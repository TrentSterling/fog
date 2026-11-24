/* Classic Worker entry. The build embeds this exact file after field-utils.js
 * and cpu-solver.js in a Blob URL. No imports, network, or SharedArrayBuffer.
 * The renderer owns persistent texture arrays; only separate packet buffers
 * cross this boundary. Returning packets are reused by the next worker task.
 */
(function (scope) {
  'use strict';
  const Solver=scope.FogLab.CPUFluidSolver;
  const now=()=>performance.now();
  const auxiliary=new Set(['pressure','curl','divergence']);
  const pools={state:[],aux:[]};
  const floatScratch=new Float32Array(1),bits=new Uint32Array(floatScratch.buffer);
  let solver=null,generation=0,simulationTime=0,half=false;
  let buffersCreated=0,buffersReused=0;

  function halfFloat(value) {
    floatScratch[0]=value;const word=bits[0],sign=(word>>>16)&0x8000;
    let exponent=((word>>>23)&255)-127+15,mantissa=word&0x7fffff;
    if(exponent<=0) {
      if(exponent<-10)return sign;
      mantissa=(mantissa|0x800000)>>(1-exponent);
      return sign|((mantissa+0x1000)>>13);
    }
    if(exponent>=31)return sign|0x7c00;
    mantissa+=0x1000;
    if(mantissa&0x800000){mantissa=0;exponent++;}
    return sign|(exponent<<10)|(mantissa>>13);
  }
  function recycle(entries) {
    if(!Array.isArray(entries))return;
    for(const entry of entries) {
      const pool=pools[entry.kind];
      if(pool&&entry.buffer instanceof ArrayBuffer&&entry.buffer.byteLength>0&&pool.length<2)pool.push(entry.buffer);
    }
  }
  function buffer(kind,bytes) {
    const pool=pools[kind];
    while(pool.length){const value=pool.pop();if(value.byteLength===bytes){buffersReused++;return value;}}
    buffersCreated++;return new ArrayBuffer(bytes);
  }
  function result(request,withState,started) {
    const count=solver.resolution*solver.resolution,packingStarted=now();
    let state=null,aux=null;
    if(withState) {
      state=buffer('state',count*4*(half?2:4));
      if(half) {
        const data=new Uint16Array(state);
        for(let i=0;i<count;i++) {
          const j=i*4;data[j]=halfFloat(solver.u[i]);data[j+1]=halfFloat(solver.v[i]);
          data[j+2]=halfFloat(solver.density[i]);data[j+3]=halfFloat(solver.energy[i]);
        }
      } else solver.packRGBA(new Float32Array(state));
    }
    if(auxiliary.has(request.debug)) {
      aux=buffer('aux',count*4);new Float32Array(aux).set(solver[request.debug]);
    }
    const packingMs=now()-packingStarted;
    // Scalar diagnostics stay on the worker as well. No simulation array is
    // transferred or detached, including pressure's ping-pong buffers.
    const diagnostics=solver.getDiagnostics();
    const response={type:'result',requestType:request.type,id:request.id,generation,
      resolution:solver.resolution,simulationTime,debug:request.debug||'beauty',
      state,aux,format:half?'float16':'float32',diagnostics,
      lastSolveMs:request.type==='step'?solver.lastStepMs:0,
      lastStepMs:request.type==='step'?solver.lastStepMs+packingMs:0,
      lastWorkerTaskMs:now()-started,buffersCreated,buffersReused};
    const transfer=[];if(state)transfer.push(state);if(aux)transfer.push(aux);
    scope.postMessage(response,transfer);
  }

  scope.addEventListener('message',event=>{
    const request=event.data||{},started=now();
    try {
      recycle(request.recycle);
      if(request.type==='configure') {
        generation=request.generation;simulationTime=0;half=request.half===true;
        if(!solver)solver=new Solver({resolution:request.resolution,worldSize:request.worldSize,noise:request.noise});
        else if(solver.worldSize!==request.worldSize)solver=new Solver({resolution:request.resolution,worldSize:request.worldSize,noise:request.noise||solver.noise});
        else solver.setResolution(request.resolution);
        solver.setObstacles(request.obstacles||[],request.obstaclesEnabled!==false);
        solver.reset(request.settings||{});
        result(request,true,started);return;
      }
      if(!solver)throw new Error('CPU worker has not been initialized.');
      if(request.generation!==generation) {
        scope.postMessage({type:'stale',id:request.id,generation:request.generation});return;
      }
      if(request.type==='step') {
        const accepted=solver.step(request.dt,request.time,request.interactors||[],request.settings||{},request.segments||[]);
        if(!accepted)throw new Error('CPU worker rejected a non-finite or non-positive time step.');
        simulationTime=Number.isFinite(request.time)?request.time:simulationTime+Math.min(request.dt,1/20);
        result(request,true,started);return;
      }
      if(request.type==='inspect') {result(request,false,started);return;}
      throw new Error('Unknown CPU worker request.');
    } catch(error) {
      scope.postMessage({type:'error',id:request.id,generation:request.generation,message:String(error?.message||error)});
    }
  });
})(self);
