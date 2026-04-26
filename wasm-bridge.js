// =============================================================================
// wasm-bridge.js — Minimal JS integration layer for the boid-sim WASM module
//
// Loads the WASM module and provides zero-copy typed array helpers for
// reading agent data and writing simulation parameters.
//
// USAGE:
//   import { BoidSim } from './wasm-bridge.js';
//   const sim = await BoidSim.create(canvas.width, canvas.height, 10000);
//   sim.writeParams(getP(), leaderX, leaderY, elapsed);
//   sim.step(dt);
//   const { buffer, count, stride } = sim.readAgents();
//   // buffer is a Float32Array view over wasm memory — zero copy.
//   // Upload to GPU: gl.bufferSubData(gl.ARRAY_BUFFER, 0, buffer);
// =============================================================================

/**
 * @typedef {Object} BoidSimInstance
 * @property {function(Object, number, number, number): void} writeParams
 * @property {function(number): void} step
 * @property {function(): {buffer: Float32Array, count: number, stride: number}} readAgents
 * @property {function(number, number): number} spawnAgent
 * @property {function(number, number, number, number, number, number, number): void} spawnBatch
 * @property {function(number): void} removeAgent
 * @property {function(): void} clearAgents
 * @property {function(Uint8Array, number, number): void} uploadSensing
 * @property {Object} wasm - raw WASM exports for advanced use
 */

// Spawn shape name → u32 mapping (must match spawn.rs SpawnShape enum)
const SHAPE_MAP = {
  circle: 0, ring: 1, gaussian: 2, line: 3, ellipse: 4,
  diamond: 5, grid: 6, sunburst: 7, spiral: 8, poisson: 9,
  random_cluster: 10, burst: 11, lemniscate: 12, phyllotaxis: 13,
  noise_scatter: 14, bullseye: 15, cross: 16, wave: 17, voronoi: 18,
};

export class BoidSim {
  /**
   * Load WASM and initialize the simulation.
   * @param {number} width  - Canvas width in CSS pixels.
   * @param {number} height - Canvas height in CSS pixels.
   * @param {number} maxAgents - Maximum agent pool capacity.
   * @param {string} [wasmPath='./wasm-sim/pkg/boid_sim.js'] - Path to wasm-pack output.
   * @returns {Promise<BoidSim>}
   */
  static async create(width, height, maxAgents, wasmPath = './wasm-sim/pkg/boid_sim.js') {
    const mod = await import(wasmPath);
    const wasm = await mod.default(); // init WASM — returns InitOutput with .memory
    mod.sim_init(width, height, maxAgents);

    const instance = new BoidSim();
    instance._mod = mod;
    instance._wasm = wasm; // raw wasm exports including .memory
    instance._stride = mod.get_stride();
    instance._paramsLen = mod.get_params_len();
    // Cache buffer refs (invalidated on memory growth)
    instance._refreshViews();
    return instance;
  }

  /** @private */
  _refreshViews() {
    const m = this._mod;
    // We need the WASM memory object. wasm-bindgen exposes it differently
    // depending on target. Try common accessor patterns.
    const mem = this._getMemory();
    if (!mem) return;

    const paramsPtr = m.get_params_buffer_ptr();
    this._paramsView = new Float32Array(mem.buffer, paramsPtr, this._paramsLen);

    const agentPtr = m.get_agent_buffer_ptr();
    // Max view size: we'll slice it to actual count when reading
    this._agentBasePtr = agentPtr;
    this._memBuffer = mem.buffer;
  }

  /** @private */
  _getMemory() {
    // wasm-bindgen --target web: init() returns InitOutput which has .memory
    return this._wasm.memory;
  }

  /**
   * Write simulation parameters from a JS params object (from getP()).
   * Call before step().
   *
   * @param {Object} p - Params object from getP().
   * @param {number} targetX - Cursor x (canvas coords).
   * @param {number} targetY - Cursor y (canvas coords).
   * @param {number} time - Elapsed time for flow field.
   */
  writeParams(p, targetX, targetY, time) {
    this._ensureViews();
    const v = this._paramsView;
    v[0]  = p.seek ?? 0.4;
    v[1]  = p.cohesion ?? 0.15;
    v[2]  = p.separation ?? 0.5;
    v[3]  = p.alignment ?? 0.2;
    v[4]  = p.jitter ?? 0;
    v[5]  = p.wander ?? 0;
    v[6]  = p.wanderSpeed ?? 0.3;
    v[7]  = p.maxSpeed ?? 4.0;
    v[8]  = p.damping ?? 0.95;
    v[9]  = p.flowField ?? 0;
    v[10] = p.flowScale ?? 0.01;
    v[11] = p.fleeRadius ?? 0;
    v[12] = p.fov ?? 360;        // degrees; Rust converts to radians
    v[13] = p.individuality ?? 0;
    v[14] = p.sensingEnabled ? 1 : 0;
    v[15] = p.sensingMode === 'attract' ? 1 : 0;
    v[16] = p.sensingStrength ?? 0.5;
    v[17] = p.sensingRadius ?? 20;
    v[18] = p.sensingThreshold ?? 0.1;
    v[19] = targetX;
    v[20] = targetY;
    v[21] = time;
    v[22] = p.neighborRadius ?? 80; // neighbor radius
    v[23] = p.separationRadius ?? 25; // separation radius
    v[24] = p.sizeVar ?? 0;
    v[25] = p.opacityVar ?? 0;
    v[26] = p.speedVar ?? 0;
    v[27] = p.forceVar ?? 0;
    v[28] = p.hueVar ?? 0;
    v[29] = p.satVar ?? 0;
    v[30] = p.litVar ?? 0;
    this._mod.set_params();
  }

  /**
   * Advance simulation by one frame.
   * @param {number} dt - Time delta in seconds (reserved for variable-rate).
   */
  step(dt) {
    this._mod.step(dt);
  }

  /**
   * Read the agent buffer. Returns a Float32Array VIEW (zero-copy).
   *
   * IMPORTANT: This view is invalidated if WASM memory grows.
   * Recreate after any operation that may grow memory (spawn beyond capacity).
   *
   * @returns {{buffer: Float32Array, count: number, stride: number}}
   */
  readAgents() {
    this._ensureViews();
    const count = this._mod.get_agent_count();
    const stride = this._stride;
    const mem = this._getMemory();
    const buf = new Float32Array(mem.buffer, this._agentBasePtr, count * stride);
    return { buffer: buf, count, stride };
  }

  /**
   * Spawn a single agent at (x, y). Returns agent ID.
   * @param {number} x
   * @param {number} y
   * @returns {number} Agent ID (index)
   */
  spawnAgent(x, y) {
    return this._mod.spawn_agent(x, y);
  }

  /**
   * Batch-spawn agents in a shaped distribution.
   *
   * @param {number} cx - Center x.
   * @param {number} cy - Center y.
   * @param {number} count - Number of agents.
   * @param {string|number} shape - Shape name or ID (e.g. 'circle' or 0).
   * @param {number} angle - Rotation in radians.
   * @param {number} jitter - Position noise 0-1.
   * @param {number} radius - Spawn area radius in pixels.
   */
  spawnBatch(cx, cy, count, shape, angle, jitter, radius) {
    const shapeId = typeof shape === 'string' ? (SHAPE_MAP[shape] ?? 0) : shape;
    this._mod.spawn_batch(cx, cy, count, shapeId, angle, jitter, radius);
  }

  /** Remove agent by ID. Uses swap-remove (O(1)). */
  removeAgent(id) {
    this._mod.remove_agent(id);
  }

  /** Clear all agents. */
  clearAgents() {
    this._mod.clear_agents();
  }

  /**
   * Upload a downsampled luminance map for pixel sensing.
   *
   * JS should:
   * 1. Render layers to a small offscreen canvas (e.g. canvas_w/4 × canvas_h/4).
   * 2. Call getImageData() and extract single-channel luminance.
   * 3. Pass the Uint8Array here.
   *
   * @param {Uint8Array} luminance - Single-channel luminance data.
   * @param {number} w - Width of the luminance map.
   * @param {number} h - Height of the luminance map.
   */
  uploadSensing(luminance, w, h) {
    this._mod.init_sensing(w, h);
    const ptr = this._mod.get_sensing_buffer_ptr();
    if (!ptr) return;
    const mem = this._getMemory();
    const dst = new Uint8Array(mem.buffer, ptr, w * h);
    dst.set(luminance);
    this._mod.update_sensing();
  }

  /** @private Recreate typed views if memory buffer has changed (growth). */
  _ensureViews() {
    const mem = this._getMemory();
    if (!mem) return;
    if (mem.buffer !== this._memBuffer) {
      this._refreshViews();
    }
  }

  /** Access raw WASM module exports for advanced use. */
  get wasm() {
    return this._mod;
  }
}

const FLUID_TYPE_MAP = {
  sph: 0,
  eulerian: 1,
  lbm: 2,
};

const FLUID_RENDER_MODE_MAP = {
  particles: 0,
  grid: 1,
  hybrid: 2,
};

let _fluidModulePromise = null;
let _fluidModulePath = '';

function _scaleImageDataViaCanvas(imageData, width, height, sourceCanvas, sourceCtx, targetCanvas, targetCtx) {
  if (sourceCanvas.width !== imageData.width || sourceCanvas.height !== imageData.height) {
    sourceCanvas.width = imageData.width;
    sourceCanvas.height = imageData.height;
  }
  sourceCtx.putImageData(imageData, 0, 0);
  if (targetCanvas.width !== width || targetCanvas.height !== height) {
    targetCanvas.width = width;
    targetCanvas.height = height;
  }
  targetCtx.imageSmoothingEnabled = true;
  targetCtx.clearRect(0, 0, width, height);
  targetCtx.drawImage(sourceCanvas, 0, 0, width, height);
  return targetCtx.getImageData(0, 0, width, height);
}

async function _loadFluidModule(wasmPath) {
  if (!_fluidModulePromise || _fluidModulePath !== wasmPath) {
    _fluidModulePath = wasmPath;
    _fluidModulePromise = (async () => {
      const mod = await import(wasmPath);
      if (typeof mod.default === 'function') await mod.default();
      if (typeof mod.fluid_create_simulator !== 'function') {
        throw new Error('Fluid exports are unavailable in the WASM module.');
      }
      return mod;
    })();
  }
  return _fluidModulePromise;
}

export class FluidSim {
  static async create(width, height, params = {}, wasmPath = './wasm-sim/pkg/boid_sim.js') {
    const mod = await _loadFluidModule(wasmPath);
    const instance = new FluidSim(mod, width, height, params);
    instance.updateParams(params);
    return instance;
  }

  constructor(mod, displayWidth, displayHeight, params = {}) {
    this._mod = mod;
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.internalWidth = 0;
    this.internalHeight = 0;
    this.handle = null;
    this.params = { ...params };
    this.maskImageData = null;
    this._sourceCanvas = document.createElement('canvas');
    this._sourceCtx = this._sourceCanvas.getContext('2d', { willReadFrequently: true });
    this._targetCanvas = document.createElement('canvas');
    this._targetCtx = this._targetCanvas.getContext('2d', { willReadFrequently: true });
  }

  updateParams(params = {}) {
    this.params = { ...this.params, ...params };
    const next = this._targetSize(this.params);
    const needsRebuild = this.handle === null || next.width !== this.internalWidth || next.height !== this.internalHeight;
    if (needsRebuild) {
      this.internalWidth = next.width;
      this.internalHeight = next.height;
      this._recreateHandle();
    }

    this._mod.fluid_set_params(
      this.handle,
      this._scaleDistance(this.params.particleRadius ?? 4),
      this.params.viscosity ?? 0.45,
      this.params.density ?? 0.55,
      this.params.surfaceTension ?? 0.58,
      this.params.timeStep ?? 1,
      this.params.substeps ?? 3,
      this.params.motionDecay ?? 0.12,
      this._scaleDistance(this.params.stopSpeed ?? 0.025),
      FLUID_TYPE_MAP[this.params.simulationType ?? 'lbm'] ?? 2,
      FLUID_RENDER_MODE_MAP[this.params.renderMode ?? 'hybrid'] ?? 2,
    );
  }

  setDisplaySize(displayWidth, displayHeight) {
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.updateParams(this.params);
  }

  setMask(imageData) {
    this.maskImageData = imageData;
    if (this.handle === null) return;
    const scaled = _scaleImageDataViaCanvas(
      imageData,
      this.internalWidth,
      this.internalHeight,
      this._sourceCanvas,
      this._sourceCtx,
      this._targetCanvas,
      this._targetCtx,
    );
    this._mod.fluid_set_mask_rgba(this.handle, new Uint8Array(scaled.data));
  }

  addParticles(particlesArray) {
    if (this.handle === null || !particlesArray?.length) return;
    const packed = new Float32Array(particlesArray.length * 9);
    const scaleX = this.internalWidth / this.displayWidth;
    const scaleY = this.internalHeight / this.displayHeight;
    const scaleAvg = (scaleX + scaleY) * 0.5;
    let offset = 0;
    for (const particle of particlesArray) {
      packed[offset + 0] = particle.x * scaleX;
      packed[offset + 1] = particle.y * scaleY;
      packed[offset + 2] = (particle.vx ?? 0) * scaleX;
      packed[offset + 3] = (particle.vy ?? 0) * scaleY;
      packed[offset + 4] = particle.r ?? 0;
      packed[offset + 5] = particle.g ?? 0;
      packed[offset + 6] = particle.b ?? 0;
      packed[offset + 7] = particle.a ?? 0.8;
      packed[offset + 8] = (particle.radius ?? this.params.particleRadius ?? 4) * scaleAvg;
      offset += 9;
    }
    this._mod.fluid_add_particles(this.handle, packed, 9);
  }

  clearParticles() {
    if (this.handle !== null) this._mod.fluid_clear_particles(this.handle);
  }

  step(dt) {
    if (this.handle !== null) this._mod.fluid_step(this.handle, dt);
  }

  readPixels() {
    return {
      buffer: new Uint8ClampedArray(this._mod.fluid_read_pixels(this.handle)),
      width: this.internalWidth,
      height: this.internalHeight,
    };
  }

  getParticleCount() {
    return this.handle !== null ? this._mod.fluid_get_particle_count(this.handle) : 0;
  }

  getParticles() {
    if (this.handle === null) return [];
    const raw = this._mod.fluid_get_particles(this.handle);
    const scaleX = this.displayWidth / this.internalWidth;
    const scaleY = this.displayHeight / this.internalHeight;
    const particles = [];
    for (let index = 0; index < raw.length; index += 4) {
      particles.push({
        x: raw[index] * scaleX,
        y: raw[index + 1] * scaleY,
        vx: raw[index + 2] * scaleX,
        vy: raw[index + 3] * scaleY,
      });
    }
    return particles;
  }

  getRenderSize() {
    return { width: this.internalWidth, height: this.internalHeight };
  }

  destroy() {
    if (this.handle !== null) {
      this._mod.fluid_destroy_simulator(this.handle);
      this.handle = null;
    }
  }

  _targetSize(params) {
    const scale = Number(params.resolutionScale) || 1;
    const fluidScale = Math.max(0.35, Number(params.fluidScale) || 1);
    return {
      width: Math.max(96, Math.round((this.displayWidth * scale) / fluidScale)),
      height: Math.max(72, Math.round((this.displayHeight * scale) / fluidScale)),
    };
  }

  _scaleDistance(distance) {
    const scaleX = this.internalWidth / this.displayWidth;
    const scaleY = this.internalHeight / this.displayHeight;
    return distance * ((scaleX + scaleY) * 0.5);
  }

  _recreateHandle() {
    if (this.handle !== null) this._mod.fluid_destroy_simulator(this.handle);
    this.handle = this._mod.fluid_create_simulator(this.internalWidth, this.internalHeight);
    if (this.maskImageData) this.setMask(this.maskImageData);
  }
}
