// Trailers are listed under a commit's message in the details views, so the
// message leaves out the paragraph they were parsed from, and only that one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitDetails } from '@gitglasses/protocol';
import { bodyWithoutTrailers, trailerBlock, type Trailer } from '../src/system/trailers';
import { renderDetails } from '../webviews-src/graph/details';
import { FakeElement, fakeDocument } from './support/fakeDom';

const SIGNED: Trailer = { key: 'Signed-off-by', value: 'Ada Lovelace <ada@example.com>' };
const COAUTHOR: Trailer = { key: 'Co-authored-by', value: 'Grace Hopper <grace@example.com>' };

describe('bodyWithoutTrailers', () => {
  it('leaves out the closing paragraph the trailers were parsed from', () => {
    const body = [
      'Read trailers the way git does.',
      '',
      'Signed-off-by: Ada Lovelace <ada@example.com>',
      'Co-authored-by: Grace Hopper <grace@example.com>',
    ].join('\n');
    expect(bodyWithoutTrailers(body, [SIGNED, COAUTHOR])).toBe('Read trailers the way git does.');
  });

  it('keeps text that only looks like a trailer earlier in the body', () => {
    const body = [
      'Fixes: the parser, which dropped the last line.',
      'Reported-by: nobody in particular',
      '',
      'Signed-off-by: Ada Lovelace <ada@example.com>',
    ].join('\n');
    expect(bodyWithoutTrailers(body, [SIGNED])).toBe(
      'Fixes: the parser, which dropped the last line.\nReported-by: nobody in particular',
    );
  });

  it('keeps the body whole when its closing paragraph is not the trailers reported', () => {
    const body = 'Prose.\n\nSigned-off-by: Ada Lovelace <ada@example.com>';
    // No trailers parsed: nothing is taken for one.
    expect(bodyWithoutTrailers(body, [])).toBe(body);
    // A different value, or a trailer the engine did not report.
    expect(bodyWithoutTrailers(body, [{ key: 'Signed-off-by', value: 'Someone Else' }])).toBe(body);
    expect(bodyWithoutTrailers(`${body}\nAcked-by: Grace`, [SIGNED])).toBe(
      `${body}\nAcked-by: Grace`,
    );
    // The trailers came from before a closing paragraph that holds none.
    const after = 'Prose.\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n\n---\nnot a trailer';
    expect(bodyWithoutTrailers(after, [SIGNED])).toBe(after);
  });

  it('keeps lines among the trailers that are not trailers', () => {
    const body = [
      'Backport the fix.',
      '',
      '(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)',
      'Signed-off-by: Ada Lovelace <ada@example.com>',
    ].join('\n');
    expect(bodyWithoutTrailers(body, [SIGNED])).toBe(
      'Backport the fix.\n\n(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)',
    );
  });

  it('takes continuation lines and CRLF line endings with their trailer', () => {
    const body = 'Prose.\r\n\r\nCo-authored-by: Grace Hopper\r\n <grace@example.com>\r\n';
    const wrapped: Trailer = { key: 'Co-authored-by', value: 'Grace Hopper\n <grace@example.com>' };
    expect(bodyWithoutTrailers(body, [wrapped])).toBe('Prose.');
    expect(trailerBlock(body, [wrapped])).toEqual({
      start: 2,
      lines: [{ text: 'Co-authored-by: Grace Hopper\n <grace@example.com>', trailer: true }],
    });
  });

  it('leaves nothing when the body is only trailers', () => {
    expect(bodyWithoutTrailers('Signed-off-by: Ada Lovelace <ada@example.com>', [SIGNED])).toBe('');
  });
});

describe('commit details view', () => {
  beforeEach(() => {
    vi.stubGlobal('document', fakeDocument);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function details(body: string, trailers: Trailer[]): CommitDetails {
    const who = { name: 'Ada Lovelace', email: 'ada@example.com', time: 1_750_000_000 };
    return {
      sha: 'a'.repeat(40),
      parents: ['b'.repeat(40)],
      author: who,
      committer: who,
      subject: 'Read trailers the way git does',
      body,
      trailers,
      refs: [],
      files: [],
      stats: { files: 0, additions: 0, deletions: 0 },
      truncated: false,
    };
  }

  function render(body: string, trailers: Trailer[]): FakeElement {
    const root = new FakeElement('main');
    renderDetails(
      root as unknown as HTMLElement,
      { kind: 'commit', details: details(body, trailers) },
      { post: () => undefined, canMutate: false },
    );
    return root;
  }

  it('shows each trailer once, under the message', () => {
    const root = render(
      'Fixes: a line that only looks like a trailer.\n\n' +
        'Signed-off-by: Ada Lovelace <ada@example.com>\n' +
        'Co-authored-by: Grace Hopper <grace@example.com>',
      [SIGNED, COAUTHOR],
    );
    expect(root.querySelector('.details-message')?.outerHTML).toBe(
      '<div class="details-message">Fixes: a line that only looks like a trailer.</div>',
    );
    expect(root.querySelector('.details-trailers')?.outerHTML).toBe(
      '<dl class="details-trailers">' +
        '<dt>Signed-off-by</dt><dd>Ada Lovelace &lt;ada@example.com&gt;</dd>' +
        '<dt>Co-authored-by</dt><dd>Grace Hopper &lt;grace@example.com&gt;</dd>' +
        '</dl>',
    );
    expect(root.textContent.split('grace@example.com')).toHaveLength(2);
  });

  it('shows no message when the body is only trailers', () => {
    const root = render('Signed-off-by: Ada Lovelace <ada@example.com>', [SIGNED]);
    expect(root.querySelector('.details-message')).toBeNull();
    expect(root.byClass('details-trailers')).toHaveLength(1);
  });
});
