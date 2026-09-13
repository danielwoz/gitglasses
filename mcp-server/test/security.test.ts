import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalPath,
  configuredGitHubHost,
  createToolHandlers,
  isPlainHostname,
  isWithinAllowedRoots,
  parseAllowedRoots,
} from '../src/server.js';

// Captures every outbound request so a test can assert where a token went.
function recordingFetch() {
  const sent: Array<{ url: string; auth?: string }> = [];
  const fetchFn = async (url: string, init?: { headers?: Record<string, string> }) => {
    sent.push({
      url,
      auth: init?.headers?.authorization ?? init?.headers?.Authorization,
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: { viewer: { pullRequests: { nodes: [] } } } }),
      text: async () => '',
    };
  };
  return { sent, fetchFn };
}

// The GitHub host used to be a tool argument, so a prompt-injected agent could
// name any host and have the user's PAT delivered there in one request.
describe('list_my_prs host is not agent-controlled', () => {
  for (const attempt of [
    'attacker.example',
    '169.254.169.254',
    'api.github.com@attacker.example',
    'localhost:8443',
  ]) {
    it(`ignores an agent-supplied host: ${attempt}`, async () => {
      const { sent, fetchFn } = recordingFetch();
      const handlers = createToolHandlers({
        client: {} as never,
        env: { GITHUB_TOKEN: 'ghp_SECRET' },
        fetchFn: fetchFn as never,
      });

      await handlers.list_my_prs({ provider: 'github', host: attempt } as never);

      const hosts = sent.map((entry) => new URL(entry.url).host);
      expect(hosts.length).toBeGreaterThan(0);
      for (const host of hosts) expect(host).toBe('api.github.com');
      expect(sent.some((entry) => entry.url.includes('attacker.example'))).toBe(false);
    });
  }

  it('honours the operator-configured enterprise host', async () => {
    const { sent, fetchFn } = recordingFetch();
    const handlers = createToolHandlers({
      client: {} as never,
      env: { GITHUB_TOKEN: 'ghp_SECRET', GITGLASSES_GITHUB_HOST: 'ghe.corp.example' },
      fetchFn: fetchFn as never,
    });
    await handlers.list_my_prs({ provider: 'github' } as never);
    expect(new URL(sent[0].url).host).toBe('ghe.corp.example');
  });
});

describe('configuredGitHubHost', () => {
  it('rejects anything that is not a bare hostname', () => {
    for (const bad of [
      'api.github.com@attacker.example',
      'https://attacker.example',
      'host/path',
      'has space',
    ]) {
      expect(() => configuredGitHubHost({ GITGLASSES_GITHUB_HOST: bad })).toThrow();
    }
  });

  it('treats github.com and unset alike', () => {
    expect(configuredGitHubHost({})).toBeUndefined();
    expect(configuredGitHubHost({ GITGLASSES_GITHUB_HOST: 'github.com' })).toBeUndefined();
  });

  it('accepts a plain enterprise hostname', () => {
    expect(configuredGitHubHost({ GITGLASSES_GITHUB_HOST: 'ghe.corp.example' })).toBe(
      'ghe.corp.example',
    );
  });
});

describe('isPlainHostname', () => {
  it('accepts hostnames and ports, rejects userinfo, schemes and paths', () => {
    expect(isPlainHostname('github.com')).toBe(true);
    expect(isPlainHostname('ghe.corp.example:8443')).toBe(true);
    expect(isPlainHostname('api.github.com@attacker.example')).toBe(false);
    expect(isPlainHostname('https://x.example')).toBe(false);
    expect(isPlainHostname('x.example/path')).toBe(false);
    expect(isPlainHostname('')).toBe(false);
  });
});

// Without a bound, any path grants the repository containing it, because
// repo/discover walks upwards.
//
// Paths are built with path.join/path.delimiter rather than POSIX literals:
// the delimiter is ";" on Windows and path.resolve makes paths drive-relative
// there, so hardcoded "/a:/b" strings describe nothing the code would see.
describe('repository containment', () => {
  const base = path.resolve('containment-fixture');
  const work = path.join(base, 'work');
  const code = path.join(base, 'code');
  const roots = parseAllowedRoots([work, code].join(path.delimiter));

  it('parses each entry to an absolute path', () => {
    expect(roots).toEqual([work, code]);
  });

  it('allows a root and paths inside it', () => {
    expect(isWithinAllowedRoots(work, roots)).toBe(true);
    expect(isWithinAllowedRoots(path.join(work, 'repoA'), roots)).toBe(true);
    expect(isWithinAllowedRoots(path.join(code, 'x', 'y'), roots)).toBe(true);
  });

  it('blocks traversal back out of a root', () => {
    expect(isWithinAllowedRoots(path.join(work, '..', 'secret'), roots)).toBe(false);
  });

  it('blocks a sibling sharing a name prefix', () => {
    expect(isWithinAllowedRoots(path.join(base, 'workshop', 'z'), roots)).toBe(false);
  });

  it('blocks unrelated paths', () => {
    expect(isWithinAllowedRoots(path.resolve('somewhere-else'), roots)).toBe(false);
  });

  it('is unrestricted when unset, preserving existing setups', () => {
    expect(parseAllowedRoots(undefined)).toEqual([]);
    expect(parseAllowedRoots('   ')).toEqual([]);
    expect(isWithinAllowedRoots(path.resolve('anything'), [])).toBe(true);
  });
});

// path.resolve collapses "..", but it does not follow symlinks, so a lexical
// comparison accepts a link inside a root that resolves outside it.
describe('symlinked repository containment', () => {
  let base: string;
  let jail: string;
  let secret: string;
  let escaping: string;
  let internal: string;

  beforeAll(() => {
    base = canonicalPath(mkdtempSync(path.join(os.tmpdir(), 'gitglasses-roots-')));
    jail = path.join(base, 'jail');
    secret = path.join(base, 'elsewhere', 'secret');
    mkdirSync(path.join(jail, 'proj'), { recursive: true });
    mkdirSync(path.join(jail, 'other'), { recursive: true });
    mkdirSync(secret, { recursive: true });
    writeFileSync(path.join(secret, 'marker'), 'secret\n');
    escaping = path.join(jail, 'proj', 'link');
    symlinkSync(secret, escaping, 'junction');
    internal = path.join(jail, 'proj', 'sibling');
    symlinkSync(path.join(jail, 'other'), internal, 'junction');
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolves a symlink to its target', () => {
    expect(canonicalPath(escaping)).toBe(secret);
    expect(canonicalPath(path.join(escaping, 'nested', 'deeper'))).toBe(
      path.join(secret, 'nested', 'deeper'),
    );
  });

  it('blocks a symlink pointing out of a root', () => {
    const roots = parseAllowedRoots(jail);
    expect(isWithinAllowedRoots(canonicalPath(escaping), roots)).toBe(false);
    expect(isWithinAllowedRoots(canonicalPath(path.join(escaping, 'inner')), roots)).toBe(
      false,
    );
  });

  it('allows a symlink that stays inside a root', () => {
    const roots = parseAllowedRoots(jail);
    expect(isWithinAllowedRoots(canonicalPath(internal), roots)).toBe(true);
    expect(isWithinAllowedRoots(canonicalPath(path.join(internal, 'inner')), roots)).toBe(
      true,
    );
  });

  it('canonicalises the roots too, so a symlinked root still matches', () => {
    const linkedRoot = path.join(base, 'jail-link');
    symlinkSync(jail, linkedRoot, 'junction');
    const roots = parseAllowedRoots(linkedRoot);
    expect(roots).toEqual([jail]);
    expect(isWithinAllowedRoots(canonicalPath(path.join(jail, 'proj')), roots)).toBe(true);
  });

  it('keeps a non-existent path lexical rather than allowing it', () => {
    const missing = path.join(base, 'no-such-dir', 'repo');
    expect(canonicalPath(missing)).toBe(missing);
    expect(isWithinAllowedRoots(missing, parseAllowedRoots(jail))).toBe(false);
  });

  it('rejects a tool call naming a path that symlinks out of a root', async () => {
    const handlers = createToolHandlers({
      client: {} as never,
      env: { GITGLASSES_ALLOWED_ROOTS: jail },
    });
    await expect(handlers.git_status({ repoPath: escaping })).rejects.toThrow(
      /outside GITGLASSES_ALLOWED_ROOTS/,
    );
  });

  it('lets a tool call through when the symlink stays inside a root', async () => {
    const requested: string[] = [];
    const handlers = createToolHandlers({
      client: {
        request: async (_method: string, params: { path: string }) => {
          requested.push(params.path);
          throw new Error('reached the engine');
        },
      } as never,
      env: { GITGLASSES_ALLOWED_ROOTS: jail },
    });
    await expect(handlers.git_status({ repoPath: internal })).rejects.toThrow(
      'reached the engine',
    );
    expect(requested).toEqual([path.join(jail, 'other')]);
  });
});
