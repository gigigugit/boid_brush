import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCorral,
  constrainAgentsToCorral,
  corralToSvg,
  pointInCorral,
  smoothClosedCorral,
} from '../corral.js';

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

test('corral SVG export emits one closed path and the canvas viewBox', () => {
  const svg = corralToSvg(square, 640, 480);
  assert.match(svg, /viewBox="0 0 640 480"/);
  assert.match(svg, /<path[^>]+ Z"/);
});
