import type { PullRequest } from './models.js';

export type LaunchpadBucket =
  | 'blocked'
  | 'needs-your-review'
  | 'changes-requested'
  | 'mergeable'
  | 'waiting'
  | 'draft';

/** Display order for launchpad groups. */
export const LAUNCHPAD_BUCKET_ORDER: readonly LaunchpadBucket[] = [
  'blocked',
  'needs-your-review',
  'changes-requested',
  'mergeable',
  'waiting',
  'draft',
];

/**
 * Assign a pull request to a launchpad bucket for `viewer` (a username).
 * Precedence: draft, then blocked (failing checks or merge conflicts), then
 * review requested from the viewer, then changes requested on the viewer's own
 * PR, then fully mergeable, else waiting.
 */
export function classify(pr: PullRequest, viewer: string): LaunchpadBucket {
  if (pr.draft) {
    return 'draft';
  }
  if (pr.checksStatus === 'failing' || pr.mergeable === 'conflicts') {
    return 'blocked';
  }
  if (pr.reviewRequestedFromViewer) {
    return 'needs-your-review';
  }
  if (pr.reviewDecision === 'changes_requested' && pr.author.username === viewer) {
    return 'changes-requested';
  }
  if (
    pr.reviewDecision === 'approved' &&
    pr.checksStatus === 'passing' &&
    pr.mergeable === 'mergeable'
  ) {
    return 'mergeable';
  }
  return 'waiting';
}

export interface LaunchpadGroup {
  bucket: LaunchpadBucket;
  items: PullRequest[];
}

/**
 * Group pull requests into launchpad buckets, ordered per
 * LAUNCHPAD_BUCKET_ORDER. Empty buckets are omitted; within a bucket items are
 * ordered most recently updated first.
 */
export function groupItems(prs: readonly PullRequest[], viewer: string): LaunchpadGroup[] {
  const byBucket = new Map<LaunchpadBucket, PullRequest[]>();
  for (const pr of prs) {
    const bucket = classify(pr, viewer);
    const items = byBucket.get(bucket);
    if (items) {
      items.push(pr);
    } else {
      byBucket.set(bucket, [pr]);
    }
  }
  const groups: LaunchpadGroup[] = [];
  for (const bucket of LAUNCHPAD_BUCKET_ORDER) {
    const items = byBucket.get(bucket);
    if (items && items.length > 0) {
      items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      groups.push({ bucket, items });
    }
  }
  return groups;
}
