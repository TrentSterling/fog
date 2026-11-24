/* FogLab: independent geometry / shallow-volume fog renderers.
 * GPU Gems 38 is the fluid reference; this renderer is an original visual experiment.
 * The analytical mode is a hypothesis, not a claim about Nintendo's implementation.
 */
(function () {
  'use strict';
  const F = window.FogLab = window.FogLab || {};
  const FS_VERT = `varying vec2 vUv;
    void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`;

  // The analytical provider and the GPU initial state share one bank recipe.
  // Large visible features are density features, not a second texture mask
  // painted over the density that the simulation actually transports.
  const BANK = F.fogBankGLSL || `
    float fogBankDensity(vec2 p){
      vec2 warp=(texture2D(uNoise,p*0.021+vec2(0.31,0.71)).ba*2.0-1.0)*0.95;
      vec2 q=p+warp;
      float broad=texture2D(uNoise,q*0.055+vec2(0.19,0.37)).r;
      vec2 curl=(texture2D(uNoise,p*0.065+vec2(0.63,0.29)).ba*2.0-1.0);
      float medium=texture2D(uNoise,q*0.105+curl*0.045+vec2(0.47,0.13)).g;
      return 1.6*smoothstep(0.36,0.82,broad)*(0.20+0.80*medium);
    }
  `;

  const COMMON = `
    uniform sampler2D uNoise, uField, uDepth, uAux, uObstacle;
    uniform float uTime,uHeight,uDensity,uRadius,uStrength,uSwirl,uPersistence,uWind;
    uniform float uNear,uFar,uContribution,uDetailStrength,uHeightShear,uWispStrength;
    uniform int uMode,uTrailCount,uDebug,uDensityProfile,uHeightMode,uLightingModel,uObstacles,uWakeStyle;
    uniform vec2 uResolution;
    uniform vec4 uSurfaceRelief;
    uniform vec3 uTint,uCamPos;
    uniform vec4 uTrails[24],uTrailVels[24],uTrailShape[24];
    float terrainHeight(vec2 p);
    ${BANK}
    float linearDepth(float d){return uNear*uFar/(uFar-d*(uFar-uNear));}
    vec2 perpendicular(vec2 p){return vec2(-p.y,p.x);}
    float solidAt(vec2 p){
      if(uObstacles==0)return 0.0;
      return step(0.5,texture2D(uObstacle,p/32.0+0.5).r);
    }
    float fieldEdge(vec2 p){
      // Rounded corners keep the finite simulation domain from reading as a
      // rectangular white carpet in an overhead inspection view.
      vec2 q=abs(p);float boundary=pow(pow(q.x,6.0)+pow(q.y,6.0),1.0/6.0);
      return 1.0-smoothstep(13.0,16.0,boundary);
    }
    vec4 sampleField(vec2 p){
      if(solidAt(p)>0.5)return vec4(0.0);
      if(uMode>0){return texture2D(uField,p/32.0+0.5);}
      float hole=0.0,lift=0.0;vec2 motion=vec2(0.0);
      for(int i=0;i<24;i++){
        if(i>=uTrailCount)break;
        vec4 tr=uTrails[i];
        float age=max(tr.z,0.0);
        float decay=exp(-age/max(uPersistence*0.58,0.15))*tr.w;
        vec4 shape=uTrailShape[i];
        float radius=max(0.15,shape.z>0.0?shape.z:uRadius)*(1.0+0.075*age);
        vec2 center=tr.xy;
        if(shape.w>0.5){
          // Explicit flag distinguishes a capsule from a circle, including
          // segments whose start lies exactly on a world axis or at the origin.
          vec2 segment=tr.xy-shape.xy;
          float along=clamp(dot(p-shape.xy,segment)/max(dot(segment,segment),0.000001),0.0,1.0);
          center=shape.xy+segment*along;
        }
        vec2 d=p-center;
        float r2=dot(d,d)/(radius*radius);
        if(r2>16.0)continue;
        float r=sqrt(r2);
        float core=exp(-pow(r/0.73,4.0))*decay;
        float edge=exp(-pow((r-1.02)/0.34,2.0))*decay;
        hole=max(hole,core*uStrength);
        lift=max(lift,edge*uStrength);
        vec2 dir=uTrailVels[i].xy;
        float speed=length(dir);
        dir=dir/max(speed,0.001);
        float side=dot(d,perpendicular(dir));
        float signSide=side>=0.0?1.0:-1.0;
        if(uWakeStyle==0||shape.w>0.5){
          // Preserve the original paired reconstruction. Swept blade stamps
          // retain their own curl independently of the actor wake selector.
          motion+=perpendicular(d)*edge*signSide*uSwirl*min(speed,4.0)*0.26;
        }else{
          // Match solver style conventions: radial keeps outward push and
          // entrainment; tangential adds a single-signed circulation. These
          // remain reconstructed history fields, not integrated fluid forces.
          float body=exp(-r2/0.58)*decay;
          float len=max(length(d),0.08);
          motion+=d/len*min(speed,4.0)*0.28*body;
          if(uWakeStyle==2)motion+=perpendicular(d)/len*min(speed,4.0)*uSwirl*0.46*body;
        }
        motion+=dir*core*min(speed,5.0)*0.18;
      }
      motion=clamp(motion,vec2(-4.0),vec2(4.0));
      vec2 drift=vec2(0.35,0.13)*uWind*uTime;
      float bank=fogBankDensity(p-drift+motion*0.18);
      float concentration=bank*(1.0-clamp(hole*0.992,0.0,0.997));
      concentration+=bank*lift*0.16;
      return vec4(motion,clamp(concentration,0.0,1.65),clamp(lift,0.0,1.0));
    }
    // Medium billows, roughly one metre across with the eight-cell G atlas.
    // These erode and fold a bank; they cannot create fog where field.b is zero.
    // Two staggered phases keep local flow from stretching indefinitely.
    float cloudNoise(vec2 p,vec4 field,float level){
      if(uDetailStrength<=0.0)return 0.5;
      vec2 drift=vec2(uTime*0.0022,uTime*0.0011)*uWind;
      vec2 flow=(texture2D(uNoise,p*0.045+drift*0.4).ba*2.0-1.0)*(0.08+min(uSwirl,1.5)*0.045);
      flow+=clamp(field.xy,vec2(-5.0),vec2(5.0))*0.045;
      float phase=fract(uTime*0.17);
      float shear=uDensityProfile==0?uHeightShear:0.0;
      vec2 q=p*0.135+drift+vec2(level*0.065,-level*0.080)*shear;
      float a=texture2D(uNoise,q-flow*phase).g;
      float b=texture2D(uNoise,q-flow*fract(phase+0.5)).g;
      float medium=mix(a,b,abs(phase*2.0-1.0));
      return clamp((medium-0.5)*1.65+0.5,0.0,1.0);
    }
    float detailDensity(float n){return 1.0+(n-0.5)*0.64*uDetailStrength;}

    // Two independently offset atlas slices interpolate a shallow 3D band.
    // A flat pattern sheared through height produces density curtains instead.
    float wispNoise(vec2 p,vec4 field,float worldY,float lod){
      vec2 drift=vec2(0.35,0.13)*uWind*uTime*0.07;
      vec2 curl=(texture2D(uNoise,p*0.085+drift*0.03).ba*2.0-1.0);
      vec2 q=(p+drift+curl*0.55+clamp(field.xy,vec2(-5.0),vec2(5.0))*0.16)*0.27;
      float vertical=uDensityProfile==0?(worldY*4.0+dot(curl,vec2(0.65,0.35)))*uHeightShear:0.0;
      float slice=floor(vertical),blend=fract(vertical);
      blend=blend*blend*(3.0-2.0*blend);
      vec2 stride=vec2(0.317,0.613);
      float a=textureLod(uNoise,q+slice*stride+vec2(0.23,0.67),lod).g;
      float b=textureLod(uNoise,q+(slice+1.0)*stride+vec2(0.23,0.67),lod).g;
      return clamp((mix(a,b,blend)-0.5)*1.85+0.5,0.0,1.0);
    }
    float densityDetail(vec2 p,vec4 field,float level,float n,float worldY,float footprint){
      if(uDetailStrength<=0.0)return 1.0;
      if(uWispStrength<=0.0)return detailDensity(n);
      // Filter the atlas over the distance between ray samples as well as
      // pixel coverage. A screen-only mip choice leaves grazing rays striped.
      float lod=max(0.0,log2(max(1.0,footprint*0.27*256.0*0.65)));
      float fine=wispNoise(p,field,worldY,lod);
      float fold=mix(n,fine,0.62);
      float edge=max(smoothstep(0.12,0.80,level),1.0-smoothstep(0.18,0.90,field.b));
      float erosion=0.10+1.55*smoothstep(0.26,0.72,fold);
      return detailDensity(n)*mix(1.0,erosion,clamp((0.35+0.60*edge)*uDetailStrength*uWispStrength,0.0,1.0));
    }
    float fogTop(vec2 p,vec4 field){
      // World mode lets hills break through the upper envelope. Terrain mode
      // translates the same local shape by the height of the ground beneath it.
      // Density sets the bank. Medium contours round its surface, while wake
      // energy raises occupied shoulders instead of making halos in clear air.
      float body=pow(clamp(field.b/1.50,0.0,1.15),0.62);
      float occupied=smoothstep(0.035,0.65,max(field.b,0.0));
      // Single sheets need gentler geometry than a volume to avoid folded
      // silhouettes. The same profile supplies their positions and normals;
      // concentration modulation remains fully detailed in every renderer.
      float contour=(cloudNoise(p,field,0.68)*2.0-1.0)*uSurfaceRelief.x*sqrt(occupied)*uDetailStrength;
      float shoulder=field.a*occupied*uSurfaceRelief.y*min(uSwirl,1.5);
      float base=uHeightMode==1?terrainHeight(p):0.0;
      return base+uHeight*(uSurfaceRelief.z+uSurfaceRelief.w*body+contour)+shoulder;
    }
    vec3 fogSurfaceNormal(vec2 p,vec4 field,float layer){
      const float e=0.32;
      vec4 a,b,c,d;
      if(uMode>0){
        a=sampleField(p-vec2(e,0.0));
        b=sampleField(p+vec2(e,0.0));
        c=sampleField(p-vec2(0.0,e));
        d=sampleField(p+vec2(0.0,e));
      }else{
        // Lighting uses the bank gradient and current clearing ratio. It does
        // not repeat the 24-stamp history reconstruction for every neighbour.
        vec2 q=p-vec2(0.35,0.13)*uWind*uTime+field.xy*0.18;
        float ratio=clamp(field.b/max(fogBankDensity(q),0.025),0.0,1.5);
        a=vec4(field.xy,fogBankDensity(q-vec2(e,0.0))*ratio,field.a);
        b=vec4(field.xy,fogBankDensity(q+vec2(e,0.0))*ratio,field.a);
        c=vec4(field.xy,fogBankDensity(q-vec2(0.0,e))*ratio,field.a);
        d=vec4(field.xy,fogBankDensity(q+vec2(0.0,e))*ratio,field.a);
        if(uObstacles>0){
          a*=1.0-solidAt(p-vec2(e,0.0));b*=1.0-solidAt(p+vec2(e,0.0));
          c*=1.0-solidAt(p-vec2(0.0,e));d*=1.0-solidAt(p+vec2(0.0,e));
        }
      }
      vec4 heights=vec4(fogTop(p-vec2(e,0.0),a),fogTop(p+vec2(e,0.0),b),
        fogTop(p-vec2(0.0,e),c),fogTop(p+vec2(0.0,e),d))*layer;
      if(uHeightMode==1){
        // The base also slopes with the terrain. Scaling only the top normal
        // by layer would incorrectly flatten the lower terrain-following shells.
        heights+=(1.0-layer)*vec4(terrainHeight(p-vec2(e,0.0)),terrainHeight(p+vec2(e,0.0)),
          terrainHeight(p-vec2(0.0,e)),terrainHeight(p+vec2(0.0,e)));
      }
      return normalize(vec3(heights.x-heights.y,2.0*e,heights.z-heights.w));
    }
    vec3 fogLight(float n,float elevation){
      // Optical density and illumination are intentionally separate. Fine
      // noise must not turn every local concentration peak into a white fleck.
      return uTint*mix(0.64,1.0,clamp(elevation,0.0,1.0));
    }
  `;

  const MESH_VERT = `
    uniform float uLayer;
    varying vec3 vWorld;
    varying vec3 vFogNormal;
    varying vec2 vWarp;
    varying vec4 vField;
    varying float vViewDepth,vThickness,vLevel;
    void main(){
      vec2 p=position.xz;
      vec4 f=sampleField(p);
      vec2 shift=clamp(f.xy,vec2(-3.0),vec2(3.0))*0.085;
      // Columns use the same footprint at every shell height. Billows retain
      // the original layer-dependent offset as well as their noise shear.
      p+=shift*(0.4+(uDensityProfile==1?0.84:uLayer));
      float top=fogTop(p,f);
      // Keep vertices below protruding terrain; scene depth clips them. Raising
      // vertices back onto the terrain here would recreate the snowy blanket.
      float base=uHeightMode==1?terrainHeight(p)-0.06:-0.06;
      vec3 wp=vec3(p.x,mix(base,top,uLayer),p.y);
      vThickness=max(0.0,top-terrainHeight(p));
      vField=f;vWorld=wp;vWarp=p+f.xy*0.08;vLevel=uLayer;
      vFogNormal=fogSurfaceNormal(p,f,uLayer);
      vec4 mv=viewMatrix*vec4(wp,1.0);vViewDepth=-mv.z;
      gl_Position=projectionMatrix*mv;
    }
  `;

  const MESH_FRAG = `
    varying vec3 vWorld;
    varying vec3 vFogNormal;
    varying vec2 vWarp;
    varying vec4 vField;
    varying float vViewDepth,vThickness,vLevel;
    void main(){
      // Interpolating masked vertex density alone can bridge a solid footprint.
      if(solidAt(vWorld.xz)>0.5)discard;
      vec2 suv=gl_FragCoord.xy/uResolution;
      float sceneZ=linearDepth(texture2D(uDepth,suv).r);
      float gap=sceneZ-vViewDepth;
      if(gap<=0.0)discard;
      float soft=smoothstep(0.0,max(0.12,uHeight*0.22),gap);
      vec3 viewDir=normalize(uCamPos-vWorld);
      vec3 fogNormal=normalize(vFogNormal);
      // A sheet has a geometric silhouette where a volume would fade softly.
      // Remove optical thickness smoothly at grazing angles to keep overlapping
      // shells from drawing bright contour lines around each displaced crest.
      float silhouette=smoothstep(0.0,0.35,abs(dot(fogNormal,viewDir)));
      float path=min(vThickness/max(abs(viewDir.y),0.24),3.4);
      float n=cloudNoise(vWarp,vField,vLevel);
      float concentration=max(0.0,vField.b)*densityDetail(vWarp,vField,vLevel,n,vWorld.y,max(length(dFdx(vWorld)),length(dFdy(vWorld))));
      float extinction=concentration*uDensity*1.05*fieldEdge(vWorld.xz)*uContribution*silhouette;
      float alpha=(1.0-exp(-extinction*path))*soft;
      vec3 col=fogLight(n,vLevel);
      if(uLightingModel==0){
        float diffuse=max(0.0,dot(fogNormal,normalize(vec3(-0.45,0.82,0.36))));
        col*=mix(0.50,1.15,diffuse);
      }
      if(uDebug==5){
        vec2 q=vWarp+vField.xy*0.55;
        vec2 g=abs(fract(q*0.70)-0.5);
        float line=1.0-smoothstep(0.025,0.055,min(g.x,g.y));
        col=mix(vec3(0.015,0.11,0.10),vec3(0.33,1.0,0.74),line);
        alpha=0.88*soft*fieldEdge(vWorld.xz);
      }
      gl_FragColor=vec4(col*alpha,alpha);
    }
  `;

  const WIRE_FRAG = `
    varying vec3 vWorld;
    varying vec2 vWarp;
    varying vec4 vField;
    varying float vViewDepth,vThickness,vLevel;
    void main(){
      if(solidAt(vWorld.xz)>0.5)discard;
      float z=linearDepth(texture2D(uDepth,gl_FragCoord.xy/uResolution).r);
      if(z<vViewDepth-0.03)discard;
      float a=0.50*fieldEdge(vWorld.xz);
      gl_FragColor=vec4(vec3(0.18,0.77,0.58)*a,a);
    }
  `;

  const RAY_FRAG = `
    varying vec2 vUv;
    uniform mat4 uInvViewProjection;
    uniform int uSteps;
    vec2 hitBox(vec3 o,vec3 d){
      vec3 safe=sign(d+vec3(0.0000001))*max(abs(d),vec3(0.00001));
      vec3 a=(vec3(-16.0,-0.8,-16.0)-o)/safe;
      // Preserve the old default interval; expand for stronger relief and for
      // terrain-following fog above the highest supported hill (1.6 metres).
      float ceiling=uHeight*(1.40+0.22*max(uDetailStrength-1.0,0.0))+0.52;
      ceiling+=uHeightMode==1?1.6*uTerrain:0.0;
      vec3 b=(vec3(16.0,ceiling,16.0)-o)/safe;
      vec3 lo=min(a,b),hi=max(a,b);
      return vec2(max(max(lo.x,lo.y),lo.z),min(min(hi.x,hi.y),hi.z));
    }
    void main(){
      vec2 ndc=vUv*2.0-1.0;
      vec4 fp=uInvViewProjection*vec4(ndc,1.0,1.0);
      vec3 rd=normalize(fp.xyz/fp.w-uCamPos);
      float depth=texture2D(uDepth,vUv).r;
      vec4 sceneP=uInvViewProjection*vec4(ndc,depth*2.0-1.0,1.0);
      float sceneDistance=length(sceneP.xyz/sceneP.w-uCamPos);
      vec2 box=hitBox(uCamPos,rd);
      float first=max(0.0,box.x),last=min(box.y,sceneDistance);
      if(last<=first){gl_FragColor=vec4(0.0);return;}
      float dt=(last-first)/float(uSteps);
      // The tight world-height interval makes 24 samples useful. Low-amplitude
      // interleaved jitter avoids wide bands without a correlated cloud pattern.
      float jitter=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
      float t=first+dt*(0.40+jitter*0.20);
      vec3 accum=vec3(0.0);float trans=1.0;
      for(int i=0;i<64;i++){
        if(i>=uSteps)break;
        vec3 p=uCamPos+rd*t;
        float ground=terrainHeight(p.xz);
        if(p.y>ground){
          vec4 f=sampleField(p.xz);
          float top=fogTop(p.xz,f);
          // Empty cells and samples above the bank add no scattering.
          // Skip fine density and lighting work for those samples.
          if(f.b>0.0&&p.y<top){
          float height=max(0.02,top-ground);
          float h=(p.y-ground)/height;
          float n=cloudNoise(p.xz,f,h);
          // Column keeps one horizontal pattern through height, with a longer
          // constant-density body and a soft cap. Billows retains its old fade.
          float capStart=uDensityProfile==1?0.75:0.48;
          float vertical=smoothstep(0.0,0.09,p.y-ground)*(1.0-smoothstep(capStart,1.0,h))*step(ground+0.01,top);
          float rho=max(0.0,f.b)*densityDetail(p.xz,f,h,n,p.y,dt)*vertical*uDensity*1.65*fieldEdge(p.xz)*uContribution;
          float a=1.0-exp(-rho*dt);
          vec3 color=fogLight(n,clamp(h,0.0,1.0));
          if(uLightingModel==0){
            vec2 towardsLight=vec2(-0.45,0.36)*0.75;
            float occludingDensity;
            if(uMode>0)occludingDensity=texture2D(uField,(p.xz+towardsLight)/32.0+0.5).b;
            else occludingDensity=fogBankDensity(p.xz+towardsLight-vec2(0.35,0.13)*uWind*uTime+f.xy*0.18);
            occludingDensity*=1.0-solidAt(p.xz+towardsLight);
            float lightDetail=cloudNoise(p.xz+towardsLight,vec4(f.xy,occludingDensity,f.a),h+0.15);
            occludingDensity*=detailDensity(lightDetail);
            color*=exp(-max(occludingDensity,0.0)*max(top-p.y,0.0)*0.38);
          }
          if(uDebug==5){
            vec2 q=p.xz+f.xy*0.6;
            vec2 gr=abs(fract(q*0.70)-0.5);
            float line=1.0-smoothstep(0.025,0.055,min(gr.x,gr.y));
            color=mix(vec3(0.015,0.11,0.10),vec3(0.33,1.0,0.74),line);
          }
          accum+=trans*a*color;trans*=1.0-a;
          }
        }
        t+=dt;
        if(trans<0.018)break;
      }
      gl_FragColor=vec4(accum,1.0-trans);
    }
  `;

  const COMPOSITE_FRAG = `
    varying vec2 vUv;
    uniform sampler2D uScene,uFog,uDepth;
    uniform vec2 uFogSize;
    uniform float uNear,uFar;
    float zlin(float d){return uNear*uFar/(uFar-d*(uFar-uNear));}
    void main(){
      vec3 background=texture2D(uScene,vUv).rgb;
      vec2 p=vUv*uFogSize-0.5;
      vec2 f=fract(p),corner=(floor(p)+0.5)/uFogSize;
      vec2 d=1.0/uFogSize;
      float centerZ=zlin(texture2D(uDepth,vUv).r);
      vec2 uv0=corner,uv1=corner+vec2(d.x,0.0),uv2=corner+vec2(0.0,d.y),uv3=corner+d;
      vec4 w=vec4((1.0-f.x)*(1.0-f.y),f.x*(1.0-f.y),(1.0-f.x)*f.y,f.x*f.y);
      vec4 zs=vec4(zlin(texture2D(uDepth,uv0).r),zlin(texture2D(uDepth,uv1).r),zlin(texture2D(uDepth,uv2).r),zlin(texture2D(uDepth,uv3).r));
      w*=1.0/(vec4(1.0)+abs(zs-centerZ)*14.0);
      w/=max(dot(w,vec4(1.0)),0.00001);
      vec4 fog=texture2D(uFog,uv0)*w.x+texture2D(uFog,uv1)*w.y+texture2D(uFog,uv2)*w.z+texture2D(uFog,uv3)*w.w;
      gl_FragColor=vec4(fog.rgb+background*(1.0-fog.a),1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;

  const DEBUG_FRAG = `
    varying vec2 vUv;
    float lineDistance(vec2 p,vec2 a,vec2 b){vec2 d=b-a;float h=clamp(dot(p-a,d)/max(dot(d,d),0.000001),0.0,1.0);return length(p-a-d*h);}
    vec3 hue(float h){return clamp(abs(fract(vec3(h)+vec3(0.0,0.6666667,0.3333333))*6.0-3.0)-1.0,0.0,1.0);}
    void main(){
      vec2 uv=vUv;
      float aspect=uResolution.x/uResolution.y;
      uv=(uv-0.5)*vec2(max(aspect,1.0),max(1.0/aspect,1.0))+0.5;
      if(min(uv.x,uv.y)<0.0||max(uv.x,uv.y)>1.0){gl_FragColor=vec4(0.015,0.029,0.028,1.0);return;}
      vec2 world=(uv-0.5)*32.0;
      vec4 field=vec4(0.0);if(uDebug!=7)field=sampleField(world);
      vec3 color;
      if(uDebug==7){color=mix(vec3(0.025,0.055,0.065),vec3(0.95,0.46,0.14),solidAt(world));}
      else if(uDebug==1){color=mix(vec3(0.008,0.055,0.045),vec3(0.76,0.89,0.76),smoothstep(0.0,1.4,field.b));}
      else if(uDebug==2){
        float speed=length(field.xy);
        float h=atan(field.y,field.x)/6.2831853+0.5;
        color=mix(vec3(0.018,0.037,0.045),hue(h)*0.6+0.1,1.0-exp(-speed*1.3));
        vec2 cell=floor(uv*24.0),center=(cell+0.5)/24.0;
        vec2 v=sampleField((center-0.5)*32.0).xy;
        float s=length(v);vec2 dir=v/max(s,0.0001),local=fract(uv*24.0)-0.5;
        float len=min(s*0.25,0.37);
        float line=lineDistance(local,-dir*len,dir*len);
        line=min(line,lineDistance(local,dir*len,dir*(len-0.10)+perpendicular(dir)*0.10));
        line=min(line,lineDistance(local,dir*len,dir*(len-0.10)-perpendicular(dir)*0.10));
        color=mix(color,vec3(0.83,0.96,0.85),(1.0-smoothstep(0.012,0.035,line))*smoothstep(0.02,0.12,s));
      }else{
        float val=uMode>0?texture2D(uAux,uv).r:0.0;
        float intensity=1.0-exp(-abs(val)*(uDebug==3?1.0:2.0));
        color=mix(vec3(0.035,0.055,0.065),val>=0.0?vec3(1.0,0.47,0.16):vec3(0.15,0.57,0.95),intensity);
      }
      vec2 grid=abs(fract(uv*16.0)-0.5);
      color*=0.85+0.15*smoothstep(0.0,0.015,min(grid.x,grid.y));
      gl_FragColor=vec4(color,1.0);
      #include <colorspace_fragment>
    }
  `;

  function premultMaterial(options) {
    return new THREE.ShaderMaterial(Object.assign({
      depthTest:false,depthWrite:false,transparent:true,toneMapped:false,
      blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,
      blendDst:THREE.OneMinusSrcAlphaFactor,blendEquation:THREE.AddEquation,
      blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.OneMinusSrcAlphaFactor,
      side:THREE.DoubleSide,forceSinglePass:true
    },options));
  }

  class FogRenderer {
    constructor(renderer,noiseTexture,terrainGLSL) {
      this.renderer=renderer;
      this.passCount=0;this.triangleCount=0;this.meshResolution=0;
      this._v=new THREE.Vector4();this._s=new THREE.Vector4();this._clear=new THREE.Color();
      this._targetWidth=0;this._targetHeight=0;
      this.empty=new THREE.DataTexture(new Float32Array([0,0,0.85,0]),1,1,THREE.RGBAFormat,THREE.FloatType);
      this.empty.needsUpdate=true;
      this.emptyObstacle=new THREE.DataTexture(new Uint8Array([0]),1,1,THREE.RedFormat,THREE.UnsignedByteType);
      this.emptyObstacle.minFilter=this.emptyObstacle.magFilter=THREE.NearestFilter;
      this.emptyObstacle.colorSpace=THREE.NoColorSpace;this.emptyObstacle.needsUpdate=true;
      this.uniforms={
        uNoise:{value:noiseTexture},uField:{value:this.empty},uDepth:{value:null},uAux:{value:this.empty},uObstacle:{value:this.emptyObstacle},
        uTime:{value:0},uHeight:{value:1.35},uDensity:{value:0.95},uRadius:{value:1.15},uStrength:{value:1},
        uSwirl:{value:0.8},uPersistence:{value:5},uWind:{value:0.4},uNear:{value:0.1},uFar:{value:100},
        uContribution:{value:1},uTerrain:{value:1},uMode:{value:0},uTrailCount:{value:0},uDebug:{value:0},
        uDensityProfile:{value:0},uHeightMode:{value:0},uDetailStrength:{value:1},uHeightShear:{value:1},uWispStrength:{value:1},uLightingModel:{value:0},uObstacles:{value:0},uWakeStyle:{value:0},
        uResolution:{value:new THREE.Vector2(1,1)},uSurfaceRelief:{value:new THREE.Vector4(0.22,0.30,0.44,0.58)},uCamPos:{value:new THREE.Vector3()},
        uTint:{value:new THREE.Color(0.40,0.405,0.375)},
        uTrails:{value:Array.from({length:24},()=>new THREE.Vector4(1000,1000,100,0))},
        uTrailVels:{value:Array.from({length:24},()=>new THREE.Vector4())},
        uTrailShape:{value:Array.from({length:24},()=>new THREE.Vector4())},
        uInvViewProjection:{value:new THREE.Matrix4()},uSteps:{value:24}
      };
      // Some callers provide only the function, others include its uniform declaration.
      const terrain=(/uniform\s+float\s+uTerrain/.test(terrainGLSL)?'':'uniform float uTerrain;\n')+terrainGLSL;
      this.common=COMMON+terrain;
      this.fogTarget=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,stencilBuffer:false,format:THREE.RGBAFormat,type:THREE.UnsignedByteType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
      this.fogTarget.texture.colorSpace=THREE.NoColorSpace;
      this.meshScene=new THREE.Scene();this.wireScene=new THREE.Scene();
      this.meshes=[];this.materials=[];
      for(let i=0;i<4;i++){
        const uniforms=Object.assign({},this.uniforms,{uLayer:{value:0.55},uContribution:{value:1},uSurfaceRelief:{value:new THREE.Vector4(0.025,0.07,0.65,0.14)}});
        const mat=premultMaterial({uniforms,vertexShader:this.common+MESH_VERT,fragmentShader:this.common+MESH_FRAG});
        const mesh=new THREE.Mesh(undefined,mat);mesh.frustumCulled=false;mesh.renderOrder=i;
        this.meshes.push(mesh);this.materials.push(mat);this.meshScene.add(mesh);
      }
      this.wireMaterial=premultMaterial({uniforms:Object.assign({},this.uniforms,{uLayer:{value:0.84},uSurfaceRelief:{value:new THREE.Vector4(0.025,0.07,0.65,0.14)}}),vertexShader:this.common+MESH_VERT,fragmentShader:this.common+WIRE_FRAG,wireframe:true});
      this.wire=new THREE.Mesh(undefined,this.wireMaterial);this.wire.frustumCulled=false;this.wireScene.add(this.wire);
      this.quadGeometry=new THREE.PlaneGeometry(2,2);
      this.quadCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
      this.rayMaterial=premultMaterial({uniforms:this.uniforms,vertexShader:FS_VERT,fragmentShader:this.common+RAY_FRAG});
      this.rayQuad=new THREE.Mesh(this.quadGeometry,this.rayMaterial);this.rayQuad.frustumCulled=false;
      this.rayScene=new THREE.Scene();this.rayScene.add(this.rayQuad);
      this.compositeMaterial=new THREE.ShaderMaterial({
        uniforms:{uScene:{value:null},uFog:{value:this.fogTarget.texture},uDepth:{value:null},uFogSize:{value:new THREE.Vector2()},uNear:{value:0.1},uFar:{value:100}},
        vertexShader:FS_VERT,fragmentShader:COMPOSITE_FRAG,depthTest:false,depthWrite:false,toneMapped:true
      });
      this.compositeQuad=new THREE.Mesh(this.quadGeometry,this.compositeMaterial);this.compositeQuad.frustumCulled=false;
      this.finalScene=new THREE.Scene();this.finalScene.add(this.compositeQuad);
      this.debugMaterial=new THREE.ShaderMaterial({uniforms:this.uniforms,vertexShader:FS_VERT,fragmentShader:this.common+DEBUG_FRAG,depthTest:false,depthWrite:false,toneMapped:false});
      this.setQuality('balanced');
    }

    setQuality(quality) {
      const segments=quality==='low'||quality==='eco'||quality==='potato'?56:quality==='high'||quality==='ultra'?144:96;
      if(segments===this.meshResolution)return;
      this.meshResolution=segments;
      if(this.geometry)this.geometry.dispose();
      this.geometry=new THREE.PlaneGeometry(32,32,segments,segments);
      this.geometry.rotateX(-Math.PI/2);
      for(const mesh of this.meshes)mesh.geometry=this.geometry;
      this.wire.geometry=this.geometry;
    }

    _uniforms(args,w,h) {
      const {camera,settings:s,time,mode,fieldTexture,trails=[]}=args,u=this.uniforms;
      u.uTime.value=time||0;u.uHeight.value=s.height??1.35;u.uDensity.value=s.density??0.95;
      u.uRadius.value=s.radius??1.15;u.uStrength.value=s.strength??1;u.uSwirl.value=s.swirl??0.8;
      u.uPersistence.value=s.persistence??5;u.uWind.value=s.wind??0.4;u.uTerrain.value=s.terrain==='flat'?0:1;
      u.uNear.value=camera.near;u.uFar.value=camera.far;u.uMode.value=mode==='analytical'?0:mode==='hybrid'?1:mode==='cpu'?3:2;
      u.uDensityProfile.value=s.densityProfile==='column'?1:0;u.uHeightMode.value=s.heightMode==='terrain'?1:0;
      u.uDetailStrength.value=Math.max(0,Math.min(1.5,s.detailStrength??1));
      u.uHeightShear.value=Math.max(0,Math.min(1.5,s.heightShear??1));
      u.uWispStrength.value=Math.max(0,Math.min(1.5,s.wispStrength??1));
      u.uLightingModel.value=s.lightingModel==='ambient'?1:0;
      u.uWakeStyle.value=s.wakeStyle==='radial'?1:s.wakeStyle==='tangential'?2:0;
      u.uObstacle.value=args.obstacleTexture||this.emptyObstacle;u.uObstacles.value=s.obstacles&&args.obstacleTexture?1:0;
      u.uResolution.value.set(w,h);u.uField.value=fieldTexture||this.empty;u.uDepth.value=args.depthTexture;
      camera.getWorldPosition(u.uCamPos.value);
      u.uInvViewProjection.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).invert();
      u.uSteps.value=Math.max(8,Math.min(64,Math.round(s.raySteps||24)));
      u.uDebug.value=({density:1,velocity:2,pressure:3,curl:4,uv:5,divergence:6,obstacles:7})[s.debug]||0;
      u.uAux.value=s.debug==='pressure'?(args.pressureTexture||this.empty):s.debug==='divergence'?(args.divergenceTexture||this.empty):(args.curlTexture||this.empty);
      if(s.lighting==='night')u.uTint.value.setRGB(0.18,0.235,0.27);
      else if(s.lighting==='day'||s.lighting==='dawn'||s.lighting==='sunrise')u.uTint.value.setRGB(0.47,0.455,0.405);
      else u.uTint.value.setRGB(0.40,0.405,0.375);
      u.uTrailCount.value=Math.min(24,trails.length);
      for(let i=0;i<24;i++){
        const t=trails[i];
        if(t){
          u.uTrails.value[i].set(t.x,t.z,t.age??0,t.strength??1);u.uTrailVels.value[i].set(t.vx||0,t.vz||0,0,0);
          const capsule=Number.isFinite(t.x0)&&Number.isFinite(t.z0);
          const radius=Number.isFinite(t.radius)&&t.radius>0?t.radius:0;
          u.uTrailShape.value[i].set(capsule?t.x0:t.x,capsule?t.z0:t.z,radius,capsule?1:0);
        }else{
          u.uTrails.value[i].set(1000,1000,100,0);u.uTrailVels.value[i].set(0,0,0,0);u.uTrailShape.value[i].set(0,0,0,0);
        }
      }
    }

    render(args) {
      const r=this.renderer,s=args.settings||{},mode=args.renderMode||'mesh';
      const savedTarget=r.getRenderTarget(),savedAuto=r.autoClear,savedScissor=r.getScissorTest();
      r.getViewport(this._v);r.getScissor(this._s);r.getClearColor(this._clear);const savedAlpha=r.getClearAlpha();
      const debug=!!s.debug&&s.debug!=='beauty'&&s.debug!=='uv';
      const scale=debug?1:Math.max(0.25,Math.min(1,s.renderScale??0.70));
      const w=Math.max(2,Math.round(args.width*scale)),h=Math.max(2,Math.round(args.height*scale));
      this._uniforms(args,w,h);this.setQuality(s.quality||'balanced');
      this.passCount=0;this.triangleCount=0;r.autoClear=false;
      try{
        if(!debug){
          if(w!==this._targetWidth||h!==this._targetHeight){this.fogTarget.setSize(w,h);this._targetWidth=w;this._targetHeight=h;}
          r.setRenderTarget(this.fogTarget);r.setViewport(0,0,w,h);r.setScissorTest(false);r.setClearColor(0x000000,0);r.clear(true,false,false);
          const hasMesh=mode!=='raymarch',hasRay=mode==='raymarch'||mode==='layered';
          if(hasMesh){
            const count=mode==='shells'?4:1;
            const contribution=mode==='layered'?0.30:1;
            for(let i=0;i<4;i++){
              this.meshes[i].visible=i<count;
              this.materials[i].uniforms.uLayer.value=count===1?0.84:0.25+i*0.22;
              this.materials[i].uniforms.uContribution.value=contribution/count;
            }
            r.render(this.meshScene,args.camera);this.passCount+=count;
            this.triangleCount+=this.meshResolution*this.meshResolution*2*count;
          }
          if(hasRay){
            this.uniforms.uContribution.value=mode==='layered'?0.70:1;
            r.render(this.rayScene,this.quadCamera);this.passCount++;this.triangleCount+=2;
          }
          if(s.wireframe){this.wireMaterial.uniforms.uLayer.value=mode==='shells'?0.91:0.84;r.render(this.wireScene,args.camera);this.passCount++;this.triangleCount+=this.meshResolution*this.meshResolution*2;}
        }
        r.setRenderTarget(args.target||null);r.setViewport(this._v);r.setScissor(this._s);r.setScissorTest(savedScissor);
        if(debug){
          this.uniforms.uResolution.value.set(args.width,args.height);
          this.compositeQuad.material=this.debugMaterial;
        }else{
          const u=this.compositeMaterial.uniforms;
          u.uScene.value=args.sceneTexture;u.uDepth.value=args.depthTexture;u.uFogSize.value.set(w,h);
          u.uNear.value=args.camera.near;u.uFar.value=args.camera.far;
          this.compositeQuad.material=this.compositeMaterial;
        }
        r.render(this.finalScene,this.quadCamera);this.passCount++;this.triangleCount+=2;
      }finally{
        r.setRenderTarget(savedTarget);r.setViewport(this._v);r.setScissor(this._s);r.setScissorTest(savedScissor);
        r.setClearColor(this._clear,savedAlpha);r.autoClear=savedAuto;
      }
    }

    dispose(){
      this.fogTarget.dispose();this.empty.dispose();this.emptyObstacle.dispose();this.geometry.dispose();this.quadGeometry.dispose();
      for(const m of this.materials)m.dispose();
      this.wireMaterial.dispose();this.rayMaterial.dispose();this.compositeMaterial.dispose();this.debugMaterial.dispose();
    }
  }
  F.FogRenderer=FogRenderer;
  F.fogShaders={common:COMMON,meshVertex:MESH_VERT,meshFragment:MESH_FRAG,raymarchFragment:RAY_FRAG,compositeFragment:COMPOSITE_FRAG,debugFragment:DEBUG_FRAG};
})();
