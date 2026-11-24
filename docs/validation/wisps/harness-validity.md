# Native visual harness validity review

## What matches production

The harness imports the selected source tree's exact presets, field utilities, interactions, world, GPU and CPU solvers, and fog renderer. It extracts and executes `createNoiseAtlas` from that same app source and records all module and atlas hashes. Three.js, renderer color space, ACES tone mapping, exposure 1.05, PCF soft shadows, HDR scene target, unsigned integer depth texture, camera projection, and scene/fog compositing match the production single-pane draw path.

The production `FogRenderer.render` remains responsible for internal fog dimensions, ray jitter, depth clipping, and compositing. At 960 by 540 and 0.8 scale, the actual fog target is 768 by 432. The static interleaved jitter uses `gl_FragCoord` at this internal resolution and has no separate frame seed. Native captures use the same shader code, simulation tick, atlas, camera and target size for every candidate. No sharpening, denoising, contrast changes or generative edits are applied.

The app enables scissoring over the entire single-pane target; the harness disables it over the same full rectangle, which produces the same covered pixels. The harness renders only requested snapshots, but the scene and actor animation advance every fixed tick. The fog has no temporal accumulation buffer to depend on skipped draws.

## Deliberate limits

The capture camera locks to its exact actor target. The app's live follow camera interpolates that target based on requestAnimationFrame timing. This makes controlled comparisons independent of capture throughput; it is not a pixel-identical replay of arbitrary live browser timing. The production terrain-height camera clamp is applied. Coordinates and projection are in the manifest.

The app may choose a different canvas size based on layout, aspect ratio and device pixel ratio. These tests deliberately use fixed 16:9 targets and pixel ratio one. They do not certify HTML layout, DOM interactions, background worker scheduling, browser compositing, WebGL implementation differences, or device performance. CPU mode exercises the synchronous production CPU adapter. Native llvmpipe throughput and diagnostic CPU times are not hardware GPU benchmarks.

Gameplay event ticks are applied before that tick's actor integration. The original harness started a slash after movement; this was corrected before the stress run. Round-one captures had no slash events and were unaffected. A 10 FPS clip sampled every three simulation ticks shows coarse motion coherence, but cannot rule out all 30 FPS temporal aliasing.

## Field identity evidence

GPU captures hash an unmodified readback of the completed state target as RGBA16F little-endian bytes. CPU captures hash their completed texture upload arrays. Readback performs no draw, simulation advance, or ping-pong swap. Three.js restores the framebuffer binding. Analytical mode does not sample a simulation field and records null. Formats must match before comparing hashes.

Adding the readback left the original baseline tick-180 image byte-identical: `46a6f05162bf445e6a590c8f8fbad00069e28e27c0ba6c73ea46499b8d305fd8`. The corresponding 128-square RGBA16F field is `6448a8f08561dacb6cbec5793ad1e87976179b2877e0086e77f1c302572515dc`. Follow and grazing views share the same field. Flat and hills rendering also share it, because terrain changes affect fog presentation rather than this horizontal simulation.

## Baseline stress outcome

All 32 requested captures completed, with nonblank images, shader compilation success, no GLES errors, and finite simulated fields. Coverage includes flat and hills at ticks 180 and 900 from follow and grazing cameras; 21 slash frames from 180 through 240; CPU/main raymarch, analytical mesh and hybrid layered rendering. The slash clip preserves 10 FPS simulation time. The consolidated manifest is `stress-control/manifest.json`, and the numerical summary is `stress-control/summary.json`.

The captures retain the baseline's smooth broad banks and open hilltops. They provide a controlled reference for detail changes; they are not themselves the proposed appearance improvement.
