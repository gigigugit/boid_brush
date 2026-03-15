// =============================================================================
// sim.rs — Simulation struct: agent pool, step loop, spawn/despawn
//
// Owns a flat Vec<f32> of capacity max_agents * STRIDE. Agent lifecycle is
// managed via an object pool with a free-list for O(1) spawn and swap-remove
// despawn.
//
// The JS host reads the agent buffer directly via get_agent_buffer_ptr()
// as a Float32Array view over wasm.memory.buffer (zero-copy).
// =============================================================================

use crate::boid::*;
use crate::forces::{self, Rng};
use crate::noise::SimplexNoise;
use crate::params::{SimParams, PARAMS_LEN};
use crate::sensing::{self, SensingMap};
use crate::spawn::{self, SpawnShape};

pub struct Simulation {
    /// Flat agent buffer: agent i occupies buf[i*STRIDE .. (i+1)*STRIDE].
    pub buf: Vec<f32>,
    /// Number of live agents (packed at the front of buf).
    pub agent_count: usize,
    /// Maximum agent capacity.
    pub max_agents: usize,
    /// Canvas dimensions (for boundary reference).
    pub width: u32,
    pub height: u32,
    /// Current simulation parameters (updated via set_params).
    pub params: SimParams,
    /// Params raw buffer (JS writes here, we parse into SimParams).
    pub params_buf: Vec<f32>,
    /// PRNG for forces and spawning.
    pub rng: Rng,
    /// Simplex noise for flow field.
    pub noise: SimplexNoise,
    /// Pixel sensing map.
    pub sensing: SensingMap,
    /// Scratch buffer for spawn shape positions.
    spawn_scratch: Vec<(f32, f32)>,
}

impl Simulation {
    pub fn new(width: u32, height: u32, max_agents: u32) -> Self {
        let max = max_agents as usize;
        let seed = 42u32;
        Self {
            buf: vec![0.0; max * STRIDE],
            agent_count: 0,
            max_agents: max,
            width,
            height,
            params: SimParams::default(),
            params_buf: vec![0.0; PARAMS_LEN],
            rng: Rng::new(seed),
            noise: SimplexNoise::new(seed as f32),
            sensing: SensingMap::new(),
            spawn_scratch: Vec::with_capacity(256),
        }
    }

    /// Update params from the raw f32 buffer (called by set_params export).
    pub fn update_params(&mut self) {
        self.params = SimParams::from_raw(&self.params_buf);
    }

    /// Spawn a single agent at (x, y). Returns the agent index (ID).
    /// Per-agent multipliers are randomized based on variance params.
    pub fn spawn_one(&mut self, x: f32, y: f32) -> u32 {
        if self.agent_count >= self.max_agents {
            return u32::MAX;
        }
        let idx = self.agent_count;
        let base = idx * STRIDE;
        let p = &self.params;

        let vx = (self.rng.next_f32() - 0.5) * 2.0;
        let vy = (self.rng.next_f32() - 0.5) * 2.0;
        let wa = self.rng.next_f32() * core::f32::consts::PI * 2.0;
        let nx = self.rng.next_f32() * 1000.0;
        let ny = self.rng.next_f32() * 1000.0;

        // Base sm/om (always have some natural variance)
        let sm_base = 0.7 + self.rng.next_f32() * 0.6;
        let om_base = 0.6 + self.rng.next_f32() * 0.8;

        // Apply per-param variance: size_var and opacity_var scale the
        // randomization range. At 0 → no extra variance. At 1 → ±100%.
        let sv = p.size_var.max(p.individuality);
        let ov = p.opacity_var.max(p.individuality);
        let sm = sm_base * (1.0 + (self.rng.next_f32() - 0.5) * 2.0 * sv);
        let om = om_base * (1.0 + (self.rng.next_f32() - 0.5) * 2.0 * ov);

        // Per-agent behavioral multipliers (centered at 1.0)
        let spv = p.speed_var.max(p.individuality);
        let fv = p.force_var.max(p.individuality);
        let spd_m = 1.0 + (self.rng.next_f32() - 0.5) * 2.0 * spv;
        let seek_m = 1.0 + (self.rng.next_f32() - 0.5) * 2.0 * fv;
        let coh_m = 1.0 + (self.rng.next_f32() - 0.5) * 2.0 * fv;
        let sep_m = 1.0 + (self.rng.next_f32() - 0.5) * 2.0 * fv;

        // Per-agent color modifiers (set once at spawn)
        // hue: offset in degrees, ±180 at max variance
        let hv = p.hue_var;
        let hue = (self.rng.next_f32() - 0.5) * 2.0 * 180.0 * hv;
        // sat: additive offset to saturation (0-100%), ±50 at max
        let satv = p.sat_var;
        let sat = (self.rng.next_f32() - 0.5) * 2.0 * 50.0 * satv;
        // lit: additive offset to lightness (0-100%), ±30 at max
        let litv = p.lit_var;
        let lit = (self.rng.next_f32() - 0.5) * 2.0 * 30.0 * litv;

        init_agent(&mut self.buf, base, x, y, vx, vy, sm, om, wa, nx, ny,
                    spd_m, seek_m, coh_m, sep_m, hue, sat, lit);
        self.agent_count += 1;
        idx as u32
    }

    /// Batch-spawn agents in a given shape centered at (cx, cy).
    pub fn spawn_batch(
        &mut self,
        cx: f32,
        cy: f32,
        count: u32,
        shape: u32,
        angle: f32,
        jitter: f32,
        radius: f32,
    ) {
        let shape = SpawnShape::from_u32(shape);
        let count = count as usize;

        spawn::generate(shape, count, radius, &mut self.rng, &mut self.spawn_scratch);
        spawn::transform(
            &mut self.spawn_scratch,
            cx,
            cy,
            angle,
            jitter,
            radius,
            &mut self.rng,
        );

        let n = self.spawn_scratch.len();
        for i in 0..n {
            if self.agent_count >= self.max_agents {
                break;
            }
            let (px, py) = self.spawn_scratch[i];
            self.spawn_one(px, py);
        }
    }

    /// Remove agent by index. Swap-removes with the last live agent.
    pub fn remove_agent(&mut self, id: u32) {
        let idx = id as usize;
        if idx >= self.agent_count {
            return;
        }
        let last = self.agent_count - 1;
        if idx != last {
            let src = last * STRIDE;
            let dst = idx * STRIDE;
            for i in 0..STRIDE {
                self.buf[dst + i] = self.buf[src + i];
            }
        }
        // Zero out the removed slot (now at 'last' position)
        let clear_base = last * STRIDE;
        for i in 0..STRIDE {
            self.buf[clear_base + i] = 0.0;
        }
        self.agent_count -= 1;
    }

    /// Clear all agents (used at stroke start for respawnOnStroke).
    pub fn clear_agents(&mut self) {
        for i in 0..self.agent_count * STRIDE {
            self.buf[i] = 0.0;
        }
        self.agent_count = 0;
    }

    /// Main simulation step. Advances all alive agents by one frame.
    /// Call set_params() before this to update forces/target.
    pub fn step(&mut self, _dt: f32) {
        let p = &self.params;
        let ms = p.max_speed;

        // Phase 1: Zero accelerations and apply per-agent forces
        //          (seek, flee, jitter, wander, flow, sensing)
        for i in 0..self.agent_count {
            let base = i * STRIDE;
            if !has_flag(&self.buf, base, FLAG_ALIVE) {
                continue;
            }

            // Per-agent multipliers
            let agent_ms = ms * self.buf[base + SPD_M];
            let agent_seek = p.seek * self.buf[base + SEEK_M];

            // Zero accel
            self.buf[base + AX] = 0.0;
            self.buf[base + AY] = 0.0;

            // Seek cursor (uses per-agent seek weight and speed)
            forces::seek(&mut self.buf, base, p.target_x, p.target_y, agent_seek, agent_ms);

            // Flee cursor
            if p.flee_radius > 0.0 {
                forces::flee(&mut self.buf, base, p.target_x, p.target_y, p.flee_radius, agent_ms);
            }

            // Jitter
            forces::jitter(&mut self.buf, base, p.jitter, agent_ms, &mut self.rng);

            // Wander
            forces::wander(
                &mut self.buf,
                base,
                p.wander,
                p.wander_speed,
                agent_ms,
                &mut self.rng,
            );

            // Flow field
            forces::flow_field(
                &mut self.buf,
                base,
                p.flow_field,
                p.flow_scale,
                agent_ms,
                p.time,
                &self.noise,
            );

            // Sensing
            sensing::apply_sensing_force(&mut self.buf, base, p, &self.sensing);
        }

        // Phase 2: Neighbor forces (cohesion, separation, alignment)
        // Uses per-agent COH_M and SEP_M multipliers.
        forces::apply_neighbor_forces(&mut self.buf, self.agent_count, &self.params);

        // Phase 3: Integrate (uses per-agent speed multiplier)
        for i in 0..self.agent_count {
            let base = i * STRIDE;
            if !has_flag(&self.buf, base, FLAG_ALIVE) {
                continue;
            }
            let agent_ms = ms * self.buf[base + SPD_M];
            forces::integrate(&mut self.buf, base, agent_ms, p.damping);
        }
    }
}
