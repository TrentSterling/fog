#!/usr/bin/env node
/* Reproducible visual checks of the production Three.js modules. This runs a
 * native Mesa GLES context, not Chromium, and does not measure GPU performance. */
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto'),os=require('os');
const options={source:path.resolve(__dirname,'../..'),out:path.resolve('visual-output')};
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];
  if(key==='--help'){console.log('node scripts/visual/capture.cjs --variants variants.json [--source repo] [--out directory] [--width 960] [--height 540] [--only id] [--ticks 180,210,240]');process.exit(0);}
  if(!key.startsWith('--')||!process.argv[i+1])throw Error('Expected --option value; use --help.');
  options[key.slice(2)]=process.argv[++i];
}
const ROOT=path.resolve(options.source),OUT=path.resolve(options.out);
const config=options.variants?JSON.parse(fs.readFileSync(options.variants,'utf8')):{variants:[{id:'baseline'}]};
const variants=Array.isArray(config)?config:config.variants;
if(!Array.isArray(variants)||!variants.length)throw Error('Variants must be an array, or an object with a nonempty variants array.');
const base=Array.isArray(config)?{}:config.defaults||{};
const W=Number(options.width||config.width||960),H=Number(options.height||config.height||540);
if(!Number.isInteger(W)||!Number.isInteger(H)||W<64||H<64||W>4096||H>4096)throw Error('Invalid capture dimensions.');
fs.mkdirSync(OUT,{recursive:true});
const dependency=name=>require(require.resolve(name,{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||ROOT,ROOT]}));
const THREE=require(path.join(ROOT,'vendor/three.cjs')),sharp=dependency('sharp');
const {NativeGL}=require('./native_webgl.js');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
globalThis.THREE=THREE;globalThis.window=globalThis;globalThis.self={cancelAnimationFrame(){}};
const modules=['presets.js','field-utils.js','interactions.js','world.js','sim.js','cpu-solver.js','cpu-sim.js','fog.js'];
const moduleSHA256={};
for(const file of modules){const source=fs.readFileSync(path.join(ROOT,'src',file),'utf8');moduleSHA256[file]=sha(source);vm.runInThisContext(source,{filename:file});}
const F=globalThis.FogLab,appSource=fs.readFileSync(path.join(ROOT,'src/app.js'),'utf8');
moduleSHA256['app.js']=sha(appSource);moduleSHA256['vendor/three.cjs']=sha(fs.readFileSync(path.join(ROOT,'vendor/three.cjs')));
const begin=appSource.indexOf('function createNoiseAtlas(){'),end=appSource.indexOf('\n  function paneConfigs()',begin);
if(begin<0||end<0)throw Error('Cannot locate production createNoiseAtlas source; update capture extraction.');
const noise=new Function('T','clamp',appSource.slice(begin,end)+'\nreturn createNoiseAtlas();')(THREE,clamp);
const noiseSHA256=sha(Buffer.from(noise.image.data));
const gl=new NativeGL({width:W,height:H});
const renderer=new THREE.WebGLRenderer({canvas:gl.canvas,context:gl,antialias:false,alpha:false});
renderer.setPixelRatio(1);renderer.setSize(W,H,false);renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;renderer.autoClear=false;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.info.autoReset=false;
renderer.debug.checkShaderErrors=true;
renderer.debug.onShaderError=(g,p,v,f)=>{throw Error('Shader compilation failed: '+g.getShaderInfoLog(v)+' '+g.getShaderInfoLog(f)+' '+g.getProgramInfoLog(p));};
const manifest={
  provenance:'Actual production Three.js modules and fog shaders rendered through a native Mesa GLES software context. These are not browser screenshots, generated illustrations, or hardware performance benchmarks. CPU captures use the synchronous CPU adapter.',
  renderer:gl.getParameter(gl.RENDERER),glVersion:gl.getParameter(gl.VERSION),source:ROOT,
  width:W,height:H,fixedHz:30,moduleSHA256,noiseSHA256,
  cameraPolicy:'Locked capture framing: actor target follows without the app RAF smoothing; production terrain-height camera clamp is applied. Identical camera coordinates are recorded for comparison.',
  captures:[]
};
const writeManifest=()=>fs.writeFileSync(path.join(OUT,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
writeManifest();
function position(t,motion){
  if(motion==='still')return {x:0,z:2};
  if(motion==='straight')return {x:t*.8-4,z:2};
  return {x:Math.sin(t*.30)*5.2,z:2+Math.sin(t*.30*1.47)*3.7};
}
function identifier(value){if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))throw Error('Use letters, numbers, _ and - in capture identifiers.');return value;}
function fieldFingerprint(sim,mode){
  if(mode==='analytical')return null;
  let raw,format;
  if(mode==='cpu'){
    raw=sim.texture?.image?.data;format=sim.uploadFormat;
    if(!ArrayBuffer.isView(raw))throw Error('CPU uploaded field bytes are unavailable.');
  }else{
    const target=sim._state?.[sim._stateIndex];
    if(!target||target.texture!==sim.texture)throw Error('GPU completed field target is unavailable.');
    raw=new Uint16Array(sim.resolution*sim.resolution*4);format='RGBA16F';
    // readRenderTargetPixels restores its framebuffer binding and performs no
    // simulation draw, texture write, ping-pong swap, or state integration.
    renderer.readRenderTargetPixels(target,0,0,sim.resolution,sim.resolution,raw);
  }
  const bytes=Buffer.from(new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength));
  if(os.endianness()==='BE'){if(raw.BYTES_PER_ELEMENT===2)bytes.swap16();else if(raw.BYTES_PER_ELEMENT===4)bytes.swap32();}
  return {sha256:sha(bytes),format,byteOrder:'little-endian',bytes:bytes.length,width:sim.resolution,height:sim.resolution,channels:['velocityX','velocityZ','density','energy'],source:mode==='cpu'?'Completed CPU texture upload array':'Completed GPU state render target'};
}
async function runVariant(input){
  const spec={mode:'fluid',render:'raymarch',motion:'walk',ticks:[180],...base,...input};
  spec.settings={...F.Presets.DEFAULT_SETTINGS,...base.settings,...input.settings};
  spec.camera={...F.Presets.DEFAULT_CAMERA,...base.camera,...input.camera};
  spec.id=identifier(spec.id);
  const settings=spec.settings;
  const ticks=[...new Set((options.ticks?options.ticks.split(',').map(Number):spec.ticks).map(Number))].sort((a,b)=>a-b);
  if(!ticks.length||ticks.some(t=>!Number.isInteger(t)||t<0||t>36000))throw Error('Ticks must be nonnegative integers up to 36000.');
  const tickSet=new Set(ticks),shots=spec.shots||[{id:'follow'}];
  const slashTicks=new Set(spec.slashTicks||[]),jumpTicks=new Set(spec.jumpTicks||[]),pulseTicks=new Set(spec.pulseTicks||[]);
  const world=F.createWorld(THREE),fog=new F.FogRenderer(renderer,noise,world.terrainGLSL);
  const camera=new THREE.PerspectiveCamera(48,W/H,.1,150);
  const sceneRT=new THREE.WebGLRenderTarget(W,H,{type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:true,stencilBuffer:false});
  sceneRT.texture.colorSpace=THREE.NoColorSpace;sceneRT.depthTexture=new THREE.DepthTexture(W,H,THREE.UnsignedIntType);sceneRT.depthTexture.format=THREE.DepthFormat;
  world.setTerrain(settings.terrain);world.setEnvironment(settings.environment);world.setLighting(settings.lighting);world.setObstacleCourse(settings.obstacleCourse);
  const sim=spec.mode==='cpu'?new F.CPUFieldSimulation(renderer,noise,{resolution:settings.resolution,worldSize:32}):new F.FieldSimulation(renderer,noise,{mode:spec.mode==='hybrid'?'hybrid':'fluid',resolution:settings.resolution,worldSize:32});
  sim.setObstacles(world.getObstacles(),settings.obstacles);if(sim.uniforms?.uWind)sim.uniforms.uWind.value=settings.wind;sim.reset(settings);fog.setQuality(settings.quality);
  let time=0,lastStamp=-1,trails=[],pulseAge=99,pulseX=0,pulseZ=0;
  const actor={...position(0,spec.motion),vx:0,vz:0,heading:0,radius:settings.radius,strength:1,jump:0,verticalVelocity:0,slashAge:99};
  world.update(0,1/30,[actor],settings);
  async function capture(tick){
    const diagnostics=spec.mode==='analytical'?null:sim.getDiagnostics();
    if(diagnostics&&!diagnostics.finite)throw Error('Nonfinite simulation for '+spec.id);
    const field=fieldFingerprint(sim,spec.mode);
    for(const shot of shots){
      const shotId=identifier(shot.id||'follow'),cam={...spec.camera,...shot.camera};
      const target=cam.target?new THREE.Vector3(...cam.target):new THREE.Vector3(actor.x,world.terrainHeight(actor.x,actor.z)+(cam.targetHeight??.72),actor.z);
      if(cam.position)camera.position.fromArray(cam.position);else camera.position.set(target.x+Math.sin(cam.theta)*Math.sin(cam.phi)*cam.distance,target.y+Math.cos(cam.phi)*cam.distance,target.z+Math.cos(cam.theta)*Math.sin(cam.phi)*cam.distance);
      camera.position.y=Math.max(camera.position.y,world.terrainHeight(camera.position.x,camera.position.z)+.35);
      camera.fov=cam.fov||48;camera.lookAt(target);camera.updateProjectionMatrix();camera.updateMatrixWorld();
      renderer.info.reset();renderer.setScissorTest(false);renderer.setRenderTarget(sceneRT);renderer.setViewport(0,0,W,H);renderer.setClearColor(0x162b2c,1);renderer.clear(true,true,true);renderer.render(world.scene,camera);
      renderer.setRenderTarget(null);renderer.setViewport(0,0,W,H);renderer.setScissor(0,0,W,H);renderer.setScissorTest(false);renderer.setClearColor(0x102023,1);renderer.clear(true,true,true);
      sim.prepareDebug?.(settings.debug);
      fog.render({camera,sceneTexture:sceneRT.texture,depthTexture:sceneRT.depthTexture,width:W,height:H,time,settings,mode:spec.mode,renderMode:spec.render,fieldTexture:sim.texture,velocityTexture:sim.velocityTexture,pressureTexture:sim.pressureTexture,curlTexture:sim.curlTexture,divergenceTexture:sim.divergenceTexture,obstacleTexture:sim.obstacleTexture,trails,target:null});
      renderer.setRenderTarget(null);renderer.setScissorTest(false);renderer.setViewport(0,0,W,H);gl.finish();
      const filename=spec.id+'-'+shotId+'-'+String(tick).padStart(5,'0')+'.png';await gl.capture(path.join(OUT,filename));
      const glError=gl.getError();if(glError)throw Error('GLES error 0x'+glError.toString(16)+' for '+filename);
      const stat=await sharp(path.join(OUT,filename)).stats();if(stat.channels.slice(0,3).every(c=>c.stdev<.5))throw Error('Blank capture '+filename);
      const bytes=fs.readFileSync(path.join(OUT,filename));
      manifest.captures.push({variant:spec.id,shot:shotId,filename,tick,seconds:time,mode:spec.mode,render:spec.render,motion:spec.motion,settings,actor:{...actor},cameraPosition:camera.position.toArray(),cameraTarget:target.toArray(),cameraFov:camera.fov,sourceSHA256:moduleSHA256,noiseSHA256,rawFieldSHA256:field?.sha256||null,field,sha256:sha(bytes),draws:renderer.info.render.calls,triangles:renderer.info.render.triangles,diagnostics,bytes:bytes.length});
      writeManifest();console.log('[saved] '+path.join(OUT,filename));
    }
  }
  console.log('[variant] '+spec.id+' at ticks '+ticks.join(','));
  try{
    if(tickSet.has(0))await capture(0);
    for(let tick=1;tick<=ticks[ticks.length-1];tick++){
      const dt=1/30;time=tick/30;pulseAge+=dt;
      if(slashTicks.has(tick))F.Interactions.beginSlash(actor);
      if(jumpTicks.has(tick))F.Interactions.beginJump(actor);
      const old={x:actor.x,z:actor.z},desired=position(time,spec.motion),p=settings.obstacles?F.Interactions.resolveMotion(old,desired,world.getObstacles(),.23):desired;
      Object.assign(actor,p);actor.vx=clamp((p.x-old.x)/dt,-9,9);actor.vz=clamp((p.z-old.z)/dt,-9,9);
      if(Math.hypot(actor.vx,actor.vz)>.04)actor.heading=Math.atan2(-actor.vx,-actor.vz);
      if(F.Interactions.advanceJump(actor,dt)||pulseTicks.has(tick)){pulseAge=0;pulseX=actor.x;pulseZ=actor.z;}
      actor.strength=clamp(1-actor.jump/Math.max(settings.height,.3),.15,1);
      const segments=F.Interactions.advanceSlash(actor,dt,settings.radius);world.recordSlash(segments,time);
      let interactors=[actor];
      if(pulseAge<.7){const radius=.3+pulseAge*7;for(let i=0;i<7;i++){const angle=i*Math.PI*2/7;interactors.push({x:pulseX+Math.cos(angle)*radius,z:pulseZ+Math.sin(angle)*radius,vx:Math.cos(angle)*8,vz:Math.sin(angle)*8,radius:settings.radius*.85,strength:1.6*(1-pulseAge/.8)});}}
      for(const trail of trails)trail.age+=dt;trails=trails.filter(trail=>trail.age<settings.persistence*3);
      if(time-lastStamp>=.12||pulseAge<.7){for(const item of interactors)trails.unshift({...item,age:0});lastStamp=time;}
      for(const s of segments)trails.unshift({x:s.x1,z:s.z1,x0:s.x0,z0:s.z0,radius:s.radius,age:0,strength:s.strength,vx:s.vx,vz:s.vz});trails=trails.slice(0,24);
      if(spec.mode!=='analytical')sim.step(dt,time,interactors,settings,segments);world.update(time,dt,[actor],settings);
      if(tickSet.has(tick))await capture(tick);
    }
  }finally{sim.dispose();sceneRT.dispose();fog.dispose();world.dispose();}
}
(async()=>{try{for(const spec of variants.filter(v=>!options.only||v.id===options.only))await runVariant(spec);console.log('[complete] '+manifest.captures.length+' native GLES captures');}finally{noise.dispose();renderer.dispose();gl.close();}})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
