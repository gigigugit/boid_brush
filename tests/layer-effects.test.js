import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  BLUR_SLIDER_MAX,
  LayerEffectRenderer,
  MAX_BLUR_RADIUS,
  MAX_NATIVE_BLUR_RADIUS,
  blurRadiusFromSlider,
  blurRadiusToSlider,
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
  assert.equal(normalizeLayerEffect({ type: 'blur', radius: 9999 }).radius, MAX_BLUR_RADIUS);
});

test('blur slider preserves exact low values and expands smoothly to the high maximum', () => {
  for (let radius = 0; radius <= 64; radius += 1) {
    assert.equal(blurRadiusFromSlider(radius), radius);
    assert.equal(blurRadiusToSlider(radius), radius);
  }
  assert.equal(blurRadiusFromSlider(BLUR_SLIDER_MAX), MAX_BLUR_RADIUS);
  assert.equal(blurRadiusToSlider(MAX_BLUR_RADIUS), BLUR_SLIDER_MAX);
  for (let position = 1; position <= BLUR_SLIDER_MAX; position += 1) {
    assert.ok(blurRadiusFromSlider(position) >= blurRadiusFromSlider(position - 1));
  }
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

  renderer.invalidate(layer);
  const refreshed = renderer.resolve(layer);
  assert.equal(refreshed.changed, true);
  assert.equal(created.length, 2);
  layer.dirty = false;

  layer.gpuPreviewCanvas = new FakeCanvas(200, 100);
  const previewFrame = renderer.resolve(layer);
  assert.equal(previewFrame.includesPreview, true);
  assert.equal(previewFrame.changed, true);
  assert.equal(created.length, 2);

  const committed = renderer.resolve(layer, { includePreview: false });
  assert.equal(committed.includesPreview, false);
  assert.equal(committed.changed, true);
});

test('very large blur downsamples work while preserving a full-size output', () => {
  const created = [];
  const renderer = new LayerEffectRenderer((width, height) => {
    const canvas = new FakeCanvas(width, height);
    created.push(canvas);
    return canvas;
  });
  const layer = {
    canvas: new FakeCanvas(1024, 512),
    dirty: true,
    _bbCssWidth: 512,
    effects: [{ id: 'blur', type: 'blur', radius: MAX_BLUR_RADIUS, opacity: 0.75 }],
  };

  const result = renderer.resolve(layer);
  assert.equal(result.canvas.width, 1024);
  assert.equal(result.canvas.height, 512);
  const downsampled = created.filter(canvas => canvas.width < 1024);
  assert.equal(downsampled.length, 2);
  assert.equal(downsampled[0].width, MAX_NATIVE_BLUR_RADIUS);
  assert.equal(downsampled[0].height, MAX_NATIVE_BLUR_RADIUS / 2);
  assert.equal(downsampled[1].context.draws.at(-1).filter, `blur(${MAX_NATIVE_BLUR_RADIUS}px)`);
  assert.equal(result.canvas.context.draws.at(-1).alpha, 0.75);

  layer.effects[0].radius = MAX_BLUR_RADIUS - 1;
  renderer.invalidate(layer);
  renderer.resolve(layer);
  assert.equal(created.length, 4);
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
