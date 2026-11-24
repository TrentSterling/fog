#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const args={seed:'fog-review',columns:'2','tile-width':'640'};
for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw Error('Expected --inputs images.json --out directory [--seed text --columns 2 --tile-width 640]');args[process.argv[i].slice(2)]=process.argv[i+1];}
if(!args.inputs||!args.out)throw Error('Required: --inputs images.json --out directory');
const sharp=require(require.resolve('sharp',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||process.cwd(),process.cwd()]}));
const inputs=JSON.parse(fs.readFileSync(args.inputs,'utf8')).map(item=>typeof item==='string'?{file:item}:item);
if(!inputs.length||inputs.length>26)throw Error('Provide between 1 and 26 images.');
let state=crypto.createHash('sha256').update(args.seed).digest().readUInt32LE();
const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
for(let i=inputs.length-1;i>0;i--){let j=Math.floor(random()*(i+1));[inputs[i],inputs[j]]=[inputs[j],inputs[i]];}
const out=path.resolve(args.out),blind=path.join(out,'blind');fs.mkdirSync(blind,{recursive:true});
const columns=Number(args.columns),tileWidth=Number(args['tile-width']),tileHeight=Math.round(tileWidth*9/16),header=36;
if(!Number.isInteger(columns)||columns<1||columns>6||!Number.isInteger(tileWidth)||tileWidth<128)throw Error('Invalid sheet dimensions.');
(async()=>{
 const key=[],layers=[];
 for(let i=0;i<inputs.length;i++){
   const label=String.fromCharCode(65+i),file=path.resolve(inputs[i].file),original=fs.readFileSync(file);
   fs.writeFileSync(path.join(blind,label+'.png'),original);
   const x=i%columns*tileWidth,y=Math.floor(i/columns)*(tileHeight+header);
   const title=Buffer.from('<svg width="'+tileWidth+'" height="'+header+'"><rect width="100%" height="100%" fill="#111a1b"/><text x="16" y="26" fill="#e1ece5" font-family="sans-serif" font-size="24">'+label+'</text></svg>');
   const png=await sharp(original).resize(tileWidth,tileHeight,{fit:'contain',background:'#111a1b'}).png().toBuffer();
   layers.push({input:title,left:x,top:y},{input:png,left:x,top:y+header});
   key.push({...inputs[i],file,label,sha256:crypto.createHash('sha256').update(original).digest('hex')});
 }
 await sharp({create:{width:tileWidth*columns,height:(tileHeight+header)*Math.ceil(inputs.length/columns),channels:3,background:'#111a1b'}}).composite(layers).png().toFile(path.join(blind,'sheet.png'));
 fs.writeFileSync(path.join(out,'key.json'),JSON.stringify({seed:args.seed,provenance:'Unmodified rendered images, anonymously shuffled for review; overview thumbnails resize without enhancement.',images:key},null,2)+'\n');
 console.log(path.join(blind,'sheet.png'));
})().catch(e=>{console.error(e);process.exitCode=1;});
