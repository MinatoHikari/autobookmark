<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { startStream } from '../../../shared/stream';
import type { ChatMessage } from '../../../core/providers/client';

/** 展示条目：普通消息或工具活动徽章 */
interface ChatItem {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
}

const CHAT_KEY = 'agentChat';

const items = ref<ChatItem[]>([]);
const history = ref<ChatMessage[]>([]); // 完整 API 会话（含 tool 消息）
const input = ref('');
const running = ref(false);
const errorMsg = ref('');
const listEl = ref<HTMLElement | null>(null);

const QUICK_PROMPTS = [
  '帮我看看书签库里有哪些目录',
  '把书签栏里的书签按主题重命名，加上统一的格式',
  '找出重复收藏的书签',
];

async function scrollToBottom() {
  await nextTick();
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
}

async function persist() {
  try {
    await browser.storage.session.set({ [CHAT_KEY]: { items: items.value, history: history.value } });
  } catch {
    /* session 不可用时只在内存保留 */
  }
}

async function clearChat() {
  items.value = [];
  history.value = [];
  errorMsg.value = '';
  await persist();
}

function sendQuick(text: string) {
  input.value = text;
  void send();
}

async function send() {
  const text = input.value.trim();
  if (!text || running.value) return;
  errorMsg.value = '';
  input.value = '';
  running.value = true;

  items.value.push({ role: 'user', text });
  const userMsg: ChatMessage = { role: 'user', content: text };
  const runHistory = [...history.value, userMsg];

  // 助手流式气泡
  const assistantIdx = items.value.push({ role: 'assistant', text: '' }) - 1;
  await persist();
  await scrollToBottom();

  startStream(
    'agent',
    { history: runHistory },
    {
      onDelta: (delta) => {
        items.value[assistantIdx]!.text += delta;
        void scrollToBottom();
      },
      onTool: (name, detail) => {
        items.value.push({ role: 'tool', text: detail, toolName: name });
        void scrollToBottom();
      },
      onDone: (raw) => {
        // 用最终文本替换流式气泡（含工具轮次后的完整回复）
        const newMessages = (raw ?? []) as unknown as ChatMessage[];
        const finals = newMessages.filter((m) => m.role === 'assistant');
        const finalText = finals.map((m) => m.content).filter(Boolean).join('\n\n');
        items.value[assistantIdx]!.text = finalText || items.value[assistantIdx]!.text || '（无回复）';
        history.value = [...runHistory, ...newMessages];
        running.value = false;
        void persist();
        void scrollToBottom();
      },
      onError: (message) => {
        errorMsg.value = message;
        if (!items.value[assistantIdx]!.text) items.value.splice(assistantIdx, 1);
        running.value = false;
        void persist();
      },
    },
  );
}

onMounted(async () => {
  try {
    const saved = await browser.storage.session.get(CHAT_KEY);
    const data = saved[CHAT_KEY] as { items?: ChatItem[]; history?: ChatMessage[] } | undefined;
    if (data?.items?.length) {
      items.value = data.items;
      history.value = data.history ?? [];
      await scrollToBottom();
    }
  } catch {
    /* session 不可用则忽略 */
  }
});
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col bg-slate-50">
    <div class="flex items-center gap-2 px-4 py-2 border-b border-slate-200 bg-white shrink-0">
      <span class="text-xs text-slate-400">
        用自然语言指挥书签操作：整理、批量重命名、移动、查找…删除类操作超过 3 条需要你确认
      </span>
      <span class="flex-1"></span>
      <button
        class="px-2.5 py-1 rounded-lg border border-slate-200 text-[11px] text-slate-500 hover:bg-slate-50"
        @click="clearChat"
      >
        清空对话
      </button>
    </div>

    <p v-if="errorMsg" class="mx-4 mt-2 px-3 py-2 rounded-lg bg-red-50 text-red-600 text-xs">{{ errorMsg }}</p>

    <!-- 消息列表 -->
    <div ref="listEl" class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
      <div v-if="!items.length" class="h-full grid place-items-center text-center">
        <div>
          <div class="text-3xl mb-3">🤖</div>
          <p class="text-sm text-slate-500 mb-3">用一句话管理整个书签库</p>
          <div class="space-y-1.5">
            <button
              v-for="q in QUICK_PROMPTS"
              :key="q"
              class="block mx-auto px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
              @click="sendQuick(q)"
            >
              {{ q }}
            </button>
          </div>
        </div>
      </div>

      <template v-for="(item, i) in items" :key="i">
        <!-- 工具活动徽章 -->
        <div v-if="item.role === 'tool'" class="flex justify-center">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-[10px] text-slate-500">
            🔧 {{ item.toolName }} · {{ item.text }}
          </span>
        </div>

        <!-- 用户气泡 -->
        <div v-else-if="item.role === 'user'" class="flex justify-end">
          <div class="max-w-[80%] px-3 py-2 rounded-2xl rounded-br-sm bg-indigo-600 text-white text-sm leading-relaxed whitespace-pre-wrap break-words">
            {{ item.text }}
          </div>
        </div>

        <!-- 助手气泡 -->
        <div v-else class="flex justify-start">
          <div
            class="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-sm bg-white border border-slate-200 text-sm leading-relaxed whitespace-pre-wrap break-words"
            :class="running && i === items.length - 1 && 'animate-pulse'"
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
</template>
