import * as vscode from 'vscode';
import {
  AI_PROVIDER_LABELS,
  aiSecretKey,
  AiProviderId,
  KEYED_PROVIDER_IDS,
  providerAfterKeySaved,
} from './aiProvider';
import { chooseProvider, configuredProvider, promptForKey, setProvider } from './aiSetup';

// API key management for the keyed AI providers. Keys live in SecretStorage
// under gitglasses:ai:<provider>; Ollama and the editor's models need none.

async function pickKeyedProvider(placeHolder: string): Promise<AiProviderId | undefined> {
  const current = configuredProvider();
  const picked = await vscode.window.showQuickPick(
    KEYED_PROVIDER_IDS.map((id) => ({
      label: AI_PROVIDER_LABELS[id],
      description: id === current ? 'current provider' : undefined,
      id,
    })),
    { placeHolder },
  );
  return picked?.id;
}

/** Saves a key, then makes its provider the one in use: right away when no
 *  provider was chosen yet, after asking when another one was. */
export async function setAiApiKey(
  secrets: vscode.SecretStorage,
  log?: (line: string) => void,
): Promise<void> {
  const provider = await pickKeyedProvider('Provider to set an API key for');
  if (!provider) return;
  if (!(await promptForKey(secrets, provider))) return;
  const label = AI_PROVIDER_LABELS[provider];
  const current = configuredProvider();
  const decision = providerAfterKeySaved(current, provider);
  if (decision === 'switch') {
    await setProvider(provider, log);
    void vscode.window.showInformationMessage(
      `GitGlasses: ${label} API key saved. GitGlasses AI now uses ${label}.`,
    );
    return;
  }
  if (decision === 'keep') {
    void vscode.window.showInformationMessage(`GitGlasses: ${label} API key saved.`);
    return;
  }
  const use = `Use ${label}`;
  const choice = await vscode.window.showInformationMessage(
    `GitGlasses: ${label} API key saved. GitGlasses AI currently uses ${AI_PROVIDER_LABELS[current as AiProviderId]}; switch to ${label}?`,
    use,
    'Keep Current',
  );
  if (choice === use) await setProvider(provider, log);
}

export async function clearAiApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const provider = await pickKeyedProvider('Provider to clear the API key for');
  if (!provider) return;
  await secrets.delete(aiSecretKey(provider));
  void vscode.window.showInformationMessage(
    `GitGlasses: ${AI_PROVIDER_LABELS[provider]} API key removed.`,
  );
}

export function registerAiAuthCommands(
  context: vscode.ExtensionContext,
  log?: (line: string) => void,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gitglasses.ai.setApiKey', () =>
      setAiApiKey(context.secrets, log),
    ),
    vscode.commands.registerCommand('gitglasses.ai.clearApiKey', () =>
      clearAiApiKey(context.secrets),
    ),
    vscode.commands.registerCommand('gitglasses.ai.chooseProvider', async () => {
      const id = await chooseProvider(context.secrets, { log });
      if (id) {
        void vscode.window.showInformationMessage(
          `GitGlasses: AI requests now go to ${AI_PROVIDER_LABELS[id]}.`,
        );
      }
    }),
  ];
}
