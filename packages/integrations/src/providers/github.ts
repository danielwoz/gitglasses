import { AuthError, ProviderError, RateLimitError } from '../errors.js';
import { defaultFetch, type FetchLike, type HttpResponseLike } from '../http.js';
import type {
  AuthContext,
  HostingCapability,
  HostingProvider,
  PullRequestQueryOptions,
  ReviewSuggestionInput,
  ReviewSuggestions,
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

export interface GitHubProviderOptions {
  /** Provider id used in RepoDescriptors. Default "github". */
  id?: string;
  /** Host this provider serves. Default "github.com". */
  host?: string;
  /** REST API base URL. Default "https://api.github.com". */
  apiBaseUrl?: string;
  /** GraphQL endpoint URL. Default "https://api.github.com/graphql". */
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

interface GraphQlSearchResponse {
  data?: {
    viewer?: { login: string };
    search?: { nodes: Array<GraphQlPullRequestNode | null> };
  };
  errors?: Array<{ message: string }>;
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
 * Also serves GitHub Enterprise via createGitHubEnterpriseProvider, which
 * points the same class at an enterprise host's API endpoints.
 */
export class GitHubProvider implements HostingProvider, SnippetHost, ReviewSuggestions {
  readonly id: string;
  readonly host: string;
  readonly capabilities: ReadonlySet<HostingCapability> = new Set<HostingCapability>([
    'prs',
    'prForBranch',
    'checks',
    'reviews',
    'mergeability',
    'createPR',
    'gists',
    'suggestions',
  ]);

  private readonly apiBaseUrl: string;
  private readonly graphqlUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(options: GitHubProviderOptions = {}) {
    this.id = options.id ?? 'github';
    this.host = options.host ?? 'github.com';
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
    this.graphqlUrl = options.graphqlUrl ?? `${this.apiBaseUrl}/graphql`;
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
    const data = await this.graphql(auth, SEARCH_QUERY, {
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
    branch: string
  ): Promise<PullRequest | undefined> {
    const data = await this.graphql(auth, SEARCH_QUERY, {
      searchQuery: `is:pr state:open head:${branch} repo:${repo.owner}/${repo.name}`,
      first: 1,
    });
    const viewer = data.viewer?.login ?? '';
    const node = (data.search?.nodes ?? []).find(
      (n): n is GraphQlPullRequestNode => n !== null && 'number' in n
    );
    return node ? this.mapPullRequest(node, viewer) : undefined;
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
    const issue = await this.rest(
      auth,
      `/repos/${repo.owner}/${repo.name}/issues/${number}`
    );
    if (issue === undefined) {
      return undefined;
    }
    const issueJson = issue as Record<string, unknown>;
    if (issueJson.pull_request) {
      const pull = await this.rest(
        auth,
        `/repos/${repo.owner}/${repo.name}/pulls/${number}`
      );
      return pull === undefined
        ? undefined
        : this.mapRestPullRequest(pull as Record<string, unknown>, repo);
    }
    return this.mapRestIssue(issueJson, repo);
  }

  /** Creates a gist (secret by default) holding a single file. */
  async createSnippet(auth: AuthContext, options: SnippetCreateOptions): Promise<SnippetRef> {
    const json = (await this.restPost(auth, '/gists', {
      description: options.description ?? '',
      public: options.secret === false,
      files: { [options.filename]: { content: options.content } },
    })) as { id?: unknown; html_url?: unknown };
    return { id: String(json.id ?? ''), url: String(json.html_url ?? '') };
  }

  /** Fetches a gist's file content by id or URL; prefers a .ggpatch file. */
  async getSnippet(auth: AuthContext, idOrUrl: string): Promise<string> {
    const id = parseGistId(idOrUrl);
    if (!id) {
      throw new ProviderError(`Not a recognizable gist id or URL: ${idOrUrl}`);
    }
    const json = await this.rest(auth, `/gists/${id}`);
    if (json === undefined) {
      throw new ProviderError(`Gist ${id} not found`, 404);
    }
    const files =
      (json as { files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> })
        .files ?? {};
    const entries = Object.entries(files);
    const file = entries.find(([name]) => name.endsWith('.ggpatch'))?.[1] ?? entries[0]?.[1];
    if (!file) {
      throw new ProviderError(`Gist ${id} has no files`);
    }
    if (file.truncated && file.raw_url) {
      const response = await this.fetchFn(file.raw_url, {
        method: 'GET',
        headers: this.headers(auth),
      });
      this.throwForStatus(response);
      return response.text();
    }
    return file.content ?? '';
  }

  /**
   * Posts a diff-anchored review comment with a ```suggestion block via
   * REST POST /repos/{o}/{r}/pulls/{n}/comments (line/start_line, side RIGHT).
   * REST is chosen over the GraphQL addPullRequestReviewThread flow because a
   * single call yields an immediately visible comment — no pending review to
   * create and submit. A 422 means the lines are not part of the PR head diff.
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
    const json = (await this.restPost(
      auth,
      `/repos/${pr.repo.owner}/${pr.repo.name}/pulls/${pr.number}/comments`,
      body
    )) as { html_url?: unknown };
    return { url: json.html_url ? String(json.html_url) : pr.url };
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
    };
  }

  private async graphql(
    auth: AuthContext,
    query: string,
    variables: Record<string, unknown>
  ): Promise<NonNullable<GraphQlSearchResponse['data']>> {
    const response = await this.fetchFn(this.graphqlUrl, {
      method: 'POST',
      headers: this.headers(auth),
      body: JSON.stringify({ query, variables }),
    });
    this.throwForStatus(response);
    const json = (await response.json()) as GraphQlSearchResponse;
    if (json.errors && json.errors.length > 0) {
      throw new ProviderError(`GitHub GraphQL error: ${json.errors[0].message}`);
    }
    if (!json.data) {
      throw new ProviderError('GitHub GraphQL response had no data');
    }
    return json.data;
  }

  /** REST GET; returns undefined on 404. */
  private async rest(auth: AuthContext, path: string): Promise<unknown | undefined> {
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(auth),
    });
    if (response.status === 404) {
      return undefined;
    }
    this.throwForStatus(response);
    return response.json();
  }

  /** REST POST with a JSON body; throws typed errors on failure. */
  private async restPost(
    auth: AuthContext,
    path: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(auth),
      body: JSON.stringify(body),
    });
    this.throwForStatus(response);
    return response.json();
  }

  private headers(auth: AuthContext): Record<string, string> {
    return {
      authorization: `Bearer ${auth.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'gitglasses',
    };
  }

  private throwForStatus(response: HttpResponseLike): void {
    if (response.ok) {
      return;
    }
    if (response.status === 401) {
      throw new AuthError('GitHub authentication failed (401): check the token and its scopes');
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const retryAfter = response.headers.get('retry-after');
      if (remaining === '0' || retryAfter !== null || response.status === 429) {
        throw new RateLimitError(
          'GitHub rate limit exceeded',
          this.resetTime(response),
          response.status
        );
      }
      throw new ProviderError('GitHub request forbidden (403)', 403);
    }
    throw new ProviderError(`GitHub request failed with status ${response.status}`, response.status);
  }

  private resetTime(response: HttpResponseLike): Date | undefined {
    const reset = response.headers.get('x-ratelimit-reset');
    if (reset !== null && Number.isFinite(Number(reset))) {
      return new Date(Number(reset) * 1000);
    }
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        return new Date(Date.now() + seconds * 1000);
      }
      const dateMs = Date.parse(retryAfter);
      if (!Number.isNaN(dateMs)) {
        return new Date(dateMs);
      }
    }
    return undefined;
  }
}

/**
 * GitHub Enterprise Server variant: same implementation pointed at the
 * enterprise host's REST (/api/v3) and GraphQL (/api/graphql) endpoints.
 */
export function createGitHubEnterpriseProvider(
  host: string,
  fetchFn?: FetchLike
): GitHubProvider {
  return new GitHubProvider({
    id: 'github-enterprise',
    host,
    apiBaseUrl: `https://${host}/api/v3`,
    graphqlUrl: `https://${host}/api/graphql`,
    fetchFn,
  });
}
