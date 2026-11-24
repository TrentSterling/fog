"""Third refinement: physical-height volume detail with ray-footprint filtering."""
from pathlib import Path
import argparse,shutil,json
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--out',type=Path,required=True)
work=p.parse_args().out.resolve()
base=work/'baseline-src'
s=(work/'candidates/volume/src/fog.js').read_text()
s=s.replace('float wispNoise(vec2 p,vec4 field,float level){','float wispNoise(vec2 p,vec4 field,float worldY){')
s=s.replace('level*uHeight*2.35*uHeightShear','worldY*2.35*uHeightShear')
s=s.replace('float densityDetail(vec2 p,vec4 field,float level,float n){','float densityDetail(vec2 p,vec4 field,float level,float n,float worldY,float footprint){')
s=s.replace('float fine=wispNoise(p,field,level);','float resolved=1.0-smoothstep(0.18,0.42,footprint);\n      float fine=mix(0.5,wispNoise(p,field,worldY),resolved);')
s=s.replace('densityDetail(vWarp,vField,vLevel,n)','densityDetail(vWarp,vField,vLevel,n,vWorld.y,0.0)')
s=s.replace('densityDetail(p.xz,f,h,n)','densityDetail(p.xz,f,h,n,p.y,dt)')
s=s.replace('densityDetail(p.xz+towardsLight,vec4(f.xy,occludingDensity,f.a),h+0.15,lightDetail)','detailDensity(lightDetail)')
s=s.replace('float height=max(0.02,top-ground);','if(f.b>0.0&&p.y<top){\n          float height=max(0.02,top-ground);')
s=s.replace('accum+=trans*a*color;trans*=1.0-a;','accum+=trans*a*color;trans*=1.0-a;\n          }')
for name,settings in [('physical',{}),('airy',{'density':1.10})]:
 dest=work/'candidates'/name
 shutil.copytree(base/'src',dest/'src',dirs_exist_ok=True)
 if not (dest/'vendor').exists(): (dest/'vendor').symlink_to(base/'vendor',target_is_directory=True)
 (dest/'src/fog.js').write_text(s)
 config={'defaults':{'mode':'fluid','render':'raymarch','ticks':[180], 'shots':[{'id':'follow'},{'id':'grazing','camera':{'phi':1.36,'distance':13}}]},'variants':[{'id':name,'settings':settings}]}
 (work/(name+'.json')).write_text(json.dumps(config,indent=2)+'\n')
print('Wrote physical-height and airier-density captures.')
