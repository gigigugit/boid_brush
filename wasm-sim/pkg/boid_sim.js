/* @ts-self-types="./boid_sim.d.ts" */

/**
 * Clear all agents.
 */
export function clear_agents() {
    wasm.clear_agents();
}

/**
 * Pointer to the raw f32 agent buffer. JS creates a typed view:
 * ```js
 * new Float32Array(wasm.memory.buffer, ptr, count * STRIDE)
 * ```
 *
 * **Important:** This pointer is valid until the next WASM memory growth.
 * If you see a detached ArrayBuffer, recreate the view.
 * @returns {number}
 */
export function get_agent_buffer_ptr() {
    const ret = wasm.get_agent_buffer_ptr();
    return ret >>> 0;
}

/**
 * Number of currently live agents.
 * @returns {number}
 */
export function get_agent_count() {
    const ret = wasm.get_agent_count();
    return ret >>> 0;
}

/**
 * LBM grid height in lattice cells.  Returns 0 if LBM is not initialised.
 * @returns {number}
 */
export function get_lbm_height() {
    const ret = wasm.get_lbm_height();
    return ret >>> 0;
}

/**
 * LBM grid width in lattice cells.  Returns 0 if LBM is not initialised.
 * @returns {number}
 */
export function get_lbm_width() {
    const ret = wasm.get_lbm_width();
    return ret >>> 0;
}

/**
 * Pointer to the raw f32 params buffer (32 floats = 128 bytes).
 * JS writes directly here, then calls `set_params()` to parse.
 * @returns {number}
 */
export function get_params_buffer_ptr() {
    const ret = wasm.get_params_buffer_ptr();
    return ret >>> 0;
}

/**
 * Params buffer length in f32 count (32).
 * @returns {number}
 */
export function get_params_len() {
    const ret = wasm.get_params_len();
    return ret >>> 0;
}

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
 * @returns {number}
 */
export function get_pigment_ptr() {
    const ret = wasm.get_pigment_ptr();
    return ret >>> 0;
}

/**
 * Pointer to the sensing buffer (u8 luminance data).
 * JS writes downsampled luminance here, then calls `update_sensing()`.
 * @returns {number}
 */
export function get_sensing_buffer_ptr() {
    const ret = wasm.get_sensing_buffer_ptr();
    return ret >>> 0;
}

/**
 * Agent stride in f32 count (16).
 * @returns {number}
 */
export function get_stride() {
    const ret = wasm.get_stride();
    return ret >>> 0;
}

/**
 * Prepare the sensing buffer for a given resolution.
 * Call this before writing luminance data into the buffer.
 *
 * - `w`, `h`: sensing map resolution (typically canvas_w/4 × canvas_h/4).
 * @param {number} w
 * @param {number} h
 */
export function init_sensing(w, h) {
    wasm.init_sensing(w, h);
}

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
 * @param {number} lbm_w
 * @param {number} lbm_h
 */
export function lbm_init(lbm_w, lbm_h) {
    wasm.lbm_init(lbm_w, lbm_h);
}

/**
 * Reset the LBM grid to equilibrium and clear all pigment.
 * Call at the start of a new stroke to remove residual fluid state.
 */
export function lbm_reset() {
    wasm.lbm_reset();
}

/**
 * Remove an agent by ID. Uses swap-remove (O(1), may reorder).
 * @param {number} id
 */
export function remove_agent(id) {
    wasm.remove_agent(id);
}

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
export function set_params() {
    wasm.set_params();
}

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
 * @param {number} width
 * @param {number} height
 * @param {number} max_agents
 */
export function sim_init(width, height, max_agents) {
    wasm.sim_init(width, height, max_agents);
}

/**
 * Spawn a single agent at (x, y). Returns the agent ID (index).
 *
 * For batch spawning, prefer `spawn_batch()` which is far more efficient.
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function spawn_agent(x, y) {
    const ret = wasm.spawn_agent(x, y);
    return ret >>> 0;
}

/**
 * Batch-spawn agents in a shaped distribution centered at (cx, cy).
 *
 * - `count`: number of agents to spawn.
 * - `shape`: SpawnShape enum as u32 (0=Circle, 1=Ring, ..., 10=RandomCluster).
 * - `angle`: rotation in radians.
 * - `jitter`: 0.0-1.0 position noise.
 * - `radius`: spawn area radius in pixels.
 * @param {number} cx
 * @param {number} cy
 * @param {number} count
 * @param {number} shape
 * @param {number} angle
 * @param {number} jitter
 * @param {number} radius
 */
export function spawn_batch(cx, cy, count, shape, angle, jitter, radius) {
    wasm.spawn_batch(cx, cy, count, shape, angle, jitter, radius);
}

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
 * @param {number} dt
 */
export function step(dt) {
    wasm.step(dt);
}

/**
 * Advance the LBM fluid simulation by one step **without** running boid physics.
 *
 * Useful for running extra LBM sub-steps per boid step, or for stepping the
 * fluid independently.  Boid momentum/pigment injection is **not** performed
 * by this function — use `step()` for the integrated boid + LBM update.
 */
export function step_lbm() {
    wasm.step_lbm();
}

/**
 * Tell the simulation that fresh sensing data has been written.
 * (The data was written directly into the buffer at get_sensing_buffer_ptr().)
 */
export function update_sensing() {
    wasm.update_sensing();
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
    };
    return {
        __proto__: null,
        "./boid_sim_bg.js": import0,
    };
}

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('boid_sim_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
