/**
 * Normalized cross-provider data models. Every hosting/issue provider maps its
 * native payloads into these shapes so the rest of gitglasses is provider-agnostic.
 */

/** A user account on a hosting or issue provider. */
export interface Account {
  id: string;
  username: string;
  name?: string;
  avatarUrl?: string;
}

/** Identifies a repository on a specific provider host. */
export interface RepoDescriptor {
  /** Provider id, e.g. "github", "gitlab", "azuredevops". */
  provider: string;
  /** Hostname the repo lives on, e.g. "github.com". */
  host: string;
  /** Owner path. May contain a slash for providers like Azure DevOps ("org/project"). */
  owner: string;
  /** Repository name. */
  name: string;
}

export type PullRequestState = 'open' | 'merged' | 'closed';
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required';
export type ChecksStatus = 'passing' | 'failing' | 'pending' | 'none';
export type Mergeability = 'mergeable' | 'conflicts' | 'unknown';
export type ViewerRole = 'author' | 'reviewer' | 'assignee' | 'mentioned' | 'none';

/** A normalized pull/merge request. */
export interface PullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  author: Account;
  baseRef: string;
  headRef: string;
  headSha: string;
  repo: RepoDescriptor;
  createdAt: string;
  updatedAt: string;
  reviewDecision?: ReviewDecision;
  checksStatus?: ChecksStatus;
  mergeable?: Mergeability;
  viewerRole: ViewerRole;
  reviewRequestedFromViewer: boolean;
}

/** A normalized issue/work item. */
export interface Issue {
  id: string;
  /** Human-facing key, e.g. "owner/repo#123" or "PROJ-42". */
  key: string;
  title: string;
  url: string;
  state: string;
  assignee?: Account;
  updatedAt: string;
  /** Issue type name as reported by the tracker, e.g. "Bug" or "Story". */
  type?: string;
  /** Branch name suggested by the tracker itself (e.g. Linear), when available. */
  branchName?: string;
}

/** A pattern that turns plain-text references (e.g. "PROJ-42") into links. */
export interface AutolinkPattern {
  /** Source regex (string form so it can cross serialization boundaries). */
  regex: string;
  /** URL template; capture groups referenced as $1, $2, ... */
  urlTemplate: string;
  title?: string;
}
