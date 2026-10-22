import type { ProviderConfig } from '../storage/settings';
import { browser } from 'wxt/browser';
import { rt } from '../../shared/i18n';

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息携带的工具调用请求 */
  tool_calls?: ChatToolCall[];
  /** role='tool' 时对应请求的 id */
  tool_call_id?: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export class AiClientError extends Error {
  status?: number;
  detail?: string;
  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = 'AiClientError';
    this.status = status;
    this.detail = detail;
  }
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  /** 要求 JSON 输出（response_format: json_object） */
  json?: boolean;
  temperature?: number;
  signal?: AbortSignal;
  /** 传入则启用 SSE 流式，逐段回调 */
  onDelta?: (text: string) => void;
  /** OpenAI function calling 工具定义（agent 使用） */
  tools?: unknown[];
}

export interface ChatResult {
  text: string;
  usage?: ChatUsage;
  /** 非流式响应的完整 assistant 消息（含 tool_calls） */
  message?: { content: string | null; tool_calls?: ChatToolCall[] };
}

function authHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

async function errorFromResponse(res: Response): Promise<AiClientError> {
  let detail = '';
  try {
    const body = await res.text();
    detail = body.slice(0, 500);
  } catch {
    /* ignore */
  }
  if (res.status === 401 || res.status === 403) {
    return new AiClientError(rt('client.authFailed'), res.status, detail);
  }
  if (res.status === 429) {
    return new AiClientError(rt('client.rateLimited'), res.status, detail);
  }
  return new AiClientError(rt('client.httpStatus', { code: res.status }), res.status, detail);
}

/**
 * 统一的 OpenAI 兼容客户端：Z.ai / DeepSeek / OpenAI / Ollama 等
 * 全部走 `${baseURL}/chat/completions`、`${baseURL}/embeddings`、`${baseURL}/models`
 */
export function createClient(provider: ProviderConfig) {
  const base = provider.baseURL.replace(/\/+$/, '');
  const headers = authHeaders(provider);

  async function chat(opts: ChatOptions): Promise<ChatResult> {
    const stream = !!opts.onDelta;
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.3,
      stream,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (opts.tools?.length) body.tools = opts.tools;
    if (stream) body.stream_options = { include_usage: true };

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw await errorFromResponse(res);

    if (!stream) {
      const data = await res.json();
      const message = data.choices?.[0]?.message;
      return {
        text: message?.content ?? '',
        message: message
          ? { content: message.content ?? null, tool_calls: message.tool_calls }
          : undefined,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
            }
          : undefined,
      };
    }

    // SSE 流式解析
    if (!res.body) throw new AiClientError(rt('client.noStreamBody'));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let usage: ChatUsage | undefined;
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break outer;
        try {
          const evt = JSON.parse(payload);
          const delta: string | undefined = evt.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            opts.onDelta!(delta);
          }
          if (evt.usage) {
            usage = {
              promptTokens: evt.usage.prompt_tokens ?? 0,
              completionTokens: evt.usage.completion_tokens ?? 0,
            };
          }
        } catch {
          /* 半截 JSON，等下一块 */
        }
      }
    }
    return { text: full, usage };
  }

  async function embed(model: string, inputs: string[]): Promise<number[][]> {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: inputs }),
    });
    if (!res.ok) throw await errorFromResponse(res);
    const data = await res.json();
    const items: Array<{ index: number; embedding: number[] }> = data.data ?? [];
    return items.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async function listModels(): Promise<string[]> {
    const res = await fetch(`${base}/models`, { headers });
    if (!res.ok) throw await errorFromResponse(res);
    const data = await res.json();
    return (data.data ?? [])
      .map((m: { id?: string }) => m.id)
      .filter((id: unknown): id is string => typeof id === 'string')
      .sort();
  }

  return { chat, embed, listModels };
}

/** 供应商 API 域名的 host 权限描述，如 https://api.z.ai/* */
export function providerOriginPattern(baseURL: string): string {
  const u = new URL(baseURL);
  return `${u.protocol}//${u.host}/*`;
}

/**
 * 确保拥有供应商域名的 host 权限（带 host 权限时 fetch 不受 CORS 限制）。
 * permissions.request 需要在用户手势中调用，因此只能在扩展页面（options/popup）里调用，
 * 不能在 background 消息回调里调用。
 */
export async function ensureOriginPermission(baseURL: string): Promise<boolean> {
  const origins = [providerOriginPattern(baseURL)];
  if (await browser.permissions.contains({ origins })) return true;
  return browser.permissions.request({ origins });
}
