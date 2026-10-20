import { ErrorCodes } from '@gitglasses/protocol';
import { EngineError, type EngineClient } from '@gitglasses/rpc';

export interface FakeRepo {
  id: string;
  /** The root the engine reports. */
  root: string;
  /** Paths at or below this prefix are inside the repository. */
  match: string;
}

export interface FakeRequest {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Engine stand-in for repo/discover and repo/close: answers with the
 * innermost repository whose `match` prefix contains the requested path (the
 * engine's own upward search), reporting `root` with a trailing slash as
 * libgit2 does. Requests and notifications are recorded.
 */
export function fakeEngine(
  repos: FakeRepo[],
  options: { fail?: (dir: string) => Error | undefined } = {},
) {
  const requests: FakeRequest[] = [];
  const notifications: FakeRequest[] = [];
  const engine = {
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      if (method === 'repo/close') return {};
      if (method !== 'repo/discover') throw new Error(`unexpected ${method}`);
      const requested = String(params.path);
      const failure = options.fail?.(requested);
      if (failure) throw failure;
      const fold = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
      const target = fold(requested);
      const hit = repos
        .filter((repo) => target === fold(repo.match) || target.startsWith(`${fold(repo.match)}/`))
        .sort((a, b) => b.match.length - a.match.length)[0];
      if (!hit) {
        throw new EngineError(
          ErrorCodes.RepoNotFound,
          `could not find repository at '${requested}'`,
        );
      }
      return { repoId: hit.id, rootPath: `${hit.root}/`, bare: false };
    },
    notify(method: string, params: Record<string, unknown>) {
      notifications.push({ method, params });
    },
  };
  const discoveries = (): FakeRequest[] =>
    requests.filter((request) => request.method === 'repo/discover');
  const discovered = (): string[] => discoveries().map((request) => String(request.params.path));
  return {
    engine: engine as unknown as EngineClient,
    requests,
    notifications,
    discoveries,
    discovered,
  };
}
