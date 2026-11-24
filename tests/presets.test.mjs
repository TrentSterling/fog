import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({TextEncoder,TextDecoder,URL,Buffer,module:{exports:{}},btoa,atob});
vm.runInContext(fs.readFileSync(new URL('../src/presets.js',import.meta.url),'utf8'),context);
const P = context.module.exports;
const json = value => JSON.parse(JSON.stringify(value));
const minimal = () => ({format:'FogLab',version:1,settings:{},view:{}});
const rejects = (fn,code) => assert.throws(fn,error=>error.name==='PresetError'&&(!code||error.code===code));

test('complete setup round-trips through a canonical base64url fragment',()=>{
  const preset=P.defaultPreset();
  Object.assign(preset.settings,{height:1.7,quality:'high',meshLayers:4,terrain:'hills',paused:true,wireframe:true,debug:'velocity',cpuExecution:'main'});
  Object.assign(preset.view,{mode:'hybrid',renderer:'mesh',layout:'compare',compareMode:'fluid',compareRenderer:'raymarch',auto:false,actorCount:4});
  Object.assign(preset.camera,{theta:-2.1,phi:1.35,distance:22,mode:0});
  const hash=P.encodeHash(preset);
  assert.match(hash,/^#preset=[A-Za-z0-9_-]+$/);
  assert.deepEqual(json(P.decodeHash(hash)),json(P.validatePreset(preset)));
  assert.equal(P.decodeHash(hash).settings.resolution,256);
  assert.equal(P.encodeHash(P.decodeHash(hash)),hash);
});

test('empty fragments are absent; malformed and unsupported links never normalize silently',()=>{
  for(const hash of ['', '#',null,undefined])assert.equal(P.decodeHash(hash),null);
  for(const hash of ['#preset=','#preset=a','#preset=***','#preset=YWJj=','#preset=YWJj&mode=fluid','#preset=!!!!'])rejects(()=>P.decodeHash(hash),'MALFORMED_LINK');
  rejects(()=>P.decodeHash('#another-format=abc'),'UNSUPPORTED_LINK');
  rejects(()=>P.decodeHash('#preset='+Buffer.from('{not-json').toString('base64url')),'MALFORMED_PRESET');
  rejects(()=>P.decodeHash('#preset='+Buffer.from([0xff,0xfe]).toString('base64url')),'MALFORMED_LINK');
});

test('noncanonical base64 padding bits are rejected',()=>{
  // ZA is canonical base64url for "d"; ZB decodes to the same byte but is not.
  rejects(()=>P.decodeHash('#preset=ZB'),'MALFORMED_LINK');
});

test('size limits apply before decoding, JSON parsing, and whitelist normalization',()=>{
  rejects(()=>P.decodeHash('#preset='+'a'.repeat(P.MAX_ENCODED_CHARS+1)),'PRESET_TOO_LARGE');
  rejects(()=>P.parseJSON(' '.repeat(P.MAX_JSON_BYTES+1)),'PRESET_TOO_LARGE');
  rejects(()=>P.validatePreset({...minimal(),unused:'x'.repeat(P.MAX_JSON_BYTES)}),'PRESET_TOO_LARGE');
  rejects(()=>P.validatePreset({...minimal(),unused:'☁'.repeat(Math.floor(P.MAX_JSON_BYTES/2))}),'PRESET_TOO_LARGE');
  const text=JSON.stringify({...minimal(),unused:'x'.repeat(P.MAX_JSON_BYTES)});
  rejects(()=>P.decodeHash('#preset='+Buffer.from(text).toString('base64url')),'PRESET_TOO_LARGE');
});

test('numeric settings clamp safely and only quality controls field allocation',()=>{
  const input=minimal();
  input.settings={density:-10,height:100,radius:99,strength:-1,pressure:22.7,raySteps:99,resolution:1e9,quality:'low'};
  input.camera={theta:999,phi:-4,distance:1};
  const value=P.validatePreset(input);
  assert.equal(value.settings.density,0);assert.equal(value.settings.height,2.8);
  assert.equal(value.settings.radius,2.7);assert.equal(value.settings.strength,0);
  assert.equal(value.settings.pressure,23);assert.equal(value.settings.raySteps,48);
  assert.equal(value.settings.resolution,64);
  assert.equal(value.camera.theta,100);assert.equal(value.camera.phi,.07);assert.equal(value.camera.distance,7);
  for(const bad of [NaN,Infinity,-Infinity,'1',null])rejects(()=>P.validatePreset({...minimal(),settings:{density:bad}}));
});

test('enums, booleans and structures are validated rather than coerced',()=>{
  for(const settings of [{terrain:'ocean'},{quality:'ultra'},{debug:'javascript:alert(1)'},{meshLayers:3},{wireframe:'true'},{paused:1},{cpuExecution:'remote'}])rejects(()=>P.validatePreset({...minimal(),settings}));
  for(const view of [{mode:'compute'},{renderer:'raster'},{layout:'quad'},{actorCount:2},{auto:'false'},{compareRenderer:'none'}])rejects(()=>P.validatePreset({...minimal(),view}));
  rejects(()=>P.validatePreset({...minimal(),camera:{mode:7}}));
  for(const input of [null,[],{...minimal(),settings:[]},{...minimal(),view:null},{...minimal(),camera:[]}])rejects(()=>P.validatePreset(input));
});

test('unknown keys and hostile prototype names cannot inject application state',()=>{
  const input=JSON.parse('{"format":"FogLab","version":1,"settings":{"density":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"time":999},"view":{"mode":"analytical","ready":true,"halted":true,"actors":[{"x":999}]},"camera":{"theta":0.2,"position":[99,99,99]},"time":999,"trails":[1]}');
  const output=P.validatePreset(input);
  assert.equal(output.settings.density,1);assert.equal(output.view.mode,'analytical');assert.equal(output.camera.theta,.2);
  for(const object of [output,output.settings,output.view,output.camera]){
    assert.equal(Object.hasOwn(object,'__proto__'),false);assert.equal(Object.hasOwn(object,'constructor'),false);
    assert.equal(Object.hasOwn(object,'time'),false);assert.equal(Object.hasOwn(object,'actors'),false);
    assert.equal(Object.hasOwn(object,'ready'),false);assert.equal(Object.hasOwn(object,'halted'),false);
  }
  assert.equal({}.polluted,undefined);
  const inherited=Object.create({auto:false,mode:'hybrid'});
  assert.equal(P.validatePreset({...minimal(),view:inherited}).view.auto,true);
  assert.equal(P.validatePreset({...minimal(),view:inherited}).view.mode,'fluid');
});

test('missing fields always use isolated defaults, never a previous experiment',()=>{
  const first=P.validatePreset({...minimal(),settings:{height:2.8,terrain:'hills',meshLayers:4},view:{auto:false},camera:{theta:99}});
  first.settings.density=0;first.view.renderer='mesh';first.camera.distance=48;
  const second=P.validatePreset(minimal());
  assert.deepEqual(json(second.settings),json(P.DEFAULT_SETTINGS));
  assert.deepEqual(json(second.view),json(P.DEFAULT_VIEW));
  assert.deepEqual(json(second.camera),json(P.DEFAULT_CAMERA));
  second.settings.height=.2;assert.equal(P.defaultPreset().settings.height,1.22);
});

test('legacy version 1 JSON remains compatible; future versions are explicit errors',()=>{
  const old={format:'FogLab',version:1,settings:{density:.93,height:1.25,resolution:128},view:{mode:'hybrid',renderer:'mesh',layout:'single',compareMode:'fluid',compareRenderer:'same',actorCount:1}};
  const normalized=P.parseJSON(JSON.stringify(old));
  assert.equal(normalized.settings.density,.93);assert.equal(normalized.settings.height,1.25);
  assert.equal(normalized.view.auto,true);assert.equal(normalized.settings.meshLayers,1);
  assert.equal(normalized.settings.cpuExecution,'worker');
  assert.deepEqual(json(normalized.camera),json(P.DEFAULT_CAMERA));
  rejects(()=>P.validatePreset({...old,version:2}),'UNSUPPORTED_VERSION');
  rejects(()=>P.validatePreset({...old,version:'1'}),'UNSUPPORTED_VERSION');
  rejects(()=>P.validatePreset({...old,format:'AnotherTool'}));
});

test('file-open sharing uses canonical hosting; web sharing uses the current origin and path',()=>{
  const value=P.defaultPreset();
  assert.ok(P.buildShareURL(value,'file:///tmp/FogLab.html').startsWith('https://tront.xyz/fog/#preset='));
  assert.ok(P.buildShareURL(value,'https://example.test/my/fog/?tracking=1#old').startsWith('https://example.test/my/fog/#preset='));
  assert.ok(P.buildShareURL(value,'http://localhost:8080/fog/index.html').startsWith('http://localhost:8080/fog/index.html#preset='));
  assert.ok(P.buildShareURL(value,undefined).startsWith('https://tront.xyz/fog/#preset='));
});

test('v0.2 CPU, obstacles and shape choices survive a shared link',()=>{
  const value=P.defaultPreset();
  Object.assign(value.settings,{obstacles:false,obstacleCourse:true,wakeStyle:'tangential',densityProfile:'column',heightMode:'terrain',detailStrength:.4,heightShear:1.3,lightingModel:'ambient',debug:'obstacles'});
  Object.assign(value.view,{mode:'cpu',layout:'compare',compareMode:'fluid'});
  const restored=P.decodeHash(P.encodeHash(value));
  assert.deepEqual(json(restored),json(value));
  for(const settings of [{obstacles:'false'},{obstacleCourse:1},{heightMode:'valleySimulation'},{wakeStyle:'unknown'}])rejects(()=>P.validatePreset({...minimal(),settings}));
});

test('wisp control preserves zero, bounds imports, and defaults old presets safely',()=>{
  assert.equal(P.validatePreset(minimal()).settings.wispStrength,1);
  for(const [input,expected] of [[0,0],[.65,.65],[-3,0],[9,1.5]]){
    const preset=P.validatePreset({...minimal(),settings:{wispStrength:input}});
    assert.equal(P.decodeHash(P.encodeHash(preset)).settings.wispStrength,expected);
  }
  for(const bad of [NaN,Infinity,'1',null])rejects(()=>P.validatePreset({...minimal(),settings:{wispStrength:bad}}));
});


test('three-way view keeps its selected card on a visible backend',()=>{
  const preset=P.validatePreset({...minimal(),view:{mode:'cpu',layout:'triple'}});
  assert.equal(preset.view.mode,'fluid');
});
