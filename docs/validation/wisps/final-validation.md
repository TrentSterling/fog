# Final native visual validation

The adopted FogLab 0.4 renderer passed **99 captures**: 95 at 960×540 and four at 1280×720. Shader compilation, GLES error checks, nonblank-image checks, and finite simulation checks passed. All captured production modules match [commit 7dd9351](https://github.com/TrentSterling/fog/commit/7dd935143cdd928f23c26b2d6332087f328640e9). See [final-summary.json](final-summary.json) for the recorded outcomes and media hashes.

## Exact preservation checks

All **31 non-null raw fields** across 32 original baseline scenarios are byte-identical, and all 32 camera configurations match. Additional matched low-quality and column captures also preserve their fields and cameras. Analytical rendering has no integrated field and records null. See [field-comparison.json](field-comparison.json) and [quality-control-comparison.json](quality-control-comparison.json).

At wisp strength zero, final production follow and grazing PNGs exactly reproduce the round-three old-renderer controls. At default strength one, both PNGs exactly reproduce the blind-selected filtered-warped candidate. All four matches are byte-identical. The four packaged full-size WebPs were decoded and compared with their source PNGs: **every RGBA pixel matches**. See [hero-equivalence.json](hero-equivalence.json).

## Visible result and limits

Full-resolution hero, grazing, low/high quality, terrain/profile frames and chronological motion sheets were inspected. Finer, frayed foreground edges and secondary density breakup appear while broad banks, deliberate clearings, character readability and exposed hill crests remain intact. Terrain-follow mode stays distinct from the world-space ceiling. CPU and hybrid rendering retain the same intended improvement.

Horizontal ray-step strata remain visible at shallow angles, especially with 20 steps and the column profile. Matched old-source controls show this limitation already existed in 0.3. The 48-step/full-resolution views are cleaner; this change does not eliminate every trace of banding.

## Motion checks

The [slash sample](media/slash-30fps.mp4) contains 61 consecutive ticks, 180–240, at 30 FPS. The [steady-camera phase sample](media/phase-boundary-30fps.mp4) contains ticks 350–365 at 30 FPS. Across the phase wrap at 352→353, mean absolute RGB change in the fog region is 0.0321 on the 0–255 scale, maximum channel change is 3, and the mean is 1.015× the ordinary adjacent-frame median. There is no large reset spike in this sample; it does not certify every possible temporal or device-specific artifact.

## Media

- [Before follow](media/before-follow.webp) and [after follow](media/after-follow.webp): full-size lossless 1280×720 images.
- [Before grazing](media/before-grazing.webp) and [after grazing](media/after-grazing.webp): full-size lossless 1280×720 images.
- [Display comparison](media/comparison.webp): compact labelled before/after overview.
- [Thirty-second comparison](media/long-run-comparison.webp): before/after tick 900 with the same simulation field and camera.
- [Quality and profiles](media/quality-sheet.webp): low/high quality, columns and terrain-follow hills.
- [All 14 unique candidates](media/candidate-overview.webp): labels added after blind review. Rounds 1–2 used 960×540 captures; round 3 used 1280×720. The overview uses 480×270 thumbnails and includes repeated candidates once. [Candidate metadata](candidate-overview.json) records originals and hashes.

The [full capture manifest](full-manifest.json.gz) retains all 99 records with per-capture dimensions, source/noise/field/image hashes and a pinned source reference. Gzip is deterministic. Selected media are bundled; original batch filenames in the manifest can be recreated with [winner-stress-config.json](winner-stress-config.json), [winner-hero-config.json](winner-hero-config.json), and the repository capture harness.

These are real production Three.js scenes and GLSL rendered through native Mesa llvmpipe. They are **not browser screenshots, generated illustrations, or hardware GPU performance benchmarks**. The harness deliberately uses a locked camera rather than live frame-rate-dependent smoothing. CPU validation uses the synchronous production adapter.
