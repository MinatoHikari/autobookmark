<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { sendMessage } from '../shared/messages';
import { useI18n, localeTag, type I18nKey } from '../shared/i18n';
import type { ProviderPreset } from '../core/providers/presets';
import {
  AI_TASKS,
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

const t = useI18n();
const tab = ref<Tab>('providers');
const settings = ref<Settings | null>(null);
const saving = ref(false);
const savedFlash = ref(false);
const usage = ref<Usage>({});

// ---- 自定义弹层（原生 confirm/alert 在无头/自动化环境下会永久阻塞页面）----
const confirmState = ref<null | { text: string; action: () => void }>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const notice = ref('');
function showNotice(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ''), 3000);
}
function askConfirm(text: string, action: () => void) {
  confirmState.value = { text, action };
}
function runConfirm() {
  const c = confirmState.value;
  confirmState.value = null;
  c?.action();
}

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
    ? { ...newProviderFromPreset(preset), name: presetName(preset) }
    : {
        id: crypto.randomUUID(),
        presetId: null,
        name: t('settings.customProviderName'),
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
  askConfirm(t('settings.confirmRemoveProvider'), () => {
    if (!settings.value) return;
    settings.value.providers = settings.value.providers.filter((p) => p.id !== id);
    for (const task of ['enhance', 'tldr', 'embedding'] as AiTask[]) {
      if (settings.value.bindings[task]?.providerId === id) {
        settings.value.bindings[task] = null;
      }
    }
  });
}

/** 测试连接：申请域名权限 → 拉模型列表 → （可选）最小 chat 验证 */
async function testProvider(p: ProviderConfig) {
  testing.value[p.id] = 'testing';
  testMessage.value[p.id] = '';
  try {
    const granted = await ensureOriginPermission(p.baseURL);
    if (!granted) throw new Error(t('settings.errorNoOriginPermission'));

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
    testMessage.value[p.id] = models.length ? t('settings.testOkModels', { n: models.length }) : t('settings.testOk');
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
    testMessage.value[p.id] = t('settings.errorNoOriginPermissionShort');
    return;
  }
  try {
    const models = await createClient(p).listModels();
    p.models = models.filter((m) => !p.embeddingModels.includes(m));
    testMessage.value[p.id] = t('settings.fetchedModels', { n: models.length });
    await persist();
  } catch (e) {
    testMessage.value[p.id] = t('settings.fetchFailed', { msg: (e as Error).message });
  }
}

function providerOf(id: string | null | undefined): ProviderConfig | undefined {
  return settings.value?.providers.find((p) => p.id === id);
}

function statusLabel(id: string): string {
  const s = testing.value[id];
  return s === 'ok' ? t('settings.statusOk') : s === 'fail' ? t('settings.statusFail') : t('settings.statusTesting');
}

function presetOf(id: string | null): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((x) => x.id === id);
}

// 预设名跟随界面语言展示与落库（presets.ts 里的 name 是中文兜底，防止词典漏项）
const PRESET_NAME_KEYS: Record<string, I18nKey> = {
  zai: 'settings.presetName.zai',
  'zai-coding': 'settings.presetName.zai-coding',
  'zai-cn': 'settings.presetName.zai-cn',
  'zai-cn-coding': 'settings.presetName.zai-cn-coding',
  deepseek: 'settings.presetName.deepseek',
  openai: 'settings.presetName.openai',
  'opencode-zen': 'settings.presetName.opencode-zen',
  'opencode-go': 'settings.presetName.opencode-go',
  ollama: 'settings.presetName.ollama',
};
function presetName(preset: ProviderPreset): string {
  const key = PRESET_NAME_KEYS[preset.id];
  return key ? t(key) : preset.name;
}

const TASK_LABEL_KEYS: Record<AiTask, I18nKey> = {
  enhance: 'settings.taskEnhance',
  tldr: 'settings.taskTldr',
  embedding: 'settings.taskEmbedding',
  agent: 'settings.taskAgent',
};

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
    showNotice(t('settings.importOk'));
  } catch (e) {
    showNotice(t('settings.importFailed', { msg: (e as Error).message }));
  }
  input.value = '';
}

async function clearUsageStats() {
  askConfirm(t('settings.confirmClearUsage'), async () => {
    await sendMessage('clearUsage');
    usage.value = {};
  });
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
    <div v-if="!settings" class="p-10 text-center text-slate-400 text-sm">{{ t('common.loading') }}</div>

    <div v-else class="space-y-6">
      <header class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-indigo-600 text-white grid place-items-center font-bold">A</div>
        <div>
          <h1 class="text-lg font-semibold">{{ t('settings.pageTitle') }}</h1>
          <p class="text-xs text-slate-400">{{ t('settings.privacyNote') }}</p>
        </div>
        <span class="flex-1"></span>
        <span v-if="savedFlash" class="text-xs text-green-600">{{ t('settings.savedFlash') }}</span>
      </header>

      <!-- Tabs -->
      <nav class="flex gap-1 p-1 rounded-xl bg-slate-100 w-fit">
        <button
          v-for="tabKey in (['providers', 'bindings', 'preferences', 'usage'] as Tab[])"
          :key="tabKey"
          class="px-4 py-1.5 rounded-lg text-sm transition-colors"
          :class="tab === tabKey ? 'bg-white shadow-sm font-medium text-indigo-700' : 'text-slate-500 hover:text-slate-700'"
          @click="tab = tabKey"
        >
          {{ ({ providers: t('settings.tabProviders'), bindings: t('settings.tabBindings'), preferences: t('settings.tabPreferences'), usage: t('settings.tabUsage') })[tabKey] }}
        </button>
      </nav>

      <!-- 供应商 -->
      <section v-if="tab === 'providers'" class="space-y-4">
        <div class="flex gap-2 items-center">
          <select
            v-model="addPresetId"
            class="px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm flex-1"
          >
            <option value="" disabled>{{ t('settings.addPresetPlaceholder') }}</option>
            <option v-for="preset in PROVIDER_PRESETS" :key="preset.id" :value="preset.id">
              {{ presetName(preset) }} — {{ preset.baseURL }}
            </option>
            <option value="custom">{{ t('settings.customOption') }}</option>
          </select>
          <button
            class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40"
            :disabled="!addPresetId"
            @click="addProvider"
          >
            {{ t('settings.addBtn') }}
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
              {{ t('settings.testBtn') }}
            </button>
            <button
              class="px-2.5 py-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50"
              @click="removeProvider(p.id)"
            >
              {{ t('common.delete') }}
            </button>
          </div>

          <p v-if="testMessage[p.id]" class="text-xs" :class="testing[p.id] === 'fail' ? 'text-red-600' : 'text-slate-500'">
            {{ testMessage[p.id] }}
          </p>

          <label class="block">
            <span class="text-xs font-medium text-slate-500">{{ t('settings.baseUrlLabel') }}</span>
            <input
              v-model="p.baseURL"
              placeholder="https://api.z.ai/api/paas/v4"
              class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm font-mono"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-slate-500">{{ t('settings.apiKeyLabel') }}</span>
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
                {{ showKey[p.id] ? t('settings.hide') : t('settings.show') }}
              </button>
            </div>
          </label>

          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs font-medium text-slate-500">{{ t('settings.modelsLabel') }}</span>
              <textarea
                :value="p.models.join(', ')"
                @change="p.models = ($event.target as HTMLTextAreaElement).value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)"
                rows="2"
                class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-mono resize-none"
              ></textarea>
            </label>
            <label class="block">
              <span class="text-xs font-medium text-slate-500">{{ t('settings.embeddingModelsLabel') }}</span>
              <textarea
                :value="p.embeddingModels.join(', ')"
                @change="p.embeddingModels = ($event.target as HTMLTextAreaElement).value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)"
                rows="2"
                :placeholder="t('settings.embeddingPlaceholder')"
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
              {{ t('settings.getKeyLink') }}
            </a>
            <span v-else class="text-xs text-slate-400"></span>
            <button
              class="text-xs text-slate-500 hover:text-indigo-600"
              @click="fetchModels(p)"
            >
              {{ t('settings.fetchModelsBtn') }}
            </button>
          </div>
        </div>

        <div v-if="!settings.providers.length" class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          {{ t('settings.noProviders') }}
        </div>

        <!-- 配置备份 -->
        <div class="rounded-xl bg-white border border-slate-200 p-4 flex items-center gap-3">
          <div class="flex-1">
            <p class="text-xs font-medium">{{ t('settings.configBackupTitle') }}</p>
            <p class="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              {{ t('settings.configBackupDesc') }}
            </p>
          </div>
          <button
            class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
            @click="exportSettings"
          >
            {{ t('settings.exportBtn') }}
          </button>
          <label class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 cursor-pointer">
            {{ t('settings.importBtn') }}
            <input type="file" accept="application/json,.json" class="hidden" @change="importSettings" />
          </label>
        </div>

        <div class="flex justify-end">
          <button
            class="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            :disabled="saving"
            @click="persist"
          >
            {{ saving ? t('common.saving') : t('settings.saveBtn') }}
          </button>
        </div>
      </section>

      <!-- 任务绑定 -->
      <section v-else-if="tab === 'bindings'" class="space-y-4">
        <p class="text-xs text-slate-500 bg-indigo-50 text-indigo-700 rounded-lg px-3 py-2 leading-relaxed">
          {{ t('settings.bindingsIntro') }}
        </p>
        <div
          v-for="task in (AI_TASKS as readonly AiTask[])"
          :key="task"
          class="rounded-xl bg-white border border-slate-200 p-4 space-y-2.5"
        >
          <p class="text-sm font-medium">{{ t(TASK_LABEL_KEYS[task]) }}</p>
          <div class="flex gap-2">
            <select
              :value="settings.bindings[task]?.providerId ?? ''"
              class="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white"
              @change="onBindingProviderChange(task, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ t('settings.unbound') }}</option>
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
            {{ saving ? t('common.saving') : t('settings.saveBtn') }}
          </button>
        </div>
      </section>

      <!-- 偏好 -->
      <section v-else-if="tab === 'preferences'" class="rounded-xl bg-white border border-slate-200 p-4 space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <label class="block">
            <span class="text-xs font-medium text-slate-500">{{ t('settings.rootFolderLabel') }}</span>
            <input v-model="settings.preferences.rootFolder" class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm" />
          </label>
          <label class="block">
            <span class="text-xs font-medium text-slate-500">{{ t('settings.aiLanguageLabel') }}</span>
            <select v-model="settings.preferences.language" class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white">
              <option value="zh">{{ t('settings.langZh') }}</option>
              <option value="ja">{{ t('settings.langJa') }}</option>
              <option value="en">{{ t('settings.langEn') }}</option>
            </select>
          </label>
          <label class="block">
            <span class="text-xs font-medium text-slate-500">{{ t('settings.uiLanguage') }}</span>
            <select v-model="settings.preferences.uiLanguage" class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white">
              <option value="zh">{{ t('settings.langZh') }}</option>
              <option value="ja">{{ t('settings.langJa') }}</option>
              <option value="en">{{ t('settings.langEn') }}</option>
            </select>
          </label>
        </div>
        <label class="block">
          <span class="text-xs font-medium text-slate-500">{{ t('settings.openModeLabel') }}</span>
          <select
            v-model="settings.preferences.bookmarkOpenMode"
            class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white"
          >
            <option value="newTab">{{ t('settings.openModeNewTab') }}</option>
            <option value="currentTab">{{ t('settings.openModeCurrentTab') }}</option>
          </select>
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="settings.preferences.openNewTabInBackground" class="accent-indigo-600" />
          {{ t('settings.backgroundOpenLabel') }}
        </label>
        <div>
          <label class="flex items-center gap-2 text-sm" :class="settings.preferences.saveStrategy === 'existing' && 'opacity-40'">
            <input
              type="checkbox"
              v-model="settings.preferences.autoFolder"
              class="accent-indigo-600"
              :disabled="settings.preferences.saveStrategy === 'existing'"
            />
            {{ t('settings.autoFolderLabel') }}
          </label>
          <p class="text-[11px] text-slate-400 mt-1 leading-relaxed">
            {{
              settings.preferences.saveStrategy === 'existing'
                ? t('settings.autoFolderHintExisting')
                : settings.preferences.autoFolder
                  ? t('settings.autoFolderHintOn')
                  : t('settings.autoFolderHintOff')
            }}
          </p>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="settings.preferences.contextMenuEnabled" class="accent-indigo-600" />
          {{ t('settings.contextMenuLabel') }}
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="settings.preferences.notifications" class="accent-indigo-600" />
          {{ t('settings.notificationsLabel') }}
        </label>
        <label class="block">
          <span class="text-xs font-medium text-slate-500">{{ t('settings.maxContentLabel', { n: settings.preferences.maxContentChars }) }}</span>
          <input
            type="range"
            min="2000"
            max="32000"
            step="1000"
            v-model.number="settings.preferences.maxContentChars"
            class="mt-1 w-full accent-indigo-600"
          />
          <span class="text-[11px] text-slate-400">{{ t('settings.maxContentHint') }}</span>
        </label>
        <div class="flex justify-end">
          <button
            class="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            :disabled="saving"
            @click="persist"
          >
            {{ saving ? t('common.saving') : t('settings.saveBtn') }}
          </button>
        </div>
      </section>

      <!-- 用量 -->
      <section v-else class="space-y-3">
        <div v-if="!usageRows.length" class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          {{ t('settings.noUsage') }}
        </div>
        <table v-else class="w-full rounded-xl bg-white border border-slate-200 text-sm">
          <thead>
            <tr class="text-left text-xs text-slate-400 border-b border-slate-100">
              <th class="px-4 py-2.5 font-medium">{{ t('settings.colProvider') }}</th>
              <th class="px-4 py-2.5 font-medium text-right">{{ t('settings.colCalls') }}</th>
              <th class="px-4 py-2.5 font-medium text-right">{{ t('settings.colPromptTokens') }}</th>
              <th class="px-4 py-2.5 font-medium text-right">{{ t('settings.colCompletionTokens') }}</th>
              <th class="px-4 py-2.5 font-medium text-right">{{ t('settings.colLastUsed') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in usageRows" :key="row.name" class="border-b border-slate-50 last:border-0">
              <td class="px-4 py-2.5">{{ row.name }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums">{{ row.calls }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-slate-500">{{ row.promptTokens }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-slate-500">{{ row.completionTokens }}</td>
              <td class="px-4 py-2.5 text-right text-slate-400">{{ row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString(localeTag()) : '-' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="usageRows.length" class="flex justify-end">
          <button class="px-4 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-500 hover:bg-slate-50" @click="clearUsageStats">
            {{ t('settings.clearUsageBtn') }}
          </button>
        </div>
      </section>
    </div>

    <!-- 确认弹层（替代原生 confirm） -->
    <div
      v-if="confirmState"
      class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6"
      @click.self="confirmState = null"
    >
      <div class="w-full max-w-xs rounded-xl bg-white p-4 shadow-xl space-y-3">
        <p class="text-sm font-medium">{{ t('common.confirmTitle') }}</p>
        <p class="text-xs text-slate-600 leading-relaxed">{{ confirmState.text }}</p>
        <div class="flex justify-end gap-2">
          <button class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50" @click="confirmState = null">{{ t('common.cancel') }}</button>
          <button class="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600" @click="runConfirm">{{ t('common.confirm') }}</button>
        </div>
      </div>
    </div>

    <!-- 轻提示（替代原生 alert，3 秒自动消失） -->
    <div
      v-if="notice"
      class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 rounded-full bg-slate-800 text-white text-xs shadow-lg"
    >
      {{ notice }}
    </div>
  </div>
</template>
