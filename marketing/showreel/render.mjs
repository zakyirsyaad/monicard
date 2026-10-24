// Renders scene.html frame by frame. Usage:
//   node render.mjs stills 1.2 5.6 ...   -> stills/t_<sec>.png
//   node render.mjs video                -> segments for reel_silent.mp4 + sfx.json
// Env: SCENE (default battle.html), WIDTH, HEIGHT, SECONDS.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || '/Users/mac/.npm/_npx/9833c18b2d85bc59/node_modules/playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const nadDir = path.join(here, '../../docs/design-system/assets/Nadmon');
const svgs = Object.fromEntries(readdirSync(nadDir).filter(f => f.endsWith('.svg')).map(f => [f.replace('.svg', ''), readFileSync(path.join(nadDir, f), 'utf8')]));
const SCENE = process.env.SCENE || 'battle.html';
const WIDTH = Number(process.env.WIDTH || 1080), HEIGHT = Number(process.env.HEIGHT || 1920);
const FPS = 60, FRAMES = Number(process.env.SECONDS || 30) * FPS, WORKERS = 4;

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.addInitScript(s => { window.NADMON_SVGS = s; }, svgs);
  await page.goto('file://' + path.join(here, SCENE) + `?w=${WIDTH}&h=${HEIGHT}`);
  if (!(await page.evaluate(() => window.ready))) throw new Error('fonts failed to load');
  return page;
}
const frame = (page, t) => page.evaluate(t => { window.render(t); return document.getElementById('c').toDataURL('image/png').split(',')[1]; }, t).then(b => Buffer.from(b, 'base64'));

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/Users/mac/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const [mode, ...args] = process.argv.slice(2);
if (mode === 'stills') {
  mkdirSync(path.join(here, 'stills'), { recursive: true });
  const page = await openPage(browser);
  for (const a of args) writeFileSync(path.join(here, `stills/t_${a}.png`), await frame(page, Number(a)));
} else {
  const page0 = await openPage(browser);
  writeFileSync(path.join(here, 'sfx.json'), JSON.stringify(await page0.evaluate(() => window.SFX), null, 1));
  await page0.close();
  const per = Math.ceil(FRAMES / WORKERS);
  await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
    const page = await openPage(browser);
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', String(FPS), path.join(here, `seg${w}.mp4`)], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => ff.on('close', c => c ? rej(new Error('ffmpeg ' + c)) : res()));
    for (let f = w * per; f < Math.min(FRAMES, (w + 1) * per); f++) {
      const buf = await frame(page, f / FPS);
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (f % 60 === 0) console.log(`worker ${w} frame ${f}`);
    }
    ff.stdin.end(); await done;
  }));
  writeFileSync(path.join(here, 'segs.txt'), Array.from({ length: WORKERS }, (_, w) => `file 'seg${w}.mp4'`).join('\n'));
}
await browser.close();
