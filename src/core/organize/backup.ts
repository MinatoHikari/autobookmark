import { browser } from 'wxt/browser';
import type { BackupEntry, TreeNodeDto } from '../../shared/types';
import { getTreeDtos } from './scan';
import { getAllMeta, getBackup, pruneBackups, putBackup, putMeta, deleteMeta } from '../storage/db';

const MAX_BACKUPS = 10;

function countBookmarks(nodes: TreeNodeDto[]): number {
  return nodes.reduce(
    (sum, n) => sum + (n.url ? 1 : countBookmarks(n.children)),
    0,
  );
}

/** 快照当前完整书签树 */
export async function createSnapshot(label: string): Promise<string> {
  const tree = await getTreeDtos();
  const entry: BackupEntry = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    label,
    count: countBookmarks(tree),
    tree,
  };
  await putBackup(entry);
  await pruneBackups(MAX_BACKUPS);
  return entry.id;
}

async function recreateIn(parentId: string, nodes: TreeNodeDto[]): Promise<void> {
  for (const node of nodes) {
    if (node.url) {
      await browser.bookmarks.create({ parentId, title: node.title, url: node.url });
    } else {
      const folder = await browser.bookmarks.create({ parentId, title: node.title });
      await recreateIn(folder.id, node.children);
    }
  }
}

/**
 * 恢复快照：清空当前全部书签区（书签栏/其他书签的子树），按快照重建。
 * 根级分区 id（'1'/'2' 等）在 Chromium 中稳定，直接用快照里的 parentId 重建。
 */
export async function restoreSnapshot(id: string): Promise<boolean> {
  const entry = await getBackup(id);
  if (!entry) return false;

  // 恢复前先把现状再存一份，防误操作
  await createSnapshot('恢复前自动备份');

  const [realRoot] = await browser.bookmarks.getTree();
  const permanent = realRoot?.children ?? [];
  // 永久分区（书签栏/其他书签）本身不可删除，只清空其子节点
  for (const section of permanent) {
    for (const sub of section.children ?? []) {
      await browser.bookmarks.removeTree(sub.id).catch((e) => {
        console.warn('[autobookmark] restore: removeTree failed', sub.title, e);
      });
    }
  }
  // 快照顶层即永久分区，按 id（Chromium 中稳定）匹配后重建其子树
  for (const dto of entry.tree) {
    const target =
      permanent.find((p) => p.id === dto.id) ?? permanent.find((p) => p.title === dto.title);
    if (target) await recreateIn(target.id, dto.children);
  }

  // 重建后的书签 id 全部变化，旧元数据整体失效（保守处理）
  for (const meta of await getAllMeta()) {
    await deleteMeta(meta.bookmarkId).catch(() => undefined);
  }
  return true;
}

/** Netscape 书签 HTML 格式（可用浏览器书签管理器直接导入） */
export function buildBackupHtml(entry: BackupEntry): string {
  const esc = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- AutoBookmark backup -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const walk = (nodes: TreeNodeDto[], depth: number): void => {
    const pad = '    '.repeat(depth);
    for (const node of nodes) {
      if (node.url) {
        lines.push(`${pad}<DT><A HREF="${esc(node.url)}" ADD_DATE="${Math.floor((node.dateAdded ?? 0) / 1000)}">${esc(node.title)}</A>`);
      } else {
        lines.push(`${pad}<DT><H3 ADD_DATE="${Math.floor((node.dateAdded ?? 0) / 1000)}">${esc(node.title)}</H3>`);
        lines.push(`${pad}<DL><p>`);
        walk(node.children, depth + 1);
        lines.push(`${pad}</DL><p>`);
      }
    }
  };
  walk(entry.tree, 1);
  lines.push('</DL><p>');
  return lines.join('\n');
}

/**
 * 最后兜底：从 IndexedDB 元数据重建 chrome.bookmarks 中已消失的书签。
 * （异常撤销/误删后，只要书签被 AI 增强过，url 与标题就有本地快照）
 * 已被重建的元数据重新关联到新书签 id，搜索库不受影响。
 */
export async function recoverMissingFromMeta(): Promise<{ recovered: number; skipped: number }> {
  const metas = await getAllMeta();
  const missing: typeof metas = [];
  for (const m of metas) {
    const exists = await browser.bookmarks
      .get(m.bookmarkId)
      .then(() => true)
      .catch(() => false);
    if (exists) continue;
    // 同一 URL 已有存活书签（如被重建过）→ 跳过，避免制造重复
    const sameUrl = await browser.bookmarks.search({ url: m.url });
    if (sameUrl.length) continue;
    missing.push(m);
  }
  if (!missing.length) return { recovered: 0, skipped: 0 };

  const [realRoot] = await browser.bookmarks.getTree();
  const other =
    realRoot?.children?.find((c) => c.id === '2') ??
    realRoot?.children?.[realRoot.children.length - 1];
  const parentId = other?.id ?? '2';
  const children = await browser.bookmarks.getChildren(parentId);
  let folder = children.find((c) => !c.url && c.title === '恢复的书签');
  if (!folder) folder = await browser.bookmarks.create({ parentId, title: '恢复的书签' });

  let recovered = 0;
  for (const m of missing) {
    try {
      const created = await browser.bookmarks.create({
        parentId: folder.id,
        title: m.title,
        url: m.url,
      });
      await putMeta({ ...m, bookmarkId: created.id, updatedAt: Date.now() });
      recovered++;
    } catch (e) {
      console.warn('[autobookmark] recover meta failed:', m.url, e);
    }
  }
  return { recovered, skipped: missing.length - recovered };
}
