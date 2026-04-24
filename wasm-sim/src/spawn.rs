// =============================================================================
// spawn.rs — 19 spawn shape generators
//
// Each function writes agent positions relative to center (0,0). The caller
// applies rotation, jitter, and offset before writing into the agent buffer.
//
// Ported from index.html SS object (lines ~857-911).
// =============================================================================

use crate::forces::Rng;
use core::f32::consts::PI;

/// Spawn shape identifier (matches JS shape select values).
#[repr(u32)]
#[derive(Clone, Copy, PartialEq)]
pub enum SpawnShape {
    Circle = 0,
    Ring = 1,
    Gaussian = 2,
    Line = 3,
    Ellipse = 4,
    Diamond = 5,
    Grid = 6,
    Sunburst = 7,
    Spiral = 8,
    Poisson = 9,
    RandomCluster = 10,
    Burst = 11,
    Lemniscate = 12,
    Phyllotaxis = 13,
    NoiseScatter = 14,
    Bullseye = 15,
    Cross = 16,
    Wave = 17,
    VoronoiSeeds = 18,
}

impl SpawnShape {
    pub fn from_u32(v: u32) -> Self {
        match v {
            0 => Self::Circle,
            1 => Self::Ring,
            2 => Self::Gaussian,
            3 => Self::Line,
            4 => Self::Ellipse,
            5 => Self::Diamond,
            6 => Self::Grid,
            7 => Self::Sunburst,
            8 => Self::Spiral,
            9 => Self::Poisson,
            10 => Self::RandomCluster,
            11 => Self::Burst,
            12 => Self::Lemniscate,
            13 => Self::Phyllotaxis,
            14 => Self::NoiseScatter,
            15 => Self::Bullseye,
            16 => Self::Cross,
            17 => Self::Wave,
            18 => Self::VoronoiSeeds,
            _ => Self::Circle,
        }
    }
}

/// Generate `count` positions for the given shape. Returns (x, y) pairs in `out`.
/// `out` must have capacity for at least `count` entries.
pub fn generate(
    shape: SpawnShape,
    count: usize,
    radius: f32,
    rng: &mut Rng,
    out: &mut Vec<(f32, f32)>,
) {
    out.clear();
    match shape {
        SpawnShape::Circle => circle(count, radius, rng, out),
        SpawnShape::Ring => ring(count, radius, rng, out),
        SpawnShape::Gaussian => gaussian(count, radius, rng, out),
        SpawnShape::Line => line(count, radius, out),
        SpawnShape::Ellipse => ellipse(count, radius, rng, out),
        SpawnShape::Diamond => diamond(count, radius, rng, out),
        SpawnShape::Grid => grid(count, radius, out),
        SpawnShape::Sunburst => sunburst(count, radius, out),
        SpawnShape::Spiral => spiral(count, radius, out),
        SpawnShape::Poisson => poisson(count, radius, rng, out),
        SpawnShape::RandomCluster => random_cluster(count, radius, rng, out),
        SpawnShape::Burst => burst(count, radius, out),
        SpawnShape::Lemniscate => lemniscate(count, radius, out),
        SpawnShape::Phyllotaxis => phyllotaxis(count, radius, out),
        SpawnShape::NoiseScatter => noise_scatter(count, radius, rng, out),
        SpawnShape::Bullseye => bullseye(count, radius, out),
        SpawnShape::Cross => cross(count, radius, out),
        SpawnShape::Wave => wave(count, radius, out),
        SpawnShape::VoronoiSeeds => voronoi_seeds(count, radius, rng, out),
    }
}

/// Apply rotation by `angle` and jitter to all positions, then offset by (cx, cy).
pub fn transform(
    out: &mut [(f32, f32)],
    cx: f32,
    cy: f32,
    angle: f32,
    jitter: f32,
    radius: f32,
    rng: &mut Rng,
) {
    let cs = angle.cos();
    let sn = angle.sin();
    for pt in out.iter_mut() {
        let mut rx = pt.0 * cs - pt.1 * sn;
        let mut ry = pt.0 * sn + pt.1 * cs;
        if jitter > 0.0 {
            rx += (rng.next_f32() - 0.5) * radius * jitter * 2.0;
            ry += (rng.next_f32() - 0.5) * radius * jitter * 2.0;
        }
        pt.0 = cx + rx;
        pt.1 = cy + ry;
    }
}

// ---- Individual shape generators ----

fn circle(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    for _ in 0..count {
        let a = rng.next_f32() * PI * 2.0;
        let d = rng.next_f32().sqrt() * r;
        out.push((a.cos() * d, a.sin() * d));
    }
}

fn ring(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    let inner = r * 0.7;
    for _ in 0..count {
        let a = rng.next_f32() * PI * 2.0;
        let d = inner + rng.next_f32() * (r - inner);
        out.push((a.cos() * d, a.sin() * d));
    }
}

fn gaussian(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    for _ in 0..count {
        let u1 = rng.next_f32().max(0.0001);
        let u2 = rng.next_f32();
        let m = r * 0.4 * (-2.0 * u1.ln()).sqrt();
        let a = PI * 2.0 * u2;
        out.push((a.cos() * m, a.sin() * m));
    }
}

fn line(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let div = if count > 1 { (count - 1) as f32 } else { 1.0 };
    for i in 0..count {
        let t = (i as f32 / div) * 2.0 - 1.0;
        out.push((t * r, 0.0));
    }
}

fn ellipse(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    for _ in 0..count {
        let a = rng.next_f32() * PI * 2.0;
        let d = rng.next_f32().sqrt() * r;
        out.push((a.cos() * d, a.sin() * d * 0.35));
    }
}

fn diamond(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    for _ in 0..count {
        loop {
            let x = (rng.next_f32() * 2.0 - 1.0) * r;
            let y = (rng.next_f32() * 2.0 - 1.0) * r;
            if x.abs() / r + y.abs() / r <= 1.0 {
                out.push((x, y));
                break;
            }
        }
    }
}

fn grid(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let s = (count as f32).sqrt().ceil() as usize;
    let sp = (r * 2.0) / ((s as f32 - 1.0).max(1.0));
    let mut n = 0;
    for row in 0..s {
        for col in 0..s {
            if n >= count {
                return;
            }
            out.push((-r + col as f32 * sp, -r + row as f32 * sp));
            n += 1;
        }
    }
}

fn sunburst(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let arms = (count as f32 / 5.0).round().max(3.0) as usize;
    let per = ((count + arms - 1) / arms).max(1);
    let mut n = 0;
    for a in 0..arms {
        if n >= count {
            break;
        }
        let base_angle = (a as f32 / arms as f32) * PI * 2.0;
        for j in 0..per {
            if n >= count {
                break;
            }
            let d = (j as f32 / per as f32) * r;
            out.push((base_angle.cos() * d, base_angle.sin() * d));
            n += 1;
        }
    }
}

fn spiral(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let div = if count > 1 { (count - 1) as f32 } else { 1.0 };
    for i in 0..count {
        let t = i as f32 / div;
        let a = t * 3.0 * PI * 2.0;
        let d = t * r;
        out.push((a.cos() * d, a.sin() * d));
    }
}

fn poisson(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    let md = (r * 2.0) / (count as f32 * 2.0).sqrt();
    let md2 = md * md;
    let max_attempts = count * 50;
    let mut attempts = 0;

    while out.len() < count && attempts < max_attempts {
        let a = rng.next_f32() * PI * 2.0;
        let d = rng.next_f32().sqrt() * r;
        let cx = a.cos() * d;
        let cy = a.sin() * d;
        let mut too_close = false;
        for q in out.iter() {
            let dx = q.0 - cx;
            let dy = q.1 - cy;
            if dx * dx + dy * dy < md2 {
                too_close = true;
                break;
            }
        }
        if !too_close {
            out.push((cx, cy));
        }
        attempts += 1;
    }

    // Fill any remaining with random circle fallback
    while out.len() < count {
        let a = rng.next_f32() * PI * 2.0;
        let d = rng.next_f32().sqrt() * r;
        out.push((a.cos() * d, a.sin() * d));
    }
}

fn random_cluster(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    let nc = 3 + (rng.next_f32() * 4.0) as usize;
    let mut centers = Vec::with_capacity(nc);
    for _ in 0..nc {
        let a = rng.next_f32() * PI * 2.0;
        let d = rng.next_f32() * r * 0.7;
        centers.push((a.cos() * d, a.sin() * d));
    }
    let cluster_r = r * 0.3;
    for i in 0..count {
        let c = &centers[i % nc];
        let a = rng.next_f32() * PI * 2.0;
        let d = rng.next_f32().sqrt() * cluster_r;
        out.push((c.0 + a.cos() * d, c.1 + a.sin() * d));
    }
}

/// Radial spokes with points clustered densely near the origin, thinning toward tips.
fn burst(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let arms = (count as f32 / 6.0).round().max(4.0) as usize;
    let per = ((count + arms - 1) / arms).max(1);
    let mut n = 0;
    for a in 0..arms {
        if n >= count {
            break;
        }
        let angle = (a as f32 / arms as f32) * PI * 2.0;
        for j in 0..per {
            if n >= count {
                break;
            }
            // Quadratic spacing: t^2 concentrates points near the origin.
            let t = j as f32 / per as f32;
            let d = t * t * r;
            out.push((angle.cos() * d, angle.sin() * d));
            n += 1;
        }
    }
}

/// Points along a lemniscate of Bernoulli (figure-8) curve.
fn lemniscate(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let div = if count > 1 { (count - 1) as f32 } else { 1.0 };
    for i in 0..count {
        let t = (i as f32 / div) * PI * 2.0;
        let denom = 1.0 + t.sin() * t.sin();
        out.push((r * t.cos() / denom, r * t.sin() * t.cos() / denom));
    }
}

/// Golden-angle phyllotaxis (Fibonacci sunflower) — organic, evenly-distributed spiral.
fn phyllotaxis(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    // Golden angle ≈ 137.508° in radians
    let golden_angle = PI * (3.0 - 5.0_f32.sqrt());
    let scale = r / (count as f32).sqrt();
    for i in 0..count {
        let a = i as f32 * golden_angle;
        let d = (i as f32).sqrt() * scale;
        out.push((a.cos() * d, a.sin() * d));
    }
}

/// Grid-based noise scatter: each grid cell is accepted or rejected by a hash,
/// producing organic droplet-like coverage with natural gaps.
fn noise_scatter(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    let cells = ((count as f32 * 2.5).sqrt() as usize).max(5);
    let cell_size = (r * 2.0) / cells as f32;
    let mut accepted: Vec<(f32, f32)> = Vec::new();
    for row in 0..cells {
        for col in 0..cells {
            let cx = -r + (col as f32 + 0.5) * cell_size;
            let cy = -r + (row as f32 + 0.5) * cell_size;
            if cx * cx + cy * cy > r * r {
                continue;
            }
            // Mix two primes to hash grid coords into a float in [0,1)
            let h = (row as u32)
                .wrapping_mul(2654435761)
                .wrapping_add((col as u32).wrapping_mul(2246822519));
            let fh = ((h >> 16) as f32) / 65535.0;
            if fh > 0.4 {
                accepted.push((cx, cy));
            }
        }
    }
    if accepted.is_empty() {
        circle(count, r, rng, out);
        return;
    }
    for i in 0..count {
        let (cx, cy) = accepted[i % accepted.len()];
        let ox = (rng.next_f32() - 0.5) * cell_size;
        let oy = (rng.next_f32() - 0.5) * cell_size;
        out.push((cx + ox, cy + oy));
    }
}

/// Concentric rings (bullseye) with points proportional to circumference per ring.
fn bullseye(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let rings = ((count as f32 / 5.0).round() as usize).max(2).min(8);
    // Weight each ring k by its index so outer rings get more points.
    let total_weight: f32 = (1..=rings).map(|k| k as f32).sum();
    let mut n = 0;
    for k in 1..=rings {
        if n >= count {
            break;
        }
        let ring_r = (k as f32 / rings as f32) * r;
        let per = if k == rings {
            count - n
        } else {
            ((k as f32 / total_weight) * count as f32).round() as usize
        };
        let per = per.max(1);
        for j in 0..per {
            if n >= count {
                break;
            }
            let a = (j as f32 / per as f32) * PI * 2.0;
            out.push((a.cos() * ring_r, a.sin() * ring_r));
            n += 1;
        }
    }
}

/// Plus/cross shape: points along two perpendicular lines through the center.
fn cross(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let half = count / 2;
    let rest = count - half;
    let div_h = if half > 1 { (half - 1) as f32 } else { 1.0 };
    let div_v = if rest > 1 { (rest - 1) as f32 } else { 1.0 };
    for i in 0..half {
        let t = (i as f32 / div_h) * 2.0 - 1.0;
        out.push((t * r, 0.0));
    }
    for i in 0..rest {
        let t = (i as f32 / div_v) * 2.0 - 1.0;
        out.push((0.0, t * r));
    }
}

/// Sinusoidal wave strip: points on y = A·sin(x) across the diameter.
fn wave(count: usize, r: f32, out: &mut Vec<(f32, f32)>) {
    let div = if count > 1 { (count - 1) as f32 } else { 1.0 };
    for i in 0..count {
        let t = (i as f32 / div) * 2.0 - 1.0; // -1..1
        let x = t * r;
        let y = (t * PI * 2.0).sin() * r * 0.3;
        out.push((x, y));
    }
}

/// Voronoi seeds: a small set of random poles, boids clustered around them.
fn voronoi_seeds(count: usize, r: f32, rng: &mut Rng, out: &mut Vec<(f32, f32)>) {
    let num_poles = ((count as f32).sqrt() as usize).max(3).min(8);
    let mut poles = Vec::with_capacity(num_poles);
    for _ in 0..num_poles {
        let a = rng.next_f32() * PI * 2.0;
        let d = rng.next_f32().sqrt() * r * 0.8;
        poles.push((a.cos() * d, a.sin() * d));
    }
    let jitter_r = r * 0.15;
    for i in 0..count {
        let (px, py) = poles[i % num_poles];
        let a = rng.next_f32() * PI * 2.0;
        let d = rng.next_f32().sqrt() * jitter_r;
        out.push((px + a.cos() * d, py + a.sin() * d));
    }
}
