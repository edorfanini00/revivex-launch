import { chromium } from 'playwright-core';
const sites = [
  ['timeline', 'https://www.timeline.com/'],
  ['seed', 'https://seed.com/']
];
const b = await chromium.launch({ channel: 'chrome' });
for (const [tag, url] of sites) {
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await c.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(5000);
  const H = await p.evaluate(() => document.documentElement.scrollHeight);
  const shots = Math.min(8, Math.ceil(H / 760));
  for (let i = 0; i < shots; i++) {
    await p.evaluate(y => scrollTo(0, y), i * 760);
    await p.waitForTimeout(1200);
    await p.screenshot({ path: `/tmp/${tag}-m-${i}.png` });
  }
  const metrics = await p.evaluate(() => [...document.querySelectorAll('h1,h2,h3,p,a,button')].slice(0,80).map(el => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    return { tag: el.tagName, text: el.innerText?.trim().slice(0,80), fs: cs.fontSize, lh: cs.lineHeight, fw: cs.fontWeight, w: Math.round(r.width), x: Math.round(r.x), y: Math.round(r.y) };
  }).filter(x => x.text));
  console.log('====', tag, 'H', H, 'shots', shots);
  console.log(JSON.stringify(metrics.slice(0,40), null, 2));
  await c.close();
}
await b.close();
