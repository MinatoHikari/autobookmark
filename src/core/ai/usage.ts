import { browser } from 'wxt/browser';
import type { Usage } from '../../shared/types';
import type { ChatUsage } from '../providers/client';

const KEY = 'usage';

export async function getUsage(): Promise<Usage> {
  return ((await browser.storage.local.get(KEY))[KEY] as Usage) ?? {};
}

export async function clearUsage(): Promise<void> {
  await browser.storage.local.remove(KEY);
}

export async function trackUsage(providerId: string, usage?: ChatUsage): Promise<void> {
  const all = await getUsage();
  const entry = all[providerId] ?? {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    lastUsedAt: 0,
  };
  entry.calls += 1;
  if (usage) {
    entry.promptTokens += usage.promptTokens;
    entry.completionTokens += usage.completionTokens;
  }
  entry.lastUsedAt = Date.now();
  all[providerId] = entry;
  await browser.storage.local.set({ [KEY]: all });
}
