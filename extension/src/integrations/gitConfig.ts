// Pure .git/config parsing (no vscode/fs imports). The engine's refs/list
// reports remote names without URLs; the integration service reads the repo's
// .git/config and this module extracts the remote URLs and branch tracking
// from it.

export interface RemoteConfig {
  name: string;
  /** Fetch URL (first `url =` in the section, matching git's behavior). */
  url?: string;
  /** Push URL override, when configured. */
  pushUrl?: string;
}

/** Tracking configuration of one local branch. */
export interface BranchConfig {
  /** Remote the branch pulls from (`branch.<name>.remote`). */
  remote?: string;
  /** Remote the branch pushes to (`branch.<name>.pushRemote`). */
  pushRemote?: string;
  /** Upstream ref (`branch.<name>.merge`), e.g. "refs/heads/main". */
  merge?: string;
}

/** The parts of a git config file pull request lookups read. */
export interface GitConfigSummary {
  remotes: RemoteConfig[];
  branches: Map<string, BranchConfig>;
  /** `remote.pushDefault`, when set. */
  pushDefault?: string;
}

const SECTION = /^\s*\[remote\s+"((?:[^"\\]|\\.)*)"\]\s*$/;
const BRANCH_SECTION = /^\s*\[branch\s+"((?:[^"\\]|\\.)*)"\]\s*$/;
const PLAIN_REMOTE_SECTION = /^\s*\[remote\]\s*$/i;
const OTHER_SECTION = /^\s*\[/;
const KEY_VALUE = /^\s*(url|pushurl)\s*=\s*(.*?)\s*$/i;
const BRANCH_KEY_VALUE = /^\s*(remote|pushremote|merge)\s*=\s*(.*?)\s*$/i;
const PUSH_DEFAULT = /^\s*pushdefault\s*=\s*(.*?)\s*$/i;

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
 * Parse remotes, branch tracking and `remote.pushDefault` out of a git config
 * file's text.
 */
export function parseGitConfig(text: string): GitConfigSummary {
  const branches = new Map<string, BranchConfig>();
  let pushDefault: string | undefined;
  let branch: BranchConfig | undefined;
  let inRemoteDefaults = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.startsWith('#') || line.startsWith(';')) continue;

    const section = BRANCH_SECTION.exec(rawLine);
    if (section) {
      const name = section[1].replace(/\\(.)/g, '$1');
      branch = branches.get(name) ?? {};
      branches.set(name, branch);
      inRemoteDefaults = false;
      continue;
    }
    if (OTHER_SECTION.test(rawLine)) {
      branch = undefined;
      inRemoteDefaults = PLAIN_REMOTE_SECTION.test(rawLine);
      continue;
    }
    if (inRemoteDefaults) {
      const push = PUSH_DEFAULT.exec(rawLine);
      if (push && push[1] !== '') pushDefault = unquote(push[1]);
      continue;
    }
    if (!branch) continue;
    const kv = BRANCH_KEY_VALUE.exec(rawLine);
    if (!kv || kv[2] === '') continue;
    const value = unquote(kv[2]);
    const key = kv[1].toLowerCase();
    if (key === 'remote') branch.remote = value;
    else if (key === 'pushremote') branch.pushRemote = value;
    else branch.merge = value;
  }
  const summary: GitConfigSummary = { remotes: parseGitConfigRemotes(text), branches };
  if (pushDefault !== undefined) summary.pushDefault = pushDefault;
  return summary;
}

/** Where to look for a branch's pull request. */
export interface PullRequestRemotes {
  /** Remote holding the branch the pull request was opened from. */
  headRemote: RemoteConfig;
  /** Branch name on the head remote. */
  headBranch: string;
  /**
   * Remotes whose repository the pull request may target, most likely
   * first: `upstream` (the usual name for the repository a fork came from),
   * then the branch's upstream remote, then the head remote itself.
   */
  baseRemotes: RemoteConfig[];
}

/**
 * The head and candidate base remotes for `branch`'s pull request. The head
 * is the remote the branch pushes to, following git's own precedence
 * (branch.<name>.pushRemote, remote.pushDefault, branch.<name>.remote), and
 * origin when nothing is configured.
 */
export function pullRequestRemotes(
  config: GitConfigSummary,
  branch: string,
): PullRequestRemotes | undefined {
  const byName = new Map(config.remotes.map((remote) => [remote.name, remote]));
  const tracking = config.branches.get(branch) ?? {};
  const headName =
    [tracking.pushRemote, config.pushDefault, tracking.remote, 'origin'].find(
      (name) => name !== undefined && byName.has(name),
    ) ?? config.remotes[0]?.name;
  const headRemote = headName === undefined ? undefined : byName.get(headName);
  if (!headRemote) return undefined;

  // The upstream ref names the remote branch only when the branch pushes to
  // the remote it tracks; a triangular setup pushes under the local name.
  const merged = tracking.merge?.replace(/^refs\/heads\//, '');
  const headBranch =
    tracking.remote === headRemote.name && merged !== undefined && merged !== ''
      ? merged
      : branch;

  const baseRemotes: RemoteConfig[] = [];
  for (const name of ['upstream', tracking.remote, headRemote.name]) {
    const remote = name === undefined ? undefined : byName.get(name);
    if (remote && !baseRemotes.includes(remote)) baseRemotes.push(remote);
  }
  return { headRemote, headBranch, baseRemotes };
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
