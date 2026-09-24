import {chromium} from 'playwright-core';
import fs from 'node:fs';
const dir='../research-page-v2';fs.mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.goto('https://drinklinc.com',{waitUntil:'domcontentloaded'});await page.waitForTimeout(3500);
await page.screenshot({path:dir+'/linc-desktop.png'});await page.screenshot({path:dir+'/linc-desktop-full.png',fullPage:true});
fs.writeFileSync(dir+'/linc-dom.json',JSON.stringify(await page.evaluate(()=>({title:document.title,text:document.body.innerText,videos:[...document.querySelectorAll('video')].map(v=>({src:v.currentSrc,width:v.videoWidth,height:v.videoHeight,paused:v.paused})),headings:[...document.querySelectorAll('h1,h2')].map(e=>({text:e.textContent,font:getComputedStyle(e).fontSize,box:e.getBoundingClientRect().toJSON()}))})),null,2));
await page.setViewportSize({width:390,height:844});await page.reload({waitUntil:'domcontentloaded'});await page.waitForTimeout(2500);await page.screenshot({path:dir+'/linc-mobile.png'});await page.screenshot({path:dir+'/linc-mobile-full.png',fullPage:true});
await page.setViewportSize({width:1440,height:1000});
await page.goto('https://www.youtube.com/watch?v=8yh6XeUUU38',{waitUntil:'domcontentloaded'});await page.waitForTimeout(4000);
fs.writeFileSync(dir+'/youtube-page.txt',await page.locator('body').innerText());
await page.screenshot({path:dir+'/jack-youtube-page.png'});
for(const t of [275,485,735,1235]){await page.evaluate(t=>{let v=document.querySelector('video');if(v){v.currentTime=t;v.pause();}},t);await page.waitForTimeout(1800);await page.screenshot({path:dir+`/jack-${t}s.png`});}
console.log('Research captures saved in '+dir);await browser.close();
