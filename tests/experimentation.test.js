import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../app.js';
import {
  FeedbackStore, ExperimentationController, FEEDBACK_KEY, FEEDBACK_FORMAT, QUESTIONS, STARTERS,
  emptyCurve, normalizeCurve, dragCurve, fitExperimentationView, createStarter, relevantQuestions,
} from '../experimentation.js';

function memoryStorage(initial = null) {
  let data = initial;
  return {
    writes: 0,
    getItem(key) { assert.equal(key, FEEDBACK_KEY); return data; },
    setItem(key, value) { assert.equal(key, FEEDBACK_KEY); data = value; this.writes++; },
  };
}
const context = (id = 'session-1', name = 'Flock') => ({ id, name, brush: 'boid', configuration: { vars: { cohesion: 0.5 } } });

test('feedback curves distinguish unanswered, neutral, and bounded numeric answers', () => {
  assert.deepEqual(emptyCurve(), [null, null, null, null, null]);
  assert.deepEqual(normalizeCurve([0, null, '0', Infinity, -150]), [0, null, null, null, -100]);
  assert.deepEqual(normalizeCurve([150, 1.4, -3.8]), [100, 1, -4, null, null]);
});

test('fast pointer drags interpolate every crossed sample in both directions', () => {
  assert.deepEqual(dragCurve(emptyCurve(), { index: 0, value: -100 }, { index: 4, value: 100 }), [-100, -50, 0, 50, 100]);
  assert.deepEqual(dragCurve(emptyCurve(), { index: 4, value: 100 }, { index: 0, value: -100 }), [-100, -50, 0, 50, 100]);
  assert.deepEqual(dragCurve(emptyCurve(), null, { index: 2, value: 0 }), [null, null, 0, null, null]);
});

test('feedback survives store reload and rename without crossing configuration identities', () => {
  const storage = memoryStorage();
  const first = new FeedbackStore(storage);
  first.update(context(), { question: 'cohesion', curve: [0, 10], note: 'A note' });
  first.update(context(), { notes: 'Overall' });
  first.update(context('session-2'), { question: 'cohesion', curve: [-100] });
  const restored = new FeedbackStore(storage);
  restored.update(context('session-1', 'Renamed flock'), { question: 'overall', notApplicable: true });
  assert.equal(restored.records.size, 2);
  const record = restored.records.get('session-1');
  assert.equal(record.name, 'Renamed flock');
  assert.equal(record.answers.cohesion.note, 'A note');
  assert.deepEqual(record.answers.cohesion.curve, [0, 10, null, null, null]);
  assert.equal(record.answers.overall.notApplicable, true);
  assert.equal(record.notes, 'Overall');
  assert.equal(restored.records.get('session-2').answers.cohesion.curve[0], -100);
});

test('corrupt, future, or partially damaged storage is not overwritten', () => {
  for (const raw of ['{', 'null', '{"version":99}', JSON.stringify({
    format: FEEDBACK_FORMAT, version: 1, records: [{ id: 'bad' }],
  })]) {
    const storage = memoryStorage(raw);
    const store = new FeedbackStore(storage);
    assert.equal(store.blocked, true);
    assert.equal(store.update(context(), { notes: 'Recoverable in export' }), false);
    assert.equal(storage.writes, 0);
    assert.equal(store.bundle().records[0].notes, 'Recoverable in export');
    assert.match(store.status, /export JSON/);
  }
});

test('unavailable storage and quota failures preserve edits for JSON export and permit quota retry', () => {
  const denied = new FeedbackStore({ getItem() { throw Error('denied'); } });
  assert.doesNotThrow(() => denied.update(context(), { notes: 'Keep' }));
  assert.equal(denied.bundle().records[0].notes, 'Keep');
  let fail = true;
  const quota = new FeedbackStore({ getItem() { return null; }, setItem() { if (fail) throw Error('quota'); } });
  assert.equal(quota.update(context(), { notes: 'Keep too' }), false);
  assert.match(quota.status, /Could not save/);
  fail = false;
  assert.equal(quota.persist(), true);
  assert.match(quota.status, /saved/);
});

test('JSON export includes stable schema, configuration, notes, N/A and null samples', () => {
  const store = new FeedbackStore(memoryStorage());
  store.update(context(), { question: 'boundary', notApplicable: true, note: 'No corral' });
  const bundle = JSON.parse(JSON.stringify(store.bundle()));
  assert.equal(bundle.format, FEEDBACK_FORMAT);
  assert.equal(bundle.schema.scale.unanswered, null);
  assert.equal(bundle.schema.questions.length, 12);
  assert.deepEqual(bundle.records[0].configuration, context().configuration);
  assert.deepEqual(bundle.records[0].answers.boundary.curve, emptyCurve());
  assert.equal(bundle.records[0].answers.boundary.notApplicable, true);
});

test('feedback accepts hostile text as data and ignores unknown answer keys', () => {
  const store = new FeedbackStore(memoryStorage());
  store.update(context('__proto__', '<img src=x onerror=alert(1)>'), { question: '__proto__', notes: '<script>bad()</script>' });
  assert.equal(store.records.get('__proto__').name, '<img src=x onerror=alert(1)>');
  assert.deepEqual(store.records.get('__proto__').answers, {});
  assert.equal({}.polluted, undefined);
  store.update(context(), { notes: 'a'.repeat(13000), question: 'overall', note: 'b'.repeat(5000) });
  assert.equal(store.records.get('session-1').notes.length, 12000);
  assert.equal(store.records.get('session-1').answers.overall.note.length, 4000);
});

test('flock-specific questions are scoped, environmental questions support explicit N/A', () => {
  assert.equal(relevantQuestions('boid').length, QUESTIONS.length);
  assert.equal(relevantQuestions('ant').some(q => q.id === 'cohesion'), false);
  assert.equal(relevantQuestions('ant').some(q => q.id === 'obstacles'), true);
});

test('fitting the reserved viewport preserves rotation/flip and does not mutate saved view', () => {
  const view = { zoom: 2, panX: 45, panY: -60, rotation: Math.PI / 4, flipped: true };
  const fitted = fitExperimentationView(view, 600, 700, 1024, 512);
  const extent = (1024 + 512) / Math.sqrt(2) * fitted.zoom;
  assert.ok(extent <= 600);
  assert.equal(fitted.rotation, view.rotation);
  assert.equal(fitted.flipped, true);
  assert.equal(view.panX, 45);
  assert.equal(fitted.panX, 0);
});

test('large documents can temporarily fit below the manual zoom floor without touching paint', () => {
  let transformed = 0;
  const app = {
    _getCanvasViewMetrics: () => ({ areaRect: { width: 234, height: 740 }, docW: 8192, docH: 8192 }),
    _applyViewTransform: () => transformed++,
  };
  const savedView = { zoom: 1, panX: 20, panY: 10, rotation: 0, flipped: false };
  ExperimentationController.prototype.fitView.call({ app, savedView });
  assert.ok(app.viewZoom * 8192 < 234);
  assert.ok(app.viewZoom < 0.1);
  assert.equal(savedView.zoom, 1);
  assert.equal(transformed, 1);
});

test('all starting points are bounded runnable configurations with no shared mutable state', () => {
  const controls = { stampOpacity: 70 };
  for (const starter of STARTERS) {
    const session = createStarter(starter.key, { id: starter.key, width: 800, height: 600, controls });
    assert.equal(session.experimentationBrush, 'boid');
    assert.equal(session.controlState.count, 48);
    assert.equal(session.controlState.simEphemeralMode, false);
    assert.equal(session.vars.seek, 0);
    assert.equal(session.savedPlayback, null);
    assert.ok(session.brushData.boid.spawns.length);
    for (const item of [...session.brushData.boid.spawns, ...session.brushData.boid.points]) {
      assert.ok(item.x >= 0 && item.x <= 800 && item.y >= 0 && item.y <= 600);
    }
    session.controlState.stampOpacity = 20;
    assert.equal(controls.stampOpacity, 70);
  }
  assert.throws(() => createStarter('unknown', {}), /Unknown/);
});

function headlessApp() {
  const app = Object.create(App.prototype);
  app.W = 800; app.H = 600; app.activeBrush = 'boid';
  app.simulation = {
    sessions: [], activeSessionIndex: -1, multiSessionBindings: [], multiSessionEnabled: true,
    vars: {}, brushData: { boid: { spawns: [], points: [], paths: [] } }, enabled: true, nextId: 1,
  };
  app._captureSimulationSessionControlState = () => ({ count: 200, stampSize: 40 });
  app._captureSimulationSessionParamSnapshot = () => ({ count: 200 });
  app._serializeSensingSourceSelection = () => [];
  app._getSimulationTargetLayers = () => [{ id: 'layer' }];
  app.getActiveLayer = () => ({ id: 'layer' });
  app._renderSimulationInspector = () => {};
  app._syncSimulationSessionContextUi = () => {};
  app.saveSession = () => true;
  app.setBrush = name => { app.activeBrush = name; };
  app._setSimulationMode = mode => { app.simulation.mode = mode; };
  return app;
}

test('adding starting points does not apply controls, change active session, run or arm routes', () => {
  const app = headlessApp();
  const prior = structuredClone(app.simulation.brushData);
  const session = app._addExperimentationStarter('flock');
  assert.equal(app.simulation.activeSessionIndex, -1);
  assert.equal(app.simulation.running, undefined);
  assert.equal(app.simulation.multiSessionEnabled, true);
  assert.deepEqual(app.simulation.brushData, prior);
  assert.equal(app.simulation.multiSessionBindings[0].enabled, false);
  assert.equal(app.simulation.sessions[0].id, session.id);
});

test('explicit loading preserves ad-hoc data and feedback ID before single-session loading', () => {
  const app = headlessApp();
  const draftId = app._getExperimentationContext().id;
  const session = app._addExperimentationStarter('obstacle');
  let loaded = null;
  app._loadSimulationSession = index => { loaded = app.simulation.sessions[index]; };
  assert.equal(app._loadExperimentationSession(session.id), true);
  assert.equal(loaded, session);
  const preserved = app.simulation.sessions.find(s => s.id === draftId);
  assert.ok(preserved);
  assert.equal(preserved.controlState.count, 200);
  assert.equal(app.simulation.multiSessionBindings.find(b => b.sessionId === draftId).enabled, false);
  assert.equal(app.simulation.multiSessionEnabled, false);
  assert.equal(app.simulation.mode, 'normal');
});

test('loading guards missing/starting/already loaded sessions and pauses before stopping', () => {
  const app = headlessApp();
  const session = app._addExperimentationStarter('flock');
  assert.equal(app._loadExperimentationSession('missing'), false);
  app.simulation.starting = true;
  assert.equal(app._loadExperimentationSession(session.id), false);
  app.simulation.starting = false;
  const calls = [];
  app.simulation.running = true;
  app.pauseSimulation = () => { calls.push('pause'); app.simulation.running = false; app.simulation.paused = true; };
  app.stopSimulation = () => { calls.push('stop'); app.simulation.paused = false; };
  app._loadSimulationSession = () => calls.push('load');
  app._loadExperimentationSession(session.id);
  assert.deepEqual(calls, ['pause', 'stop', 'load']);
  app.simulation.activeSessionIndex = 0;
  calls.length = 0;
  app._loadExperimentationSession(session.id);
  assert.deepEqual(calls, []);
});

test('loading B and returning to edited Boid A restores its new Ant engine and draft data', () => {
  const app = headlessApp();
  const a = app._addExperimentationStarter('flock');
  const b = app._addExperimentationStarter('spacing');
  app.simulation.activeSessionIndex = 0;
  app.setBrush('ant');
  app._areAlphaFeaturesEnabled = () => true;
  app.simulation.brushData.ant = { spawns: [{ id: 'edited-ant', x: 123, y: 234 }], points: [] };
  const editedData = structuredClone(app.simulation.brushData);
  app._loadSimulationSession = index => {
    app.simulation.activeSessionIndex = index;
    app.simulation.brushData = structuredClone(app.simulation.sessions[index].brushData);
  };
  assert.equal(app._loadExperimentationSession(b.id), true);
  assert.equal(app.activeBrush, 'boid');
  const savedA = app.simulation.sessions[0];
  assert.deepEqual(savedA.brushData, editedData);
  assert.deepEqual(savedA.controlState, { count: 200, stampSize: 40 });
  assert.equal(savedA.experimentationBrush, 'ant');
  assert.equal(app._getExperimentationContext(savedA).brush, 'ant');
  assert.equal(app._loadExperimentationSession(a.id), true);
  assert.equal(app.activeBrush, 'ant');
  assert.deepEqual(app.simulation.brushData, editedData);
});

function viewApp() {
  const app = headlessApp();
  app._setSimulationMode = App.prototype._setSimulationMode;
  app._normalizeForceVizState = () => {};
  app._syncSimulationUI = () => {};
  app._maybeAutoSaveSession = () => {};
  app.showToast = () => {};
  app._applyViewTransform = () => {};
  app._getCanvasViewMetrics = () => ({ areaRect: { width: 480, height: 700 }, docW: 800, docH: 600 });
  app.simulation.mode = 'normal';
  app.simulation.forceViz = { camera: { exitBehavior: 'restoreManualView' } };
  app._applyViewState({ zoom: 1.7, panX: 95, panY: -31, rotation: 0.3, flipped: true });
  const controller = Object.create(ExperimentationController.prototype);
  controller.app = app;
  controller.open = true;
  controller.savedView = app._captureViewState();
  app.experimentation = controller;
  return app;
}

test('starter mode-transition autosave cannot overwrite the outgoing edited session brush', () => {
  const app = viewApp();
  const a = app._addExperimentationStarter('flock');
  const b = app._addExperimentationStarter('spacing');
  app.simulation.activeSessionIndex = 0;
  app.setBrush('ant');
  app._maybeAutoSaveSession = () => app._syncActiveSimulationSessionFromDraft();
  app._setSimulationMode('forceVisualization');
  app._loadSimulationSession = index => { app.simulation.activeSessionIndex = index; };
  assert.equal(app._loadExperimentationSession(b.id), true);
  assert.equal(app.simulation.mode, 'normal');
  assert.equal(app.activeBrush, 'boid');
  assert.equal(app.simulation.sessions.find(s => s.id === a.id).experimentationBrush, 'ant');
});

test('starter loading reapplies the reserved fit after force-viz exit and completed loading', () => {
  const app = viewApp();
  app.simulation.mode = 'forceVisualization';
  app._forceVizManualViewSnapshot = { ...app.experimentation.savedView, zoom: 2.3, panX: 160 };
  app.experimentation.fitView();
  const fitted = app._captureViewState();
  const saved = { ...app.experimentation.savedView };
  const session = app._addExperimentationStarter('flock');
  let viewAtLoad;
  app._loadSimulationSession = () => {
    viewAtLoad = app._captureViewState();
    // A load can finish other view-changing transitions; fit must be last.
    app.viewPanX = 500;
  };
  assert.equal(app._loadExperimentationSession(session.id), true);
  assert.deepEqual(app._captureViewState(), fitted);
  assert.deepEqual(viewAtLoad, fitted);
  assert.deepEqual(app.experimentation.savedView, saved);
  assert.equal(app.simulation.mode, 'normal');
  assert.equal(app._forceVizManualViewSnapshot, null);
});

test('direct force-viz transitions keep the open reserved fit without changing its saved view', () => {
  const app = viewApp();
  const saved = { ...app.experimentation.savedView };
  app.experimentation.fitView();
  const fitted = app._captureViewState();
  app._setSimulationMode('forceVisualization');
  assert.deepEqual(app._captureViewState(), fitted);
  app.viewZoom = 3;
  app.viewPanX = 700;
  app._setSimulationMode('normal');
  assert.deepEqual(app._captureViewState(), fitted);
  assert.deepEqual(app.experimentation.savedView, saved);
});

test('force-viz entered during Experimentation uses the full manual view after close, not its temporary fit', () => {
  const app = viewApp();
  const saved = { ...app.experimentation.savedView };
  app.experimentation.fitView();
  app._setSimulationMode('forceVisualization');
  // Model close's existing view restoration, then a later force-viz exit.
  app.experimentation.open = false;
  app._applyViewState(saved);
  app._setSimulationMode('normal');
  assert.deepEqual(app._captureViewState(), saved);
  assert.equal(app._forceVizManualViewSnapshot, null);
});

test('pre-existing force-viz manual baseline and retain-current exit semantics survive Experimentation', () => {
  for (const exitBehavior of ['restoreManualView', 'retainCurrentView']) {
    const app = viewApp();
    const manual = { ...app.experimentation.savedView, zoom: 2.4, panX: -170 };
    app.simulation.mode = 'forceVisualization';
    app.simulation.forceViz.camera.exitBehavior = exitBehavior;
    app._forceVizManualViewSnapshot = manual;
    app.experimentation.fitView();
    app.experimentation.open = false;
    app._applyViewState(app.experimentation.savedView);
    app._setSimulationMode('normal');
    assert.deepEqual(app._captureViewState(), exitBehavior === 'restoreManualView' ? manual : app.experimentation.savedView);
    assert.equal(app._forceVizManualViewSnapshot, null);
  }
});

test('session identity is retained by import normalization and renaming', () => {
  const app = headlessApp();
  const session = app._addExperimentationStarter('spacing');
  app.layers = [{ id: 'layer', name: 'Layer' }];
  const bundle = app._normalizeSimulationSetupBundle({
    format: 'boid-brush-simulation-setup', version: 1, sessions: [structuredClone(session)], bindings: [],
  });
  assert.equal(bundle.sessions[0].id, session.id);
  bundle.sessions[0].name = 'Renamed';
  app._ensureSimulationSessionIds(bundle.sessions);
  assert.equal(bundle.sessions[0].id, session.id);
});

test('saving an ad-hoc draft adopts its feedback ID, then renaming preserves it', t => {
  const priorWindow = globalThis.window;
  globalThis.window = { prompt: () => 'Saved draft' };
  t.after(() => { globalThis.window = priorWindow; });
  const app = headlessApp();
  app.showToast = () => {};
  const store = new FeedbackStore(memoryStorage());
  const draft = app._getExperimentationContext();
  store.update(draft, { notes: 'Already evaluated' });
  app._saveSimulationSession();
  assert.equal(app.simulation.sessions[0].id, draft.id);
  assert.equal(app.simulation.activeSessionIndex, 0);
  globalThis.window.prompt = () => 'Renamed saved draft';
  app._saveSimulationSession();
  assert.equal(app.simulation.sessions.length, 1);
  assert.equal(app._getExperimentationContext().id, draft.id);
  assert.equal(store.records.get(draft.id).notes, 'Already evaluated');
});

test('setup imports that detach a draft cannot cause duplicate feedback/session IDs', () => {
  const app = headlessApp();
  const session = app._addExperimentationStarter('flock');
  app.simulation.experimentationDraftId = session.id;
  app.simulation.activeSessionIndex = -1;
  const draft = app._getExperimentationContext();
  assert.notEqual(draft.id, session.id);
  assert.equal(app._getExperimentationContext().id, draft.id);
});

test('observation-only session persistence never synchronizes the active configuration', t => {
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = { setItem() {} };
  t.after(() => { globalThis.localStorage = priorStorage; });
  const app = Object.create(App.prototype);
  let synced = 0;
  app._syncActiveSimulationSessionFromDraft = () => synced++;
  app._captureSessionControls = () => ({});
  assert.equal(app.saveSession({ syncSimulation: false }), true);
  assert.equal(synced, 0);
  assert.equal(app.saveSession(), true);
  assert.equal(synced, 1);
  globalThis.localStorage.setItem = () => { throw Error('quota'); };
  assert.equal(app.saveSession({ syncSimulation: false }), false);
});

test('legacy and untrusted brush metadata cannot select a nonexistent brush', () => {
  for (const brush of [undefined, '<script>', '__proto__']) {
    const app = headlessApp();
    const session = app._addExperimentationStarter('flock');
    session.experimentationBrush = brush;
    let selected = null;
    app.setBrush = name => { selected = name; };
    app._loadSimulationSession = () => {};
    app._loadExperimentationSession(session.id);
    assert.equal(selected, null);
  }
});

test('unavailable alpha brushes fail before changing the current draft or playback', () => {
  const app = headlessApp();
  const session = app._addExperimentationStarter('flock');
  session.experimentationBrush = 'ant';
  app._areAlphaFeaturesEnabled = () => false;
  app.showToast = () => {};
  assert.equal(app._loadExperimentationSession(session.id), false);
  assert.equal(app.simulation.activeSessionIndex, -1);
  assert.equal(app.simulation.sessions.length, 1);
  assert.equal(app.simulation.multiSessionEnabled, true);
});

test('viewport resize never resizes paint buffers while experimentation is open', () => {
  const app = headlessApp();
  let transformed = 0;
  app.experimentation = { open: true };
  app._applyViewTransform = () => transformed++;
  // Any canvas access would throw in this headless stand-in.
  app._resizeAll();
  assert.equal(transformed, 1);
  assert.equal(app.W, 800);
});
