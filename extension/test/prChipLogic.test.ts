import { describe, expect, it } from 'vitest';
import { prChipSuffix } from '../src/integrations/prChipLogic';

describe('prChipSuffix', () => {
  it('uses a check mark for passing checks', () => {
    expect(prChipSuffix({ number: 42, checksStatus: 'passing' })).toBe('PR #42 ✓');
  });

  it('uses a cross for failing checks', () => {
    expect(prChipSuffix({ number: 7, checksStatus: 'failing' })).toBe('PR #7 ✗');
  });

  it('uses a dot for pending, none, and unknown checks', () => {
    expect(prChipSuffix({ number: 1, checksStatus: 'pending' })).toBe('PR #1 ○');
    expect(prChipSuffix({ number: 2, checksStatus: 'none' })).toBe('PR #2 ○');
    expect(prChipSuffix({ number: 3 })).toBe('PR #3 ○');
  });
});
