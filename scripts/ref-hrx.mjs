import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto('https://healthrevivex.com', { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForTimeout(2500);
const H = await p.evaluate(() => document.documentElement.scrollHeight);
for (let y = 0; y < H; y += 700) { await p.evaluate(v => scrollTo(0, v), y); await p.waitForTimeout(120); }
await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(800);
await p.screenshot({ path: '/tmp/hrx-full.png', fullPage: true });
const info = await p.evaluate(() => {
  const radii = [...document.querySelectorAll('section, div, img, a, button')].map(e => getComputedStyle(e).borderRadius).filter(r => r !== '0px');
  const cnt = {}; radii.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
  const heads = [...document.querySelectorAll('h1,h2,h3')].slice(0, 12).map(h => { const c = getComputedStyle(h); return `${h.tagName} ${c.fontSize}/${c.fontWeight} ${c.letterSpacing} ${c.color} :: ${h.textContent.trim().slice(0, 60)}`; });
  const logo = document.querySelector('header img, a[href="/"] img');
  return { radii: Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8), heads, logo: logo && logo.currentSrc, links: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href).slice(0, 5) };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
