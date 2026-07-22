// Pure launchpad state logic (no vscode imports): snooze bookkeeping, group
// merging across providers, and the status-bar attention count.

import {
  LAUNCHPAD_BUCKET_ORDER,
  type LaunchpadBucket,
  type LaunchpadGroup,
} from '@gitglasses/integrations';

/** PR id -> epoch ms when the snooze expires. */
export type SnoozeMap = Record<string, number>;

export const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

/** Drop expired snooze entries. Returns the same object when nothing changed. */
export function pruneSnoozes(snoozes: SnoozeMap, nowMs: number): SnoozeMap {
  const expired = Object.keys(snoozes).filter((id) => snoozes[id] <= nowMs);
  if (expired.length === 0) return snoozes;
  const pruned: SnoozeMap = { ...snoozes };
  for (const id of expired) delete pruned[id];
  return pruned;
}

/** Split items into visible and actively-snoozed (expired snoozes count as visible). */
export function partitionSnoozed<T extends { id: string }>(
  items: readonly T[],
  snoozes: SnoozeMap,
  nowMs: number,
): { active: T[]; snoozed: T[] } {
  const active: T[] = [];
  const snoozed: T[] = [];
  for (const item of items) {
    const until = snoozes[item.id];
    (until !== undefined && until > nowMs ? snoozed : active).push(item);
  }
  return { active, snoozed };
}

/** Merge per-provider group lists into one list ordered per LAUNCHPAD_BUCKET_ORDER. */
export function mergeGroups(perProvider: readonly (readonly LaunchpadGroup[])[]): LaunchpadGroup[] {
  const byBucket = new Map<LaunchpadBucket, LaunchpadGroup>();
  for (const groups of perProvider) {
    for (const group of groups) {
      const existing = byBucket.get(group.bucket);
      if (existing) {
        existing.items.push(...group.items);
      } else {
        byBucket.set(group.bucket, { bucket: group.bucket, items: [...group.items] });
      }
    }
  }
  const merged: LaunchpadGroup[] = [];
  for (const bucket of LAUNCHPAD_BUCKET_ORDER) {
    const group = byBucket.get(bucket);
    if (group && group.items.length > 0) {
      group.items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      merged.push(group);
    }
  }
  return merged;
}

/** PRs that need the user's attention: blocked + needs-your-review. */
export function attentionCount(groups: readonly LaunchpadGroup[]): number {
  let count = 0;
  for (const group of groups) {
    if (group.bucket === 'blocked' || group.bucket === 'needs-your-review') {
      count += group.items.length;
    }
  }
  return count;
}

export const BUCKET_LABELS: Record<LaunchpadBucket | 'snoozed', string> = {
  blocked: 'Blocked',
  'needs-your-review': 'Needs Your Review',
  'changes-requested': 'Changes Requested',
  mergeable: 'Ready to Merge',
  waiting: 'Waiting',
  draft: 'Drafts',
  snoozed: 'Snoozed',
};
