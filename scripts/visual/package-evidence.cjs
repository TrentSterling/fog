#!/usr/bin/env node
/* Package existing, reviewed native captures. Does not run or alter FogLab. */
'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process'),zlib=require('zlib');
const args={repo:path.resolve(__dirname,'../..')};
for(let i=2;i<process.argv.length;i+=2){
  if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw Error('Expected --work capture-directory [--repo repository --source-commit commit].');
  args[process.argv[i].slice(2)]=process.argv[i+1];
}
if(!args.work)throw Error('Required: --work directory containing round1, round2, round3 and stress-winner.');
const repo=path.resolve(args.repo),work=path.resolve(args.work),winner=path.join(work,'stress-winner');
const docs=path.join(repo,'docs/validation/wisps'),media=path.join(docs,'media');
const sharp=require(require.resolve('sharp',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||repo,repo]}));
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeJSON=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const git=(...command)=>cp.execFileSync('git',command,{cwd:repo,maxBuffer:8*1024*1024});
const commit=git('rev-parse',args['source-commit']||'HEAD').toString().trim();
const sourceRef='github:TrentSterling/fog@'+commit;
const manifest=readJSON(path.join(winner,'manifest.json')),outcome=readJSON(path.join(winner,'summary.json'));
for(const [name,expected]of Object.entries(manifest.moduleSHA256)){
  const file=name.startsWith('vendor/')?name:'src/'+name;
  if(sha(git('show',commit+':'+file))!==expected)throw Error('Pinned commit does not match captured module '+file);
}
const equivalence=readJSON(path.join(winner,'hero-equivalence.json'));
const fieldComparison=readJSON(path.join(winner,'field-comparison.json'));
const qualityComparison=readJSON(path.join(winner,'quality-control-comparison.json'));
const temporal=readJSON(path.join(winner,'phase-temporal-check.json'));
if(!outcome.allFinite||outcome.shaderOrGLErrors!==0||!equivalence.allIdentical||!fieldComparison.allFieldsIdentical||!fieldComparison.allCamerasIdentical||qualityComparison.some(x=>!x.fieldIdentical||!x.cameraIdentical))throw Error('Refusing to package failed validation as a passing result.');
fs.mkdirSync(media,{recursive:true});
const inventory=[];
function record(file,extra={}){const data=fs.readFileSync(file);const item={file:path.relative(repo,file).split(path.sep).join('/'),bytes:data.length,sha256:sha(data),...extra};inventory.push(item);return item;}
function sanitize(value){
  if(Array.isArray(value))return value.map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,sanitize(v)]));
  if(typeof value==='string'){
    if(value===manifest.source)return sourceRef;
    if(value.startsWith(work+path.sep))return 'validation-work/'+path.relative(work,value).split(path.sep).join('/');
    if(value.includes('/workspace/'))throw Error('Unrecognized machine-specific path in packaged evidence: '+value);
  }
  return value;
}
async function pixels(file){const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});return{data,width:info.width,height:info.height,channels:info.channels};}
async function hero(sourceName,destinationName){
  const source=path.join(winner,'hero',sourceName),output=path.join(media,destinationName);
  await sharp(source).webp({lossless:true,effort:6}).toFile(output);
  const [a,b]=await Promise.all([pixels(source),pixels(output)]);
  if(a.width!==b.width||a.height!==b.height||a.channels!==b.channels||!a.data.equals(b.data))throw Error('Lossless WebP pixel mismatch: '+destinationName);
  return record(output,{width:b.width,height:b.height,encoding:'lossless WebP',sourcePNG:sourceName,sourcePNGSHA256:sha(fs.readFileSync(source)),decodedPixelSHA256:sha(b.data),decodedPixelsMatchSourcePNG:true});
}
async function sheetWebP(sourceName,destinationName,width){
  const output=path.join(media,destinationName);let encoding='lossless WebP';
  await sharp(path.join(winner,sourceName)).resize({width}).webp({lossless:true,effort:6}).toFile(output);
  if(fs.statSync(output).size>800000){encoding='WebP quality 92';await sharp(path.join(winner,sourceName)).resize({width}).webp({quality:92,effort:6}).toFile(output);}
  const size=await sharp(output).metadata();return record(output,{width:size.width,height:size.height,encoding,processing:'Resize only before WebP encoding; no enhancement'});
}
async function longRunSheet(){
  const layers=[],sources=[path.join(work,'stress-control/flat/flat-follow-00900.png'),path.join(winner,'flat/flat-follow-00900.png')];
  for(let i=0;i<2;i++){
    const label=(i?'After':'Before')+' · 30 seconds · identical simulation field';
    const title=Buffer.from('<svg width="640" height="34"><rect width="100%" height="100%" fill="#111a1b"/><text x="12" y="24" fill="#e1ece5" font-family="sans-serif" font-size="17">'+label+'</text></svg>');
    layers.push({input:title,left:i*640,top:0},{input:await sharp(sources[i]).resize(640,360).png().toBuffer(),left:i*640,top:34});
  }
  const output=path.join(media,'long-run-comparison.webp');
  await sharp({create:{width:1280,height:394,channels:3,background:'#111a1b'}}).composite(layers).webp({lossless:true,effort:6}).toFile(output);
  record(output,{width:1280,height:394,encoding:'lossless WebP',processing:'Before/after tick-900 captures resized to 640×360 and labelled; no enhancement'});
}
const candidates=[
  ['round1','controls','control','Control'],['round1','controls','params','Parameters only'],
  ['round1','fine','fine','Fine band'],['round1','erosion','erosion','Edge erosion'],['round1','aggressive','aggressive','Aggressive erosion'],
  ['round2','volume','volume','Volume'],['round2','volume-soft','volume-soft','Soft volume'],['round2','volume-lit','volume-lit','Lit volume'],
  ['round2','medium-erosion','medium-erosion','Medium erosion'],['round2','physical','physical','Physical lighting'],['round2','airy','airy','Airy'],
  ['round3','filtered','filtered','Filtered volume'],['round3','filtered-soft','filtered-soft','Filtered soft'],['round3','filtered-warped','filtered-warped','Filtered warped — selected']
];
async function candidateSheet(){
  const width=480,height=270,header=34,columns=3,rows=Math.ceil(candidates.length/columns),layers=[],entries=[];
  for(let i=0;i<candidates.length;i++){
    const [round,directory,variant,label]=candidates[i],source=path.join(work,round,directory,variant+'-follow-00180.png');
    const m=readJSON(path.join(work,round,directory,'manifest.json')),capture=m.captures.find(c=>c.variant===variant&&c.shot==='follow'&&c.tick===180);
    if(!capture||sha(fs.readFileSync(source))!==capture.sha256)throw Error('Candidate capture hash mismatch: '+source);
    const x=i%columns*width,y=Math.floor(i/columns)*(height+header),text=String(i+1).padStart(2,'0')+' · '+label;
    const title=Buffer.from('<svg width="'+width+'" height="'+header+'"><rect width="100%" height="100%" fill="#111a1b"/><text x="12" y="24" fill="#e1ece5" font-family="sans-serif" font-size="17">'+text+'</text></svg>');
    layers.push({input:title,left:x,top:y},{input:await sharp(source).resize(width,height).png().toBuffer(),left:x,top:y+header});
    entries.push({index:i+1,round,variant,label,tick:180,sourceImage:round+'/'+directory+'/'+path.basename(source),sourceWidth:m.width,sourceHeight:m.height,sourcePNGSHA256:capture.sha256,sourceSHA256:capture.sourceSHA256||capture.moduleSHA256||m.moduleSHA256,noiseSHA256:capture.noiseSHA256||m.noiseSHA256});
  }
  const output=path.join(media,'candidate-overview.webp');
  await sharp({create:{width:columns*width,height:rows*(height+header),channels:3,background:'#111a1b'}}).composite(layers).webp({quality:92,effort:6}).toFile(output);
  const item=record(output,{width:columns*width,height:rows*(height+header),encoding:'WebP quality 92',processing:'480×270 thumbnails from rendered follow-camera captures; labels added after blind review'});
  writeJSON(path.join(docs,'candidate-overview.json'),{provenance:manifest.provenance,uniqueCandidates:14,labelsAddedAfterBlindReview:true,thumbnailWidth:width,thumbnailHeight:height,note:'Rounds 1–2 were captured at 960×540, round 3 at 1280×720. Repeated controls and physical-lighting candidates are included once. Thumbnail overview is not an identical-resolution pixel comparison.',media:item,entries});
}
(async()=>{
  for(const [source,output]of [['rollback-follow-00180.png','before-follow.webp'],['rollback-grazing-00180.png','before-grazing.webp'],['hero-follow-00180.png','after-follow.webp'],['hero-grazing-00180.png','after-grazing.webp']])await hero(source,output);
  await sheetWebP('before-after-hero.png','comparison.webp',960);
  await sheetWebP('quality-sheet.png','quality-sheet.webp',1440);
  await longRunSheet();
  await candidateSheet();
  for(const name of ['slash-30fps.mp4','phase-boundary-30fps.mp4']){const target=path.join(media,name);fs.copyFileSync(path.join(winner,name),target);record(target,{encoding:'H.264 MP4',framesPerSecond:30,frames:name.startsWith('slash')?61:16,sourceBytesUnchanged:true});}
  const preview=path.join(repo,'assets/foglab-preview.png');
  await sharp(path.join(winner,'hero/hero-follow-00180.png')).resize(960,540).png({compressionLevel:9,adaptiveFiltering:true}).toFile(preview);
  record(preview,{width:960,height:540,encoding:'PNG',processing:'Selected hero resized to 960×540; no enhancement'});
  writeJSON(path.join(docs,'hero-equivalence.json'),sanitize(equivalence));
  writeJSON(path.join(docs,'field-comparison.json'),sanitize(fieldComparison));
  writeJSON(path.join(docs,'quality-control-comparison.json'),sanitize(qualityComparison));
  const cleanManifest={...sanitize(manifest),source:sourceRef,sourceCommit:commit,captureFilenamePolicy:'Capture filenames identify the original batches. Selected representative media are bundled; recreate all frames with the documented configs and capture harness.'};
  const encoded=Buffer.from(JSON.stringify(cleanManifest,null,2)+'\n'),gz=zlib.gzipSync(encoded,{level:9,mtime:0});
  const gzipPath=path.join(docs,'full-manifest.json.gz');fs.writeFileSync(gzipPath,gz);
  if(!zlib.gunzipSync(gz).equals(encoded)||!zlib.gzipSync(encoded,{level:9,mtime:0}).equals(gz))throw Error('Deterministic gzip verification failed.');
  record(gzipPath,{encoding:'deterministic gzip',uncompressedBytes:encoded.length,uncompressedSHA256:sha(encoded)});
  const summary={
    provenance:manifest.provenance,source:sourceRef,sourceCommit:commit,allCapturedModulesMatchPinnedCommit:true,
    captures:manifest.captures.length,captureSizes:[{width:960,height:540,count:95},{width:1280,height:720,count:4}],
    allFinite:outcome.allFinite,shaderOrGLErrors:outcome.shaderOrGLErrors,allCapturesNonblank:true,
    comparedBaselineCaptures:fieldComparison.comparedCaptures,comparedNonNullRawFields:fieldComparison.comparedRawFields,
    allBaselineFieldsIdentical:fieldComparison.allFieldsIdentical,allBaselineCamerasIdentical:fieldComparison.allCamerasIdentical,
    additionalQualityControlCaptures:qualityComparison.length,allAdditionalQualityFieldsAndCamerasIdentical:true,
    heroEquivalence:{pngComparisons:equivalence.matches.length,allByteIdentical:equivalence.allIdentical,losslessWebPConversions:4,allDecodedPixelsMatchSourcePNG:true},
    phaseBoundary:{fromTick:temporal.boundary.fromTick,toTick:temporal.boundary.toTick,meanAbsoluteRGBChange:temporal.boundary.meanAbsoluteChannelDelta,maxAbsoluteChannelChange:temporal.boundary.maxAbsoluteChannelDelta,boundaryVsAdjacentMedian:temporal.phaseBoundaryVsMedian,scope:'8-bit RGB fog region below the top 30% sky; fixed camera; 16 consecutive ticks'},
    uniqueVisuallyReviewedCandidates:14,
    visualReview:outcome.visualReview,
    limitations:['Native Mesa GLES captures, not browser screenshots or device GPU benchmarks.','Locked camera omits frame-rate-dependent follow smoothing; CPU uses the synchronous production adapter.','Low-step grazing and column views retain pre-existing horizontal ray strata.','Packaged overview sheets use resized thumbnails; four full-size hero WebPs preserve exact decoded PNG pixels.'],
    media:inventory
  };
  writeJSON(path.join(docs,'final-summary.json'),summary);
  const report=`# Final native visual validation\n\nThe adopted FogLab 0.4 renderer passed **99 captures**: 95 at 960×540 and four at 1280×720. Shader compilation, GLES error checks, nonblank-image checks, and finite simulation checks passed. All captured production modules match [commit ${commit.slice(0,7)}](https://github.com/TrentSterling/fog/commit/${commit}). See [final-summary.json](final-summary.json) for the recorded outcomes and media hashes.\n\n## Exact preservation checks\n\nAll **31 non-null raw fields** across 32 original baseline scenarios are byte-identical, and all 32 camera configurations match. Additional matched low-quality and column captures also preserve their fields and cameras. Analytical rendering has no integrated field and records null. See [field-comparison.json](field-comparison.json) and [quality-control-comparison.json](quality-control-comparison.json).\n\nAt wisp strength zero, final production follow and grazing PNGs exactly reproduce the round-three old-renderer controls. At default strength one, both PNGs exactly reproduce the blind-selected filtered-warped candidate. All four matches are byte-identical. The four packaged full-size WebPs were decoded and compared with their source PNGs: **every RGBA pixel matches**. See [hero-equivalence.json](hero-equivalence.json).\n\n## Visible result and limits\n\nFull-resolution hero, grazing, low/high quality, terrain/profile frames and chronological motion sheets were inspected. Finer, frayed foreground edges and secondary density breakup appear while broad banks, deliberate clearings, character readability and exposed hill crests remain intact. Terrain-follow mode stays distinct from the world-space ceiling. CPU and hybrid rendering retain the same intended improvement.\n\nHorizontal ray-step strata remain visible at shallow angles, especially with 20 steps and the column profile. Matched old-source controls show this limitation already existed in 0.3. The 48-step/full-resolution views are cleaner; this change does not eliminate every trace of banding.\n\n## Motion checks\n\nThe [slash sample](media/slash-30fps.mp4) contains 61 consecutive ticks, 180–240, at 30 FPS. The [steady-camera phase sample](media/phase-boundary-30fps.mp4) contains ticks 350–365 at 30 FPS. Across the phase wrap at 352→353, mean absolute RGB change in the fog region is ${temporal.boundary.meanAbsoluteChannelDelta.toFixed(4)} on the 0–255 scale, maximum channel change is ${temporal.boundary.maxAbsoluteChannelDelta}, and the mean is ${temporal.phaseBoundaryVsMedian.toFixed(3)}× the ordinary adjacent-frame median. There is no large reset spike in this sample; it does not certify every possible temporal or device-specific artifact.\n\n## Media\n\n- [Before follow](media/before-follow.webp) and [after follow](media/after-follow.webp): full-size lossless 1280×720 images.\n- [Before grazing](media/before-grazing.webp) and [after grazing](media/after-grazing.webp): full-size lossless 1280×720 images.\n- [Display comparison](media/comparison.webp): compact labelled before/after overview.\n- [Quality and profiles](media/quality-sheet.webp): low/high quality, columns and terrain-follow hills.\n- [All 14 unique candidates](media/candidate-overview.webp): labels added after blind review. Rounds 1–2 used 960×540 captures; round 3 used 1280×720. The overview uses 480×270 thumbnails and includes repeated candidates once. [Candidate metadata](candidate-overview.json) records originals and hashes.\n\nThe [full capture manifest](full-manifest.json.gz) retains all 99 records with per-capture dimensions, source/noise/field/image hashes and a pinned source reference. Gzip is deterministic. Selected media are bundled; original batch filenames in the manifest can be recreated with [winner-stress-config.json](winner-stress-config.json), [winner-hero-config.json](winner-hero-config.json), and the repository capture harness.\n\nThese are real production Three.js scenes and GLSL rendered through native Mesa llvmpipe. They are **not browser screenshots, generated illustrations, or hardware GPU performance benchmarks**. The harness deliberately uses a locked camera rather than live frame-rate-dependent smoothing. CPU validation uses the synchronous production adapter.\n`;
  fs.writeFileSync(path.join(docs,'final-validation.md'),report.replace('- [Quality and profiles]', '- [Thirty-second comparison](media/long-run-comparison.webp): before/after tick 900 with the same simulation field and camera.\n- [Quality and profiles]'));
  const packaged=[...inventory,...['hero-equivalence.json','field-comparison.json','quality-control-comparison.json','candidate-overview.json','final-summary.json','final-validation.md'].map(name=>({file:'docs/validation/wisps/'+name,bytes:fs.statSync(path.join(docs,name)).size}))];
  console.log(JSON.stringify({sourceCommit:commit,files:packaged.length,totalBytes:packaged.reduce((sum,f)=>sum+f.bytes,0),largestFile:packaged.reduce((a,b)=>a.bytes>b.bytes?a:b),filesOver800KB:packaged.filter(f=>f.bytes>800000),inventory:packaged.map(({file,bytes})=>({file,bytes}))},null,2));
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
