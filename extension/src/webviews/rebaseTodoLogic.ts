// Reading and writing the todo list git hands its sequence editor during
// `git rebase -i` (rebase-merge/git-rebase-todo), so the rebase editor can
// stand in for a text editor there. No vscode imports, so vitest covers it.

import type { PlanAction } from '../../webviews-src/rebase/rebaseLogic';

/** A todo line that names a commit, with the update-ref lines after it. */
export interface TodoCommit {
  action: PlanAction;
  sha: string;
  /** Whatever git wrote after the sha: the subject, by default. */
  summary: string;
  refs: string[];
}

export interface ParsedTodo {
  commits: TodoCommit[];
  /** update-ref lines ahead of every commit. */
  leadingRefs: string[];
  /** Lines this editor cannot show (exec, break, label, merge…). */
  unsupported: string[];
  /** "abc123..def456 onto 789abc", from git's comment, when present. */
  range?: string;
}

const ABBREVIATIONS: Readonly<Record<string, string>> = {
  p: 'pick',
  r: 'reword',
  e: 'edit',
  s: 'squash',
  f: 'fixup',
  d: 'drop',
  x: 'exec',
  b: 'break',
  l: 'label',
  t: 'reset',
  m: 'merge',
  u: 'update-ref',
};

const COMMIT_ACTIONS: ReadonlySet<string> = new Set([
  'pick',
  'reword',
  'edit',
  'squash',
  'fixup',
  'drop',
]);

export function parseTodo(text: string): ParsedTodo {
  const parsed: ParsedTodo = { commits: [], leadingRefs: [], unsupported: [] };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '') continue;
    // Comment lines start with core.commentChar, which is never a letter.
    if (!/^[a-z]/i.test(line)) {
      const range = /Rebase (\S+) onto (\S+)/.exec(line);
      if (range && !parsed.range) parsed.range = `${range[1]} onto ${range[2]}`;
      continue;
    }
    const [word, ...rest] = line.split(/\s+/);
    const command = ABBREVIATIONS[word] ?? word;
    if (command === 'noop') continue;
    if (command === 'update-ref' && rest[0]) {
      const last = parsed.commits[parsed.commits.length - 1];
      (last ? last.refs : parsed.leadingRefs).push(rest[0]);
      continue;
    }
    // `fixup -C` / `fixup -c` reuse a message in ways a plan cannot show.
    if (COMMIT_ACTIONS.has(command) && rest[0] && !rest[0].startsWith('-')) {
      const [sha, ...summary] = rest;
      parsed.commits.push({
        action: command as PlanAction,
        sha,
        summary: summary.join(' '),
        refs: [],
      });
      continue;
    }
    parsed.unsupported.push(line);
  }
  return parsed;
}

/** The todo for `plan` (commits of `parsed`, reordered and re-actioned).
 *  update-ref lines follow their commit, as the engine's sequence editor
 *  writes them: past a squash/fixup folded into it, and onto the commit
 *  before it when it is dropped. Drops are written out so git's
 *  missing-commit check never mistakes them for accidents. */
export function serializeTodo(
  plan: readonly { sha: string; action: PlanAction }[],
  parsed: ParsedTodo,
): string {
  const bySha = new Map(parsed.commits.map((commit) => [commit.sha, commit]));
  const lines: string[] = [];
  const drops: string[] = [];
  let pendingRefs = [...parsed.leadingRefs];
  const flushRefs = (): void => {
    for (const ref of pendingRefs) lines.push(`update-ref ${ref}`);
    pendingRefs = [];
  };
  for (const entry of plan) {
    const commit = bySha.get(entry.sha);
    if (!commit) continue;
    const line = `${entry.action} ${commit.sha}${commit.summary ? ` ${commit.summary}` : ''}`;
    if (entry.action === 'drop') {
      drops.push(line);
    } else {
      if (entry.action !== 'squash' && entry.action !== 'fixup') flushRefs();
      lines.push(line);
    }
    pendingRefs.push(...commit.refs);
  }
  flushRefs();
  return [...lines, ...drops].map((line) => `${line}\n`).join('');
}

/** The workbench.editorAssociations key for git's todo file. */
export const TODO_ASSOCIATION = 'git-rebase-todo';

/** The user's editor associations with the rebase editor added (enabled) or
 *  its own entry removed (disabled); undefined when nothing has to change.
 *  An association to another editor is replaced only when enabling, which
 *  the user asked for. */
export function editorAssociationsFor(
  current: Readonly<Record<string, string>> | undefined,
  enabled: boolean,
  viewType: string,
): Record<string, string> | undefined {
  const associations = { ...(current ?? {}) };
  const ours = associations[TODO_ASSOCIATION] === viewType;
  if (enabled === ours) return undefined;
  if (enabled) {
    associations[TODO_ASSOCIATION] = viewType;
  } else {
    delete associations[TODO_ASSOCIATION];
  }
  return associations;
}
