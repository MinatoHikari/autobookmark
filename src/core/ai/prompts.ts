import type { ChatMessage } from '../providers/client';
import type { PageContent } from '../../shared/types';

const LANG_LABEL: Record<string, string> = { zh: '中文', ja: '日本語', en: 'English' };

export function buildEnhanceMessages(
  page: PageContent,
  opts: { language: 'zh' | 'ja' | 'en'; maxContentChars: number; existingFolders?: string[] },
): ChatMessage[] {
  const lang = LANG_LABEL[opts.language] ?? '中文';
  const system = [
    '你是书签整理助手。根据网页信息为这条书签生成元数据，要求：',
    `- title：简洁准确的书签标题（不超过 40 字），去除营销词与站点名冗余，用${lang}；若原标题已是${lang}且合适则沿用`,
    `- summary：一句话概括页面核心内容（不超过 80 字，${lang}）`,
    '- tags：3~5 个标签，小写英文或通用' + lang + '短词，覆盖主题与技术点，不要 # 号',
  ];
  if (opts.existingFolders?.length) {
    system.push(
      '- folder：这本新书签的目标存放目录。优先从下面的已有目录列表中选一个最合适的，必须一字不差地输出该完整路径；',
      '  确实都不合适时，选语义上最接近的已有目录，并在其后追加 "/新子目录名"（新子目录要简短、2~8 字）。',
      '已有目录列表：',
      ...opts.existingFolders.map((p) => `  ${p}`),
    );
  } else {
    system.push(
      `- folder：一个分类文件夹名（2~8 字，${lang}），如 "前端开发"、"AI"、"产品设计"、"论文"、"工具"`,
    );
  }
  system.push(
    '只输出一个 JSON 对象，不要输出任何其他文字。格式：',
    '{"title": "...", "summary": "...", "tags": ["..."], "folder": "..."}',
  );
  const systemText = system.join('\n');

  let content = page.content?.trim() ?? '';
  if (content.length < 80 && page.selection.trim().length > 40) {
    content = page.selection.trim();
  }
  if (!content) content = page.excerpt || '（无正文，请根据标题和 URL 推断）';
  if (content.length > opts.maxContentChars) {
    content = content.slice(0, opts.maxContentChars) + '\n…（正文已截断）';
  }

  const user = [
    `URL: ${page.url}`,
    `站点: ${page.siteName}`,
    `原标题: ${page.title}`,
    page.byline ? `作者: ${page.byline}` : '',
    page.excerpt ? `页面描述: ${page.excerpt}` : '',
    '--- 正文（Markdown）---',
    content,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: systemText },
    { role: 'user', content: user },
  ];
}

export function buildTldrMessages(
  page: PageContent,
  opts: { language: 'zh' | 'ja' | 'en'; maxContentChars: number },
): ChatMessage[] {
  const lang = LANG_LABEL[opts.language] ?? '中文';
  const system = [
    `用${lang}为网页生成 TL;DR：3~5 条要点，每条一句话，以 "- " 开头的列表输出。`,
    '直接输出要点列表，不要标题、不要总结段、不要客套话。',
  ].join('\n');

  let content = page.content?.trim() ?? '';
  if (content.length < 80 && page.selection.trim().length > 40) {
    content = page.selection.trim();
  }
  if (!content) {
    throw new Error('此页面没有可总结的正文，请先选中一段文字再试');
  }
  if (content.length > opts.maxContentChars) {
    content = content.slice(0, opts.maxContentChars) + '\n…（正文已截断）';
  }

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `URL: ${page.url}\n标题: ${page.title}\n---\n${content}`,
    },
  ];
}

// ---- 整理中心（批量任务）prompts ----

export interface BatchItem {
  i: number;
  title: string;
  url: string;
  /** 可选的正文摘录（整理时抓取），显著提升摘要质量 */
  excerpt?: string;
}

function itemList(items: BatchItem[]): string {
  return items
    .map((x) => `[${x.i}] ${x.title}\n    ${x.url}${x.excerpt ? `\n    摘录: ${x.excerpt}` : ''}`)
    .join('\n');
}

/** 批量补全元数据：每批一批书签（标题+URL）→ JSON 数量 */
export function buildBatchEnhanceMessages(
  items: BatchItem[],
  opts: { language: 'zh' | 'ja' | 'en' },
): ChatMessage[] {
  const lang = LANG_LABEL[opts.language] ?? '中文';
  const system = [
    '你是书签整理助手。为下列每条书签生成元数据，要求：',
    `- title：规范化标题（≤40 字，去除营销词与站点名冗余，${lang}；信息不足时基于标题和域名合理推断）`,
    `- summary：一句话概括（≤60 字，${lang}；只根据标题与 URL 域名推断主题，不要编造细节）`,
    '- tags：2~4 个标签，小写英文或通用中文短词',
    '只输出 JSON 对象，格式：{"items": [{"i": 0, "title": "...", "summary": "...", "tags": ["..."]}, ...]}，i 与输入对应，一条都不能少。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: itemList(items) },
  ];
}

/** 聚类：一批书签 → 本批建议的类目名；maxDepth≥2 时类目为 "/" 分隔的多级路径 */
export function buildClusterMessages(items: BatchItem[], maxDepth = 1): ChatMessage[] {
  const depthLine =
    maxDepth >= 2
      ? [
          `类目为最多 ${maxDepth} 级的路径，用 "/" 分隔（如 "开发/前端"、"AI/论文"），也可只给一级（如 "工具"）。`,
          '每段：中文、2~6 字；同级类目互不重叠，子类目只挂在语义最贴近的父类目下。',
        ]
      : ['类目名要求：中文、2~6 字、通用且可扩展（如 "前端开发"、"AI"、"设计"、"产品"、"工具"、"阅读"、"购物"、"社交"）。'];
  const system = [
    '你是书签整理师。把下列书签按主题聚类，给出 3~8 个类目名。',
    ...depthLine,
    '只输出 JSON：{"categories": ["...", "..."]}',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: itemList(items) },
  ];
}

/** 归类：一批书签 + 已有类目 → 每条的归属 */
export function buildAssignMessages(
  items: BatchItem[],
  categories: string[],
): ChatMessage[] {
  const system = [
    '你是书签整理师。把下列每条书签归入最合适的一个类目。',
    `可选类目：${categories.join('、')}。都不合适时用 "未定"。`,
    '只输出 JSON：{"assignments": [{"i": 0, "category": "..."}, ...]}，i 与输入对应，一条都不能少。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: itemList(items) },
  ];
}

/** 去重确认：一组疑似重复的书签 → 是否真的重复 */
export function buildDupConfirmMessages(items: BatchItem[]): ChatMessage[] {
  const system = [
    '判断下列书签是否指向同一内容（同一文章/站点的不同 URL、镜像、转载等算重复；仅主题相似不算）。',
    '只输出 JSON：{"duplicates": true} 或 {"duplicates": false}',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: itemList(items) },
  ];
}
