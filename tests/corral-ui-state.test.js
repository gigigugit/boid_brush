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
  assert.match(html, /#corralHud\.collapsed \.corral-body,#corralHud\.collapsed \.corral-drawers\{display:none;\}/);
});

test('corral toolbar is centered, single-line, and below panel tabs', () => {
  assert.match(html, /#corralHud\{[^}]*left:50%;[^}]*z-index:19;[^}]*transform:translateX\(-50%\)/);
  assert.match(html, /\.corral-main\{[^}]*justify-content:center;[^}]*overflow-x:auto/);
  assert.match(html, /\.corral-body\{[^}]*flex-wrap:nowrap/);
  assert.match(html, /\.panel-tabs\{[^}]*z-index:21/);
});

test('corral control delivery uses a build-matched current cache token', () => {
  const assetVersion = html.match(/const assetVersion = '([^']+)'/)?.[1];
  const appBuildId = app.match(/const APP_BUILD_ID = '([^']+)'/)?.[1];
  assert.equal(assetVersion, '2026-09-11-corral-drawer-actions');
  assert.equal(appBuildId, assetVersion);
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

test('corral exposes and persists an independent repulsion radius', () => {
  assert.match(html, /id="corralRepulsionRadius"[^>]*min="0" max="150"[^>]*value="32"/);
  assert.match(app, /corralRepulsionRadius: this\.corral\.repulsionRadius/);
  assert.match(app, /controls\.corralRepulsionRadius = Math\.round\(this\.corral\.repulsionRadius\)/);
  assert.match(app, /id === 'corralRepulsionRadius'/);
});

test('corral has two attached moving-tab drawers with advanced controls', () => {
  assert.match(html, /id="corralPhysicsDrawerTab"[^>]*aria-expanded="false"/);
  assert.match(html, /id="corralSvgDrawerTab"[^>]*aria-expanded="false"/);
  assert.match(app, /tab\.textContent = `\$\{label\} \$\{open \? '▲' : '▼'\}`/);
  for (const id of [
    'corralHardEdge',
    'corralMidpointForce',
    'corralTangentialForce',
    'corralNormalDamping',
    'corralTangentialFriction',
    'corralShapeSmoothing',
    'corralFalloff',
  ]) assert.match(html, new RegExp(`id="${id}"`));
});

test('SVG drawer supports path entry and permission-based folder browsing', () => {
  assert.match(html, /id="corralSvgPathInput"/);
  assert.match(html, /id="corralChooseDirectoryBtn"/);
  assert.match(html, /id="corralFileTree"/);
  assert.match(html, /id="corralSaveToDirectoryBtn"/);
  assert.match(app, /new CorralFileWorkspace\(\)/);
});
