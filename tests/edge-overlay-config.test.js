import test from 'node:test';
import assert from 'node:assert/strict';

import { EDGE_OVERLAY_CONTROLS, resolveEdgeOverlayLayout } from '../ui.js';

test('edge overlay registry exposes every supported control exactly once', () => {
  assert.deepEqual(
    EDGE_OVERLAY_CONTROLS.map(control => control.key),
    ['brushScale', 'stampOpacity', 'stampSize', 'seek', 'wander', 'flowField']
  );
  assert.equal(new Set(EDGE_OVERLAY_CONTROLS.map(control => control.placementId)).size, EDGE_OVERLAY_CONTROLS.length);
});

test('edge overlay defaults show Opacity, Stamp Size, and Seek on the left', () => {
  const layout = resolveEdgeOverlayLayout();
  assert.deepEqual(layout.left.map(control => control.key), ['stampOpacity', 'stampSize', 'seek']);
  assert.deepEqual(layout.right, []);
});

test('edge overlay controls choose their sides independently', () => {
  const layout = resolveEdgeOverlayLayout({
    placements: {
      brushScale: 'right',
      stampOpacity: 'hidden',
      stampSize: 'left',
      seek: 'right',
      wander: 'hidden',
      flowField: 'left',
    },
  });
  assert.deepEqual(layout.left.map(control => control.key), ['stampSize', 'flowField']);
  assert.deepEqual(layout.right.map(control => control.key), ['brushScale', 'seek']);
  assert.deepEqual(
    layout.left.filter(control => layout.right.includes(control)),
    []
  );
});

test('invalid placement is hidden rather than duplicated', () => {
  const layout = resolveEdgeOverlayLayout({
    placements: { brushScale: 'both' },
  });
  assert.equal(layout.left.some(control => control.key === 'brushScale'), false);
  assert.equal(layout.right.some(control => control.key === 'brushScale'), false);
});
