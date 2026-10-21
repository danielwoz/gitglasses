// Provider abstraction for the BYO-key AI layer. This module is pure (no
// vscode import) so provider plumbing stays unit-testable.

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface CompletionRequest {
  system?: string;
  prompt: string;
  /** Room for the visible answer. Providers whose models think before they
   *  answer raise it to MIN_OUTPUT_TOKENS, since thinking counts against it. */
  maxTokens?: number;
}

export interface AiProvider {
  id: string;
  label: string;
  /** True when the provider can serve requests without further setup. */
  isConfigured(): Promise<boolean>;
  complete(req: CompletionRequest, token?: CancellationLike): Promise<string>;
}

export type AiProviderId = 'vscode-lm' | 'anthropic' | 'openai' | 'gemini' | 'ollama';

/** gitglasses.ai.provider: a provider, or 'none' until one is chosen. */
export type AiProviderSetting = AiProviderId | 'none';

export const AI_PROVIDER_IDS: readonly AiProviderId[] = [
  'vscode-lm',
  'anthropic',
  'openai',
  'gemini',
  'ollama',
];

export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
  'vscode-lm': 'VS Code language model',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (or compatible endpoint)',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
};

/** Providers that need an API key stored in SecretStorage. */
export const KEYED_PROVIDER_IDS: readonly AiProviderId[] = ['anthropic', 'openai', 'gemini'];

export function isKeyedProvider(id: AiProviderId): boolean {
  return KEYED_PROVIDER_IDS.includes(id);
}

/** The provider a gitglasses.ai.provider value names, or undefined when it
 *  names none ('none', empty, or a value this version does not know). */
export function providerFromSetting(raw: unknown): AiProviderId | undefined {
  return typeof raw === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(raw)
    ? (raw as AiProviderId)
    : undefined;
}

/** SecretStorage key holding a provider's API key. */
export function aiSecretKey(provider: string): string {
  return `gitglasses:ai:${provider}`;
}

/** Whether an Ollama host URL points at this machine. */
export function isLoopbackHost(url: string | undefined): boolean {
  if (!url) return true; // the default, http://localhost:11434
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    host.endsWith('.localhost')
  );
}

/** Sending to a hosted API needs a first-use confirmation; a local Ollama and
 *  the editor's own language models (already consented to in the editor) do
 *  not. An Ollama server on another machine does. */
export function requiresConsent(provider: string, options: { ollamaHost?: string } = {}): boolean {
  if (provider === 'vscode-lm') return false;
  if (provider === 'ollama') return !isLoopbackHost(options.ollamaHost);
  return true;
}

/** The first-use confirmation, naming what leaves the machine and where to. */
export function consentMessage(label: string): string {
  return (
    `GitGlasses AI sends what you ask about to ${label}: the diff, commit messages, ` +
    'file paths, and author names and email addresses. It leaves your machine and is ' +
    "handled under that provider's terms. Send it?"
  );
}

// --- Provider choice ---------------------------------------------------------

/** What the first-use picker knows about each provider. */
export interface ProviderStatus {
  /** Names of the language models the editor offers through vscode.lm. */
  vscodeLmModels: readonly string[];
  /** Whether a Copilot Chat extension is installed (models may still be
   *  missing until it signs in). */
  copilotInstalled: boolean;
  ollama: { reachable: boolean; models: readonly string[]; host: string };
  /** Keyed providers with an API key already stored. */
  keys: Partial<Record<AiProviderId, boolean>>;
}

export interface ProviderChoice {
  id: AiProviderId;
  label: string;
  description: string;
  detail: string;
}

/** The first-use picker's entries, most ready first: models the editor
 *  already offers, a running Ollama, providers with a saved key, then the
 *  rest. The editor's models are offered only when it actually has some. */
export function providerChoices(status: ProviderStatus): ProviderChoice[] {
  const ready: ProviderChoice[] = [];
  const rest: ProviderChoice[] = [];
  if (status.vscodeLmModels.length > 0) {
    const names = status.vscodeLmModels.slice(0, 3).join(', ');
    const more = status.vscodeLmModels.length > 3 ? ', …' : '';
    ready.push({
      id: 'vscode-lm',
      label: AI_PROVIDER_LABELS['vscode-lm'],
      description: `${names}${more}`,
      detail: 'Uses a model another extension provides to the editor, such as GitHub Copilot.',
    });
  }
  const ollama: ProviderChoice = {
    id: 'ollama',
    label: AI_PROVIDER_LABELS.ollama,
    description: status.ollama.reachable
      ? `running · ${status.ollama.models.length} model${status.ollama.models.length === 1 ? '' : 's'}`
      : `not running at ${status.ollama.host}`,
    detail: isLoopbackHost(status.ollama.host)
      ? 'Runs on this machine: nothing is sent over the network. Free; install from ollama.com.'
      : `Runs on ${status.ollama.host}.`,
  };
  (status.ollama.reachable ? ready : rest).push(ollama);
  for (const id of KEYED_PROVIDER_IDS) {
    const hasKey = status.keys[id] === true;
    const choice: ProviderChoice = {
      id,
      label: AI_PROVIDER_LABELS[id],
      description: hasKey ? 'API key saved' : 'bring your own API key',
      detail: 'Sends the code you ask about to this provider, after asking once per workspace.',
    };
    (hasKey ? ready : rest).push(choice);
  }
  return [...ready, ...rest];
}

/** After an API key is saved: switch to its provider when none is chosen
 *  yet, keep things as they are when it is already the one in use, and ask
 *  when the user deliberately chose another. */
export function providerAfterKeySaved(
  current: AiProviderId | undefined,
  saved: AiProviderId,
): 'switch' | 'keep' | 'ask' {
  if (current === undefined) return 'switch';
  if (current === saved) return 'keep';
  return 'ask';
}

/** Minimal fetch shape so providers accept an injected stub in tests. */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
