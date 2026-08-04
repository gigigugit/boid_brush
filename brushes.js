// =============================================================================
// brushes.js — Ant, Boid, Bristle, Eraser, Fluid, and Simple brush engines
//
// Each brush implements: onDown(x,y,pressure), onMove(x,y,pressure),
// onUp(x,y), onFrame(elapsed), taperFrame(t,p), drawOverlay(ctx,p),
// getStatusInfo(), deactivate().
// =============================================================================

import { BoidSim, FluidSim } from './wasm-bridge.js';
import { WebGPUBoidSim } from './webgpu-boid-sim.js';
import { createBoidStampRenderer } from './boid-renderer.js';
import { WebGPUFluidSim } from './webgpu-fluid-sim.js';
import { WebGPUFluidRenderer } from './fluid-renderer.js';
import { LEADER_OVERRIDE_FIELDS } from './ui.js';

// Pressure EMA alpha for BristleBrush (~6-frame smoothing window)
const BRISTLE_PRESSURE_ALPHA = 0.15;
// Max EMA damping: smoothing=1 → alpha = 1 - MAX_SMOOTH_DAMP ≈ 0.08
const MAX_SMOOTH_DAMP = 0.92;
// Low-pass filter strength for Pencil angle changes (higher = snappier, lower = smoother)
const BRISTLE_ANGLE_ALPHA = 0.16;
// Move samples inject less mass than pointer-down so a continuous stroke does not over-pack the lattice.
const FLUID_MOVE_SEED_RATIO = 0.45;
const FLUID_TIMESTEP_60FPS = 1 / 60;
// Maximum pheromone intensity (maps to Uint8 luminance for sensing upload)
const MAX_PHEROMONE = 255;
const SHARED_MOTION_SIM_MAX_AGENTS = 10000;
// Skip texture flow on nearly flat regions where the sampled slope is only a tiny fraction
// of the texture's full gradient range; this avoids unnecessary blur-canvas churn.
const MIN_TEXTURE_FLOW_SLOPE = 0.04;
const TEXTURE_FLOW_BASE_TRANSFER = 0.12;
const TEXTURE_FLOW_SLOPE_TRANSFER = 0.28;
const TEXTURE_FLOW_MAX_TRANSFER = 0.4;
const TEXTURE_EDGE_BREAKUP_MIN_SIZE = 0.7;
const TEXTURE_EDGE_BREAKUP_SIZE_SCALE = 0.18;
const TEXTURE_EDGE_BREAKUP_VALLEY_SCALE = 0.14;
const MIN_ALLOWED_SIM_HARDNESS = 0.1;
const FLUID_FINAL_PASS_MAX_SETTLING_STEPS = 480;
const FLUID_FINAL_PASS_REPLAY_STEPS_PER_FRAME = 12;
const FLUID_FINAL_PASS_SETTLE_STEPS_PER_FRAME = 6;
const FLUID3D_MOVE_EMIT_RATIO = 0.5;
const FLUID3D_ACTIVE_SUBSTEPS = 3;
const FLUID3D_FINAL_PASS_SETTLING_STEPS = 48;
const FLUID3D_FINAL_PASS_REPLAY_STEPS_PER_FRAME = 12;
const FLUID3D_FINAL_PASS_SETTLE_STEPS_PER_FRAME = 6;
const FLUID3D_FINAL_PASS_CAPTURE_STATS = false;
const FLUID3D_TEXTURE_GUIDE_MIN_SAMPLES = 3;
const FLUID3D_TEXTURE_GUIDE_MAX_SAMPLES = 8;
const FLUID3D_TEXTURE_GUIDE_FRAME_SAMPLES = 4;
// Minimum deviation from vertical (π/2) in radians to consider tilt data meaningful.
// Values closer to π/2 than this indicate the pen is essentially vertical or no tilt
// data is available from the hardware.
const TILT_THRESHOLD = 0.01; // ~0.57°
const AGENT_X = 0;
const AGENT_Y = 1;
const AGENT_VX = 2;
const AGENT_VY = 3;
const AGENT_OPACITY = 9;
const TREADMILL_MAX_CANDIDATES = 64; // sampled agent positions cached per frame for camera policies
// Predefined hue anchors used to visually separate detected boid quorum groups.
const BOID_GROUP_HUES = [18, 42, 78, 132, 188, 228, 276, 318];
const BOID_GROUP_COLOR_SATURATION = 85;
const BOID_GROUP_COLOR_LIGHTNESS = 68;
const BOID_GROUP_HUE_WRAP_OFFSET = 17;
// Probe up to 12 stamps per batch to confirm non-canvas backends copy visible
// pixels to the 2D target without paying a full-batch readback cost.
const STAMP_VISIBILITY_SAMPLE_COUNT = 12;
// Disable GPU paths for the session after 2 consecutive probe/render failures.
// This avoids repeated flicker/no-op draws on platforms with unstable interop.
const GPU_RENDERER_FAILURE_LIMIT = 2;
// Apple touch WebKit remains unreliable for boid GPU copy-out/compositing.
// Route normal boid stamp rendering to the Canvas2D batch backend there.
const DISABLE_BOID_GPU_RENDERING_ON_APPLE_TOUCH_WEBKIT = (() => {
  try {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
    const isIPadOS = platform === 'MacIntel' && maxTouchPoints > 1;
    const isAppleTouchDevice = /iPad|iPhone|iPod/i.test(ua) || isIPadOS;
    const isWebKit = /AppleWebKit/i.test(ua);
    return isAppleTouchDevice && isWebKit;
  } catch {
    return false;
  }
})();

// ---- Hex → HSL / HSL → CSS helpers ----
function hexToHSL(hex) {
  let r = parseInt(hex.slice(1, 3), 16) / 255;
  let g = parseInt(hex.slice(3, 5), 16) / 255;
  let b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100]; // degrees, %, %
}

function hslToCSS(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s));
  l = Math.max(0, Math.min(100, l));
  return `hsl(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%)`;
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  if (s <= 0) {
    const channel = Math.round(l * 255).toString(16).padStart(2, '0');
    return `#${channel}${channel}${channel}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToRgb = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const r = Math.round(hueToRgb(h + 1 / 3) * 255).toString(16).padStart(2, '0');
  const g = Math.round(hueToRgb(h) * 255).toString(16).padStart(2, '0');
  const b = Math.round(hueToRgb(h - 1 / 3) * 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

function hexToRGB(hex) {
  let value = String(hex || '#000000');
  if (!/^#[\da-f]{3,6}$/i.test(value)) return { r: 0, g: 0, b: 0 };
  if (value.length === 4) {
    value = '#' + value.slice(1).split('').map(ch => ch + ch).join('');
  }
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}

function hslToRGB(h, s, l) {
  return hexToRGB(hslToHex(h, s, l));
}

function _normalizeBrushHexColor(value, fallback = '#000000') {
  let hex = String(value || '').trim();
  if (!hex) return fallback;
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex)) return fallback;
  if (hex.length === 4) {
    hex = `#${hex.slice(1).split('').map(ch => ch + ch).join('')}`;
  }
  return hex.toLowerCase();
}

function _resetSimulationSpawnAppearance(brush) {
  brush._agentSpawnColors = [];
  brush._agentSpawnOpacity = [];
}

function _setSimulationSpawnAppearanceRange(brush, spawnInfo, config, p) {
  if (!brush?.app?.simulation?.enabled || !spawnInfo || spawnInfo.endIndex <= spawnInfo.startIndex) return;
  if (!brush._agentSpawnColors || !brush._agentSpawnOpacity) _resetSimulationSpawnAppearance(brush);
  const color = _normalizeBrushHexColor(config?.color, _normalizeBrushHexColor(p?.color, '#000000'));
  const opacity = Number.isFinite(config?.opacity)
    ? Math.max(0, Math.min(1, config.opacity))
    : (Number.isFinite(p?.stampOpacity) ? Math.max(0, Math.min(1, p.stampOpacity)) : 1);
  for (let index = spawnInfo.startIndex; index < spawnInfo.endIndex; index++) {
    brush._agentSpawnColors[index] = color;
    brush._agentSpawnOpacity[index] = opacity;
  }
}

function _getSimulationSpawnAppearance(brush, index, p) {
  const color = _normalizeBrushHexColor(brush?._agentSpawnColors?.[index], _normalizeBrushHexColor(p?.color, '#000000'));
  const opacity = Number.isFinite(brush?._agentSpawnOpacity?.[index])
    ? Math.max(0, Math.min(1, brush._agentSpawnOpacity[index]))
    : (Number.isFinite(p?.stampOpacity) ? Math.max(0, Math.min(1, p.stampOpacity)) : 1);
  return { color, opacity };
}

function _relativeLuminanceFromHex(color, fallback = 0) {
  const hex = _normalizeBrushHexColor(color, '#000000');
  const rgb = hexToRGB(hex);
  if (!rgb) return fallback;
  const channel = value => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function _getVisibleTreadmillStampColor(app, color) {
  const stampColor = _normalizeBrushHexColor(color, '#000000');
  const bgColor = _normalizeBrushHexColor(app?.getColorValue?.('background', '#313131'), '#313131');
  const stampLum = _relativeLuminanceFromHex(stampColor, 0);
  const bgLum = _relativeLuminanceFromHex(bgColor, 0.03);
  return Math.abs(stampLum - bgLum) < 0.035 ? '#ffffff' : stampColor;
}

function _syncSimulationSpawnAppearance(brush, spawns, resolveConfig, p) {
  if (!brush?.app?.simulation?.enabled || !brush?.sim || !Array.isArray(spawns) || typeof resolveConfig !== 'function') return;
  const activeSpawns = spawns.filter(spawn => spawn?.enabled !== false);
  if (!activeSpawns.length) {
    _resetSimulationSpawnAppearance(brush);
    return;
  }
  const nextColors = [];
  const nextOpacity = [];
  const liveCount = Math.max(0, brush.sim.readAgents?.().count || 0);
  let cursor = 0;
  for (const spawn of activeSpawns) {
    const config = resolveConfig(spawn);
    const color = _normalizeBrushHexColor(config?.color, _normalizeBrushHexColor(p?.color, '#000000'));
    const opacity = Number.isFinite(config?.opacity)
      ? Math.max(0, Math.min(1, config.opacity))
      : (Number.isFinite(p?.stampOpacity) ? Math.max(0, Math.min(1, p.stampOpacity)) : 1);
    const expectedCount = Math.max(0, Math.round(config?.count || 0));
    for (let offset = 0; offset < expectedCount; offset++) {
      const index = cursor + offset;
      if (liveCount && index >= liveCount) break;
      nextColors[index] = color;
      nextOpacity[index] = opacity;
    }
    cursor += expectedCount;
    if (liveCount && cursor >= liveCount) break;
  }
  if (liveCount > cursor) {
    const fallback = resolveConfig(activeSpawns[0]);
    const color = _normalizeBrushHexColor(fallback?.color, _normalizeBrushHexColor(p?.color, '#000000'));
    const opacity = Number.isFinite(fallback?.opacity)
      ? Math.max(0, Math.min(1, fallback.opacity))
      : (Number.isFinite(p?.stampOpacity) ? Math.max(0, Math.min(1, p.stampOpacity)) : 1);
    for (let index = cursor; index < liveCount; index++) {
      nextColors[index] = color;
      nextOpacity[index] = opacity;
    }
  }
  brush._agentSpawnColors = nextColors;
  brush._agentSpawnOpacity = nextOpacity;
}

function _resolveLeaderParams(p) {
  const leaderConfig = p?.leaderConfig;
  const leader = {
    count: Math.max(0, Math.min(Math.round(leaderConfig?.count || 0), Math.round(p?.count || 0))),
    pull: Number.isFinite(leaderConfig?.pull) ? Math.max(0, leaderConfig.pull) : 0,
  };
  for (const field of LEADER_OVERRIDE_FIELDS) {
    const override = leaderConfig?.overrides?.[field.key];
    leader[field.key] = override?.enabled ? override.value : p[field.key];
  }
  return leader;
}

class StampInstanceBuffer {
  constructor(initialCapacity = 1024) {
    this._stride = 8;
    this._capacity = Math.max(1, initialCapacity);
    this._data = new Float32Array(this._capacity * this._stride);
    this.count = 0;
  }

  _grow() {
    this._capacity *= 2;
    const next = new Float32Array(this._capacity * this._stride);
    next.set(this._data);
    this._data = next;
  }

  push(x, y, size, r, g, b, a, rotation = 0) {
    if (this.count >= this._capacity) this._grow();
    const base = this.count * this._stride;
    this._data[base + 0] = x;
    this._data[base + 1] = y;
    this._data[base + 2] = size;
    // Store per-stamp rotation in the spare slot while preserving the
    // renderer's 8-float / 32-byte instance stride.
    this._data[base + 3] = rotation;
    this._data[base + 4] = r / 255;
    this._data[base + 5] = g / 255;
    this._data[base + 6] = b / 255;
    this._data[base + 7] = a;
    this.count++;
  }

  finish() {
    return this._data.subarray(0, this.count * this._stride);
  }
}

function _ensureProceduralStampRendererInit(brush) {
  if (!brush?.renderer) return Promise.resolve(false);
  if (brush._rendererInitPromise) return brush._rendererInitPromise;
  brush._rendererInitPromise = brush.renderer.init()
    .then(() => {
      if (brush._rendererChainPatched) return true;
      brush.renderer._getRendererChain = (renderState = {}) => {
        const chain = [];
        if (brush._gpuDisabledReason) {
          chain.push(brush.renderer.canvas);
          return chain;
        }
        if (renderState.stampBitmap) {
          if (brush.renderer.webgl.ready) chain.push(brush.renderer.webgl);
          chain.push(brush.renderer.canvas);
          return chain;
        }
        if (brush.renderer.webgpu.ready) chain.push(brush.renderer.webgpu);
        if (brush.renderer.webgl.ready) chain.push(brush.renderer.webgl);
        chain.push(brush.renderer.canvas);
        return chain;
      };
      brush._rendererChainPatched = true;
      return true;
    })
    .catch(() => false);
  return brush._rendererInitPromise;
}

function _setProceduralRenderBackend(brush, kind, reason = '') {
  brush._renderBackend = kind;
  brush._renderLegacyReason = kind === 'legacy' ? reason : '';
}

function _formatProceduralLegacyFallbackReason(reason) {
  const coreReason = reason || 'GPU procedural-stamp renderer failed';
  return `${coreReason}; using CPU fallback`;
}

function _noteProceduralGpuFailure(brush, reason) {
  brush._gpuFailureCount = (brush._gpuFailureCount || 0) + 1;
  if (brush._gpuFailureCount >= GPU_RENDERER_FAILURE_LIMIT) {
    brush._gpuDisabledReason = reason;
  }
  _setProceduralRenderBackend(
    brush,
    'legacy',
    _formatProceduralLegacyFallbackReason(brush._gpuDisabledReason || reason),
  );
}

function _resetProceduralGpuFailure(brush) {
  brush._gpuFailureCount = 0;
}

function _getProceduralBatchRendererSupport(brush, p, flat = brush._flatActive) {
  const layer = brush.app.getActiveLayer();
  if (!layer) return { ok: false, reason: 'no active layer' };
  if (layer.alphaLock && flat) return { ok: false, reason: 'alpha lock enabled with flat stroke' };
  if (p.trailBlur > 0) return { ok: false, reason: 'trail blur enabled' };
  if (p.trailFlow > 0) return { ok: false, reason: 'texture flow enabled' };
  if (p.smudge > 0) return { ok: false, reason: 'smudge enabled' };
  if (p.smudgeOnly) return { ok: false, reason: 'smudge only enabled' };
  if (p.kmMix && p.kmStrength > 0) return { ok: false, reason: 'pigment mix enabled' };
  if (p.impasto && p.impastoStrength > 0) return { ok: false, reason: 'impasto enabled' };
  if (brush._gpuDisabledReason) return { ok: false, reason: brush._gpuDisabledReason };
  if (!brush.renderer.canRenderBatch({ stampBitmap: p.stampImageCanvas || null })) {
    return { ok: false, reason: brush.renderer.getUnavailableReason({ stampBitmap: p.stampImageCanvas || null }) };
  }
  return { ok: true, reason: '' };
}

function _batchHasVisiblePixels(targetCtx, batch, dpr = 1) {
  if (!targetCtx || !batch?.instances || batch.count <= 0) return false;
  const canvas = targetCtx.canvas;
  if (!canvas?.width || !canvas?.height) return false;
  const instances = batch.instances;
  const sampleCount = Math.min(batch.count, STAMP_VISIBILITY_SAMPLE_COUNT);
  const stride = 8;
  try {
    for (let i = 0; i < sampleCount; i++) {
      const base = i * stride;
      const size = Math.max(1, instances[base + 2] * dpr);
      const cx = Math.round(instances[base + 0] * dpr);
      const cy = Math.round(instances[base + 1] * dpr);
      const offsets = [
        [0, 0],
        [Math.min(size * 0.25, 2), 0],
        [-Math.min(size * 0.25, 2), 0],
        [0, Math.min(size * 0.25, 2)],
        [0, -Math.min(size * 0.25, 2)],
      ];
      for (const [ox, oy] of offsets) {
        const x = Math.max(0, Math.min(canvas.width - 1, Math.round(cx + ox)));
        const y = Math.max(0, Math.min(canvas.height - 1, Math.round(cy + oy)));
        if (targetCtx.getImageData(x, y, 1, 1).data[3] > 0) return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

function _emitBatchStampInstances(app, instances, p, x, y, size, colorRGB, opacity, rotation = 0) {
  const renderPoints = p.symmetryEnabled
    ? app.getSymmetryPoints(x, y)
    : [{ x, y }];
  const seen = new Set();
  const emitInstance = (px, py, pointSize = size) => {
    const key = `${Math.round(px * 1000)}:${Math.round(py * 1000)}`;
    if (seen.has(key)) return;
    seen.add(key);
    let instOpacity = opacity;
    let instSize = pointSize;
    if (app.hasCanvasTexture?.() && p.canvasTextureEnabled) {
      instOpacity *= _textureDepositDensity(app, p, px, py);
      const edgeBreakup = app.getTextureEdgeBreakup?.(px, py, p) || 0;
      if (edgeBreakup > 0) {
        const field = app.sampleTextureField?.(px, py, p);
        instSize *= Math.max(
          TEXTURE_EDGE_BREAKUP_MIN_SIZE,
          1 - edgeBreakup * TEXTURE_EDGE_BREAKUP_SIZE_SCALE + ((field?.valley ?? 0.5) - 0.5) * edgeBreakup * TEXTURE_EDGE_BREAKUP_VALLEY_SCALE,
        );
      }
    }
    if (instOpacity < 0.005 || instSize < 0.5) return;
    instances.push(px, py, instSize, colorRGB.r, colorRGB.g, colorRGB.b, instOpacity, rotation);
  };

  for (const point of renderPoints) {
    const pointSize = size * (point.sizeMultiplier || 1);
    emitInstance(point.x, point.y, pointSize);
    if (!app.tilingMode || !app._getStampWrapPoints) continue;
    const wraps = app._getStampWrapPoints(point.x, point.y, pointSize);
    for (const wrap of wraps) emitInstance(wrap.x, wrap.y, pointSize);
  }
}

function _resolveBatchCompositeOperation(brush, p, layer, allowAlphaLock = false) {
  if (typeof brush._getBatchCompositeOperation === 'function') {
    return brush._getBatchCompositeOperation(p, layer, allowAlphaLock);
  }
  return allowAlphaLock && layer?.alphaLock ? 'source-atop' : 'source-over';
}

function _getProceduralGpuPreviewRenderer(brush, p) {
  if (p?.stampImageCanvas) return null;
  if (brush.renderer.webgpu?.ready) return brush.renderer.webgpu;
  if (brush.renderer.webgl?.ready) return brush.renderer.webgl;
  return null;
}

function _getProceduralGpuPreviewCanvas(renderer) {
  if (!renderer) return null;
  if (renderer.kind === 'webgpu') {
    // Prefer the async-synced preview canvas when available, but fall back to
    // the live WebGPU canvas so preview rendering remains visible immediately.
    return renderer.previewCanvas || renderer.canvas || null;
  }
  return renderer.previewCanvas || renderer.canvas || null;
}

function _canUseProceduralGpuPreview(brush, targetCtx, p) {
  const layer = brush.app.getActiveLayer();
  if (!layer || !targetCtx || targetCtx !== layer.ctx) return false;
  if (DISABLE_BOID_GPU_RENDERING_ON_APPLE_TOUCH_WEBKIT) return false;
  if (brush._flatActive) return false;
  if (!_getProceduralGpuPreviewRenderer(brush, p)) return false;
  if (p?.stampImageCanvas) return false;
  if ((p?.taperLength || 0) > 0 && !brush.app.isDrawing && !brush.app.simulation?.running) return false;
  if (layer.alphaLock) return false;
  if (layer.blend !== 'source-over') return false;
  if (Math.abs((layer.opacity ?? 1) - 1) > 1e-3) return false;
  return true;
}

function _clearProceduralGpuPreview(brush, { composite = false } = {}) {
  const layer = brush._gpuPreviewLayer;
  const renderer = brush._gpuPreviewRenderer;
  const previewCanvas = _getProceduralGpuPreviewCanvas(renderer);
  if (renderer) renderer.onPreviewUpdated = null;
  if (layer?.gpuPreviewCanvas && previewCanvas && layer.gpuPreviewCanvas === previewCanvas) {
    layer.gpuPreviewCanvas = null;
    layer.dirty = true;
  }
  if (renderer?.clearSurface && layer?.canvas?.width && layer?.canvas?.height) {
    renderer.clearSurface(layer.canvas.width, layer.canvas.height);
  }
  brush._gpuPreviewActive = false;
  brush._gpuPreviewLayer = null;
  brush._gpuPreviewRenderer = null;
  if (composite && layer) brush.app.compositeAllLayers();
}

function _resetMotionBrushPaintState(brush, layer = brush.app?.getActiveLayer?.()) {
  const dpr = brush.app?.DPR || 1;
  if (brush._preStrokeCanvas && brush._preStrokeCtx) {
    brush._preStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
    brush._preStrokeCtx.clearRect(0, 0, brush._preStrokeCanvas.width, brush._preStrokeCanvas.height);
    if (layer?.canvas) brush._preStrokeCtx.drawImage(layer.canvas, 0, 0);
  }
  if (brush._strokeCanvas && brush._strokeCtx) {
    brush._strokeCtx.setTransform(1, 0, 0, 1, 0, 0);
    brush._strokeCtx.clearRect(0, 0, brush._strokeCanvas.width, brush._strokeCanvas.height);
    brush._strokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (brush._blurStrokeCanvas && brush._blurStrokeCtx) {
    brush._blurStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
    brush._blurStrokeCtx.clearRect(0, 0, brush._blurStrokeCanvas.width, brush._blurStrokeCanvas.height);
    brush._blurStrokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function _commitProceduralGpuPreviewToLayer(brush, { allowAlphaLock = false } = {}) {
  const layer = brush._gpuPreviewLayer;
  const renderer = brush._gpuPreviewRenderer;
  if (!layer || !renderer?.ready) {
    _clearProceduralGpuPreview(brush);
    return false;
  }
  const compositeOperation = _resolveBatchCompositeOperation(
    brush,
    brush.app.getP(),
    layer,
    allowAlphaLock,
  );
  if (renderer.kind === 'webgpu' && !renderer._hasLivePreviewFrame) {
    // First try committing directly from the current WebGPU canvas; if that
    // fails, keep the deferred callback path as a fallback.
    const immediateOk = renderer.copyTo2D(
      layer.ctx,
      layer.canvas.width,
      layer.canvas.height,
      compositeOperation,
    );
    if (immediateOk) {
      renderer.clearSurface?.(layer.canvas.width, layer.canvas.height);
      layer.gpuPreviewCanvas = null;
      brush._gpuPreviewActive = false;
      brush._gpuPreviewLayer = null;
      renderer.onPreviewUpdated = null;
      brush._gpuPreviewRenderer = null;
      layer.dirty = true;
      brush.app.compositeAllLayers();
      return true;
    }
    renderer.onPreviewUpdated = (canvas) => {
      if (!canvas) return;
      if (!brush._gpuPreviewActive || brush._gpuPreviewLayer !== layer || brush._gpuPreviewRenderer !== renderer) return;
      layer.gpuPreviewCanvas = canvas;
      const ok = renderer.copyTo2D(
        layer.ctx,
        layer.canvas.width,
        layer.canvas.height,
        compositeOperation,
      );
      renderer.clearSurface?.(layer.canvas.width, layer.canvas.height);
      layer.gpuPreviewCanvas = null;
      brush._gpuPreviewActive = false;
      brush._gpuPreviewLayer = null;
      renderer.onPreviewUpdated = null;
      brush._gpuPreviewRenderer = null;
      if (!ok) return;
      layer.dirty = true;
      brush.app.compositeAllLayers();
    };
    return true;
  }
  const ok = renderer.copyTo2D(
    layer.ctx,
    layer.canvas.width,
    layer.canvas.height,
    compositeOperation,
  );
  renderer.clearSurface?.(layer.canvas.width, layer.canvas.height);
  layer.gpuPreviewCanvas = null;
  brush._gpuPreviewActive = false;
  brush._gpuPreviewLayer = null;
  renderer.onPreviewUpdated = null;
  brush._gpuPreviewRenderer = null;
  if (!ok) return false;
  layer.dirty = true;
  brush.app.compositeAllLayers();
  return true;
}

function _renderProceduralBatchToGpuPreview(brush, batch, p) {
  const layer = brush.app.getActiveLayer();
  const renderer = _getProceduralGpuPreviewRenderer(brush, p);
  if (!layer || !renderer?.ready) return false;
  const needsFreshSurface = !brush._gpuPreviewActive || brush._gpuPreviewLayer !== layer || brush._gpuPreviewRenderer !== renderer;
  renderer.onPreviewUpdated = (canvas) => {
    if (!canvas) return;
    if (!brush._gpuPreviewActive || brush._gpuPreviewLayer !== layer || brush._gpuPreviewRenderer !== renderer) return;
    layer.gpuPreviewCanvas = canvas;
    layer.dirty = true;
    brush.app.compositeAllLayers();
  };
  if (brush._gpuPreviewActive && brush._gpuPreviewRenderer && brush._gpuPreviewRenderer !== renderer) {
    _commitProceduralGpuPreviewToLayer(brush);
  }
  if (needsFreshSurface) {
    if (renderer.kind === 'webgpu') {
      renderer.invalidatePreview?.();
    } else if (!renderer.clearSurface?.(layer.canvas.width, layer.canvas.height)) {
      return false;
    }
    brush._gpuPreviewActive = true;
    brush._gpuPreviewLayer = layer;
    brush._gpuPreviewRenderer = renderer;
    layer.gpuPreviewCanvas = _getProceduralGpuPreviewCanvas(renderer);
  }
  const stampBitmap = p?.stampImageCanvas || null;
  const ok = renderer.render({
    instances: batch.instances,
    count: batch.count,
    targetWidthPx: layer.canvas.width,
    targetHeightPx: layer.canvas.height,
    dpr: brush.app.DPR,
    stampBitmap,
    stampTint: p?.stampImageTint !== false,
    stampRotation: p?.stampImageRotation || 0,
    stampAspect: stampBitmap?.width > 0 && stampBitmap?.height > 0 ? stampBitmap.width / stampBitmap.height : 1,
    copyToTarget: false,
    clear: needsFreshSurface,
  });
  if (!ok) {
    _commitProceduralGpuPreviewToLayer(brush);
    _clearProceduralGpuPreview(brush);
    return false;
  }
  layer.gpuPreviewCanvas = _getProceduralGpuPreviewCanvas(renderer);
  layer.dirty = true;
  _setProceduralRenderBackend(brush, renderer.kind);
  return true;
}

function _renderProceduralBatchToTarget(brush, targetCtx, batch, p, { allowAlphaLock = false, visibilityProbe = true } = {}) {
  const stampBitmap = p?.stampImageCanvas || null;
  const layer = brush.app.getActiveLayer();
  const previewAllowed = _canUseProceduralGpuPreview(brush, targetCtx, p);
  if (brush._gpuPreviewActive && !previewAllowed) {
    _commitProceduralGpuPreviewToLayer(brush, { allowAlphaLock });
  }
  if (previewAllowed) {
    return _renderProceduralBatchToGpuPreview(brush, batch, p);
  }
  if (batch.count <= 0) {
    _setProceduralRenderBackend(brush, brush.renderer.getPreferredBatchRendererKind({ stampBitmap }));
    return true;
  }
  const ok = brush.renderer.render({
    instances: batch.instances,
    count: batch.count,
    targetCtx,
    targetWidthPx: targetCtx?.canvas?.width || 0,
    targetHeightPx: targetCtx?.canvas?.height || 0,
    dpr: brush.app.DPR,
    stampBitmap,
    stampTint: p?.stampImageTint !== false,
    stampRotation: p?.stampImageRotation || 0,
    stampAspect: stampBitmap?.width > 0 && stampBitmap?.height > 0 ? stampBitmap.width / stampBitmap.height : 1,
    compositeOperation: _resolveBatchCompositeOperation(brush, p, layer, allowAlphaLock),
  });
  _setProceduralRenderBackend(brush, ok ? brush.renderer.activeKind : 'legacy', ok ? '' : brush.renderer.legacyReason);
  if (!ok) {
    _noteProceduralGpuFailure(brush, brush.renderer.legacyReason || 'GPU procedural-stamp renderer failed');
    return false;
  }
  if (visibilityProbe && brush.renderer.activeKind !== 'canvas' && !stampBitmap && !_batchHasVisiblePixels(targetCtx, batch, brush.app.DPR || 1)) {
    _noteProceduralGpuFailure(brush, 'GPU procedural-stamp visibility probe failed');
    return false;
  }
  _resetProceduralGpuFailure(brush);
  return true;
}

function _colorWithAlpha(color, alpha) {
  const a = _clamp(alpha, 0, 1);
  if (a <= 0) return 'rgba(0,0,0,0)';
  if (typeof color === 'string') {
    let hex = null;
    if (/^#[\da-f]{6}$/i.test(color)) hex = color.slice(1);
    else if (/^#[\da-f]{3}$/i.test(color)) hex = color.slice(1).split('').map(ch => ch + ch).join('');
    if (hex) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
  }
  return color;
}

function _shadeColor(color, lightnessDelta = -12, saturationDelta = 4) {
  if (typeof color !== 'string' || !/^#[\da-f]{3,6}$/i.test(color)) return color;
  const [h, s, l] = hexToHSL(color.length === 4
    ? '#' + color.slice(1).split('').map(ch => ch + ch).join('')
    : color);
  return hslToCSS(h, s + saturationDelta, l + lightnessDelta);
}

function _boidNeighborInFov(buffer, base, otherX, otherY, fovDeg) {
  if (!Number.isFinite(fovDeg) || fovDeg >= 360) return true;
  const dx = otherX - buffer[base + AGENT_X];
  const dy = otherY - buffer[base + AGENT_Y];
  const vx = buffer[base + AGENT_VX];
  const vy = buffer[base + AGENT_VY];
  let diff = Math.atan2(dy, dx) - Math.atan2(vy, vx);
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) < (fovDeg * Math.PI / 180) / 2;
}

function _computeBoidOverlayGroups(buffer, count, stride, p) {
  const groupIds = new Int16Array(count);
  groupIds.fill(-1);
  if (!count || !buffer || !Number.isFinite(p?.quorumThreshold) || p.quorumThreshold < 2) return groupIds;

  const neighborRadius = Math.max(1, Number.isFinite(p.neighborRadius) ? p.neighborRadius : 80);
  const neighborRadius2 = neighborRadius * neighborRadius;
  const members = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const baseI = i * stride;
    const xi = buffer[baseI + AGENT_X];
    const yi = buffer[baseI + AGENT_Y];
    let seen = 0;
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      const baseJ = j * stride;
      const dx = buffer[baseJ + AGENT_X] - xi;
      const dy = buffer[baseJ + AGENT_Y] - yi;
      if (dx * dx + dy * dy >= neighborRadius2) continue;
      if (!_boidNeighborInFov(buffer, baseI, buffer[baseJ + AGENT_X], buffer[baseJ + AGENT_Y], p.fov)) continue;
      seen++;
      if (seen >= p.quorumThreshold) {
        members[i] = 1;
        break;
      }
    }
  }

  let groupId = 0;
  const stack = [];
  for (let i = 0; i < count; i++) {
    if (!members[i] || groupIds[i] !== -1) continue;
    groupIds[i] = groupId;
    stack.push(i);
    while (stack.length) {
      const current = stack.pop();
      const baseI = current * stride;
      const xi = buffer[baseI + AGENT_X];
      const yi = buffer[baseI + AGENT_Y];
      for (let j = 0; j < count; j++) {
        if (!members[j] || groupIds[j] !== -1) continue;
        const baseJ = j * stride;
        const dx = buffer[baseJ + AGENT_X] - xi;
        const dy = buffer[baseJ + AGENT_Y] - yi;
        if (dx * dx + dy * dy >= neighborRadius2) continue;
        groupIds[j] = groupId;
        stack.push(j);
      }
    }
    groupId++;
  }

  return groupIds;
}

function _getBoidGroupCursorColor(groupId, alpha = 0.6) {
  if (groupId < 0) return `rgba(100,180,255,${alpha})`;
  const baseHue = BOID_GROUP_HUES[groupId % BOID_GROUP_HUES.length];
  const hue = (baseHue + Math.floor(groupId / BOID_GROUP_HUES.length) * BOID_GROUP_HUE_WRAP_OFFSET) % 360;
  return `hsla(${hue},${BOID_GROUP_COLOR_SATURATION}%,${BOID_GROUP_COLOR_LIGHTNESS}%,${Math.max(0, Math.min(1, alpha))})`;
}

function _fillRadialPool(ctx, app, x, y, radius, color, opacity) {
  if (!ctx || radius <= 0 || opacity <= 0) return;
  for (const pt of app.getSymmetryPoints(x, y)) {
    const scaledRadius = radius * (pt.sizeMultiplier || 1);
    const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, scaledRadius);
    grad.addColorStop(0, _colorWithAlpha(color, opacity));
    grad.addColorStop(0.58, _colorWithAlpha(color, opacity * 0.52));
    grad.addColorStop(1, _colorWithAlpha(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, scaledRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function _strokePoolRing(ctx, app, x, y, radius, color, opacity, width) {
  if (!ctx || radius <= 0 || opacity <= 0 || width <= 0) return;
  ctx.save();
  ctx.strokeStyle = _shadeColor(color);
  ctx.globalAlpha = opacity;
  for (const pt of app.getSymmetryPoints(x, y)) {
    const sizeMultiplier = pt.sizeMultiplier || 1;
    ctx.lineWidth = width * sizeMultiplier;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius * sizeMultiplier, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ---- Spawn shape generators (for JS-side simple/eraser line interpolation) ----
export const SpawnShapes = {
  circle(c, r) {
    const p = [];
    for (let i = 0; i < c; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
      p.push({ x: Math.cos(a) * d, y: Math.sin(a) * d });
    }
    return p;
  }
};

// =============================================================================
// BOID BRUSH — WASM-backed swarm simulation
// =============================================================================

/**
 * Apply a texture-aware flow step to the blur canvas.
 * Shifts paint pixels toward lower-height areas of the canvas texture,
 * simulating paint flowing into surface valleys.
 *
 * Operates on _blurCanvas (pre-blur data) so the subsequent CSS blur
 * smooths out any stepping artifacts.
 *
 * @param {CanvasRenderingContext2D} ctx - blur canvas context (_blurCtx)
 * @param {HTMLCanvasElement} canvas - blur canvas
 * @param {App} app - app instance (for texture data + DPR)
 * @param {number} flow - flow strength 0–1
 * @param {object} p - active brush params
 */
function _applyTextureFlow(ctx, canvas, app, flow, p) {
  const textureFlow = app.getTextureInfluence(p, 'flow');
  if (!app.hasCanvasTexture() || textureFlow <= 0 || flow <= 0) return;

  const w   = canvas.width;
  const h   = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;

  // Reuse a cached buffer to avoid large allocation every frame
  const needed = src.length;
  if (!_applyTextureFlow._buf || _applyTextureFlow._buf.length < needed) {
    _applyTextureFlow._buf = new Uint8ClampedArray(needed);
  }
  const dst = _applyTextureFlow._buf;
  dst.set(src);

  const dpr      = app.DPR;
  const invDpr   = 1 / dpr;
  // Maximum pixel shift per iteration (1–4 device pixels depending on strength)
  const flowStrength = flow * textureFlow;
  const shift = Math.max(1, Math.round(flowStrength * 4 * dpr));
  const margin = shift;

  for (let py = margin; py < h - margin; py++) {
    for (let px = margin; px < w - margin; px++) {
      const idx = (py * w + px) << 2;
      if (src[idx + 3] < 2) continue; // skip transparent

      const field = app.sampleTextureField(px * invDpr, py * invDpr, p);
      if (field.slope < MIN_TEXTURE_FLOW_SLOPE) continue;
      const len = Math.hypot(field.flowX, field.flowY);
      if (len < 1e-4) continue;
      const fx = Math.round((field.flowX / len) * shift);
      const fy = Math.round((field.flowY / len) * shift);
      if (!fx && !fy) continue;

      const tx = px + fx;
      const ty = py + fy;
      // Bounds already guaranteed by margin
      const tidx = (ty * w + tx) << 2;

      const t = Math.min(flowStrength * (TEXTURE_FLOW_BASE_TRANSFER + field.slope * TEXTURE_FLOW_SLOPE_TRANSFER), TEXTURE_FLOW_MAX_TRANSFER);

      const r = src[idx],     g = src[idx + 1], b = src[idx + 2], a = src[idx + 3];
      const rt = r * t, gt = g * t, bt = b * t, at = a * t;

      dst[idx]     -= rt;
      dst[idx + 1] -= gt;
      dst[idx + 2] -= bt;
      dst[idx + 3] -= at;

      dst[tidx]     = Math.min(255, dst[tidx]     + rt);
      dst[tidx + 1] = Math.min(255, dst[tidx + 1] + gt);
      dst[tidx + 2] = Math.min(255, dst[tidx + 2] + bt);
      dst[tidx + 3] = Math.min(255, dst[tidx + 3] + at);
    }
  }

  img.data.set(dst);
  ctx.putImageData(img, 0, 0);
}

/**
 * Stamp plain circles (CSS coordinates) into a blur accumulation canvas.
 * Applies the same symmetry as the main stamp but skips all canvas-sampling
 * effects (smudge, KM mix, impasto) to avoid side-effects on app state.
 */
function _stampToBlurAccum(bctx, app, x, y, sz, color, op) {
  if (app.hasActiveStampImage?.()) {
    app.symBitmapStamp(bctx, x, y, sz, color, op, {
      applyAlphaLock: false,
      applyImpasto: false,
      applyTexture: false,
      applyTiling: false,
      markDirty: false,
      tintEnabled: app.getP().stampImageTint,
    });
    return;
  }
  bctx.fillStyle = color;
  for (const pt of app.getSymmetryPoints(x, y)) {
    bctx.beginPath();
    bctx.arc(pt.x, pt.y, (sz * (pt.sizeMultiplier || 1)) / 2, 0, Math.PI * 2);
    bctx.globalAlpha = op;
    bctx.fill();
  }
  bctx.globalAlpha = 1;
}

function _clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function _closestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-6) return { x: ax, y: ay, t: 0 };
  const t = _clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return { x: ax + dx * t, y: ay + dy * t, t };
}

function _signedDistanceToLine(px, py, ax, ay, bx, by) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function _textureDepositDensity(app, p, x, y) {
  if (!app?.getTextureDepositDensity) return 1;
  return app.getTextureDepositDensity(x, y, p);
}

function _collectSimulationGuides(brush, p) {
  const app = brush.app;
  const sim = app.simulation;
  if (!sim?.enabled) return { points: [], pathTargets: [], edges: [], treadmillPoints: [] };
  const brushName = app._getSimulationContextBrush?.() || app.activeBrush;
  const data = app._getSimulationBrushData?.(brushName) || sim.brushData[brushName];
  if (!data) return { points: [], pathTargets: [], edges: [], treadmillPoints: [] };
  return {
    points: Array.isArray(data.points)
      ? data.points
          .filter(point => point.enabled !== false)
          .map(point => {
            const config = app._resolveSimulationPointConfig(point, p);
            return {
              x: point.x,
              y: point.y,
              type: point.type === 'repel' ? 'repel' : 'attract',
              strength: config.strength,
              radius: config.radius,
              influenceRadius: config.influenceRadius,
              hardness: config.hardness,
            };
          })
      : [],
    pathTargets: brushName === 'boid'
      ? (data.paths || [])
          .filter(pathItem => pathItem.enabled !== false && pathItem.points?.length >= 2)
          .map(pathItem => app._getAnimatedSimulationPathTarget(pathItem, p))
          .filter(Boolean)
          .map(target => ({
            x: target.x,
            y: target.y,
            strength: target.config.strength,
            radius: target.config.radius,
            influenceRadius: target.config.influenceRadius,
          }))
      : [],
    edges: brushName === 'ant'
      ? (data.edges || [])
          .filter(edge => edge.enabled !== false && edge.points?.length >= 2)
          .map(edge => {
            const config = app._resolveSimulationEdgeConfig(edge, p);
            return {
              points: edge.points,
              strength: config.strength,
              radius: config.radius,
            };
          })
      : [],
    // Treadmill Canvas submode: per-group weighted attractor guides. Always
    // CPU-applied (never uploaded to the GPU point-guide buffer) so each guide
    // point can be scoped to a group's agent index range via `groupRange` —
    // this isolates per-group routing from the global GPU guide path while
    // reusing the exact same attract/repel push math as normal guide points.
    treadmillPoints: (brushName === 'boid' && sim.mode === 'treadmillCanvas' && typeof app._collectTreadmillGuidePoints === 'function')
      ? app._collectTreadmillGuidePoints(brush, p)
      : [],
  };
}

function _pathInfluenceFalloff(distance, radius, influenceRadius) {
  const innerRadius = Math.max(1, radius || 0);
  const outerRadius = Math.max(innerRadius, influenceRadius || innerRadius);
  if (distance <= innerRadius) return 1;
  if (distance >= outerRadius) return 0;
  const innerSq = innerRadius * innerRadius;
  const outerSq = outerRadius * outerRadius;
  const distanceSq = Math.max(distance * distance, 1);
  const gravity = 1 / distanceSq;
  const innerGravity = 1 / innerSq;
  const outerGravity = 1 / outerSq;
  const denom = innerGravity - outerGravity;
  if (denom <= 1e-6) return 0;
  return Math.max(0, Math.min(1, (gravity - outerGravity) / denom));
}

function _syncSimulationGuidesToGpu(brush, guideState) {
  if (!brush.sim?.setSimulationGuides) return { points: false, pathTargets: false };
  return brush.sim.setSimulationGuides(guideState) ?? { points: false, pathTargets: false };
}

function _applySimulationGuides(brush, p, read, guideState = _collectSimulationGuides(brush, p), gpuSupport = {}) {
  const app = brush.app;
  const pointGuides = gpuSupport.points ? [] : (guideState.points || []);
  const animatedPathTargets = gpuSupport.pathTargets ? [] : (guideState.pathTargets || []);
  const edgeGuides = guideState.edges || [];
  const treadmillPoints = guideState.treadmillPoints || [];
  if (!pointGuides.length && !animatedPathTargets.length && !edgeGuides.length && !treadmillPoints.length) return false;
  const { buffer, count, stride } = read;
  const guideSpeedScale = Math.max(1, p.maxSpeed || 0);

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    let x = buffer[base + AGENT_X];
    let y = buffer[base + AGENT_Y];
    let vx = buffer[base + AGENT_VX];
    let vy = buffer[base + AGENT_VY];

    for (const point of pointGuides) {
      const dx = point.x - x;
      const dy = point.y - y;
      const d = Math.hypot(dx, dy);
      const sign = point.type === 'repel' ? -1 : 1;
      const outerRadius = sign < 0
        ? point.radius
        : Math.max(point.radius || 0, point.influenceRadius || point.radius || 0);
      if (d <= 0.0001 || d > outerRadius) continue;
      let shaped = 0;
      if (sign < 0) {
        const falloff = 1 - d / point.radius;
        // Repel points use a hardness-shaped falloff so users can make repulsion
        // either soft/wide or tight/punchy; attract points stay linear.
        shaped = Math.pow(falloff, Math.max(MIN_ALLOWED_SIM_HARDNESS, point.hardness));
      } else if (d <= point.radius) {
        shaped = 1 - d / point.radius;
      } else {
        shaped = _pathInfluenceFalloff(d, point.radius, outerRadius);
      }
      const push = point.strength * p.simSpeed * guideSpeedScale * shaped * 0.85 * sign;
      vx += (dx / d) * push;
      vy += (dy / d) * push;
    }

    // Treadmill Canvas routes continuously seek their fixed attractor like
    // a held pointer. A range-wide rebase below removes shared progress before
    // the flock arrives, producing the treadmill illusion without wrapping the
    // canvas or breaking the group's local boid relationships.
    for (const point of treadmillPoints) {
      if (point.treadmillFrame) continue;
      if (point.groupRange && (i < point.groupRange.start || i >= point.groupRange.end)) continue;
      const dx = point.x - x;
      const dy = point.y - y;
      const d = Math.hypot(dx, dy);
      if (d <= 0.0001) continue;
      const inwardX = dx / d;
      const inwardY = dy / d;
      const pursuitRadius = Math.max(1, point.radius || 1);
      const containmentRadius = Math.max(pursuitRadius, point.influenceRadius || pursuitRadius);
      const edgeFalloff = d <= pursuitRadius
        ? 1
        : Math.max(0.15, 1 - (d - pursuitRadius) / Math.max(1, containmentRadius - pursuitRadius));
      const pull = point.strength * p.simSpeed * guideSpeedScale * 0.85 * edgeFalloff;
      vx += inwardX * pull;
      vy += inwardY * pull;
    }

    if (animatedPathTargets.length) {
      let sumX = 0;
      let sumY = 0;
      for (const target of animatedPathTargets) {
        const dx = target.x - x;
        const dy = target.y - y;
        const d = Math.hypot(dx, dy);
        const influenceRadius = Math.max(target.radius || 0, target.influenceRadius || 0);
        if (d <= 0.0001 || d > influenceRadius) continue;
        const falloff = _pathInfluenceFalloff(d, target.radius, influenceRadius);
        const push = target.strength * p.simSpeed * guideSpeedScale * falloff;
        sumX += (dx / d) * push;
        sumY += (dy / d) * push;
      }
      vx += sumX;
      vy += sumY;
    }

    if ((app._getSimulationContextBrush?.() || app.activeBrush) === 'ant' && edgeGuides.length) {
      const prevX = x - vx;
      const prevY = y - vy;
      for (const edge of edgeGuides) {
        const pts = edge.points || [];
        for (let j = 1; j < pts.length; j++) {
          const a = pts[j - 1];
          const b = pts[j];
          const closest = _closestPointOnSegment(x, y, a.x, a.y, b.x, b.y);
          const dx = x - closest.x;
          const dy = y - closest.y;
          const dist = Math.hypot(dx, dy);
          if (edge.radius > 0 && dist < edge.radius && dist > 0.0001) {
            const away = (1 - dist / edge.radius) * edge.strength * p.simSpeed;
            vx += (dx / dist) * away;
            vy += (dy / dist) * away;
          }
          const prevSide = _signedDistanceToLine(prevX, prevY, a.x, a.y, b.x, b.y);
          const curSide = _signedDistanceToLine(x, y, a.x, a.y, b.x, b.y);
          if ((prevSide < 0 && curSide > 0) || (prevSide > 0 && curSide < 0)) {
            const nx = dy === 0 && dx === 0 ? 0 : dx / Math.max(dist, 1);
            const ny = dy === 0 && dx === 0 ? 0 : dy / Math.max(dist, 1);
            x = closest.x + nx * Math.max(edge.radius, 2);
            y = closest.y + ny * Math.max(edge.radius, 2);
            const dot = vx * nx + vy * ny;
            if (dot < 0) {
              vx -= 1.8 * dot * nx;
              vy -= 1.8 * dot * ny;
            }
          }
        }
      }
    }

    buffer[base + AGENT_X] = x;
    buffer[base + AGENT_Y] = y;
    buffer[base + AGENT_VX] = vx;
    buffer[base + AGENT_VY] = vy;
  }

  // Treadmill coordinate frame: rebase each routed group's entire range once
  // its centroid nears the fixed pointer. Every member is translated by the
  // same amount, so flock shape/velocity stays coherent while the visible
  // group keeps pursuing without ever arriving.
  for (const point of treadmillPoints) {
    if (point.treadmillFrame) continue;
    const start = Math.max(0, Math.floor(point.groupRange?.start ?? 0));
    const end = Math.min(count, Math.max(start, Math.floor(point.groupRange?.end ?? count)));
    if (start >= end) continue;
    const pursuitRadius = Math.max(1, point.radius || 1);
    const containmentRadius = Math.max(pursuitRadius, point.influenceRadius || pursuitRadius);
    const standoffRadius = Math.max(1, pursuitRadius * Math.max(0.05, Math.min(0.95, point.treadmillStandoffRatio ?? 0.65)));
    const rebaseStrength = Math.max(0.05, Math.min(1, point.treadmillRebaseStrength ?? 0.8));
    let centroidX = 0;
    let centroidY = 0;
    let avgVx = 0;
    let avgVy = 0;
    for (let i = start; i < end; i++) {
      const base = i * stride;
      centroidX += buffer[base + AGENT_X];
      centroidY += buffer[base + AGENT_Y];
      avgVx += buffer[base + AGENT_VX];
      avgVy += buffer[base + AGENT_VY];
    }
    const groupCount = end - start;
    centroidX /= groupCount;
    centroidY /= groupCount;
    avgVx /= groupCount;
    avgVy /= groupCount;
    const fromTargetX = centroidX - point.x;
    const fromTargetY = centroidY - point.y;
    const centroidDistance = Math.hypot(fromTargetX, fromTargetY);
    let outwardX = centroidDistance > 0.0001 ? fromTargetX / centroidDistance : -avgVx;
    let outwardY = centroidDistance > 0.0001 ? fromTargetY / centroidDistance : -avgVy;
    const outwardLength = Math.hypot(outwardX, outwardY);
    if (outwardLength <= 0.0001) {
      outwardX = 1;
      outwardY = 0;
    } else {
      outwardX /= outwardLength;
      outwardY /= outwardLength;
    }

    let translateX = 0;
    let translateY = 0;
    if (centroidDistance < standoffRadius) {
      const resetDistance = Math.max(0, pursuitRadius - centroidDistance) * rebaseStrength;
      translateX = outwardX * resetDistance;
      translateY = outwardY * resetDistance;
    }
    for (let i = start; i < end; i++) {
      const base = i * stride;
      let x = buffer[base + AGENT_X] + translateX;
      let y = buffer[base + AGENT_Y] + translateY;
      const deltaX = x - point.x;
      const deltaY = y - point.y;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance > containmentRadius) {
        const scale = containmentRadius / distance;
        x = point.x + deltaX * scale;
        y = point.y + deltaY * scale;
      }
      buffer[base + AGENT_X] = x;
      buffer[base + AGENT_Y] = y;
    }
  }
  return count > 0;
}

async function _createMotionSim(app, maxAgents = SHARED_MOTION_SIM_MAX_AGENTS, options = {}) {
  const width = app.W || 800;
  const height = app.H || 600;
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      return await WebGPUBoidSim.create(width, height, maxAgents, undefined, options);
    } catch (error) {
      console.warn('WebGPU boid sim unavailable — falling back to WASM.', error);
    }
  }
  return BoidSim.create(width, height, maxAgents);
}

async function _createSharedMotionSim(app) {
  return _createMotionSim(app, SHARED_MOTION_SIM_MAX_AGENTS);
}

async function _acquireSharedMotionSim(app) {
  if (app.sharedMotionSim) return app.sharedMotionSim;
  if (!app.sharedMotionSimPromise) {
    const epoch = app.sharedMotionSimEpoch ?? 0;
    const request = (async () => {
      try {
        const sim = await _createSharedMotionSim(app);
        if ((app.sharedMotionSimEpoch ?? 0) !== epoch) {
          sim?.destroy?.();
          return _acquireSharedMotionSim(app);
        }
        app.sharedMotionSim = sim;
        return sim;
      } catch (error) {
        if ((app.sharedMotionSimEpoch ?? 0) !== epoch) {
          return _acquireSharedMotionSim(app);
        }
        app.sharedMotionSim = null;
        throw error;
      } finally {
        if (app.sharedMotionSimPromise === request) {
          app.sharedMotionSimPromise = null;
        }
      }
    })();
    app.sharedMotionSimPromise = request;
  }
  return app.sharedMotionSimPromise;
}

export class BoidBrush {
  constructor(app) {
    this.app = app;
    this.sim = null;
    this._usingSharedSim = false;
    this.renderer = createBoidStampRenderer();
    this._ready = false;
    this._resetInterpolationState();
    this._treadmillDisplayHeadings = [];
    this._lastSpawnX = 0;
    this._lastSpawnY = 0;
    this._boidsSpawned = false;
    // Hover state — Apple Pencil hover preview
    this._hoverSpawned = false;
    // Flat-stroke (wet buffer) canvases
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._preStrokeCanvas = null;
    this._preStrokeCtx = null;
    this._flatActive = false;
    // Sensing state
    this._sensingFrame = 0;
    this._sensingUploaded = false;
    this._sensingSignature = '';
    this._sensingLum = null;
    // Trail blur offscreen canvases
    this._blurCanvas = null;
    this._blurCtx = null;
    this._blurTmpCanvas = null;
    this._blurTmpCtx = null;
    // Per-stroke accumulation canvas — cleared each onDown, so blur only affects
    // paint from the current stroke, not previously painted layers.
    this._blurStrokeCanvas = null;
    this._blurStrokeCtx = null;
    this._renderBackend = 'legacy';
    this._renderLegacyReason = 'compatibility check pending';
    this._gpuBatchVisibilityVerified = false;
    this._rendererChainPatched = false;
    this._gpuPreviewActive = false;
    this._gpuPreviewLayer = null;
    this._gpuPreviewRenderer = null;
    this._debugEvents = [];
    this._debugSeq = 0;
    this._debugMaxEvents = 120;
    // Treadmill Canvas submode support: runtime-only, never persisted.
    // Maps a spawn definition id -> the agent index range it produced this
    // stroke, so routes can scope guide points to one spawn group's agents.
    this._spawnRangesById = new Map();
    this._primarySpawnId = null;
    // Cached per-frame transient snapshot (centroid/bounds/avg velocity/
    // sampled candidates) consumed by camera policies without re-reading
    // the agent buffer. Populated from the same non-blocking readAgents()
    // call the stroke loop already performs.
    this._transientSnapshot = { count: 0 };
    _resetSimulationSpawnAppearance(this);
  }

  _patchRendererChain() {
    if (this._rendererChainPatched) return;
    this.renderer._getRendererChain = (renderState = {}) => {
      if (DISABLE_BOID_GPU_RENDERING_ON_APPLE_TOUCH_WEBKIT && !renderState.stampBitmap) {
        return [this.renderer.canvas];
      }
      const chain = [];
      if (renderState.stampBitmap) {
        if (this.renderer.webgl.ready) chain.push(this.renderer.webgl);
        chain.push(this.renderer.canvas);
      }
      if (this.renderer.webgpu.ready) chain.push(this.renderer.webgpu);
      if (this.renderer.webgl.ready) chain.push(this.renderer.webgl);
      chain.push(this.renderer.canvas);
      return chain;
    };
    this._rendererChainPatched = true;
  }

  async init({ force = false, useShared = true, gpuOptions = {} } = {}) {
    if (force) {
      this._clearGpuPreview();
      this._ready = false;
      this.sim = null;
      this._usingSharedSim = false;
      this.app.sharedMotionSimEpoch = (this.app.sharedMotionSimEpoch ?? 0) + 1;
      this.app.sharedMotionSim = null;
      this.app.sharedMotionSimPromise = null;
      this._resetInterpolationState();
      this._boidsSpawned = false;
      this._hoverSpawned = false;
      this.renderer.reset();
      this._renderBackend = 'legacy';
      this._renderLegacyReason = 'compatibility check pending';
      this._gpuBatchVisibilityVerified = false;
      this._rendererChainPatched = false;
      this._gpuPreviewRenderer = null;
      _resetSimulationSpawnAppearance(this);
    }
    if (useShared && this.app.sharedMotionSim) {
      this.sim = this.app.sharedMotionSim;
      this._usingSharedSim = true;
      this.sim.setDisplaySize?.(this.app.W, this.app.H);
      await this.renderer.init();
      this._patchRendererChain();
      this._syncRenderBackendStatus();
      this._ready = true;
      return this.sim;
    }
    await this.renderer.init();
    this._patchRendererChain();
    try {
      this.sim = useShared
        ? await _acquireSharedMotionSim(this.app)
        : await _createMotionSim(this.app, undefined, gpuOptions);
      this._usingSharedSim = !!useShared;
      if (useShared) this.app.sharedMotionSim = this.sim;
      this._syncRenderBackendStatus();
      this._ready = true;
    } catch (e) {
      console.error('BoidBrush: WASM init failed —', e);
    }
  }

  _syncRenderBackendStatus() {
    const p = this.app.getP?.();
    if (!p) return;
    const support = this._getBatchRendererSupport(p, this._flatActive);
    if (!support.ok) {
      this._setRenderBackend('legacy', support.reason || 'compatibility check pending');
      return;
    }
    this._setRenderBackend(this.renderer.getPreferredBatchRendererKind({ stampBitmap: p.stampImageCanvas || null }));
  }

  /** Capture canvas luminance and upload to WASM for pixel sensing */
  _uploadSensing(p) {
    const imgData = this.app.buildSensingData(p);
    const rgba = imgData.data;
    const w = imgData.width;
    const h = imgData.height;
    // Downsample to 1/4 resolution to reduce cost
    const dw = Math.max(1, w >> 2);
    const dh = Math.max(1, h >> 2);
    const lumLen = dw * dh;
    if (!this._sensingLum || this._sensingLum.length !== lumLen) {
      this._sensingLum = new Uint8Array(lumLen);
    }
    const lum = this._sensingLum;
    const channel = p.sensingChannel || 'darkness';
    const sx = w / dw;
    const sy = h / dh;
    for (let dy = 0; dy < dh; dy++) {
      const srcY = Math.min(Math.floor(dy * sy), h - 1);
      for (let dx = 0; dx < dw; dx++) {
        const srcX = Math.min(Math.floor(dx * sx), w - 1);
        const idx = (srcY * w + srcX) * 4;
        const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2], a = rgba[idx + 3];
        const alphaScale = a / 255;
        let v;
        if (channel === 'red') v = Math.round(r * alphaScale);
        else if (channel === 'green') v = Math.round(g * alphaScale);
        else if (channel === 'blue') v = Math.round(b * alphaScale);
        else if (channel === 'alpha') v = a;
        else if (channel === 'lightness') v = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * alphaScale);
        else if (channel === 'saturation') {
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          v = mx === 0 ? 0 : Math.round((((mx - mn) / mx) * 255) * alphaScale);
        }
        else /* 'darkness' */ v = Math.round((255 - Math.round(0.299 * r + 0.587 * g + 0.114 * b)) * alphaScale);
        lum[dy * dw + dx] = v;
      }
    }
    this.sim.uploadSensing(lum, dw, dh);
    this._sensingUploaded = true;
    this._sensingSignature = this._buildSensingSignature(p);
  }

  _buildSensingSignature(p) {
    return JSON.stringify({
      source: p.sensingSource || 'below',
      selectedSources: this.app.getSensingSourceSelectionSignature?.() || '[]',
      channel: p.sensingChannel || 'darkness',
      enabled: !!p.sensingEnabled,
      mode: p.sensingMode || 'avoid',
      strength: Number(p.sensingStrength || 0).toFixed(4),
      radius: Number(p.sensingRadius || 0).toFixed(2),
      fitRadius: Number(p.sensingFitRadius || 0).toFixed(2),
      threshold: Number(p.sensingThreshold || 0).toFixed(4),
      updateFrames: Math.max(1, Math.min(50, Math.round(p.sensingUpdateFrames || 30))),
    });
  }

  _hasAgents() {
    if (!this._ready || !this.sim) return false;
    return this.sim.readAgents().count > 0;
  }

  _clearAgents() {
    if (!this.sim) return;
    this.sim.clearAgents();
    _resetSimulationSpawnAppearance(this);
    this._clearGpuPreview({ composite: true });
    this._resetInterpolationState();
    this._boidsSpawned = false;
  }

  /**
   * When simulation mode is active, override brush-level params with any
   * scene-variable values stored in `simulation.vars`.
   * Returns `p` unchanged when simulation is not enabled.
   */
  _applySimVars(p) {
    const next = !this.app.simulation?.enabled
      ? Object.assign({}, p, { simBoundsMargin: -1 })
      : Object.assign({}, p);
    const vars = this.app._getSimulationVars?.() || this.app.simulation?.vars;
    if (this.app.simulation?.enabled && vars) {
      Object.assign(next, {
      seek: Number.isFinite(vars.seek) ? vars.seek : 0,
      simBoundsMargin: p.simBoundsMargin,
      });
      if (Number.isFinite(vars.cohesion)) next.cohesion = vars.cohesion;
      if (Number.isFinite(vars.separation)) next.separation = vars.separation;
      if (Number.isFinite(vars.alignment)) next.alignment = vars.alignment;
      if (Number.isFinite(vars.maxSpeed)) next.maxSpeed = vars.maxSpeed;
      if (Number.isFinite(vars.damping)) next.damping = vars.damping;
      if (typeof vars.sensingEnabled === 'boolean') next.sensingEnabled = vars.sensingEnabled;
      if (typeof vars.sensingMode === 'string') next.sensingMode = vars.sensingMode;
      if (typeof vars.sensingChannel === 'string') next.sensingChannel = vars.sensingChannel;
      if (Number.isFinite(vars.sensingStrength)) next.sensingStrength = vars.sensingStrength;
      if (Number.isFinite(vars.sensingRadius)) next.sensingRadius = vars.sensingRadius;
      if (Number.isFinite(vars.sensingFitRadius)) next.sensingFitRadius = vars.sensingFitRadius;
      if (Number.isFinite(vars.sensingThreshold)) next.sensingThreshold = vars.sensingThreshold;
      if (typeof vars.sensingSource === 'string') next.sensingSource = vars.sensingSource;
      if (Number.isFinite(vars.sensingUpdateFrames)) next.sensingUpdateFrames = vars.sensingUpdateFrames;
    }
    if (this.app.simulation?.mode === 'treadmillCanvas') {
      const group = this.app._getActiveTreadmillScenario?.()?.groups?.[0];
      if (group) {
        next.seek = group.seek;
        next.cohesion = group.cohesion;
        next.separation = group.separation;
        next.alignment = group.alignment;
        next.maxSpeed = group.maxSpeed;
        next.neighborRadius = group.neighborRadius;
        next.wander = group.wander;
        next.damping = group.damping;
      }
      // Treadmill simulation runs in virtual world coordinates, so document
      // bounds must not clamp agents back into the visible canvas.
      next.simBoundsMargin = -1;
    }
    // Treadmill Canvas applies group-scoped guides to the CPU mirror after
    // each simulation frame. WebGPU readback is asynchronous, so that mutation
    // would invalidate every pending position readback and freeze painted
    // stamps at their initial positions. Keep this specialized mode synchronous.
    next.forceCpuSimulation = this.app.simulation?.mode === 'treadmillCanvas';
    next.leader = _resolveLeaderParams(next);
    if (this.app.simulation?.mode === 'treadmillCanvas' && next.leader) {
      next.leader.simBoundsMargin = -1;
    }
    return next;
  }

  _spawnAgents(x, y, p, pressure = 1, useHoverAngle = false) {
    if (!this.sim) return false;
    let spawnAngle = p.spawnAngle;
    let r = p.spawnRadius;
    if (useHoverAngle) {
      const alt = this.app.altitude;
      const isPen = this.app.pointerType === 'pen';
      const hasTilt = isPen && alt < Math.PI / 2 - TILT_THRESHOLD;
      spawnAngle = hasTilt ? this.app.azimuth : p.spawnAngle;
      const tiltFactor = hasTilt ? (1 - alt / (Math.PI / 2)) : 0;
      r *= 1 + tiltFactor * 2;
    } else if (p.pressureSpawnRadius) {
      r *= 0.3 + 0.7 * pressure;
    }
    const spawnInfo = this.app._spawnSimulationAgents(this.sim, {
      count: p.count,
      shape: p.spawnShape,
      angle: spawnAngle,
      jitter: p.spawnJitter,
      radius: r,
      color: p.color,
      opacity: p.stampOpacity,
      mask: p.spawnMask || null,
      distribution: p.spawnDistribution || 'uniform',
      noiseScale: p.spawnNoiseScale || 1,
    }, x, y);
    this.sim.setLeaderRange?.(spawnInfo.startIndex, spawnInfo.endIndex, p.leader?.count ?? p.leaderConfig?.count ?? 0);
    _setSimulationSpawnAppearanceRange(this, spawnInfo, {
      color: p.color,
      opacity: p.stampOpacity,
    }, p);
    if (this._primarySpawnId != null) this._recordSimulationSpawnRange(this._primarySpawnId, spawnInfo);
    this._boidsSpawned = true;
    this._lastSpawnX = x;
    this._lastSpawnY = y;
    return true;
  }

  /** Treadmill Canvas submode: remember which agent index range a spawn
   *  definition produced this stroke, keyed by the spawn's own id. Routes
   *  use this to scope a weighted attractor's guide point to just the boids
   *  from its bound group instead of applying it globally. */
  _recordSimulationSpawnRange(spawnId, spawnInfo) {
    if (spawnId == null || !spawnInfo) return;
    this._spawnRangesById.set(spawnId, { startIndex: spawnInfo.startIndex, endIndex: spawnInfo.endIndex });
  }

  _applyLifecycleAction(action, p, x, y, pressure = 1, useHoverAngle = false) {
    if (action === 'cull') {
      this._clearAgents();
      return false;
    }
    const hasAgents = this._hasAgents();
    if (action === 'spawn' && !hasAgents) {
      return this._spawnAgents(x, y, p, pressure, useHoverAngle);
    }
    this._boidsSpawned = hasAgents;
    if (hasAgents && Number.isFinite(x) && Number.isFinite(y)) {
      this._lastSpawnX = x;
      this._lastSpawnY = y;
    }
    return hasAgents;
  }

  _canUseBatchRenderer(p, flat = this._flatActive) {
    return this._getBatchRendererSupport(p, flat).ok;
  }

  _getBatchRendererSupport(p, flat = this._flatActive) {
    const layer = this.app.getActiveLayer();
    if (!layer) return { ok: false, reason: 'no active layer' };
    if (layer.alphaLock && flat) return { ok: false, reason: 'alpha lock enabled with flat stroke' };
    if (p.trailBlur > 0) return { ok: false, reason: 'trail blur enabled' };
    if (p.trailFlow > 0) return { ok: false, reason: 'texture flow enabled' };
    if (p.smudge > 0) return { ok: false, reason: 'smudge enabled' };
    if (p.smudgeOnly) return { ok: false, reason: 'smudge only enabled' };
    if (p.kmMix && p.kmStrength > 0) return { ok: false, reason: 'pigment mix enabled' };
    if (p.impasto && p.impastoStrength > 0) return { ok: false, reason: 'impasto enabled' };
    if (!this.renderer.canRenderBatch({ stampBitmap: p.stampImageCanvas || null })) {
      return { ok: false, reason: this.renderer.getUnavailableReason({ stampBitmap: p.stampImageCanvas || null }) };
    }
    return { ok: true, reason: '' };
  }

  _setRenderBackend(kind, reason = '') {
    this._renderBackend = kind;
    this._renderLegacyReason = kind === 'legacy' ? reason : '';
    this._pushRenderDebug('set-render-backend', { kind, reason: this._renderLegacyReason || reason || '' });
  }

  _formatLegacyFallbackReason(reason) {
    const coreReason = reason || 'GPU boid-stamp renderer failed';
    return `${coreReason}; using CPU fallback`;
  }

  _pushRenderDebug(type, details = {}) {
    const entry = {
      seq: ++this._debugSeq,
      type,
      t: typeof performance !== 'undefined' && Number.isFinite(performance.now())
        ? Number(performance.now().toFixed(2))
        : Date.now(),
      ...details,
    };
    this._debugEvents.push(entry);
    if (this._debugEvents.length > this._debugMaxEvents) {
      this._debugEvents.splice(0, this._debugEvents.length - this._debugMaxEvents);
    }
    return entry;
  }

  getDebugState() {
    return {
      ready: this._ready,
      renderBackend: this._renderBackend,
      renderLegacyReason: this._renderLegacyReason,
      gpuPreviewActive: this._gpuPreviewActive,
      gpuPreviewLayer: this._gpuPreviewLayer ? { width: this._gpuPreviewLayer.canvas?.width || 0, height: this._gpuPreviewLayer.canvas?.height || 0 } : null,
      gpuPreviewRendererKind: this._gpuPreviewRenderer?.kind || null,
      events: this._debugEvents.slice(),
      webgpu: this.renderer?.webgpu?.getDebugState?.() || null,
    };
  }

  clearDebugState() {
    this._debugEvents = [];
    this._debugSeq = 0;
    this.renderer?.webgpu?.clearDebugState?.();
    return true;
  }

  _getGpuPreviewRenderer(p) {
    if (p?.stampImageCanvas) return null;
    if (this.renderer.webgpu?.ready) return this.renderer.webgpu;
    if (this.renderer.webgl?.ready) return this.renderer.webgl;
    return null;
  }

  _getGpuPreviewCanvas(renderer) {
    if (!renderer) return null;
    if (renderer.kind === 'webgpu') {
      // Keep boid preview visible even before preview-sync completes by using
      // the renderer canvas as a fallback source.
      return renderer.previewCanvas || renderer.canvas || null;
    }
    return renderer.previewCanvas || renderer.canvas || null;
  }

  _canUseGpuPreview(targetCtx, p) {
    const layer = this.app.getActiveLayer();
    if (!layer || !targetCtx || targetCtx !== layer.ctx) return false;
    if (this.app._hasActiveMultiSessionPlayback?.()) return false;
    if (DISABLE_BOID_GPU_RENDERING_ON_APPLE_TOUCH_WEBKIT) return false;
    if (this._flatActive) return false;
    if (this.app.simulation?.running && p?.simEphemeralMode) return false;
    if (!this._getGpuPreviewRenderer(p)) return false;
    if (p?.stampImageCanvas) return false;
    if (p?.sensingEnabled) return false;
    if ((p?.taperLength || 0) > 0 && !this.app.isDrawing && !this.app.simulation?.running) return false;
    if (layer.alphaLock) return false;
    if (layer.blend !== 'source-over') return false;
    if (Math.abs((layer.opacity ?? 1) - 1) > 1e-3) return false;
    return true;
  }

  _clearGpuPreview({ composite = false } = {}) {
    const layer = this._gpuPreviewLayer;
    const renderer = this._gpuPreviewRenderer;
    this._pushRenderDebug('clear-gpu-preview', {
      composite,
      rendererKind: renderer?.kind || null,
      hadPreviewLayer: !!layer,
    });
    const previewCanvas = this._getGpuPreviewCanvas(renderer);
    if (renderer) renderer.onPreviewUpdated = null;
    if (layer?.gpuPreviewCanvas && previewCanvas && layer.gpuPreviewCanvas === previewCanvas) {
      layer.gpuPreviewCanvas = null;
      layer.dirty = true;
    }
    if (renderer?.clearSurface && layer?.canvas?.width && layer?.canvas?.height) {
      renderer.clearSurface(layer.canvas.width, layer.canvas.height);
    }
    this._gpuPreviewActive = false;
    this._gpuPreviewLayer = null;
    this._gpuPreviewRenderer = null;
    if (composite && layer) this.app.compositeAllLayers();
  }

  _commitGpuPreviewToLayer() {
    const layer = this._gpuPreviewLayer;
    const renderer = this._gpuPreviewRenderer;
    if (!layer || !renderer?.ready) {
      this._pushRenderDebug('commit-gpu-preview-skipped', {
        hasLayer: !!layer,
        rendererKind: renderer?.kind || null,
        rendererReady: !!renderer?.ready,
      });
      this._clearGpuPreview();
      return false;
    }
    if (renderer.kind === 'webgpu' && !renderer._hasLivePreviewFrame) {
      // The preview sync is still in-flight (device.queue.onSubmittedWorkDone has
      // not resolved yet). Reading directly from the WebGPU swapchain canvas at
      // this point returns the previous frame's content (or blank on the first
      // stroke), so the immediate-commit path is omitted. Instead, defer the
      // commit to onPreviewUpdated, which fires once _syncPreviewCanvas has
      // confirmed the GPU work is done and captured the frame into previewCanvas.
      this._pushRenderDebug('commit-gpu-preview-deferred', {
        rendererKind: renderer.kind,
        previewSyncPending: !!renderer._previewSyncPending,
        previewSyncQueued: !!renderer._previewSyncQueued,
      });
      renderer.onPreviewUpdated = (canvas) => {
        if (!canvas) return;
        if (!this._gpuPreviewActive || this._gpuPreviewLayer !== layer || this._gpuPreviewRenderer !== renderer) return;
        this._pushRenderDebug('preview-updated', {
          rendererKind: renderer.kind,
          width: canvas.width,
          height: canvas.height,
          deferredCommit: true,
        });
        layer.gpuPreviewCanvas = canvas;
        const ok = renderer.copyTo2D(
          layer.ctx,
          layer.canvas.width,
          layer.canvas.height,
          layer.alphaLock ? 'source-atop' : 'source-over',
        );
        renderer.clearSurface?.(layer.canvas.width, layer.canvas.height);
        layer.gpuPreviewCanvas = null;
        this._gpuPreviewActive = false;
        this._gpuPreviewLayer = null;
        renderer.onPreviewUpdated = null;
        this._gpuPreviewRenderer = null;
        this._pushRenderDebug('commit-gpu-preview', {
          ok,
          rendererKind: renderer.kind,
          copiedFromLivePreview: true,
          deferred: true,
        });
        if (!ok) return;
        layer.dirty = true;
        this.app.compositeAllLayers();
      };
      return true;
    }
    const ok = renderer.copyTo2D(
      layer.ctx,
      layer.canvas.width,
      layer.canvas.height,
      layer.alphaLock ? 'source-atop' : 'source-over',
    );
    renderer.clearSurface?.(layer.canvas.width, layer.canvas.height);
    layer.gpuPreviewCanvas = null;
    this._gpuPreviewActive = false;
    this._gpuPreviewLayer = null;
    renderer.onPreviewUpdated = null;
    this._gpuPreviewRenderer = null;
    this._pushRenderDebug('commit-gpu-preview', {
      ok,
      rendererKind: renderer.kind,
      copiedFromLivePreview: renderer.kind === 'webgpu' ? !!renderer._hasLivePreviewFrame : true,
    });
    if (!ok) return false;
    layer.dirty = true;
    this.app.compositeAllLayers();
    return true;
  }

  _renderBatchToGpuPreview(batch, p) {
    const layer = this.app.getActiveLayer();
    const renderer = this._getGpuPreviewRenderer(p);
    if (!layer || !renderer?.ready) return false;
    const needsFreshSurface = !this._gpuPreviewActive || this._gpuPreviewLayer !== layer || this._gpuPreviewRenderer !== renderer;
    renderer.onPreviewUpdated = (canvas) => {
      if (!canvas) return;
      if (!this._gpuPreviewActive || this._gpuPreviewLayer !== layer || this._gpuPreviewRenderer !== renderer) return;
      this._pushRenderDebug('preview-updated', {
        rendererKind: renderer.kind,
        width: canvas.width,
        height: canvas.height,
      });
      layer.gpuPreviewCanvas = canvas;
      layer.dirty = true;
      this.app.compositeAllLayers();
    };
    if (this._gpuPreviewActive && this._gpuPreviewRenderer && this._gpuPreviewRenderer !== renderer) {
      this._commitGpuPreviewToLayer();
    }
    if (needsFreshSurface) {
      if (renderer.kind === 'webgpu') {
        renderer.invalidatePreview?.();
      } else if (!renderer.clearSurface?.(layer.canvas.width, layer.canvas.height)) {
        return false;
      }
      this._gpuPreviewActive = true;
      this._gpuPreviewLayer = layer;
      this._gpuPreviewRenderer = renderer;
      layer.gpuPreviewCanvas = this._getGpuPreviewCanvas(renderer);
    }
    this._pushRenderDebug('render-gpu-preview', {
      rendererKind: renderer.kind,
      count: batch.count,
      needsFreshSurface,
      hadLivePreviewFrame: renderer.kind === 'webgpu' ? !!renderer._hasLivePreviewFrame : true,
      layerWidth: layer.canvas.width,
      layerHeight: layer.canvas.height,
    });
    const stampBitmap = p?.stampImageCanvas || null;
    const ok = renderer.render({
      instances: batch.instances,
      count: batch.count,
      targetWidthPx: layer.canvas.width,
      targetHeightPx: layer.canvas.height,
      dpr: this.app.DPR,
      stampBitmap,
      stampTint: p?.stampImageTint !== false,
      stampRotation: p?.stampImageRotation || 0,
      stampAspect: stampBitmap?.width > 0 && stampBitmap?.height > 0 ? stampBitmap.width / stampBitmap.height : 1,
      copyToTarget: false,
      clear: needsFreshSurface,
    });
    if (!ok) {
      this._pushRenderDebug('render-gpu-preview-failed', {
        rendererKind: renderer.kind,
        reason: renderer.lastRenderFailureReason || '',
      });
      this._commitGpuPreviewToLayer();
      this._clearGpuPreview();
      return false;
    }
    layer.gpuPreviewCanvas = this._getGpuPreviewCanvas(renderer);
    layer.dirty = true;
    this._setRenderBackend(renderer.kind);
    return true;
  }

  _resetInterpolationState() {
    this._resetStampInterpolationAnchors();
    this._treadmillDisplayHeadings = [];
  }

  _resetStampInterpolationAnchors() {
    this._lastStampX = [];
    this._lastStampY = [];
    this._lastSpacingX = [];
    this._lastSpacingY = [];
  }

  _buildRenderBatch(read, p, {
    flat = this._flatActive,
    pressure = this.app.pressure,
    interpolate = true,
    applySkip = true,
    forceStamp = false,
    taperCurve = 1,
    taperSize = false,
    taperOpacity = false,
  } = {}) {
    const { buffer, count, stride } = read;
    const instances = new StampInstanceBuffer(Math.max(64, count));
    const skipActive = applySkip && this.app.strokeFrame <= (p.skipStamps || 0);
    const colorCache = new Map();
    const getAppearanceColor = color => {
      const key = _normalizeBrushHexColor(color, '#000000');
      let cached = colorCache.get(key);
      if (!cached) {
        cached = { hsl: hexToHSL(key), rgb: hexToRGB(key) };
        colorCache.set(key, cached);
      }
      return cached;
    };
    const textureEnabled = this.app.hasCanvasTexture?.() && p.canvasTextureEnabled;

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];
      const appearance = _getSimulationSpawnAppearance(this, i, p);
      const appearanceColor = getAppearanceColor(appearance.color);

      let size = p.stampSize * sm;
      let opacity = flat ? Math.min(om, 1) : appearance.opacity * om;
      if (!taperSize && p.pressureSize) size *= (0.3 + 0.7 * pressure);
      if (!flat && !taperOpacity && p.pressureOpacity) opacity *= (0.3 + 0.7 * pressure);
      if (taperSize) size *= taperCurve;
      if (taperOpacity) opacity *= taperCurve;
      opacity = Math.min(opacity, 1);
      if (opacity < 0.005 || size < 0.5) continue;

      const color = (agentHue !== 0 || agentSat !== 0 || agentLit !== 0)
        ? hslToRGB(appearanceColor.hsl[0] + agentHue, appearanceColor.hsl[1] + agentSat, appearanceColor.hsl[2] + agentLit)
        : appearanceColor.rgb;
      let rotation = p.stampImageRotation || 0;
      if (this.app.simulation?.mode === 'treadmillCanvas') {
        const group = this.app._getActiveTreadmillScenario?.()?.groups?.[0];
        const rawHeading = Math.atan2(buffer[base + AGENT_VY], buffer[base + AGENT_VX]);
        const priorHeading = this._treadmillDisplayHeadings[i];
        if (!Number.isFinite(priorHeading)) {
          this._treadmillDisplayHeadings[i] = rawHeading;
        } else {
          const delta = Math.atan2(Math.sin(rawHeading - priorHeading), Math.cos(rawHeading - priorHeading));
          this._treadmillDisplayHeadings[i] = priorHeading + delta * (1 - (group?.headingDamper ?? 0.7));
        }
        rotation += this._treadmillDisplayHeadings[i];
      }
      const pushInstance = (x, y) => {
        const renderPoints = p.symmetryEnabled
          ? this.app.getSymmetryPoints(x, y)
          : [{ x, y }];
        const seen = new Set();
        const emitInstance = (px, py, pointSize = size) => {
          const key = `${Math.round(px * 1000)}:${Math.round(py * 1000)}`;
          if (seen.has(key)) return;
          seen.add(key);
          let instOpacity = opacity;
          let instSize = pointSize;
          if (textureEnabled) {
            instOpacity *= _textureDepositDensity(this.app, p, px, py);
            const edgeBreakup = this.app.getTextureEdgeBreakup?.(px, py, p) || 0;
            if (edgeBreakup > 0) {
              const field = this.app.sampleTextureField?.(px, py, p);
              instSize *= Math.max(
                TEXTURE_EDGE_BREAKUP_MIN_SIZE,
                1 - edgeBreakup * TEXTURE_EDGE_BREAKUP_SIZE_SCALE + ((field?.valley ?? 0.5) - 0.5) * edgeBreakup * TEXTURE_EDGE_BREAKUP_VALLEY_SCALE,
              );
            }
          }
          if (instOpacity < 0.005 || instSize < 0.5) return;
          instances.push(px, py, instSize, color.r, color.g, color.b, instOpacity, rotation);
        };
        for (const point of renderPoints) {
          const pointSize = size * (point.sizeMultiplier || 1);
          emitInstance(point.x, point.y, pointSize);
          if (!this.app.tilingMode || !this.app._getStampWrapPoints) continue;
          const wraps = this.app._getStampWrapPoints(point.x, point.y, pointSize);
          for (const wrap of wraps) emitInstance(wrap.x, wrap.y, pointSize);
        }
      };

      if (skipActive) {
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        this._lastSpacingX[i] = ax;
        this._lastSpacingY[i] = ay;
        continue;
      }

      const prevStampX = this._lastSpacingX[i];
      const prevStampY = this._lastSpacingY[i];
      if (!interpolate || prevStampX === undefined || prevStampY === undefined) {
        pushInstance(ax, ay);
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        this._lastSpacingX[i] = ax;
        this._lastSpacingY[i] = ay;
        continue;
      }

      const dx = ax - prevStampX;
      const dy = ay - prevStampY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = p.stampSeparation > 0 ? p.stampSeparation : Math.max(1, size * 0.25);
      if (dist >= step) {
        // Match legacy interpolation behavior: accumulate distance from the last
        // emitted stamp, not from the last agent sample, so slow motion in
        // simulation mode still produces subsequent stamps once spacing is met.
        const emitCount = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= emitCount; j++) {
          const t = j / emitCount;
          pushInstance(prevStampX + dx * t, prevStampY + dy * t);
        }
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        this._lastSpacingX[i] = ax;
        this._lastSpacingY[i] = ay;
      } else if (forceStamp) {
        pushInstance(ax, ay);
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        // Keep the spacing anchor at the last spacing-qualified stamp so
        // sub-threshold motion can accumulate across frames into additional
        // emitted stamps instead of collapsing to exactly one stamp per agent.
      }
    }

    return {
      instances: instances.finish(),
      count: instances.count,
    };
  }

  _batchHasVisiblePixels(targetCtx, batch) {
    if (!targetCtx || !batch?.instances || batch.count <= 0) return false;
    const canvas = targetCtx.canvas;
    if (!canvas?.width || !canvas?.height) return false;
    const instances = batch.instances;
    const dpr = this.app.DPR || 1;
    const sampleCount = Math.min(batch.count, STAMP_VISIBILITY_SAMPLE_COUNT);
    const stride = 8;
    try {
      for (let i = 0; i < sampleCount; i++) {
        const base = i * stride;
        const size = Math.max(1, instances[base + 2] * dpr);
        const cx = Math.round(instances[base + 0] * dpr);
        const cy = Math.round(instances[base + 1] * dpr);
        const offsets = [
          [0, 0],
          [Math.min(size * 0.25, 2), 0],
          [-Math.min(size * 0.25, 2), 0],
          [0, Math.min(size * 0.25, 2)],
          [0, -Math.min(size * 0.25, 2)],
        ];
        for (const [ox, oy] of offsets) {
          const x = Math.max(0, Math.min(canvas.width - 1, Math.round(cx + ox)));
          const y = Math.max(0, Math.min(canvas.height - 1, Math.round(cy + oy)));
          if (targetCtx.getImageData(x, y, 1, 1).data[3] > 0) return true;
        }
      }
    } catch {
      return true;
    }
    return false;
  }

  _renderBatchToTarget(targetCtx, batch, p, { allowAlphaLock = false } = {}) {
    const stampBitmap = p?.stampImageCanvas || null;
    const layer = this.app.getActiveLayer();
    const previewAllowed = this._canUseGpuPreview(targetCtx, p);
    if (this._gpuPreviewActive && !previewAllowed) {
      this._commitGpuPreviewToLayer();
    }
    if (previewAllowed) {
      return this._renderBatchToGpuPreview(batch, p);
    }
    const ok = this.renderer.render({
      instances: batch.instances,
      count: batch.count,
      targetCtx,
      targetWidthPx: targetCtx?.canvas?.width || 0,
      targetHeightPx: targetCtx?.canvas?.height || 0,
      dpr: this.app.DPR,
      stampBitmap,
      stampTint: p?.stampImageTint !== false,
      stampRotation: p?.stampImageRotation || 0,
      stampAspect: stampBitmap?.width > 0 && stampBitmap?.height > 0 ? stampBitmap.width / stampBitmap.height : 1,
      compositeOperation: allowAlphaLock && layer?.alphaLock ? 'source-atop' : 'source-over',
    });
    this._setRenderBackend(ok ? this.renderer.activeKind : 'legacy', ok ? '' : this.renderer.legacyReason);
    if (ok && this.renderer.activeKind !== 'canvas' && !stampBitmap && !this._gpuBatchVisibilityVerified) {
      if (!this._batchHasVisiblePixels(targetCtx, batch)) {
        this._setRenderBackend('legacy', 'GPU batch copy produced no visible pixels');
        return false;
      }
      this._gpuBatchVisibilityVerified = true;
    }
    return ok;
  }

  _renderAgentsLegacy(targetCtx, read, p, pressure, {
    flat = this._flatActive,
    taperCurve = 1,
    taperSize = false,
    taperOpacity = false,
    reason = '',
  } = {}) {
    const { buffer, count, stride } = read;
    this._setRenderBackend('legacy', reason || this._renderLegacyReason || this.renderer.legacyReason);
    const colorCache = new Map();
    const getAppearanceColor = color => {
      const key = _normalizeBrushHexColor(color, '#000000');
      let cached = colorCache.get(key);
      if (!cached) {
        cached = { hsl: hexToHSL(key), color: key };
        colorCache.set(key, cached);
      }
      return cached;
    };
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];
      const appearance = _getSimulationSpawnAppearance(this, i, p);
      const appearanceColor = getAppearanceColor(appearance.color);
      let sz = p.stampSize * sm;
      let op = flat ? Math.min(om, 1) : appearance.opacity * om;
      if (!taperSize && p.pressureSize) sz *= (0.3 + 0.7 * pressure);
      if (!flat && !taperOpacity && p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
      if (taperSize) sz *= taperCurve;
      if (taperOpacity) op *= taperCurve;
      op = Math.min(op, 1);
      let color = appearanceColor.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = appearanceColor.hsl;
        color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
      }
      this.app.symStamp(targetCtx, ax, ay, sz, color, op);
      this._lastStampX[i] = ax;
      this._lastStampY[i] = ay;
    }
  }

  /** Hover: spawn boids once at hover position, then let onHoverFrame step
   *  the simulation so boids flock exactly as they do during drawing.
   *  Pen with tilt uses pencil azimuth for spawn angle; mouse uses UI angle. */
  onHover(x, y) {
    if (!this._ready) return;
    if (this._hoverSpawned) return; // hover state already entered — sim runs via onHoverFrame
    const p = this.app.getP();
    if (!this.app.simulation?.enabled) _resetSimulationSpawnAppearance(this);
    this._hoverSpawned = this._applyLifecycleAction(p.boidHoverAction, p, x, y, 1, true);
  }

  /** Clear hover preview when pointer leaves canvas */
  onHoverEnd() {
    if (!this._ready) return;
    const p = this.app.getP();
    this._applyLifecycleAction(p.boidUnhoverAction, p, this.app.leaderX, this.app.leaderY, 1, true);
    this._hoverSpawned = false;
  }

  /** Step the boid simulation during hover (no stamping).
   *  This lets boids settle into their flocking formation so the swarm
   *  shape is visible before the pencil touches down. */
  onHoverFrame(elapsed) {
    if (!this._ready || !this._hoverSpawned) return;
    const p = this._spawnOverrides ? { ...this.app.getP(), ...this._spawnOverrides } : this.app.getP();
    const guideState = _collectSimulationGuides(this, p);
    _syncSimulationGuidesToGpu(this, guideState);
    // Write params with the current hover leader position so boids follow
    this.sim.writeParams(this._applySimVars(p), this.app.leaderX, this.app.leaderY, elapsed);
    this.sim.step(1 / 60);
  }

  onDown(x, y, pressure) {
    if (!this._ready) return;
    const p = this.app.getP();
    if (!this.app.simulation?.enabled) _resetSimulationSpawnAppearance(this);
    // Fresh stroke — spawn index ranges from the previous stroke no longer apply.
    this._spawnRangesById.clear();
    this._pushRenderDebug('pointer-down', {
      x,
      y,
      pressure,
      flatStroke: !!p.flatStroke,
      taperLength: p.taperLength || 0,
    });
    if (this._gpuPreviewActive) this._clearGpuPreview({ composite: true });
    const selectedEntry = this.app._getSelectedSimulationEntry?.();
    const selectedSpawn = selectedEntry?.kind === 'spawn' ? selectedEntry.target : null;
    const simSpawns = this.app._ensureSimulationSpawns('boid');
    const forcedSimulationSpawn = this.app.simulation?.enabled
      && this.app.simulation?.mode === 'treadmillCanvas'
      && this._primarySpawnId != null
      ? simSpawns.find(spawn => String(spawn.id) === String(this._primarySpawnId))
      : null;
    const simSpawn = this.app.simulation?.enabled && this.app.activeBrush === 'boid'
      ? (forcedSimulationSpawn || (selectedSpawn && selectedSpawn.enabled !== false ? selectedSpawn : (simSpawns.find(spawn => spawn.enabled !== false) || simSpawns[0])))
      : null;
    this._primarySpawnId = simSpawn?.id ?? null;
    const spawnConfig = simSpawn ? this.app._resolveSimulationSpawnConfig(simSpawn, p) : null;
    const treadmillGroup = this.app.simulation?.mode === 'treadmillCanvas'
      ? this.app._getActiveTreadmillScenario?.()?.groups?.[0]
      : null;
    this._spawnOverrides = spawnConfig ? {
      count: treadmillGroup?.count ?? spawnConfig.count,
      color: spawnConfig.color,
      stampOpacity: spawnConfig.opacity,
      spawnShape: spawnConfig.shape,
      spawnAngle: spawnConfig.angle,
      spawnJitter: spawnConfig.jitter,
      spawnRadius: spawnConfig.radius,
      spawnMask: spawnConfig.mask,
      spawnDistribution: spawnConfig.distribution,
      spawnNoiseScale: spawnConfig.noiseScale,
      stampSize: spawnConfig.stampSize,
      stampSeparation: spawnConfig.stampSeparation,
      trailFlow: spawnConfig.trailFlow,
      smudge: spawnConfig.smudge,
      hueVar: spawnConfig.hueVar,
      satVar: spawnConfig.satVar,
      litVar: spawnConfig.litVar,
      sizeVar: spawnConfig.sizeVar,
      opacityVar: spawnConfig.opacityVar,
      speedVar: spawnConfig.speedVar,
    } : null;
    const strokeP = this._spawnOverrides ? { ...p, ...this._spawnOverrides } : p;

    this._applyLifecycleAction(p.boidTouchAction, strokeP, x, y, pressure, false);
    // Touch-down ends any prior hover preview; the stroke now owns agent motion.
    this._hoverSpawned = false;
    this._resetInterpolationState();
    this._lastSpawnX = x;
    this._lastSpawnY = y;
    this.app.strokeFrame = 0;
    this._sensingFrame = 0;
    this._sensingUploaded = false;
    this._sensingSignature = '';

    const simP = this._applySimVars(p);

    // Upload sensing data at stroke start if enabled
    if (simP.sensingEnabled) {
      this._uploadSensing(simP);
    }

    // Push undo on first stroke frame that actually stamps
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }

    // Flat-stroke setup: snapshot layer, prepare stroke canvas
    this._flatActive = !!p.flatStroke;
    if (this._flatActive) {
      const layer = this.app.getActiveLayer();
      const dpr = this.app.DPR;
      const w = layer.canvas.width, h = layer.canvas.height;
      if (!this._strokeCanvas || this._strokeCanvas.width !== w || this._strokeCanvas.height !== h) {
        this._strokeCanvas = document.createElement('canvas');
        this._strokeCanvas.width = w; this._strokeCanvas.height = h;
        this._strokeCtx = this._strokeCanvas.getContext('2d');
        this._preStrokeCanvas = document.createElement('canvas');
        this._preStrokeCanvas.width = w; this._preStrokeCanvas.height = h;
        this._preStrokeCtx = this._preStrokeCanvas.getContext('2d');
      }
      // Snapshot the current layer state (raw pixel copy, identity transform)
      this._preStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._preStrokeCtx.clearRect(0, 0, w, h);
      this._preStrokeCtx.drawImage(layer.canvas, 0, 0);
      // Clear stroke accumulator; apply DPR transform so stamps use CSS coords
      this._strokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._strokeCtx.clearRect(0, 0, w, h);
    }

    // Clear per-stroke blur accumulation canvas so the blur doesn't affect
    // paint deposited by previous strokes.
    if (this._blurStrokeCanvas) {
      const lw = this._blurStrokeCanvas.width, lh = this._blurStrokeCanvas.height;
      this._blurStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurStrokeCtx.clearRect(0, 0, lw, lh);
      // Restore DPR transform so subsequent arc() calls use CSS coordinates
      this._blurStrokeCtx.setTransform(this.app.DPR, 0, 0, this.app.DPR, 0, 0);
    }

    // Perform one initial simulation step and stamp agents immediately in
    // non-flat mode. Without this, paint only appears after the first onFrame()
    // call from requestAnimationFrame. On a quick tap (pointerdown + pointerup
    // faster than one frame), isDrawing goes false before onFrame runs and no
    // paint is ever deposited. In flat-stroke mode the composite path in onFrame
    // is required, so this initial stamp is omitted there.
    if (!this._flatActive) {
      const guideState = _collectSimulationGuides(this, p);
      const gpuGuideSupport = _syncSimulationGuidesToGpu(this, guideState);
      this.sim.writeParams(simP, x, y, 0);
      this.sim.step(1 / 60);
      const { buffer, count, stride } = this.sim.readAgents();
      if (_applySimulationGuides(this, p, { buffer, count, stride }, guideState, gpuGuideSupport)) {
        this.sim.markStateDirty?.();
      }
      if (this.app.simulation?.mode === 'treadmillCanvas') {
        this._updateTransientSnapshot({ buffer, count, stride });
        this._treadmillRead = { buffer, count, stride };
        return;
      }
      if (count > 0) {
        const layer = this.app.getActiveLayer();
        const batchSupport = this._getBatchRendererSupport(p, false);
        if (batchSupport.ok) {
          const batch = this._buildRenderBatch({ buffer, count, stride }, p, {
            flat: false,
            pressure,
            interpolate: false,
            applySkip: false,
          });
          if (!this._renderBatchToTarget(layer.ctx, batch, p, { allowAlphaLock: true })) {
            this._renderAgentsLegacy(layer.ctx, { buffer, count, stride }, p, pressure, {
              flat: false,
              reason: this.renderer.legacyReason,
            });
          }
        } else {
          this._renderAgentsLegacy(layer.ctx, { buffer, count, stride }, p, pressure, {
            flat: false,
            reason: batchSupport.reason,
          });
        }
        layer.dirty = true;
        this.app.compositeAllLayers();
      }
    }
  }

  onMove(x, y, pressure) {
    // No respawn-on-move: boids are spawned once (on hover or touch-down)
  }

  onUp(x, y) {
    this._pushRenderDebug('pointer-up', {
      x,
      y,
      flatStroke: this._flatActive,
      gpuPreviewActive: this._gpuPreviewActive,
      gpuPreviewRendererKind: this._gpuPreviewRenderer?.kind || null,
    });
    // Flush paint that was deposited by the initial onDown stamp or by the last
    // onFrame call. Covers the quick-tap case where isDrawing goes false before
    // the next RAF frame fires. Only runs in non-flat mode — flat stroke
    // compositing lives in onFrame and the taper handles the final flush.
    if (!this._flatActive) {
      if (!this._commitGpuPreviewToLayer()) {
        const layer = this.app.getActiveLayer();
        if (layer?.dirty) this.app.compositeAllLayers();
      }
    }
    const p = this.app.getP();
    this._applyLifecycleAction(p.boidUntouchAction, p, x, y, 1, false);
    this._hoverSpawned = false;
    this._spawnOverrides = null;
  }

  configureSimulation(data, p) {
    if (!this._ready || !data?.spawns?.length) return;
    const primary = data.spawns.find(spawn => spawn.enabled !== false) || data.spawns[0];
    for (const spawn of data.spawns) {
      if (spawn === primary || spawn.enabled === false) continue;
      const config = this.app._resolveSimulationSpawnConfig(spawn, p);
      const spawnInfo = this.app._spawnSimulationAgents(this.sim, config, spawn.x, spawn.y);
      this.sim.setLeaderRange?.(spawnInfo.startIndex, spawnInfo.endIndex, p.leader?.count ?? p.leaderConfig?.count ?? 0);
      _setSimulationSpawnAppearanceRange(this, spawnInfo, config, p);
      this._recordSimulationSpawnRange(spawn.id, spawnInfo);
    }
  }

  ensureSimulationSpawnAppearance(p = this.app.getP()) {
    if (!this._ready || !this.sim || !this.app.simulation?.enabled) return;
    _syncSimulationSpawnAppearance(this, this.app._ensureSimulationSpawns('boid'), spawn => this.app._resolveSimulationSpawnConfig(spawn, p), p);
  }

  refreshSimulationSpawnAppearance(p = this.app.getP()) {
    this.ensureSimulationSpawnAppearance(p);
  }

  _seedSpawnAppearanceForSavedPlayback(agentCount, p = this.app.getP()) {
    const spawns = this.app._ensureSimulationSpawns('boid').filter(spawn => spawn?.enabled !== false);
    if (!spawns.length || agentCount <= 0) {
      this._agentSpawnColors = [];
      this._agentSpawnOpacity = [];
      return;
    }
    const nextColors = [];
    const nextOpacity = [];
    let cursor = 0;
    for (const spawn of spawns) {
      const config = this.app._resolveSimulationSpawnConfig(spawn, p);
      const color = _normalizeBrushHexColor(config?.color, _normalizeBrushHexColor(p?.color, '#000000'));
      const opacity = Number.isFinite(config?.opacity)
        ? Math.max(0, Math.min(1, config.opacity))
        : (Number.isFinite(p?.stampOpacity) ? Math.max(0, Math.min(1, p.stampOpacity)) : 1);
      const expectedCount = Math.max(0, Math.round(config?.count || 0));
      for (let offset = 0; offset < expectedCount && cursor < agentCount; offset++, cursor++) {
        nextColors[cursor] = color;
        nextOpacity[cursor] = opacity;
      }
      if (cursor >= agentCount) break;
    }
    if (cursor < agentCount) {
      const fallback = this.app._resolveSimulationSpawnConfig(spawns[0], p);
      const color = _normalizeBrushHexColor(fallback?.color, _normalizeBrushHexColor(p?.color, '#000000'));
      const opacity = Number.isFinite(fallback?.opacity)
        ? Math.max(0, Math.min(1, fallback.opacity))
        : (Number.isFinite(p?.stampOpacity) ? Math.max(0, Math.min(1, p.stampOpacity)) : 1);
      for (; cursor < agentCount; cursor++) {
        nextColors[cursor] = color;
        nextOpacity[cursor] = opacity;
      }
    }
    this._agentSpawnColors = nextColors;
    this._agentSpawnOpacity = nextOpacity;
  }

  prepareSavedPlayback(savedPlayback, p = this.app.getP()) {
    this.resetSimulationPlaybackState({ compositePreview: false });
    this._flatActive = false;
    this._spawnOverrides = null;
    this._seedSpawnAppearanceForSavedPlayback(savedPlayback?.agentCount || 0, p);
  }

  captureSavedPlaybackFrame() {
    if (!this._ready || !this.sim) return null;
    const { buffer, count, stride } = this.sim.readAgents();
    if (!count) return null;
    const positions = new Array(count * 2);
    const appearance = new Array(count * 5);
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const posBase = i * 2;
      const appearanceBase = i * 5;
      positions[posBase] = buffer[base + 0];
      positions[posBase + 1] = buffer[base + 1];
      appearance[appearanceBase] = buffer[base + 8];
      appearance[appearanceBase + 1] = buffer[base + 9];
      appearance[appearanceBase + 2] = buffer[base + 20];
      appearance[appearanceBase + 3] = buffer[base + 21];
      appearance[appearanceBase + 4] = buffer[base + 22];
    }
    return { count, positions, appearance };
  }

  _buildAgentBufferFromSavedFrame(savedPlayback, frameIndex) {
    const frame = savedPlayback?.frames?.[frameIndex];
    const agentCount = Math.max(0, Math.round(savedPlayback?.agentCount || 0));
    if (!frame?.positions?.length || !savedPlayback?.appearance?.length || agentCount <= 0) return null;
    const stride = 23;
    const size = agentCount * stride;
    if (!this._savedPlaybackReadBuffer || this._savedPlaybackReadBuffer.length !== size) {
      this._savedPlaybackReadBuffer = new Float32Array(size);
    } else {
      this._savedPlaybackReadBuffer.fill(0);
    }
    const buffer = this._savedPlaybackReadBuffer;
    for (let i = 0; i < agentCount; i++) {
      const base = i * stride;
      const posBase = i * 2;
      const appearanceBase = i * 5;
      buffer[base + 0] = frame.positions[posBase];
      buffer[base + 1] = frame.positions[posBase + 1];
      buffer[base + 8] = savedPlayback.appearance[appearanceBase];
      buffer[base + 9] = savedPlayback.appearance[appearanceBase + 1];
      buffer[base + 20] = savedPlayback.appearance[appearanceBase + 2];
      buffer[base + 21] = savedPlayback.appearance[appearanceBase + 3];
      buffer[base + 22] = savedPlayback.appearance[appearanceBase + 4];
    }
    return { buffer, count: agentCount, stride };
  }

  _renderAgentRead(read, p, { forceStamp = false } = {}) {
    const { buffer, count, stride } = read;
    if (count === 0) return;
    const app = this.app;
    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;
    const skipN = p.skipStamps || 0;
    app.strokeFrame++;
    const batchSupport = this._getBatchRendererSupport(p, flat);
    if (batchSupport.ok) {
      const batch = this._buildRenderBatch(read, p, {
        flat,
        pressure: app.pressure,
        interpolate: true,
        applySkip: skipN > 0,
        forceStamp,
      });
      if (batch.count === 0) {
        this._setRenderBackend(this.renderer.getPreferredBatchRendererKind({ stampBitmap: p.stampImageCanvas || null }));
        return;
      }
      if (this._renderBatchToTarget(stampCtx, batch, p, { allowAlphaLock: !flat })) {
        if (flat) {
          const w = layer.canvas.width, h = layer.canvas.height;
          const ctx = layer.ctx;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(this._preStrokeCanvas, 0, 0);
          let masterOp = p.stampOpacity;
          if (p.pressureOpacity) masterOp *= (0.3 + 0.7 * app.pressure);
          ctx.globalAlpha = Math.min(masterOp, 1);
          ctx.drawImage(this._strokeCanvas, 0, 0);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
        layer.dirty = true;
        app.compositeAllLayers();
        return;
      }
    }
    this._setRenderBackend('legacy', batchSupport.ok ? (this.renderer.legacyReason || this._renderLegacyReason) : batchSupport.reason);
    const colorCache = new Map();
    const getAppearanceColor = color => {
      const key = _normalizeBrushHexColor(color, '#000000');
      let cached = colorCache.get(key);
      if (!cached) {
        cached = { hsl: hexToHSL(key), color: key };
        colorCache.set(key, cached);
      }
      return cached;
    };

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];
      const appearance = _getSimulationSpawnAppearance(this, i, p);
      const appearanceColor = getAppearanceColor(appearance.color);

      if (app.strokeFrame <= skipN) {
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        this._lastSpacingX[i] = ax;
        this._lastSpacingY[i] = ay;
        continue;
      }

      let sz = p.stampSize * sm;
      let op = flat ? Math.min(om, 1) : appearance.opacity * om;
      if (p.pressureSize) sz *= (0.3 + 0.7 * app.pressure);
      if (!flat && p.pressureOpacity) op *= (0.3 + 0.7 * app.pressure);
      op = Math.min(op, 1);

      let color = appearanceColor.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = appearanceColor.hsl;
        color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
      }

      const step = p.stampSeparation > 0
        ? p.stampSeparation
        : Math.max(1, sz * 0.25);
      const prevX = this._lastSpacingX[i];
      const prevY = this._lastSpacingY[i];

      let advanceAnchor = true;
      if (prevX !== undefined) {
        const dx = ax - prevX;
        const dy = ay - prevY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < step) {
          if (!forceStamp && !app.isDrawing && !app.simulation?.running) continue;
          app.symStamp(stampCtx, ax, ay, sz, color, op);
          if (p.trailBlur > 0 && !flat && this._blurStrokeCtx) {
            _stampToBlurAccum(this._blurStrokeCtx, app, ax, ay, sz, color, op);
          }
          this._lastStampX[i] = ax;
          this._lastStampY[i] = ay;
          advanceAnchor = false;
          continue;
        }

        const n = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= n; j++) {
          const t = j / n;
          app.symStamp(stampCtx, prevX + dx * t, prevY + dy * t, sz, color, op);
          if (p.trailBlur > 0 && !flat && this._blurStrokeCtx) {
            _stampToBlurAccum(this._blurStrokeCtx, app, prevX + dx * t, prevY + dy * t, sz, color, op);
          }
        }
      } else {
        app.symStamp(stampCtx, ax, ay, sz, color, op);
        if (p.trailBlur > 0 && !flat && this._blurStrokeCtx) {
          _stampToBlurAccum(this._blurStrokeCtx, app, ax, ay, sz, color, op);
        }
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
      }

      if (advanceAnchor) {
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        this._lastSpacingX[i] = ax;
        this._lastSpacingY[i] = ay;
      }
    }

    if (flat) {
      const w = layer.canvas.width, h = layer.canvas.height;
      const ctx = layer.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._preStrokeCanvas, 0, 0);
      let masterOp = p.stampOpacity;
      if (p.pressureOpacity) masterOp *= (0.3 + 0.7 * app.pressure);
      ctx.globalAlpha = Math.min(masterOp, 1);
      ctx.drawImage(this._strokeCanvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    if (p.trailBlur > 0 && !flat) {
      const lw = layer.canvas.width, lh = layer.canvas.height;
      if (!this._blurCanvas || this._blurCanvas.width !== lw || this._blurCanvas.height !== lh) {
        this._blurCanvas = document.createElement('canvas');
        this._blurCanvas.width = lw;
        this._blurCanvas.height = lh;
        this._blurCtx = this._blurCanvas.getContext('2d');
        this._blurTmpCanvas = document.createElement('canvas');
        this._blurTmpCanvas.width = lw;
        this._blurTmpCanvas.height = lh;
        this._blurTmpCtx = this._blurTmpCanvas.getContext('2d');
      }
      if (!this._blurStrokeCanvas || this._blurStrokeCanvas.width !== lw || this._blurStrokeCanvas.height !== lh) {
        this._blurStrokeCanvas = document.createElement('canvas');
        this._blurStrokeCanvas.width = lw;
        this._blurStrokeCanvas.height = lh;
        this._blurStrokeCtx = this._blurStrokeCanvas.getContext('2d');
        this._blurStrokeCtx.setTransform(app.DPR, 0, 0, app.DPR, 0, 0);
      }
      this._blurCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurCtx.clearRect(0, 0, lw, lh);
      this._blurCtx.drawImage(this._blurStrokeCanvas, 0, 0);
      if (p.trailFlow > 0 && p.canvasTextureEnabled) {
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p);
      }
      this._blurTmpCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurTmpCtx.clearRect(0, 0, lw, lh);
      this._blurTmpCtx.filter = `blur(${p.trailBlur * app.DPR}px)`;
      this._blurTmpCtx.drawImage(this._blurCanvas, 0, 0);
      this._blurTmpCtx.filter = 'none';
      layer.ctx.save();
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.globalAlpha = 0.18;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.drawImage(this._blurTmpCanvas, 0, 0);
      layer.ctx.globalAlpha = 1;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.restore();
    }

    layer.dirty = true;
    app.compositeAllLayers();
  }

  renderSavedPlaybackFrame(savedPlayback, frameIndex, p = this.app.getP()) {
    const read = this._buildAgentBufferFromSavedFrame(savedPlayback, frameIndex);
    if (!read) return;
    this._renderAgentRead(read, p, { forceStamp: true });
  }

  onFrame(elapsed) {
    if (!this._ready) return;
    const p = this._spawnOverrides ? { ...this.app.getP(), ...this._spawnOverrides } : this.app.getP();
    const simP = this._applySimVars(p);
    const app = this.app;

    if (simP.sensingEnabled) {
      const sensingSourceIsBelow = simP.sensingSource === 'below';
      const sensingUpdateFrames = Math.max(1, Math.min(50, Math.round(simP.sensingUpdateFrames || 30)));
      const sensingSignature = this._buildSensingSignature(simP);
      if (!this._sensingUploaded || this._sensingSignature !== sensingSignature) {
        this._uploadSensing(simP);
        this._sensingFrame = 0;
      } else if (!sensingSourceIsBelow) {
        // "Below" excludes the active stroke layer, so it stays unchanged during
        // the stroke and doesn't need the periodic refresh used by active/all.
        this._sensingFrame++;
        if (this._sensingFrame >= sensingUpdateFrames) {
          this._uploadSensing(simP);
          this._sensingFrame = 0;
        }
      }
    } else {
      this._sensingUploaded = false;
      this._sensingSignature = '';
    }

    // Write sim params and step
    const guideState = _collectSimulationGuides(this, p);
    const gpuGuideSupport = _syncSimulationGuidesToGpu(this, guideState);
    const treadmillTarget = guideState.treadmillPoints?.find(point => point.treadmillFrame);
    this.sim.writeParams(simP, treadmillTarget?.x ?? app.leaderX, treadmillTarget?.y ?? app.leaderY, elapsed);
    this.sim.step(1 / 60);

    // Read agents. readAgents() itself is non-blocking: on WebGPU it returns
    // the latest CPU mirror already updated by an async mapAsync() readback
    // (see webgpu-boid-sim.js _applyReadyResults), so caching a transient
    // snapshot from it here never stalls the frame loop.
    const read = this.sim.readAgents();
    if (_applySimulationGuides(this, p, read, guideState, gpuGuideSupport)) this.sim.markStateDirty?.();
    if (app.simulation?.mode === 'treadmillCanvas') {
      const display = app.simulation?.treadmill?.display;
      this._updateTransientSnapshot(read);
      this._treadmillRead = read;
      if (display?.showPresentationLayer) {
        this._renderTreadmillPresentationLayer(p);
      } else {
        this._suspendTreadmillPresentationLayer();
      }
      if (display?.showCanvasLayer === false) {
        this._resetStampInterpolationAnchors();
        return;
      }
      const projectedRead = this._buildProjectedTreadmillRead(read);
      this._renderAgentRead(projectedRead, p, {
        forceStamp: !!app.isDrawing || !!app.simulation?.running,
      });
      return;
    }
    this._renderAgentRead(read, p, {
      forceStamp: !!app.isDrawing || !!app.simulation?.running,
    });
  }

  /** Treadmill Canvas submode: cache centroid/bounds/average velocity and
   *  a sampled set of agent candidates from the current agent read. Camera
   *  policies (followBoid/followCentroid/frameGroups/orbit) consume this
   *  cached snapshot instead of re-scanning the agent buffer themselves. */
  _updateTransientSnapshot(read) {
    const { buffer, count, stride } = read || {};
    if (!count) {
      this._transientSnapshot = { count: 0 };
      return;
    }
    let sumX = 0, sumY = 0, sumVX = 0, sumVY = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const candidates = [];
    const sampleStride = Math.max(1, Math.floor(count / TREADMILL_MAX_CANDIDATES));
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const x = buffer[base + AGENT_X];
      const y = buffer[base + AGENT_Y];
      const vx = buffer[base + AGENT_VX];
      const vy = buffer[base + AGENT_VY];
      sumX += x; sumY += y; sumVX += vx; sumVY += vy;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (i % sampleStride === 0) candidates.push({ x, y, vx, vy, index: i });
    }
    this._transientSnapshot = {
      count,
      centroid: { x: sumX / count, y: sumY / count },
      avgVelocity: { x: sumVX / count, y: sumVY / count },
      bounds: { minX, minY, maxX, maxY },
      candidates,
      updatedAt: performance.now(),
    };
  }

  _buildProjectedTreadmillRead(read) {
    const { buffer, count, stride } = read || {};
    if (!buffer || !count || !stride) return read;
    const needed = count * stride;
    if (!this._treadmillProjectedReadBuffer || this._treadmillProjectedReadBuffer.length !== needed) {
      this._treadmillProjectedReadBuffer = new Float32Array(needed);
    }
    const projectedBuffer = this._treadmillProjectedReadBuffer;
    projectedBuffer.set(buffer.subarray(0, needed));
    for (let index = 0; index < count; index++) {
      const base = index * stride;
      const projected = this.app._projectTreadmillWorldPoint(
        buffer[base + AGENT_X],
        buffer[base + AGENT_Y],
      );
      if (!projected) {
        projectedBuffer[base + AGENT_OPACITY] = 0;
        continue;
      }
      projectedBuffer[base + AGENT_X] = projected.canvasX;
      projectedBuffer[base + AGENT_Y] = projected.canvasY;
    }
    return { buffer: projectedBuffer, count, stride };
  }

  _suspendTreadmillPresentationLayer() {
    const layer = this.app._getLayerById?.(this.app._treadmillPresentationLayerId);
    if (!layer || layer.visible === false) return;
    layer.visible = false;
    layer.dirty = true;
    layer.dirtyTiles = null;
  }

  taperFrame(t, p) {
    if (!this._ready) return;
    const app = this.app;
    const curve = Math.pow(1 - t, p.taperCurve);

    // Freeze agent positions — do NOT step the simulation during taper.
    // Advancing the sim causes boids to drift from the stroke endpoint and
    // stamp at wrong locations with full size/opacity, which is the reported
    // "large and opaque stamps" bug. Keeping positions frozen lets the taper
    // fade them out cleanly in place.
    const { buffer, count, stride } = this.sim.readAgents();
    if (count === 0) return;

    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;
    const batchSupport = this._getBatchRendererSupport(p, flat);
    if (batchSupport.ok) {
      const batch = this._buildRenderBatch({ buffer, count, stride }, p, {
        flat,
        interpolate: false,  // stamp directly at frozen positions, no gap-fill
        applySkip: false,
        taperCurve: curve,
        taperSize: p.taperSize,
        taperOpacity: p.taperOpacity,
      });
      if (batch.count === 0) {
        this._setRenderBackend(this.renderer.getPreferredBatchRendererKind({ stampBitmap: p.stampImageCanvas || null }));
        return;
      }
      if (!this._renderBatchToTarget(stampCtx, batch, p, { allowAlphaLock: !flat })) {
        this._renderAgentsLegacy(stampCtx, { buffer, count, stride }, p, app.pressure, {
          flat,
          taperCurve: curve,
          taperSize: p.taperSize,
          taperOpacity: p.taperOpacity,
          reason: this.renderer.legacyReason,
        });
      }
      if (flat) {
        const w = layer.canvas.width, h = layer.canvas.height;
        const ctx = layer.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(this._preStrokeCanvas, 0, 0);
        let masterOp = p.stampOpacity;
        if (p.taperOpacity) masterOp *= curve;
        ctx.globalAlpha = Math.min(masterOp, 1);
        ctx.drawImage(this._strokeCanvas, 0, 0);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      layer.dirty = true;
      app.compositeAllLayers();
      return;
    }
    this._setRenderBackend('legacy', batchSupport.reason);
    const colorCache = new Map();
    const getAppearanceColor = color => {
      const key = _normalizeBrushHexColor(color, '#000000');
      let cached = colorCache.get(key);
      if (!cached) {
        cached = { hsl: hexToHSL(key), color: key };
        colorCache.set(key, cached);
      }
      return cached;
    };

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];
      const appearance = _getSimulationSpawnAppearance(this, i, p);
      const appearanceColor = getAppearanceColor(appearance.color);

      let sz = p.stampSize * sm;
      let op = flat ? Math.min(om, 1) : appearance.opacity * om;
      if (p.taperSize) sz *= curve;
      if (p.taperOpacity) op *= curve;
      op = Math.min(op, 1);
      if (op < 0.005 || sz < 0.5) continue;

      let color = appearanceColor.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = appearanceColor.hsl;
        color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
      }

      // Stamp directly at frozen position (skip distance interpolation to
      // avoid accumulating paint when boids are stationary).
      app.symStamp(stampCtx, ax, ay, sz, color, op);
    }

    if (flat) {
      const w = layer.canvas.width, h = layer.canvas.height;
      const ctx = layer.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._preStrokeCanvas, 0, 0);
      let masterOp = p.stampOpacity;
      if (p.taperOpacity) masterOp *= curve;
      ctx.globalAlpha = Math.min(masterOp, 1);
      ctx.drawImage(this._strokeCanvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    layer.dirty = true;
    app.compositeAllLayers();
  }

  drawOverlay(ctx, p) {
    if (!this._ready) return;
    if (this.app.simulation?.mode === 'treadmillCanvas' && (this.app.simulation?.running || this.app.simulation?.paused)) {
      this._drawTreadmillTargetOverlay(ctx);
      return;
    }
    const { buffer, count, stride } = this.sim.readAgents();
    const groupIds = _computeBoidOverlayGroups(buffer, count, stride, p);

    // Show hover-spawned boids even when showBoids is off (lighter colour)
    if (this._hoverSpawned) {
      for (let i = 0; i < count; i++) {
        const base = i * stride;
        ctx.fillStyle = _getBoidGroupCursorColor(groupIds[i], 0.35);
        ctx.fillRect(buffer[base] - 1, buffer[base + 1] - 1, 2, 2);
      }
      // Draw spawn area ring during hover
      ctx.strokeStyle = 'rgba(100,180,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const alt = this.app.altitude;
      const isPen = this.app.pointerType === 'pen';
      const hasTilt = isPen && alt < Math.PI / 2 - TILT_THRESHOLD;
      const tiltFactor = hasTilt ? (1 - alt / (Math.PI / 2)) : 0;
      const r = p.spawnRadius * (1 + tiltFactor * 2);
      ctx.arc(this.app.leaderX, this.app.leaderY, r, 0, Math.PI * 2);
      ctx.stroke();
      return; // hover preview only — skip normal overlay
    }

    if (!p.showBoids) return;
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      ctx.fillStyle = _getBoidGroupCursorColor(groupIds[i], 0.6);
      ctx.fillRect(buffer[base] - 1, buffer[base + 1] - 1, 2, 2);
    }

    // Draw spawn area indicator
    const simSpawn = this.app.simulation?.enabled && this.app.activeBrush === 'boid'
      ? (this.app._ensureSimulationSpawns('boid').find(spawn => spawn.enabled !== false) || this.app._ensureSimulationSpawns('boid')[0])
      : null;
    if (p.showSpawn && (this.app.isDrawing || simSpawn)) {
      const config = simSpawn ? this.app._resolveSimulationSpawnConfig(simSpawn, p) : null;
      const sx = simSpawn?.x ?? this.app.leaderX;
      const sy = simSpawn?.y ?? this.app.leaderY;
      ctx.strokeStyle = 'rgba(100,180,255,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, config?.radius ?? p.spawnRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawTreadmillTargetOverlay(ctx) {
    const runtime = this.app._treadmillRuntime;
    if (!runtime) return;
    const projected = this.app._projectTreadmillWorldPoint(runtime.targetX, runtime.targetY);
    if (!projected) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 242, 168, 0.96)';
    ctx.fillStyle = 'rgba(255, 226, 96, 0.25)';
    ctx.lineWidth = 2 / Math.max(0.1, this.app.viewZoom);
    ctx.beginPath();
    ctx.arc(projected.canvasX, projected.canvasY, 11 / Math.max(0.1, this.app.viewZoom), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _renderTreadmillPresentationLayer(p) {
    const layer = this.app._ensureTreadmillPresentationLayer?.();
    if (!layer?.ctx) return;
    layer.visible = true;
    const ctx = layer.ctx;
    ctx.save();
    ctx.setTransform(this.app.DPR, 0, 0, this.app.DPR, 0, 0);
    ctx.clearRect(0, 0, this.app.W, this.app.H);
    this._drawTreadmillPresentation(ctx, p);
    ctx.restore();
    layer.dirty = true;
    layer.dirtyTiles = null;
    this.app.compositeAllLayers();
  }

  _drawTreadmillPresentation(ctx, p) {
    const read = this._treadmillRead;
    if (!read?.count) return;
    const { buffer, count, stride } = read;
    const app = this.app;
    const runtime = app._treadmillRuntime;
    const radius = Math.max(3, Math.min(28, p.stampSize * 0.5));
    const viewport = document.getElementById('canvasArea')?.getBoundingClientRect();
    const viewportWidth = viewport?.width || app.W;
    const viewportHeight = viewport?.height || app.H;
    const group = app._getActiveTreadmillScenario?.()?.groups?.[0];
    const headingFollow = 1 - (group?.headingDamper ?? 0.7);
    const headings = this._treadmillDisplayHeadings || [];

    ctx.save();
    for (let index = 0; index < count; index++) {
      const base = index * stride;
      const projected = app._projectTreadmillWorldPoint(buffer[base + AGENT_X], buffer[base + AGENT_Y]);
      if (!projected || projected.screenX < -radius || projected.screenY < -radius || projected.screenX > viewportWidth + radius || projected.screenY > viewportHeight + radius) continue;
      const rawHeading = Math.atan2(buffer[base + AGENT_VY], buffer[base + AGENT_VX]);
      const previous = headings[index];
      const heading = Number.isFinite(previous)
        ? previous + Math.atan2(Math.sin(rawHeading - previous), Math.cos(rawHeading - previous)) * headingFollow
        : rawHeading;
      headings[index] = heading;
      const appearance = _getSimulationSpawnAppearance(this, index, p);
      ctx.save();
      ctx.translate(projected.canvasX, projected.canvasY);
      ctx.rotate(heading);
      ctx.fillStyle = _getVisibleTreadmillStampColor(app, appearance.color);
      ctx.globalAlpha = Math.max(0.48, Math.min(1, appearance.opacity * (buffer[base + 9] || 1)));
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      ctx.moveTo(radius * 0.95, 0);
      ctx.lineTo(radius * 0.2, radius * 0.28);
      ctx.lineTo(radius * 0.2, -radius * 0.28);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  getStatusInfo() {
    if (!this._ready) return 'WASM loading...';
    const { count } = this.sim.readAgents();
    const legacyReason = this._renderBackend === 'legacy'
      ? (this._getBatchRendererSupport(this.app.getP(), this._flatActive).reason || this.renderer.legacyReason || this._renderLegacyReason)
      : '';
    return `Boid | Agents: ${count} | Sim: ${this.sim?.mode || 'wasm'} | Render: ${this._renderBackend}${legacyReason ? ` (${legacyReason})` : ''}`;
  }

  onActiveLayerCleared(layer) {
    this._clearGpuPreview();
    this._resetInterpolationState();
    this._sensingUploaded = false;
    this._sensingFrame = 0;
    this._sensingSignature = '';
    _resetMotionBrushPaintState(this, layer);
  }

  resetSimulationPlaybackState({ compositePreview = false, resetRenderer = false } = {}) {
    if (this.sim) this.sim.clearAgents();
    _resetSimulationSpawnAppearance(this);
    this._clearGpuPreview({ composite: compositePreview });
    this._resetInterpolationState();
    this._lastSpawnX = 0;
    this._lastSpawnY = 0;
    this._boidsSpawned = false;
    this._hoverSpawned = false;
    this._flatActive = false;
    this._sensingUploaded = false;
    this._sensingFrame = 0;
    this._sensingSignature = '';
    this._sensingLum = null;
    if (resetRenderer) this.renderer.reset();
  }

  deactivate() {
    this.resetSimulationPlaybackState({ compositePreview: true });
    this._spawnRangesById.clear();
    this._primarySpawnId = null;
    this._transientSnapshot = { count: 0 };
  }

  destroy() {
    if (!this._usingSharedSim) {
      this.sim?.destroy?.();
    }
    this.sim = null;
    this._usingSharedSim = false;
    this._ready = false;
    this._boidsSpawned = false;
    this._hoverSpawned = false;
    this._flatActive = false;
    this._sensingUploaded = false;
    this._sensingFrame = 0;
    this._sensingSignature = '';
    this._gpuPreviewActive = false;
    this._gpuPreviewLayer = null;
    this._gpuPreviewRenderer = null;
    this.renderer.reset();
  }
}

// =============================================================================
// ANT BRUSH — Pheromone-trail ant colony simulation
//
// Ants crawl across the canvas, depositing pheromone trails that attract
// other ants.  The pheromone grid feeds into the same pixel-sensing pipeline
// used by BoidBrush, so the WASM simulation steers ants toward existing
// pheromone deposits.  A cursor "follow" signal lets the user guide the
// colony.  Trail deposition is rendered both as paint and as an optional
// overlay visualisation.
// =============================================================================

export class AntBrush {
  constructor(app) {
    this.app = app;
    this.renderer = createBoidStampRenderer();
    this.sim = null;
    this._ready = false;
    this._lastStampX = [];
    this._lastStampY = [];
    this._lastSpacingX = [];
    this._lastSpacingY = [];
    this._lastSpawnX = 0;
    this._lastSpawnY = 0;
    this._renderBackend = 'legacy';
    this._renderLegacyReason = 'compatibility check pending';
    this._gpuFailureCount = 0;
    this._gpuDisabledReason = '';
    this._rendererInitPromise = null;
    this._rendererChainPatched = false;
    this._gpuPreviewActive = false;
    this._gpuPreviewLayer = null;
    this._gpuPreviewRenderer = null;
    // Pheromone grid (JS-side, quarter-resolution like sensing)
    this._pheroW = 0;
    this._pheroH = 0;
    this._pheroData = null;  // Float32Array — continuous 0-255 values
    this._pheroFrame = 0;
    // Trail blur offscreen canvases (shared pattern from BoidBrush)
    this._blurCanvas = null;
    this._blurCtx = null;
    this._blurTmpCanvas = null;
    this._blurTmpCtx = null;
    this._blurStrokeCanvas = null;
    this._blurStrokeCtx = null;
    // Flat-stroke
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._preStrokeCanvas = null;
    this._preStrokeCtx = null;
    this._flatActive = false;
    _resetSimulationSpawnAppearance(this);
    _ensureProceduralStampRendererInit(this);
  }

  async init({ force = false } = {}) {
    if (force) {
      this._ready = false;
      this.sim = null;
      this._lastStampX = [];
      this._lastStampY = [];
      this._lastSpacingX = [];
      this._lastSpacingY = [];
      this._renderBackend = 'legacy';
      this._renderLegacyReason = 'compatibility check pending';
      this._gpuFailureCount = 0;
      this._gpuDisabledReason = '';
      this._rendererInitPromise = null;
      this._rendererChainPatched = false;
      this._gpuPreviewActive = false;
      this._gpuPreviewLayer = null;
      this._gpuPreviewRenderer = null;
      _resetSimulationSpawnAppearance(this);
      this.renderer.reset();
    }
    _ensureProceduralStampRendererInit(this);
    if (this.app.sharedMotionSim) {
      this.sim = this.app.sharedMotionSim;
      this.sim.setDisplaySize?.(this.app.W, this.app.H);
      this._ready = true;
      return this.sim;
    }
    try {
      this.sim = await _acquireSharedMotionSim(this.app);
      this.app.sharedMotionSim = this.sim;
      this._ready = true;
    } catch (e) {
      console.error('AntBrush: WASM init failed —', e);
    }
  }

  _buildRenderBatch(read, p, {
    flat = this._flatActive,
    pressure = this.app.pressure,
    interpolate = true,
    applySkip = true,
    forceStamp = false,
    taperCurve = 1,
    taperSize = false,
    taperOpacity = false,
  } = {}) {
    const { buffer, count, stride } = read;
    const instances = new StampInstanceBuffer(Math.max(64, count));
    const skipActive = applySkip && this.app.strokeFrame <= (p.skipStamps || 0);
    const colorCache = new Map();
    const getAppearanceColor = color => {
      const key = _normalizeBrushHexColor(color, '#000000');
      let cached = colorCache.get(key);
      if (!cached) {
        cached = { hsl: hexToHSL(key), rgb: hexToRGB(key) };
        colorCache.set(key, cached);
      }
      return cached;
    };

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];
      const appearance = _getSimulationSpawnAppearance(this, i, p);
      const appearanceColor = getAppearanceColor(appearance.color);

      let size = p.stampSize * sm;
      let opacity = flat ? Math.min(om, 1) : appearance.opacity * om;
      if (!taperSize && p.pressureSize) size *= (0.3 + 0.7 * pressure);
      if (!flat && !taperOpacity && p.pressureOpacity) opacity *= (0.3 + 0.7 * pressure);
      if (taperSize) size *= taperCurve;
      if (taperOpacity) opacity *= taperCurve;
      opacity = Math.min(opacity, 1);
      if (opacity < 0.005 || size < 0.5) continue;

      const color = (agentHue !== 0 || agentSat !== 0 || agentLit !== 0)
        ? hslToRGB(appearanceColor.hsl[0] + agentHue, appearanceColor.hsl[1] + agentSat, appearanceColor.hsl[2] + agentLit)
        : appearanceColor.rgb;

      if (skipActive) {
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        this._lastSpacingX[i] = ax;
        this._lastSpacingY[i] = ay;
        continue;
      }

      const prevStampX = this._lastSpacingX[i];
      const prevStampY = this._lastSpacingY[i];
      if (!interpolate || prevStampX === undefined || prevStampY === undefined) {
        _emitBatchStampInstances(this.app, instances, p, ax, ay, size, color, opacity);
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        this._lastSpacingX[i] = ax;
        this._lastSpacingY[i] = ay;
        continue;
      }

      const dx = ax - prevStampX;
      const dy = ay - prevStampY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = p.stampSeparation > 0 ? p.stampSeparation : Math.max(1, size * 0.25);

      if (dist >= step) {
        const emitCount = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= emitCount; j++) {
          const t = j / emitCount;
          _emitBatchStampInstances(this.app, instances, p, prevStampX + dx * t, prevStampY + dy * t, size, color, opacity);
        }
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        this._lastSpacingX[i] = ax;
        this._lastSpacingY[i] = ay;
      } else if (forceStamp) {
        _emitBatchStampInstances(this.app, instances, p, ax, ay, size, color, opacity);
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
      }
    }

    return {
      instances: instances.finish(),
      count: instances.count,
    };
  }

  // ---- Pheromone grid management ----

  /** Initialise (or resize) the pheromone grid to quarter-canvas resolution */
  _initPheroGrid() {
    const app = this.app;
    const w = Math.max(1, (app.W * app.DPR) >> 2);
    const h = Math.max(1, (app.H * app.DPR) >> 2);
    if (this._pheroW !== w || this._pheroH !== h || !this._pheroData) {
      this._pheroW = w;
      this._pheroH = h;
      this._pheroData = new Float32Array(w * h);
    }
  }

  /** Deposit pheromone at (cx, cy) CSS coords with given intensity (0-255) */
  _depositPheromone(cx, cy, radius, intensity) {
    if (!this._pheroData) return;
    const dpr = this.app.DPR;
    // Convert CSS coords to quarter-resolution grid coords
    const gx = (cx * dpr) / 4;
    const gy = (cy * dpr) / 4;
    const gr = Math.max(1, (radius * dpr) / 4);
    const gr2 = gr * gr;
    const w = this._pheroW;
    const h = this._pheroH;
    const x0 = Math.max(0, Math.floor(gx - gr));
    const x1 = Math.min(w - 1, Math.ceil(gx + gr));
    const y0 = Math.max(0, Math.floor(gy - gr));
    const y1 = Math.min(h - 1, Math.ceil(gy + gr));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px - gx;
        const dy = py - gy;
        const d2 = dx * dx + dy * dy;
        if (d2 > gr2) continue;
        const falloff = 1 - Math.sqrt(d2) / gr;
        const idx = py * w + px;
        this._pheroData[idx] = Math.min(MAX_PHEROMONE, this._pheroData[idx] + intensity * falloff);
      }
    }
  }

  /** Evaporate pheromones: multiply by (1 - decayRate) */
  _decayPheromones(decayRate) {
    if (!this._pheroData) return;
    const factor = 1 - decayRate;
    const data = this._pheroData;
    for (let i = 0, len = data.length; i < len; i++) {
      data[i] *= factor;
      if (data[i] < 0.5) data[i] = 0;
    }
  }

  /** Upload pheromone grid to WASM sensing (same pathway as pixel sensing) */
  _uploadPheromoneToSensing() {
    if (!this._pheroData || !this.sim) return;
    const lum = new Uint8Array(this._pheroData.length);
    for (let i = 0, len = this._pheroData.length; i < len; i++) {
      lum[i] = Math.min(MAX_PHEROMONE, Math.round(this._pheroData[i]));
    }
    this.sim.uploadSensing(lum, this._pheroW, this._pheroH);
  }

  paintSimulationPheromone(points, radius, intensity) {
    if (!points?.length) return;
    this._initPheroGrid();
    for (const pt of points) {
      this._depositPheromone(pt.x, pt.y, radius, intensity * MAX_PHEROMONE);
    }
  }

  configureSimulation(data, p) {
    if (!this._ready || !data?.spawns?.length) return;
    const primary = data.spawns.find(spawn => spawn.enabled !== false) || data.spawns[0];
    for (const spawn of data.spawns) {
      if (spawn === primary || spawn.enabled === false) continue;
      const config = this.app._resolveSimulationSpawnConfig(spawn, p);
      const spawnInfo = this.app._spawnSimulationAgents(this.sim, config, spawn.x, spawn.y);
      _setSimulationSpawnAppearanceRange(this, spawnInfo, config, p);
    }
    this._initPheroGrid();
    if (this._pheroData) this._pheroData.fill(0);
    for (const trail of data.pheromonePaths || []) {
      if (trail.enabled === false) continue;
      const config = this.app._resolveSimulationPheromoneConfig(trail, p);
      this.paintSimulationPheromone(trail.points, config.radius, config.intensity);
    }
    if (p.antPheromoneToSensing && this._pheroData) this._uploadPheromoneToSensing();
  }

  refreshSimulationSpawnAppearance(p = this.app.getP()) {
    if (!this._ready || !this.sim || !this.app.simulation?.enabled) return;
    _syncSimulationSpawnAppearance(this, this.app._ensureSimulationSpawns('ant'), spawn => this.app._resolveSimulationSpawnConfig(spawn, p), p);
  }

  // ---- Brush lifecycle ----

  onDown(x, y, pressure) {
    if (!this._ready) return;
    const p = this.app.getP();
    if (!this.app.simulation?.enabled) _resetSimulationSpawnAppearance(this);
    if (this._gpuPreviewActive) _clearProceduralGpuPreview(this, { composite: true });
    const simSpawn = this.app.simulation?.enabled && this.app.activeBrush === 'ant'
      ? (this.app._ensureSimulationSpawns('ant').find(spawn => spawn.enabled !== false) || this.app._ensureSimulationSpawns('ant')[0])
      : null;
    const spawnConfig = simSpawn ? this.app._resolveSimulationSpawnConfig(simSpawn, p) : null;
    let r = spawnConfig ? spawnConfig.radius : p.spawnRadius;
    if (!spawnConfig && p.pressureSpawnRadius) r *= (0.3 + 0.7 * pressure);
    this.sim.clearAgents();
    _resetSimulationSpawnAppearance(this);
    const spawnInfo = this.app._spawnSimulationAgents(this.sim, {
      count: spawnConfig ? spawnConfig.count : p.count,
      shape: spawnConfig ? spawnConfig.shape : p.spawnShape,
      angle: spawnConfig ? spawnConfig.angle : p.spawnAngle,
      jitter: spawnConfig ? spawnConfig.jitter : p.spawnJitter,
      radius: r,
      color: spawnConfig ? spawnConfig.color : p.color,
      opacity: spawnConfig ? spawnConfig.opacity : p.stampOpacity,
      mask: spawnConfig?.mask || null,
      distribution: spawnConfig?.distribution || 'uniform',
      noiseScale: spawnConfig?.noiseScale || 1,
    }, x, y);
    _setSimulationSpawnAppearanceRange(this, spawnInfo, {
      color: spawnConfig ? spawnConfig.color : p.color,
      opacity: spawnConfig ? spawnConfig.opacity : p.stampOpacity,
    }, p);
    this._spawnOverrides = spawnConfig ? {
      stampSize: spawnConfig.stampSize,
      stampSeparation: spawnConfig.stampSeparation,
      trailFlow: spawnConfig.trailFlow,
      smudge: spawnConfig.smudge,
      hueVar: spawnConfig.hueVar,
      satVar: spawnConfig.satVar,
      litVar: spawnConfig.litVar,
      sizeVar: spawnConfig.sizeVar,
      opacityVar: spawnConfig.opacityVar,
      speedVar: spawnConfig.speedVar,
    } : null;
    this._lastStampX = [];
    this._lastStampY = [];
    this._lastSpawnX = x;
    this._lastSpawnY = y;
    this.app.strokeFrame = 0;
    this._pheroFrame = 0;

    // Initialise pheromone grid
    this._initPheroGrid();
    // Clear pheromones at stroke start unless simulation mode will seed them
    if (this._pheroData && !this.app.simulation?.enabled) this._pheroData.fill(0);

    // Push undo
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }

    // Flat-stroke setup
    this._flatActive = !!p.flatStroke;
    if (this._flatActive) {
      const layer = this.app.getActiveLayer();
      const dpr = this.app.DPR;
      const w = layer.canvas.width, h = layer.canvas.height;
      if (!this._strokeCanvas || this._strokeCanvas.width !== w || this._strokeCanvas.height !== h) {
        this._strokeCanvas = document.createElement('canvas');
        this._strokeCanvas.width = w; this._strokeCanvas.height = h;
        this._strokeCtx = this._strokeCanvas.getContext('2d');
        this._preStrokeCanvas = document.createElement('canvas');
        this._preStrokeCanvas.width = w; this._preStrokeCanvas.height = h;
        this._preStrokeCtx = this._preStrokeCanvas.getContext('2d');
      }
      this._preStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._preStrokeCtx.clearRect(0, 0, w, h);
      this._preStrokeCtx.drawImage(layer.canvas, 0, 0);
      this._strokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._strokeCtx.clearRect(0, 0, w, h);
    }

    // Clear per-stroke blur accumulation
    if (this._blurStrokeCanvas) {
      const lw = this._blurStrokeCanvas.width, lh = this._blurStrokeCanvas.height;
      this._blurStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurStrokeCtx.clearRect(0, 0, lw, lh);
      this._blurStrokeCtx.setTransform(this.app.DPR, 0, 0, this.app.DPR, 0, 0);
    }

    // Initial step (same as BoidBrush — prevents no-paint on quick taps)
    if (!this._flatActive) {
      // Override: set sensing to attract mode for pheromone following
      const antP = this._buildAntParams(p);
      const guideState = _collectSimulationGuides(this, p);
      const gpuGuideSupport = _syncSimulationGuidesToGpu(this, guideState);
      this.sim.writeParams(antP, x, y, 0);
      this.sim.step(1 / 60);
      const { buffer, count, stride } = this.sim.readAgents();
      if (_applySimulationGuides(this, p, { buffer, count, stride }, guideState, gpuGuideSupport)) {
        this.sim.markStateDirty?.();
      }
      if (count > 0) {
        const layer = this.app.getActiveLayer();
        const batchSupport = _getProceduralBatchRendererSupport(this, p, false);
        if (batchSupport.ok) {
          const batch = this._buildRenderBatch({ buffer, count, stride }, p, {
            flat: false,
            pressure,
            interpolate: false,
            applySkip: false,
            forceStamp: true,
          });
          if (!_renderProceduralBatchToTarget(this, layer.ctx, batch, p, { allowAlphaLock: true })) {
            const colorCache = new Map();
            const getAppearanceColor = color => {
              const key = _normalizeBrushHexColor(color, '#000000');
              let cached = colorCache.get(key);
              if (!cached) {
                cached = { hsl: hexToHSL(key), color: key };
                colorCache.set(key, cached);
              }
              return cached;
            };
            for (let i = 0; i < count; i++) {
              const base = i * stride;
              const ax = buffer[base + 0];
              const ay = buffer[base + 1];
              const sm = buffer[base + 8];
              const om = buffer[base + 9];
              const agentHue = buffer[base + 20];
              const agentSat = buffer[base + 21];
              const agentLit = buffer[base + 22];
              const appearance = _getSimulationSpawnAppearance(this, i, p);
              const appearanceColor = getAppearanceColor(appearance.color);
              let sz = p.stampSize * sm;
              let op = appearance.opacity * om;
              if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
              if (p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
              op = Math.min(op, 1);
              let color = appearanceColor.color;
              if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
                const [bh, bs, bl] = appearanceColor.hsl;
                color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
              }
              this.app.symStamp(layer.ctx, ax, ay, sz, color, op);
              this._lastStampX[i] = ax;
              this._lastStampY[i] = ay;
            }
          }
        } else {
          _setProceduralRenderBackend(this, 'legacy', batchSupport.reason);
          const colorCache = new Map();
          const getAppearanceColor = color => {
            const key = _normalizeBrushHexColor(color, '#000000');
            let cached = colorCache.get(key);
            if (!cached) {
              cached = { hsl: hexToHSL(key), color: key };
              colorCache.set(key, cached);
            }
            return cached;
          };
          for (let i = 0; i < count; i++) {
            const base = i * stride;
            const ax = buffer[base + 0];
            const ay = buffer[base + 1];
            const sm = buffer[base + 8];
            const om = buffer[base + 9];
            const agentHue = buffer[base + 20];
            const agentSat = buffer[base + 21];
            const agentLit = buffer[base + 22];
            const appearance = _getSimulationSpawnAppearance(this, i, p);
            const appearanceColor = getAppearanceColor(appearance.color);
            let sz = p.stampSize * sm;
            let op = appearance.opacity * om;
            if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
            if (p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
            op = Math.min(op, 1);
            let color = appearanceColor.color;
            if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
              const [bh, bs, bl] = appearanceColor.hsl;
              color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
            }
            this.app.symStamp(layer.ctx, ax, ay, sz, color, op);
            this._lastStampX[i] = ax;
            this._lastStampY[i] = ay;
          }
        }
        for (let i = 0; i < count; i++) {
          const base = i * stride;
          this._depositPheromone(buffer[base + 0], buffer[base + 1], p.antPheromoneSize, p.antPheromoneRate * MAX_PHEROMONE);
        }
        layer.dirty = true;
      }
    }
  }

  onMove(x, y, pressure) {
    // No respawn-on-move: ants are spawned once (on hover or touch-down)
  }

  onUp(x, y) {
    if (!this._flatActive) {
      if (!_commitProceduralGpuPreviewToLayer(this)) {
        const layer = this.app.getActiveLayer();
        if (layer?.dirty) this.app.compositeAllLayers();
      }
    }
    // Touch has no hover phase — clear ants on lift so they don't linger
    if (this.app.pointerType === 'touch') {
      this.sim.clearAgents();
      this._hoverSpawned = false;
    }
  }

  /**
   * Build params object with ant-specific overrides.
   * Pheromone sensing uses the same WASM pathway: sensing is enabled in
   * attract mode so ants are drawn toward deposited pheromone trails.
   */
  _buildAntParams(p) {
    return Object.assign({}, p, {
      // Ant follow signal: seek = antFollow strength toward cursor
      seek: p.antFollow,
      // Enable sensing in attract mode for pheromone following
      sensingEnabled: p.antPheromoneToSensing,
      sensingMode: 'attract',
      sensingStrength: p.sensingStrength,
      sensingRadius: p.sensingRadius || 20,
      sensingFitRadius: p.sensingFitRadius || 0,
      sensingThreshold: p.sensingThreshold || 0.1,
      // Ants wander more by default
      wander: p.wander,
      jitter: p.jitter,
      simBoundsMargin: this.app.simulation?.enabled ? p.simBoundsMargin : -1,
    });
  }

  onFrame(elapsed) {
    if (!this._ready) return;
    const p = this.app.getP();
    const app = this.app;

    // Decay pheromones each frame
    if (this._pheroData) {
      this._decayPheromones(p.antPheromoneDecay);
    }

    // Upload pheromone grid as sensing data (same pathway as pixel sensing)
    this._pheroFrame++;
    if (p.antPheromoneToSensing && this._pheroData) {
      // Re-upload every 3 frames to balance performance and responsiveness
      if (this._pheroFrame % 3 === 0) {
        this._uploadPheromoneToSensing();
      }
    }

    // Write params with ant-specific overrides and step sim
    const antP = this._buildAntParams(p);
    const guideState = _collectSimulationGuides(this, p);
    const gpuGuideSupport = _syncSimulationGuidesToGpu(this, guideState);
    this.sim.writeParams(antP, app.leaderX, app.leaderY, elapsed);
    this.sim.step(1 / 60);

    // Read agents
    const read = this.sim.readAgents();
    if (_applySimulationGuides(this, p, read, guideState, gpuGuideSupport)) this.sim.markStateDirty?.();
    const { buffer, count, stride } = read;
    if (count === 0) return;

    // Stamp each agent and deposit pheromones along their paths
    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;
    const skipN = p.skipStamps || 0;
    app.strokeFrame++;

    const batchSupport = _getProceduralBatchRendererSupport(this, p, flat);
    if (batchSupport.ok) {
      for (let i = 0; i < count; i++) {
        const base = i * stride;
        this._depositPheromone(buffer[base + 0], buffer[base + 1], p.antPheromoneSize, p.antPheromoneRate * MAX_PHEROMONE);
      }
      const batch = this._buildRenderBatch(read, p, {
        flat,
        pressure: app.pressure,
        interpolate: true,
        applySkip: skipN > 0,
        forceStamp: !!app.isDrawing || !!app.simulation?.running,
      });
      if (_renderProceduralBatchToTarget(this, stampCtx, batch, p, { allowAlphaLock: !flat })) {
        if (flat) {
          const w = layer.canvas.width, h = layer.canvas.height;
          const ctx = layer.ctx;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(this._preStrokeCanvas, 0, 0);
          let masterOp = p.stampOpacity;
          if (p.pressureOpacity) masterOp *= (0.3 + 0.7 * app.pressure);
          ctx.globalAlpha = Math.min(masterOp, 1);
          ctx.drawImage(this._strokeCanvas, 0, 0);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
        layer.dirty = true;
        app.compositeAllLayers();
        return;
      }
    }

    _setProceduralRenderBackend(this, 'legacy', batchSupport.ok ? (this.renderer.legacyReason || this._renderLegacyReason) : batchSupport.reason);
    const colorCache = new Map();
    const getAppearanceColor = color => {
      const key = _normalizeBrushHexColor(color, '#000000');
      let cached = colorCache.get(key);
      if (!cached) {
        cached = { hsl: hexToHSL(key), color: key };
        colorCache.set(key, cached);
      }
      return cached;
    };

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];
      const appearance = _getSimulationSpawnAppearance(this, i, p);
      const appearanceColor = getAppearanceColor(appearance.color);

      // Skip first N stamps
      if (app.strokeFrame <= skipN) {
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        continue;
      }

      let sz = p.stampSize * sm;
      let op = flat ? Math.min(om, 1) : appearance.opacity * om;
      if (p.pressureSize) sz *= (0.3 + 0.7 * app.pressure);
      if (!flat && p.pressureOpacity) op *= (0.3 + 0.7 * app.pressure);
      op = Math.min(op, 1);

      let color = appearanceColor.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = appearanceColor.hsl;
        color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
      }

      // Deposit pheromone at current ant position
      this._depositPheromone(ax, ay, p.antPheromoneSize, p.antPheromoneRate * MAX_PHEROMONE);

      // Interpolation: fill gaps between previous and current position
      const step = p.stampSeparation > 0
        ? p.stampSeparation
        : Math.max(1, sz * 0.25);
      const prevX = this._lastStampX[i];
      const prevY = this._lastStampY[i];

      if (prevX !== undefined) {
        const dx = ax - prevX;
        const dy = ay - prevY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < step) continue;
        const n = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= n; j++) {
          const t = j / n;
          app.symStamp(stampCtx, prevX + dx * t, prevY + dy * t, sz, color, op);
          if (p.trailBlur > 0 && !flat && this._blurStrokeCtx) {
            _stampToBlurAccum(this._blurStrokeCtx, app, prevX + dx * t, prevY + dy * t, sz, color, op);
          }
        }
      } else {
        app.symStamp(stampCtx, ax, ay, sz, color, op);
        if (p.trailBlur > 0 && !flat && this._blurStrokeCtx) {
          _stampToBlurAccum(this._blurStrokeCtx, app, ax, ay, sz, color, op);
        }
      }

      this._lastStampX[i] = ax;
      this._lastStampY[i] = ay;
    }

    // Flat-stroke compositing
    if (flat) {
      const w = layer.canvas.width, h = layer.canvas.height;
      const ctx = layer.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._preStrokeCanvas, 0, 0);
      let masterOp = p.stampOpacity;
      if (p.pressureOpacity) masterOp *= (0.3 + 0.7 * app.pressure);
      ctx.globalAlpha = Math.min(masterOp, 1);
      ctx.drawImage(this._strokeCanvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Trail blur (identical to BoidBrush)
    if (p.trailBlur > 0 && !flat) {
      const lw = layer.canvas.width, lh = layer.canvas.height;
      if (!this._blurCanvas || this._blurCanvas.width !== lw || this._blurCanvas.height !== lh) {
        this._blurCanvas = document.createElement('canvas');
        this._blurCanvas.width = lw;
        this._blurCanvas.height = lh;
        this._blurCtx = this._blurCanvas.getContext('2d');
        this._blurTmpCanvas = document.createElement('canvas');
        this._blurTmpCanvas.width = lw;
        this._blurTmpCanvas.height = lh;
        this._blurTmpCtx = this._blurTmpCanvas.getContext('2d');
      }
      if (!this._blurStrokeCanvas || this._blurStrokeCanvas.width !== lw || this._blurStrokeCanvas.height !== lh) {
        this._blurStrokeCanvas = document.createElement('canvas');
        this._blurStrokeCanvas.width = lw;
        this._blurStrokeCanvas.height = lh;
        this._blurStrokeCtx = this._blurStrokeCanvas.getContext('2d');
        this._blurStrokeCtx.setTransform(app.DPR, 0, 0, app.DPR, 0, 0);
      }
      this._blurCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurCtx.clearRect(0, 0, lw, lh);
      this._blurCtx.drawImage(this._blurStrokeCanvas, 0, 0);
      if (p.trailFlow > 0 && p.canvasTextureEnabled) {
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p);
      }
      this._blurTmpCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurTmpCtx.clearRect(0, 0, lw, lh);
      this._blurTmpCtx.filter = `blur(${p.trailBlur * app.DPR}px)`;
      this._blurTmpCtx.drawImage(this._blurCanvas, 0, 0);
      this._blurTmpCtx.filter = 'none';
      layer.ctx.save();
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.globalAlpha = 0.18;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.drawImage(this._blurTmpCanvas, 0, 0);
      layer.ctx.globalAlpha = 1;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.restore();
    }

    layer.dirty = true;
    app.compositeAllLayers();
  }

  taperFrame(t, p) {
    if (!this._ready) return;
    const app = this.app;
    const curve = Math.pow(1 - t, p.taperCurve);

    // Freeze agent positions — do NOT step the simulation during taper.
    // Stepping causes ants to drift and stamp at unexpected locations with
    // full size/opacity, producing the "large and opaque" taper bug.
    const { buffer, count, stride } = this.sim.readAgents();
    if (count === 0) return;

    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;

    const batchSupport = _getProceduralBatchRendererSupport(this, p, flat);
    if (batchSupport.ok) {
      const batch = this._buildRenderBatch({ buffer, count, stride }, p, {
        flat,
        interpolate: false,
        applySkip: false,
        taperCurve: curve,
        taperSize: p.taperSize,
        taperOpacity: p.taperOpacity,
      });
      if (_renderProceduralBatchToTarget(this, stampCtx, batch, p, { allowAlphaLock: !flat })) {
        if (flat) {
          const w = layer.canvas.width, h = layer.canvas.height;
          const ctx = layer.ctx;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(this._preStrokeCanvas, 0, 0);
          let masterOp = p.stampOpacity;
          if (p.taperOpacity) masterOp *= curve;
          ctx.globalAlpha = Math.min(masterOp, 1);
          ctx.drawImage(this._strokeCanvas, 0, 0);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
        layer.dirty = true;
        app.compositeAllLayers();
        return;
      }
    }

    _setProceduralRenderBackend(this, 'legacy', batchSupport.reason || this.renderer.legacyReason || this._renderLegacyReason);
    const colorCache = new Map();
    const getAppearanceColor = color => {
      const key = _normalizeBrushHexColor(color, '#000000');
      let cached = colorCache.get(key);
      if (!cached) {
        cached = { hsl: hexToHSL(key), color: key };
        colorCache.set(key, cached);
      }
      return cached;
    };

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];
      const appearance = _getSimulationSpawnAppearance(this, i, p);
      const appearanceColor = getAppearanceColor(appearance.color);

      let sz = p.stampSize * sm;
      let op = flat ? Math.min(om, 1) : appearance.opacity * om;
      if (p.taperSize) sz *= curve;
      if (p.taperOpacity) op *= curve;
      op = Math.min(op, 1);
      if (op < 0.005 || sz < 0.5) continue;

      let color = appearanceColor.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = appearanceColor.hsl;
        color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
      }

      // Stamp directly at frozen position (no distance interpolation).
      app.symStamp(stampCtx, ax, ay, sz, color, op);
    }

    if (flat) {
      const w = layer.canvas.width, h = layer.canvas.height;
      const ctx = layer.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._preStrokeCanvas, 0, 0);
      let masterOp = p.stampOpacity;
      if (p.taperOpacity) masterOp *= curve;
      ctx.globalAlpha = Math.min(masterOp, 1);
      ctx.drawImage(this._strokeCanvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    layer.dirty = true;
    app.compositeAllLayers();
  }

  drawOverlay(ctx, p) {
    if (!this._ready) return;

    // Show ant agents as small dots
    if (p.showBoids) {
      const { buffer, count, stride } = this.sim.readAgents();
      ctx.fillStyle = 'rgba(180,100,50,0.7)';
      for (let i = 0; i < count; i++) {
        const base = i * stride;
        ctx.fillRect(buffer[base] - 1, buffer[base + 1] - 1, 2, 2);
      }
    }

    // Draw spawn area indicator
    const simSpawn = this.app.simulation?.enabled && this.app.activeBrush === 'ant'
      ? (this.app._ensureSimulationSpawns('ant').find(spawn => spawn.enabled !== false) || this.app._ensureSimulationSpawns('ant')[0])
      : null;
    if (p.showSpawn && (this.app.isDrawing || simSpawn)) {
      const config = simSpawn ? this.app._resolveSimulationSpawnConfig(simSpawn, p) : null;
      const sx = simSpawn?.x ?? this.app.leaderX;
      const sy = simSpawn?.y ?? this.app.leaderY;
      ctx.strokeStyle = 'rgba(180,100,50,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, config?.radius ?? p.spawnRadius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Render pheromone trail overlay
    if (p.antTrailVisible && this._pheroData && this._pheroW > 0 && this._pheroH > 0) {
      const pw = this._pheroW;
      const ph = this._pheroH;
      const data = this._pheroData;
      const dpr = this.app.DPR;
      const cellW = 4 / dpr;
      const cellH = 4 / dpr;
      ctx.save();
      for (let py = 0; py < ph; py++) {
        for (let px = 0; px < pw; px++) {
          const v = data[py * pw + px];
          if (v < 2) continue;
          const a = Math.min(v / MAX_PHEROMONE, 1) * 0.4;
          ctx.fillStyle = `rgba(120,200,80,${a.toFixed(3)})`;
          ctx.fillRect(px * cellW, py * cellH, cellW, cellH);
        }
      }
      ctx.restore();
    }
  }

  getStatusInfo() {
    if (!this._ready) return 'WASM loading...';
    const { count } = this.sim.readAgents();
    const legacyReason = this._renderBackend === 'legacy'
      ? (_getProceduralBatchRendererSupport(this, this.app.getP(), this._flatActive).reason || this.renderer.legacyReason || this._renderLegacyReason)
      : '';
    return `Ant | Agents: ${count} | Render: ${this._renderBackend}${legacyReason ? ` (${legacyReason})` : ''}`;
  }

  onActiveLayerCleared(layer) {
    _clearProceduralGpuPreview(this);
    this._lastStampX = [];
    this._lastStampY = [];
    this._lastSpacingX = [];
    this._lastSpacingY = [];
    _resetMotionBrushPaintState(this, layer);
  }

  deactivate() {
    _clearProceduralGpuPreview(this, { composite: true });
    if (this.sim) this.sim.clearAgents();
    _resetSimulationSpawnAppearance(this);
    if (this._pheroData) this._pheroData.fill(0);
  }
}

// =============================================================================
// BRISTLE BRUSH — Spring-physics flexible bristle simulation
//
// Each bristle is an individual entity anchored to the brush body.
// When dragged, tips lag behind roots due to surface friction, creating
// realistic brush-stroke dynamics with splay and convergence.
// =============================================================================

export class BristleBrush {
  constructor(app) {
    this.app = app;
    this.renderer = createBoidStampRenderer();
    // Bristle state arrays
    this._rootX = [];    // root (ferrule) x – follows cursor
    this._rootY = [];    // root (ferrule) y
    this._tipX = [];     // tip (surface contact) x – simulated
    this._tipY = [];     // tip (surface contact) y
    this._velX = [];     // tip velocity x
    this._velY = [];     // tip velocity y
    this._lastStampX = [];
    this._lastStampY = [];
    this._offsets = [];  // per-bristle offset from cursor {dx, dy}
    // Per-bristle EMA-smoothed positions for stamp output
    this._smoothX = [];
    this._smoothY = [];
    // Per-bristle position history for Catmull-Rom smoothing (4 points each)
    this._histX = [];    // array of arrays: [[x0,x1,x2,x3], ...]
    this._histY = [];
    // Per-bristle variance multipliers (persistent per stroke)
    this._varSize = [];
    this._varOpacity = [];
    this._varStiffness = [];
    this._varLength = [];
    this._varFriction = [];
    this._varHue = [];
    this._cachedColors = [];   // pre-computed shifted colors per bristle
    this._cachedBaseColor = null; // base color used for cached colors
    this._count = 0;
    this._lastCursorX = 0;
    this._lastCursorY = 0;
    this._strokeDir = 0; // stroke direction angle (movement)
    this._baseAngle = Math.PI / 2; // bristle fan angle (perpendicular to pen azimuth)
    this._pressure = 0.5;
    this._smoothPressure = 0.5; // EMA-smoothed pressure for gradual transitions
    this._active = false;
    // Hover state — Apple Pencil hover preview
    this._hoverActive = false;
    this._hoverBristlesSpawned = false; // true when bristles have been spawned during hover
    this._hoverDir = 0;          // azimuth-derived angle during hover
    this._hoverLengthScale = 1;  // altitude-derived bristle length multiplier
    this._hoverDirSource = 'none';
    this._lastGoodHoverAzimuth = 0;
    this._hasGoodHoverAzimuth = false;
    this._smoothedPenDir = 0;
    this._hasSmoothedPenDir = false;
    // Flat-stroke (wet buffer) canvases
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._preStrokeCanvas = null;
    this._preStrokeCtx = null;
    this._flatActive = false;
    // Trail blur offscreen canvases
    this._blurCanvas = null;
    this._blurCtx = null;
    this._blurTmpCanvas = null;
    this._blurTmpCtx = null;
    this._blurStrokeCanvas = null;
    this._blurStrokeCtx = null;
    this._renderBackend = 'legacy';
    this._renderLegacyReason = 'compatibility check pending';
    this._gpuFailureCount = 0;
    this._gpuDisabledReason = '';
    this._rendererInitPromise = null;
    this._rendererChainPatched = false;
    this._gpuPreviewActive = false;
    this._gpuPreviewLayer = null;
    this._gpuPreviewRenderer = null;
    _ensureProceduralStampRendererInit(this);
  }

  _isDeadHoverAngleSample() {
    const isPen = this.app.pointerType === 'pen';
    const hasAz = this.app.penAngleSampleValid;
    const az = this.app.azimuth;
    const alt = this.app.altitude;
    // Some environments report hover as a constant 0 rad / 90 deg regardless
    // of pencil orientation. Treat this as unusable for hover direction.
    return isPen && hasAz && Math.abs(az) < 1e-4 && Math.abs(alt - Math.PI / 2) < 1e-4;
  }

  _resolveHoverDir(x, y, preferPenAzimuth = true) {
    const isPen = this.app.pointerType === 'pen';
    const hasAzimuth = preferPenAzimuth && isPen && this.app.penAngleSampleValid;
    const deadSample = hasAzimuth && this._isDeadHoverAngleSample();

    if (hasAzimuth && !deadSample) {
      const liveDir = this._smoothPencilDir(this.app.azimuth);
      this._lastGoodHoverAzimuth = liveDir;
      this._hasGoodHoverAzimuth = true;
      this._hoverDirSource = 'live-azimuth';
      return liveDir;
    }

    if (this._hasGoodHoverAzimuth) {
      this._hoverDirSource = 'cached-azimuth';
      return this._lastGoodHoverAzimuth;
    }

    const dx = x - this._lastCursorX;
    const dy = y - this._lastCursorY;
    if (dx * dx + dy * dy > 0.25) {
      this._hoverDirSource = 'hover-motion';
      return Math.atan2(dy, dx);
    }

    this._hoverDirSource = 'hold';
    return this._strokeDir;
  }

  _smoothPencilDir(target) {
    if (!this._hasSmoothedPenDir) {
      this._smoothedPenDir = target;
      this._hasSmoothedPenDir = true;
      return target;
    }
    const diff = ((target - this._smoothedPenDir + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this._smoothedPenDir += diff * BRISTLE_ANGLE_ALPHA;
    return this._smoothedPenDir;
  }

  /** Spawn bristles using current stroke direction.
   *  When alignTipsToDir is true, tips start one bristle-length away from bases
   *  along the stroke direction (used for Pencil azimuth-driven spawn). */
  _spawnBristles(x, y, p, alignTipsToDir = false) {
    const count = p.bristleCount;
    this._count = count;
    this._rootX = new Array(count);
    this._rootY = new Array(count);
    this._tipX = new Array(count);
    this._tipY = new Array(count);
    this._velX = new Array(count).fill(0);
    this._velY = new Array(count).fill(0);
    this._lastStampX = new Array(count);
    this._lastStampY = new Array(count);
    this._offsets = new Array(count);
    this._smoothX = new Array(count);
    this._smoothY = new Array(count);
    this._histX = new Array(count);
    this._histY = new Array(count);
    this._varSize = new Array(count);
    this._varOpacity = new Array(count);
    this._varStiffness = new Array(count);
    this._varLength = new Array(count);
    this._varFriction = new Array(count);
    this._varHue = new Array(count);
    this._cachedColors = new Array(count);

    const width = p.bristleWidth;
    const spread = p.bristleSpread;
    const tipAngle = this._strokeDir;
    const offsetRad = p.bristleAngleOffset;
    const baseAngle = this._baseAngle + offsetRad; // fan angle with offset
    const cosBase = Math.cos(baseAngle);
    const sinBase = Math.sin(baseAngle);
    const cosTip = Math.cos(tipAngle);
    const sinTip = Math.sin(tipAngle);
    const pressureSplay = p.bristleSplay * (0.5 + 0.5 * this._smoothPressure);
    const splayFactor = 1 + pressureSplay;
    const fanSpread = 1 + p.bristleFan; // fanning multiplier for cross-stroke width at tips
    const baseLen = p.bristleLength * this._hoverLengthScale;

    for (let i = 0; i < count; i++) {
      // Distribute evenly across the brush width, perpendicular to stroke
      const t = count > 1 ? (i / (count - 1) - 0.5) : 0; // -0.5 to 0.5
      // Base offset perpendicular to stroke direction
      const perpDx = t * width;
      const perpDy = 0;
      // Add slight randomness based on spread
      const jx = (Math.random() - 0.5) * spread * 2;
      const jy = (Math.random() - 0.5) * spread * 2;

      this._offsets[i] = { dx: perpDx + jx, dy: perpDy + jy };

      // Apply stroke-angle rotation at spawn so bases are immediately oriented.
      const rx = (perpDx + jx) * cosBase - (perpDy + jy) * sinBase;
      const ry = (perpDx + jx) * sinBase + (perpDy + jy) * cosBase;
      this._rootX[i] = x + rx * splayFactor;
      this._rootY[i] = y + ry * splayFactor;

      if (alignTipsToDir) {
        // Spawn tips bristle-length away in the same direction as Pencil azimuth.
        // Apply fanning: spread tips wider in the specified fanning direction.
        const fannedPerpDist = t * width * fanSpread;
        const cosFan = Math.cos(p.bristleFanAngle);
        const sinFan = Math.sin(p.bristleFanAngle);
        const fpx = cosFan * fannedPerpDist;
        const fpy = sinFan * fannedPerpDist;
        this._tipX[i] = this._rootX[i] + cosTip * baseLen + fpx;
        this._tipY[i] = this._rootY[i] + sinTip * baseLen + fpy;
      } else {
        this._tipX[i] = this._rootX[i];
        this._tipY[i] = this._rootY[i];
      }
      this._velX[i] = 0;
      this._velY[i] = 0;
      this._lastStampX[i] = undefined;
      this._lastStampY[i] = undefined;
      // Initialize EMA-smoothed positions at spawn
      this._smoothX[i] = this._tipX[i];
      this._smoothY[i] = this._tipY[i];
      // Initialize position history with spawn position
      this._histX[i] = [this._tipX[i], this._tipX[i], this._tipX[i], this._tipX[i]];
      this._histY[i] = [this._tipY[i], this._tipY[i], this._tipY[i], this._tipY[i]];
      // Generate persistent per-bristle variance multipliers (centered around 1.0)
      // Variance 0→no variation, 1→range [0.1, 1.9] clamped to avoid zero/negative
      this._varSize[i] = Math.max(0.1, 1 + (Math.random() - 0.5) * 2 * p.bSizeVar);
      this._varOpacity[i] = Math.max(0.1, 1 + (Math.random() - 0.5) * 2 * p.bOpacityVar);
      this._varStiffness[i] = Math.max(0.1, 1 + (Math.random() - 0.5) * 2 * p.bStiffVar);
      this._varLength[i] = Math.max(0.1, 1 + (Math.random() - 0.5) * 2 * p.bLengthVar);
      this._varFriction[i] = Math.max(0.1, 1 + (Math.random() - 0.5) * 2 * p.bFrictionVar);
      this._varHue[i] = (Math.random() - 0.5) * 2 * p.bHueVar * 60; // ±60° at max
    }
    // Sort hue offsets so spatially adjacent bristles get similar hues.
    // This prevents the dotted-line effect caused by random color alternation
    // between neighboring bristles whose stamps overlap on canvas.
    this._varHue.sort((a, b) => a - b);
    this._cachedBaseColor = null; // invalidate color cache
  }

  /** Rotate bristle offsets so the spread is perpendicular to stroke direction */
  _updateRoots(x, y, p) {
    const angle = this._baseAngle + p.bristleAngleOffset; // apply offset
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const pressureSplay = p.bristleSplay * (0.5 + 0.5 * this._smoothPressure);

    for (let i = 0; i < this._count; i++) {
      const off = this._offsets[i];
      // Rotate offset to be perpendicular to stroke direction
      const rx = off.dx * cosA - off.dy * sinA;
      const ry = off.dx * sinA + off.dy * cosA;
      // Apply splay: push outward from center based on pressure
      const splayFactor = 1 + pressureSplay;
      this._rootX[i] = x + rx * splayFactor;
      this._rootY[i] = y + ry * splayFactor;
    }
  }

  /** Step spring physics for all bristle tips */
  _stepPhysics(p, dt) {
    const stiffness = p.bristleStiffness * 12; // spring constant
    const damping = p.bristleDamping;
    const friction = p.bristleFriction;
    const length = p.bristleLength * this._hoverLengthScale;
    const angle = this._strokeDir;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    for (let i = 0; i < this._count; i++) {
      // Apply per-bristle variance
      const iStiff = stiffness * this._varStiffness[i];
      const iLen = length * this._varLength[i];
      const iFric = friction * this._varFriction[i];

      // Rest position is bristle-length away from root along current stroke direction.
      const restX = this._rootX[i] + cosA * iLen;
      const restY = this._rootY[i] + sinA * iLen;

      // Spring force toward rest position
      const dx = restX - this._tipX[i];
      const dy = restY - this._tipY[i];

      // The tip wants to stay at a distance of `length` from root in the
      // trailing direction, but also return if stretched too far
      let fx = dx * iStiff;
      let fy = dy * iStiff;

      // Surface friction: opposes velocity
      fx -= this._velX[i] * iFric;
      fy -= this._velY[i] * iFric;

      // Update velocity with damping
      this._velX[i] = (this._velX[i] + fx * dt) * damping;
      this._velY[i] = (this._velY[i] + fy * dt) * damping;

      // Clamp velocity to prevent explosion
      const speed = Math.sqrt(this._velX[i] * this._velX[i] + this._velY[i] * this._velY[i]);
      const maxSpd = 800;
      if (speed > maxSpd) {
        this._velX[i] = (this._velX[i] / speed) * maxSpd;
        this._velY[i] = (this._velY[i] / speed) * maxSpd;
      }

      // Update position
      this._tipX[i] += this._velX[i] * dt;
      this._tipY[i] += this._velY[i] * dt;

      // Constrain: tip can't be further than bristleLength * 2 from root
      const maxDist = iLen * 2;
      const tdx = this._tipX[i] - restX;
      const tdy = this._tipY[i] - restY;
      const tdist = Math.sqrt(tdx * tdx + tdy * tdy);
      if (tdist > maxDist) {
        this._tipX[i] = restX + (tdx / tdist) * maxDist;
        this._tipY[i] = restY + (tdy / tdist) * maxDist;
      }
    }
  }

  /** Push current tip positions into the per-bristle history ring and update EMA-smoothed positions */
  _pushHistory(smoothing) {
    const alpha = smoothing > 0 ? 1 - smoothing * MAX_SMOOTH_DAMP : 1;
    for (let i = 0; i < this._count; i++) {
      const hx = this._histX[i];
      const hy = this._histY[i];
      hx[0] = hx[1]; hx[1] = hx[2]; hx[2] = hx[3]; hx[3] = this._tipX[i];
      hy[0] = hy[1]; hy[1] = hy[2]; hy[2] = hy[3]; hy[3] = this._tipY[i];
      // Update per-bristle EMA-smoothed positions
      this._smoothX[i] += (this._tipX[i] - this._smoothX[i]) * alpha;
      this._smoothY[i] += (this._tipY[i] - this._smoothY[i]) * alpha;
    }
  }

  /** Catmull-Rom interpolation between p1 and p2 using p0 and p3 as tangent guides */
  static _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  /** Shift a color string by a hue offset. Returns hex color. */
  static _shiftHue(color, hueDeg) {
    if (hueDeg === 0) return color;
    // Parse hex color
    const r = parseInt(color.slice(1, 3), 16) / 255;
    const g = parseInt(color.slice(3, 5), 16) / 255;
    const b = parseInt(color.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    h = ((h * 360 + hueDeg) % 360 + 360) % 360 / 360;
    // HSL to RGB
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    let rr, gg, bb;
    if (s === 0) { rr = gg = bb = l; }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      rr = hue2rgb(p, q, h + 1/3);
      gg = hue2rgb(p, q, h);
      bb = hue2rgb(p, q, h - 1/3);
    }
    const toHex = v => {
      const c = Math.round(Math.min(1, Math.max(0, v)) * 255);
      return c < 16 ? '0' + c.toString(16) : c.toString(16);
    };
    return '#' + toHex(rr) + toHex(gg) + toHex(bb);
  }

  /** Get the cached shifted color for bristle i, rebuilding cache if base color changed */
  _getColor(i, baseColor) {
    if (this._cachedBaseColor !== baseColor) {
      this._cachedBaseColor = baseColor;
      for (let k = 0; k < this._count; k++) {
        this._cachedColors[k] = this._varHue[k] !== 0
          ? BristleBrush._shiftHue(baseColor, this._varHue[k])
          : baseColor;
      }
    }
    return this._cachedColors[i];
  }

  _buildRenderBatch(p, {
    opScale = 1,
    flat = this._flatActive,
    pressure = this._smoothPressure,
    taperCurve = 1,
    taperSize = false,
    taperOpacity = false,
  } = {}) {
    const instances = new StampInstanceBuffer(Math.max(64, this._count * 2));
    for (let i = 0; i < this._count; i++) {
      const tx = this._smoothX[i];
      const ty = this._smoothY[i];
      let sz = p.stampSize * this._varSize[i];
      let op = flat
        ? Math.min(opScale * this._varOpacity[i], 1)
        : p.stampOpacity * opScale * this._varOpacity[i];
      if (!taperSize && p.pressureSize) sz *= (0.3 + 0.7 * pressure);
      if (!flat && !taperOpacity && p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
      if (taperSize) sz *= taperCurve;
      if (taperOpacity) op *= taperCurve;
      op = Math.min(op, 1);
      if (op < 0.005 || sz < 0.5) continue;

      const color = hexToRGB(this._getColor(i, p.color));
      const step = p.stampSeparation > 0
        ? p.stampSeparation
        : Math.max(1, sz * 0.25);
      const prevX = this._lastStampX[i];
      const prevY = this._lastStampY[i];

      if (prevX !== undefined) {
        const dx = tx - prevX;
        const dy = ty - prevY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < step) continue;
        const n = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= n; j++) {
          const t = j / n;
          _emitBatchStampInstances(this.app, instances, p, prevX + dx * t, prevY + dy * t, sz, color, op);
        }
      } else {
        _emitBatchStampInstances(this.app, instances, p, tx, ty, sz, color, op);
      }

      this._lastStampX[i] = tx;
      this._lastStampY[i] = ty;
    }

    return {
      instances: instances.finish(),
      count: instances.count,
    };
  }

  /** Stamp all bristle tips using EMA-smoothed positions */
  _stampBristles(stampCtx, p, opScale, flat = false, blurCtx = null) {
    const app = this.app;
    const pres = this._smoothPressure;
    for (let i = 0; i < this._count; i++) {
      // Use per-bristle EMA-smoothed position (updated in _pushHistory)
      const tx = this._smoothX[i];
      const ty = this._smoothY[i];

      let sz = p.stampSize * this._varSize[i];
      // In flat mode stamps go at full per-bristle opacity; master opacity applied on composite
      let op = flat
        ? Math.min(opScale * this._varOpacity[i], 1)
        : p.stampOpacity * opScale * this._varOpacity[i];
      if (p.pressureSize) sz *= (0.3 + 0.7 * pres);
      if (!flat && p.pressureOpacity) op *= (0.3 + 0.7 * pres);
      op = Math.min(op, 1);

      // Apply per-bristle hue variance (cached per color change)
      const color = this._getColor(i, p.color);

      // Interpolation: fill gaps between previous and current position
      const step = p.stampSeparation > 0
        ? p.stampSeparation
        : Math.max(1, sz * 0.25);
      const prevX = this._lastStampX[i];
      const prevY = this._lastStampY[i];

      if (prevX !== undefined) {
        const dx = tx - prevX;
        const dy = ty - prevY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < step) continue; // accumulate distance

        const n = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= n; j++) {
          const t = j / n;
          app.symStamp(stampCtx, prevX + dx * t, prevY + dy * t, sz, color, op);
          if (blurCtx) _stampToBlurAccum(blurCtx, app, prevX + dx * t, prevY + dy * t, sz, color, op);
        }
      } else {
        app.symStamp(stampCtx, tx, ty, sz, color, op);
        if (blurCtx) _stampToBlurAccum(blurCtx, app, tx, ty, sz, color, op);
      }

      this._lastStampX[i] = tx;
      this._lastStampY[i] = ty;
    }
  }

  /** Apple Pencil hover: spawn bristles at hover position using azimuth for
   *  angle and altitude for bristle length, simulating a real brush preview. */
  onHover(x, y) {
    const p = this.app.getP();

    const alt = this.app.altitude;
    const isPen = this.app.pointerType === 'pen';
    const hasAzimuth = isPen && this.app.penAngleSampleValid;
    const hasTilt = isPen && alt < Math.PI / 2 - TILT_THRESHOLD;

    this._hoverDir = this._resolveHoverDir(x, y, p.pencilAngle);
    this._strokeDir = this._hoverDir;
    this._baseAngle = this._hoverDir + Math.PI / 2;
    // Tilt-based bristle length scaling
    const tiltFactor = hasTilt ? (1 - alt / (Math.PI / 2)) : 0.33;
    this._hoverLengthScale = 0.5 + tiltFactor * 1.5;
    this._hoverActive = true;
    this._lastCursorX = x;
    this._lastCursorY = y;

    // Spawn actual bristles during hover so physics can settle them
    if (!this._hoverBristlesSpawned) {
      this._spawnBristles(x, y, p, !!p.pencilAngle);
      this._hoverBristlesSpawned = true;
    }

    // Apply azimuth-driven orientation immediately during hover so angle
    // changes are visible without waiting for spring convergence.
    if (p.pencilAngle && this._hoverBristlesSpawned && this._count > 0) {
      this._updateRoots(x, y, p);
      const cosA = Math.cos(this._strokeDir);
      const sinA = Math.sin(this._strokeDir);
      const baseLen = p.bristleLength * this._hoverLengthScale;
      const fanSpread = 1 + p.bristleFan;
      const cosFan = Math.cos(p.bristleFanAngle);
      const sinFan = Math.sin(p.bristleFanAngle);
      for (let i = 0; i < this._count; i++) {
        const iLen = baseLen * this._varLength[i];
        // Apply fanning: spread tips wider in specified fanning direction
        const t = this._count > 1 ? (i / (this._count - 1) - 0.5) : 0;
        const w = p.bristleWidth;
        const fannedPerpDist = t * w * fanSpread;
        const fpx = cosFan * fannedPerpDist;
        const fpy = sinFan * fannedPerpDist;
        const tx = this._rootX[i] + cosA * iLen + fpx;
        const ty = this._rootY[i] + sinA * iLen + fpy;
        this._tipX[i] = tx;
        this._tipY[i] = ty;
        this._smoothX[i] = tx;
        this._smoothY[i] = ty;
        this._velX[i] = 0;
        this._velY[i] = 0;
        const hx = this._histX[i];
        const hy = this._histY[i];
        hx[0] = tx; hx[1] = tx; hx[2] = tx; hx[3] = tx;
        hy[0] = ty; hy[1] = ty; hy[2] = ty; hy[3] = ty;
      }
    }
  }

  /** Clear hover preview when pointer leaves canvas */
  onHoverEnd() {
    this._hoverActive = false;
    this._hoverBristlesSpawned = false;
    this._count = 0; // clear bristle arrays
  }

  /** Step bristle physics during hover (no stamping).
   *  This lets bristles settle into their physical positions so the brush
   *  shape preview matches what will happen when the pencil touches down. */
  onHoverFrame(elapsed) {
    if (!this._hoverActive || this._count === 0) return;
    const p = this.app.getP();
    const useHoverDirection = p.pencilAngle && this.app.pointerType === 'pen';

    if (useHoverDirection) {
      // Keep hover direction synced to live pen orientation when available,
      // otherwise use fallback direction sources.
      this._hoverDir = this._resolveHoverDir(this._lastCursorX, this._lastCursorY, true);
      this._strokeDir = this._hoverDir;
      this._baseAngle = this._hoverDir + Math.PI / 2;

      // If altitude is unavailable/flat during hover, keep a readable default length.
      const alt = this.app.altitude;
      const hasTilt = alt < Math.PI / 2 - TILT_THRESHOLD;
      const tiltFactor = hasTilt ? (1 - alt / (Math.PI / 2)) : 0.33;
      this._hoverLengthScale = 0.5 + tiltFactor * 1.5;

      // Kinematic hover preview: directly position roots/tips from current
      // azimuth so orientation is unambiguous before touch-down.
      this._updateRoots(this._lastCursorX, this._lastCursorY, p);
      const cosA = Math.cos(this._strokeDir);
      const sinA = Math.sin(this._strokeDir);
      const baseLen = p.bristleLength * this._hoverLengthScale;
      const fanSpread = 1 + p.bristleFan;
      const cosFan = Math.cos(p.bristleFanAngle);
      const sinFan = Math.sin(p.bristleFanAngle);
      for (let i = 0; i < this._count; i++) {
        const iLen = baseLen * this._varLength[i];
        // Apply fanning: spread tips wider in specified fanning direction
        const t = this._count > 1 ? (i / (this._count - 1) - 0.5) : 0;
        const w = p.bristleWidth;
        const fannedPerpDist = t * w * fanSpread;
        const fpx = cosFan * fannedPerpDist;
        const fpy = sinFan * fannedPerpDist;
        const tx = this._rootX[i] + cosA * iLen + fpx;
        const ty = this._rootY[i] + sinA * iLen + fpy;
        this._tipX[i] = tx;
        this._tipY[i] = ty;
        this._smoothX[i] = tx;
        this._smoothY[i] = ty;
        const hx = this._histX[i];
        const hy = this._histY[i];
        hx[0] = tx; hx[1] = tx; hx[2] = tx; hx[3] = tx;
        hy[0] = ty; hy[1] = ty; hy[2] = ty; hy[3] = ty;
      }
      return;
    }

    // Update root positions to follow the hover leader
    this._updateRoots(this._lastCursorX, this._lastCursorY, p);
    // Step physics so tips trail behind roots naturally
    const dt = 1 / 60;
    const subSteps = 3;
    for (let s = 0; s < subSteps; s++) {
      this._stepPhysics(p, dt / subSteps);
    }
    this._pushHistory(p.bristleSmoothing);
  }

  onDown(x, y, pressure) {
    const p = this.app.getP();
    if (this._gpuPreviewActive) _clearProceduralGpuPreview(this, { composite: true });
    this._pressure = pressure;
    this._smoothPressure = pressure; // Initialize smoothed pressure at stroke start
    this._lastCursorX = x;
    this._lastCursorY = y;
    // Prioritize live azimuth on touch-down. If not available, fall back to hover direction.
    if (p.pencilAngle && this.app.pointerType === 'pen' && this.app.penAngleSampleValid) {
      this._baseAngle = this.app.azimuth; // raw pen azimuth, no smoothing
      this._strokeDir = 0; // no movement yet at touch-down
      // Compute length scale from current altitude
      const tiltFactor = 1 - (this.app.altitude / (Math.PI / 2));
      this._hoverLengthScale = 0.5 + tiltFactor * 1.5;
    } else if (this._hoverActive) {
      this._strokeDir = this._hoverDir;
      // _baseAngle already set continuously during hover (onHoverFrame)
      this._smoothedPenDir = this._hoverDir;
      this._hasSmoothedPenDir = true;
      // _hoverLengthScale already set during hover
    } else {
      this._strokeDir = 0;
      this._baseAngle = Math.PI / 2;
      this._hoverLengthScale = 1; // reset to default
    }
    this._active = true;
    this._hoverActive = false; // transition from hover to drawing
    this.app.strokeFrame = 0;

    // Push undo
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }

    // Flat-stroke setup: snapshot layer, prepare stroke canvas
    this._flatActive = !!p.flatStroke;
    if (this._flatActive) {
      const layer = this.app.getActiveLayer();
      const dpr = this.app.DPR;
      const w = layer.canvas.width, h = layer.canvas.height;
      if (!this._strokeCanvas || this._strokeCanvas.width !== w || this._strokeCanvas.height !== h) {
        this._strokeCanvas = document.createElement('canvas');
        this._strokeCanvas.width = w; this._strokeCanvas.height = h;
        this._strokeCtx = this._strokeCanvas.getContext('2d');
        this._preStrokeCanvas = document.createElement('canvas');
        this._preStrokeCanvas.width = w; this._preStrokeCanvas.height = h;
        this._preStrokeCtx = this._preStrokeCanvas.getContext('2d');
      }
      this._preStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._preStrokeCtx.clearRect(0, 0, w, h);
      this._preStrokeCtx.drawImage(layer.canvas, 0, 0);
      this._strokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._strokeCtx.clearRect(0, 0, w, h);
    }

    // Clear per-stroke blur accumulation canvas
    if (this._blurStrokeCanvas) {
      const lw = this._blurStrokeCanvas.width, lh = this._blurStrokeCanvas.height;
      this._blurStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurStrokeCtx.clearRect(0, 0, lw, lh);
      this._blurStrokeCtx.setTransform(this.app.DPR, 0, 0, this.app.DPR, 0, 0);
    }

    // Always spawn a clean bristle set on touch-down using the current
    // calibrated stroke direction. This avoids inheriting hover-time kinematic
    // state that can create directional spring bias.
    const alignTips = p.pencilAngle && this.app.pointerType === 'pen' && this.app.penAngleSampleValid;
    this._spawnBristles(x, y, p, alignTips);
    this._hoverBristlesSpawned = false;
  }

  onMove(x, y, pressure) {
    if (!this._active) return;
    this._pressure = pressure;
    this._smoothPressure += (pressure - this._smoothPressure) * BRISTLE_PRESSURE_ALPHA;
    const p = this.app.getP();

    // Compute movement-derived direction
    const dx = x - this._lastCursorX;
    const dy = y - this._lastCursorY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    let moveDir = this._strokeDir;
    if (dist > 1) {
      const newDir = Math.atan2(dy, dx);
      const diff = newDir - this._strokeDir;
      const wrapped = ((diff + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      moveDir = this._strokeDir + wrapped * 0.3;
    }

    // Stroke direction always follows movement
    this._strokeDir = moveDir;

    // Pencil azimuth controls bristle fan angle (root spreading), independent of stroke direction
    if (p.pencilAngle && this.app.pointerType === 'pen' && this.app.penAngleSampleValid) {
      this._baseAngle = this.app.azimuth; // raw pen azimuth, no smoothing
      // Update bristle length scale from altitude during stroke
      const tiltFactor = 1 - (this.app.altitude / (Math.PI / 2));
      const targetScale = 0.5 + tiltFactor * 1.5;
      this._hoverLengthScale += (targetScale - this._hoverLengthScale) * 0.15;
    } else {
      this._baseAngle = this._strokeDir + Math.PI / 2;
    }

    this._lastCursorX = x;
    this._lastCursorY = y;
  }

  onUp(x, y) {
    if (!this._flatActive) {
      _commitProceduralGpuPreviewToLayer(this);
    }
  }

  onFrame(elapsed) {
    if (!this._active || this._count === 0) return;
    const p = this.app.getP();
    const app = this.app;

    // Update root positions
    this._updateRoots(this._lastCursorX, this._lastCursorY, p);

    // Step physics (multiple sub-steps for stability)
    const dt = 1 / 60;
    const subSteps = 3;
    for (let s = 0; s < subSteps; s++) {
      this._stepPhysics(p, dt / subSteps);
    }

    // Push tip positions into history and update EMA-smoothed positions
    this._pushHistory(p.bristleSmoothing);

    app.strokeFrame++;

    // Skip lead-in stamps
    const skipN = p.skipStamps || 0;
    if (app.strokeFrame <= skipN) {
      for (let i = 0; i < this._count; i++) {
        this._lastStampX[i] = this._smoothX[i];
        this._lastStampY[i] = this._smoothY[i];
      }
      return;
    }

    // Stamp bristle tips
    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;
    const blurEnabled = p.trailBlur > 0;

    const batchSupport = _getProceduralBatchRendererSupport(this, p, flat);
    if (batchSupport.ok) {
      const batch = this._buildRenderBatch(p, {
        opScale: 1,
        flat,
        pressure: this._smoothPressure,
      });
      if (_renderProceduralBatchToTarget(this, stampCtx, batch, p, { allowAlphaLock: !flat })) {
        if (flat) {
          const w = layer.canvas.width, h = layer.canvas.height;
          const ctx = layer.ctx;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(this._preStrokeCanvas, 0, 0);
          let masterOp = p.stampOpacity;
          if (p.pressureOpacity) masterOp *= (0.3 + 0.7 * this._smoothPressure);
          ctx.globalAlpha = Math.min(masterOp, 1);
          ctx.drawImage(this._strokeCanvas, 0, 0);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
        layer.dirty = true;
        app.compositeAllLayers();
        return;
      }
    }

    _setProceduralRenderBackend(this, 'legacy', batchSupport.ok ? (this.renderer.legacyReason || this._renderLegacyReason) : batchSupport.reason);

    this._stampBristles(stampCtx, p, 1.0, flat, blurEnabled ? this._blurStrokeCtx : null);

    // Flat-stroke compositing: restore snapshot, overlay stroke at stampOpacity
    if (flat) {
      const w = layer.canvas.width, h = layer.canvas.height;
      const ctx = layer.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._preStrokeCanvas, 0, 0);
      let masterOp = p.stampOpacity;
      if (p.pressureOpacity) masterOp *= (0.3 + 0.7 * this._smoothPressure);
      ctx.globalAlpha = Math.min(masterOp, 1);
      ctx.drawImage(this._strokeCanvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Trail blur: diffuse freshly stamped paint outward like wet ink
    if (blurEnabled) {
      const lw = layer.canvas.width, lh = layer.canvas.height;
      if (!this._blurCanvas || this._blurCanvas.width !== lw || this._blurCanvas.height !== lh) {
        this._blurCanvas = document.createElement('canvas');
        this._blurCanvas.width = lw;
        this._blurCanvas.height = lh;
        this._blurCtx = this._blurCanvas.getContext('2d');
        this._blurTmpCanvas = document.createElement('canvas');
        this._blurTmpCanvas.width = lw;
        this._blurTmpCanvas.height = lh;
        this._blurTmpCtx = this._blurTmpCanvas.getContext('2d');
      }
      if (!this._blurStrokeCanvas || this._blurStrokeCanvas.width !== lw || this._blurStrokeCanvas.height !== lh) {
        this._blurStrokeCanvas = document.createElement('canvas');
        this._blurStrokeCanvas.width = lw;
        this._blurStrokeCanvas.height = lh;
        this._blurStrokeCtx = this._blurStrokeCanvas.getContext('2d');
        this._blurStrokeCtx.setTransform(app.DPR, 0, 0, app.DPR, 0, 0);
      }
      this._blurCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurCtx.clearRect(0, 0, lw, lh);
      this._blurCtx.drawImage(this._blurStrokeCanvas, 0, 0);
      // Texture flow: shift blur paint toward lower-height texture areas
      if (p.trailFlow > 0 && p.canvasTextureEnabled) {
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p);
      }
      this._blurTmpCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurTmpCtx.clearRect(0, 0, lw, lh);
      this._blurTmpCtx.filter = `blur(${p.trailBlur * app.DPR}px)`;
      this._blurTmpCtx.drawImage(this._blurCanvas, 0, 0);
      this._blurTmpCtx.filter = 'none';
      layer.ctx.save();
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.globalAlpha = 0.18;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.drawImage(this._blurTmpCanvas, 0, 0);
      layer.ctx.globalAlpha = 1;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.restore();
    }

    layer.dirty = true;
    app.compositeAllLayers();
  }

  taperFrame(t, p) {
    if (this._count === 0) return;
    const app = this.app;
    const curve = Math.pow(1 - t, p.taperCurve);

    // Step physics toward rest (bristles converge back)
    const dt = 1 / 60;
    this._stepPhysics(p, dt);

    // Push history and update EMA-smoothed positions
    this._pushHistory(p.bristleSmoothing);

    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;

    const batchSupport = _getProceduralBatchRendererSupport(this, p, flat);
    if (batchSupport.ok) {
      const batch = this._buildRenderBatch(p, {
        opScale: 1,
        flat,
        taperCurve: curve,
        taperSize: p.taperSize,
        taperOpacity: p.taperOpacity,
      });
      if (_renderProceduralBatchToTarget(this, stampCtx, batch, p, { allowAlphaLock: !flat })) {
        if (flat) {
          const w = layer.canvas.width, h = layer.canvas.height;
          const ctx = layer.ctx;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(this._preStrokeCanvas, 0, 0);
          let masterOp = p.stampOpacity;
          if (p.taperOpacity) masterOp *= curve;
          ctx.globalAlpha = Math.min(masterOp, 1);
          ctx.drawImage(this._strokeCanvas, 0, 0);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
        layer.dirty = true;
        app.compositeAllLayers();
        return;
      }
    }

    _setProceduralRenderBackend(this, 'legacy', batchSupport.ok ? (this.renderer.legacyReason || this._renderLegacyReason) : batchSupport.reason);

    // Stamp with fading opacity/size
    for (let i = 0; i < this._count; i++) {
      const tx = this._smoothX[i];
      const ty = this._smoothY[i];

      let sz = p.stampSize * this._varSize[i];
      let op = flat
        ? Math.min(this._varOpacity[i], 1)
        : p.stampOpacity * this._varOpacity[i];
      if (p.taperSize) sz *= curve;
      if (p.taperOpacity) op *= curve;
      op = Math.min(op, 1);
      if (op < 0.005 || sz < 0.5) continue;

      const color = this._getColor(i, p.color);

      const step = p.stampSeparation > 0
        ? p.stampSeparation
        : Math.max(1, sz * 0.25);
      const prevX = this._lastStampX[i];
      const prevY = this._lastStampY[i];

      if (prevX !== undefined) {
        const dx = tx - prevX;
        const dy = ty - prevY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < step) continue;

        const n = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= n; j++) {
          const tt = j / n;
          app.symStamp(stampCtx, prevX + dx * tt, prevY + dy * tt, sz, color, op);
        }
      } else {
        app.symStamp(stampCtx, tx, ty, sz, color, op);
      }

      this._lastStampX[i] = tx;
      this._lastStampY[i] = ty;
    }

    // Flat-stroke compositing during taper
    if (flat) {
      const w = layer.canvas.width, h = layer.canvas.height;
      const ctx = layer.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._preStrokeCanvas, 0, 0);
      let masterOp = p.stampOpacity;
      if (p.taperOpacity) masterOp *= curve;
      ctx.globalAlpha = Math.min(masterOp, 1);
      ctx.drawImage(this._strokeCanvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    layer.dirty = true;
    app.compositeAllLayers();
  }

  drawOverlay(ctx, p) {
    const drawPencilDebug = () => {
      const isPen = this.app.pointerType === 'pen';
      const hasTilt = isPen && this.app.altitude < Math.PI / 2 - TILT_THRESHOLD;
      const hasAzimuth = isPen && this.app.penAngleSampleValid;
      const deadHover = this._isDeadHoverAngleSample();
      const azDeg = (this.app.azimuth * 180 / Math.PI).toFixed(1);
      const azRad = this.app.azimuth.toFixed(4);
      const altDeg = (this.app.altitude * 180 / Math.PI).toFixed(1);
      const dirDeg = (this._strokeDir * 180 / Math.PI).toFixed(1);
      const dAz = this.app.azimuthDeltaDeg.toFixed(2);
      const lines = [
        `Pencil dbg`,
        `type=${this.app.pointerType} pen=${isPen} hasTilt=${hasTilt} hasAz=${hasAzimuth}`,
        `azimuth=${azDeg}deg (${azRad}rad) altitude=${altDeg}deg`,
        `dAz/event=${dAz}deg updates=${this.app.azimuthUpdateCount}`,
        `deadHover=${deadHover} hoverDirSrc=${this._hoverDirSource}`,
        `source=${this.app.penAngleSource} eventHasAngles=${this.app.penEventHasAngles}`,
        `strokeDir=${dirDeg}deg hover=${this._hoverActive} active=${this._active}`,
        `lenScale=${this._hoverLengthScale.toFixed(2)} pencilAngle=${p.pencilAngle}`
      ];

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = '18px Consolas, monospace';
      ctx.textBaseline = 'top';
      const lineH = 24;
      const boxX = 12;
      const boxY = 12;
      const boxW = 700;
      const boxH = lines.length * lineH + 16;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = '#bff4ff';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], boxX + 10, boxY + 8 + i * lineH);
      }
      ctx.restore();
    };

    // Hover preview: show live physics-simulated bristle positions
    if (this._hoverActive && this._hoverBristlesSpawned && this._count > 0) {
      ctx.strokeStyle = 'rgba(255,180,100,0.3)';
      ctx.lineWidth = 0.5;
      for (let i = 0; i < this._count; i++) {
        // Root (anchor point)
        ctx.fillStyle = 'rgba(255,180,100,0.3)';
        ctx.fillRect(this._rootX[i] - 1, this._rootY[i] - 1, 2, 2);
        // Tip (physics-simulated position)
        ctx.fillStyle = 'rgba(100,255,180,0.4)';
        ctx.fillRect(this._smoothX[i] - 1, this._smoothY[i] - 1, 2, 2);
        // Line connecting root to tip
        ctx.beginPath();
        ctx.moveTo(this._rootX[i], this._rootY[i]);
        ctx.lineTo(this._smoothX[i], this._smoothY[i]);
        ctx.stroke();
      }
      drawPencilDebug();
      return; // hover preview only
    }

    if (!p.showBristles || !this._active) {
      if (this._hoverActive) drawPencilDebug();
      return;
    }
    // Draw bristle roots and tips
    for (let i = 0; i < this._count; i++) {
      // Root (anchor point)
      ctx.fillStyle = 'rgba(255,180,100,0.4)';
      ctx.fillRect(this._rootX[i] - 1, this._rootY[i] - 1, 2, 2);
      // Tip (contact point)
      ctx.fillStyle = 'rgba(100,255,180,0.6)';
      ctx.fillRect(this._tipX[i] - 1, this._tipY[i] - 1, 2, 2);
      // Line connecting root to tip
      ctx.strokeStyle = 'rgba(200,200,200,0.15)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(this._rootX[i], this._rootY[i]);
      ctx.lineTo(this._tipX[i], this._tipY[i]);
      ctx.stroke();
    }
    drawPencilDebug();
  }

  getStatusInfo() {
    const legacyReason = this._renderBackend === 'legacy'
      ? (_getProceduralBatchRendererSupport(this, this.app.getP(), this._flatActive).reason || this.renderer.legacyReason || this._renderLegacyReason)
      : '';
    return `Bristle | Tips: ${this._count} | Render: ${this._renderBackend}${legacyReason ? ` (${legacyReason})` : ''}`;
  }

  deactivate() {
    _clearProceduralGpuPreview(this, { composite: true });
    this._count = 0;
    this._active = false;
    this._hoverActive = false;
    this._hoverBristlesSpawned = false;
    this._hoverLengthScale = 1;
    this._flatActive = false;
  }
}

// =============================================================================
// SIMPLE BRUSH — Direct stamp along pointer path
// =============================================================================

export class SimpleBrush {
  constructor(app) {
    this.app = app;
    this.renderer = createBoidStampRenderer();
    this._lastStampX = null;
    this._lastStampY = null;
    this._needsComposite = false;
    this._active = false;
    this._renderBackend = 'legacy';
    this._renderLegacyReason = 'compatibility check pending';
    this._gpuFailureCount = 0;
    this._gpuDisabledReason = '';
    this._rendererInitPromise = null;
    this._rendererChainPatched = false;
    // Flat-stroke (wet buffer) canvases
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._preStrokeCanvas = null;
    this._preStrokeCtx = null;
    this._flatActive = false;
    // Trail blur offscreen canvases
    this._blurCanvas = null;
    this._blurCtx = null;
    this._blurTmpCanvas = null;
    this._blurTmpCtx = null;
    this._blurStrokeCanvas = null;
    this._blurStrokeCtx = null;
    this._lastStrokeAngle = 0;
    this._ensureRendererInit();
  }

  _ensureRendererInit() {
    if (this._rendererInitPromise) return this._rendererInitPromise;
    this._rendererInitPromise = this.renderer.init()
      .then(() => {
        if (this._rendererChainPatched) return;
        // Temporary Simple-Brush-specific override: prefer procedural GPU paths
        // (WebGPU/WebGL) with Canvas2D fallback while Boid keeps its own policy.
        this.renderer._getRendererChain = (renderState = {}) => {
          const chain = [];
          if (this._gpuDisabledReason) {
            chain.push(this.renderer.canvas);
            return chain;
          }
          if (renderState.stampBitmap) {
            if (this.renderer.webgl.ready) chain.push(this.renderer.webgl);
            chain.push(this.renderer.canvas);
            return chain;
          }
          if (this.renderer.webgpu.ready) chain.push(this.renderer.webgpu);
          if (this.renderer.webgl.ready) chain.push(this.renderer.webgl);
          chain.push(this.renderer.canvas);
          return chain;
        };
        this._rendererChainPatched = true;
      })
      .catch(() => {});
    return this._rendererInitPromise;
  }

  _setRenderBackend(kind, reason = '') {
    this._renderBackend = kind;
    this._renderLegacyReason = kind === 'legacy' ? reason : '';
  }

  _getBatchRendererSupport(p) {
    const layer = this.app.getActiveLayer();
    if (!layer) return { ok: false, reason: 'no active layer' };
    if (this._flatActive || p.flatStroke) return { ok: false, reason: 'flat stroke enabled' };
    if (p.trailBlur > 0) return { ok: false, reason: 'trail blur enabled' };
    if (p.trailFlow > 0) return { ok: false, reason: 'texture flow enabled' };
    if (p.smudge > 0) return { ok: false, reason: 'smudge enabled' };
    if (p.smudgeOnly) return { ok: false, reason: 'smudge only enabled' };
    if (p.kmMix && p.kmStrength > 0) return { ok: false, reason: 'pigment mix enabled' };
    if (p.impasto && p.impastoStrength > 0) return { ok: false, reason: 'impasto enabled' };
    if (this._gpuDisabledReason) return { ok: false, reason: this._gpuDisabledReason };
    if (!this.renderer.canRenderBatch({ stampBitmap: p.stampImageCanvas || null })) {
      return { ok: false, reason: this.renderer.getUnavailableReason({ stampBitmap: p.stampImageCanvas || null }) };
    }
    return { ok: true, reason: '' };
  }

  _getBatchCompositeOperation(p, layer) {
    return layer.alphaLock ? 'source-atop' : 'source-over';
  }

  _getBatchStampColor(p) {
    return p.color;
  }

  _expandRenderPoints(points, stampSize, p) {
    if (!points?.length) return [];
    const expanded = [];
    const seen = new Set();
    const addPoint = (x, y, rotation = 0, sizeMultiplier = 1) => {
      const key = `${Math.round(x * 1000)}:${Math.round(y * 1000)}`;
      if (seen.has(key)) return;
      seen.add(key);
      expanded.push({ x, y, rotation, sizeMultiplier });
    };
    for (const point of points) {
      const rotation = Number.isFinite(point.rotation) ? point.rotation : 0;
      const symPoints = p.symmetryEnabled ? this.app.getSymmetryPoints(point.x, point.y) : [point];
      for (const symPoint of symPoints) {
        const sizeMultiplier = symPoint.sizeMultiplier || point.sizeMultiplier || 1;
        addPoint(symPoint.x, symPoint.y, rotation, sizeMultiplier);
        if (!this.app.tilingMode || !this.app._getStampWrapPoints) continue;
        const wrapPoints = this.app._getStampWrapPoints(symPoint.x, symPoint.y, this._getStampBounds(stampSize * sizeMultiplier));
        for (const wrap of wrapPoints) addPoint(wrap.x, wrap.y, rotation + (wrap.rotation || 0), sizeMultiplier);
      }
    }
    return expanded;
  }

  _buildSimpleBatch(points, p, pressure) {
    const color = hexToRGB(this._getBatchStampColor?.(p) || p.color);
    const canvasTextureActive = this.app.hasCanvasTexture?.() && p.canvasTextureEnabled;
    const instances = new StampInstanceBuffer(Math.max(16, points.length));
    for (const pt of points) {
      let sz = p.stampSize * (pt.sizeMultiplier || 1);
      if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
      let op = p.stampOpacity;
      if (p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
      if (canvasTextureActive) {
        op *= this.app.getTextureDepositDensity?.(pt.x, pt.y, p) ?? 1;
        const edgeBreakup = this.app.getTextureEdgeBreakup?.(pt.x, pt.y, p) || 0;
        if (edgeBreakup > 0) {
          const field = this.app.sampleTextureField?.(pt.x, pt.y, p);
          sz *= Math.max(
            TEXTURE_EDGE_BREAKUP_MIN_SIZE,
            1 - edgeBreakup * TEXTURE_EDGE_BREAKUP_SIZE_SCALE + ((field?.valley ?? 0.5) - 0.5) * edgeBreakup * TEXTURE_EDGE_BREAKUP_VALLEY_SCALE,
          );
        }
      }
      op = Math.min(op, 1);
      if (sz < 0.5 || op < 0.005) continue;
      instances.push(pt.x, pt.y, sz, color.r, color.g, color.b, op, pt.rotation || 0);
    }
    return { instances: instances.finish(), count: instances.count };
  }

  _batchHasVisiblePixels(targetCtx, batch) {
    if (!targetCtx || !batch?.instances || batch.count <= 0) return false;
    const canvas = targetCtx.canvas;
    if (!canvas?.width || !canvas?.height) return false;
    const instances = batch.instances;
    const dpr = this.app.DPR || 1;
    const sampleCount = Math.min(batch.count, STAMP_VISIBILITY_SAMPLE_COUNT);
    const stride = 8;
    try {
      for (let i = 0; i < sampleCount; i++) {
        const base = i * stride;
        const size = Math.max(1, instances[base + 2] * dpr);
        const cx = Math.round(instances[base + 0] * dpr);
        const cy = Math.round(instances[base + 1] * dpr);
        const x = Math.max(0, Math.min(canvas.width - 1, cx));
        const y = Math.max(0, Math.min(canvas.height - 1, cy));
        if (targetCtx.getImageData(x, y, 1, 1).data[3] > 0) return true;
        const edge = Math.round(Math.min(size * 0.2, 2));
        const ex = Math.max(0, Math.min(canvas.width - 1, x + edge));
        if (targetCtx.getImageData(ex, y, 1, 1).data[3] > 0) return true;
      }
    } catch {
      return true;
    }
    return false;
  }

  _renderPointBatch(points, pressure) {
    const p = this.app.getP();
    const support = this._getBatchRendererSupport(p);
    const requestedStamps = points?.length || 0;
    if (!support.ok) {
      this._setRenderBackend('legacy', support.reason);
      this.app.recordBrushRenderTelemetry?.({
        backend: 'legacy',
        submittedStamps: requestedStamps,
        renderedStampsEstimate: 0,
        fallbackReason: support.reason,
      });
      return false;
    }
    this._ensureRendererInit();
    const layer = this.app.getActiveLayer();
    const stampSize = Math.max(1, p.pressureSize ? p.stampSize * (0.3 + 0.7 * pressure) : p.stampSize);
    const renderPoints = this._expandRenderPoints(points, stampSize, p);
    const batch = this._buildSimpleBatch(renderPoints, p, pressure);
    const stampBitmap = p.stampImageCanvas || null;
    const compositeOperation = this._getBatchCompositeOperation?.(p, layer) || 'source-over';
    if (batch.count <= 0) {
      const backend = this.renderer.getPreferredBatchRendererKind({ stampBitmap });
      this._setRenderBackend(backend);
      this.app.recordBrushRenderTelemetry?.({
        backend,
        submittedStamps: requestedStamps,
        renderedStampsEstimate: 0,
      });
      return true;
    }
    const ok = this.renderer.render({
      instances: batch.instances,
      count: batch.count,
      targetCtx: layer.ctx,
      targetWidthPx: layer.canvas.width,
      targetHeightPx: layer.canvas.height,
      dpr: this.app.DPR,
      compositeOperation,
      stampBitmap,
      stampTint: p.stampImageTint !== false,
      stampRotation: p.stampImageRotation || 0,
      stampAspect: stampBitmap?.width > 0 && stampBitmap?.height > 0 ? stampBitmap.width / stampBitmap.height : 1,
    });
    this._setRenderBackend(ok ? this.renderer.activeKind : 'legacy', ok ? '' : this.renderer.legacyReason);
    if (!ok) {
      this._gpuFailureCount++;
      if (this._gpuFailureCount >= GPU_RENDERER_FAILURE_LIMIT) {
        this._gpuDisabledReason = 'GPU simple-stamp renderer failed repeatedly';
        this._setRenderBackend('legacy', this._formatLegacyFallbackReason(this._gpuDisabledReason));
      }
      this.app.recordBrushRenderTelemetry?.({
        backend: 'legacy',
        submittedStamps: requestedStamps,
        renderedStampsEstimate: 0,
        fallbackReason: this._renderLegacyReason || this.renderer.legacyReason || 'GPU simple-stamp renderer failed',
      });
      return false;
    }
    if (this.renderer.activeKind !== 'canvas' && !this._batchHasVisiblePixels(layer.ctx, batch)) {
      this._gpuFailureCount++;
      if (this._gpuFailureCount >= GPU_RENDERER_FAILURE_LIMIT) {
        this._gpuDisabledReason = 'GPU simple-stamp visibility probe failed';
      }
      this._setRenderBackend('legacy', this._formatLegacyFallbackReason(this._gpuDisabledReason || 'GPU simple-stamp visibility probe failed'));
      this.app.recordBrushRenderTelemetry?.({
        backend: 'legacy',
        submittedStamps: requestedStamps,
        renderedStampsEstimate: 0,
        fallbackReason: this._renderLegacyReason || 'GPU simple-stamp visibility probe failed',
      });
      return false;
    }
    this._gpuFailureCount = 0;
    this.app.recordBrushRenderTelemetry?.({
      backend: this.renderer.activeKind || 'canvas',
      submittedStamps: requestedStamps,
      renderedStampsEstimate: batch.count,
    });
    return true;
  }

  onDown(x, y, pressure) {
    const p = this.app.getP();
    const strokeAngle = this._resolveStrokeAngle(null, p, this._lastStrokeAngle);
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }

    // Flat-stroke setup: snapshot layer, prepare stroke canvas
    this._flatActive = !!p.flatStroke;
    if (this._flatActive) {
      const layer = this.app.getActiveLayer();
      const dpr = this.app.DPR;
      const w = layer.canvas.width, h = layer.canvas.height;
      if (!this._strokeCanvas || this._strokeCanvas.width !== w || this._strokeCanvas.height !== h) {
        this._strokeCanvas = document.createElement('canvas');
        this._strokeCanvas.width = w; this._strokeCanvas.height = h;
        this._strokeCtx = this._strokeCanvas.getContext('2d');
        this._preStrokeCanvas = document.createElement('canvas');
        this._preStrokeCanvas.width = w; this._preStrokeCanvas.height = h;
        this._preStrokeCtx = this._preStrokeCanvas.getContext('2d');
      }
      this._preStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._preStrokeCtx.clearRect(0, 0, w, h);
      this._preStrokeCtx.drawImage(layer.canvas, 0, 0);
      this._strokeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._strokeCtx.clearRect(0, 0, w, h);
    }

    // Trail blur: set up per-stroke accumulation canvas
    if (p.trailBlur > 0) {
      const layer = this.app.getActiveLayer();
      const lw = layer.canvas.width, lh = layer.canvas.height;
      if (!this._blurStrokeCanvas || this._blurStrokeCanvas.width !== lw || this._blurStrokeCanvas.height !== lh) {
        this._blurStrokeCanvas = document.createElement('canvas');
        this._blurStrokeCanvas.width = lw; this._blurStrokeCanvas.height = lh;
        this._blurStrokeCtx = this._blurStrokeCanvas.getContext('2d');
        this._blurStrokeCtx.setTransform(this.app.DPR, 0, 0, this.app.DPR, 0, 0);
      } else {
        this._blurStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
        this._blurStrokeCtx.clearRect(0, 0, lw, lh);
        this._blurStrokeCtx.setTransform(this.app.DPR, 0, 0, this.app.DPR, 0, 0);
      }
    }

    this._lastStampX = x;
    this._lastStampY = y;
    this._lastStrokeAngle = strokeAngle;
    this.app.strokeFrame = 0;
    this._active = true;
    if (!this._renderPointBatch([{ x, y, rotation: strokeAngle }], pressure)) {
      this._stamp(x, y, pressure, strokeAngle);
    }
    this._markDirty();
  }

  onMove(x, y, pressure) {
    if (this._lastStampX == null) return;

    const dx = x - this._lastStampX;
    const dy = y - this._lastStampY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const p = this.app.getP();
    let sz = p.stampSize;
    if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
    const step = Math.max(1, p.stampSeparation > 0 ? p.stampSeparation : sz * 0.25);

    if (dist < step) return; // accumulate distance until next stamp

    const n = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
    const pathAngle = dist > 0 ? Math.atan2(dy, dx) : this._lastStrokeAngle;
    const strokeAngle = this._resolveStrokeAngle(pathAngle, p, this._lastStrokeAngle);
    const points = [];
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      points.push({
        x: this._lastStampX + dx * t,
        y: this._lastStampY + dy * t,
        rotation: strokeAngle,
      });
    }
    if (!this._renderPointBatch(points, pressure)) {
      for (const pt of points) this._stamp(pt.x, pt.y, pressure, pt.rotation);
    }
    this._lastStampX = x;
    this._lastStampY = y;
    this._lastStrokeAngle = strokeAngle;

    this._markDirty();
  }

  onUp() {
    this._lastStampX = null;
    this._lastStampY = null;
    // Flush any pending composite so the final stamps are visible
    this._flushComposite();
    this._active = false;
  }

  onFrame() {
    if (!this._active) return;
    this._flushComposite();
  }

  taperFrame(t, p) {
    // Simple brush has no ongoing simulation; taper is a no-op
  }

  /** Mark layer as needing composite on next frame */
  _markDirty() {
    this.app.getActiveLayer().dirty = true;
    this._needsComposite = true;
  }

  /** Flush pending composite if needed */
  _flushComposite() {
    if (!this._needsComposite) return;
    const app = this.app;
    const layer = app.getActiveLayer();
    const p = app.getP();

    // Flat-stroke compositing: restore snapshot, overlay stroke at stampOpacity
    if (this._flatActive && this._preStrokeCanvas) {
      const w = layer.canvas.width, h = layer.canvas.height;
      const ctx = layer.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this._preStrokeCanvas, 0, 0);
      let masterOp = p.stampOpacity;
      if (p.pressureOpacity) masterOp *= (0.3 + 0.7 * app.pressure);
      ctx.globalAlpha = Math.min(masterOp, 1);
      ctx.drawImage(this._strokeCanvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Trail blur: diffuse freshly stamped paint outward like wet ink
    if (p.trailBlur > 0 && this._blurStrokeCtx) {
      const lw = layer.canvas.width, lh = layer.canvas.height;
      if (!this._blurCanvas || this._blurCanvas.width !== lw || this._blurCanvas.height !== lh) {
        this._blurCanvas = document.createElement('canvas');
        this._blurCanvas.width = lw; this._blurCanvas.height = lh;
        this._blurCtx = this._blurCanvas.getContext('2d');
        this._blurTmpCanvas = document.createElement('canvas');
        this._blurTmpCanvas.width = lw; this._blurTmpCanvas.height = lh;
        this._blurTmpCtx = this._blurTmpCanvas.getContext('2d');
      }
      this._blurCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurCtx.clearRect(0, 0, lw, lh);
      this._blurCtx.drawImage(this._blurStrokeCanvas, 0, 0);
      // Texture flow: shift blur paint toward lower-height texture areas
      if (p.trailFlow > 0 && p.canvasTextureEnabled) {
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p);
      }
      this._blurTmpCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurTmpCtx.clearRect(0, 0, lw, lh);
      this._blurTmpCtx.filter = `blur(${p.trailBlur * app.DPR}px)`;
      this._blurTmpCtx.drawImage(this._blurCanvas, 0, 0);
      this._blurTmpCtx.filter = 'none';
      layer.ctx.save();
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.globalAlpha = 0.18;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.drawImage(this._blurTmpCanvas, 0, 0);
      layer.ctx.globalAlpha = 1;
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.restore();
    }

    layer.dirty = true;
    app.compositeAllLayers();
    this._needsComposite = false;
  }

  _stamp(x, y, pressure, strokeAngle = this._lastStrokeAngle) {
    const p = this.app.getP();
    const flat = this._flatActive;
    const layer = this.app.getActiveLayer();
    const ctx = flat ? this._strokeCtx : layer.ctx;
    let sz = p.stampSize;
    if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
    // In flat mode stamps go at full opacity; master opacity applied on composite
    let op = flat ? 1.0 : p.stampOpacity;
    if (!flat && p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
    op = Math.min(op, 1);

    this.app.symStamp(ctx, x, y, sz, p.color, op, {
      rotation: (p.stampImageRotation || 0) + strokeAngle,
    });
    if (this._blurStrokeCtx) _stampToBlurAccum(this._blurStrokeCtx, this.app, x, y, sz, p.color, op);
    this.app.strokeFrame++;
  }

  drawOverlay() { /* nothing */ }
  getStatusInfo() {
    const p = this.app.getP();
    const legacyReason = this._renderBackend === 'legacy'
      ? (this._getBatchRendererSupport(p).reason || this.renderer.legacyReason || this._renderLegacyReason)
      : '';
    return `Simple | Render: ${this._renderBackend}${legacyReason ? ` (${legacyReason})` : ''}`;
  }
  deactivate() {
    this._active = false;
    this._flatActive = false;
    this._setRenderBackend('legacy', 'compatibility check pending');
  }
}

// =============================================================================
// FLUID BRUSH — Free-flow LBM painter backed by the fluid WASM solver
// =============================================================================

function _fluidHexToRgba(hex, alpha = 1) {
  const normalized = String(hex || '#000000').replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map((chunk) => chunk + chunk).join('')
    : normalized.padStart(6, '0').slice(0, 6);
  const int = Number.parseInt(value, 16) || 0;
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
    a: _clamp(alpha, 0, 1),
  };
}

function _makeFluidSpawnProfile(x, y, previousPoint = null) {
  if (!previousPoint) {
    return {
      distance: 0,
      tangentX: 1,
      tangentY: 0,
      normalX: 0,
      normalY: 1,
      spawnTime: performance.now(),
    };
  }
  const dx = x - previousPoint.x;
  const dy = y - previousPoint.y;
  const distance = Math.hypot(dx, dy);
  const tangentX = distance > 1e-3 ? dx / distance : 1;
  const tangentY = distance > 1e-3 ? dy / distance : 0;
  return {
    distance,
    tangentX,
    tangentY,
    normalX: -tangentY,
    normalY: tangentX,
    spawnTime: performance.now(),
  };
}

function _jitterFluidColor(baseColor, p, profile, index) {
  if (p.lbmHueJitter <= 0 && p.lbmLightnessJitter <= 0) return baseColor;
  const [h, s, l] = hexToHSL(baseColor);
  const phase = (profile?.spawnTime ?? performance.now()) * 0.0026 + index * 0.71;
  const structured = Math.sin(phase) * 0.62 + Math.cos(phase * 0.53 + 1.1) * 0.38;
  const randomBias = (Math.random() - 0.5) * 2;
  const hueOffset = (structured * 0.7 + randomBias * 0.3) * p.lbmHueJitter;
  const lightOffset = (Math.cos(phase * 0.91 + 0.6) * 0.58 + randomBias * 0.42) * p.lbmLightnessJitter;
  const saturationOffset = _clamp(-Math.abs(lightOffset) * 0.18 + structured * 2.4, -8, 8);
  return hslToHex(h + hueOffset, s + saturationOffset, l + lightOffset);
}

function _makeFluidSeeds(x, y, amount, color, p, profile) {
  const particles = [];
  const speedScale = (0.54 + p.lbmStrokePull * 0.5 + p.lbmStrokeRake * 0.12 + p.lbmStrokeJitter * 0.2)
    * (p.lbmInjectForce ?? 1);
  const travel = Math.min(1, profile.distance / Math.max(8, p.lbmBrushRadius * 0.75));
  const laneCount = Math.max(3, 3 + Math.round(p.lbmStrokeRake * 7));
  const laneSpacing = p.lbmBrushRadius * (0.11 + p.lbmStrokeRake * 0.24 + p.lbmStrokeJitter * 0.06);
  const phase = profile.spawnTime * 0.018;
  const patternBoost = 0.35 + travel * 0.65;

  for (let index = 0; index < amount; index += 1) {
    if (profile.distance <= 1e-3) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * p.lbmBrushRadius;
      const radialVelocity = speedScale * (0.3 + Math.random() * 1.05);
      const swirlVelocity = speedScale * (0.12 + p.lbmStrokeJitter * 0.72) * (Math.random() - 0.5);
      const seed = _fluidHexToRgba(_jitterFluidColor(color, p, profile, index), 0.68 + Math.random() * 0.1);
      particles.push({
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        vx: Math.cos(angle) * radialVelocity - Math.sin(angle) * swirlVelocity,
        vy: Math.sin(angle) * radialVelocity + Math.cos(angle) * swirlVelocity,
        radius: p.lbmParticleRadius,
        ...seed,
      });
      continue;
    }

    const laneIndex = index % laneCount;
    const lanePosition = laneCount > 1 ? laneIndex / (laneCount - 1) - 0.5 : 0;
    const laneSpin = laneIndex % 2 === 0 ? 1 : -1;
    const alongOffset = ((Math.random() - 0.42) * p.lbmBrushRadius * (0.28 + p.lbmStrokePull * 0.82))
      + travel * p.lbmBrushRadius * (0.18 + p.lbmStrokePull * 0.55);
    const laneOffset = lanePosition * laneSpacing * (1 + travel * 1.4)
      + (Math.random() - 0.5) * p.lbmBrushRadius * (0.06 + p.lbmStrokeJitter * 0.18);
    const ribbonWave = Math.sin(phase * 1.18 + laneIndex * 1.37 + index * 0.31);
    const swirlOffset = ribbonWave * p.lbmBrushRadius * (0.08 + p.lbmStrokeJitter * 0.18 + patternBoost * 0.16);
    const scatterRadius = Math.sqrt(Math.random()) * p.lbmBrushRadius * (0.06 + p.lbmStrokeJitter * 0.18);
    const scatterAngle = phase * 1.4 + index * 0.53 + laneSpin * lanePosition * 1.8;
    const tangentVelocity = speedScale * (0.7 + p.lbmStrokePull * 2.5) * (0.72 + travel * 1.15 + Math.random() * 0.42);
    const crossVelocity = speedScale * (lanePosition * (0.5 + p.lbmStrokeRake * 1.8)
      + ribbonWave * (0.08 + p.lbmStrokeJitter * 0.44 + p.lbmStrokeRake * 0.18)
      + laneSpin * patternBoost * (0.04 + p.lbmStrokeRake * 0.22)
      + (Math.random() - 0.5) * (0.1 + p.lbmStrokeJitter * 0.34));
    const curlVelocity = speedScale * Math.sin(phase * 0.92 + lanePosition * 6.4 + index * 0.27)
      * laneSpin * (0.2 + p.lbmStrokeJitter * 0.92 + p.lbmStrokeRake * 0.34 + patternBoost * 0.18);
    const backfill = speedScale * (Math.random() - 0.5) * (0.08 + p.lbmStrokePull * 0.22);
    const dragNoiseX = speedScale * (Math.random() - 0.5) * (0.12 + p.lbmStrokeJitter * 0.16);
    const dragNoiseY = speedScale * (Math.random() - 0.5) * (0.14 + p.lbmStrokeJitter * 0.2);

    // ── Extra injection force modes ──────────────────────────────────────────
    // Each mode adds deltas in stroke-relative coords (along = tangent, cross = normal).

    // Vortex: counter-rotating ring vortices — tight spirals and eddies
    let extraAlongPos = 0, extraCrossPos = 0, extraAlongVel = 0, extraCrossVel = 0;
    if (p.lbmVortexStrength > 0) {
      const vortexAngle = laneIndex / laneCount * Math.PI * 2 + phase * 3.1 + index * 0.19;
      const vortexR = p.lbmBrushRadius * 0.45 * p.lbmVortexStrength;
      const vortexSpeed = speedScale * p.lbmVortexStrength * 2.8;
      const vortexSign = laneIndex % 2 === 0 ? 1 : -1;
      extraAlongPos += Math.cos(vortexAngle) * vortexR;
      extraCrossPos += Math.sin(vortexAngle) * vortexR;
      extraAlongVel += -Math.sin(vortexAngle) * vortexSpeed * vortexSign;
      extraCrossVel += Math.cos(vortexAngle) * vortexSpeed * vortexSign;
    }

    // Burst: radial explosion bursts along the stroke — sunburst splatters
    if (p.lbmBurstStrength > 0) {
      const burstAngle = (index / amount) * Math.PI * 2 + phase * 0.8 + laneIndex * 0.7;
      const burstR = p.lbmBrushRadius * 0.12 * p.lbmBurstStrength;
      const burstSpeed = speedScale * p.lbmBurstStrength * 3.8;
      extraAlongPos += Math.cos(burstAngle) * burstR;
      extraCrossPos += Math.sin(burstAngle) * burstR;
      extraAlongVel += Math.cos(burstAngle) * burstSpeed;
      extraCrossVel += Math.sin(burstAngle) * burstSpeed;
    }

    // Chevron: herringbone V-pattern — feather and fishbone textures
    if (p.lbmChevronStrength > 0) {
      const chevronDir = laneIndex % 2 === 0 ? 1 : -1;
      const chevronDivergence = 0.42 + p.lbmChevronStrength * 0.92;
      const chevronSpeed = speedScale * p.lbmChevronStrength * 2.2;
      extraAlongVel += Math.cos(chevronDivergence) * chevronSpeed;
      extraCrossVel += Math.sin(chevronDivergence) * chevronSpeed * chevronDir;
    }

    // Undulate: sinusoidal snake-wave cross-stroke offset — meander patterns
    if (p.lbmUndulateStrength > 0) {
      const undulateFreq = 0.0028;
      const undulateT = profile.spawnTime * undulateFreq + index * 0.14;
      const undulateWave = Math.sin(undulateT);
      const undulateDerivative = Math.cos(undulateT);
      const undulateAmp = p.lbmBrushRadius * 1.3 * p.lbmUndulateStrength;
      const undulateVelScale = speedScale * p.lbmUndulateStrength * 1.6;
      extraCrossPos += undulateWave * undulateAmp;
      extraCrossVel += undulateDerivative * undulateVelScale;
    }

    const seed = _fluidHexToRgba(_jitterFluidColor(color, p, profile, index), 0.66 + travel * 0.12 + Math.random() * 0.05);

    particles.push({
      x: x + profile.tangentX * (alongOffset + extraAlongPos) + profile.normalX * (laneOffset + swirlOffset + extraCrossPos) + Math.cos(scatterAngle) * scatterRadius * 0.35,
      y: y + profile.tangentY * (alongOffset + extraAlongPos) + profile.normalY * (laneOffset + swirlOffset + extraCrossPos) + Math.sin(scatterAngle) * scatterRadius * 0.35,
      vx: profile.tangentX * (tangentVelocity + backfill + extraAlongVel) + profile.normalX * (crossVelocity + curlVelocity + extraCrossVel) + dragNoiseX,
      vy: profile.tangentY * (tangentVelocity + backfill + extraAlongVel) + profile.normalY * (crossVelocity + curlVelocity + extraCrossVel) + dragNoiseY,
      radius: p.lbmParticleRadius * (1 + (Math.random() - 0.5) * (0.08 + p.lbmStrokeJitter * 0.22)),
      ...seed,
    });
  }

  return particles;
}


export class ThreeDFluidBrush {
  constructor(app) {
    this.app = app;
    this.sim = null;
    this._finalSim = null;
    this.renderer = new WebGPUFluidRenderer();
    this._ready = false;
    this._initPromise = null;
    this._active = false;
    this._lastPoint = null;
    this._lastFrameElapsed = null;
    this._strokeLayer = null;
    this._strokeBaseCanvas = document.createElement('canvas');
    this._strokeBaseCtx = this._strokeBaseCanvas.getContext('2d', { willReadFrequently: true });
    this._maskCanvas = document.createElement('canvas');
    this._maskCtx = this._maskCanvas.getContext('2d', { willReadFrequently: true });
    this._replayInteractionEvents = [];
    this._replayStepHistory = [];
    this._replayTime = 0;
    // Tracks the chunked post-stroke replay/settle job:
    // { replayIndex, replayTime, eventIndex, settleRemaining, stage }.
    this._finalPassJob = null;
    this._previewBound = false;
    this._backend = 'webgpu';
    this._legacyFallback = null;
  }

  async init({ force = false } = {}) {
    if (force) {
      this.sim?.destroy?.();
      this._finalSim?.destroy?.();
      this.renderer?.reset?.();
      this.sim = null;
      this._finalSim = null;
      this._ready = false;
      this._initPromise = null;
      this._active = false;
      this._lastPoint = null;
      this._lastFrameElapsed = null;
      this._strokeLayer = null;
      this._resetReplayCapture();
      this._finalPassJob = null;
      this._clearPreview({ composite: false });
      this._legacyFallback?.deactivate?.();
    }
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const params = this._solverParams();
      await this.renderer.init();
      if (!this.renderer.ready) {
        this._backend = 'legacy';
        this._legacyFallback = this._legacyFallback || new FluidBrush(this.app);
        await this._legacyFallback.init({ force });
        return this;
      }
      const gpuContext = {
        adapter: this.renderer.adapter,
        device: this.renderer.device,
      };
      this.sim = await WebGPUFluidSim.create(this.app.W || 800, this.app.H || 600, params, gpuContext);
      this._finalSim = await WebGPUFluidSim.create(this.app.W || 800, this.app.H || 600, this._solverParams('final'), gpuContext);
      this._ready = true;
      this._backend = 'webgpu';
      this._syncMask();
      return this;
    })().catch(async (error) => {
      console.warn('ThreeDFluidBrush: WebGPU init failed, falling back to legacy fluid.', error);
      this._backend = 'legacy';
      this._legacyFallback = this._legacyFallback || new FluidBrush(this.app);
      await this._legacyFallback.init({ force });
      return this;
    });
    return this._initPromise;
  }

  _usingLegacyFallback() {
    return this._backend === 'legacy' && this._legacyFallback;
  }

  _bindPreviewUpdater(layer = this._strokeLayer) {
    if (!this.renderer || !layer) return;
    this.renderer.onPreviewUpdated = (canvas) => {
      if (!canvas || !layer || this._strokeLayer !== layer || !this.app.layers.includes(layer)) return;
      layer.gpuPreviewCanvas = canvas;
      layer.dirty = true;
      this.app.compositeAllLayers();
    };
    this._previewBound = true;
  }

  _previewResolutionScale(p) {
    const finalScale = Number(p?.fluid3dResolutionScale) || 1;
    const previewScale = Number(p?.fluid3dPreviewScale) || finalScale;
    if (!p?.fluid3dAdaptiveQuality) return finalScale;
    return Math.max(0.3, Math.min(finalScale, previewScale));
  }

  _usesAdaptiveReplay(p = this.app.getP()) {
    return !!(p?.fluid3dAdaptiveQuality && this._previewResolutionScale(p) < ((Number(p?.fluid3dResolutionScale) || 1) - 0.05));
  }

  _solverParams(pass = 'preview', sourceParams = this.app.getP()) {
    const p = sourceParams;
    return {
      resolutionScale: pass === 'final' ? p.fluid3dResolutionScale : this._previewResolutionScale(p),
      fluidScale: p.fluid3dFluidScale,
      emissionRate: p.fluid3dEmissionRate,
      emitterStrength: p.fluid3dEmitterStrength,
      emitterVelocity: p.fluid3dEmitterVelocity,
      pressureResponse: p.fluid3dPressure,
      momentumRetention: p.fluid3dMomentum,
      velocityDiffuse: p.fluid3dVelocityDiffuse,
      drag: p.fluid3dDrag,
      thicknessDecay: p.fluid3dThicknessDecay,
      pigmentDiffusion: p.fluid3dPigmentDiffusion,
      pressureFade: p.fluid3dPressureFade,
      settleThreshold: p.fluid3dSettleThreshold,
      terrainWeight: p.fluid3dTerrainWeight,
      scalarFieldInfluence: p.fluid3dScalarFieldInfluence,
      influenceStrength: p.fluid3dInfluenceStrength,
      influenceRadius: p.fluid3dInfluenceRadius,
      maxVelocity: p.fluid3dMaxVelocity,
      thicknessFloor: p.fluid3dThicknessFloor,
      commitOpacityScale: p.fluid3dOpacityScale,
      renderMode: p.fluid3dRenderMode,
      previewBoost: pass === 'final' ? 1 : (p.fluid3dAdaptiveQuality ? 1.25 : 1),
      occupancyBias: p.fluid3dOccupancyBias,
      spreadClamp: p.fluid3dSpreadClamp,
      surfaceTension: p.fluid3dSurfaceTension,
      edgeWidth: p.fluid3dEdgeWidth,
      edgeDrag: p.fluid3dEdgeDrag,
      injectorMode: p.fluid3dInjectorMode,
      injectorMotionWeight: p.fluid3dInjectorMotion,
      injectorPigmentMotion: p.fluid3dInjectorPigment,
      injectorOccupancyMotion: p.fluid3dInjectorOccupancy,
      injectorSwirl: p.fluid3dInjectorSwirl,
    };
  }

  _updateSimulator(pass = 'preview', sourceParams = this.app.getP()) {
    const sim = pass === 'final' ? this._finalSim : this.sim;
    if (!sim) return false;
    sim.setDisplaySize(this.app.W || 1, this.app.H || 1);
    sim.updateParams(this._solverParams(pass, sourceParams));
    if (this._maskCanvas.width !== this.app.W || this._maskCanvas.height !== this.app.H) this._syncMask();
    return true;
  }

  _syncMask() {
    if (!this.sim && !this._finalSim) return;
    if (this._maskCanvas.width !== this.app.W || this._maskCanvas.height !== this.app.H) {
      this._maskCanvas.width = this.app.W;
      this._maskCanvas.height = this.app.H;
    }
    this._maskCtx.clearRect(0, 0, this._maskCanvas.width, this._maskCanvas.height);
    const mask = this._maskCtx.getImageData(0, 0, this._maskCanvas.width, this._maskCanvas.height);
    this.sim?.setMask(mask);
    this._finalSim?.setMask(mask);
  }

  _captureStrokeBase() {
    const layer = this._strokeLayer;
    if (!layer) return;
    if (this._strokeBaseCanvas.width !== layer.canvas.width || this._strokeBaseCanvas.height !== layer.canvas.height) {
      this._strokeBaseCanvas.width = layer.canvas.width;
      this._strokeBaseCanvas.height = layer.canvas.height;
    }
    this._strokeBaseCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._strokeBaseCtx.clearRect(0, 0, this._strokeBaseCanvas.width, this._strokeBaseCanvas.height);
    this._strokeBaseCtx.drawImage(layer.canvas, 0, 0, layer.canvas.width, layer.canvas.height);
  }

  _resetReplayCapture() {
    this._replayInteractionEvents = [];
    this._replayStepHistory = [];
    this._replayTime = 0;
  }

  _recordInteractionEvent(emitters = [], influences = [], scalarFields = []) {
    if (!emitters.length && !influences.length && !scalarFields.length) return;
    this._replayInteractionEvents.push({
      time: this._replayTime,
      emitters: emitters.map(record => ({ ...record })),
      influences: influences.map(record => ({ ...record })),
      scalarFields: scalarFields.map(record => ({ ...record })),
    });
  }

  _createTextureGuidancePayload(x, y, previousPoint, p, sampleCount = 0) {
    const textureEnabled = !!(this.app.hasCanvasTexture?.() && p?.canvasTextureEnabled);
    if (!textureEnabled) return { influences: [], scalarFields: [] };
    const flowInfluence = this.app.getTextureInfluence?.(p, 'flow') || 0;
    const terrainInfluence = Math.max(0, Number(p?.fluid3dTerrainWeight) || 0);
    const scalarInfluence = Math.max(0, Number(p?.fluid3dScalarFieldInfluence) || 0);
    if (flowInfluence <= 0 && terrainInfluence <= 0 && scalarInfluence <= 0) {
      return { influences: [], scalarFields: [] };
    }

    const color = hexToRGB(p.color);
    const baseRadius = Math.max(8, (Number(p?.fluid3dBrushRadius) || 0) * 0.58);
    const desiredSamples = sampleCount > 0 ? sampleCount : Math.round(baseRadius / 10);
    const samples = Math.max(FLUID3D_TEXTURE_GUIDE_MIN_SAMPLES, Math.min(FLUID3D_TEXTURE_GUIDE_MAX_SAMPLES, desiredSamples));
    const profile = _makeFluidSpawnProfile(x, y, previousPoint);
    const influences = [];
    const scalarFields = [];
    const anchorAngle = Math.atan2(profile.normalY || 0, profile.normalX || 1);

    for (let index = 0; index < samples; index += 1) {
      const t = (index + 0.5) / samples;
      const angle = anchorAngle + index * 2.399963229728653;
      const ringRadius = baseRadius * (0.18 + t * 0.5);
      const px = x + Math.cos(angle) * ringRadius;
      const py = y + Math.sin(angle) * ringRadius;
      const field = this.app.sampleTextureField?.(px, py, p);
      const flow = this.app.sampleTextureFlowVector?.(px, py, p);
      if (!field || !flow) continue;
      const slope = Math.max(0, Number(flow.slope ?? field.slope) || 0);
      const valleyBoost = 0.35 + field.valley * 0.65;

      if (flowInfluence > 0 && slope >= MIN_TEXTURE_FLOW_SLOPE) {
        const flowVelocity = baseRadius
          * (0.018 + slope * 0.075)
          * flowInfluence
          * (0.5 + (Number(p?.fluid3dEmitterVelocity) || 0) * 0.5);
        influences.push({
          sourceType: 1,
          x: px,
          y: py,
          vx: flow.x * flowVelocity,
          vy: flow.y * flowVelocity,
          radius: baseRadius * (0.28 + field.valley * 0.22),
          strength: flowInfluence * (0.35 + slope * 0.85) * valleyBoost / samples,
          alpha: (Number(p?.fluid3dOpacity) || 0) * 0.08,
          pigmentColor: color,
          modeFlags: 2,
        });
      }

      if (terrainInfluence > 0 || scalarInfluence > 0) {
        scalarFields.push({
          sourceType: 2,
          x: px,
          y: py,
          radius: baseRadius * (0.24 + field.valley * 0.18),
          strength: (Math.max(terrainInfluence, scalarInfluence) * (0.25 + slope * 0.75)) / samples,
          alpha: 1,
          value0: field.height * (0.25 + terrainInfluence * 0.75),
          value1: flow.x * flowInfluence * (0.45 + slope * 0.65),
          value2: flow.y * flowInfluence * (0.45 + slope * 0.65),
          value3: field.valley * scalarInfluence,
          modeFlags: 1,
          falloff: 1.15 + slope * 0.55,
        });
      }
    }

    return { influences, scalarFields };
  }

  _createEmitterPayload(x, y, pressure, previousPoint, amount, p) {
    // Reuse the legacy fluid stroke-profile helper so cursor tangent/normal handling stays
    // consistent between the lightweight LBM brush and the new 3D fluid brush.
    const profile = _makeFluidSpawnProfile(x, y, previousPoint);
    const color = hexToRGB(p.color);
    const scaledRadius = p.fluid3dBrushRadius * (p.pressureSize ? (0.35 + pressure * 0.65) : 1);
    const scaledCount = Math.max(1, Math.round(amount * (0.45 + pressure * 0.55)));
    const hasStrokeDirection = !!previousPoint && profile.distance > 1e-3;
    const totalEmitterStrength = p.fluid3dEmissionRate * p.fluid3dEmitterStrength * (0.4 + pressure * 0.6);
    const totalInfluenceStrength = p.fluid3dInfluenceStrength * (0.3 + pressure * 0.7);
    const emitterStrength = totalEmitterStrength / scaledCount;
    const influenceStrength = totalInfluenceStrength / scaledCount;
    const emitters = [];
    const influences = [];
    for (let index = 0; index < scaledCount; index += 1) {
      const scatterAngle = Math.random() * Math.PI * 2;
      const scatterRadius = Math.sqrt(Math.random()) * scaledRadius * (hasStrokeDirection ? 0.34 : 0.24);
      const alongJitter = (Math.random() - 0.5) * scaledRadius * (hasStrokeDirection ? 0.24 : 0.08);
      const acrossJitter = (Math.random() - 0.5) * scaledRadius * (hasStrokeDirection ? 0.42 : 0.26);
      const radialX = Math.cos(scatterAngle);
      const radialY = Math.sin(scatterAngle);
      const px = x
        + profile.tangentX * alongJitter
        + profile.normalX * acrossJitter
        + radialX * scatterRadius * 0.28;
      const py = y
        + profile.tangentY * alongJitter
        + profile.normalY * acrossJitter
        + radialY * scatterRadius * 0.28;
      const velocityScale = (0.2 + Math.random() * 0.18) * p.fluid3dEmitterVelocity * scaledRadius * 0.035;
      const tangentVelocity = hasStrokeDirection ? velocityScale : velocityScale * 0.08;
      const radialVelocity = hasStrokeDirection ? velocityScale * 0.1 : velocityScale * (Math.random() - 0.5) * 0.05;
      const normalVelocity = velocityScale * (Math.random() - 0.5) * (hasStrokeDirection ? 0.22 : 0.1);
      const vx = profile.tangentX * tangentVelocity + profile.normalX * normalVelocity + radialX * radialVelocity;
      const vy = profile.tangentY * tangentVelocity + profile.normalY * normalVelocity + radialY * radialVelocity;
      emitters.push({
        sourceType: 0,
        x: px,
        y: py,
        vx,
        vy,
        radius: scaledRadius * (0.2 + Math.random() * 0.12),
        strength: emitterStrength,
        alpha: p.fluid3dOpacity,
        pigmentColor: color,
        modeFlags: 1,
      });
      influences.push({
        sourceType: 1,
        x: px,
        y: py,
        vx,
        vy,
        radius: scaledRadius * (0.34 + Math.random() * 0.18),
        strength: influenceStrength,
        alpha: p.fluid3dOpacity * 0.25,
        pigmentColor: color,
        modeFlags: 0,
      });
    }
    const textureGuidance = this._createTextureGuidancePayload(x, y, previousPoint, p, Math.max(2, Math.round(scaledCount * 0.35)));
    if (textureGuidance.influences.length) influences.push(...textureGuidance.influences);
    return { emitters, influences, scalarFields: textureGuidance.scalarFields };
  }

  _consumeExternalInteractions() {
    const payload = this.app.consumeFluidInteractionInputs?.() || {};
    return {
      emitters: Array.isArray(payload.emitters) ? payload.emitters : [],
      influences: Array.isArray(payload.influences) ? payload.influences : [],
      scalarFields: Array.isArray(payload.scalarFields) ? payload.scalarFields : [],
    };
  }

  _hasVisiblePreview() {
    const layer = this._strokeLayer;
    return !!(layer?.gpuPreviewCanvas || this.renderer?.previewCanvas || this.renderer?.canvas);
  }

  onDown(x, y, pressure) {
    if (this._usingLegacyFallback()) return this._legacyFallback.onDown(x, y, pressure);
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }
    if (!this._ready || !this.sim) return;
    if (this._finalPassJob) {
      this._commitPreviewToLayer({ composite: false });
      this._finishSettledStroke();
    } else if (!this._active && this._strokeLayer && this._hasVisiblePreview()) {
      // Starting a new stroke should preserve the currently visible settled preview,
      // even if the previous stroke has not yet entered the async final-pass path.
      this._commitPreviewToLayer({ composite: false });
      this._finishSettledStroke();
    }
    const p = this.app.getP();
    this._active = true;
    this._strokeLayer = this.app.getActiveLayer();
    this._captureStrokeBase();
    this._clearPreview({ composite: false });
    this.sim.clearState();
    this._finalSim?.clearState?.();
    this._resetReplayCapture();
    this._lastPoint = { x, y };
    this._lastFrameElapsed = null;
    this._updateSimulator('preview', p);
    const local = this._createEmitterPayload(x, y, pressure, null, Math.max(2, p.fluid3dEmitterCount), p);
    this.sim.submitEmitters(local.emitters);
    this.sim.submitInfluences(local.influences);
    this.sim.submitScalarFields(local.scalarFields);
    if (this._usesAdaptiveReplay(p)) this._recordInteractionEvent(local.emitters, local.influences, local.scalarFields);
    this._step(0);
  }

  onMove(x, y, pressure) {
    if (this._usingLegacyFallback()) return this._legacyFallback.onMove(x, y, pressure);
    if (!this._active || !this.sim) return;
    const previousPoint = this._lastPoint;
    if (!previousPoint) {
      this._lastPoint = { x, y };
      return;
    }
    const p = this.app.getP();
    const dx = x - previousPoint.x;
    const dy = y - previousPoint.y;
    const distance = Math.hypot(dx, dy);
    const step = Math.max(2, p.fluid3dBrushRadius * 0.32);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let index = 1; index <= count; index += 1) {
      const t = index / count;
      const px = previousPoint.x + dx * t;
      const py = previousPoint.y + dy * t;
      const prev = { x: previousPoint.x + dx * ((index - 1) / count), y: previousPoint.y + dy * ((index - 1) / count) };
      const local = this._createEmitterPayload(px, py, pressure, prev, Math.max(2, Math.round(p.fluid3dEmitterCount * FLUID3D_MOVE_EMIT_RATIO)), p);
      this.sim.submitEmitters(local.emitters);
      this.sim.submitInfluences(local.influences);
      this.sim.submitScalarFields(local.scalarFields);
      if (this._usesAdaptiveReplay(p)) this._recordInteractionEvent(local.emitters, local.influences, local.scalarFields);
    }
    this._lastPoint = { x, y };
  }

  onUp(x, y) {
    if (this._usingLegacyFallback()) return this._legacyFallback.onUp(x, y);
    this._active = false;
    this._lastPoint = null;
  }

  onFrame(elapsed) {
    if (this._usingLegacyFallback()) return this._legacyFallback.onFrame(elapsed);
    this._step(elapsed);
  }

  onHoverFrame(elapsed) {
    if (this._usingLegacyFallback()) return this._legacyFallback.onHoverFrame?.(elapsed);
    this._step(elapsed);
  }

  taperFrame() {}

  _renderPreviewFromSim(sim) {
    const layer = this._strokeLayer || this.app.getActiveLayer();
    if (!layer || !this.renderer?.ready) return false;
    this._bindPreviewUpdater(layer);
    const ok = this.renderer.render({
      renderState: sim.getRenderState(),
      targetWidthPx: layer.canvas.width,
      targetHeightPx: layer.canvas.height,
      clear: true,
    });
    if (!ok) return false;
    layer.gpuPreviewCanvas = this.renderer.previewCanvas || this.renderer.canvas;
    layer.dirty = true;
    this.app.compositeAllLayers();
    return true;
  }

  _commitPreviewToLayer({ composite = true } = {}) {
    const layer = this._strokeLayer;
    if (!layer || !this.renderer?.ready) {
      this._clearPreview({ composite });
      return false;
    }
    const ok = this.renderer.copyTo2D(
      layer.ctx,
      layer.canvas.width,
      layer.canvas.height,
      layer.alphaLock ? 'source-atop' : 'source-over',
    );
    this.renderer.onPreviewUpdated = null;
    this._previewBound = false;
    this.renderer.clearSurface?.(layer.canvas.width, layer.canvas.height);
    layer.gpuPreviewCanvas = null;
    if (!ok) return false;
    layer.dirty = true;
    if (composite) this.app.compositeAllLayers();
    return true;
  }

  _clearPreview({ composite = false } = {}) {
    const layer = this._strokeLayer;
    if (layer?.gpuPreviewCanvas) {
      layer.gpuPreviewCanvas = null;
      layer.dirty = true;
    }
    if (this.renderer) {
      this.renderer.onPreviewUpdated = null;
      this._previewBound = false;
    }
    if (layer?.canvas && this.renderer?.ready) {
      this.renderer.clearSurface(layer.canvas.width, layer.canvas.height);
    }
    if (composite && layer) this.app.compositeAllLayers();
  }

  _finishSettledStroke() {
    this.sim?.clearState?.();
    this._finalSim?.clearState?.();
    this._resetReplayCapture();
    this._finalPassJob = null;
    this._active = false;
    this._lastPoint = null;
    this._lastFrameElapsed = null;
    this._strokeLayer = null;
  }

  _commitAndFinishSettledStroke() {
    this._commitPreviewToLayer({ composite: true });
    this._finishSettledStroke();
  }

  _flushFinalPassEvents(job) {
    while (job.eventIndex < this._replayInteractionEvents.length && this._replayInteractionEvents[job.eventIndex].time <= job.replayTime + 1e-6) {
      const event = this._replayInteractionEvents[job.eventIndex];
      this._finalSim.submitEmitters(event.emitters);
      this._finalSim.submitInfluences(event.influences);
      this._finalSim.submitScalarFields(event.scalarFields);
      job.eventIndex += 1;
    }
  }

  _renderFinalPass(sourceParams) {
    if (!this._finalSim || !this._replayInteractionEvents.length || !this._replayStepHistory.length) {
      const committed = this._commitPreviewToLayer({ composite: true });
      this._finishSettledStroke();
      return committed;
    }
    if (!this._updateSimulator('final', sourceParams)) return false;
    this._finalSim.clearState();
    this._finalPassJob = {
      replayIndex: 0,
      replayTime: 0,
      eventIndex: 0,
      settleRemaining: FLUID3D_FINAL_PASS_SETTLING_STEPS,
      stage: 'replay',
    };
    this._flushFinalPassEvents(this._finalPassJob);
    return true;
  }

  _advanceFinalPass() {
    const job = this._finalPassJob;
    if (!job || !this._finalSim) return false;
    if (job.stage === 'committing') return true;

    if (job.stage === 'replay') {
      let replayStepsThisFrame = 0;
      while (job.replayIndex < this._replayStepHistory.length && replayStepsThisFrame < FLUID3D_FINAL_PASS_REPLAY_STEPS_PER_FRAME) {
        const dt = this._replayStepHistory[job.replayIndex];
        this._finalSim.step(dt, { captureStats: FLUID3D_FINAL_PASS_CAPTURE_STATS });
        job.replayTime += dt;
        job.replayIndex += 1;
        replayStepsThisFrame += 1;
        this._flushFinalPassEvents(job);
      }
      if (job.replayIndex < this._replayStepHistory.length) return true;
      job.stage = 'settle';
    }

    if (job.stage === 'settle') {
      let settleStepsThisFrame = 0;
      while (job.settleRemaining > 0 && settleStepsThisFrame < FLUID3D_FINAL_PASS_SETTLE_STEPS_PER_FRAME) {
        this._finalSim.step(FLUID_TIMESTEP_60FPS, { captureStats: FLUID3D_FINAL_PASS_CAPTURE_STATS });
        job.settleRemaining -= 1;
        settleStepsThisFrame += 1;
      }
      if (job.settleRemaining > 0) return true;
      job.stage = 'render';
    }

    if (job.stage === 'render') {
      const rendered = this._renderPreviewFromSim(this._finalSim);
      if (!rendered) {
        this._finishSettledStroke();
        return false;
      }
      job.stage = 'committing';
      if (this.renderer.device?.queue?.onSubmittedWorkDone) {
        this.renderer.device.queue.onSubmittedWorkDone().then(() => {
          this._commitAndFinishSettledStroke();
        }).catch(() => {
          this._commitAndFinishSettledStroke();
        });
        return true;
      }
      this._commitAndFinishSettledStroke();
      return true;
    }

    return true;
  }

  _step(elapsed) {
    if (!this._ready || !this.sim) return;
    if (this._finalPassJob) {
      this._advanceFinalPass();
      if (!this._active) {
        this._lastFrameElapsed = elapsed;
        return;
      }
    }
    const currentParams = this.app.getP();
    if (!this._updateSimulator('preview', currentParams)) return;
    const external = this._consumeExternalInteractions();
    if (external.emitters.length) this.sim.submitEmitters(external.emitters);
    if (external.influences.length) this.sim.submitInfluences(external.influences);
    if (external.scalarFields.length) this.sim.submitScalarFields(external.scalarFields);
    if (this._usesAdaptiveReplay(currentParams)) this._recordInteractionEvent(external.emitters, external.influences, external.scalarFields);
    if (this._active && this._lastPoint) {
      const textureGuidance = this._createTextureGuidancePayload(
        this._lastPoint.x,
        this._lastPoint.y,
        null,
        currentParams,
        FLUID3D_TEXTURE_GUIDE_FRAME_SAMPLES,
      );
      if (textureGuidance.influences.length) this.sim.submitInfluences(textureGuidance.influences);
      if (textureGuidance.scalarFields.length) this.sim.submitScalarFields(textureGuidance.scalarFields);
      if (this._usesAdaptiveReplay(currentParams)) this._recordInteractionEvent([], textureGuidance.influences, textureGuidance.scalarFields);
    }
    const prevCount = this.sim.getParticleCount();
    if (!this._active && prevCount <= 0) {
      this._lastFrameElapsed = elapsed;
      return;
    }
    let dt = this._lastFrameElapsed == null ? FLUID_TIMESTEP_60FPS : elapsed - this._lastFrameElapsed;
    this._lastFrameElapsed = elapsed;
    if (!Number.isFinite(dt) || dt <= 0) dt = FLUID_TIMESTEP_60FPS;
    dt = Math.min(dt, 0.05);
    const stepCount = this._active ? FLUID3D_ACTIVE_SUBSTEPS : 1;
    const stepDt = dt / stepCount;
    for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
      this.sim.step(stepDt);
    }
    const nextCount = this.sim.getParticleCount();
    if (this._usesAdaptiveReplay(currentParams) && (this._active || prevCount > 0 || nextCount > 0)) {
      for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
        this._replayStepHistory.push(stepDt);
        this._replayTime += stepDt;
      }
    }
    if (this._active || prevCount > 0 || nextCount > 0) {
      this._renderPreviewFromSim(this.sim);
    }
    if (!this._active && prevCount > 0 && nextCount <= 0) {
      if (this._usesAdaptiveReplay(currentParams)) this._renderFinalPass(currentParams);
      else {
        this._commitPreviewToLayer({ composite: true });
        this._finishSettledStroke();
      }
    }
  }

  drawOverlay(ctx, p) {
    if (this._usingLegacyFallback()) return this._legacyFallback.drawOverlay?.(ctx, p);
    if (!p.fluid3dShowField || !this.sim) return;
    const particles = this.sim.getParticles();
    ctx.save();
    ctx.fillStyle = 'rgba(114, 196, 255, 0.38)';
    for (const particle of particles.slice(0, 900)) {
      ctx.globalAlpha = Math.max(0.08, Math.min(0.6, particle.thickness * 0.8 + particle.pressure * 0.25));
      ctx.fillRect(particle.x - 1, particle.y - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(114, 196, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.app.leaderX, this.app.leaderY, p.fluid3dBrushRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  getStatusInfo() {
    if (this._usingLegacyFallback()) return `3D Fluid | fallback ${this._legacyFallback.getStatusInfo()}`;
    const stats = this.sim?.getDebugState?.()?.stats || {};
    return `3D Fluid | sim:webgpu render:${this.renderer?.ready ? 'webgpu' : 'legacy'} cells:${stats.activeCells ?? 0} occ:${((stats.occupiedRatio || 0) * 100).toFixed(1)}%`;
  }

  deactivate() {
    if (this._usingLegacyFallback()) return this._legacyFallback.deactivate();
    this._active = false;
    this._lastPoint = null;
    this._lastFrameElapsed = null;
    this._commitPreviewToLayer({ composite: false });
    this._clearPreview({ composite: true });
    this._strokeLayer = null;
    this._finalPassJob = null;
    this.sim?.clearState?.();
    this._finalSim?.clearState?.();
    this._resetReplayCapture();
  }
}

export class FluidBrush {
  constructor(app) {
    this.app = app;
    this.sim = null;
    this._finalSim = null;
    this._ready = false;
    this._initPromise = null;
    this._active = false;
    this._lastPoint = null;
    this._lastFrameElapsed = null;
    this._strokeLayer = null;
    this._maskCanvas = document.createElement('canvas');
    this._maskCtx = this._maskCanvas.getContext('2d', { willReadFrequently: true });
    this._frameCanvas = document.createElement('canvas');
    this._frameCtx = this._frameCanvas.getContext('2d', { willReadFrequently: true });
    this._strokeBaseCanvas = document.createElement('canvas');
    this._strokeBaseCtx = this._strokeBaseCanvas.getContext('2d', { willReadFrequently: true });
    this._maskSynced = false;
    this._finalPassJob = null;
    this._replaySeedEvents = [];
    this._replayStepHistory = [];
    this._replayTime = 0;
  }

  async init({ force = false } = {}) {
    if (force) {
      this.sim?.destroy?.();
      this._finalSim?.destroy?.();
      this.sim = null;
      this._finalSim = null;
      this._ready = false;
      this._initPromise = null;
      this._active = false;
      this._lastPoint = null;
      this._lastFrameElapsed = null;
      this._strokeLayer = null;
      this._maskSynced = false;
      this._finalPassJob = null;
      this._resetReplayCapture();
    }
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      try {
        this.sim = await FluidSim.create(this.app.W || 800, this.app.H || 600, this._solverParams());
        this._finalSim = new FluidSim(this.sim._mod, this.app.W || 800, this.app.H || 600, this._solverParams('final'));
        this._finalSim.updateParams(this._solverParams('final'));
        this._ready = true;
        this._syncMask();
      } catch (error) {
        this._ready = false;
        console.error('FluidBrush: WASM init failed —', error);
      }
      return this.sim;
    })();
    return this._initPromise;
  }

  _resetSimulatorState(sim = this.sim) {
    if (!sim) return;
    sim.clearParticles();
  }

  _resetAllSimulatorStates() {
    this._resetSimulatorState(this.sim);
    this._resetSimulatorState(this._finalSim);
  }

  onDown(x, y, pressure) {
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }
    if (!this._ready || !this.sim) return;
    if (this._finalPassJob) {
      this._finalPassJob = null;
      this._resetSimulatorState(this._finalSim);
      this._resetReplayCapture();
    }
    const p = this.app.getP();
    this._active = true;
    this._strokeLayer = this.app.getActiveLayer();
    this._resetAllSimulatorStates();
    this._resetReplayCapture();
    this._captureStrokeBase();
    this._lastPoint = { x, y };
    this._lastFrameElapsed = null;
    this._updateSimulator();
    this._seedAt(x, y, pressure, null, p.lbmSpawnCount, p);
    this._step(0);
  }

  onMove(x, y, pressure) {
    if (!this._active || !this._ready || !this.sim) return;
    const previousPoint = this._lastPoint;
    if (!previousPoint) {
      this._lastPoint = { x, y };
      return;
    }
    const p = this.app.getP();
    const dx = x - previousPoint.x;
    const dy = y - previousPoint.y;
    const distance = Math.hypot(dx, dy);
    const step = Math.max(2, p.lbmBrushRadius * 0.3);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let index = 1; index <= count; index += 1) {
      const t = index / count;
      this._seedAt(
        previousPoint.x + dx * t,
        previousPoint.y + dy * t,
        pressure,
        { x: previousPoint.x + dx * ((index - 1) / count), y: previousPoint.y + dy * ((index - 1) / count) },
        Math.max(4, Math.round(p.lbmSpawnCount * FLUID_MOVE_SEED_RATIO)),
        p,
      );
    }
    this._lastPoint = { x, y };
  }

  onUp(x, y) {
    this._active = false;
    this._lastPoint = null;
  }

  onFrame(elapsed) {
    this._step(elapsed);
  }

  onHoverFrame(elapsed) {
    this._step(elapsed);
  }

  taperFrame() {}

  _previewResolutionScale(p) {
    const finalScale = Number(p?.lbmResolutionScale) || 1;
    if (!p?.lbmFirstPassPreview || finalScale <= 0.75) return finalScale;
    return Math.max(0.5, Math.min(finalScale, finalScale * 0.55));
  }

  _usesFastFirstPass(p = this.app.getP()) {
    return !!(p?.lbmFirstPassPreview && this._previewResolutionScale(p) < ((Number(p?.lbmResolutionScale) || 1) - 0.05));
  }

  _solverParams(pass = 'preview', sourceParams = this.app.getP()) {
    const p = sourceParams;
    return {
      particleRadius: p.lbmParticleRadius,
      viscosity: p.lbmViscosity,
      density: p.lbmDensity,
      surfaceTension: p.lbmSurfaceTension,
      timeStep: p.lbmTimeStep,
      substeps: p.lbmSubsteps,
      motionDecay: p.lbmMotionDecay,
      stopSpeed: p.lbmStopSpeed,
      pigmentCarry: p.lbmPigmentCarry,
      pigmentRetention: p.lbmPigmentRetention,
      resolutionScale: pass === 'final' ? p.lbmResolutionScale : this._previewResolutionScale(p),
      fluidScale: p.lbmFluidScale,
      renderMode: p.lbmRenderMode,
      simulationType: 'lbm',
    };
  }

  _updateSimulator(pass = 'preview', sourceParams = this.app.getP()) {
    const sim = pass === 'final' ? this._finalSim : this.sim;
    if (!this._ready || !sim) return false;
    const needsMaskSync = this._maskCanvas.width !== this.app.W || this._maskCanvas.height !== this.app.H || !this._maskSynced;
    sim.setDisplaySize(this.app.W || 1, this.app.H || 1);
    sim.updateParams(this._solverParams(pass, sourceParams));
    if (needsMaskSync) this._syncMask();
    return true;
  }

  _syncMask() {
    if (!this.sim && !this._finalSim) return;
    if (this._maskCanvas.width !== this.app.W || this._maskCanvas.height !== this.app.H) {
      this._maskCanvas.width = this.app.W;
      this._maskCanvas.height = this.app.H;
    }
    this._maskCtx.clearRect(0, 0, this._maskCanvas.width, this._maskCanvas.height);
    const mask = this._maskCtx.getImageData(0, 0, this._maskCanvas.width, this._maskCanvas.height);
    this.sim?.setMask(mask);
    this._finalSim?.setMask(mask);
    this._maskSynced = true;
  }

  _resetReplayCapture() {
    this._replaySeedEvents = [];
    this._replayStepHistory = [];
    this._replayTime = 0;
  }

  _recordSeedParticles(particles) {
    this._replaySeedEvents.push({
      time: this._replayTime,
      particles: particles.map(particle => ({ ...particle })),
    });
  }

  _flushFinalPassSeeds(job) {
    while (job.seedIndex < this._replaySeedEvents.length && this._replaySeedEvents[job.seedIndex].time <= job.replayTime + 1e-6) {
      this._finalSim.addParticles(this._replaySeedEvents[job.seedIndex].particles);
      job.seedIndex += 1;
    }
  }

  _captureStrokeBase() {
    const layer = this._strokeLayer;
    if (!layer) return;
    if (this._strokeBaseCanvas.width !== layer.canvas.width || this._strokeBaseCanvas.height !== layer.canvas.height) {
      this._strokeBaseCanvas.width = layer.canvas.width;
      this._strokeBaseCanvas.height = layer.canvas.height;
    }
    this._strokeBaseCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._strokeBaseCtx.clearRect(0, 0, this._strokeBaseCanvas.width, this._strokeBaseCanvas.height);
    this._strokeBaseCtx.drawImage(layer.canvas, 0, 0, layer.canvas.width, layer.canvas.height);
  }

  _seedAt(x, y, pressure, previousPoint, amount, p) {
    if (!this._active) return;
    if (!this._updateSimulator('preview', p)) return;
    p = p ?? this.app.getP();
    const profile = _makeFluidSpawnProfile(x, y, previousPoint);
    const scaledBrushRadius = p.lbmBrushRadius * (p.pressureSize ? (0.35 + pressure * 0.65) : 1);
    const scaledCount = Math.max(1, Math.round(amount * (0.4 + pressure * 0.6)));
    const particles = _makeFluidSeeds(
      x,
      y,
      scaledCount,
      p.color,
      { ...p, lbmBrushRadius: scaledBrushRadius },
      profile,
    );
    this.sim.addParticles(particles);
    if (this._usesFastFirstPass(p)) this._recordSeedParticles(particles);
  }

  _step(elapsed) {
    if (this._finalPassJob) {
      this._advanceFinalPass();
      if (!this._active) {
        this._lastFrameElapsed = elapsed;
        return;
      }
    }
    const currentParams = this.app.getP();
    if (!this._updateSimulator('preview', currentParams)) return;
    const prevCount = this.sim.getParticleCount();
    if (!this._active && prevCount <= 0) {
      this._lastFrameElapsed = elapsed;
      return;
    }
    let dt = this._lastFrameElapsed == null ? FLUID_TIMESTEP_60FPS : elapsed - this._lastFrameElapsed;
    this._lastFrameElapsed = elapsed;
    if (!Number.isFinite(dt) || dt <= 0) dt = FLUID_TIMESTEP_60FPS;
    dt = Math.min(dt, 0.05);
    this.sim.step(dt);
    const nextCount = this.sim.getParticleCount();
    if (this._usesFastFirstPass(currentParams) && (this._active || prevCount > 0 || nextCount > 0)) {
      this._replayStepHistory.push(dt);
      this._replayTime += dt;
    }
    if (this._active || prevCount > 0 || nextCount > 0) {
      this._depositFrameFromSim(this.sim);
    }
    if (!this._active && prevCount > 0 && nextCount <= 0) {
      if (this._usesFastFirstPass(currentParams)) this._renderFinalPass(currentParams);
      else this._resetReplayCapture();
      this._resetSimulatorState();
    }
  }

  _renderFinalPass(sourceParams) {
    if (!this._finalSim || !this._replaySeedEvents.length || !this._replayStepHistory.length) return;
    if (!this._updateSimulator('final', sourceParams)) return;
    this._finalSim.clearParticles();
    this._finalPassJob = {
      replayIndex: 0,
      replayTime: 0,
      seedIndex: 0,
      settleRemaining: FLUID_FINAL_PASS_MAX_SETTLING_STEPS,
      stage: 'replay',
    };
    this._flushFinalPassSeeds(this._finalPassJob);
  }

  _advanceFinalPass() {
    const job = this._finalPassJob;
    if (!job || !this._finalSim) return false;

    if (job.stage === 'replay') {
      let replayStepsThisFrame = 0;
      while (job.replayIndex < this._replayStepHistory.length && replayStepsThisFrame < FLUID_FINAL_PASS_REPLAY_STEPS_PER_FRAME) {
        const dt = this._replayStepHistory[job.replayIndex];
        this._finalSim.step(dt);
        job.replayTime += dt;
        job.replayIndex += 1;
        replayStepsThisFrame += 1;
        this._flushFinalPassSeeds(job);
      }
      this._depositFrameFromSim(this._finalSim);
      if (job.replayIndex < this._replayStepHistory.length) return true;
      job.stage = 'settle';
    }

    if (job.stage === 'settle') {
      let settleStepsThisFrame = 0;
      while (job.settleRemaining > 0 && this._finalSim.getParticleCount() > 0 && settleStepsThisFrame < FLUID_FINAL_PASS_SETTLE_STEPS_PER_FRAME) {
        this._finalSim.step(FLUID_TIMESTEP_60FPS);
        job.settleRemaining -= 1;
        settleStepsThisFrame += 1;
      }
      this._depositFrameFromSim(this._finalSim);
      if (job.settleRemaining > 0 && this._finalSim.getParticleCount() > 0) return true;
    }

    this._finalPassJob = null;
    this._resetSimulatorState(this._finalSim);
    this._resetReplayCapture();
    return true;
  }

  _depositFrameFromSim(sim) {
    if (this._strokeLayer && !this.app.layers.includes(this._strokeLayer)) {
      this._strokeLayer = null;
      return;
    }
    const layer = this._strokeLayer || this.app.getActiveLayer();
    if (!layer) return;
    if (!this._strokeBaseCanvas.width || !this._strokeBaseCanvas.height) {
      this._captureStrokeBase();
    }
    const frame = sim.readPixels();
    if (!frame.width || !frame.height) return;
    if (this._frameCanvas.width !== frame.width || this._frameCanvas.height !== frame.height) {
      this._frameCanvas.width = frame.width;
      this._frameCanvas.height = frame.height;
    }
    this._frameCtx.putImageData(new ImageData(frame.buffer, frame.width, frame.height), 0, 0);
    layer.ctx.save();
    // Rebuild from the captured pre-stroke layer each frame so the full fluid
    // render doesn't accumulate and create heavier-looking artifacts that read
    // like fresh paint injection after touch-up. Use backing-canvas dimensions
    // here so the redraw stays aligned with DPR-scaled pointer coordinates.
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    layer.ctx.drawImage(this._strokeBaseCanvas, 0, 0, layer.canvas.width, layer.canvas.height);
    layer.ctx.globalCompositeOperation = layer.alphaLock ? 'source-atop' : 'source-over';
    layer.ctx.drawImage(this._frameCanvas, 0, 0, layer.canvas.width, layer.canvas.height);
    layer.ctx.restore();
    layer.dirty = true;
    this.app.compositeAllLayers();
  }

  drawOverlay(ctx, p) {
    if (!p.lbmShowFlow || !this.sim) return;
    const particles = this.sim.getParticles();
    ctx.save();
    ctx.fillStyle = 'rgba(120, 190, 255, 0.45)';
    for (const particle of particles) {
      ctx.globalAlpha = Math.max(0.08, Math.min(0.55, Math.hypot(particle.vx, particle.vy) * 0.18));
      ctx.fillRect(particle.x - 1, particle.y - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(120, 190, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.app.leaderX, this.app.leaderY, p.lbmBrushRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  getStatusInfo() {
    return `LBM | Cells: ${this.sim?.getParticleCount?.() ?? 0}`;
  }

  deactivate() {
    this._active = false;
    this._lastPoint = null;
    this._lastFrameElapsed = null;
    this._finalPassJob = null;
    this._strokeLayer = null;
    this._resetAllSimulatorStates();
    this._resetReplayCapture();
  }
}

// =============================================================================
// ERASER BRUSH — Same as simple, but uses destination-out composite
// =============================================================================

export class EraserBrush {
  constructor(app) {
    this.app = app;
    this._inner = new SimpleBrush(app);
    this._inner._getBatchCompositeOperation = () => 'destination-out';
    this._inner._getBatchStampColor = () => '#000000';
    // Override stamp to use destination-out
    this._inner._stamp = (x, y, pressure) => {
      const p = this.app.getP();
      const layer = this.app.getActiveLayer();
      // Eraser always stamps directly to layer (flat stroke not meaningful for destination-out)
      const ctx = layer.ctx;
      let sz = p.stampSize;
      let op = p.stampOpacity;
      if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
      if (p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
      op = Math.min(op, 1);

      ctx.globalCompositeOperation = 'destination-out';
      this.app.symStamp(ctx, x, y, sz, '#000', op);
      ctx.globalCompositeOperation = 'source-over';
      this.app.strokeFrame++;
    };
  }

  onDown(x, y, pr) {
    this._inner.onDown(x, y, pr);
    // Flat stroke does not apply to eraser (destination-out + flat compositing = no visible erase)
    this._inner._flatActive = false;
  }
  onMove(x, y, pr) { this._inner.onMove(x, y, pr); }
  onUp(x, y) { this._inner.onUp(x, y); }
  onFrame(e) { this._inner.onFrame(e); }
  taperFrame(t, p) { this._inner.taperFrame(t, p); }
  drawOverlay(ctx, p) { this._inner.drawOverlay(ctx, p); }
  getStatusInfo() { return this._inner.getStatusInfo().replace(/^Simple/, 'Eraser'); }
  deactivate() { this._inner.deactivate(); }
}

const MOTION_PATH_BRUSH_BASE_SPEED = 90;
const MOTION_PATH_BRUSH_DELTA_CAP = 1 / 24;

function _sampleCompiledMotionTrack(track, distanceAlongPath) {
  if (!track?.points?.length) return null;
  if (track.points.length === 1) {
    return {
      x: track.points[0].x,
      y: track.points[0].y,
      angle: 0,
      stampScale: Number.isFinite(track.points[0]?.stampScale) ? track.points[0].stampScale : 1,
      speedScale: Number.isFinite(track.points[0]?.speedScale) ? track.points[0].speedScale : 1,
    };
  }
  const totalLength = Math.max(track.totalLength || 0, 1e-6);
  const distance = track.closed
    ? ((distanceAlongPath % totalLength) + totalLength) % totalLength
    : _clamp(distanceAlongPath, 0, totalLength);
  let remaining = distance;
  for (let i = 1; i < track.points.length; i++) {
    const length = track.segmentLengths?.[i - 1] || 0;
    if (remaining <= length || i === track.points.length - 1) {
      const a = track.points[i - 1];
      const b = track.points[i];
      const t = length <= 1e-6 ? 0 : remaining / length;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        stampScale: (Number.isFinite(a?.stampScale) ? a.stampScale : 1)
          + (((Number.isFinite(b?.stampScale) ? b.stampScale : 1) - (Number.isFinite(a?.stampScale) ? a.stampScale : 1)) * t),
        speedScale: (Number.isFinite(a?.speedScale) ? a.speedScale : 1)
          + (((Number.isFinite(b?.speedScale) ? b.speedScale : 1) - (Number.isFinite(a?.speedScale) ? a.speedScale : 1)) * t),
      };
    }
    remaining -= length;
  }
  const last = track.points[track.points.length - 1];
  const prev = track.points[track.points.length - 2] || last;
  return {
    x: last.x,
    y: last.y,
    angle: Math.atan2(last.y - prev.y, last.x - prev.x),
    stampScale: Number.isFinite(last?.stampScale) ? last.stampScale : 1,
    speedScale: Number.isFinite(last?.speedScale) ? last.speedScale : 1,
  };
}

function _advanceMotionTrackDistance(agent, track, deltaDistance) {
  const totalLength = Math.max(track?.totalLength || 0, 1e-6);
  const direction = agent.direction === -1 ? -1 : 1;
  if (track?.closed) {
    const nextDistance = agent.distance + (deltaDistance * direction);
    agent.wrappedStep = nextDistance >= totalLength || nextDistance < 0;
    agent.distance = ((nextDistance % totalLength) + totalLength) % totalLength;
    agent.direction = direction;
    agent.discontinuousStep = false;
    agent.respawnSnapToTrack = false;
    if (!Number.isFinite(agent.respawnOffsetBlend)) agent.respawnOffsetBlend = 1;
    agent.stopped = false;
    return;
  }
  agent.wrappedStep = false;
  const behavior = ['bounce', 'restart', 'random', 'stop', 'reverse'].includes(agent.endBehavior) ? agent.endBehavior : 'restart';
  if (behavior === 'stop') {
    const nextDistance = agent.distance + (deltaDistance * direction);
    agent.distance = _clamp(nextDistance, 0, totalLength);
    agent.direction = direction;
    agent.stopped = nextDistance >= totalLength || nextDistance <= 0;
    agent.discontinuousStep = false;
    agent.respawnSnapToTrack = false;
    if (!Number.isFinite(agent.respawnOffsetBlend)) agent.respawnOffsetBlend = 1;
    return;
  }
  if (behavior === 'reverse') {
    const nextDistance = agent.distance + (deltaDistance * direction);
    if (nextDistance > totalLength) {
      agent.distance = totalLength;
      agent.direction = -1;
      agent.discontinuousStep = true;
      agent.respawnSnapToTrack = true;
      agent.respawnOffsetBlend = 0;
    } else if (nextDistance < 0) {
      agent.distance = 0;
      agent.direction = 1;
      agent.discontinuousStep = true;
      agent.respawnSnapToTrack = true;
      agent.respawnOffsetBlend = 0;
    } else {
      agent.distance = nextDistance;
      agent.discontinuousStep = false;
      agent.respawnSnapToTrack = false;
      if (!Number.isFinite(agent.respawnOffsetBlend)) agent.respawnOffsetBlend = 1;
    }
    agent.stopped = false;
    return;
  }
  if (behavior === 'bounce') {
    let distance = agent.distance + (deltaDistance * direction);
    let nextDirection = direction;
    while (distance < 0 || distance > totalLength) {
      if (distance > totalLength) {
        distance = totalLength - (distance - totalLength);
        nextDirection = -1;
      } else {
        distance = -distance;
        nextDirection = 1;
      }
    }
    agent.distance = _clamp(distance, 0, totalLength);
    agent.direction = nextDirection;
    agent.discontinuousStep = false;
    agent.respawnSnapToTrack = false;
    if (!Number.isFinite(agent.respawnOffsetBlend)) agent.respawnOffsetBlend = 1;
    agent.stopped = false;
    return;
  }
  const nextDistance = agent.distance + (deltaDistance * direction);
  if (nextDistance > totalLength || nextDistance < 0) {
    agent.discontinuousStep = true;
    agent.respawnSnapToTrack = true;
    agent.respawnOffsetBlend = 0;
    agent.distance = behavior === 'random'
      ? Math.random() * totalLength
      : ((nextDistance % totalLength) + totalLength) % totalLength;
  } else {
    agent.discontinuousStep = false;
    agent.respawnSnapToTrack = false;
    if (!Number.isFinite(agent.respawnOffsetBlend)) agent.respawnOffsetBlend = 1;
    agent.distance = nextDistance;
  }
  agent.direction = direction;
  agent.stopped = false;
}

export class MotionPathBrush {
  constructor(app) {
    this.app = app;
    this.renderer = createBoidStampRenderer();
    this._active = false;
    this._originX = 0;
    this._originY = 0;
    this._pressure = 1;
    this._compiledGraph = null;
    this._compiledGraphKey = '';
    this._runtimeAgents = [];
    this._lastElapsed = 0;
    this._renderBackend = 'legacy';
    this._renderLegacyReason = 'compatibility check pending';
    this._gpuFailureCount = 0;
    this._gpuDisabledReason = '';
    this._rendererInitPromise = null;
    this._rendererChainPatched = false;
    this._gpuPreviewActive = false;
    this._gpuPreviewLayer = null;
    this._gpuPreviewRenderer = null;
    this._overlayPoints = [];
    this._graphAngle = 0;
    this._hasGraphAngle = false;
    this._lastInputX = 0;
    this._lastInputY = 0;
    this._simulationData = null;
    this._simulationSpawnConfig = null;
    _ensureProceduralStampRendererInit(this);
  }

  _updateGraphAngle(p, x = this._lastInputX, y = this._lastInputY, { hasPathSample = false, fallbackAngle = this._graphAngle } = {}) {
    let pathAngle = null;
    if (hasPathSample) {
      const dx = x - this._lastInputX;
      const dy = y - this._lastInputY;
      if (Math.hypot(dx, dy) > 0.001) pathAngle = Math.atan2(dy, dx);
    }
    const targetAngle = this.app.resolveStrokeAngle(pathAngle, {
      mode: p.strokeAngleMode,
      fallbackAngle,
    });
    if (!this._hasGraphAngle) {
      this._graphAngle = targetAngle;
      this._hasGraphAngle = true;
    } else {
      const alpha = p.motionPathAngleSmoothing > 0
        ? 1 - p.motionPathAngleSmoothing * MAX_SMOOTH_DAMP
        : 1;
      const diff = ((targetAngle - this._graphAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this._graphAngle += diff * alpha;
    }
    this._lastInputX = x;
    this._lastInputY = y;
    return this._graphAngle;
  }

  _smoothAgentWorldPoint(agent, prevTargetX, prevTargetY, targetX, targetY, p) {
    const smoothing = _clamp(p.motionPathMovementSmoothing || 0, 0, 1);
    if (
      !Number.isFinite(agent.smoothX)
      || !Number.isFinite(agent.smoothY)
      || !Number.isFinite(prevTargetX)
      || !Number.isFinite(prevTargetY)
      || smoothing <= 0
      || agent.discontinuousStep
      || agent.wrappedStep
    ) {
      agent.smoothX = targetX;
      agent.smoothY = targetY;
      return { x: targetX, y: targetY };
    }
    const alpha = 1 - smoothing * MAX_SMOOTH_DAMP;
    const candidateX = agent.smoothX + (targetX - agent.smoothX) * alpha;
    const candidateY = agent.smoothY + (targetY - agent.smoothY) * alpha;
    const clamped = _closestPointOnSegment(candidateX, candidateY, prevTargetX, prevTargetY, targetX, targetY);
    agent.smoothX = clamped.x;
    agent.smoothY = clamped.y;
    return { x: agent.smoothX, y: agent.smoothY };
  }

  _resetRuntime(recompile = false) {
    this._runtimeAgents = [];
    this._overlayPoints = [];
    this._lastElapsed = 0;
    this._hasGraphAngle = false;
    if (recompile) {
      this._compiledGraph = null;
      this._compiledGraphKey = '';
    }
  }

  _ensureCompiledGraph(p) {
    const compiled = this.app._compileActiveMotionPathGraph?.(p) || { documentId: null, updatedAt: 0, paths: [], agents: [] };
    const key = `${compiled.documentId || 0}:${compiled.updatedAt || 0}:${p.motionPathAgentCount || 0}:${Math.round((p.motionPathPathSmoothing || 0) * 1000)}`;
    if (this._compiledGraphKey === key && this._compiledGraph) return this._compiledGraph;
    this._compiledGraphKey = key;
    this._compiledGraph = compiled;
    this._runtimeAgents = compiled.agents.map((agent, index, list) => ({
      pathIndex: agent.pathIndex,
      pathId: agent.pathId,
      distance: agent.distance || 0,
      speedMultiplier: agent.speedMultiplier || 1,
      startMode: agent.startMode === 'random' ? 'random' : 'spread',
      endBehavior: ['bounce', 'restart', 'random', 'stop', 'reverse'].includes(agent.endBehavior) ? agent.endBehavior : 'restart',
      speed: 0,
      direction: agent.direction === -1 ? -1 : 1,
      stopped: false,
      discontinuousStep: false,
      wrappedStep: false,
      respawnSnapToTrack: false,
      respawnOffsetBlend: 1,
      lateralOffset: list.length <= 1 ? 0 : ((index / Math.max(1, list.length - 1)) - 0.5) * 2,
      spacingDistance: Number.NaN,
      spacingX: Number.NaN,
      spacingY: Number.NaN,
      spacingSize: Number.NaN,
      smoothX: Number.NaN,
      smoothY: Number.NaN,
      prevX: Number.NaN,
      prevY: Number.NaN,
      prevSize: Number.NaN,
    }));
    this._overlayPoints = [];
    return this._compiledGraph;
  }

  _rerollRandomStartAgents(compiled = this._compiledGraph) {
    if (!compiled?.paths?.length || !this._runtimeAgents.length) return;
    for (const agent of this._runtimeAgents) {
      if (agent.startMode !== 'random') continue;
      const path = compiled.paths[agent.pathIndex];
      if (!path) continue;
      const totalLength = Math.max(0, path.totalLength || 0);
      const baseDistance = totalLength > 0 ? Math.random() * totalLength : 0;
      agent.distance = !path.closed && agent.direction === -1
        ? Math.max(0, totalLength - baseDistance)
        : baseDistance;
      agent.speed = 0;
      agent.stopped = false;
      agent.discontinuousStep = false;
      agent.wrappedStep = false;
      agent.respawnSnapToTrack = true;
      agent.respawnOffsetBlend = 0;
      agent.spacingDistance = Number.NaN;
      agent.spacingX = Number.NaN;
      agent.spacingY = Number.NaN;
      agent.spacingSize = Number.NaN;
      agent.smoothX = Number.NaN;
      agent.smoothY = Number.NaN;
      agent.prevX = Number.NaN;
      agent.prevY = Number.NaN;
      agent.prevSize = Number.NaN;
    }
  }

  _cpuFallbackStamp(points, p) {
    const layer = this.app.getActiveLayer();
    if (!layer?.ctx) return;
    let baseSize = p.stampSize;
    if (p.pressureSize) baseSize *= (0.3 + 0.7 * this._pressure);
    let opacity = p.stampOpacity;
    if (p.pressureOpacity) opacity *= (0.3 + 0.7 * this._pressure);
    opacity = Math.min(opacity, 1);
    for (const point of points) {
      this.app.symStamp(layer.ctx, point.x, point.y, point.size || baseSize, p.color, opacity);
    }
    layer.dirty = true;
  }


  configureSimulation(data, p = this.app.getP()) {
    this._simulationData = data || null;
    const spawns = Array.isArray(data?.spawns) ? data.spawns.filter(spawn => spawn?.enabled !== false) : [];
    const spawn = spawns[0] || (Array.isArray(data?.spawns) ? data.spawns[0] : null);
    this._simulationSpawnConfig = spawn ? this.app._resolveSimulationSpawnConfig(spawn, p) || null : null;
  }

  _getRuntimeParams(base) {
    if (!this.app?.simulation?.enabled || !this._simulationSpawnConfig) return base;
    const cfg = this._simulationSpawnConfig;
    return {
      ...base,
      color: cfg.color || base.color,
      stampOpacity: Number.isFinite(cfg.opacity) ? cfg.opacity : base.stampOpacity,
      stampSize: Number.isFinite(cfg.stampSize) ? cfg.stampSize : base.stampSize,
      stampSeparation: Number.isFinite(cfg.stampSeparation) ? cfg.stampSeparation : base.stampSeparation,
      smudge: Number.isFinite(cfg.smudge) ? cfg.smudge : base.smudge,
      hueVar: Number.isFinite(cfg.hueVar) ? cfg.hueVar : base.hueVar,
      satVar: Number.isFinite(cfg.satVar) ? cfg.satVar : base.satVar,
      litVar: Number.isFinite(cfg.litVar) ? cfg.litVar : base.litVar,
      sizeVar: Number.isFinite(cfg.sizeVar) ? cfg.sizeVar : base.sizeVar,
      opacityVar: Number.isFinite(cfg.opacityVar) ? cfg.opacityVar : base.opacityVar,
      speedVar: Number.isFinite(cfg.speedVar) ? cfg.speedVar : base.speedVar,
    };
  }

  _cpuRenderRibbonSegments(segments, p) {
    const layer = this.app.getActiveLayer();
    if (!layer?.ctx || !segments?.length) return;
    const ctx = layer.ctx;
    let width = p.stampSize;
    if (p.pressureSize) width *= (0.3 + 0.7 * this._pressure);
    width = Math.max(0.5, width);
    let opacity = p.stampOpacity;
    if (p.pressureOpacity) opacity *= (0.3 + 0.7 * this._pressure);
    opacity = Math.min(opacity, 1);
    const useAlphaLock = layer.alphaLock;
    const useStampImage = this.app.hasActiveStampImage?.(p);
    const support = useStampImage ? _getProceduralBatchRendererSupport(this, p, false) : { ok: false, reason: '' };
    const offsets = this.app.tilingMode
      ? [
          [0, 0],
          [this.app.W, 0],
          [-this.app.W, 0],
          [0, this.app.H],
          [0, -this.app.H],
          [this.app.W, this.app.H],
          [this.app.W, -this.app.H],
          [-this.app.W, this.app.H],
          [-this.app.W, -this.app.H],
        ]
      : [[0, 0]];

    if (useStampImage && support.ok) {
      const color = hexToRGB(p.color);
      const instances = new StampInstanceBuffer(Math.max(32, segments.length * 8));
      for (const segment of segments) {
        if (segment.kind === 'dot') {
          _emitBatchStampInstances(this.app, instances, p, segment.x, segment.y, segment.size || width, color, opacity, 0);
          continue;
        }

        const dx = segment.x1 - segment.x0;
        const dy = segment.y1 - segment.y0;
        const travel = Math.hypot(dx, dy);
        const rotation = Math.atan2(dy, dx);
        const startSize = segment.size0 || width;
        const endSize = segment.size1 || startSize;
        const stampStep = Math.max(0.35, Math.max(startSize, endSize) * 0.18);
        const steps = Math.max(1, Math.ceil(travel / stampStep));
        for (let step = 1; step <= steps; step++) {
          const t = step / steps;
          const x = segment.x0 + dx * t;
          const y = segment.y0 + dy * t;
          const size = startSize + ((endSize - startSize) * t);
          _emitBatchStampInstances(this.app, instances, p, x, y, size, color, opacity, rotation);
        }
      }

      if (instances.count > 0) {
        const batch = { instances: instances.finish(), count: instances.count };
        if (_renderProceduralBatchToTarget(this, ctx, batch, p, { allowAlphaLock: true })) {
          layer.dirty = true;
          this.app.compositeAllLayers();
          return;
        }
      }
    }

    if (useStampImage) {
      for (const segment of segments) {
        if (segment.kind === 'dot') {
          this.app.symBitmapStamp(ctx, segment.x, segment.y, segment.size || width, p.color, opacity, {
            p,
            markDirty: false,
          });
          continue;
        }

        const dx = segment.x1 - segment.x0;
        const dy = segment.y1 - segment.y0;
        const travel = Math.hypot(dx, dy);
        const rotation = Math.atan2(dy, dx);
        const startSize = segment.size0 || width;
        const endSize = segment.size1 || startSize;
        const stampStep = Math.max(0.35, Math.max(startSize, endSize) * 0.18);
        const steps = Math.max(1, Math.ceil(travel / stampStep));
        for (let step = 1; step <= steps; step++) {
          const t = step / steps;
          const x = segment.x0 + dx * t;
          const y = segment.y0 + dy * t;
          const size = startSize + ((endSize - startSize) * t);
          this.app.symBitmapStamp(ctx, x, y, size, p.color, opacity, {
            p,
            rotation,
            markDirty: false,
          });
        }
      }
      layer.dirty = true;
      this.app.compositeAllLayers();
      return;
    }

    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.fillStyle = p.color;
    ctx.globalAlpha = opacity;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (useAlphaLock) ctx.globalCompositeOperation = 'source-atop';
    for (const segment of segments) {
      if (segment.kind === 'dot') {
        const dotSize = segment.size || width;
        const points = this.app.getSymmetryPoints(segment.x, segment.y);
        for (let i = 0; i < points.length; i++) {
          const point = points[i];
          const scaledDotSize = dotSize * (point.sizeMultiplier || 1);
          for (const [ox, oy] of offsets) {
            ctx.beginPath();
            ctx.arc(point.x + ox, point.y + oy, scaledDotSize / 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        continue;
      }
      const startPoints = this.app.getSymmetryPoints(segment.x0, segment.y0);
      const endPoints = this.app.getSymmetryPoints(segment.x1, segment.y1);
      const pairCount = Math.min(startPoints.length, endPoints.length);
      for (let i = 0; i < pairCount; i++) {
        const start = startPoints[i];
        const end = endPoints[i];
        const startSize = (segment.size0 || width) * (start.sizeMultiplier || 1);
        const endSize = (segment.size1 || segment.size0 || width) * (end.sizeMultiplier || 1);
        ctx.lineWidth = Math.max(0.5, (startSize + endSize) * 0.5);
        for (const [ox, oy] of offsets) {
          ctx.beginPath();
          ctx.moveTo(start.x + ox, start.y + oy);
          ctx.lineTo(end.x + ox, end.y + oy);
          ctx.stroke();
        }
      }
    }
    if (useAlphaLock) ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.restore();
    layer.dirty = true;
    this.app.compositeAllLayers();
  }

  onDown(x, y, pressure = 1) {
    const p = this.app.getP();
    if (this._gpuPreviewActive) _commitProceduralGpuPreviewToLayer(this, { allowAlphaLock: true });
    this._active = true;
    this._originX = x;
    this._originY = y;
    this._pressure = pressure;
    this._lastInputX = x;
    this._lastInputY = y;
    this._updateGraphAngle(p, x, y, { hasPathSample: false, fallbackAngle: 0 });
    this._resetRuntime(true);
    _ensureProceduralStampRendererInit(this);
    const compiled = this._ensureCompiledGraph(p);
    this._rerollRandomStartAgents(compiled);
  }

  onMove(x, y, pressure = this._pressure) {
    const p = this.app.getP();
    this._updateGraphAngle(p, x, y, { hasPathSample: true });
    this._originX = x;
    this._originY = y;
    this._pressure = pressure;
  }

  onUp(x, y) {
    this._originX = x;
    this._originY = y;
    if (this._gpuPreviewActive) {
      if (!_commitProceduralGpuPreviewToLayer(this, { allowAlphaLock: true })) {
        const layer = this.app.getActiveLayer();
        if (layer?.dirty) this.app.compositeAllLayers();
      }
    }
    this._active = false;
    this._resetRuntime(false);
  }

  onFrame(elapsed) {
    if (!this._active) return;
    const p = this._getRuntimeParams(this.app.getP());
    if (this.app?.simulation?.enabled && this.app?.activeBrush === 'motionPath') {
      if (Number.isFinite(this.app.leaderX)) this._originX = this.app.leaderX;
      if (Number.isFinite(this.app.leaderY)) this._originY = this.app.leaderY;
    }
    this._updateGraphAngle(p, this._lastInputX, this._lastInputY, { hasPathSample: false });
    const compiled = this._ensureCompiledGraph(p);
    if (!compiled?.paths?.length || !this._runtimeAgents.length) return;
    const delta = this._lastElapsed > 0
      ? Math.min(MOTION_PATH_BRUSH_DELTA_CAP, Math.max(0, elapsed - this._lastElapsed))
      : 1 / 60;
    this._lastElapsed = elapsed;

    const graphScale = Math.max(0.05, (p.brushScale || 1) * (p.motionPathScale || 1));
    const targetSpeed = Math.max(0, Number.isFinite(p.motionPathSpeed) ? p.motionPathSpeed : 1) * MOTION_PATH_BRUSH_BASE_SPEED;
    const acceleration = _clamp((p.motionPathAcceleration || 0) * 3.5, 0.2, 8);
    const pullStrength = _clamp((p.motionPathAttraction || 0) * 0.35, 0, 0.35);
    const baseSeparation = (p.stampSize || 1) * Math.max(0.08, p.stampSeparation || 0.15) * 0.5;
    const separation = Math.max(0.2, baseSeparation * Math.max(0.05, p.motionPathSpacing || 0.35));
    const useRibbon = (p.motionPathRenderMode || 'ribbon') === 'ribbon';
    const graphAngle = this._graphAngle || 0;
    const graphCos = Math.cos(graphAngle);
    const graphSin = Math.sin(graphAngle);
    const support = _getProceduralBatchRendererSupport(this, p, false);
    const color = hexToRGB(p.color);
    const instances = new StampInstanceBuffer(Math.max(32, this._runtimeAgents.length * 6));
    const cpuFallbackPoints = [];
    const ribbonSegments = [];
    this._overlayPoints = [];

    let baseSize = p.stampSize;
    if (p.pressureSize) baseSize *= (0.3 + 0.7 * this._pressure);
    let opacity = p.stampOpacity;
    if (p.pressureOpacity) opacity *= (0.3 + 0.7 * this._pressure);
    opacity = Math.min(opacity, 1);

    if (useRibbon && this._gpuPreviewActive) {
      _commitProceduralGpuPreviewToLayer(this, { allowAlphaLock: true });
    }

    const emitRibbonPoint = (x, y, stampSize) => {
      ribbonSegments.push({ kind: 'dot', x, y, size: stampSize });
    };

    const emitRibbonSegment = (x0, y0, size0, x1, y1, size1) => {
      ribbonSegments.push({ kind: 'segment', x0, y0, size0, x1, y1, size1 });
    };

    const emitPointStamp = (x, y, stampSize) => {
      if (useRibbon) {
        emitRibbonPoint(x, y, stampSize);
        return;
      }
      if (support.ok) {
        _emitBatchStampInstances(this.app, instances, p, x, y, stampSize, color, opacity);
      } else {
        cpuFallbackPoints.push({ x, y, size: stampSize });
      }
    };

    const emitSegmentStamps = (x0, y0, size0, x1, y1, size1) => {
      if (useRibbon) {
        emitRibbonSegment(x0, y0, size0, x1, y1, size1);
        return;
      }
      const dx = x1 - x0;
      const dy = y1 - y0;
      const travel = Math.hypot(dx, dy);
      const stampSpacing = Math.max(0.2, separation * Math.max(0.25, ((size0 + size1) * 0.5) / Math.max(baseSize, 0.001)));
      const steps = Math.max(1, Math.ceil(travel / stampSpacing));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const stampX = x0 + dx * t;
        const stampY = y0 + dy * t;
        const stampSize = size0 + ((size1 - size0) * t);
        emitPointStamp(stampX, stampY, stampSize);
      }
    };

    const toWorldPoint = (sample, lateralPixels) => {
      const rotatedAngle = sample.angle + graphAngle;
      const nx = -Math.sin(rotatedAngle);
      const ny = Math.cos(rotatedAngle);
      const scaledX = sample.x * graphScale;
      const scaledY = sample.y * graphScale;
      const rotatedX = scaledX * graphCos - scaledY * graphSin;
      const rotatedY = scaledX * graphSin + scaledY * graphCos;
      let worldX = this._originX + rotatedX + nx * lateralPixels;
      let worldY = this._originY + rotatedY + ny * lateralPixels;
      if (pullStrength > 0) {
        worldX += (this._originX - worldX) * pullStrength;
        worldY += (this._originY - worldY) * pullStrength;
      }
      return { x: worldX, y: worldY };
    };

    for (const agent of this._runtimeAgents) {
      const track = compiled.paths[agent.pathIndex];
      if (!track) continue;
      if (agent.stopped) continue;
      const speedSample = _sampleCompiledMotionTrack(track, agent.distance);
      const nodeSpeedScale = Math.max(0, Number.isFinite(speedSample?.speedScale) ? speedSample.speedScale : 1);
      const speedEase = _clamp(delta * acceleration, 0, 1);
      agent.speed += ((targetSpeed * agent.speedMultiplier * nodeSpeedScale) - agent.speed) * speedEase;
      const prevDistance = agent.distance;
      _advanceMotionTrackDistance(agent, track, agent.speed * delta);
      const prevSample = _sampleCompiledMotionTrack(track, prevDistance);
      const sample = _sampleCompiledMotionTrack(track, agent.distance);
      if (!sample) continue;
      const avoidanceBlend = agent.respawnSnapToTrack
        ? 0
        : _clamp(Number.isFinite(agent.respawnOffsetBlend) ? agent.respawnOffsetBlend : 1, 0, 1);
      const lateralPixels = agent.lateralOffset * (p.motionPathAvoidance || 0) * 18 * graphScale * avoidanceBlend;
      const rawPrevWorld = prevSample ? toWorldPoint(prevSample, lateralPixels) : null;
      const rawWorld = toWorldPoint(sample, lateralPixels);
      const prevStampSize = Math.max(0.5, baseSize * Math.max(0.05, prevSample?.stampScale || sample.stampScale || 1));
      const stampSize = Math.max(0.5, baseSize * Math.max(0.05, sample.stampScale || 1));
      const { x: worldX, y: worldY } = this._smoothAgentWorldPoint(
        agent,
        rawPrevWorld?.x ?? rawWorld.x,
        rawPrevWorld?.y ?? rawWorld.y,
        rawWorld.x,
        rawWorld.y,
        p,
      );
      this._overlayPoints.push({ x: worldX, y: worldY, size: stampSize });

      if (useRibbon) {
        const hasPrevWorld = Number.isFinite(agent.prevX) && Number.isFinite(agent.prevY);
        if (agent.discontinuousStep || !hasPrevWorld) {
          emitRibbonPoint(worldX, worldY, stampSize);
          agent.prevX = worldX;
          agent.prevY = worldY;
          agent.prevSize = stampSize;
          agent.spacingDistance = agent.distance;
          agent.spacingX = worldX;
          agent.spacingY = worldY;
          agent.spacingSize = stampSize;
          continue;
        }

        if (track.closed && agent.wrappedStep) {
          const seamEndSample = _sampleCompiledMotionTrack(track, Math.max(0, (track.totalLength || 0) - 1e-4));
          const seamStartSample = _sampleCompiledMotionTrack(track, 0);
          if (seamEndSample && seamStartSample) {
            const seamEndWorld = toWorldPoint(seamEndSample, lateralPixels);
            const seamStartWorld = toWorldPoint(seamStartSample, lateralPixels);
            const seamEndSize = Math.max(0.5, baseSize * Math.max(0.05, seamEndSample.stampScale || 1));
            const seamStartSize = Math.max(0.5, baseSize * Math.max(0.05, seamStartSample.stampScale || 1));
            emitRibbonSegment(agent.prevX, agent.prevY, agent.prevSize || prevStampSize, seamEndWorld.x, seamEndWorld.y, seamEndSize);
            emitRibbonSegment(seamStartWorld.x, seamStartWorld.y, seamStartSize, worldX, worldY, stampSize);
            agent.prevX = worldX;
            agent.prevY = worldY;
            agent.prevSize = stampSize;
            agent.spacingDistance = agent.distance;
            agent.spacingX = worldX;
            agent.spacingY = worldY;
            agent.spacingSize = stampSize;
            continue;
          }
        }

        emitRibbonSegment(agent.prevX, agent.prevY, agent.prevSize || prevStampSize, worldX, worldY, stampSize);
        agent.prevX = worldX;
        agent.prevY = worldY;
        agent.prevSize = stampSize;
        agent.spacingDistance = agent.distance;
        agent.spacingX = worldX;
        agent.spacingY = worldY;
        agent.spacingSize = stampSize;
        continue;
      }

      const hasSpacingAnchor = Number.isFinite(agent.spacingDistance);
      const spacingWorld = hasSpacingAnchor && Number.isFinite(agent.spacingX) && Number.isFinite(agent.spacingY)
        ? { x: agent.spacingX, y: agent.spacingY }
        : null;
      const spacingSize = Number.isFinite(agent.spacingSize) ? agent.spacingSize : prevStampSize;

      if (agent.discontinuousStep || !spacingWorld) {
        emitPointStamp(worldX, worldY, stampSize);
        agent.spacingDistance = agent.distance;
        agent.spacingX = worldX;
        agent.spacingY = worldY;
        agent.spacingSize = stampSize;
        agent.prevX = worldX;
        agent.prevY = worldY;
        agent.prevSize = stampSize;
        continue;
      }

      if (track.closed && agent.wrappedStep && agent.spacingDistance > agent.distance) {
        const seamEndSample = _sampleCompiledMotionTrack(track, Math.max(0, (track.totalLength || 0) - 1e-4));
        const seamStartSample = _sampleCompiledMotionTrack(track, 0);
        if (seamEndSample && seamStartSample) {
          const seamEndWorld = toWorldPoint(seamEndSample, lateralPixels);
          const seamStartWorld = toWorldPoint(seamStartSample, lateralPixels);
          const seamEndSize = Math.max(0.5, baseSize * Math.max(0.05, seamEndSample.stampScale || 1));
          const seamStartSize = Math.max(0.5, baseSize * Math.max(0.05, seamStartSample.stampScale || 1));
          emitSegmentStamps(spacingWorld.x, spacingWorld.y, spacingSize, seamEndWorld.x, seamEndWorld.y, seamEndSize);
          const wrapDx = worldX - seamStartWorld.x;
          const wrapDy = worldY - seamStartWorld.y;
          const wrapTravel = Math.hypot(wrapDx, wrapDy);
          if (wrapTravel < separation) {
            emitPointStamp(worldX, worldY, stampSize);
          } else {
            emitSegmentStamps(seamStartWorld.x, seamStartWorld.y, seamStartSize, worldX, worldY, stampSize);
            agent.spacingDistance = agent.distance;
            agent.spacingX = worldX;
            agent.spacingY = worldY;
            agent.spacingSize = stampSize;
          }
          agent.prevX = worldX;
          agent.prevY = worldY;
          agent.prevSize = stampSize;
          continue;
        }
      }

      const dx = worldX - spacingWorld.x;
      const dy = worldY - spacingWorld.y;
      const dist = Math.hypot(dx, dy);
      const currentSeparation = Math.max(0.2, separation * Math.max(0.25, stampSize / Math.max(baseSize, 0.001)));
      if (dist < currentSeparation) {
        emitPointStamp(worldX, worldY, stampSize);
      } else {
        emitSegmentStamps(spacingWorld.x, spacingWorld.y, spacingSize, worldX, worldY, stampSize);
        agent.spacingDistance = agent.distance;
        agent.spacingX = worldX;
        agent.spacingY = worldY;
        agent.spacingSize = stampSize;
      }
      agent.prevX = worldX;
      agent.prevY = worldY;
      agent.prevSize = stampSize;
      agent.respawnSnapToTrack = false;
      agent.respawnOffsetBlend = Math.min(1, (Number.isFinite(agent.respawnOffsetBlend) ? agent.respawnOffsetBlend : 1) + (delta * 7));
    }

    const layer = this.app.getActiveLayer();
    if (!layer) return;
    if (useRibbon && ribbonSegments.length) {
      _setProceduralRenderBackend(this, 'ribbon');
      this._cpuRenderRibbonSegments(ribbonSegments, p);
      return;
    }
    if (support.ok && instances.count > 0) {
      const batch = { instances: instances.finish(), count: instances.count };
      if (_renderProceduralBatchToTarget(this, layer.ctx, batch, p, { allowAlphaLock: true })) {
        layer.dirty = true;
        if (!this._gpuPreviewActive) this.app.compositeAllLayers();
      } else {
        this._cpuFallbackStamp(this._overlayPoints, p);
      }
    } else if (cpuFallbackPoints.length) {
      _setProceduralRenderBackend(this, 'legacy', support.reason || 'GPU procedural-stamp renderer unavailable');
      this._cpuFallbackStamp(cpuFallbackPoints, p);
    }
  }

  drawOverlay(ctx) {
    if (!this._active) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(91,138,240,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(this._originX, this._originY, 8, 0, Math.PI * 2);
    ctx.moveTo(this._originX - 14, this._originY);
    ctx.lineTo(this._originX + 14, this._originY);
    ctx.moveTo(this._originX, this._originY - 14);
    ctx.lineTo(this._originX, this._originY + 14);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,210,120,0.85)';
    for (const point of this._overlayPoints) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  getStatusInfo() {
    const doc = this.app._getActiveMotionPathDocument?.();
    if (!doc) return 'Motion Path · no graph';
    const legacyReason = this._renderBackend === 'legacy'
      ? (_getProceduralBatchRendererSupport(this, this.app.getP(), false).reason || this.renderer.legacyReason || this._renderLegacyReason)
      : '';
    return `Motion Path · ${doc.name} · ${doc.paths.length} paths · ${this._runtimeAgents.length || this.app.getP().motionPathAgentCount} agents · Render: ${this._renderBackend}${legacyReason ? ` (${legacyReason})` : ''}`;
  }

  deactivate() {
    if (this._gpuPreviewActive) _clearProceduralGpuPreview(this, { composite: true });
    this._active = false;
    this._simulationData = null;
    this._simulationSpawnConfig = null;
    this._resetRuntime(true);
  }
}
