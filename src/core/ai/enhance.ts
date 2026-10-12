import { z } from 'zod';
import type { BookmarkDraft, PageContent } from '../../shared/types';
import { createClient, AiClientError, type ChatMessage } from '../providers/client';
import { buildEnhanceMessages } from './prompts';
import { trackUsage } from './usage';
import type { ModelRef, Settings } from '../storage/settings';

const draftSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(400),
  tags: z.array(z.string().min(1).max(30)).min(1).max(6),
  folder: z.string().min(1).max(200),
});

/** 从模型输出中抠出 JSON：容忍 ```json 围栏和前后废话 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中未找到 JSON 对象');
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.slice(0, 6);
}

export { normalizeTags };

export class NotConfiguredError extends Error {
  constructor(task: string) {
    super(`尚未为「${task}」配置 AI 模型，请先到设置页完成配置`);
    this.name = 'NotConfiguredError';
  }
}

export function resolveBinding(settings: Settings, task: 'enhance' | 'tldr' | 'embedding' | 'agent'): {
  provider: ReturnType<typeof createClient>;
  model: string;
  providerId: string;
} {
  const ref: ModelRef | null = settings.bindings[task];
  if (!ref) throw new NotConfiguredError(task);
  const provider = settings.providers.find((p) => p.id === ref.providerId);
  if (!provider) throw new NotConfiguredError(task);
  return { provider: createClient(provider), model: ref.model, providerId: provider.id };
}

/** 瞬时错误（超时/网络/限流/服务端故障）可安全重试 */
export function isTransientError(e: unknown): boolean {
  const err = e as Error & { status?: number };
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  if (/timed?\s*out/i.test(err?.message ?? '')) return true;
  if (err instanceof TypeError) return true; // fetch 网络失败
  const message = err?.message ?? '';
  if (err instanceof AiClientError && (err.status === 429 || (err.status ?? 0) >= 500)) return true;
  if (/\b(429|50[0-4])\b/.test(message)) return true;
  return false;
}

const RETRY_DELAYS_MS = [3_000, 10_000];

type Provider = ReturnType<typeof createClient>;
type ChatOpts = Parameters<Provider['chat']>[0];
type ChatResult = Awaited<ReturnType<Provider['chat']>>;

/** 带瞬时错误重试的 chat（指数退避 3s → 10s，共最多 3 次） */
async function chatWithRetry(provider: Provider, opts: ChatOpts): Promise<ChatResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.chat(opts);
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientError(e)) throw e;
      console.warn('[autobookmark] AI 调用瞬时失败，重试:', (e as Error).message);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * 通用 JSON 对话：发送 prompt → 解析 JSON → parse 校验，失败带错误重试一次。
 * 瞬时错误（超时/网络/限流）由 chatWithRetry 自动重试。
 * 单条收藏与整理中心的批量任务共用。
 */
export async function chatJson<T>(
  settings: Settings,
  task: 'enhance' | 'tldr',
  messages: ChatMessage[],
  parse: (raw: unknown) => T,
  opts: { repairHint?: string; temperature?: number; timeoutMs?: number } = {},
): Promise<T> {
  const { provider, model, providerId } = resolveBinding(settings, task);

  let lastOutput = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptMessages: ChatMessage[] =
      attempt === 0
        ? messages
        : [
            ...messages,
            { role: 'assistant', content: lastOutput },
            {
              role: 'user',
              content:
                opts.repairHint ??
                '上面的输出不是合法的 JSON 或缺少必填字段。请重新只输出要求的 JSON，不要其他文字。',
            },
          ];

    const { text, usage } = await chatWithRetry(provider, {
      model,
      messages: attemptMessages,
      json: true,
      temperature: opts.temperature ?? 0.2,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    await trackUsage(providerId, usage);

    try {
      return parse(extractJson(text));
    } catch (e) {
      lastOutput = text;
      if (attempt === 1) {
        throw new Error(`AI 输出无法解析：${(e as Error).message}`);
      }
    }
  }
  throw new Error('AI 未能生成有效输出，请重试');
}

/**
 * 智能收藏核心：AI 生成 { title, summary, tags, folder }。
 */
export async function enhanceBookmark(
  settings: Settings,
  page: PageContent,
  /** 存放策略为 existing 时传入已有目录路径列表，AI 从中挑目标目录 */
  existingFolders?: string[],
): Promise<BookmarkDraft> {
  const messages = buildEnhanceMessages(page, {
    language: settings.preferences.language,
    maxContentChars: settings.preferences.maxContentChars,
    existingFolders,
  });

  const data = await chatJson(settings, 'enhance', messages, (raw) =>
    draftSchema.parse(raw),
  );
  return {
    title: data.title.trim(),
    summary: data.summary.trim(),
    tags: normalizeTags(data.tags),
    folder: data.folder.trim() || '未分类',
  };
}
