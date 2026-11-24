from pathlib import Path
import shutil, json, argparse, subprocess, tarfile, io

REPO=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description='Recreate the first controlled wisp shader experiment from its pinned baseline.')
parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args()
WORK=args.out.resolve()
BASE=WORK/'baseline-src'
BASE.mkdir(parents=True,exist_ok=True)
archive=subprocess.check_output(['git','archive','9702cfed3e3d0e9dd66f723c183ffad8be97844c','src','vendor'],cwd=REPO)
with tarfile.open(fileobj=io.BytesIO(archive)) as tar: tar.extractall(BASE,filter='data')
original=(BASE/'src/fog.js').read_text()

helper='''
    // A renderer-only ribbon band. The field still controls all occupied fog.
    // Its longer axis follows prevailing wind, while local velocity carries
    // both phases together. No high-frequency albedo/brightness modulation.
    float wispNoise(vec2 p,vec4 field,float level){
      vec2 drift=vec2(0.35,0.13)*uWind*uTime*0.07;
      vec2 flow=(texture2D(uNoise,p*0.045+drift*0.02).ba*2.0-1.0)
        *(0.62+min(uSwirl,1.5)*0.33);
      flow+=clamp(field.xy,vec2(-5.0),vec2(5.0))*0.333;
      float phase=fract(uTime*0.17);
      float shear=uDensityProfile==0?uHeightShear:0.0;
      vec2 q=p+drift+vec2(level*0.24,-level*0.30)*shear;
      mat2 ribbon=mat2(0.185,-0.139,0.069,0.375);
      float a=texture2D(uNoise,ribbon*(q-flow*phase)+vec2(0.23,0.67)).g;
      float b=texture2D(uNoise,ribbon*(q-flow*fract(phase+0.5))+vec2(0.23,0.67)).g;
      return clamp((mix(a,b,abs(phase*2.0-1.0))-0.5)*1.8+0.5,0.0,1.0);
    }
'''

formulas={
 'fine':'''float fine=wispNoise(p,field,level);
      return detailDensity(n)*(1.0+(fine-0.5)*1.25*uDetailStrength);''',
 'erosion':'''float fine=wispNoise(p,field,level);
      float fold=mix(n,fine,0.62);
      float edge=max(smoothstep(0.12,0.80,level),1.0-smoothstep(0.18,0.90,field.b));
      float erosion=0.10+1.55*smoothstep(0.26,0.72,fold);
      return detailDensity(n)*mix(1.0,erosion,clamp((0.35+0.60*edge)*uDetailStrength,0.0,1.0));''',
 'aggressive':'''float fine=wispNoise(p,field,level);
      float fold=mix(n,fine,0.75);
      float erosion=0.015+1.95*smoothstep(0.38,0.72,fold);
      return detailDensity(n)*mix(1.0,erosion,clamp(uDetailStrength,0.0,1.0));'''
}
for name,formula in formulas.items():
    dest=WORK/'candidates'/name
    shutil.copytree(BASE/'src',dest/'src',dirs_exist_ok=True)
    if not (dest/'vendor').exists(): (dest/'vendor').symlink_to(BASE/'vendor',target_is_directory=True)
    code=original
    marker='    float fogTop(vec2 p,vec4 field){'
    density='''
    float densityDetail(vec2 p,vec4 field,float level,float n){
      if(uDetailStrength<=0.0)return 1.0;
      '''+formula+'''
    }
'''
    code=code.replace(marker,helper+density+marker)
    code=code.replace('max(0.0,vField.b)*detailDensity(n)','max(0.0,vField.b)*densityDetail(vWarp,vField,vLevel,n)')
    code=code.replace('max(0.0,f.b)*detailDensity(n)','max(0.0,f.b)*densityDetail(p.xz,f,h,n)')
    code=code.replace('occludingDensity*=detailDensity(lightDetail);','occludingDensity*=densityDetail(p.xz+towardsLight,vec4(f.xy,occludingDensity,f.a),h+0.15,lightDetail);')
    (dest/'src/fog.js').write_text(code)

config={'defaults':{'mode':'fluid','render':'raymarch','ticks':[180], 'shots':[{'id':'follow'},{'id':'grazing','camera':{'phi':1.36,'distance':13}}]},'variants':[{'id':'control'},{'id':'params','settings':{'density':1.05,'detailStrength':1.35,'heightShear':1.2}}]}
(WORK/'controls.json').write_text(json.dumps(config,indent=2)+'\n')
for name in formulas:
    config['variants']=[{'id':name}]
    (WORK/(name+'.json')).write_text(json.dumps(config,indent=2)+'\n')
print('Wrote three shader candidates and controlled capture recipes.')
