import { describe, expect, it } from 'vitest';
import type { LaunchpadGroup, PullRequest } from '@gitglasses/integrations';
import {
  SNOOZE_DURATION_MS,
  attentionCount,
  mergeGroups,
  partitionSnoozed,
  pruneSnoozes,
} from '../src/integrations/launchpadLogic';

function pr(id: string, updatedAt = '2026-07-01T00:00:00Z'): PullRequest {
  return {
    id,
    number: Number(id.replace(/\D/g, '') || 1),
    title: `PR ${id}`,
    url: `https://github.com/acme/widgets/pull/${id}`,
    state: 'open',
    draft: false,
    author: { id: 'alice', username: 'alice' },
    baseRef: 'main',
    headRef: `feature/${id}`,
    headSha: 'abc123',
    repo: { provider: 'github', host: 'github.com', owner: 'acme', name: 'widgets' },
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt,
    viewerRole: 'author',
    reviewRequestedFromViewer: false,
  };
}

describe('attentionCount', () => {
  it('counts blocked and needs-your-review items only', () => {
    const groups: LaunchpadGroup[] = [
      { bucket: 'blocked', items: [pr('1'), pr('2')] },
      { bucket: 'needs-your-review', items: [pr('3')] },
      { bucket: 'waiting', items: [pr('4'), pr('5')] },
      { bucket: 'draft', items: [pr('6')] },
    ];
    expect(attentionCount(groups)).toBe(3);
  });

  it('is zero for empty group lists', () => {
    expect(attentionCount([])).toBe(0);
  });
});

describe('snoozes', () => {
  const now = 1_000_000;

  it('partitions actively snoozed items out and keeps expired ones visible', () => {
    const items = [pr('a'), pr('b'), pr('c')];
    const snoozes = { a: now + 5000, b: now - 1 };
    const { active, snoozed } = partitionSnoozed(items, snoozes, now);
    expect(active.map((item) => item.id)).toEqual(['b', 'c']);
    expect(snoozed.map((item) => item.id)).toEqual(['a']);
  });

  it('prunes only expired entries', () => {
    const snoozes = { fresh: now + SNOOZE_DURATION_MS, stale: now, older: now - 10 };
    expect(pruneSnoozes(snoozes, now)).toEqual({ fresh: now + SNOOZE_DURATION_MS });
  });

  it('returns the same object when nothing expired', () => {
    const snoozes = { a: now + 1 };
    expect(pruneSnoozes(snoozes, now)).toBe(snoozes);
  });
});

describe('mergeGroups', () => {
  it('merges per-provider groups in bucket order, newest first within a bucket', () => {
    const merged = mergeGroups([
      [
        { bucket: 'waiting', items: [pr('w1', '2026-07-01T00:00:00Z')] },
        { bucket: 'blocked', items: [pr('b1', '2026-07-02T00:00:00Z')] },
      ],
      [{ bucket: 'blocked', items: [pr('b2', '2026-07-03T00:00:00Z')] }],
    ]);
    expect(merged.map((group) => group.bucket)).toEqual(['blocked', 'waiting']);
    expect(merged[0].items.map((item) => item.id)).toEqual(['b2', 'b1']);
  });

  it('omits empty buckets', () => {
    expect(mergeGroups([[{ bucket: 'draft', items: [] }], []])).toEqual([]);
  });
});
