#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FluidRenderMode {
    Particles,
    Grid,
    Hybrid,
}

impl From<u32> for FluidRenderMode {
    fn from(value: u32) -> Self {
        match value {
            1 => Self::Grid,
            2 => Self::Hybrid,
            _ => Self::Particles,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FluidSimulationType {
    Sph,
    Eulerian,
    Lbm,
}

impl From<u32> for FluidSimulationType {
    fn from(value: u32) -> Self {
        match value {
            1 => Self::Eulerian,
            2 => Self::Lbm,
            _ => Self::Sph,
        }
    }
}

#[derive(Clone, Copy)]
pub struct FluidParams {
    pub particle_radius: f32,
    pub viscosity: f32,
    pub density: f32,
    pub surface_tension: f32,
    pub time_step: f32,
    pub substeps: u32,
    pub motion_decay: f32,
    pub stop_speed: f32,
    pub pigment_carry: f32,
    pub pigment_retention: f32,
    pub simulation_type: FluidSimulationType,
    pub render_mode: FluidRenderMode,
}

impl Default for FluidParams {
    fn default() -> Self {
        Self {
            particle_radius: 4.0,
            viscosity: 0.45,
            density: 0.55,
            surface_tension: 0.58,
            time_step: 1.0,
            substeps: 3,
            motion_decay: 0.12,
            stop_speed: 0.025,
            pigment_carry: 0.44,
            pigment_retention: 0.78,
            simulation_type: FluidSimulationType::Sph,
            render_mode: FluidRenderMode::Hybrid,
        }
    }
}

#[derive(Clone, Copy)]
struct FluidParticle {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    outside_slack: f32,
    radius: f32,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

#[derive(Clone, Copy, Default)]
struct GridCell {
    count: u32,
    r: u32,
    g: u32,
    b: u32,
    alpha: f32,
    allow_outside: bool,
}

#[derive(Clone)]
struct LbmState {
    dist: Vec<[f32; 9]>,
    next_dist: Vec<[f32; 9]>,
    rho: Vec<f32>,
    velocity: Vec<[f32; 2]>,
    phase: Vec<f32>,
    next_phase: Vec<f32>,
    pigment: Vec<[f32; 4]>,
    next_pigment: Vec<[f32; 4]>,
    active_cells: u32,
}

impl LbmState {
    fn new(px_count: usize) -> Self {
        Self {
            dist: vec![[0.0; 9]; px_count],
            next_dist: vec![[0.0; 9]; px_count],
            rho: vec![0.0; px_count],
            velocity: vec![[0.0; 2]; px_count],
            phase: vec![0.0; px_count],
            next_phase: vec![0.0; px_count],
            pigment: vec![[0.0; 4]; px_count],
            next_pigment: vec![[0.0; 4]; px_count],
            active_cells: 0,
        }
    }

    fn clear(&mut self) {
        self.dist.fill([0.0; 9]);
        self.next_dist.fill([0.0; 9]);
        self.rho.fill(0.0);
        self.velocity.fill([0.0; 2]);
        self.phase.fill(0.0);
        self.next_phase.fill(0.0);
        self.pigment.fill([0.0; 4]);
        self.next_pigment.fill([0.0; 4]);
        self.active_cells = 0;
    }
}

const LBM_DIRS: [(i32, i32); 9] = [
    (0, 0),
    (1, 0),
    (0, 1),
    (-1, 0),
    (0, -1),
    (1, 1),
    (-1, 1),
    (-1, -1),
    (1, -1),
];
const LBM_WEIGHTS: [f32; 9] = [
    4.0 / 9.0,
    1.0 / 9.0,
    1.0 / 9.0,
    1.0 / 9.0,
    1.0 / 9.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
];
const LBM_OPPOSITE: [usize; 9] = [0, 3, 4, 1, 2, 7, 8, 5, 6];
const LBM_EPSILON: f32 = 0.0001;
const LBM_RENDER_ACTIVITY_THRESHOLD: f32 = 0.001;
const LBM_RENDER_PIGMENT_THRESHOLD: f32 = 0.0001;
const LBM_PHASE_CLEAR_THRESHOLD: f32 = 0.003;
const LBM_MASK_EDGE_RETAIN_FACTOR: f32 = 0.96;
const LBM_RENDER_ALPHA_MAX: f32 = 0.96;
const LBM_STOP_SETTLE_BASE_MIX: f32 = 0.9;
const LBM_STOP_SETTLE_MAX_MIX: f32 = 0.995;
const LBM_STOP_RETENTION_EXPONENT: i32 = 2;
const LBM_ACTIVE_STOP_SPEED_RATIO: f32 = 1.0;
const LBM_ACTIVE_SPEED_FLOOR: f32 = 0.0025;
const LBM_ACTIVE_RHO_THRESHOLD: f32 = 0.012;
const LBM_ACTIVE_PIGMENT_THRESHOLD: f32 = 0.008;
const LBM_ACTIVE_PHASE_THRESHOLD: f32 = 0.02;
const LBM_REST_SPEED_RATIO: f32 = 1.0;
const LBM_FINAL_REST_ACTIVE_LIMIT: u32 = 20;
const LBM_FINAL_REST_MOTION_MULTIPLIER: f32 = 6.0;
const LBM_VISIBLE_CARRY_BASE: f32 = 0.35;
const LBM_VISIBLE_CARRY_RANGE: f32 = 1.55;
const LBM_PHASE_ADVECT_BASE: f32 = 2.4;
const LBM_PHASE_ADVECT_RANGE: f32 = 4.6;
const LBM_PIGMENT_ADVECT_BASE: f32 = 3.1;
const LBM_PIGMENT_ADVECT_RANGE: f32 = 5.6;
const LBM_PHASE_RETENTION_BASE: f32 = 0.984;
const LBM_PHASE_RETENTION_RANGE: f32 = 0.013;
const LBM_PIGMENT_RETENTION_BASE: f32 = 0.986;
const LBM_PIGMENT_RETENTION_RANGE: f32 = 0.012;
const LBM_MOTION_DECAY_SCALE: f32 = 0.06;
const LBM_MOTION_DECAY_MIN: f32 = 0.91;
const LBM_MOTION_DECAY_MAX: f32 = 0.9993;
const LBM_INTERFACE_DRAG_BASE: f32 = 0.018;
const LBM_INTERFACE_DRAG_VISCOSITY_SCALE: f32 = 0.014;
const LBM_PATTERN_CURVATURE_PUSH: f32 = 3.35;
const LBM_PATTERN_VORTEX_BASE: f32 = 0.016;
const LBM_PATTERN_VORTEX_TENSION_SCALE: f32 = 0.055;
const LBM_PATTERN_VORTEX_DENSITY_SCALE: f32 = 0.016;
#[cfg(test)]
const LBM_STOP_SETTLING_IMPROVEMENT_THRESHOLD: f32 = 0.82;

pub struct FluidSimulation {
    width: u32,
    height: u32,
    params: FluidParams,
    mask_alpha: Vec<u8>,
    mask_has_content: bool,
    pixels: Vec<u8>,
    particles: Vec<FluidParticle>,
    particle_view: Vec<f32>,
    lbm: LbmState,
}

impl FluidSimulation {
    pub fn new(width: u32, height: u32) -> Self {
        let px_count = (width * height) as usize;
        Self {
            width,
            height,
            params: FluidParams::default(),
            mask_alpha: vec![0; px_count],
            mask_has_content: false,
            pixels: vec![0; px_count * 4],
            particles: Vec::new(),
            particle_view: Vec::new(),
            lbm: LbmState::new(px_count),
        }
    }

    pub fn set_params(
        &mut self,
        particle_radius: f32,
        viscosity: f32,
        density: f32,
        surface_tension: f32,
        time_step: f32,
        substeps: u32,
        motion_decay: f32,
        stop_speed: f32,
        pigment_carry: f32,
        pigment_retention: f32,
        simulation_type: u32,
        render_mode: u32,
    ) {
        let previous_type = self.params.simulation_type;
        self.params = FluidParams {
            particle_radius: particle_radius.clamp(0.5, 64.0),
            viscosity: viscosity.clamp(0.0, 1.0),
            density: density.clamp(0.0, 1.0),
            surface_tension: surface_tension.clamp(0.0, 1.0),
            time_step: time_step.clamp(0.01, 8.0),
            substeps: substeps.clamp(1, 12),
            motion_decay: motion_decay.clamp(0.0, 2.0),
            stop_speed: stop_speed.clamp(0.0, 3.0),
            pigment_carry: pigment_carry.clamp(0.0, 1.0),
            pigment_retention: pigment_retention.clamp(0.0, 1.0),
            simulation_type: FluidSimulationType::from(simulation_type),
            render_mode: FluidRenderMode::from(render_mode),
        };

        if previous_type != self.params.simulation_type {
            match self.params.simulation_type {
                FluidSimulationType::Lbm => self.transfer_particles_to_lbm(),
                _ if previous_type == FluidSimulationType::Lbm => self.transfer_lbm_to_particles(),
                _ => {}
            }
        }
    }

    pub fn set_mask_rgba(&mut self, rgba: &[u8]) {
        let expected_len = (self.width * self.height * 4) as usize;
        if rgba.len() < expected_len {
            return;
        }

        self.mask_has_content = false;
        for (index, alpha) in self.mask_alpha.iter_mut().enumerate() {
            *alpha = rgba[index * 4 + 3];
            self.mask_has_content |= *alpha > 8;
        }

        self.seed_lbm_phase_from_mask();
        self.trim_lbm_to_mask();
        self.sync_particle_view();
    }

    pub fn add_particles_from_slice(&mut self, packed: &[f32], stride: usize) {
        if stride < 9 {
            return;
        }

        if self.params.simulation_type == FluidSimulationType::Lbm {
            for chunk in packed.chunks_exact(stride) {
                self.inject_particle_to_lbm(chunk);
            }
            self.recompute_lbm_macros();
            self.refresh_lbm_activity();
            self.sync_particle_view();
            return;
        }

        for chunk in packed.chunks_exact(stride) {
            let particle = FluidParticle {
                x: chunk[0],
                y: chunk[1],
                vx: chunk[2],
                vy: chunk[3],
                outside_slack: 0.0,
                r: chunk[4].clamp(0.0, 255.0) as u8,
                g: chunk[5].clamp(0.0, 255.0) as u8,
                b: chunk[6].clamp(0.0, 255.0) as u8,
                a: (chunk[7].clamp(0.0, 1.0) * 255.0).clamp(0.0, 255.0) as u8,
                radius: chunk[8].clamp(0.5, 64.0),
            };
            if self.inside_mask(particle.x, particle.y) {
                self.particles.push(particle);
            }
        }

        const MAX_PARTICLES: usize = 5000;
        if self.particles.len() > MAX_PARTICLES {
            let overflow = self.particles.len() - MAX_PARTICLES;
            self.particles.drain(0..overflow);
        }

        self.sync_particle_view();
    }

    pub fn clear_particles(&mut self) {
        self.particles.clear();
        self.particle_view.clear();
        self.lbm.clear();
        self.pixels.fill(0);
    }

    pub fn particle_count(&self) -> u32 {
        if self.params.simulation_type == FluidSimulationType::Lbm {
            self.lbm.active_cells
        } else {
            self.particles.len() as u32
        }
    }

    fn lbm_visible_carry_scale(&self) -> f32 {
        LBM_VISIBLE_CARRY_BASE + self.params.pigment_carry * LBM_VISIBLE_CARRY_RANGE
    }

    fn lbm_phase_advect_scale(&self) -> f32 {
        LBM_PHASE_ADVECT_BASE + self.params.pigment_carry * LBM_PHASE_ADVECT_RANGE
    }

    fn lbm_pigment_advect_scale(&self) -> f32 {
        LBM_PIGMENT_ADVECT_BASE + self.params.pigment_carry * LBM_PIGMENT_ADVECT_RANGE
    }

    fn lbm_phase_retention(&self) -> f32 {
        (LBM_PHASE_RETENTION_BASE + self.params.pigment_retention * LBM_PHASE_RETENTION_RANGE)
            .clamp(0.0, 0.9997)
    }

    fn lbm_pigment_retention(&self) -> f32 {
        (LBM_PIGMENT_RETENTION_BASE
            + self.params.pigment_retention * LBM_PIGMENT_RETENTION_RANGE)
            .clamp(0.0, 0.9998)
    }

    fn lbm_visible_speed(&self, speed: f32, carries_visible_fluid: bool) -> f32 {
        if carries_visible_fluid {
            speed * self.lbm_visible_carry_scale()
        } else {
            speed
        }
    }

    pub fn step(&mut self, dt: f32) {
        let substeps = self.params.substeps.max(1) as usize;
        let scaled_dt = dt.max(0.0005) * self.params.time_step;
        let sub_dt = scaled_dt / substeps as f32;
        let width = self.width;
        let height = self.height;
        let mask = self.mask_alpha.clone();
        let mask_has_content = self.mask_has_content;

        match self.params.simulation_type {
            FluidSimulationType::Lbm => {
                if self.lbm.active_cells == 0 {
                    self.render_pixels();
                    return;
                }

                for _ in 0..substeps {
                    self.step_lbm(sub_dt, &mask, mask_has_content, width, height);
                }
            }
            _ => {
                if self.particles.is_empty() {
                    self.render_pixels();
                    return;
                }

                let interaction_radius = (self.params.particle_radius * 3.2).max(3.0);
                let interaction_radius_sq = interaction_radius * interaction_radius;
                for _ in 0..substeps {
                    match self.params.simulation_type {
                        FluidSimulationType::Sph => {
                            self.step_sph(
                                sub_dt,
                                interaction_radius_sq,
                                &mask,
                                mask_has_content,
                                width,
                                height,
                            );
                        }
                        FluidSimulationType::Eulerian => {
                            self.step_grid_flow(
                                sub_dt,
                                &mask,
                                mask_has_content,
                                width,
                                height,
                                0.22,
                                0.16,
                                false,
                            );
                        }
                        FluidSimulationType::Lbm => unreachable!(),
                    }
                }
            }
        }

        self.sync_particle_view();
        self.render_pixels();
    }

    fn step_sph(
        &mut self,
        sub_dt: f32,
        interaction_radius_sq: f32,
        mask: &[u8],
        mask_has_content: bool,
        width: u32,
        height: u32,
    ) {
        let interaction_radius = (self.params.particle_radius * 3.2).max(3.0);
        let len = self.particles.len();
        let mut delta_v = vec![(0.0f32, 0.0f32); len];

        for i in 0..len {
            for j in (i + 1)..len {
                let dx = self.particles[j].x - self.particles[i].x;
                let dy = self.particles[j].y - self.particles[i].y;
                let dist_sq = dx * dx + dy * dy;
                if !(0.0001..interaction_radius_sq).contains(&dist_sq) {
                    continue;
                }

                let dist = dist_sq.sqrt();
                let nx = dx / dist;
                let ny = dy / dist;
                let overlap = 1.0 - dist / interaction_radius;
                let repel = overlap * (0.025 + self.params.density * 0.11);
                let viscosity = overlap * self.params.viscosity * 0.08;

                delta_v[i].0 -= nx * repel;
                delta_v[i].1 -= ny * repel;
                delta_v[j].0 += nx * repel;
                delta_v[j].1 += ny * repel;

                delta_v[i].0 += (self.particles[j].vx - self.particles[i].vx) * viscosity;
                delta_v[i].1 += (self.particles[j].vy - self.particles[i].vy) * viscosity;
                delta_v[j].0 += (self.particles[i].vx - self.particles[j].vx) * viscosity;
                delta_v[j].1 += (self.particles[i].vy - self.particles[j].vy) * viscosity;
            }
        }

        let decay = (1.0 - self.params.motion_decay * sub_dt * 60.0).clamp(0.0, 1.0);
        for (index, particle) in self.particles.iter_mut().enumerate() {
            particle.vx += delta_v[index].0 * sub_dt * 60.0;
            particle.vy += delta_v[index].1 * sub_dt * 60.0;
            particle.vx *= decay;
            particle.vy *= decay;
            Self::advance_particle(
                particle,
                sub_dt,
                self.params.stop_speed,
                self.params.density,
                self.params.viscosity,
                mask,
                mask_has_content,
                width,
                height,
            );
        }
    }

    fn step_grid_flow(
        &mut self,
        sub_dt: f32,
        mask: &[u8],
        mask_has_content: bool,
        width: u32,
        height: u32,
        flow_scale: f32,
        swirl_scale: f32,
        lattice_bias: bool,
    ) {
        let px_count = (width * height) as usize;
        let mut field_x = vec![0.0f32; px_count];
        let mut field_y = vec![0.0f32; px_count];
        let mut counts = vec![0.0f32; px_count];
        let mut density_map = vec![0.0f32; px_count];

        for particle in &self.particles {
            let ix = particle
                .x
                .round()
                .clamp(0.0, width.saturating_sub(1) as f32) as u32;
            let iy = particle
                .y
                .round()
                .clamp(0.0, height.saturating_sub(1) as f32) as u32;
            let index = (iy * width + ix) as usize;
            field_x[index] += particle.vx;
            field_y[index] += particle.vy;
            counts[index] += 1.0;
            density_map[index] +=
                (particle.radius / self.params.particle_radius.max(0.5)).clamp(0.35, 2.2);
        }

        let mut smoothed_x = vec![0.0f32; px_count];
        let mut smoothed_y = vec![0.0f32; px_count];
        for iy in 0..height as i32 {
            for ix in 0..width as i32 {
                let index = (iy as u32 * width + ix as u32) as usize;
                if mask_has_content && mask[index] <= 8 {
                    continue;
                }

                let mut sum_x = 0.0;
                let mut sum_y = 0.0;
                let mut sum_w = 0.0;
                for oy in -1..=1 {
                    for ox in -1..=1 {
                        let nx = ix + ox;
                        let ny = iy + oy;
                        if nx < 0 || ny < 0 || nx >= width as i32 || ny >= height as i32 {
                            continue;
                        }
                        let nindex = (ny as u32 * width + nx as u32) as usize;
                        if mask_has_content && mask[nindex] <= 8 {
                            continue;
                        }
                        let weight = if ox == 0 && oy == 0 { 1.8 } else { 1.0 };
                        let count = counts[nindex].max(1.0);
                        sum_x += field_x[nindex] / count * weight;
                        sum_y += field_y[nindex] / count * weight;
                        sum_w += weight;
                    }
                }

                let grad_x = Self::sample_mask(mask, mask_has_content, width, height, ix + 1, iy)
                    - Self::sample_mask(mask, mask_has_content, width, height, ix - 1, iy);
                let grad_y = Self::sample_mask(mask, mask_has_content, width, height, ix, iy + 1)
                    - Self::sample_mask(mask, mask_has_content, width, height, ix, iy - 1);
                let density_grad_x = Self::sample_density(&density_map, width, height, ix + 1, iy)
                    - Self::sample_density(&density_map, width, height, ix - 1, iy);
                let density_grad_y = Self::sample_density(&density_map, width, height, ix, iy + 1)
                    - Self::sample_density(&density_map, width, height, ix, iy - 1);
                let density_here = density_map[index];
                let pressure = density_here * (0.18 + self.params.density * 0.42);
                let edge_push = 0.18 + self.params.density * 0.34;
                let swirl_boost = if lattice_bias { 1.35 } else { 0.85 };
                let base_flow_x = sum_x / sum_w.max(1.0);
                let base_flow_y = sum_y / sum_w.max(1.0);
                let mut vx = base_flow_x * (flow_scale + density_here * 0.06)
                    - grad_y * swirl_scale * swirl_boost
                    - density_grad_x * pressure
                    - grad_x * edge_push;
                let mut vy = base_flow_y * (flow_scale + density_here * 0.06)
                    + grad_x * swirl_scale * swirl_boost
                    - density_grad_y * pressure
                    - grad_y * edge_push;
                if lattice_bias {
                    let swap_x = -vy * (0.26 + self.params.density * 0.62);
                    let swap_y = vx * (0.26 + self.params.density * 0.62);
                    vx += swap_x;
                    vy += swap_y;
                }
                smoothed_x[index] = vx;
                smoothed_y[index] = vy;
            }
        }

        let relax = if lattice_bias {
            0.34 + self.params.viscosity * 0.38
        } else {
            0.2 + self.params.viscosity * 0.28
        };
        let decay = if lattice_bias {
            (1.0 - self.params.motion_decay * sub_dt * 18.0).clamp(0.82, 1.0)
        } else {
            (1.0 - self.params.motion_decay * sub_dt * 22.0).clamp(0.8, 1.0)
        };
        let min_carried_speed = self.params.stop_speed * if lattice_bias { 6.5 } else { 3.5 };

        for particle in self.particles.iter_mut() {
            let ix = particle
                .x
                .round()
                .clamp(0.0, width.saturating_sub(1) as f32) as u32;
            let iy = particle
                .y
                .round()
                .clamp(0.0, height.saturating_sub(1) as f32) as u32;
            let index = (iy * width + ix) as usize;
            particle.vx += (smoothed_x[index] - particle.vx) * relax;
            particle.vy += (smoothed_y[index] - particle.vy) * relax;
            particle.vx *= decay;
            particle.vy *= decay;
            let speed = (particle.vx * particle.vx + particle.vy * particle.vy).sqrt();
            if speed < min_carried_speed {
                let boost = min_carried_speed - speed;
                let flow_x = smoothed_x[index];
                let flow_y = smoothed_y[index];
                let flow_mag = (flow_x * flow_x + flow_y * flow_y).sqrt();
                if speed > 0.0001 {
                    particle.vx += particle.vx / speed * boost;
                    particle.vy += particle.vy / speed * boost;
                } else if flow_mag > 0.0001 {
                    particle.vx += flow_x / flow_mag * boost;
                    particle.vy += flow_y / flow_mag * boost;
                } else if lattice_bias {
                    let curl_x = -smoothed_y[index];
                    let curl_y = smoothed_x[index];
                    let curl_mag = (curl_x * curl_x + curl_y * curl_y).sqrt();
                    if curl_mag > 0.0001 {
                        particle.vx += curl_x / curl_mag * boost;
                        particle.vy += curl_y / curl_mag * boost;
                    }
                }
            }
            Self::advance_particle(
                particle,
                sub_dt,
                self.params.stop_speed * 0.45,
                self.params.density,
                self.params.viscosity,
                mask,
                mask_has_content,
                width,
                height,
            );
        }
    }

    fn step_lbm(
        &mut self,
        _sub_dt: f32,
        mask: &[u8],
        mask_has_content: bool,
        width: u32,
        height: u32,
    ) {
        let dist = self.lbm.dist.clone();
        let phase = self.lbm.phase.clone();
        self.lbm.next_dist.fill([0.0; 9]);

        let tau = 0.56 + self.params.viscosity * 1.22;
        let omega = 1.0 / tau.max(0.52);
        let decay = (1.0 - self.params.motion_decay * LBM_MOTION_DECAY_SCALE)
            .clamp(LBM_MOTION_DECAY_MIN, LBM_MOTION_DECAY_MAX);
        let max_speed = 0.14 + self.params.density * 0.22 + self.params.surface_tension * 0.04;
        let surface_tension = 0.012 + self.params.surface_tension * 0.098;
        let interface_drag =
            (LBM_INTERFACE_DRAG_BASE + self.params.viscosity * LBM_INTERFACE_DRAG_VISCOSITY_SCALE)
                * 0.88;
        let stop_threshold = self.params.stop_speed.max(0.0);

        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let index = (y as u32 * width + x as u32) as usize;
                let cell = dist[index];
                let rho = cell.iter().sum::<f32>();
                let phase_here = phase[index];
                if rho < LBM_EPSILON && phase_here < 0.002 {
                    continue;
                }

                let mut ux = 0.0;
                let mut uy = 0.0;
                if rho >= LBM_EPSILON {
                    for dir in 0..9 {
                        ux += cell[dir] * LBM_DIRS[dir].0 as f32;
                        uy += cell[dir] * LBM_DIRS[dir].1 as f32;
                    }
                    ux /= rho;
                    uy /= rho;
                }
                ux *= decay;
                uy *= decay;

                let phase_px = Self::sample_phase(&phase, width, height, x + 1, y);
                let phase_nx = Self::sample_phase(&phase, width, height, x - 1, y);
                let phase_py = Self::sample_phase(&phase, width, height, x, y + 1);
                let phase_ny = Self::sample_phase(&phase, width, height, x, y - 1);
                let grad_x = (phase_px - phase_nx) * 0.5;
                let grad_y = (phase_py - phase_ny) * 0.5;
                let interface_band = (phase_here * (1.0 - phase_here) * 4.0).clamp(0.0, 1.0);
                let curvature = phase_px + phase_nx + phase_py + phase_ny - phase_here * 4.0;
                let phase_force = surface_tension * interface_band;
                ux += -grad_x * phase_force * 0.86
                    + curvature * grad_x * phase_force * LBM_PATTERN_CURVATURE_PUSH;
                uy += -grad_y * phase_force * 0.86
                    + curvature * grad_y * phase_force * LBM_PATTERN_CURVATURE_PUSH;
                let vortex_force = (LBM_PATTERN_VORTEX_BASE
                    + self.params.surface_tension * LBM_PATTERN_VORTEX_TENSION_SCALE
                    + self.params.density * LBM_PATTERN_VORTEX_DENSITY_SCALE)
                    * interface_band;
                ux += -grad_y * curvature * vortex_force;
                uy += grad_x * curvature * vortex_force;
                ux *= 1.0 - interface_band * interface_drag;
                uy *= 1.0 - interface_band * interface_drag;

                let speed = (ux * ux + uy * uy).sqrt();
                let mut stop_mix = 0.0;
                if stop_threshold > LBM_EPSILON && speed < stop_threshold {
                    let normalized = (1.0 - speed / stop_threshold).clamp(0.0, 1.0);
                    stop_mix = (normalized * LBM_STOP_SETTLE_BASE_MIX)
                        .clamp(0.0, LBM_STOP_SETTLE_MAX_MIX);
                    let retained = (1.0 - stop_mix).powi(LBM_STOP_RETENTION_EXPONENT);
                    ux *= retained;
                    uy *= retained;
                }
                if speed > max_speed {
                    let scale = max_speed / speed;
                    ux *= scale;
                    uy *= scale;
                }
                let rest_eq = if stop_mix > 0.0 {
                    Some(Self::lbm_rest_equilibrium(rho))
                } else {
                    None
                };

                for dir in 0..9 {
                    let f_eq = Self::lbm_equilibrium(rho, ux, uy, dir);
                    let mut f_post = cell[dir] + omega * (f_eq - cell[dir]);
                    if let Some(rest_eq) = rest_eq {
                        f_post = f_post * (1.0 - stop_mix) + rest_eq[dir] * stop_mix;
                    }
                    let nx = x + LBM_DIRS[dir].0;
                    let ny = y + LBM_DIRS[dir].1;

                    if nx >= 0 && ny >= 0 && nx < width as i32 && ny < height as i32 {
                        let nindex = (ny as u32 * width + nx as u32) as usize;
                        let neighbor_phase = Self::sample_phase(&phase, width, height, nx, ny);
                        let anchor_phase =
                            Self::sample_mask(mask, mask_has_content, width, height, nx, ny);
                        let forward =
                            (neighbor_phase * 0.86 + anchor_phase * 0.1 + 0.06).clamp(0.0, 1.0);
                        let bounce = (1.0 - forward).clamp(0.0, 1.0);
                        self.lbm.next_dist[nindex][dir] += f_post * forward;
                        if bounce > 0.0 {
                            self.lbm.next_dist[index][LBM_OPPOSITE[dir]] += f_post * bounce * 0.985;
                        }
                    } else {
                        self.lbm.next_dist[index][LBM_OPPOSITE[dir]] += f_post * 0.98;
                    }
                }
            }
        }

        std::mem::swap(&mut self.lbm.dist, &mut self.lbm.next_dist);
        self.recompute_lbm_macros();
        self.advect_lbm_phase(mask, mask_has_content, width, height);
        self.apply_phase_to_lbm();
        self.recompute_lbm_macros();
        self.advect_lbm_pigment(mask, mask_has_content, width, height);
        self.settle_lbm_resting_cells();
        self.refresh_lbm_activity();
    }

    fn sample_density(density_map: &[f32], width: u32, height: u32, x: i32, y: i32) -> f32 {
        if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
            return 0.0;
        }
        density_map[(y as u32 * width + x as u32) as usize]
    }

    fn sample_mask(
        mask: &[u8],
        mask_has_content: bool,
        width: u32,
        height: u32,
        x: i32,
        y: i32,
    ) -> f32 {
        if !mask_has_content {
            return if x >= 0 && y >= 0 && x < width as i32 && y < height as i32 {
                1.0
            } else {
                0.0
            };
        }
        if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
            return 0.0;
        }
        if mask[(y as u32 * width + x as u32) as usize] > 8 {
            1.0
        } else {
            0.0
        }
    }

    fn sample_phase(field: &[f32], width: u32, height: u32, x: i32, y: i32) -> f32 {
        if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
            return 0.0;
        }
        field[(y as u32 * width + x as u32) as usize]
    }

    fn sample_scalar_field(field: &[f32], width: u32, height: u32, x: f32, y: f32) -> f32 {
        if x < 0.0 || y < 0.0 || x >= width as f32 || y >= height as f32 {
            return 0.0;
        }

        let x0 = x.floor().clamp(0.0, width.saturating_sub(1) as f32) as usize;
        let y0 = y.floor().clamp(0.0, height.saturating_sub(1) as f32) as usize;
        let x1 = (x0 + 1).min(width.saturating_sub(1) as usize);
        let y1 = (y0 + 1).min(height.saturating_sub(1) as usize);
        let tx = x - x0 as f32;
        let ty = y - y0 as f32;

        let c00 = field[y0 * width as usize + x0];
        let c10 = field[y0 * width as usize + x1];
        let c01 = field[y1 * width as usize + x0];
        let c11 = field[y1 * width as usize + x1];

        let top = c00 * (1.0 - tx) + c10 * tx;
        let bottom = c01 * (1.0 - tx) + c11 * tx;
        top * (1.0 - ty) + bottom * ty
    }

    fn advance_particle(
        particle: &mut FluidParticle,
        sub_dt: f32,
        stop_speed: f32,
        density: f32,
        viscosity: f32,
        mask: &[u8],
        mask_has_content: bool,
        width: u32,
        height: u32,
    ) {
        let speed = (particle.vx * particle.vx + particle.vy * particle.vy).sqrt();
        if speed < stop_speed {
            particle.vx = 0.0;
            particle.vy = 0.0;
        }

        let next_x = particle.x + particle.vx * sub_dt * 60.0;
        let next_y = particle.y + particle.vy * sub_dt * 60.0;
        if Self::inside_mask_slice(mask, mask_has_content, width, height, next_x, next_y) {
            particle.x = next_x.clamp(0.0, width.saturating_sub(1) as f32);
            particle.y = next_y.clamp(0.0, height.saturating_sub(1) as f32);
            particle.outside_slack = 0.0;
        } else {
            let (snap_x, snap_y) = Self::find_inside_point_slice(
                mask, width, height, particle.x, particle.y, next_x, next_y,
            );
            let overshoot = ((next_x - snap_x).powi(2) + (next_y - snap_y).powi(2)).sqrt();
            let leeway =
                Self::boundary_leeway(particle, speed, sub_dt, stop_speed, density, viscosity);
            if overshoot <= leeway {
                particle.x = next_x.clamp(0.0, width.saturating_sub(1) as f32);
                particle.y = next_y.clamp(0.0, height.saturating_sub(1) as f32);
                particle.vx *= 0.96;
                particle.vy *= 0.96;
                particle.outside_slack = overshoot;
            } else {
                particle.x = snap_x;
                particle.y = snap_y;
                particle.vx *= -0.18;
                particle.vy *= -0.18;
                particle.outside_slack = 0.0;
            }
        }
    }

    fn boundary_leeway(
        particle: &FluidParticle,
        speed: f32,
        sub_dt: f32,
        stop_speed: f32,
        density: f32,
        viscosity: f32,
    ) -> f32 {
        let travel = (speed - stop_speed).max(0.0) * sub_dt * 60.0;
        let force_bias = 1.0 + density * 0.9 + viscosity * 0.35;
        let base = particle.radius * (0.18 + density * 0.22);
        (base + travel * 0.9 * force_bias).clamp(0.0, particle.radius * 1.9 + 10.0)
    }

    fn lbm_equilibrium(rho: f32, ux: f32, uy: f32, dir: usize) -> f32 {
        let (cx, cy) = LBM_DIRS[dir];
        let cu = 3.0 * (cx as f32 * ux + cy as f32 * uy);
        let u2 = ux * ux + uy * uy;
        LBM_WEIGHTS[dir] * rho * (1.0 + cu + 0.5 * cu * cu - 1.5 * u2)
    }

    fn lbm_rest_equilibrium(rho: f32) -> [f32; 9] {
        let mut equilibrium = [0.0; 9];
        for dir in 0..9 {
            equilibrium[dir] = LBM_WEIGHTS[dir] * rho;
        }
        equilibrium
    }

    fn inject_particle_to_lbm(&mut self, chunk: &[f32]) {
        let x = chunk[0];
        let y = chunk[1];
        if !Self::inside_mask_slice(
            &self.mask_alpha,
            self.mask_has_content,
            self.width,
            self.height,
            x,
            y,
        ) {
            return;
        }

        let radius = chunk[8].clamp(0.5, 64.0);
        let spread = radius
            .max(self.params.particle_radius * 0.9)
            .clamp(1.0, 8.0);
        let reach = spread.ceil() as i32;
        let velocity_scale =
            0.14 + self.params.density * 0.085 + self.params.surface_tension * 0.045;
        let ux = (chunk[2] * velocity_scale).clamp(-0.48, 0.48);
        let uy = (chunk[3] * velocity_scale).clamp(-0.48, 0.48);
        let alpha = chunk[7].clamp(0.0, 1.0);
        let mass_base = (radius / self.params.particle_radius.max(0.5)).clamp(0.45, 2.8)
            * alpha.max(0.2)
            * 1.08;

        let base_x = x.floor() as i32;
        let base_y = y.floor() as i32;
        for oy in -reach..=reach {
            for ox in -reach..=reach {
                let cx = base_x + ox;
                let cy = base_y + oy;
                if cx < 0 || cy < 0 || cx >= self.width as i32 || cy >= self.height as i32 {
                    continue;
                }
                if !Self::inside_mask_slice(
                    &self.mask_alpha,
                    self.mask_has_content,
                    self.width,
                    self.height,
                    cx as f32,
                    cy as f32,
                ) {
                    continue;
                }

                let dx = cx as f32 + 0.5 - x;
                let dy = cy as f32 + 0.5 - y;
                let distance = (dx * dx + dy * dy).sqrt();
                if distance > spread {
                    continue;
                }
                let weight = (1.0 - distance / spread).max(0.0);
                let mass = mass_base * weight.max(0.08);
                let index = (cy as u32 * self.width + cx as u32) as usize;
                for dir in 0..9 {
                    self.lbm.dist[index][dir] += Self::lbm_equilibrium(mass, ux, uy, dir);
                }
                self.lbm.phase[index] = self.lbm.phase[index].max(weight.max(0.18));
                self.lbm.next_phase[index] = self.lbm.next_phase[index].max(self.lbm.phase[index]);
                self.lbm.pigment[index][0] += chunk[4].clamp(0.0, 255.0) * alpha * mass;
                self.lbm.pigment[index][1] += chunk[5].clamp(0.0, 255.0) * alpha * mass;
                self.lbm.pigment[index][2] += chunk[6].clamp(0.0, 255.0) * alpha * mass;
                self.lbm.pigment[index][3] += alpha * mass;
            }
        }
    }

    fn trim_lbm_to_mask(&mut self) {
        if !self.mask_has_content {
            return;
        }

        for index in 0..self.mask_alpha.len() {
            if self.mask_alpha[index] > 8 {
                continue;
            }
            self.lbm.dist[index] = [0.0; 9];
            self.lbm.next_dist[index] = [0.0; 9];
            self.lbm.rho[index] = 0.0;
            self.lbm.velocity[index] = [0.0; 2];
            self.lbm.phase[index] = 0.0;
            self.lbm.next_phase[index] = 0.0;
            self.lbm.pigment[index] = [0.0; 4];
            self.lbm.next_pigment[index] = [0.0; 4];
        }
        self.refresh_lbm_activity();
    }

    fn seed_lbm_phase_from_mask(&mut self) {
        for index in 0..self.mask_alpha.len() {
            let seeded = (self.mask_alpha[index] as f32 / 255.0).clamp(0.0, 1.0);
            let eased = if seeded > 0.0 { seeded.powf(0.7) } else { 0.0 };
            self.lbm.phase[index] = eased;
            self.lbm.next_phase[index] = eased;
        }
    }

    fn recompute_lbm_macros(&mut self) {
        for index in 0..self.lbm.dist.len() {
            let cell = self.lbm.dist[index];
            let rho = cell.iter().sum::<f32>();
            if rho < LBM_EPSILON || self.lbm.phase[index] < 0.002 {
                self.lbm.rho[index] = 0.0;
                self.lbm.velocity[index] = [0.0; 2];
                continue;
            }

            let mut ux = 0.0;
            let mut uy = 0.0;
            for dir in 0..9 {
                ux += cell[dir] * LBM_DIRS[dir].0 as f32;
                uy += cell[dir] * LBM_DIRS[dir].1 as f32;
            }
            self.lbm.rho[index] = rho;
            self.lbm.velocity[index] = [ux / rho, uy / rho];
        }
    }

    fn advect_lbm_phase(&mut self, mask: &[u8], mask_has_content: bool, width: u32, height: u32) {
        let phase = self.lbm.phase.clone();
        self.lbm.next_phase.fill(0.0);
        let advect_scale = self.lbm_phase_advect_scale();
        let tension_mix =
            (0.04 + self.params.viscosity * 0.06 + self.params.density * 0.04).clamp(0.03, 0.14);
        let anchor_mix = if mask_has_content {
            0.006 + self.params.viscosity * 0.01
        } else {
            0.0
        };
        let retain = self.lbm_phase_retention();

        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let index = (y as u32 * width + x as u32) as usize;
                let vel = self.lbm.velocity[index];
                let sample_x = x as f32 - vel[0] * advect_scale;
                let sample_y = y as f32 - vel[1] * advect_scale;
                let advected = Self::sample_scalar_field(&phase, width, height, sample_x, sample_y);
                let phase_px = Self::sample_phase(&phase, width, height, x + 1, y);
                let phase_nx = Self::sample_phase(&phase, width, height, x - 1, y);
                let phase_py = Self::sample_phase(&phase, width, height, x, y + 1);
                let phase_ny = Self::sample_phase(&phase, width, height, x, y - 1);
                let smooth = (phase_px + phase_nx + phase_py + phase_ny) * 0.25;
                let interface_band = (advected * (1.0 - advected) * 4.0).clamp(0.0, 1.0);
                let support = (self.lbm.rho[index] * 0.22 + self.lbm.pigment[index][3] * 0.34)
                    .clamp(0.0, 1.0);
                let mask_seed = Self::sample_mask(mask, mask_has_content, width, height, x, y);
                let mut next_phase = advected * (1.0 - tension_mix)
                    + smooth * tension_mix * (0.45 + interface_band * 0.55);
                next_phase = next_phase.max(support * 0.5);
                next_phase =
                    next_phase * (1.0 - anchor_mix) + mask_seed * anchor_mix + support * 0.08;
                next_phase *= retain;
                if next_phase < 0.004 {
                    next_phase = 0.0;
                }
                self.lbm.next_phase[index] = next_phase.clamp(0.0, 1.0);
            }
        }

        std::mem::swap(&mut self.lbm.phase, &mut self.lbm.next_phase);
    }

    fn apply_phase_to_lbm(&mut self) {
        for index in 0..self.lbm.phase.len() {
            let phase = self.lbm.phase[index];
            if phase <= LBM_PHASE_CLEAR_THRESHOLD {
                self.lbm.dist[index] = [0.0; 9];
                self.lbm.pigment[index] = [0.0; 4];
                continue;
            }

            let keep = (0.86 + phase * 0.14).clamp(0.0, 1.0);
            for dir in 0..9 {
                self.lbm.dist[index][dir] *= keep;
            }
        }
    }

    fn advect_lbm_pigment(&mut self, mask: &[u8], mask_has_content: bool, width: u32, height: u32) {
        let pigment = self.lbm.pigment.clone();
        self.lbm.next_pigment.fill([0.0; 4]);
        let advect_scale = self.lbm_pigment_advect_scale();
        let pigment_retain = self.lbm_pigment_retention();

        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let index = (y as u32 * width + x as u32) as usize;
                let rho = self.lbm.rho[index];
                let alpha = pigment[index][3];
                let phase = self.lbm.phase[index];
                if rho < 0.001 && alpha < 0.001 && phase < 0.004 {
                    continue;
                }

                let vel = self.lbm.velocity[index];
                let sample_x = x as f32 - vel[0] * advect_scale;
                let sample_y = y as f32 - vel[1] * advect_scale;
                let mut sampled =
                    Self::sample_pigment_field(&pigment, width, height, sample_x, sample_y);
                if phase <= LBM_PHASE_CLEAR_THRESHOLD {
                    sampled = [0.0; 4];
                } else if mask_has_content && mask[index] <= 8 && rho < 0.015 {
                    for channel in 0..4 {
                        sampled[channel] *= LBM_MASK_EDGE_RETAIN_FACTOR;
                    }
                }
                for channel in 0..4 {
                    sampled[channel] *= pigment_retain;
                }

                self.lbm.next_pigment[index] = sampled;
            }
        }

        std::mem::swap(&mut self.lbm.pigment, &mut self.lbm.next_pigment);
    }

    fn settle_lbm_resting_cells(&mut self) {
        // Snap cells to a true rest state only after both their raw velocity and their
        // carry-adjusted visible motion drop below the stop threshold. For settled cells
        // this zeroes velocity and, when mass remains, rewrites the lattice distributions
        // to the equilibrium rest state so the solver stops reporting invisible tail motion.
        let rest_speed = (self.params.stop_speed * LBM_REST_SPEED_RATIO).max(LBM_ACTIVE_SPEED_FLOOR);
        for index in 0..self.lbm.rho.len() {
            let rho = self.lbm.rho[index];
            let alpha = self.lbm.pigment[index][3];
            let phase = self.lbm.phase[index];
            if rho < LBM_ACTIVE_RHO_THRESHOLD
                && alpha < LBM_ACTIVE_PIGMENT_THRESHOLD
                && phase < LBM_ACTIVE_PHASE_THRESHOLD
            {
                continue;
            }

            let speed = self.lbm.velocity[index][0].hypot(self.lbm.velocity[index][1]);
            let carries_visible_fluid = rho > LBM_ACTIVE_RHO_THRESHOLD
                || alpha > LBM_ACTIVE_PIGMENT_THRESHOLD
                || phase > LBM_ACTIVE_PHASE_THRESHOLD;
            let visible_speed = self.lbm_visible_speed(speed, carries_visible_fluid);
            if speed > rest_speed || visible_speed > rest_speed {
                continue;
            }

            self.lbm.velocity[index] = [0.0, 0.0];
            if rho <= LBM_EPSILON {
                self.lbm.dist[index] = [0.0; 9];
            } else {
                self.lbm.dist[index] = Self::lbm_rest_equilibrium(rho);
            }
        }
    }

    fn refresh_lbm_activity(&mut self) {
        let mut active = 0u32;
        let mut total_motion = 0.0f32;
        let motion_threshold = (self.params.stop_speed * LBM_ACTIVE_STOP_SPEED_RATIO)
            .max(LBM_ACTIVE_SPEED_FLOOR);
        let carry_threshold = motion_threshold.max(LBM_ACTIVE_SPEED_FLOOR);
        for index in 0..self.lbm.rho.len() {
            let speed = self.lbm.velocity[index][0].hypot(self.lbm.velocity[index][1]);
            let carries_visible_fluid = self.lbm.rho[index] > LBM_ACTIVE_RHO_THRESHOLD
                || self.lbm.pigment[index][3] > LBM_ACTIVE_PIGMENT_THRESHOLD
                || self.lbm.phase[index] > LBM_ACTIVE_PHASE_THRESHOLD;
            let visible_speed = self.lbm_visible_speed(speed, carries_visible_fluid);
            if speed > motion_threshold || (carries_visible_fluid && visible_speed > carry_threshold)
            {
                active += 1;
                total_motion += visible_speed.max(speed);
            }
        }
        if active <= LBM_FINAL_REST_ACTIVE_LIMIT
            && total_motion <= motion_threshold * LBM_FINAL_REST_MOTION_MULTIPLIER
        {
            active = 0;
        }
        self.lbm.active_cells = active;
    }

    fn sample_pigment_field(
        field: &[[f32; 4]],
        width: u32,
        height: u32,
        x: f32,
        y: f32,
    ) -> [f32; 4] {
        if x < 0.0 || y < 0.0 || x >= width as f32 || y >= height as f32 {
            return [0.0; 4];
        }

        let x0 = x.floor().clamp(0.0, width.saturating_sub(1) as f32) as usize;
        let y0 = y.floor().clamp(0.0, height.saturating_sub(1) as f32) as usize;
        let x1 = (x0 + 1).min(width.saturating_sub(1) as usize);
        let y1 = (y0 + 1).min(height.saturating_sub(1) as usize);
        let tx = x - x0 as f32;
        let ty = y - y0 as f32;

        let c00 = field[y0 * width as usize + x0];
        let c10 = field[y0 * width as usize + x1];
        let c01 = field[y1 * width as usize + x0];
        let c11 = field[y1 * width as usize + x1];

        let mut out = [0.0; 4];
        for channel in 0..4 {
            let top = c00[channel] * (1.0 - tx) + c10[channel] * tx;
            let bottom = c01[channel] * (1.0 - tx) + c11[channel] * tx;
            out[channel] = top * (1.0 - ty) + bottom * ty;
        }
        out
    }

    fn transfer_particles_to_lbm(&mut self) {
        let existing = self.particles.clone();
        self.particles.clear();
        self.lbm.clear();

        for particle in existing {
            let packed = [
                particle.x,
                particle.y,
                particle.vx,
                particle.vy,
                particle.r as f32,
                particle.g as f32,
                particle.b as f32,
                particle.a as f32 / 255.0,
                particle.radius,
            ];
            self.inject_particle_to_lbm(&packed);
        }

        self.recompute_lbm_macros();
        self.refresh_lbm_activity();
        self.sync_particle_view();
    }

    fn transfer_lbm_to_particles(&mut self) {
        self.particles.clear();
        let stride = (self.params.particle_radius * 1.2).round().clamp(1.0, 4.0) as usize;
        for y in (0..self.height as usize).step_by(stride) {
            for x in (0..self.width as usize).step_by(stride) {
                let index = y * self.width as usize + x;
                let rho = self.lbm.rho[index];
                let alpha_mass = self.lbm.pigment[index][3];
                if rho < 0.02 && alpha_mass < 0.02 {
                    continue;
                }

                let rgba = if alpha_mass > 0.001 {
                    [
                        (self.lbm.pigment[index][0] / alpha_mass).clamp(0.0, 255.0) as u8,
                        (self.lbm.pigment[index][1] / alpha_mass).clamp(0.0, 255.0) as u8,
                        (self.lbm.pigment[index][2] / alpha_mass).clamp(0.0, 255.0) as u8,
                        (alpha_mass * 255.0).clamp(32.0, 255.0) as u8,
                    ]
                } else {
                    [71, 199, 255, 180]
                };
                self.particles.push(FluidParticle {
                    x: x as f32 + 0.5,
                    y: y as f32 + 0.5,
                    vx: self.lbm.velocity[index][0] * 18.0,
                    vy: self.lbm.velocity[index][1] * 18.0,
                    outside_slack: if self.mask_alpha[index] == 0 && rho > 0.02 {
                        1.0
                    } else {
                        0.0
                    },
                    radius: self.params.particle_radius,
                    r: rgba[0],
                    g: rgba[1],
                    b: rgba[2],
                    a: rgba[3],
                });
                if self.particles.len() >= 5000 {
                    break;
                }
            }
            if self.particles.len() >= 5000 {
                break;
            }
        }

        self.lbm.clear();
        self.sync_particle_view();
    }

    pub fn read_pixels(&mut self) -> Vec<u8> {
        self.render_pixels();
        self.pixels.clone()
    }

    pub fn read_particles(&self) -> Vec<f32> {
        self.particle_view.clone()
    }

    fn sync_particle_view(&mut self) {
        self.particle_view.clear();
        if self.params.simulation_type == FluidSimulationType::Lbm {
            self.sync_lbm_view();
            return;
        }

        self.particle_view.reserve(self.particles.len() * 4);
        for particle in &self.particles {
            self.particle_view.push(particle.x);
            self.particle_view.push(particle.y);
            self.particle_view.push(particle.vx);
            self.particle_view.push(particle.vy);
        }
    }

    fn sync_lbm_view(&mut self) {
        let stride = (self.params.particle_radius * 2.0).round().clamp(2.0, 10.0) as usize;
        for y in (0..self.height as usize).step_by(stride) {
            for x in (0..self.width as usize).step_by(stride) {
                let index = y * self.width as usize + x;
                let rho = self.lbm.rho[index];
                let alpha = self.lbm.pigment[index][3];
                if rho < 0.02 && alpha < 0.02 && self.lbm.phase[index] < 0.05 {
                    continue;
                }
                self.particle_view.push(x as f32 + 0.5);
                self.particle_view.push(y as f32 + 0.5);
                self.particle_view.push(self.lbm.velocity[index][0] * 18.0);
                self.particle_view.push(self.lbm.velocity[index][1] * 18.0);
            }
        }
    }

    fn render_pixels(&mut self) {
        self.pixels.fill(0);

        if self.params.simulation_type == FluidSimulationType::Lbm {
            self.render_lbm();
            return;
        }

        if self.params.render_mode != FluidRenderMode::Particles {
            self.render_grid();
        }
        if self.params.render_mode != FluidRenderMode::Grid {
            self.render_particles();
        }
    }

    fn render_grid(&mut self) {
        let cell_size = (self.params.particle_radius * 3.0).round().clamp(3.0, 24.0) as u32;
        let cols = self.width.div_ceil(cell_size);
        let rows = self.height.div_ceil(cell_size);
        let mut cells = vec![GridCell::default(); (cols * rows) as usize];

        for particle in &self.particles {
            let cell_x = (particle.x.max(0.0) as u32 / cell_size).min(cols.saturating_sub(1));
            let cell_y = (particle.y.max(0.0) as u32 / cell_size).min(rows.saturating_sub(1));
            let cell = &mut cells[(cell_y * cols + cell_x) as usize];
            cell.count += 1;
            cell.r += particle.r as u32;
            cell.g += particle.g as u32;
            cell.b += particle.b as u32;
            cell.alpha += particle.a as f32 / 255.0;
            cell.allow_outside |= particle.outside_slack > 0.0;
        }

        for row in 0..rows {
            for col in 0..cols {
                let cell = cells[(row * cols + col) as usize];
                if cell.count == 0 {
                    continue;
                }
                let alpha =
                    (0.05 + cell.alpha / cell.count as f32 * 0.28 + cell.count as f32 * 0.025)
                        .clamp(0.0, 0.78);
                let r = (cell.r / cell.count) as u8;
                let g = (cell.g / cell.count) as u8;
                let b = (cell.b / cell.count) as u8;
                let start_x = col * cell_size;
                let start_y = row * cell_size;
                let end_x = (start_x + cell_size).min(self.width);
                let end_y = (start_y + cell_size).min(self.height);
                for py in start_y..end_y {
                    for px in start_x..end_x {
                        self.blend_pixel(px as i32, py as i32, r, g, b, alpha, cell.allow_outside);
                    }
                }
            }
        }
    }

    fn render_particles(&mut self) {
        for index in 0..self.particles.len() {
            let particle = self.particles[index];
            let radius = (particle.radius
                * if self.params.render_mode == FluidRenderMode::Hybrid {
                    1.55
                } else {
                    1.1
                })
            .max(1.25);
            let reach = (radius * 2.5).ceil() as i32;
            let allow_outside = particle.outside_slack > 0.0;
            let min_x = particle.x.floor() as i32 - reach;
            let max_x = particle.x.ceil() as i32 + reach;
            let min_y = particle.y.floor() as i32 - reach;
            let max_y = particle.y.ceil() as i32 + reach;
            let alpha_scale = particle.a as f32 / 255.0;

            for py in min_y..=max_y {
                for px in min_x..=max_x {
                    if !allow_outside && !self.inside_mask(px as f32, py as f32) {
                        continue;
                    }
                    let dx = px as f32 + 0.5 - particle.x;
                    let dy = py as f32 + 0.5 - particle.y;
                    let distance = (dx * dx + dy * dy).sqrt();
                    if distance > reach as f32 {
                        continue;
                    }
                    let falloff = (1.0 - distance / reach as f32).max(0.0);
                    let alpha = alpha_scale * falloff * falloff * 0.6;
                    if alpha > 0.001 {
                        self.blend_pixel(
                            px,
                            py,
                            particle.r,
                            particle.g,
                            particle.b,
                            alpha,
                            allow_outside,
                        );
                    }
                }
            }
        }
    }

    fn render_lbm(&mut self) {
        for index in 0..self.lbm.rho.len() {
            let rho = self.lbm.rho[index];
            let pigment = self.lbm.pigment[index];
            let alpha_mass = pigment[3];
            let phase = self.lbm.phase[index];
            if rho < LBM_RENDER_ACTIVITY_THRESHOLD
                && alpha_mass < LBM_RENDER_ACTIVITY_THRESHOLD
                && phase < 0.004
            {
                continue;
            }
            if alpha_mass <= LBM_RENDER_PIGMENT_THRESHOLD {
                continue;
            }

            let x = (index % self.width as usize) as i32;
            let y = (index / self.width as usize) as i32;
            let allow_outside =
                self.mask_alpha[index] == 0 && (phase > 0.035 || rho > 0.02 || alpha_mass > 0.012);
            let alpha = alpha_mass.clamp(0.0, LBM_RENDER_ALPHA_MAX);
            if alpha <= 0.001 {
                continue;
            }

            let base_r = (pigment[0] / alpha_mass).clamp(0.0, 255.0) as u8;
            let base_g = (pigment[1] / alpha_mass).clamp(0.0, 255.0) as u8;
            let base_b = (pigment[2] / alpha_mass).clamp(0.0, 255.0) as u8;

            self.blend_pixel(x, y, base_r, base_g, base_b, alpha, allow_outside);
            if self.params.render_mode == FluidRenderMode::Hybrid {
                self.blend_pixel(
                    x + 1,
                    y,
                    base_r,
                    base_g,
                    base_b,
                    alpha * 0.18,
                    allow_outside,
                );
                self.blend_pixel(
                    x - 1,
                    y,
                    base_r,
                    base_g,
                    base_b,
                    alpha * 0.18,
                    allow_outside,
                );
                self.blend_pixel(
                    x,
                    y + 1,
                    base_r,
                    base_g,
                    base_b,
                    alpha * 0.18,
                    allow_outside,
                );
                self.blend_pixel(
                    x,
                    y - 1,
                    base_r,
                    base_g,
                    base_b,
                    alpha * 0.18,
                    allow_outside,
                );
            }
        }
    }

    fn blend_pixel(
        &mut self,
        x: i32,
        y: i32,
        r: u8,
        g: u8,
        b: u8,
        alpha: f32,
        allow_outside: bool,
    ) {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return;
        }
        let ux = x as u32;
        let uy = y as u32;
        if !allow_outside && self.mask_alpha[(uy * self.width + ux) as usize] == 0 {
            return;
        }

        let index = ((uy * self.width + ux) * 4) as usize;
        let dst_a = self.pixels[index + 3] as f32 / 255.0;
        let src_a = alpha.clamp(0.0, 1.0);
        let out_a = src_a + dst_a * (1.0 - src_a);
        if out_a <= 0.0001 {
            return;
        }

        let dst_r = self.pixels[index] as f32;
        let dst_g = self.pixels[index + 1] as f32;
        let dst_b = self.pixels[index + 2] as f32;
        let out_r = (r as f32 * src_a + dst_r * dst_a * (1.0 - src_a)) / out_a;
        let out_g = (g as f32 * src_a + dst_g * dst_a * (1.0 - src_a)) / out_a;
        let out_b = (b as f32 * src_a + dst_b * dst_a * (1.0 - src_a)) / out_a;

        self.pixels[index] = out_r.clamp(0.0, 255.0) as u8;
        self.pixels[index + 1] = out_g.clamp(0.0, 255.0) as u8;
        self.pixels[index + 2] = out_b.clamp(0.0, 255.0) as u8;
        self.pixels[index + 3] = (out_a * 255.0).clamp(0.0, 255.0) as u8;
    }

    fn inside_mask(&self, x: f32, y: f32) -> bool {
        Self::inside_mask_slice(
            &self.mask_alpha,
            self.mask_has_content,
            self.width,
            self.height,
            x,
            y,
        )
    }

    fn inside_mask_slice(
        mask_alpha: &[u8],
        mask_has_content: bool,
        width: u32,
        height: u32,
        x: f32,
        y: f32,
    ) -> bool {
        if !mask_has_content {
            return x >= 0.0 && y >= 0.0 && x < width as f32 && y < height as f32;
        }
        let ix = x.round() as i32;
        let iy = y.round() as i32;
        if ix < 0 || iy < 0 || ix >= width as i32 || iy >= height as i32 {
            return false;
        }
        mask_alpha[(iy as u32 * width + ix as u32) as usize] > 8
    }

    fn find_inside_point_slice(
        mask_alpha: &[u8],
        width: u32,
        height: u32,
        fallback_x: f32,
        fallback_y: f32,
        next_x: f32,
        next_y: f32,
    ) -> (f32, f32) {
        if Self::inside_mask_slice(mask_alpha, true, width, height, fallback_x, fallback_y) {
            return (fallback_x, fallback_y);
        }
        for step in 0..14 {
            let ratio = step as f32 / 13.0;
            let x = next_x + (fallback_x - next_x) * ratio;
            let y = next_y + (fallback_y - next_y) * ratio;
            if Self::inside_mask_slice(mask_alpha, true, width, height, x, y) {
                return (x, y);
            }
        }
        (
            fallback_x.clamp(0.0, width.saturating_sub(1) as f32),
            fallback_y.clamp(0.0, height.saturating_sub(1) as f32),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{
        FluidRenderMode, FluidSimulation, LBM_STOP_SETTLING_IMPROVEMENT_THRESHOLD,
    };

    fn full_mask(width: usize, height: usize) -> Vec<u8> {
        let mut mask = vec![0u8; width * height * 4];
        for index in (3..mask.len()).step_by(4) {
            mask[index] = 255;
        }
        mask
    }

    #[test]
    fn fluid_step_generates_pixels() {
        let mut sim = FluidSimulation::new(48, 48);
        let mask = full_mask(48, 48);
        sim.set_mask_rgba(&mask);
        sim.add_particles_from_slice(&[24.0, 24.0, 0.8, 0.2, 71.0, 199.0, 255.0, 0.8, 3.5], 9);
        sim.step(1.0 / 60.0);

        assert_eq!(sim.particle_count(), 1);
        assert_eq!(sim.read_pixels().len(), 48 * 48 * 4);
        assert!(sim.read_pixels().iter().any(|value| *value > 0));
    }

    #[test]
    fn eulerian_mode_advects_particles() {
        let mut sim = FluidSimulation::new(64, 64);
        let mask = full_mask(64, 64);
        sim.set_mask_rgba(&mask);
        sim.set_params(
            4.0,
            0.45,
            0.7,
            0.58,
            1.0,
            3,
            0.12,
            0.025,
            0.44,
            0.78,
            1,
            FluidRenderMode::Hybrid as u32,
        );
        sim.add_particles_from_slice(
            &[
                30.0, 32.0, 0.9, 0.15, 71.0, 199.0, 255.0, 0.8, 3.5, 34.0, 32.0, -0.5, 0.3, 71.0,
                199.0, 255.0, 0.8, 3.5, 32.0, 36.0, 0.25, -0.65, 71.0, 199.0, 255.0, 0.8, 3.5,
            ],
            9,
        );
        let before = sim.read_particles();
        for _ in 0..6 {
            sim.step(1.0 / 60.0);
        }
        let after = sim.read_particles();
        let moved = before
            .chunks_exact(4)
            .zip(after.chunks_exact(4))
            .map(|(start, end)| ((end[0] - start[0]).powi(2) + (end[1] - start[1]).powi(2)).sqrt())
            .fold(0.0f32, f32::max);

        assert!(moved > 0.35, "eulerian moved only {moved}");
        assert!(sim.read_pixels().iter().any(|value| *value > 0));
    }

    #[test]
    fn lbm_mode_runs_without_particles() {
        let mut sim = FluidSimulation::new(64, 64);
        let mask = full_mask(64, 64);
        sim.set_mask_rgba(&mask);
        sim.set_params(
            4.0,
            0.45,
            0.7,
            0.58,
            1.0,
            3,
            0.12,
            0.025,
            0.44,
            0.78,
            2,
            FluidRenderMode::Hybrid as u32,
        );
        sim.add_particles_from_slice(
            &[
                30.0, 32.0, 0.9, 0.15, 71.0, 199.0, 255.0, 0.8, 3.5, 34.0, 32.0, -0.5, 0.3, 71.0,
                199.0, 255.0, 0.8, 3.5, 32.0, 36.0, 0.25, -0.65, 71.0, 199.0, 255.0, 0.8, 3.5,
            ],
            9,
        );
        assert!(
            sim.particles.is_empty(),
            "LBM should not keep particle state"
        );
        let before = sim.read_pixels();
        for _ in 0..6 {
            sim.step(1.0 / 60.0);
        }
        let after = sim.read_pixels();

        assert!(
            sim.particle_count() > 0,
            "LBM should report active lattice cells"
        );
        assert!(
            !sim.read_particles().is_empty(),
            "LBM should expose sampled flow vectors"
        );
        assert_ne!(before, after, "LBM pixels should evolve over time");
        assert!(
            sim.lbm.phase.iter().any(|value| *value > 0.05),
            "LBM should maintain a phase interface"
        );
    }

    #[test]
    fn lbm_interface_can_move_beyond_seed_mask() {
        let mut sim = FluidSimulation::new(48, 48);
        let mut mask = vec![0u8; 48 * 48 * 4];
        for y in 14..34usize {
            for x in 10..24usize {
                mask[(y * 48 + x) * 4 + 3] = 255;
            }
        }
        sim.set_mask_rgba(&mask);
        sim.set_params(
            4.0,
            0.4,
            0.78,
            0.62,
            1.0,
            3,
            0.08,
            0.02,
            0.44,
            0.78,
            2,
            FluidRenderMode::Hybrid as u32,
        );
        sim.add_particles_from_slice(&[22.0, 24.0, 2.4, 0.0, 71.0, 199.0, 255.0, 0.9, 4.0], 9);

        for _ in 0..18 {
            sim.step(1.0 / 60.0);
        }

        let outside_index = 24usize * 48 + 27usize;
        assert!(
            sim.lbm.phase[outside_index] > 0.01,
            "phase did not advect outside the seeded mask"
        );
    }

    #[test]
    fn lbm_does_not_render_colorless_phase_as_blue() {
        let mut sim = FluidSimulation::new(16, 16);
        sim.set_params(
            4.0,
            0.45,
            0.7,
            0.58,
            1.0,
            3,
            0.12,
            0.025,
            0.44,
            0.78,
            2,
            FluidRenderMode::Hybrid as u32,
        );
        let index = 8usize * 16 + 8usize;
        sim.lbm.rho[index] = 0.2;
        sim.lbm.phase[index] = 0.7;
        sim.lbm.pigment[index] = [0.0; 4];

        let pixels = sim.read_pixels();
        let px = index * 4;
        assert_eq!(&pixels[px..px + 4], &[0, 0, 0, 0]);
    }

    #[test]
    fn lbm_renders_pigment_color_without_blue_fallback() {
        let mut sim = FluidSimulation::new(16, 16);
        sim.set_params(
            4.0,
            0.45,
            0.7,
            0.58,
            1.0,
            3,
            0.12,
            0.025,
            0.44,
            0.78,
            2,
            FluidRenderMode::Hybrid as u32,
        );
        let index = 8usize * 16 + 8usize;
        sim.lbm.rho[index] = 0.2;
        sim.lbm.phase[index] = 0.7;
        sim.lbm.pigment[index] = [180.0, 20.0, 10.0, 0.7];

        let pixels = sim.read_pixels();
        let px = index * 4;
        assert!(pixels[px] > pixels[px + 2], "expected rendered pigment to stay closer to the injected color");
        assert!(pixels[px + 1] > pixels[px + 2], "expected rendered pigment to keep the warmer pigment balance");
        assert!(pixels[px + 3] > 0, "expected rendered pigment to remain visible");
    }

    #[test]
    fn lbm_apply_phase_keeps_pigment_mass_while_fluid_settles() {
        let mut sim = FluidSimulation::new(8, 8);
        let index = 4usize * 8 + 4usize;
        sim.lbm.phase[index] = 0.65;
        sim.lbm.pigment[index] = [90.0, 30.0, 15.0, 0.6];

        sim.apply_phase_to_lbm();

        assert_eq!(sim.lbm.pigment[index], [90.0, 30.0, 15.0, 0.6]);
    }

    #[test]
    fn lbm_stop_speed_quickens_settling() {
        let mut slow_stop = FluidSimulation::new(48, 48);
        let mut fast_stop = FluidSimulation::new(48, 48);

        slow_stop.set_params(4.0, 0.45, 0.78, 0.58, 1.0, 3, 0.12, 0.01, 0.44, 0.78, 2, 2);
        fast_stop.set_params(4.0, 0.45, 0.78, 0.58, 1.0, 3, 0.12, 0.16, 0.44, 0.78, 2, 2);

        let seed = [
            24.0, 24.0, 1.8, 0.2, 71.0, 199.0, 255.0, 0.88, 4.0, 28.0, 25.0, -1.1, 0.4, 71.0,
            199.0, 255.0, 0.82, 4.0,
        ];
        slow_stop.add_particles_from_slice(&seed, 9);
        fast_stop.add_particles_from_slice(&seed, 9);

        for _ in 0..12 {
            slow_stop.step(1.0 / 60.0);
            fast_stop.step(1.0 / 60.0);
        }

        let summed_speed = |sim: &FluidSimulation| -> f32 {
            sim.lbm
                .velocity
                .iter()
                .map(|vel| vel[0].hypot(vel[1]))
                .sum::<f32>()
        };
        let slow_energy = summed_speed(&slow_stop);
        let fast_energy = summed_speed(&fast_stop);
        let slow_active = slow_stop.particle_count();
        let fast_active = fast_stop.particle_count();

        assert!(
            fast_energy < slow_energy * LBM_STOP_SETTLING_IMPROVEMENT_THRESHOLD,
            "expected higher stop speed to settle faster (slow={slow_energy:.5}, fast={fast_energy:.5})"
        );
        assert!(
            fast_active < slow_active,
            "expected higher stop speed to deactivate more lattice cells (slow={slow_active}, fast={fast_active})"
        );
        assert!(
            fast_stop.lbm.pigment.iter().any(|px| px[3] > 0.01),
            "faster settling should not immediately erase pigment mass"
        );
    }

    #[test]
    fn lbm_resting_fluid_deactivates_without_losing_pigment() {
        let mut sim = FluidSimulation::new(48, 48);
        sim.set_params(4.0, 0.76, 0.3, 0.34, 0.625, 2, 0.58, 0.32, 0.44, 0.78, 2, 2);
        sim.add_particles_from_slice(&[24.0, 24.0, 1.4, 0.0, 71.0, 199.0, 255.0, 0.84, 4.0], 9);

        for _ in 0..180 {
            sim.step(1.0 / 60.0);
            if sim.particle_count() == 0 {
                break;
            }
        }

        assert_eq!(
            sim.particle_count(),
            0,
            "expected a single click-sized LBM injection to settle fully within a few seconds"
        );
        assert!(
            sim.lbm.pigment.iter().any(|px| px[3] > 0.01),
            "settling should preserve pigment for the final blit"
        );
    }

    #[test]
    fn lbm_pigment_carry_extends_visible_drift_without_adding_motion_energy() {
        let mut short_carry = FluidSimulation::new(32, 32);
        let mut long_carry = FluidSimulation::new(32, 32);
        let mask = full_mask(32, 32);

        short_carry.set_mask_rgba(&mask);
        long_carry.set_mask_rgba(&mask);
        short_carry.set_params(4.0, 0.45, 0.7, 0.58, 1.0, 3, 0.12, 0.05, 0.05, 0.78, 2, 2);
        long_carry.set_params(4.0, 0.45, 0.7, 0.58, 1.0, 3, 0.12, 0.05, 0.9, 0.78, 2, 2);

        let seed_blob = |sim: &mut FluidSimulation| {
            for y in 14..18usize {
                for x in 12..16usize {
                    let index = y * 32 + x;
                    sim.lbm.rho[index] = 0.22;
                    sim.lbm.phase[index] = 0.86;
                    sim.lbm.pigment[index] = [90.0, 30.0, 15.0, 0.55];
                    sim.lbm.velocity[index] = [0.09, 0.0];
                }
            }
        };
        seed_blob(&mut short_carry);
        seed_blob(&mut long_carry);

        for _ in 0..4 {
            short_carry.advect_lbm_phase(&mask, true, 32, 32);
            short_carry.apply_phase_to_lbm();
            short_carry.advect_lbm_pigment(&mask, true, 32, 32);

            long_carry.advect_lbm_phase(&mask, true, 32, 32);
            long_carry.apply_phase_to_lbm();
            long_carry.advect_lbm_pigment(&mask, true, 32, 32);
        }

        let summed_speed = |sim: &FluidSimulation| -> f32 {
            sim.lbm
                .velocity
                .iter()
                .map(|vel| vel[0].hypot(vel[1]))
                .sum::<f32>()
        };
        let pigment_mass = |sim: &FluidSimulation| -> f32 {
            sim.lbm.pigment.iter().map(|pigment| pigment[3]).sum::<f32>()
        };
        let pigment_center_x = |sim: &FluidSimulation| -> f32 {
            let mass = pigment_mass(sim).max(0.0001);
            sim.lbm
                .pigment
                .iter()
                .enumerate()
                .map(|(index, pigment)| (index % 32) as f32 * pigment[3])
                .sum::<f32>()
                / mass
        };

        let short_energy = summed_speed(&short_carry);
        let long_energy = summed_speed(&long_carry);
        let short_center = pigment_center_x(&short_carry);
        let long_center = pigment_center_x(&long_carry);

        assert!(
            long_center > short_center + 0.35,
            "expected higher pigment carry to keep pigment gliding farther (short={short_center:.5}, long={long_center:.5})"
        );
        assert!(
            (long_energy - short_energy).abs() < short_energy.max(0.001) * 0.35,
            "pigment carry should not dramatically change motion energy (short={short_energy:.5}, long={long_energy:.5})"
        );
    }

    #[test]
    fn lbm_pigment_retention_preserves_visible_mass_after_settling() {
        let mut low_retention = FluidSimulation::new(32, 32);
        let mut high_retention = FluidSimulation::new(32, 32);
        let mask = full_mask(32, 32);

        low_retention.set_mask_rgba(&mask);
        high_retention.set_mask_rgba(&mask);
        low_retention.set_params(4.0, 0.76, 0.3, 0.34, 0.625, 2, 0.58, 0.24, 0.44, 0.15, 2, 2);
        high_retention.set_params(4.0, 0.76, 0.3, 0.34, 0.625, 2, 0.58, 0.24, 0.44, 0.95, 2, 2);

        let seed_blob = |sim: &mut FluidSimulation| {
            for y in 14..18usize {
                for x in 14..18usize {
                    let index = y * 32 + x;
                    sim.lbm.rho[index] = 0.2;
                    sim.lbm.phase[index] = 0.82;
                    sim.lbm.pigment[index] = [80.0, 22.0, 12.0, 0.5];
                    sim.lbm.velocity[index] = [0.06, 0.01];
                }
            }
        };
        seed_blob(&mut low_retention);
        seed_blob(&mut high_retention);

        for _ in 0..6 {
            low_retention.advect_lbm_phase(&mask, true, 32, 32);
            low_retention.apply_phase_to_lbm();
            low_retention.advect_lbm_pigment(&mask, true, 32, 32);

            high_retention.advect_lbm_phase(&mask, true, 32, 32);
            high_retention.apply_phase_to_lbm();
            high_retention.advect_lbm_pigment(&mask, true, 32, 32);
        }

        let pigment_mass = |sim: &FluidSimulation| -> f32 {
            sim.lbm.pigment.iter().map(|px| px[3]).sum::<f32>()
        };
        let phase_mass = |sim: &FluidSimulation| -> f32 { sim.lbm.phase.iter().sum::<f32>() };

        let low_mass = pigment_mass(&low_retention);
        let high_mass = pigment_mass(&high_retention);
        let low_phase = phase_mass(&low_retention);
        let high_phase = phase_mass(&high_retention);

        assert!(
            high_mass > low_mass * 1.04,
            "expected higher pigment retention to preserve more visible pigment (low={low_mass:.5}, high={high_mass:.5})"
        );
        assert!(
            high_phase > low_phase * 1.04,
            "expected higher pigment retention to preserve more phase support (low={low_phase:.5}, high={high_phase:.5})"
        );
    }

    #[test]
    fn fast_particles_can_overshoot_mask_slightly() {
        let mut sim = FluidSimulation::new(48, 48);
        let mut mask = vec![0u8; 48 * 48 * 4];
        for y in 0..48usize {
            for x in 0..24usize {
                mask[(y * 48 + x) * 4 + 3] = 255;
            }
        }
        sim.set_mask_rgba(&mask);
        sim.set_params(3.5, 0.42, 0.75, 0.58, 1.0, 1, 0.08, 0.01, 0.44, 0.78, 0, 2);
        sim.add_particles_from_slice(&[22.0, 24.0, 3.4, 0.0, 71.0, 199.0, 255.0, 0.8, 3.5], 9);

        sim.step(1.0 / 60.0);
        let particles = sim.read_particles();
        assert!(
            particles[0] > 23.5,
            "particle did not overshoot boundary: {}",
            particles[0]
        );
    }
}
