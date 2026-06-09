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
use crate::params::{AgentParams, SimParams};
use core::f32::consts::PI;

#[cfg(feature = "spatial-hash")]
use crate::spatial::SpatialGrid;

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

#[inline]
pub fn jitter(buf: &mut [f32], base: usize, weight: f32, max_speed: f32, rng: &mut Rng) {
    if weight <= 0.0 {
        return;
    }
    buf[base + AX] += (rng.next_f32() - 0.5) * weight * max_speed * 2.0;
    buf[base + AY] += (rng.next_f32() - 0.5) * weight * max_speed * 2.0;
}

#[inline]
pub fn wander(
    buf: &mut [f32],
    base: usize,
    weight: f32,
    speed: f32,
    max_speed: f32,
    rng: &mut Rng,
) {
    if weight <= 0.0 {
        return;
    }
    buf[base + WA] += (rng.next_f32() - 0.5) * speed * 2.0;
    let wa = buf[base + WA];
    buf[base + AX] += wa.cos() * weight * max_speed;
    buf[base + AY] += wa.sin() * weight * max_speed;
}

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

#[derive(Clone, Copy, Default)]
struct DirectNeighborAccum {
    cx: f32,
    cy: f32,
    cc: u32,
    sx: f32,
    sy: f32,
    avx: f32,
    avy: f32,
    ac: u32,
}

#[derive(Clone, Copy, Default)]
struct CompositeNeighborAccum {
    cx: f32,
    cy: f32,
    vx: f32,
    vy: f32,
    count: u32,
}

#[derive(Clone, Copy, Default)]
struct LeaderNeighborAccum {
    cx: f32,
    cy: f32,
    count: u32,
}

#[inline]
fn quorum_enabled(threshold: u32) -> bool {
    threshold >= 2
}

#[inline]
fn split_agent_params(p: &SimParams) -> (AgentParams, AgentParams) {
    (p.params_for(false), p.params_for(true))
}

#[inline]
fn agent_params_for_role(
    is_leader: bool,
    follower_params: AgentParams,
    leader_params: AgentParams,
) -> AgentParams {
    if is_leader {
        leader_params
    } else {
        follower_params
    }
}

#[inline]
fn accumulate_direct_neighbor(
    accum: &mut DirectNeighborAccum,
    dx: f32,
    dy: f32,
    d2: f32,
    xj: f32,
    yj: f32,
    vxj: f32,
    vyj: f32,
    nd2: f32,
    sd2: f32,
) {
    if d2 < nd2 {
        accum.cx += xj;
        accum.cy += yj;
        accum.cc += 1;
        accum.avx += vxj;
        accum.avy += vyj;
        accum.ac += 1;
    }

    if d2 < sd2 && d2 > 0.0 {
        let d = d2.sqrt();
        accum.sx -= dx / d;
        accum.sy -= dy / d;
    }
}

#[inline]
fn accumulate_composite_neighbor(
    accum: &mut CompositeNeighborAccum,
    xj: f32,
    yj: f32,
    vxj: f32,
    vyj: f32,
    d2: f32,
    nd2: f32,
    sd2: f32,
) {
    if d2 < nd2 || d2 < sd2 {
        accum.cx += xj;
        accum.cy += yj;
        accum.vx += vxj;
        accum.vy += vyj;
        accum.count += 1;
    }
}

#[inline]
fn accumulate_leader_neighbor(
    accum: &mut LeaderNeighborAccum,
    xj: f32,
    yj: f32,
    d2: f32,
    nd2: f32,
) {
    if d2 < nd2 {
        accum.cx += xj;
        accum.cy += yj;
        accum.count += 1;
    }
}

#[inline]
fn apply_accumulated_neighbor_forces(
    buf: &mut [f32],
    base: usize,
    params: &AgentParams,
    max_speed: f32,
    direct: &DirectNeighborAccum,
) {
    if direct.cc > 0 && params.cohesion > 0.0 {
        let gx = direct.cx / direct.cc as f32;
        let gy = direct.cy / direct.cc as f32;
        let agent_coh = params.cohesion * buf[base + COH_M];
        seek(buf, base, gx, gy, agent_coh, max_speed);
    }

    if direct.ac > 0 && params.alignment > 0.0 {
        let avg_vx = direct.avx / direct.ac as f32;
        let avg_vy = direct.avy / direct.ac as f32;
        buf[base + AX] += (avg_vx - buf[base + VX]) * params.alignment;
        buf[base + AY] += (avg_vy - buf[base + VY]) * params.alignment;
    }

    if params.separation > 0.0 {
        let agent_sep = params.separation * buf[base + SEP_M];
        buf[base + AX] += direct.sx * agent_sep;
        buf[base + AY] += direct.sy * agent_sep;
    }
}

#[inline]
fn apply_composite_neighbor_force(
    buf: &mut [f32],
    base: usize,
    params: &AgentParams,
    max_speed: f32,
    xi: f32,
    yi: f32,
    sd2: f32,
    composite: &CompositeNeighborAccum,
) {
    if composite.count == 0 {
        return;
    }

    let strength = params.quorum_composite_strength;
    if strength <= 0.0 {
        return;
    }

    let cx = composite.cx / composite.count as f32;
    let cy = composite.cy / composite.count as f32;

    if params.cohesion > 0.0 {
        let agent_coh = params.cohesion * buf[base + COH_M] * strength;
        seek(buf, base, cx, cy, agent_coh, max_speed);
    }

    if params.alignment > 0.0 {
        let mut composite_vx = composite.vx;
        let mut composite_vy = composite.vy;
        let composite_speed = (composite_vx * composite_vx + composite_vy * composite_vy).sqrt();
        if composite_speed > max_speed {
            let scale = max_speed / composite_speed;
            composite_vx *= scale;
            composite_vy *= scale;
        }
        buf[base + AX] += (composite_vx - buf[base + VX]) * params.alignment * strength;
        buf[base + AY] += (composite_vy - buf[base + VY]) * params.alignment * strength;
    }

    if params.separation > 0.0 {
        let dx = cx - xi;
        let dy = cy - yi;
        let d2 = dx * dx + dy * dy;
        if d2 < sd2 && d2 > 0.0 {
            let d = d2.sqrt();
            let agent_sep = params.separation * buf[base + SEP_M] * strength;
            buf[base + AX] -= (dx / d) * agent_sep;
            buf[base + AY] -= (dy / d) * agent_sep;
        }
    }
}

#[inline]
fn apply_leader_pull(
    buf: &mut [f32],
    base: usize,
    max_speed: f32,
    leader_pull: f32,
    leaders: &LeaderNeighborAccum,
) {
    if leader_pull <= 0.0 || leaders.count == 0 {
        return;
    }
    seek(
        buf,
        base,
        leaders.cx / leaders.count as f32,
        leaders.cy / leaders.count as f32,
        leader_pull,
        max_speed,
    );
}

#[cfg(any(not(feature = "spatial-hash"), test))]
fn compute_quorum_members(
    buf: &[f32],
    agent_count: usize,
    follower_params: AgentParams,
    leader_params: AgentParams,
) -> Vec<bool> {
    let mut members = vec![false; agent_count];

    for i in 0..agent_count {
        let bi = i * STRIDE;
        let flags_i = buf[bi + FLAGS] as u32;
        if flags_i & FLAG_ALIVE == 0 {
            continue;
        }
        let focal_params =
            agent_params_for_role(flags_i & FLAG_LEADER != 0, follower_params, leader_params);
        if !quorum_enabled(focal_params.quorum_threshold) {
            continue;
        }

        let xi = buf[bi + X];
        let yi = buf[bi + Y];
        let nd2 = focal_params.neighbor_radius * focal_params.neighbor_radius;
        let mut count = 0u32;

        for j in 0..agent_count {
            if i == j {
                continue;
            }
            let bj = j * STRIDE;
            if (buf[bj + FLAGS] as u32) & FLAG_ALIVE == 0 {
                continue;
            }
            let xj = buf[bj + X];
            let yj = buf[bj + Y];
            if !in_fov(buf, bi, xj, yj, focal_params.fov_rad) {
                continue;
            }

            let dx = xj - xi;
            let dy = yj - yi;
            if dx * dx + dy * dy < nd2 {
                count += 1;
                if count >= focal_params.quorum_threshold {
                    members[i] = true;
                    break;
                }
            }
        }
    }

    members
}

#[cfg(feature = "spatial-hash")]
fn compute_quorum_members_grid(
    buf: &[f32],
    agent_count: usize,
    follower_params: AgentParams,
    leader_params: AgentParams,
    grid: &SpatialGrid,
) -> Vec<bool> {
    let mut members = vec![false; agent_count];

    for i in 0..agent_count {
        let bi = i * STRIDE;
        let flags_i = buf[bi + FLAGS] as u32;
        if flags_i & FLAG_ALIVE == 0 {
            continue;
        }
        let focal_params =
            agent_params_for_role(flags_i & FLAG_LEADER != 0, follower_params, leader_params);
        if !quorum_enabled(focal_params.quorum_threshold) {
            continue;
        }

        let xi = buf[bi + X];
        let yi = buf[bi + Y];
        let nd2 = focal_params.neighbor_radius * focal_params.neighbor_radius;
        let (cell_xi, cell_yi) = grid.agent_cell(i);
        let mut count = 0u32;

        'neighbor_cells: for ndy in -1i32..=1 {
            for ndx in -1i32..=1 {
                for &j_u32 in grid.cell_agents(cell_xi + ndx, cell_yi + ndy) {
                    let j = j_u32 as usize;
                    if i == j {
                        continue;
                    }
                    let bj = j * STRIDE;
                    let xj = buf[bj + X];
                    let yj = buf[bj + Y];
                    if !in_fov(buf, bi, xj, yj, focal_params.fov_rad) {
                        continue;
                    }

                    let dx = xj - xi;
                    let dy = yj - yi;
                    if dx * dx + dy * dy < nd2 {
                        count += 1;
                        if count >= focal_params.quorum_threshold {
                            members[i] = true;
                            break 'neighbor_cells;
                        }
                    }
                }
            }
        }
    }

    members
}

#[cfg(any(not(feature = "spatial-hash"), test))]
pub fn apply_neighbor_forces(buf: &mut [f32], agent_count: usize, p: &SimParams) {
    let (follower_params, leader_params) = split_agent_params(p);
    let uses_quorum = quorum_enabled(follower_params.quorum_threshold)
        || quorum_enabled(leader_params.quorum_threshold);
    let quorum_members = uses_quorum
        .then(|| compute_quorum_members(buf, agent_count, follower_params, leader_params));

    for i in 0..agent_count {
        let bi = i * STRIDE;
        let flags_i = buf[bi + FLAGS] as u32;
        if flags_i & FLAG_ALIVE == 0 {
            continue;
        }

        let focal_is_leader = flags_i & FLAG_LEADER != 0;
        let focal_params = agent_params_for_role(focal_is_leader, follower_params, leader_params);
        let xi = buf[bi + X];
        let yi = buf[bi + Y];
        let nd2 = focal_params.neighbor_radius * focal_params.neighbor_radius;
        let sd2 = focal_params.separation_radius * focal_params.separation_radius;
        let ms = focal_params.max_speed;
        let focal_quorum = quorum_members.as_ref().is_some_and(|members| members[i]);
        let mut direct = DirectNeighborAccum::default();
        let mut composite = CompositeNeighborAccum::default();
        let mut leaders = LeaderNeighborAccum::default();

        for j in 0..agent_count {
            if i == j {
                continue;
            }
            let bj = j * STRIDE;
            let flags_j = buf[bj + FLAGS] as u32;
            if flags_j & FLAG_ALIVE == 0 {
                continue;
            }

            let xj = buf[bj + X];
            let yj = buf[bj + Y];
            if !in_fov(buf, bi, xj, yj, focal_params.fov_rad) {
                continue;
            }

            let dx = xj - xi;
            let dy = yj - yi;
            let d2 = dx * dx + dy * dy;
            if !focal_is_leader && flags_j & FLAG_LEADER != 0 {
                accumulate_leader_neighbor(&mut leaders, xj, yj, d2, nd2);
            }

            let neighbor_quorum = quorum_members.as_ref().is_some_and(|members| members[j]);
            if focal_quorum {
                if neighbor_quorum {
                    accumulate_direct_neighbor(
                        &mut direct,
                        dx,
                        dy,
                        d2,
                        xj,
                        yj,
                        buf[bj + VX],
                        buf[bj + VY],
                        nd2,
                        sd2,
                    );
                }
            } else if neighbor_quorum {
                accumulate_composite_neighbor(
                    &mut composite,
                    xj,
                    yj,
                    buf[bj + VX],
                    buf[bj + VY],
                    d2,
                    nd2,
                    sd2,
                );
            } else {
                accumulate_direct_neighbor(
                    &mut direct,
                    dx,
                    dy,
                    d2,
                    xj,
                    yj,
                    buf[bj + VX],
                    buf[bj + VY],
                    nd2,
                    sd2,
                );
            }
        }

        apply_accumulated_neighbor_forces(buf, bi, &focal_params, ms, &direct);
        if !focal_quorum {
            apply_composite_neighbor_force(buf, bi, &focal_params, ms, xi, yi, sd2, &composite);
        }
        if !focal_is_leader {
            apply_leader_pull(buf, bi, ms, p.leader_pull, &leaders);
        }
    }
}

#[cfg(feature = "spatial-hash")]
pub fn apply_neighbor_forces_grid(
    buf: &mut [f32],
    agent_count: usize,
    p: &SimParams,
    grid: &SpatialGrid,
) {
    let (follower_params, leader_params) = split_agent_params(p);
    let uses_quorum = quorum_enabled(follower_params.quorum_threshold)
        || quorum_enabled(leader_params.quorum_threshold);
    let quorum_members = uses_quorum.then(|| {
        compute_quorum_members_grid(buf, agent_count, follower_params, leader_params, grid)
    });

    for i in 0..agent_count {
        let bi = i * STRIDE;
        let flags_i = buf[bi + FLAGS] as u32;
        if flags_i & FLAG_ALIVE == 0 {
            continue;
        }

        let focal_is_leader = flags_i & FLAG_LEADER != 0;
        let focal_params = agent_params_for_role(focal_is_leader, follower_params, leader_params);
        let xi = buf[bi + X];
        let yi = buf[bi + Y];
        let nd2 = focal_params.neighbor_radius * focal_params.neighbor_radius;
        let sd2 = focal_params.separation_radius * focal_params.separation_radius;
        let ms = focal_params.max_speed;
        let focal_quorum = quorum_members.as_ref().is_some_and(|members| members[i]);
        let mut direct = DirectNeighborAccum::default();
        let mut composite = CompositeNeighborAccum::default();
        let mut leaders = LeaderNeighborAccum::default();
        let (cell_xi, cell_yi) = grid.agent_cell(i);

        for ndy in -1i32..=1 {
            for ndx in -1i32..=1 {
                for &j_u32 in grid.cell_agents(cell_xi + ndx, cell_yi + ndy) {
                    let j = j_u32 as usize;
                    if j == i {
                        continue;
                    }
                    let bj = j * STRIDE;
                    let flags_j = buf[bj + FLAGS] as u32;
                    let xj = buf[bj + X];
                    let yj = buf[bj + Y];
                    if !in_fov(buf, bi, xj, yj, focal_params.fov_rad) {
                        continue;
                    }

                    let dx = xj - xi;
                    let dy = yj - yi;
                    let d2 = dx * dx + dy * dy;
                    if !focal_is_leader && flags_j & FLAG_LEADER != 0 {
                        accumulate_leader_neighbor(&mut leaders, xj, yj, d2, nd2);
                    }

                    let neighbor_quorum = quorum_members.as_ref().is_some_and(|members| members[j]);
                    if focal_quorum {
                        if neighbor_quorum {
                            accumulate_direct_neighbor(
                                &mut direct,
                                dx,
                                dy,
                                d2,
                                xj,
                                yj,
                                buf[bj + VX],
                                buf[bj + VY],
                                nd2,
                                sd2,
                            );
                        }
                    } else if neighbor_quorum {
                        accumulate_composite_neighbor(
                            &mut composite,
                            xj,
                            yj,
                            buf[bj + VX],
                            buf[bj + VY],
                            d2,
                            nd2,
                            sd2,
                        );
                    } else {
                        accumulate_direct_neighbor(
                            &mut direct,
                            dx,
                            dy,
                            d2,
                            xj,
                            yj,
                            buf[bj + VX],
                            buf[bj + VY],
                            nd2,
                            sd2,
                        );
                    }
                }
            }
        }

        apply_accumulated_neighbor_forces(buf, bi, &focal_params, ms, &direct);
        if !focal_quorum {
            apply_composite_neighbor_force(buf, bi, &focal_params, ms, xi, yi, sd2, &composite);
        }
        if !focal_is_leader {
            apply_leader_pull(buf, bi, ms, p.leader_pull, &leaders);
        }
    }
}

// ---- Integrate: velocity += accel, clamp speed, apply damping, advance pos ----
#[inline]
pub fn integrate(
    buf: &mut [f32],
    base: usize,
    max_speed: f32,
    damping: f32,
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
) {
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

    if min_x <= max_x {
        if buf[base + X] < min_x {
            buf[base + X] = min_x;
            if buf[base + VX] < 0.0 {
                buf[base + VX] = 0.0;
            }
        } else if buf[base + X] > max_x {
            buf[base + X] = max_x;
            if buf[base + VX] > 0.0 {
                buf[base + VX] = 0.0;
            }
        }
    }

    if min_y <= max_y {
        if buf[base + Y] < min_y {
            buf[base + Y] = min_y;
            if buf[base + VY] < 0.0 {
                buf[base + VY] = 0.0;
            }
        } else if buf[base + Y] > max_y {
            buf[base + Y] = max_y;
            if buf[base + VY] > 0.0 {
                buf[base + VY] = 0.0;
            }
        }
    }

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
