import * as vscode from 'vscode';
import {
  AI_PROVIDER_LABELS,
  aiSecretKey,
  AiProviderId,
  KEYED_PROVIDER_IDS,
} from './aiProvider';

// API key management for the keyed AI providers. Keys live in SecretStorage
// under gitglasses:ai:<provider>; Ollama and vscode-lm need no key.

async function pickKeyedProvider(placeHolder: string): Promise<AiProviderId | undefined> {
  const picked = await vscode.window.showQuickPick(
    KEYED_PROVIDER_IDS.map((id) => ({ label: AI_PROVIDER_LABELS[id], id })),
    { placeHolder },
  );
  return picked?.id;
}

export async function setAiApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const provider = await pickKeyedProvider('Provider to set an API key for');
  if (!provider) return;
  const key = await vscode.window.showInputBox({
    prompt: `API key for ${AI_PROVIDER_LABELS[provider]}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!key) return;
  await secrets.store(aiSecretKey(provider), key);
  void vscode.window.showInformationMessage(
    `GitGlasses: ${AI_PROVIDER_LABELS[provider]} API key saved.`,
  );
}

export async function clearAiApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const provider = await pickKeyedProvider('Provider to clear the API key for');
  if (!provider) return;
  await secrets.delete(aiSecretKey(provider));
  void vscode.window.showInformationMessage(
    `GitGlasses: ${AI_PROVIDER_LABELS[provider]} API key removed.`,
  );
}

export function registerAiAuthCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gitglasses.ai.setApiKey', () =>
      setAiApiKey(context.secrets),
    ),
    vscode.commands.registerCommand('gitglasses.ai.clearApiKey', () =>
      clearAiApiKey(context.secrets),
    ),
  ];
}
