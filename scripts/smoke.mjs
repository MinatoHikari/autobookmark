/**
 * 端到端冒烟测试：
 * 1. 本地 mock OpenAI 兼容 server（无需真实 API Key）
 * 2. 用 Playwright 缓存的 Chrome for Testing 加载构建产物
 * 3. 验证：三个 UI 挂载、消息路由、saveBookmark 全链路、
 *    整理中心（批量增强 / 自动分类+撤销 / 去重 / 死链）全链路
 * 用法：pnpm build && node scripts/smoke.mjs
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { realpathSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const extPath = realpathSync(join(projectRoot, '.output/chrome-mv3'));

// ---------- mock OpenAI 兼容 server ----------
const requests = [];
const mockServer = await startMockServer(0);
const MOCK_BASE = `http://127.0.0.1:${mockServer.port}/v1`;

function chatResponse(content) {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
}

function handleChat(body) {
  const system = body.messages?.[0]?.content ?? '';
  const user = body.messages?.at(-1)?.content ?? '';

  if (system.includes('为下列每条书签生成元数据')) {
    // 批量增强：解析 "[i] title" 行
    const items = [...user.matchAll(/\[(\d+)\] (.+)/g)].map((m) => ({
      i: Number(m[1]),
      title: `增强·${m[2].trim()}`,
      summary: `这是 ${m[2].trim()} 的 AI 摘要`,
      tags: ['mock', '测试'],
    }));
    return chatResponse(JSON.stringify({ items }));
  }
  if (system.includes('按主题聚类')) {
    return chatResponse(JSON.stringify({ categories: ['mock 分类一', 'mock 分类二'] }));
  }
  if (system.includes('归入最合适的一个类目')) {
    const catsMatch = system.match(/可选类目：(.+?)。/);
    // 只在真实类目间轮转（「未定」是兜底项，不该被主动选中）
    const real = (catsMatch?.[1] ?? '').split('、').filter((c) => c && c !== '未定');
    const items = [...user.matchAll(/\[(\d+)\] /g)].map((m, idx) => ({
      i: Number(m[1]),
      category: real[idx % real.length] ?? '未定',
    }));
    return chatResponse(JSON.stringify({ assignments: items }));
  }
  if (system.includes('是否指向同一内容')) {
    // 按提取到的 URL 判断：全部相同才算重复
    const urls = [...user.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].trim());
    const allSame = urls.length > 1 && urls.every((u) => u === urls[0]);
    return chatResponse(JSON.stringify({ duplicates: allSame }));
  }
  // agent：tools 请求 → 脚本化工具调用循环
  if (body.tools?.length) {
    const toolResults = body.messages.filter((m) => m.role === 'tool');
    const last = toolResults.at(-1);
    if (!last) {
      // 第一步：列出书签
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list_bookmarks', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    }
    const lastContent = String(last.content ?? '');
    if (lastContent.includes('list_bookmarks') || !lastContent.includes('已重命名')) {
      if (!lastContent.startsWith('{"ok"')) {
        // 第二步：从 list 结果里取第一条做重命名
        try {
          const parsed = JSON.parse(lastContent);
          const first = parsed.bookmarks?.[0];
          if (first) {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'call-2',
                    type: 'function',
                    function: {
                      name: 'rename_bookmarks',
                      arguments: JSON.stringify({ items: [{ id: first.id, new_title: `【游戏】${first.title}` }] }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            };
          }
        } catch { /* fallthrough */ }
      }
    }
    // 第三步：总结
    return chatResponse('已完成：重命名 1 条书签，加上了【游戏】前缀。');
  }

  // 单条收藏 enhance
  return chatResponse(
    JSON.stringify({ title: 'Mock 书签标题', summary: 'Mock 摘要', tags: ['mock'], folder: 'mock 文件夹' }),
  );
}

async function startMockServer(port) {
  const server = createServer((req, res) => {
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };

    if (req.method === 'OPTIONS') return send(204, '');

    const url = new URL(req.url ?? '/', `http://127.0.0.1`);

    // 死链测试目标
    if (url.pathname.startsWith('/dead/')) return send(404, 'not found', 'text/plain');
    if (url.pathname.startsWith('/hang/')) return; // 挂起不响应，等客户端 10s 超时
    if (url.pathname.startsWith('/ok/')) return send(200, '<html><body>ok</body></html>', 'text/html');

    if (url.pathname === '/v1/models') {
      return send(200, { data: [{ id: 'mock-model' }] });
    }

    if (url.pathname.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests.push({ path: url.pathname, body: body.slice(0, 200) });
        try {
          send(200, handleChat(JSON.parse(body)));
        } catch (e) {
          send(500, { error: { message: String(e) } });
        }
      });
      return;
    }

    if (url.pathname.endsWith('/embeddings')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const input = JSON.parse(body).input ?? [];
        // 同一文本给同一向量，不同文本给正交向量；用于语义去重可控测试
        const data = input.map((text, index) => ({
          index,
          embedding: String(text).includes('dup') ? [1, 0] : [0, 1],
        }));
        send(200, { data });
      });
      return;
    }

    send(404, { error: { message: `mock: no route ${url.pathname}` } });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

// ---------- 浏览器 ----------
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
function findPlaywrightChrome() {
  const dir = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(dir)) return null;
  for (const build of readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    for (const candidate of [
      `${dir}/${build}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${dir}/${build}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
      `${dir}/${build}/chrome-linux/chrome`,
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
const chromeExecutable = findPlaywrightChrome() ?? CHROME_CANDIDATES.find(existsSync);
if (!chromeExecutable) throw new Error('未找到可用的 Chrome/Chromium');

const browser = await puppeteer.launch({
  executablePath: chromeExecutable,
  headless: 'new',
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const errors = [];

// @webext-core/messaging wire 协议帮助函数（在扩展页面里执行）
const send = (type, data) => `
  (async () => {
    const res = await chrome.runtime.sendMessage({ type: ${JSON.stringify(type)}, timestamp: Date.now(), data: ${JSON.stringify(data)} });
    if (res && typeof res === 'object' && 'err' in res) throw new Error(String(res.err?.message ?? res.err));
    return res?.res ?? res;
  })()`;

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 15_000 },
  );
  const extensionId = new URL(swTarget.url()).host;
  console.log(`[smoke] extension ${extensionId}，mock provider ${MOCK_BASE}`);

  async function withPage(fn) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    const result = await fn(page);
    await page.close();
    return result;
  }

  // 2. 三页挂载
  for (const entry of ['popup.html', 'options.html', 'manager.html']) {
    await withPage(async (page) => {
      await page.goto(`chrome-extension://${extensionId}/${entry}`, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 500));
      const state = await page.evaluate(() => ({
        hasApp: !!document.querySelector('#app')?.children.length,
      }));
      if (!state.hasApp) errors.push(`${entry}: Vue app 未挂载`);
      console.log(`[smoke] ${entry} 挂载 ${state.hasApp ? '✓' : '✗'}`);
    });
  }

  // 3. 预置书签：两个旧文件夹(各3条) + 1 条精确重复 + 2 条死链
  const seeded = await withPage(async (page) => {
    const result = await page.evaluate(`
      (async () => {
        const mk = (parentId, title, url) => chrome.bookmarks.create({ parentId, title, url });
        const other = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '2');
        const folderA = await chrome.bookmarks.create({ parentId: other.id, title: '旧分类A' });
        const folderB = await chrome.bookmarks.create({ parentId: other.id, title: '旧分类B' });
        const a1 = await mk(folderA.id, '文章 alpha', 'http://127.0.0.1:${mockServer.port}/ok/a1');
        const a2 = await mk(folderA.id, '文章 beta', 'http://127.0.0.1:${mockServer.port}/ok/a2');
        const a3 = await mk(folderA.id, '文章 gamma', 'http://127.0.0.1:${mockServer.port}/ok/a3');
        const b1 = await mk(folderB.id, '文档 dup one', 'http://127.0.0.1:${mockServer.port}/ok/dup1');
        const b2 = await mk(folderB.id, '文档 dup two', 'http://127.0.0.1:${mockServer.port}/ok/dup2');
        const dupExact = await mk(folderB.id, '文章 beta 副本', 'http://127.0.0.1:${mockServer.port}/ok/a2');
        const dead1 = await mk(folderB.id, '死链一', 'http://127.0.0.1:${mockServer.port}/dead/1');
        const dead2 = await mk(folderB.id, '死链二', 'http://127.0.0.1:${mockServer.port}/dead/2');
        return { otherId: other.id, folderA: folderA.id, ids: [a1.id, a2.id, a3.id, b1.id, b2.id, dupExact.id, dead1.id, dead2.id], betaId: a2.id, dupExactId: dupExact.id, dead1: dead1.id, dead2: dead2.id };
      })()`);
    return result;
  });
  console.log(`[smoke] 预置 ${seeded.ids.length} 条书签 ✓`);
  console.log(`[smoke] 预置 ${seeded.ids.length} 条书签 ✓`);

  // 3.4 旧格式设置迁移：写入 v0.3.0 形状的设置 → 加载并保存不应报错，且新字段自动补齐
  await withPage(async (page) => {
    await page.evaluate(() =>
      chrome.storage.local.set({
        settings: {
          version: 1,
          providers: [],
          bindings: { enhance: null, tldr: null, embedding: null },
          preferences: {
            rootFolder: 'AI 收藏', autoFolder: true, language: 'zh',
            maxContentChars: 8000, contextMenuEnabled: true, notifications: true,
          },
        },
      }),
    );
    const migrated = await page.evaluate(`(async () => {
      const res = await chrome.runtime.sendMessage({ type: 'saveSettings', timestamp: Date.now(), data: await chrome.runtime.sendMessage({ type: 'getSettings', timestamp: Date.now() }).then(r => r.res ?? r) });
      if (res && 'err' in res) throw new Error(String(res.err?.message ?? res.err));
      return res?.res ?? res;
    })()`);
    const okMigrated =
      migrated?.bindings && 'agent' in migrated.bindings && 'saveStrategy' in migrated.preferences;
    console.log(`[smoke] 旧设置迁移: ${okMigrated ? '✓' : '✗'}`);
    if (!okMigrated) errors.push('旧格式设置迁移失败（缺少新字段或保存报错）');
  });

  // 3.5 未配置供应商：树浏览 / 右键编辑保存 / 删除 全部可用
  await withPage(async (page) => {
    await page.evaluate(`chrome.bookmarks.create({ parentId: '1', title: '零供应商测试书签', url: 'http://127.0.0.1:${mockServer.port}/ok/zeroprovider' })`);
  });
  const pp0 = await browser.newPage();
  await pp0.setViewport({ width: 660, height: 600 });
  await pp0.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  const t0 = await pp0.evaluate(() => document.body.innerText);
  const treeOk0 = t0.includes('书签栏') && t0.includes('零供应商测试书签');
  console.log(`[smoke] 零供应商树浏览: ${treeOk0 ? '✓' : '✗'}`);
  if (!treeOk0) errors.push('未配置供应商时树未渲染');

  await pp0.evaluate(() => {
    const row = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('零供应商测试书签'));
    if (!row) throw new Error('未找到书签行');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 200 }));
  });
  await new Promise((r) => setTimeout(r, 200));
  await pp0.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('编辑'));
    if (!btn) throw new Error('菜单中未找到编辑项');
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const dialogOk0 = await pp0.evaluate(() =>
    document.body.innerText.includes('编辑书签') && document.body.innerText.includes('未增强'),
  );
  await pp0.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '保存');
    if (!btn) throw new Error('未找到保存按钮');
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  const metaOk0 = await pp0.evaluate(`(async () => {
    const [node] = await chrome.bookmarks.search({ title: '零供应商测试书签' });
    const { tree, metaById } = await chrome.runtime.sendMessage({ type: 'getBookmarksTree', timestamp: Date.now() }).then(r => r.res ?? r);
    return !!(tree && metaById[node.id]);
  })()`);
  console.log(`[smoke] 零供应商编辑保存: 弹窗=${dialogOk0 ? '✓' : '✗'} 元数据=${metaOk0 ? '✓' : '✗'}`);
  if (!dialogOk0) errors.push('零供应商编辑弹窗未出现');
  if (!metaOk0) errors.push('零供应商编辑保存失败');

  await pp0.evaluate(() => {
    const row = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('零供应商测试书签'));
    if (!row) throw new Error('行消失了');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 300 }));
  });
  await new Promise((r) => setTimeout(r, 200));
  await pp0.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (el) => el.textContent?.includes('删除') && !el.textContent.includes('确认'),
    );
    if (!btn) throw new Error('菜单中未找到删除项');
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  await pp0.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '确认删除');
    if (!btn) throw new Error('未找到确认删除按钮');
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  const gone0 = await pp0.evaluate(`chrome.bookmarks.search({ title: '零供应商测试书签' }).then(r => r.length === 0)`);
  console.log(`[smoke] 零供应商删除: ${gone0 ? '✓' : '✗'}`);
  if (!gone0) errors.push('零供应商删除失败');

  // 普通收藏：默认落点 + 手动路径
  const plain1 = await pp0.evaluate(send('savePlainBookmark', {
    url: `http://127.0.0.1:${mockServer.port}/ok/plain-default`, title: '普通收藏·默认落点',
  }));
  const plain2 = await pp0.evaluate(send('savePlainBookmark', {
    url: `http://127.0.0.1:${mockServer.port}/ok/plain-manual`, title: '普通收藏·手动路径', folderPath: '书签栏',
  }));
  const p1node = await pp0.evaluate(`chrome.bookmarks.get(${JSON.stringify(plain1.bookmarkId)}).then(r => r[0])`);
  const p1parent = await pp0.evaluate(`chrome.bookmarks.get(${JSON.stringify(p1node.parentId)}).then(r => r[0])`);
  const p2parent = await pp0.evaluate(`chrome.bookmarks.get(${JSON.stringify(plain2.bookmarkId)}).then(r => r[0]).then(async n => (await chrome.bookmarks.get(n.parentId))[0])`);
  console.log(`[smoke] 普通收藏: 默认→${p1parent.title} 手动→${p2parent.title} 元数据=${plain1.summary !== undefined ? '✓' : '✗'}`);
  if (p1parent.title !== 'AI 收藏') errors.push(`普通收藏默认落点错误: ${p1parent.title}`);
  if (p2parent.title !== '书签栏') errors.push(`手动路径落点错误: ${p2parent.title}`);
  await pp0.close();



  // 1. 配置 mock 供应商
  await withPage(async (page) => {
    const settings = await page.evaluate(send('getSettings'));
    settings.providers.push({
      id: 'mock-provider',
      presetId: null,
      name: 'Mock 供应商',
      baseURL: MOCK_BASE,
      apiKey: 'sk-mock',
      models: ['mock-model'],
      embeddingModels: ['mock-model'],
    });
    settings.bindings.enhance = { providerId: 'mock-provider', model: 'mock-model' };
    settings.bindings.tldr = { providerId: 'mock-provider', model: 'mock-model' };
    settings.bindings.embedding = { providerId: 'mock-provider', model: 'mock-model' };
    settings.bindings.agent = { providerId: 'mock-provider', model: 'mock-model' };
    await page.evaluate(send('saveSettings', settings));
    console.log('[smoke] mock 供应商已配置 ✓');
  });

  // 4. 树消息
  await withPage(async (page) => {
    const { tree, metaById } = await page.evaluate(send('getBookmarksTree'));
    const total = JSON.stringify(tree).match(/"url"/g)?.length ?? 0;
    console.log(`[smoke] getBookmarksTree: ${tree.length} 个根，共 ${total} 条书签 ✓`);
    if (total < seeded.ids.length) errors.push('书签树数量不对');
  });

  // 5. 批量增强 job
  await withPage(async (page) => {
    const jobId = await page.evaluate(send('startJob', { kind: 'enhance', params: { ids: seeded.ids.slice(0, 4), fetchContent: false } }));
    const job = await waitForJob(page, jobId, (j) => j.status === 'done', 30_000);
    const { metaById } = await page.evaluate(send('getBookmarksTree'));
    const enhancedCount = seeded.ids.slice(0, 4).filter((id) => metaById[id]).length;
    console.log(`[smoke] 批量增强 job: ${job.status}，增强 ${enhancedCount}/4 条 ✓`);
    if (job.status !== 'done' || enhancedCount !== 4) errors.push(`批量增强失败: ${job.status}/${enhancedCount}`);
  });

  // 5.5 存放策略 existing：路径落点 + 新子目录创建 + 版本号 bump
  await withPage(async (page) => {
    const settings = await page.evaluate(send('getSettings'));
    settings.preferences.saveStrategy = 'existing';
    await page.evaluate(send('saveSettings', settings));

    const before = await page.evaluate(() =>
      chrome.storage.local.get('libraryVersion').then((r) => r.libraryVersion ?? 0),
    );
    const meta = await page.evaluate(send('saveBookmark', {
      page: {
        url: 'https://example.com/strategy-test', title: '原标题', siteName: 'example.com',
        byline: '', excerpt: '', content: '', selection: '', extractedAt: Date.now(),
      },
      draft: { title: '策略测试书签', summary: '验证落点', tags: ['策略'], folder: '其他书签/旧分类A/策略子目录' },
    }));
    const node = await page.evaluate(`chrome.bookmarks.get(${JSON.stringify(meta.bookmarkId)}).then(r => r[0])`);
    const parent = await page.evaluate(`chrome.bookmarks.get(${JSON.stringify(node.parentId)}).then(r => r[0])`);
    const grandpa = await page.evaluate(`chrome.bookmarks.get(${JSON.stringify(parent.parentId)}).then(r => r[0])`);
    const located =
      grandpa.title === '旧分类A' && parent.title === '策略子目录' && node.url.includes('strategy-test');
    const after = await page.evaluate(() =>
      chrome.storage.local.get('libraryVersion').then((r) => r.libraryVersion ?? 0),
    );
    console.log(`[smoke] existing 策略落点: ${located ? '✓' : '✗'}（${grandpa.title}/${parent.title}） 版本bump: ${after > before ? '✓' : '✗'}`);
    if (!located) errors.push(`existing 策略落点错误: ${grandpa.title}/${parent.title}`);
    if (after <= before) errors.push('saveBookmark 未 bump libraryVersion');

    // 还原策略 + 清理
    const s2 = await page.evaluate(send('getSettings'));
    s2.preferences.saveStrategy = 'aiFolder';
    await page.evaluate(send('saveSettings', s2));
    await page.evaluate(send('deleteBookmark', meta.bookmarkId));
  });

  // 6. 自动分类 + 撤销
  await withPage(async (page) => {
    const before = await page.evaluate(send('getBookmarksTree'));
    const jobId = await page.evaluate(send('startJob', { kind: 'classify', params: { scope: 'other', maxCategories: 8 } }));
    const job = await waitForJob(page, jobId, (j) => j.status === 'done' || j.status === 'error', 60_000);
    console.log(`[smoke] 自动分类 job: ${job.status}，报告: ${job.result?.report?.join('；') ?? job.error ?? '-'}`);
    if (job.status !== 'done') errors.push(`自动分类失败: ${job.error}`);
    // sweep 必须真的删掉旧文件夹，否则下面的撤销恢复是空测（回归 old-folder-id 映射 bug）
    const swept = job.result?.report?.find((r) => r.includes('清理空文件夹')) ?? '';
    const sweptCount = Number(swept.match(/清理空文件夹 (\d+)/)?.[1] ?? 0);
    console.log(`[smoke] sweep 删除旧文件夹: ${sweptCount} 个`);
    if (sweptCount < 1) errors.push('sweep 未删除旧文件夹，撤销回归测试无效');

    const after = await page.evaluate(send('getBookmarksTree'));
    const beforeJson = JSON.stringify(sortTree(before.tree));
    const afterJson = JSON.stringify(sortTree(after.tree));
    if (beforeJson === afterJson) errors.push('自动分类没有产生任何移动');

    // 任务完成应有浏览器通知
    // 无头环境 getAll() 只返回 {id: true}，用 job- 前缀 id 断言通知已创建
    const notifs = await page.evaluate(() => chrome.notifications.getAll());
    const jobNotifs = Object.keys(notifs).filter((id) => id.startsWith('job-'));
    console.log(`[smoke] 任务完成通知: ${jobNotifs.length ? '✓' : '✗'}（${jobNotifs.length} 条）`);
    if (!jobNotifs.length) errors.push('任务完成未产生浏览器通知');

    const undone = await page.evaluate(send('undoJob', jobId));
    const restored = await page.evaluate(send('getBookmarksTree'));
    console.log(`[smoke] 撤销: ${undone ? '✓' : '✗'}，树恢复 ${JSON.stringify(sortTree(restored.tree)) === beforeJson ? '✓' : '✗'}`);
    if (!undone || JSON.stringify(sortTree(restored.tree)) !== beforeJson) {
      errors.push('撤销后书签树未恢复原状');
    }
  });

  // 6.5 备份：自动备份 + 手动备份 + HTML 导出 + 恢复
  await withPage(async (page) => {
    const backups = await page.evaluate(send('listBackups'));
    console.log(`[smoke] 自动备份数: ${backups.length}（分类任务自动创建）`);
    if (!backups.length) errors.push('整理任务未自动创建备份');

    const bid = await page.evaluate(send('createBackupNow', '测试手动备份'));
    const html = await page.evaluate(send('getBackupHtml', bid));
    if (!html.includes('NETSCAPE-Bookmark-file-1') || !html.includes('/ok/a1')) {
      errors.push('备份 HTML 导出异常');
    }

    // 恢复测试：删一条 → 恢复 → 验证回来
    const a1 = seeded.ids[0];
    await page.evaluate(`chrome.bookmarks.remove(${JSON.stringify(a1)})`);
    const ok = await page.evaluate(send('restoreBackup', bid));
    const after = await page.evaluate(send('getBookmarksTree'));
    const a1Back = JSON.stringify(after.tree).includes('/ok/a1');
    console.log(`[smoke] 备份恢复: ${ok && a1Back ? '✓ 删除的书签已恢复' : '✗'}`);
    if (!ok || !a1Back) errors.push('备份恢复失败');
  });

  // 7. 去重（精确重复 a2 vs dupExact）
  await withPage(async (page) => {
    const jobId = await page.evaluate(send('startJob', { kind: 'dedupe', params: {} }));
    const job = await waitForJob(page, jobId, (j) => j.status === 'awaiting-review' || j.status === 'done' || j.status === 'error', 30_000);
    const groups = job.result?.groups ?? [];
    console.log(`[smoke] 去重扫描: ${job.status}，${groups.length} 组待确认 ✓`);
    if (job.status !== 'awaiting-review' || !groups.length) errors.push(`去重扫描异常: ${job.status}`);

    const keepByGroup = {};
    for (const g of groups) keepByGroup[g.id] = g.items[0].bookmarkId; // 保留每组第一条
    await page.evaluate(send('resolveJob', { jobId, keepByGroup }));
    const after = await page.evaluate(send('getBookmarksTree'));
    const dupStillThere = JSON.stringify(after.tree).includes('/ok/a2') &&
      after.tree.some((root) => countUrl(root, '/ok/a2') > 1);
    console.log(`[smoke] 去重落地: 精确重复${dupStillThere ? '仍存在 ✗' : '已消除 ✓'}`);
    if (dupStillThere) errors.push('去重后精确重复仍存在');
  });

  // 8. 死链检测
  await withPage(async (page) => {
    const jobId = await page.evaluate(send('startJob', { kind: 'deadlink', params: {} }));
    const job = await waitForJob(page, jobId, (j) => j.status === 'awaiting-review' || j.status === 'done' || j.status === 'error', 60_000);
    const groups = job.result?.groups ?? [];
    console.log(`[smoke] 死链检测: ${job.status}，发现 ${groups.length} 条死链`);
    console.log('[smoke] checks:', JSON.stringify(job.params?.checks ?? []));
    if (!groups.some((g) => g.items[0].url.includes('/dead/'))) errors.push('死链检测未发现 /dead/ 链接');

    await page.evaluate(send('resolveJob', { jobId, removeIds: groups.map((g) => g.items[0].bookmarkId) }));
    const after = await page.evaluate(send('getBookmarksTree'));
    const deadLeft = JSON.stringify(after.tree).includes('/dead/');
    console.log(`[smoke] 死链清理: ${deadLeft ? '仍有残留 ✗' : '已清除 ✓'}`);
    if (deadLeft) errors.push('死链未清除');
  });

  // 8.5 取消后新任务不被阻塞 + 删除任务记录
  await withPage(async (page) => {
    // 启动死链任务后立刻取消
    const jobId1 = await page.evaluate(send('startJob', { kind: 'deadlink', params: {} }));
    await page.evaluate(send('cancelJob', jobId1));
    // 新任务必须能正常跑到完成（回归：僵尸任务阻塞队列）
    const jobId2 = await page.evaluate(send('startJob', { kind: 'deadlink', params: {} }));
    const job2 = await waitForJob(page, jobId2, (j) => j.status === 'awaiting-review' || j.status === 'done' || j.status === 'error', 60_000);
    console.log(`[smoke] 取消后新任务执行: ${job2.status} ✓`);
    if (job2.status === 'error') errors.push(`取消后新任务失败: ${job2.error}`);

    // 取消的任务 + 已完成任务都能删除
    await page.evaluate(send('resolveJob', { jobId: jobId2, removeIds: [] }));
    await page.evaluate(send('deleteJob', jobId1));
    await page.evaluate(send('deleteJob', jobId2));
    const jobs = await page.evaluate(send('getJobs'));
    const gone = !jobs.some((j) => j.id === jobId1 || j.id === jobId2);
    console.log(`[smoke] 任务删除: ${gone ? '✓' : '✗'}`);
    if (!gone) errors.push('任务删除失败');

    // 删除进行中任务应报错：/hang 书签让死链任务确定性地跑满 10s
    await page.evaluate(`(async () => {
      const other = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '2');
      const folderA = other.children.find((c) => c.title === '旧分类A') ?? (await chrome.bookmarks.create({ parentId: other.id, title: '旧分类A' }));
      await chrome.bookmarks.create({ parentId: folderA.id, title: '挂起链接', url: 'http://127.0.0.1:${mockServer.port}/hang/1' });
    })()`);
    const jobId3 = await page.evaluate(send('startJob', { kind: 'deadlink', params: {} }));
    await new Promise((r) => setTimeout(r, 500));
    let rejected = false;
    try {
      await page.evaluate(send('deleteJob', jobId3));
    } catch {
      rejected = true;
    }
    console.log(`[smoke] 进行中任务拒绝删除: ${rejected ? '✓' : '✗'}`);
    if (!rejected) errors.push('进行中任务未被拒绝删除');
    await page.evaluate(send('cancelJob', jobId3));
    await new Promise((r) => setTimeout(r, 11_000)); // 等挂起的 fetch 超时，批次收尾
    await page.evaluate(send('deleteJob', jobId3));
  });

  // 8.6 对话 agent：自然语言批量重命名
  {
    const mp3 = await browser.newPage();
    await mp3.goto(`chrome-extension://${extensionId}/manager.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 600));
    await mp3.evaluate(() => {
      const tab = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('助手'));
      if (!tab) throw new Error('未找到助手标签');
      tab.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    await mp3.evaluate(() => {
      const ta = document.querySelector('textarea');
      if (!ta) throw new Error('未找到输入框');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '把第一本书签重命名，加上【游戏】前缀');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await mp3.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('发送'));
      if (!btn) throw new Error('未找到发送按钮，按钮列表: ' + [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).join('|').slice(0, 300));
      btn.click();
    });
    let renamed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      renamed = await mp3.evaluate(`chrome.bookmarks.search('【游戏】').then(r => r.length > 0)`);
      if (renamed) break;
    }
    const chatText = await mp3.evaluate(() => document.body.innerText);
    const replied = chatText.includes('重命名 1 条');
    console.log(`[smoke] 对话 agent: 重命名=${renamed ? '✓' : '✗'} 回复=${replied ? '✓' : '✗'}`);
    if (!renamed) errors.push('agent 未执行重命名');
    if (!replied) errors.push('agent 未给出总结回复');

    // 切到设置 → 任务绑定：应出现「对话助手」绑定行
    await mp3.evaluate(() => {
      [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('⚙ 设置'))?.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    await mp3.evaluate(() => {
      [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '任务绑定')?.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const settingsText = await mp3.evaluate(() => document.body.innerText);
    const bindingRow = settingsText.includes('对话助手');
    console.log(`[smoke] 设置任务绑定含对话助手: ${bindingRow ? '✓' : '✗'}`);
    if (!bindingRow) errors.push('任务绑定缺少对话助手行');

    // 保存设置回归：任务绑定页点保存 → 应出现"已保存"
    mp3.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[设置页 console.error]', msg.text().slice(0, 200));
    });
    await mp3.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '保存设置');
      if (!btn) throw new Error('未找到保存设置按钮');
      btn.click();
    });
    await new Promise((r) => setTimeout(r, 800));
    const savedShown = await mp3.evaluate(() => document.body.innerText.includes('已保存'));
    console.log(`[smoke] 设置保存: ${savedShown ? '✓' : '✗'}`);
    if (!savedShown) errors.push('设置保存失败（未出现已保存提示）');

    // 切回助手：对话从 storage.local 恢复
    await mp3.evaluate(() => {
      [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('🤖 助手'))?.click();
    });
    await new Promise((r) => setTimeout(r, 1000));
    const persisted = await mp3.evaluate(() => document.body.innerText.includes('把第一本书签重命名'));
    console.log(`[smoke] 对话持久化（切 tab 不丢）: ${persisted ? '✓' : '✗'}`);
    if (!persisted) {
      const t = await mp3.evaluate(() => document.body.innerText.slice(0, 400));
      console.log('[smoke] 助手页文本:', JSON.stringify(t));
      errors.push('切换 tab 后对话内容丢失');
    }

    // 输入框草稿：切 tab 后保留
    await mp3.evaluate(() => {
      const ta = document.querySelector('textarea');
      if (!ta) throw new Error('未找到输入框');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '这是一条未发送的草稿');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await mp3.evaluate(() => {
      [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('⚙ 设置'))?.click();
    });
    await new Promise((r) => setTimeout(r, 200));
    await mp3.evaluate(() => {
      [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('🤖 助手'))?.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    const draftKept = await mp3.evaluate(() => document.querySelector('textarea')?.value ?? '');
    console.log(`[smoke] 输入草稿保留: ${draftKept ? '✓' : '✗'}`);
    if (draftKept !== '这是一条未发送的草稿') errors.push('切换 tab 后输入草稿丢失');
    await mp3.close();
  }

  // 9. openManager
  await withPage(async (page) => {
    const ok = await page.evaluate(send('openManager', ''));
    await new Promise((r) => setTimeout(r, 800));
    const tabs = await browser.pages();
    const managerOpen = tabs.some((t) => t.url().includes('manager.html'));
    console.log(`[smoke] openManager: ${ok && managerOpen ? '✓' : '✗'}`);
    if (!ok || !managerOpen) errors.push('openManager 未打开管理页');

    // manager.html?panel=settings 应直接渲染设置视图（tab + 供应商卡）
    const sp = await browser.newPage();
    await sp.goto(`chrome-extension://${extensionId}/manager.html?panel=settings`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 500));
    const st = await sp.evaluate(() => document.body.innerText);
    const settingsOk = st.includes('设置') && st.includes('添加供应商');
    console.log(`[smoke] manager 设置视图: ${settingsOk ? '✓' : '✗'}`);
    if (!settingsOk) errors.push('manager.html?panel=settings 未渲染设置视图');
    await sp.close();

    // 树中书签双击 → 新标签页打开（根级书签默认可见）
    await withPage(async (page) => {
      await page.evaluate(`chrome.bookmarks.create({ parentId: '1', title: '双击测试书签', url: 'http://127.0.0.1:${mockServer.port}/ok/dblclick' })`);
    });
    const mp2 = await browser.newPage();
    await mp2.goto(`chrome-extension://${extensionId}/manager.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 600));
    mp2.on('console', (msg) => console.log('[manager console]', msg.type(), msg.text()));
    await mp2.evaluate(() => {
      const rows = [...document.querySelectorAll('div.cursor-pointer')];
      const row = rows.find((el) => el.textContent?.includes('双击测试书签'));
      if (!row) throw new Error('树中未找到书签行（双击测试书签）');
      row.scrollIntoView();
      row.setAttribute('data-dbl-test', '1');
      window.__dbl = 0;
      window.__click = 0;
      row.addEventListener('dblclick', () => window.__dbl++);
      row.addEventListener('click', () => window.__click++);
    });
    const handle = await mp2.waitForSelector('[data-dbl-test]');
    const box = await handle.boundingBox();
    await mp2.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2, delay: 30 });
    const counts = await mp2.evaluate(() => ({ dbl: window.__dbl, click: window.__click }));
    console.log(`[smoke] 原生事件计数: dblclick=${counts.dbl} click=${counts.click}`);
    // 树行 favicon（站点图标）渲染
    const hasFavicon = await mp2.evaluate(() => {
      const row = [...document.querySelectorAll('div.cursor-pointer')].find((el) =>
        el.textContent?.includes('双击测试书签'),
      );
      return !!row?.querySelector('img[src*="_favicon"]');
    });
    console.log(`[smoke] 树行 favicon: ${hasFavicon ? '✓' : '✗'}`);
    if (!hasFavicon) errors.push('树中书签行未渲染站点 favicon');

    // 编辑书签链接：书签 URL 与元数据同步更新
    const urlEdit = await mp2.evaluate(`(async () => {
      const [node] = await chrome.bookmarks.search({ title: '双击测试书签' });
      if (!node) throw new Error('未找到双击测试书签');
      const res = await chrome.runtime.sendMessage({ type: 'updateMeta', timestamp: Date.now(), data: {
        bookmarkId: node.id, url: 'http://127.0.0.1:${mockServer.port}/ok/moved', summary: '改过链接', tags: ['moved'],
      }});
      if (res && 'err' in res) throw new Error(String(res.err?.message ?? res.err));
      const after = (await chrome.bookmarks.get(node.id))[0];
      return { url: after.url, hasMeta: !!res?.res?.urlHash };
    })()`);
    console.log(`[smoke] 编辑链接: url=${urlEdit.url?.split('/').pop()} 元数据=${urlEdit.hasMeta ? '✓' : '✗'}`);
    if (!urlEdit.url?.endsWith('/ok/moved') || !urlEdit.hasMeta) errors.push('链接编辑未同步书签与元数据');

    // 回归：书签视图不应泄漏设置内容（v-else 错挂 bug）
    const mp = await browser.newPage();
    await mp.goto(`chrome-extension://${extensionId}/manager.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 500));
    const mt = await mp.evaluate(() => document.body.innerText);
    const leaked = mt.includes('添加供应商') || mt.includes('Base URL');
    console.log(`[smoke] 书签视图不含设置: ${leaked ? '✗ 泄漏' : '✓'}`);
    if (leaked) errors.push('书签视图泄漏了设置界面');
    await mp.close();

    // popup 树右键菜单
    const pp = await browser.newPage();
    await pp.setViewport({ width: 660, height: 480 });
    await pp.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 800));
    const popupText = await pp.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('[smoke] popup 页面文本:', JSON.stringify(popupText));
    await pp.evaluate(() => {
      const row = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('书签栏'));
      if (!row) throw new Error('popup 树中未找到文件夹行');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
    });
    await new Promise((r) => setTimeout(r, 300));
    const menuText = await pp.evaluate(() => document.body.innerText);
    const menuOk = menuText.includes('在管理页中查看') && (menuText.includes('展开') || menuText.includes('收起'));
    console.log(`[smoke] popup 右键菜单: ${menuOk ? '✓' : '✗'}`);
    if (!menuOk) errors.push('popup 右键菜单未渲染');

    // 右键删除书签：菜单 → 删除 → 二次确认 → 书签消失
    const delTarget = '双击测试书签';
    await pp.evaluate(() => {
      const row = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('双击测试书签'));
      if (!row) throw new Error('未找到待删除书签行');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 120 }));
    });
    await new Promise((r) => setTimeout(r, 200));
    await pp.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (el) => el.textContent?.includes('删除') && !el.textContent.includes('确认'),
      );
      if (!btn) throw new Error('菜单中未找到删除项');
      btn.click();
    });
    await new Promise((r) => setTimeout(r, 200));
    const confirmShown = await pp.evaluate(() => document.body.innerText.includes('此操作不可撤销'));
    await pp.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '确认删除');
      if (!btn) throw new Error('未找到确认删除按钮');
      btn.click();
    });
    await new Promise((r) => setTimeout(r, 600));
    const stillThere = await pp.evaluate(`chrome.bookmarks.search({ title: ${JSON.stringify(delTarget)} }).then(r => r.length > 0)`);
    console.log(`[smoke] popup 删除书签: 确认弹层=${confirmShown ? '✓' : '✗'} 书签已移除=${stillThere ? '✗' : '✓'}`);
    if (!confirmShown) errors.push('删除二次确认弹层未出现');
    if (stillThere) errors.push('确认删除后书签仍存在');
    await pp.close();
  });
} finally {
  await browser.close();
  mockServer.server.close();
}

function countUrl(node, fragment) {
  let n = node.url?.includes(fragment) ? 1 : 0;
  for (const c of node.children ?? []) n += countUrl(c, fragment);
  return n;
}

function sortTree(nodes) {
  return nodes
    .map((n) => ({
      title: n.title,
      url: n.url,
      children: n.url ? [] : sortTree(n.children ?? []),
    }))
    .sort((a, b) => (a.title + (a.url ?? '')).localeCompare(b.title + (b.url ?? '')));
}

async function waitForJob(page, jobId, predicate, timeout) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    const jobs = await page.evaluate(send('getJobs'));
    last = jobs.find((j) => j.id === jobId) ?? null;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`job ${jobId} 等待超时，最后状态: ${JSON.stringify(last).slice(0, 600)}`);
}

if (errors.length) {
  console.error('\n[smoke] 发现问题:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log(`\n[smoke] 全部通过 ✓（mock server 处理了 ${requests.length} 次 AI 请求）`);
