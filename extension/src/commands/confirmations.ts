// Confirmation text for destructive git operations. Every builder returns the
// modal message plus a detail line that states the exact git operation, so the
// user always sees what will run before proceeding. Pure (no vscode imports)
// so tests can assert the exact strings.

import { shortSha } from '@gitglasses/protocol/sha';

export interface Confirmation {
  message: string;
  detail: string;
}

export function confirmResetHard(branch: string, ref: string): Confirmation {
  return {
    message: `Hard reset '${branch}' to ${ref}?`,
    detail: `git reset --hard ${ref}\n\nDiscards all staged and working tree changes and moves '${branch}' to ${ref}.`,
  };
}

export function confirmMerge(ref: string, intoBranch: string): Confirmation {
  return {
    message: `Merge ${ref} into '${intoBranch}'?`,
    detail: `git merge ${ref}\n\nCreates a merge commit on '${intoBranch}' unless a fast-forward applies.`,
  };
}

export function confirmRebase(branch: string, upstream: string): Confirmation {
  return {
    message: `Rebase '${branch}' onto ${upstream}?`,
    detail: `git rebase ${upstream}\n\nReplays the commits of '${branch}' onto ${upstream}; commit shas change.`,
  };
}

export function confirmCherryPick(shas: readonly string[]): Confirmation {
  const short = shas.map(shortSha);
  const plural = shas.length !== 1;
  return {
    message: plural ? `Cherry-pick ${shas.length} commits?` : `Cherry-pick commit ${short[0]}?`,
    detail: `git cherry-pick ${short.join(' ')}\n\nApplies the ${
      plural ? 'changes' : 'change'
    } onto the current branch as ${plural ? 'new commits' : 'a new commit'}.`,
  };
}

export function confirmRevert(shas: readonly string[]): Confirmation {
  const short = shas.map(shortSha);
  const plural = shas.length !== 1;
  return {
    message: plural ? `Revert ${shas.length} commits?` : `Revert commit ${short[0]}?`,
    detail: `git revert ${short.join(' ')}\n\nCreates ${
      plural ? 'new commits that undo the selected changes' : 'a new commit that undoes the change'
    }.`,
  };
}

export function confirmBranchDelete(name: string): Confirmation {
  return {
    message: `Delete branch '${name}'?`,
    detail: `git branch -d ${name}`,
  };
}

export function confirmBranchForceDelete(name: string): Confirmation {
  return {
    message: `Force delete branch '${name}'?`,
    detail: `git branch -D ${name}\n\nThe branch is not fully merged; its commits may be lost.`,
  };
}

export function confirmStashDrop(index: number, message: string): Confirmation {
  return {
    message: `Drop stash@{${index}}?`,
    detail: `git stash drop stash@{${index}}\n\n${message}`,
  };
}

export function confirmWorktreeRemove(path: string): Confirmation {
  return {
    message: `Remove worktree at ${path}?`,
    detail: `git worktree remove ${path}`,
  };
}

export function confirmWorktreeForceRemove(path: string): Confirmation {
  return {
    message: `Force remove worktree at ${path}?`,
    detail: `git worktree remove --force ${path}\n\nRemoves the worktree even if it has modified or untracked files.`,
  };
}
