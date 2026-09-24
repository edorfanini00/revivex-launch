import {chromium} from 'playwright-core';import assert from 'node:assert/strict';import fs from 'node:fs';
const manifest=JSON.parse(fs.readFileSync('public/assets/media-v2.json'));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const results=[];
for(const width of [1440,390])for(const reduced of [false,true]) {
 const page=await browser.newPage({viewport:{width,height:width===390?844:1000},reducedMotion:reduced?'reduce':'no-preference'});
 await page.goto('http://127.0.0.1:4178');await page.waitForTimeout(700);
 assert.ok(await page.locator('#hero-poster').evaluate(e=>e.complete&&e.naturalWidth>0));
 if(manifest.loop){
  const video=page.locator('#hero-media video');await video.waitFor({state:'attached'});
  if(reduced){assert.equal(await video.evaluate(v=>v.paused),true);assert.equal(await video.getAttribute('src'),null);await page.locator('#motion-toggle').click();}
  await page.waitForFunction(()=>document.querySelector('#hero-media video').currentTime>0);
  await page.locator('#motion-toggle').click();assert.equal(await video.evaluate(v=>v.paused),true);
  if(manifest.film){await page.locator('#watch-film').click();assert.equal(await page.locator('#film-dialog').evaluate(d=>d.open),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#film-dialog').evaluate(d=>d.open),false);assert.equal(await page.locator(':focus').getAttribute('id'),'watch-film');}
 }else{assert.equal(await page.locator('#motion-toggle').isVisible(),false);assert.equal(await page.locator('#watch-film').isVisible(),false);assert.equal(await page.locator('#hero-media video').count(),0);}
 results.push({width,reduced,mode:manifest.loop?'verified-v2-playback-pause-dialog':'real-v2-still-no-unavailable-controls'});await page.close();
}
await browser.close();fs.writeFileSync('evidence/media-qa.json',JSON.stringify(results,null,2));console.log(results);
