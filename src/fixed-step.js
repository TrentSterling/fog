/* FogLab fixed-step budget. This clock tracks time; it never schedules work.
 * A busy asynchronous solver leaves a bounded backlog rather than a queue of
 * stale inputs. The caller consumes a tick only after accepting its work.
 */
(function(root,factory){
  'use strict';
  const FixedStepClock=factory();
  if(typeof module==='object'&&module.exports)module.exports=FixedStepClock;
  root.FogLab=root.FogLab||{};root.FogLab.FixedStepClock=FixedStepClock;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  class FixedStepClock {
    constructor({dt=1/30,maxSteps=3,maxBacklog=.1}={}) {
      if(!Number.isFinite(dt)||dt<=0)throw new RangeError('Fixed step must be finite and positive.');
      if(!Number.isSafeInteger(maxSteps)||maxSteps<1)throw new RangeError('Frame step limit must be a positive integer.');
      if(!Number.isFinite(maxBacklog)||maxBacklog<dt)throw new RangeError('Backlog must hold at least one fixed step.');
      this.dt=dt;this.maxSteps=maxSteps;this.maxBacklog=maxBacklog;
      // Fractional refresh periods otherwise lose a tick at arithmetic edges.
      this._epsilon=dt*1e-9;
      this.reset();
    }

    reset() {
      this.accumulator=0;this.droppedSeconds=0;this.totalSteps=0;this.frameSteps=0;
      this._suspended=false;
      return this;
    }

    beginFrame(elapsedSeconds,{paused=false,visible=true}={}) {
      this.frameSteps=0;
      if(paused||!visible){
        // Intentional suspension is not counted as solver overload.
        this.accumulator=0;this._suspended=true;return this;
      }
      if(this._suspended){
        // The resumed timestamp can span time spent in a hidden tab. Start
        // measuring active time from here instead of replaying that interval.
        this.accumulator=0;this._suspended=false;return this;
      }
      const elapsed=Number.isFinite(elapsedSeconds)&&elapsedSeconds>0?elapsedSeconds:0;
      const accepted=Math.min(elapsed,Math.max(0,this.maxBacklog-this.accumulator));
      this.accumulator+=accepted;
      // Subtract before adding to avoid overflowing accumulator on a huge gap.
      this.droppedSeconds=Math.min(Number.MAX_VALUE,this.droppedSeconds+(elapsed-accepted));
      return this;
    }

    canStep() {
      return !this._suspended&&this.frameSteps<this.maxSteps&&this.accumulator+this._epsilon>=this.dt;
    }

    consumeStep() {
      if(!this.canStep())return false;
      this.accumulator=Math.max(0,this.accumulator-this.dt);
      if(this.accumulator<this._epsilon)this.accumulator=0;
      this.frameSteps++;this.totalSteps++;
      return true;
    }
  }
  return FixedStepClock;
});
