// Answers the credential prompts git, ssh and gpg raise while the engine runs
// them (ui/askpass): from an integration's stored credential when the prompt
// is for exactly that host over https, otherwise by asking the user in an
// input box or, for an ssh host key, a yes/no pick. Prompts from background
// work (blame or history fetching objects a partial clone left out) never
// pop up on their own; the user is told once and can opt in. Answers are
// never logged or kept.

import * as vscode from 'vscode';
import type { CancellationLike, EngineClient } from '@gitglasses/rpc';
import type { EngineRequestResult } from '@gitglasses/protocol';
import type { IntegrationService } from '../integrations/integrationService';
import {
  type AskpassRequest,
  type IntegrationCredential,
  backgroundKey,
  displayHost,
  integrationAnswer,
  integrationMayAnswer,
  promptText,
  promptTitle,
  yesNoChoices,
  yesNoQuestion,
} from './askpassLogic';

type AskpassResult = EngineRequestResult<'ui/askpass'>;

const CANCELLED: AskpassResult = { cancelled: true };

export interface AskpassDeps {
  log(line: string): void;
  /** The integration credential stored for `host`, if any. `interactive`
   *  allows a sign-in flow where the provider has one. */
  credentialFor(host: string, interactive: boolean): Promise<IntegrationCredential | undefined>;
  /** Runs after the user agreed to answer prompts from background work, so
   *  what failed for want of them can be retried. */
  onBackgroundAllowed?(): void;
}

export class AskpassService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  // One quick input shows at a time; a second would close the first.
  private queue: Promise<unknown> = Promise.resolve();
  private readonly integrationRefused = new Set<string>();
  private readonly integrationAnswered = new Map<string, number>();
  private readonly backgroundAllowed = new Set<string>();
  private readonly backgroundExplained = new Set<string>();

  constructor(
    engine: Pick<EngineClient, 'onRequest'>,
    private readonly deps: AskpassDeps,
  ) {
    this.disposables.push(
      engine.onRequest('ui/askpass', (params, token) => this.answer(params, token)),
    );
  }

  /** Answers one prompt. */
  async answer(request: AskpassRequest, token: CancellationLike): Promise<AskpassResult> {
    const where = request.host ? displayHost(request.host) : 'a remote';
    const fromIntegration = await this.fromIntegration(request);
    if (fromIntegration !== undefined) {
      this.deps.log(`askpass: ${request.kind} for ${where} answered from the stored integration`);
      return { value: fromIntegration };
    }
    if (!request.interactive && !this.backgroundAllowed.has(backgroundKey(request))) {
      this.explainBackgroundPrompt(request);
      this.deps.log(`askpass: ${request.kind} for ${where} from background work declined`);
      return CANCELLED;
    }
    const result = (await this.enqueue(() =>
      token.isCancellationRequested ? Promise.resolve(CANCELLED) : this.ask(request, token),
    )) as AskpassResult;
    const outcome = token.isCancellationRequested
      ? 'withdrawn'
      : 'value' in result
        ? 'answered'
        : 'dismissed';
    this.deps.log(`askpass: ${request.kind} for ${where} (${request.method ?? 'git'}) ${outcome}`);
    return result;
  }

  /** True when a credential prompt for `host` was answered from a stored
   *  integration credential at or after `since` (Date.now() time). */
  answeredFromIntegrationSince(host: string, since: number): boolean {
    return (this.integrationAnswered.get(host.toLowerCase()) ?? 0) >= since;
  }

  /** Stops answering `host`'s prompts from its integration for the rest of
   *  the session: git refused the stored credential (it may lack write
   *  access), so the user is asked instead. */
  refuseIntegrationFor(host: string): void {
    this.integrationRefused.add(host.toLowerCase());
  }

  private async fromIntegration(request: AskpassRequest): Promise<string | undefined> {
    const host = request.host?.toLowerCase();
    if (!host || this.integrationRefused.has(host)) return undefined;
    if (!integrationMayAnswer(request, host)) return undefined;
    let credential: IntegrationCredential | undefined;
    try {
      credential = await this.deps.credentialFor(host, request.interactive);
    } catch (error) {
      this.deps.log(`askpass: reading the ${host} integration failed: ${String(error)}`);
      return undefined;
    }
    // The credential must belong to exactly the host the prompt names.
    if (!credential || !integrationMayAnswer(request, credential.host)) return undefined;
    this.integrationAnswered.set(host, Date.now());
    return integrationAnswer(request, credential);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ask(request: AskpassRequest, token: CancellationLike): Promise<AskpassResult> {
    return request.kind === 'hostKey' || request.kind === 'confirm'
      ? this.askYesNo(request, token)
      : this.askText(request, token);
  }

  private askText(request: AskpassRequest, token: CancellationLike): Promise<AskpassResult> {
    return new Promise((resolve) => {
      const input = vscode.window.createInputBox();
      input.title = promptTitle(request);
      input.prompt = promptText(request);
      input.password = request.secret;
      input.ignoreFocusOut = true;
      let settled = false;
      const subscriptions: { dispose(): void }[] = [];
      const settle = (result: AskpassResult): void => {
        if (settled) return;
        settled = true;
        for (const subscription of subscriptions) subscription.dispose();
        input.dispose();
        resolve(result);
      };
      subscriptions.push(
        input.onDidAccept(() => settle({ value: input.value })),
        input.onDidHide(() => settle(CANCELLED)),
        token.onCancellationRequested(() => settle(CANCELLED)),
      );
      input.show();
    });
  }

  private askYesNo(request: AskpassRequest, token: CancellationLike): Promise<AskpassResult> {
    return new Promise((resolve) => {
      const choices = yesNoChoices(request);
      const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { answer: 'yes' | 'no' }>();
      pick.title = promptTitle(request);
      pick.placeholder = yesNoQuestion(request);
      pick.items = choices;
      pick.ignoreFocusOut = true;
      let settled = false;
      const subscriptions: { dispose(): void }[] = [];
      const settle = (result: AskpassResult): void => {
        if (settled) return;
        settled = true;
        for (const subscription of subscriptions) subscription.dispose();
        pick.dispose();
        resolve(result);
      };
      subscriptions.push(
        pick.onDidAccept(() => {
          const answer = pick.selectedItems[0]?.answer;
          // Declining is a dismissal: ssh then stops, and nothing reports it
          // as a failure the user has to read.
          settle(answer === 'yes' ? { value: 'yes' } : CANCELLED);
        }),
        pick.onDidHide(() => settle(CANCELLED)),
        token.onCancellationRequested(() => settle(CANCELLED)),
      );
      pick.show();
    });
  }

  /** Says once per remote that background work wanted credentials, and lets
   *  the user allow it to ask. */
  private explainBackgroundPrompt(request: AskpassRequest): void {
    const key = backgroundKey(request);
    if (this.backgroundExplained.has(key)) return;
    this.backgroundExplained.add(key);
    const where = request.host ? displayHost(request.host) : 'The remote';
    const allow = 'Enter Credentials';
    void vscode.window
      .showWarningMessage(
        `GitGlasses: ${where} asks for credentials to download objects this partial clone left ` +
          'out, so blame and history may be incomplete.',
        allow,
      )
      .then((choice) => {
        if (choice !== allow) return;
        this.backgroundAllowed.add(key);
        this.deps.onBackgroundAllowed?.();
      });
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

/**
 * The credential an integration stores for exactly `host`. Only VS Code's
 * own GitHub sign-in may run for a git prompt: other providers ask for a
 * token as part of setting up the integration, which a push is not.
 */
export async function integrationCredential(
  integrations: Pick<IntegrationService, 'getHostingEntries' | 'auth'>,
  host: string,
  interactive: boolean,
): Promise<IntegrationCredential | undefined> {
  const entry = integrations
    .getHostingEntries()
    .find((candidate) => candidate.host.toLowerCase() === host.toLowerCase());
  if (!entry) return undefined;
  const signIn = interactive && entry.providerId === 'github' && entry.host === 'github.com';
  const auth = await integrations.auth.getAuth(entry.providerId, entry.host, {
    interactive: signIn,
  });
  if (!auth) return undefined;
  return {
    providerId: entry.providerId,
    host: entry.host,
    token: auth.token,
    username: auth.username,
  };
}
