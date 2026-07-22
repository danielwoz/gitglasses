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
  | 'autolinks'
  | 'createPR';

/** Credentials for a provider call. Tokens come from the host app's secret storage. */
export interface AuthContext {
  token: string;
}

export interface PullRequestQueryOptions {
  /** Maximum number of results to return. */
  limit?: number;
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

/** An issue tracker (Jira, Linear, GitHub Issues, ...). */
export interface IssueProvider {
  readonly id: string;

  /** Issues assigned to (or otherwise involving) the authenticated user. */
  getMyIssues(auth: AuthContext, opts?: IssueQueryOptions): Promise<Issue[]>;

  /** Resolve an issue by its key, e.g. "PROJ-42". */
  getIssue(auth: AuthContext, key: string): Promise<Issue | undefined>;

  /** A git-branch-safe name derived from the issue, e.g. "proj-42-fix-login". */
  suggestBranchName(issue: Issue): string;
}
