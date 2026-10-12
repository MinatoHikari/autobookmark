<script lang="ts">
/**
 * 模块级输入草稿：切换视图（组件卸载重建）后仍保留，刷新页面才清空。
 * 放在模块作用域而非组件实例，保证跨挂载存活。
 */
let inputDraft = '';
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import { startStream } from '../../../shared/stream';
import type { ChatMessage } from '../../../core/providers/client';
import { sendMessage } from '../../../shared/messages';
import {
  AI_TASK_LABELS,
  type ProviderConfig,
  type Settings,
} from '../../../core/storage/settings';

/** 展示条目：普通消息或工具活动徽章 */
interface ChatItem {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
}

interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  items: ChatItem[];
  /** 完整 API 会话（含 tool 消息），每轮结束后持久化 */
  history: ChatMessage[];
}

const STORE_KEY = 'agentConversations';
const ACTIVE_KEY = 'agentActiveId';

const conversations = ref<Conversation[]>([]);
const activeId = ref<string>('');
const input = ref(inputDraft);
watch(input, (v) => {
  inputDraft = v;
});
const running = ref(false);
const errorMsg = ref('');
const listEl = ref<HTMLElement | null>(null);

// ---- 模型选择 ----
const settings = ref<Settings | null>(null);
const providers = computed<ProviderConfig[]>(() => settings.value?.providers ?? []);
const agentBinding = computed(() => settings.value?.bindings.agent ?? null);
const agentProviderModels = computed(
  () => providers.value.find((p) => p.id === agentBinding.value?.providerId)?.models ?? [],
);

async function persistSettings() {
  if (settings.value) {
    settings.value = await sendMessage('saveSettings', settings.value);
  }
}

function onAgentProviderChange(providerId: string) {
  if (!settings.value) return;
  if (!providerId) {
    settings.value.bindings.agent = null;
  } else {
    const p = providers.value.find((x) => x.id === providerId);
    settings.value.bindings.agent = { providerId, model: p?.models[0] ?? '' };
  }
  void persistSettings();
}

async function onAgentModelChange(model: string) {
  if (!settings.value?.bindings.agent) return;
  settings.value.bindings.agent.model = model;
  await persistSettings();
}

// ---- 会话管理 ----
const active = computed(() => conversations.value.find((c) => c.id === activeId.value) ?? null);

function newConversation(): Conversation {
  return { id: crypto.randomUUID(), title: '新对话', createdAt: Date.now(), items: [], history: [] };
}

function switchTo(id: string) {
  if (running.value) return;
  activeId.value = id;
  errorMsg.value = '';
  void persistAll();
  void scrollToBottom();
}

function createConversation() {
  if (running.value) return;
  const convo = newConversation();
  conversations.value.unshift(convo);
  activeId.value = convo.id;
  errorMsg.value = '';
  void persistAll();
}

function deleteConversation(id: string) {
  const idx = conversations.value.findIndex((c) => c.id === id);
  if (idx < 0) return;
  if (running.value && activeId.value === id) return;
  conversations.value.splice(idx, 1);
  if (activeId.value === id || !conversations.value.some((c) => c.id === activeId.value)) {
    if (!conversations.value.length) conversations.value.unshift(newConversation());
    activeId.value = conversations.value[0]!.id;
  }
  void persistAll();
}

async function persistAll() {
  try {
    // chrome.storage 会把 Vue reactive Proxy 数组序列化成数字键对象，必须深拷贝为纯 JSON
    await browser.storage.local.set({
      [STORE_KEY]: JSON.parse(JSON.stringify(conversations.value)),
      [ACTIVE_KEY]: activeId.value,
    });
  } catch {
    /* 存储不可用时只在内存保留 */
  }
}

async function scrollToBottom() {
  await nextTick();
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
}

// ---- 发送 ----
async function send() {
  const convo = active.value;
  const text = input.value.trim();
  if (!text || running.value || !convo) return;
  errorMsg.value = '';
  input.value = '';
  running.value = true;

  if (convo.title === '新对话') convo.title = text.slice(0, 24);
  convo.items.push({ role: 'user', text });
  const userMsg: ChatMessage = { role: 'user', content: text };
  const runHistory = [...convo.history, userMsg];

  const assistantIdx = convo.items.push({ role: 'assistant', text: '' }) - 1;
  await persistAll();
  await scrollToBottom();

  startStream(
    'agent',
    { history: runHistory },
    {
      onDelta: (delta) => {
        convo.items[assistantIdx]!.text += delta;
        void scrollToBottom();
      },
      onTool: (name, detail) => {
        convo.items.push({ role: 'tool', text: detail, toolName: name });
        void persistAll();
        void scrollToBottom();
      },
      onDone: (raw) => {
        const newMessages = (raw ?? []) as unknown as ChatMessage[];
        const finals = newMessages.filter((m) => m.role === 'assistant');
        const finalText = finals.map((m) => m.content).filter(Boolean).join('\n\n');
        convo.items[assistantIdx]!.text = finalText || convo.items[assistantIdx]!.text || '（无回复）';
        convo.history = [...runHistory, ...newMessages];
        running.value = false;
        void persistAll();
        void scrollToBottom();
      },
      onError: (message) => {
        errorMsg.value = message;
        if (!convo.items[assistantIdx]!.text) convo.items.splice(assistantIdx, 1);
        running.value = false;
        void persistAll();
      },
    },
  );
}

async function clearActiveChat() {
  const convo = active.value;
  if (!convo || running.value) return;
  convo.items = [];
  convo.history = [];
  convo.title = '新对话';
  await persistAll();
}

onMounted(async () => {
  settings.value = await sendMessage('getSettings');
  try {
    const stored = await browser.storage.local.get([STORE_KEY, ACTIVE_KEY]);
    conversations.value = Array.isArray(stored[STORE_KEY]) ? (stored[STORE_KEY] as Conversation[]) : [];
    activeId.value = (stored[ACTIVE_KEY] as string) ?? '';
  } catch {
    conversations.value = [];
  }
  if (!conversations.value.length) {
    conversations.value = [newConversation()];
    activeId.value = conversations.value[0]!.id;
    await persistAll();
  }
  if (!conversations.value.some((c) => c.id === activeId.value)) {
    activeId.value = conversations.value[0]!.id;
  }
  await scrollToBottom();
});

// 消息条数或激活会话变化时自动持久化（流式 delta 期间不落盘，onTool/onDone 已显式保存）
watch(
  () => [conversations.value.map((c) => c.items.length).join(','), activeId.value],
  () => void persistAll(),
);
</script>

<template>
  <div class="flex-1 min-h-0 flex bg-slate-50">
    <!-- 会话列表侧栏 -->
    <aside class="w-52 shrink-0 flex flex-col bg-white border-r border-slate-200">
      <button
        class="m-2 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-40"
        :disabled="running"
        @click="createConversation"
      >
        ＋ 新对话
      </button>
      <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
        <div
          v-for="c in conversations"
          :key="c.id"
          class="group flex items-center gap-1 rounded-lg px-2 py-1.5 cursor-pointer text-xs transition-colors"
          :class="activeId === c.id ? 'bg-indigo-100 text-indigo-800 font-medium' : 'hover:bg-slate-100 text-slate-600'"
          @click="switchTo(c.id)"
        >
          <span class="truncate flex-1">{{ c.title }}</span>
          <button
            class="shrink-0 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100"
            title="删除此对话"
            @click.stop="deleteConversation(c.id)"
          >
            ✕
          </button>
        </div>
      </div>
    </aside>

    <!-- 对话主区 -->
    <div class="flex-1 min-w-0 flex flex-col">
      <!-- 顶部：模型选择 -->
      <div class="flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-white shrink-0">
        <span class="text-xs text-slate-400">{{ AI_TASK_LABELS.agent }}</span>
        <span class="flex-1"></span>
        <template v-if="agentBinding">
          <select
            class="px-2 py-1 rounded-lg border border-slate-200 text-[11px] bg-white max-w-[140px]"
            :value="agentBinding.providerId"
            @change="onAgentProviderChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select
            class="px-2 py-1 rounded-lg border border-slate-200 text-[11px] bg-white font-mono max-w-[180px]"
            :value="agentBinding.model"
            @change="onAgentModelChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="m in agentProviderModels" :key="m" :value="m">{{ m }}</option>
            <option v-if="agentBinding.model && !agentProviderModels.includes(agentBinding.model)" :value="agentBinding.model">
              {{ agentBinding.model }}
            </option>
          </select>
        </template>
        <template v-else-if="providers.length">
          <button
            class="px-2.5 py-1 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-700"
            @click="onAgentProviderChange(providers[0]!.id)"
          >
            选择模型
          </button>
        </template>
        <span v-else class="text-[11px] text-amber-600">先在设置中添加供应商</span>
        <button
          class="px-2.5 py-1 rounded-lg border border-slate-200 text-[11px] text-slate-500 hover:bg-slate-50"
          @click="clearActiveChat"
        >
          清空对话
        </button>
      </div>

      <p v-if="errorMsg" class="mx-4 mt-2 px-3 py-2 rounded-lg bg-red-50 text-red-600 text-xs">{{ errorMsg }}</p>

      <!-- 消息列表 -->
      <div ref="listEl" class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <div v-if="!active?.items.length" class="h-full grid place-items-center text-center">
          <div>
            <div class="text-3xl mb-3">🤖</div>
            <p class="text-sm text-slate-500 mb-3">用一句话管理整个书签库</p>
            <div class="space-y-1.5">
              <button
                v-for="q in [
                  '帮我看看书签库里有哪些目录',
                  '把书签栏里的书签按主题重命名，加上统一的格式',
                  '找出重复收藏的书签',
                ]"
                :key="q"
                class="block mx-auto px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
                @click="
                  input = q;
                  send();
                "
              >
                {{ q }}
              </button>
            </div>
          </div>
        </div>

        <template v-for="(item, i) in active?.items ?? []" :key="i">
          <div v-if="item.role === 'tool'" class="flex justify-center">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-[10px] text-slate-500">
              🔧 {{ item.toolName }} · {{ item.text }}
            </span>
          </div>

          <div v-else-if="item.role === 'user'" class="flex justify-end">
            <div class="max-w-[80%] px-3 py-2 rounded-2xl rounded-br-sm bg-indigo-600 text-white text-sm leading-relaxed whitespace-pre-wrap break-words">
              {{ item.text }}
            </div>
          </div>

          <div v-else class="flex justify-start">
            <div
              class="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-sm bg-white border border-slate-200 text-sm leading-relaxed whitespace-pre-wrap break-words"
              :class="running && i === (active?.items.length ?? 0) - 1 && 'animate-pulse'"
            >
              {{ item.text || '…' }}
            </div>
          </div>
        </template>
      </div>

      <!-- 输入区 -->
      <div class="shrink-0 p-3 border-t border-slate-200 bg-white">
        <div class="flex gap-2 items-end">
          <textarea
            v-model="input"
            rows="2"
            placeholder="例如：把「书签栏」里的书签按用途分类整理；把 osu 目录下的书签标题都加上【游戏】前缀…"
            class="flex-1 resize-none px-3 py-2 rounded-xl border border-slate-200 text-sm leading-relaxed focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button
            class="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40"
            :disabled="running || !input.trim()"
            @click="send"
          >
            {{ running ? '执行中…' : '发送' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
