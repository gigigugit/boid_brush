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
use crate::params::{AgentParams, SimParams, PARAMS_LEN};
use crate::sensing::{self, SensingMap};
use crate::spawn::{self, SpawnShape};

#[cfg(feature = "spatial-hash")]
use crate::spatial::SpatialGrid;

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
    /// Spatial grid for O(n·k) neighbor queries (built each frame when
    /// the `spatial-hash` feature is enabled).
    #[cfg(feature = "spatial-hash")]
    spatial_grid: SpatialGrid,
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
            #[cfg(feature = "spatial-hash")]
            spatial_grid: SpatialGrid::new(max),
        }
    }

    /// Update params from the raw f32 buffer (called by set_params export).
    pub fn update_params(&mut self) {
        self.params = SimParams::from_raw(&self.params_buf);
    }

    pub fn resize_canvas(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
        if self.sensing.width > 0 && self.sensing.height > 0 {
            // Preserve the existing sensing buffer resolution and data, but
            // refresh its canvas-to-sensing scale factors for the new display size.
            self.sensing
                .resize(self.sensing.width, self.sensing.height, width, height);
        }
    }

    fn generate_agent_traits(
        &mut self,
        params: &AgentParams,
    ) -> (f32, f32, f32, f32, f32, f32, f32, f32, f32) {
        let sm_base = 0.7 + self.rng.next_f32() * 0.6;
        let om_base = 0.6 + self.rng.next_f32() * 0.8;
        let sv = params.size_var.max(params.individuality);
        let ov = params.opacity_var.max(params.individuality);
        let sm = sm_base * (1.0 + (self.rng.next_f32() - 0.5) * 2.0 * sv);
        let om = om_base * (1.0 + (self.rng.next_f32() - 0.5) * 2.0 * ov);

        let spv = params.speed_var.max(params.individuality);
        let fv = params.force_var.max(params.individuality);
        let spd_m = 1.0 + (self.rng.next_f32() - 0.5) * 2.0 * spv;
        let seek_m = 1.0 + (self.rng.next_f32() - 0.5) * 2.0 * fv;
        let coh_m = 1.0 + (self.rng.next_f32() - 0.5) * 2.0 * fv;
        let sep_m = 1.0 + (self.rng.next_f32() - 0.5) * 2.0 * fv;

        let hue = (self.rng.next_f32() - 0.5) * 2.0 * 180.0 * params.hue_var;
        let sat = (self.rng.next_f32() - 0.5) * 2.0 * 50.0 * params.sat_var;
        let lit = (self.rng.next_f32() - 0.5) * 2.0 * 30.0 * params.lit_var;
        (sm, om, spd_m, seek_m, coh_m, sep_m, hue, sat, lit)
    }

    fn apply_agent_traits(&mut self, base: usize, params: &AgentParams) {
        let (sm, om, spd_m, seek_m, coh_m, sep_m, hue, sat, lit) =
            self.generate_agent_traits(params);
        self.buf[base + SM] = sm;
        self.buf[base + OM] = om;
        self.buf[base + SPD_M] = spd_m;
        self.buf[base + SEEK_M] = seek_m;
        self.buf[base + COH_M] = coh_m;
        self.buf[base + SEP_M] = sep_m;
        self.buf[base + HUE] = hue;
        self.buf[base + SAT] = sat;
        self.buf[base + LIT] = lit;
    }

    /// Spawn a single agent at (x, y). Returns the agent index (ID).
    /// Per-agent multipliers are randomized based on variance params.
    pub fn spawn_one(&mut self, x: f32, y: f32) -> u32 {
        if self.agent_count >= self.max_agents {
            return u32::MAX;
        }
        let idx = self.agent_count;
        let base = idx * STRIDE;
        let params = self.params.params_for(false);

        let vx = (self.rng.next_f32() - 0.5) * 2.0;
        let vy = (self.rng.next_f32() - 0.5) * 2.0;
        let wa = self.rng.next_f32() * core::f32::consts::PI * 2.0;
        let nx = self.rng.next_f32() * 1000.0;
        let ny = self.rng.next_f32() * 1000.0;

        let (sm, om, spd_m, seek_m, coh_m, sep_m, hue, sat, lit) =
            self.generate_agent_traits(&params);

        init_agent(
            &mut self.buf,
            base,
            x,
            y,
            vx,
            vy,
            sm,
            om,
            wa,
            nx,
            ny,
            spd_m,
            seek_m,
            coh_m,
            sep_m,
            hue,
            sat,
            lit,
        );
        self.agent_count += 1;
        idx as u32
    }

    pub fn set_leader_range(&mut self, start_index: u32, end_index: u32, leader_count: u32) {
        let start = (start_index as usize).min(self.agent_count);
        let end = (end_index as usize).min(self.agent_count);
        let leader_limit = leader_count as usize;
        if start >= end {
            return;
        }
        let leader_params = self.params.params_for(true);
        for (offset, agent_index) in (start..end).enumerate() {
            let base = agent_index * STRIDE;
            if offset < leader_limit {
                set_flag(&mut self.buf, base, FLAG_LEADER);
                self.apply_agent_traits(base, &leader_params);
            } else {
                clear_flag(&mut self.buf, base, FLAG_LEADER);
            }
        }
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

    /// Clear all agents.
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
        let follower_params = p.params_for(false);
        let leader_params = p.params_for(true);

        // Phase 1: Zero accelerations and apply per-agent forces
        //          (seek, flee, jitter, wander, flow, sensing)
        for i in 0..self.agent_count {
            let base = i * STRIDE;
            let flags = self.buf[base + FLAGS] as u32;
            if flags & FLAG_ALIVE == 0 {
                continue;
            }
            let agent_params = if flags & FLAG_LEADER != 0 {
                leader_params
            } else {
                follower_params
            };

            // Per-agent multipliers
            let agent_ms = agent_params.max_speed * self.buf[base + SPD_M];
            let agent_seek = agent_params.seek * self.buf[base + SEEK_M];

            // Zero accel
            self.buf[base + AX] = 0.0;
            self.buf[base + AY] = 0.0;

            // Seek cursor (uses per-agent seek weight and speed)
            forces::seek(
                &mut self.buf,
                base,
                p.target_x,
                p.target_y,
                agent_seek,
                agent_ms,
            );

            // Flee cursor
            if agent_params.flee_radius > 0.0 {
                forces::flee(
                    &mut self.buf,
                    base,
                    p.target_x,
                    p.target_y,
                    agent_params.flee_radius,
                    agent_ms,
                );
            }

            // Jitter
            forces::jitter(
                &mut self.buf,
                base,
                agent_params.jitter,
                agent_ms,
                &mut self.rng,
            );

            // Wander
            forces::wander(
                &mut self.buf,
                base,
                agent_params.wander,
                agent_params.wander_speed,
                agent_ms,
                &mut self.rng,
            );

            // Flow field
            forces::flow_field(
                &mut self.buf,
                base,
                agent_params.flow_field,
                agent_params.flow_scale,
                agent_ms,
                p.time,
                &self.noise,
            );

            // Sensing
            sensing::apply_sensing_force(&mut self.buf, base, &agent_params, &self.sensing);
        }

        // Phase 2: Neighbor forces (cohesion, separation, alignment)
        // Uses per-agent COH_M and SEP_M multipliers.
        //
        // When `spatial-hash` is enabled (default), a uniform grid limits
        // neighbor search to the 3×3 cell neighborhood — O(n·k) instead of
        // O(n²). The grid is rebuilt each frame from live agent positions.
        #[cfg(feature = "spatial-hash")]
        {
            self.spatial_grid.build(
                &self.buf,
                self.agent_count,
                self.params.max_neighbor_radius(),
                self.params.max_separation_radius(),
                self.width,
                self.height,
            );
            forces::apply_neighbor_forces_grid(
                &mut self.buf,
                self.agent_count,
                &self.params,
                &self.spatial_grid,
            );
        }
        #[cfg(not(feature = "spatial-hash"))]
        forces::apply_neighbor_forces(&mut self.buf, self.agent_count, &self.params);

        // Phase 3: Integrate (uses per-agent speed multiplier)
        for i in 0..self.agent_count {
            let base = i * STRIDE;
            let flags = self.buf[base + FLAGS] as u32;
            if flags & FLAG_ALIVE == 0 {
                continue;
            }
            let agent_params = if flags & FLAG_LEADER != 0 {
                leader_params
            } else {
                follower_params
            };
            let agent_ms = agent_params.max_speed * self.buf[base + SPD_M];
            let bounds_margin = agent_params.boundary_margin;
            let (min_x, min_y, max_x, max_y) = if bounds_margin >= 0.0 {
                (
                    -bounds_margin,
                    -bounds_margin,
                    self.width as f32 + bounds_margin,
                    self.height as f32 + bounds_margin,
                )
            } else {
                (1.0, 1.0, 0.0, 0.0)
            };
            forces::integrate(
                &mut self.buf,
                base,
                agent_ms,
                agent_params.damping,
                min_x,
                min_y,
                max_x,
                max_y,
            );
        }
    }
}
