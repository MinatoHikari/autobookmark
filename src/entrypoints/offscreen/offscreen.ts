import { browser } from 'wxt/browser';
import { extractMarkdown } from '../../core/organize/parse';

/**
 * offscreen document：接收 SW 转发的 HTML 字符串，
 * 解析逻辑在 core/organize/parse.ts（Firefox 构建不含本入口，直接在 background 解析）。
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
