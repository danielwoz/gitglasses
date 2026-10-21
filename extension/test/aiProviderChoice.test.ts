import { describe, expect, it } from 'vitest';
import {
  consentMessage,
  isLoopbackHost,
  providerAfterKeySaved,
  providerChoices,
  providerFromSetting,
  ProviderStatus,
  requiresConsent,
} from '../src/ai/aiProvider';

function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    vscodeLmModels: [],
    copilotInstalled: false,
    ollama: { reachable: false, models: [], host: 'http://localhost:11434' },
    keys: {},
    ...overrides,
  };
}

describe('providerFromSetting', () => {
  it('reads a provider, and nothing from none, empty or unknown values', () => {
    expect(providerFromSetting('anthropic')).toBe('anthropic');
    expect(providerFromSetting('vscode-lm')).toBe('vscode-lm');
    expect(providerFromSetting('none')).toBeUndefined();
    expect(providerFromSetting('')).toBeUndefined();
    expect(providerFromSetting('copilot')).toBeUndefined();
    expect(providerFromSetting(undefined)).toBeUndefined();
  });
});

describe('providerChoices', () => {
  it('offers no editor models on a host without any (VSCodium, Theia, code-server)', () => {
    const ids = providerChoices(status()).map((choice) => choice.id);
    expect(ids).not.toContain('vscode-lm');
    expect(ids).toEqual(['ollama', 'anthropic', 'openai', 'gemini']);
  });

  it('puts what is ready first: editor models, a running Ollama, saved keys', () => {
    const choices = providerChoices(
      status({
        vscodeLmModels: ['GPT-5 mini', 'Claude Sonnet 5.5', 'o4', 'extra'],
        ollama: { reachable: true, models: ['gemma4:latest'], host: 'http://localhost:11434' },
        keys: { gemini: true },
      }),
    );
    expect(choices.map((choice) => choice.id)).toEqual([
      'vscode-lm',
      'ollama',
      'gemini',
      'anthropic',
      'openai',
    ]);
    expect(choices[0].description).toBe('GPT-5 mini, Claude Sonnet 5.5, o4, …');
    expect(choices[1].description).toBe('running · 1 model');
    expect(choices[2].description).toBe('API key saved');
    expect(choices[3].description).toBe('bring your own API key');
  });

  it('says where Ollama was looked for when it is not running', () => {
    const ollama = providerChoices(status()).find((choice) => choice.id === 'ollama');
    expect(ollama?.description).toBe('not running at http://localhost:11434');
    expect(ollama?.detail).toMatch(/nothing is sent over the network/);
  });

  it('does not call a remote Ollama server local', () => {
    const ollama = providerChoices(
      status({ ollama: { reachable: true, models: [], host: 'http://gpu-box:11434' } }),
    ).find((choice) => choice.id === 'ollama');
    expect(ollama?.detail).toBe('Runs on http://gpu-box:11434.');
  });
});

describe('providerAfterKeySaved', () => {
  it('switches when no provider was chosen, keeps the current one, asks otherwise', () => {
    expect(providerAfterKeySaved(undefined, 'anthropic')).toBe('switch');
    expect(providerAfterKeySaved('anthropic', 'anthropic')).toBe('keep');
    expect(providerAfterKeySaved('vscode-lm', 'anthropic')).toBe('ask');
    expect(providerAfterKeySaved('ollama', 'gemini')).toBe('ask');
  });
});

describe('consent', () => {
  it('is asked before code goes to a hosted API or a remote Ollama', () => {
    expect(requiresConsent('anthropic')).toBe(true);
    expect(requiresConsent('openai')).toBe(true);
    expect(requiresConsent('gemini')).toBe(true);
    expect(requiresConsent('vscode-lm')).toBe(false);
    expect(requiresConsent('ollama')).toBe(false);
    expect(requiresConsent('ollama', { ollamaHost: 'http://127.0.0.1:11434' })).toBe(false);
    expect(requiresConsent('ollama', { ollamaHost: 'http://gpu-box.lan:11434' })).toBe(true);
  });

  it('recognises loopback hosts', () => {
    expect(isLoopbackHost(undefined)).toBe(true);
    expect(isLoopbackHost('http://localhost:11434')).toBe(true);
    expect(isLoopbackHost('http://[::1]:11434')).toBe(true);
    expect(isLoopbackHost('http://127.0.0.2')).toBe(true);
    expect(isLoopbackHost('http://10.0.0.5:11434')).toBe(false);
    expect(isLoopbackHost('not a url')).toBe(false);
  });

  it('names what is sent', () => {
    const message = consentMessage('Anthropic (Claude)');
    expect(message).toContain('Anthropic (Claude)');
    for (const part of ['diff', 'commit messages', 'file paths', 'email addresses']) {
      expect(message).toContain(part);
    }
  });
});
