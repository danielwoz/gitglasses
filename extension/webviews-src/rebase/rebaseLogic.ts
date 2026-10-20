// Pure rebase-plan state: the editor UI dispatches into these functions and
// re-renders from the returned plan. No DOM access so vitest covers it.

import type { RebaseEntry } from '@gitglasses/protocol';

export type PlanAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export const PLAN_ACTIONS: readonly PlanAction[] = [
  'pick',
  'reword',
  'edit',
  'squash',
  'fixup',
  'drop',
];

/** What each action does, for the action picker's tooltips. */
export const ACTION_DESCRIPTIONS: Readonly<Record<PlanAction, string>> = {
  pick: 'Keep the commit as it is',
  reword: 'Keep the commit with a new message',
  edit: 'Stop after this commit so you can amend it or add commits',
  squash: 'Fold into the commit above, combining the messages',
  fixup: "Fold into the commit above, keeping that commit's message",
  drop: 'Remove the commit',
};

/** Single-key shortcuts for the action of the focused row, as in git's todo. */
const ACTION_KEYS: Readonly<Record<string, PlanAction>> = {
  p: 'pick',
  r: 'reword',
  e: 'edit',
  s: 'squash',
  f: 'fixup',
  d: 'drop',
};

export function actionForKey(key: string): PlanAction | undefined {
  return ACTION_KEYS[key.toLowerCase()];
}

export interface PlanEntry {
  sha: string;
  summary: string;
  action: PlanAction;
  /** Replacement message; only sent for reword/squash. */
  message: string;
}

/** Initial plan from rebase/preview entries (oldest first): everything
 *  picked, unless an entry says otherwise (a todo git already prepared). */
export function planFromPreview(
  entries: readonly { sha: string; summary: string; action?: PlanAction }[],
): PlanEntry[] {
  return entries.map((entry) => ({
    sha: entry.sha,
    summary: entry.summary,
    action: entry.action ?? 'pick',
    message: '',
  }));
}

/** A fresh preview applied to a plan being edited: commits still on the
 *  branch keep their place, action and message; commits gone from it leave
 *  the plan; new ones are appended, picked, in the preview's order. */
export function mergePlan(
  plan: readonly PlanEntry[],
  entries: readonly { sha: string; summary: string }[],
): PlanEntry[] {
  const fresh = new Map(entries.map((entry) => [entry.sha, entry]));
  const kept = plan
    .filter((entry) => fresh.has(entry.sha))
    .map((entry) => ({ ...entry, summary: fresh.get(entry.sha)?.summary ?? entry.summary }));
  const known = new Set(kept.map((entry) => entry.sha));
  const added = planFromPreview(entries.filter((entry) => !known.has(entry.sha)));
  return [...kept, ...added];
}

/** Moves the entry at `index` so it ends up at position `to` (clamped). */
export function move(plan: readonly PlanEntry[], index: number, to: number): PlanEntry[] {
  const result = [...plan];
  if (index < 0 || index >= plan.length) return result;
  const target = Math.max(0, Math.min(plan.length - 1, to));
  const [entry] = result.splice(index, 1);
  result.splice(target, 0, entry);
  return result;
}

export function setAction(
  plan: readonly PlanEntry[],
  index: number,
  action: PlanAction,
): PlanEntry[] {
  return plan.map((entry, i) => (i === index ? { ...entry, action } : entry));
}

export function setMessage(
  plan: readonly PlanEntry[],
  index: number,
  message: string,
): PlanEntry[] {
  return plan.map((entry, i) => (i === index ? { ...entry, message } : entry));
}

/** Human-readable problems; an empty array means the plan can start.
 *  `messages: false` is for a todo handed back to git, which asks for
 *  reword messages itself. */
export function validate(
  plan: readonly PlanEntry[],
  { messages = true }: { messages?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const kept = plan.filter((entry) => entry.action !== 'drop');
  if (kept.length === 0) {
    errors.push('At least one commit must not be dropped.');
    return errors;
  }
  const first = kept[0];
  if (first.action === 'squash' || first.action === 'fixup') {
    errors.push(
      `The first kept commit cannot be '${first.action}'; it has no earlier commit to combine into.`,
    );
  }
  const unworded = plan.filter((entry) => entry.action === 'reword' && entry.message.trim() === '');
  if (messages && unworded.length > 0) {
    errors.push(
      `Enter the new message for ${unworded.map((entry) => entry.sha.slice(0, 7)).join(', ')}, or pick instead of reword.`,
    );
  }
  return errors;
}

/** The engine refused the plan because the branch, the upstream or the
 *  commits to replay changed since it was made; reloading it is the fix. */
export function isStalePlanRefusal(message: string): boolean {
  return /reload the plan/i.test(message);
}

/** Wire-format plan; messages attach only where the action consumes them. */
export function toRebaseEntries(plan: readonly PlanEntry[]): RebaseEntry[] {
  return plan.map((entry) => {
    const wire: RebaseEntry = { action: entry.action, sha: entry.sha, summary: entry.summary };
    if ((entry.action === 'reword' || entry.action === 'squash') && entry.message.trim() !== '') {
      wire.message = entry.message;
    }
    return wire;
  });
}

const AUTOSQUASH_PREFIX = /^(fixup|squash)! /;

/** The commit a `fixup! …` / `squash! …` subject names, matched the way
 *  `git rebase --autosquash` does: an earlier commit with that subject, else
 *  one whose sha starts with it, else one whose subject starts with it. */
function autosquashTarget(
  subject: string,
  earlier: readonly PlanEntry[],
): PlanEntry | undefined {
  let rest = subject;
  while (AUTOSQUASH_PREFIX.test(rest)) rest = rest.replace(AUTOSQUASH_PREFIX, '');
  return (
    earlier.find((entry) => entry.summary === rest) ??
    (/^[0-9a-f]{4,40}$/.test(rest) ? earlier.find((entry) => entry.sha.startsWith(rest)) : undefined) ??
    earlier.find((entry) => entry.summary.startsWith(rest))
  );
}

/** True when autosquash would change the plan: some commit's subject asks to
 *  be folded into an earlier one that it is not folded into yet. */
export function hasAutosquashCandidates(plan: readonly PlanEntry[]): boolean {
  const squashed = autosquash(plan);
  return squashed.some(
    (entry, index) => entry.sha !== plan[index].sha || entry.action !== plan[index].action,
  );
}

/** Moves every `fixup! X` / `squash! X` commit right after the commit it
 *  names (after earlier ones already folded there) with the matching action,
 *  like `git rebase --autosquash`. Commits whose target is not in the plan
 *  stay where they are. */
export function autosquash(plan: readonly PlanEntry[]): PlanEntry[] {
  const folds = new Map<string, PlanEntry[]>();
  const rest: PlanEntry[] = [];
  plan.forEach((entry, index) => {
    const match = AUTOSQUASH_PREFIX.exec(entry.summary);
    const target = match && autosquashTarget(entry.summary, plan.slice(0, index));
    if (!match || !target) {
      rest.push(entry);
      return;
    }
    // A fold of a fold joins the chain of the commit the chain folds into.
    let root = target;
    for (const [rootSha, chain] of folds) {
      if (chain.some((folded) => folded.sha === target.sha)) {
        root = plan.find((candidate) => candidate.sha === rootSha) ?? target;
      }
    }
    const action: PlanAction = match[1] === 'squash' ? 'squash' : 'fixup';
    folds.set(root.sha, [...(folds.get(root.sha) ?? []), { ...entry, action }]);
  });
  return rest.flatMap((entry) => [entry, ...(folds.get(entry.sha) ?? [])]);
}
