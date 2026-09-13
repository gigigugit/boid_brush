import test from 'node:test';
import assert from 'node:assert/strict';

import { EraserBrush, SimpleBrush } from '../brushes.js';

function makeContext() {
  return {
    canvas: { width: 800, height: 600 },
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
  };
}

function makeApp() {
  const ctx = makeContext();
  const layer = { canvas: ctx.canvas, ctx, dirty: false, alphaLock: false };
  const stamps = [];
  const params = {
    color: '#123456',
    flatStroke: false,
    trailBlur: 0,
    trailFlow: 0,
    smudge: 0,
    smudgeOnly: false,
    kmMix: false,
    kmStrength: 0,
    impasto: false,
    impastoStrength: 0,
    pressureSize: false,
    pressureOpacity: false,
    stampSize: 20,
    stampOpacity: 0.75,
    stampSeparation: 0,
    stampImageCanvas: null,
    stampImageRotation: 0,
    strokeAngleMode: 'auto',
  };
  return {
    DPR: 1,
    strokeFrame: 0,
    pressure: 1,
    undoPushedThisStroke: false,
    stamps,
    getP: () => params,
    getActiveLayer: () => layer,
    resolveStrokeAngle: (pathAngle, { fallbackAngle }) => pathAngle ?? fallbackAngle,
    pushUndo() {},
    recordBrushRenderTelemetry() {},
    compositeAllLayers() {},
    symStamp(targetCtx, x, y, size, color, opacity) {
      stamps.push({ operation: targetCtx.globalCompositeOperation, x, y, size, color, opacity });
    },
  };
}

function forceLegacy(brush) {
  brush._getBatchRendererSupport = () => ({ ok: false, reason: 'test fallback' });
}

test('SimpleBrush legacy fallback paints on pointer down', () => {
  const app = makeApp();
  const brush = new SimpleBrush(app);
  forceLegacy(brush);

  assert.doesNotThrow(() => brush.onDown(40, 60, 1));
  brush.onUp();

  assert.deepEqual(app.stamps, [{
    operation: 'source-over',
    x: 40,
    y: 60,
    size: 20,
    color: '#123456',
    opacity: 0.75,
  }]);
  assert.equal(app.getActiveLayer().dirty, true);
});

test('EraserBrush legacy fallback erases on pointer down', () => {
  const app = makeApp();
  const brush = new EraserBrush(app);
  forceLegacy(brush._inner);

  assert.doesNotThrow(() => brush.onDown(80, 100, 1));
  brush.onUp();

  assert.deepEqual(app.stamps, [{
    operation: 'destination-out',
    x: 80,
    y: 100,
    size: 20,
    color: '#000',
    opacity: 0.75,
  }]);
  assert.equal(app.getActiveLayer().ctx.globalCompositeOperation, 'source-over');
  assert.equal(app.getActiveLayer().dirty, true);
});
