// =============================================================================
// app.js — Core painting application engine
//
// Manages canvases, layers, undo/redo, parameter cache, frame loop,
// session persistence, and wires all modules together.
// =============================================================================

import { Compositor, BLEND_MODE_MAP } from './compositor.js';
import { BoidBrush, AntBrush, BristleBrush, FluidBrush, SimpleBrush, EraserBrush, AIDiffusionBrush, SpawnShapes } from './brushes.js';
import { buildSidebar, buildLayersPanel, syncUI, initEdgeSliders } from './ui.js';
import { AIServer } from './ai-server.js';
import { SelectionManager } from './selection.js';
import { exportPSD, importPSD } from './psd-io.js';

const STORAGE_KEY = 'bb_session_v1';
const MAX_UNDO = 20;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const WHEEL_ZOOM_IN = 1.05;
const WHEEL_ZOOM_OUT = 0.95;
const WHEEL_ROTATION_DEG = 2;
// Pressure EMA alpha (~4-sample smoothing window for pointer events)
const PRESSURE_SMOOTH_ALPHA = 0.25;
const DEFAULT_CANVAS_TEXTURE_ID = 'builtin-paper-grain';
const PAPER_TEXTURE_FLECK_SCALE = 3.2;
const PAPER_TEXTURE_FLECK_THRESHOLD = 0.84;
const PAPER_TEXTURE_FLECK_INTENSITY = 170;
const TEXTURE_SLOPE_AMPLIFICATION = 1.8;
const TEXTURE_SMUDGE_MIN_DISTANCE = 0.35;
const TEXTURE_SMUDGE_SIZE_FACTOR = 0.14;
const TEXTURE_SMUDGE_BASE_INFLUENCE = 0.4;
const TEXTURE_SMUDGE_SLOPE_INFLUENCE = 1.4;
const TEXTURE_EDGE_BREAKUP_MIN_SIZE = 0.7;
const TEXTURE_EDGE_BREAKUP_SIZE_SCALE = 0.18;
const TEXTURE_EDGE_BREAKUP_VALLEY_SCALE = 0.14;
const TEXTURE_EDGE_FEATHER_MIN_DISTANCE = 0.6;
const TEXTURE_EDGE_FEATHER_DISTANCE_SCALE = 0.12;
const TEXTURE_EDGE_FEATHER_OPACITY_SCALE = 0.32;
const TEXTURE_CHANNEL_DEFAULTS = {
  deposit: 1,
  flow: 1,
  edgeBreakup: 0,
  smudgeDrag: 0,
  pooling: 0,
};
const SIM_SPAWN_SHAPES = [
  'circle', 'ring', 'gaussian', 'line', 'ellipse', 'diamond', 'grid',
  'sunburst', 'spiral', 'poisson', 'random_cluster', 'burst', 'lemniscate',
  'phyllotaxis', 'noise_scatter', 'bullseye', 'cross', 'wave', 'voronoi',
];
const DUPLICATE_OFFSET = 14;
const ANGLE_PRECISION = 10;
const SIM_POINT_HIT_RADIUS = 14;
const SIM_LINE_HIT_RADIUS = 12;
const SIM_DELETE_HIT_RADIUS = 10;
const DEFAULT_SIM_HARDNESS = 0.1;
const MAX_SIM_HARDNESS = 10;
const MAX_SWARM_COUNT = 2000;
const DEFAULT_PATH_STRENGTH = 0.9;
const DEFAULT_PATH_RADIUS = 40;
// Keep traveled distance bounded during long simulation runs; each path still
// wraps or ping-pongs against its own actual length when sampled.
const PATH_DISTANCE_WRAP_THRESHOLD = 1000000;
const DEFAULT_SIM_SEEK = 0;
const MAX_SIM_SESSION_NAME_LENGTH = 64;
const PERF_TELEMETRY_KEY = 'bb_perfTelemetry';
const PERF_WAKE_LOCK_KEY = 'bb_perfWakeLock';
const PERF_UI_REFRESH_MS = 500;
const PERF_SLOW_FRAME_MS = 20;
const PERF_THROTTLE_GAP_MS = 250;
const PERF_RECENT_EVENT_LIMIT = 10;
const DIRTY_TILE_SIZE = 256;
const DIRTY_TILE_MAX_COVERAGE = 0.45;

function _clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

function _wrapIndex(v, size) {
  return ((v % size) + size) % size;
}

function _radiansToDegrees(value) {
  return value * 180 / Math.PI;
}

function _degreesToRadians(value) {
  return value * Math.PI / 180;
}

function _formatAngleDegrees(value) {
  return Math.round(_radiansToDegrees(value) * ANGLE_PRECISION) / ANGLE_PRECISION;
}

function _parseAngleDegrees(value) {
  return _degreesToRadians(+value);
}

function _deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _normalizeSimulationVars(value) {
  return {
    seek: Number.isFinite(value?.seek) ? value.seek : DEFAULT_SIM_SEEK,
  };
}

function _closestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-6) return { x: ax, y: ay, distance: Math.hypot(px - ax, py - ay) };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const x = ax + dx * t;
  const y = ay + dy * t;
  return { x, y, distance: Math.hypot(px - x, py - y) };
}

/**
 * Sample a point along a polyline using an absolute traveled distance.
 * Closed paths wrap continuously; open paths ping-pong forward and backward.
 */
function _samplePolylinePoint(points, distanceAlongPath, closed = false) {
  const validPoints = Array.isArray(points)
    ? points.filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    : [];
  if (validPoints.length === 0) return null;
  if (validPoints.length === 1) return { x: validPoints[0].x, y: validPoints[0].y };
  const segments = [];
  let totalLength = 0;
  for (let i = 1; i < validPoints.length; i++) {
    const a = validPoints[i - 1];
    const b = validPoints[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 1e-6) continue;
    segments.push({ a, b, length });
    totalLength += length;
  }
  if (closed && validPoints.length > 2) {
    const a = validPoints[validPoints.length - 1];
    const b = validPoints[0];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 1e-6) {
      segments.push({ a, b, length });
      totalLength += length;
    }
  }
  if (!segments.length || totalLength <= 1e-6) return { x: validPoints[0].x, y: validPoints[0].y };

  let distance;
  if (closed) {
    distance = _wrapIndex(distanceAlongPath, totalLength);
  } else {
    const pingPongDistance = _wrapIndex(distanceAlongPath, totalLength * 2);
    distance = pingPongDistance <= totalLength ? pingPongDistance : (totalLength * 2) - pingPongDistance;
  }

  for (const segment of segments) {
    if (distance <= segment.length) {
      const t = segment.length <= 1e-6 ? 0 : distance / segment.length;
      return {
        x: _lerp(segment.a.x, segment.b.x, t),
        y: _lerp(segment.a.y, segment.b.y, t),
      };
    }
    distance -= segment.length;
  }

  const last = segments[segments.length - 1];
  return { x: last.b.x, y: last.b.y };
}

function _capitalizeTextureChannel(name) {
  return name ? name[0].toUpperCase() + name.slice(1) : '';
}

function _hashNoise2D(x, y, seed = 0) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 101.3) * 43758.5453123;
  return n - Math.floor(n);
}

function _smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function _valueNoise2D(x, y, scale, seed = 0) {
  const sx = x / scale;
  const sy = y / scale;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const tx = _smoothstep(sx - x0);
  const ty = _smoothstep(sy - y0);
  const n00 = _hashNoise2D(x0, y0, seed);
  const n10 = _hashNoise2D(x0 + 1, y0, seed);
  const n01 = _hashNoise2D(x0, y0 + 1, seed);
  const n11 = _hashNoise2D(x0 + 1, y0 + 1, seed);
  const nx0 = _lerp(n00, n10, tx);
  const nx1 = _lerp(n01, n11, tx);
  return _lerp(nx0, nx1, ty);
}

export class App {
  constructor() {
    // DOM
    this.compositeCanvas = document.getElementById('compositeDisplay');
    this.liveCanvas = document.getElementById('liveCanvas');
    this.interactionCanvas = document.getElementById('interactionCanvas');
    this.statusEl = document.getElementById('status');
    this.toastEl = document.getElementById('toast');

    // Canvas contexts
    this.lctx = null;
    this.DPR = 1;
    this.W = 0;
    this.H = 0;

    // Layers
    this.layers = [];
    this.activeLayerIdx = 0;

    // Undo/redo
    this.undoStack = [];
    this.redoStack = [];

    // Compositor
    this.compositor = null;

    // Brush engines
    this.brushes = {};
    this.sharedMotionSim = null;
    this.activeBrush = 'boid';

    // Drawing state
    this.isDrawing = false;
    this.pressure = 0.5;
    this._rawPressure = 0.5;  // unsmoothed pressure for EMA calculation
    this.tiltX = 0;       // stylus tilt in degrees (-90..90)
    this.tiltY = 0;
    this.azimuth = 0;     // stylus azimuth in radians (0..2π)
    this.altitude = Math.PI / 2; // stylus altitude (π/2 = vertical)
    this.prevAzimuth = 0;
    this.azimuthDeltaDeg = 0;
    this.azimuthUpdateCount = 0;
    this.penAngleSampleValid = false; // true once we have any real azimuth sample
    this.penEventHasAngles = false;   // true for the current/last processed pen event
    this.penAngleSource = 'none';     // 'azimuthAngle' | 'tilt' | 'none'
    this.pointerType = 'mouse';  // last pointer type ('mouse', 'pen', 'touch')
    this.leaderX = 0;
    this.leaderY = 0;
    this.undoPushedThisStroke = false;

    // Stabilizer (lazy mouse)
    this._stabX = 0;
    this._stabY = 0;

    // View transform (pinch zoom/rotate/pan)
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.viewRotation = 0; // radians
    this._pinchActive = false;
    this._pinchStartDist = 0;
    this._pinchStartAngle = 0;
    this._pinchStartZoom = 1;
    this._pinchStartRotation = 0;
    this._pinchStartPanX = 0;
    this._pinchStartPanY = 0;
    this._pinchStartMidX = 0;
    this._pinchStartMidY = 0;
    this._pinchAnchor = { x: 0, y: 0 };
    this._activePointers = new Map();

    // Flip view
    this.viewFlipped = false;

    // Tiling mode
    this.tilingMode = false;

    // Cursor preview position (screen-relative to canvasArea)
    this._cursorX = -1;
    this._cursorY = -1;

    // Taper state
    this.isTapering = false;
    this.taperFrame = 0;
    this.taperTotal = 0;
    this.strokeFrame = 0;

    // Params
    this._paramsDirty = true;
    this._cachedP = null;

    // Canvas texture
    this._builtinCanvasTextures = new Map();
    this._canvasTexture = null;
    this._customCanvasTexture = null;
    this._activeCanvasTextureId = DEFAULT_CANVAS_TEXTURE_ID;

    // Smudge: cached image data for colour sampling (invalidated each composite)
    this._smudgeImageData = null;

    // Height map for impasto (greyscale accumulation of paint thickness)
    this._heightCanvas = null;
    this._heightCtx = null;
    this._heightDirty = false;
    this._impastoOverlayCanvas = null;

    // Reusable 1×1 canvas for CSS color parsing (smudge)
    this._colorParseCanvas = document.createElement('canvas');
    this._colorParseCanvas.width = 1;
    this._colorParseCanvas.height = 1;
    this._colorParseCtx = this._colorParseCanvas.getContext('2d');
    this._sensingCompositeCanvas = null;
    this._sensingCompositeCtx = null;
    this._performanceTelemetry = this._createPerformanceTelemetryState();
    this._wakeLockSentinel = null;

    // Internal clipboard buffer (fallback when Clipboard API unavailable)
    this._clipboardBlob = null;
    this._clipboardMetadata = null;  // { x, y, w, h } bounds from selection copy

    // Tool mode ('brush' | 'rect-select' | 'ellipse-select' | 'lasso-select')
    this.activeTool = 'brush';
    this.selectionMgr = null;
    this.simulation = {
      enabled: false,
      running: false,
      paused: false,
      inspectorCollapsed: false,
      editorTool: 'spawn',
      brushData: {
        boid: { spawns: [], points: [], paths: [] },
        ant: { spawns: [], points: [], edges: [], pheromonePaths: [] },
      },
      // Scene-level variable overrides (applied during simulation playback).
      // seek defaults to 0 so boids follow guides instead of the cursor.
      vars: { seek: DEFAULT_SIM_SEEK },
      // Named saved simulation sessions.
      sessions: [],
      drawingPath: null,
      dragTarget: null,
      selected: null,
      pathDistance: 0,
      nextId: 1,
    };

    // Color
    this.primaryEl = document.getElementById('primaryColor');
    this.secondaryEl = document.getElementById('secondaryColor');
    this.bgColorEl = document.getElementById('bgColor');

    // Color history
    this._colorHistory = [];
    this._maxColorHistory = 16;

    // Frame loop
    this._rafId = null;
    this._startTime = performance.now();

    // Toast timer
    this._toastTimer = null;

    // Kick off
    this._init();
  }

  // ========================================================
  // INIT
  // ========================================================

  async _init() {
    this.selectionMgr = new SelectionManager(this);
    this._resizeAll();
    this.compositor = new Compositor(this.compositeCanvas);
    this.compositor.resize(this.W, this.H, this.DPR);
    this._addBackgroundLayer();
    this.addLayer('Layer 1');
    this._syncLayerSwitcher();
    this._syncAlphaLockUI();

    // AI server
    this.aiServer = new AIServer();

    // Brush engines
    this.brushes.boid = new BoidBrush(this);
    this.brushes.ant = new AntBrush(this);
    this.brushes.bristle = new BristleBrush(this);
    this.brushes.fluid = new FluidBrush(this);
    this.brushes.simple = new SimpleBrush(this);
    this.brushes.eraser = new EraserBrush(this);
    this.brushes.ai = new AIDiffusionBrush(this);

    // Init WASM-backed brushes
    await this.brushes.boid.init();
    await this.brushes.ant.init();
    await this.brushes.fluid.init();

    // Sidebar UI
    buildSidebar(this);
    buildLayersPanel(this);
    initEdgeSliders(this);
    this._initPerformanceTelemetry();

    // Events
    this._bindEvents();
    this._initTopbarOverflow();

    // Restore session
    await this._ensureBuiltinCanvasTexture();
    await this._restoreSession();
    // Fresh loads start with activeBrush='boid' but had not been run through
    // the normal brush activation path. Re-applying the current brush keeps
    // startup behavior consistent with choosing it from the menu.
    this.setBrush(this.activeBrush);
    this._syncSimulationUI();

    // Composite & start loop
    this.compositeAllLayers();
    this._frameLoop();

    this.setStatus('Ready');
  }

  // ========================================================
  // CANVAS MANAGEMENT
  // ========================================================

  _resizeAll() {
    if (this._docSized) {
      // Document has explicit size — don't resize to viewport
      const transformEl = document.getElementById('canvasTransform');
      if (transformEl) {
        transformEl.style.width = this.W + 'px';
        transformEl.style.height = this.H + 'px';
      }
      this.lctx = this.liveCanvas.getContext('2d', { desynchronized: true });
      this.lctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
      this._applyViewTransform();
      return;
    }
    this.DPR = window.devicePixelRatio || 1;
    const rect = document.getElementById('canvasArea').getBoundingClientRect();
    this.W = Math.floor(rect.width);
    this.H = Math.floor(rect.height);

    for (const c of [this.compositeCanvas, this.liveCanvas, this.interactionCanvas]) {
      c.width = this.W * this.DPR;
      c.height = this.H * this.DPR;
      c.style.width = this.W + 'px';
      c.style.height = this.H + 'px';
    }

    this.lctx = this.liveCanvas.getContext('2d', { desynchronized: true });
    this.lctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);

    // Resize existing layers
    for (const l of this.layers) {
      if (l.canvas.width !== this.W * this.DPR || l.canvas.height !== this.H * this.DPR) {
        const tmp = document.createElement('canvas');
        tmp.width = l.canvas.width;
        tmp.height = l.canvas.height;
        tmp.getContext('2d').drawImage(l.canvas, 0, 0);
        l.canvas.width = this.W * this.DPR;
        l.canvas.height = this.H * this.DPR;
        l.ctx = l.canvas.getContext('2d', { desynchronized: true });
        l.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
        l.ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, this.W, this.H);
      }
      l.dirty = true;
      this.compositor?.deleteLayerTex(l);
    }
    this.compositor?.resize(this.W, this.H, this.DPR);
    // Refill background layer after resize
    this._fillBackgroundLayer();

    // Resize height canvas for impasto, preserving existing paint height data
    if (!this._heightCanvas) {
      this._heightCanvas = document.createElement('canvas');
      this._heightCtx = this._heightCanvas.getContext('2d');
    }
    const targetW = this.W * this.DPR;
    const targetH = this.H * this.DPR;
    if (this._heightCanvas.width !== targetW || this._heightCanvas.height !== targetH) {
      const oldW = this._heightCanvas.width, oldH = this._heightCanvas.height;
      if (oldW > 0 && oldH > 0) {
        const tmp = document.createElement('canvas');
        tmp.width = oldW; tmp.height = oldH;
        tmp.getContext('2d').drawImage(this._heightCanvas, 0, 0);
        this._heightCanvas.width = targetW;
        this._heightCanvas.height = targetH;
        this._heightCtx.drawImage(tmp, 0, 0, oldW, oldH, 0, 0, targetW, targetH);
      } else {
        this._heightCanvas.width = targetW;
        this._heightCanvas.height = targetH;
      }
    }
    this._applyViewTransform();
  }

  async resizeDocument(newW, newH, bgColor) {
    newW = Math.max(1, Math.min(8192, Math.round(newW)));
    newH = Math.max(1, Math.min(8192, Math.round(newH)));

    this._docSized = true;
    this._docW = newW;
    this._docH = newH;

    this.DPR = 1;
    this.W = newW;
    this.H = newH;

    // Resize display canvases
    for (const c of [this.compositeCanvas, this.liveCanvas, this.interactionCanvas]) {
      c.width = newW;
      c.height = newH;
      c.style.width = newW + 'px';
      c.style.height = newH + 'px';
    }
    this.lctx = this.liveCanvas.getContext('2d', { desynchronized: true });
    this.lctx.setTransform(1, 0, 0, 1, 0, 0);

    // Resize layers (preserve content by scaling)
    for (const l of this.layers) {
      const tmp = document.createElement('canvas');
      tmp.width = l.canvas.width;
      tmp.height = l.canvas.height;
      tmp.getContext('2d').drawImage(l.canvas, 0, 0);
      l.canvas.width = newW;
      l.canvas.height = newH;
      l.ctx = l.canvas.getContext('2d', { desynchronized: true });
      l.ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, newW, newH);
      l.dirty = true;
      this.compositor?.deleteLayerTex(l);
    }

    this.compositor?.resize(newW, newH, 1);

    // Background
    if (bgColor) {
      this.bgColorEl.value = bgColor;
    }
    this._fillBackgroundLayer();

    // Height canvas
    if (this._heightCanvas) {
      const tmp = document.createElement('canvas');
      tmp.width = this._heightCanvas.width;
      tmp.height = this._heightCanvas.height;
      tmp.getContext('2d').drawImage(this._heightCanvas, 0, 0);
      this._heightCanvas.width = newW;
      this._heightCanvas.height = newH;
      this._heightCtx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, newW, newH);
    }

    // Reinit WASM sims
    try {
      if (this.brushes.boid) await this.brushes.boid.init({ force: true });
      if (this.brushes.ant) await this.brushes.ant.init({ force: true });
      if (this.brushes.fluid) await this.brushes.fluid.init({ force: true });
    } catch(e) { console.warn('WASM reinit failed:', e); }

    // Zoom to fit
    const viewRect = document.getElementById('canvasArea').getBoundingClientRect();
    const fitZoom = Math.min(viewRect.width / newW, viewRect.height / newH, 1) * 0.95;
    this.viewZoom = fitZoom;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.viewRotation = 0;
    this.viewFlipped = false;
    this._applyViewTransform();

    this._smudgeImageData = null;
    this.compositeAllLayers();
    this.showToast(`📐 Canvas: ${newW}×${newH}`);
  }

  _showCanvasSizeModal() {
    const modal = document.getElementById('canvasSizeModal');
    if (!modal) return;
    const wEl = document.getElementById('canvasSizeW');
    const hEl = document.getElementById('canvasSizeH');
    const bgEl = document.getElementById('canvasSizeBg');
    if (wEl) wEl.value = this.W;
    if (hEl) hEl.value = this.H;
    if (bgEl) bgEl.value = this.bgColorEl?.value || '#ffffff';
    modal.classList.add('open');
  }

  _hideCanvasSizeModal() {
    document.getElementById('canvasSizeModal')?.classList.remove('open');
  }

  _onCanvasSizePresetChange() {
    const preset = document.getElementById('canvasSizePreset')?.value;
    if (!preset || preset === 'custom') return;
    const [w, h] = preset.split('x').map(Number);
    const wEl = document.getElementById('canvasSizeW');
    const hEl = document.getElementById('canvasSizeH');
    if (wEl) wEl.value = w;
    if (hEl) hEl.value = h;
  }

  makeLayerCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = this.W * this.DPR;
    canvas.height = this.H * this.DPR;
    const ctx = canvas.getContext('2d', { desynchronized: true });
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    return { canvas, ctx };
  }

  _createLayerRecord(canvas, ctx, props = {}) {
    const layer = {
      canvas,
      ctx,
      visible: true,
      opacity: 1,
      blend: 'source-over',
      dirty: true,
      dirtyTiles: null,
      glTex: null,
      alphaLock: false,
      ...props,
    };
    canvas._bbLayer = layer;
    return layer;
  }

  _markLayerDirty(layer, rect = null) {
    if (!layer) return;
    if (!rect) {
      layer.dirty = true;
      layer.dirtyTiles = null;
      return;
    }
    const x0 = Math.max(0, Math.min(this.W, rect.x));
    const y0 = Math.max(0, Math.min(this.H, rect.y));
    const x1 = Math.max(0, Math.min(this.W, rect.x + rect.w));
    const y1 = Math.max(0, Math.min(this.H, rect.y + rect.h));
    if (x1 <= x0 || y1 <= y0) return;
    if (layer.dirty && !layer.dirtyTiles) return;
    layer.dirty = true;
    const tiles = layer.dirtyTiles ||= new Set();
    const minTX = Math.floor(x0 / DIRTY_TILE_SIZE);
    const maxTX = Math.floor((x1 - 1) / DIRTY_TILE_SIZE);
    const minTY = Math.floor(y0 / DIRTY_TILE_SIZE);
    const maxTY = Math.floor((y1 - 1) / DIRTY_TILE_SIZE);
    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        tiles.add(`${tx},${ty}`);
      }
    }
    const totalTilesX = Math.max(1, Math.ceil(this.W / DIRTY_TILE_SIZE));
    const totalTilesY = Math.max(1, Math.ceil(this.H / DIRTY_TILE_SIZE));
    const maxTiles = Math.max(1, Math.floor(totalTilesX * totalTilesY * DIRTY_TILE_MAX_COVERAGE));
    if (tiles.size > maxTiles) {
      layer.dirtyTiles = null;
    }
  }

  _markContextDirty(ctx, rect = null) {
    this._markLayerDirty(ctx?.canvas?._bbLayer || null, rect);
  }

  // ========================================================
  // LAYERS
  // ========================================================

  addLayer(name) {
    const { canvas, ctx } = this.makeLayerCanvas();
    this.layers.splice(this.activeLayerIdx, 0, this._createLayerRecord(canvas, ctx, {
      name: name || `Layer ${this.layers.length + 1}`,
    }));
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  getActiveLayer() { return this.layers[this.activeLayerIdx]; }

  toggleAlphaLock() {
    const layer = this.getActiveLayer();
    if (!layer) return;
    layer.alphaLock = !layer.alphaLock;
    this._syncAlphaLockUI();
    if (typeof syncUI === 'function') syncUI(this);
  }

  _syncAlphaLockUI() {
    const btn = document.getElementById('alphaLockBtn');
    if (!btn) return;
    const layer = this.getActiveLayer();
    const on = layer && layer.alphaLock;
    btn.classList.toggle('active-lock', on);
    btn.title = `Alpha Lock (/) ${on ? 'ON' : 'OFF'}`;
  }

  // ── Background layer ──────────────────────────────────────

  _addBackgroundLayer() {
    const { canvas, ctx } = this.makeLayerCanvas();
     const bgLayer = this._createLayerRecord(canvas, ctx, {
      name: 'Background', isBackground: true,
    });
    this.layers.push(bgLayer); // always last = bottom
    this._fillBackgroundLayer();
  }

  _fillBackgroundLayer() {
    const bg = this.layers.find(l => l.isBackground);
    if (!bg) return;
    const color = this.bgColorEl ? this.bgColorEl.value : '#ffffff';
    bg.ctx.save();
    bg.ctx.setTransform(1, 0, 0, 1, 0, 0);
    bg.ctx.fillStyle = color;
    bg.ctx.fillRect(0, 0, bg.canvas.width, bg.canvas.height);
    bg.ctx.restore();
    bg.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    bg.dirty = true;
  }

  setBackgroundColor(color) {
    if (this.bgColorEl) this.bgColorEl.value = color;
    this._fillBackgroundLayer();
    this.compositeAllLayers();
  }

  // ── Canvas texture ─────────────────────────────────────────

  /**
   * Build the default built-in paper texture.
   */
  _buildBuiltinPaperTextureCanvas() {
    const c = document.createElement('canvas');
    c.width = 192;
    c.height = 192;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(c.width, c.height);
    const d = img.data;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const base = 180;
        const coarse = _valueNoise2D(x, y, 38, 11);
        const medium = _valueNoise2D(x, y, 16, 29);
        const fine = _valueNoise2D(x, y, 6, 71);
        const fleck = _valueNoise2D(x, y, PAPER_TEXTURE_FLECK_SCALE, 97);
        const fiber = Math.sin((x + y * 0.18) * 0.11 + medium * 4.2) * 0.5 + 0.5;
        let grey = base
          + (coarse - 0.5) * 44
          + (medium - 0.5) * 26
          + (fine - 0.5) * 14
          + (fiber - 0.5) * 12;
        if (fleck > PAPER_TEXTURE_FLECK_THRESHOLD) {
          grey -= (fleck - PAPER_TEXTURE_FLECK_THRESHOLD) * PAPER_TEXTURE_FLECK_INTENSITY;
        }
        grey = Math.max(58, Math.min(235, Math.round(grey)));
        const off = (y * c.width + x) * 4;
        d[off] = grey;
        d[off + 1] = grey;
        d[off + 2] = grey;
        d[off + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  _createCanvasTextureRecord({ id, name, sourceType, canvas, dataUrl = null, persistDataUrl = false }) {
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    const grey = new Uint8ClampedArray(width * height);
    for (let i = 0; i < grey.length; i++) {
      const off = i * 4;
      grey[i] = Math.round(0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2]);
    }
    const flowX = new Float32Array(grey.length);
    const flowY = new Float32Array(grey.length);
    const slope = new Float32Array(grey.length);
    for (let y = 0; y < height; y++) {
      const yU = _wrapIndex(y - 1, height);
      const yD = _wrapIndex(y + 1, height);
      for (let x = 0; x < width; x++) {
        const xL = _wrapIndex(x - 1, width);
        const xR = _wrapIndex(x + 1, width);
        const i = y * width + x;
        const gx = (grey[y * width + xR] - grey[y * width + xL]) / 255;
        const gy = (grey[yD * width + x] - grey[yU * width + x]) / 255;
        const len = Math.hypot(gx, gy);
        slope[i] = Math.min(1, len * TEXTURE_SLOPE_AMPLIFICATION);
        if (len > 1e-5) {
          flowX[i] = -gx / len;
          flowY[i] = -gy / len;
        }
      }
    }
    return {
      id,
      name,
      sourceType,
      width,
      height,
      canvas,
      previewCanvas: canvas,
      previewDataUrl: canvas.toDataURL('image/png'),
      heightData: grey,
      flowX,
      flowY,
      slope,
      dataUrl: persistDataUrl ? (dataUrl || canvas.toDataURL('image/png')) : null,
    };
  }

  _setActiveCanvasTexture(texture, { silent = false } = {}) {
    this._canvasTexture = texture;
    this._activeCanvasTextureId = texture?.id || DEFAULT_CANVAS_TEXTURE_ID;
    const chk = document.getElementById('canvasTextureEnabled');
    if (chk && !chk.checked) chk.checked = true;
    this._paramsDirty = true;
    if (document.getElementById('sidebar')) syncUI(this);
    if (!silent && texture) this.showToast(`🖼 Texture: ${texture.name}`);
  }

  async _ensureBuiltinCanvasTexture() {
    if (!this._builtinCanvasTextures.has(DEFAULT_CANVAS_TEXTURE_ID)) {
      const canvas = this._buildBuiltinPaperTextureCanvas();
      const texture = this._createCanvasTextureRecord({
        id: DEFAULT_CANVAS_TEXTURE_ID,
        name: 'Paper Grain',
        sourceType: 'builtin',
        canvas,
      });
      this._builtinCanvasTextures.set(texture.id, texture);
    }
    if (!this._canvasTexture) {
      this._setActiveCanvasTexture(this._builtinCanvasTextures.get(DEFAULT_CANVAS_TEXTURE_ID), { silent: true });
    }
  }

  async _canvasFromDataUrl(dataUrl) {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return c;
  }

  async _setCustomCanvasTextureFromDataUrl(dataUrl, name = 'Custom Upload', { activate = true, silent = false } = {}) {
    const canvas = await this._canvasFromDataUrl(dataUrl);
    const texture = this._createCanvasTextureRecord({
      id: 'custom-upload',
      name,
      sourceType: 'upload',
      canvas,
      dataUrl,
      persistDataUrl: true,
    });
    this._customCanvasTexture = texture;
    if (activate) this._setActiveCanvasTexture(texture, { silent });
    else if (document.getElementById('sidebar')) syncUI(this);
    return texture;
  }

  setCanvasTextureById(id, { silent = false } = {}) {
    const texture = id === 'custom-upload'
      ? this._customCanvasTexture
      : this._builtinCanvasTextures.get(id);
    if (!texture) return false;
    this._setActiveCanvasTexture(texture, { silent });
    return true;
  }

  /**
   * Load a user-supplied image as a greyscale canvas texture tile.
   * @param {File} file - Image file (PNG, JPEG, etc.)
   */
  async loadCanvasTexture(file) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = evt => resolve(evt.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await this._setCustomCanvasTextureFromDataUrl(dataUrl, file?.name || 'Custom Upload', { silent: true });
      this.showToast('🖼 Texture loaded & enabled');
      return true;
    } catch {
      this.showToast('⚠ Texture load failed — invalid image');
      return false;
    }
  }

  clearCanvasTexture() {
    this._customCanvasTexture = null;
    this._setActiveCanvasTexture(this._builtinCanvasTextures.get(DEFAULT_CANVAS_TEXTURE_ID), { silent: true });
    this.showToast('Texture reset to built-in paper grain');
  }

  /**
   * Sample the active texture at a canvas position.
   */
  sampleTextureField(x, y, p = this._cachedP || this.getP()) {
    const tex = this._canvasTexture;
    if (!tex?.heightData || !p?.canvasTextureEnabled) {
      return { height: 0, valley: 1, flowX: 0, flowY: 0, slope: 0 };
    }
    const scale = Math.max(0.05, p.canvasTextureScale || 1);
    const theta = (p.canvasTextureRotation || 0) * Math.PI / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const tx = (x + (p.canvasTextureOffsetX || 0)) / scale;
    const ty = (y + (p.canvasTextureOffsetY || 0)) / scale;
    const u = cos * tx - sin * ty;
    const v = sin * tx + cos * ty;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const w = tex.width;
    const h = tex.height;
    const idx00 = _wrapIndex(y0, h) * w + _wrapIndex(x0, w);
    const idx10 = _wrapIndex(y0, h) * w + _wrapIndex(x1, w);
    const idx01 = _wrapIndex(y1, h) * w + _wrapIndex(x0, w);
    const idx11 = _wrapIndex(y1, h) * w + _wrapIndex(x1, w);
    const wx0 = 1 - fx;
    const wy0 = 1 - fy;
    const w00 = wx0 * wy0;
    const w10 = fx * wy0;
    const w01 = wx0 * fy;
    const w11 = fx * fy;
    let height = (
      tex.heightData[idx00] * w00 +
      tex.heightData[idx10] * w10 +
      tex.heightData[idx01] * w01 +
      tex.heightData[idx11] * w11
    ) / 255;
    if (p.canvasTextureInvert) height = 1 - height;
    let flowX = tex.flowX[idx00] * w00 + tex.flowX[idx10] * w10 + tex.flowX[idx01] * w01 + tex.flowX[idx11] * w11;
    let flowY = tex.flowY[idx00] * w00 + tex.flowY[idx10] * w10 + tex.flowY[idx01] * w01 + tex.flowY[idx11] * w11;
    const slope = tex.slope[idx00] * w00 + tex.slope[idx10] * w10 + tex.slope[idx01] * w01 + tex.slope[idx11] * w11;
    if (p.canvasTextureInvert) {
      flowX *= -1;
      flowY *= -1;
    }
    return {
      height,
      valley: 1 - height,
      flowX,
      flowY,
      slope,
    };
  }

  sampleTextureHeight(x, y, p = this._cachedP || this.getP()) {
    return this.sampleTextureField(x, y, p).height;
  }

  sampleTextureFlowVector(x, y, p = this._cachedP || this.getP()) {
    const field = this.sampleTextureField(x, y, p);
    const len = Math.hypot(field.flowX, field.flowY);
    if (len < 1e-5) return { x: 0, y: 0, slope: field.slope };
    return { x: field.flowX / len, y: field.flowY / len, slope: field.slope };
  }

  hasCanvasTexture() {
    return !!this._canvasTexture?.heightData;
  }

  getTextureInfluence(p, channel = 'deposit') {
    if (!this.hasCanvasTexture() || !p?.canvasTextureEnabled) return 0;
    const key = `canvasTexture${_capitalizeTextureChannel(channel)}`;
    const channelValue = typeof p[key] === 'number' ? p[key] : (TEXTURE_CHANNEL_DEFAULTS[channel] ?? 0);
    return _clamp01((p.canvasTextureStrength || 0) * channelValue);
  }

  getTextureDepositDensity(x, y, p = this._cachedP || this.getP()) {
    const influence = this.getTextureInfluence(p, 'deposit');
    if (influence <= 0) return 1;
    return Math.max(0.05, 1 - influence * this.sampleTextureHeight(x, y, p));
  }

  getTexturePoolingDensity(x, y, p = this._cachedP || this.getP()) {
    const influence = this.getTextureInfluence(p, 'pooling');
    if (influence <= 0) return 1;
    return Math.max(0.15, 1 - influence * this.sampleTextureHeight(x, y, p));
  }

  getTextureSmudgeOffset(x, y, size, p = this._cachedP || this.getP()) {
    const influence = this.getTextureInfluence(p, 'smudgeDrag');
    if (influence <= 0) return { x, y };
    const flow = this.sampleTextureFlowVector(x, y, p);
    const dist = Math.max(TEXTURE_SMUDGE_MIN_DISTANCE, size * TEXTURE_SMUDGE_SIZE_FACTOR)
      * influence
      * (TEXTURE_SMUDGE_BASE_INFLUENCE + flow.slope * TEXTURE_SMUDGE_SLOPE_INFLUENCE);
    return { x: x + flow.x * dist, y: y + flow.y * dist };
  }

  getTextureEdgeBreakup(x, y, p = this._cachedP || this.getP()) {
    const influence = this.getTextureInfluence(p, 'edgeBreakup');
    if (influence <= 0) return 0;
    const field = this.sampleTextureField(x, y, p);
    return _clamp01(influence * (0.3 + field.slope * 1.15 + field.height * 0.35));
  }

  getAvailableCanvasTextures() {
    const items = [...this._builtinCanvasTextures.values()].map(tex => ({
      id: tex.id,
      name: tex.name,
      sourceType: tex.sourceType,
    }));
    if (this._customCanvasTexture) {
      items.push({
        id: this._customCanvasTexture.id,
        name: this._customCanvasTexture.name,
        sourceType: this._customCanvasTexture.sourceType,
      });
    }
    return items;
  }

  getActiveCanvasTextureMeta() {
    if (!this._canvasTexture) return null;
    return {
      id: this._canvasTexture.id,
      name: this._canvasTexture.name,
      sourceType: this._canvasTexture.sourceType,
      width: this._canvasTexture.width,
      height: this._canvasTexture.height,
      previewCanvas: this._canvasTexture.previewCanvas,
      previewDataUrl: this._canvasTexture.previewDataUrl,
    };
  }

  _serializeCanvasTextureState() {
    return {
      activeId: this._activeCanvasTextureId || DEFAULT_CANVAS_TEXTURE_ID,
      custom: this._customCanvasTexture
        ? {
            name: this._customCanvasTexture.name,
            dataUrl: this._customCanvasTexture.dataUrl,
          }
        : null,
    };
  }

  async _restoreCanvasTextureState(state) {
    await this._ensureBuiltinCanvasTexture();
    if (state?.custom?.dataUrl) {
      try {
        await this._setCustomCanvasTextureFromDataUrl(state.custom.dataUrl, state.custom.name || 'Custom Upload', { activate: false });
      } catch {
        this._customCanvasTexture = null;
        this.showToast('⚠ Saved custom texture could not be restored');
      }
    }
    if (!this.setCanvasTextureById(state?.activeId || DEFAULT_CANVAS_TEXTURE_ID, { silent: true })) {
      this._setActiveCanvasTexture(this._builtinCanvasTextures.get(DEFAULT_CANVAS_TEXTURE_ID), { silent: true });
    }
  }

  setActiveLayer(idx) {
    if (idx >= 0 && idx < this.layers.length && !this.layers[idx].isBackground) {
      this.activeLayerIdx = idx;
      this._syncLayerSwitcher();
      this._syncAlphaLockUI();
    }
  }

  removeLayer() {
    const paintLayers = this.layers.filter(l => !l.isBackground);
    if (paintLayers.length <= 1) { this.showToast('Need at least 1 layer'); return; }
    const target = this.layers[this.activeLayerIdx];
    if (target.isBackground) { this.showToast('Cannot delete background'); return; }
    this.pushUndo();
    const rem = this.layers[this.activeLayerIdx];
    this.compositor?.deleteLayerTex(rem);
    this.layers.splice(this.activeLayerIdx, 1);
    if (this.activeLayerIdx >= this.layers.length) this.activeLayerIdx = this.layers.length - 1;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  duplicateLayer() {
    this.pushUndo();
    const src = this.getActiveLayer();
    const { canvas, ctx } = this.makeLayerCanvas();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(src.canvas, 0, 0);
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.layers.splice(this.activeLayerIdx, 0, this._createLayerRecord(canvas, ctx, {
      name: src.name + ' copy',
      opacity: src.opacity,
      blend: src.blend,
    }));
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  moveLayerUp() {
    if (this.activeLayerIdx <= 0) {
      this.showToast('Already at top');
      return;
    }
    this.pushUndo();
    [this.layers[this.activeLayerIdx - 1], this.layers[this.activeLayerIdx]] =
      [this.layers[this.activeLayerIdx], this.layers[this.activeLayerIdx - 1]];
    this.activeLayerIdx--;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  moveLayerDown() {
    if (this.activeLayerIdx >= this.layers.length - 1) {
      this.showToast('Already at bottom');
      return;
    }
    if (this.layers[this.activeLayerIdx + 1]?.isBackground) {
      this.showToast('Already at bottom');
      return;
    }
    this.pushUndo();
    [this.layers[this.activeLayerIdx + 1], this.layers[this.activeLayerIdx]] =
      [this.layers[this.activeLayerIdx], this.layers[this.activeLayerIdx + 1]];
    this.activeLayerIdx++;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  mergeDown() {
    if (this.activeLayerIdx >= this.layers.length - 1) { this.showToast('No layer below'); return; }
    const lower = this.layers[this.activeLayerIdx + 1];
    if (lower.isBackground) { this.showToast('Cannot merge into background'); return; }
    this.pushUndo();
    const upper = this.layers[this.activeLayerIdx];
    lower.ctx.save();
    lower.ctx.setTransform(1, 0, 0, 1, 0, 0);
    lower.ctx.globalAlpha = upper.opacity;
    lower.ctx.globalCompositeOperation = upper.blend;
    lower.ctx.drawImage(upper.canvas, 0, 0);
    lower.ctx.restore();
    lower.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.compositor?.deleteLayerTex(upper);
    lower.dirty = true;
    this.layers.splice(this.activeLayerIdx, 1);
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  flattenAll() {
    const paintLayers = this.layers.filter(l => !l.isBackground);
    if (paintLayers.length <= 1) return;
    this.pushUndo();
    const bgLayer = this.layers.find(l => l.isBackground);
    const { canvas, ctx } = this.makeLayerCanvas();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = paintLayers.length - 1; i >= 0; i--) {
      const l = paintLayers[i];
      if (!l.visible) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.blend;
      ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.restore(); ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    for (const l of paintLayers) this.compositor?.deleteLayerTex(l);
    this.layers = [this._createLayerRecord(canvas, ctx, { name: 'Flattened' })];
    if (bgLayer) this.layers.push(bgLayer);
    this.activeLayerIdx = 0;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  clearActiveLayer() {
    const l = this.getActiveLayer();
    if (l.isBackground) { this.showToast('Use BG color picker to change background'); return; }
    this.pushUndo();
    l.ctx.save();
    l.ctx.setTransform(1, 0, 0, 1, 0, 0);
    l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
    l.ctx.restore();
    l.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this._markLayerDirty(l);
    // Also clear height map when there's only one paint layer
    if (this.layers.filter(layer => !layer.isBackground).length === 1) {
      this._heightCtx?.clearRect(0, 0, this._heightCanvas.width, this._heightCanvas.height);
      this._heightDirty = true;
    }
    this.compositeAllLayers();
    this.showToast('🗑 Layer cleared');
  }

  compositeAllLayers() {
    this._smudgeImageData = null; // invalidate smudge cache
    const p = this._cachedP || this.getP();
    const forceFullComposite = !!(p.impasto && p.impastoStrength > 0);
    this.compositor?.composite(this.layers, this.W, this.H, { forceFull: forceFullComposite });

    // Impasto: recompute lighting overlay from height map when dirty, then draw
    if (p.impasto && p.impastoStrength > 0) {
      if (this._heightDirty) {
        this._impastoOverlayCanvas = this._computeImpastoOverlay(p);
        this._heightDirty = false;
      }
      if (this._impastoOverlayCanvas && this.compositeCanvas) {
        const dctx = this.compositeCanvas.getContext('2d');
        if (dctx) {
          dctx.save();
          dctx.setTransform(1, 0, 0, 1, 0, 0);
          dctx.globalCompositeOperation = 'overlay';
          dctx.globalAlpha = p.impastoStrength * 0.6;
          dctx.drawImage(this._impastoOverlayCanvas, 0, 0);
          dctx.globalAlpha = 1;
          dctx.globalCompositeOperation = 'source-over';
          dctx.restore();
        }
      }
    }
  }

  _syncLayerSwitcher() {
    const sel = document.getElementById('layerSwitcher');
    if (!sel) return;
    sel.innerHTML = '';
    this.layers.forEach((l, i) => {
      if (l.isBackground) return; // skip background in switcher
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = l.name;
      if (i === this.activeLayerIdx) opt.selected = true;
      sel.appendChild(opt);
    });
    // Also refresh sidebar layer list if it exists
    if (this._renderLayerList) this._renderLayerList();
  }

  // ========================================================
  // UNDO / REDO
  // ========================================================

  _captureState() {
    return this.layers.map(l => ({
      data: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height),
      name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend,
      isBackground: !!l.isBackground
    }));
  }

  _restoreState(state) {
    for (const l of this.layers) this.compositor?.deleteLayerTex(l);
    this.layers = state.map(s => {
      const { canvas, ctx } = this.makeLayerCanvas();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(s.data, 0, 0);
      ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
      return this._createLayerRecord(canvas, ctx, {
        name: s.name,
        visible: s.visible,
        opacity: s.opacity,
        blend: s.blend,
        isBackground: !!s.isBackground,
      });
    });
    if (this.activeLayerIdx >= this.layers.length) this.activeLayerIdx = this.layers.length - 1;
    // Ensure active layer is not the background
    if (this.layers[this.activeLayerIdx]?.isBackground) {
      this.activeLayerIdx = Math.max(0, this.activeLayerIdx - 1);
    }
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  pushUndo() {
    this.undoStack.push({ s: this._captureState(), i: this.activeLayerIdx });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  doUndo() {
    if (!this.undoStack.length) return;
    this.redoStack.push({ s: this._captureState(), i: this.activeLayerIdx });
    const u = this.undoStack.pop();
    this.activeLayerIdx = u.i;
    this._restoreState(u.s);
    this.showToast('↩ Undo');
  }

  doRedo() {
    if (!this.redoStack.length) return;
    this.undoStack.push({ s: this._captureState(), i: this.activeLayerIdx });
    const r = this.redoStack.pop();
    this.activeLayerIdx = r.i;
    this._restoreState(r.s);
    this.showToast('↪ Redo');
  }

  // ========================================================
  // PARAMETER CACHE
  // ========================================================

  invalidateParams() { this._paramsDirty = true; }

  getP() {
    if (!this._paramsDirty && this._cachedP) return this._cachedP;
    this._paramsDirty = false;

    const el = id => document.getElementById(id);
    const has = id => !!el(id);
    const val = id => { const e = el(id); return e ? +e.value : 0; };
    const numOr = (id, fallback) => {
      const e = el(id);
      return e ? +e.value : fallback;
    };
    const chk = id => { const e = el(id); return e ? e.checked : false; };
    const sel = id => { const e = el(id); return e ? e.value : ''; };
    const _MULT_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
    const mult = id => {
      const e = el(id + '_multIdx');
      const idx = e ? Math.round(+e.value) : 5;
      return _MULT_STEPS[Math.max(0, Math.min(_MULT_STEPS.length - 1, idx))];
    };

    const scale = val('brushScale') / 100;

    this._cachedP = {
      // Brush scale
      brushScale: scale,
      // Spawn
      spawnShape: sel('spawnShape') || 'circle',
      spawnRadius: Math.round(val('spawnRadius') * scale),
      spawnAngle: (val('spawnAngle') || 0) * Math.PI / 180,
      spawnJitter: val('spawnJitter') / 100,
      pressureSpawnRadius: chk('pressureSpawnRadius'),
      boidHoverAction: sel('boidHoverAction') || 'spawn',
      boidTouchAction: sel('boidTouchAction') || 'spawn',
      boidUntouchAction: sel('boidUntouchAction') || 'persist',
      boidUnhoverAction: sel('boidUnhoverAction') || 'persist',
      // Swarm
      count: Math.max(1, Math.min(MAX_SWARM_COUNT, val('count') || 60)),
      // Forces
      seek: val('seek') / 100,
      cohesion: val('cohesion') / 100,
      separation: val('separation') / 100,
      alignment: val('alignment') / 100,
      jitter: val('jitter') / 100,
      wander: val('wander') / 100,
      wanderSpeed: val('wanderSpeed') / 100,
      fov: val('fov') || 360,
      flowField: val('flowField') / 100,
      flowScale: val('flowScale') / 1000,
      fleeRadius: val('fleeRadius'),
      individuality: val('individuality') / 100,
      // Variance
      sizeVar: val('sizeVar') / 100,
      opacityVar: val('opacityVar') / 100,
      speedVar: val('speedVar') / 100,
      forceVar: val('forceVar') / 100,
      hueVar: val('hueVar') / 100,
      satVar: val('satVar') / 100,
      litVar: val('litVar') / 100,
      // Motion
      maxSpeed: val('maxSpeed') / 2,
      damping: val('damping') / 100,
      // Stamp
      stampSize: Math.max(1, Math.round(val('stampSize') * scale)),
      stampOpacity: val('stampOpacity') / 100,
      stampSeparation: val('stampSeparation'),
      skipStamps: val('skipStamps'),
      pressureSize: chk('pressureSize'),
      pressureOpacity: chk('pressureOpacity'),
      smudge: val('smudge') / 100,
      smudgeOnly: chk('smudgeOnly'),
      flatStroke: chk('flatStroke'),
      stabilizer: val('stabilizer') / 100,
      // Symmetry
      symmetryEnabled: chk('symmetryEnabled'),
      symmetryCount: val('symmetryCount') || 4,
      symmetryMirror: chk('symmetryMirror'),
      symmetryCenterX: (val('symmetryCenterX') || 50) / 100,
      symmetryCenterY: (val('symmetryCenterY') || 50) / 100,
      // Taper
      taperLength: val('taperLength'),
      taperCurve: val('taperCurve') / 100,
      taperSize: chk('taperSize'),
      taperOpacity: chk('taperOpacity'),
      // Sensing
      sensingEnabled: chk('sensingEnabled'),
      sensingMode: sel('sensingMode') || 'avoid',
      sensingChannel: sel('sensingChannel') || 'darkness',
      sensingStrength: val('sensingStrength') / 100,
      sensingRadius: val('sensingRadius'),
      sensingThreshold: val('sensingThreshold') / 100,
      sensingSource: sel('sensingSource') || 'below',
      // Visual
      showBoids: chk('showBoids'),
      showSpawn: chk('showSpawn'),
      // Bristle brush
      bristleCount: val('bristleCount') || 30,
      bristleWidth: Math.max(1, Math.round((val('bristleWidth') || 30) * scale)),
      bristleLength: Math.max(1, Math.round((val('bristleLength') || 20) * scale)),
      bristleStiffness: (val('bristleStiffness') || 50) / 100,
      bristleDamping: (val('bristleDamping') || 85) / 100,
      bristleFriction: (val('bristleFriction') || 40) / 100 * 20,
      bristleSpread: (val('bristleSpread') || 10) / 100 * 10,
      bristleSplay: (val('bristleSplay') || 30) / 100,
      bristleAngleOffset: (val('bristleAngleOffset') || 0) * Math.PI / 180,
      bristleFanEnable: chk('bristleFanEnable'),
      bristleFan: (chk('bristleFanEnable') ? val('bristleFan') : 0) || 0,
      bristleFanAngle: (val('bristleFanAngle') || 90) * Math.PI / 180,
      bristleSmoothing: (val('bristleSmoothing') || 50) / 100,
      pencilAngle: chk('pencilAngle'),
      pencilBlend: (val('pencilBlend') || 0) / 100,
      showBristles: chk('showBristles'),
      // LBM fluid brush
      lbmBrushRadius: Math.max(2, Math.round(numOr('lbmBrushRadius', 36) * scale)),
      lbmSpawnCount: numOr('lbmSpawnCount', 30),
      lbmParticleRadius: numOr('lbmParticleRadius', 3),
      lbmViscosity: numOr('lbmViscosity', 28) / 100,
      lbmDensity: numOr('lbmDensity', 30) / 100,
      lbmSurfaceTension: numOr('lbmSurfaceTension', 34) / 100,
      lbmTimeStep: numOr('lbmTimeStep', 16) / 16,
      lbmSubsteps: numOr('lbmSubsteps', 4),
      lbmMotionDecay: numOr('lbmMotionDecay', 34) / 100,
      lbmStopSpeed: numOr('lbmStopSpeed', 14) / 100,
      lbmPigmentCarry: numOr('lbmPigmentCarry', 65) / 100,
      lbmPigmentRetention: numOr('lbmPigmentRetention', 78) / 100,
      lbmResolutionScale: numOr('lbmResolutionScale', 100) / 100,
      lbmFluidScale: numOr('lbmFluidScale', 115) / 100,
      lbmStrokePull: numOr('lbmStrokePull', 36) / 100 * mult('lbmStrokePull'),
      lbmStrokeRake: numOr('lbmStrokeRake', 55) / 100 * mult('lbmStrokeRake'),
      lbmStrokeJitter: numOr('lbmStrokeJitter', 65) / 100 * mult('lbmStrokeJitter'),
      lbmHueJitter: numOr('lbmHueJitter', 0),
      lbmLightnessJitter: numOr('lbmLightnessJitter', 0),
      lbmInjectForce: numOr('lbmInjectForce', 100) / 100 * mult('lbmInjectForce'),
      lbmVortexStrength: numOr('lbmVortexStrength', 0) / 100 * mult('lbmVortexStrength'),
      lbmBurstStrength: numOr('lbmBurstStrength', 0) / 100 * mult('lbmBurstStrength'),
      lbmChevronStrength: numOr('lbmChevronStrength', 0) / 100 * mult('lbmChevronStrength'),
      lbmUndulateStrength: numOr('lbmUndulateStrength', 0) / 100 * mult('lbmUndulateStrength'),
      lbmRenderMode: sel('lbmRenderMode') || 'hybrid',
      lbmFirstPassPreview: has('lbmFirstPassPreview') ? chk('lbmFirstPassPreview') : true,
      lbmShowFlow: chk('lbmShowFlow'),
      // Bristle variance
      bSizeVar: val('bSizeVar') / 100,
      bOpacityVar: val('bOpacityVar') / 100,
      bStiffVar: val('bStiffVar') / 100,
      bLengthVar: val('bLengthVar') / 100,
      bFrictionVar: val('bFrictionVar') / 100,
      bHueVar: val('bHueVar') / 100,
      // Canvas texture
      canvasTextureEnabled: chk('canvasTextureEnabled'),
      canvasTextureStrength: val('canvasTextureStrength') / 100,
      canvasTextureScale: val('canvasTextureScale') / 100 || 1,
      canvasTextureOffsetX: (val('canvasTextureOffsetX') || 0) / 10,
      canvasTextureOffsetY: (val('canvasTextureOffsetY') || 0) / 10,
      canvasTextureRotation: val('canvasTextureRotation') || 0,
      canvasTextureInvert: chk('canvasTextureInvert'),
      canvasTextureDeposit: (val('canvasTextureDeposit') || 0) / 100,
      canvasTextureFlow: (val('canvasTextureFlow') || 0) / 100,
      canvasTextureEdgeBreakup: (val('canvasTextureEdgeBreakup') || 0) / 100,
      canvasTextureSmudgeDrag: (val('canvasTextureSmudgeDrag') || 0) / 100,
      canvasTexturePooling: (val('canvasTexturePooling') || 0) / 100,
      // Color
      color: this.primaryEl.value,
      // AI Diffusion
      aiStampSize: Math.max(20, Math.round(val('aiStampSize') * scale)) || 80,
      aiSteps: val('aiSteps') || 2,
      aiStrength: (val('aiStrength') || 80) / 100,
      aiGuidance: (val('aiGuidance') || 75) / 10,
      maskFeather: val('maskFeather') || 20,
      aiInputSource: sel('aiInputSource') || 'visible',
      aiMode: sel('aiMode') || 'continuous',
      aiInterval: val('aiInterval') || 30,
      aiRandomSeed: chk('aiRandomSeed'),
      aiSeed: +(document.getElementById('aiSeed')?.value || 42),
      aiPrompt: document.getElementById('aiPromptText')?.value || '',
      aiNegPrompt: document.getElementById('aiNegPromptText')?.value || '',
      // Trail blur
      trailBlur: val('trailBlur') || 0,
      trailFlow: val('trailFlow') / 100,
      // Kubelka-Munk pigment mixing
      kmMix: chk('kmMix'),
      kmStrength: val('kmStrength') / 100,
      // Heightmap impasto
      impasto: chk('impasto'),
      impastoStrength: val('impastoStrength') / 100,
      impastoLightAngle: val('impastoLightAngle') * Math.PI / 180,
      impastoLightElevation: val('impastoLightElevation') * Math.PI / 180,
      // Ant brush
      antFollow: val('antFollow') / 100,
      antPheromoneRate: val('antPheromoneRate') / 100,
      antPheromoneDecay: val('antPheromoneDecay') / 1000,
      antPheromoneSize: val('antPheromoneSize') || 6,
      antTrailVisible: chk('antTrailVisible'),
      antPheromoneToSensing: chk('antPheromoneToSensing'),
      // Neighbor/separation radii (ant math panel)
      neighborRadius: val('am_neighborRadius') || 80,
      separationRadius: val('am_separationRadius') || 25,
      // Simulation mode
      simSpeed: (val('simSpeed') || 100) / 100,
      simPointStrength: (val('simPointStrength') || 0) / 100,
      simPointRadius: val('simPointRadius') || 120,
      simPathSpeed: val('simPathSpeed') || 120,
      simEdgeForce: (val('simEdgeForce') || 100) / 100,
      simEdgeRadius: val('simEdgeRadius') || 28,
      simPheroPaintRadius: val('simPheroPaintRadius') || 18,
      simPheroPaintStrength: (val('simPheroPaintStrength') || 55) / 100,
    };
    return this._cachedP;
  }

  // ========================================================
  // SIMULATION MODE
  // ========================================================

  _isMotionBrush(name = this.activeBrush) {
    return name === 'boid' || name === 'ant';
  }

  _getSimulationBrushData(brush = this.activeBrush) {
    return this.simulation.brushData[brush] || null;
  }

  _getSimulationCollection(collection, brush = this.activeBrush) {
    const data = this._getSimulationBrushData(brush);
    return data && Array.isArray(data[collection]) ? data[collection] : [];
  }

  _ensureSimulationSpawns(brush = this.activeBrush) {
    const data = this._getSimulationBrushData(brush);
    if (!data) return [];
    if (!Array.isArray(data.spawns)) data.spawns = [];
    if (!data.spawns.length) {
      data.spawns.push({ id: this.simulation.nextId++, x: this.W * 0.5, y: this.H * 0.5, enabled: true });
    }
    return data.spawns;
  }

  _normalizeSimulationData() {
    for (const brush of ['boid', 'ant']) {
      const data = this._getSimulationBrushData(brush);
      if (!data) continue;

      if (!Array.isArray(data.spawns)) {
        data.spawns = data.spawn ? [data.spawn] : [];
        delete data.spawn;
      }
      data.spawns = data.spawns.map(spawn => ({
        id: spawn?.id || this.simulation.nextId++,
        x: Number.isFinite(spawn?.x) ? spawn.x : this.W * 0.5,
        y: Number.isFinite(spawn?.y) ? spawn.y : this.H * 0.5,
        enabled: spawn?.enabled !== false,
        count: Number.isFinite(spawn?.count) ? Math.max(1, Math.min(MAX_SWARM_COUNT, Math.round(spawn.count))) : undefined,
        shape: SIM_SPAWN_SHAPES.includes(spawn?.shape) ? spawn.shape : undefined,
        radius: Number.isFinite(spawn?.radius) ? Math.max(1, spawn.radius) : undefined,
        angle: Number.isFinite(spawn?.angle) ? spawn.angle : undefined,
        jitter: Number.isFinite(spawn?.jitter) ? Math.max(0, Math.min(1, spawn.jitter)) : undefined,
      }));

      if (!Array.isArray(data.points)) data.points = [];
      data.points = data.points.map(point => ({
        id: point?.id || this.simulation.nextId++,
        x: Number.isFinite(point?.x) ? point.x : this.W * 0.5,
        y: Number.isFinite(point?.y) ? point.y : this.H * 0.5,
        type: point?.type === 'repel' ? 'repel' : 'attract',
        enabled: point?.enabled !== false,
        strength: Number.isFinite(point?.strength) ? Math.max(0, point.strength) : undefined,
        radius: Number.isFinite(point?.radius) ? Math.max(1, point.radius) : undefined,
        hardness: Number.isFinite(point?.hardness) ? Math.max(DEFAULT_SIM_HARDNESS, Math.min(MAX_SIM_HARDNESS, point.hardness)) : undefined,
      }));

      if (brush === 'boid') {
        const legacyPaths = [];
        if (Array.isArray(data.path) && data.path.length >= 2) legacyPaths.push({ points: data.path });
        if (Array.isArray(data.paths)) legacyPaths.push(...data.paths);
        data.paths = legacyPaths.map(pathItem => ({
          id: pathItem?.id || this.simulation.nextId++,
          enabled: pathItem?.enabled !== false,
          points: Array.isArray(pathItem?.points)
            ? pathItem.points
                .filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
                .map(pt => ({ x: pt.x, y: pt.y }))
            : [],
          strength: Number.isFinite(pathItem?.strength) ? Math.max(0, pathItem.strength) : undefined,
          radius: Number.isFinite(pathItem?.radius) ? Math.max(1, pathItem.radius) : undefined,
          closed: !!pathItem?.closed,
        })).filter(pathItem => pathItem.points.length >= 2);
        delete data.path;
      }

      if (brush === 'ant') {
        if (!Array.isArray(data.edges)) data.edges = [];
        data.edges = data.edges.map(edge => ({
          id: edge?.id || this.simulation.nextId++,
          enabled: edge?.enabled !== false,
          points: Array.isArray(edge?.points)
            ? edge.points
                .filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
                .map(pt => ({ x: pt.x, y: pt.y }))
            : [],
          strength: Number.isFinite(edge?.strength) ? Math.max(0, edge.strength) : undefined,
          radius: Number.isFinite(edge?.radius) ? Math.max(0, edge.radius) : undefined,
        })).filter(edge => edge.points.length >= 2);

        if (!Array.isArray(data.pheromonePaths)) data.pheromonePaths = [];
        data.pheromonePaths = data.pheromonePaths.map(pathItem => ({
          id: pathItem?.id || this.simulation.nextId++,
          enabled: pathItem?.enabled !== false,
          points: Array.isArray(pathItem?.points)
            ? pathItem.points
                .filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
                .map(pt => ({ x: pt.x, y: pt.y }))
            : [],
          radius: Number.isFinite(pathItem?.radius) ? Math.max(1, pathItem.radius) : undefined,
          intensity: Number.isFinite(pathItem?.intensity) ? Math.max(0, Math.min(1, pathItem.intensity)) : undefined,
        })).filter(pathItem => pathItem.points.length >= 2);
      }
    }

    if (this.simulation.selected && !this._getSelectedSimulationEntry()) {
      this.simulation.selected = null;
    }
  }

  _resolveSimulationSpawnConfig(spawn, p = this.getP()) {
    return {
      count: Number.isFinite(spawn?.count) ? Math.max(1, Math.min(MAX_SWARM_COUNT, Math.round(spawn.count))) : p.count,
      shape: spawn?.shape || p.spawnShape,
      radius: Number.isFinite(spawn?.radius) ? Math.max(1, spawn.radius) : p.spawnRadius,
      angle: Number.isFinite(spawn?.angle) ? spawn.angle : p.spawnAngle,
      jitter: Number.isFinite(spawn?.jitter) ? Math.max(0, Math.min(1, spawn.jitter)) : p.spawnJitter,
    };
  }

  _resolveSimulationPointConfig(point, p = this.getP()) {
    return {
      strength: Number.isFinite(point?.strength) ? Math.max(0, point.strength) : p.simPointStrength,
      radius: Number.isFinite(point?.radius) ? Math.max(1, point.radius) : p.simPointRadius,
      hardness: Number.isFinite(point?.hardness) ? Math.max(DEFAULT_SIM_HARDNESS, Math.min(MAX_SIM_HARDNESS, point.hardness)) : 1,
    };
  }

  _resolveSimulationPathConfig(pathItem, p = this.getP()) {
    return {
      strength: Number.isFinite(pathItem?.strength) ? Math.max(0, pathItem.strength) : DEFAULT_PATH_STRENGTH,
      radius: Number.isFinite(pathItem?.radius) ? Math.max(1, pathItem.radius) : DEFAULT_PATH_RADIUS,
      closed: !!pathItem?.closed,
    };
  }

  _getAnimatedSimulationPathTarget(pathItem, p = this.getP()) {
    if (!pathItem?.points?.length) return null;
    const config = this._resolveSimulationPathConfig(pathItem, p);
    const point = _samplePolylinePoint(pathItem.points, this.simulation.pathDistance, config.closed);
    return point ? { x: point.x, y: point.y, config, pathItem } : null;
  }

  _resolveSimulationEdgeConfig(edge, p = this.getP()) {
    return {
      strength: Number.isFinite(edge?.strength) ? Math.max(0, edge.strength) : p.simEdgeForce,
      radius: Number.isFinite(edge?.radius) ? Math.max(0, edge.radius) : p.simEdgeRadius,
    };
  }

  _resolveSimulationPheromoneConfig(pathItem, p = this.getP()) {
    return {
      radius: Number.isFinite(pathItem?.radius) ? Math.max(1, pathItem.radius) : p.simPheroPaintRadius,
      intensity: Number.isFinite(pathItem?.intensity) ? Math.max(0, Math.min(1, pathItem.intensity)) : p.simPheroPaintStrength,
    };
  }

  _getSimulationSpawnCenter(brush = this.activeBrush) {
    const allSpawns = this._ensureSimulationSpawns(brush);
    const spawns = allSpawns.filter(spawn => spawn.enabled !== false);
    const activeSpawns = spawns.length ? spawns : allSpawns;
    if (!activeSpawns.length) return { x: this.W * 0.5, y: this.H * 0.5 };
    let sx = 0;
    let sy = 0;
    for (const spawn of activeSpawns) {
      sx += spawn.x;
      sy += spawn.y;
    }
    return { x: sx / activeSpawns.length, y: sy / activeSpawns.length };
  }

  _setSimulationSelection(selection) {
    this.simulation.selected = selection
      ? {
          brush: this.activeBrush,
          collection: selection.collection,
          kind: selection.kind,
          id: selection.target?.id ?? selection.id,
        }
      : null;
    this._renderSimulationInspector();
  }

  _getSelectedSimulationEntry() {
    const sel = this.simulation.selected;
    if (!sel || sel.brush !== this.activeBrush) return null;
    const items = this._getSimulationCollection(sel.collection);
    const target = items.find(item => item.id === sel.id);
    return target ? { ...sel, target } : null;
  }

  _getSimulationAnchor(item) {
    if (Array.isArray(item?.points) && item.points.length) {
      return item.points[Math.floor(item.points.length / 2)];
    }
    return item ? { x: item.x, y: item.y } : { x: this.W * 0.5, y: this.H * 0.5 };
  }

  _translateSimulationTarget(target, dx, dy) {
    if (!target) return;
    if (Array.isArray(target.points)) {
      for (const pt of target.points) {
        pt.x += dx;
        pt.y += dy;
      }
      return;
    }
    target.x += dx;
    target.y += dy;
  }

  _duplicateSelectedSimulationItem() {
    const entry = this._getSelectedSimulationEntry();
    if (!entry) return;
    const items = this._getSimulationCollection(entry.collection);
    const clone = _deepClone(entry.target);
    clone.id = this.simulation.nextId++;
    if (Array.isArray(clone.points)) {
      clone.points = clone.points.map(pt => ({ x: pt.x + DUPLICATE_OFFSET, y: pt.y + DUPLICATE_OFFSET }));
    } else {
      clone.x += DUPLICATE_OFFSET;
      clone.y += DUPLICATE_OFFSET;
    }
    items.push(clone);
    this._setSimulationSelection({ collection: entry.collection, kind: entry.kind, target: clone });
    this._maybeAutoSaveSession();
    this.showToast('Simulation item duplicated');
  }

  _openSimulationHelp() {
    document.getElementById('simHelpModal')?.classList.add('open');
  }

  _closeSimulationHelp() {
    document.getElementById('simHelpModal')?.classList.remove('open');
  }

  _maybeAutoSaveSession() {
    if (document.getElementById('autoSaveSession')?.checked) this.saveSession();
  }

  _newSimulationSession() {
    this.simulation.vars = _normalizeSimulationVars();
    this.simulation.brushData = {
      boid: { spawns: [], points: [], paths: [] },
      ant: { spawns: [], points: [], edges: [], pheromonePaths: [] },
    };
    this.simulation.nextId = 1;
    this.simulation.selected = null;
    this._ensureSimulationSpawns();
    this._renderSimulationInspector();
    this.saveSession();
    this.showToast('New simulation session started');
  }

  _saveSimulationSession() {
    const defaultName = `Session ${this.simulation.sessions.length + 1}`;
    const rawName = window.prompt('Name for this simulation session:', defaultName);
    if (!rawName) return;
    const name = rawName.trim().slice(0, MAX_SIM_SESSION_NAME_LENGTH) || defaultName;
    this.simulation.sessions.push({
      name,
      savedAt: Date.now(),
      vars: _normalizeSimulationVars(this.simulation.vars),
      brushData: _deepClone(this.simulation.brushData),
      nextId: this.simulation.nextId,
    });
    this._renderSimulationInspector();
    this.saveSession();
    this.showToast(rawName.trim().length > MAX_SIM_SESSION_NAME_LENGTH ? `Saved "${name}" (trimmed)` : `Saved "${name}"`);
  }

  _loadSimulationSession(index) {
    const session = this.simulation.sessions[index];
    if (!session) return;
    this.simulation.vars = _normalizeSimulationVars(session.vars);
    this.simulation.brushData = _deepClone(session.brushData);
    this.simulation.nextId = session.nextId || this.simulation.nextId;
    this.simulation.selected = null;
    this._normalizeSimulationData();
    this._ensureSimulationSpawns();
    this._renderSimulationInspector();
    this.saveSession();
    this.showToast(`Loaded "${session.name}"`);
  }

  _deleteSimulationSavedSession(index) {
    const session = this.simulation.sessions[index];
    if (!session) return;
    if (!window.confirm(`Delete saved simulation session "${session.name}"?`)) return;
    this.simulation.sessions.splice(index, 1);
    this._renderSimulationInspector();
    this.saveSession();
    this.showToast(`Deleted "${session.name}"`);
  }


  _renderSimulationInspector() {
    const panel = document.getElementById('simOverlaySidebar');
    if (!panel) return;
    const open = this.simulation.enabled && this._isMotionBrush() && !this.simulation.inspectorCollapsed;
    panel.classList.toggle('open', open);
    if (!open) {
      panel.innerHTML = '';
      return;
    }

    const data = this._getSimulationBrushData();
    if (!data) {
      panel.innerHTML = '';
      return;
    }
    const selected = this._getSelectedSimulationEntry();
    if (this.simulation.selected && !selected) this.simulation.selected = null;
    const p = this.getP();
    const isBoid = this.activeBrush === 'boid';
    const pointItems = data.points || [];
    const attractPoints = [];
    const repelPoints = [];
    for (const point of pointItems) {
      if (point?.type === 'repel') repelPoints.push(point);
      else attractPoints.push(point);
    }
    const groups = [
      { collection: 'spawns', kind: 'spawn', label: 'Spawn', items: data.spawns || [] },
      { collection: 'points', kind: 'point', label: 'Attract Point', items: attractPoints },
      { collection: 'points', kind: 'point', label: 'Repel Point', items: repelPoints },
      ...(isBoid ? [{ collection: 'paths', kind: 'path', label: 'Path Guide', items: data.paths || [] }] : []),
      ...(!isBoid ? [{ collection: 'edges', kind: 'edge', label: 'Edge Barrier', items: data.edges || [] }] : []),
      ...(!isBoid ? [{ collection: 'pheromonePaths', kind: 'pheromonePath', label: 'Pheromone Trail', items: data.pheromonePaths || [] }] : []),
    ];
    const describeSimulationItem = (group, item, idx) => {
      const parts = [`${group.label} ${idx + 1}`];
      if (group.kind === 'spawn') {
        if (item.shape) parts.push(item.shape);
      } else if (group.kind === 'path') {
        parts.push(item.closed ? 'Closed' : 'Open');
      }
      if (item.enabled === false) parts.push('Off');
      return parts.join(' · ');
    };
    const summaryButtons = groups.map(group => {
      if (!group.items.length) return '';
      return `<div class="sim-inspector-group"><h3>${_escapeHtml(group.label)}s</h3><div class="sim-inspector-list">${group.items.map((item, idx) => `
        <button data-sim-select="1" data-sim-collection="${group.collection}" data-sim-kind="${group.kind}" data-sim-id="${item.id}" class="${selected?.id === item.id && selected?.collection === group.collection ? 'active' : ''}">
          ${_escapeHtml(describeSimulationItem(group, item, idx))}
        </button>`).join('')}</div></div>`;
    }).join('');

    const clearSelectionBtn = selected ? '<button data-sim-clear-selection="1">Clear Selection</button>' : '';

    const seekPct = Math.round((Number.isFinite(this.simulation.vars.seek) ? this.simulation.vars.seek : DEFAULT_SIM_SEEK) * 100);
    const savedSessionsList = this.simulation.sessions.length
      ? `<div class="sim-inspector-note" style="margin-top:8px"><strong>Saved sessions:</strong></div>
         <div class="sim-inspector-list" style="margin-top:6px">${this.simulation.sessions.map((s, i) =>
            `<button data-sim-load-session="${i}" aria-label="Load saved session ${_escapeHtml(s.name)}">${_escapeHtml(s.name)}</button>
             <button class="danger" data-sim-del-session="${i}" aria-label="Delete saved session ${_escapeHtml(s.name)}" style="padding:6px 7px">×</button>`
         ).join('')}</div>`
      : '';

    let inspector = `
      <div class="sim-inspector-header">
        <div>
          <div class="sim-inspector-title">Simulation Inspector</div>
          <div class="sim-inspector-subtitle">${isBoid ? 'Boid' : 'Ant'} simulation overrides live here.</div>
        </div>
        <div class="sim-inspector-actions">
          <button data-sim-collapse="1">Collapse</button>
          <button data-sim-clear-canvas="1">Clear Canvas</button>
          ${clearSelectionBtn}
          <button data-sim-help="1">Help</button>
        </div>
      </div>
      <div class="sim-inspector-group">
        <h3>Scene</h3>
        <div class="sim-inspector-note">Current tool: <strong>${this.simulation.editorTool}</strong> · Playback speed <strong>${p.simSpeed.toFixed(2)}×</strong> (shown for reference from the brush sidebar). Brush sidebar values stay untouched; item values only override when explicitly set here.</div>
      </div>
      <div class="sim-inspector-group">
        <h3>Scene Variables</h3>
        <div class="sim-inspector-note">Override brush parameters for simulation playback. <strong>Seek</strong> defaults to 0 so agents follow guides instead of the cursor. Values persist when reopening simulation.</div>
        <div class="sim-inspector-row" style="flex-direction:column;align-items:stretch">
          <label style="display:flex;justify-content:space-between">
            <span>Seek (cursor pull)</span><span class="sim-inspector-value" data-sim-var-label="seek">${seekPct}%</span>
          </label>
          <input type="range" min="0" max="100" step="0.5" value="${seekPct}" data-sim-var="seek" style="margin-top:4px">
        </div>
        <div class="sim-inspector-actions" style="margin-top:10px">
          <button data-sim-new-session="1">New Session</button>
          <button data-sim-save-session="1">Save Session</button>
        </div>
        ${savedSessionsList}
      </div>
      ${summaryButtons}
    `;

    if (!selected) {
      inspector += `
        <div class="sim-inspector-group">
          <h3>No Selection</h3>
          <div class="sim-inspector-note">Select a spawn, ${isBoid ? 'attract point, repel point, or path guide' : 'attract point, repel point, edge barrier, or pheromone trail'} on the canvas or from the lists above to edit its per-item overrides.</div>
        </div>
      `;
    } else {
      const target = selected.target;
      const checked = target.enabled !== false ? 'checked' : '';

      // Helper: render a slider row for a numeric override field.
      // Slider value = stored value / scale  (e.g. scale=0.01 → slider 0-200 maps to stored 0-2.0).
      // When the field is not set on target, shows "Brush def." and places thumb at midpoint.
      const simSlider = (field, type, label, min, max, step, scale, showNumberInput = false) => {
        const raw = target[field];
        const isSet = Number.isFinite(raw);
        let sliderVal;
        if (isSet) {
          sliderVal = type === 'angle'
            ? Math.round(_formatAngleDegrees(raw))
            : Math.round(raw / scale);
        } else {
          sliderVal = Math.round((+min + +max) / 2);
        }
        const fmtStored = v => {
          if (type === 'angle') return v + '°';
          if (type === 'integer') return String(Math.round(v));
          return scale < 1 ? v.toFixed(2) : v.toFixed(1);
        };
        const displayVal = isSet
          ? fmtStored(type === 'angle' ? sliderVal : sliderVal * scale)
          : 'Brush def.';
        const unset = isSet ? '' : ' data-sim-unset="1"';
        const resetOpacity = isSet ? '' : ' style="opacity:0.35"';
        const inputVal = isSet
          ? (type === 'angle' ? Math.round(_formatAngleDegrees(raw)) : (type === 'integer' ? Math.round(raw) : raw))
          : '';
        return `<div class="sim-slider-row">
          <div class="sim-slider-header">
            <span class="sim-slider-label">${label}</span>
            <div class="sim-slider-meta">
              <span class="sim-inspector-value" data-sim-val-label="${field}">${displayVal}</span>
              <button class="sim-fld-reset" data-sim-reset="${field}" title="Clear override"${resetOpacity}>×</button>
            </div>
          </div>
          <div class="sim-slider-controls">
            <input type="range" min="${min}" max="${max}" step="${step}" value="${sliderVal}"
                   data-sim-field="${field}" data-sim-type="${type}" data-sim-scale="${scale}"${unset}>
            ${showNumberInput
              ? `<input type="number" min="${min}" max="${max}" step="${step}" value="${inputVal}" placeholder="Brush def."
                   data-sim-field="${field}" data-sim-type="${type}" data-sim-scale="${scale}"${unset}>`
              : ''}
          </div>
        </div>`;
      };

      let rows = `
        <div class="sim-inspector-group">
          <h3>Selected ${selected.kind === 'point' ? target.type : selected.kind}</h3>
          <div class="sim-inspector-row">
            <label>Enabled</label>
            <input type="checkbox" data-sim-field="enabled" data-sim-type="bool" ${checked}>
          </div>
          <div class="sim-inspector-actions">
            <button data-sim-duplicate="1">Duplicate</button>
            <button class="danger" data-sim-delete="1">Delete</button>
          </div>
        </div>
      `;
      if (selected.kind === 'spawn') {
        rows += `
          <div class="sim-inspector-group">
            <h3>Spawn Overrides</h3>
            <div class="sim-inspector-note">Move a slider to override; press × to restore brush default.</div>
            ${simSlider('count', 'integer', 'Count', 1, MAX_SWARM_COUNT, 1, 1, true)}
            <div class="sim-inspector-row"><label>Shape<select data-sim-field="shape" data-sim-type="select">
              <option value="">Brush default</option>
              ${SIM_SPAWN_SHAPES.map(shape => `<option value="${shape}" ${target.shape === shape ? 'selected' : ''}>${shape}</option>`).join('')}
            </select></label></div>
            ${simSlider('radius', 'integer', 'Radius', 1, 300, 1, 1)}
            ${simSlider('angle', 'angle', 'Angle', -180, 180, 1, 1)}
            ${simSlider('jitter', 'number', 'Jitter', 0, 100, 1, 0.01)}
          </div>`;
      } else if (selected.kind === 'point') {
        rows += `
          <div class="sim-inspector-group">
            <h3>${target.type === 'repel' ? 'Repulsion' : 'Attraction'} Overrides</h3>
            <div class="sim-inspector-note">Move a slider to override; press × to restore brush default.</div>
            ${simSlider('strength', 'number', 'Strength', 0, 200, 5, 0.01)}
            ${simSlider('radius', 'integer', 'Radius', 1, 300, 1, 1)}
            ${target.type === 'repel' ? simSlider('hardness', 'number', 'Hardness', 1, 100, 5, 0.1) : ''}
          </div>`;
      } else if (selected.kind === 'path') {
        rows += `
          <div class="sim-inspector-group">
            <h3>Path Attraction</h3>
            <div class="sim-inspector-note">Each enabled path animates its own attraction point along the stroke. Strength and radius apply to that moving guide point.</div>
            ${simSlider('strength', 'number', 'Strength', 0, 200, 5, 0.01)}
            ${simSlider('radius', 'integer', 'Radius', 1, 300, 1, 1)}
            <div class="sim-inspector-row"><label>Closed</label><input type="checkbox" data-sim-field="closed" data-sim-type="bool" ${target.closed ? 'checked' : ''}></div>
          </div>`;
      } else if (selected.kind === 'edge') {
        rows += `
          <div class="sim-inspector-group">
            <h3>Edge Barrier</h3>
            <div class="sim-inspector-note">Move a slider to override; press × to restore brush default.</div>
            ${simSlider('strength', 'number', 'Force', 0, 200, 5, 0.01)}
            ${simSlider('radius', 'integer', 'Radius', 0, 300, 1, 1)}
          </div>`;
      } else if (selected.kind === 'pheromonePath') {
        rows += `
          <div class="sim-inspector-group">
            <h3>Pheromone Trail</h3>
            <div class="sim-inspector-note">Move a slider to override; press × to restore brush default.</div>
            ${simSlider('radius', 'integer', 'Radius', 1, 80, 1, 1)}
            ${simSlider('intensity', 'number', 'Intensity', 0, 100, 5, 0.01)}
          </div>`;
      }
      inspector += rows;
    }

    panel.innerHTML = inspector;

    panel.querySelectorAll('[data-sim-select]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._setSimulationSelection({
          collection: btn.dataset.simCollection,
          kind: btn.dataset.simKind,
          id: +btn.dataset.simId,
        });
      });
    });
    panel.querySelector('[data-sim-collapse]')?.addEventListener('click', () => {
      this.simulation.inspectorCollapsed = true;
      this._syncSimulationUI();
    });
    panel.querySelector('[data-sim-clear-canvas]')?.addEventListener('click', () => this.clearActiveLayer());
    panel.querySelector('[data-sim-help]')?.addEventListener('click', () => this._openSimulationHelp());
    panel.querySelector('[data-sim-clear-selection]')?.addEventListener('click', () => this._setSimulationSelection(null));
    panel.querySelector('[data-sim-duplicate]')?.addEventListener('click', () => this._duplicateSelectedSimulationItem());
    panel.querySelector('[data-sim-delete]')?.addEventListener('click', () => {
      const entry = this._getSelectedSimulationEntry();
      if (entry) this._deleteSimulationItem(entry);
    });
    panel.querySelectorAll('[data-sim-field]').forEach(el => {
      const field = el.dataset.simField;
      const type = el.dataset.simType || 'number';
      const scale = parseFloat(el.dataset.simScale || '1');

      // Write the current control value into target (no re-render).
      const writeField = () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry) return false;
        const { target } = entry;
        if (type === 'bool') {
          target[field] = el.checked;
        } else if (type === 'select') {
          if (el.value === '') delete target[field];
          else target[field] = el.value;
        } else if (el.type === 'range') {
          const minVal = el.min !== '' ? +el.min : 1;
           const maxVal = el.max !== '' ? +el.max : Number.POSITIVE_INFINITY;
           if (type === 'integer') {
             target[field] = Math.max(minVal, Math.min(maxVal, Math.round(+el.value * scale)));
           } else if (type === 'angle') {
             target[field] = _parseAngleDegrees(el.value);
           } else {
             target[field] = Math.max(minVal, Math.min(maxVal, +el.value * scale));
           }
         } else if (el.value === '') {
           delete target[field];
         } else if (type === 'integer') {
           const minVal = el.min !== '' ? +el.min : 1;
           const maxVal = el.max !== '' ? +el.max : Number.POSITIVE_INFINITY;
           target[field] = Math.max(minVal, Math.min(maxVal, Math.round(+el.value)));
         } else if (type === 'angle') {
           target[field] = _parseAngleDegrees(el.value);
         } else {
           const minVal = el.min !== '' ? +el.min : Number.NEGATIVE_INFINITY;
           const maxVal = el.max !== '' ? +el.max : Number.POSITIVE_INFINITY;
           target[field] = Math.max(minVal, Math.min(maxVal, +el.value));
         }
         return true;
       };

      // Live label update for range sliders (no re-render while dragging).
       if (el.type === 'range') {
         el.addEventListener('input', () => {
           const lbl = panel.querySelector(`[data-sim-val-label="${field}"]`);
          if (!lbl) return;
          if (type === 'angle') {
            lbl.textContent = Math.round(+el.value) + '°';
          } else if (type === 'integer') {
            lbl.textContent = String(Math.max(+el.min || 0, Math.round(+el.value * scale)));
          } else {
            lbl.textContent = (+el.value * scale).toFixed(scale < 1 ? 2 : 1);
           }
           const numberInput = Array.from(panel.querySelectorAll(`[data-sim-field="${field}"]`))
             .find(candidate => candidate !== el && candidate.type === 'number');
           if (numberInput) numberInput.value = type === 'angle' ? String(Math.round(+el.value)) : String(type === 'integer' ? Math.max(+el.min || 0, Math.round(+el.value * scale)) : (+el.value * scale));
           // Restore reset-button opacity once the user moves the slider.
           const resetBtn = panel.querySelector(`.sim-fld-reset[data-sim-reset="${field}"]`);
           if (resetBtn) resetBtn.style.opacity = '1';
         });
       } else if (el.type === 'number') {
         el.addEventListener('input', () => {
           const lbl = panel.querySelector(`[data-sim-val-label="${field}"]`);
           const resetBtn = panel.querySelector(`.sim-fld-reset[data-sim-reset="${field}"]`);
           const rangeInput = Array.from(panel.querySelectorAll(`[data-sim-field="${field}"]`))
             .find(candidate => candidate !== el && candidate.type === 'range');
           if (el.value === '') {
             if (lbl) lbl.textContent = 'Brush def.';
             if (resetBtn) resetBtn.style.opacity = '0.35';
             return;
           }
           const minVal = el.min !== '' ? +el.min : (type === 'integer' ? 1 : Number.NEGATIVE_INFINITY);
           const maxVal = el.max !== '' ? +el.max : Number.POSITIVE_INFINITY;
           const numericValue = type === 'integer'
             ? Math.max(minVal, Math.min(maxVal, Math.round(+el.value)))
             : Math.max(minVal, Math.min(maxVal, +el.value));
           if (lbl) {
             if (type === 'angle') lbl.textContent = `${Math.round(numericValue)}°`;
             else if (type === 'integer') lbl.textContent = String(numericValue);
             else lbl.textContent = numericValue.toFixed(scale < 1 ? 2 : 1);
           }
           if (rangeInput) rangeInput.value = type === 'angle' ? String(Math.round(numericValue)) : String(scale ? numericValue / scale : numericValue);
           if (resetBtn) resetBtn.style.opacity = '1';
         });
       }

      // Commit on change + trigger re-render.
      const applyField = () => {
        if (!writeField()) return;
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      };
      el.addEventListener('change', applyField);
      if (el.type === 'checkbox') el.addEventListener('input', applyField);
    });

    // Reset buttons — clear an override field and re-render.
    panel.querySelectorAll('[data-sim-reset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry) return;
        delete entry.target[btn.dataset.simReset];
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      });
    });

    // Scene-variable sliders (seek, etc.)
    panel.querySelectorAll('[data-sim-var]').forEach(el => {
      const varName = el.dataset.simVar;
      const updateVar = () => {
        const raw = +el.value;
        this.simulation.vars[varName] = raw / 100;
        const label = panel.querySelector(`[data-sim-var-label="${varName}"]`);
        if (label) label.textContent = `${Math.round(raw)}%`;
        this._maybeAutoSaveSession();
      };
      el.addEventListener('input', updateVar);
      el.addEventListener('change', updateVar);
    });

    panel.querySelector('[data-sim-new-session]')?.addEventListener('click', () => this._newSimulationSession());
    panel.querySelector('[data-sim-save-session]')?.addEventListener('click', () => this._saveSimulationSession());
    panel.querySelectorAll('[data-sim-load-session]').forEach(btn => {
      btn.addEventListener('click', () => this._loadSimulationSession(+btn.dataset.simLoadSession));
    });
    panel.querySelectorAll('[data-sim-del-session]').forEach(btn => {
      btn.addEventListener('click', () => this._deleteSimulationSavedSession(+btn.dataset.simDelSession));
    });
  }

  _toggleSimulationMode(force) {
    if (!this._isMotionBrush()) return;
    const next = typeof force === 'boolean' ? force : !this.simulation.enabled;
    if (!next) {
      this.stopSimulation(false);
      this.simulation.selected = null;
      this._closeSimulationHelp();
    } else {
      const brush = this.getCurrentBrush();
      if (brush?.deactivate) brush.deactivate();
      this.isDrawing = false;
      this.isTapering = false;
    }
    this.simulation.enabled = next;
    this.simulation.paused = false;
    this.simulation.drawingPath = null;
    this.simulation.dragTarget = null;
    this._normalizeSimulationData();
    this._ensureSimulationSpawns();
    this._syncSimulationUI();
    this.showToast(next ? 'Simulation mode ON' : 'Simulation mode OFF');
  }

  _setSimulationTool(tool) {
    if (!this._isMotionBrush()) return;
    this.simulation.editorTool = tool;
    this._syncSimulationUI();
  }

  _syncSimulationUI() {
    if (this.activeBrush === 'boid' && this.simulation.editorTool === 'edge') this.simulation.editorTool = 'spawn';
    if (this.activeBrush === 'ant' && this.simulation.editorTool === 'path') this.simulation.editorTool = 'spawn';
    if (this.activeBrush === 'boid' && this.simulation.editorTool === 'pheromone') this.simulation.editorTool = 'spawn';
    const btn = document.getElementById('simulationBtn');
    const hud = document.getElementById('simHud');
    const handle = document.getElementById('simOverlayHandle');
    const isMotion = this._isMotionBrush();
    if (btn) {
      btn.style.display = isMotion ? '' : 'none';
      btn.classList.toggle('active', !!this.simulation.enabled);
    }
    if (hud) hud.classList.toggle('open', !!this.simulation.enabled && isMotion);
    if (handle) {
      const showHandle = !!this.simulation.enabled && isMotion && this.simulation.inspectorCollapsed;
      handle.classList.toggle('open', showHandle);
      handle.setAttribute('aria-expanded', showHandle ? 'false' : 'true');
    }

    const toolRow = document.getElementById('simToolRow');
    if (toolRow) {
      toolRow.querySelectorAll('[data-sim-tool]').forEach(el => {
        const tool = el.dataset.simTool;
        const hide =
          (this.activeBrush === 'boid' && tool === 'edge') ||
          (this.activeBrush === 'ant' && tool === 'path') ||
          (this.activeBrush === 'boid' && tool === 'pheromone');
        el.style.display = hide ? 'none' : '';
        el.classList.toggle('active', this.simulation.editorTool === tool);
      });
    }

    document.getElementById('simRunBtn')?.classList.toggle('active', this.simulation.running);
    document.getElementById('simPauseBtn')?.classList.toggle('active', this.simulation.paused);
    document.getElementById('simInspectorToggle')?.classList.toggle('active', !this.simulation.inspectorCollapsed);
    const status = document.getElementById('simStatus');
    if (status) {
      status.textContent = this.simulation.running ? 'Running' : (this.simulation.paused ? 'Paused' : 'Ready');
    }
    this._renderSimulationInspector();
  }

  startSimulation() {
    if (!this.simulation.enabled || !this._isMotionBrush()) return;
    const brush = this.getCurrentBrush();
    if (!brush) return;
    if (this.simulation.running) return;
    const spawns = this._ensureSimulationSpawns().filter(spawn => spawn.enabled !== false);
    const spawn = spawns[0] || this._ensureSimulationSpawns()[0];
    this.stopSimulation(false);
    this.simulation.running = true;
    this.simulation.paused = false;
    this.simulation.pathDistance = 0;
    const center = this._getSimulationSpawnCenter();
    this.leaderX = center.x;
    this.leaderY = center.y;
    this.isDrawing = true;
    this.undoPushedThisStroke = false;
    this.strokeFrame = 0;
    brush.onDown?.(spawn.x, spawn.y, 1);
    brush.configureSimulation?.(this._getSimulationBrushData(), this.getP());
    this._syncSimulationUI();
    this.showToast('Simulation running');
  }

  pauseSimulation() {
    if (!this.simulation.running) return;
    this.simulation.running = false;
    this.simulation.paused = true;
    this.isDrawing = false;
    this._syncSimulationUI();
    this.showToast('Simulation paused');
  }

  resumeSimulation() {
    if (!this.simulation.paused || !this._isMotionBrush()) return;
    this.simulation.paused = false;
    this.simulation.running = true;
    this.isDrawing = true;
    this._syncSimulationUI();
    this.showToast('Simulation resumed');
  }

  stopSimulation(showToast = true) {
    const brush = this.getCurrentBrush();
    const wasActive = this.simulation.running || this.simulation.paused;
    if (this.simulation.running && brush?.onUp) {
      brush.onUp(this.leaderX, this.leaderY);
    }
    if (wasActive && brush?.deactivate) brush.deactivate();
    this.simulation.running = false;
    this.simulation.paused = false;
    this.isDrawing = false;
    this.isTapering = false;
    this._syncSimulationUI();
    if (showToast && wasActive) this.showToast('Simulation stopped');
  }

  _handleSimulationPointerDown(x, y) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return false;
    if (this.simulation.running || this.simulation.paused) return true;

    const hit = this._findSimulationHit(x, y);
    if (hit?.kind === 'delete') {
      this._deleteSimulationItem(hit);
      return true;
    }
    if (hit?.kind) {
      this._setSimulationSelection(hit);
      this.simulation.dragTarget = { ...hit, lastX: x, lastY: y };
      return true;
    }

    const tool = this.simulation.editorTool;
    const data = this._getSimulationBrushData();
    if (!data) return true;
    this._setSimulationSelection(null);

    if (tool === 'spawn') {
      const spawn = { id: this.simulation.nextId++, x, y, enabled: true };
      data.spawns.push(spawn);
      this._setSimulationSelection({ collection: 'spawns', kind: 'spawn', target: spawn });
      this._maybeAutoSaveSession();
    } else if (tool === 'attract' || tool === 'repel') {
      const point = { id: this.simulation.nextId++, x, y, type: tool, enabled: true };
      data.points.push(point);
      this._setSimulationSelection({ collection: 'points', kind: 'point', target: point });
      this._maybeAutoSaveSession();
    } else if (tool === 'pheromone' && this.activeBrush === 'ant') {
      this.simulation.drawingPath = {
        kind: tool,
        points: [{ x, y }],
      };
    } else if ((tool === 'path' && this.activeBrush === 'boid') || (tool === 'edge' && this.activeBrush === 'ant')) {
      this.simulation.drawingPath = {
        kind: tool,
        points: [{ x, y }],
      };
    }
    this._renderSimulationInspector();
    return true;
  }

  _handleSimulationPointerMove(x, y) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return false;
    if (this.simulation.dragTarget) {
      const hit = this.simulation.dragTarget;
      const dx = x - hit.lastX;
      const dy = y - hit.lastY;
      hit.lastX = x;
      hit.lastY = y;
      hit.moved = true;
      this._translateSimulationTarget(hit.target, dx, dy);
      return true;
    }
    if (this.simulation.drawingPath) {
      const pts = this.simulation.drawingPath.points;
      const last = pts[pts.length - 1];
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy >= 16) pts.push({ x, y });
      return true;
    }
    return this.simulation.running || this.simulation.paused;
  }

  _handleSimulationPointerUp() {
    if (!this.simulation.enabled || !this._isMotionBrush()) return false;
    const hadMoved = !!this.simulation.dragTarget?.moved;
    this.simulation.dragTarget = null;
    if (this.simulation.drawingPath) {
      const path = this.simulation.drawingPath.points.filter((pt, i, arr) => i === 0 || Math.hypot(pt.x - arr[i - 1].x, pt.y - arr[i - 1].y) > 1);
      const data = this._getSimulationBrushData();
      if (data && path.length >= 2) {
        if (this.simulation.drawingPath.kind === 'path' && this.activeBrush === 'boid') {
          const entry = { id: this.simulation.nextId++, points: path, enabled: true };
          data.paths.push(entry);
          this._setSimulationSelection({ collection: 'paths', kind: 'path', target: entry });
          this._maybeAutoSaveSession();
        } else if (this.simulation.drawingPath.kind === 'edge' && this.activeBrush === 'ant') {
          const entry = { id: this.simulation.nextId++, points: path, enabled: true };
          data.edges.push(entry);
          this._setSimulationSelection({ collection: 'edges', kind: 'edge', target: entry });
          this._maybeAutoSaveSession();
        } else if (this.simulation.drawingPath.kind === 'pheromone' && this.activeBrush === 'ant') {
          const entry = { id: this.simulation.nextId++, points: path, enabled: true };
          data.pheromonePaths.push(entry);
          this._setSimulationSelection({ collection: 'pheromonePaths', kind: 'pheromonePath', target: entry });
          this._maybeAutoSaveSession();
        }
      }
      this.simulation.drawingPath = null;
      this._renderSimulationInspector();
      return true;
    }
    if (hadMoved) this._maybeAutoSaveSession();
    return this.simulation.running || this.simulation.paused || this.simulation.enabled;
  }

  _deleteSimulationItem(hit) {
    const data = this._getSimulationBrushData();
    if (!data) return;
    const collection = hit.collection;
    if (!collection || !Array.isArray(data[collection])) return;
    data[collection] = data[collection].filter(item => item.id !== hit.target?.id);
    if (collection === 'spawns') this._ensureSimulationSpawns();
    const selected = this._getSelectedSimulationEntry();
    if (selected && selected.collection === collection && selected.id === hit.target?.id) {
      this.simulation.selected = null;
    }
    this._renderSimulationInspector();
    this._maybeAutoSaveSession();
  }

  clearSimulationGuides() {
    const data = this._getSimulationBrushData();
    if (!data) return;
    data.spawns = [];
    data.points = [];
    if (this.activeBrush === 'boid') data.paths = [];
    if (this.activeBrush === 'ant') {
      data.edges = [];
      data.pheromonePaths = [];
    }
    this.simulation.selected = null;
    this._ensureSimulationSpawns();
    this._renderSimulationInspector();
    this._maybeAutoSaveSession();
    this.showToast('Simulation guides cleared');
  }

  _findPolylineHit(points, x, y, maxDistance) {
    let best = null;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const candidate = _closestPointOnSegment(x, y, a.x, a.y, b.x, b.y);
      if (!best || candidate.distance < best.distance) best = candidate;
    }
    return best && best.distance <= maxDistance ? best : null;
  }

  _findSimulationHit(x, y) {
    const data = this._getSimulationBrushData();
    if (!data) return null;
    const checkDelete = (target, collection, kind) => {
      const anchor = this._getSimulationAnchor(target);
      const dx = x - (anchor.x + 12);
      const dy = y - (anchor.y - 12);
      return dx * dx + dy * dy <= SIM_DELETE_HIT_RADIUS * SIM_DELETE_HIT_RADIUS ? { kind: 'delete', target, collection, anchorType: kind } : null;
    };

    for (const spawn of this._ensureSimulationSpawns()) {
      const del = checkDelete(spawn, 'spawns', 'spawn');
      if (del) return del;
      if (Math.hypot(x - spawn.x, y - spawn.y) <= SIM_POINT_HIT_RADIUS) return { kind: 'spawn', target: spawn, collection: 'spawns' };
    }

    for (const point of data.points) {
      const del = checkDelete(point, 'points', 'point');
      if (del) return del;
      if (Math.hypot(x - point.x, y - point.y) <= SIM_POINT_HIT_RADIUS) return { kind: 'point', target: point, collection: 'points' };
    }

    if (this.activeBrush === 'boid') {
      for (const pathItem of data.paths || []) {
        const del = checkDelete(pathItem, 'paths', 'path');
        if (del) return del;
        if (this._findPolylineHit(pathItem.points || [], x, y, SIM_LINE_HIT_RADIUS)) {
          return { kind: 'path', target: pathItem, collection: 'paths' };
        }
      }
    }

    if (this.activeBrush === 'ant') {
      for (const pathItem of data.pheromonePaths || []) {
        const del = checkDelete(pathItem, 'pheromonePaths', 'pheromonePath');
        if (del) return del;
        if (this._findPolylineHit(pathItem.points || [], x, y, SIM_LINE_HIT_RADIUS)) {
          return { kind: 'pheromonePath', target: pathItem, collection: 'pheromonePaths' };
        }
      }
      for (const edge of data.edges || []) {
        const del = checkDelete(edge, 'edges', 'edge');
        if (del) return del;
        if (this._findPolylineHit(edge.points || [], x, y, SIM_LINE_HIT_RADIUS)) {
          return { kind: 'edge', target: edge, collection: 'edges' };
        }
      }
    }

    return null;
  }

  _updateSimulationLeader(elapsed, p) {
    const center = this._getSimulationSpawnCenter();
    if (this.activeBrush === 'boid') {
      const data = this._getSimulationBrushData('boid');
      const activePaths = (data?.paths || []).filter(pathItem => pathItem.enabled !== false && pathItem.points?.length >= 2);
      if (activePaths.length) {
        this.simulation.pathDistance += (elapsed / 1000) * p.simPathSpeed * p.simSpeed;
        if (this.simulation.pathDistance >= PATH_DISTANCE_WRAP_THRESHOLD) {
          this.simulation.pathDistance %= PATH_DISTANCE_WRAP_THRESHOLD;
        }
        const targets = activePaths
          .map(pathItem => this._getAnimatedSimulationPathTarget(pathItem, p))
          .filter(Boolean);
        if (targets.length) {
          let sx = 0;
          let sy = 0;
          for (const target of targets) {
            sx += target.x;
            sy += target.y;
          }
          this.leaderX = sx / targets.length;
          this.leaderY = sy / targets.length;
          return;
        }
      }
    }
    this.leaderX = center.x;
    this.leaderY = center.y;
  }

  drawSimulationOverlay(ctx) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return;
    const data = this._getSimulationBrushData();
    if (!data) return;
    const p = this.getP();
    const selected = this._getSelectedSimulationEntry();
    const isSelected = (collection, item) => selected?.collection === collection && selected?.id === item.id;

    const drawDelete = (x, y) => {
      ctx.fillStyle = 'rgba(18,18,22,0.55)';
      ctx.beginPath();
      ctx.arc(x + 12, y - 12, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('×', x + 12, y - 12);
    };

    for (const spawn of this._ensureSimulationSpawns()) {
      const config = this._resolveSimulationSpawnConfig(spawn, p);
      const active = spawn.enabled !== false;
      ctx.save();
      ctx.globalAlpha = active ? 1 : 0.35;
      ctx.strokeStyle = isSelected('spawns', spawn) ? 'rgba(140,196,255,0.98)' : 'rgba(255,255,255,0.6)';
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = isSelected('spawns', spawn) ? 2.4 : 1.5;
      ctx.beginPath();
      ctx.arc(spawn.x, spawn.y, Math.max(8, config.radius), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(spawn.x, spawn.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      drawDelete(spawn.x, spawn.y);
      ctx.restore();
    }

    for (const point of data.points) {
      const config = this._resolveSimulationPointConfig(point, p);
      const attract = point.type === 'attract';
      const color = isSelected('points', point)
        ? 'rgba(150,214,255,0.95)'
        : attract ? 'rgba(94,149,255,0.88)' : 'rgba(255,188,118,0.9)';
      const fill = attract ? 'rgba(54,98,185,0.18)' : 'rgba(217,147,66,0.18)';
      ctx.save();
      ctx.globalAlpha = point.enabled !== false ? 1 : 0.35;
      ctx.strokeStyle = color;
      ctx.fillStyle = fill;
      ctx.lineWidth = isSelected('points', point) ? 2.4 : 1.5;
      ctx.beginPath();
      ctx.arc(point.x, point.y, config.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      drawDelete(point.x, point.y);
      ctx.restore();
    }

    if (this.activeBrush === 'boid') {
      for (const pathItem of data.paths || []) {
        if (!pathItem.points?.length) continue;
        const config = this._resolveSimulationPathConfig(pathItem, p);
        const target = this._getAnimatedSimulationPathTarget(pathItem, p);
        ctx.save();
        ctx.globalAlpha = pathItem.enabled !== false ? 1 : 0.3;
        ctx.strokeStyle = isSelected('paths', pathItem) ? 'rgba(168,218,255,0.98)' : 'rgba(116,166,255,0.85)';
        ctx.lineWidth = isSelected('paths', pathItem) ? 3 : 2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(pathItem.points[0].x, pathItem.points[0].y);
        for (let i = 1; i < pathItem.points.length; i++) ctx.lineTo(pathItem.points[i].x, pathItem.points[i].y);
        if (config.closed) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha *= 0.16;
        ctx.lineWidth = config.radius * 2;
        ctx.stroke();
        if (target) {
          ctx.globalAlpha = pathItem.enabled !== false ? 1 : 0.3;
          ctx.fillStyle = isSelected('paths', pathItem) ? 'rgba(196,233,255,0.98)' : 'rgba(136,190,255,0.95)';
          ctx.beginPath();
          ctx.arc(target.x, target.y, Math.max(5, Math.min(9, config.radius * 0.2)), 0, Math.PI * 2);
          ctx.fill();
        }
        const anchor = this._getSimulationAnchor(pathItem);
        drawDelete(anchor.x, anchor.y);
        ctx.restore();
      }
    }

    if (this.activeBrush === 'ant') {
      for (const trail of data.pheromonePaths || []) {
        if (!trail.points?.length) continue;
        const config = this._resolveSimulationPheromoneConfig(trail, p);
        ctx.save();
        ctx.globalAlpha = trail.enabled !== false ? 1 : 0.35;
        ctx.strokeStyle = isSelected('pheromonePaths', trail) ? 'rgba(194,255,150,0.95)' : 'rgba(120,200,80,0.8)';
        ctx.lineWidth = Math.max(2, config.radius * 2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha *= Math.max(0.12, config.intensity * 0.4);
        ctx.beginPath();
        ctx.moveTo(trail.points[0].x, trail.points[0].y);
        for (let i = 1; i < trail.points.length; i++) ctx.lineTo(trail.points[i].x, trail.points[i].y);
        ctx.stroke();
        ctx.restore();
        const anchor = this._getSimulationAnchor(trail);
        drawDelete(anchor.x, anchor.y);
      }
      for (const edge of data.edges) {
        if (!edge.points?.length) continue;
        const config = this._resolveSimulationEdgeConfig(edge, p);
        ctx.save();
        ctx.globalAlpha = edge.enabled !== false ? 1 : 0.35;
        ctx.strokeStyle = isSelected('edges', edge) ? 'rgba(255,238,160,0.98)' : 'rgba(255,210,120,0.92)';
        ctx.fillStyle = 'rgba(255,210,120,0.08)';
        ctx.lineWidth = isSelected('edges', edge) ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(edge.points[0].x, edge.points[0].y);
        for (let i = 1; i < edge.points.length; i++) ctx.lineTo(edge.points[i].x, edge.points[i].y);
        ctx.stroke();
        if (config.radius > 0) {
          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.lineWidth = config.radius * 2;
          ctx.stroke();
          ctx.restore();
        }
        const anchor = this._getSimulationAnchor(edge);
        drawDelete(anchor.x, anchor.y);
        ctx.restore();
      }
    }

    if (this.simulation.drawingPath?.points?.length >= 2) {
      const pts = this.simulation.drawingPath.points;
      ctx.strokeStyle =
        this.simulation.drawingPath.kind === 'edge' ? 'rgba(255,210,120,0.85)'
        : this.simulation.drawingPath.kind === 'pheromone' ? 'rgba(120,200,80,0.85)'
        : 'rgba(116,166,255,0.85)';
      ctx.lineWidth = this.simulation.drawingPath.kind === 'pheromone'
        ? Math.max(2, p.simPheroPaintRadius * 2)
        : 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ========================================================
  // BRUSH MANAGEMENT
  // ========================================================

  setBrush(name) {
    if (!this.brushes[name]) return;
    if (this.activeBrush !== name && (this.simulation.running || this.simulation.paused)) this.stopSimulation(false);
    this.setTool('brush'); // restore brush mode when changing brush type
    // Deactivate current
    const cur = this.brushes[this.activeBrush];
    if (cur && cur.deactivate) cur.deactivate();
    this.activeBrush = name;
    // Update brush dropdown button
    const brushLabels = { boid: '🐦 Boid', ant: '🐜 Ant', bristle: '🖊 Bristle', fluid: '🌊 LBM Fluid', simple: '🖌 Simple', eraser: '◻ Eraser', ai: '🤖 AI Diffusion' };
    const btn = document.getElementById('brushBtn');
    if (btn) {
      btn.textContent = brushLabels[name] || name;
      btn.classList.remove('active', 'eraser-active');
      btn.classList.add(name === 'eraser' ? 'eraser-active' : 'active');
    }
    // Update dropdown selection
    document.querySelectorAll('#brushDropdown button[data-brush]').forEach(b => {
      b.classList.toggle('selected', b.dataset.brush === name);
    });
    // Toggle brush-specific sections
    this._toggleBrushSections(name);
    if (!this._isMotionBrush(name)) this.simulation.enabled = false;
    this._ensureSimulationSpawns(name);
    this._syncSimulationUI();
    this._paramsDirty = true;
  }

  _toggleBrushSections(brush) {
    document.querySelectorAll('[data-brushes]').forEach(el => {
      const allowed = el.dataset.brushes.split(' ');
      const show = allowed.includes(brush);
      el.classList.toggle('brush-hidden', !show);
    });
  }

  getCurrentBrush() { return this.brushes[this.activeBrush]; }

  /** Set the active interaction tool. */
  setTool(name) {
    this.activeTool = name;
    this._syncSelectionUI();
  }

  /** Clear the active selection. Stamps any floating pixels first. */
  deselect() {
    if (!this.selectionMgr?.active) return;
    this._commitFloatingPixels();
    this.selectionMgr.clear();
    this._syncSelectionUI();
    this.showToast('✕ Deselected');
  }

  /** Stamp floating pixels back onto the active layer (if any). */
  _commitFloatingPixels() {
    if (!this.selectionMgr?._floatingPixels) return;
    const l = this.getActiveLayer();
    this.selectionMgr.stampPixels(l.ctx, this.DPR);
    l.dirty = true;
    this.compositeAllLayers();
  }

  /** Sync selection toolbar buttons with current tool/selection state. */
  _syncSelectionUI() {
    document.getElementById('rectSelectBtn')?.classList.toggle('active', this.activeTool === 'rect-select');
    document.getElementById('ellipseSelectBtn')?.classList.toggle('active', this.activeTool === 'ellipse-select');
    document.getElementById('lassoSelectBtn')?.classList.toggle('active', this.activeTool === 'lasso-select');
    document.getElementById('fillBtn')?.classList.toggle('active', this.activeTool === 'fill');
    const deselectBtn = document.getElementById('deselectBtn');
    if (deselectBtn) deselectBtn.style.display = this.selectionMgr?.active ? '' : 'none';
    const transformBtn = document.getElementById('transformBtn');
    if (transformBtn) transformBtn.style.display = this.selectionMgr?.active ? '' : 'none';
    const proportionalBtn = document.getElementById('proportionalToggle');
    if (proportionalBtn) proportionalBtn.style.display = this.selectionMgr?.transformActive ? '' : 'none';
    // Update transform button active state
    document.getElementById('transformBtn')?.classList.toggle('active', this.activeTool === 'transform');
  }

  _toggleTransform() {
    if (!this.selectionMgr?.active) return;
    this.selectionMgr.transformActive = !this.selectionMgr.transformActive;
    if (this.selectionMgr.transformActive) {
      this.setTool('transform');
      this.showToast('🔒 Transform mode ON');
    } else {
      this.setTool('brush');
      this.showToast('🔒 Transform mode OFF');
    }
    this._syncSelectionUI();
  }

  _toggleProportional() {
    if (!this.selectionMgr) return;
    this.selectionMgr.keepProportional = !this.selectionMgr.keepProportional;
    const btn = document.getElementById('proportionalToggle');
    if (btn) btn.classList.toggle('active', this.selectionMgr.keepProportional);
    this.showToast(this.selectionMgr.keepProportional ? '🔒 Proportional: ON' : '🔒 Proportional: OFF');
  }

  // ========================================================
  // DRAWING / POINTER EVENTS
  // ========================================================

  _bindEvents() {
    const ic = this.interactionCanvas;

    ic.addEventListener('pointerdown', e => this._onPointerDown(e));
    ic.addEventListener('pointermove', e => this._onPointerMove(e));
    ic.addEventListener('pointerrawupdate', e => this._onPointerRawUpdate(e));
    ic.addEventListener('pointerup', e => this._onPointerUp(e));
    ic.addEventListener('pointercancel', e => this._onPointerUp(e));
    ic.addEventListener('pointerleave', e => this._onPointerLeave(e));

    // Touch events for pinch zoom/rotate (on canvasArea to capture all fingers)
    const area = document.getElementById('canvasArea');
    area.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false });
    area.addEventListener('touchmove', e => this._onTouchMove(e), { passive: false });
    area.addEventListener('touchend', e => this._onTouchEnd(e), { passive: false });
    area.addEventListener('touchcancel', e => this._onTouchEnd(e), { passive: false });

    // Mouse wheel zoom
    area.addEventListener('wheel', e => this._onWheel(e), { passive: false });

    // Keyboard shortcuts
    window.addEventListener('keydown', e => this._onKeyDown(e));

    // Resize
    window.addEventListener('resize', () => {
      this._resizeAll();
      this.compositeAllLayers();
    });

    // Brush dropdown
    const brushBtn = document.getElementById('brushBtn');
    const brushDropdown = document.getElementById('brushDropdown');
    if (brushBtn && brushDropdown) {
      const positionDropdown = () => {
        const r = brushBtn.getBoundingClientRect();
        brushDropdown.style.top = (r.bottom + 4) + 'px';
        brushDropdown.style.left = r.left + 'px';
      };
      brushBtn.addEventListener('click', e => {
        e.stopPropagation();
        positionDropdown();
        brushDropdown.classList.toggle('open');
      });
      brushDropdown.querySelectorAll('button[data-brush]').forEach(b => {
        b.addEventListener('click', e => {
          e.stopPropagation();
          this.setBrush(b.dataset.brush);
          brushDropdown.classList.remove('open');
        });
      });
      document.addEventListener('click', () => {
        brushDropdown.classList.remove('open');
      });
    }
    document.getElementById('undoBtn')?.addEventListener('click', () => this.doUndo());
    document.getElementById('redoBtn')?.addEventListener('click', () => this.doRedo());
    document.getElementById('clearBtn')?.addEventListener('click', () => this.clearActiveLayer());
    document.getElementById('saveBtn')?.addEventListener('click', () => this.saveImage());
    document.getElementById('exportPsdBtn')?.addEventListener('click', () => exportPSD(this));
    document.getElementById('importPsdBtn')?.addEventListener('click', () => importPSD(this));
    document.getElementById('resetViewBtn')?.addEventListener('click', () => this.resetView());
    document.getElementById('flipViewBtn')?.addEventListener('click', () => this.flipView());
    document.getElementById('tilingBtn')?.addEventListener('click', () => this.toggleTiling());
    document.getElementById('alphaLockBtn')?.addEventListener('click', () => this.toggleAlphaLock());
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      const sb = document.getElementById('sidebar');
      const open = sb?.classList.toggle('open');
      document.getElementById('sidebarToggle')?.classList.toggle('active', open);
    });
    document.getElementById('layersToggle')?.addEventListener('click', () => {
      const lp = document.getElementById('layersPanel');
      const open = lp?.classList.toggle('open');
      document.getElementById('layersToggle')?.classList.toggle('active', open);
    });
    document.getElementById('swapColors')?.addEventListener('click', () => {
      const t = this.primaryEl.value;
      this.primaryEl.value = this.secondaryEl.value;
      this.secondaryEl.value = t;
      this._paramsDirty = true;
    });
    document.getElementById('layerSwitcher')?.addEventListener('change', e => {
      this.setActiveLayer(+e.target.value);
      syncUI(this);
    });
    // Selection tools
    document.getElementById('rectSelectBtn')?.addEventListener('click', () => this.setTool('rect-select'));
    document.getElementById('ellipseSelectBtn')?.addEventListener('click', () => this.setTool('ellipse-select'));
    document.getElementById('lassoSelectBtn')?.addEventListener('click', () => this.setTool('lasso-select'));
    document.getElementById('fillBtn')?.addEventListener('click', () => this.setTool('fill'));
    document.getElementById('deselectBtn')?.addEventListener('click', () => this.deselect());
    // Transform tool
    document.getElementById('transformBtn')?.addEventListener('click', () => this._toggleTransform());
    document.getElementById('proportionalToggle')?.addEventListener('click', () => this._toggleProportional());
    document.getElementById('simulationBtn')?.addEventListener('click', () => this._toggleSimulationMode());
    document.getElementById('simRunBtn')?.addEventListener('click', () => {
      if (this.simulation.paused) this.resumeSimulation();
      else this.startSimulation();
    });
    document.getElementById('simPauseBtn')?.addEventListener('click', () => this.pauseSimulation());
    document.getElementById('simStopBtn')?.addEventListener('click', () => this.stopSimulation());
    document.getElementById('simClearBtn')?.addEventListener('click', () => this.clearSimulationGuides());
    document.getElementById('simInspectorToggle')?.addEventListener('click', () => {
      this.simulation.inspectorCollapsed = !this.simulation.inspectorCollapsed;
      this._syncSimulationUI();
    });
    document.getElementById('simOverlayHandle')?.addEventListener('click', () => {
      this.simulation.inspectorCollapsed = false;
      this._syncSimulationUI();
    });
    document.querySelectorAll('[data-sim-tool]').forEach(el => {
      el.addEventListener('click', () => this._setSimulationTool(el.dataset.simTool));
    });
    document.getElementById('simHelpClose')?.addEventListener('click', () => this._closeSimulationHelp());
    document.getElementById('simHelpBackdrop')?.addEventListener('click', () => this._closeSimulationHelp());
    // Copy/cut/paste
    document.getElementById('copyBtn')?.addEventListener('click', () => this.copyToClipboard());
    document.getElementById('cutBtn')?.addEventListener('click', () => this.cutToClipboard());
    document.getElementById('pasteBtn')?.addEventListener('click', () => this.pasteFromClipboard());
    // Color pickers invalidate params
    this.primaryEl.addEventListener('input', () => { this._paramsDirty = true; });
    this.secondaryEl.addEventListener('input', () => { this._paramsDirty = true; });
    // Background color
    this.bgColorEl?.addEventListener('input', () => {
      this._fillBackgroundLayer();
      this.compositeAllLayers();
    });
    // Canvas size modal
    document.getElementById('canvasSizeBtn')?.addEventListener('click', () => this._showCanvasSizeModal());
    document.getElementById('canvasSizeClose')?.addEventListener('click', () => this._hideCanvasSizeModal());
    document.getElementById('canvasSizeBackdrop')?.addEventListener('click', () => this._hideCanvasSizeModal());
    document.getElementById('canvasSizePreset')?.addEventListener('change', () => this._onCanvasSizePresetChange());
    document.getElementById('canvasSizeSwap')?.addEventListener('click', () => {
      const w = document.getElementById('canvasSizeW');
      const h = document.getElementById('canvasSizeH');
      if (w && h) { const t = w.value; w.value = h.value; h.value = t; }
    });
    document.getElementById('canvasSizeApply')?.addEventListener('click', async () => {
      const w = +document.getElementById('canvasSizeW')?.value || 1920;
      const h = +document.getElementById('canvasSizeH')?.value || 1080;
      const bg = document.getElementById('canvasSizeBg')?.value || '#ffffff';
      await this.resizeDocument(w, h, bg);
      this._hideCanvasSizeModal();
    });
  }

  _initTopbarOverflow() {
    const topbar = document.getElementById('topbar');
    const menu = document.getElementById('topbarOverflowMenu');
    const toggle = document.getElementById('topbarOverflowToggle');
    if (!topbar || !menu || !toggle) return;

    // Capture the initial ordered children and insert comment placeholders to
    // track original positions so items can be returned in the right order.
    const items = Array.from(topbar.children).map(node => {
      const placeholder = document.createComment('tbof');
      node.before(placeholder);
      return { node, placeholder };
    });

    // Use let so that closeMenu and the dismiss handlers can mutually reference
    // each other without temporal-dead-zone issues.
    let onDocClick, onDocKeydown;
    // Track whether dismiss listeners are currently attached to avoid
    // unconditional removeEventListener calls before the menu has ever opened.
    let dismissBound = false;

    const closeMenu = (returnFocus = false) => {
      const wasOpen = menu.classList.contains('open');
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      if (dismissBound) {
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onDocKeydown);
        dismissBound = false;
      }
      // Return focus to the caret toggle when the menu was closed by user action
      // and focus was inside the menu (e.g. Escape key or outside click).
      if (returnFocus && wasOpen && menu.contains(document.activeElement)) {
        toggle.focus();
      }
    };

    // Check the click target instead of stopping propagation on the menu so
    // that events inside the menu can still bubble normally to their ancestors.
    onDocClick = e => { if (!menu.contains(e.target) && e.target !== toggle) closeMenu(true); };
    onDocKeydown = e => { if (e.key === 'Escape') closeMenu(true); };

    let layoutPending = false;
    const layout = () => {
      if (layoutPending) return;
      layoutPending = true;
      requestAnimationFrame(() => {
        layoutPending = false;

        // 1. Return all overflowed items back to topbar (in original order).
        for (const item of items) {
          if (item.node.parentElement !== topbar) {
            item.placeholder.after(item.node);
          }
        }
        closeMenu();

        // 2. Reset any separator display overrides from the previous layout pass.
        topbar.querySelectorAll('.tb-sep').forEach(s => { s.style.display = ''; });

        // 3. Move trailing items into the menu until the topbar fits.
        //    Skip items that are hidden by app logic (display:none) — they
        //    don't contribute to overflow width and should stay in the topbar
        //    so that show/hide toggling by app code continues to work.
        for (let i = items.length - 1; i >= 0; i--) {
          if (topbar.scrollWidth <= topbar.clientWidth) break;
          const item = items[i];
          if (item.node.classList.contains('topbar-essential')) continue;
          if (item.node.style.display === 'none') continue;
          menu.prepend(item.node);
        }

        // 4. Hide orphan separators at the visible boundaries of #topbar.
        const tbVisible = Array.from(topbar.childNodes)
          .filter(n => n.nodeType === Node.ELEMENT_NODE &&
                       getComputedStyle(n).display !== 'none');
        // Trailing separators
        for (let i = tbVisible.length - 1; i >= 0; i--) {
          if (tbVisible[i].classList.contains('tb-sep')) tbVisible[i].style.display = 'none';
          else break;
        }
        // Leading separators
        for (let i = 0; i < tbVisible.length; i++) {
          if (tbVisible[i].classList.contains('tb-sep')) tbVisible[i].style.display = 'none';
          else break;
        }

        // 5. Show the caret only when there are overflow items.
        const hasOverflow = menu.children.length > 0;
        toggle.hidden = !hasOverflow;
        if (!hasOverflow) closeMenu();
      });
    };

    // Caret click — open/close the menu and position it under the toggle button.
    // stopPropagation prevents the toggle's own click from reaching onDocClick
    // which is attached to the document and would immediately close the menu.
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      const r = toggle.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.right = (window.innerWidth - r.right) + 'px';
      const isOpen = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      // Add dismiss listeners only while the menu is open, so they don't fire
      // on every click/keydown throughout the rest of the application lifetime.
      if (isOpen) {
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onDocKeydown);
        dismissBound = true;
        // Move focus to the first focusable item in the menu for keyboard users.
        const firstFocusable = menu.querySelector(
          'button:not([hidden]):not([disabled]), input:not([hidden]):not([disabled]), select:not([hidden]):not([disabled])'
        );
        firstFocusable?.focus();
      } else {
        closeMenu();
      }
    });

    // Re-run layout on window resize, orientation change, and whenever
    // #topbar itself changes size (e.g. after show/hide of conditional buttons).
    window.addEventListener('resize', layout);
    window.addEventListener('orientationchange', layout);
    new ResizeObserver(layout).observe(topbar);

    layout();
  }

  _getEventCoords(e) {
    // Get coords relative to the canvas area (not the transformed canvas)
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const sx = e.clientX - areaRect.left;
    const sy = e.clientY - areaRect.top;
    // Convert from screen space (post-transform) to canvas space
    return this._screenToCanvas(sx, sy);
  }

  _getCanvasViewMetrics() {
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    return {
      areaRect,
      baseX: (areaRect.width - this.W) / 2,
      baseY: (areaRect.height - this.H) / 2,
      centerX: this.W / 2,
      centerY: this.H / 2,
    };
  }

  _screenToCanvas(sx, sy) {
    const { baseX, baseY, centerX, centerY } = this._getCanvasViewMetrics();

    // Undo translate(base + pan) and the canvas-center pivot translation.
    let dx = sx - baseX - this.viewPanX - centerX;
    let dy = sy - baseY - this.viewPanY - centerY;
    // Undo rotate(rot)
    const cos = Math.cos(-this.viewRotation);
    const sin = Math.sin(-this.viewRotation);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    // Undo scale(zoom)
    let ux = rx / this.viewZoom;
    let uy = ry / this.viewZoom;
    // Undo scaleX(flip)
    if (this.viewFlipped) ux = -ux;
    return { x: ux + centerX, y: uy + centerY };
  }

  _setViewPanForScreenAnchor(canvasX, canvasY, screenX, screenY) {
    const { baseX, baseY, centerX, centerY } = this._getCanvasViewMetrics();
    let offsetX = canvasX - centerX;
    const offsetY = canvasY - centerY;
    if (this.viewFlipped) offsetX = -offsetX;
    offsetX *= this.viewZoom;
    const scaledOffsetY = offsetY * this.viewZoom;
    const cos = Math.cos(this.viewRotation);
    const sin = Math.sin(this.viewRotation);
    const rx = offsetX * cos - scaledOffsetY * sin;
    const ry = offsetX * sin + scaledOffsetY * cos;
    this.viewPanX = screenX - baseX - centerX - rx;
    this.viewPanY = screenY - baseY - centerY - ry;
  }

  /** Extract stylus tilt/azimuth from a PointerEvent and store on this App */
  _captureTilt(e) {
    const prevAz = this.azimuth;
    this.penEventHasAngles = false;
    this.tiltX = e.tiltX || 0;
    this.tiltY = e.tiltY || 0;
    // Prefer the direct azimuthAngle/altitudeAngle (Safari/WebKit on iPad)
    if (typeof e.azimuthAngle === 'number') {
      this.azimuth = e.azimuthAngle;
      this.altitude = typeof e.altitudeAngle === 'number' ? e.altitudeAngle : Math.PI / 2;
      this.penEventHasAngles = true;
      this.penAngleSampleValid = true;
      this.penAngleSource = 'azimuthAngle';
    } else if (this.tiltX !== 0 || this.tiltY !== 0) {
      // Compute azimuth from tiltX/tiltY (Pointer Events Level 2 fallback)
      const tx = this.tiltX * Math.PI / 180;
      const ty = this.tiltY * Math.PI / 180;
      this.azimuth = Math.atan2(Math.tan(ty), Math.tan(tx));
      if (this.azimuth < 0) this.azimuth += Math.PI * 2;
      // Approximate altitude from tilt magnitude
      const tiltMag = Math.sqrt(tx * tx + ty * ty);
      this.altitude = Math.max(0, Math.PI / 2 - tiltMag);
      this.penEventHasAngles = true;
      this.penAngleSampleValid = true;
      this.penAngleSource = 'tilt';
    } else {
      // Pen is vertical or no tilt data — leave previous values
      this.penAngleSource = 'none';
    }

    // Track azimuth change per processed pen event for live diagnostics.
    let diff = this.azimuth - prevAz;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.prevAzimuth = prevAz;
    this.azimuthDeltaDeg = diff * 180 / Math.PI;
    if (Math.abs(this.azimuthDeltaDeg) > 0.01) this.azimuthUpdateCount++;
  }

  _onPointerRawUpdate(e) {
    if ((e.pointerType || '') !== 'pen') return;
    this.pointerType = 'pen';
    this._captureTilt(e);
  }

  _onPointerDown(e) {
    e.preventDefault();
    // Track active pointers for multi-touch detection
    this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.pointerType = e.pointerType || 'mouse';
    // Don't start drawing during pinch gesture
    if (this._pinchActive) return;
    // Don't start drawing if touch and multiple pointers (pinch incoming)
    if (e.pointerType === 'touch' && this._activePointers.size > 1) return;

    this.interactionCanvas.setPointerCapture(e.pointerId);
    const { x, y } = this._getEventCoords(e);
    this._captureTilt(e);
    if (this._handleSimulationPointerDown(x, y)) return;
    // Move selection by dragging inside it (works in any tool mode)
    if (this.selectionMgr?.active && !this.selectionMgr.transformActive) {
      if (this.selectionMgr.moveOnDown(x, y)) {
        // Lift pixels from the layer on first move (noop if already floating)
        if (!this.selectionMgr._floatingPixels) {
          const l = this.getActiveLayer();
          this.pushUndo();
          this.selectionMgr.liftPixels(l.ctx, l.canvas, this.DPR);
          l.dirty = true;
          this.compositeAllLayers();
        }
        return;
      }
    }
    // Transform tool dispatch - check for handle drag (resize or move)
    if (this.activeTool === 'transform' && this.selectionMgr?.transformActive) {
      if (this.selectionMgr.transformOnDown(x, y)) {
        // Lift pixels from the layer on first transform drag (noop if already floating)
        if (!this.selectionMgr._floatingPixels) {
          const l = this.getActiveLayer();
          this.pushUndo();
          this.selectionMgr.liftPixels(l.ctx, l.canvas, this.DPR);
          l.dirty = true;
          this.compositeAllLayers();
        }
        return;
      }
    }
    // Fill tool dispatch
    if (this.activeTool === 'fill') {
      this._floodFill(x, y);
      return;
    }
    // Selection tool dispatch - click outside selection starts a new one
    if (this.activeTool !== 'brush') {
      this._commitFloatingPixels(); // stamp any floating pixels before new selection
      this.selectionMgr.onDown(x, y);
      return;
    }
    // Reset EMA pressure at stroke start for immediate response
    this._rawPressure = e.pressure || 0.5;
    this.pressure = this._rawPressure;
    this.leaderX = x;
    this.leaderY = y;
    this._stabX = x;
    this._stabY = y;
    this.isDrawing = true;
    this.undoPushedThisStroke = false;
    this.isTapering = false;
    this.strokeFrame = 0;

    const brush = this.getCurrentBrush();
    if (brush) brush.onDown(x, y, this.pressure);
  }

  _onPointerMove(e) {
    this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.pointerType = e.pointerType || 'mouse';
    // Track cursor position for brush size preview
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    this._cursorX = e.clientX - areaRect.left;
    this._cursorY = e.clientY - areaRect.top;
    // Don't draw during pinch
    if (this._pinchActive) return;
    const simCoords = this._getEventCoords(e);
    if (this._handleSimulationPointerMove(simCoords.x, simCoords.y)) return;
    // Move-drag dispatch (any tool mode)
    if (this.selectionMgr?._isMoving) {
      const { x, y } = this._getEventCoords(e);
      this.selectionMgr.moveOnMove(x, y);
      return;
    }
    // Transform tool dispatch
    if (this.activeTool === 'transform' && this.selectionMgr?._transformHandle) {
      const { x, y } = this._getEventCoords(e);
      this.selectionMgr.transformOnMove(x, y);
      return;
    }
    if (this.activeTool !== 'brush') {
      if (this.selectionMgr?._isDragging) {
        const { x, y } = this._getEventCoords(e);
        this.selectionMgr.onMove(x, y);
      }
      return;
    }
    if (!this.isDrawing) {
      const { x, y } = this._getEventCoords(e);
      this._rawPressure = e.pressure || 0.5;
      this.pressure += (this._rawPressure - this.pressure) * PRESSURE_SMOOTH_ALPHA;
      this._captureTilt(e);
      this.leaderX = x;
      this.leaderY = y;
      // Notify brush of hover for Apple Pencil hover preview/spawn
      // Skip during taper — hover would clear the tapering boids
      if (!this.isTapering && !(this.simulation.enabled && this._isMotionBrush())) {
        const brush = this.getCurrentBrush();
        if (brush && brush.onHover) brush.onHover(x, y);
      }
      return;
    }

    const brush = this.getCurrentBrush();
    const p = this.getP();
    const stab = p.stabilizer || 0;
    // Use coalesced events for smoother brush strokes (sub-frame input samples)
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [e];
    for (const pe of events) {
      const { x, y } = this._getEventCoords(pe);
      this._rawPressure = pe.pressure || 0.5;
      this.pressure += (this._rawPressure - this.pressure) * PRESSURE_SMOOTH_ALPHA;
      this._captureTilt(pe);

      // Apply stabilizer (lazy mouse)
      if (stab > 0) {
        const alpha = 1 - stab * 0.95; // keeps min 5% responsiveness at max stabilizer
        this._stabX += (x - this._stabX) * alpha;
        this._stabY += (y - this._stabY) * alpha;
        this.leaderX = this._stabX;
        this.leaderY = this._stabY;
        if (brush) brush.onMove(this._stabX, this._stabY, this.pressure);
      } else {
        this.leaderX = x;
        this.leaderY = y;
        if (brush) brush.onMove(x, y, this.pressure);
      }
    }
  }

  _onPointerUp(e) {
    this._activePointers.delete(e.pointerId);
    if (this._handleSimulationPointerUp()) return;
    // Move-drag end (any tool mode) — keep pixels floating
    if (this.selectionMgr?._isMoving) {
      this.selectionMgr.moveOnUp();
      return;
    }
    // Transform tool dispatch — keep pixels floating
    if (this.activeTool === 'transform' && this.selectionMgr?._transformHandle) {
      this.selectionMgr.transformOnUp();
      return;
    }
    // Selection tool dispatch
    if (this.activeTool !== 'brush') {
      if (this.selectionMgr?._isDragging) {
        const { x, y } = this._getEventCoords(e);
        this.selectionMgr.onUp(x, y);
      }
      return;
    }
    if (!this.isDrawing) return;
    this.isDrawing = false;
    const { x, y } = this._getEventCoords(e);

    const brush = this.getCurrentBrush();
    if (brush) brush.onUp(x, y);

    this._recordColor(this.primaryEl.value);

    // Start taper if configured
    const p = this.getP();
    if (p.taperLength > 0) {
      this.isTapering = true;
      this.taperFrame = 0;
      this.taperTotal = p.taperLength;
    }
  }

  _onPointerLeave(e) {
    // Clear hover state when a hover-capable pointer leaves canvas.
    // Touch has no hover phase, so letting pointerleave run unhover logic after
    // touch-up would incorrectly override the configured untouch action.
    if (this.isDrawing) return;
    if ((e.pointerType || this.pointerType) === 'touch') return;
    const brush = this.getCurrentBrush();
    if (brush && brush.onHoverEnd) brush.onHoverEnd();
  }

  _onKeyDown(e) {
    const target = e.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      const isEditableField = !target.disabled && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
      if (target.isContentEditable || isEditableField) return;
    }
    // Ctrl+N = new canvas / canvas size
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); this._showCanvasSizeModal(); return; }
    // Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo
    if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); this.doUndo(); }
    if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); this.doRedo(); }
    // Ctrl+S = save image
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.saveImage(); }
    // Ctrl+C = copy canvas to clipboard
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); this.copyToClipboard(); }
    // Ctrl+X = cut selection
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') { e.preventDefault(); this.cutToClipboard(); return; }
    // Ctrl+V = paste from clipboard
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); this.pasteFromClipboard(); }
    // Escape = deselect
    if (e.key === 'Escape') this.deselect();
    // M = rectangle select, L = lasso select, T = transform
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (e.key === 'm' || e.key === 'M') { this.setTool('rect-select'); return; }
      if (e.key === 'l' || e.key === 'L') { this.setTool('lasso-select'); return; }
      if (e.key === 'g' || e.key === 'G') { this.setTool('fill'); return; }
      if (e.key === 't' || e.key === 'T') { this._toggleTransform(); return; }
    }
    // 0 = reset view
    if (e.key === '0' && !e.ctrlKey && !e.metaKey) this.resetView();
    // [ / ] = decrease / increase brush size
    if (e.key === '[') this._adjustBrushSize(-1);
    if (e.key === ']') this._adjustBrushSize(1);
    // F = flip canvas view
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
      this.flipView();
    }
    // P = toggle tiling mode
    if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey) {
      this.toggleTiling();
      return;
    }
    // X = swap colors (non-ctrl; Ctrl+X is cut)
    if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey) {
      const t = this.primaryEl.value;
      this.primaryEl.value = this.secondaryEl.value;
      this.secondaryEl.value = t;
      this._paramsDirty = true;
    }
    // / = toggle alpha lock on active layer
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.toggleAlphaLock();
    }
  }

  _adjustBrushSize(delta) {
    const slider = document.getElementById('stampSize');
    if (!slider) return;
    slider.value = Math.max(+slider.min, Math.min(+slider.max, +slider.value + delta));
    this.invalidateParams();
    const span = document.getElementById('v_stampSize');
    if (span) span.textContent = slider.value;
    this.showToast(`🖌 Brush size: ${slider.value}`);
  }

  // ========================================================
  // PINCH ZOOM / ROTATE / PAN (Touch Gestures)
  // ========================================================

  _onTouchStart(e) {
    if (e.touches.length === 2) {
      // Two-finger gesture: start pinch zoom/rotate
      e.preventDefault();
      this._pinchActive = true;
      // Cancel any active drawing
      if (this.isDrawing) {
        this.isDrawing = false;
        const brush = this.getCurrentBrush();
        if (brush) brush.onUp(this.leaderX, this.leaderY);
      }
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      this._pinchStartDist = Math.sqrt(dx * dx + dy * dy);
      this._pinchStartAngle = Math.atan2(dy, dx);
      this._pinchStartZoom = this.viewZoom;
      this._pinchStartRotation = this.viewRotation;
      this._pinchStartPanX = this.viewPanX;
      this._pinchStartPanY = this.viewPanY;
      this._pinchStartMidX = (t0.clientX + t1.clientX) / 2;
      this._pinchStartMidY = (t0.clientY + t1.clientY) / 2;
      // Compute canvas point under pinch midpoint (to anchor zoom/rotate)
      const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
      this._pinchAnchor = this._screenToCanvas(
        this._pinchStartMidX - areaRect.left,
        this._pinchStartMidY - areaRect.top
      );
    }
  }

  _onTouchMove(e) {
    if (this._pinchActive && e.touches.length === 2) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      // Zoom
      const scale = dist / this._pinchStartDist;
      this.viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._pinchStartZoom * scale));

      // Rotation
      this.viewRotation = this._pinchStartRotation + (angle - this._pinchStartAngle);

      // Pan: keep the canvas anchor point under the current pinch midpoint
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
      const curSX = midX - areaRect.left;
      const curSY = midY - areaRect.top;
      this._setViewPanForScreenAnchor(this._pinchAnchor.x, this._pinchAnchor.y, curSX, curSY);

      this._applyViewTransform();
    }
  }

  _onTouchEnd(e) {
    if (this._pinchActive && e.touches.length < 2) {
      this._pinchActive = false;
    }
  }

  _onWheel(e) {
    e.preventDefault();
    // Shift+scroll = rotate view
    if (e.shiftKey) {
      const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
      const mx = e.clientX - areaRect.left;
      const my = e.clientY - areaRect.top;
      const anchor = this._screenToCanvas(mx, my);
      const rotDelta = (e.deltaY > 0 ? 1 : -1) * WHEEL_ROTATION_DEG * Math.PI / 180;
      this.viewRotation += rotDelta;
      this._setViewPanForScreenAnchor(anchor.x, anchor.y, mx, my);
      this._applyViewTransform();
      return;
    }
    const zoomFactor = e.deltaY > 0 ? WHEEL_ZOOM_OUT : WHEEL_ZOOM_IN;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * zoomFactor));

    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const mx = e.clientX - areaRect.left;
    const my = e.clientY - areaRect.top;
    const anchor = this._screenToCanvas(mx, my);
    this.viewZoom = newZoom;
    this._setViewPanForScreenAnchor(anchor.x, anchor.y, mx, my);
    this._applyViewTransform();
  }

  _applyViewTransform() {
    const el = document.getElementById('canvasTransform');
    if (!el) return;
    const { baseX, baseY, centerX, centerY } = this._getCanvasViewMetrics();
    const deg = this.viewRotation * 180 / Math.PI;
    const flipScale = this.viewFlipped ? -1 : 1;
    el.style.width = this.W + 'px';
    el.style.height = this.H + 'px';
    el.style.transform = `translate(${baseX + this.viewPanX}px, ${baseY + this.viewPanY}px) translate(${centerX}px, ${centerY}px) rotate(${deg}deg) scale(${this.viewZoom}) scaleX(${flipScale}) translate(${-centerX}px, ${-centerY}px)`;
  }

  resetView() {
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.viewRotation = 0;
    this.viewFlipped = false;
    this._applyViewTransform();
    this.showToast('🔍 View reset');
  }

  flipView() {
    this.viewFlipped = !this.viewFlipped;
    this._applyViewTransform();
    this.showToast(this.viewFlipped ? '🪞 View flipped' : '🪞 View unflipped');
  }

  toggleTiling() {
    this.tilingMode = !this.tilingMode;
    this._syncTilingUI();
    this.showToast(this.tilingMode ? '🔁 Tiling: ON' : '🔁 Tiling: OFF');
  }

  _syncTilingUI() {
    const btn = document.getElementById('tilingBtn');
    if (btn) btn.classList.toggle('active', this.tilingMode);
  }

  _createPerformanceTelemetryState() {
    return {
      initialized: false,
      enabled: true,
      wakeLockPreferred: false,
      wakeLockActive: false,
      lastFrameAt: 0,
      frameCount: 0,
      slowFrameCount: 0,
      totalFrameMs: 0,
      totalBrushMs: 0,
      totalClearMs: 0,
      totalOverlayMs: 0,
      totalStatusMs: 0,
      worstFrameMs: 0,
      worstFramePhase: 'none',
      maxBrushMs: 0,
      maxClearMs: 0,
      maxOverlayMs: 0,
      maxStatusMs: 0,
      longTaskCount: 0,
      longTaskTotalMs: 0,
      throttleGapCount: 0,
      visibilityChanges: 0,
      focusLostCount: 0,
      pageHideCount: 0,
      freezeCount: 0,
      hiddenAt: 0,
      hiddenMs: 0,
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'visible',
      focused: typeof document !== 'undefined' ? document.hasFocus() : true,
      memoryMB: null,
      deviceMemoryGB: Number.isFinite(navigator?.deviceMemory) ? navigator.deviceMemory : null,
      hardwareConcurrency: Number.isFinite(navigator?.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
      recentEvents: [],
      lastUiRefreshAt: 0,
      observer: null,
      enabledEl: null,
      wakeLockEl: null,
      readoutEl: null,
    };
  }

  _resetPerformanceTelemetryStats() {
    const t = this._performanceTelemetry;
    t.lastFrameAt = 0;
    t.frameCount = 0;
    t.slowFrameCount = 0;
    t.totalFrameMs = 0;
    t.totalBrushMs = 0;
    t.totalClearMs = 0;
    t.totalOverlayMs = 0;
    t.totalStatusMs = 0;
    t.worstFrameMs = 0;
    t.worstFramePhase = 'none';
    t.maxBrushMs = 0;
    t.maxClearMs = 0;
    t.maxOverlayMs = 0;
    t.maxStatusMs = 0;
    t.longTaskCount = 0;
    t.longTaskTotalMs = 0;
    t.throttleGapCount = 0;
    t.visibilityChanges = 0;
    t.focusLostCount = 0;
    t.pageHideCount = 0;
    t.freezeCount = 0;
    t.hiddenAt = document.visibilityState === 'hidden' ? performance.now() : 0;
    t.hiddenMs = 0;
    t.visibilityState = document.visibilityState;
    t.focused = document.hasFocus();
    t.memoryMB = null;
    t.recentEvents.length = 0;
    t.lastUiRefreshAt = 0;
  }

  _notePerformanceEvent(message) {
    const t = this._performanceTelemetry;
    const stamp = (performance.now() / 1000).toFixed(1) + 's';
    t.recentEvents.unshift(`${stamp} ${message}`);
    if (t.recentEvents.length > PERF_RECENT_EVENT_LIMIT) t.recentEvents.length = PERF_RECENT_EVENT_LIMIT;
  }

  _persistPerformancePreference(key, enabled) {
    try {
      localStorage.setItem(key, enabled ? '1' : '0');
    } catch { /* ignore persistence errors */ }
  }

  _loadPerformancePreference(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (value == null) return fallback;
      return value === '1';
    } catch {
      return fallback;
    }
  }

  _initPerformanceTelemetry() {
    const t = this._performanceTelemetry;
    if (t.initialized) return;
    t.initialized = true;
    t.enabled = this._loadPerformancePreference(PERF_TELEMETRY_KEY, true);
    t.wakeLockPreferred = this._loadPerformancePreference(PERF_WAKE_LOCK_KEY, false);
    this._resetPerformanceTelemetryStats();
    this._notePerformanceEvent('telemetry initialized');
    t.enabledEl = document.getElementById('perfTelemetryEnabled');
    t.wakeLockEl = document.getElementById('perfWakeLockEnabled');
    t.readoutEl = document.getElementById('perfTelemetryReadout');

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        t.observer = new PerformanceObserver(list => {
          if (!t.enabled) return;
          for (const entry of list.getEntries()) {
            t.longTaskCount++;
            t.longTaskTotalMs += entry.duration;
            this._notePerformanceEvent(`long task ${entry.duration.toFixed(1)}ms`);
          }
          this._refreshPerformanceTelemetryUI(true);
        });
        t.observer.observe({ entryTypes: ['longtask'] });
      } catch { /* unsupported */ }
    }

    document.addEventListener('visibilitychange', () => {
      t.visibilityChanges++;
      t.visibilityState = document.visibilityState;
      if (document.visibilityState === 'hidden') {
        t.hiddenAt = performance.now();
        this._releasePerformanceWakeLock();
        this._notePerformanceEvent('tab hidden');
      } else {
        if (t.hiddenAt) t.hiddenMs += performance.now() - t.hiddenAt;
        t.hiddenAt = 0;
        this._requestPerformanceWakeLock();
        this._notePerformanceEvent('tab visible');
      }
      this._refreshPerformanceTelemetryUI(true);
    });
    window.addEventListener('focus', () => {
      t.focused = true;
      this._requestPerformanceWakeLock();
      this._refreshPerformanceTelemetryUI(true);
    });
    window.addEventListener('blur', () => {
      t.focused = false;
      t.focusLostCount++;
      this._notePerformanceEvent('window blurred');
      this._refreshPerformanceTelemetryUI(true);
    });
    window.addEventListener('pagehide', () => {
      t.pageHideCount++;
      this._releasePerformanceWakeLock();
      this._notePerformanceEvent('page hidden by browser');
      this._refreshPerformanceTelemetryUI(true);
    });
    window.addEventListener('pageshow', () => {
      this._requestPerformanceWakeLock();
      this._notePerformanceEvent('page shown by browser');
      this._refreshPerformanceTelemetryUI(true);
    });
    document.addEventListener('freeze', () => {
      t.freezeCount++;
      this._notePerformanceEvent('page lifecycle freeze');
      this._refreshPerformanceTelemetryUI(true);
    });
    document.addEventListener('resume', () => {
      this._notePerformanceEvent('page lifecycle resume');
      this._requestPerformanceWakeLock();
      this._refreshPerformanceTelemetryUI(true);
    });

    this._requestPerformanceWakeLock();
    this._refreshPerformanceTelemetryUI(true);
  }

  setPerformanceTelemetryEnabled(enabled) {
    const t = this._performanceTelemetry;
    t.enabled = !!enabled;
    this._persistPerformancePreference(PERF_TELEMETRY_KEY, t.enabled);
    this._resetPerformanceTelemetryStats();
    this._notePerformanceEvent(t.enabled ? 'telemetry enabled' : 'telemetry disabled');
    this._refreshPerformanceTelemetryUI(true);
    this.showToast(t.enabled ? '📊 Perf telemetry enabled' : '📊 Perf telemetry disabled');
  }

  async setPerformanceWakeLockEnabled(enabled) {
    const t = this._performanceTelemetry;
    t.wakeLockPreferred = !!enabled;
    this._persistPerformancePreference(PERF_WAKE_LOCK_KEY, t.wakeLockPreferred);
    if (t.wakeLockPreferred) await this._requestPerformanceWakeLock();
    else await this._releasePerformanceWakeLock();
    this._refreshPerformanceTelemetryUI(true);
    this.showToast(t.wakeLockPreferred ? '🔆 Wake lock requested' : '🔆 Wake lock released');
  }

  async _requestPerformanceWakeLock() {
    const t = this._performanceTelemetry;
    if (!t.wakeLockPreferred || document.visibilityState !== 'visible' || !navigator.wakeLock) {
      t.wakeLockActive = false;
      return false;
    }
    if (this._wakeLockSentinel && !this._wakeLockSentinel.released) {
      t.wakeLockActive = true;
      return true;
    }
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      this._wakeLockSentinel = sentinel;
      t.wakeLockActive = true;
      sentinel.addEventListener('release', () => {
        if (this._wakeLockSentinel === sentinel) {
          this._wakeLockSentinel = null;
          t.wakeLockActive = false;
          this._refreshPerformanceTelemetryUI(true);
        }
      });
      this._notePerformanceEvent('screen wake lock acquired');
      return true;
    } catch (err) {
      t.wakeLockActive = false;
      this._notePerformanceEvent(`wake lock unavailable (${err?.name || 'error'})`);
      return false;
    } finally {
      this._refreshPerformanceTelemetryUI(true);
    }
  }

  async _releasePerformanceWakeLock() {
    const t = this._performanceTelemetry;
    const sentinel = this._wakeLockSentinel;
    this._wakeLockSentinel = null;
    t.wakeLockActive = false;
    if (!sentinel) return;
    try {
      await sentinel.release();
    } catch { /* already released */ }
  }

  _recordPerformanceFrame(frame) {
    const t = this._performanceTelemetry;
    if (!t.enabled) return;
    if (this._isPerformanceThrottleGap(frame)) {
      t.throttleGapCount++;
      this._notePerformanceEvent(`raf gap ${frame.deltaMs.toFixed(1)}ms`);
    }
    if (frame.hidden) {
      this._refreshPerformanceTelemetryUI();
      return;
    }
    t.frameCount++;
    t.totalFrameMs += frame.totalMs;
    t.totalBrushMs += frame.brushMs;
    t.totalClearMs += frame.clearMs;
    t.totalOverlayMs += frame.overlayMs;
    t.totalStatusMs += frame.statusMs;
    t.maxBrushMs = Math.max(t.maxBrushMs, frame.brushMs);
    t.maxClearMs = Math.max(t.maxClearMs, frame.clearMs);
    t.maxOverlayMs = Math.max(t.maxOverlayMs, frame.overlayMs);
    t.maxStatusMs = Math.max(t.maxStatusMs, frame.statusMs);
    if (frame.totalMs >= PERF_SLOW_FRAME_MS) {
      t.slowFrameCount++;
      const phases = [
        ['brush', frame.brushMs],
        ['overlay', frame.overlayMs],
        ['clear', frame.clearMs],
        ['status', frame.statusMs],
      ];
      phases.sort((a, b) => b[1] - a[1]);
      if (frame.totalMs > t.worstFrameMs) {
        t.worstFrameMs = frame.totalMs;
        t.worstFramePhase = phases[0][0];
      }
    }
    if (performance.memory?.usedJSHeapSize) {
      t.memoryMB = performance.memory.usedJSHeapSize / (1024 * 1024);
    }
    this._refreshPerformanceTelemetryUI();
  }

  _isPerformanceThrottleGap(frame) {
    const t = this._performanceTelemetry;
    return Number.isFinite(frame.deltaMs)
      && t.lastFrameAt
      && t.focused
      && t.visibilityState === 'visible'
      && frame.deltaMs >= PERF_THROTTLE_GAP_MS;
  }

  _refreshPerformanceTelemetryUI(force = false) {
    const t = this._performanceTelemetry;
    const now = performance.now();
    if (!force && now - t.lastUiRefreshAt < PERF_UI_REFRESH_MS) return;
    t.lastUiRefreshAt = now;
    const enabledEl = t.enabledEl;
    const wakeLockEl = t.wakeLockEl;
    const readoutEl = t.readoutEl;
    if (enabledEl) enabledEl.checked = !!t.enabled;
    if (wakeLockEl) wakeLockEl.checked = !!t.wakeLockPreferred;
    if (!readoutEl) return;
    if (!t.enabled) {
      readoutEl.textContent = 'Telemetry is off.';
      return;
    }
    const frameCount = Math.max(t.frameCount, 1);
    const avgFrame = t.totalFrameMs / frameCount;
    const fps = avgFrame > 0 ? 1000 / avgFrame : 0;
    const hiddenMs = t.hiddenMs + (t.hiddenAt ? performance.now() - t.hiddenAt : 0);
    const wakeLockState = t.wakeLockPreferred
      ? ` • wake ${t.wakeLockActive ? 'on' : 'waiting'}`
      : '';
    const lines = [
      `State: ${t.visibilityState}${t.focused ? ' • focused' : ' • blurred'}${wakeLockState}`,
      `Frames: ${t.frameCount} • avg ${avgFrame.toFixed(1)}ms • ~${fps.toFixed(0)}fps • slow ${t.slowFrameCount}`,
      `Attribution: brush ${(t.totalBrushMs / frameCount).toFixed(1)} • overlay ${(t.totalOverlayMs / frameCount).toFixed(1)} • clear ${(t.totalClearMs / frameCount).toFixed(1)} • status ${(t.totalStatusMs / frameCount).toFixed(1)} ms/frame`,
      `Worst: ${t.worstFrameMs.toFixed(1)}ms (${t.worstFramePhase}) • long tasks ${t.longTaskCount} (${t.longTaskTotalMs.toFixed(0)}ms) • raf gaps ${t.throttleGapCount}`,
      `Lifecycle: hidden ${(hiddenMs / 1000).toFixed(1)}s • vis ${t.visibilityChanges} • blur ${t.focusLostCount} • pagehide ${t.pageHideCount} • freeze ${t.freezeCount}`,
      `Device: ${t.hardwareConcurrency || '?'} cores • ${t.deviceMemoryGB || '?'}GB mem${t.memoryMB != null ? ` • heap ${t.memoryMB.toFixed(0)}MB` : ''}`,
    ];
    if (t.recentEvents.length) lines.push(`Recent: ${t.recentEvents.slice(0, 3).join(' | ')}`);
    readoutEl.textContent = lines.join('\n');
  }

  _getPerformanceStatusSummary() {
    const t = this._performanceTelemetry;
    if (!t.enabled || t.frameCount === 0) return '';
    const avgFrame = t.totalFrameMs / t.frameCount;
    const fps = avgFrame > 0 ? 1000 / avgFrame : 0;
    return `Perf ${fps.toFixed(0)}fps ${avgFrame.toFixed(1)}ms LT:${t.longTaskCount} Gap:${t.throttleGapCount}${t.wakeLockPreferred ? ` WL:${t.wakeLockActive ? 'on' : 'wait'}` : ''}`;
  }

  _buildPerformanceTelemetrySnapshot() {
    const t = this._performanceTelemetry;
    const frameCount = Math.max(t.frameCount, 1);
    return JSON.stringify({
      enabled: t.enabled,
      wakeLockPreferred: t.wakeLockPreferred,
      wakeLockActive: t.wakeLockActive,
      visibilityState: t.visibilityState,
      focused: t.focused,
      frames: t.frameCount,
      avgFrameMs: +(t.totalFrameMs / frameCount).toFixed(3),
      avgBrushMs: +(t.totalBrushMs / frameCount).toFixed(3),
      avgOverlayMs: +(t.totalOverlayMs / frameCount).toFixed(3),
      avgClearMs: +(t.totalClearMs / frameCount).toFixed(3),
      avgStatusMs: +(t.totalStatusMs / frameCount).toFixed(3),
      slowFrames: t.slowFrameCount,
      worstFrameMs: +t.worstFrameMs.toFixed(3),
      worstFramePhase: t.worstFramePhase,
      longTasks: t.longTaskCount,
      longTaskTotalMs: +t.longTaskTotalMs.toFixed(3),
      rafGaps: t.throttleGapCount,
      hiddenMs: +(t.hiddenMs + (t.hiddenAt ? performance.now() - t.hiddenAt : 0)).toFixed(3),
      visibilityChanges: t.visibilityChanges,
      blurCount: t.focusLostCount,
      pageHideCount: t.pageHideCount,
      freezeCount: t.freezeCount,
      memoryMB: t.memoryMB == null ? null : +t.memoryMB.toFixed(3),
      hardwareConcurrency: t.hardwareConcurrency,
      deviceMemoryGB: t.deviceMemoryGB,
      recentEvents: t.recentEvents,
    }, null, 2);
  }

  async copyPerformanceTelemetrySnapshot() {
    const snapshot = this._buildPerformanceTelemetrySnapshot();
    try {
      await navigator.clipboard.writeText(snapshot);
      this.showToast('📋 Perf snapshot copied');
    } catch {
      console.info(snapshot);
      this.showToast('📋 Perf snapshot logged to console');
    }
  }

  resetPerformanceTelemetry() {
    this._resetPerformanceTelemetryStats();
    this._notePerformanceEvent('telemetry reset');
    this._refreshPerformanceTelemetryUI(true);
    this.showToast('♻ Perf telemetry reset');
  }

  // ========================================================
  // FRAME LOOP
  // ========================================================

  _frameLoop() {
    const perf = this._performanceTelemetry.enabled ? this._performanceTelemetry : null;
    const frameStart = perf ? performance.now() : 0;
    const deltaMs = perf && perf.lastFrameAt ? frameStart - perf.lastFrameAt : 0;
    if (perf) perf.lastFrameAt = frameStart;
    if (document.visibilityState === 'hidden') {
      // Hidden tabs are browser-throttled anyway; skip the heavy frame work so
      // we do not keep behaving like a costly background tab.
      if (perf) this._recordPerformanceFrame({ deltaMs, totalMs: 0, brushMs: 0, clearMs: 0, overlayMs: 0, statusMs: 0, hidden: true });
      this._rafId = requestAnimationFrame(() => this._frameLoop());
      return;
    }
    const elapsed = (performance.now() - this._startTime) / 1000;
    const brush = this.getCurrentBrush();
    const p = this.getP();
    let brushMs = 0;
    let clearMs = 0;
    let overlayMs = 0;
    let statusMs = 0;

    // Taper pass — after stroke ends
    const brushStart = perf ? performance.now() : 0;
    if (this.isTapering && brush && brush.taperFrame) {
      this.taperFrame++;
      const t = this.taperFrame / this.taperTotal;
      if (t >= 1) {
        this.isTapering = false;
      } else {
        brush.taperFrame(t, p);
      }
    }

    // Active brush frame (e.g. boid step)
    if (this.simulation.running) this._updateSimulationLeader(elapsed, p);
    if (this.isDrawing && brush && brush.onFrame) {
      brush.onFrame(elapsed);
    } else if (!this.isDrawing && !this.isTapering && brush && brush.onHoverFrame) {
      // Step hover simulation (boid flocking / bristle physics) without stamping
      // Skip during taper — taperFrame already steps the sim
      brush.onHoverFrame(elapsed);
    }
    if (perf) brushMs = performance.now() - brushStart;

    // Update live overlay (particle visualization)
    const clearStart = perf ? performance.now() : 0;
    this.lctx.clearRect(0, 0, this.W, this.H);
    if (perf) clearMs = performance.now() - clearStart;

    // Brush size cursor preview
    const overlayStart = perf ? performance.now() : 0;
    if (this._cursorX >= 0 && this._cursorY >= 0) {
      const canvasPos = this._screenToCanvas(this._cursorX, this._cursorY);
      const radius = p.stampSize / 2;
      this.lctx.save();
      this.lctx.strokeStyle = 'rgba(255,255,255,0.5)';
      this.lctx.lineWidth = 1;
      this.lctx.beginPath();
      this.lctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
      this.lctx.stroke();
      this.lctx.restore();
    }

    if (brush && brush.drawOverlay) {
      brush.drawOverlay(this.lctx, p);
    }
    this.drawSimulationOverlay(this.lctx);
    // Selection overlay (marching ants)
    if (this.selectionMgr) this.selectionMgr.drawOverlay(this.lctx, elapsed);
    // Floating pixel preview (during move/transform drag)
    if (this.selectionMgr) this.selectionMgr.drawFloatingPreview(this.lctx);
    // Transform handles
    if (this.selectionMgr?.transformActive) this.selectionMgr.drawTransformHandles(this.lctx);

    // Tiling mode boundary indicator
    if (this.tilingMode) {
      this.lctx.save();
      this.lctx.strokeStyle = 'rgba(255,200,50,0.3)';
      this.lctx.lineWidth = 1;
      this.lctx.setLineDash([8, 4]);
      this.lctx.strokeRect(0, 0, this.W, this.H);
      this.lctx.restore();
    }
    if (perf) overlayMs = performance.now() - overlayStart;

    // Update status
    const statusStart = perf ? performance.now() : 0;
    this._updateStatus(brush);
    if (perf) {
      statusMs = performance.now() - statusStart;
      this._recordPerformanceFrame({
        deltaMs,
        totalMs: performance.now() - frameStart,
        brushMs,
        clearMs,
        overlayMs,
        statusMs,
        hidden: false,
      });
    }

    this._rafId = requestAnimationFrame(() => this._frameLoop());
  }

  _updateStatus(brush) {
    let info = `${this.W}×${this.H} | Layer ${this.activeLayerIdx + 1}/${this.layers.length}`;
    if (this.viewZoom !== 1 || this.viewRotation !== 0) {
      info += ` | ${Math.round(this.viewZoom * 100)}%`;
      if (this.viewRotation !== 0) info += ` ${Math.round(this.viewRotation * 180 / Math.PI)}°`;
    }
    if (this.simulation.running) info += ' | Sim: running';
    else if (this.simulation.paused) info += ' | Sim: paused';
    if (brush && brush.getStatusInfo) info += ` | ${brush.getStatusInfo()}`;
    const perf = this._getPerformanceStatusSummary();
    if (perf) info += ` | ${perf}`;
    this.statusEl.textContent = info;
  }

  // ========================================================
  // STAMP HELPERS
  // ========================================================

  _markStampDirty(ctx, x, y, size, extraPad = 0) {
    const half = size / 2 + Math.max(2, extraPad);
    this._markContextDirty(ctx, {
      x: x - half,
      y: y - half,
      w: half * 2,
      h: half * 2,
    });
  }

  stampCircle(ctx, x, y, size, color, opacity) {
    const p = this._cachedP || this.getP();
    const textureEnabled = this.hasCanvasTexture() && p.canvasTextureEnabled;
    let drawSize = size;
    let dirtyExtraPad = 0;
    // Modulate opacity by canvas texture if enabled
    if (textureEnabled) {
      opacity *= this.getTextureDepositDensity(x, y, p);
      const edgeBreakup = this.getTextureEdgeBreakup(x, y, p);
      if (edgeBreakup > 0) {
        const field = this.sampleTextureField(x, y, p);
        drawSize = size * Math.max(
          TEXTURE_EDGE_BREAKUP_MIN_SIZE,
          1 - edgeBreakup * TEXTURE_EDGE_BREAKUP_SIZE_SCALE + (field.valley - 0.5) * edgeBreakup * TEXTURE_EDGE_BREAKUP_VALLEY_SCALE,
        );
      }
    }
    // Kubelka-Munk pigment mixing: blend brush colour with existing canvas colour
    // physically (subtractive mixing) before smudge logic takes over
    if (p.kmMix && p.kmStrength > 0 && !p.smudge) {
      const sampled = this._sampleSmudgeColor(x, y);
      if (sampled.a > 10) {
        const mixed = this._kmMixColors(color, sampled.r, sampled.g, sampled.b, p.kmStrength);
        color = `rgb(${mixed.r},${mixed.g},${mixed.b})`;
      }
    }
    // Smudge: blend brush colour with existing canvas colour
    if (p.smudge > 0) {
      const smudgePoint = textureEnabled ? this.getTextureSmudgeOffset(x, y, drawSize, p) : { x, y };
      const sampled = this._sampleSmudgeColor(smudgePoint.x, smudgePoint.y);
      if (sampled.a > 0) {
        if (p.smudgeOnly) {
          // Smudge-only: stamp purely with the sampled canvas colour
          // Modulate by area-averaged alpha so stamps fade at edges near transparent pixels
          color = `rgb(${sampled.r},${sampled.g},${sampled.b})`;
          opacity *= this._sampleSmudgeAreaAlpha(smudgePoint.x, smudgePoint.y, drawSize);
        } else {
          const brush = this._parseColorToRGB(color);
          const s = p.smudge * (sampled.a / 255); // scale by sampled alpha
          const r = Math.round(brush.r * (1 - s) + sampled.r * s);
          const g = Math.round(brush.g * (1 - s) + sampled.g * s);
          const b = Math.round(brush.b * (1 - s) + sampled.b * s);
          color = `rgb(${r},${g},${b})`;
        }
      } else if (p.smudgeOnly) {
        // Nothing on canvas to smudge — skip stamp entirely
        return;
      }
    } else if (p.smudgeOnly) {
      // Smudge is 0 but smudgeOnly is on — nothing to do
      return;
    }
    ctx.beginPath();
    ctx.arc(x, y, drawSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    const activeLayer = this.getActiveLayer();
    const useAlphaLock = activeLayer && activeLayer.alphaLock && this.activeBrush !== 'eraser';
    if (useAlphaLock) ctx.globalCompositeOperation = 'source-atop';
    ctx.fill();
    if (textureEnabled) {
      const breakup = this.getTextureEdgeBreakup(x, y, p);
      if (breakup > 0.12) {
        const flow = this.sampleTextureFlowVector(x, y, p);
        const feather = Math.max(TEXTURE_EDGE_FEATHER_MIN_DISTANCE, drawSize * TEXTURE_EDGE_FEATHER_DISTANCE_SCALE * breakup);
        dirtyExtraPad = Math.max(
          dirtyExtraPad,
          Math.hypot(flow.x * feather, flow.y * feather) + Math.max(1, drawSize * (0.12 + breakup * 0.04)),
        );
        ctx.globalAlpha = opacity * breakup * TEXTURE_EDGE_FEATHER_OPACITY_SCALE;
        ctx.beginPath();
        ctx.arc(x + flow.x * feather, y + flow.y * feather, Math.max(0.5, drawSize * (0.22 + breakup * 0.08)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (useAlphaLock) ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Impasto: stamp onto the height map proportionally to stamp opacity
    if (p.impasto && p.impastoStrength > 0 && this._heightCtx) {
      const hctx = this._heightCtx;
      hctx.beginPath();
      hctx.arc(x * this.DPR, y * this.DPR, (drawSize / 2) * this.DPR, 0, Math.PI * 2);
      hctx.fillStyle = '#ffffff';
      hctx.globalAlpha = Math.min(opacity * p.impastoStrength, 1);
      hctx.fill();
      hctx.globalAlpha = 1;
      this._heightDirty = true;
    }

    this._markStampDirty(ctx, x, y, drawSize, dirtyExtraPad);

    // Tiling: wrap stamp at canvas edges
    if (this.tilingMode) {
      const r = size / 2;
      const W = this.W, H = this.H;
      const overLeft = x - r < 0, overRight = x + r > W;
      const overTop = y - r < 0, overBottom = y + r > H;
      const wraps = [];
      if (overLeft)  wraps.push([x + W, y]);
      if (overRight) wraps.push([x - W, y]);
      if (overTop)    wraps.push([x, y + H]);
      if (overBottom) wraps.push([x, y - H]);
      // Corners
      if (overLeft  && overTop)    wraps.push([x + W, y + H]);
      if (overRight && overTop)    wraps.push([x - W, y + H]);
      if (overLeft  && overBottom) wraps.push([x + W, y - H]);
      if (overRight && overBottom) wraps.push([x - W, y - H]);

      for (const [wx, wy] of wraps) {
        if (useAlphaLock) ctx.globalCompositeOperation = 'source-atop';
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = opacity;
        ctx.fill();
        if (useAlphaLock) ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        // Impasto for wrapped stamps
        if (p.impasto && p.impastoStrength > 0 && this._heightCtx) {
          const hctx = this._heightCtx;
          hctx.beginPath();
          hctx.arc(wx * this.DPR, wy * this.DPR, r * this.DPR, 0, Math.PI * 2);
          hctx.fillStyle = '#ffffff';
          hctx.globalAlpha = Math.min(opacity * p.impastoStrength, 1);
          hctx.fill();
          hctx.globalAlpha = 1;
          this._heightDirty = true;
        }
        this._markStampDirty(ctx, wx, wy, size, dirtyExtraPad);
      }
    }
  }

  /**
   * Parse any CSS colour string to {r, g, b}.
   * Fast path for #rrggbb / #rgb hex; canvas fallback for hsl(), rgb(), etc.
   */
  _parseColorToRGB(color) {
    if (color[0] === '#') {
      let hex = color.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      const n = parseInt(hex, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    // Fallback: render into 1×1 canvas and read back
    const c = this._colorParseCtx;
    c.clearRect(0, 0, 1, 1);
    c.fillStyle = color;
    c.fillRect(0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }

  /**
   * Flood-fill a contiguous region of similar colour on the active layer.
   * Receives CSS-pixel coordinates and converts to device pixels internally.
   */
  _floodFill(x, y) {
    const layer = this.getActiveLayer();
    if (!layer) return;

    this.pushUndo();

    const dpr = this.DPR;
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    const w = layer.canvas.width;
    const h = layer.canvas.height;

    if (px < 0 || px >= w || py < 0 || py >= h) return;

    // Read current layer pixels
    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    const imageData = layer.ctx.getImageData(0, 0, w, h);
    layer.ctx.restore();
    const data = imageData.data;

    // Target colour at click point
    const idx = (py * w + px) * 4;
    const targetR = data[idx], targetG = data[idx + 1], targetB = data[idx + 2], targetA = data[idx + 3];

    // Fill colour from primary colour picker
    const fill = this._parseColorToRGB(this.primaryEl.value);
    const fillR = fill.r, fillG = fill.g, fillB = fill.b, fillA = 255;

    // Don't fill if target already matches fill colour
    if (targetR === fillR && targetG === fillG && targetB === fillB && targetA === fillA) return;

    // Tolerance from sidebar slider
    const tolEl = document.getElementById('fillTolerance');
    const tolerance = tolEl ? +tolEl.value : 32;

    function colorMatch(i) {
      return Math.abs(data[i] - targetR) <= tolerance &&
             Math.abs(data[i + 1] - targetG) <= tolerance &&
             Math.abs(data[i + 2] - targetB) <= tolerance &&
             Math.abs(data[i + 3] - targetA) <= tolerance;
    }

    // Scanline flood fill
    const visited = new Uint8Array(w * h);
    const stack = [[px, py]];

    while (stack.length > 0) {
      const [cx, cy] = stack.pop();
      const ci = cy * w + cx;
      if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
      if (visited[ci]) continue;
      if (!colorMatch(ci * 4)) continue;

      // Find leftmost pixel in this row
      let left = cx;
      while (left > 0 && !visited[cy * w + left - 1] && colorMatch((cy * w + left - 1) * 4)) left--;

      // Find rightmost pixel in this row
      let right = cx;
      while (right < w - 1 && !visited[cy * w + right + 1] && colorMatch((cy * w + right + 1) * 4)) right++;

      for (let fx = left; fx <= right; fx++) {
        const fi = cy * w + fx;
        visited[fi] = 1;
        const di = fi * 4;
        data[di] = fillR;
        data[di + 1] = fillG;
        data[di + 2] = fillB;
        data[di + 3] = fillA;

        if (cy > 0 && !visited[(cy - 1) * w + fx] && colorMatch(((cy - 1) * w + fx) * 4)) stack.push([fx, cy - 1]);
        if (cy < h - 1 && !visited[(cy + 1) * w + fx] && colorMatch(((cy + 1) * w + fx) * 4)) stack.push([fx, cy + 1]);
      }
    }

    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.putImageData(imageData, 0, 0);
    layer.ctx.restore();
    layer.dirty = true;
    this.compositeAllLayers();
    this.showToast('🪣 Filled');
  }

  /**
   * Sample the active layer colour at CSS coordinate (x, y).
   * Uses a cached ImageData snapshot that is invalidated each compositeAllLayers().
   */
  _sampleSmudgeColor(x, y) {
    const layer = this.getActiveLayer();
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    // Lazy-capture once per composite cycle
    if (!this._smudgeImageData) {
      this._smudgeImageData = layer.ctx.getImageData(0, 0, w, h);
    }
    // Convert CSS coordinates to canvas bitmap pixels (canvas is scaled by DPR)
    const dpr = this.DPR;
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    if (px < 0 || py < 0 || px >= w || py >= h) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    const off = (py * w + px) * 4;
    const d = this._smudgeImageData.data;
    return { r: d[off], g: d[off + 1], b: d[off + 2], a: d[off + 3] };
  }

  /**
   * Sample the average alpha within a circular stamp footprint on the active layer.
   * Returns 0–1. Samples 9 points (center + 8 surrounding at half-radius) for
   * performance, giving a smooth fade-out at edges near transparent pixels.
   */
  _sampleSmudgeAreaAlpha(x, y, size) {
    const layer = this.getActiveLayer();
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    if (!this._smudgeImageData) {
      this._smudgeImageData = layer.ctx.getImageData(0, 0, w, h);
    }
    const dpr = this.DPR;
    const r = size / 2 * 0.5; // sample at half-radius
    const d = this._smudgeImageData.data;
    // 9 sample offsets: center + 4 cardinal + 4 diagonal at half-radius
    const offsets = [
      [0, 0],
      [r, 0], [-r, 0], [0, r], [0, -r],
      [r * 0.707, r * 0.707], [-r * 0.707, r * 0.707],
      [r * 0.707, -r * 0.707], [-r * 0.707, -r * 0.707],
    ];
    let sum = 0;
    let count = 0;
    for (const [dx, dy] of offsets) {
      const px = Math.round((x + dx) * dpr);
      const py = Math.round((y + dy) * dpr);
      if (px >= 0 && py >= 0 && px < w && py < h) {
        sum += d[(py * w + px) * 4 + 3]; // alpha channel
        count++;
      }
    }
    return count > 0 ? (sum / count) / 255 : 0;
  }

  /**
   * Kubelka-Munk two-flux reflectance mixing.
   * Converts brush and canvas colours to K/S coefficients, mixes them by
   * brushStrength, and converts back to RGB — producing physically-based
   * subtractive pigment mixing (blue + yellow → vibrant green).
   *
   * @param {string} brushColorHex  Hex colour string of the brush (e.g. "#ff0000")
   * @param {number} canvasR        Existing canvas red   channel (0–255)
   * @param {number} canvasG        Existing canvas green channel (0–255)
   * @param {number} canvasB        Existing canvas blue  channel (0–255)
   * @param {number} strength       Mix strength 0–1 (1 = full brush colour)
   * @returns {{ r: number, g: number, b: number }}
   */
  _kmMixColors(brushColorHex, canvasR, canvasG, canvasB, strength) {
    const brushRGB = this._parseColorToRGB(brushColorHex);

    // Convert 0-255 channel to linear reflectance [0.001, 0.999]
    const toR = v => Math.max(0.001, Math.min(0.999, v / 255));
    // Kubelka-Munk remission function: K/S = (1 - R)² / (2R)
    const toKS = R => ((1 - R) * (1 - R)) / (2 * R);
    // Convert K/S back to reflectance: R = 1 + K/S - sqrt((K/S)² + 2*(K/S))
    const toRefl = ks => {
      const r = 1 + ks - Math.sqrt(ks * ks + 2 * ks);
      return Math.max(0, Math.min(1, r));
    };

    const channels = [
      [brushRGB.r, canvasR],
      [brushRGB.g, canvasG],
      [brushRGB.b, canvasB],
    ];

    const mixed = channels.map(([bv, cv]) => {
      const Rb = toR(bv);
      const Rc = toR(cv);
      const KSb = toKS(Rb);
      const KSc = toKS(Rc);
      // Separate K and S using a fixed K:S ratio derived from KS composite
      // Simplified assumption: S=1, K=KS (valid for opaque pigments)
      const Kb = KSb, Sb = 1;
      const Kc = KSc, Sc = 1;
      const Kmix = strength * Kb + (1 - strength) * Kc;
      const Smix = strength * Sb + (1 - strength) * Sc;
      const KSmix = Kmix / Smix;
      return Math.round(toRefl(KSmix) * 255);
    });

    return { r: mixed[0], g: mixed[1], b: mixed[2] };
  }

  /**
   * Compute a lighting overlay canvas from the height map using Sobel normals
   * and a directional light model (Phong N·L).
   * Only called when _heightDirty is true; result is cached as _impastoOverlayCanvas.
   */
  _computeImpastoOverlay(p) {
    if (!this._heightCanvas || this._heightCanvas.width === 0) return null;
    const w = this._heightCanvas.width;
    const h = this._heightCanvas.height;
    const src = this._heightCtx.getImageData(0, 0, w, h).data;

    // Build a greyscale height array (using red channel)
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      height[i] = src[i * 4] / 255;
    }

    // Light direction from angle + elevation
    const la = p.impastoLightAngle;      // azimuth in radians
    const le = p.impastoLightElevation;  // elevation in radians
    const Lx = Math.cos(le) * Math.cos(la);
    const Ly = Math.cos(le) * Math.sin(la);
    const Lz = Math.sin(le);

    // Create output canvas
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const imgData = octx.createImageData(w, h);
    const od = imgData.data;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        // Sobel kernel to approximate surface gradient
        const tl = height[(y - 1) * w + (x - 1)];
        const tc = height[(y - 1) * w + x];
        const tr = height[(y - 1) * w + (x + 1)];
        const ml = height[y * w + (x - 1)];
        const mr = height[y * w + (x + 1)];
        const bl = height[(y + 1) * w + (x - 1)];
        const bc = height[(y + 1) * w + x];
        const br = height[(y + 1) * w + (x + 1)];

        const nx = -(tr + 2 * mr + br - tl - 2 * ml - bl);
        const ny = -(bl + 2 * bc + br - tl - 2 * tc - tr);
        const nz = 1.0;
        // Normalise; nz=1 guarantees len >= 1, but guard for safety
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const Nx = len > 1e-6 ? nx / len : 0;
        const Ny = len > 1e-6 ? ny / len : 0;
        const Nz = len > 1e-6 ? nz / len : 1;

        // N·L dot product, clamped
        const NdotL = Math.max(0, Math.min(1, Nx * Lx + Ny * Ly + Nz * Lz));

        // Map to output: 128 is neutral; above = highlights, below = shadows
        const v = Math.round(128 + (NdotL - 0.5) * 200);
        const off = (y * w + x) * 4;
        od[off] = v;
        od[off + 1] = v;
        od[off + 2] = v;
        od[off + 3] = 255;
      }
    }

    octx.putImageData(imgData, 0, 0);
    return out;
  }

  getSymmetryPoints(x, y) {
    const p = this.getP();
    if (!p.symmetryEnabled) return [{ x, y }];
    const cx = p.symmetryCenterX * this.W;
    const cy = p.symmetryCenterY * this.H;
    const pts = [];
    const n = p.symmetryCount;
    const dx = x - cx, dy = y - cy;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const cos = Math.cos(a), sin = Math.sin(a);
      pts.push({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos });
      if (p.symmetryMirror) {
        pts.push({ x: cx + dx * cos + dy * sin, y: cy + dx * sin - dy * cos });
      }
    }
    return pts;
  }

  symStamp(ctx, x, y, size, color, opacity) {
    for (const pt of this.getSymmetryPoints(x, y)) {
      this.stampCircle(ctx, pt.x, pt.y, size, color, opacity);
    }
  }

  // ========================================================
  // SENSING (for boid brush)
  // ========================================================

  buildSensingData() {
    const p = this.getP();
    const src = p.sensingSource;
    const w = this.W * this.DPR, h = this.H * this.DPR;
    if (src === 'active') {
      // Read directly from the active layer bitmap; the reusable offscreen
      // surface only helps when multiple layers must be composited first.
      const l = this.getActiveLayer();
      return l.ctx.getImageData(0, 0, w, h);
    }
    if (!this._sensingCompositeCanvas) {
      this._sensingCompositeCanvas = document.createElement('canvas');
      this._sensingCompositeCtx = this._sensingCompositeCanvas.getContext('2d');
    }
    const tmp = this._sensingCompositeCanvas;
    if (tmp.width !== w || tmp.height !== h) {
      tmp.width = w;
      tmp.height = h;
    }
    const tc = this._sensingCompositeCtx;
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, w, h);

    if (src === 'below') {
      // Layers below active
      for (let i = this.layers.length - 1; i > this.activeLayerIdx; i--) {
        const l = this.layers[i];
        if (!l.visible) continue;
        tc.globalAlpha = l.opacity;
        tc.globalCompositeOperation = l.blend;
        tc.drawImage(l.canvas, 0, 0);
      }
    } else if (src === 'all') {
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const l = this.layers[i];
        if (!l.visible) continue;
        tc.globalAlpha = l.opacity;
        tc.globalCompositeOperation = l.blend;
        tc.drawImage(l.canvas, 0, 0);
      }
    }
    return tc.getImageData(0, 0, w, h);
  }

  // ========================================================
  // SAVE IMAGE
  // ========================================================

  _compositeFlatCanvas() {
    const { canvas, ctx } = this.makeLayerCanvas();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.bgColorEl ? this.bgColorEl.value : '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (!l.visible) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.blend;
      ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.restore();
    return canvas;
  }

  saveImage() {
    const canvas = this._compositeFlatCanvas();
    // Use toBlob for better performance with large canvases
    canvas.toBlob(blob => {
      if (!blob) {
        // Fallback to toDataURL
        const a = document.createElement('a');
        a.download = 'boid-brush.png';
        a.href = canvas.toDataURL('image/png');
        a.click();
        this.showToast('💾 Saved');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = 'boid-brush.png';
      a.href = url;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.showToast('💾 Saved');
    }, 'image/png');
  }

  // ========================================================
  // COPY / PASTE
  // ========================================================

  async copyToClipboard() {
    // With an active selection: copy only the selected pixels from the active layer
    if (this.selectionMgr?.active) {
      try {
        const l = this.getActiveLayer();
        const bounds = this.selectionMgr.getBounds();
        const extracted = this.selectionMgr.extractPixels(l.canvas, this.DPR);
        if (!extracted) { this.showToast('⚠ Nothing selected'); return; }
        const blob = await extracted.convertToBlob({ type: 'image/png' });
        this._clipboardBlob = blob;
        this._clipboardMetadata = bounds;  // Store original location & size
        let clipboardOk = false;
        try {
          if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            clipboardOk = true;
          }
        } catch { /* Clipboard unavailable */ }
        this.showToast(clipboardOk ? '📋 Selection copied' : '📋 Selection copied (in-app)');
      } catch { this.showToast('⚠ Copy failed'); }
      return;
    }
    // No selection: copy flat composite of all layers
    try {
      const canvas = this._compositeFlatCanvas();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) { this.showToast('⚠ Copy failed'); return; }
      // Always store internally for in-app paste fallback
      this._clipboardBlob = blob;
      this._clipboardMetadata = null;  // No selection = no stored location
      let clipboardOk = false;
      try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
          clipboardOk = true;
        }
      } catch { /* Clipboard API unavailable or denied */ }
      this.showToast(clipboardOk ? '📋 Copied to clipboard' : '📋 Copied (in-app only)');
    } catch (err) {
      this.showToast('⚠ Copy failed');
    }
  }

  /** Shared helper to paste an image blob onto the active layer */
  _pasteImageBlob(blob) {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      this.pushUndo();
      const l = this.getActiveLayer();
      // If clipboard has stored bounds metadata, paste at exact original location & size
      if (this._clipboardMetadata) {
        const { x, y, w, h } = this._clipboardMetadata;
        l.ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h);
        l.dirty = true;
        this.compositeAllLayers();
        URL.revokeObjectURL(url);
        this.showToast('📋 Pasted at original location');
        return;
      }
      // If a selection is active, paste into the selection bounding box
      if (this.selectionMgr?.active) {
        const bounds = this.selectionMgr.getBounds();
        if (bounds && bounds.w > 0 && bounds.h > 0) {
          const dpr = this.DPR;
          l.ctx.save();
          l.ctx.setTransform(1, 0, 0, 1, 0, 0);
          this.selectionMgr._buildPath(l.ctx, dpr);
          l.ctx.clip();
          l.ctx.drawImage(img, bounds.x * dpr, bounds.y * dpr, bounds.w * dpr, bounds.h * dpr);
          l.ctx.restore();
          l.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          l.dirty = true;
          this.compositeAllLayers();
          URL.revokeObjectURL(url);
          this.showToast('📋 Pasted into selection');
          return;
        }
      }
      // Otherwise scale to fit canvas while maintaining aspect ratio, centered
      const srcAspect = img.width / img.height;
      const canvasAspect = this.W / this.H;
      let destW, destH;
      if (srcAspect > canvasAspect) {
        // Image is wider than canvas; fit to width
        destW = this.W;
        destH = this.W / srcAspect;
      } else {
        // Image is taller than canvas; fit to height
        destH = this.H;
        destW = this.H * srcAspect;
      }
      const destX = (this.W - destW) / 2;
      const destY = (this.H - destH) / 2;
      l.ctx.drawImage(img, 0, 0, img.width, img.height, destX, destY, destW, destH);
      l.dirty = true;
      this.compositeAllLayers();
      URL.revokeObjectURL(url);
      this.showToast('📋 Pasted');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      this.showToast('⚠ Paste failed — invalid image');
    };
    img.src = url;
  }

  async pasteFromClipboard() {
    // Tier 1: try native Clipboard API
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              this._pasteImageBlob(blob);
              return;
            }
          }
        }
      }
    } catch { /* Clipboard API unavailable or denied — fall through */ }

    // Tier 2: use internal clipboard buffer (from in-app copy)
    if (this._clipboardBlob) {
      this._pasteImageBlob(this._clipboardBlob);
      return;
    }

    // Tier 3: open a file picker as last resort
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      this._pasteImageBlob(file);
    });
    input.click();
  }

  // ========================================================
  // SESSION PERSISTENCE
  /** Cut the selected region from the active layer to clipboard. */
  async cutToClipboard() {
    if (!this.selectionMgr?.active) { this.showToast('⚠ No selection to cut'); return; }
    const l = this.getActiveLayer();
    if (l.isBackground) { this.showToast('Cannot cut from background layer'); return; }
    try {
      const extracted = this.selectionMgr.extractPixels(l.canvas, this.DPR);
      if (!extracted) { this.showToast('⚠ Cut failed'); return; }
      const blob = await extracted.convertToBlob({ type: 'image/png' });
      this._clipboardBlob = blob;
      try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }
      } catch { /* Clipboard unavailable */ }
      this.pushUndo();
      this.selectionMgr.clearPixels(l.ctx, this.DPR);
      l.dirty = true;
      this.compositeAllLayers();
      this.showToast('✂ Cut');
    } catch { this.showToast('⚠ Cut failed'); }
  }

  // ========================================================
  // COLOR HISTORY
  // ========================================================

  _recordColor(hex) {
    hex = hex.toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    const idx = this._colorHistory.indexOf(hex);
    if (idx !== -1) this._colorHistory.splice(idx, 1);
    this._colorHistory.unshift(hex);
    if (this._colorHistory.length > this._maxColorHistory) this._colorHistory.pop();
    this._renderColorHistory();
  }

  _renderColorHistory() {
    const container = document.getElementById('colorHistory');
    if (!container) return;
    container.innerHTML = '';
    for (const hex of this._colorHistory) {
      const swatch = document.createElement('div');
      swatch.style.cssText = `width:20px;height:20px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,0.15);background:${hex};transition:transform 0.1s;`;
      swatch.title = hex;
      swatch.addEventListener('click', () => {
        this.primaryEl.value = hex;
        this._paramsDirty = true;
      });
      swatch.addEventListener('mouseenter', () => swatch.style.transform = 'scale(1.2)');
      swatch.addEventListener('mouseleave', () => swatch.style.transform = 'scale(1)');
      container.appendChild(swatch);
    }
  }

  // SESSION PERSISTENCE
  // ========================================================

  saveSession() {
    try {
      // Save slider/checkbox values
      const controls = {};
      document.querySelectorAll('#sidebar input[type="range"], #sidebar input[type="checkbox"], #sidebar select').forEach(el => {
        if (el.id) controls[el.id] = el.type === 'checkbox' ? el.checked : el.value;
      });
      // Save number inputs (e.g. AI seed)
      document.querySelectorAll('#sidebar input[type="number"]').forEach(el => {
        if (el.id) controls[el.id] = el.value;
      });
      controls.primaryColor = this.primaryEl.value;
      controls.secondaryColor = this.secondaryEl.value;
      controls.bgColor = this.bgColorEl ? this.bgColorEl.value : '#ffffff';
      controls.activeBrush = this.activeBrush;
      // Save AI prompt textareas
      const promptEl = document.getElementById('aiPromptText');
      const negPromptEl = document.getElementById('aiNegPromptText');
      if (promptEl) controls._aiPrompt = promptEl.value;
      if (negPromptEl) controls._aiNegPrompt = negPromptEl.value;
      controls._colorHistory = this._colorHistory;
      controls._tilingMode = this.tilingMode;
      if (this._docSized) {
        controls._docSized = true;
        controls._docW = this._docW;
        controls._docH = this._docH;
      }
      controls._simulation = {
        enabled: this.simulation.enabled,
        inspectorCollapsed: this.simulation.inspectorCollapsed,
        editorTool: this.simulation.editorTool,
        brushData: this.simulation.brushData,
        nextId: this.simulation.nextId,
        vars: this.simulation.vars,
        sessions: this.simulation.sessions,
      };
      controls._canvasTextureState = this._serializeCanvasTextureState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(controls));
    } catch { /* quota exceeded — ignore */ }
  }

  async _restoreSession() {
    try {
      await this._ensureBuiltinCanvasTexture();
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        syncUI(this);
        return;
      }
      const controls = JSON.parse(raw);
      if (controls._canvasTextureState) {
        await this._restoreCanvasTextureState(controls._canvasTextureState);
      }
      for (const [id, val] of Object.entries(controls)) {
        if (id === '_docSized' || id === '_docW' || id === '_docH') continue;
        if (id === '_canvasTextureState') continue;
        if (id === 'primaryColor') { this.primaryEl.value = val; continue; }
        if (id === 'secondaryColor') { this.secondaryEl.value = val; continue; }
        if (id === 'bgColor') { this.setBackgroundColor(val); continue; }
        if (id === 'activeBrush') { this.setBrush(val); continue; }
        if (id === '_aiPrompt') {
          const el = document.getElementById('aiPromptText');
          if (el) el.value = val;
          const preview = document.getElementById('aiPromptPreview');
          if (preview && val) preview.textContent = val;
          continue;
        }
        if (id === '_aiNegPrompt') {
          const el = document.getElementById('aiNegPromptText');
          if (el) el.value = val;
          continue;
        }
        if (id === '_colorHistory') {
          if (Array.isArray(val)) {
            this._colorHistory = val.filter(v => typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v));
          }
          this._renderColorHistory();
          continue;
        }
        if (id === '_tilingMode') {
          this.tilingMode = !!val;
          this._syncTilingUI();
          continue;
        }
        if (id === '_simulation') {
          if (val?.brushData) this.simulation.brushData = val.brushData;
          if (typeof val?.editorTool === 'string') this.simulation.editorTool = val.editorTool;
          if (typeof val?.nextId === 'number') this.simulation.nextId = val.nextId;
          this.simulation.enabled = !!val?.enabled;
          this.simulation.inspectorCollapsed = !!val?.inspectorCollapsed;
          // Restore scene-level variable overrides (seek etc.) persisted from last use.
          // Keep the default seek value if no value was saved (first ever session).
          if (val?.vars && typeof val.vars === 'object') {
            this.simulation.vars = _normalizeSimulationVars(val.vars);
          }
          if (Array.isArray(val?.sessions)) this.simulation.sessions = val.sessions;
          continue;
        }
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = val;
        else el.value = val;
      }
      this._paramsDirty = true;
      syncUI(this);
      this._normalizeSimulationData();
      this._ensureSimulationSpawns();
      this._syncSimulationUI();
      if (controls._docSized && controls._docW && controls._docH) {
        await this.resizeDocument(controls._docW, controls._docH, this.bgColorEl?.value || '#ffffff');
      }
    } catch { /* corrupt — ignore */ }
  }

  // ========================================================
  // UTILITIES
  // ========================================================

  showToast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }

  setStatus(msg) {
    this.statusEl.textContent = msg;
  }
}
