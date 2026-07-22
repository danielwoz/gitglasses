import { describe, expect, it } from 'vitest';
import {
  move,
  planFromPreview,
  setAction,
  setMessage,
  sha7,
  toRebaseEntries,
  validate,
} from '../webviews-src/rebase/rebaseLogic';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function plan() {
  return planFromPreview([
    { sha: A, summary: 'first' },
    { sha: B, summary: 'second' },
    { sha: C, summary: 'third' },
  ]);
}

describe('planFromPreview', () => {
  it('defaults every entry to pick with an empty message', () => {
    expect(plan()).toEqual([
      { sha: A, summary: 'first', action: 'pick', message: '' },
      { sha: B, summary: 'second', action: 'pick', message: '' },
      { sha: C, summary: 'third', action: 'pick', message: '' },
    ]);
  });
});

describe('move', () => {
  it('moves an entry down', () => {
    expect(move(plan(), 0, 2).map((e) => e.sha)).toEqual([B, C, A]);
  });

  it('moves an entry up', () => {
    expect(move(plan(), 2, 0).map((e) => e.sha)).toEqual([C, A, B]);
  });

  it('clamps an out-of-range target', () => {
    expect(move(plan(), 0, 99).map((e) => e.sha)).toEqual([B, C, A]);
    expect(move(plan(), 1, -5).map((e) => e.sha)).toEqual([B, A, C]);
  });

  it('ignores an out-of-range source index', () => {
    expect(move(plan(), 7, 0)).toEqual(plan());
  });

  it('does not mutate the input plan', () => {
    const original = plan();
    move(original, 0, 2);
    expect(original.map((e) => e.sha)).toEqual([A, B, C]);
  });
});

describe('setAction / setMessage', () => {
  it('replaces only the targeted entry action', () => {
    const updated = setAction(plan(), 1, 'squash');
    expect(updated[1].action).toBe('squash');
    expect(updated[0].action).toBe('pick');
    expect(updated[2].action).toBe('pick');
  });

  it('attaches a message to the targeted entry', () => {
    const updated = setMessage(plan(), 2, 'new message');
    expect(updated[2].message).toBe('new message');
    expect(updated[1].message).toBe('');
  });

  it('leaves the original plan untouched', () => {
    const original = plan();
    setAction(original, 0, 'drop');
    setMessage(original, 0, 'x');
    expect(original[0]).toEqual({ sha: A, summary: 'first', action: 'pick', message: '' });
  });
});

describe('validate', () => {
  it('accepts an all-pick plan', () => {
    expect(validate(plan())).toEqual([]);
  });

  it('rejects squash as the first entry', () => {
    const errors = validate(setAction(plan(), 0, 'squash'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'squash'");
  });

  it('rejects fixup as the first entry', () => {
    expect(validate(setAction(plan(), 0, 'fixup'))).toHaveLength(1);
  });

  it('rejects squash as the first kept entry when earlier entries are dropped', () => {
    const p = setAction(setAction(plan(), 0, 'drop'), 1, 'squash');
    expect(validate(p)).toHaveLength(1);
  });

  it('accepts squash later in the plan', () => {
    expect(validate(setAction(plan(), 1, 'squash'))).toEqual([]);
  });

  it('rejects a plan where every entry is dropped', () => {
    let p = plan();
    for (let i = 0; i < p.length; i++) p = setAction(p, i, 'drop');
    expect(validate(p)).toEqual(['At least one commit must not be dropped.']);
  });
});

describe('toRebaseEntries', () => {
  it('serializes actions and shas in order', () => {
    expect(toRebaseEntries(plan())).toEqual([
      { action: 'pick', sha: A, summary: 'first' },
      { action: 'pick', sha: B, summary: 'second' },
      { action: 'pick', sha: C, summary: 'third' },
    ]);
  });

  it('attaches the message for reword and squash entries', () => {
    let p = setAction(plan(), 1, 'reword');
    p = setMessage(p, 1, 'reworded');
    p = setAction(p, 2, 'squash');
    p = setMessage(p, 2, 'squashed');
    const entries = toRebaseEntries(p);
    expect(entries[1]).toEqual({ action: 'reword', sha: B, summary: 'second', message: 'reworded' });
    expect(entries[2]).toEqual({ action: 'squash', sha: C, summary: 'third', message: 'squashed' });
  });

  it('omits messages for actions that do not consume them', () => {
    let p = setMessage(plan(), 0, 'ignored');
    p = setAction(p, 1, 'fixup');
    p = setMessage(p, 1, 'also ignored');
    const entries = toRebaseEntries(p);
    expect(entries[0].message).toBeUndefined();
    expect(entries[1].message).toBeUndefined();
  });

  it('omits blank reword messages', () => {
    let p = setAction(plan(), 0, 'reword');
    p = setMessage(p, 0, '   ');
    expect(toRebaseEntries(p)[0].message).toBeUndefined();
  });
});

describe('sha7', () => {
  it('shortens a full sha to seven characters', () => {
    expect(sha7(A)).toBe('aaaaaaa');
  });
});
