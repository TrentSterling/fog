/* FogLab credits and offline license notices. MIT license. */
(function () {
  'use strict';
  const F = window.FogLab = window.FogLab || {};

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  const data = freeze({
    project: {
      name: 'FogLab',
      creator: 'Trent Sterling / Tront',
      homepage: 'https://tront.xyz/',
      repository: 'https://github.com/TrentSterling/fog',
      credits: 'https://github.com/TrentSterling/fog/blob/main/CREDITS.md',
      role: 'Project direction, visual decisions, and release ownership.'
    },
    references: [
      {
        credit: 'Original visual reference',
        role: 'The appearance and interaction reference that started this experiment. Thank you to the video’s creator for sharing the effect.',
        links: [{ label: 'Ocarina of Time Style Interactive Ground Fog in Godot', url: 'https://www.youtube.com/watch?v=Sm8x4lOGOYE' }]
      },
      {
        credit: 'Jos Stam',
        role: 'Stable advection, pressure projection, and a practical grid-based fluid solver.',
        links: [
          { label: 'Stable Fluids · SIGGRAPH 1999', url: 'https://www.dgp.toronto.edu/~stam/reality/Research/pub.html' },
          { label: 'Real-Time Fluid Dynamics for Games · GDC 2003', url: 'https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/GDC03.pdf' }
        ]
      },
      {
        credit: 'Mark J. Harris',
        role: 'Texture-backed fluid simulation, advection, and iterative pressure solving on the GPU.',
        links: [{ label: 'Fast Fluid Dynamics Simulation on the GPU · GPU Gems 38, 2004', url: 'https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu' }]
      },
      {
        credit: 'Ronald Fedkiw, Jos Stam & Henrik Wann Jensen',
        role: 'Vorticity confinement to restore rolling detail on coarse simulation grids.',
        links: [{ label: 'Visual Simulation of Smoke · SIGGRAPH 2001', url: 'https://graphics.stanford.edu/papers/smoke/' }]
      },
      {
        credit: 'Robert Bridson, Jim Hourihan & Marcus Nordenstam',
        role: 'Curl-based procedural flow, a reference for the baked noise field.',
        links: [{ label: 'Curl-Noise for Procedural Fluid Flow · SIGGRAPH 2007', url: 'https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf' }]
      },
      {
        credit: 'Keenan Crane, Ignacio Llamas & Sarah Tariq',
        role: 'Background on volume integration and scene-depth composition. FogLab’s simulated field remains 2D.',
        links: [{ label: 'Real-Time Simulation and Rendering of 3D Fluids · GPU Gems 3, 2007', url: 'https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids' }]
      }
    ],
    dependency: {
      name: 'Three.js r180 / 0.180.0',
      url: 'https://github.com/mrdoob/three.js/tree/r180',
      role: 'Rendering engine. Copyright © 2010–2025 three.js authors. MIT license.'
    },
    acknowledgments: 'ChatGPT assisted engineering and iteration. Gemini discussion contributed review ideas.',
    scope: 'An independent experiment inspired by published techniques and the original video. No affiliation with Nintendo or the reference creator. Referenced publications and video remain the work of their respective authors.',
    licenses: [
      {
        name: 'FogLab · MIT license',
        text: `MIT License

Copyright (c) 2026 Trent Sterling

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
      },
      {
        name: 'Three.js · MIT license',
        text: `The MIT License

Copyright © 2010-2025 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`
      }
    ]
  });

  function render(container) {
    if (!container || typeof container.replaceChildren !== 'function') {
      throw new TypeError('Credits.render needs a DOM container.');
    }
    const doc = container.ownerDocument;
    const node = (tag, text, className) => {
      const element = doc.createElement(tag);
      if (text) element.textContent = text;
      if (className) element.className = className;
      return element;
    };
    const link = (label, url) => {
      const element = node('a', label);
      element.href = url;
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
      return element;
    };

    const content = doc.createDocumentFragment();
    const creator = node('p', '', 'credits-creator');
    creator.append('FogLab by ', link(data.project.creator, data.project.homepage), '. ', data.project.role);
    content.append(creator, node('h3', 'Ideas & reference'));

    const references = node('ul', '', 'credits-list');
    for (const entry of data.references) {
      const item = node('li', '', 'credits-entry');
      const links = node('p', '', 'credits-links');
      entry.links.forEach((source, index) => {
        if (index) links.append(node('br'));
        links.append(link(source.label, source.url));
      });
      item.append(node('strong', entry.credit), node('p', entry.role, 'credits-role'), links);
      references.append(item);
    }
    content.append(references, node('h3', 'Built with'));
    const dependency = node('p');
    dependency.append(link(data.dependency.name, data.dependency.url), '. ', data.dependency.role);
    content.append(dependency, node('h3', 'Development acknowledgments'), node('p', data.acknowledgments, 'credits-acknowledgments'));

    const licenses = node('details', '', 'credits-license');
    licenses.append(node('summary', 'Licenses & reuse'));
    licenses.append(node('p', 'Original FogLab code and procedural assets are MIT licensed. Keep both notices when redistributing the bundled app. The full texts below are included in this file and remain available offline.'));
    for (const license of data.licenses) {
      licenses.append(node('h4', license.name), node('pre', license.text));
    }
    const source = node('p', '', 'credits-source');
    source.append(link('Source on GitHub', data.project.repository), ' · ', link('Full project credits', data.project.credits));
    content.append(licenses, node('p', data.scope, 'fine-print'), source);
    container.replaceChildren(content);
    return container;
  }

  F.Credits = Object.freeze({ data, render });
})();
