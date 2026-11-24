# Changelog

## 0.4.0 — 2026-11-24

### Wisps and visual review

- Added renderer-only, height-varying wisp detail using the existing periodic atlas. Local curl bends the detail and offsets its height slices; the broad transported banks and deliberate clearings stay intact.
- Filtered fine atlas sampling using the ray-step footprint, with screen-space coverage for mesh rendering. Rejected straight extruded ribbons and aggressive granular variants through three rounds of anonymous visual review.
- Added Wisp detail to the main Rendering controls and validated preset/share-link codec. Zero selects the earlier smooth density modulation.
- Skipped fine-density and light work for empty/above-bank volume samples. Default simulation resolution, ray sample count, fog render scale, and render-target allocation are unchanged.
- Preserved deterministic render, image anonymization, motion capture, candidate recipes, and independent critique records in the repository. Native GLES validation is explicitly distinguished from browser and hardware performance testing.
- Updated the documented Pages publishing route to the working gh-pages branch workflow.

The initial softness predates 0.3; it was not introduced by moving CPU simulation into a worker. See the [source audit](docs/validation/wisp-source-audit.md) and [visual review](docs/validation/wisps/README.md).

## 0.3.0 — 2026-11-24

### CPU execution

- Added a Web Worker execution mode, selected by default when CPU fluids are active. Retained an explicit Main thread mode for comparison and fallback.
- Embedded the shared obstacle utilities, existing CPU solver, and worker entry source in the standalone HTML. Worker execution needs no separate file or runtime download.
- Added reusable, transferable field packets while keeping Three.js upload arrays and the worker's simulation arrays resident with their owners.
- Limited the worker adapter to one outstanding task. Reset and configuration generations reject stale results; a worker failure visibly falls back and restarts all backends together.

### Scheduling and comparison

- Added a bounded fixed-step clock targeting 30 Hz, with at most three accepted ticks per display frame and 0.1 seconds of retained elapsed time.
- Kept CPU and GPU comparison batches on the same completed tick. Camera updates and drawing continue while a worker solve is pending.
- Exposed actual simulation progress and discarded overload time, alongside separate solve/packing and worker round-trip timing. These report observed work rather than promise a worker speedup.
- Cleared elapsed backlog on pause and hidden tabs to prevent catch-up bursts on return.
- Suppressed obsolete CPU fields during asynchronous resets and kept the graphics view available if both CPU execution paths fail.
- Made divergence reduction unavailable (`null`) when no measurable pre-projection baseline exists, including immediately after reset.

### Attribution and packaging

- Added a visible Credits panel with the original visual reference, fluid and rendering research, development acknowledgments, and complete offline FogLab and Three.js MIT notices.
- Added [CREDITS.md](CREDITS.md), expanded [third-party notices](THIRD_PARTY_NOTICES.md), and updated the [technique guide](docs/how-it-works.md).
- Added worker-protocol and fixed-step regression coverage. The fog shaders and existing visual controls retain the established 0.2 appearance.
- Added complete application coordination tests, [release validation evidence](docs/validation/v0.3.0.md), and persistent GitHub checkpoint instructions in `AGENTS.md`.

The source release and offline build do not establish publication at the project URL. See [Publishing](README.md#publishing) for the Pages setup and deployment check.

## 0.2.0

- Added typed-array CPU Stable Fluids with shared rendering and a matching 64² CPU / GPU comparison guide.
- Added static obstacle boundaries, an optional pillar course, and obstacle-mask inspection.
- Added swept blade impulses and a jump that triggers a landing pulse.
- Added column/billow density, world-ceiling/terrain-following height, and ambient/directional lighting choices.
- Added radial, tangential, and paired wake controls alongside vorticity confinement.
