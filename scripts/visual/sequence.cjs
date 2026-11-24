#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const args={shot:'follow'};
for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw Error('Expected --manifest file --variant id --out movie.mp4 [--shot follow]');args[process.argv[i].slice(2)]=process.argv[i+1];}
if(!args.manifest||!args.variant||!args.out)throw Error('Required: --manifest file --variant id --out movie.mp4');
const manifest=JSON.parse(fs.readFileSync(args.manifest,'utf8')),directory=path.dirname(path.resolve(args.manifest));
const frames=manifest.captures.filter(f=>f.variant===args.variant&&f.shot===args.shot).sort((a,b)=>a.tick-b.tick);
if(frames.length<2)throw Error('Capture at least two frames for a motion sequence.');
const stride=frames[1].tick-frames[0].tick;
if(stride<1||frames.some((f,i)=>i&&f.tick-frames[i-1].tick!==stride))throw Error('Motion sequence needs regularly spaced ticks.');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fog-sequence-'));
try{
 for(let i=0;i<frames.length;i++)fs.copyFileSync(path.join(directory,frames[i].filename),path.join(temp,String(i).padStart(6,'0')+'.png'));
 fs.mkdirSync(path.dirname(path.resolve(args.out)),{recursive:true});
 const result=cp.spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-framerate',String((manifest.fixedHz||30)/stride),'-i',path.join(temp,'%06d.png'),'-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',path.resolve(args.out)],{stdio:'inherit'});
 if(result.error)throw result.error;if(result.status!==0)throw Error('FFmpeg failed with status '+result.status);
 fs.writeFileSync(path.resolve(args.out)+'.json',JSON.stringify({provenance:manifest.provenance,variant:args.variant,shot:args.shot,firstTick:frames[0].tick,lastTick:frames.at(-1).tick,frameCount:frames.length,simulationHz:manifest.fixedHz||30,framesPerSecond:(manifest.fixedHz||30)/stride,sourceManifest:path.resolve(args.manifest)},null,2)+'\n');
 console.log(path.resolve(args.out));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
