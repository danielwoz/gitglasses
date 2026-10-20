// The AI provider flows against a scripted editor: first use on a host with
// no editor models and no Ollama, saving a key, readiness checks that fail
// before any input is asked for, and the move of the old shared model setting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Item = { id?: string; label: string };
  const state = {
    /** Global settings under gitglasses.ai, by key. */
    global: new Map<string, unknown>(),
    workspace: new Map<string, unknown>(),
    secrets: new Map<string, string>(),
    chatModels: [] as { id: string; family: string; name: string; vendor: string }[],
    extensions: new Set<string>(),
    /** Scripted answers, consumed in order. */
    picks: [] as ((items: Item[]) => Item | undefined)[],
    inputs: [] as (string | undefined)[],
    messageChoices: [] as (string | undefined)[],
    shownPicks: [] as Item[][],
    messages: [] as string[],
    reset(): void {
      this.global.clear();
      this.workspace.clear();
      this.secrets.clear();
      this.chatModels = [];
      this.extensions.clear();
      this.picks = [];
      this.inputs = [];
      this.messageChoices = [];
      this.shownPicks = [];
      this.messages = [];
    },
  };
  const defaults: Record<string, unknown> = { provider: 'none', model: '' };
  const message = async (text: string): Promise<string | undefined> => {
    state.messages.push(text);
    return state.messageChoices.shift();
  };
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    env: { openExternal: async () => true },
    extensions: {
      getExtension: (id: string) => (state.extensions.has(id) ? { id } : undefined),
    },
    lm: { selectChatModels: async () => state.chatModels },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: (section: string) => {
        const key = (name: string): string => `${section}.${name}`.replace(/^gitglasses\.ai\./, '');
        return {
          get: <T>(name: string, fallback?: T): T | undefined => {
            const k = key(name);
            if (state.workspace.has(k)) return state.workspace.get(k) as T;
            if (state.global.has(k)) return state.global.get(k) as T;
            return (k in defaults ? defaults[k] : fallback) as T;
          },
          inspect: <T>(name: string) => ({
            key: name,
            globalValue: state.global.get(key(name)) as T | undefined,
            workspaceValue: state.workspace.get(key(name)) as T | undefined,
          }),
          update: async (name: string, value: unknown) => {
            if (value === undefined) state.global.delete(key(name));
            else state.global.set(key(name), value);
          },
        };
      },
    },
    window: {
      withProgress: async <T>(_options: unknown, task: () => Promise<T>) => task(),
      showQuickPick: async (items: Item[]) => {
        state.shownPicks.push(items);
        const answer = state.picks.shift();
        return answer ? answer(items) : undefined;
      },
      showInputBox: async () => state.inputs.shift(),
      showInformationMessage: message,
      showWarningMessage: message,
      showErrorMessage: message,
    },
  };
  return { state, vscode };
});

vi.mock('vscode', () => fake.vscode);

import { setAiApiKey } from '../src/ai/aiAuth';
import { chooseProvider, ensureAiReady, setProvider } from '../src/ai/aiSetup';
import { modelFor } from '../src/ai/providers';
import { filterModels, noModelMessage, preferCopilot } from '../src/ai/providers/vscodeLm';

const { state } = fake;

const secrets = {
  get: async (key: string) => state.secrets.get(key),
  store: async (key: string, value: string) => void state.secrets.set(key, value),
  delete: async (key: string) => void state.secrets.delete(key),
};

function context() {
  const global = new Map<string, unknown>();
  return {
    secrets,
    globalState: {
      get: (key: string) => global.get(key),
      update: async (key: string, value: unknown) => void global.set(key, value),
    },
  } as never;
}

const pickId = (id: string) => (items: { id?: string; label: string }[]) =>
  items.find((item) => item.id === id);

/** Ollama answers /api/tags when `running`; nothing else is reachable. */
function stubOllama(running: boolean, models: string[] = ['gemma4:latest']): void {
  vi.stubGlobal('fetch', async (url: string) => {
    if (!running || !url.endsWith('/api/tags')) throw new TypeError('fetch failed');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ models: models.map((name) => ({ name })) }),
    };
  });
}

beforeEach(() => state.reset());
afterEach(() => vi.unstubAllGlobals());

describe('first use on an Open VSX host (no editor models, no Ollama)', () => {
  it('offers Ollama and the keyed providers, never the editor models', async () => {
    stubOllama(false);
    state.picks.push(() => undefined);
    expect(await chooseProvider(secrets as never)).toBeUndefined();
    expect(state.shownPicks[0].map((item) => item.id)).toEqual([
      'ollama',
      'anthropic',
      'openai',
      'gemini',
    ]);
    expect(state.global.get('provider')).toBeUndefined();
  });

  it('saves the provider only once its key is given', async () => {
    stubOllama(false);
    state.picks.push(pickId('anthropic'));
    state.inputs.push(undefined); // key prompt dismissed
    expect(await chooseProvider(secrets as never)).toBeUndefined();
    expect(state.global.get('provider')).toBeUndefined();

    state.picks.push(pickId('anthropic'));
    state.inputs.push('  sk-ant-1  ');
    expect(await chooseProvider(secrets as never)).toBe('anthropic');
    expect(state.global.get('provider')).toBe('anthropic');
    expect(state.secrets.get('gitglasses:ai:anthropic')).toBe('sk-ant-1');
  });

  it('asks on the first AI command, then is ready', async () => {
    stubOllama(true);
    state.picks.push(pickId('ollama'));
    const ready = await ensureAiReady(context());
    expect(ready?.id).toBe('ollama');
    expect(state.global.get('provider')).toBe('ollama');
  });
});

describe('Set AI API Key', () => {
  it('switches to the provider when none was chosen', async () => {
    state.picks.push(pickId('anthropic'));
    state.inputs.push('sk-ant');
    await setAiApiKey(secrets as never);
    expect(state.global.get('provider')).toBe('anthropic');
    expect(state.messages.at(-1)).toContain('GitGlasses AI now uses Anthropic (Claude)');
  });

  it('asks before replacing a provider the user chose', async () => {
    state.global.set('provider', 'vscode-lm');
    state.picks.push(pickId('gemini'));
    state.inputs.push('g-key');
    state.messageChoices.push('Keep Current');
    await setAiApiKey(secrets as never);
    expect(state.global.get('provider')).toBe('vscode-lm');
    expect(state.messages.at(-1)).toContain('switch to Google Gemini?');

    state.picks.push(pickId('gemini'));
    state.inputs.push('g-key-2');
    state.messageChoices.push('Use Google Gemini');
    await setAiApiKey(secrets as never);
    expect(state.global.get('provider')).toBe('gemini');
  });
});

describe('readiness before input', () => {
  it('explains a missing editor model without mentioning Copilot where it cannot be installed', async () => {
    state.global.set('provider', 'vscode-lm');
    state.messageChoices.push(undefined);
    expect(await ensureAiReady(context())).toBeUndefined();
    expect(state.messages[0]).toContain('This editor offers no language models to extensions');
    expect(state.messages[0]).not.toContain('Copilot');
  });

  it('points at signing in when Copilot Chat is installed but has no model', async () => {
    state.global.set('provider', 'vscode-lm');
    state.extensions.add('GitHub.copilot-chat');
    state.messageChoices.push(undefined);
    expect(await ensureAiReady(context())).toBeUndefined();
    expect(state.messages[0]).toContain('sign in to Copilot');
  });

  it('uses any vendor’s editor models', async () => {
    state.global.set('provider', 'vscode-lm');
    state.chatModels = [{ id: 'm1', family: 'local', name: 'Local Model', vendor: 'acme' }];
    expect((await ensureAiReady(context()))?.id).toBe('vscode-lm');
  });

  it('offers to set a missing key, then continues', async () => {
    state.global.set('provider', 'openai');
    state.messageChoices.push('Set API Key…', 'Send');
    state.inputs.push('sk-openai');
    const ready = await ensureAiReady(context());
    expect(ready?.id).toBe('openai');
    expect(state.messages[0]).toContain('No OpenAI (or compatible endpoint) API key is set');
    expect(state.messages[1]).toContain('the diff, commit messages');
  });

  it('stops when the user declines to send code to a hosted provider', async () => {
    state.global.set('provider', 'anthropic');
    state.secrets.set('gitglasses:ai:anthropic', 'k');
    state.messageChoices.push(undefined);
    expect(await ensureAiReady(context())).toBeUndefined();
  });

  it('reports Ollama not running, and can switch provider from there', async () => {
    stubOllama(false);
    state.global.set('provider', 'ollama');
    state.messageChoices.push('Choose AI Provider…', 'Send');
    state.picks.push(pickId('gemini'));
    state.inputs.push('g-key');
    const ready = await ensureAiReady(context());
    expect(state.messages[0]).toContain('Ollama is not running at http://localhost:11434');
    expect(ready?.id).toBe('gemini');
  });
});

describe('per-provider models', () => {
  it('never sends the old shared model to a different provider', async () => {
    state.global.set('provider', 'openai');
    state.global.set('model', 'gpt-4o');
    expect(modelFor('openai')).toBe('gpt-4o');
    expect(modelFor('anthropic')).toBeUndefined();

    await setProvider('anthropic');
    expect(state.global.get('openai.model')).toBe('gpt-4o');
    expect(state.global.has('model')).toBe(false);
    expect(modelFor('anthropic')).toBeUndefined();
    expect(modelFor('openai')).toBe('gpt-4o');
  });

  it('prefers a provider’s own setting', () => {
    state.global.set('provider', 'anthropic');
    state.global.set('model', 'claude-sonnet-5');
    state.global.set('anthropic.model', 'claude-haiku-5-5');
    expect(modelFor('anthropic')).toBe('claude-haiku-5-5');
  });
});

describe('editor model helpers', () => {
  const models = [
    { id: 'a', family: 'gpt-5-mini', name: 'GPT-5 mini', vendor: 'copilot' },
    { id: 'b', family: 'llama', name: 'Llama', vendor: 'ollama-bridge' },
    { id: 'c', family: 'claude', name: 'Claude', vendor: 'copilot' },
  ];

  it('prefers Copilot models and otherwise keeps the order', () => {
    expect(preferCopilot([models[1], models[0], models[2]]).map((m) => m.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('filters by id, family or name', () => {
    expect(filterModels(models, undefined)).toHaveLength(3);
    expect(filterModels(models, 'llama').map((m) => m.id)).toEqual(['b']);
    expect(filterModels(models, 'Claude').map((m) => m.id)).toEqual(['c']);
    expect(noModelMessage(false, 'x')).toContain('matches "x"');
  });
});
