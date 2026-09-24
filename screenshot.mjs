import { chromium } from 'playwright-core';
import fs from 'fs';

const chromePaths = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Users/edorfanini/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
];
const executablePath = chromePaths.find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
console.log('Using browser:', executablePath || 'playwright-core default');

const browser = await chromium.launch({ 
  executablePath: executablePath || undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

async function screenshotPage(width, outPath) {
  const page = await browser.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto('http://127.0.0.1:4178/', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1000);
  
  // Scroll to trigger IntersectionObserver on all fade-up elements
  await page.evaluate(async () => {
    const total = document.body.scrollHeight;
    const step = 300;
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300));
  });
  
  await page.waitForTimeout(1000);
  await page.screenshot({ path: outPath, fullPage: true });
  await page.close();
  console.log(`${width}px → ${outPath}`);
}

await screenshotPage(1440, 'evidence/desktop-v9-1440.png');
await screenshotPage(390, 'evidence/desktop-v9-390.png');
await browser.close();
console.log('Screenshots saved.');
