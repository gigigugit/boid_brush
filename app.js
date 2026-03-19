// =============================================================================
// app.js — Core painting application engine
//
// Manages canvases, layers, undo/redo, parameter cache, frame loop,
// session persistence, and wires all modules together.
// =============================================================================

import { Compositor, BLEND_MODE_MAP } from './compositor.js';
import { BoidBrush, BristleBrush, SimpleBrush, EraserBrush, AIDiffusionBrush, SpawnShapes } from './brushes.js';
import { buildSidebar, syncUI, initEdgeSliders } from './ui.js';
import { AIServer } from './ai-server.js';

const STORAGE_KEY = 'bb_session_v1';
const MAX_UNDO = 20;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const WHEEL_ZOOM_IN = 1.05;
const WHEEL_ZOOM_OUT = 0.95;
// Pressure EMA alpha (~4-sample smoothing window for pointer events)
const PRESSURE_SMOOTH_ALPHA = 0.25;

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
    this.activeBrush = 'boid';

    // Drawing state
    this.isDrawing = false;
    this.pressure = 0.5;
    this._rawPressure = 0.5;  // unsmoothed pressure for EMA calculation
    this.tiltX = 0;       // stylus tilt in degrees (-90..90)
    this.tiltY = 0;
    this.azimuth = 0;     // stylus azimuth in radians (0..2π)
    this.altitude = Math.PI / 2; // stylus altitude (π/2 = vertical)
    this.leaderX = 0;
    this.leaderY = 0;
    this.undoPushedThisStroke = false;

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

    // Taper state
    this.isTapering = false;
    this.taperFrame = 0;
    this.taperTotal = 0;
    this.strokeFrame = 0;

    // Params
    this._paramsDirty = true;
    this._cachedP = null;

    // Canvas texture
    this._canvasTextureImg = null;   // greyscale HTMLCanvasElement (source tile)
    this._canvasTextureW = 0;        // source tile pixel width
    this._canvasTextureH = 0;        // source tile pixel height
    this._canvasTextureData = null;   // Uint8ClampedArray of greyscale luminance

    // Smudge: cached image data for colour sampling (invalidated each composite)
    this._smudgeImageData = null;

    // Reusable 1×1 canvas for CSS color parsing (smudge)
    this._colorParseCanvas = document.createElement('canvas');
    this._colorParseCanvas.width = 1;
    this._colorParseCanvas.height = 1;
    this._colorParseCtx = this._colorParseCanvas.getContext('2d');

    // Internal clipboard buffer (fallback when Clipboard API unavailable)
    this._clipboardBlob = null;

    // Color
    this.primaryEl = document.getElementById('primaryColor');
    this.secondaryEl = document.getElementById('secondaryColor');
    this.bgColorEl = document.getElementById('bgColor');

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
    this._resizeAll();
    this.compositor = new Compositor(this.compositeCanvas);
    this.compositor.resize(this.W, this.H, this.DPR);
    this._addBackgroundLayer();
    this.addLayer('Layer 1');
    this._syncLayerSwitcher();

    // AI server
    this.aiServer = new AIServer();

    // Brush engines
    this.brushes.boid = new BoidBrush(this);
    this.brushes.bristle = new BristleBrush(this);
    this.brushes.simple = new SimpleBrush(this);
    this.brushes.eraser = new EraserBrush(this);
    this.brushes.ai = new AIDiffusionBrush(this);

    // Init WASM for boid brush
    await this.brushes.boid.init();

    // Sidebar UI
    buildSidebar(this);
    initEdgeSliders(this);

    // Events
    this._bindEvents();

    // Restore session
    this._restoreSession();

    // Composite & start loop
    this.compositeAllLayers();
    this._frameLoop();

    this.setStatus('Ready');
  }

  // ========================================================
  // CANVAS MANAGEMENT
  // ========================================================

  _resizeAll() {
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
  }

  makeLayerCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = this.W * this.DPR;
    canvas.height = this.H * this.DPR;
    const ctx = canvas.getContext('2d', { desynchronized: true });
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    return { canvas, ctx };
  }

  // ========================================================
  // LAYERS
  // ========================================================

  addLayer(name) {
    const { canvas, ctx } = this.makeLayerCanvas();
    this.layers.splice(this.activeLayerIdx, 0, {
      canvas, ctx, name: name || `Layer ${this.layers.length + 1}`,
      visible: true, opacity: 1, blend: 'source-over', dirty: true, glTex: null
    });
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  getActiveLayer() { return this.layers[this.activeLayerIdx]; }

  // ── Background layer ──────────────────────────────────────

  _addBackgroundLayer() {
    const { canvas, ctx } = this.makeLayerCanvas();
    const bgLayer = {
      canvas, ctx, name: 'Background', isBackground: true,
      visible: true, opacity: 1, blend: 'source-over', dirty: true, glTex: null
    };
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
   * Load a user-supplied image as a greyscale canvas texture tile.
   * @param {File} file - Image file (PNG, JPEG, etc.)
   */
  loadCanvasTexture(file) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        // Draw to a temp canvas and convert to greyscale
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, c.width, c.height);
        const d = imgData.data;
        // Greyscale conversion: luminance = 0.299R + 0.587G + 0.114B
        const grey = new Uint8ClampedArray(c.width * c.height);
        for (let i = 0; i < grey.length; i++) {
          const off = i * 4;
          grey[i] = Math.round(0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2]);
        }
        this._canvasTextureW = c.width;
        this._canvasTextureH = c.height;
        this._canvasTextureData = grey;
        this._canvasTextureImg = c;
        // Auto-enable texture so the effect is immediately visible
        const chk = document.getElementById('canvasTextureEnabled');
        if (chk && !chk.checked) { chk.checked = true; }
        this._paramsDirty = true;
        this.showToast('🖼 Texture loaded & enabled');
      };
      img.onerror = () => {
        this.showToast('⚠ Texture load failed — invalid image');
      };
      img.src = evt.target.result;
    };
    reader.onerror = () => {
      this.showToast('⚠ Texture load failed — could not read file');
    };
    reader.readAsDataURL(file);
  }

  clearCanvasTexture() {
    this._canvasTextureImg = null;
    this._canvasTextureW = 0;
    this._canvasTextureH = 0;
    this._canvasTextureData = null;
    this.showToast('Texture cleared');
  }

  /**
   * Sample the greyscale texture value at a canvas position.
   * Returns 0–1 where 0 = black (valley, holds paint) and 1 = white (peak, rejects paint).
   * The texture is tiled at the specified scale.
   */
  _sampleTexture(x, y, scale) {
    if (!this._canvasTextureData) return 0;
    const w = this._canvasTextureW;
    const h = this._canvasTextureH;
    if (w <= 0 || h <= 0 || scale <= 0) return 0;
    // Tile position (scale modifies UV coords); double-mod handles negative coords
    const ix = ((Math.floor(x / scale) % w) + w) % w;
    const iy = ((Math.floor(y / scale) % h) + h) % h;
    return this._canvasTextureData[iy * w + ix] / 255;
  }

  setActiveLayer(idx) {
    if (idx >= 0 && idx < this.layers.length && !this.layers[idx].isBackground) {
      this.activeLayerIdx = idx;
      this._syncLayerSwitcher();
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
    this.layers.splice(this.activeLayerIdx, 0, {
      canvas, ctx, name: src.name + ' copy',
      visible: true, opacity: src.opacity, blend: src.blend, dirty: true, glTex: null
    });
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  moveLayerUp() {
    if (this.activeLayerIdx <= 0) return;
    this.pushUndo();
    [this.layers[this.activeLayerIdx - 1], this.layers[this.activeLayerIdx]] =
      [this.layers[this.activeLayerIdx], this.layers[this.activeLayerIdx - 1]];
    this.activeLayerIdx--;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  moveLayerDown() {
    if (this.activeLayerIdx >= this.layers.length - 1) return;
    // Don't swap with background layer
    if (this.layers[this.activeLayerIdx + 1]?.isBackground) return;
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
    this.layers = [{ canvas, ctx, name: 'Flattened', visible: true, opacity: 1, blend: 'source-over', dirty: true, glTex: null }];
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
    l.dirty = true;
    this.compositeAllLayers();
    this.showToast('🗑 Layer cleared');
  }

  compositeAllLayers() {
    this._smudgeImageData = null; // invalidate smudge cache
    this.compositor?.composite(this.layers, this.W, this.H);
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
      return { canvas, ctx, name: s.name, visible: s.visible, opacity: s.opacity, blend: s.blend,
               isBackground: !!s.isBackground, dirty: true, glTex: null };
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
    const val = id => { const e = el(id); return e ? +e.value : 0; };
    const chk = id => { const e = el(id); return e ? e.checked : false; };
    const sel = id => { const e = el(id); return e ? e.value : ''; };

    const scale = val('brushScale') / 100;

    this._cachedP = {
      // Brush scale
      brushScale: scale,
      // Spawn
      spawnShape: sel('spawnShape') || 'circle',
      spawnRadius: Math.round(val('spawnRadius') * scale),
      spawnAngle: (val('spawnAngle') || 0) * Math.PI / 180,
      spawnJitter: val('spawnJitter') / 100,
      respawnOnStroke: chk('respawnOnStroke'),
      pressureSpawnRadius: chk('pressureSpawnRadius'),
      // Swarm
      count: val('count') || 60,
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
      flatStroke: chk('flatStroke'),
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
      bristleSmoothing: (val('bristleSmoothing') || 50) / 100,
      pencilAngle: chk('pencilAngle'),
      pencilBlend: (val('pencilBlend') || 0) / 100,
      showBristles: chk('showBristles'),
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
    };
    return this._cachedP;
  }

  // ========================================================
  // BRUSH MANAGEMENT
  // ========================================================

  setBrush(name) {
    if (!this.brushes[name]) return;
    // Deactivate current
    const cur = this.brushes[this.activeBrush];
    if (cur && cur.deactivate) cur.deactivate();
    this.activeBrush = name;
    // Update brush dropdown button
    const brushLabels = { boid: '🐦 Boid', bristle: '🖊 Bristle', simple: '🖌 Simple', eraser: '◻ Eraser', ai: '🤖 AI Diffusion' };
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

  // ========================================================
  // DRAWING / POINTER EVENTS
  // ========================================================

  _bindEvents() {
    const ic = this.interactionCanvas;

    ic.addEventListener('pointerdown', e => this._onPointerDown(e));
    ic.addEventListener('pointermove', e => this._onPointerMove(e));
    ic.addEventListener('pointerup', e => this._onPointerUp(e));
    ic.addEventListener('pointercancel', e => this._onPointerUp(e));

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
    document.getElementById('resetViewBtn')?.addEventListener('click', () => this.resetView());
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      document.getElementById('sidebar')?.classList.toggle('open');
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
    // Color pickers invalidate params
    this.primaryEl.addEventListener('input', () => { this._paramsDirty = true; });
    this.secondaryEl.addEventListener('input', () => { this._paramsDirty = true; });
    // Background color
    this.bgColorEl?.addEventListener('input', () => {
      this._fillBackgroundLayer();
      this.compositeAllLayers();
    });
  }

  _getEventCoords(e) {
    // Get coords relative to the canvas area (not the transformed canvas)
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const sx = e.clientX - areaRect.left;
    const sy = e.clientY - areaRect.top;
    // Convert from screen space (post-transform) to canvas space
    return this._screenToCanvas(sx, sy);
  }

  _screenToCanvas(sx, sy) {
    // Undo view transform: the CSS transform is:
    // translate(panX, panY) translate(cx,cy) rotate(rot) scale(zoom) translate(-cx,-cy)
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const cx = areaRect.width / 2;
    const cy = areaRect.height / 2;

    // Step 1: undo translate(panX, panY)
    let dx = sx - this.viewPanX;
    let dy = sy - this.viewPanY;
    // Step 2: undo translate(cx, cy)
    dx -= cx;
    dy -= cy;
    // Step 3: undo rotate(rot)
    const cos = Math.cos(-this.viewRotation);
    const sin = Math.sin(-this.viewRotation);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    // Step 4: undo scale(zoom)
    const ux = rx / this.viewZoom;
    const uy = ry / this.viewZoom;
    // Step 5: undo translate(-cx, -cy)
    return { x: ux + cx, y: uy + cy };
  }

  /** Extract stylus tilt/azimuth from a PointerEvent and store on this App */
  _captureTilt(e) {
    this.tiltX = e.tiltX || 0;
    this.tiltY = e.tiltY || 0;
    // Prefer the direct azimuthAngle/altitudeAngle (Safari/WebKit on iPad)
    if (typeof e.azimuthAngle === 'number') {
      this.azimuth = e.azimuthAngle;
      this.altitude = typeof e.altitudeAngle === 'number' ? e.altitudeAngle : Math.PI / 2;
    } else if (this.tiltX !== 0 || this.tiltY !== 0) {
      // Compute azimuth from tiltX/tiltY (Pointer Events Level 2 fallback)
      const tx = this.tiltX * Math.PI / 180;
      const ty = this.tiltY * Math.PI / 180;
      this.azimuth = Math.atan2(Math.tan(ty), Math.tan(tx));
      if (this.azimuth < 0) this.azimuth += Math.PI * 2;
      // Approximate altitude from tilt magnitude
      const tiltMag = Math.sqrt(tx * tx + ty * ty);
      this.altitude = Math.max(0, Math.PI / 2 - tiltMag);
    } else {
      // Pen is vertical or no tilt data — leave previous values
    }
  }

  _onPointerDown(e) {
    e.preventDefault();
    // Track active pointers for multi-touch detection
    this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    // Don't start drawing during pinch gesture
    if (this._pinchActive) return;
    // Don't start drawing if touch and multiple pointers (pinch incoming)
    if (e.pointerType === 'touch' && this._activePointers.size > 1) return;

    this.interactionCanvas.setPointerCapture(e.pointerId);
    const { x, y } = this._getEventCoords(e);
    // Reset EMA pressure at stroke start for immediate response
    this._rawPressure = e.pressure || 0.5;
    this.pressure = this._rawPressure;
    this._captureTilt(e);
    this.leaderX = x;
    this.leaderY = y;
    this.isDrawing = true;
    this.undoPushedThisStroke = false;
    this.isTapering = false;
    this.strokeFrame = 0;

    const brush = this.getCurrentBrush();
    if (brush) brush.onDown(x, y, this.pressure);
  }

  _onPointerMove(e) {
    this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    // Don't draw during pinch
    if (this._pinchActive) return;
    if (!this.isDrawing) {
      const { x, y } = this._getEventCoords(e);
      this._rawPressure = e.pressure || 0.5;
      this.pressure += (this._rawPressure - this.pressure) * PRESSURE_SMOOTH_ALPHA;
      this._captureTilt(e);
      this.leaderX = x;
      this.leaderY = y;
      return;
    }

    const brush = this.getCurrentBrush();
    // Use coalesced events for smoother brush strokes (sub-frame input samples)
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [e];
    for (const pe of events) {
      const { x, y } = this._getEventCoords(pe);
      this._rawPressure = pe.pressure || 0.5;
      this.pressure += (this._rawPressure - this.pressure) * PRESSURE_SMOOTH_ALPHA;
      this._captureTilt(pe);
      this.leaderX = x;
      this.leaderY = y;
      if (brush) brush.onMove(x, y, this.pressure);
    }
  }

  _onPointerUp(e) {
    this._activePointers.delete(e.pointerId);
    if (!this.isDrawing) return;
    this.isDrawing = false;
    const { x, y } = this._getEventCoords(e);

    const brush = this.getCurrentBrush();
    if (brush) brush.onUp(x, y);

    // Start taper if configured
    const p = this.getP();
    if (p.taperLength > 0) {
      this.isTapering = true;
      this.taperFrame = 0;
      this.taperTotal = p.taperLength;
    }
  }

  _onKeyDown(e) {
    // Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo
    if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); this.doUndo(); }
    if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); this.doRedo(); }
    // Ctrl+S = save image
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.saveImage(); }
    // Ctrl+C = copy canvas to clipboard
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); this.copyToClipboard(); }
    // Ctrl+V = paste from clipboard
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); this.pasteFromClipboard(); }
    // 1/2/3 = brush switch
    if (e.key === '1') this.setBrush('boid');
    if (e.key === '2') this.setBrush('bristle');
    if (e.key === '3') this.setBrush('simple');
    if (e.key === '4') this.setBrush('eraser');
    if (e.key === '5') this.setBrush('ai');
    // 0 = reset view
    if (e.key === '0' && !e.ctrlKey && !e.metaKey) this.resetView();
    // X = swap colors
    if (e.key === 'x' || e.key === 'X') {
      if (!e.ctrlKey) {
        const t = this.primaryEl.value;
        this.primaryEl.value = this.secondaryEl.value;
        this.secondaryEl.value = t;
        this._paramsDirty = true;
      }
    }
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
      const cx = areaRect.width / 2;
      const cy = areaRect.height / 2;
      const r = this.viewRotation;
      const z = this.viewZoom;
      const ax = this._pinchAnchor.x - cx;
      const ay = this._pinchAnchor.y - cy;
      this.viewPanX = curSX - cx - z * (ax * Math.cos(r) - ay * Math.sin(r));
      this.viewPanY = curSY - cy - z * (ax * Math.sin(r) + ay * Math.cos(r));

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
    const zoomFactor = e.deltaY > 0 ? WHEEL_ZOOM_OUT : WHEEL_ZOOM_IN;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * zoomFactor));

    // Zoom toward pointer position
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const mx = e.clientX - areaRect.left;
    const my = e.clientY - areaRect.top;

    // Adjust pan so the point under the cursor stays fixed
    const cx = areaRect.width / 2;
    const cy = areaRect.height / 2;
    const s = newZoom / this.viewZoom;
    this.viewPanX = (mx - cx) - s * (mx - cx - this.viewPanX);
    this.viewPanY = (my - cy) - s * (my - cy - this.viewPanY);

    this.viewZoom = newZoom;
    this._applyViewTransform();
  }

  _applyViewTransform() {
    const el = document.getElementById('canvasTransform');
    if (!el) return;
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const cx = areaRect.width / 2;
    const cy = areaRect.height / 2;
    const deg = this.viewRotation * 180 / Math.PI;
    el.style.transform = `translate(${this.viewPanX}px, ${this.viewPanY}px) translate(${cx}px, ${cy}px) rotate(${deg}deg) scale(${this.viewZoom}) translate(${-cx}px, ${-cy}px)`;
  }

  resetView() {
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.viewRotation = 0;
    this._applyViewTransform();
    this.showToast('🔍 View reset');
  }

  // ========================================================
  // FRAME LOOP
  // ========================================================

  _frameLoop() {
    const elapsed = (performance.now() - this._startTime) / 1000;
    const brush = this.getCurrentBrush();

    // Taper pass — after stroke ends
    if (this.isTapering && brush && brush.taperFrame) {
      this.taperFrame++;
      const t = this.taperFrame / this.taperTotal;
      if (t >= 1) {
        this.isTapering = false;
      } else {
        brush.taperFrame(t, this.getP());
      }
    }

    // Active brush frame (e.g. boid step)
    if (this.isDrawing && brush && brush.onFrame) {
      brush.onFrame(elapsed);
    }

    // Update live overlay (particle visualization)
    this.lctx.clearRect(0, 0, this.W, this.H);
    if (brush && brush.drawOverlay) {
      brush.drawOverlay(this.lctx, this.getP());
    }

    // Update status
    this._updateStatus(brush);

    this._rafId = requestAnimationFrame(() => this._frameLoop());
  }

  _updateStatus(brush) {
    let info = `${this.W}×${this.H} | Layer ${this.activeLayerIdx + 1}/${this.layers.length}`;
    if (this.viewZoom !== 1 || this.viewRotation !== 0) {
      info += ` | ${Math.round(this.viewZoom * 100)}%`;
      if (this.viewRotation !== 0) info += ` ${Math.round(this.viewRotation * 180 / Math.PI)}°`;
    }
    if (brush && brush.getStatusInfo) info += ` | ${brush.getStatusInfo()}`;
    this.statusEl.textContent = info;
  }

  // ========================================================
  // STAMP HELPERS
  // ========================================================

  stampCircle(ctx, x, y, size, color, opacity) {
    const p = this._cachedP || this.getP();
    // Modulate opacity by canvas texture if enabled
    if (this._canvasTextureData) {
      if (p.canvasTextureEnabled && p.canvasTextureStrength > 0) {
        const grey = this._sampleTexture(x, y, p.canvasTextureScale);
        // grey 0=black(valley→more paint), 1=white(peak→less paint)
        // strength and grey are both 0-1, so product ≤ 1, but clamp for safety
        opacity *= Math.max(0, 1 - p.canvasTextureStrength * grey);
      }
    }
    // Smudge: blend brush colour with existing canvas colour
    if (p.smudge > 0) {
      const sampled = this._sampleSmudgeColor(x, y);
      if (sampled.a > 0) {
        const brush = this._parseColorToRGB(color);
        const s = p.smudge * (sampled.a / 255); // scale by sampled alpha
        const r = Math.round(brush.r * (1 - s) + sampled.r * s);
        const g = Math.round(brush.g * (1 - s) + sampled.g * s);
        const b = Math.round(brush.b * (1 - s) + sampled.b * s);
        color = `rgb(${r},${g},${b})`;
      }
    }
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    ctx.fill();
    ctx.globalAlpha = 1;
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
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d');
    tc.setTransform(1, 0, 0, 1, 0, 0);

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
    } else {
      // 'active'
      const l = this.getActiveLayer();
      tc.drawImage(l.canvas, 0, 0);
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
    try {
      const canvas = this._compositeFlatCanvas();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) { this.showToast('⚠ Copy failed'); return; }
      // Always store internally for in-app paste fallback
      this._clipboardBlob = blob;
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
      l.ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, this.W, this.H);
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(controls));
    } catch { /* quota exceeded — ignore */ }
  }

  _restoreSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const controls = JSON.parse(raw);
      for (const [id, val] of Object.entries(controls)) {
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
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = val;
        else el.value = val;
      }
      this._paramsDirty = true;
      syncUI(this);
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
