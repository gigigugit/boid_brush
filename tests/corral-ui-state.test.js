import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [html, app] = await Promise.all([
  readFile(new URL('app.html', root), 'utf8'),
  readFile(new URL('app.js', root), 'utf8'),
]);

test('corral overlay exposes persistent visibility and collapse controls', () => {
  assert.match(html, /id="corralVisibilityBtn"[^>]*aria-pressed="false"/);
  assert.match(html, /id="corralCollapseBtn"[^>]*aria-expanded="true"/);
  assert.match(html, /id="corralHudBody"/);
  assert.match(html, /#corralHud\.collapsed \.corral-body\{display:none;\}/);
});

test('corral toolbar is centered, single-line, and below panel tabs', () => {
  assert.match(html, /#corralHud\{[^}]*left:50%;[^}]*z-index:19;[^}]*transform:translateX\(-50%\)/);
  assert.match(html, /\.corral-card\{[^}]*justify-content:center;[^}]*width:max-content;[^}]*overflow-x:auto/);
  assert.match(html, /\.corral-body\{[^}]*flex-wrap:nowrap/);
  assert.match(html, /\.panel-tabs\{[^}]*z-index:21/);
});

test('corral control delivery uses the current cache token', () => {
  assert.match(html, /const assetVersion = '2026-09-11-corral-toolbar'/);
});

test('enabled corral keeps controls visible outside editor mode', () => {
  assert.match(app, /const showHud = available && \(this\.corral\.enabled \|\| this\.corral\.editing\)/);
  assert.match(app, /hud\?\.classList\.toggle\('open', showHud\)/);
});

test('corral boundary visibility and overlay collapse round-trip through session state', () => {
  assert.match(app, /controls\.corralVisible = this\.corral\.visible/);
  assert.match(app, /controls\.corralOverlayCollapsed = this\.corral\.overlayCollapsed/);
  assert.match(app, /id === 'corralVisible'/);
  assert.match(app, /id === 'corralOverlayCollapsed'/);
});

test('hiding the boundary does not disable containment', () => {
  assert.match(app, /if \(!this\.corral\.visible \|\| this\.activeBrush !== 'boid'/);
  assert.doesNotMatch(app, /this\.corral\.visible\s*=\s*this\.corral\.enabled/);
});
