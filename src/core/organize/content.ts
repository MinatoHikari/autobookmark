import { browser } from 'wxt/browser';

const OFFSCREEN_URL = '/offscreen.html';

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

    await ensureOffscreen();
    const markdown = await new Promise<string>((resolve) => {
      void browser.runtime
        .sendMessage({ type: 'ab-offscreen-extract', html })
        .then((response: unknown) => resolve(((response as { markdown?: string })?.markdown ?? '')))
        .catch(() => resolve(''));
    });
    return markdown;
  } catch {
    return '';
  }
}

export async function hasAllSiteAccess(): Promise<boolean> {
  return browser.permissions.contains({
    origins: ['http://*/*', 'https://*/*'],
  });
}
