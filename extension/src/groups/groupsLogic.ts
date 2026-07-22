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

// --- Export / import (.ggworkspace) -----------------------------------------

/** One repo entry in a shared group file: a portable remote URL when the repo
 *  has one, else the machine-local path. */
export interface ExportedRepo {
  remoteUrl?: string;
  path?: string;
}

export interface GroupExportFile {
  format: 'gitglasses-group';
  version: 1;
  name: string;
  repos: ExportedRepo[];
}

/** Serialize a group for sharing: remote URLs travel, paths are a fallback. */
export function serializeGroupExport(name: string, repos: readonly ExportedRepo[]): string {
  const file: GroupExportFile = {
    format: 'gitglasses-group',
    version: 1,
    name,
    repos: repos.map((repo) => (repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : { path: repo.path })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type GroupImportResult =
  | { ok: true; name: string; repos: ExportedRepo[] }
  | { ok: false; error: string };

/** Parse and validate a .ggworkspace file, returning friendly errors. */
export function parseGroupExport(text: string): GroupImportResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the file is not valid JSON (expected a .ggworkspace file)' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, error: 'the JSON is not a repo-group object' };
  }
  const obj = json as Record<string, unknown>;
  if (obj.format !== 'gitglasses-group') {
    return { ok: false, error: 'not a GitGlasses repo group — missing "format": "gitglasses-group"' };
  }
  if (obj.version !== 1) {
    return {
      ok: false,
      error: `unsupported group version ${JSON.stringify(obj.version)} — this build understands version 1`,
    };
  }
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    return { ok: false, error: 'the group has no name' };
  }
  if (!Array.isArray(obj.repos)) {
    return { ok: false, error: 'the group has no repos array' };
  }
  const repos: ExportedRepo[] = [];
  for (const entry of obj.repos) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { remoteUrl, path } = entry as Record<string, unknown>;
    if (typeof remoteUrl === 'string' && remoteUrl.trim() !== '') {
      repos.push({ remoteUrl: remoteUrl.trim() });
    } else if (typeof path === 'string' && path.trim() !== '') {
      repos.push({ path });
    }
  }
  if (repos.length === 0) {
    return { ok: false, error: 'the group lists no usable repos (each needs a remoteUrl or path)' };
  }
  return { ok: true, name: obj.name.trim(), repos };
}

/** A group name that does not collide with existing ones: "name (2)", "name (3)", … */
export function uniqueGroupName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The directory name `git clone <url>` creates, for predicting clone targets. */
export function repoDirNameFromUrl(url: string): string {
  const cleaned = url
    .trim()
    .replace(/[/\s]+$/, '')
    .replace(/\.git$/i, '');
  const lastSegment = cleaned.split(/[/:\\]/).filter((segment) => segment !== '').pop() ?? '';
  return lastSegment || 'repository';
}

/** Suggested save-dialog file name for an exported group. */
export function groupExportFileName(name: string): string {
  const safe =
    name
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'group';
  return `${safe}.ggworkspace`;
}
