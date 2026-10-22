import { z } from 'zod';
import { browser } from 'wxt/browser';
import { detectLocale, setRuntimeLocale } from '../../shared/i18n';

export const providerConfigSchema = z.object({
  id: z.string().min(1),
  /** 来自哪个预置模板，自定义供应商为 null */
  presetId: z.string().nullable().default(null),
  name: z.string().min(1),
  baseURL: z.string().url(),
  apiKey: z.string().default(''),
  /** 对话模型列表 */
  models: z.array(z.string()).default([]),
  /** 支持 /embeddings 的模型列表（可与 models 重叠） */
  embeddingModels: z.array(z.string()).default([]),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const modelRefSchema = z.object({
  providerId: z.string(),
  model: z.string(),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

export const AI_TASKS = ['enhance', 'tldr', 'embedding', 'agent'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const settingsSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerConfigSchema),
  bindings: z.object({
    enhance: modelRefSchema.nullable(),
    tldr: modelRefSchema.nullable(),
    embedding: modelRefSchema.nullable(),
    agent: modelRefSchema.nullable(),
  }),
  preferences: z.object({
    /** 收藏根文件夹名（挂在"其他书签"下） */
    rootFolder: z.string().min(1),
    /** 是否按 AI 建议创建子文件夹 */
    autoFolder: z.boolean(),
    /** AI 生成内容（标题/摘要/标签）的语言 */
    language: z.enum(['zh', 'ja', 'en']),
    /** 发送给 AI 的正文最大字符数 */
    maxContentChars: z.number().int().min(500).max(64_000),
    contextMenuEnabled: z.boolean(),
    /** 整理任务完成/失败时发送浏览器通知 */
    notifications: z.boolean(),
    /** AI 收藏存放策略：aiFolder=存入「AI 收藏」目录；existing=在已有目录中寻找合适目录（可在其下新建） */
    saveStrategy: z.enum(['aiFolder', 'existing']),
    /** popup 左键打开书签的方式 */
    bookmarkOpenMode: z.enum(['newTab', 'currentTab']),
    /** 新标签页在后台打开（焦点留在当前页面） */
    openNewTabInBackground: z.boolean(),
    /** 界面语言（zh=简体中文 ja=日本語 en=English） */
    uiLanguage: z.enum(['zh', 'ja', 'en']),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  providers: [],
  bindings: { enhance: null, tldr: null, embedding: null, agent: null },
  preferences: {
    rootFolder: 'AI 收藏',
    autoFolder: true,
    language: 'zh',
    maxContentChars: 8_000,
    contextMenuEnabled: true,
    notifications: true,
    saveStrategy: 'aiFolder',
    bookmarkOpenMode: 'newTab',
    openNewTabInBackground: false,
    // 升级安装（有旧 settings 缺字段）默认 zh；全新安装由 getSettings 按浏览器语言推断
    uiLanguage: 'zh',
  },
};

const STORAGE_KEY = 'settings';

/** 每次读写设置都同步运行时语言，让后台通知/报告/错误消息跟随界面语言 */
function syncRuntimeLocale(s: Settings): void {
  setRuntimeLocale(s.preferences.uiLanguage);
}

export async function getSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!raw) {
    // 全新安装：界面语言跟随浏览器语言；
    // 升级安装走下方深合并（缺 uiLanguage 字段时用默认 zh，不隐性切换存量用户）
    const fresh = structuredClone(DEFAULT_SETTINGS);
    fresh.preferences.uiLanguage = detectLocale();
    syncRuntimeLocale(fresh);
    return fresh;
  }
  // 旧版本设置缺新增字段（如 bindings.agent / saveStrategy）：
  // 必须逐段与默认值深合并，否则保存时会因缺少必填键而校验失败
  const defaults = structuredClone(DEFAULT_SETTINGS);
  const rawAny = raw as Partial<Settings>;
  const merged: Settings = {
    ...defaults,
    ...rawAny,
    bindings: { ...defaults.bindings, ...(rawAny.bindings ?? {}) },
    preferences: { ...defaults.preferences, ...(rawAny.preferences ?? {}) },
    providers: Array.isArray(rawAny.providers) ? rawAny.providers : defaults.providers,
  };
  const parsed = settingsSchema.safeParse(merged);
  const result = parsed.success ? parsed.data : defaults;
  syncRuntimeLocale(result);
  return result;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const parsed = settingsSchema.parse(settings);
  syncRuntimeLocale(parsed);
  await browser.storage.local.set({ [STORAGE_KEY]: parsed });
}
