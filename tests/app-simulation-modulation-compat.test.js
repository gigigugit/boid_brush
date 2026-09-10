/**
 * Regression tests for the Boid Input Modulation Framework's simulation-mode
 * compatibility seam in app.js.
 *
 * Bug: `App.getModulationSnapshot()` (via `getInputFeatureFrame()`) and
 * `App._ingestInputSample()` used to dereference `this._inputFeatureTracker`
 * directly. `_inputFeatureTracker` is always created in the real constructor,
 * Callers without a live input tracker must remain safe, while BoidBrush must
 * bypass input modulation entirely whenever simulation mode is enabled.
 *
 * `App.prototype` methods are exercised directly against a minimal
 * `Object.create(App.prototype)` stand-in (no DOM) so this stays a fast,
 * dependency-free unit test while still running the real production code
 * paths — the same style used by tests/boid-input-modulation.test.js.
 *
 * Run with Node's built-in runner (no dependencies):  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../app.js';
import { BoidBrush } from '../brushes.js';
import { FeatureTracker, MOD_MATRIX_FORMAT, MOD_MATRIX_VERSION, createModRoute } from '../boid-input-modulation.js?v=2026-09-10-edge-overlay-cache-bust';

/** One-route matrix gating on a Pencil-only channel (pressure), matching how
 *  a user would wire "boid cohesion follows stylus pressure". */
const pressureMatrix = () => ({
  format: MOD_MATRIX_FORMAT,
  version: MOD_MATRIX_VERSION,
  routes: [createModRoute({ source: 'pressure', target: 'cohesion', amount: 0.5 }, 0)],
  channels: {},
});

/** Minimal App stand-in: just enough state for `getP()`'s cache fast-path
 *  (`_paramsDirty === false`) to return a param object with a modMatrix,
 *  without touching `document`. Deliberately omits `_inputFeatureTracker` to
 *  reproduce "simulation mode activated without live input data". */
function makeHeadlessApp({ modMatrix = pressureMatrix() } = {}) {
  const app = Object.create(App.prototype);
  app._cachedP = { modMatrix };
  app._paramsDirty = false;
  app._simulationContextOverride = null;
  app._modSnapshot = null;
  app._modSnapshotTime = -1;
  return app;
}

test('getModulationSnapshot() does not crash when simulation mode runs with no live input tracker', () => {
  const app = makeHeadlessApp();
  assert.equal(app._inputFeatureTracker, undefined, 'precondition: tracker not constructed yet');

  let snapshot;
  assert.doesNotThrow(() => { snapshot = app.getModulationSnapshot(); });

  // No live input means the pressure-gated route stays idle, not applied —
  // but evaluation still runs and reports why, instead of throwing.
  assert.equal(snapshot.diagnostics.active, 0);
  assert.equal(snapshot.diagnostics.skipped, 1);
  assert.equal(snapshot.diagnostics.routes[0].reason, 'missing-capability:pressure');
});

test('getModulationSnapshot() self-heals a missing tracker into a real FeatureTracker', () => {
  const app = makeHeadlessApp();
  app.getModulationSnapshot();
  assert.ok(app._inputFeatureTracker instanceof FeatureTracker, 'tracker should be lazily created');
});

test('getInputFeatureFrame() is safe to call before any pointer/pencil sample exists', () => {
  const app = makeHeadlessApp();
  let frame;
  assert.doesNotThrow(() => { frame = app.getInputFeatureFrame(); });
  assert.equal(frame.sourceId, 'mouse');
  assert.deepEqual(frame.capabilities, []);
  assert.equal(frame.channels.constant, 1);
});

test('_ingestInputSample() is safe to call before the tracker has been constructed', () => {
  const app = makeHeadlessApp();
  app._activePointers = new Map();
  assert.doesNotThrow(() => {
    app._ingestInputSample({ pointerType: 'mouse', timeStamp: 0 }, 5, 5);
  });
  assert.ok(app._inputFeatureTracker instanceof FeatureTracker);
});

test('live Pencil input still drives modulation normally once a real sample arrives', () => {
  const app = makeHeadlessApp();
  app._activePointers = new Map();

  // Before any sample: pressure-gated route is skipped (no crash, no effect).
  const idleSnapshot = app.getModulationSnapshot();
  assert.equal(idleSnapshot.diagnostics.active, 0);

  // A real Pencil sample arrives (e.g. the user starts dragging a guide
  // during simulation mode) — the same tracker instance now reports the
  // pressure capability and the route goes active.
  app._ingestInputSample({ pointerType: 'pen', pressure: 0.8, timeStamp: 1000 }, 10, 10);
  app._modSnapshotTime = -1; // bypass the per-frame cache to force re-evaluation
  const liveSnapshot = app.getModulationSnapshot();
  assert.equal(liveSnapshot.diagnostics.active, 1);
  assert.equal(liveSnapshot.diagnostics.routes[0].applied, true);
});

test('getModulationSnapshot() still returns null for the default (empty) modMatrix, tracker or not', () => {
  const app = makeHeadlessApp({ modMatrix: { format: MOD_MATRIX_FORMAT, version: MOD_MATRIX_VERSION, routes: [], channels: {} } });
  assert.equal(app.getModulationSnapshot(), null);
});

test('getModulationSnapshot() bypasses the matrix without creating input state in simulation mode', () => {
  const app = makeHeadlessApp();
  app.simulation = { enabled: true };

  assert.equal(app.getModulationSnapshot(), null);
  assert.equal(app._inputFeatureTracker, undefined);
});

test('BoidBrush bypasses input modulation completely in simulation mode', () => {
  const brush = Object.create(BoidBrush.prototype);
  brush.app = {
    simulation: { enabled: true },
    getModulationSnapshot() {
      throw new Error('simulation mode must not evaluate input modulation');
    },
  };
  brush._modApplied = { seek: { value: 9 } };
  const params = { seek: 0.25 };

  assert.equal(brush._applyInputModulation(params), params);
  assert.equal(params.seek, 0.25);
  assert.equal(brush._modApplied, null);
});

test('alpha-off simulation suppresses quorum values and leader overrides', () => {
  const brush = Object.create(BoidBrush.prototype);
  brush.app = {
    simulation: { enabled: true, vars: {} },
    _areAlphaFeaturesEnabled: () => false,
  };
  const params = {
    count: 10,
    quorumThreshold: 5,
    quorumCompositeStrength: 0.8,
    leaderConfig: {
      count: 1,
      pull: 0.2,
      overrides: {
        quorumThreshold: { enabled: true, value: 7 },
        quorumCompositeStrength: { enabled: true, value: 0.9 },
      },
    },
  };

  const result = brush._applySimVars(params);

  assert.equal(result.quorumThreshold, 0);
  assert.equal(result.quorumCompositeStrength, 0);
  assert.equal(result.leader.quorumThreshold, 0);
  assert.equal(result.leader.quorumCompositeStrength, 0);
});

test('BoidBrush still applies input modulation outside simulation mode', () => {
  let snapshotReads = 0;
  const brush = Object.create(BoidBrush.prototype);
  brush.app = {
    simulation: { enabled: false },
    getModulationSnapshot() {
      snapshotReads++;
      return {
        targets: {
          seek: {
            offsetNorm: 0.1,
            gain: 1,
            clampMin: 0,
            clampMax: 1,
            routeIds: ['seek-route'],
          },
        },
      };
    },
  };
  const params = { seek: 0.25 };

  brush._applyInputModulation(params);
  assert.equal(snapshotReads, 1);
  assert.notEqual(params.seek, 0.25);
  assert.ok(brush._modApplied.seek);
});

test('active seek modulation remains authoritative over a leader seek override', () => {
  const brush = Object.create(BoidBrush.prototype);
  brush.app = {
    simulation: { enabled: false },
    getModulationSnapshot() {
      return {
        targets: {
          seek: {
            absoluteNorm: 0.25,
            offsetNorm: 0,
            gain: 1,
            clampMin: 0,
            clampMax: 1,
            routeIds: ['seek-route'],
          },
        },
      };
    },
  };
  const params = {
    seek: 0.75,
    count: 10,
    leaderConfig: {
      count: 2,
      pull: 0,
      overrides: { seek: { enabled: true, value: 0.9 } },
    },
  };

  const resolved = brush._applySimVars(params);
  assert.equal(resolved.seek, 0.25);
  assert.equal(resolved.leader.seek, 0.25);
});

test('leader seek override remains active when no seek route is applied', () => {
  const brush = Object.create(BoidBrush.prototype);
  brush.app = {
    simulation: { enabled: false },
    getModulationSnapshot() {
      return { targets: {}, diagnostics: { routes: [], active: 0, skipped: 0 } };
    },
  };
  const params = {
    seek: 0.75,
    count: 10,
    leaderConfig: {
      count: 2,
      pull: 0,
      overrides: { seek: { enabled: true, value: 0.9 } },
    },
  };

  const resolved = brush._applySimVars(params);
  assert.equal(resolved.seek, 0.75);
  assert.equal(resolved.leader.seek, 0.9);
});
