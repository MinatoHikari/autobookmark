import { browser } from 'wxt/browser';
import type { TreeNodeDto } from '../../shared/types';

export interface FlatBookmark {
  id: string;
  title: string;
  url: string;
  parentId: string;
  folderPath: string;
  dateAdded?: number;
}

/** chrome.bookmarks 节点 → 可序列化 DTO */
export function toDto(
  node: { id: string; title: string; url?: string; dateAdded?: number; children?: unknown[] },
  parentId: string | null,
): TreeNodeDto {
  const children = (node.children ?? []) as Array<Parameters<typeof toDto>[0]>;
  return {
    id: node.id,
    parentId,
    title: node.title,
    url: node.url,
    dateAdded: node.dateAdded,
    children: node.url ? [] : children.map((c) => toDto(c, node.id)),
  };
}

export async function getTreeDtos(): Promise<TreeNodeDto[]> {
  const root = (await browser.bookmarks.getTree())[0]!;
  return (root.children ?? []).map((c) => toDto(c, root.id));
}

/**
 * 扁平化全部书签。skipRootTitles: 命名匹配的根级文件夹子树整体跳过
 * （默认跳过"AI 收藏"，它已经是整理结果）。
 */
export function flattenBookmarks(
  nodes: TreeNodeDto[],
  skipRootTitles: string[] = [],
  parentPath = '',
): FlatBookmark[] {
  const out: FlatBookmark[] = [];
  for (const node of nodes) {
    const path = parentPath ? `${parentPath}/${node.title}` : node.title;
    if (node.url) {
      if (/^https?:/i.test(node.url)) {
        out.push({
          id: node.id,
          title: node.title,
          url: node.url,
          parentId: node.parentId ?? '',
          folderPath: parentPath,
          dateAdded: node.dateAdded,
        });
      }
      continue;
    }
    if (!parentPath && skipRootTitles.includes(node.title)) continue;
    out.push(...flattenBookmarks(node.children, skipRootTitles, path));
  }
  return out;
}

export function findNode(nodes: TreeNodeDto[], id: string): TreeNodeDto | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (!node.url) {
      const hit = findNode(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function countBookmarks(node: TreeNodeDto): number {
  if (node.url) return 1;
  return node.children.reduce((sum, c) => sum + countBookmarks(c), 0);
}

/** 沿父链计算文件夹路径（"书签栏/开发/前端"） */
export async function computeFolderPath(
  startParentId: string | undefined,
  maxDepth = 6,
): Promise<string> {
  const titles: string[] = [];
  let currentId = startParentId;
  for (let depth = 0; depth < maxDepth && currentId; depth++) {
    let node;
    try {
      node = (await browser.bookmarks.get(currentId))[0];
    } catch {
      break;
    }
    if (!node || !node.parentId) break; // 根节点（"书签栏"/"其他书签"的父级）不再计入
    titles.unshift(node.title);
    currentId = node.parentId;
  }
  return titles.filter((t) => t && t !== 'root').join('/');
}

/** 收集全部文件夹路径（"书签栏/开发"、"其他书签/海淘"），供 AI 为新书签挑选目标目录 */
export async function listFolderPaths(
  skipRootTitles: string[] = ['AI 收藏'],
  max = 150,
): Promise<string[]> {
  const tree = await getTreeDtos();
  const paths: string[] = [];
  const walk = (nodes: TreeNodeDto[], parentPath: string): void => {
    for (const node of nodes) {
      if (node.url) continue;
      const path = parentPath ? `${parentPath}/${node.title}` : node.title;
      if (!parentPath && skipRootTitles.includes(node.title)) continue;
      paths.push(path);
      walk(node.children, path);
    }
  };
  walk(tree, '');
  return paths.slice(0, max);
}
