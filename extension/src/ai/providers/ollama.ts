import {
  AiProvider,
  AI_PROVIDER_LABELS,
  CancellationLike,
  CompletionRequest,
  FetchFn,
} from '../aiProvider';
import { defaultFetch, executeHttpCompletion } from '../httpClient';
import { buildOllamaRequest, extractOllamaText } from '../requestBuilders';

export interface OllamaProviderDeps {
  getModel(): string | undefined;
  /** Server base URL (gitglasses.ai.ollama.host), default http://localhost:11434. */
  getHost(): string | undefined;
  fetchFn?: FetchFn;
}

/** Local Ollama server: no API key, data never leaves the machine. */
export class OllamaProvider implements AiProvider {
  readonly id = 'ollama';
  readonly label = AI_PROVIDER_LABELS.ollama;

  constructor(private readonly deps: OllamaProviderDeps) {}

  async isConfigured(): Promise<boolean> {
    return true; // keyless; reachability is reported at request time
  }

  async complete(req: CompletionRequest, token?: CancellationLike): Promise<string> {
    const spec = buildOllamaRequest(req, {
      model: this.deps.getModel(),
      host: this.deps.getHost(),
    });
    return executeHttpCompletion(spec, extractOllamaText, this.deps.fetchFn ?? defaultFetch, token);
  }
}
