import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOID_VARIANCE_COUNT,
  BOID_VARIANCE_FIELDS,
  readBoidVariances,
  writeBoidVariances,
} from '../boid-parameter-contract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('boid variance fields are independent and exclude count/select/boolean controls', () => {
  const keys = BOID_VARIANCE_FIELDS.map(field => field.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(BOID_VARIANCE_COUNT, 21);
  for (const excluded of ['count', 'leaderCount', 'sensingEnabled', 'sensingMode', 'quorumThreshold']) {
    assert.equal(keys.includes(excluded), false);
  }
});

test('variance packing preserves distinct WASM and WebGPU append offsets', () => {
  const params = {
    variances: { seek: 0.25, neighborRadius: 0.5 },
    leader: { variances: { seek: 0.75, neighborRadius: 1 } },
  };
  const wasm = new Float32Array(130).fill(-1);
  const gpu = new Float32Array(131).fill(-1);
  assert.equal(writeBoidVariances(wasm, params, 88), 130);
  assert.equal(writeBoidVariances(gpu, params, 89), 131);
  assert.equal(wasm[88], 0.25);
  assert.equal(gpu[89], 0.25);
  assert.equal(wasm[88 + BOID_VARIANCE_COUNT], 0.75);
  assert.equal(gpu[89 + BOID_VARIANCE_COUNT], 0.75);
  assert.equal(readBoidVariances(params)[18], 0.5);
  assert.equal(readBoidVariances(params, true)[18], 1);
});

test('variance values clamp and missing values preserve zero-variance behavior', () => {
  const values = readBoidVariances({ variances: { seek: -2, cohesion: 4 } });
  assert.equal(values[0], 0);
  assert.equal(values[1], 1);
  assert.ok(values.slice(2).every(value => value === 0));
});

test('dedicated Boid panel mirrors canonical radii instead of persisting panel copies', () => {
  const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /data-panel-view="boid"/);
  assert.match(html, /id="boidPanel"/);
  assert.match(ui, /sliderRow\('neighborRadius'/);
  assert.match(ui, /\['am_neighborRadius', 'neighborRadius'\]/);
  assert.match(app, /neighborRadius: val\('neighborRadius'\)/);
  assert.doesNotMatch(app, /neighborRadius: val\('am_neighborRadius'\)/);
});
