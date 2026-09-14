import { governedFetch } from '../rateLimiter.js';
import type { FetchLike } from '../http.js';
import type {
  AuthContext,
  HostingCapability,
  HostingProvider,
  PullRequestQueryOptions,
} from '../hostingProvider.js';
import type {
  Account,
  ChecksStatus,
  Issue,
  PullRequest,
  PullRequestState,
  RepoDescriptor,
  ViewerRole,
} from '../models.js';
import { parseRemoteUrl } from '../remoteMatcher.js';
import {
  CachedIdentity,
  FANOUT_CONCURRENCY,
  ISSUE_TTL_MS,
  mapPooled,
  mergeByRole,
  p,
  ProviderClient,
} from './client.js';
import { base64Encode, escapeBbqlString } from './shared.js';

export interface BitbucketProviderOptions {
  /** Provider id used in RepoDescriptors. Default "bitbucket". */
  id?: string;
  /** REST API base URL. Default "https://api.bitbucket.org/2.0". */
  apiBaseUrl?: string;
  /** HTTP transport; defaults to the global fetch. Tests inject a stub here. */
  fetchFn?: FetchLike;
}

interface BitbucketAccount {
  uuid?: string;
  account_id?: string;
  username?: string;
  nickname?: string;
  display_name?: string;
  links?: { avatar?: { href?: string } };
}

interface BitbucketPullRequest {
  id: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft?: boolean;
  author?: BitbucketAccount;
  links?: { html?: { href?: string } };
  source?: { branch?: { name?: string }; commit?: { hash?: string } };
  destination?: {
    branch?: { name?: string };
    repository?: { full_name?: string };
  };
  created_on: string;
  updated_on: string;
}

function mapState(state: BitbucketPullRequest['state']): PullRequestState {
  switch (state) {
    case 'OPEN':
      return 'open';
    case 'MERGED':
      return 'merged';
    default:
      // DECLINED and SUPERSEDED are both terminal without a merge.
      return 'closed';
  }
}

interface BitbucketCommitStatus {
  state?: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED' | string;
}

/**
 * Aggregate commit statuses into a single ChecksStatus: any FAILED wins as
 * "failing", then any INPROGRESS as "pending", "passing" only when every
 * status is SUCCESSFUL, and "none" otherwise (no statuses, or e.g. STOPPED).
 */
function deriveChecksStatus(statuses: BitbucketCommitStatus[]): ChecksStatus {
  if (statuses.length === 0) {
    return 'none';
  }
  if (statuses.some((s) => s.state === 'FAILED')) {
    return 'failing';
  }
  if (statuses.some((s) => s.state === 'INPROGRESS')) {
    return 'pending';
  }
  return statuses.every((s) => s.state === 'SUCCESSFUL') ? 'passing' : 'none';
}

function mapAccount(account: BitbucketAccount | undefined): Account {
  if (!account) {
    return { id: 'unknown', username: 'unknown' };
  }
  const username = account.nickname ?? account.username ?? account.display_name ?? 'unknown';
  return {
    id: account.uuid ?? account.account_id ?? username,
    username,
    name: account.display_name,
    avatarUrl: account.links?.avatar?.href,
  };
}

/**
 * Bitbucket Cloud hosting provider (api.bitbucket.org/2.0).
 *
 * getMyPullRequests returns authored PRs from the documented
 * `/2.0/pullrequests/{selected_user}` endpoint. The Cloud API has no
 * account-wide "PRs where I am a reviewer" endpoint — the reviewer query is
 * repo-scoped only — so review requests are aggregated only when the caller
 * passes a repo in PullRequestQueryOptions: the repo's open PRs listing
 * reviewers.uuid = <own uuid> is then merged in with viewerRole "reviewer".
 * Without a repo context all results carry viewerRole "author".
 *
 * checksStatus comes from the per-PR `/statuses` endpoint at one extra
 * request per PR; the fan-out is bounded by FANOUT_CONCURRENCY
 * results are enriched (first page of statuses only) and the rest stay
 * "none". The Cloud API exposes no mergeability signal at all (hence no
 * "mergeability" capability flag).
 */
export class BitbucketProvider implements HostingProvider {
  readonly id: string;
  readonly host = 'bitbucket.org';
  readonly capabilities: ReadonlySet<HostingCapability> = new Set<HostingCapability>([
    'prs',
    'prForBranch',
  ]);

  private readonly client: ProviderClient;
  private readonly identity = new CachedIdentity<BitbucketAccount>();

  constructor(options: BitbucketProviderOptions = {}) {
    this.id = options.id ?? 'bitbucket';
    this.client = new ProviderClient({
      name: 'Bitbucket',
      baseUrl: options.apiBaseUrl ?? 'https://api.bitbucket.org/2.0',
      baseUrlLabel: 'Bitbucket apiBaseUrl',
      headers: { accept: 'application/json' },
      // An app password authenticates as a named account; OAuth tokens do not.
      authorize: (auth) =>
        auth.username
          ? `Basic ${base64Encode(`${auth.username}:${auth.token}`)}`
          : `Bearer ${auth.token}`,
      fetchFn: options.fetchFn ?? governedFetch,
    });
  }

  matchesRemote(remoteUrl: string): RepoDescriptor | undefined {
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed || parsed.host !== this.host) {
      return undefined;
    }
    return { provider: this.id, ...parsed };
  }

  async getMyPullRequests(
    auth: AuthContext,
    opts?: PullRequestQueryOptions
  ): Promise<PullRequest[]> {
    const me = await this.username(auth);
    const limit = opts?.limit ?? 50;
    const json = await this.client.getJson<{ values?: BitbucketPullRequest[] }>(
      auth,
      p`/pullrequests/${me}?state=OPEN&pagelen=${limit}`
    );
    // The reviewer query is repo-scoped, so review requests are only visible
    // when the caller supplies a repo context.
    const reviewing = opts?.repo ? await this.reviewRequestedPullRequests(auth, opts.repo) : [];
    const prs = mergeByRole(
      (json?.values ?? []).map((pr) => this.mapPullRequest(pr, 'author')),
      reviewing.map((pr) => this.mapPullRequest(pr, 'reviewer')),
      (pr) => pr.number,
      limit
    );
    return this.withChecksStatus(auth, prs);
  }

  async getPullRequestForBranch(
    auth: AuthContext,
    repo: RepoDescriptor,
    branch: string
  ): Promise<PullRequest | undefined> {
    // Branch names come from the repository, so a name containing a quote
    // would close the BBQL literal and rewrite the query's meaning.
    const q = `source.branch.name = "${escapeBbqlString(branch)}" AND state = "OPEN"`;
    const json = await this.client.getJson<{ values?: BitbucketPullRequest[] }>(
      auth,
      p`/repositories/${repo.owner}/${repo.name}/pullrequests?q=${q}`
    );
    const pr = json?.values?.[0];
    if (!pr) {
      return undefined;
    }
    const cached = this.identity.peek(auth.token);
    const viewer = auth.username ?? cached?.username ?? cached?.nickname;
    const role: ViewerRole =
      viewer !== undefined && mapAccount(pr.author).username === viewer ? 'author' : 'none';
    return this.mapPullRequest(pr, role);
  }

  async getIssueOrPr(
    auth: AuthContext,
    repo: RepoDescriptor,
    ref: string
  ): Promise<Issue | PullRequest | undefined> {
    const number = Number(ref.replace(/^#/, ''));
    if (!Number.isInteger(number) || number <= 0) {
      return undefined;
    }
    const repoPath = p`/repositories/${repo.owner}/${repo.name}`;
    const issue = await this.client.getJsonCached<Record<string, unknown>>(
      auth,
      p`${repoPath}/issues/${number}`,
      ISSUE_TTL_MS
    );
    if (issue !== undefined) {
      const assignee = issue.assignee as BitbucketAccount | null | undefined;
      const links = issue.links as { html?: { href?: string } } | undefined;
      return {
        id: String(issue.id),
        key: `${repo.owner}/${repo.name}#${issue.id}`,
        title: String(issue.title),
        url: String(links?.html?.href ?? ''),
        state: String(issue.state),
        assignee: assignee ? mapAccount(assignee) : undefined,
        updatedAt: String(issue.updated_on),
      };
    }
    // The issue tracker may be disabled for the repo; fall back to PRs.
    const pr = await this.client.getJsonCached<BitbucketPullRequest>(
      auth,
      p`${repoPath}/pullrequests/${number}`,
      ISSUE_TTL_MS
    );
    return pr ? this.mapPullRequest(pr, 'none') : undefined;
  }

  /** Open PRs in `repo` where the authenticated user is a requested reviewer. */
  private async reviewRequestedPullRequests(
    auth: AuthContext,
    repo: RepoDescriptor
  ): Promise<BitbucketPullRequest[]> {
    const uuid = (await this.user(auth)).uuid;
    if (!uuid) {
      return [];
    }
    const q = `state="OPEN" AND reviewers.uuid="${escapeBbqlString(uuid)}"`;
    const json = await this.client.getJson<{ values?: BitbucketPullRequest[] }>(
      auth,
      p`/repositories/${repo.owner}/${repo.name}/pullrequests?q=${q}`
    );
    return json?.values ?? [];
  }

  /**
   * Fills checksStatus from the per-PR statuses endpoint (first page only).
   * One request per PR, at most FANOUT_CONCURRENCY in flight.
   */
  private async withChecksStatus(auth: AuthContext, prs: PullRequest[]): Promise<PullRequest[]> {
    return mapPooled(prs, FANOUT_CONCURRENCY, async (pr) => {
      const json = await this.client.getJson<{ values?: BitbucketCommitStatus[] }>(
        auth,
        p`/repositories/${pr.repo.owner}/${pr.repo.name}/pullrequests/${pr.number}/statuses`
      );
      return { ...pr, checksStatus: deriveChecksStatus(json?.values ?? []) };
    });
  }

  private mapPullRequest(pr: BitbucketPullRequest, viewerRole: ViewerRole): PullRequest {
    const fullName = pr.destination?.repository?.full_name ?? '/';
    const slash = fullName.indexOf('/');
    return {
      id: String(pr.id),
      number: pr.id,
      title: pr.title,
      url: pr.links?.html?.href ?? '',
      state: mapState(pr.state),
      draft: pr.draft ?? false,
      author: mapAccount(pr.author),
      baseRef: pr.destination?.branch?.name ?? '',
      headRef: pr.source?.branch?.name ?? '',
      headSha: pr.source?.commit?.hash ?? '',
      repo: {
        provider: this.id,
        host: this.host,
        owner: fullName.slice(0, slash),
        name: fullName.slice(slash + 1),
      },
      createdAt: pr.created_on,
      updatedAt: pr.updated_on,
      checksStatus: 'none',
      mergeable: 'unknown',
      viewerRole,
      reviewRequestedFromViewer: viewerRole === 'reviewer',
    };
  }

  private async username(auth: AuthContext): Promise<string> {
    if (auth.username) {
      return auth.username;
    }
    const user = await this.user(auth);
    const username = user.username ?? user.nickname;
    if (!username) {
      throw new Error('Bitbucket /user returned no username');
    }
    return username;
  }

  /** Own account profile from /2.0/user, cached per token. */
  private async user(auth: AuthContext): Promise<BitbucketAccount> {
    return this.identity.get(auth.token, async () => {
      const user = await this.client.getJson<BitbucketAccount>(auth, p`/user`);
      if (!user) {
        throw new Error('Bitbucket /user returned no profile');
      }
      return user;
    });
  }
}
