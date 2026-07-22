// Pure rebase-plan state: the editor UI dispatches into these functions and
// re-renders from the returned plan. No DOM access so vitest covers it.

import type { RebaseEntry } from '@gitglasses/protocol';

export type PlanAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export const PLAN_ACTIONS: readonly PlanAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop'];

export interface PlanEntry {
  sha: string;
  summary: string;
  action: PlanAction;
  /** Replacement message; only sent for reword/squash. */
  message: string;
}

export function sha7(sha: string): string {
  return sha.slice(0, 7);
}

/** Initial plan from rebase/preview entries (oldest first): everything picked. */
export function planFromPreview(
  entries: readonly { sha: string; summary: string }[],
): PlanEntry[] {
  return entries.map((entry) => ({
    sha: entry.sha,
    summary: entry.summary,
    action: 'pick' as const,
    message: '',
  }));
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

/** Human-readable problems; an empty array means the plan can start. */
export function validate(plan: readonly PlanEntry[]): string[] {
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
  return errors;
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
