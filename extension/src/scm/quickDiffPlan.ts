// Pure bookkeeping for the per-repository quick diff sources (no vscode
// imports): which source controls to add and which to dispose when the
// workspace's repositories change.

export interface QuickDiffPlan<T> {
  add: T[];
  remove: string[];
}

/**
 * Compares the roots that have a source control (`existing`, by key) with
 * the repositories that should have one. Each repository is keyed by `key`,
 * so two spellings of one root map to one source control.
 */
export function planQuickDiffSources<T>(
  existing: Iterable<string>,
  wanted: readonly T[],
  key: (item: T) => string,
): QuickDiffPlan<T> {
  const have = new Set(existing);
  const want = new Map<string, T>();
  for (const item of wanted) {
    const itemKey = key(item);
    if (!want.has(itemKey)) want.set(itemKey, item);
  }
  return {
    add: [...want].filter(([itemKey]) => !have.has(itemKey)).map(([, item]) => item),
    remove: [...have].filter((itemKey) => !want.has(itemKey)),
  };
}
