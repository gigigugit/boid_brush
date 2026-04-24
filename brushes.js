// =============================================================================
// brushes.js — Boid, Ant, Bristle, Fluid, Simple, and Eraser brush engines
//
// Each brush implements: onDown(x,y,pressure), onMove(x,y,pressure),
// onUp(x,y), onFrame(elapsed), taperFrame(t,p), drawOverlay(ctx,p),
// getStatusInfo(), deactivate().
// =============================================================================

import { BoidSim } from './wasm-bridge.js';

// Pressure EMA alpha for BristleBrush (~6-frame smoothing window)
const BRISTLE_PRESSURE_ALPHA = 0.15;
// Max EMA damping: smoothing=1 → alpha = 1 - MAX_SMOOTH_DAMP ≈ 0.08
const MAX_SMOOTH_DAMP = 0.92;
// Low-pass filter strength for Pencil angle changes (higher = snappier, lower = smoother)
const BRISTLE_ANGLE_ALPHA = 0.16;
// Maximum pheromone intensity (maps to Uint8 luminance for sensing upload)
const MAX_PHEROMONE = 255;
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
 * @param {number} texScale - texture tiling scale (CSS-pixel units)
 */
function _applyTextureFlow(ctx, canvas, app, flow, texScale) {
  const texW = app._canvasTextureW;
  const texH = app._canvasTextureH;
  const tex  = app._canvasTextureData;
  if (!tex || texW <= 0 || texH <= 0 || texScale <= 0 || flow <= 0) return;

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
  const invScale = 1 / texScale;
  // Maximum pixel shift per iteration (1–4 device pixels depending on strength)
  const shift = Math.max(1, Math.round(flow * 4 * dpr));
  const margin = shift;

  for (let py = margin; py < h - margin; py++) {
    for (let px = margin; px < w - margin; px++) {
      const idx = (py * w + px) << 2;
      if (src[idx + 3] < 2) continue; // skip transparent

      // Convert device px → CSS px → texture UV
      const cx = px * invDpr * invScale;
      const cy = py * invDpr * invScale;
      const st = invDpr * invScale; // one device-pixel step in texture coords

      // Inline texture lookups for 4-connected neighbours
      const ixC = ((Math.floor(cx)      % texW) + texW) % texW;
      const iyC = ((Math.floor(cy)      % texH) + texH) % texH;
      const ixL = ((Math.floor(cx - st) % texW) + texW) % texW;
      const ixR = ((Math.floor(cx + st) % texW) + texW) % texW;
      const iyU = ((Math.floor(cy - st) % texH) + texH) % texH;
      const iyD = ((Math.floor(cy + st) % texH) + texH) % texH;

      const hL = tex[iyC * texW + ixL];
      const hR = tex[iyC * texW + ixR];
      const hU = tex[iyU * texW + ixC];
      const hD = tex[iyD * texW + ixC];

      // Gradient (positive = toward higher values)
      const gx = hR - hL;
      const gy = hD - hU;
      const lenSq = gx * gx + gy * gy;
      if (lenSq < 100) continue; // skip near-flat regions

      const invLen = 1 / Math.sqrt(lenSq);
      // Flow direction = negative gradient (toward lower height)
      const fx = Math.round(-gx * invLen * shift);
      const fy = Math.round(-gy * invLen * shift);

      const tx = px + fx;
      const ty = py + fy;
      // Bounds already guaranteed by margin
      const tidx = (ty * w + tx) << 2;

      // Transfer fraction proportional to gradient steepness × flow strength
      // tex[] stores 0–255 greyscale values; normalize by 255 to get 0–~1.4 range
      const steepness = Math.sqrt(lenSq) / 255;
      const t = Math.min(flow * steepness * 0.3, 0.4); // capped

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

function _sampleTextureFlowVector(app, x, y, texScale) {
  const texW = app._canvasTextureW;
  const texH = app._canvasTextureH;
  const tex = app._canvasTextureData;
  if (!tex || texW <= 0 || texH <= 0 || texScale <= 0) return { x: 0, y: 0 };

  const cx = x / texScale;
  const cy = y / texScale;
  const ix = ((Math.floor(cx) % texW) + texW) % texW;
  const iy = ((Math.floor(cy) % texH) + texH) % texH;
  const ixL = ((ix - 1) % texW + texW) % texW;
  const ixR = (ix + 1) % texW;
  const iyU = ((iy - 1) % texH + texH) % texH;
  const iyD = (iy + 1) % texH;
  const gx = tex[iy * texW + ixR] - tex[iy * texW + ixL];
  const gy = tex[iyD * texW + ix] - tex[iyU * texW + ix];
  const len = Math.hypot(gx, gy);
  if (len < 1e-3) return { x: 0, y: 0 };
  return { x: -gx / len, y: -gy / len };
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
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p.canvasTextureScale);
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
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p.canvasTextureScale);
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
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p.canvasTextureScale);
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
        _applyTextureFlow(this._blurCtx, this._blurCanvas, app, p.trailFlow, p.canvasTextureScale);
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
// FLUID BRUSH — Particle-based wet paint dragged by the brush
// =============================================================================

export class FluidBrush {
  constructor(app) {
    this.app = app;
    this._particles = [];
    this._active = false;
    this._lastX = null;
    this._lastY = null;
    this._lastFrameElapsed = null;
    this._blurCanvas = null;
    this._blurCtx = null;
    this._blurTmpCanvas = null;
    this._blurTmpCtx = null;
    this._blurStrokeCanvas = null;
    this._blurStrokeCtx = null;
  }

  onDown(x, y, pressure) {
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }
    this._active = true;
    this._lastX = x;
    this._lastY = y;
    this._lastFrameElapsed = null;
    this.app.strokeFrame = 0;
    this._injectAt(x, y, pressure, 0, 0, true);
  }

  onMove(x, y, pressure) {
    if (this._lastX == null || this._lastY == null) {
      this._lastX = x;
      this._lastY = y;
      return;
    }
    const dx = x - this._lastX;
    const dy = y - this._lastY;
    const dist = Math.hypot(dx, dy);
    const p = this.app.getP();
    const step = Math.max(2, p.fluidBrushRadius * 0.3);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this._injectAt(
        this._lastX + dx * t,
        this._lastY + dy * t,
        pressure,
        dx / n,
        dy / n
      );
    }
    this._lastX = x;
    this._lastY = y;
  }

  onUp() {
    this._active = false;
    this._lastX = null;
    this._lastY = null;
  }

  onFrame(elapsed) {
    this._step(elapsed);
  }

  onHoverFrame(elapsed) {
    this._step(elapsed);
  }

  taperFrame() {
    // Fluid particles keep moving in onHoverFrame after stroke end.
  }

  _injectAt(x, y, pressure, dx, dy, forceStamp = false) {
    const p = this.app.getP();
    const radius = Math.max(4, p.fluidBrushRadius);
    const emit = Math.max(1, Math.round(p.fluidEmitRate * (0.35 + pressure * 0.65)));
    const len = Math.hypot(dx, dy);
    const motion = Math.min(1.4, len / Math.max(1, radius * 0.45));
    const pushX = dx * p.fluidBrushForce * 0.12;
    const pushY = dy * p.fluidBrushForce * 0.12;
    const impact = p.fluidImpact * (0.25 + Math.min(1, pressure) * 0.45 + Math.min(1, motion) * 0.45);
    // Perpendicular (lateral) direction to stroke — zero when there is no motion
    const latX = len > 1e-4 ? -dy / len : 0;
    const latY = len > 1e-4 ? dx / len : 0;
    const latScale = p.fluidLateralSpread * 0.1;
    const splashRadius = radius * (0.35 + p.fluidSplashRadius * 0.9);
    const burstSpeed = impact * (2.6 + splashRadius * 0.03);
    const breakupChance = _clamp(p.fluidBreakup * (0.05 + motion * 0.24 + pressure * 0.18), 0, 0.75);

    for (let i = 0; i < this._particles.length; i++) {
      const part = this._particles[i];
      const ox = part.x - x;
      const oy = part.y - y;
      const d = Math.hypot(ox, oy);
      if (d > radius || d < 1e-4) continue;
      const falloff = 1 - d / radius;
      const swirl = p.fluidSpread * 0.028 * falloff;
      const radialX = ox / d;
      const radialY = oy / d;
      const burst = burstSpeed * (0.3 + falloff * 0.7);
      part.vx += pushX * falloff + radialX * burst + (-oy / d) * swirl;
      part.vy += pushY * falloff + radialY * burst + (ox / d) * swirl;
      // Lateral (sideways) impulse on existing particles so they spread during stroke
      if (latScale > 0) {
        const lat = (Math.random() * 2 - 1) * latScale * falloff;
        part.vx += latX * lat;
        part.vy += latY * lat;
      }
      part.wetness = Math.min(1, part.wetness + 0.02 * falloff);
      part.pressure = Math.max(part.pressure || 0, pressure);
      part.pool = _clamp((part.pool || 0) + p.fluidPooling * 0.045 * falloff, 0, 1.6);
      part.edge = Math.max(part.edge || 0, p.fluidEdgeBleed * falloff);
      part.splash = Math.max(part.splash || 0, impact * falloff);
    }

    const spread = splashRadius;
    const layer = this.app.getActiveLayer();
    for (let i = 0; i < emit; i++) {
      const ang = Math.random() * Math.PI * 2;
      const crown = Math.random() < 0.4 + impact * 0.35;
      const rim = crown
        ? 0.55 + Math.random() * 0.45
        : Math.pow(Math.random(), 0.7);
      const mag = rim * spread;
      const radialX = Math.cos(ang);
      const radialY = Math.sin(ang);
      const radialVel = burstSpeed * (0.55 + Math.random() * 0.9) * (crown ? 1.15 : 0.8);
      const tangential = (Math.random() - 0.5) * p.fluidLateralSpread * 0.035;
      // Lateral velocity for new particles — perpendicular to stroke direction
      const lat = (Math.random() * 2 - 1) * latScale;
      const breakup = Math.random() < breakupChance;
      const size = breakup ? 0.28 + Math.random() * 0.34 : 0.62 + Math.random() * 0.82;
      const wetness = breakup ? 0.28 + Math.random() * 0.28 : 0.58 + Math.random() * 0.42;
      this._particles.push({
        x: x + radialX * mag,
        y: y + radialY * mag,
        vx: pushX + radialX * radialVel + latX * lat - radialY * tangential + (Math.random() - 0.5) * p.fluidSpread * 0.08,
        vy: pushY + radialY * radialVel + latY * lat + radialX * tangential + (Math.random() - 0.5) * p.fluidSpread * 0.08,
        wetness,
        size,
        pressure,
        color: p.color,
        layer,
        pool: _clamp(p.fluidPooling * (breakup ? 0.18 : 0.55 + Math.random() * 0.55), 0, 1.6),
        edge: crown ? (0.35 + p.fluidEdgeBleed * 0.65) : p.fluidEdgeBleed * 0.28,
        splash: impact * (crown ? 1 : 0.65),
      });
    }

    const overflow = this._particles.length - p.fluidParticleLimit;
    if (overflow > 0) this._particles.splice(0, overflow);
    if (forceStamp) this._stampFrame(p);
  }

  _step(elapsed) {
    if (!this._particles.length) {
      this._lastFrameElapsed = elapsed;
      return;
    }
    let dt = this._lastFrameElapsed == null ? 1 / 60 : elapsed - this._lastFrameElapsed;
    this._lastFrameElapsed = elapsed;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.05);

    const p = this.app.getP();
    const steps = Math.max(1, Math.ceil(dt * 90));
    const subDt = dt / steps;
    const cellSize = Math.max(8, p.fluidBrushRadius * 0.45);
    const damping = Math.pow(Math.max(0.0001, p.fluidVelocityDamping), subDt * 60);
    const evaporation = Math.max(0, 1 - p.fluidEvaporation * subDt * 60);

    for (let step = 0; step < steps; step++) {
      const cells = new Map();
      for (let i = 0; i < this._particles.length; i++) {
        const part = this._particles[i];
        const key = `${Math.floor(part.x / cellSize)},${Math.floor(part.y / cellSize)}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = { vx: 0, vy: 0, x: 0, y: 0, wet: 0, count: 0 };
          cells.set(key, cell);
        }
        cell.vx += part.vx;
        cell.vy += part.vy;
        cell.x += part.x;
        cell.y += part.y;
        cell.wet += part.wetness;
        cell.count++;
      }

      for (let i = this._particles.length - 1; i >= 0; i--) {
        const part = this._particles[i];
        const cellX = Math.floor(part.x / cellSize);
        const cellY = Math.floor(part.y / cellSize);
        const key = `${cellX},${cellY}`;
        const cell = cells.get(key);
        let flowVX = 0;
        let flowVY = 0;
        let flowWeight = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nearby = cells.get(`${cellX + ox},${cellY + oy}`);
            if (!nearby || nearby.count <= 0) continue;
            const weight = 1 / (1 + Math.abs(ox) + Math.abs(oy));
            flowVX += (nearby.vx / nearby.count) * weight;
            flowVY += (nearby.vy / nearby.count) * weight;
            flowWeight += weight;
          }
        }
        if (flowWeight > 0) {
          const avx = flowVX / flowWeight;
          const avy = flowVY / flowWeight;
          const blend = 0.05 + p.fluidViscosity * 0.22;
          part.vx += (avx - part.vx) * blend;
          part.vy += (avy - part.vy) * blend;
        }
        if (cell && cell.count > 0) {
          const centerX = cell.x / cell.count;
          const centerY = cell.y / cell.count;
          const toCenterX = centerX - part.x;
          const toCenterY = centerY - part.y;
          const centerDist = Math.hypot(toCenterX, toCenterY);
          const density = Math.min(1.6, cell.count / 7);
          part.vx += toCenterX * p.fluidPooling * density * 0.008;
          part.vy += toCenterY * p.fluidPooling * density * 0.008;
          if (centerDist > 1e-4) {
            const edgeFactor = _clamp(centerDist / (cellSize * 0.85), 0, 1);
            const edgePush = p.fluidImpact * p.fluidSplashRadius * density * edgeFactor * (0.08 + (part.edge || 0) * 0.08);
            part.vx -= (toCenterX / centerDist) * edgePush;
            part.vy -= (toCenterY / centerDist) * edgePush;
          }
          const speed = Math.hypot(part.vx, part.vy);
          part.pool = _clamp((part.pool || 0) + p.fluidPooling * part.wetness * 0.02 - speed * 0.0015, 0, 1.8);
          part.edge = _clamp((part.edge || 0) * 0.94 + p.fluidEdgeBleed * density * 0.05, 0, 1.4);
        }
        if (p.canvasTextureEnabled && p.fluidTextureFollow > 0) {
          const flow = _sampleTextureFlowVector(this.app, part.x, part.y, p.canvasTextureScale);
          part.vx += flow.x * p.fluidTextureFollow * 0.7;
          part.vy += flow.y * p.fluidTextureFollow * 0.7;
        }
        part.vx += (Math.random() - 0.5) * p.fluidSpread * (0.01 + p.fluidBreakup * 0.012);
        part.vy += (Math.random() - 0.5) * p.fluidSpread * (0.01 + p.fluidBreakup * 0.012);
        part.vx *= damping;
        part.vy *= damping;
        const poolDrag = Math.max(0.72, 1 - (part.pool || 0) * p.fluidPooling * 0.08);
        part.vx *= poolDrag;
        part.vy *= poolDrag;
        const prevX = part.x;
        const prevY = part.y;
        part.x += part.vx * p.fluidFlow * subDt * 60;
        part.y += part.vy * p.fluidFlow * subDt * 60;
        if (part.x < 0 || part.x > this.app.W) {
          part.x = _clamp(part.x, 0, this.app.W);
          part.vx *= -0.28;
        }
        if (part.y < 0 || part.y > this.app.H) {
          part.y = _clamp(part.y, 0, this.app.H);
          part.vy *= -0.28;
        }
        part.prevX = prevX;
        part.prevY = prevY;
        part.splash = Math.max(0, (part.splash || 0) * (0.9 - p.fluidImpact * 0.08));
        part.wetness *= Math.min(1, evaporation + (part.pool || 0) * p.fluidPooling * 0.016);
        if (part.wetness < 0.025) this._particles.splice(i, 1);
      }
    }

    this._stampFrame(p);
  }

  _stampFrame(p) {
    if (!this._particles.length) return;
    const blurEnabled = p.trailBlur > 0;
    const blurCtx = blurEnabled ? this._prepareBlurFrame() : null;
    const touched = new Set();

    for (let i = 0; i < this._particles.length; i++) {
      const part = this._particles[i];
      if (!part.layer || !this.app.layers.includes(part.layer)) continue;
      const ctx = part.layer.ctx;
      touched.add(part.layer);
      const pressureScale = p.pressureSize ? (0.3 + 0.7 * (part.pressure || 1)) : 1;
      const opacityScale = p.pressureOpacity ? (0.3 + 0.7 * (part.pressure || 1)) : 1;
      const size = Math.max(1, p.stampSize * pressureScale * part.size * (0.45 + part.wetness * 0.75));
      const opacity = Math.min(1, p.stampOpacity * p.fluidDeposit * part.wetness * opacityScale);
      const trailOpacity = opacity * (0.2 + (1 - p.fluidPooling) * 0.35 + (part.splash || 0) * 0.12);
      const poolRadius = Math.max(size * 0.55, size * (0.7 + p.fluidPooling * 0.55 + (part.pool || 0) * 0.35));
      const poolOpacity = Math.min(1, opacity * (0.28 + p.fluidPooling * 0.34 + (part.pool || 0) * 0.22));
      const edgeOpacity = Math.min(0.55, opacity * p.fluidEdgeBleed * (0.18 + (part.edge || 0) * 0.32));
      const fromX = part.prevX ?? part.x;
      const fromY = part.prevY ?? part.y;
      const dx = part.x - fromX;
      const dy = part.y - fromY;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, size * 0.28);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let j = 1; j <= n; j++) {
        const t = j / n;
        const sx = fromX + dx * t;
        const sy = fromY + dy * t;
        this.app.symStamp(ctx, sx, sy, size, part.color, trailOpacity);
        if (blurCtx) _stampToBlurAccum(blurCtx, this.app, sx, sy, size, part.color, trailOpacity);
      }
      _fillRadialPool(ctx, this.app, part.x, part.y, poolRadius, part.color, poolOpacity);
      if (blurCtx) _stampToBlurAccum(blurCtx, this.app, part.x, part.y, poolRadius * 1.05, part.color, Math.min(0.85, poolOpacity * 0.55));
      _strokePoolRing(
        ctx,
        this.app,
        part.x,
        part.y,
        poolRadius * (0.68 + p.fluidEdgeBleed * 0.16),
        part.color,
        edgeOpacity,
        Math.max(0.75, poolRadius * (0.06 + p.fluidEdgeBleed * 0.05))
      );
      part.prevX = part.x;
      part.prevY = part.y;
      this.app.strokeFrame++;
    }

    if (blurCtx && touched.size) this._applyBlurFrame(touched, p);
    if (touched.size) {
      touched.forEach(layer => { layer.dirty = true; });
      this.app.compositeAllLayers();
    }
  }

  _prepareBlurFrame() {
    const layer = this.app.getActiveLayer();
    if (!layer) return null;
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    if (!this._blurStrokeCanvas || this._blurStrokeCanvas.width !== w || this._blurStrokeCanvas.height !== h) {
      this._blurStrokeCanvas = document.createElement('canvas');
      this._blurStrokeCanvas.width = w;
      this._blurStrokeCanvas.height = h;
      this._blurStrokeCtx = this._blurStrokeCanvas.getContext('2d');
    }
    this._blurStrokeCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._blurStrokeCtx.clearRect(0, 0, w, h);
    this._blurStrokeCtx.setTransform(this.app.DPR, 0, 0, this.app.DPR, 0, 0);
    return this._blurStrokeCtx;
  }

  _applyBlurFrame(touched, p) {
    const layer = this.app.getActiveLayer();
    if (!layer) return;
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    if (!this._blurCanvas || this._blurCanvas.width !== w || this._blurCanvas.height !== h) {
      this._blurCanvas = document.createElement('canvas');
      this._blurCanvas.width = w;
      this._blurCanvas.height = h;
      this._blurCtx = this._blurCanvas.getContext('2d');
      this._blurTmpCanvas = document.createElement('canvas');
      this._blurTmpCanvas.width = w;
      this._blurTmpCanvas.height = h;
      this._blurTmpCtx = this._blurTmpCanvas.getContext('2d');
    }
    this._blurCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._blurCtx.clearRect(0, 0, w, h);
    this._blurCtx.drawImage(this._blurStrokeCanvas, 0, 0);
    if (p.trailFlow > 0 && p.canvasTextureEnabled) {
      _applyTextureFlow(this._blurCtx, this._blurCanvas, this.app, p.trailFlow, p.canvasTextureScale);
    }
    this._blurTmpCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._blurTmpCtx.clearRect(0, 0, w, h);
    this._blurTmpCtx.filter = `blur(${p.trailBlur * this.app.DPR}px)`;
    this._blurTmpCtx.drawImage(this._blurCanvas, 0, 0);
    this._blurTmpCtx.filter = 'none';
    touched.forEach(layerRef => {
      if (!layerRef?.ctx) return;
      layerRef.ctx.save();
      layerRef.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layerRef.ctx.globalAlpha = 0.16;
      layerRef.ctx.drawImage(this._blurTmpCanvas, 0, 0);
      layerRef.ctx.globalAlpha = 1;
      layerRef.ctx.restore();
    });
  }

  drawOverlay(ctx, p) {
    if (!p.fluidShowParticles) return;
    ctx.save();
    ctx.fillStyle = 'rgba(120,190,255,0.45)';
    for (let i = 0; i < this._particles.length; i++) {
      const part = this._particles[i];
      ctx.globalAlpha = Math.max(0.08, Math.min(0.65, part.wetness * 0.65));
      ctx.fillRect(part.x - 1, part.y - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(120,190,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.app.leaderX, this.app.leaderY, p.fluidBrushRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  getStatusInfo() {
    return `Fluid | Drops: ${this._particles.length}`;
  }

  deactivate() {
    this._active = false;
    this._lastX = null;
    this._lastY = null;
    this._lastFrameElapsed = null;
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
