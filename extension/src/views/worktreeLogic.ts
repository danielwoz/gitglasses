// Pure worktree presentation helpers (no vscode imports) so the tree labels,
// status lines, confirmations and the status cache stay unit-testable.

import type { MergeSkipReason, WorktreeEntry, WorktreeStatus } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import type { Confirmation } from '../commands/confirmations';
import { relativeTime } from '../system/dates';

function stripTrailingSeparators(p: string): string {
  const stripped = p.replace(/[\\/]+$/, '');
  return stripped === '' ? p : stripped;
}

/** Directory basename of a worktree path (either separator style). */
export function worktreeLabel(worktreePath: string): string {
  const trimmed = stripTrailingSeparators(worktreePath);
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** Suggested location for a new worktree: a `<repo>-<ref>` sibling directory
 *  of the repository root, with ref characters unsafe in paths replaced. */
export function defaultWorktreePath(repoRoot: string, ref: string): string {
  const name = worktreeLabel(repoRoot);
  const safeRef = ref.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `../${name}-${safeRef}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Why a merge check has no answer, for a tooltip. */
const MERGE_SKIPPED: Record<MergeSkipReason, string> = {
  restricted: 'not checked in Restricted Mode',
  noGitCli: 'not checked: needs the git CLI',
  gitVersion: 'not checked: needs git 2.38 or later',
  partialClone: 'not checked: a partial clone needs git 2.45 or later',
  failed: 'could not be checked (see the GitGlasses output)',
};

/** Whether the worktree is checked out on the branch it is compared with. */
function isOnBase(worktree: WorktreeEntry, status: WorktreeStatus): boolean {
  return status.base !== undefined && worktree.branch === status.base.ref;
}

/** Whether the worktree has no checkout to read: its directory is gone, or
 *  is no longer a worktree, or is missing while a lock keeps the entry. */
export function hasNoCheckout(worktree: WorktreeEntry): boolean {
  return worktree.prunable || worktree.missing;
}

/** The kind of row a worktree is, for its context menu: the current one, the
 *  main one, a linked one, or one that cannot be opened (bare, or its
 *  directory is gone). */
export function worktreeContext(worktree: WorktreeEntry, index: number): string {
  if (worktree.bare) return 'gitglassesBareWorktree';
  if (hasNoCheckout(worktree)) return 'gitglassesMissingWorktree';
  if (worktree.current) return 'gitglassesCurrentWorktree';
  // worktree/list puts the main worktree first.
  return index === 0 ? 'gitglassesMainWorktree' : 'gitglassesWorktree';
}

/** The row's label: the branch, which names the work (an agent's worktree
 *  folder is often an opaque id), or the folder for a detached or bare one. */
export function worktreeRowLabel(worktree: WorktreeEntry): string {
  return worktree.bare || !worktree.branch ? worktreeLabel(worktree.path) : worktree.branch;
}

/**
 * The row's description: what the status says at a glance, e.g. `3 changed ·
 * ↑2 ↓0 · merges cleanly · Claude Code`, after the fixed facts (detached,
 * current, missing, locked). The status parts come first so a narrow sidebar
 * cuts the agent name before the merge verdict.
 */
export function worktreeDescription(worktree: WorktreeEntry, status?: WorktreeStatus): string {
  const parts: string[] = [];
  if (worktree.bare) parts.push('bare');
  else if (!worktree.branch) parts.push(`detached@${shortSha(worktree.sha)}`);
  if (worktree.current) parts.push('current');
  if (hasNoCheckout(worktree)) parts.push('missing');
  if (worktree.locked) parts.push('locked');
  if (status) {
    if (status.dirty) parts.push(`${status.dirty} changed`);
    const base = status.base;
    if (base && isOnBase(worktree, status)) {
      parts.push('base');
    } else if (base) {
      parts.push(`↑${base.ahead} ↓${base.behind}`);
      // With nothing ahead there is nothing to merge, so no verdict either.
      if (base.ahead > 0 && base.mergesCleanly === true) parts.push('merges cleanly');
      if (base.ahead > 0 && base.mergesCleanly === false) {
        const count = base.conflicts?.length ?? 0;
        parts.push(count > 0 ? `conflicts in ${plural(count, 'file')}` : 'conflicts');
      }
    }
    if (status.agent) parts.push(status.agent.name);
  }
  return parts.join(' · ');
}

const EVIDENCE: Record<NonNullable<WorktreeStatus['agent']>['evidence'], string> = {
  path: 'where the worktree is',
  branch: 'the branch name',
  trailer: 'a commit trailer',
};

/** Most conflicted paths a tooltip names. */
const TOOLTIP_CONFLICTS = 10;

/** The row's tooltip: everything worktree/list and worktree/status said. */
export function worktreeTooltip(
  worktree: WorktreeEntry,
  status: WorktreeStatus | undefined,
  options: { error?: string; nowSeconds?: number } = {},
): string {
  const lines = [worktree.path];
  if (worktree.bare) {
    lines.push('Bare repository');
  } else if (worktree.branch) {
    lines.push(`Branch: ${worktree.branch} at ${shortSha(worktree.sha)}`);
  } else {
    lines.push(`Detached HEAD at ${shortSha(worktree.sha)}`);
  }
  if (worktree.prunable) {
    lines.push(
      worktree.missing
        ? 'The directory is gone; `git worktree prune` removes the entry.'
        : 'The directory is no longer a worktree (its .git file is gone); `git worktree prune` removes the entry.',
    );
  } else if (worktree.missing) {
    lines.push(
      'The directory is missing; the lock keeps `git worktree prune` from removing the entry.',
    );
  }
  if (worktree.locked) lines.push('Locked against removal and pruning');
  if (status?.agent) {
    lines.push(`Agent: ${status.agent.name} (going by ${EVIDENCE[status.agent.evidence]})`);
  }
  if (status?.dirty !== undefined) {
    lines.push(
      status.dirty === 0
        ? 'No uncommitted changes'
        : `Uncommitted: ${plural(status.dirty, 'changed path')}`,
    );
  }
  if (status?.upstream) {
    const { ref, ahead, behind } = status.upstream;
    lines.push(`Upstream ${ref}: ${ahead} ahead, ${behind} behind`);
  }
  const base = status?.base;
  if (base && status && isOnBase(worktree, status)) {
    lines.push(`Base for the comparisons: ${base.ref}`);
  } else if (base) {
    lines.push(`Against ${base.ref}: ${base.ahead} ahead, ${base.behind} behind`);
    if (base.ahead === 0) {
      lines.push(`Nothing to merge into ${base.ref}`);
    } else if (base.mergesCleanly === true) {
      lines.push(`Merges cleanly into ${base.ref}`);
    } else if (base.mergesCleanly === false) {
      const conflicts = base.conflicts ?? [];
      const shown = conflicts.slice(0, TOOLTIP_CONFLICTS).join(', ');
      const more = conflicts.length > TOOLTIP_CONFLICTS ? ` and ${conflicts.length - TOOLTIP_CONFLICTS} more` : '';
      lines.push(
        conflicts.length > 0
          ? `Conflicts with ${base.ref} in ${shown}${more}`
          : `Conflicts with ${base.ref}`,
      );
    } else {
      lines.push(`Merge into ${base.ref}: ${MERGE_SKIPPED[base.mergeSkipped ?? 'failed']}`);
    }
  }
  if (status?.lastActivity !== undefined) {
    lines.push(`Last activity: ${relativeTime(status.lastActivity, options.nowSeconds)}`);
  }
  if (options.error) lines.push(`Status unavailable: ${options.error}`);
  return lines.join('\n');
}

/** Asks once before removing a worktree and its branch, naming everything
 *  that goes: the directory, the branch and any commits only it has. */
export function confirmWorktreeAndBranchRemove(
  worktree: WorktreeEntry,
  status: WorktreeStatus | undefined,
): Confirmation {
  const label = worktreeLabel(worktree.path);
  const branch = worktree.branch;
  const lines = [`Worktree: ${worktree.path}`];
  if (branch) {
    const base = status?.base;
    const unmerged =
      base && base.ahead > 0
        ? ` (${plural(base.ahead, 'commit')} not on ${base.ref} will be lost)`
        : '';
    lines.push(`Branch: ${branch}${unmerged}`);
  }
  if (status?.dirty) {
    lines.push(
      `${plural(status.dirty, 'uncommitted change')} — you will be asked again before they are discarded.`,
    );
  }
  lines.push('', `git worktree remove ${worktree.path}`);
  if (branch) lines.push(`git branch -D ${branch}`);
  return {
    message: branch
      ? `Remove worktree '${label}' and delete branch '${branch}'?`
      : `Remove worktree '${label}'?`,
    detail: lines.join('\n'),
  };
}

/** The second question when the worktree has uncommitted changes. */
export function confirmDiscardWorktreeChanges(worktree: WorktreeEntry, dirty: number): Confirmation {
  return {
    message: `Discard ${plural(dirty, 'uncommitted change')} in '${worktreeLabel(worktree.path)}'?`,
    detail: `git worktree remove --force ${worktree.path}\n\nModified and untracked files in the worktree are deleted and cannot be recovered.`,
  };
}

/** What is known about one worktree's status. */
export interface StatusEntry {
  /** The latest answer; kept while a newer one loads. */
  status?: WorktreeStatus;
  /** Why the latest load failed. */
  error?: string;
}

interface Stored extends StatusEntry {
  key: string;
  generation: number;
}

/**
 * Loads worktree/status lazily and a few at a time, so a repository with
 * dozens of worktrees costs only what is on screen: get() answers from the
 * cache and queues a load when the answer is missing, out of date (another
 * commit or base, `key`) or older than the last invalidate(). Answers arrive
 * through `onLoaded`.
 */
export class WorktreeStatusCache {
  private readonly entries = new Map<string, Stored>();
  /** Loads queued or running, by path: the key and generation they serve. */
  private readonly pending = new Map<string, string>();
  private readonly queue: { path: string; key: string; generation: number }[] = [];
  private running = 0;
  private generation = 0;

  constructor(
    private readonly load: (path: string) => Promise<WorktreeStatus>,
    private readonly onLoaded: (path: string) => void,
    private readonly concurrency = 3,
  ) {}

  /** The latest known status for `path`, loading a newer one if needed. */
  get(path: string, key: string): StatusEntry | undefined {
    const entry = this.entries.get(path);
    if (!entry || entry.key !== key || entry.generation !== this.generation) {
      this.enqueue(path, key);
    }
    return entry;
  }

  /** Marks every answer out of date; each is kept on screen until the next
   *  get() for it has loaded a new one. */
  invalidate(): void {
    this.generation += 1;
  }

  /** Forgets worktrees that are no longer listed. */
  retain(paths: ReadonlySet<string>): void {
    for (const path of [...this.entries.keys()]) {
      if (!paths.has(path)) this.entries.delete(path);
    }
  }

  /** Loads queued or running. */
  get busy(): number {
    return this.queue.length + this.running;
  }

  private enqueue(path: string, key: string): void {
    const token = `${this.generation}|${key}`;
    if (this.pending.get(path) === token) return;
    this.pending.set(path, token);
    this.queue.push({ path, key, generation: this.generation });
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const token = `${job.generation}|${job.key}`;
      // A newer request for the same path replaced this one.
      if (this.pending.get(job.path) !== token) continue;
      this.running += 1;
      void this.load(job.path)
        .then(
          (status) => ({ status }),
          (error: unknown) => ({
            status: this.entries.get(job.path)?.status,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((result) => {
          this.running -= 1;
          if (this.pending.get(job.path) === token) this.pending.delete(job.path);
          this.entries.set(job.path, { ...result, key: job.key, generation: job.generation });
          this.onLoaded(job.path);
          this.pump();
        });
    }
  }
}

/** The cache key of a worktree's status: what the answer depends on beyond
 *  the working tree itself. */
export function statusKey(worktree: WorktreeEntry, base: string | undefined): string {
  return `${worktree.sha}|${worktree.branch ?? ''}|${base ?? ''}`;
}
