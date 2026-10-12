<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../shared/messages';
import type { MetaBrief, SearchResultItem, TreeNodeDto } from '../../shared/types';
import { findNode, flattenBookmarks } from '../../core/organize/scan';
import { resolveDropTarget, setNodeDropHandler, type TreeDropEvent } from '../../shared/dnd';
import FolderTree from './components/FolderTree.vue';
import BookmarkList from './components/BookmarkList.vue';
import OrganizePanel from './components/OrganizePanel.vue';
import MetaEditDialog from '../../components/MetaEditDialog.vue';
import AgentChat from './components/AgentChat.vue';
import SettingsContent from '../../components/SettingsContent.vue';
import { faviconUrl, formatTime } from '../../shared/ui';

const tree = ref<TreeNodeDto[]>([]);
const treeAside = ref<HTMLElement | null>(null);

/** 把树滚动到指定节点（保持可视位置，用于移动后定位） */
async function scrollToTreeNode(id: string) {
  await nextTick();
  document.querySelector(`[data-node-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}
const metaById = ref<Record<string, MetaBrief>>({});
const selectedId = ref('');
const expanded = ref(new Set<string>());
const loading = ref(true);
const errorMsg = ref('');

const searchQuery = ref('');
const searchResults = ref<SearchResultItem[] | null>(null);
const searching = ref(false);

const showOrganize = ref(false);
/** 树单击书签 / 右键编辑 → 元数据编辑弹窗 */
const metaEditNode = ref<TreeNodeDto | null>(null);
const metaEditMeta = computed(() =>
  metaEditNode.value ? (metaById.value[metaEditNode.value.id] ?? null) : null,
);
/** 显示当前加载的扩展版本，用于确认刷新是否生效 */
const extVersion = browser.runtime.getManifest().version;
/** 页面级视图：书签浏览 / 设置 / AI 助手 */
const view = ref<'bookmarks' | 'settings' | 'agent'>('bookmarks');
const busyIds = ref(new Set<string>());
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const selectedNode = computed(() => findNode(tree.value, selectedId.value));

const unenhancedIds = computed(() => {
  const ids: string[] = [];
  const walk = (nodes: TreeNodeDto[]): void => {
    for (const node of nodes) {
      if (node.url) {
        if (!metaById.value[node.id]) ids.push(node.id);
      } else {
        walk(node.children);
      }
    }
  };
  walk(tree.value);
  return ids;
});

async function refreshTree(keepSelection = true) {
  const { tree: t, metaById: m } = await sendMessage('getBookmarksTree');
  tree.value = t;
  metaById.value = m;
  if (!keepSelection || !findNode(t, selectedId.value)) {
    selectedId.value = t[0]?.id ?? '';
  }
  // 默认展开前两级
  if (!expanded.value.size) {
    for (const root of t) expanded.value.add(root.id);
  }
}

function expandTo(nodeId: string) {
  // 沿父链展开
  const path: string[] = [];
  const walk = (nodes: TreeNodeDto[], parents: string[]): boolean => {
    for (const node of nodes) {
      if (node.id === nodeId) {
        path.push(...parents);
        return true;
      }
      if (!node.url && walk(node.children, [...parents, node.id])) return true;
    }
    return false;
  };
  walk(tree.value, []);
  const next = new Set(expanded.value);
  for (const id of path) next.add(id);
  expanded.value = next;
}

function selectFolder(node: TreeNodeDto) {
  searchQuery.value = '';
  searchResults.value = null;
  // 树里单击书签 = 打开编辑界面（双击才是新标签页打开）
  if (node.url) {
    metaEditNode.value = node;
    return;
  }
  selectedId.value = node.id;
  if (!node.url) {
    // 点击文件夹行 = 选中 + 切换展开/收起（与箭头行为一致）
    const next = new Set(expanded.value);
    if (next.has(node.id)) next.delete(node.id);
    else next.add(node.id);
    expanded.value = next;
  }
}

function toggleFolder(node: TreeNodeDto) {
  const next = new Set(expanded.value);
  if (next.has(node.id)) next.delete(node.id);
  else next.add(node.id);
  expanded.value = next;
}

async function createIn(parent: TreeNodeDto) {
  const title = prompt('新建文件夹名称');
  if (!title?.trim()) return;
  await sendMessage('createFolder', { parentId: parent.id, title: title.trim() });
  const next = new Set(expanded.value);
  next.add(parent.id);
  expanded.value = next;
  await refreshTree();
}

async function rename(node: TreeNodeDto) {
  const title = prompt('重命名', node.title);
  if (!title?.trim() || title === node.title) return;
  await sendMessage('renameNode', { id: node.id, title: title.trim() });
  await refreshTree();
}

async function remove(node: TreeNodeDto) {
  const msg = node.url
    ? `删除书签「${node.title}」？`
    : `删除文件夹「${node.title}」及其全部内容？`;
  if (!confirm(msg)) return;
  await sendMessage('removeNode', node.id);
  await refreshTree();
}

/** 树行拖放落点：同级重排 / 跨文件夹插入 / 移入文件夹（拖源可为树行或右侧列表卡片） */
async function onTreeDrop({ targetId, zone, draggedId }: TreeDropEvent) {
  const target = findNode(tree.value, targetId);
  if (!target) return;
  const res = resolveDropTarget(tree.value, draggedId, target, zone);
  if (!res.ok) {
    if (res.reason === 'invalid') alert('不能移动到该位置（自身、子文件夹或系统根文件夹）');
    return;
  }
  const ok = await sendMessage('moveNode', { id: draggedId, newParentId: res.parentId, index: res.index });
  if (!ok) {
    alert('移动失败（可能是系统文件夹或非法目标）');
    return;
  }
  if (zone === 'into') expandTo(target.id);
  await refreshTree();
}

setNodeDropHandler((e) => void onTreeDrop(e));

function onSearchInput() {
  clearTimeout(searchTimer);
  const q = searchQuery.value.trim();
  if (!q) {
    searchResults.value = null;
    return;
  }
  searchTimer = setTimeout(async () => {
    searching.value = true;
    try {
      searchResults.value = await sendMessage('searchBookmarks', q);
    } finally {
      searching.value = false;
    }
  }, 250);
}

function locate(item: SearchResultItem) {
  searchQuery.value = '';
  searchResults.value = null;
  selectedId.value = item.bookmarkId; // 列表按 selectedId 的父文件夹显示
  const parent = findParent(tree.value, item.bookmarkId);
  if (parent) {
    expandTo(parent.id);
    selectedId.value = parent.id;
  }
}

function findParent(nodes: TreeNodeDto[], childId: string): TreeNodeDto | null {
  for (const node of nodes) {
    if (node.children.some((c) => c.id === childId)) return node;
    if (!node.url) {
      const hit = findParent(node.children, childId);
      if (hit) return hit;
    }
  }
  return null;
}

async function openUrl(url: string) {
  await browser.tabs.create({ url });
}

// ---- 树右键菜单 ----
const ctxMenu = ref<{ node: TreeNodeDto; x: number; y: number } | null>(null);

function openCtxMenu(payload: { node: TreeNodeDto; x: number; y: number }) {
  // 防止菜单超出视口
  const x = Math.min(payload.x, window.innerWidth - 180);
  const y = Math.min(payload.y, window.innerHeight - 160);
  ctxMenu.value = { node: payload.node, x, y };
}

// ---- 右键新建书签（落点=该文件夹）----
const createBookmarkState = ref<{ node: TreeNodeDto; title: string; url: string } | null>(null);
const createBookmarkError = ref('');

function nodeFolderPath(node: TreeNodeDto): string {
  const walk = (nodes: TreeNodeDto[], parents: string[]): string | null => {
    for (const n of nodes) {
      const path = [...parents, n.title].join('/');
      if (n.id === node.id) return path;
      if (!n.url) {
        const hit = walk(n.children, [...parents, n.title]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(tree.value, []) ?? '其他书签';
}

function openCreateBookmark(node: TreeNodeDto) {
  ctxMenu.value = null;
  createBookmarkError.value = '';
  createBookmarkState.value = { node, title: '', url: '' };
}

async function confirmCreateBookmark() {
  const form = createBookmarkState.value;
  const title = form?.title.trim();
  const url = form?.url.trim();
  if (!form || !title) {
    createBookmarkError.value = '标题不能为空';
    return;
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    createBookmarkError.value = '链接必须以 http:// 或 https:// 开头';
    return;
  }
  try {
    await sendMessage('savePlainBookmark', { url, title, folderPath: nodeFolderPath(form.node) });
    createBookmarkState.value = null;
    await refreshTree();
  } catch (e) {
    createBookmarkError.value = (e as Error).message;
  }
}

async function menuAction(act: 'open' | 'edit' | 'createIn' | 'delete' | 'enhance' | 'reclassify') {
  const node = ctxMenu.value?.node;
  ctxMenu.value = null;
  if (!node) return;
  if (act === 'open') await openUrl(node.url ?? '');
  else if (act === 'edit') {
    if (node.url) metaEditNode.value = node;
    else await rename(node);
  } else if (act === 'createIn') await createIn(node);
  else if (act === 'delete') await remove(node);
  else if (act === 'enhance') await ctxEnhance(node);
  else if (act === 'reclassify') await ctxReclassify(node);
}

// ---- 右键 AI 操作（书签=单条；文件夹=整棵子树，走后台任务并打开整理中心看进度）----
async function ctxEnhance(node: TreeNodeDto) {
  if (node.url) {
    await enhanceIds([node.id]);
    return;
  }
  const ids = flattenBookmarks([node], []).map((b) => b.id);
  if (!ids.length) {
    alert('文件夹里没有可增强的书签');
    return;
  }
  try {
    await sendMessage('startJob', { kind: 'enhance', params: { ids, fetchContent: false } });
    showOrganize.value = true;
  } catch (e) {
    alert((e as Error).message);
  }
}

// ---- AI 分类进行中状态（持续到任务结束）+ 轻提示 ----
const classifying = ref<{ title: string } | null>(null);
const toast = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 2200);
}

async function ctxReclassify(node: TreeNodeDto) {
  if (node.url) {
    // 提示条从点击一直显示到分类完成（含移动与刷新）
    classifying.value = { title: node.title };
    try {
      const r = await sendMessage('reclassifyBookmark', node.id);
      if (!r.ok) {
        showToast(r.reason === 'no-candidates' ? '没有可用的目标目录' : 'AI 未能确定目标目录');
        return;
      }
      await refreshTree();
      showToast(`已移动到「${r.folder}」`);
    } catch (e) {
      showToast(`分类失败：${(e as Error).message}`);
      return;
    } finally {
      classifying.value = null;
    }
    return;
  }
  // 根分区（书签栏/其他书签）沿用原有 scope；普通文件夹以子树为输入
  const isRootIdx = tree.value.findIndex((r) => r.id === node.id);
  const params: Record<string, unknown> = isRootIdx >= 0
    ? { scope: isRootIdx === 0 ? 'toolbar' : 'other', maxCategories: 12 }
    : { scope: 'folder', folderId: node.id, maxCategories: 12 };
  try {
    await sendMessage('startJob', { kind: 'classify', params });
    showOrganize.value = true;
  } catch (e) {
    alert((e as Error).message);
  }
}

async function enhanceIds(ids: string[]) {
  for (const id of ids) {
    busyIds.value = new Set(busyIds.value).add(id);
  }
  try {
    for (const id of ids) {
      try {
        await sendMessage('enhanceExisting', id);
      } catch (e) {
        errorMsg.value = (e as Error).message;
        break;
      }
    }
    await refreshTree();
  } finally {
    const next = new Set(busyIds.value);
    for (const id of ids) next.delete(id);
    busyIds.value = next;
  }
}

// 书签库在其他界面（popup 收藏/删除等）发生变化时自动刷新树
let libRefreshTimer: ReturnType<typeof setTimeout> | undefined;
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.libraryVersion) return;
  clearTimeout(libRefreshTimer);
  libRefreshTimer = setTimeout(() => void refreshTree(), 300);
});

onMounted(async () => {
  try {
    await refreshTree(false);
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
  // 支持 manager.html?panel=settings 直接进入设置视图（popup 等入口导航用）
  if (new URLSearchParams(location.search).get('panel') === 'settings') {
    view.value = 'settings';
  }
});
</script>

<template>
  <div class="h-screen flex flex-col bg-slate-50 text-slate-800">
    <!-- 顶栏 -->
    <header class="flex items-center gap-2.5 px-4 py-2.5 bg-white border-b border-slate-200">
      <div class="w-6 h-6 rounded-md bg-indigo-600 text-white grid place-items-center text-xs font-bold">A</div>
      <span class="font-semibold text-sm">AutoBookmark 书签管理</span>
      <span
        class="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-400 font-mono"
        :title="`扩展版本（当前加载：${extVersion}）`"
      >
        v{{ extVersion }}
      </span>

      <!-- 视图切换 -->
      <nav class="flex gap-1 p-1 rounded-xl bg-slate-100 ml-2">
        <button
          class="px-3.5 py-1 rounded-lg text-xs transition-colors"
          :class="view === 'bookmarks' ? 'bg-white shadow-sm font-medium text-indigo-700' : 'text-slate-500 hover:text-slate-700'"
          @click="view = 'bookmarks'"
        >
          🔖 书签
        </button>
        <button
          class="px-3.5 py-1 rounded-lg text-xs transition-colors"
          :class="view === 'settings' ? 'bg-white shadow-sm font-medium text-indigo-700' : 'text-slate-500 hover:text-slate-700'"
          @click="view = 'settings'"
        >
          ⚙ 设置
        </button>
        <button
          class="px-3.5 py-1 rounded-lg text-xs transition-colors"
          :class="view === 'agent' ? 'bg-white shadow-sm font-medium text-indigo-700' : 'text-slate-500 hover:text-slate-700'"
          @click="view = 'agent'"
        >
          🤖 助手
        </button>
      </nav>

      <template v-if="view === 'bookmarks'">
        <span class="flex-1"></span>
        <div class="relative w-full max-w-md">
          <input
            v-model="searchQuery"
            @input="onSearchInput"
            placeholder="搜索全部书签（标题 / 摘要 / 标签）…"
            class="w-full px-3.5 py-1.5 rounded-lg bg-slate-100 text-sm focus:outline-none focus:bg-white focus:ring-2 focus:ring-indigo-200"
          />
          <span v-if="searching" class="absolute right-3 top-2 text-xs text-slate-400 animate-pulse">…</span>
        </div>
        <button
          class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700"
          @click="showOrganize = true"
        >
          ✨ 整理
        </button>
        <button
          class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
          @click="refreshTree()"
        >
          刷新
        </button>
      </template>
      <span v-else class="flex-1"></span>
    </header>

    <p v-if="errorMsg" class="px-4 py-2 bg-red-50 text-red-700 text-xs">{{ errorMsg }}</p>

    <!-- 书签浏览视图 -->
    <div v-if="view === 'bookmarks'" class="flex-1 flex min-h-0">
      <!-- 左：文件夹树 -->
      <aside ref="treeAside" class="w-64 shrink-0 overflow-y-auto bg-white border-r border-slate-200 p-2" data-drop-root>
        <div v-if="loading" class="space-y-2 p-2">
          <div class="h-5 rounded bg-slate-100 animate-pulse w-3/4"></div>
          <div class="h-5 rounded bg-slate-100 animate-pulse w-1/2"></div>
          <div class="h-5 rounded bg-slate-100 animate-pulse w-2/3"></div>
        </div>
        <FolderTree
          v-else
          :nodes="tree"
          :selected-id="selectedId"
          :expanded="expanded"
          @select="selectFolder"
          @open-bookmark="openUrl($event.url ?? '')"
          @context-menu="openCtxMenu"
          @toggle="toggleFolder"
          @create-in="createIn"
          @rename="rename"
          @remove="remove"
        />
      </aside>

      <!-- 右：内容区 -->
      <main class="flex-1 overflow-y-auto p-4">
        <!-- 搜索结果 -->
        <template v-if="searchResults">
          <h2 class="text-xs font-semibold text-slate-500 mb-3">
            搜索「{{ searchQuery }}」 · {{ searchResults.length }} 条结果
          </h2>
          <div class="max-w-3xl space-y-2">
            <div
              v-for="item in searchResults"
              :key="item.bookmarkId"
              class="group flex items-start gap-2.5 rounded-xl bg-white border border-slate-200 p-3 hover:border-indigo-200"
            >
              <img :src="faviconUrl(item.url)" class="w-4 h-4 mt-1 rounded" alt="" loading="lazy" />
              <div class="min-w-0 flex-1 cursor-pointer" @click="openUrl(item.url)">
                <h3 class="text-sm font-medium leading-snug break-words group-hover:text-indigo-700">{{ item.title }}</h3>
                <p class="mt-1 text-xs text-slate-600 leading-relaxed line-clamp-2">{{ item.summary }}</p>
                <p class="mt-1.5 text-[11px] text-slate-400">
                  {{ item.folderPath || '·' }} · {{ formatTime(item.createdAt) }}
                  <span v-if="item.matchedBy === 'semantic'" class="ml-1 text-emerald-500">语义</span>
                </p>
                <div v-if="item.tags.length" class="mt-1.5 flex flex-wrap gap-1">
                  <span v-for="tag in item.tags" :key="tag" class="px-1.5 py-0.5 rounded text-[10px] bg-indigo-50 text-indigo-600">
                    {{ tag }}
                  </span>
                </div>
              </div>
              <button
                class="shrink-0 px-2 py-1 rounded text-[11px] text-indigo-500 hover:bg-indigo-50 opacity-0 group-hover:opacity-100"
                @click="locate(item)"
              >
                定位 ↗
              </button>
            </div>
            <div v-if="!searchResults.length" class="py-16 text-center text-sm text-slate-400">没有匹配的书签</div>
          </div>
        </template>

        <!-- 文件夹内容 -->
        <template v-else>
          <div class="max-w-3xl">
            <div class="flex items-center gap-2 mb-3">
              <h2 class="text-sm font-semibold">{{ selectedNode?.title ?? '…' }}</h2>
              <span class="text-[11px] text-slate-400">
                {{ selectedNode?.children.filter((c) => c.url).length ?? 0 }} 条书签 ·
                {{ unenhancedIds.length }} 条待增强
              </span>
            </div>
            <BookmarkList
              :folder="selectedNode"
              :meta-by-id="metaById"
              :busy-ids="busyIds"
              @open="openUrl"
              @open-folder="selectFolder"
              @enhance="enhanceIds"
              @meta-changed="refreshTree()"
              @node-changed="refreshTree()"
            />
          </div>
        </template>
      </main>
    </div>

    <!-- 助手视图 -->
    <AgentChat v-else-if="view === 'agent'" />

    <!-- 设置视图（内嵌页面） -->
    <div v-else class="flex-1 overflow-y-auto">
      <div class="max-w-3xl mx-auto p-6">
        <SettingsContent />
      </div>
    </div>

    <!-- 树右键菜单 -->
    <div
      v-if="ctxMenu"
      class="fixed inset-0 z-40"
      @click="ctxMenu = null"
      @contextmenu.prevent="ctxMenu = null"
    >
      <div
        class="absolute z-50 min-w-[150px] rounded-lg bg-white border border-slate-200 shadow-lg py-1 text-sm"
        :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }"
      >
        <button
          class="w-full text-left px-3 py-1.5 text-indigo-600 hover:bg-indigo-50 font-medium"
          @click="menuAction('enhance')"
        >
          ✨ AI 增强
        </button>
        <button
          class="w-full text-left px-3 py-1.5 text-indigo-600 hover:bg-indigo-50 font-medium"
          @click="menuAction('reclassify')"
        >
          🗂 智能重新分类
        </button>
        <button
          v-if="ctxMenu.node.url"
          class="w-full text-left px-3 py-1.5 hover:bg-indigo-50 hover:text-indigo-700"
          @click="menuAction('open')"
        >
          🔗 打开
        </button>
        <button
          class="w-full text-left px-3 py-1.5 hover:bg-indigo-50 hover:text-indigo-700"
          @click="menuAction('edit')"
        >
          ✎ {{ ctxMenu.node.url ? '编辑' : '重命名' }}
        </button>
        <button
          v-if="!ctxMenu.node.url"
          class="w-full text-left px-3 py-1.5 hover:bg-indigo-50 hover:text-indigo-700"
          @click="menuAction('createIn')"
        >
          ＋ 新建子文件夹
        </button>
        <button
          v-if="!ctxMenu.node.url"
          class="w-full text-left px-3 py-1.5 hover:bg-indigo-50 hover:text-indigo-700"
          @click="openCreateBookmark(ctxMenu.node)"
        >
          🔖 新建书签
        </button>
        <button
          class="w-full text-left px-3 py-1.5 text-red-500 hover:bg-red-50"
          @click="menuAction('delete')"
        >
          🗑 删除
        </button>
      </div>
    </div>

    <MetaEditDialog
      :node="metaEditNode"
      :meta="metaEditMeta"
      @close="metaEditNode = null"
      @saved="refreshTree()"
    />

    <!-- AI 分类进行中状态条 -->
    <div
      v-if="classifying"
      class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-indigo-600 text-white text-xs shadow-lg"
    >
      <span class="typing-dots"><span>●</span><span>●</span><span>●</span></span>
      AI 正在分类「{{ classifying.title }}」…
    </div>

    <!-- 轻提示 -->
    <div
      v-if="toast"
      class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 rounded-full bg-slate-800 text-white text-xs shadow-lg"
    >
      {{ toast }}
    </div>

    <!-- 新建书签弹层 -->
    <div
      v-if="createBookmarkState"
      class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6"
      @click.self="createBookmarkState = null"
    >
      <div class="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl space-y-3">
        <p class="text-sm font-medium">新建书签</p>
        <p class="text-[11px] text-slate-400">位置：{{ nodeFolderPath(createBookmarkState.node) }}</p>
        <p v-if="createBookmarkError" class="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs">{{ createBookmarkError }}</p>
        <input
          v-model="createBookmarkState.title"
          autofocus
          placeholder="标题"
          class="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-indigo-400"
        />
        <input
          v-model="createBookmarkState.url"
          placeholder="https://…"
          class="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm font-mono focus:outline-none focus:border-indigo-400"
          @keydown.enter="confirmCreateBookmark"
        />
        <div class="flex justify-end gap-2">
          <button class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50" @click="createBookmarkState = null">取消</button>
          <button class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700" @click="confirmCreateBookmark">创建</button>
        </div>
      </div>
    </div>

    <OrganizePanel
      v-if="showOrganize"
      :unenhanced-ids="unenhancedIds"
      @close="showOrganize = false"
      @changed="refreshTree()"
    />

  </div>
</template>
