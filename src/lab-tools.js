(function(){
  'use strict';
  const $=id=>document.getElementById(id),F=window.FogLab;
  $('meshLayers').onchange=e=>{if(F.app)F.app.settings.meshLayers=+e.target.value;};
  $('diagnosticButton').onclick=()=>{
    const out=$('diagnosticResult');out.hidden=false;
    if(!F.app?.renderReady){out.textContent='GPU diagnostics need a running WebGL 2 context. Learning, presets, sharing, and shader export remain available.';return;}
    try{
      const result=F.app.diagnostics();
      out.textContent=JSON.stringify(result,null,2);
    }catch(e){out.textContent='Readback unavailable: '+e.message;}
  };
  $('shaderButton').onclick=()=>{
    const source={note:'Original FogLab GLSL. MIT license. Three.js prefixes, common blocks and uniforms must be supplied when extracting. Runtime terrain GLSL comes from world.terrainGLSL. Motion and rendering remain independent.',simulation:F.simulationShaders,rendering:F.fogShaders,terrain:F.app?.world?.terrainGLSL||null};
    const url=URL.createObjectURL(new Blob([JSON.stringify(source,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='FogLab-shaders.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
  };
})();
