// The release workflow's ordering: nothing publishes until CI has passed on
// the tagged commit and everything the release ships is ready, and its steps
// run the same scripts as the local checks.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)), 'utf8');

/** The text of each job, keyed by its id. */
const jobs = new Map(
  workflow
    .slice(workflow.indexOf('\njobs:\n'))
    .split(/^(?=  [a-z][\w-]*:$)/m)
    .map((text) => [/^ {2}([a-z][\w-]*):$/m.exec(text)?.[1], text])
    .filter(([id]) => id),
);

function needs(id) {
  const value = /^ {4}needs: (.+)$/m.exec(jobs.get(id))?.[1] ?? '';
  return value.replace(/^\[|\]$/g, '').split(',').map((name) => name.trim());
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

  it('takes the release notes from the changelog parser the version job checks with', () => {
    expect(jobs.get('version')).toContain('node scripts/check-versions.mjs');
    expect(jobs.get('release-assets')).toContain('node scripts/release-notes.mjs "$VERSION" > release-notes.md');
    expect(jobs.get('release-assets')).not.toMatch(/CHANGELOG/);
  });
});
