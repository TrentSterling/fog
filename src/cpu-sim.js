/* CPU field adapter: CPU integration, shared Three.js fog rendering.
 * A dirty DataTexture uploads at its next draw. lastStepMs measures CPU solve
 * and packing, never GPU transfer time. No synchronous GPU readback is used.
 */
(function () {
  'use strict';
  const F=window.FogLab,T=window.THREE;
  const clock=()=>performance.now();
  class CPUFieldSimulation {
    constructor(renderer,noiseTexture,options={}) {
      this.renderer=renderer;this.noiseTexture=noiseTexture;this.worldSize=options.worldSize||32;
      this.mode='cpu';this.supported=true;this.disposed=false;this.passCount=0;this.totalPassCount=0;
      this.lastStepMs=0;this.lastSolveMs=0;this.uploadBytesPerTick=0;
      this.execution='main';this.fallbackReason='';this.pending=false;this.simulationTime=0;this.epoch=0;this.needsResync=false;this.lastRoundTripMs=0;
      this.uniforms={uWind:{value:.4}};
      this.solver=new F.CPUFluidSolver({resolution:options.resolution||128,worldSize:this.worldSize,noise:noiseTexture.image});
      // RGBA16F is filterable in WebGL2 without float render-target support.
      // Use RGBA32F when its linear filtering extension is available.
      this._floatLinear=!!renderer.getContext().getExtension('OES_texture_float_linear');
      this._textures=[];this._allocateTextures();this.reset();
    }
    get resolution(){return this.solver.resolution;}
    get fieldReady(){return this.supported&&!this.disposed;}
    get texture(){return this._stateTexture;}
    get velocityTexture(){return this._stateTexture;}
    get pressureTexture(){return this._pressureTexture;}
    get curlTexture(){return this._curlTexture;}
    get divergenceTexture(){return this._divergenceTexture;}
    get obstacleTexture(){return this._obstacleTexture;}
    get memoryBytes(){return this.solver.memoryBytes+this._upload.byteLength;}
    get gpuMemoryBytes(){return this._upload.byteLength+this.resolution*this.resolution*13;}
    get uploadFormat(){return this._floatLinear?'RGBA32F':'RGBA16F';}

    _texture(data,format,type,linear=false,name='') {
      const texture=new T.DataTexture(data,this.resolution,this.resolution,format,type);
      texture.minFilter=texture.magFilter=linear?T.LinearFilter:T.NearestFilter;
      texture.wrapS=texture.wrapT=T.ClampToEdgeWrapping;
      texture.generateMipmaps=false;texture.colorSpace=T.NoColorSpace;texture.needsUpdate=true;texture.name='FogLab CPU '+name;
      this._textures.push(texture);return texture;
    }
    _allocateTextures() {
      const count=this.resolution*this.resolution;
      this._upload=this._floatLinear?new Float32Array(count*4):new Uint16Array(count*4);
      this._stateTexture=this._texture(this._upload,T.RGBAFormat,this._floatLinear?T.FloatType:T.HalfFloatType,true,'state');
      this._pressureTexture=this._texture(this.solver.pressure,T.RedFormat,T.FloatType,false,'pressure');
      this._curlTexture=this._texture(this.solver.curl,T.RedFormat,T.FloatType,false,'curl');
      this._divergenceTexture=this._texture(this.solver.divergence,T.RedFormat,T.FloatType,false,'divergence');
      this._obstacleTexture=this._texture(this.solver.mask,T.RedFormat,T.UnsignedByteType,false,'obstacles');
    }
    _pack() {
      const s=this.solver;
      if(this._floatLinear)s.packRGBA(this._upload);
      else for(let i=0;i<s.mask.length;i++) {
        const j=i*4;this._upload[j]=T.DataUtils.toHalfFloat(s.u[i]);this._upload[j+1]=T.DataUtils.toHalfFloat(s.v[i]);
        this._upload[j+2]=T.DataUtils.toHalfFloat(s.density[i]);this._upload[j+3]=T.DataUtils.toHalfFloat(s.energy[i]);
      }
      this._stateTexture.needsUpdate=true;
    }
    _refreshAuxiliary(debug) {
      this._pressureTexture.image.data=this.solver.pressure;
      if(debug==='pressure')this._pressureTexture.needsUpdate=true;
      if(debug==='curl')this._curlTexture.needsUpdate=true;
      if(debug==='divergence')this._divergenceTexture.needsUpdate=true;
    }
    prepareDebug(debug) {
      // Also called by render-time UI changes while simulation is paused.
      if(debug!==this._lastDebug){this._refreshAuxiliary(debug);this._lastDebug=debug;}
    }
    reset(settings={}) {
      if(this.disposed)return;
      if(Number.isFinite(settings.wind))this.uniforms.uWind.value=settings.wind;
      this.solver.reset({wind:this.uniforms.uWind.value});this._pack();
      this._pressureTexture.image.data=this.solver.pressure;
      for(const texture of [this._pressureTexture,this._curlTexture,this._divergenceTexture])texture.needsUpdate=true;
      this.lastStepMs=this.lastSolveMs=0;this.uploadBytesPerTick=0;this._lastDebug=null;
      this.simulationTime=0;this.epoch++;
    }
    setResolution(n) {
      if(this.disposed||!this.solver.setResolution(n))return;
      for(const texture of this._textures)texture.dispose();this._textures=[];
      this._allocateTextures();this.reset();
    }
    setObstacles(obstacles,enabled=true) {
      if(this.disposed)return;
      this.solver.setObstacles(obstacles,enabled);this._obstacleTexture.image.data=this.solver.mask;
      this._obstacleTexture.needsUpdate=true;this._pack();
    }
    step(dt,time,interactors=[],settings={},segments=[]) {
      if(this.disposed)return false;
      const started=clock();
      if(!this.solver.step(dt,time,interactors,settings,segments))return false;
      this.uniforms.uWind.value=this.solver.wind;this._pack();this._refreshAuxiliary(settings.debug);
      this._lastDebug=settings.debug;this.lastSolveMs=this.solver.lastStepMs;this.lastStepMs=clock()-started;
      this.uploadBytesPerTick=this._upload.byteLength+(['pressure','curl','divergence'].includes(settings.debug)?this.resolution*this.resolution*4:0);
      this.simulationTime=Number.isFinite(time)?time:this.simulationTime+Math.min(dt,1/20);return true;
    }
    getDiagnostics() {
      return {...this.solver.getDiagnostics(),execution:this.execution,pending:false,simulationTime:this.simulationTime,epoch:this.epoch,lastStepMs:this.lastStepMs,lastSolveMs:this.lastSolveMs,
        memoryBytes:this.memoryBytes,gpuMemoryBytes:this.gpuMemoryBytes,uploadBytesPerTick:this.uploadBytesPerTick,
        uploadFormat:this.uploadFormat,timingScope:'CPU solve and upload-array packing; GPU transfer time is not included.'};
    }
    dispose() {
      if(this.disposed)return;this.disposed=true;for(const texture of this._textures)texture.dispose();
    }
  }
  F.CPUFieldSimulation=CPUFieldSimulation;
})();
