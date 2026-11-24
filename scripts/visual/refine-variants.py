"""Second visual round: replace extruded detail with interpolated volume slices.
Run make-variants.py --out DIRECTORY first; this command uses the same directory.
"""
from pathlib import Path
import argparse, shutil, json
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out',type=Path,required=True)
work=parser.parse_args().out.resolve()
base=work/'baseline-src'
template=(work/'candidates/erosion/src/fog.js').read_text()
begin=template.index('    // A renderer-only ribbon band.')
end=template.index('    float densityDetail',begin)
volume='''    // Two independently offset atlas slices interpolate a shallow 3D band.
    // A flat pattern sheared through height produces density curtains instead.
    float wispNoise(vec2 p,vec4 field,float level){
      vec2 drift=vec2(0.35,0.13)*uWind*uTime*0.07;
      vec2 curl=(texture2D(uNoise,p*0.085+drift*0.03).ba*2.0-1.0);
      vec2 q=(p+drift+curl*0.55+clamp(field.xy,vec2(-5.0),vec2(5.0))*0.16)*0.27;
      float vertical=uDensityProfile==0?level*uHeight*2.35*uHeightShear:0.0;
      float slice=floor(vertical),blend=fract(vertical);
      blend=blend*blend*(3.0-2.0*blend);
      vec2 stride=vec2(0.317,0.613);
      float a=texture2D(uNoise,q+slice*stride+vec2(0.23,0.67)).g;
      float b=texture2D(uNoise,q+(slice+1.0)*stride+vec2(0.23,0.67)).g;
      return clamp((mix(a,b,blend)-0.5)*1.85+0.5,0.0,1.0);
    }
'''
source=template[:begin]+volume+template[end:]
variants={
 'volume':source,
 'volume-lit':source.replace('max(top-p.y,0.0)*0.38','max(top-p.y,0.0)*0.65'),
 'volume-soft':source.replace('mix(n,fine,0.62)','mix(n,fine,0.48)').replace('0.10+1.55*smoothstep(0.26,0.72,fold)','0.20+1.35*smoothstep(0.20,0.72,fold)'),
 'medium-erosion':template.replace('float fine=wispNoise(p,field,level);','float fine=n;').replace('0.10+1.55*smoothstep(0.26,0.72,fold)','0.10+1.55*smoothstep(0.26,0.72,fold)')
}
for name,code in variants.items():
 dest=work/'candidates'/name
 shutil.copytree(base/'src',dest/'src',dirs_exist_ok=True)
 if not (dest/'vendor').exists(): (dest/'vendor').symlink_to(base/'vendor',target_is_directory=True)
 (dest/'src/fog.js').write_text(code)
 config={'defaults':{'mode':'fluid','render':'raymarch','ticks':[180], 'shots':[{'id':'follow'},{'id':'grazing','camera':{'phi':1.36,'distance':13}}]},'variants':[{'id':name}]}
 (work/(name+'.json')).write_text(json.dumps(config,indent=2)+'\n')
print('Wrote four controlled second-round variants.')
