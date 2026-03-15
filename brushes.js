// =============================================================================
// brushes.js — Boid, Simple, and Eraser brush engines
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
