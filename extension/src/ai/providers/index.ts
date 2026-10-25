import * as vscode from 'vscode';
import { AiProvider, AiProviderId, FetchFn, providerFromSetting } from '../aiProvider';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import { OpenAiProvider } from './openai';
import { VsCodeLmProvider } from './vscodeLm';

/** The per-provider model setting under gitglasses.ai. */
export const MODEL_SETTING: Record<AiProviderId, string> = {
  'vscode-lm': 'vscodeLm.model',
  anthropic: 'anthropic.model',
  openai: 'openai.model',
  gemini: 'gemini.model',
  ollama: 'ollama.model',
};

function aiSetting<T>(key: string): T | undefined {
  const value = vscode.workspace.getConfiguration('gitglasses.ai').get<T>(key);
  // Treat empty strings as unset so provider defaults apply.
  return (value as unknown) === '' ? undefined : value;
}

/** The model for a provider: its own setting, else the older shared
 *  gitglasses.ai.model, but only while the provider setting still names this
 *  provider, so one vendor's model id never reaches another. */
export function modelFor(id: AiProviderId): string | undefined {
  const own = aiSetting<string>(MODEL_SETTING[id]);
  if (own) return own;
  const legacy = aiSetting<string>('model');
  return legacy && providerFromSetting(aiSetting<string>('provider')) === id ? legacy : undefined;
}

export function ollamaProvider(fetchFn?: FetchFn): OllamaProvider {
  return new OllamaProvider({
    getModel: () => modelFor('ollama'),
    getHost: () => aiSetting<string>('ollama.host'),
    fetchFn,
  });
}

/** Builds the configured provider. Constructed per call so settings and key
 *  changes take effect without a reload. */
export function createAiProvider(
  id: AiProviderId,
  secrets: vscode.SecretStorage,
  fetchFn?: FetchFn,
): AiProvider {
  const getSecret = (key: string): Promise<string | undefined> =>
    Promise.resolve(secrets.get(key));
  const getModel = (): string | undefined => modelFor(id);
  switch (id) {
    case 'anthropic':
      return new AnthropicProvider({ getSecret, getModel, fetchFn });
    case 'openai':
      return new OpenAiProvider({
        getSecret,
        getModel,
        getBaseUrl: () => aiSetting<string>('openai.baseUrl'),
        fetchFn,
      });
    case 'gemini':
      return new GeminiProvider({ getSecret, getModel, fetchFn });
    case 'ollama':
      return ollamaProvider(fetchFn);
    case 'vscode-lm':
      return new VsCodeLmProvider(getModel);
  }
}
