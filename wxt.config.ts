import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  srcDir: 'src',
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    // 固化扩展 ID：未打包扩展的 ID 默认由加载路径推导，路径变化/重建会导致
    // ID 改变进而丢失 chrome.storage 与 IndexedDB。写入 key 后 ID 永久固定。
    // 私钥在 scripts/autobookmark-extension.pem（仅打包 CRX 时需要，请勿提交）
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsnLqiI5X9k+7DNVlwWOUAF6JrRSNo0cz4MguOu5vBz64vyEy6VIUWD9I3MKS2cINVTbv9Qhj7J0n35J2qKLaHCLV9NVv3Tqn9AFAXmVYMyrVE9f6GbMZqpbW2S3mrrEOj66X0U+gc+ZbDPbgP6g7glbp1cTgZ/ygVQ5iTJyDZjdTGvb+WY1zZCr/LNgvr3PyTVbQZ7nRhTR27iC7/XLIQs7tIGlDBOYqj5h+G/eknr+lVQ63kjxdmVxBUoNx1fABvTPP7dfT6NDA40QTK7f9PjdE2eG3KdMrus1PkyAvsezveQKJP2XQ4XjxssFCyV+4sGH/iZOPt0us9qqgY+N4iQIDAQAB',
    name: 'AutoBookmark · AI 智能书签',
    description:
      '一键收藏，AI 自动生成标题、摘要与标签；树状管理页浏览与整理书签库。支持自定义 AI 供应商（Z.ai / DeepSeek / OpenAI 兼容）。',
    permissions: [
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
  },
});
