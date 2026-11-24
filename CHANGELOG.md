# Changelog

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
