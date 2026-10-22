const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname,'../dist/data');
const essays = ['essays-a.json','essays-b.json'].flatMap(file=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'))).sort((a,b)=>a.day-b.day);
if(essays.length!==42 || new Set(essays.map(e=>e.day)).size!==42 || essays.some((e,i)=>e.day!==i+1))throw Error('Expected days 1–42 exactly.');
fs.writeFileSync(path.join(dir,'essays.js'),'window.ESSAYS = '+JSON.stringify(essays,null,2)+';\n','utf8');
console.log(`Assembled ${essays.length} original writing lessons.`);
