<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../shared/messages';
import { startStream } from '../../shared/stream';
import type { BookmarkDraft, BookmarkMeta, PageContent } from '../../shared/types';
import type { Settings } from '../../core/storage/settings';
import { faviconUrl, formatTime, hostOf, tooltipIfTruncated } from '../../shared/ui';
import { resolveDropTarget, setNodeDropHandler, type TreeDropEvent } from '../../shared/dnd';
import { findNode, flattenBookmarks } from '../../core/organize/scan';
import type { MetaBrief, SearchResultItem, TreeNodeDto } from '../../shared/types';
import MiniTree from './components/MiniTree.vue';
import MetaEditDialog from '../../components/MetaEditDialog.vue';

type Phase =
  | 'loading'
  | 'needsSetup'
  | 'unsupported'
  | 'bookmarked'
  | 'idle'
  | 'enhancing'
  | 'draft'
  | 'saving'
  | 'saved';

const phase = ref<Phase>('loading');
const errorMsg = ref('');
const settings = ref<Settings | null>(null);
const existingMeta = ref<BookmarkMeta | null>(null);
const savedMeta = ref<BookmarkMeta | null>(null);
const page = ref<PageContent | null>(null);
const tabId = ref<number | null>(null);

const draft = reactive<BookmarkDraft>({ title: '', summary: '', tags: [], folder: '' });
const newTag = ref('');

const tldrState = ref<'hidden' | 'loading' | 'streaming' | 'done' | 'error'>('hidden');
const tldrText = ref('');
const tldrError = ref('');
/** 结果按 URL 存入 storage.session，popup 关闭后再打开不丢 */
const tldrStorageKey = computed(() => `tldr:${currentUrl.value}`);
let lastTldrSave = 0;

async function persistTldr(force = false) {
  if (!currentUrl.value) return;
  const now = Date.now();
  if (!force && now - lastTldrSave < 400) return; // 流式期间节流
  lastTldrSave = now;
  await browser.storage.session.set({ [tldrStorageKey.value]: tldrText.value });
}

const currentUrl = ref('');
const currentTitle = ref('');
const configured = computed(() => !!settings.value?.bindings.enhance);

async function loadPageContent(): Promise<PageContent> {
  if (page.value) return page.value;
  if (tabId.value == null) throw new Error('未找到当前标签页');
  const p = await sendMessage('extractPage', tabId.value);
  page.value = p;
  return p;
}

async function startEnhance() {
  errorMsg.value = '';
  phase.value = 'enhancing';
  try {
    const p = await loadPageContent();
    const d = await sendMessage('enhanceBookmark', p);
    Object.assign(draft, d);
    // AI 建议的目标目录（用户仍可通过下拉手动改）
    const settings = await sendMessage('getSettings');
    savePath.value =
      settings.preferences.saveStrategy === 'existing'
        ? d.folder
        : `其他书签/${settings.preferences.rootFolder}/${d.folder}`;
    phase.value = 'draft';
  } catch (e) {
    errorMsg.value = (e as Error).message;
    phase.value = 'idle';
  }
}

function addTag() {
  const t = newTag.value.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
  if (t && !draft.tags.includes(t)) draft.tags.push(t);
  newTag.value = '';
}

function removeTag(tag: string) {
  draft.tags = draft.tags.filter((t) => t !== tag);
}

async function save() {
  if (!draft.title.trim()) {
    errorMsg.value = '标题不能为空';
    return;
  }
  errorMsg.value = '';
  phase.value = 'saving';
  try {
    const p = await loadPageContent();
    const meta = await sendMessage('saveBookmark', {
      page: p,
      draft: {
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        tags: [...draft.tags],
        folder: draft.folder.trim() || '未分类',
      },
      manualPath: savePath.value || undefined,
    });
    savedMeta.value = meta;
    phase.value = 'saved';
    await reloadTree(); // 收藏完成后刷新树，立即可见
  } catch (e) {
    errorMsg.value = (e as Error).message;
    phase.value = 'draft';
  }
}

async function savePlain() {
  errorMsg.value = '';
  phase.value = 'saving';
  try {
    const meta = await sendMessage('savePlainBookmark', {
      url: currentUrl.value,
      title: currentTitle.value || hostOf(currentUrl.value),
      folderPath: savePath.value || undefined,
    });
    savedMeta.value = meta;
    phase.value = 'saved';
    await reloadTree();
  } catch (e) {
    errorMsg.value = (e as Error).message;
    phase.value = 'idle';
  }
}

async function runTldr() {
  tldrState.value = 'loading';
  tldrText.value = '';
  tldrError.value = '';
  try {
    const p = await loadPageContent();
    startStream('tldr', p, {
      onStart: () => {
        tldrState.value = 'streaming';
      },
      onDelta: (text) => {
        tldrText.value += text;
        void persistTldr();
      },
      onDone: () => {
        tldrState.value = 'done';
        void persistTldr(true);
      },
      onError: (message) => {
        tldrError.value = message;
        tldrState.value = 'error';
      },
    });
  } catch (e) {
    tldrError.value = (e as Error).message;
    tldrState.value = 'error';
  }
}

async function restoreTldr() {
  try {
    const saved = (await browser.storage.session.get(tldrStorageKey.value))[tldrStorageKey.value];
    if (typeof saved === 'string' && saved.trim()) {
      tldrText.value = saved;
      tldrState.value = 'done';
    }
  } catch {
    /* session 存储不可用时静默 */
  }
}

const tldrLines = computed(() =>
  tldrText.value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*•]\s*$/.test(l))
    .map((l) => l.replace(/^[-*•]\s*/, '')),
);

async function openManager() {
  await sendMessage('openManager', '');
  window.close();
}

// ---- 书签树（与收藏区同页展示）----
const treeNodes = ref<TreeNodeDto[]>([]);
const treeMeta = ref<Record<string, MetaBrief>>({});
const treeExpanded = ref(new Set<string>());
const treeLoading = ref(false);
const treeQuery = ref('');
const treeResults = ref<SearchResultItem[] | null>(null);
let treeQueryTimer: ReturnType<typeof setTimeout> | undefined;

// ---- 树展开状态持久化（storage.local，跨 popup 打关保留）----
const TREE_EXPANDED_KEY = 'popup:treeExpanded';
/** 恢复过持久化状态后，就不再套用「默认展开一级」 */
let expandedRestored = false;

async function restoreTreeExpanded() {
  try {
    const stored = (await browser.storage.local.get(TREE_EXPANDED_KEY))[TREE_EXPANDED_KEY];
    if (Array.isArray(stored)) {
      expandedRestored = true;
      treeExpanded.value = new Set(stored.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    /* storage 不可用时退化为会话内状态 */
  }
}

// ---- 树滚动位置持久化（同用 storage.local）----
const TREE_SCROLL_KEY = 'popup:treeScrollTop';
const treeScrollEl = ref<HTMLElement | null>(null);
let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;
let scrollRestored = false;

function onTreeScroll() {
  if (treeResults.value) return; // 搜索结果视图的滚动不算树的位置
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    const top = treeScrollEl.value?.scrollTop ?? 0;
    void browser.storage.local.set({ [TREE_SCROLL_KEY]: top }).catch(() => {});
  }, 200);
}

/** 在树数据 + 展开状态都已恢复、DOM 渲染完成后调用，否则会被未撑开的内容钳回 0 */
async function restoreTreeScroll() {
  if (scrollRestored) return;
  scrollRestored = true;
  try {
    const stored = (await browser.storage.local.get(TREE_SCROLL_KEY))[TREE_SCROLL_KEY];
    if (typeof stored === 'number' && treeScrollEl.value) treeScrollEl.value.scrollTop = stored;
  } catch {
    /* 静默 */
  }
}

async function loadTree(force = false) {
  if (!force && (treeNodes.value.length || treeLoading.value)) return;
  treeLoading.value = true;
  try {
    const { tree, metaById } = await sendMessage('getBookmarksTree');
    treeNodes.value = tree;
    treeMeta.value = metaById;
    // 默认展开一级；已恢复持久化的展开状态时以恢复的为准（显式存过空集 = 全部收起）
    if (!expandedRestored && !treeExpanded.value.size) {
      treeExpanded.value = new Set(tree.map((n) => n.id));
    }
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    treeLoading.value = false;
  }
}

function toggleTreeNode(node: TreeNodeDto) {
  const next = new Set(treeExpanded.value);
  if (next.has(node.id)) next.delete(node.id);
  else next.add(node.id);
  treeExpanded.value = next;
  void browser.storage.local.set({ [TREE_EXPANDED_KEY]: [...next] }).catch(() => {});
}

async function openBookmark(node: TreeNodeDto) {
  if (!node.url) return;
  await browser.tabs.create({ url: node.url });
  window.close();
}

/** 树行拖放落点：同级重排 / 跨文件夹插入 / 移入文件夹 */
async function onTreeDrop({ targetId, zone, draggedId }: TreeDropEvent) {
  const target = findNode(treeNodes.value, targetId);
  if (!target) return;
  const res = resolveDropTarget(treeNodes.value, draggedId, target, zone);
  if (!res.ok) {
    if (res.reason === 'invalid') showToast('不能移动到该位置');
    return;
  }
  const ok = await sendMessage('moveNode', { id: draggedId, newParentId: res.parentId, index: res.index });
  if (!ok) {
    showToast('移动失败（可能是系统文件夹或非法目标）');
    return;
  }
  await reloadTree();
}

setNodeDropHandler((e) => void onTreeDrop(e));

function onTreeQueryInput() {
  clearTimeout(treeQueryTimer);
  const q = treeQuery.value.trim();
  if (!q) {
    treeResults.value = null;
    return;
  }
  treeQueryTimer = setTimeout(async () => {
    treeResults.value = await sendMessage('searchBookmarks', q);
  }, 250);
}

function openResult(item: SearchResultItem) {
  void browser.tabs.create({ url: item.url });
  window.close();
}

// ---- 保存路径（普通/AI 收藏共用，手动可改）----
const folderPaths = ref<string[]>([]);
const savePath = ref('');

async function loadFolderPaths() {
  folderPaths.value = await sendMessage('listFolderPaths');
  // 默认落点：aiFolder 策略 → AI 收藏根；existing → 其他书签根
  const settings = await sendMessage('getSettings');
  savePath.value =
    settings.preferences.saveStrategy === 'existing'
      ? '其他书签'
      : `其他书签/${settings.preferences.rootFolder}`;
}

// ---- 树右键菜单 ----
const ctxMenu = ref<{ node: TreeNodeDto; x: number; y: number } | null>(null);
const toast = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 1400);
}

// ---- 右键删除（popup 内自定义二次确认，原生 confirm 会让 popup 失焦关闭）----
const confirmDelete = ref<{ node: TreeNodeDto } | null>(null);

function ctxDelete(node: TreeNodeDto) {
  ctxMenu.value = null;
  confirmDelete.value = { node };
}

function countDescendants(node: TreeNodeDto): number {
  return node.children.reduce((sum, c) => sum + 1 + (c.url ? 0 : countDescendants(c)), 0);
}

async function confirmDeleteAction() {
  const node = confirmDelete.value?.node;
  confirmDelete.value = null;
  if (!node) return;
  await sendMessage('removeNode', node.id);
  await reloadTree();
  showToast(node.url ? '书签已删除' : '文件夹已删除');
}

function openCtxMenu(payload: { node: TreeNodeDto; x: number; y: number }) {
  // 防止菜单溢出（菜单约 310px 高）
  ctxMenu.value = {
    node: payload.node,
    x: Math.min(payload.x, 660 - 224),
    y: Math.min(payload.y, window.innerHeight - 320),
  };
}

function ctxOpen(node: TreeNodeDto) {
  ctxMenu.value = null;
  void browser.tabs.create({ url: node.url ?? '' });
  window.close();
}

async function ctxCopyLink(node: TreeNodeDto) {
  ctxMenu.value = null;
  try {
    await navigator.clipboard.writeText(node.url ?? '');
    showToast('链接已复制');
  } catch {
    /* 剪贴板不可用时静默 */
  }
}

function ctxToggle(node: TreeNodeDto) {
  ctxMenu.value = null;
  toggleTreeNode(node);
}

function ctxOpenManager() {
  ctxMenu.value = null;
  void openManager();
}

// ---- 右键 AI 操作（书签=单条；文件夹=整棵子树，走后台任务）----
async function ctxEnhance(node: TreeNodeDto) {
  ctxMenu.value = null;
  if (node.url) {
    showToast('AI 增强中…');
    try {
      await sendMessage('enhanceExisting', node.id);
      showToast('已增强');
    } catch (e) {
      showToast(`增强失败：${(e as Error).message}`);
      return;
    }
    await reloadTree();
    return;
  }
  const ids = flattenBookmarks([node], []).map((b) => b.id);
  if (!ids.length) {
    showToast('文件夹里没有可增强的书签');
    return;
  }
  try {
    await sendMessage('startJob', { kind: 'enhance', params: { ids, fetchContent: false } });
    showToast(`已开始后台增强 ${ids.length} 条，可关闭窗口`);
  } catch (e) {
    showToast((e as Error).message);
  }
}

async function ctxReclassify(node: TreeNodeDto) {
  ctxMenu.value = null;
  if (node.url) {
    showToast('AI 挑选目录中…');
    try {
      const r = await sendMessage('reclassifyBookmark', node.id);
      if (r.ok && r.folder) showToast(`已移至 ${r.folder}`);
      else if (r.reason === 'no-candidates') showToast('没有可用的目标目录');
      else showToast('AI 未能确定目标目录');
    } catch (e) {
      showToast(`分类失败：${(e as Error).message}`);
      return;
    }
    await reloadTree();
    return;
  }
  // 根分区（书签栏/其他书签）沿用原有 scope；普通文件夹以子树为输入
  const isRootIdx = treeNodes.value.findIndex((r) => r.id === node.id);
  const params: Record<string, unknown> = isRootIdx >= 0
    ? { scope: isRootIdx === 0 ? 'toolbar' : 'other', maxCategories: 12 }
    : { scope: 'folder', folderId: node.id, maxCategories: 12 };
  try {
    await sendMessage('startJob', { kind: 'classify', params });
    showToast('已开始后台重新分类，可关闭窗口');
  } catch (e) {
    showToast((e as Error).message);
  }
}

// ---- 右键编辑 ----
const ctxEditNode = ref<TreeNodeDto | null>(null);
const ctxEditMeta = computed(() =>
  ctxEditNode.value ? (treeMeta.value[ctxEditNode.value.id] ?? null) : null,
);

async function reloadTree() {
  // 保留用户已展开的节点（失效 id 无害）
  const keep = new Set(treeExpanded.value);
  treeNodes.value = [];
  await loadTree();
  treeExpanded.value = new Set([...keep, ...treeExpanded.value]);
}

// 书签库在其他界面变化时自动刷新 popup 树
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.libraryVersion) void reloadTree();
});

function ctxEdit(node: TreeNodeDto) {
  ctxMenu.value = null;
  if (node.url) {
    ctxEditNode.value = node;
    return;
  }
  // 文件夹：重命名
  const title = prompt('重命名文件夹', node.title);
  if (!title?.trim() || title === node.title) return;
  void sendMessage('renameNode', { id: node.id, title: title.trim() }).then(() => reloadTree());
}

function openManagerSettings() {
  void sendMessage('openManager', 'settings');
  window.close();
}

onMounted(async () => {
  // 树的启动自举：展开状态 → 树数据都就绪并渲染后，恢复上次滚动位置
  void (async () => {
    await Promise.all([restoreTreeExpanded(), loadTree()]);
    await nextTick();
    await restoreTreeScroll();
  })();
  void loadFolderPaths();
  void loadFolderPaths();
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    currentUrl.value = tab?.url ?? '';
    currentTitle.value = tab?.title ?? '';
    tabId.value = tab?.id ?? null;

    const s = await sendMessage('getSettings');
    settings.value = s;

    if (!tab || !/^https?:/i.test(currentUrl.value)) {
      phase.value = 'unsupported';
      return;
    }
    const { bookmarked, meta } = await sendMessage('isUrlBookmarked', currentUrl.value);
    if (bookmarked) {
      existingMeta.value = meta ?? null;
      phase.value = 'bookmarked';
      return;
    }
    phase.value = 'idle';
    await restoreTldr();
  } catch (e) {
    errorMsg.value = (e as Error).message;
    phase.value = 'idle';
  }
  void loadTree();
});
</script>

<template>
  <div class="w-[660px] h-[600px] flex flex-col bg-slate-50 text-slate-800">
    <!-- 顶栏 -->
    <header class="flex items-center gap-2 px-4 py-2.5 bg-white border-b border-slate-200">
      <div class="w-6 h-6 rounded-md bg-indigo-600 text-white grid place-items-center text-sm font-bold">
        A
      </div>
      <span class="font-semibold text-sm">AutoBookmark</span>
      <span class="flex-1"></span>
      <button
        title="打开书签管理 (Alt+Shift+B)"
        class="p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
        @click="openManager"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="15" y1="4" x2="15" y2="20" />
        </svg>
      </button>
      <button
        title="设置"
        class="p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
        @click="openManagerSettings"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      </button>
    </header>

    <div v-if="errorMsg" class="mx-3 mt-2 px-3 py-2 rounded-md bg-red-50 text-red-700 text-xs leading-relaxed">
      {{ errorMsg }}
    </div>

    <div class="flex-1 flex min-h-0">
    <!-- 左栏：书签树（分节头 + 搜索框固定，树/结果滚动） -->
    <aside class="w-1/2 shrink-0 flex flex-col border-r border-slate-200 px-2.5 pt-3 pb-1">
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-xs font-semibold text-slate-500">🌳 全部书签</span>
        <span class="flex-1"></span>
        <button
          class="text-[11px] text-indigo-500 hover:underline"
          title="树操作 / 整理中心"
          @click="openManager"
        >
          完整管理页 ↗
        </button>
      </div>
      <input
        v-model="treeQuery"
        @input="onTreeQueryInput"
        placeholder="搜索全部书签…"
        class="shrink-0 mt-2 w-full px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-[13px] focus:outline-none focus:border-indigo-400"
      />
      <div
        ref="treeScrollEl"
        class="flex-1 min-h-0 overflow-y-auto mt-2 pb-1 space-y-2"
        @scroll.passive="onTreeScroll"
      >

      <!-- 搜索结果（平铺） -->
      <template v-if="treeResults">
        <button
          v-for="item in treeResults"
          :key="item.bookmarkId"
          class="w-full flex items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-white transition-colors"
          @click="openResult(item)"
        >
          <img :src="faviconUrl(item.url)" class="w-4 h-4 mt-0.5 rounded shrink-0" alt="" loading="lazy" />
          <span class="min-w-0">
            <span class="block text-[13px] truncate" @mouseenter="tooltipIfTruncated">{{ item.title }}</span>
            <span class="block text-[10px] text-slate-400 truncate">{{ item.folderPath || hostOf(item.url) }}</span>
          </span>
        </button>
        <p v-if="!treeResults.length" class="py-10 text-center text-xs text-slate-400">没有匹配的书签</p>
      </template>

      <!-- 树 -->
      <template v-else>
        <div v-if="treeLoading" class="space-y-1.5 pt-1">
          <div class="h-5 rounded bg-slate-100 animate-pulse w-2/3"></div>
          <div class="h-5 rounded bg-slate-100 animate-pulse w-1/2"></div>
          <div class="h-5 rounded bg-slate-100 animate-pulse w-3/4"></div>
        </div>
        <MiniTree
          v-else
          :nodes="treeNodes"
          :expanded="treeExpanded"
          :meta-by-id="treeMeta"
          @toggle="toggleTreeNode"
          @open="openBookmark"
          @context-menu="openCtxMenu"
        />
        </template>
      </div>
    </aside>

    <!-- 右栏：收藏区（独立滚动） -->
    <section class="flex-1 min-w-0 overflow-y-auto px-3 py-3 space-y-3">
      <!-- 加载中 -->
      <div v-if="phase === 'loading'" class="py-4 text-center text-sm text-slate-400">加载中…</div>

      <!-- 未配置 -->
      <div v-else-if="phase === 'needsSetup' || (phase === 'idle' && !configured)" class="flex items-center gap-3 rounded-xl bg-amber-50 border border-amber-200 p-3">
        <span class="text-xl shrink-0">🔌</span>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-semibold text-amber-800">还未设置 AI 供应商</p>
          <p class="text-[11px] text-amber-700/80 mt-0.5 leading-relaxed">
            配置后即可智能收藏与 TL;DR；下方书签浏览不受影响
          </p>
        </div>
        <button
          class="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-medium hover:bg-amber-600"
          @click="openManagerSettings"
        >
          去设置
        </button>
      </div>

      <!-- 不支持的页面 -->
      <div v-else-if="phase === 'unsupported'" class="flex items-center gap-3 rounded-xl bg-slate-100 p-3">
        <span class="text-xl shrink-0">🚫</span>
        <div class="min-w-0">
          <p class="text-xs font-semibold text-slate-600">此页面暂不支持收藏</p>
          <p class="text-[11px] text-slate-400 mt-0.5">浏览器内部页面无法提取正文</p>
        </div>
      </div>

      <!-- 已收藏 -->
      <div v-else-if="phase === 'bookmarked'" class="space-y-3">
        <div class="rounded-xl bg-white border border-slate-200 p-3">
          <div class="flex items-start gap-2.5">
            <img :src="faviconUrl(currentUrl)" class="w-5 h-5 mt-0.5 rounded" alt="" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium leading-snug break-words">
                {{ existingMeta?.title || currentTitle }}
              </p>
              <p class="text-xs text-slate-400 mt-0.5">{{ hostOf(currentUrl) }}</p>
            </div>
          </div>
          <div v-if="existingMeta" class="mt-2.5 space-y-1.5">
            <p v-if="existingMeta.summary" class="text-xs text-slate-600 leading-relaxed">
              {{ existingMeta.summary }}
            </p>
            <div class="flex flex-wrap gap-1">
              <span
                v-for="tag in existingMeta.tags"
                :key="tag"
                class="px-1.5 py-0.5 rounded text-[10px] bg-indigo-50 text-indigo-600"
              >
                {{ tag }}
              </span>
            </div>
            <p class="text-[11px] text-slate-400">
              已于 {{ formatTime(existingMeta.createdAt) }} 收藏{{ existingMeta.folderPath ? ' · ' + existingMeta.folderPath : '' }}
            </p>
          </div>
          <p v-else class="mt-2 text-xs text-slate-500">这个页面已在书签中</p>
        </div>
        <button
          class="w-full py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50"
          @click="openManager"
        >
          在侧边栏中查看
        </button>
      </div>

      <!-- 空闲：收藏入口 -->
      <template v-else-if="phase === 'idle' || phase === 'enhancing'">
        <div class="rounded-xl bg-white border border-slate-200 p-3">
          <div class="flex items-start gap-2.5">
            <img :src="faviconUrl(currentUrl)" class="w-6 h-6 mt-0.5 rounded" alt="" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium leading-snug break-words">{{ currentTitle || hostOf(currentUrl) }}</p>
              <p class="text-xs text-slate-400 mt-0.5 truncate">{{ currentUrl }}</p>
            </div>
          </div>

          <div v-if="phase === 'idle'" class="mt-2.5 space-y-2">
            <label class="flex items-center gap-1.5">
              <span class="shrink-0 text-[10px] text-slate-400">保存到</span>
              <select
                v-model="savePath"
                class="flex-1 min-w-0 px-2 py-1 rounded-lg border border-slate-200 bg-white text-[11px] text-slate-600 focus:outline-none focus:border-indigo-400"
              >
                <option v-for="p in folderPaths" :key="p" :value="p">{{ p }}</option>
                <option v-if="savePath && !folderPaths.includes(savePath)" :value="savePath">{{ savePath }}</option>
              </select>
            </label>
            <div class="grid grid-cols-2 gap-2">
              <button
                class="py-1.5 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 text-xs font-medium hover:bg-indigo-100"
                @click="savePlain"
              >
                🔖 收藏
              </button>
              <button
                :disabled="!configured"
                class="py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                @click="startEnhance"
              >
                ✨ AI 收藏
              </button>
            </div>
            <button
              v-if="settings?.bindings.tldr"
              class="w-full py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              :disabled="tldrState === 'loading' || tldrState === 'streaming'"
              @click="runTldr"
            >
              {{ tldrState === 'loading' || tldrState === 'streaming' ? '总结中…' : '⚡ 页面 TL;DR' }}
            </button>
          </div>

          <div v-else class="mt-3 space-y-2">
            <div class="h-3.5 rounded bg-slate-100 animate-pulse w-3/4"></div>
            <div class="h-3 rounded bg-slate-100 animate-pulse w-full"></div>
            <div class="h-3 rounded bg-slate-100 animate-pulse w-5/6"></div>
            <p class="text-xs text-slate-400 pt-1">AI 正在阅读页面，生成标题、摘要与标签…</p>
          </div>
        </div>

      </template>

      <!-- 草稿编辑 -->
      <div v-else-if="phase === 'draft' || phase === 'saving'" class="rounded-xl bg-white border border-slate-200 p-3 space-y-3">
        <label class="block">
          <span class="text-xs font-medium text-slate-500">标题</span>
          <input
            v-model="draft.title"
            class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </label>
        <label class="block">
          <span class="text-xs font-medium text-slate-500">摘要</span>
          <textarea
            v-model="draft.summary"
            rows="3"
            class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs leading-relaxed resize-none focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          ></textarea>
        </label>
        <div>
          <span class="text-xs font-medium text-slate-500">标签</span>
          <div class="mt-1 flex flex-wrap gap-1">
            <span
              v-for="tag in draft.tags"
              :key="tag"
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-xs"
            >
              {{ tag }}
              <button class="text-indigo-400 hover:text-indigo-700" @click="removeTag(tag)">×</button>
            </span>
          </div>
          <input
            v-model="newTag"
            placeholder="回车添加标签"
            class="mt-1.5 w-full px-2.5 py-1 rounded-lg border border-dashed border-slate-300 text-xs focus:outline-none focus:border-indigo-400"
            @keydown.enter.prevent="addTag"
          />
        </div>
        <label class="block">
          <span class="text-xs font-medium text-slate-500">保存路径（AI 建议，可手动改）</span>
          <select
            v-model="savePath"
            class="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:border-indigo-400"
          >
            <option v-for="p in folderPaths" :key="p" :value="p">{{ p }}</option>
            <option v-if="savePath && !folderPaths.includes(savePath)" :value="savePath">{{ savePath }}</option>
          </select>
        </label>
        <div class="flex gap-2 pt-1">
          <button
            class="flex-1 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
            @click="phase = 'idle'"
          >
            取消
          </button>
          <button
            class="flex-1 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
            :disabled="phase === 'saving'"
            @click="save"
          >
            {{ phase === 'saving' ? '保存中…' : '保存书签' }}
          </button>
        </div>
      </div>

      <!-- 已保存 -->
      <div v-else-if="phase === 'saved'" class="text-center py-6 space-y-3">
        <div class="text-3xl">✅</div>
        <p class="text-sm font-medium">已收藏</p>
        <p v-if="savedMeta" class="text-xs text-slate-500">
          {{ savedMeta.folderPath || '书签栏' }} · {{ formatTime(savedMeta.createdAt) }}
        </p>
        <button
          class="px-4 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50"
          @click="openManager"
        >
          在侧边栏中查看
        </button>
      </div>

      <!-- TL;DR 输出 -->
      <div
        v-if="tldrState !== 'hidden'"
        class="rounded-xl bg-white border border-slate-200 p-3"
      >
        <p class="text-xs font-semibold text-slate-500 mb-2">⚡ TL;DR</p>
        <div v-if="tldrState === 'loading'" class="space-y-1.5">
          <div class="h-3 rounded bg-slate-100 animate-pulse w-full"></div>
          <div class="h-3 rounded bg-slate-100 animate-pulse w-11/12"></div>
          <div class="h-3 rounded bg-slate-100 animate-pulse w-4/5"></div>
        </div>
        <p v-else-if="tldrState === 'error'" class="text-xs text-red-600">{{ tldrError }}</p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="(line, i) in tldrLines"
            :key="i"
            class="text-xs text-slate-700 leading-relaxed flex gap-1.5"
          >
            <span class="text-indigo-400 shrink-0">•</span>{{ line }}<span
              v-if="tldrState === 'streaming' && i === tldrLines.length - 1"
              class="animate-pulse text-indigo-500"
              >▍</span
            >
          </li>
        </ul>
      </div>

      <!-- 普通收藏：无需 AI，未配置供应商时也可用 -->
      <button
        v-if="phase === 'needsSetup' || (phase === 'idle' && !configured)"
        class="w-full py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-1.5"
        @click="savePlain"
      >
        🔖 普通收藏（无需 AI）
      </button>
    </section>
    </div>

    <footer class="px-4 py-1.5 border-t border-slate-200 bg-white">
      <p class="text-[10px] text-slate-400 text-center">
        快捷键 Alt+B · 右键菜单也可收藏 · 内容仅发送至你配置的 AI 供应商
      </p>
    </footer>

    <!-- 树右键菜单 -->
    <div
      v-if="ctxMenu"
      class="fixed inset-0 z-40"
      @click="ctxMenu = null"
      @contextmenu.prevent="ctxMenu = null"
    >
      <div
        class="absolute z-50 w-[212px] rounded-xl bg-white border border-slate-200 shadow-xl overflow-hidden"
        :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }"
      >
        <!-- 节点预览头 -->
        <div class="px-3 pt-2.5 pb-2 border-b border-slate-100">
          <div class="flex items-start gap-2">
            <img
              v-if="ctxMenu.node.url"
              :src="faviconUrl(ctxMenu.node.url)"
              class="w-4 h-4 mt-0.5 rounded shrink-0"
              alt=""
            />
            <span v-else class="shrink-0 text-sm">📁</span>
            <div class="min-w-0">
              <p class="text-xs font-medium leading-snug break-words line-clamp-2">
                {{ ctxMenu.node.title || hostOf(ctxMenu.node.url ?? '') }}
              </p>
              <p v-if="ctxMenu.node.url" class="text-[10px] text-slate-400 truncate mt-0.5">
                {{ hostOf(ctxMenu.node.url) }}
              </p>
              <p v-else class="text-[10px] text-slate-400 mt-0.5">文件夹 · {{ ctxMenu.node.children.length }} 项</p>
            </div>
          </div>
        </div>

        <div class="py-1">
          <button
            class="w-full flex items-center justify-between px-3 py-1.5 text-xs text-indigo-600 hover:bg-indigo-50 font-medium"
            @click="ctxEnhance(ctxMenu.node)"
          >
            <span>✨ AI 增强</span><span class="text-slate-400">⚡</span>
          </button>
          <button
            class="w-full flex items-center justify-between px-3 py-1.5 text-xs text-indigo-600 hover:bg-indigo-50 font-medium"
            @click="ctxReclassify(ctxMenu.node)"
          >
            <span>🗂 智能重新分类</span><span class="text-slate-400">⇄</span>
          </button>
          <div class="my-1 border-t border-slate-100"></div>
          <button
            class="w-full flex items-center justify-between px-3 py-1.5 text-xs text-slate-700 hover:bg-indigo-50"
            @click="ctxEdit(ctxMenu.node)"
          >
            <span>{{ ctxMenu.node.url ? '编辑' : '重命名' }}</span><span class="text-slate-400">✎</span>
          </button>
          <button
            v-if="ctxMenu.node.url"
            class="w-full flex items-center justify-between px-3 py-1.5 text-xs text-slate-700 hover:bg-indigo-50"
            @click="ctxOpen(ctxMenu.node)"
          >
            <span>新标签页中打开</span><span class="text-slate-400">↗</span>
          </button>
          <button
            v-if="ctxMenu.node.url"
            class="w-full flex items-center justify-between px-3 py-1.5 text-xs text-slate-700 hover:bg-indigo-50"
            @click="ctxCopyLink(ctxMenu.node)"
          >
            <span>复制链接</span><span class="text-slate-400">⧉</span>
          </button>
          <button
            v-if="!ctxMenu.node.url"
            class="w-full flex items-center justify-between px-3 py-1.5 text-xs text-slate-700 hover:bg-indigo-50"
            @click="ctxToggle(ctxMenu.node)"
          >
            <span>{{ treeExpanded.has(ctxMenu.node.id) ? '收起' : '展开' }}</span>
            <span class="text-slate-400">{{ treeExpanded.has(ctxMenu.node.id) ? '▲' : '▼' }}</span>
          </button>
          <button
            class="w-full flex items-center justify-between px-3 py-1.5 text-xs text-slate-700 hover:bg-indigo-50"
            @click="ctxOpenManager"
          >
            <span>在管理页中查看</span><span class="text-slate-400">⇥</span>
          </button>
          <div class="my-1 border-t border-slate-100"></div>
          <button
            class="w-full flex items-center justify-between px-3 py-1.5 text-xs text-red-500 hover:bg-red-50"
            @click="ctxDelete(ctxMenu.node)"
          >
            <span>删除</span><span>🗑</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 右键编辑弹窗 -->
    <MetaEditDialog
      :node="ctxEditNode"
      :meta="ctxEditMeta"
      @close="ctxEditNode = null"
      @saved="reloadTree()"
    />

    <!-- 删除二次确认 -->
    <div
      v-if="confirmDelete"
      class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6"
      @click.self="confirmDelete = null"
    >
      <div class="w-full max-w-xs rounded-xl bg-white p-4 shadow-xl space-y-3">
        <p class="text-sm font-medium">
          {{ confirmDelete.node.url ? '删除书签' : '删除文件夹' }}
        </p>
        <p class="text-xs text-slate-600 leading-relaxed break-words">
          确定删除「{{ confirmDelete.node.title || hostOf(confirmDelete.node.url ?? '') }}」{{
            confirmDelete.node.url ? '' : `及其全部内容（${countDescendants(confirmDelete.node)} 项）`
          }}？此操作不可撤销。
        </p>
        <div class="flex justify-end gap-2">
          <button
            class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
            @click="confirmDelete = null"
          >
            取消
          </button>
          <button
            class="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600"
            @click="confirmDeleteAction"
          >
            确认删除
          </button>
        </div>
      </div>
    </div>

    <!-- 轻提示 -->
    <div
      v-if="toast"
      class="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs shadow-lg"
    >
      {{ toast }}
    </div>
  </div>
</template>
