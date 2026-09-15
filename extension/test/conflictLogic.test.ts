import { describe, expect, it } from 'vitest';
import {
  conflictLabel,
  conflictTooltip,
  confirmWithConflicts,
} from '../src/model/conflictLogic';

const files = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `src/file${i}.ts`);

describe('conflictLabel', () => {
  it('singularizes one conflict', () => {
    expect(conflictLabel(1)).toBe('1 conflict');
    expect(conflictLabel(4)).toBe('4 conflicts');
  });
});

describe('conflictTooltip', () => {
  it('lists every file when there are few', () => {
    expect(conflictTooltip(['a.ts', 'b.ts'])).toBe('2 conflicts to resolve:\na.ts\nb.ts');
  });

  it('caps the list and counts the rest', () => {
    const tooltip = conflictTooltip(files(13));
    expect(tooltip).toContain('13 conflicts to resolve:');
    expect(tooltip).toContain('src/file9.ts');
    expect(tooltip).not.toContain('src/file10.ts');
    expect(tooltip).toContain('…and 3 more');
  });
});

describe('confirmWithConflicts', () => {
  it('names the operation and the conflict count', () => {
    const confirmation = confirmWithConflicts('merge', ['a.ts']);
    expect(confirmation.message).toBe(
      'This repository has 1 conflict to resolve. Run merge anyway?',
    );
    expect(confirmation.detail).toContain('Git refuses most operations');
    expect(confirmation.detail).toContain('a.ts');
  });
});
