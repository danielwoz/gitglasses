// Open revision documents follow the repository: after a commit, checkout,
// reset or stash, a "HEAD" document (the left side of Open Changes with
// HEAD, a quick diff original) is read again, and after an engine restart a
// document still reads the repository it was opened for.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => import('./support/fakeVscode'));

import { controls } from './support/fakeVscode';
import {
  RevisionContentProvider,
  decodeRevisionUri,
  encodeRevisionUri,
  setRevisionRootLookup,
} from '../src/scm/revisionContentProvider';
import { isFixedRevision } from '../src/scm/revisionLogic';

const SHA = 'a'.repeat(40);

describe('isFixedRevision', () => {
  it('holds for full object ids and their ancestors', () => {
    expect(isFixedRevision(SHA)).toBe(true);
    expect(isFixedRevision('b'.repeat(64))).toBe(true);
    expect(isFixedRevision(`${SHA}~1`)).toBe(true);
    expect(isFixedRevision(`${SHA}^2`)).toBe(true);
    expect(isFixedRevision(`${SHA.toUpperCase()}^`)).toBe(true);
  });

  it('does not hold for anything that can come to name other content', () => {
    for (const rev of ['HEAD', 'HEAD~1', 'main', 'v1.0', ':0', ':', 'abc1234', 'main@{1}']) {
      expect(isFixedRevision(rev), rev).toBe(false);
    }
  });
});

describe('revision uris', () => {
  afterEach(() => setRevisionRootLookup(undefined));

  it('record the repository root when it is known', () => {
    setRevisionRootLookup((repoId) => (repoId === 'r1' ? '/w/repo' : undefined));
    const uri = encodeRevisionUri('r1', 'src/a.ts', 'HEAD');
    expect(decodeRevisionUri(uri)).toEqual({
      repoId: 'r1',
      relativePath: 'src/a.ts',
      rev: 'HEAD',
      root: '/w/repo',
    });
    expect(decodeRevisionUri(encodeRevisionUri('r9', 'a', 'HEAD'))?.root).toBeUndefined();
  });
});

function fakeEngine(contents: () => string) {
  const requests: Array<{ repoId: string; path: string; rev: string }> = [];
  return {
    requests,
    engine: {
      async request(_method: string, params: { repoId: string; path: string; rev: string }) {
        requests.push(params);
        return { contents: contents() };
      },
    },
  };
}

describe('RevisionContentProvider', () => {
  beforeEach(() => {
    controls.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    setRevisionRootLookup(undefined);
  });

  function open(...uris: vscode.Uri[]): void {
    controls.openDocuments = uris.map((uri) => ({ uri }) as never);
  }

  it('re-reads the moved documents of the changed repository once a burst settles', async () => {
    const { engine } = fakeEngine(() => '');
    const provider = new RevisionContentProvider(engine as never);
    const fired: string[] = [];
    provider.onDidChange((uri) => fired.push(uri.toString()));

    const head = encodeRevisionUri('r1', 'a.txt', 'HEAD');
    const index = encodeRevisionUri('r1', 'a.txt', ':0');
    const fixed = encodeRevisionUri('r1', 'a.txt', SHA);
    const otherRepo = encodeRevisionUri('r2', 'a.txt', 'HEAD');
    open(head, index, fixed, otherRepo);

    provider.refreshMoved('r1');
    provider.refreshMoved('r1');
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(fired).toEqual([head.toString(), index.toString()]);
  });

  it('re-reads every moved document when no repository is named', async () => {
    const { engine } = fakeEngine(() => '');
    const provider = new RevisionContentProvider(engine as never);
    const fired: string[] = [];
    provider.onDidChange((uri) => fired.push(uri.toString()));
    const one = encodeRevisionUri('r1', 'a.txt', 'HEAD');
    const two = encodeRevisionUri('r2', 'b.txt', 'main');
    open(one, two, encodeRevisionUri('r2', 'b.txt', SHA));

    provider.refreshMoved();
    await vi.advanceTimersByTimeAsync(200);
    expect(fired).toEqual([one.toString(), two.toString()]);
  });

  it('re-reads fixed documents too after an engine restart', async () => {
    const { engine } = fakeEngine(() => '');
    const provider = new RevisionContentProvider(engine as never);
    const fired: string[] = [];
    provider.onDidChange((uri) => fired.push(uri.toString()));
    const fixed = encodeRevisionUri('r1', 'a.txt', SHA);
    open(fixed);

    provider.refreshAll();
    await vi.advanceTimersByTimeAsync(200);
    expect(fired).toEqual([fixed.toString()]);
  });

  it('serves a document from the repository at its root, whatever id that root has now', async () => {
    const { engine, requests } = fakeEngine(() => 'committed\n');
    setRevisionRootLookup(() => '/w/repo');
    const uri = encodeRevisionUri('r1', 'a.txt', 'HEAD');
    // After a restart the same root is registered as r7, and r1 is another
    // repository.
    const provider = new RevisionContentProvider(engine as never, (root) =>
      root === '/w/repo' ? 'r7' : undefined,
    );

    expect(await provider.provideTextDocumentContent(uri, {} as never)).toBe('committed\n');
    expect(requests).toEqual([{ repoId: 'r7', path: 'a.txt', rev: 'HEAD' }]);
  });

  it('matches a document to the changed repository by its root', async () => {
    const { engine } = fakeEngine(() => '');
    setRevisionRootLookup(() => '/w/repo');
    const uri = encodeRevisionUri('r1', 'a.txt', 'HEAD');
    const provider = new RevisionContentProvider(engine as never, () => 'r7');
    const fired: string[] = [];
    provider.onDidChange((changed) => fired.push(changed.toString()));
    open(uri);

    provider.refreshMoved('r1');
    await vi.advanceTimersByTimeAsync(200);
    expect(fired).toEqual([]);
    provider.refreshMoved('r7');
    await vi.advanceTimersByTimeAsync(200);
    expect(fired).toEqual([uri.toString()]);
  });
});
