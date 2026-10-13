// 切图：AI 合成母图 → Chrome/Firefox 商店上传件 + 扩展包内全尺寸图标
// 用法：node scripts/slice-icon.mjs [母图路径]
// 母图默认 assets/store/ai-icon-master.png（compose-ai-icon.mjs 产出）；
// 若存在 ai-icon-master-small.png（书签区域裁切放大版）则 16/32px 用它，小尺寸更清晰。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(process.argv[2] ?? 'assets/store/ai-icon-master.png');
if (!existsSync(src)) throw new Error(`母图不存在: ${src}`);
const smallSrc = resolve('assets/store/ai-icon-master-small.png');
const hasSmall = existsSync(smallSrc);

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

/** 多步减半缩放，避免 1024→16 一次性缩放产生锯齿/细节糊死（目标尺寸运行时传入） */
function scaleDownPage() {
  return `<!doctype html><meta charset="utf-8"><canvas id="c"></canvas><script>
    window.render = async (dataUrl, n) => {
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = dataUrl; });
      let cur = img, w = img.naturalWidth, h = img.naturalHeight;
      while (w / 2 >= n && h / 2 >= n) {
        const half = document.createElement('canvas');
        half.width = Math.round(w / 2); half.height = Math.round(h / 2);
        const hc = half.getContext('2d');
        hc.imageSmoothingEnabled = true; hc.imageSmoothingQuality = 'high';
        hc.drawImage(cur, 0, 0, half.width, half.height);
        cur = half; w = half.width; h = half.height;
      }
      const c = document.getElementById('c');
      c.width = n; c.height = n;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      // 居中裁正方形（母图应为 1:1，此步只兜底）
      const side = Math.min(w, h);
      ctx.drawImage(cur, (w - side) / 2, (h - side) / 2, side, side, 0, 0, n, n);
      return c.toDataURL('image/png');
    };
  </script>`;
}

const targets = [
  { n: 128, out: 'public/icon/128.png' },
  { n: 96, out: 'public/icon/96.png' },
  { n: 48, out: 'public/icon/48.png' },
  { n: 32, out: 'public/icon/32.png', small: true },
  { n: 16, out: 'public/icon/16.png', small: true },
  { n: 512, out: 'assets/store/icon-512.png' },
  { n: 128, out: 'assets/store/icon-128.png' },
];

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
try {
  const page = await browser.newPage();
  const dataUrl = `data:image/png;base64,${(await import('node:fs')).readFileSync(src).toString('base64')}`;
  const smallDataUrl = hasSmall ? `data:image/png;base64,${(await import('node:fs')).readFileSync(smallSrc).toString('base64')}` : dataUrl;
  await page.setContent(scaleDownPage());
  for (const { n, out, small } of targets) {
    const result = await page.evaluate(async (data, size) => window.render(data, size), small && hasSmall ? smallDataUrl : dataUrl, n);
    const dir = join(root, out, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, out), Buffer.from(result.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log(`[slice] ${out}`);
  }
} finally {
  await browser.close();
}
