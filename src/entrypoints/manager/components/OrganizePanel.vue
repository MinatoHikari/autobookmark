<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../../shared/messages';
import type { BackupEntry, OrganizeJob } from '../../../shared/types';

const props = defineProps<{ unenhancedIds: string[] }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const jobs = ref<OrganizeJob[]>([]);
const backups = ref<BackupEntry[]>([]);
const hasAccess = ref(false);
const busy = ref(false);
const errorMsg = ref('');
const scope = ref<'all' | 'toolbar' | 'other'>('all');
const maxCategories = ref(12);
/** 类目层级上限：≥2 时 AI 产出 "大类/子类" 多级目录 */
const maxDepth = ref(1);
const fetchContent = ref(false);

// ---- 自定义弹层（原生 confirm/alert 在无头/自动化环境下会永久阻塞页面）----
const confirmState = ref<null | { text: string; action: () => void }>(null);
const noticeMsg = ref('');

function askConfirm(text: string, action: () => void) {
  confirmState.value = { text, action };
}
function runConfirm() {
  const c = confirmState.value;
  confirmState.value = null;
  c?.action();
}

const unenhancedCount = computed(() => props.unenhancedIds.length);

let timer: ReturnType<typeof setInterval> | undefined;

const KIND_LABELS: Record<OrganizeJob['kind'], string> = {
  enhance: '补全元数据',
  classify: '自动分类',
  dedupe: '去重',
  deadlink: '死链检测',
};

const STATUS_LABELS: Record<OrganizeJob['status'], string> = {
  queued: '排队中',
  running: '进行中',
  paused: '已暂停',
  'awaiting-review': '待确认',
  done: '已完成',
  undone: '已撤销',
  cancelled: '已取消',
  error: '出错',
};

const activeJob = computed(() => jobs.value.find((j) => j.status === 'queued' || j.status === 'running'));
const hasUndo = (job: OrganizeJob) => job.undoLog.length > 0 && (job.status === 'done' || job.status === 'error');

async function refresh() {
  try {
    jobs.value = await sendMessage('getJobs');
    backups.value = await sendMessage('listBackups');
  } catch {
    /* SW 可能休眠，下轮再试 */
  }
  // 任务进入待确认 → 自动弹出审查弹窗（用户关掉过的不打扰）
  const pending = jobs.value.find(
    (j) => j.status === 'awaiting-review' && (j.kind === 'dedupe' || j.kind === 'deadlink'),
  );
  if (pending && !reviewJobId.value && !dismissedReviewIds.has(pending.id)) openReview(pending);
}

async function removeBackup(b: BackupEntry) {
  askConfirm(`删除备份「${b.label}」？此操作不可恢复。`, async () => {
    busy.value = true;
    try {
      await sendMessage('deleteBackup', b.id);
      await refresh();
    } finally {
      busy.value = false;
    }
  });
}

async function recoverFromMeta() {
  askConfirm('扫描 AI 元数据，重建 chrome.bookmarks 中已消失的书签？\n（只恢复被 AI 增强过的书签，放到「其他书签/恢复的书签」下）', async () => {
    busy.value = true;
    try {
      const { recovered, skipped } = await sendMessage('recoverFromMeta');
      await refresh();
      emit('changed');
      noticeMsg.value = recovered
        ? `已恢复 ${recovered} 条书签到「其他书签/恢复的书签」`
        : `没有发现可恢复的书签${skipped ? `（${skipped} 条候选的 URL 已存在，跳过）` : ''}`;
    } catch (e) {
      errorMsg.value = (e as Error).message;
    } finally {
      busy.value = false;
    }
  });
}

async function backupNow() {
  busy.value = true;
  try {
    await sendMessage('createBackupNow', `手动备份 ${new Date().toLocaleString('zh-CN')}`);
    await refresh();
  } finally {
    busy.value = false;
  }
}

function downloadBackup(b: BackupEntry) {
  void (async () => {
    const html = await sendMessage('getBackupHtml', b.id);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `autobookmark-backup-${new Date(b.createdAt).toISOString().slice(0, 19).replace(/[T:]/g, '-')}.html`;
    a.click();
    URL.revokeObjectURL(url);
  })();
}

async function restore(b: BackupEntry) {
  askConfirm(
    `恢复到 ${new Date(b.createdAt).toLocaleString('zh-CN')} 的书签结构？\n` +
      '当前全部书签将被清空并按快照重建（恢复前会自动再备份一次）。\n' +
      '注意：AI 摘要/标签等元数据在恢复后会失效。',
    async () => {
      busy.value = true;
      try {
        await sendMessage('restoreBackup', b.id);
        await refresh();
        emit('changed');
      } finally {
        busy.value = false;
      }
    },
  );
}

async function refreshAccess() {
  hasAccess.value = await sendMessage('hasAllSiteAccess');
}

async function grantAccess() {
  // permissions.request 必须在页面用户手势内调用
  hasAccess.value = await browser.permissions.request({
    origins: ['http://*/*', 'https://*/*'],
  });
}

async function begin(kind: OrganizeJob['kind'], params: Record<string, unknown>) {
  busy.value = true;
  errorMsg.value = '';
  try {
    await sendMessage('startJob', { kind, params });
    emit('changed');
    await refresh();
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function startEnhance() {
  void begin('enhance', {
    ids: props.unenhancedIds,
    fetchContent: fetchContent.value && hasAccess.value,
  });
}

function startClassify() {
  void begin('classify', {
    scope: scope.value,
    maxCategories: maxCategories.value,
    maxDepth: maxDepth.value,
  });
}

function startDedupe() {
  void begin('dedupe', {});
}

function startDeadlink() {
  void begin('deadlink', {});
}

async function removeJob(job: OrganizeJob) {
  if (job.status === 'awaiting-review') {
    askConfirm('该任务有待确认的分组，删除后将丢弃这些分组，确定？', () => void doRemoveJob(job));
    return;
  }
  await doRemoveJob(job);
}

async function doRemoveJob(job: OrganizeJob) {
  busy.value = true;
  try {
    await sendMessage('deleteJob', job.id);
    await refresh();
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function action(job: OrganizeJob, act: 'pause' | 'resume' | 'cancel' | 'undo') {
  busy.value = true;
  try {
    await sendMessage(`${act}Job` as 'pauseJob', job.id);
    await refresh();
    emit('changed');
  } finally {
    busy.value = false;
  }
}

// ---- 审查弹窗（去重/死链落地前的可勾选二次确认，勾选=待删除，默认全选）----
const reviewJobId = ref<string | null>(null);
const reviewChecked = ref<Set<string>>(new Set());
/** 用户手动关掉过弹窗的任务不再自动弹出 */
const dismissedReviewIds = new Set<string>();

const reviewLive = computed(() => jobs.value.find((j) => j.id === reviewJobId.value) ?? null);
const isDedupeReview = computed(() => reviewLive.value?.kind === 'dedupe');
const reviewGroups = computed(() => reviewLive.value?.result?.groups ?? []);
const reviewRemoveCount = computed(() => reviewChecked.value.size);
/** 去重组被全部勾选 = 一条都不保留，禁止确认 */
const invalidGroups = computed(() =>
  isDedupeReview.value
    ? reviewGroups.value.filter((g) => g.items.every((i) => reviewChecked.value.has(i.bookmarkId)))
    : [],
);

function openReview(job: OrganizeJob) {
  reviewJobId.value = job.id;
  // 默认全选待删：死链=每条都删；去重=每组保留第一条，其余勾删
  const checked = new Set<string>();
  for (const g of job.result?.groups ?? []) {
    if (job.kind === 'dedupe') for (const item of g.items.slice(1)) checked.add(item.bookmarkId);
    else for (const item of g.items) checked.add(item.bookmarkId);
  }
  reviewChecked.value = checked;
}

function closeReview() {
  if (reviewJobId.value) dismissedReviewIds.add(reviewJobId.value);
  reviewJobId.value = null;
}

function toggleReviewCheck(id: string) {
  const next = new Set(reviewChecked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  reviewChecked.value = next;
}

async function confirmReview() {
  const job = reviewLive.value;
  if (!job) return;
  busy.value = true;
  try {
    if (job.kind === 'dedupe') {
      const keepByGroup: Record<string, string> = {};
      for (const g of job.result?.groups ?? []) {
        const keep = g.items.find((i) => !reviewChecked.value.has(i.bookmarkId));
        if (keep) keepByGroup[g.id] = keep.bookmarkId;
      }
      await sendMessage('resolveJob', { jobId: job.id, keepByGroup });
    } else {
      await sendMessage('resolveJob', { jobId: job.id, removeIds: [...reviewChecked.value] });
    }
    reviewJobId.value = null;
    await refresh();
    emit('changed');
  } catch (e) {
    errorMsg.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void refresh();
  void refreshAccess();
  timer = setInterval(() => void refresh(), 1500);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="fixed inset-0 z-30 bg-slate-900/40 flex justify-end" @click.self="emit('close')">
    <aside class="w-[520px] max-w-full h-full bg-slate-50 shadow-2xl flex flex-col">
      <header class="flex items-center gap-2 px-5 py-3.5 bg-white border-b border-slate-200">
        <h2 class="text-sm font-semibold">整理中心</h2>
        <span class="flex-1"></span>
        <button class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-500 hover:bg-slate-50" @click="emit('close')">
          关闭
        </button>
      </header>

      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <p v-if="errorMsg" class="px-3 py-2 rounded-lg bg-red-50 text-red-700 text-xs">{{ errorMsg }}</p>

        <!-- 备份卡 -->
        <div class="rounded-xl bg-white border border-slate-200 p-3.5 space-y-2.5">
          <div class="flex items-center gap-2">
            <p class="text-xs font-semibold">📦 书签备份</p>
            <span class="flex-1"></span>
            <button
              class="px-2.5 py-1 rounded-lg border border-slate-200 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              :disabled="busy"
              @click="backupNow"
            >
              立即备份
            </button>
          </div>
          <p class="text-[11px] text-slate-400 leading-relaxed">
            分类/去重/死链任务启动前会自动备份；最多保留 10 份
          </p>
          <button
            class="text-[11px] text-amber-600 hover:underline"
            @click="recoverFromMeta"
          >
            🛟 从元数据恢复丢失的书签
          </button>
          <div v-if="backups.length" class="space-y-1.5 max-h-40 overflow-y-auto">
            <div
              v-for="b in backups"
              :key="b.id"
              class="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5"
            >
              <div class="min-w-0 flex-1">
                <p class="text-[11px] truncate">{{ b.label }}</p>
                <p class="text-[10px] text-slate-400">
                  {{ new Date(b.createdAt).toLocaleString('zh-CN') }} · {{ b.count }} 条
                </p>
              </div>
              <button
                class="shrink-0 px-2 py-0.5 rounded text-[10px] text-slate-500 hover:bg-white"
                title="下载 HTML（可在浏览器书签管理器导入）"
                @click="downloadBackup(b)"
              >
                下载
              </button>
              <button
                class="shrink-0 px-2 py-0.5 rounded text-[10px] text-red-400 hover:bg-white hover:text-red-600"
                title="删除此备份"
                @click="removeBackup(b)"
              >
                删除
              </button>
              <button
                class="shrink-0 px-2 py-0.5 rounded text-[10px] text-red-500 hover:bg-white"
                @click="restore(b)"
              >
                恢复
              </button>
            </div>
          </div>
          <p v-else class="text-[11px] text-slate-400">暂无备份</p>
        </div>

        <!-- 权限卡 -->
        <div class="rounded-xl bg-white border border-slate-200 p-3.5 flex items-center gap-3">
          <div class="flex-1">
            <p class="text-xs font-medium">网站访问权限</p>
            <p class="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              死链检测与正文抓取需要；不授权也可用标题+URL 完成增强与分类
            </p>
          </div>
          <span v-if="hasAccess" class="text-xs text-green-600">已授权 ✓</span>
          <button
            v-else
            class="px-3 py-1.5 rounded-lg border border-indigo-200 text-xs text-indigo-600 hover:bg-indigo-50"
            @click="grantAccess"
          >
            授权
          </button>
        </div>

        <!-- 四个动作 -->
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-xl bg-white border border-slate-200 p-3.5 space-y-2">
            <p class="text-xs font-semibold">✨ 补全元数据</p>
            <p class="text-[11px] text-slate-400 leading-relaxed">为 {{ unenhancedCount }} 条未增强书签生成摘要与标签，不改变目录</p>
            <label class="flex items-center gap-1.5 text-[11px] text-slate-500">
              <input type="checkbox" v-model="fetchContent" class="accent-indigo-600" :disabled="!hasAccess" />
              抓取正文（更准，更慢）
            </label>
            <button
              class="w-full py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-40"
              :disabled="busy || !!activeJob || !unenhancedCount"
              @click="startEnhance"
            >
              开始（{{ unenhancedCount }} 条）
            </button>
          </div>

          <div class="rounded-xl bg-white border border-slate-200 p-3.5 space-y-2">
            <p class="text-xs font-semibold">🗂 自动分类</p>
            <div class="flex gap-1.5">
              <select v-model="scope" class="flex-1 min-w-0 px-2 py-1 rounded-lg border border-slate-200 text-[11px] bg-white">
                <option value="all">全部书签</option>
                <option value="toolbar">仅书签栏</option>
                <option value="other">仅其他书签</option>
              </select>
              <select
                v-model.number="maxDepth"
                class="px-1.5 py-1 rounded-lg border border-slate-200 text-[11px] bg-white"
                title="类目层级：≥2 级时 AI 生成「大类/子类」多级目录"
              >
                <option :value="1">1 级</option>
                <option :value="2">2 级</option>
                <option :value="3">3 级</option>
              </select>
              <label class="flex items-center gap-1 text-[11px] text-slate-500" title="大类数量上限">
                ≤{{ maxCategories }}类
                <input type="range" min="6" max="20" v-model.number="maxCategories" class="w-12 accent-indigo-600" />
              </label>
            </div>
            <p class="text-[11px] text-slate-400 leading-relaxed">AI 聚类后在原地建分类文件夹并移动，可一键撤销；跳过「AI 收藏」子树</p>
            <button
              class="w-full py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-40"
              :disabled="busy || !!activeJob"
              @click="startClassify"
            >
              开始分类
            </button>
          </div>

          <div class="rounded-xl bg-white border border-slate-200 p-3.5 space-y-2">
            <p class="text-xs font-semibold">🔁 去重</p>
            <p class="text-[11px] text-slate-400 leading-relaxed">URL 归一化 + 语义相似 + AI 确认，逐组选择保留项</p>
            <button
              class="w-full py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-40"
              :disabled="busy || !!activeJob"
              @click="startDedupe"
            >
              扫描重复
            </button>
          </div>

          <div class="rounded-xl bg-white border border-slate-200 p-3.5 space-y-2">
            <p class="text-xs font-semibold">💀 死链检测</p>
            <p class="text-[11px] text-slate-400 leading-relaxed">批量探测全部书签可访问性，确认后删除（需授权）</p>
            <button
              class="w-full py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-40"
              :disabled="busy || !!activeJob || !hasAccess"
              @click="startDeadlink"
            >
              开始检测
            </button>
          </div>
        </div>

        <!-- 任务列表 -->
        <div class="space-y-3">
          <h3 class="text-xs font-semibold text-slate-500 px-1">任务记录</h3>
          <div v-if="!jobs.length" class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400">
            还没有整理任务
          </div>

          <div v-for="job in jobs" :key="job.id" class="rounded-xl bg-white border border-slate-200 p-3.5 space-y-2.5">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium">{{ KIND_LABELS[job.kind] }}</span>
              <button
                v-if="job.status !== 'running' && job.status !== 'queued'"
                class="text-slate-300 hover:text-red-500 text-xs leading-none"
                title="删除任务记录"
                @click="removeJob(job)"
              >
                ✕
              </button>
              <span
                class="text-[10px] px-1.5 py-px rounded-full"
                :class="{
                  'bg-blue-50 text-blue-600': job.status === 'running' || job.status === 'queued',
                  'bg-amber-50 text-amber-600': job.status === 'paused' || job.status === 'awaiting-review',
                  'bg-green-50 text-green-600': job.status === 'done',
                  'bg-slate-100 text-slate-500': job.status === 'undone' || job.status === 'cancelled',
                  'bg-red-50 text-red-600': job.status === 'error',
                }"
              >
                {{ STATUS_LABELS[job.status] }}
              </span>
              <span class="flex-1"></span>
              <span class="text-[10px] text-slate-400 tabular-nums" v-if="job.total">
                {{ Math.min(job.done, job.total) }}/{{ job.total }}
              </span>
            </div>

            <!-- 进度条 -->
            <div v-if="job.total" class="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                class="h-full bg-indigo-500 transition-all"
                :style="{ width: `${Math.min(100, Math.round((job.done / job.total) * 100))}%` }"
              ></div>
            </div>

            <p v-if="job.error" class="text-[11px] text-red-600">{{ job.error }}</p>
            <ul v-if="job.result?.report" class="space-y-0.5">
              <li v-for="(line, i) in job.result.report" :key="i" class="text-[11px] text-slate-500">· {{ line }}</li>
            </ul>

            <!-- 控制按钮 -->
            <div class="flex gap-2" v-if="job.status === 'running' || job.status === 'queued' || job.status === 'paused' || job.status === 'error'">
              <button
                v-if="job.status === 'paused' || job.status === 'error'"
                class="px-2.5 py-1 rounded-lg bg-indigo-50 border border-indigo-200 text-[11px] text-indigo-600 hover:bg-indigo-100"
                :title="job.status === 'error' ? '从当前进度继续，不重复已完成批次' : ''"
                @click="action(job, 'resume')"
              >
                {{ job.status === 'error' ? '继续（从进度处重试）' : '继续' }}
              </button>
              <button
                v-if="job.status === 'running' || job.status === 'queued' || job.status === 'paused'"
                class="px-2.5 py-1 rounded-lg border border-slate-200 text-[11px] text-slate-600 hover:bg-slate-50"
                @click="action(job, 'pause')"
              >
                暂停
              </button>
              <button
                v-if="job.status !== 'error'"
                class="px-2.5 py-1 rounded-lg border border-slate-200 text-[11px] text-slate-600 hover:bg-slate-50"
                @click="action(job, 'cancel')"
              >
                取消
              </button>
            </div>

            <!-- 待确认：弹窗审查入口（进入待确认状态时自动弹出） -->
            <div
              v-if="job.status === 'awaiting-review'"
              class="border-t border-slate-100 pt-2 flex items-center gap-2"
            >
              <span class="text-[11px] text-amber-600">
                发现 {{ (job.result?.groups ?? []).length }} 组待确认
              </span>
              <span class="flex-1"></span>
              <button
                class="px-2.5 py-1 rounded-lg bg-red-500 text-white text-[11px] font-medium hover:bg-red-600"
                @click="openReview(job)"
              >
                去审查
              </button>
            </div>

            <!-- 撤销 -->
            <button
              v-if="hasUndo(job)"
              class="px-2.5 py-1 rounded-lg border border-amber-200 text-[11px] text-amber-700 hover:bg-amber-50"
              @click="action(job, 'undo')"
            >
              ↩ 撤销本次整理（{{ job.undoLog.length }} 步）
            </button>
          </div>
        </div>
      </div>
    </aside>

    <!-- 审查弹窗：去重/死链落地前的可勾选二次确认（勾选=待删除，默认全选） -->
    <div
      v-if="reviewLive"
      class="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-6"
      @click.self="closeReview"
    >
      <div class="w-full max-w-md max-h-[80vh] rounded-xl bg-white shadow-xl flex flex-col overflow-hidden">
        <div class="px-4 pt-3.5 pb-2.5 border-b border-slate-100">
          <p class="text-sm font-medium">{{ isDedupeReview ? '删除重复书签' : '删除死链书签' }}</p>
          <p class="mt-0.5 text-[11px] text-slate-400 leading-relaxed">
            {{
              isDedupeReview
                ? '勾选 = 删除；每组默认保留第一条，取消勾选即保留，每组至少保留一条'
                : '勾选 = 删除（默认全选），取消勾选的保留'
            }}
          </p>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          <template v-if="isDedupeReview">
            <div
              v-for="group in reviewGroups"
              :key="group.id"
              class="rounded-lg border p-2.5 space-y-1.5"
              :class="invalidGroups.some((g) => g.id === group.id) ? 'border-red-300 bg-red-50/60' : 'border-slate-200 bg-slate-50'"
            >
              <label
                v-for="item in group.items"
                :key="item.bookmarkId"
                class="flex items-start gap-2 cursor-pointer"
              >
                <input
                  type="checkbox"
                  class="mt-0.5 accent-red-500"
                  :checked="reviewChecked.has(item.bookmarkId)"
                  @change="toggleReviewCheck(item.bookmarkId)"
                />
                <span class="min-w-0" :class="reviewChecked.has(item.bookmarkId) ? 'opacity-60' : ''">
                  <span class="block text-xs truncate">{{ item.title }}</span>
                  <span class="block text-[10px] text-slate-400 truncate">{{ item.folderPath || '·' }} · {{ item.url }}</span>
                </span>
              </label>
            </div>
          </template>
          <template v-else>
            <label
              v-for="group in reviewGroups"
              :key="group.id"
              class="flex items-start gap-2 cursor-pointer"
            >
              <input
                type="checkbox"
                class="mt-0.5 accent-red-500"
                :checked="reviewChecked.has(group.items[0]!.bookmarkId)"
                @change="toggleReviewCheck(group.items[0]!.bookmarkId)"
              />
              <span class="min-w-0">
                <span class="block text-xs truncate">{{ group.items[0]!.title }}</span>
                <span class="block text-[10px] text-red-400 truncate">{{ group.items[0]!.url }}</span>
                <span class="block text-[10px] text-slate-400 truncate">{{ group.items[0]!.folderPath }}</span>
              </span>
            </label>
          </template>
        </div>
        <div class="px-4 py-3 border-t border-slate-100 flex items-center gap-2">
          <p v-if="invalidGroups.length" class="flex-1 text-[11px] text-red-500">
            有 {{ invalidGroups.length }} 组全部勾选，需至少保留一条
          </p>
          <span v-else class="flex-1 text-[11px] text-slate-400">将删除 {{ reviewRemoveCount }} 条</span>
          <button
            class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
            @click="closeReview"
          >
            取消
          </button>
          <button
            class="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-40"
            :disabled="busy || !reviewRemoveCount || !!invalidGroups.length"
            @click="confirmReview"
          >
            确认删除（{{ reviewRemoveCount }}）
          </button>
        </div>
      </div>
    </div>

    <!-- 确认弹层（替代原生 confirm） -->
    <div
      v-if="confirmState"
      class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6"
      @click.self="confirmState = null"
    >
      <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl space-y-3">
        <p class="text-sm font-medium">确认操作</p>
        <p class="text-xs text-slate-600 leading-relaxed whitespace-pre-line">{{ confirmState.text }}</p>
        <div class="flex justify-end gap-2">
          <button class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50" @click="confirmState = null">取消</button>
          <button class="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600" @click="runConfirm">确认</button>
        </div>
      </div>
    </div>

    <!-- 通知弹层（替代原生 alert） -->
    <div
      v-if="noticeMsg"
      class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6"
      @click.self="noticeMsg = ''"
    >
      <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl space-y-3">
        <p class="text-xs text-slate-600 leading-relaxed">{{ noticeMsg }}</p>
        <div class="flex justify-end">
          <button class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700" @click="noticeMsg = ''">知道了</button>
        </div>
      </div>
    </div>
  </div>
</template>
