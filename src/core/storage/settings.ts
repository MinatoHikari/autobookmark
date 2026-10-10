import { z } from 'zod';
import { browser } from 'wxt/browser';

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

export const AI_TASKS = ['enhance', 'tldr', 'embedding'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_TASK_LABELS: Record<AiTask, string> = {
  enhance: '智能收藏（标题/摘要/标签）',
  tldr: '页面 TL;DR',
  embedding: '语义索引（向量搜索）',
};

export const settingsSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerConfigSchema),
  bindings: z.object({
    enhance: modelRefSchema.nullable(),
    tldr: modelRefSchema.nullable(),
    embedding: modelRefSchema.nullable(),
  }),
  preferences: z.object({
    /** 收藏根文件夹名（挂在"其他书签"下） */
    rootFolder: z.string().min(1),
    /** 是否按 AI 建议创建子文件夹 */
    autoFolder: z.boolean(),
    language: z.enum(['zh', 'en']),
    /** 发送给 AI 的正文最大字符数 */
    maxContentChars: z.number().int().min(500).max(64_000),
    contextMenuEnabled: z.boolean(),
    /** 整理任务完成/失败时发送浏览器通知 */
    notifications: z.boolean(),
    /** AI 收藏存放策略：aiFolder=存入「AI 收藏」目录；existing=在已有目录中寻找合适目录（可在其下新建） */
    saveStrategy: z.enum(['aiFolder', 'existing']),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  providers: [],
  bindings: { enhance: null, tldr: null, embedding: null },
  preferences: {
    rootFolder: 'AI 收藏',
    autoFolder: true,
    language: 'zh',
    maxContentChars: 8_000,
    contextMenuEnabled: true,
    notifications: true,
    saveStrategy: 'aiFolder',
  },
};

const STORAGE_KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  const parsed = settingsSchema.safeParse(raw);
  // 字段不完整时用默认值补齐，避免旧版本数据崩溃
  return parsed.success ? parsed.data : { ...structuredClone(DEFAULT_SETTINGS), ...raw };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: settingsSchema.parse(settings) });
}
