import type { AutolinkPattern, Issue, PullRequest, RepoDescriptor } from './models.js';

/** Feature flags a hosting provider can advertise. */
export type HostingCapability =
  | 'prs'
  | 'prForBranch'
  | 'checks'
  | 'reviews'
  | 'mergeability'
  | 'suggestions'
  | 'gists'
  | 'avatars'
  | 'autolinks';

/** Credentials for a provider call. Tokens come from the host app's secret storage. */
export interface AuthContext {
  token: string;
  /**
   * Account identifier for providers whose API tokens are bound to a login,
   * e.g. the Jira account email or the Bitbucket username for basic auth.
   */
  username?: string;
}

export interface PullRequestQueryOptions {
  /** Maximum number of results to return. */
  limit?: number;
  /**
   * Repository context for providers whose review-request queries are
   * repo-scoped (e.g. Bitbucket Cloud). Providers with account-wide queries
   * ignore it.
   */
  repo?: RepoDescriptor;
}

export interface IssueQueryOptions {
  limit?: number;
}

/**
 * A git hosting provider (GitHub, GitLab, ...). Implementations are pure
 * TypeScript and safe to run in both the extension host and the MCP server.
 */
export interface HostingProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<HostingCapability>;

  /** Returns a descriptor when the remote URL belongs to this provider, else undefined. */
  matchesRemote(remoteUrl: string): RepoDescriptor | undefined;

  /** Open pull requests involving the authenticated user (author, reviewer, assignee, mention). */
  getMyPullRequests(auth: AuthContext, opts?: PullRequestQueryOptions): Promise<PullRequest[]>;

  /** The open pull request whose head is `branch` in `repo`, if any. */
  getPullRequestForBranch(
    auth: AuthContext,
    repo: RepoDescriptor,
    branch: string
  ): Promise<PullRequest | undefined>;

  /** Resolve a reference like "#123" or "123" to an issue or pull request. */
  getIssueOrPr(
    auth: AuthContext,
    repo: RepoDescriptor,
    ref: string
  ): Promise<Issue | PullRequest | undefined>;

  /** Avatar URL for a commit author email, when the provider supports lookup. */
  getAvatarUrl?(auth: AuthContext, email: string): Promise<string | undefined>;

  /** Repo-configured autolink patterns, when the provider supports them. */
  getAutolinkPatterns?(auth: AuthContext, repo: RepoDescriptor): Promise<AutolinkPattern[]>;
}

export interface ReviewSuggestionInput {
  /** File path relative to the repository root, forward slashes. */
  path: string;
  /** 1-based first line of the replaced range in the PR head version. */
  startLine: number;
  /** 1-based last line of the range, inclusive; equals startLine for one line. */
  endLine: number;
  /** Full comment body, including the ```suggestion fenced block. */
  body: string;
}

/**
 * Additive capability interface for providers that can post diff-anchored
 * review comments carrying a ```suggestion block. The comment anchors to the
 * PR head sha: when the local file differs from the head on those lines the
 * provider rejects the anchor (GitHub 422, GitLab 400) and callers should
 * surface "unpushed/uncommitted changes" guidance.
 */
export interface ReviewSuggestions {
  createReviewSuggestion(
    auth: AuthContext,
    pr: PullRequest,
    input: ReviewSuggestionInput
  ): Promise<{ url: string }>;
}

/** True when the provider implements the ReviewSuggestions capability. */
export function supportsReviewSuggestions<T extends object>(
  provider: T
): provider is T & ReviewSuggestions {
  return typeof (provider as Partial<ReviewSuggestions>).createReviewSuggestion === 'function';
}

/**
 * Additive capability interface for providers that can post a plain top-level
 * comment on a pull request. Used as the fallback channel when a suggestion
 * cannot anchor to the diff: the caller posts an Open-Patch link as a PR
 * comment instead.
 */
export interface PrComments {
  createPullRequestComment(
    auth: AuthContext,
    pr: { repo: RepoDescriptor; number: number },
    body: string
  ): Promise<{ url: string }>;
}

/** True when the provider implements the PrComments capability. */
export function supportsPrComments<T extends object>(provider: T): provider is T & PrComments {
  return typeof (provider as Partial<PrComments>).createPullRequestComment === 'function';
}

/** An issue tracker (Jira, Linear, GitHub Issues, ...). */
export interface IssueProvider {
  readonly id: string;

  /** Issues assigned to (or otherwise involving) the authenticated user. */
  getMyIssues(auth: AuthContext, opts?: IssueQueryOptions): Promise<Issue[]>;

  /** Resolve an issue by its key, e.g. "PROJ-42". */
  getIssue(auth: AuthContext, key: string): Promise<Issue | undefined>;

  /** A git-branch-safe name derived from the issue, e.g. "proj-42-fix-login". */
  suggestBranchName(issue: Issue): string;

  /**
   * Record a link from the issue to a git branch, so the branch shows up on
   * the issue in the tracker's UI. Providers that auto-link by branch name
   * implement this as a no-op; providers that need a URL may throw
   * NotSupportedError when `branch.url` is absent.
   */
  createBranchLink?(
    auth: AuthContext,
    issue: Issue,
    branch: { name: string; url?: string }
  ): Promise<void>;
}
