# AutoBookmark · AI 智能书签

把"收藏了就再也不看"的书签，变成自动整理、可语义搜索的知识库。

自带 AI 供应商配置：**Z.ai、Z.ai GLM Coding Plan、智谱 BigModel（含国内 Coding Plan）、DeepSeek、OpenAI、OpenCode Zen/Go、Ollama** 预置模板，或任意 OpenAI 兼容接口。API Key 只保存在浏览器本地，所有请求直达你配置的供应商，无中间服务器。

## 功能

| 功能 | 说明 |
| --- | --- |
| ✨ 一键智能收藏 | Popup / 右键菜单 / `Alt+B`。AI 自动生成规范标题、一句话摘要、3~5 个标签，并建议分类文件夹；生成结果可编辑后保存 |
| 🌳 Popup 书签树 | 点击图标即可浏览书签树，点书签直接打开；顶部快速搜索，直达完整管理页 |
| ⚡ 页面 TL;DR | 流式输出当前页面的 3~5 条要点 |
| 🔍 混合搜索 | 管理页自然语言搜索全部书签（"那篇讲 CSS 容器查询的教程"）。配置 embedding 后为 语义+关键词 RRF 融合排序，未配置则退化为关键词模式（中文子串匹配 + FlexSearch） |
| 🌳 树状管理页 | 扩展内置全标签页管理器（`Alt+Shift+B`）：左侧文件夹树（新建/重命名/删除/拖拽移动），右侧书签卡片（未增强角标、多选批量 AI 增强、元数据编辑），不依赖浏览器侧栏，Brave/Chrome/Edge 行为一致 |
| 🗂 自动归档 | 收藏自动挂到 `其他书签/AI 收藏/<AI 建议文件夹>`，与浏览器原生书签完全互通 |
| ✨ 整理中心 | 对**已有书签**批量整理（可一键撤销）：批量补全 AI 元数据、自动分类（聚类→原地移动→清理空文件夹）、去重（URL 归一化 + 语义相似 + AI 确认）、死链检测清理 |
| 🤖 对话助手 | 管理页内嵌对话 Agent：自然语言指挥书签操作——批量重命名、移动、归类整理、查找、删除（>3 条需对话内确认），基于 Function Calling，操作实时反映到树 |
| 📊 用量统计 | 按供应商统计调用次数与 token 消耗 |
| 🔌 任务级模型绑定 | 摘要绑便宜模型、整理绑强模型，各功能独立选择供应商/模型 |

## 快速开始

```bash
pnpm install
pnpm dev        # Chrome 开发模式（自动打开浏览器，热更新）
```

生产构建：

```bash
pnpm build      # 产物在 .output/chrome-mv3
pnpm zip        # 打包商店上传用 zip
```

### Firefox

```bash
pnpm build:firefox   # 产物在 .output/firefox-mv3（WXT MV3 事件页）
pnpm zip:firefox     # 打包 AMO 上传用 zip
pnpm lint:firefox    # web-ext lint 检查产物
```

要求 Firefox 128+（MV3 按需 host 权限）。两处与 Chromium 的差异已做兼容：正文解析直接在带 DOM 的 event page 进行（无 offscreen API）；站点图标直接取目标站 `/favicon.ico`（无 `/_favicon/` 服务）。手动加载：`about:debugging#/runtime/this-firefox` → "临时载入附加组件" → 选择 `.output/firefox-mv3` 任意文件。临时载入使用随机扩展 ID；AMO 正式签名安装后固定为 manifest 声明的 gecko id。

Chrome 手动加载：打开 `chrome://extensions` → 开发者模式 → "加载已解压的扩展程序" → 选择 `.output/chrome-mv3`。

## 配置 AI 供应商

1. 点击扩展图标 → 设置（或右键图标 → 选项）
2. 从预置模板添加供应商，填入 API Key：
   - **Z.ai**：<https://z.ai/manage/apikey>（国内用 智谱 BigModel：<https://open.bigmodel.cn/usercenter/apikeys>）
- 对话助手需要模型支持 **Function Calling**（GLM / DeepSeek / OpenAI 系列均支持）
   - **DeepSeek**：<https://platform.deepseek.com/api_keys>
3. 点"测试连接"（会请求该供应商域名的访问权限，并拉取模型列表）
4. 在"任务绑定"里为 智能收藏 / TL;DR / 语义索引 各选一个模型

> 语义索引需要供应商提供 `/embeddings` 接口（Z.ai 的 `embedding-3`、OpenAI 的 `text-embedding-3-small` 均可；DeepSeek 不提供，可留空或另配一家）。

## 架构

```
src/
├── entrypoints/
│   ├── background/       # service worker：AI 调用（SSE 流式/重试/用量）、消息路由、
│   │                     # 右键菜单、书签事件同步、TL;DR 流式端口
│   ├── popup/            # 收藏卡片（AI 生成 → 编辑 → 保存）、TL;DR
│   ├── manager/          # 树状书签管理页（树/列表/搜索/整理中心）
│   ├── options/          # 供应商 CRUD、测试连接、任务绑定、偏好、用量
│   ├── offscreen/        # DOMParser+Readability 正文解析（SW 无 DOM）
│   └── extractor.script.ts  # 正文提取（Readability→Markdown），按需注入、无常驻
├── core/
│   ├── providers/        # OpenAI 兼容 client + 预置模板 + 域名权限
│   ├── ai/               # prompts、JSON 结构化输出（zod 校验+修复重试）、用量
│   ├── bookmarks/        # 收藏 pipeline、文件夹管理、事件同步
│   ├── organize/         # 整理中心：jobs 调度（alarms 续跑）、增强/分类/去重/死链、undo 回放
│   ├── search/           # FlexSearch + 向量余弦 + RRF / 中文子串匹配
│   └── storage/          # IndexedDB 元数据+任务（idb）+ settings（chrome.storage.local）
└── shared/               # typed messaging 协议、流式端口协议、类型
```

**数据设计**：`chrome.bookmarks` 是真相源（原生管理器可见可管）；IndexedDB 存 AI 元数据（摘要/标签/向量），监听 `onRemoved/onChanged/onMoved` 保持一致。URL 归一化哈希（去 utm/hash）用于重复检测。

**隐私**：正文提取与关键词索引全本地；发送给 AI 的正文上限可在设置中调整；API Key 永不进 sync 存储。

## 冒烟测试

```bash
pnpm build && node scripts/smoke.mjs
```

内置本地 mock OpenAI 兼容服务器（无需真实 Key），用 Playwright 缓存的 Chrome for Testing 加载构建产物，覆盖：四个 UI 挂载、消息路由、`saveBookmark` 全链路、批量增强、自动分类 + **撤销恢复**、去重（精确+语义+AI 确认）、死链检测清理。

## 上架与隐私

- 隐私政策：[`PRIVACY.md`](PRIVACY.md)
- 商店提交材料（权限说明、数据披露、素材清单）：[`docs/store-listing.md`](docs/store-listing.md)

## 许可证

本项目基于 [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)（GNU General Public License v3.0）发布。

Copyright (C) 2026 MinatoHikari

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
