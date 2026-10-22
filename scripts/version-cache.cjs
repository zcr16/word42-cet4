const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const dist=path.resolve(__dirname,'../dist');
const files=['index.html','styles.css','app.js','engine.js','data/vocabulary.js','data/meta.js','data/learning.js','data/essays.js','manifest.webmanifest'];
const hash=crypto.createHash('sha256');files.forEach(f=>hash.update(fs.readFileSync(path.join(dist,f))));
const version=hash.digest('hex').slice(0,12);
const sw=path.join(dist,'sw.js');fs.writeFileSync(sw,fs.readFileSync(sw,'utf8').replace(/const CACHE = '[^']+';/,`const CACHE = 'word42-static-${version}';`));
console.log('Offline cache version: '+version);
