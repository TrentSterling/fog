"""Final controlled refinement: filter atlas samples along the ray footprint."""
from pathlib import Path
import argparse,shutil,json
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--out',type=Path,required=True)
work=p.parse_args().out.resolve();base=work/'baseline-src'
s=(work/'candidates/physical/src/fog.js').read_text()
s=s.replace('float wispNoise(vec2 p,vec4 field,float worldY){','float wispNoise(vec2 p,vec4 field,float worldY,float lod){')
s=s.replace('worldY*2.35*uHeightShear','worldY*4.0*uHeightShear')
s=s.replace('texture2D(uNoise,q+slice*stride+vec2(0.23,0.67)).g','textureLod(uNoise,q+slice*stride+vec2(0.23,0.67),lod).g')
s=s.replace('texture2D(uNoise,q+(slice+1.0)*stride+vec2(0.23,0.67)).g','textureLod(uNoise,q+(slice+1.0)*stride+vec2(0.23,0.67),lod).g')
s=s.replace('float resolved=1.0-smoothstep(0.18,0.42,footprint);\n      float fine=mix(0.5,wispNoise(p,field,worldY),resolved);','float lod=max(0.0,log2(max(1.0,footprint*0.27*256.0*0.65)));\n      float fine=wispNoise(p,field,worldY,lod);')
s=s.replace('densityDetail(vWarp,vField,vLevel,n,vWorld.y,0.0)','densityDetail(vWarp,vField,vLevel,n,vWorld.y,max(length(dFdx(vWorld)),length(dFdy(vWorld))))')
variants={'filtered-warped':s.replace('worldY*4.0*uHeightShear','(worldY*4.0+dot(curl,vec2(0.65,0.35)))*uHeightShear'),'filtered':s,'filtered-soft':s.replace('mix(n,fine,0.62)','mix(n,fine,0.48)').replace('0.10+1.55*smoothstep(0.26,0.72,fold)','0.20+1.35*smoothstep(0.20,0.72,fold)')}
for name,code in variants.items():
 dest=work/'candidates'/name
 shutil.copytree(base/'src',dest/'src',dirs_exist_ok=True)
 if not (dest/'vendor').exists(): (dest/'vendor').symlink_to(base/'vendor',target_is_directory=True)
 (dest/'src/fog.js').write_text(code)
 config={'width':1280,'height':720,'defaults':{'mode':'fluid','render':'raymarch','ticks':[180], 'shots':[{'id':'follow'},{'id':'grazing','camera':{'phi':1.36,'distance':13}}]},'variants':[{'id':name}]}
 (work/(name+'.json')).write_text(json.dumps(config,indent=2)+'\n')
print('Wrote two explicit-LOD refinement candidates.')
