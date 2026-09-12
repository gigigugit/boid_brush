/**
 * Regression tests for the simulation-mode lifecycle race that broke
 * concurrent/multi-session simulation runs once recorded (saved playback)
 * multi-session runtimes were added.
 *
 * Root cause: `startSimulation()`'s multi-session branch awaits
 * `_createMultiSessionRuntimeSessions()` (GPU device + brush-instance setup)
 * before publishing `this.simulation.runtimeSessions`. `stopSimulation()`
 * unconditionally reset `simulation.starting`/`running` with no way for the
 * still-in-flight `startSimulation()` call to know it had been superseded.
 * That let a Stop (or a fresh Start) race an in-flight Start: the stale call
 * would resume after its await and either (a) resurrect a "running" state
 * the user had just stopped, or (b) leak its freshly created GPU-backed
 * runtime sessions forever, eventually exhausting the shared WebGPU device
 * limit so no further simulation — single or multi-session — could start.
 *
 * A second, related gap: any error thrown while creating/priming a single
 * multi-session runtime (or while tearing one down) was uncaught, aborting
 * the whole batch and leaking every sibling runtime that came before or
 * after the failure. Saved-playback ("recorded") runtimes were also treated
 * identically to live ones during teardown, including calling the live-only
 * `onUp()` lifecycle hook on a runtime that never received `onDown()`.
 *
 * These tests exercise `App.prototype.startSimulation` / `stopSimulation` /
 * `_teardownMultiSessionRuntimeSessions` / `_releaseCachedMultiSessionRuntimeSessions`
 * / `_createMultiSessionRuntimeSessions` directly against a minimal
 * `Object.create(App.prototype)` stand-in (no DOM, no real GPU), matching
 * the style used by tests/app-simulation-modulation-compat.test.js.
 *
 * Run with Node's built-in runner (no dependencies): npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../app.js';

function makeFakeRuntime(name, { savedPlayback = null } = {}) {
  const brushInstance = {
    onUpCalls: 0,
    deactivateCalls: 0,
    destroyCalls: 0,
    onUp() { this.onUpCalls++; },
    deactivate() { this.deactivateCalls++; },
    destroy() { this.destroyCalls++; },
  };
  return {
    brush: 'boid',
    brushInstance,
    savedPlayback,
    sessionIndex: 0,
    sessionName: name,
    layerId: 'L1',
    leaderX: 0,
    leaderY: 0,
    strokeFrame: 0,
    playbackCursor: 0,
    playbackComplete: false,
  };
}

/** Minimal App stand-in with just enough state for the simulation lifecycle
 *  methods (startSimulation/stopSimulation/teardown helpers) to run without
 *  touching `document` or a real GPU. */
function makeHeadlessSimApp(overrides = {}) {
  const app = Object.create(App.prototype);
  app.activeBrush = 'boid';
  app.simulation = {
    enabled: true,
    starting: false,
    running: false,
    paused: false,
    runToken: 0,
    frameCount: 0,
    pathDistance: 0,
    mode: 'normal',
    forceViz: null,
    multiSessionEnabled: true,
    sessions: [],
    runtimeSessions: [],
    cachedRuntimeSessions: [],
    runtimeStrokeStarts: [],
    motionPathVelocity: { x: 0, y: 0 },
  };
  app._simulationExport = { armedOnStart: false, recording: false };
  app._simulationContextOverride = null;
  app.strokeFrame = 0;
  app.leaderX = 0;
  app.leaderY = 0;
  app.isDrawing = false;
  app.isTapering = false;
  app.undoPushedThisStroke = false;
  app._toasts = [];
  app.showToast = msg => { app._toasts.push(msg); };
  app.getCurrentBrush = () => ({ deactivate() {}, onUp() {}, onDown() {}, configureSimulation() {} });
  app.getP = () => ({});
  app._isMotionBrush = () => true;
  app._constrainSimulationDataToBounds = () => {};
  app._syncSimulationUI = () => {};
  app._stopSimulationRecording = async () => null;
  app.recordLastChangeMarker = () => {};
  app.saveSession = () => {};
  app._ensureSimulationSpawns = () => [{ id: 1, x: 0, y: 0, enabled: true }];
  app._usesPathGuides = () => false;
  app._collectSimulationStrokeStartSpawns = () => [];
  app._updateSimulationLeader = () => {};
  app._getSimulationBrushData = () => ({ spawns: [] });
  Object.assign(app, overrides);
  return app;
}

test('a Stop mid-flight during an async multi-session start does not resurrect the stopped run or leak the freshly created runtime sessions', async () => {
  const app = makeHeadlessSimApp();
  app._shouldUseMultiSessionPlayback = () => true;
  app._getMultiSessionRouteDiagnostics = () => ({
    runnableRoutes: [{ sessionId: 's1', sessionIndex: 0, layerId: 'L1' }],
    blockReason: '',
    healedBindings: false,
  });

  const fakeRuntime = makeFakeRuntime('session-1');
  let resolveCreate;
  app._createMultiSessionRuntimeSessions = () => new Promise(resolve => { resolveCreate = resolve; });

  const startPromise = app.startSimulation({ announce: false });

  // startSimulation() runs synchronously up to its one await point.
  assert.equal(app.simulation.running, true, 'precondition: start marks running before awaiting GPU/session setup');
  assert.equal(app.simulation.starting, true);

  // The user clicks Stop while GPU/session creation is still pending.
  app.stopSimulation(false);
  assert.equal(app.simulation.running, false, 'stop should win immediately');
  assert.equal(app.simulation.starting, false);

  // GPU/session setup for the now-superseded start now resolves.
  resolveCreate([fakeRuntime]);
  await startPromise;

  assert.deepEqual(app.simulation.runtimeSessions, [], 'the stale run must never publish its runtime sessions');
  assert.equal(fakeRuntime.brushInstance.destroyCalls, 1, 'the orphaned runtime must be destroyed, not leaked');
  assert.equal(app.simulation.running, false, 'the explicit stop must remain in effect, not be clobbered by the stale start');
});

test('a fresh Start superseding an in-flight Start destroys the stale runtimes and keeps only the newer run\'s sessions', async () => {
  const app = makeHeadlessSimApp();
  app._shouldUseMultiSessionPlayback = () => true;
  app._getMultiSessionRouteDiagnostics = () => ({
    runnableRoutes: [{ sessionId: 's1', sessionIndex: 0, layerId: 'L1' }],
    blockReason: '',
    healedBindings: false,
  });

  const staleRuntime = makeFakeRuntime('stale');
  const freshRuntime = makeFakeRuntime('fresh');
  let resolveStale;
  let callCount = 0;
  app._createMultiSessionRuntimeSessions = () => {
    callCount++;
    if (callCount === 1) return new Promise(resolve => { resolveStale = resolve; });
    return Promise.resolve([freshRuntime]);
  };

  const firstStart = app.startSimulation({ announce: false });
  // Allow the guard flags to be set before attempting a second call.
  assert.equal(app.simulation.starting, true);

  // A second start is requested before the first has resolved. Because
  // stopSimulation() bumps runToken and startSimulation() re-checks the
  // running/starting guard after its own internal stopSimulation(false)
  // call, this models a Stop+Start (e.g. re-arm) superseding the pending run.
  app.stopSimulation(false);
  const secondStart = app.startSimulation({ announce: false });

  resolveStale([staleRuntime]);
  await Promise.all([firstStart, secondStart]);

  assert.equal(app.simulation.runtimeSessions.length, 1, 'only the newer run\'s sessions should be published');
  assert.equal(app.simulation.runtimeSessions[0], freshRuntime);
  assert.equal(staleRuntime.brushInstance.destroyCalls, 1, 'the superseded run\'s runtime must be destroyed, not leaked');
  assert.equal(freshRuntime.brushInstance.destroyCalls, 0, 'the winning run\'s runtime must remain alive');
});

test('_teardownMultiSessionRuntimeSessions isolates a broken runtime so its siblings are still torn down and nothing is leaked', () => {
  const app = makeHeadlessSimApp();
  const broken = makeFakeRuntime('broken');
  broken.brushInstance.onUp = () => { throw new Error('boom'); };
  const healthy = makeFakeRuntime('healthy');
  app.simulation.runtimeSessions = [broken, healthy];

  assert.doesNotThrow(() => {
    app._teardownMultiSessionRuntimeSessions({ commitPreview: true, cache: false });
  });

  assert.equal(broken.brushInstance.destroyCalls, 1, 'the broken runtime must still be destroyed despite onUp throwing');
  assert.equal(healthy.brushInstance.onUpCalls, 1, 'a sibling runtime after a broken one must still be torn down');
  assert.equal(healthy.brushInstance.destroyCalls, 1);
  assert.deepEqual(app.simulation.runtimeSessions, [], 'runtimeSessions must always end up cleared, even after a mid-loop failure');
});

test('teardown defines recorded-vs-new behavior: onUp is skipped for a saved-playback runtime but still runs for a live one', () => {
  const app = makeHeadlessSimApp();
  const recorded = makeFakeRuntime('recorded', { savedPlayback: { frames: [], agentCount: 0 } });
  const live = makeFakeRuntime('live');
  app.simulation.runtimeSessions = [recorded, live];

  app._teardownMultiSessionRuntimeSessions({ commitPreview: true, cache: false });

  assert.equal(recorded.brushInstance.onUpCalls, 0, 'a recorded runtime never received onDown, so onUp must not run on it');
  assert.equal(live.brushInstance.onUpCalls, 1, 'a live runtime should still commit its preview via onUp');
});

test('_releaseCachedMultiSessionRuntimeSessions isolates a broken cached runtime\'s destroy failure', () => {
  const app = makeHeadlessSimApp();
  const broken = makeFakeRuntime('broken');
  broken.brushInstance.destroy = () => { throw new Error('destroy boom'); };
  const healthy = makeFakeRuntime('healthy');
  app.simulation.cachedRuntimeSessions = [broken, healthy];

  assert.doesNotThrow(() => app._releaseCachedMultiSessionRuntimeSessions());
  assert.equal(healthy.brushInstance.destroyCalls, 1);
  assert.deepEqual(app.simulation.cachedRuntimeSessions, []);
});

test('_createMultiSessionRuntimeSessions isolates a priming failure: the failed runtime is destroyed, not leaked, and sibling sessions are preserved', async () => {
  const app = makeHeadlessSimApp();
  app.simulation.sessions = [{ id: 's1', name: 'Session 1' }, { id: 's2', name: 'Session 2' }];
  app._getRunnableSimulationSessionBindings = () => ([
    { sessionId: 's1', sessionIndex: 0, layerId: 'L1' },
    { sessionId: 's2', sessionIndex: 1, layerId: 'L2' },
  ]);
  app._canReuseCachedMultiSessionRuntimeSessions = () => false;
  app._getLayerById = id => ({ id, name: id });
  app._getSimulationSavedPlaybackForRuntime = () => null;

  const instances = [];
  app._createSimulationRuntimeBrush = async () => {
    const instance = { destroyCalls: 0, destroy() { this.destroyCalls++; } };
    instances.push(instance);
    return instance;
  };
  app._primeMultiSessionRuntime = runtime => {
    if (runtime.sessionIndex === 1) throw new Error('priming failed');
  };

  const runtimes = await app._createMultiSessionRuntimeSessions({});

  assert.equal(runtimes.length, 1, 'only the successfully primed session should be returned');
  assert.equal(runtimes[0].sessionIndex, 0);
  assert.equal(instances.length, 2, 'both brush instances were attempted');
  assert.equal(instances[1].destroyCalls, 1, 'the failed session\'s brush instance must be destroyed, not leaked');
  assert.equal(instances[0].destroyCalls, 0, 'the surviving session\'s brush instance must remain alive');
});
