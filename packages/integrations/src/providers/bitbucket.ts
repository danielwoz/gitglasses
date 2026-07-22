import { defaultFetch, type FetchLike } from '../http.js';
import type {
  AuthContext,
  HostingCapability,
  HostingProvider,
  PullRequestQueryOptions,
} from '../hostingProvider.js';
import type {
  Account,
  Issue,
  PullRequest,
  PullRequestState,
  RepoDescriptor,
  ViewerRole,
} from '../models.js';
import { parseRemoteUrl } from '../remoteMatcher.js';
import { base64Encode, throwForStatus } from './shared.js';

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
 * account-wide "PRs where I am a reviewer" endpoint (the reviewer query is
 * repo-scoped only), so review requests are not aggregated here; all results
 * carry viewerRole "author".
 *
 * checksStatus is reported as "none": commit statuses live on a separate
 * `/statuses` endpoint that would cost one extra request per PR, and the
 * Cloud API exposes no mergeability signal at all (hence no "mergeability"
 * or "checks" capability flags).
 */
export class BitbucketProvider implements HostingProvider {
  readonly id: string;
  readonly host = 'bitbucket.org';
  readonly capabilities: ReadonlySet<HostingCapability> = new Set<HostingCapability>([
    'prs',
    'prForBranch',
  ]);

  private readonly apiBaseUrl: string;
  private readonly fetchFn: FetchLike;
  private cachedUsername?: string;
  private cachedUsernameToken?: string;

  constructor(options: BitbucketProviderOptions = {}) {
    this.id = options.id ?? 'bitbucket';
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.bitbucket.org/2.0').replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? defaultFetch;
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
    const json = (await this.get(
      auth,
      `/pullrequests/${encodeURIComponent(me)}?state=OPEN&pagelen=${limit}`
    )) as { values?: BitbucketPullRequest[] } | undefined;
    return (json?.values ?? [])
      .slice(0, limit)
      .map((pr) => this.mapPullRequest(pr, 'author'));
  }

  async getPullRequestForBranch(
    auth: AuthContext,
    repo: RepoDescriptor,
    branch: string
  ): Promise<PullRequest | undefined> {
    const q = encodeURIComponent(`source.branch.name = "${branch}" AND state = "OPEN"`);
    const json = (await this.get(
      auth,
      `/repositories/${repo.owner}/${repo.name}/pullrequests?q=${q}`
    )) as { values?: BitbucketPullRequest[] } | undefined;
    const pr = json?.values?.[0];
    if (!pr) {
      return undefined;
    }
    const viewer = auth.username ?? this.cachedUsername;
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
    const repoPath = `/repositories/${repo.owner}/${repo.name}`;
    const issue = (await this.get(auth, `${repoPath}/issues/${number}`)) as
      | Record<string, unknown>
      | undefined;
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
    const pr = (await this.get(auth, `${repoPath}/pullrequests/${number}`)) as
      | BitbucketPullRequest
      | undefined;
    return pr ? this.mapPullRequest(pr, 'none') : undefined;
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
      reviewRequestedFromViewer: false,
    };
  }

  private async username(auth: AuthContext): Promise<string> {
    if (auth.username) {
      return auth.username;
    }
    if (this.cachedUsername !== undefined && this.cachedUsernameToken === auth.token) {
      return this.cachedUsername;
    }
    const user = (await this.get(auth, '/user')) as BitbucketAccount | undefined;
    const username = user?.username ?? user?.nickname;
    if (!username) {
      throw new Error('Bitbucket /user returned no username');
    }
    this.cachedUsername = username;
    this.cachedUsernameToken = auth.token;
    return username;
  }

  /** REST GET; returns undefined on 404. */
  private async get(auth: AuthContext, path: string): Promise<unknown | undefined> {
    const authorization = auth.username
      ? `Basic ${base64Encode(`${auth.username}:${auth.token}`)}`
      : `Bearer ${auth.token}`;
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization,
        accept: 'application/json',
        'user-agent': 'gitglasses',
      },
    });
    if (response.status === 404) {
      return undefined;
    }
    throwForStatus('Bitbucket', response);
    return response.json();
  }
}
