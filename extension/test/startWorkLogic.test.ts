import { describe, expect, it } from 'vitest';
import { fallbackBranchName, sanitizeBranchName } from '../src/integrations/startWorkLogic';

describe('sanitizeBranchName', () => {
  it('lowercases and dash-separates arbitrary text', () => {
    expect(sanitizeBranchName('Fix Login Flow!')).toBe('fix-login-flow');
  });

  it('strips leading/trailing separators and collapses runs', () => {
    expect(sanitizeBranchName('--wip:  new -- thing..done-')).toBe('wip-new-thing.done');
  });

  it('returns empty for input with no usable characters', () => {
    expect(sanitizeBranchName('***')).toBe('');
  });

  it('caps overly long names', () => {
    expect(sanitizeBranchName('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('fallbackBranchName', () => {
  it('combines key and title', () => {
    expect(fallbackBranchName('PROJ-42', 'Fix login flow')).toBe('proj-42-fix-login-flow');
  });

  it('handles repo#number style keys', () => {
    expect(fallbackBranchName('acme/widgets#12', 'Crash on save')).toBe(
      'acme/widgets-12-crash-on-save',
    );
  });

  it('falls back to the key alone, then to a generic name', () => {
    expect(fallbackBranchName('PROJ-42', '***')).toBe('proj-42');
    expect(fallbackBranchName('***', '???')).toBe('work');
  });
});
