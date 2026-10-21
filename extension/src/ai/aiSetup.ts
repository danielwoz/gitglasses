// Choosing and readying an AI provider. Until one is chosen
// (gitglasses.ai.provider is 'none'), the first AI command offers what this
// editor can actually use: its own language models when an extension
// provides some, a running Ollama, or a bring-your-own-key API. Every AI
// command checks readiness before asking for its input, so nothing is typed
// in vain.

import * as vscode from 'vscode';
import {
  AI_PROVIDER_LABELS,
  aiSecretKey,
  AiProvider,
  AiProviderId,
  consentMessage,
  isKeyedProvider,
  KEYED_PROVIDER_IDS,
  providerChoices,
  providerFromSetting,
  ProviderStatus,
  requiresConsent,
} from './aiProvider';
import { createAiProvider, MODEL_SETTING, ollamaProvider } from './providers';
import {
  availableChatModels,
  COPILOT_CHAT_EXTENSION_ID,
  filterModels,
  noModelMessage,
} from './providers/vscodeLm';

const CHOOSE_PROVIDER = 'Choose AI Provider…';
const SET_KEY = 'Set API Key…';
const RETRY = 'Retry';

function aiConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('gitglasses.ai');
}

/** The provider gitglasses.ai.provider names, or undefined until one is chosen. */
export function configuredProvider(): AiProviderId | undefined {
  return providerFromSetting(aiConfig().get<string>('provider'));
}

function ollamaHost(): string | undefined {
  return aiConfig().get<string>('ollama.host') || undefined;
}

export async function detectProviders(secrets: vscode.SecretStorage): Promise<ProviderStatus> {
  const ollama = ollamaProvider();
  const [models, ollamaModels, ...keys] = await Promise.all([
    availableChatModels(),
    ollama.listModels(),
    ...KEYED_PROVIDER_IDS.map(async (id) => (await secrets.get(aiSecretKey(id))) !== undefined),
  ]);
  return {
    vscodeLmModels: models.map((model) => model.name || model.id),
    copilotInstalled: vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID) !== undefined,
    ollama: {
      reachable: ollamaModels !== undefined,
      models: ollamaModels ?? [],
      host: ollama.host(),
    },
    keys: Object.fromEntries(KEYED_PROVIDER_IDS.map((id, index) => [id, keys[index]])),
  };
}

/** Writes gitglasses.ai.provider for the user. The older shared
 *  gitglasses.ai.model moves to the per-provider setting of the provider it
 *  was written for, so it is never sent to the new one. */
export async function setProvider(id: AiProviderId, log?: (line: string) => void): Promise<void> {
  const config = aiConfig();
  const legacyModel = config.inspect<string>('model')?.globalValue;
  if (legacyModel) {
    const previous =
      providerFromSetting(config.inspect<string>('provider')?.globalValue) ?? 'vscode-lm';
    if (previous !== id) {
      if (!config.inspect<string>(MODEL_SETTING[previous])?.globalValue) {
        await config.update(
          MODEL_SETTING[previous],
          legacyModel,
          vscode.ConfigurationTarget.Global,
        );
      }
      await config.update('model', undefined, vscode.ConfigurationTarget.Global);
      log?.(`AI: moved gitglasses.ai.model to gitglasses.ai.${MODEL_SETTING[previous]}`);
    }
  }
  await config.update('provider', id, vscode.ConfigurationTarget.Global);
  const inspected = config.inspect<string>('provider');
  if (
    (inspected?.workspaceFolderValue ?? inspected?.workspaceValue) !== undefined &&
    (inspected?.workspaceFolderValue ?? inspected?.workspaceValue) !== id
  ) {
    void vscode.window.showWarningMessage(
      `GitGlasses: saved ${AI_PROVIDER_LABELS[id]} as your AI provider, but this workspace's settings choose another with "gitglasses.ai.provider".`,
    );
  }
}

/** Prompts for and stores a keyed provider's API key; true when one was saved. */
export async function promptForKey(
  secrets: vscode.SecretStorage,
  id: AiProviderId,
): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: `${AI_PROVIDER_LABELS[id]} API key`,
    prompt: `Paste your ${AI_PROVIDER_LABELS[id]} API key. It is kept in the editor's secret storage.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!key || key.trim() === '') return false;
  await secrets.store(aiSecretKey(id), key.trim());
  return true;
}

/** Offers every provider, most ready first, and saves the choice (asking
 *  for a key first when it needs one). Returns the chosen provider. */
export async function chooseProvider(
  secrets: vscode.SecretStorage,
  options: { title?: string; log?: (line: string) => void } = {},
): Promise<AiProviderId | undefined> {
  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'GitGlasses: looking for AI providers' },
    () => detectProviders(secrets),
  );
  const current = configuredProvider();
  const picked = await vscode.window.showQuickPick(
    providerChoices(status).map((choice) => ({
      ...choice,
      label: choice.id === current ? `$(check) ${choice.label}` : choice.label,
    })),
    {
      title: options.title ?? 'Choose an AI provider for GitGlasses',
      placeHolder: 'Where should GitGlasses AI requests go? You can change this later.',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    },
  );
  if (!picked) return undefined;
  const id = picked.id;
  if (isKeyedProvider(id) && status.keys[id] !== true && !(await promptForKey(secrets, id))) {
    return undefined;
  }
  if (id === 'ollama' && !status.ollama.reachable) {
    void vscode.window
      .showInformationMessage(
        `GitGlasses: Ollama is not running at ${status.ollama.host}. Install it from ollama.com, pull a model (for example "ollama pull gemma4"), and start it.`,
        'Open ollama.com',
      )
      .then((choice) => {
        if (choice) void vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
      });
  }
  await setProvider(id, options.log);
  options.log?.(`AI: provider set to ${id}`);
  return id;
}

/** Answers "can this provider serve a request now?", with the reason when
 *  it cannot and the action that would fix it. */
async function readiness(
  id: AiProviderId,
  secrets: vscode.SecretStorage,
): Promise<{ ready: true } | { ready: false; reason: string; fix: string }> {
  if (isKeyedProvider(id)) {
    if ((await secrets.get(aiSecretKey(id))) !== undefined) return { ready: true };
    return { ready: false, reason: `no ${AI_PROVIDER_LABELS[id]} API key is set.`, fix: SET_KEY };
  }
  if (id === 'ollama') {
    const ollama = ollamaProvider();
    if ((await ollama.listModels()) !== undefined) return { ready: true };
    return {
      ready: false,
      reason: `Ollama is not running at ${ollama.host()}. Start it with "ollama serve", or choose another provider.`,
      fix: RETRY,
    };
  }
  const wanted = aiConfig().get<string>(MODEL_SETTING['vscode-lm']) || undefined;
  if (filterModels(await availableChatModels(), wanted).length > 0) return { ready: true };
  const copilot = vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID) !== undefined;
  return { ready: false, reason: noModelMessage(copilot, wanted), fix: CHOOSE_PROVIDER };
}

/** The provider an AI command should use, ready to serve: chosen (asking on
 *  first use), configured, and consented to. Undefined when the user backs
 *  out; every problem has been explained by then. */
export async function ensureAiReady(
  context: vscode.ExtensionContext,
  log?: (line: string) => void,
): Promise<{ id: AiProviderId; provider: AiProvider } | undefined> {
  let id = configuredProvider();
  if (!id) {
    id = await chooseProvider(context.secrets, {
      title: 'GitGlasses AI: choose a provider to continue',
      log,
    });
    if (!id) return undefined;
  }
  for (;;) {
    const state = await readiness(id, context.secrets);
    if (state.ready) break;
    log?.(`AI: ${AI_PROVIDER_LABELS[id]} not ready: ${state.reason}`);
    const actions =
      state.fix === CHOOSE_PROVIDER ? [CHOOSE_PROVIDER] : [state.fix, CHOOSE_PROVIDER];
    const choice = await vscode.window.showWarningMessage(
      `GitGlasses AI: ${state.reason.charAt(0).toUpperCase()}${state.reason.slice(1)}`,
      ...actions,
    );
    if (choice === SET_KEY) {
      if (!(await promptForKey(context.secrets, id))) return undefined;
    } else if (choice === CHOOSE_PROVIDER) {
      const chosen = await chooseProvider(context.secrets, { log });
      if (!chosen) return undefined;
      id = chosen;
    } else if (choice !== RETRY) {
      return undefined;
    }
  }
  if (!(await ensureConsent(context, id))) return undefined;
  return { id, provider: createAiProvider(id, context.secrets) };
}

function consentKey(id: AiProviderId): string {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'no-workspace';
  return `gitglasses.ai.consent:${id}:${workspace}`;
}

/** First-use confirmation per workspace before code leaves the machine. */
async function ensureConsent(context: vscode.ExtensionContext, id: AiProviderId): Promise<boolean> {
  if (!requiresConsent(id, { ollamaHost: ollamaHost() })) return true;
  const key = consentKey(id);
  if (context.globalState.get<boolean>(key) === true) return true;
  const label = id === 'ollama' ? `the Ollama server at ${ollamaHost()}` : AI_PROVIDER_LABELS[id];
  const choice = await vscode.window.showWarningMessage(
    consentMessage(label),
    { modal: true },
    'Send',
  );
  if (choice !== 'Send') return false;
  await context.globalState.update(key, true);
  return true;
}
