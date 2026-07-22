// Pure repo-group logic (no vscode imports): storage (de)serialization and
// .code-workspace file generation.

export interface RepoGroup {
  id: string;
  name: string;
  repos: { path: string }[];
}

/** Parses persisted globalState data, dropping anything malformed. */
export function parseRepoGroups(raw: unknown): RepoGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: RepoGroup[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, name, repos } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(repos)) continue;
    const paths: { path: string }[] = [];
    for (const repo of repos) {
      const path = (repo as { path?: unknown } | null)?.path;
      if (typeof path === 'string') paths.push({ path });
    }
    groups.push({ id, name, repos: paths });
  }
  return groups;
}

/** JSON-safe deep copy suitable for globalState.update. */
export function serializeRepoGroups(groups: readonly RepoGroup[]): RepoGroup[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    repos: group.repos.map((repo) => ({ path: repo.path })),
  }));
}

/** Multi-root .code-workspace document listing the group's repos. */
export function workspaceFileContents(group: RepoGroup): string {
  const folders = group.repos.map((repo) => ({ path: repo.path }));
  return JSON.stringify({ folders }, null, 2) + '\n';
}

/** Stable, filesystem-safe workspace file name for a group. */
export function workspaceFileName(group: RepoGroup): string {
  const safe =
    group.name
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'group';
  return `${safe}-${group.id}.code-workspace`;
}
