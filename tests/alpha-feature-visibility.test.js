import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('production brush menu leaves only supported brushes visible by default', () => {
  for (const brush of ['boid', 'bristle', 'simple', 'eraser']) {
    assert.match(html, new RegExp(`<button data-brush="${brush}"(?![^>]*data-alpha-brush)`));
  }
  for (const brush of ['ant', 'motionPath', 'fluid', 'fluid3d']) {
    assert.match(html, new RegExp(`<button data-brush="${brush}"[^>]*data-alpha-brush`));
  }
});

test('alpha sections and settings toggles are present', () => {
  for (const section of ['quorum', 'taper', 'trailBlur', 'kmMix', 'impasto']) {
    assert.match(ui, new RegExp(`data-section="${section}"[^>]*data-alpha-feature`));
  }
  assert.match(ui, /id="showAlphaFeatures"/);
  assert.match(ui, /id="showJsonTab"/);
  assert.match(app, /bb_showAlphaFeatures/);
  assert.match(app, /bb_showJsonTab/);
});

test('JSON remains available while its tab starts hidden', () => {
  assert.match(
    html,
    /class="panel-tab panel-tab-hidden" data-panel-view="json" data-panel-target="rightPanel"/
  );
  assert.match(ui, /id="btnEditWorkspaceJson"/);
  assert.match(app, /_showWorkspaceJsonModal\(\)/);
});
