import { browser } from 'wxt/browser';

/** PublicPath 只包含 WXT 已知的输出文件，_favicon 是 Chrome 运行时内置路径 */
const FAVICON_BASE = '/_favicon/' as unknown as Parameters<typeof browser.runtime.getURL>[0];

/** Chrome 内置 favicon 服务（需 manifest 里声明 "favicon" 权限） */
export function faviconUrl(pageUrl: string, size = 32): string {
  return `${browser.runtime.getURL(FAVICON_BASE)}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
}

export function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** 文本被截断时才设置原生 title（浏览器 tooltip 默认约 1s 延迟），绑定在 truncate 元素的 mouseenter 上 */
export function tooltipIfTruncated(event: MouseEvent): void {
  const el = event.currentTarget as HTMLElement;
  el.title = el.scrollWidth > el.clientWidth ? (el.textContent ?? '').trim() : '';
}
