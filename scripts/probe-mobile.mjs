import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const p = await c.newPage();
const reqs = [];
p.on('request', r => { if (r.url().includes('/frames')) reqs.push(r.url().split('/assets/')[1]); });
await p.goto(process.argv[2] || 'http://127.0.0.1:4190/', { waitUntil: 'networkidle' });
await p.waitForTimeout(3000);
console.log('frame requests', reqs.length, reqs.slice(0, 2), reqs.slice(-1));
const H = await p.evaluate(() => document.getElementById('hero').offsetHeight - innerHeight);
for (const [i, f] of [0, 0.5, 0.98].entries()) {
  await p.evaluate(y => scrollTo(0, y), Math.round(H * f));
  await p.waitForTimeout(700);
  await p.screenshot({ path: `/tmp/mprobe-${i}.png` });
  console.log(f, await p.evaluate(() => ({ canvasW: heroCanvas.width, canvasH: heroCanvas.height, ready: heroCanvas.classList.contains('ready'), bar: heroBar.style.width })));
}
await b.close();
