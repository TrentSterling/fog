# Reproducible native visual captures

This development tool executes FogLab's actual production Three.js scene,
simulation, seeded noise atlas, and GLSL through a surfaceless Mesa GLES context.
It is a fallback for environments where Chromium cannot provide WebGL 2.
**Its output is native rendering, not browser screenshots or hardware performance
measurements.** The CPU option uses the synchronous CPU adapter, not a Worker.

The capture does not change the shipping app or its dependencies. It needs Node
22+, Python 3 with NumPy, Mesa EGL/GLES libraries, and `sharp`. Dependencies can be
resolved from `CODEX_PRIMARY_RUNTIME_NODE_MODULES`. The Python executable may be
set with `CODEX_PRIMARY_RUNTIME_PYTHON`. No download or installation is performed.

## Capture

```sh
node scripts/visual/capture.cjs --variants scripts/visual/variants.example.json --out /tmp/fog-review
node scripts/visual/capture.cjs --source /path/to/source-snapshot --variants /tmp/variants.json --out /tmp/candidate-review --width 1280 --height 720
```

`--source` is a directory containing `src/` and `vendor/three.cjs`. It defaults
to this repository. Freeze source before comparing revisions. One process loads
one revision; run separate processes for different shader implementations.
`--only <id>` selects one variant; `--ticks 180,210,240` overrides capture ticks.

The variants file accepts an array, or an object with `defaults` and `variants`.
Every variant gets an independent scene and simulation, with the same seeded
atlas. Settings merge over the production defaults. Values are not normalized by
the preset codec, allowing controlled renderer experiments.

```json
{
  "width": 960,
  "height": 540,
  "defaults": {
    "mode": "fluid",
    "render": "raymarch",
    "ticks": [180, 210, 240],
    "motion": "walk",
    "camera": {"theta": 0.38, "phi": 1.14, "distance": 11.5},
    "shots": [
      {"id": "follow"},
      {"id": "grazing", "camera": {"phi": 1.36, "distance": 13}}
    ]
  },
  "variants": [
    {"id": "reference"},
    {"id": "parameters", "settings": {"density": 1.05, "detailStrength": 1.35, "heightShear": 1.2}}
  ]
}
```

Other variant options:

- `mode`: `fluid`, `cpu`, `hybrid`, or `analytical`.
- `render`: `raymarch`, `mesh`, or `layered`.
- `motion`: deterministic `walk`, `straight`, or `still`.
- `slashTicks`, `jumpTicks`, `pulseTicks`: arrays of integer event ticks.
- `camera.target` and `camera.position`: explicit `[x,y,z]` overrides for fixed
  framing. Otherwise the camera follows the actor. `fov` defaults to 48 degrees,
  and `targetHeight` defaults to 0.72 world units above the terrain.
- `settings`: any production settings, including terrain, density profile,
  quality, resolution, ray steps, and rendering scale. A quality name alone does
  not apply the app's quality preset: set resolution, steps, and scale explicitly
  when testing preset changes.

The simulation always advances by exactly 1/30 second. A capture at tick 180 is
at six seconds. Its PNG filename includes variant, shot, and zero-padded tick.
`manifest.json` records exact settings, actor and camera coordinates, source and
noise SHA-256 hashes, renderer provenance, simulation diagnostics, and image
hashes. Captures abort on shader failure, nonfinite fields, or blank images.
Wall-clock timings in solver diagnostics are not hardware GPU benchmarks.

## Anonymous review sheet

Create a JSON array of image paths, then:

```sh
node scripts/visual/review.cjs --inputs /tmp/images.json --out /tmp/review-sheet --seed round-one
```

This copies the original images to `blind/A.png`, `blind/B.png`, and so on in a
reproducibly shuffled order, with a labelled `blind/sheet.png`. The implementation
key remains separately in `key.json`; give critics only the `blind/` folder.
Images are resized only for the overview sheet. The individual originals remain
unchanged. Input entries can be strings or objects containing a `file` field.

## Motion sequence

Capture regular tick intervals, then:

```sh
node scripts/visual/sequence.cjs --manifest /tmp/candidate-review/manifest.json --variant reference --shot follow --out /tmp/reference.mp4
```

This uses local FFmpeg and preserves simulation time: captures every three ticks
play at 10 frames per second. It refuses irregular intervals. Use consecutive
ticks for a 30 FPS motion check; do not interpret capture throughput as runtime
performance.

## Provenance of the adapter

The adapter was recovered from FogLab's previous native validation tooling and
made repository-local. `native_webgl.js` forwards actual Three.js GL commands to
`native_gl_bridge.py`; `gles_context.py` establishes the Mesa GLES context. The
wrapper releases cached WebGL object identity when native names are deleted,
because Mesa can recycle integer handles. The source scene, fog shader and atlas
generator are always loaded from the selected source tree.

Local Chromium was attempted for the initial v0.3 detail review, but this
workspace denied its ProcessSingleton socket before WebGL initialization. The
native path lets us review real output while explicitly preserving that limit.
