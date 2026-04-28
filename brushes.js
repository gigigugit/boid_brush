// =============================================================================
// brushes.js — Ant, Boid, Bristle, Eraser, Fluid, and Simple brush engines
//
// Each brush implements: onDown(x,y,pressure), onMove(x,y,pressure),
// onUp(x,y), onFrame(elapsed), taperFrame(t,p), drawOverlay(ctx,p),
// getStatusInfo(), deactivate().
// =============================================================================

import { BoidSim, FluidSim } from './wasm-bridge.js';

// Pressure EMA alpha for BristleBrush (~6-frame smoothing window)
const BRISTLE_PRESSURE_ALPHA = 0.15;
// Max EMA damping: smoothing=1 → alpha = 1 - MAX_SMOOTH_DAMP ≈ 0.08
const MAX_SMOOTH_DAMP = 0.92;
// Low-pass filter strength for Pencil angle changes (higher = snappier, lower = smoother)
const BRISTLE_ANGLE_ALPHA = 0.16;
// Move samples inject less mass than pointer-down so a continuous stroke does not over-pack the lattice.
const FLUID_MOVE_SEED_RATIO = 0.45;
// Maximum pheromone intensity (maps to Uint8 luminance for sensing upload)
const MAX_PHEROMONE = 255;
// Skip texture flow on nearly flat regions where the sampled slope is only a tiny fraction
// of the texture's full gradient range; this avoids unnecessary blur-canvas churn.
const MIN_TEXTURE_FLOW_SLOPE = 0.04;
const TEXTURE_FLOW_BASE_TRANSFER = 0.12;
const TEXTURE_FLOW_SLOPE_TRANSFER = 0.28;
const TEXTURE_FLOW_MAX_TRANSFER = 0.4;
const FLUID_FINAL_PASS_MAX_SETTLING_STEPS = 480;
// Minimum deviation from vertical (π/2) in radians to consider tilt data meaningful.
// Values closer to π/2 than this indicate the pen is essentially vertical or no tilt
// data is available from the hardware.
const TILT_THRESHOLD = 0.01; // ~0.57°
const AGENT_X = 0;
const AGENT_Y = 1;
const AGENT_VX = 2;
const AGENT_VY = 3;

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

function _fillRadialPool(ctx, app, x, y, radius, color, opacity) {
  if (!ctx || radius <= 0 || opacity <= 0) return;
  for (const pt of app.getSymmetryPoints(x, y)) {
    const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radius);
    grad.addColorStop(0, _colorWithAlpha(color, opacity));
    grad.addColorStop(0.58, _colorWithAlpha(color, opacity * 0.52));
    grad.addColorStop(1, _colorWithAlpha(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function _strokePoolRing(ctx, app, x, y, radius, color, opacity, width) {
  if (!ctx || radius <= 0 || opacity <= 0 || width <= 0) return;
  ctx.save();
  ctx.strokeStyle = _shadeColor(color);
  ctx.globalAlpha = opacity;
  ctx.lineWidth = width;
  for (const pt of app.getSymmetryPoints(x, y)) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
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
  bctx.fillStyle = color;
  for (const pt of app.getSymmetryPoints(x, y)) {
    bctx.beginPath();
    bctx.arc(pt.x, pt.y, sz / 2, 0, Math.PI * 2);
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

function _applySimulationGuides(brush, p, read) {
  const app = brush.app;
  const sim = app.simulation;
  if (!sim?.enabled) return;
  const data = sim.brushData[app.activeBrush];
  if (!data) return;
  const { buffer, count, stride } = read;
  const pointForce = p.simPointStrength * p.simSpeed;
  const pointRadius = Math.max(1, p.simPointRadius);
  const edgeForce = p.simEdgeForce * p.simSpeed;
  const edgeRadius = Math.max(0, p.simEdgeRadius);

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    let x = buffer[base + AGENT_X];
    let y = buffer[base + AGENT_Y];
    let vx = buffer[base + AGENT_VX];
    let vy = buffer[base + AGENT_VY];

    for (const point of data.points) {
      const dx = point.x - x;
      const dy = point.y - y;
      const d = Math.hypot(dx, dy);
      if (d <= 0.0001 || d > pointRadius) continue;
      const sign = point.type === 'repel' ? -1 : 1;
      const falloff = 1 - d / pointRadius;
      const push = pointForce * falloff * 0.85 * sign;
      vx += (dx / d) * push;
      vy += (dy / d) * push;
    }

    if (app.activeBrush === 'ant' && data.edges?.length) {
      const prevX = x - vx;
      const prevY = y - vy;
      for (const edge of data.edges) {
        const pts = edge.points || [];
        for (let j = 1; j < pts.length; j++) {
          const a = pts[j - 1];
          const b = pts[j];
          const closest = _closestPointOnSegment(x, y, a.x, a.y, b.x, b.y);
          const dx = x - closest.x;
          const dy = y - closest.y;
          const dist = Math.hypot(dx, dy);
          if (edgeRadius > 0 && dist < edgeRadius && dist > 0.0001) {
            const away = (1 - dist / edgeRadius) * edgeForce;
            vx += (dx / dist) * away;
            vy += (dy / dist) * away;
          }
          const prevSide = _signedDistanceToLine(prevX, prevY, a.x, a.y, b.x, b.y);
          const curSide = _signedDistanceToLine(x, y, a.x, a.y, b.x, b.y);
          if ((prevSide < 0 && curSide > 0) || (prevSide > 0 && curSide < 0)) {
            const nx = dy === 0 && dx === 0 ? 0 : dx / Math.max(dist, 1);
            const ny = dy === 0 && dx === 0 ? 0 : dy / Math.max(dist, 1);
            x = closest.x + nx * Math.max(edgeRadius, 2);
            y = closest.y + ny * Math.max(edgeRadius, 2);
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
}

export class BoidBrush {
  constructor(app) {
    this.app = app;
    this.sim = null;
    this._ready = false;
    this._lastStampX = [];
    this._lastStampY = [];
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
    // Trail blur offscreen canvases
    this._blurCanvas = null;
    this._blurCtx = null;
    this._blurTmpCanvas = null;
    this._blurTmpCtx = null;
    // Per-stroke accumulation canvas — cleared each onDown, so blur only affects
    // paint from the current stroke, not previously painted layers.
    this._blurStrokeCanvas = null;
    this._blurStrokeCtx = null;
  }

  async init() {
    try {
      this.sim = await BoidSim.create(
        this.app.W || 800,
        this.app.H || 600,
        10000
      );
      this._ready = true;
    } catch (e) {
      console.error('BoidBrush: WASM init failed —', e);
    }
  }

  /** Capture canvas luminance and upload to WASM for pixel sensing */
  _uploadSensing(p) {
    const imgData = this.app.buildSensingData();
    const rgba = imgData.data;
    const w = imgData.width;
    const h = imgData.height;
    // Downsample to 1/4 resolution to reduce cost
    const dw = Math.max(1, w >> 2);
    const dh = Math.max(1, h >> 2);
    const lum = new Uint8Array(dw * dh);
    const channel = p.sensingChannel || 'darkness';
    const sx = w / dw;
    const sy = h / dh;
    for (let dy = 0; dy < dh; dy++) {
      const srcY = Math.min(Math.floor(dy * sy), h - 1);
      for (let dx = 0; dx < dw; dx++) {
        const srcX = Math.min(Math.floor(dx * sx), w - 1);
        const idx = (srcY * w + srcX) * 4;
        const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2], a = rgba[idx + 3];
        let v;
        if (channel === 'red') v = r;
        else if (channel === 'green') v = g;
        else if (channel === 'blue') v = b;
        else if (channel === 'alpha') v = a;
        else if (channel === 'lightness') v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        else if (channel === 'saturation') {
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          v = mx === 0 ? 0 : Math.round(((mx - mn) / mx) * 255);
        }
        else /* 'darkness' */ v = 255 - Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        lum[dy * dw + dx] = v;
      }
    }
    this.sim.uploadSensing(lum, dw, dh);
    this._sensingUploaded = true;
  }

  _hasAgents() {
    if (!this._ready || !this.sim) return false;
    return this.sim.readAgents().count > 0;
  }

  _clearAgents() {
    if (!this.sim) return;
    this.sim.clearAgents();
    this._boidsSpawned = false;
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
    this.sim.spawnBatch(x, y, p.count, p.spawnShape, spawnAngle, p.spawnJitter, r);
    this._boidsSpawned = true;
    this._lastSpawnX = x;
    this._lastSpawnY = y;
    return true;
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

  /** Hover: spawn boids once at hover position, then let onHoverFrame step
   *  the simulation so boids flock exactly as they do during drawing.
   *  Pen with tilt uses pencil azimuth for spawn angle; mouse uses UI angle. */
  onHover(x, y) {
    if (!this._ready) return;
    if (this._hoverSpawned) return; // hover state already entered — sim runs via onHoverFrame
    const p = this.app.getP();
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
    const p = this.app.getP();
    // Write params with the current hover leader position so boids follow
    this.sim.writeParams(p, this.app.leaderX, this.app.leaderY, elapsed);
    this.sim.step(1 / 60);
  }

  onDown(x, y, pressure) {
    if (!this._ready) return;
    const p = this.app.getP();

    this._applyLifecycleAction(p.boidTouchAction, p, x, y, pressure, false);
    // Touch-down ends any prior hover preview; the stroke now owns agent motion.
    this._hoverSpawned = false;
    this._lastStampX = [];
    this._lastStampY = [];
    this._lastSpawnX = x;
    this._lastSpawnY = y;
    this.app.strokeFrame = 0;
    this._sensingFrame = 0;
    this._sensingUploaded = false;

    // Upload sensing data at stroke start if enabled
    if (p.sensingEnabled) {
      this._uploadSensing(p);
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
      this.sim.writeParams(p, x, y, 0);
      this.sim.step(1 / 60);
      const { buffer, count, stride } = this.sim.readAgents();
      if (count > 0) {
        const layer = this.app.getActiveLayer();
        this._baseHSL = hexToHSL(p.color);
        for (let i = 0; i < count; i++) {
          const base = i * stride;
          const ax = buffer[base + 0];
          const ay = buffer[base + 1];
          const sm = buffer[base + 8];
          const om = buffer[base + 9];
          const agentHue = buffer[base + 20];
          const agentSat = buffer[base + 21];
          const agentLit = buffer[base + 22];
          let sz = p.stampSize * sm;
          let op = p.stampOpacity * om;
          if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
          if (p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
          op = Math.min(op, 1);
          let color = p.color;
          if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
            const [bh, bs, bl] = this._baseHSL;
            color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
          }
          this.app.symStamp(layer.ctx, ax, ay, sz, color, op);
          this._lastStampX[i] = ax;
          this._lastStampY[i] = ay;
        }
        layer.dirty = true;
      }
    }
  }

  onMove(x, y, pressure) {
    // No respawn-on-move: boids are spawned once (on hover or touch-down)
  }

  onUp(x, y) {
    // Flush paint that was deposited by the initial onDown stamp or by the last
    // onFrame call. Covers the quick-tap case where isDrawing goes false before
    // the next RAF frame fires. Only runs in non-flat mode — flat stroke
    // compositing lives in onFrame and the taper handles the final flush.
    if (!this._flatActive) {
      const layer = this.app.getActiveLayer();
      if (layer.dirty) this.app.compositeAllLayers();
    }
    const p = this.app.getP();
    this._applyLifecycleAction(p.boidUntouchAction, p, x, y, 1, false);
    this._hoverSpawned = false;
  }

  configureSimulation(data, p) {
    if (!this._ready || !data?.spawns?.length) return;
    for (let i = 1; i < data.spawns.length; i++) {
      const spawn = data.spawns[i];
      this.sim.spawnBatch(spawn.x, spawn.y, p.count, p.spawnShape, p.spawnAngle, p.spawnJitter, p.spawnRadius);
    }
  }

  onFrame(elapsed) {
    if (!this._ready) return;
    const p = this.app.getP();
    const app = this.app;

    // Periodically re-upload sensing data during long strokes (every 30 frames)
    if (p.sensingEnabled) {
      this._sensingFrame++;
      if (!this._sensingUploaded || this._sensingFrame >= 30) {
        this._uploadSensing(p);
        this._sensingFrame = 0;
      }
    }

    // Write sim params and step
    this.sim.writeParams(p, app.leaderX, app.leaderY, elapsed);
    this.sim.step(1 / 60);

    // Read agents
    const read = this.sim.readAgents();
    _applySimulationGuides(this, p, read);
    const { buffer, count, stride } = read;
    if (count === 0) return;

    // Stamp each agent
    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;
    const skipN = p.skipStamps || 0;
    app.strokeFrame++;
    this._baseHSL = hexToHSL(p.color);

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0]; // x
      const ay = buffer[base + 1]; // y
      const sm = buffer[base + 8]; // size multiplier
      const om = buffer[base + 9]; // opacity multiplier
      const agentHue = buffer[base + 20]; // hue offset (degrees)
      const agentSat = buffer[base + 21]; // saturation offset
      const agentLit = buffer[base + 22]; // lightness offset

      // Skip first N stamps (lead-in) — track position but don't stamp
      if (app.strokeFrame <= skipN) {
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        continue;
      }

      // Compute size and opacity (needed for spacing calculation)
      let sz = p.stampSize * sm;
      // In flat mode, stamps go at full agent opacity; master opacity applied on composite
      let op = flat ? Math.min(om, 1) : p.stampOpacity * om;
      if (p.pressureSize) sz *= (0.3 + 0.7 * app.pressure);
      if (!flat && p.pressureOpacity) op *= (0.3 + 0.7 * app.pressure);
      op = Math.min(op, 1);

      // Per-agent color modification
      let color = p.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = this._baseHSL;
        color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
      }

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

        if (dist < step) continue; // accumulate distance until next stamp

        const n = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= n; j++) {
          const t = j / n;
          app.symStamp(stampCtx, prevX + dx * t, prevY + dy * t, sz, color, op);
          if (p.trailBlur > 0 && !flat && this._blurStrokeCtx) {
            _stampToBlurAccum(this._blurStrokeCtx, app, prevX + dx * t, prevY + dy * t, sz, color, op);
          }
        }
      } else {
        // First stamp for this agent
        app.symStamp(stampCtx, ax, ay, sz, color, op);
        if (p.trailBlur > 0 && !flat && this._blurStrokeCtx) {
          _stampToBlurAccum(this._blurStrokeCtx, app, ax, ay, sz, color, op);
        }
      }

      this._lastStampX[i] = ax;
      this._lastStampY[i] = ay;
    }

    // Flat-stroke compositing: restore snapshot, overlay stroke at stampOpacity
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

    // Trail blur: diffuse freshly stamped paint outward like wet ink.
    // Source: _blurStrokeCanvas (current stroke only), not the full layer —
    // this prevents the blur from re-processing paint from previous strokes.
    if (p.trailBlur > 0 && !flat) {
      const lw = layer.canvas.width, lh = layer.canvas.height;
      // Create/resize offscreen blur canvases and the per-stroke accumulation canvas
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
        // Apply DPR transform so plain arc() calls use CSS coordinates
        this._blurStrokeCtx.setTransform(app.DPR, 0, 0, app.DPR, 0, 0);
      }
      // Copy current stroke accumulation into blur canvas
      this._blurCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurCtx.clearRect(0, 0, lw, lh);
      this._blurCtx.drawImage(this._blurStrokeCanvas, 0, 0);
      // Texture flow: shift blur paint toward lower-height texture areas
      if (p.trailFlow > 0 && p.canvasTextureEnabled) {
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p);
      }
      // Apply CSS blur via tmp canvas
      this._blurTmpCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._blurTmpCtx.clearRect(0, 0, lw, lh);
      this._blurTmpCtx.filter = `blur(${p.trailBlur * app.DPR}px)`;
      this._blurTmpCtx.drawImage(this._blurCanvas, 0, 0);
      this._blurTmpCtx.filter = 'none';
      // Composite blurred result back onto layer with low opacity for soft diffusion halo
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

    // Step sim without leader tracking (they drift)
    this.sim.step(1 / 60);
    const { buffer, count, stride } = this.sim.readAgents();
    if (count === 0) return;

    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;
    this._baseHSL = hexToHSL(p.color);

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];

      let sz = p.stampSize * sm;
      let op = flat ? Math.min(om, 1) : p.stampOpacity * om;
      if (p.taperSize) sz *= curve;
      if (p.taperOpacity) op *= curve;
      op = Math.min(op, 1);
      if (op < 0.005 || sz < 0.5) continue;

      let color = p.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = this._baseHSL;
        color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
      }

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

        if (dist < step) continue; // accumulate distance

        const n = Math.min(Math.max(1, Math.ceil(dist / step)), 256);
        for (let j = 1; j <= n; j++) {
          const tt = j / n;
          app.symStamp(stampCtx, prevX + dx * tt, prevY + dy * tt, sz, color, op);
        }
      } else {
        app.symStamp(stampCtx, ax, ay, sz, color, op);
      }

      this._lastStampX[i] = ax;
      this._lastStampY[i] = ay;
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

    // Show hover-spawned boids even when showBoids is off (lighter colour)
    if (this._hoverSpawned) {
      const { buffer, count, stride } = this.sim.readAgents();
      ctx.fillStyle = 'rgba(100,180,255,0.35)';
      for (let i = 0; i < count; i++) {
        const base = i * stride;
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
    const { buffer, count, stride } = this.sim.readAgents();
    ctx.fillStyle = 'rgba(100,180,255,0.6)';
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      ctx.fillRect(buffer[base] - 1, buffer[base + 1] - 1, 2, 2);
    }

    // Draw spawn area indicator
    const simSpawn = this.app.simulation?.enabled && this.app.activeBrush === 'boid'
      ? this.app._getSimulationSpawnCenter('boid')
      : null;
    if (p.showSpawn && (this.app.isDrawing || simSpawn)) {
      const sx = simSpawn?.x ?? this.app.leaderX;
      const sy = simSpawn?.y ?? this.app.leaderY;
      ctx.strokeStyle = 'rgba(100,180,255,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, p.spawnRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  getStatusInfo() {
    if (!this._ready) return 'WASM loading...';
    const { count } = this.sim.readAgents();
    return `Boid | Agents: ${count}`;
  }

  deactivate() {
    if (this.sim) this.sim.clearAgents();
    this._boidsSpawned = false;
    this._hoverSpawned = false;
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
    this.sim = null;
    this._ready = false;
    this._lastStampX = [];
    this._lastStampY = [];
    this._lastSpawnX = 0;
    this._lastSpawnY = 0;
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
  }

  async init() {
    try {
      this.sim = await BoidSim.create(
        this.app.W || 800,
        this.app.H || 600,
        10000 // max agent pool capacity
      );
      this._ready = true;
    } catch (e) {
      console.error('AntBrush: WASM init failed —', e);
    }
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
    for (let i = 1; i < data.spawns.length; i++) {
      const spawn = data.spawns[i];
      this.sim.spawnBatch(spawn.x, spawn.y, p.count, p.spawnShape, p.spawnAngle, p.spawnJitter, p.spawnRadius);
    }
    this._initPheroGrid();
    if (this._pheroData) this._pheroData.fill(0);
    for (const trail of data.pheromonePaths || []) {
      this.paintSimulationPheromone(trail.points, trail.radius || p.simPheroPaintRadius, trail.intensity || p.simPheroPaintStrength);
    }
    if (p.antPheromoneToSensing && this._pheroData) this._uploadPheromoneToSensing();
  }

  // ---- Brush lifecycle ----

  onDown(x, y, pressure) {
    if (!this._ready) return;
    const p = this.app.getP();
    let r = p.spawnRadius;
    if (p.pressureSpawnRadius) r *= (0.3 + 0.7 * pressure);
    this.sim.clearAgents();
    this.sim.spawnBatch(x, y, p.count, p.spawnShape, p.spawnAngle, p.spawnJitter, r);
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
      this.sim.writeParams(antP, x, y, 0);
      this.sim.step(1 / 60);
      const { buffer, count, stride } = this.sim.readAgents();
      if (count > 0) {
        const layer = this.app.getActiveLayer();
        this._baseHSL = hexToHSL(p.color);
        for (let i = 0; i < count; i++) {
          const base = i * stride;
          const ax = buffer[base + 0];
          const ay = buffer[base + 1];
          const sm = buffer[base + 8];
          const om = buffer[base + 9];
          const agentHue = buffer[base + 20];
          const agentSat = buffer[base + 21];
          const agentLit = buffer[base + 22];
          let sz = p.stampSize * sm;
          let op = p.stampOpacity * om;
          if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
          if (p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
          op = Math.min(op, 1);
          let color = p.color;
          if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
            const [bh, bs, bl] = this._baseHSL;
            color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
          }
          this.app.symStamp(layer.ctx, ax, ay, sz, color, op);
          this._lastStampX[i] = ax;
          this._lastStampY[i] = ay;
          // Deposit initial pheromone
          this._depositPheromone(ax, ay, p.antPheromoneSize, p.antPheromoneRate * MAX_PHEROMONE);
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
      const layer = this.app.getActiveLayer();
      if (layer.dirty) this.app.compositeAllLayers();
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
      sensingThreshold: p.sensingThreshold || 0.1,
      // Ants wander more by default
      wander: p.wander,
      jitter: p.jitter,
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
    this.sim.writeParams(antP, app.leaderX, app.leaderY, elapsed);
    this.sim.step(1 / 60);

    // Read agents
    const read = this.sim.readAgents();
    _applySimulationGuides(this, p, read);
    const { buffer, count, stride } = read;
    if (count === 0) return;

    // Stamp each agent and deposit pheromones along their paths
    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;
    const skipN = p.skipStamps || 0;
    app.strokeFrame++;
    this._baseHSL = hexToHSL(p.color);

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];

      // Skip first N stamps
      if (app.strokeFrame <= skipN) {
        this._lastStampX[i] = ax;
        this._lastStampY[i] = ay;
        continue;
      }

      let sz = p.stampSize * sm;
      let op = flat ? Math.min(om, 1) : p.stampOpacity * om;
      if (p.pressureSize) sz *= (0.3 + 0.7 * app.pressure);
      if (!flat && p.pressureOpacity) op *= (0.3 + 0.7 * app.pressure);
      op = Math.min(op, 1);

      let color = p.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = this._baseHSL;
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

    this.sim.step(1 / 60);
    const { buffer, count, stride } = this.sim.readAgents();
    if (count === 0) return;

    const layer = app.getActiveLayer();
    const flat = this._flatActive;
    const stampCtx = flat ? this._strokeCtx : layer.ctx;
    this._baseHSL = hexToHSL(p.color);

    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const ax = buffer[base + 0];
      const ay = buffer[base + 1];
      const sm = buffer[base + 8];
      const om = buffer[base + 9];
      const agentHue = buffer[base + 20];
      const agentSat = buffer[base + 21];
      const agentLit = buffer[base + 22];

      let sz = p.stampSize * sm;
      let op = flat ? Math.min(om, 1) : p.stampOpacity * om;
      if (p.taperSize) sz *= curve;
      if (p.taperOpacity) op *= curve;
      op = Math.min(op, 1);
      if (op < 0.005 || sz < 0.5) continue;

      let color = p.color;
      if (agentHue !== 0 || agentSat !== 0 || agentLit !== 0) {
        const [bh, bs, bl] = this._baseHSL;
        color = hslToCSS(bh + agentHue, bs + agentSat, bl + agentLit);
      }

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
          const tt = j / n;
          app.symStamp(stampCtx, prevX + dx * tt, prevY + dy * tt, sz, color, op);
        }
      } else {
        app.symStamp(stampCtx, ax, ay, sz, color, op);
      }

      this._lastStampX[i] = ax;
      this._lastStampY[i] = ay;
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
      ? this.app._getSimulationSpawnCenter('ant')
      : null;
    if (p.showSpawn && (this.app.isDrawing || simSpawn)) {
      const sx = simSpawn?.x ?? this.app.leaderX;
      const sy = simSpawn?.y ?? this.app.leaderY;
      ctx.strokeStyle = 'rgba(180,100,50,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, p.spawnRadius, 0, Math.PI * 2);
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
    return `Ant | Agents: ${count}`;
  }

  deactivate() {
    if (this.sim) this.sim.clearAgents();
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
    // Bristles continue via taper if configured
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
    return `Bristle | Tips: ${this._count}`;
  }

  deactivate() {
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
    this._lastStampX = null;
    this._lastStampY = null;
    this._needsComposite = false;
    this._active = false;
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
  }

  onDown(x, y, pressure) {
    const p = this.app.getP();
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
    this.app.strokeFrame = 0;
    this._active = true;
    this._stamp(x, y, pressure);
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
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      this._stamp(this._lastStampX + dx * t, this._lastStampY + dy * t, pressure);
    }
    this._lastStampX = x;
    this._lastStampY = y;

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

  _stamp(x, y, pressure) {
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

    this.app.symStamp(ctx, x, y, sz, p.color, op);
    if (this._blurStrokeCtx) _stampToBlurAccum(this._blurStrokeCtx, this.app, x, y, sz, p.color, op);
    this.app.strokeFrame++;
  }

  drawOverlay() { /* nothing */ }
  getStatusInfo() { return 'Simple'; }
  deactivate() { this._active = false; this._flatActive = false; }
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
  const speedScale = 0.54 + p.lbmStrokePull * 0.5 + p.lbmStrokeRake * 0.12 + p.lbmStrokeJitter * 0.2;
  const travel = Math.min(1, profile.distance / Math.max(8, p.lbmBrushRadius * 0.75));
  const laneCount = Math.max(2, 2 + Math.round(p.lbmStrokeRake * 5));
  const laneSpacing = p.lbmBrushRadius * (0.08 + p.lbmStrokeRake * 0.2);
  const phase = profile.spawnTime * 0.018;

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
    const alongOffset = ((Math.random() - 0.42) * p.lbmBrushRadius * (0.32 + p.lbmStrokePull * 0.9))
      + travel * p.lbmBrushRadius * (0.12 + p.lbmStrokePull * 0.42);
    const laneOffset = lanePosition * laneSpacing * (1 + travel * 1.4)
      + (Math.random() - 0.5) * p.lbmBrushRadius * (0.08 + p.lbmStrokeJitter * 0.22);
    const swirlOffset = Math.sin(phase + laneIndex * 1.37 + index * 0.31) * p.lbmBrushRadius * p.lbmStrokeJitter * 0.16;
    const scatterRadius = Math.sqrt(Math.random()) * p.lbmBrushRadius * (0.08 + p.lbmStrokeJitter * 0.24);
    const scatterAngle = phase + index * 0.53;
    const tangentVelocity = speedScale * (0.62 + p.lbmStrokePull * 2.2) * (0.66 + travel * 0.96 + Math.random() * 0.5);
    const crossVelocity = speedScale * (lanePosition * (0.36 + p.lbmStrokeRake * 1.45)
      + Math.sin(phase + index * 0.83) * p.lbmStrokeJitter * 0.28
      + (Math.random() - 0.5) * (0.12 + p.lbmStrokeJitter * 0.45));
    const curlVelocity = speedScale * Math.sin(phase * 0.74 + lanePosition * 5.6 + index * 0.21)
      * (0.16 + p.lbmStrokeJitter * 0.72 + p.lbmStrokeRake * 0.24);
    const backfill = speedScale * (Math.random() - 0.5) * (0.08 + p.lbmStrokePull * 0.22);
    const dragNoise = speedScale * (Math.random() - 0.5) * 0.2;
    const seed = _fluidHexToRgba(_jitterFluidColor(color, p, profile, index), 0.66 + travel * 0.12 + Math.random() * 0.05);

    particles.push({
      x: x + profile.tangentX * alongOffset + profile.normalX * (laneOffset + swirlOffset) + Math.cos(scatterAngle) * scatterRadius * 0.35,
      y: y + profile.tangentY * alongOffset + profile.normalY * (laneOffset + swirlOffset) + Math.sin(scatterAngle) * scatterRadius * 0.35,
      vx: profile.tangentX * (tangentVelocity + backfill) + profile.normalX * (crossVelocity + curlVelocity) + dragNoise,
      vy: profile.tangentY * (tangentVelocity + backfill) + profile.normalY * (crossVelocity + curlVelocity) + dragNoise,
      radius: p.lbmParticleRadius * (1 + (Math.random() - 0.5) * (0.08 + p.lbmStrokeJitter * 0.22)),
      ...seed,
    });
  }

  return particles;
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
    this._replaySeedEvents = [];
    this._replayStepHistory = [];
    this._replayTime = 0;
  }

  async init() {
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
    const currentParams = this.app.getP();
    if (!this._updateSimulator('preview', currentParams)) return;
    const prevCount = this.sim.getParticleCount();
    if (!this._active && prevCount <= 0) {
      this._lastFrameElapsed = elapsed;
      return;
    }
    let dt = this._lastFrameElapsed == null ? 1 / 60 : elapsed - this._lastFrameElapsed;
    this._lastFrameElapsed = elapsed;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
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
      this._resetSimulatorState();
      this._resetReplayCapture();
    }
  }

  _renderFinalPass(sourceParams) {
    if (!this._finalSim || !this._replaySeedEvents.length || !this._replayStepHistory.length) return;
    if (!this._updateSimulator('final', sourceParams)) return;
    this._finalSim.clearParticles();
    let replayTime = 0;
    let seedIndex = 0;
    const flushSeeds = () => {
      while (seedIndex < this._replaySeedEvents.length && this._replaySeedEvents[seedIndex].time <= replayTime + 1e-6) {
        this._finalSim.addParticles(this._replaySeedEvents[seedIndex].particles);
        seedIndex += 1;
      }
    };
    flushSeeds();
    for (const dt of this._replayStepHistory) {
      this._finalSim.step(dt);
      replayTime += dt;
      flushSeeds();
    }
    let guard = 0;
    while (this._finalSim.getParticleCount() > 0 && guard < FLUID_FINAL_PASS_MAX_SETTLING_STEPS) {
      this._finalSim.step(1 / 60);
      guard += 1;
    }
    this._depositFrameFromSim(this._finalSim);
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
  getStatusInfo() { return 'Eraser'; }
  deactivate() { this._inner.deactivate(); }
}

// =============================================================================
// AI DIFFUSION BRUSH — Captures canvas region, sends to SD server for inpainting
//
// Phase A: Stub implementation using placeholder stamps. Capture + mask pipeline
// fully functional; server calls replaced with tinted preview.
// =============================================================================

export class AIDiffusionBrush {
  constructor(app) {
    this.app = app;
    // Stamp queue for continuous mode
    this._queue = [];
    this._pending = []; // { x, y, promise, startTime }
    this._maxPending = 3;
    // Reusable 512×512 canvases for capture/mask
    this._captureCanvas = document.createElement('canvas');
    this._captureCanvas.width = 512;
    this._captureCanvas.height = 512;
    this._captureCtx = this._captureCanvas.getContext('2d');
    this._maskCanvas = document.createElement('canvas');
    this._maskCanvas.width = 512;
    this._maskCanvas.height = 512;
    this._maskCtx = this._maskCanvas.getContext('2d');
    // Result temp canvas (sized to stamp)
    this._resultCanvas = document.createElement('canvas');
    this._resultCtx = this._resultCanvas.getContext('2d');
    // Continuous mode timer
    this._lastStampTime = 0;
    this._lastStampX = null;
    this._lastStampY = null;
  }

  /**
   * Capture a square region from the canvas centered at (cx, cy), resized to 512×512.
   * @param {number} cx - Center X in canvas coords
   * @param {number} cy - Center Y in canvas coords
   * @param {number} size - Region size in canvas pixels
   * @param {string} source - 'visible' or 'active'
   * @returns {HTMLCanvasElement} 512×512 captured image
   */
  captureRegion(cx, cy, size, source) {
    const app = this.app;
    const half = size / 2;
    const sx = cx - half, sy = cy - half;
    const ctx = this._captureCtx;
    ctx.clearRect(0, 0, 512, 512);

    if (source === 'active') {
      const layer = app.getActiveLayer();
      const dpr = app.DPR;
      ctx.drawImage(layer.canvas,
        sx * dpr, sy * dpr, size * dpr, size * dpr,
        0, 0, 512, 512);
    } else {
      // Visible composite — use the composite display canvas
      const dpr = app.DPR;
      ctx.drawImage(app.compositeCanvas,
        sx * dpr, sy * dpr, size * dpr, size * dpr,
        0, 0, 512, 512);
    }
    return this._captureCanvas;
  }

  /**
   * Build a 512×512 circular soft-edged mask (white = inpaint area).
   * @param {number} feather - Feather width in 512-space pixels (0 = hard edge)
   * @returns {HTMLCanvasElement} 512×512 mask
   */
  buildMask(feather) {
    const ctx = this._maskCtx;
    ctx.clearRect(0, 0, 512, 512);
    const cx = 256, cy = 256;
    const outerR = 220; // leave some border for context
    const innerR = Math.max(0, outerR - feather);

    if (feather > 0) {
      const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
      grad.addColorStop(0, '#fff');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 512, 512);
      // Fill solid inner circle
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.fill();
    }
    return this._maskCanvas;
  }

  /**
   * Stamp a result image onto the active layer at (cx, cy) with the given size.
   * Uses the mask to blend edges via globalCompositeOperation.
   */
  stampResult(resultImg, cx, cy, targetSize) {
    const app = this.app;
    const layer = app.getActiveLayer();
    const ctx = layer.ctx;
    const half = targetSize / 2;

    // Draw result image clipped by circular mask
    const rc = this._resultCanvas;
    const rctx = this._resultCtx;
    rc.width = targetSize;
    rc.height = targetSize;
    rctx.clearRect(0, 0, targetSize, targetSize);

    // Draw circular clip path
    rctx.save();
    rctx.beginPath();
    rctx.arc(targetSize / 2, targetSize / 2, targetSize / 2, 0, Math.PI * 2);
    rctx.clip();
    rctx.drawImage(resultImg, 0, 0, targetSize, targetSize);
    rctx.restore();

    // Stamp onto layer (use symmetry if enabled)
    const points = app.getSymmetryPoints(cx, cy);
    for (const pt of points) {
      ctx.drawImage(rc, pt.x - half, pt.y - half, targetSize, targetSize);
    }

    layer.dirty = true;
    app.compositeAllLayers();
  }

  /**
   * Convert a canvas to a base64 data URL.
   */
  _canvasToB64(canvas) {
    return canvas.toDataURL('image/png');
  }

  /**
   * Request an AI-generated stamp from the server, or fall back to placeholder.
   */
  _requestStamp(cx, cy, p) {
    const stampSize = p.aiStampSize || 80;
    const feather = p.maskFeather || 20;
    const source = p.aiInputSource || 'visible';
    const server = this.app.aiServer;

    // Capture + mask (always needed)
    this.captureRegion(cx, cy, stampSize, source);
    this.buildMask(feather);

    if (!server || server.state !== 'connected') {
      // Fallback: placeholder stamp
      this._placeholderStamp(cx, cy, p);
      return;
    }

    // Drop oldest pending if at cap
    if (this._pending.length >= this._maxPending) {
      this._pending.shift();
    }

    const imageB64 = this._canvasToB64(this._captureCanvas);
    const maskB64 = this._canvasToB64(this._maskCanvas);

    const seed = p.aiRandomSeed ? -1 : (p.aiSeed || 42);

    const entry = {
      x: cx, y: cy, stampSize,
      startTime: performance.now(),
      promise: server.inpaint({
        imageBase64: imageB64,
        maskBase64: maskB64,
        prompt: p.aiPrompt || '',
        negativePrompt: p.aiNegPrompt || '',
        steps: p.aiSteps || 2,
        strength: p.aiStrength ?? 0.8,
        guidanceScale: p.aiGuidance ?? 7.5,
        seed,
      }).then(result => {
        entry.result = result;
      }).catch(err => {
        entry.error = err;
      }),
      result: null,
      error: null,
    };
    this._pending.push(entry);
  }

  /**
   * Generate a placeholder stamp (no server / offline fallback).
   */
  _placeholderStamp(cx, cy, p) {
    const stampSize = p.aiStampSize || 80;

    // Create a visible placeholder: solid color fill + crosshatch
    const tc = document.createElement('canvas');
    tc.width = 512; tc.height = 512;
    const tctx = tc.getContext('2d');

    // Solid fill with primary color
    tctx.globalAlpha = 0.35;
    tctx.fillStyle = p.color || '#4a7af5';
    tctx.fillRect(0, 0, 512, 512);

    // Visible crosshatch pattern to indicate placeholder
    tctx.globalAlpha = 0.5;
    tctx.strokeStyle = '#ffffff';
    tctx.lineWidth = 1.5;
    for (let i = -512; i < 1024; i += 20) {
      tctx.beginPath(); tctx.moveTo(i, 0); tctx.lineTo(i + 512, 512); tctx.stroke();
      tctx.beginPath(); tctx.moveTo(i, 512); tctx.lineTo(i + 512, 0); tctx.stroke();
    }
    tctx.globalAlpha = 1;

    this.stampResult(tc, cx, cy, stampSize);
  }

  onDown(x, y, pressure) {
    const p = this.app.getP();

    // Push undo
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }

    // Stamp immediately
    this._requestStamp(x, y, p);
    this._lastStampX = x;
    this._lastStampY = y;
    this._lastStampTime = performance.now();
  }

  onMove(x, y, pressure) {
    const p = this.app.getP();
    const mode = p.aiMode || 'continuous';
    if (mode !== 'continuous') return;

    const dx = x - (this._lastStampX ?? x);
    const dy = y - (this._lastStampY ?? y);
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Spacing slider controls % of stamp size between centres
    const spacing = (p.aiStampSize || 80) * ((p.aiInterval || 30) / 100);

    if (dist >= spacing) {
      this._requestStamp(x, y, p);
      this._lastStampX = x;
      this._lastStampY = y;
    }
  }

  onUp(x, y) {
    this._lastStampX = null;
    this._lastStampY = null;
  }

  onFrame(elapsed) {
    // Process completed server responses
    const done = [];
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const entry = this._pending[i];
      if (entry.result) {
        // Decode and stamp the AI-generated image
        const img = new Image();
        img.onload = () => {
          this.stampResult(img, entry.x, entry.y, entry.stampSize);
        };
        img.src = entry.result.imageBase64.startsWith('data:')
          ? entry.result.imageBase64
          : 'data:image/png;base64,' + entry.result.imageBase64;
        done.push(i);
      } else if (entry.error) {
        // Log error via toast, remove entry
        this.app.showToast('⚠ AI: ' + (entry.error.message || 'Generation failed'));
        done.push(i);
      }
    }
    // Remove processed entries (reverse order to keep indices valid)
    for (const i of done) {
      this._pending.splice(i, 1);
    }
  }

  taperFrame(t, p) {
    // AI brush doesn't support taper
  }

  drawOverlay(ctx, p) {
    const app = this.app;
    // Draw stamp preview circle at cursor
    const stampSize = p.aiStampSize || 80;
    ctx.strokeStyle = 'rgba(74,122,245,0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(app.leaderX, app.leaderY, stampSize / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw pending stamp indicators
    for (const pend of this._pending) {
      const elapsed = performance.now() - pend.startTime;
      const pulse = 0.3 + 0.3 * Math.sin(elapsed / 200);
      ctx.fillStyle = `rgba(74,122,245,${pulse})`;
      ctx.beginPath();
      ctx.arc(pend.x, pend.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  getStatusInfo() {
    const pending = this._pending.length;
    return pending > 0 ? `AI | Pending: ${pending}` : 'AI | Ready';
  }

  deactivate() {
    this._queue = [];
    this._pending = [];
    this._lastStampX = null;
    this._lastStampY = null;
  }
}
