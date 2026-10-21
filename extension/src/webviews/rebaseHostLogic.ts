// Pure decisions of the rebase editor host: whether the working tree needs
// stashing, what to tell the user about it, and whether a plan being edited
// still describes the branch. No vscode imports, so vitest covers it.

/** What the open plan was made against. */
export interface RebaseSession {
  upstream: string;
  branch: string;
  /** HEAD and the upstream commit when the plan was made. */
  headSha: string;
  upstreamSha: string;
  /** Uncommitted changes are stashed and restored around the rebase. */
  autoStash: boolean;
}

interface WorkingTreeStatus {
  staged: readonly unknown[];
  unstaged: readonly unknown[];
}

/** Uncommitted changes to tracked files, which `git rebase` refuses to run
 *  over. Untracked files do not count: git leaves them alone. */
export function isDirty(status: WorkingTreeStatus): boolean {
  return status.staged.length > 0 || status.unstaged.length > 0;
}

export function autoStashPrompt(status: WorkingTreeStatus): { message: string; detail: string } {
  const count = status.staged.length + status.unstaged.length;
  return {
    message: 'You have uncommitted changes.',
    detail:
      `${count} changed file${count === 1 ? '' : 's'}. A rebase needs a clean working tree. ` +
      'GitGlasses can stash the changes, rebase, and restore them afterwards ' +
      '(git rebase --autostash). If they conflict with the rebased branch, they stay ' +
      'in the stash.',
  };
}

/** Why a plan no longer matches the branch, or undefined when it still does.
 *  `preview` is a fresh rebase/preview for the same upstream. */
export function staleReason(
  session: RebaseSession,
  preview: { headSha: string; upstreamSha: string },
): string | undefined {
  const reasons: string[] = [];
  if (preview.headSha !== session.headSha) {
    reasons.push(
      `'${session.branch}' moved from ${session.headSha.slice(0, 7)} to ${preview.headSha.slice(0, 7)}`,
    );
  }
  if (preview.upstreamSha !== session.upstreamSha) {
    reasons.push(
      `${session.upstream} moved from ${session.upstreamSha.slice(0, 7)} to ${preview.upstreamSha.slice(0, 7)}`,
    );
  }
  return reasons.length === 0 ? undefined : `${reasons.join('; ')} since this plan was made.`;
}

/** What to tell the user when a rebase finished but git could not put the
 *  changes it stashed first back on top (it keeps them as stash@{0}).
 *  `conflicted` are the files the attempt left in conflict. */
export function autoStashKeptWarning(conflicted: readonly string[]): string {
  if (conflicted.length === 0) {
    return 'GitGlasses: the rebase completed, but your uncommitted changes could not be restored. They are kept in stash@{0}; apply it when you are ready.';
  }
  const shown = conflicted.slice(0, 3).join(', ');
  const more = conflicted.length > 3 ? ` and ${conflicted.length - 3} more` : '';
  return (
    `GitGlasses: the rebase completed, but your uncommitted changes conflict with it ` +
    `(${shown}${more}). Resolve the conflicts, then drop stash@{0}, which still holds the changes.`
  );
}
