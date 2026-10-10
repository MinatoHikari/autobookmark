import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { PageContent } from '../shared/types';

/**
 * 按需注入的正文提取器（background 通过 scripting.executeScript({files}) 注入，
 * 然后用一段小的 func 脚本调用 window.__autobookmarkExtract()）。
 * 不注册为常驻 content script：零常驻开销、无需 <all_urls> 权限。
 */
export default defineUnlistedScript(() => {
  const w = window as unknown as Record<string, undefined | (() => PageContent)>;
  if (w.__autobookmarkExtract) return; // 幂等：同页重复注入直接跳过

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndown.remove(['script', 'style', 'noscript', 'iframe']);

  w.__autobookmarkExtract = (): PageContent => {
    const metaContent = (name: string) =>
      document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? '';
    const selection = String(window.getSelection?.() ?? '').trim();

    let title = document.title ?? '';
    let content = '';
    let byline = '';
    let excerpt = metaContent('description');
    let siteName = '';

    try {
      const docClone = document.cloneNode(true) as Document;
      const article = new Readability(docClone, { charThreshold: 80 }).parse();
      if (article) {
        title = article.title ?? title;
        byline = article.byline ?? '';
        excerpt = article.excerpt ?? excerpt;
        siteName = article.siteName ?? '';
        if (article.content) {
          content = turndown.turndown(article.content).trim();
        }
      }
    } catch (e) {
      console.warn('[autobookmark] Readability failed:', e);
    }

    // 降级链：Readability 正文 → 用户选区 → meta description
    if (content.length < 80 && selection.length > 40) {
      content = selection;
    }

    return {
      url: location.href,
      title: title || location.hostname,
      siteName: siteName || location.hostname,
      byline,
      excerpt,
      content,
      selection,
      extractedAt: Date.now(),
    };
  };
});
