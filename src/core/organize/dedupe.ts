import { z } from 'zod';
import type { OrganizeJob, ReviewGroup } from '../../shared/types';
import type { FlatBookmark } from './scan';
import type { Settings } from '../storage/settings';
import { normalizeUrl, getAllMeta } from '../storage/db';
import { chatJson, resolveBinding } from '../ai/enhance';
import { buildDupConfirmMessages } from '../ai/prompts';
import { trackUsage } from '../ai/usage';
import { flattenBookmarks, getTreeDtos } from './scan';

const dupSchema = z.object({ duplicates: z.boolean() });

/** AI 确认上限：每组一次调用，防止大库爆 token */
const MAX_AI_GROUPS = 50;

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

/** 并查集：把相似对合并成组 */
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  unioned(x: string): boolean {
    return this.parent.has(x);
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * 去重扫描（一次 tick 内完成，无进度分批）：
 * 1. normalizeUrl 相同 → 精确重复组（直接确认，免 AI）
 * 2. embedding 可用时：同域名内向量余弦 > 0.90 且 URL 不同 → 语义候选组，交 AI 确认
 */
/** shouldStop：用户取消/暂停时返回 true，扫描立即中止且不覆盖任务状态 */
export async function scanDuplicates(
  settings: Settings,
  job: OrganizeJob,
  shouldStop?: () => Promise<boolean>,
): Promise<void> {
  const tree = await getTreeDtos();
  const all = flattenBookmarks(tree);
  job.total = all.length;
  // 1. 精确重复组
  const byHash = new Map<string, FlatBookmark[]>();
  for (const b of all) {
    const hash = normalizeUrl(b.url);
    const bucket = byHash.get(hash) ?? [];
    bucket.push(b);
    byHash.set(hash, bucket);
  }
  const exactGroups = [...byHash.values()].filter((members) => members.length > 1);

  // 2. 语义候选组（依赖 embedding）
  const semanticGroups: FlatBookmark[][] = [];
  const metaById = new Map((await getAllMeta()).map((m) => [m.bookmarkId, m]));
  if (settings.bindings.embedding && all.length <= 3000) {
    try {
      const { provider, model, providerId } = resolveBinding(settings, 'embedding');
      const texts = all.map((b) => {
        const meta = metaById.get(b.id);
        return meta ? `${b.title}\n${meta.summary}` : b.title;
      });
      const vectors: Array<number[] | undefined> = [];
      for (let i = 0; i < texts.length; i += 64) {
        if (await shouldStop?.()) return; // 已取消，进度与状态保持用户操作
        const batch = await provider.embed(model, texts.slice(i, i + 64));
        vectors.push(...batch);
      }
      await trackUsage(providerId);

      const byDomain = new Map<string, number[]>();
      all.forEach((b, idx) => {
        try {
          const host = new URL(b.url).host;
          const bucket = byDomain.get(host) ?? [];
          bucket.push(idx);
          byDomain.set(host, bucket);
        } catch {
          /* 非法 URL */
        }
      });

      const uf = new UnionFind();
      for (const indexes of byDomain.values()) {
        for (let i = 0; i < indexes.length; i++) {
          for (let j = i + 1; j < indexes.length; j++) {
            const a = all[indexes[i]!]!;
            const b = all[indexes[j]!]!;
            const va = vectors[indexes[i]!];
            const vb = vectors[indexes[j]!];
            // URL 已相同的在精确组里，语义组只收"URL 不同但内容相近"的
            if (va && vb && cosine(va, vb) > 0.9 && normalizeUrl(a.url) !== normalizeUrl(b.url)) {
              uf.union(a.id, b.id);
            }
          }
        }
      }
      const groupsById = new Map<string, FlatBookmark[]>();
      for (const b of all) {
        if (!uf.unioned(b.id)) continue;
        const root = uf.find(b.id);
        const bucket = groupsById.get(root) ?? [];
        bucket.push(b);
        groupsById.set(root, bucket);
      }
      semanticGroups.push(...[...groupsById.values()].filter((members) => members.length > 1));
    } catch {
      /* embedding 失败 → 仅精确去重 */
    }
  }

  // 3. 语义组交 AI 确认
  const confirmed: Array<{ id: string; items: ReviewGroup['items'] }> = [];
  let aiChecked = 0;
  let aiConfirmedCount = 0;
  for (const members of exactGroups) {
    confirmed.push({
      id: crypto.randomUUID(),
      items: members.map((m) => ({
        bookmarkId: m.id,
        title: m.title,
        url: m.url,
        folderPath: m.folderPath,
      })),
    });
  }
  for (const members of semanticGroups) {
    if (aiChecked >= MAX_AI_GROUPS) break;
    if (await shouldStop?.()) return;
    aiChecked++;
    try {
      const data = await chatJson(
        settings,
        'enhance',
        buildDupConfirmMessages(members.map((m, i) => ({ i, title: m.title, url: m.url }))),
        (raw) => dupSchema.parse(raw),
      );
      if (data.duplicates) {
        aiConfirmedCount++;
        confirmed.push({
          id: crypto.randomUUID(),
          items: members.map((m) => ({
            bookmarkId: m.id,
            title: m.title,
            url: m.url,
            folderPath: m.folderPath,
          })),
        });
      }
    } catch {
      /* AI 失败的组丢弃 */
    }
  }

  // 兜底：扫描完成时若用户已取消/暂停，不覆盖其状态
  if (await shouldStop?.()) return;

  job.done = job.total;
  job.result = {
    groups: confirmed,
    report: [
      `扫描 ${all.length} 条书签`,
      `精确重复 ${exactGroups.length} 组`,
      ...(aiChecked
        ? [`语义候选 ${aiChecked} 组，AI 确认 ${aiConfirmedCount} 组`]
        : []),
    ],
  };
  job.status = confirmed.length ? 'awaiting-review' : 'done';
}
