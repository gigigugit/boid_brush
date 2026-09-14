import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCorral,
  constrainAgentsToCorral,
  corralForceWeight,
  corralRepulsionWeight,
  corralToSvg,
  extractClosedSvgPath,
  normalizeEditableCorral,
  pointInCorral,
  sampleEditableCorral,
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

test('editable corrals preserve line, curve, and spline segments', () => {
  const anchors = normalizeEditableCorral([
    { x: 0, y: 0, segment: 'line' },
    { x: 100, y: 0, segment: 'curve' },
    { x: 100, y: 100, segment: 'spline' },
    { x: 0, y: 100, segment: 'invalid' },
  ]);
  assert.deepEqual(anchors.map(point => point.segment), ['line', 'curve', 'spline', 'spline']);
  const sampled = sampleEditableCorral(anchors, 4);
  assert.ok(sampled.length > anchors.length);
  assert.deepEqual(sampled[0], { x: 0, y: 0 });
  assert.ok(sampled.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.ok(compileCorral(sampled));
});

test('legacy point arrays normalize into editable spline anchors', () => {
  const anchors = normalizeEditableCorral(square);
  assert.equal(anchors.length, square.length);
  assert.ok(anchors.every(point => point.segment === 'spline'));
  assert.equal(pointInCorral(50, 50, sampleEditableCorral(anchors)), true);
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

test('corral repulsion is a smooth half-tunnel with no hard-edge dropoff', () => {
  assert.equal(corralRepulsionWeight(0, 32), 1);
  assert.equal(corralRepulsionWeight(32, 32), 0);
  assert.equal(corralRepulsionWeight(40, 32), 0);
  assert.ok(corralRepulsionWeight(8, 32) > corralRepulsionWeight(16, 32));
  const epsilon = 0.001;
  const wallSlope = (corralRepulsionWeight(epsilon, 32) - corralRepulsionWeight(0, 32)) / epsilon;
  const innerSlope = (corralRepulsionWeight(32, 32) - corralRepulsionWeight(32 - epsilon, 32)) / epsilon;
  assert.ok(Math.abs(wallSlope) < 0.001);
  assert.ok(Math.abs(innerSlope) < 0.001);
});

test('repulsion radius and force strength are independent', () => {
  const compiled = compileCorral(square);
  const outsideBand = new Float32Array([80, 50, 0, 0]);
  assert.equal(constrainAgentsToCorral({ buffer: outsideBand, count: 1, stride: 4 }, compiled, 1, 10), false);
  const insideBand = new Float32Array([80, 50, 0, 0]);
  assert.equal(constrainAgentsToCorral({ buffer: insideBand, count: 1, stride: 4 }, compiled, 1, 30), true);
  assert.ok(insideBand[2] < 0);
  const zeroForce = new Float32Array([99, 50, 0, 0]);
  assert.equal(constrainAgentsToCorral({ buffer: zeroForce, count: 1, stride: 4 }, compiled, 0, 30), false);
});

test('midpoint adjustment preserves smooth zero-slope hard-edge transition', () => {
  assert.equal(corralForceWeight(0, 40, 1), 1);
  assert.equal(corralForceWeight(20, 40, 1), 1);
  assert.equal(corralForceWeight(40, 40, 1), 0);
  const epsilon = 0.001;
  const wallSlope = (corralForceWeight(epsilon, 40, 1) - corralForceWeight(0, 40, 1)) / epsilon;
  assert.ok(Math.abs(wallSlope) < 0.001);
});

test('advanced edge forces add tangent steering and local velocity damping', () => {
  const compiled = compileCorral(square);
  const tangent = new Float32Array([99, 50, 0, 0]);
  constrainAgentsToCorral({ buffer: tangent, count: 1, stride: 4 }, compiled, {
    edgeStrength: 0,
    repulsionRadius: 20,
    tangentialForce: 1,
  });
  assert.ok(Math.abs(tangent[3]) > 0.9);

  const damped = new Float32Array([99, 50, 2, 3]);
  constrainAgentsToCorral({ buffer: damped, count: 1, stride: 4 }, compiled, {
    edgeStrength: 0,
    repulsionRadius: 20,
    normalDamping: 1,
    tangentialFriction: 1,
  });
  assert.ok(Math.hypot(damped[2], damped[3]) < 0.1);
});

test('hard edge can be disabled independently of interior repulsion', () => {
  const compiled = compileCorral(square);
  const buffer = new Float32Array([105, 50, 0, 0]);
  constrainAgentsToCorral({ buffer, count: 1, stride: 4 }, compiled, {
    hardEdge: false,
    edgeStrength: 1,
    repulsionRadius: 20,
  });
  assert.equal(buffer[0], 105);
  assert.ok(buffer[2] < 0);
});

test('edge attraction pulls agents toward the boundary from either side', () => {
    const compiled = compileCorral(square);
    const inside = new Float32Array([90, 50, 0, 0]);
    constrainAgentsToCorral({ buffer: inside, count: 1, stride: 4 }, compiled, {
      interactionMode: 'attract',
      edgeStrength: 1,
      repulsionRadius: 20,
    });
    assert.ok(inside[2] > 0);
    const outside = new Float32Array([110, 50, 0, 0]);
    constrainAgentsToCorral({ buffer: outside, count: 1, stride: 4 }, compiled, {
      interactionMode: 'attract',
      edgeStrength: 1,
      repulsionRadius: 20,
    });
    assert.ok(outside[2] < 0);
    assert.equal(outside[0], 110);
});

test('exclusion projects interior agents outside and redirects them away', () => {
    const compiled = compileCorral(square);
    const buffer = new Float32Array([90, 50, -4, 0]);
    constrainAgentsToCorral({ buffer, count: 1, stride: 4 }, compiled, {
      interactionMode: 'exclude',
      edgeStrength: 1,
      repulsionRadius: 20,
      restitution: 0.5,
    });
    assert.equal(pointInCorral(buffer[0], buffer[1], compiled.points), false);
    assert.ok(buffer[2] > 0);
});

test('center force, force noise, restitution, and speed limit shape interactions', () => {
    const compiled = compileCorral(square);
    const centered = new Float32Array([20, 50, 0, 0]);
    constrainAgentsToCorral({ buffer: centered, count: 1, stride: 4 }, compiled, {
      edgeStrength: 0,
      repulsionRadius: 0,
      centerForce: 1,
    });
    assert.ok(centered[0] === 20 && centered[2] > 0);

    const limited = new Float32Array([50, 50, 30, 40]);
    constrainAgentsToCorral({ buffer: limited, count: 1, stride: 4 }, compiled, {
      edgeStrength: 0,
      repulsionRadius: 0,
      maxSpeed: 5,
    });
    assert.ok(Math.abs(Math.hypot(limited[2], limited[3]) - 5) < 1e-6);

    const noisy = new Float32Array([95, 40, 0, 0]);
    constrainAgentsToCorral({ buffer: noisy, count: 1, stride: 4 }, compiled, {
      edgeStrength: 0,
      repulsionRadius: 20,
      forceNoise: 1,
    });
    assert.notEqual(noisy[3], 0);
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
