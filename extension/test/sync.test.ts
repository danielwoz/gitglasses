// Push, pull and fetch as Home and the palette run them: progress with
// Cancel, publishing to a remote the user picks, the merge-or-rebase choice
// for a diverged branch, and failures explained by what git said.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscodeUi'));

import { ui } from './support/fakeVscodeUi';
import { ErrorCodes } from '@gitglasses/protocol';
import { EngineError, type CancellationLike } from '@gitglasses/rpc';
import {
  describeFailure,
  divergedPullChoices,
  gitErrorData,
  gitMessage,
  operationActions,
} from '../src/sync/syncLogic';
import { configureSync, fetch, publish, pull, push, reportFailure } from '../src/sync/syncCommands';
import { showConflictGuidance } from '../src/commands/ui';

const repo = { repoId: 'r1', rootPath: '/work/repo' };

function gitError(message: string, data?: Record<string, unknown>): EngineError {
  return new EngineError(ErrorCodes.GitError, message, data);
}

type Responder = (params: Record<string, unknown>, token?: CancellationLike) => unknown;

/** An engine whose methods answer from scripted responders, recording calls. */
function engine(responders: Record<string, Responder | Responder[]>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fake = {
    calls,
    async request(method: string, params: Record<string, unknown>, token?: CancellationLike) {
      calls.push({ method, params });
      const entry = responders[method];
      const responder = Array.isArray(entry) ? entry.shift() : entry;
      if (!responder) throw new Error(`unexpected ${method}`);
      return responder(params, token);
    },
  };
  return fake;
}

const status = (upstream?: string) => () => ({
  branch: 'topic',
  upstream,
  ahead: 1,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
});

beforeEach(() => {
  ui.reset();
  configureSync({ log: () => undefined, showLog: () => undefined });
});

describe('failure presentation', () => {
  it('reads the kind of failure from the error data', () => {
    expect(gitErrorData(gitError('x', { kind: 'auth', host: 'h' }))).toEqual({
      kind: 'auth',
      host: 'h',
    });
    expect(gitErrorData(new Error('plain'))).toBeUndefined();
  });

  it("keeps git's words and drops the noise", () => {
    const error = gitError(
      "git push failed (128): error: unable to read askpass response from '/x/engine'\n" +
        "fatal: could not read Username for 'https://h': terminal prompts disabled\n",
    );
    expect(gitMessage(error)).toBe(
      "fatal: could not read Username for 'https://h': terminal prompts disabled",
    );
    expect(gitMessage(gitError('git pull failed (1): hint: do this\nfatal: stopped\n'))).toBe(
      'fatal: stopped',
    );
  });

  it('offers the next step that fits the failure', () => {
    const labels = (presentation: ReturnType<typeof describeFailure>) =>
      presentation.actions.map((action) => action.label);
    expect(describeFailure('Push', gitError('', { kind: 'rejected' })).actions[0].action).toBe(
      'pull',
    );
    expect(
      labels(
        describeFailure('Fetch', gitError('', { kind: 'auth', host: 'h' }), { canRetry: true }),
      ),
    ).toEqual(['Retry', 'Show Log']);
    expect(describeFailure('Push', gitError('', { kind: 'cancelled' })).silent).toBe(true);
    const signing = describeFailure(
      'Merge',
      gitError('git merge failed (128): error: gpg failed to sign the data', {
        kind: 'signing',
        operation: 'merge',
      }),
    );
    expect(signing.message).toContain('pinentry');
    expect(labels(signing)).toEqual(['Continue', 'Abort Merge', 'Show Log']);
    const empty = describeFailure(
      'Cherry-pick',
      gitError('', { kind: 'emptyCommit', operation: 'cherry-pick' }),
    );
    expect(labels(empty)).toEqual(['Skip Commit', 'Abort Cherry-pick', 'Show Log']);
    const stopped = describeFailure(
      'Revert',
      gitError('git revert failed (1): error: hook declined', {
        kind: 'stopped',
        operation: 'revert',
      }),
    );
    expect(stopped.message).toBe('Revert stopped: error: hook declined');
    expect(operationActions('none')).toEqual([]);
  });

  it('offers merge or rebase, once or for good, for a diverged branch', () => {
    expect(divergedPullChoices().map((choice) => [choice.strategy, choice.remember])).toEqual([
      ['merge', false],
      ['rebase', false],
      ['merge', true],
      ['rebase', true],
    ]);
  });
});

describe('push and publish', () => {
  it('pushes under a cancellable progress notification', async () => {
    const fake = engine({ 'status/summary': status('origin/topic'), 'mutate/push': () => ({}) });
    await push(fake as never, repo);
    expect(ui.progress).toEqual(["GitGlasses: Pushing 'topic'…"]);
    expect(fake.calls.map((call) => call.method)).toEqual(['status/summary', 'mutate/push']);
    expect(ui.status.at(-1)).toContain("Pushed 'topic'");
  });

  it('publishes a new branch to the remote the user picks when git names none', async () => {
    const fake = engine({
      'status/summary': status(undefined),
      'mutate/push': [
        () => {
          throw gitError("cannot publish 'topic': choose a remote", {
            kind: 'noRemote',
            remotes: ['fork', 'origin'],
          });
        },
        (params) => ({ remote: params.remote }),
      ],
      'remote/list': () => ({
        remotes: [
          { name: 'fork', fetchUrl: 'https://example.com/me/repo.git' },
          { name: 'origin', fetchUrl: 'https://example.com/org/repo.git' },
        ],
      }),
    });
    ui.quickPickChoices.push('fork');
    await push(fake as never, repo);
    const pushes = fake.calls.filter((call) => call.method === 'mutate/push');
    expect(pushes.map((call) => call.params)).toEqual([
      { repoId: 'r1', setUpstream: true, remote: undefined },
      { repoId: 'r1', setUpstream: true, remote: 'fork' },
    ]);
    expect(ui.shown[0].items?.map((item) => item.label)).toEqual(['fork', 'origin']);
    expect(ui.status.at(-1)).toContain("Published 'topic' to 'fork'");
  });

  it('asks for credentials itself when git refused the integration token', async () => {
    const refused: string[] = [];
    configureSync({
      log: () => undefined,
      showLog: () => undefined,
      askpass: {
        answeredFromIntegrationSince: () => refused.length === 0,
        refuseIntegrationFor: (host) => refused.push(host),
      },
    });
    const fake = engine({
      'status/summary': status('origin/topic'),
      'mutate/push': [
        () => {
          throw gitError('Authentication failed', { kind: 'auth', host: 'github.com' });
        },
        () => ({}),
      ],
    });
    await push(fake as never, repo);
    expect(refused).toEqual(['github.com']);
    expect(fake.calls.filter((call) => call.method === 'mutate/push')).toHaveLength(2);
    expect(ui.messages).toHaveLength(0);
  });

  it('says nothing alarming when the user cancelled', async () => {
    const fake = engine({
      'status/summary': status('origin/topic'),
      'mutate/push': () => {
        throw new EngineError(ErrorCodes.Cancelled, 'cancelled');
      },
    });
    await push(fake as never, repo);
    expect(ui.messages).toHaveLength(0);
    expect(ui.status.at(-1)).toContain('Push cancelled');
  });

  it('hands the progress cancellation to the engine request', async () => {
    let seen: CancellationLike | undefined;
    const fake = engine({
      'status/summary': status('origin/topic'),
      'mutate/push': (_params, token) => {
        seen = token;
        return {};
      },
    });
    await push(fake as never, repo);
    expect(seen?.isCancellationRequested).toBe(false);
    expect(typeof seen?.onCancellationRequested).toBe('function');
  });
});

describe('pull', () => {
  it('lets the user choose merge or rebase when the branches diverged', async () => {
    const fake = engine({
      'mutate/pull': [
        () => {
          throw gitError('Need to specify how to reconcile divergent branches', {
            kind: 'divergent',
          });
        },
        () => ({ conflicts: false }),
      ],
    });
    ui.quickPickChoices.push('Always Rebase in This Repository');
    await pull(fake as never, repo);
    expect(fake.calls.map((call) => call.params)).toEqual([
      { repoId: 'r1', autoStash: true },
      { repoId: 'r1', autoStash: true, strategy: 'rebase', remember: true },
    ]);
  });

  it('reports conflicts with the way to resolve them', async () => {
    const fake = engine({ 'mutate/pull': () => ({ conflicts: true }) });
    ui.messageChoices.push('Abort');
    await pull(fake as never, repo, { strategy: 'merge', remember: false });
    expect(ui.messages[0].level).toBe('warning');
    expect(ui.messages[0].buttons).toEqual(['Open Conflicts', 'Continue', 'Abort']);
    await vi.waitFor(() =>
      expect(ui.executed.map((call) => call.command)).toContain('gitglasses.abortOperation'),
    );
  });

  it('offers a pull when a push was rejected', async () => {
    const fake = engine({
      'status/summary': status('origin/topic'),
      'mutate/push': () => {
        throw gitError(' ! [rejected] topic -> topic (fetch first)', { kind: 'rejected' });
      },
    });
    ui.messageChoices.push('Pull');
    await push(fake as never, repo);
    expect(ui.messages[0].text).toContain('was rejected');
    expect(ui.executed.map((call) => call.command)).toContain('gitglasses.home.pull');
  });
});

describe('fetch', () => {
  it('retries from the failure notification', async () => {
    const fake = engine({
      'mutate/fetch': [
        () => {
          throw gitError('Could not resolve host', { kind: 'network', host: 'example.com' });
        },
        () => ({}),
      ],
    });
    ui.messageChoices.push('Retry');
    await fetch(fake as never, repo, false);
    expect(ui.messages[0].text).toBe('GitGlasses: Fetch failed: could not reach example.com.');
    expect(fake.calls).toHaveLength(2);
  });
});

describe('conflict guidance', () => {
  it('offers continue and abort only where an operation is left in progress', () => {
    showConflictGuidance('Stash apply');
    showConflictGuidance('Cherry-pick');
    expect(ui.messages.map((message) => message.buttons)).toEqual([
      ['Open Conflicts'],
      ['Open Conflicts', 'Continue', 'Abort'],
    ]);
  });

  it('reports a failure without retry when the caller cannot retry', async () => {
    await reportFailure('Commit', gitError('git commit failed (1): nothing to commit'));
    expect(ui.messages[0].buttons).toEqual(['Show Log']);
  });

  it('publishes with the remote given', async () => {
    const fake = engine({ 'mutate/push': (params) => ({ remote: params.remote }) });
    await publish(fake as never, repo, 'topic', 'mine');
    expect(fake.calls[0].params).toEqual({ repoId: 'r1', setUpstream: true, remote: 'mine' });
  });
});
