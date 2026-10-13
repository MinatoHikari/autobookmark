import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// Firefox 的内置数据同意声明（FF140+ 安装时弹出授权）：本扩展会把网页正文与
// 书签数据发送到用户自行配置的 AI 供应商，如实声明，避免 AMO 审核驳回。
import type { FirefoxDataCollectionPermissions } from 'wxt';

const AI_DATA_DISCLOSURE: FirefoxDataCollectionPermissions = {
  required: ['websiteContent', 'bookmarksInfo'],
};

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  srcDir: 'src',
  // Firefox 同样产出 MV3：复用 optional host permissions 按需授权架构
  // （MV2 会丢掉 optional_host_permissions，且 background 只有 browserAction 无 action）
  manifestVersion: 3,
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    return {
      // 固化扩展 ID：未打包扩展的 ID 默认由加载路径推导，路径变化/重建会导致
      // ID 改变进而丢失 chrome.storage 与 IndexedDB。写入 key 后 ID 永久固定。
      // 私钥在 scripts/autobookmark-extension.pem（仅打包 CRX 时需要，请勿提交）。
      // Firefox 用 gecko.id 固定 ID，CWS 上传时会替换 key，故 Firefox 构建不带 key。
      ...(isFirefox ? {} : { key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsnLqiI5X9k+7DNVlwWOUAF6JrRSNo0cz4MguOu5vBz64vyEy6VIUWD9I3MKS2cINVTbv9Qhj7J0n35J2qKLaHCLV9NVv3Tqn9AFAXmVYMyrVE9f6GbMZqpbW2S3mrrEOj66X0U+gc+ZbDPbgP6g7glbp1cTgZ/ygVQ5iTJyDZjdTGvb+WY1zZCr/LNgvr3PyTVbQZ7nRhTR27iC7/XLIQs7tIGlDBOYqj5h+G/eknr+lVQ63kjxdmVxBUoNx1fABvTPP7dfT6NDA40QTK7f9PjdE2eG3KdMrus1PkyAvsezveQKJP2XQ4XjxssFCyV+4sGH/iZOPt0us9qqgY+N4iQIDAQAB' }),
      name: 'AutoBookmark · AI 智能书签',
      description:
        '一键收藏，AI 自动生成标题、摘要与标签；树状管理页浏览与整理书签库。支持自定义 AI 供应商（Z.ai / DeepSeek / OpenAI 兼容）。',
      // offscreen 文档 API 需 Chrome 109+；Firefox 下限由 gecko.strict_min_version 表达
      ...(isFirefox ? {} : { minimum_chrome_version: '109' }),
      // favicon（/_favicon/ 服务）与 offscreen 均为 Chromium 专属，Firefox 构建裁剪
      permissions: isFirefox
        ? ['storage', 'bookmarks', 'scripting', 'activeTab', 'contextMenus', 'alarms', 'notifications']
        : [
            'storage',
            'bookmarks',
            'scripting',
            'activeTab',
            'contextMenus',
            'alarms',
            'favicon',
            'offscreen',
            'notifications',
          ],
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                // AMO 签发后不可更改，改动即视为新扩展
                id: '{45A91DCC-0F63-4FB4-9C47-B810881F69A8}',
                strict_min_version: '128.0',
                data_collection_permissions: AI_DATA_DISCLOSURE,
              },
            },
          }
        : {}),
      optional_host_permissions: ['http://*/*', 'https://*/*'],
      commands: {
        _execute_action: {
          suggested_key: {
            default: 'Alt+B',
          },
        },
        'open-manager': {
          suggested_key: {
            default: 'Alt+Shift+B',
          },
          description: '打开书签管理页',
        },
      },
    };
  },
});
