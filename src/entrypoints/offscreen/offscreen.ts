import { browser } from 'wxt/browser';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

function extractMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndown.remove(['script', 'style', 'noscript', 'iframe']);
  const article = new Readability(doc, { charThreshold: 80 }).parse();
  return article?.content ? turndown.turndown(article.content).trim() : '';
}

/**
 * offscreen document：接收 SW 转发的 HTML 字符串，
 * DOMParser + Readability + Turndown 解析出 Markdown 正文。
 * （MV3 service worker 没有 DOM，这是 Chromium 官方推荐的解析路径）
 */
const onMessage = browser.runtime.onMessage as unknown as {
  addListener: (fn: (message: unknown) => unknown) => void;
};
onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; html?: string };
  if (msg?.type !== 'ab-offscreen-extract') return undefined;
  try {
    return Promise.resolve({ markdown: extractMarkdown(msg.html ?? '') });
  } catch (e) {
    console.warn('[autobookmark] offscreen extract failed:', e);
    return Promise.resolve({ markdown: '' });
  }
});
