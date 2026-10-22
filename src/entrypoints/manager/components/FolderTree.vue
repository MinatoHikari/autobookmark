<script setup lang="ts">
import type { TreeNodeDto } from '../../../shared/types';
import { countBookmarks } from '../../../core/organize/scan';
import { useI18n } from '../../../shared/i18n';
import FaviconImg from '../../../components/FaviconImg.vue';
import { beginRowDrag, draggingId, dropHint, shouldSuppressClick } from '../../../shared/dnd';

const t = useI18n();

const props = defineProps<{
  nodes: TreeNodeDto[];
  selectedId: string;
  expanded: Set<string>;
  depth?: number;
}>();

const emit = defineEmits<{
  select: [node: TreeNodeDto];
  /** 书签叶节点双击：新标签页打开（附带事件以识别 Ctrl/Cmd 修饰键） */
  openBookmark: [node: TreeNodeDto, e?: MouseEvent];
  /** 右键菜单：节点 + 鼠标位置 */
  contextMenu: [payload: { node: TreeNodeDto; x: number; y: number }];
  toggle: [node: TreeNodeDto];
  createIn: [node: TreeNodeDto];
  rename: [node: TreeNodeDto];
  remove: [node: TreeNodeDto];
}>();

/** 顶层即 Chrome 根文件夹（书签栏等）：不可拖动，只接受移入 */
const isRootLevel = () => (props.depth ?? 0) === 0;

function onRowClick(node: TreeNodeDto) {
  if (shouldSuppressClick()) return;
  emit('select', node);
}

function hintClass(node: TreeNodeDto): string {
  const base = draggingId.value === node.id ? 'opacity-40' : '';
  if (dropHint.value?.id !== node.id) return base;
  const zone = dropHint.value.zone;
  if (zone === 'into') return 'ring-2 ring-indigo-400';
  if (zone === 'before') return 'shadow-[inset_0_2px_0_0_#6366f1]';
  return 'shadow-[inset_0_-2px_0_0_#6366f1]';
}
</script>

<template>
  <div>
    <div
      v-for="node in nodes"
      :key="node.id"
      class="group select-none"
    >
      <div
        :data-node-id="node.id"
        class="flex items-center gap-1 rounded-md px-1.5 py-[5px] cursor-pointer text-sm transition-colors"
        :class="[
          selectedId === node.id ? 'bg-indigo-100 text-indigo-800 font-medium' : 'hover:bg-slate-100',
          hintClass(node),
        ]"
        :style="{ paddingLeft: `${(depth ?? 0) * 14 + 6}px` }"
        :title="node.url ? t('folderTree.dblclickOpen') : ''"
        :data-ab-node="node.id"
        :data-ab-type="node.url ? 'bookmark' : 'folder'"
        :data-ab-root="isRootLevel() ? '1' : null"
        @click="onRowClick(node)"
        @dblclick="node.url && emit('openBookmark', node, $event)"
        @auxclick.middle="node.url && emit('openBookmark', node, $event)"
        @mousedown="beginRowDrag(node, $event, isRootLevel())"
        @dragstart.prevent
        @contextmenu.prevent.stop="emit('contextMenu', { node, x: $event.clientX, y: $event.clientY })"
      >
        <button
          v-if="!node.url && node.children.length"
          class="w-4 h-4 shrink-0 grid place-items-center text-slate-400 text-[10px] hover:text-slate-700"
          @click.stop="emit('toggle', node)"
        >
          {{ expanded.has(node.id) ? '▼' : '▶' }}
        </button>
        <span v-else class="w-4 shrink-0"></span>
        <FaviconImg
          v-if="node.url"
          :url="node.url"
          class="w-4 h-4 shrink-0 rounded-sm"
          loading="lazy"
        />
        <span v-else class="shrink-0">📁</span>
        <span class="truncate flex-1" :title="node.title">{{ node.title }}</span>
        <span
          v-if="!node.url"
          class="shrink-0 text-[10px] text-slate-400 tabular-nums group-hover:hidden"
        >
          {{ countBookmarks(node) || '' }}
        </span>
        <span v-if="!node.url" class="shrink-0 hidden group-hover:flex gap-0.5">
          <button
            class="w-5 h-5 grid place-items-center rounded text-slate-400 hover:bg-white hover:text-indigo-600"
            :title="t('common.newSubfolder')"
            @click.stop="emit('createIn', node)"
          >
            ＋
          </button>
          <button
            class="w-5 h-5 grid place-items-center rounded text-slate-400 hover:bg-white hover:text-indigo-600"
            :title="t('common.rename')"
            @click.stop="emit('rename', node)"
          >
            ✎
          </button>
          <button
            class="w-5 h-5 grid place-items-center rounded text-slate-400 hover:bg-white hover:text-red-500"
            :title="t('common.delete')"
            @click.stop="emit('remove', node)"
          >
            🗑
          </button>
        </span>
      </div>
      <FolderTree
        v-if="!node.url && expanded.has(node.id)"
        :nodes="node.children"
        :selected-id="selectedId"
        :expanded="expanded"
        :depth="(depth ?? 0) + 1"
        @select="emit('select', $event)"
        @open-bookmark="(node, e) => emit('openBookmark', node, e)"
        @context-menu="emit('contextMenu', $event)"
        @toggle="emit('toggle', $event)"
        @create-in="emit('createIn', $event)"
        @rename="emit('rename', $event)"
        @remove="emit('remove', $event)"
      />
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'FolderTree' };
</script>
