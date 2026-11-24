/* Offline capture adapter: Three.js issues its real GL commands to a Mesa GLES
 * context. This is not a browser, and its output is labeled native rendering. */
'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const C=require('./native_gl_constants.json');
const QUERY=new Set(['getError','getParameter','getShaderParameter','getProgramParameter','getShaderInfoLog','getProgramInfoLog','getActiveAttrib','getActiveUniform','getAttribLocation','getUniformLocation','checkFramebufferStatus','getBufferParameter','getTexParameter','getRenderbufferParameter','getFramebufferAttachmentParameter','getInternalformatParameter','getUniformBlockIndex','getUniformIndices','getActiveUniformBlockParameter','getActiveUniformBlockName','getActiveUniforms','isEnabled','isBuffer','isFramebuffer','isProgram','isRenderbuffer','isShader','isTexture','isVertexArray','clientWaitSync','getSyncParameter']);
const CREATES={createTexture:'texture',createBuffer:'buffer',createFramebuffer:'framebuffer',createRenderbuffer:'renderbuffer',createVertexArray:'vertexarray',createShader:'shader',createProgram:'program',createQuery:'query',createSampler:'sampler',createTransformFeedback:'transformfeedback',fenceSync:'sync'};
const DELETES={deleteTexture:'texture',deleteBuffer:'buffer',deleteFramebuffer:'framebuffer',deleteRenderbuffer:'renderbuffer',deleteVertexArray:'vertexarray',deleteShader:'shader',deleteProgram:'program',deleteQuery:'query',deleteSampler:'sampler',deleteTransformFeedback:'transformfeedback',deleteSync:'sync'};
const delayArray=new Int32Array(new SharedArrayBuffer(4));
function pause(){Atomics.wait(delayArray,0,0,2);}
function encode(v){
  if(v===undefined||v===null)return null;
  if(v&&v._glHandle!==undefined)return v._glHandle;
  if(v&&v._glLocation!==undefined)return v._glLocation;
  if(ArrayBuffer.isView(v))return {__typed:v.constructor.name,base64:Buffer.from(v.buffer,v.byteOffset,v.byteLength).toString('base64')};
  if(v instanceof ArrayBuffer)return {__typed:'Uint8Array',base64:Buffer.from(v).toString('base64')};
  if(Array.isArray(v))return v.map(encode);
  return v;
}
class NativeGL{
  constructor({width=1280,height=720}={}){
    Object.assign(this,C);this._width=width;this._height=height;this._commands=[];this._inbox=Buffer.alloc(0);this._closed=false;this._sources=new Map();this._handles=new Map();this._extensionCache=new Map();this._defaultFramebuffer=true;this._colorSpace='srgb';this.callCount=0;
    this._child=cp.spawn(process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3',[path.join(__dirname,'native_gl_bridge.py')],{stdio:['pipe','pipe','inherit'],env:process.env});
    this._writeFd=this._child.stdin._handle.fd;this._readFd=this._child.stdout._handle.fd;
    const self=this;
    this.canvas={style:{},addEventListener(){},removeEventListener(){},setAttribute(){},getContext(){return self;},getBoundingClientRect(){return {x:0,y:0,left:0,top:0,width:self._width,height:self._height};}};
    Object.defineProperties(this.canvas,{width:{get:()=>this._width,set:v=>this._resize(v,this._height)},height:{get:()=>this._height,set:v=>this._resize(this._width,v)},clientWidth:{get:()=>this._width},clientHeight:{get:()=>this._height}});
    this._rpc('resize',[width,height]);
    this._supported=this._rpc('getParameter',[0x1F03]).split(' ').map(x=>x.replace(/^GL_/,''));
    console.log('Native renderer:',this._rpc('getParameter',[this.RENDERER]));
    return new Proxy(this,{get(target,key){
      if(key in target){const v=target[key];return typeof v==='function'?v.bind(target):v;}
      if(typeof key==='symbol')return undefined;
      // Native drivers recycle integer names. A new WebGL object must retain
      // fresh identity, so discard the identity cache on deletion.
      if(key in DELETES)return object=>{if(object){target._handles.delete(DELETES[key]+':'+object._glHandle);target._sources.delete(object);}target._push(key,[object]);};
      if(key in CREATES)return (...args)=>target._wrap(CREATES[key],target._rpc(key,args));
      if(QUERY.has(key))return (...args)=>target._rpc(key,args);
      if(/^[A-Z][A-Z0-9_]+$/.test(key))throw new Error('Missing GL enum '+key);
      if(typeof key==='string'&&/^[a-z]/.test(key))return (...args)=>target._push(key,args);
      return undefined;
    }});
  }
  get drawingBufferWidth(){return this._width;}
  get drawingBufferHeight(){return this._height;}
  get drawingBufferColorSpace(){return this._colorSpace;}
  set drawingBufferColorSpace(x){this._colorSpace=x;}
  get unpackColorSpace(){return 'srgb';}
  set unpackColorSpace(x){}
  _wrap(kind,id){if(id===null||id===undefined||id===0)return null;const key=kind+':'+id;if(!this._handles.has(key))this._handles.set(key,{_glHandle:id,_glType:kind});return this._handles.get(key);}
  _resize(w,h){w=Math.max(1,Math.round(w));h=Math.max(1,Math.round(h));if(w===this._width&&h===this._height)return;this._width=w;this._height=h;this._rpc('resize',[w,h]);}
  _send(payload){
    const bytes=Buffer.from(JSON.stringify(payload)+'\n');let offset=0;
    while(offset<bytes.length){try{offset+=fs.writeSync(this._writeFd,bytes,offset,bytes.length-offset);}catch(e){if(e.code==='EAGAIN')pause();else throw e;}}
    const deadline=Date.now()+120000;
    for(;;){
      const idx=this._inbox.indexOf(10);if(idx>=0){const line=this._inbox.subarray(0,idx).toString();this._inbox=this._inbox.subarray(idx+1);const data=JSON.parse(line);if(data.error)throw new Error('Native GLES: '+data.error);return data.result;}
      if(Date.now()>deadline)throw new Error('Native GLES IPC timeout');
      const chunk=Buffer.allocUnsafe(1024*1024);let n;
      try{n=fs.readSync(this._readFd,chunk,0,chunk.length,null);}catch(e){if(e.code==='EAGAIN'){pause();continue;}throw e;}
      if(n===0)throw new Error('Native GLES process closed its output');
      this._inbox=Buffer.concat([this._inbox,chunk.subarray(0,n)]);
    }
  }
  _rpc(op,args=[]){
    if(this._closed)throw new Error('Native context is closed');
    const commands=this._commands;this._commands=[];this.callCount++;
    return this._send({commands,query:{op,args:args.map(encode)}});
  }
  _push(op,args=[]){this._commands.push({op,args:args.map(encode)});this.callCount++;if(this._commands.length>=500){const err=this._rpc('getError');if(err)throw new Error('Native GLES error 0x'+err.toString(16)+' while flushing '+op);}}
  getContextAttributes(){return {alpha:false,depth:true,stencil:true,antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,powerPreference:'default'};}
  isContextLost(){return false;}
  getSupportedExtensions(){return ['EXT_color_buffer_float','OES_texture_float_linear','EXT_float_blend'];}
  getExtension(name){
    if(this._extensionCache.has(name))return this._extensionCache.get(name);
    let v=null;
    if(['EXT_color_buffer_float','OES_texture_float_linear','EXT_float_blend','EXT_color_buffer_half_float'].includes(name)&&this._supported.includes(name))v={};
    // Do not advertise features that require browser-only extension entry points.
    this._extensionCache.set(name,v);return v;
  }
  getShaderPrecisionFormat(type,precision){return this._rpc('getShaderPrecisionFormat',[type,precision]);}
  shaderSource(shader,source){this._sources.set(shader,source);this._push('shaderSource',[shader,source]);}
  getShaderSource(shader){return this._sources.get(shader)||'';}
  getUniformLocation(program,name){const v=this._rpc('getUniformLocation',[program,name]);return v<0?null:{_glLocation:v};}
  getParameter(p){
    const v=this._rpc('getParameter',[p]);
    if(p===this.FRAMEBUFFER_BINDING||p===this.DRAW_FRAMEBUFFER_BINDING||p===this.READ_FRAMEBUFFER_BINDING)return this._wrap('framebuffer',v);
    return v;
  }
  bindFramebuffer(target,buffer){this._defaultFramebuffer=buffer===null;this._push('bindFramebuffer',[target,buffer]);}
  drawBuffers(buffers){this._push('drawBuffers',[this._defaultFramebuffer?Array.from(buffers,x=>x===this.BACK?this.COLOR_ATTACHMENT0:x):buffers]);}
  readBuffer(buffer){this._push('readBuffer',[this._defaultFramebuffer&&buffer===this.BACK?this.COLOR_ATTACHMENT0:buffer]);}
  pixelStorei(p,v){if([this.UNPACK_FLIP_Y_WEBGL,this.UNPACK_PREMULTIPLY_ALPHA_WEBGL,this.UNPACK_COLORSPACE_CONVERSION_WEBGL].includes(p))return;this._push('pixelStorei',[p,v]);}
  readPixels(x,y,w,h,format,type,array,offset=0){
    const data=this._rpc('readPixels',[x,y,w,h,format,type]);const bytes=Buffer.from(typeof data==='string'?data:data.base64,'base64');
    if(!array)return bytes;
    const dest=Buffer.from(array.buffer,array.byteOffset+offset*array.BYTES_PER_ELEMENT,array.byteLength-offset*array.BYTES_PER_ELEMENT);bytes.copy(dest);return undefined;
  }
  async capture(filename){
    this._rpc('finish');
    const pixels=new Uint8Array(this._width*this._height*4);this.readPixels(0,0,this._width,this._height,this.RGBA,this.UNSIGNED_BYTE,pixels);
    const sharp=require(require.resolve('sharp',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]}));
    await sharp(Buffer.from(pixels),{raw:{width:this._width,height:this._height,channels:4}}).flip().png().toFile(filename);
    return filename;
  }
  flush(){const err=this._rpc('getError');if(err)throw new Error('Native GL error 0x'+err.toString(16));}
  finish(){this._rpc('finish');}
  close(){if(this._closed)return;try{this._rpc('finish');}catch(e){}this._closed=true;this._child.stdin.end();this._child.kill();}
}
module.exports={NativeGL};
