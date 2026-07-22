import * as vscode from 'vscode';
import {
  AiProvider,
  AI_PROVIDER_LABELS,
  CancellationLike,
  CompletionRequest,
} from '../aiProvider';

/** VS Code Language Model API (Copilot): zero-config when Copilot Chat is
 *  installed. The LM API has no separate system role, so the system prompt is
 *  prepended to the user message. */
export class VsCodeLmProvider implements AiProvider {
  readonly id = 'vscode-lm';
  readonly label = AI_PROVIDER_LABELS['vscode-lm'];

  constructor(private readonly getModelFamily: () => string | undefined) {}

  private async selectModels(): Promise<vscode.LanguageModelChat[]> {
    const family = this.getModelFamily();
    const selector: vscode.LanguageModelChatSelector = family
      ? { vendor: 'copilot', family }
      : { vendor: 'copilot' };
    try {
      return await vscode.lm.selectChatModels(selector);
    } catch {
      return [];
    }
  }

  async isConfigured(): Promise<boolean> {
    return (await this.selectModels()).length > 0;
  }

  async complete(req: CompletionRequest, token?: CancellationLike): Promise<string> {
    const models = await this.selectModels();
    const model = models[0];
    if (!model) {
      throw new Error(
        'No VS Code language model available. Install GitHub Copilot Chat, or pick another provider via "gitglasses.ai.provider".',
      );
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
