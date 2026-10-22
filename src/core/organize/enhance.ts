import { browser } from 'wxt/browser';
import { z } from 'zod';
import { rt } from '../../shared/i18n';
import type { BookmarkMeta, OrganizeJob } from '../../shared/types';
import type { Settings } from '../storage/settings';
import { getMeta, hashUrl, putMeta } from '../storage/db';
import { chatJson, enhanceBookmark, normalizeTags } from '../ai/enhance';
import { buildBatchEnhanceMessages } from '../ai/prompts';
import { resolveBinding } from '../ai/enhance';
import { trackUsage } from '../ai/usage';
import { computeFolderPath } from './scan';
import { fetchPageMarkdown } from './content';
import { runWithSplit } from './split';

const BATCH_SIZE = 40;
/** 批内并发路数：两路并行 chat，减少一半串行等待 */
const PARALLEL_WAYS = 2;
const BATCH_TIMEOUT_MS = 300_000;

const batchItemSchema = z.object({
  i: z.number().int(),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(300),
  tags: z.array(z.string().min(1).max(30)).min(1).max(6),
});
const batchSchema = z.object({ items: z.array(batchItemSchema) });

export interface EnhanceParams {
  ids: string[];
  /** 整理页开启且已授权全站访问时，抓取正文提升摘要质量 */
  fetchContent?: boolean;
  /** 调用失败被跳过的条数（报告展示，可补跑） */
  skipped?: number;
}

/** 批量补全：每批 20 条，写 IndexedDB 元数据（不动书签本身）；整批失败自动对半拆分 */
export async function processEnhanceBatch(settings: Settings, job: OrganizeJob): Promise<void> {
  const params = job.params as unknown as EnhanceParams;
  params.skipped ??= 0;
  const slice = params.ids.slice(job.done, job.done + BATCH_SIZE);
  if (!slice.length) return;

  const nodes = await Promise.all(
    slice.map((id) => browser.bookmarks.get(id).then((r) => r[0]).catch(() => undefined)),
  );

  // 可选正文抓取（并发 4，失败静默降级为标题+URL）
  const excerpts = new Map<string, string>();
  if (params.fetchContent) {
    for (let i = 0; i < nodes.length; i += 4) {
      await Promise.all(
        nodes.slice(i, i + 4).map(async (node) => {
          if (!node?.url || excerpts.has(node.id)) return;
          const markdown = await fetchPageMarkdown(node.url);
          excerpts.set(node.id, markdown.slice(0, 400));
        }),
      );
    }
  }

  interface Entry {
    node: { id: string; title: string; url: string; parentId?: string };
    excerpt: string;
  }
  const entries: Entry[] = nodes
    .filter((node): node is NonNullable<typeof node> & { url: string } => !!node?.url)
    .map((node) => ({ node, excerpt: excerpts.get(node.id) ?? '' }));

  const skippedEntries: Entry[] = [];
  const enhanceEntries = async (sub: Entry[]): Promise<void> => {
      const messages = buildBatchEnhanceMessages(
        sub.map((x, i) => ({ i, title: x.node.title, url: x.node.url, excerpt: x.excerpt })),
        { language: settings.preferences.language },
      );
      const data = await chatJson(settings, 'enhance', messages, (raw) => batchSchema.parse(raw), {
        repairHint:
          '请重新只输出 JSON：{"items": [{"i": 数字, "title": "...", "summary": "...", "tags": ["..."]}, ...]}，i 必须覆盖输入的每一行。',
        timeoutMs: BATCH_TIMEOUT_MS,
      });

      const metas: BookmarkMeta[] = [];
      for (const item of data.items) {
        const entry = sub[item.i];
        if (!entry?.node.url) continue;
        metas.push({
          bookmarkId: entry.node.id,
          url: entry.node.url,
          urlHash: await hashUrl(entry.node.url),
          title: entry.node.title, // 不覆盖书签标题，仅记录
          originalTitle: entry.node.title,
          summary: item.summary.trim(),
          tags: normalizeTags(item.tags),
          folderPath: await computeFolderPath(entry.node.parentId),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      // 有 embedding 绑定时批量生成向量（一次调用）
      if (settings.bindings.embedding && metas.length) {
        try {
          const { provider, model, providerId } = resolveBinding(settings, 'embedding');
          const vectors = await provider.embed(
            model,
            metas.map((m) => `${m.title}\n${m.summary}\n${m.tags.join(' ')}`),
          );
          await trackUsage(providerId);
          metas.forEach((m, i) => {
            if (vectors[i]) {
              m.embedding = vectors[i]!;
              m.embeddingModel = model;
            }
          });
        } catch {
          /* embedding 可选 */
        }
      }

      for (const meta of metas) await putMeta(meta);
    };
  // 对半两路并发，各自保留"失败再对半"的降级能力
  const half = Math.ceil(entries.length / 2);
  await Promise.all([
    runWithSplit(entries.slice(0, half), enhanceEntries, { onSkipped: (sub) => skippedEntries.push(...sub) }),
    runWithSplit(entries.slice(half), enhanceEntries, { onSkipped: (sub) => skippedEntries.push(...sub) }),
  ]);
  params.skipped += skippedEntries.length;

  job.done += slice.length;
}

/** 单条增强（列表里的"AI 增强"按钮）：复用单条收藏管线，不创建书签 */
export async function enhanceSingle(
  settings: Settings,
  bookmarkId: string,
): Promise<BookmarkMeta> {
  const node = (await browser.bookmarks.get(bookmarkId).catch(() => []))[0];
  if (!node?.url) throw new Error(rt('err.bookmarkNotFound'));
  const existing = await getMeta(bookmarkId);

  const page = {
    url: node.url,
    title: node.title,
    siteName: new URL(node.url).host,
    byline: '',
    excerpt: '',
    content: '',
    selection: '',
    extractedAt: Date.now(),
  };
  const draft = await enhanceBookmark(settings, page);

  const meta: BookmarkMeta = {
    bookmarkId,
    url: node.url,
    urlHash: await hashUrl(node.url),
    title: node.title,
    originalTitle: node.title,
    summary: draft.summary,
    tags: draft.tags,
    folderPath: await computeFolderPath(node.parentId),
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };

  if (settings.bindings.embedding) {
    try {
      const { provider, model, providerId } = resolveBinding(settings, 'embedding');
      const [vector] = await provider.embed(model, [
        `${meta.title}\n${meta.summary}\n${meta.tags.join(' ')}`,
      ]);
      await trackUsage(providerId);
      if (vector) {
        meta.embedding = vector;
        meta.embeddingModel = model;
      }
    } catch {
      /* embedding 可选 */
    }
  }

  await putMeta(meta);
  return meta;
}
