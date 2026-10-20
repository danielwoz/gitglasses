// The blame hover as VS Code receives it: the commit's message with its
// trailers one per line, the declared provenance, and the links.

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscode'));

import type { CommitDetails, CommitProvenance } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';
import { BlameHoverRenderer } from '../src/annotations/hoverProvider';
import type { FileBlame } from '../src/model/blameModel';

const SHA = 'a'.repeat(40);
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com', time: 1_750_000_000 };

const BODY = [
  'The parser read a Signed-off-by: in the middle of a',
  'sentence as a trailer.',
  '',
  'Signed-off-by: Ada Lovelace <ada@example.com>',
  'Reviewed-by: Grace Hopper',
  ' <grace@example.com>',
  'Co-authored-by: Agent <agent@example.com>',
].join('\n');

const DETAILS: CommitDetails = {
  sha: SHA,
  parents: [],
  author: ADA,
  committer: ADA,
  subject: 'Read trailers only at the end',
  body: BODY,
  trailers: [
    { key: 'Signed-off-by', value: 'Ada Lovelace <ada@example.com>' },
    { key: 'Reviewed-by', value: 'Grace Hopper\n <grace@example.com>' },
    { key: 'Co-authored-by', value: 'Agent <agent@example.com>' },
  ],
  refs: [],
  files: [],
  stats: { files: 1, additions: 2, deletions: 1 },
  truncated: false,
};

const PROVENANCE: CommitProvenance = {
  declared: 'agent',
  declarations: [
    {
      source: 'trailer',
      kind: 'agent',
      name: 'Agent',
      via: 'Co-authored-by',
      value: 'Agent <agent@example.com>',
    },
  ],
};

const BLAME: FileBlame = {
  hunks: [{ sha: SHA, resultLine: 1, originalLine: 1, lineCount: 2, path: 'src/parser.ts' }],
  commits: { [SHA]: { author: ADA, committer: ADA, summary: DETAILS.subject, boundary: false } },
  totalLines: 2,
  lfs: false,
};

async function hover(details: CommitDetails): Promise<string> {
  const engine = { request: async () => details } as unknown as EngineClient;
  const renderer = new BlameHoverRenderer(engine, { provenance: async () => PROVENANCE });
  const markdown = await renderer.render(
    BLAME,
    {
      documentUri: 'file:///repo/src/parser.ts',
      repoId: 'r1',
      rootPath: '/repo',
      relativePath: 'src/parser.ts',
    },
    1,
  );
  return (markdown as unknown as { value: string }).value;
}

describe('blame hover message', () => {
  it('keeps each trailer on a line of its own', async () => {
    const [message, links] = (await hover(DETAILS)).split('\n\n---\n\n');
    // The author line carries dates, which depend on the clock and locale.
    expect(message.split('\n\n').slice(1)).toEqual([
      '**Read trailers only at the end**',
      'The parser read a Signed\\-off\\-by: in the middle of a sentence as a trailer\\.',
      'Signed\\-off\\-by: Ada Lovelace \\<ada@example\\.com\\>  \n' +
        'Reviewed\\-by: Grace Hopper \\<grace@example\\.com\\>  \n' +
        'Co\\-authored\\-by: Agent \\<agent@example\\.com\\>',
      '`aaaaaaa` · 1 file changed, +2 −1',
      '$(sparkle) **AI\\-assisted** (declared via Co\\-authored\\-by: Agent)',
    ]);
    expect(links).toContain('$(question) Why this line?');
    expect(links).toContain('command:gitglasses.showLineStory?');
  });

  it('reflows a closing paragraph that is not the trailers', async () => {
    const message = (
      await hover({ ...DETAILS, body: 'First line\nSigned-off-by: someone', trailers: [] })
    ).split('\n\n')[2];
    expect(message).toBe('First line Signed\\-off\\-by: someone');
  });
});
