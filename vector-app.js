import {
  cloneDocument,
  createEmptyDocument,
  createShape,
  createShapeId,
  getShapeBounds,
  getShapePoints,
  normalizeDocument,
  translateShape,
  updateShapePoint,
} from './vector-document.js';
import { buildVectorSidebar, syncVectorSidebar } from './vector-ui.js';

const LOCAL_STORAGE_KEY = 'boid-brush-vector-draft';
const MAX_HISTORY_LENGTH = 80;
const DOWNLOAD_URL_REVOKE_DELAY_MS = 250;
const PASTE_OFFSET_PX = 24;
const MIN_SHAPE_DIMENSION_PX = 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

class VectorEditorApp {
  constructor() {
    this.doc = createEmptyDocument();
    this.state = {
      tool: 'select',
      selection: [],
      defaults: {
        fill: '#5b8af0',
        stroke: '#e8edf8',
        strokeWidth: 4,
        opacity: 1,
      },
      view: {
        x: 0,
        y: 0,
        width: this.doc.width,
        height: this.doc.height,
      },
      clipboard: [],
      polylineDraft: null,
      hoverPoint: null,
      interaction: null,
      history: [],
      future: [],
      status: 'Ready',
    };
    this._suspendHistory = false;
    this._downloadCleanupTimers = new Set();
    this._wireShell();
    this._snapshot('Initial state');
    this.render();
  }

  _wireShell() {
    this.stage = document.getElementById('vectorStage');
    this.scene = document.getElementById('vectorScene');
    this.preview = document.getElementById('vectorPreview');
    this.overlay = document.getElementById('vectorOverlay');
    this.statusEl = document.getElementById('vectorStatus');
    this.fileInput = document.getElementById('vectorJsonInput');
    buildVectorSidebar();

    document.querySelectorAll('[data-tool]').forEach(button => {
      button.addEventListener('click', () => this.setTool(button.dataset.tool));
    });
    document.getElementById('finishPathBtn')?.addEventListener('click', () => this.finishPolyline());
    document.getElementById('undoVectorBtn')?.addEventListener('click', () => this.undo());
    document.getElementById('redoVectorBtn')?.addEventListener('click', () => this.redo());
    document.getElementById('copyVectorBtn')?.addEventListener('click', () => this.copySelection());
    document.getElementById('pasteVectorBtn')?.addEventListener('click', () => this.pasteClipboard());
    document.getElementById('exportSvgBtn')?.addEventListener('click', () => this.exportSvg());
    document.getElementById('saveLocalBtn')?.addEventListener('click', () => this.saveLocalDraft());
    document.getElementById('loadLocalBtn')?.addEventListener('click', () => this.loadLocalDraft());
    document.getElementById('saveJsonBtn')?.addEventListener('click', () => this.downloadJson());
    document.getElementById('openJsonBtn')?.addEventListener('click', () => this.fileInput?.click());
    document.getElementById('duplicateShapeBtn')?.addEventListener('click', () => this.duplicateSelection());
    document.getElementById('deleteShapeBtn')?.addEventListener('click', () => this.deleteSelection());
    document.getElementById('moveShapeUpBtn')?.addEventListener('click', () => this.moveSelection(1));
    document.getElementById('moveShapeDownBtn')?.addEventListener('click', () => this.moveSelection(-1));

    this.fileInput?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) this.openJson(file);
    });

    [
      ['docWidth', value => this.updateDocumentSize({ width: Number(value) || this.doc.width })],
      ['docHeight', value => this.updateDocumentSize({ height: Number(value) || this.doc.height })],
      ['docBackground', value => this.updateDocumentBackground(value)],
      ['defaultFill', value => this.updateDefaults({ fill: value })],
      ['defaultStroke', value => this.updateDefaults({ stroke: value })],
      ['defaultStrokeWidth', value => this.updateDefaults({ strokeWidth: Math.max(1, Number(value) || 1) })],
      ['defaultOpacity', value => this.updateDefaults({ opacity: clamp(Number(value) || 1, 0.05, 1) })],
      ['selectedGuideRole', value => this.updateSelectedMeta({ guideRole: value }, true)],
      ['selectedFill', value => this.updateSelectedStyle({ fill: value })],
      ['selectedStroke', value => this.updateSelectedStyle({ stroke: value })],
      ['selectedStrokeWidth', value => this.updateSelectedStyle({ strokeWidth: Math.max(1, Number(value) || 1) })],
      ['selectedOpacity', value => this.updateSelectedStyle({ opacity: clamp(Number(value) || 1, 0.05, 1) })],
    ].forEach(([id, handler]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => handler(el.value));
      el.addEventListener('change', () => {
        handler(el.value);
        this._snapshot(`Changed ${id}`);
      });
    });

    this.stage.addEventListener('pointerdown', event => this._onPointerDown(event));
    window.addEventListener('pointermove', event => this._onPointerMove(event));
    window.addEventListener('pointerup', event => this._onPointerUp(event));
    this.stage.addEventListener('dblclick', event => {
      if (this.state.tool === 'polyline') {
        event.preventDefault();
        this.finishPolyline();
      }
    });
    this.stage.addEventListener('wheel', event => this._onWheel(event), { passive: false });
    document.addEventListener('keydown', event => this._onKeyDown(event));
    document.getElementById('vectorSidebar')?.addEventListener('click', event => {
      const itemButton = event.target.closest('[data-item-id]');
      if (!itemButton) return;
      this.selectOnly(itemButton.dataset.itemId);
    });
    window.addEventListener('beforeunload', () => {
      for (const timerId of this._downloadCleanupTimers) clearTimeout(timerId);
      this._downloadCleanupTimers.clear();
    });
  }

  getSelectedShape() {
    const id = this.state.selection[0];
    return id ? this.doc.items.find(item => item.id === id) || null : null;
  }

  setTool(tool) {
    this.state.tool = tool;
    if (tool !== 'polyline') {
      this.state.polylineDraft = null;
      this.state.hoverPoint = null;
    }
    this._setStatus(`Tool: ${tool}`);
    this.render();
  }

  updateDefaults(next) {
    this.state.defaults = { ...this.state.defaults, ...next };
    if (this.getSelectedShape()) this.updateSelectedStyle(next);
    this.render();
  }

  updateDocumentSize({ width = this.doc.width, height = this.doc.height }) {
    this.doc.width = Math.max(1, Math.round(width));
    this.doc.height = Math.max(1, Math.round(height));
    this.state.view.width = this.doc.width;
    this.state.view.height = this.doc.height;
    this.render();
  }

  updateDocumentBackground(background) {
    this.doc.background = background;
    this.render();
  }

  updateSelectedStyle(next) {
    const selected = this.getSelectedShape();
    if (!selected) return;
    selected.style = { ...selected.style, ...next };
    if ((selected.kind === 'line' || selected.kind === 'polyline') && next.fill) {
      selected.style.fill = 'none';
    }
    this.render();
  }

  updateSelectedMeta(next) {
    const selected = this.getSelectedShape();
    if (!selected) return;
    selected.meta = { ...selected.meta, ...next };
    this.render();
  }

  selectOnly(id) {
    this.state.selection = id ? [id] : [];
    this.render();
  }

  addShape(shape, snapshotLabel = 'Added shape') {
    this.doc.items.push(shape);
    this.state.selection = [shape.id];
    this._snapshot(snapshotLabel);
    this.render();
  }

  deleteSelection() {
    const selected = new Set(this.state.selection);
    if (!selected.size) return;
    this.doc.items = this.doc.items.filter(item => !selected.has(item.id));
    this.state.selection = [];
    this._snapshot('Deleted selection');
    this.render();
  }

  duplicateSelection() {
    this.copySelection();
    this.pasteClipboard();
  }

  copySelection() {
    const selection = this.doc.items.filter(item => this.state.selection.includes(item.id));
    if (!selection.length) return;
    this.state.clipboard = selection.map(item => cloneDocument(item));
    this._setStatus(`Copied ${selection.length} shape${selection.length === 1 ? '' : 's'}`);
    this.render();
  }

  pasteClipboard() {
    if (!this.state.clipboard.length) return;
    const pasted = this.state.clipboard.map(item => {
      const clone = cloneDocument(item);
      clone.id = createShapeId();
      return translateShape(clone, PASTE_OFFSET_PX, PASTE_OFFSET_PX);
    });
    this.doc.items.push(...pasted);
    this.state.selection = pasted.map(item => item.id);
    this.state.clipboard = pasted.map(item => cloneDocument(item));
    this._snapshot('Pasted shape');
    this.render();
  }

  moveSelection(direction) {
    const selected = this.getSelectedShape();
    if (!selected) return;
    const index = this.doc.items.findIndex(item => item.id === selected.id);
    const nextIndex = clamp(index + direction, 0, this.doc.items.length - 1);
    if (index === nextIndex) return;
    const [item] = this.doc.items.splice(index, 1);
    this.doc.items.splice(nextIndex, 0, item);
    this._snapshot('Reordered shape');
    this.render();
  }

  saveLocalDraft() {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(this.doc));
    this._setStatus('Saved local draft');
  }

  loadLocalDraft() {
    const payload = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!payload) {
      this._setStatus('No local draft saved yet');
      return;
    }
    try {
      this.doc = normalizeDocument(JSON.parse(payload));
      this.state.selection = [];
      this.state.view = { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
      this._snapshot('Loaded local draft');
      this._setStatus('Loaded local draft');
    } catch (error) {
      console.error(error);
      this._setStatus('Failed to load local draft');
    }
    this.render();
  }

  downloadJson() {
    const blob = new Blob([JSON.stringify(this.doc, null, 2)], { type: 'application/json' });
    this._downloadBlob(blob, 'boid-brush-vector.json');
    this._setStatus('Downloaded JSON');
  }

  async openJson(file) {
    try {
      const text = await file.text();
      this.doc = normalizeDocument(JSON.parse(text));
      this.state.selection = [];
      this.state.view = { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
      this._snapshot('Opened JSON');
      this._setStatus(`Opened ${file.name}`);
    } catch (error) {
      console.error(error);
      this._setStatus(`Failed to open ${file.name}`);
    }
    this.render();
  }

  exportSvg() {
    const svg = this._serializeSvg();
    this._downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'boid-brush-vector.svg');
    this._setStatus('Exported SVG');
  }

  undo() {
    if (this.state.history.length <= 1) return;
    const current = this.state.history.pop();
    this.state.future.push(current);
    const previous = this.state.history[this.state.history.length - 1];
    this.doc = cloneDocument(previous.doc);
    this.state.selection = [...previous.selection];
    this.state.view = cloneDocument(previous.view);
    this.render();
  }

  redo() {
    const next = this.state.future.pop();
    if (!next) return;
    this.state.history.push(cloneDocument(next));
    this.doc = cloneDocument(next.doc);
    this.state.selection = [...next.selection];
    this.state.view = cloneDocument(next.view);
    this.render();
  }

  finishPolyline() {
    const draft = this.state.polylineDraft;
    if (!draft || draft.points.length < 2) return;
    const shape = createShape('polyline', { points: draft.points }, this._currentShapeStyle('polyline'), { guideRole: 'path' });
    this.state.polylineDraft = null;
    this.state.hoverPoint = null;
    this.addShape(shape, 'Added polyline');
    this.setTool('select');
  }

  _currentShapeStyle(kind) {
    const style = {
      fill: this.state.defaults.fill,
      stroke: this.state.defaults.stroke,
      strokeWidth: this.state.defaults.strokeWidth,
      opacity: this.state.defaults.opacity,
    };
    if (kind === 'line' || kind === 'polyline') style.fill = 'none';
    return style;
  }

  _onPointerDown(event) {
    if (event.button !== 0) return;
    const point = this._clientToDocPoint(event.clientX, event.clientY);
    const handle = event.target.closest('[data-handle-index]');
    if (handle) {
      const shapeId = handle.dataset.shapeId;
      const pointIndex = Number(handle.dataset.handleIndex);
      const shape = this.doc.items.find(item => item.id === shapeId);
      if (!shape) return;
      this.state.selection = [shapeId];
      this.state.interaction = {
        type: 'point-drag',
        shapeId,
        pointIndex,
        original: cloneDocument(shape),
      };
      this.render();
      return;
    }

    if (this.state.tool === 'pan') {
      this.state.interaction = {
        type: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        originalView: cloneDocument(this.state.view),
      };
      return;
    }

    if (this.state.tool === 'polyline') {
      if (!this.state.polylineDraft) {
        this.state.polylineDraft = { points: [point] };
      } else {
        this.state.polylineDraft.points.push(point);
      }
      this.state.hoverPoint = point;
      this._setStatus(`Polyline points: ${this.state.polylineDraft.points.length}`);
      this.render();
      return;
    }

    const shapeEl = event.target.closest('[data-shape-id]');
    if (this.state.tool === 'select') {
      if (shapeEl) {
        const shapeId = shapeEl.dataset.shapeId;
        this.state.selection = [shapeId];
        const shape = this.getSelectedShape();
        this.state.interaction = {
          type: 'move-shape',
          shapeId,
          start: point,
          original: cloneDocument(shape),
        };
      } else {
        this.state.selection = [];
      }
      this.render();
      return;
    }

    if (this.state.tool === 'rect' || this.state.tool === 'ellipse' || this.state.tool === 'line') {
      this.state.interaction = {
        type: 'draw-shape',
        kind: this.state.tool,
        start: point,
        current: point,
      };
      this.render();
    }
  }

  _onPointerMove(event) {
    const point = this._clientToDocPoint(event.clientX, event.clientY);
    if (this.state.tool === 'polyline') {
      this.state.hoverPoint = point;
      if (!this.state.interaction) this.render();
    }
    const interaction = this.state.interaction;
    if (!interaction) return;
    if (interaction.type === 'draw-shape') {
      interaction.current = point;
      this.render();
      return;
    }
    if (interaction.type === 'move-shape') {
      const dx = point.x - interaction.start.x;
      const dy = point.y - interaction.start.y;
      const index = this.doc.items.findIndex(item => item.id === interaction.shapeId);
      if (index >= 0) this.doc.items[index] = translateShape(interaction.original, dx, dy);
      this.render();
      return;
    }
    if (interaction.type === 'point-drag') {
      const index = this.doc.items.findIndex(item => item.id === interaction.shapeId);
      if (index >= 0) this.doc.items[index] = updateShapePoint(interaction.original, interaction.pointIndex, point.x, point.y);
      this.render();
      return;
    }
    if (interaction.type === 'pan') {
      const scaleX = interaction.originalView.width / this.stage.clientWidth;
      const scaleY = interaction.originalView.height / this.stage.clientHeight;
      this.state.view.x = interaction.originalView.x - (event.clientX - interaction.startClientX) * scaleX;
      this.state.view.y = interaction.originalView.y - (event.clientY - interaction.startClientY) * scaleY;
      this.render();
    }
  }

  _onPointerUp() {
    const interaction = this.state.interaction;
    if (!interaction) return;
    if (interaction.type === 'draw-shape') {
      const shape = this._shapeFromDraft(interaction.kind, interaction.start, interaction.current);
      if (shape) this.addShape(shape, `Added ${interaction.kind}`);
    } else if (interaction.type === 'move-shape') {
      this._snapshot('Moved shape');
    } else if (interaction.type === 'point-drag') {
      this._snapshot('Edited points');
    } else if (interaction.type === 'pan') {
      this._setStatus(`View ${Math.round(this.state.view.x)}, ${Math.round(this.state.view.y)}`);
    }
    this.state.interaction = null;
    this.render();
  }

  _onWheel(event) {
    event.preventDefault();
    const zoomFactor = event.deltaY < 0 ? 0.9 : 1.1;
    const point = this._clientToDocPoint(event.clientX, event.clientY);
    const nextWidth = clamp(this.state.view.width * zoomFactor, 120, this.doc.width * 8);
    const nextHeight = clamp(this.state.view.height * zoomFactor, 120, this.doc.height * 8);
    const relX = (point.x - this.state.view.x) / this.state.view.width;
    const relY = (point.y - this.state.view.y) / this.state.view.height;
    this.state.view = {
      x: point.x - relX * nextWidth,
      y: point.y - relY * nextHeight,
      width: nextWidth,
      height: nextHeight,
    };
    this.render();
  }

  _onKeyDown(event) {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      this.copySelection();
      return;
    }
    if (mod && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      this.pasteClipboard();
      return;
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.exportSvg();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    if (event.key === 'Escape') {
      this.state.polylineDraft = null;
      this.state.hoverPoint = null;
      this.state.interaction = null;
      this.setTool('select');
      return;
    }
    if (event.key === 'Enter' && this.state.tool === 'polyline') {
      event.preventDefault();
      this.finishPolyline();
      return;
    }
    const toolKeys = {
      v: 'select',
      h: 'pan',
      l: 'line',
      r: 'rect',
      e: 'ellipse',
      p: 'polyline',
    };
    const tool = toolKeys[event.key.toLowerCase()];
    if (tool) {
      event.preventDefault();
      this.setTool(tool);
    }
  }

  _shapeFromDraft(kind, start, current) {
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    if (kind === 'rect') {
      if (Math.abs(dx) < MIN_SHAPE_DIMENSION_PX || Math.abs(dy) < MIN_SHAPE_DIMENSION_PX) return null;
      return createShape('rect', {
        x: Math.min(start.x, current.x),
        y: Math.min(start.y, current.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      }, this._currentShapeStyle('rect'));
    }
    if (kind === 'ellipse') {
      if (Math.abs(dx) < MIN_SHAPE_DIMENSION_PX || Math.abs(dy) < MIN_SHAPE_DIMENSION_PX) return null;
      return createShape('ellipse', {
        cx: (start.x + current.x) / 2,
        cy: (start.y + current.y) / 2,
        rx: Math.abs(dx) / 2,
        ry: Math.abs(dy) / 2,
      }, this._currentShapeStyle('ellipse'));
    }
    if (kind === 'line') {
      if (Math.abs(dx) < MIN_SHAPE_DIMENSION_PX && Math.abs(dy) < MIN_SHAPE_DIMENSION_PX) return null;
      return createShape('line', {
        x1: start.x,
        y1: start.y,
        x2: current.x,
        y2: current.y,
      }, this._currentShapeStyle('line'), { guideRole: 'path' });
    }
    return null;
  }

  _clientToDocPoint(clientX, clientY) {
    const svgPoint = this.scene.createSVGPoint();
    svgPoint.x = clientX;
    svgPoint.y = clientY;
    const matrix = this.scene.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const point = svgPoint.matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }

  _snapshot(label) {
    if (this._suspendHistory) return;
    const snapshot = {
      label,
      doc: cloneDocument(this.doc),
      selection: [...this.state.selection],
      view: cloneDocument(this.state.view),
    };
    this.state.history.push(snapshot);
    if (this.state.history.length > MAX_HISTORY_LENGTH) this.state.history.shift();
    this.state.future = [];
  }

  _setStatus(message) {
    this.state.status = message;
  }

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    const timerId = setTimeout(() => {
      URL.revokeObjectURL(url);
      this._downloadCleanupTimers.delete(timerId);
    }, DOWNLOAD_URL_REVOKE_DELAY_MS);
    this._downloadCleanupTimers.add(timerId);
  }

  _serializeSvg() {
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.doc.width}" height="${this.doc.height}" viewBox="0 0 ${this.doc.width} ${this.doc.height}">`,
      `  <rect width="100%" height="100%" fill="${esc(this.doc.background)}" />`,
      ...this.doc.items.map(item => `  ${this._shapeMarkup(item)}`),
      `</svg>`,
    ].join('\n');
  }

  _shapeMarkup(shape) {
    const style = `fill="${esc(shape.style.fill)}" stroke="${esc(shape.style.stroke)}" stroke-width="${shape.style.strokeWidth}" opacity="${shape.style.opacity}" data-guide-role="${esc(shape.meta.guideRole || 'none')}"`;
    if (shape.kind === 'rect') {
      return `<rect x="${shape.geometry.x}" y="${shape.geometry.y}" width="${shape.geometry.width}" height="${shape.geometry.height}" rx="8" ${style} />`;
    }
    if (shape.kind === 'ellipse') {
      return `<ellipse cx="${shape.geometry.cx}" cy="${shape.geometry.cy}" rx="${shape.geometry.rx}" ry="${shape.geometry.ry}" ${style} />`;
    }
    if (shape.kind === 'line') {
      return `<line x1="${shape.geometry.x1}" y1="${shape.geometry.y1}" x2="${shape.geometry.x2}" y2="${shape.geometry.y2}" ${style} />`;
    }
    const points = shape.geometry.points.map(point => `${point.x},${point.y}`).join(' ');
    return `<polyline points="${points}" ${style} />`;
  }

  render() {
    const selectedId = this.state.selection[0] || null;
    [this.scene, this.preview, this.overlay].forEach(svg => {
      svg.setAttribute('viewBox', `${this.state.view.x} ${this.state.view.y} ${this.state.view.width} ${this.state.view.height}`);
    });

    this.scene.innerHTML = [
      `<rect x="0" y="0" width="${this.doc.width}" height="${this.doc.height}" fill="${esc(this.doc.background)}"></rect>`,
      ...this.doc.items.map(item => this._shapeMarkup(item).replace(/ \/>$/, ` class="vector-shape${item.id === selectedId ? ' vector-shape-selected' : ''}" data-shape-id="${item.id}" />`)),
    ].join('');

    this.preview.innerHTML = this._previewMarkup();
    this.overlay.innerHTML = this._overlayMarkup();

    const finishPathBtn = document.getElementById('finishPathBtn');
    if (finishPathBtn) finishPathBtn.disabled = !(this.state.tool === 'polyline' && this.state.polylineDraft?.points.length >= 2);

    document.querySelectorAll('[data-tool]').forEach(button => {
      button.classList.toggle('active', button.dataset.tool === this.state.tool);
    });
    document.getElementById('undoVectorBtn')?.toggleAttribute('disabled', this.state.history.length <= 1);
    document.getElementById('redoVectorBtn')?.toggleAttribute('disabled', !this.state.future.length);
    document.getElementById('pasteVectorBtn')?.toggleAttribute('disabled', !this.state.clipboard.length);

    syncVectorSidebar(this);

    const zoom = (this.doc.width / this.state.view.width) * 100;
    this.statusEl.textContent = `${this.state.status} · Tool ${this.state.tool} · Shapes ${this.doc.items.length} · Zoom ${Math.round(zoom)}%`;
  }

  _previewMarkup() {
    const interaction = this.state.interaction;
    if (interaction?.type === 'draw-shape') {
      const draftShape = this._shapeFromDraft(interaction.kind, interaction.start, interaction.current);
      if (!draftShape) return '';
      return this._shapeMarkup({ ...draftShape, style: { ...draftShape.style, opacity: 0.35 } });
    }
    if (this.state.polylineDraft) {
      const points = [...this.state.polylineDraft.points];
      if (this.state.hoverPoint) points.push(this.state.hoverPoint);
      if (points.length < 2) return '';
      const pointsAttr = points.map(point => `${point.x},${point.y}`).join(' ');
      return `<polyline points="${pointsAttr}" fill="none" stroke="${esc(this.state.defaults.stroke)}" stroke-width="${this.state.defaults.strokeWidth}" opacity="0.55" stroke-dasharray="10 8" />`;
    }
    return '';
  }

  _overlayMarkup() {
    const selected = this.getSelectedShape();
    if (!selected) return '';
    const bounds = getShapeBounds(selected);
    const handles = getShapePoints(selected)
      .map((point, index) => `<circle class="vector-handle" data-shape-id="${selected.id}" data-handle-index="${index}" cx="${point.x}" cy="${point.y}" r="8" />`)
      .join('');
    return `
      <rect class="vector-selection-box" x="${bounds.x - 10}" y="${bounds.y - 10}" width="${bounds.width + 20}" height="${bounds.height + 20}" />
      ${selected.kind === 'line' || selected.kind === 'polyline' ? handles : ''}
    `;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.vectorEditorApp = new VectorEditorApp();
});
