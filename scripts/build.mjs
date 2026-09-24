import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
for (const path of ['index.html','privacy.html','styles.css','app.js','assets/appliance-v9.webp','assets/manrope.ttf']) if(!fs.statSync(`public/${path}`).size) throw Error(`Missing ${path}`);
execFileSync('node',['--check','public/app.js'],{stdio:'inherit'});
execFileSync('python3',['-m','py_compile','server.py'],{stdio:'inherit'});
fs.mkdirSync('dist',{recursive:true});fs.cpSync('public','dist/public',{recursive:true});fs.copyFileSync('server.py','dist/server.py');
console.log('Built standalone public assets + Python/SQLite server into dist. No runtime packages required.');
