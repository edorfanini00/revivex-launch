// Full-page QA screenshots at desktop + mobile, with scroll so reveals fire.
import { chromium } from 'playwright-core';
const url = process.argv[2] || 'http://127.0.0.1:4190/';
const tag = process.argv[3] || 'v10';
const browser = await chromium.launch({ channel: 'chrome' });
for (const [name, vp, mobile] of [['d', { width: 1440, height: 900 }, false], ['m', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/${tag}-${name}-hero0.png` });
  const H = await page.evaluate(() => document.getElementById('hero').offsetHeight - innerHeight);
  await page.evaluate(h => scrollTo(0, h * 0.95), H);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `/tmp/${tag}-${name}-hero1.png` });
  // scroll through to trigger reveals
  const total = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < total; y += 500) { await page.evaluate(v => scrollTo(0, v), y); await page.waitForTimeout(60); }
  await page.waitForTimeout(1200);
  await page.evaluate(() => { document.getElementById('hero').style.height = '100vh'; document.querySelectorAll('.reveal').forEach(e => e.classList.add('in')); });
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `/tmp/${tag}-${name}-full.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(name, 'overflowX', overflow, 'errors', JSON.stringify(errs));
  await ctx.close();
}
await browser.close();
