import { describe, expect, it } from 'vitest';
import type { CommitDetails } from '@gitglasses/protocol';
import {
  fencedBlock,
  formatFileLines,
  fullMessage,
  renderCommitDetails,
} from '../src/commitDetails/commitDetailsLogic';

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f80912345678';
const PARENT = 'f0e1d2c3b4a5968778695a4b3c2d1e0f12345678';

function details(overrides: Partial<CommitDetails> = {}): CommitDetails {
  return {
    sha: SHA,
    parents: [PARENT],
    author: { name: 'Ada', email: 'ada@example.invalid', time: 1700000000 },
    committer: { name: 'Ada', email: 'ada@example.invalid', time: 1700000000 },
    subject: 'Add the frame parser',
    body: 'Reads frames.\n\nSigned-off-by: Ada <ada@example.invalid>',
    trailers: [{ key: 'Signed-off-by', value: 'Ada <ada@example.invalid>' }],
    refs: [
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'branch' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1.0', kind: 'tag' },
    ],
    files: [
      { path: 'src/parser.ts', status: 'A', additions: 12, deletions: 0, binary: false },
      {
        path: 'docs/new.md',
        origPath: 'docs/old.md',
        status: 'R',
        additions: 1,
        deletions: 1,
        binary: false,
      },
      { path: 'logo.png', status: 'M', additions: 0, deletions: 0, binary: true },
    ],
    stats: { files: 3, additions: 13, deletions: 1 },
    truncated: false,
    ...overrides,
  };
}

describe('renderCommitDetails', () => {
  it('renders the message, identity, refs, trailers and files', () => {
    expect(renderCommitDetails(details())).toBe(
      [
        '# Commit 1a2b3c4',
        '',
        '```text',
        'Add the frame parser',
        '',
        'Reads frames.',
        '',
        'Signed-off-by: Ada <ada@example.invalid>',
        '```',
        '',
        '## Details',
        '',
        '```text',
        `commit     ${SHA}`,
        `parents    ${PARENT}`,
        'author     Ada <ada@example.invalid>',
        'date       Tue, 14 Nov 2023 22:13:20 GMT',
        'refs       HEAD, main (branch), origin/main (remote), v1.0 (tag)',
        '```',
        '',
        '## Trailers',
        '',
        '```text',
        'Signed-off-by: Ada <ada@example.invalid>',
        '```',
        '',
        '## Changed files (3, +13 −1)',
        '',
        '```text',
        'A  src/parser.ts              +12 −0',
        'R  docs/old.md → docs/new.md  +1 −1',
        'M  logo.png                   binary',
        '```',
        '',
      ].join('\n'),
    );
  });

  it('shows the committer only where it differs from the author', () => {
    const text = renderCommitDetails(
      details({ committer: { name: 'Bob', email: 'bob@example.invalid', time: 1700000060 } }),
    );
    expect(text).toContain('committer  Bob <bob@example.invalid>');
    expect(text).toContain('committed  Tue, 14 Nov 2023 22:14:20 GMT');

    const rebased = renderCommitDetails(
      details({ committer: { name: 'Ada', email: 'ada@example.invalid', time: 1700000060 } }),
    );
    expect(rebased).not.toContain('committer  ');
    expect(rebased).toContain('committed  Tue, 14 Nov 2023 22:14:20 GMT');
  });

  it('handles a root commit with no body, trailers, refs or files', () => {
    const text = renderCommitDetails(
      details({
        parents: [],
        body: '',
        trailers: [],
        refs: [],
        files: [],
        stats: { files: 0, additions: 0, deletions: 0 },
      }),
    );
    expect(text).toContain('parents    (none)');
    expect(text).toContain('```text\nAdd the frame parser\n```');
    expect(text).not.toContain('## Trailers');
    expect(text).not.toContain('refs       ');
    expect(text).toContain('## Changed files (0, +0 −0)\n\nNo files changed.\n');
  });

  it('says when the file list is truncated', () => {
    const text = renderCommitDetails(
      details({ truncated: true, stats: { files: 2500, additions: 13, deletions: 1 } }),
    );
    expect(text).toContain('## Changed files (2500, +13 −1)');
    expect(text).toContain(
      'Only the first 3 of 2500 changed files are listed, and the line counts cover only those.',
    );
  });

  it('keeps repository text literal and inside its block', () => {
    const text = renderCommitDetails(
      details({
        subject: 'Close the fence ``` early',
        body: '````\n# not a heading\n![x](https://example.invalid/pixel.png)',
        author: { name: 'Eve\n# Injected', email: 'eve@example.invalid', time: 1700000000 },
        files: [{ path: 'a\nb.txt', status: 'A', additions: 1, deletions: 0, binary: false }],
      }),
    );
    // The message block's fence outruns the longest backtick run inside it.
    expect(text).toContain(
      '`````text\nClose the fence ``` early\n\n````\n# not a heading\n' +
        '![x](https://example.invalid/pixel.png)\n`````',
    );
    // Single-line values cannot break onto a line of their own.
    expect(text).toContain('author     Eve\\u000a# Injected <eve@example.invalid>');
    expect(text).toContain('A  a\\u000ab.txt  +1 −0');
  });
});

describe('commit details helpers', () => {
  it('builds the full message from subject and body', () => {
    expect(fullMessage({ subject: 'one', body: '' })).toBe('one');
    expect(fullMessage({ subject: 'one', body: 'two\nthree' })).toBe('one\n\ntwo\nthree');
  });

  it('fences text with at least three backticks', () => {
    expect(fencedBlock('plain')).toBe('```text\nplain\n```');
    expect(fencedBlock('a ```` b')).toBe('`````text\na ```` b\n`````');
  });

  it('aligns line counts up to a capped name width', () => {
    const long = 'x'.repeat(80);
    const lines = formatFileLines([
      { path: 'a', status: 'M', additions: 1, deletions: 2, binary: false },
      { path: long, status: 'A', additions: 3, deletions: 0, binary: false },
    ]);
    expect(lines[0]).toBe(`M  a${' '.repeat(59)}  +1 −2`);
    expect(lines[1]).toBe(`A  ${long}  +3 −0`);
  });
});
