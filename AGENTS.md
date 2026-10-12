# AGENTS.md — AutoBookmark 项目协作规范

本文件供 AI 编码助手与贡献者阅读，约定本项目的开发流程与规则。

## 项目概览

浏览器扩展（MV3）：AI 智能书签管理。技术栈：WXT + Vue 3 + TypeScript + Tailwind CSS。
AI 供应商可自定义（Z.ai / 智谱 / DeepSeek / OpenAI / OpenCode Zen·Go / Ollama 及任意 OpenAI 兼容端点）。

## 常用命令

```bash
pnpm compile          # 类型检查（vue-tsc）
pnpm build            # 构建到 .output/chrome-mv3
pnpm zip              # 打包 zip（发布物）
node scripts/smoke.mjs # 端到端冒烟测试（内置 mock OpenAI server，无需真实 Key）
```

交付前必须：`pnpm compile` + `pnpm build` + `node scripts/smoke.mjs` 全部通过。

## 版本号规则（重要）

遵循语义化版本 `主.次.修订`（如 0.6.1），改动大小决定升级哪一位：

| 改动类型 | 升级位 | 示例 |
| --- | --- | --- |
| **第一位（主版本）** | **由项目所有者亲自决定，AI/贡献者不得擅自更改** | 破坏性架构迁移、数据格式不兼容 |
| 第二位（次版本） | 新增功能、明显的行为变化 | 新增对话助手、新增设置项 |
| 第三位（修订） | bug 修复、小的 UI 调整、文案改动 | 修复样式、修正报错文案 |

更新位置：`package.json` 的 `version` 字段（manifest 版本由 WXT 读取它生成）。
打包后清理旧版本 zip：`.output/autobookmark-<version>-chrome.zip`。

## 开发约定

- **UI 文案使用中文**；代码注释用中文说明"为什么"。
- **测试**：`scripts/smoke.mjs` 用 Playwright 缓存的 Chrome for Testing 加载构建产物 + 内置 mock OpenAI server（`/v1/chat/completions`、`/v1/embeddings`、`/v1/models`，含 agent tool_calls 脚本）。新功能必须补对应断言；修 bug 必须先能用测试复现。
- **脚本语言**：`scripts/*.mjs` 是纯 JavaScript，禁止 TypeScript 语法（如 `!` 非空断言、类型标注）。
- **持久化**：Vue reactive 对象直接存 `chrome.storage` 会被序列化成数字键对象——必须 `JSON.parse(JSON.stringify(...))` 深拷贝后再存。
- **设置兼容**：`getSettings` 对旧格式数据逐段深合并默认值，新增设置字段时无需写迁移代码，但必须在冒烟测试里加"旧格式设置迁移"用例。
- **popup 交互**：禁止 `window.confirm/prompt`（popup 会失焦关闭），用自定义弹层。
- **书签库真相源**是 `chrome.bookmarks`；IndexedDB 只存 AI 元数据与任务，任何变更后调用 `invalidateSearchIndex()` + `bumpLibraryVersion()`（驱动各界面自动刷新）。
- **MV3 约束**：批量/长任务必须可断点续跑（jobs + alarms），单轮 agent 循环保持无状态。

## 发布物

- `.output/chrome-mv3/` — 手动加载目录
- `.output/autobookmark-<version>-chrome.zip` — 存档/商店上传

扩展 ID 已通过 manifest `key` 固化，重建/换路径加载不丢用户数据。
