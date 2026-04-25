// =============================================================================
// lib.rs — WASM exports via wasm-bindgen
//
// This is the public API surface for the JS host. All functions are designed
// to minimize JS↔WASM crossings: accept batched updates via pointers and let
// the host read the whole agent buffer after step() for GPU rendering.
//
// BUILD:
//   cd wasm-sim
//   wasm-pack build --target web --release
//
// OUTPUT: pkg/boid_sim.js + boid_sim_bg.wasm
//
// THREADING NOTE:
//   Phase 1 is single-threaded. For pthreads/SharedArrayBuffer support,
//   compile with: RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals'
//   and serve with: Cross-Origin-Opener-Policy: same-origin
//                   Cross-Origin-Embedder-Policy: require-corp
// =============================================================================

mod boid;
mod fluid;
mod forces;
mod noise;
mod params;
mod sensing;
mod sim;
mod spawn;

use boid::STRIDE;
use fluid::FluidSimulation;
use params::PARAMS_LEN;
use sim::Simulation;
use wasm_bindgen::prelude::*;

use std::cell::RefCell;

thread_local! {
    static SIM: RefCell<Option<Simulation>> = RefCell::new(None);
    static FLUID_SIMS: RefCell<Vec<Option<FluidSimulation>>> = RefCell::new(Vec::new());
}

fn with_sim<F, R>(f: F) -> R
where
    F: FnOnce(&mut Simulation) -> R,
{
    SIM.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let sim = borrow.as_mut().expect("Simulation not initialized — call init() first");
        f(sim)
    })
}

fn with_fluid_sim<F, R>(handle: u32, f: F) -> R
where
    F: FnOnce(&mut FluidSimulation) -> R,
{
    FLUID_SIMS.with(|cell| {
        let mut sims = cell.borrow_mut();
        let sim = sims
            .get_mut(handle as usize)
            .and_then(Option::as_mut)
            .expect("Fluid simulator not initialized");
        f(sim)
    })
}

// =============================================================================
// Exported API
// =============================================================================

/// Initialize the simulation. Must be called before any other function.
///
/// - `width`, `height`: canvas dimensions in CSS pixels.
/// - `max_agents`: pre-allocated pool capacity.
///
/// ```js
/// import init, { sim_init, step, get_agent_buffer_ptr, get_agent_count, get_stride }
///   from './wasm-sim/pkg/boid_sim.js';
/// await init();                      // load WASM
/// sim_init(canvas.width, canvas.height, 10000);
/// ```
#[wasm_bindgen]
pub fn sim_init(width: u32, height: u32, max_agents: u32) {
    SIM.with(|cell| {
        *cell.borrow_mut() = Some(Simulation::new(width, height, max_agents));
    });
}

/// Advance the simulation by one frame.
///
/// Call `set_params()` before this to update forces, cursor position, and time.
/// After `step()`, read agent positions from the buffer returned by
/// `get_agent_buffer_ptr()`.
///
/// - `dt`: time delta (currently unused; reserved for variable-rate stepping).
///
/// ```js
/// // In your requestAnimationFrame loop:
/// set_params();  // write params Float32Array
/// step(dt);
/// const ptr = get_agent_buffer_ptr();
/// const cnt = get_agent_count();
/// const agents = new Float32Array(wasm.memory.buffer, ptr, cnt * STRIDE);
/// // agents[i*STRIDE + 0] = x, [i*STRIDE + 1] = y, etc.
/// ```
#[wasm_bindgen]
pub fn step(dt: f32) {
    with_sim(|sim| sim.step(dt));
}

/// Spawn a single agent at (x, y). Returns the agent ID (index).
///
/// For batch spawning, prefer `spawn_batch()` which is far more efficient.
#[wasm_bindgen]
pub fn spawn_agent(x: f32, y: f32) -> u32 {
    with_sim(|sim| sim.spawn_one(x, y))
}

/// Batch-spawn agents in a shaped distribution centered at (cx, cy).
///
/// - `count`: number of agents to spawn.
/// - `shape`: SpawnShape enum as u32 (0=Circle, 1=Ring, ..., 10=RandomCluster).
/// - `angle`: rotation in radians.
/// - `jitter`: 0.0-1.0 position noise.
/// - `radius`: spawn area radius in pixels.
#[wasm_bindgen]
pub fn spawn_batch(cx: f32, cy: f32, count: u32, shape: u32, angle: f32, jitter: f32, radius: f32) {
    with_sim(|sim| sim.spawn_batch(cx, cy, count, shape, angle, jitter, radius));
}

/// Remove an agent by ID. Uses swap-remove (O(1), may reorder).
#[wasm_bindgen]
pub fn remove_agent(id: u32) {
    with_sim(|sim| sim.remove_agent(id));
}

/// Clear all agents.
#[wasm_bindgen]
pub fn clear_agents() {
    with_sim(|sim| sim.clear_agents());
}

/// Write simulation parameters from JS. Call before `step()`.
///
/// ```js
/// const paramsPtr = get_params_buffer_ptr();
/// const paramsView = new Float32Array(wasm.memory.buffer, paramsPtr, PARAMS_LEN);
/// paramsView[0] = p.seek;  // ... fill all 32 floats
/// set_params();
/// ```
#[wasm_bindgen]
pub fn set_params() {
    with_sim(|sim| sim.update_params());
}

/// Pointer to the raw f32 params buffer (32 floats = 128 bytes).
/// JS writes directly here, then calls `set_params()` to parse.
#[wasm_bindgen]
pub fn get_params_buffer_ptr() -> *const f32 {
    with_sim(|sim| sim.params_buf.as_ptr())
}

/// Pointer to the raw f32 agent buffer. JS creates a typed view:
/// ```js
/// new Float32Array(wasm.memory.buffer, ptr, count * STRIDE)
/// ```
///
/// **Important:** This pointer is valid until the next WASM memory growth.
/// If you see a detached ArrayBuffer, recreate the view.
#[wasm_bindgen]
pub fn get_agent_buffer_ptr() -> *const f32 {
    with_sim(|sim| sim.buf.as_ptr())
}

/// Number of currently live agents.
#[wasm_bindgen]
pub fn get_agent_count() -> u32 {
    with_sim(|sim| sim.agent_count as u32)
}

/// Agent stride in f32 count (16).
#[wasm_bindgen]
pub fn get_stride() -> u32 {
    STRIDE as u32
}

/// Params buffer length in f32 count (32).
#[wasm_bindgen]
pub fn get_params_len() -> u32 {
    PARAMS_LEN as u32
}

/// Pointer to the sensing buffer (u8 luminance data).
/// JS writes downsampled luminance here, then calls `update_sensing()`.
#[wasm_bindgen]
pub fn get_sensing_buffer_ptr() -> *const u8 {
    with_sim(|sim| {
        if sim.sensing.data.is_empty() {
            std::ptr::null()
        } else {
            sim.sensing.data.as_ptr()
        }
    })
}

/// Prepare the sensing buffer for a given resolution.
/// Call this before writing luminance data into the buffer.
///
/// - `w`, `h`: sensing map resolution (typically canvas_w/4 × canvas_h/4).
#[wasm_bindgen]
pub fn init_sensing(w: u32, h: u32) {
    with_sim(|sim| {
        sim.sensing.resize(w, h, sim.width, sim.height);
    });
}

/// Tell the simulation that fresh sensing data has been written.
/// (The data was written directly into the buffer at get_sensing_buffer_ptr().)
#[wasm_bindgen]
pub fn update_sensing() {
    // No-op: the data is already in place. This function exists as a
    // synchronization point — if we add threading later, this would
    // include a memory fence.
}

#[wasm_bindgen]
pub fn fluid_create_simulator(width: u32, height: u32) -> u32 {
    FLUID_SIMS.with(|cell| {
        let mut sims = cell.borrow_mut();
        let sim = FluidSimulation::new(width, height);
        if let Some((index, slot)) = sims.iter_mut().enumerate().find(|(_, slot)| slot.is_none()) {
            *slot = Some(sim);
            index as u32
        } else {
            sims.push(Some(sim));
            (sims.len() - 1) as u32
        }
    })
}

#[wasm_bindgen]
pub fn fluid_destroy_simulator(handle: u32) {
    FLUID_SIMS.with(|cell| {
        if let Some(slot) = cell.borrow_mut().get_mut(handle as usize) {
            *slot = None;
        }
    });
}

#[wasm_bindgen]
pub fn fluid_set_params(
    handle: u32,
    particle_radius: f32,
    viscosity: f32,
    density: f32,
    surface_tension: f32,
    time_step: f32,
    substeps: u32,
    motion_decay: f32,
    stop_speed: f32,
    simulation_type: u32,
    render_mode: u32,
) {
    with_fluid_sim(handle, |sim| {
        sim.set_params(
            particle_radius,
            viscosity,
            density,
            surface_tension,
            time_step,
            substeps,
            motion_decay,
            stop_speed,
            simulation_type,
            render_mode,
        )
    });
}

#[wasm_bindgen]
pub fn fluid_set_mask_rgba(handle: u32, rgba: &[u8]) {
    with_fluid_sim(handle, |sim| sim.set_mask_rgba(rgba));
}

#[wasm_bindgen]
pub fn fluid_add_particles(handle: u32, packed: &[f32], stride: u32) {
    with_fluid_sim(handle, |sim| sim.add_particles_from_slice(packed, stride as usize));
}

#[wasm_bindgen]
pub fn fluid_clear_particles(handle: u32) {
    with_fluid_sim(handle, |sim| sim.clear_particles());
}

#[wasm_bindgen]
pub fn fluid_step(handle: u32, dt: f32) {
    with_fluid_sim(handle, |sim| sim.step(dt));
}

#[wasm_bindgen]
pub fn fluid_read_pixels(handle: u32) -> Vec<u8> {
    with_fluid_sim(handle, |sim| sim.read_pixels())
}

#[wasm_bindgen]
pub fn fluid_get_particle_count(handle: u32) -> u32 {
    with_fluid_sim(handle, |sim| sim.particle_count())
}

#[wasm_bindgen]
pub fn fluid_get_particles(handle: u32) -> Vec<f32> {
    with_fluid_sim(handle, |sim| sim.read_particles())
}

// =============================================================================
// Tests (run with: cargo test --target x86_64-pc-windows-msvc)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boid;
    use crate::forces::Rng;

    #[test]
    fn test_spawn_and_count() {
        let mut sim = Simulation::new(800, 600, 1000);
        assert_eq!(sim.agent_count, 0);

        sim.spawn_one(100.0, 200.0);
        assert_eq!(sim.agent_count, 1);
        assert_eq!(sim.buf[boid::X], 100.0);
        assert_eq!(sim.buf[boid::Y], 200.0);
        assert!(boid::has_flag(&sim.buf, 0, boid::FLAG_ALIVE));

        sim.spawn_one(300.0, 400.0);
        assert_eq!(sim.agent_count, 2);
    }

    #[test]
    fn test_remove_swap() {
        let mut sim = Simulation::new(800, 600, 1000);
        sim.spawn_one(10.0, 20.0);
        sim.spawn_one(30.0, 40.0);
        sim.spawn_one(50.0, 60.0);
        assert_eq!(sim.agent_count, 3);

        // Remove agent 0 — agent 2 should swap into slot 0
        sim.remove_agent(0);
        assert_eq!(sim.agent_count, 2);
        assert_eq!(sim.buf[boid::X], 50.0); // was agent 2
        assert_eq!(sim.buf[boid::Y], 60.0);
    }

    #[test]
    fn test_step_no_nan() {
        let mut sim = Simulation::new(800, 600, 100);
        for i in 0..50 {
            sim.spawn_one(400.0 + i as f32, 300.0);
        }
        sim.params = crate::params::SimParams::default();
        sim.params.target_x = 400.0;
        sim.params.target_y = 300.0;

        for _ in 0..1000 {
            sim.step(1.0 / 60.0);
        }

        for i in 0..sim.agent_count {
            let base = i * STRIDE;
            assert!(!sim.buf[base + boid::X].is_nan(), "x is NaN at agent {i}");
            assert!(!sim.buf[base + boid::Y].is_nan(), "y is NaN at agent {i}");
            assert!(
                !sim.buf[base + boid::VX].is_nan(),
                "vx is NaN at agent {i}"
            );
            assert!(
                !sim.buf[base + boid::VY].is_nan(),
                "vy is NaN at agent {i}"
            );
        }
    }

    #[test]
    fn test_batch_spawn_shapes() {
        let mut sim = Simulation::new(800, 600, 1000);
        for shape_id in 0..=18u32 {
            sim.clear_agents();
            sim.spawn_batch(400.0, 300.0, 25, shape_id, 0.0, 0.0, 50.0);
            assert_eq!(
                sim.agent_count, 25,
                "Shape {shape_id} didn't produce 25 agents"
            );
        }
    }

    #[test]
    fn test_sensing_force_direction() {
        let mut sim = Simulation::new(100, 100, 10);
        sim.sensing.resize(100, 100, 100, 100);
        // Fill right half with bright pixels
        for y in 0..100u32 {
            for x in 50..100u32 {
                sim.sensing.data[(y * 100 + x) as usize] = 255;
            }
        }
        sim.params.sensing_enabled = true;
        sim.params.sensing_attract = false; // avoid
        sim.params.sensing_strength = 1.0;
        sim.params.sensing_radius = 10.0;
        sim.params.sensing_threshold = 0.1;
        sim.params.max_speed = 4.0;

        // Spawn agent near the boundary
        sim.spawn_one(45.0, 50.0);
        let base = 0;
        sim.buf[base + boid::AX] = 0.0;
        sim.buf[base + boid::AY] = 0.0;

        crate::sensing::apply_sensing_force(
            &mut sim.buf,
            base,
            &sim.params,
            &sim.sensing,
        );

        // Agent should be pushed LEFT (negative x) away from bright right side
        assert!(
            sim.buf[base + boid::AX] < 0.0,
            "Expected negative ax (avoid right), got {}",
            sim.buf[base + boid::AX]
        );
    }

    #[test]
    fn test_clear_agents() {
        let mut sim = Simulation::new(800, 600, 100);
        for _ in 0..50 {
            sim.spawn_one(100.0, 100.0);
        }
        assert_eq!(sim.agent_count, 50);
        sim.clear_agents();
        assert_eq!(sim.agent_count, 0);
    }

    #[test]
    fn test_pool_integrity_random_ops() {
        let mut sim = Simulation::new(800, 600, 200);
        let mut rng = Rng::new(12345);

        // Spawn 100 agents
        for _ in 0..100 {
            sim.spawn_one(rng.next_f32() * 800.0, rng.next_f32() * 600.0);
        }
        assert_eq!(sim.agent_count, 100);

        // Remove 50 in random order
        for _ in 0..50 {
            let id = (rng.next_f32() * sim.agent_count as f32) as u32;
            sim.remove_agent(id);
        }
        assert_eq!(sim.agent_count, 50);

        // Spawn 50 more
        for _ in 0..50 {
            sim.spawn_one(rng.next_f32() * 800.0, rng.next_f32() * 600.0);
        }
        assert_eq!(sim.agent_count, 100);

        // All agents should be alive and have valid positions
        for i in 0..sim.agent_count {
            let base = i * STRIDE;
            assert!(boid::has_flag(&sim.buf, base, boid::FLAG_ALIVE));
            assert!(!sim.buf[base + boid::X].is_nan());
            assert!(!sim.buf[base + boid::Y].is_nan());
        }
    }
}
