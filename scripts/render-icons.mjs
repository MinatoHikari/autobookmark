// 渲染扩展图标：SVG 母版 → 各尺寸 PNG（工具栏 / Chrome Web Store / AMO）
// 用法：node scripts/render-icons.mjs
// 无额外依赖：复用冒烟测试同款 Chrome 查找逻辑 + 项目内 puppeteer-core 截图。
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 图标母版（viewBox 512）。
 * 设计：indigo→violet→fuchsia 渐变圆角底，白色书签（AI 增强的载体），
 * 金色四角星芒（AI 生成）。detailed=false 时省去书签内的三条内容线，
 * 16/32px 下线条会糊成一团，只保留主图形。
 */
const iconSvg = (detailed) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366F1"/>
      <stop offset=".52" stop-color="#8B5CF6"/>
      <stop offset="1" stop-color="#D946EF"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FEF08A"/>
      <stop offset=".55" stop-color="#FCD34D"/>
      <stop offset="1" stop-color="#F59E0B"/>
    </linearGradient>
    <radialGradient id="sheen" cx=".28" cy=".1" r="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".26"/>
      <stop offset=".55" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#312E81" flood-opacity=".35"/>
    </filter>
    <filter id="tiny" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#312E81" flood-opacity=".4"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <rect width="512" height="512" rx="116" fill="url(#sheen)"/>
  <path filter="url(#soft)" fill="#fff" d="M188 92H300Q348 92 348 140V396Q348 424 326 410L258 368Q244 359 230 368L162 410Q140 424 140 396V140Q140 92 188 92Z"/>
  ${detailed ? `<g fill="#8B5CF6">
    <rect x="176" y="146" width="136" height="18" rx="9"/>
    <rect x="176" y="190" width="96" height="18" rx="9"/>
    <rect x="176" y="234" width="114" height="18" rx="9"/>
  </g>` : ''}
  <path filter="url(#tiny)" fill="url(#gold)" d="M392 44C397 90 428 121 474 126 428 131 397 162 392 208 387 162 356 131 310 126 356 121 387 90 392 44Z"/>
  <path fill="#fff" opacity=".9" d="M108 344C110.5 361 120 370 137 372 120 374 110.5 383 108 400 105.5 383 96 374 79 372 96 370 105.5 361 108 344Z"/>
</svg>`;

/** public/icon/ 内 manifest 引用的尺寸（Chrome/Firefox 包内图标，AMO 商店图标即取自包内） */
const PACKAGE_SIZES = [16, 32, 48, 96, 128];
/** 商店上传用高清版（不进扩展包，public/ 会被整体拷入产物） */
const STORE_EXTRA = [
  { n: 512, out: 'assets/store/icon-512.png' },
];

function findChrome() {
  const candidates = [];
  const puppeteerRoot = `${homedir()}/.cache/puppeteer/chrome`;
  if (existsSync(puppeteerRoot)) {
    for (const build of readdirSync(puppeteerRoot).sort().reverse()) {
      candidates.push(`${puppeteerRoot}/${build}/chrome-win64/chrome.exe`, `${puppeteerRoot}/${build}/chrome-win/chrome.exe`);
    }
  }
  const playwrightDir = `${homedir()}/AppData/Local/ms-playwright`;
  if (existsSync(playwrightDir)) {
    for (const build of readdirSync(playwrightDir).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      candidates.push(`${playwrightDir}/${build}/chrome-win64/chrome.exe`, `${playwrightDir}/${build}/chrome-win/chrome.exe`);
    }
  }
  candidates.push('C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  return candidates.find(existsSync);
}

const chrome = findChrome();
if (!chrome) throw new Error('未找到可用的 Chrome/Chromium（puppeteer 缓存 / playwright 缓存 / 系统安装均缺失）');
console.log(`[icons] Chrome: ${chrome}`);

mkdirSync(join(root, 'public/icon'), { recursive: true });
mkdirSync(join(root, 'assets/store'), { recursive: true });

// 母版矢量入库，方便日后改设计再重渲染
writeFileSync(join(root, 'assets/icon.svg'), iconSvg(true));

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
const targets = [
  ...PACKAGE_SIZES.map((n) => ({ n, out: `public/icon/${n}.png` })),
  ...STORE_EXTRA,
];
for (const { n, out } of targets) {
  const detailed = n >= 48;
  const page = await browser.newPage();
  await page.setViewport({ width: n, height: n, deviceScaleFactor: 1 });
  const svg = iconSvg(detailed).replace('<svg ', `<svg width="${n}" height="${n}" `);
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:${n}px;height:${n}px;overflow:hidden}svg{display:block}</style>${svg}`,
  );
  await new Promise((r) => setTimeout(r, 60)); // 等 feDropShadow/渐变栅格化一帧
  await page.screenshot({ path: join(root, out), omitBackground: true });
  await page.close();
  console.log(`[icons] ${out}`);
}
} finally {
  await browser.close();
}

// Chrome Web Store 商店图标上传件（要求 128×128 PNG）
copyFileSync(join(root, 'public/icon/128.png'), join(root, 'assets/store/icon-128.png'));
console.log('[icons] assets/store/icon-128.png 完成');
