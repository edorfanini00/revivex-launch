// Screenshot the v14 scenes, steps and gallery on laptop + phone; report broken images.
import { chromium } from 'playwright-core';
const url = process.argv[2] || 'http://127.0.0.1:4190/';
const tag0 = process.argv[3] || 'v14';
const b = await chromium.launch({ channel: 'chrome' });
for (const [w, h, mob, tag, dsf] of [[1440, 900, false, 'd', 1], [390, 844, true, 'm', 2]]) {
  const c = await b.newContext({ viewport: { width: w, height: h }, isMobile: mob, hasTouch: mob, deviceScaleFactor: dsf });
  const p = await c.newPage();
  await p.goto(url, { waitUntil: 'networkidle' });
  const H = await p.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < H; y += 500) { await p.evaluate(v => scrollTo(0, v), y); await p.waitForTimeout(100); }
  await p.waitForTimeout(1500);
  await p.addStyleTag({ content: '.reveal{opacity:1!important;transform:none!important;transition:none!important}.nav{display:none!important}' });
  const broken = await p.evaluate(() => [...document.images].filter(i => i.complete && !i.naturalWidth).map(i => i.src));
  console.log(tag, 'broken', broken.length, broken.slice(0, 3));
  const scenes = await p.$$('.scene');
  let k = 0;
  for (const el of scenes) await el.screenshot({ path: `/tmp/${tag0}-${tag}-scene${k++}.png` });
  for (const s of ['#how', '#details']) { const el = await p.$(s); if (el) await el.screenshot({ path: `/tmp/${tag0}-${tag}-${s.slice(1)}.png` }); }
}
await b.close();
