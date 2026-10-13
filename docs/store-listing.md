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
- 简短说明 / 详细描述：可直接用 README「功能」表格

## AMO 备注

- 上传 zip 为 minified 构建产物；审核员索要源码时提供仓库链接与构建说明：`pnpm install --frozen-lockfile && pnpm build:firefox`（依赖全部来自 npm 公共源，锁文件可复现）。
- lint 结果 0 errors / 0 notices / 12 warnings（均为第三方 minified 依赖的 eval/innerHTML 常规告警）。
- Firefox ESR/Release 128+ 支持；MV3 事件页 + 按需 host 权限（128+ 特性）。
