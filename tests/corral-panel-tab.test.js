import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('right drawer exposes a dedicated Corral tab and panel host', () => {
  assert.match(html, /class="panel-tab panel-tab-hidden" data-panel-view="corral" data-panel-target="rightPanel">Corral<\/button>/);
  assert.match(html, /<div id="corralPanel" class="panel-view" data-panel-view="corral"><\/div>/);
  assert.match(html, /#sidebar,#favoritesPanel,#settingsPanel,#modulationPanel,#jsonPanel,#boidPanel,#corralPanel/);
  assert.match(html, /body:has\(#boidPanel\.active\)\{--right-panel-open-w:min\(92vw,520px\);\}/);
  assert.match(html, /body:has\(#corralPanel\.active\)\{--right-panel-open-w:min\(92vw,520px\);\}/);
});

test('corral physics and SVG controls live in the drawer panel, not duplicated in the overlay', () => {
  assert.match(ui, /export function buildCorralPanel\(app\)/);
  for (const id of [
    'corralEdgeStrength',
    'corralRepulsionRadius',
    'corralSvgPathInput',
    'corralChooseDirectoryBtn',
    'corralSaveToDirectoryBtn',
  ]) assert.match(ui, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="corralEdgeStrength"/);
  assert.doesNotMatch(html, /id="corralSvgPathInput"/);
});

test('app builds and brush-gates the Corral drawer tab alongside the Boid tab', () => {
  assert.match(app, /buildSidebar\(this\);\s*\n\s*buildBoidPanel\(this\);\s*\n\s*buildCorralPanel\(this\);/);
  assert.match(app, /\['boid', 'corral', 'modulation'\]\.forEach\(viewName => \{/);
  assert.match(app, /data-panel-view="\$\{viewName\}"/);
});
