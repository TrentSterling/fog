import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),Three=require('../vendor/three.cjs');
const sources=['presets.js','fixed-step.js','interactions.js','app.js'].map(name=>({
  name,text:fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8')
}));
const copy=value=>JSON.parse(JSON.stringify(value));
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} differs from ${expected}`);

// Run the entire production app, including its normal initialization, input
// handlers and animation loop. Only browser/graphics boundaries and simulation
// execution are replaced. The controlled worker lets a result arrive between
// any two frames; no copy of the application's commit logic lives in this test.
function appHarness() {
  let now=0,timerId=0;
  const timers=new Map(),animationFrames=[],elements=new Map(),windowListeners=new Map();
  const gpuSteps=[],fogDraws=[],workers=[],mainSolvers=[],worldUpdates=[],slashRecords=[];
  const gl={getExtension:()=>null};
  class Element {
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.textContent='';this.width=0;this.height=0;this.listeners=new Map();this.queries=new Map();this.classes=new Set();this.style={setProperty(key,value){this[key]=value;}};
      this.classList={add:(...names)=>names.forEach(name=>this.classes.add(name)),remove:(...names)=>names.forEach(name=>this.classes.delete(name)),toggle:(name,force)=>{const value=force??!this.classes.has(name);if(value)this.classes.add(name);else this.classes.delete(name);return value;}};}
    set id(value){this._id=value;elements.set(value,this);}get id(){return this._id;}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    addEventListener(name,handler){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(handler);}
    dispatchEvent(event){for(const handler of this.listeners.get(event.type)||[])handler(event);}
    setAttribute(name,value){this[name]=value;}
    querySelector(selector){if(!this.queries.has(selector))this.queries.set(selector,new Element());return this.queries.get(selector);}
    getBoundingClientRect(){return {left:0,top:0,right:1000,bottom:600,width:1000,height:600};}
    getContext(){return gl;}
    focus(){}select(){}remove(){}setPointerCapture(){}
    showModal(){this.open=true;}close(){this.open=false;}
    click(){this.onclick?.({target:this});this.dispatchEvent({type:'click',target:this});}
  }
  const element=id=>{if(!elements.has(id)){const el=new Element();el.id=id;}return elements.get(id);};
  const document={hidden:false,body:new Element('body'),getElementById:element,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,addEventListener:Element.prototype.addEventListener,dispatchEvent:Element.prototype.dispatchEvent,listeners:new Map()};
  class Renderer {
    constructor({canvas}){this.canvas=canvas;this.shadowMap={};this.debug={};this.info={render:{calls:0,triangles:0},reset(){this.render.calls=this.render.triangles=0;}};}
    setPixelRatio(){}getContext(){return gl;}
    setSize(width,height){this.canvas.width=width;this.canvas.height=height;}
    setScissorTest(){}setRenderTarget(){}setViewport(){}setClearColor(){}clear(){}setScissor(){}
    render(){this.info.render.calls++;}
  }
  const world={scene:{},terrainGLSL:'',latest:null,
    terrainHeight:()=>0,getObstacles:()=>[],setObstacleCourse(){},setTerrain(){},setLighting(){},setEnvironment(){},
    update(time,dt,actors){this.latest={time,dt,actors:copy(actors)};worldUpdates.push(copy(this.latest));},
    recordSlash(segments,time){slashRecords.push({segments:copy(segments),time});}
  };
  class GPUField {
    constructor(renderer,noise,options={}){this.mode=options.mode;this.resolution=options.resolution;this.supported=true;this.passCount=this.mode==='hybrid'?1:25;this.uniforms={uWind:{value:0}};this.resets=0;this.texture={backend:this.mode,time:0};this.obstacleTexture={};}
    setObstacles(){}setResolution(value){this.resolution=value;}
    reset(){this.resets++;this.texture.time=0;}
    step(dt,time,interactors,settings,segments){this.texture.time=time;gpuSteps.push({mode:this.mode,dt,time,interactors:copy(interactors),settings:copy(settings),segments:copy(segments)});return true;}
    getDiagnostics(){return {supported:true};}prepareDebug(){}dispose(){this.disposed=true;}
  }
  class MainCPU extends GPUField {
    constructor(renderer,noise,options){super(renderer,noise,{...options,mode:'cpu'});this.execution='main';this.epoch=0;this.simulationTime=0;this.pending=false;this.fieldReady=true;this.needsResync=false;this.calls=[];this.passCount=0;mainSolvers.push(this);}
    reset(){super.reset();this.epoch++;this.simulationTime=0;this.needsResync=false;this.fieldReady=true;}
    step(dt,time,interactors,settings,segments){this.calls.push({dt,time,interactors:copy(interactors),settings:copy(settings),segments:copy(segments),epoch:this.epoch});this.simulationTime=this.texture.time=time;return true;}
  }
  class WorkerCPU extends MainCPU {
    constructor(...args){super(...args);mainSolvers.pop();this.execution='worker';this.pending=true;this.fieldReady=false;this.active=null;workers.push(this);}
    reset(){super.reset();if(this.execution==='worker'){this.pending=true;this.fieldReady=false;}else this.pending=false;}
    ready(){this.pending=false;this.fieldReady=true;this.simulationTime=this.texture.time=0;this.active=null;}
    step(dt,time,interactors,settings,segments){
      if(this.execution==='main')return super.step(dt,time,interactors,settings,segments);
      assert.equal(this.pending,false,'application must not submit a busy worker');
      const request={dt,time,interactors:copy(interactors),settings:copy(settings),segments:copy(segments),epoch:this.epoch};
      this.calls.push(request);this.active=request;this.pending=true;return true;
    }
    complete(request=this.active,{inspectionPending=false}={}){
      if(request.epoch!==this.epoch)return false;
      this.simulationTime=this.texture.time=request.time;this.pending=inspectionPending;this.fieldReady=true;this.active=null;return true;
    }
    fault({terminal=false}={}){this.execution='main';this.pending=false;this.needsResync=true;this.supported=!terminal;this.epoch++;this.fallbackReason='Controlled worker failure';}
  }
  class FogRenderer {
    constructor(){this.passCount=1;}
    render({time,mode,settings,fieldTexture,trails}){fogDraws.push({time,mode,settings:copy(settings),fieldTime:fieldTexture?.time??null,trails:copy(trails),actors:copy(world.latest.actors)});}
  }
  const F={FieldSimulation:GPUField,CPUFieldSimulation:MainCPU,CPUWorkerSimulation:WorkerCPU,FogRenderer,createWorld:()=>world,Credits:{render(){}}};
  const context=vm.createContext({FogLab:F,THREE:{...Three,WebGLRenderer:Renderer},document,performance:{now:()=>now},Math,Uint8Array,TextEncoder,TextDecoder,URL,Blob,Buffer,navigator:{},innerWidth:1000,devicePixelRatio:1,
    location:{href:'file:///FogLab.html',hash:'',reload(){}},
    console:{error(){},log(){}},CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail;}},ResizeObserver:class{observe(){}},
    requestAnimationFrame:callback=>{animationFrames.push(callback);return animationFrames.length;},
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,due:now+delay});return id;},clearTimeout:id=>timers.delete(id),
    addEventListener:(name,callback)=>{if(!windowListeners.has(name))windowListeners.set(name,[]);windowListeners.get(name).push(callback);},
    dispatchEvent:event=>{for(const callback of windowListeners.get(event.type)||[])callback(event);}
  });
  context.window=context;
  for(const {name,text} of sources)vm.runInContext(text,context,{filename:name});
  function frame(seconds=1/60){
    now+=seconds*1000;
    for(const [id,timer] of timers)if(timer.due<=now){timers.delete(id);timer.callback();}
    const callback=animationFrames.shift();assert.ok(callback,'application must keep scheduling display frames');callback(now);
    assert.deepEqual(Array.from(F.app.errors),[],'application frame must not fail');
  }
  frame(0);frame(.02);assert.equal(F.app.renderReady,true);
  function configure({execution='worker',paused=true,layout='compare',mode='cpu',compareMode='fluid'}={}){
    const preset=F.app.snapshotPreset();Object.assign(preset.settings,{cpuExecution:execution,paused,quality:'low'});Object.assign(preset.view,{mode,compareMode,layout,auto:true});
    F.app.applyPreset(preset,{silent:true});return F.app.sims.cpu;
  }
  return {app:F.app,frame,configure,element,world,worldUpdates,fogDraws,gpuSteps,workers,mainSolvers,slashRecords};
}

test('worker A/B holds actors, trails and shader time at the last completed tick',()=>{
  const h=appHarness(),cpu=h.configure();cpu.ready();h.frame(0);
  const initialActors=copy(h.world.latest.actors),initialDraws=h.fogDraws.length;
  assert.equal(h.app.physicsStep(1/30),true);
  const submittedActors=copy(h.app.state.actors),submittedTrails=copy(h.app.state.trails);
  near(h.app.runtime.submittedTime,1/30);assert.equal(h.app.runtime.renderTime,0);assert.equal(h.app.runtime.committedTicks,0);
  assert.notDeepEqual(submittedActors,initialActors);assert.ok(submittedTrails.length>0);
  assert.equal(h.app.physicsStep(1/30),false);assert.equal(cpu.calls.length,1);assert.equal(h.gpuSteps.length,0);
  assert.deepEqual(copy(h.app.state.actors),submittedActors,'busy frames must not advance input state');
  const cameraPosition=h.app.camera.position.clone(),canvas=h.element('viewport');
  canvas.dispatchEvent({type:'pointerdown',pointerId:1,button:0,clientX:100,clientY:100});
  canvas.dispatchEvent({type:'pointermove',pointerId:1,clientX:180,clientY:125});
  h.frame();h.frame();
  assert.equal(h.app.camera.position.equals(cameraPosition),false,'orbit controls must remain responsive during a pending solve');
  assert.deepEqual(h.world.latest.actors,initialActors);
  for(const draw of h.fogDraws.slice(initialDraws)){assert.equal(draw.time,0);assert.equal(draw.fieldTime,0);assert.deepEqual(draw.trails,[]);assert.deepEqual(draw.actors,initialActors);}
  cpu.complete();h.frame(0);
  near(h.app.runtime.renderTime,1/30);assert.equal(h.app.runtime.committedTicks,1);assert.equal(h.app.runtime.pending,false);
  assert.equal(h.gpuSteps.length,1);assert.deepEqual(h.world.latest.actors,submittedActors);
  for(const draw of h.fogDraws.slice(-2)){near(draw.time,1/30);near(draw.fieldTime,1/30);assert.deepEqual(draw.trails,submittedTrails);assert.deepEqual(draw.actors,submittedActors);}
});

test('delayed GPU work uses the accepted CPU settings and interactions snapshot',()=>{
  const h=appHarness(),cpu=h.configure();cpu.ready();h.frame(0);
  h.app.slash();h.frame(0);assert.equal(cpu.calls.length,1);
  const request=copy(cpu.calls[0]);assert.equal(request.segments.length,3);
  Object.assign(h.app.settings,{wind:1.8,pressure:32,radius:2.5,strength:.2});
  h.app.jump();cpu.complete();h.frame(0);
  assert.equal(h.gpuSteps.length,1);
  assert.deepEqual(h.gpuSteps[0].settings,request.settings);
  assert.deepEqual(h.gpuSteps[0].interactors,request.interactors);
  assert.deepEqual(h.gpuSteps[0].segments,request.segments);
  near(h.gpuSteps[0].time,request.time);
});

test('main-thread CPU commits synchronously and GPU-only scenes allocate no worker',()=>{
  const h=appHarness();assert.equal(h.workers.length,0);assert.equal(h.mainSolvers.length,0);
  const cpu=h.configure({execution:'main',paused:false});h.frame(0);h.frame(1/30);
  assert.equal(h.workers.length,0);assert.equal(cpu.calls.length,1);assert.equal(h.gpuSteps.length,1);
  assert.equal(h.app.runtime.pending,false);assert.equal(h.app.runtime.committedTicks,1);
  near(h.app.runtime.renderTime,1/30);assert.deepEqual(h.world.latest.actors,copy(h.app.state.actors));
  for(const draw of h.fogDraws.slice(-2)){near(draw.time,1/30);near(draw.fieldTime,1/30);}
});

test('reset discards the pending comparison and hides an obsolete CPU field during configuration',()=>{
  const h=appHarness(),cpu=h.configure();cpu.ready();h.app.physicsStep(1/30);cpu.complete();h.frame(0);
  h.app.physicsStep(1/30);const stale=cpu.active,stepCount=h.gpuSteps.length;
  h.app.reset(true);assert.equal(h.app.runtime.pending,false);assert.equal(h.app.runtime.renderTime,0);assert.equal(h.app.runtime.committedTicks,0);
  // Keep a previously displayed field resident, like the real adapter does
  // while waiting for its new configuration result. It must not be sampled.
  cpu.texture.time=1/30;h.app.settings.debug='velocity';h.app.settings.wireframe=true;h.frame(0);
  const preparing=h.fogDraws.slice(-2).find(draw=>draw.mode==='cpu');
  assert.equal(preparing.fieldTime,null);assert.equal(preparing.settings.density,0);
  assert.equal(preparing.settings.debug,'beauty');assert.equal(preparing.settings.wireframe,false);
  assert.equal(cpu.complete(stale),false);cpu.ready();h.frame(0);
  assert.equal(h.app.runtime.renderTime,0);assert.equal(h.gpuSteps.length,stepCount,'reset work must not replay a stale GPU batch');
  assert.equal(h.fogDraws.at(-2).fieldTime,0);
});

test('a paused single-step survives worker startup and completes exactly once',()=>{
  const h=appHarness(),cpu=h.configure();h.element('stepButton').click();
  for(let frame=0;frame<4;frame++)h.frame(1/30);
  assert.equal(h.app.runtime.submittedTime,0);assert.equal(cpu.calls.length,0);
  cpu.ready();h.frame(0);assert.equal(cpu.calls.length,1);near(h.app.runtime.submittedTime,1/30);
  for(let frame=0;frame<4;frame++)h.frame(1/30);
  assert.equal(cpu.calls.length,1);assert.equal(h.app.runtime.committedTicks,0);
  cpu.complete();h.frame(0);
  for(let frame=0;frame<4;frame++)h.frame(1/30);
  assert.equal(cpu.calls.length,1);assert.equal(h.app.runtime.committedTicks,1);near(h.app.runtime.renderTime,1/30);
});

test('completed simulation time commits even if a debug inspection is still busy',()=>{
  const h=appHarness(),cpu=h.configure();cpu.ready();h.app.physicsStep(1/30);
  cpu.complete(cpu.active,{inspectionPending:true});h.frame(0);
  assert.equal(cpu.pending,true);assert.equal(h.app.runtime.pending,false);assert.equal(h.app.runtime.committedTicks,1);
  assert.equal(h.gpuSteps.length,1);near(h.gpuSteps[0].time,1/30);
  assert.equal(h.app.physicsStep(1/30),false,'a debug task must not accept another worker solve');
  near(h.app.runtime.submittedTime,1/30);
});

test('a slow worker retains a bounded elapsed budget without submitting stale inputs',()=>{
  const h=appHarness(),cpu=h.configure({paused:false});cpu.ready();h.frame(0);h.frame(1/30);
  for(let frame=0;frame<90;frame++)h.frame(1/60);
  assert.equal(cpu.calls.length,1);assert.equal(h.gpuSteps.length,0);assert.equal(h.app.runtime.committedTicks,0);
  near(h.app.runtime.submittedTime,1/30);near(h.app.state.accumulator,.1);
  assert.ok(h.app.runtime.droppedSeconds>1.3);assert.equal(h.app.runtime.simulationHz,0);
  cpu.complete();h.frame(0);
  assert.equal(h.app.runtime.committedTicks,1);assert.equal(h.gpuSteps.length,1);assert.equal(cpu.calls.length,2);
  near(h.app.runtime.renderTime,1/30);near(h.app.runtime.submittedTime,2/30);near(h.app.state.accumulator,2/30);
  for(const draw of h.fogDraws.slice(-2)){near(draw.time,1/30);near(draw.fieldTime,1/30);}
});

test('worker failure restarts every backend and continues with the main-thread fallback',()=>{
  const h=appHarness(),cpu=h.configure();cpu.ready();h.app.physicsStep(1/30);cpu.complete();h.frame(0);
  h.app.physicsStep(1/30);
  const resets=Object.fromEntries(Object.entries(h.app.sims).map(([key,sim])=>[key,sim.resets]));
  cpu.fault();h.frame(0);
  assert.equal(h.app.runtime.cpuExecution,'main');assert.equal(h.app.runtime.pending,false);assert.equal(h.app.runtime.renderTime,0);assert.equal(h.app.runtime.submittedTime,0);assert.equal(h.app.runtime.committedTicks,0);
  for(const [key,sim] of Object.entries(h.app.sims))assert.ok(sim.resets>resets[key],`${key} must restart with the fallback`);
  assert.match(h.element('toast').textContent,/fallback.*fields restarted/i);
  assert.equal(h.workers.length,1,'a failed worker must not be recreated on every reset');
  assert.equal(h.app.physicsStep(1/30),true);h.frame(0);
  assert.equal(h.app.runtime.committedTicks,1);near(h.app.runtime.renderTime,1/30);
  for(const draw of h.fogDraws.slice(-2)){near(draw.time,1/30);near(draw.fieldTime,1/30);}
});

test('terminal CPU failure preserves the live graphics view through Analytical mode',()=>{
  const h=appHarness(),cpu=h.configure();cpu.fault({terminal:true});h.frame(0);
  assert.equal(h.app.renderReady,true);assert.equal(h.app.state.halted,false);assert.equal(h.app.state.mode,'analytical');
  assert.equal(h.app.sims.cpu,undefined);assert.equal(cpu.disposed,true);assert.equal(h.app.runtime.renderTime,0);
  assert.deepEqual(h.fogDraws.slice(-2).map(draw=>draw.mode),['analytical','fluid']);
  assert.equal(h.app.physicsStep(1/30),true);h.frame(0);near(h.app.runtime.renderTime,1/30);
});
