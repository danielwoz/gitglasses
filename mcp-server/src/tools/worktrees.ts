// git_worktrees: every worktree of a repository with its status, so an agent
// orchestrating others (each in its own worktree) can see which finished,
// what each holds, and whether it would merge cleanly.

import type { MergeSkipReason, WorktreeEntry, WorktreeStatus } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';

/** Worktrees whose status one call computes; the rest are listed bare. */
export const MAX_WORKTREE_STATUSES = 50;

/** Status requests in flight at once: each scans a working tree. */
const STATUS_CONCURRENCY = 4;

/** Conflicted paths named per worktree. */
const MAX_CONFLICTS_SHOWN = 20;

/** One listed worktree with what worktree/status said about it. */
export interface WorktreeReport {
  entry: WorktreeEntry;
  status?: WorktreeStatus;
  /** Why the status could not be read. */
  error?: string;
  /** The worktree lies outside the directories the server may read. */
  outside?: boolean;
}

/** Whether a listed worktree has a checkout to read a status from: not a
 *  bare repository, and its directory is there and still a worktree. */
function hasCheckout(entry: WorktreeEntry): boolean {
  return !entry.bare && !entry.prunable && !entry.missing;
}

/** Lists the worktrees and reads the status of the first
 *  MAX_WORKTREE_STATUSES, a few at a time. A status that fails is reported
 *  on its worktree rather than failing the call. Worktrees `mayRead` refuses
 *  (directories outside those the server serves) are listed unread. */
export async function collectWorktrees(
  repo: { client: EngineClient; repoId: string },
  base: string | undefined,
  mayRead: (worktreePath: string) => Promise<boolean> = async () => true,
): Promise<WorktreeReport[]> {
  const { worktrees } = await repo.client.request('worktree/list', { repoId: repo.repoId });
  const reports: WorktreeReport[] = worktrees.map((entry) => ({ entry }));
  const candidates = reports
    .slice(0, MAX_WORKTREE_STATUSES)
    .filter((report) => hasCheckout(report.entry));
  const pending: WorktreeReport[] = [];
  for (const report of candidates) {
    if (await mayRead(report.entry.path)) pending.push(report);
    else report.outside = true;
  }
  const worker = async (): Promise<void> => {
    for (let report = pending.shift(); report; report = pending.shift()) {
      try {
        report.status = await repo.client.request('worktree/status', {
          repoId: repo.repoId,
          path: report.entry.path,
          base,
        });
      } catch (error) {
        // An explicit base that names nothing is the caller's mistake, the
        // same for every worktree: fail the call with it.
        if (base !== undefined && isInvalidParams(error)) throw error;
        report.error = error instanceof Error ? error.message : String(error);
      }
    }
  };
  await Promise.all(Array.from({ length: STATUS_CONCURRENCY }, worker));
  return reports;
}

function isInvalidParams(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === -32602;
}

const MERGE_SKIPPED: Record<MergeSkipReason, string> = {
  restricted:
    'not checked: this repository is served without running git (outside the --allow directories)',
  noGitCli: 'not checked: the engine has no git CLI',
  gitVersion: 'not checked: needs git 2.38 or later',
  partialClone: 'not checked: a partial clone needs git 2.45 or later',
  failed: 'could not be checked',
};

const EVIDENCE: Record<NonNullable<WorktreeStatus['agent']>['evidence'], string> = {
  path: 'worktree location',
  branch: 'branch name',
  trailer: 'commit trailer',
};

function isoTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The merge verdict for a worktree compared with its base. */
function mergeLine(base: NonNullable<WorktreeStatus['base']>): string {
  if (base.ahead === 0) return 'nothing to merge';
  if (base.mergesCleanly === true) return 'merges cleanly';
  if (base.mergesCleanly === false) {
    const conflicts = base.conflicts ?? [];
    if (conflicts.length === 0) return 'conflicts';
    const shown = conflicts.slice(0, MAX_CONFLICTS_SHOWN).join(', ');
    const more =
      conflicts.length > MAX_CONFLICTS_SHOWN
        ? ` and ${conflicts.length - MAX_CONFLICTS_SHOWN} more`
        : '';
    return `conflicts in ${shown}${more}`;
  }
  return MERGE_SKIPPED[base.mergeSkipped ?? 'failed'];
}

/** What a worktree without a checkout lacks, and what `git worktree prune`
 *  makes of it: git drops the entry unless it is locked. */
function missingFlag(entry: WorktreeEntry): string | undefined {
  if (entry.prunable) {
    return entry.missing
      ? 'directory missing (git worktree prune would remove it)'
      : 'no longer a worktree: its .git file is gone (git worktree prune would remove it)';
  }
  if (entry.missing) return 'directory missing (locked, so git worktree prune keeps it)';
  return undefined;
}

/** One block per worktree: path, then indented facts. Agent names come from
 *  repository content (trailers), so they are quoted. */
function formatReport(report: WorktreeReport, statusRead: boolean): string[] {
  const { entry, status } = report;
  const lines = [entry.path];
  const facts: string[] = [];
  if (entry.bare) facts.push('bare repository');
  else if (entry.branch) facts.push(`branch: ${entry.branch} at ${entry.sha.slice(0, 7)}`);
  else facts.push(`detached HEAD at ${entry.sha.slice(0, 7)}`);
  const flags = [
    entry.current ? 'the repository this call named' : undefined,
    entry.locked ? 'locked' : undefined,
    missingFlag(entry),
  ].filter((flag): flag is string => flag !== undefined);
  if (flags.length > 0) facts.push(flags.join('; '));
  if (status?.agent) {
    facts.push(
      `agent: ${JSON.stringify(status.agent.name)} (from its ${EVIDENCE[status.agent.evidence]})`,
    );
  }
  if (status?.dirty !== undefined) facts.push(`uncommitted paths: ${status.dirty}`);
  if (status?.base) {
    const base = status.base;
    if (entry.branch === base.ref) {
      facts.push(`is the base (${base.ref})`);
    } else {
      facts.push(`vs ${base.ref}: ${base.ahead} ahead, ${base.behind} behind; ${mergeLine(base)}`);
    }
  }
  if (status?.upstream) {
    const { ref, ahead, behind } = status.upstream;
    facts.push(`upstream ${ref}: ${ahead} ahead, ${behind} behind`);
  }
  if (status?.lastActivity !== undefined) {
    facts.push(`last activity: ${isoTime(status.lastActivity)}`);
  }
  if (report.error) facts.push(`status unavailable: ${report.error}`);
  else if (report.outside) {
    facts.push('status not read: outside the directories this server serves (see --allow)');
  } else if (!status && hasCheckout(entry) && !statusRead) {
    facts.push('status not read (only the first worktrees are)');
  }
  return [...lines, ...facts.map((fact) => `  ${fact}`)];
}

/** Text for git_worktrees. */
export function formatWorktrees(reports: readonly WorktreeReport[]): string {
  if (reports.length === 0) return 'No worktrees.';
  const base = reports.find((report) => report.status?.base)?.status?.base?.ref;
  const header =
    `${reports.length} worktree${reports.length === 1 ? '' : 's'}` +
    (base ? `, compared with ${base}` : '') +
    ':';
  const blocks = reports.map((report, index) =>
    formatReport(report, index < MAX_WORKTREE_STATUSES).join('\n'),
  );
  const footer =
    reports.length > MAX_WORKTREE_STATUSES
      ? [`(status read for the first ${MAX_WORKTREE_STATUSES} worktrees only)`]
      : [];
  return [header, ...blocks, ...footer].join('\n');
}
