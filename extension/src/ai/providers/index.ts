import * as vscode from 'vscode';
import { AiProvider, AiProviderId, FetchFn } from '../aiProvider';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import { OpenAiProvider } from './openai';
import { VsCodeLmProvider } from './vscodeLm';

function aiSetting<T>(key: string): T | undefined {
  const value = vscode.workspace.getConfiguration('gitglasses.ai').get<T>(key);
  // Treat empty strings as unset so provider defaults apply.
  return (value as unknown) === '' ? undefined : value;
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
  const getModel = (): string | undefined => aiSetting<string>('model');
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
      return new OllamaProvider({
        getModel,
        getHost: () => aiSetting<string>('ollama.host'),
        fetchFn,
      });
    case 'vscode-lm':
      return new VsCodeLmProvider(getModel);
  }
}
