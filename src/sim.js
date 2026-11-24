/* FogLab FieldSimulation
 * Independent WebGL2 motion backends, all state on the GPU.
 * RG = velocity in world units / second; B = concentration; A = disturbance.
 * Hybrid: one advection / forcing / recovery pass, no pressure projection.
 * Fluid: semi-Lagrangian velocity + forcing + curl + confinement + divergence
 *        + Jacobi pressure + projection + semi-Lagrangian concentration.
 * Equations follow Stam / Harris; this implementation is original FogLab code.
 */
(function () {
  'use strict';
  window.FogLab = window.FogLab || {};
  const THREE = window.THREE;

  const VERTEX = `
    varying vec2 vUv;
    void main() {
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  // Shared by the analytical renderer and both simulation backends. Broad
  // concentration is the transported material itself, not an unrelated
  // decorative cloud texture multiplied over a nearly uniform simulation.
  // With the four-cell R atlas, 0.055 world scaling gives ~4.5 m banks.
  // The eight-cell G atlas at 0.105 supplies ~1.2 m billows. Both scales are
  // stored in concentration and advected; the renderer does not paint them on.
  const FOG_BANK_GLSL = `
    float fogBankDensity(vec2 worldXZ) {
      vec2 warp = (texture2D(uNoise, worldXZ * 0.021 + vec2(0.31, 0.71)).ba * 2.0 - 1.0) * 0.95;
      vec2 q = worldXZ + warp;
      float broad = texture2D(uNoise, q * 0.055 + vec2(0.19, 0.37)).r;
      vec2 curl = texture2D(uNoise, worldXZ * 0.065 + vec2(0.63, 0.29)).ba * 2.0 - 1.0;
      float medium = texture2D(uNoise, q * 0.105 + curl * 0.045 + vec2(0.47, 0.13)).g;
      // The broad envelope can reach full coverage while medium concentration
      // remains continuous, avoiding the former constant-density white pools.
      return 1.6 * smoothstep(0.36, 0.82, broad) * (0.20 + 0.80 * medium);
    }
  `;

  // One common field convention keeps the cheap approximation and solver
  // interchangeable with all FogLab renderers.
  const COMMON = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uState;
    uniform sampler2D uVelocity;
    uniform sampler2D uPressure;
    uniform sampler2D uCurl;
    uniform sampler2D uDivergence;
    uniform sampler2D uNoise;
    uniform sampler2D uObstacles;
    uniform vec2 uTexel;
    uniform float uWorld;
    uniform float uDt;
    uniform float uTime;
    uniform float uWind;
    uniform float uSwirl;
    uniform float uVorticity;
    uniform float uPersistence;
    uniform float uStrength;
    uniform float uFirstPressure;
    uniform int uActorCount;
    uniform int uWakeStyle;
    uniform int uSegmentCount;
    uniform vec4 uActors[8];
    uniform vec4 uMotion[8];
    uniform vec4 uSegments[8];
    uniform vec4 uSegmentParams[8];
    uniform vec4 uSegmentAux[8];

    ${FOG_BANK_GLSL}

    vec2 safeUV(vec2 uv) {
      return clamp(uv, uTexel * 0.5, vec2(1.0) - uTexel * 0.5);
    }

    float solidAt(vec2 uv) {
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
      return step(0.5, texture2D(uObstacles, safeUV(uv)).r);
    }

    // Stop at the first solid cell along the backtrace. Merely rejecting a
    // solid endpoint lets fast flow tunnel across an obstacle to its far side.
    // With dt <= 0.05 s, speed <= 10 m/s and N <= 512, 32 half-cell samples
    // cover the longest permitted characteristic in this 32 m field.
    vec2 traceUV(vec2 origin, vec2 target) {
      target = safeUV(target);
      vec2 cells = abs(target - origin) / uTexel;
      float count = clamp(ceil(max(cells.x, cells.y) * 2.0), 1.0, 32.0);
      vec2 previous = origin;
      for (int i = 1; i <= 32; i++) {
        if (float(i) > count) break;
        vec2 probe = mix(origin, target, float(i) / count);
        if (solidAt(probe) > 0.5) return previous;
        previous = probe;
      }
      return target;
    }

    // Explicit bilinear backtracing is independent of filter state and is also
    // useful when this solver is ported to other half-float texture APIs.
    vec4 bilerp(sampler2D field, vec2 uv) {
      vec2 q = safeUV(uv) / uTexel - 0.5;
      vec2 i = floor(q);
      vec2 f = fract(q);
      vec2 p = (i + 0.5) * uTexel;
      vec4 a = texture2D(field, safeUV(p));
      vec4 b = texture2D(field, safeUV(p + vec2(uTexel.x, 0.0)));
      vec4 c = texture2D(field, safeUV(p + vec2(0.0, uTexel.y)));
      vec4 d = texture2D(field, safeUV(p + uTexel));
      vec4 weights = vec4((1.0-f.x)*(1.0-f.y),f.x*(1.0-f.y),(1.0-f.x)*f.y,f.x*f.y);
      weights *= vec4(1.0-solidAt(p),1.0-solidAt(p+vec2(uTexel.x,0.0)),
                      1.0-solidAt(p+vec2(0.0,uTexel.y)),1.0-solidAt(p+uTexel));
      float total = dot(weights,vec4(1.0));
      return total > 0.00001 ? (a*weights.x+b*weights.y+c*weights.z+d*weights.w)/total : texture2D(field,vUv);
    }

    float equilibrium(vec2 uv) {
      return fogBankDensity((uv - 0.5) * uWorld);
    }

    // Curl of one scalar texture potential, evaluated in world units.
    // The base flow is divergence-free before discretization / boundaries.
    vec2 ambientVelocity(vec2 uv) {
      vec2 q = uv * 2.0 + vec2(0.004, -0.0027) * uTime;
      vec2 d = uTexel * 2.0;
      float l = texture2D(uNoise, q - vec2(d.x, 0.0)).r;
      float r = texture2D(uNoise, q + vec2(d.x, 0.0)).r;
      float b = texture2D(uNoise, q - vec2(0.0, d.y)).r;
      float t = texture2D(uNoise, q + vec2(0.0, d.y)).r;
      vec2 curl = vec2(t - b, l - r) / (2.0 * uWorld * uTexel.x);
      return uWind * (vec2(0.35, 0.13) + curl * 1.8);
    }

    vec2 boundVelocity(vec2 velocity, vec2 uv) {
      // Cell-centred free-slip approximation: block normal flow next to a
      // rasterized rock or domain wall, leaving tangential velocity free.
      if (solidAt(uv) > 0.5) return vec2(0.0);
      if (solidAt(uv-vec2(uTexel.x,0.0)) + solidAt(uv+vec2(uTexel.x,0.0)) > 0.5) velocity.x = 0.0;
      if (solidAt(uv-vec2(0.0,uTexel.y)) + solidAt(uv+vec2(0.0,uTexel.y)) > 0.5) velocity.y = 0.0;
      float speed = length(velocity);
      return velocity * min(1.0, 10.0 / max(speed, 0.0001));
    }

    float capsuleDistance(vec2 p, vec2 start, vec2 finish) {
      vec2 ab = finish - start;
      float t = clamp(dot(p - start, ab) / max(dot(ab, ab), 0.00001), 0.0, 1.0);
      return length(p - start - ab * t);
    }

    vec2 capsuleOffset(vec2 p, vec4 segment) {
      vec2 ab = segment.zw - segment.xy;
      float t = clamp(dot(p-segment.xy,ab)/max(dot(ab,ab),0.00001),0.0,1.0);
      return p-segment.xy-ab*t;
    }

    vec2 addActorForces(vec2 velocity, vec2 p) {
      for (int i = 0; i < 8; i++) {
        if (i >= uActorCount) break;
        vec4 actor = uActors[i];
        vec2 motion = uMotion[i].xy;
        float originalSpeed = length(motion);
        float speed = min(originalSpeed, 9.0);
        motion *= min(1.0, 9.0 / max(originalSpeed, 0.001));
        float radius = max(actor.z, 0.2);
        float power = actor.w * uStrength;
        vec2 d = p - actor.xy;
        float len = length(d);
        vec2 dir = motion / max(speed, 0.001);
        vec2 side = vec2(-dir.y, dir.x);
        float body = exp(-dot(d, d) / (radius * radius * 0.58));
        // Entrained motion plus radial push. A stationary body clears fog,
        // but does not create perpetual momentum or a circular water fountain.
        velocity += (motion * 3.6 + d / max(len, 0.08) * speed * 2.8)
                  * body * uDt * power;

        // A pair of counter-rotating, moving wake impulses. The fluid solver
        // then transports / projects them; hybrid transports / damps them.
        vec2 center = actor.xy - dir * radius * 0.7;
        vec2 dl = p - (center + side * radius * 0.8);
        vec2 dr = p - (center - side * radius * 0.8);
        float falloff = max(radius * radius * 1.1, 0.01);
        vec2 pair = vec2(-dl.y, dl.x) * exp(-dot(dl, dl) / falloff)
                  - vec2(-dr.y, dr.x) * exp(-dot(dr, dr) / falloff);
        if (uWakeStyle == 0) {
          velocity += pair * (speed / radius) * uSwirl * power * uDt * 4.6;
        } else if (uWakeStyle == 2) {
          velocity += vec2(-d.y,d.x)/max(len,0.08) * speed * uSwirl * power * uDt * 4.6 * body;
        }
      }
      // Slashes are swept capsules with a direction and a signed swirl, not
      // a chain of point stamps. All force terms are accelerations times dt.
      for (int i = 0; i < 8; i++) {
        if (i >= uSegmentCount) break;
        vec4 params = uSegmentParams[i];
        vec2 offset = capsuleOffset(p,uSegments[i]);
        float radius = max(params.x,0.12),distance = length(offset);
        float falloff = exp(-dot(offset,offset)/(radius*radius*0.72));
        vec2 motion = params.zw;
        motion *= min(1.0,12.0/max(length(motion),0.001));
        vec2 tangent = vec2(-offset.y,offset.x)/max(distance,0.08);
        velocity += (motion*4.5 + tangent*uSegmentAux[i].x*4.0)
                    * falloff * max(params.y,0.0) * uStrength * uDt;
      }
      return velocity;
    }

    vec2 densityAndEnergy(vec4 previous, vec2 p, vec2 uv) {
      if (solidAt(uv) > 0.5) return vec2(0.0);
      float density = previous.b;
      float energy = previous.a * exp(-uDt / max(uPersistence * 0.65, 0.2));
      float rest = equilibrium(uv);
      // Explicit exponential recovery is stable for every user-selected dt.
      // A slow reservoir replenishes the field without pinning the transported
      // cloud pattern to its original noise coordinates every few seconds.
      // Semi-Lagrangian interpolation supplies the numerical diffusion; no
      // extra blur pass is applied to the broad transported concentration.
      density = mix(density, rest, 1.0 - exp(-uDt / max(uPersistence * 2.5, 1.5)));
      for (int i = 0; i < 8; i++) {
        if (i >= uActorCount) break;
        vec4 actor = uActors[i];
        vec2 motion = uMotion[i].xy;
        float speed = min(length(motion), 9.0);
        float radius = max(actor.z, 0.2);
        float power = actor.w * uStrength;
        float d = capsuleDistance(p, actor.xy - motion * uDt, actor.xy);
        float clearing = exp(-pow(d / (radius * 0.73), 4.0));
        // A clear center, with material gathered into soft, mobile shoulders.
        float desired = rest * (1.0 - 0.985 * clearing);
        density = mix(density, min(density, desired),
                      1.0 - exp(-uDt * 20.0 * power));
        float ring = exp(-pow((d - radius * 0.98) / (radius * 0.28), 2.0));
        // Gather only material already present. Stamping a bright ring into an
        // empty bank gap would look like a foam decal instead of displaced fog.
        density += ring * min(speed, 5.0) * power * uDt * 0.16 * clamp(previous.b, 0.0, 1.2);
        energy = max(energy, max(clearing * 0.75, ring) * min(1.0, power));
      }
      for (int i = 0; i < 8; i++) {
        if (i >= uSegmentCount) break;
        vec4 params = uSegmentParams[i];
        float radius = max(params.x,0.12),power = max(params.y,0.0)*uStrength;
        float d = length(capsuleOffset(p,uSegments[i]));
        float clearing = exp(-pow(d/(radius*0.8),4.0));
        float desired = rest*(1.0-0.995*clearing);
        density = mix(density,min(density,desired),1.0-exp(-uDt*32.0*power));
        float shoulder = exp(-pow((d-radius)/(radius*0.32),2.0));
        density += shoulder*min(length(params.zw),8.0)*power*uDt*0.12*clamp(previous.b,0.0,1.2);
        energy = max(energy,max(clearing,shoulder)*min(power,1.0));
      }
      return vec2(clamp(density, 0.0, 1.65), clamp(energy, 0.0, 1.0));
    }
  `;

  const FRAGMENTS = {
    initialize: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        gl_FragColor = vec4(boundVelocity(ambientVelocity(vUv),vUv), equilibrium(vUv), 0.0);
      }
    `,
    zero: `void main() { gl_FragColor = vec4(0.0); }`,
    hybrid: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        vec2 velocity = texture2D(uState, vUv).rg;
        vec4 previous = bilerp(uState, traceUV(vUv,vUv - uDt * velocity / uWorld));
        velocity = mix(previous.rg, ambientVelocity(vUv), 1.0 - exp(-uDt * 0.7));
        velocity = addActorForces(velocity, (vUv - 0.5) * uWorld);
        velocity = boundVelocity(velocity, vUv);
        vec2 de = densityAndEnergy(previous, (vUv - 0.5) * uWorld, vUv);
        gl_FragColor = vec4(velocity, de);
      }
    `,
    advectVelocity: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        vec2 velocity = texture2D(uVelocity, vUv).rg;
        velocity = bilerp(uVelocity, traceUV(vUv,vUv - uDt * velocity / uWorld)).rg;
        velocity *= exp(-uDt * 0.095);
        gl_FragColor = vec4(boundVelocity(velocity, vUv), 0.0, 0.0);
      }
    `,
    force: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        vec2 velocity = texture2D(uVelocity, vUv).rg;
        velocity = mix(velocity, ambientVelocity(vUv), 1.0 - exp(-uDt * 0.12));
        velocity = addActorForces(velocity, (vUv - 0.5) * uWorld);
        gl_FragColor = vec4(boundVelocity(velocity, vUv), 0.0, 0.0);
      }
    `,
    curl: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        vec2 center = texture2D(uVelocity,vUv).rg;
        float l = texture2D(uVelocity, safeUV(vUv - vec2(uTexel.x, 0.0))).g;
        float r = texture2D(uVelocity, safeUV(vUv + vec2(uTexel.x, 0.0))).g;
        float b = texture2D(uVelocity, safeUV(vUv - vec2(0.0, uTexel.y))).r;
        float t = texture2D(uVelocity, safeUV(vUv + vec2(0.0, uTexel.y))).r;
        // Free-slip ghost values preserve the tangent component at a wall.
        if (solidAt(vUv-vec2(uTexel.x,0.0)) > 0.5) l = center.y;
        if (solidAt(vUv+vec2(uTexel.x,0.0)) > 0.5) r = center.y;
        if (solidAt(vUv-vec2(0.0,uTexel.y)) > 0.5) b = center.x;
        if (solidAt(vUv+vec2(0.0,uTexel.y)) > 0.5) t = center.x;
        float curl = (r - l - t + b) / (2.0 * uWorld * uTexel.x);
        gl_FragColor = vec4(curl, 0.0, 0.0, 1.0);
      }
    `,
    confinement: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        float l = abs(texture2D(uCurl, safeUV(vUv - vec2(uTexel.x, 0.0))).r);
        float r = abs(texture2D(uCurl, safeUV(vUv + vec2(uTexel.x, 0.0))).r);
        float b = abs(texture2D(uCurl, safeUV(vUv - vec2(0.0, uTexel.y))).r);
        float t = abs(texture2D(uCurl, safeUV(vUv + vec2(0.0, uTexel.y))).r);
        float omega = texture2D(uCurl, vUv).r;
        vec2 gradient = vec2(r - l, t - b);
        gradient /= max(length(gradient), 0.0001);
        vec2 force = vec2(gradient.y, -gradient.x) * omega;
        // h scaling is the customary grid-dependent confinement factor.
        force *= uVorticity * 7.0 * (uWorld * uTexel.x);
        vec2 velocity = texture2D(uVelocity, vUv).rg + uDt * clamp(force, -12.0, 12.0);
        gl_FragColor = vec4(boundVelocity(velocity, vUv), 0.0, 0.0);
      }
    `,
    divergence: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        vec2 center = texture2D(uVelocity, vUv).rg;
        float l = texture2D(uVelocity, safeUV(vUv - vec2(uTexel.x, 0.0))).r;
        float r = texture2D(uVelocity, safeUV(vUv + vec2(uTexel.x, 0.0))).r;
        float b = texture2D(uVelocity, safeUV(vUv - vec2(0.0, uTexel.y))).g;
        float t = texture2D(uVelocity, safeUV(vUv + vec2(0.0, uTexel.y))).g;
        if (solidAt(vUv-vec2(uTexel.x,0.0)) > 0.5) l = -center.x;
        if (solidAt(vUv+vec2(uTexel.x,0.0)) > 0.5) r = -center.x;
        if (solidAt(vUv-vec2(0.0,uTexel.y)) > 0.5) b = -center.y;
        if (solidAt(vUv+vec2(0.0,uTexel.y)) > 0.5) t = -center.y;
        float div = (r - l + t - b) / (2.0 * uWorld * uTexel.x);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
      }
    `,
    pressure: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        float l = texture2D(uPressure, safeUV(vUv - vec2(uTexel.x, 0.0))).r;
        float r = texture2D(uPressure, safeUV(vUv + vec2(uTexel.x, 0.0))).r;
        float b = texture2D(uPressure, safeUV(vUv - vec2(0.0, uTexel.y))).r;
        float t = texture2D(uPressure, safeUV(vUv + vec2(0.0, uTexel.y))).r;
        float divergence = texture2D(uDivergence, vUv).r;
        float h = uWorld * uTexel.x;
        vec4 open = vec4(1.0-solidAt(vUv-vec2(uTexel.x,0.0)),1.0-solidAt(vUv+vec2(uTexel.x,0.0)),
                         1.0-solidAt(vUv-vec2(0.0,uTexel.y)),1.0-solidAt(vUv+vec2(0.0,uTexel.y)));
        float neighbors = dot(open,vec4(1.0));
        // Excluding solid faces imposes zero normal pressure derivative. This
        // is a masked Poisson equation, not pressure multiplied by a mask.
        float sum = dot(vec4(l,r,b,t),open)*(1.0-uFirstPressure);
        float p = neighbors > 0.5 ? (sum-divergence*h*h)/neighbors : 0.0;
        gl_FragColor = vec4(p, 0.0, 0.0, 1.0);
      }
    `,
    project: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        float l = texture2D(uPressure, safeUV(vUv - vec2(uTexel.x, 0.0))).r;
        float r = texture2D(uPressure, safeUV(vUv + vec2(uTexel.x, 0.0))).r;
        float b = texture2D(uPressure, safeUV(vUv - vec2(0.0, uTexel.y))).r;
        float t = texture2D(uPressure, safeUV(vUv + vec2(0.0, uTexel.y))).r;
        float center = texture2D(uPressure,vUv).r;
        if (solidAt(vUv-vec2(uTexel.x,0.0)) > 0.5) l = center;
        if (solidAt(vUv+vec2(uTexel.x,0.0)) > 0.5) r = center;
        if (solidAt(vUv-vec2(0.0,uTexel.y)) > 0.5) b = center;
        if (solidAt(vUv+vec2(0.0,uTexel.y)) > 0.5) t = center;
        vec2 velocity = texture2D(uVelocity, vUv).rg;
        velocity -= vec2(r - l, t - b) / (2.0 * uWorld * uTexel.x);
        gl_FragColor = vec4(boundVelocity(velocity, vUv), 0.0, 0.0);
      }
    `,
    advectDensity: `
      void main() {
        if (solidAt(vUv) > 0.5) { gl_FragColor = vec4(0.0); return; }
        vec2 velocity = texture2D(uVelocity, vUv).rg;
        vec4 previous = bilerp(uState, traceUV(vUv,vUv - uDt * velocity / uWorld));
        vec2 de = densityAndEnergy(previous, (vUv - 0.5) * uWorld, vUv);
        gl_FragColor = vec4(velocity, de);
      }
    `
  };

  class FieldSimulation {
    constructor(renderer, noiseTexture, options = {}) {
      this.renderer = renderer;
      this.noiseTexture = noiseTexture;
      this.mode = options.mode === 'fluid' ? 'fluid' : 'hybrid';
      this.resolution = Math.max(32, Math.min(512, Math.round(options.resolution || 128)));
      this.worldSize = options.worldSize || 32;
      this.passCount = 0;
      this.totalPassCount = 0;
      this.supported = !!renderer.getContext().getExtension('EXT_color_buffer_float');
      this.unsupportedReason = this.supported ? '' : 'RGBA16F render targets require EXT_color_buffer_float.';
      this.disposed = false;
      this._targets = [];
      this._state = [];
      this._velocity = [];
      this._pressure = [];
      this._stateIndex = this._velocityIndex = this._pressureIndex = 0;
      this._fallback = new THREE.DataTexture(new Uint8Array([0, 0, 210, 0]), 1, 1, THREE.RGBAFormat);
      this._fallback.needsUpdate = true;
      this._fallback.colorSpace = THREE.NoColorSpace;
      this._obstacles = [];
      this._obstaclesEnabled = true;
      this._obstacleKey = '';
      this._rebuildObstacleTexture();

      this.uniforms = {
        uState: { value: this._fallback }, uVelocity: { value: this._fallback },
        uPressure: { value: this._fallback }, uCurl: { value: this._fallback },
        uDivergence: { value: this._fallback }, uNoise: { value: noiseTexture }, uObstacles: { value: this._obstacleTexture },
        uTexel: { value: new THREE.Vector2(1 / this.resolution, 1 / this.resolution) },
        uWorld: { value: this.worldSize }, uDt: { value: 1 / 30 },
        uTime: { value: 0 }, uWind: { value: 0.4 }, uSwirl: { value: 0.8 },
        uVorticity: { value: 0.4 }, uPersistence: { value: 5 }, uStrength: { value: 1 },
        uFirstPressure: { value: 1 }, uActorCount: { value: 0 }, uWakeStyle: { value: 0 }, uSegmentCount: { value: 0 },
        uActors: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
        uMotion: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
        uSegments: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
        uSegmentParams: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
        uSegmentAux: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }
      };
      this.materials = {};
      for (const name of Object.keys(FRAGMENTS)) {
        this.materials[name] = new THREE.ShaderMaterial({
          name: 'FogLab simulation / ' + name,
          uniforms: this.uniforms,
          vertexShader: VERTEX,
          fragmentShader: COMMON + FRAGMENTS[name],
          depthTest: false,
          depthWrite: false,
          blending: THREE.NoBlending,
          toneMapped: false
        });
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      this._quad = new THREE.Mesh(geometry, this.materials.zero);
      this._quad.frustumCulled = false;
      this._scene = new THREE.Scene();
      this._scene.add(this._quad);
      this._camera = new THREE.Camera();
      if (this.supported) {
        this._allocate();
        this.reset();
      }
    }

    get texture() { return this._state[this._stateIndex]?.texture || this._fallback; }
    get velocityTexture() {
      return this.mode === 'fluid' ? (this._velocity[this._velocityIndex]?.texture || this._fallback) : this.texture;
    }
    get pressureTexture() { return this._pressure[this._pressureIndex]?.texture || null; }
    get curlTexture() { return this._curl?.texture || null; }
    get divergenceTexture() { return this._divergence?.texture || null; }
    get obstacleTexture() { return this._obstacleTexture; }
    get targetMemoryBytes() { return this._targets.length * this.resolution * this.resolution * 8; }
    get obstacleMemoryBytes() { return this._obstacleMask.byteLength; }
    get memoryBytes() { return this.targetMemoryBytes + this.obstacleMemoryBytes; }

    _rebuildObstacleTexture() {
      this._obstacleMask = window.FogLab.FieldUtils.buildObstacleMask(this.resolution,this.worldSize,this._obstacles,this._obstaclesEnabled);
      if (this._obstacleTexture?.image.width === this.resolution) {
        this._obstacleTexture.image.data = this._obstacleMask;
        this._obstacleTexture.needsUpdate = true;
        return;
      }
      this._obstacleTexture?.dispose();
      this._obstacleTexture = new THREE.DataTexture(this._obstacleMask,this.resolution,this.resolution,THREE.RedFormat,THREE.UnsignedByteType);
      this._obstacleTexture.minFilter = this._obstacleTexture.magFilter = THREE.NearestFilter;
      this._obstacleTexture.wrapS = this._obstacleTexture.wrapT = THREE.ClampToEdgeWrapping;
      this._obstacleTexture.colorSpace = THREE.NoColorSpace;
      this._obstacleTexture.generateMipmaps = false;
      this._obstacleTexture.needsUpdate = true;
      this._obstacleTexture.name = 'FogLab '+this.mode+' solid footprints';
      if (this.uniforms) this.uniforms.uObstacles.value = this._obstacleTexture;
    }

    setObstacles(obstacles = [], enabled = true) {
      if (this.disposed) return;
      const next = obstacles.filter(o=>o && [o.x,o.z,o.radius].every(Number.isFinite) && o.radius>0)
        .map(o=>({x:o.x,z:o.z,radius:o.radius}));
      const key = JSON.stringify([!!enabled,next]);
      if (key === this._obstacleKey) return;
      this._obstacleKey = key;
      this._obstacles = next;
      this._obstaclesEnabled = !!enabled;
      this._rebuildObstacleTexture();
      // A changed boundary invalidates the old pressure and can cover occupied
      // cells. Restart rather than retaining fog inside a newly solid rock.
      this.reset();
    }

    _target(name, linear = false) {
      const target = new THREE.WebGLRenderTarget(this.resolution, this.resolution, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
        magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false, stencilBuffer: false,
        generateMipmaps: false
      });
      target.texture.name = 'FogLab ' + this.mode + ' ' + name;
      target.texture.colorSpace = THREE.NoColorSpace;
      this._targets.push(target);
      return target;
    }

    _allocate() {
      this._state = [this._target('state A', true), this._target('state B', true)];
      if (this.mode === 'fluid') {
        this._velocity = [this._target('velocity A', true), this._target('velocity B', true)];
        this._pressure = [this._target('pressure A'), this._target('pressure B')];
        this._curl = this._target('curl');
        this._divergence = this._target('divergence');
      }
    }

    _saveRenderer() {
      const r = this.renderer;
      return {
        target: r.getRenderTarget(), viewport: r.getViewport(new THREE.Vector4()),
        scissor: r.getScissor(new THREE.Vector4()), scissorTest: r.getScissorTest(),
        autoClear: r.autoClear, xr: r.xr.enabled
      };
    }

    _restoreRenderer(saved) {
      const r = this.renderer;
      r.setRenderTarget(saved.target);
      r.setViewport(saved.viewport);
      r.setScissor(saved.scissor);
      r.setScissorTest(saved.scissorTest);
      r.autoClear = saved.autoClear;
      r.xr.enabled = saved.xr;
    }

    _draw(name, target) {
      const r = this.renderer;
      this._quad.material = this.materials[name];
      r.setRenderTarget(target);
      // setRenderTarget applies the target's pixel-sized viewport. Calling
      // renderer.setViewport here would apply the display pixel ratio again.
      r.setScissorTest(false);
      r.render(this._scene, this._camera);
      this.passCount++;
      this.totalPassCount++;
    }

    reset() {
      if (!this.supported || this.disposed) return;
      const saved = this._saveRenderer();
      try {
        this.renderer.autoClear = false;
        this.renderer.xr.enabled = false;
        this._stateIndex = this._velocityIndex = this._pressureIndex = 0;
        this.uniforms.uActorCount.value = 0;
        this.uniforms.uSegmentCount.value = 0;
        this.uniforms.uTime.value = 0;
        for (const target of this._state) this._draw('initialize', target);
        for (const target of this._velocity) this._draw('initialize', target);
        for (const target of this._pressure) this._draw('zero', target);
        if (this._curl) this._draw('zero', this._curl);
        if (this._divergence) this._draw('zero', this._divergence);
      } finally {
        this._restoreRenderer(saved);
        this.passCount = 0;
      }
    }

    setResolution(resolution) {
      const n = Math.max(32, Math.min(512, Math.round(resolution)));
      if (n === this.resolution || this.disposed) return;
      for (const target of this._targets) target.dispose();
      this._targets = [];
      this._state = []; this._velocity = []; this._pressure = [];
      this._curl = this._divergence = null;
      this.resolution = n;
      this.uniforms.uTexel.value.set(1 / n, 1 / n);
      this._rebuildObstacleTexture();
      if (this.supported) this._allocate();
      this.reset();
    }

    step(dt, time, interactors = [], settings = {}, segments = []) {
      if (!this.supported || this.disposed || !(dt > 0)) { this.passCount = 0; return; }
      const u = this.uniforms;
      u.uDt.value = Math.min(dt, 1 / 20);
      u.uTime.value = time;
      u.uWind.value = settings.wind ?? 0.4;
      u.uSwirl.value = settings.swirl ?? 0.8;
      u.uVorticity.value = settings.vorticity ?? 0.4;
      u.uPersistence.value = settings.persistence ?? 5;
      u.uStrength.value = settings.strength ?? 1;
      u.uWakeStyle.value = settings.wakeStyle === 'radial' ? 1 : settings.wakeStyle === 'tangential' ? 2 : 0;
      const count = Math.min(8, interactors.length);
      u.uActorCount.value = count;
      for (let i = 0; i < count; i++) {
        const a = interactors[i];
        u.uActors.value[i].set(a.x || 0, a.z || 0, a.radius ?? settings.radius ?? 1.15, a.strength ?? 1);
        u.uMotion.value[i].set(a.vx || 0, a.vz || 0, 0, 0);
      }
      u.uSegmentCount.value = Math.min(8,segments.length);
      for (let i = 0; i < u.uSegmentCount.value; i++) {
        const segment = segments[i];
        u.uSegments.value[i].set(segment.x0||0,segment.z0||0,segment.x1||0,segment.z1||0);
        u.uSegmentParams.value[i].set(segment.radius??0.45,segment.strength??1,segment.vx||0,segment.vz||0);
        u.uSegmentAux.value[i].set(segment.swirl??1,0,0,0);
      }
      const saved = this._saveRenderer();
      this.passCount = 0;
      try {
        this.renderer.autoClear = false;
        this.renderer.xr.enabled = false;
        u.uState.value = this.texture;
        if (this.mode === 'hybrid') {
          this._draw('hybrid', this._state[1 - this._stateIndex]);
          this._stateIndex = 1 - this._stateIndex;
          return;
        }

        u.uVelocity.value = this.velocityTexture;
        this._draw('advectVelocity', this._velocity[1 - this._velocityIndex]);
        this._velocityIndex = 1 - this._velocityIndex;
        u.uVelocity.value = this.velocityTexture;
        this._draw('force', this._velocity[1 - this._velocityIndex]);
        this._velocityIndex = 1 - this._velocityIndex;

        u.uVelocity.value = this.velocityTexture;
        this._draw('curl', this._curl);
        u.uCurl.value = this._curl.texture;
        if (u.uVorticity.value > 0.001) {
          this._draw('confinement', this._velocity[1 - this._velocityIndex]);
          this._velocityIndex = 1 - this._velocityIndex;
        }

        u.uVelocity.value = this.velocityTexture;
        this._draw('divergence', this._divergence);
        u.uDivergence.value = this._divergence.texture;
        const iterations = Math.max(2, Math.min(40, Math.round(settings.pressure ?? 14)));
        for (let i = 0; i < iterations; i++) {
          u.uPressure.value = this.pressureTexture;
          u.uFirstPressure.value = i === 0 ? 1 : 0;
          this._draw('pressure', this._pressure[1 - this._pressureIndex]);
          this._pressureIndex = 1 - this._pressureIndex;
        }
        u.uPressure.value = this.pressureTexture;
        this._draw('project', this._velocity[1 - this._velocityIndex]);
        this._velocityIndex = 1 - this._velocityIndex;
        u.uVelocity.value = this.velocityTexture;
        this._draw('advectDensity', this._state[1 - this._stateIndex]);
        this._stateIndex = 1 - this._stateIndex;
      } finally {
        this._restoreRenderer(saved);
      }
    }

    // Deliberately opt-in: synchronous GPU readback is a diagnostic, never part
    // of the animation loop. It checks real shader outputs, including whether
    // projection actually reduces discrete divergence, without a CPU solver.
    getDiagnostics() {
      if (!this.supported || this.disposed) return { supported: false, reason: this.unsupportedReason };
      const n = this.resolution;
      const read = (target) => {
        const raw = new Uint16Array(n * n * 4);
        this.renderer.readRenderTargetPixels(target, 0, 0, n, n, raw);
        return Float32Array.from(raw, THREE.DataUtils.fromHalfFloat);
      };
      const state = read(this._state[this._stateIndex]);
      let finite = true, densityMin = Infinity, densityMax = -Infinity;
      let densitySum = 0, speedMax = 0, speedSum = 0, disturbedTexels = 0;
      let solidCells = 0, solidDensityMax = 0, solidSpeedMax = 0, obstacleBoundaryMaxNormalSpeed = 0;
      for (let i = 0; i < state.length; i += 4) {
        const speed = Math.hypot(state[i], state[i + 1]);
        finite = finite && Number.isFinite(speed) && Number.isFinite(state[i + 2]) && Number.isFinite(state[i + 3]);
        densityMin = Math.min(densityMin, state[i + 2]);
        densityMax = Math.max(densityMax, state[i + 2]);
        densitySum += state[i + 2];
        speedMax = Math.max(speedMax, speed);
        speedSum += speed;
        if (state[i + 3] > 0.1) disturbedTexels++;
        const cell = i/4, x = cell%n, y = Math.floor(cell/n);
        if (this._obstacleMask[cell]) {
          solidCells++;
          solidDensityMax = Math.max(solidDensityMax,state[i+2]);
          solidSpeedMax = Math.max(solidSpeedMax,speed);
        } else {
          if ((x>0 && this._obstacleMask[cell-1]) || (x<n-1 && this._obstacleMask[cell+1]))
            obstacleBoundaryMaxNormalSpeed = Math.max(obstacleBoundaryMaxNormalSpeed,Math.abs(state[i]));
          if ((y>0 && this._obstacleMask[cell-n]) || (y<n-1 && this._obstacleMask[cell+n]))
            obstacleBoundaryMaxNormalSpeed = Math.max(obstacleBoundaryMaxNormalSpeed,Math.abs(state[i+1]));
        }
      }
      const result = {
        supported: true, mode: this.mode, resolution: n, finite,
        densityMin, densityMax, densityMean: densitySum / (n * n),
        speedMax, speedMean: speedSum / (n * n), disturbedTexels,
        passCount: this.passCount, memoryBytes: this.memoryBytes,
        solidCells, solidDensityMax, solidSpeedMax, obstacleBoundaryMaxNormalSpeed
      };
      if (this.mode === 'fluid') {
        const before = read(this._divergence);
        const velocity = read(this._velocity[this._velocityIndex]);
        let preSquared = 0, postSquared = 0, fluidCells = 0;
        const h = this.worldSize / n;
        // Measure the same reflected-normal divergence used by the shader,
        // including fluid cells bordering solid footprints and domain walls.
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const cell = y*n+x, i = cell*4;
          if (this._obstacleMask[cell]) continue;
          const l = x===0 || this._obstacleMask[cell-1] ? -velocity[i] : velocity[i-4];
          const r = x===n-1 || this._obstacleMask[cell+1] ? -velocity[i] : velocity[i+4];
          const b = y===0 || this._obstacleMask[cell-n] ? -velocity[i+1] : velocity[i-n*4+1];
          const t = y===n-1 || this._obstacleMask[cell+n] ? -velocity[i+1] : velocity[i+n*4+1];
          const div = (r-l+t-b)/(2*h);
          preSquared += before[i] ** 2;
          postSquared += div ** 2;
          fluidCells++;
        }
        result.divergenceBeforeRMS = Math.sqrt(preSquared / Math.max(fluidCells,1));
        result.divergenceAfterRMS = Math.sqrt(postSquared / Math.max(fluidCells,1));
        result.divergenceReduction = 1 - result.divergenceAfterRMS / Math.max(result.divergenceBeforeRMS, 1e-8);
      }
      return result;
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const target of this._targets) target.dispose();
      for (const material of Object.values(this.materials)) material.dispose();
      this._quad.geometry.dispose();
      this._fallback.dispose();
      this._obstacleTexture.dispose();
    }
  }

  window.FogLab.FieldSimulation = FieldSimulation;
  window.FogLab.fogBankGLSL = FOG_BANK_GLSL;
  window.FogLab.simulationShaders = { vertex: VERTEX, common: COMMON, fragments: FRAGMENTS };
})();
