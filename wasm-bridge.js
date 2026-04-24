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
