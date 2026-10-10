import { browser } from 'wxt/browser';
import type { OrganizeJob } from '../../shared/types';
import { getSettings } from '../storage/settings';

const KIND_LABELS: Record<OrganizeJob['kind'], string> = {
  enhance: '补全元数据',
  classify: '自动分类',
  dedupe: '去重',
  deadlink: '死链检测',
};

const TERMINAL_NOTIFY: OrganizeJob['status'][] = ['done', 'error', 'awaiting-review'];

/** 任务到达终态时是否需要通知 */
export function shouldNotify(status: OrganizeJob['status']): boolean {
  return TERMINAL_NOTIFY.includes(status);
}

async function show(title: string, message: string): Promise<void> {
  await browser.notifications.create(`job-${crypto.randomUUID()}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: `AutoBookmark · ${title}`,
    message,
  });
}

/** 任务终态通知（完成/失败/待确认），失败静默（无通知权限的环境不影响任务） */
export async function notifyJobTerminal(job: OrganizeJob): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.preferences.notifications) return;
    const kind = KIND_LABELS[job.kind] ?? job.kind;

    if (job.status === 'done') {
      await show(`整理完成 · ${kind}`, job.result?.report?.slice(0, 2).join('\n') ?? '任务已完成');
    } else if (job.status === 'awaiting-review') {
      const groups = job.result?.groups?.length ?? 0;
      await show(
        `待确认 · ${kind}`,
        groups ? `发现 ${groups} 组待处理项，请在整理中心确认` : '请在整理中心确认结果',
      );
    } else if (job.status === 'error') {
      await show(`整理失败 · ${kind}`, (job.error ?? '可点击「继续」从进度处重试').slice(0, 200));
    }
  } catch (e) {
    console.warn('[autobookmark] notification failed:', e);
  }
}
