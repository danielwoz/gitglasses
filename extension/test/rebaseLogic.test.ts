import { describe, expect, it } from 'vitest';
import {
  PLAN_ACTIONS,
  actionForKey,
  autosquash,
  hasAutosquashCandidates,
  isStalePlanRefusal,
  mergePlan,
  move,
  planFromPreview,
  setAction,
  setMessage,
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

describe('planFromPreview with actions', () => {
  it('keeps the actions a prepared todo already has', () => {
    expect(
      planFromPreview([
        { sha: A, summary: 'first' },
        { sha: B, summary: 'fixup! first', action: 'fixup' },
      ]).map((entry) => entry.action),
    ).toEqual(['pick', 'fixup']);
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

  it('rejects a reword without a message, which would silently do nothing', () => {
    const p = setAction(plan(), 1, 'reword');
    expect(validate(p)).toEqual([
      'Enter the new message for bbbbbbb, or pick instead of reword.',
    ]);
    expect(validate(setMessage(p, 1, '   '))).toHaveLength(1);
    expect(validate(setMessage(p, 1, 'second, reworded'))).toEqual([]);
  });

  it('leaves reword messages to git for a todo handed back to it', () => {
    expect(validate(setAction(plan(), 1, 'reword'), { messages: false })).toEqual([]);
  });

  it('accepts a squash without a message: git combines the messages', () => {
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

describe('edit and keyboard actions', () => {
  it('offers edit, which stops the rebase after the commit', () => {
    expect(PLAN_ACTIONS).toContain('edit');
    expect(toRebaseEntries(setAction(plan(), 1, 'edit'))[1]).toEqual({
      action: 'edit',
      sha: B,
      summary: 'second',
    });
  });

  it("maps git's todo letters to actions", () => {
    expect(actionForKey('p')).toBe('pick');
    expect(actionForKey('R')).toBe('reword');
    expect(actionForKey('e')).toBe('edit');
    expect(actionForKey('s')).toBe('squash');
    expect(actionForKey('f')).toBe('fixup');
    expect(actionForKey('d')).toBe('drop');
    expect(actionForKey('x')).toBeUndefined();
  });
});

describe('mergePlan', () => {
  it('keeps choices for commits still on the branch and appends new ones', () => {
    let edited = move(plan(), 2, 0);
    edited = setAction(edited, 0, 'reword');
    edited = setMessage(edited, 0, 'third, reworded');
    edited = setAction(edited, 2, 'drop');
    const D = 'd'.repeat(40);
    const merged = mergePlan(edited, [
      { sha: A, summary: 'first' },
      { sha: C, summary: 'third (amended)' },
      { sha: D, summary: 'fourth' },
    ]);
    expect(merged).toEqual([
      { sha: C, summary: 'third (amended)', action: 'reword', message: 'third, reworded' },
      { sha: A, summary: 'first', action: 'pick', message: '' },
      { sha: D, summary: 'fourth', action: 'pick', message: '' },
    ]);
  });
});

describe('autosquash', () => {
  const D = 'd'.repeat(40);
  const E = 'e'.repeat(40);
  function withFixups() {
    return planFromPreview([
      { sha: A, summary: 'add parser' },
      { sha: B, summary: 'add lexer' },
      { sha: C, summary: 'fixup! add parser' },
      { sha: D, summary: 'squash! add lexer' },
      { sha: E, summary: 'fixup! fixup! add parser' },
    ]);
  }

  it('moves fixup!/squash! commits under the commit they name', () => {
    expect(hasAutosquashCandidates(withFixups())).toBe(true);
    expect(hasAutosquashCandidates(autosquash(withFixups()))).toBe(false);
    expect(autosquash(withFixups()).map((entry) => [entry.summary, entry.action])).toEqual([
      ['add parser', 'pick'],
      ['fixup! add parser', 'fixup'],
      ['fixup! fixup! add parser', 'fixup'],
      ['add lexer', 'pick'],
      ['squash! add lexer', 'squash'],
    ]);
  });

  it('matches a sha prefix or a subject prefix the way git does', () => {
    const p = planFromPreview([
      { sha: A, summary: 'add parser for frames' },
      { sha: B, summary: 'fixup! aaaaaaa' },
      { sha: C, summary: 'fixup! add parser' },
    ]);
    expect(autosquash(p).map((entry) => entry.sha)).toEqual([A, B, C]);
    expect(autosquash(p).map((entry) => entry.action)).toEqual(['pick', 'fixup', 'fixup']);
  });

  it('leaves commits whose target is not in the plan alone', () => {
    const p = planFromPreview([
      { sha: A, summary: 'fixup! something upstream' },
      { sha: B, summary: 'second' },
    ]);
    expect(hasAutosquashCandidates(p)).toBe(false);
    expect(autosquash(p)).toEqual(p);
  });
});

describe('isStalePlanRefusal', () => {
  it("recognises each of the engine's out-of-date plan refusals", () => {
    for (const message of [
      'the branch moved since the rebase plan was made (HEAD was 1111111, is now 2222222); reload the plan',
      "'origin/main' moved since the rebase plan was made (it was 1111111, is now 2222222); reload the plan",
      "rebase not started: the branch has 3333333 'late work', which the plan does not list; it was probably committed after the plan was made. Reload the plan so it is not lost.",
      "rebase not started: the plan lists 4444444 'merge', which git will not replay: it is a merge commit or its change is already upstream. Reload the plan.",
    ]) {
      expect(isStalePlanRefusal(message)).toBe(true);
    }
  });

  it('leaves other failures alone', () => {
    expect(
      isStalePlanRefusal('git rebase failed (1): error: cannot rebase: You have unstaged changes.'),
    ).toBe(false);
  });
});
