# Wisp source audit

Date: 2026-11-24. This is a source/history audit and visual hypothesis, written before the new variant renders were judged. It does not report a rendering benchmark or a winning variant.

## Source identity

The release inspected was `9702cfed3e3d0e9dd66f723c183ffad8be97844c` (main, deployment changes over v0.3.0). Historical comparisons used these exact commits:

| Snapshot | Commit | `src/fog.js` Git blob |
| --- | --- | --- |
| v0.1.0 | `73331345e73e6ba4bb0a7b48cf019ba75437b32a` | `ca3904ca965f773959a16c0eb20de69b1ed2b0bb` |
| v0.2.0 | `b2380681afaaf56bc2173dbe6c721ee88631994c` | `88635671a7c7928aceae75cc65dfe5734d32eb08` |
| v0.3.0 | `dba352ce26f4635d089894169aac9b7aaf28993a` | `88635671a7c7928aceae75cc65dfe5734d32eb08` |

Two preserved pre-release prototypes were also inspected. These are filesystem snapshots, not identified release commits. Their SHA-256 hashes make the evidence distinguishable:

| Preserved source | SHA-256 |
| --- | --- |
| `foglab/baseline-v1/fog.js` | `cb5f071fa8db184d06b7861fdee1d02a758e1490ee2c7f28d4d9dc82ca21e7de` |
| `foglab/baseline-v1/app.js` | `17463a5af3ee895a8795635575dec899d64a98024e945b544d16ee0f84c03c0e` |
| `foglab/fog.js` | `23dacfb52348767476d09fee8a0d9ed6a1b88b5af6e6c398ff802c1f477d07e1` |

The snapshot root was `/workspace/scratch/38bb7867aec9/`. The final pre-release `foglab/fog.js` already has the broad-bank/medium-billow recipe used by v0.1.0. The sharper fine band described below belongs to `baseline-v1`, not to the v0.2 or v0.3 release.

## Findings

**The reported softness is plausible, but the evidence does not identify a v0.3 shader regression.** The v0.2 and v0.3 fog shader blobs are identical. Their noise-atlas recipe is unchanged; the only addition to the default settings is the CPU execution selector. The v0.1-to-v0.2 renderer diff adds selectable profiles, obstacles and controls, while preserving the default medium-noise and density-modulation formulas.

The earlier prototype had a separate fine band that was removed during the broad-bank revision:

| Evidence | Earlier `baseline-v1` | Release inspected |
| --- | --- | --- |
| Noise atlas | `app.js:42–43`: R periods 7/15/29, G periods 19/41/73 | [`src/app.js:69–83`](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/app.js#L69-L83): R periods 4/9/17, G periods 8/17/31 |
| Renderer sampling | `fog.js:50–60`: broad R plus a separate G sample at `p * 0.31`, weighted 0.25 | [`src/fog.js:102–118`](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/fog.js#L102-L118): two flow phases of G at `p * 0.135`, without an independent finer band |
| Density shaping | Raymarch used `smoothstep(0.16, 0.76, n)` | [`src/fog.js:118`](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/fog.js#L118): `1 + (n - 0.5) * 0.64 * detailStrength` |
| Lighting | `fog.js:62–63`: noise directly affected brightness | [`src/fog.js:166–169`](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/fog.js#L166-L169): elevation lighting deliberately avoids bright noise flecks |

Ignoring warping and higher octaves, the old fine band's dominant cell spacing was about 17 cm (`1 / (19 * 0.31)`), versus approximately 93 cm for today's medium renderer band (`1 / (8 * 0.135)`). These are nominal pattern scales, not measured image frequencies.

At default detail strength, the current density multiplier spans only 0.68–1.32. The default density is 1.25 and the raymarch extinction factor is 1.65 ([presets](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/presets.js#L16-L21), [raymarch](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/fog.js#L290-L312)). The hypothesis is that long view paths saturate much of this modest modulation, leaving broad smooth interiors and detail mostly at the top silhouette.

The supplied screenshot supports that diagnosis: large clearings and bank silhouettes read well, but near-bank interiors resemble smooth foam. The reference video contact sheet contains more stretched translucent ribbons and tighter internal folds. Increasing top displacement alone risks lumpy popcorn; lowering density alone risks merely revealing more checkerboard.

The solver also uses bilinear semi-Lagrangian advection each tick and exponential reservoir recovery with a 13-second default time constant ([`src/sim.js:209–219`](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/sim.js#L209-L219), [379–385](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/sim.js#L379-L385)). Numerical diffusion is therefore a reason to judge settled sequences as well as initial frames. No separate density blur pass was found.

## Recommended preserves and hypothesis

- Preserve the shared noise atlas and transported bank field. Both GPU and CPU bank initialization use its R/G channels; globally restoring the old atlas would also shrink the banks. See [`src/sim.js:22–37`](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/sim.js#L22-L37) and [`src/cpu-solver.js:99–104`](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/cpu-solver.js#L99-L104).
- Preserve the world-height ceiling, exposed hilltops, deliberate clearings, close camera, obstacle clipping and synchronized simulation tick.
- Test a restrained renderer-only fine band sampled from the existing atlas, with flow deformation and height shear. A world scale around 0.28–0.38 gives nominal 33–45 cm G-channel features, between the two historical scales.
- Test stronger erosion in the upper/tenuous volume while retaining the dense core. Avoid uniform bright noise and wholesale fragmentation into small islands.
- Keep mesh geometry relief restrained. Its separate low-relief profile in [`src/fog.js:432–437`](https://github.com/TrentSterling/fog/blob/dba352ce26f4635d089894169aac9b7aaf28993a/src/fog.js#L432-L437) exists to avoid folded sheet silhouettes. A raymarch improvement must also be inspected in mesh and layered modes; a shared noise function can alter their normals and opacity.

## Proposed gauntlet

Compare the current baseline, a parameter-only candidate (`density=1.05`, `detailStrength=1.35`, `heightShear=1.2`), a restrained fine-band candidate, fine band plus envelope erosion, and an aggressive erosion rejection control. Hold camera, lighting, field and completed tick fixed within each scene. Test sampling quality separately so a change from 32 to 48 steps or 0.8 to full render scale does not confound the artistic comparison.

Judge anonymized images and motion sequences for coherent banks, readable wisps, clearings, terrain exposure, temporal continuity, and absence of cotton/snow, halos, banding and sheet folds. Include flat terrain, hills, a grazing camera, all three renderers, slash/wake motion, and a 20–30 second settled field. Record actual rendering capabilities and measured cost; this source audit makes no performance claim.
