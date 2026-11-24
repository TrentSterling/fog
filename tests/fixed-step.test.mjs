import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context=vm.createContext({module:{exports:{}}});
vm.runInContext(fs.readFileSync(new URL('../src/fixed-step.js',import.meta.url),'utf8'),context);
const FixedStepClock=context.module.exports;
const drain=clock=>{let count=0;while(clock.consumeStep())count++;return count;};
const near=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} differs from ${expected}`);

test('steady display rates produce the same thirty simulation ticks per second',()=>{
  for(const hz of [30,60,72,90,120,144]){
    const clock=new FixedStepClock();
    for(let frame=0;frame<hz*10;frame++){clock.beginFrame(1/hz);drain(clock);}
    assert.equal(clock.totalSteps,300,`${hz} Hz`);
    near(clock.accumulator,0);near(clock.droppedSeconds,0);
  }
});

test('a long stall has an explicit dropped-time budget and limited catch-up',()=>{
  const clock=new FixedStepClock();clock.beginFrame(2);
  near(clock.accumulator,.1);near(clock.droppedSeconds,1.9);
  assert.equal(drain(clock),3);assert.equal(clock.canStep(),false);near(clock.accumulator,0);
  clock.beginFrame(1/60);assert.equal(drain(clock),0);
  clock.beginFrame(1/60);assert.equal(drain(clock),1);
  near(clock.totalSteps*clock.dt+clock.accumulator+clock.droppedSeconds,2+1/30);
});

test('a busy asynchronous solver cannot accumulate an unbounded backlog',()=>{
  const clock=new FixedStepClock();
  // Five seconds of displayed frames arrive while no solver work is accepted.
  for(let frame=0;frame<300;frame++)clock.beginFrame(1/60);
  near(clock.accumulator,.1);near(clock.droppedSeconds,4.9);assert.equal(clock.totalSteps,0);
  assert.equal(drain(clock),3);near(clock.accumulator,0);
  clock.beginFrame(0);assert.equal(drain(clock),0);
});

test('per-frame step limit holds even when a larger backlog is allowed',()=>{
  const clock=new FixedStepClock({dt:.01,maxSteps:2,maxBacklog:.06});clock.beginFrame(.06);
  assert.equal(drain(clock),2);near(clock.accumulator,.04);
  assert.equal(clock.consumeStep(),false);assert.equal(clock.frameSteps,2);
  clock.beginFrame(0);assert.equal(drain(clock),2);near(clock.accumulator,.02);
  clock.beginFrame(0);assert.equal(drain(clock),2);near(clock.accumulator,0);
});

test('pause and hidden tabs discard stale time without a resume burst',()=>{
  for(const suspension of [{paused:true},{visible:false}]){
    const clock=new FixedStepClock();clock.beginFrame(.05);assert.equal(clock.consumeStep(),true);
    const before=clock.totalSteps;clock.beginFrame(20,suspension);
    near(clock.accumulator,0);assert.equal(clock.canStep(),false);
    clock.beginFrame(20);assert.equal(drain(clock),0);assert.equal(clock.totalSteps,before);
    clock.beginFrame(1/30);assert.equal(drain(clock),1);near(clock.droppedSeconds,0);
  }
});

test('invalid elapsed intervals leave existing valid time and counters finite',()=>{
  const clock=new FixedStepClock();clock.beginFrame(1/60);
  for(const elapsed of [NaN,Infinity,-Infinity,-1,undefined,null,'1']){
    clock.beginFrame(elapsed);near(clock.accumulator,1/60);near(clock.droppedSeconds,0);
    assert.equal(clock.consumeStep(),false);
  }
  clock.beginFrame(Number.MAX_VALUE);clock.beginFrame(Number.MAX_VALUE);
  assert.equal(Number.isFinite(clock.droppedSeconds),true);near(clock.accumulator,.1);
  assert.equal(drain(clock),3);
});

test('reset clears overload, pending elapsed time, and frame history',()=>{
  const clock=new FixedStepClock();clock.beginFrame(1);clock.consumeStep();
  clock.beginFrame(10,{paused:true});clock.reset();
  assert.equal(clock.totalSteps,0);assert.equal(clock.frameSteps,0);
  assert.equal(clock.accumulator,0);assert.equal(clock.droppedSeconds,0);
  clock.beginFrame(1/30);assert.equal(clock.consumeStep(),true);
});

test('invalid clock configurations fail before animation starts',()=>{
  for(const options of [{dt:0},{dt:NaN},{dt:-1},{maxSteps:0},{maxSteps:1.5},{maxSteps:Infinity},{maxBacklog:0},{maxBacklog:NaN}]){
    assert.throws(()=>new FixedStepClock(options),error=>error.name==='RangeError');
  }
});
