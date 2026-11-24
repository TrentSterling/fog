/* FogLab gameplay impulses. Fixed-step, DOM-free, and independent of the solver. */
(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
  root.FogLab=root.FogLab||{};root.FogLab.Interactions=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const SLASH_DURATION=.42, GRAVITY=12, JUMP_SPEED=4.5;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  function beginJump(actor){
    if(!actor||actor.jump>0||actor.verticalVelocity>0)return false;
    actor.jump=0;actor.verticalVelocity=JUMP_SPEED;return true;
  }
  function advanceJump(actor,dt){
    if(!(dt>0)||(!actor.jump&&!actor.verticalVelocity))return false;
    const next=actor.jump+actor.verticalVelocity*dt-.5*GRAVITY*dt*dt;
    actor.verticalVelocity-=GRAVITY*dt;
    if(next<=0&&actor.verticalVelocity<0){actor.jump=0;actor.verticalVelocity=0;return true;}
    actor.jump=Math.max(0,next);return false;
  }
  function beginSlash(actor){
    if(!actor||actor.slashAge<SLASH_DURATION)return false;
    actor.slashAge=0;actor.slashHeading=actor.heading||0;actor.slashOrigin={x:actor.x,z:actor.z};return true;
  }
  function slashPoint(x,z,heading,progress,reach){
    const angle=heading-1.28+2.56*clamp(progress,0,1);
    return {x:x-Math.sin(angle)*reach,z:z-Math.cos(angle)*reach};
  }
  function resolveMotion(from,to,obstacles,padding=.23){
    let x=from.x,z=from.z;const dx=to.x-x,dz=to.z-z;
    const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.12));
    for(let step=0;step<steps;step++){
      const oldX=x,oldZ=z;x+=dx/steps;z+=dz/steps;
      for(let pass=0;pass<2;pass++)for(const solid of obstacles){
        const radius=solid.radius+padding;let sx=x-solid.x,sz=z-solid.z,d=Math.hypot(sx,sz);
        if(d>=radius)continue;
        if(d<1e-7){sx=oldX-solid.x;sz=oldZ-solid.z;d=Math.hypot(sx,sz);if(d<1e-7){sx=1;sz=0;d=1;}}
        x=solid.x+sx/d*radius;z=solid.z+sz/d*radius;
      }
    }
    return {x,z};
  }
  function advanceSlash(actor,dt,radius=1.35){
    if(!(dt>0)||!(actor.slashAge<SLASH_DURATION))return [];
    const oldAge=actor.slashAge,nextAge=Math.min(SLASH_DURATION,oldAge+dt);
    const previous=actor.slashOrigin||actor;
    const sources=[];
    // Three swept capsules cover the blade length as well as the moving tip.
    for(const reach of [.70,1.32,1.94]){
      const p=slashPoint(previous.x,previous.z,actor.slashHeading,oldAge/SLASH_DURATION,reach);
      const q=slashPoint(actor.x,actor.z,actor.slashHeading,nextAge/SLASH_DURATION,reach);
      sources.push({x0:p.x,z0:p.z,x1:q.x,z1:q.z,radius:clamp(radius*.25,.22,.55),
        strength:1.8,vx:(q.x-p.x)/dt,vz:(q.z-p.z)/dt,swirl:.75,y:(actor.jump||0)+.84});
    }
    actor.slashAge=nextAge;actor.slashOrigin={x:actor.x,z:actor.z};
    actor.slashAngle=actor.slashHeading-1.28+2.56*nextAge/SLASH_DURATION;
    return sources;
  }
  return Object.freeze({SLASH_DURATION,beginJump,advanceJump,beginSlash,advanceSlash,slashPoint,resolveMotion});
});
