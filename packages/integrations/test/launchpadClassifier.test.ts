import { describe, expect, it } from 'vitest';
import { classify, groupItems } from '../src/launchpadClassifier.js';
import { makePr } from './helpers.js';

const viewer = 'alice';

describe('classify', () => {
  it('classifies drafts', () => {
    expect(classify(makePr({ draft: true }), viewer)).toBe('draft');
  });

  it('classifies failing checks as blocked', () => {
    expect(classify(makePr({ checksStatus: 'failing' }), viewer)).toBe('blocked');
  });

  it('classifies merge conflicts as blocked', () => {
    expect(classify(makePr({ mergeable: 'conflicts' }), viewer)).toBe('blocked');
  });

  it('classifies review requests from the viewer', () => {
    expect(
      classify(
        makePr({ author: { id: 'bob', username: 'bob' }, reviewRequestedFromViewer: true }),
        viewer
      )
    ).toBe('needs-your-review');
  });

  it("classifies changes requested on the viewer's own PR", () => {
    expect(classify(makePr({ reviewDecision: 'changes_requested' }), viewer)).toBe(
      'changes-requested'
    );
  });

  it('does not use changes-requested when the viewer is not the author', () => {
    expect(
      classify(
        makePr({ author: { id: 'bob', username: 'bob' }, reviewDecision: 'changes_requested' }),
        viewer
      )
    ).toBe('waiting');
  });

  it('classifies approved+passing+mergeable as mergeable', () => {
    expect(
      classify(
        makePr({ reviewDecision: 'approved', checksStatus: 'passing', mergeable: 'mergeable' }),
        viewer
      )
    ).toBe('mergeable');
  });

  it('approved but pending checks is waiting', () => {
    expect(
      classify(
        makePr({ reviewDecision: 'approved', checksStatus: 'pending', mergeable: 'mergeable' }),
        viewer
      )
    ).toBe('waiting');
  });

  it('defaults to waiting', () => {
    expect(classify(makePr(), viewer)).toBe('waiting');
  });

  it('draft takes precedence over blocked', () => {
    expect(classify(makePr({ draft: true, checksStatus: 'failing' }), viewer)).toBe('draft');
  });

  it('blocked takes precedence over needs-your-review', () => {
    expect(
      classify(
        makePr({
          author: { id: 'bob', username: 'bob' },
          checksStatus: 'failing',
          reviewRequestedFromViewer: true,
        }),
        viewer
      )
    ).toBe('blocked');
  });

  it('needs-your-review takes precedence over mergeable', () => {
    expect(
      classify(
        makePr({
          author: { id: 'bob', username: 'bob' },
          reviewRequestedFromViewer: true,
          reviewDecision: 'approved',
          checksStatus: 'passing',
          mergeable: 'mergeable',
        }),
        viewer
      )
    ).toBe('needs-your-review');
  });
});

describe('groupItems', () => {
  it('returns non-empty groups in launchpad order with newest items first', () => {
    const blocked = makePr({ id: 'b', checksStatus: 'failing' });
    const draft = makePr({ id: 'd', draft: true });
    const waitingOld = makePr({ id: 'w1', updatedAt: '2026-07-01T00:00:00Z' });
    const waitingNew = makePr({ id: 'w2', updatedAt: '2026-07-10T00:00:00Z' });
    const groups = groupItems([waitingOld, draft, blocked, waitingNew], viewer);
    expect(groups.map((g) => g.bucket)).toEqual(['blocked', 'waiting', 'draft']);
    const waiting = groups.find((g) => g.bucket === 'waiting');
    expect(waiting?.items.map((pr) => pr.id)).toEqual(['w2', 'w1']);
  });

  it('returns an empty list for no PRs', () => {
    expect(groupItems([], viewer)).toEqual([]);
  });
});
