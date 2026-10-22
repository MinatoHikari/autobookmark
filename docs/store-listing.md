# 商店上架材料清单

上传 Chrome Web Store 与 Firefox Add-ons (AMO) 时需要填写的审核信息汇总，直接复制使用。

## 上传产物

| 商店 | 文件 | 版本要求 |
| --- | --- | --- |
| Chrome Web Store | `.output/autobookmark-<version>-chrome.zip`（`pnpm zip`） | manifest 含 `minimum_chrome_version: 109` |
| Firefox AMO | `.output/autobookmark-<version>-firefox.zip`（`pnpm zip:firefox`） | `strict_min_version: 128.0`，gecko id `{45A91DCC-0F63-4FB4-9C47-B810881F69A8}` |

提交前跑一遍：`pnpm compile && pnpm build && node scripts/smoke.mjs && pnpm lint:firefox`。

## 单一用途描述（Single Purpose）

> AI 智能书签管理：一键收藏网页并由 AI 生成标题、摘要与标签，提供树状管理页、语义搜索与批量整理（分类/去重/死链检测），所有 AI 处理由用户自行配置的供应商完成。

## 权限用途说明（Chrome 审核表单）

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存扩展设置、API Key 与用量统计（仅本地，不进 sync） |
| `bookmarks` | 读写书签：智能收藏、树状管理、AI 分类/去重/死链整理 |
| `scripting` | 按需向当前标签页注入正文提取脚本（收藏与 TL;DR 时） |
| `activeTab` | 在用户点击扩展/右键菜单时获取当前页 URL 并注入提取脚本 |
| `contextMenus` | 提供右键菜单"AI 智能收藏此页面" |
| `alarms` | 批量整理任务的断点续跑调度（MV3 service worker 会被回收） |
| `favicon` | 读取浏览器内置站点图标用于书签列表展示 |
| `offscreen` | 在无 DOM 的 service worker 中离屏解析网页正文（DOMParser） |
| `notifications` | 批量整理任务完成时通知，点击打开管理页 |
| `optional_host_permissions`（http/https 全站） | 按需授权：测试 AI 供应商连通性、抓取书签页面正文做增强/死链检测。仅在用户主动开启功能或点击"测试连接"时请求，可随时撤销 |

## 远程代码声明

本扩展**不加载任何远程代码**，全部 JS/CSS 随包分发。运行时仅向**用户配置的 AI 供应商端点**发起网络请求（OpenAI 兼容 chat/embeddings/models 接口），属远程服务调用而非远程代码。

## 数据使用披露（CWS Data Usage）

- 收集/处理网站内容：是 —— 仅用户主动收藏或整理时，发送到用户自行配置的 AI 供应商（见 `PRIVACY.md`）
- 书签数据：本地处理；AI 功能中相关书签标题/URL 会发送到用户配置的供应商
- 个人身份信息 / 财务 / 健康 / 通讯录：无
- 遥测/分析：无
- 隐私政策 URL：指向仓库 `PRIVACY.md`（发布前可部署为静态页面）

## AMO 数据收集披露

manifest 已声明 `browser_specific_settings.gecko.data_collection_permissions`：

```json
{ "required": ["websiteContent", "bookmarksInfo"] }
```

Dev Hub 对应回答：扩展会把网页正文与书签信息发送到用户自行配置的 AI 端点；开发者不接收任何数据。

## 商店素材

- 图标 128×128：`public/icon/128.png`（已达标）
- 截图（必填，1280×800 或 640×400，1~5 张）：建议截取 ① 管理页树状视图 ② popup 智能收藏卡片 ③ 整理中心任务报告 ④ 对话助手 ⑤ 搜索
- 宣传图（可选）：440×280 小图、1400×560 marquee
- 简短说明（132 字内）：直接用 `wxt.config.ts` manifest 的 description
- 详细描述：见下方「商店详细描述」，为纯文本（商店编辑器不渲染 Markdown），可直接整段粘贴

## 商店详细描述（Chrome Web Store / AMO 通用，纯文本）

```
收藏了就再也不看？让 AI 替你把书签变成自动整理、可语义搜索的知识库。

AutoBookmark 是 AI 驱动的书签管理扩展：一键收藏网页，AI 自动生成规范标题、一句话摘要与标签，并建议归类文件夹——收藏的那一刻就已经整理好了。

✨ 一键智能收藏
点击图标（Alt+B）或右键菜单即可收藏。AI 生成标题、摘要与 3~5 个标签，自动归档到「其他书签 / AI 收藏 / 建议文件夹」，与浏览器原生书签完全互通；生成结果可编辑后保存。

⚡ 页面速读 TL;DR
流式输出当前网页的 3~5 条要点，长文先看重点，再决定是否精读。

🔍 自然语言搜索
像说话一样搜索："那篇讲 CSS 容器查询的教程"。配置 Embedding 后为语义 + 关键词双路融合排序；不配置也可用中文关键词搜索。

🌳 树状管理页（Alt+Shift+B）
内置全标签页管理器：左侧文件夹树支持新建 / 重命名 / 拖拽移动，右侧书签卡片带未增强角标、多选批量操作与元数据编辑，Chrome / Edge / Brave 表现一致。

🧹 整理中心 · 一键可撤销
对已有书签批量整理：补全 AI 元数据、自动分类、智能去重（URL 归一化 + 语义相似 + AI 确认）、死链检测与清理，全程可一键撤销。

🤖 对话助手
在管理页用自然语言指挥书签操作，例如"把所有 GitHub 收藏按主题归类"。基于 Function Calling 实现，操作实时生效；超过 3 条的删除需在对话内确认。

📊 用量统计 · 任务级模型绑定
按供应商统计调用次数与 token 消耗；摘要、整理等任务可分别绑定不同模型——便宜模型干轻活，强模型干重活。

【自带 AI 供应商 · Bring Your Own Key】
预置 Z.ai、智谱 BigModel、DeepSeek、OpenAI、OpenCode Zen/Go、Ollama 模板，也可接入任意 OpenAI 兼容接口。使用需自备 API Key，在设置页一分钟完成配置，支持一键测试连接。

【隐私与数据 · 本地优先】
• API Key 仅保存在浏览器本地，绝不进入云同步
• AI 请求由浏览器直达你配置的供应商，本扩展没有中间服务器，开发者不接收任何数据
• 正文提取与关键词索引全部本地完成，发送给 AI 的正文长度上限可在设置中调整
• 隐私政策：https://github.com/MinatoHikari/autobookmark/blob/main/PRIVACY.md

【快捷键】
Alt+B · 智能收藏
Alt+Shift+B · 打开书签管理页

开源地址：https://github.com/MinatoHikari/autobookmark
问题反馈请提交 Issue，欢迎 Star 支持。
```

## AMO 备注

- 上传 zip 为 minified 构建产物；审核员索要源码时提供仓库链接与构建说明：`pnpm install --frozen-lockfile && pnpm build:firefox`（依赖全部来自 npm 公共源，锁文件可复现）。
- lint 结果 0 errors / 0 notices / 12 warnings（均为第三方 minified 依赖的 eval/innerHTML 常规告警）。
- Firefox ESR/Release 128+ 支持；MV3 事件页 + 按需 host 权限（128+ 特性）。
