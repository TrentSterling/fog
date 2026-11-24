/* Worker-backed CPU field adapter. One task at a time, no solve backlog.
 * Reset/configuration generations discard stale results. Three.js keeps its
 * own persistent upload arrays; transferred result packets are copied into
 * those arrays and recycled only after the copy, never from a live texture.
 */
(function () {
  'use strict';
  const F=window.FogLab,T=window.THREE,now=()=>performance.now();
  const debugFields=new Set(['pressure','curl','divergence']);
  const resolution=value=>Math.max(32,Math.min(256,Math.round(Number.isFinite(value)?value:128)));
  class CPUWorkerSimulation {
    constructor(renderer,noiseTexture,options={}) {
      this.renderer=renderer;this.noiseTexture=noiseTexture;this.worldSize=options.worldSize||32;
      this.mode='cpu';this.supported=true;this.disposed=false;this.passCount=0;this.totalPassCount=0;
      this.execution='worker';this.fallbackReason='';this.needsResync=false;
      this.lastStepMs=0;this.lastSolveMs=0;this.lastRoundTripMs=0;this.lastWorkerTaskMs=0;this.uploadBytesPerTick=0;
      this.uniforms={uWind:{value:.4}};
      this._resolution=resolution(options.resolution);this._simulationTime=0;this._generation=0;
      this._fieldGeneration=-1;
      this._settings={wind:.4,debug:'beauty'};this._obstacles=[];this._obstaclesEnabled=true;this._obstacleKey='';
      this._desiredDebug='beauty';this._seenDebug=null;this._configurationDirty=false;this._debugDirty=false;
      this._requestId=0;this._active=null;this._recycle=[];this._diagnostics=null;
      this._worker=null;this._url=null;this._fallback=null;this._timer=null;this._noiseSent=false;
      this._timeout=Math.max(20,Number.isFinite(options.workerTimeoutMs)?options.workerTimeoutMs:10000);
      this._floatLinear=!!renderer.getContext().getExtension('OES_texture_float_linear');
      this._textures=[];this._allocateTextures();
      try {
        if(typeof Worker!=='function'||typeof Blob!=='function'||typeof URL.createObjectURL!=='function')throw new Error('Web Workers are unavailable in this browser.');
        if(typeof F.cpuWorkerSource!=='string'||!F.cpuWorkerSource.trim())throw new Error('The embedded CPU worker source is unavailable.');
        this._url=URL.createObjectURL(new Blob([F.cpuWorkerSource],{type:'text/javascript'}));
        const worker=this._worker=new Worker(this._url,{name:'FogLab CPU fluids'});
        worker.onmessage=event=>{if(this._worker===worker)this._receive(event.data);};
        worker.onerror=event=>{if(this._worker===worker){event.preventDefault?.();this._fail(event.message||'The CPU worker stopped unexpectedly.');}};
        worker.onmessageerror=()=>{if(this._worker===worker)this._fail('The CPU worker returned an unreadable message.');};
        this._invalidate();
      } catch(error) {this._fail(String(error?.message||error));}
    }
    get resolution(){return this._resolution;}
    get epoch(){return this._generation;}
    get simulationTime(){return this._simulationTime;}
    get pending(){return this.supported&&!this.disposed&&!this._fallback&&!!(this._active||this._configurationDirty||this._debugDirty);}
    get fieldReady(){return this.supported&&!this.disposed&&!!(this._fallback||this._fieldGeneration===this._generation);}
    get texture(){return this._fallback?.texture||this._stateTexture;}
    get velocityTexture(){return this.texture;}
    get pressureTexture(){return this._fallback?.pressureTexture||this._pressureTexture;}
    get curlTexture(){return this._fallback?.curlTexture||this._curlTexture;}
    get divergenceTexture(){return this._fallback?.divergenceTexture||this._divergenceTexture;}
    get obstacleTexture(){return this._fallback?.obstacleTexture||this._obstacleTexture;}
    get uploadFormat(){return this._fallback?.uploadFormat||(this._floatLinear?'RGBA32F':'RGBA16F');}
    get memoryBytes(){
      if(this._fallback)return this._fallback.memoryBytes;
      const resident=this._textures.reduce((sum,texture)=>sum+(texture.image.data?.byteLength||0),0);
      const packets=this._recycle.reduce((sum,entry)=>sum+entry.buffer.byteLength,0);
      return (this._diagnostics?.memoryBytes||0)+resident+packets;
    }
    get gpuMemoryBytes(){return this._fallback?.gpuMemoryBytes||(this._resolution*this._resolution*(this._floatLinear?29:21));}

    _texture(data,format,type,linear,name) {
      const texture=new T.DataTexture(data,this._resolution,this._resolution,format,type);
      texture.minFilter=texture.magFilter=linear?T.LinearFilter:T.NearestFilter;
      texture.wrapS=texture.wrapT=T.ClampToEdgeWrapping;texture.generateMipmaps=false;texture.colorSpace=T.NoColorSpace;
      texture.needsUpdate=true;texture.name='FogLab CPU worker '+name;this._textures.push(texture);return texture;
    }
    _allocateTextures() {
      const count=this._resolution*this._resolution;
      this._upload=this._floatLinear?new Float32Array(count*4):new Uint16Array(count*4);
      this._stateTexture=this._texture(this._upload,T.RGBAFormat,this._floatLinear?T.FloatType:T.HalfFloatType,true,'state');
      this._pressureTexture=this._texture(new Float32Array(count),T.RedFormat,T.FloatType,false,'pressure');
      this._curlTexture=this._texture(new Float32Array(count),T.RedFormat,T.FloatType,false,'curl');
      this._divergenceTexture=this._texture(new Float32Array(count),T.RedFormat,T.FloatType,false,'divergence');
      const mask=F.FieldUtils.buildObstacleMask(this._resolution,this.worldSize,this._obstacles,this._obstaclesEnabled);
      this._obstacleTexture=this._texture(mask,T.RedFormat,T.UnsignedByteType,false,'obstacles');
    }
    _disposeTextures(){for(const texture of this._textures)texture.dispose();this._textures=[];}
    _notify(){if(typeof this.onStateChange==='function')this.onStateChange(this);}
    _invalidate() {
      if(!this.supported){this._configurationDirty=this._debugDirty=false;this._notify();return;}
      this._generation++;this._simulationTime=0;this._configurationDirty=true;this._debugDirty=false;
      this._seenDebug=null;this._diagnostics=null;this.lastStepMs=this.lastSolveMs=0;this.uploadBytesPerTick=0;
      this._sendNext();this._notify();
    }
    _post(type,payload={}) {
      if(this.disposed||!this._worker||this._active)return false;
      const id=++this._requestId,request={type,id,generation:this._generation,debug:this._desiredDebug,...payload};
      const transfer=[],recycle=this._recycle;this._recycle=[];
      request.recycle=recycle;
      for(const entry of recycle)if(entry.buffer.byteLength)transfer.push(entry.buffer);
      if(request.noise?.data?.buffer)transfer.push(request.noise.data.buffer);
      this._active={id,generation:this._generation,type,started:now(),debug:request.debug};
      clearTimeout(this._timer);
      this._timer=setTimeout(()=>this._fail('The CPU worker did not respond within '+(this._timeout/1000)+' seconds.'),this._timeout);
      try {this._worker.postMessage(request,transfer);return true;}
      catch(error){this._fail('CPU worker message failed: '+String(error?.message||error));return false;}
    }
    _sendNext() {
      if(this.disposed||this._fallback||this._active||!this._worker)return;
      if(this._configurationDirty) {
        this._configurationDirty=false;this._debugDirty=false;
        const payload={resolution:this._resolution,worldSize:this.worldSize,half:!this._floatLinear,
          obstacles:this._obstacles,obstaclesEnabled:this._obstaclesEnabled,settings:{...this._settings}};
        if(!this._noiseSent) {
          const image=this.noiseTexture.image;
          // Copy once so transferring the atlas never detaches Three's texture.
          payload.noise={data:image.data.slice(),width:image.width,height:image.height};this._noiseSent=true;
        }
        this._post('configure',payload);return;
      }
      if(this._debugDirty) {this._debugDirty=false;this._post('inspect');}
    }
    _rememberPacket(message) {
      for(const kind of ['state','aux']) {
        const value=message[kind];
        if(value instanceof ArrayBuffer&&value.byteLength&&this._recycle.length<4)this._recycle.push({kind,buffer:value});
      }
    }
    _receive(message) {
      if(this.disposed||!this._active||message?.id!==this._active.id)return;
      const active=this._active;this._active=null;clearTimeout(this._timer);this._timer=null;
      if(active.generation!==this._generation) {
        this._rememberPacket(message);this._sendNext();this._notify();return;
      }
      if(message.generation!==this._generation){this._fail('The CPU worker returned an unexpected simulation generation.');return;}
      if(message.type==='error'){this._fail(message.message||'The CPU worker failed.');return;}
      if(message.type!=='result'&&message.type!=='stale'){this._fail('The CPU worker returned an unexpected response.');return;}
      if(message.type==='stale'){this._fail('The CPU worker lost its simulation generation.');return;}
      const count=this._resolution*this._resolution;
      if(message.resolution!==this._resolution||message.format!==(this._floatLinear?'float32':'float16')||
        (message.state&&message.state.byteLength!==this._upload.byteLength)||
        (message.aux&&message.aux.byteLength!==count*4)) {
        this._fail('The CPU worker returned a field with an invalid layout.');return;
      }
      if(message.state) {
        this._upload.set(this._floatLinear?new Float32Array(message.state):new Uint16Array(message.state));
        this._stateTexture.needsUpdate=true;this._fieldGeneration=this._generation;
      }
      if(message.aux&&debugFields.has(message.debug)) {
        const target=this['_'+message.debug+'Texture'];target.image.data.set(new Float32Array(message.aux));target.needsUpdate=true;
      }
      this._simulationTime=message.simulationTime;this._diagnostics=message.diagnostics;
      this.lastRoundTripMs=now()-active.started;this.lastWorkerTaskMs=message.lastWorkerTaskMs;
      if(active.type==='step') {
        this.lastStepMs=message.lastStepMs;this.lastSolveMs=message.lastSolveMs;
        this.uploadBytesPerTick=(message.state?.byteLength||0)+(message.aux?.byteLength||0);
      }
      this.buffersCreated=message.buffersCreated;this.buffersReused=message.buffersReused;
      this._seenDebug=message.debug;this._debugDirty=this._desiredDebug!==this._seenDebug;
      this._rememberPacket(message);this._sendNext();this._notify();
    }
    _shutdownWorker() {
      clearTimeout(this._timer);this._timer=null;
      if(this._worker){this._worker.terminate();this._worker=null;}
      if(this._url){URL.revokeObjectURL(this._url);this._url=null;}
      this._active=null;this._recycle=[];
    }
    _fail(reason) {
      if(this.disposed||this._fallback)return;
      this._shutdownWorker();this.execution='main';this.fallbackReason=reason;this.needsResync=true;
      this._generation++;this._simulationTime=0;this._configurationDirty=this._debugDirty=false;
      this._diagnostics=null;
      this.lastStepMs=this.lastSolveMs=this.lastRoundTripMs=this.lastWorkerTaskMs=this.uploadBytesPerTick=0;
      let fallback;
      try {
        fallback=new F.CPUFieldSimulation(this.renderer,this.noiseTexture,{resolution:this._resolution,worldSize:this.worldSize});
        fallback.setObstacles(this._obstacles,this._obstaclesEnabled);fallback.reset(this._settings);
        this._fallback=fallback;this.uniforms=fallback.uniforms;this._disposeTextures();
      } catch(error) {
        try{fallback?.dispose();}catch(_){/* A failed fallback must not block the other backends. */}
        this.supported=false;this.fallbackReason+=' Main-thread fallback failed: '+String(error?.message||error);
      }
      this._notify();
    }

    reset(settings={}) {
      if(this.disposed)return;
      this._settings={...this._settings,...settings};this._settings.wind=Number.isFinite(settings.wind)?settings.wind:this.uniforms.uWind.value;
      this.uniforms.uWind.value=this._settings.wind;this._desiredDebug=this._settings.debug||'beauty';this.needsResync=false;
      if(this._fallback){this._fallback.reset(this._settings);this._generation++;this._simulationTime=0;this.lastStepMs=this.lastSolveMs=this.uploadBytesPerTick=0;this._notify();return;}
      this._invalidate();
    }
    setResolution(value) {
      const n=resolution(value);if(this.disposed||!this.supported||n===this._resolution)return;
      this._resolution=n;
      if(this._fallback){this._fallback.setResolution(n);this.reset(this._settings);return;}
      this._disposeTextures();this._allocateTextures();this._invalidate();
    }
    setObstacles(obstacles=[],enabled=true) {
      if(this.disposed||!this.supported)return;
      const copy=(Array.isArray(obstacles)?obstacles:[]).filter(o=>o&&[o.x,o.z,o.radius].every(Number.isFinite)).map(o=>({x:o.x,z:o.z,radius:o.radius}));
      const key=JSON.stringify([copy,!!enabled]);if(key===this._obstacleKey)return;
      this._obstacleKey=key;this._obstacles=copy;this._obstaclesEnabled=!!enabled;
      if(this._fallback){this._fallback.setObstacles(copy,enabled);this.reset(this._settings);return;}
      this._obstacleTexture.image.data=F.FieldUtils.buildObstacleMask(this._resolution,this.worldSize,copy,enabled);
      this._obstacleTexture.needsUpdate=true;this._invalidate();
    }
    prepareDebug(debug='beauty') {
      if(this.disposed)return;
      if(!this.supported)return;
      if(this._fallback){this._desiredDebug=debug;this._settings.debug=debug;this._fallback.prepareDebug(debug);return;}
      if(debug===this._desiredDebug)return;
      this._desiredDebug=debug;this._settings.debug=debug;
      this._debugDirty=true;this._sendNext();this._notify();
    }
    step(dt,time,interactors=[],settings={},segments=[]) {
      if(this.disposed||!this.supported||this.needsResync||!Number.isFinite(dt)||dt<=0||this.pending)return false;
      this._settings={...settings};this._desiredDebug=settings.debug||'beauty';
      if(Number.isFinite(settings.wind))this.uniforms.uWind.value=settings.wind;
      if(this._fallback) {
        const accepted=this._fallback.step(dt,time,interactors,settings,segments);
        if(accepted===false)return false;
        this._simulationTime=Number.isFinite(time)?time:this._simulationTime+Math.min(dt,1/20);
        this.lastStepMs=this._fallback.lastStepMs;this.lastSolveMs=this._fallback.lastSolveMs;
        this.lastWorkerTaskMs=0;this.lastRoundTripMs=0;this.uploadBytesPerTick=this._fallback.uploadBytesPerTick;return true;
      }
      return this._post('step',{dt,time,interactors,settings:{...settings},segments});
    }
    getDiagnostics() {
      const details=this._fallback?this._fallback.getDiagnostics():this._diagnostics;
      return {...(details||{supported:this.supported,mode:'cpu',resolution:this._resolution}),
        supported:this.supported,execution:this.execution,pending:this.pending,fieldReady:this.fieldReady,epoch:this.epoch,simulationTime:this.simulationTime,
        fallbackReason:this.fallbackReason,needsResync:this.needsResync,lastStepMs:this.lastStepMs,lastSolveMs:this.lastSolveMs,
        lastRoundTripMs:this.lastRoundTripMs,lastWorkerTaskMs:this.lastWorkerTaskMs,uploadBytesPerTick:this.uploadBytesPerTick,
        memoryBytes:this.memoryBytes,gpuMemoryBytes:this.gpuMemoryBytes,uploadFormat:this.uploadFormat,
        buffersCreated:this.buffersCreated||0,buffersReused:this.buffersReused||0,
        timingScope:this.execution==='worker'?'Worker solve and packet packing; round trip includes scheduling, diagnostics, delivery and the main-thread texture copy. GPU upload is excluded.':'Main-thread solve and packing; GPU upload is excluded.'};
    }
    dispose() {
      if(this.disposed)return;this.disposed=true;this._shutdownWorker();this._configurationDirty=this._debugDirty=false;
      this._fallback?.dispose();this._disposeTextures();
    }
  }
  F.CPUWorkerSimulation=CPUWorkerSimulation;
})();
