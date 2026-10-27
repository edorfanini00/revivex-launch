// Round 3 visual QA: viewport and full-page captures at the brief's four sizes, plus
// layout probes (overflow, image decode, orphan words in headings).
//   node scripts/r3-shots.mjs <out dir> [base url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const OUT = process.argv[2]; const BASE = process.argv[3] || 'http://127.0.0.1:4580';
fs.mkdirSync(OUT, { recursive: true });
const VPS = [['phone402', 402, 874, 3, true], ['phone390', 390, 844, 3, true], ['desk1440', 1440, 900, 1, false], ['desk1920', 1920, 1080, 1, false]];
const only = process.env.VP ? process.env.VP.split(',') : null;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = {};
for (const [name, w, h, dpr, mobile] of VPS) {
  if (only && !only.includes(name)) continue;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: process.env.DPR ? Number(process.env.DPR) : (mobile ? 2 : 1), isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${name}-0-hero.png`) });
  // Viewport captures down the page; the How it works section is captured per step.
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  let i = 1;
  for (let y = h; y < total; y += Math.round(h * 0.9)) {
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), y);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${name}-${String(i++).padStart(2, '0')}.png`) });
  }
  // Full page: reveal everything first.
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach(e => e.classList.add('in')));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(500);
  report[name] = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const imgs = [...document.images].filter(i => i.getBoundingClientRect().width > 0);
    const orphans = [...document.querySelectorAll('h1,h2,h3,summary')].filter(el => {
      const r = document.createRange(); r.selectNodeContents(el);
      const rects = [...r.getClientRects()]; if (rects.length < 2) return false;
      const lines = {}; for (const x of rects) { const k = Math.round(x.top); lines[k] = (lines[k] || 0) + x.width; }
      const ws = Object.values(lines); return ws.length > 1 && ws[ws.length - 1] < 0.18 * Math.max(...ws);
    }).map(e => e.textContent.trim().slice(0, 50));
    return { overflow: document.documentElement.scrollWidth - vw, height: document.documentElement.scrollHeight, undecoded: imgs.filter(i => !i.complete || !i.naturalWidth).map(i => i.currentSrc || i.src), orphans,
      bytes: performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0) + (performance.getEntriesByType('navigation')[0]?.transferSize || 0),
      imgsLoaded: performance.getEntriesByType('resource').filter(r => r.initiatorType === 'img' || /\.(avif|webp|jpg|png)$/.test(r.name)).map(r => r.name.replace(location.origin, '') + ' ' + r.transferSize) };
  });
  report[name].errors = errors;
  if (!process.env.NOFULL) await page.screenshot({ path: path.join(OUT, `${name}-full.png`), fullPage: true });
  await ctx.close();
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, { overflow: v.overflow, height: v.height, undecoded: v.undecoded.length, orphans: v.orphans, errors: v.errors, kb: Math.round(v.bytes / 1024) }])), null, 1));
