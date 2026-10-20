// Credential prompts from the engine (ui/askpass): which ones a stored
// integration may answer, how the rest are asked, and that background work
// never pops a prompt up on its own.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscodeUi'));

import { ui } from './support/fakeVscodeUi';
import type { CancellationLike } from '@gitglasses/rpc';
import {
  type AskpassRequest,
  displayHost,
  integrationAnswer,
  integrationMayAnswer,
  promptText,
  promptTitle,
  tokenUsername,
} from '../src/auth/askpassLogic';
import { AskpassService, integrationCredential } from '../src/auth/askpassService';

function request(overrides: Partial<AskpassRequest> = {}): AskpassRequest {
  return {
    kind: 'password',
    prompt: "Password for 'https://alice@github.com': ",
    protocol: 'https',
    host: 'github.com',
    username: 'alice',
    secret: true,
    interactive: true,
    method: 'mutate/push',
    requestId: 4,
    ...overrides,
  };
}

/** A cancellation the test can fire, as ui/askpassCancelled does. */
function cancellation() {
  const listeners = new Set<() => void>();
  let cancelled = false;
  const token: CancellationLike = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    token,
    cancel() {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

const never = cancellation().token;

function service(
  credential?: { providerId: string; host: string; token: string; username?: string },
  onBackgroundAllowed?: () => void,
) {
  const logs: string[] = [];
  const asked: { host: string; interactive: boolean }[] = [];
  let handler: ((params: AskpassRequest, token: CancellationLike) => Promise<unknown>) | undefined;
  const engine = {
    onRequest: (_method: string, h: typeof handler) => {
      handler = h;
      return { dispose: () => (handler = undefined) };
    },
  };
  const askpass = new AskpassService(engine as never, {
    log: (line) => logs.push(line),
    credentialFor: async (host, interactive) => {
      asked.push({ host, interactive });
      return credential;
    },
    onBackgroundAllowed,
  });
  return { askpass, logs, asked, handler: () => handler };
}

beforeEach(() => ui.reset());

describe('askpass presentation', () => {
  it('names the action and the host', () => {
    expect(promptTitle(request())).toBe('GitGlasses: Push (github.com)');
    expect(promptTitle(request({ method: 'mutate/commit', host: undefined }))).toBe(
      'GitGlasses: Commit',
    );
    expect(promptText(request())).toBe("Password for 'https://alice@github.com'");
    expect(displayHost('[127.0.0.1]:2222')).toBe('127.0.0.1:2222');
    expect(promptTitle(request({ interactive: false, method: 'blame/file' }))).toBe(
      'GitGlasses: Download Missing Objects (github.com)',
    );
    expect(
      promptText(request({ kind: 'passphrase', prompt: 'Enter passphrase: ', host: undefined })),
    ).toBe('Enter the passphrase of the ssh key that signs your commits');
    expect(promptTitle(request({ kind: 'hostKey', host: '[git.lan]:2222' }))).toBe(
      'GitGlasses: Connect to git.lan:2222',
    );
  });
});

describe('integration answers', () => {
  it('answer only credential prompts for https on exactly their host', () => {
    expect(integrationMayAnswer(request(), 'github.com')).toBe(true);
    expect(integrationMayAnswer(request({ kind: 'username' }), 'GitHub.com')).toBe(true);
    expect(integrationMayAnswer(request({ protocol: 'http' }), 'github.com')).toBe(false);
    expect(integrationMayAnswer(request({ host: 'github.com.evil.example' }), 'github.com')).toBe(
      false,
    );
    expect(integrationMayAnswer(request({ kind: 'passphrase' }), 'github.com')).toBe(false);
    expect(integrationMayAnswer(request({ host: undefined }), 'github.com')).toBe(false);
  });

  it('give the stored username, or the one each forge takes with a token', () => {
    const credential = { providerId: 'gitlab', host: 'gitlab.com', token: 'glpat-x' };
    expect(integrationAnswer(request({ kind: 'username' }), credential)).toBe('oauth2');
    expect(integrationAnswer(request(), credential)).toBe('glpat-x');
    expect(
      integrationAnswer(request({ kind: 'username' }), { ...credential, username: 'carol' }),
    ).toBe('carol');
    expect(tokenUsername('github')).toBe('x-access-token');
  });

  it('only GitHub.com may sign in during a git prompt', async () => {
    const calls: { providerId: string; interactive: boolean | undefined }[] = [];
    const integrations = {
      getHostingEntries: () => [
        { providerId: 'github', host: 'github.com' },
        { providerId: 'gitlab', host: 'gitlab.example.com' },
      ],
      auth: {
        getAuth: async (providerId: string, _host: string, options: { interactive?: boolean }) => {
          calls.push({ providerId, interactive: options.interactive });
          return { token: 't' };
        },
      },
    };
    await integrationCredential(integrations as never, 'github.com', true);
    await integrationCredential(integrations as never, 'gitlab.example.com', true);
    expect(await integrationCredential(integrations as never, 'example.org', true)).toBeUndefined();
    expect(calls).toEqual([
      { providerId: 'github', interactive: true },
      { providerId: 'gitlab', interactive: false },
    ]);
  });
});

describe('AskpassService', () => {
  it('answers from the integration that holds a credential for the host', async () => {
    const { askpass, asked, logs } = service({
      providerId: 'github',
      host: 'github.com',
      token: 'gho_token',
    });
    await expect(askpass.answer(request({ kind: 'username' }), never)).resolves.toEqual({
      value: 'x-access-token',
    });
    await expect(askpass.answer(request(), never)).resolves.toEqual({ value: 'gho_token' });
    expect(asked[0]).toEqual({ host: 'github.com', interactive: true });
    expect(ui.shown).toHaveLength(0);
    expect(askpass.answeredFromIntegrationSince('github.com', 0)).toBe(true);
    expect(logs.join('\n')).not.toContain('gho_token');
  });

  it('never sends a token over plain http', async () => {
    const { askpass, asked } = service({ providerId: 'github', host: 'github.com', token: 't' });
    ui.answers.push((input) => input.accept('typed'));
    await expect(askpass.answer(request({ protocol: 'http' }), never)).resolves.toEqual({
      value: 'typed',
    });
    expect(asked).toHaveLength(0);
  });

  it('asks in a masked input box and logs no answer', async () => {
    const { askpass, logs } = service();
    ui.answers.push((input) => input.accept('s3cret'));
    await expect(askpass.answer(request({ host: 'git.example.com' }), never)).resolves.toEqual({
      value: 's3cret',
    });
    expect(ui.shown[0]).toMatchObject({
      kind: 'input',
      password: true,
      title: 'GitGlasses: Push (git.example.com)',
    });
    expect(ui.shown[0].disposed).toBe(true);
    expect(logs.join('\n')).not.toContain('s3cret');

    ui.answers.push((input) => input.accept('alice'));
    await askpass.answer(request({ kind: 'username', secret: false, host: 'x' }), never);
    expect(ui.shown[1].password).toBe(false);
  });

  it('reports a dismissed prompt as cancelled', async () => {
    const { askpass } = service();
    ui.answers.push((input) => input.hide());
    await expect(askpass.answer(request({ host: 'x' }), never)).resolves.toEqual({
      cancelled: true,
    });
  });

  it('closes the prompt when the engine withdraws it', async () => {
    const { askpass } = service();
    const { token, cancel } = cancellation();
    const answer = askpass.answer(request({ host: 'x' }), token);
    await vi.waitFor(() => expect(ui.shown).toHaveLength(1));
    cancel();
    await expect(answer).resolves.toEqual({ cancelled: true });
    expect(ui.shown[0].disposed).toBe(true);
  });

  it('shows one prompt at a time', async () => {
    const { askpass } = service();
    const first = askpass.answer(request({ host: 'a', kind: 'username', secret: false }), never);
    const second = askpass.answer(request({ host: 'a' }), never);
    await vi.waitFor(() => expect(ui.shown).toHaveLength(1));
    ui.shown[0].accept('alice');
    await expect(first).resolves.toEqual({ value: 'alice' });
    await vi.waitFor(() => expect(ui.shown).toHaveLength(2));
    ui.shown[1].accept('pw');
    await expect(second).resolves.toEqual({ value: 'pw' });
  });

  it('asks a yes/no question for an unknown ssh host', async () => {
    const { askpass } = service();
    const hostKey = request({
      kind: 'hostKey',
      secret: false,
      protocol: 'ssh',
      host: '[git.lan]:2222',
      fingerprint: 'SHA256:abc',
      prompt: "The authenticity of host '[git.lan]:2222' can't be established.\n...",
    });
    ui.answers.push((pick) => pick.accept(0));
    await expect(askpass.answer(hostKey, never)).resolves.toEqual({ value: 'yes' });
    expect(ui.shown[0].kind).toBe('pick');
    expect(ui.shown[0].placeholder).toContain('git.lan:2222');
    ui.answers.push((pick) => pick.accept(1));
    await expect(askpass.answer(hostKey, never)).resolves.toEqual({ cancelled: true });
  });

  it('keeps background prompts quiet until the user agrees to answer them', async () => {
    let allowed = 0;
    const { askpass } = service(undefined, () => (allowed += 1));
    const background = request({
      interactive: false,
      host: 'git.example.com',
      method: 'blame/file',
    });
    ui.messageChoices.push(undefined);
    await expect(askpass.answer(background, never)).resolves.toEqual({ cancelled: true });
    await expect(askpass.answer(background, never)).resolves.toEqual({ cancelled: true });
    expect(ui.shown).toHaveLength(0);
    expect(ui.messages).toHaveLength(1);
    expect(ui.messages[0].text).toContain('partial clone');

    // A second remote is explained once too; this time the user agrees.
    ui.messageChoices.push('Enter Credentials');
    const other = { ...background, host: 'other.example.com' };
    await askpass.answer(other, never);
    await vi.waitFor(() => expect(allowed).toBe(1));
    ui.answers.push((input) => input.accept('pw'));
    await expect(askpass.answer(other, never)).resolves.toEqual({ value: 'pw' });
  });

  it('asks the user once git refused the integration token for a host', async () => {
    const { askpass } = service({ providerId: 'github', host: 'github.com', token: 't' });
    askpass.refuseIntegrationFor('GitHub.com');
    ui.answers.push((input) => input.accept('typed'));
    await expect(askpass.answer(request(), never)).resolves.toEqual({ value: 'typed' });
  });
});
