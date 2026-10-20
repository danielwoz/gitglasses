// Which buffer the engine holds for an edited document, and which contents a
// blame of it asks for.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => import('./support/fakeVscode'));

import { controls, textDocument, Uri, type FakeTextDocument } from './support/fakeVscode';
import { fakeEngine } from './support/fakeEngine';
import { RepositoryService } from '../src/model/repositoryService';
import { DocumentSync, fitsBufferLimit, utf8ByteLength } from '../src/engine/documentSync';
import { BlameModel, type BlameKey } from '../src/model/blameModel';
import { DocumentBlameService } from '../src/annotations/documentBlame';
import { encodeRevisionUri } from '../src/scm/revisionContentProvider';

const asDocument = (doc: FakeTextDocument) => doc as unknown as vscode.TextDocument;

function setup(options: { maxBytes?: number } = {}) {
  const fake = fakeEngine([{ id: 'r1', root: '/w/repo', match: '/w/repo' }]);
  const repos = new RepositoryService(fake.engine, { caseInsensitive: false });
  const sync = new DocumentSync(fake.engine, repos, options);
  const sent = () =>
    fake.notifications.map((n) => `${n.method} ${String(n.params.version ?? '')}`.trim());
  return { ...fake, repos, sync, sent };
}

beforeEach(() => controls.reset());

describe('DocumentSync', () => {
  it('pushes an edited buffer once per version, when blame asks', async () => {
    const { sync, sent, notifications } = setup();
    const doc = textDocument('/w/repo/a.txt', 'one\n', 3);
    // Editing alone sends nothing.
    controls.documentChanged.fire({ document: doc });
    expect(sent()).toEqual([]);

    const [first, second] = await Promise.all([
      sync.sync(asDocument(doc)),
      sync.sync(asDocument(doc)),
    ]);
    expect(first).toEqual({ kind: 'buffer', version: 3 });
    expect(second).toEqual({ kind: 'buffer', version: 3 });
    expect(await sync.sync(asDocument(doc))).toEqual({ kind: 'buffer', version: 3 });
    expect(sent()).toEqual(['doc/didChange 3']);
    expect(notifications[0].params).toEqual({
      repoId: 'r1',
      path: 'a.txt',
      contents: 'one\n',
      version: 3,
    });

    doc.version = 4;
    expect(await sync.sync(asDocument(doc))).toEqual({ kind: 'buffer', version: 4 });
    expect(sent()).toEqual(['doc/didChange 3', 'doc/didChange 4']);
  });

  it('asks for the disk while the document is clean', async () => {
    const { sync, sent } = setup();
    const doc = textDocument('/w/repo/a.txt', 'one\n');
    doc.isDirty = false;
    expect(await sync.sync(asDocument(doc))).toEqual({ kind: 'disk' });
    expect(sent()).toEqual([]);
  });

  it('drops the buffer the moment the document matches the disk again', async () => {
    for (const settle of ['save', 'revert', 'close'] as const) {
      const { sync, sent } = setup();
      const doc = textDocument('/w/repo/a.txt', 'one\n', 2);
      await sync.sync(asDocument(doc));
      if (settle === 'save') {
        doc.isDirty = false;
        controls.documentSaved.fire(doc);
      } else if (settle === 'revert') {
        // Revert File and undo back to the saved text leave a clean buffer.
        doc.isDirty = false;
        controls.documentChanged.fire({ document: doc });
      } else {
        doc.isClosed = true;
        controls.documentClosed.fire(doc);
      }
      expect(sent(), settle).toEqual(['doc/didChange 2', 'doc/didClose']);
      sync.dispose();
    }
  });

  it('sends no close for a document it never pushed', () => {
    const { sent } = setup();
    const doc = textDocument('/w/repo/a.txt', 'one\n');
    doc.isDirty = false;
    controls.documentSaved.fire(doc);
    controls.documentClosed.fire(doc);
    expect(sent()).toEqual([]);
  });

  it('never sends a buffer over the engine limit, and drops a smaller one it holds', async () => {
    const { sync, sent } = setup({ maxBytes: 8 });
    const doc = textDocument('/w/repo/a.txt', 'small', 1);
    expect(await sync.sync(asDocument(doc))).toEqual({ kind: 'buffer', version: 1 });
    const big = { ...doc, version: 2, getText: () => 'much too large' };
    expect(await sync.sync(asDocument(big))).toEqual({ kind: 'tooLarge' });
    expect(await sync.sync(asDocument(big))).toEqual({ kind: 'tooLarge' });
    expect(sent()).toEqual(['doc/didChange 1', 'doc/didClose']);
  });

  it('pushes again after the engine lost the buffer', async () => {
    const { sync, sent } = setup();
    const doc = textDocument('/w/repo/a.txt', 'one\n', 5);
    await sync.sync(asDocument(doc));
    sync.forget(asDocument(doc));
    await sync.sync(asDocument(doc));
    sync.resync();
    await sync.sync(asDocument(doc));
    expect(sent()).toEqual(['doc/didChange 5', 'doc/didChange 5', 'doc/didChange 5']);
  });

  it('has nothing for documents outside a repository or the host', async () => {
    const { sync, sent } = setup();
    expect(await sync.sync(asDocument(textDocument('/elsewhere/a.txt', 'x')))).toEqual({
      kind: 'unavailable',
    });
    const untitled = {
      ...textDocument('/w/repo/b.txt', 'x'),
      uri: Uri.from({ scheme: 'untitled', path: 'b' }),
    };
    expect(await sync.sync(asDocument(untitled))).toEqual({ kind: 'unavailable' });
    expect(sent()).toEqual([]);
  });

  it('measures UTF-8 the way the engine counts bytes', () => {
    expect(utf8ByteLength('aé€😀')).toBe(1 + 2 + 3 + 4);
    expect(fitsBufferLimit('€€', 6)).toBe(true);
    expect(fitsBufferLimit('€€', 5)).toBe(false);
    expect(fitsBufferLimit('x'.repeat(10), 9)).toBe(false);
  });
});

describe('DocumentBlameService', () => {
  function blameSetup(answer: (key: BlameKey) => number | undefined) {
    const fake = setup();
    const asked: BlameKey[] = [];
    const model = {
      getBlame: vi.fn(async (key: BlameKey) => {
        asked.push(key);
        const version = answer(key);
        if (version !== undefined && version !== key.version) {
          const { StaleBlameError } = await import('../src/model/blameModel');
          throw new StaleBlameError(key.version, version);
        }
        return { hunks: [], commits: {}, totalLines: 0, lfs: false };
      }),
      invalidate: vi.fn(),
    } as unknown as BlameModel;
    const service = new DocumentBlameService(model, fake.repos, fake.sync);
    return { ...fake, asked, service };
  }

  it('blames an edited document at the version it pushed', async () => {
    const { service, asked, sent } = blameSetup((key) => key.version);
    const doc = textDocument('/w/repo/src/a.txt', 'one\n', 9);
    const result = await service.blameDocument(asDocument(doc));
    expect(result).toMatchObject({
      kind: 'blame',
      target: { repoId: 'r1', relativePath: 'src/a.txt' },
    });
    expect(asked).toEqual([
      {
        repoId: 'r1',
        path: 'src/a.txt',
        version: 9,
        options: { ignoreWhitespace: false, moves: 'off', ignoreRevs: true },
      },
    ]);
    expect(sent()).toEqual(['doc/didChange 9']);
  });

  it('pushes again and retries once when the engine answered for another buffer', async () => {
    let answers = [3, undefined];
    const { service, asked, sent } = blameSetup(() => answers.shift());
    const doc = textDocument('/w/repo/a.txt', 'one\n', 4);
    expect((await service.blameDocument(asDocument(doc))).kind).toBe('blame');
    expect(asked.map((k) => k.version)).toEqual([4, 4]);
    expect(sent()).toEqual(['doc/didChange 4', 'doc/didChange 4']);

    // A second stale answer is not chased further.
    answers = [3, 3, 3];
    doc.version = 5;
    expect((await service.blameDocument(asDocument(doc))).kind).toBe('none');
  });

  it('blames a revision document at its revision', async () => {
    const { service, asked, sent } = blameSetup(() => undefined);
    const uri = encodeRevisionUri('r1', 'src/a.txt', 'abc123^');
    const doc = { ...textDocument('/unused', 'x'), uri, isDirty: false };
    expect(await service.blameDocument(asDocument(doc))).toMatchObject({
      kind: 'blame',
      target: { repoId: 'r1', relativePath: 'src/a.txt', rev: 'abc123^' },
    });
    expect(asked[0]).toMatchObject({ rev: 'abc123^', version: -1 });
    expect(sent()).toEqual([]);
  });

  it('reports a paused blame for a buffer too large to push', async () => {
    const fake = setup({ maxBytes: 2 });
    const model = { getBlame: vi.fn(), invalidate: vi.fn() } as unknown as BlameModel;
    const service = new DocumentBlameService(model, fake.repos, fake.sync);
    const doc = textDocument('/w/repo/a.txt', 'longer', 2);
    expect(await service.blameDocument(asDocument(doc))).toMatchObject({ kind: 'tooLarge' });
    expect(model.getBlame).not.toHaveBeenCalled();
  });

  it('has no blame outside a repository', async () => {
    const { service, asked } = blameSetup(() => undefined);
    const doc = textDocument('/elsewhere/a.txt', 'x');
    expect(await service.blameDocument(asDocument(doc))).toEqual({ kind: 'none' });
    expect(asked).toEqual([]);
  });

  it('drops cached blame when an attribution setting changes', () => {
    const { service } = blameSetup(() => undefined);
    const model = (service as unknown as { model: BlameModel }).model;
    const fired = vi.fn();
    service.onDidChangeSettings(fired);
    controls.settings.set('gitglasses.blame.dateStyle', 'iso');
    controls.changeSettings('gitglasses.blame.dateStyle');
    expect(model.invalidate).not.toHaveBeenCalled();
    expect(service.settings.text.dateStyle).toBe('iso');
    controls.settings.set('gitglasses.blame.ignoreWhitespace', true);
    controls.changeSettings('gitglasses.blame.ignoreWhitespace');
    expect(model.invalidate).toHaveBeenCalledTimes(1);
    expect(service.settings.options.ignoreWhitespace).toBe(true);
    expect(fired).toHaveBeenCalledTimes(2);
  });
});
