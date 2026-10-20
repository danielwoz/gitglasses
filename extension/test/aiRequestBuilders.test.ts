import { describe, expect, it } from 'vitest';
import { aiSecretKey, FetchFn, KEYED_PROVIDER_IDS } from '../src/ai/aiProvider';
import { executeHttpCompletion } from '../src/ai/httpClient';
import {
  ANTHROPIC_FALLBACK_BETA,
  ANTHROPIC_VERSION,
  anthropicModelTraits,
  buildAnthropicRequest,
  buildGeminiRequest,
  buildOllamaRequest,
  buildOpenAiRequest,
  DEFAULT_MODELS,
  extractAnthropicText,
  extractGeminiText,
  extractOllamaText,
  extractOpenAiText,
  geminiMajorVersion,
  isOpenAiReasoningModel,
  MIN_OUTPUT_TOKENS,
  ollamaModelNames,
  pickOllamaModel,
} from '../src/ai/requestBuilders';

const req = { system: 'be terse', prompt: 'explain this diff', maxTokens: 256 };

describe('default models', () => {
  it('are current generally available models', () => {
    expect(DEFAULT_MODELS).toEqual({
      anthropic: 'claude-opus-5-5',
      openai: 'gpt-6-luna',
      gemini: 'gemini-3.8-flash',
      ollama: 'gemma4',
    });
  });
});

describe('buildAnthropicRequest', () => {
  it('targets the Messages API with key, version and fallback headers', () => {
    const spec = buildAnthropicRequest(req, { apiKey: 'sk-ant-test' });
    expect(spec.url).toBe('https://api.anthropic.com/v1/messages');
    expect(spec.headers['x-api-key']).toBe('sk-ant-test');
    expect(spec.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(spec.headers['anthropic-beta']).toBe(ANTHROPIC_FALLBACK_BETA);
    expect(spec.body).toEqual({
      model: 'claude-opus-5-5',
      // Thinking counts against max_tokens, so short answers still get room.
      max_tokens: MIN_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: 'explain this diff' }],
      system: 'be terse',
      output_config: { effort: 'low' },
      fallbacks: 'default',
    });
  });

  it('sends effort and fallbacks only to models that accept them', () => {
    const haiku45 = buildAnthropicRequest({ prompt: 'p', maxTokens: 300 }, {
      apiKey: 'k',
      model: 'claude-haiku-4-5',
    });
    expect(haiku45.body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: 'p' }],
    });
    expect(haiku45.headers['anthropic-beta']).toBeUndefined();

    const haiku55 = buildAnthropicRequest({ prompt: 'p' }, { apiKey: 'k', model: 'claude-haiku-5-5' });
    expect((haiku55.body as Record<string, unknown>).output_config).toEqual({ effort: 'low' });
    expect((haiku55.body as Record<string, unknown>).fallbacks).toBeUndefined();
  });

  it('reads model traits from the id', () => {
    expect(anthropicModelTraits('claude-opus-5-5')).toEqual({ effort: true, fallbacks: true });
    expect(anthropicModelTraits('claude-opus-5')).toEqual({ effort: true, fallbacks: true });
    expect(anthropicModelTraits('claude-sonnet-5-5')).toEqual({ effort: true, fallbacks: true });
    expect(anthropicModelTraits('claude-sonnet-5')).toEqual({ effort: true, fallbacks: false });
    expect(anthropicModelTraits('claude-sonnet-4-6')).toEqual({ effort: true, fallbacks: false });
    expect(anthropicModelTraits('claude-sonnet-4-5')).toEqual({ effort: false, fallbacks: false });
    expect(anthropicModelTraits('claude-opus-4-5')).toEqual({ effort: true, fallbacks: false });
    expect(anthropicModelTraits('claude-haiku-4-5')).toEqual({ effort: false, fallbacks: false });
    expect(anthropicModelTraits('claude-haiku-5-5')).toEqual({ effort: true, fallbacks: false });
    expect(anthropicModelTraits('claude-fable-5-1')).toEqual({ effort: true, fallbacks: true });
    // A dated snapshot's date is not a minor version.
    expect(anthropicModelTraits('claude-sonnet-4-20250514')).toEqual({
      effort: false,
      fallbacks: false,
    });
    expect(anthropicModelTraits('claude-3-5-haiku-latest')).toEqual({
      effort: false,
      fallbacks: false,
    });
  });
});

describe('buildOpenAiRequest', () => {
  it('sends max_completion_tokens and low reasoning effort to current models', () => {
    const spec = buildOpenAiRequest(req, { apiKey: 'sk-test' });
    expect(spec.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(spec.headers.authorization).toBe('Bearer sk-test');
    expect(spec.body).toEqual({
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'explain this diff' },
      ],
      max_completion_tokens: MIN_OUTPUT_TOKENS,
      reasoning_effort: 'low',
    });
    expect((spec.body as Record<string, unknown>).max_tokens).toBeUndefined();
  });

  it('keeps non-reasoning models to the requested room, without reasoning_effort', () => {
    const spec = buildOpenAiRequest(req, { apiKey: 'k', model: 'gpt-4.1-mini' });
    expect(spec.body).toMatchObject({ max_completion_tokens: 256 });
    expect((spec.body as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('recognises reasoning models', () => {
    expect(isOpenAiReasoningModel('o3-mini')).toBe(true);
    expect(isOpenAiReasoningModel('gpt-5-mini')).toBe(true);
    expect(isOpenAiReasoningModel('gpt-6.1-sol')).toBe(true);
    expect(isOpenAiReasoningModel('gpt-4o-mini')).toBe(false);
    expect(isOpenAiReasoningModel('qwen2.5-coder')).toBe(false);
  });

  it('uses max_tokens with custom compatible base URLs, trimming trailing slashes', () => {
    const spec = buildOpenAiRequest(req, {
      apiKey: 'k',
      baseUrl: 'https://llm.internal.example/v1/',
      model: 'qwen2.5-coder',
    });
    expect(spec.url).toBe('https://llm.internal.example/v1/chat/completions');
    expect(spec.body).toEqual({
      model: 'qwen2.5-coder',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'explain this diff' },
      ],
      max_tokens: 256,
    });
  });
});

describe('buildGeminiRequest', () => {
  it('sends the key in a header, never the URL, and a low thinking level', () => {
    const spec = buildGeminiRequest(req, { apiKey: 'g-key' });
    expect(spec.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    expect(spec.url).not.toContain('g-key');
    expect(spec.headers['x-goog-api-key']).toBe('g-key');
    expect(spec.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'explain this diff' }] }],
      generationConfig: {
        maxOutputTokens: MIN_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: 'low' },
      },
      systemInstruction: { parts: [{ text: 'be terse' }] },
    });
  });

  it('leaves thinking alone on models before Gemini 3', () => {
    const spec = buildGeminiRequest(req, { apiKey: 'k', model: 'gemini-2.5-flash' });
    expect(spec.body).toMatchObject({ generationConfig: { maxOutputTokens: MIN_OUTPUT_TOKENS } });
    expect(
      (spec.body as { generationConfig: Record<string, unknown> }).generationConfig.thinkingConfig,
    ).toBeUndefined();
    expect(geminiMajorVersion('gemini-3.8-flash')).toBe(3);
    expect(geminiMajorVersion('learnlm-2')).toBeUndefined();
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

  it('picks an installed model when none is configured', () => {
    expect(ollamaModelNames({ models: [{ name: 'qwen3:8b' }, { model: 'gemma4:latest' }] })).toEqual([
      'qwen3:8b',
      'gemma4:latest',
    ]);
    expect(ollamaModelNames({})).toEqual([]);
    expect(pickOllamaModel('mine', ['gemma4:latest'])).toBe('mine');
    expect(pickOllamaModel(undefined, ['qwen3:8b', 'gemma4:latest'])).toBe('gemma4:latest');
    expect(pickOllamaModel(undefined, ['qwen3:8b'])).toBe('qwen3:8b');
    expect(pickOllamaModel(undefined, [])).toBe('gemma4');
  });
});

describe('response extractors', () => {
  it('pull the completion text from each provider shape', () => {
    expect(
      extractAnthropicText({
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'part one ' },
          { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
          { type: 'text', text: 'part two' },
        ],
        stop_reason: 'end_turn',
      }),
    ).toEqual({ text: 'part one part two' });
    expect(extractOpenAiText({ choices: [{ message: { content: 'hi' } }] })).toEqual({ text: 'hi' });
    expect(
      extractGeminiText({
        candidates: [
          { content: { parts: [{ text: 'thinking…', thought: true }, { text: 'a' }, { text: 'b' }] } },
        ],
      }),
    ).toEqual({ text: 'ab' });
    expect(extractOllamaText({ message: { content: 'local' } })).toEqual({ text: 'local' });
  });

  it('explain why there is no answer', () => {
    expect(extractAnthropicText({ content: [], stop_reason: 'max_tokens' }).problem).toMatch(
      /output allowance/,
    );
    expect(
      extractAnthropicText({
        content: [],
        stop_reason: 'refusal',
        stop_details: { category: 'cyber' },
      }).problem,
    ).toBe('the model declined to answer (cyber)');
    expect(
      extractOpenAiText({ choices: [{ finish_reason: 'length', message: { content: '' } }] })
        .problem,
    ).toMatch(/output allowance/);
    expect(
      extractOpenAiText({ choices: [{ message: { content: null, refusal: 'no' } }] }).problem,
    ).toBe('the model declined to answer: no');
    expect(
      extractOpenAiText({ choices: [{ finish_reason: 'content_filter', message: {} }] }).problem,
    ).toMatch(/content filter/);
    expect(extractGeminiText({ candidates: [{ finishReason: 'MAX_TOKENS' }] }).problem).toMatch(
      /output allowance/,
    );
    expect(extractGeminiText({ candidates: [{ finishReason: 'SAFETY' }] }).problem).toBe(
      'Gemini withheld the answer (SAFETY)',
    );
    expect(extractGeminiText({ promptFeedback: { blockReason: 'OTHER' } }).problem).toBe(
      'Gemini blocked the request (OTHER)',
    );
    expect(extractOllamaText({ message: { content: '' }, done_reason: 'length' }).problem).toMatch(
      /output allowance/,
    );
  });

  it('return nothing on malformed responses', () => {
    expect(extractAnthropicText({})).toEqual({});
    expect(extractOpenAiText({ choices: [] })).toEqual({});
    expect(extractGeminiText({ candidates: [{}] })).toEqual({});
    expect(extractOllamaText(null)).toEqual({});
  });
});

describe('executeHttpCompletion', () => {
  const spec = buildAnthropicRequest({ prompt: 'p' }, { apiKey: 'k' });
  const respond =
    (status: number, body: unknown): FetchFn =>
    async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

  it('returns the text of a complete answer', async () => {
    const fetchFn = respond(200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    await expect(executeHttpCompletion(spec, extractAnthropicText, fetchFn)).resolves.toBe('ok');
  });

  it('reports a refusal or an exhausted output allowance instead of an empty answer', async () => {
    await expect(
      executeHttpCompletion(spec, extractAnthropicText, respond(200, { content: [], stop_reason: 'refusal' })),
    ).rejects.toThrow('No answer: the model declined to answer.');
    await expect(
      executeHttpCompletion(
        spec,
        extractAnthropicText,
        respond(200, { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'max_tokens' }),
      ),
    ).rejects.toThrow(/output allowance/);
  });

  it('names the server it could not reach', async () => {
    const offline: FetchFn = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(executeHttpCompletion(spec, extractAnthropicText, offline)).rejects.toThrow(
      'could not reach https://api.anthropic.com (fetch failed)',
    );
  });

  it('surfaces HTTP errors with the body', async () => {
    await expect(
      executeHttpCompletion(spec, extractAnthropicText, respond(401, { error: 'bad key' })),
    ).rejects.toThrow('AI request failed (HTTP 401)');
  });
});

describe('key names', () => {
  it('maps providers to gitglasses:ai:<provider> secret keys', () => {
    expect([...KEYED_PROVIDER_IDS]).toEqual(['anthropic', 'openai', 'gemini']);
    expect(aiSecretKey('anthropic')).toBe('gitglasses:ai:anthropic');
    expect(aiSecretKey('openai')).toBe('gitglasses:ai:openai');
    expect(aiSecretKey('gemini')).toBe('gitglasses:ai:gemini');
  });
});
