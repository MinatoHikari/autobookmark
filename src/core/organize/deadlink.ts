import { browser } from 'wxt/browser';
import { rt } from '../../shared/i18n';
import type { OrganizeJob, ReviewGroup } from '../../shared/types';
import { flattenBookmarks, getTreeDtos } from './scan';

const CHECK_BATCH = 12;
const TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;

export interface DeadlinkParams {
  ids: string[];
  deadIds: string[];
  cursor: number;
  /** 诊断记录 */
  checks?: Array<{ url: string; alive: boolean }>;
}

async function checkUrl(url: string): Promise<{ alive: boolean; status: number | 'error' }> {
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(method === 'GET' ? { headers: { Range: 'bytes=0-2048' } } : {}),
      });
      // 405/501 表示不支持该方法，换 GET 再试；其余 >=400 视为死链
      if (res.ok) return { alive: true, status: res.status };
      if (res.status === 405 || res.status === 501) continue;
      return { alive: false, status: res.status };
    } catch (e) {
      console.warn('[autobookmark] deadlink fetch error:', method, url, (e as Error).message);
    }
  }
  return { alive: false, status: 'error' };
}

/** 死链检测：每批 12 条、并发 4 */
export async function processDeadlinkBatch(job: OrganizeJob): Promise<void> {
  const params = job.params as unknown as DeadlinkParams;
  const slice = params.ids.slice(params.cursor, params.cursor + CHECK_BATCH);
  if (!slice.length) {
    await finalizeDeadlink(job);
    return;
  }

  for (let i = 0; i < slice.length; i += CONCURRENCY) {
    await Promise.all(
      slice.slice(i, i + CONCURRENCY).map(async (id) => {
        let node;
        try {
          node = (await browser.bookmarks.get(id))[0];
        } catch {
          return; // 已被删除
        }
        if (!node?.url) return;
        const { alive, status } = await checkUrl(node.url);
        params.checks ??= [];
        params.checks.push({ url: node.url, alive });
        console.log('[autobookmark] deadlink check:', node.url, '=>', status, alive ? 'alive' : 'DEAD');
        if (!alive) params.deadIds.push(id);
      }),
    );
  }
  params.cursor += slice.length;
  job.done += slice.length;
  if (params.cursor >= params.ids.length) await finalizeDeadlink(job);
}

async function finalizeDeadlink(job: OrganizeJob): Promise<void> {
  const params = job.params as unknown as DeadlinkParams;
  const tree = await getTreeDtos();
  const all = new Map(flattenBookmarks(tree).map((b) => [b.id, b]));
  const deadItems = params.deadIds
    .map((id) => all.get(id))
    .filter((b): b is NonNullable<typeof b> => !!b);

  job.result = {
    groups: deadItems.map((b) => ({
      id: b.id,
      items: [
        { bookmarkId: b.id, title: b.title, url: b.url, folderPath: b.folderPath },
      ],
    })),
    report: [rt('organize.reportDeadlink', { n: params.ids.length, m: deadItems.length })],
  };
  job.status = deadItems.length ? 'awaiting-review' : 'done';
}
