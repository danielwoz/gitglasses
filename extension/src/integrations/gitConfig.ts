// Pure .git/config parsing (no vscode/fs imports). The engine's refs/list
// reports remote names without URLs; the integration service reads the repo's
// .git/config and this module extracts the remote URLs and branch tracking
// from it.

import { parseRemoteUrl } from '@gitglasses/integrations';

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
  /**
   * The pull request the GitHub Pull Requests extension checked this branch
   * out for (`branch.<name>.github-pr-owner-number`, "owner#repo#number"
   * naming the pull request's base repository).
   */
  pullRequest?: { owner: string; name: string; number: number };
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
const BRANCH_KEY_VALUE =
  /^\s*(remote|pushremote|merge|github-pr-owner-number)\s*=\s*(.*?)\s*$/i;
const PUSH_DEFAULT = /^\s*pushdefault\s*=\s*(.*?)\s*$/i;
const PR_METADATA = /^(.+)#([^#]+)#(\d+)$/;

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
    else if (key === 'merge') branch.merge = value;
    else {
      const metadata = PR_METADATA.exec(value);
      if (metadata) {
        const [, owner, name, number] = metadata;
        branch.pullRequest = { owner, name, number: Number(number) };
      }
    }
  }
  const summary: GitConfigSummary = { remotes: parseGitConfigRemotes(text), branches };
  if (pushDefault !== undefined) summary.pushDefault = pushDefault;
  return summary;
}

/** One repository a branch's pull request may target. */
export interface PullRequestLookup {
  /** Remote naming the repository the pull request targets. */
  base: RemoteConfig;
  /** The pull request's head branch name to ask that repository for. */
  branch: string;
}

/** Where to look for a branch's pull request. */
export interface PullRequestRemotes {
  /** Remote holding the branch the pull request was opened from. */
  headRemote: RemoteConfig;
  /**
   * Repositories the pull request may target, most likely first:
   * `upstream` (the usual name for the repository a fork came from), then
   * `origin`, then the branch's tracked and push remotes. Empty when
   * `trackedPullRequest` names the pull request.
   */
  lookups: PullRequestLookup[];
  /**
   * The pull request the branch was checked out for, when its config names
   * one: a branch tracking `refs/pull/<n>/head` (how `gh pr checkout` sets
   * up a fork it cannot push to), or one the GitHub Pull Requests extension
   * recorded. It is the only candidate, since a branch-name match could find
   * another pull request.
   */
  trackedPullRequest?: { remote: RemoteConfig; number: number };
}

/** The URL a remote fetches from, else the one it pushes to. */
function remoteUrl(remote: RemoteConfig): string | undefined {
  return remote.url ?? remote.pushUrl;
}

/** Whether a remote's URL names `owner/name`, ignoring case and URL form. */
function namesRepository(remote: RemoteConfig, owner: string, name: string): boolean {
  const url = remoteUrl(remote);
  const parsed = url === undefined ? undefined : parseRemoteUrl(url);
  return (
    parsed !== undefined &&
    parsed.owner.toLowerCase() === owner.toLowerCase() &&
    parsed.name.toLowerCase() === name.toLowerCase()
  );
}

/** Whether two remotes name the same repository, whatever they are called. */
function sameRepository(a: RemoteConfig, b: RemoteConfig): boolean {
  if (a === b) return true;
  const urlA = remoteUrl(a);
  const urlB = remoteUrl(b);
  if (urlA === undefined || urlB === undefined) return false;
  const repoA = parseRemoteUrl(urlA);
  if (!repoA) return urlA === urlB;
  return parseRemoteUrl(urlB)?.host === repoA.host && namesRepository(b, repoA.owner, repoA.name);
}

/**
 * The remote a branch setting names. Git also accepts a URL there, standing
 * for an unnamed remote (`gh pr checkout` records a fork that way); "." is
 * the local repository, which has no pull requests.
 */
function settingRemote(
  byName: ReadonlyMap<string, RemoteConfig>,
  value: string | undefined,
): RemoteConfig | undefined {
  if (value === undefined || value === '' || value === '.') return undefined;
  const remote = byName.get(value);
  if (remote) return remote;
  return /[:/\\]/.test(value) ? { name: value, url: value } : undefined;
}

/** The branch an upstream ref names, or undefined for any other ref. */
function mergedBranch(merge: string | undefined): string | undefined {
  if (merge === undefined) return undefined;
  if (merge.startsWith('refs/heads/')) return merge.slice('refs/heads/'.length) || undefined;
  return merge.startsWith('refs/') ? undefined : merge;
}

/**
 * Where to look for `branch`'s pull request. The head is the remote the
 * branch pushes to, following git's own precedence (branch.<name>.pushRemote,
 * remote.pushDefault, branch.<name>.remote), and origin when nothing is
 * configured.
 */
export function pullRequestRemotes(
  config: GitConfigSummary,
  branch: string,
): PullRequestRemotes | undefined {
  const byName = new Map(config.remotes.map((remote) => [remote.name, remote]));
  const tracking = config.branches.get(branch) ?? {};
  const tracked = settingRemote(byName, tracking.remote);
  const headRemote =
    settingRemote(byName, tracking.pushRemote) ??
    settingRemote(byName, config.pushDefault) ??
    tracked ??
    byName.get('origin') ??
    config.remotes[0];
  if (!headRemote) return undefined;

  const pullRef = /^refs\/pull\/(\d+)\/head$/.exec(tracking.merge ?? '');
  if (pullRef && tracked) {
    const trackedPullRequest = { remote: tracked, number: Number(pullRef[1]) };
    return { headRemote, lookups: [], trackedPullRequest };
  }
  const recorded = tracking.pullRequest;
  const recordedBase =
    recorded &&
    [...config.remotes, ...(tracked ? [tracked] : [])].find((remote) =>
      namesRepository(remote, recorded.owner, recorded.name),
    );
  if (recorded && recordedBase) {
    const trackedPullRequest = { remote: recordedBase, number: recorded.number };
    return { headRemote, lookups: [], trackedPullRequest };
  }

  // A branch usually reaches its pull request under its own name. A
  // differently named upstream is most often the branch it was started from
  // (`git checkout -b fix origin/develop`), and asking for that name finds
  // that branch's pull request instead. The exception is a fork's branch
  // checked out under another local name and tracked by URL, which only
  // review tools write: there the tracked name is the pull request's head,
  // in the repositories other than the fork itself.
  const trackedName = mergedBranch(tracking.merge);
  const forkHeadName =
    tracked !== undefined &&
    !byName.has(tracked.name) &&
    sameRepository(tracked, headRemote) &&
    trackedName !== undefined
      ? trackedName
      : undefined;

  const bases: RemoteConfig[] = [];
  for (const remote of [byName.get('upstream'), byName.get('origin'), tracked, headRemote]) {
    if (remote && !bases.some((base) => sameRepository(base, remote))) bases.push(remote);
  }
  const lookups = bases.map((base) => ({
    base,
    branch:
      forkHeadName !== undefined && tracked !== undefined && !sameRepository(base, tracked)
        ? forkHeadName
        : branch,
  }));
  return { headRemote, lookups };
}

/**
 * The user-level git config files, lowest precedence first, as git reads
 * them: $GIT_CONFIG_GLOBAL alone when set, otherwise the XDG file and then
 * ~/.gitconfig.
 */
export function globalGitConfigPaths(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string[] {
  const join = (...parts: string[]): string => parts.join('/').replace(/\/{2,}/g, '/');
  if (env.GIT_CONFIG_GLOBAL) return [env.GIT_CONFIG_GLOBAL];
  const xdg = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, 'git', 'config')
    : join(home, '.config', 'git', 'config');
  return [xdg, join(home, '.gitconfig')];
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
