import { describe, expect, it } from 'vitest';
import type { PatchEnvelope, PatchFileChange } from '@gitglasses/protocol';
import {
  CONFIRM_MAX_LISTED_FILES,
  classifySnippetUrl,
  confirmDetail,
  confirmMessage,
  envelopeToJson,
  parseEnvelope,
  patchFileName,
  sensitivePathReason,
  snippetProviderHost,
} from '../src/patches/patchLogic';

const baseSha = 'a'.repeat(40);

function envelope(overrides: Partial<PatchEnvelope> = {}): PatchEnvelope {
  return {
    format: 'gitglasses-patch',
    version: 1,
    baseSha,
    summary: 'Fix the widget',
    patch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
    createdAtIso: '2026-07-22T10:00:00Z',
    ...overrides,
  };
}

describe('parseEnvelope', () => {
  it('accepts a valid envelope and normalizes optional fields', () => {
    const result = parseEnvelope(JSON.stringify(envelope({ branch: 'feat/x' })));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.baseSha).toBe(baseSha);
      expect(result.envelope.branch).toBe('feat/x');
      expect(result.envelope.summary).toBe('Fix the widget');
    }
  });

  it('rejects non-JSON with a friendly message', () => {
    const result = parseEnvelope('this is not json');
    expect(result).toEqual({
      ok: false,
      error: 'the content is not valid JSON (expected a .ggpatch envelope)',
    });
  });

  it('rejects JSON that is not an envelope object', () => {
    expect(parseEnvelope('[1,2]').ok).toBe(false);
    expect(parseEnvelope('"hi"').ok).toBe(false);
  });

  it('rejects a wrong or missing format marker', () => {
    const bad = parseEnvelope(JSON.stringify({ ...envelope(), format: 'other' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('not a GitGlasses patch');
  });

  it('rejects unsupported versions, naming the found version', () => {
    const bad = parseEnvelope(JSON.stringify({ ...envelope(), version: 2 }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('version 2');
  });

  it('rejects a malformed base SHA and empty patch content', () => {
    expect(parseEnvelope(JSON.stringify({ ...envelope(), baseSha: 'abc' })).ok).toBe(false);
    const noPatch = parseEnvelope(JSON.stringify({ ...envelope(), patch: '  ' }));
    expect(noPatch.ok).toBe(false);
    if (!noPatch.ok) expect(noPatch.error).toContain('no patch content');
  });
});

describe('envelopeToJson', () => {
  it('round-trips through parseEnvelope', () => {
    const original = envelope({ branch: 'feat/x', remoteFingerprint: 'deadbeefcafebabe' });
    const result = parseEnvelope(envelopeToJson(original));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope).toEqual(original);
  });

  it('pretty-prints with a trailing newline', () => {
    const json = envelopeToJson(envelope());
    expect(json.endsWith('}\n')).toBe(true);
    expect(json).toContain('\n  "format": "gitglasses-patch",');
  });
});

describe('classifySnippetUrl', () => {
  it('classifies gist URLs by their gist. host prefix', () => {
    expect(classifySnippetUrl('https://gist.github.com/octocat/aa5a315d61ae9438b18d')).toEqual({
      kind: 'gist',
      host: 'gist.github.com',
    });
  });

  it('classifies GitLab snippet URLs, including self-managed hosts', () => {
    expect(classifySnippetUrl('https://gitlab.com/-/snippets/42')).toEqual({
      kind: 'gitlab-snippet',
      host: 'gitlab.com',
    });
    expect(classifySnippetUrl('https://gitlab.example.com/g/p/-/snippets/7')).toEqual({
      kind: 'gitlab-snippet',
      host: 'gitlab.example.com',
    });
  });

  it('treats other http(s) URLs as raw and non-URLs as undefined', () => {
    expect(classifySnippetUrl('https://example.com/patch.ggpatch')).toEqual({ kind: 'raw' });
    expect(classifySnippetUrl('file:///tmp/x.ggpatch')).toBeUndefined();
    expect(classifySnippetUrl('not a url')).toBeUndefined();
  });

  it('maps snippet hosts to their hosting-entry domains', () => {
    expect(snippetProviderHost({ kind: 'gist', host: 'gist.github.com' })).toBe('github.com');
    expect(snippetProviderHost({ kind: 'gitlab-snippet', host: 'gitlab.example.com' })).toBe(
      'gitlab.example.com',
    );
    expect(snippetProviderHost({ kind: 'raw' })).toBeUndefined();
  });
});

function file(overrides: Partial<PatchFileChange> & { path: string }): PatchFileChange {
  return { status: 'M', additions: 0, deletions: 0, binary: false, ...overrides };
}

describe('confirmDetail', () => {
  it('summarizes the envelope with base sha7, date, and the totals of the listed files', () => {
    const env = envelope({ branch: 'feat/x' });
    const detail = confirmDetail(env, [file({ path: 'x', additions: 1, deletions: 1 })]);
    expect(detail).toContain('Fix the widget');
    expect(detail).toContain(`Base: ${baseSha.slice(0, 7)} (branch feat/x)`);
    expect(detail).toContain('Created: 2026-07-22T10:00:00Z');
    expect(detail).toContain('1 file changed, +1 −1');
    expect(detail).toContain('• x  +1 −1');
  });

  it('handles missing summary and pluralizes files', () => {
    const detail = confirmDetail(envelope({ summary: '', createdAtIso: '' }), [
      file({ path: 'a', additions: 2 }),
      file({ path: 'b', additions: 1, deletions: 3 }),
    ]);
    expect(detail).toContain('(no summary)');
    expect(detail).toContain('2 files changed, +3 −3');
    expect(detail).not.toContain('Created:');
  });

  it('names every file with what happens to it', () => {
    const detail = confirmDetail(envelope(), [
      file({ path: 'docs/new.md', status: 'R', origPath: 'old.md' }),
      file({ path: 'gone.txt', status: 'D', deletions: 2 }),
      file({ path: 'fresh.txt', status: 'A', additions: 4 }),
      file({ path: 'logo.png', binary: true }),
    ]);
    expect(detail).toContain('• docs/new.md (renamed from old.md)  +0 −0');
    expect(detail).toContain('• gone.txt (deleted)  +0 −2');
    expect(detail).toContain('• fresh.txt (new)  +4 −0');
    expect(detail).toContain('• logo.png (binary)');
  });

  it('marks files that can run code and lists them first, past the cap', () => {
    const many = Array.from({ length: CONFIRM_MAX_LISTED_FILES + 5 }, (_, i) =>
      file({ path: `src/file${i}.ts`, additions: 1 }),
    );
    const detail = confirmDetail(envelope(), [
      ...many,
      file({ path: '.vscode/settings.json', status: 'A', additions: 3 }),
    ]);
    const lines = detail.split('\n');
    const firstFile = lines.findIndex((line) => line.startsWith('⚠') || line.startsWith('•'));
    expect(lines[firstFile]).toBe(
      '⚠ .vscode/settings.json (new)  +3 −0 — editor settings and tasks',
    );
    expect(detail).toContain('…and 6 more files');
    expect(detail).toContain(`${CONFIRM_MAX_LISTED_FILES + 6} files changed`);
  });
});

describe('sensitivePathReason', () => {
  it('flags editor, CI, git, build and script files', () => {
    expect(sensitivePathReason('.vscode/tasks.json')).toBe('editor settings and tasks');
    expect(sensitivePathReason('.github/workflows/ci.yml')).toBe('CI configuration');
    expect(sensitivePathReason('.gitlab-ci.yml')).toBe('CI configuration');
    expect(sensitivePathReason('.gitattributes')).toContain('git attributes');
    expect(sensitivePathReason('sub/.gitattributes')).toContain('git attributes');
    expect(sensitivePathReason('.gitmodules')).toBe('submodules');
    expect(sensitivePathReason('packages/app/package.json')).toBe('package scripts');
    expect(sensitivePathReason('Makefile')).toBe('build script');
    expect(sensitivePathReason('tools/setup.sh')).toBe('script');
    expect(sensitivePathReason('.envrc')).toBe('configuration file');
    expect(sensitivePathReason('bin/tool', true)).toBe('made executable');
  });

  it('leaves ordinary files alone', () => {
    expect(sensitivePathReason('src/index.ts')).toBeUndefined();
    expect(sensitivePathReason('README.md')).toBeUndefined();
    expect(sensitivePathReason('.gitignore')).toBeUndefined();
    expect(sensitivePathReason('docs/.prettierrc')).toBeUndefined();
  });
});

describe('confirmMessage', () => {
  it('asks plainly when nothing is flagged and warns otherwise', () => {
    expect(confirmMessage([file({ path: 'a.txt' })])).toBe('Apply this patch to the repository?');
    expect(
      confirmMessage([file({ path: '.github/workflows/x.yml' }), file({ path: 'package.json' })]),
    ).toContain('changes 2 files that can run code');
  });
});

describe('patchFileName', () => {
  it('slugifies the summary into a .ggpatch name', () => {
    expect(patchFileName('Fix the Widget!')).toBe('fix-the-widget.ggpatch');
  });

  it('falls back to patch.ggpatch for empty or unusable summaries', () => {
    expect(patchFileName('')).toBe('patch.ggpatch');
    expect(patchFileName('***')).toBe('patch.ggpatch');
  });
});
