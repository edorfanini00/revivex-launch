import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.BASE_URL||'http://127.0.0.1:4178';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const evidence={base,errors:[],screens:[],checks:[]};
for (const width of [1440,390]) {
 const context=await browser.newContext({viewport:{width,height:width===390?844:1000},deviceScaleFactor:1,isMobile:width===390,reducedMotion:'reduce'});
 const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')evidence.errors.push(m.text())});
 await page.goto(base);await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>[...document.images].filter(i=>i.loading!=='lazy').every(i=>i.complete&&i.naturalWidth>0));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
 await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').textContent(),'Skip to content');
 await page.locator('h1').click();
 await page.screenshot({path:`evidence/desktop-${width}.png`,fullPage:false});
 for (const el of await page.locator('section').all()) {await el.scrollIntoViewIfNeeded();await page.waitForTimeout(90);}
 const lazyLoaded = await page.evaluate(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0));assert.ok(lazyLoaded,'all product images loaded');
 await page.screenshot({path:`evidence/full-${width}.png`,fullPage:true});
 await page.locator('#waitlist').scrollIntoViewIfNeeded();
 await page.screenshot({path:`evidence/signup-${width}.png`});
 assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior),'auto');
 await page.locator('details').first().locator('summary').click();assert.ok(await page.locator('details').first().getAttribute('open')!==null);
 await page.goto(base+'/privacy');assert.ok(await page.locator('h1').textContent());
 evidence.checks.push(`${width}px: no overflow, fonts/images loaded, keyboard skip link, reduced motion, FAQ, privacy`);
 if(width===390){
  await page.goto(base+'/#waitlist');await page.waitForTimeout(1200);
  await page.locator('#email').fill('invalid');await page.locator('button[type=submit]').click();
  assert.equal(await page.locator('#email').evaluate(e=>e.validity.valid),false);
  await page.locator('#email').fill('browser-qa@example.test');await page.locator('button[type=submit]').click();
  assert.equal(await page.locator('input[name=consent]').evaluate(e=>e.validity.valid),false);
  await page.locator('input[name=consent]').check();await page.locator('button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#form-status').textContent.includes('Your interest is saved'));
  await page.screenshot({path:'evidence/signup-success-390.png'});
  await page.waitForTimeout(1200);await page.locator('#email').fill('browser-qa@example.test');await page.locator('input[name=consent]').check();await page.locator('button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#form-status').textContent.includes('Your interest is saved'));
  await page.waitForTimeout(1200);await page.locator('#email').fill('browser-error@example.test');await page.locator('input[name=consent]').check();await page.route('**/api/signup',route=>route.abort());await page.locator('button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#form-status').classList.contains('error'));
  await page.screenshot({path:'evidence/signup-error-390.png'});await page.unroute('**/api/signup');
  evidence.checks.push('UI invalid email, required consent, real HTTP signup, duplicate, network error recovery state');
 }
 await context.close();
}
// Browser logs include the intentionally aborted request only.
evidence.errors=evidence.errors.filter(x=>!x.includes('ERR_FAILED'));
assert.deepEqual(evidence.errors,[]);
const normal=await browser.newContext({viewport:{width:768,height:1024}});const page=await normal.newPage();await page.goto(base);await page.locator('#waitlist').scrollIntoViewIfNeeded();await page.waitForTimeout(900);assert.equal(await page.locator('.waitlist-headline').evaluate(e=>getComputedStyle(e).opacity),'1');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.locator('#email').focus();await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').getAttribute('type'),'submit');await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').getAttribute('name'),'consent');assert.equal(await page.locator(':focus').evaluate(e=>getComputedStyle(e).outlineStyle),'solid');await normal.close();evidence.checks.push('768px no overflow, normal-motion reveal visible, keyboard email → submit → consent and visible focus');
fs.writeFileSync('evidence/browser-qa.json',JSON.stringify(evidence,null,2));await browser.close();console.log(JSON.stringify(evidence,null,2));
