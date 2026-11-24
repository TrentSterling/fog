/* FogLab CPU Stable Fluids. DOM-free reference implementation.
 * Cell-centered Float32 fields, world-space metres/second, identical field
 * channels and artistic sources to the GPU solver. This is a collocated-grid
 * approximation with Jacobi projection, not a staggered MAC-grid solver.
 * No WebGL, compute shader, readback, worker, or allocation inside cell loops.
 */
(function (root, factory) {
  'use strict';
  const utilities = root.FogLab?.FieldUtils || (typeof require === 'function' ? require('./field-utils.js') : null);
  const Solver = factory(utilities);
  if (typeof module === 'object' && module.exports) module.exports = Solver;
  root.FogLab = root.FogLab || {};
  root.FogLab.CPUFluidSolver = Solver;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (utilities) {
  'use strict';
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
  const number = (value, fallback, lo = -Infinity, hi = Infinity) => Number.isFinite(value) ? clamp(value, lo, hi) : fallback;
  const smooth = (lo, hi, value) => { const q = clamp((value - lo) / (hi - lo), 0, 1); return q * q * (3 - 2 * q); };
  const clock = () => typeof performance === 'object' ? performance.now() : Date.now();

  class CPUFluidSolver {
    constructor(options = {}) {
      if (!utilities) throw new Error('CPUFluidSolver requires FogLab.FieldUtils.');
      this.resolution = Math.round(number(options.resolution, 128, 32, 256));
      this.worldSize = number(options.worldSize, 32, 1, 1024);
      this.noise = options.noise || {data:new Uint8Array([128,128,128,128]),width:1,height:1};
      this.noiseScale = this.noise.data instanceof Float32Array ? 1 : 1 / 255;
      this.obstacles = [];
      this.obstaclesEnabled = true;
      this.wind = .4;
      this.lastStepMs = 0;
      this.stepCount = 0;
      this._actors = Array.from({length:8}, () => ({}));
      this._segments = Array.from({length:8}, () => ({}));
      this._allocate();
      this.reset();
    }

    _allocate() {
      const n = this.resolution, count = n * n;
      this.cellSize = this.worldSize / n;
      for (const name of ['u','v','uNext','vNext','density','densityNext','energy','energyNext',
        'pressure','pressureNext','curl','divergence','equilibrium']) this[name] = new Float32Array(count);
      for (const name of ['left','right','bottom','top']) this[name] = new Int32Array(count);
      this.neighborCount = new Uint8Array(count);
      this.coordinates = new Float32Array(n);
      for (let i=0;i<n;i++) this.coordinates[i] = ((i+.5)/n-.5)*this.worldSize;
      this.mask = utilities.buildObstacleMask(n,this.worldSize,this.obstacles,this.obstaclesEnabled);
      this._buildNeighbors();
      for (let y=0;y<n;y++) for(let x=0;x<n;x++) this.equilibrium[y*n+x] = this.bankDensity(this.coordinates[x],this.coordinates[y]);
    }

    _buildNeighbors() {
      const n=this.resolution,mask=this.mask;
      this.solidCellCount=0;
      for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
        const i=y*n+x;
        if(mask[i])this.solidCellCount++;
        this.left[i]=x>0&&!mask[i-1]?i-1:-1;
        this.right[i]=x<n-1&&!mask[i+1]?i+1:-1;
        this.bottom[i]=y>0&&!mask[i-n]?i-n:-1;
        this.top[i]=y<n-1&&!mask[i+n]?i+n:-1;
        this.neighborCount[i]=(this.left[i]>=0)+(this.right[i]>=0)+(this.bottom[i]>=0)+(this.top[i]>=0);
      }
    }

    setObstacles(obstacles = [], enabled = true) {
      this.obstacles=Array.isArray(obstacles)?obstacles.map(o=>({x:o.x,z:o.z,radius:o.radius})):[];
      this.obstaclesEnabled=!!enabled;
      this.mask=utilities.buildObstacleMask(this.resolution,this.worldSize,this.obstacles,this.obstaclesEnabled);
      this._buildNeighbors();
      // Remove stale material immediately when a formerly fluid cell is covered.
      for(let i=0;i<this.mask.length;i++)if(this.mask[i]) {
        this.u[i]=this.v[i]=this.density[i]=this.energy[i]=this.pressure[i]=this.curl[i]=this.divergence[i]=0;
      }
      this._bound(this.u,this.v);
    }

    setResolution(value) {
      const n=Math.round(number(value,this.resolution,32,256));
      if(n===this.resolution)return false;
      this.resolution=n;this._allocate();this.reset();return true;
    }

    // Repeat-wrapped, bilinear sampling of the same static atlas as the GPU.
    // The CPU deliberately uses the base mip level, so CPU/GPU values need not
    // be bit-identical when implicit GPU mip selection changes with resolution.
    sampleNoise(u,v,channel) {
      const image=this.noise,w=image.width,h=image.height,data=image.data;
      const qx=(u-Math.floor(u))*w-.5,qy=(v-Math.floor(v))*h-.5;
      const ix=Math.floor(qx),iy=Math.floor(qy),fx=qx-ix,fy=qy-iy;
      const x0=(ix+w)%w,x1=(x0+1)%w,y0=(iy+h)%h,y1=(y0+1)%h;
      const a=data[(y0*w+x0)*4+channel],b=data[(y0*w+x1)*4+channel];
      const c=data[(y1*w+x0)*4+channel],d=data[(y1*w+x1)*4+channel];
      return ((a+(b-a)*fx)*(1-fy)+(c+(d-c)*fx)*fy)*this.noiseScale;
    }

    bankDensity(x,z) {
      const qx=x+(this.sampleNoise(x*.021+.31,z*.021+.71,2)*2-1)*.95;
      const qz=z+(this.sampleNoise(x*.021+.31,z*.021+.71,3)*2-1)*.95;
      const broad=this.sampleNoise(qx*.055+.19,qz*.055+.37,0);
      const cx=this.sampleNoise(x*.065+.63,z*.065+.29,2)*2-1;
      const cz=this.sampleNoise(x*.065+.63,z*.065+.29,3)*2-1;
      const medium=this.sampleNoise(qx*.105+cx*.045+.47,qz*.105+cz*.045+.13,1);
      return 1.6*smooth(.36,.82,broad)*(.20+.80*medium);
    }

    _ambient(x,y,time,wind) {
      const n=this.resolution,qx=(x+.5)/n*2+.004*time,qy=(y+.5)/n*2-.0027*time,d=2/n;
      const l=this.sampleNoise(qx-d,qy,0),r=this.sampleNoise(qx+d,qy,0);
      const b=this.sampleNoise(qx,qy-d,0),t=this.sampleNoise(qx,qy+d,0);
      const factor=1.8/(2*this.cellSize);
      this.ambientU=wind*(.35+(t-b)*factor);
      this.ambientV=wind*(.13+(l-r)*factor);
    }

    reset(settings = {}) {
      this.wind=number(settings.wind,this.wind,0,2);
      for(const name of ['uNext','vNext','densityNext','energy','energyNext','pressure','pressureNext','curl','divergence'])this[name].fill(0);
      const n=this.resolution;
      for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
        const i=y*n+x;
        if(this.mask[i]){this.u[i]=this.v[i]=this.density[i]=0;continue;}
        this._ambient(x,y,0,this.wind);
        this.u[i]=this.ambientU;this.v[i]=this.ambientV;this.density[i]=this.equilibrium[i];
      }
      this._bound(this.u,this.v);
      this.stepCount=0;this.lastStepMs=0;
    }

    _bound(u,v) {
      for(let i=0;i<this.mask.length;i++) {
        if(this.mask[i]){u[i]=v[i]=0;continue;}
        let x=u[i],y=v[i];
        if(this.left[i]<0||this.right[i]<0)x=0;
        if(this.bottom[i]<0||this.top[i]<0)y=0;
        const scale=Math.min(1,10/Math.max(Math.sqrt(x*x+y*y),.0001));
        u[i]=x*scale;v[i]=y*scale;
      }
    }

    // Trace in cell coordinates. Half-cell subdivisions catch a solid even
    // when the final sample lands beyond a narrow obstacle; interpolation then
    // excludes solid taps instead of diluting material with the solid's zeros.
    _trace(x,y,u,v,dt) {
      const n=this.resolution,tx=clamp(x-dt*u/this.cellSize,0,n-1),ty=clamp(y-dt*v/this.cellSize,0,n-1);
      if(!this.solidCellCount){this.traceX=tx;this.traceY=ty;return;}
      const dx=tx-x,dy=ty-y,steps=Math.min(32,Math.max(1,Math.ceil(Math.sqrt(dx*dx+dy*dy)*2)));
      let previousX=x,previousY=y;
      for(let step=1;step<=steps;step++) {
        const q=step/steps,px=x+dx*q,py=y+dy*q;
        if(this.mask[Math.round(py)*n+Math.round(px)])break;
        previousX=px;previousY=py;
      }
      this.traceX=previousX;this.traceY=previousY;
    }

    _weights(x,y,local) {
      const n=this.resolution,x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(n-1,x0+1),y1=Math.min(n-1,y0+1),fx=x-x0,fy=y-y0;
      this.i0=y0*n+x0;this.i1=y0*n+x1;this.i2=y1*n+x0;this.i3=y1*n+x1;
      this.w0=this.mask[this.i0]?0:(1-fx)*(1-fy);this.w1=this.mask[this.i1]?0:fx*(1-fy);
      this.w2=this.mask[this.i2]?0:(1-fx)*fy;this.w3=this.mask[this.i3]?0:fx*fy;
      const total=this.w0+this.w1+this.w2+this.w3;
      if(total<.00001){this.i0=local;this.w0=1;this.w1=this.w2=this.w3=0;}
      else{const inv=1/total;this.w0*=inv;this.w1*=inv;this.w2*=inv;this.w3*=inv;}
    }

    _sample(field){return field[this.i0]*this.w0+field[this.i1]*this.w1+field[this.i2]*this.w2+field[this.i3]*this.w3;}

    _prepareSources(interactors,segments,settings,dt) {
      let count=0;
      for(const source of interactors) {
        if(count===8)break;
        if(!source||!Number.isFinite(source.x)||!Number.isFinite(source.z))continue;
        const a=this._actors[count++],vx=number(source.vx,0,-100,100),vz=number(source.vz,0,-100,100);
        const originalSpeed=Math.hypot(vx,vz),scale=Math.min(1,9/Math.max(originalSpeed,.001));
        a.x=clamp(source.x,-1e4,1e4);a.z=clamp(source.z,-1e4,1e4);a.vx=vx*scale;a.vz=vz*scale;a.speed=Math.min(originalSpeed,9);
        a.radius=number(source.radius,number(settings.radius,1.15,.2,8),.2,8);
        a.power=number(source.strength,1,0,4)*number(settings.strength,1,0,2.5);
        a.dirX=a.vx/Math.max(a.speed,.001);a.dirZ=a.vz/Math.max(a.speed,.001);
        // Density uses the actual traversed actor segment, bounded against
        // malicious/non-finite sources rather than an unbounded backtrace.
        a.startX=a.x-vx*dt;a.startZ=a.z-vz*dt;
        a.clearFactor=1-Math.exp(-dt*20*a.power);
      }
      this.actorCount=count;count=0;
      for(const source of segments) {
        if(count===8)break;
        if(!source||![source.x0,source.z0,source.x1,source.z1].every(Number.isFinite))continue;
        const a=this._segments[count++];
        a.x0=clamp(source.x0,-1e4,1e4);a.z0=clamp(source.z0,-1e4,1e4);a.dx=clamp(source.x1,-1e4,1e4)-a.x0;a.dz=clamp(source.z1,-1e4,1e4)-a.z0;
        a.inverseLengthSquared=1/Math.max(a.dx*a.dx+a.dz*a.dz,.00001);
        a.radius=number(source.radius,.3,.12,8);
        a.power=number(source.strength,1,0,4)*number(settings.strength,1,0,2.5);
        const vx=number(source.vx,0,-100,100),vz=number(source.vz,0,-100,100),speed=Math.hypot(vx,vz),scale=Math.min(1,12/Math.max(speed,.001));
        a.vx=vx*scale;a.vz=vz*scale;a.speed=Math.min(speed,12);a.swirl=number(source.swirl,0,-8,8);
        a.clearFactor=1-Math.exp(-dt*32*a.power);
      }
      this.segmentCount=count;
    }

    _velocityStep(dt,time,settings) {
      const n=this.resolution,u=this.u,v=this.v,outU=this.uNext,outV=this.vNext;
      const decay=Math.exp(-dt*.095),ambientMix=1-Math.exp(-dt*.12),swirl=number(settings.swirl,.8,0,2.5);
      const style=settings.wakeStyle||'paired';
      for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
        const i=y*n+x;
        if(this.mask[i]){outU[i]=outV[i]=0;continue;}
        this._trace(x,y,u[i],v[i],dt);this._weights(this.traceX,this.traceY,i);
        let vx=this._sample(u)*decay,vz=this._sample(v)*decay;
        this._ambient(x,y,time,this.wind);
        vx+=(this.ambientU-vx)*ambientMix;vz+=(this.ambientV-vz)*ambientMix;
        const px=this.coordinates[x],pz=this.coordinates[y];
        for(let j=0;j<this.actorCount;j++) {
          const a=this._actors[j],dx=px-a.x,dz=pz-a.z,r=a.radius,d2=dx*dx+dz*dz;
          if(d2>r*r*25)continue;
          const len=Math.sqrt(d2);
          const body=Math.exp(-(dx*dx+dz*dz)/(r*r*.58)),scale=body*dt*a.power;
          vx+=(a.vx*3.6+dx/Math.max(len,.08)*a.speed*2.8)*scale;
          vz+=(a.vz*3.6+dz/Math.max(len,.08)*a.speed*2.8)*scale;
          if(style==='tangential') {
            const spin=a.speed*swirl*a.power*dt*4.6*body/Math.max(len,.08);
            vx-=dz*spin;vz+=dx*spin;
          } else if(style!=='radial') {
            const centerX=a.x-a.dirX*r*.7,centerZ=a.z-a.dirZ*r*.7;
            const dlx=px-(centerX-a.dirZ*r*.8),dlz=pz-(centerZ+a.dirX*r*.8);
            const drx=px-(centerX+a.dirZ*r*.8),drz=pz-(centerZ-a.dirX*r*.8);
            const falloff=Math.max(r*r*1.1,.01),l=Math.exp(-(dlx*dlx+dlz*dlz)/falloff),rr=Math.exp(-(drx*drx+drz*drz)/falloff);
            const pair=a.speed/r*swirl*a.power*dt*4.6;
            vx+=(-dlz*l+drz*rr)*pair;vz+=(dlx*l-drx*rr)*pair;
          }
        }
        for(let j=0;j<this.segmentCount;j++) {
          const a=this._segments[j],q=clamp(((px-a.x0)*a.dx+(pz-a.z0)*a.dz)*a.inverseLengthSquared,0,1);
          const dx=px-a.x0-a.dx*q,dz=pz-a.z0-a.dz*q,d=Math.hypot(dx,dz);
          if(d>a.radius*5)continue;
          const f=Math.exp(-d*d/(a.radius*a.radius*.72))*a.power*dt;
          vx+=(a.vx*4.5-dz/Math.max(d,.08)*a.swirl*4)*f;
          vz+=(a.vz*4.5+dx/Math.max(d,.08)*a.swirl*4)*f;
        }
        outU[i]=vx;outV[i]=vz;
      }
      this.u=outU;this.v=outV;this.uNext=u;this.vNext=v;
      this._bound(this.u,this.v);
    }

    _curlAndConfinement(dt,amount) {
      const u=this.u,v=this.v,curl=this.curl,mask=this.mask,inv=1/(2*this.cellSize);
      for(let i=0;i<mask.length;i++) {
        if(mask[i]){curl[i]=0;continue;}
        const l=this.left[i],r=this.right[i],b=this.bottom[i],t=this.top[i];
        curl[i]=((r<0?v[i]:v[r])-(l<0?v[i]:v[l])-(t<0?u[i]:u[t])+(b<0?u[i]:u[b]))*inv;
      }
      if(amount<=.001)return;
      const gain=amount*7*this.cellSize,n=this.resolution;
      for(let i=0;i<mask.length;i++) {
        if(mask[i])continue;
        const l=this.left[i],r=this.right[i],b=this.bottom[i],t=this.top[i],c=Math.abs(curl[i]);
        // GPU texture sampling clamps at the outer wall; obstacle curl cells
        // contain zero. Preserve that distinction for the confinement gradient.
        const gx=(r<0?(i%n===n-1?c:0):Math.abs(curl[r]))-(l<0?(i%n===0?c:0):Math.abs(curl[l]));
        const gy=(t<0?(i>=mask.length-n?c:0):Math.abs(curl[t]))-(b<0?(i<n?c:0):Math.abs(curl[b]));
        const scale=curl[i]*gain/Math.max(Math.sqrt(gx*gx+gy*gy),.0001);
        u[i]+=dt*clamp(gy*scale,-12,12);v[i]+=dt*clamp(-gx*scale,-12,12);
      }
      this._bound(u,v);
    }

    _divergenceAt(i) {
      const l=this.left[i],r=this.right[i],b=this.bottom[i],t=this.top[i],u=this.u,v=this.v;
      return ((r<0?-u[i]:u[r])-(l<0?-u[i]:u[l])+(t<0?-v[i]:v[t])-(b<0?-v[i]:v[b]))/(2*this.cellSize);
    }

    projectVelocity(iterations = 18) {
      const count=this.mask.length,h2=this.cellSize*this.cellSize;
      const mask=this.mask,div=this.divergence,left=this.left,right=this.right,bottom=this.bottom,top=this.top;
      this._bound(this.u,this.v);
      for(let i=0;i<count;i++)div[i]=mask[i]?0:this._divergenceAt(i);
      this.pressure.fill(0);this.pressureNext.fill(0);
      let p=this.pressure,next=this.pressureNext;
      const passes=Math.round(number(iterations,18,2,40));
      for(let pass=0;pass<passes;pass++) {
        for(let i=0;i<count;i++) {
          const neighbors=this.neighborCount[i];
          if(mask[i]||!neighbors){next[i]=0;continue;}
          const l=left[i],r=right[i],b=bottom[i],t=top[i];
          next[i]=((l<0?0:p[l])+(r<0?0:p[r])+(b<0?0:p[b])+(t<0?0:p[t])-div[i]*h2)/neighbors;
        }
        const previous=p;p=next;next=previous;
      }
      this.pressure=p;this.pressureNext=next;
      const factor=1/(2*this.cellSize);
      for(let i=0;i<count;i++) {
        if(mask[i])continue;
        const l=left[i],r=right[i],b=bottom[i],t=top[i],center=p[i];
        this.u[i]-=((r<0?center:p[r])-(l<0?center:p[l]))*factor;
        this.v[i]-=((t<0?center:p[t])-(b<0?center:p[b]))*factor;
      }
      this._bound(this.u,this.v);
    }

    _densityStep(dt,settings) {
      const n=this.resolution,previous=this.density,previousEnergy=this.energy,out=this.densityNext,energyOut=this.energyNext;
      const persistence=number(settings.persistence,5,.6,12),recovery=1-Math.exp(-dt/Math.max(persistence*2.5,1.5));
      const energyDecay=Math.exp(-dt/Math.max(persistence*.65,.2));
      for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
        const i=y*n+x;
        if(this.mask[i]){out[i]=energyOut[i]=0;continue;}
        this._trace(x,y,this.u[i],this.v[i],dt);this._weights(this.traceX,this.traceY,i);
        const advected=this._sample(previous),rest=this.equilibrium[i];
        let density=advected+(rest-advected)*recovery,energy=this._sample(previousEnergy)*energyDecay;
        const px=this.coordinates[x],pz=this.coordinates[y];
        for(let j=0;j<this.actorCount;j++) {
          const a=this._actors[j],abx=a.x-a.startX,abz=a.z-a.startZ;
          const q=clamp(((px-a.startX)*abx+(pz-a.startZ)*abz)/Math.max(abx*abx+abz*abz,.00001),0,1);
          const distance=Math.hypot(px-a.startX-abx*q,pz-a.startZ-abz*q),r=a.radius;
          if(distance>r*5)continue;
          const d=distance/(r*.73),clearing=Math.exp(-d*d*d*d);
          density+=(Math.min(density,rest*(1-.985*clearing))-density)*a.clearFactor;
          const shoulder=(distance-r*.98)/(r*.28),ring=Math.exp(-shoulder*shoulder);
          density+=ring*Math.min(a.speed,5)*a.power*dt*.16*clamp(advected,0,1.2);
          energy=Math.max(energy,Math.max(clearing*.75,ring)*Math.min(1,a.power));
        }
        for(let j=0;j<this.segmentCount;j++) {
          const a=this._segments[j],q=clamp(((px-a.x0)*a.dx+(pz-a.z0)*a.dz)*a.inverseLengthSquared,0,1);
          const distance=Math.hypot(px-a.x0-a.dx*q,pz-a.z0-a.dz*q),r=a.radius;
          if(distance>r*5)continue;
          const d=distance/(r*.8),clearing=Math.exp(-d*d*d*d);
          density+=(Math.min(density,rest*(1-.995*clearing))-density)*a.clearFactor;
          const shoulder=(distance-r)/(r*.32),ring=Math.exp(-shoulder*shoulder);
          density+=ring*Math.min(a.speed,8)*a.power*dt*.12*clamp(advected,0,1.2);
          energy=Math.max(energy,Math.max(clearing,ring)*Math.min(1,a.power));
        }
        out[i]=clamp(density,0,1.65);energyOut[i]=clamp(energy,0,1);
      }
      this.density=out;this.densityNext=previous;this.energy=energyOut;this.energyNext=previousEnergy;
    }

    step(dt,time,interactors = [],settings = {},segments = []) {
      if(!Number.isFinite(dt)||dt<=0)return false;
      const started=clock();dt=Math.min(dt,1/20);time=number(time,0,-1e7,1e7);
      this.wind=number(settings.wind,.4,0,2);
      this._prepareSources(Array.isArray(interactors)?interactors:[],Array.isArray(segments)?segments:[],settings,dt);
      this._velocityStep(dt,time,settings);
      this._curlAndConfinement(dt,number(settings.vorticity,.4,0,1.8));
      this.projectVelocity(settings.pressure);
      this._densityStep(dt,settings);
      this.stepCount++;this.lastStepMs=clock()-started;return true;
    }

    packRGBA(target) {
      if(target.length!==this.mask.length*4)throw new Error('CPU field upload has the wrong size.');
      for(let i=0;i<this.mask.length;i++) {
        const offset=i*4;target[offset]=this.u[i];target[offset+1]=this.v[i];target[offset+2]=this.density[i];target[offset+3]=this.energy[i];
      }
      return target;
    }

    get memoryBytes() {
      let bytes=0;
      for(const value of Object.values(this))if(ArrayBuffer.isView(value))bytes+=value.byteLength;
      return bytes;
    }

    getDiagnostics() {
      let finite=true,densityMin=Infinity,densityMax=-Infinity,densitySum=0,speedMax=0,disturbedTexels=0;
      let preSquared=0,postSquared=0,fluidCount=0,solidDensityMax=0,solidSpeedMax=0,normalSpeedMax=0;
      for(let i=0;i<this.mask.length;i++) {
        const d=this.density[i],speed=Math.hypot(this.u[i],this.v[i]);
        finite=finite&&Number.isFinite(d)&&Number.isFinite(speed)&&Number.isFinite(this.energy[i])&&Number.isFinite(this.pressure[i]);
        densityMin=Math.min(densityMin,d);densityMax=Math.max(densityMax,d);densitySum+=d;speedMax=Math.max(speedMax,speed);
        if(this.energy[i]>.1)disturbedTexels++;
        if(this.mask[i]){solidDensityMax=Math.max(solidDensityMax,Math.abs(d));solidSpeedMax=Math.max(solidSpeedMax,speed);continue;}
        fluidCount++;preSquared+=this.divergence[i]**2;postSquared+=this._divergenceAt(i)**2;
        if(this.left[i]<0||this.right[i]<0)normalSpeedMax=Math.max(normalSpeedMax,Math.abs(this.u[i]));
        if(this.bottom[i]<0||this.top[i]<0)normalSpeedMax=Math.max(normalSpeedMax,Math.abs(this.v[i]));
      }
      const before=Math.sqrt(preSquared/Math.max(fluidCount,1)),after=Math.sqrt(postSquared/Math.max(fluidCount,1));
      return {supported:true,mode:'cpu',resolution:this.resolution,finite,densityMin,densityMax,
        densityMean:densitySum/this.mask.length,speedMax,disturbedTexels,solidCellCount:this.solidCellCount,solidCells:this.solidCellCount,
        solidDensityMax,solidSpeedMax,normalSpeedMax,obstacleBoundaryMaxNormalSpeed:normalSpeedMax,divergenceBeforeRMS:before,divergenceAfterRMS:after,
        divergenceReduction:1-after/Math.max(before,1e-8),stepCount:this.stepCount,lastSolveMs:this.lastStepMs,
        memoryBytes:this.memoryBytes,passCount:0};
    }
  }
  return CPUFluidSolver;
});
