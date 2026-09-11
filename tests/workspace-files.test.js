import test from 'node:test';
import assert from 'node:assert/strict';
import { listSvgFiles } from '../workspace-files.js';

function directory(entries, permission = 'granted') {
  return {
    async queryPermission() { return permission; },
    async *entries() {
      for (const entry of entries) yield entry;
    },
  };
}

test('folder tree lists only SVG files in stable order', async () => {
  const files = await listSvgFiles(directory([
    ['z.svg', { kind: 'file' }],
    ['notes.txt', { kind: 'file' }],
    ['folder', directory([])],
    ['a.SVG', { kind: 'file' }],
  ]));
  assert.deepEqual(files.map(file => file.name), ['a.SVG', 'z.svg']);
});

test('folder tree fails closed without permission and respects entry cap', async () => {
  assert.deepEqual(await listSvgFiles(directory([['a.svg', { kind: 'file' }]], 'denied')), []);
  const files = await listSvgFiles(directory([
    ['a.svg', { kind: 'file' }],
    ['b.svg', { kind: 'file' }],
  ]), { maxEntries: 1 });
  assert.equal(files.length, 1);
});

test('folder tree recursively exposes SVG assets with bounded paths', async () => {
  const nested = directory([['shape.svg', { kind: 'file' }]]);
  nested.kind = 'directory';
  const files = await listSvgFiles(directory([['common', nested]]));
  assert.deepEqual(files.map(file => file.path), ['common/shape.svg']);
  assert.equal(files[0].depth, 1);
});
