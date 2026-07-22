import { describe, expect, it } from 'vitest';
import {
  aiSecretKey,
  KEYED_PROVIDER_IDS,
  requiresConsent,
} from '../src/ai/aiProvider';
import {
  ANTHROPIC_VERSION,
  buildAnthropicRequest,
  buildGeminiRequest,
  buildOllamaRequest,
  buildOpenAiRequest,
  DEFAULT_MODELS,
  extractAnthropicText,
  extractGeminiText,
  extractOllamaText,
  extractOpenAiText,
} from '../src/ai/requestBuilders';

const req = { system: 'be terse', prompt: 'explain this diff', maxTokens: 256 };

describe('buildAnthropicRequest', () => {
  it('targets the Messages API with key and version headers', () => {
    const spec = buildAnthropicRequest(req, { apiKey: 'sk-ant-test' });
    expect(spec.url).toBe('https://api.anthropic.com/v1/messages');
    expect(spec.headers['x-api-key']).toBe('sk-ant-test');
    expect(spec.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(spec.body).toEqual({
      model: DEFAULT_MODELS.anthropic,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'explain this diff' }],
      system: 'be terse',
    });
  });

  it('defaults to claude-sonnet-5 and honors a model override', () => {
    expect(DEFAULT_MODELS.anthropic).toBe('claude-sonnet-5');
    const spec = buildAnthropicRequest({ prompt: 'p' }, { apiKey: 'k', model: 'claude-opus-4-8' });
    expect((spec.body as { model: string }).model).toBe('claude-opus-4-8');
    expect((spec.body as { system?: string }).system).toBeUndefined();
  });
});

describe('buildOpenAiRequest', () => {
  it('uses bearer auth against the default endpoint', () => {
    const spec = buildOpenAiRequest(req, { apiKey: 'sk-test' });
    expect(spec.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(spec.headers.authorization).toBe('Bearer sk-test');
    expect(spec.body).toEqual({
      model: DEFAULT_MODELS.openai,
      max_tokens: 256,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'explain this diff' },
      ],
    });
  });

  it('supports custom compatible base URLs, trimming trailing slashes', () => {
    const spec = buildOpenAiRequest(req, {
      apiKey: 'k',
      baseUrl: 'https://llm.internal.example/v1/',
      model: 'qwen2.5-coder',
    });
    expect(spec.url).toBe('https://llm.internal.example/v1/chat/completions');
    expect((spec.body as { model: string }).model).toBe('qwen2.5-coder');
  });
});

describe('buildGeminiRequest', () => {
  it('puts the key in the query string and the system prompt in systemInstruction', () => {
    const spec = buildGeminiRequest(req, { apiKey: 'g-key' });
    expect(spec.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODELS.gemini}:generateContent?key=g-key`,
    );
    expect(spec.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'explain this diff' }] }],
      generationConfig: { maxOutputTokens: 256 },
      systemInstruction: { parts: [{ text: 'be terse' }] },
    });
  });
});

describe('buildOllamaRequest', () => {
  it('is keyless, non-streaming, and defaults to localhost', () => {
    const spec = buildOllamaRequest(req, {});
    expect(spec.url).toBe('http://localhost:11434/api/chat');
    expect(spec.headers.authorization).toBeUndefined();
    expect(spec.body).toEqual({
      model: DEFAULT_MODELS.ollama,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'explain this diff' },
      ],
      stream: false,
    });
  });

  it('honors host and model settings', () => {
    const spec = buildOllamaRequest({ prompt: 'p' }, { host: 'http://box:11434/', model: 'phi3' });
    expect(spec.url).toBe('http://box:11434/api/chat');
    expect((spec.body as { model: string }).model).toBe('phi3');
  });
});

describe('response extractors', () => {
  it('pull the completion text from each provider shape', () => {
    expect(
      extractAnthropicText({
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      }),
    ).toBe('part one part two');
    expect(extractOpenAiText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
    expect(
      extractGeminiText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }),
    ).toBe('ab');
    expect(extractOllamaText({ message: { content: 'local' } })).toBe('local');
  });

  it('return undefined on malformed responses', () => {
    expect(extractAnthropicText({})).toBeUndefined();
    expect(extractOpenAiText({ choices: [] })).toBeUndefined();
    expect(extractGeminiText({ candidates: [{}] })).toBeUndefined();
    expect(extractOllamaText(null)).toBeUndefined();
  });
});

describe('key names and consent', () => {
  it('maps providers to gitglasses:ai:<provider> secret keys', () => {
    expect(aiSecretKey('anthropic')).toBe('gitglasses:ai:anthropic');
    expect(aiSecretKey('openai')).toBe('gitglasses:ai:openai');
    expect(aiSecretKey('gemini')).toBe('gitglasses:ai:gemini');
  });

  it('only API-key providers are keyed; local/IDE surfaces skip consent', () => {
    expect([...KEYED_PROVIDER_IDS]).toEqual(['anthropic', 'openai', 'gemini']);
    expect(requiresConsent('anthropic')).toBe(true);
    expect(requiresConsent('openai')).toBe(true);
    expect(requiresConsent('gemini')).toBe(true);
    expect(requiresConsent('ollama')).toBe(false);
    expect(requiresConsent('vscode-lm')).toBe(false);
  });
});
