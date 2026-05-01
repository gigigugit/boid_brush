/* @ts-self-types="./boid_sim.d.ts" */

/**
 * Clear all agents.
 */
export function clear_agents() {
    wasm.clear_agents();
}

/**
 * @param {number} handle
 * @param {Float32Array} packed
 * @param {number} stride
 */
export function fluid_add_particles(handle, packed, stride) {
    const ptr0 = passArrayF32ToWasm0(packed, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    wasm.fluid_add_particles(handle, ptr0, len0, stride);
}

/**
 * @param {number} handle
 */
export function fluid_clear_particles(handle) {
    wasm.fluid_clear_particles(handle);
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function fluid_create_simulator(width, height) {
    const ret = wasm.fluid_create_simulator(width, height);
    return ret >>> 0;
}

/**
 * @param {number} handle
 */
export function fluid_destroy_simulator(handle) {
    wasm.fluid_destroy_simulator(handle);
}

/**
 * @param {number} handle
 * @returns {number}
 */
export function fluid_get_particle_count(handle) {
    const ret = wasm.fluid_get_particle_count(handle);
    return ret >>> 0;
}

/**
 * @param {number} handle
 * @returns {Float32Array}
 */
export function fluid_get_particles(handle) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.fluid_get_particles(retptr, handle);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {number} handle
 * @returns {Uint8Array}
 */
export function fluid_read_pixels(handle) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.fluid_read_pixels(retptr, handle);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export2(r0, r1 * 1, 1);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {number} handle
 * @param {Uint8Array} rgba
 */
export function fluid_set_mask_rgba(handle, rgba) {
    const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    wasm.fluid_set_mask_rgba(handle, ptr0, len0);
}

/**
 * @param {number} handle
 * @param {number} particle_radius
 * @param {number} viscosity
 * @param {number} density
 * @param {number} surface_tension
 * @param {number} time_step
 * @param {number} substeps
 * @param {number} motion_decay
 * @param {number} stop_speed
 * @param {number} pigment_carry
 * @param {number} pigment_retention
 * @param {number} simulation_type
 * @param {number} render_mode
 */
export function fluid_set_params(handle, particle_radius, viscosity, density, surface_tension, time_step, substeps, motion_decay, stop_speed, pigment_carry, pigment_retention, simulation_type, render_mode) {
    wasm.fluid_set_params(handle, particle_radius, viscosity, density, surface_tension, time_step, substeps, motion_decay, stop_speed, pigment_carry, pigment_retention, simulation_type, render_mode);
}

/**
 * @param {number} handle
 * @param {number} dt
 */
export function fluid_step(handle, dt) {
    wasm.fluid_step(handle, dt);
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

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
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
