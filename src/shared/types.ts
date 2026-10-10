/** 从页面提取的正文内容（content script 产出，跨消息传递） */
export interface PageContent {
  url: string;
  title: string;
  siteName: string;
  byline: string;
  excerpt: string;
  /** 正文 Markdown（Readability + Turndown），可能为空 */
  content: string;
  /** 用户当前选中的文本（正文提取失败时的兜底素材） */
  selection: string;
  extractedAt: number;
}

/** 序列化后的书签树节点（chrome.bookmarks.getTree 的可传递形态） */
export interface TreeNodeDto {
  id: string;
  parentId: string | null;
  title: string;
  url?: string;
  dateAdded?: number;
  /** 仅文件夹有 children */
  children: TreeNodeDto[];
}

/** AI 元数据摘要（树 + 列表联查用，比完整 BookmarkMeta 轻） */
export interface MetaBrief {
  summary: string;
  tags: string[];
  createdAt: number;
}

export type JobKind = 'enhance' | 'classify' | 'dedupe' | 'deadlink';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting-review'
  | 'done'
  | 'undone'
  | 'cancelled'
  | 'error';

/** 撤销日志：反向回放即可恢复原状 */
export type UndoEntry =
  | { op: 'move'; id: string; fromParentId: string; index: number }
  | { op: 'create-folder'; id: string }
  /** meta 快照用于撤销删除后重建 AI 元数据关联（重建的书签会有新 id） */
  | {
      op: 'remove';
      parentId: string;
      title: string;
      url?: string;
      meta?: BookmarkMeta;
      /** 被删的是文件夹时记录其旧 id：撤销重建后新 id 通过它映射回引用 */
      folderId?: string;
    };

/** 去重/死链 待确认分组 */
export interface ReviewGroup {
  id: string;
  /** 死链场景 items.length === 1 */
  items: Array<{
    bookmarkId: string;
    title: string;
    url: string;
    folderPath: string;
  }>;
}

/** 书签结构快照（整理前自动创建，可恢复/下载） */
export interface BackupEntry {
  id: string;
  createdAt: number;
  label: string;
  /** 快照中书签总数 */
  count: number;
  /** 完整树（getTreeDtos 形态，含根级"书签栏/其他书签"） */
  tree: TreeNodeDto[];
}

export interface OrganizeJob {
  id: string;
  kind: JobKind;
  status: JobStatus;
  total: number;
  done: number;
  params: Record<string, unknown>;
  undoLog: UndoEntry[];
  result?: {
    report?: string[];
    groups?: ReviewGroup[];
  };
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** AI 为一次收藏生成的元数据草稿（保存前可编辑） */
export interface BookmarkDraft {
  title: string;
  summary: string;
  tags: string[];
  folder: string;
}

/** 已保存书签的增强元数据（IndexedDB，与 chrome.bookmarks 通过 bookmarkId 关联） */
export interface BookmarkMeta {
  bookmarkId: string;
  url: string;
  urlHash: string;
  title: string;
  originalTitle: string;
  summary: string;
  tags: string[];
  folderPath: string;
  createdAt: number;
  updatedAt: number;
  embedding?: number[];
  embeddingModel?: string;
}

export interface SearchResultItem extends BookmarkMeta {
  matchedBy?: 'keyword' | 'semantic' | 'both';
}

export interface UsageEntry {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  lastUsedAt: number;
}

/** providerId -> 用量 */
export type Usage = Record<string, UsageEntry>;
