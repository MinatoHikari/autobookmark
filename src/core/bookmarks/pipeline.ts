import { browser } from 'wxt/browser';
import type { BookmarkDraft, BookmarkMeta, PageContent } from '../../shared/types';
import type { Settings } from '../storage/settings';
import { hashUrl, putMeta } from '../storage/db';
import { computeFolderPath } from '../organize/scan';
import { resolveBinding } from '../ai/enhance';

import { trackUsage } from '../ai/usage';

/** "其他书签" 的 id：Chrome 为 '2'，Firefox 树中最后一个子节点是 unfiled */
async function getOtherBookmarksId(): Promise<string> {
  const root = (await browser.bookmarks.getTree())[0]!;
  const children = root.children ?? [];
  return children.find((c) => c.id === '2')?.id ?? children[children.length - 1]?.id ?? '2';
}

async function ensureFolder(parentId: string, title: string): Promise<{ id: string; created: boolean }> {
  const children = await browser.bookmarks.getChildren(parentId);
  const existing = children.find((c) => !c.url && c.title === title);
  if (existing) return { id: existing.id, created: false };
  const node = await browser.bookmarks.create({ parentId, title });
  return { id: node.id, created: true };
}

/** 确保"其他书签/<rootFolder>"存在 */
export async function ensureRootFolder(rootFolder: string): Promise<string> {
  const otherId = await getOtherBookmarksId();
  return (await ensureFolder(otherId, rootFolder)).id;
}

export async function listSubFolders(rootFolder: string): Promise<string[]> {
  const otherId = await getOtherBookmarksId();
  const children = await browser.bookmarks.getChildren(otherId);
  const root = children.find((c) => !c.url && c.title === rootFolder);
  if (!root) return [];
  const subs = await browser.bookmarks.getChildren(root.id);
  return subs.filter((c) => !c.url).map((c) => c.title).sort();
}

export async function isUrlBookmarked(url: string): Promise<boolean> {
  const results = await browser.bookmarks.search({ url });
  return results.some((b) => b.url === url);
}

/**
 * 把 "永久分区/目录/子目录" 形式的路径解析为 parentId，缺失的目录逐级创建。
 * 首段必须是永久分区（书签栏/其他书签），匹配不到时回退到「其他书签」。
 */
export async function resolveFolderPath(path: string): Promise<string> {
  const segments = path.split('/').map((x) => x.trim()).filter(Boolean);
  const [realRoot] = await browser.bookmarks.getTree();
  const sections = realRoot?.children ?? [];
  const first = segments[0] ?? '';
  const section =
    sections.find((c) => c.title === first) ??
    sections.find((c) => c.id === '2') ??
    sections[sections.length - 1];
  if (!section) throw new Error('未找到可存放的根目录');
  let parentId = section.id;
  for (const seg of segments.slice(1)) {
    parentId = (await ensureFolder(parentId, seg)).id;
  }
  return parentId;
}

/** 语义向量（尽力而为：未配置 embedding 或失败不影响保存） */
async function embedForIndex(settings: Settings, text: string): Promise<{ vector: number[]; model: string } | null> {
  try {
    const { provider, model, providerId } = resolveBinding(settings, 'embedding');
    const [vector] = await provider.embed(model, [text]);
    await trackUsage(providerId);
    if (vector) return { vector, model };
  } catch {
    /* embedding 是可选能力 */
  }
  return null;
}

export async function saveEnhancedBookmark(
  settings: Settings,
  page: PageContent,
  draft: BookmarkDraft,
  /** 手动指定的完整保存路径，提供时忽略存放策略与 AI 建议 */
  manualPath?: string,
): Promise<BookmarkMeta> {
  let parentId: string;
  let folderPath: string;

  if (manualPath) {
    // 用户在 popup 里手动指定了完整路径（优先级最高）
    parentId = await resolveFolderPath(manualPath);
    folderPath = manualPath;
  } else if (settings.preferences.saveStrategy === 'existing') {
    // 在已有目录树中落位：draft.folder = "永久分区/已有目录/…/新子目录"
    const segments = draft.folder.split('/').map((x) => x.trim()).filter(Boolean);
    const [realRoot] = await browser.bookmarks.getTree();
    const sections = realRoot?.children ?? [];
    const first = segments[0] ?? '';
    const section =
      sections.find((c) => c.title === first) ??
      sections.find((c) => c.id === '2') ??
      sections[sections.length - 1];
    if (!section) throw new Error('未找到可存放的根目录');
    parentId = section.id;
    for (const seg of segments.slice(1)) {
      parentId = (await ensureFolder(parentId, seg)).id;
    }
    folderPath = [section.title, ...segments.slice(1)].filter(Boolean).join('/');
  } else {
    const rootId = await ensureRootFolder(settings.preferences.rootFolder);
    const folderName = settings.preferences.autoFolder ? draft.folder : '';
    parentId = folderName ? (await ensureFolder(rootId, folderName)).id : rootId;
    folderPath = [settings.preferences.rootFolder, folderName].filter(Boolean).join('/');
  }

  const node = await browser.bookmarks.create({ parentId, title: draft.title, url: page.url });

  const now = Date.now();
  const meta: BookmarkMeta = {
    bookmarkId: node.id,
    url: page.url,
    urlHash: await hashUrl(page.url),
    title: draft.title,
    originalTitle: page.title,
    summary: draft.summary,
    tags: draft.tags,
    folderPath,
    createdAt: now,
    updatedAt: now,
  };

  const embedded = await embedForIndex(settings, `${draft.title}\n${draft.summary}\n${draft.tags.join(' ')}`);
  if (embedded) {
    meta.embedding = embedded.vector;
    meta.embeddingModel = embedded.model;
  }

  await putMeta(meta);
  return meta;
}

/** 书签被移动后重算 folderPath */
export async function recomputeFolderPath(bookmarkId: string, meta: BookmarkMeta): Promise<void> {
  try {
    const titles: string[] = [];
    let currentId: string = bookmarkId;
    // 沿父链向上收集文件夹名（最多 5 层防御）
    for (let depth = 0; depth < 5; depth++) {
      const node = (await browser.bookmarks.get(currentId))[0];
      if (!node?.parentId) break;
      const parent = (await browser.bookmarks.get(node.parentId))[0];
      if (!parent || !parent.parentId) break; // 到达根
      titles.unshift(parent.title);
      currentId = node.parentId;
    }
    const folderPath = titles.filter((t) => t && t !== 'root').join('/');
    if (folderPath && folderPath !== meta.folderPath) {
      await putMeta({ ...meta, folderPath, updatedAt: Date.now() });
    }
  } catch {
    /* 书签可能已被删除，忽略 */
  }
}

/**
 * 普通收藏（非 AI）：不提取正文、不调用模型，直接用页面标题落库。
 * aiFolder 策略 → 「AI 收藏」根目录；existing 策略 → 「其他书签」根目录。
 * 元数据记为未增强（空摘要/标签），之后可随时 AI 增强。
 */
export async function savePlainBookmark(
  settings: Settings,
  input: { url: string; title: string },
  /** 手动指定的完整保存路径，提供时忽略默认落点 */
  manualPath?: string,
): Promise<BookmarkMeta> {
  let parentId: string;
  if (manualPath) {
    parentId = await resolveFolderPath(manualPath);
  } else if (settings.preferences.saveStrategy === 'existing') {
    const [realRoot] = await browser.bookmarks.getTree();
    const section =
      realRoot?.children?.find((c) => c.id === '2') ??
      realRoot?.children?.[realRoot.children.length - 1];
    if (!section) throw new Error('未找到可存放的根目录');
    parentId = section.id;
  } else {
    parentId = await ensureRootFolder(settings.preferences.rootFolder);
  }

  const node = await browser.bookmarks.create({ parentId, title: input.title, url: input.url });
  const meta: BookmarkMeta = {
    bookmarkId: node.id,
    url: input.url,
    urlHash: await hashUrl(input.url),
    title: input.title,
    originalTitle: input.title,
    summary: '',
    tags: [],
    folderPath: await computeFolderPath(node.parentId),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await putMeta(meta);
  return meta;
}
