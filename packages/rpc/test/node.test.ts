// Engine argv for the child-process transport: Restricted Mode is chosen per
// spawn, so a restart after the workspace is trusted starts a full engine.

import { describe, expect, it } from 'vitest';
import { engineArgs } from '../src/node.js';

describe('engineArgs', () => {
  it('starts a full engine by default', () => {
    expect(engineArgs({ enginePath: 'engine' })).toEqual(['--stdio']);
    expect(engineArgs({ enginePath: 'engine', restricted: false })).toEqual(['--stdio']);
  });

  it('passes --restricted when asked to', () => {
    expect(engineArgs({ enginePath: 'engine', restricted: true, logLevel: 'info' })).toEqual([
      '--stdio',
      '--restricted',
      '--log-level',
      'info',
    ]);
  });

  it('reads a restricted getter at each spawn', () => {
    let trusted = false;
    const options = { enginePath: 'engine', restricted: () => !trusted };
    expect(engineArgs(options)).toContain('--restricted');
    trusted = true;
    expect(engineArgs(options)).not.toContain('--restricted');
  });
});
