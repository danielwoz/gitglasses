// Pure request/response mapping for the HTTP AI providers. Each builder turns
// a completion request plus provider config into {url, headers, body}; each
// extractor pulls the completion text, and why the model stopped, out of the
// provider's response JSON.

import { CompletionRequest } from './aiProvider';

export interface HttpRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** What a provider's response carried. `problem` is set when the model
 *  stopped without a usable answer (refused, filtered, or out of tokens). */
export interface ExtractedCompletion {
  text?: string;
  problem?: string;
}

/** Room for the visible answer when a request does not say. */
export const DEFAULT_MAX_TOKENS = 1024;

/** Output ceiling for models that think before answering: their thinking
 *  counts against the same limit, and is billed per token generated, not per
 *  token allowed, so a generous ceiling costs nothing extra. */
export const MIN_OUTPUT_TOKENS = 8192;

export const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-6-luna',
  gemini: 'gemini-3.8-flash',
  ollama: 'gemma4',
} as const;

export const ANTHROPIC_VERSION = '2023-06-01';
/** Beta that lets a declined request be retried on the fallback model
 *  Anthropic recommends for the refusal's category. */
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function answerRoom(req: CompletionRequest): number {
  return req.maxTokens ?? DEFAULT_MAX_TOKENS;
}

// --- Anthropic Messages API -------------------------------------------------

export interface AnthropicModelTraits {
  /** Accepts output_config.effort (thinking on by default, depth by effort). */
  effort: boolean;
  /** Accepts the server-side `fallbacks` parameter. */
  fallbacks: boolean;
}

/** What a Claude model id accepts, read from its family and version. Ids the
 *  pattern does not recognise get neither, which every model accepts. */
export function anthropicModelTraits(model: string): AnthropicModelTraits {
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model);
  if (!match) return { effort: false, fallbacks: false };
  const family = match[1];
  const version = Number(match[2]) + Number(match[3] ?? 0) / 10;
  switch (family) {
    case 'fable':
      return { effort: true, fallbacks: version >= 5.1 };
    case 'mythos':
      return { effort: true, fallbacks: false };
    case 'opus':
      return { effort: version >= 4.5, fallbacks: version >= 5 };
    case 'sonnet':
      return { effort: version >= 4.6, fallbacks: version >= 5.5 };
    default:
      return { effort: version >= 5, fallbacks: false };
  }
}

export function buildAnthropicRequest(
  req: CompletionRequest,
  config: { apiKey: string; model?: string },
): HttpRequestSpec {
  const model = config.model || DEFAULT_MODELS.anthropic;
  const traits = anthropicModelTraits(model);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const body: Record<string, unknown> = {
    model,
    max_tokens: traits.effort ? Math.max(answerRoom(req), MIN_OUTPUT_TOKENS) : answerRoom(req),
    messages: [{ role: 'user', content: req.prompt }],
  };
  if (req.system) body.system = req.system;
  // These are short, focused tasks: low effort keeps thinking brief.
  if (traits.effort) body.output_config = { effort: 'low' };
  if (traits.fallbacks) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
  }
  return { url: 'https://api.anthropic.com/v1/messages', headers, body };
}

export function extractAnthropicText(response: unknown): ExtractedCompletion {
  const message = response as {
    content?: { type?: string; text?: string }[];
    stop_reason?: string;
    stop_details?: { category?: string | null } | null;
  } | null;
  if (message?.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    return { problem: `the model declined to answer${category ? ` (${category})` : ''}` };
  }
  const content = message?.content;
  const text = Array.isArray(content)
    ? content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
    : '';
  if (text) return { text };
  if (message?.stop_reason === 'max_tokens') {
    return { problem: 'the model used its whole output allowance before answering' };
  }
  return {};
}

// --- OpenAI chat completions (and compatible endpoints) ---------------------

/** OpenAI reasoning models (o-series, GPT-5 and later), which take
 *  reasoning_effort and count reasoning toward max_completion_tokens. */
export function isOpenAiReasoningModel(model: string): boolean {
  if (/^o\d/.test(model)) return true;
  const gpt = /^gpt-(\d+)/.exec(model);
  return gpt !== null && Number(gpt[1]) >= 5;
}

export function buildOpenAiRequest(
  req: CompletionRequest,
  config: { apiKey: string; model?: string; baseUrl?: string },
): HttpRequestSpec {
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });
  const base = trimTrailingSlash(config.baseUrl || DEFAULT_OPENAI_BASE_URL);
  const model = config.model || DEFAULT_MODELS.openai;
  const body: Record<string, unknown> = { model, messages };
  if (base !== DEFAULT_OPENAI_BASE_URL) {
    // Compatible servers (vLLM, LM Studio, gateways) widely accept only the
    // original parameter.
    body.max_tokens = answerRoom(req);
  } else if (isOpenAiReasoningModel(model)) {
    body.max_completion_tokens = Math.max(answerRoom(req), MIN_OUTPUT_TOKENS);
    body.reasoning_effort = 'low';
  } else {
    body.max_completion_tokens = answerRoom(req);
  }
  return {
    url: `${base}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body,
  };
}

export function extractOpenAiText(response: unknown): ExtractedCompletion {
  const choices = (
    response as {
      choices?: { finish_reason?: string; message?: { content?: string; refusal?: string } }[];
    } | null
  )?.choices;
  const choice = choices?.[0];
  const refusal = choice?.message?.refusal;
  if (typeof refusal === 'string' && refusal) {
    return { problem: `the model declined to answer: ${refusal}` };
  }
  const content = choice?.message?.content;
  if (typeof content === 'string' && content) return { text: content };
  if (choice?.finish_reason === 'length') {
    return { problem: 'the model used its whole output allowance before answering' };
  }
  if (choice?.finish_reason === 'content_filter') {
    return { problem: "the provider's content filter withheld the answer" };
  }
  return {};
}

// --- Google Gemini generateContent ------------------------------------------

/** The major version of a Gemini model id, or undefined when unrecognised. */
export function geminiMajorVersion(model: string): number | undefined {
  const match = /^gemini-(\d+)/.exec(model);
  return match ? Number(match[1]) : undefined;
}

export function buildGeminiRequest(
  req: CompletionRequest,
  config: { apiKey: string; model?: string },
): HttpRequestSpec {
  const model = config.model || DEFAULT_MODELS.gemini;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.max(answerRoom(req), MIN_OUTPUT_TOKENS),
  };
  // Gemini 3 and later take a thinking level; earlier models a budget, which
  // is left at its default.
  if ((geminiMajorVersion(model) ?? 0) >= 3) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    generationConfig,
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    // In a header, the key stays out of URLs that proxies and logs record.
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
    body,
  };
}

const GEMINI_BLOCKED = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'LANGUAGE',
  'OTHER',
]);

export function extractGeminiText(response: unknown): ExtractedCompletion {
  const result = response as {
    candidates?: {
      finishReason?: string;
      content?: { parts?: { text?: string; thought?: boolean }[] };
    }[];
    promptFeedback?: { blockReason?: string };
  } | null;
  const blockReason = result?.promptFeedback?.blockReason;
  if (blockReason) return { problem: `Gemini blocked the request (${blockReason})` };
  const candidate = result?.candidates?.[0];
  const parts = candidate?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
        .filter((part) => typeof part?.text === 'string' && part.thought !== true)
        .map((part) => part.text)
        .join('')
    : '';
  if (text) return { text };
  const finish = candidate?.finishReason;
  if (finish === 'MAX_TOKENS') {
    return { problem: 'the model used its whole output allowance before answering' };
  }
  if (finish && GEMINI_BLOCKED.has(finish)) {
    return { problem: `Gemini withheld the answer (${finish})` };
  }
  return {};
}

// --- Ollama local chat ------------------------------------------------------

export function buildOllamaRequest(
  req: CompletionRequest,
  config: { model?: string; host?: string },
): HttpRequestSpec {
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });
  return {
    url: `${trimTrailingSlash(config.host || DEFAULT_OLLAMA_HOST)}/api/chat`,
    headers: { 'content-type': 'application/json' },
    body: {
      model: config.model || DEFAULT_MODELS.ollama,
      messages,
      stream: false,
    },
  };
}

export function extractOllamaText(response: unknown): ExtractedCompletion {
  const result = response as { message?: { content?: string }; done_reason?: string } | null;
  const content = result?.message?.content;
  if (typeof content === 'string' && content) return { text: content };
  if (result?.done_reason === 'length') {
    return { problem: 'the model used its whole output allowance before answering' };
  }
  return {};
}

/** Names of the models an Ollama /api/tags response lists. */
export function ollamaModelNames(response: unknown): string[] {
  const models = (response as { models?: { name?: unknown; model?: unknown }[] } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((entry) => (typeof entry?.name === 'string' ? entry.name : entry?.model))
    .filter((name): name is string => typeof name === 'string' && name !== '');
}

/** The Ollama model to use: the configured one, else the default when it is
 *  installed, else the first installed model, else the default (whose
 *  absence Ollama then reports by name). */
export function pickOllamaModel(configured: string | undefined, installed: readonly string[]): string {
  if (configured) return configured;
  const preferred: string = DEFAULT_MODELS.ollama;
  const matches = (name: string): boolean => name === preferred || name.startsWith(`${preferred}:`);
  return installed.find(matches) ?? installed[0] ?? preferred;
}
