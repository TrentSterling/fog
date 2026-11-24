/* FogLab application. No network requests, no asset dependencies.
 * Original application, simulation and procedural assets are MIT licensed.
 * Architecture: shared world + independent motion providers + interchangeable renderers.
 */
(function () {
  'use strict';
  const $=id=>document.getElementById(id), F=window.FogLab, T=window.THREE, P=F.Presets;
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const defaults=P.DEFAULT_SETTINGS;
  const settings={...defaults};
  const state={...P.DEFAULT_VIEW,cameraMode:P.DEFAULT_CAMERA.mode,time:0,frame:0,trails:[],actors:[],lastStamp:0,accumulator:0,pulseAge:99,pulseX:0,pulseZ:0,ready:false,halted:false};
  // The submitted state may be one worker tick ahead. Every visible backend,
  // actor, trail and shader clock renders this last completed snapshot instead.
  const renderState={time:0,actors:[],trails:[]},simulationClock=new F.FixedStepClock();
  let pendingTick=null,committedTicks=0,statTicks=0,lastSimulationHz=0;
  const modeNames={analytical:'Analytical',hybrid:'Hybrid',fluid:'GPU fluids',cpu:'CPU fluids'};
  const modeColors={analytical:'#c4b8f6',hybrid:'#b0ecd2',fluid:'#e5d09b',cpu:'#a6c9f4'};
  const renderNames={mesh:'reactive mesh',raymarch:'shallow raymarch',layered:'mesh + volume'};
  const renderDescriptions={mesh:'Broad fog banks on a displaced surface. Hilltops rise above the fog level.',raymarch:'Integrate transported density below a shared fog ceiling, clipped by the terrain.',layered:'30% mesh + 70% volume. The density budget is split across the two renderers.'};
  const qualities=P.QUALITY_PRESETS;
  const errors=[];
  let toastTimer,renderer,world,noise,sims,fog,sceneRT,camera,gl,timerExt;
  let queryQueue=[],activeQuery=null,gpuMs=null,submitMs=0,lastNow=performance.now(),statStart=lastNow,statFrames=0,lastFps=60,needsResize=true,stepRequested=false,captureRequested=false;
  let frameDraws=0,frameTriangles=0,lastSimulationPasses=0,lastFogPasses=0;
  const cameraTarget=new T.Vector3(0,.7,2),orbit={theta:P.DEFAULT_CAMERA.theta,phi:P.DEFAULT_CAMERA.phi,distance:P.DEFAULT_CAMERA.distance,targetTheta:P.DEFAULT_CAMERA.theta,targetPhi:P.DEFAULT_CAMERA.phi,targetDistance:P.DEFAULT_CAMERA.distance};
  const autoResume={x:0,z:0};
  const keys=new Set(),raycaster=new T.Raycaster(),pointerNdc=new T.Vector2();
  const pointer={down:false,button:0,x:0,y:0,stir:false,worldX:0,worldZ:0,vx:0,vz:0,lastTime:0};
  let simulationSupported=false,initializationComplete=false,readyAnnounced=false;

  function canRender(){return !!(renderer&&world&&camera&&sceneRT&&fog&&!state.halted);}
  function announceReady(){
    if(readyAnnounced)return;initializationComplete=true;readyAnnounced=true;
    window.dispatchEvent(new CustomEvent('foglab:ready',{detail:{app:F.app,renderReady:canRender()&&state.ready,simulationSupported}}));
  }
  // The setup API exists before WebGL initialization. A browser without a GPU
  // context can still inspect methods, prepare experiments, and share links.
  F.app={settings,state,errors,
    get renderer(){return renderer;},get world(){return world;},get noise(){return noise;},get sims(){return sims;},
    get fog(){return fog;},get camera(){return camera;},get sceneRT(){return sceneRT;},
    get ready(){return initializationComplete;},get renderReady(){return canRender()&&state.ready;},
    get simulationSupported(){return simulationSupported;},
    get runtime(){return {version:F.BuildInfo?.version||'0.3.0',submittedTime:state.time,renderTime:renderState.time,committedTicks,pending:!!pendingTick,simulationHz:lastSimulationHz,droppedSeconds:simulationClock.droppedSeconds,cpuExecution:sims?.cpu?.execution||null};},
    snapshotPreset,applyPreset,showToast:toast,copyShareLink,getShareURL:()=>P.buildShareURL(snapshotPreset(),location.href),
    setMode,setLayout,setRenderMode,setQuality,reset,pulse,jump,slash,physicsStep,draw,
    diagnostics:()=>canRender()?{available:true,hybrid:sims.hybrid.getDiagnostics(),fluid:sims.fluid.getDiagnostics(),cpu:sims.cpu?.getDiagnostics()||null,errors:[...errors]}:
      {available:false,reason:'Live rendering is unavailable.',hybrid:null,fluid:null,errors:[...errors]}
  };

  function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),2800);}
  function fail(error){
    errors.push(String(error&&error.stack||error));console.error(error);state.halted=true;state.ready=false;simulationSupported=false;
    $('loading').classList.add('done');$('loading').hidden=true;$('errorBox').hidden=false;
    $('errorBox').querySelector('h2').textContent='Live rendering is unavailable';
    $('errorText').textContent=String(error&&error.message||error)+' · You can still explore the methods and prepare a shareable setup. Try a current browser with hardware acceleration for the live view.';
    $('capability').textContent='WEBGL UNAVAILABLE';
    const liveTag=document.querySelector('.live-tag');if(liveTag)liveTag.textContent='SETUP';
    for(const id of ['fps','gpuTime','simPasses','drawCalls','simulationRate','workerLatency'])$(id).textContent='—';
    $('timingBadge').textContent='SETUP';$('gpuLabel').textContent='no live render';$('perfBar').style.width='0%';
    $('perfNote').textContent='No live measurements are available. The selected settings can still be inspected and shared.';
    $('cpuMetrics').hidden=true;$('workerLatencyMetric').hidden=true;$('runtimeNote').hidden=true;
    $('statusText').textContent='Setup only · live rendering unavailable';announceReady();
  }
  window.addEventListener('error',e=>{if(!state.halted)fail(e.error||e.message);});
  $('retryButton').onclick=()=>location.reload();

  // Four independent channels from a seeded, periodic scalar potential.
  // R: broad cloud, G: fine cloud, BA: baked curl field. Generated only once.
  function createNoiseAtlas(){
    const N=256,bytes=new Uint8Array(N*N*4);
    function hash(x,y,k){let h=(Math.imul(x+71,374761393)^Math.imul(y+43,668265263)^Math.imul(k,982451653))>>>0;h=Math.imul(h^(h>>>13),1274126177)>>>0;return ((h^(h>>>16))>>>0)/4294967295;}
    function n(x,y,period,k){const px=x*period,py=y*period,ix=Math.floor(px),iy=Math.floor(py);let u=px-ix,v=py-iy;u=u*u*(3-2*u);v=v*v*(3-2*v);const at=(a,b)=>hash((a%period+period)%period,(b%period+period)%period,k);return (at(ix,iy)*(1-u)+at(ix+1,iy)*u)*(1-v)+(at(ix,iy+1)*(1-u)+at(ix+1,iy+1)*u)*v;}
    const potential=(x,y)=>n(x,y,5,71)*.75+n(x,y,11,21)*.25;
    for(let y=0;y<N;y++)for(let x=0;x<N;x++){
      const u=x/N,v=y/N,i=(y*N+x)*4,d=1/N;
      const broad=n(u,v,4,13)*.78+n(u,v,9,31)*.18+n(u,v,17,63)*.04;
      const fine=n(u,v,8,47)*.80+n(u,v,17,83)*.16+n(u,v,31,19)*.04;
      const dx=(potential(u+d,v)-potential(u-d,v))/(2*d),dy=(potential(u,v+d)-potential(u,v-d))/(2*d);
      bytes[i]=Math.round(clamp((broad-.5)*1.35+.5,0,1)*255);bytes[i+1]=Math.round(clamp((fine-.5)*1.3+.5,0,1)*255);
      bytes[i+2]=Math.round(clamp(.5+dy*.055,0,1)*255);bytes[i+3]=Math.round(clamp(.5-dx*.055,0,1)*255);
    }
    const texture=new T.DataTexture(bytes,N,N,T.RGBAFormat,T.UnsignedByteType);
    texture.wrapS=texture.wrapT=T.RepeatWrapping;texture.magFilter=T.LinearFilter;texture.minFilter=T.LinearMipmapLinearFilter;texture.generateMipmaps=true;texture.colorSpace=T.NoColorSpace;texture.needsUpdate=true;texture.name='FogLab static 256² cloud and curl atlas';return texture;
  }

  function paneConfigs(){
    if(state.layout==='triple')return ['analytical','hybrid','fluid'].map(mode=>({mode,renderer:state.renderer}));
    const result=[{mode:state.mode,renderer:state.renderer}];
    if(state.layout==='compare')result.push({mode:state.compareMode,renderer:state.compareRenderer==='same'?state.renderer:state.compareRenderer});
    return result;
  }
  function activeModes(){return new Set(paneConfigs().map(x=>x.mode));}
  const isGPU=mode=>mode==='hybrid'||mode==='fluid';
  function ensureCPU(){
    if(!renderer||!noise||!sims)return;
    if(sims.cpu&&sims.cpu.requestedExecution!==settings.cpuExecution){sims.cpu.dispose();delete sims.cpu;}
    if(sims.cpu||!activeModes().has('cpu'))return;
    const Simulation=settings.cpuExecution==='main'?F.CPUFieldSimulation:F.CPUWorkerSimulation;
    sims.cpu=new Simulation(renderer,noise,{resolution:settings.resolution,worldSize:32});
    // Keep the requested option separate from the actual execution path: a
    // worker fault can fall back to main without recreating a broken worker.
    sims.cpu.requestedExecution=settings.cpuExecution;
  }
  function syncObstacles(){
    if(!world||!sims)return;
    world.setObstacleCourse(settings.obstacleCourse);
    const obstacles=world.getObstacles();
    for(const sim of Object.values(sims))sim.setObstacles(obstacles,settings.obstacles);
  }
  function refreshLabels(){
    const panes=paneConfigs();$('paneLabels').replaceChildren();
    panes.forEach((p,i)=>{
      const el=document.createElement('div');el.className='pane-label';el.style.left=`calc(${i*100/panes.length}% + ${panes.length===1?32:18}px)`;el.style.borderColor=modeColors[p.mode];
      const passes=p.mode==='analytical'||p.mode==='cpu'?0:p.mode==='hybrid'?1:settings.pressure+(settings.vorticity>.001?7:6);
      const cpuExecution=sims?.cpu?.execution||settings.cpuExecution;
      const heading=document.createElement('strong');heading.textContent=modeNames[p.mode];const subtitle=document.createElement('p');subtitle.textContent=p.mode==='cpu'?`${settings.resolution}² ${cpuExecution==='worker'?'worker':'main-thread'} solve + upload · ${renderNames[p.renderer]}`:`${passes} GPU state passes · ${renderNames[p.renderer]}`;
      el.append(heading,subtitle);$('paneLabels').append(el);
      if(i){const divider=document.createElement('div');divider.className='pane-divider';divider.style.left=(100*i/panes.length)+'%';$('paneLabels').append(divider);}
    });
    $('comparisonPick').hidden=state.layout!=='compare';$('compareRendererRow').hidden=state.layout!=='compare';
    $('cpuExecutionRow').hidden=!activeModes().has('cpu');
    $('cpuExecution').value=settings.cpuExecution;
    $('backendLabel').textContent=state.layout==='triple'?'ALL THREE / '+state.renderer.toUpperCase():state.layout==='compare'?'A/B / '+state.renderer.toUpperCase():state.mode.toUpperCase()+' / '+state.renderer.toUpperCase();
    $('renderDescription').textContent=settings.heightMode==='terrain'?'Fog follows local terrain height. '+({mesh:'A displaced surface suggests the bank.',raymarch:'Integrate density through the local fog depth.',layered:'30% mesh + 70% volume share the density budget.'})[state.renderer]:renderDescriptions[state.renderer];
    $('heightHint').textContent=settings.heightMode==='world'?'A shared world ceiling lets hilltops emerge.':'A local fog depth follows the terrain, including hilltops.';
    $('statusText').textContent=state.halted?'Setup only · live rendering unavailable':`${activeModes().size===1&&state.mode==='analytical'?'Analytical history':settings.resolution+'² field'} · 30 Hz target · 256² static noise`;
    for(const el of document.querySelectorAll('[data-mode]'))el.classList.toggle('active',el.dataset.mode===state.mode);
    for(const el of document.querySelectorAll('[data-render]'))el.classList.toggle('active',el.dataset.render===state.renderer);
    for(const el of document.querySelectorAll('[data-layout]'))el.classList.toggle('active',el.dataset.layout===state.layout);
  }

  const sliderDefs=[
    ['slidersMain','density','Density',0,2.2,.01,v=>v.toFixed(2)],['slidersMain','height','Fog ceiling',.15,2.8,.01,v=>v.toFixed(2)+' m'],
    ['slidersInteraction','radius','Influence radius',.35,2.7,.05,v=>v.toFixed(2)+' m'],['slidersInteraction','strength','Displacement',0,2.5,.05,v=>v.toFixed(2)],
    ['slidersInteraction','swirl','Curl & roll',0,2.5,.05,v=>v.toFixed(2)],['slidersInteraction','persistence','Wake memory',.6,12,.2,v=>v.toFixed(1)+' s'],
    ['slidersAdvanced','wind','Ambient wind',0,2,.05,v=>v.toFixed(2)],['slidersAdvanced','pressure','Pressure iterations',2,32,1,v=>v.toFixed(0)],
    ['slidersAdvanced','vorticity','Vorticity confinement',0,1.8,.05,v=>v.toFixed(2)],['slidersAdvanced','raySteps','Ray samples',8,48,2,v=>v.toFixed(0)],
    ['slidersAdvanced','renderScale','Fog render scale',.3,1,.05,v=>Math.round(v*100)+'%'],
    ['slidersShape','detailStrength','Billow detail',0,1.5,.05,v=>v.toFixed(2)],
    ['slidersShape','heightShear','Vertical shear',0,1.5,.05,v=>v.toFixed(2)]
  ];
  const sliders={};
  for(const [parent,key,name,min,max,step,format] of sliderDefs){
    const label=document.createElement('label');label.className='slider-control';
    const line=document.createElement('div');line.className='slider-top';const nameEl=document.createElement('span');nameEl.textContent=name;
    const val=document.createElement('output');val.className='slider-value';val.htmlFor='slider-'+key;line.append(nameEl,val);
    const input=document.createElement('input');input.type='range';input.id='slider-'+key;input.min=min;input.max=max;input.step=step;input.value=settings[key];input.setAttribute('aria-label',name);
    function refresh(){input.value=settings[key];val.value=format(settings[key]);input.style.setProperty('--p',100*(settings[key]-min)/(max-min)+'%');}
    input.oninput=()=>{settings[key]=+input.value;refresh();if(key==='pressure'||key==='vorticity')refreshLabels();};
    label.append(line,input);$(parent).append(label);sliders[key]={input,refresh};refresh();
  }
  function refreshSliders(){Object.values(sliders).forEach(s=>s.refresh());}

  function automaticPosition(index,time){
    const phase=index*2.399,rate=index===0?.30:.25+index*.013;
    return {x:Math.sin(time*rate+phase)*(index===0?5.2:3.8+index*.65),z:2+Math.sin(time*rate*1.47+phase*.73)*(index===0?3.7:3.2+index*.35)};
  }

  function reset(silent=false){
    state.time=0;state.frame=0;state.accumulator=0;state.trails=[];state.lastStamp=-1;state.pulseAge=99;state.pulseX=state.pulseZ=0;
    pendingTick=null;simulationClock.reset();committedTicks=statTicks=0;lastSimulationHz=0;
    statStart=performance.now();statFrames=0;
    autoResume.x=autoResume.z=0;stepRequested=false;
    state.actors=Array.from({length:state.actorCount},(_,i)=>({...((i===0&&!state.auto)?{x:0,z:3}:automaticPosition(i,0)),vx:0,vz:0,radius:settings.radius,strength:1,jump:0,verticalVelocity:0,heading:0,slashAge:99}));
    renderState.time=0;renderState.actors=state.actors.map(a=>({...a}));renderState.trails=[];
    pointer.stir=false;keys.clear();
    if(canRender()){ensureCPU();syncObstacles();for(const sim of Object.values(sims)){if(sim.uniforms?.uWind)sim.uniforms.uWind.value=settings.wind;sim.reset(settings);}}
    if(world)world.update(0,1/30,state.actors,settings);
    // Presets always start from the same target, rather than inheriting the
    // previous experiment's smoothed camera position or manual actor location.
    const actor=state.actors[0],follow=state.cameraMode===3&&actor;
    cameraTarget.set(follow?actor.x:0,follow?(world?world.terrainHeight(actor.x,actor.z):0)+.72:.55,follow?actor.z:-1);
    if(camera&&world)updateCamera(0);
    lastNow=performance.now();if(!silent)toast(canRender()?'Fresh air. All fields reset.':'Setup reset to time zero.');
  }
  function setMode(mode){if(!modeNames[mode])return;if(isGPU(mode)&&canRender()&&!simulationSupported){toast('GPU fluid targets are unavailable. CPU and Analytical remain available.');return;}
    state.mode=mode;if(mode==='cpu'&&state.layout==='triple'){state.layout='single';needsResize=true;}reset(true);refreshLabels();toast(modeNames[mode]+' · '+renderNames[state.renderer]);}
  function setLayout(layout){if(!['single','compare','triple'].includes(layout))return;if(canRender()&&!simulationSupported&&(layout==='triple'||(layout==='compare'&&(isGPU(state.mode)||isGPU(state.compareMode))))){toast('Choose CPU or Analytical in both panes for this device.');return;}state.layout=layout;if(layout==='triple'&&state.mode==='cpu')state.mode='fluid';reset(true);refreshLabels();needsResize=true;}
  function setRenderMode(value){if(!renderNames[value])return;state.renderer=value;refreshLabels();}
  function setQuality(name){if(!qualities[name])return;settings.quality=name;Object.assign(settings,(({resolution,raySteps,renderScale})=>({resolution,raySteps,renderScale}))(qualities[name]));
    if(canRender())for(const sim of Object.values(sims||{}))sim.setResolution(settings.resolution);refreshSliders();refreshLabels();needsResize=true;reset(true);}
  for(const el of document.querySelectorAll('[data-mode]'))el.onclick=()=>setMode(el.dataset.mode);
  for(const el of document.querySelectorAll('[data-render]'))el.onclick=()=>setRenderMode(el.dataset.render);
  for(const el of document.querySelectorAll('[data-layout]'))el.onclick=()=>setLayout(el.dataset.layout);
  $('compareMode').onchange=e=>{if(canRender()&&!simulationSupported&&isGPU(e.target.value)){e.target.value=state.compareMode;toast('GPU fluid targets are unavailable.');return;}state.compareMode=e.target.value;reset(true);refreshLabels();};
  $('compareRenderer').onchange=e=>{state.compareRenderer=e.target.value;refreshLabels();};
  $('quality').onchange=e=>{setQuality(e.target.value);toast(e.target.options[e.target.selectedIndex].text+' quality');};
  $('cpuExecution').onchange=e=>{settings.cpuExecution=e.target.value;reset(true);refreshLabels();toast(settings.cpuExecution==='worker'?'CPU solver moved to a background worker.':'CPU solver runs on the main thread.');};
  $('terrain').onchange=e=>{settings.terrain=e.target.value;world?.setTerrain(settings.terrain);};
  $('lighting').onchange=e=>{settings.lighting=e.target.value;world?.setLighting(settings.lighting);};
  $('environment').onchange=e=>{settings.environment=e.target.value;world?.setEnvironment(settings.environment);reset(true);$('scene-heading').querySelector('h1').textContent=settings.environment==='reference'?'Ground fog study':'The emerald ruins';};
  for(const key of ['densityProfile','heightMode','lightingModel','wakeStyle'])$(key).onchange=e=>{settings[key]=e.target.value;refreshLabels();};
  for(const key of ['obstacles','obstacleCourse'])$(key).onchange=e=>{settings[key]=e.target.checked;reset(true);toast('Obstacle setup changed · fields restarted');};
  $('actorCount').onchange=e=>{state.actorCount=+e.target.value;reset(true);toast(state.actorCount+' wanderer'+(state.actorCount===1?'':'s'));};
  $('debugView').onchange=e=>{settings.debug=e.target.value;if(['pressure','curl','divergence'].includes(settings.debug)&&state.layout==='single'&&!['fluid','cpu'].includes(state.mode))toast('Choose GPU fluids or CPU fluids to inspect this solved field.');};
  $('wireframe').onchange=e=>{settings.wireframe=e.target.checked;};
  function setAuto(value){
    // Resume from the actual position, then smoothly settle onto the shared replay path.
    // A hard snap here would stamp an artificial, high-velocity wake across the clearing.
    if(value&&!state.auto&&state.actors[0]){const p=automaticPosition(0,state.time);autoResume.x=state.actors[0].x-p.x;autoResume.z=state.actors[0].z-p.z;}
    state.auto=value;$('autoButton').classList.toggle('active',value);$('autoButton').querySelector('span').textContent=value?'Auto walk':'Manual';
  }
  $('autoButton').onclick=()=>{setAuto(!state.auto);if(!state.auto)toast('WASD or arrow keys to move. Shift to sprint.');};
  function setPause(value){settings.paused=value;stepRequested=false;state.accumulator=0;simulationClock.beginFrame(0,{paused:true});lastNow=performance.now();$('pauseButton').classList.toggle('active',value);$('pauseButton').setAttribute('aria-label',value?'Resume':'Pause');$('pauseButton').title=value?'Resume (P)':'Pause (P)';$('stepButton').disabled=!value;}
  $('pauseButton').onclick=()=>setPause(!settings.paused);
  $('stepButton').onclick=()=>{if(!canRender()){toast('A live graphics view is needed to step the simulation.');return;}if(settings.paused)stepRequested=true;};
  $('stepButton').disabled=true;
  function pulse(){if(!canRender()){toast('A live graphics view is needed for a pulse.');return false;}const a=state.actors[0];if(!a)return false;state.pulseAge=0;state.pulseX=a.x;state.pulseZ=a.z;if(settings.paused)stepRequested=true;toast('Radial impulse');return true;}
  function jump(){if(!canRender()){toast('A live graphics view is needed to jump.');return false;}const started=F.Interactions.beginJump(state.actors[0]);if(started){if(settings.paused)stepRequested=true;toast('Jump · the landing pushes the fog');}return started;}
  function slash(){if(!canRender()){toast('A live graphics view is needed to slash.');return false;}const started=F.Interactions.beginSlash(state.actors[0]);if(started){if(settings.paused)stepRequested=true;toast('Swept blade impulse');}return started;}
  $('pulseButton').onclick=pulse;$('resetButton').onclick=()=>reset();
  $('jumpButton').onclick=jump;$('slashButton').onclick=slash;
  function cycleCamera(){state.cameraMode=(state.cameraMode+1)%4;const preset=[{n:'Orbit view',p:.98,d:17},{n:'Ground view',p:1.43,d:11},{n:'Overhead',p:.08,d:22},{n:'Follow cam',p:1.14,d:11.5}][state.cameraMode];orbit.targetPhi=preset.p;orbit.targetDistance=preset.d;$('cameraButton').textContent=preset.n;}
  $('cameraButton').onclick=cycleCamera;
  function toggleUI(){if(innerWidth<=760){document.body.classList.toggle('mobile-panel-hidden');}else document.body.classList.toggle('clean');needsResize=true;}
  $('uiToggle').onclick=toggleUI;$('showUi').onclick=()=>{document.body.classList.remove('clean');needsResize=true;};
  if(innerWidth<=760)document.body.classList.add('mobile-panel-hidden');
  function showHelp(){keys.clear();$('helpDialog').showModal();}
  $('helpButton').onclick=showHelp;$('aboutButton').onclick=showHelp;$('closeHelp').onclick=()=>$('helpDialog').close();
  $('helpDialog').addEventListener('click',e=>{if(e.target===$('helpDialog')){const r=$('helpDialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('helpDialog').close();}});
  F.Credits.render($('creditsContent'));
  $('creditsButton').onclick=()=>{keys.clear();pointer.down=pointer.stir=false;$('creditsDialog').showModal();};
  $('closeCredits').onclick=()=>$('creditsDialog').close();
  $('creditsDialog').addEventListener('click',e=>{if(e.target===$('creditsDialog')){const r=$('creditsDialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('creditsDialog').close();}});

  function download(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  function snapshotPreset(){
    return P.validatePreset({format:'FogLab',version:1,settings:{...settings},
      view:{mode:state.mode,renderer:state.renderer,layout:state.layout,compareMode:state.compareMode,compareRenderer:state.compareRenderer,actorCount:state.actorCount,auto:state.auto},
      camera:{theta:orbit.targetTheta,phi:orbit.targetPhi,distance:orbit.targetDistance,mode:state.cameraMode}});
  }
  function refreshSetupControls(){
    for(const key of ['terrain','lighting','environment','quality','densityProfile','heightMode','lightingModel','wakeStyle','cpuExecution'])$(key).value=settings[key];
    for(const key of ['obstacles','obstacleCourse'])$(key).checked=settings[key];
    $('debugView').value=settings.debug;$('wireframe').checked=settings.wireframe;$('actorCount').value=state.actorCount;
    $('compareMode').value=state.compareMode;$('compareRenderer').value=state.compareRenderer;
    if($('meshLayers'))$('meshLayers').value=settings.meshLayers;
    $('cameraButton').textContent=['Orbit view','Ground view','Overhead','Follow cam'][state.cameraMode];
    $('scene-heading').querySelector('h1').textContent=settings.environment==='reference'?'Ground fog study':'The emerald ruins';
    setAuto(state.auto);setPause(settings.paused);refreshSliders();refreshLabels();
  }
  function applyPreset(value,options={}){
    const preset=P.validatePreset(value);
    const visible=preset.view.layout==='triple'?['analytical','hybrid','fluid']:
      [preset.view.mode,...(preset.view.layout==='compare'?[preset.view.compareMode]:[])];
    if(canRender()&&!simulationSupported&&visible.some(isGPU))throw new Error('This device cannot run GPU fluid targets. CPU and Analytical remain available.');
    // Validation and capability checks finish before any live object changes.
    // Only the codec's fresh whitelist records can enter settings or view state.
    Object.assign(settings,preset.settings);Object.assign(state,preset.view);
    for(const key of ['theta','phi','distance'])orbit[key]=orbit['target'+key[0].toUpperCase()+key.slice(1)]=preset.camera[key];
    state.cameraMode=preset.camera.mode;
    if(canRender())for(const sim of Object.values(sims))sim.setResolution(settings.resolution);
    world?.setTerrain(settings.terrain);world?.setLighting(settings.lighting);world?.setEnvironment(settings.environment);
    reset(true);refreshSetupControls();needsResize=true;
    const source=typeof options?.source==='string'?options.source.slice(0,80):'api';
    if(options?.silent!==true)toast(canRender()?'Setup loaded from time zero.':'Setup prepared. Live rendering is unavailable.');
    window.dispatchEvent(new CustomEvent('foglab:presetchange',{detail:{source,preset:snapshotPreset(),renderReady:canRender()&&state.ready}}));
    return snapshotPreset();
  }
  $('exportPreset').onclick=()=>download(new Blob([JSON.stringify(snapshotPreset(),null,2)],{type:'application/json'}),'FogLab-preset.json');
  $('importPreset').onclick=()=>$('presetFile').click();
  $('presetFile').onchange=async e=>{
    try{const file=e.target.files[0];if(!file)return;if(file.size>P.MAX_JSON_BYTES)throw new Error('Preset is too large.');applyPreset(P.parseJSON(await file.text()),{source:'file'});}
    catch(err){toast('Could not load preset: '+err.message);}finally{e.target.value='';}
  };
  $('captureButton').onclick=()=>{if(!canRender()){toast('A live graphics view is needed to capture an image.');return;}captureRequested=true;};

  function ensureShareDialog(){
    let dialog=$('shareDialog');
    if(!dialog){
      dialog=document.createElement('dialog');dialog.id='shareDialog';
      const heading=document.createElement('h2');heading.textContent='Share this experiment';
      const description=document.createElement('p');description.id='shareDescription';
      const input=document.createElement('textarea');input.id='shareLink';input.readOnly=true;input.setAttribute('aria-label','Experiment link');
      const status=document.createElement('p');status.id='shareStatus';status.setAttribute('role','status');
      const close=document.createElement('button');close.id='shareClose';close.textContent='Close';
      dialog.append(heading,description,input,status,close);document.body.append(dialog);
    }
    const close=$('shareClose');if(close&&!close.dataset.shareBound){close.dataset.shareBound='true';close.addEventListener('click',()=>dialog.close());}
    return dialog;
  }
  async function copyShareLink(){
    const url=P.buildShareURL(snapshotPreset(),location.href);
    try{
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);toast('Experiment link copied. It starts from time zero.');return url;
    }catch(_){
      const dialog=ensureShareDialog(),input=$('shareLink');keys.clear();pointer.down=pointer.stir=false;
      input.value=url;input.readOnly=true;
      if($('shareDescription'))$('shareDescription').textContent='This link restores the settings, camera and comparison from time zero. It does not include the current fluid field.';
      if($('shareStatus'))$('shareStatus').textContent='Select and copy the link below.';
      if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}
      input.focus();input.select();return url;
    }
  }
  $('copyLink')?.addEventListener('click',()=>{copyShareLink().catch(error=>toast('Could not prepare a link: '+error.message));});
  if($('shareDialog'))ensureShareDialog();
  function applyURLSetup(initial=false){
    try{
      const preset=P.decodeHash(location.hash);
      if(preset){applyPreset(preset,{silent:true,source:'link'});toast('Shared experiment loaded from time zero.');}
      else if(!initial){applyPreset(P.defaultPreset(),{silent:true,source:'link'});toast('Default experiment restored.');}
      return true;
    }catch(error){toast('Experiment link ignored: '+error.message);return false;}
  }
  window.addEventListener('hashchange',()=>applyURLSetup(false));

  const moveKeys=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
  window.addEventListener('keydown',e=>{
    // Focused controls own their keys. Space on a guide button must activate
    // that button, and arrows in a dialog must not move the hidden wanderer.
    if(document.querySelector('dialog[open]')||e.target?.isContentEditable||e.target?.closest?.('input,select,textarea,button,a,[role="button"],[role="link"]')||e.ctrlKey||e.metaKey||e.altKey)return;
    if(moveKeys.has(e.code)){e.preventDefault();keys.add(e.code);if(state.auto)setAuto(false);return;}
    if(e.code==='ShiftLeft'||e.code==='ShiftRight')keys.add(e.code);
    if(e.repeat)return;
    if(e.code==='Space'){e.preventDefault();jump();}else if(e.code==='KeyX')slash();else if(e.code==='KeyF')pulse();else if(e.code==='KeyP')setPause(!settings.paused);else if(e.code==='KeyR')reset();else if(e.code==='KeyT')setAuto(!state.auto);else if(e.code==='KeyC')cycleCamera();else if(e.code==='KeyH')toggleUI();
  });
  window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>{keys.clear();pointer.down=pointer.stir=false;});
  document.addEventListener('visibilitychange',()=>{lastNow=performance.now();state.accumulator=0;simulationClock.beginFrame(0,{visible:false});keys.clear();pointer.down=pointer.stir=false;});
  const canvas=$('viewport');canvas.addEventListener('contextmenu',e=>e.preventDefault());
  function mouseWorld(e){if(!camera||!world||state.halted)return null;const rect=canvas.getBoundingClientRect(),count=paneConfigs().length,w=rect.width/count,x=((e.clientX-rect.left)%w)/w*2-1,y=1-(e.clientY-rect.top)/rect.height*2;pointerNdc.set(x,y);raycaster.setFromCamera(pointerNdc,camera);const ray=raycaster.ray;if(ray.direction.y>=-.003)return null;let t=-ray.origin.y/ray.direction.y;const out=new T.Vector3();for(let i=0;i<4;i++){out.copy(ray.direction).multiplyScalar(t).add(ray.origin);t=(world.terrainHeight(out.x,out.z)-ray.origin.y)/ray.direction.y;}out.copy(ray.direction).multiplyScalar(t).add(ray.origin);return {x:clamp(out.x,-14.5,14.5),z:clamp(out.z,-14.5,14.5)};}
  function updateBrush(e){const pos=mouseWorld(e);if(!pos)return;const now=performance.now()/1000,dt=clamp(now-pointer.lastTime,.016,.15);pointer.vx=clamp((pos.x-pointer.worldX)/dt,-10,10);pointer.vz=clamp((pos.z-pointer.worldZ)/dt,-10,10);pointer.worldX=pos.x;pointer.worldZ=pos.z;pointer.lastTime=now;}
  canvas.addEventListener('pointerdown',e=>{canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);pointer.down=true;pointer.button=e.button;pointer.x=e.clientX;pointer.y=e.clientY;if(e.button===2||e.shiftKey){pointer.stir=true;const pos=mouseWorld(e);if(pos){pointer.worldX=pos.x;pointer.worldZ=pos.z;}pointer.lastTime=performance.now()/1000;pointer.vx=pointer.vz=0;updateBrush(e);}});
  canvas.addEventListener('pointermove',e=>{if(!pointer.down)return;const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;pointer.x=e.clientX;pointer.y=e.clientY;if(pointer.stir){updateBrush(e);}else{orbit.targetTheta-=dx*.005;orbit.targetPhi=clamp(orbit.targetPhi+dy*.004,.07,1.49);state.cameraMode=0;$('cameraButton').textContent='Orbit view';}});
  const endPointer=()=>{pointer.down=false;pointer.stir=false;};canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',endPointer);
  canvas.addEventListener('wheel',e=>{e.preventDefault();orbit.targetDistance=clamp(orbit.targetDistance*Math.exp(e.deltaY*.001),7,48);},{passive:false});
  new ResizeObserver(()=>needsResize=true).observe($('stage'));

  function updateCamera(dt){
    if(!camera||!world)return;
    const f=1-Math.exp(-dt*12);orbit.theta+=(orbit.targetTheta-orbit.theta)*f;orbit.phi+=(orbit.targetPhi-orbit.phi)*f;orbit.distance+=(orbit.targetDistance-orbit.distance)*f;
    const a=renderState.actors[0],follow=state.cameraMode===3&&a;
    const goal=new T.Vector3(follow?a.x:0,follow?world.terrainHeight(a.x,a.z)+.72:.55,follow?a.z:-1);cameraTarget.lerp(goal,f);
    camera.position.set(cameraTarget.x+Math.sin(orbit.theta)*Math.sin(orbit.phi)*orbit.distance,cameraTarget.y+Math.cos(orbit.phi)*orbit.distance,cameraTarget.z+Math.cos(orbit.theta)*Math.sin(orbit.phi)*orbit.distance);
    camera.position.y=Math.max(camera.position.y,world.terrainHeight(camera.position.x,camera.position.z)+.35);camera.lookAt(cameraTarget);camera.updateMatrixWorld();
  }
  function physicsStep(dt){
    if(!canRender()||!Number.isFinite(dt)||dt<=0)return false;
    const modes=[...activeModes()],cpu=modes.includes('cpu')?sims.cpu:null;
    // Reject before moving actors or consuming an input. The worker owns at
    // most one solve; the clock retains only a small, bounded time budget.
    if(pendingTick||cpu?.pending||cpu?.needsResync)return false;
    if(cpu&&!cpu.supported)throw new Error('No CPU execution path is available. '+cpu.fallbackReason);
    dt=Math.min(dt,1/20);
    state.time+=dt;state.pulseAge+=dt;const t=state.time,solids=settings.obstacles?world.getObstacles():[];
    for(let i=0;i<state.actors.length;i++){
      const a=state.actors[i],ox=a.x,oz=a.z;
      if(i===0&&!state.auto){
        let forward=(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0),side=(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0);const len=Math.hypot(forward,side)||1;forward/=len;side/=len;
        const speed=(keys.has('ShiftLeft')||keys.has('ShiftRight'))?5.4:2.6;const sx=Math.sin(orbit.theta),cz=Math.cos(orbit.theta);
        a.x=clamp(a.x+(-sx*forward+cz*side)*speed*dt,-12.8,12.8);a.z=clamp(a.z+(-cz*forward-sx*side)*speed*dt,-12.8,12.8);
      }else{
        const p=automaticPosition(i,t);
        if(i===0){autoResume.x*=Math.exp(-dt*.18);autoResume.z*=Math.exp(-dt*.18);p.x+=autoResume.x;p.z+=autoResume.z;}
        a.x=clamp(p.x,-12.8,12.8);a.z=clamp(p.z,-12.8,12.8);
      }
      if(solids.length){const p=F.Interactions.resolveMotion({x:ox,z:oz},a,solids);a.x=p.x;a.z=p.z;}
      a.vx=clamp((a.x-ox)/dt,-9,9);a.vz=clamp((a.z-oz)/dt,-9,9);a.radius=settings.radius;a.strength=1;
      if(Math.hypot(a.vx,a.vz)>.04)a.heading=Math.atan2(-a.vx,-a.vz);
      if(F.Interactions.advanceJump(a,dt)&&i===0){state.pulseAge=0;state.pulseX=a.x;state.pulseZ=a.z;}
      a.strength=clamp(1-a.jump/Math.max(settings.height,.3),.15,1);
    }
    const segments=F.Interactions.advanceSlash(state.actors[0],dt,settings.radius);
    let interactors=state.actors.map(a=>({...a}));
    if(pointer.stir){if(performance.now()/1000-pointer.lastTime>.1){pointer.vx*=.8;pointer.vz*=.8;}interactors=interactors.slice(0,7);interactors.push({x:pointer.worldX,z:pointer.worldZ,vx:pointer.vx,vz:pointer.vz,radius:settings.radius*1.15,strength:1.4});}
    if(state.pulseAge<.7){interactors=interactors.slice(0,1);const radius=.3+state.pulseAge*7;for(let i=0;i<7;i++){const ang=i*Math.PI*2/7;interactors.push({x:state.pulseX+Math.cos(ang)*radius,z:state.pulseZ+Math.sin(ang)*radius,vx:Math.cos(ang)*8,vz:Math.sin(ang)*8,radius:settings.radius*.85,strength:1.6*(1-state.pulseAge/.8)});}}
    for(const p of state.trails)p.age+=dt;
    state.trails=state.trails.filter(p=>p.age<settings.persistence*3);
    if(t-state.lastStamp>=.12||state.pulseAge<.7){
      for(const a of interactors){state.trails.unshift({x:a.x,z:a.z,age:0,strength:a.strength,vx:a.vx,vz:a.vz,radius:a.radius});}
      state.trails=state.trails.slice(0,24);state.lastStamp=t;
    }
    for(const s of segments)state.trails.unshift({x:s.x1,z:s.z1,x0:s.x0,z0:s.z0,radius:s.radius,age:0,strength:s.strength,vx:s.vx,vz:s.vz});
    state.trails=state.trails.slice(0,24);
    const tick={dt,time:t,modes,interactors,segments,settings:{...settings},actors:state.actors.map(a=>({...a})),trails:state.trails.map(p=>({...p})),epoch:cpu?.epoch};
    if(cpu){
      pendingTick=tick;
      if(cpu.step(dt,t,interactors,tick.settings,segments)!==true){
        // A synchronous postMessage failure has already exposed its fallback.
        // Restart the complete experiment rather than leaving moved actors
        // paired with a field from the previous generation.
        const reason=cpu.fallbackReason;reset(true);refreshLabels();toast(reason?'CPU worker unavailable. Main-thread fallback; fields restarted.':'CPU step was not accepted. Fields restarted.');return false;
      }
      flushSimulation();
    }else commitTick(tick);
    return true;
  }

  function commitTick(tick){
    lastSimulationPasses=0;
    for(const mode of tick.modes)if(mode!=='analytical'&&mode!=='cpu'&&sims[mode]){sims[mode].step(tick.dt,tick.time,tick.interactors,tick.settings,tick.segments);lastSimulationPasses+=sims[mode].passCount;}
    world.recordSlash(tick.segments,tick.time);
    renderState.time=tick.time;renderState.actors=tick.actors;renderState.trails=tick.trails;
    committedTicks++;statTicks++;return tick.dt;
  }
  function flushSimulation(){
    const cpu=activeModes().has('cpu')?sims?.cpu:null;
    if(cpu?.needsResync){
      if(!cpu.supported)throw new Error('No CPU execution path is available. '+cpu.fallbackReason);
      reset(true);refreshLabels();toast('CPU worker stopped. Main-thread fallback; all fields restarted.');return 0;
    }
    if(!pendingTick)return 0;
    if(!cpu||cpu.epoch!==pendingTick.epoch){reset(true);return 0;}
    // Debug inspection can still be pending after a solve has completed.
    // The committed timestamp, not the busy flag, is the comparison fence.
    if(cpu.simulationTime+1e-8<pendingTick.time)return 0;
    if(Math.abs(cpu.simulationTime-pendingTick.time)>1e-8)throw new Error('CPU and render simulation clocks diverged.');
    const tick=pendingTick;pendingTick=null;return commitTick(tick);
  }

  function resize(){
    if(!canRender())return false;
    const rect=$('stage').getBoundingClientRect(),q=qualities[settings.quality],ratio=Math.min(window.devicePixelRatio||1,q.pixelRatio)*q.drawScale;
    const width=Math.max(2,Math.round(rect.width*ratio)),height=Math.max(2,Math.round(rect.height*ratio));
    if(canvas.width!==width||canvas.height!==height)renderer.setSize(width,height,false);
    const paneWidth=Math.floor(width/paneConfigs().length);
    if(sceneRT.width!==paneWidth||sceneRT.height!==height)sceneRT.setSize(paneWidth,height);
    camera.aspect=paneWidth/height;camera.fov=camera.aspect<.7?62:48;camera.updateProjectionMatrix();needsResize=false;
  }
  function beginGpu(){if(!timerExt||activeQuery||queryQueue.length>=5)return;const query=gl.createQuery();gl.beginQuery(timerExt.TIME_ELAPSED_EXT,query);activeQuery=query;}
  function endGpu(){if(!activeQuery)return;gl.endQuery(timerExt.TIME_ELAPSED_EXT);queryQueue.push(activeQuery);activeQuery=null;}
  function pollGpu(){if(!timerExt)return;const disjoint=gl.getParameter(timerExt.GPU_DISJOINT_EXT);while(queryQueue.length){const q=queryQueue[0];if(!disjoint&&!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))break;queryQueue.shift();if(!disjoint){const ms=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;if(Number.isFinite(ms)&&ms<10000)gpuMs=gpuMs===null?ms:gpuMs*.7+ms*.3;}gl.deleteQuery(q);}}

  function draw(){
    if(!canRender())return false;
    const completed=flushSimulation();if(completed)world.update(renderState.time,completed,renderState.actors,settings);
    if(needsResize)resize();
    const panes=paneConfigs(),width=canvas.width,height=canvas.height,paneWidth=Math.floor(width/panes.length);
    renderer.setScissorTest(false);renderer.setRenderTarget(sceneRT);renderer.setViewport(0,0,paneWidth,height);renderer.setClearColor(0x162b2c,1);renderer.clear(true,true,true);renderer.render(world.scene,camera);
    renderer.setRenderTarget(null);renderer.setViewport(0,0,width,height);renderer.setScissorTest(false);renderer.setClearColor(0x102023,1);renderer.clear(true,true,true);
    lastFogPasses=0;
    panes.forEach((p,i)=>{
      const x=i*paneWidth,w=i===panes.length-1?width-x:paneWidth;
      renderer.setRenderTarget(null);renderer.setViewport(x,0,w,height);renderer.setScissor(x,0,w,height);renderer.setScissorTest(true);
      const sim=sims[p.mode];
      sim?.prepareDebug?.(settings.debug);
      fog.render({camera,sceneTexture:sceneRT.texture,depthTexture:sceneRT.depthTexture,width:w,height,time:renderState.time,settings,mode:p.mode,renderMode:p.renderer==='mesh'&&settings.meshLayers===4?'shells':p.renderer,fieldTexture:sim?.texture,velocityTexture:sim?.velocityTexture,pressureTexture:sim?.pressureTexture,curlTexture:sim?.curlTexture,divergenceTexture:sim?.divergenceTexture,obstacleTexture:sim?.obstacleTexture||sims.fluid.obstacleTexture,trails:renderState.trails,target:null});
      lastFogPasses+=fog.passCount;
    });
    renderer.setScissorTest(false);renderer.setViewport(0,0,width,height);
    frameDraws=renderer.info.render.calls;frameTriangles=renderer.info.render.triangles;
    if(captureRequested){captureRequested=false;canvas.toBlob(blob=>{if(blob){download(blob,'FogLab-'+state.mode+'-'+state.renderer+'.png');toast('View captured.');}else toast('This browser could not capture the frame.');},'image/png');}
  }
  function updateStats(now){
    const elapsed=now-statStart;if(elapsed<650)return;
    lastFps=statFrames*1000/elapsed;$('fps').textContent=Math.round(lastFps)+' fps';
    $('gpuTime').textContent=(gpuMs===null?submitMs:gpuMs).toFixed(1);$('gpuLabel').textContent=gpuMs===null?'CPU frame · ms':'GPU total · ms';$('timingBadge').textContent=gpuMs===null?'CPU / FRAME':'GPU / FRAME';
    let passes=0;for(const m of activeModes())passes+=m==='analytical'||m==='cpu'?0:m==='hybrid'?1:settings.pressure+(settings.vorticity>.001?7:6);
    $('simPasses').textContent=passes;$('drawCalls').textContent=frameDraws;
    $('perfBar').style.width=clamp((gpuMs??submitMs)/16.67*100,3,100)+'%';$('perfBar').style.background=(gpuMs??submitMs)>16.67?'#d1b27c':'#a4cdaa';
    $('perfNote').textContent=state.layout==='single'?`${Math.round(frameTriangles/1000)}k submitted triangles · ${lastFogPasses} fog draws. ${gpuMs===null?'CPU time is not GPU time.':'GPU includes the whole scene.'}`:`${paneConfigs().length} synchronized views · one shared scene render. Use Solo for isolated timing.`;
    lastSimulationHz=statTicks*1000/elapsed;
    $('simulationRate').textContent=lastSimulationHz.toFixed(1)+' / 30';
    const cpu=sims.cpu,cpuActive=activeModes().has('cpu');$('cpuMetrics').hidden=!cpuActive;
    $('workerLatencyMetric').hidden=!(cpuActive&&cpu?.execution==='worker');
    if(cpuActive&&cpu){$('cpuTimingScope').textContent=settings.paused?'last '+cpu.execution+' tick · paused':(cpu.execution==='worker'?'worker':'main')+' solve + pack / tick';$('cpuSolve').textContent=(cpu.lastStepMs||0).toFixed(2)+' ms';$('cpuUpload').textContent=Math.round((cpu.uploadBytesPerTick||0)/1024)+' KiB';$('workerLatency').textContent=(cpu.lastRoundTripMs||0).toFixed(1)+' ms';}
    const notes=[];
    if(cpuActive&&cpu){
      if(cpu.fallbackReason)notes.push('Main-thread fallback: '+cpu.fallbackReason);
      else if(cpu.execution==='worker')notes.push(cpu.pending?'Worker busy. Drawing the last completed tick.':'CPU solver runs in a background worker.');
      else notes.push('CPU solver runs on the main thread.');
    }
    if(simulationClock.droppedSeconds>.05)notes.push(simulationClock.droppedSeconds.toFixed(1)+' s of excess wall-clock budget discarded since reset. Simulation slows under load.');
    $('runtimeNote').textContent=notes.join(' ');$('runtimeNote').hidden=!notes.length;
    $('viewport').dataset.frames=state.frame;$('viewport').dataset.errors=errors.length;$('viewport').dataset.mode=state.mode;$('viewport').dataset.render=state.renderer;$('viewport').dataset.time=renderState.time.toFixed(2);
    statStart=now;statFrames=0;statTicks=0;
  }
  function frame(now){
    if(state.halted)return;
    try{
      const cpuStart=performance.now(),elapsed=Math.max(0,(now-lastNow)/1000),dt=Math.min(elapsed,.10);lastNow=now;state.frame++;statFrames++;pollGpu();renderer.info.reset();
      if(state.frame%10===0)beginGpu();
      const previousTime=renderState.time;flushSimulation();
      simulationClock.beginFrame(elapsed,{paused:settings.paused,visible:!document.hidden});
      while(simulationClock.canStep()){
        if(!physicsStep(simulationClock.dt))break;
        simulationClock.consumeStep();
      }
      // A queued manual step survives worker startup or a still-pending solve.
      if(settings.paused&&stepRequested&&!document.hidden&&physicsStep(simulationClock.dt))stepRequested=false;
      state.accumulator=simulationClock.accumulator;
      world.update(renderState.time,Math.max(0,renderState.time-previousTime),renderState.actors,settings);updateCamera(Math.max(dt,1/120));draw();endGpu();submitMs=submitMs*.85+(performance.now()-cpuStart)*.15;
      if(!state.ready){state.ready=true;$('loading').classList.add('done');setTimeout(()=>$('loading').hidden=true,700);announceReady();}
      updateStats(now);requestAnimationFrame(frame);
    }catch(e){try{endGpu();}catch(_){}fail(e);}
  }

  function init(){
    try{
      gl=canvas.getContext('webgl2',{antialias:false,alpha:false,powerPreference:'high-performance',preserveDrawingBuffer:false});
      // A power preference is only a hint. Some dual-GPU browsers reject it
      // even though their default adapter can supply a valid WebGL 2 context.
      if(!gl)gl=canvas.getContext('webgl2',{antialias:false,alpha:false,preserveDrawingBuffer:false});
      if(!gl)throw new Error('WebGL 2 is unavailable');
      renderer=new T.WebGLRenderer({canvas,context:gl,antialias:false,alpha:false});renderer.setPixelRatio(1);renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;renderer.autoClear=false;
      renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.info.autoReset=false;
      renderer.debug.checkShaderErrors=true;renderer.debug.onShaderError=(g,p,vs,fs)=>{throw new Error('Shader compilation: '+(g.getShaderInfoLog(vs)||'')+' '+(g.getShaderInfoLog(fs)||'')+' '+(g.getProgramInfoLog(p)||''));};
      canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();fail(new Error('The graphics context was interrupted. Reload to restore live rendering.'));});
      noise=createNoiseAtlas();world=F.createWorld(T);camera=new T.PerspectiveCamera(48,1,.1,150);
      sims={hybrid:new F.FieldSimulation(renderer,noise,{mode:'hybrid',resolution:settings.resolution,worldSize:32}),fluid:new F.FieldSimulation(renderer,noise,{mode:'fluid',resolution:settings.resolution,worldSize:32})};
      simulationSupported=sims.fluid.supported&&sims.hybrid.supported;
      if(!simulationSupported){
        // A shared link can select several GPU modes before capabilities are
        // known. Collapse the complete visible layout to a safe analytical view.
        if(isGPU(state.mode))state.mode='cpu';if(isGPU(state.compareMode))state.compareMode='analytical';if(state.layout==='triple')state.layout='single';
        for(const el of document.querySelectorAll('[data-mode="hybrid"],[data-mode="fluid"],[data-layout="triple"]'))el.disabled=true;
        $('capability').textContent='WEBGL 2 · CPU FLUIDS';toast('Float rendering unavailable. CPU and Analytical remain available.');
      }
      sceneRT=new T.WebGLRenderTarget(2,2,{type:simulationSupported?T.HalfFloatType:T.UnsignedByteType,minFilter:T.LinearFilter,magFilter:T.LinearFilter,depthBuffer:true,stencilBuffer:false});sceneRT.texture.colorSpace=T.NoColorSpace;sceneRT.depthTexture=new T.DepthTexture(2,2,T.UnsignedIntType);sceneRT.depthTexture.format=T.DepthFormat;
      fog=new F.FogRenderer(renderer,noise,world.terrainGLSL);timerExt=gl.getExtension('EXT_disjoint_timer_query_webgl2');
      reset(true);refreshSetupControls();resize();updateCamera(0);lastNow=performance.now();requestAnimationFrame(frame);
    }catch(e){fail(e);}
  }
  // Prepare a shareable setup before the first graphics call. Invalid links
  // leave the current/default setup unchanged and report a readable message.
  reset(true);refreshSetupControls();applyURLSetup(true);
  // Let the offline UI paint before shader compilation begins.
  requestAnimationFrame(()=>setTimeout(init,20));
})();
