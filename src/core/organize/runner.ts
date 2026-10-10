import { browser } from 'wxt/browser';
import type { OrganizeJob, UndoEntry } from '../../shared/types';
import { getJob, getMeta, listJobs, putJob, putMeta, deleteMeta, deleteJobById } from '../storage/db';
import { getSettings } from '../storage/settings';
import { invalidateSearchIndex } from '../search/search';
import { processEnhanceBatch, type EnhanceParams } from './enhance';
import { prepareClassify, processClassifyBatch, type ClassifyParams } from './classify';
import { scanDuplicates } from './dedupe';
import { processDeadlinkBatch, type DeadlinkParams } from './deadlink';
import { flattenBookmarks, getTreeDtos } from './scan';
import { createSnapshot } from './backup';
import { notifyJobTerminal, shouldNotify } from './notify';

const ALARM_NAME = 'organize-tick';
/** SW 每次唤醒最多连续处理的批数，余下交给 alarm 兜底 */
const MAX_BATCHES_PER_WAKE = 8;

let ticking = false;

function isActive(job: OrganizeJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

async function ensureAlarm(): Promise<void> {
  await browser.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

async function clearAlarmIfIdle(): Promise<void> {
  const jobs = await listJobs();
  if (!jobs.some(isActive)) await browser.alarms.clear(ALARM_NAME);
}

/** alarm 监听（background 入口注册一次） */
export function watchOrganizeAlarms(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void tick();
  });
}

export async function startJob(
  kind: OrganizeJob['kind'],
  rawParams: Record<string, unknown>,
): Promise<string> {
  // 同时只允许一个活动任务，避免 AI 并发爆限额
  const existing = await listJobs();
  if (existing.some(isActive)) {
    throw new Error('已有任务在进行中，请等它完成或先暂停/取消');
  }

  const job: OrganizeJob = {
    id: crypto.randomUUID(),
    kind,
    status: 'queued',
    total: 0,
    done: 0,
    params: rawParams,
    undoLog: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // 破坏性任务（改变结构/删除书签）启动前自动快照
  const KIND_LABELS: Record<OrganizeJob['kind'], string> = {
    enhance: '补全元数据',
    classify: '自动分类',
    dedupe: '去重',
    deadlink: '死链检测',
  };
  if (kind !== 'enhance') {
    await createSnapshot(`整理前自动备份 · ${KIND_LABELS[kind]}`);
  }

  // 准备阶段：确定 total 与参数规范化
  const settings = await getSettings();
  if (kind === 'enhance') {
    const ids = (rawParams.ids as string[]) ?? [];
    job.params = { ids, fetchContent: !!rawParams.fetchContent } satisfies EnhanceParams;
    job.total = ids.length;
  } else if (kind === 'classify') {
    job.params = rawParams;
    await prepareClassify(job, settings);
  } else if (kind === 'dedupe') {
    job.total = 0; // 扫描阶段自己填
  } else if (kind === 'deadlink') {
    const tree = await getTreeDtos();
    const ids = flattenBookmarks(tree).map((b) => b.id);
    job.params = { ids, deadIds: [], cursor: 0 } satisfies DeadlinkParams;
    job.total = ids.length;
  }

  await putJob(job);
  await ensureAlarm();
  void tick();
  return job.id;
}

async function getCurrentJob(): Promise<OrganizeJob | undefined> {
  const jobs = await listJobs();
  return jobs.filter(isActive).sort((a, b) => a.createdAt - b.createdAt)[0];
}

/** 唤醒入口：处理当前活动任务的若干批 */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (let i = 0; i < MAX_BATCHES_PER_WAKE; i++) {
      const job = await getCurrentJob();
      if (!job) break;
      if (job.status === 'queued') {
        job.status = 'running';
        await putJob(job);
      }
      const statusAtPickup = job.status;
      await runOneBatch(job);

      // 批次期间用户可能已暂停/取消：以 DB 中的最新状态为准，
      // 只把进度字段合并回去，绝不用内存里的旧 status 覆盖用户操作
      const fresh = await getJob(job.id);
      if (!fresh) break;
      if (fresh.status !== statusAtPickup) {
        // 用户改了状态（cancelled/paused/error）：保留其决定，仅合并进度（不通知，是用户自己的操作）
        fresh.done = job.done;
        fresh.params = job.params;
        fresh.undoLog = job.undoLog;
        fresh.result = job.result;
        fresh.updatedAt = Date.now();
        await putJob(fresh);
        break;
      }
      job.updatedAt = Date.now();
      await putJob(job);
      if (statusAtPickup !== job.status && shouldNotify(job.status)) {
        await notifyJobTerminal(job);
      }
      if (!isActive(job)) break;
    }
    await clearAlarmIfIdle();
  } catch (e) {
    console.error('[autobookmark] organize tick failed:', e);
    const job = await getCurrentJob();
    if (job) {
      // 若用户在批次失败前已取消/暂停，尊重其状态，不强改 error
      const fresh = await getJob(job.id);
      if (fresh && fresh.status !== 'running' && fresh.status !== 'queued') {
        await clearAlarmIfIdle();
      } else {
        job.status = 'error';
        job.error = (e as Error).message;
        job.updatedAt = Date.now();
        await putJob(job);
        await notifyJobTerminal(job);
        await clearAlarmIfIdle();
      }
    }
  } finally {
    ticking = false;
  }
}

/** 传给长扫描任务的取消检查器：DB 中状态不再是 running 即应停止 */
async function makeStopChecker(jobId: string): Promise<() => Promise<boolean>> {
  return async () => {
    const job = await getJob(jobId);
    return !job || job.status !== 'running';
  };
}

async function runOneBatch(job: OrganizeJob): Promise<void> {
  const settings = await getSettings();

  if (job.kind === 'enhance') {
    await processEnhanceBatch(settings, job);
    if (job.done >= job.total) {
      const skipped = (job.params as unknown as EnhanceParams).skipped ?? 0;
      job.result = {
        report: [
          `已为 ${job.done - skipped} 条书签补全元数据`,
          ...(skipped ? [`${skipped} 条调用失败被跳过，可重跑本任务补全`] : []),
        ],
      };
      job.status = 'done';
    }
    return;
  }
  if (job.kind === 'classify') {
    await processClassifyBatch(settings, job);
    if (job.status !== 'running') return;
    if (job.result?.report) job.status = 'done';
    return;
  }
  if (job.kind === 'dedupe') {
    // 全库扫描耗时长，支持中途取消
    await scanDuplicates(settings, job, await makeStopChecker(job.id));
    return;
  }
  if (job.kind === 'deadlink') {
    await processDeadlinkBatch(job);
    return;
  }
}

export async function pauseJob(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job || !isActive(job)) return false;
  job.status = 'paused';
  job.updatedAt = Date.now();
  await putJob(job);
  return true;
}

export async function resumeJob(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  // paused：用户暂停；error：瞬时故障（如超时）后从当前进度继续，不重复已完成批次
  if (!job || (job.status !== 'paused' && job.status !== 'error')) return false;
  job.status = 'queued';
  job.updatedAt = Date.now();
  await putJob(job);
  await ensureAlarm();
  void tick();
  return true;
}

export async function deleteJob(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job) return false;
  if (isActive(job)) throw new Error('任务进行中，请先暂停或取消再删除');
  await deleteJobById(jobId);
  return true;
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job || !isActive(job)) return false;
  job.status = 'cancelled';
  job.updatedAt = Date.now();
  await putJob(job);
  await clearAlarmIfIdle();
  return true;
}

async function removeWithUndo(job: OrganizeJob, bookmarkId: string): Promise<void> {
  const node = (await browser.bookmarks.get(bookmarkId).catch(() => []))[0];
  if (!node) return;
  const entry: UndoEntry = {
    op: 'remove',
    parentId: node.parentId ?? '',
    title: node.title,
    url: node.url,
  };
  const meta = await getMeta(bookmarkId);
  if (meta) entry.meta = meta;
  await browser.bookmarks.remove(bookmarkId).catch(() => undefined);
  await deleteMeta(bookmarkId);
  job.undoLog.push(entry);
}

/** review 落地：去重（每组保留项）/ 死链（确认删除清单） */
export async function resolveJob(
  jobId: string,
  decision: { keepByGroup?: Record<string, string>; removeIds?: string[] },
): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job || job.status !== 'awaiting-review') return false;

  if (job.kind === 'dedupe' && decision.keepByGroup) {
    const groups = job.result?.groups ?? [];
    for (const [groupId, keepId] of Object.entries(decision.keepByGroup)) {
      const group = groups.find((g) => g.id === groupId);
      if (!group) continue;
      for (const item of group.items) {
        if (item.bookmarkId === keepId) continue;
        await removeWithUndo(job, item.bookmarkId);
      }
    }
  }
  if (decision.removeIds) {
    for (const id of decision.removeIds) await removeWithUndo(job, id);
  }

  job.status = 'done';
  job.updatedAt = Date.now();
  await putJob(job);
  invalidateSearchIndex();
  return true;
}

/**
 * 反向回放 undo 日志，恢复原状。
 * 关键点：
 * 1. 撤销前先自动备份现状（防撤销本身出错）
 * 2. 重建被删文件夹时记录 旧id→新id 映射，move 回放通过映射找到新父级
 *    （旧实现直接用旧 id，文件夹被 sweep 删过就必然失败——书签回不去）
 * 3. 删除新建分类文件夹前检查非空：非空说明 move 回放失败，绝不能 removeTree
 *    连里面的书签一起删掉（宁可留下空文件夹也不能丢数据）
 */
export async function undoJob(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job || job.status === 'undone') return false;
  if (!job.undoLog.length) return false;

  await createSnapshot('撤销前自动备份').catch(() => undefined);

  const idMap = new Map<string, string>();
  const resolveParent = (pid: string): string => {
    let mapped = pid;
    while (idMap.has(mapped)) mapped = idMap.get(mapped)!;
    return mapped;
  };

  for (const entry of [...job.undoLog].reverse()) {
    try {
      if (entry.op === 'move') {
        const target = resolveParent(entry.fromParentId);
        try {
          await browser.bookmarks.move(entry.id, { parentId: target, index: entry.index });
        } catch {
          await browser.bookmarks.move(entry.id, { parentId: target });
        }
      } else if (entry.op === 'create-folder') {
        const children = await browser.bookmarks.getChildren(entry.id);
        if (children.length === 0) {
          await browser.bookmarks.remove(entry.id);
        } else {
          console.warn(
            '[autobookmark] undo: 分类文件夹非空（其中的书签未能移回），跳过删除以保护数据:',
            entry.id,
          );
        }
      } else if (entry.op === 'remove') {
        const created = await browser.bookmarks.create({
          parentId: entry.parentId,
          title: entry.title,
          ...(entry.url ? { url: entry.url } : {}),
        });
        // 重建的是被 sweep 删掉的旧文件夹 → 映射旧 id，供后续 move 回放定位
        if (!entry.url && entry.folderId) {
          idMap.set(entry.folderId, created.id);
        }
        if (entry.meta) {
          await putMeta({ ...entry.meta, bookmarkId: created.id, updatedAt: Date.now() });
        }
      }
    } catch (e) {
      console.warn('[autobookmark] undo entry failed:', entry, e);
    }
  }

  job.status = 'undone';
  job.updatedAt = Date.now();
  await putJob(job);
  invalidateSearchIndex();
  return true;
}
