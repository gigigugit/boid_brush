// =============================================================================
// lbm.rs — D2Q9 Lattice Boltzmann Method fluid solver with passive scalar advection
//
// Implements a 2D fluid simulation using the BGK (Bhatnagar–Gross–Krook) collision
// operator on a D2Q9 lattice. A secondary pigment/dye grid is advected by the
// computed velocity field, enabling realistic ink bleeding and flow effects.
//
// The LBM grid runs at a fraction of the canvas resolution (e.g., 1/4) for
// real-time performance. Boids act as "ink emitters" depositing pigment and
// injecting momentum into the fluid at their current positions each frame.
//
// ALGORITHM OVERVIEW
// ------------------
//   1. BGK Collision:  f*_i = f_i - (f_i - f^eq_i) / tau
//   2. Streaming:      f_i(x + e_i) = f*_i(x)   [pull scheme]
//   3. Boundaries:     Bounce-back at domain edges (no-slip walls)
//   4. Pigment:        Semi-Lagrangian advection + Laplacian diffusion
//
// D2Q9 velocity directions (index → (ex, ey)):
//   0: ( 0, 0)  rest
//   1: ( 1, 0)  east
//   2: ( 0, 1)  north
//   3: (-1, 0)  west
//   4: ( 0,-1)  south
//   5: ( 1, 1)  north-east
//   6: (-1, 1)  north-west
//   7: (-1,-1)  south-west
//   8: ( 1,-1)  south-east
// =============================================================================

/// D2Q9 velocity components
const EX: [i32; 9] = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const EY: [i32; 9] = [0, 0, 1, 0, -1, 1, 1, -1, -1];

/// D2Q9 equilibrium weights (must sum to 1)
const W: [f32; 9] = [
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

/// Opposite direction indices for bounce-back boundary conditions
const OPP: [usize; 9] = [0, 3, 4, 1, 2, 7, 8, 5, 6];

/// Pigment diffusion coefficient per step (prevents hard concentration edges)
const PIGMENT_DIFFUSE: f32 = 0.015;

/// Pigment decay per step (slow evaporation / drying)
const PIGMENT_DECAY: f32 = 0.0005;

/// Amplification factor applied to LBM velocity when advecting pigment.
/// LBM lattice velocities are O(0.1) but we want visually significant flow.
const VELOCITY_AMP: f32 = 4.0;

/// Minimum density threshold below which a cell is treated as vacuum.
const MIN_DENSITY: f32 = 1e-6;

/// Maximum allowed lattice velocity magnitude (LBM stability: |u| << cs = 1/√3)
const MAX_VELOCITY: f32 = 0.15;

/// Blend strength when injecting boid momentum into f distributions (0–1)
const MOMENTUM_BLEND: f32 = 0.12;

/// D2Q9 Lattice Boltzmann grid with integrated passive scalar (pigment) transport.
pub struct LbmGrid {
    /// Grid width in lattice cells.
    pub width: usize,
    /// Grid height in lattice cells.
    pub height: usize,

    /// Distribution functions, indexed as `f[q * (width * height) + y * width + x]`.
    /// `q` ∈ [0, 9) is the velocity direction index.
    pub f: Vec<f32>,

    /// Post-collision / streaming scratch buffer (same layout as `f`).
    f_scratch: Vec<f32>,

    /// Pigment/ink concentration per cell in [0, 1].
    /// Indexed as `pigment[y * width + x]`.
    pub pigment: Vec<f32>,

    /// Scratch buffer for pigment advection.
    pig_scratch: Vec<f32>,

    /// Scale from canvas pixels → LBM lattice coordinates.
    pub scale_x: f32,
    pub scale_y: f32,

    /// BGK relaxation time τ.  Kinematic viscosity ν = (τ − 0.5) / 3.
    /// Must satisfy τ > 0.5 for numerical stability.
    pub tau: f32,
}

impl LbmGrid {
    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    /// Create a new LBM grid for a canvas of `canvas_w × canvas_h` pixels,
    /// at LBM resolution `lbm_w × lbm_h`.
    ///
    /// Recommended: lbm_w = canvas_w / 4, lbm_h = canvas_h / 4.
    pub fn new(lbm_w: usize, lbm_h: usize, canvas_w: u32, canvas_h: u32) -> Self {
        let n = lbm_w * lbm_h;
        let mut grid = Self {
            width: lbm_w,
            height: lbm_h,
            f: vec![0.0_f32; 9 * n],
            f_scratch: vec![0.0_f32; 9 * n],
            pigment: vec![0.0_f32; n],
            pig_scratch: vec![0.0_f32; n],
            scale_x: lbm_w as f32 / canvas_w as f32,
            scale_y: lbm_h as f32 / canvas_h as f32,
            tau: 0.6,
        };
        grid.init_equilibrium();
        grid
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /// Reset distributions to equilibrium (ρ = 1, u = 0) and clear pigment.
    pub fn reset(&mut self) {
        self.init_equilibrium();
        for v in self.pigment.iter_mut() {
            *v = 0.0;
        }
        for v in self.pig_scratch.iter_mut() {
            *v = 0.0;
        }
    }

    /// Pointer to the pigment Float32Array for zero-copy JS access.
    ///
    /// JS usage:
    /// ```js
    /// const ptr = get_pigment_ptr();
    /// const pig = new Float32Array(wasm.memory.buffer, ptr, lbm_w * lbm_h);
    /// ```
    pub fn get_pigment_ptr(&self) -> *const f32 {
        self.pigment.as_ptr()
    }

    /// Inject ink and momentum from a boid at canvas position `(bx, by)`
    /// moving with velocity `(bvx, bvy)`. `ink_amount` ∈ [0, 1] controls
    /// how much pigment is deposited this frame.
    pub fn inject_boid(&mut self, bx: f32, by: f32, bvx: f32, bvy: f32, ink_amount: f32) {
        let gx = (bx * self.scale_x) as i32;
        let gy = (by * self.scale_y) as i32;
        let w = self.width as i32;
        let h = self.height as i32;

        if gx < 0 || gx >= w || gy < 0 || gy >= h {
            return;
        }

        let gx = gx as usize;
        let gy = gy as usize;
        let n = self.width * self.height;
        let cidx = gy * self.width + gx;

        // Deposit pigment
        self.pigment[cidx] = (self.pigment[cidx] + ink_amount).min(1.0);

        // Scale boid velocity to LBM units and clamp for numerical stability
        let vel_scale = self.scale_x.min(self.scale_y) * 0.06;
        let lux = (bvx * vel_scale).clamp(-MAX_VELOCITY, MAX_VELOCITY);
        let luy = (bvy * vel_scale).clamp(-MAX_VELOCITY, MAX_VELOCITY);

        // Compute current cell density
        let mut rho = 0.0_f32;
        for q in 0..9 {
            rho += self.f[q * n + cidx];
        }
        rho = rho.max(0.01);

        // Blend distribution toward equilibrium with boid velocity:
        // f_new = f * (1 - MOMENTUM_BLEND) + f_eq * MOMENTUM_BLEND
        let uu = lux * lux + luy * luy;
        for q in 0..9 {
            let eu = EX[q] as f32 * lux + EY[q] as f32 * luy;
            let feq = W[q] * rho * (1.0 + 3.0 * eu + 4.5 * eu * eu - 1.5 * uu);
            let fv = self.f[q * n + cidx];
            // mul_add(a, b): equivalent to fv * (1.0 - MOMENTUM_BLEND) + feq * MOMENTUM_BLEND
            self.f[q * n + cidx] = fv.mul_add(1.0 - MOMENTUM_BLEND, feq * MOMENTUM_BLEND);
        }
    }

    /// Advance the simulation by one LBM time step:
    /// BGK collision → streaming with bounce-back → pigment advection.
    pub fn step(&mut self) {
        self.collide();
        self.stream();
        self.advect_pigment();
    }

    // -------------------------------------------------------------------------
    // Internal implementation
    // -------------------------------------------------------------------------

    /// Initialise all distribution functions to the rest equilibrium (ρ = 1, u = 0).
    fn init_equilibrium(&mut self) {
        let n = self.width * self.height;
        for q in 0..9 {
            let wq = W[q];
            for i in 0..n {
                self.f[q * n + i] = wq;
                self.f_scratch[q * n + i] = wq;
            }
        }
    }

    /// BGK collision step.  Post-collision values are written to `f_scratch`.
    fn collide(&mut self) {
        let w = self.width;
        let h = self.height;
        let n = w * h;
        let inv_tau = 1.0 / self.tau;

        for y in 0..h {
            for x in 0..w {
                let cidx = y * w + x;

                // Macroscopic density ρ and momentum ρu
                let mut rho = 0.0_f32;
                let mut ux = 0.0_f32;
                let mut uy = 0.0_f32;
                for q in 0..9 {
                    let fv = self.f[q * n + cidx];
                    rho += fv;
                    ux += fv * EX[q] as f32;
                    uy += fv * EY[q] as f32;
                }

                // Guard against near-zero density (vacuum cells)
                if rho < MIN_DENSITY {
                    for q in 0..9 {
                        self.f_scratch[q * n + cidx] = W[q];
                    }
                    continue;
                }

                ux /= rho;
                uy /= rho;

                // Velocity clamping for numerical stability
                let speed_sq = ux * ux + uy * uy;
                let (ux, uy) = if speed_sq > MAX_VELOCITY * MAX_VELOCITY {
                    let inv_s = MAX_VELOCITY / speed_sq.sqrt();
                    (ux * inv_s, uy * inv_s)
                } else {
                    (ux, uy)
                };
                let u_sq = ux * ux + uy * uy;

                // BGK: f*_i = f_i + (f^eq_i − f_i) / τ
                for q in 0..9 {
                    let eu = EX[q] as f32 * ux + EY[q] as f32 * uy;
                    let feq = W[q] * rho * (1.0 + 3.0 * eu + 4.5 * eu * eu - 1.5 * u_sq);
                    let fv = self.f[q * n + cidx];
                    self.f_scratch[q * n + cidx] = fv + (feq - fv) * inv_tau;
                }
            }
        }
    }

    /// Streaming step using the "pull" scheme.
    ///
    /// `f[q](x, y) = f_scratch[q](x − ex[q], y − ey[q])`
    ///
    /// Cells that would pull from outside the domain use bounce-back:
    /// `f[q](x, y) = f_scratch[OPP[q]](x, y)` — the post-collision value
    /// of the opposite direction at the same cell — implementing no-slip walls.
    fn stream(&mut self) {
        let w = self.width;
        let h = self.height;
        let n = w * h;

        for y in 0..h {
            for x in 0..w {
                let cidx = y * w + x;
                for q in 0..9 {
                    let src_x = x as i32 - EX[q];
                    let src_y = y as i32 - EY[q];

                    if src_x >= 0 && src_x < w as i32 && src_y >= 0 && src_y < h as i32 {
                        let src_idx = src_y as usize * w + src_x as usize;
                        self.f[q * n + cidx] = self.f_scratch[q * n + src_idx];
                    } else {
                        // Bounce-back: reflect into opposite direction
                        self.f[q * n + cidx] = self.f_scratch[OPP[q] * n + cidx];
                    }
                }
            }
        }
    }

    /// Semi-Lagrangian pigment advection followed by Laplacian diffusion and decay.
    fn advect_pigment(&mut self) {
        let w = self.width;
        let h = self.height;
        let n = w * h;

        for y in 0..h {
            for x in 0..w {
                let cidx = y * w + x;

                // Extract velocity at this cell from the updated f
                let mut rho = 0.0_f32;
                let mut ux = 0.0_f32;
                let mut uy = 0.0_f32;
                for q in 0..9 {
                    let fv = self.f[q * n + cidx];
                    rho += fv;
                    ux += fv * EX[q] as f32;
                    uy += fv * EY[q] as f32;
                }
                if rho > MIN_DENSITY {
                    ux /= rho;
                    uy /= rho;
                }

                // Trace particle backward in time (semi-Lagrangian)
                let src_fx = x as f32 - ux * VELOCITY_AMP;
                let src_fy = y as f32 - uy * VELOCITY_AMP;

                let advected = self.bilinear_pigment(src_fx, src_fy);

                // Laplacian diffusion with zero-flux (Neumann) boundary:
                // at edges, mirror the central cell value so the gradient is zero.
                let p_l = if x > 0 { self.pigment[cidx - 1] } else { self.pigment[cidx] };
                let p_r = if x < w - 1 { self.pigment[cidx + 1] } else { self.pigment[cidx] };
                let p_u = if y > 0 { self.pigment[cidx - w] } else { self.pigment[cidx] };
                let p_d = if y < h - 1 { self.pigment[cidx + w] } else { self.pigment[cidx] };
                let laplacian = p_l + p_r + p_u + p_d - 4.0 * self.pigment[cidx];

                self.pig_scratch[cidx] =
                    (advected + PIGMENT_DIFFUSE * laplacian - PIGMENT_DECAY).clamp(0.0, 1.0);
            }
        }

        core::mem::swap(&mut self.pigment, &mut self.pig_scratch);
    }

    /// Clamped bilinear interpolation into the pigment grid.
    #[inline]
    fn bilinear_pigment(&self, fx: f32, fy: f32) -> f32 {
        let w = self.width;
        let h = self.height;

        let fx = fx.clamp(0.0, (w - 1) as f32);
        let fy = fy.clamp(0.0, (h - 1) as f32);

        let x0 = fx.floor() as usize;
        let y0 = fy.floor() as usize;
        let x1 = (x0 + 1).min(w - 1);
        let y1 = (y0 + 1).min(h - 1);

        let tx = fx - fx.floor();
        let ty = fy - fy.floor();

        let p00 = self.pigment[y0 * w + x0];
        let p10 = self.pigment[y0 * w + x1];
        let p01 = self.pigment[y1 * w + x0];
        let p11 = self.pigment[y1 * w + x1];

        let p0 = p00 + (p10 - p00) * tx;
        let p1 = p01 + (p11 - p01) * tx;
        p0 + (p1 - p0) * ty
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lbm_init_density() {
        let lbm = LbmGrid::new(40, 30, 160, 120);
        let n = lbm.width * lbm.height;
        // At equilibrium each cell should have total density ≈ 1.0 (sum of W[q] = 1)
        for cidx in 0..n {
            let rho: f32 = (0..9).map(|q| lbm.f[q * n + cidx]).sum();
            assert!(
                (rho - 1.0).abs() < 1e-5,
                "Cell {cidx} rho = {rho}, expected ≈ 1.0"
            );
        }
    }

    #[test]
    fn test_lbm_step_no_nan() {
        let mut lbm = LbmGrid::new(40, 30, 160, 120);
        for _ in 0..60 {
            lbm.step();
        }
        let n = lbm.width * lbm.height;
        for cidx in 0..n {
            for q in 0..9 {
                assert!(!lbm.f[q * n + cidx].is_nan(), "f[{q}][{cidx}] is NaN");
            }
            assert!(!lbm.pigment[cidx].is_nan(), "pigment[{cidx}] is NaN");
        }
    }

    #[test]
    fn test_lbm_inject_deposits_pigment() {
        let mut lbm = LbmGrid::new(40, 30, 160, 120);
        // Canvas centre → LBM centre
        lbm.inject_boid(80.0, 60.0, 2.0, 1.0, 0.5);
        // Pigment should be non-zero somewhere near LBM centre
        let cx = 20usize;
        let cy = 15usize;
        let cidx = cy * lbm.width + cx;
        assert!(lbm.pigment[cidx] > 0.0, "Pigment not deposited at centre");
    }

    #[test]
    fn test_lbm_pigment_flows() {
        let mut lbm = LbmGrid::new(40, 30, 160, 120);
        // Inject ink at the left edge with rightward momentum
        for _ in 0..5 {
            lbm.inject_boid(4.0, 60.0, 10.0, 0.0, 0.3);
        }
        let sum_before: f32 = lbm.pigment.iter().sum();

        // Run many steps so ink spreads
        for _ in 0..50 {
            lbm.step();
        }

        // Pigment should still exist (not all decayed) and spread across the grid
        let max_after = lbm.pigment.iter().cloned().fold(0.0_f32, f32::max);

        assert!(sum_before > 0.0, "No initial pigment deposited");
        // Some pigment remains
        assert!(max_after > 0.0, "All pigment decayed within 50 steps");
        // Pigment has spread (more cells are non-zero than just 1)
        let nonzero = lbm.pigment.iter().filter(|&&v| v > 1e-4).count();
        assert!(nonzero > 1, "Pigment did not spread: only {nonzero} non-zero cells");
    }

    #[test]
    fn test_lbm_reset() {
        let mut lbm = LbmGrid::new(40, 30, 160, 120);
        lbm.inject_boid(80.0, 60.0, 5.0, 3.0, 1.0);
        lbm.step();
        lbm.reset();
        let n = lbm.width * lbm.height;
        for cidx in 0..n {
            assert_eq!(lbm.pigment[cidx], 0.0, "Pigment not cleared after reset");
            let rho: f32 = (0..9).map(|q| lbm.f[q * n + cidx]).sum();
            assert!(
                (rho - 1.0).abs() < 1e-5,
                "Density not reset to equilibrium at {cidx}: rho={rho}"
            );
        }
    }
}
