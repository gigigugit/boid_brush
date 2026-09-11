import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiverBundle, riverGeometry, RIVER_ANALYSIS, RIVER_TRIALS, RiverExperimentRunner } from '../river-experiment.js';

test('river native data is deterministic, bounded, selective and explicit about feedback limitations', () => {
  const bundle = createRiverBundle();
  assert.deepEqual(JSON.parse(JSON.stringify(bundle)), createRiverBundle());
  assert.equal(bundle.format, 'boid-brush-simulation-setup');
  assert.equal(bundle.version, 1);
  assert.equal(bundle.sessions.length, 9);
  assert.equal(new Set(bundle.sessions.map(s => s.id)).size, 9);
  assert.equal(bundle.multiSessionEnabled, false);
  assert.equal(bundle.activeSessionId, null);
  assert.ok(bundle.bindings.every(b => !b.enabled && !b.layerIds.length));
  assert.equal(RIVER_TRIALS.length, 5);
  assert.equal(RIVER_ANALYSIS.baseline.seek, 0);
  assert.equal(RIVER_ANALYSIS.baseline.snapshotSeekIgnored, .75);
  assert.ok(bundle.riverExperiment.limitations.some(s => s.includes('not erosion')));
  for (const s of bundle.sessions) {
    assert.equal(s.experimentationBrush, 'boid');
    assert.equal(s.vars.seek, 0);
    assert.equal(s.paramSnapshot.seek, 0);
    assert.equal(s.controlState.maxSpeed / 2, s.vars.maxSpeed);
    assert.equal(s.controlState.wander / 100, s.paramSnapshot.wander);
    assert.ok(!Object.hasOwn(s.vars, 'wander'));
    assert.equal(s.brushData.boid.spawns[0].count, 500);
    assert.ok(s.controlState.simBoundsMargin <= 240);
    assert.ok(s.controlState.simPathSpeed <= 200);
    assert.ok(s.brushData.boid.paths.every(p => p.closed && p.strength <= 2 && p.speed === 1));
  }
  const control = bundle.sessions[0];
  assert.equal(control.vars.maxSpeed, 11);
  assert.equal(control.paramSnapshot.spawnRadius, 300);
  assert.equal(control.brushData.boid.paths.length, 0);
  assert.deepEqual(control.brushData.boid.spawns[0].x, 710.858);
});

test('horseshoe and bypass share inlet/outlet, remove bend, and keep return inside native margin', () => {
  for (const size of [256, 400, 1424, 2048]) {
    const a = riverGeometry(size, size), b = riverGeometry(size, size, 'bypass');
    assert.deepEqual(a.points.slice(0, 8), b.points.slice(0, 8));
    assert.deepEqual(a.points.slice(-11), b.points.slice(-11));
    assert.ok(a.points.length > b.points.length);
    assert.ok(a.points.some(p => p.x > size));
    assert.ok(a.points.some(p => p.x < 0));
    for (const p of [...a.points, ...b.points]) {
      assert.ok(p.x >= -a.margin && p.x <= size + a.margin);
      assert.ok(p.y >= -a.margin && p.y <= size + a.margin);
    }
  }
  for (const n of [NaN, Infinity, -1, 255, 2049]) assert.throws(() => riverGeometry(n, 1424));
  assert.throws(() => riverGeometry(1424, 1424, 'erosion'));
});

function fakeApp() {
  const app = {
    W: 1424, H: 1424, activeBrush: 'ant', activeLayerIdx: 0,
    corral: { enabled: true }, _simulationExport: { armedOnStart: true },
    layers: [{ id: 'user', name: 'Original', visible: true, paint: 'untouched' }],
    simulation: {
      enabled: true, mode: 'normal', running: true, paused: false,
      vars: { seek: .2 }, brushData: { ant: { points: [{ id: 99 }] } }, nextId: 100,
      savedPlayback: { frames: ['user playback'] },
      activeSessionIndex: -1, experimentationDraftId: 'my-draft',
      sessions: [{ id: 'mine', name: 'Saved', vars: { seek: .5 } }],
      multiSessionEnabled: true, multiSessionBindings: [{ sessionId: 'mine', enabled: true, layerIds: ['user'] }],
    },
    controls: { maxSpeed: '22', wander: '6' },
    _captureSimulationSessionControlState() { return structuredClone(this.controls); },
    _captureViewState() { return { zoom: .7, panX: 30 }; },
    _applyViewState(v) { this.view = v; },
    _applySimulationSessionControlState(c) { this.controls = c; },
    _applySimulationSessionToDraft(s) { Object.assign(this.simulation, structuredClone({ vars: s.vars, brushData: s.brushData })); this.controls = s.controlState; },
    getActiveLayer() { return this.layers[this.activeLayerIdx]; },
    pauseSimulation() { this.simulation.running = false; this.simulation.paused = true; },
    stopSimulation() {
      if (this.simulation.running) assert.notEqual(this.getActiveLayer().id, 'user', 'must pause before stopping user playback');
      this.simulation.running = false; this.simulation.paused = false;
    },
    _setSimulationMode(mode) { this.simulation.mode = mode; },
    _toggleSimulationMode(enabled) { this.simulation.enabled = enabled; },
    setBrush(brush) { this.activeBrush = brush; },
    addLayer(name) { this.layers.splice(this.activeLayerIdx, 0, { id: name, name, visible: true }); },
    async startSimulation() { this.simulation.running = true; this.simulation.frameCount = 0; },
    _syncLayerSwitcher() {}, _syncSimulationUI() {}, compositeAllLayers() {},
    saveSession() { return true; },
  };
  return app;
}

for (const outcome of ['success', 'cancel', 'failure']) {
  test(`river ${outcome} restores draft, bindings, controls, active layer, mode, and input fence`, async () => {
    const listeners = new Map();
    globalThis.window = {
      addEventListener(type, callback) { listeners.set(type, callback); },
      removeEventListener(type, callback) { assert.equal(listeners.get(type), callback); listeners.delete(type); },
    };
    try {
      const app = fakeApp();
      const original = structuredClone(app.simulation);
      const runner = new RiverExperimentRunner(app);
      let phases = 0;
      runner.waitForPhase = async session => {
        phases++;
        assert.equal(app.getActiveLayer().id, runner.layerId);
        assert.equal(app.simulation.multiSessionEnabled, false);
        assert.equal(app.corral.enabled, false);
        if (session.riverExperiment.phase === 'bypass') {
          assert.deepEqual(app.simulation.brushData.boid.paths[0].points, session.brushData.boid.paths[0].points);
          assert.equal(app.simulation.brushData.boid.paths[0].travelDistance, 0);
        }
        if (outcome === 'cancel') runner.cancel();
        if (outcome === 'failure') throw new Error('injected startup/phase failure');
      };
      assert.equal(await runner.start(createRiverBundle()), outcome === 'success');
      assert.equal(phases, outcome === 'success' ? 9 : 1);
      assert.equal(runner.running, false);
      assert.equal(listeners.size, 0);
      assert.equal(app.activeBrush, 'ant');
      assert.equal(app.getActiveLayer().id, 'user');
      assert.equal(app.getActiveLayer().paint, 'untouched');
      assert.deepEqual(app.simulation.vars, original.vars);
      assert.deepEqual(app.simulation.brushData, original.brushData);
      assert.deepEqual(app.simulation.savedPlayback, original.savedPlayback);
      assert.equal(app.simulation.experimentationDraftId, 'my-draft');
      assert.equal(app.simulation.activeSessionIndex, -1);
      assert.deepEqual(app.simulation.sessions[0], original.sessions[0]);
      assert.deepEqual(app.simulation.multiSessionBindings[0], original.multiSessionBindings[0]);
      assert.equal(app.simulation.sessions.length, 10);
      assert.ok(app.simulation.multiSessionBindings.slice(1).every(b => !b.enabled));
      assert.equal(app.simulation.running, false);
      assert.equal(app.simulation.paused, false);
      assert.equal(app.corral.enabled, true);
      assert.equal(app._simulationExport.armedOnStart, true);
      assert.deepEqual(app.controls, { maxSpeed: '22', wander: '6' });
    } finally { delete globalThis.window; }
  });
}
