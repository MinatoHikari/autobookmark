import { browser } from 'wxt/browser';
import { rt } from '../../shared/i18n';
import { AiClientError, type ChatMessage } from '../providers/client';
import { resolveBinding } from './enhance';
import { getTreeDtos, listFolderPaths, flattenBookmarks, type FlatBookmark } from '../organize/scan';
import { resolveFolderPath } from '../bookmarks/pipeline';
import { searchBookmarks, invalidateSearchIndex } from '../search/search';
import { getMeta, putMeta, deleteMeta, bumpLibraryVersion } from '../storage/db';
import { trackUsage } from './usage';
import type { Settings } from '../storage/settings';
import type { TreeNodeDto } from '../../shared/types';

/** 工具活动回报（UI 显示为徽章） */
export type AgentEmit = (event: { type: 'delta'; text: string } | { type: 'tool'; name: string; detail: string }) => void;

const MAX_ITERATIONS = 8;
/** 超过此数量的删除必须先经用户在对话中确认 */
const DELETE_CONFIRM_THRESHOLD = 3;

// ---------- 工具定义（OpenAI function calling 格式） ----------

const toolSchemas = [
  {
    type: 'function' as const,
    function: {
      name: 'list_folders',
      description: '列出书签库中全部目录的完整路径',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_bookmarks',
      description: '列出书签。可按目录过滤（完整路径）或按关键词过滤标题/URL，最多返回 50 条',
      parameters: {
        type: 'object',
        properties: {
          folder_path: { type: 'string', description: '目录完整路径，如 "书签栏/osu"。省略则列出全部' },
          keyword: { type: 'string', description: '标题/URL 关键词过滤' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_bookmarks',
      description: '按语义+关键词混合搜索书签',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'rename_bookmarks',
      description: '批量重命名书签标题',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '要重命名的书签列表',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                new_title: { type: 'string' },
              },
              required: ['id', 'new_title'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'move_bookmarks',
      description: '批量移动书签到目标目录；目录不存在会自动创建',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '书签 id 列表' },
          target_path: { type: 'string', description: '目标目录完整路径' },
        },
        required: ['ids', 'target_path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_folder',
      description: '创建目录（支持 "书签栏/父目录/新目录" 多级路径，缺失层级自动创建）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_bookmarks',
      description:
        '删除书签。一次删除超过 3 条会被拒绝——此时必须先把完整清单（标题+URL）展示给用户并明确请求回复"确认"后才再次调用',
      parameters: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' }, description: '书签 id 列表' } },
        required: ['ids'],
      },
    },
  },
];

// ---------- 工具执行 ----------

async function flattenAll(): Promise<FlatBookmark[]> {
  return flattenBookmarks(await getTreeDtos());
}

function findNodeById(nodes: TreeNodeDto[], id: string): TreeNodeDto | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (!node.url) {
      const hit = findNodeById(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

async function executeTool(
  settings: Settings,
  name: string,
  args: Record<string, unknown>,
  emit: AgentEmit,
): Promise<string> {
  switch (name) {
    case 'list_folders': {
      const paths = await listFolderPaths([], 300);
      return JSON.stringify({ folders: paths });
    }

    case 'list_bookmarks': {
      const folderPath = args.folder_path as string | undefined;
      const keyword = (args.keyword as string | undefined)?.toLowerCase();
      let items: FlatBookmark[];
      if (folderPath) {
        const parentId = await resolveFolderPath(folderPath).catch(() => null);
        if (!parentId) return JSON.stringify({ error: `目录不存在: ${folderPath}` });
        const children = await browser.bookmarks.getChildren(parentId);
        items = children
          .filter((c) => c.url)
          .map((c) => ({
            id: c.id, title: c.title, url: c.url!, parentId, folderPath,
            dateAdded: c.dateAdded,
          }));
      } else {
        items = await flattenAll();
      }
      if (keyword) {
        items = items.filter(
          (b) => b.title.toLowerCase().includes(keyword) || b.url.toLowerCase().includes(keyword),
        );
      }
      const total = items.length;
      const trimmed = items.slice(0, 50).map((b) => ({
        id: b.id, title: b.title, url: b.url.length > 80 ? b.url.slice(0, 80) + '…' : b.url, folder: b.folderPath,
      }));
      return JSON.stringify({ total, returned: trimmed.length, bookmarks: trimmed });
    }

    case 'search_bookmarks': {
      const results = await searchBookmarks(settings, (args.query as string) ?? '');
      return JSON.stringify({
        total: results.length,
        bookmarks: results.slice(0, 30).map((r) => ({
          id: r.bookmarkId, title: r.title, url: r.url, folder: r.folderPath, summary: r.summary,
        })),
      });
    }

    case 'rename_bookmarks': {
      const items = (args.items as Array<{ id: string; new_title: string }>) ?? [];
      let ok = 0;
      const failed: string[] = [];
      for (const item of items) {
        try {
          await browser.bookmarks.update(item.id, { title: item.new_title });
          const meta = await getMeta(item.id);
          if (meta) await putMeta({ ...meta, title: item.new_title, updatedAt: Date.now() });
          ok++;
        } catch {
          failed.push(item.id);
        }
      }
      invalidateSearchIndex();
      await bumpLibraryVersion();
      const detail = `重命名 ${ok}/${items.length} 条`;
      emit({ type: 'tool', name: 'rename_bookmarks', detail });
      return JSON.stringify({ ok, failed });
    }

    case 'move_bookmarks': {
      const ids = (args.ids as string[]) ?? [];
      const targetPath = (args.target_path as string) ?? '';
      const parentId = await resolveFolderPath(targetPath);
      let ok = 0;
      for (const id of ids) {
        try {
          await browser.bookmarks.move(id, { parentId });
          const meta = await getMeta(id);
          if (meta) {
            await putMeta({
              ...meta,
              folderPath: targetPath,
              // 目录变了，若之前是 AI 收藏体系下的路径记录需更新；向量仍有效（内容未变）
              updatedAt: Date.now(),
            });
          }
          ok++;
        } catch {
          /* 单条失败继续 */
        }
      }
      invalidateSearchIndex();
      await bumpLibraryVersion();
      const detail = `移动 ${ok}/${ids.length} 条 → ${targetPath}`;
      emit({ type: 'tool', name: 'move_bookmarks', detail });
      return JSON.stringify({ ok, target: targetPath });
    }

    case 'create_folder': {
      const path = (args.path as string) ?? '';
      await resolveFolderPath(path);
      await bumpLibraryVersion();
      const detail = `创建目录 ${path}`;
      emit({ type: 'tool', name: 'create_folder', detail });
      return JSON.stringify({ ok: true, path });
    }

    case 'delete_bookmarks': {
      const ids = (args.ids as string[]) ?? [];
      if (ids.length > DELETE_CONFIRM_THRESHOLD) {
        // 大批量删除：拒绝执行，把清单交还给助手向用户请求确认
        const all = await flattenAll();
        const list = ids
          .map((id) => all.find((b) => b.id === id))
          .filter(Boolean)
          .map((b) => `  - ${(b as FlatBookmark).title} (${(b as FlatBookmark).url})`)
          .join('\n');
        return JSON.stringify({
          refused: true,
          reason: `一次删除 ${ids.length} 条超过上限 ${DELETE_CONFIRM_THRESHOLD} 条。请先把以下清单完整展示给用户，明确请求用户回复"确认删除"后，再用相同 ids 重新调用本工具：\n${list}`,
        });
      }
      let ok = 0;
      for (const id of ids) {
        try {
          const node = (await browser.bookmarks.get(id).catch(() => []))[0];
          if (!node) continue;
          await browser.bookmarks.remove(id);
          await deleteMeta(id);
          ok++;
        } catch {
          /* 已不存在 */
        }
      }
      invalidateSearchIndex();
      await bumpLibraryVersion();
      const detail = `删除 ${ok}/${ids.length} 条`;
      emit({ type: 'tool', name: 'delete_bookmarks', detail });
      return JSON.stringify({ ok });
    }

    default:
      return JSON.stringify({ error: `未知工具: ${name}` });
  }
}

// ---------- 系统提示词 ----------

function systemPrompt(settings: Settings): string {
  const lang = settings.preferences.language === 'en' ? 'English' : settings.preferences.language === 'ja' ? '日本語' : '中文';
  return [
    '你是浏览器扩展 AutoBookmark 的书签库管理助手，可以调用工具查看和操作用户的书签。',
    `始终用${lang}回复。`,
    '规则：',
    '1. 操作前先用 list_folders / list_bookmarks / search_bookmarks 获取事实，不要凭空猜 id。',
    '2. 重命名/移动前如果方案有多种可能，先简要说明你的方案再执行。',
    '3. delete_bookmarks 一次最多删 3 条；更多时工具会拒绝——把完整清单展示给用户并请求回复"确认删除"。',
    '4. 所有操作完成后，用简短的清单向用户汇报改了什么（几条重命名/移动/删除，落到哪个目录）。',
    '5. 与书签操作无关的问题，直接回答，不要调用工具。',
  ].join('\n');
}

// ---------- Agent 循环 ----------

export interface AgentTurnResult {
  /** 追加到会话历史的全部新消息（assistant/tool），UI 需持久化 */
  newMessages: ChatMessage[];
}

/**
 * 无状态 agent 轮次：history = 完整会话（含之前的 tool 消息）。
 * 追加用户最新消息后循环调用模型，执行工具，直到产出最终回复。
 */
export async function runAgentTurn(
  settings: Settings,
  history: ChatMessage[],
  emit: AgentEmit,
): Promise<AgentTurnResult> {
  const { provider, model, providerId } = resolveBinding(settings, 'agent');
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(settings) }, ...history];
  const newMessages: ChatMessage[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await provider.chat({
        model,
        messages,
        tools: toolSchemas,
        temperature: 0.3,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      if (e instanceof AiClientError && /tools|function/i.test(e.detail ?? '')) {
        throw new Error(rt('err.noFunctionCalling'));
      }
      throw e;
    }
    await trackUsage(providerId, response.usage);

    const assistantMsg = response.message;
    if (!assistantMsg) break;

    if (!assistantMsg.tool_calls?.length) {
      // 最终回复
      const finalMsg: ChatMessage = { role: 'assistant', content: assistantMsg.content ?? '' };
      messages.push(finalMsg);
      newMessages.push(finalMsg);
      return { newMessages };
    }

    // 记录 assistant 的 tool_calls 消息并逐个执行
    const msgWithCalls: ChatMessage = {
      role: 'assistant',
      content: assistantMsg.content ?? '',
      tool_calls: assistantMsg.tool_calls,
    };
    messages.push(msgWithCalls);
    newMessages.push(msgWithCalls);

    for (const call of assistantMsg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      emit({ type: 'tool', name: call.function.name, detail: rt('agent.running') });
      let result: string;
      try {
        result = await executeTool(settings, call.function.name, args, emit);
      } catch (e) {
        result = JSON.stringify({ error: (e as Error).message });
      }
      const toolMsg: ChatMessage = {
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      };
      messages.push(toolMsg);
      newMessages.push(toolMsg);
    }
  }

  const limitMsg: ChatMessage = {
    role: 'assistant',
    content: rt('agent.limitReached'),
  };
  messages.push(limitMsg);
  newMessages.push(limitMsg);
  return { newMessages };
}


