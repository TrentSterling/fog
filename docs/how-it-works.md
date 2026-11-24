# How FogLab works

FogLab separates two questions: **what moves the fog, and how do we draw it?** A pressure solver does not require raymarching. A raymarcher does not require a pressure solver. Keeping those decisions separate is the point of the demo.

This guide describes release **0.1.0**, particularly [sim.js](../src/sim.js), [fog.js](../src/fog.js), and [app.js](../src/app.js). The implementation is a visual approximation inspired by the [reference video](https://www.youtube.com/watch?v=Sm8x4lOGOYE), not a claim about Nintendo's engine.

## Start with controlled comparisons

1. **Motion:** choose A/B, put Hybrid on the left and Stable fluids on the right, and give both the same Mesh renderer. Reset and watch the same automatic path. Differences now come mainly from the motion model.
2. **Rendering:** choose Stable fluids in both panes, with Mesh on one side and Raymarch on the other. Both sample the same simulation texture; compare volume, intersections, and view dependence.
3. **Inspect:** pause and select Density or Velocity. Single-step the simulation, then return to the final fog. Use the mesh wireframe to separate geometry changes from texture detail.

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

## Three motion models

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

Vorticity confinement reinforces rotation lost to the coarse grid. Actor motion also adds a radial push, entrainment, and a pair of counter-rotating wake impulses. A swept interaction stamp clears the center and gathers some occupied material into the shoulders. These are effect controls, not a rigid-body fluid coupling system. The outer square has no-through-flow walls; terrain and rocks are **not** included as velocity obstacles. Sources: [sim.js](../src/sim.js), [Stam](#references), [Harris](#references), and [Fedkiw et al.](#references).

## Independent renderers

All renderers consume concentration and a motion/disturbance signal. They reconstruct a world-space upper envelope for the fog. Terrain can rise above that envelope; the fog is not simply raised onto every hill like a blanket. The CPU terrain and shader terrain use the same function in [world.js](../src/world.js).

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

## Count the work honestly

### State-update passes

| Motion backend | Passes per tick |
| --- | ---: |
| Analytical | 0 |
| Hybrid | 1 |
| Fluid, confinement disabled | `P + 6` |
| Fluid, confinement enabled | `P + 7` |

`P` is the pressure-iteration count. Curl is still computed with confinement disabled because it is available for inspection. The initial setting is `P = 18`, giving 25 fluid passes per tick. Initialization/reset passes are excluded. Updating at 30 Hz is independent of display frame rate.

### Simulation texture allocation

Every simulation target in this release is **RGBA16F: eight bytes per texel**, with no mipmaps or depth attachment. Hybrid has two targets. Fluid has eight: two state, two velocity, two pressure, one curl, and one divergence.

| Grid | Hybrid targets | Fluid targets | Both allocated by the app |
| --- | ---: | ---: | ---: |
| 64² | 64 KiB | 256 KiB | 320 KiB |
| 128² | 256 KiB | 1 MiB | 1.25 MiB |
| 256² | 1 MiB | 4 MiB | 5 MiB |

These are calculated texture payload sizes from [the allocator](../src/sim.js), not measurements of driver/GPU memory. They exclude noise, scene color/depth, fog targets, shadows, geometry, materials, and overhead. The application constructs both simulation backends for switching, so selecting Analytical does **not** free the two backends' allocations. A standalone analytical implementation could omit them.

### Rendering and timing

A mesh view normally performs one fog draw plus the composite. A raymarch view also performs one fog draw plus the composite, but the fragment shader has much more work. Four shells need four fog draws plus the composite; Layered needs mesh, volume, and composite. Wireframe adds another draw. The opaque scene and its shadows are separate.

The optional GPU timer samples a whole frame every tenth display frame and smooths its result. It includes the scene, the simulation work due in that frame, and all visible fog panes. The fixed-step update means a sampled frame may contain zero or several simulation steps. When GPU timer queries are unavailable, the UI reports CPU submission time instead. Neither an FPS number nor native software-rendered preview footage establishes Quest performance.

For a useful comparison, keep the camera, scene, settings, browser, and device fixed; let the scene settle; use Solo; and record the configuration with the observation. A/B is for visual comparisons, not isolated per-backend timing. Opt-in diagnostics read textures back synchronously and should not run during a timing measurement.

## Porting and limits

- Preserve the world-to-texture mapping, velocity units, time step, and linear data-texture sampling when moving the solver to another engine.
- Port motion and rendering separately. A texture-driven mesh is a valid renderer for the full solver.
- Shader export includes original blocks. It does not supply an engine's uniforms, matrix conventions, color management, or shader-prefix code.
- Semi-Lagrangian diffusion, finite pressure iterations, artistic density recovery, and a fixed local domain are deliberate limits of this prototype.
- There is no 3D buoyancy solve, general obstacle coupling, MacCormack advection, WebGPU compute implementation, WebXR path, or certified mobile/VR performance target in 0.1.0.

## References

These links explain the techniques that informed the implementation. Referenced material is not a bundled dependency or a promise that every method in a paper is implemented.

- **Visual target:** [Ocarina of Time-style interactive ground fog in Godot](https://www.youtube.com/watch?v=Sm8x4lOGOYE). The original video supplied the appearance and interaction reference.
- **Jos Stam, “Stable Fluids,” SIGGRAPH 1999.** [Author's publication list](https://www.dgp.toronto.edu/~stam/reality/Research/pub.html). Foundation for stable advection and projection.
- **Jos Stam, “Real-Time Fluid Dynamics for Games,” GDC 2003.** [Author-hosted PDF](https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/GDC03.pdf). A practical explanation of a small grid-based solver.
- **Mark J. Harris, “Fast Fluid Dynamics Simulation on the GPU,” GPU Gems, Chapter 38.** [NVIDIA chapter](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu). Texture storage, fullscreen computation, advection, and pressure projection.
- **Ronald Fedkiw, Jos Stam, and Henrik Wann Jensen, “Visual Simulation of Smoke,” SIGGRAPH 2001.** [Stanford paper page](https://graphics.stanford.edu/papers/smoke/). Vorticity confinement as a way to restore small-scale rolling behavior.
- **Robert Bridson, Jim Hourihan, and Marcus Nordenstam, “Curl-Noise for Procedural Fluid Flow,” SIGGRAPH 2007.** [Author-hosted PDF](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf). Curl-based procedural velocity fields. FogLab does not implement the paper's full solid-boundary treatment.
- **Keenan Crane, Ignacio Llamas, and Sarah Tariq, “Real-Time Simulation and Rendering of 3D Fluids,” GPU Gems 3, Chapter 30.** [NVIDIA chapter](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids). Background on volume integration and scene-depth composition; FogLab's simulated state remains 2D.
