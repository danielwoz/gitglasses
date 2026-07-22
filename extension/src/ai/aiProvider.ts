// Provider abstraction for the BYO-key AI layer. This module is pure (no
// vscode import) so provider plumbing stays unit-testable.

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface CompletionRequest {
  system?: string;
  prompt: string;
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

export const AI_PROVIDER_IDS: readonly AiProviderId[] = [
  'vscode-lm',
  'anthropic',
  'openai',
  'gemini',
  'ollama',
];

export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
  'vscode-lm': 'VS Code Language Model (Copilot)',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (or compatible endpoint)',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
};

/** Providers that need an API key stored in SecretStorage. */
export const KEYED_PROVIDER_IDS: readonly AiProviderId[] = ['anthropic', 'openai', 'gemini'];

/** SecretStorage key holding a provider's API key. */
export function aiSecretKey(provider: string): string {
  return `gitglasses:ai:${provider}`;
}

/** Ollama is local and vscode-lm is an already-consented surface; every other
 *  provider sends diffs off-machine and needs a first-use confirmation. */
export function requiresConsent(provider: string): boolean {
  return provider !== 'ollama' && provider !== 'vscode-lm';
}

/** Minimal fetch shape so providers accept an injected stub in tests. */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
