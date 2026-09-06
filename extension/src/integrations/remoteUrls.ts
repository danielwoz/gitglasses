// Pure web-URL construction for "open on remote" (no vscode/fs imports).
//
// Provider ids here must match the ones that can actually reach this module:
// DEFAULT_HOSTS in remoteMatcher ("github", "gitlab", "bitbucket",
// "azuredevops"), the ids Add Integration writes (integrationSettings), and
// "github-enterprise", which integrationService special-cases. An id present
// here but emitted by nothing is dead code that reads as coverage.

import type { RepoDescriptor } from '@gitglasses/integrations';

/** What the user asked to see on the forge's website. */
export type RemoteTarget =
  | { kind: 'repo' }
  | { kind: 'branch'; branch: string }
  | { kind: 'commit'; sha: string }
  | {
      kind: 'file';
      /** Repo-relative path, forward slashes, no leading slash. */
      path: string;
      /** Branch name or sha the path should be read at. */
      ref: string;
      /** 1-based inclusive line range; omitted links the whole file. */
      startLine?: number;
      endLine?: number;
    };

// Path segments are encoded individually so slashes survive but spaces and
// other literals in branch names or paths do not break the URL.
function encodePath(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment !== '')
    .map(encodeURIComponent)
    .join('/');
}

function normalizeRange(
  startLine?: number,
  endLine?: number,
): { start: number; end: number } | undefined {
  if (startLine === undefined || !Number.isFinite(startLine)) return undefined;
  const start = Math.max(1, Math.trunc(startLine));
  const rawEnd = endLine === undefined || !Number.isFinite(endLine) ? start : Math.trunc(endLine);
  const end = Math.max(start, rawEnd);
  return { start, end };
}

type Builder = (repo: RepoDescriptor, target: RemoteTarget) => string;

/**
 * GitHub and GitLab share a layout and differ only in the segment inserted
 * before the route and in how a line range is written.
 */
function treeStyle(options: {
  infix: string;
  lines: (start: number, end: number) => string;
}): Builder {
  return (repo, target) => {
    const base = `https://${repo.host}/${encodePath(repo.owner)}/${encodePath(repo.name)}`;
    switch (target.kind) {
      case 'repo':
        return base;
      case 'branch':
        return target.branch === ''
          ? base
          : `${base}${options.infix}/tree/${encodePath(target.branch)}`;
      case 'commit':
        return target.sha === ''
          ? base
          : `${base}${options.infix}/commit/${encodeURIComponent(target.sha)}`;
      case 'file': {
        const path = encodePath(target.path);
        if (path === '') return base;
        const ref = encodePath(target.ref) || 'HEAD';
        const url = `${base}${options.infix}/blob/${ref}/${path}`;
        const range = normalizeRange(target.startLine, target.endLine);
        return range ? `${url}${options.lines(range.start, range.end)}` : url;
      }
    }
  };
}

const GITHUB = treeStyle({
  infix: '',
  lines: (start, end) => (start === end ? `#L${start}` : `#L${start}-L${end}`),
});

const GITLAB = treeStyle({
  infix: '/-',
  lines: (start, end) => (start === end ? `#L${start}` : `#L${start}-${end}`),
});

/** Bitbucket Cloud: /src for files, /commits for commits, #lines-a:b. */
const BITBUCKET_CLOUD: Builder = (repo, target) => {
  const base = `https://${repo.host}/${encodePath(repo.owner)}/${encodePath(repo.name)}`;
  switch (target.kind) {
    case 'repo':
      return base;
    case 'branch':
      return target.branch === '' ? base : `${base}/branch/${encodePath(target.branch)}`;
    case 'commit':
      return target.sha === '' ? base : `${base}/commits/${encodeURIComponent(target.sha)}`;
    case 'file': {
      const path = encodePath(target.path);
      if (path === '') return base;
      const ref = encodePath(target.ref) || 'HEAD';
      const url = `${base}/src/${ref}/${path}`;
      const range = normalizeRange(target.startLine, target.endLine);
      if (!range) return url;
      return `${url}#lines-${range.start}${range.end === range.start ? '' : `:${range.end}`}`;
    }
  }
};

/**
 * Bitbucket Data Center (formerly Server) uses a different layout entirely:
 * /projects/<KEY>/repos/<slug>/browse/<path>?at=<ref>#<line>. Mapping it onto
 * the Cloud routes would produce URLs that 404.
 */
const BITBUCKET_DC: Builder = (repo, target) => {
  const base = `https://${repo.host}/projects/${encodePath(repo.owner)}/repos/${encodePath(
    repo.name,
  )}`;
  switch (target.kind) {
    case 'repo':
      return `${base}/browse`;
    case 'branch':
      return target.branch === ''
        ? `${base}/browse`
        : `${base}/browse?at=${encodeURIComponent(`refs/heads/${target.branch}`)}`;
    case 'commit':
      return target.sha === '' ? `${base}/commits` : `${base}/commits/${encodeURIComponent(target.sha)}`;
    case 'file': {
      const path = encodePath(target.path);
      if (path === '') return `${base}/browse`;
      let url = `${base}/browse/${path}`;
      if (target.ref !== '') url += `?at=${encodeURIComponent(target.ref)}`;
      const range = normalizeRange(target.startLine, target.endLine);
      if (!range) return url;
      return `${url}#${range.start}${range.end === range.start ? '' : `-${range.end}`}`;
    }
  }
};

/**
 * Azure DevOps addresses everything through query parameters, and its owner is
 * "organisation/project", so the repository lives at
 * https://host/<org>/<project>/_git/<repo>.
 */
const AZURE_DEVOPS: Builder = (repo, target) => {
  const base = `https://${repo.host}/${encodePath(repo.owner)}/_git/${encodePath(repo.name)}`;
  switch (target.kind) {
    case 'repo':
      return base;
    case 'branch':
      return target.branch === ''
        ? base
        : `${base}?version=GB${encodeURIComponent(target.branch)}`;
    case 'commit':
      return target.sha === '' ? base : `${base}/commit/${encodeURIComponent(target.sha)}`;
    case 'file': {
      if (target.path === '') return base;
      const params = new URLSearchParams();
      params.set('path', `/${target.path}`);
      if (target.ref !== '') params.set('version', `GB${target.ref}`);
      const range = normalizeRange(target.startLine, target.endLine);
      if (range) {
        params.set('line', String(range.start));
        params.set('lineEnd', String(range.end));
        params.set('lineStartColumn', '1');
        params.set('lineEndColumn', '1');
      }
      return `${base}?${params.toString()}`;
    }
  }
};

const BUILDERS: Record<string, Builder> = {
  github: GITHUB,
  'github-enterprise': GITHUB,
  gitlab: GITLAB,
  bitbucket: BITBUCKET_CLOUD,
  bitbucketDC: BITBUCKET_DC,
  azuredevops: AZURE_DEVOPS,
};

/** True when this provider's web routes are known. */
export function supportsRemoteUrls(providerId: string): boolean {
  return providerId in BUILDERS;
}

/**
 * Build the forge URL for a target, or undefined when the provider's routes
 * are unknown. Callers should tell the user the remote is unsupported rather
 * than opening a guessed URL.
 */
export function buildRemoteUrl(
  providerId: string,
  repo: RepoDescriptor,
  target: RemoteTarget,
): string | undefined {
  return BUILDERS[providerId]?.(repo, target);
}
