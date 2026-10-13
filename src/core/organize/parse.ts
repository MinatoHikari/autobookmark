import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

/**
 * HTML → Markdown 正文（DOMParser + Readability + Turndown）。
 * Chromium：在 offscreen document 里调用（service worker 无 DOM）；
 * Firefox：MV3 background 是带 DOM 的 event page，直接在 background 里调用。
 */
export function extractMarkdown(html: string): string {
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
