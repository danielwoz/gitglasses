// The release workflow's ordering: nothing publishes until CI has passed on
// the tagged commit and everything the release ships is ready, its steps run
// the same scripts as the local checks, and it publishes only the VSIXes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

/** The text of each job, keyed by its id. */
const jobs = new Map(
  workflow
    .slice(workflow.indexOf('\njobs:\n'))
    .split(/^(?= {2}[a-z][\w-]*:$)/m)
    .map((text) => [/^ {2}([a-z][\w-]*):$/m.exec(text)?.[1], text])
    .filter(([id]) => id),
);

function needs(id) {
  const value = /^ {4}needs: (.+)$/m.exec(jobs.get(id))?.[1] ?? '';
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((name) => name.trim());
}

describe('release workflow', () => {
  const publishJobs = [...jobs.keys()].filter((id) => id.startsWith('publish-'));

  it('publishes only after CI and every release asset', () => {
    expect(publishJobs).toEqual(['publish-marketplace', 'publish-openvsx']);
    for (const id of publishJobs) {
      expect(needs(id), id).toEqual(expect.arrayContaining(['version', 'ci', 'release-assets']));
    }
    expect(needs('github-release')).toEqual(
      expect.arrayContaining(['release-assets', 'publish-marketplace', 'publish-openvsx']),
    );
  });

  it('waits for CI through the tested gate, which ignores pull request runs', () => {
    expect(jobs.get('ci')).toContain(
      'node scripts/wait-for-ci.mjs --repo "$GITHUB_REPOSITORY" --sha "$GITHUB_SHA"',
    );
    expect(jobs.get('ci')).not.toContain('gh api');
  });

  // The MCP server is not shipped: nothing is packed for npm or published
  // there, and no npm credential is read.
  it('packs and publishes nothing to npm', () => {
    expect([...jobs.keys()]).not.toContain('package-mcp');
    expect(workflow).not.toMatch(/pack-mcp|verify-mcp-package|npm publish|registry-url|NPM_/);
  });

  it('runs the engine of every native package it builds, from the package', () => {
    const matrix = (id, pattern) => [...jobs.get(id).matchAll(pattern)].map((match) => match[1]);
    const packaged = matrix('package', /^ {10}- ([\w-]+)$/gm).filter((target) => target !== 'web');
    const built = ['engine', 'engine-alpine'].flatMap((id) =>
      matrix(id, /^\s+(?:- )?target: ([\w-]+)$/gm),
    );
    const smoked = matrix('smoke', /^\s+- target: ([\w-]+)$/gm);
    expect(packaged.length).toBeGreaterThan(0);
    expect(built.sort()).toEqual([...packaged].sort());
    expect(smoked.sort()).toEqual([...packaged].sort());
    expect(jobs.get('smoke')).toContain(
      'node scripts/verify-vsix.mjs dist/*.vsix --target "$TARGET" --version "$VERSION" --run',
    );
  });

  it('takes the release notes from the changelog parser the version job checks with', () => {
    expect(jobs.get('version')).toContain('node scripts/check-versions.mjs');
    expect(jobs.get('release-assets')).toContain(
      'node scripts/release-notes.mjs "$VERSION" > release-notes.md',
    );
    expect(jobs.get('release-assets')).not.toMatch(/CHANGELOG/);
  });
});
