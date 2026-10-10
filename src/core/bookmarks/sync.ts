import { browser } from 'wxt/browser';
import { deleteMeta, getMeta, putMeta, hashUrl } from '../storage/db';
import { recomputeFolderPath } from './pipeline';
import type { BookmarkMeta } from '../../shared/types';

/**
 * chrome.bookmarks 为真相源，IndexedDB 元数据跟随书签事件同步：
 * - onRemoved：删元数据
 * - onChanged：同步用户手改的标题 / URL 变化（URL 变化时清掉过期向量）
 * - onMoved：重算 folderPath
 * - onCreated：外部创建的书签视为"未增强"，不处理
 */
export function watchBookmarkEvents(onMetaChanged?: () => void) {
  browser.bookmarks.onRemoved.addListener((id) => {
    void deleteMeta(id).then(onMetaChanged);
  });

  browser.bookmarks.onChanged.addListener((id, changeInfo) => {
    void (async () => {
      const meta = await getMeta(id);
      if (!meta) return;
      const next: BookmarkMeta = { ...meta, updatedAt: Date.now() };
      if (changeInfo.title !== undefined) next.title = changeInfo.title;
      if (changeInfo.url !== undefined && changeInfo.url !== meta.url) {
        next.url = changeInfo.url;
        next.urlHash = await hashUrl(changeInfo.url);
        // URL 变了，原摘要/向量已过期
        delete next.embedding;
        delete next.embeddingModel;
      }
      await putMeta(next);
      onMetaChanged?.();
    })();
  });

  browser.bookmarks.onMoved.addListener((id) => {
    void (async () => {
      const meta = await getMeta(id);
      if (meta) await recomputeFolderPath(id, meta);
      onMetaChanged?.();
    })();
  });
}
