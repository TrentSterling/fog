/* FogLab guided experiments. MIT license.
 * Presets describe an initial experiment, not a recording of simulation state.
 */
(function () {
  'use strict';
  const F = window.FogLab = window.FogLab || {};
  const $ = id => document.getElementById(id);
  const buttons = [...document.querySelectorAll('[data-guide]')];
  const clone = value => JSON.parse(JSON.stringify(value));
  let originalPreset = null;
  let activeGuide = '';

  const explanations = {
    backends: {
      title: 'CPU / GPU · same 64² fluid grid',
      text: 'The CPU solver is on the left, GPU on the right. Both receive the same walk, slash, and landing inputs. CPU solve time and upload bytes are shown separately. Use Solo for performance measurements.'
    },
    obstacles: {
      title: 'Solid pillars · stir, slash, and land',
      text: 'The solver treats these pillar footprints as walls. Press X to sweep the fog and Space to jump. Inspect the solid obstacle mask to see its grid boundaries.'
    },
    motion: {
      title: 'Compare motion · same mesh renderer',
      text: 'Analytical, Hybrid, and Stable fluids share the camera and one mesh renderer. Follow each wake after the wanderer passes: watch its shape, spread, and persistence.'
    },
    rendering: {
      title: 'Compare rendering · same fluid field',
      text: 'Mesh on the left, volume on the right. Both read the same fluid field. Orbit the camera and watch the bank edges, height, and silhouettes.'
    },
    density: {
      title: 'Inspect the field · concentration from above',
      text: 'This is the Stable fluids density texture. Bright areas contain more fog; dark areas are gaps or clearings. The map replaces the scene across the whole view.'
    },
    beauty: {
      title: 'Back to the rendered fog',
      text: 'The same fluid settings now drive a shallow volume. The walk restarts from time zero; this is a fresh run, not a replay of the texture you just inspected.'
    }
  };

  function availability() {
    const app = F.app;
    const ready = !!(app && app.ready && typeof app.snapshotPreset === 'function' && typeof app.applyPreset === 'function');
    const unsupportedGPU = ready && app.renderReady && !app.simulationSupported;
    return { app, ready, unsupportedGPU };
  }

  function updateAvailability() {
    const { app, ready, unsupportedGPU } = availability();
    const message = !ready
      ? 'Preparing the experiment controls…'
      : unsupportedGPU
        ? 'This device can run CPU and Analytical fog, but it cannot run the texture-based GPU comparisons. You can still read the guide and explore the source.'
        : !app.renderReady
          ? 'Live rendering is unavailable here. You can still prepare an experiment, copy its link, or download the HTML to run elsewhere.'
          : '';
    buttons.forEach(button => {
      button.disabled = !ready || unsupportedGPU;
      button.title = !ready ? 'Preparing the experiment controls' : unsupportedGPU ? 'GPU simulation textures are unavailable on this device' : '';
    });
    $('learningAvailability').textContent = message;
    $('learningAvailability').hidden = !message;
    if (activeGuide) renderGuide(activeGuide);
  }

  function openLearn() {
    updateAvailability();
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      if (dialog !== $('learnDialog')) dialog.close();
    }
    if (!$('learnDialog').open) $('learnDialog').showModal();
  }

  function renderGuide(name) {
    const explanation = explanations[name];
    if (!explanation) return;
    activeGuide = name;
    $('guideBar').hidden = false;
    $('guideTitle').textContent = explanation.title;
    $('guideText').textContent = explanation.text + (F.app && !F.app.renderReady
      ? ' Preset prepared; live rendering is unavailable in this browser. Use Copy experiment link to share it.' : '');
    $('returnBeauty').hidden = name !== 'density';
    $('restoreExperiment').hidden = !originalPreset;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.guide === name)));
  }

  function reportError(error) {
    const message = 'Could not prepare the experiment: ' + (error && error.message || String(error));
    $('guideBar').hidden = false;
    $('guideTitle').textContent = 'The experiment could not start';
    $('guideText').textContent = message;
    $('learningAvailability').hidden = false;
    $('learningAvailability').textContent = message;
    F.app?.showToast?.(message);
  }

  function comparisonPreset() {
    // Start with a complete, normalized snapshot, then make every visible
    // comparison choice explicit. Quality stays at the user's current level.
    const preset = clone(F.app.snapshotPreset());
    Object.assign(preset.settings, {
      density: 1.25, height: 1.22, radius: 1.35, strength: 1.20,
      swirl: 0.8, persistence: 5.2, wind: 0.32, pressure: 18, vorticity: 0.38,
      terrain: 'flat', lighting: 'reference', environment: 'reference',
      paused: false, debug: 'beauty', wireframe: false, meshLayers: 1
      ,obstacles:true,obstacleCourse:false,wakeStyle:'paired',densityProfile:'billows',heightMode:'world',detailStrength:1,heightShear:1,wispStrength:1,lightingModel:'directional'
    });
    Object.assign(preset.view, {
      mode: 'fluid', renderer: 'mesh', layout: 'single',
      compareMode: 'fluid', compareRenderer: 'same', actorCount: 1, auto: true
    });
    preset.camera = { theta: 0.38, phi: 1.14, distance: 11.5, mode: 3 };
    return preset;
  }

  function runGuide(name) {
    if (!explanations[name]) return;
    const { app, ready, unsupportedGPU } = availability();
    if (!ready || unsupportedGPU) { updateAvailability(); return; }
    try {
      const before = originalPreset || clone(app.snapshotPreset());
      const preset = comparisonPreset();
      if (name === 'motion') {
        preset.view.layout = 'triple';
        preset.view.mode = 'analytical';
      } else if (name === 'rendering') {
        preset.view.layout = 'compare';
        preset.view.compareRenderer = 'raymarch';
      } else if (name === 'backends') {
        preset.settings.quality='low';Object.assign(preset.settings,{resolution:64,raySteps:20,renderScale:.6});
        preset.view.mode='cpu';preset.view.compareMode='fluid';preset.view.layout='compare';
      } else if (name === 'obstacles') {
        preset.settings.obstacleCourse=true;preset.view.renderer='raymarch';
        preset.camera={theta:.25,phi:.83,distance:16,mode:0};
      } else if (name === 'density') {
        preset.settings.debug = 'density';
        preset.view.renderer = 'raymarch';
      }
      app.applyPreset(preset, { silent: true, source: 'guided-' + name });
      originalPreset = before;
      $('learnDialog').close();
      if (innerWidth <= 760) document.body.classList.add('mobile-panel-hidden');
      renderGuide(name);
      // Keep keyboard focus visible after a modal action closes its dialog.
      document.querySelector('#guideBar [data-guide="' + name + '"]')?.focus({ preventScroll: true });
      app.showToast?.(app.renderReady ? 'Experiment reset · automatic walk on' : 'Preset prepared · live rendering unavailable');
    } catch (error) { reportError(error); }
  }

  buttons.forEach(button => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => runGuide(button.dataset.guide));
  });
  $('learnButton').addEventListener('click', openLearn);
  $('errorLearn').addEventListener('click', openLearn);
  $('closeLearn').addEventListener('click', () => $('learnDialog').close());
  $('learnCredits').addEventListener('click', () => {
    $('learnDialog').close();
    $('helpButton').click();
  });
  $('learnDialog').addEventListener('click', event => {
    if (event.target !== $('learnDialog')) return;
    const r = $('learnDialog').getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('learnDialog').close();
  });
  $('dismissGuide').addEventListener('click', () => {
    $('guideBar').hidden = true;
    $('learnButton').focus({ preventScroll: true });
  });
  $('returnBeauty').addEventListener('click', () => {
    try {
      const preset = clone(F.app.snapshotPreset());
      Object.assign(preset.settings, { debug: 'beauty', paused: false });
      Object.assign(preset.view, { mode: 'fluid', renderer: 'raymarch', layout: 'single', auto: true });
      F.app.applyPreset(preset, { silent: true, source: 'guided-beauty' });
      renderGuide('beauty');
      $('restoreExperiment').focus({ preventScroll: true });
    } catch (error) { reportError(error); }
  });
  $('restoreExperiment').addEventListener('click', () => {
    if (!originalPreset) return;
    try {
      F.app.applyPreset(clone(originalPreset), { silent: true, source: 'guided-restore' });
      originalPreset = null;
      activeGuide = '';
      $('guideTitle').textContent = 'Your view is restored';
      $('guideText').textContent = 'The settings and camera are back where you left them. The simulation starts fresh from time zero.';
      $('returnBeauty').hidden = true;
      $('restoreExperiment').hidden = true;
      buttons.forEach(button => button.setAttribute('aria-pressed', 'false'));
      document.querySelector('#guideBar [data-guide="motion"]')?.focus({ preventScroll: true });
    } catch (error) { reportError(error); }
  });

  // A saved HTML already contains all runtime assets. Its download action can
  // fetch the latest published file without trying to read a neighbouring file.
  if (location.protocol === 'file:') {
    document.querySelectorAll('#downloadHtml, [data-download-html]').forEach(link => {
      link.href = 'https://tront.xyz/fog/FogLab.html';
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Download the latest published HTML (requires a connection)';
      link.removeAttribute('download');
    });
  }
  window.addEventListener('foglab:ready', updateAvailability);
  updateAvailability();
})();
