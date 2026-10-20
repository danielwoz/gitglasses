// How declared provenance is worded wherever commits are shown: always as a
// declaration, naming what declared it, with session links only when they
// are http(s), and the graph filter that keeps undeclared commits on the
// human side.

import { describe, expect, it } from 'vitest';
import type { CommitProvenance, ProvenanceDeclaration } from '@gitglasses/protocol';
import {
  batches,
  declarationText,
  isProvenanceFilter,
  isSessionLink,
  passesProvenanceFilter,
  provenanceLines,
  summarizeProvenance,
} from '../src/provenance/provenanceLogic';
import { provenanceHoverLine } from '../src/provenance/provenanceMarkdown';

const claudeTrailer: ProvenanceDeclaration = {
  source: 'trailer',
  kind: 'agent',
  name: 'Claude',
  model: 'Opus 4.7',
  via: 'Co-authored-by',
  value: 'Claude Opus 4.7 <noreply@anthropic.com>',
};

const copilotAuthor: ProvenanceDeclaration = {
  source: 'identity',
  kind: 'agent',
  name: 'GitHub Copilot',
  via: 'author',
  value: 'Copilot <198982749+Copilot@users.noreply.github.com>',
  url: 'https://github.com/o/r/tasks/1',
};

const cursorNote: ProvenanceDeclaration = {
  source: 'notes',
  kind: 'agent',
  name: 'Cursor',
  model: 'gpt-5',
  via: 'refs/notes/ai',
  value: '6ef2299e',
};

const humanNote: ProvenanceDeclaration = {
  source: 'notes',
  kind: 'human',
  name: 'Dev <dev@example.com>',
  via: 'refs/notes/ai',
  value: 'Dev <dev@example.com>',
};

function agent(...declarations: ProvenanceDeclaration[]): CommitProvenance {
  return { declared: 'agent', declarations };
}

describe('summarizeProvenance', () => {
  it('says nothing about a commit that declares nothing', () => {
    expect(summarizeProvenance(undefined)).toBeUndefined();
    expect(summarizeProvenance({ declared: 'unknown', declarations: [] })).toBeUndefined();
  });

  it('labels a co-authored commit AI-assisted, declared via its trailer', () => {
    expect(summarizeProvenance(agent(claudeTrailer))).toEqual({
      agent: true,
      label: 'AI-assisted',
      via: 'Co-authored-by: Claude Opus 4.7',
      text: 'AI-assisted (declared via Co-authored-by: Claude Opus 4.7)',
      agents: ['Claude'],
    });
  });

  it('labels a commit an agent authored AI-authored and keeps its session link', () => {
    const summary = summarizeProvenance(agent(claudeTrailer, copilotAuthor));
    expect(summary?.label).toBe('AI-authored');
    // The highest priority declaration names how it was declared.
    expect(summary?.via).toBe('Co-authored-by: Claude Opus 4.7');
    expect(summary?.agents).toEqual(['Claude', 'GitHub Copilot']);
    expect(summary?.sessionUrl).toBe('https://github.com/o/r/tasks/1');
  });

  it('names a git-ai note with its agent and model', () => {
    expect(summarizeProvenance(agent(cursorNote, humanNote))?.text).toBe(
      'AI-assisted (declared via git-ai note: Cursor · gpt-5)',
    );
  });

  it('labels a commit whose note declares only known humans Human-written', () => {
    expect(summarizeProvenance({ declared: 'human', declarations: [humanNote] })).toMatchObject({
      agent: false,
      label: 'Human-written',
      text: 'Human-written (declared via git-ai note: Dev)',
    });
  });

  it('ignores session links that are not http(s)', () => {
    const summary = summarizeProvenance(agent({ ...claudeTrailer, url: 'javascript:alert(1)' }));
    expect(summary?.sessionUrl).toBeUndefined();
  });
});

describe('declarationText', () => {
  it('shows a session link that stands alone by its trailer and agent', () => {
    expect(
      declarationText({
        source: 'trailer',
        kind: 'agent',
        name: 'Amp',
        via: 'Amp-Thread-ID',
        value: 'https://ampcode.com/threads/T-1',
        url: 'https://ampcode.com/threads/T-1',
      }),
    ).toBe('Amp-Thread-ID (Amp)');
  });

  it('shows the kernel form as written and cuts long values short', () => {
    expect(
      declarationText({
        source: 'trailer',
        kind: 'agent',
        name: 'Claude',
        model: 'claude-3-opus',
        via: 'Assisted-by',
        value: 'Claude:claude-3-opus coccinelle sparse',
      }),
    ).toBe('Assisted-by: Claude:claude-3-opus coccinelle sparse');
    const long = declarationText({ ...claudeTrailer, value: 'x'.repeat(200) });
    expect(long.length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('provenanceLines', () => {
  it('lists every other declaration and the session link', () => {
    expect(provenanceLines(agent(claudeTrailer, copilotAuthor))).toEqual([
      'AI-authored (declared via Co-authored-by: Claude Opus 4.7)',
      'also declared via author: Copilot',
      'session: https://github.com/o/r/tasks/1',
    ]);
    expect(provenanceLines({ declared: 'unknown', declarations: [] })).toEqual([]);
  });
});

describe('provenanceHoverLine', () => {
  it('escapes what the repository wrote and renders the session link', () => {
    const line = provenanceHoverLine(
      summarizeProvenance(
        agent({
          ...claudeTrailer,
          value: '[click](command:workbench.action.terminal.new) <noreply@anthropic.com>',
          url: 'https://example.com/s?a=(1)',
        }),
      )!,
    );
    expect(line).toContain(
      '$(sparkle) **AI\\-assisted** (declared via Co\\-authored\\-by: ' +
        '\\[click\\]\\(command:workbench\\.action\\.terminal\\.new\\))',
    );
    expect(line).toContain('[session link](<https://example.com/s?a=(1)>');
  });

  it('marks a human declaration with a person', () => {
    const line = provenanceHoverLine(
      summarizeProvenance({ declared: 'human', declarations: [humanNote] })!,
    );
    expect(line.startsWith('$(person) **Human\\-written**')).toBe(true);
    expect(line).not.toContain('session link');
  });
});

describe('the provenance filter', () => {
  it('keeps undeclared commits with the human ones and every non-commit row', () => {
    expect(passesProvenanceFilter('all', true, undefined)).toBe(true);
    expect(passesProvenanceFilter('agent', true, true)).toBe(true);
    expect(passesProvenanceFilter('agent', true, false)).toBe(false);
    expect(passesProvenanceFilter('agent', true, undefined)).toBe(false);
    expect(passesProvenanceFilter('human', true, undefined)).toBe(true);
    expect(passesProvenanceFilter('human', true, true)).toBe(false);
    expect(passesProvenanceFilter('agent', false, undefined)).toBe(true);
  });

  it('accepts only known filter values', () => {
    expect(isProvenanceFilter('agent')).toBe(true);
    expect(isProvenanceFilter('robots')).toBe(false);
    expect(isProvenanceFilter(undefined)).toBe(false);
  });
});

describe('helpers', () => {
  it('accepts only http(s) links without whitespace', () => {
    expect(isSessionLink('https://ampcode.com/threads/T-1')).toBe(true);
    expect(isSessionLink('HTTP://example.com')).toBe(true);
    expect(isSessionLink('file:///etc/passwd')).toBe(false);
    expect(isSessionLink('https://example.com/a b')).toBe(false);
    expect(isSessionLink(undefined)).toBe(false);
  });

  it('batches shas without duplicates', () => {
    expect(batches(['a', 'b', 'a', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(batches([], 2)).toEqual([]);
  });
});
