/**
 * Deliberately small OpenAI chat-completions request subset.
 *
 * OCM currently routes text chat to simple MLX/Ollama adapters. Silently accepting
 * tools, multimodal content or sampling controls and then ignoring them would be
 * less compatible than returning a precise 400. This module also establishes the
 * maximum completion budget the gateway reserves before dispatch.
 */
import { normalizeModelId } from './provider.mjs';

export const MAX_OUTPUT_TOKENS = 512;
const MAX_MESSAGES = 128;
const MAX_MESSAGE_CHARS = 256 * 1024;
const ALLOWED_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

/**
 * Two classes of parameter the runtimes do not implement.
 *
 * REJECTED asks for a capability the answer would silently lack: tools, structured
 * output, audio, images, several choices. A precise 400 is more compatible than a
 * plausible-looking wrong answer.
 *
 * IGNORED only shapes sampling or carries metadata. Common OpenAI clients send
 * `temperature`, `top_p`, `stop`, `user` and friends by default, and compatibility
 * with unmodified clients is the distribution strategy, so these are accepted, not
 * applied, and named in the `x-ocm-ignored-params` response header so nobody has to
 * guess. Same for a completion budget above the cap: clamped, and named in
 * `x-ocm-adjusted`.
 */
const REJECTED = [
  'audio',
  'function_call',
  'functions',
  'modalities',
  'prediction',
  'response_format',
  'tool_choice',
  'tools',
  'web_search_options',
];
const IGNORED = [
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'metadata',
  'parallel_tool_calls',
  'presence_penalty',
  'reasoning_effort',
  'seed',
  'service_tier',
  'stop',
  'store',
  'stream_options',
  'temperature',
  'top_logprobs',
  'top_p',
  'user',
  'verbosity',
];

function requestedMaxTokens(body) {
  const oldValue = body.max_tokens;
  const newValue = body.max_completion_tokens;
  if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue) {
    throw new TypeError('max_tokens and max_completion_tokens conflict');
  }
  const value = newValue ?? oldValue;
  if (value === undefined || value === null) return { maxTokens: MAX_OUTPUT_TOKENS, clamped: false };
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('max completion tokens must be a positive integer');
  }
  return value > MAX_OUTPUT_TOKENS
    ? { maxTokens: MAX_OUTPUT_TOKENS, clamped: true }
    : { maxTokens: value, clamped: false };
}

/** Text content, or an array of text parts (the multimodal shape with only text in it). */
function textContent(content, index) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length) {
    const parts = content.map((part) => {
      if (!part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
        throw new TypeError(`messages[${index}].content: only text is supported (no ${part?.type || 'non-text'} parts)`);
      }
      return part.text;
    });
    return parts.join('');
  }
  throw new TypeError(`messages[${index}].content must be text`);
}

export function normalizeChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('body must be a JSON object');
  }
  const rejected = REJECTED.filter((key) => body[key] !== undefined && body[key] !== null);
  if (rejected.length) {
    throw new TypeError(`unsupported parameter(s): ${rejected.join(', ')}`);
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    throw new TypeError('n: only one choice is supported');
  }
  const ignored = IGNORED.filter((key) => body[key] !== undefined && body[key] !== null);

  const model = normalizeModelId(body.model, 'model');
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_MESSAGES) {
    throw new TypeError(`messages must contain 1-${MAX_MESSAGES} text messages`);
  }

  const messages = body.messages.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new TypeError(`messages[${index}] must be an object`);
    }
    if (typeof message.role !== 'string' || !ALLOWED_ROLES.has(message.role)) {
      throw new TypeError(`messages[${index}].role is not supported`);
    }
    if (message.tool_calls !== undefined) {
      throw new TypeError(`messages[${index}].tool_calls: tools are not supported`);
    }
    const content = textContent(message.content, index);
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new TypeError(`messages[${index}].content is too long`);
    }
    if (message.name !== undefined
        && (typeof message.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.name))) {
      throw new TypeError(`messages[${index}].name is invalid`);
    }
    // Drop unknown message properties instead of forwarding caller-supplied objects
    // that the runtime adapters do not implement.
    return {
      role: message.role,
      content,
      ...(message.name ? { name: message.name } : {}),
    };
  });

  if (body.stream !== undefined && body.stream !== null && typeof body.stream !== 'boolean') {
    throw new TypeError('stream must be a boolean');
  }
  const { maxTokens, clamped } = requestedMaxTokens(body);

  return {
    model,
    messages,
    stream: body.stream === true,
    maxTokens,
    ignored,
    adjusted: clamped ? { max_tokens: MAX_OUTPUT_TOKENS } : null,
  };
}
