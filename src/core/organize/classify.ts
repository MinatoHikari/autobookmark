import { browser } from 'wxt/browser';
import { z } from 'zod';
import { rt, listSep } from '../../shared/i18n';
import type { OrganizeJob, UndoEntry } from '../../shared/types';
import type { Settings } from '../storage/settings';
import { bumpLibraryVersion } from '../storage/db';
import { chatJson } from '../ai/enhance';
import { buildAssignMessages, buildClusterMessages } from '../ai/prompts';
import { computeFolderPath, findNode, flattenBookmarks, getTreeDtos, listFolderPaths } from './scan';
import { resolveFolderPath } from '../bookmarks/pipeline';
import { runWithSplit } from './split';

const CLUSTER_BATCH = 80;
const ASSIGN_BATCH = 60;
const MOVE_BATCH = 25;
const BATCH_TIMEOUT_MS = 300_000;

export interface ClassifyParams {
  scope: 'toolbar' | 'other' | 'all' | 'folder';
  /** scope='folder' 时必填：目标文件夹 id，类目仍建在"其他书签"下（与整理中心一致） */
  folderId?: string;
  /** 类目层级上限：1=扁平类目（旧行为），≥2 时类目为 "/" 分隔的多级路径 */
  maxDepth: number;
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

// 类目可能是多级路径（"开发/前端/Vue"），长度上限放宽
const clusterSchema = z.object({ categories: z.array(z.string().min(1).max(64)).min(1).max(16) });
const assignSchema = z.object({
  assignments: z.array(z.object({ i: z.number().int(), category: z.string().min(1).max(64) })),
});

/** 范围对应的根节点 id（书签栏 / 其他书签）；folder 模式与 all 一致落在其他书签下 */
async function resolveScopeRootId(scope: ClassifyParams['scope']): Promise<string> {
  const tree = await getTreeDtos();
  // Chrome: children[0]=书签栏 children[1]=其他书签（getTreeDtos 已去掉总根）
  const toolbar = tree[0]?.id ?? '1';
  const other = tree[1]?.id ?? '2';
  return scope === 'toolbar' ? toolbar : other;
}

/** 收集整理范围；scope='folder' 时仅以目标文件夹子树为输入（抛错=找不到目标文件夹） */
export async function prepareClassify(job: OrganizeJob, settings: Settings): Promise<void> {
  void settings;
  const params = job.params as unknown as Partial<ClassifyParams>;
  const scope = params.scope ?? 'all';
  const tree = await getTreeDtos();

  // 旧文件夹快照（清空后可删）；跳过根级"AI 收藏"
  const oldFolderIds: string[] = [];
  let scopeNodes: typeof tree;
  let items: ClassifyParams['items'];
  if (scope === 'folder') {
    // 指定文件夹：仅以该子树内的书签为输入；目标文件夹自身不进 sweep 名单（清空也不删）
    const folder = findNode(tree, params.folderId ?? '');
    if (!folder || folder.url) throw new Error(rt('err.targetFolderNotFound'));
    scopeNodes = [folder];
    const collectInner = (nodes: typeof tree): void => {
      for (const node of nodes) {
        if (node.url) continue;
        oldFolderIds.push(node.id);
        collectInner(node.children);
      }
    };
    collectInner(folder.children);
    items = flattenBookmarks([folder], []).map((b) => ({ id: b.id, title: b.title, url: b.url }));
  } else {
    scopeNodes = tree.filter((_, idx) =>
      scope === 'all' ? true : scope === 'toolbar' ? idx === 0 : idx === 1,
    );
    const collectFolders = (nodes: typeof tree, inScopeRoot: boolean): void => {
      for (const node of nodes) {
        if (node.url) continue;
        if (inScopeRoot && node.title === 'AI 收藏') continue;
        oldFolderIds.push(node.id);
        collectFolders(node.children, false);
      }
    };
    collectFolders(scopeNodes ?? [], true);
    items = flattenBookmarks(scopeNodes ?? [], ['AI 收藏']).map((b) => ({
      id: b.id,
      title: b.title,
      url: b.url,
    }));
  }

  const full: ClassifyParams = {
    scope,
    folderId: params.folderId,
    maxDepth: Math.min(3, Math.max(1, Number(params.maxDepth) || 1)),
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

/**
 * 逐段确保 "a/b/c" 路径存在（缺失即创建）。每级新建都记 createdIds + undo：
 * undoJob 逆序回放，天然先删子级再删父级，多级目录无需额外处理。
 */
async function ensureFolderPath(
  rootId: string,
  path: string,
  createdIds: string[],
  undoLog: UndoEntry[],
): Promise<string> {
  let parentId = rootId;
  for (const seg of path.split('/').filter(Boolean)) {
    parentId = await ensureFolder(parentId, seg, createdIds, undoLog);
  }
  return parentId;
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
      // 归并类目：按顶层（路径首段）聚合频次，截断到 maxCategories 个大类，
      // 保留其下全部子路径；maxDepth=1 时顶层即类目本身，与旧行为一致
      const pathFreq = new Map<string, number>();
      for (const c of p.categories) {
        const top = c.split('/')[0]!;
        pathFreq.set(top, (pathFreq.get(top) ?? 0) + 1);
      }
      const topSorted = [...pathFreq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
      const keptTops = new Set(topSorted.slice(0, Math.max(3, params.maxCategories)));
      p.categories = p.categories.filter((c) => keptTops.has(c.split('/')[0]!));
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
          buildClusterMessages(
            sub.map((x, idx) => ({ i: idx, title: x.title, url: x.url })),
            params.maxDepth,
          ),
          (raw) => clusterSchema.parse(raw),
          { timeoutMs: BATCH_TIMEOUT_MS },
        );
        for (const c of data.categories) {
          // 规范路径：逐段 trim、去空段、深度封顶到 maxDepth
          const name = c
            .split('/')
            .map((seg) => seg.trim())
            .filter(Boolean)
            .slice(0, params.maxDepth)
            .join('/');
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
      // 类目可能是 "大类/子类" 多级路径，逐级查找/创建
      folderIds.set(
        category,
        await ensureFolderPath(params.rootId, category, p.createdFolderIds, job.undoLog),
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
    // 结束：生成报告（多级类目时大类数与实际创建的文件夹数不同，分开统计）
    const assigned = Object.values(p.assignments).filter((c) => c !== '未定').length;
    const undecided = params.items.length - assigned;
    const topCount = new Set(p.categories.map((c) => c.split('/')[0])).size;
    const sep = listSep();
    const trunc = (arr: string[], max: number) => `${arr.slice(0, max).join(sep)}${arr.length > max ? '…' : ''}`;
    const folderLine = p.createdFolderIds.length
      ? params.maxDepth >= 2
        ? rt('organize.reportBuiltHierarchical', { top: topCount, n: p.createdFolderIds.length, list: trunc(p.categories, 6) })
        : rt('organize.reportBuilt', { n: p.createdFolderIds.length, list: trunc(p.categories, 8) })
      : rt('organize.reportNoFolders');
    job.result = {
      report: [
        folderLine,
        rt('organize.reportMoved', { n: assigned }),
        rt('organize.reportUndecided', { n: undecided }),
        rt('organize.reportCleaned', { n: p.removedFolders }),
      ],
    };
  }
}

const singleAssignSchema = z.object({
  assignments: z.array(z.object({ i: z.number().int(), category: z.string().min(1) })),
});

export interface ReclassifyResult {
  ok: boolean;
  /** 移动成功时的目标目录完整路径 */
  folder?: string;
  reason?: 'no-candidates' | 'ai-error';
}

/** 单条书签智能重新分类：AI 从现有目录路径中挑最合适的一个并移动过去 */
export async function reclassifyBookmarkToBestFolder(
  settings: Settings,
  bookmarkId: string,
): Promise<ReclassifyResult> {
  const node = (await browser.bookmarks.get(bookmarkId).catch(() => []))[0];
  if (!node?.url) return { ok: false, reason: 'no-candidates' };

  const candidates = await listFolderPaths();
  const currentPath = await computeFolderPath(node.parentId);
  const options = candidates.filter((p) => p && p !== currentPath);
  if (options.length < 1) return { ok: false, reason: 'no-candidates' };

  let chosen: string | undefined;
  try {
    const data = await chatJson(
      settings,
      'enhance',
      buildAssignMessages([{ i: 0, title: node.title, url: node.url }], options),
      (raw) => singleAssignSchema.parse(raw),
      { timeoutMs: BATCH_TIMEOUT_MS },
    );
    const answer = data.assignments[0]?.category.trim();
    chosen = options.find((p) => p === answer);
  } catch {
    return { ok: false, reason: 'ai-error' };
  }
  if (!chosen) return { ok: false, reason: 'ai-error' };

  const parentId = await resolveFolderPath(chosen);
  if (parentId === node.parentId) return { ok: true, folder: chosen };
  await browser.bookmarks.move(node.id, { parentId });
  await bumpLibraryVersion();
  return { ok: true, folder: chosen };
}
