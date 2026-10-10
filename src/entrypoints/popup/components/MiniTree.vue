<script setup lang="ts">
import type { MetaBrief, TreeNodeDto } from '../../../shared/types';
import { faviconUrl, tooltipIfTruncated } from '../../../shared/ui';

defineProps<{
  nodes: TreeNodeDto[];
  expanded: Set<string>;
  metaById: Record<string, MetaBrief>;
  depth?: number;
}>();

const emit = defineEmits<{
  toggle: [node: TreeNodeDto];
  open: [node: TreeNodeDto];
  contextMenu: [payload: { node: TreeNodeDto; x: number; y: number }];
}>();
</script>

<template>
  <div>
    <div v-for="node in nodes" :key="node.id">
      <!-- 文件夹行 -->
      <button
        v-if="!node.url"
        class="w-full flex items-center gap-1 rounded-md px-1.5 py-[5px] text-left text-[13px] hover:bg-slate-100 transition-colors"
        :style="{ paddingLeft: `${(depth ?? 0) * 12 + 4}px` }"
        @click="emit('toggle', node)"
        @contextmenu.prevent.stop="emit('contextMenu', { node, x: $event.clientX, y: $event.clientY })"
      >
        <span class="w-3.5 shrink-0 grid place-items-center text-[9px] text-slate-400">
          {{ node.children.length ? (expanded.has(node.id) ? '▼' : '▶') : '' }}
        </span>
        <span class="shrink-0 text-[12px]">📁</span>
        <span class="truncate flex-1 font-medium text-slate-700" @mouseenter="tooltipIfTruncated">{{ node.title }}</span>
        <span class="shrink-0 text-[10px] text-slate-400 tabular-nums">{{ node.children.length || '' }}</span>
      </button>

      <!-- 书签行 -->
      <button
        v-else
        class="w-full flex items-center gap-1.5 rounded-md px-1.5 py-[5px] text-left text-[13px] hover:bg-indigo-50 hover:text-indigo-700 transition-colors group"
        :style="{ paddingLeft: `${(depth ?? 0) * 12 + 4}px` }"
        @click="emit('open', node)"
        @contextmenu.prevent.stop="emit('contextMenu', { node, x: $event.clientX, y: $event.clientY })"
      >
        <span class="w-3.5 shrink-0"></span>
        <img :src="faviconUrl(node.url)" class="w-3.5 h-3.5 shrink-0 rounded-sm" alt="" loading="lazy" />
        <span class="truncate flex-1" @mouseenter="tooltipIfTruncated">{{ node.title || node.url }}</span>
        <span
          v-if="metaById[node.id]?.summary"
          class="shrink-0 hidden group-hover:block text-[9px] px-1 rounded bg-indigo-100 text-indigo-500"
          title="已 AI 增强"
        >AI</span>
      </button>

      <!-- 子树 -->
      <MiniTree
        v-if="!node.url && expanded.has(node.id)"
        :nodes="node.children"
        :expanded="expanded"
        :meta-by-id="metaById"
        :depth="(depth ?? 0) + 1"
        @toggle="emit('toggle', $event)"
        @open="emit('open', $event)"
        @context-menu="emit('contextMenu', $event)"
      />
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'MiniTree' };
</script>
