import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// These tests are static-source assertions (matching the convention used by
// alpha-feature-visibility.test.js and corral-ui-state.test.js) because the
// app has no jsdom dependency to render #boidPanel in Node. They pin down the
// wiring for: inline per-base-setting variance sub-rows in the wider Boid
// right drawer, the consolidated "Independent variance" accordion staying
// available but hidden by default, and a persisted toggle to re-show it —
// without disturbing the canonical sidebar, leader overrides, or the
// existing bidirectional proxy <-> canonical sync.

const ui = fs.readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8');

test('every independent-variance field can resolve a subordinate sub-setting beside its base control', () => {
  assert.match(ui, /const _BOID_VARIANCE_FIELD_BY_KEY = new Map\(BOID_VARIANCE_FIELDS\.map\(field => \[field\.key, field\]\)\)/);
  assert.match(ui, /function _boidVarianceSubrowMarkup\(baseId\)/);
  assert.match(ui, /function _boidProxyMarkupWithVariance\(source\)/);
  // The grid renderer and the sensing sliders both route through the
  // variance-aware wrapper instead of the bare proxy markup.
  assert.match(ui, /controls\.map\(_boidProxyMarkupWithVariance\)\.join\(''\)/);
  assert.match(ui, /const subrow = _boidVarianceSubrowMarkup\(id\);\s*\n\s*return subrow \? `<div class="boid-control-with-variance">\$\{base\}\$\{subrow\}<\/div>` : base;/);
  // The two base controls that previously existed outside the drawer's main
  // groups must also be present, otherwise their variance rows would only be
  // reachable through the hidden advanced accordion.
  assert.match(ui, /\['Forces', \[[^\]]*'quorumCompositeStrength'\]\]/);
  assert.match(ui, /\['Forces', \[[^\]]*'wanderSpeed'[^\]]*'quorumCompositeStrength'\]\]/);
  assert.doesNotMatch(ui, /\['Motion', \[[^\]]*'wanderSpeed'/);
  assert.match(ui, /\['Motion', \[[^\]]*'simBoundsMargin'\]\]/);
  // Quorum remains governed by the existing alpha-feature visibility switch.
  assert.match(ui, /source\.closest\('\[data-alpha-feature\]'\)/);
  assert.match(ui, /data-alpha-feature/);
});

test('the consolidated Independent variance accordion is retained but hidden by default', () => {
  assert.match(ui, /const BOID_VARIANCE_ACCORDION_TITLE = 'Independent variance'/);
  assert.match(ui, /\['Independent variance', BOID_VARIANCE_FIELDS\.map\(field => field\.controlId\)\]/);
  assert.match(ui, /function _boidVarianceAccordionVisible\(\)/);
  assert.match(ui, /localStorage\.getItem\(BOID_VARIANCE_ACCORDION_STORAGE_KEY\) === 'true'/);
  assert.match(ui, /const accordionHiddenClass = isVarianceAccordion && !varianceAccordionVisible \? ' boid-variance-accordion-hidden' : ''/);
  assert.match(html, /\.boid-variance-accordion-hidden\{display:none!important;\}/);
});

test('a subtle, persisted toggle can re-enable the consolidated advanced view', () => {
  assert.match(ui, /const BOID_VARIANCE_ACCORDION_STORAGE_KEY = 'bb_showBoidVarianceAccordion'/);
  assert.match(ui, /id="showBoidVarianceAccordion"\$\{varianceAccordionVisible \? ' checked' : ''\}/);
  assert.match(ui, /function _setBoidVarianceAccordionVisible\(visible\)/);
  assert.match(ui, /localStorage\.setItem\(BOID_VARIANCE_ACCORDION_STORAGE_KEY, String\(!!visible\)\)/);
  assert.match(ui, /varianceAccordionToggle\?\.addEventListener\('change', \(\) => \{/);
  assert.match(ui, /panel\.querySelectorAll\('\[data-boid-variance-accordion\]'\)\.forEach\(el => el\.classList\.toggle\('boid-variance-accordion-hidden', !visible\)\)/);
  assert.match(html, /\.boid-variance-accordion-toggle\{/);
});

test('canonical sidebar variance controls, leader overrides, and the contract are untouched', () => {
  // Canonical left sidebar still owns the persisted per-parameter sliders and
  // its own (unhidden) independent-variance list.
  assert.match(ui, /\$\{_buildIndependentVarianceRows\(\)\}/);
  assert.match(ui, /function _buildLeaderVarianceRows\(\)/);
  assert.match(ui, /\$\{_buildLeaderOverrideRows\(\)\}/);
  assert.match(ui, /\$\{_buildLeaderVarianceRows\(\)\}/);
  // syncBoidPanel remains a generic proxy <-> canonical sync sweep, so it
  // keeps working for every proxy copy of a control (inline sub-setting,
  // advanced accordion, or both at once).
  assert.match(ui, /export function syncBoidPanel\(\) \{\s*\n\s*document\.querySelectorAll\('#boidPanel \[data-boid-control\]'\)\.forEach\(proxy => \{/);
  assert.match(ui, /document\.querySelectorAll\(`#boidPanel \[data-boid-value="\$\{source\.id\}"\]`\)\.forEach\(value => \{/);
});

test('the new drawer toggle is presentation-only and does not leak into canonical session persistence', () => {
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  // Session snapshot/restore walk #sidebar and #settingsPanel only; #boidPanel
  // controls (proxies and this toggle alike) are deliberately out of scope so
  // the canonical control stays the single source of truth.
  assert.doesNotMatch(app, /#boidPanel[^`]*input\[type="checkbox"\]/);
  assert.doesNotMatch(ui, /data-boid-control="showBoidVarianceAccordion"/);
});
