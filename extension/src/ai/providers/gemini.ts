import {
  AiProvider,
  AI_PROVIDER_LABELS,
  aiSecretKey,
  CancellationLike,
  CompletionRequest,
  FetchFn,
} from '../aiProvider';
import { defaultFetch, executeHttpCompletion } from '../httpClient';
import { buildGeminiRequest, extractGeminiText } from '../requestBuilders';

export interface GeminiProviderDeps {
  getSecret(key: string): Promise<string | undefined>;
  getModel(): string | undefined;
  fetchFn?: FetchFn;
}

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini';
  readonly label = AI_PROVIDER_LABELS.gemini;

  constructor(private readonly deps: GeminiProviderDeps) {}

  async isConfigured(): Promise<boolean> {
    return (await this.deps.getSecret(aiSecretKey(this.id))) !== undefined;
  }

  async complete(req: CompletionRequest, token?: CancellationLike): Promise<string> {
    const apiKey = await this.deps.getSecret(aiSecretKey(this.id));
    if (!apiKey) throw new Error('No Gemini API key set (run "GitGlasses: Set AI API Key…").');
    const spec = buildGeminiRequest(req, { apiKey, model: this.deps.getModel() });
    return executeHttpCompletion(spec, extractGeminiText, this.deps.fetchFn ?? defaultFetch, token);
  }
}
