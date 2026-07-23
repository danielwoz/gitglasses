// Pure .git/config parsing (no vscode/fs imports). The engine's refs/list
// reports remote names without URLs; the integration service reads the repo's
// .git/config and this module extracts the remote URLs from it.

export interface RemoteConfig {
  name: string;
  /** Fetch URL (first `url =` in the section, matching git's behavior). */
  url?: string;
  /** Push URL override, when configured. */
  pushUrl?: string;
}

const SECTION = /^\s*\[remote\s+"((?:[^"\\]|\\.)*)"\]\s*$/;
const OTHER_SECTION = /^\s*\[/;
const KEY_VALUE = /^\s*(url|pushurl)\s*=\s*(.*?)\s*$/i;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

/** Parse remote sections out of a git config file's text. */
export function parseGitConfigRemotes(text: string): RemoteConfig[] {
  const remotes: RemoteConfig[] = [];
  const byName = new Map<string, RemoteConfig>();
  let current: RemoteConfig | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.startsWith('#') || line.startsWith(';')) continue;

    const section = SECTION.exec(rawLine);
    if (section) {
      const name = section[1].replace(/\\(.)/g, '$1');
      current = byName.get(name);
      if (!current) {
        current = { name };
        byName.set(name, current);
        remotes.push(current);
      }
      continue;
    }
    if (OTHER_SECTION.test(rawLine)) {
      current = undefined;
      continue;
    }
    if (!current) continue;

    const kv = KEY_VALUE.exec(rawLine);
    if (!kv) continue;
    const value = unquote(kv[2]);
    if (value === '') continue;
    if (kv[1].toLowerCase() === 'url') {
      // Git uses the first url of a section for fetching; keep that one.
      current.url ??= value;
    } else {
      current.pushUrl ??= value;
    }
  }
  return remotes;
}

/**
 * Remote URLs in resolution-preference order: origin first, then upstream,
 * then the rest in file order. Fetch URL preferred over pushurl.
 */
export function orderedRemoteUrls(remotes: readonly RemoteConfig[]): string[] {
  const rank = (remote: RemoteConfig): number =>
    remote.name === 'origin' ? 0 : remote.name === 'upstream' ? 1 : 2;
  return [...remotes]
    .sort((a, b) => rank(a) - rank(b))
    .map((remote) => remote.url ?? remote.pushUrl)
    .filter((url): url is string => typeof url === 'string' && url !== '');
}
