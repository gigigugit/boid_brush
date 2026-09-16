import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [html, app, ui] = await Promise.all([
  readFile(new URL('app.html', root), 'utf8'),
  readFile(new URL('app.js', root), 'utf8'),
  readFile(new URL('ui.js', root), 'utf8'),
]);

test('one global control collapses every simulation and corral overlay', () => {
  assert.match(html, /id="corralVisibilityBtn"[^>]*aria-pressed="false"/);
  assert.match(html, /id="globalOverlayCollapseBtn"[^>]*aria-expanded="true"/);
  assert.match(html, /body\.overlays-collapsed #simHud,body\.overlays-collapsed #simPlaybackBar,body\.overlays-collapsed #corralHud/);
  assert.match(html, /id="globalOverlayRunBtn"/);
  assert.match(html, /id="globalOverlayStopBtn"/);
  assert.match(html, /id="corralHudBody"/);
  assert.doesNotMatch(html, /id="corralCollapseBtn"/);
  assert.doesNotMatch(html, /id="simHudCollapseBtn"/);
});

test('corral overlay is a horizontal toolbar directly below the top bar', () => {
  assert.match(html, /#corralHud\{[^}]*left:150px;[^}]*right:0;[^}]*top:calc\(var\(--topbar-h\) \+ 8px\)/);
  assert.match(html, /\.corral-card\{[^}]*width:100%/);
  assert.match(html, /\.corral-main\{[^}]*align-items:center;[^}]*overflow-x:auto;[^}]*white-space:nowrap/);
  assert.match(html, /\.panel-tabs\{[^}]*z-index:21/);
  assert.doesNotMatch(html, /class="corral-drawers"/);
});

test('corral control delivery uses a build-matched current cache token', () => {
  const assetVersion = html.match(/const assetVersion = '([^']+)'/)?.[1];
  const appBuildId = app.match(/const APP_BUILD_ID = '([^']+)'/)?.[1];
  assert.equal(assetVersion, '2026-09-14-corral-panel-toolbar');
  assert.equal(appBuildId, assetVersion);
});

test('enabled corral keeps controls visible outside editor mode', () => {
  assert.match(app, /const showHud = available && \(this\.corral\.enabled \|\| this\.corral\.editing\)/);
  assert.match(app, /hud\?\.classList\.toggle\('open', showHud\)/);
});

test('corral boundary visibility and overlay collapse round-trip through session state', () => {
  assert.match(app, /controls\.corralVisible = this\.corral\.visible/);
  assert.match(app, /controls\.corralOverlayCollapsed = this\.overlaysCollapsed/);
  assert.match(app, /id === 'corralVisible'/);
  assert.match(app, /id === 'corralOverlayCollapsed'/);
});

test('corral exposes separate path and editing action groups', () => {
  assert.match(html, /aria-label="Corral path tools"/);
  assert.match(html, /aria-label="Corral edit actions"/);
  assert.match(html, /aria-label="Corral simulation actions"/);
  for (const id of [
    'corralDrawBtn',
    'corralEditBtn',
    'corralAddPointBtn',
    'corralDeletePointBtn',
    'corralUndoBtn',
    'corralRedoBtn',
    'corralCopyBtn',
    'corralPasteBtn',
    'corralSegmentType',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /_undoCorralEdit\(\)/);
  assert.match(app, /_redoCorralEdit\(\)/);
  assert.match(app, /_copyCorral\(\)/);
  assert.match(app, /_pasteCorral\(\)/);
});

test('simulation overlays use the active simulation predicate', () => {
  assert.match(app, /const showOverlayHud = !!this\.simulation\.enabled && isMotion && overlayHudEnabled/);
  assert.match(app, /playbackBar\.classList\.toggle\('open', !!this\.simulation\.enabled && isMotion\)/);
  assert.match(app, /const simulationActive = !!this\.simulation\.enabled && this\._isMotionBrush\(\)/);
});

test('hiding the boundary does not disable containment', () => {
  assert.match(app, /if \(!this\.corral\.visible \|\| this\.activeBrush !== 'boid'/);
  assert.doesNotMatch(app, /this\.corral\.visible\s*=\s*this\.corral\.enabled/);
});

test('corral exposes and persists an independent repulsion radius', () => {
  assert.match(ui, /id="corralRepulsionRadius"[^>]*min="0" max="150"[^>]*value="32"/);
  assert.match(app, /corralRepulsionRadius: this\.corral\.repulsionRadius/);
  assert.match(app, /controls\.corralRepulsionRadius = Math\.round\(this\.corral\.repulsionRadius\)/);
  assert.match(app, /id === 'corralRepulsionRadius'/);
});

test('corral panel keeps the existing physics and SVG controls under persisted sections', () => {
  assert.match(ui, /id="corralPhysicsDrawerTab"[^>]*aria-expanded="\$\{physicsOpen \? 'true' : 'false'\}"/);
  assert.match(ui, /id="corralSvgDrawerTab"[^>]*aria-expanded="\$\{svgOpen \? 'true' : 'false'\}"/);
  assert.match(ui, /id="corralPhysicsDrawerTab"[^>]*role="button" tabindex="0"/);
  assert.match(app, /if \(event\.key !== 'Enter' && event\.key !== ' '\) return/);
  assert.match(app, /drawer\?\.classList\.toggle\('collapsed', !open\)/);
  assert.match(app, /tab\.classList\.toggle\('closed', !open\)/);
  assert.match(app, /controls\.corralPhysicsDrawerOpen = this\.corral\.physicsDrawerOpen/);
  assert.match(app, /controls\.corralSvgDrawerOpen = this\.corral\.svgDrawerOpen/);
  for (const id of [
    'corralHardEdge',
    'corralMidpointForce',
    'corralTangentialForce',
    'corralNormalDamping',
    'corralTangentialFriction',
    'corralShapeSmoothing',
    'corralFalloff',
    'corralInteractionMode',
    'corralCenterForce',
    'corralForceNoise',
    'corralRestitution',
    'corralMaxSpeed',
  ]) assert.match(ui, new RegExp(`id="${id}"`));
});

test('additional corral interactions flow through params and session state', () => {
  for (const key of [
    'InteractionMode',
    'CenterForce',
    'ForceNoise',
    'Restitution',
    'MaxSpeed',
  ]) {
    assert.match(app, new RegExp(`corral${key}: this\\.corral\\.`));
    assert.match(app, new RegExp(`id === 'corral${key}'`));
  }
});

test('corral SVG section supports path entry and permission-based folder browsing', () => {
  assert.match(ui, /id="corralSvgPathInput"/);
  assert.match(ui, /id="corralChooseDirectoryBtn"/);
  assert.match(ui, /id="corralFileTree"/);
  assert.match(ui, /id="corralSaveToDirectoryBtn"/);
  assert.match(app, /new CorralFileWorkspace\(\)/);
});
