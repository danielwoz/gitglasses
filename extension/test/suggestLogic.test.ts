import { describe, expect, it } from 'vitest';
import {
  buildSuggestionBody,
  isAnchorRejection,
  selectionToRange,
} from '../src/reviews/suggestLogic';

describe('selectionToRange', () => {
  it('converts a same-line selection to a 1-based single-line range', () => {
    expect(
      selectionToRange({ startLine: 4, startCharacter: 2, endLine: 4, endCharacter: 10 }),
    ).toEqual({ startLine: 5, endLine: 5 });
  });

  it('converts a multi-line selection to an inclusive range', () => {
    expect(
      selectionToRange({ startLine: 2, startCharacter: 0, endLine: 5, endCharacter: 8 }),
    ).toEqual({ startLine: 3, endLine: 6 });
  });

  it('excludes a trailing line when the selection ends at character 0', () => {
    expect(
      selectionToRange({ startLine: 2, startCharacter: 0, endLine: 5, endCharacter: 0 }),
    ).toEqual({ startLine: 3, endLine: 5 });
  });

  it('keeps a single-line selection ending at character 0 on its line', () => {
    expect(
      selectionToRange({ startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 0 }),
    ).toEqual({ startLine: 4, endLine: 4 });
  });
});

describe('buildSuggestionBody', () => {
  it('wraps the replacement in a plain suggestion fence for GitHub', () => {
    expect(buildSuggestionBody({ replacement: 'const x = 1;' })).toBe(
      '```suggestion\nconst x = 1;\n```',
    );
  });

  it('prepends the optional comment separated by a blank line', () => {
    expect(buildSuggestionBody({ replacement: 'x', comment: 'Simpler this way.' })).toBe(
      'Simpler this way.\n\n```suggestion\nx\n```',
    );
  });

  it('uses GitLab offset syntax when linesAbove is given', () => {
    expect(buildSuggestionBody({ replacement: 'x', gitlabLinesAbove: 3 })).toBe(
      '```suggestion:-3+0\nx\n```',
    );
    expect(buildSuggestionBody({ replacement: 'x', gitlabLinesAbove: 0 })).toBe(
      '```suggestion:-0+0\nx\n```',
    );
  });

  it('grows the fence beyond backtick runs inside the replacement', () => {
    const body = buildSuggestionBody({ replacement: 'code with ``` inside' });
    expect(body).toBe('````suggestion\ncode with ``` inside\n````');
  });

  it('strips a single trailing newline from the replacement', () => {
    expect(buildSuggestionBody({ replacement: 'line\n' })).toBe('```suggestion\nline\n```');
  });
});

describe('isAnchorRejection', () => {
  it('recognizes GitHub 422 and GitLab 400 anchor rejections', () => {
    expect(isAnchorRejection(422)).toBe(true);
    expect(isAnchorRejection(400)).toBe(true);
  });

  it('is false for other statuses and undefined', () => {
    expect(isAnchorRejection(500)).toBe(false);
    expect(isAnchorRejection(undefined)).toBe(false);
  });
});
