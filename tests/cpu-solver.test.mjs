import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const Solver=require('../src/cpu-solver.js');
const settings={wind:0,swirl:.8,vorticity:0,pressure:18,persistence:5.2,strength:1,radius:1.35};
const solver=(resolution=64,worldSize=32)=>{const value=new Solver({resolution,worldSize});value.reset({wind:0});return value;};

test('pressure projection reduces a smooth compressible field with solid boundaries',()=>{
  const s=solver(),n=s.resolution;
  s.setObstacles([{x:1,z:-2,radius:1.7}]);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
    const i=y*n+x,envelope=Math.sin(Math.PI*x/(n-1))*Math.sin(Math.PI*y/(n-1));
    s.u[i]=Math.sin(x*.3)*envelope;s.v[i]=Math.cos(y*.25)*envelope;
  }
  s.projectVelocity(32);
  const result=s.getDiagnostics();
  assert.ok(result.divergenceBeforeRMS>.1);
  assert.equal(result.projectionMeasured,true,'direct projection counts even before a simulation tick');
  assert.ok(result.divergenceAfterRMS<result.divergenceBeforeRMS*.7,JSON.stringify(result));
  assert.equal(result.solidSpeedMax,0);assert.equal(result.normalSpeedMax,0);
});

test('standing actors clear occupied fog without manufacturing momentum',()=>{
  const s=solver(),center=(s.resolution/2)*s.resolution+s.resolution/2,initial=s.density[center];
  for(let tick=0;tick<24;tick++)s.step(1/30,tick/30,[{x:0,z:0,vx:0,vz:0,radius:1.35,strength:1}],settings);
  assert.ok(s.density[center]<initial*.08);
  assert.ok(s.energy[center]>.5);
  assert.equal(s.getDiagnostics().speedMax,0);
  assert.ok(s.density[0]>initial*.99);
});

test('a swept slash clears every crossed cell, including between its endpoints',()=>{
  const s=solver(),n=s.resolution,row=n/2-1,initial=s.density[row*n+n/2];
  s.step(1/20,0,[],settings,[{x0:-4,z0:-.25,x1:4,z1:-.25,radius:.35,strength:2,vx:0,vz:0,swirl:0}]);
  let checked=0;
  for(let x=0;x<n;x++)if(Math.abs(s.coordinates[x])<3.9) {
    assert.ok(s.density[row*n+x]<initial*.08,`uncleared interior cell ${x}`);checked++;
  }
  assert.equal(checked,16);
  assert.equal(s.density[(row-8)*n+n/2],initial);
});

test('obstacle-aware advection cannot transport density through a thin wall',()=>{
  const s=solver(64,8),n=s.resolution;
  const wall=Array.from({length:n},(_,y)=>({x:0,z:s.coordinates[y],radius:.13}));
  s.setObstacles(wall);
  s.equilibrium.fill(0);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
    const i=y*n+x;s.u[i]=10;s.v[i]=0;s.density[i]=!s.mask[i]&&s.coordinates[x]<0?1:0;
  }
  for(let tick=0;tick<5;tick++)s.step(1/20,tick/20,[],{...settings,pressure:2,persistence:12});
  let leaked=0;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(s.coordinates[x]>0&&!s.mask[y*n+x])leaked=Math.max(leaked,s.density[y*n+x]);
  assert.equal(leaked,0);
  const result=s.getDiagnostics();
  assert.ok(result.solidCellCount>0);assert.equal(result.solidDensityMax,0);assert.equal(result.solidSpeedMax,0);
});

test('all local wake styles and a strong slash remain finite at the longest allowed step',()=>{
  const s=solver(32);s.setObstacles([{x:0,z:0,radius:2},{x:-3,z:2,radius:.8}]);
  for(const wakeStyle of ['paired','radial','tangential'])for(let tick=0;tick<24;tick++) {
    s.step(1/20,tick/20,[
      {x:-3+tick*.15,z:1,vx:9,vz:-5,radius:.35,strength:2.5},
      {x:Infinity,z:0,vx:NaN,vz:0},
      {x:1e308,z:-1e308,vx:1e308,vz:NaN,radius:NaN,strength:Infinity}
    ],{...settings,wakeStyle,strength:2.5,swirl:2.5,vorticity:1.8,wind:2,persistence:.6,pressure:32},[
      {x0:-3,z0:0,x1:3,z1:2,radius:.3,strength:4,vx:12,vz:3,swirl:4},
      {x0:1e308,z0:1e308,x1:-1e308,z1:-1e308,radius:NaN,strength:NaN,vx:Infinity,vz:NaN}
    ]);
  }
  const result=s.getDiagnostics();
  assert.equal(result.finite,true);assert.ok(result.speedMax<=10.00001);
  assert.ok(result.densityMin>=0&&result.densityMax<=1.650001);
  assert.equal(result.solidDensityMax,0);assert.equal(result.solidSpeedMax,0);assert.equal(result.normalSpeedMax,0);
  const before=Float32Array.from(s.density);assert.equal(s.step(NaN,0),false);assert.deepEqual(s.density,before);
});

test('reset reproduces the same field and replay after activity and resolution changes',()=>{
  const s=solver(32);s.setObstacles([{x:2,z:-3,radius:1}]);
  const replay=()=>{for(let tick=0;tick<12;tick++)s.step(1/30,tick/30,[{x:tick*.1,z:0,vx:3,vz:0,radius:1,strength:1}],{...settings,wind:.32,vorticity:.38});};
  s.reset({wind:.32});
  const resetDiagnostics=s.getDiagnostics();
  assert.deepEqual([resetDiagnostics.projectionMeasured,resetDiagnostics.divergenceReduction],[false,null],'reset must not invent a reduction percentage');
  replay();const first=s.packRGBA(new Float32Array(32*32*4));
  s.reset({wind:.32});replay();assert.deepEqual(s.packRGBA(new Float32Array(first.length)),first);
  s.setResolution(64);assert.equal(s.mask.length,64*64);assert.ok(s.solidCellCount>0);
  s.setResolution(32);s.reset({wind:.32});replay();assert.deepEqual(s.packRGBA(new Float32Array(first.length)),first);
});

test('CPU adapter exposes an uploadable field without float render-target support',()=>{
  const T=require('../vendor/three.cjs');
  const noise=new T.DataTexture(new Uint8Array([128,128,128,128]),1,1,T.RGBAFormat,T.UnsignedByteType);
  const context=vm.createContext({window:{FogLab:{CPUFluidSolver:Solver},THREE:T},performance});
  vm.runInContext(fs.readFileSync(new URL('../src/cpu-sim.js',import.meta.url),'utf8'),context);
  const Adapter=context.window.FogLab.CPUFieldSimulation;
  for(const floatLinear of [true,false]) {
    const renderer={getContext:()=>({getExtension:name=>name==='OES_texture_float_linear'&&floatLinear?{}:null})};
    const simulation=new Adapter(renderer,noise,{resolution:32,worldSize:32});
    simulation.reset({wind:0});simulation.setObstacles([{x:0,z:0,radius:2}]);
    simulation.step(1/30,1/30,[{x:-3,z:0,vx:2,vz:0,radius:1,strength:1}],{...settings,debug:'pressure'});
    assert.equal(simulation.supported,true);assert.equal(simulation.passCount,0);
    assert.equal(simulation.texture.image.width,32);assert.equal(simulation.velocityTexture,simulation.texture);
    assert.equal(simulation.texture.type,floatLinear?T.FloatType:T.HalfFloatType);
    assert.equal(simulation.pressureTexture.image.data,simulation.solver.pressure);
    assert.equal(simulation.uploadBytesPerTick,32*32*(floatLinear?20:12));
    assert.equal(simulation.obstacleTexture.format,T.RedFormat);
    const expected=simulation.solver.density[0],encoded=simulation.texture.image.data[2];
    assert.ok(Math.abs((floatLinear?encoded:T.DataUtils.fromHalfFloat(encoded))-expected)<.0005);
    simulation.prepareDebug('curl');simulation.dispose();assert.equal(simulation.disposed,true);
  }
});
