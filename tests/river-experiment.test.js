import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../app.js';
import { createRiverBundle, riverGeometry, RIVER_ANALYSIS, RIVER_TRIALS, RiverExperimentRunner } from '../river-experiment.js';

test('single-session river guide clock uses fixed milliseconds without changing ordinary playback', () => {
  const oldDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible', getElementById() { return null; } };
  try {
    for (const running of [true, false]) {
      const app = Object.create(App.prototype);
      const stop = new Error('frame sampled');
      Object.assign(app, {
        _performanceTelemetry: { enabled: false }, _startTime: performance.now() - 100000,
        simulation: { running: true, frameCount: 0 },
        experimentation: { river: { running } },
        getP: () => ({}), getCurrentBrush: () => ({ onFrame() { throw stop; } }),
        _hasActiveMultiSessionPlayback: () => false,
        _applySimulationEphemeralFade() {},
        _updateSimulationLeader(elapsed) { this.guideElapsed = elapsed; },
      });
      assert.throws(() => app._frameLoop(), error => error === stop);
      if (running) assert.equal(app.guideElapsed, 1000 / 60);
      else assert.ok(app.guideElapsed >= 100 && app.guideElapsed < 101);
    }
  } finally { globalThis.document = oldDocument; }
});

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
    activeTool: 'fill', sensingSelection: ['user'], undoStack: [], redoStack: [],
    _serializeSensingSourceSelection() { return [...this.sensingSelection]; },
    _restoreSensingSourceSelection(selection) { this.sensingSelection = selection; },
    _captureState() { return { layers: structuredClone(this.layers), simulation: structuredClone(this.simulation) }; },
    pushUndo(state) { this.undoStack.push({ s: state, i: this.activeLayerIdx }); this.redoStack = []; },
    setTool(tool) { this.activeTool = tool; },
    getCurrentBrush() { return this.brush; },
    _syncCorralUI() {},
    _captureSimulationSessionControlState() { return structuredClone(this.controls); },
    _captureViewState() { return { zoom: .7, panX: 30 }; },
    _applyViewState(v) { this.view = v; },
    _applySimulationSessionControlState(c) { this.controls = c; },
    _applySimulationSessionToDraft(s) {
      Object.assign(this.simulation, structuredClone({ vars: s.vars, brushData: s.brushData }));
      this.controls = s.controlState;
      this._restoreSensingSourceSelection(s.sensingSourceSelection);
    },
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
    async startSimulation() {
      this.pushUndo(this._captureState());
      this.simulation.running = true; this.simulation.frameCount = 0;
    },
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
      // App tracks hover in this map too; it is not a pointer-down guard.
      app._activePointers = new Map([[1, { type: 'mouse' }]]);
      const original = structuredClone(app.simulation);
      const runner = new RiverExperimentRunner(app);
      let phases = 0;
      runner.waitForPhase = async session => {
        phases++;
        assert.equal(app.getActiveLayer().id, runner.layerId);
        assert.equal(app.simulation.multiSessionEnabled, false);
        assert.equal(app.corral.enabled, false);
        assert.deepEqual(app.sensingSelection, []);
        for (const type of ['wheel', 'touchmove', 'drop', 'paste']) {
          let blocked = false;
          listeners.get(type)({ type, preventDefault() { blocked = true; }, stopImmediatePropagation() {} });
          assert.equal(blocked, true, `${type} is fenced`);
        }
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
      assert.equal(app.activeTool, 'fill');
      assert.deepEqual(app.sensingSelection, ['user']);
      assert.equal(app.undoStack.length, 1);
      assert.deepEqual(app.undoStack[0].s.layers.map(l => l.id), ['user']);
      assert.deepEqual(app.undoStack[0].s.simulation.brushData, original.brushData);
      assert.equal(app._simulationExport.armedOnStart, true);
      assert.deepEqual(app.controls, { maxSpeed: '22', wander: '6' });
    } finally { delete globalThis.window; }
  });
}

test('cancellation during startup waits for owned GPU preview and commits it once before restoration', async () => {
  const listeners = new Set();
  globalThis.window = {
    addEventListener(type) { listeners.add(type); },
    removeEventListener(type) { listeners.delete(type); },
  };
  try {
    const app = fakeApp();
    let releaseStart, commits = 0;
    const started = new Promise(resolve => { releaseStart = resolve; });
    app.brush = {
      _gpuPreviewActive: true,
      _gpuPreviewRenderer: { kind: 'webgpu', _previewSyncPending: true, _hasLivePreviewFrame: false },
      onUp() {
        assert.notEqual(app.getActiveLayer().id, 'user');
        assert.equal(app.simulation.running, false);
        assert.equal(this._gpuPreviewRenderer._hasLivePreviewFrame, true);
        assert.equal(this._gpuPreviewRenderer._previewSyncPending, false);
        this._gpuPreviewActive = false;
        app.getActiveLayer().paint = 'committed partial preview';
        commits++;
      },
    };
    app.startSimulation = async () => { app.simulation.running = true; await started; };
    const runner = new RiverExperimentRunner(app);
    runner.waitForPhase = () => assert.fail('cancelled startup must not enter a phase');
    const run = runner.start(createRiverBundle());
    runner.cancel();
    releaseStart();
    setTimeout(() => {
      app.brush._gpuPreviewRenderer._hasLivePreviewFrame = true;
      app.brush._gpuPreviewRenderer._previewSyncPending = false;
    }, 0);
    assert.equal(await run, false);
    assert.equal(commits, 1);
    assert.equal(app.layers[0].paint, 'committed partial preview');
    assert.equal(app.getActiveLayer().id, 'user');
    assert.equal(runner.running, false);
    assert.equal(listeners.size, 0);
  } finally { delete globalThis.window; }
});

test('phase checks use smoothed circuit distance and enforce time budgets and target ownership', async t => {
  const app = fakeApp(), runner = new RiverExperimentRunner(app);
  const session = createRiverBundle().sessions[1];
  runner.layerId = 'user';
  app.activeBrush = 'boid';
  app.simulation.brushData.boid = { paths: [{ travelDistance: 100 }] };
  app._getSimulationPathSample = () => ({ totalLength: 100 });
  app.simulation.frameCount = 12;
  await runner.waitForPhase(session, performance.now());
  assert.equal(runner.results[0].circuitLength, 100);
  assert.equal(runner.results[0].frames, 12);
  app.activeBrush = 'ant';
  await assert.rejects(runner.waitForPhase(session, performance.now()), /target changed/);
  app.activeBrush = 'boid';
  t.mock.method(performance, 'now', () => 800000);
  await assert.rejects(runner.waitForPhase(session, 0), /Time budget/);
});

test('stalled GPU preview cleanup is bounded and never commits an unavailable presentation', async t => {
  const app = fakeApp();
  app.activeBrush = 'boid';
  app.addLayer('River partial');
  app.brush = {
    _gpuPreviewActive: true,
    _gpuPreviewRenderer: { kind: 'webgpu', _previewSyncPending: true, _hasLivePreviewFrame: false },
    onUp() { assert.fail('unsettled preview must not be copied to paint'); },
  };
  const runner = new RiverExperimentRunner(app);
  runner.layerId = app.getActiveLayer().id;
  let clock = 0;
  t.mock.method(performance, 'now', () => { clock += 20000; return clock; });
  await assert.rejects(runner.finishOwnedPlayback(), /Preview did not settle/);
  assert.equal(app.simulation.running, false);
  assert.equal(app.simulation.paused, false);
  assert.equal(app.layers.find(l => l.id === 'user').paint, 'untouched');
});

test('in-flight editing and queued playback refresh reject river startup without mutation', async () => {
  for (const block of [
    app => { app.simulation.starting = true; },
    app => { app._simulationPlaybackRefreshQueued = true; },
    app => { app.simulation.dragTarget = {}; },
    app => { app._pinchActive = true; },
    app => { app.corral.drawing = true; },
    app => { app.selectionMgr = { active: true }; },
  ]) {
    const app = fakeApp();
    block(app);
    const runner = new RiverExperimentRunner(app);
    assert.equal(await runner.start(createRiverBundle()), false);
    assert.equal(app.layers.length, 1);
    assert.equal(app.simulation.running, true);
    assert.equal(app.simulation.sessions.length, 1);
  }
});
