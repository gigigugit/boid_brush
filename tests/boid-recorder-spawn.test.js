import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { BoidBrush } from '../brushes.js';
import { App } from '../app.js';

const recorderSource = readFileSync(new URL('../userscripts/mouse-path-recorder.user.js', import.meta.url), 'utf8');
const { buildTimelineSchedule, createTimelineSettings, normalizeTimelineSettings } = runInNewContext(
  `${recorderSource.slice(recorderSource.indexOf('    function getCanvasStroke('), recorderSource.indexOf('    function wait('))}
  ({ buildTimelineSchedule, createTimelineSettings, normalizeTimelineSettings })`);
const canvas = { selector: '#interactionCanvas', tagName: 'canvas' };
const path = [
  { type: 'mousedown', timestamp: 100, x: 10, y: 20, target: canvas, button: 0, buttons: 1 },
  { type: 'mousemove', timestamp: 200, x: 30, y: 40, target: canvas, button: -1, buttons: 1 },
  { type: 'mouseup', timestamp: 300, x: 50, y: 60, target: canvas, button: 0, buttons: 0 },
];

test('page shortcuts ignore editable fields inside the recorder shadow root', () => {
  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class {};
  try {
    const field = new HTMLElement();
    field.disabled = false;
    field.isContentEditable = false;
    field.matches = selector => selector === 'input, textarea, select';
    const panel = new HTMLElement();
    panel.matches = () => false;
    const app = { simulation: { enabled: false }, resetView: () => assert.fail('typing in a field reset the view') };
    App.prototype._onKeyDown.call(app, {
      key: '0', target: panel, composedPath: () => [field, panel],
    });
    app.resetView = () => { app.reset = true; };
    App.prototype._onKeyDown.call(app, { key: '0', target: panel, composedPath: () => [panel] });
    assert.equal(app.reset, true);
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }
});

test('timeline trim crops and rebases events without moving retained points', () => {
  const schedule = buildTimelineSchedule(path, {
    enabled: true, trimStart: 50, trimEnd: 180, spawnAt: 70, stampAt: 120,
    position: 'path', x: 2, y: -3,
  });
  const press = schedule.find(item => item.kind === 'press');
  const move = schedule.find(item => item.entry?.type === 'mousemove');
  const spawn = schedule.find(item => item.kind === 'spawn');
  const stamp = schedule.find(item => item.kind === 'stamp');
  const release = schedule.find(item => item.entry?.type === 'mouseup');
  assert.deepEqual([press.at, press.entry.x, press.entry.y], [0, 20, 30]);
  assert.deepEqual([move.at, move.entry.x, move.entry.y], [50, 30, 40]);
  assert.deepEqual([spawn.at, spawn.x, spawn.y, spawn.deferStamp], [20, 26, 31, true]);
  assert.deepEqual([stamp.at, stamp.x, stamp.y], [70, 34, 44]);
  assert.deepEqual([release.at, release.entry.x, release.entry.y], [130, 46, 56]);
});

test('timeline normalizes marker order and supports recorded-press spawn position', () => {
  const normalized = normalizeTimelineSettings(path, {
    enabled: true, trimStart: 50, trimEnd: 180, spawnAt: 20, stampAt: 10,
  });
  assert.deepEqual([normalized.trimStart, normalized.spawnAt, normalized.stampAt, normalized.trimEnd],
    [50, 50, 50, 180]);
  const click = buildTimelineSchedule(path, { ...normalized, position: 'click', x: 2, y: -3 })
    .find(item => item.kind === 'spawn');
  assert.deepEqual([click.x, click.y], [12, 17]);
});

test('legacy timeline defaults to full stroke with spawn and stamp at press', () => {
  const defaults = normalizeTimelineSettings(path, null, true);
  assert.deepEqual({ ...defaults }, {
    enabled: true, trimStart: 0, trimEnd: 200, spawnAt: 0, stampAt: 0,
    position: 'path', x: 0, y: 0,
  });
  assert.equal(createTimelineSettings(path, false).enabled, false);
});

test('direct recorder spawn replaces hover agents and stamps only after the spawn command', () => {
  const brush = Object.create(BoidBrush.prototype);
  const actions = [];
  const params = { color: '#123456' };
  brush._ready = true;
  brush._flatActive = false;
  brush._spawnOverrides = null;
  brush.app = {
    undoPushedThisStroke: false,
    getP: () => params,
    pushUndo: () => actions.push('undo'),
  };
  brush._clearAgents = () => actions.push('clear');
  brush._applyLifecycleAction = (action, config, x, y, pressure) => {
    assert.deepEqual([action, config, x, y, pressure], ['spawn', params, 20, 30, 0.5]);
    actions.push('spawn');
    return true;
  };
  brush._applySimVars = config => config;
  brush._stampInitialAgents = () => actions.push('stamp');

  brush.spawnFromRecorder(20, 30, 0.5);

  assert.deepEqual(actions, ['clear', 'spawn', 'undo', 'stamp']);
  assert.equal(brush.app.undoPushedThisStroke, true);
});

test('timeline recorder spawn advances agents without paint until stamp start', () => {
  const brush = Object.create(BoidBrush.prototype);
  const actions = [];
  const params = { color: '#123456' };
  brush._ready = true;
  brush._flatActive = false;
  brush._spawnOverrides = null;
  brush.sim = { readAgents: () => ({ count: 4 }) };
  brush.app = {
    undoPushedThisStroke: false,
    getP: () => params,
    pushUndo: () => actions.push('undo'),
  };
  brush._clearAgents = () => actions.push('clear');
  brush._applyLifecycleAction = () => { actions.push('spawn'); return true; };
  brush._applySimVars = config => config;
  brush._renderAgentRead = (read, config, options) => {
    assert.deepEqual([read.count, config, options.forceStamp], [4, params, true]);
    actions.push('stamp-current');
  };

  brush.spawnFromRecorder(20, 30, 0.5, { deferStamp: true });
  assert.deepEqual(actions, ['clear', 'spawn']);
  assert.equal(brush.app.undoPushedThisStroke, false);
  assert.equal(brush._recorderStamping, false);

  brush.startRecorderStamp(40, 50, 0.5);
  assert.deepEqual(actions, ['clear', 'spawn', 'undo', 'stamp-current']);
  assert.equal(brush.app.undoPushedThisStroke, true);
  assert.equal(brush._recorderStamping, true);
  assert.throws(() => brush.startRecorderStamp(40, 50, 0.5), /not pending/);
});

test('direct recorder spawn rejects an uninitialized Boid Brush', () => {
  const brush = Object.create(BoidBrush.prototype);
  brush._ready = false;
  assert.throws(() => brush.spawnFromRecorder(20, 30, 0.5), /not ready/);
});

test('direct recorder spawn does not acknowledge a failed spawn', () => {
  const brush = Object.create(BoidBrush.prototype);
  brush._ready = true;
  brush.app = { getP: () => ({}), pushUndo: () => assert.fail('no paint to undo') };
  brush._clearAgents = () => {};
  brush._applyLifecycleAction = () => false;
  assert.throws(() => brush.spawnFromRecorder(20, 30, 0.5), /no agents/);
});

test('recorder minimized mode keeps compact transport and save controls available', () => {
  assert.match(recorderSource, /id="minimizeButton"[^>]*aria-expanded="true"[^>]*>◀ Hide<\/button>/);
  assert.match(recorderSource, /id="compactRecord"[^>]*>●<\/button>/);
  assert.match(recorderSource, /id="compactPlay"[^>]*>▶ Start<\/button>/);
  assert.match(recorderSource, /id="compactStop"[^>]*>⏹ Stop<\/button>/);
  assert.match(recorderSource, /id="compactSave"[^>]*>💾<\/button>/);
  assert.match(recorderSource, /\.panel\.minimized \.panel-head \.title, \.panel\.minimized \.panel-body \{ display: none; \}/);
  assert.match(recorderSource, /timelineDrawer'\)\.classList\.toggle\('open', timelineDrawerOpen && !recorderMinimized\)/);
});