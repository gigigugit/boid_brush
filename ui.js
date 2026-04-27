// =============================================================================
// ui.js — Sidebar UI: collapsible sections, sliders, presets, layers
// =============================================================================

const PRESETS_KEY = 'bb_presets_v1';
const AUTOSAVE_DEBOUNCE_MS = 2000;

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
function sliderRow(id, label, min, max, value, fmt, desc) {
  const fmtFn = fmt || (v => v);
  const descHtml = desc ? `<span class="slider-desc">${desc}</span>` : '';
  return `<label>${label} <span id="v_${id}">${fmtFn(value)}</span><input type="range" id="${id}" min="${min}" max="${max}" value="${value}"></label>${descHtml}`;
}

// ── Build sidebar DOM ───────────────────────────────────────
export function buildSidebar(app) {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = `
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
      ${sliderRow('count', 'Count', 3, 200, 60)}
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

    <!-- Simulation (boid + ant) -->
    <div class="section-header" data-brushes="boid ant" data-section="simulation">Simulation <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant">
      <label>Speed <span id="v_simSpeed">1.0×</span><input type="range" id="simSpeed" min="10" max="300" value="100"></label>
      <span class="slider-desc">Playback multiplier for autonomous painting</span>
      ${sliderRow('simPointStrength', 'Point Force', 0, 200, 90, v => (v/100).toFixed(2))}
      ${sliderRow('simPointRadius', 'Point Radius', 10, 300, 120)}
      <span class="slider-desc">Spawn point, spread radius, and stamp settings continue to use the usual controls above</span>
    </div>

    <!-- Boid Simulation -->
    <div class="section-header" data-brushes="boid" data-section="boidSimulation">Boid Sim Guides <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid">
      ${sliderRow('simPathSpeed', 'Path Speed', 5, 200, 50, v => (v/20).toFixed(1) + '×')}
      <span class="slider-desc">Use the Path tool in Simulation mode to draw a guide stroke that boids follow while painting</span>
    </div>

    <!-- Ant Simulation -->
    <div class="section-header" data-brushes="ant" data-section="antSimulation">Ant Sim Guides <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="ant">
      ${sliderRow('simEdgeForce', 'Edge Force', 0, 200, 100, v => (v/100).toFixed(2))}
      ${sliderRow('simEdgeRadius', 'Avoid Radius', 0, 200, 28)}
      ${sliderRow('simPheroPaintRadius', 'Phero Radius', 2, 80, 18)}
      ${sliderRow('simPheroPaintStrength', 'Phero Paint', 0, 100, 55, v => (v/100).toFixed(2))}
      <span class="slider-desc">Use the Edge tool for barriers and the Pheromone tool to paint visible pheromone trails that ants will follow</span>
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

    <!-- Pencil / Hover (boid + bristle) -->
    <div class="section-header" data-brushes="boid bristle" data-section="pencilHover">Pencil / Hover <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid bristle">
      <label>Pencil Angle <input type="checkbox" id="pencilAngle" checked></label>
      <span class="slider-desc">Use Apple Pencil tilt/azimuth for brush angle &amp; hover spawn</span>
      ${sliderRow('pencilBlend', 'Pencil Blend', 0, 100, 80, v => (v/100).toFixed(2), 'Mix of pencil angle vs stroke direction (1 = all pencil)')}
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
      ${sliderRow('lbmSpawnCount', 'Inject', 1, 120, 16, null, 'How much pigment mass is injected at each pointer sample')}
      ${sliderRow('lbmParticleRadius', 'Seed Radius', 1, 24, 3, null, 'Radius of the seed packets used to feed the lattice')}
      ${sliderRow('lbmStrokePull', 'Stroke Pull', 0, 100, 36, v => (v / 100).toFixed(2), 'How strongly new fluid follows the stroke tangent')}
      ${sliderRow('lbmStrokeRake', 'Stroke Rake', 0, 100, 10, v => (v / 100).toFixed(2), 'How much the injected flow fans into distinct lanes')}
      ${sliderRow('lbmStrokeJitter', 'Stroke Jitter', 0, 100, 8, v => (v / 100).toFixed(2), 'How much turbulence and curl are mixed into each injection')}
      ${sliderRow('lbmHueJitter', 'Hue Jitter', 0, 180, 0, v => v + '°', 'Per-injection hue drift for painterly color variation')}
      ${sliderRow('lbmLightnessJitter', 'Light Jitter', 0, 100, 0, v => v + '%', 'Per-injection lightness drift for pigment variation')}
    </div>

    <!-- Fluid Flow (fluid only) -->
    <div class="section-header closed" data-brushes="fluid" data-section="fluidFlow">Fluid Flow <span class="chevron">▼</span></div>
    <div class="section-body collapsed" data-brushes="fluid">
      ${sliderRow('lbmViscosity', 'Viscosity', 0, 100, 76, v => (v / 100).toFixed(2), 'How resistant the lattice flow is to shearing and smearing')}
      ${sliderRow('lbmDensity', 'Density', 0, 100, 30, v => (v / 100).toFixed(2), 'How much mass each injection contributes to the fluid')}
      ${sliderRow('lbmSurfaceTension', 'Surface Tension', 0, 100, 34, v => (v / 100).toFixed(2), 'How strongly the interface holds together while it flows')}
      ${sliderRow('lbmTimeStep', 'Time Step', 1, 64, 10, v => (v / 16).toFixed(2) + '×', 'Simulation time scale per animation frame')}
      ${sliderRow('lbmSubsteps', 'Substeps', 1, 8, 2, null, 'How many solver iterations run per frame')}
    </div>

    <!-- Fluid Settling (fluid only) -->
    <div class="section-header" data-brushes="fluid" data-section="fluidSettling">Fluid Settling <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="fluid">
      ${sliderRow('lbmMotionDecay', 'Motion Slowdown', 0, 100, 62, v => (v / 100).toFixed(2), 'How quickly motion energy drains from the flow itself')}
      ${sliderRow('lbmStopSpeed', 'Stop Threshold', 0, 100, 24, v => (v / 100).toFixed(2), 'Velocity below which motion is treated as stopped')}
      ${sliderRow('lbmPigmentCarry', 'Pigment Carry', 0, 100, 44, v => (v / 100).toFixed(2), 'How long visible pigment keeps gliding once the flow slows down')}
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
      ${sliderRow('lbmResolutionScale', 'Resolution', 50, 200, 100, v => v + '%', 'Internal lattice resolution relative to the canvas')}
      ${sliderRow('lbmFluidScale', 'Fluid Scale', 35, 200, 115, v => (v / 100).toFixed(2) + '×', 'Zoom the fluid grid independently of the canvas')}
      <label>Show Flow <input type="checkbox" id="lbmShowFlow" checked></label>
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
    </div>

    <!-- Canvas Texture -->
    <div class="section-header closed" data-section="canvasTexture">Canvas Texture <span class="chevron">▼</span></div>
    <div class="section-body collapsed">
      <label>Enable <input type="checkbox" id="canvasTextureEnabled" checked></label>
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
      ${sliderRow('taperLength', 'Length', 0, 120, 0)}
      ${sliderRow('taperCurve', 'Curve', 10, 300, 100, v => (v/100).toFixed(1))}
      <label>Taper Size <input type="checkbox" id="taperSize"></label>
      <label>Taper Opac <input type="checkbox" id="taperOpacity" checked></label>
    </div>

    <!-- Sensing (boid + ant) -->
    <div class="section-header" data-brushes="boid ant" data-section="sensing">Pixel Sensing <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="boid ant">
      <label>Enable <input type="checkbox" id="sensingEnabled"></label>
      <label>Mode <select id="sensingMode"><option value="avoid">Avoid</option><option value="attract">Attract</option></select></label>
      <label>Channel <select id="sensingChannel"><option value="darkness">Darkness</option><option value="lightness">Lightness</option><option value="saturation">Saturation</option><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option><option value="alpha">Alpha</option></select></label>
      ${sliderRow('sensingStrength', 'Strength', 0, 100, 50, v => (v/100).toFixed(2))}
      ${sliderRow('sensingRadius', 'Radius', 5, 80, 20)}
      ${sliderRow('sensingThreshold', 'Threshold', 0, 100, 10, v => (v/100).toFixed(2))}
      <label>Source <select id="sensingSource"><option value="below">Below</option><option value="all">All</option><option value="active">Active</option></select></label>
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

    <!-- AI brush sidebar sections hidden until complete:

    // AI Connection (ai only)
    <div class="section-header" data-brushes="ai" data-section="aiConnection">AI Connection <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="ai">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="ai-conn-dot" id="aiSidebarDot"></span>
          <span id="aiSidebarStatus" style="color:#999;font-size:10px;">Not connected</span>
        </div>
        <button id="btnAiSetup" style="font-size:10px;">⚙ Setup</button>
      </div>
    </div>

    // AI Prompt (ai only)
    <div class="section-header" data-brushes="ai" data-section="aiPrompt">Prompt <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="ai">
      <div style="display:flex;align-items:center;gap:4px;">
        <span id="aiPromptPreview" style="flex:1;color:#bbb;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic;">paint green leaves...</span>
        <button id="btnAiPromptEdit" style="font-size:10px;flex-shrink:0;">✏ Edit</button>
      </div>
    </div>

    // AI Generation (ai only)
    <div class="section-header" data-brushes="ai" data-section="aiGeneration">Generation <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="ai">
      ${sliderRow('aiStampSize', 'Stamp Size', 20, 400, 80)}
      ${sliderRow('aiSteps', 'Steps', 1, 20, 2)}
      ${sliderRow('aiStrength', 'Strength', 1, 100, 80, v => (v/100).toFixed(2))}
      ${sliderRow('aiGuidance', 'Guidance', 10, 200, 75, v => (v/10).toFixed(1))}
      ${sliderRow('maskFeather', 'Mask Feather', 0, 100, 20)}
    </div>

    // AI Mode (ai only)
    <div class="section-header" data-brushes="ai" data-section="aiMode">Mode <span class="chevron">▼</span></div>
    <div class="section-body" data-brushes="ai">
      <label>Input Source <select id="aiInputSource">
        <option value="visible">Visible pixels</option>
        <option value="active">Active layer</option>
      </select></label>
      <label>Stamp Mode <select id="aiMode">
        <option value="continuous">Continuous</option>
        <option value="click">Click to stamp</option>
      </select></label>
      ${sliderRow('aiInterval', 'Spacing', 5, 100, 30)}
      <label>Random Seed <input type="checkbox" id="aiRandomSeed" checked></label>
      <label style="display:flex;gap:4px;align-items:center;">Seed <input type="number" id="aiSeed" value="42" min="0" max="999999999" style="width:80px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:5px;color:#ddd;padding:3px 6px;font-size:11px;"></label>
    </div>
    -->

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
      <label>Auto-save session <input type="checkbox" id="autoSaveSession"></label>
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
  sb.querySelectorAll('input[type="checkbox"], select, input[type="number"]').forEach(el => {
    el.addEventListener('change', () => app.invalidateParams());
  });

  // ── Canvas texture upload ──
  const _texFileInput = document.createElement('input');
  _texFileInput.type = 'file';
  _texFileInput.accept = 'image/*';
  _texFileInput.addEventListener('change', async () => {
    const file = _texFileInput.files[0];
    if (!file) return;
    await app.loadCanvasTexture(file);
    syncTextureUI(app);
    _texFileInput.value = '';
  });
  document.getElementById('btnUploadTexture')?.addEventListener('click', () => _texFileInput.click());
  document.getElementById('canvasTexturePreset')?.addEventListener('change', (e) => {
    app.setCanvasTextureById(e.target.value);
    syncTextureUI(app);
  });
  document.getElementById('btnClearTexture')?.addEventListener('click', () => {
    app.clearCanvasTexture();
    syncTextureUI(app);
  });

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
      localStorage.removeItem('bb_autosave');
      location.reload();
    }
  });
  // Auto-save toggle
  const autoSaveCb = document.getElementById('autoSaveSession');
  if (autoSaveCb) {
    autoSaveCb.checked = localStorage.getItem('bb_autosave') === '1';
    autoSaveCb.addEventListener('change', () => {
      localStorage.setItem('bb_autosave', autoSaveCb.checked ? '1' : '0');
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

  // Initial brush-specific visibility
  app._toggleBrushSections(app.activeBrush);

  // ── Ant Math overlay panel ──
  _buildAntMathPanel(app);

  // ── AI Diffusion: Modal, Popout, and Button wiring ──
  _initAIModal(app);
  _initAIPromptPopout(app);

  // ── AI Server live status updates ──
  if (app.aiServer) {
    app.aiServer.onChange((state) => {
      _syncModalStatus(app.aiServer);
    });
  }
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

// ── AI Setup Modal logic ────────────────────────────────────
const AI_SETTINGS_KEY = 'bb_ai_settings';

function _loadAISettings() {
  try { return JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}

function _saveAISettings(obj) {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(obj));
}

function _initAIModal(app) {
  const modal = document.getElementById('aiSetupModal');
  if (!modal) return;

  const closeModal = () => modal.classList.remove('open');
  const openModal = () => {
    modal.classList.add('open');
    // Restore saved settings
    const settings = _loadAISettings();
    const urlInput = document.getElementById('aiServerUrl');
    const backendSel = document.getElementById('aiBackendSelect');
    if (urlInput && settings.serverUrl) urlInput.value = settings.serverUrl;
    if (backendSel && settings.backend) backendSel.value = settings.backend;
    // Sync displayed status from AIServer if available
    if (app.aiServer) _syncModalStatus(app.aiServer);
  };

  // Open button in sidebar
  document.getElementById('btnAiSetup')?.addEventListener('click', openModal);

  // Close buttons
  document.getElementById('aiModalClose')?.addEventListener('click', closeModal);
  document.getElementById('aiModalBackdrop')?.addEventListener('click', closeModal);

  // Test connection button — uses live AIServer
  document.getElementById('aiTestConn')?.addEventListener('click', async () => {
    const dot = document.getElementById('aiConnDot');
    const label = document.getElementById('aiConnLabel');
    if (dot) dot.className = 'ai-conn-dot connecting';
    if (label) label.textContent = 'Connecting...';

    if (app.aiServer) {
      const url = document.getElementById('aiServerUrl')?.value || 'http://127.0.0.1:7860';
      const backend = document.getElementById('aiBackendSelect')?.value || 'builtin';
      app.aiServer.updateSettings(url, backend);
      // Wait for the health check result
      const result = await app.aiServer.checkHealth();
      _syncModalStatus(app.aiServer);
    } else {
      // No server object — show error
      setTimeout(() => {
        if (dot) dot.className = 'ai-conn-dot error';
        if (label) label.textContent = 'Connection failed — server not running';
      }, 800);
    }
  });

  // Save & Close
  document.getElementById('aiModalSave')?.addEventListener('click', () => {
    const settings = {
      backend: document.getElementById('aiBackendSelect')?.value || 'builtin',
      serverUrl: document.getElementById('aiServerUrl')?.value || 'http://127.0.0.1:7860',
    };
    _saveAISettings(settings);
    if (app.aiServer) {
      app.aiServer.updateSettings(settings.serverUrl, settings.backend);
    }
    closeModal();
    app.showToast('AI settings saved');
  });
}

function _syncModalStatus(server) {
  const dot = document.getElementById('aiConnDot');
  const label = document.getElementById('aiConnLabel');
  const sDot = document.getElementById('aiSidebarDot');
  const sLabel = document.getElementById('aiSidebarStatus');
  const stateMap = {
    connected:    { cls: 'ai-conn-dot connected',  text: 'Connected' },
    connecting:   { cls: 'ai-conn-dot connecting',  text: 'Connecting...' },
    error:        { cls: 'ai-conn-dot error',       text: 'Not connected' },
    disconnected: { cls: 'ai-conn-dot',             text: 'Not connected' },
  };
  const m = stateMap[server.state] || stateMap.disconnected;
  if (dot) dot.className = m.cls;
  if (label) {
    if (server.state === 'connected' && server.serverInfo) {
      const info = server.serverInfo;
      label.textContent = info.model ? `Connected — ${info.model} on ${info.device}` : 'Connected';
    } else {
      label.textContent = m.text;
    }
  }
  if (sDot) sDot.className = m.cls;
  if (sLabel) sLabel.textContent = m.text;
}

// ── AI Prompt Popout logic ──────────────────────────────────
const AI_PROMPTS_KEY = 'bb_ai_prompts';
const MAX_RECENT_PROMPTS = 10;

function _loadRecentPrompts() {
  try { return JSON.parse(localStorage.getItem(AI_PROMPTS_KEY) || '[]'); }
  catch { return []; }
}

function _saveRecentPrompts(arr) {
  localStorage.setItem(AI_PROMPTS_KEY, JSON.stringify(arr.slice(0, MAX_RECENT_PROMPTS)));
}

function _addRecentPrompt(text) {
  if (!text.trim()) return;
  let recent = _loadRecentPrompts();
  recent = recent.filter(p => p !== text);
  recent.unshift(text);
  _saveRecentPrompts(recent);
}

function _initAIPromptPopout(app) {
  const popout = document.getElementById('aiPromptPopout');
  const editBtn = document.getElementById('btnAiPromptEdit');
  const promptText = document.getElementById('aiPromptText');
  const negPromptText = document.getElementById('aiNegPromptText');
  const preview = document.getElementById('aiPromptPreview');
  if (!popout || !editBtn) return;

  // Restore saved prompt
  const settings = _loadAISettings();
  if (promptText && settings.prompt) promptText.value = settings.prompt;
  if (negPromptText && settings.negativePrompt) negPromptText.value = settings.negativePrompt;
  if (preview && settings.prompt) preview.textContent = settings.prompt;

  const openPopout = () => {
    // Position near the edit button
    const rect = editBtn.getBoundingClientRect();
    popout.style.top = rect.bottom + 4 + 'px';
    popout.style.right = (window.innerWidth - rect.right) + 'px';
    popout.classList.add('open');
    _renderRecentPrompts();
    promptText?.focus();
  };

  const closePopout = () => {
    popout.classList.remove('open');
    // Save prompt on close
    const prompt = promptText?.value || '';
    const negPrompt = negPromptText?.value || '';
    if (preview) preview.textContent = prompt || 'paint green leaves...';
    const settings = _loadAISettings();
    settings.prompt = prompt;
    settings.negativePrompt = negPrompt;
    _saveAISettings(settings);
    if (prompt) _addRecentPrompt(prompt);
    app.invalidateParams();
  };

  editBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (popout.classList.contains('open')) closePopout();
    else openPopout();
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!popout.contains(e.target) && e.target !== editBtn && popout.classList.contains('open')) {
      closePopout();
    }
  });

  // Prevent popout clicks from closing
  popout.addEventListener('click', e => e.stopPropagation());

  function _renderRecentPrompts() {
    const container = document.getElementById('aiRecentPrompts');
    if (!container) return;
    const recent = _loadRecentPrompts();
    container.innerHTML = '<div class="ai-recent-label">Recent</div>';
    if (recent.length === 0) return;
    for (const p of recent) {
      const div = document.createElement('div');
      div.className = 'ai-recent-prompt-item';
      div.textContent = p;
      div.addEventListener('click', () => {
        if (promptText) promptText.value = p;
        if (preview) preview.textContent = p;
      });
      container.appendChild(div);
    }
  }
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
  syncTextureUI(app);
  syncEdgeSliders();
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
  stampOpacity: v => (v / 100).toFixed(2),
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
  taperCurve: v => (v / 100).toFixed(1),
  sensingStrength: v => (v / 100).toFixed(2),
  sensingThreshold: v => (v / 100).toFixed(2),
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
  // AI diffusion
  aiStrength: v => (v / 100).toFixed(2),
  aiGuidance: v => (v / 10).toFixed(1),
  aiInterval: v => v + '%',
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
  simSpeed: v => (v / 100).toFixed(1) + '×',
  simPointStrength: v => (v / 100).toFixed(2),
  simPathSpeed: v => (v / 20).toFixed(1) + '×',
  simEdgeForce: v => (v / 100).toFixed(2),
  simPheroPaintStrength: v => (v / 100).toFixed(2),
};

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
        app.compositeAllLayers();
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
        app.compositeAllLayers();
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
    if (id === '_primaryColor') { app.primaryEl.value = val; continue; }
    if (id === '_secondaryColor') { app.secondaryEl.value = val; continue; }
    if (id === '_activeBrush') { app.setBrush(val); continue; }
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
  const presets = loadUserPresets();
  if (presets[name]) {
    if (!confirm(`Overwrite existing preset "${name}"?`)) return;
  }
  // Capture current slider values, checkboxes, selects, colors, and brush type
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
  // Also save colors and brush type
  values._primaryColor = app.primaryEl.value;
  values._secondaryColor = app.secondaryEl.value;
  values._activeBrush = app.activeBrush;
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

  syncEdgeSliders();
}
