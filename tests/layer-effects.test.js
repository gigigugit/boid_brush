import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  LayerEffectRenderer,
  hasActiveLayerEffects,
  normalizeLayerEffect,
  normalizeLayerEffects,
} from '../layer-effects.js';

class FakeContext {
  constructor() {
    this.draws = [];
    this.filter = 'none';
    this.globalAlpha = 1;
  }

  setTransform() {}
  clearRect() {}

  drawImage(source) {
    this.draws.push({
      source,
      filter: this.filter,
      alpha: this.globalAlpha,
    });
  }
}

class FakeCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.context = new FakeContext();
  }

  getContext() {
    return this.context;
  }
}

test('blur effect normalization clamps persisted values and rejects unknown effects', () => {
  assert.deepEqual(normalizeLayerEffect({
    id: ' blur-1 ',
    type: 'blur',
    name: ' Soft blur ',
    enabled: false,
    opacity: 3,
    radius: -10,
  }), {
    id: 'blur-1',
    type: 'blur',
    name: 'Soft blur',
    enabled: false,
    opacity: 1,
    radius: 0,
  });
  assert.equal(normalizeLayerEffect({ type: 'shadow' }), null);
  assert.deepEqual(normalizeLayerEffects([null, { type: 'shadow' }]), []);
  assert.equal(hasActiveLayerEffects({ effects: [{ type: 'blur', radius: 8, opacity: 1 }] }), true);
});

test('effect renderer caches committed blur but refreshes live preview frames', () => {
  const created = [];
  const renderer = new LayerEffectRenderer((width, height) => {
    const canvas = new FakeCanvas(width, height);
    created.push(canvas);
    return canvas;
  });
  const layer = {
    canvas: new FakeCanvas(200, 100),
    dirty: true,
    _bbCssWidth: 100,
    effects: [{ id: 'blur', type: 'blur', radius: 4, opacity: 0.5 }],
  };

  const first = renderer.resolve(layer);
  assert.equal(first.changed, true);
  assert.equal(first.includesPreview, false);
  assert.equal(first.canvas.context.draws.at(-1).filter, 'blur(8px)');
  assert.equal(first.canvas.context.draws.at(-1).alpha, 0.5);

  layer.dirty = false;
  const cached = renderer.resolve(layer);
  assert.equal(cached.canvas, first.canvas);
  assert.equal(cached.changed, false);

  layer.gpuPreviewCanvas = new FakeCanvas(200, 100);
  const previewFrame = renderer.resolve(layer);
  assert.equal(previewFrame.includesPreview, true);
  assert.equal(previewFrame.changed, true);
  assert.equal(created.length, 2);

  const committed = renderer.resolve(layer, { includePreview: false });
  assert.equal(committed.includesPreview, false);
  assert.equal(committed.changed, true);
});

test('application wiring persists effects and renders attached effect controls', () => {
  const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const uiSource = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  const htmlSource = fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8');

  assert.match(appSource, /effects: normalizeLayerEffects\(layer\.effects\)/);
  assert.match(appSource, /effects: normalizeLayerEffects\(layerState\.effects\)/);
  assert.match(appSource, /forceFull: forceFullComposite \|\| effectsChanged/);
  assert.match(uiSource, /id="btnAddBlurEffect"/);
  assert.match(uiSource, /effectRow\.className = 'layer-item effect-layer-item'/);
  assert.match(htmlSource, /\.effect-layer-item\{/);
});
