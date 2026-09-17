import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('right drawer exposes a boid-only Modulation tab with the complete editor', () => {
  assert.match(html, /data-panel-view="modulation" data-panel-target="rightPanel">Modulation<\/button>/);
  assert.match(html, /id="modulationPanel" class="panel-view" data-panel-view="modulation" data-brushes="boid"/);
  for (const id of [
    'modChannelMonitor',
    'modRouteList',
    'modRouteDetail',
    'modAddRouteBtn',
    'modChannelTuning',
    'modDiagnostics',
    'boidModMatrix',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="modInputEditorModal"/);
  assert.doesNotMatch(html, /id="modCurveEditorModal"/);
});

test('modulation curves use the Settings curve appearance and edit in place', () => {
  assert.match(ui, /class="pressure-curve-editor mod-curve-editor"/);
  assert.match(ui, /class="pressure-curve-canvas mod-curve-canvas"/);
  assert.match(ui, /class="pressure-curve-axis"/);
  assert.match(ui, /_wireModRouteCurveEditor\(app, container, route\.id\)/);
  assert.doesNotMatch(ui, /_openModCurveEditor/);
  assert.doesNotMatch(ui, /data-open-mod-curve/);
});

test('modulation state remains catalogued, persisted, and brush-gated', () => {
  assert.match(ui, /buildSettingsCatalog\(document\.getElementById\('modulationPanel'\)\)/);
  assert.match(ui, /document\.getElementById\('modulationPanel'\),/);
  assert.match(ui, /control\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
  assert.match(app, /\['boid', 'corral', 'modulation'\]\.forEach\(viewName => \{/);
  assert.match(app, /#modulationPanel input\[type="text"\]/);
});
