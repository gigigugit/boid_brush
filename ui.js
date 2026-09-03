import { buildSettingsCatalog, catalogEntryApplies } from './settings-catalog.js';
import {
  FAVORITES_KEY,
  LEGACY_PRESETS_KEY,
  PRESET_FORMAT,
  PRESET_LIBRARY_FORMAT,
  PRESET_LIBRARY_KEY,
  applyPresetValues,
  capturePresetValues,
  createPreset,
  emptyLibrary,
  mergeImportedEntries,
  normalizeFavorites,
  normalizeLibrary,
  normalizePreset,
} from './settings-library.js';
import { evaluatePressureCurve } from './pressure-curve.js';
import {
  FEATURE_CHANNELS,
  MAX_CHANNEL_DEADZONE,
  MAX_CHANNEL_SMOOTHING,
  MOD_COMBINE_MODES,
  MOD_CONDITION_OPS,
  MOD_CURVES,
  MOD_TARGETS,
  createModRoute,
  emptyModMatrix,
  getFeatureChannel,
  getInputSource,
  modMatrixToControlValue,
  parseModMatrix,
  resolveModTarget,
} from './boid-input-modulation.js';

// =============================================================================
// ui.js — Sidebar UI: collapsible sections, sliders, presets, layers
// =============================================================================

export const PRESETS_KEY = LEGACY_PRESETS_KEY;
export const AUTOSAVE_STORAGE_KEY = 'bb_autosave';
const AUTOSAVE_DEBOUNCE_MS = 2000;
const MAX_SWARM_COUNT = 2000;
const NUDGE_BUTTON_STYLE = 'width:20px;height:20px;padding:0;border-radius:5px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#ddd;font-size:12px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;';

// ── Multiplier selector constants ───────────────────────────
const MULT_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
const MULT_DEFAULT_IDX = 5; // 1×

function _fmtMult(idx) {
  const v = MULT_STEPS[Math.max(0, Math.min(MULT_STEPS.length - 1, idx))];
  return '×' + v;
}

function multRow(id) {
  return `<div style="display:flex;align-items:center;gap:4px;margin:-2px 0 4px 0;padding-left:2px;">
    <span style="font-size:10px;color:#8899aa;flex:1;">multiplier</span>
    <button type="button" class="mult-step-btn" data-target="${id}" data-dir="-1" aria-label="Decrease ${id} multiplier" style="${NUDGE_BUTTON_STYLE}">↓</button>
    <span id="${id}_multDisp" style="font-size:10px;color:#cbd7e6;min-width:38px;text-align:center;">×1</span>
    <button type="button" class="mult-step-btn" data-target="${id}" data-dir="1" aria-label="Increase ${id} multiplier" style="${NUDGE_BUTTON_STYLE}">↑</button>
    <input type="range" id="${id}_multIdx" min="0" max="11" value="${MULT_DEFAULT_IDX}" style="display:none;">
  </div>`;
}

// ── Built-in presets ────────────────────────────────────────
const BUILTIN_PRESETS = {
  'Ink Wash': { count:25,seek:40,cohesion:15,separation:50,alignment:20,jitter:0,wander:0,wanderSpeed:30,maxSpeed:8,damping:95,stampSize:6,stampOpacity:15,stampSeparation:0,fov:360,flowField:0,flowScale:10,fleeRadius:0,individuality:0,spawnRadius:50,brushScale:100 },
  'Charcoal': { count:40,seek:50,cohesion:5,separation:60,alignment:10,jitter:20,wander:10,wanderSpeed:40,maxSpeed:6,damping:90,stampSize:8,stampOpacity:8,stampSeparation:0,fov:360,flowField:0,flowScale:10,fleeRadius:0,individuality:30,spawnRadius:30,brushScale:100 },
  'Ribbon': { count:15,seek:60,cohesion:30,separation:30,alignment:40,jitter:0,wander:5,wanderSpeed:20,maxSpeed:12,damping:97,stampSize:4,stampOpacity:20,stampSeparation:5,fov:360,flowField:0,flowScale:10,fleeRadius:0,individuality:10,spawnRadius:20,brushScale:100 },
  'Galaxy': { count:80,seek:20,cohesion:40,separation:20,alignment:15,jitter:10,wander:30,wanderSpeed:50,maxSpeed:5,damping:92,stampSize:3,stampOpacity:10,stampSeparation:0,fov:360,flowField:20,flowScale:5,fleeRadius:0,individuality:50,spawnRadius:80,brushScale:100 },
  'Mist': { count:60,seek:15,cohesion:5,separation:10,alignment:5,jitter:15,wander:40,wanderSpeed:60,maxSpeed:3,damping:85,stampSize:12,stampOpacity:4,stampSeparation:0,fov:360,flowField:10,flowScale:20,fleeRadius:0,individuality:40,spawnRadius:100,brushScale:100 },
  'Edge Seeker': { count:30,seek:50,cohesion:20,separation:40,alignment:25,jitter:5,wander:10,wanderSpeed:30,maxSpeed:8,damping:93,stampSize:5,stampOpacity:18,stampSeparation:2,fov:180,flowField:0,flowScale:10,fleeRadius:0,individuality:20,spawnRadius:40,brushScale:100 },
  'Diffuse Burst': { _activeBrush:'fluid', lbmBrushRadius:55, lbmSpawnCount:8, lbmParticleRadius:6, lbmStrokePull:55, lbmStrokeRake:28, lbmStrokeJitter:87, lbmInjectForce:300, lbmVortexStrength:38, lbmBurstStrength:100, lbmChevronStrength:100, lbmUndulateStrength:0 },
  '3D Fluid Wake': { _activeBrush:'fluid3d', fluid3dBrushRadius:44, fluid3dEmitterCount:6, fluid3dEmissionRate:46, fluid3dEmitterStrength:35, fluid3dEmitterVelocity:22, fluid3dPressure:48, fluid3dMomentum:82, fluid3dVelocityDiffuse:36, fluid3dDrag:28, fluid3dThicknessDecay:14, fluid3dPressureFade:22, fluid3dInfluenceStrength:34, fluid3dMaxVelocity:13, fluid3dFluidScale:120, fluid3dOccupancyBias:8, fluid3dSpreadClamp:78, fluid3dSurfaceTension:24, fluid3dEdgeWidth:48, fluid3dEdgeDrag:18, fluid3dInjectorMode:'swirl', fluid3dInjectorMotion:78, fluid3dInjectorPigment:86, fluid3dInjectorOccupancy:80, fluid3dInjectorSwirl:58, fluid3dRenderMode:'volume' },
  '3D Fluid Crimson Swirl': { _activeBrush:'fluid3d', _primaryColor:'#ff0000', fluid3dBrushRadius:61, fluid3dEmitterCount:21, fluid3dEmissionRate:100, fluid3dEmitterStrength:100, fluid3dEmitterVelocity:100, fluid3dPressure:100, fluid3dMomentum:100, fluid3dVelocityDiffuse:100, fluid3dDrag:25, fluid3dThicknessDecay:37, fluid3dPigmentDiffusion:30, fluid3dPressureFade:11, fluid3dSettleThreshold:4, fluid3dMaxVelocity:30, fluid3dThicknessFloor:1, fluid3dOccupancyBias:29, fluid3dInfluenceStrength:51, fluid3dInfluenceRadius:105, fluid3dTerrainWeight:64, fluid3dScalarFieldInfluence:100, fluid3dOpacity:77, fluid3dOpacityScale:68, fluid3dResolutionScale:70, fluid3dPreviewScale:50, fluid3dFluidScale:85, fluid3dAdaptiveQuality:false, fluid3dShowField:false, fluid3dRenderMode:'pigment', fluid3dSpreadClamp:76, fluid3dSurfaceTension:28, fluid3dEdgeWidth:34, fluid3dEdgeDrag:24, fluid3dInjectorMode:'swirl', fluid3dInjectorMotion:84, fluid3dInjectorPigment:90, fluid3dInjectorOccupancy:68, fluid3dInjectorSwirl:62, stampOpacity:100, canvasTextureEnabled:false },
};

let _settingsCatalog = new Map();
let _favoritesState = normalizeFavorites();

function loadPresetLibrary() {
  try {
    const current = localStorage.getItem(PRESET_LIBRARY_KEY);
    if (current) {
      const normalized = normalizeLibrary(JSON.parse(current), {
        normalizeValue: _normalizePresetControlValue,
        catalog: _settingsCatalog,
        skipInvalidEntries: true,
      });
      if (normalized.warnings.some(warning => warning.error)) {
        console.warn('Some saved presets could not be loaded:', normalized.warnings.filter(warning => warning.error));
      }
      return normalized.library;
    }
    const legacy = JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}');
    const normalized = normalizeLibrary(legacy, {
      normalizeValue: _normalizePresetControlValue,
      catalog: _settingsCatalog,
      skipInvalidEntries: true,
    });
    if (normalized.warnings.some(warning => warning.error)) {
      console.warn('Some legacy presets could not be migrated:', normalized.warnings.filter(warning => warning.error));
    }
    return normalized.library;
  } catch {
    return emptyLibrary();
  }
}

function savePresetLibrary(library) {
  localStorage.setItem(PRESET_LIBRARY_KEY, JSON.stringify(library));
}

function loadFavorites() {
  try { return normalizeFavorites(JSON.parse(localStorage.getItem(FAVORITES_KEY) || 'null')); }
  catch { return normalizeFavorites(); }
}

function saveFavorites(favorites) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(normalizeFavorites(favorites)));
}

// ── Section toggle ──────────────────────────────────────────
function toggleSection(header) {
  header.classList.toggle('closed');
  const body = header.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
}

function _syncSymmetryModeUi() {
  const mode = document.getElementById('symmetryMode')?.value || 'radial';
  document.querySelectorAll('[data-symmetry-mode-panel]').forEach(panel => {
    panel.style.display = panel.dataset.symmetryModePanel === mode ? '' : 'none';
  });
}

// ── Build a slider row ──────────────────────────────────────
function sliderRow(id, label, min, max, value, fmt, desc) {
  const fmtFn = fmt || (v => v);
  const descHtml = desc ? `<span class="slider-desc">${desc}</span>` : '';
  return `<label>${label} <span id="v_${id}">${fmtFn(value)}</span><input type="range" id="${id}" min="${min}" max="${max}" value="${value}"></label>${descHtml}`;
}

function nudgeSliderRow(id, label, min, max, value, fmt, desc, delta = 1) {
  const fmtFn = fmt || (v => v);
  const descHtml = desc ? `<span class="slider-desc">${desc}</span>` : '';
  return `<label>${label} <span style="display:inline-flex;align-items:center;gap:4px;"><button type="button" class="slider-nudge-btn" data-target="${id}" data-delta="${-delta}" aria-label="Decrease ${label}" style="${NUDGE_BUTTON_STYLE}">−</button><span id="v_${id}">${fmtFn(value)}</span><button type="button" class="slider-nudge-btn" data-target="${id}" data-delta="${delta}" aria-label="Increase ${label}" style="${NUDGE_BUTTON_STYLE}">+</button></span><input type="range" id="${id}" min="${min}" max="${max}" value="${value}"></label>${descHtml}`;
}

function fluidMidrangeRow() {
  return `
    <div style="display:flex;align-items:center;gap:6px;margin:4px 0 2px;">
      <span style="flex:1;color:#cbd7e6;font-weight:600;">Midrange Flow</span>
      <button type="button" class="fluid-midrange-btn" data-fluid-bias="-1" aria-label="Nudge midrange flow calmer" style="${NUDGE_BUTTON_STYLE};width:auto;padding:0 8px;">Calmer</button>
      <button type="button" class="fluid-midrange-btn" data-fluid-bias="0" aria-label="Reset midrange flow bias" style="${NUDGE_BUTTON_STYLE};width:auto;padding:0 8px;">Reset</button>
      <button type="button" class="fluid-midrange-btn" data-fluid-bias="1" aria-label="Nudge midrange flow livelier" style="${NUDGE_BUTTON_STYLE};width:auto;padding:0 8px;">Livelier</button>
    </div>
    <span class="slider-desc">Bias Time Step, Motion Slowdown, Stop Threshold, and Viscosity together first, then fine-tune the raw sliders below.</span>
  `;
}

const PRESSURE_CURVE_DEFS = Object.freeze([
  { id: 'pressureSizeCurve', label: 'Stamp Size', group: 'Shared Stamp', points: [[0, 0.3], [1, 1]] },
  { id: 'pressureOpacityCurve', label: 'Stamp Opacity', group: 'Shared Stamp', points: [[0, 0.3], [1, 1]] },
  { id: 'pressureSpawnRadiusCurve', label: 'Spawn Radius', group: 'Boid / Ant', points: [[0, 0.3], [1, 1]] },
  { id: 'bristleSplayPressureCurve', label: 'Bristle Splay', group: 'Bristle', points: [[0, 0.5], [1, 1]] },
  { id: 'fluid3dRadiusPressureCurve', label: 'Emitter Radius', group: '3D Fluid', points: [[0, 0.35], [1, 1]] },
  { id: 'fluid3dCountPressureCurve', label: 'Particle Count', group: '3D Fluid', points: [[0, 0.45], [1, 1]] },
  { id: 'fluid3dEmissionPressureCurve', label: 'Emission Strength', group: '3D Fluid', points: [[0, 0.4], [1, 1]] },
  { id: 'fluid3dInfluencePressureCurve', label: 'Influence Strength', group: '3D Fluid', points: [[0, 0.3], [1, 1]] },
  { id: 'lbmRadiusPressureCurve', label: 'Emitter Radius', group: 'Fluid', points: [[0, 0.35], [1, 1]] },
  { id: 'lbmCountPressureCurve', label: 'Particle Count', group: 'Fluid', points: [[0, 0.4], [1, 1]] },
]);

function _pressureCurveMarkup() {
  let currentGroup = '';
  let markup = '';
  for (const definition of PRESSURE_CURVE_DEFS) {
    if (definition.group !== currentGroup) {
      if (currentGroup) markup += '</div>';
      currentGroup = definition.group;
      markup += `<div class="pressure-curve-group"><div class="pressure-curve-group-title">${currentGroup}</div>`;
    }
    const serialized = JSON.stringify(definition.points);
    markup += `
      <div class="pressure-curve-editor" data-pressure-curve="${definition.id}" data-default-curve='${serialized}'>
        <div class="pressure-curve-header">
          <span class="pressure-curve-title">${definition.label}</span>
          <button type="button" class="pressure-curve-reset" data-pressure-curve-reset>Reset</button>
        </div>
        <canvas class="pressure-curve-canvas" width="240" height="118" aria-label="${definition.label} pressure response curve"></canvas>
        <div class="pressure-curve-axis"><span>Light pressure</span><span>Output</span><span>Firm pressure</span></div>
        <input class="pressure-curve-value" type="text" id="${definition.id}" value='${serialized}' aria-label="${definition.label} pressure curve data">
      </div>`;
  }
  return `${markup}</div>`;
}

function _normalizePressureCurve(value, fallback) {
  try {
    const source = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(source)) return fallback.map(point => [...point]);
    const points = source
      .map(point => [Number(point?.[0]), Number(point?.[1])])
      .filter(point => point.every(Number.isFinite))
      .map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))])
      .sort((a, b) => a[0] - b[0]);
    if (points.length < 2) return fallback.map(point => [...point]);
    const deduped = points.filter((point, index) => index === 0 || point[0] - points[index - 1][0] > 0.001);
    if (deduped.length < 2) return fallback.map(point => [...point]);
    deduped[0][0] = 0;
    deduped[deduped.length - 1][0] = 1;
    return deduped;
  } catch {
    return fallback.map(point => [...point]);
  }
}

function _wirePressureCurveEditors(app, panel) {
  panel.querySelectorAll('[data-pressure-curve]').forEach(editor => {
    const canvas = editor.querySelector('.pressure-curve-canvas');
    const input = editor.querySelector('.pressure-curve-value');
    const fallback = JSON.parse(editor.dataset.defaultCurve);
    let points = _normalizePressureCurve(input.value, fallback);
    let activeIndex = -1;

    const serialize = () => {
      input.value = JSON.stringify(points.map(([x, y]) => [
        Number(x.toFixed(4)),
        Number(y.toFixed(4)),
      ]));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      app.invalidateParams();
    };
    const draw = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(180, Math.round(canvas.getBoundingClientRect().width || 240));
      const height = 118;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const pad = 12;
      const graphW = width - pad * 2;
      const graphH = height - pad * 2;
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const x = pad + graphW * i / 4;
        const y = pad + graphH * i / 4;
        ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, height - pad); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke();
      }
      ctx.strokeStyle = '#6d9cff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const curveSamples = Math.max(96, Math.round(graphW));
      for (let index = 0; index <= curveSamples; index += 1) {
        const x = index / curveSamples;
        const px = pad + x * graphW;
        const py = pad + (1 - evaluatePressureCurve(points, x)) * graphH;
        if (index) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.stroke();
      points.forEach(([x, y], index) => {
        ctx.beginPath();
        ctx.arc(pad + x * graphW, pad + (1 - y) * graphH, index === activeIndex ? 6 : 5, 0, Math.PI * 2);
        ctx.fillStyle = index === activeIndex ? '#fff' : '#8bb3ff';
        ctx.fill();
        ctx.strokeStyle = '#17233a';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    };
    const pointFromEvent = event => {
      const rect = canvas.getBoundingClientRect();
      const pad = 12;
      return [
        Math.max(0, Math.min(1, (event.clientX - rect.left - pad) / Math.max(1, rect.width - pad * 2))),
        Math.max(0, Math.min(1, 1 - (event.clientY - rect.top - pad) / Math.max(1, rect.height - pad * 2))),
      ];
    };
    canvas.addEventListener('pointerdown', event => {
      event.preventDefault();
      const [x, y] = pointFromEvent(event);
      let nearest = -1;
      let nearestDistance = 0.075;
      points.forEach((point, index) => {
        const distance = Math.hypot(point[0] - x, point[1] - y);
        if (distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      });
      if (nearest < 0) {
        points.push([x, y]);
        points.sort((a, b) => a[0] - b[0]);
        nearest = points.findIndex(point => point[0] === x && point[1] === y);
        serialize();
      }
      activeIndex = nearest;
      canvas.setPointerCapture(event.pointerId);
      draw();
    });
    canvas.addEventListener('pointermove', event => {
      if (activeIndex < 0 || !canvas.hasPointerCapture(event.pointerId)) return;
      event.preventDefault();
      const [x, y] = pointFromEvent(event);
      const isEndpoint = activeIndex === 0 || activeIndex === points.length - 1;
      const minX = activeIndex > 0 ? points[activeIndex - 1][0] + 0.002 : 0;
      const maxX = activeIndex < points.length - 1 ? points[activeIndex + 1][0] - 0.002 : 1;
      points[activeIndex] = [isEndpoint ? (activeIndex === 0 ? 0 : 1) : Math.max(minX, Math.min(maxX, x)), y];
      serialize();
      draw();
    }, { passive: false });
    const release = event => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      activeIndex = -1;
      draw();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('dblclick', event => {
      const [x, y] = pointFromEvent(event);
      let nearest = -1;
      let nearestDistance = 0.075;
      points.forEach((point, index) => {
        const distance = Math.hypot(point[0] - x, point[1] - y);
        if (index > 0 && index < points.length - 1 && distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      });
      if (nearest >= 0) {
        points.splice(nearest, 1);
        serialize();
        draw();
      }
    });
    editor.querySelector('[data-pressure-curve-reset]')?.addEventListener('click', () => {
      points = fallback.map(point => [...point]);
      serialize();
      draw();
    });
    input.addEventListener('change', () => {
      points = _normalizePressureCurve(input.value, fallback);
      serialize();
      draw();
    });
    new ResizeObserver(draw).observe(canvas);
    draw();
  });
}

function _updateSliderValue(target, newValue) {
  if (!target) return;
  const min = Number(target.min);
  const max = Number(target.max);
  const clamped = Math.max(min, Math.min(max, newValue));
  if (clamped === Number(target.value)) return;
  target.value = String(clamped);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function _nudgeRangeValue(target, delta) {
  _updateSliderValue(target, (Number(target?.value) || 0) + delta);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderSimulationSessionCard({
  title = 'Simulation Session',
  badgeId = '',
  badgeTone = 'muted',
  badgeLabel = 'Unsaved Draft',
  sessionSelectMarkup = '',
  actionsMarkup = '',
  sessionNameId = '',
  sessionName = '',
  sessionMetaId = '',
  sessionMeta = '',
} = {}) {
  const badgeIdAttr = badgeId ? ` id="${badgeId}"` : '';
  const sessionNameIdAttr = sessionNameId ? ` id="${sessionNameId}"` : '';
  const sessionMetaIdAttr = sessionMetaId ? ` id="${sessionMetaId}"` : '';
  return `
    <div class="sim-inspector-sessionBarCard">
      <div class="sim-inspector-title">${title}</div>
      <div class="sim-inspector-sessionBarRow">
        <span class="sim-inspector-sessionBarLabel">Editing Session</span>
        <span${badgeIdAttr} class="sim-stage-badge ${badgeTone}">${badgeLabel}</span>
      </div>
      <div class="sim-inspector-sessionBarControls">
        ${sessionSelectMarkup}
        <div class="sim-inspector-sessionBarActions">
          ${actionsMarkup}
        </div>
      </div>
      <div${sessionNameIdAttr} class="sim-session-context-title">${sessionName}</div>
      <div${sessionMetaIdAttr} class="sim-session-context-meta">${sessionMeta}</div>
    </div>`;
}

export const LEADER_OVERRIDE_FIELDS = Object.freeze([
  { key: 'seek', sourceId: 'seek', id: 'leaderSeek', overrideId: 'leaderOverrideSeek', type: 'range', label: 'Seek', min: 0, max: 100, defaultValue: 75, readControl: ({ val }) => val('leaderSeek') / 100 },
  { key: 'cohesion', sourceId: 'cohesion', id: 'leaderCohesion', overrideId: 'leaderOverrideCohesion', type: 'range', label: 'Cohesion', min: 0, max: 100, defaultValue: 37, readControl: ({ val }) => val('leaderCohesion') / 100 },
  { key: 'separation', sourceId: 'separation', id: 'leaderSeparation', overrideId: 'leaderOverrideSeparation', type: 'range', label: 'Separation', min: 0, max: 100, defaultValue: 15, readControl: ({ val }) => val('leaderSeparation') / 100 },
  { key: 'alignment', sourceId: 'alignment', id: 'leaderAlignment', overrideId: 'leaderOverrideAlignment', type: 'range', label: 'Alignment', min: 0, max: 100, defaultValue: 22, readControl: ({ val }) => val('leaderAlignment') / 100 },
  { key: 'jitter', sourceId: 'jitter', id: 'leaderJitter', overrideId: 'leaderOverrideJitter', type: 'range', label: 'Jitter', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderJitter') / 100 },
  { key: 'wander', sourceId: 'wander', id: 'leaderWander', overrideId: 'leaderOverrideWander', type: 'range', label: 'Wander', min: 0, max: 100, defaultValue: 6, readControl: ({ val }) => val('leaderWander') / 100 },
  { key: 'wanderSpeed', sourceId: 'wanderSpeed', id: 'leaderWanderSpeed', overrideId: 'leaderOverrideWanderSpeed', type: 'range', label: 'Wander Spd', min: 1, max: 100, defaultValue: 30, readControl: ({ val }) => val('leaderWanderSpeed') / 100 },
  { key: 'fov', sourceId: 'fov', id: 'leaderFov', overrideId: 'leaderOverrideFov', type: 'range', label: 'FOV', min: 30, max: 360, defaultValue: 115, readControl: ({ val }) => val('leaderFov') || 360 },
  { key: 'flowField', sourceId: 'flowField', id: 'leaderFlowField', overrideId: 'leaderOverrideFlowField', type: 'range', label: 'Flow', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderFlowField') / 100 },
  { key: 'flowScale', sourceId: 'flowScale', id: 'leaderFlowScale', overrideId: 'leaderOverrideFlowScale', type: 'range', label: 'Flow Scale', min: 1, max: 100, defaultValue: 10, readControl: ({ val }) => val('leaderFlowScale') / 1000 },
  { key: 'fleeRadius', sourceId: 'fleeRadius', id: 'leaderFleeRadius', overrideId: 'leaderOverrideFleeRadius', type: 'range', label: 'Flee R', min: 0, max: 150, defaultValue: 0, readControl: ({ val }) => val('leaderFleeRadius') },
  { key: 'individuality', sourceId: 'individuality', id: 'leaderIndividuality', overrideId: 'leaderOverrideIndividuality', type: 'range', label: 'Individ.', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderIndividuality') / 100 },
  { key: 'quorumThreshold', sourceId: 'quorumThreshold', id: 'leaderQuorumThreshold', overrideId: 'leaderOverrideQuorumThreshold', type: 'range', label: 'Quorum Threshold', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => Math.max(0, Math.round(val('leaderQuorumThreshold') || 0)) },
  { key: 'quorumCompositeStrength', sourceId: 'quorumCompositeStrength', id: 'leaderQuorumCompositeStrength', overrideId: 'leaderOverrideQuorumCompositeStrength', type: 'range', label: 'Quorum Composite', min: 0, max: 100, defaultValue: 35, readControl: ({ val }) => val('leaderQuorumCompositeStrength') / 100 },
  { key: 'sizeVar', sourceId: 'sizeVar', id: 'leaderSizeVar', overrideId: 'leaderOverrideSizeVar', type: 'range', label: 'Size Var', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderSizeVar') / 100 },
  { key: 'opacityVar', sourceId: 'opacityVar', id: 'leaderOpacityVar', overrideId: 'leaderOverrideOpacityVar', type: 'range', label: 'Opac Var', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderOpacityVar') / 100 },
  { key: 'speedVar', sourceId: 'speedVar', id: 'leaderSpeedVar', overrideId: 'leaderOverrideSpeedVar', type: 'range', label: 'Speed Var', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderSpeedVar') / 100 },
  { key: 'forceVar', sourceId: 'forceVar', id: 'leaderForceVar', overrideId: 'leaderOverrideForceVar', type: 'range', label: 'Force Var', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderForceVar') / 100 },
  { key: 'hueVar', sourceId: 'hueVar', id: 'leaderHueVar', overrideId: 'leaderOverrideHueVar', type: 'range', label: 'Hue Var', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderHueVar') / 100 },
  { key: 'satVar', sourceId: 'satVar', id: 'leaderSatVar', overrideId: 'leaderOverrideSatVar', type: 'range', label: 'Satur Var', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderSatVar') / 100 },
  { key: 'litVar', sourceId: 'litVar', id: 'leaderLitVar', overrideId: 'leaderOverrideLitVar', type: 'range', label: 'Light Var', min: 0, max: 100, defaultValue: 0, readControl: ({ val }) => val('leaderLitVar') / 100 },
  { key: 'maxSpeed', sourceId: 'maxSpeed', id: 'leaderMaxSpeed', overrideId: 'leaderOverrideMaxSpeed', type: 'range', label: 'Max Speed', min: 1, max: 30, defaultValue: 22, readControl: ({ val }) => val('leaderMaxSpeed') / 2 },
  { key: 'damping', sourceId: 'damping', id: 'leaderDamping', overrideId: 'leaderOverrideDamping', type: 'range', label: 'Damping', min: 80, max: 100, defaultValue: 95, readControl: ({ val }) => val('leaderDamping') / 100 },
  { key: 'sensingEnabled', sourceId: 'sensingEnabled', id: 'leaderSensingEnabled', overrideId: 'leaderOverrideSensingEnabled', type: 'checkbox', label: 'Sensing', defaultValue: false, readControl: ({ chk }) => chk('leaderSensingEnabled') },
  { key: 'sensingMode', sourceId: 'sensingMode', id: 'leaderSensingMode', overrideId: 'leaderOverrideSensingMode', type: 'select', label: 'Sensing Mode', defaultValue: 'avoid', options: [{ value: 'avoid', label: 'Avoid' }, { value: 'attract', label: 'Attract' }], readControl: ({ sel }) => sel('leaderSensingMode') || 'avoid' },
  { key: 'sensingStrength', sourceId: 'sensingStrength', id: 'leaderSensingStrength', overrideId: 'leaderOverrideSensingStrength', type: 'range', label: 'Sensing Strength', min: 0, max: 100, defaultValue: 50, readControl: ({ val }) => val('leaderSensingStrength') / 100 },
  { key: 'sensingRadius', sourceId: 'sensingRadius', id: 'leaderSensingRadius', overrideId: 'leaderOverrideSensingRadius', type: 'range', label: 'Sensing Radius', min: 0, max: 200, defaultValue: 20, readControl: ({ val }) => val('leaderSensingRadius') },
  { key: 'sensingFitRadius', sourceId: 'sensingFitRadius', id: 'leaderSensingFitRadius', overrideId: 'leaderOverrideSensingFitRadius', type: 'range', label: 'Sensing Fit Radius', min: 0, max: 200, defaultValue: 0, readControl: ({ val }) => val('leaderSensingFitRadius') },
  { key: 'sensingThreshold', sourceId: 'sensingThreshold', id: 'leaderSensingThreshold', overrideId: 'leaderOverrideSensingThreshold', type: 'range', label: 'Sensing Threshold', min: 0, max: 100, defaultValue: 10, readControl: ({ val }) => val('leaderSensingThreshold') / 100 },
  { key: 'neighborRadius', sourceId: 'am_neighborRadius', id: 'leaderNeighborRadius', overrideId: 'leaderOverrideNeighborRadius', type: 'range', label: 'Neighbor Radius', min: 1, max: 240, defaultValue: 80, readControl: ({ val }) => val('leaderNeighborRadius') || 80 },
  { key: 'separationRadius', sourceId: 'am_separationRadius', id: 'leaderSeparationRadius', overrideId: 'leaderOverrideSeparationRadius', type: 'range', label: 'Separation Radius', min: 1, max: 240, defaultValue: 25, readControl: ({ val }) => val('leaderSeparationRadius') || 25 },
  { key: 'simBoundsMargin', sourceId: 'simBoundsMargin', id: 'leaderSimBoundsMargin', overrideId: 'leaderOverrideSimBoundsMargin', type: 'range', label: 'Bounds Margin', min: 0, max: 240, defaultValue: 0, readControl: ({ val }) => Math.max(0, val('leaderSimBoundsMargin') || 0) },
]);

function _buildLeaderOverrideControl(field) {
  if (field.type === 'checkbox') {
    return `<label style="margin:4px 0 0 0;">Enabled <input type="checkbox" id="${field.id}"></label>`;
  }
  if (field.type === 'select') {
    return `<label style="margin:4px 0 0 0;">Mode <select id="${field.id}">${field.options.map(option => `<option value="${option.value}">${option.label}</option>`).join('')}</select></label>`;
  }
  return `<label style="margin:4px 0 0 0;">${field.label} <span id="v_${field.id}">${field.defaultValue}</span><input type="range" id="${field.id}" min="${field.min}" max="${field.max}" value="${field.defaultValue}"></label>`;
}

function _buildLeaderOverrideRows() {
  return LEADER_OVERRIDE_FIELDS.map(field => `
    <div data-leader-field="${field.key}" style="margin:4px 0 8px;padding:6px 8px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;background:rgba(255,255,255,0.03);">
      <label style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;">
        <span>${field.label}</span>
        <span style="display:inline-flex;align-items:center;gap:6px;font-size:10px;color:#9fb0c6;">Override <input type="checkbox" id="${field.overrideId}" data-leader-target="${field.id}" data-leader-source="${field.sourceId}"></span>
      </label>
      ${_buildLeaderOverrideControl(field)}
    </div>
  `).join('');
}

function _syncLeaderOverrideControlState(field) {
  const toggle = document.getElementById(field.overrideId);
  const target = document.getElementById(field.id);
  const row = document.querySelector(`[data-leader-field="${field.key}"]`);
  const enabled = !!toggle?.checked;
  if (target) target.disabled = !enabled;
  if (row) row.style.opacity = enabled ? '1' : '0.6';
}

function _copyLeaderOverrideFromSource(field) {
  const source = document.getElementById(field.sourceId);
  const target = document.getElementById(field.id);
  if (!source || !target) return;
  if (target.type === 'checkbox') target.checked = source.checked;
  else target.value = source.value;
  const span = document.getElementById('v_' + field.id);
  const fmt = _sliderFormats[field.id];
  if (span && target.type === 'range') span.textContent = fmt ? fmt(+target.value) : target.value;
}

function _syncLeaderOverrideUI() {
  LEADER_OVERRIDE_FIELDS.forEach(_syncLeaderOverrideControlState);
}

// ── Boid Input Modulation Framework ─────────────────────────
// Boid-only. The whole modulation matrix lives in ONE hidden JSON control
// (`#boidModMatrix`) so it rides through the scalar-only preset catalog filter
// as a string, while this editor renders a live, structured view of it.
//
// Ownership: the hidden text input is the single source of truth. Every editor
// control reads it, mutates the parsed matrix, and writes it back — there is no
// second store to keep in sync, and preset/workspace/session plumbing needs no
// special-casing beyond the normalization pass in `_syncModMatrixUi`.
const MOD_ROUTE_LIMIT = 24;
const MOD_CONDITION_LIMIT = 3;
const MOD_MATRIX_MAX_JSON_LENGTH = 24000;

function _modMatrixControl() {
  return document.getElementById('boidModMatrix');
}

/** Read the current matrix from the hidden control (never throws). */
function _readModMatrix() {
  return parseModMatrix(_modMatrixControl()?.value || '');
}

/** Write a matrix back to the hidden control and refresh dependent state.
 *  `rerender` is false while dragging a slider so focus is not stolen. */
function _writeModMatrix(app, matrix, { rerender = true } = {}) {
  const control = _modMatrixControl();
  if (!control) return;
  control.value = modMatrixToControlValue(matrix);
  app.invalidateParams();
  // Re-rendering replaces innerHTML, which would steal focus mid-drag or
  // mid-keystroke, so value-only edits skip it and structural edits opt in.
  if (!rerender) return;
  _renderModRouteEditor(app);
  _renderModChannelTuning(app);
}

function _modSelect(dataAttrs, options, selected) {
  const html = options.map(option => `<option value="${option.value}"${option.value === selected ? ' selected' : ''}>${option.label}</option>`).join('');
  return `<select ${dataAttrs} style="flex:1;min-width:0;">${html}</select>`;
}

const _MOD_CHANNEL_OPTIONS = FEATURE_CHANNELS.map(channel => ({ value: channel.id, label: channel.label }));
const _MOD_TARGET_OPTIONS = MOD_TARGETS.map(target => ({ value: target.id, label: `${target.section} · ${target.label}` }));
const _MOD_CURVE_OPTIONS = MOD_CURVES.map(curve => ({ value: curve.id, label: curve.label }));
const _MOD_COMBINE_OPTIONS = MOD_COMBINE_MODES.map(mode => ({ value: mode.id, label: mode.label }));
const _MOD_CONDITION_OPTIONS = MOD_CONDITION_OPS.map(op => ({ value: op.id, label: op.label }));

const _MOD_CARD_STYLE = 'margin:6px 0;padding:8px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;background:rgba(255,255,255,0.03);';
const _MOD_ROW_STYLE = 'display:flex;align-items:center;gap:6px;margin:4px 0;font-size:10px;color:#9fb0c6;';
const _MOD_NUM_STYLE = 'width:52px;flex:0 0 auto;';

function _buildModConditionRow(route, condition, index) {
  const needsSecond = condition.op === 'between' || condition.op === 'outside';
  return `
    <div style="${_MOD_ROW_STYLE}">
      <span style="flex:0 0 auto;">When</span>
      ${_modSelect(`data-mod-route="${route.id}" data-mod-cond="${index}" data-mod-prop="channel"`, _MOD_CHANNEL_OPTIONS, condition.channel)}
      ${_modSelect(`data-mod-route="${route.id}" data-mod-cond="${index}" data-mod-prop="op"`, _MOD_CONDITION_OPTIONS, condition.op)}
      <input type="number" min="0" max="1" step="0.05" value="${condition.value}" style="${_MOD_NUM_STYLE}" data-mod-route="${route.id}" data-mod-cond="${index}" data-mod-prop="value" aria-label="Condition threshold">
      <input type="number" min="0" max="1" step="0.05" value="${condition.value2}" style="${_MOD_NUM_STYLE}${needsSecond ? '' : 'visibility:hidden;'}" data-mod-route="${route.id}" data-mod-cond="${index}" data-mod-prop="value2" aria-label="Condition upper threshold">
      <button type="button" data-mod-route="${route.id}" data-mod-cond="${index}" data-mod-action="remove-condition" title="Remove condition" style="flex:0 0 auto;padding:0 6px;">✕</button>
    </div>
  `;
}

function _buildModRouteCard(route, index, report) {
  const target = resolveModTarget(route.target);
  const channel = getFeatureChannel(route.source);
  const statusText = report?.applied
    ? `active · signal ${report.signal.toFixed(2)} · contrib ${report.contribution >= 0 ? '+' : ''}${report.contribution.toFixed(2)}`
    : (report?.reason ? `idle · ${report.reason}` : 'idle');
  const statusColor = report?.applied ? '#7fe0a0' : '#8b98aa';
  return `
    <div data-mod-route-card="${route.id}" style="${_MOD_CARD_STYLE}${route.enabled ? '' : 'opacity:0.55;'}">
      <div style="display:flex;align-items:center;gap:6px;margin:0 0 4px;">
        <span style="font-weight:600;color:#eef3ff;flex:1;">Route ${index + 1}</span>
        <span style="font-size:10px;color:${statusColor};" data-mod-route-status="${route.id}">${statusText}</span>
        <label style="margin:0;display:inline-flex;align-items:center;gap:4px;font-size:10px;color:#9fb0c6;">On
          <input type="checkbox" ${route.enabled ? 'checked' : ''} data-mod-route="${route.id}" data-mod-prop="enabled" aria-label="Enable route ${index + 1}">
        </label>
        <button type="button" data-mod-route="${route.id}" data-mod-action="remove-route" title="Delete route" style="flex:0 0 auto;padding:0 6px;">✕</button>
      </div>
      <div style="${_MOD_ROW_STYLE}">
        <span style="flex:0 0 44px;">Source</span>
        ${_modSelect(`data-mod-route="${route.id}" data-mod-prop="source"`, _MOD_CHANNEL_OPTIONS, route.source)}
        <span style="flex:0 0 40px;text-align:right;">Target</span>
        ${_modSelect(`data-mod-route="${route.id}" data-mod-prop="target"`, _MOD_TARGET_OPTIONS, route.target)}
      </div>
      <label style="margin:4px 0 0 0;">Amount <span data-mod-readout="${route.id}:amount">${route.amount.toFixed(2)}</span>
        <input type="range" min="-100" max="100" value="${Math.round(route.amount * 100)}" data-mod-route="${route.id}" data-mod-prop="amount">
      </label>
      <span class="slider-desc">${target ? `Fraction of the ${target.label} range (${target.min}…${target.max}) this route can move.` : 'Fraction of the target range this route can move.'}</span>
      <div style="${_MOD_ROW_STYLE}">
        <span style="flex:0 0 44px;">Curve</span>
        ${_modSelect(`data-mod-route="${route.id}" data-mod-prop="curve"`, _MOD_CURVE_OPTIONS, route.curve)}
        <label style="margin:0;display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;">Invert
          <input type="checkbox" ${route.invert ? 'checked' : ''} data-mod-route="${route.id}" data-mod-prop="invert" aria-label="Invert route ${index + 1}">
        </label>
      </div>
      <div style="${_MOD_ROW_STYLE}">
        <span style="flex:0 0 44px;">Combine</span>
        ${_modSelect(`data-mod-route="${route.id}" data-mod-prop="combine"`, _MOD_COMBINE_OPTIONS, route.combine)}
        <span style="flex:0 0 auto;">Priority</span>
        <input type="number" min="-99" max="99" step="1" value="${route.priority}" style="${_MOD_NUM_STYLE}" data-mod-route="${route.id}" data-mod-prop="priority" aria-label="Route ${index + 1} priority">
      </div>
      <div style="${_MOD_ROW_STYLE}">
        <span style="flex:0 0 44px;">Clamp</span>
        <input type="number" min="0" max="1" step="0.05" value="${route.clampMin}" style="${_MOD_NUM_STYLE}" data-mod-route="${route.id}" data-mod-prop="clampMin" aria-label="Route ${index + 1} clamp minimum">
        <span style="flex:0 0 auto;">…</span>
        <input type="number" min="0" max="1" step="0.05" value="${route.clampMax}" style="${_MOD_NUM_STYLE}" data-mod-route="${route.id}" data-mod-prop="clampMax" aria-label="Route ${index + 1} clamp maximum">
        <span style="flex:1;min-width:0;">of the target range${channel?.capability ? ` · needs ${channel.capability}` : ''}</span>
      </div>
      ${route.conditions.map((condition, conditionIndex) => _buildModConditionRow(route, condition, conditionIndex)).join('')}
      ${route.conditions.length < MOD_CONDITION_LIMIT
        ? `<button type="button" data-mod-route="${route.id}" data-mod-action="add-condition" style="width:100%;margin-top:4px;font-size:10px;">+ Condition</button>`
        : ''}
    </div>
  `;
}

/** Rebuild the route cards from the hidden JSON control. */
function _renderModRouteEditor(app) {
  const container = document.getElementById('modRouteEditor');
  if (!container) return;
  const matrix = _readModMatrix();
  const reports = new Map();
  // Only reach into the app for live route status when routes exist, so the
  // default (empty) document never pulls getP() during initial sidebar build.
  if (matrix.routes.length) {
    for (const report of app?.getModulationSnapshot?.()?.diagnostics?.routes || []) reports.set(report.id, report);
  }
  container.innerHTML = matrix.routes.length
    ? matrix.routes.map((route, index) => _buildModRouteCard(route, index, reports.get(route.id))).join('')
    : '<span class="slider-desc">No routes. Add one to drive a boid parameter from a live input channel.</span>';
  const addBtn = document.getElementById('modAddRouteBtn');
  if (addBtn) addBtn.disabled = matrix.routes.length >= MOD_ROUTE_LIMIT;
}

/** Channel tuning (EMA smoothing + deadzone) for the channels actually in use.
 *  Kept scoped to in-use channels so the section never grows into a wall of
 *  controls that map to nothing. */
function _renderModChannelTuning(app) {
  const container = document.getElementById('modChannelTuning');
  if (!container) return;
  const matrix = _readModMatrix();
  const inUse = new Set();
  for (const route of matrix.routes) {
    inUse.add(route.source);
    for (const condition of route.conditions) inUse.add(condition.channel);
  }
  const rows = FEATURE_CHANNELS.filter(channel => inUse.has(channel.id) && channel.id !== 'constant');
  if (!rows.length) {
    container.innerHTML = '<span class="slider-desc">Channel smoothing and deadzones appear here once a route uses a channel.</span>';
    return;
  }
  container.innerHTML = rows.map(channel => {
    const tuning = matrix.channels[channel.id] || { smoothing: channel.smoothing, deadzone: channel.deadzone };
    return `
      <div style="${_MOD_ROW_STYLE}">
        <span style="flex:1;min-width:0;color:#cbd7e6;">${channel.label}</span>
        <span style="flex:0 0 auto;">Smooth</span>
        <input type="number" min="0" max="${MAX_CHANNEL_SMOOTHING}" step="0.05" value="${tuning.smoothing}" style="${_MOD_NUM_STYLE}" data-mod-channel="${channel.id}" data-mod-prop="smoothing" aria-label="${channel.label} smoothing">
        <span style="flex:0 0 auto;">Dead</span>
        <input type="number" min="0" max="${MAX_CHANNEL_DEADZONE}" step="0.02" value="${tuning.deadzone}" style="${_MOD_NUM_STYLE}" data-mod-channel="${channel.id}" data-mod-prop="deadzone" aria-label="${channel.label} deadzone">
      </div>
    `;
  }).join('');
}

/** Static skeleton for the live channel monitor; values are filled in by
 *  `_refreshModulationDebugUi` on the frame loop. */
function _buildModChannelMonitor() {
  return FEATURE_CHANNELS.map(channel => `
    <div style="display:flex;align-items:center;gap:6px;margin:2px 0;font-size:10px;" data-mod-monitor-row="${channel.id}" title="${channel.description}">
      <span style="flex:0 0 88px;color:#9fb0c6;">${channel.label}</span>
      <span style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden;">
        <span data-mod-monitor-bar="${channel.id}" style="display:block;height:100%;width:0%;background:#3a6ae8;"></span>
      </span>
      <span data-mod-monitor-value="${channel.id}" style="flex:0 0 34px;text-align:right;color:#cbd7e6;font-variant-numeric:tabular-nums;">0.00</span>
    </div>
  `).join('');
}

/** Per-frame refresh installed on `app._refreshModulationDebugUi`. Early-exits
 *  unless the boid section is expanded, so the frame loop pays one DOM lookup
 *  in the common case. */
function _refreshModulationDebugUi(app) {
  const monitor = document.getElementById('modChannelMonitor');
  // `.brush-hidden` is display:none (offsetParent null) but `.collapsed` only
  // zeroes max-height, so both checks are needed to stay off the frame budget.
  if (!monitor || !monitor.offsetParent) return;
  if (monitor.closest('.section-body')?.classList.contains('collapsed')) return;
  const features = app.getInputFeatureFrame?.();
  if (!features) return;
  const available = new Set(features.capabilities || []);
  for (const channel of FEATURE_CHANNELS) {
    const value = Math.max(0, Math.min(1, features.channels[channel.id] || 0));
    const supported = !channel.capability || available.has(channel.capability);
    const bar = monitor.querySelector(`[data-mod-monitor-bar="${channel.id}"]`);
    const label = monitor.querySelector(`[data-mod-monitor-value="${channel.id}"]`);
    const row = monitor.querySelector(`[data-mod-monitor-row="${channel.id}"]`);
    if (bar) {
      bar.style.width = `${(supported ? value : 0) * 100}%`;
      bar.style.background = supported ? '#3a6ae8' : '#4a5568';
    }
    if (label) label.textContent = supported ? value.toFixed(2) : '—';
    if (row) row.style.opacity = supported ? '1' : '0.45';
  }
  const sourceEl = document.getElementById('modMonitorSource');
  if (sourceEl) {
    sourceEl.textContent = `${getInputSource(features.sourceId).label} · ${(features.capabilities || []).join(', ') || 'no capabilities yet'}`;
  }
  _refreshModulationDiagnostics(app);
}

function _refreshModulationDiagnostics(app) {
  const panel = document.getElementById('modDiagnostics');
  if (!panel) return;
  const snapshot = app.getModulationSnapshot?.();
  if (!snapshot) {
    panel.textContent = 'No active routes.';
    return;
  }
  const applied = app.getCurrentBrush?.()?.getModulationApplied?.() || null;
  for (const report of snapshot.diagnostics.routes) {
    const status = document.querySelector(`[data-mod-route-status="${report.id}"]`);
    if (!status) continue;
    status.textContent = report.applied
      ? `active · signal ${report.signal.toFixed(2)} · contrib ${report.contribution >= 0 ? '+' : ''}${report.contribution.toFixed(2)}`
      : `idle · ${report.reason || 'inactive'}`;
    status.style.color = report.applied ? '#7fe0a0' : '#8b98aa';
  }
  const lines = snapshot.diagnostics.routes.map(report => {
    const arrow = `${report.source} → ${report.target}`;
    if (!report.applied) return `· ${report.id} ${arrow} — ${report.reason}`;
    const written = applied?.[report.target];
    const resolved = written ? ` ⇒ ${written.base.toFixed(3)} → ${written.value.toFixed(3)}` : '';
    return `✓ ${report.id} ${arrow} [${report.combine} p${report.priority}] sig ${report.signal.toFixed(2)}${resolved}`;
  });
  lines.push(`— ${snapshot.diagnostics.active} active / ${snapshot.diagnostics.skipped} skipped`);
  panel.textContent = lines.join('\n');
}

/** Normalize the hidden control and rebuild the editor. Called from `syncUI`,
 *  so every entry path (preset apply, workspace restore, session load, legacy
 *  import) is normalized through the same seam. */
function _syncModMatrixUi(app) {
  const control = _modMatrixControl();
  if (!control) return;
  const raw = control.value || '';
  let normalized = '';
  try {
    normalized = modMatrixToControlValue(parseModMatrix(raw, { strict: !!raw.trim() }));
    _setModMatrixError('');
  } catch (error) {
    // Keep whatever the user/preset supplied visible so it can be fixed, but
    // fall back to "no modulation" for the runtime read path.
    _setModMatrixError(error.message);
    _renderModRouteEditor(app);
    _renderModChannelTuning(app);
    return;
  }
  if (normalized !== raw) control.value = normalized;
  _renderModRouteEditor(app);
  _renderModChannelTuning(app);
}

/** Structured-state sanitizer handed to the preset pipeline. Runs on capture,
 *  normalize (import), and apply, so an exported preset, a hand-edited JSON
 *  file, and a legacy workspace bundle all converge on the same validated
 *  modMatrix.v1 document. Unknown ids pass through untouched, which keeps this
 *  seam usable for any future structured control. */
function _normalizePresetControlValue(id, value) {
  if (id !== 'boidModMatrix') return value;
  if (typeof value !== 'string') return '';
  // Bound the payload before parsing so a hostile preset cannot push an
  // unbounded string through JSON.parse or into localStorage.
  if (value.length > MOD_MATRIX_MAX_JSON_LENGTH) return '';
  return modMatrixToControlValue(parseModMatrix(value));
}

function _setModMatrixError(message) {
  const el = document.getElementById('modMatrixError');
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? '' : 'none';
}

// ── Build sidebar DOM ───────────────────────────────────────
export function buildSidebar(app) {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = `
    <div class="settings-navigator">
      <input id="settingsCatalogSearch" type="search" placeholder="Search settings…" aria-label="Search settings">
      <select id="settingsCatalogScope" aria-label="Settings scope">
        <option value="active">Active Brush</option>
        <option value="simulation">Simulation</option>
        <option value="shared">Shared</option>
        <option value="favorites">Favorites</option>
        <option value="all">All</option>
      </select>
      <div id="settingsCatalogResults"></div>
    </div>
    <div id="simBrushSessionCardHost" data-brushes="boid">
      ${renderSimulationSessionCard({
        badgeId: 'simSidebarSessionBadge',
        badgeTone: 'muted',
        badgeLabel: 'Unsaved Draft',
        sessionSelectMarkup: `
          <label class="sim-session-switcher">
            <span>Session Selector</span>
            <select id="simSidebarSessionSelect" class="sim-stage-select" disabled>
              <option value="" disabled selected>Unsaved Draft</option>
            </select>
          </label>`,
        actionsMarkup: `
          <button id="simSidebarNewDraft" type="button">New Draft</button>
          <button id="simSidebarSave" type="button">Save Draft Session</button>
          <button id="btnOpenSimulationSetup" type="button">Stage Setup</button>
          <button id="btnOpenSimulationInspector" type="button">Session Editor</button>`,
        sessionNameId: 'simSidebarSessionName',
        sessionName: 'Simulation session: Unsaved Draft',
        sessionMetaId: 'simSidebarSessionMeta',
        sessionMeta: 'Brush sidebar changes can be captured into the current simulation draft or saved session.',
      })}
    </div>

    <!-- Color History -->
    <div class="section-header" data-section="colorHistory">Colors <span class="chevron">▼</span></div>
    <div class="section-body">
      <div id="colorHistory" style="display:flex;flex-wrap:wrap;gap:2px;min-height:20px;"></div>
    </div>

    <!-- Brush Scale -->
    <div class="section-header" data-section="brushScale">Brush Scale <span class="chevron">▼</span></div>
    <div class="section-body">
      ${sliderRow('brushScale', 'Scale', 10, 300, 100, v => (v/100).toFixed(1))}
    </div>

    <!-- Fill -->
    <div class="section-header closed" data-section="fill">Fill <span class="chevron">▼</span></div>
    <div class="section-body collapsed">
      ${sliderRow('fillTolerance', 'Tolerance', 0, 255, 32)}
    </div>

    <!-- Spawn Shape (boid + ant) -->
    <div class="section-header" data-brushes="boid ant" data-section="spawn">Spawn Shape <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant">
      <label>Shape <select id="spawnShape">
        <option value="circle">● Circle</option><option value="ring">◎ Ring</option>
        <option value="gaussian">☁ Gaussian</option><option value="line">═ Line</option>
        <option value="ellipse">⬮ Ellipse</option><option value="diamond">◆ Diamond</option>
        <option value="grid">▥ Grid</option><option value="sunburst">✱ Sunburst</option>
        <option value="spiral">≋ Spiral</option><option value="poisson">⁘ Poisson</option>
        <option value="random_cluster">✦ Clusters</option>
        <option value="burst">💥 Burst</option><option value="lemniscate">∞ Lemniscate</option>
        <option value="phyllotaxis">🌻 Phyllotaxis</option><option value="noise_scatter">🌧 Noise Scatter</option>
        <option value="bullseye">🎯 Bullseye</option><option value="cross">✚ Cross</option>
        <option value="wave">〜 Wave</option><option value="voronoi">⬡ Voronoi</option>
      </select></label>
      ${sliderRow('spawnRadius', 'Radius', 5, 200, 5)}
      ${sliderRow('spawnAngle', 'Angle', 0, 360, 0, v => v + '°')}
      ${sliderRow('spawnJitter', 'Jitter', 0, 100, 0, v => (v / 100).toFixed(2))}
      <label>Press→Radius <input type="checkbox" id="pressureSpawnRadius"></label>
    </div>

    <!-- Swarm (boid + ant) -->
    <div class="section-header" data-brushes="boid ant" data-section="swarm">Swarm <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant">
      ${sliderRow('count', 'Count', 3, MAX_SWARM_COUNT, 60)}
      <button id="btnBoidColorDist" style="width:100%;margin-top:6px;padding:6px;background:rgba(58,106,232,0.2);border:1px solid rgba(58,106,232,0.3);border-radius:6px;color:#8ab4f8;font-size:11px;cursor:pointer;">🎨 Color Distribution</button>
    </div>

    <!-- Forces (boid + ant) -->
    <div class="section-header" data-brushes="boid ant" data-section="forces">Forces <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant">
      ${sliderRow('seek', 'Seek', 0, 100, 75, v => (v/100).toFixed(2))}
      ${sliderRow('cohesion', 'Cohesion', 0, 100, 15, v => (v/100).toFixed(2))}
      ${sliderRow('separation', 'Separation', 0, 100, 15, v => (v/100).toFixed(2))}
      ${sliderRow('alignment', 'Alignment', 0, 100, 20, v => (v/100).toFixed(2))}
      ${sliderRow('jitter', 'Jitter', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('wander', 'Wander', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('wanderSpeed', 'Wander Spd', 1, 100, 30, v => (v/100).toFixed(2))}
      ${sliderRow('fov', 'FOV', 30, 360, 115, v => v + '°')}
      ${sliderRow('flowField', 'Flow', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('flowScale', 'Flow Scale', 1, 100, 10, v => (v/1000).toFixed(3))}
      ${sliderRow('fleeRadius', 'Flee R', 0, 150, 0)}
      ${sliderRow('individuality', 'Individ.', 0, 100, 0, v => (v/100).toFixed(2))}
    </div>

    <!-- Quorum (boid only) -->
    <div class="section-header closed" data-brushes="boid" data-section="quorum">Quorum <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="boid">
      ${sliderRow('quorumThreshold', 'Threshold', 0, 100, 0, v => v === 0 ? 'off' : v, 'Neighbors required before a local boid group becomes a quorum')}
      ${sliderRow('quorumCompositeStrength', 'Composite', 0, 100, 35, v => (v/100).toFixed(2), 'How strongly quorum groups affect outgroup boids as one composite')}
    </div>

    <!-- Variance (boid + ant) -->
    <div class="section-header closed" data-brushes="boid ant" data-section="variance">Variance <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="boid ant">
      ${sliderRow('sizeVar', 'Size Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('opacityVar', 'Opac Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('speedVar', 'Speed Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('forceVar', 'Force Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('hueVar', 'Hue Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('satVar', 'Satur Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('litVar', 'Light Var', 0, 100, 0, v => (v/100).toFixed(2))}
    </div>

    <!-- Motion (boid + ant) -->
    <div class="section-header" data-brushes="boid ant" data-section="motion">Motion <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant">
      ${sliderRow('maxSpeed', 'Max Speed', 1, 30, 8, v => (v/2).toFixed(1))}
      ${sliderRow('damping', 'Damping', 80, 100, 95, v => (v/100).toFixed(2))}
    </div>

    <div class="section-header closed" data-brushes="boid" data-section="leaders">Leader Boids <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="boid">
      ${sliderRow('leaderCount', 'Leader Count', 0, MAX_SWARM_COUNT, 0)}
      ${sliderRow('leaderPull', 'Leader Pull', 0, 100, 35, v => (v / 100).toFixed(2), 'Extra pull followers feel toward nearby leaders')}
      <span class="slider-desc">The first N boids in each spawned batch become leaders. Enable an override to decouple that leader setting from the main boid controls.</span>
      ${_buildLeaderOverrideRows()}
    </div>

    <!-- Input Modulation (boid only) -->
    <div class="section-header closed" data-brushes="boid" data-section="inputModulation">Input Modulation <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="boid">
      <span class="slider-desc">Route live input channels (pressure, tilt, twist, speed, curvature…) onto allow-listed boid parameters. No routes = no modulation, so existing brushes and presets behave exactly as before.</span>

      <div style="font-weight:600;color:#cbd7e6;margin:8px 0 2px;">Live Channels</div>
      <div id="modMonitorSource" class="slider-desc" style="margin:0 0 4px;">No input sampled yet</div>
      <div id="modChannelMonitor">${_buildModChannelMonitor()}</div>

      <div style="font-weight:600;color:#cbd7e6;margin:10px 0 2px;">Routes</div>
      <div id="modRouteEditor"></div>
      <button id="modAddRouteBtn" type="button" style="width:100%;margin-top:4px;">+ Add Route</button>

      <div style="font-weight:600;color:#cbd7e6;margin:10px 0 2px;">Channel Tuning</div>
      <div id="modChannelTuning"></div>

      <div style="font-weight:600;color:#cbd7e6;margin:10px 0 2px;">Diagnostics</div>
      <pre id="modDiagnostics" class="slider-desc" style="margin:0;white-space:pre-wrap;font-size:10px;line-height:1.4;">No active routes.</pre>

      <div style="display:flex;gap:4px;margin-top:8px;">
        <button id="modShowJsonBtn" type="button" style="flex:1;">Show JSON</button>
        <button id="modResetBtn" type="button" style="flex:1;">Reset Routes</button>
      </div>
      <span id="modMatrixError" class="slider-desc" style="display:none;color:#ff9d9d;"></span>
      <!-- Single structured-state control, following the same convention as
           the pressure-curve editors: a real (non-hidden-type) text input
           holding JSON. That keeps it inside every existing pipe unchanged —
           settings catalog, brush/simulation preset capture and apply, session
           autosave, and workspace export — while the scalar-only preset filter
           sees an ordinary string. -->
      <label id="modMatrixJsonRow" style="display:none;">Modulation Matrix (JSON)
        <input type="text" id="boidModMatrix" value="" spellcheck="false" aria-label="Boid modulation matrix JSON" style="width:100%;font-family:ui-monospace,monospace;font-size:10px;">
      </label>
    </div>

    <!-- Motion Path Graph -->
    <div class="section-header" data-brushes="motionPath" data-section="motionPathGraph">Motion Graph <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="motionPath">
      <label>Active Graph <select id="motionPathDocSelect"></select></label>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin:6px 0;">
        <button id="motionPathEditBtn" type="button">Edit Graph</button>
        <button id="motionPathNewDocBtn" type="button">+ New</button>
        <button id="motionPathRenameDocBtn" type="button">Rename</button>
        <button id="motionPathDeleteDocBtn" type="button">Delete</button>
      </div>
      <div style="padding:8px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;background:rgba(255,255,255,0.04);">
        <div id="motionPathDocName" style="font-weight:600;color:#eef3ff;">Motion Graph 1</div>
        <div id="motionPathDocSummary" class="slider-desc" style="margin-top:4px;">0 paths · 0 agents</div>
      </div>
    </div>

    <!-- Motion Path Runtime -->
    <div class="section-header" data-brushes="motionPath" data-section="motionPathRuntime">Motion Runtime <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="motionPath">
      <label>Render <select id="motionPathRenderMode">
        <option value="ribbon" selected>Ribbon</option>
        <option value="stamps">Stamps</option>
      </select></label>
      <label>Sim Mode <select id="simMotionPathMode">
        <option value="path" selected>Path Follow</option>
        <option value="forces">Force Field</option>
      </select></label>
      ${sliderRow('motionPathAgentCount', 'Agents', 1, MAX_SWARM_COUNT, 12)}
      ${sliderRow('motionPathScale', 'Scale', 10, 1000, 100, v => (v / 100).toFixed(2))}
      ${sliderRow('motionPathSpeed', 'Speed Mult', 0, 5000, 100, v => (v / 100).toFixed(2))}
      ${sliderRow('motionPathAcceleration', 'Accel', 0, 200, 50, v => (v / 100).toFixed(2))}
      ${sliderRow('motionPathAvoidance', 'Avoid', 0, 100, 25, v => (v / 100).toFixed(2))}
      ${sliderRow('motionPathAttraction', 'Attract', 0, 100, 0, v => (v / 100).toFixed(2))}
      ${sliderRow('motionPathSpacing', 'Spacing', 5, 100, 35, v => (v / 100).toFixed(2), 'Lower values pack stamps closer together for a more continuous line')}
      ${sliderRow('motionPathPathSmoothing', 'Path Smooth', 0, 100, 35, v => (v / 100).toFixed(2), 'Rounds sharp corners in the authored motion path before agent movement is sampled')}
      ${sliderRow('motionPathAngleSmoothing', 'Angle Smooth', 0, 100, 90, v => (v / 100).toFixed(2), 'Higher values damp graph rotation changes more strongly')}
      ${sliderRow('motionPathMovementSmoothing', 'Move Smooth', 0, 100, 65, v => (v / 100).toFixed(2), 'Higher values low-pass each agent\'s resolved canvas movement after the graph motion is applied')}
      <span class="slider-desc">Scale enlarges the authored graph on canvas. These are graph-wide defaults until per-agent motion overrides are added in the editor.</span>
    </div>

    <!-- Bristle Shape (bristle only) -->
    <div class="section-header" data-brushes="bristle" data-section="bristleShape">Bristle Shape <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="bristle">
      ${sliderRow('bristleCount', 'Count', 1, 200, 30, null, 'Number of individual bristle hairs')}
      ${sliderRow('bristleWidth', 'Width', 1, 300, 30, null, 'Spread of bristles across brush head')}
      ${sliderRow('bristleSpread', 'Spread', 0, 100, 10, v => (v/100).toFixed(2), 'Random scatter of bristle positions')}
      ${sliderRow('bristleSplay', 'Pressure Splay', 0, 100, 30, v => (v/100).toFixed(2), 'How much pressure fans bristles outward')}
      ${sliderRow('bristleAngleOffset', 'Angle Offset', -180, 180, 0, null, 'Rotate bristle fan angle in place')}
      <div style="display: flex; align-items: center; gap: 8px; padding: 4px; margin: 2px 0;">
        <input type="checkbox" id="bristleFanEnable" style="width: 14px; height: 14px; cursor: pointer;">
        <label for="bristleFanEnable" style="color: #cbd7e6; font-weight: 600; cursor: pointer; flex: 1; margin: 0;">Fanning</label>
      </div>
      ${sliderRow('bristleFan', 'Amount', 0, 1, 0, v => (v*100).toFixed(0) + '%', 'Spread tips wider than roots')}
      ${sliderRow('bristleFanAngle', 'Direction', 0, 360, 90, null, 'Angle direction for tip spread')}
    </div>

    <!-- Bristle Physics (bristle only) -->
    <div class="section-header" data-brushes="bristle" data-section="bristlePhysics">Bristle Physics <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="bristle">
      ${sliderRow('bristleLength', 'Length', 1, 200, 20, null, 'How far tips trail behind roots')}
      ${sliderRow('bristleStiffness', 'Stiffness', 1, 100, 50, v => (v/100).toFixed(2), 'Spring force pulling tips toward roots')}
      ${sliderRow('bristleDamping', 'Damping', 1, 100, 85, v => (v/100).toFixed(2), 'Velocity decay per frame (higher = less bounce)')}
      ${sliderRow('bristleFriction', 'Friction', 0, 100, 40, v => (v/100).toFixed(2), 'Surface drag opposing tip movement')}
      ${sliderRow('bristleSmoothing', 'Smoothing', 0, 100, 50, v => (v/100).toFixed(2), 'Curve smoothing between tip positions')}
    </div>

    <!-- Angle / Hover (simple + motionPath + boid + bristle) -->
    <div class="section-header" data-brushes="simple motionPath boid bristle" data-section="pencilHover">Angle / Hover <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="simple motionPath boid bristle">
      <label>Stroke Angle <select id="strokeAngleMode">
        <option value="auto" selected>Auto</option>
        <option value="path">Cursor Path</option>
        <option value="pencil">Apple Pencil</option>
      </select></label>
      <span class="slider-desc">Choose whether stroke angle follows cursor direction or Apple Pencil angle when available. Motion Path rotates the authored graph with this angle.</span>
      <div data-brushes="boid">
        <label>On Hover <select id="boidHoverAction">
          <option value="spawn" selected>Spawn</option>
          <option value="cull">Cull</option>
          <option value="persist">Persist</option>
        </select></label>
        <label>On Touch <select id="boidTouchAction">
          <option value="spawn" selected>Spawn</option>
          <option value="cull">Cull</option>
          <option value="persist">Persist</option>
        </select></label>
        <label>On Untouch <select id="boidUntouchAction">
          <option value="spawn">Spawn</option>
          <option value="cull">Cull</option>
          <option value="persist" selected>Persist</option>
        </select></label>
        <label>On Unhover <select id="boidUnhoverAction">
          <option value="spawn">Spawn</option>
          <option value="cull">Cull</option>
          <option value="persist" selected>Persist</option>
        </select></label>
        <span class="slider-desc">Spawn ensures a swarm exists, cull clears it, persist keeps the current boids alive</span>
      </div>
    </div>

    <!-- Bristle Variance (bristle only) -->
    <div class="section-header closed" data-brushes="bristle" data-section="bristleVariance">Bristle Variance <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="bristle">
      ${sliderRow('bSizeVar', 'Size Var', 0, 100, 0, v => (v/100).toFixed(2), 'Per-bristle stamp size variation')}
      ${sliderRow('bOpacityVar', 'Opacity Var', 0, 100, 0, v => (v/100).toFixed(2), 'Per-bristle opacity variation')}
      ${sliderRow('bStiffVar', 'Stiffness Var', 0, 100, 0, v => (v/100).toFixed(2), 'Per-bristle spring stiffness variation')}
      ${sliderRow('bLengthVar', 'Length Var', 0, 100, 0, v => (v/100).toFixed(2), 'Per-bristle trail length variation')}
      ${sliderRow('bFrictionVar', 'Friction Var', 0, 100, 0, v => (v/100).toFixed(2), 'Per-bristle surface drag variation')}
      ${sliderRow('bHueVar', 'Hue Var', 0, 100, 0, v => (v/100).toFixed(2), 'Per-bristle color hue shift')}
    </div>

    <!-- Bristle Visual (bristle only) -->
    <div class="section-header" data-brushes="bristle" data-section="bristleVisual">Bristle Visual <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="bristle">
      <label>Show Bristles <input type="checkbox" id="showBristles" checked></label>
    </div>

    <!-- Fluid Brush (fluid only) -->
    <div class="section-header" data-brushes="fluid" data-section="fluidBrush">Fluid Brush <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="fluid">
      ${sliderRow('lbmBrushRadius', 'Brush Radius', 2, 240, 36, null, 'Footprint of each free-flow injection along the stroke')}
      ${sliderRow('lbmSpawnCount', 'Inject', 1, 120, 30, null, 'How much pigment mass is injected at each pointer sample')}
      ${sliderRow('lbmParticleRadius', 'Seed Radius', 1, 24, 3, null, 'Radius of the seed packets used to feed the lattice')}
      ${sliderRow('lbmStrokePull', 'Stroke Pull', 0, 100, 36, v => (v / 100).toFixed(2), 'How strongly new fluid follows the stroke tangent')}
      ${multRow('lbmStrokePull')}
      ${sliderRow('lbmStrokeRake', 'Stroke Rake', 0, 100, 55, v => (v / 100).toFixed(2), 'How much the injected flow fans into distinct lanes')}
      ${multRow('lbmStrokeRake')}
      ${sliderRow('lbmStrokeJitter', 'Stroke Jitter', 0, 100, 65, v => (v / 100).toFixed(2), 'How much turbulence and curl are mixed into each injection')}
      ${multRow('lbmStrokeJitter')}
      ${sliderRow('lbmHueJitter', 'Hue Jitter', 0, 180, 0, v => v + '°', 'Per-injection hue drift for painterly color variation')}
      ${sliderRow('lbmLightnessJitter', 'Light Jitter', 0, 100, 0, v => v + '%', 'Per-injection lightness drift for pigment variation')}
    </div>

    <!-- Stroke Forces (fluid only) -->
    <div class="section-header closed" data-brushes="fluid" data-section="fluidForces">Stroke Forces <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="fluid">
      ${sliderRow('lbmInjectForce', 'Inject Force', 50, 300, 100, v => v + '%', 'Master velocity scale applied to all injection forces')}
      ${multRow('lbmInjectForce')}
      ${sliderRow('lbmVortexStrength', 'Vortex', 0, 100, 0, v => (v / 100).toFixed(2), 'Counter-rotating ring vortices across the stroke — tight spirals and eddies')}
      ${multRow('lbmVortexStrength')}
      ${sliderRow('lbmBurstStrength', 'Burst', 0, 100, 0, v => (v / 100).toFixed(2), 'Radial explosion bursts along the stroke — sunburst splatters')}
      ${multRow('lbmBurstStrength')}
      ${sliderRow('lbmChevronStrength', 'Chevron', 0, 100, 0, v => (v / 100).toFixed(2), 'Herringbone V-pattern injection — feather and fishbone textures')}
      ${multRow('lbmChevronStrength')}
      ${sliderRow('lbmUndulateStrength', 'Undulate', 0, 100, 0, v => (v / 100).toFixed(2), 'Sinusoidal snake-wave offset along the stroke — meander patterns')}
      ${multRow('lbmUndulateStrength')}
    </div>

    <!-- Fluid Flow (fluid only) -->
    <div class="section-header" data-brushes="fluid" data-section="fluidMidrange">Midrange Flow Tuning <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="fluid">
      ${fluidMidrangeRow()}
    </div>

    <!-- Fluid Flow (fluid only) -->
    <div class="section-header closed" data-brushes="fluid" data-section="fluidFlow">Fluid Flow <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="fluid">
      ${nudgeSliderRow('lbmViscosity', 'Viscosity', 0, 100, 28, v => (v / 100).toFixed(2), 'How resistant the lattice flow is to shearing and smearing')}
      ${sliderRow('lbmDensity', 'Density', 0, 100, 30, v => (v / 100).toFixed(2), 'How much mass each injection contributes to the fluid')}
      ${sliderRow('lbmSurfaceTension', 'Surface Tension', 0, 100, 34, v => (v / 100).toFixed(2), 'How strongly the interface holds together while it flows')}
      ${nudgeSliderRow('lbmTimeStep', 'Time Step', 1, 64, 16, v => (v / 16).toFixed(2) + '×', 'Simulation time scale per animation frame')}
      ${sliderRow('lbmSubsteps', 'Substeps', 1, 8, 4, null, 'How many solver iterations run per frame')}
    </div>

    <!-- Fluid Settling (fluid only) -->
    <div class="section-header" data-brushes="fluid" data-section="fluidSettling">Fluid Settling <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="fluid">
      ${nudgeSliderRow('lbmMotionDecay', 'Motion Slowdown', 0, 100, 34, v => (v / 100).toFixed(2), 'How quickly motion energy drains from the flow itself')}
      ${nudgeSliderRow('lbmStopSpeed', 'Stop Threshold', 0, 100, 14, v => (v / 100).toFixed(2), 'Velocity below which motion is treated as stopped')}
      ${sliderRow('lbmPigmentCarry', 'Pigment Carry', 0, 100, 65, v => (v / 100).toFixed(2), 'How long visible pigment keeps gliding once the flow slows down')}
      ${sliderRow('lbmPigmentRetention', 'Pigment Retention', 0, 100, 78, v => (v / 100).toFixed(2), 'How much pigment and phase remain while the fluid settles')}
    </div>

    <!-- Fluid Rendering (fluid only) -->
    <div class="section-header closed" data-brushes="fluid" data-section="fluidRendering">Fluid Rendering <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="fluid">
      <label>Render <select id="lbmRenderMode">
        <option value="hybrid">Hybrid</option>
        <option value="grid">Grid</option>
        <option value="particles">Particles</option>
      </select></label>
      <label>Fast First Pass <input type="checkbox" id="lbmFirstPassPreview" checked></label>
      <span class="slider-desc">Preview the stroke at a lower internal resolution, then replay a full-resolution final render when the fluid settles.</span>
      ${sliderRow('lbmResolutionScale', 'Resolution', 50, 200, 100, v => v + '%', 'Internal lattice resolution relative to the canvas')}
      ${sliderRow('lbmFluidScale', 'Fluid Scale', 35, 200, 115, v => (v / 100).toFixed(2) + '×', 'Zoom the fluid grid independently of the canvas')}
      <label>Show Flow <input type="checkbox" id="lbmShowFlow" checked></label>
    </div>



    <!-- 3D Fluid Brush (fluid3d only) -->
    <div class="section-header" data-brushes="fluid3d" data-section="fluid3dBrush">3D Fluid Brush <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="fluid3d">
      ${sliderRow('fluid3dBrushRadius', 'Brush Radius', 4, 240, 40, null, 'Emitter footprint for the 3D Fluid brush')}
      ${sliderRow('fluid3dEmitterCount', 'Emitters', 1, 32, 5, null, 'Emitter records generated per pointer sample')}
      ${sliderRow('fluid3dEmissionRate', 'Emission', 1, 100, 38, v => (v / 100).toFixed(2), 'How much thickness/volume is injected into the grid')}
      ${sliderRow('fluid3dEmitterStrength', 'Strength', 1, 100, 29, v => (v / 100).toFixed(2), 'Impulse strength applied by direct brush emitters')}
      ${sliderRow('fluid3dEmitterVelocity', 'Velocity', 1, 100, 18, v => (v / 100).toFixed(2), 'How strongly emitter velocity drives the fluid state')}
    </div>

    <!-- 3D Fluid Dynamics (fluid3d only) -->
    <div class="section-header" data-brushes="fluid3d" data-section="fluid3dDynamics">3D Fluid Dynamics <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="fluid3d">
      ${sliderRow('fluid3dPressure', 'Pressure', 1, 100, 44, v => (v / 100).toFixed(2), 'Pressure response for thickness/volume changes')}
      ${sliderRow('fluid3dMomentum', 'Momentum', 1, 100, 80, v => (v / 100).toFixed(2), 'Velocity retention between frames')}
      ${sliderRow('fluid3dVelocityDiffuse', 'Vel Diffuse', 0, 100, 34, v => (v / 100).toFixed(2), 'Neighbor velocity blending for stable flow')}
      ${sliderRow('fluid3dDrag', 'Drag', 0, 100, 29, v => (v / 100).toFixed(2), 'Global drag before scalar-field or terrain modifiers')}
      ${sliderRow('fluid3dThicknessDecay', 'Decay', 0, 100, 15, v => (v / 100).toFixed(2), 'Thickness loss while the fluid settles')}
      ${sliderRow('fluid3dPigmentDiffusion', 'Pigment', 0, 100, 24, v => (v / 100).toFixed(2), 'Pigment transport / blending strength')}
      ${sliderRow('fluid3dPressureFade', 'Pressure Fade', 0, 100, 24, v => (v / 100).toFixed(2), 'Pressure dissipation after injection')}
      ${sliderRow('fluid3dSettleThreshold', 'Settle', 0, 20, 4, v => (v / 100).toFixed(2), 'Rest threshold used for final commit timing')}
      ${sliderRow('fluid3dMaxVelocity', 'Max Velocity', 1, 40, 12, v => (v / 10).toFixed(1), 'Velocity clamp for stability and responsiveness')}
      ${sliderRow('fluid3dThicknessFloor', 'Thickness Floor', 1, 20, 4, v => (v / 1000).toFixed(3), 'Minimum thickness retained before a cell turns inactive')}
      ${sliderRow('fluid3dOccupancyBias', 'Occupancy', 0, 100, 8, v => (v / 100).toFixed(2), 'How quickly occupancy ramps up for blob-ready state')}
      ${sliderRow('fluid3dSpreadClamp', 'Spread Cap', 20, 140, 82, v => (v / 100).toFixed(2), 'Caps local thickness buildup so swirl can spread without ballooning into large blobs')}
      ${sliderRow('fluid3dSurfaceTension', 'Surface Tension', 0, 100, 18, v => (v / 100).toFixed(2), 'Adds inward pull at the fluid edge to keep the boundary tighter while preserving motion')}
      ${sliderRow('fluid3dEdgeWidth', 'Edge Width', 10, 100, 42, v => (v / 100).toFixed(2), 'Controls how wide the active edge band is before the core flow takes over')}
      ${sliderRow('fluid3dEdgeDrag', 'Edge Drag', 0, 100, 16, v => (v / 100).toFixed(2), 'Adds drag only at the edge so the rim settles without flattening interior swirl')}
    </div>

    <!-- 3D Fluid Interaction (fluid3d only) -->
    <div class="section-header closed" data-brushes="fluid3d" data-section="fluid3dInteraction">3D Fluid Interaction <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="fluid3d">
      ${sliderRow('fluid3dInfluenceStrength', 'Influence', 0, 100, 38, v => (v / 100).toFixed(2), 'Strength for external influence records and cursor side-forces')}
      ${sliderRow('fluid3dInfluenceRadius', 'Influence R', 10, 240, 120, null, 'Radius used for generic influence inputs')}
      ${sliderRow('fluid3dTerrainWeight', 'Terrain', 0, 100, 18, v => (v / 100).toFixed(2), 'Coupling from terrain/height into pressure and velocity')}
      ${sliderRow('fluid3dScalarFieldInfluence', 'Scalar Fields', 0, 100, 45, v => (v / 100).toFixed(2), 'Strength of future drag/capacity/directional field inputs')}
      ${sliderRow('fluid3dOpacity', 'Pigment Alpha', 1, 100, 60, v => (v / 100).toFixed(2), 'Per-emitter pigment alpha for the 3D fluid brush')}
      ${sliderRow('fluid3dOpacityScale', 'Opacity', 1, 100, 100, v => (v / 100).toFixed(2), 'Commit opacity scale derived from simulated mass')}
      <label>Injector <select id="fluid3dInjectorMode">
        <option value="direct">Direct</option>
        <option value="motion">Motion</option>
        <option value="swirl">Swirl</option>
      </select></label>
      ${sliderRow('fluid3dInjectorMotion', 'Motion Weight', 0, 100, 70, v => (v / 100).toFixed(2), 'How strongly injector behavior responds to stroke motion rather than static radial deposit')}
      ${sliderRow('fluid3dInjectorPigment', 'Pigment Motion', 0, 100, 82, v => (v / 100).toFixed(2), 'How much pigment visibility favors moving flow over circular direct placement')}
      ${sliderRow('fluid3dInjectorOccupancy', 'Occupancy Motion', 0, 100, 74, v => (v / 100).toFixed(2), 'How much blob/occupancy buildup is reduced when the stroke is not moving')}
      ${sliderRow('fluid3dInjectorSwirl', 'Swirl Bias', 0, 100, 36, v => (v / 100).toFixed(2), 'Tangential swirl added by the injector when Swirl mode is active')}
    </div>

    <!-- 3D Fluid Rendering (fluid3d only) -->
    <div class="section-header" data-brushes="fluid3d" data-section="fluid3dRendering">3D Fluid Rendering <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="fluid3d">
      <label>Render <select id="fluid3dRenderMode">
        <option value="volume">Volume</option>
        <option value="pressure">Pressure</option>
        <option value="pigment">Pigment</option>
      </select></label>
      <label>Adaptive Quality <input type="checkbox" id="fluid3dAdaptiveQuality" checked></label>
      ${sliderRow('fluid3dResolutionScale', 'Resolution', 40, 150, 90, v => v + '%', 'Full-resolution simulation scale used for settle replay and final commit')}
      ${sliderRow('fluid3dPreviewScale', 'Preview', 30, 120, 55, v => v + '%', 'Active-stroke preview scale used before final replay')}
      ${sliderRow('fluid3dFluidScale', 'Fluid Scale', 40, 200, 120, v => (v / 100).toFixed(2) + '×', 'Independent scale of the simulation lattice relative to canvas size')}
      <label>Show Field <input type="checkbox" id="fluid3dShowField"></label>
    </div>

    <!-- Stamp -->
    <div class="section-header" data-section="stamp">Stamp <span class="chevron">▼</span></div>
    <div class="section-body">
      ${sliderRow('stampSize', 'Size', 1, 40, 10)}
      ${sliderRow('stampOpacity', 'Opacity', 1, 100, 15, v => (v/100).toFixed(2))}
      ${sliderRow('stampSeparation', 'Separation', 0, 80, 0)}
      ${sliderRow('smudge', 'Smudge', 0, 100, 0, v => (v/100).toFixed(2), 'Blend with existing canvas colour')}
      <label>Smudge Only <input type="checkbox" id="smudgeOnly"></label>
      ${sliderRow('skipStamps', 'Skip Start', 0, 60, 0)}
      <label>Press→Size <input type="checkbox" id="pressureSize" checked></label>
      <label>Press→Opac <input type="checkbox" id="pressureOpacity" checked></label>
      <label>Flat Stroke <input type="checkbox" id="flatStroke"></label>
      ${sliderRow('stabilizer', 'Stabilizer', 0, 100, 0)}
      <label>Wave <select id="strokeWaveType">
        <option value="none">Off</option>
        <option value="sine">Sine</option>
      </select></label>
      ${sliderRow('strokeWaveAmplitude', 'Wave Amp', 0, 200, 0, v => v + ' px', 'Offsets the stroke normal to the drawn path')}
      ${sliderRow('strokeWaveLength', 'Wave Length', 4, 400, 80, v => v + ' px', 'Distance along the stroke for one full wave cycle')}
      ${sliderRow('strokeWavePhase', 'Wave Phase', 0, 360, 0, v => v + '°', 'Phase offset applied at stroke start')}
    </div>

    <!-- Stamp Image -->
    <div class="section-header closed" data-brushes="boid ant bristle simple eraser motionPath" data-section="stampImage">Stamp Image <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="boid ant bristle simple eraser motionPath">
      <label>Enable <input type="checkbox" id="stampImageEnabled" checked></label>
      <div id="stampPresetSwitcher"></div>
      <span class="slider-desc">Built-in free silhouettes for quick switching. Upload still works for custom stamps.</span>
      <div style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;">
        <canvas id="stampImagePreview" width="72" height="72" style="width:72px;height:72px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:#0d0d12;image-rendering:auto;"></canvas>
        <div style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;">
          <strong id="stampImageName" style="font-size:12px;">No stamp loaded</strong>
          <span id="stampImageFileName" class="slider-desc">Upload a PNG, WebP, JPEG, or similar image</span>
        </div>
      </div>
      <div style="display:flex;gap:4px;align-items:center;margin:4px 0;">
        <button id="btnUploadStampImage" style="flex:1;">📂 Upload Stamp</button>
        <button id="btnClearStampImage" style="flex-shrink:0;">✕</button>
      </div>
      <label>Tint With Brush <input type="checkbox" id="stampImageTint" checked></label>
      ${sliderRow('stampImageRotation', 'Rotation', 0, 360, 0, v => v + '°', 'Rotate the loaded stamp while preserving its aspect ratio and soft alpha')}
    </div>

    <!-- Canvas Texture -->
    <div class="section-header closed" data-section="canvasTexture">Canvas Texture <span class="chevron">▼</span></div>
    <div class="section-body collapsed">
      <label>Enable <input type="checkbox" id="canvasTextureEnabled"></label>
      <label>Show On Canvas <input type="checkbox" id="canvasTextureShowOnCanvas"></label>
      <label>Active <select id="canvasTexturePreset"></select></label>
      <div style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;">
        <canvas id="texturePreview" width="72" height="72" style="width:72px;height:72px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:#0d0d12;image-rendering:auto;"></canvas>
        <div style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;">
          <strong id="textureName" style="font-size:12px;">Paper Grain</strong>
          <span id="textureFileName" class="slider-desc">Built-in texture</span>
        </div>
      </div>
      <div style="display:flex;gap:4px;align-items:center;margin:4px 0;">
        <button id="btnUploadTexture" style="flex:1;">📂 Load Texture</button>
        <button id="btnClearTexture" style="flex-shrink:0;">✕</button>
      </div>
      ${sliderRow('canvasTextureStrength', 'Master Strength', 0, 100, 60, v => (v/100).toFixed(2), 'Overall intensity applied across all texture responses')}
      ${sliderRow('canvasTextureScale', 'Scale', 10, 500, 100, v => (v/100).toFixed(1) + '×', 'Tile scale of the texture pattern')}
      ${sliderRow('canvasTextureOffsetX', 'Offset X', -500, 500, 0, v => (v/10).toFixed(1), 'Shift the texture pattern horizontally in canvas-space units')}
      ${sliderRow('canvasTextureOffsetY', 'Offset Y', -500, 500, 0, v => (v/10).toFixed(1), 'Shift the texture pattern vertically in canvas-space units')}
      ${sliderRow('canvasTextureRotation', 'Rotation', 0, 360, 0, v => v + '°', 'Rotate the texture field before sampling')}
      <label>Invert Height <input type="checkbox" id="canvasTextureInvert"></label>
      ${sliderRow('canvasTextureDeposit', 'Deposit Mask', 0, 100, 100, v => (v/100).toFixed(2), 'How strongly texture peaks reduce paint deposit')}
      ${sliderRow('canvasTextureFlow', 'Flow Bias', 0, 100, 100, v => (v/100).toFixed(2), 'How much texture slope contributes to flow-driven behavior')}
      ${sliderRow('canvasTextureEdgeBreakup', 'Edge Breakup', 0, 100, 35, v => (v/100).toFixed(2), 'How much texture roughness frays stamp edges')}
      ${sliderRow('canvasTextureSmudgeDrag', 'Smudge Drag', 0, 100, 30, v => (v/100).toFixed(2), 'How much smudge sampling slides into texture valleys')}
      ${sliderRow('canvasTexturePooling', 'Pooling Bias', 0, 100, 55, v => (v/100).toFixed(2), 'How strongly fluid pooling favors texture valleys')}
    </div>

    <!-- Symmetry (closed by default) -->
    <div class="section-header closed" data-section="symmetry">Symmetry <span class="chevron">▼</span></div>
    <div class="section-body collapsed">
      <label>Enable <input type="checkbox" id="symmetryEnabled"></label>
      <label>Mode <select id="symmetryMode"><option value="radial">Radial</option><option value="path">Path</option></select></label>
      <label>Show Guide <input type="checkbox" id="symmetryGuideVisible" checked></label>
      ${sliderRow('symmetryCount', 'Count', 2, 16, 4)}
      <label for="symmetrySizeMultipliers">Copy Sizes <input type="text" id="symmetrySizeMultipliers" value="1" placeholder="1, 0.9, 0.8" aria-describedby="symmetrySizeMultipliersDesc"></label>
      <span class="slider-desc" id="symmetrySizeMultipliersDesc">Comma- or space-separated size multipliers applied to copies in order; the last value repeats for remaining copies.</span>
      <div data-symmetry-mode-panel="radial">
        <label>Mirror <input type="checkbox" id="symmetryMirror"></label>
        ${sliderRow('symmetryCenterX', 'Center X', 0, 100, 50, v => v + '%')}
        ${sliderRow('symmetryCenterY', 'Center Y', 0, 100, 50, v => v + '%')}
      </div>
      <div data-symmetry-mode-panel="path" style="display:none;">
        <label>Mirror <input type="checkbox" id="symmetryPathMirror"></label>
        <label>Curve <input type="checkbox" id="symmetryPathUseCurve"></label>
        <span class="slider-desc">Drag nodes on the canvas to shape the copy path. Shift-click the guide to add a node, and Alt-click a node to remove it.</span>
      </div>
    </div>

    <!-- Taper -->
    <div class="section-header" data-section="taper">Taper <span class="chevron">▼</span></div>
    <div class="section-body">
      ${sliderRow('taperLength', 'Length', 0, 120, 20, v => +v === 0 ? 'off' : v + ' frames')}
      ${sliderRow('taperCurve', 'Curve', 10, 300, 100, v => (v/100).toFixed(1))}
      <label>Taper Size <input type="checkbox" id="taperSize" checked></label>
      <label>Taper Opac <input type="checkbox" id="taperOpacity" checked></label>
    </div>

    <!-- Sensing -->
    <div class="section-header" data-brushes="boid ant" data-section="sensing">Pixel Sensing <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant" data-section="sensing">
      <label>Enable <input type="checkbox" id="sensingEnabled"></label>
      <label>Mode <select id="sensingMode"><option value="avoid">Avoid</option><option value="attract">Attract</option></select></label>
      <label>Channel <select id="sensingChannel"><option value="darkness">Darkness</option><option value="lightness">Lightness</option><option value="saturation">Saturation</option><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option><option value="alpha">Alpha</option></select></label>
      ${sliderRow('sensingStrength', 'Strength', 0, 100, 50, v => (v/100).toFixed(2))}
      ${sliderRow('sensingRadius', 'Radius', 5, 80, 20)}
      ${sliderRow('sensingFitRadius', 'Fit Radius', 0, 80, 0)}
      ${sliderRow('sensingThreshold', 'Threshold', 0, 100, 10, v => (v/100).toFixed(2))}
      ${sliderRow('sensingUpdateFrames', 'Update Every', 1, 50, 30, v => `${Math.round(v)}f`, 'Frames between sensing refreshes for Active and All sources')}
      <label>Source <select id="sensingSource"><option value="below">Below</option><option value="all">All</option><option value="active">Active</option><option value="selected">Selected Layers</option></select></label>
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <button id="sensingSourceLayersBtn" type="button" style="flex:0 0 auto;padding:6px 10px;background:rgba(58,106,232,0.18);border:1px solid rgba(58,106,232,0.3);border-radius:6px;color:#dce6ff;font-size:11px;cursor:pointer;">Pick Layers</button>
        <span id="sensingSourceLayersSummary" class="slider-desc" style="margin:0;flex:1;min-width:0;">Custom: No custom sources selected</span>
      </div>
      <div style="display:flex;gap:6px;align-items:flex-start;margin-top:6px;">
        <button id="sensingRulesBtn" type="button" style="flex:0 0 auto;padding:6px 10px;background:rgba(58,106,232,0.18);border:1px solid rgba(58,106,232,0.3);border-radius:6px;color:#dce6ff;font-size:11px;cursor:pointer;">Edit Rules…</button>
        <span id="sensingRulesSummary" class="slider-desc" style="margin:0;flex:1;min-width:0;">1 rule (from controls above)</span>
      </div>
    </div>

    <!-- Visual (boid + ant) -->
    <div class="section-header" data-brushes="boid ant" data-section="visual">Visual <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant">
      <label>Show Particles <input type="checkbox" id="showBoids" checked></label>
      <label>Show Spawn <input type="checkbox" id="showSpawn" checked></label>
    </div>

    <!-- Pheromone (ant only) -->
    <div class="section-header" data-brushes="ant" data-section="antPheromone">Pheromone <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="ant">
      ${sliderRow('antFollow', 'Follow Cursor', 0, 100, 40, v => (v/100).toFixed(2), 'How strongly ants follow the cursor')}
      ${sliderRow('antPheromoneRate', 'Deposit Rate', 0, 100, 50, v => (v/100).toFixed(2), 'Intensity of pheromone deposited per ant per frame')}
      ${sliderRow('antPheromoneDecay', 'Evaporation', 1, 100, 20, v => (v/1000).toFixed(3), 'Pheromone decay rate per frame (higher = faster fade)')}
      ${sliderRow('antPheromoneSize', 'Trail Width', 1, 30, 6, null, 'Radius of each pheromone deposit in pixels')}
      <label>Show Trail <input type="checkbox" id="antTrailVisible" checked></label>
      <span class="slider-desc">Render pheromone trail overlay (green glow)</span>
      <label>Phero→Sensing <input type="checkbox" id="antPheromoneToSensing" checked></label>
      <span class="slider-desc">Feed pheromone grid into WASM sensing (ants attract to trails)</span>
      <button id="btnAntMath" style="width:100%;margin-top:6px;padding:6px;background:rgba(58,106,232,0.2);border:1px solid rgba(58,106,232,0.3);border-radius:6px;color:#8ab4f8;font-size:11px;cursor:pointer;">🔬 Ant Math Variables</button>
    </div>

    <!-- Trail Blur -->
    <div class="section-header" data-section="trailBlur">Trail Blur <span class="chevron">▼</span></div>
    <div class="section-body">
      ${sliderRow('trailBlur', 'Trail Blur', 0, 20, 0, null, 'Softly diffuse wet ink trails outward after each frame')}
      ${sliderRow('trailFlow', 'Texture Flow', 0, 100, 0, v => (v / 100).toFixed(2), 'Bias blur diffusion toward lower-height canvas texture areas (requires texture)')}
    </div>

    <!-- Pigment Mix / KM -->
    <div class="section-header" data-section="kmMix">Pigment Mix <span class="chevron">▼</span></div>
    <div class="section-body">
      <label>Enable <input type="checkbox" id="kmMix"></label>
      <span class="slider-desc">Physically-based subtractive pigment mixing (blue+yellow→green)</span>
      ${sliderRow('kmStrength', 'Strength', 0, 100, 50, v => (v / 100).toFixed(2), 'How strongly the brush pigment mixes into existing paint')}
    </div>

    <!-- Impasto -->
    <div class="section-header" data-section="impasto">Impasto <span class="chevron">▼</span></div>
    <div class="section-body">
      <label>Enable <input type="checkbox" id="impasto"></label>
      <span class="slider-desc">Build up paint height — directional lighting reveals 3D ridges</span>
      ${sliderRow('impastoStrength', 'Strength', 0, 100, 60, v => (v / 100).toFixed(2))}
      ${sliderRow('impastoLightAngle', 'Light Angle', 0, 360, 45, v => v + '°')}
      ${sliderRow('impastoLightElevation', 'Light Elev.', 0, 90, 45, v => v + '°')}
    </div>
    <!-- Presets -->
    <div class="section-header" data-section="presets">Presets <span class="chevron">▼</span></div>
    <div class="section-body">
      <div style="display:flex;gap:3px;margin-bottom:5px;">
        <select id="presetLibraryScope" aria-label="Preset library scope" style="flex:1;">
          <option value="active">Active Brush / Mode</option>
          <option value="all">All Presets</option>
        </select>
        <input id="presetLibrarySearch" type="search" placeholder="Search…" aria-label="Search presets" style="min-width:0;flex:1;">
      </div>
      <div id="builtinPresets" style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:6px;"></div>
      <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;margin-top:4px;">
        <div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px;">
          <button id="btnSavePreset" class="save-btn">💾 Brush</button>
          <button id="btnSaveSimulationPreset">💾 Simulation</button>
          <button id="btnImportPreset">📥 File</button>
          <button id="btnExportPresets">📤 Library</button>
        </div>
        <div id="userPresets"></div>
      </div>
    </div>

    <div class="section-header closed" data-brushes="boid ant" data-section="brushSettings">Brush Settings <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="boid ant">
      <label>Show Sim Overlay <input type="checkbox" id="showSimulationOverlayControls"></label>
      <span class="slider-desc">Off keeps simulation quick controls in the left drawer. On restores the floating overlay HUD.</span>
    </div>

    <div id="simControlStore" style="display:none" aria-hidden="true">
      <label>Ephemeral Mode <input type="checkbox" id="simEphemeralMode"></label>
      <label>Speed <span id="v_simSpeed">1.0×</span><input type="range" id="simSpeed" min="10" max="300" value="100"></label>
      ${sliderRow('simEphemeralFrames', 'Trail Length', 1, 240, 45, v => `${Math.round(v)}f`)}
      ${sliderRow('simEphemeralFade', 'Fade Speed', 10, 300, 100, v => (v / 100).toFixed(2))}
      ${sliderRow('simPointStrength', 'Point Force', 0, 200, 90, v => (v/100).toFixed(2))}
      ${sliderRow('simPointRadius', 'Point Radius', 10, 300, 120)}
      ${sliderRow('simBoundsMargin', 'Bounds Margin', 0, 240, 0, v => `${v}px`)}
      ${sliderRow('simPathSpeed', 'Path Speed', 1, 200, 120, v => `${v}px/s`)}
      ${sliderRow('simEdgeForce', 'Edge Force', 0, 200, 100, v => (v/100).toFixed(2))}
      ${sliderRow('simEdgeRadius', 'Avoid Radius', 0, 200, 28)}
      ${sliderRow('simPheroPaintRadius', 'Phero Radius', 2, 80, 18)}
      ${sliderRow('simPheroPaintStrength', 'Phero Paint', 0, 100, 55, v => (v/100).toFixed(2))}
    </div>
  `;

  // ── Wire section toggles ──
  sb.querySelectorAll('.section-header').forEach(h => {
    h.addEventListener('click', () => toggleSection(h));
  });

  // ── Wire slider readouts ──
  sb.querySelectorAll('input[type="range"]').forEach(inp => {
    const span = document.getElementById('v_' + inp.id);
    if (!span) return;
    const fmt = _sliderFormats[inp.id];
    const update = () => {
      span.textContent = fmt ? fmt(+inp.value) : inp.value;
      app.invalidateParams();
      syncEdgeSliders(app);
    };
    inp.addEventListener('input', update);
  });

  sb.querySelectorAll('.slider-nudge-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      _nudgeRangeValue(target, Number(btn.dataset.delta) || 0);
    });
  });

  sb.querySelectorAll('.mult-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const dir = Number(btn.dataset.dir);
      const idxEl = document.getElementById(targetId + '_multIdx');
      const dispEl = document.getElementById(targetId + '_multDisp');
      if (!idxEl || !dispEl) return;
      const newIdx = Math.max(0, Math.min(MULT_STEPS.length - 1, Number(idxEl.value) + dir));
      idxEl.value = String(newIdx);
      dispEl.textContent = _fmtMult(newIdx);
      app.invalidateParams();
    });
  });

  sb.querySelectorAll('.fluid-midrange-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const bias = Number(btn.dataset.fluidBias);
      const updates = bias === 0 ? {
        lbmTimeStep: 16,
        lbmMotionDecay: 34,
        lbmStopSpeed: 14,
        lbmViscosity: 28,
      } : {
        lbmTimeStep: (Number(document.getElementById('lbmTimeStep')?.value) || 10) + bias,
        lbmMotionDecay: (Number(document.getElementById('lbmMotionDecay')?.value) || 62) - bias * 2,
        lbmStopSpeed: (Number(document.getElementById('lbmStopSpeed')?.value) || 24) - bias,
        lbmViscosity: (Number(document.getElementById('lbmViscosity')?.value) || 76) - bias,
      };
      for (const [id, value] of Object.entries(updates)) {
        _updateSliderValue(document.getElementById(id), value);
      }
      app.showToast(
        bias === 0
          ? '💧 Midrange flow reset'
          : bias < 0
            ? '💧 Midrange flow nudged calmer'
            : '💧 Midrange flow nudged livelier'
      );
    });
  });

  // Checkbox & select → invalidate params
  sb.querySelectorAll('input[type="checkbox"], select, input[type="number"], input[type="text"]').forEach(el => {
    el.addEventListener('change', () => app.invalidateParams());
  });
  sb.querySelectorAll('input[type="text"]').forEach(el => {
    el.addEventListener('input', () => app.invalidateParams());
  });
  document.getElementById('symmetryMode')?.addEventListener('change', _syncSymmetryModeUi);
  _syncSymmetryModeUi();
  document.getElementById('showSimulationOverlayControls')?.addEventListener('change', () => {
    app._syncSimulationUI?.();
  });

  const sensingSourceSelect = document.getElementById('sensingSource');
  if (sensingSourceSelect) {
    sensingSourceSelect.dataset.prevValue = sensingSourceSelect.value || 'below';
    sensingSourceSelect.addEventListener('change', () => {
      const previousValue = sensingSourceSelect.dataset.prevValue || 'below';
      app._handleSensingSourceChange?.(sensingSourceSelect.value, previousValue);
    });
  }
  document.getElementById('sensingSourceLayersBtn')?.addEventListener('click', event => {
    app.toggleSensingSourcePicker?.(event.currentTarget);
  });

  LEADER_OVERRIDE_FIELDS.forEach(field => {
    document.getElementById(field.overrideId)?.addEventListener('change', (event) => {
      if (event.target.checked) _copyLeaderOverrideFromSource(field);
      _syncLeaderOverrideUI();
      app.invalidateParams();
    });
  });
  _syncLeaderOverrideUI();

  // ── Boid Input Modulation Framework ──
  // One delegated listener per event type over the whole section: dynamic
  // route/condition controls carry `data-mod-*` attributes instead of ids, so
  // they never enter the settings catalog and never collide with preset keys.
  const modSection = document.getElementById('modRouteEditor')?.closest('.section-body');
  const _modApplyControlEdit = (target, { rerender }) => {
    const prop = target.dataset.modProp;
    if (!prop) return false;
    const matrix = _readModMatrix();
    if (target.dataset.modChannel) {
      const channel = getFeatureChannel(target.dataset.modChannel);
      if (!channel) return false;
      const current = matrix.channels[channel.id] || { smoothing: channel.smoothing, deadzone: channel.deadzone };
      matrix.channels[channel.id] = { ...current, [prop]: Number(target.value) };
      _writeModMatrix(app, matrix, { rerender: false });
      return true;
    }
    const route = matrix.routes.find(entry => entry.id === target.dataset.modRoute);
    if (!route) return false;
    const conditionIndex = target.dataset.modCond === undefined ? -1 : Number(target.dataset.modCond);
    if (conditionIndex >= 0) {
      const condition = route.conditions[conditionIndex];
      if (!condition) return false;
      condition[prop] = prop === 'channel' || prop === 'op' ? target.value : Number(target.value);
    } else if (prop === 'enabled' || prop === 'invert') {
      route[prop] = !!target.checked;
    } else if (prop === 'amount') {
      route.amount = Number(target.value) / 100;
    } else if (prop === 'priority') {
      route.priority = Number(target.value);
    } else if (prop === 'clampMin' || prop === 'clampMax') {
      route[prop] = Number(target.value);
    } else {
      route[prop] = target.value;
    }
    _writeModMatrix(app, matrix, { rerender });
    return true;
  };

  modSection?.addEventListener('input', event => {
    const target = event.target;
    if (!target?.dataset?.modProp) return;
    // Live-drag path: update the readout only so the slider keeps focus.
    if (target.type === 'range') {
      const readout = modSection.querySelector(`[data-mod-readout="${target.dataset.modRoute}:${target.dataset.modProp}"]`);
      if (readout) readout.textContent = (Number(target.value) / 100).toFixed(2);
      _modApplyControlEdit(target, { rerender: false });
      return;
    }
    if (target.tagName === 'SELECT' || target.type === 'checkbox') return;
    // Half-typed number fields read as '' → Number('') === 0, which would
    // briefly slam a clamp to zero. Wait for `change` (blur/commit) instead.
    if (target.value === '') return;
    _modApplyControlEdit(target, { rerender: false });
  });

  modSection?.addEventListener('change', event => {
    const target = event.target;
    if (target === _modMatrixControl()) {
      _syncModMatrixUi(app);
      app.invalidateParams();
      return;
    }
    if (!target?.dataset?.modProp) return;
    // Structural edits (source/target/curve/combine/condition op) change which
    // controls are relevant, so re-render; value edits do not.
    const structural = target.tagName === 'SELECT' || target.type === 'checkbox';
    _modApplyControlEdit(target, { rerender: structural });
  });

  modSection?.addEventListener('click', event => {
    const button = event.target.closest('[data-mod-action]');
    if (!button) return;
    const matrix = _readModMatrix();
    const route = matrix.routes.find(entry => entry.id === button.dataset.modRoute);
    if (button.dataset.modAction === 'remove-route') {
      matrix.routes = matrix.routes.filter(entry => entry.id !== button.dataset.modRoute);
    } else if (button.dataset.modAction === 'add-condition' && route) {
      if (route.conditions.length >= MOD_CONDITION_LIMIT) return;
      route.conditions.push({ channel: route.source, op: 'gt', value: 0.5, value2: 1 });
    } else if (button.dataset.modAction === 'remove-condition' && route) {
      route.conditions.splice(Number(button.dataset.modCond), 1);
    } else {
      return;
    }
    _writeModMatrix(app, matrix);
  });

  document.getElementById('modAddRouteBtn')?.addEventListener('click', () => {
    const matrix = _readModMatrix();
    if (matrix.routes.length >= MOD_ROUTE_LIMIT) {
      app.showToast(`Modulation is limited to ${MOD_ROUTE_LIMIT} routes`);
      return;
    }
    // New routes default to amount 0 so adding one never changes the painting
    // until an amount is dialed in.
    matrix.routes.push(createModRoute({
      id: `r${Date.now().toString(36)}`,
      source: 'pressure',
      target: 'cohesion',
      amount: 0,
      combine: 'sum',
    }));
    _writeModMatrix(app, matrix);
  });

  document.getElementById('modResetBtn')?.addEventListener('click', () => {
    _writeModMatrix(app, emptyModMatrix());
    _setModMatrixError('');
    app.showToast('Modulation routes cleared');
  });

  document.getElementById('modShowJsonBtn')?.addEventListener('click', event => {
    const row = document.getElementById('modMatrixJsonRow');
    if (!row) return;
    const showing = row.style.display === 'none';
    row.style.display = showing ? '' : 'none';
    event.currentTarget.textContent = showing ? 'Hide JSON' : 'Show JSON';
  });

  app._refreshModulationDebugUi = () => _refreshModulationDebugUi(app);
  _syncModMatrixUi(app);

  // ── Canvas texture upload ──
  const _texFileInput = document.createElement('input');
  _texFileInput.type = 'file';
  _texFileInput.accept = 'image/*';
  _texFileInput.addEventListener('change', async () => {
    const file = _texFileInput.files[0];
    if (!file) return;
    await app.loadCanvasTexture(file);
    syncTextureUI(app);
    app.compositeAllLayers({ forceFull: true });
    _texFileInput.value = '';
  });
  document.getElementById('btnUploadTexture')?.addEventListener('click', () => _texFileInput.click());
  document.getElementById('canvasTexturePreset')?.addEventListener('change', (e) => {
    app.setCanvasTextureById(e.target.value);
    syncTextureUI(app);
    app.compositeAllLayers({ forceFull: true });
  });
  document.getElementById('btnClearTexture')?.addEventListener('click', () => {
    app.clearCanvasTexture();
    syncTextureUI(app);
    app.compositeAllLayers({ forceFull: true });
  });

  const texturePreviewRefreshIds = [
    'canvasTextureEnabled',
    'canvasTextureShowOnCanvas',
    'canvasTextureStrength',
    'canvasTextureScale',
    'canvasTextureOffsetX',
    'canvasTextureOffsetY',
    'canvasTextureRotation',
    'canvasTextureInvert',
    'canvasTextureDeposit',
    'canvasTextureFlow',
    'canvasTextureEdgeBreakup',
    'canvasTextureSmudgeDrag',
    'canvasTexturePooling',
  ];
  const refreshTexturePreview = () => app.compositeAllLayers({ forceFull: true });
  texturePreviewRefreshIds.forEach(id => {
    const control = document.getElementById(id);
    if (!control) return;
    control.addEventListener('input', refreshTexturePreview);
    control.addEventListener('change', refreshTexturePreview);
  });

  // ── Stamp image upload ──
  const _stampFileInput = document.createElement('input');
  _stampFileInput.type = 'file';
  _stampFileInput.accept = 'image/*';
  _stampFileInput.addEventListener('change', async () => {
    const file = _stampFileInput.files[0];
    if (!file) return;
    await app.loadCustomStampImage(file);
    syncStampImageUI(app);
    _stampFileInput.value = '';
  });
  document.getElementById('btnUploadStampImage')?.addEventListener('click', () => _stampFileInput.click());
  document.getElementById('btnClearStampImage')?.addEventListener('click', () => {
    app.clearCustomStampImage();
    syncStampImageUI(app);
  });
  document.getElementById('stampPresetSwitcher')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-stamp-preset-id]');
    if (!button) return;
    await app.loadBuiltinStampPreset(button.dataset.stampPresetId);
    syncStampImageUI(app);
  });

  // ── Preset buttons ──
  _settingsCatalog = buildSettingsCatalog(sb);
  _favoritesState = loadFavorites();
  _decorateFavoriteControls(app);
  _wireSettingsCatalogSearch(app);
  _renderBuiltinPresets(app);
  _renderUserPresets(app);
  document.getElementById('btnSavePreset')?.addEventListener('click', () => _saveNewPreset(app, 'brush'));
  document.getElementById('btnSaveSimulationPreset')?.addEventListener('click', () => _saveNewPreset(app, 'simulation'));
  document.getElementById('btnImportPreset')?.addEventListener('click', () => _importPreset(app));
  document.getElementById('btnExportPresets')?.addEventListener('click', () => _exportPresets(app));
  document.getElementById('presetLibraryScope')?.addEventListener('change', () => _renderUserPresets(app));
  document.getElementById('presetLibrarySearch')?.addEventListener('input', () => _renderUserPresets(app));
  app._refreshSettingsManagementUi = () => {
    _decorateFavoriteControls(app);
    _renderBuiltinPresets(app);
    _renderUserPresets(app);
    _renderFavorites(app);
    _renderSettingsCatalogResults(app);
  };

  // Sidebar auto-save is wired via delegated listeners in
  // _wireWorkspaceSettingsPanel() so all control types share one debounced
  // timer that is flushed on pagehide.

  document.getElementById('btnOpenSimulationInspector')?.addEventListener('click', () => {
    if (!app.simulation.enabled) app._toggleSimulationMode(true);
    app.simulation.inspectorCollapsed = false;
    app._syncSimulationUI?.();
  });
  document.getElementById('simSidebarSessionSelect')?.addEventListener('change', event => {
    const nextIndex = Number(event.target.value);
    if (!Number.isFinite(nextIndex)) return;
    app._syncActiveSimulationSessionFromDraft?.();
    app._setActiveSimulationSessionIndex?.(nextIndex);
  });
  document.getElementById('simSidebarNewDraft')?.addEventListener('click', () => {
    app._newSimulationSession?.();
  });
  document.getElementById('simSidebarSave')?.addEventListener('click', () => {
    app._saveSimulationSession?.();
  });
  document.getElementById('btnOpenSimulationSetup')?.addEventListener('click', event => {
    app._showSimulationSetupExplorer?.(event.currentTarget);
  });
  document.getElementById('btnBoidColorDist')?.addEventListener('click', () => {
    app._openBoidColorDistModal?.();
  });
  const syncSimulationDraftFromSidebar = () => app._syncSimulationSessionDraftUi?.();
  sb.querySelectorAll('input[type="range"], input[type="checkbox"], select, input[type="number"], input[type="text"]').forEach(el => {
    el.addEventListener('input', syncSimulationDraftFromSidebar);
    el.addEventListener('change', syncSimulationDraftFromSidebar);
  });
  app._refreshSensingLayerSourceUi?.();
  app._syncSimulationSessionContextUi?.();

  // Initial brush-specific visibility
  app._toggleBrushSections(app.activeBrush);
  app._syncMotionPathUI?.();

  // ── Ant Math overlay panel ──
  _buildAntMathPanel(app);
}

function _workspaceSettingsMarkup() {
  return `
    <div class="section-header" data-section="appSettings">Settings <span class="chevron">▼</span></div>
    <div class="section-body">
      <label>Always show tabs <input type="checkbox" id="alwaysShowTabs" checked></label>
      <label>Auto-save session <input type="checkbox" id="autoSaveSession"></label>
      <label>Perf telemetry <input type="checkbox" id="perfTelemetryEnabled"></label>
      <label>Request wake lock <input type="checkbox" id="perfWakeLockEnabled"></label>
      <div id="perfTelemetryReadout" style="white-space:pre-wrap;line-height:1.35;font-size:9px;color:rgba(230,236,248,0.92);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px;min-height:92px;">Telemetry is off.</div>
      <span class="slider-desc">Tracks frame timing, slow-frame attribution, long tasks, tab visibility/focus changes, and optional wake-lock state. Wake lock can reduce device sleep, but browsers may still throttle hidden tabs.</span>
      <div style="display:flex;gap:3px;margin:2px 0 4px;">
        <button id="btnCopyPerfTelemetry">📋 Copy Perf</button>
        <button id="btnResetPerfTelemetry">♻ Reset Perf</button>
      </div>
      <div style="display:flex;gap:3px;margin:2px 0 4px;">
        <button id="btnImportWorkspace">📂 Open Workspace File</button>
        <button id="btnExportWorkspace">💾 Save Workspace File</button>
      </div>
      <div style="display:flex;gap:3px;margin:2px 0 4px;">
        <button id="btnEditWorkspaceJson">📝 Open Workspace JSON Tab</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;margin:4px 0;">
        <button id="btnSaveSession" class="save-btn">💾 Save Session</button>
        <button id="btnResetDefaults" class="reset-btn">🧼 Fresh Start</button>
      </div>
    </div>
    <div class="section-header" data-section="stylusPressureCurves">Stylus Pressure Curves <span class="chevron">▼</span></div>
    <div class="section-body">
      <div class="pressure-curve-intro">Apple Pencil and stylus response. Drag points to reshape a smooth spline, tap empty space to add a point, or double-tap an inner point to remove it. Existing pressure toggles still enable or disable each response.</div>
      ${_pressureCurveMarkup()}
    </div>
    <div class="section-header" data-section="simulationSettings">Simulation <span class="chevron">▼</span></div>
    <div class="section-body">
      <label>Show Selected Overlay <input type="checkbox" id="showSimulationSelectionOverlay"></label>
      <span class="slider-desc">Show or hide the draggable spawn/guide format bar that appears when a simulation item is selected.</span>
    </div>
  `;
}

function _wireWorkspaceSettingsPanel(app, panel) {
  panel.querySelectorAll('.section-header').forEach(h => {
    h.addEventListener('click', () => toggleSection(h));
  });
  _wirePressureCurveEditors(app, panel);

  const workspaceImportInput = document.createElement('input');
  workspaceImportInput.type = 'file';
  workspaceImportInput.accept = '.json,application/json';
  workspaceImportInput.addEventListener('change', async () => {
    const file = workspaceImportInput.files?.[0];
    workspaceImportInput.value = '';
    if (!file) return;
    try {
      await app.importWorkspaceSettingsText(await file.text());
      refreshWorkspaceSettingsUi(app);
      app.showToast(`📂 Loaded workspace file ${file.name}`);
    } catch (error) {
      console.error('Workspace file import failed:', error);
      app.showToast('⚠ Invalid workspace file');
    }
  });

  document.getElementById('btnSaveSession')?.addEventListener('click', () => {
    app.saveSession();
    app.showToast('💾 Session saved');
  });
  document.getElementById('btnImportWorkspace')?.addEventListener('click', () => {
    if (!confirm('Open a workspace file and replace the current canvas, layers, brush settings, and simulation state?')) return;
    workspaceImportInput.click();
  });
  document.getElementById('btnExportWorkspace')?.addEventListener('click', () => {
    app.exportWorkspaceSettingsFile();
  });
  document.getElementById('btnEditWorkspaceJson')?.addEventListener('click', () => {
    app._showWorkspaceJsonModal?.();
  });
  document.getElementById('perfTelemetryEnabled')?.addEventListener('change', event => {
    app.setPerformanceTelemetryEnabled(event.target.checked);
  });
  document.getElementById('perfWakeLockEnabled')?.addEventListener('change', event => {
    app.setPerformanceWakeLockEnabled(event.target.checked);
  });
  document.getElementById('btnCopyPerfTelemetry')?.addEventListener('click', () => {
    app.copyPerformanceTelemetrySnapshot();
  });
  document.getElementById('btnResetPerfTelemetry')?.addEventListener('click', () => {
    app.resetPerformanceTelemetry();
  });
  document.getElementById('btnResetDefaults')?.addEventListener('click', async () => {
    if (confirm('Delete all saved app data, presets, and settings, then reload fresh?')) {
      await app.reloadAppWithCacheBust({ wipeSession: true });
    }
  });
  document.getElementById('showSimulationSelectionOverlay')?.addEventListener('change', () => {
    app._closeSimulationFormatMenuPopover?.({ rerender: false });
    app._renderSimulationInspector?.();
  });

  const autoSaveCb = document.getElementById('autoSaveSession');
  if (autoSaveCb) {
    autoSaveCb.checked = localStorage.getItem(AUTOSAVE_STORAGE_KEY) === '1';
    autoSaveCb.addEventListener('change', () => {
      localStorage.setItem(AUTOSAVE_STORAGE_KEY, autoSaveCb.checked ? '1' : '0');
      app.showToast(autoSaveCb.checked ? '⏱ Auto-save enabled' : 'Auto-save disabled');
    });
    let autoSaveTimer = null;
    const triggerAutoSave = () => {
      if (!autoSaveCb.checked) return;
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => { autoSaveTimer = null; app.saveSession(); }, AUTOSAVE_DEBOUNCE_MS);
    };
    panel.querySelectorAll('input[type="range"], input[type="checkbox"], input[type="text"], select').forEach(el => {
      el.addEventListener('input', triggerAutoSave);
      el.addEventListener('change', triggerAutoSave);
    });
    // Sidebar control edits are only persisted when another action (stroke,
    // sim edit, explicit save) fires saveSession — with auto-save enabled,
    // debounce-save them here too. Delegated so it survives rebuilds.
    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl) {
      const onSidebarEdit = event => {
        const t = event.target;
        if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT')) triggerAutoSave();
      };
      sidebarEl.addEventListener('input', onSidebarEdit);
      sidebarEl.addEventListener('change', onSidebarEdit);
    }
    // Flush any pending debounced auto-save before the page goes away so the
    // last edits aren't lost to the debounce window. Guarded so a panel
    // rebuild can't accumulate duplicate window listeners.
    if (!app._autoSavePagehideFlushWired) {
      app._autoSavePagehideFlushWired = true;
      window.addEventListener('pagehide', () => {
        if (!autoSaveCb.checked || autoSaveTimer == null) return;
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        app.saveSession();
      });
    }
  }

  app._refreshPerformanceTelemetryUI(true);
}

export function buildFavoritesPanel(app) {
  const panel = document.getElementById('favoritesPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="section-header" data-section="favorites">Favorites <span class="chevron">▼</span></div>
    <div class="section-body">
      <div style="font-size:12px;font-weight:700;color:rgba(120,241,220,0.96);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:7px;">Starred Controls</div>
      <div style="display:flex;gap:4px;margin-bottom:7px;">
        <button id="btnImportFavorites" type="button">Import</button>
        <button id="btnExportFavorites" type="button">Export</button>
      </div>
      <div id="favoriteControlList"></div>
    </div>
  `;
  panel.querySelectorAll('.section-header').forEach(h => {
    h.addEventListener('click', () => toggleSection(h));
  });
  _favoritesState = loadFavorites();
  document.getElementById('btnImportFavorites')?.addEventListener('click', () => _importFavorites(app));
  document.getElementById('btnExportFavorites')?.addEventListener('click', () => {
    _downloadSettingsJson(_favoritesState, `boid-brush-favorites-${new Date().toISOString().slice(0, 10)}.json`);
    app.showToast('Favorites exported');
  });
  _renderFavorites(app);
}

export function buildSettingsPanel(app) {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;
  panel.innerHTML = _workspaceSettingsMarkup();
  _wireWorkspaceSettingsPanel(app, panel);
}

export function buildSimulationControlsPanel(app) {
  const panel = document.getElementById('simulationControlsPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="sim-card">
      <div class="sim-hud-header">
        <div class="sim-label">Simulation</div>
        <div id="simTreeSessionMeta" class="sim-tree-sessionMeta"></div>
      </div>
      <div class="sim-hud-body">
        <div class="sim-row sim-stack" id="simDrawerToolRow">
          <button class="sim-pill" data-sim-tool="select">Select</button>
          <button class="sim-pill" id="simDrawerDuplicateBtn" type="button" disabled>Duplicate</button>
          <button class="sim-pill" id="simDrawerCopyBtn" type="button" disabled>Copy</button>
          <button class="sim-pill" id="simDrawerCutBtn" type="button" disabled>Cut</button>
          <button class="sim-pill" id="simDrawerPasteBtn" type="button" disabled>Paste</button>
          <div class="sim-inspector-divider" aria-hidden="true"></div>
          <button class="sim-pill active" data-sim-tool="spawn">Spawn</button>
          <button class="sim-pill" data-sim-tool="spawnBlob">Spawn Blob</button>
          <button class="sim-pill" data-sim-tool="attract">Attract</button>
          <button class="sim-pill" data-sim-tool="repel">Repel</button>
          <button class="sim-pill" data-sim-tool="path">Path</button>
          <button class="sim-pill" data-sim-tool="edge">Edge</button>
          <button class="sim-pill" data-sim-tool="pheromone">Pheromone</button>
          <button class="sim-pill active" id="simDrawerGuidesToggle">Hide Guides</button>
          <button class="sim-pill" id="simDrawerHeatmapToggle" aria-pressed="false">Heatmap</button>
          <button class="sim-pill warn" id="simDrawerCanvasClearBtn">Clear Canvas</button>
          <button class="sim-pill warn" id="simDrawerClearBtn">Clear</button>
        </div>
        <div class="sim-row sim-stack">
          <button class="sim-pill" id="simDrawerRunBtn" type="button">▶ Run</button>
          <button class="sim-pill warn" id="simDrawerStopBtn" type="button">⏹ Stop</button>
          <button class="sim-pill" id="simDrawerStepBackBtn" type="button">Step Path -</button>
          <button class="sim-pill" id="simDrawerStepForwardBtn" type="button">Step Path +</button>
          <button class="sim-pill active" id="simDrawerInspectorToggle">Settings</button>
        </div>
        <div id="simTreePanel" class="sim-tree-panel"></div>
        <div id="simForceVizPanel" class="sim-tree-panel" style="display:none;"></div>
      </div>
    </div>
  `;

  const treePanel = panel.querySelector('#simTreePanel');
  const sessionMeta = panel.querySelector('#simTreeSessionMeta');
  const currentBrush = () => app._getSimulationContextBrush?.() || app.activeBrush;
  const currentVars = () => app._getSimulationVars?.() || app.simulation?.vars || {};
  const activeSessionIndex = () => Number.isFinite(app.simulation?.activeSessionIndex) ? Math.round(app.simulation.activeSessionIndex) : -1;
  const selectedEntry = () => app._getSelectedSimulationEntry?.() || null;

  const fmt = value => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '—';
  const chip = (label, value) => value == null || value === '—' ? '' : `<span class="sim-tree-chip"><span class="sim-tree-chip-label">${escapeHtml(label)}</span> ${escapeHtml(value)}</span>`;
  const chipRow = items => {
    const filtered = items.filter(Boolean).join('');
    return filtered ? `<div class="sim-tree-chipRow">${filtered}</div>` : '';
  };

  const spawnMeta = item => {
    const meta = [];
    if (item.mask) meta.push('Blob');
    else if (item.shape) meta.push(item.shape);
    if (Number.isFinite(item.count)) meta.push(`Count ${Math.round(item.count)}`);
    if (Number.isFinite(item.stampSize)) meta.push(`Size ${Math.round(item.stampSize)}`);
    if (Number.isFinite(item.opacity)) meta.push(`Opacity ${Math.round((item.opacity <= 1 ? item.opacity * 100 : item.opacity))}%`);
    return meta.slice(0, 3).join(' · ');
  };

  const pointMeta = item => {
    const meta = [item.type === 'repel' ? 'Repel' : 'Attract'];
    if (Number.isFinite(item.radius)) meta.push(`Radius ${Math.round(item.radius)}px`);
    if (Number.isFinite(item.strength)) meta.push(`Force ${fmt(item.strength)}`);
    return meta.join(' · ');
  };

  const pathMeta = item => {
    const meta = [item.closed ? 'Closed' : 'Open'];
    if (Array.isArray(item.points)) meta.push(`${item.points.length} pts`);
    if (Number.isFinite(item.radius)) meta.push(`Radius ${Math.round(item.radius)}px`);
    if (Number.isFinite(item.strength)) meta.push(`Force ${fmt(item.strength)}`);
    return meta.join(' · ');
  };

  const edgeMeta = item => {
    const meta = [];
    if (Array.isArray(item.points)) meta.push(`${item.points.length} pts`);
    if (Number.isFinite(item.radius)) meta.push(`Radius ${Math.round(item.radius)}px`);
    if (Number.isFinite(item.strength)) meta.push(`Force ${fmt(item.strength)}`);
    return meta.join(' · ');
  };

  const pheromoneMeta = item => {
    const meta = [];
    if (Array.isArray(item.points)) meta.push(`${item.points.length} pts`);
    if (Number.isFinite(item.radius)) meta.push(`Radius ${Math.round(item.radius)}px`);
    if (Number.isFinite(item.intensity)) meta.push(`Intensity ${fmt(item.intensity)}`);
    return meta.join(' · ');
  };

  const itemButton = ({ icon, title, meta, chips, active, disabled, attrs = '' }) => `
    <button type="button" class="sim-tree-node${active ? ' active' : ''}${disabled ? ' disabled' : ''}" ${attrs}>
      <span class="sim-tree-node-icon">${escapeHtml(icon)}</span>
      <span class="sim-tree-node-main">
        <span class="sim-tree-node-title">${escapeHtml(title)}</span>
        <span class="sim-tree-node-meta">${escapeHtml(meta || 'No details')}</span>
        ${chips ? `<span class="sim-tree-chipRow">${chips}</span>` : ''}
      </span>
      ${disabled ? '<span class="sim-stage-badge muted">Off</span>' : ''}
    </button>`;

  const renderGroup = ({ title, items, collection, kind, sessionIndex, iconFor, metaFor, chipFor }) => {
    if (!items.length) {
      return `<div class="sim-tree-group"><div class="sim-tree-groupHeader"><span class="sim-tree-groupTitle">${escapeHtml(title)}</span><span class="sim-stage-badge muted">0</span></div><div class="sim-tree-empty">No ${escapeHtml(title.toLowerCase())} yet.</div></div>`;
    }
    const selected = selectedEntry();
    return `
      <div class="sim-tree-group">
        <div class="sim-tree-groupHeader">
          <span class="sim-tree-groupTitle">${escapeHtml(title)}</span>
          <span class="sim-stage-badge muted">${items.length}</span>
        </div>
        <div class="sim-tree-list">
          ${items.map((item, index) => itemButton({
            icon: iconFor(item, index),
            title: `${title.replace(/s$/, '')} ${index + 1}`,
            meta: metaFor(item, index),
            chips: chipFor(item, index),
            active: !!selected && selected.collection === collection && selected.kind === kind && selected.id === item.id,
            disabled: item.enabled === false,
            attrs: `data-sim-tree-select="1" data-sim-tree-session-index="${sessionIndex}" data-sim-tree-collection="${collection}" data-sim-tree-kind="${kind}" data-sim-tree-id="${item.id}"`,
          })).join('')}
        </div>
      </div>`;
  };

  const renderSession = (session, sessionIndex, isDraft = false) => {
    const brush = currentBrush();
    const liveSessionIndex = activeSessionIndex();
    const data = isDraft || sessionIndex === liveSessionIndex
      ? (app._getSimulationBrushData?.(brush) || null)
      : (session?.brushData?.[brush] || null);
    const spawns = Array.isArray(data?.spawns) ? data.spawns : [];
    const points = Array.isArray(data?.points) ? data.points : [];
    const attractPoints = points.filter(point => point?.type !== 'repel');
    const repelPoints = points.filter(point => point?.type === 'repel');
    const paths = brush !== 'ant' ? (Array.isArray(data?.paths) ? data.paths : []) : [];
    const edges = brush === 'ant' ? (Array.isArray(data?.edges) ? data.edges : []) : [];
    const pheromonePaths = brush === 'ant' ? (Array.isArray(data?.pheromonePaths) ? data.pheromonePaths : []) : [];
    const isActive = isDraft ? activeSessionIndex() < 0 : activeSessionIndex() === sessionIndex;
    const title = isDraft ? 'Unsaved Draft' : (session?.name || `Session ${sessionIndex + 1}`);
    const meta = [
      `${spawns.length} spawn${spawns.length === 1 ? '' : 's'}`,
      `${points.length} point${points.length === 1 ? '' : 's'}`,
      brush !== 'ant' ? `${paths.length} path${paths.length === 1 ? '' : 's'}` : `${edges.length} edge${edges.length === 1 ? '' : 's'}`,
    ].join(' · ');
    const vars = isDraft || sessionIndex === liveSessionIndex ? currentVars() : (session?.vars || {});
    const sessionChips = chipRow([
      chip('Seek', Number.isFinite(vars.seek) ? fmt(vars.seek) : null),
      chip('Max', Number.isFinite(vars.maxSpeed) ? fmt(vars.maxSpeed) : null),
      chip('Sense', typeof vars.sensingEnabled === 'boolean' ? (vars.sensingEnabled ? 'On' : 'Off') : null),
    ]);
    return `
      <details class="sim-tree-session"${isActive || isDraft ? ' open' : ''}>
        <summary class="sim-tree-sessionSummary${isActive ? ' active' : ''}" data-sim-tree-session="${sessionIndex}" data-sim-tree-draft="${isDraft ? '1' : '0'}">
          <span class="sim-tree-sessionSummaryMain">
            <span class="sim-tree-sessionTitle">${escapeHtml(title)}</span>
            <span class="sim-tree-sessionMeta">${escapeHtml(meta)}${isDraft ? ' · current edits' : ''}</span>
            ${sessionChips}
          </span>
          <span class="sim-tree-sessionSummaryActions"><span class="sim-stage-badge ${isActive ? 'active' : 'muted'}">${isDraft ? 'Draft' : (isActive ? 'Active' : 'Saved')}</span></span>
        </summary>
        <div class="sim-tree-sessionBody">
          ${renderGroup({
            title: 'Spawns',
            items: spawns,
            collection: 'spawns',
            kind: 'spawn',
            sessionIndex,
            iconFor: item => item.mask ? '◉' : '◎',
            metaFor: item => spawnMeta(item),
            chipFor: item => chipRow([
              chip('Count', Number.isFinite(item.count) ? Math.round(item.count) : null),
              chip('Size', Number.isFinite(item.stampSize) ? Math.round(item.stampSize) : null),
              chip('Opacity', Number.isFinite(item.opacity) ? `${Math.round((item.opacity <= 1 ? item.opacity * 100 : item.opacity))}%` : null),
            ]),
          })}
          ${renderGroup({
            title: 'Attract Points',
            items: attractPoints,
            collection: 'points',
            kind: 'point',
            sessionIndex,
            iconFor: () => '↗',
            metaFor: item => pointMeta(item),
            chipFor: item => chipRow([
              chip('Force', Number.isFinite(item.strength) ? fmt(item.strength) : null),
              chip('Radius', Number.isFinite(item.radius) ? `${Math.round(item.radius)}px` : null),
            ]),
          })}
          ${renderGroup({
            title: 'Repel Points',
            items: repelPoints,
            collection: 'points',
            kind: 'point',
            sessionIndex,
            iconFor: () => '↘',
            metaFor: item => pointMeta(item),
            chipFor: item => chipRow([
              chip('Force', Number.isFinite(item.strength) ? fmt(item.strength) : null),
              chip('Radius', Number.isFinite(item.radius) ? `${Math.round(item.radius)}px` : null),
              chip('Hard', Number.isFinite(item.hardness) ? fmt(item.hardness) : null),
            ]),
          })}
          ${brush !== 'ant' ? renderGroup({
            title: 'Paths',
            items: paths,
            collection: 'paths',
            kind: 'path',
            sessionIndex,
            iconFor: item => item.primitiveKind ? '⬡' : '≈',
            metaFor: item => pathMeta(item),
            chipFor: item => chipRow([
              chip('Strength', Number.isFinite(item.strength) ? fmt(item.strength) : null),
              chip('Radius', Number.isFinite(item.radius) ? `${Math.round(item.radius)}px` : null),
            ]),
          }) : ''}
          ${brush === 'ant' ? renderGroup({
            title: 'Edges',
            items: edges,
            collection: 'edges',
            kind: 'edge',
            sessionIndex,
            iconFor: () => '⛶',
            metaFor: item => edgeMeta(item),
            chipFor: item => chipRow([
              chip('Force', Number.isFinite(item.strength) ? fmt(item.strength) : null),
              chip('Radius', Number.isFinite(item.radius) ? `${Math.round(item.radius)}px` : null),
            ]),
          }) : ''}
          ${brush === 'ant' ? renderGroup({
            title: 'Pheromones',
            items: pheromonePaths,
            collection: 'pheromonePaths',
            kind: 'pheromonePath',
            sessionIndex,
            iconFor: () => '∿',
            metaFor: item => pheromoneMeta(item),
            chipFor: item => chipRow([
              chip('Radius', Number.isFinite(item.radius) ? `${Math.round(item.radius)}px` : null),
              chip('Intensity', Number.isFinite(item.intensity) ? fmt(item.intensity) : null),
            ]),
          }) : ''}
        </div>
      </details>`;
  };

  const renderTree = () => {
    if (!treePanel) return;
    const brush = currentBrush();
    const vars = currentVars();
    const sessions = Array.isArray(app.simulation?.sessions) ? app.simulation.sessions : [];
    const currentName = app._getSimulationSessionContextSummary?.()?.name || 'Unsaved Draft';
    if (sessionMeta) sessionMeta.textContent = `${currentName} · ${brush}`;
    const globalChips = chipRow([
      chip('Seek', Number.isFinite(vars.seek) ? fmt(vars.seek) : null),
      chip('Cohesion', Number.isFinite(vars.cohesion) ? fmt(vars.cohesion) : null),
      chip('Separation', Number.isFinite(vars.separation) ? fmt(vars.separation) : null),
      chip('Max', Number.isFinite(vars.maxSpeed) ? fmt(vars.maxSpeed) : null),
      chip('Damping', Number.isFinite(vars.damping) ? fmt(vars.damping) : null),
    ]);
    const entries = [];
    if (activeSessionIndex() < 0) entries.push(renderSession(null, -1, true));
    sessions.forEach((session, index) => entries.push(renderSession(session, index, false)));
    treePanel.innerHTML = `
      <div class="sim-tree-root">
        <div class="sim-tree-global" data-sim-tree-global="1">
          <div class="sim-tree-groupHeader">
            <span class="sim-tree-groupTitle">Global</span>
            <span class="sim-stage-badge ${selectedEntry() ? 'muted' : 'active'}">${selectedEntry() ? 'Context' : 'Selected'}</span>
          </div>
          <div class="sim-tree-globalBody">
            <div class="sim-tree-empty">Current simulation defaults for the active brush.</div>
            ${globalChips}
          </div>
        </div>
        <div class="sim-tree-sessionsWrap">
          <div class="sim-tree-groupHeader">
            <span class="sim-tree-groupTitle">Sessions</span>
            <span class="sim-stage-badge muted">${entries.length}</span>
          </div>
          <div class="sim-tree-list">${entries.join('') || '<div class="sim-tree-empty">No simulation sessions yet.</div>'}</div>
        </div>
      </div>`;

    treePanel.querySelectorAll('[data-sim-tree-session]').forEach(summary => {
      summary.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (summary.dataset.simTreeDraft === '1') {
          app._setSimulationSelection?.(null);
          return;
        }
        const index = Number(summary.dataset.simTreeSession);
        if (Number.isFinite(index) && index >= 0) {
          app._setActiveSimulationSessionIndex?.(index);
          app._setSimulationSelection?.(null);
        }
      });
    });

    treePanel.querySelectorAll('[data-sim-tree-select]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const index = Number(button.dataset.simTreeSessionIndex);
        if (Number.isFinite(index) && index >= 0 && index !== activeSessionIndex()) {
          app._setActiveSimulationSessionIndex?.(index);
        }
        app._setSimulationSelection?.({
          collection: button.dataset.simTreeCollection,
          kind: button.dataset.simTreeKind,
          id: Number(button.dataset.simTreeId),
        }, { focusDrawer: true });
      });
    });

    treePanel.querySelectorAll('[data-sim-tree-global]').forEach(button => {
      button.addEventListener('click', () => app._setSimulationSelection?.(null));
    });
  };

  app._renderSimulationTreePanel = renderTree;
  renderTree();

  // ── Force Visualization submode panel ───────────────────────────────────
  // Renders inside the same simulationControlsPanel shell as the tree panel,
  // gated to visible only while simulation.mode === 'forceVisualization'.
  // Every control here maps 1:1 to app.js force-viz state mutators — no
  // control re-implements boid physics, it only edits routing/camera config.
  const fvPanel = panel.querySelector('#simForceVizPanel');
  const fvOption = (value, label, selected) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

  const renderForceViz = () => {
    if (!fvPanel) return;
    const sim = app.simulation;
    const isForceViz = sim?.mode === 'forceVisualization';
    fvPanel.style.display = isForceViz ? '' : 'none';
    if (!isForceViz) return;
    const scenario = app._getActiveForceVizScenario?.();
    if (!scenario) { fvPanel.innerHTML = ''; return; }
    const fv = sim.forceViz;
    const activeGroup = scenario.groups.find(g => g.id === fv.ui.activeGroupId) || scenario.groups[0];
    const activeAttractor = scenario.attractors.find(a => a.id === fv.ui.activeAttractorId) || scenario.attractors[0];
    const cam = fv.camera;
    const spawns = app._getForceVizSpawnOptions?.() || [];
    const paths = app._getForceVizPathOptions?.() || [];
    const layers = app._getSimulationTargetLayers?.() || [];

    const groupOptions = scenario.groups.map((g, i) => fvOption(g.id, g.name || `Group ${i + 1}`, g.id === activeGroup?.id)).join('');
    const attractorOptions = scenario.attractors.map((a, i) => fvOption(a.id, a.name || `Attractor ${i + 1}`, a.id === activeAttractor?.id)).join('');
    const spawnOptions = ['<option value="">— Unbound —</option>', ...spawns.map((s, i) => fvOption(String(s.id), `Spawn ${i + 1}${s.enabled === false ? ' (disabled)' : ''}`, String(activeGroup?.spawnId) === String(s.id)))].join('');
    const layerOptions = ['<option value="">— Active layer —</option>', ...layers.map(l => fvOption(l.id, l.name || 'Layer', activeGroup?.layerId === l.id))].join('');
    const pathOptions = ['<option value="">— No path —</option>', ...paths.map((pth, i) => fvOption(String(pth.id), `Path ${i + 1}`, String(activeAttractor?.movement?.pathId) === String(pth.id)))].join('');
    const otherAttractors = scenario.attractors.filter(a => a.id !== activeAttractor?.id);
    const sharedOptions = otherAttractors.map(a => fvOption(a.id, a.name, activeAttractor?.sharedAttractorId === a.id)).join('');

    const routeRows = scenario.routes.map(route => {
      const routeGroupOptions = scenario.groups.map(g => fvOption(g.id, g.name, g.id === route.groupId)).join('');
      const routeAttractorOptions = scenario.attractors.map(a => fvOption(a.id, a.name, a.id === route.attractorId)).join('');
      return `
        <div class="sim-tree-node" style="flex-direction:column;align-items:stretch;gap:4px;" data-fv-route-row="${route.id}">
          <div class="sim-row" style="gap:4px;">
            <select data-fv-route-group="${route.id}" style="flex:1;min-width:0;">${routeGroupOptions}</select>
            <span style="color:#7d8594;">→</span>
            <select data-fv-route-attractor="${route.id}" style="flex:1;min-width:0;">${routeAttractorOptions}</select>
          </div>
          <label style="margin:0;">Weight <span id="v_fvRouteWeight_${route.id}">${(route.weight ?? 1).toFixed(2)}</span>
            <input type="range" id="fvRouteWeight_${route.id}" min="0" max="300" value="${Math.round(Math.max(0, Math.min(3, route.weight ?? 1)) * 100)}" data-fv-route-weight="${route.id}">
          </label>
          <div class="sim-row" style="justify-content:space-between;">
            <label style="margin:0;display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" data-fv-route-enabled="${route.id}" ${route.enabled !== false ? 'checked' : ''}> Enabled</label>
            <button type="button" class="sim-pill warn" data-fv-route-remove="${route.id}" ${scenario.routes.length <= 1 ? 'disabled' : ''}>Remove</button>
          </div>
        </div>`;
    }).join('');

    const cameraPolicy = cam.policy;
    const showFor = (...policies) => policies.includes(cameraPolicy) ? '' : 'display:none;';

    fvPanel.innerHTML = `
      <div class="sim-tree-group">
        <div class="sim-row" style="justify-content:flex-end;margin:0 0 6px;">
          <button type="button" class="sim-pill" id="fvHelpBtn">How to start this mode</button>
        </div>
        <div class="sim-tree-groupHeader"><span class="sim-tree-groupTitle">Group</span></div>
        <div class="sim-row" style="gap:6px;">
          <select id="fvGroupSelect" style="flex:1;min-width:0;">${groupOptions}</select>
          <button type="button" class="sim-pill" id="fvGroupAdd">+ Group</button>
          <button type="button" class="sim-pill warn" id="fvGroupRemove" ${scenario.groups.length <= 1 ? 'disabled' : ''}>Remove</button>
        </div>
        <label>Bound Spawn<select id="fvGroupSpawn">${spawnOptions}</select></label>
        <span class="slider-desc">Groups reference an existing spawn definition — no separate spawn config is created here.</span>
        <label>Paint Layer<select id="fvGroupLayer">${layerOptions}</select></label>
      </div>

      <div class="sim-tree-group">
        <div class="sim-tree-groupHeader"><span class="sim-tree-groupTitle">Attractor</span></div>
        <div class="sim-row" style="gap:6px;">
          <select id="fvAttractorSelect" style="flex:1;min-width:0;">${attractorOptions}</select>
          <button type="button" class="sim-pill" id="fvAttractorAdd">+ Attractor</button>
          <button type="button" class="sim-pill warn" id="fvAttractorRemove" ${scenario.attractors.length <= 1 ? 'disabled' : ''}>Remove</button>
        </div>
        <label style="display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" id="fvAttractorEnabled" ${activeAttractor.enabled !== false ? 'checked' : ''}> Enabled</label>
        <label>Type<select id="fvAttractorType">
          ${['fixed', 'unreachable', 'moving', 'orbiting', 'path', 'shared'].map(t => fvOption(t, t[0].toUpperCase() + t.slice(1), t === activeAttractor.type)).join('')}
        </select></label>
        <div class="sim-row" style="gap:6px;">
          <label style="flex:1;">X<input type="number" id="fvAttractorX" value="${Math.round(activeAttractor.x)}"></label>
          <label style="flex:1;">Y<input type="number" id="fvAttractorY" value="${Math.round(activeAttractor.y)}"></label>
        </div>
        ${nudgeSliderRow('fvAttractorStrength', 'Strength', 0, 500, Math.round(activeAttractor.strength * 100), v => (v / 100).toFixed(2), 'Pull applied to routed boids, scaled by the route weight')}
        ${nudgeSliderRow('fvAttractorRadius', 'Radius', 1, 800, Math.round(activeAttractor.radius), v => v + 'px', 'Full-strength radius (same falloff as a normal attract guide point)')}
        ${nudgeSliderRow('fvAttractorInfluenceRadius', 'Influence Radius', 1, 1600, Math.round(activeAttractor.influenceRadius), v => v + 'px', 'Outer radius where pull fades to zero')}
        <div data-fv-attractor-type-panel="moving" style="${activeAttractor.type === 'moving' ? '' : 'display:none;'}">
          <div class="sim-row" style="gap:6px;">
            <label style="flex:1;">Vel X<input type="number" id="fvMoveVX" value="${activeAttractor.movement.velocityX}"></label>
            <label style="flex:1;">Vel Y<input type="number" id="fvMoveVY" value="${activeAttractor.movement.velocityY}"></label>
          </div>
        </div>
        <div data-fv-attractor-type-panel="unreachable" style="${activeAttractor.type === 'unreachable' ? '' : 'display:none;'}">
          ${nudgeSliderRow('fvDriftRadius', 'Drift Radius', 0, 400, Math.round(activeAttractor.movement.driftRadius), v => v + 'px', 'How far it drifts from its anchor — never fully caught')}
          ${nudgeSliderRow('fvDriftSpeed', 'Drift Speed', 0, 200, Math.round(activeAttractor.movement.driftSpeed * 100), v => (v / 100).toFixed(2), 'Drift cycle speed (radians/sec)')}
        </div>
        <div data-fv-attractor-type-panel="orbiting" style="${activeAttractor.type === 'orbiting' ? '' : 'display:none;'}">
          <div class="sim-row" style="gap:6px;">
            <label style="flex:1;">Orbit Center X<input type="number" id="fvOrbitCX" value="${Math.round(activeAttractor.movement.orbitCenterX)}"></label>
            <label style="flex:1;">Orbit Center Y<input type="number" id="fvOrbitCY" value="${Math.round(activeAttractor.movement.orbitCenterY)}"></label>
          </div>
          ${nudgeSliderRow('fvOrbitRadius', 'Orbit Radius', 0, 800, Math.round(activeAttractor.movement.orbitRadius), v => v + 'px')}
          ${nudgeSliderRow('fvOrbitSpeed', 'Orbit Speed', -300, 300, Math.round(activeAttractor.movement.orbitSpeed * 100), v => (v / 100).toFixed(2), 'Radians/sec, negative reverses direction')}
        </div>
        <div data-fv-attractor-type-panel="path" style="${activeAttractor.type === 'path' ? '' : 'display:none;'}">
          <label>Guide Path<select id="fvAttractorPath">${pathOptions}</select></label>
          <span class="slider-desc">Reuses the same animated guide path used for path guides.</span>
        </div>
        <div data-fv-attractor-type-panel="shared" style="${activeAttractor.type === 'shared' ? '' : 'display:none;'}">
          <label>Mirrors Attractor<select id="fvAttractorShared">${sharedOptions || '<option value="">— No other attractors —</option>'}</select></label>
          <span class="slider-desc">Position always matches the target attractor — useful for multiple groups converging on one shared target.</span>
        </div>
      </div>

      <div class="sim-tree-group">
        <div class="sim-tree-groupHeader"><span class="sim-tree-groupTitle">Routes</span><span class="sim-stage-badge muted">${scenario.routes.length}</span></div>
        <div class="sim-tree-list">${routeRows}</div>
        <button type="button" class="sim-pill" id="fvRouteAdd">+ Route</button>
      </div>

      <div class="sim-tree-group">
        <div class="sim-tree-groupHeader"><span class="sim-tree-groupTitle">Camera</span></div>
        <label>Policy<select id="fvCameraPolicy">
          ${[
            ['fixed', 'Fixed (manual)'],
            ['followBoid', 'Follow Boid'],
            ['followCentroid', 'Follow Centroid'],
            ['frameGroups', 'Frame Groups'],
            ['orbit', 'Orbit'],
          ].map(([value, label]) => fvOption(value, label, value === cameraPolicy)).join('')}
        </select></label>
        <div style="${showFor('followBoid')}">
          ${nudgeSliderRow('fvCamBoidIndex', 'Boid Sample Index', 0, 63, cam.targetBoidIndex || 0, v => String(v), 'Index into the sampled candidate list, not the raw agent count')}
        </div>
        <div style="${showFor('frameGroups')}">
          ${nudgeSliderRow('fvCamPadding', 'Framing Padding', 0, 400, Math.round(cam.padding), v => v + 'px')}
        </div>
        <div style="${showFor('orbit')}">
          ${nudgeSliderRow('fvCamOrbitSpeed', 'Orbit Speed', -300, 300, Math.round(cam.orbitSpeed * 100), v => (v / 100).toFixed(2), 'Camera rotation speed (radians/sec)')}
        </div>
        ${nudgeSliderRow('fvCamSmoothing', 'Smoothing', 1, 100, Math.round(cam.smoothing * 100), v => (v / 100).toFixed(2), 'Per-frame lerp factor toward the resolved camera target')}
        ${nudgeSliderRow('fvCamLookahead', 'Lookahead', 0, 100, Math.round(cam.lookahead * 100), v => (v / 100).toFixed(2), 'Shifts focus ahead using the tracked average velocity')}
        <div class="sim-row" style="gap:6px;">
          <label style="flex:1;">Offset X<input type="number" id="fvCamOffsetX" value="${Math.round(cam.offsetX)}"></label>
          <label style="flex:1;">Offset Y<input type="number" id="fvCamOffsetY" value="${Math.round(cam.offsetY)}"></label>
        </div>
        <div class="sim-row" style="gap:6px;">
          <label style="flex:1;">Min Zoom<input type="number" step="0.05" id="fvCamMinZoom" value="${cam.minZoom.toFixed(2)}"></label>
          <label style="flex:1;">Max Zoom<input type="number" step="0.05" id="fvCamMaxZoom" value="${cam.maxZoom.toFixed(2)}"></label>
        </div>
        <label>Interruption<select id="fvCamInterruption">
          ${[
            ['holdOnUserInput', 'Hold on user input'],
            ['resumeAfterDelay', 'Resume after delay'],
            ['ignoreUserInput', 'Ignore user input'],
          ].map(([value, label]) => fvOption(value, label, value === cam.interruption)).join('')}
        </select></label>
        <div style="${cam.interruption === 'resumeAfterDelay' ? '' : 'display:none;'}">
          ${nudgeSliderRow('fvCamResumeDelay', 'Resume Delay', 0, 100, Math.round(cam.resumeDelay * 10), v => (v / 10).toFixed(1) + 's')}
        </div>
        <label>On Stop / Exit<select id="fvCamExitBehavior">
          ${[
            ['restoreManualView', 'Restore manual view'],
            ['retainCurrentView', 'Retain current view'],
          ].map(([value, label]) => fvOption(value, label, value === cam.exitBehavior)).join('')}
        </select></label>
      </div>
    `;

    fvPanel.querySelector('#fvHelpBtn')?.addEventListener('click', () => app._openForceVizHelp?.());
    fvPanel.querySelector('#fvGroupSelect')?.addEventListener('change', e => app._setForceVizActiveGroup(e.target.value));
    fvPanel.querySelector('#fvGroupAdd')?.addEventListener('click', () => app._addForceVizGroup());
    fvPanel.querySelector('#fvGroupRemove')?.addEventListener('click', () => app._removeForceVizGroup(activeGroup.id));
    fvPanel.querySelector('#fvGroupSpawn')?.addEventListener('change', e => {
      const spawn = spawns.find(candidate => String(candidate.id) === e.target.value);
      app._updateForceVizGroup(activeGroup.id, { spawnId: spawn?.id ?? null });
    });
    fvPanel.querySelector('#fvGroupLayer')?.addEventListener('change', e => app._updateForceVizGroup(activeGroup.id, { layerId: e.target.value || null }));

    fvPanel.querySelector('#fvAttractorSelect')?.addEventListener('change', e => app._setForceVizActiveAttractor(e.target.value));
    fvPanel.querySelector('#fvAttractorAdd')?.addEventListener('click', () => app._addForceVizAttractor());
    fvPanel.querySelector('#fvAttractorRemove')?.addEventListener('click', () => app._removeForceVizAttractor(activeAttractor.id));
    fvPanel.querySelector('#fvAttractorEnabled')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { enabled: !!e.target.checked }));
    fvPanel.querySelector('#fvAttractorType')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { type: e.target.value }));
    fvPanel.querySelector('#fvAttractorX')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { x: +e.target.value }));
    fvPanel.querySelector('#fvAttractorY')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { y: +e.target.value }));
    fvPanel.querySelector('#fvAttractorStrength')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { strength: +e.target.value / 100 }));
    fvPanel.querySelector('#fvAttractorRadius')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { radius: +e.target.value }));
    fvPanel.querySelector('#fvAttractorInfluenceRadius')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { influenceRadius: +e.target.value }));
    fvPanel.querySelector('#fvMoveVX')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { movement: { velocityX: +e.target.value } }));
    fvPanel.querySelector('#fvMoveVY')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { movement: { velocityY: +e.target.value } }));
    fvPanel.querySelector('#fvDriftRadius')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { movement: { driftRadius: +e.target.value } }));
    fvPanel.querySelector('#fvDriftSpeed')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { movement: { driftSpeed: +e.target.value / 100 } }));
    fvPanel.querySelector('#fvOrbitCX')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { movement: { orbitCenterX: +e.target.value } }));
    fvPanel.querySelector('#fvOrbitCY')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { movement: { orbitCenterY: +e.target.value } }));
    fvPanel.querySelector('#fvOrbitRadius')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { movement: { orbitRadius: +e.target.value } }));
    fvPanel.querySelector('#fvOrbitSpeed')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { movement: { orbitSpeed: +e.target.value / 100 } }));
    fvPanel.querySelector('#fvAttractorPath')?.addEventListener('change', e => {
      const pathItem = paths.find(candidate => String(candidate.id) === e.target.value);
      app._updateForceVizAttractor(activeAttractor.id, { movement: { pathId: pathItem?.id ?? null } });
    });
    fvPanel.querySelector('#fvAttractorShared')?.addEventListener('change', e => app._updateForceVizAttractor(activeAttractor.id, { sharedAttractorId: e.target.value || null }));

    fvPanel.querySelector('#fvRouteAdd')?.addEventListener('click', () => app._addForceVizRoute());
    scenario.routes.forEach(route => {
      fvPanel.querySelector(`[data-fv-route-group="${route.id}"]`)?.addEventListener('change', e => app._updateForceVizRoute(route.id, { groupId: e.target.value }));
      fvPanel.querySelector(`[data-fv-route-attractor="${route.id}"]`)?.addEventListener('change', e => app._updateForceVizRoute(route.id, { attractorId: e.target.value }));
      fvPanel.querySelector(`[data-fv-route-weight="${route.id}"]`)?.addEventListener('change', e => app._updateForceVizRoute(route.id, { weight: +e.target.value / 100 }));
      fvPanel.querySelector(`[data-fv-route-enabled="${route.id}"]`)?.addEventListener('change', e => app._updateForceVizRoute(route.id, { enabled: !!e.target.checked }));
      fvPanel.querySelector(`[data-fv-route-remove="${route.id}"]`)?.addEventListener('click', () => app._removeForceVizRoute(route.id));
    });

    fvPanel.querySelector('#fvCameraPolicy')?.addEventListener('change', e => app._updateForceVizCamera({ policy: e.target.value }));
    fvPanel.querySelector('#fvCamBoidIndex')?.addEventListener('change', e => app._updateForceVizCamera({ targetBoidIndex: +e.target.value }));
    fvPanel.querySelector('#fvCamPadding')?.addEventListener('change', e => app._updateForceVizCamera({ padding: +e.target.value }));
    fvPanel.querySelector('#fvCamOrbitSpeed')?.addEventListener('change', e => app._updateForceVizCamera({ orbitSpeed: +e.target.value / 100 }));
    fvPanel.querySelector('#fvCamSmoothing')?.addEventListener('change', e => app._updateForceVizCamera({ smoothing: +e.target.value / 100 }));
    fvPanel.querySelector('#fvCamLookahead')?.addEventListener('change', e => app._updateForceVizCamera({ lookahead: +e.target.value / 100 }));
    fvPanel.querySelector('#fvCamOffsetX')?.addEventListener('change', e => app._updateForceVizCamera({ offsetX: +e.target.value }));
    fvPanel.querySelector('#fvCamOffsetY')?.addEventListener('change', e => app._updateForceVizCamera({ offsetY: +e.target.value }));
    fvPanel.querySelector('#fvCamMinZoom')?.addEventListener('change', e => app._updateForceVizCamera({ minZoom: +e.target.value }));
    fvPanel.querySelector('#fvCamMaxZoom')?.addEventListener('change', e => app._updateForceVizCamera({ maxZoom: +e.target.value }));
    fvPanel.querySelector('#fvCamInterruption')?.addEventListener('change', e => app._updateForceVizCamera({ interruption: e.target.value }));
    fvPanel.querySelector('#fvCamResumeDelay')?.addEventListener('change', e => app._updateForceVizCamera({ resumeDelay: +e.target.value / 10 }));
    fvPanel.querySelector('#fvCamExitBehavior')?.addEventListener('change', e => app._updateForceVizCamera({ exitBehavior: e.target.value }));

    // Live readout feedback while dragging, without rebuilding the panel
    // mid-drag (which would drop the pointer capture on the range input).
    // The formatted value + full re-render still happens on 'change' above.
    fvPanel.querySelectorAll('input[type="range"]').forEach(inp => {
      const span = fvPanel.querySelector('#v_' + inp.id);
      if (!span) return;
      inp.addEventListener('input', () => { span.textContent = inp.value; });
    });
    // nudgeSliderRow() ships +/- buttons but only buildSidebar() wires them
    // globally for #sidebar; wire the copies rendered in this panel too.
    fvPanel.querySelectorAll('.slider-nudge-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = fvPanel.querySelector('#' + btn.dataset.target);
        _nudgeRangeValue(target, Number(btn.dataset.delta) || 0);
      });
    });
  };
  app._renderForceVizPanel = renderForceViz;
  renderForceViz();

  panel.querySelectorAll('.section-header').forEach(h => {
    h.addEventListener('click', () => toggleSection(h));
  });
}

// ── Build Layers Panel (left panel) ─────────────────────────
export function buildLayersPanel(app) {
  const lp = document.getElementById('layersPanel');
  if (!lp) return;
  lp.innerHTML = `
    <div class="section-header" data-section="layers">Layers <span class="chevron">▼</span></div>
    <div class="section-body">
      <div style="display:flex;gap:3px;flex-wrap:wrap;margin-bottom:6px;">
        <button id="btnAddLayer">+ Add</button>
        <button id="btnDupLayer">⧉ Dup</button>
        <button id="btnDelLayer">✕ Del</button>
        <button id="btnLayerUp">▲</button>
        <button id="btnLayerDown">▼</button>
        <button id="btnMergeDown">Merge▼</button>
        <button id="btnFlatten">Flatten</button>
      </div>
      <div class="blend-row">
        <label>Blend <select id="layerBlend">
          <option value="source-over">Normal</option><option value="multiply">Multiply</option>
          <option value="screen">Screen</option><option value="overlay">Overlay</option>
          <option value="darken">Darken</option><option value="lighten">Lighten</option>
          <option value="add">Add</option>
          <option value="color-dodge">Dodge</option><option value="color-burn">Burn</option>
          <option value="hard-light">Hard Light</option><option value="soft-light">Soft Light</option>
          <option value="difference">Difference</option><option value="exclusion">Exclusion</option>
          <option value="hue">Hue</option><option value="saturation">Saturation</option>
          <option value="color">Color</option><option value="luminosity">Luminosity</option>
        </select></label>
        <label>Opacity <span id="v_layerOpacity">100</span>% <input type="range" id="layerOpacity" min="0" max="100" value="100"></label>
      </div>
      <div id="layerList"></div>
    </div>
    <div class="section-header" data-section="viewBookmarks">View Bookmarks <span class="chevron">▼</span></div>
    <div class="section-body">
      <div class="view-bookmark-toolbar">
        <button id="btnSaveViewBookmark">+ Save View</button>
        <button id="btnJumpLastChange">↩ Last Change</button>
      </div>
      <div id="viewBookmarkLastChange"></div>
      <div id="viewBookmarkList" class="view-bookmark-list"></div>
    </div>
  `;

  // Wire section toggle
  lp.querySelectorAll('.section-header').forEach(h => {
    h.addEventListener('click', () => toggleSection(h));
  });

  // Layer buttons
  document.getElementById('btnAddLayer')?.addEventListener('click', () => { app.addLayer(); _refreshLayers(app); });
  document.getElementById('btnDupLayer')?.addEventListener('click', () => { app.duplicateLayer(); _refreshLayers(app); });
  document.getElementById('btnDelLayer')?.addEventListener('click', () => { app.removeLayer(); _refreshLayers(app); });
  document.getElementById('btnLayerUp')?.addEventListener('click', () => { app.moveLayerUp(); _refreshLayers(app); });
  document.getElementById('btnLayerDown')?.addEventListener('click', () => { app.moveLayerDown(); _refreshLayers(app); });
  document.getElementById('btnMergeDown')?.addEventListener('click', () => { app.mergeDown(); _refreshLayers(app); });
  document.getElementById('btnFlatten')?.addEventListener('click', () => { app.flattenAll(); _refreshLayers(app); });
  document.getElementById('btnSaveViewBookmark')?.addEventListener('click', () => {
    const name = prompt('Bookmark name:', app.getSuggestedViewBookmarkName?.() || 'View 1');
    if (name === null) return;
    app.saveCurrentViewBookmark?.({ name });
  });
  document.getElementById('btnJumpLastChange')?.addEventListener('click', () => {
    app.jumpToLastChange?.();
  });

  // Layer blend & opacity
  document.getElementById('layerBlend')?.addEventListener('change', () => {
    const l = app.getActiveLayer();
    if (l) { l.blend = document.getElementById('layerBlend').value; app.compositeAllLayers(); }
  });
  document.getElementById('layerOpacity')?.addEventListener('input', () => {
    const l = app.getActiveLayer();
    const v = +document.getElementById('layerOpacity').value;
    document.getElementById('v_layerOpacity').textContent = v;
    if (l) { l.opacity = v / 100; app.compositeAllLayers(); }
  });

  // Store layer list renderer on app for external refresh
  app._renderLayerList = () => _renderLayerList(app);
  app._renderViewBookmarksPanel = () => _renderViewBookmarksPanel(app);

  // Initial layer list
  _renderLayerList(app);
  _renderViewBookmarksPanel(app);
}

export function buildGuidesPanel(app) {
  const panel = document.getElementById('guidesPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="section-header" data-section="guides">Guides <span class="chevron">▼</span></div>
    <div class="section-body">
      <div id="guidesPanelEditor" class="sim-guide-editor">
        <div class="sim-guide-panel-summary">Select a guide in simulation mode to edit its per-item overrides here.</div>
        <div class="sim-inspector-note">Spawn, point, path, edge, and pheromone guide settings now live in this left-side drawer instead of the floating overlay.</div>
      </div>
    </div>
  `;

  panel.querySelectorAll('.section-header').forEach(h => {
    h.addEventListener('click', () => toggleSection(h));
  });
}

// ── Ant Math overlay panel ──────────────────────────────────
// Mirrors for controls that already exist in the main sidebar.
// Two new controls (neighborRadius, separationRadius) live only here.
const _AM_MIRRORS = [
  // [panelId, mainId] — panel slider mirrors the main sidebar slider
  ['am_seek', 'seek'],
  ['am_cohesion', 'cohesion'],
  ['am_separation', 'separation'],
  ['am_alignment', 'alignment'],
  ['am_jitter', 'jitter'],
  ['am_wander', 'wander'],
  ['am_wanderSpeed', 'wanderSpeed'],
  ['am_fov', 'fov'],
  ['am_flowField', 'flowField'],
  ['am_flowScale', 'flowScale'],
  ['am_fleeRadius', 'fleeRadius'],
  ['am_maxSpeed', 'maxSpeed'],
  ['am_damping', 'damping'],
  ['am_individuality', 'individuality'],
  ['am_sensingStrength', 'sensingStrength'],
  ['am_sensingRadius', 'sensingRadius'],
  ['am_sensingThreshold', 'sensingThreshold'],
  ['am_antFollow', 'antFollow'],
  ['am_antPheromoneRate', 'antPheromoneRate'],
  ['am_antPheromoneDecay', 'antPheromoneDecay'],
  ['am_antPheromoneSize', 'antPheromoneSize'],
  ['am_speedVar', 'speedVar'],
  ['am_forceVar', 'forceVar'],
];

function _amSlider(id, label, min, max, value, fmt, math) {
  const fmtFn = fmt || (v => v);
  const mathHtml = math ? `<span class="am-math">${math}</span>` : '';
  return `<label>${label} <span id="v_${id}">${fmtFn(value)}</span><input type="range" id="${id}" min="${min}" max="${max}" value="${value}"></label>${mathHtml}`;
}

/**
 * Build the "Ant Math Variables" overlay panel.
 *
 * The panel overlays the sidebar (position:fixed, z-index 11) and contains
 * sliders for every mathematical variable in the ant motion model, grouped
 * by equation role (seek, flock, flow, integration, pheromone, sensing).
 *
 * Most sliders are *mirrors* of existing sidebar controls (_AM_MIRRORS):
 * changing a mirror slider syncs the value back to the main sidebar input
 * and fires its 'input' event so getP() picks up the change.
 *
 * Two sliders are panel-only (no sidebar counterpart):
 *   - am_neighborRadius  → getP().neighborRadius  (was hardcoded 80)
 *   - am_separationRadius → getP().separationRadius (was hardcoded 25)
 */
function _buildAntMathPanel(app) {
  const panel = document.getElementById('antMathPanel');
  if (!panel) return;

  panel.innerHTML = `
    <button class="am-back-btn" id="amBackBtn">← Back</button>
    <div class="am-title">🐜 Ant Motion — Math Variables</div>

    <div class="am-section">Cursor Follow (Seek)</div>
    ${_amSlider('am_antFollow', 'w_follow', 0, 100, 40, v => (v/100).toFixed(2), 'F_seek = ((d̂ · v_max) − v) · w_follow')}
    ${_amSlider('am_seek', 'w_seek', 0, 100, 75, v => (v/100).toFixed(2), 'Base seek weight (ant uses w_follow instead via _buildAntParams)')}

    <div class="am-section">Exploration Forces</div>
    ${_amSlider('am_jitter', 'w_jitter', 0, 100, 0, v => (v/100).toFixed(2), 'F_jitter = (ξ − 0.5) · 2 · w_j · v_max')}
    ${_amSlider('am_wander', 'w_wander', 0, 100, 0, v => (v/100).toFixed(2), 'θ += (ξ − 0.5) · 2 · s_w; F = w_w · v_max · (cosθ, sinθ)')}
    ${_amSlider('am_wanderSpeed', 's_wander', 1, 100, 30, v => (v/100).toFixed(2), 'Angular step size for Brownian wander walk')}

    <div class="am-section">Flock Forces</div>
    ${_amSlider('am_cohesion', 'w_coh', 0, 100, 15, v => (v/100).toFixed(2), 'F_coh = seek(centroid_of_neighbors) · w_c')}
    ${_amSlider('am_separation', 'w_sep', 0, 100, 15, v => (v/100).toFixed(2), 'F_sep = Σ −d̂_ij · w_s (for ‖d‖ < R_sep)')}
    ${_amSlider('am_alignment', 'w_align', 0, 100, 20, v => (v/100).toFixed(2), 'F_align = (avg_neighbor_v − v_i) · w_a')}
    ${_amSlider('am_neighborRadius', 'R_neighbor', 10, 200, 80, null, 'Radius for cohesion/alignment neighbor scan')}
    ${_amSlider('am_separationRadius', 'R_sep', 5, 100, 25, null, 'Radius for separation repulsion')}
    ${_amSlider('am_fov', 'θ_fov', 30, 360, 115, v => v + '°', 'Field of view angle for neighbor detection')}

    <div class="am-section">Flow Field</div>
    ${_amSlider('am_flowField', 'w_flow', 0, 100, 0, v => (v/100).toFixed(2), 'α = N(p·σ) · 2π; F = w_f · v_max · (cosα, sinα)')}
    ${_amSlider('am_flowScale', 'σ_flow', 1, 100, 10, v => (v/1000).toFixed(3), 'Spatial scale of simplex noise field')}

    <div class="am-section">Integration</div>
    ${_amSlider('am_maxSpeed', 'v_max', 1, 30, 8, v => (v/2).toFixed(1), 'v += a; if ‖v‖ > v_max: v = v̂ · v_max')}
    ${_amSlider('am_damping', 'δ (damping)', 80, 100, 95, v => (v/100).toFixed(2), 'v *= δ; p += v (Euler integration)')}
    ${_amSlider('am_fleeRadius', 'R_flee', 0, 150, 0, null, 'F_flee = d̂ · v_max · 0.8 · (1 − d/R) if d < R')}

    <div class="am-section">Pheromone</div>
    ${_amSlider('am_antPheromoneRate', 'I (deposit)', 0, 100, 50, v => (v/100).toFixed(2), 'P += I · (1 − √d²/r); clamp to 255')}
    ${_amSlider('am_antPheromoneDecay', 'λ (evapor.)', 1, 100, 20, v => (v/1000).toFixed(3), 'P *= (1 − λ); if P < 0.5: P = 0')}
    ${_amSlider('am_antPheromoneSize', 'r (trail)', 1, 30, 6, null, 'Radius of radial pheromone deposit kernel')}

    <div class="am-section">Sensing (8-Point Radial)</div>
    ${_amSlider('am_sensingStrength', 'w_sense', 0, 100, 50, v => (v/100).toFixed(2), 'F_sense = w_s · v_max · Σ s_k · d̂_k')}
    ${_amSlider('am_sensingRadius', 'R_sense', 5, 80, 20, null, 's_k = P(p + R·(cos θ_k, sin θ_k)), k=0…7')}
    ${_amSlider('am_sensingThreshold', 'τ (thresh)', 0, 100, 10, v => (v/100).toFixed(2), 'Only accumulate if s_k > τ')}

    <div class="am-section">Per-Agent Variance</div>
    ${_amSlider('am_individuality', 'individuality', 0, 100, 0, v => (v/100).toFixed(2), 'm = 1 + (ξ − 0.5) · 2 · σ_v (per-agent multipliers)')}
    ${_amSlider('am_speedVar', 'σ_speed', 0, 100, 0, v => (v/100).toFixed(2), 'Per-agent max-speed multiplier variance')}
    ${_amSlider('am_forceVar', 'σ_force', 0, 100, 0, v => (v/100).toFixed(2), 'Per-agent seek/coh/sep weight variance')}
  `;

  // ── Format map for panel sliders ──
  const amFormats = {
    am_seek: v => (v/100).toFixed(2), am_cohesion: v => (v/100).toFixed(2),
    am_separation: v => (v/100).toFixed(2), am_alignment: v => (v/100).toFixed(2),
    am_jitter: v => (v/100).toFixed(2), am_wander: v => (v/100).toFixed(2),
    am_wanderSpeed: v => (v/100).toFixed(2), am_fov: v => v + '°',
    am_flowField: v => (v/100).toFixed(2), am_flowScale: v => (v/1000).toFixed(3),
    am_maxSpeed: v => (v/2).toFixed(1), am_damping: v => (v/100).toFixed(2),
    am_individuality: v => (v/100).toFixed(2),
    am_sensingStrength: v => (v/100).toFixed(2), am_sensingThreshold: v => (v/100).toFixed(2),
    am_antFollow: v => (v/100).toFixed(2), am_antPheromoneRate: v => (v/100).toFixed(2),
    am_antPheromoneDecay: v => (v/1000).toFixed(3),
    am_speedVar: v => (v/100).toFixed(2), am_forceVar: v => (v/100).toFixed(2),
  };

  // ── Wire panel sliders: update readout, sync mirrors, invalidate params ──
  panel.querySelectorAll('input[type="range"]').forEach(inp => {
    const span = document.getElementById('v_' + inp.id);
    const fmt = amFormats[inp.id];
    inp.addEventListener('input', () => {
      if (span) span.textContent = fmt ? fmt(+inp.value) : inp.value;
      // Mirror to main sidebar (no-op for panel-only sliders like neighborRadius)
      const pair = _AM_MIRRORS.find(m => m[0] === inp.id);
      if (pair) {
        const main = document.getElementById(pair[1]);
        if (main) {
          main.value = inp.value;
          main.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      app.invalidateParams();
    });
  });

  // ── Open / close ──
  document.getElementById('btnAntMath')?.addEventListener('click', () => {
    // Sync panel slider values from main sidebar before opening
    _AM_MIRRORS.forEach(([panelId, mainId]) => {
      const main = document.getElementById(mainId);
      const p = document.getElementById(panelId);
      if (main && p) {
        p.value = main.value;
        const span = document.getElementById('v_' + panelId);
        const fmt = amFormats[panelId];
        if (span) span.textContent = fmt ? fmt(+p.value) : p.value;
      }
    });
    // Also update panel-only sliders' readouts (neighborRadius, separationRadius)
    panel.querySelectorAll('input[type="range"]').forEach(inp => {
      if (_AM_MIRRORS.some(m => m[0] === inp.id)) return; // already synced above
      const span = document.getElementById('v_' + inp.id);
      if (span) span.textContent = amFormats[inp.id] ? amFormats[inp.id](+inp.value) : inp.value;
    });
    panel.classList.add('open');
  });

  document.getElementById('amBackBtn')?.addEventListener('click', () => {
    panel.classList.remove('open');
  });
}

// ── Sync UI from app state (e.g. after session restore) ─────
function _syncMultDisplays() {
  document.querySelectorAll('[id$="_multIdx"]').forEach(el => {
    const baseId = el.id.slice(0, -8); // strip "_multIdx"
    const dispEl = document.getElementById(baseId + '_multDisp');
    if (dispEl) dispEl.textContent = _fmtMult(Number(el.value));
  });
}

export function syncUI(app) {
  // Update slider readouts
  document.querySelectorAll('#sidebar input[type="range"]').forEach(inp => {
    const span = document.getElementById('v_' + inp.id);
    if (!span) return;
    const fmt = _sliderFormats[inp.id];
    span.textContent = fmt ? fmt(+inp.value) : inp.value;
  });
  _settingsCatalog.forEach((_, controlId) => _syncFavoriteProxies(controlId));
  // Update multiplier displays
  _syncMultDisplays();
  // Layer controls
  const l = app.getActiveLayer();
  if (l) {
    const be = document.getElementById('layerBlend');
    if (be) be.value = l.blend === 'lighter' ? 'add' : l.blend;
    const oe = document.getElementById('layerOpacity');
    if (oe) { oe.value = Math.round(l.opacity * 100); }
    const vs = document.getElementById('v_layerOpacity');
    if (vs) vs.textContent = Math.round(l.opacity * 100);
  }
  _renderLayerList(app);
  syncTextureUI(app);
  syncStampImageUI(app);
  syncEdgeSliders(app);
  _syncLeaderOverrideUI();
  _syncModMatrixUi(app);
  _syncSymmetryModeUi();
  app._refreshSensingLayerSourceUi?.();
  app._refreshSensingRulesSummary?.();
  app._syncMotionPathUI?.();
}

export function refreshWorkspaceSettingsUi(app) {
  _renderUserPresets(app);
  syncUI(app);
}

export function syncTextureUI(app) {
  const textureSelect = document.getElementById('canvasTexturePreset');
  const active = app.getActiveCanvasTextureMeta();
  if (textureSelect) {
    const textures = app.getAvailableCanvasTextures();
    textureSelect.innerHTML = textures.map(tex => {
      const label = tex.sourceType === 'builtin' ? `${tex.name} · Built-in` : `${tex.name} · Custom`;
      return `<option value="${tex.id}">${label}</option>`;
    }).join('');
    if (active?.id) textureSelect.value = active.id;
  }
  const nameEl = document.getElementById('textureName');
  if (nameEl) nameEl.textContent = active?.name || 'No texture';
  const infoEl = document.getElementById('textureFileName');
  if (infoEl) {
    if (!active) infoEl.textContent = 'No texture active';
    else {
      const kind = active.sourceType === 'builtin' ? 'Built-in texture' : 'Custom upload';
      infoEl.textContent = `${kind} · ${active.width}×${active.height}`;
    }
  }
  const clearBtn = document.getElementById('btnClearTexture');
  if (clearBtn) {
    clearBtn.disabled = !app.getAvailableCanvasTextures().some(tex => tex.id === 'custom-upload');
    clearBtn.title = clearBtn.disabled ? 'No custom texture to clear' : 'Remove the custom texture and fall back to the built-in one';
  }
  const preview = document.getElementById('texturePreview');
  if (preview) {
    const ctx = preview.getContext('2d');
    ctx.clearRect(0, 0, preview.width, preview.height);
    if (active?.previewCanvas) ctx.drawImage(active.previewCanvas, 0, 0, preview.width, preview.height);
  }
}

export function syncStampImageUI(app) {
  const meta = app.getCustomStampImageMeta();
  _renderStampPresetSwitcher(app, meta);
  const nameEl = document.getElementById('stampImageName');
  if (nameEl) nameEl.textContent = meta?.name || 'No stamp loaded';
  const infoEl = document.getElementById('stampImageFileName');
  if (infoEl) {
    if (!meta) infoEl.textContent = 'Choose a built-in preset or upload a PNG, WebP, JPEG, or similar image';
    else {
      const kind = meta.sourceType === 'builtin'
        ? (meta.licenseLabel ? `Built-in preset · ${meta.licenseLabel}` : 'Built-in preset')
        : 'Custom upload';
      infoEl.textContent = `${kind} · ${meta.width}×${meta.height}`;
    }
  }
  const enableEl = document.getElementById('stampImageEnabled');
  if (enableEl) {
    enableEl.disabled = !meta;
    if (!meta) enableEl.checked = false;
  }
  const clearBtn = document.getElementById('btnClearStampImage');
  if (clearBtn) {
    clearBtn.disabled = !meta;
    clearBtn.title = meta ? 'Remove the current custom stamp image' : 'No custom stamp image to clear';
  }
  const preview = document.getElementById('stampImagePreview');
  if (preview) {
    const ctx = preview.getContext('2d');
    ctx.clearRect(0, 0, preview.width, preview.height);
    if (meta?.canvas) {
      const aspect = meta.width > 0 && meta.height > 0 ? meta.width / meta.height : 1;
      const drawW = aspect >= 1 ? preview.width : preview.width * aspect;
      const drawH = aspect >= 1 ? preview.height / aspect : preview.height;
      ctx.drawImage(meta.canvas, (preview.width - drawW) / 2, (preview.height - drawH) / 2, drawW, drawH);
    }
  }
}

function _renderStampPresetSwitcher(app, activeMeta = app.getCustomStampImageMeta()) {
  const container = document.getElementById('stampPresetSwitcher');
  if (!container) return;
  const activePresetId = activeMeta?.sourceType === 'builtin' ? activeMeta.id : '';
  container.innerHTML = '';
  for (const preset of app.getAvailableStampImagePresets()) {
    const btn = document.createElement('button');
    const isActive = preset.id === activePresetId;
    btn.type = 'button';
    btn.className = `stamp-preset-btn${isActive ? ' active' : ''}`;
    btn.dataset.stampPresetId = preset.id;
    btn.title = preset.licenseLabel ? `${preset.name} · ${preset.licenseLabel}` : preset.name;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    const img = document.createElement('img');
    img.src = preset.previewDataUrl;
    img.alt = `${preset.name} stamp preset`;
    const label = document.createElement('span');
    label.textContent = preset.name;
    btn.appendChild(img);
    btn.appendChild(label);
    container.appendChild(btn);
  }
}

// ── Slider display format map ───────────────────────────────
const _sliderFormats = {
  brushScale: v => (v / 100).toFixed(1),
  spawnAngle: v => v + '°',
  spawnJitter: v => (v / 100).toFixed(2),
  leaderPull: v => (v / 100).toFixed(2),
  seek: v => (v / 100).toFixed(2),
  cohesion: v => (v / 100).toFixed(2),
  separation: v => (v / 100).toFixed(2),
  alignment: v => (v / 100).toFixed(2),
  jitter: v => (v / 100).toFixed(2),
  wander: v => (v / 100).toFixed(2),
  wanderSpeed: v => (v / 100).toFixed(2),
  fov: v => v + '°',
  flowField: v => (v / 100).toFixed(2),
  flowScale: v => (v / 1000).toFixed(3),
  individuality: v => (v / 100).toFixed(2),
  quorumCompositeStrength: v => (v / 100).toFixed(2),
  maxSpeed: v => (v / 2).toFixed(1),
  damping: v => (v / 100).toFixed(2),
  motionPathScale: v => (v / 100).toFixed(2),
  motionPathSpeed: v => (v / 100).toFixed(2),
  motionPathAcceleration: v => (v / 100).toFixed(2),
  motionPathAvoidance: v => (v / 100).toFixed(2),
  motionPathAttraction: v => (v / 100).toFixed(2),
  motionPathSpacing: v => (v / 100).toFixed(2),
  motionPathPathSmoothing: v => (v / 100).toFixed(2),
  motionPathAngleSmoothing: v => (v / 100).toFixed(2),
  motionPathMovementSmoothing: v => (v / 100).toFixed(2),
  lbmStrokePull: v => (v / 100).toFixed(2),
  lbmStrokeRake: v => (v / 100).toFixed(2),
  lbmStrokeJitter: v => (v / 100).toFixed(2),
  lbmHueJitter: v => v + '°',
  lbmLightnessJitter: v => v + '%',
  lbmViscosity: v => (v / 100).toFixed(2),
  lbmDensity: v => (v / 100).toFixed(2),
  lbmSurfaceTension: v => (v / 100).toFixed(2),
  lbmTimeStep: v => (v / 16).toFixed(2) + '×',
  lbmMotionDecay: v => (v / 100).toFixed(2),
  lbmStopSpeed: v => (v / 100).toFixed(2),
  lbmPigmentCarry: v => (v / 100).toFixed(2),
  lbmPigmentRetention: v => (v / 100).toFixed(2),
  lbmResolutionScale: v => v + '%',
  lbmFluidScale: v => (v / 100).toFixed(2) + '×',
  fluid3dEmissionRate: v => (v / 100).toFixed(2),
  fluid3dEmitterStrength: v => (v / 100).toFixed(2),
  fluid3dEmitterVelocity: v => (v / 100).toFixed(2),
  fluid3dPressure: v => (v / 100).toFixed(2),
  fluid3dMomentum: v => (v / 100).toFixed(2),
  fluid3dVelocityDiffuse: v => (v / 100).toFixed(2),
  fluid3dDrag: v => (v / 100).toFixed(2),
  fluid3dThicknessDecay: v => (v / 100).toFixed(2),
  fluid3dPigmentDiffusion: v => (v / 100).toFixed(2),
  fluid3dPressureFade: v => (v / 100).toFixed(2),
  fluid3dSettleThreshold: v => (v / 100).toFixed(2),
  fluid3dTerrainWeight: v => (v / 100).toFixed(2),
  fluid3dScalarFieldInfluence: v => (v / 100).toFixed(2),
  fluid3dInfluenceStrength: v => (v / 100).toFixed(2),
  fluid3dMaxVelocity: v => (v / 10).toFixed(1),
  fluid3dThicknessFloor: v => (v / 1000).toFixed(3),
  fluid3dOpacity: v => (v / 100).toFixed(2),
  fluid3dOpacityScale: v => (v / 100).toFixed(2),
  fluid3dResolutionScale: v => v + '%',
  fluid3dPreviewScale: v => v + '%',
  fluid3dFluidScale: v => (v / 100).toFixed(2) + '×',
  fluid3dOccupancyBias: v => (v / 100).toFixed(2),
  fluid3dSpreadClamp: v => (v / 100).toFixed(2),
  fluid3dSurfaceTension: v => (v / 100).toFixed(2),
  fluid3dEdgeWidth: v => (v / 100).toFixed(2),
  fluid3dEdgeDrag: v => (v / 100).toFixed(2),
  fluid3dInjectorMotion: v => (v / 100).toFixed(2),
  fluid3dInjectorPigment: v => (v / 100).toFixed(2),
  fluid3dInjectorOccupancy: v => (v / 100).toFixed(2),
  fluid3dInjectorSwirl: v => (v / 100).toFixed(2),
  stampOpacity: v => (v / 100).toFixed(2),
  strokeWaveAmplitude: v => v + ' px',
  strokeWaveLength: v => v + ' px',
  strokeWavePhase: v => v + '°',
  stampImageRotation: v => v + '°',
  smudge: v => (v / 100).toFixed(2),
  canvasTextureStrength: v => (v / 100).toFixed(2),
  canvasTextureScale: v => (v / 100).toFixed(1) + '×',
  canvasTextureOffsetX: v => (v / 10).toFixed(1),
  canvasTextureOffsetY: v => (v / 10).toFixed(1),
  canvasTextureRotation: v => v + '°',
  canvasTextureDeposit: v => (v / 100).toFixed(2),
  canvasTextureFlow: v => (v / 100).toFixed(2),
  canvasTextureEdgeBreakup: v => (v / 100).toFixed(2),
  canvasTextureSmudgeDrag: v => (v / 100).toFixed(2),
  canvasTexturePooling: v => (v / 100).toFixed(2),
  taperLength: v => +v === 0 ? 'off' : v + ' frames',
  taperCurve: v => (v / 100).toFixed(1),
  sensingStrength: v => (v / 100).toFixed(2),
  sensingThreshold: v => (v / 100).toFixed(2),
  sensingUpdateFrames: v => `${Math.round(v)}f`,
  symmetryCenterX: v => v + '%',
  symmetryCenterY: v => v + '%',
  bristleSpread: v => (v / 100).toFixed(2),
  bristleSplay: v => (v / 100).toFixed(2),
  bristleStiffness: v => (v / 100).toFixed(2),
  bristleDamping: v => (v / 100).toFixed(2),
  bristleFriction: v => (v / 100).toFixed(2),
  bristleSmoothing: v => (v / 100).toFixed(2),
  bSizeVar: v => (v / 100).toFixed(2),
  bOpacityVar: v => (v / 100).toFixed(2),
  bStiffVar: v => (v / 100).toFixed(2),
  bLengthVar: v => (v / 100).toFixed(2),
  bFrictionVar: v => (v / 100).toFixed(2),
  bHueVar: v => (v / 100).toFixed(2),
  // Trail blur / KM / Impasto
  trailFlow: v => (v / 100).toFixed(2),
  kmStrength: v => (v / 100).toFixed(2),
  impastoStrength: v => (v / 100).toFixed(2),
  impastoLightAngle: v => v + '°',
  impastoLightElevation: v => v + '°',
  // Ant brush
  antFollow: v => (v / 100).toFixed(2),
  antPheromoneRate: v => (v / 100).toFixed(2),
  antPheromoneDecay: v => (v / 1000).toFixed(3),
  simBoundsMargin: v => `${v}px`,
  simSpeed: v => (v / 100).toFixed(1) + '×',
  simEphemeralFrames: v => `${Math.round(v)}f`,
  simEphemeralFade: v => (v / 100).toFixed(2),
  simPointStrength: v => (v / 100).toFixed(2),
  simPathSpeed: v => `${v}px/s`,
  simEdgeForce: v => (v / 100).toFixed(2),
  simPheroPaintStrength: v => (v / 100).toFixed(2),
};

LEADER_OVERRIDE_FIELDS.forEach(field => {
  if (field.type === 'range' && !_sliderFormats[field.id] && _sliderFormats[field.sourceId]) {
    _sliderFormats[field.id] = _sliderFormats[field.sourceId];
  }
});

let _edgeSliderApp = null;

// ── Layer list renderer ─────────────────────────────────────
let _dragSrcIdx = null;

function _renderLayerList(app) {
  const list = document.getElementById('layerList');
  if (!list) return;
  list.innerHTML = '';

  // Count non-background (paint) layers to decide if drag/reorder makes sense
  const paintCount = app.layers.filter(l => !l.isBackground).length;

  app.layers.forEach((l, i) => {
    const div = document.createElement('div');
    if (l.isBackground) {
      div.className = 'layer-item bg-layer';
      div.innerHTML = `
        <button class="vis-btn${l.visible ? '' : ' hidden'}" data-idx="${i}">${l.visible ? '👁' : '⬚'}</button>
        <span class="layer-name" style="opacity:0.6">Background</span>
      `;
      div.querySelector('.vis-btn').addEventListener('click', () => {
        l.visible = !l.visible;
        app.compositeAllLayers({ forceFull: true });
        _renderLayerList(app);
      });
      list.appendChild(div);
      return;
    }
    div.className = 'layer-item' + (i === app.activeLayerIdx ? ' active' : '');
    div.draggable = paintCount > 1;
    div.dataset.layerIdx = i;
    div.innerHTML = `
      <button class="vis-btn${l.visible ? '' : ' hidden'}" data-idx="${i}">${l.visible ? '👁' : '⬚'}</button>
      <button class="lock-btn${l.alphaLock ? ' locked' : ''}" data-idx="${i}" title="Alpha Lock">${l.alphaLock ? '🔒' : '🔓'}</button>
      <span class="layer-name">${l.name}</span>
      <span class="layer-opacity">${Math.round(l.opacity * 100)}%</span>
    `;

    // Prevent child buttons from starting their own drag
    div.querySelectorAll('button').forEach(btn => {
      btn.draggable = false;
      btn.addEventListener('dragstart', e => e.stopPropagation());
    });

    // ── Drag-to-reorder ──
    div.addEventListener('dragstart', e => {
      _dragSrcIdx = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      // Slight delay so the dragging class applies after the drag image is captured
      requestAnimationFrame(() => div.classList.add('dragging'));
    });
    div.addEventListener('dragend', () => {
      _dragSrcIdx = null;
      div.classList.remove('dragging');
      _removeDropIndicator(list);
    });
    div.addEventListener('dragover', e => {
      if (_dragSrcIdx === null || _dragSrcIdx === i) return;
      if (l.isBackground) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Show drop indicator above or below this item depending on cursor position
      const rect = div.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const above = e.clientY < midY;
      _showDropIndicator(list, div, above);
    });
    div.addEventListener('dragleave', (e) => {
      // Only remove if leaving the item entirely (not entering a child)
      if (!div.contains(e.relatedTarget)) {
        // Don't clear here — let dragover on next item handle it
      }
    });
    div.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      _removeDropIndicator(list);
      if (_dragSrcIdx === null || _dragSrcIdx === i) return;
      const from = _dragSrcIdx;
      // Determine insert position based on where indicator was
      const rect = div.getBoundingClientRect();
      const midY = e.clientY < rect.top + rect.height / 2;
      let to = midY ? i : i + 1;
      // Don't drop onto/past background
      if (to >= app.layers.length) to = app.layers.length - 1;
      if (app.layers[to]?.isBackground) to = to - 1;
      if (from === to) { _dragSrcIdx = null; return; }
      _dragSrcIdx = null;
      app.pushUndo();
      const [moved] = app.layers.splice(from, 1);
      // Adjust target index after removal
      const insertAt = from < to ? to - 1 : to;
      app.layers.splice(insertAt, 0, moved);
      if (app.activeLayerIdx === from) {
        app.activeLayerIdx = insertAt;
      } else if (from < app.activeLayerIdx && insertAt >= app.activeLayerIdx) {
        app.activeLayerIdx--;
      } else if (from > app.activeLayerIdx && insertAt <= app.activeLayerIdx) {
        app.activeLayerIdx++;
      }
      app._syncLayerSwitcher();
      app.compositeAllLayers();
      _refreshLayers(app);
    });

    // ── Click handlers ──
    div.addEventListener('click', e => {
      if (e.target.classList.contains('vis-btn')) {
        l.visible = !l.visible;
        app.compositeAllLayers({ forceFull: true });
        _renderLayerList(app);
        return;
      }
      if (e.target.classList.contains('lock-btn')) {
        l.alphaLock = !l.alphaLock;
        app._syncAlphaLockUI();
        _renderLayerList(app);
        return;
      }
      app.setActiveLayer(i);
      _syncLayerControls(app);
      _renderLayerList(app);
    });
    div.querySelector('.layer-name').addEventListener('dblclick', () => {
      const n = prompt('Layer name:', l.name);
      if (n) { l.name = n; app._syncLayerSwitcher(); _renderLayerList(app); }
    });
    list.appendChild(div);
  });

  // Allow the list container itself to accept drops (for reordering to end of list)
  list.ondragover = e => {
    if (_dragSrcIdx === null) return;
    if (e.target === list) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Show indicator at the end (before background)
      const lastPaint = list.querySelector('.layer-item:not(.bg-layer):last-of-type') ||
                        list.querySelector('.layer-item.bg-layer');
      if (lastPaint) _showDropIndicator(list, lastPaint, false);
    }
  };
  list.ondrop = e => {
    if (_dragSrcIdx === null) return;
    if (e.target !== list) return;
    e.preventDefault();
    _removeDropIndicator(list);
    const from = _dragSrcIdx;
    const bgIdx = app.layers.findIndex(l => l.isBackground);
    const to = bgIdx >= 0 ? bgIdx - 1 : app.layers.length - 1;
    if (from === to) return;
    _dragSrcIdx = null;
    app.pushUndo();
    const [moved] = app.layers.splice(from, 1);
    const insertAt = Math.min(to, app.layers.length);
    app.layers.splice(insertAt, 0, moved);
    if (app.activeLayerIdx === from) {
      app.activeLayerIdx = insertAt;
    } else if (from < app.activeLayerIdx && insertAt >= app.activeLayerIdx) {
      app.activeLayerIdx--;
    } else if (from > app.activeLayerIdx && insertAt <= app.activeLayerIdx) {
      app.activeLayerIdx++;
    }
    app._syncLayerSwitcher();
    app.compositeAllLayers();
    _refreshLayers(app);
  };
  app._refreshSensingLayerSourceUi?.();
}

function _formatBookmarkTimestamp(timestamp) {
  if (!timestamp) return 'No time saved';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'No time saved';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function _appendBookmarkMetaLine(container, text) {
  const line = document.createElement('div');
  line.textContent = text;
  container.appendChild(line);
}

function _renderViewBookmarksPanel(app) {
  const list = document.getElementById('viewBookmarkList');
  const lastChange = document.getElementById('viewBookmarkLastChange');
  const jumpLastBtn = document.getElementById('btnJumpLastChange');
  if (!list || !lastChange) return;

  list.innerHTML = '';
  lastChange.innerHTML = '';

  const activeBookmarkId = app.getActiveViewBookmarkId?.() || null;
  const bookmarks = Array.isArray(app.viewBookmarks) ? app.viewBookmarks : [];
  if (!bookmarks.length) {
    const empty = document.createElement('div');
    empty.className = 'view-bookmark-empty';
    empty.textContent = 'Save named views here to jump back to important canvas locations.';
    list.appendChild(empty);
  } else {
    bookmarks.forEach(bookmark => {
      const item = document.createElement('div');
      item.className = 'view-bookmark-item' + (bookmark.id === activeBookmarkId ? ' active' : '');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'view-bookmark-main';
      main.title = `Jump to ${bookmark.name}`;
      main.addEventListener('click', () => app.jumpToViewBookmark?.(bookmark.id));

      const title = document.createElement('div');
      title.className = 'view-bookmark-title';
      title.textContent = bookmark.name;
      main.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'view-bookmark-meta';
      _appendBookmarkMetaLine(meta, `Saved ${_formatBookmarkTimestamp(bookmark.updatedAt || bookmark.createdAt)}`);
      if (bookmark.layerName) _appendBookmarkMetaLine(meta, `Layer: ${bookmark.layerName}`);
      main.appendChild(meta);
      item.appendChild(main);

      const actions = document.createElement('div');
      actions.className = 'view-bookmark-actions';
      const actionSpecs = [
        {
          label: 'Overwrite',
          title: `Overwrite ${bookmark.name} with the current view`,
          onClick: () => app.saveCurrentViewBookmark?.({ overwriteId: bookmark.id, name: bookmark.name }),
        },
        {
          label: 'Rename',
          title: `Rename ${bookmark.name}`,
          onClick: () => {
            const name = prompt('Rename bookmark:', bookmark.name);
            if (name === null) return;
            app.renameViewBookmark?.(bookmark.id, name);
          },
        },
        {
          label: 'Delete',
          title: `Delete ${bookmark.name}`,
          onClick: () => app.deleteViewBookmark?.(bookmark.id),
        },
      ];
      actionSpecs.forEach(spec => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = spec.label;
        button.title = spec.title;
        button.addEventListener('click', spec.onClick);
        actions.appendChild(button);
      });
      item.appendChild(actions);
      list.appendChild(item);
    });
  }

  const marker = app.lastChangeMarker;
  if (marker) {
    const card = document.createElement('div');
    card.className = 'view-bookmark-lastchange';
    const meta = document.createElement('div');
    meta.className = 'view-bookmark-meta';
    const title = document.createElement('div');
    title.className = 'view-bookmark-title';
    title.textContent = marker.label || 'Last change';
    card.appendChild(title);
    _appendBookmarkMetaLine(meta, `Updated ${_formatBookmarkTimestamp(marker.timestamp)}`);
    if (marker.layerName) _appendBookmarkMetaLine(meta, `Layer: ${marker.layerName}`);
    card.appendChild(meta);
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.textContent = 'Jump to last change';
    jump.addEventListener('click', () => app.jumpToLastChange?.());
    card.appendChild(jump);
    lastChange.appendChild(card);
  } else {
    const empty = document.createElement('div');
    empty.className = 'view-bookmark-empty';
    empty.textContent = 'No recent committed change has been recorded yet.';
    lastChange.appendChild(empty);
  }

  if (jumpLastBtn) jumpLastBtn.disabled = !marker;
}

// ── Drop indicator helpers ──────────────────────────────────
function _removeDropIndicator(list) {
  list.querySelectorAll('.layer-drop-indicator').forEach(el => el.remove());
}

function _showDropIndicator(list, refElement, above) {
  _removeDropIndicator(list);
  const indicator = document.createElement('div');
  indicator.className = 'layer-drop-indicator';
  if (above) {
    refElement.parentNode.insertBefore(indicator, refElement);
  } else {
    refElement.parentNode.insertBefore(indicator, refElement.nextSibling);
  }
}

function _refreshLayers(app) {
  _renderLayerList(app);
  _syncLayerControls(app);
}

function _syncLayerControls(app) {
  const l = app.getActiveLayer();
  if (!l) return;
  const be = document.getElementById('layerBlend');
  if (be) be.value = l.blend === 'lighter' ? 'add' : l.blend;
  const oe = document.getElementById('layerOpacity');
  if (oe) oe.value = Math.round(l.opacity * 100);
  const vs = document.getElementById('v_layerOpacity');
  if (vs) vs.textContent = Math.round(l.opacity * 100);
}

// ── Built-in presets ────────────────────────────────────────
function _renderBuiltinPresets(app) {
  const container = document.getElementById('builtinPresets');
  if (!container) return;
  container.innerHTML = '';
  for (const [name, values] of Object.entries(BUILTIN_PRESETS)) {
    const fallbackBrush = values._activeBrush || 'boid';
    let preset;
    try {
      preset = normalizePreset(values, { catalog: _settingsCatalog, fallbackName: name, fallbackBrush, normalizeValue: _normalizePresetControlValue }).preset;
    } catch {
      continue;
    }
    const activeOnly = document.getElementById('presetLibraryScope')?.value !== 'all';
    const search = document.getElementById('presetLibrarySearch')?.value?.trim().toLowerCase() || '';
    if (activeOnly && preset.scope.brush !== app.activeBrush) continue;
    if (search && !`${name} ${preset.scope.kind} ${preset.scope.brush}`.toLowerCase().includes(search)) continue;
    const btn = document.createElement('button');
    btn.textContent = `${name} · ${preset.scope.brush}`;
    btn.title = `Built-in ${preset.scope.kind} preset`;
    btn.addEventListener('click', () => _applyBuiltinPreset(app, name, values, preset.scope.brush));
    container.appendChild(btn);
  }
}

function _applyBuiltinPreset(app, name, values, brush) {
  if (brush && brush !== app.activeBrush) app.setBrush(brush);
  for (const [id, value] of Object.entries(values)) {
    if (id === '_activeBrush') continue;
    if (id === '_primaryColor') {
      app.setColorValue?.('primary', value) ?? (app.primaryEl.value = value);
      continue;
    }
    if (id === '_secondaryColor') {
      app.setColorValue?.('secondary', value) ?? (app.secondaryEl.value = value);
      continue;
    }
    const control = document.getElementById(id);
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = !!value;
    else control.value = String(value);
  }
  app.invalidateParams();
  syncUI(app);
  app.showToast(`Applied "${name}"`);
}

// ── User presets ────────────────────────────────────────────
function _renderUserPresets(app) {
  const container = document.getElementById('userPresets');
  if (!container) return;
  container.innerHTML = '';
  const library = loadPresetLibrary();
  if (app._pendingLegacyWorkspacePresets && Object.keys(app._pendingLegacyWorkspacePresets).length) {
    const compatibility = document.createElement('button');
    compatibility.type = 'button';
    compatibility.style.width = '100%';
    compatibility.style.marginBottom = '5px';
    compatibility.textContent = `Import ${Object.keys(app._pendingLegacyWorkspacePresets).length} embedded workspace preset(s)`;
    compatibility.addEventListener('click', () => {
      try {
        const candidate = normalizeLibrary(app._pendingLegacyWorkspacePresets, {
          catalog: _settingsCatalog,
          normalizeValue: _normalizePresetControlValue,
          fallbackBrush: app.activeBrush,
          skipInvalidEntries: true,
        });
        savePresetLibrary(mergeImportedEntries(loadPresetLibrary(), candidate.library));
        app._pendingLegacyWorkspacePresets = null;
        _renderUserPresets(app);
        const skipped = candidate.warnings.filter(warning => warning.error).length;
        app.showToast(`Imported ${candidate.library.entries.length} legacy workspace preset(s)${skipped ? ` · ${skipped} invalid skipped` : ''}`);
      } catch (error) {
        app.showToast(`Legacy preset import failed: ${error.message}`);
      }
    });
    container.appendChild(compatibility);
  }
  const activeOnly = document.getElementById('presetLibraryScope')?.value !== 'all';
  const search = document.getElementById('presetLibrarySearch')?.value?.trim().toLowerCase() || '';
  for (const preset of library.entries) {
    if (activeOnly && preset.scope.brush !== app.activeBrush) continue;
    if (search && !`${preset.name} ${preset.scope.kind} ${preset.scope.brush}`.toLowerCase().includes(search)) continue;
    const row = document.createElement('div');
    row.className = 'preset-item';
    const btn = document.createElement('button');
    btn.textContent = `${preset.name} · ${preset.scope.kind} · ${preset.scope.brush}`;
    btn.addEventListener('click', () => _applyPreset(app, preset));
    const more = document.createElement('button');
    more.className = 'preset-del';
    more.textContent = '⋯';
    more.title = 'Rename, duplicate, or export';
    more.addEventListener('click', () => _managePreset(app, preset.id));
    const del = document.createElement('button');
    del.className = 'preset-del';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      const next = emptyLibrary(library.entries.filter(entry => entry.id !== preset.id));
      try {
        savePresetLibrary(next);
        _renderUserPresets(app);
        app.showToast(`Deleted "${preset.name}"`);
      } catch (error) {
        console.error('Preset deletion failed:', error);
        app.showToast('Preset could not be deleted from this device');
      }
    });
    row.appendChild(btn);
    row.appendChild(more);
    row.appendChild(del);
    container.appendChild(row);
  }
  if (!container.children.length) container.innerHTML = '<span class="slider-desc">No matching device presets.</span>';
}

function _applyPreset(app, preset) {
  if (preset.scope.brush !== app.activeBrush) {
    app.showToast(`Switch to ${preset.scope.brush} to apply this preset`);
    return;
  }
  const legacyMotionPath = preset.legacyAuthoredContent?.motionPath;
  if (preset.scope.brush === 'motionPath' && legacyMotionPath && typeof legacyMotionPath === 'object') {
    app.motionPath = {
      ...app.motionPath,
      ...structuredClone(legacyMotionPath),
      editorOpen: false,
      previousUiState: null,
    };
    app._normalizeMotionPathState?.();
  }
  const legacyColors = preset.legacyAuthoredContent?.colors;
  if (typeof legacyColors?.primary === 'string') app.setColorValue?.('primary', legacyColors.primary);
  if (typeof legacyColors?.secondary === 'string') app.setColorValue?.('secondary', legacyColors.secondary);
  if (preset.scope.kind === 'simulation') {
    if (app.simulation?.running || app.simulation?.paused) app.stopSimulation(false);
    const authored = preset.values.authoredContent || {};
    if (authored.brushData && app.simulation?.brushData) {
      app.simulation.brushData[preset.scope.brush] = structuredClone(authored.brushData);
    }
    if (authored.vars && app.simulation) app.simulation.vars = structuredClone(authored.vars);
    if (authored.sensingSourceSelection) app._restoreSensingSourceSelection?.(authored.sensingSourceSelection);
    if (app.simulation) {
      app.simulation.savedPlayback = null;
      app.simulation.selected = null;
      app.simulation.drawingPath = null;
      app.simulation.drawingBlob = null;
      app.simulation.dragTarget = null;
    }
    app._normalizeSimulationData?.();
    _advanceSimulationNextId(app);
    app._ensureSimulationSpawns?.(preset.scope.brush);
  }
  const result = applyPresetValues(document, _settingsCatalog, preset, { normalizeValue: _normalizePresetControlValue });
  app.invalidateParams();
  syncUI(app);
  app._renderSimulationInspector?.();
  app._syncSimulationUI?.();
  app.showToast(`Applied "${preset.name}"${result.dropped.length ? ` (${result.dropped.length} unavailable)` : ''}`);
}

function _captureCurrentPreset(app, kind, name) {
  const scope = { kind, brush: app.activeBrush };
  const parameters = capturePresetValues(document, _settingsCatalog, scope, { normalizeValue: _normalizePresetControlValue });
  if (kind === 'brush') return createPreset({ name, kind, brush: app.activeBrush, values: parameters });
  const authoredContent = {
    brushData: structuredClone(app.simulation?.brushData?.[app.activeBrush] || {}),
    vars: structuredClone(app.simulation?.vars || {}),
    sensingSourceSelection: structuredClone(app._serializeSensingSourceSelection?.() || []),
  };
  return createPreset({
    name,
    kind,
    brush: app.activeBrush,
    values: { parameters, authoredContent },
  });
}

function _advanceSimulationNextId(app) {
  if (!app.simulation) return;
  let maxId = Math.max(0, Math.floor(Number(app.simulation.nextId) || 1) - 1);
  const pending = [app.simulation.brushData];
  const seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Number.isFinite(Number(value.id))) maxId = Math.max(maxId, Math.floor(Number(value.id)));
    if (Array.isArray(value)) pending.push(...value);
    else pending.push(...Object.values(value));
  }
  app.simulation.nextId = maxId + 1;
}

function _saveNewPreset(app, kind = 'brush') {
  if (kind === 'simulation' && !['boid', 'ant'].includes(app.activeBrush)) {
    app.showToast('Simulation presets are available for Boid and Ant');
    return;
  }
  const name = prompt(`${kind === 'simulation' ? 'Simulation' : 'Brush'} preset name:`);
  if (!name) return;
  const library = loadPresetLibrary();
  const preset = _captureCurrentPreset(app, kind, name);
  const merged = mergeImportedEntries(library, emptyLibrary([preset]));
  try {
    savePresetLibrary(merged);
    _renderUserPresets(app);
    app.showToast(`Saved "${merged.entries.at(-1).name}"`);
  } catch (error) {
    console.error('Preset save failed:', error);
    app.showToast('Preset could not be saved to this device');
  }
}

function _importPreset(app) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const versioned = parsed?.format === PRESET_FORMAT || parsed?.format === PRESET_LIBRARY_FORMAT;
      const candidate = normalizeLibrary(parsed, {
        normalizeValue: _normalizePresetControlValue,
        catalog: _settingsCatalog,
        fallbackBrush: app.activeBrush,
        skipInvalidEntries: !versioned,
      });
      const next = mergeImportedEntries(loadPresetLibrary(), candidate.library);
      savePresetLibrary(next);
      _renderUserPresets(app);
      const loss = candidate.warnings.reduce((sum, warning) => sum + warning.dropped.length, 0);
      const skipped = candidate.warnings.filter(warning => warning.error).length;
      const warningParts = [
        loss ? `${loss} unsupported setting(s) skipped` : '',
        skipped ? `${skipped} invalid preset(s) skipped` : '',
      ].filter(Boolean);
      app.showToast(`Imported ${candidate.library.entries.length} preset(s)${warningParts.length ? ` · ${warningParts.join(' · ')}` : ''}`);
    } catch (error) {
      app.showToast(`Import failed: ${error.message}`);
    }
  }, { once: true });
  input.click();
}

function _exportPresets(app) {
  _downloadSettingsJson(loadPresetLibrary(), `boid-brush-preset-library-${new Date().toISOString().slice(0, 10)}.json`);
  app.showToast('Preset library exported');
}

function _managePreset(app, id) {
  const library = loadPresetLibrary();
  const preset = library.entries.find(entry => entry.id === id);
  if (!preset) return;
  const action = prompt('Preset action: rename, duplicate, or export', 'rename')?.trim().toLowerCase();
  if (action === 'rename') {
    const name = prompt('New preset name:', preset.name)?.trim();
    if (!name) return;
    const occupied = new Set(library.entries.filter(entry => entry.id !== id).map(entry => entry.name));
    let resolved = name;
    let n = 2;
    while (occupied.has(resolved)) resolved = `${name} (${n++})`;
    preset.name = resolved;
    preset.updatedAt = new Date().toISOString();
    try {
      savePresetLibrary(library);
      _renderUserPresets(app);
    } catch (error) {
      console.error('Preset rename failed:', error);
      app.showToast('Preset could not be renamed on this device');
    }
  } else if (action === 'duplicate') {
    const duplicate = createPreset({
      ...preset,
      id: undefined,
      name: `${preset.name} Copy`,
      kind: preset.scope.kind,
      brush: preset.scope.brush,
    });
    try {
      savePresetLibrary(mergeImportedEntries(library, emptyLibrary([duplicate])));
      _renderUserPresets(app);
    } catch (error) {
      console.error('Preset duplicate failed:', error);
      app.showToast('Preset could not be duplicated on this device');
    }
  } else if (action === 'export') {
    _downloadSettingsJson(preset, `${preset.name.replace(/[^\w.-]+/g, '-') || 'preset'}.json`);
  }
}

function _downloadSettingsJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function _importFavorites(app) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const imported = normalizeFavorites(JSON.parse(await file.text()));
      const merged = normalizeFavorites({
        ..._favoritesState,
        items: [..._favoritesState.items, ...imported.items],
      });
      saveFavorites(merged);
      _favoritesState = merged;
      _decorateFavoriteControls(app);
      _renderFavorites(app);
      _renderSettingsCatalogResults(app);
      app.showToast(`Imported ${imported.items.length} favorite(s)`);
    } catch (error) {
      app.showToast(`Favorites import failed: ${error.message}`);
    }
  }, { once: true });
  input.click();
}

function _favoriteIds(brush = '') {
  return new Set(_favoritesState.items
    .filter(item => !item.scope?.brush || !brush || item.scope.brush === brush)
    .map(item => item.controlId));
}

function _decorateFavoriteControls(app) {
  const favoriteIds = _favoriteIds(app.activeBrush);
  for (const entry of _settingsCatalog.values()) {
    if (!entry.favoriteEligible) continue;
    const control = document.getElementById(entry.id);
    const label = control?.closest('label');
    const existingStar = label?.querySelector(':scope > .setting-favorite-toggle');
    if (existingStar) {
      const selected = favoriteIds.has(entry.id);
      existingStar.textContent = selected ? '★' : '☆';
      existingStar.title = selected ? 'Remove from Favorites' : 'Add to Favorites';
      continue;
    }
    if (!control || !label) continue;
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'setting-favorite-toggle';
    star.textContent = favoriteIds.has(entry.id) ? '★' : '☆';
    star.title = favoriteIds.has(entry.id) ? 'Remove from Favorites' : 'Add to Favorites';
    star.setAttribute('aria-label', star.title);
    star.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const previous = structuredClone(_favoritesState);
      const favoriteScope = entry.scope.kind === 'brush'
        ? { kind: 'brush', brush: app.activeBrush }
        : { kind: entry.scope.kind };
      const index = _favoritesState.items.findIndex(item =>
        item.controlId === entry.id
        && (item.scope?.brush || '') === (favoriteScope.brush || '')
      );
      if (index >= 0) _favoritesState.items.splice(index, 1);
      else _favoritesState.items.push({
        controlId: entry.id,
        scope: favoriteScope,
      });
      try {
        saveFavorites(_favoritesState);
        _decorateFavoriteControls(app);
        document.querySelectorAll('.setting-favorite-toggle').forEach(button => {
          const target = button.closest('label')?.querySelector('input[id],select[id],textarea[id]');
          if (!target) return;
          const selected = _favoriteIds(app.activeBrush).has(target.id);
          button.textContent = selected ? '★' : '☆';
          button.title = selected ? 'Remove from Favorites' : 'Add to Favorites';
        });
        _renderFavorites(app);
        _renderSettingsCatalogResults(app);
      } catch (error) {
        _favoritesState = previous;
        console.error('Favorite save failed:', error);
        app.showToast('Favorites could not be saved');
      }
    });
    label.appendChild(star);
    if (!control.dataset.favoriteSyncWired) {
      control.dataset.favoriteSyncWired = '1';
      const sync = () => _syncFavoriteProxies(entry.id);
      control.addEventListener('input', sync);
      control.addEventListener('change', sync);
    }
  }
}

function _syncFavoriteProxies(controlId) {
  const source = document.getElementById(controlId);
  if (!source) return;
  const canonicalReadout = document.getElementById(`v_${controlId}`);
  document.querySelectorAll(`[data-favorite-control="${controlId}"]`).forEach(proxy => {
    if (proxy.type === 'checkbox') proxy.checked = source.checked;
    else proxy.value = source.value;
  });
  document.querySelectorAll(`[data-favorite-readout="${controlId}"]`).forEach(readout => {
    readout.textContent = canonicalReadout?.textContent || '';
  });
}

function _renderFavorites(app) {
  const container = document.getElementById('favoriteControlList');
  if (!container) return;
  container.innerHTML = '';
  const grouped = new Map();
  for (const item of _favoritesState.items) {
    if (item.scope?.brush && item.scope.brush !== app.activeBrush) continue;
    const entry = _settingsCatalog.get(item.controlId);
    if (!entry) {
      const row = document.createElement('div');
      row.className = 'favorite-control-row';
      row.textContent = `${item.controlId} · unavailable`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        const previous = _favoritesState;
        const next = { ..._favoritesState, items: _favoritesState.items.filter(candidate => candidate !== item) };
        try {
          saveFavorites(next);
          _favoritesState = next;
          _renderFavorites(app);
        } catch (error) {
          _favoritesState = previous;
          console.error('Favorite removal failed:', error);
          app.showToast('Favorite could not be removed');
        }
      });
      row.appendChild(remove);
      container.appendChild(row);
      continue;
    }
    if (!catalogEntryApplies(entry, app.activeBrush, 'favorite')) continue;
    const key = entry.section || entry.scope.kind;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ entry, item });
  }
  for (const [section, favorites] of grouped) {
    const heading = document.createElement('div');
    heading.className = 'favorite-section-label';
    heading.textContent = section;
    container.appendChild(heading);
    favorites.forEach(({ entry, item }) => {
      const canonical = document.getElementById(entry.id);
      if (!canonical) return;
      const row = document.createElement('div');
      row.className = 'favorite-control-row';
      const setting = document.createElement('label');
      setting.className = 'favorite-setting-proxy';
      const text = document.createElement('span');
      text.className = 'favorite-control-label';
      text.textContent = entry.label;
      const canonicalReadout = document.getElementById(`v_${entry.id}`);
      const readout = canonicalReadout
        && canonicalReadout.closest('label') === canonical.closest('label')
        ? canonicalReadout.cloneNode(true)
        : null;
      if (readout) {
        readout.removeAttribute('id');
        readout.dataset.favoriteReadout = entry.id;
      }
      const proxy = canonical.cloneNode(true);
      proxy.removeAttribute('id');
      proxy.removeAttribute('data-favorite-sync-wired');
      proxy.dataset.favoriteControl = entry.id;
      proxy.addEventListener('input', () => {
        if (canonical.type === 'checkbox') canonical.checked = proxy.checked;
        else canonical.value = proxy.value;
        canonical.dispatchEvent(new Event('input', { bubbles: true }));
      });
      proxy.addEventListener('change', () => {
        if (canonical.type === 'checkbox') canonical.checked = proxy.checked;
        else canonical.value = proxy.value;
        canonical.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'preset-del';
      remove.textContent = '✕';
      remove.title = 'Remove favorite';
      remove.addEventListener('click', event => {
        event.preventDefault();
        const previous = _favoritesState;
        const next = {
          ..._favoritesState,
          items: _favoritesState.items.filter(item =>
            item.controlId !== entry.id || (item.scope?.brush && item.scope.brush !== app.activeBrush)
          ),
        };
        try {
          saveFavorites(next);
          _favoritesState = next;
          _renderFavorites(app);
          _decorateFavoriteControls(app);
        } catch (error) {
          _favoritesState = previous;
          console.error('Favorite removal failed:', error);
          app.showToast('Favorite could not be removed');
        }
      });
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'preset-del';
      up.textContent = '↑';
      up.title = 'Move favorite up';
      up.addEventListener('click', event => {
        event.preventDefault();
        const index = _favoritesState.items.indexOf(item);
        if (index <= 0) return;
        const items = [..._favoritesState.items];
        [items[index - 1], items[index]] = [items[index], items[index - 1]];
        const next = { ..._favoritesState, items };
        try {
          saveFavorites(next);
          _favoritesState = next;
          _renderFavorites(app);
        } catch (error) {
          console.error('Favorite reorder failed:', error);
          app.showToast('Favorites could not be reordered');
        }
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'preset-del';
      down.textContent = '↓';
      down.title = 'Move favorite down';
      down.addEventListener('click', event => {
        event.preventDefault();
        const index = _favoritesState.items.indexOf(item);
        if (index < 0 || index >= _favoritesState.items.length - 1) return;
        const items = [..._favoritesState.items];
        [items[index + 1], items[index]] = [items[index], items[index + 1]];
        const next = { ..._favoritesState, items };
        try {
          saveFavorites(next);
          _favoritesState = next;
          _renderFavorites(app);
        } catch (error) {
          console.error('Favorite reorder failed:', error);
          app.showToast('Favorites could not be reordered');
        }
      });
      setting.append(text);
      if (readout) setting.append(readout);
      setting.append(proxy);
      const actions = document.createElement('span');
      actions.className = 'favorite-control-actions';
      actions.append(up, down, remove);
      row.append(setting, actions);
      container.appendChild(row);
    });
  }
  if (!container.children.length) {
    container.innerHTML = '<span class="slider-desc">Star a setting in the Brush panel. Favorites are filtered to the active brush or simulation mode.</span>';
  }
}

function _wireSettingsCatalogSearch(app) {
  const search = document.getElementById('settingsCatalogSearch');
  const scope = document.getElementById('settingsCatalogScope');
  const refresh = () => _renderSettingsCatalogResults(app);
  search?.addEventListener('input', refresh);
  scope?.addEventListener('change', refresh);
  refresh();
}

function _renderSettingsCatalogResults(app) {
  const container = document.getElementById('settingsCatalogResults');
  if (!container) return;
  const query = document.getElementById('settingsCatalogSearch')?.value?.trim().toLowerCase() || '';
  const scope = document.getElementById('settingsCatalogScope')?.value || 'active';
  const favorites = _favoriteIds(app.activeBrush);
  container.innerHTML = '';
  const entries = [..._settingsCatalog.values()].filter(entry => {
    if (scope === 'active' && !catalogEntryApplies(entry, app.activeBrush, 'favorite')) return false;
    if (scope === 'simulation' && !catalogEntryApplies(entry, app.activeBrush, 'simulation')) return false;
    if (scope === 'shared' && entry.scope.kind !== 'shared') return false;
    if (scope === 'favorites' && !favorites.has(entry.id)) return false;
    return !query || `${entry.label} ${entry.description} ${entry.section} ${entry.scope.kind} ${(entry.scope.brushes || []).join(' ')}`.toLowerCase().includes(query);
  }).slice(0, query || scope !== 'active' ? 40 : 0);
  entries.forEach(entry => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-search-result';
    button.textContent = `${entry.label} · ${entry.section || entry.scope.kind}`;
    button.addEventListener('click', () => {
      let control = document.getElementById(entry.id);
      const isStoredSimulationControl = !!control?.closest('#simControlStore');
      if (isStoredSimulationControl) {
        if (!app.simulation?.enabled) app._toggleSimulationMode?.(true);
        if (app.simulation) app.simulation.inspectorCollapsed = false;
        app._renderSimulationInspector?.();
        app._activateRightPanelTab?.('simulation');
        control = document.querySelector(`#simOverlaySidebar [data-sim-param="${entry.id}"]`)
          || document.querySelector(`#simulationControlsPanel [data-sim-param="${entry.id}"]`);
      } else {
        app._activateRightPanelTab?.('brush');
      }
      const body = control?.closest('.section-body, [data-sim-section-body]');
      body?.classList.remove('collapsed');
      body?.previousElementSibling?.classList.remove('closed');
      control?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      control?.focus({ preventScroll: true });
    });
    container.appendChild(button);
  });
}

// ── Edge slider sync ────────────────────────────────────────
export function syncEdgeSliders(app = _edgeSliderApp) {
  document.querySelectorAll('.edge-slider').forEach(slider => {
    const simOnly = slider.dataset.simOnly === '1';
    const showSimOnly = !!(app?.simulation?.enabled && app?._isMotionBrush?.());
    if (simOnly) {
      slider.hidden = !showSimOnly;
      slider.style.display = showSimOnly ? '' : 'none';
    } else {
      slider.style.display = '';
    }
    const paramId = slider.dataset.param;
    const simVarId = slider.dataset.simVar;
    const simVarScale = parseFloat(slider.dataset.simVarScale || '1');
    const min = +slider.dataset.min;
    const max = +slider.dataset.max;
    const fill = slider.querySelector('.edge-slider-fill');
    const thumb = slider.querySelector('.edge-slider-thumb');
    const valueEl = slider.querySelector('.edge-slider-value');
    const sidebarSlider = simVarId ? null : document.getElementById(paramId);
    if (slider.hidden) return;
    let val = min;
    if (simVarId) {
      const simVarValue = app?.simulation?.vars?.[simVarId];
      val = Number.isFinite(simVarValue) ? (simVarValue / simVarScale) : min;
    } else {
      if (!sidebarSlider) return;
      val = +sidebarSlider.value;
    }
    const pct = Math.max(0, Math.min(1, (val - min) / (max - min)));
    fill.style.height = (pct * 100) + '%';
    thumb.style.bottom = (pct * 100) + '%';
    const fmt = _sliderFormats[simVarId || paramId];
    valueEl.textContent = fmt ? fmt(val) : val;
  });
}

// ── Initialize edge slider drag behavior ────────────────────
export function initEdgeSliders(app) {
  _edgeSliderApp = app;
  document.querySelectorAll('.edge-slider').forEach(slider => {
    const track = slider.querySelector('.edge-slider-track');
    const paramId = slider.dataset.param;
    const simVarId = slider.dataset.simVar;
    const simVarScale = parseFloat(slider.dataset.simVarScale || '1');
    const min = +slider.dataset.min;
    const max = +slider.dataset.max;

    const setFromY = (clientY) => {
      const rect = track.getBoundingClientRect();
      const pct = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const val = Math.round(min + pct * (max - min));
      if (simVarId) {
        if (!app?.simulation?.vars) return;
        app.simulation.vars[simVarId] = val * simVarScale;
        syncEdgeSliders(app);
      } else {
        const sidebarSlider = document.getElementById(paramId);
        if (!sidebarSlider) return;
        sidebarSlider.value = val;
        sidebarSlider.dispatchEvent(new Event('input'));
      }
    };

    slider.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      slider.setPointerCapture(e.pointerId);
      setFromY(e.clientY);
    });

    slider.addEventListener('pointermove', e => {
      if (slider.hasPointerCapture(e.pointerId)) {
        e.preventDefault();
        setFromY(e.clientY);
      }
    });
  });

  syncEdgeSliders(app);
}
