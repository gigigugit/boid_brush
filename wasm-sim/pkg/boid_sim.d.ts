/* tslint:disable */
/* eslint-disable */

/**
 * Clear all agents.
 */
export function clear_agents(): void;

/**
 * Pointer to the raw f32 agent buffer. JS creates a typed view:
 * ```js
 * new Float32Array(wasm.memory.buffer, ptr, count * STRIDE)
 * ```
 *
 * **Important:** This pointer is valid until the next WASM memory growth.
 * If you see a detached ArrayBuffer, recreate the view.
 */
export function get_agent_buffer_ptr(): number;

/**
 * Number of currently live agents.
 */
export function get_agent_count(): number;

/**
 * LBM grid height in lattice cells.  Returns 0 if LBM is not initialised.
 */
export function get_lbm_height(): number;

/**
 * LBM grid width in lattice cells.  Returns 0 if LBM is not initialised.
 */
export function get_lbm_width(): number;

/**
 * Pointer to the raw f32 params buffer (32 floats = 128 bytes).
 * JS writes directly here, then calls `set_params()` to parse.
 */
export function get_params_buffer_ptr(): number;

/**
 * Params buffer length in f32 count (32).
 */
export function get_params_len(): number;

/**
 * Pointer to the pigment Float32Array (one f32 per cell, in [0, 1]).
 *
 * ```js
 * const ptr = get_pigment_ptr();
 * const w   = get_lbm_width();
 * const h   = get_lbm_height();
 * const pig = new Float32Array(wasm.memory.buffer, ptr, w * h);
 * ```
 *
 * Returns null (0) if LBM has not been initialised.
 */
export function get_pigment_ptr(): number;

/**
 * Pointer to the sensing buffer (u8 luminance data).
 * JS writes downsampled luminance here, then calls `update_sensing()`.
 */
export function get_sensing_buffer_ptr(): number;

/**
 * Agent stride in f32 count (16).
 */
export function get_stride(): number;

/**
 * Prepare the sensing buffer for a given resolution.
 * Call this before writing luminance data into the buffer.
 *
 * - `w`, `h`: sensing map resolution (typically canvas_w/4 × canvas_h/4).
 */
export function init_sensing(w: number, h: number): void;

/**
 * Initialise the D2Q9 LBM fluid grid at lattice resolution `lbm_w × lbm_h`.
 *
 * The LBM grid is independent of the agent pool and operates at a lower
 * resolution than the canvas (e.g., canvas_w/4 × canvas_h/4) for real-time
 * performance.  After calling this, `step()` will automatically inject boid
 * momentum/pigment into the LBM grid each frame.
 *
 * ```js
 * // Typically called once after sim_init():
 * lbm_init(Math.floor(canvas.width / 4), Math.floor(canvas.height / 4));
 * ```
 */
export function lbm_init(lbm_w: number, lbm_h: number): void;

/**
 * Reset the LBM grid to equilibrium and clear all pigment.
 * Call at the start of a new stroke to remove residual fluid state.
 */
export function lbm_reset(): void;

/**
 * Remove an agent by ID. Uses swap-remove (O(1), may reorder).
 */
export function remove_agent(id: number): void;

/**
 * Write simulation parameters from JS. Call before `step()`.
 *
 * ```js
 * const paramsPtr = get_params_buffer_ptr();
 * const paramsView = new Float32Array(wasm.memory.buffer, paramsPtr, PARAMS_LEN);
 * paramsView[0] = p.seek;  // ... fill all 32 floats
 * set_params();
 * ```
 */
export function set_params(): void;

/**
 * Initialize the simulation. Must be called before any other function.
 *
 * - `width`, `height`: canvas dimensions in CSS pixels.
 * - `max_agents`: pre-allocated pool capacity.
 *
 * ```js
 * import init, { sim_init, step, get_agent_buffer_ptr, get_agent_count, get_stride }
 *   from './wasm-sim/pkg/boid_sim.js';
 * await init();                      // load WASM
 * sim_init(canvas.width, canvas.height, 10000);
 * ```
 */
export function sim_init(width: number, height: number, max_agents: number): void;

/**
 * Spawn a single agent at (x, y). Returns the agent ID (index).
 *
 * For batch spawning, prefer `spawn_batch()` which is far more efficient.
 */
export function spawn_agent(x: number, y: number): number;

/**
 * Batch-spawn agents in a shaped distribution centered at (cx, cy).
 *
 * - `count`: number of agents to spawn.
 * - `shape`: SpawnShape enum as u32 (0=Circle, 1=Ring, ..., 10=RandomCluster).
 * - `angle`: rotation in radians.
 * - `jitter`: 0.0-1.0 position noise.
 * - `radius`: spawn area radius in pixels.
 */
export function spawn_batch(cx: number, cy: number, count: number, shape: number, angle: number, jitter: number, radius: number): void;

/**
 * Advance the simulation by one frame.
 *
 * Call `set_params()` before this to update forces, cursor position, and time.
 * After `step()`, read agent positions from the buffer returned by
 * `get_agent_buffer_ptr()`.
 *
 * - `dt`: time delta (currently unused; reserved for variable-rate stepping).
 *
 * ```js
 * // In your requestAnimationFrame loop:
 * set_params();  // write params Float32Array
 * step(dt);
 * const ptr = get_agent_buffer_ptr();
 * const cnt = get_agent_count();
 * const agents = new Float32Array(wasm.memory.buffer, ptr, cnt * STRIDE);
 * // agents[i*STRIDE + 0] = x, [i*STRIDE + 1] = y, etc.
 * ```
 */
export function step(dt: number): void;

/**
 * Advance the LBM fluid simulation by one step **without** running boid physics.
 *
 * Useful for running extra LBM sub-steps per boid step, or for stepping the
 * fluid independently.  Boid momentum/pigment injection is **not** performed
 * by this function — use `step()` for the integrated boid + LBM update.
 */
export function step_lbm(): void;

/**
 * Tell the simulation that fresh sensing data has been written.
 * (The data was written directly into the buffer at get_sensing_buffer_ptr().)
 */
export function update_sensing(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly get_agent_buffer_ptr: () => number;
    readonly get_params_buffer_ptr: () => number;
    readonly get_params_len: () => number;
    readonly get_pigment_ptr: () => number;
    readonly get_sensing_buffer_ptr: () => number;
    readonly get_stride: () => number;
    readonly init_sensing: (a: number, b: number) => void;
    readonly lbm_init: (a: number, b: number) => void;
    readonly remove_agent: (a: number) => void;
    readonly sim_init: (a: number, b: number, c: number) => void;
    readonly spawn_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly update_sensing: () => void;
    readonly step: (a: number) => void;
    readonly get_agent_count: () => number;
    readonly clear_agents: () => void;
    readonly lbm_reset: () => void;
    readonly get_lbm_height: () => number;
    readonly get_lbm_width: () => number;
    readonly spawn_agent: (a: number, b: number) => number;
    readonly step_lbm: () => void;
    readonly set_params: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
