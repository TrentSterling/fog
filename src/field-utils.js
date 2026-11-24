/* Shared, DOM-free conventions for the CPU and GPU fog grids. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FogLab = root.FogLab || {};
  root.FogLab.FieldUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // X runs across a row, Z runs up the texture. These are cell-centred circular
  // footprints, not triangle collisions. Tiny obstacles need a finer grid.
  function buildObstacleMask(resolution, worldSize, obstacles = [], enabled = true) {
    const n = Math.max(1, Math.floor(resolution)), data = new Uint8Array(n * n);
    if (!enabled || !(worldSize > 0)) return data;
    const h = worldSize / n, half = worldSize * 0.5;
    for (const obstacle of obstacles) {
      const { x, z, radius } = obstacle;
      if (![x, z, radius].every(Number.isFinite) || radius <= 0) continue;
      const x0 = Math.max(0, Math.floor((x - radius + half) / h));
      const x1 = Math.min(n - 1, Math.floor((x + radius + half) / h));
      const z0 = Math.max(0, Math.floor((z - radius + half) / h));
      const z1 = Math.min(n - 1, Math.floor((z + radius + half) / h));
      for (let row = z0; row <= z1; row++) for (let column = x0; column <= x1; column++) {
        const dx = (column + 0.5) * h - half - x, dz = (row + 0.5) * h - half - z;
        if (dx * dx + dz * dz <= radius * radius) data[row * n + column] = 255;
      }
    }
    return data;
  }

  return Object.freeze({ buildObstacleMask });
});
