// =============================================================================
// noise.rs — 2D Simplex noise (port of the inline JS SN module)
//
// Deterministic permutation table seeded at init. Used by flow field force.
// =============================================================================

const F2: f32 = 0.366_025_4; // 0.5 * (sqrt(3) - 1)
const G2: f32 = 0.211_324_87; // (3 - sqrt(3)) / 6

static GRAD: [[f32; 2]; 8] = [
    [1.0, 1.0],
    [-1.0, 1.0],
    [1.0, -1.0],
    [-1.0, -1.0],
    [1.0, 0.0],
    [-1.0, 0.0],
    [0.0, 1.0],
    [0.0, -1.0],
];

pub struct SimplexNoise {
    perm: [u8; 512],
}

impl SimplexNoise {
    /// Create a new simplex noise with the given seed.
    pub fn new(seed: f32) -> Self {
        let mut perm = [0u8; 512];
        for i in 0..512 {
            let x = ((i % 256) as f32 + seed).sin() * 43758.546_9;
            perm[i] = ((x - x.floor()) * 256.0) as u8;
        }
        Self { perm }
    }

    /// 2D simplex noise, returns value in approximately [-1, 1].
    pub fn n2d(&self, x: f32, y: f32) -> f32 {
        let s = (x + y) * F2;
        let i = (x + s).floor();
        let j = (y + s).floor();
        let t = (i + j) * G2;

        let x0 = x - (i - t);
        let y0 = y - (j - t);

        let (i1, j1) = if x0 > y0 { (1, 0) } else { (0, 1) };

        let x1 = x0 - i1 as f32 + G2;
        let y1 = y0 - j1 as f32 + G2;
        let x2 = x0 - 1.0 + 2.0 * G2;
        let y2 = y0 - 1.0 + 2.0 * G2;

        let ii = (i as i32 & 255) as usize;
        let jj = (j as i32 & 255) as usize;

        let g0 = self.perm[ii + self.perm[jj] as usize] as usize % 8;
        let g1 = self.perm[ii + i1 + self.perm[jj + j1] as usize] as usize % 8;
        let g2 = self.perm[ii + 1 + self.perm[jj + 1] as usize] as usize % 8;

        let mut n0 = 0.0f32;
        let mut t0 = 0.5 - x0 * x0 - y0 * y0;
        if t0 > 0.0 {
            t0 *= t0;
            n0 = t0 * t0 * (GRAD[g0][0] * x0 + GRAD[g0][1] * y0);
        }

        let mut n1 = 0.0f32;
        let mut t1 = 0.5 - x1 * x1 - y1 * y1;
        if t1 > 0.0 {
            t1 *= t1;
            n1 = t1 * t1 * (GRAD[g1][0] * x1 + GRAD[g1][1] * y1);
        }

        let mut n2 = 0.0f32;
        let mut t2 = 0.5 - x2 * x2 - y2 * y2;
        if t2 > 0.0 {
            t2 *= t2;
            n2 = t2 * t2 * (GRAD[g2][0] * x2 + GRAD[g2][1] * y2);
        }

        70.0 * (n0 + n1 + n2)
    }
}
