import { ref } from 'vue';
import { browser } from 'wxt/browser';
import type { Settings } from '../../core/storage/settings';
import { zh } from './locales/zh';
import { en } from './locales/en';
import { ja } from './locales/ja';

export type Locale = 'zh' | 'ja' | 'en';
export type I18nKey = keyof typeof zh;
export type TParams = Record<string, string | number>;

const DICTS: Record<Locale, Record<I18nKey, string>> = { zh, en, ja };

/** settings 存储键（与 core/storage/settings.ts 的 STORAGE_KEY 一致；此处不直接引用以避免运行时循环依赖） */
const SETTINGS_KEY = 'settings';

/** 浏览器语言 → 界面语言（仅全新安装的默认值推断用；升级安装缺字段时保持 zh） */
export function detectLocale(): Locale {
  const lang = (navigator.language ?? '').toLowerCase();
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('zh')) return 'zh';
  return 'en';
}

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** 当前界面语言（模块级共享；t 读取它以建立响应依赖） */
const locale = ref<Locale>('zh');

/**
 * 运行时语言：后台 service worker / 核心层没有 initI18n 生命周期，
 * 由 settings.ts 的 getSettings/saveSettings 在每次读写设置时同步，
 * 保证通知、报告、错误消息跟随生成时刻的界面语言。
 */
let runtimeLocale: Locale = 'zh';

export function setRuntimeLocale(l: Locale): void {
  runtimeLocale = l;
}

/** 纯函数版本：后台 service worker / 核心层生成通知与报告时用（无响应式需求） */
export function tIn(l: Locale, key: I18nKey, params?: TParams): string {
  return interpolate(DICTS[l][key] ?? zh[key] ?? key, params);
}

/** 运行时 t：核心层 / 后台用，语言跟随最近一次设置的读写 */
export function rt(key: I18nKey, params?: TParams): string {
  return tIn(runtimeLocale, key, params);
}

/** 列表分隔符：中日文用顿号，英文用逗号 */
export function listSep(): string {
  return runtimeLocale === 'en' ? ', ' : '、';
}

/**
 * 前台响应式 t：在模板 / computed 中调用时自动跟踪 locale，
 * 切换语言后用到文案的组件会整体重渲染。
 */
export function t(key: I18nKey, params?: TParams): string {
  return tIn(locale.value, key, params);
}

/** 组件内约定入口（当前与 t 同一函数） */
export function useI18n() {
  return t;
}

/** 界面语言对应的 BCP 47 标签（日期 toLocaleString 等本地化格式用） */
export function localeTag(l?: Locale): string {
  const v = l ?? locale.value;
  return v === 'zh' ? 'zh-CN' : v === 'ja' ? 'ja-JP' : 'en-US';
}

/** 前台入口初始化：读设置中的界面语言，并监听其他界面保存设置后的变更（popup/manager/设置页即时同步） */
let started = false;
export async function initI18n(): Promise<void> {
  if (started) return;
  started = true;
  const raw = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Settings | undefined;
  locale.value = raw?.preferences?.uiLanguage ?? detectLocale();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = (changes.settings.newValue as Settings | undefined)?.preferences?.uiLanguage;
    if (next) locale.value = next;
  });
}
