import {
  AiProvider,
  AI_PROVIDER_LABELS,
  CancellationLike,
  CompletionRequest,
  FetchFn,
} from '../aiProvider';
import { defaultFetch, executeHttpCompletion, fetchJson } from '../httpClient';
import {
  buildOllamaRequest,
  DEFAULT_OLLAMA_HOST,
  extractOllamaText,
  ollamaModelNames,
  pickOllamaModel,
} from '../requestBuilders';

/** How long the reachability probe waits for a local server. */
const PROBE_TIMEOUT_MS = 1500;

export interface OllamaProviderDeps {
  getModel(): string | undefined;
  /** Server base URL (gitglasses.ai.ollama.host), default http://localhost:11434. */
  getHost(): string | undefined;
  fetchFn?: FetchFn;
}

/** An Ollama server: no API key, and on this machine nothing leaves it. */
export class OllamaProvider implements AiProvider {
  readonly id = 'ollama';
  readonly label = AI_PROVIDER_LABELS.ollama;

  constructor(private readonly deps: OllamaProviderDeps) {}

  host(): string {
    return (this.deps.getHost() || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
  }

  /** The installed models, or undefined when the server does not answer. */
  async listModels(): Promise<string[] | undefined> {
    try {
      const tags = await fetchJson(
        `${this.host()}/api/tags`,
        this.deps.fetchFn ?? defaultFetch,
        PROBE_TIMEOUT_MS,
      );
      return ollamaModelNames(tags);
    } catch {
      return undefined;
    }
  }

  async isConfigured(): Promise<boolean> {
    return (await this.listModels()) !== undefined;
  }

  async complete(req: CompletionRequest, token?: CancellationLike): Promise<string> {
    let model = this.deps.getModel();
    if (!model) model = pickOllamaModel(undefined, (await this.listModels()) ?? []);
    const spec = buildOllamaRequest(req, { model, host: this.host() });
    try {
      return await executeHttpCompletion(
        spec,
        extractOllamaText,
        this.deps.fetchFn ?? defaultFetch,
        token,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/could not reach/.test(message)) {
        throw new Error(`${message}. Is Ollama running? Start it with "ollama serve".`, {
          cause: error,
        });
      }
      if (/HTTP 404/.test(message)) {
        throw new Error(
          `Ollama has no model "${model}". Pull it with "ollama pull ${model}", or set "gitglasses.ai.ollama.model".`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
