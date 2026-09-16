// =============================================================================
// params.rs — Simulation parameters struct
// =============================================================================

use core::f32::consts::PI;

pub const MAX_SENSING_RULES: usize = 4;
pub const BOID_VARIANCE_COUNT: usize = 21;
pub const PARAMS_LEN: usize = 88 + BOID_VARIANCE_COUNT * 2;
const LEGACY_PARAMS_LEN: usize = 68;

#[derive(Clone, Copy, Debug)]
pub struct SensingRule {
    pub active: bool,
    pub attract: bool,
    pub strength: f32,
    pub range_min: f32,
    pub range_max: f32,
}

impl Default for SensingRule {
    fn default() -> Self {
        Self {
            active: false,
            attract: false,
            strength: 0.5,
            range_min: 0.0,
            range_max: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AgentParams {
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
    pub fov_rad: f32,
    pub individuality: f32,
    pub quorum_threshold: u32,
    pub quorum_composite_strength: f32,
    pub sensing_enabled: bool,
    pub sensing_attract: bool,
    pub sensing_strength: f32,
    pub sensing_radius: f32,
    pub sensing_fit_radius: f32,
    pub sensing_threshold: f32,
    pub sensing_rules: [SensingRule; MAX_SENSING_RULES],
    pub neighbor_radius: f32,
    pub separation_radius: f32,
    pub size_var: f32,
    pub opacity_var: f32,
    pub speed_var: f32,
    pub force_var: f32,
    pub hue_var: f32,
    pub sat_var: f32,
    pub lit_var: f32,
    pub boundary_margin: f32,
    pub variances: [f32; BOID_VARIANCE_COUNT],
}

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
    pub fov_rad: f32,
    pub individuality: f32,
    pub quorum_threshold: u32,
    pub quorum_composite_strength: f32,
    pub sensing_enabled: bool,
    pub sensing_attract: bool,
    pub sensing_strength: f32,
    pub sensing_radius: f32,
    pub sensing_fit_radius: f32,
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
    pub boundary_margin: f32,
    pub leader_pull: f32,
    pub leader_seek: f32,
    pub leader_cohesion: f32,
    pub leader_separation: f32,
    pub leader_alignment: f32,
    pub leader_jitter: f32,
    pub leader_wander: f32,
    pub leader_wander_speed: f32,
    pub leader_max_speed: f32,
    pub leader_damping: f32,
    pub leader_flow_field: f32,
    pub leader_flow_scale: f32,
    pub leader_flee_radius: f32,
    pub leader_fov_rad: f32,
    pub leader_individuality: f32,
    pub leader_quorum_threshold: u32,
    pub leader_quorum_composite_strength: f32,
    pub leader_sensing_enabled: bool,
    pub leader_sensing_attract: bool,
    pub leader_sensing_strength: f32,
    pub leader_sensing_radius: f32,
    pub leader_sensing_fit_radius: f32,
    pub leader_sensing_threshold: f32,
    pub sensing_rules: [SensingRule; MAX_SENSING_RULES],
    pub leader_neighbor_radius: f32,
    pub leader_separation_radius: f32,
    pub leader_size_var: f32,
    pub leader_opacity_var: f32,
    pub leader_speed_var: f32,
    pub leader_force_var: f32,
    pub leader_hue_var: f32,
    pub leader_sat_var: f32,
    pub leader_lit_var: f32,
    pub leader_boundary_margin: f32,
    pub variances: [f32; BOID_VARIANCE_COUNT],
    pub leader_variances: [f32; BOID_VARIANCE_COUNT],
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
            quorum_threshold: 0,
            quorum_composite_strength: 0.35,
            sensing_enabled: false,
            sensing_attract: false,
            sensing_strength: 0.5,
            sensing_radius: 20.0,
            sensing_fit_radius: 0.0,
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
            boundary_margin: -1.0,
            leader_pull: 0.35,
            leader_seek: 0.4,
            leader_cohesion: 0.15,
            leader_separation: 0.5,
            leader_alignment: 0.2,
            leader_jitter: 0.0,
            leader_wander: 0.0,
            leader_wander_speed: 0.3,
            leader_max_speed: 4.0,
            leader_damping: 0.95,
            leader_flow_field: 0.0,
            leader_flow_scale: 0.01,
            leader_flee_radius: 0.0,
            leader_fov_rad: 2.0 * PI,
            leader_individuality: 0.0,
            leader_quorum_threshold: 0,
            leader_quorum_composite_strength: 0.35,
            leader_sensing_enabled: false,
            leader_sensing_attract: false,
            leader_sensing_strength: 0.5,
            leader_sensing_radius: 20.0,
            leader_sensing_fit_radius: 0.0,
            leader_sensing_threshold: 0.1,
            sensing_rules: [SensingRule::default(); MAX_SENSING_RULES],
            leader_neighbor_radius: 80.0,
            leader_separation_radius: 25.0,
            leader_size_var: 0.0,
            leader_opacity_var: 0.0,
            leader_speed_var: 0.0,
            leader_force_var: 0.0,
            leader_hue_var: 0.0,
            leader_sat_var: 0.0,
            leader_lit_var: 0.0,
            leader_boundary_margin: -1.0,
            variances: [0.0; BOID_VARIANCE_COUNT],
            leader_variances: [0.0; BOID_VARIANCE_COUNT],
        }
    }
}

impl SimParams {
    /// Safely read a float parameter, reject non-finite values, clamp to
    /// non-negative, and fall back to `default` when missing/invalid.
    #[inline]
    fn read_nonnegative(raw: &[f32], index: usize, default: f32) -> f32 {
        raw.get(index)
            .copied()
            .filter(|value| value.is_finite())
            .map(|value| value.max(0.0))
            .unwrap_or(default)
    }

    #[inline]
    fn read_finite(raw: &[f32], index: usize, default: f32) -> f32 {
        raw.get(index)
            .copied()
            .filter(|value| value.is_finite())
            .unwrap_or(default)
    }

    fn leader_params(&self) -> AgentParams {
        AgentParams {
            seek: self.leader_seek,
            cohesion: self.leader_cohesion,
            separation: self.leader_separation,
            alignment: self.leader_alignment,
            jitter: self.leader_jitter,
            wander: self.leader_wander,
            wander_speed: self.leader_wander_speed,
            max_speed: self.leader_max_speed,
            damping: self.leader_damping,
            flow_field: self.leader_flow_field,
            flow_scale: self.leader_flow_scale,
            flee_radius: self.leader_flee_radius,
            fov_rad: self.leader_fov_rad,
            individuality: self.leader_individuality,
            quorum_threshold: self.leader_quorum_threshold,
            quorum_composite_strength: self.leader_quorum_composite_strength,
            sensing_enabled: self.leader_sensing_enabled,
            sensing_attract: self.leader_sensing_attract,
            sensing_strength: self.leader_sensing_strength,
            sensing_radius: self.leader_sensing_radius,
            sensing_fit_radius: self.leader_sensing_fit_radius,
            sensing_threshold: self.leader_sensing_threshold,
            sensing_rules: self.sensing_rules,
            neighbor_radius: self.leader_neighbor_radius,
            separation_radius: self.leader_separation_radius,
            size_var: self.leader_size_var,
            opacity_var: self.leader_opacity_var,
            speed_var: self.leader_speed_var,
            force_var: self.leader_force_var,
            hue_var: self.leader_hue_var,
            sat_var: self.leader_sat_var,
            lit_var: self.leader_lit_var,
            boundary_margin: self.leader_boundary_margin,
            variances: self.leader_variances,
        }
    }

    fn follower_params(&self) -> AgentParams {
        AgentParams {
            seek: self.seek,
            cohesion: self.cohesion,
            separation: self.separation,
            alignment: self.alignment,
            jitter: self.jitter,
            wander: self.wander,
            wander_speed: self.wander_speed,
            max_speed: self.max_speed,
            damping: self.damping,
            flow_field: self.flow_field,
            flow_scale: self.flow_scale,
            flee_radius: self.flee_radius,
            fov_rad: self.fov_rad,
            individuality: self.individuality,
            quorum_threshold: self.quorum_threshold,
            quorum_composite_strength: self.quorum_composite_strength,
            sensing_enabled: self.sensing_enabled,
            sensing_attract: self.sensing_attract,
            sensing_strength: self.sensing_strength,
            sensing_radius: self.sensing_radius,
            sensing_fit_radius: self.sensing_fit_radius,
            sensing_threshold: self.sensing_threshold,
            sensing_rules: self.sensing_rules,
            neighbor_radius: self.neighbor_radius,
            separation_radius: self.separation_radius,
            size_var: self.size_var,
            opacity_var: self.opacity_var,
            speed_var: self.speed_var,
            force_var: self.force_var,
            hue_var: self.hue_var,
            sat_var: self.sat_var,
            lit_var: self.lit_var,
            boundary_margin: self.boundary_margin,
            variances: self.variances,
        }
    }

    pub fn params_for(&self, is_leader: bool) -> AgentParams {
        if is_leader {
            self.leader_params()
        } else {
            self.follower_params()
        }
    }

    pub fn max_neighbor_radius(&self) -> f32 {
        (self.neighbor_radius * (1.0 + self.variances[18]))
            .max(self.leader_neighbor_radius * (1.0 + self.leader_variances[18]))
    }

    pub fn max_separation_radius(&self) -> f32 {
        (self.separation_radius * (1.0 + self.variances[19]))
            .max(self.leader_separation_radius * (1.0 + self.leader_variances[19]))
    }

    pub fn from_raw(raw: &[f32]) -> Self {
        assert!(raw.len() >= LEGACY_PARAMS_LEN);
        let sensing_rules = Self::read_sensing_rules(raw);
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
            fov_rad: raw[12] * PI / 180.0,
            individuality: raw[13],
            quorum_threshold: raw[14].max(0.0).round() as u32,
            quorum_composite_strength: raw[15].clamp(0.0, 1.0),
            sensing_enabled: raw[16] > 0.5,
            sensing_attract: raw[17] > 0.5,
            sensing_strength: raw[18],
            sensing_radius: raw[19],
            sensing_threshold: raw[20],
            target_x: raw[21],
            target_y: raw[22],
            time: raw[23],
            neighbor_radius: if raw[24] > 0.0 { raw[24] } else { 80.0 },
            separation_radius: if raw[25] > 0.0 { raw[25] } else { 25.0 },
            size_var: raw[26],
            opacity_var: raw[27],
            speed_var: raw[28],
            force_var: raw[29],
            hue_var: raw[30],
            sat_var: raw[31],
            lit_var: raw[32],
            boundary_margin: raw[33],
            leader_pull: raw[34].clamp(0.0, 1.0),
            leader_seek: raw[35],
            leader_cohesion: raw[36],
            leader_separation: raw[37],
            leader_alignment: raw[38],
            leader_jitter: raw[39],
            leader_wander: raw[40],
            leader_wander_speed: raw[41],
            leader_max_speed: raw[42],
            leader_damping: raw[43],
            leader_flow_field: raw[44],
            leader_flow_scale: raw[45],
            leader_flee_radius: raw[46],
            leader_fov_rad: raw[47] * PI / 180.0,
            leader_individuality: raw[48],
            leader_quorum_threshold: raw[49].max(0.0).round() as u32,
            leader_quorum_composite_strength: raw[50].clamp(0.0, 1.0),
            leader_sensing_enabled: raw[51] > 0.5,
            leader_sensing_attract: raw[52] > 0.5,
            leader_sensing_strength: raw[53],
            leader_sensing_radius: if raw[54] > 0.0 { raw[54] } else { 20.0 },
            leader_sensing_threshold: raw[55],
            leader_neighbor_radius: if raw[56] > 0.0 { raw[56] } else { 80.0 },
            leader_separation_radius: if raw[57] > 0.0 { raw[57] } else { 25.0 },
            leader_size_var: raw[58],
            leader_opacity_var: raw[59],
            leader_speed_var: raw[60],
            leader_force_var: raw[61],
            leader_hue_var: raw[62],
            leader_sat_var: raw[63],
            leader_lit_var: raw[64],
            leader_boundary_margin: raw[65],
            sensing_fit_radius: Self::read_nonnegative(raw, 66, 0.0),
            leader_sensing_fit_radius: Self::read_nonnegative(raw, 67, 0.0),
            sensing_rules,
            variances: Self::read_variances(raw, 88),
            leader_variances: Self::read_variances(raw, 88 + BOID_VARIANCE_COUNT),
        }
    }

    fn read_sensing_rules(raw: &[f32]) -> [SensingRule; MAX_SENSING_RULES] {
        let mut rules = [SensingRule::default(); MAX_SENSING_RULES];
        if raw.len() < PARAMS_LEN {
            return rules;
        }

        for (i, rule) in rules.iter_mut().enumerate() {
            let base = LEGACY_PARAMS_LEN + i * 5;
            let range_min = Self::read_finite(raw, base + 3, 0.0).clamp(0.0, 1.0);
            let range_max = Self::read_finite(raw, base + 4, 1.0).clamp(0.0, 1.0);
            *rule = SensingRule {
                active: raw[base] > 0.5,
                attract: raw[base + 1] > 0.5,
                strength: Self::read_finite(raw, base + 2, 0.5),
                range_min: range_min.min(range_max),
                range_max: range_min.max(range_max),
            };
        }
        rules
    }

    fn read_variances(raw: &[f32], start: usize) -> [f32; BOID_VARIANCE_COUNT] {
        let mut values = [0.0; BOID_VARIANCE_COUNT];
        for (index, value) in values.iter_mut().enumerate() {
            *value = Self::read_nonnegative(raw, start + index, 0.0).min(1.0);
        }
        values
    }
}

impl AgentParams {
    #[inline]
    fn varied_value(value: f32, variance: f32, seed: f32) -> f32 {
        (value * (1.0 + variance * seed)).max(0.0)
    }

    /// Apply the stable signed seeds stored on one agent. Index order matches
    /// BOID_VARIANCE_FIELDS in boid-parameter-contract.js.
    pub fn varied(mut self, seeds: &[f32]) -> Self {
        let v = &self.variances;
        self.seek = Self::varied_value(self.seek, v[0], seeds[0]);
        self.cohesion = Self::varied_value(self.cohesion, v[1], seeds[1]);
        self.separation = Self::varied_value(self.separation, v[2], seeds[2]);
        self.alignment = Self::varied_value(self.alignment, v[3], seeds[3]);
        self.jitter = Self::varied_value(self.jitter, v[4], seeds[4]);
        self.wander = Self::varied_value(self.wander, v[5], seeds[5]);
        self.wander_speed = Self::varied_value(self.wander_speed, v[6], seeds[6]);
        self.max_speed = Self::varied_value(self.max_speed, v[7], seeds[7]);
        self.damping = Self::varied_value(self.damping, v[8], seeds[8]).min(1.0);
        self.flow_field = Self::varied_value(self.flow_field, v[9], seeds[9]);
        self.flow_scale = Self::varied_value(self.flow_scale, v[10], seeds[10]);
        self.flee_radius = Self::varied_value(self.flee_radius, v[11], seeds[11]);
        self.fov_rad = Self::varied_value(self.fov_rad, v[12], seeds[12]).min(2.0 * PI);
        self.quorum_composite_strength =
            Self::varied_value(self.quorum_composite_strength, v[13], seeds[13]).min(1.0);
        self.sensing_strength = Self::varied_value(self.sensing_strength, v[14], seeds[14]);
        self.sensing_radius = Self::varied_value(self.sensing_radius, v[15], seeds[15]);
        self.sensing_fit_radius = Self::varied_value(self.sensing_fit_radius, v[16], seeds[16]);
        self.sensing_threshold =
            Self::varied_value(self.sensing_threshold, v[17], seeds[17]).min(1.0);
        self.neighbor_radius = Self::varied_value(self.neighbor_radius, v[18], seeds[18]).max(1.0);
        self.separation_radius =
            Self::varied_value(self.separation_radius, v[19], seeds[19]).max(1.0);
        self.boundary_margin = if self.boundary_margin < 0.0 {
            self.boundary_margin
        } else {
            Self::varied_value(self.boundary_margin, v[20], seeds[20])
        };
        self
    }
}

#[cfg(test)]
mod variance_tests {
    use super::*;

    #[test]
    fn zero_variance_preserves_every_agent_parameter() {
        let params = SimParams::default().params_for(false);
        let varied = params.varied(&[1.0; BOID_VARIANCE_COUNT]);
        assert_eq!(varied.seek, params.seek);
        assert_eq!(varied.max_speed, params.max_speed);
        assert_eq!(varied.neighbor_radius, params.neighbor_radius);
        assert_eq!(varied.boundary_margin, params.boundary_margin);
    }

    #[test]
    fn independent_seeds_only_change_their_owned_parameter() {
        let mut params = SimParams::default().params_for(false);
        params.variances[0] = 0.5;
        params.variances[18] = 0.25;
        let mut seeds = [0.0; BOID_VARIANCE_COUNT];
        seeds[0] = 1.0;
        seeds[18] = -1.0;
        let varied = params.varied(&seeds);
        assert_eq!(varied.seek, params.seek * 1.5);
        assert_eq!(varied.neighbor_radius, params.neighbor_radius * 0.75);
        assert_eq!(varied.cohesion, params.cohesion);
        assert_eq!(varied.max_speed, params.max_speed);
    }
}
