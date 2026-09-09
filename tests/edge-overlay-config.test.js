import test from 'node:test';
import assert from 'node:assert/strict';

import { EDGE_OVERLAY_CONTROLS, resolveEdgeOverlayLayout } from '../ui.js';

test('edge overlay registry exposes every supported control exactly once', () => {
  assert.deepEqual(
    EDGE_OVERLAY_CONTROLS.map(control => control.key),
    ['brushScale', 'stampOpacity', 'stampSize', 'seek', 'wander', 'flowField']
  );
  assert.equal(new Set(EDGE_OVERLAY_CONTROLS.map(control => control.visibilityId)).size, EDGE_OVERLAY_CONTROLS.length);
});

test('edge overlay defaults preserve Scale and Opacity on the left', () => {
  const layout = resolveEdgeOverlayLayout();
  assert.deepEqual(layout.left.map(control => control.key), ['brushScale', 'stampOpacity']);
  assert.deepEqual(layout.right, []);
});

test('edge overlay selection can be placed on both sides', () => {
  const layout = resolveEdgeOverlayLayout({
    placement: 'both',
    visible: {
      brushScale: false,
      stampOpacity: false,
      stampSize: true,
      seek: true,
      wander: true,
      flowField: true,
    },
  });
  const expected = ['stampSize', 'seek', 'wander', 'flowField'];
  assert.deepEqual(layout.left.map(control => control.key), expected);
  assert.deepEqual(layout.right.map(control => control.key), expected);
});
