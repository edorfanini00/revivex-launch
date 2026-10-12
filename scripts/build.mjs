import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
// Usage: node scripts/build.mjs [--out <dir>]   (default: dist)
const outArg = process.argv.indexOf('--out');
const out = outArg > -1 ? process.argv[outArg + 1] : 'dist';
if (!out) throw Error('--out needs a directory');
for (const p of ['index.html','privacy.html','deposit-terms.html','reservation.html','styles.css','app.js','legal.js','reservation.js','assets/appliance-v9.webp','assets/manrope.ttf']) if(!fs.statSync(`public/${p}`).size) throw Error(`Missing ${p}`);
for (const f of ['public/app.js','public/legal.js','public/reservation.js',...fs.readdirSync('api').map(f=>`api/${f}`),...fs.readdirSync('lib').map(f=>`lib/${f}`)]) execFileSync('node',['--check',f],{stdio:'inherit'});
JSON.parse(fs.readFileSync('vercel.json','utf8'));
execFileSync('python3',['-m','py_compile','server.py'],{stdio:'inherit'});
fs.mkdirSync(out,{recursive:true});fs.cpSync('public',path.join(out,'public'),{recursive:true});fs.copyFileSync('server.py',path.join(out,'server.py'));
console.log(`Built static public assets into ${out}/public (plus legacy Python preview server). Vercel serves public/ and api/ directly.`);
