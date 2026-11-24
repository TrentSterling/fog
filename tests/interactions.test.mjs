import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context=vm.createContext({module:{exports:{}}});
vm.runInContext(fs.readFileSync(new URL('../src/interactions.js',import.meta.url),'utf8'),context);
const I=context.module.exports;
const actor=()=>({x:0,z:0,heading:0,jump:0,verticalVelocity:0,slashAge:99});

test('jump emits exactly one grounded landing and cannot restart in mid-air',()=>{
  for(const dt of [1/30,1/60]){
    const a=actor();assert.equal(I.beginJump(a),true);assert.equal(I.beginJump(a),false);
    let landings=0,peak=0;
    for(let i=0;i<2/dt;i++){if(I.advanceJump(a,dt))landings++;peak=Math.max(peak,a.jump);}
    assert.equal(landings,1);assert.equal(a.jump,0);assert.equal(a.verticalVelocity,0);
    assert.ok(peak>.8&&peak<.85);assert.equal(I.beginJump(a),true);
  }
});

test('swept blade sources join continuously even while the actor moves',()=>{
  const a=actor();assert.equal(I.beginSlash(a),true);assert.equal(I.beginSlash(a),false);
  let last=null,count=0;
  for(let i=0;i<20;i++){
    a.x+=.03;a.z-=.015;const sources=I.advanceSlash(a,1/30,1.35);
    if(!sources.length)continue;count++;
    assert.equal(sources.length,3);
    if(last)for(let j=0;j<3;j++){
      assert.ok(Math.abs(sources[j].x0-last[j].x1)<1e-10);
      assert.ok(Math.abs(sources[j].z0-last[j].z1)<1e-10);
    }
    for(const s of sources)for(const key of ['x0','z0','x1','z1','vx','vz','radius','strength'])assert.ok(Number.isFinite(s[key]));
    last=sources;
  }
  assert.equal(count,13);assert.equal(I.advanceSlash(a,1/30).length,0);
  assert.equal(I.beginSlash(a),true);
});

test('a fast movement cannot tunnel through a pillar',()=>{
  const solids=[{x:0,z:0,radius:.72}];
  const result=I.resolveMotion({x:-2,z:0},{x:2,z:0},solids,.23);
  assert.ok(result.x<=-.95+1e-9);assert.ok(Math.hypot(result.x,result.z)>=.95-1e-9);
  const clear=I.resolveMotion({x:-2,z:2},{x:2,z:2},solids,.23);
  assert.ok(Math.abs(clear.x-2)<1e-9);assert.equal(clear.z,2);
});
