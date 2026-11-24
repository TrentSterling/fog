# FogLab credits

**FogLab by [Trent Sterling / Tront](https://tront.xyz/).**

An interactive ground-fog study for comparing analytical motion, a small hybrid field, and CPU or GPU fluid simulation through a shared Three.js renderer. Project direction, visual decisions, and release ownership: Trent Sterling.

- [Project and live demo](https://tront.xyz/fog/)
- [Source repository](https://github.com/TrentSterling/fog)
- [Implementation notes](docs/how-it-works.md)

## Visual reference

[**Ocarina of Time Style Interactive Ground Fog in Godot**](https://www.youtube.com/watch?v=Sm8x4lOGOYE) was the original appearance and interaction reference supplied for this project. Thank you to the video's creator for sharing the effect.

The reference informed the look of low fog, displaced wakes, and swirling recovery. The video, its frames, and any implementation belonging to its creator are not bundled with FogLab. FogLab does not claim to reproduce Nintendo's implementation and is not affiliated with Nintendo or the reference video's creator.

## Research and technical foundations

These are credits for published ideas and explanations. They are not bundled dependencies, and a citation does not mean that every method in a paper is implemented here.

| Authors and publication | Connection to FogLab |
| --- | --- |
| **Jos Stam.** “Stable Fluids.” SIGGRAPH, 1999. [Author's publication list](https://www.dgp.toronto.edu/~stam/reality/Research/pub.html). | Foundation for semi-Lagrangian transport and pressure projection in the fluid modes. |
| **Jos Stam.** “Real-Time Fluid Dynamics for Games.” GDC, 2003. [Author-hosted paper](https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/GDC03.pdf). | Practical explanation of a compact grid-based solver and separate velocity and density fields. |
| **Mark J. Harris.** “Fast Fluid Dynamics Simulation on the GPU.” *GPU Gems*, Chapter 38, 2004. [NVIDIA chapter](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu). | Texture-backed simulation, fullscreen computation, advection, iterative pressure solving, and projection. |
| **Ronald Fedkiw, Jos Stam, and Henrik Wann Jensen.** “Visual Simulation of Smoke.” SIGGRAPH, 2001. [Stanford paper page](https://graphics.stanford.edu/papers/smoke/). | Vorticity confinement as a way to restore rolling detail lost on coarse simulation grids. |
| **Robert Bridson, Jim Hourihan, and Marcus Nordenstam.** “Curl-Noise for Procedural Fluid Flow.” SIGGRAPH, 2007. [Author-hosted paper](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf). | Curl-based procedural flow as a technical reference for the baked noise field. FogLab does not implement the paper's complete boundary treatment. |
| **Keenan Crane, Ignacio Llamas, and Sarah Tariq.** “Real-Time Simulation and Rendering of 3D Fluids.” *GPU Gems 3*, Chapter 30, 2007. [NVIDIA chapter](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids). | Background on volume integration and scene-depth composition. FogLab's simulated state remains a horizontal 2D field. |

FogLab uses first-order semi-Lagrangian advection. MacCormack advection was discussed during research but is not implemented in this release.

## Software and assets

**[Three.js r180 / 0.180.0](https://github.com/mrdoob/three.js/tree/r180)** provides the rendering engine. Copyright © 2010–2025 three.js authors. Three.js is distributed under its MIT license, reproduced verbatim in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [vendor/three-LICENSE.txt](vendor/three-LICENSE.txt). The standalone HTML embeds the notice and exposes it in Credits.

The stage geometry, materials, noise atlas, interface, and preview media are made within FogLab. No third-party models, textures, fonts, audio, or video frames are included in the public build. Original FogLab code and procedural assets are distributed under the repository's [MIT license](LICENSE), copyright 2026 Trent Sterling.

## Development acknowledgments

ChatGPT assisted engineering and iteration. Gemini discussion contributed review ideas. These acknowledgments describe development assistance; the published research and the original video remain credited to their respective authors.

## Reuse

Keep the FogLab MIT notice with copies or substantial portions of the original software, and preserve the Three.js MIT notice when redistributing the bundled engine. The repository's MIT license does not relicense the linked publications or reference video. Full license texts are in [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
