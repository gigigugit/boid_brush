// =============================================================================
// fluid_advect.js — BlobAdvectBrush
//
// A grid-based, low-resolution Eulerian advection brush (no particles).
// While the pointer is held, a soft blob mask is painted on an offscreen canvas.
// On pointer release the pixels inside the blob are read from the active layer,
// downsampled to a compact simulation grid, and then advected each frame using:
//   • Semi-Lagrangian advection  (unconditionally stable)
//   • Time-varying curl noise    (keeps motion alive after release)
//   • Optional velocity diffusion (viscosity)
//   • Jacobi pressure projection  (approximate incompressibility)
//   • Dye diffusion              (wide-range diffusion knob)
//   • Hard mask clipping         (no pixel bleeds outside the blob)
//
// The advected state is composited on the live canvas for a real-time preview.
// On commit (auto after runTime seconds, or on next onDown / deactivate) the
// result is blended back into the active layer using the soft mask as the blend
// weight, then the Compositor is notified.
//
// Integration with existing app:
//   • Works with both WebGL2 Compositor and 2-D CSS fallback.
//   • Does not touch any other brush.
//   • All parameters flow through app.getP().
// =============================================================================

// ── Noise helpers ─────────────────────────────────────────────────────────────

function _hn(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function _ss(t) {
  return t * t * (3.0 - 2.0 * t); // smoothstep
}

/** 2-D value noise at fractional grid coordinates (sx, sy). */
function _vn(sx, sy) {
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const tx = _ss(sx - x0), ty = _ss(sy - y0);
  return _hn(x0,   y0)   * (1 - tx) * (1 - ty)
       + _hn(x0+1, y0)   * tx       * (1 - ty)
       + _hn(x0,   y0+1) * (1 - tx) * ty
       + _hn(x0+1, y0+1) * tx       * ty;
}

// ── Bilinear interpolation ────────────────────────────────────────────────────

/**
 * Bilinear sample from Float32Array field of size (w × h).
 * Clamps coordinates to the valid range (Neumann boundary).
 */
function _bilerp(f, x, y, w, h) {
  const cx = x < 0 ? 0 : (x > w - 1.001 ? w - 1.001 : x);
  const cy = y < 0 ? 0 : (y > h - 1.001 ? h - 1.001 : y);
  const x0 = cx | 0, y0 = cy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = cx - x0, fy = cy - y0;
  const i00 = y0 * w + x0, i10 = y0 * w + x1;
  const i01 = y1 * w + x0, i11 = y1 * w + x1;
  return f[i00] * (1-fx) * (1-fy)
       + f[i10] * fx     * (1-fy)
       + f[i01] * (1-fx) * fy
       + f[i11] * fx     * fy;
}

// ── BlobAdvectBrush ───────────────────────────────────────────────────────────

export class BlobAdvectBrush {
  constructor(app) {
    this.app = app;

    // ── stroke / mask state ──
    this._active      = false;
    this._strokeLayer = null;   // layer captured at onDown

    // Mask canvas (full CSS-pixel resolution, matches layer)
    this._maskCanvas = document.createElement('canvas');
    this._maskCtx    = this._maskCanvas.getContext('2d', { willReadFrequently: true });

    // Last mask-paint positions (for interpolated circles along stroke)
    this._lastMaskX = null;
    this._lastMaskY = null;

    // ── sim state ──
    this._simRunning = false;
    this._simTime    = 0;
    this._bbox       = null;   // { x, y, w, h } in CSS pixels
    this._simW       = 0;
    this._simH       = 0;

    // Velocity (two-buffer ping-pong)
    this._u    = null; this._uBuf = null;
    this._v    = null; this._vBuf = null;

    // Premultiplied RGBA dye (two-buffer ping-pong)
    this._r    = null; this._rBuf = null;
    this._g    = null; this._gBuf = null;
    this._b    = null; this._bBuf = null;
    this._a    = null; this._aBuf = null;

    // Mask alpha at sim resolution
    this._mask = null;

    // Pressure / divergence scratch (reused each step, single buffer is fine
    // because Jacobi iteration reads and writes in alternating passes over
    // a separate temporary array allocated once in _projectVelocity).
    this._pres = null;
    this._div  = null;

    // ── pointer velocity (CSS px / s) tracked for initial impulse ──
    this._ptrX    = 0;
    this._ptrY    = 0;
    this._ptrVX   = 0;
    this._ptrVY   = 0;
    this._lastPtrTime = 0;

    // ── frame timing ──
    this._lastElapsed = null;

    // ── preview (CSS-pixel sized canvas; drawn in drawOverlay each frame) ──
    this._previewCanvas = document.createElement('canvas');
    this._previewCtx    = this._previewCanvas.getContext('2d');

    // Small canvas at sim resolution used to build the preview image
    this._simPixCanvas = document.createElement('canvas');
    this._simPixCtx    = this._simPixCanvas.getContext('2d');
  }

  // ── Brush lifecycle ─────────────────────────────────────────────────────────

  onDown(x, y, pressure) {
    // Commit any running sim before starting a new stroke
    if (this._simRunning) this._commit();

    if (!this.app.undoPushedThisStroke) {
      this.app.pushUndo();
      this.app.undoPushedThisStroke = true;
    }

    this._active      = true;
    this._strokeLayer = this.app.getActiveLayer();
    this._simRunning  = false;
    this._simTime     = 0;
    this._lastElapsed = null;

    // Reset / resize mask canvas to match layer CSS dimensions
    this._ensureMaskCanvas();
    this._maskCtx.clearRect(0, 0, this._maskCanvas.width, this._maskCanvas.height);
    this._lastMaskX = null;
    this._lastMaskY = null;

    // Pointer velocity starts at zero
    this._ptrX    = x;
    this._ptrY    = y;
    this._ptrVX   = 0;
    this._ptrVY   = 0;
    this._lastPtrTime = performance.now();

    // Paint first mask circle
    const p = this.app.getP();
    this._paintMaskAt(x, y, this._blobRadius(p));
    this._lastMaskX = x;
    this._lastMaskY = y;
  }

  onMove(x, y, pressure) {
    if (!this._active) return;

    const now  = performance.now();
    const dtMs = Math.max(1, now - this._lastPtrTime);
    this._ptrVX = (x - this._ptrX) / (dtMs / 1000);
    this._ptrVY = (y - this._ptrY) / (dtMs / 1000);
    this._ptrX  = x;
    this._ptrY  = y;
    this._lastPtrTime = now;

    const p = this.app.getP();
    const r = this._blobRadius(p);

    // Interpolate mask circles along the move for a continuous blob
    const lx = this._lastMaskX ?? x;
    const ly = this._lastMaskY ?? y;
    const dx = x - lx, dy = y - ly;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(r * 0.4, 1);
    const count = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      this._paintMaskAt(lx + dx * t, ly + dy * t, r);
    }
    this._lastMaskX = x;
    this._lastMaskY = y;
  }

  onUp(x, y) {
    this._active = false;
    if (!this._strokeLayer) return;

    const bbox = this._computeMaskBBox();
    if (!bbox) return; // empty stroke — nothing to simulate

    this._bbox = bbox;
    this._initSim(this.app.getP());
  }

  /**
   * Called each RAF while isDrawing === true.
   * Nothing to do — the mask is built in onMove and the sim starts in onUp.
   */
  onFrame(elapsed) {}

  /**
   * Called each RAF while !isDrawing && !isTapering.
   * Steps the sim when it is running.
   */
  onHoverFrame(elapsed) {
    if (!this._simRunning) return;
    this._step(elapsed);
    const p = this.app.getP();
    const maxTime = p.advectRunTime ?? 5.0;
    if (this._simTime >= maxTime) {
      this._commit();
    }
  }

  taperFrame(t, p) {}

  drawOverlay(ctx, p) {
    // Show blob outline during stroke
    if (this._active && this._lastMaskX !== null) {
      const r = this._blobRadius(p);
      ctx.save();
      ctx.strokeStyle = 'rgba(120,180,255,0.5)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(this._ptrX, this._ptrY, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (!this._simRunning || !this._bbox) return;

    // Render sim state to preview canvas
    this._renderPreview();

    const { x, y, w, h } = this._bbox;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._previewCanvas, x, y, w, h);
    ctx.restore();

    // Bbox outline during sim
    ctx.save();
    ctx.strokeStyle = 'rgba(255,200,100,0.4)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  getStatusInfo() {
    if (this._simRunning) {
      const p = this.app.getP();
      const maxT = (p.advectRunTime ?? 5.0).toFixed(1);
      return `Advect | ${this._simTime.toFixed(1)}s / ${maxT}s | ${this._simW}×${this._simH}`;
    }
    if (this._active) return 'Advect | Painting blob…';
    return 'Advect | Ready';
  }

  deactivate() {
    if (this._simRunning) this._commit();
    this._active      = false;
    this._strokeLayer = null;
    this._lastMaskX   = null;
    this._lastMaskY   = null;
  }

  // ── Mask helpers ────────────────────────────────────────────────────────────

  _blobRadius(p) {
    return Math.max(4, (p.advectBlobRadius ?? 40) * (p.brushScale ?? 1.0));
  }

  _ensureMaskCanvas() {
    // Size the mask canvas to the layer's CSS pixel dimensions
    const layer = this._strokeLayer || this.app.getActiveLayer();
    if (!layer) return;
    const w = this.app.W;
    const h = this.app.H;
    if (this._maskCanvas.width !== w || this._maskCanvas.height !== h) {
      this._maskCanvas.width  = w;
      this._maskCanvas.height = h;
    }
  }

  /** Paint a soft (Gaussian-like) circle into the mask canvas. */
  _paintMaskAt(x, y, r) {
    const ctx = this._maskCtx;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0,   'rgba(255,255,255,1)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.8)');
    grad.addColorStop(1,   'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Find the tight bounding box of opaque pixels in the mask canvas.
   * Returns null when the mask is empty.
   */
  _computeMaskBBox() {
    const mw = this._maskCanvas.width;
    const mh = this._maskCanvas.height;
    if (mw === 0 || mh === 0) return null;

    const data   = this._maskCtx.getImageData(0, 0, mw, mh).data;
    const THRESH = 8;
    let minX = mw, minY = mh, maxX = -1, maxY = -1;

    for (let row = 0; row < mh; row++) {
      const rowBase = row * mw * 4;
      for (let col = 0; col < mw; col++) {
        if (data[rowBase + col * 4 + 3] > THRESH) {
          if (col  < minX) minX = col;
          if (col  > maxX) maxX = col;
          if (row  < minY) minY = row;
          if (row  > maxY) maxY = row;
        }
      }
    }

    if (maxX < minX) return null; // empty

    // Clamp to canvas
    minX = Math.max(0, minX);
    minY = Math.max(0, minY);
    maxX = Math.min(mw - 1, maxX);
    maxY = Math.min(mh - 1, maxY);

    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // ── Sim initialisation ──────────────────────────────────────────────────────

  _initSim(p) {
    const { x: bx, y: by, w: bw, h: bh } = this._bbox;
    const scale  = Math.max(0.1, Math.min(1.0, (p.advectSimScale ?? 50) / 100));
    // Cap simulation grid to MAX_DIM cells on each side to prevent performance
    // degradation when the user paints a very large blob at high resolution.
    const MAX_DIM = 300;

    let sw = Math.max(4, Math.round(bw * scale));
    let sh = Math.max(4, Math.round(bh * scale));

    // Cap so a large blob does not crater performance
    if (sw > MAX_DIM || sh > MAX_DIM) {
      const r = Math.min(MAX_DIM / sw, MAX_DIM / sh);
      sw = Math.max(4, Math.round(sw * r));
      sh = Math.max(4, Math.round(sh * r));
    }

    this._simW = sw;
    this._simH = sh;
    const n = sw * sh;

    // Allocate or reuse Float32Array buffers
    if (!this._u || this._u.length !== n) {
      this._u    = new Float32Array(n); this._uBuf = new Float32Array(n);
      this._v    = new Float32Array(n); this._vBuf = new Float32Array(n);
      this._r    = new Float32Array(n); this._rBuf = new Float32Array(n);
      this._g    = new Float32Array(n); this._gBuf = new Float32Array(n);
      this._b    = new Float32Array(n); this._bBuf = new Float32Array(n);
      this._a    = new Float32Array(n); this._aBuf = new Float32Array(n);
      this._mask = new Float32Array(n);
      this._pres = new Float32Array(n);
      this._div  = new Float32Array(n);
    } else {
      this._u.fill(0); this._uBuf.fill(0);
      this._v.fill(0); this._vBuf.fill(0);
      this._pres.fill(0);
    }

    // ── Downsample mask to sim resolution ──
    const tmpMask = document.createElement('canvas');
    tmpMask.width = sw; tmpMask.height = sh;
    const tmpMaskCtx = tmpMask.getContext('2d', { willReadFrequently: true });
    tmpMaskCtx.drawImage(this._maskCanvas, bx, by, bw, bh, 0, 0, sw, sh);
    const maskPx = tmpMaskCtx.getImageData(0, 0, sw, sh).data;
    for (let i = 0; i < n; i++) this._mask[i] = maskPx[i * 4 + 3] / 255;

    // ── Sample composited pixels (downsampled to sim resolution) ──
    // We read from a flat composite of ALL visible layers so the sim has actual
    // visible content to advect.  Reading from the active layer alone would give
    // transparent pixels whenever the user paints on a fresh / empty layer,
    // producing no visible result.
    const dpr   = this.app.DPR;
    const flatW = Math.max(1, Math.round(bw * dpr));
    const flatH = Math.max(1, Math.round(bh * dpr));
    const flatCanvas = document.createElement('canvas');
    flatCanvas.width  = flatW;
    flatCanvas.height = flatH;
    const flatCtx = flatCanvas.getContext('2d', { willReadFrequently: true });
    // Composite visible layers from bottom to top over the bbox crop
    for (let li = this.app.layers.length - 1; li >= 0; li--) {
      const l = this.app.layers[li];
      if (!l.visible) continue;
      flatCtx.globalAlpha = l.opacity ?? 1;
      flatCtx.globalCompositeOperation = l.blend || 'source-over';
      flatCtx.drawImage(
        l.canvas,
        Math.round(bx * dpr), Math.round(by * dpr), flatW, flatH,
        0, 0, flatW, flatH
      );
    }
    flatCtx.globalAlpha = 1;
    flatCtx.globalCompositeOperation = 'source-over';

    const tmpPx    = document.createElement('canvas');
    tmpPx.width    = sw; tmpPx.height = sh;
    const tmpPxCtx = tmpPx.getContext('2d', { willReadFrequently: true });
    tmpPxCtx.drawImage(flatCanvas, 0, 0, sw, sh);
    const pxData = tmpPxCtx.getImageData(0, 0, sw, sh).data;

    // Convert straight RGBA → premultiplied floats and apply mask
    for (let i = 0; i < n; i++) {
      const off = i * 4;
      const ai  = pxData[off + 3] / 255;
      const m   = this._mask[i];
      this._a[i] = ai * m;
      this._r[i] = (pxData[off]     / 255) * ai * m; // premultiplied
      this._g[i] = (pxData[off + 1] / 255) * ai * m;
      this._b[i] = (pxData[off + 2] / 255) * ai * m;
    }

    // Seed initial velocity from last pointer movement
    if (Math.hypot(this._ptrVX, this._ptrVY) > 1) {
      const scX  = sw / bw;
      const scY  = sh / bh;
      const ivx  = this._ptrVX * scX * 0.05; // small initial impulse
      const ivy  = this._ptrVY * scY * 0.05;
      for (let i = 0; i < n; i++) {
        if (this._mask[i] > 0.05) {
          this._u[i] = ivx;
          this._v[i] = ivy;
        }
      }
    }

    // Size preview canvas to bbox CSS dimensions
    if (this._previewCanvas.width !== bw || this._previewCanvas.height !== bh) {
      this._previewCanvas.width  = bw;
      this._previewCanvas.height = bh;
    }

    this._simTime    = 0;
    this._lastElapsed = null;
    this._simRunning = true;
  }

  // ── Simulation step ─────────────────────────────────────────────────────────

  _step(elapsed) {
    if (!this._simRunning) return;

    let dt = this._lastElapsed === null ? 1 / 60 : elapsed - this._lastElapsed;
    this._lastElapsed = elapsed;
    dt = Math.min(Math.max(dt, 0), 0.05);
    if (dt <= 0) return;

    this._simTime += dt;

    const p   = this.app.getP();
    const sw  = this._simW;
    const sh  = this._simH;

    // ── 1. Curl noise ──
    const curlStr   = p.advectCurlStrength ?? 50;
    const curlScale = p.advectCurlScale    ?? 30;
    const curlSpeed = p.advectCurlSpeed    ?? 20;
    if (curlStr > 0) {
      this._applyCurlNoise(
        this._simTime, curlStr / 100, curlScale, curlSpeed / 100, sw, sh, dt
      );
    }

    // ── 2. Velocity diffusion (viscosity) ──
    const visc = (p.advectViscosity ?? 0) / 100;
    if (visc > 1e-5) {
      this._diffuseField(this._u, visc, dt, sw, sh, this._uBuf);
      _swap(this, '_u', '_uBuf');
      this._diffuseField(this._v, visc, dt, sw, sh, this._vBuf);
      _swap(this, '_v', '_vBuf');
    }

    // ── 3. Pressure projection (approximate incompressibility) ──
    const projIter = Math.max(0, Math.round(p.advectProjIter ?? 4));
    if (projIter > 0) {
      this._projectVelocity(projIter, sw, sh);
    }

    // ── 4. Semi-Lagrangian velocity self-advection ──
    // Keep references to the OLD fields so both u and v are traced with the
    // same un-updated velocity.
    const oldU = this._u;
    const oldV = this._v;
    this._advectField(oldU, oldU, oldV, sw, sh, dt, this._uBuf);
    this._advectField(oldV, oldU, oldV, sw, sh, dt, this._vBuf);
    _swap(this, '_u', '_uBuf');
    _swap(this, '_v', '_vBuf');

    // ── 5. Advect RGBA dye ──
    const cu = this._u, cv = this._v; // advected velocity
    this._advectField(this._r, cu, cv, sw, sh, dt, this._rBuf);
    this._advectField(this._g, cu, cv, sw, sh, dt, this._gBuf);
    this._advectField(this._b, cu, cv, sw, sh, dt, this._bBuf);
    this._advectField(this._a, cu, cv, sw, sh, dt, this._aBuf);
    _swap(this, '_r', '_rBuf');
    _swap(this, '_g', '_gBuf');
    _swap(this, '_b', '_bBuf');
    _swap(this, '_a', '_aBuf');

    // ── 6. Dye diffusion ──
    // Slider 0–1000 → diffusion coefficient 0–1. Use log-scale feel by
    // squaring the normalised value.
    const rawDiff = (p.advectDiffusion ?? 50) / 1000; // 0..1
    const diffD   = rawDiff * rawDiff;                 // 0..1 (log-feel)
    if (diffD > 1e-8) {
      this._diffuseField(this._r, diffD, dt, sw, sh, this._rBuf);
      this._diffuseField(this._g, diffD, dt, sw, sh, this._gBuf);
      this._diffuseField(this._b, diffD, dt, sw, sh, this._bBuf);
      this._diffuseField(this._a, diffD, dt, sw, sh, this._aBuf);
      _swap(this, '_r', '_rBuf');
      _swap(this, '_g', '_gBuf');
      _swap(this, '_b', '_bBuf');
      _swap(this, '_a', '_aBuf');
    }

    // ── 7. Enforce mask (hard clip + velocity damping outside blob) ──
    this._applyMask(sw, sh);
  }

  // ── Semi-Lagrangian advection ────────────────────────────────────────────────

  /** Advect `field` along (u, v) for time dt; write result into `out`. */
  _advectField(field, u, v, w, h, dt, out) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i  = y * w + x;
        const sx = x - u[i] * dt;
        const sy = y - v[i] * dt;
        out[i]   = _bilerp(field, sx, sy, w, h);
      }
    }
  }

  // ── Pressure projection ──────────────────────────────────────────────────────

  /**
   * Approximate incompressibility using `iters` Jacobi iterations.
   * Modifies this._u and this._v in-place.
   */
  _projectVelocity(iters, w, h) {
    const div  = this._div;
    const pres = this._pres;

    // Compute divergence
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i  = y * w + x;
        const xL = x > 0     ? x - 1 : 0;
        const xR = x < w - 1 ? x + 1 : w - 1;
        const yU = y > 0     ? y - 1 : 0;
        const yD = y < h - 1 ? y + 1 : h - 1;
        div[i]  = 0.5 * (
          (this._u[y * w + xR] - this._u[y * w + xL]) +
          (this._v[yD * w + x] - this._v[yU * w + x])
        );
        pres[i] = 0;
      }
    }

    // Jacobi iterations (temporary array reused each call)
    const tmp = this._uBuf; // safe to borrow — not needed during projection
    for (let iter = 0; iter < iters; iter++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i  = y * w + x;
          const xL = x > 0     ? x - 1 : 0;
          const xR = x < w - 1 ? x + 1 : w - 1;
          const yU = y > 0     ? y - 1 : 0;
          const yD = y < h - 1 ? y + 1 : h - 1;
          tmp[i] = (
            pres[y * w + xL] + pres[y * w + xR] +
            pres[yU * w + x] + pres[yD * w + x] - div[i]
          ) * 0.25;
        }
      }
      // Copy tmp → pres (avoid aliasing between iterations)
      pres.set(tmp.subarray(0, h * w));
    }

    // Subtract pressure gradient from velocity
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i  = y * w + x;
        const xL = x > 0     ? x - 1 : 0;
        const xR = x < w - 1 ? x + 1 : w - 1;
        const yU = y > 0     ? y - 1 : 0;
        const yD = y < h - 1 ? y + 1 : h - 1;
        this._u[i] -= 0.5 * (pres[y * w + xR] - pres[y * w + xL]);
        this._v[i] -= 0.5 * (pres[yD * w + x] - pres[yU * w + x]);
      }
    }
  }

  // ── Explicit dye/velocity diffusion ─────────────────────────────────────────

  /**
   * One explicit diffusion step: out[i] = field[i] + dt * D * laplacian(field)[i].
   * field and out must be different arrays.
   */
  _diffuseField(field, D, dt, w, h, out) {
    const k = dt * D;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i   = y * w + x;
        const xL  = x > 0     ? x - 1 : 0;
        const xR  = x < w - 1 ? x + 1 : w - 1;
        const yU  = y > 0     ? y - 1 : 0;
        const yD  = y < h - 1 ? y + 1 : h - 1;
        const lap = field[y * w + xL] + field[y * w + xR]
                  + field[yU * w + x] + field[yD * w + x]
                  - 4 * field[i];
        out[i] = field[i] + k * lap;
      }
    }
  }

  // ── Curl noise ───────────────────────────────────────────────────────────────

  /**
   * Inject divergence-free curl noise into (this._u, this._v).
   *
   * Curl of a scalar potential φ:
   *   u += ∂φ/∂y   v -= ∂φ/∂x
   *
   * φ is evaluated as value noise at (x/scale, y/scale, t*speed).
   * Numeric differentiation with eps = 0.5 cells.
   *
   * @param {number} t          - Elapsed simulation time (seconds)
   * @param {number} strength   - [0, 1] — scales the velocity addition
   * @param {number} scale      - Spatial scale in sim-grid cells
   * @param {number} speed      - Time evolution rate (turns/second ~ arbitrary)
   * @param {number} w, h       - Sim grid dimensions
   * @param {number} dt         - Frame delta time (seconds)
   */
  _applyCurlNoise(t, strength, scale, speed, w, h, dt) {
    // Calibrate: velocity is in cells/s.  A strength=1 gives a peak speed of
    // max(sw, sh) * 0.15 cells/s, which at default settings means ~10–20 cells/s
    // on a 128px sim — clearly visible swirling.
    const maxSpd   = Math.max(w, h) * 0.15;
    const curlAmt  = strength * maxSpd * dt;
    const invScale = 1.0 / Math.max(1, scale);
    const to       = t * speed * 0.05; // time offset (small scale so noise wraps slowly)
    const eps      = 0.5;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (this._mask[i] < 0.02) continue; // skip outside mask for performance

        const sx = x * invScale;
        const sy = y * invScale;

        const dPhiDy = (_vn(sx, sy + eps + to) - _vn(sx, sy - eps + to)) / (2 * eps);
        const dPhiDx = (_vn(sx + eps, sy + to) - _vn(sx - eps, sy + to)) / (2 * eps);

        this._u[i] +=  dPhiDy * curlAmt;
        this._v[i] -=  dPhiDx * curlAmt;
      }
    }
  }

  // ── Mask enforcement ─────────────────────────────────────────────────────────

  _applyMask(w, h) {
    for (let i = 0, n = w * h; i < n; i++) {
      const m    = this._mask[i];
      // Clamp RGBA to [0, mask] range (premultiplied alpha must not exceed mask)
      this._a[i] = Math.min(m, Math.max(0, this._a[i]));
      this._r[i] = Math.min(this._a[i], Math.max(0, this._r[i]));
      this._g[i] = Math.min(this._a[i], Math.max(0, this._g[i]));
      this._b[i] = Math.min(this._a[i], Math.max(0, this._b[i]));
      // Damp velocity outside mask to prevent leakage
      if (m < 0.1) {
        this._u[i] *= 0.85;
        this._v[i] *= 0.85;
      }
    }
  }

  // ── Preview rendering ────────────────────────────────────────────────────────

  /**
   * Render the current sim RGBA into this._previewCanvas (CSS-pixel sized).
   * Converts premultiplied float → straight Uint8 RGBA.
   */
  _renderPreview() {
    const sw = this._simW, sh = this._simH;
    const pw = this._previewCanvas.width;
    const ph = this._previewCanvas.height;
    if (sw === 0 || sh === 0 || pw === 0 || ph === 0) return;

    // Build straight RGBA from premultiplied float fields
    const n    = sw * sh;
    const px   = new Uint8ClampedArray(n * 4);
    const rF   = this._r, gF = this._g, bF = this._b, aF = this._a;

    for (let i = 0; i < n; i++) {
      const a = Math.max(0, Math.min(1, aF[i]));
      const o = i * 4;
      if (a < 0.004) {
        // transparent — leave as zero
        continue;
      }
      const invA      = 1 / a;
      px[o]     = Math.round(Math.min(a, rF[i]) * invA * 255);
      px[o + 1] = Math.round(Math.min(a, gF[i]) * invA * 255);
      px[o + 2] = Math.round(Math.min(a, bF[i]) * invA * 255);
      px[o + 3] = Math.round(a * 255);
    }

    // Write to small sim-res canvas, then upscale to preview canvas
    if (this._simPixCanvas.width !== sw || this._simPixCanvas.height !== sh) {
      this._simPixCanvas.width  = sw;
      this._simPixCanvas.height = sh;
    }
    this._simPixCtx.putImageData(new ImageData(px, sw, sh), 0, 0);

    this._previewCtx.clearRect(0, 0, pw, ph);
    this._previewCtx.imageSmoothingEnabled  = true;
    this._previewCtx.imageSmoothingQuality  = 'medium';
    this._previewCtx.drawImage(this._simPixCanvas, 0, 0, pw, ph);
  }

  // ── Commit ───────────────────────────────────────────────────────────────────

  /**
   * Blend the advected sim state back into the layer using the soft blob mask
   * as the blend weight (soft transition at blob edges).
   *
   * Blend formula (premultiplied linear space):
   *   final_premult = advected_premult * mask + original_premult * (1 - mask)
   *
   * then convert to straight RGBA for putImageData.
   */
  _commit() {
    if (!this._simRunning) return; // nothing to commit
    this._simRunning = false;

    if (!this._bbox || !this._strokeLayer) return;
    const layer = this._strokeLayer;
    if (!this.app.layers.includes(layer)) return; // layer was deleted

    const { x: bx, y: by, w: bw, h: bh } = this._bbox;
    const dpr = this.app.DPR;
    const pw  = Math.round(bw * dpr);
    const ph  = Math.round(bh * dpr);
    const sw  = this._simW;
    const sh  = this._simH;
    if (pw === 0 || ph === 0 || sw === 0 || sh === 0) return;

    // Read original layer pixels (physical coords, straight RGBA)
    const origImg = layer.ctx.getImageData(
      Math.round(bx * dpr), Math.round(by * dpr), pw, ph
    );
    const origD = origImg.data;
    const outD  = new Uint8ClampedArray(origD.length);

    // For each output physical pixel, blend advected (sim) + original
    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        const off = (py * pw + px) * 4;

        // Map to sim coordinates
        const sx = (px / pw) * sw;
        const sy = (py / ph) * sh;

        // Sample mask blend weight
        const m = _bilerp(this._mask, sx, sy, sw, sh);

        if (m < 0.004) {
          // Outside mask — keep original pixel unchanged
          outD[off]     = origD[off];
          outD[off + 1] = origD[off + 1];
          outD[off + 2] = origD[off + 2];
          outD[off + 3] = origD[off + 3];
          continue;
        }

        // Sample advected premultiplied RGBA
        const advR = _bilerp(this._r, sx, sy, sw, sh);
        const advG = _bilerp(this._g, sx, sy, sw, sh);
        const advB = _bilerp(this._b, sx, sy, sw, sh);
        const advA = _bilerp(this._a, sx, sy, sw, sh);

        // Original in premultiplied float [0,1]
        const origA      = origD[off + 3] / 255;
        const origR_pm   = origD[off]     / 255 * origA;
        const origG_pm   = origD[off + 1] / 255 * origA;
        const origB_pm   = origD[off + 2] / 255 * origA;

        // Blend (premultiplied linear)
        const mInv   = 1 - m;
        const finA   = advA * m + origA  * mInv;
        const finR   = advR * m + origR_pm * mInv;
        const finG   = advG * m + origG_pm * mInv;
        const finB   = advB * m + origB_pm * mInv;

        // Convert premultiplied → straight
        if (finA < 0.004) {
          outD[off] = outD[off+1] = outD[off+2] = outD[off+3] = 0;
        } else {
          const invFA  = 1 / finA;
          outD[off]     = Math.round(Math.min(1, finR * invFA) * 255);
          outD[off + 1] = Math.round(Math.min(1, finG * invFA) * 255);
          outD[off + 2] = Math.round(Math.min(1, finB * invFA) * 255);
          outD[off + 3] = Math.round(finA * 255);
        }
      }
    }

    // Write merged result back to layer (bypass DPR transform via identity)
    const outImg = new ImageData(outD, pw, ph);
    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.putImageData(outImg, Math.round(bx * dpr), Math.round(by * dpr));
    layer.ctx.restore();

    layer.dirty = true;
    this.app.compositeAllLayers();
  }
}

// ── Utility: swap two named Float32Array fields on an object ─────────────────
function _swap(obj, keyA, keyB) {
  const tmp  = obj[keyA];
  obj[keyA]  = obj[keyB];
  obj[keyB]  = tmp;
}
