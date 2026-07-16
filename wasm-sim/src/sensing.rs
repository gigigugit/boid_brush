// =============================================================================
// sensing.rs — Downsampled luminance/gradient map and 8-point radial sampler
//
// JS uploads a single-channel luminance buffer (u8 per pixel) at a potentially
// downsampled resolution. The Rust side stores it and provides a force function
// that samples 8 points around each boid, producing an avoid/attract force.
//
// Ported from index.html Boid.sense() and sampleSensing().
// =============================================================================

use crate::boid::*;
use crate::params::AgentParams;
use core::f32::consts::PI;

#[derive(Clone, Debug, Default)]
pub struct SensingRule {
    pub enabled: bool,
    pub attract: bool,
    pub strength: f32,
    pub radius: f32,
    pub fit_radius: f32,
    pub threshold: f32,
}

/// Sensing buffer: single-channel luminance at (sensing_w × sensing_h).
/// The JS host writes raw u8 luminance values here via get_sensing_buffer_ptr().
pub struct SensingMap {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Scale factors from canvas coords to sensing coords.
    pub scale_x: f32,
    pub scale_y: f32,
}

impl SensingMap {
    pub fn new() -> Self {
        Self {
            data: Vec::new(),
            width: 0,
            height: 0,
            scale_x: 1.0,
            scale_y: 1.0,
        }
    }

    /// Resize the sensing buffer. Called from update_sensing_from_image.
    pub fn resize(&mut self, w: u32, h: u32, canvas_w: u32, canvas_h: u32) {
        let len = (w * h) as usize;
        self.data.resize(len, 0);
        self.width = w;
        self.height = h;
        self.scale_x = if canvas_w > 0 {
            w as f32 / canvas_w as f32
        } else {
            1.0
        };
        self.scale_y = if canvas_h > 0 {
            h as f32 / canvas_h as f32
        } else {
            1.0
        };
    }

    /// Sample luminance at canvas coordinates. Returns 0.0-1.0.
    #[inline]
    pub fn sample(&self, canvas_x: f32, canvas_y: f32) -> f32 {
        if self.data.is_empty() {
            return 0.0;
        }
        let sx = (canvas_x * self.scale_x).round() as i32;
        let sy = (canvas_y * self.scale_y).round() as i32;
        if sx < 0 || sy < 0 || sx >= self.width as i32 || sy >= self.height as i32 {
            return 0.0;
        }
        let idx = (sy as u32 * self.width + sx as u32) as usize;
        self.data[idx] as f32 / 255.0
    }

    /// Sample luminance at canvas coordinates and return the minimum value across
    /// the center point plus 8 ring samples at `fit_radius`.
    /// This verifies the full local circular area before sensing force applies.
    #[inline]
    pub fn sample_fit(&self, canvas_x: f32, canvas_y: f32, fit_radius: f32) -> f32 {
        let mut min_sample = self.sample(canvas_x, canvas_y);
        if fit_radius <= 0.0 {
            return min_sample;
        }
        const FIT_SAMPLES: usize = 8;
        for i in 0..FIT_SAMPLES {
            let a = (i as f32 / FIT_SAMPLES as f32) * PI * 2.0;
            let sx = canvas_x + a.cos() * fit_radius;
            let sy = canvas_y + a.sin() * fit_radius;
            min_sample = min_sample.min(self.sample(sx, sy));
        }
        min_sample
    }
}

/// Apply sensing force to a single agent. 8-point radial sample.
#[inline]
pub fn apply_sensing_force(buf: &mut [f32], base: usize, p: &AgentParams, map: &SensingMap) {
    if !p.sensing_enabled || map.data.is_empty() {
        return;
    }

    let sr = p.sensing_radius;
    let fit_r = p.sensing_fit_radius.max(0.0);
    let bx = buf[base + X];
    let by = buf[base + Y];
    let mut fx = 0.0f32;
    let mut fy = 0.0f32;

    const SAMPLES: usize = 8;
    for i in 0..SAMPLES {
        let a = (i as f32 / SAMPLES as f32) * PI * 2.0;
        let sx = bx + a.cos() * sr;
        let sy = by + a.sin() * sr;
        let v = map.sample_fit(sx, sy, fit_r);
        if v > p.sensing_threshold {
            let dx = a.cos();
            let dy = a.sin();
            if p.sensing_attract {
                fx += dx * v;
                fy += dy * v;
            } else {
                fx -= dx * v;
                fy -= dy * v;
            }
        }
    }

    let ms = p.max_speed;
    buf[base + AX] += fx * p.sensing_strength * ms;
    buf[base + AY] += fy * p.sensing_strength * ms;
}

#[inline]
pub fn apply_sensing_rules_force(
    buf: &mut [f32],
    base: usize,
    p: &AgentParams,
    maps: &[SensingMap],
    rules: &[SensingRule],
) {
    if rules.is_empty() || maps.is_empty() {
        return;
    }

    let bx = buf[base + X];
    let by = buf[base + Y];
    let ms = p.max_speed;
    let mut total_fx = 0.0f32;
    let mut total_fy = 0.0f32;

    for (rule, map) in rules.iter().zip(maps.iter()) {
        if !rule.enabled || map.data.is_empty() || rule.strength == 0.0 || rule.radius <= 0.0 {
            continue;
        }

        let mut fx = 0.0f32;
        let mut fy = 0.0f32;
        let fit_r = rule.fit_radius.max(0.0);
        const SAMPLES: usize = 8;
        for i in 0..SAMPLES {
            let a = (i as f32 / SAMPLES as f32) * PI * 2.0;
            let sx = bx + a.cos() * rule.radius;
            let sy = by + a.sin() * rule.radius;
            let v = map.sample_fit(sx, sy, fit_r);
            if v > rule.threshold {
                let dx = a.cos();
                let dy = a.sin();
                if rule.attract {
                    fx += dx * v;
                    fy += dy * v;
                } else {
                    fx -= dx * v;
                    fy -= dy * v;
                }
            }
        }
        total_fx += fx * rule.strength * ms;
        total_fy += fy * rule.strength * ms;
    }

    buf[base + AX] += total_fx;
    buf[base + AY] += total_fy;
}
