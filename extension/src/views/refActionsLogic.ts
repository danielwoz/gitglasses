// Pure decisions behind the Branches, Remotes, Tags and Stashes actions: which
// remote a push goes to, which files a comparison shows on which side, how a
// git failure reads in a notification, and the confirmation text. No vscode
// imports, so vitest covers it.

import type { Confirmation } from '../commands/confirmations';

/** What a Branches/Remotes/Tags/Stashes node stands for. */
export type RefPayload =
  | { kind: 'branch'; name: string; upstream?: string; current: boolean }
  | { kind: 'remote'; name: string; url?: string }
  | { kind: 'remoteBranch'; remote: string; name: string }
  | { kind: 'tag'; name: string }
  | { kind: 'stash'; index: number; message: string };

/** The revision a ref node names, as git accepts it. Tags are spelled out in
 *  full so a branch of the same name cannot shadow them. */
export function refRevision(ref: RefPayload): string | undefined {
  switch (ref.kind) {
    case 'branch':
      return ref.name;
    case 'remoteBranch':
      return `${ref.remote}/${ref.name}`;
    case 'tag':
      return `refs/tags/${ref.name}`;
    case 'stash':
      return `stash@{${ref.index}}`;
    case 'remote':
      return undefined;
  }
}

/** A short user-facing name for the ref. */
export function refLabel(ref: RefPayload): string {
  switch (ref.kind) {
    case 'branch':
    case 'tag':
    case 'remote':
      return ref.name;
    case 'remoteBranch':
      return `${ref.remote}/${ref.name}`;
    case 'stash':
      return `stash@{${ref.index}}`;
  }
}

/** A remote-tracking name split into its remote and branch, using the
 *  longest configured remote name that prefixes it (remote names may contain
 *  '/'). Undefined when no configured remote matches. */
export function splitRemoteBranch(
  tracking: string,
  remotes: readonly string[],
): { remote: string; branch: string } | undefined {
  let best: string | undefined;
  for (const remote of remotes) {
    if (tracking.startsWith(`${remote}/`) && (!best || remote.length > best.length)) best = remote;
  }
  if (!best) return undefined;
  return { remote: best, branch: tracking.slice(best.length + 1) };
}

/** How pushing a local branch proceeds. A branch with an upstream pushes to
 *  it; one without is published, to the only remote, or after the user picks
 *  one (the engine refuses to guess between several). */
export type PushPlan =
  | { kind: 'push' }
  | { kind: 'publish'; remote: string }
  | { kind: 'pickRemote'; remotes: string[]; preferred?: string }
  | { kind: 'noRemote' };

export function planPush(upstream: string | undefined, remotes: readonly string[]): PushPlan {
  if (upstream) return { kind: 'push' };
  if (remotes.length === 0) return { kind: 'noRemote' };
  if (remotes.length === 1) return { kind: 'publish', remote: remotes[0] };
  return {
    kind: 'pickRemote',
    remotes: [...remotes],
    preferred: remotes.includes('origin') ? 'origin' : undefined,
  };
}

/** `git branch -d` refused because the branch has commits no other branch
 *  holds: the case that warrants offering a forced delete. */
export function isNotFullyMerged(message: string): boolean {
  return /not fully merged/i.test(message);
}

/** A push the remote rejected because it would lose commits there. */
export function isPushRejected(message: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(message);
}

/** The engine's refusal to push a branch into the differently named branch
 *  it tracks (git's push.default=simple). */
export function isUpstreamNameMismatch(message: string): boolean {
  return /which has a different name/i.test(message);
}

/** The remote branch a push updates, as branch/push resolves it. */
export interface PushTarget {
  remote: string;
  branch: string;
}

/** The `git push` arguments that push `branch` to `target`. */
function pushArguments(branch: string, target: PushTarget): string {
  return `${target.remote} ${target.branch === branch ? branch : `${branch}:${target.branch}`}`;
}

/** The line of a git failure worth a notification: the first `error:` or
 *  `fatal:` line without its prefix, else the first non-hint line, with the
 *  engine's "git … failed (n):" lead-in removed. A line that ends in a colon
 *  takes the indented list git prints under it. The full text stays
 *  available behind "Show Details". */
export function summarizeGitError(message: string): string {
  const withoutLead = message.replace(/^git [^\n]*? failed(?: \(\d+\))?: /, '');
  const lines = withoutLead.split('\n').filter((line) => line.trim() !== '');
  const flagged = lines.findIndex((line) => /^(error|fatal):/i.test(line.trim()));
  const at =
    flagged >= 0
      ? flagged
      : Math.max(
          0,
          lines.findIndex((line) => !/^hint:/i.test(line.trim())),
        );
  let summary = (lines[at] ?? withoutLead).trim().replace(/^(error|fatal):\s*/i, '');
  if (summary.endsWith(':')) {
    const listed: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line)) break;
      listed.push(line.trim());
    }
    if (listed.length > 0) {
      const shown = listed.slice(0, 3).join(', ');
      summary = `${summary} ${shown}${listed.length > 3 ? `, and ${listed.length - 3} more` : ''}`;
    }
  }
  return summary;
}

/** True when the summary leaves out part of the message. */
export function hasMoreDetail(message: string): boolean {
  return message.trim() !== summarizeGitError(message);
}

/** One file of a comparison: the path it is labelled with and the revision
 *  path on each side (undefined where the file does not exist). */
export interface CompareEntry {
  path: string;
  left?: string;
  right?: string;
}

interface ChangedFile {
  path: string;
  status: string;
  origPath?: string;
}

/** Files a ref-to-ref diff lists, as sides of a two-way comparison. */
export function compareEntries(files: readonly ChangedFile[]): CompareEntry[] {
  return files.map((file) => {
    switch (file.status) {
      case 'A':
        return { path: file.path, right: file.path };
      case 'D':
        return { path: file.path, left: file.path };
      case 'R':
      case 'C':
        return { path: file.path, left: file.origPath ?? file.path, right: file.path };
      default:
        return { path: file.path, left: file.path, right: file.path };
    }
  });
}

/** The files that differ between a revision and the working tree: what
 *  differs between the revision and HEAD, plus whatever the working tree and
 *  index change on top of HEAD. A path deleted from the working tree has no
 *  right side. */
export function workingTreeCompareEntries(
  refToHead: readonly ChangedFile[],
  status: {
    staged: readonly ChangedFile[];
    unstaged: readonly ChangedFile[];
    untracked: readonly string[];
  },
): CompareEntry[] {
  const entries = new Map<string, CompareEntry>();
  for (const entry of compareEntries(refToHead)) entries.set(entry.path, entry);
  const deletedNow = new Set(
    [...status.staged, ...status.unstaged].filter((f) => f.status === 'D').map((f) => f.path),
  );
  const touched = [
    ...status.staged.map((f) => f.path),
    ...status.unstaged.map((f) => f.path),
    ...status.untracked,
  ];
  for (const path of touched) {
    if (!entries.has(path)) entries.set(path, { path, left: path, right: path });
  }
  for (const [path, entry] of entries) {
    entries.set(path, deletedNow.has(path) ? { path, left: entry.left } : entry);
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function confirmTagDelete(name: string): Confirmation {
  return {
    message: `Delete tag '${name}'?`,
    detail: `git tag -d ${name}\n\nThe tag stays on any remote it was pushed to.`,
  };
}

export function confirmRemoteTagDelete(name: string, remote: string): Confirmation {
  return {
    message: `Delete tag '${name}' from ${remote}?`,
    detail: `git push --delete ${remote} refs/tags/${name}\n\nEveryone fetching from ${remote} loses the tag; your local tag stays.`,
  };
}

export function confirmRemoteRemove(name: string): Confirmation {
  return {
    message: `Remove remote '${name}'?`,
    detail: `git remote remove ${name}\n\nDeletes its remote-tracking branches and any upstream settings that point at it.`,
  };
}

export function confirmForcePush(branch: string, target: PushTarget): Confirmation {
  const where = `${target.remote}/${target.branch}`;
  return {
    message: `Force push '${branch}' to ${where}?`,
    detail: `git push --force-with-lease ${pushArguments(branch, target)}\n\n${where} has commits that are not in '${branch}'. Force pushing replaces them, unless someone pushed there since you last fetched.`,
  };
}

/** Offered when `branch` tracks `upstream`, a branch of another name on
 *  `remote`, which git will not push to by default. */
export function confirmPublishUnderOwnName(
  branch: string,
  upstream: string,
  remote: string,
): Confirmation {
  return {
    message: `'${branch}' tracks ${upstream}, which has a different name.`,
    detail: `git push -u ${remote} ${branch}\n\nPushing does not update ${upstream}. Publish '${branch}' as ${remote}/${branch} instead; it then tracks ${remote}/${branch}.`,
  };
}

/** A revision offered as a rebase target. */
export interface RefTarget {
  /** What git is given. */
  value: string;
  kind: 'upstream' | 'branch' | 'remoteBranch' | 'tag';
  sha: string;
}

interface RefsListing {
  branches: readonly { name: string; sha: string; current: boolean; upstream?: string }[];
  remotes: readonly { name: string; branches: readonly { name: string; sha: string }[] }[];
  tags: readonly { name: string; sha: string }[];
}

/** Revisions to rebase the current branch onto: its upstream first (the
 *  usual choice), then the other local branches, remote branches and tags. */
export function rebaseTargets(refs: RefsListing): RefTarget[] {
  const current = refs.branches.find((branch) => branch.current);
  const remoteBranches = refs.remotes.flatMap((remote) =>
    remote.branches.map((branch) => ({ value: `${remote.name}/${branch.name}`, sha: branch.sha })),
  );
  const targets: RefTarget[] = [];
  const upstream = current?.upstream && remoteBranches.find((b) => b.value === current.upstream);
  if (upstream) targets.push({ ...upstream, kind: 'upstream' });
  for (const branch of refs.branches) {
    if (!branch.current) targets.push({ value: branch.name, kind: 'branch', sha: branch.sha });
  }
  for (const branch of remoteBranches) {
    if (branch.value !== current?.upstream) targets.push({ ...branch, kind: 'remoteBranch' });
  }
  for (const tag of refs.tags) targets.push({ value: tag.name, kind: 'tag', sha: tag.sha });
  return targets;
}
