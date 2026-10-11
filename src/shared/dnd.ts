import { ref } from 'vue';
import type { TreeNodeDto } from './types';
import { faviconUrl } from './ui';

export type DropZone = 'before' | 'into' | 'after';

/** 落点回调载荷：targetId 由 App 侧用 findNode 还原为节点 DTO */
export interface TreeDropEvent {
  targetId: string;
  zone: DropZone;
  draggedId: string;
}

// —— 页面级拖拽状态（每个扩展页面文档各持有一份）——
export const draggingId = ref<string | null>(null);
export const dropHint = ref<{ id: string; zone: DropZone } | null>(null);

const PRESS_THRESHOLD = 5; // px，超过才进入拖拽，保留普通点击/双击/右键
const CLICK_SUPPRESS_MS = 300;

let press: { node: TreeNodeDto; x: number; y: number } | null = null;
let active = false;
let ghost: HTMLElement | null = null;
let clickSuppressUntil = 0;
let dropHandler: ((e: TreeDropEvent) => void) | null = null;

/** App setup 时注册一次落点处理器（拖拽 mouseup 命中目标行时回调） */
export function setNodeDropHandler(handler: (e: TreeDropEvent) => void): void {
  dropHandler = handler;
}

/** 拖拽刚结束的短时间内吞掉随行 click，避免落点行被误当作普通点击 */
export function shouldSuppressClick(): boolean {
  return Date.now() < clickSuppressUntil;
}

/**
 * 树行/卡片 mousedown 入口。用自定义鼠标事件拖拽（而非 HTML5 DnD）：
 * 拖拽期间不存在浏览器拖拽循环，滚轮滚动、悬停等交互照常工作。
 * 根级行（书签栏等 Chrome 根文件夹）不可拖动。
 */
export function beginRowDrag(node: TreeNodeDto, event: MouseEvent, isRootLevel: boolean): void {
  if (event.button !== 0 || isRootLevel) return;
  ensureListeners();
  press = { node, x: event.clientX, y: event.clientY };
}

function clearDragState(): void {
  draggingId.value = null;
  dropHint.value = null;
}

function startDrag(node: TreeNodeDto): void {
  active = true;
  draggingId.value = node.id;
  ghost = createGhost(node);
  document.documentElement.style.userSelect = 'none';
  document.documentElement.style.cursor = 'grabbing';
}

function createGhost(node: TreeNodeDto): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '9999',
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    maxWidth: '260px',
    padding: '4px 10px',
    borderRadius: '8px',
    background: '#fff',
    border: '1px solid #6366f1',
    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)',
    fontSize: '12px',
    color: '#334155',
    whiteSpace: 'nowrap',
  } as CSSStyleDeclaration);
  if (node.url) {
    const img = document.createElement('img');
    img.src = faviconUrl(node.url);
    Object.assign(img.style, { width: '14px', height: '14px', borderRadius: '2px', flexShrink: '0' });
    el.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.textContent = '📁';
    icon.style.flexShrink = '0';
    el.appendChild(icon);
  }
  const label = document.createElement('span');
  label.textContent = node.title || node.url || '';
  Object.assign(label.style, { overflow: 'hidden', textOverflow: 'ellipsis' });
  el.appendChild(label);
  document.body.appendChild(el);
  return el;
}

function positionGhost(x: number, y: number): void {
  if (!ghost) return;
  const left = Math.min(x + 14, window.innerWidth - ghost.offsetWidth - 8);
  const top = Math.min(y + 10, window.innerHeight - ghost.offsetHeight - 8);
  ghost.style.left = `${Math.max(4, left)}px`;
  ghost.style.top = `${Math.max(4, top)}px`;
}

/** 命中测试：光标下最近的可放置行（行由 data-ab-node 标记） */
function hitTest(x: number, y: number): { el: HTMLElement; rect: DOMRect } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-ab-node]');
  if (!el) return null;
  return { el, rect: el.getBoundingClientRect() };
}

function zoneFor(type: string, rect: DOMRect, clientY: number, isRootLevel: boolean): DropZone {
  if (type !== 'bookmark') {
    if (isRootLevel) return 'into';
    const y = clientY - rect.top;
    if (y < rect.height * 0.25) return 'before';
    if (y > rect.height * 0.75) return 'after';
    return 'into';
  }
  return clientY - rect.top < rect.height / 2 ? 'before' : 'after';
}

function onMove(event: MouseEvent): void {
  if (!active && press) {
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < PRESS_THRESHOLD) return;
    startDrag(press.node);
    press = null;
  }
  if (!active) return;
  positionGhost(event.clientX, event.clientY);
  const hit = hitTest(event.clientX, event.clientY);
  if (!hit) {
    dropHint.value = null;
    return;
  }
  dropHint.value = {
    id: hit.el.dataset.abNode!,
    zone: zoneFor(hit.el.dataset.abType ?? 'bookmark', hit.rect, event.clientY, hit.el.dataset.abRoot === '1'),
  };
}

function onUp(event: MouseEvent): void {
  press = null;
  if (!active) return;
  const draggedId = draggingId.value;
  const hit = hitTest(event.clientX, event.clientY);
  const e: TreeDropEvent | null =
    hit && draggedId
      ? {
          targetId: hit.el.dataset.abNode!,
          zone: zoneFor(hit.el.dataset.abType ?? 'bookmark', hit.rect, event.clientY, hit.el.dataset.abRoot === '1'),
          draggedId,
        }
      : null;
  endDrag();
  if (e) dropHandler?.(e);
}

function endDrag(): void {
  active = false;
  clickSuppressUntil = Date.now() + CLICK_SUPPRESS_MS;
  document.documentElement.style.userSelect = '';
  document.documentElement.style.cursor = '';
  ghost?.remove();
  ghost = null;
  clearDragState();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && active) endDrag();
}

function onBlur(): void {
  if (active) endDrag();
  press = null;
}

let installed = false;
function ensureListeners(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('keydown', onKey);
}

export type DropResolution =
  | { ok: true; parentId: string; index?: number }
  | { ok: false; reason: 'noop' | 'invalid' };

function findSiblings(nodes: TreeNodeDto[], childId: string): TreeNodeDto[] | null {
  for (const node of nodes) {
    if (node.children.some((c) => c.id === childId)) return node.children;
    if (!node.url) {
      const hit = findSiblings(node.children, childId);
      if (hit) return hit;
    }
  }
  return null;
}

function containsId(node: TreeNodeDto, id: string): boolean {
  if (node.id === id) return true;
  return node.children.some((c) => containsId(c, id));
}

function findIn(nodes: TreeNodeDto[], id: string): TreeNodeDto | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (!node.url) {
      const hit = findIn(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 把「拖拽节点 + 目标行 + 落点分区」解析为 moveNode 参数。
 * index 语义：目标父级 children 中移除被拖节点后的**最终插入位置**；
 * 浏览器 move API 对同层移动按「移除前」列表解释 index，由 background 换算。
 * 'into' 不带 index → 追加到目标文件夹末尾。
 */
export function resolveDropTarget(
  roots: TreeNodeDto[],
  draggedId: string,
  target: TreeNodeDto,
  zone: DropZone,
): DropResolution {
  // Chrome 根文件夹（书签栏 / 其他书签 / 移动设备书签）不可移动
  if (roots.some((r) => r.id === draggedId)) return { ok: false, reason: 'invalid' };
  if (draggedId === target.id) return { ok: false, reason: 'noop' };
  const dragged = findIn(roots, draggedId);
  if (!dragged) return { ok: false, reason: 'invalid' };

  if (zone === 'into') {
    if (target.url) return { ok: false, reason: 'invalid' };
    // 环路：目标位于被拖文件夹自身或其子树内。
    // 反向（被拖节点是目标的直接子级）不在此列 —— 那表示「移到该文件夹末尾」。
    if (containsId(dragged, target.id)) return { ok: false, reason: 'invalid' };
    return { ok: true, parentId: target.id };
  }

  // 根级行只能被移入，不能作为插入参照
  if (roots.some((r) => r.id === target.id)) return { ok: false, reason: 'invalid' };
  const siblings = findSiblings(roots, target.id);
  if (!siblings) return { ok: false, reason: 'invalid' };
  const targetIdx = siblings.findIndex((c) => c.id === target.id);
  if (targetIdx < 0) return { ok: false, reason: 'invalid' };

  let index = zone === 'before' ? targetIdx : targetIdx + 1;
  const oldIdx = siblings.findIndex((c) => c.id === draggedId);
  if (oldIdx >= 0) {
    // 同层移动：按移除被拖节点后的最终位置计（后台再换算为浏览器 API 的原位语义）
    if (oldIdx < index) index -= 1;
    if (index === oldIdx) return { ok: false, reason: 'noop' };
  }
  // toDto 为每个非虚拟根节点写入了真实 parentId；根级行已在上面排除
  return { ok: true, parentId: target.parentId!, index };
}
