// Pure web-URL construction for "open on remote" (no vscode/fs imports).
// Providers describe a repo as host/owner/name; each forge lays its web routes
// out differently, so the shapes are kept in one table rather than scattered
// through the command handlers.

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

interface Routes {
  /** Path segment introducing a file listing, e.g. "blob" or "src". */
  file: string;
  branch: string;
  commit: string;
  /** Fragment for a line range, given a 1-based inclusive range. */
  lines(start: number, end: number): string;
  /** Inserted between the repo path and the route, e.g. GitLab's "/-". */
  infix?: string;
}

const GITHUB: Routes = {
  file: 'blob',
  branch: 'tree',
  commit: 'commit',
  lines: (start, end) => (start === end ? `#L${start}` : `#L${start}-L${end}`),
};

const GITLAB: Routes = {
  file: 'blob',
  branch: 'tree',
  commit: 'commit',
  infix: '/-',
  lines: (start, end) => (start === end ? `#L${start}` : `#L${start}-${end}`),
};

const BITBUCKET: Routes = {
  file: 'src',
  branch: 'branch',
  commit: 'commits',
  lines: (start, end) => (start === end ? `#lines-${start}` : `#lines-${start}:${end}`),
};

const ROUTES: Record<string, Routes> = {
  github: GITHUB,
  'github-enterprise': GITHUB,
  gitlab: GITLAB,
  'gitlab-self-hosted': GITLAB,
  bitbucket: BITBUCKET,
  'bitbucket-server': BITBUCKET,
};

/** True when this provider's web routes are known. */
export function supportsRemoteUrls(providerId: string): boolean {
  return providerId in ROUTES;
}

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

/**
 * Build the forge URL for a target, or undefined when the provider's routes
 * are unknown. Callers should fall back to telling the user the remote is
 * unsupported rather than guessing a URL.
 */
export function buildRemoteUrl(
  providerId: string,
  repo: RepoDescriptor,
  target: RemoteTarget,
): string | undefined {
  const routes = ROUTES[providerId];
  if (!routes) return undefined;

  const base = `https://${repo.host}/${encodePath(repo.owner)}/${encodePath(repo.name)}`;
  const infix = routes.infix ?? '';

  switch (target.kind) {
    case 'repo':
      return base;
    case 'branch':
      if (target.branch === '') return base;
      return `${base}${infix}/${routes.branch}/${encodePath(target.branch)}`;
    case 'commit':
      if (target.sha === '') return base;
      return `${base}${infix}/${routes.commit}/${encodeURIComponent(target.sha)}`;
    case 'file': {
      const path = encodePath(target.path);
      if (path === '') return base;
      const ref = encodePath(target.ref) || 'HEAD';
      const url = `${base}${infix}/${routes.file}/${ref}/${path}`;
      const range = normalizeRange(target.startLine, target.endLine);
      return range ? `${url}${routes.lines(range.start, range.end)}` : url;
    }
  }
}
