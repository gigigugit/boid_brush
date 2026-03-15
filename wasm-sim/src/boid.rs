// =============================================================================
// boid.rs — Agent memory layout constants and per-agent helpers
//
// PACKED AGENT LAYOUT (Float32Array-compatible)
// Fixed stride of 23 floats (92 bytes) per agent. JS creates a typed view:
//   new Float32Array(wasm.memory.buffer, ptr, count * STRIDE)
//
// Offset | Field       | Description
// -------|-------------|---------------------------------------------
//   0    | x           | position x
//   1    | y           | position y
//   2    | vx          | velocity x
//   3    | vy          | velocity y
//   4    | ax          | acceleration x
//   5    | ay          | acceleration y
//   6    | wa          | wander angle (Brownian walk state)
//   7    | life        | frame counter (incremented each step)
//   8    | sm          | stamp size multiplier (set at spawn)
//   9    | om          | stamp opacity multiplier (set at spawn)
//  10    | nx          | noise coord x (for flow field)
//  11    | ny          | noise coord y (for flow field)
//  12    | lsx         | last stamp x (for interpolated stamping)
//  13    | lsy         | last stamp y (for interpolated stamping)
//  14    | hs          | has-stamped flag (0.0 = no, 1.0 = yes)
//  15    | flags       | bitfield as f32: alive(bit0), active(bit1)
//  16    | spd_m       | per-agent max-speed multiplier (set at spawn)
//  17    | seek_m      | per-agent seek weight multiplier (set at spawn)
//  18    | coh_m       | per-agent cohesion multiplier (set at spawn)
//  19    | sep_m       | per-agent separation multiplier (set at spawn)
//  20    | hue         | per-agent hue offset in degrees (set at spawn)
//  21    | sat         | per-agent saturation offset 0-1 (set at spawn)
//  22    | lit         | per-agent lightness offset 0-1 (set at spawn)
// =============================================================================

/// Number of f32 values per agent in the packed buffer.
pub const STRIDE: usize = 23;

// Field offsets within each agent's STRIDE-sized slice.
pub const X: usize = 0;
pub const Y: usize = 1;
pub const VX: usize = 2;
pub const VY: usize = 3;
pub const AX: usize = 4;
pub const AY: usize = 5;
pub const WA: usize = 6;
pub const LIFE: usize = 7;
pub const SM: usize = 8;
pub const OM: usize = 9;
pub const NX: usize = 10;
pub const NY: usize = 11;
pub const LSX: usize = 12;
pub const LSY: usize = 13;
pub const HS: usize = 14;
pub const FLAGS: usize = 15;
pub const SPD_M: usize = 16;
pub const SEEK_M: usize = 17;
pub const COH_M: usize = 18;
pub const SEP_M: usize = 19;
pub const HUE: usize = 20;
pub const SAT: usize = 21;
pub const LIT: usize = 22;

// Flag bits (stored as f32, cast to u32 for bit ops)
pub const FLAG_ALIVE: u32 = 1;

/// Read a flag bit from the agent's flags field.
#[inline]
pub fn has_flag(buf: &[f32], base: usize, flag: u32) -> bool {
    (buf[base + FLAGS] as u32) & flag != 0
}

/// Set a flag bit on the agent.
#[inline]
pub fn set_flag(buf: &mut [f32], base: usize, flag: u32) {
    let v = buf[base + FLAGS] as u32 | flag;
    buf[base + FLAGS] = v as f32;
}

/// Clear a flag bit on the agent.
#[inline]
pub fn clear_flag(buf: &mut [f32], base: usize, flag: u32) {
    let v = buf[base + FLAGS] as u32 & !flag;
    buf[base + FLAGS] = v as f32;
}

/// Initialize a new agent at `base` offset in the buffer.
#[inline]
pub fn init_agent(
    buf: &mut [f32],
    base: usize,
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    sm: f32,
    om: f32,
    wa: f32,
    nx: f32,
    ny: f32,
    spd_m: f32,
    seek_m: f32,
    coh_m: f32,
    sep_m: f32,
    hue: f32,
    sat: f32,
    lit: f32,
) {
    buf[base + X] = x;
    buf[base + Y] = y;
    buf[base + VX] = vx;
    buf[base + VY] = vy;
    buf[base + AX] = 0.0;
    buf[base + AY] = 0.0;
    buf[base + WA] = wa;
    buf[base + LIFE] = 0.0;
    buf[base + SM] = sm;
    buf[base + OM] = om;
    buf[base + NX] = nx;
    buf[base + NY] = ny;
    buf[base + LSX] = x;
    buf[base + LSY] = y;
    buf[base + HS] = 0.0;
    buf[base + FLAGS] = FLAG_ALIVE as f32;
    buf[base + SPD_M] = spd_m;
    buf[base + SEEK_M] = seek_m;
    buf[base + COH_M] = coh_m;
    buf[base + SEP_M] = sep_m;
    buf[base + HUE] = hue;
    buf[base + SAT] = sat;
    buf[base + LIT] = lit;
}
