// =============================================================================
// app.js — Core painting application engine
//
// Manages canvases, layers, undo/redo, parameter cache, frame loop,
// session persistence, and wires all modules together.
// =============================================================================

import { Compositor, BLEND_MODE_MAP } from './compositor.js';
import { BoidBrush, BristleBrush, SimpleBrush, EraserBrush, SpawnShapes } from './brushes.js';
import { buildSidebar, syncUI, initEdgeSliders } from './ui.js';

const STORAGE_KEY = 'bb_session_v1';
const MAX_UNDO = 20;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const WHEEL_ZOOM_IN = 1.05;
const WHEEL_ZOOM_OUT = 0.95;
const MIN_SELECTION_SIZE = 2;
const MARCH_SPEED = 40; // pixels per second for marching ants

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

    // Color
    this.primaryEl = document.getElementById('primaryColor');
    this.secondaryEl = document.getElementById('secondaryColor');
    this.bgColorEl = document.getElementById('bgColor');

    // Frame loop
    this._rafId = null;
    this._startTime = performance.now();

    // Toast timer
    this._toastTimer = null;

    // Internal clipboard buffer (fallback when Clipboard API unavailable)
    this._clipboardBlob = null;

    // Selection
    this.selection = null;        // { x, y, w, h } in canvas coords or null
    this._selectMode = false;     // whether user is in marquee select mode
    this._isSelecting = false;    // actively dragging a selection
    this._selectStartX = 0;
    this._selectStartY = 0;

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

    // Brush engines
    this.brushes.boid = new BoidBrush(this);
    this.brushes.bristle = new BristleBrush(this);
    this.brushes.simple = new SimpleBrush(this);
    this.brushes.eraser = new EraserBrush(this);

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

  // ========================================================
  // SELECTION
  // ========================================================

  toggleSelectMode() {
    this._selectMode = !this._selectMode;
    const btn = document.getElementById('selectBtn');
    if (btn) btn.classList.toggle('active', this._selectMode);
    this.interactionCanvas.classList.toggle('select-mode', this._selectMode);
    if (!this._selectMode) {
      this._isSelecting = false;
    }
    this.showToast(this._selectMode ? '⬚ Select mode ON — drag to select' : '⬚ Select mode OFF');
  }

  selectAll() {
    this.selection = { x: 0, y: 0, w: this.W, h: this.H };
    this.showToast('⬚ Selected all');
  }

  deselect() {
    if (!this.selection) return;
    this.selection = null;
    this.showToast('⊘ Deselected');
  }

  clearSelection() {
    if (!this.selection) return;
    const l = this.getActiveLayer();
    if (l.isBackground) { this.showToast('Cannot clear on background'); return; }
    this.pushUndo();
    const s = this.selection;
    l.ctx.clearRect(s.x, s.y, s.w, s.h);
    l.dirty = true;
    this.compositeAllLayers();
    this.showToast('🗑 Selection cleared');
  }

  _drawSelectionOverlay(ctx) {
    if (!this.selection) return;
    const s = this.selection;
    const t = performance.now() / 1000;
    const offset = (t * MARCH_SPEED) % 16;
    ctx.save();
    // Draw selection border — white dashed with black dashed underneath for contrast
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    // Black underlay
    ctx.lineDashOffset = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
    // White overlay (marching)
    ctx.lineDashOffset = -offset;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
    ctx.restore();
  }

  compositeAllLayers() {
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
      count: val('count') || 25,
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
      showBristles: chk('showBristles'),
      // Color
      color: this.primaryEl.value,
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
    const brushLabels = { boid: '🐦 Boid', bristle: '🖊 Bristle', simple: '🖌 Simple', eraser: '◻ Eraser' };
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
    document.getElementById('selectBtn')?.addEventListener('click', () => this.toggleSelectMode());
    document.getElementById('deselectBtn')?.addEventListener('click', () => this.deselect());
    document.getElementById('clearBtn')?.addEventListener('click', () => this.clearActiveLayer());
    document.getElementById('saveBtn')?.addEventListener('click', () => this.saveImage());
    document.getElementById('copyBtn')?.addEventListener('click', () => this.copyToClipboard());
    document.getElementById('pasteBtn')?.addEventListener('click', () => this.pasteFromClipboard());
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

    // Select mode: start rectangular selection drag
    if (this._selectMode) {
      this._isSelecting = true;
      this._selectStartX = x;
      this._selectStartY = y;
      this.selection = { x, y, w: 0, h: 0 };
      return;
    }

    this.pressure = e.pressure || 0.5;
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

    // Select mode: update selection rectangle
    if (this._isSelecting) {
      const { x, y } = this._getEventCoords(e);
      const sx = Math.min(this._selectStartX, x);
      const sy = Math.min(this._selectStartY, y);
      const sw = Math.abs(x - this._selectStartX);
      const sh = Math.abs(y - this._selectStartY);
      this.selection = { x: sx, y: sy, w: sw, h: sh };
      return;
    }

    if (!this.isDrawing) {
      const { x, y } = this._getEventCoords(e);
      this.pressure = e.pressure || 0.5;
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
      this.pressure = pe.pressure || 0.5;
      this.leaderX = x;
      this.leaderY = y;
      if (brush) brush.onMove(x, y, this.pressure);
    }
  }

  _onPointerUp(e) {
    this._activePointers.delete(e.pointerId);

    // Finish selection drag
    if (this._isSelecting) {
      this._isSelecting = false;
      // Remove zero-size selections
      if (this.selection && (this.selection.w < MIN_SELECTION_SIZE || this.selection.h < MIN_SELECTION_SIZE)) {
        this.selection = null;
      }
      return;
    }

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
    // Ctrl+A = select all
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); this.selectAll(); }
    // Ctrl+D = deselect
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); this.deselect(); }
    // Escape = deselect or exit select mode
    if (e.key === 'Escape') {
      if (this.selection) { this.deselect(); }
      else if (this._selectMode) { this.toggleSelectMode(); }
    }
    // Delete/Backspace with selection = clear selected region
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection) {
      e.preventDefault(); this.clearSelection();
    }
    // M = toggle marquee select mode
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey) this.toggleSelectMode();
    // 1/2/3 = brush switch
    if (e.key === '1') this.setBrush('boid');
    if (e.key === '2') this.setBrush('bristle');
    if (e.key === '3') this.setBrush('simple');
    if (e.key === '4') this.setBrush('eraser');
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
    // Draw selection overlay (marching ants)
    this._drawSelectionOverlay(this.lctx);

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
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    ctx.fill();
    ctx.globalAlpha = 1;
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
    const flat = this._compositeFlatCanvas();
    let outCanvas;
    if (this.selection) {
      // Copy only the selected region
      const s = this.selection;
      outCanvas = document.createElement('canvas');
      outCanvas.width = Math.ceil(s.w * this.DPR);
      outCanvas.height = Math.ceil(s.h * this.DPR);
      const oc = outCanvas.getContext('2d');
      oc.drawImage(flat,
        s.x * this.DPR, s.y * this.DPR, s.w * this.DPR, s.h * this.DPR,
        0, 0, outCanvas.width, outCanvas.height);
    } else {
      outCanvas = flat;
    }
    const blob = await new Promise(resolve => outCanvas.toBlob(resolve, 'image/png'));
    if (!blob) { this.showToast('⚠ Copy failed'); return; }
    // Always store in internal buffer so paste fallback works
    this._clipboardBlob = blob;
    // Try modern Clipboard API (not available in all browsers, e.g. Firefox on iPad)
    let clipboardOk = false;
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        clipboardOk = true;
      } catch (err) { console.warn('Clipboard API write unavailable, relying on internal buffer:', err); }
    }
    if (clipboardOk) {
      this.showToast(this.selection ? '📋 Selection copied' : '📋 Copied to clipboard');
    } else {
      this.showToast(this.selection ? '📋 Selection copied (in-app only)' : '📋 Copied (in-app only)');
    }
  }

  _pasteImageBlob(blob) {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      this.pushUndo();
      const l = this.getActiveLayer();
      if (this.selection) {
        const s = this.selection;
        l.ctx.drawImage(img, 0, 0, img.width, img.height, s.x, s.y, s.w, s.h);
      } else {
        l.ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, this.W, this.H);
      }
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
    // Try modern Clipboard API first
    if (navigator.clipboard?.read) {
      try {
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
        this.showToast('⚠ No image in clipboard');
        return;
      } catch (err) { console.warn('Clipboard API read unavailable, trying internal buffer:', err); }
    }
    // Fallback: use internal clipboard buffer if available
    if (this._clipboardBlob) {
      this._pasteImageBlob(this._clipboardBlob);
      return;
    }
    // Last resort: open file picker when clipboard is unavailable
    this.showToast('📋 Clipboard unavailable — select an image file');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) this._pasteImageBlob(file);
    };
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
      controls.primaryColor = this.primaryEl.value;
      controls.secondaryColor = this.secondaryEl.value;
      controls.bgColor = this.bgColorEl ? this.bgColorEl.value : '#ffffff';
      controls.activeBrush = this.activeBrush;
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
