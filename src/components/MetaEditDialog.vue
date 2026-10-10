<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { MetaBrief, TreeNodeDto } from '../shared/types';
import { sendMessage } from '../shared/messages';

const props = defineProps<{
  /** null 时隐藏 */
  node: TreeNodeDto | null;
  /** 已有 AI 元数据（未增强的书签为空，保存时自动创建） */
  meta?: MetaBrief | null;
}>();

const emit = defineEmits<{ close: []; saved: [metaChanged: boolean] }>();

const form = reactive({ title: '', url: '', summary: '', tags: [] as string[], newTag: '' });
const saving = ref(false);
const errorMsg = ref('');

watch(
  () => props.node?.id,
  () => {
    if (!props.node) return;
    form.title = props.node.title;
    form.url = props.node.url ?? '';
    form.summary = props.meta?.summary ?? '';
    form.tags = props.meta ? [...props.meta.tags] : [];
    form.newTag = '';
    errorMsg.value = '';
  },
  { immediate: true },
);

function addTag() {
  const t = form.newTag.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
  if (t && !form.tags.includes(t)) form.tags.push(t);
  form.newTag = '';
}

function removeTag(tag: string) {
  form.tags = form.tags.filter((t) => t !== tag);
}

async function save() {
  if (!props.node) return;
  if (!form.title.trim()) {
    errorMsg.value = '标题不能为空';
    return;
  }
  const url = form.url.trim();
  if (url && !/^https?:\/\//i.test(url)) {
    errorMsg.value = '链接必须以 http:// 或 https:// 开头';
    return;
  }
  saving.value = true;
  errorMsg.value = '';
  try {
    const urlChanged = url !== (props.node.url ?? '');
    let metaChanged = false;
    // 未增强书签首次保存即创建元数据记录（空字段也创建，使其进入"已增强"状态）
    if (urlChanged || !props.meta || form.summary.trim() || form.tags.length) {
      const next = await sendMessage('updateMeta', {
        bookmarkId: props.node.id,
        url: urlChanged ? url : undefined,
        summary: form.summary.trim(),
        tags: form.tags,
      });
      metaChanged = !!next;
    }
    const title = form.title.trim();
    if (title && title !== props.node.title) {
      await sendMessage('renameNode', { id: props.node.id, title });
      metaChanged = true;
    }
    emit('saved', metaChanged);
    emit('close');
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div
    v-if="node"
    class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl space-y-3">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-semibold">编辑书签</h3>
        <span v-if="!meta" class="text-[10px] px-1.5 py-px rounded bg-amber-50 text-amber-600 border border-amber-200">
          未增强 · 保存后将创建元数据
        </span>
        <span class="flex-1"></span>
        <button class="text-slate-400 hover:text-slate-600 text-sm leading-none" @click="emit('close')">×</button>
      </div>

      <p v-if="errorMsg" class="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs">{{ errorMsg }}</p>

      <label class="block">
        <span class="text-xs font-medium text-slate-500">书签标题</span>
        <input
          v-model="form.title"
          class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
      </label>
      <label class="block">
        <span class="text-xs font-medium text-slate-500">链接</span>
        <input
          v-model="form.url"
          spellcheck="false"
          class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-mono focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
      </label>
      <label class="block">
        <span class="text-xs font-medium text-slate-500">AI 摘要</span>
        <textarea
          v-model="form.summary"
          rows="3"
          placeholder="留空则不生成摘要（可用 ✨ AI 增强自动生成）"
          class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs leading-relaxed resize-none focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        ></textarea>
      </label>
      <div>
        <span class="text-xs font-medium text-slate-500">标签</span>
        <div class="mt-1 flex flex-wrap gap-1">
          <span
            v-for="tag in form.tags"
            :key="tag"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-xs"
          >
            {{ tag }}
            <button class="text-indigo-400 hover:text-indigo-700" @click="removeTag(tag)">×</button>
          </span>
        </div>
        <input
          v-model="form.newTag"
          placeholder="回车添加标签"
          class="mt-1.5 w-full px-2.5 py-1 rounded-lg border border-dashed border-slate-300 text-xs focus:outline-none focus:border-indigo-400"
          @keydown.enter.prevent="addTag"
        />
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <button
          class="px-4 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
          @click="emit('close')"
        >
          取消
        </button>
        <button
          class="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
