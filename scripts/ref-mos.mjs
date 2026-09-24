// Capture Mos Health structure: full-page shots (desktop + mobile), type scale, section spacing, logo rows.
import { chromium } from 'playwright-core';
import fs from 'fs';
const url = process.argv[2] || 'https://www.moshealth.com/';
const b = await chromium.launch({ channel: 'chrome' });
for (const [tag, vp, mob] of [['d', { width: 1440, height: 900 }, false], ['m', { width: 390, height: 844 }, true]]) {
  const c = await b.newContext({ viewport: vp, isMobile: mob, hasTouch: mob, deviceScaleFactor: mob ? 2 : 1 });
  const p = await c.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(4000);
  for (const t of ['Accept', 'Accept all', 'Got it', 'OK']) {
    const btn = p.getByRole('button', { name: t, exact: true }); if (await btn.count()) { await btn.first().click().catch(() => {}); break; }
  }
  // scroll through to trigger lazy content
  const H = await p.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < H; y += 700) { await p.evaluate(v => scrollTo(0, v), y); await p.waitForTimeout(250); }
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(1200);
  await p.screenshot({ path: `/tmp/mos-${tag}-full.png`, fullPage: true });
  const data = await p.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const type = [];
    document.querySelectorAll('h1,h2,h3,h4,p,a,button,span,li').forEach(e => {
      if (!vis(e)) return; const t = (e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) ? e.textContent.trim() : ''; if (!t) return;
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      type.push({ tag: e.tagName.toLowerCase(), fs: cs.fontSize, lh: cs.lineHeight, fw: cs.fontWeight, ls: cs.letterSpacing, ff: cs.fontFamily.split(',')[0], tt: cs.textTransform, w: Math.round(r.width), y: Math.round(r.top + scrollY), t: t.slice(0, 60) });
    });
    const secs = [...document.querySelectorAll('section, main > div, footer')].filter(vis).map(e => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { cls: String(e.className).slice(0, 50), y: Math.round(r.top + scrollY), h: Math.round(r.height), pt: cs.paddingTop, pb: cs.paddingBottom, bg: cs.backgroundColor, h2: (e.querySelector('h1,h2')?.textContent || '').trim().slice(0, 60) }; });
    const logos = [...document.querySelectorAll('img, svg')].filter(vis).map(e => { const r = e.getBoundingClientRect(); return { alt: e.getAttribute('alt') || e.getAttribute('aria-label') || '', src: (e.getAttribute('src') || '').slice(-60), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + scrollY) }; }).filter(l => l.h > 10 && l.h < 90 && l.w < 260);
    return { H: document.body.scrollHeight, type, secs, logos, container: getComputedStyle(document.body).maxWidth };
  });
  fs.writeFileSync(`/tmp/mos-${tag}.json`, JSON.stringify(data, null, 1));
  console.log(tag, 'height', data.H, 'type', data.type.length, 'secs', data.secs.length, 'logos', data.logos.length);
  await c.close();
}
await b.close();
