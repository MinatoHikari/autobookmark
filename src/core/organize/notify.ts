import { browser } from 'wxt/browser';
import type { OrganizeJob } from '../../shared/types';
import { getSettings } from '../storage/settings';
import { rt, type I18nKey } from '../../shared/i18n';

const KIND_KEYS: Record<OrganizeJob['kind'], I18nKey> = {
  enhance: 'notify.kindEnhance',
  classify: 'notify.kindClassify',
  dedupe: 'notify.kindDedupe',
  deadlink: 'notify.kindDeadlink',
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
    const kind = rt(KIND_KEYS[job.kind]);

    if (job.status === 'done') {
      await show(rt('notify.done', { kind }), job.result?.report?.slice(0, 2).join('\n') ?? rt('notify.doneFallback'));
    } else if (job.status === 'awaiting-review') {
      const groups = job.result?.groups?.length ?? 0;
      await show(
        rt('notify.awaiting', { kind }),
        groups ? rt('notify.awaitingGroups', { n: groups }) : rt('notify.awaitingPlain'),
      );
    } else if (job.status === 'error') {
      await show(rt('notify.failed', { kind }), (job.error ?? rt('notify.failedFallback')).slice(0, 200));
    }
  } catch (e) {
    console.warn('[autobookmark] notification failed:', e);
  }
}
