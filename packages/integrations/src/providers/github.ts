import { governedFetch } from '../rateLimiter.js';
import { ProviderError, RateLimitError } from '../errors.js';
import type { FetchLike } from '../http.js';
import {
  orderCommitPullRequests,
  type AuthContext,
  type HostingCapability,
  type HostingProvider,
  type IssueProvider,
  type IssueQueryOptions,
  type PrComments,
  type PullRequestHead,
  type PullRequestQueryOptions,
  type ReviewSuggestionInput,
  type ReviewSuggestions,
} from '../hostingProvider.js';
import {
  parseGistId,
  type SnippetCreateOptions,
  type SnippetHost,
  type SnippetRef,
} from '../snippets.js';
import type {
  Account,
  ChecksStatus,
  Issue,
  Mergeability,
  PullRequest,
  PullRequestState,
  RepoDescriptor,
  ReviewDecision,
  ViewerRole,
} from '../models.js';
import { parseRemoteUrl } from '../remoteMatcher.js';
import {
  COMMIT_PULL_REQUESTS_TTL_MS,
  ISSUE_TTL_MS,
  isFullSha,
  MAX_COMMIT_PULL_REQUESTS,
  p,
  ProviderClient,
} from './client.js';
import {
  assertKnownOptions,
  assertPlainHost,
  isGistRawOrigin,
  isSameOriginAs,
  slugify,
} from './shared.js';

export interface GitHubProviderOptions {
  /** Provider id used in RepoDescriptors. Default "github". */
  id?: string;
  /** Host this provider serves. Default "github.com". */
  host?: string;
  /**
   * REST API base URL. Default "https://api.github.com" for github.com and
   * "https://<host>/api/v3" for any other host.
   */
  apiBaseUrl?: string;
  /**
   * GraphQL endpoint URL. Default "<apiBaseUrl>/graphql" for github.com and
   * "https://<host>/api/graphql" for any other host.
   */
  graphqlUrl?: string;
  /** HTTP transport; defaults to the global fetch. Tests inject a stub here. */
  fetchFn?: FetchLike;
}

interface GraphQlAccount {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

interface GraphQlPullRequestNode {
  id: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: GraphQlAccount | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  repository: { name: string; owner: { login: string } };
  createdAt: string;
  updatedAt: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  commits: {
    nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }>;
  };
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { login?: string } | null }>;
  };
  assignees: { nodes: Array<{ login: string }> };
}

interface GraphQlSearchData {
  viewer?: { login: string };
  search?: { nodes: Array<GraphQlPullRequestNode | null> };
}

interface GraphQlBranchPullRequestNode extends GraphQlPullRequestNode {
  headRepositoryOwner: { login: string } | null;
}

interface GraphQlNumberData {
  viewer?: { login: string };
  repository?: { pullRequest?: GraphQlBranchPullRequestNode | null } | null;
}

/** The parts of a REST pull request list item a branch lookup reads. */
interface RestPullHead {
  number?: number;
  head?: { ref?: string; repo?: { owner?: { login?: string } } | null } | null;
}

interface RestAssignedIssue {
  id?: number;
  node_id?: string;
  number?: number;
  title?: string;
  html_url?: string;
  state?: string;
  updated_at?: string;
  pull_request?: unknown;
  assignee?: { login?: string; avatar_url?: string } | null;
  repository?: { name?: string; full_name?: string; owner?: { login?: string } };
  repository_url?: string;
}

const PR_FRAGMENT = `
  id
  number
  title
  url
  state
  isDraft
  author { login ... on User { name avatarUrl } }
  baseRefName
  headRefName
  headRefOid
  repository { name owner { login } }
  createdAt
  updatedAt
  reviewDecision
  mergeable
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  assignees(first: 10) { nodes { login } }
`;

/** One pull request by number, with its head repository's owner. */
const NUMBER_QUERY = `
query ($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${PR_FRAGMENT}
      headRepositoryOwner { login }
    }
  }
}`;

const OPTION_KEYS = ['id', 'host', 'apiBaseUrl', 'graphqlUrl', 'fetchFn'] as const;

const SEARCH_QUERY = `
query ($searchQuery: String!, $first: Int!) {
  viewer { login }
  search(query: $searchQuery, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        ${PR_FRAGMENT}
      }
    }
  }
}`;

function mapChecksStatus(rollupState: string | null | undefined): ChecksStatus {
  switch (rollupState) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

function mapMergeable(mergeable: string | null | undefined): Mergeability {
  switch (mergeable) {
    case 'MERGEABLE':
      return 'mergeable';
    case 'CONFLICTING':
      return 'conflicts';
    default:
      return 'unknown';
  }
}

function mapReviewDecision(decision: string | null | undefined): ReviewDecision | undefined {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return undefined;
  }
}

function mapState(state: 'OPEN' | 'CLOSED' | 'MERGED'): PullRequestState {
  switch (state) {
    case 'OPEN':
      return 'open';
    case 'MERGED':
      return 'merged';
    default:
      return 'closed';
  }
}

function mapAccount(account: GraphQlAccount | null): Account {
  if (!account) {
    // Deleted accounts come back as null; GitHub renders them as "ghost".
    return { id: 'ghost', username: 'ghost' };
  }
  return {
    id: account.login,
    username: account.login,
    name: account.name ?? undefined,
    avatarUrl: account.avatarUrl ?? undefined,
  };
}

/**
 * GitHub hosting provider backed by the real api.github.com GraphQL/REST APIs.
 * Any host other than github.com is treated as GitHub Enterprise Server and
 * served from that host's own API endpoints. Also an issue provider for the
 * issues assigned to the authenticated user.
 */
export class GitHubProvider
  implements HostingProvider, IssueProvider, SnippetHost, ReviewSuggestions, PrComments
{
  readonly id: string;
  readonly host: string;
  readonly capabilities: ReadonlySet<HostingCapability> = new Set<HostingCapability>([
    'prs',
    'prForBranch',
    'checks',
    'reviews',
    'mergeability',
    'gists',
    'suggestions',
  ]);

  private readonly client: ProviderClient;

  constructor(options: GitHubProviderOptions = {}) {
    assertKnownOptions(options, OPTION_KEYS, 'GitHubProvider');
    this.id = options.id ?? 'github';
    // The host reaches a base URL that carries the token, so it must be a bare
    // hostname. It is lowercased to match the hosts parseRemoteUrl returns.
    this.host = (
      options.host === undefined ? 'github.com' : assertPlainHost(options.host, 'GitHub host')
    ).toLowerCase();
    // An enterprise host serves its own API; defaulting it to api.github.com
    // would send that instance's token to github.com.
    const enterprise = this.host !== 'github.com';
    const apiBaseUrl =
      options.apiBaseUrl ?? (enterprise ? `https://${this.host}/api/v3` : 'https://api.github.com');
    const graphqlUrl =
      options.graphqlUrl ??
      (enterprise && options.apiBaseUrl === undefined
        ? `https://${this.host}/api/graphql`
        : `${apiBaseUrl}/graphql`);
    this.client = new ProviderClient({
      name: 'GitHub',
      baseUrl: apiBaseUrl,
      baseUrlLabel: 'GitHub apiBaseUrl',
      credentialHost: this.host,
      graphqlUrl,
      headers: { accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      authorize: (auth) => `Bearer ${auth.token}`,
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
    const data = await this.client.graphql<GraphQlSearchData>(auth, SEARCH_QUERY, {
      searchQuery: 'is:pr involves:@me state:open',
      first: opts?.limit ?? 50,
    });
    const viewer = data.viewer?.login ?? '';
    const nodes = data.search?.nodes ?? [];
    return nodes
      .filter((node): node is GraphQlPullRequestNode => node !== null && 'number' in node)
      .map((node) => this.mapPullRequest(node, viewer));
  }

  async getPullRequestForBranch(
    auth: AuthContext,
    repo: RepoDescriptor,
    branch: string,
    head?: PullRequestHead
  ): Promise<PullRequest | undefined> {
    // A fork owner can have only one fork in a repository's network, so the
    // head repository's owner identifies it. REST filters on "owner:branch"
    // server-side; GraphQL's headRefName matches the branch in every fork, so
    // other forks' same-named branches could crowd this one out of a page.
    const headOwner = (head ?? repo).owner.toLowerCase();
    const isHead = (owner: string | undefined, ref: string | undefined): boolean =>
      ref === branch && owner?.toLowerCase() === headOwner;
    const headFilter = `${headOwner}:${branch}`;
    const pulls = await this.client.getJson<RestPullHead[]>(
      auth,
      p`/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${headFilter}&per_page=10`
    );
    // A deleted head repository has no owner and never matches.
    const match = (pulls ?? []).find((pull) =>
      isHead(pull.head?.repo?.owner?.login, pull.head?.ref)
    );
    if (match?.number === undefined) {
      return undefined;
    }
    const data = await this.client.graphql<GraphQlNumberData>(auth, NUMBER_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number: match.number,
    });
    const node = data.repository?.pullRequest;
    // Checked again on the full record, which may be newer than the list.
    const stillHead = node && isHead(node.headRepositoryOwner?.login, node.headRefName);
    if (!node || !stillHead || node.state !== 'OPEN') {
      return undefined;
    }
    return this.mapPullRequest(node, data.viewer?.login ?? '');
  }

  /**
   * The pull requests containing `sha`, from REST GET
   * /repos/{o}/{r}/commits/{sha}/pulls. The list carries no comment counts,
   * so the first few are read in full (GET /pulls/{n}) for them. Both answers
   * are cached per commit and pull request. A commit GitHub does not have
   * (422: not pushed, or rewritten) has none. A 404 means the repository is
   * out of the credential's sight, which says nothing about the commit, so
   * it fails the lookup.
   */
  async getPullRequestsForCommit(
    auth: AuthContext,
    repo: RepoDescriptor,
    sha: string
  ): Promise<PullRequest[]> {
    if (!isFullSha(sha)) {
      return [];
    }
    let pulls: Record<string, unknown>[] | undefined;
    try {
      pulls = await this.client.getJsonCached<Record<string, unknown>[]>(
        auth,
        p`/repos/${repo.owner}/${repo.name}/commits/${sha}/pulls?per_page=${MAX_COMMIT_PULL_REQUESTS}`,
        COMMIT_PULL_REQUESTS_TTL_MS
      );
    } catch (error) {
      if (error instanceof ProviderError && error.status === 422) {
        return [];
      }
      throw error;
    }
    if (pulls === undefined) {
      throw new ProviderError(
        `GitHub does not show ${repo.owner}/${repo.name} to this credential (404): it has no ` +
          'access to the repository, or the organization wants it authorised for SSO',
        404
      );
    }
    const listed = orderCommitPullRequests(
      (Array.isArray(pulls) ? pulls : []).map((pull) => this.mapRestPullRequest(pull, repo))
    ).slice(0, MAX_COMMIT_PULL_REQUESTS);
    return Promise.all(
      listed.map(async (pr) => {
        let full: Record<string, unknown> | undefined;
        try {
          full = await this.client.getJsonCached<Record<string, unknown>>(
            auth,
            p`/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
            COMMIT_PULL_REQUESTS_TTL_MS
          );
        } catch (error) {
          // The list already describes the pull request; only its counts are
          // missing. A rejected token or an exhausted quota fails the lookup.
          if (
            !(error instanceof ProviderError) ||
            error.status === 401 ||
            error instanceof RateLimitError
          ) {
            throw error;
          }
        }
        return full === undefined ? pr : this.mapRestPullRequest(full, repo);
      })
    );
  }

  /** Open issues assigned to the authenticated user, across repositories. */
  async getMyIssues(auth: AuthContext, opts?: IssueQueryOptions): Promise<Issue[]> {
    // The endpoint pages at 100 and counts pull requests against the page.
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
    const json = await this.client.getJson<RestAssignedIssue[]>(
      auth,
      p`/issues?filter=assigned&state=open&sort=updated&per_page=${limit}`
    );
    const issues: Issue[] = [];
    for (const item of json ?? []) {
      if (item.pull_request !== undefined) {
        continue;
      }
      const path = repoOfAssignedIssue(item);
      if (path) {
        const repo: RepoDescriptor = { provider: this.id, host: this.host, ...path };
        issues.push(this.mapRestIssue(item as Record<string, unknown>, repo));
      }
    }
    return issues;
  }

  /** Resolves an "owner/name#123" key to its issue; pull requests resolve to undefined. */
  async getIssue(auth: AuthContext, key: string): Promise<Issue | undefined> {
    const match = /^(.+)\/([^/#]+)#(\d+)$/.exec(key.trim());
    if (!match) {
      return undefined;
    }
    const repo: RepoDescriptor = {
      provider: this.id,
      host: this.host,
      owner: match[1],
      name: match[2],
    };
    const found = await this.getIssueOrPr(auth, repo, match[3]);
    return found !== undefined && !('headSha' in found) ? found : undefined;
  }

  /** "<number>-<slug>", the shape GitHub's own "Create a branch" uses. */
  suggestBranchName(issue: Issue): string {
    const number = /#(\d+)$/.exec(issue.key)?.[1];
    const slug = slugify(issue.title, 40);
    if (number === undefined) {
      return slug;
    }
    return slug ? `${number}-${slug}` : number;
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
    const issue = await this.client.getJsonCached<Record<string, unknown>>(
      auth,
      p`/repos/${repo.owner}/${repo.name}/issues/${number}`,
      ISSUE_TTL_MS
    );
    if (issue === undefined) {
      return undefined;
    }
    if (issue.pull_request) {
      const pull = await this.client.getJsonCached<Record<string, unknown>>(
        auth,
        p`/repos/${repo.owner}/${repo.name}/pulls/${number}`,
        ISSUE_TTL_MS
      );
      return pull === undefined ? undefined : this.mapRestPullRequest(pull, repo);
    }
    return this.mapRestIssue(issue, repo);
  }

  /** Creates a gist (secret by default) holding a single file. */
  async createSnippet(auth: AuthContext, options: SnippetCreateOptions): Promise<SnippetRef> {
    const json = await this.client.postJson<{ id?: unknown; html_url?: unknown }>(
      auth,
      p`/gists`,
      {
        description: options.description ?? '',
        public: options.secret === false,
        files: { [options.filename]: { content: options.content } },
      }
    );
    return { id: String(json.id ?? ''), url: String(json.html_url ?? '') };
  }

  /** Fetches a gist's file content by id or URL; prefers a .ggpatch file. */
  async getSnippet(auth: AuthContext, idOrUrl: string): Promise<string> {
    const id = parseGistId(idOrUrl);
    if (!id) {
      throw new ProviderError(`Not a recognizable gist id or URL: ${idOrUrl}`);
    }
    const json = await this.client.getJson<{
      files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }>;
    }>(auth, p`/gists/${id}`);
    if (json === undefined) {
      throw new ProviderError(`Gist ${id} not found`, 404);
    }
    const entries = Object.entries(json.files ?? {});
    const file = entries.find(([name]) => name.endsWith('.ggpatch'))?.[1] ?? entries[0]?.[1];
    if (!file) {
      throw new ProviderError(`Gist ${id} has no files`);
    }
    if (file.truncated && file.raw_url) {
      // Gist raw content is public: fetched uncredentialed, and only from the
      // API origin or gist.githubusercontent.com.
      if (!isSameOriginAs(file.raw_url, this.client.baseUrl) && !isGistRawOrigin(file.raw_url)) {
        throw new ProviderError(`Gist ${id} points its content at an unexpected host`);
      }
      return this.client.getPublicText(file.raw_url);
    }
    return file.content ?? '';
  }

  /**
   * Posts a diff-anchored review comment with a ```suggestion block via
   * REST POST /repos/{o}/{r}/pulls/{n}/comments (line/start_line, side RIGHT).
   * One call, and the comment is visible immediately: there is no pending
   * review to submit. A 422 means the lines are not part of the PR head diff.
   */
  async createReviewSuggestion(
    auth: AuthContext,
    pr: PullRequest,
    input: ReviewSuggestionInput
  ): Promise<{ url: string }> {
    const body: Record<string, unknown> = {
      body: input.body,
      commit_id: pr.headSha,
      path: input.path,
      line: input.endLine,
      side: 'RIGHT',
    };
    if (input.endLine > input.startLine) {
      body.start_line = input.startLine;
      body.start_side = 'RIGHT';
    }
    const json = await this.client.postJson<{ html_url?: unknown }>(
      auth,
      p`/repos/${pr.repo.owner}/${pr.repo.name}/pulls/${pr.number}/comments`,
      body
    );
    return { url: json.html_url ? String(json.html_url) : pr.url };
  }

  /**
   * Posts a plain top-level PR comment via the issue-comments endpoint
   * (POST /repos/{o}/{r}/issues/{n}/comments — PR conversation comments are
   * issue comments in the REST API). Serves as the fallback channel when a
   * suggestion cannot anchor to the diff.
   */
  async createPullRequestComment(
    auth: AuthContext,
    pr: { repo: RepoDescriptor; number: number },
    body: string
  ): Promise<{ url: string }> {
    const json = await this.client.postJson<{ html_url?: unknown }>(
      auth,
      p`/repos/${pr.repo.owner}/${pr.repo.name}/issues/${pr.number}/comments`,
      { body }
    );
    return {
      url: json.html_url
        ? String(json.html_url)
        : `https://${this.host}/${pr.repo.owner}/${pr.repo.name}/pull/${pr.number}`,
    };
  }

  private mapPullRequest(node: GraphQlPullRequestNode, viewer: string): PullRequest {
    const authorLogin = node.author?.login;
    const requestedLogins = node.reviewRequests.nodes
      .map((n) => n.requestedReviewer?.login)
      .filter((login): login is string => typeof login === 'string');
    const assigneeLogins = node.assignees.nodes.map((n) => n.login);
    const reviewRequestedFromViewer = viewer !== '' && requestedLogins.includes(viewer);

    let viewerRole: ViewerRole = 'none';
    if (viewer !== '') {
      if (authorLogin === viewer) {
        viewerRole = 'author';
      } else if (reviewRequestedFromViewer) {
        viewerRole = 'reviewer';
      } else if (assigneeLogins.includes(viewer)) {
        viewerRole = 'assignee';
      } else {
        // The search matched via involves:@me, so the remaining tie is a mention.
        viewerRole = 'mentioned';
      }
    }

    return {
      id: node.id,
      number: node.number,
      title: node.title,
      url: node.url,
      state: mapState(node.state),
      draft: node.isDraft,
      author: mapAccount(node.author),
      baseRef: node.baseRefName,
      headRef: node.headRefName,
      headSha: node.headRefOid,
      repo: {
        provider: this.id,
        host: this.host,
        owner: node.repository.owner.login,
        name: node.repository.name,
      },
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      reviewDecision: mapReviewDecision(node.reviewDecision),
      checksStatus: mapChecksStatus(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
      mergeable: mapMergeable(node.mergeable),
      viewerRole,
      reviewRequestedFromViewer,
    };
  }

  private mapRestIssue(json: Record<string, unknown>, repo: RepoDescriptor): Issue {
    const assignee = json.assignee as Record<string, unknown> | null;
    return {
      id: String(json.node_id ?? json.id),
      key: `${repo.owner}/${repo.name}#${json.number}`,
      title: String(json.title),
      url: String(json.html_url),
      state: String(json.state),
      assignee: assignee
        ? {
            id: String(assignee.login),
            username: String(assignee.login),
            avatarUrl: assignee.avatar_url ? String(assignee.avatar_url) : undefined,
          }
        : undefined,
      updatedAt: String(json.updated_at),
    };
  }

  private mapRestPullRequest(
    json: Record<string, unknown>,
    repo: RepoDescriptor
  ): PullRequest {
    const user = json.user as Record<string, unknown> | null;
    const base = json.base as Record<string, unknown>;
    const head = json.head as Record<string, unknown>;
    const state = json.merged_at
      ? 'merged'
      : json.state === 'open'
        ? 'open'
        : 'closed';
    return {
      id: String(json.node_id ?? json.id),
      number: Number(json.number),
      title: String(json.title),
      url: String(json.html_url),
      state,
      draft: Boolean(json.draft),
      author: user
        ? {
            id: String(user.login),
            username: String(user.login),
            avatarUrl: user.avatar_url ? String(user.avatar_url) : undefined,
          }
        : { id: 'ghost', username: 'ghost' },
      baseRef: String(base.ref),
      headRef: String(head.ref),
      headSha: String(head.sha),
      repo: { ...repo, provider: this.id, host: this.host },
      createdAt: String(json.created_at),
      updatedAt: String(json.updated_at),
      mergeable:
        json.mergeable === true ? 'mergeable' : json.mergeable === false ? 'conflicts' : 'unknown',
      viewerRole: 'none',
      reviewRequestedFromViewer: false,
      mergedAt: typeof json.merged_at === 'string' ? json.merged_at : undefined,
      body: typeof json.body === 'string' ? json.body : undefined,
      // Only the full record counts comments; list items leave them out.
      reviewCommentCount: count(json.review_comments),
      commentCount: count(json.comments),
    };
  }
}

/** A non-negative integer count from a payload, or undefined. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Owner and name of the repository an /issues result belongs to. */
function repoOfAssignedIssue(item: RestAssignedIssue): { owner: string; name: string } | undefined {
  const fullName =
    item.repository?.full_name ?? /\/repos\/([^/]+\/[^/]+)$/.exec(item.repository_url ?? '')?.[1];
  const slash = fullName?.indexOf('/') ?? -1;
  if (fullName === undefined || slash <= 0) {
    return undefined;
  }
  return { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/**
 * GitHub Enterprise Server variant: same implementation pointed at the
 * enterprise host's REST (/api/v3) and GraphQL (/api/graphql) endpoints.
 */
export function createGitHubEnterpriseProvider(
  host: string,
  fetchFn?: FetchLike
): GitHubProvider {
  // The host is interpolated into both API base URLs, which then carry the
  // user's token, so it must be a bare hostname.
  assertPlainHost(host, 'GitHub Enterprise host');
  return new GitHubProvider({
    id: 'github-enterprise',
    host,
    apiBaseUrl: `https://${host}/api/v3`,
    graphqlUrl: `https://${host}/api/graphql`,
    fetchFn,
  });
}
