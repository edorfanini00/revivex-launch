import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const p = await c.newPage();
await p.goto(process.argv[2] || 'http://127.0.0.1:4190/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
const rows = await p.evaluate(() => {
  const out = [];
  const sel = 'h1,h2,h3,p,a.pill,button,summary,.eyebrow,.chip,label span,.lede';
  document.querySelectorAll(sel).forEach(e => {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    if (!r.width || cs.display === 'none') return;
    out.push([e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''), cs.fontSize, cs.lineHeight, cs.fontWeight, cs.letterSpacing, Math.round(r.width), (e.textContent || '').trim().slice(0, 34)]);
  });
  return out;
});
rows.forEach(r => console.log(r.join(' | ')));
await b.close();
