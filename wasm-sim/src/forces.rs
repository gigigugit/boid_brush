// =============================================================================
// forces.rs — All boid force functions
//
// Each force operates on a flat &mut [f32] buffer at a given agent offset,
// accumulating into the ax/ay fields. Zero heap allocations per call.
//
// Ported from index.html Boid.update() (lines ~981-1012).
// =============================================================================

use crate::boid::*;
use crate::noise::SimplexNoise;
use crate::params::SimParams;
use core::f32::consts::PI;

#[cfg(feature = "spatial-hash")]
use crate::spatial::SpatialGrid;

// ---- Seek: steer toward target at max speed ----
#[inline]
pub fn seek(buf: &mut [f32], base: usize, tx: f32, ty: f32, weight: f32, max_speed: f32) {
    let dx = tx - buf[base + X];
    let dy = ty - buf[base + Y];
    let d = (dx * dx + dy * dy).sqrt().max(1.0);
    let fx = ((dx / d) * max_speed - buf[base + VX]) * weight;
    let fy = ((dy / d) * max_speed - buf[base + VY]) * weight;
    buf[base + AX] += fx;
    buf[base + AY] += fy;
}

// ---- Flee: repel from target within radius ----
#[inline]
pub fn flee(buf: &mut [f32], base: usize, tx: f32, ty: f32, radius: f32, max_speed: f32) {
    let dx = buf[base + X] - tx;
    let dy = buf[base + Y] - ty;
    let d = (dx * dx + dy * dy).sqrt();
    if d > radius || d == 0.0 {
        return;
    }
    let s = 1.0 - d / radius;
    buf[base + AX] += (dx / d) * max_speed * 0.8 * s;
    buf[base + AY] += (dy / d) * max_speed * 0.8 * s;
}

// ---- Jitter: random perturbation ----
#[inline]
pub fn jitter(buf: &mut [f32], base: usize, weight: f32, max_speed: f32, rng: &mut Rng) {
    if weight <= 0.0 {
        return;
    }
    buf[base + AX] += (rng.next_f32() - 0.5) * weight * max_speed * 2.0;
    buf[base + AY] += (rng.next_f32() - 0.5) * weight * max_speed * 2.0;
}

// ---- Wander: Brownian angle walk ----
#[inline]
pub fn wander(buf: &mut [f32], base: usize, weight: f32, speed: f32, max_speed: f32, rng: &mut Rng) {
    if weight <= 0.0 {
        return;
    }
    buf[base + WA] += (rng.next_f32() - 0.5) * speed * 2.0;
    let wa = buf[base + WA];
    buf[base + AX] += wa.cos() * weight * max_speed;
    buf[base + AY] += wa.sin() * weight * max_speed;
}

// ---- Flow field: simplex noise directional push ----
#[inline]
pub fn flow_field(
    buf: &mut [f32],
    base: usize,
    weight: f32,
    scale: f32,
    max_speed: f32,
    time: f32,
    noise: &SimplexNoise,
) {
    if weight <= 0.0 {
        return;
    }
    let nx = buf[base + NX];
    let ny = buf[base + NY];
    let px = buf[base + X];
    let py = buf[base + Y];
    let a = noise.n2d((px + nx) * scale, (py + ny) * scale + time * 0.0005) * PI * 2.0;
    buf[base + AX] += a.cos() * weight * max_speed;
    buf[base + AY] += a.sin() * weight * max_speed;
}

// ---- FOV check: does other agent fall within this agent's field of view? ----
#[inline]
pub fn in_fov(buf: &[f32], base: usize, ox: f32, oy: f32, fov_rad: f32) -> bool {
    if fov_rad >= PI * 2.0 {
        return true;
    }
    let dx = ox - buf[base + X];
    let dy = oy - buf[base + Y];
    let vx = buf[base + VX];
    let vy = buf[base + VY];
    let mut diff = dy.atan2(dx) - vy.atan2(vx);
    if diff > PI {
        diff -= PI * 2.0;
    }
    if diff < -PI {
        diff += PI * 2.0;
    }
    diff.abs() < fov_rad / 2.0
}

// ---- Neighbor forces (cohesion + separation + alignment) ----
// Applied all at once during the neighbor scan to avoid iterating twice.
//
// This is the fallback O(n²) all-pairs implementation. It is used when the
// `spatial-hash` feature is disabled, and is retained for testing/comparison.
#[cfg(any(not(feature = "spatial-hash"), test))]
pub fn apply_neighbor_forces(
    buf: &mut [f32],
    agent_count: usize,
    p: &SimParams,
) {
    let nd = p.neighbor_radius;
    let sd = p.separation_radius;
    let nd2 = nd * nd;
    let sd2 = sd * sd;

    // We need to accumulate per-agent neighbor data. Use stack arrays for small counts,
    // otherwise heap — but agent_count is typically ≤ 200 in this phase.
    // To avoid O(n) allocation, we iterate pairs and accumulate inline.

    // For each alive agent, scan all other alive agents.
    // This is O(n²) which is fine for ≤ 200. For 10k+ use spatial hash feature.
    for i in 0..agent_count {
        let bi = i * STRIDE;
        if !has_flag(buf, bi, FLAG_ALIVE) {
            continue;
        }

        let xi = buf[bi + X];
        let yi = buf[bi + Y];
        let ms = p.max_speed;

        let mut cx = 0.0f32;
        let mut cy = 0.0f32;
        let mut cc = 0u32;
        let mut sx = 0.0f32;
        let mut sy = 0.0f32;
        let mut avx = 0.0f32;
        let mut avy = 0.0f32;
        let mut ac = 0u32;

        for j in 0..agent_count {
            if i == j {
                continue;
            }
            let bj = j * STRIDE;
            if !has_flag(buf, bj, FLAG_ALIVE) {
                continue;
            }

            let xj = buf[bj + X];
            let yj = buf[bj + Y];

            // FOV check
            if !in_fov(buf, bi, xj, yj, p.fov_rad) {
                continue;
            }

            let dx = xj - xi;
            let dy = yj - yi;
            let d2 = dx * dx + dy * dy;

            if d2 < nd2 {
                cx += xj;
                cy += yj;
                cc += 1;
                avx += buf[bj + VX];
                avy += buf[bj + VY];
                ac += 1;
            }

            if d2 < sd2 && d2 > 0.0 {
                let d = d2.sqrt();
                sx -= dx / d;
                sy -= dy / d;
            }
        }

        // Cohesion: seek centroid of neighbors (uses per-agent coh_m)
        if cc > 0 && p.cohesion > 0.0 {
            let gx = cx / cc as f32;
            let gy = cy / cc as f32;
            let agent_coh = p.cohesion * buf[bi + COH_M];
            seek(buf, bi, gx, gy, agent_coh, ms);
        }

        // Alignment: match average neighbor velocity
        if ac > 0 && p.alignment > 0.0 {
            let avg_vx = avx / ac as f32;
            let avg_vy = avy / ac as f32;
            buf[bi + AX] += (avg_vx - buf[bi + VX]) * p.alignment;
            buf[bi + AY] += (avg_vy - buf[bi + VY]) * p.alignment;
        }

        // Separation: repel from close neighbors (uses per-agent sep_m)
        if p.separation > 0.0 {
            let agent_sep = p.separation * buf[bi + SEP_M];
            buf[bi + AX] += sx * agent_sep;
            buf[bi + AY] += sy * agent_sep;
        }
    }
}

// ---- Neighbor forces via spatial grid — O(n·k) instead of O(n²) ----
//
// Requires `grid` to have been built this frame (via `SpatialGrid::build()`).
//
// # Why 3×3 cells is sufficient
// The grid cell size is set to max(neighbor_radius, separation_radius). An agent
// in a cell that is ≥2 steps away in any axis has an x- (or y-) distance of at
// least `cell_size` from the querying agent, so its Euclidean distance ≥
// `cell_size` ≥ max(neighbor_r, separation_r). It therefore cannot pass either
// the `d² < nd²` (cohesion/alignment) or `d² < sd²` (separation) checks, and
// can be skipped safely.
//
// For a typical boid count of n and average k agents in the 3×3 neighborhood,
// this reduces work from O(n²) to O(n·k).
#[cfg(feature = "spatial-hash")]
pub fn apply_neighbor_forces_grid(
    buf: &mut [f32],
    agent_count: usize,
    p: &SimParams,
    grid: &SpatialGrid,
) {
    let nd2 = p.neighbor_radius * p.neighbor_radius;
    let sd2 = p.separation_radius * p.separation_radius;

    for i in 0..agent_count {
        let bi = i * STRIDE;
        if !has_flag(buf, bi, FLAG_ALIVE) {
            continue;
        }

        let xi = buf[bi + X];
        let yi = buf[bi + Y];
        let ms = p.max_speed;

        let mut cx_acc = 0.0f32;
        let mut cy_acc = 0.0f32;
        let mut cc = 0u32;
        let mut sx = 0.0f32;
        let mut sy = 0.0f32;
        let mut avx = 0.0f32;
        let mut avy = 0.0f32;
        let mut ac = 0u32;

        // Retrieve pre-computed grid cell for this agent (avoids redundant division).
        // `i` is always within 0..agent_count == grid.cell_of.len(), so the call is
        // in-bounds. Returns (-1,-1) only for dead agents, already filtered above.
        let (cell_xi, cell_yi) = grid.agent_cell(i);

        // Inspect the 3×3 cell neighborhood (±1 in each axis).
        for ndy in -1i32..=1 {
            for ndx in -1i32..=1 {
                for &j_u32 in grid.cell_agents(cell_xi + ndx, cell_yi + ndy) {
                    let j = j_u32 as usize;
                    if j == i {
                        continue;
                    }
                    let bj = j * STRIDE;
                    let xj = buf[bj + X];
                    let yj = buf[bj + Y];

                    // FOV check: skip agents outside field of view
                    if !in_fov(buf, bi, xj, yj, p.fov_rad) {
                        continue;
                    }

                    let dx = xj - xi;
                    let dy = yj - yi;
                    let d2 = dx * dx + dy * dy;

                    if d2 < nd2 {
                        cx_acc += xj;
                        cy_acc += yj;
                        cc += 1;
                        avx += buf[bj + VX];
                        avy += buf[bj + VY];
                        ac += 1;
                    }

                    if d2 < sd2 && d2 > 0.0 {
                        let d = d2.sqrt();
                        sx -= dx / d;
                        sy -= dy / d;
                    }
                }
            }
        }

        // Cohesion: seek centroid of neighbors (uses per-agent coh_m)
        if cc > 0 && p.cohesion > 0.0 {
            let gx = cx_acc / cc as f32;
            let gy = cy_acc / cc as f32;
            let agent_coh = p.cohesion * buf[bi + COH_M];
            seek(buf, bi, gx, gy, agent_coh, ms);
        }

        // Alignment: match average neighbor velocity
        if ac > 0 && p.alignment > 0.0 {
            let avg_vx = avx / ac as f32;
            let avg_vy = avy / ac as f32;
            buf[bi + AX] += (avg_vx - buf[bi + VX]) * p.alignment;
            buf[bi + AY] += (avg_vy - buf[bi + VY]) * p.alignment;
        }

        // Separation: repel from close neighbors (uses per-agent sep_m)
        if p.separation > 0.0 {
            let agent_sep = p.separation * buf[bi + SEP_M];
            buf[bi + AX] += sx * agent_sep;
            buf[bi + AY] += sy * agent_sep;
        }
    }
}

// ---- Integrate: velocity += accel, clamp speed, apply damping, advance pos ----
#[inline]
pub fn integrate(buf: &mut [f32], base: usize, max_speed: f32, damping: f32) {
    buf[base + VX] += buf[base + AX];
    buf[base + VY] += buf[base + AY];

    let sp = (buf[base + VX] * buf[base + VX] + buf[base + VY] * buf[base + VY]).sqrt();
    if sp > max_speed {
        buf[base + VX] = (buf[base + VX] / sp) * max_speed;
        buf[base + VY] = (buf[base + VY] / sp) * max_speed;
    }

    buf[base + VX] *= damping;
    buf[base + VY] *= damping;

    buf[base + X] += buf[base + VX];
    buf[base + Y] += buf[base + VY];

    buf[base + LIFE] += 1.0;
}

// =============================================================================
// Simple xorshift32-based PRNG (no std dependency, deterministic, fast)
// =============================================================================
pub struct Rng {
    state: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self {
            state: if seed == 0 { 1 } else { seed },
        }
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        x
    }

    /// Returns a float in [0, 1).
    #[inline]
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() & 0x00FF_FFFF) as f32 / 16_777_216.0
    }

    /// Returns a float in [-1, 1).
    #[inline]
    pub fn next_f32_signed(&mut self) -> f32 {
        self.next_f32() * 2.0 - 1.0
    }
}
