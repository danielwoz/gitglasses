// Quick diff and unsaved-buffer overlays for a file in a submodule must
// address the submodule even when the enclosing repository is already known
// and the file's directory has not been looked up yet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => import('./support/fakeVscode'));

import { controls, textDocument, Uri } from './support/fakeVscode';
import { fakeEngine } from './support/fakeEngine';
import { RepositoryService } from '../src/model/repositoryService';
import { GitGlassesQuickDiffProvider } from '../src/scm/quickDiffProvider';
import { decodeRevisionUri } from '../src/scm/revisionContentProvider';
import { DocumentSync } from '../src/engine/documentSync';

const layout = () => [
  { id: 'r1', root: '/w/parent', match: '/w/parent' },
  { id: 'r2', root: '/w/parent/sub', match: '/w/parent/sub' },
];

async function knownParent() {
  const fake = fakeEngine(layout());
  const repos = new RepositoryService(fake.engine, { caseInsensitive: false });
  await repos.locateOrDiscover(Uri.file('/w/parent/a.txt') as unknown as vscode.Uri);
  return { ...fake, repos };
}

describe('files in a repository nested in a known one', () => {
  beforeEach(() => controls.reset());
  afterEach(() => vi.useRealTimers());

  it('takes the quick diff original from the inner repository', async () => {
    const { repos } = await knownParent();
    const provider = new GitGlassesQuickDiffProvider(repos);

    const original = await provider.provideOriginalResource(
      Uri.file('/w/parent/sub/lib.txt') as unknown as vscode.Uri,
    );
    expect(original && decodeRevisionUri(original)).toEqual({
      repoId: 'r2',
      relativePath: 'lib.txt',
      rev: 'HEAD',
    });
  });

  it('sends unsaved contents to the inner repository', async () => {
    vi.useFakeTimers();
    const { repos, notifications } = await knownParent();
    const sync = new DocumentSync(
      {
        notify: (method: string, params: unknown) => notifications.push({ method, params }),
      } as never,
      repos,
    );
    try {
      controls.documentChanged.fire({
        document: textDocument('/w/parent/sub/lib.txt', 'edited\n', 7),
      });
      await vi.advanceTimersByTimeAsync(200);

      expect(notifications).toEqual([
        {
          method: 'doc/didChange',
          params: { repoId: 'r2', path: 'lib.txt', contents: 'edited\n', version: 7 },
        },
      ]);
    } finally {
      sync.dispose();
    }
  });

  it('sends nothing for a document saved while its repository was looked up', async () => {
    vi.useFakeTimers();
    const { engine, repos, notifications } = await knownParent();
    // The engine answers for the submodule only when released.
    let release = (): void => undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const request = engine.request.bind(engine);
    engine.request = (async (...args: Parameters<typeof request>) => {
      await answered;
      return request(...args);
    }) as typeof engine.request;
    const sync = new DocumentSync(
      {
        notify: (method: string, params: unknown) => notifications.push({ method, params }),
      } as never,
      repos,
    );
    try {
      const document = textDocument('/w/parent/sub/lib.txt', 'edited\n');
      controls.documentChanged.fire({ document });
      await vi.advanceTimersByTimeAsync(200);
      document.isDirty = false;
      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(notifications).toEqual([]);
    } finally {
      sync.dispose();
    }
  });
});
