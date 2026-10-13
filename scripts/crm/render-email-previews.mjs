// Renders the CRM emails to HTML and PNG (600px and 375px, light and dark color scheme).
// Images are swapped to local files so previews do not depend on the deployed site.
// Usage: node scripts/crm/render-email-previews.mjs <output dir>
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { renderPreorderConfirmation, renderWelcome } from '../../lib/email/index.js';

const out = path.resolve(process.argv[2] || 'previews');
fs.mkdirSync(out, { recursive: true });
const publicDir = path.resolve(new URL('../../public', import.meta.url).pathname);
const origin = 'https://reserve.healthrevivex.com';
const emails = {
  'preorder-confirmation': renderPreorderConfirmation({ sessionId: 'cs_live_b1Q9xLmT0pZ3aR7kE5F6G7H8', email: 'pat.example@icloud.com', name: 'Pat Example', paidAt: '2026-10-13T15:00:00Z', origin }),
  welcome: renderWelcome({ firstName: 'Pat', unsubscribeUrl: `${origin}/api/unsubscribe?t=preview`, origin }),
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const files = [];
for (const [name, msg] of Object.entries(emails)) {
  fs.writeFileSync(path.join(out, `${name}.html`), msg.html);
  fs.writeFileSync(path.join(out, `${name}.txt`), msg.text);
  const local = msg.html.replaceAll(`${origin}/assets/`, `file://${publicDir}/assets/`);
  const tmp = path.join(out, `.${name}.local.html`);
  fs.writeFileSync(tmp, local);
  for (const width of [600, 375]) {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
      await page.goto(`file://${tmp}`);
      await page.waitForLoadState('networkidle');
      const f = path.join(out, `${name}-${width}-${scheme}.png`);
      await page.screenshot({ path: f, fullPage: true });
      files.push(f);
      await page.close();
    }
  }
  fs.unlinkSync(tmp);
}
await browser.close();
console.log(files.join('\n'));
