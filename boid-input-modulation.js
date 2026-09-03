/**
 * Boid Input Modulation Framework — pure, DOM-free, hardware-free core.
 *
 * Pipeline (one direction, no hidden state outside the explicit tracker):
 *
 *   PointerEvent / touch  ──(adapter in app.js)──▶  InputFrame
 *   InputFrame            ──(FeatureTracker)─────▶  FeatureFrame  (stable channels)
 *   FeatureFrame + matrix ──(evaluateModMatrix)──▶  ModEvaluation (per-target offset/gain/clamp)
 *   ModEvaluation + base  ──(applyModTargets)────▶  boid params   (allowlisted targets only)
 *
 * The boid runtime only ever sees a FeatureFrame and a ModEvaluation, so it is
 * independent of the hardware that produced the samples (mouse, Apple Pencil,
 * touch, or a synthetic frame in a test).
 *
 * Everything exported here is pure or explicitly state-in/state-out so it can
 * be unit tested without a DOM.
 */

export const MOD_MATRIX_FORMAT = 'modMatrix.v1';
export const MOD_MATRIX_VERSION = 1;

// ── Small shared helpers ────────────────────────────────────
const clamp = (value, min, max) => value < min ? min : (value > max ? max : value);
const clamp01 = value => clamp(value, 0, 1);
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const CIRCULAR_CHANNEL_IDS = new Set(['direction', 'azimuth', 'twist']);

function _smoothChannel(previous, next, alpha, circular) {
  if (!circular) return previous + (next - previous) * alpha;
  let delta = next - previous;
  if (delta > 0.5) delta -= 1;
  else if (delta < -0.5) delta += 1;
  const value = previous + delta * alpha;
  return ((value % 1) + 1) % 1;
}

// ── Input capabilities ──────────────────────────────────────
// A capability is a claim about what the *device* actually reported for this
// sample. Routes bound to a channel whose capability is missing are skipped
// (never silently treated as 0), and the skip is reported in diagnostics.
export const INPUT_CAPABILITIES = Object.freeze({
  POSITION: 'position',
  PRESSURE: 'pressure',
  TILT: 'tilt',
  AZIMUTH: 'azimuth',
  TWIST: 'twist',
  CONTACT: 'contact',
  MULTITOUCH: 'multitouch',
});

// ── Source registry ─────────────────────────────────────────
// Sources describe *where* InputFrames come from. Adapters call
// `createInputFrame({ sourceId: 'pencil', ... })`; the registry gives the UI a
// readable label and the capability floor a source is expected to provide.
const _sourceRegistry = new Map();

function _registerBuiltinSource(source) {
  _sourceRegistry.set(source.id, Object.freeze({ ...source, capabilities: Object.freeze([...source.capabilities]) }));
}

_registerBuiltinSource({
  id: 'mouse',
  label: 'Mouse / Trackpad',
  capabilities: [INPUT_CAPABILITIES.POSITION],
});
_registerBuiltinSource({
  id: 'pen',
  label: 'Stylus / Apple Pencil',
  capabilities: [
    INPUT_CAPABILITIES.POSITION, INPUT_CAPABILITIES.PRESSURE, INPUT_CAPABILITIES.TILT,
    INPUT_CAPABILITIES.AZIMUTH, INPUT_CAPABILITIES.TWIST,
  ],
});
_registerBuiltinSource({
  id: 'touch',
  label: 'Touch',
  capabilities: [
    INPUT_CAPABILITIES.POSITION, INPUT_CAPABILITIES.PRESSURE,
    INPUT_CAPABILITIES.CONTACT, INPUT_CAPABILITIES.MULTITOUCH,
  ],
});
_registerBuiltinSource({
  id: 'synthetic',
  label: 'Synthetic / Test',
  capabilities: Object.values(INPUT_CAPABILITIES),
});

export function registerInputSource({ id, label, capabilities = [] } = {}) {
  if (!id || typeof id !== 'string') return null;
  _registerBuiltinSource({ id, label: label || id, capabilities: capabilities.filter(Boolean) });
  return _sourceRegistry.get(id);
}

export function getInputSource(id) {
  return _sourceRegistry.get(id) || _sourceRegistry.get('mouse');
}

export function listInputSources() {
  return [..._sourceRegistry.values()];
}

// ── InputFrame ──────────────────────────────────────────────
// Normalized, adapter-agnostic sample. Angles are radians, tilt is degrees
// (matching PointerEvent), twist is degrees 0..359. Everything is optional;
// absent fields simply do not contribute capabilities.
export function createInputFrame(raw = {}) {
  const source = getInputSource(raw.sourceId);
  const declared = new Set(Array.isArray(raw.capabilities) ? raw.capabilities : []);
  const has = key => raw[key] !== undefined && raw[key] !== null && Number.isFinite(Number(raw[key]));
  const capabilities = new Set();
  if (has('x') && has('y')) capabilities.add(INPUT_CAPABILITIES.POSITION);
  if (has('pressure')) capabilities.add(INPUT_CAPABILITIES.PRESSURE);
  if (has('tiltX') || has('tiltY') || has('altitude')) capabilities.add(INPUT_CAPABILITIES.TILT);
  if (has('azimuth')) capabilities.add(INPUT_CAPABILITIES.AZIMUTH);
  if (has('twist')) capabilities.add(INPUT_CAPABILITIES.TWIST);
  if (has('contactWidth') || has('contactHeight')) capabilities.add(INPUT_CAPABILITIES.CONTACT);
  if (has('touchCount')) capabilities.add(INPUT_CAPABILITIES.MULTITOUCH);
  for (const capability of declared) capabilities.add(capability);
  return Object.freeze({
    sourceId: source.id,
    t: finite(raw.t, 0),
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    pressure: clamp01(finite(raw.pressure, 0)),
    tiltX: clamp(finite(raw.tiltX, 0), -90, 90),
    tiltY: clamp(finite(raw.tiltY, 0), -90, 90),
    altitude: clamp(finite(raw.altitude, Math.PI / 2), 0, Math.PI / 2),
    azimuth: finite(raw.azimuth, 0),
    twist: finite(raw.twist, 0),
    contactWidth: Math.max(0, finite(raw.contactWidth, 0)),
    contactHeight: Math.max(0, finite(raw.contactHeight, 0)),
    touchCount: Math.max(0, Math.round(finite(raw.touchCount, 0))),
    capabilities: Object.freeze([...capabilities]),
  });
}

// ── FeatureFrame channels (stable contract) ─────────────────
// Channel ids are the stable public surface: presets, routes, and diagnostics
// all reference them by id. Adding a channel is additive; renaming one is a
// breaking change that needs a modMatrix.v2.
export const FEATURE_CHANNELS = Object.freeze([
  { id: 'constant', label: 'Constant', capability: null, smoothing: 0, deadzone: 0, description: 'Always 1.0 — use for a static offset or a condition-only route.' },
  { id: 'pressure', label: 'Pressure', capability: INPUT_CAPABILITIES.PRESSURE, smoothing: 0.75, deadzone: 0, description: 'Normalized stylus/touch pressure (matches the app pressure EMA).' },
  { id: 'speed', label: 'Speed', capability: INPUT_CAPABILITIES.POSITION, smoothing: 0.75, deadzone: 0.02, description: 'Pointer speed normalized against FEATURE_REFERENCES.SPEED_PX_PER_MS.' },
  { id: 'acceleration', label: 'Acceleration', capability: INPUT_CAPABILITIES.POSITION, smoothing: 0.8, deadzone: 0.04, description: 'Magnitude of velocity change per ms.' },
  { id: 'curvature', label: 'Curvature', capability: INPUT_CAPABILITIES.POSITION, smoothing: 0.8, deadzone: 0.04, description: 'Heading change per sample; 1.0 is a hard turn.' },
  { id: 'direction', label: 'Direction', capability: INPUT_CAPABILITIES.POSITION, smoothing: 0.65, deadzone: 0, description: 'Heading mapped to 0..1 over a full turn.' },
  { id: 'tilt', label: 'Tilt', capability: INPUT_CAPABILITIES.TILT, smoothing: 0.7, deadzone: 0, description: 'Tilt magnitude away from vertical (0 = upright).' },
  { id: 'altitude', label: 'Altitude', capability: INPUT_CAPABILITIES.TILT, smoothing: 0.7, deadzone: 0, description: 'Pen altitude; 1.0 = perpendicular to the surface.' },
  { id: 'azimuth', label: 'Azimuth', capability: INPUT_CAPABILITIES.AZIMUTH, smoothing: 0.7, deadzone: 0, description: 'Pen bearing mapped to 0..1 over a full turn.' },
  { id: 'twist', label: 'Twist', capability: INPUT_CAPABILITIES.TWIST, smoothing: 0.7, deadzone: 0, description: 'Barrel rotation mapped to 0..1 over 360°.' },
  { id: 'contactSize', label: 'Contact Size', capability: INPUT_CAPABILITIES.CONTACT, smoothing: 0.7, deadzone: 0, description: 'Touch contact footprint normalized against FEATURE_REFERENCES.CONTACT_PX.' },
  { id: 'touchCount', label: 'Touch Count', capability: INPUT_CAPABILITIES.MULTITOUCH, smoothing: 0, deadzone: 0, description: 'Active touch points normalized against FEATURE_REFERENCES.TOUCH_COUNT.' },
]);

// `smoothing` is the amount of EMA smoothing (0 = raw, 0.95 = very slow), not
// the alpha: the extractor uses `alpha = 1 - smoothing` so the editor slider
// reads left-to-right as "more smoothing".
export const MAX_CHANNEL_SMOOTHING = 0.95;
export const MAX_CHANNEL_DEADZONE = 0.9;

export const FEATURE_CHANNEL_IDS = Object.freeze(FEATURE_CHANNELS.map(channel => channel.id));
const FEATURE_CHANNEL_BY_ID = new Map(FEATURE_CHANNELS.map(channel => [channel.id, channel]));

export function getFeatureChannel(id) {
  return FEATURE_CHANNEL_BY_ID.get(id) || null;
}

// Normalization references. Kept explicit and bounded so a channel value of
// 1.0 always means the same physical thing regardless of device.
export const FEATURE_REFERENCES = Object.freeze({
  SPEED_PX_PER_MS: 1.5,
  ACCELERATION_PX_PER_MS2: 0.02,
  CURVATURE_RAD: Math.PI / 3,
  CONTACT_PX: 40,
  TOUCH_COUNT: 5,
  IDLE_MS: 140,
  RESET_GAP_MS: 250,
});

// ── Curves ──────────────────────────────────────────────────
// Bounded, readable set. Every curve maps 0..1 → 0..1 and is monotonic except
// `bell`, which is documented as a mid-peak shaper.
export const MOD_CURVES = Object.freeze([
  { id: 'linear', label: 'Linear', fn: x => x },
  { id: 'easeIn', label: 'Ease In', fn: x => x * x },
  { id: 'easeOut', label: 'Ease Out', fn: x => 1 - (1 - x) * (1 - x) },
  { id: 'smoothstep', label: 'Smoothstep', fn: x => x * x * (3 - 2 * x) },
  { id: 'sqrt', label: 'Square Root', fn: x => Math.sqrt(x) },
  { id: 'cubic', label: 'Cubic', fn: x => x * x * x },
  { id: 'bell', label: 'Bell (mid peak)', fn: x => 4 * x * (1 - x) },
  { id: 'quantize4', label: 'Quantize 4', fn: x => Math.round(x * 3) / 3 },
  { id: 'gate', label: 'Gate (>= 0.5)', fn: x => x >= 0.5 ? 1 : 0 },
]);

export const MOD_CURVE_IDS = Object.freeze(MOD_CURVES.map(curve => curve.id));
const MOD_CURVE_BY_ID = new Map(MOD_CURVES.map(curve => [curve.id, curve]));

export function applyCurve(curveId, value) {
  const curve = MOD_CURVE_BY_ID.get(curveId) || MOD_CURVE_BY_ID.get('linear');
  return clamp01(curve.fn(clamp01(finite(value, 0))));
}

// ── Combine modes ───────────────────────────────────────────
export const MOD_COMBINE_MODES = Object.freeze([
  { id: 'sum', label: 'Sum (offset)', description: 'Adds amount × span to the base value.' },
  { id: 'mul', label: 'Multiply (gain)', description: 'Scales the target by (1 + amount × signal).' },
  { id: 'max', label: 'Max (winner offset)', description: 'Only the largest-magnitude offset among max routes applies.' },
  { id: 'priority', label: 'Priority (override)', description: 'Highest-priority route replaces every sum/max offset on this target.' },
]);

export const MOD_COMBINE_IDS = Object.freeze(MOD_COMBINE_MODES.map(mode => mode.id));

// ── Condition operators ─────────────────────────────────────
export const MOD_CONDITION_OPS = Object.freeze([
  { id: 'gt', label: '>', arity: 1 },
  { id: 'lt', label: '<', arity: 1 },
  { id: 'between', label: 'between', arity: 2 },
  { id: 'outside', label: 'outside', arity: 2 },
]);

export const MOD_CONDITION_OP_IDS = Object.freeze(MOD_CONDITION_OPS.map(op => op.id));

function _evaluateCondition(condition, features) {
  const value = features[condition.channel];
  if (!Number.isFinite(value)) return false;
  const low = Math.min(condition.value, condition.value2);
  const high = Math.max(condition.value, condition.value2);
  switch (condition.op) {
    case 'gt': return value > condition.value;
    case 'lt': return value < condition.value;
    case 'between': return value >= low && value <= high;
    case 'outside': return value < low || value > high;
    default: return false;
  }
}

// ── Target allowlist (safe target specs) ────────────────────
// Only these ids may ever be written by the modulation framework. Each entry
// names exactly one boid parameter that `sim.writeParams()` consumes, with the
// bounds the sidebar sliders already enforce. There is no path from a preset
// or an imported route to an arbitrary property write.
export const MOD_TARGETS = Object.freeze([
  { id: 'seek', label: 'Seek', section: 'Forces', min: 0, max: 1, integer: false },
  { id: 'cohesion', label: 'Cohesion', section: 'Forces', min: 0, max: 1, integer: false },
  { id: 'separation', label: 'Separation', section: 'Forces', min: 0, max: 1, integer: false },
  { id: 'alignment', label: 'Alignment', section: 'Forces', min: 0, max: 1, integer: false },
  { id: 'jitter', label: 'Jitter', section: 'Forces', min: 0, max: 1, integer: false },
  { id: 'wander', label: 'Wander', section: 'Forces', min: 0, max: 1, integer: false },
  { id: 'wanderSpeed', label: 'Wander Speed', section: 'Forces', min: 0.01, max: 1, integer: false },
  { id: 'flowField', label: 'Flow Field', section: 'Forces', min: 0, max: 1, integer: false },
  { id: 'flowScale', label: 'Flow Scale', section: 'Forces', min: 0.001, max: 0.1, integer: false },
  { id: 'fleeRadius', label: 'Flee Radius', section: 'Forces', min: 0, max: 150, integer: false },
  { id: 'fov', label: 'Field of View', section: 'Forces', min: 30, max: 360, integer: false },
  { id: 'individuality', label: 'Individuality', section: 'Forces', min: 0, max: 1, integer: false },
  { id: 'maxSpeed', label: 'Max Speed', section: 'Motion', min: 0.5, max: 15, integer: false },
  { id: 'damping', label: 'Damping', section: 'Motion', min: 0.8, max: 1, integer: false },
  { id: 'neighborRadius', label: 'Neighbor Radius', section: 'Motion', min: 10, max: 200, integer: false },
  { id: 'separationRadius', label: 'Separation Radius', section: 'Motion', min: 5, max: 100, integer: false },
  { id: 'quorumThreshold', label: 'Quorum Threshold', section: 'Quorum', min: 0, max: 100, integer: true },
  { id: 'quorumCompositeStrength', label: 'Quorum Composite', section: 'Quorum', min: 0, max: 1, integer: false },
  { id: 'sensingStrength', label: 'Sensing Strength', section: 'Sensing', min: 0, max: 1, integer: false },
  { id: 'sensingRadius', label: 'Sensing Radius', section: 'Sensing', min: 5, max: 80, integer: false },
  { id: 'sensingThreshold', label: 'Sensing Threshold', section: 'Sensing', min: 0, max: 1, integer: false },
]);

export const MOD_TARGET_IDS = Object.freeze(MOD_TARGETS.map(target => target.id));
const MOD_TARGET_BY_ID = new Map(MOD_TARGETS.map(target => [target.id, target]));

/** Safe target resolver: returns the frozen spec for an allowlisted boid
 *  parameter, or null. Callers must never write a target this rejects. */
export function resolveModTarget(id) {
  return MOD_TARGET_BY_ID.get(id) || null;
}

// ── Feature extraction (EMA + deadzone + derivatives) ───────

/** Immutable-in/immutable-out feature state. `null` means "no samples yet". */
export function createFeatureState() {
  return {
    hasSample: false,
    lastT: 0,
    lastX: 0,
    lastY: 0,
    lastVx: 0,
    lastVy: 0,
    lastHeading: 0,
    hasHeading: false,
    smoothed: Object.fromEntries(FEATURE_CHANNEL_IDS.map(id => [id, id === 'constant' ? 1 : 0])),
    raw: Object.fromEntries(FEATURE_CHANNEL_IDS.map(id => [id, id === 'constant' ? 1 : 0])),
    capabilities: [],
    sourceId: 'mouse',
  };
}

function _applyDeadzone(value, deadzone) {
  if (!(deadzone > 0)) return clamp01(value);
  const magnitude = clamp01(value);
  if (magnitude <= deadzone) return 0;
  return clamp01((magnitude - deadzone) / (1 - deadzone));
}

function _channelTuning(config, channel) {
  const override = isObject(config) ? config[channel.id] : null;
  return {
    smoothing: clamp(finite(override?.smoothing, channel.smoothing), 0, MAX_CHANNEL_SMOOTHING),
    deadzone: clamp(finite(override?.deadzone, channel.deadzone), 0, MAX_CHANNEL_DEADZONE),
  };
}

/**
 * Pure feature step: (previous state, InputFrame, channel tuning) → next state.
 * Derivatives (speed / acceleration / curvature / direction) come from the
 * position deltas; everything else is a direct normalization of the frame.
 * Never mutates `state`.
 */
export function stepFeatureState(state, inputFrame, channelConfig = {}) {
  const previous = state || createFeatureState();
  const frame = inputFrame && inputFrame.capabilities ? inputFrame : createInputFrame(inputFrame || {});
  const dt = previous.hasSample ? frame.t - previous.lastT : 0;
  const restart = !previous.hasSample || !(dt > 0) || dt > FEATURE_REFERENCES.RESET_GAP_MS;

  const dx = restart ? 0 : frame.x - previous.lastX;
  const dy = restart ? 0 : frame.y - previous.lastY;
  const safeDt = restart ? 1 : Math.max(1, dt);
  const vx = dx / safeDt;
  const vy = dy / safeDt;
  const speedPxMs = Math.hypot(vx, vy);
  const accelPxMs2 = restart ? 0 : Math.hypot(vx - previous.lastVx, vy - previous.lastVy) / safeDt;
  const moved = Math.hypot(dx, dy) > 0.01;
  const heading = moved ? Math.atan2(dy, dx) : previous.lastHeading;
  let headingDelta = 0;
  if (moved && previous.hasHeading && !restart) {
    headingDelta = heading - previous.lastHeading;
    while (headingDelta > Math.PI) headingDelta -= Math.PI * 2;
    while (headingDelta < -Math.PI) headingDelta += Math.PI * 2;
  }

  const twoPi = Math.PI * 2;
  const azimuthTurns = ((frame.azimuth % twoPi) + twoPi) % twoPi / twoPi;
  const contactPx = Math.max(frame.contactWidth, frame.contactHeight);

  const raw = {
    constant: 1,
    pressure: clamp01(frame.pressure),
    speed: clamp01(speedPxMs / FEATURE_REFERENCES.SPEED_PX_PER_MS),
    acceleration: clamp01(accelPxMs2 / FEATURE_REFERENCES.ACCELERATION_PX_PER_MS2),
    curvature: clamp01(Math.abs(headingDelta) / FEATURE_REFERENCES.CURVATURE_RAD),
    direction: (((heading % twoPi) + twoPi) % twoPi) / twoPi,
    tilt: clamp01(Math.hypot(frame.tiltX, frame.tiltY) / 90),
    altitude: clamp01(frame.altitude / (Math.PI / 2)),
    azimuth: azimuthTurns,
    twist: clamp01((((frame.twist % 360) + 360) % 360) / 360),
    contactSize: clamp01(contactPx / FEATURE_REFERENCES.CONTACT_PX),
    touchCount: clamp01(frame.touchCount / FEATURE_REFERENCES.TOUCH_COUNT),
  };

  const smoothed = {};
  for (const channel of FEATURE_CHANNELS) {
    const tuning = _channelTuning(channelConfig, channel);
    const gated = _applyDeadzone(raw[channel.id], tuning.deadzone);
    const previousValue = finite(previous.smoothed[channel.id], gated);
    // `smoothing` is the smoothing *amount* (0 = raw, 0.95 = very slow), so the
    // EMA alpha is its complement and the editor field reads left-to-right as
    // "more smoothing". `restart` snaps, so a new stroke (or one resumed after a
    // gap) never inherits the tail of the previous one.
    const alpha = restart ? 1 : (1 - tuning.smoothing);
    smoothed[channel.id] = clamp01(_smoothChannel(
      previousValue,
      gated,
      alpha,
      CIRCULAR_CHANNEL_IDS.has(channel.id),
    ));
  }
  smoothed.constant = 1;

  return {
    hasSample: true,
    lastT: frame.t,
    lastX: frame.x,
    lastY: frame.y,
    lastVx: vx,
    lastVy: vy,
    lastHeading: heading,
    hasHeading: previous.hasHeading || moved,
    smoothed,
    raw,
    capabilities: frame.capabilities,
    sourceId: frame.sourceId,
  };
}

/**
 * Pure idle decay: motion-derived channels fall back to 0 once samples stop so
 * a parked pointer does not hold a stale speed/acceleration/curvature signal.
 */
export function decayFeatureState(state, elapsedMs) {
  if (!state?.hasSample) return state || createFeatureState();
  const idleFactor = clamp01(1 - Math.max(0, finite(elapsedMs, 0)) / FEATURE_REFERENCES.IDLE_MS);
  if (idleFactor >= 1) return state;
  const smoothed = { ...state.smoothed };
  for (const id of ['speed', 'acceleration', 'curvature']) {
    smoothed[id] = clamp01(finite(smoothed[id], 0) * idleFactor);
  }
  return { ...state, smoothed };
}

/** Read-only view handed to the boid runtime and the channel monitor. */
export function toFeatureFrame(state) {
  const source = state || createFeatureState();
  return {
    sourceId: source.sourceId || 'mouse',
    capabilities: [...(source.capabilities || [])],
    channels: { ...source.smoothed },
    raw: { ...source.raw },
  };
}

/**
 * Stateful convenience wrapper around the pure step/decay functions. The app
 * owns exactly one of these; the boid runtime only reads `frame()`.
 */
export class FeatureTracker {
  constructor() {
    this._state = createFeatureState();
    this._lastSampleWallClock = 0;
  }

  reset({ preserveCapabilities = false } = {}) {
    const capabilities = preserveCapabilities ? [...this._state.capabilities] : [];
    const sourceId = preserveCapabilities ? this._state.sourceId : 'mouse';
    this._state = createFeatureState();
    this._state.capabilities = capabilities;
    this._state.sourceId = sourceId;
    this._lastSampleWallClock = 0;
  }

  /** @param {object} rawFrame InputFrame-shaped sample from an adapter. */
  sample(rawFrame, channelConfig, wallClockMs) {
    const sampleClock = finite(wallClockMs, this._state.lastT);
    if (this._state.hasSample) {
      this._state = decayFeatureState(this._state, sampleClock - this._lastSampleWallClock);
    }
    let frame = createInputFrame(rawFrame);
    if (this._state.hasSample && this._state.sourceId === frame.sourceId) {
      frame = createInputFrame({
        ...frame,
        capabilities: [...new Set([...this._state.capabilities, ...frame.capabilities])],
      });
    }
    this._state = stepFeatureState(this._state, frame, channelConfig);
    this._lastSampleWallClock = sampleClock;
    return this._state;
  }

  frame(wallClockMs) {
    if (!this._state.hasSample) return toFeatureFrame(this._state);
    const elapsed = Number.isFinite(wallClockMs) ? wallClockMs - this._lastSampleWallClock : 0;
    return toFeatureFrame(decayFeatureState(this._state, elapsed));
  }
}

// ── Matrix normalization (versioned, backward compatible) ───

const DEFAULT_ROUTE = Object.freeze({
  enabled: true,
  source: 'pressure',
  target: 'cohesion',
  amount: 0,
  curve: 'linear',
  invert: false,
  clampMin: 0,
  clampMax: 1,
  combine: 'sum',
  priority: 0,
  conditions: [],
});

// Legacy shape written by the first fixed six-field implementation:
// { cohesion: { enabled, source: 'pressure'|'velocity', depth } , ... }
const LEGACY_FIELD_KEYS = Object.freeze(['cohesion', 'separation', 'alignment', 'seek', 'wander', 'maxSpeed']);
const LEGACY_SOURCE_MAP = Object.freeze({ pressure: 'pressure', velocity: 'speed' });

export function createModRoute(partial = {}, index = 0) {
  return normalizeModRoute(partial, index).route;
}

function _normalizeConditions(candidate) {
  const conditions = [];
  const dropped = [];
  for (const raw of Array.isArray(candidate) ? candidate.slice(0, 4) : []) {
    if (!isObject(raw)) { dropped.push('condition:not-an-object'); continue; }
    const channel = FEATURE_CHANNEL_BY_ID.has(raw.channel) ? raw.channel : '';
    if (!channel) { dropped.push(`condition:channel:${String(raw.channel)}`); continue; }
    const op = MOD_CONDITION_OP_IDS.includes(raw.op) ? raw.op : 'gt';
    conditions.push({
      channel,
      op,
      value: clamp01(finite(raw.value, 0.5)),
      value2: clamp01(finite(raw.value2, 1)),
    });
  }
  return { conditions, dropped };
}

export function normalizeModRoute(candidate, index = 0) {
  const dropped = [];
  // Garbage entries are dropped outright rather than materialized as inert
  // default routes, so a corrupted import cannot pad the editor with noise.
  if (!isObject(candidate)) {
    return { route: { ...DEFAULT_ROUTE, id: `r${index + 1}` }, dropped: ['route:not-an-object'], unresolvedTarget: true };
  }
  const source = FEATURE_CHANNEL_BY_ID.has(candidate.source) ? candidate.source : DEFAULT_ROUTE.source;
  if (candidate.source !== undefined && source !== candidate.source) dropped.push(`source:${String(candidate.source)}`);
  const target = MOD_TARGET_BY_ID.has(candidate.target) ? candidate.target : '';
  if (!target) dropped.push(`target:${String(candidate.target)}`);
  const curve = MOD_CURVE_IDS.includes(candidate.curve) ? candidate.curve : DEFAULT_ROUTE.curve;
  if (candidate.curve !== undefined && curve !== candidate.curve) dropped.push(`curve:${String(candidate.curve)}`);
  const combine = MOD_COMBINE_IDS.includes(candidate.combine) ? candidate.combine : DEFAULT_ROUTE.combine;
  if (candidate.combine !== undefined && combine !== candidate.combine) dropped.push(`combine:${String(candidate.combine)}`);
  const conditionResult = _normalizeConditions(candidate.conditions);
  dropped.push(...conditionResult.dropped);
  const clampMin = clamp01(finite(candidate.clampMin, DEFAULT_ROUTE.clampMin));
  const clampMax = clamp01(finite(candidate.clampMax, DEFAULT_ROUTE.clampMax));
  const rawId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || `r${index + 1}`;
  if (rawId && id !== rawId) dropped.push('id:sanitized');
  return {
    route: {
      id,
      enabled: candidate.enabled !== false,
      source,
      target: target || DEFAULT_ROUTE.target,
      amount: clamp(finite(candidate.amount, DEFAULT_ROUTE.amount), -1, 1),
      curve,
      invert: !!candidate.invert,
      clampMin: Math.min(clampMin, clampMax),
      clampMax: Math.max(clampMin, clampMax),
      combine,
      priority: clamp(Math.round(finite(candidate.priority, 0)), -99, 99),
      conditions: conditionResult.conditions,
    },
    dropped,
    unresolvedTarget: !target && candidate.target !== undefined,
  };
}

function _normalizeChannelConfig(candidate) {
  const channels = {};
  if (!isObject(candidate)) return channels;
  for (const channel of FEATURE_CHANNELS) {
    const raw = candidate[channel.id];
    if (!isObject(raw)) continue;
    const smoothing = clamp(finite(raw.smoothing, channel.smoothing), 0, MAX_CHANNEL_SMOOTHING);
    const deadzone = clamp(finite(raw.deadzone, channel.deadzone), 0, MAX_CHANNEL_DEADZONE);
    // Only persist genuine deviations so exported presets stay small and the
    // built-in defaults keep improving for existing documents.
    if (smoothing !== channel.smoothing || deadzone !== channel.deadzone) {
      channels[channel.id] = { smoothing, deadzone };
    }
  }
  return channels;
}

function _routesFromLegacyFields(candidate) {
  const routes = [];
  for (const key of LEGACY_FIELD_KEYS) {
    const legacy = candidate[key];
    if (!isObject(legacy)) continue;
    const depth = finite(legacy.depth, 0);
    if (!legacy.enabled || !depth) continue;
    routes.push({
      source: LEGACY_SOURCE_MAP[legacy.source] || 'pressure',
      target: key,
      amount: clamp(depth, -1, 1),
      // The legacy runtime did `value *= (1 + depth * signal)` — that is
      // exactly the `mul` combine mode, so migrated routes sound identical.
      combine: 'mul',
      curve: 'linear',
    });
  }
  return routes;
}

export function emptyModMatrix() {
  return { format: MOD_MATRIX_FORMAT, version: MOD_MATRIX_VERSION, routes: [], channels: {} };
}

/**
 * Accepts: a modMatrix.v1 document, a bare route array, the legacy fixed
 * six-field object, or anything unrecognized (→ empty matrix). Never throws
 * and never returns a route that points at a non-allowlisted target.
 */
export function normalizeModMatrix(candidate) {
  return normalizeModMatrixWithReport(candidate).matrix;
}

export function normalizeModMatrixWithReport(candidate) {
  const dropped = [];
  if (candidate == null) return { matrix: emptyModMatrix(), dropped };
  let rawRoutes = [];
  let rawChannels = null;
  if (Array.isArray(candidate)) {
    rawRoutes = candidate;
  } else if (isObject(candidate)) {
    if (candidate.format && candidate.format !== MOD_MATRIX_FORMAT) {
      dropped.push(`format:${String(candidate.format)}`);
      return { matrix: emptyModMatrix(), dropped };
    }
    if (candidate.format === MOD_MATRIX_FORMAT && finite(candidate.version, 1) > MOD_MATRIX_VERSION) {
      dropped.push(`version:${String(candidate.version)}`);
      return { matrix: emptyModMatrix(), dropped };
    }
    if (Array.isArray(candidate.routes)) {
      rawRoutes = candidate.routes;
      rawChannels = candidate.channels;
    } else if (LEGACY_FIELD_KEYS.some(key => isObject(candidate[key]))) {
      rawRoutes = _routesFromLegacyFields(candidate);
      dropped.push('migrated:legacy-six-field');
    }
  } else {
    dropped.push(`root:${typeof candidate}`);
    return { matrix: emptyModMatrix(), dropped };
  }

  const routes = [];
  const usedIds = new Set();
  for (const raw of rawRoutes.slice(0, 64)) {
    const result = normalizeModRoute(raw, routes.length);
    if (result.unresolvedTarget) {
      dropped.push(...result.dropped);
      continue;
    }
    let id = result.route.id;
    let suffix = 2;
    while (usedIds.has(id)) id = `${result.route.id}-${suffix++}`;
    usedIds.add(id);
    routes.push({ ...result.route, id });
    dropped.push(...result.dropped);
  }
  return {
    matrix: {
      format: MOD_MATRIX_FORMAT,
      version: MOD_MATRIX_VERSION,
      routes,
      channels: _normalizeChannelConfig(rawChannels),
    },
    dropped,
  };
}

export function serializeModMatrix(matrix) {
  const normalized = normalizeModMatrix(matrix);
  // Empty matrices serialize to a short, stable string so untouched documents
  // do not churn presets or the workspace autosave payload.
  return JSON.stringify(normalized);
}

/**
 * Parse the hidden JSON control. `strict` surfaces syntax errors to the route
 * editor; the default (non-strict) path is what `getP()` uses and can never
 * throw, so a corrupted document degrades to "no modulation" instead of
 * breaking the brush.
 */
export function parseModMatrix(text, { strict = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) return emptyModMatrix();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (strict) throw new Error(`Modulation matrix is not valid JSON: ${error.message}`);
    return emptyModMatrix();
  }
  return normalizeModMatrix(parsed);
}

export function isEmptyModMatrix(matrix) {
  return !matrix?.routes?.length && !Object.keys(matrix?.channels || {}).length;
}

/**
 * Value written into the single hidden `boidModMatrix` control. A default
 * matrix serializes to the empty string so untouched documents keep producing
 * byte-identical presets, workspace autosaves, and session payloads.
 */
export function modMatrixToControlValue(matrix) {
  const normalized = normalizeModMatrix(matrix);
  return isEmptyModMatrix(normalized) ? '' : serializeModMatrix(normalized);
}

// ── Deterministic evaluation ────────────────────────────────

/**
 * Deterministic ordering: higher priority first, then original document order.
 * Route ids never participate in ordering so importing a preset cannot reorder
 * evaluation just because ids were regenerated.
 */
function _orderedRoutes(routes) {
  return routes
    .map((route, index) => ({ route, index }))
    .sort((a, b) => (b.route.priority - a.route.priority) || (a.index - b.index))
    .map(entry => entry.route);
}

/**
 * Capability-aware, base-value-free evaluation.
 *
 * Returns per-target instructions in *normalized span units* so the caller can
 * apply them to whatever base value it actually holds (brush params, or the
 * simulation-var overrides in `_applySimVars`). This keeps evaluation a pure
 * function of (matrix, features, capabilities).
 *
 * @returns {{targets: Object, diagnostics: {routes: Array, active: number, skipped: number}}}
 */
export function evaluateModMatrix({ matrix, features, capabilities } = {}) {
  // Always normalize: evaluation must never trust hand-built or imported
  // route objects, so the allowlist and the value clamps apply unconditionally.
  const normalized = normalizeModMatrix(matrix);
  const channels = isObject(features) ? features : {};
  const available = new Set(Array.isArray(capabilities) ? capabilities : []);
  const targets = {};
  const routeReports = [];
  let active = 0;
  let skipped = 0;

  for (const route of _orderedRoutes(normalized.routes)) {
    const spec = resolveModTarget(route.target);
    const channel = getFeatureChannel(route.source);
    const report = {
      id: route.id,
      target: route.target,
      source: route.source,
      combine: route.combine,
      priority: route.priority,
      applied: false,
      reason: '',
      signal: 0,
      contribution: 0,
    };
    if (!route.enabled) { report.reason = 'disabled'; routeReports.push(report); skipped++; continue; }
    if (!spec) { report.reason = 'target-not-allowlisted'; routeReports.push(report); skipped++; continue; }
    if (!channel) { report.reason = 'unknown-channel'; routeReports.push(report); skipped++; continue; }
    if (channel.capability && !available.has(channel.capability)) {
      report.reason = `missing-capability:${channel.capability}`;
      routeReports.push(report);
      skipped++;
      continue;
    }
    // Conditions fail closed: a gate we cannot evaluate never opens.
    const gateChannelMissing = route.conditions.some(condition => {
      const conditionChannel = getFeatureChannel(condition.channel);
      return conditionChannel?.capability && !available.has(conditionChannel.capability);
    });
    if (gateChannelMissing) {
      report.reason = 'condition-capability-missing';
      routeReports.push(report);
      skipped++;
      continue;
    }
    if (!route.conditions.every(condition => _evaluateCondition(condition, channels))) {
      report.reason = 'condition-false';
      routeReports.push(report);
      skipped++;
      continue;
    }

    const signal = clamp01(finite(channels[route.source], 0));
    const shaped = applyCurve(route.curve, signal);
    const oriented = route.invert ? 1 - shaped : shaped;
    const contribution = clamp(route.amount * oriented, -1, 1);
    report.signal = signal;
    report.contribution = contribution;

    const bucket = targets[route.target] || (targets[route.target] = {
      target: route.target,
      sumOffsetNorm: 0,
      maxOffsetNorm: 0,
      hasMax: false,
      priorityOffsetNorm: 0,
      hasPriority: false,
      gain: 1,
      clampMin: 0,
      clampMax: 1,
      routeIds: [],
    });

    if (route.combine === 'priority') {
      if (bucket.hasPriority) {
        report.reason = 'priority-outranked';
        routeReports.push(report);
        skipped++;
        continue;
      }
      bucket.hasPriority = true;
      bucket.priorityOffsetNorm = contribution;
    } else if (route.combine === 'mul') {
      bucket.gain *= (1 + contribution);
    } else if (route.combine === 'max') {
      if (!bucket.hasMax || Math.abs(contribution) > Math.abs(bucket.maxOffsetNorm)) {
        bucket.maxOffsetNorm = contribution;
      }
      bucket.hasMax = true;
    } else {
      bucket.sumOffsetNorm += contribution;
    }

    // Per-route clamps intersect: the narrowest window on a target wins, so a
    // safety clamp can never be widened by adding another route.
    bucket.clampMin = Math.max(bucket.clampMin, route.clampMin);
    bucket.clampMax = Math.min(bucket.clampMax, route.clampMax);
    bucket.routeIds.push(route.id);
    report.applied = true;
    routeReports.push(report);
    active++;
  }

  for (const bucket of Object.values(targets)) {
    bucket.offsetNorm = bucket.hasPriority
      ? bucket.priorityOffsetNorm
      : bucket.sumOffsetNorm + (bucket.hasMax ? bucket.maxOffsetNorm : 0);
    if (bucket.clampMin > bucket.clampMax) {
      // Contradictory clamps collapse to a single value rather than inverting.
      bucket.clampMax = bucket.clampMin;
    }
  }

  return { targets, diagnostics: { routes: routeReports, active, skipped } };
}

/**
 * Safe application step. Writes *only* allowlisted target ids onto `params`,
 * clamped to the target spec and to the intersected per-route clamp window.
 * Mutates and returns `params` (callers pass their own working copy), plus an
 * `applied` map for diagnostics.
 */
export function applyModTargets(params, evaluation) {
  const applied = {};
  if (!params || !evaluation?.targets) return { params, applied };
  for (const [targetId, bucket] of Object.entries(evaluation.targets)) {
    const spec = resolveModTarget(targetId);
    if (!spec) continue;
    const base = params[targetId];
    if (!Number.isFinite(base)) continue;
    const span = spec.max - spec.min;
    const windowMin = spec.min + bucket.clampMin * span;
    const windowMax = spec.min + bucket.clampMax * span;
    let value = (base + bucket.offsetNorm * span) * bucket.gain;
    value = clamp(value, Math.min(windowMin, windowMax), Math.max(windowMin, windowMax));
    value = clamp(value, spec.min, spec.max);
    if (spec.integer) value = Math.round(value);
    params[targetId] = value;
    applied[targetId] = { base, value, offsetNorm: bucket.offsetNorm, gain: bucket.gain, routeIds: [...bucket.routeIds] };
  }
  return { params, applied };
}

/** Compact one-line summary for the boid status bar / HUD. */
export function summarizeModulation(applied, { limit = 3 } = {}) {
  const entries = Object.entries(applied || {});
  if (!entries.length) return '';
  const parts = entries.slice(0, limit).map(([id, info]) => {
    const spec = resolveModTarget(id);
    const digits = spec && (spec.max - spec.min) > 20 ? 0 : 2;
    return `${id} ${info.value.toFixed(digits)}`;
  });
  if (entries.length > limit) parts.push(`+${entries.length - limit}`);
  return parts.join(', ');
}
