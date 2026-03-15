// =============================================================================
// params.rs — Simulation parameters struct
//
// JS writes a Float32Array of 32 floats into WASM memory before each step().
// This module reads those raw floats into a typed struct.
//
// PARAMS BUFFER LAYOUT (Float32Array, 32 floats = 128 bytes)
// Offset | Param            | JS source (from getP())
// -------|------------------|------------------------
//   0    | seek             | p.seek  (0-1)
//   1    | cohesion         | p.cohesion (0-1, pre-scaled)
//   2    | separation       | p.separation (0-1, pre-scaled)
//   3    | alignment        | p.alignment (0-1)
//   4    | jitter           | p.jitter (0-1)
//   5    | wander           | p.wander (0-1)
//   6    | wander_speed     | p.wanderSpeed (0-1)
//   7    | max_speed        | p.maxSpeed (already halved)
//   8    | damping          | p.damping (0-1, e.g. 0.95)
//   9    | flow_field       | p.flowField (0-1)
//  10    | flow_scale       | p.flowScale (small, e.g. 0.01)
//  11    | flee_radius      | p.fleeRadius (pixels)
//  12    | fov              | p.fov (degrees, converted to radians in Rust)
//  13    | individuality    | p.individuality (0-1)
//  14    | sensing_enabled  | 0.0 or 1.0
//  15    | sensing_mode     | 0.0 = avoid, 1.0 = attract
//  16    | sensing_strength | p.sensingStrength (0-1)
//  17    | sensing_radius   | p.sensingRadius (pixels)
//  18    | sensing_threshold| p.sensingThreshold (0-1)
//  19    | target_x         | cursor x (canvas coords)
//  20    | target_y         | cursor y (canvas coords)
//  21    | time             | elapsed time (seconds or ms, for flow field)
//  22    | neighbor_radius  | default 80.0
//  23    | separation_radius| default 25.0
//  24    | size_var         | per-boid size variance (0-1)
//  25    | opacity_var      | per-boid opacity variance (0-1)
//  26    | speed_var        | per-boid speed variance (0-1)
//  27    | force_var        | per-boid force weight variance (0-1)
//  28    | hue_var          | per-boid hue offset variance (0-1)
//  29    | sat_var          | per-boid saturation offset variance (0-1)
//  30    | lit_var          | per-boid lightness offset variance (0-1)
//  31    | reserved         | 0.0
// =============================================================================

use core::f32::consts::PI;

/// Total number of f32s in the params buffer.
pub const PARAMS_LEN: usize = 32;

#[derive(Clone, Debug)]
pub struct SimParams {
    pub seek: f32,
    pub cohesion: f32,
    pub separation: f32,
    pub alignment: f32,
    pub jitter: f32,
    pub wander: f32,
    pub wander_speed: f32,
    pub max_speed: f32,
    pub damping: f32,
    pub flow_field: f32,
    pub flow_scale: f32,
    pub flee_radius: f32,
    pub fov_rad: f32,          // stored in radians
    pub individuality: f32,
    pub sensing_enabled: bool,
    pub sensing_attract: bool, // false = avoid, true = attract
    pub sensing_strength: f32,
    pub sensing_radius: f32,
    pub sensing_threshold: f32,
    pub target_x: f32,
    pub target_y: f32,
    pub time: f32,
    pub neighbor_radius: f32,
    pub separation_radius: f32,
    pub size_var: f32,
    pub opacity_var: f32,
    pub speed_var: f32,
    pub force_var: f32,
    pub hue_var: f32,
    pub sat_var: f32,
    pub lit_var: f32,
}

impl Default for SimParams {
    fn default() -> Self {
        Self {
            seek: 0.4,
            cohesion: 0.15,
            separation: 0.5,
            alignment: 0.2,
            jitter: 0.0,
            wander: 0.0,
            wander_speed: 0.3,
            max_speed: 4.0,
            damping: 0.95,
            flow_field: 0.0,
            flow_scale: 0.01,
            flee_radius: 0.0,
            fov_rad: 2.0 * PI,
            individuality: 0.0,
            sensing_enabled: false,
            sensing_attract: false,
            sensing_strength: 0.5,
            sensing_radius: 20.0,
            sensing_threshold: 0.1,
            target_x: 0.0,
            target_y: 0.0,
            time: 0.0,
            neighbor_radius: 80.0,
            separation_radius: 25.0,
            size_var: 0.0,
            opacity_var: 0.0,
            speed_var: 0.0,
            force_var: 0.0,
            hue_var: 0.0,
            sat_var: 0.0,
            lit_var: 0.0,
        }
    }
}

impl SimParams {
    /// Parse from a raw f32 slice (at least PARAMS_LEN elements).
    pub fn from_raw(raw: &[f32]) -> Self {
        assert!(raw.len() >= PARAMS_LEN);
        Self {
            seek: raw[0],
            cohesion: raw[1],
            separation: raw[2],
            alignment: raw[3],
            jitter: raw[4],
            wander: raw[5],
            wander_speed: raw[6],
            max_speed: raw[7],
            damping: raw[8],
            flow_field: raw[9],
            flow_scale: raw[10],
            flee_radius: raw[11],
            fov_rad: raw[12] * PI / 180.0, // degrees → radians
            individuality: raw[13],
            sensing_enabled: raw[14] > 0.5,
            sensing_attract: raw[15] > 0.5,
            sensing_strength: raw[16],
            sensing_radius: raw[17],
            sensing_threshold: raw[18],
            target_x: raw[19],
            target_y: raw[20],
            time: raw[21],
            neighbor_radius: if raw[22] > 0.0 { raw[22] } else { 80.0 },
            separation_radius: if raw[23] > 0.0 { raw[23] } else { 25.0 },
            size_var: raw[24],
            opacity_var: raw[25],
            speed_var: raw[26],
            force_var: raw[27],
            hue_var: raw[28],
            sat_var: raw[29],
            lit_var: raw[30],
        }
    }
}
