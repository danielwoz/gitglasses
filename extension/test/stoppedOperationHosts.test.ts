// The commit graph's merge and the interactive rebase editor when git stops
// half-way for a reason other than conflicts (here a signing failure): the
// failure offers the steps that finish or abandon the operation, not a bare
// error.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const webview = vi.hoisted(() => ({
  handler: undefined as ((message: unknown) => Promise<void>) | undefined,
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
        webview: {
          html: '',
          cspSource: 'vscode-webview:',
          asWebviewUri: (uri: unknown) => uri,
          postMessage: async () => true,
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
import { GraphWebviewHost } from '../src/webviews/graphHost';
import { RebaseWebviewHost } from '../src/webviews/rebaseHost';
import { setActiveRepoResolver } from '../src/views/viewBase';
import { configureSync } from '../src/sync/syncCommands';

const SHA = 'a'.repeat(40);

function engine(failing: string, operation: 'merge' | 'rebase') {
  const answers: Record<string, () => unknown> = {
    'status/summary': () => ({ conflicted: [] }),
    'repo/state': () => ({ head: { branch: 'main', detached: false } }),
    'rebase/preview': () => ({ entries: [{ sha: SHA, summary: 'work' }] }),
    [failing]: () => {
      throw new EngineError(
        ErrorCodes.GitError,
        `git ${operation} failed (128): error: gpg failed to sign the data`,
        { kind: 'signing', operation },
      );
    },
  };
  return {
    capabilities: () => ({ gitCli: true, watch: true, threads: true }),
    onNotification: () => ({ dispose: () => undefined }),
    async request(method: string) {
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
  configureSync({ log: () => undefined, showLog: () => undefined });
  setActiveRepoResolver(async () => ({ repoId: 'r1', rootPath: '/work/repo' }) as never);
});

describe('an operation stopped half-way outside Home and the palette', () => {
  it('the graph offers to continue or abort a merge that could not be signed', async () => {
    const host = new GraphWebviewHost(
      context,
      engine('mutate/merge', 'merge') as never,
      {} as never,
      () => undefined,
    );
    await host.show();
    ui.messageChoices.push('Proceed');
    await webview.handler!({ type: 'action', action: 'merge', shas: [SHA] });
    await vi.waitFor(() => expect(ui.messages.some((m) => m.level === 'error')).toBe(true));
    const error = ui.messages.find((m) => m.level === 'error')!;
    expect(error.text).toContain('could not be signed');
    expect(error.buttons).toEqual(['Continue', 'Abort Merge', 'Show Log']);
    host.dispose();
  });

  it('the rebase editor offers to continue, skip or abort a rebase that could not be signed', async () => {
    const host = new RebaseWebviewHost(
      context,
      engine('rebase/start', 'rebase') as never,
      {} as never,
    );
    await host.open('main');
    ui.messageChoices.push('Proceed');
    await webview.handler!({
      type: 'start',
      plan: [{ action: 'pick', sha: SHA, summary: 'work' }],
    });
    await vi.waitFor(() => expect(ui.messages.some((m) => m.level === 'error')).toBe(true));
    const error = ui.messages.find((m) => m.level === 'error')!;
    expect(error.buttons).toEqual(['Continue', 'Skip Commit', 'Abort Rebase', 'Show Log']);
    host.dispose();
  });
});
