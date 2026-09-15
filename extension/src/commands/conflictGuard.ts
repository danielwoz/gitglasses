// Gate in front of the mutating flows: a repository with unresolved conflicts
// makes most git operations fail, so the user is told what is in the way and
// confirms before the mutation is attempted.

import type { EngineClient } from '@gitglasses/rpc';
import { confirmWithConflicts } from '../model/conflictLogic';
import { confirmDestructive } from './ui';

/** True when `operation` may proceed: no conflicts, or the user confirmed. */
export async function allowedDespiteConflicts(
  engine: EngineClient,
  repoId: string,
  operation: string,
): Promise<boolean> {
  let conflicted: readonly string[];
  try {
    ({ conflicted } = await engine.request('status/summary', { repoId }));
  } catch {
    // Unknown state: let the operation run and report its own failure.
    return true;
  }
  if (conflicted.length === 0) return true;
  return confirmDestructive(confirmWithConflicts(operation, conflicted));
}
