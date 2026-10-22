import { browser } from 'wxt/browser';
import { rt, localeTag } from './i18n';

/** PublicPath 只包含 WXT 已知的输出文件，_favicon 是 Chrome 运行时内置路径 */
const FAVICON_BASE = '/_favicon/' as unknown as Parameters<typeof browser.runtime.getURL>[0];

/**
 * 书签站点图标地址。
 * Chromium 用内置 favicon 服务（需 manifest 声明 "favicon" 权限）；
 * Firefox 没有该服务，直接取站点根路径的 /favicon.ico（不经过第三方，无隐私外泄）。
 * 加载失败由 FaviconImg 组件隐藏兜底。
 */
export function faviconUrl(pageUrl: string, size = 32): string {
  if (import.meta.env.FIREFOX) {
    try {
      return `${new URL(pageUrl).origin}/favicon.ico`;
    } catch {
      return '';
    }
  }
  return `${browser.runtime.getURL(FAVICON_BASE)}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
}

export function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return rt('time.justNow');
  if (minutes < 60) return rt('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rt('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return rt('time.daysAgo', { n: days });
  return new Date(ts).toLocaleDateString(localeTag());
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

/** 在当前标签页打开（覆盖活动标签） */
export async function openInCurrentTab(url: string): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await browser.tabs.update(tab.id, { url });
    return;
  }
  await browser.tabs.create({ url });
}

/** 新窗口（incognito = 无痕窗口）打开 */
export async function openInWindow(url: string, incognito = false): Promise<void> {
  await browser.windows.create({ url, incognito });
}

/**
 * 新标签页打开。
 * background = 在后台打开（焦点留在当前页面）；打开方读取 openNewTabInBackground 设置后传入
 */
export async function openInNewTab(url: string, background = false): Promise<void> {
  await browser.tabs.create({ url, active: !background });
}

/**
 * 结合设置与修饰键计算后台打开：
 * 设置为开 → 默认后台；按住 Ctrl/Cmd 时取反为前台。
 * 设置为关 → 默认前台；按住 Ctrl/Cmd 时取反为后台。
 */
export function backgroundOpen(inBackground: boolean | undefined, e?: MouseEvent): boolean {
  const base = inBackground ?? false;
  return e?.ctrlKey || e?.metaKey ? !base : base;
}
