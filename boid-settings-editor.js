// =============================================================================
// boid-settings-editor.js — Boid Agent Settings Editor
//
// A centred modal panel with:
//   • live stamp preview (top-left, 1/3 panel width, square)
//   • grouped controls in columns (right 2/3)
//   • Apply / Reset / Undo / Redo / Apply & Close / Close Without Applying
//   • blurred backdrop over all page layers
//   • full app-wide settings propagation on Apply
// =============================================================================

const MODAL_ID = 'boidAgentEditorModal';
const MAX_UNDO = 50;

// ─── Parameter group definitions ────────────────────────────────────────────

const BOID_PARAM_GROUPS = [
  {
    id: 'swarm',
    label: 'Swarm',
    icon: '🐦',
    params: [
      { id: 'brushScale', type: 'range', label: 'Brush Scale', min: 10, max: 300, def: 100, fmt: v => (v / 100).toFixed(1) + '×' },
      { id: 'count',      type: 'range', label: 'Count',       min: 3,  max: 200, def: 60 },
    ],
  },
  {
    id: 'spawn',
    label: 'Spawn',
    icon: '🌱',
    params: [
      { id: 'spawnShape', type: 'select', label: 'Shape', options: [
        ['circle', '● Circle'], ['ring', '◎ Ring'], ['gaussian', '☁ Gaussian'],
        ['line', '═ Line'], ['ellipse', '⬮ Ellipse'], ['diamond', '◆ Diamond'],
        ['grid', '▥ Grid'], ['sunburst', '✱ Sunburst'], ['spiral', '≋ Spiral'],
        ['poisson', '⁘ Poisson'], ['random_cluster', '✦ Clusters'],
        ['burst', '💥 Burst'], ['lemniscate', '∞ Lemniscate'],
        ['phyllotaxis', '🌻 Phyllotaxis'], ['noise_scatter', '🌧 Noise Scatter'],
        ['bullseye', '🎯 Bullseye'], ['cross', '✚ Cross'],
        ['wave', '〜 Wave'], ['voronoi', '⬡ Voronoi'],
      ] },
      { id: 'spawnRadius',        type: 'range', label: 'Radius',          min: 5,  max: 200, def: 5 },
      { id: 'spawnAngle',         type: 'range', label: 'Angle',           min: 0,  max: 360, def: 0,  fmt: v => v + '°' },
      { id: 'spawnJitter',        type: 'range', label: 'Jitter',          min: 0,  max: 100, def: 0,  fmt: v => (v / 100).toFixed(2) },
      { id: 'pressureSpawnRadius', type: 'check', label: 'Pressure → Radius' },
    ],
  },
  {
    id: 'forces',
    label: 'Forces',
    icon: '⚡',
    params: [
      { id: 'seek',        type: 'range', label: 'Seek',        min: 0, max: 100, def: 75,  fmt: v => (v / 100).toFixed(2) },
      { id: 'cohesion',    type: 'range', label: 'Cohesion',    min: 0, max: 100, def: 15,  fmt: v => (v / 100).toFixed(2) },
      { id: 'separation',  type: 'range', label: 'Separation',  min: 0, max: 100, def: 15,  fmt: v => (v / 100).toFixed(2) },
      { id: 'alignment',   type: 'range', label: 'Alignment',   min: 0, max: 100, def: 20,  fmt: v => (v / 100).toFixed(2) },
      { id: 'jitter',      type: 'range', label: 'Jitter',      min: 0, max: 100, def: 0,   fmt: v => (v / 100).toFixed(2) },
      { id: 'wander',      type: 'range', label: 'Wander',      min: 0, max: 100, def: 0,   fmt: v => (v / 100).toFixed(2) },
      { id: 'wanderSpeed', type: 'range', label: 'Wander Spd',  min: 1, max: 100, def: 30,  fmt: v => (v / 100).toFixed(2) },
      { id: 'fov',         type: 'range', label: 'FOV',         min: 30, max: 360, def: 115, fmt: v => v + '°' },
      { id: 'flowField',   type: 'range', label: 'Flow Field',  min: 0, max: 100, def: 0,   fmt: v => (v / 100).toFixed(2) },
      { id: 'fleeRadius',  type: 'range', label: 'Flee Radius', min: 0, max: 150, def: 0 },
      { id: 'individuality', type: 'range', label: 'Individuality', min: 0, max: 100, def: 0, fmt: v => (v / 100).toFixed(2) },
    ],
  },
  {
    id: 'motion',
    label: 'Motion',
    icon: '💨',
    params: [
      { id: 'maxSpeed', type: 'range', label: 'Max Speed', min: 1,  max: 30,  def: 8,  fmt: v => (v / 2).toFixed(1) },
      { id: 'damping',  type: 'range', label: 'Damping',   min: 80, max: 100, def: 95, fmt: v => (v / 100).toFixed(2) },
    ],
  },
  {
    id: 'variance',
    label: 'Variance',
    icon: '📊',
    params: [
      { id: 'sizeVar',    type: 'range', label: 'Size',       min: 0, max: 100, def: 0, fmt: v => (v / 100).toFixed(2) },
      { id: 'opacityVar', type: 'range', label: 'Opacity',    min: 0, max: 100, def: 0, fmt: v => (v / 100).toFixed(2) },
      { id: 'speedVar',   type: 'range', label: 'Speed',      min: 0, max: 100, def: 0, fmt: v => (v / 100).toFixed(2) },
      { id: 'forceVar',   type: 'range', label: 'Force',      min: 0, max: 100, def: 0, fmt: v => (v / 100).toFixed(2) },
      { id: 'hueVar',     type: 'range', label: 'Hue',        min: 0, max: 100, def: 0, fmt: v => (v / 100).toFixed(2) },
      { id: 'satVar',     type: 'range', label: 'Saturation', min: 0, max: 100, def: 0, fmt: v => (v / 100).toFixed(2) },
      { id: 'litVar',     type: 'range', label: 'Lightness',  min: 0, max: 100, def: 0, fmt: v => (v / 100).toFixed(2) },
    ],
  },
  {
    id: 'stamp',
    label: 'Stamp',
    icon: '🔴',
    params: [
      { id: 'stampSize',       type: 'range', label: 'Size',        min: 1,  max: 200, def: 6 },
      { id: 'stampOpacity',    type: 'range', label: 'Opacity',     min: 1,  max: 100, def: 15, fmt: v => v + '%' },
      { id: 'stampSeparation', type: 'range', label: 'Separation',  min: 0,  max: 50,  def: 0 },
      { id: 'smudge',          type: 'range', label: 'Smudge',      min: 0,  max: 100, def: 0,  fmt: v => (v / 100).toFixed(2) },
      { id: 'stabilizer',      type: 'range', label: 'Stabilizer',  min: 0,  max: 100, def: 0,  fmt: v => (v / 100).toFixed(2) },
      { id: 'pressureSize',    type: 'check', label: 'Pressure → Size' },
      { id: 'pressureOpacity', type: 'check', label: 'Pressure → Opacity' },
      { id: 'smudgeOnly',      type: 'check', label: 'Smudge Only' },
      { id: 'flatStroke',      type: 'check', label: 'Flat Stroke' },
    ],
  },
  {
    id: 'taper',
    label: 'Taper',
    icon: '✏️',
    params: [
      { id: 'taperLength',  type: 'range', label: 'Length', min: 0, max: 100, def: 0 },
      { id: 'taperCurve',   type: 'range', label: 'Curve',  min: 0, max: 100, def: 50, fmt: v => (v / 100).toFixed(2) },
      { id: 'taperSize',    type: 'check', label: 'Taper Size' },
      { id: 'taperOpacity', type: 'check', label: 'Taper Opacity' },
    ],
  },
  {
    id: 'sensing',
    label: 'Sensing',
    icon: '👁',
    params: [
      { id: 'sensingEnabled',   type: 'check',  label: 'Enable Sensing' },
      { id: 'sensingMode',      type: 'select', label: 'Mode',    options: [['avoid', 'Avoid'], ['attract', 'Attract']] },
      { id: 'sensingChannel',   type: 'select', label: 'Channel', options: [
        ['darkness', 'Darkness'], ['lightness', 'Lightness'], ['saturation', 'Saturation'],
        ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue'], ['alpha', 'Alpha'],
      ] },
      { id: 'sensingStrength',  type: 'range', label: 'Strength',  min: 0, max: 100, def: 50, fmt: v => (v / 100).toFixed(2) },
      { id: 'sensingRadius',    type: 'range', label: 'Radius',    min: 1, max: 200, def: 40 },
      { id: 'sensingThreshold', type: 'range', label: 'Threshold', min: 0, max: 100, def: 30, fmt: v => (v / 100).toFixed(2) },
    ],
  },
  {
    id: 'visual',
    label: 'Visual',
    icon: '🎨',
    params: [
      { id: 'showBoids', type: 'check', label: 'Show Particles' },
      { id: 'showSpawn', type: 'check', label: 'Show Spawn Area' },
    ],
  },
];

// ─── State helpers ───────────────────────────────────────────────────────────

/** Read current sidebar values into a flat state snapshot. */
function _readState() {
  const state = {};
  for (const group of BOID_PARAM_GROUPS) {
    for (const p of group.params) {
      const el = document.getElementById(p.id);
      if (!el) {
        // Store default so we have a value
        if (p.type === 'check') state[p.id] = false;
        else if (p.type === 'select') state[p.id] = p.options?.[0]?.[0] ?? '';
        else state[p.id] = p.def ?? 0;
        continue;
      }
      if (p.type === 'check') state[p.id] = el.checked;
      else if (p.type === 'select') state[p.id] = el.value;
      else state[p.id] = +el.value;
    }
  }
  return state;
}

/** Write a state snapshot back to the sidebar DOM and invalidate params. */
function _writeStateToSidebar(state, app) {
  for (const group of BOID_PARAM_GROUPS) {
    for (const p of group.params) {
      const el = document.getElementById(p.id);
      if (!el) continue;
      if (p.type === 'check') {
        el.checked = !!state[p.id];
      } else if (p.type === 'select') {
        el.value = state[p.id] ?? el.value;
      } else {
        el.value = String(state[p.id] ?? el.value);
      }
      // Fire input + change so sidebar readouts and auto-save hooks update
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  app.invalidateParams();
  // Sync sidebar readout spans and edge sliders via the app's existing syncUI path
  app._maybeAutoSaveSession?.();
}

/** Deep clone a state object. */
function _cloneState(s) { return JSON.parse(JSON.stringify(s)); }

// ─── Preview rendering ───────────────────────────────────────────────────────

/**
 * Render a boid-like stamp preview into a <canvas>.
 * Draws a cluster of circular stamps arranged in a flowing arc to give
 * a quick visual sense of the current size / opacity / count settings.
 */
function _renderPreview(canvas, state, color) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d0f16';
  ctx.fillRect(0, 0, W, H);

  // Parse color
  let r = 120, g = 160, b = 240;
  if (color && color.startsWith('#') && color.length >= 7) {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
  }

  const scale = (state.brushScale ?? 100) / 100;
  const rawStampSize = state.stampSize ?? 6;
  const stampOpacity = (state.stampOpacity ?? 15) / 100;
  const count = Math.max(3, Math.min(state.count ?? 60, 60));
  const sizeVar = (state.sizeVar ?? 0) / 100;

  // Scale stamp size to fit preview nicely
  const maxRadius = W * 0.18;
  const minRadius = 1;
  const naturalRadius = rawStampSize * scale;
  const baseRadius = Math.max(minRadius, Math.min(maxRadius, naturalRadius));

  // Generate a boid-like cluster: arc + scatter
  const cx = W * 0.5;
  const cy = H * 0.52;
  const arcR = W * 0.32;
  const spread = Math.min(W * 0.22, arcR * 0.7);

  // Seed a deterministic "random" for stable preview
  let seed = 12345;
  const rng = () => { seed = (seed * 16807 + 0) % 2147483647; return (seed - 1) / 2147483646; };

  // Build positions: arc from left to right, with scatter
  const n = Math.min(count, 48);
  const stamps = [];
  const cohesion = (state.cohesion ?? 15) / 100;
  const jitterAmt = (state.jitter ?? 0) / 100;
  const individuality = (state.individuality ?? 0) / 100;

  for (let i = 0; i < n; i++) {
    const t = i / Math.max(n - 1, 1);
    // Arc angle: ~150° sweep
    const angle = -0.9 * Math.PI + t * 1.8 * Math.PI;
    // Cohesion pulls toward center; individuality scatters
    const scatterR = spread * (0.15 + (1 - cohesion) * 0.65 + individuality * 0.5) * (0.7 + rng() * 0.6);
    const noiseA = angle + (rng() - 0.5) * (0.5 + jitterAmt * 2);
    const px = cx + Math.cos(noiseA) * (arcR * (0.5 + cohesion * 0.5) + (rng() - 0.5) * scatterR);
    const py = cy + Math.sin(noiseA) * (arcR * 0.38 + (rng() - 0.5) * scatterR);
    const szMulti = 1 - sizeVar * 0.5 + rng() * sizeVar;
    const opMulti = 1 - (state.opacityVar ?? 0) / 100 * 0.5 + rng() * (state.opacityVar ?? 0) / 100;
    stamps.push({ x: px, y: py, r: baseRadius * szMulti, op: stampOpacity * opMulti });
  }

  // Draw taper (fades stamps at start/end if taperOpacity is on)
  const taperOpacity = !!(state.taperOpacity);
  const taperLength = (state.taperLength ?? 0) / 100;

  for (let i = 0; i < stamps.length; i++) {
    const { x, y, r, op } = stamps[i];
    const t = i / Math.max(stamps.length - 1, 1);
    let opFinal = Math.min(1, op);
    if (taperOpacity && taperLength > 0) {
      const tapT = Math.min(t, 1 - t) / (taperLength * 0.5 + 0.01);
      opFinal *= Math.min(1, tapT);
    }
    if (opFinal <= 0.002) continue;

    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${r_c(r)},${g_c(g)},${b_c(b)},${opFinal.toFixed(3)})`);
    grad.addColorStop(1, `rgba(${r_c(r)},${g_c(g)},${b_c(b)},0)`);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Spawn shape indicator (faint circle for spawn radius)
  const spawnR = Math.min((state.spawnRadius ?? 5) * scale * (W / 200), W * 0.42);
  ctx.strokeStyle = 'rgba(100,140,255,0.22)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, spawnR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Count badge
  ctx.fillStyle = 'rgba(80,120,255,0.55)';
  ctx.beginPath();
  ctx.arc(W * 0.08, H * 0.08, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(W * 0.04)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(state.count ?? 60), W * 0.08, H * 0.08);
}

/** Helper clampers so rgba doesn't get component names confused with vars. */
function r_c(v) { return Math.round(Math.max(0, Math.min(255, v))); }
function g_c(v) { return r_c(v); }
function b_c(v) { return r_c(v); }

// ─── Control builder ─────────────────────────────────────────────────────────

const CS = {
  group: 'margin-bottom:14px;',
  groupHead: [
    'display:flex;align-items:center;gap:6px;',
    'font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;',
    'color:#8099cc;margin-bottom:7px;padding-bottom:5px;',
    'border-bottom:1px solid rgba(255,255,255,0.07);',
  ].join(''),
  groupIcon: 'font-size:13px;',
  row: 'display:flex;flex-direction:column;gap:2px;margin-bottom:7px;',
  label: 'display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#c4d2ea;',
  val: 'font-size:11px;font-variant-numeric:tabular-nums;color:#8fb5f5;min-width:36px;text-align:right;',
  slider: [
    'width:100%;height:4px;border-radius:2px;accent-color:#4a80f0;',
    'cursor:pointer;margin-top:4px;',
  ].join(''),
  checkRow: 'display:flex;align-items:center;gap:7px;font-size:11px;color:#c4d2ea;cursor:pointer;margin-bottom:6px;user-select:none;',
  check: 'width:14px;height:14px;accent-color:#4a80f0;cursor:pointer;flex-shrink:0;',
  select: [
    'width:100%;background:rgba(18,20,32,0.92);border:1px solid rgba(255,255,255,0.12);',
    'border-radius:6px;color:#dce6ff;padding:5px 8px;font-size:11px;',
    'font-family:inherit;color-scheme:dark;cursor:pointer;margin-top:2px;',
  ].join(''),
};

function _buildGroupHtml(group) {
  let rows = '';
  for (const p of group.params) {
    if (p.type === 'range') {
      const fmtDisplay = p.fmt ? p.fmt(p.def ?? 0) : String(p.def ?? 0);
      rows += `
        <div style="${CS.row}">
          <div style="${CS.label}">
            <span>${p.label}</span>
            <span id="bse_v_${p.id}" style="${CS.val}">${fmtDisplay}</span>
          </div>
          <input type="range" id="bse_${p.id}"
            min="${p.min}" max="${p.max}" value="${p.def ?? 0}"
            style="${CS.slider}">
        </div>`;
    } else if (p.type === 'check') {
      rows += `
        <label style="${CS.checkRow}">
          <input type="checkbox" id="bse_${p.id}" style="${CS.check}">
          <span>${p.label}</span>
        </label>`;
    } else if (p.type === 'select') {
      const optHtml = (p.options || []).map(([v, l]) =>
        `<option value="${v}">${l}</option>`
      ).join('');
      rows += `
        <div style="${CS.row}">
          <div style="${CS.label}"><span>${p.label}</span></div>
          <select id="bse_${p.id}" style="${CS.select}">${optHtml}</select>
        </div>`;
    }
  }
  return `
    <div style="${CS.group}">
      <div style="${CS.groupHead}">
        <span style="${CS.groupIcon}">${group.icon}</span>
        <span>${group.label}</span>
      </div>
      ${rows}
    </div>`;
}

// ─── Main editor ─────────────────────────────────────────────────────────────

let _editorState = null;   // Current local (not-yet-applied) state
let _openState   = null;   // State when editor was opened (for Reset)
let _undoStack   = [];
let _redoStack   = [];
let _app         = null;
let _previewRaf  = null;
let _previewDirty = false;

/** Open (or bring to front) the editor. */
export function openBoidSettingsEditor(app) {
  _app = app;
  let modal = document.getElementById(MODAL_ID);
  if (!modal) modal = _buildModal();

  // Snapshot current sidebar state
  _editorState = _readState();
  _openState   = _cloneState(_editorState);
  _undoStack   = [];
  _redoStack   = [];

  // Populate editor controls from snapshot
  _populateControls(_editorState);
  _schedulePreview();

  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('bse-open'));
}

/** Build the modal DOM and attach it to <body>. */
function _buildModal() {
  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Boid Agent Settings Editor');

  // Split groups into two columns
  const mid = Math.ceil(BOID_PARAM_GROUPS.length / 2);
  const col1 = BOID_PARAM_GROUPS.slice(0, mid).map(_buildGroupHtml).join('');
  const col2 = BOID_PARAM_GROUPS.slice(mid).map(_buildGroupHtml).join('');

  modal.innerHTML = `
    <div id="bse-panel">
      <!-- Header -->
      <div id="bse-header">
        <div id="bse-title">
          <span style="font-size:18px;">🧬</span>
          <span>Boid Agent Settings</span>
        </div>
        <button id="bse-header-close" aria-label="Close without applying">✕</button>
      </div>

      <!-- Body -->
      <div id="bse-body">
        <!-- Left: stamp preview -->
        <div id="bse-preview-col">
          <div id="bse-preview-wrap">
            <canvas id="bse-preview-canvas"></canvas>
          </div>
          <div id="bse-preview-labels">
            <div class="bse-stat"><span class="bse-stat-k">Stamp</span><span id="bse-stat-size">—</span></div>
            <div class="bse-stat"><span class="bse-stat-k">Opacity</span><span id="bse-stat-opacity">—</span></div>
            <div class="bse-stat"><span class="bse-stat-k">Count</span><span id="bse-stat-count">—</span></div>
            <div class="bse-stat"><span class="bse-stat-k">Scale</span><span id="bse-stat-scale">—</span></div>
          </div>
          <div id="bse-preset-row">
            <span style="font-size:10px;color:#8099cc;font-weight:700;letter-spacing:.05em;text-transform:uppercase;">Quick Presets</span>
            <div id="bse-preset-btns"></div>
          </div>
        </div>

        <!-- Right: controls -->
        <div id="bse-controls-col">
          <div id="bse-controls-grid">
            <div class="bse-col">${col1}</div>
            <div class="bse-col">${col2}</div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div id="bse-footer">
        <div id="bse-footer-left">
          <button id="bse-btn-undo"  class="bse-btn bse-btn-ghost" disabled title="Undo last change (Ctrl+Z)">↩ Undo</button>
          <button id="bse-btn-redo"  class="bse-btn bse-btn-ghost" disabled title="Redo (Ctrl+Y)">↪ Redo</button>
          <button id="bse-btn-reset" class="bse-btn bse-btn-ghost" title="Reset to values when editor opened">⟳ Reset</button>
        </div>
        <div id="bse-footer-right">
          <button id="bse-btn-close"        class="bse-btn bse-btn-ghost">✕ Close</button>
          <button id="bse-btn-apply"         class="bse-btn bse-btn-accent">✓ Apply</button>
          <button id="bse-btn-apply-close"   class="bse-btn bse-btn-accent">✓ Apply &amp; Close</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  _injectStyles();
  _bindEvents(modal);
  _buildPresetButtons(modal);
  return modal;
}

function _injectStyles() {
  if (document.getElementById('bse-styles')) return;
  const style = document.createElement('style');
  style.id = 'bse-styles';
  style.textContent = `
    #${MODAL_ID} {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 210;
      align-items: center;
      justify-content: center;
      background: rgba(4,6,14,0.72);
      backdrop-filter: blur(14px) saturate(0.7);
      -webkit-backdrop-filter: blur(14px) saturate(0.7);
      opacity: 0;
      transition: opacity .18s ease;
    }
    #${MODAL_ID}.bse-open { opacity: 1; }

    #bse-panel {
      display: flex;
      flex-direction: column;
      width: clamp(640px, 60vw, 1160px);
      height: clamp(380px, calc(60vw / 1.618), calc(100vh - 60px));
      max-height: calc(100vh - 40px);
      background: linear-gradient(165deg, rgba(14,18,30,0.99), rgba(8,11,21,0.99));
      border: 1px solid rgba(80,120,220,0.2);
      border-radius: 16px;
      box-shadow: 0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04) inset;
      overflow: hidden;
    }

    /* Header */
    #bse-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
      flex-shrink: 0;
      background: rgba(255,255,255,0.02);
    }
    #bse-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 16px;
      font-weight: 700;
      color: #e8efff;
      letter-spacing: .01em;
    }
    #bse-header-close {
      background: none;
      border: none;
      color: #8099cc;
      font-size: 16px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      line-height: 1;
    }
    #bse-header-close:hover { background: rgba(255,255,255,0.08); color: #fff; }

    /* Body */
    #bse-body {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /* Preview column */
    #bse-preview-col {
      display: flex;
      flex-direction: column;
      width: 33.33%;
      flex-shrink: 0;
      border-right: 1px solid rgba(255,255,255,0.07);
      padding: 16px;
      gap: 12px;
      background: rgba(6,8,16,0.4);
      overflow-y: auto;
    }
    #bse-preview-wrap {
      width: 100%;
      aspect-ratio: 1;
      border-radius: 10px;
      overflow: hidden;
      background: #0d0f16;
      border: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    #bse-preview-canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    #bse-preview-labels {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .bse-stat {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 7px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .bse-stat-k {
      font-size: 9px;
      color: #6480a8;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .bse-stat span:last-child {
      font-size: 12px;
      font-weight: 600;
      color: #c2d4f0;
      font-variant-numeric: tabular-nums;
    }
    #bse-preset-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #bse-preset-btns {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .bse-preset-btn {
      font-size: 10px;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.05);
      color: #b8cae8;
      cursor: pointer;
      font-family: inherit;
      transition: background .12s;
    }
    .bse-preset-btn:hover {
      background: rgba(58,106,232,0.22);
      border-color: rgba(58,106,232,0.4);
      color: #dce8ff;
    }

    /* Controls column */
    #bse-controls-col {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      scrollbar-width: thin;
      scrollbar-color: rgba(80,120,220,0.3) transparent;
    }
    #bse-controls-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 28px;
      align-items: start;
    }
    .bse-col { min-width: 0; }

    /* Footer */
    #bse-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-top: 1px solid rgba(255,255,255,0.07);
      background: rgba(255,255,255,0.02);
      flex-shrink: 0;
      gap: 10px;
      flex-wrap: wrap;
    }
    #bse-footer-left, #bse-footer-right {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .bse-btn {
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 650;
      font-family: inherit;
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.12);
      transition: background .12s, opacity .12s;
    }
    .bse-btn:disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }
    .bse-btn-ghost {
      background: rgba(255,255,255,0.06);
      color: #cad8f0;
    }
    .bse-btn-ghost:hover:not(:disabled) {
      background: rgba(255,255,255,0.12);
      color: #fff;
    }
    .bse-btn-accent {
      background: linear-gradient(135deg, #3a6ae8, #5b8af0);
      border-color: rgba(117,162,255,0.45);
      color: #fff;
    }
    .bse-btn-accent:hover:not(:disabled) {
      background: linear-gradient(135deg, #4a78f4, #6a98ff);
    }

    /* Unsaved-changes indicator */
    #bse-title.bse-dirty::after {
      content: ' ●';
      color: #f0b040;
      font-size: 10px;
      vertical-align: super;
    }
  `;
  document.head.appendChild(style);
}

function _buildPresetButtons(modal) {
  const QUICK_PRESETS = [
    { label: 'Ink Wash',    values: { count: 25, seek: 40, cohesion: 15, separation: 50, alignment: 20, jitter: 0, wander: 0, wanderSpeed: 30, maxSpeed: 8, damping: 95, stampSize: 6, stampOpacity: 15 } },
    { label: 'Charcoal',   values: { count: 40, seek: 50, cohesion: 5,  separation: 60, alignment: 10, jitter: 20, wander: 10, wanderSpeed: 40, maxSpeed: 6, damping: 90, stampSize: 8, stampOpacity: 8 } },
    { label: 'Ribbon',     values: { count: 15, seek: 60, cohesion: 30, separation: 30, alignment: 40, jitter: 0, wander: 5, wanderSpeed: 20, maxSpeed: 12, damping: 97, stampSize: 4, stampOpacity: 20 } },
    { label: 'Galaxy',     values: { count: 80, seek: 20, cohesion: 40, separation: 20, alignment: 15, jitter: 10, wander: 30, wanderSpeed: 50, maxSpeed: 5, damping: 92, stampSize: 3, stampOpacity: 10 } },
    { label: 'Mist',       values: { count: 60, seek: 15, cohesion: 5,  separation: 10, alignment: 5,  jitter: 15, wander: 40, wanderSpeed: 60, maxSpeed: 3, damping: 85, stampSize: 12, stampOpacity: 4 } },
    { label: 'Edge Seek',  values: { count: 30, seek: 50, cohesion: 20, separation: 40, alignment: 25, jitter: 5,  wander: 10, wanderSpeed: 30, maxSpeed: 8, damping: 93, stampSize: 5,  stampOpacity: 18 } },
  ];

  const container = modal.querySelector('#bse-preset-btns');
  if (!container) return;

  for (const preset of QUICK_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'bse-preset-btn';
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      _pushUndo();
      Object.assign(_editorState, preset.values);
      _populateControls(_editorState);
      _markDirty();
      _schedulePreview();
    });
    container.appendChild(btn);
  }
}

function _bindEvents(modal) {
  // Close via backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) _closeEditor();
  });

  // Header close
  modal.querySelector('#bse-header-close').addEventListener('click', _closeEditor);

  // Footer buttons
  modal.querySelector('#bse-btn-close').addEventListener('click', _closeEditor);
  modal.querySelector('#bse-btn-reset').addEventListener('click', _doReset);
  modal.querySelector('#bse-btn-undo').addEventListener('click', _doUndo);
  modal.querySelector('#bse-btn-redo').addEventListener('click', _doRedo);
  modal.querySelector('#bse-btn-apply').addEventListener('click', _doApply);
  modal.querySelector('#bse-btn-apply-close').addEventListener('click', () => { _doApply(); _closeEditor(); });

  // Keyboard shortcuts
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') _closeEditor();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); _doUndo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); _doRedo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); _doApply(); }
  });

  // Wire all controls: on change (user finishes dragging) push undo; on input update state + preview
  for (const group of BOID_PARAM_GROUPS) {
    for (const p of group.params) {
      const el = modal.querySelector(`#bse_${p.id}`);
      if (!el) continue;

      if (p.type === 'range') {
        const valEl = modal.querySelector(`#bse_v_${p.id}`);
        el.addEventListener('input', () => {
          const v = +el.value;
          _editorState[p.id] = v;
          if (valEl) valEl.textContent = p.fmt ? p.fmt(v) : String(v);
          _markDirty();
          _schedulePreview();
        });
        el.addEventListener('change', () => _pushUndo());
      } else if (p.type === 'check') {
        el.addEventListener('change', () => {
          _pushUndo();
          _editorState[p.id] = el.checked;
          _markDirty();
          _schedulePreview();
        });
      } else if (p.type === 'select') {
        el.addEventListener('change', () => {
          _pushUndo();
          _editorState[p.id] = el.value;
          _markDirty();
          _schedulePreview();
        });
      }
    }
  }
}

// ─── Undo / redo ─────────────────────────────────────────────────────────────

function _pushUndo() {
  // Don't push duplicate states
  if (_undoStack.length > 0) {
    const top = _undoStack[_undoStack.length - 1];
    if (JSON.stringify(top) === JSON.stringify(_editorState)) return;
  }
  _undoStack.push(_cloneState(_editorState));
  _redoStack = [];
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  _refreshUndoRedoBtns();
}

function _doUndo() {
  if (!_undoStack.length) return;
  _redoStack.push(_cloneState(_editorState));
  _editorState = _undoStack.pop();
  _populateControls(_editorState);
  _refreshUndoRedoBtns();
  _schedulePreview();
}

function _doRedo() {
  if (!_redoStack.length) return;
  _undoStack.push(_cloneState(_editorState));
  _editorState = _redoStack.pop();
  _populateControls(_editorState);
  _refreshUndoRedoBtns();
  _schedulePreview();
}

function _refreshUndoRedoBtns() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  const u = modal.querySelector('#bse-btn-undo');
  const r = modal.querySelector('#bse-btn-redo');
  if (u) u.disabled = _undoStack.length === 0;
  if (r) r.disabled = _redoStack.length === 0;
}

// ─── Apply / Reset / Close ───────────────────────────────────────────────────

function _doApply() {
  if (!_app) return;
  // Push a pre-apply undo snapshot so "Undo" can revert an apply
  _pushUndo();
  _writeStateToSidebar(_editorState, _app);
  _app.showToast?.('✓ Boid settings applied');
  _clearDirty();
}

function _doReset() {
  if (!_openState) return;
  _pushUndo();
  _editorState = _cloneState(_openState);
  _populateControls(_editorState);
  _schedulePreview();
  _markDirty();
}

function _closeEditor() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.remove('bse-open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
  if (_previewRaf) { cancelAnimationFrame(_previewRaf); _previewRaf = null; }
}

// ─── State ↔ controls ────────────────────────────────────────────────────────

/** Write a state object into the editor control DOM. */
function _populateControls(state) {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;

  for (const group of BOID_PARAM_GROUPS) {
    for (const p of group.params) {
      const el = modal.querySelector(`#bse_${p.id}`);
      if (!el) continue;
      const v = state[p.id];
      if (v === undefined) continue;

      if (p.type === 'check') {
        el.checked = !!v;
      } else if (p.type === 'select') {
        el.value = v;
      } else {
        el.value = String(v);
        const valEl = modal.querySelector(`#bse_v_${p.id}`);
        if (valEl) valEl.textContent = p.fmt ? p.fmt(+v) : String(v);
      }
    }
  }
  _refreshUndoRedoBtns();
}

// ─── Dirty indicator ─────────────────────────────────────────────────────────

let _isDirty = false;

function _markDirty() {
  if (_isDirty) return;
  _isDirty = true;
  document.getElementById('bse-title')?.classList.add('bse-dirty');
}

function _clearDirty() {
  _isDirty = false;
  document.getElementById('bse-title')?.classList.remove('bse-dirty');
}

// ─── Preview scheduling ───────────────────────────────────────────────────────

function _schedulePreview() {
  _previewDirty = true;
  if (!_previewRaf) {
    _previewRaf = requestAnimationFrame(_runPreview);
  }
}

function _runPreview() {
  _previewRaf = null;
  if (!_previewDirty) return;
  _previewDirty = false;

  const canvas = document.getElementById('bse-preview-canvas');
  if (!canvas) return;

  // Size canvas to match its CSS display size
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(rect.width * dpr) || 240;
  const H = Math.round(rect.height * dpr) || 240;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }

  const color = _app?.primaryEl?.value || '#5090ff';
  _renderPreview(canvas, _editorState, color);

  // Update stat labels
  const scale = (_editorState.brushScale ?? 100) / 100;
  const sz = document.getElementById('bse-stat-size');
  const op = document.getElementById('bse-stat-opacity');
  const ct = document.getElementById('bse-stat-count');
  const sc = document.getElementById('bse-stat-scale');
  if (sz) sz.textContent = Math.round((_editorState.stampSize ?? 6) * scale) + 'px';
  if (op) op.textContent = (_editorState.stampOpacity ?? 15) + '%';
  if (ct) ct.textContent = String(_editorState.count ?? 60);
  if (sc) sc.textContent = scale.toFixed(1) + '×';
}
