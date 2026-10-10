import { browser } from 'wxt/browser';
import { z } from 'zod';
import type { OrganizeJob, UndoEntry } from '../../shared/types';
import type { Settings } from '../storage/settings';
import { chatJson } from '../ai/enhance';
import { buildAssignMessages, buildClusterMessages } from '../ai/prompts';
import { flattenBookmarks, getTreeDtos } from './scan';
import { runWithSplit } from './split';

const CLUSTER_BATCH = 80;
const ASSIGN_BATCH = 60;
const MOVE_BATCH = 25;
const BATCH_TIMEOUT_MS = 300_000;

export interface ClassifyParams {
  scope: 'toolbar' | 'other' | 'all';
  maxCategories: number;
  progress: {
    phase: 'cluster' | 'assign' | 'execute' | 'sweep';
    cursor: number;
    categories: string[];
    assignments: Record<string, string>;
    createdFolderIds: string[];
    oldFolderIds: string[];
    removedFolders: number;
  };
  items: Array<{ id: string; title: string; url: string }>;
  rootId: string;
}

const clusterSchema = z.object({ categories: z.array(z.string().min(1).max(24)).min(1).max(16) });
const assignSchema = z.object({
  assignments: z.array(z.object({ i: z.number().int(), category: z.string().min(1).max(24) })),
});

/** 范围对应的根节点 id（书签栏 / 其他书签） */
async function resolveScopeRootId(scope: ClassifyParams['scope']): Promise<string> {
  const tree = await getTreeDtos();
  // Chrome: children[0]=书签栏 children[1]=其他书签（getTreeDtos 已去掉总根）
  const toolbar = tree[0]?.id ?? '1';
  const other = tree[1]?.id ?? '2';
  return scope === 'toolbar' ? toolbar : other;
}

/** 收集整理范围（跳过"AI 收藏"子树与已增强项可选） */
export async function prepareClassify(job: OrganizeJob, settings: Settings): Promise<void> {
  void settings;
  const params = job.params as unknown as Partial<ClassifyParams>;
  const scope = params.scope ?? 'all';
  const tree = await getTreeDtos();
  const scopeNodes = tree.filter((_, idx) =>
    scope === 'all' ? true : scope === 'toolbar' ? idx === 0 : idx === 1,
  );

  // 旧文件夹快照（清空后可删）；跳过根级"AI 收藏"
  const oldFolderIds: string[] = [];
  const collectFolders = (nodes: typeof tree, inScopeRoot: boolean): void => {
    for (const node of nodes) {
      if (node.url) continue;
      if (inScopeRoot && node.title === 'AI 收藏') continue;
      oldFolderIds.push(node.id);
      collectFolders(node.children, false);
    }
  };
  collectFolders(scopeNodes ?? [], true);

  const items = flattenBookmarks(scopeNodes ?? [], ['AI 收藏']).map((b) => ({
    id: b.id,
    title: b.title,
    url: b.url,
  }));

  const full: ClassifyParams = {
    scope,
    maxCategories: params.maxCategories ?? 12,
    items,
    rootId: await resolveScopeRootId(scope),
    progress: {
      phase: 'cluster',
      cursor: 0,
      categories: [],
      assignments: {},
      createdFolderIds: [],
      oldFolderIds,
      removedFolders: 0,
    },
  };
  job.params = full as unknown as Record<string, unknown>;
  const batches =
    Math.ceil(items.length / CLUSTER_BATCH) +
    Math.ceil(items.length / ASSIGN_BATCH) +
    Math.ceil(items.length / MOVE_BATCH) +
    1 /* sweep */;
  job.total = batches;
  job.done = 0;
}

async function ensureFolder(
  rootId: string,
  title: string,
  createdIds: string[],
  undoLog: UndoEntry[],
): Promise<string> {
  const children = await browser.bookmarks.getChildren(rootId);
  const existing = children.find((c) => !c.url && c.title === title);
  if (existing) return existing.id;
  const node = await browser.bookmarks.create({ parentId: rootId, title });
  createdIds.push(node.id);
  undoLog.push({ op: 'create-folder', id: node.id });
  return node.id;
}

/** 分类任务推进一批：按 phase 分发 */
export async function processClassifyBatch(settings: Settings, job: OrganizeJob): Promise<void> {
  const params = job.params as unknown as ClassifyParams;
  const p = params.progress;

  if (p.phase === 'cluster') {
    const slice = params.items.slice(p.cursor, p.cursor + CLUSTER_BATCH);
    if (!slice.length) {
      // 归并类目：频次排序，截断到 maxCategories，其余并入「其他」
      const freq = new Map<string, number>();
      for (const c of p.categories) freq.set(c, (freq.get(c) ?? 0) + 1);
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
      p.categories = sorted.slice(0, Math.max(3, params.maxCategories));
      p.phase = 'assign';
      p.cursor = 0;
      return;
    }
    await runWithSplit(
      slice,
      async (sub) => {
        const data = await chatJson(
          settings,
          'enhance',
          buildClusterMessages(sub.map((x, idx) => ({ i: idx, title: x.title, url: x.url }))),
          (raw) => clusterSchema.parse(raw),
          { timeoutMs: BATCH_TIMEOUT_MS },
        );
        for (const c of data.categories) {
          const name = c.trim();
          if (name && name !== '未定') p.categories.push(name);
        }
      },
      // 聚类失败的小批直接放弃——类目来自其他批，无致命影响
    );
    p.cursor += slice.length;
    job.done++;
    return;
  }

  if (p.phase === 'assign') {
    const slice = params.items.slice(p.cursor, p.cursor + ASSIGN_BATCH);
    if (!slice.length) {
      p.phase = 'execute';
      p.cursor = 0;
      return;
    }
    const categories = [...new Set([...p.categories, '未定'])];
    const assignSub = async (sub: typeof slice): Promise<void> => {
      const data = await chatJson(
        settings,
        'enhance',
        buildAssignMessages(sub.map((x, idx) => ({ i: idx, title: x.title, url: x.url })), categories),
        (raw) => assignSchema.parse(raw),
        { timeoutMs: BATCH_TIMEOUT_MS },
      );
      const byIndex = new Map(sub.map((x, i) => [i, x]));
      for (const a of data.assignments) {
        const item = byIndex.get(a.i);
        if (!item) continue;
        p.assignments[item.id] = categories.includes(a.category) ? a.category : '未定';
      }
    };
    // 归类失败的小批保持未分配 → 计入"未归类保留原地"；对半两路并发
    const half = Math.ceil(slice.length / 2);
    await Promise.all([
      runWithSplit(slice.slice(0, half), assignSub),
      runWithSplit(slice.slice(half), assignSub),
    ]);
    p.cursor += slice.length;
    job.done++;
    return;
  }

  if (p.phase === 'execute') {
    const movable = params.items.filter(
      (x) => p.assignments[x.id] && p.assignments[x.id] !== '未定',
    );
    const slice = movable.slice(p.cursor, p.cursor + MOVE_BATCH);
    if (!slice.length) {
      p.phase = 'sweep';
      p.cursor = 0;
      return;
    }
    const folderIds = new Map<string, string>();
    const categories = new Set(
      slice.map((x) => p.assignments[x.id]).filter((c): c is string => !!c),
    );
    for (const category of categories) {
      folderIds.set(
        category,
        await ensureFolder(params.rootId, category, p.createdFolderIds, job.undoLog),
      );
    }
    for (const item of slice) {
      const assignment = p.assignments[item.id];
      if (!assignment) continue;
      const target = folderIds.get(assignment);
      if (!target) continue;
      const node = (await browser.bookmarks.get(item.id).catch(() => []))[0];
      if (!node) continue; // 已被用户删除
      const siblings = await browser.bookmarks.getChildren(node.parentId ?? '');
      const index = siblings.findIndex((s) => s.id === node.id);
      job.undoLog.push({ op: 'move', id: item.id, fromParentId: node.parentId ?? '', index: Math.max(0, index) });
      await browser.bookmarks.move(item.id, { parentId: target });
    }
    p.cursor += slice.length;
    job.done++;
    return;
  }

  // sweep：删除整理后变空的旧文件夹（不含本次新建的、根节点）
  const sweepFrom = p.cursor;
  const candidates = p.oldFolderIds
    .filter((id) => !p.createdFolderIds.includes(id))
    .slice(sweepFrom, sweepFrom + MOVE_BATCH * 2);
  for (const id of candidates) {
    try {
      const children = await browser.bookmarks.getChildren(id);
      if (children.length === 0) {
        const node = (await browser.bookmarks.get(id))[0];
        if (!node?.parentId) continue;
        await browser.bookmarks.remove(id);
        job.undoLog.push({ op: 'remove', parentId: node.parentId, title: node.title, folderId: id });
        p.removedFolders++;
      }
    } catch {
      /* 可能已被用户删除 */
    }
    p.cursor++;
  }
  if (candidates.length) job.done++;
  if (candidates.length < MOVE_BATCH * 2) {
    // 结束：生成报告
    const assigned = Object.values(p.assignments).filter((c) => c !== '未定').length;
    const undecided = params.items.length - assigned;
    job.result = {
      report: [
        `已建 ${p.createdFolderIds.length} 个分类文件夹（${p.categories.slice(0, 8).join('、')}${p.categories.length > 8 ? '…' : ''}）`,
        `已移动 ${assigned} 条书签`,
        `未归类 ${undecided} 条保留原地`,
        `清理空文件夹 ${p.removedFolders} 个`,
      ],
    };
  }
}
