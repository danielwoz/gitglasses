// The commit graph's merge and the interactive rebase editor when git stops
// half-way for a reason other than conflicts (here a signing failure): the
// graph offers the steps that finish or abandon the operation, and the rebase
// editor stays open on its paused panel, whose Continue, Skip and Abort run
// the rebase's next step, rather than showing a bare error.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const webview = vi.hoisted(() => ({
  handler: undefined as ((message: unknown) => Promise<void>) | undefined,
  posted: [] as Array<{ type: string } & Record<string, unknown>>,
}));

vi.mock('vscode', async () => {
  const fake = await import('./support/fakeVscodeUi');
  const none = () => ({ dispose: () => undefined });
  return {
    ...fake,
    ViewColumn: { Active: -1 },
    window: {
      ...fake.window,
      onDidChangeActiveColorTheme: none,
      createWebviewPanel: () => ({
        visible: true,
        webview: {
          html: '',
          cspSource: 'vscode-webview:',
          asWebviewUri: (uri: unknown) => uri,
          postMessage: async (message: { type: string }) => {
            webview.posted.push(message);
            return true;
          },
          onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
            webview.handler = handler;
            return { dispose: () => undefined };
          },
        },
        reveal: () => undefined,
        dispose: () => undefined,
        onDidDispose: none,
      }),
    },
  };
});

import * as vscode from 'vscode';
import { ui } from './support/fakeVscodeUi';
import { ErrorCodes } from '@gitglasses/protocol';
import { EngineError } from '@gitglasses/rpc';
import { runRowAction } from '../src/webviews/graphActions';
import { RebaseWebviewHost } from '../src/webviews/rebaseHost';
import { setActiveRepoResolver } from '../src/views/viewBase';
import { configureSync } from '../src/sync/syncCommands';

const SHA = 'a'.repeat(40);
const SIGNING_ERROR = 'error: gpg failed to sign the data';

/** An engine whose `failing` method stops `operation` with a signing failure,
 *  after which the repository reports that operation in progress. */
function engine(failing: string, operation: 'merge' | 'rebase') {
  let inProgress = false;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const answers: Record<string, () => unknown> = {
    'status/summary': () => ({ branch: 'main', staged: [], unstaged: [], conflicted: [] }),
    'repo/state': () => ({
      head: { branch: 'main', detached: false },
      sequencer: inProgress ? { operation, step: 1, total: 1 } : { operation: 'none' },
    }),
    'rebase/preview': () => ({
      entries: [{ sha: SHA, summary: 'work' }],
      headSha: SHA,
      upstreamSha: 'b'.repeat(40),
      mergeCount: 0,
    }),
    'rebase/continue': () => ({ completed: false, conflicts: false }),
    'rebase/skip': () => ({ completed: false, conflicts: false }),
    'rebase/abort': () => ({}),
    [failing]: () => {
      inProgress = true;
      throw new EngineError(
        ErrorCodes.GitError,
        `git ${operation} failed (128): ${SIGNING_ERROR}`,
        { kind: 'signing', operation },
      );
    },
  };
  return {
    requests,
    capabilities: () => ({ gitCli: true, watch: true, threads: true }),
    onNotification: () => ({ dispose: () => undefined }),
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      const answer = answers[method];
      if (!answer) throw new Error(`unexpected ${method}`);
      return answer();
    },
  };
}

const context = { extensionUri: vscode.Uri.file('/ext') } as never;

beforeEach(() => {
  ui.reset();
  webview.handler = undefined;
  webview.posted = [];
  configureSync({ log: () => undefined, showLog: () => undefined });
  setActiveRepoResolver(async () => ({ repoId: 'r1', rootPath: '/work/repo' }) as never);
});

describe('an operation stopped half-way outside Home and the palette', () => {
  it('the graph offers to continue or abort a merge that could not be signed', async () => {
    const fake = engine('mutate/merge', 'merge');
    ui.messageChoices.push('Proceed');
    await runRowAction(
      { engine: fake as never, repoId: 'r1', log: () => undefined, openRebase: vi.fn() },
      'merge',
      [SHA],
      new Map([[SHA, 'commit' as const]]),
    );
    await vi.waitFor(() => expect(ui.messages.some((m) => m.level === 'error')).toBe(true));
    const error = ui.messages.find((m) => m.level === 'error')!;
    expect(error.text).toContain('could not be signed');
    expect(error.buttons).toEqual(['Continue', 'Abort Merge', 'Show Log']);
  });

  it('the rebase editor offers to continue, skip or abort a rebase that could not be signed', async () => {
    const fake = engine('rebase/start', 'rebase');
    const host = new RebaseWebviewHost(context, fake as never, {} as never, () => undefined);
    await host.open('main');
    await webview.handler!({ type: 'ready' });
    ui.messageChoices.push('Proceed');
    await webview.handler!({
      type: 'start',
      plan: [{ action: 'pick', sha: SHA, summary: 'work' }],
    });

    // The editor turns to its paused panel with git's explanation; the stop
    // is not a conflict, and no error notification stands in for the panel.
    const paused = webview.posted.filter((message) => message.type === 'paused');
    expect(paused.at(-1)).toMatchObject({ conflicted: [], step: 1, total: 1 });
    expect(paused.at(-1)?.reason).not.toBe('conflicts');
    expect(String(paused.at(-1)?.error)).toContain(SIGNING_ERROR);
    expect(ui.messages.filter((m) => m.level === 'error')).toEqual([]);

    // The panel's Continue, Skip and Abort run those steps of the rebase.
    await webview.handler!({ type: 'continue' });
    await webview.handler!({ type: 'skip' });
    ui.messageChoices.push('Abort Rebase');
    await webview.handler!({ type: 'abort' });
    const steps = fake.requests
      .filter((request) => /^rebase\/(continue|skip|abort)$/.test(request.method))
      .map((request) => [request.method, request.params.repoId]);
    expect(steps).toEqual([
      ['rebase/continue', 'r1'],
      ['rebase/skip', 'r1'],
      ['rebase/abort', 'r1'],
    ]);
    host.dispose();
  });
});
