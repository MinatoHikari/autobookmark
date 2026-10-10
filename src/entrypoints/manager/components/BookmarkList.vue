<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MetaBrief, TreeNodeDto } from '../../../shared/types';
import { sendMessage } from '../../../shared/messages';
import { faviconUrl, formatTime } from '../../../shared/ui';
import MetaEditDialog from '../../../components/MetaEditDialog.vue';

const props = defineProps<{
  folder: TreeNodeDto | null;
  metaById: Record<string, MetaBrief>;
  busyIds: Set<string>;
}>();

const emit = defineEmits<{
  open: [url: string];
  openFolder: [node: TreeNodeDto];
  enhance: [ids: string[]];
  metaChanged: [];
  nodeChanged: [];
}>();

const checked = ref(new Set<string>());
const editingNode = ref<TreeNodeDto | null>(null);
const deleteConfirmId = ref('');

const folders = computed(() => (props.folder?.children ?? []).filter((c) => !c.url));
const bookmarks = computed(() => (props.folder?.children ?? []).filter((c) => c.url));

function toggleCheck(id: string) {
  const next = new Set(checked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  checked.value = next;
}

function isEnhanced(id: string): boolean {
  return !!props.metaById[id];
}

function startEdit(node: TreeNodeDto) {
  editingNode.value = node;
}

async function removeItem(id: string) {
  if (deleteConfirmId.value !== id) {
    deleteConfirmId.value = id;
    setTimeout(() => {
      if (deleteConfirmId.value === id) deleteConfirmId.value = '';
    }, 2500);
    return;
  }
  await sendMessage('removeNode', id);
  checked.value = new Set([...checked.value].filter((x) => x !== id));
  deleteConfirmId.value = '';
  emit('nodeChanged');
}

function onDragStart(node: TreeNodeDto, event: DragEvent) {
  event.dataTransfer?.setData(
    'application/x-ab-node',
    JSON.stringify({ type: node.url ? 'bookmark' : 'folder', id: node.id }),
  );
  event.dataTransfer!.effectAllowed = 'move';
}

async function enhanceChecked() {
  const ids = [...checked.value];
  if (!ids.length) return;
  emit('enhance', ids);
  checked.value = new Set();
}

async function enhanceOne(id: string) {
  emit('enhance', [id]);
}
</script>

<template>
  <div class="space-y-3">
    <!-- 子文件夹 -->
    <div v-if="folders.length" class="flex flex-wrap gap-2">
      <button
        v-for="folder in folders"
        :key="folder.id"
        draggable="true"
        class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-sm hover:border-indigo-300 hover:text-indigo-700 transition-colors"
        @click="emit('openFolder', folder)"
        @dragstart="onDragStart(folder, $event)"
      >
        <span>📁</span>{{ folder.title }}
        <span class="text-[10px] text-slate-400">{{ folder.children.length }}</span>
      </button>
    </div>

    <!-- 批量操作栏 -->
    <div
      v-if="checked.size"
      class="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm shadow"
    >
      <span>已选 {{ checked.size }} 项</span>
      <span class="flex-1"></span>
      <button class="px-2.5 py-1 rounded bg-white/15 hover:bg-white/25" @click="enhanceChecked">
        ✨ AI 增强 ({{ checked.size }})
      </button>
      <button class="px-2.5 py-1 rounded bg-white/15 hover:bg-white/25" @click="checked = new Set()">
        取消选择
      </button>
    </div>

    <!-- 书签卡片 -->
    <div
      v-for="node in bookmarks"
      :key="node.id"
      class="group flex items-start gap-2.5 rounded-xl bg-white border p-3 transition-colors"
      :class="[checked.has(node.id) ? 'border-indigo-300 bg-indigo-50/40' : 'border-slate-200 hover:border-indigo-200']"
      draggable="true"
      @dragstart="onDragStart(node, $event)"
    >
      <input
        type="checkbox"
        class="mt-1 accent-indigo-600"
        :checked="checked.has(node.id)"
        @change="toggleCheck(node.id)"
      />
      <img :src="faviconUrl(node.url ?? '')" class="w-4 h-4 mt-1 rounded" alt="" loading="lazy" />
      <div class="min-w-0 flex-1 cursor-pointer" @click="emit('open', node.url ?? '')">
        <div class="flex items-center gap-1.5 flex-wrap">
          <h3 class="text-sm font-medium leading-snug break-words group-hover:text-indigo-700 transition-colors">
            {{ node.title }}
          </h3>
          <span
            v-if="!isEnhanced(node.id)"
            class="text-[10px] px-1.5 py-px rounded bg-amber-50 text-amber-600 border border-amber-200"
            >未增强</span
          >
          <span v-if="busyIds.has(node.id)" class="text-[10px] text-indigo-500 animate-pulse">AI 处理中…</span>
        </div>
        <p v-if="metaById[node.id]?.summary" class="mt-1 text-xs text-slate-600 leading-relaxed line-clamp-2">
          {{ metaById[node.id]!.summary }}
        </p>
        <div class="mt-1.5 flex items-center gap-2 flex-wrap">
          <span class="text-[11px] text-slate-400 truncate max-w-[240px]">{{ node.url }}</span>
          <span v-if="node.dateAdded" class="text-[11px] text-slate-400">· {{ formatTime(node.dateAdded) }}</span>
        </div>
        <div v-if="metaById[node.id]?.tags?.length" class="mt-1.5 flex flex-wrap gap-1">
          <span
            v-for="tag in metaById[node.id]!.tags"
            :key="tag"
            class="px-1.5 py-0.5 rounded text-[10px] bg-indigo-50 text-indigo-600"
          >
            {{ tag }}
          </span>
        </div>
      </div>
      <div class="shrink-0 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          class="p-1.5 rounded-md text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
          title="AI 增强 / 编辑元数据"
          @click="isEnhanced(node.id) ? startEdit(node) : enhanceOne(node.id)"
        >
          ✨
        </button>
        <button
          v-if="isEnhanced(node.id)"
          class="p-1.5 rounded-md text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
          title="编辑"
          @click="startEdit(node)"
        >
          ✎
        </button>
        <button
          class="p-1.5 rounded-md text-sm"
          :class="deleteConfirmId === node.id ? 'text-red-600 bg-red-50' : 'text-slate-400 hover:bg-slate-100 hover:text-red-500'"
          :title="deleteConfirmId === node.id ? '再点一次确认删除' : '删除'"
          @click="removeItem(node.id)"
        >
          🗑
        </button>
      </div>
    </div>

    <div v-if="!bookmarks.length && !folders.length" class="py-16 text-center text-sm text-slate-400">
      此文件夹为空
    </div>

    <!-- 元数据编辑弹层（共享组件） -->
    <MetaEditDialog
      :node="editingNode"
      :meta="editingNode ? (metaById[editingNode.id] ?? null) : null"
      @close="editingNode = null"
      @saved="emit('metaChanged'); emit('nodeChanged')"
    />
  </div>
</template>
