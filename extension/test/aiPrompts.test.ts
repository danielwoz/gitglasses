import { describe, expect, it } from 'vitest';
import {
  COMMIT_MESSAGE_SYSTEM,
  EXPLAIN_COMMIT_SYSTEM,
  EXPLAIN_WIP_SYSTEM,
  NL_SEARCH_SYSTEM,
  PROMPT_VERSION,
  explainCommitPrompt,
  nlSearchPrompt,
} from '../src/ai/prompts';

describe('prompt templates', () => {
  it('are versioned', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('nl-search system prompt carries the strict JSON schema and examples', () => {
    expect(NL_SEARCH_SYSTEM).toContain('STRICT JSON');
    expect(NL_SEARCH_SYSTEM).toContain('"text"');
    expect(NL_SEARCH_SYSTEM).toContain('"author"');
    expect(NL_SEARCH_SYSTEM).toContain('"sha"');
    expect(NL_SEARCH_SYSTEM).toContain('Examples');
  });

  it('system prompts ground the model in provided context and brevity', () => {
    for (const system of [
      EXPLAIN_COMMIT_SYSTEM,
      EXPLAIN_WIP_SYSTEM,
      COMMIT_MESSAGE_SYSTEM,
      NL_SEARCH_SYSTEM,
    ]) {
      expect(system).toContain('context provided');
      expect(system.toLowerCase()).toContain('concise');
    }
  });

  it('commit message prompt asks for Conventional Commits style', () => {
    expect(COMMIT_MESSAGE_SYSTEM).toContain('Conventional Commits');
  });

  it('prompt builders embed the supplied context verbatim', () => {
    const prompt = explainCommitPrompt(
      { sha: 'abc1234', author: 'a <a@b.c>', date: '2026-01-01', summary: 'fix crash' },
      '=== a.ts ===\n+patch',
    );
    expect(prompt).toContain('abc1234');
    expect(prompt).toContain('fix crash');
    expect(prompt).toContain('=== a.ts ===');
    expect(nlSearchPrompt('find alice commits')).toContain('find alice commits');
  });
});
