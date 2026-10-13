// AI 图标合成：背景艺术图（本地 NoobAI 生成）+ 矢量书签字形/金色星芒 → 母图
// 用法：node scripts/compose-ai-icon.mjs [背景图路径]
// 产出：assets/store/ai-icon-master.png（完整版，切 48+ 尺寸）
//       assets/store/ai-icon-master-small.png（书签区域裁切放大版，切 16/32）
// 背景图由 ComfyUI 生成后放到 assets/store/ai-bg.png 即可重跑本脚本。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
const puppeteer = createRequire(import.meta.url)('puppeteer-core');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bgPath = resolve(process.argv[2] ?? 'assets/store/ai-bg.png');
if (!existsSync(bgPath)) throw new Error(`背景图不存在: ${bgPath}（先在 ComfyUI 生成渐变背景并保存为 assets/store/ai-bg.png）`);

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

// 书签缎带（顶部圆角、底部 V 形缺口）+ 三条"文本线" + 金色四角星芒 + 中心聚光晕
const GLYPH = `
<defs>
  <filter id="gs" x="-40%" y="-40%" width="180%" height="180%">
    <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#1E1B4B" flood-opacity=".5"/>
  </filter>
  <filter id="ss" x="-60%" y="-60%" width="220%" height="220%">
    <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#1E1B4B" flood-opacity=".45"/>
  </filter>
  <radialGradient id="scrim" cx=".5" cy=".52" r=".56">
    <stop offset="0" stop-color="#1E1B4B" stop-opacity=".34"/>
    <stop offset=".7" stop-color="#1E1B4B" stop-opacity=".12"/>
    <stop offset="1" stop-color="#1E1B4B" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FEF08A"/><stop offset=".55" stop-color="#FCD34D"/><stop offset="1" stop-color="#F59E0B"/>
  </linearGradient>
</defs>
<rect width="1024" height="1024" fill="url(#scrim)"/>
<g filter="url(#gs)">
  <path fill="#FFFFFF" d="M342,330 Q342,300 372,300 H652 Q682,300 682,330 V742 L512,650 L342,742 Z"/>
</g>
<g fill="#8B5CF6">
  <rect x="396" y="380" width="232" height="26" rx="13"/>
  <rect x="396" y="438" width="164" height="26" rx="13"/>
  <rect x="396" y="496" width="196" height="26" rx="13"/>
</g>
<path filter="url(#ss)" fill="url(#gold)" d="M665,180 C671.4,157.2 687.2,141.4 710,135 687.2,128.6 671.4,112.8 665,90 658.6,112.8 642.8,128.6 620,135 642.8,141.4 658.6,157.2 665,180 Z" transform="translate(670,262) scale(1.7) translate(-665,-135)"/>
`;

const b64 = readFileSync(bgPath).toString('base64');
// 小尺寸版：裁切书签+星芒所在的 600² 区域再放大，字形占比 33%→57%，16/32px 才可辨识
const CROP = { x: 212, y: 161, size: 600 };

const htmlFull = `<!doctype html><meta charset="utf-8"><style>*{margin:0}body{width:1024px;height:1024px;overflow:hidden}#bg{position:absolute;inset:0;width:1024px;height:1024px;object-fit:cover}svg{position:absolute;inset:0}</style>
<img id="bg" src="data:image/png;base64,${b64}">
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">${GLYPH}</svg>`;

// 裁切版单独渲染：直接以 canvas source-crop 绘制背景
const htmlCrop = `<!doctype html><meta charset="utf-8"><style>*{margin:0}body{width:1024px;height:1024px;overflow:hidden}canvas,svg{position:absolute;inset:0}</style>
<canvas id="c" width="1024" height="1024"></canvas>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">${GLYPH}</svg>
<script>
  window.drawBg = (dataUrl) => new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => {
      const c = document.getElementById('c');
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, ${CROP.x}, ${CROP.y}, ${CROP.size}, ${CROP.size}, 0, 0, 1024, 1024);
      ok();
    };
    img.onerror = bad;
    img.src = dataUrl;
  });
</script>`;

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });

  await page.setContent(htmlFull, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 120));
  await page.screenshot({ path: join(root, 'assets/store/ai-icon-master.png') });
  console.log('[compose] assets/store/ai-icon-master.png');

  await page.setContent(htmlCrop, { waitUntil: 'domcontentloaded' });
  await page.evaluate((d) => window.drawBg(d), `data:image/png;base64,${b64}`);
  await new Promise((r) => setTimeout(r, 120));
  await page.screenshot({ path: join(root, 'assets/store/ai-icon-master-small.png') });
  console.log('[compose] assets/store/ai-icon-master-small.png');
} finally {
  await browser.close();
}
