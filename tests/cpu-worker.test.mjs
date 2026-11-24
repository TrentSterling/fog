import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {Worker as NodeWorker} from 'node:worker_threads';

const require=createRequire(import.meta.url),T=require('../vendor/three.cjs');
const Solver=require('../src/cpu-solver.js'),FieldUtils=require('../src/field-utils.js');
const read=name=>fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const source=['field-utils.js','cpu-solver.js','cpu-worker.js'].map(read).join('\n');
// The browser message API is the only shim. All solver/protocol source below
// runs unchanged in an actual worker_threads isolate, with real transfers.
const bridge=`const {parentPort}=require('node:worker_threads');
globalThis.self=globalThis;
globalThis.addEventListener=(name,listener)=>{if(name==='message')parentPort.on('message',data=>listener({data}));};
globalThis.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);
`;
const settings={wind:.32,swirl:.8,vorticity:.38,pressure:18,persistence:5.2,strength:1.2,radius:1.35,debug:'beauty'};
const obstacles=[{x:2,z:-2,radius:1.3}];
const actor=tick=>[{x:-2+tick*.1,z:1,vx:3,vz:.4,radius:1.35,strength:1}];
const noiseImage=()=>({data:new Uint8Array([140,165,128,132,180,120,120,150,120,210,145,115,210,100,111,140]),width:2,height:2});
const waitFor=async(predicate,timeout=5000)=>{
  const started=performance.now();
  while(!predicate()) {if(performance.now()-started>timeout)throw new Error('Timed out waiting for worker test.');await new Promise(resolve=>setTimeout(resolve,3));}
};
const settled=simulation=>waitFor(()=>!simulation.pending);

function adapterHarness(options={}) {
  const urls=new Map(),workers=[],posts=[];let nextURL=0,revoked=0;
  class LocalBlob {constructor(parts){this.source=parts.join('');}}
  const objectURL={createObjectURL(blob){const key='blob:test-'+(++nextURL);urls.set(key,blob);return key;},revokeObjectURL(key){if(urls.delete(key))revoked++;}};
  class BrowserWorker {
    constructor(url) {
      if(options.constructorFailure)throw new Error('Worker constructor refused by test.');
      this.terminated=false;
      this.native=new NodeWorker(bridge+urls.get(url).source,{eval:true});workers.push(this);
      this.native.on('message',data=>{
        if(options.dropMessages)return;
        if(options.wrongGeneration)data={...data,generation:data.generation+100};
        const deliver=()=>{if(!this.terminated)this.onmessage?.({data});};
        if(options.delayMessages)setTimeout(deliver,options.delayMessages);else deliver();
      });
      this.native.on('error',error=>this.onerror?.({message:error.message,preventDefault(){}}));
    }
    postMessage(message,transfer=[]) {
      posts.push({type:message.type,generation:message.generation,recycled:message.recycle?.length||0});
      this.native.postMessage(message,transfer);
    }
    terminate(){this.terminated=true;void this.native.terminate();}
  }
  const F={CPUFluidSolver:Solver,FieldUtils,cpuWorkerSource:options.source??source};
  const context=vm.createContext({window:{FogLab:F,THREE:T},performance,Worker:options.unavailable?undefined:BrowserWorker,
    Blob:LocalBlob,URL:objectURL,setTimeout,clearTimeout,ArrayBuffer,Float32Array,Uint16Array,Uint8Array});
  vm.runInContext(read('cpu-sim.js'),context);vm.runInContext(read('cpu-worker-sim.js'),context);
  if(options.fallbackFailure)F.CPUFieldSimulation=class {constructor(){throw new Error('Main fallback allocation failed in test.');}};
  const image=noiseImage(),noise=new T.DataTexture(image.data,image.width,image.height,T.RGBAFormat,T.UnsignedByteType);
  const renderer={getContext:()=>({getExtension:name=>name==='OES_texture_float_linear'&&options.floatLinear!==false?{}:null})};
  const sim=new F.CPUWorkerSimulation(renderer,noise,{resolution:32,worldSize:32,workerTimeoutMs:options.timeout??5000});
  return {sim,noise,workers,posts,urls,get revoked(){return revoked;},async close(){sim.dispose();await Promise.all(workers.map(worker=>worker.native.terminate()));}};
}

test('exact classic worker protocol matches synchronous solver and recycles transferred packets',async()=>{
  const worker=new NodeWorker(bridge+source,{eval:true});let id=0;
  const pending=new Map();worker.on('message',message=>{const callback=pending.get(message.id);pending.delete(message.id);callback?.(message);});
  const call=(type,payload={},transfers=[])=>new Promise(resolve=>{const request={type,id:++id,generation:1,debug:'beauty',...payload};pending.set(request.id,resolve);worker.postMessage(request,transfers);});
  try {
    const image=noiseImage(),sync=new Solver({resolution:32,noise:noiseImage()});sync.setObstacles(obstacles);sync.reset(settings);
    let packet=await call('configure',{resolution:32,worldSize:32,noise:image,obstacles,settings,half:false},[image.data.buffer]);
    assert.equal(image.data.byteLength,0,'the test must exercise a real transferable');
    assert.deepEqual(new Float32Array(packet.state),sync.packRGBA(new Float32Array(32*32*4)));
    const packetSizes=[];
    for(let tick=1;tick<=8;tick++) {
      const previous=packet.state;packetSizes.push(previous.byteLength);
      packet=await call('step',{dt:1/30,time:tick/30,interactors:actor(tick),settings,recycle:[{kind:'state',buffer:previous}]},[previous]);
      assert.equal(previous.byteLength,0);
      sync.step(1/30,tick/30,actor(tick),settings);
      assert.deepEqual(new Float32Array(packet.state),sync.packRGBA(new Float32Array(32*32*4)));
    }
    assert.ok(packetSizes.every(bytes=>bytes===32*32*16));
    assert.equal(packet.buffersCreated,1);assert.equal(packet.buffersReused,8);
    const time=packet.simulationTime;
    const inspect=await call('inspect',{debug:'pressure',recycle:[{kind:'state',buffer:packet.state}]},[packet.state]);
    assert.equal(inspect.state,null);assert.equal(inspect.simulationTime,time);
    assert.deepEqual(new Float32Array(inspect.aux),sync.pressure);
  } finally {await worker.terminate();}
});

test('adapter rejects busy steps, preserves Three upload arrays, and commits only completed simulation time',async()=>{
  const h=adapterHarness();
  try {
    assert.equal(h.sim.pending,true);assert.equal(h.sim.step(1/30,1/30,[],settings),false);
    assert.equal(h.sim.fieldReady,false);
    h.sim.setObstacles(obstacles);h.sim.reset(settings);await settled(h.sim);
    assert.equal(h.sim.fieldReady,true);
    const stableArray=h.sim.texture.image.data,atlas=h.noise.image.data,epoch=h.sim.epoch;
    const sync=new Solver({resolution:32,noise:noiseImage()});sync.setObstacles(obstacles);sync.reset(settings);
    for(let tick=1;tick<=4;tick++) {
      assert.equal(h.sim.step(1/30,tick/30,actor(tick),settings),true);
      assert.equal(h.sim.pending,true);assert.equal(h.sim.step(1/30,tick/30,actor(tick),settings),false);
      assert.equal(h.sim.simulationTime,(tick-1)/30);
      await settled(h.sim);sync.step(1/30,tick/30,actor(tick),settings);
      assert.equal(h.sim.texture.image.data,stableArray);assert.equal(stableArray.byteLength,32*32*16);
      assert.equal(atlas.byteLength,16,'the shared atlas remains attached');
      assert.deepEqual(stableArray,sync.packRGBA(new Float32Array(stableArray.length)));
      assert.equal(h.sim.simulationTime,tick/30);assert.equal(h.sim.epoch,epoch);
    }
    assert.equal(h.sim.execution,'worker');assert.equal(h.posts.filter(p=>p.type==='step').length,4);
    assert.ok(h.sim.buffersReused>=3);assert.equal(h.sim.uploadBytesPerTick,32*32*16);
    assert.ok(h.sim.lastStepMs>=h.sim.lastSolveMs);assert.ok(h.sim.lastRoundTripMs>=0);
  } finally {await h.close();}
});

test('resets and resizes supersede an in-flight solve without applying its stale field',async()=>{
  const h=adapterHarness({delayMessages:12});
  try {
    h.sim.reset(settings);await settled(h.sim);
    const committed=[];h.sim.onStateChange=sim=>{if(!sim.pending)committed.push({epoch:sim.epoch,time:sim.simulationTime,resolution:sim.resolution});};
    assert.equal(h.sim.step(1/30,1/30,actor(1),settings),true);
    const stepEpoch=h.sim.epoch;
    h.sim.reset({...settings,wind:1});h.sim.setResolution(64);h.sim.setObstacles([{x:-1,z:2,radius:2}]);h.sim.reset({...settings,wind:.17});
    assert.ok(h.sim.epoch>stepEpoch);assert.equal(h.sim.simulationTime,0);assert.equal(h.sim.pending,true);
    await settled(h.sim);
    const sync=new Solver({resolution:64,noise:noiseImage()});sync.setObstacles([{x:-1,z:2,radius:2}]);sync.reset({...settings,wind:.17});
    assert.deepEqual(h.sim.texture.image.data,sync.packRGBA(new Float32Array(64*64*4)));
    assert.equal(h.sim.simulationTime,0);assert.equal(committed.some(event=>event.time!==0),false);
    const afterStep=h.posts.slice(h.posts.findIndex(post=>post.type==='step')+1);
    assert.equal(afterStep.filter(post=>post.type==='configure').length,1,'configurations coalesce instead of queuing');
  } finally {await h.close();}
});

test('paused debug switches refresh auxiliary arrays without advancing or replacing state',async()=>{
  const h=adapterHarness();
  try {
    h.sim.reset(settings);await settled(h.sim);
    h.sim.step(1/30,1/30,actor(1),settings);await settled(h.sim);
    const state=Float32Array.from(h.sim.texture.image.data),time=h.sim.simulationTime;
    h.sim.prepareDebug('pressure');assert.equal(h.sim.pending,true);await settled(h.sim);
    assert.equal(h.sim.simulationTime,time);assert.deepEqual(h.sim.texture.image.data,state);
    assert.ok(h.sim.pressureTexture.image.data.some(value=>value!==0));
    h.sim.prepareDebug('curl');h.sim.prepareDebug('divergence');await settled(h.sim);
    assert.equal(h.sim.simulationTime,time);assert.ok(h.sim.divergenceTexture.image.data.some(value=>value!==0));
    assert.equal(h.sim.getDiagnostics().pending,false);
    assert.equal(h.posts.filter(post=>post.type==='step').length,1);
  } finally {await h.close();}
});

test('worker packs the half-float fallback off-thread and leaves texture backing storage attached',async()=>{
  const h=adapterHarness({floatLinear:false});
  try {
    h.sim.reset(settings);await settled(h.sim);
    const array=h.sim.texture.image.data;
    h.sim.step(1/30,1/30,actor(1),{...settings,debug:'pressure'});await settled(h.sim);
    assert.equal(h.sim.texture.image.data,array);assert.equal(array.byteLength,32*32*8);
    assert.equal(h.sim.texture.type,T.HalfFloatType);assert.equal(h.sim.uploadBytesPerTick,32*32*12);
    const sync=new Solver({resolution:32,noise:noiseImage()});sync.reset(settings);sync.step(1/30,1/30,actor(1),settings);
    const expected=sync.packRGBA(new Float32Array(32*32*4));
    for(let i=0;i<array.length;i++)assert.ok(Math.abs(T.DataUtils.fromHalfFloat(array[i])-expected[i])<.002);
  } finally {await h.close();}
});

test('unavailable workers and constructor errors fall back explicitly and require comparison resynchronization',async()=>{
  for(const options of [{unavailable:true},{constructorFailure:true}]) {
    const h=adapterHarness(options);
    try {
      assert.equal(h.sim.execution,'main');assert.equal(h.sim.pending,false);assert.equal(h.sim.needsResync,true);
      assert.ok(h.sim.fallbackReason);assert.equal(h.sim.step(1/30,1/30,actor(1),settings),false);
      h.sim.reset(settings);assert.equal(h.sim.needsResync,false);
      assert.equal(h.sim.step(1/30,1/30,actor(1),settings),true);assert.equal(h.sim.simulationTime,1/30);
      assert.equal(h.sim.getDiagnostics().finite,true);assert.equal(h.urls.size,0);
    } finally {await h.close();}
  }
});

test('worker errors and timeouts terminate the worker and expose a reset main-thread fallback',async()=>{
  for(const options of [{source:source+'\nthrow new Error("worker test fault");'},{dropMessages:true,timeout:30}]) {
    const h=adapterHarness(options);
    try {
      await waitFor(()=>h.sim.execution==='main');
      assert.equal(h.sim.pending,false);assert.equal(h.sim.needsResync,true);assert.equal(h.sim.simulationTime,0);
      assert.ok(h.sim.fallbackReason);assert.equal(h.urls.size,0);assert.equal(h.revoked,1);
      assert.ok(h.workers.every(worker=>worker.terminated));
      h.sim.reset({...settings,wind:.2});assert.equal(h.sim.step(1/30,1/30,actor(1),settings),true);
      assert.equal(h.sim.simulationTime,1/30);
    } finally {await h.close();}
  }
});

test('disposal cancels pending work, revokes its Blob URL, and ignores late replies',async()=>{
  const h=adapterHarness({delayMessages:30});
  try {
    assert.equal(h.sim.pending,true);h.sim.dispose();
    assert.equal(h.sim.pending,false);assert.equal(h.urls.size,0);assert.equal(h.revoked,1);
    const epoch=h.sim.epoch;await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(h.sim.epoch,epoch);assert.equal(h.sim.step(1/30,1/30,actor(1),settings),false);
    assert.ok(h.workers.every(worker=>worker.terminated));
  } finally {await h.close();}
});

test('a mismatched response generation fails explicitly instead of leaving a blank idle worker',async()=>{
  const h=adapterHarness({wrongGeneration:true});
  try {
    await waitFor(()=>h.sim.execution==='main');
    assert.match(h.sim.fallbackReason,/generation/);assert.equal(h.sim.needsResync,true);
    assert.equal(h.sim.pending,false);assert.equal(h.sim.fieldReady,true);
  } finally {await h.close();}
});

test('failure of both worker and main fallback remains settled and unavailable after reset',async()=>{
  const h=adapterHarness({unavailable:true,fallbackFailure:true});
  try {
    assert.equal(h.sim.supported,false);assert.equal(h.sim.pending,false);assert.equal(h.sim.fieldReady,false);
    assert.match(h.sim.fallbackReason,/Main-thread fallback failed/);
    h.sim.reset(settings);h.sim.setResolution(64);h.sim.setObstacles(obstacles);h.sim.prepareDebug('pressure');
    assert.equal(h.sim.pending,false);assert.equal(h.sim.fieldReady,false);assert.equal(h.sim.step(1/30,1/30,actor(1),settings),false);
    assert.equal(h.sim.getDiagnostics().supported,false);
  } finally {await h.close();}
});
