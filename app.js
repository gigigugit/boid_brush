// =============================================================================
// app.js — Core painting application engine
//
// Manages canvases, layers, undo/redo, parameter cache, frame loop,
// session persistence, and wires all modules together.
// =============================================================================

import { Compositor, BLEND_MODE_MAP } from './compositor.js';
import { BoidBrush, AntBrush, BristleBrush, SimpleBrush, EraserBrush, AIDiffusionBrush, SpawnShapes } from './brushes.js';
import { buildSidebar, syncUI, initEdgeSliders } from './ui.js';
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
    this._canvasTextureImg = null;   // greyscale HTMLCanvasElement (source tile)
    this._canvasTextureW = 0;        // source tile pixel width
    this._canvasTextureH = 0;        // source tile pixel height
    this._canvasTextureData = null;   // Uint8ClampedArray of greyscale luminance

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
      editorTool: 'spawn',
      brushData: {
        boid: { spawns: [], points: [], path: [] },
        ant: { spawns: [], points: [], edges: [], pheromonePaths: [] },
      },
      drawingPath: null,
      dragTarget: null,
      pathDistance: 0,
      pathProgress: 0,
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
    this.brushes.simple = new SimpleBrush(this);
    this.brushes.eraser = new EraserBrush(this);
    this.brushes.ai = new AIDiffusionBrush(this);

    // Init WASM for boid brush
    await this.brushes.boid.init();
    await this.brushes.ant.init();

    // Sidebar UI
    buildSidebar(this);
    initEdgeSliders(this);

    // Events
    this._bindEvents();

    // Restore session
    this._restoreSession();
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
      this.lctx = this.liveCanvas.getContext('2d', { desynchronized: true });
      this.lctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
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
      if (this.brushes.boid) await this.brushes.boid.init();
      if (this.brushes.ant) await this.brushes.ant.init();
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

  // ========================================================
  // LAYERS
  // ========================================================

  addLayer(name) {
    const { canvas, ctx } = this.makeLayerCanvas();
    this.layers.splice(this.activeLayerIdx, 0, {
      canvas, ctx, name: name || `Layer ${this.layers.length + 1}`,
      visible: true, opacity: 1, blend: 'source-over', dirty: true, glTex: null, alphaLock: false
    });
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
    const bgLayer = {
      canvas, ctx, name: 'Background', isBackground: true,
      visible: true, opacity: 1, blend: 'source-over', dirty: true, glTex: null, alphaLock: false
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
    this.compositor?.composite(this.layers, this.W, this.H);

    // Impasto: recompute lighting overlay from height map when dirty, then draw
    const p = this._cachedP || this.getP();
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
      simPathSpeed: (val('simPathSpeed') || 50) / 20,
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

  _ensureSimulationSpawns(brush = this.activeBrush) {
    const data = this._getSimulationBrushData(brush);
    if (!data) return [];
    if (!Array.isArray(data.spawns)) {
      data.spawns = data.spawn ? [data.spawn] : [];
      delete data.spawn;
    }
    if (!data.spawns.length) data.spawns.push({ id: this.simulation.nextId++, x: this.W * 0.5, y: this.H * 0.5 });
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
      data.spawns = data.spawns.map(spawn => ({ id: spawn.id || this.simulation.nextId++, x: spawn.x, y: spawn.y }));
      if (!Array.isArray(data.points)) data.points = [];
      if (brush === 'boid' && !Array.isArray(data.path)) data.path = [];
      if (brush === 'ant') {
        if (!Array.isArray(data.edges)) data.edges = [];
        if (!Array.isArray(data.pheromonePaths)) data.pheromonePaths = [];
      }
    }
  }

  _getSimulationSpawnCenter(brush = this.activeBrush) {
    const spawns = this._ensureSimulationSpawns(brush);
    if (!spawns.length) return { x: this.W * 0.5, y: this.H * 0.5 };
    let sx = 0;
    let sy = 0;
    for (const spawn of spawns) {
      sx += spawn.x;
      sy += spawn.y;
    }
    return { x: sx / spawns.length, y: sy / spawns.length };
  }

  _toggleSimulationMode(force) {
    if (!this._isMotionBrush()) return;
    const next = typeof force === 'boolean' ? force : !this.simulation.enabled;
    if (!next) this.stopSimulation(false);
    this.simulation.enabled = next;
    this.simulation.paused = false;
    this.simulation.drawingPath = null;
    this.simulation.dragTarget = null;
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
    const isMotion = this._isMotionBrush();
    if (btn) {
      btn.style.display = isMotion ? '' : 'none';
      btn.classList.toggle('active', !!this.simulation.enabled);
    }
    if (hud) hud.classList.toggle('open', !!this.simulation.enabled && isMotion);

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
    const status = document.getElementById('simStatus');
    if (status) {
      status.textContent = this.simulation.running ? 'Running' : (this.simulation.paused ? 'Paused' : 'Ready');
    }
  }

  startSimulation() {
    if (!this.simulation.enabled || !this._isMotionBrush()) return;
    const brush = this.getCurrentBrush();
    if (!brush) return;
    if (this.simulation.running) return;
    const spawns = this._ensureSimulationSpawns();
    const spawn = spawns[0];
    this.stopSimulation(false);
    this.simulation.running = true;
    this.simulation.paused = false;
    this.simulation.pathProgress = 0;
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
    if (hit?.kind === 'point') {
      this.simulation.dragTarget = hit;
      return true;
    }
    if (hit?.kind === 'spawn') {
      this.simulation.dragTarget = hit;
      return true;
    }
    const tool = this.simulation.editorTool;
    const data = this._getSimulationBrushData();
    if (!data) return true;

    if (tool === 'spawn') {
      data.spawns.push({ id: this.simulation.nextId++, x, y });
    } else if (tool === 'attract' || tool === 'repel') {
      data.points.push({ id: this.simulation.nextId++, x, y, type: tool });
    } else if (tool === 'pheromone' && this.activeBrush === 'ant') {
      this.simulation.drawingPath = {
        kind: tool,
        radius: this.getP().simPheroPaintRadius,
        intensity: this.getP().simPheroPaintStrength,
        points: [{ x, y }],
      };
    } else if ((tool === 'path' && this.activeBrush === 'boid') || (tool === 'edge' && this.activeBrush === 'ant')) {
      this.simulation.drawingPath = {
        kind: tool,
        points: [{ x, y }],
      };
    }
    return true;
  }

  _handleSimulationPointerMove(x, y) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return false;
    if (this.simulation.dragTarget) {
      const hit = this.simulation.dragTarget;
      if (hit.kind === 'spawn' || hit.kind === 'point') {
        hit.target.x = x;
        hit.target.y = y;
      }
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
    this.simulation.dragTarget = null;
    if (this.simulation.drawingPath) {
      const path = this.simulation.drawingPath.points.filter((pt, i, arr) => i === 0 || Math.hypot(pt.x - arr[i - 1].x, pt.y - arr[i - 1].y) > 1);
      const data = this._getSimulationBrushData();
      if (data && path.length >= 2) {
        if (this.simulation.drawingPath.kind === 'path' && this.activeBrush === 'boid') data.path = path;
        else if (this.simulation.drawingPath.kind === 'edge' && this.activeBrush === 'ant') data.edges.push({ id: this.simulation.nextId++, points: path });
        else if (this.simulation.drawingPath.kind === 'pheromone' && this.activeBrush === 'ant') {
          data.pheromonePaths.push({
            id: this.simulation.nextId++,
            points: path,
            radius: this.simulation.drawingPath.radius,
            intensity: this.simulation.drawingPath.intensity,
          });
        }
      }
      this.simulation.drawingPath = null;
      return true;
    }
    return this.simulation.running || this.simulation.paused || this.simulation.enabled;
  }

  _deleteSimulationItem(hit) {
    const data = this._getSimulationBrushData();
    if (!data) return;
    if (hit.collection === 'spawns') {
      data.spawns = data.spawns.filter(p => p !== hit.target);
      this._ensureSimulationSpawns();
    } else if (hit.collection === 'points') {
      data.points = data.points.filter(p => p !== hit.target);
    } else if (hit.collection === 'edges') {
      data.edges = data.edges.filter(p => p !== hit.target);
    } else if (hit.collection === 'pheromonePaths') {
      data.pheromonePaths = data.pheromonePaths.filter(p => p !== hit.target);
    } else if (hit.collection === 'path') {
      data.path = [];
    }
  }

  clearSimulationGuides() {
    const data = this._getSimulationBrushData();
    if (!data) return;
    data.spawns = [];
    data.points = [];
    if (this.activeBrush === 'boid') data.path = [];
    if (this.activeBrush === 'ant') {
      data.edges = [];
      data.pheromonePaths = [];
    }
    this._ensureSimulationSpawns();
    this.showToast('Simulation guides cleared');
  }

  _findSimulationHit(x, y) {
    const data = this._getSimulationBrushData();
    if (!data) return null;
    const hitRadius = 14;
    const delRadius = 10;
    const checkDelete = (target, collection) => {
      const dx = x - (target.x + 12);
      const dy = y - (target.y - 12);
      return dx * dx + dy * dy <= delRadius * delRadius ? { kind: 'delete', target, collection } : null;
    };

    for (const spawn of this._ensureSimulationSpawns()) {
      const del = checkDelete(spawn, 'spawns');
      if (del) return del;
      if (Math.hypot(x - spawn.x, y - spawn.y) <= hitRadius) return { kind: 'spawn', target: spawn, collection: 'spawns' };
    }

    for (const point of data.points) {
      const del = checkDelete(point, 'points');
      if (del) return del;
      if (Math.hypot(x - point.x, y - point.y) <= hitRadius) return { kind: 'point', target: point, collection: 'points' };
    }

    if (this.activeBrush === 'ant') {
      for (const path of data.pheromonePaths || []) {
        if (!path.points?.length) continue;
        const anchor = path.points[Math.floor(path.points.length / 2)];
        const del = checkDelete(anchor, 'pheromonePaths');
        if (del) return { ...del, target: path };
      }
    }

    return null;
  }

  _updateSimulationLeader(elapsed, p) {
    const data = this._getSimulationBrushData();
    if (!data) return;
    const center = this._getSimulationSpawnCenter();
    this.leaderX = center.x;
    this.leaderY = center.y;
    if (this.activeBrush !== 'boid' || !data.path || data.path.length < 2) return;

    const total = this._polylineLength(data.path);
    if (total <= 0) return;
    const dt = 1 / 60;
    this.simulation.pathDistance += Math.max(0.5, p.maxSpeed * 14 * p.simSpeed * p.simPathSpeed) * dt;
    const dist = this.simulation.pathDistance % total;
    const pt = this._samplePolyline(data.path, dist);
    if (pt) {
      this.leaderX = pt.x;
      this.leaderY = pt.y;
    }
  }

  _polylineLength(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return len;
  }

  _samplePolyline(points, distance) {
    let remaining = distance;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (seg <= 0) continue;
      if (remaining <= seg) {
        const t = remaining / seg;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      remaining -= seg;
    }
    return points[points.length - 1] || null;
  }

  drawSimulationOverlay(ctx) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return;
    const data = this._getSimulationBrushData();
    if (!data) return;
    const p = this.getP();
    const pointRadius = p.simPointRadius;
    const edgeRadius = p.simEdgeRadius;

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
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(spawn.x, spawn.y, Math.max(8, p.spawnRadius), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(spawn.x, spawn.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      drawDelete(spawn.x, spawn.y);
    }

    for (const point of data.points) {
      const attract = point.type === 'attract';
      const color = attract ? 'rgba(94,149,255,0.88)' : 'rgba(255,188,118,0.9)';
      const fill = attract ? 'rgba(54,98,185,0.18)' : 'rgba(217,147,66,0.18)';
      ctx.strokeStyle = color;
      ctx.fillStyle = fill;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      drawDelete(point.x, point.y);
    }

    if (this.activeBrush === 'boid' && data.path?.length >= 2) {
      ctx.strokeStyle = 'rgba(116,166,255,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(data.path[0].x, data.path[0].y);
      for (let i = 1; i < data.path.length; i++) ctx.lineTo(data.path[i].x, data.path[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.activeBrush === 'ant') {
      for (const trail of data.pheromonePaths || []) {
        if (!trail.points?.length) continue;
        ctx.strokeStyle = 'rgba(120,200,80,0.8)';
        ctx.lineWidth = Math.max(2, trail.radius * 2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = Math.max(0.12, trail.intensity * 0.4);
        ctx.beginPath();
        ctx.moveTo(trail.points[0].x, trail.points[0].y);
        for (let i = 1; i < trail.points.length; i++) ctx.lineTo(trail.points[i].x, trail.points[i].y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const anchor = trail.points[Math.floor(trail.points.length / 2)];
        drawDelete(anchor.x, anchor.y);
      }
      ctx.strokeStyle = 'rgba(255,210,120,0.92)';
      ctx.fillStyle = 'rgba(255,210,120,0.08)';
      ctx.lineWidth = 2;
      for (const edge of data.edges) {
        if (!edge.points?.length) continue;
        ctx.beginPath();
        ctx.moveTo(edge.points[0].x, edge.points[0].y);
        for (let i = 1; i < edge.points.length; i++) ctx.lineTo(edge.points[i].x, edge.points[i].y);
        ctx.stroke();
        if (edgeRadius > 0) {
          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.lineWidth = edgeRadius * 2;
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    if (this.simulation.drawingPath?.points?.length >= 2) {
      const pts = this.simulation.drawingPath.points;
      ctx.strokeStyle =
        this.simulation.drawingPath.kind === 'edge' ? 'rgba(255,210,120,0.85)'
        : this.simulation.drawingPath.kind === 'pheromone' ? 'rgba(120,200,80,0.85)'
        : 'rgba(116,166,255,0.85)';
      ctx.lineWidth = this.simulation.drawingPath.kind === 'pheromone'
        ? Math.max(2, this.simulation.drawingPath.radius * 2)
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
    const brushLabels = { boid: '🐦 Boid', ant: '🐜 Ant', bristle: '🖊 Bristle', simple: '🖌 Simple', eraser: '◻ Eraser', ai: '🤖 AI Diffusion' };
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
    document.querySelectorAll('[data-sim-tool]').forEach(el => {
      el.addEventListener('click', () => this._setSimulationTool(el.dataset.simTool));
    });
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
    document.getElementById('canvasSizeApply')?.addEventListener('click', () => {
      const w = +document.getElementById('canvasSizeW')?.value || 1920;
      const h = +document.getElementById('canvasSizeH')?.value || 1080;
      const bg = document.getElementById('canvasSizeBg')?.value || '#ffffff';
      this.resizeDocument(w, h, bg);
      this._hideCanvasSizeModal();
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
    // translate(panX, panY) translate(cx,cy) rotate(rot) scale(zoom) scaleX(flip) translate(-cx,-cy)
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
    let ux = rx / this.viewZoom;
    let uy = ry / this.viewZoom;
    // Step 5: undo scaleX(flip)
    if (this.viewFlipped) ux = -ux;
    // Step 6: undo translate(-cx, -cy)
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
      const brush = this.getCurrentBrush();
      if (brush && brush.onHover) brush.onHover(x, y);
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
    // Clear hover state when pointer leaves canvas (e.g. Apple Pencil lifts away)
    if (this.isDrawing) return;
    const brush = this.getCurrentBrush();
    if (brush && brush.onHoverEnd) brush.onHoverEnd();
  }

  _onKeyDown(e) {
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
    // 1/2/3 = brush switch
    if (e.key === '1') this.setBrush('boid');
    if (e.key === '2') this.setBrush('bristle');
    if (e.key === '3') this.setBrush('simple');
    if (e.key === '4') this.setBrush('eraser');
    if (e.key === '5') this.setBrush('ai');
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
    // Shift+scroll = rotate view
    if (e.shiftKey) {
      const rotDelta = (e.deltaY > 0 ? 1 : -1) * WHEEL_ROTATION_DEG * Math.PI / 180;
      this.viewRotation += rotDelta;
      this._applyViewTransform();
      return;
    }
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
    const flipScale = this.viewFlipped ? -1 : 1;
    el.style.transform = `translate(${this.viewPanX}px, ${this.viewPanY}px) translate(${cx}px, ${cy}px) rotate(${deg}deg) scale(${this.viewZoom}) scaleX(${flipScale}) translate(${-cx}px, ${-cy}px)`;
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

  // ========================================================
  // FRAME LOOP
  // ========================================================

  _frameLoop() {
    const elapsed = (performance.now() - this._startTime) / 1000;
    const brush = this.getCurrentBrush();
    const p = this.getP();

    // Taper pass — after stroke ends
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
    }

    // Update live overlay (particle visualization)
    this.lctx.clearRect(0, 0, this.W, this.H);

    // Brush size cursor preview
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
    if (this.simulation.running) info += ' | Sim: running';
    else if (this.simulation.paused) info += ' | Sim: paused';
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
      const sampled = this._sampleSmudgeColor(x, y);
      if (sampled.a > 0) {
        if (p.smudgeOnly) {
          // Smudge-only: stamp purely with the sampled canvas colour
          // Modulate by area-averaged alpha so stamps fade at edges near transparent pixels
          color = `rgb(${sampled.r},${sampled.g},${sampled.b})`;
          opacity *= this._sampleSmudgeAreaAlpha(x, y, size);
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
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    const activeLayer = this.getActiveLayer();
    const useAlphaLock = activeLayer && activeLayer.alphaLock && this.activeBrush !== 'eraser';
    if (useAlphaLock) ctx.globalCompositeOperation = 'source-atop';
    ctx.fill();
    if (useAlphaLock) ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Impasto: stamp onto the height map proportionally to stamp opacity
    if (p.impasto && p.impastoStrength > 0 && this._heightCtx) {
      const hctx = this._heightCtx;
      hctx.beginPath();
      hctx.arc(x * this.DPR, y * this.DPR, (size / 2) * this.DPR, 0, Math.PI * 2);
      hctx.fillStyle = '#ffffff';
      hctx.globalAlpha = Math.min(opacity * p.impastoStrength, 1);
      hctx.fill();
      hctx.globalAlpha = 1;
      this._heightDirty = true;
    }

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
        editorTool: this.simulation.editorTool,
        brushData: this.simulation.brushData,
        nextId: this.simulation.nextId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(controls));
    } catch { /* quota exceeded — ignore */ }
  }

  _restoreSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const controls = JSON.parse(raw);
      for (const [id, val] of Object.entries(controls)) {
        if (id === '_docSized' || id === '_docW' || id === '_docH') continue;
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
      // Restore document size (state only; actual resize happens via _resizeAll or resizeDocument)
      if (controls._docSized && controls._docW && controls._docH) {
        this._docSized = true;
        this._docW = controls._docW;
        this._docH = controls._docH;
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
