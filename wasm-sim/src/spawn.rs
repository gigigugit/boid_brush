// =============================================================================
// spawn.rs — 11 spawn shape generators
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
