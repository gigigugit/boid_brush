import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCorral,
  constrainAgentsToCorral,
  corralToSvg,
  extractClosedSvgPath,
  pointInCorral,
  smoothClosedCorral,
} from '../corral.js';
import { isSupportedByGpu } from '../webgpu-boid-sim.js';

const square = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

test('smoothClosedCorral creates a bounded closed contour', () => {
  const smoothed = smoothClosedCorral(square, 1);
  assert.equal(smoothed.length, 8);
  assert.ok(smoothed.every(point => point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100));
});

test('pointInCorral handles inside and outside points', () => {
  assert.equal(pointInCorral(50, 50, square), true);
  assert.equal(pointInCorral(150, 50, square), false);
});

test('corral constraint projects escaped agents inward and redirects velocity', () => {
  const compiled = compileCorral(square);
  const buffer = new Float32Array([120, 50, 4, 0]);
  const changed = constrainAgentsToCorral({ buffer, count: 1, stride: 4 }, compiled, 1);
  assert.equal(changed, true);
  assert.equal(pointInCorral(buffer[0], buffer[1], compiled.points), true);
  assert.ok(buffer[2] <= 0);
});

test('corral constraint leaves central agents unchanged', () => {
  const compiled = compileCorral(square);
  const buffer = new Float32Array([50, 50, 1, 2]);
  assert.equal(constrainAgentsToCorral({ buffer, count: 1, stride: 4 }, compiled, 1), false);
  assert.deepEqual([...buffer], [50, 50, 1, 2]);
});

test('corral constraint redirects only agents near the boundary', () => {
  const compiled = compileCorral(square);
  const buffer = new Float32Array([
    99, 50, 4, 0,
    50, 50, 1, 2,
  ]);
  constrainAgentsToCorral({ buffer, count: 2, stride: 4 }, compiled, 1);
  assert.ok(buffer[2] < 4);
  assert.deepEqual([...buffer.slice(4)], [50, 50, 1, 2]);
});

test('active corral uses synchronous simulation state', () => {
  assert.equal(isSupportedByGpu({ corralEnabled: true }), false);
  assert.equal(isSupportedByGpu({ corralEnabled: false }), true);
  assert.equal(isSupportedByGpu({}), true);
});

test('corral SVG export emits one closed path and the canvas viewBox', () => {
  const svg = corralToSvg(square, 640, 480);
  assert.match(svg, /viewBox="0 0 640 480"/);
  assert.match(svg, /<path[^>]+ Z"/);
});

test('corral SVG import accepts one closed path and rejects active content', () => {
  const parsed = extractClosedSvgPath('<svg viewBox="0 0 10 20"><path d="M0 0 L10 0 L10 20 Z"/></svg>');
  assert.equal(parsed.d, 'M0 0 L10 0 L10 20 Z');
  assert.deepEqual(parsed.viewBox, [0, 0, 10, 20]);
  assert.throws(
    () => extractClosedSvgPath('<svg viewBox="0 0 10 10"><script>alert(1)</script><path d="M0 0L1 1Z"/></svg>'),
    /not supported/,
  );
  assert.throws(
    () => extractClosedSvgPath('<svg viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>'),
    /closed/,
  );
});
