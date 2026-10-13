import { browser } from 'wxt/browser';
import { extractMarkdown } from './parse';

const OFFSCREEN_URL = '/offscreen.html';

/** Chromium 的 SW 无 DOM，正文解析放进 offscreen document；Firefox 无此 API，
 * 但 MV3 background 是带 DOM 的 event page，可直接在本地解析 */
const supportsOffscreen = typeof browser.offscreen !== 'undefined';

/** SW 无 DOM，正文解析放进 offscreen document（DOMParser + Readability） */
async function ensureOffscreen(): Promise<void> {
  const already = await browser.offscreen.hasDocument().catch(() => true);
  if (already) return;
  await browser.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER' as never],
    justification: '提取书签页面正文用于 AI 整理',
  });
}

async function parseHtmlToMarkdown(html: string): Promise<string> {
  if (!supportsOffscreen) return extractMarkdown(html);
  await ensureOffscreen();
  return new Promise<string>((resolve) => {
    void browser.runtime
      .sendMessage({ type: 'ab-offscreen-extract', html })
      .then((response: unknown) => resolve(((response as { markdown?: string })?.markdown ?? '')))
      .catch(() => resolve(''));
  });
}

/**
 * 抓取 URL 并解析为 Markdown 正文（需全站 host 权限）。
 * 失败返回空串，由调用方降级为标题+URL 模式。
 */
export async function fetchPageMarkdown(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(contentType)) return '';
    let html = await res.text();
    if (html.length > 3_000_000) html = html.slice(0, 3_000_000);

    return await parseHtmlToMarkdown(html);
  } catch {
    return '';
  }
}

export async function hasAllSiteAccess(): Promise<boolean> {
  return browser.permissions.contains({
    origins: ['http://*/*', 'https://*/*'],
  });
}
