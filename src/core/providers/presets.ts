export interface ProviderPreset {
  id: string;
  name: string;
  baseURL: string;
  /** 常见对话模型（"拉取模型"会覆盖/补充） */
  models: string[];
  embeddingModels?: string[];
  /** 获取 API Key 的地址，方便用户直达 */
  keyUrl?: string;
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    baseURL: 'https://api.z.ai/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash'],
    embeddingModels: ['embedding-3'],
    keyUrl: 'https://z.ai/manage/apikey',
  },
  {
    id: 'zai-coding',
    name: 'Z.ai · GLM Coding Plan',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    models: ['glm-5.1', 'glm-5'],
    keyUrl: 'https://z.ai/subscribe',
    note: '订阅制（GLM Coding Plan），走订阅额度；模型列表可点「从 /models 拉取」',
  },
  {
    id: 'zai-cn',
    name: '智谱 BigModel (国内)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash'],
    embeddingModels: ['embedding-3'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'zai-cn-coding',
    name: '智谱 · GLM Coding Plan (国内)',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: ['glm-4.7', 'glm-4.6'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '需先在 open.bigmodel.cn 订阅 GLM Coding Plan，走订阅额度（仅编码场景）',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen (按量付费)',
    baseURL: 'https://opencode.ai/zen/v1',
    models: [],
    keyUrl: 'https://opencode.ai/auth',
    note: 'OpenCode 精选模型网关，按 token 计费；添加后点「从 /models 拉取模型列表」',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go (订阅)',
    baseURL: 'https://opencode.ai/zen/go/v1',
    models: [],
    keyUrl: 'https://opencode.ai/go',
    note: '需订阅 Go($10/月) 或 Go Plus($40/月)；Key 在 opencode.ai/auth 创建，含 GLM/Kimi/Qwen/DeepSeek 等',
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    baseURL: 'http://localhost:11434/v1',
    models: ['qwen3:8b', 'llama3.1:8b'],
    note: '本地运行，无需 API Key（留空即可）；请先在 Ollama 拉取模型',
  },
];

export function newProviderFromPreset(preset: ProviderPreset): {
  id: string;
  presetId: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  embeddingModels: string[];
} {
  return {
    id: crypto.randomUUID(),
    presetId: preset.id,
    name: preset.name,
    baseURL: preset.baseURL,
    apiKey: '',
    models: [...preset.models],
    embeddingModels: preset.embeddingModels ? [...preset.embeddingModels] : [],
  };
}
