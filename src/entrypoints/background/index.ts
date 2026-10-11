import { browser } from 'wxt/browser';
import { onMessage } from '../../shared/messages';
import { STREAM_PORT, type StreamEvent, type StreamRequest } from '../../shared/stream';
import type { BookmarkMeta, PageContent } from '../../shared/types';
import { getSettings, saveSettings } from '../../core/storage/settings';
import { getAllMeta, getMeta, getMetaByHash, hashUrl, putMeta } from '../../core/storage/db';
import { enhanceBookmark, resolveBinding, NotConfiguredError } from '../../core/ai/enhance';
import { buildTldrMessages } from '../../core/ai/prompts';
import { trackUsage, getUsage, clearUsage } from '../../core/ai/usage';
import {
  isUrlBookmarked,
  saveEnhancedBookmark,
  savePlainBookmark,
} from '../../core/bookmarks/pipeline';
import { watchBookmarkEvents } from '../../core/bookmarks/sync';
import { invalidateSearchIndex, searchBookmarks } from '../../core/search/search';
import { computeFolderPath, getTreeDtos, listFolderPaths } from '../../core/organize/scan';
import { enhanceSingle } from '../../core/organize/enhance';
import { reclassifyBookmarkToBestFolder } from '../../core/organize/classify';
import {
  startJob,
  pauseJob,
  resumeJob,
  cancelJob,
  deleteJob,
  resolveJob,
  undoJob,
  watchOrganizeAlarms,
} from '../../core/organize/runner';
import { hasAllSiteAccess } from '../../core/organize/content';
import {
  createSnapshot,
  restoreSnapshot,
  buildBackupHtml,
  recoverMissingFromMeta,
} from '../../core/organize/backup';
import { listBackups, deleteBackup, bumpLibraryVersion } from '../../core/storage/db';
import { listJobs } from '../../core/storage/db';

const CONTEXT_MENU_ID = 'autobookmark-save';
const EXTRACTOR_FILE = '/extractor.js';
const MANAGER_URL = 'manager.html' as Parameters<typeof browser.runtime.getURL>[0];

/** 注入 extractor 脚本并调用它（同页多次注入安全：extractor 自带幂等守卫） */
export async function extractPageContent(tabId: number): Promise<PageContent> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error('浏览器内部页面（chrome:// 等）暂不支持收藏');
  }
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [EXTRACTOR_FILE],
    });
  } catch {
    throw new Error('无法注入此页面（可能是商店/系统页面），请换个页面试试');
  }
  const [res] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
      const extract = (window as unknown as Record<string, undefined | (() => unknown)>)
        .__autobookmarkExtract;
      return extract?.();
    },
  });
  const page = res?.result as PageContent | undefined;
  if (!page || !page.url) throw new Error('正文提取失败');
  return page;
}

async function flashBadge(ok: boolean) {
  await browser.action.setBadgeText({ text: ok ? '✓' : '✕' });
  await browser.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626' });
  setTimeout(() => {
    void browser.action.setBadgeText({ text: '' });
  }, 2000);
}

/** 右键菜单：提取 → AI 增强 → 直接保存（无编辑步骤） */
async function contextMenuSave(tabId: number | undefined) {
  if (!tabId) return;
  try {
    const settings = await getSettings();
    if (!settings.bindings.enhance) throw new NotConfiguredError('智能收藏');
    const page = await extractPageContent(tabId);
    const draft = await enhanceBookmark(settings, page);
    await saveEnhancedBookmark(settings, page, draft);
    invalidateSearchIndex();
    await flashBadge(true);
  } catch (e) {
    console.error('[autobookmark] context menu save failed:', e);
    await flashBadge(false);
  }
}

function setupContextMenus() {
  browser.runtime.onInstalled.addListener(() => {
    void browser.contextMenus.removeAll().then(async () => {
      const settings = await getSettings();
      if (!settings.preferences.contextMenuEnabled) return;
      browser.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: 'AI 智能收藏此页面',
        contexts: ['page'],
      });
    });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === CONTEXT_MENU_ID) void contextMenuSave(tab?.id);
  });
}

/** TL;DR 流式任务 */
async function runTldrStream(
  page: PageContent,
  emit: (event: StreamEvent) => void,
  close: () => void,
) {
  const settings = await getSettings();
  const { provider, model, providerId } = resolveBinding(settings, 'tldr');
  const messages = buildTldrMessages(page, {
    language: settings.preferences.language,
    maxContentChars: settings.preferences.maxContentChars,
  });
  emit({ type: 'start' });
  const { usage } = await provider.chat({
    model,
    messages,
    temperature: 0.3,
    signal: AbortSignal.timeout(180_000),
    onDelta: (text) => emit({ type: 'delta', text }),
  });
  await trackUsage(providerId, usage);
  emit({ type: 'done' });
  close();
}

function setupStreamServer() {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== STREAM_PORT) return;
    port.onMessage.addListener((request: StreamRequest) => {
      const emit = (event: StreamEvent) => {
        try {
          port.postMessage(event);
        } catch {
          /* UI 可能已关闭 */
        }
      };
      if (request.task === 'tldr') {
        runTldrStream(request.payload as PageContent, emit, () => port.disconnect()).catch((e) => {
          emit({ type: 'error', message: (e as Error).message });
        });
      }
    });
  });
}

function setupCommands() {
  browser.commands?.onCommand.addListener((command) => {
    if (command === 'open-manager') void openManagerTab();
  });
}

/** 点击任务通知 → 打开书签管理页 */
function setupNotifications() {
  browser.notifications?.onClicked.addListener(() => {
    void openManagerTab();
  });
}

export async function openManagerTab(panel?: string): Promise<boolean> {
  try {
    const path = panel ? `manager.html?panel=${panel}` : 'manager.html';
    await browser.tabs.create({
      url: browser.runtime.getURL(path as Parameters<typeof browser.runtime.getURL>[0]),
    });
    return true;
  } catch (e) {
    console.warn('[autobookmark] open manager failed:', e);
    return false;
  }
}

function setupMessageRouter() {
  // ---- 设置 ----
  onMessage('getSettings', async () => getSettings());

  onMessage('saveSettings', async ({ data }) => {
    await saveSettings(data);
    await browser.contextMenus.removeAll();
    if (data.preferences.contextMenuEnabled) {
      browser.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: 'AI 智能收藏此页面',
        contexts: ['page'],
      });
    }
    return data;
  });

  onMessage('getUsage', async () => getUsage());
  onMessage('clearUsage', async () => {
    await clearUsage();
    return true;
  });

  // ---- 页面提取 / 收藏 ----
  onMessage('extractPage', async ({ data }) => extractPageContent(data));

  onMessage('isUrlBookmarked', async ({ data }) => {
    const exact = await isUrlBookmarked(data);
    let meta = undefined;
    if (!exact) {
      meta = await getMetaByHash(await hashUrl(data));
      if (meta) {
        try {
          await browser.bookmarks.get(meta.bookmarkId);
        } catch {
          meta = undefined;
        }
      }
    } else {
      const results = await browser.bookmarks.search({ url: data });
      const id = results[0]?.id;
      if (id) meta = await getMeta(id);
    }
    return { bookmarked: exact || !!meta, meta };
  });

  onMessage('enhanceBookmark', async ({ data }) => {
    const settings = await getSettings();
    // 存放策略为 existing 时，让 AI 从已有目录中挑目标
    const folders =
      settings.preferences.saveStrategy === 'existing' ? await listFolderPaths() : undefined;
    return enhanceBookmark(settings, data, folders);
  });

  onMessage('saveBookmark', async ({ data }) => {
    const settings = await getSettings();
    const meta = await saveEnhancedBookmark(settings, data.page, data.draft, data.manualPath);
    invalidateSearchIndex();
    await bumpLibraryVersion();
    return meta;
  });

  onMessage('savePlainBookmark', async ({ data }) => {
    const settings = await getSettings();
    const meta = await savePlainBookmark(settings, data, data.folderPath);
    invalidateSearchIndex();
    await bumpLibraryVersion();
    return meta;
  });

  onMessage('listFolderPaths', async () => listFolderPaths());

  // ---- 书签树浏览 / 管理 ----
  onMessage('getBookmarksTree', async () => {
    const [tree, metas] = await Promise.all([getTreeDtos(), getAllMeta()]);
    const metaById: Record<string, { summary: string; tags: string[]; createdAt: number }> = {};
    for (const m of metas) {
      metaById[m.bookmarkId] = { summary: m.summary, tags: m.tags, createdAt: m.createdAt };
    }
    return { tree, metaById };
  });

  onMessage('moveNode', async ({ data }) => {
    try {
      const moveArgs: { parentId: string; index?: number } = { parentId: data.newParentId };
      if (data.index != null) {
        moveArgs.index = data.index;
        // 同层重排时浏览器把 index 解释为「移除前列表中占据该位者之前」插入（真机验证），
        // 而调用方传的是期望的最终位置：向后移时 +1 换算；跨文件夹时 index 即目标位置，直接透传
        const node = (await browser.bookmarks.get(data.id))[0];
        if (node?.parentId === data.newParentId && node.index != null && data.index >= node.index) {
          moveArgs.index = data.index + 1;
        }
      }
      await browser.bookmarks.move(data.id, moveArgs);
      // 更新受影响书签的 folderPath（尽力而为）
      const metas = await getAllMeta();
      for (const m of metas) {
        if (m.bookmarkId === data.id) {
          const node = (await browser.bookmarks.get(data.id).catch(() => []))[0];
          if (node) {
            await putMeta({ ...m, folderPath: await computeFolderPath(node.parentId), updatedAt: Date.now() });
          }
        }
      }
      await bumpLibraryVersion();
      return true;
    } catch (e) {
      console.warn('[autobookmark] moveNode failed:', e);
      return false;
    }
  });

  onMessage('renameNode', async ({ data }) => {
    try {
      await browser.bookmarks.update(data.id, { title: data.title });
      return true;
    } catch {
      return false;
    }
  });

  onMessage('createFolder', async ({ data }) => {
    const node = await browser.bookmarks.create({ parentId: data.parentId, title: data.title });
    await bumpLibraryVersion();
    return node.id;
  });

  onMessage('removeNode', async ({ data }) => {
    try {
      await browser.bookmarks.remove(data).catch(() => browser.bookmarks.removeTree(data));
      await bumpLibraryVersion();
      return true;
    } catch {
      return false;
    }
  });

  onMessage('updateMeta', async ({ data }) => {
    let base = await getMeta(data.bookmarkId);
    if (!base) {
      // 未增强书签第一次编辑：自动创建元数据记录
      const node = (await browser.bookmarks.get(data.bookmarkId).catch(() => []))[0];
      if (!node?.url) return null;
      base = {
        bookmarkId: node.id,
        url: node.url,
        urlHash: await hashUrl(node.url),
        title: node.title,
        originalTitle: node.title,
        summary: '',
        tags: [],
        folderPath: await computeFolderPath(node.parentId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    const next: BookmarkMeta = {
      ...base,
      summary: data.summary,
      tags: data.tags,
      updatedAt: Date.now(),
    };
    if (data.title !== undefined && data.title.trim()) next.title = data.title.trim();
    if (data.url !== undefined && data.url.trim() && data.url.trim() !== base.url) {
      const newUrl = data.url.trim();
      if (!/^https?:\/\//i.test(newUrl)) throw new Error('链接必须以 http:// 或 https:// 开头');
      await browser.bookmarks.update(data.bookmarkId, { url: newUrl });
      next.url = newUrl;
      next.urlHash = await hashUrl(newUrl);
      // 旧链接的语义向量不再成立
      delete next.embedding;
      delete next.embeddingModel;
    }
    await putMeta(next);
    invalidateSearchIndex();
    return next;
  });

  onMessage('enhanceExisting', async ({ data }) => {
    const settings = await getSettings();
    const meta = await enhanceSingle(settings, data);
    invalidateSearchIndex();
    return meta;
  });

  onMessage('reclassifyBookmark', async ({ data }) => {
    const settings = await getSettings();
    return reclassifyBookmarkToBestFolder(settings, data);
  });

  onMessage('searchBookmarks', async ({ data }) => {
    const settings = await getSettings();
    return searchBookmarks(settings, data);
  });

  onMessage('deleteBookmark', async ({ data }) => {
    try {
      await browser.bookmarks.remove(data);
    } catch {
      // 书签可能已不存在，直接清元数据
    }
    invalidateSearchIndex();
    await bumpLibraryVersion();
    return true;
  });

  // ---- manager 页 ----
  onMessage('openManager', async ({ data }) => openManagerTab(data || undefined));

  // ---- 整理任务 ----
  onMessage('getJobs', async () => listJobs());
  onMessage('startJob', async ({ data }) => startJob(data.kind, data.params));
  onMessage('pauseJob', async ({ data }) => pauseJob(data));
  onMessage('resumeJob', async ({ data }) => resumeJob(data));
  onMessage('cancelJob', async ({ data }) => cancelJob(data));
  onMessage('deleteJob', async ({ data }) => deleteJob(data));
  onMessage('resolveJob', async ({ data }) =>
    resolveJob(data.jobId, { keepByGroup: data.keepByGroup, removeIds: data.removeIds }),
  );
  onMessage('undoJob', async ({ data }) => undoJob(data));
  onMessage('hasAllSiteAccess', async () => hasAllSiteAccess());

  // ---- 书签结构备份 ----
  onMessage('listBackups', async () => listBackups());
  onMessage('createBackupNow', async ({ data }) => {
    const id = await createSnapshot(data || '手动备份');
    invalidateSearchIndex();
    return id;
  });
  onMessage('restoreBackup', async ({ data }) => {
    const ok = await restoreSnapshot(data);
    invalidateSearchIndex();
    return ok;
  });
  onMessage('getBackupHtml', async ({ data }) => {
    const { getBackup } = await import('../../core/storage/db');
    const entry = await getBackup(data);
    return entry ? buildBackupHtml(entry) : '';
  });
  onMessage('deleteBackup', async ({ data }) => {
    await deleteBackup(data);
    return true;
  });
  onMessage('recoverFromMeta', async () => {
    const result = await recoverMissingFromMeta();
    invalidateSearchIndex();
    return result;
  });
}

export default defineBackground(() => {
  setupContextMenus();
  setupStreamServer();
  setupCommands();
  setupNotifications();
  setupMessageRouter();
  watchBookmarkEvents(() => invalidateSearchIndex());
  watchOrganizeAlarms();

  console.log('[autobookmark] background ready');
});
