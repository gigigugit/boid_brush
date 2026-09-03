/**
 * Focused unit tests for the boid input-modulation core.
 *
 * Run with Node's built-in runner (no dependencies):  npm test
 *
 * The module under test is deliberately pure and DOM-free, so everything here
 * exercises real production code paths rather than mocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOD_MATRIX_FORMAT,
  MOD_MATRIX_VERSION,
  INPUT_CAPABILITIES,
  MOD_TARGET_IDS,
  FEATURE_REFERENCES,
  createInputFrame,
  getInputSource,
  registerInputSource,
  listInputSources,
  getFeatureChannel,
  applyCurve,
  resolveModTarget,
  createFeatureState,
  stepFeatureState,
  decayFeatureState,
  toFeatureFrame,
  FeatureTracker,
  createModRoute,
  normalizeModMatrix,
  normalizeModMatrixWithReport,
  emptyModMatrix,
  parseModMatrix,
  serializeModMatrix,
  isEmptyModMatrix,
  modMatrixToControlValue,
  evaluateModMatrix,
  applyModTargets,
  summarizeModulation,
} from '../boid-input-modulation.js';

const ALL_CAPS = Object.values(INPUT_CAPABILITIES);

/** Build a one-route matrix without going through the editor. */
const matrixOf = (...routes) => ({
  format: MOD_MATRIX_FORMAT,
  version: MOD_MATRIX_VERSION,
  routes: routes.map((route, index) => createModRoute(route, index)),
  channels: {},
});

/** Evaluate + apply in one step against a synthetic base param set.
 *  Real FeatureFrames always carry `constant: 1` (see `toFeatureFrame`), so the
 *  helper seeds it rather than making every case restate it. */
function run(matrix, { params, features = {}, capabilities = ALL_CAPS }) {
  const evaluation = evaluateModMatrix({ matrix, features: { constant: 1, ...features }, capabilities });
  const result = applyModTargets({ ...params }, evaluation);
  return { evaluation, ...result };
}

// ── Source registry / InputFrame ───────────────────────────────────────────

test('input source registry exposes built-ins and accepts new sources', () => {
  assert.equal(getInputSource('pen').label, 'Stylus / Apple Pencil');
  // Unknown ids fall back to mouse rather than returning undefined.
  assert.equal(getInputSource('nope').id, 'mouse');
  registerInputSource({ id: 'midi-pad', label: 'MIDI Pad', capabilities: [INPUT_CAPABILITIES.PRESSURE] });
  assert.equal(getInputSource('midi-pad').label, 'MIDI Pad');
  assert.ok(listInputSources().some(source => source.id === 'midi-pad'));
});

test('createInputFrame derives capabilities only from fields actually reported', () => {
  const mouse = createInputFrame({ sourceId: 'mouse', t: 0, x: 10, y: 10 });
  assert.deepEqual([...mouse.capabilities], [INPUT_CAPABILITIES.POSITION]);

  const pencil = createInputFrame({
    sourceId: 'pen', t: 0, x: 0, y: 0, pressure: 0.5, tiltX: 30, tiltY: 0, azimuth: 1, twist: 90,
  });
  for (const capability of ['position', 'pressure', 'tilt', 'azimuth', 'twist']) {
    assert.ok(pencil.capabilities.includes(capability), `expected ${capability}`);
  }
  assert.ok(!pencil.capabilities.includes(INPUT_CAPABILITIES.MULTITOUCH));

  // Out-of-range values are bounded, not trusted.
  const wild = createInputFrame({ x: 0, y: 0, pressure: 12, tiltX: 400, altitude: -5 });
  assert.equal(wild.pressure, 1);
  assert.equal(wild.tiltX, 90);
  assert.equal(wild.altitude, 0);
});

// ── Feature extraction ─────────────────────────────────────────────────────

test('stepFeatureState normalizes speed against the documented reference', () => {
  const config = { speed: { smoothing: 0, deadzone: 0 } };
  let state = stepFeatureState(createFeatureState(), createInputFrame({ sourceId: 'mouse', t: 0, x: 0, y: 0 }), config);
  // Move exactly SPEED_PX_PER_MS px in 1 ms → channel should read 1.0.
  state = stepFeatureState(state, createInputFrame({ sourceId: 'mouse', t: 1, x: FEATURE_REFERENCES.SPEED_PX_PER_MS, y: 0 }), config);
  assert.equal(state.smoothed.speed, 1);
  // Half the reference speed → 0.5.
  state = stepFeatureState(state, createInputFrame({ sourceId: 'mouse', t: 2, x: FEATURE_REFERENCES.SPEED_PX_PER_MS * 1.5, y: 0 }), config);
  assert.ok(Math.abs(state.smoothed.speed - 0.5) < 1e-9);
});

test('stepFeatureState restarts (does not spike) after a long sample gap', () => {
  const config = { speed: { smoothing: 0, deadzone: 0 } };
  let state = stepFeatureState(createFeatureState(), createInputFrame({ t: 0, x: 0, y: 0 }), config);
  state = stepFeatureState(state, createInputFrame({ t: 5, x: 6, y: 0 }), config);
  assert.ok(state.smoothed.speed > 0);
  // A gap beyond RESET_GAP_MS must be treated as a new stroke: zero derivative.
  state = stepFeatureState(state, createInputFrame({ t: 5 + FEATURE_REFERENCES.RESET_GAP_MS + 50, x: 9999, y: 0 }), config);
  assert.equal(state.smoothed.speed, 0);
  assert.equal(state.smoothed.acceleration, 0);
});

test('deadzone rescales rather than merely thresholding', () => {
  const config = { pressure: { smoothing: 0, deadzone: 0.5 } };
  let state = stepFeatureState(createFeatureState(), createInputFrame({ t: 0, x: 0, y: 0, pressure: 0.4 }), config);
  assert.equal(state.smoothed.pressure, 0, 'below the deadzone reads as silence');
  state = stepFeatureState(state, createInputFrame({ t: 16, x: 0, y: 0, pressure: 0.75 }), config);
  assert.ok(Math.abs(state.smoothed.pressure - 0.5) < 1e-9, 'above the deadzone rescales to full 0..1');
});

test('EMA smoothing uses the complement of the smoothing amount', () => {
  const config = { pressure: { smoothing: 0.75, deadzone: 0 } };
  let state = stepFeatureState(createFeatureState(), createInputFrame({ t: 0, x: 0, y: 0, pressure: 0 }), config);
  // First sample snaps (restart), so seed from 0 and take one more step.
  state = stepFeatureState(state, createInputFrame({ t: 16, x: 0, y: 0, pressure: 1 }), config);
  // alpha = 1 - 0.75 = 0.25 → 0 + (1 - 0) * 0.25
  assert.ok(Math.abs(state.smoothed.pressure - 0.25) < 1e-9);
});

test('decayFeatureState bleeds motion channels toward zero while idle', () => {
  const config = { speed: { smoothing: 0, deadzone: 0 } };
  let state = stepFeatureState(createFeatureState(), createInputFrame({ t: 0, x: 0, y: 0 }), config);
  state = stepFeatureState(state, createInputFrame({ t: 1, x: FEATURE_REFERENCES.SPEED_PX_PER_MS, y: 0 }), config);
  assert.equal(state.smoothed.speed, 1);
  const halfway = decayFeatureState(state, FEATURE_REFERENCES.IDLE_MS / 2);
  assert.ok(Math.abs(halfway.smoothed.speed - 0.5) < 1e-9);
  const parked = decayFeatureState(state, FEATURE_REFERENCES.IDLE_MS * 4);
  assert.equal(parked.smoothed.speed, 0);
  assert.equal(state.smoothed.speed, 1, 'decay must not mutate the input state');
});

test('FeatureTracker produces a hardware-independent FeatureFrame', () => {
  const tracker = new FeatureTracker();
  tracker.sample({ sourceId: 'pen', t: 0, x: 0, y: 0, pressure: 0.6, tiltX: 0, tiltY: 0 }, {}, 0);
  const frame = tracker.frame(0);
  assert.equal(frame.sourceId, 'pen');
  assert.ok(frame.capabilities.includes(INPUT_CAPABILITIES.PRESSURE));
  assert.equal(frame.channels.constant, 1);
  // The frame is a copy: the runtime cannot reach back into tracker state.
  frame.channels.pressure = 999;
  assert.notEqual(tracker.frame(0).channels.pressure, 999);
});

test('toFeatureFrame of a fresh state is safe to consume', () => {
  const frame = toFeatureFrame(createFeatureState());
  assert.equal(frame.channels.constant, 1);
  assert.equal(frame.channels.pressure, 0);
  assert.deepEqual(frame.capabilities, []);
});

// ── Normalization / versioning / backward compatibility ────────────────────

test('normalizeModMatrix migrates the legacy fixed six-field object', () => {
  const { matrix, dropped } = normalizeModMatrixWithReport({
    cohesion: { enabled: true, source: 'velocity', depth: 0.5 },
    separation: { enabled: true, source: 'pressure', depth: -0.25 },
    wander: { enabled: false, source: 'pressure', depth: 0.9 },
    maxSpeed: { enabled: true, source: 'pressure', depth: 0 },
  });
  assert.ok(dropped.includes('migrated:legacy-six-field'));
  assert.equal(matrix.routes.length, 2, 'disabled and zero-depth fields migrate to nothing');
  const cohesion = matrix.routes.find(route => route.target === 'cohesion');
  assert.equal(cohesion.source, 'speed', "legacy 'velocity' maps to the speed channel");
  assert.equal(cohesion.amount, 0.5);
  assert.equal(cohesion.combine, 'mul', 'legacy depth math is exactly the mul combine mode');
  assert.equal(matrix.routes.find(route => route.target === 'separation').amount, -0.25);
});

test('normalization refuses non-allowlisted targets and unknown enum values', () => {
  const { matrix, dropped } = normalizeModMatrixWithReport({
    format: MOD_MATRIX_FORMAT,
    version: 1,
    routes: [
      { id: 'evil', target: '__proto__', amount: 1 },
      { id: 'evil2', target: 'constructor', amount: 1 },
      { id: 'evil3', target: 'brushSize', amount: 1 },
      { id: 'ok', target: 'seek', source: 'nope', curve: 'nope', combine: 'nope', amount: 5, priority: 1e9 },
    ],
  });
  assert.equal(matrix.routes.length, 1);
  const route = matrix.routes[0];
  assert.equal(route.target, 'seek');
  assert.equal(route.source, 'pressure', 'unknown channel falls back to the default');
  assert.equal(route.curve, 'linear');
  assert.equal(route.combine, 'sum');
  assert.equal(route.amount, 1, 'amount is clamped to -1..1');
  assert.equal(route.priority, 99, 'priority is bounded');
  for (const reason of ['target:__proto__', 'target:constructor', 'target:brushSize']) {
    assert.ok(dropped.includes(reason), `expected drop report ${reason}`);
  }
  for (const normalizedRoute of matrix.routes) {
    assert.ok(MOD_TARGET_IDS.includes(normalizedRoute.target));
  }
});

test('normalization rejects foreign formats and future versions', () => {
  assert.deepEqual(normalizeModMatrix({ format: 'modMatrix.v2', routes: [{ target: 'seek', amount: 1 }] }).routes, []);
  assert.deepEqual(normalizeModMatrix({ format: MOD_MATRIX_FORMAT, version: 99, routes: [{ target: 'seek', amount: 1 }] }).routes, []);
  // ...but a v1 document without an explicit version is accepted.
  assert.equal(normalizeModMatrix({ format: MOD_MATRIX_FORMAT, routes: [{ target: 'seek', amount: 1 }] }).routes.length, 1);
});

test('normalization never throws on hostile or malformed input', () => {
  for (const candidate of [null, undefined, 4, 'nope', true, [], [null, 3, 'x'], { routes: 'nope' }, { routes: [null] }]) {
    const matrix = normalizeModMatrix(candidate);
    assert.equal(matrix.format, MOD_MATRIX_FORMAT);
    assert.ok(Array.isArray(matrix.routes));
  }
});

test('duplicate route ids are made unique so diagnostics stay addressable', () => {
  const matrix = normalizeModMatrix({
    routes: [
      { id: 'dup', target: 'seek', amount: 0.1 },
      { id: 'dup', target: 'cohesion', amount: 0.1 },
    ],
  });
  assert.equal(matrix.routes.length, 2);
  assert.notEqual(matrix.routes[0].id, matrix.routes[1].id);
});

test('route ids are safe for use by the DOM route editor', () => {
  const { matrix, dropped } = normalizeModMatrixWithReport({
    routes: [{ id: '"><img src=x onerror=alert(1)>', target: 'seek', amount: 0.1 }],
  });
  assert.match(matrix.routes[0].id, /^[a-zA-Z0-9_-]+$/);
  assert.ok(dropped.includes('id:sanitized'));
});

test('channel overrides persist only genuine deviations from the defaults', () => {
  const defaults = getFeatureChannel('pressure');
  const matrix = normalizeModMatrix({
    routes: [],
    channels: {
      pressure: { smoothing: defaults.smoothing, deadzone: defaults.deadzone },
      speed: { smoothing: 0.9, deadzone: 0.1 },
      nonsense: { smoothing: 0.5 },
    },
  });
  assert.ok(!('pressure' in matrix.channels), 'default-valued overrides are not persisted');
  assert.ok(!('nonsense' in matrix.channels), 'unknown channels are dropped');
  assert.deepEqual(matrix.channels.speed, { smoothing: 0.9, deadzone: 0.1 });
});

test('channel overrides are clamped to the documented maxima', () => {
  const matrix = normalizeModMatrix({ routes: [], channels: { speed: { smoothing: 99, deadzone: 99 } } });
  assert.ok(matrix.channels.speed.smoothing <= 0.95);
  assert.ok(matrix.channels.speed.deadzone <= 0.9);
});

// ── Serialization ──────────────────────────────────────────────────────────

test('parseModMatrix never throws unless strict is requested', () => {
  assert.deepEqual(parseModMatrix('not json').routes, []);
  assert.deepEqual(parseModMatrix('').routes, []);
  assert.deepEqual(parseModMatrix(undefined).routes, []);
  assert.throws(() => parseModMatrix('{oops', { strict: true }), /not valid JSON/);
});

test('a default matrix serializes to the empty control value', () => {
  assert.ok(isEmptyModMatrix(emptyModMatrix()));
  assert.equal(modMatrixToControlValue(emptyModMatrix()), '');
  assert.equal(modMatrixToControlValue(null), '', 'untouched documents stay byte-identical in presets');
  assert.equal(modMatrixToControlValue({ routes: [], channels: {} }), '');
});

test('control value round-trips through parse without drift', () => {
  const matrix = matrixOf(
    { id: 'a', source: 'twist', target: 'wander', amount: 0.4, curve: 'smoothstep', combine: 'max', priority: 3 },
    { id: 'b', source: 'tilt', target: 'maxSpeed', amount: -0.2, invert: true, clampMin: 0.2, clampMax: 0.8 },
  );
  const encoded = modMatrixToControlValue(matrix);
  assert.notEqual(encoded, '');
  assert.equal(modMatrixToControlValue(parseModMatrix(encoded)), encoded);
  assert.equal(serializeModMatrix(parseModMatrix(encoded)), serializeModMatrix(matrix));
});

// ── Curves ─────────────────────────────────────────────────────────────────

test('curves stay bounded and unknown curve ids fall back to linear', () => {
  assert.equal(applyCurve('linear', 0.25), 0.25);
  assert.equal(applyCurve('easeIn', 0.5), 0.25);
  assert.equal(applyCurve('sqrt', 0.25), 0.5);
  assert.equal(applyCurve('gate', 0.49), 0);
  assert.equal(applyCurve('gate', 0.5), 1);
  assert.equal(applyCurve('quantize4', 0.5), 2 / 3);
  assert.equal(applyCurve('bell', 0.5), 1);
  assert.equal(applyCurve('nope', 0.3), 0.3);
  assert.equal(applyCurve('linear', 9), 1, 'inputs are clamped before shaping');
  assert.equal(applyCurve('linear', NaN), 0);
});

// ── Evaluation: combine modes ──────────────────────────────────────────────

test('sum combine adds amount x span to the base value', () => {
  // seek spans 0..2, so amount 0.25 with a full-scale signal shifts by +0.5.
  const { params } = run(matrixOf({ source: 'constant', target: 'seek', amount: 0.25, combine: 'sum' }), {
    params: { seek: 1 },
  });
  assert.ok(Math.abs(params.seek - 1.5) < 1e-9);
});

test('sum combine accumulates across routes', () => {
  const { params } = run(matrixOf(
    { source: 'constant', target: 'seek', amount: 0.1, combine: 'sum' },
    { source: 'constant', target: 'seek', amount: 0.15, combine: 'sum' },
  ), { params: { seek: 1 } });
  assert.ok(Math.abs(params.seek - 1.5) < 1e-9);
});

test('mul combine scales the target by (1 + contribution)', () => {
  const { params } = run(matrixOf({ source: 'constant', target: 'seek', amount: 0.5, combine: 'mul' }), {
    params: { seek: 1 },
  });
  assert.ok(Math.abs(params.seek - 1.5) < 1e-9);
});

test('max combine keeps only the largest-magnitude contribution', () => {
  const { params } = run(matrixOf(
    { source: 'constant', target: 'seek', amount: 0.1, combine: 'max' },
    { source: 'constant', target: 'seek', amount: 0.3, combine: 'max' },
    { source: 'constant', target: 'seek', amount: 0.2, combine: 'max' },
  ), { params: { seek: 1 } });
  assert.ok(Math.abs(params.seek - 1.6) < 1e-9, 'only 0.3 x span applies');
});

test('priority combine replaces sum/max offsets and outranks later priority routes', () => {
  const { params, evaluation } = run(matrixOf(
    { id: 'sum', source: 'constant', target: 'seek', amount: 0.5, combine: 'sum', priority: 0 },
    { id: 'hi', source: 'constant', target: 'seek', amount: -0.25, combine: 'priority', priority: 10 },
    { id: 'lo', source: 'constant', target: 'seek', amount: 0.9, combine: 'priority', priority: 5 },
  ), { params: { seek: 1.5 } });
  assert.ok(Math.abs(params.seek - 1.0) < 1e-9, 'only the winning priority offset applies');
  const outranked = evaluation.diagnostics.routes.find(report => report.id === 'lo');
  assert.equal(outranked.applied, false);
  assert.equal(outranked.reason, 'priority-outranked');
});

test('evaluation order is priority descending, then document order', () => {
  const { evaluation } = run(matrixOf(
    { id: 'first', source: 'constant', target: 'seek', amount: 0.1, priority: 0 },
    { id: 'second', source: 'constant', target: 'cohesion', amount: 0.1, priority: 0 },
    { id: 'top', source: 'constant', target: 'alignment', amount: 0.1, priority: 7 },
  ), { params: { seek: 1, cohesion: 1, alignment: 1 } });
  assert.deepEqual(evaluation.diagnostics.routes.map(report => report.id), ['top', 'first', 'second']);
});

// ── Evaluation: curve, invert, clamps, conditions, capabilities ────────────

test('invert and curve shape the signal before the amount is applied', () => {
  const features = { pressure: 0.25 };
  // sqrt(0.25) = 0.5; invert → 0.5; amount 1 → +0.5 span on seek (span 2) = +1.
  const { params } = run(matrixOf({ source: 'pressure', target: 'seek', amount: 1, curve: 'sqrt', invert: true }), {
    params: { seek: 0.5 }, features,
  });
  assert.ok(Math.abs(params.seek - 1.5) < 1e-9);
});

test('per-route clamps intersect to the narrowest window on a target', () => {
  // seek spans 0..2 → clamp 0.25..0.6 means an absolute window of 0.5..1.2.
  const { params } = run(matrixOf(
    { source: 'constant', target: 'seek', amount: 0.9, clampMin: 0.25, clampMax: 0.75 },
    { source: 'constant', target: 'seek', amount: 0, clampMin: 0.1, clampMax: 0.6 },
  ), { params: { seek: 1 } });
  assert.ok(Math.abs(params.seek - 1.2) < 1e-9, 'a safety clamp cannot be widened by adding a route');
});

test('contradictory clamps collapse to a value instead of inverting', () => {
  const { params } = run(matrixOf(
    { source: 'constant', target: 'seek', amount: 1, clampMin: 0.8, clampMax: 1 },
    { source: 'constant', target: 'seek', amount: 0, clampMin: 0, clampMax: 0.2 },
  ), { params: { seek: 1 } });
  assert.ok(Math.abs(params.seek - 1.6) < 1e-9, 'window collapses to clampMin (0.8 of the 0..2 span)');
});

test('routes are skipped when the device did not report the channel capability', () => {
  const { evaluation, params } = run(matrixOf({ id: 'tw', source: 'twist', target: 'seek', amount: 1 }), {
    params: { seek: 1 },
    features: { twist: 1 },
    capabilities: [INPUT_CAPABILITIES.POSITION],
  });
  assert.equal(params.seek, 1, 'a missing capability must not be treated as a zero signal');
  const report = evaluation.diagnostics.routes[0];
  assert.equal(report.applied, false);
  assert.equal(report.reason, 'missing-capability:twist');
  assert.equal(evaluation.diagnostics.skipped, 1);
});

test('conditions gate a route and fail closed when unverifiable', () => {
  const route = { id: 'gated', source: 'constant', target: 'seek', amount: 0.5, conditions: [{ channel: 'pressure', op: 'gt', value: 0.5 }] };

  const open = run(matrixOf(route), { params: { seek: 1 }, features: { pressure: 0.9 } });
  assert.ok(Math.abs(open.params.seek - 2) < 1e-9);
  assert.equal(open.evaluation.diagnostics.active, 1);

  const shut = run(matrixOf(route), { params: { seek: 1 }, features: { pressure: 0.1 } });
  assert.equal(shut.params.seek, 1);
  assert.equal(shut.evaluation.diagnostics.routes[0].reason, 'condition-false');

  // Capability for the *condition* channel is missing → the gate never opens.
  const blind = run(matrixOf(route), {
    params: { seek: 1 }, features: { pressure: 0.9 }, capabilities: [INPUT_CAPABILITIES.POSITION],
  });
  assert.equal(blind.params.seek, 1);
  assert.equal(blind.evaluation.diagnostics.routes[0].reason, 'condition-capability-missing');
});

test('between and outside conditions honour swapped bounds', () => {
  const build = (op, value, value2) => matrixOf({
    source: 'constant', target: 'seek', amount: 0.5,
    conditions: [{ channel: 'pressure', op, value, value2 }],
  });
  // Bounds given backwards still describe the same interval.
  assert.equal(run(build('between', 0.8, 0.2), { params: { seek: 1 }, features: { pressure: 0.5 } }).evaluation.diagnostics.active, 1);
  assert.equal(run(build('between', 0.2, 0.8), { params: { seek: 1 }, features: { pressure: 0.9 } }).evaluation.diagnostics.active, 0);
  assert.equal(run(build('outside', 0.2, 0.8), { params: { seek: 1 }, features: { pressure: 0.9 } }).evaluation.diagnostics.active, 1);
});

test('disabled routes are reported, not silently missing', () => {
  const { evaluation, params } = run(matrixOf({ id: 'off', source: 'constant', target: 'seek', amount: 1, enabled: false }), {
    params: { seek: 1 },
  });
  assert.equal(params.seek, 1);
  assert.equal(evaluation.diagnostics.routes[0].reason, 'disabled');
});

test('evaluation is pure: same inputs produce identical output', () => {
  const matrix = matrixOf(
    { id: 'a', source: 'pressure', target: 'seek', amount: 0.3, combine: 'sum' },
    { id: 'b', source: 'speed', target: 'seek', amount: 0.2, combine: 'mul' },
  );
  const args = { matrix, features: { pressure: 0.4, speed: 0.7 }, capabilities: ALL_CAPS };
  assert.deepEqual(evaluateModMatrix(args), evaluateModMatrix(args));
});

test('evaluation normalizes hand-built matrices, so raw objects cannot bypass the allowlist', () => {
  const evaluation = evaluateModMatrix({
    // Deliberately un-normalized: a caller-forged route object.
    matrix: { routes: [{ target: 'evalMe', source: 'constant', amount: 1, enabled: true }] },
    features: {},
    capabilities: ALL_CAPS,
  });
  assert.deepEqual(Object.keys(evaluation.targets), []);
});

// ── Application ────────────────────────────────────────────────────────────

test('applyModTargets writes only allowlisted ids present on the params object', () => {
  const params = { seek: 1, brushSize: 20 };
  const targets = {
    seek: { offsetNorm: 0.25, gain: 1, clampMin: 0, clampMax: 1, routeIds: ['a'] },
    brushSize: { offsetNorm: 1, gain: 4, clampMin: 0, clampMax: 1, routeIds: ['b'] },
  };
  // defineProperty (not a literal key) so this really is an own, enumerable
  // '__proto__' entry that Object.entries will hand to the resolver.
  Object.defineProperty(targets, '__proto__', {
    value: { offsetNorm: 1, gain: 1, clampMin: 0, clampMax: 1, routeIds: ['c'] },
    enumerable: true, configurable: true, writable: true,
  });
  const { applied } = applyModTargets(params, { targets });
  assert.ok(Math.abs(params.seek - 1.5) < 1e-9);
  assert.equal(params.brushSize, 20, 'non-allowlisted keys are never written');
  assert.deepEqual(Object.keys(applied), ['seek']);
  assert.equal(Object.getPrototypeOf(params), Object.prototype, 'prototype is untouched');
});

test('applyModTargets skips targets the caller does not actually own', () => {
  const params = { seek: 1 };
  applyModTargets(params, { targets: { cohesion: { offsetNorm: 1, gain: 1, clampMin: 0, clampMax: 1, routeIds: [] } } });
  assert.ok(!('cohesion' in params), 'a target absent from the base params is left alone');
});

test('applied values respect the target spec bounds and integer rounding', () => {
  const spec = resolveModTarget('quorumThreshold');
  assert.equal(spec.integer, true);
  const { params } = run(matrixOf({ source: 'constant', target: 'quorumThreshold', amount: 0.113, combine: 'sum' }), {
    params: { quorumThreshold: 10 },
  });
  assert.equal(params.quorumThreshold, 21, 'integer targets round (10 + 0.113 * 100)');
  assert.equal(Number.isInteger(params.quorumThreshold), true);

  // Overdriving a route can never leave the declared spec range.
  const hot = run(matrixOf({ source: 'constant', target: 'damping', amount: 1, combine: 'sum' }), {
    params: { damping: 0.9 },
  });
  assert.ok(hot.params.damping <= resolveModTarget('damping').max);
  const cold = run(matrixOf({ source: 'constant', target: 'damping', amount: -1, combine: 'sum' }), {
    params: { damping: 0.9 },
  });
  assert.ok(cold.params.damping >= resolveModTarget('damping').min);
});

test('an empty matrix is a no-op, preserving existing brush behaviour', () => {
  const params = { seek: 1, cohesion: 0.6, maxSpeed: 4 };
  const { params: next, applied } = run(emptyModMatrix(), { params });
  assert.deepEqual(next, params);
  assert.deepEqual(applied, {});
});

// ── Diagnostics summary ────────────────────────────────────────────────────

test('summarizeModulation is compact and elides beyond the limit', () => {
  assert.equal(summarizeModulation({}), '');
  assert.equal(summarizeModulation(null), '');
  assert.equal(summarizeModulation({ seek: { base: 1, value: 1.5 } }), 'seek 1.50');
  // Wide-range targets drop the decimals.
  assert.equal(summarizeModulation({ neighborRadius: { base: 40, value: 62.4 } }), 'neighborRadius 62');
  const many = summarizeModulation({
    seek: { value: 1 }, cohesion: { value: 1 }, alignment: { value: 1 }, wander: { value: 1 },
  });
  assert.ok(many.endsWith('+1'));
});
