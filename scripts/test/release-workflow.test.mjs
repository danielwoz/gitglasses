// The release workflow's ordering: nothing publishes until CI has passed on
// the tagged commit and everything the release ships is ready, and its steps
// run the same scripts as the local checks.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_PACKAGES } from '../lib/mcp-package.mjs';

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
    expect(publishJobs).toEqual(['publish-marketplace', 'publish-openvsx', 'publish-npm']);
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

  it('packs gitglasses-mcp with its npm README and checks the tarball', () => {
    expect(jobs.get('package-mcp')).toContain('node scripts/pack-mcp.mjs --out dist-npm');
    expect(jobs.get('package-mcp')).toContain('node scripts/verify-mcp-package.mjs');
    expect(jobs.get('package-mcp')).not.toMatch(/pnpm[^\n]* pack\b/);
  });

  it('packs an engine package from every engine the release builds, and runs one', () => {
    expect(needs('package-mcp')).toEqual(expect.arrayContaining(['engine', 'engine-alpine']));
    expect(jobs.get('package-mcp')).toContain('--engines engines --all-engines');
    expect(jobs.get('package-mcp')).toContain('--engine-package');
    const built = ['engine', 'engine-alpine'].flatMap((id) =>
      [...jobs.get(id).matchAll(/^\s+(?:- )?target: ([\w-]+)$/gm)].map((match) => match[1]),
    );
    expect(built.sort()).toEqual(ENGINE_PACKAGES.map((engine) => engine.target).sort());
  });

  it('publishes the engine packages before gitglasses-mcp, which names them', () => {
    const publish = jobs.get('publish-npm');
    expect(publish).toContain('environment: release');
    const engines = publish.indexOf('dist-npm/gitglasses-engine-');
    const server = publish.indexOf('publish "dist-npm/gitglasses-mcp-');
    expect(engines).toBeGreaterThan(0);
    expect(server).toBeGreaterThan(engines);
    expect(publish).toContain('--provenance --access public');
  });

  it('takes the release notes from the changelog parser the version job checks with', () => {
    expect(jobs.get('version')).toContain('node scripts/check-versions.mjs');
    expect(jobs.get('release-assets')).toContain(
      'node scripts/release-notes.mjs "$VERSION" > release-notes.md',
    );
    expect(jobs.get('release-assets')).not.toMatch(/CHANGELOG/);
  });
});
