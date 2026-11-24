# How FogLab works

FogLab separates two questions: **what moves the fog, and how do we draw it?** A pressure solver does not require raymarching. A raymarcher does not require a pressure solver. Keeping those decisions separate is the point of the demo.

This guide describes release **0.3.0**, particularly [sim.js](../src/sim.js), [fog.js](../src/fog.js), [cpu-worker-sim.js](../src/cpu-worker-sim.js), and [app.js](../src/app.js). The implementation is a visual approximation inspired by the [reference video](https://www.youtube.com/watch?v=Sm8x4lOGOYE), not a claim about Nintendo's engine. The 0.3 upgrade changes CPU execution and update scheduling while preserving the fog shaders and established visual controls.

## Start with controlled comparisons

1. **Motion:** choose A/B, put Hybrid on the left and Stable fluids on the right, and give both the same Mesh renderer. Reset and watch the same automatic path. Differences now come mainly from the motion model.
2. **Rendering:** choose Stable fluids in both panes, with Mesh on one side and Raymarch on the other. Both sample the same simulation texture; compare volume, intersections, and view dependence.
3. **Inspect:** pause and select Density or Velocity. Single-step the simulation, then return to the final fog. Use the mesh wireframe to separate geometry changes from texture detail.
4. **CPU execution:** select CPU fluids and compare Worker with Main thread at 64². Watch frame rate, completed simulation ticks per second, and solve time together; a responsive camera does not establish a faster solver.

Camera, actors, terrain, noise assets, and interaction events are shared. The opaque world is rendered once for the pane aspect ratio and reused. The visible motion backends update at fixed **1/30-second steps**; multiple renderers using the same backend do not advance it twice. Share links preserve configuration and reset the initial world, not GPU texture contents or a particular moment in the wake.

## Shared field and static noise

The simulation covers a **32 × 32 m** square on the XZ plane. Texture coordinates are `worldXZ / 32 + 0.5`. At 128², one cell spans 0.25 m.

| State channel | Meaning |
| --- | --- |
| R | Velocity along world X |
| G | Velocity along world Z |
| B | Fog concentration |
| A | Decaying disturbance energy used to shape shoulders and recovery |

Hybrid packs everything into one state texture pair. The fluid backend has a separate velocity pair during its solve, then writes the resulting velocity back alongside concentration and disturbance in the shared state format. Analytical mode returns a compatible field from functions; its procedural motion signal is not a pressure-projected physical velocity.

The **256² RGBA8 noise atlas is generated deterministically once at startup**. R carries broad noise, G carries medium detail, and B/A carry a baked curl vector. Its base image occupies 256 KiB, before mipmaps. Sampling coordinates, flow phases, and the simulation change over time; the atlas bytes do not get regenerated every frame. See `createNoiseAtlas()` in [app.js](../src/app.js).

The broad banks are part of the initial **concentration field**. Hybrid and fluid modes transport those concentrations, rather than drawing an unrelated scrolling cloud mask over a uniform simulation. A slow recovery term replenishes fog toward the original bank pattern. Additional texture samples shape medium billows and lighting without creating fog where concentration is zero. The common bank recipe is `fogBankDensity()` in [sim.js](../src/sim.js).

## Motion models and execution

### Analytical: reconstruct a wake from history

The application retains up to 24 recent interaction samples. The shader evaluates their age, radius, clearing, and edge influence to reconstruct a field. Motion bends the texture coordinates; sampled field values also displace mesh vertices.

There is no evolving simulation texture and no pressure solve. The tradeoff is that each field evaluation must revisit the history, and disturbances do not interact like simulated fluid. The 24-sample budget is shared by all interactors, so adding actors shortens the history available per actor. Raymarching an analytical field can repeat this work at many samples per pixel; it is not automatically the cheapest combination.

### Hybrid: one persistent update

Hybrid reads the previous state, backtraces through its velocity, interpolates the result, blends toward ambient flow, applies actor impulses, and updates concentration and disturbance. It writes the new state into the other texture and swaps the pair. All of this happens in **one fullscreen pass** per tick.

The central transport operation is semi-Lagrangian advection:

$$
q_{new}(x) \approx q_{old}\bigl(x-\Delta t\,u(x)\bigr).
$$

Read it as: “Where did the material at this cell come from?” The shader samples that previous location. Explicit bilinear sampling makes the interpolation behavior clear. This method introduces numerical diffusion, so fine detail softens over time. FogLab does not implement MacCormack or another corrected-advection scheme.

Hybrid includes persistent motion, clearing, and recovery, but **does not enforce incompressibility**. It is the middle option between reconstructing every disturbance analytically and running a pressure solve.

### Stable fluids: project the velocity

The fluid backend performs these passes in order:

1. Advect and damp velocity.
2. Add ambient flow and actor forces.
3. Compute curl, then optionally add vorticity confinement.
4. Compute divergence.
5. Iterate a Jacobi pressure solve.
6. Subtract the pressure gradient from velocity.
7. Advect concentration and disturbance with the projected velocity; apply clearing and recovery.

The projection step approximates:

$$
\nabla^2p=\nabla\cdot u^*,\qquad u=u^*-\nabla p.
$$

Here the time-step/density scale is absorbed into the pressure-like variable used by this solver. With a finite number of iterations, projection reduces discrete divergence; it does not guarantee an exact incompressible solution. The optional readback diagnostic reports interior RMS divergence before and after projection so the result can be inspected.

Vorticity confinement reinforces rotation lost to the coarse grid. Actor motion also adds a radial push, entrainment, and a pair of counter-rotating wake impulses. A swept interaction stamp clears the center and gathers some occupied material into the shoulders. These are effect controls, not a rigid-body fluid coupling system. The outer square, rock footprints, and optional pillars have no-through-flow walls. Hills are **not** included as velocity obstacles. The Wake force selector chooses paired vortices, radial push, or tangential rotation; the separate Vorticity confinement control acts on the whole solved field. Sources: [sim.js](../src/sim.js), [Stam](#references), [Harris](#references), and [Fedkiw et al.](#references).

### CPU fluids: solve in typed arrays

[src/cpu-solver.js](../src/cpu-solver.js) performs semi-Lagrangian transport, the same force kernels, curl/confinement, Jacobi pressure projection, and exponential density recovery in JavaScript. State lives in typed arrays. The solver does not read back GPU textures. CPU resources are allocated when the CPU backend is selected; a scene using only GPU or Analytical motion does not create a CPU worker. Only visible backends advance.

The CPU / GPU guide explicitly selects 64² for both backends, with the same camera, input path, pressure iterations, and renderer. Quality can raise both to 128² or 256². CPU Float32 arithmetic, base-mip noise sampling, and GPU half-float targets with implicit noise mip levels do not give bitwise-identical results; both implementations use the same units, equations, boundaries, and source shapes. At coarse grids, pressure iteration count and numerical diffusion remain visible.

**Worker is the default CPU execution mode.** The explicit Main thread option uses [cpu-sim.js](../src/cpu-sim.js), so both modes execute the same solver. The standalone build embeds the actual [field-utils.js](../src/field-utils.js), [cpu-solver.js](../src/cpu-solver.js), and [cpu-worker.js](../src/cpu-worker.js) sources into a classic Blob worker. There is no second solver implementation to keep in sync, no fetched worker script, and no requirement for SharedArrayBuffer or cross-origin isolation.

[cpu-worker-sim.js](../src/cpu-worker-sim.js) owns the Three.js upload textures on the main thread. Each completed worker task transfers a separate packed field buffer. The adapter copies it into a persistent texture array and returns the packet buffer for reuse on a later task. The live renderer array and the worker's evolving simulation arrays are never transferred or detached. The field packet is RGBA32F if float linear filtering is available, otherwise packed RGBA16F. An inspected pressure, curl, or divergence field adds a scalar Float32 packet; those auxiliaries are not sent with every beauty-view tick.

The adapter permits **one outstanding task**, so a slow worker does not collect a queue of old actor inputs. Reset, resolution, and obstacle changes advance a generation identifier. A result from an older generation is discarded before it can overwrite the new field. Pending configuration changes are coalesced around the running task. If worker creation, messaging, or execution fails, the app displays the fallback, switches to the main-thread solver, and restarts all backends together. That restart is intentional: a fresh CPU field must not be compared with an older GPU field.

Moving the calculation off the main thread allows camera updates and drawing to continue while it is busy. It does not reduce the number of pressure iterations or eliminate packing, delivery, copying, and GPU uploads. Whether it raises frame rate or simulation throughput depends on the browser, device, grid, and scene. Start at 64² and measure.

### Update scheduling and completed ticks

[fixed-step.js](../src/fixed-step.js) tracks a **1/30-second simulation step**, a maximum of **three accepted steps per display frame**, and a maximum retained backlog of **0.1 seconds**. It tracks elapsed time only; rendering still uses the browser's animation loop. When the worker is busy, the application does not consume another tick or advance the simulation inputs.

For a CPU / GPU comparison, each accepted tick has one shared snapshot of actors, interactions, settings, and simulation time. The CPU worker receives that snapshot. When its result is ready, the corresponding GPU work completes from the same snapshot before the next draw. Until then, every pane renders the previous completed simulation tick while camera controls and rendering remain active. Sharing a time step makes the comparison coherent; Float32 CPU and half-float GPU arithmetic still differ.

If elapsed time exceeds the backlog budget, the clock records the excess as **discarded overload time**. It does not replay an unlimited backlog later. The consequence is slower simulation progress under sustained load, rather than unbounded latency. The interface reports actual completed ticks per second separately from display frame rate and the nominal 30 Hz target. Discarded seconds describe wall-clock budget removed by the scheduler; they do not measure CPU execution cost or data loss in the fields.

Pause and hidden-tab handling clear retained elapsed time. The first resumed frame ignores a possibly stale interval, preventing a return-to-tab burst. A requested single-step advances one fixed tick while paused. A full reset clears timing history and invalidates any pending comparison batch.

### Obstacles and swept interactions

The shared cell-centered R8 mask stores 0 for fluid and 255 for solid. Reference rocks use circular footprint approximations; the optional pillar course uses circles matching the cylinders. Forest rocks are included, but decorative ruin blocks and trees are not. Hills only affect rendering. The mask is regenerated when the environment, course, obstacle toggle, or grid size changes; changing that setup restarts the fields.

Advection traces stop at solids and interpolation rejects solid taps. Divergence reflects the wall-normal velocity. The pressure stencil counts fluid neighbors, applying a zero-normal-gradient boundary, and projection blocks wall-normal velocity. Solid cells hold zero density, energy, and velocity. This is a coarse collocated free-slip approximation, not exact curved-wall geometry, no-slip viscosity, moving rigid bodies, or perfectly incompressible flow. A small rock needs enough grid cells to be represented. Analytical motion masks the footprint without redirecting flow; Hybrid respects transport walls without pressure projection.

The blade emits three capsule sweeps across its length during a 0.42-second swing. Each step joins the previous and current sample, including actor translation. Directional and tangential forces are scaled by the time step. Its short visible ribbon uses the same sweep positions. The analytical renderer remembers capsule stamps in its shared 24-sample history budget.

Jump height is integrated with gravity. A landing event occurs once when the actor crosses back to ground and triggers the radial impulse. The separate Pulse action is still available. These are authored effect inputs, not two-way fluid/character dynamics.

## Independent renderers

All renderers consume concentration and a motion/disturbance signal. They reconstruct a world-space upper envelope for the fog. Terrain can rise above that envelope; the fog is not simply raised onto every hill like a blanket. The default World ceiling lets hills emerge. Follow terrain instead adds terrain height to both the local base and top; it blankets hills intentionally and does not simulate valley pooling. The CPU terrain and shader terrain use the same function in [world.js](../src/world.js).

| Renderer | How it draws the field | Main compromise |
| --- | --- | --- |
| Mesh | One tessellated surface, field-driven height/offset, texture flow, approximate optical thickness | Flat or folded silhouettes can reveal the surface |
| Four shells | Four surfaces with divided contributions | More transparent overdraw; still discrete layers |
| Raymarch | Samples a shallow volume, clips at opaque scene depth, accumulates extinction from front to back | More fragment work as sample count and coverage grow |
| Layered | One mesh plus one volume, with 30%/70% density contributions | An artistic blend, not a general volumetric layer-compositing solution |

The single sheet deliberately uses gentler surface relief than the volume. Raising every small density variation into a large geometric crest makes the mesh look like crumpled material and exposes its silhouettes.

Both the sheet approximation and raymarch accumulation use exponential extinction:

$$
\alpha=1-\exp(-\sigma L).
$$

For the sheet, `L` comes from an approximate thickness/view-angle calculation with a clamp. For the raymarcher, `L` is a step length, and the remaining transmittance weights each successive sample. Scene depth clips opaque intersections. Fog renders into its own lower-resolution target, then a depth-aware four-tap composite combines it with the opaque scene. This is a shallow 2.5D reconstruction, not a 3D simulated density grid. Implementation: [fog.js](../src/fog.js).

### Density shape and lighting

Layered billows preserve the existing height-varying noise. Simple columns keep one horizontal pattern throughout the height with a soft upper falloff. These choices work with every renderer. Billow detail scales medium erosion and surface relief; it does not remove the broad transported concentration pattern. Vertical shear changes height-dependent noise coordinates and is inactive for columns.

Directional lighting uses the existing nearby density sample to darken deeper material. Ambient only skips that extra raymarch density/detail lookup; mesh silhouette normals are still required. Neither setting adds a fluid update pass. Precomputed light fields and MacCormack advection are not part of this release.

## Count the work honestly

### State-update passes

| Motion backend | Passes per tick |
| --- | ---: |
| Analytical | 0 |
| Hybrid | 1 |
| CPU fluids | 0 GPU simulation passes; CPU solve plus texture upload |
| GPU fluid, confinement disabled | `P + 6` |
| GPU fluid, confinement enabled | `P + 7` |

`P` is the pressure-iteration count. Curl is still computed with confinement disabled because it is available for inspection. The initial setting is `P = 18`, giving 25 fluid passes per tick. Initialization/reset passes are excluded. Updating at 30 Hz is independent of display frame rate.

### Simulation texture allocation

Every GPU simulation render target in this release is **RGBA16F: eight bytes per texel**, with no mipmaps or depth attachment. Hybrid has two targets. Fluid has eight: two state, two velocity, two pressure, one curl, and one divergence.

| Grid | Hybrid targets | Fluid targets | Both allocated by the app |
| --- | ---: | ---: | ---: |
| 64² | 64 KiB | 256 KiB | 320 KiB |
| 128² | 256 KiB | 1 MiB | 1.25 MiB |
| 256² | 1 MiB | 4 MiB | 5 MiB |

Each GPU backend also owns an R8 obstacle mask, adding N² bytes: 4 KiB, 16 KiB, or 64 KiB per backend at the listed resolutions. These are calculated texture payload sizes from [the allocator](../src/sim.js), not measurements of driver/GPU memory. They exclude noise, scene color/depth, fog targets, shadows, geometry, materials, and overhead. The application constructs both simulation backends for switching, so selecting Analytical does **not** free the two backends' allocations. A standalone analytical implementation could omit them.

The CPU field upload is 16 bytes per cell in RGBA32F, or 8 bytes in the half-float fallback. At 64² that is 64 KiB or 32 KiB per scheduled tick; at 128² it is 256 KiB or 128 KiB. An inspected scalar auxiliary adds 4 bytes per cell. Worker messages use separate reusable packets of these sizes; the persistent Three.js arrays still require a CPU copy and a later GPU upload. Several main-thread CPU ticks before one draw can coalesce into one upload. The UI reports payload per completed tick, not PCIe traffic or measured transfer latency. CPU solver arrays, transfer packets, GPU upload textures, and GPU simulation render targets are separate budgets.

### Rendering and timing

A mesh view normally performs one fog draw plus the composite. A raymarch view also performs one fog draw plus the composite, but the fragment shader has much more work. Four shells need four fog draws plus the composite; Layered needs mesh, volume, and composite. Wireframe adds another draw. The opaque scene and its shadows are separate.

The optional GPU timer samples a whole frame every tenth display frame and smooths its result. It includes the scene, the GPU simulation work due in that frame, and all visible fog panes. The fixed-step update means a sampled frame may contain zero or several simulation steps. When GPU timer queries are unavailable, the UI reports main-thread CPU frame time: accepted synchronous simulation work, scene updates, and draw submission. It excludes time spent solving on a worker.

CPU solve plus packing time is reported per completed tick. Worker round-trip time covers the interval from submitting a request through scheduling, solving, packing, diagnostics, delivery, and the main-thread texture copy. GPU upload happens later and is excluded from these CPU measurements. The round trip can be longer than solve plus packing without indicating additional numerical work.

Read **display FPS**, **actual simulation ticks per second**, and **discarded overload time** together. A 60 FPS display can redraw a field that is advancing below 30 Hz. A worker can improve input responsiveness while leaving total solve throughput unchanged or lower. Neither an FPS number nor native software-rendered preview footage establishes Quest performance.

For a useful comparison, keep the camera, scene, settings, browser, and device fixed; let the scene settle; use Solo; and record the configuration with the observation. A/B is for visual comparisons, not isolated per-backend timing. Opt-in diagnostics read textures back synchronously and should not run during a timing measurement.

## Porting and limits

- Preserve the world-to-texture mapping, velocity units, time step, and linear data-texture sampling when moving the solver to another engine.
- Port motion and rendering separately. A texture-driven mesh is a valid renderer for the full solver.
- Shader export includes original blocks. It does not supply an engine's uniforms, matrix conventions, color management, or shader-prefix code.
- Semi-Lagrangian diffusion, finite pressure iterations, artistic density recovery, and a fixed local domain are deliberate limits of this prototype.
- There is no 3D buoyancy solve, moving or general triangle-mesh obstacle coupling, MacCormack advection, Wasm solver, WebGPU compute implementation, WebXR path, or certified mobile/VR performance target in 0.3.0.

## Credits and reuse

FogLab is by [Trent Sterling / Tront](https://tront.xyz/). The [complete credits](../CREDITS.md) identify the visual reference, technical publications, bundled engine, and development assistance. The demo's Credits panel embeds the reference list and full FogLab and Three.js MIT notices, so attribution stays readable in the offline HTML. The linked papers and video are references rather than bundled assets. See [LICENSE](../LICENSE) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the complete software notices.

## References

These links explain the techniques that informed the implementation. Referenced material is not a bundled dependency or a promise that every method in a paper is implemented.

- **Visual target:** [Ocarina of Time-style interactive ground fog in Godot](https://www.youtube.com/watch?v=Sm8x4lOGOYE). The original video supplied the appearance and interaction reference.
- **Jos Stam, “Stable Fluids,” SIGGRAPH 1999.** [Author's publication list](https://www.dgp.toronto.edu/~stam/reality/Research/pub.html). Foundation for stable advection and projection.
- **Jos Stam, “Real-Time Fluid Dynamics for Games,” GDC 2003.** [Author-hosted PDF](https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/GDC03.pdf). A practical explanation of a small grid-based solver.
- **Mark J. Harris, “Fast Fluid Dynamics Simulation on the GPU,” GPU Gems, Chapter 38.** [NVIDIA chapter](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu). Texture storage, fullscreen computation, advection, and pressure projection.
- **Ronald Fedkiw, Jos Stam, and Henrik Wann Jensen, “Visual Simulation of Smoke,” SIGGRAPH 2001.** [Stanford paper page](https://graphics.stanford.edu/papers/smoke/). Vorticity confinement as a way to restore small-scale rolling behavior.
- **Robert Bridson, Jim Hourihan, and Marcus Nordenstam, “Curl-Noise for Procedural Fluid Flow,” SIGGRAPH 2007.** [Author-hosted PDF](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf). Curl-based procedural velocity fields. FogLab does not implement the paper's full solid-boundary treatment.
- **Keenan Crane, Ignacio Llamas, and Sarah Tariq, “Real-Time Simulation and Rendering of 3D Fluids,” GPU Gems 3, Chapter 30.** [NVIDIA chapter](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids). Background on volume integration and scene-depth composition; FogLab's simulated state remains 2D.
