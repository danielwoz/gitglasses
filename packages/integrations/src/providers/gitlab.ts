import { governedFetch } from '../rateLimiter.js';
import { ProviderError } from '../errors.js';
import type { FetchLike } from '../http.js';
import {
  orderCommitPullRequests,
  type AuthContext,
  type HostingCapability,
  type HostingProvider,
  type PrComments,
  type PullRequestHead,
  type PullRequestQueryOptions,
  type ReviewSuggestionInput,
  type ReviewSuggestions,
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
import {
  AVATAR_TTL_MS,
  CachedIdentity,
  COMMIT_PULL_REQUESTS_TTL_MS,
  FANOUT_CONCURRENCY,
  ISSUE_TTL_MS,
  isFullSha,
  mapPooled,
  MAX_COMMIT_PULL_REQUESTS,
  mergeByRole,
  p,
  ProviderClient,
} from './client.js';
import { assertKnownOptions, credentialHostOfUrl, sameRepoPath } from './shared.js';

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
  source_project_id?: number;
  target_project_id?: number;
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
  merged_at?: string | null;
  description?: string | null;
  user_notes_count?: number;
}

const OPTION_KEYS = ['id', 'baseUrl', 'fetchFn'] as const;

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

/**
 * Project identifier for a path: GitLab takes the full "group/project" path
 * as one URL-encoded segment.
 */
function projectPath(repo: RepoDescriptor): string {
  return `${repo.owner}/${repo.name}`;
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
  private readonly client: ProviderClient;
  private readonly identity = new CachedIdentity<string>();

  constructor(options: GitLabProviderOptions = {}) {
    assertKnownOptions(options, OPTION_KEYS, 'GitLabProvider');
    this.id = options.id ?? 'gitlab';
    const baseUrl = options.baseUrl ?? 'https://gitlab.com';
    this.client = new ProviderClient({
      name: 'GitLab',
      baseUrl,
      baseUrlLabel: 'GitLab baseUrl',
      credentialHost: credentialHostOfUrl(baseUrl),
      prefix: '/api/v4',
      headers: { accept: 'application/json' },
      authorize: (auth) => `Bearer ${auth.token}`,
      fetchFn: options.fetchFn ?? governedFetch,
    });
    this.baseUrl = this.client.baseUrl;
    this.host = this.client.host;
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
    const [reviewing, authored] = await Promise.all([
      this.mergeRequestsFor(auth, 'reviewer_username', me, limit),
      this.mergeRequestsFor(auth, 'author_username', me, limit),
    ]);
    const reviewerIds = new Set(reviewing.map((mr) => mr.id));
    const mrs = mergeByRole(authored, reviewing, (mr) => mr.id, limit);
    // Approvals cost one request per merge request; at most
    // FANOUT_CONCURRENCY are in flight at once.
    return mapPooled(mrs, FANOUT_CONCURRENCY, (mr) =>
      this.enrichAndMap(auth, mr, me, reviewerIds.has(mr.id), true)
    );
  }

  /** Open merge requests where `field` (author or reviewer) names the user. */
  private async mergeRequestsFor(
    auth: AuthContext,
    field: 'author_username' | 'reviewer_username',
    username: string,
    limit: number
  ): Promise<GitLabMergeRequest[]> {
    const mrs = await this.client.getJson<GitLabMergeRequest[]>(
      auth,
      p`/merge_requests?scope=all&state=opened&per_page=${limit}&${field}=${username}`
    );
    return mrs ?? [];
  }

  async getPullRequestForBranch(
    auth: AuthContext,
    repo: RepoDescriptor,
    branch: string,
    head?: PullRequestHead
  ): Promise<PullRequest | undefined> {
    const list = await this.client.getJson<GitLabMergeRequest[]>(
      auth,
      p`/projects/${projectPath(repo)}/merge_requests?state=opened&source_branch=${branch}`
    );
    if (!list || list.length === 0) {
      return undefined;
    }
    // source_branch matches merge requests from every fork; only the one
    // whose source project is the head repository is this branch's.
    const forked = head !== undefined && !sameRepoPath(head, repo);
    const forkId = forked ? await this.projectId(auth, `${head.owner}/${head.name}`) : undefined;
    if (forked && forkId === undefined) {
      return undefined;
    }
    const mr = list.find(
      (candidate) =>
        candidate.source_project_id ===
        (forked ? forkId : (candidate.target_project_id ?? candidate.project_id))
    );
    if (!mr) {
      return undefined;
    }
    const me = await this.username(auth);
    return this.enrichAndMap(auth, mr, me, false, true);
  }

  /**
   * The merge requests containing `sha`, from GET
   * /projects/:id/repository/commits/:sha/merge_requests, cached per commit.
   * One call carries the description and the comment count (every note,
   * review comments included). GitLab answers 404 both for a commit it does
   * not have, which has none, and for a project the credential cannot see,
   * which fails the lookup; the project itself tells the two apart.
   */
  async getPullRequestsForCommit(
    auth: AuthContext,
    repo: RepoDescriptor,
    sha: string
  ): Promise<PullRequest[]> {
    if (!isFullSha(sha)) {
      return [];
    }
    const mrs = await this.client.getJsonCached<GitLabMergeRequest[]>(
      auth,
      p`/projects/${projectPath(repo)}/repository/commits/${sha}/merge_requests`,
      COMMIT_PULL_REQUESTS_TTL_MS
    );
    if (mrs === undefined) {
      const project = await this.client.getJsonCached<Record<string, unknown>>(
        auth,
        p`/projects/${projectPath(repo)}`,
        COMMIT_PULL_REQUESTS_TTL_MS
      );
      if (project === undefined) {
        throw new ProviderError(
          `GitLab does not show ${repo.owner}/${repo.name} to this credential (404): it has no ` +
            'access to the project',
          404
        );
      }
      return [];
    }
    const mapped = await Promise.all(
      (Array.isArray(mrs) ? mrs : []).map(async (mr) => ({
        ...(await this.enrichAndMap(auth, mr, '', false, false)),
        mergedAt: mr.merged_at ?? undefined,
        body: mr.description ?? undefined,
        commentCount: mr.user_notes_count,
      }))
    );
    return orderCommitPullRequests(mapped).slice(0, MAX_COMMIT_PULL_REQUESTS);
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
    const json = await this.client.getJsonCached<Record<string, unknown>>(
      auth,
      p`/projects/${projectPath(repo)}/issues/${number}`,
      ISSUE_TTL_MS
    );
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

  /** Avatar for a commit author email, reused for AVATAR_TTL_MS per email. */
  async getAvatarUrl(auth: AuthContext, email: string): Promise<string | undefined> {
    const json = await this.client.getJsonCached<{ avatar_url?: string }>(
      auth,
      p`/avatar?email=${email}`,
      AVATAR_TTL_MS
    );
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
    const json = await this.client.postJson<{ id?: unknown; web_url?: unknown }>(
      auth,
      p`/snippets`,
      {
        title: options.description ?? options.filename,
        description: options.description,
        visibility: options.visibility ?? 'private',
        files: [{ file_path: options.filename, content: options.content }],
      }
    );
    return { id: String(json.id ?? ''), url: String(json.web_url ?? '') };
  }

  /** Fetches a snippet's raw content by id or URL via GET /snippets/:id/raw. */
  async getSnippet(auth: AuthContext, idOrUrl: string): Promise<string> {
    const id = parseGitLabSnippetId(idOrUrl);
    if (!id) {
      throw new ProviderError(`Not a recognizable GitLab snippet id or URL: ${idOrUrl}`);
    }
    return this.client.getText(auth, p`/snippets/${id}/raw`);
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
    const mrPath = p`/projects/${projectPath(pr.repo)}/merge_requests/${pr.number}`;
    const mr = await this.client.getJson<{
      diff_refs?: { base_sha?: string; start_sha?: string; head_sha?: string };
    }>(auth, mrPath);
    const diffRefs = mr?.diff_refs;
    if (!diffRefs?.base_sha || !diffRefs.start_sha || !diffRefs.head_sha) {
      throw new ProviderError(`GitLab merge request !${pr.number} has no diff refs`);
    }
    const json = await this.client.postJson<{ notes?: Array<{ id?: unknown }> }>(
      auth,
      p`${mrPath}/discussions`,
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
    );
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
    const json = await this.client.postJson<{ id?: unknown }>(
      auth,
      p`/projects/${projectPath(pr.repo)}/merge_requests/${pr.number}/notes`,
      { body }
    );
    const mrUrl = `${this.baseUrl}/${pr.repo.owner}/${pr.repo.name}/-/merge_requests/${pr.number}`;
    return { url: json.id !== undefined ? `${mrUrl}#note_${String(json.id)}` : mrUrl };
  }

  /**
   * Maps a merge request, asking for its approvals when `withApprovals` is
   * set. Without them reviewDecision stays undefined.
   */
  private async enrichAndMap(
    auth: AuthContext,
    mr: GitLabMergeRequest,
    me: string,
    fromReviewerQuery: boolean,
    withApprovals: boolean
  ): Promise<PullRequest> {
    const approvals = withApprovals
      ? await this.client.getJson<GitLabApprovals>(
          auth,
          p`/projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`
        )
      : undefined;
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
      reviewDecision: withApprovals ? (approved ? 'approved' : 'review_required') : undefined,
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

  /** Numeric id of the project at `path`, or undefined when it is not visible. */
  private async projectId(auth: AuthContext, path: string): Promise<number | undefined> {
    const project = await this.client.getJson<{ id?: number }>(auth, p`/projects/${path}`);
    return typeof project?.id === 'number' ? project.id : undefined;
  }

  private async username(auth: AuthContext): Promise<string> {
    return this.identity.get(auth.token, async () => {
      const user = await this.client.getJson<GitLabUser>(auth, p`/user`);
      if (!user) {
        throw new Error('GitLab /user returned no profile');
      }
      return user.username;
    });
  }
}
