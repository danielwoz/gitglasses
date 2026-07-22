import {
  AiProvider,
  AI_PROVIDER_LABELS,
  aiSecretKey,
  CancellationLike,
  CompletionRequest,
  FetchFn,
} from '../aiProvider';
import { defaultFetch, executeHttpCompletion } from '../httpClient';
import { buildAnthropicRequest, extractAnthropicText } from '../requestBuilders';

export interface AnthropicProviderDeps {
  getSecret(key: string): Promise<string | undefined>;
  getModel(): string | undefined;
  fetchFn?: FetchFn;
}

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly label = AI_PROVIDER_LABELS.anthropic;

  constructor(private readonly deps: AnthropicProviderDeps) {}

  async isConfigured(): Promise<boolean> {
    return (await this.deps.getSecret(aiSecretKey(this.id))) !== undefined;
  }

  async complete(req: CompletionRequest, token?: CancellationLike): Promise<string> {
    const apiKey = await this.deps.getSecret(aiSecretKey(this.id));
    if (!apiKey) throw new Error('No Anthropic API key set (run "GitGlasses: Set AI API Key…").');
    const spec = buildAnthropicRequest(req, { apiKey, model: this.deps.getModel() });
    return executeHttpCompletion(spec, extractAnthropicText, this.deps.fetchFn ?? defaultFetch, token);
  }
}
