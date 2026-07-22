import { describe, expect, it } from 'vitest';
import type { PatchEnvelope } from '@gitglasses/protocol';
import {
  classifySnippetUrl,
  confirmDetail,
  envelopeToJson,
  extractDiffStat,
  parseEnvelope,
  patchFileName,
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

describe('extractDiffStat', () => {
  it('counts additions and deletions per file across multiple files', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' keep',
      '-removed',
      '+added one',
      '+added two',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5 +5 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    expect(extractDiffStat(patch)).toEqual([
      { path: 'src/a.ts', additions: 2, deletions: 1, binary: false },
      { path: 'src/b.ts', additions: 1, deletions: 1, binary: false },
    ]);
  });

  it('tracks renames via rename from/to headers', () => {
    const patch = [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 96%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(extractDiffStat(patch)).toEqual([
      { path: 'new/name.ts', additions: 1, deletions: 1, binary: false, renamedFrom: 'old/name.ts' },
    ]);
  });

  it('flags binary files without counting lines', () => {
    const patch = [
      'diff --git a/logo.png b/logo.png',
      'index 111..222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    expect(extractDiffStat(patch)).toEqual([
      { path: 'logo.png', additions: 0, deletions: 0, binary: true },
    ]);
  });

  it('keeps the pre-image path for deletions (+++ /dev/null)', () => {
    const patch = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
    ].join('\n');
    expect(extractDiffStat(patch)).toEqual([
      { path: 'gone.ts', additions: 0, deletions: 2, binary: false },
    ]);
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

describe('confirmDetail', () => {
  it('summarizes the envelope with base sha7, date, and diffstat totals', () => {
    const env = envelope({ branch: 'feat/x' });
    const detail = confirmDetail(env, extractDiffStat(env.patch));
    expect(detail).toContain('Fix the widget');
    expect(detail).toContain(`Base: ${baseSha.slice(0, 7)} (branch feat/x)`);
    expect(detail).toContain('Created: 2026-07-22T10:00:00Z');
    expect(detail).toContain('1 file changed, +1 −1');
  });

  it('handles missing summary and pluralizes files', () => {
    const detail = confirmDetail(envelope({ summary: '', createdAtIso: '' }), [
      { path: 'a', additions: 2, deletions: 0, binary: false },
      { path: 'b', additions: 1, deletions: 3, binary: false },
    ]);
    expect(detail).toContain('(no summary)');
    expect(detail).toContain('2 files changed, +3 −3');
    expect(detail).not.toContain('Created:');
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
