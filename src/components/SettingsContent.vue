<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { sendMessage } from '../shared/messages';
import type { ProviderPreset } from '../core/providers/presets';
import {
  AI_TASK_LABELS,
  settingsSchema,
  type AiTask,
  type ProviderConfig,
  type Settings,
} from '../core/storage/settings';
import { PROVIDER_PRESETS, newProviderFromPreset } from '../core/providers/presets';
import {
  createClient,
  ensureOriginPermission,
  AiClientError,
} from '../core/providers/client';
import type { Usage } from '../shared/types';

type Tab = 'providers' | 'bindings' | 'preferences' | 'usage';

const tab = ref<Tab>('providers');
const settings = ref<Settings | null>(null);
const saving = ref(false);
const savedFlash = ref(false);
const usage = ref<Usage>({});

// 供应商编辑的临时态（不落库，点保存才写）
const showKey = ref<Record<string, boolean>>({});
const testing = ref<Record<string, 'testing' | 'ok' | 'fail'>>({});
const testMessage = ref<Record<string, string>>({});
const addPresetId = ref('');

async function reload() {
  const s = await sendMessage('getSettings');
  settings.value = s;
  const u = await sendMessage('getUsage');
  usage.value = u;
}

async function persist() {
  if (!settings.value) return;
  saving.value = true;
  try {
    settings.value = await sendMessage('saveSettings', settings.value);
    savedFlash.value = true;
    setTimeout(() => (savedFlash.value = false), 1500);
  } finally {
    saving.value = false;
  }
}

function addProvider() {
  const preset = PROVIDER_PRESETS.find((p) => p.id === addPresetId.value);
  if (!settings.value) return;
  const provider = preset
    ? newProviderFromPreset(preset)
    : {
        id: crypto.randomUUID(),
        presetId: null,
        name: '自定义供应商',
        baseURL: 'https://',
        apiKey: '',
        models: [],
        embeddingModels: [],
      };
  settings.value.providers.push(provider);
  addPresetId.value = '';
}

function removeProvider(id: string) {
  if (!settings.value) return;
  if (!confirm('确定删除这个供应商？')) return;
  settings.value.providers = settings.value.providers.filter((p) => p.id !== id);
  for (const task of ['enhance', 'tldr', 'embedding'] as AiTask[]) {
    if (settings.value.bindings[task]?.providerId === id) {
      settings.value.bindings[task] = null;
    }
  }
}

/** 测试连接：申请域名权限 → 拉模型列表 → （可选）最小 chat 验证 */
async function testProvider(p: ProviderConfig) {
  testing.value[p.id] = 'testing';
  testMessage.value[p.id] = '';
  try {
    const granted = await ensureOriginPermission(p.baseURL);
    if (!granted) throw new Error('未授予该供应商域名的访问权限');

    const client = createClient(p);
    let models: string[] = [];
    try {
      models = await client.listModels();
    } catch (e) {
      // 有些网关不支持 /models，降级为最小 chat 验证
      await client.chat({
        model: p.models[0] ?? 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hi' }],
        signal: AbortSignal.timeout(20_000),
      });
    }
    if (models.length) {
      // 手动填写的 embedding 模型不从对话模型列表里剔除
      p.models = models.filter((m) => !p.embeddingModels.includes(m));
    }
    testing.value[p.id] = 'ok';
    testMessage.value[p.id] = models.length ? `连接正常，发现 ${models.length} 个模型` : '连接正常';
    await persist();
  } catch (e) {
    testing.value[p.id] = 'fail';
    const msg = e instanceof AiClientError ? `${e.message}${e.detail ? '：' + e.detail.slice(0, 120) : ''}` : (e as Error).message;
    testMessage.value[p.id] = msg;
  }
}

async function fetchModels(p: ProviderConfig) {
  const granted = await ensureOriginPermission(p.baseURL);
  if (!granted) {
    testMessage.value[p.id] = '未授予域名权限';
    return;
  }
  try {
    const models = await createClient(p).listModels();
    p.models = models.filter((m) => !p.embeddingModels.includes(m));
    testMessage.value[p.id] = `已拉取 ${models.length} 个模型`;
    await persist();
  } catch (e) {
    testMessage.value[p.id] = `拉取失败：${(e as Error).message}`;
  }
}

function providerOf(id: string | null | undefined): ProviderConfig | undefined {
  return settings.value?.providers.find((p) => p.id === id);
}

function statusLabel(id: string): string {
  const s = testing.value[id];
  return s === 'ok' ? '正常' : s === 'fail' ? '失败' : '测试中…';
}

function presetOf(id: string | null): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((x) => x.id === id);
}

function onBindingProviderChange(task: AiTask, providerId: string) {
  if (!settings.value) return;
  const p = providerOf(providerId);
  const models = task === 'embedding' ? (p?.embeddingModels ?? []) : (p?.models ?? []);
  settings.value.bindings[task] = { providerId, model: models[0] ?? '' };
}

// ---- 配置备份 ----
function exportSettings() {
  if (!settings.value) return;
  const blob = new Blob([JSON.stringify(settings.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `autobookmark-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importSettings(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !settings.value) return;
  try {
    const next = settingsSchema.parse(JSON.parse(await file.text()));
    settings.value = await sendMessage('saveSettings', next);
    savedFlash.value = true;
    setTimeout(() => alert('导入成功'), 100);
  } catch (e) {
    alert(`导入失败：${(e as Error).message}`);
  }
  input.value = '';
}

async function clearUsageStats() {
  if (!confirm('清零所有用量统计？')) return;
  await sendMessage('clearUsage');
  usage.value = {};
}

const usageRows = computed(() => {
  if (!settings.value) return [];
  return Object.entries(usage.value).map(([providerId, entry]) => ({
    name: settings.value!.providers.find((p) => p.id === providerId)?.name ?? providerId.slice(0, 8),
    ...entry,
  }));
});

onMounted(reload);
</script>

<template>
  <div class="space-y-6">
    <div v-if="!settings" class="p-10 text-center text-slate-400 text-sm">加载中…</div>

    <div v-else class="space-y-6">
      <header class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-indigo-600 text-white grid place-items-center font-bold">A</div>
        <div>
          <h1 class="text-lg font-semibold">AutoBookmark 设置</h1>
          <p class="text-xs text-slate-400">API Key 仅保存在浏览器本地，不会上传到任何服务器</p>
        </div>
        <span class="flex-1"></span>
        <span v-if="savedFlash" class="text-xs text-green-600">已保存 ✓</span>
      </header>

      <!-- Tabs -->
      <nav class="flex gap-1 p-1 rounded-xl bg-slate-100 w-fit">
        <button
          v-for="t in (['providers', 'bindings', 'preferences', 'usage'] as Tab[])"
          :key="t"
          class="px-4 py-1.5 rounded-lg text-sm transition-colors"
          :class="tab === t ? 'bg-white shadow-sm font-medium text-indigo-700' : 'text-slate-500 hover:text-slate-700'"
          @click="tab = t"
        >
          {{ { providers: '供应商', bindings: '任务绑定', preferences: '偏好', usage: '用量' }[t] }}
        </button>
      </nav>

      <!-- 供应商 -->
      <section v-if="tab === 'providers'" class="space-y-4">
        <div class="flex gap-2 items-center">
          <select
            v-model="addPresetId"
            class="px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm flex-1"
          >
            <option value="" disabled>添加供应商（选择预置模板）…</option>
            <option v-for="preset in PROVIDER_PRESETS" :key="preset.id" :value="preset.id">
              {{ preset.name }} — {{ preset.baseURL }}
            </option>
            <option value="custom">自定义（任意 OpenAI 兼容接口）</option>
          </select>
          <button
            class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40"
            :disabled="!addPresetId"
            @click="addProvider"
          >
            添加
          </button>
        </div>

        <div
          v-for="p in settings.providers"
          :key="p.id"
          class="rounded-xl bg-white border border-slate-200 p-4 space-y-3"
        >
          <div class="flex items-center gap-2">
            <input
              v-model="p.name"
              class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm font-medium w-48"
            />
            <span
              v-if="testing[p.id]"
              class="text-xs px-2 py-0.5 rounded-full"
              :class="{
                'bg-slate-100 text-slate-500': testing[p.id] === 'testing',
                'bg-green-50 text-green-600': testing[p.id] === 'ok',
                'bg-red-50 text-red-600': testing[p.id] === 'fail',
              }"
            >
              {{ statusLabel(p.id) }}
            </span>
            <span class="flex-1"></span>
            <button
              class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
              @click="testProvider(p)"
            >
              测试连接
            </button>
            <button
              class="px-2.5 py-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50"
              @click="removeProvider(p.id)"
            >
              删除
            </button>
          </div>

          <p v-if="testMessage[p.id]" class="text-xs" :class="testing[p.id] === 'fail' ? 'text-red-600' : 'text-slate-500'">
            {{ testMessage[p.id] }}
          </p>

          <label class="block">
            <span class="text-xs font-medium text-slate-500">Base URL（OpenAI 兼容）</span>
            <input
              v-model="p.baseURL"
              placeholder="https://api.z.ai/api/paas/v4"
              class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm font-mono"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-slate-500">API Key</span>
            <div class="mt-1 flex gap-2">
              <input
                :type="showKey[p.id] ? 'text' : 'password'"
                v-model="p.apiKey"
                placeholder="sk-…"
                autocomplete="off"
                class="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm font-mono"
              />
              <button
                class="px-3 rounded-lg border border-slate-200 text-xs text-slate-500 hover:bg-slate-50"
                @click="showKey[p.id] = !showKey[p.id]"
              >
                {{ showKey[p.id] ? '隐藏' : '显示' }}
              </button>
            </div>
          </label>

          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-slate-500">对话模型（逗号分隔）</span>
              <textarea
                :value="p.models.join(', ')"
                @change="p.models = ($event.target as HTMLTextAreaElement).value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)"
                rows="2"
                class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-mono resize-none"
              ></textarea>
            </label>
            <label class="block">
              <span class="text-xs font-medium text-slate-500">Embedding 模型（可选）</span>
              <textarea
                :value="p.embeddingModels.join(', ')"
                @change="p.embeddingModels = ($event.target as HTMLTextAreaElement).value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)"
                rows="2"
                placeholder="如 embedding-3（DeepSeek 无需填）"
                class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-mono resize-none"
              ></textarea>
            </label>
          </div>
          <div class="flex justify-between items-center">
            <a
              v-if="presetOf(p.presetId)?.keyUrl"
              :href="presetOf(p.presetId)?.keyUrl"
              target="_blank"
              class="text-xs text-indigo-500 hover:underline"
            >
              获取 API Key ↗
            </a>
            <span v-else class="text-xs text-slate-400"></span>
            <button
              class="text-xs text-slate-500 hover:text-indigo-600"
              @click="fetchModels(p)"
            >
              从 /models 拉取模型列表
            </button>
          </div>
        </div>

        <div v-if="!settings.providers.length" class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          还没有供应商，从上方选择一个预置模板开始
        </div>

        <!-- 配置备份 -->
        <div class="rounded-xl bg-white border border-slate-200 p-4 flex items-center gap-3">
          <div class="flex-1">
            <p class="text-xs font-medium">配置备份</p>
            <p class="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              导出含 API Key 的完整配置 JSON；重装 / 换浏览器 / 换电脑时导入即可恢复
            </p>
          </div>
          <button
            class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
            @click="exportSettings"
          >
            导出配置
          </button>
          <label class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 cursor-pointer">
            导入配置
            <input type="file" accept="application/json,.json" class="hidden" @change="importSettings" />
          </label>
        </div>

        <div class="flex justify-end">
          <button
            class="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            :disabled="saving"
            @click="persist"
          >
            {{ saving ? '保存中…' : '保存设置' }}
          </button>
        </div>
      </section>

      <!-- 任务绑定 -->
      <section v-else-if="tab === 'bindings'" class="space-y-4">
        <p class="text-xs text-slate-500 bg-indigo-50 text-indigo-700 rounded-lg px-3 py-2 leading-relaxed">
          每个功能可以绑定不同的供应商/模型：例如摘要用便宜的 GLM-4.5-Air，整理用更强的 GLM-4.6。语义索引需供应商提供
          /embeddings 接口（DeepSeek 不提供，可留空，搜索将退化为关键词模式）。
        </p>
        <div
          v-for="task in (['enhance', 'tldr', 'embedding'] as AiTask[])"
          :key="task"
          class="rounded-xl bg-white border border-slate-200 p-4 space-y-2.5"
        >
          <p class="text-sm font-medium">{{ AI_TASK_LABELS[task] }}</p>
          <div class="flex gap-2">
            <select
              :value="settings.bindings[task]?.providerId ?? ''"
              class="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white"
              @change="onBindingProviderChange(task, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">未配置</option>
              <option v-for="p in settings.providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <select
              v-if="settings.bindings[task]"
              v-model="settings.bindings[task]!.model"
              class="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white font-mono"
            >
              <option v-for="m in (task === 'embedding' ? (providerOf(settings.bindings[task]!.providerId)?.embeddingModels ?? []) : (providerOf(settings.bindings[task]!.providerId)?.models ?? []))" :key="m" :value="m">
                {{ m }}
              </option>
            </select>
          </div>
        </div>
        <div class="flex justify-end">
          <button
            class="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            :disabled="saving"
            @click="persist"
          >
            {{ saving ? '保存中…' : '保存设置' }}
          </button>
        </div>
      </section>

      <!-- 偏好 -->
      <section v-else-if="tab === 'preferences'" class="rounded-xl bg-white border border-slate-200 p-4 space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-medium text-slate-500">收藏根文件夹（挂在"其他书签"下）</span>
            <input v-model="settings.preferences.rootFolder" class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm" />
          </label>
          <label class="block">
            <span class="text-xs font-medium text-slate-500">摘要/标签语言</span>
            <select v-model="settings.preferences.language" class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white">
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="settings.preferences.autoFolder" class="accent-indigo-600" />
          按 AI 建议的文件夹分类收藏
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="settings.preferences.contextMenuEnabled" class="accent-indigo-600" />
          启用右键菜单"AI 智能收藏此页面"
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="settings.preferences.notifications" class="accent-indigo-600" />
          整理任务完成 / 失败 / 待确认时发送浏览器通知（点击通知打开书签管理）
        </label>
        <label class="block">
          <span class="text-xs font-medium text-slate-500">发送给 AI 的正文上限：{{ settings.preferences.maxContentChars }} 字符</span>
          <input
            type="range"
            min="2000"
            max="32000"
            step="1000"
            v-model.number="settings.preferences.maxContentChars"
            class="mt-1 w-full accent-indigo-600"
          />
          <span class="text-[11px] text-slate-400">越大效果越好，token 消耗越多</span>
        </label>
        <div class="flex justify-end">
          <button
            class="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            :disabled="saving"
            @click="persist"
          >
            {{ saving ? '保存中…' : '保存设置' }}
          </button>
        </div>
      </section>

      <!-- 用量 -->
      <section v-else class="space-y-3">
        <div v-if="!usageRows.length" class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          还没有 AI 调用记录
        </div>
        <table v-else class="w-full rounded-xl bg-white border border-slate-200 text-sm">
          <thead>
            <tr class="text-left text-xs text-slate-400 border-b border-slate-100">
              <th class="px-4 py-2.5 font-medium">供应商</th>
              <th class="px-4 py-2.5 font-medium text-right">调用次数</th>
              <th class="px-4 py-2.5 font-medium text-right">输入 tokens</th>
              <th class="px-4 py-2.5 font-medium text-right">输出 tokens</th>
              <th class="px-4 py-2.5 font-medium text-right">最近使用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in usageRows" :key="row.name" class="border-b border-slate-50 last:border-0">
              <td class="px-4 py-2.5">{{ row.name }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums">{{ row.calls }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-slate-500">{{ row.promptTokens }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-slate-500">{{ row.completionTokens }}</td>
              <td class="px-4 py-2.5 text-right text-slate-400">{{ row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString('zh-CN') : '-' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="usageRows.length" class="flex justify-end">
          <button class="px-4 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-500 hover:bg-slate-50" @click="clearUsageStats">
            清零统计
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
