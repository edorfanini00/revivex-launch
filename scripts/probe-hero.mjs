import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
for (const [vp, mobile] of [[{ width: 1440, height: 900 }, false], [{ width: 390, height: 844 }, true]]) {
  const c = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
  const p = await c.newPage();
  await p.goto(process.argv[2] || 'http://127.0.0.1:4190/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  const H = await p.evaluate(() => document.getElementById('hero').offsetHeight - innerHeight);
  const out = [];
  for (const f of [0, 0.5, 0.97]) {
    await p.evaluate(y => scrollTo(0, y), Math.round(H * f));
    await p.waitForTimeout(500);
    out.push(await p.evaluate(() => {
      const cv = document.getElementById('heroCanvas');
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(Math.round(cv.width * 0.55), Math.round(cv.height * 0.55), 1, 1).data;
      return { ready: cv.classList.contains('ready'), w: cv.width, h: cv.height, px: [...d].slice(0, 3), bar: document.getElementById('heroBar').style.width };
    }));
  }
  console.log(mobile ? 'mobile' : 'desktop', JSON.stringify(out));
  await c.close();
}
await b.close();
