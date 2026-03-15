// =============================================================================
// ui.js — Sidebar UI: collapsible sections, sliders, presets, layers
// =============================================================================

const PRESETS_KEY = 'bb_presets_v1';

// ── Built-in presets ────────────────────────────────────────
const BUILTIN_PRESETS = {
  'Ink Wash': { count:25,seek:40,cohesion:15,separation:50,alignment:20,jitter:0,wander:0,wanderSpeed:30,maxSpeed:8,damping:95,stampSize:6,stampOpacity:15,stampSeparation:0,fov:360,flowField:0,flowScale:10,fleeRadius:0,individuality:0,spawnRadius:50,brushScale:100 },
  'Charcoal': { count:40,seek:50,cohesion:5,separation:60,alignment:10,jitter:20,wander:10,wanderSpeed:40,maxSpeed:6,damping:90,stampSize:8,stampOpacity:8,stampSeparation:0,fov:360,flowField:0,flowScale:10,fleeRadius:0,individuality:30,spawnRadius:30,brushScale:100 },
  'Ribbon': { count:15,seek:60,cohesion:30,separation:30,alignment:40,jitter:0,wander:5,wanderSpeed:20,maxSpeed:12,damping:97,stampSize:4,stampOpacity:20,stampSeparation:5,fov:360,flowField:0,flowScale:10,fleeRadius:0,individuality:10,spawnRadius:20,brushScale:100 },
  'Galaxy': { count:80,seek:20,cohesion:40,separation:20,alignment:15,jitter:10,wander:30,wanderSpeed:50,maxSpeed:5,damping:92,stampSize:3,stampOpacity:10,stampSeparation:0,fov:360,flowField:20,flowScale:5,fleeRadius:0,individuality:50,spawnRadius:80,brushScale:100 },
  'Mist': { count:60,seek:15,cohesion:5,separation:10,alignment:5,jitter:15,wander:40,wanderSpeed:60,maxSpeed:3,damping:85,stampSize:12,stampOpacity:4,stampSeparation:0,fov:360,flowField:10,flowScale:20,fleeRadius:0,individuality:40,spawnRadius:100,brushScale:100 },
  'Edge Seeker': { count:30,seek:50,cohesion:20,separation:40,alignment:25,jitter:5,wander:10,wanderSpeed:30,maxSpeed:8,damping:93,stampSize:5,stampOpacity:18,stampSeparation:2,fov:180,flowField:0,flowScale:10,fleeRadius:0,individuality:20,spawnRadius:40,brushScale:100 },
};

function loadUserPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); }
  catch { return {}; }
}

function saveUserPresets(obj) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(obj));
}

// ── Section toggle ──────────────────────────────────────────
function toggleSection(header) {
  header.classList.toggle('closed');
  const body = header.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
}

// ── Build a slider row ──────────────────────────────────────
function sliderRow(id, label, min, max, value, fmt) {
  const fmtFn = fmt || (v => v);
  return `<label>${label} <span id="v_${id}">${fmtFn(value)}</span><input type="range" id="${id}" min="${min}" max="${max}" value="${value}"></label>`;
}

// ── Build sidebar DOM ───────────────────────────────────────
export function buildSidebar(app) {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = `
    <!-- Brush Scale -->
    <div class="section-header" data-section="brushScale">Brush Scale <span class="chevron">▼</span></div>
    <div class="section-body">
      ${sliderRow('brushScale', 'Scale', 10, 300, 100, v => (v/100).toFixed(1))}
    </div>

    <!-- Spawn Shape (boid only) -->
    <div class="section-header" data-brushes="boid" data-section="spawn">Spawn Shape <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid">
      <label>Shape <select id="spawnShape">
        <option value="circle">● Circle</option><option value="ring">◎ Ring</option>
        <option value="gaussian">☁ Gaussian</option><option value="line">═ Line</option>
        <option value="ellipse">⬮ Ellipse</option><option value="diamond">◆ Diamond</option>
        <option value="grid">▥ Grid</option><option value="sunburst">✱ Sunburst</option>
        <option value="spiral">≋ Spiral</option><option value="poisson">⁘ Poisson</option>
        <option value="random_cluster">✦ Clusters</option>
      </select></label>
      ${sliderRow('spawnRadius', 'Radius', 5, 200, 5)}
      ${sliderRow('spawnAngle', 'Angle', 0, 360, 0, v => v + '°')}
      ${sliderRow('spawnJitter', 'Jitter', 0, 100, 0, v => (v/100).toFixed(2))}
      <label>Respawn <input type="checkbox" id="respawnOnStroke" checked></label>
      <label>Press→Radius <input type="checkbox" id="pressureSpawnRadius"></label>
      <label>Flat Stroke <input type="checkbox" id="flatStroke" checked></label>
    </div>

    <!-- Swarm (boid only) -->
    <div class="section-header" data-brushes="boid" data-section="swarm">Swarm <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid">
      ${sliderRow('count', 'Count', 3, 200, 25)}
    </div>

    <!-- Forces (boid only) -->
    <div class="section-header" data-brushes="boid" data-section="forces">Forces <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid">
      ${sliderRow('seek', 'Seek', 0, 100, 40, v => (v/100).toFixed(2))}
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

    <!-- Variance (boid only) -->
    <div class="section-header closed" data-brushes="boid" data-section="variance">Variance <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="boid">
      ${sliderRow('sizeVar', 'Size Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('opacityVar', 'Opac Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('speedVar', 'Speed Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('forceVar', 'Force Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('hueVar', 'Hue Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('satVar', 'Satur Var', 0, 100, 0, v => (v/100).toFixed(2))}
      ${sliderRow('litVar', 'Light Var', 0, 100, 0, v => (v/100).toFixed(2))}
    </div>

    <!-- Motion (boid only) -->
    <div class="section-header" data-brushes="boid" data-section="motion">Motion <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid">
      ${sliderRow('maxSpeed', 'Max Speed', 1, 30, 8, v => (v/2).toFixed(1))}
      ${sliderRow('damping', 'Damping', 80, 100, 95, v => (v/100).toFixed(2))}
    </div>

    <!-- Stamp -->
    <div class="section-header" data-section="stamp">Stamp <span class="chevron">▼</span></div>
    <div class="section-body">
      ${sliderRow('stampSize', 'Size', 1, 40, 6)}
      ${sliderRow('stampOpacity', 'Opacity', 1, 100, 15, v => (v/100).toFixed(2))}
      ${sliderRow('stampSeparation', 'Separation', 0, 80, 0)}
      ${sliderRow('skipStamps', 'Skip Start', 0, 60, 0)}
      <label>Press→Size <input type="checkbox" id="pressureSize" checked></label>
      <label>Press→Opac <input type="checkbox" id="pressureOpacity" checked></label>
    </div>

    <!-- Symmetry (closed by default) -->
    <div class="section-header closed" data-section="symmetry">Symmetry <span class="chevron">▼</span></div>
    <div class="section-body collapsed">
      <label>Enable <input type="checkbox" id="symmetryEnabled"></label>
      ${sliderRow('symmetryCount', 'Count', 2, 16, 4)}
      <label>Mirror <input type="checkbox" id="symmetryMirror"></label>
      ${sliderRow('symmetryCenterX', 'Center X', 0, 100, 50, v => v + '%')}
      ${sliderRow('symmetryCenterY', 'Center Y', 0, 100, 50, v => v + '%')}
    </div>

    <!-- Taper -->
    <div class="section-header" data-section="taper">Taper <span class="chevron">▼</span></div>
    <div class="section-body">
      ${sliderRow('taperLength', 'Length', 0, 120, 0)}
      ${sliderRow('taperCurve', 'Curve', 10, 300, 100, v => (v/100).toFixed(1))}
      <label>Taper Size <input type="checkbox" id="taperSize"></label>
      <label>Taper Opac <input type="checkbox" id="taperOpacity" checked></label>
    </div>

    <!-- Sensing (boid only) -->
    <div class="section-header" data-brushes="boid" data-section="sensing">Pixel Sensing <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid">
      <label>Enable <input type="checkbox" id="sensingEnabled"></label>
      <label>Mode <select id="sensingMode"><option value="avoid">Avoid</option><option value="attract">Attract</option></select></label>
      <label>Channel <select id="sensingChannel"><option value="darkness">Darkness</option><option value="lightness">Lightness</option><option value="saturation">Saturation</option><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option><option value="alpha">Alpha</option></select></label>
      ${sliderRow('sensingStrength', 'Strength', 0, 100, 50, v => (v/100).toFixed(2))}
      ${sliderRow('sensingRadius', 'Radius', 5, 80, 20)}
      ${sliderRow('sensingThreshold', 'Threshold', 0, 100, 10, v => (v/100).toFixed(2))}
      <label>Source <select id="sensingSource"><option value="below">Below</option><option value="all">All</option><option value="active">Active</option></select></label>
    </div>

    <!-- Visual (boid only) -->
    <div class="section-header" data-brushes="boid" data-section="visual">Visual <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid">
      <label>Show Particles <input type="checkbox" id="showBoids" checked></label>
      <label>Show Spawn <input type="checkbox" id="showSpawn" checked></label>
    </div>

    <!-- Layers -->
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

    <!-- Presets -->
    <div class="section-header" data-section="presets">Presets <span class="chevron">▼</span></div>
    <div class="section-body">
      <div id="builtinPresets" style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:6px;"></div>
      <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;margin-top:4px;">
        <div style="display:flex;gap:3px;margin-bottom:4px;">
          <button id="btnSavePreset" class="save-btn">💾 Save</button>
          <button id="btnImportPreset">📥 Import</button>
          <button id="btnExportPresets">📋 Export</button>
        </div>
        <div id="userPresets"></div>
      </div>
    </div>

    <!-- Settings -->
    <div class="section-header" data-section="settings">Settings <span class="chevron">▼</span></div>
    <div class="section-body">
      <div style="display:flex;flex-direction:column;gap:3px;margin:4px 0;">
        <button id="btnSaveSession" class="save-btn">💾 Save Session</button>
        <button id="btnResetDefaults" class="reset-btn">🏭 Factory Reset</button>
      </div>
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
      syncEdgeSliders();
    };
    inp.addEventListener('input', update);
  });

  // Checkbox & select → invalidate params
  sb.querySelectorAll('input[type="checkbox"], select').forEach(el => {
    el.addEventListener('change', () => app.invalidateParams());
  });

  // ── Layer buttons ──
  document.getElementById('btnAddLayer')?.addEventListener('click', () => { app.addLayer(); _refreshLayers(app); });
  document.getElementById('btnDupLayer')?.addEventListener('click', () => { app.duplicateLayer(); _refreshLayers(app); });
  document.getElementById('btnDelLayer')?.addEventListener('click', () => { app.removeLayer(); _refreshLayers(app); });
  document.getElementById('btnLayerUp')?.addEventListener('click', () => { app.moveLayerUp(); _refreshLayers(app); });
  document.getElementById('btnLayerDown')?.addEventListener('click', () => { app.moveLayerDown(); _refreshLayers(app); });
  document.getElementById('btnMergeDown')?.addEventListener('click', () => { app.mergeDown(); _refreshLayers(app); });
  document.getElementById('btnFlatten')?.addEventListener('click', () => { app.flattenAll(); _refreshLayers(app); });

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

  // ── Preset buttons ──
  _renderBuiltinPresets(app);
  _renderUserPresets(app);
  document.getElementById('btnSavePreset')?.addEventListener('click', () => _saveNewPreset(app));
  document.getElementById('btnImportPreset')?.addEventListener('click', () => _importPreset(app));
  document.getElementById('btnExportPresets')?.addEventListener('click', () => _exportPresets());

  // Settings
  document.getElementById('btnSaveSession')?.addEventListener('click', () => {
    app.saveSession(); app.showToast('💾 Session saved');
  });
  document.getElementById('btnResetDefaults')?.addEventListener('click', () => {
    if (confirm('Reset all controls to factory defaults?')) {
      localStorage.removeItem('bb_session_v1');
      location.reload();
    }
  });

  // Initial brush-specific visibility
  app._toggleBrushSections(app.activeBrush);

  // Initial layer list
  _renderLayerList(app);
}

// ── Sync UI from app state (e.g. after session restore) ─────
export function syncUI(app) {
  // Update slider readouts
  document.querySelectorAll('#sidebar input[type="range"]').forEach(inp => {
    const span = document.getElementById('v_' + inp.id);
    if (!span) return;
    const fmt = _sliderFormats[inp.id];
    span.textContent = fmt ? fmt(+inp.value) : inp.value;
  });
  // Layer controls
  const l = app.getActiveLayer();
  if (l) {
    const be = document.getElementById('layerBlend');
    if (be) be.value = l.blend;
    const oe = document.getElementById('layerOpacity');
    if (oe) { oe.value = Math.round(l.opacity * 100); }
    const vs = document.getElementById('v_layerOpacity');
    if (vs) vs.textContent = Math.round(l.opacity * 100);
  }
  _renderLayerList(app);
  syncEdgeSliders();
}

// ── Slider display format map ───────────────────────────────
const _sliderFormats = {
  brushScale: v => (v / 100).toFixed(1),
  spawnAngle: v => v + '°',
  spawnJitter: v => (v / 100).toFixed(2),
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
  maxSpeed: v => (v / 2).toFixed(1),
  damping: v => (v / 100).toFixed(2),
  stampOpacity: v => (v / 100).toFixed(2),
  taperCurve: v => (v / 100).toFixed(1),
  sensingStrength: v => (v / 100).toFixed(2),
  sensingThreshold: v => (v / 100).toFixed(2),
  symmetryCenterX: v => v + '%',
  symmetryCenterY: v => v + '%',
};

// ── Layer list renderer ─────────────────────────────────────
function _renderLayerList(app) {
  const list = document.getElementById('layerList');
  if (!list) return;
  list.innerHTML = '';
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
        app.compositeAllLayers();
        _renderLayerList(app);
      });
      list.appendChild(div);
      return;
    }
    div.className = 'layer-item' + (i === app.activeLayerIdx ? ' active' : '');
    div.innerHTML = `
      <button class="vis-btn${l.visible ? '' : ' hidden'}" data-idx="${i}">${l.visible ? '👁' : '⬚'}</button>
      <span class="layer-name">${l.name}</span>
      <span class="layer-opacity">${Math.round(l.opacity * 100)}%</span>
    `;
    div.addEventListener('click', e => {
      if (e.target.classList.contains('vis-btn')) {
        l.visible = !l.visible;
        app.compositeAllLayers();
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
}

function _refreshLayers(app) {
  _renderLayerList(app);
  _syncLayerControls(app);
}

function _syncLayerControls(app) {
  const l = app.getActiveLayer();
  if (!l) return;
  const be = document.getElementById('layerBlend');
  if (be) be.value = l.blend;
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
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.addEventListener('click', () => _applyPreset(app, values));
    container.appendChild(btn);
  }
}

// ── User presets ────────────────────────────────────────────
function _renderUserPresets(app) {
  const container = document.getElementById('userPresets');
  if (!container) return;
  container.innerHTML = '';
  const presets = loadUserPresets();
  for (const [name, values] of Object.entries(presets)) {
    const row = document.createElement('div');
    row.className = 'preset-item';
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.addEventListener('click', () => _applyPreset(app, values));
    const del = document.createElement('button');
    del.className = 'preset-del';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      delete presets[name];
      saveUserPresets(presets);
      _renderUserPresets(app);
      app.showToast(`Deleted "${name}"`);
    });
    row.appendChild(btn);
    row.appendChild(del);
    container.appendChild(row);
  }
}

function _applyPreset(app, values) {
  for (const [id, val] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val;
  }
  app.invalidateParams();
  syncUI(app);
  app.showToast('Preset applied');
}

function _saveNewPreset(app) {
  const name = prompt('Preset name:');
  if (!name) return;
  // Capture current slider values
  const values = {};
  document.querySelectorAll('#sidebar input[type="range"]').forEach(el => {
    if (el.id) values[el.id] = +el.value;
  });
  document.querySelectorAll('#sidebar input[type="checkbox"]').forEach(el => {
    if (el.id) values[el.id] = el.checked;
  });
  document.querySelectorAll('#sidebar select').forEach(el => {
    if (el.id && el.id !== 'layerBlend') values[el.id] = el.value;
  });
  const presets = loadUserPresets();
  presets[name] = values;
  saveUserPresets(presets);
  _renderUserPresets(app);
  app.showToast(`Saved "${name}"`);
}

function _importPreset(app) {
  const raw = prompt('Paste preset JSON:');
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object') throw new Error('Invalid');
    // Determine if it's a named collection or a single preset
    const firstVal = Object.values(obj)[0];
    if (typeof firstVal === 'object' && firstVal !== null) {
      // Collection of presets
      const presets = loadUserPresets();
      Object.assign(presets, obj);
      saveUserPresets(presets);
      _renderUserPresets(app);
      app.showToast(`Imported ${Object.keys(obj).length} preset(s)`);
    } else {
      // Single preset
      const name = prompt('Name for this preset:', 'Imported');
      if (!name) return;
      const presets = loadUserPresets();
      presets[name] = obj;
      saveUserPresets(presets);
      _renderUserPresets(app);
      app.showToast(`Imported "${name}"`);
    }
  } catch (e) {
    app.showToast('Invalid JSON');
  }
}

function _exportPresets() {
  const presets = loadUserPresets();
  const json = JSON.stringify(presets, null, 2);
  navigator.clipboard.writeText(json).then(() => {
    alert('Presets copied to clipboard');
  }).catch(() => {
    prompt('Copy this JSON:', json);
  });
}

// ── Edge slider sync ────────────────────────────────────────
export function syncEdgeSliders() {
  document.querySelectorAll('.edge-slider').forEach(slider => {
    const paramId = slider.dataset.param;
    const min = +slider.dataset.min;
    const max = +slider.dataset.max;
    const fill = slider.querySelector('.edge-slider-fill');
    const thumb = slider.querySelector('.edge-slider-thumb');
    const valueEl = slider.querySelector('.edge-slider-value');
    const sidebarSlider = document.getElementById(paramId);
    if (!sidebarSlider) return;
    const val = +sidebarSlider.value;
    const pct = Math.max(0, Math.min(1, (val - min) / (max - min)));
    fill.style.height = (pct * 100) + '%';
    thumb.style.bottom = (pct * 100) + '%';
    const fmt = _sliderFormats[paramId];
    valueEl.textContent = fmt ? fmt(val) : val;
  });
}

// ── Initialize edge slider drag behavior ────────────────────
export function initEdgeSliders(app) {
  document.querySelectorAll('.edge-slider').forEach(slider => {
    const track = slider.querySelector('.edge-slider-track');
    const paramId = slider.dataset.param;
    const min = +slider.dataset.min;
    const max = +slider.dataset.max;

    const setFromY = (clientY) => {
      const rect = track.getBoundingClientRect();
      const pct = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const val = Math.round(min + pct * (max - min));
      const sidebarSlider = document.getElementById(paramId);
      if (sidebarSlider) {
        sidebarSlider.value = val;
        sidebarSlider.dispatchEvent(new Event('input'));
      }
    };

    track.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      track.setPointerCapture(e.pointerId);
      setFromY(e.clientY);
    });

    track.addEventListener('pointermove', e => {
      if (track.hasPointerCapture(e.pointerId)) {
        e.preventDefault();
        setFromY(e.clientY);
      }
    });
  });

  syncEdgeSliders();
}
