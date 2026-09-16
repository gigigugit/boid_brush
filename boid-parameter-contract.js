// Canonical list of numeric boid parameters that can vary independently per
// agent. Order is part of the WASM/WebGPU packed contracts; append, do not
// reorder.
export const BOID_VARIANCE_FIELDS = Object.freeze([
  ['seek', 'Seek', 'Forces'],
  ['cohesion', 'Cohesion', 'Forces'],
  ['separation', 'Separation', 'Forces'],
  ['alignment', 'Alignment', 'Forces'],
  ['jitter', 'Jitter', 'Forces'],
  ['wander', 'Wander', 'Forces'],
  ['wanderSpeed', 'Wander Speed', 'Motion'],
  ['maxSpeed', 'Max Speed', 'Motion'],
  ['damping', 'Damping', 'Motion'],
  ['flowField', 'Flow', 'Forces'],
  ['flowScale', 'Flow Scale', 'Forces'],
  ['fleeRadius', 'Flee Radius', 'Radii'],
  ['fov', 'Field of View', 'Radii'],
  ['quorumCompositeStrength', 'Quorum Composite', 'Forces'],
  ['sensingStrength', 'Sensing Strength', 'Sensing'],
  ['sensingRadius', 'Sensing Radius', 'Sensing'],
  ['sensingFitRadius', 'Sensing Fit Radius', 'Sensing'],
  ['sensingThreshold', 'Sensing Threshold', 'Sensing'],
  ['neighborRadius', 'Neighbor Radius', 'Radii'],
  ['separationRadius', 'Separation Radius', 'Radii'],
  ['simBoundsMargin', 'Bounds Margin', 'Motion'],
].map(([key, label, category], index) => Object.freeze({
  key,
  label,
  category,
  index,
  varianceKey: `${key}Variance`,
  controlId: `${key}Variance`,
  leaderControlId: `leader${key[0].toUpperCase()}${key.slice(1)}Variance`,
  leaderOverrideId: `leaderOverride${key[0].toUpperCase()}${key.slice(1)}Variance`,
})));

export const BOID_VARIANCE_COUNT = BOID_VARIANCE_FIELDS.length;

export function readBoidVariances(params, leader = false) {
  const source = leader ? params?.leader?.variances : params?.variances;
  return BOID_VARIANCE_FIELDS.map(field => {
    const value = Number(source?.[field.key]);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  });
}

export function writeBoidVariances(target, params, start) {
  const follower = readBoidVariances(params);
  const leader = readBoidVariances(params, true);
  for (let index = 0; index < BOID_VARIANCE_COUNT; index++) {
    target[start + index] = follower[index];
    target[start + BOID_VARIANCE_COUNT + index] = leader[index];
  }
  return start + BOID_VARIANCE_COUNT * 2;
}
