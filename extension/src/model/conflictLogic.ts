// Pure text for the unresolved-conflict surfaces (no vscode imports): the
// status bar label and tooltip, and the confirmation shown before a mutation
// runs on top of a conflicted working tree.

import type { Confirmation } from '../commands/confirmations';

const TOOLTIP_FILE_LIMIT = 10;

export function conflictLabel(count: number): string {
  return `${count} conflict${count === 1 ? '' : 's'}`;
}

/** Status bar tooltip: the count, then the conflicted paths, capped. */
export function conflictTooltip(files: readonly string[]): string {
  const lines = [`${conflictLabel(files.length)} to resolve:`];
  lines.push(...files.slice(0, TOOLTIP_FILE_LIMIT));
  if (files.length > TOOLTIP_FILE_LIMIT) {
    lines.push(`…and ${files.length - TOOLTIP_FILE_LIMIT} more`);
  }
  return lines.join('\n');
}

/** Confirmation for running `operation` while conflicts are unresolved. */
export function confirmWithConflicts(
  operation: string,
  files: readonly string[],
): Confirmation {
  return {
    message:
      `This repository has ${conflictLabel(files.length)} to resolve. ` +
      `Run ${operation} anyway?`,
    detail: [
      'Git refuses most operations while a merge, rebase or cherry-pick is unfinished.',
      '',
      conflictTooltip(files),
    ].join('\n'),
  };
}
