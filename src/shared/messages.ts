import { defineExtensionMessaging } from '@webext-core/messaging';
import type { Settings } from '../core/storage/settings';
import type {
  BackupEntry,
  BookmarkDraft,
  BookmarkMeta,
  MetaBrief,
  OrganizeJob,
  PageContent,
  SearchResultItem,
  TreeNodeDto,
  Usage,
} from './types';

/**
 * 协议约定：每个消息只有一个 data 参数（原语或对象），返回值直接透传。
 * 全部 UI → background；background 从不发消息回 UI。
 */
interface ProtocolMap {
  // ---- 设置 ----
  getSettings(): Settings;
  saveSettings(newSettings: Settings): Settings;
  getUsage(): Usage;
  clearUsage(): boolean;

  // ---- 页面提取 / 收藏 ----
  /** 注入提取脚本并返回页面正文 */
  extractPage(tabId: number): PageContent;
  isUrlBookmarked(url: string): { bookmarked: boolean; meta?: BookmarkMeta };
  /** AI 生成书签元数据草稿（不保存） */
  enhanceBookmark(page: PageContent): BookmarkDraft;
  /** 保存草稿到 chrome.bookmarks + IndexedDB 元数据；manualPath 为手动指定的完整路径 */
  saveBookmark(input: { page: PageContent; draft: BookmarkDraft; manualPath?: string }): BookmarkMeta;
  /** 已有目录路径列表（手动指定保存路径的候选项） */
  listFolderPaths(): string[];

  // ---- 书签树浏览 / 管理 ----
  getBookmarksTree(): { tree: TreeNodeDto[]; metaById: Record<string, MetaBrief> };
  /** index 省略时追加到目标文件夹末尾；传入值为移除被拖节点后的最终位置（同层重排的后台换算细节见 handler） */
  moveNode(input: { id: string; newParentId: string; index?: number }): boolean;
  renameNode(input: { id: string; title: string }): boolean;
  createFolder(input: { parentId: string; title: string }): string;
  removeNode(id: string): boolean;
  /** 编辑已有书签（标题/链接/AI 元数据；改链接会重算 urlHash 并作废旧向量） */
  updateMeta(input: { bookmarkId: string; title?: string; url?: string; summary: string; tags: string[] }): BookmarkMeta | null;
  /** 对已存在书签单条补 AI 元数据（复用 enhance 管线，不改书签标题） */
  enhanceExisting(bookmarkId: string): BookmarkMeta;
  /** 单条书签智能重新分类：AI 从现有目录路径中挑最合适的并移动 */
  reclassifyBookmark(bookmarkId: string): { ok: boolean; folder?: string; reason?: 'no-candidates' | 'ai-error' };
  searchBookmarks(query: string): SearchResultItem[];
  deleteBookmark(bookmarkId: string): boolean;

  // ---- manager 页 / 导航 ----
  /** 普通收藏（非 AI）；folderPath 为手动指定的完整路径 */
  savePlainBookmark(input: { url: string; title: string; folderPath?: string }): BookmarkMeta;
  /** 打开管理页；panel='settings' 时自动弹出设置抽屉 */
  openManager(panel: string): boolean;

  // ---- 整理任务（P2） ----
  getJobs(): OrganizeJob[];
  startJob(input: { kind: OrganizeJob['kind']; params: Record<string, unknown> }): string;
  pauseJob(jobId: string): boolean;
  resumeJob(jobId: string): boolean;
  cancelJob(jobId: string): boolean;
  /** 删除任务记录（仅非进行中状态） */
  deleteJob(jobId: string): boolean;
  /** 去重/死链 review 结果落地（每组保留项 / 死链是否删除） */
  resolveJob(input: {
    jobId: string;
    keepByGroup?: Record<string, string>;
    removeIds?: string[];
  }): boolean;
  undoJob(jobId: string): boolean;
  /** 是否已授予全站访问权限（死链检测/正文抓取需要） */
  hasAllSiteAccess(): boolean;

  // ---- 书签结构备份 ----
  listBackups(): BackupEntry[];
  createBackupNow(label: string): string;
  /** 快照后重建书签树（自动先做"恢复前备份"） */
  restoreBackup(id: string): boolean;
  /** Netscape HTML 格式，管理页自行触发下载 */
  getBackupHtml(id: string): string;
  deleteBackup(id: string): boolean;
  /** 从 AI 元数据重建已消失的书签（最后兜底） */
  recoverFromMeta(): { recovered: number; skipped: number };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
