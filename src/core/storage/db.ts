import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { browser } from 'wxt/browser';
import type { BackupEntry, BookmarkMeta, OrganizeJob } from '../../shared/types';

interface AutoBookmarkDB extends DBSchema {
  meta: {
    key: string;
    value: BookmarkMeta;
    indexes: {
      'url-hash': string;
      'updated-at': number;
    };
  };
  /** 整理任务进度（可恢复、可撤销） */
  jobs: {
    key: string;
    value: OrganizeJob;
  };
  /** 书签结构快照 */
  backups: {
    key: string;
    value: BackupEntry;
  };
}

let dbPromise: Promise<IDBPDatabase<AutoBookmarkDB>> | null = null;

function getDb(): Promise<IDBPDatabase<AutoBookmarkDB>> {
  dbPromise ??= openDB<AutoBookmarkDB>('autobookmark', 3, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const meta = db.createObjectStore('meta', { keyPath: 'bookmarkId' });
        meta.createIndex('url-hash', 'urlHash');
        meta.createIndex('updated-at', 'updatedAt');
        db.createObjectStore('jobs', { keyPath: 'id' });
      }
      if (oldVersion === 1) {
        // v1 的 jobs store 建库时漏了 keyPath，废弃重建（当时无数据）
        if (db.objectStoreNames.contains('jobs')) db.deleteObjectStore('jobs');
        db.createObjectStore('jobs', { keyPath: 'id' });
      }
      if (oldVersion < 3) {
        db.createObjectStore('backups', { keyPath: 'id' });
      }
    },
  });
  return dbPromise;
}

/** 归一化 URL：去掉 hash、尾部斜杠与 utm_ 等追踪参数，让"同一篇文章"落到同一个 hash */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const kept = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (!/^(utm_|from$|spm|ref$)/i.test(k)) kept.append(k, v);
    }
    u.search = kept.toString();
    let s = u.toString();
    if (u.pathname !== '/' && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

export async function hashUrl(url: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeUrl(url));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .slice(0, 16)
    .join('');
}

export async function putMeta(meta: BookmarkMeta): Promise<void> {
  const db = await getDb();
  await db.put('meta', meta);
}

export async function deleteMeta(bookmarkId: string): Promise<void> {
  const db = await getDb();
  await db.delete('meta', bookmarkId);
}

export async function getMeta(bookmarkId: string): Promise<BookmarkMeta | undefined> {
  const db = await getDb();
  return db.get('meta', bookmarkId);
}

export async function getMetaByHash(urlHash: string): Promise<BookmarkMeta | undefined> {
  const db = await getDb();
  return db.getFromIndex('meta', 'url-hash', urlHash);
}

export async function getAllMeta(): Promise<BookmarkMeta[]> {
  const db = await getDb();
  return db.getAll('meta');
}

export async function countMeta(): Promise<number> {
  const db = await getDb();
  return db.count('meta');
}

// ---- 整理任务 ----

export async function putJob(job: OrganizeJob): Promise<void> {
  const db = await getDb();
  await db.put('jobs', job);
}

export async function getJob(jobId: string): Promise<OrganizeJob | undefined> {
  const db = await getDb();
  return db.get('jobs', jobId);
}

export async function listJobs(): Promise<OrganizeJob[]> {
  const db = await getDb();
  const all = await db.getAll('jobs');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteJobById(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('jobs', id);
}

// ---- 书签结构备份 ----

export async function putBackup(entry: BackupEntry): Promise<void> {
  const db = await getDb();
  await db.put('backups', entry);
}

export async function getBackup(id: string): Promise<BackupEntry | undefined> {
  const db = await getDb();
  return db.get('backups', id);
}

export async function listBackups(): Promise<BackupEntry[]> {
  const db = await getDb();
  const all = await db.getAll('backups');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteBackup(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('backups', id);
}

/** 只保留最近 N 份快照 */
export async function pruneBackups(keep = 10): Promise<void> {
  const all = await listBackups();
  for (const entry of all.slice(keep)) await deleteBackup(entry.id);
}

/** 库内容版本号：任何书签/元数据变更后自增，管理页与 popup 监听它自动刷新树 */
export async function bumpLibraryVersion(): Promise<void> {
  await browser.storage.local.set({ libraryVersion: Date.now() });
}
