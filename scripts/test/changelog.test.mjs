// Every changelog heading the version checks accept must yield release notes,
// so a release can never pass its checks and then fail to describe itself.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changelogSection, hasChangelogEntry } from '../lib/changelog.mjs';
import { releaseVersionProblems } from '../lib/versions.mjs';

const script = fileURLToPath(new URL('../release-notes.mjs', import.meta.url));
const HEADINGS = [
  '## [0.3.0] - 2026-11-01',
  '## [0.3.0]',
  '## 0.3.0',
  '## v0.3.0',
  '## [v0.3.0]',
  '## 0.3.0 - 2026-11-01',
];
const changelog = (heading, body = '### Fixed\n\n- A fix.\n') =>
  `# Changelog\n\nIntroduction.\n\n${heading}\n\n${body}\n## [0.2.0] - 2026-10-20\n\n- Older.\n`;

let dir;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gitglasses-changelog-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function notes(contents, version = '0.3.0') {
  const file = path.join(dir, 'CHANGELOG.md');
  writeFileSync(file, contents);
  return spawnSync(process.execPath, [script, version, '--changelog', file], { encoding: 'utf8' });
}

describe('changelogSection', () => {
  it('returns the section under each accepted heading, up to the next release', () => {
    for (const heading of HEADINGS) {
      expect(changelogSection(changelog(heading), '0.3.0'), heading).toBe('### Fixed\n\n- A fix.');
    }
  });

  it('reads the last section to the end of the file and handles CRLF', () => {
    expect(changelogSection('## [0.2.0]\r\n\r\n- Older.\r\n', '0.2.0')).toBe('- Older.');
  });

  it('matches only a heading for exactly that version', () => {
    expect(changelogSection('## [0.3.01]\n\n- x\n', '0.3.0')).toBeUndefined();
    expect(changelogSection('## [0.3.0-beta]\n\n- x\n', '0.3.0')).toBeUndefined();
    expect(changelogSection('### [0.3.0]\n\n- x\n', '0.3.0')).toBeUndefined();
    expect(changelogSection('Mentions 0.3.0 in prose\n', '0.3.0')).toBeUndefined();
  });
});

describe('hasChangelogEntry', () => {
  it('requires a heading with something under it', () => {
    expect(hasChangelogEntry(changelog('## [0.3.0]'), '0.3.0')).toBe(true);
    expect(hasChangelogEntry(changelog('## [0.3.0]', ''), '0.3.0')).toBe(false);
    expect(hasChangelogEntry('# Changelog\n\n## [0.3.0]\n', '0.3.0')).toBe(false);
  });
});

describe('release-notes', () => {
  it('prints the section under every heading the version checks accept', () => {
    for (const heading of HEADINGS) {
      const result = notes(changelog(heading));
      expect(result.status, `${heading}: ${result.stderr}`).toBe(0);
      expect(result.stdout, heading).toBe('### Fixed\n\n- A fix.\n');
    }
  });

  it('fails on a missing or empty section', () => {
    expect(notes(changelog('## [0.2.9]'))).toMatchObject({ status: 1 });
    expect(notes(changelog('## [0.2.9]')).stderr).toContain('has no section for 0.3.0');
    expect(notes(changelog('## [0.3.0]', ''))).toMatchObject({ status: 1 });
    expect(notes(changelog('## [0.3.0]', '')).stderr).toContain(
      'has no non-empty section for 0.3.0',
    );
  });

  it("prints this repository's section for its own version", () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const { version } = releaseVersionProblems(root);
    const result = spawnSync(process.execPath, [script, version], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^### /);
  });
});
