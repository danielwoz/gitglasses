// Pure PR-chip formatting (no vscode imports) for branch-node decorations.

import type { ChecksStatus } from '@gitglasses/integrations';

const MARKS: Record<ChecksStatus, string> = {
  passing: '✓',
  failing: '✗',
  pending: '○',
  none: '○',
};

/** Description suffix for a branch that has an open PR, e.g. "PR #42 ✓". */
export function prChipSuffix(pr: { number: number; checksStatus?: ChecksStatus }): string {
  return `PR #${pr.number} ${MARKS[pr.checksStatus ?? 'none']}`;
}
