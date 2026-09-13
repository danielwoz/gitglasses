import { governedFetch } from '../rateLimiter.js';
import { ProviderError } from '../errors.js';
import { defaultFetch, type FetchLike } from '../http.js';
import type {
  AuthContext,
  HostingCapability,
  HostingProvider,
  PrComments,
  PullRequestQueryOptions,
  ReviewSuggestionInput,
  ReviewSuggestions,
} from '../hostingProvider.js';
import {
  parseGitLabSnippetId,
  type SnippetCreateOptions,
  type SnippetHost,
  type SnippetRef,
} from '../snippets.js';
import type {
  Account,
  AutolinkPattern,
  ChecksStatus,
  Issue,
  Mergeability,
  PullRequest,
  PullRequestState,
  RepoDescriptor,
  ViewerRole,
} from '../models.js';
import { parseRemoteUrl } from '../remoteMatcher.js';
import { assertSecureBaseUrl, hostOfUrl, throwForStatus , tokenFingerprint} from './shared.js';

export interface GitLabProviderOptions {
  /** Provider id used in RepoDescriptors. Default "gitlab". */
  id?: string;
  /** Instance base URL; default "https://gitlab.com". Self-managed instances pass their own. */
  baseUrl?: string;
  /** HTTP transport; defaults to the global fetch. Tests inject a stub here. */
  fetchFn?: FetchLike;
}

interface GitLabUser {
  id: number;
  username: string;
  name?: string;
  avatar_url?: string;
}

interface GitLabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author: GitLabUser;
  assignees?: GitLabUser[];
  reviewers?: GitLabUser[];
  source_branch: string;
  target_branch: string;
  sha?: string;
  created_at: string;
  updated_at: string;
  merge_status?: string;
  detailed_merge_status?: string;
  head_pipeline?: { status?: string } | null;
  references?: { full?: string };
}

interface GitLabApprovals {
  approved?: boolean;
  approved_by?: Array<{ user: GitLabUser }>;
}

function mapState(state: string): PullRequestState {
  switch (state) {
    case 'opened':
      return 'open';
    case 'merged':
      return 'merged';
    default:
      return 'closed';
  }
}

function mapMergeable(mr: GitLabMergeRequest): Mergeability {
  const detailed = mr.detailed_merge_status;
  if (detailed === 'mergeable') {
    return 'mergeable';
  }
  if (detailed?.startsWith('conflict')) {
    return 'conflicts';
  }
  if (detailed === undefined) {
    if (mr.merge_status === 'can_be_merged') {
      return 'mergeable';
    }
    if (mr.merge_status === 'cannot_be_merged') {
      return 'conflicts';
    }
  }
  return 'unknown';
}

function mapChecksStatus(pipelineStatus: string | undefined): ChecksStatus {
  switch (pipelineStatus) {
    case 'success':
      return 'passing';
    case 'failed':
      return 'failing';
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'manual':
    case 'scheduled':
      return 'pending';
    default:
      return 'none';
  }
}

function mapAccount(user: GitLabUser): Account {
  return {
    id: String(user.id),
    username: user.username,
    name: user.name,
    avatarUrl: user.avatar_url,
  };
}

/**
 * GitLab hosting provider backed by the REST v4 API. Serves gitlab.com by
 * default; self-managed instances pass their own baseUrl.
 */
export class GitLabProvider implements HostingProvider, SnippetHost, ReviewSuggestions, PrComments {
  readonly id: string;
  readonly host: string;
  readonly capabilities: ReadonlySet<HostingCapability> = new Set<HostingCapability>([
    'prs',
    'prForBranch',
    'checks',
    'reviews',
    'mergeability',
    'autolinks',
    'avatars',
    'gists',
    'suggestions',
  ]);

  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private cachedUsername?: string;
  private cachedUsernameToken?: string;

  constructor(options: GitLabProviderOptions = {}) {
    this.id = options.id ?? 'gitlab';
    const baseUrl = (options.baseUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
    this.baseUrl = assertSecureBaseUrl(baseUrl, 'GitLab baseUrl');
    this.host = hostOfUrl(this.baseUrl);
    this.fetchFn = options.fetchFn ?? governedFetch;
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
    const query = `scope=all&state=opened&per_page=${limit}`;
    const [reviewing, authored] = await Promise.all([
      this.get(auth, `/merge_requests?${query}&reviewer_username=${encodeURIComponent(me)}`),
      this.get(auth, `/merge_requests?${query}&author_username=${encodeURIComponent(me)}`),
    ]);
    const reviewerIds = new Set(
      ((reviewing ?? []) as GitLabMergeRequest[]).map((mr) => mr.id)
    );
    const merged = new Map<number, GitLabMergeRequest>();
    for (const mr of [
      ...((authored ?? []) as GitLabMergeRequest[]),
      ...((reviewing ?? []) as GitLabMergeRequest[]),
    ]) {
      if (!merged.has(mr.id)) {
        merged.set(mr.id, mr);
      }
    }
    const mrs = [...merged.values()].slice(0, limit);
    return Promise.all(
      mrs.map((mr) => this.enrichAndMap(auth, mr, me, reviewerIds.has(mr.id)))
    );
  }

  async getPullRequestForBranch(
    auth: AuthContext,
    repo: RepoDescriptor,
    branch: string
  ): Promise<PullRequest | undefined> {
    const project = encodeURIComponent(`${repo.owner}/${repo.name}`);
    const list = (await this.get(
      auth,
      `/projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`
    )) as GitLabMergeRequest[] | undefined;
    const mr = list?.[0];
    if (!mr) {
      return undefined;
    }
    const me = await this.username(auth);
    return this.enrichAndMap(auth, mr, me, false);
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
    const project = encodeURIComponent(`${repo.owner}/${repo.name}`);
    const json = (await this.get(auth, `/projects/${project}/issues/${number}`)) as
      | Record<string, unknown>
      | undefined;
    if (json === undefined) {
      return undefined;
    }
    const assignees = (json.assignees as GitLabUser[] | undefined) ?? [];
    const assignee = assignees[0] ?? (json.assignee as GitLabUser | null | undefined);
    return {
      id: String(json.id),
      key: `${repo.owner}/${repo.name}#${json.iid}`,
      title: String(json.title),
      url: String(json.web_url),
      state: String(json.state),
      assignee: assignee ? mapAccount(assignee) : undefined,
      updatedAt: String(json.updated_at),
    };
  }

  async getAvatarUrl(auth: AuthContext, email: string): Promise<string | undefined> {
    const json = (await this.get(auth, `/avatar?email=${encodeURIComponent(email)}`)) as
      | { avatar_url?: string }
      | undefined;
    return json?.avatar_url ?? undefined;
  }

  /** Static reference patterns for GitLab issue (#N) and merge request (!N) shorthands. */
  async getAutolinkPatterns(
    _auth: AuthContext,
    repo: RepoDescriptor
  ): Promise<AutolinkPattern[]> {
    const projectUrl = `${this.baseUrl}/${repo.owner}/${repo.name}`;
    return [
      { regex: '#(\\d+)', urlTemplate: `${projectUrl}/-/issues/$1`, title: 'GitLab issue' },
      {
        regex: '!(\\d+)',
        urlTemplate: `${projectUrl}/-/merge_requests/$1`,
        title: 'GitLab merge request',
      },
    ];
  }

  /**
   * Creates a personal snippet via POST /snippets. Visibility defaults to
   * "private"; note that private GitLab snippets are visible only to their
   * author (the URL is NOT link-shareable by arbitrary users, unlike a secret
   * gist) — pass visibility "internal" or "public" to share the link.
   */
  async createSnippet(auth: AuthContext, options: SnippetCreateOptions): Promise<SnippetRef> {
    const json = (await this.post(auth, '/snippets', {
      title: options.description ?? options.filename,
      description: options.description,
      visibility: options.visibility ?? 'private',
      files: [{ file_path: options.filename, content: options.content }],
    })) as { id?: unknown; web_url?: unknown };
    return { id: String(json.id ?? ''), url: String(json.web_url ?? '') };
  }

  /** Fetches a snippet's raw content by id or URL via GET /snippets/:id/raw. */
  async getSnippet(auth: AuthContext, idOrUrl: string): Promise<string> {
    const id = parseGitLabSnippetId(idOrUrl);
    if (!id) {
      throw new ProviderError(`Not a recognizable GitLab snippet id or URL: ${idOrUrl}`);
    }
    const response = await this.fetchFn(`${this.baseUrl}/api/v4/snippets/${id}/raw`, {
      method: 'GET',
      headers: this.headers(auth),
    });
    throwForStatus('GitLab', response);
    return response.text();
  }

  /**
   * Posts a diff-anchored discussion on the MR. The position anchors to a
   * single line (endLine) of the head diff; multi-line replacements are
   * expressed inside the body with GitLab's ```suggestion:-N+0 offset syntax,
   * which avoids the line_range/line_code position plumbing. A 400 means the
   * line is not part of the MR head diff.
   */
  async createReviewSuggestion(
    auth: AuthContext,
    pr: PullRequest,
    input: ReviewSuggestionInput
  ): Promise<{ url: string }> {
    const project = encodeURIComponent(`${pr.repo.owner}/${pr.repo.name}`);
    const mr = (await this.get(auth, `/projects/${project}/merge_requests/${pr.number}`)) as
      | { diff_refs?: { base_sha?: string; start_sha?: string; head_sha?: string } }
      | undefined;
    const diffRefs = mr?.diff_refs;
    if (!diffRefs?.base_sha || !diffRefs.start_sha || !diffRefs.head_sha) {
      throw new ProviderError(`GitLab merge request !${pr.number} has no diff refs`);
    }
    const json = (await this.post(
      auth,
      `/projects/${project}/merge_requests/${pr.number}/discussions`,
      {
        body: input.body,
        position: {
          position_type: 'text',
          base_sha: diffRefs.base_sha,
          start_sha: diffRefs.start_sha,
          head_sha: diffRefs.head_sha,
          old_path: input.path,
          new_path: input.path,
          new_line: input.endLine,
        },
      }
    )) as { notes?: Array<{ id?: unknown }> };
    const noteId = json.notes?.[0]?.id;
    return { url: noteId !== undefined ? `${pr.url}#note_${String(noteId)}` : pr.url };
  }

  /**
   * Posts a plain (non-positioned) note on the merge request via
   * POST /projects/:id/merge_requests/:iid/notes. Serves as the fallback
   * channel when a suggestion cannot anchor to the diff.
   */
  async createPullRequestComment(
    auth: AuthContext,
    pr: { repo: RepoDescriptor; number: number },
    body: string
  ): Promise<{ url: string }> {
    const project = encodeURIComponent(`${pr.repo.owner}/${pr.repo.name}`);
    const json = (await this.post(
      auth,
      `/projects/${project}/merge_requests/${pr.number}/notes`,
      { body }
    )) as { id?: unknown };
    const mrUrl = `${this.baseUrl}/${pr.repo.owner}/${pr.repo.name}/-/merge_requests/${pr.number}`;
    return { url: json.id !== undefined ? `${mrUrl}#note_${String(json.id)}` : mrUrl };
  }

  private async enrichAndMap(
    auth: AuthContext,
    mr: GitLabMergeRequest,
    me: string,
    fromReviewerQuery: boolean
  ): Promise<PullRequest> {
    const approvals = (await this.get(
      auth,
      `/projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`
    )) as GitLabApprovals | undefined;
    const approved =
      approvals !== undefined &&
      (approvals.approved === true || (approvals.approved_by?.length ?? 0) > 0);

    const isReviewer =
      fromReviewerQuery || (mr.reviewers ?? []).some((user) => user.username === me);
    let viewerRole: ViewerRole = 'none';
    if (mr.author.username === me) {
      viewerRole = 'author';
    } else if (isReviewer) {
      viewerRole = 'reviewer';
    } else if ((mr.assignees ?? []).some((user) => user.username === me)) {
      viewerRole = 'assignee';
    }

    return {
      id: String(mr.id),
      number: mr.iid,
      title: mr.title,
      url: mr.web_url,
      state: mapState(mr.state),
      draft: mr.draft ?? mr.work_in_progress ?? false,
      author: mapAccount(mr.author),
      baseRef: mr.target_branch,
      headRef: mr.source_branch,
      headSha: mr.sha ?? '',
      repo: this.repoFromMr(mr),
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      reviewDecision: approved ? 'approved' : 'review_required',
      checksStatus: mapChecksStatus(mr.head_pipeline?.status),
      mergeable: mapMergeable(mr),
      viewerRole,
      reviewRequestedFromViewer: viewerRole === 'reviewer',
    };
  }

  private repoFromMr(mr: GitLabMergeRequest): RepoDescriptor {
    // The web URL carries the full (possibly nested-group) project path.
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/i.exec(mr.web_url);
    const path = match?.[1] ?? mr.references?.full?.replace(/!\d+$/, '') ?? '';
    const segments = path.split('/').filter(Boolean);
    return {
      provider: this.id,
      host: this.host,
      owner: segments.slice(0, -1).join('/'),
      name: segments[segments.length - 1] ?? '',
    };
  }

  private async username(auth: AuthContext): Promise<string> {
    if (this.cachedUsername !== undefined && this.cachedUsernameToken === tokenFingerprint(auth.token)) {
      return this.cachedUsername;
    }
    const user = (await this.get(auth, '/user')) as GitLabUser | undefined;
    if (!user) {
      throw new Error('GitLab /user returned no profile');
    }
    this.cachedUsername = user.username;
    this.cachedUsernameToken = tokenFingerprint(auth.token);
    return user.username;
  }

  /** REST GET against /api/v4; returns undefined on 404. */
  private async get(auth: AuthContext, path: string): Promise<unknown | undefined> {
    const response = await this.fetchFn(`${this.baseUrl}/api/v4${path}`, {
      method: 'GET',
      headers: this.headers(auth),
    });
    if (response.status === 404) {
      return undefined;
    }
    throwForStatus('GitLab', response);
    return response.json();
  }

  /** REST POST against /api/v4 with a JSON body; throws typed errors on failure. */
  private async post(
    auth: AuthContext,
    path: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}/api/v4${path}`, {
      method: 'POST',
      headers: { ...this.headers(auth), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    throwForStatus('GitLab', response);
    return response.json();
  }

  private headers(auth: AuthContext): Record<string, string> {
    return {
      authorization: `Bearer ${auth.token}`,
      accept: 'application/json',
      'user-agent': 'gitglasses',
    };
  }
}
