<script setup lang="ts">
import type { TreeNodeDto } from '../../../shared/types';
import { countBookmarks } from '../../../core/organize/scan';
import { faviconUrl } from '../../../shared/ui';

const props = defineProps<{
  nodes: TreeNodeDto[];
  selectedId: string;
  expanded: Set<string>;
  depth?: number;
}>();

const emit = defineEmits<{
  select: [node: TreeNodeDto];
  /** 书签叶节点双击：新标签页打开 */
  openBookmark: [node: TreeNodeDto];
  /** 右键菜单：节点 + 鼠标位置 */
  contextMenu: [payload: { node: TreeNodeDto; x: number; y: number }];
  toggle: [node: TreeNodeDto];
  createIn: [node: TreeNodeDto];
  rename: [node: TreeNodeDto];
  remove: [node: TreeNodeDto];
  dropOn: [payload: [TreeNodeDto, string]];
}>();

function onDrop(node: TreeNodeDto, event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  const payload = event.dataTransfer?.getData('application/x-ab-node');
  if (payload) emit('dropOn', [node, payload]);
}

function onDragOver(event: DragEvent) {
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'move';
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
        class="flex items-center gap-1 rounded-md px-1.5 py-[5px] cursor-pointer text-sm transition-colors"
        :class="[
          selectedId === node.id ? 'bg-indigo-100 text-indigo-800 font-medium' : 'hover:bg-slate-100',
        ]"
        :style="{ paddingLeft: `${(depth ?? 0) * 14 + 6}px` }"
        :title="node.url ? '双击在新标签页打开' : ''"
        @click="emit('select', node)"
        @dblclick="node.url && emit('openBookmark', node)"
        @contextmenu.prevent.stop="emit('contextMenu', { node, x: $event.clientX, y: $event.clientY })"
        @dragover="onDragOver"
        @drop="onDrop(node, $event)"
      >
        <button
          v-if="!node.url && node.children.length"
          class="w-4 h-4 shrink-0 grid place-items-center text-slate-400 text-[10px] hover:text-slate-700"
          @click.stop="emit('toggle', node)"
        >
          {{ expanded.has(node.id) ? '▼' : '▶' }}
        </button>
        <span v-else class="w-4 shrink-0"></span>
        <img
          v-if="node.url"
          :src="faviconUrl(node.url)"
          class="w-4 h-4 shrink-0 rounded-sm"
          alt=""
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
            title="新建子文件夹"
            @click.stop="emit('createIn', node)"
          >
            ＋
          </button>
          <button
            class="w-5 h-5 grid place-items-center rounded text-slate-400 hover:bg-white hover:text-indigo-600"
            title="重命名"
            @click.stop="emit('rename', node)"
          >
            ✎
          </button>
          <button
            class="w-5 h-5 grid place-items-center rounded text-slate-400 hover:bg-white hover:text-red-500"
            title="删除"
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
        @open-bookmark="emit('openBookmark', $event)"
        @context-menu="emit('contextMenu', $event)"
        @toggle="emit('toggle', $event)"
        @create-in="emit('createIn', $event)"
        @rename="emit('rename', $event)"
        @remove="emit('remove', $event)"
        @drop-on="emit('dropOn', $event)"
      />
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'FolderTree' };
</script>
