# FogLab

Interactive ground fog you can take apart. Analytical motion, Hybrid, GPU fluids, and CPU fluids share a test world and interchangeable mesh and volume renderers.

**Version 0.4.0** · WebGL 2 · Three.js r180 · MIT

[Live demo](https://tront.xyz/fog/) · [Standalone HTML](https://tront.xyz/fog/FogLab.html) · [How it works](docs/how-it-works.md) · [Changelog](CHANGELOG.md) · [Credits](CREDITS.md)

![Gold mannequin walking through reactive ground fog on the neutral test stage](assets/foglab-preview.png)

*Preview captured from the actual Three.js scene and shaders through native software OpenGL.*

## New in 0.4

- **Finer, irregular wisps inside the existing fog banks.** A shallow, height-varying detail field erodes tenuous areas without changing the transported simulation field or shrinking the large banks into granular patches.
- **Filtering for low camera angles.** Detail sampling accounts for the distance between ray samples, reducing the repeated curtains and fine banding rejected during the visual review.
- **A visible Wisp detail slider.** Start at 1. Set it to 0 for the smoother rendering, or tune it while paused to compare the same simulation state. The control survives exported presets and shared links.
- **A reproducible visual gauntlet.** Candidate generators, anonymous image shuffling, native rendering, and motion capture are saved under [scripts/visual](scripts/visual). [The review record](docs/validation/wisps/README.md) includes rejected directions and independent blind critiques.

The default remains 128² simulation, 32 ray samples, and 80% fog render scale. The new detail uses the existing atlas and adds no simulation passes or render targets. Its extra shader sampling still has a cost; measure frame time on your device. The broad bank recipe, solvers, worker, shared tick scheduling, world ceiling, and credits are retained.

## Included since 0.3

- **CPU fluids use a Web Worker by default when selected.** The same typed-array solver runs away from the main thread, while camera movement and drawing continue. An explicit main-thread option remains available for comparison.
- **Matched simulation ticks in CPU / GPU comparisons.** Each shared input batch completes on both backends before the next state is drawn. While the worker is busy, panes show the previous completed tick.
- **Bounded catch-up.** The 30 Hz clock retains at most three ticks of elapsed time and accepts at most three ticks per display frame. A busy worker has one outstanding solve; the UI reports actual simulation rate and discarded overload time.
- **Safe reset and fallback.** Reset generations reject stale worker results. If worker execution fails or is unavailable, the app visibly switches to the main-thread solver and restarts all fields together.
- **Visible credits and complete offline notices.** The Credits panel includes the original video, technical references, development acknowledgments, and the full FogLab and Three.js MIT licenses.

The worker source is embedded in the standalone HTML. No worker file, server, or runtime download is required. The 0.3 release changed execution and scheduling while retaining its established visual appearance. Moving the solver to another thread is a responsiveness improvement to measure on your device, not a guaranteed increase in simulation or display frame rate.

## Included since 0.2

- A real **CPU Stable Fluids solver**, using typed arrays and the same renderers as the GPU solver. The CPU / GPU guide compares matching 64² grids.
- **Static obstacle boundaries** in transport and projection, with a visible pillar course and obstacle-mask inspection.
- **Swept blade impulses** and a jump that triggers a pulse on landing.
- Independent **column / billow density**, **world ceiling / terrain-following height**, and **ambient / directional lighting** controls.
- Separate radial, tangential, and paired wake forces, alongside the existing vorticity confinement control.

## What to try

- **Judge the wisps.** Pause and move Wisp detail between 0 and 1. Keep the camera and density fixed to compare the same completed field.
- **Compare the motion.** Keep the mesh renderer selected and switch between Analytical, Hybrid, and Stable fluids. Use A/B or All three to compare the same walking path and camera.
- **Compare the rendering.** Keep Stable fluids selected and switch between Mesh, Raymarch, and Layered. The simulation is independent of the renderer.
- **Inspect the mechanism.** Pause, single-step, switch to density or velocity, and enable wireframe. Pressure and curl inspection belong to the fluid backend.
- **Compare CPU execution.** Select CPU fluids, switch between Worker and Main thread, and watch completed ticks per second alongside frame rate and solve time. Start with the CPU / GPU guide's matching 64² grids.
- **Share the experiment.** Copy a preset link, or export/import its JSON. A link restores settings and starts from the initial world; it does not save the evolving GPU textures.

The default is **Stable fluids + Raymarch**, a flat reference stage, neutral lighting, and automatic movement. The forest, hills, four fog shells, and extra actors are optional inspection settings. See [the technique guide](docs/how-it-works.md) for what each model actually computes.

## Run it

The downloadable `FogLab.html` contains the engine, application, shaders, procedural assets, Blob worker source, and license notices. Open it directly in a browser with WebGL 2 enabled. There are no CDN requests, external fonts, accounts, or runtime asset downloads. If the browser cannot run the embedded worker, CPU fluids fall back visibly to the main thread.

To build from source, use **Node.js 22 or newer** with npm:

1. Clone with `git clone https://github.com/TrentSterling/fog.git`.
2. Enter the checkout with `cd fog`.
3. Run `npm run build`.
4. Open `dist/FogLab.html` in your browser.

**No `npm install` is required.** The build uses Node's standard library and the vendored Three.js distribution. It emits `dist/index.html`, `dist/FogLab.html`, and the preview assets.

For an existing checkout on Windows, open PowerShell in the repository, run `git pull --ff-only`, then `npm run build`. Open `dist\FogLab.html` from Explorer. Run `npm test` for the Node tests and `npm run check` after building to check the packaged files. Those checks do not substitute for running the shaders on a browser/GPU.

## Controls

| Action | Control |
| --- | --- |
| Move the mannequin | WASD or arrow keys |
| Sprint | Shift while moving |
| Orbit | Left drag |
| Stir with a brush | Right drag, or Shift + drag |
| Zoom | Scroll wheel |
| Jump; pulse on landing | Space or Jump button |
| Swept blade slash | X or Slash button |
| Radial interaction pulse | F or Pulse button |
| Pause/resume | P |
| Advance one simulation tick | Step button while paused |
| Reset the fields and actors | R |
| Toggle automatic movement | T |
| Cycle the camera | C |
| Hide/show the interface | H |

Movement takes over from auto walk. Touch dragging orbits the camera; Jump, Slash, and Pulse buttons remain available. Presets, image capture, shader export, and optional GPU diagnostics are available in the interface.

## Motion models and execution

| Model | Persistent state | Work per simulation update | Useful for |
| --- | --- | --- | --- |
| Analytical | Up to 24 shared trail samples on the CPU | No state-update render passes | Studying geometry and UV deformation without a solver |
| Hybrid | A pair of RGBA16F textures plus an R8 obstacle mask | One fullscreen state pass | Persistent advected wakes without pressure projection |
| GPU fluids | Eight RGBA16F textures plus an R8 obstacle mask | `P + 7` passes with confinement; `P + 6` without | Comparing projected flow against the cheaper approximations |
| CPU fluids | Float32 typed arrays plus uploaded field textures | CPU advection and Jacobi projection in a worker by default; zero GPU simulation passes | Exploring CPU cost and sharing a solver with gameplay tools |

`P` is the pressure-iteration setting. At the initial 18 iterations with confinement enabled, the fluid backend performs **25 passes per 30 Hz update**. These counts exclude initialization, the opaque scene, fog rendering, and compositing. Analytical rendering still performs shader work; zero simulation passes does not mean zero cost. Implementation: [sim.js](src/sim.js) and [fog.js](src/fog.js).

## What this release does and does not establish

This is an original visual experiment inspired by [the ground-fog reference video](https://www.youtube.com/watch?v=Sm8x4lOGOYE). It is **not a reconstruction of Nintendo's implementation**, and it does not include Nintendo assets or shaders.

The fluid solver is horizontal and two-dimensional. Height and billows are reconstructed during rendering. Rock footprints and optional pillars are static solid cells in both fluid solvers. Pressure uses solid-neighbor boundaries, velocity cannot pass normally through a wall, and backtraces stop before entering solids. Rock footprints are circular approximations; small rocks can disappear at coarse grid resolution. Hills affect visible height but are not velocity barriers. Analytical only masks solids; Hybrid has transport boundaries but no pressure solve. Density is deliberately cleared, replenished, and shaped for the effect, so this is not a mass-conserving physical smoke model. MacCormack advection, a 3D solver, and WebXR are not implemented.

Hybrid and Stable fluids require renderable half-float targets through `EXT_color_buffer_float`. When that capability is absent, CPU fluids and Analytical remain available. A working WebGL 2 context is still required.

The performance panel reports the current device and view. GPU timing covers the whole sampled frame when timer queries are available; the fallback reports main-thread CPU frame time. Worker solve time is separate and is not included in that main-thread measurement. A/B views add rendering work. Use Solo and a fixed preset when investigating cost.

The target simulation rate is **30 completed ticks per second**, independent of display refresh rate. Under load, the simulation can run slower while drawing continues; excess elapsed time is discarded instead of building an unbounded queue. The panel reports the actual simulation rate and this discarded wall-clock budget. CPU solve plus packing is shown per tick, and worker round-trip time additionally includes scheduling, diagnostics, message delivery, and the main-thread texture copy. Neither number measures GPU upload latency. Upload bytes are scheduled texture payload; GPU rendering is still required. Start CPU comparisons at 64² and increase the grid only when your device has enough headroom. This release makes no Quest frame-rate or worker speedup claim. See [timing details](docs/how-it-works.md#rendering-and-timing).

## Source map

| File | Responsibility |
| --- | --- |
| [src/cpu-solver.js](src/cpu-solver.js), [src/cpu-sim.js](src/cpu-sim.js) | CPU solver and Three.js texture adapter |
| [src/cpu-worker.js](src/cpu-worker.js), [src/cpu-worker-sim.js](src/cpu-worker-sim.js) | Embedded worker protocol, transfer packets, generation checks, and fallback |
| [src/fixed-step.js](src/fixed-step.js) | Bounded fixed-step elapsed-time budget |
| [src/field-utils.js](src/field-utils.js) | Shared obstacle rasterization |
| [src/interactions.js](src/interactions.js) | Swept blade sources and jump/landing events |
| [src/sim.js](src/sim.js) | GPU motion backends, shared initial fog-bank recipe, diagnostics |
| [src/fog.js](src/fog.js) | Analytical field sampling, mesh/shell/volume rendering, compositing |
| [src/world.js](src/world.js) | Terrain, neutral stage, mannequin, optional forest |
| [src/app.js](src/app.js) | Fixed-step updates, input, cameras, resources, timings |
| [src/presets.js](src/presets.js) | Validated preset serialization and share-link codec |
| [src/learning.js](src/learning.js) | Guided comparisons and explanatory UI |
| [src/credits.js](src/credits.js) | Visible reference credits and offline license notices |
| [src/lab-tools.js](src/lab-tools.js) | Shader export and opt-in readback diagnostics |
| [src/template.html](src/template.html), [src/style.css](src/style.css) | Interface |
| [scripts/build.mjs](scripts/build.mjs) | Assemble the standalone files |
| [vendor/three.cjs](vendor/three.cjs) | Pinned Three.js r180 distribution |

Shader export produces the original GLSL blocks, not a ready-made Unity package. Engine prefixes, uniforms, texture conventions, and terrain functions must be supplied when porting them.

## Publishing

The project is published at `https://tront.xyz/fog/`. The [branch publishing workflow](.github/workflows/gh-pages-branch.yml) runs the tests, builds the self-contained files, checks packaging, and commits the generated assets to `gh-pages`. The workflow explicitly requests or confirms publication of that branch's root, then verifies the live manifest and both HTML hashes before reporting success. Source stays on `main`; generated hosting files stay on `gh-pages`.

A source push is only the first step. Check both the publishing workflow and GitHub's Pages deployment, then inspect the served [build.json](https://tront.xyz/fog/build.json) version and HTML hash. The older direct-Actions workflow remains available; it only deploys when the repository is explicitly configured for that source. It is not the active branch-publishing route.
