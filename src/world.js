/* FogLab: neutral reference stage and optional procedural ruin garden. */
(function () {
  'use strict';
  const F = window.FogLab = window.FogLab || {};

  F.createWorld = function createWorld(THREE) {
    const scene = new THREE.Scene();
    const disposables = new Set();
    const placements = [];
    const movers = [];
    const timeUniform = { value: 0 };
    let terrainMode = 1;
    let lightingMode = 'reference';
    let environmentMode = 'reference';
    const forestEnvironment = new THREE.Group();forestEnvironment.name='Optional forest dressing';scene.add(forestEnvironment);
    const referenceEnvironment = new THREE.Group();referenceEnvironment.name='Reference stage';scene.add(referenceEnvironment);
    let seed = 0x531abc2;
    function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
    const lerp = (a,b,t) => a+(b-a)*t;
    const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
    const own = x => { disposables.add(x); return x; };
    const color = s => new THREE.Color(s);

    function hills(x,z) {
      // Broad hills cross the world-space fog level. Analytic range: [-.30, 1.60].
      return .65+.70*Math.sin(.32*x-.6)*Math.cos(.28*z+.4)
        +.25*Math.sin(.18*x+.23*z+1.2);
    }
    function terrainHeight(x,z) { return terrainMode*hills(x,z); }
    const terrainGLSL = `
      uniform float uTerrain;
      float terrainHeight(vec2 p) {
        float h=.65+.70*sin(.32*p.x-.6)*cos(.28*p.y+.4)
          +.25*sin(.18*p.x+.23*p.y+1.2);
        return h*uTerrain;
      }
    `;

    const skyUniforms = {
      zenith: {value:color('#172d3d')}, horizon:{value:color('#6b8d86')},
      sunColor:{value:color('#ffe1a3')}, sunDirection:{value:new THREE.Vector3(-.5,.45,-.68).normalize()},
      sunStrength:{value:.34}
    };
    const skyMaterial = own(new THREE.ShaderMaterial({
      uniforms:skyUniforms, side:THREE.BackSide, depthWrite:false, depthTest:false,
      vertexShader:`varying vec3 vDirection; void main(){vDirection=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`varying vec3 vDirection; uniform vec3 zenith,horizon,sunColor,sunDirection; uniform float sunStrength;
        void main(){vec3 d=normalize(vDirection); float h=pow(max(d.y,0.),.64); vec3 c=mix(horizon,zenith,h);
          float s=max(dot(d,sunDirection),0.); c+=sunColor*(pow(s,18.)*.16+pow(s,240.)*.17+pow(s,1400.)*.6)*sunStrength;
          gl_FragColor=vec4(c,1.); #include <tonemapping_fragment>\n #include <colorspace_fragment>\n }`
    }));
    // Shader chunks must begin on their own lines.
    skyMaterial.fragmentShader=skyMaterial.fragmentShader.replace(' #include','\n #include');
    const sky = new THREE.Mesh(own(new THREE.SphereGeometry(100,24,12)),skyMaterial);
    sky.renderOrder=-1000; sky.frustumCulled=false; scene.add(sky);

    const hemisphere = new THREE.HemisphereLight('#b9e8d9','#1d3028',2.0); scene.add(hemisphere);
    const sunlight = new THREE.DirectionalLight('#ffdfaa',3.2);
    sunlight.position.set(-13,22,-7); sunlight.target.position.set(0,0,0); scene.add(sunlight,sunlight.target);
    sunlight.castShadow=true; sunlight.shadow.mapSize.set(1024,1024);
    Object.assign(sunlight.shadow.camera,{left:-23,right:23,top:23,bottom:-23,near:1,far:75});
    sunlight.shadow.camera.updateProjectionMatrix();
    sunlight.shadow.bias=-.00025; sunlight.shadow.normalBias=.035;
    const rimLight = new THREE.DirectionalLight('#7fcee0',.8); rimLight.position.set(12,8,11); scene.add(rimLight);
    scene.fog = new THREE.FogExp2('#496269',.020);
    scene.background = color('#496269');

    function material(hex, options={}) { return own(new THREE.MeshStandardMaterial({color:hex,roughness:.95,metalness:0,...options})); }
    // Instanced color is enabled automatically by Three.js. Do not enable vertexColors
    // on these geometries: they deliberately have no per-vertex color attribute.
    const stoneMat=material('#526565');
    const rockMat=material('#596967',{flatShading:true});
    const mossMat=material('#476d43',{flatShading:true});
    const barkMat=material('#2b443e',{flatShading:true});
    const leafMat=material('#377154',{flatShading:true});

    function makeNoiseTexture() {
      const size=128, bytes=new Uint8Array(size*size*4);
      for(let z=0;z<size;z++) for(let x=0;x<size;x++) {
        const i=(z*size+x)*4;
        let v=.85+random()*.26;
        if(random()<.045) v*=.65;
        bytes[i]=Math.min(255,Math.round(207*v)); bytes[i+1]=Math.min(255,Math.round(223*v)); bytes[i+2]=Math.min(255,Math.round(192*v)); bytes[i+3]=255;
      }
      const t=own(new THREE.DataTexture(bytes,size,size,THREE.RGBAFormat));
      t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(48,48);
      t.magFilter=THREE.LinearFilter; t.minFilter=THREE.LinearMipmapLinearFilter; t.generateMipmaps=true;
      t.colorSpace=THREE.SRGBColorSpace; t.needsUpdate=true; return t;
    }

    function makeCheckerTexture() {
      const size=256, bytes=new Uint8Array(size*size*4);
      // Two one-metre squares per repeat. Fine grain prevents an artificial flat fill.
      for(let z=0;z<size;z++)for(let x=0;x<size;x++){
        const i=(z*size+x)*4, tile=((x>>7)+(z>>7))&1;
        const grain=((Math.imul(x+13,1597)^Math.imul(z+37,733))&15)/15;
        const seam=(x%128<1||z%128<1)?-.16:0;
        const v=(tile?77:56)+(grain-.5)*5;
        bytes[i]=Math.round(v*(1+seam));bytes[i+1]=Math.round((v+1)*(1+seam));bytes[i+2]=Math.round((v-4)*(1+seam));bytes[i+3]=255;
      }
      const t=own(new THREE.DataTexture(bytes,size,size,THREE.RGBAFormat));
      t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(50,50);
      t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;
      t.colorSpace=THREE.SRGBColorSpace;t.needsUpdate=true;return t;
    }

    const groundGeometry=own(new THREE.PlaneGeometry(100,100,168,168));
    groundGeometry.rotateX(-Math.PI/2);
    const groundPos=groundGeometry.getAttribute('position');
    const groundColor=new Float32Array(groundPos.count*3);
    const dark=color('#244539'), pale=color('#527154'), path=color('#647264');
    const c=new THREE.Color();
    function pathX(z) { return .8*Math.sin(z*.25)+.2*z; }
    for(let i=0;i<groundPos.count;i++) {
      const x=groundPos.getX(i), z=groundPos.getZ(i);
      const wide=.5+.25*Math.sin(x*.41+z*.21)+.15*Math.cos(z*.63-x*.26);
      c.copy(dark).lerp(pale,clamp(wide,0,1));
      const pathFactor=Math.exp(-Math.pow((x-pathX(z))/1.35,2))*.50;
      c.lerp(path,pathFactor);
      c.multiplyScalar(.93+random()*.14); c.toArray(groundColor,i*3);
      groundPos.setY(i,terrainHeight(x,z));
    }
    groundGeometry.setAttribute('color',new THREE.BufferAttribute(groundColor,3));
    groundGeometry.computeVertexNormals();
    const groundMat=material('#ffffff',{vertexColors:true,map:makeNoiseTexture()});
    const referenceGroundMat=material('#ffffff',{map:makeCheckerTexture(),roughness:1});
    const ground=new THREE.Mesh(groundGeometry,referenceGroundMat); ground.receiveShadow=true; scene.add(ground);

    const dummy=new THREE.Object3D();
    function instanced(geo,mat,specs,cast=false,receive=true,parent=forestEnvironment) {
      const mesh=new THREE.InstancedMesh(geo,mat,specs.length);
      mesh.castShadow=cast; mesh.receiveShadow=receive;
      const record={mesh,specs}; placements.push(record);
      function write() {
        specs.forEach((s,i)=>{
          dummy.position.set(s.x,terrainHeight(s.groundX===undefined?s.x:s.groundX,s.groundZ===undefined?s.z:s.groundZ)+(s.y||0),s.z);
          dummy.rotation.set(s.rx||0,s.ry||0,s.rz||0);
          dummy.scale.set(s.sx||1,s.sy||1,s.sz||1); dummy.updateMatrix(); mesh.setMatrixAt(i,dummy.matrix);
          if(s.color) mesh.setColorAt(i,color(s.color));
        });
        mesh.instanceMatrix.needsUpdate=true;
        if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
        mesh.computeBoundingSphere();
      }
      record.write=write; write(); parent.add(mesh); return mesh;
    }

    const rockGeo=own(new THREE.IcosahedronGeometry(1,1));
    const referenceRockSpecs=[
      {x:-9,z:-7,y:.33,sx:.9,sy:.65,sz:.7,ry:.4},
      {x:9,z:-8,y:.23,sx:.75,sy:.5,sz:.8,ry:1.2},
      {x:-10,z:8,y:.19,sx:.6,sy:.45,sz:.8,ry:.8},
      {x:10,z:8,y:.31,sx:.95,sy:.63,sz:.8,ry:2},
      {x:1,z:-12,y:.3,sx:.9,sy:.6,sz:.75,ry:.6},
      {x:13,z:1,y:.21,sx:.7,sy:.48,sz:.65,ry:1.6},
      {x:-13,z:0,y:.24,sx:.9,sy:.52,sz:.8,ry:.3}
    ];
    instanced(rockGeo,material('#343630',{flatShading:true}),referenceRockSpecs,true,true,referenceEnvironment);
    const courseSpecs=[{x:3.1,z:4.4,radius:.72},{x:-3.2,z:1.1,radius:.8},{x:.5,z:-1.7,radius:.68}];
    const course=new THREE.Group();course.name='Optional flow obstacle course';course.visible=false;scene.add(course);
    const courseMat=material('#58645e',{roughness:.78});
    const courseRimMat=material('#b1d8c9',{metalness:.25,roughness:.5});
    const courseMeshes=courseSpecs.map(s=>{
      const group=new THREE.Group();group.position.set(s.x,terrainHeight(s.x,s.z),s.z);
      const cylinder=new THREE.Mesh(own(new THREE.CylinderGeometry(s.radius,s.radius,2.25,24)),courseMat);cylinder.position.y=1.125;cylinder.castShadow=cylinder.receiveShadow=true;group.add(cylinder);
      const cap=new THREE.Mesh(own(new THREE.CylinderGeometry(s.radius+.035,s.radius+.035,.09,24)),courseRimMat);cap.position.y=2.27;group.add(cap);course.add(group);return group;
    });
    const rockSpecs=[], mossSpecs=[];
    for(let i=0;i<74;i++) {
      let x,z;
      if(i<62) {const a=random()*Math.PI*2, r=12+random()*18;x=Math.cos(a)*r;z=Math.sin(a)*r;}
      else {x=lerp(-12,12,random());z=lerp(-12,8,random());if(Math.abs(x-pathX(z))<2.5)x+=3;}
      const sx=lerp(.35,1.5,random()), sy=lerp(.25,.85,random()), sz=lerp(.35,1.2,random()), ry=random()*6.283;
      rockSpecs.push({x,z,y:sy*.30,sx,sy,sz,ry,rz:(random()-.5)*.25,color:['#c5d2be','#9caaa1','#8c9ba2'][i%3]});
      if(i%3!==1)mossSpecs.push({x:x+.08,z:z-.04,y:sy*.85,sx:sx*.85,sy:sy*.26,sz:sz*.84,ry,color:['#9faf68','#91a981','#7e9f65'][i%3]});
    }
    instanced(rockGeo,rockMat,rockSpecs,true); instanced(rockGeo,mossMat,mossSpecs);

    const treeTrunks=[], treeCrowns=[], roots=[];
    for(let i=0;i<64;i++) {
      const a=random()*Math.PI*2, r=20+random()*17;
      const x=Math.cos(a)*r, z=Math.sin(a)*r;
      const h=6+random()*8, w=.34+random()*.32;
      treeTrunks.push({x,z,y:h*.49,sx:w,sy:h,sz:w,ry:random()*6,color:['#a6b4a0','#c3b8a0','#829d91'][i%3]});
      for(let k=0;k<3;k++)treeCrowns.push({x:x+(k-1)*1.1,z:z+(random()-.5)*1.8,y:h*(.68+.13*k),sx:1.8+random()*1.8,sy:2+random()*2,sz:2+random()*1.8,ry:random()*6,color:['#a5bc93','#709d84','#b4c29c','#7faaa0'][i%4]});
      roots.push({x,z,y:.1,sx:w*2.2,sy:.6,sz:w*1.8,ry:random()*6,color:'#b5b7a0'});
    }
    instanced(own(new THREE.CylinderGeometry(.7,1,1,6,1)),barkMat,treeTrunks,true);
    instanced(own(new THREE.DodecahedronGeometry(1,1)),leafMat,treeCrowns,true);
    instanced(rockGeo,barkMat,roots,false);

    // Three crossed curved blades, instanced around the clearing.
    const grassPositions=[],grassNormals=[],grassColors=[],grassIndices=[];
    for(let k=0;k<3;k++) {
      const a=k*Math.PI/3, ca=Math.cos(a),sa=Math.sin(a), base=grassPositions.length/3;
      const blade=[[-.055,0,0],[.055,0,0],[-.035,.28,.025],[.035,.28,.025],[0,.61,.09]];
      for(const v of blade) {grassPositions.push(v[0]*ca+v[2]*sa,v[1],-v[0]*sa+v[2]*ca);grassNormals.push(sa*.15,.8,ca*.15);const s=.55+v[1]*.73;grassColors.push(s,s,s);}
      grassIndices.push(base,base+2,base+1,base+1,base+2,base+3,base+2,base+4,base+3);
    }
    const grassGeo=own(new THREE.BufferGeometry());
    grassGeo.setAttribute('position',new THREE.Float32BufferAttribute(grassPositions,3));
    grassGeo.setAttribute('normal',new THREE.Float32BufferAttribute(grassNormals,3));
    grassGeo.setAttribute('color',new THREE.Float32BufferAttribute(grassColors,3)); grassGeo.setIndex(grassIndices);
    const grassMat=material('#87a878',{vertexColors:true,side:THREE.DoubleSide});
    grassMat.onBeforeCompile=shader=>{
      shader.uniforms.uWorldTime=timeUniform;
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nuniform float uWorldTime;');
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        float wPhase=instanceMatrix[3].x*.38+instanceMatrix[3].z*.25;
        transformed.x+=sin(uWorldTime*1.35+wPhase)*position.y*position.y*.24;
        transformed.z+=cos(uWorldTime*.9+wPhase*.8)*position.y*position.y*.14;`);
    };
    const grass=[];
    for(let i=0;i<3000;i++) {
      const x=lerp(-24,24,random()),z=lerp(-24,24,random());
      if(Math.abs(x-pathX(z))<1.0&&random()<.9)continue;
      const s=.6+random()*.85;
      grass.push({x,z,y:-.025,sx:s,sy:s,sz:s,ry:random()*6.28,color:['#dce6b1','#a5c5a3','#b8d3b4','#b2c787'][i%4]});
    }
    instanced(grassGeo,grassMat,grass,false,true);

    const flowers=[],flowerStems=[];
    for(let i=0;i<110;i++) {
      const z=lerp(-15,15,random()), x=pathX(z)+(random()<.5?-1:1)*(2.4+random()*3.5);
      const h=.22+random()*.29;
      flowers.push({x,z,y:h,sx:.065,sy:.045,sz:.065,ry:random()*6,color:['#edd280','#d5ddec','#b3cbb9','#e1b57c'][i%4]});
      flowerStems.push({x,z,y:h*.5,sx:.012,sy:h,sz:.012,color:'#b6c597'});
    }
    instanced(own(new THREE.IcosahedronGeometry(1,0)),material('#ffffff'),flowers,false);
    instanced(own(new THREE.CylinderGeometry(.7,1,1,3)),mossMat,flowerStems,false);

    // Hand-composed ruin built from bevelled blocks. Positions follow either terrain mode.
    const blockShape=new THREE.Shape();
    blockShape.moveTo(-.5,-.5);blockShape.lineTo(.5,-.5);blockShape.lineTo(.5,.5);blockShape.lineTo(-.5,.5);blockShape.closePath();
    const blockGeo=own(new THREE.ExtrudeGeometry(blockShape,{depth:.88,bevelEnabled:true,bevelSize:.055,bevelThickness:.055,bevelSegments:1,steps:1}));
    blockGeo.translate(0,0,-.44); blockGeo.computeVertexNormals();
    const blocks=[], archX=-3.4, archZ=-10.5;
    const baseH=terrainHeight(archX,archZ);
    function archBlock(x,y,z,sx,sy,sz,rz=0,ry=0) {
      blocks.push({x,z,y,groundX:archX,groundZ:archZ,sx,sy,sz,rz,ry,color:['#b1c2af','#c7c8b2','#97afa7','#9aa7a0'][blocks.length%4]});
    }
    for(let side of [-1,1]) for(let j=0;j<4;j++)archBlock(archX+side*2.05,.43+j*.84,archZ,.91,.78,1.05,(random()-.5)*.018);
    for(let j=0;j<9;j++) {
      const a=j*Math.PI/8;
      archBlock(archX+Math.cos(a)*2.05,2.97+Math.sin(a)*2.05,archZ,.78,.94,1.03,a-Math.PI/2);
    }
    for(let i=0;i<9;i++) {
      const x=archX-4.2+i*.8,z=archZ-1.4;
      archBlock(x,.21,z,.84,.35,1.1,0,.02*Math.sin(i));
      if(i<3||i>6)archBlock(x,.6,z,.84,.43,.8,0,.02*Math.sin(i));
    }
    // Fallen columns and a low ring of stones frame the clearing without enclosing it.
    for(let i=0;i<12;i++) {
      const x=(i<6?8:-11)+Math.sin(i)*1.4,z=-7+(i%6)*1.3;
      blocks.push({x,z,y:.3+(i%3)*.1,sx:.8+random()*.5,sy:.4+random()*.4,sz:.8,ry:random()*2,rz:(random()-.5)*.2,color:'#b3bdad'});
    }
    instanced(blockGeo,stoneMat,blocks,true);

    const pathStones=[];
    for(let i=0;i<27;i++) {
      const z=-12+i*.88,x=pathX(z)+(random()-.5)*.4;
      pathStones.push({x,z,y:.025,sx:.75+random()*.25,sy:.08+random()*.05,sz:.56+random()*.25,ry:(random()-.5)*.3,color:['#b2b7a0','#c0bda6','#829891'][i%3]});
    }
    instanced(blockGeo,stoneMat,pathStones,false,true);

    const ruinMoss=[];
    for(let i=0;i<14;i++) {
      const a=i*Math.PI/13,x=archX+Math.cos(a)*2.08,z=archZ-.05;
      ruinMoss.push({x,z,y:3.1+Math.sin(a)*2.12,groundX:archX,groundZ:archZ,sx:.39,sy:.14,sz:.6,ry:random()*6,color:'#a9b780'});
    }
    instanced(rockGeo,mossMat,ruinMoss,false);

    const goldMat=material('#bda46a',{metalness:.45,roughness:.43});
    const emissiveMat=material('#a3eddd',{emissive:'#58d6bd',emissiveIntensity:1.15,roughness:.25});
    const beacon=new THREE.Group(); beacon.position.set(archX,terrainHeight(archX,archZ)+3.45,archZ+.18);
    const crystal=new THREE.Mesh(own(new THREE.OctahedronGeometry(.23)),emissiveMat); crystal.scale.y=1.65; beacon.add(crystal);
    const ring=new THREE.Mesh(own(new THREE.TorusGeometry(.38,.018,5,32)),goldMat); ring.rotation.y=.28; beacon.add(ring);
    forestEnvironment.add(beacon); movers.push({object:beacon,x:archX,z:archZ+.18,y:3.45,type:'beacon'});
    // Lit stones beside the trail provide warm anchors through the ground mist.
    const lanternMat=material('#ffd287',{emissive:'#ffb850',emissiveIntensity:1.5});
    const lanternBases=[],lanternTops=[];
    for(const p of [[3,4],[-4,-4],[4,-9],[-8,1]]) {
      lanternBases.push({x:p[0],z:p[1],y:.55,sx:.27,sy:1.1,sz:.27,color:'#b6bfa7'});
      lanternTops.push({x:p[0],z:p[1],y:1.25,sx:.13,sy:.22,sz:.13});
    }
    instanced(blockGeo,stoneMat,lanternBases,true);
    instanced(own(new THREE.OctahedronGeometry(1)),lanternMat,lanternTops,false);

    // Original wanderer: amber cape, teal coat, leather boots, and an emissive lantern.
    const skinMat=material('#d3b187',{roughness:.9});
    const bootMat=material('#283c38');
    const coatMat=material('#365c55');
    const hoodMat=material('#274d48');
    const beltMat=material('#816849');
    const bodyGeo=own(new THREE.CylinderGeometry(.24,.29,.55,7));
    const headGeo=own(new THREE.IcosahedronGeometry(.185,2));
    const legGeo=own(new THREE.CylinderGeometry(.105,.12,.76,6));
    const armGeo=own(new THREE.CylinderGeometry(.075,.095,.5,6));
    const hoodGeo=own(new THREE.SphereGeometry(.213,10,7,0,Math.PI*2,0,Math.PI*.58));
    const satchelGeo=own(new THREE.BoxGeometry(.25,.28,.13));
    const lanternGeo=own(new THREE.OctahedronGeometry(.085));
    const characters=[];

    // Each articulated segment combines gold surfaces and dark joints into one
    // vertex-coloured mesh, keeping the reference mannequin to nine draw calls.
    const refCylinder=own(new THREE.CylinderGeometry(1,1,1,8));
    const refSphere=own(new THREE.IcosahedronGeometry(1,1));
    const refBox=own(new THREE.BoxGeometry(1,1,1));
    const refChest=own(new THREE.CylinderGeometry(.25,.19,.43,8));
    const refGold=color('#f0bd4f'), refDark=color('#282925');
    function mergedParts(parts) {
      const positions=[],normals=[],colors=[];
      for(const part of parts){
        const geo=part.g,pa=geo.attributes.position,na=geo.attributes.normal,ix=geo.index;
        const s=part.s||[1,1,1],p=part.p||[0,0,0],tint=part.dark?refDark:refGold;
        const n=ix?ix.count:pa.count;
        for(let j=0;j<n;j++){
          const k=ix?ix.getX(j):j;
          positions.push(pa.getX(k)*s[0]+p[0],pa.getY(k)*s[1]+p[1],pa.getZ(k)*s[2]+p[2]);
          const nx=na.getX(k)/s[0],ny=na.getY(k)/s[1],nz=na.getZ(k)/s[2],inv=1/Math.hypot(nx,ny,nz);
          normals.push(nx*inv,ny*inv,nz*inv);colors.push(tint.r,tint.g,tint.b);
        }
      }
      const geo=own(new THREE.BufferGeometry());
      geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
      geo.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));return geo;
    }
    const mannequinMat=material('#ffffff',{vertexColors:true,roughness:.63,metalness:.06});
    const refBody=mergedParts([
      {g:refChest,p:[0,.08,0]},
      {g:refSphere,p:[0,-.23,0],s:[.20,.13,.155]},
      {g:refCylinder,p:[0,.35,0],s:[.066,.10,.066],dark:true},
      {g:refSphere,p:[0,.54,-.005],s:[.16,.19,.16]},
      {g:refCylinder,p:[0,-.02,0],s:[.213,.026,.213],dark:true},
      {g:refCylinder,p:[0,.15,0],s:[.234,.026,.234],dark:true}
    ]);
    const refUpperArm=mergedParts([
      {g:refSphere,s:[.082,.082,.082],dark:true},
      {g:refCylinder,p:[0,-.155,0],s:[.074,.245,.074]},
      {g:refSphere,p:[0,-.30,0],s:[.062,.062,.062],dark:true}
    ]);
    const refLowerArm=mergedParts([
      {g:refCylinder,p:[0,-.13,0],s:[.064,.225,.064]},
      {g:refSphere,p:[0,-.285,0],s:[.070,.085,.065]}
    ]);
    const refUpperLeg=mergedParts([
      {g:refSphere,s:[.09,.09,.09],dark:true},
      {g:refCylinder,p:[0,-.18,0],s:[.090,.31,.095]},
      {g:refSphere,p:[0,-.38,0],s:[.067,.067,.067],dark:true}
    ]);
    const refLowerLeg=mergedParts([
      {g:refCylinder,p:[0,-.17,0],s:[.079,.31,.078]},
      {g:refBox,p:[0,-.395,-.065],s:[.16,.11,.27]}
    ]);
    function makeMannequin() {
      const group=new THREE.Group(),torso=new THREE.Mesh(refBody,mannequinMat);
      torso.position.y=1.12;group.add(torso);
      const arms=[],elbows=[],legs=[],knees=[];
      for(const side of [-1,1]){
        const shoulder=new THREE.Group();shoulder.position.set(side*.29,1.38,0);group.add(shoulder);
        shoulder.add(new THREE.Mesh(refUpperArm,mannequinMat));
        const elbow=new THREE.Group();elbow.position.y=-.30;shoulder.add(elbow);elbow.add(new THREE.Mesh(refLowerArm,mannequinMat));
        arms.push(shoulder);elbows.push(elbow);
        const hip=new THREE.Group();hip.position.set(side*.125,.86,0);group.add(hip);
        hip.add(new THREE.Mesh(refUpperLeg,mannequinMat));
        const knee=new THREE.Group();knee.position.y=-.38;hip.add(knee);knee.add(new THREE.Mesh(refLowerLeg,mannequinMat));
        legs.push(hip);knees.push(knee);
      }
      group.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
      return {group,torso,arms,elbows,legs,knees};
    }

    function makeCharacter(index) {
      const group=new THREE.Group();
      const torso=new THREE.Mesh(bodyGeo,coatMat);torso.position.y=1.06;group.add(torso);
      const head=new THREE.Mesh(headGeo,skinMat);head.position.set(0,1.55,-.015);group.add(head);
      const hood=new THREE.Mesh(hoodGeo,hoodMat);hood.position.set(0,1.56,.015);group.add(hood);
      // A very small dark visor gives the character a readable facing direction.
      const visor=new THREE.Mesh(own(new THREE.BoxGeometry(.22,.045,.018)),bootMat); visor.position.set(0,1.57,-.182);group.add(visor);
      const legs=[], arms=[];
      for(const side of [-1,1]) {
        const pivot=new THREE.Group();pivot.position.set(side*.125,.79,0);
        const mesh=new THREE.Mesh(legGeo,bootMat);mesh.position.y=-.38;pivot.add(mesh);group.add(pivot);legs.push(pivot);
        const arm=new THREE.Group();arm.position.set(side*.3,1.3,.015);
        const am=new THREE.Mesh(armGeo,coatMat);am.position.y=-.21;arm.add(am);group.add(arm);arms.push(arm);
      }
      const bag=new THREE.Mesh(satchelGeo,beltMat);bag.position.set(.26,.91,.13);group.add(bag);
      const smallLantern=new THREE.Mesh(lanternGeo,lanternMat);smallLantern.position.set(0,-.5,-.03);arms[1].add(smallLantern);
      const capeGeo=own(new THREE.PlaneGeometry(1,1,6,7));
      const cp=capeGeo.attributes.position;
      const rest=new Float32Array(cp.array.length);
      for(let i=0;i<cp.count;i++) {
        const q=1-(cp.getY(i)+.5), x=cp.getX(i)*(.61+.25*q);
        cp.setXYZ(i,x,1.35-q*.81,.13+.19*q); rest[i*3]=x;rest[i*3+1]=1.35-q*.81;rest[i*3+2]=.13+.19*q;
      }
      capeGeo.computeVertexNormals();
      const capeMat=material(['#d7ad52','#8bb7aa','#c58c66','#8399ba','#c2b96d','#91aa77','#b58ca7','#c49672'][index],{side:THREE.DoubleSide});
      const cape=new THREE.Mesh(capeGeo,capeMat);group.add(cape);
      group.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
      const forestModel=new THREE.Group();
      for(const child of [...group.children])forestModel.add(child);
      group.add(forestModel);
      const referenceModel=makeMannequin();group.add(referenceModel.group);
      group.visible=index===0; scene.add(group);
      return {group,torso,legs,arms,cape,capeGeo,rest,forestModel,referenceModel,heading:0};
    }
    for(let i=0;i<8;i++)characters.push(makeCharacter(i));
    const player=characters[0].group;

    // The blade and its short ribbon use the exact world-space sweep that
    // drives the simulation. Geometry is illustrative, not a second force.
    const blade=new THREE.Mesh(own(new THREE.BoxGeometry(.075,.035,1.55)),material('#e8f5df',{metalness:.5,roughness:.25}));
    blade.castShadow=true;blade.visible=false;scene.add(blade);
    const ribbonGeo=own(new THREE.BufferGeometry());
    const ribbonPositions=new Float32Array(24*6*3);
    ribbonGeo.setAttribute('position',new THREE.BufferAttribute(ribbonPositions,3));ribbonGeo.setDrawRange(0,0);
    const ribbon=new THREE.Mesh(ribbonGeo,own(new THREE.MeshBasicMaterial({color:'#b8e8d7',transparent:true,opacity:.28,side:THREE.DoubleSide,depthWrite:false})));
    ribbon.frustumCulled=false;scene.add(ribbon);
    let slashHistory=[];
    function recordSlash(segments,time){
      if(segments.length>=3)slashHistory.push({inner:segments[0],outer:segments[2],time});
      slashHistory=slashHistory.filter(s=>time-s.time<.22).slice(-24);
    }
    function getObstacles(){
      const rocks=environmentMode==='reference'?referenceRockSpecs:rockSpecs;
      // Circular footprints approximate the rocks; small dressing/ruins are
      // deliberately omitted. The obstacle debug view shows the exact mask.
      const result=rocks.filter(s=>Math.abs(s.x)<16&&Math.abs(s.z)<16).map(s=>({x:s.x,z:s.z,radius:.80*Math.max(s.sx,s.sz)}));
      if(course.visible)result.push(...courseSpecs);
      return result;
    }
    function setObstacleCourse(enabled){course.visible=!!enabled;}

    const fireflyCount=38;
    const fireflyGeo=own(new THREE.IcosahedronGeometry(.022,0));
    const fireflyMat=material('#d1eeb4',{emissive:'#a1d486',emissiveIntensity:1.2});
    const fireflies=new THREE.InstancedMesh(fireflyGeo,fireflyMat,fireflyCount);fireflies.frustumCulled=false;forestEnvironment.add(fireflies);
    const fireflyPositions=[];
    for(let i=0;i<fireflyCount;i++)fireflyPositions.push({x:lerp(-15,15,random()),z:lerp(-16,13,random()),y:.8+random()*3,a:random()*6.28});

    function setTerrain(mode) {
      terrainMode=(mode==='flat'||mode===0)?0:1;
      for(let i=0;i<groundPos.count;i++)groundPos.setY(i,terrainHeight(groundPos.getX(i),groundPos.getZ(i)));
      groundPos.needsUpdate=true; groundGeometry.computeVertexNormals();
      placements.forEach(p=>p.write());
      courseMeshes.forEach((p,i)=>p.position.y=terrainHeight(courseSpecs[i].x,courseSpecs[i].z));
      characters.forEach(p=>{p.group.position.y=terrainHeight(p.group.position.x,p.group.position.z);});
    }

    function setEnvironment(mode) {
      environmentMode=mode==='forest'?'forest':'reference';
      const forest=environmentMode==='forest';
      forestEnvironment.visible=forest;referenceEnvironment.visible=!forest;
      ground.material=forest?groundMat:referenceGroundMat;
      characters.forEach(p=>{p.forestModel.visible=forest;p.referenceModel.group.visible=!forest;});
      scene.userData.environment=environmentMode;
    }

    function setLighting(mode) {
      lightingMode=mode;
      const daylight=mode==='day'||mode==='sunrise'||mode==='daylight';
      sunlight.position.set(mode==='reference'?-8:-13,mode==='reference'?14:22,mode==='reference'?10:-7);
      hemisphere.groundColor.set(mode==='reference'?'#35332d':'#1d3028');
      if(mode==='reference') {
        skyUniforms.zenith.value.set('#25292c');skyUniforms.horizon.value.set('#303336');skyUniforms.sunStrength.value=0;
        sunlight.color.set('#fff3d9');sunlight.intensity=2.25;hemisphere.color.set('#e1e1d8');hemisphere.intensity=1.5;
        rimLight.color.set('#e5e2da');rimLight.intensity=.42;scene.fog.color.set('#292d30');scene.fog.density=.032;
        scene.background.set('#292d30');fireflies.visible=false;
      } else if(daylight) {
        skyUniforms.zenith.value.set('#628ba0');skyUniforms.horizon.value.set('#d2dcc2');skyUniforms.sunStrength.value=.8;
        sunlight.color.set('#ffe0a3');sunlight.intensity=3.5; hemisphere.color.set('#d8f3e0');hemisphere.intensity=2.0;
        rimLight.color.set('#b6d7d5');rimLight.intensity=.65;scene.fog.color.set('#a1b9ab');scene.fog.density=.016;
        scene.background.set('#a1b9ab');emissiveMat.emissiveIntensity=.65;lanternMat.emissiveIntensity=.9;fireflies.visible=false;
      } else if(mode==='night'||mode==='moon') {
        skyUniforms.zenith.value.set('#081823');skyUniforms.horizon.value.set('#304958');skyUniforms.sunStrength.value=.13;
        sunlight.color.set('#b2d7e2');sunlight.intensity=1.8;hemisphere.color.set('#73a5b1');hemisphere.intensity=1.25;
        rimLight.color.set('#67bfc0');rimLight.intensity=.8;scene.fog.color.set('#233b46');scene.fog.density=.026;
        scene.background.set('#233b46');emissiveMat.emissiveIntensity=1.8;lanternMat.emissiveIntensity=2.2;fireflies.visible=true;
      } else {
        skyUniforms.zenith.value.set('#243b4b');skyUniforms.horizon.value.set('#8aafa0');skyUniforms.sunStrength.value=.48;
        sunlight.color.set('#ffdfaa');sunlight.intensity=3.0;hemisphere.color.set('#b9e8d9');hemisphere.intensity=1.7;
        rimLight.color.set('#7fcee0');rimLight.intensity=.8;scene.fog.color.set('#5e807e');scene.fog.density=.019;
        scene.background.set('#5e807e');emissiveMat.emissiveIntensity=1.15;lanternMat.emissiveIntensity=1.5;fireflies.visible=true;
      }
    }

    function update(time,dt,actors,settings={}) {
      timeUniform.value=time;
      if(settings.environment&&settings.environment!==environmentMode)setEnvironment(settings.environment);
      if(settings.lighting&&settings.lighting!==lightingMode)setLighting(settings.lighting);
      const nextTerrain=settings.terrain==='flat'?0:1;
      if(settings.terrain!==undefined&&nextTerrain!==terrainMode)setTerrain(settings.terrain);
      setObstacleCourse(settings.obstacleCourse);
      const first=actors[0],slashing=first&&first.slashAge<.42;
      blade.visible=!!slashing;
      if(slashing){const angle=first.slashAngle??first.heading??0;blade.rotation.y=angle;blade.position.set(first.x-Math.sin(angle)*1.2,terrainHeight(first.x,first.z)+(first.jump||0)+.84,first.z-Math.cos(angle)*1.2);}
      slashHistory=slashHistory.filter(s=>time>=s.time&&time-s.time<.22);
      let ri=0;
      for(const s of slashHistory){
        const a=s.inner,b=s.outer,y=terrainHeight((b.x0+b.x1)*.5,(b.z0+b.z1)*.5)+b.y;
        for(const p of [[a.x0,a.z0],[b.x0,b.z0],[b.x1,b.z1],[a.x0,a.z0],[b.x1,b.z1],[a.x1,a.z1]]){ribbonPositions[ri++]=p[0];ribbonPositions[ri++]=y;ribbonPositions[ri++]=p[1];}
      }
      ribbonGeo.attributes.position.needsUpdate=true;ribbonGeo.setDrawRange(0,ri/3);ribbon.visible=ri>0;
      characters.forEach((p,i)=>{
        const a=actors[i];p.group.visible=!!a;if(!a)return;
        const speed=Math.hypot(a.vx||0,a.vz||0);
        const jump=Number.isFinite(a.jump)?a.jump:(Number.isFinite(a.yOffset)?a.yOffset:0);
        p.group.position.set(a.x,terrainHeight(a.x,a.z)+jump,a.z);
        if(speed>.035) {
          const heading=Math.atan2(-(a.vx||0),-(a.vz||0));
          let delta=((heading-p.heading+Math.PI*3)%(Math.PI*2))-Math.PI;
          p.heading+=delta*Math.min(1,dt*13);
        }
        p.group.rotation.y=p.heading;
        const phase=time*(speed>3?12:8.5)+i*.9, walk=Math.min(speed/2.3,1);
        if(environmentMode==='reference'){
          const r=p.referenceModel, swing=a.slashAge<.42?Math.sin(a.slashAge/.42*Math.PI):clamp(jump/.8,0,1)*.35;
          for(let side=0;side<2;side++){
            const gait=Math.sin(phase+side*Math.PI);
            r.legs[side].rotation.x=gait*.60*walk;
            r.knees[side].rotation.x=-.08-Math.max(0,-gait)*.72*walk;
            r.arms[side].rotation.x=-gait*.48*walk-swing*(side===1?2.35:.65);
            r.arms[side].rotation.z=(side===0?.08:-.08)+swing*(side===1?-.9:.72);
            r.elbows[side].rotation.x=-.20-.15*walk-swing*(side===1?.75:.2);
          }
          r.torso.rotation.y=Math.sin(phase)*.06*walk-swing*.45;
          r.torso.rotation.z=Math.sin(phase)*.015*walk;
          r.group.position.y=Math.pow(Math.sin(phase),2)*.012*walk;
        }else{
          p.legs[0].rotation.x=Math.sin(phase)*.47*walk;p.legs[1].rotation.x=-Math.sin(phase)*.47*walk;
          p.arms[0].rotation.x=-Math.sin(phase)*.32*walk;p.arms[1].rotation.x=Math.sin(phase)*.32*walk;
          p.torso.rotation.z=Math.sin(phase)*.022*walk;
          const cp=p.capeGeo.attributes.position;
          for(let j=0;j<cp.count;j++) {
            const x=p.rest[j*3],y=p.rest[j*3+1],z=p.rest[j*3+2], q=(1.35-y)/.81;
            cp.setXYZ(j,x+Math.sin(time*3.4+x*4+i)*.022*q,y,z+Math.sin(time*4.5+x*5+q*2+i)*.055*q+walk*q*q*.16);
          }
          cp.needsUpdate=true;p.capeGeo.computeVertexNormals();
        }
      });
      beacon.position.y=terrainHeight(archX,archZ)+3.45+Math.sin(time*.8)*.1;
      crystal.rotation.y=time*.35;ring.rotation.z=Math.sin(time*.3)*.12;
      if(forestEnvironment.visible&&fireflies.visible) {
        fireflyPositions.forEach((p,i)=>{
          dummy.position.set(p.x+Math.sin(time*.23+p.a)*.5,terrainHeight(p.x,p.z)+p.y+Math.sin(time*.4+p.a)*.3,p.z+Math.cos(time*.18+p.a)*.6);
          dummy.rotation.set(0,0,0);dummy.scale.setScalar(.55+.45*Math.pow(Math.sin(time*1.1+p.a),2));dummy.updateMatrix();fireflies.setMatrixAt(i,dummy.matrix);
        });fireflies.instanceMatrix.needsUpdate=true;
      }
    }

    setEnvironment('reference');setLighting('reference');
    update(0,1/60,[{x:0,z:2,vx:0,vz:0}],{});
    return {
      scene,player,terrainHeight,terrainGLSL,update,setTerrain,setLighting,setEnvironment,getObstacles,setObstacleCourse,recordSlash,
      cameraHint:{position:[8.5,7.9,12.5],target:[5.05,1.6,3.76]},
      dispose(){disposables.forEach(x=>x.dispose&&x.dispose());scene.clear();}
    };
  };
})();
