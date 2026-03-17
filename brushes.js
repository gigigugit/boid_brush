// =============================================================================
// brushes.js — Boid, Bristle, Simple, and Eraser brush engines
//
// Each brush implements: onDown(x,y,pressure), onMove(x,y,pressure),
// onUp(x,y), onFrame(elapsed), taperFrame(t,p), drawOverlay(ctx,p),
// getStatusInfo(), deactivate().
// =============================================================================

import { BoidSim } from './wasm-bridge.js';

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

export class BoidBrush {
  constructor(app) {
    this.app = app;
    this.sim = null;
    this._ready = false;
    this._lastStampX = [];
    this._lastStampY = [];
    this._lastSpawnX = 0;
    this._lastSpawnY = 0;
    // Flat-stroke (wet buffer) canvases
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
        10000
      );
      this._ready = true;
    } catch (e) {
      console.error('BoidBrush: WASM init failed —', e);
    }
  }

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
  }

  onMove(x, y, pressure) {
    if (!this._ready) return;
    const p = this.app.getP();
    if (p.respawnOnStroke) {
      const dx = x - this._lastSpawnX;
      const dy = y - this._lastSpawnY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = Math.max(p.spawnRadius * 0.5, 8);
      if (dist >= minDist) {
        // Cap total agents at 3× count to prevent infinite accumulation
        // while still allowing a richer trail than a single batch.
        const { count: current } = this.sim.readAgents();
        if (current >= p.count * 3) return;
        let r = p.spawnRadius;
        if (p.pressureSpawnRadius) r *= (0.3 + 0.7 * pressure);
        this.sim.spawnBatch(x, y, p.count, p.spawnShape, p.spawnAngle, p.spawnJitter, r);
        this._lastSpawnX = x;
        this._lastSpawnY = y;
      }
    }
  }

  onUp(x, y) {
    // Boids keep tailing off via taper
  }

  onFrame(elapsed) {
    if (!this._ready) return;
    const p = this.app.getP();
    const app = this.app;

    // Write sim params and step
    this.sim.writeParams(p, app.leaderX, app.leaderY, elapsed);
    this.sim.step(1 / 60);

    // Read agents
    const { buffer, count, stride } = this.sim.readAgents();
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
        }
      } else {
        // First stamp for this agent
        app.symStamp(stampCtx, ax, ay, sz, color, op);
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
    if (!this._ready || !p.showBoids) return;
    const { buffer, count, stride } = this.sim.readAgents();
    ctx.fillStyle = 'rgba(100,180,255,0.6)';
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      ctx.fillRect(buffer[base] - 1, buffer[base + 1] - 1, 2, 2);
    }

    // Draw spawn area indicator
    if (p.showSpawn && this.app.isDrawing) {
      ctx.strokeStyle = 'rgba(100,180,255,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.app.leaderX, this.app.leaderY, p.spawnRadius, 0, Math.PI * 2);
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
    this._count = 0;
    this._lastCursorX = 0;
    this._lastCursorY = 0;
    this._strokeDir = 0; // stroke direction angle
    this._pressure = 0.5;
    this._active = false;
  }

  /** Spawn bristles in a line/fan perpendicular to the initial stroke direction */
  _spawnBristles(x, y, p) {
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
    this._histX = new Array(count);
    this._histY = new Array(count);
    this._varSize = new Array(count);
    this._varOpacity = new Array(count);
    this._varStiffness = new Array(count);
    this._varLength = new Array(count);
    this._varFriction = new Array(count);
    this._varHue = new Array(count);

    const width = p.bristleWidth;
    const spread = p.bristleSpread;

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
      this._rootX[i] = x + perpDx + jx;
      this._rootY[i] = y + perpDy + jy;
      this._tipX[i] = this._rootX[i];
      this._tipY[i] = this._rootY[i];
      this._velX[i] = 0;
      this._velY[i] = 0;
      this._lastStampX[i] = undefined;
      this._lastStampY[i] = undefined;
      // Initialize position history with spawn position
      this._histX[i] = [this._tipX[i], this._tipX[i], this._tipX[i], this._tipX[i]];
      this._histY[i] = [this._tipY[i], this._tipY[i], this._tipY[i], this._tipY[i]];
      // Generate persistent per-bristle variance multipliers (centered around 1.0)
      // Variance 0→no variation, 1→full range (0.0 to 2.0)
      this._varSize[i] = 1 + (Math.random() - 0.5) * 2 * p.bSizeVar;
      this._varOpacity[i] = 1 + (Math.random() - 0.5) * 2 * p.bOpacityVar;
      this._varStiffness[i] = 1 + (Math.random() - 0.5) * 2 * p.bStiffVar;
      this._varLength[i] = 1 + (Math.random() - 0.5) * 2 * p.bLengthVar;
      this._varFriction[i] = 1 + (Math.random() - 0.5) * 2 * p.bFrictionVar;
      this._varHue[i] = (Math.random() - 0.5) * 2 * p.bHueVar * 60; // ±60° at max
    }
  }

  /** Rotate bristle offsets so the spread is perpendicular to stroke direction */
  _updateRoots(x, y, p) {
    const angle = this._strokeDir;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const pressureSplay = p.bristleSplay * (0.5 + 0.5 * this._pressure);

    for (let i = 0; i < this._count; i++) {
      const off = this._offsets[i];
      // Rotate offset to be perpendicular to stroke direction
      // Perpendicular direction: rotate offset by stroke angle + 90°
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
    const length = p.bristleLength;

    for (let i = 0; i < this._count; i++) {
      // Apply per-bristle variance
      const iStiff = stiffness * this._varStiffness[i];
      const iLen = length * this._varLength[i];
      const iFric = friction * this._varFriction[i];

      // Rest position = root position offset by bristle length in stroke direction
      const restX = this._rootX[i];
      const restY = this._rootY[i];

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

  /** Push current tip positions into the per-bristle history ring */
  _pushHistory() {
    for (let i = 0; i < this._count; i++) {
      const hx = this._histX[i];
      const hy = this._histY[i];
      hx[0] = hx[1]; hx[1] = hx[2]; hx[2] = hx[3]; hx[3] = this._tipX[i];
      hy[0] = hy[1]; hy[1] = hy[2]; hy[2] = hy[3]; hy[3] = this._tipY[i];
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
      if (t < 0) t += 1; if (t > 1) t -= 1;
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
    const toHex = v => { const c = Math.round(Math.min(1, Math.max(0, v)) * 255); return c < 16 ? '0' + c.toString(16) : c.toString(16); };
    return '#' + toHex(rr) + toHex(gg) + toHex(bb);
  }

  /** Stamp all bristle tips with Catmull-Rom smoothed interpolation */
  _stampBristles(stampCtx, p, opScale) {
    const app = this.app;
    const smoothing = p.bristleSmoothing;
    for (let i = 0; i < this._count; i++) {
      // Smoothed tip position: blend between raw tip and Catmull-Rom midpoint
      const hx = this._histX[i];
      const hy = this._histY[i];
      const rawX = this._tipX[i];
      const rawY = this._tipY[i];
      // Catmull-Rom evaluated at t=0.5 between hist[1] and hist[2]
      const smoothX = smoothing > 0
        ? rawX * (1 - smoothing) + BristleBrush._catmullRom(hx[0], hx[1], hx[2], hx[3], 0.5) * smoothing
        : rawX;
      const smoothY = smoothing > 0
        ? rawY * (1 - smoothing) + BristleBrush._catmullRom(hy[0], hy[1], hy[2], hy[3], 0.5) * smoothing
        : rawY;
      const tx = smoothX;
      const ty = smoothY;

      let sz = p.stampSize * this._varSize[i];
      let op = p.stampOpacity * opScale * this._varOpacity[i];
      if (p.pressureSize) sz *= (0.3 + 0.7 * this._pressure);
      if (p.pressureOpacity) op *= (0.3 + 0.7 * this._pressure);
      op = Math.min(op, 1);

      // Apply per-bristle hue variance
      const color = this._varHue[i] !== 0
        ? BristleBrush._shiftHue(p.color, this._varHue[i])
        : p.color;

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

        if (smoothing > 0) {
          // Use Catmull-Rom curve for interpolation between stamps
          for (let j = 1; j <= n; j++) {
            const t = j / n;
            const cx = BristleBrush._catmullRom(hx[0], hx[1], hx[2], hx[3], 0.5 + t * 0.5);
            const cy = BristleBrush._catmullRom(hy[0], hy[1], hy[2], hy[3], 0.5 + t * 0.5);
            // Blend between linear and curve
            const lx = prevX + dx * t;
            const ly = prevY + dy * t;
            const sx = lx * (1 - smoothing) + cx * smoothing;
            const sy = ly * (1 - smoothing) + cy * smoothing;
            app.symStamp(stampCtx, sx, sy, sz, color, op);
          }
        } else {
          for (let j = 1; j <= n; j++) {
            const t = j / n;
            app.symStamp(stampCtx, prevX + dx * t, prevY + dy * t, sz, color, op);
          }
        }
      } else {
        app.symStamp(stampCtx, tx, ty, sz, color, op);
      }

      this._lastStampX[i] = tx;
      this._lastStampY[i] = ty;
    }
  }

  onDown(x, y, pressure) {
    const p = this.app.getP();
    this._pressure = pressure;
    this._lastCursorX = x;
    this._lastCursorY = y;
    this._strokeDir = 0;
    this._active = true;
    this.app.strokeFrame = 0;

    // Push undo
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }

    this._spawnBristles(x, y, p);
  }

  onMove(x, y, pressure) {
    if (!this._active) return;
    this._pressure = pressure;

    // Update stroke direction from cursor movement
    const dx = x - this._lastCursorX;
    const dy = y - this._lastCursorY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) {
      // Smooth direction change
      const newDir = Math.atan2(dy, dx);
      const diff = newDir - this._strokeDir;
      // Normalize angle difference to [-PI, PI]
      const wrapped = ((diff + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this._strokeDir += wrapped * 0.3; // smooth blend
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

    // Push tip positions into history for smoothing
    this._pushHistory();

    app.strokeFrame++;

    // Skip lead-in stamps
    const skipN = p.skipStamps || 0;
    if (app.strokeFrame <= skipN) {
      for (let i = 0; i < this._count; i++) {
        this._lastStampX[i] = this._tipX[i];
        this._lastStampY[i] = this._tipY[i];
      }
      return;
    }

    // Stamp bristle tips
    const layer = app.getActiveLayer();
    this._stampBristles(layer.ctx, p, 1.0);

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

    // Push history for smoothing
    this._pushHistory();

    const layer = app.getActiveLayer();
    const smoothing = p.bristleSmoothing;

    // Stamp with fading opacity/size
    for (let i = 0; i < this._count; i++) {
      const hx = this._histX[i];
      const hy = this._histY[i];
      const rawX = this._tipX[i];
      const rawY = this._tipY[i];
      const tx = smoothing > 0
        ? rawX * (1 - smoothing) + BristleBrush._catmullRom(hx[0], hx[1], hx[2], hx[3], 0.5) * smoothing
        : rawX;
      const ty = smoothing > 0
        ? rawY * (1 - smoothing) + BristleBrush._catmullRom(hy[0], hy[1], hy[2], hy[3], 0.5) * smoothing
        : rawY;

      let sz = p.stampSize * this._varSize[i];
      let op = p.stampOpacity * this._varOpacity[i];
      if (p.taperSize) sz *= curve;
      if (p.taperOpacity) op *= curve;
      op = Math.min(op, 1);
      if (op < 0.005 || sz < 0.5) continue;

      const color = this._varHue[i] !== 0
        ? BristleBrush._shiftHue(p.color, this._varHue[i])
        : p.color;

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
        if (smoothing > 0) {
          for (let j = 1; j <= n; j++) {
            const tt = j / n;
            const cx = BristleBrush._catmullRom(hx[0], hx[1], hx[2], hx[3], 0.5 + tt * 0.5);
            const cy = BristleBrush._catmullRom(hy[0], hy[1], hy[2], hy[3], 0.5 + tt * 0.5);
            const lx = prevX + dx * tt;
            const ly = prevY + dy * tt;
            app.symStamp(layer.ctx, lx * (1 - smoothing) + cx * smoothing, ly * (1 - smoothing) + cy * smoothing, sz, color, op);
          }
        } else {
          for (let j = 1; j <= n; j++) {
            const tt = j / n;
            app.symStamp(layer.ctx, prevX + dx * tt, prevY + dy * tt, sz, color, op);
          }
        }
      } else {
        app.symStamp(layer.ctx, tx, ty, sz, color, op);
      }

      this._lastStampX[i] = tx;
      this._lastStampY[i] = ty;
    }

    layer.dirty = true;
    app.compositeAllLayers();
  }

  drawOverlay(ctx, p) {
    if (!p.showBristles || !this._active) return;
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
  }

  getStatusInfo() {
    return `Bristle | Tips: ${this._count}`;
  }

  deactivate() {
    this._count = 0;
    this._active = false;
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
  }

  onDown(x, y, pressure) {
    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }
    this._lastStampX = x;
    this._lastStampY = y;
    this.app.strokeFrame = 0;
    this._stamp(x, y, pressure);
    const layer = this.app.getActiveLayer();
    layer.dirty = true;
    this.app.compositeAllLayers();
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

    const layer = this.app.getActiveLayer();
    layer.dirty = true;
    this.app.compositeAllLayers();
  }

  onUp() {
    this._lastStampX = null;
    this._lastStampY = null;
  }

  onFrame() { /* no per-frame work for simple brush */ }

  taperFrame(t, p) {
    // Simple brush has no ongoing simulation; taper is a no-op
  }

  _stamp(x, y, pressure) {
    const p = this.app.getP();
    const layer = this.app.getActiveLayer();
    const ctx = layer.ctx;
    let sz = p.stampSize;
    let op = p.stampOpacity;
    if (p.pressureSize) sz *= (0.3 + 0.7 * pressure);
    if (p.pressureOpacity) op *= (0.3 + 0.7 * pressure);
    op = Math.min(op, 1);

    this.app.symStamp(ctx, x, y, sz, p.color, op);
    this.app.strokeFrame++;
  }

  drawOverlay() { /* nothing */ }
  getStatusInfo() { return 'Simple'; }
  deactivate() {}
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

  onDown(x, y, pr) { this._inner.onDown(x, y, pr); }
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
