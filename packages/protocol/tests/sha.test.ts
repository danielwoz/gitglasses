import { describe, expect, it } from 'vitest';
import { SHORT_SHA_LENGTH, UNCOMMITTED_SHA, shortSha } from '../src/sha.js';

describe('shortSha', () => {
  it('abbreviates a full sha to SHORT_SHA_LENGTH characters', () => {
    expect(shortSha('a'.repeat(40))).toBe('a'.repeat(SHORT_SHA_LENGTH));
    expect(shortSha('aabbccddeeff00112233445566778899aabbccdd')).toBe('aabbccd');
  });

  it('leaves an already-abbreviated sha alone', () => {
    expect(shortSha('deadbee')).toBe('deadbee');
  });

  it('marks uncommitted lines with an all-zero sha', () => {
    expect(UNCOMMITTED_SHA).toHaveLength(40);
    expect(shortSha(UNCOMMITTED_SHA)).toBe('0000000');
  });
});
