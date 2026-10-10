import { Document } from 'flexsearch';
import type { SearchResultItem } from '../../shared/types';
import { getAllMeta } from '../storage/db';
import type { Settings } from '../storage/settings';
import { resolveBinding } from '../ai/enhance';
import { trackUsage } from '../ai/usage';

/**
 * 混合搜索：FlexSearch 关键词 + 供应商 embedding 余弦相似度，RRF 融合。
 * 索引为内存态，service worker 休眠后按需重建（数千条书签重建 <100ms）。
 * 未配置 embedding（如纯 DeepSeek）时自动退化为纯关键词搜索。
 */

const FIELDS = ['title', 'summary', 'tags'] as const;

let keywordIndex: Document | null = null;
let metaById = new Map<string, SearchResultItem>();
let indexPromise: Promise<void> | null = null;

async function rebuildIndex(): Promise<void> {
  const all = await getAllMeta();
  metaById = new Map(all.map((m) => [m.bookmarkId, { ...m }]));
  const index = new Document({
    document: {
      id: 'bookmarkId',
      index: [
        { field: 'title', tokenize: 'forward' },
        { field: 'summary', tokenize: 'forward' },
        { field: 'tags', tokenize: 'forward' },
      ],
    },
  });
  for (const meta of all) {
    index.add(meta.bookmarkId, {
      bookmarkId: meta.bookmarkId,
      title: meta.title,
      summary: meta.summary,
      tags: meta.tags.join(' '),
    });
  }
  keywordIndex = index;
}

async function ensureIndex(): Promise<void> {
  indexPromise ??= rebuildIndex().catch((e) => {
    indexPromise = null;
    throw e;
  });
  await indexPromise;
}

/** 书签事件 / 新增保存后调用，下次搜索时重建索引 */
export function invalidateSearchIndex(): void {
  keywordIndex = null;
  metaById = new Map();
  indexPromise = null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** flexsearch Document.search 的重载类型非常挑，运行时按 (query, options) 调用即可 */
type LooseSearch = (query: string, options: Record<string, unknown>) => unknown;

/** 从 Document.search 的返回里拆出 id 列表（可能扁平，也可能带 {field, result} 包装） */
function unwrapIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      ids.push(item);
    } else if (item && typeof item === 'object' && Array.isArray((item as { result?: unknown }).result)) {
      for (const id of (item as { result: unknown[] }).result) ids.push(String(id));
    }
  }
  return ids;
}

const HAS_CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

async function keywordSearch(query: string, limit: number): Promise<string[]> {
  // FlexSearch 的分词器对中文子串召回不可靠：CJK 查询直接对内存元数据做子串匹配，
  // 千级书签的线性扫描 <1ms，且行为可预期（"测试" 能命中 "冒烟测试书签"）
  if (HAS_CJK.test(query)) {
    const q = query.toLowerCase();
    const hits: string[] = [];
    for (const meta of metaById.values()) {
      const haystack = `${meta.title}\n${meta.summary}\n${meta.tags.join(' ')}`.toLowerCase();
      if (haystack.includes(q)) hits.push(meta.bookmarkId);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  if (!keywordIndex) return [];
  const ranks = new Map<string, number>();
  const search = keywordIndex.search.bind(keywordIndex) as unknown as LooseSearch;
  for (const field of FIELDS) {
    let ids: string[] = [];
    try {
      ids = unwrapIds(search(query, { field, limit }));
    } catch {
      /* 单字段失败不影响其他字段 */
    }
    for (const id of ids) ranks.set(id, (ranks.get(id) ?? 0) + 1);
  }
  return [...ranks.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function semanticSearch(
  settings: Settings,
  query: string,
  limit: number,
): Promise<string[]> {
  try {
    const { provider, model, providerId } = resolveBinding(settings, 'embedding');
    const [queryVector] = await provider.embed(model, [query]);
    await trackUsage(providerId);
    if (!queryVector) return [];
    const scored: Array<{ id: string; score: number }> = [];
    for (const meta of metaById.values()) {
      if (meta.embedding) {
        scored.push({ id: meta.bookmarkId, score: cosine(queryVector, meta.embedding) });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.id);
  } catch {
    return [];
  }
}

/** Reciprocal Rank Fusion */
function rrfFuse(
  keyword: string[],
  semantic: string[],
  limit: number,
): Array<{ id: string; matchedBy: 'keyword' | 'semantic' | 'both' }> {
  const K = 60;
  const scores = new Map<string, { score: number; fromK: boolean; fromS: boolean }>();
  keyword.forEach((id, rank) => {
    const e = scores.get(id) ?? { score: 0, fromK: false, fromS: false };
    e.score += 1 / (K + rank + 1);
    e.fromK = true;
    scores.set(id, e);
  });
  semantic.forEach((id, rank) => {
    const e = scores.get(id) ?? { score: 0, fromK: false, fromS: false };
    e.score += 1 / (K + rank + 1);
    e.fromS = true;
    scores.set(id, e);
  });
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([id, e]) => ({
      id,
      matchedBy:
        e.fromK && e.fromS ? ('both' as const) : e.fromK ? ('keyword' as const) : ('semantic' as const),
    }));
}

export async function searchBookmarks(
  settings: Settings,
  query: string,
): Promise<SearchResultItem[]> {
  await ensureIndex();
  const q = query.trim();
  if (!q) return [];

  const [kwIds, semIds] = await Promise.all([
    keywordSearch(q, 30),
    semanticSearch(settings, q, 30),
  ]);
  const results: SearchResultItem[] = [];
  for (const { id, matchedBy } of rrfFuse(kwIds, semIds, 20)) {
    const meta = metaById.get(id);
    if (meta) results.push({ ...meta, matchedBy });
  }
  return results;
}

/** 最近收藏（空查询时侧边栏默认视图） */
export async function listRecent(limit = 100): Promise<SearchResultItem[]> {
  await ensureIndex();
  return [...metaById.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((m) => ({ ...m }));
}
