// =============================================================================
// ui.js — Sidebar UI: collapsible sections, sliders, presets, layers
// =============================================================================

export const PRESETS_KEY = 'bb_presets_v1';
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

// ── Build sidebar DOM ───────────────────────────────────────
export function buildSidebar(app) {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = `
    <div id="simBrushSessionCardHost" data-brushes="boid">
      <div class="sim-inspector-sessionBarCard">
        <div class="sim-inspector-title">Simulation Session</div>
        <div class="sim-inspector-sessionBarRow">
          <span class="sim-inspector-sessionBarLabel">Editing Session</span>
          <span id="simSidebarSessionBadge" class="sim-stage-badge muted">Unsaved Draft</span>
        </div>
        <div class="sim-inspector-sessionBarControls">
          <label class="sim-session-switcher">
            <span>Session Selector</span>
            <select id="simSidebarSessionSelect" class="sim-stage-select" disabled>
              <option value="" disabled selected>Unsaved Draft</option>
            </select>
          </label>
          <div class="sim-inspector-sessionBarActions">
            <button id="simSidebarNewDraft" type="button">New Draft</button>
            <button id="simSidebarSave" type="button">Save Draft Session</button>
            <button id="btnOpenSimulationSetup" type="button">Stage Setup</button>
            <button id="btnOpenSimulationInspector" type="button">Session Editor</button>
          </div>
        </div>
        <div id="simSidebarSessionName" class="sim-session-context-title">Simulation session: Unsaved Draft</div>
        <div id="simSidebarSessionMeta" class="sim-session-context-meta">Brush sidebar changes can be captured into the current simulation draft or saved session.</div>
      </div>
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
      <label>Enable <input type="checkbox" id="stampImageEnabled"></label>
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
      <label>Enable <input type="checkbox" id="canvasTextureEnabled" checked></label>
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
      ${sliderRow('symmetryCount', 'Count', 2, 16, 4)}
      <label>Mirror <input type="checkbox" id="symmetryMirror"></label>
      ${sliderRow('symmetryCenterX', 'Center X', 0, 100, 50, v => v + '%')}
      ${sliderRow('symmetryCenterY', 'Center Y', 0, 100, 50, v => v + '%')}
    </div>

    <!-- Taper -->
    <div class="section-header" data-section="taper">Taper <span class="chevron">▼</span></div>
    <div class="section-body">
      ${sliderRow('taperLength', 'Length', 0, 120, 20, v => +v === 0 ? 'off' : v + ' frames')}
      ${sliderRow('taperCurve', 'Curve', 10, 300, 100, v => (v/100).toFixed(1))}
      <label>Taper Size <input type="checkbox" id="taperSize" checked></label>
      <label>Taper Opac <input type="checkbox" id="taperOpacity" checked></label>
    </div>

    <!-- Sensing (boid + ant) -->
    <div class="section-header" data-brushes="boid ant" data-section="sensing">Drawing Mode Pixel Sensing <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant" data-section="sensing">
      <label>Enable <input type="checkbox" id="sensingEnabled"></label>
      <label>Mode <select id="sensingMode"><option value="avoid">Avoid</option><option value="attract">Attract</option></select></label>
      <label>Channel <select id="sensingChannel"><option value="darkness">Darkness</option><option value="lightness">Lightness</option><option value="saturation">Saturation</option><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option><option value="alpha">Alpha</option></select></label>
      ${sliderRow('sensingStrength', 'Strength', 0, 100, 50, v => (v/100).toFixed(2))}
      ${sliderRow('sensingRadius', 'Radius', 5, 80, 20)}
      ${sliderRow('sensingThreshold', 'Threshold', 0, 100, 10, v => (v/100).toFixed(2))}
      ${sliderRow('sensingUpdateFrames', 'Update Every', 1, 50, 30, v => `${Math.round(v)}f`, 'Frames between sensing refreshes for Active and All sources')}
      <label>Source <select id="sensingSource"><option value="below">Below</option><option value="all">All</option><option value="active">Active</option><option value="selected">Selected Layers</option></select></label>
      <div style="display:flex;gap:6px;align-items:flex-start;">
        <button id="sensingSourceLayersBtn" type="button" style="flex:0 0 auto;padding:6px 10px;background:rgba(58,106,232,0.18);border:1px solid rgba(58,106,232,0.3);border-radius:6px;color:#dce6ff;font-size:11px;cursor:pointer;">Pick Layers</button>
        <span id="sensingSourceLayersSummary" class="slider-desc" style="margin:0;flex:1;min-width:0;">Custom: No custom sources selected</span>
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
      <label>Always show tabs <input type="checkbox" id="alwaysShowTabs"></label>
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
        <button id="btnImportWorkspace">📥 Import Workspace</button>
        <button id="btnExportWorkspace">📤 Export Workspace</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;margin:4px 0;">
        <button id="btnSaveSession" class="save-btn">💾 Save Session</button>
        <button id="btnResetDefaults" class="reset-btn">🧼 Fresh Start</button>
      </div>
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
  sb.querySelectorAll('input[type="checkbox"], select, input[type="number"]').forEach(el => {
    el.addEventListener('change', () => app.invalidateParams());
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
  _renderBuiltinPresets(app);
  _renderUserPresets(app);
  document.getElementById('btnSavePreset')?.addEventListener('click', () => _saveNewPreset(app));
  document.getElementById('btnImportPreset')?.addEventListener('click', () => _importPreset(app));
  document.getElementById('btnExportPresets')?.addEventListener('click', () => _exportPresets(app));

  const workspaceImportInput = document.createElement('input');
  workspaceImportInput.type = 'file';
  workspaceImportInput.accept = '.json,application/json';
  workspaceImportInput.addEventListener('change', async () => {
    const file = workspaceImportInput.files?.[0];
    workspaceImportInput.value = '';
    if (!file) return;
    try {
      await app.importWorkspaceSettingsText(await file.text());
      _renderUserPresets(app);
      syncUI(app);
      app.showToast(`📥 Imported workspace from ${file.name}`);
    } catch (error) {
      console.error('Workspace settings import failed:', error);
      app.showToast('⚠ Invalid workspace file');
    }
  });

  // Settings
  document.getElementById('btnSaveSession')?.addEventListener('click', () => {
    app.saveSession(); app.showToast('💾 Session saved');
  });
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
  document.getElementById('btnImportWorkspace')?.addEventListener('click', () => {
    if (!confirm('Import workspace settings from a file and replace the current saved workspace settings?')) return;
    workspaceImportInput.click();
  });
  document.getElementById('btnExportWorkspace')?.addEventListener('click', () => {
    app.exportWorkspaceSettingsFile();
  });
  document.getElementById('perfTelemetryEnabled')?.addEventListener('change', e => {
    app.setPerformanceTelemetryEnabled(e.target.checked);
  });
  document.getElementById('perfWakeLockEnabled')?.addEventListener('change', e => {
    app.setPerformanceWakeLockEnabled(e.target.checked);
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
  // Auto-save toggle
  const autoSaveCb = document.getElementById('autoSaveSession');
  if (autoSaveCb) {
    autoSaveCb.checked = localStorage.getItem(AUTOSAVE_STORAGE_KEY) === '1';
    autoSaveCb.addEventListener('change', () => {
      localStorage.setItem(AUTOSAVE_STORAGE_KEY, autoSaveCb.checked ? '1' : '0');
      app.showToast(autoSaveCb.checked ? '⏱ Auto-save enabled' : 'Auto-save disabled');
    });
    // Debounced auto-save: save session when params change
    let _autoSaveTimer = null;
    const triggerAutoSave = () => {
      if (!autoSaveCb.checked) return;
      clearTimeout(_autoSaveTimer);
      _autoSaveTimer = setTimeout(() => app.saveSession(), AUTOSAVE_DEBOUNCE_MS);
    };
    sb.querySelectorAll('input[type="range"], input[type="checkbox"], select').forEach(el => {
      el.addEventListener('input', triggerAutoSave);
      el.addEventListener('change', triggerAutoSave);
    });
  }
  sb.querySelectorAll('input[type="range"], input[type="checkbox"], select, input[type="number"]').forEach(el => {
    el.addEventListener('input', () => app._syncActiveSimulationSessionFromDraft?.());
    el.addEventListener('change', () => app._syncActiveSimulationSessionFromDraft?.());
  });
  app._refreshPerformanceTelemetryUI(true);
  app._refreshSensingLayerSourceUi?.();
  app._syncSimulationSessionContextUi?.();

  // Initial brush-specific visibility
  app._toggleBrushSections(app.activeBrush);
  app._syncMotionPathUI?.();

  // ── Ant Math overlay panel ──
  _buildAntMathPanel(app);
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

  // Initial layer list
  _renderLayerList(app);
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
  // Update multiplier displays
  _syncMultDisplays();
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
  syncTextureUI(app);
  syncStampImageUI(app);
  syncEdgeSliders(app);
  _syncLeaderOverrideUI();
  app._refreshSensingLayerSourceUi?.();
  app._syncMotionPathUI?.();
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
    // Handle special preset keys
    if (id === '_primaryColor') { app.setColorValue?.('primary', val) ?? (app.primaryEl.value = val); continue; }
    if (id === '_secondaryColor') { app.setColorValue?.('secondary', val) ?? (app.secondaryEl.value = val); continue; }
    if (id === '_activeBrush') { app.setBrush(val); continue; }
    if (id === '_motionPath') {
      if (val && typeof val === 'object') {
        app.motionPath = {
          ...app.motionPath,
          ...structuredClone(val),
          editorOpen: false,
          previousUiState: null,
        };
        app._normalizeMotionPathState?.();
      }
      continue;
    }
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val;
  }
  app.invalidateParams();
  syncUI(app);
  app.showToast('Preset applied');
}

function _captureCurrentPresetValues(app) {
  const values = {};
  document.querySelectorAll('#sidebar input[type="range"]').forEach(el => {
    if (el.id) values[el.id] = +el.value;
  });
  document.querySelectorAll('#sidebar input[type="checkbox"]').forEach(el => {
    if (el.id && el.id !== 'autoSaveSession') values[el.id] = el.checked;
  });
  document.querySelectorAll('#sidebar select').forEach(el => {
    if (el.id && el.id !== 'layerBlend') values[el.id] = el.value;
  });
  values._primaryColor = app.primaryEl.value;
  values._secondaryColor = app.secondaryEl.value;
  values._activeBrush = app.activeBrush;
  if (app.activeBrush === 'motionPath' && app._serializeMotionPathState) {
    values._motionPath = app._serializeMotionPathState();
  }
  return values;
}

function _saveNewPreset(app) {
  const name = prompt('Preset name:');
  if (!name) return;
  const presets = loadUserPresets();
  if (presets[name]) {
    if (!confirm(`Overwrite existing preset "${name}"?`)) return;
  }
  const values = _captureCurrentPresetValues(app);
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

function _exportPresets(app) {
  const presets = loadUserPresets();
  const payload = Object.keys(presets).length ? presets : _captureCurrentPresetValues(app);
  const json = JSON.stringify(payload, null, 2);
  navigator.clipboard.writeText(json).then(() => {
    alert(Object.keys(presets).length ? 'Presets copied to clipboard' : 'Current settings copied to clipboard');
  }).catch(() => {
    prompt('Copy this JSON:', json);
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
