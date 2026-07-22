// Pure request/response mapping for the HTTP AI providers. Each builder turns
// a completion request plus provider config into {url, headers, body}; each
// extractor pulls the completion text out of the provider's response JSON.

import { CompletionRequest } from './aiProvider';

export interface HttpRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export const DEFAULT_MAX_TOKENS = 1024;

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.1',
} as const;

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// --- Anthropic Messages API -------------------------------------------------

export function buildAnthropicRequest(
  req: CompletionRequest,
  config: { apiKey: string; model?: string },
): HttpRequestSpec {
  const body: Record<string, unknown> = {
    model: config.model || DEFAULT_MODELS.anthropic,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content: req.prompt }],
  };
  if (req.system) body.system = req.system;
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body,
  };
}

export function extractAnthropicText(response: unknown): string | undefined {
  const content = (response as { content?: { type?: string; text?: string }[] })?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block) => typeof block?.text === 'string')
    .map((block) => block.text)
    .join('');
  return text || undefined;
}

// --- OpenAI chat completions (and compatible endpoints) ---------------------

export function buildOpenAiRequest(
  req: CompletionRequest,
  config: { apiKey: string; model?: string; baseUrl?: string },
): HttpRequestSpec {
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });
  const base = trimTrailingSlash(config.baseUrl || DEFAULT_OPENAI_BASE_URL);
  return {
    url: `${base}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: {
      model: config.model || DEFAULT_MODELS.openai,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    },
  };
}

export function extractOpenAiText(response: unknown): string | undefined {
  const choices = (response as { choices?: { message?: { content?: string } }[] })?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' && content ? content : undefined;
}

// --- Google Gemini generateContent ------------------------------------------

export function buildGeminiRequest(
  req: CompletionRequest,
  config: { apiKey: string; model?: string },
): HttpRequestSpec {
  const model = config.model || DEFAULT_MODELS.gemini;
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    generationConfig: { maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
    headers: { 'content-type': 'application/json' },
    body,
  };
}

export function extractGeminiText(response: unknown): string | undefined {
  const candidates = (
    response as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  )?.candidates;
  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('');
  return text || undefined;
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

export function extractOllamaText(response: unknown): string | undefined {
  const content = (response as { message?: { content?: string } })?.message?.content;
  return typeof content === 'string' && content ? content : undefined;
}
