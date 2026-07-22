import {
  AiProvider,
  AI_PROVIDER_LABELS,
  aiSecretKey,
  CancellationLike,
  CompletionRequest,
  FetchFn,
} from '../aiProvider';
import { defaultFetch, executeHttpCompletion } from '../httpClient';
import { buildOpenAiRequest, extractOpenAiText } from '../requestBuilders';

export interface OpenAiProviderDeps {
  getSecret(key: string): Promise<string | undefined>;
  getModel(): string | undefined;
  /** Custom base URL (gitglasses.ai.openai.baseUrl) for compatible endpoints. */
  getBaseUrl(): string | undefined;
  fetchFn?: FetchFn;
}

export class OpenAiProvider implements AiProvider {
  readonly id = 'openai';
  readonly label = AI_PROVIDER_LABELS.openai;

  constructor(private readonly deps: OpenAiProviderDeps) {}

  async isConfigured(): Promise<boolean> {
    return (await this.deps.getSecret(aiSecretKey(this.id))) !== undefined;
  }

  async complete(req: CompletionRequest, token?: CancellationLike): Promise<string> {
    const apiKey = await this.deps.getSecret(aiSecretKey(this.id));
    if (!apiKey) throw new Error('No OpenAI API key set (run "GitGlasses: Set AI API Key…").');
    const spec = buildOpenAiRequest(req, {
      apiKey,
      model: this.deps.getModel(),
      baseUrl: this.deps.getBaseUrl(),
    });
    return executeHttpCompletion(spec, extractOpenAiText, this.deps.fetchFn ?? defaultFetch, token);
  }
}
