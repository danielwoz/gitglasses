import * as vscode from 'vscode';
import {
  AiProvider,
  AI_PROVIDER_LABELS,
  CancellationLike,
  CompletionRequest,
} from '../aiProvider';

export const COPILOT_CHAT_EXTENSION_ID = 'GitHub.copilot-chat';

/** Orders models so Copilot's come first, keeping the editor's order otherwise. */
export function preferCopilot<T extends { vendor: string }>(models: readonly T[]): T[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort(
      (a, b) =>
        Number(b.model.vendor === 'copilot') - Number(a.model.vendor === 'copilot') ||
        a.index - b.index,
    )
    .map((entry) => entry.model);
}

/** Keeps the models a gitglasses.ai.vscodeLm.model value names (an id,
 *  family or display name), or all of them when it is empty. */
export function filterModels<T extends { id: string; family: string; name: string }>(
  models: readonly T[],
  wanted: string | undefined,
): T[] {
  if (!wanted) return [...models];
  return models.filter(
    (model) => model.id === wanted || model.family === wanted || model.name === wanted,
  );
}

/** Every chat model the editor offers, from any extension; hosts without
 *  the API, or whose API stubs it out, offer none. */
export async function availableChatModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    const lm = (vscode as { lm?: typeof vscode.lm }).lm;
    return preferCopilot((await lm?.selectChatModels?.({})) ?? []);
  } catch {
    return [];
  }
}

/** Why no model is available, in terms of what this editor can actually do. */
export function noModelMessage(copilotInstalled: boolean, wanted: string | undefined): string {
  if (wanted) {
    return `No VS Code language model matches "${wanted}" (gitglasses.ai.vscodeLm.model).`;
  }
  return copilotInstalled
    ? 'GitHub Copilot Chat is installed but offers no language model yet; sign in to Copilot, or choose another AI provider.'
    : 'This editor offers no language models to extensions. Choose another AI provider: a local Ollama model, or your own API key.';
}

/** The editor's Language Model API: zero-config wherever an extension (such
 *  as GitHub Copilot Chat) provides chat models. The API has no separate
 *  system role, so the system prompt is prepended to the user message. */
export class VsCodeLmProvider implements AiProvider {
  readonly id = 'vscode-lm';
  readonly label = AI_PROVIDER_LABELS['vscode-lm'];

  constructor(private readonly getModel: () => string | undefined) {}

  private async selectModels(): Promise<vscode.LanguageModelChat[]> {
    return filterModels(await availableChatModels(), this.getModel());
  }

  async isConfigured(): Promise<boolean> {
    return (await this.selectModels()).length > 0;
  }

  async complete(req: CompletionRequest, token?: CancellationLike): Promise<string> {
    const model = (await this.selectModels())[0];
    if (!model) {
      const copilot = vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID) !== undefined;
      throw new Error(noModelMessage(copilot, this.getModel()));
    }
    const content = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(content)],
      {},
      token as vscode.CancellationToken | undefined,
    );
    let out = '';
    for await (const chunk of response.text) out += chunk;
    if (!out) throw new Error('AI response contained no completion text');
    return out;
  }
}
