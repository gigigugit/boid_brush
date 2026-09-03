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
      { id: 'pressureSpawnRadius', type: 'check', label: 'Pressure → Radius', def: false },
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
      { id: 'stampSize',       type: 'range', label: 'Size',        min: 1,  max: 40,  def: 10 },
      { id: 'stampOpacity',    type: 'range', label: 'Opacity',     min: 1,  max: 100, def: 15, fmt: v => v + '%' },
      { id: 'stampSeparation', type: 'range', label: 'Separation',  min: 0,  max: 80,  def: 0 },
      { id: 'smudge',          type: 'range', label: 'Smudge',      min: 0,  max: 100, def: 0,  fmt: v => (v / 100).toFixed(2) },
      { id: 'stabilizer',      type: 'range', label: 'Stabilizer',  min: 0,  max: 100, def: 0,  fmt: v => (v / 100).toFixed(2) },
      { id: 'pressureSize',    type: 'check', label: 'Pressure → Size', def: true },
      { id: 'pressureOpacity', type: 'check', label: 'Pressure → Opacity', def: true },
      { id: 'smudgeOnly',      type: 'check', label: 'Smudge Only' },
      { id: 'flatStroke',      type: 'check', label: 'Flat Stroke' },
    ],
  },
  {
    id: 'taper',
    label: 'Taper',
    icon: '✏️',
    params: [
      { id: 'taperLength',  type: 'range', label: 'Length', min: 0,  max: 120, def: 20,  fmt: v => (+v === 0 ? 'off' : v + ' frames') },
      { id: 'taperCurve',   type: 'range', label: 'Curve',  min: 10, max: 300, def: 100, fmt: v => (v / 100).toFixed(1) },
      { id: 'taperSize',    type: 'check', label: 'Taper Size', def: true },
      { id: 'taperOpacity', type: 'check', label: 'Taper Opacity', def: true },
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
      { id: 'sensingRadius',    type: 'range', label: 'Radius',    min: 5, max: 80,  def: 20 },
      { id: 'sensingThreshold', type: 'range', label: 'Threshold', min: 0, max: 100, def: 10, fmt: v => (v / 100).toFixed(2) },
    ],
  },
  {
    id: 'visual',
    label: 'Visual',
    icon: '🎨',
    params: [
      { id: 'showBoids', type: 'check', label: 'Show Particles', def: true },
      { id: 'showSpawn', type: 'check', label: 'Show Spawn Area', def: true },
    ],
  },
];

// ─── State helpers ───────────────────────────────────────────────────────────

/** Read current sidebar values into a flat state snapshot. */
function _readState(app) {
  const state = {};
  for (const group of BOID_PARAM_GROUPS) {
    for (const p of group.params) {
      const el = document.getElementById(p.id);
      if (!el) {
        // Fallback to local defaults when the sidebar element doesn't exist.
        // Select params have p.options as Array<[value: string, label: string]>.
        if (p.type === 'check') state[p.id] = p.def ?? false;
        else if (p.type === 'select') state[p.id] = (Array.isArray(p.options) ? p.options[0]?.[0] : undefined) ?? '';
        else state[p.id] = p.def ?? 0;
        continue;
      }
      if (p.type === 'check') state[p.id] = el.checked;
      else if (p.type === 'select') state[p.id] = el.value;
      else state[p.id] = +el.value;
    }
  }
  const distribution = app?._sanitizeBoidColorDist?.(app._boidColorDist);
  state.agentColors = {
    distribution: _cloneState(distribution || [{
      color: app?.getColorValue?.('primary', '#1a1a1a') || '#1a1a1a',
      weight: 1,
    }]),
  };
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
  const distribution = app._sanitizeBoidColorDist?.(state.agentColors?.distribution);
  if (distribution) app._boidColorDist = _cloneState(distribution);
  app.invalidateParams();
  // Sync sidebar readout spans and edge sliders via the app's existing syncUI path
  app._maybeAutoSaveSession?.();
}

/** Deep clone a state object. */
function _cloneState(s) { return JSON.parse(JSON.stringify(s)); }

// ─── Preview rendering ───────────────────────────────────────────────────────
//
// The preview is a small, deterministic Canvas2D "single frame" simulation:
// spawn positions are generated from `spawnShape`, then relaxed for a fixed
// number of steps using a simplified version of the boid force model so
// every force/motion/sensing control has a real (not merely cosmetic)
// effect on the rendered result. The same state + fixed RNG seed always
// produce the same pixels, so re-rendering never "drifts" between calls
// (required for RAF-coalesced scheduling to look stable while idle).
//
// Each state field is read via its literal `state.<id>` name below so the
// mapping from control -> effect stays greppable; `_verifyParamCoverage()`
// at the bottom of this file checks that every id in BOID_PARAM_GROUPS
// (and every spawnShape option) is referenced somewhere in this pipeline.

const PREVIEW_MAX_DPR = 2;            // cap device pixel ratio (iPad/high-DPR safety)
const PREVIEW_STEPS = 7;              // fixed relaxation steps (determinism, not real-time)
const PREVIEW_SEED = 12345;           // Park-Miller LCG seed, reset every render
const PREVIEW_MAX_AGENTS = 48;        // cap for preview cost; count is clamped into this
const PREVIEW_FLEE_POINT = { x: 0.62, y: -0.58 };   // normalized "danger" marker position
const PREVIEW_SENSE_POINT = { x: -0.55, y: 0.5 };   // normalized "sensed surface" marker position

/** Deterministic Park-Miller LCG PRNG factory (stable, frame-independent). */
function _makeRng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/** Box-Muller transform using a supplied deterministic RNG. */
function _gaussianRng(rng) {
  const u1 = Math.max(rng(), 1e-6);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Clamp a number to a valid 0–255 byte value for use in rgba() strings. */
function clampByte(v) { return Math.round(Math.max(0, Math.min(255, v))); }

function _hexToRgbTuple(color) {
  let cr = 120, cg = 160, cb = 240;
  if (color && color.startsWith('#') && color.length >= 7) {
    cr = parseInt(color.slice(1, 3), 16);
    cg = parseInt(color.slice(3, 5), 16);
    cb = parseInt(color.slice(5, 7), 16);
  }
  return { r: cr, g: cg, b: cb };
}

function _rgbToHsl(r, g, b) {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  let hue = 0, saturation = 0;
  if (max !== min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case red: hue = ((green - blue) / delta) + (green < blue ? 6 : 0); break;
      case green: hue = ((blue - red) / delta) + 2; break;
      default: hue = ((red - green) / delta) + 4; break;
    }
    hue *= 60;
  }
  return { h: hue, s: saturation * 100, l: lightness * 100 };
}

function _hslToRgb(hue, saturation, lightness) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - (l * s);
  const p = 2 * l - q;
  const hueToRgb = t => {
    let n = t;
    if (n < 0) n += 1;
    if (n > 1) n -= 1;
    if (n < 1 / 6) return p + ((q - p) * 6 * n);
    if (n < 1 / 2) return q;
    if (n < 2 / 3) return p + ((q - p) * (2 / 3 - n) * 6);
    return p;
  };
  return {
    r: Math.round(hueToRgb(h + 1 / 3) * 255),
    g: Math.round(hueToRgb(h) * 255),
    b: Math.round(hueToRgb(h - 1 / 3) * 255),
  };
}

/**
 * Assign a base color to agent `index` (of `n`) from the staged agent-color
 * distribution using deterministic stratified sampling: each color owns a
 * contiguous share of [0,1) proportional to its relative weight, so the
 * mix of colors across the preview always matches the staged percentages.
 */
function _distributionColorAt(distribution, index, n) {
  const list = Array.isArray(distribution) && distribution.length ? distribution : [{ color: '#5090ff', weight: 1 }];
  const total = list.reduce((sum, e) => sum + (+e.weight || 0), 0) || 1;
  const t = (index + 0.5) / Math.max(n, 1);
  let acc = 0;
  for (const entry of list) {
    acc += (+entry.weight || 0) / total;
    if (t <= acc) return entry.color || '#5090ff';
  }
  return list[list.length - 1].color || '#5090ff';
}

/**
 * Generate normalized (roughly [-1,1]) spawn positions for one of the 19
 * `spawnShape` options. `rng` must be freshly seeded per render for
 * determinism. Shapes are grouped into "structured" (closed-form curves)
 * and "field" (statistical clouds) — see `_spawnShapeIsStructured`.
 */
function _spawnUnitPosition(shape, i, n, rng) {
  const t = n > 1 ? i / (n - 1) : 0;
  const frac = n > 0 ? i / n : 0;
  switch (shape) {
    case 'ring': {
      const angle = frac * Math.PI * 2;
      const r = 0.82 + (rng() - 0.5) * 0.12;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
    case 'gaussian': {
      const r = Math.min(1, Math.abs(_gaussianRng(rng)) * 0.32);
      const angle = rng() * Math.PI * 2;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
    case 'line': {
      return { x: -0.9 + t * 1.8, y: (rng() - 0.5) * 0.08 };
    }
    case 'ellipse': {
      const angle = frac * Math.PI * 2;
      return { x: Math.cos(angle) * 0.92, y: Math.sin(angle) * 0.5 };
    }
    case 'diamond': {
      const edgeT = frac * 4;
      const seg = Math.floor(edgeT) % 4;
      const localT = edgeT - Math.floor(edgeT);
      const pts = [[0, -0.95], [0.95, 0], [0, 0.95], [-0.95, 0]];
      const a = pts[seg], b = pts[(seg + 1) % 4];
      return { x: a[0] + (b[0] - a[0]) * localT, y: a[1] + (b[1] - a[1]) * localT };
    }
    case 'grid': {
      const cols = Math.max(1, Math.round(Math.sqrt(n)));
      const rows = Math.max(1, Math.ceil(n / cols));
      const col = i % cols, row = Math.floor(i / cols);
      const gx = cols > 1 ? (col / (cols - 1)) * 2 - 1 : 0;
      const gy = rows > 1 ? (row / (rows - 1)) * 2 - 1 : 0;
      return { x: gx * 0.85, y: gy * 0.85 };
    }
    case 'sunburst': {
      const rays = 10;
      const ray = i % rays;
      const angle = (ray / rays) * Math.PI * 2;
      const r = 0.15 + rng() * 0.8;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
    case 'spiral': {
      const turns = 3;
      const angle = frac * turns * Math.PI * 2;
      const r = frac * 0.92;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
    case 'poisson': {
      const cols = Math.max(1, Math.round(Math.sqrt(n)));
      const cellW = 2 / cols;
      const col = i % cols, row = Math.floor(i / cols);
      const cx = -1 + cellW * (col + 0.5);
      const cy = -1 + cellW * (row + 0.5);
      return { x: cx + (rng() - 0.5) * cellW * 0.7, y: cy + (rng() - 0.5) * cellW * 0.7 };
    }
    case 'random_cluster': {
      const clusters = 4;
      // Deterministic cluster centers (independent of rng draw order below).
      const centerRng = _makeRng(777);
      const centers = Array.from({ length: clusters }, () => ({
        x: (centerRng() - 0.5) * 1.4, y: (centerRng() - 0.5) * 1.4,
      }));
      const c = centers[i % clusters];
      return { x: c.x + _gaussianRng(rng) * 0.14, y: c.y + _gaussianRng(rng) * 0.14 };
    }
    case 'burst': {
      const angle = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * 0.92;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
    case 'lemniscate': {
      const angle = frac * Math.PI * 2;
      const denom = 1 + Math.sin(angle) * Math.sin(angle);
      return { x: 0.92 * Math.cos(angle) / denom, y: 0.92 * Math.sin(angle) * Math.cos(angle) / denom };
    }
    case 'phyllotaxis': {
      const goldenAngle = 2.399963;
      const angle = i * goldenAngle;
      const r = 0.9 * Math.sqrt(frac);
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
    case 'noise_scatter': {
      const r = Math.sqrt(rng()) * 0.9;
      const angle = rng() * Math.PI * 2;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
    case 'bullseye': {
      const rings = 4;
      const band = i % rings;
      const r = ((band + 0.5) / rings) * 0.9;
      const angle = rng() * Math.PI * 2;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
    case 'cross': {
      const onVertical = i % 2 === 0;
      const along = (rng() * 2 - 1) * 0.92;
      const across = (rng() - 0.5) * 0.1;
      return onVertical ? { x: across, y: along } : { x: along, y: across };
    }
    case 'wave': {
      const x = -0.9 + t * 1.8;
      const y = Math.sin(x * Math.PI * 2) * 0.35 + (rng() - 0.5) * 0.06;
      return { x, y };
    }
    case 'voronoi': {
      const cols = Math.max(1, Math.round(Math.sqrt(n)));
      const cellW = 2 / cols;
      const col = i % cols, row = Math.floor(i / cols);
      const jitter = cellW * 0.9;
      const cx = -1 + cellW * (col + 0.5) + (col % 2 === 0 ? cellW * 0.25 : -cellW * 0.25);
      const cy = -1 + cellW * (row + 0.5);
      return { x: cx + (rng() - 0.5) * jitter, y: cy + (rng() - 0.5) * jitter };
    }
    case 'circle':
    default: {
      const r = Math.sqrt(rng()) * 0.88;
      const angle = rng() * Math.PI * 2;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }
  }
}

// Shapes with a clean closed-form perimeter get a matching dashed outline
// guide when `showSpawn` is on; the rest fall back to a bounding-circle guide.
const STRUCTURED_SPAWN_OUTLINES = new Set([
  'circle', 'ring', 'ellipse', 'diamond', 'line', 'cross', 'wave', 'lemniscate', 'spiral', 'sunburst',
]);

/**
 * Run a fixed number of deterministic relaxation steps on the spawned
 * agents using a simplified boid force model, then derive each agent's
 * final render attributes (radius, opacity, color, heading).
 * Returns { agents, sensePoint, fleePoint, targetPoint, flowSample }.
 */
function _simulateAgents(state) {
  const rng = _makeRng(PREVIEW_SEED);
  const n = Math.max(3, Math.min(state.count ?? 60, PREVIEW_MAX_AGENTS));

  const scale = (state.brushScale ?? 100) / 100;
  const spawnRadiusFrac = Math.min(1, ((state.spawnRadius ?? 5) * scale) / 200);
  const spawnAngleRad = ((state.spawnAngle ?? 0) * Math.PI) / 180;
  const spawnJitter = (state.spawnJitter ?? 0) / 100;
  const pressureSpawnRadius = !!state.pressureSpawnRadius;

  const cohesion = (state.cohesion ?? 15) / 100;
  const separation = (state.separation ?? 15) / 100;
  const alignment = (state.alignment ?? 20) / 100;
  const seek = (state.seek ?? 75) / 100;
  const jitterAmt = (state.jitter ?? 0) / 100;
  const wander = (state.wander ?? 0) / 100;
  const wanderSpeed = (state.wanderSpeed ?? 30) / 100;
  const fovDeg = state.fov ?? 115;
  const flowField = (state.flowField ?? 0) / 100;
  const fleeRadiusFrac = Math.min(1, (state.fleeRadius ?? 0) / 150);
  const individuality = (state.individuality ?? 0) / 100;
  const maxSpeed = (state.maxSpeed ?? 8) / 30;
  const damping = (state.damping ?? 95) / 100;
  const forceVar = (state.forceVar ?? 0) / 100;
  const speedVar = (state.speedVar ?? 0) / 100;
  const stabilizer = (state.stabilizer ?? 0) / 100;
  const noiseDamp = 1 - stabilizer * 0.85;

  const sensingEnabled = !!state.sensingEnabled;
  const sensingMode = state.sensingMode || 'avoid';
  const sensingStrength = (state.sensingStrength ?? 50) / 100;
  const sensingRadiusFrac = Math.min(1, (state.sensingRadius ?? 20) / 100);
  const sensingThreshold = (state.sensingThreshold ?? 10) / 100;

  // Spawn: shape + radius/angle/jitter, optional pressure-driven radius ramp.
  const agents = [];
  for (let i = 0; i < n; i++) {
    const unit = _spawnUnitPosition(state.spawnShape || 'circle', i, n, rng);
    const pressureRamp = pressureSpawnRadius ? 0.35 + 0.65 * (i / Math.max(n - 1, 1)) : 1;
    const r = spawnRadiusFrac * pressureRamp;
    let x = unit.x * r + (rng() - 0.5) * spawnJitter * 0.5;
    let y = unit.y * r + (rng() - 0.5) * spawnJitter * 0.5;
    const cosA = Math.cos(spawnAngleRad), sinA = Math.sin(spawnAngleRad);
    const rx = x * cosA - y * sinA, ry = x * sinA + y * cosA;
    agents.push({
      x: rx, y: ry, vx: 0, vy: 0,
      personality: 1 + (rng() - 0.5) * 2 * individuality,
      senseVal: rng(),
      speedMul: 1 - speedVar * 0.5 + rng() * speedVar,
    });
  }

  const targetPoint = { x: 0.7, y: -0.15 }; // stand-in cursor/seek target
  const fleePoint = PREVIEW_FLEE_POINT;
  const sensePoint = PREVIEW_SENSE_POINT;

  for (let step = 0; step < PREVIEW_STEPS; step++) {
    let cx = 0, cy = 0;
    for (const a of agents) { cx += a.x; cy += a.y; }
    cx /= agents.length; cy /= agents.length;

    for (const a of agents) {
      let fx = 0, fy = 0;

      // Seek: pull toward the stand-in target point.
      fx += (targetPoint.x - a.x) * seek;
      fy += (targetPoint.y - a.y) * seek;

      // Heading used to gate neighbor perception by field of view.
      const speed = Math.hypot(a.vx, a.vy);
      const headingX = speed > 1e-4 ? a.vx / speed : (targetPoint.x - a.x);
      const headingY = speed > 1e-4 ? a.vy / speed : (targetPoint.y - a.y);
      const headingLen = Math.hypot(headingX, headingY) || 1;
      const hx = headingX / headingLen, hy = headingY / headingLen;
      const fovCos = Math.cos((fovDeg * Math.PI) / 360);

      // Cohesion/separation/alignment over FOV-limited neighbors.
      let sepX = 0, sepY = 0, alX = 0, alY = 0, seen = 0;
      for (const other of agents) {
        if (other === a) continue;
        const dx = other.x - a.x, dy = other.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        if (fovDeg < 359) {
          const dot = (dx / dist) * hx + (dy / dist) * hy;
          if (dot < fovCos) continue;
        }
        seen++;
        if (dist < 0.35) { sepX -= dx / dist / dist; sepY -= dy / dist / dist; }
        alX += other.vx; alY += other.vy;
      }
      fx += (cx - a.x) * cohesion;
      fy += (cy - a.y) * cohesion;
      if (seen > 0) {
        fx += (sepX / seen) * separation * 2;
        fy += (sepY / seen) * separation * 2;
        fx += (alX / seen - a.vx) * alignment;
        fy += (alY / seen - a.vy) * alignment;
      }

      // Wander: per-agent smooth-ish angular drift, rate set by wanderSpeed.
      if (wander > 0) {
        const wAngle = (a.senseVal * 6.283) + step * wanderSpeed * 2;
        fx += Math.cos(wAngle) * wander * noiseDamp;
        fy += Math.sin(wAngle) * wander * noiseDamp;
      }

      // Raw per-step jitter noise.
      if (jitterAmt > 0) {
        fx += (rng() - 0.5) * jitterAmt * 2 * noiseDamp;
        fy += (rng() - 0.5) * jitterAmt * 2 * noiseDamp;
      }

      // Flow field: deterministic pseudo-noise directional drift.
      if (flowField > 0) {
        const flowAngle = Math.sin(a.x * 2.7 + step * 0.4) + Math.cos(a.y * 3.1 - step * 0.3);
        fx += Math.cos(flowAngle) * flowField;
        fy += Math.sin(flowAngle) * flowField;
      }

      // Flee: push away from the stand-in danger marker within fleeRadius.
      if (fleeRadiusFrac > 0) {
        const dx = a.x - fleePoint.x, dy = a.y - fleePoint.y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        if (dist < fleeRadiusFrac) {
          const push = (1 - dist / fleeRadiusFrac);
          fx += (dx / dist) * push * 1.2;
          fy += (dy / dist) * push * 1.2;
        }
      }

      // Sensing: attract/avoid the staged "sensed surface" marker, gated by
      // a per-agent deterministic sensed value vs. threshold (mirrors the
      // real brush only reacting once a channel reading crosses the cutoff).
      if (sensingEnabled && a.senseVal >= sensingThreshold) {
        const dx = sensePoint.x - a.x, dy = sensePoint.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        if (dist < sensingRadiusFrac * 2.2) {
          const dir = sensingMode === 'attract' ? 1 : -1;
          fx += (dx / dist) * sensingStrength * dir;
          fy += (dy / dist) * sensingStrength * dir;
        }
      }

      // Individuality + forceVar: per-agent and per-step force scaling.
      const stepForceMul = a.personality * (1 - forceVar * 0.5 + rng() * forceVar);
      a.vx = (a.vx + fx * 0.12 * stepForceMul) * damping;
      a.vy = (a.vy + fy * 0.12 * stepForceMul) * damping;
      const vLen = Math.hypot(a.vx, a.vy);
      const cap = maxSpeed * a.speedMul;
      if (vLen > cap) { a.vx = (a.vx / vLen) * cap; a.vy = (a.vy / vLen) * cap; }
    }
    for (const a of agents) { a.x += a.vx; a.y += a.vy; }
  }

  // stampSeparation: final single-pass placement relaxation so stamp centers
  // keep a minimum gap independent of the flocking separation force above.
  const stampSeparation = (state.stampSeparation ?? 0) / 400;
  if (stampSeparation > 0) {
    for (const a of agents) {
      for (const other of agents) {
        if (other === a) continue;
        const dx = a.x - other.x, dy = a.y - other.y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        if (dist < stampSeparation) {
          const push = (stampSeparation - dist) * 0.5;
          a.x += (dx / dist) * push;
          a.y += (dy / dist) * push;
        }
      }
    }
  }

  return { agents, sensePoint, fleePoint, targetPoint, n };
}

/**
 * Render a boid-like stamp preview into a <canvas>, driven by a deterministic
 * mini force simulation (see `_simulateAgents`) so every force, motion,
 * variance, stamp, taper, and sensing control visibly changes the result.
 */
function _renderPreview(canvas, state, color) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d0f16';
  ctx.fillRect(0, 0, W, H);

  const cx = W * 0.5, cy = H * 0.5;
  const unitR = Math.min(W, H) * 0.42; // maps normalized [-1,1] agent space to pixels
  const toPx = (ux, uy) => ({ x: cx + ux * unitR, y: cy + uy * unitR });

  const scale = (state.brushScale ?? 100) / 100;
  const rawStampSize = state.stampSize ?? 10;
  const stampOpacity = (state.stampOpacity ?? 15) / 100;
  const sizeVar = (state.sizeVar ?? 0) / 100;
  const opacityVar = (state.opacityVar ?? 0) / 100;
  const flatStroke = !!state.flatStroke;
  const smudgeOnly = !!state.smudgeOnly;
  const smudge = (state.smudge ?? 0) / 100; // blends stamp color toward the surface beneath it
  const showBoids = state.showBoids !== false;
  const showSpawn = state.showSpawn !== false;

  const taperLength = (state.taperLength ?? 20) / 120;
  const taperCurve = (state.taperCurve ?? 100) / 100; // exponent: <1 = concave, >1 = convex ramp
  const taperSizeOn = !!state.taperSize;
  const taperOpacityOn = !!state.taperOpacity;
  const pressureSizeOn = !!state.pressureSize;
  const pressureOpacityOn = !!state.pressureOpacity;
  const flowField = (state.flowField ?? 0) / 100;
  const fleeRadiusFrac = Math.min(1, (state.fleeRadius ?? 0) / 150);
  const sensingEnabled = !!state.sensingEnabled;
  const sensingMode = state.sensingMode || 'avoid';
  const sensingChannel = state.sensingChannel || 'darkness';
  const sensingRadiusFrac = Math.min(1, (state.sensingRadius ?? 20) / 100);
  const fovDeg = state.fov ?? 115;

  const { r: cr, g: cg, b: cb } = _hexToRgbTuple(color);
  const distribution = (state.agentColors?.distribution) || [{ color, weight: 1 }];

  const sim = _simulateAgents(state);
  const stamps = sim.agents;
  const n = stamps.length;
  const rng = _makeRng(PREVIEW_SEED + 1); // independent stream for cosmetic variance only

  const maxRadius = W * 0.16;
  const minRadius = 1;
  const baseRadius = Math.max(minRadius, Math.min(maxRadius, rawStampSize * scale));

  // Flow field guide: faint arrows sampled on a small grid, visible once flowField > 0.
  if (flowField > 0.02) {
    ctx.save();
    ctx.strokeStyle = `rgba(140,200,255,${Math.min(0.55, 0.12 + flowField * 0.5)})`;
    ctx.lineWidth = 1.2;
    const grid = 4;
    for (let gyI = 0; gyI < grid; gyI++) {
      for (let gxI = 0; gxI < grid; gxI++) {
        const ux = (gxI / (grid - 1)) * 2 - 1, uy = (gyI / (grid - 1)) * 2 - 1;
        const angle = Math.sin(ux * 2.7) + Math.cos(uy * 3.1);
        const { x, y } = toPx(ux * 0.85, uy * 0.85);
        const len = 8 + flowField * 14;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Sensing marker: colored swatch (by channel) + radius + attract/avoid tint.
  if (sensingEnabled) {
    const { x: sx, y: sy } = toPx(sim.sensePoint.x, sim.sensePoint.y);
    const channelColors = {
      darkness: '#101010', lightness: '#f4f4f4', saturation: '#e040e0',
      red: '#e04040', green: '#40e060', blue: '#4060e0', alpha: 'rgba(255,255,255,0.35)',
    };
    ctx.save();
    ctx.strokeStyle = sensingMode === 'attract' ? 'rgba(80,220,140,0.55)' : 'rgba(230,90,90,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(sx, sy, sensingRadiusFrac * unitR * 1.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = channelColors[sensingChannel] || '#8090a0';
    ctx.beginPath();
    ctx.arc(sx, sy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Flee marker: danger point + its radius, only shown when fleeRadius > 0.
  if (fleeRadiusFrac > 0) {
    const { x: fx, y: fy } = toPx(sim.fleePoint.x, sim.fleePoint.y);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,120,60,0.5)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.arc(fx, fy, fleeRadiusFrac * unitR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,140,70,0.85)';
    ctx.beginPath();
    ctx.moveTo(fx, fy - 6); ctx.lineTo(fx + 6, fy + 5); ctx.lineTo(fx - 6, fy + 5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // FOV wedge: a translucent cone from the flock centroid along its average heading.
  {
    let hcx = 0, hcy = 0, hvx = 0, hvy = 0;
    for (const a of stamps) { hcx += a.x; hcy += a.y; hvx += a.vx; hvy += a.vy; }
    hcx /= n; hcy /= n;
    const hLen = Math.hypot(hvx, hvy);
    const headAngle = hLen > 1e-4 ? Math.atan2(hvy, hvx) : Math.atan2(sim.targetPoint.y - hcy, sim.targetPoint.x - hcx);
    const { x: px, y: py } = toPx(hcx, hcy);
    const halfFov = (fovDeg * Math.PI) / 360;
    const wedgeR = unitR * 0.55;
    ctx.save();
    ctx.fillStyle = 'rgba(90,140,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, wedgeR, headAngle - halfFov, headAngle + halfFov);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Spawn shape guide: structured shapes get a true parametric outline;
  // statistical/field shapes fall back to a bounding-circle guide.
  if (showSpawn) {
    const shape = state.spawnShape || 'circle';
    const spawnR = Math.min((state.spawnRadius ?? 5) * scale / 200, 1) * unitR;
    ctx.save();
    ctx.strokeStyle = 'rgba(100,140,255,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    if (STRUCTURED_SPAWN_OUTLINES.has(shape)) {
      const guideRng = _makeRng(9001);
      const samples = 64;
      ctx.beginPath();
      for (let i = 0; i <= samples; i++) {
        const unit = _spawnUnitPosition(shape, i % samples, samples, guideRng);
        const { x, y } = toPx(unit.x * (spawnR / unitR), unit.y * (spawnR / unitR));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, spawnR, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Agents (stamps): size/opacity/color driven by variance, taper, and
  // pressure-ramp controls; smudgeOnly/flatStroke change render style.
  if (showBoids) {
    for (let i = 0; i < n; i++) {
      const a = stamps[i];
      const { x, y } = toPx(a.x, a.y);
      const strokeT = n > 1 ? i / (n - 1) : 0;

      // Taper: fades size/opacity near both ends of the simulated stroke,
      // shaped by taperCurve (power curve exponent).
      let sizeRamp = 1, opRamp = 1;
      if (taperLength > 0) {
        const edgeT = Math.min(strokeT, 1 - strokeT) / (taperLength * 0.5 + 0.01);
        const shaped = Math.pow(Math.min(1, Math.max(0, edgeT)), taperCurve);
        if (taperSizeOn) sizeRamp *= Math.min(1, shaped);
        if (taperOpacityOn) opRamp *= Math.min(1, shaped);
      }
      // Pressure: simulated pressure ramps up over the first third of the stroke.
      const pressureT = Math.min(1, strokeT / 0.34);
      if (pressureSizeOn) sizeRamp *= 0.3 + 0.7 * pressureT;
      if (pressureOpacityOn) opRamp *= 0.3 + 0.7 * pressureT;

      const szMulti = (1 - sizeVar * 0.5 + rng() * sizeVar) * sizeRamp;
      const opMulti = (1 - opacityVar * 0.5 + rng() * opacityVar) * opRamp;
      const stampRadius = Math.max(0.5, baseRadius * szMulti);
      let opFinal = Math.min(1, stampOpacity * opMulti);
      if (opFinal <= 0.002) continue;

      // Agent color: staged distribution base color + hue/sat/lightness variance.
      const baseHex = _distributionColorAt(distribution, i, n);
      const base = _hexToRgbTuple(baseHex);
      const hsl = _rgbToHsl(base.r, base.g, base.b);
      const hueVar = (state.hueVar ?? 0) / 100, satVar = (state.satVar ?? 0) / 100, litVar = (state.litVar ?? 0) / 100;
      // Hue rotation is invisible on a fully desaturated (gray/black) base
      // color, so give it a small saturation floor that scales with hueVar
      // itself — at hueVar=0 the floor is 0 and the base color is untouched.
      const hueSatFloor = hsl.s + hueVar * 22;
      const shifted = _hslToRgb(
        hsl.h + (rng() - 0.5) * 360 * hueVar,
        hueSatFloor + (rng() - 0.5) * 100 * satVar,
        hsl.l + (rng() - 0.5) * 100 * litVar,
      );
      let [ar, ag, ab] = [shifted.r, shifted.g, shifted.b];
      // Smudge: blend the stamp color toward the (dark) surface beneath it,
      // simulating picking up/mixing with existing canvas color.
      if (smudge > 0) {
        ar += (13 - ar) * smudge * 0.55;
        ag += (15 - ag) * smudge * 0.55;
        ab += (22 - ab) * smudge * 0.55;
      }

      if (smudgeOnly) {
        // Smudge Only: no paint deposit — draw a faint displacement ring + drag line.
        ctx.save();
        ctx.strokeStyle = `rgba(${clampByte(ar)},${clampByte(ag)},${clampByte(ab)},${(opFinal * 0.6).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5, stampRadius), 0, Math.PI * 2);
        ctx.stroke();
        const heading = Math.atan2(a.vy, a.vx);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(heading) * stampRadius * 1.4, y - Math.sin(heading) * stampRadius * 1.4);
        ctx.stroke();
        ctx.restore();
      } else if (flatStroke) {
        // Flat Stroke: solid fill, no soft radial falloff.
        ctx.fillStyle = `rgba(${clampByte(ar)},${clampByte(ag)},${clampByte(ab)},${opFinal.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5, stampRadius), 0, Math.PI * 2);
        ctx.fill();
      } else {
        const grad = ctx.createRadialGradient(x, y, 0, x, y, stampRadius);
        grad.addColorStop(0, `rgba(${clampByte(ar)},${clampByte(ag)},${clampByte(ab)},${opFinal.toFixed(3)})`);
        grad.addColorStop(1, `rgba(${clampByte(ar)},${clampByte(ag)},${clampByte(ab)},0)`);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5, stampRadius), 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Speed variance: a short motion streak scaled by each agent's own max speed.
      const speed = Math.hypot(a.vx, a.vy);
      if (speed > 0.002) {
        const streakLen = Math.min(unitR * 0.5, speed * unitR * 4 * (0.4 + (state.speedVar ?? 0) / 100));
        if (streakLen > 1) {
          ctx.save();
          ctx.strokeStyle = `rgba(${clampByte(ar)},${clampByte(ag)},${clampByte(ab)},${(opFinal * 0.35).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.5, stampRadius * 0.3);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - (a.vx / (speed || 1)) * streakLen, y - (a.vy / (speed || 1)) * streakLen);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
  }

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
          <input type="checkbox" id="bse_${p.id}" style="${CS.check}"${p.def ? ' checked' : ''}>
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
export function openBoidSettingsEditor(app, options = {}) {
  _app = app;
  let modal = document.getElementById(MODAL_ID);
  if (!modal) modal = _buildModal();

  // Snapshot current sidebar state
  _editorState = _readState(app);
  _openState   = _cloneState(_editorState);
  _undoStack   = [];
  _redoStack   = [];

  // Populate editor controls from snapshot
  _populateControls(_editorState);
  _schedulePreview();

  modal.style.display = 'flex';
  requestAnimationFrame(() => {
    modal.classList.add('bse-open');
    if (options.section === 'agentColors') {
      modal.querySelector('#bse-agent-colors')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
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
          <section id="bse-agent-colors" aria-labelledby="bse-agent-colors-title">
            <div class="bse-agent-colors-head">
              <div>
                <div id="bse-agent-colors-title">🎨 Agent Colors</div>
                <div class="bse-agent-colors-help">Set the relative color mix used across individual boids.</div>
              </div>
              <button id="bse-agent-color-add" type="button">＋ Add Color</button>
            </div>
            <div id="bse-agent-color-scroll" tabindex="0" aria-label="Per-agent color distribution">
              <div id="bse-agent-color-list"></div>
            </div>
          </section>
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
      transition: opacity 0.18s ease;
      padding: 12px;
      box-sizing: border-box;
      overflow: hidden;
      touch-action: pan-y;
    }
    #${MODAL_ID}.bse-open { opacity: 1; }
    #${MODAL_ID} * { touch-action: pan-y; }

    #bse-panel {
      display: flex;
      flex-direction: column;
      width: min(1160px, 100%);
      height: min(720px, calc(100vh - 24px));
      max-height: calc(100vh - 24px);
      min-height: 0;
      background: linear-gradient(165deg, rgba(14,18,30,0.99), rgba(8,11,21,0.99));
      border: 1px solid rgba(80,120,220,0.2);
      border-radius: 16px;
      box-shadow: 0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04) inset;
      overflow: hidden;
    }
    @supports (height: 100dvh) {
      #bse-panel {
        height: min(720px, calc(100dvh - 24px));
        max-height: calc(100dvh - 24px);
      }
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
      -webkit-overflow-scrolling: touch;
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
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
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
    #bse-agent-colors {
      margin-top: 16px;
      padding: 12px;
      border: 1px solid rgba(80,120,220,0.2);
      border-radius: 10px;
      background: rgba(58,106,232,0.06);
      min-width: 0;
    }
    .bse-agent-colors-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    #bse-agent-colors-title { color: #dce8ff; font-size: 12px; font-weight: 700; }
    .bse-agent-colors-help { color: #7890b8; font-size: 10px; margin-top: 2px; }
    #bse-agent-color-add {
      flex: 0 0 auto;
      padding: 5px 9px;
      border-radius: 6px;
      border: 1px solid rgba(91,138,240,0.4);
      background: rgba(58,106,232,0.2);
      color: #a9c4ff;
      font: 600 10px inherit;
      cursor: pointer;
    }
    #bse-agent-color-scroll {
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      touch-action: pan-x pan-y;
      -webkit-overflow-scrolling: touch;
      padding: 2px 2px 8px;
      scrollbar-width: thin;
      scrollbar-color: rgba(80,120,220,0.35) transparent;
    }
    #bse-agent-color-list { display: flex; gap: 10px; width: max-content; min-width: 100%; }
    #bse-agent-color-scroll * { touch-action: pan-x pan-y; }
    .bse-agent-color {
      width: 112px;
      flex: 0 0 112px;
      padding: 9px;
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 8px;
      background: rgba(8,11,21,0.75);
      box-sizing: border-box;
    }
    .bse-agent-color-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .bse-agent-color-pct { color: #b9caf0; font-size: 11px; font-variant-numeric: tabular-nums; }
    .bse-agent-color-remove {
      border: 0;
      background: transparent;
      color: #7890b8;
      cursor: pointer;
      padding: 2px;
    }
    .bse-agent-color-remove:disabled { opacity: .25; cursor: default; }
    .bse-agent-color-button {
      display: block;
      width: 100%;
      height: 34px;
      border: 2px solid rgba(255,255,255,.35);
      border-radius: 7px;
      cursor: pointer;
      margin-bottom: 8px;
    }
    .bse-agent-color-weight { width: 100%; margin: 0; accent-color: #5b8af0; }
    .bse-agent-color-label { display: block; color: #7890b8; font-size: 9px; margin-bottom: 3px; }
    @media (max-width: 900px) {
      #bse-body {
        display: block;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
      }
      #bse-preview-col { width: auto; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.07); overflow: visible; }
      #bse-preview-wrap { max-width: 280px; }
      #bse-controls-col { overflow: visible; }
      #bse-controls-grid { grid-template-columns: 1fr; }
      #bse-footer-left, #bse-footer-right { flex-wrap: wrap; }
    }

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

function _closeAgentColorPicker() {
  if (!_app?._colorPicker?.open) return;
  const key = String(_app._getColorTargetKey?.(_app._colorPicker.target) || '');
  if (key.startsWith('boidSettingsColor:')) {
    _app._closeColorPicker?.({ recordHistory: false });
  }
}

function _updateAgentColorPercentages() {
  const modal = document.getElementById(MODAL_ID);
  const distribution = _editorState?.agentColors?.distribution || [];
  const total = distribution.reduce((sum, entry) => sum + (+entry.weight || 0), 0) || 1;
  modal?.querySelectorAll('.bse-agent-color-pct').forEach((label, index) => {
    label.textContent = `${Math.round(((+distribution[index]?.weight || 0) / total) * 100)}%`;
  });
}

function _renderAgentColors() {
  const modal = document.getElementById(MODAL_ID);
  const list = modal?.querySelector('#bse-agent-color-list');
  if (!list || !_editorState) return;
  _closeAgentColorPicker();
  const distribution = _editorState.agentColors?.distribution || [];
  list.innerHTML = '';

  distribution.forEach((entry, index) => {
    const card = document.createElement('div');
    card.className = 'bse-agent-color';

    const top = document.createElement('div');
    top.className = 'bse-agent-color-top';
    const pct = document.createElement('span');
    pct.className = 'bse-agent-color-pct';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'bse-agent-color-remove';
    remove.textContent = '🗑';
    remove.title = 'Remove color';
    remove.setAttribute('aria-label', `Remove color ${index + 1}`);
    remove.disabled = distribution.length <= 1;
    remove.addEventListener('click', () => {
      if (distribution.length <= 1) return;
      _pushUndo();
      distribution.splice(index, 1);
      _renderAgentColors();
      _markDirty();
      _schedulePreview();
    });
    top.append(pct, remove);

    const colorButton = document.createElement('button');
    colorButton.type = 'button';
    colorButton.className = 'bse-agent-color-button';
    colorButton.style.background = entry.color;
    colorButton.title = entry.color.toUpperCase();
    colorButton.setAttribute('aria-label', `Choose color ${index + 1}`);
    colorButton.setAttribute('aria-haspopup', 'dialog');
    colorButton.setAttribute('aria-controls', 'colorPickerPanel');
    colorButton.addEventListener('click', event => {
      event.stopPropagation();
      let undoCaptured = false;
      const target = {
        key: `boidSettingsColor:${index}`,
        trigger: colorButton,
        label: `Agent Color ${index + 1}`,
        getValue: () => distribution[index]?.color || '#1a1a1a',
        setValue: normalized => {
          if (!distribution[index]) return;
          if (!undoCaptured) {
            _pushUndo();
            undoCaptured = true;
          }
          distribution[index].color = normalized;
          colorButton.style.background = normalized;
          colorButton.title = normalized.toUpperCase();
          _markDirty();
          _schedulePreview();
        },
      };
      _app?._openColorPicker?.(target, colorButton);
    });

    const weightLabel = document.createElement('label');
    weightLabel.className = 'bse-agent-color-label';
    weightLabel.textContent = 'Relative weight';
    const weight = document.createElement('input');
    weight.type = 'range';
    weight.className = 'bse-agent-color-weight';
    weight.min = '1';
    weight.max = '100';
    weight.value = String(Math.round(Math.min(1, Math.max(0.01, +entry.weight || 0.01)) * 100));
    weight.setAttribute('aria-label', `Color ${index + 1} relative weight`);
    let weightEditActive = false;
    weight.addEventListener('input', () => {
      if (!weightEditActive) {
        _pushUndo();
        weightEditActive = true;
      }
      entry.weight = Math.min(1, Math.max(0.01, (+weight.value || 1) / 100));
      _updateAgentColorPercentages();
      _markDirty();
      _schedulePreview();
    });
    weight.addEventListener('change', () => { weightEditActive = false; });

    card.append(top, colorButton, weightLabel, weight);
    list.appendChild(card);
  });
  _updateAgentColorPercentages();
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
  modal.querySelector('#bse-agent-color-add').addEventListener('click', () => {
    _pushUndo();
    const distribution = _editorState.agentColors.distribution;
    distribution.push({
      color: _app?.getColorValue?.('primary', '#1a1a1a') || '#1a1a1a',
      weight: distribution[distribution.length - 1]?.weight || 1,
    });
    _renderAgentColors();
    _markDirty();
    _schedulePreview();
    modal.querySelector('#bse-agent-color-scroll').scrollLeft = Number.MAX_SAFE_INTEGER;
  });

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
        let rangeEditActive = false;
        el.addEventListener('input', () => {
          if (!rangeEditActive) {
            _pushUndo();
            rangeEditActive = true;
          }
          const v = +el.value;
          _editorState[p.id] = v;
          if (valEl) valEl.textContent = p.fmt ? p.fmt(v) : String(v);
          _markDirty();
          _schedulePreview();
        });
        el.addEventListener('change', () => { rangeEditActive = false; });
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
  // Don't push duplicate states. JSON.stringify is acceptable here because
  // states are small flat objects. Keys are always in the same insertion order
  // since both sides come from _cloneState (JSON.parse/stringify), so key-order
  // differences from external sources are not a concern in this code path.
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

// Transition duration must match the CSS opacity transition (0.18s) on the modal.
const BSE_CLOSE_TRANSITION_MS = 180;

function _closeEditor() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.remove('bse-open');
  _closeAgentColorPicker();
  setTimeout(() => { modal.style.display = 'none'; }, BSE_CLOSE_TRANSITION_MS);
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
  _renderAgentColors();
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

  // Size canvas to match its CSS display size. DPR is capped so high-density
  // displays (e.g. iPad Pro at 2x/3x) don't blow up preview canvas cost —
  // this is a decorative modal preview, not the paint surface.
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, PREVIEW_MAX_DPR);
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
  if (sz) sz.textContent = Math.round((_editorState.stampSize ?? 10) * scale) + 'px';
  if (op) op.textContent = (_editorState.stampOpacity ?? 15) + '%';
  if (ct) ct.textContent = String(_editorState.count ?? 60);
  if (sc) sc.textContent = scale.toFixed(1) + '×';
}

// ─── Lightweight internal coverage safeguard ────────────────────────────────
//
// Cheap, dependency-free guard against silent drift between the control
// catalog (BOID_PARAM_GROUPS) and the preview pipeline: every param id and
// every spawnShape option should be referenced by literal name somewhere in
// `_simulateAgents` / `_renderPreview` / `_spawnUnitPosition`. This never
// throws and never touches the DOM — it only inspects function source text
// — so it's safe to run at any time, including outside a browser (Node).
// It intentionally does not run automatically on import; call it from a
// console or a manual check (see also `node boid-settings-editor.js` style
// smoke tests run during development).
export function verifyBoidPreviewCoverage() {
  const allIds = BOID_PARAM_GROUPS.flatMap(g => g.params.map(p => p.id));
  const shapeGroup = BOID_PARAM_GROUPS.find(g => g.id === 'spawn');
  const shapeOptions = (shapeGroup?.params.find(p => p.id === 'spawnShape')?.options || []).map(([v]) => v);

  const pipelineSrc = [_simulateAgents, _renderPreview, _spawnUnitPosition]
    .map(fn => fn.toString())
    .join('\n');

  // Match literal `state.<id>` reads (with a word-boundary lookahead) so a
  // longer id that happens to contain a shorter one as a substring — e.g.
  // `smudgeOnly` containing `smudge` — can't hide a truly-unread control.
  const missingParams = allIds.filter(id => !new RegExp(`state\\.${id}(?![A-Za-z0-9_])`).test(pipelineSrc));
  const missingShapes = shapeOptions.filter(shape => !pipelineSrc.includes(`'${shape}'`));

  return {
    ok: missingParams.length === 0 && missingShapes.length === 0,
    paramCount: allIds.length,
    shapeCount: shapeOptions.length,
    missingParams,
    missingShapes,
  };
}

// Cheap runtime sanity check: warns (never throws) if the param/shape count
// drifts from what this file was built to cover, so future edits to
// BOID_PARAM_GROUPS can't silently outrun the preview pipeline.
const EXPECTED_PARAM_COUNT = 48;
const EXPECTED_SPAWN_SHAPE_COUNT = 19;
try {
  const report = verifyBoidPreviewCoverage();
  if (report.paramCount !== EXPECTED_PARAM_COUNT || report.shapeCount !== EXPECTED_SPAWN_SHAPE_COUNT) {
    console.warn(
      `[boid-settings-editor] control catalog size drifted (params ${report.paramCount}/${EXPECTED_PARAM_COUNT}, ` +
      `shapes ${report.shapeCount}/${EXPECTED_SPAWN_SHAPE_COUNT}). Update the preview pipeline and these constants together.`,
    );
  }
  if (!report.ok) {
    console.warn(
      '[boid-settings-editor] preview pipeline is missing coverage for:',
      { params: report.missingParams, shapes: report.missingShapes },
    );
  }
} catch { /* never let a coverage check break the editor */ }
