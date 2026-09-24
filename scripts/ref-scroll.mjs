// Viewport-by-viewport capture (handles lazy/animated sites that render blank in full-page shots).
import { chromium } from 'playwright-core';
const url = process.argv[2], tag = process.argv[3], n = +(process.argv[4] || 10);
const b = await chromium.launch({ channel: 'chrome' });
const c = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const p = await c.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(4000);
const H = await p.evaluate(() => document.documentElement.scrollHeight);
const step = Math.max(900, Math.floor(H / n));
let i = 0;
for (let y = 0; y < H && i < n; y += step, i++) {
  await p.evaluate(v => window.scrollTo(0, v), y);
  await p.waitForTimeout(1800);
  await p.screenshot({ path: `/tmp/${tag}-v${i}.png` });
}
console.log(tag, 'H', H, 'shots', i);
await b.close();
