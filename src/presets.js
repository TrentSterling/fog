/* FogLab experiment setup codec. Pure, DOM-free, and shared by imports,
 * public API calls, and URL fragments. A setup restarts at time zero; it never
 * contains a GPU field, actor positions, replay history, or application state.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FogLab = root.FogLab || {};
  root.FogLab.Presets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_JSON_BYTES = 12 * 1024;
  const MAX_ENCODED_CHARS = 16 * 1024;
  const CANONICAL_URL = 'https://tront.xyz/fog/';
  const DEFAULT_SETTINGS = Object.freeze({
    density:1.25,height:1.22,radius:1.35,strength:1.20,swirl:0.8,persistence:5.2,wind:.32,
    pressure:18,vorticity:.38,resolution:128,terrain:'flat',lighting:'reference',environment:'reference',
    paused:false,quality:'balanced',raySteps:32,renderScale:.8,wireframe:false,debug:'beauty',meshLayers:1
  });
  const DEFAULT_VIEW = Object.freeze({
    mode:'fluid',renderer:'raymarch',layout:'single',compareMode:'hybrid',compareRenderer:'same',actorCount:1,auto:true
  });
  const DEFAULT_CAMERA = Object.freeze({theta:.38,phi:1.14,distance:11.5,mode:3});
  const QUALITY_PRESETS = Object.freeze({
    low:Object.freeze({resolution:64,raySteps:20,renderScale:.6,pixelRatio:1,drawScale:.8}),
    balanced:Object.freeze({resolution:128,raySteps:32,renderScale:.8,pixelRatio:1.35,drawScale:1}),
    high:Object.freeze({resolution:256,raySteps:48,renderScale:1,pixelRatio:1.75,drawScale:1})
  });
  const NUMBERS = Object.freeze({
    density:[0,2.2],height:[.15,2.8],radius:[.35,2.7],strength:[0,2.5],swirl:[0,2.5],
    persistence:[.6,12],wind:[0,2],pressure:[2,32,true],vorticity:[0,1.8],raySteps:[8,48,true],renderScale:[.3,1]
  });
  const SETTING_ENUMS = Object.freeze({
    terrain:['flat','hills'],lighting:['reference','day','dusk','night'],environment:['reference','forest'],
    quality:['low','balanced','high'],debug:['beauty','density','velocity','uv','pressure','curl'],meshLayers:[1,4]
  });
  const VIEW_ENUMS = Object.freeze({
    mode:['analytical','hybrid','fluid'],renderer:['mesh','raymarch','layered'],layout:['single','compare','triple'],
    compareMode:['analytical','hybrid','fluid'],compareRenderer:['same','mesh','raymarch','layered'],actorCount:[1,4,8]
  });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object,key);
  const read = (object,key) => own(object,key) ? object[key] : undefined;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.toString.call(value) === '[object Object]';
  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));

  class PresetError extends Error {
    constructor(message,code='INVALID_PRESET') { super(message);this.name='PresetError';this.code=code; }
  }
  function utf8(text) { return new TextEncoder().encode(text); }
  function sizeCheckedJSON(value) {
    let text;
    try { text=JSON.stringify(value); } catch (_) { throw new PresetError('Preset must contain JSON data.','MALFORMED_PRESET'); }
    if (typeof text!=='string') throw new PresetError('Preset must contain JSON data.','MALFORMED_PRESET');
    if (text.length>MAX_JSON_BYTES || utf8(text).length>MAX_JSON_BYTES) throw new PresetError('Preset is too large.','PRESET_TOO_LARGE');
    return text;
  }
  function number(value,key,min,max,integer=false) {
    if (typeof value!=='number' || !Number.isFinite(value)) throw new PresetError('Invalid '+key+'.');
    const bounded=clamp(value,min,max);return integer?Math.round(bounded):bounded;
  }
  function copyEnum(input,output,key,values) {
    const value=read(input,key);if(value===undefined)return;
    if (!values.includes(value)) throw new PresetError('Invalid '+key+'.');
    output[key]=value;
  }
  function copyBoolean(input,output,key) {
    const value=read(input,key);if(value===undefined)return;
    if(typeof value!=='boolean')throw new PresetError('Invalid '+key+'.');
    output[key]=value;
  }

  function validatePreset(input) {
    if (!record(input) || read(input,'format')!=='FogLab') throw new PresetError('Not a FogLab preset.');
    if (read(input,'version')!==1) throw new PresetError('This preset version is not supported.','UNSUPPORTED_VERSION');
    const incomingSettings=read(input,'settings'),incomingView=read(input,'view');
    if (!record(incomingSettings) || !record(incomingView)) throw new PresetError('Preset settings and view must be objects.');
    sizeCheckedJSON(input);
    // Every output is a new whitelist-only record. Inherited keys, prototype
    // pollution keys and live-state fields never enter the returned document.
    const settings={...DEFAULT_SETTINGS},view={...DEFAULT_VIEW},camera={...DEFAULT_CAMERA};
    for(const [key,[min,max,integer]] of Object.entries(NUMBERS)) {
      const value=read(incomingSettings,key);
      if(value!==undefined)settings[key]=number(value,key,min,max,integer);
    }
    for(const [key,values] of Object.entries(SETTING_ENUMS))copyEnum(incomingSettings,settings,key,values);
    copyBoolean(incomingSettings,settings,'wireframe');copyBoolean(incomingSettings,settings,'paused');
    // Resolution is derived from the validated quality preset. A file cannot
    // request an arbitrary GPU allocation through an exported resolution key.
    settings.resolution=QUALITY_PRESETS[settings.quality].resolution;
    for(const [key,values] of Object.entries(VIEW_ENUMS))copyEnum(incomingView,view,key,values);
    copyBoolean(incomingView,view,'auto');
    const incomingCamera=read(input,'camera');
    if(incomingCamera!==undefined) {
      if(!record(incomingCamera))throw new PresetError('Preset camera must be an object.');
      for(const [key,min,max] of [['theta',-100,100],['phi',.07,1.50],['distance',7,48]]) {
        const value=read(incomingCamera,key);if(value!==undefined)camera[key]=number(value,'camera '+key,min,max);
      }
      copyEnum(incomingCamera,camera,'mode',[0,1,2,3]);
    }
    return {format:'FogLab',version:1,settings,view,camera};
  }
  function defaultPreset() { return validatePreset({format:'FogLab',version:1,settings:{},view:{}}); }
  function parseJSON(text) {
    if(typeof text!=='string')throw new PresetError('Preset JSON must be text.','MALFORMED_PRESET');
    if(text.length>MAX_JSON_BYTES || utf8(text).length>MAX_JSON_BYTES)throw new PresetError('Preset is too large.','PRESET_TOO_LARGE');
    let parsed;try{parsed=JSON.parse(text);}catch(_){throw new PresetError('Preset JSON is malformed.','MALFORMED_PRESET');}
    return validatePreset(parsed);
  }
  function bytesToBase64URL(bytes) {
    let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
    const encoded=typeof btoa==='function'?btoa(binary):Buffer.from(bytes).toString('base64');
    return encoded.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function encodeHash(preset) {
    const normalized=validatePreset(preset),encoded=bytesToBase64URL(utf8(JSON.stringify(normalized)));
    if(encoded.length>MAX_ENCODED_CHARS)throw new PresetError('Experiment link is too large.','PRESET_TOO_LARGE');
    return '#preset='+encoded;
  }
  function decodeHash(hash) {
    if(hash===''||hash==='#'||hash===undefined||hash===null)return null;
    if(typeof hash!=='string')throw new PresetError('Malformed experiment link.','MALFORMED_LINK');
    if(hash.length>MAX_ENCODED_CHARS+8)throw new PresetError('Experiment link is too large.','PRESET_TOO_LARGE');
    if(!hash.startsWith('#preset='))throw new PresetError('This experiment link format is not supported.','UNSUPPORTED_LINK');
    const encoded=hash.slice(8);
    if(!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length%4===1)throw new PresetError('Malformed experiment link.','MALFORMED_LINK');
    let bytes;
    try {
      const base64=encoded.replace(/-/g,'+').replace(/_/g,'/');
      if(typeof atob==='function')bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
      else bytes=Uint8Array.from(Buffer.from(base64,'base64'));
    } catch (_) { throw new PresetError('Malformed experiment link.','MALFORMED_LINK'); }
    if(bytes.length>MAX_JSON_BYTES)throw new PresetError('Experiment link is too large.','PRESET_TOO_LARGE');
    if(bytesToBase64URL(bytes)!==encoded)throw new PresetError('Malformed experiment link encoding.','MALFORMED_LINK');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(_){throw new PresetError('Experiment link contains invalid text.','MALFORMED_LINK');}
    return parseJSON(text);
  }
  function buildShareURL(preset,currentURL) {
    let base=CANONICAL_URL;
    try {
      const current=new URL(typeof currentURL==='string'?currentURL:currentURL.href);
      if(current.protocol==='http:'||current.protocol==='https:')base=current.origin+current.pathname;
    } catch (_) { /* Local / unavailable locations use the canonical live page. */ }
    return base+encodeHash(preset);
  }
  return Object.freeze({
    MAX_JSON_BYTES,MAX_ENCODED_CHARS,CANONICAL_URL,DEFAULT_SETTINGS,DEFAULT_VIEW,DEFAULT_CAMERA,QUALITY_PRESETS,
    PresetError,validatePreset,defaultPreset,parseJSON,encodeHash,decodeHash,buildShareURL
  });
});
