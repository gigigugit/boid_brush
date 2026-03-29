// =============================================================================
// selection.js — Selection tool system (rectangle, ellipse, lasso)
// Coordinates are in CSS canvas space unless noted otherwise.
// "Physical" = CSS coords × DPR (= actual layer canvas pixel space).
// =============================================================================

export class SelectionManager {
  constructor(app) {
    this.app = app;
    this.type = null;     // 'rect' | 'ellipse' | 'lasso'
    this.rect = null;     // { x, y, w, h } CSS canvas coords
    this.points = [];     // lasso points [{ x, y }, ...] CSS coords
    this._isDragging = false;
    this._startX = 0;
    this._startY = 0;
    this._marchOffset = 0;
    // Transform state
    this.transformActive = false;  // true when in transform mode
    this.keepProportional = true;  // scale proportionally by default
    this._transformHandle = null;  // 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'move'|'rotate'|null
    this._transformStart = null;   // { bounds, px, py, angle } when drag starts
    this.rotation = 0;             // current rotation in radians
    this.flipH = false;             // horizontal flip
    this.flipV = false;             // vertical flip
    // Move state (drag-to-move selection without entering transform mode)
    this._isMoving = false;
    this._moveStart = null;        // { bounds, px, py }
    // Floating pixels — lifted content during move/transform
    this._floatingPixels = null;   // OffscreenCanvas with extracted content
    this._floatingOrigBounds = null; // { x, y, w, h } CSS coords where pixels were lifted from
  }

  // -----------------------------------------------------------------------
  // Public state

  /** True when a completed selection exists. */
  get active() {
    if (this.type === 'lasso') return this.points.length > 2;
    return this.rect !== null && (this.rect.w > 0 || this.rect.h > 0);
  }

  clear() {
    this.type = null;
    this.rect = null;
    this.points = [];
    this._isDragging = false;
    this._isMoving = false;
    this._moveStart = null;
    this._floatingPixels = null;
    this._floatingOrigBounds = null;
    this.rotation = 0;
    this.flipH = false;
    this.flipV = false;
  }

  /** Check if (x,y) in CSS canvas coords is inside the selection bounds (rotation-aware). */
  isInsideBounds(x, y) {
    const b = this.getBounds();
    if (!b) return false;
    if (this.rotation) {
      const { lx, ly } = this._toLocal(x, y);
      return lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h;
    }
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }

  // -----------------------------------------------------------------------
  // Move lifecycle — drag-to-move from any tool mode

  moveOnDown(x, y) {
    if (!this.isInsideBounds(x, y)) return false;
    this._isMoving = true;
    this._moveStart = { bounds: this.getBounds(), px: x, py: y };
    return true;
  }

  moveOnMove(x, y) {
    if (!this._isMoving || !this._moveStart) return;
    const s = this._moveStart;
    const dx = x - s.px, dy = y - s.py;
    this.rect = { x: s.bounds.x + dx, y: s.bounds.y + dy, w: s.bounds.w, h: s.bounds.h };
  }

  moveOnUp() {
    this._isMoving = false;
    this._moveStart = null;
  }

  getBounds() {
    if (this.rect) return { ...this.rect };
    if (this.points.length > 2) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of this.points) {
        if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Drag lifecycle — called from app.js pointer handlers

  onDown(x, y) {
    this._isDragging = true;
    this._startX = x;
    this._startY = y;
    // 'rect-select' → 'rect', 'ellipse-select' → 'ellipse', etc.
    this.type = this.app.activeTool.replace('-select', '');
    if (this.type === 'lasso') {
      this.points = [{ x, y }];
      this.rect = null;
    } else {
      this.points = [];
      this.rect = { x, y, w: 0, h: 0 };
    }
  }

  onMove(x, y) {
    if (!this._isDragging) return;
    if (this.type === 'lasso') {
      const last = this.points[this.points.length - 1];
      const dx = x - last.x, dy = y - last.y;
      if (dx * dx + dy * dy > 4) this.points.push({ x, y });
    } else {
      const x0 = Math.min(this._startX, x);
      const y0 = Math.min(this._startY, y);
      this.rect = { x: x0, y: y0, w: Math.abs(x - this._startX), h: Math.abs(y - this._startY) };
    }
  }

  onUp(x, y) {
    this._isDragging = false;
    if (this.type === 'lasso') {
      if (this.points.length > 2) {
        // Close the path
        const first = this.points[0], last = this.points[this.points.length - 1];
        if (first.x !== last.x || first.y !== last.y) this.points.push({ ...first });
      } else {
        this.clear();
      }
    } else if (this.rect && this.rect.w < 3 && this.rect.h < 3) {
      // Tiny tap = deselect
      this.clear();
    }
    this.app._syncSelectionUI();
  }

  // -----------------------------------------------------------------------
  // Pixel operations (work in physical pixel space on layer canvases)

  /**
   * Build a 2D path on `ctx` using physical pixel coordinates (CSS × dpr).
   * Called with identity transform (clearPixels) or after translate (extractPixels).
   */
  _buildPath(ctx, dpr) {
    ctx.beginPath();
    if (this.type === 'lasso' && this.points.length > 2) {
      ctx.moveTo(this.points[0].x * dpr, this.points[0].y * dpr);
      for (let i = 1; i < this.points.length; i++) {
        ctx.lineTo(this.points[i].x * dpr, this.points[i].y * dpr);
      }
      ctx.closePath();
    } else if (this.rect) {
      const { x, y, w, h } = this.rect;
      if (this.type === 'ellipse') {
        ctx.ellipse((x + w / 2) * dpr, (y + h / 2) * dpr, (w / 2) * dpr, (h / 2) * dpr, 0, 0, Math.PI * 2);
      } else {
        ctx.rect(x * dpr, y * dpr, w * dpr, h * dpr);
      }
    }
  }

  /**
   * Extract only the selected pixels from a full-resolution layer canvas.
   * Returns an OffscreenCanvas covering the selection bounding box.
   */
  extractPixels(sourceCanvas, dpr) {
    const b = this._physBounds(dpr);
    if (!b) return null;
    const { bx, by, bw, bh } = b;
    const out = new OffscreenCanvas(Math.max(bw, 1), Math.max(bh, 1));
    const ctx = out.getContext('2d');
    ctx.save();
    ctx.translate(-bx, -by);
    this._buildPath(ctx, dpr);
    ctx.clip();
    ctx.drawImage(sourceCanvas, 0, 0);
    ctx.restore();
    return out;
  }

  /**
   * Clear the selected region on a layer context.
   * Operates at physical pixel level (identity transform).
   * Restores the DPR transform after clearing.
   */
  clearPixels(layerCtx, dpr) {
    layerCtx.save();
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._buildPath(layerCtx, dpr);
    layerCtx.clip();
    layerCtx.clearRect(0, 0, layerCtx.canvas.width, layerCtx.canvas.height);
    layerCtx.restore();
    // Restore the DPR scale transform that makeLayerCanvas set
    layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // -----------------------------------------------------------------------
  // Overlay drawing — called from _frameLoop with the live canvas context.
  // lctx has setTransform(DPR, 0, 0, DPR, 0, 0), so draw in CSS pixel space.

  drawOverlay(ctx, elapsed) {
    const hasGeom = this.type === 'lasso' ? this.points.length > 1 : this.rect !== null;
    if (!hasGeom && !this._isDragging) return;

    this._marchOffset = (elapsed * 60) % 12;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);

    // Apply rotation around the selection center
    if (this.rotation && this.rect) {
      const cx = this.rect.x + this.rect.w / 2;
      const cy = this.rect.y + this.rect.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate(this.rotation);
      ctx.translate(-cx, -cy);
    }

    ctx.beginPath();
    if (this.type === 'lasso' && this.points.length > 1) {
      ctx.moveTo(this.points[0].x, this.points[0].y);
      for (let i = 1; i < this.points.length; i++) ctx.lineTo(this.points[i].x, this.points[i].y);
      if (!this._isDragging) ctx.closePath();
    } else if (this.rect) {
      const { x, y, w, h } = this.rect;
      if (this.type === 'ellipse') {
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.rect(x, y, w, h);
      }
    }

    // Two-pass: white dash then offset black dash for contrast on any background
    ctx.lineDashOffset = -this._marchOffset;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();

    ctx.lineDashOffset = -this._marchOffset + 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.restore();
  }

  // -----------------------------------------------------------------------
  // Floating pixel operations — lift, preview, stamp

  /**
   * Extract the selected pixels from the layer and clear them.
   * Stores them in _floatingPixels for preview/stamping.
   */
  liftPixels(layerCtx, sourceCanvas, dpr) {
    if (this._floatingPixels) return; // already lifted
    const b = this.getBounds();
    if (!b || b.w < 1 || b.h < 1) return;
    const px = Math.round(b.x * dpr);
    const py = Math.round(b.y * dpr);
    const pw = Math.max(1, Math.round(b.w * dpr));
    const ph = Math.max(1, Math.round(b.h * dpr));
    // Use getImageData for reliable reading (forces sync on desynchronized canvases)
    const imageData = layerCtx.getImageData(px, py, pw, ph);
    const out = new OffscreenCanvas(pw, ph);
    const outCtx = out.getContext('2d');
    outCtx.putImageData(imageData, 0, 0);
    this._floatingPixels = out;
    this._floatingOrigBounds = { ...b };
    // Clear original location
    this.clearPixels(layerCtx, dpr);
  }

  /**
   * Stamp the floating pixels back onto the layer at the current rect position/size.
   */
  stampPixels(layerCtx, dpr) {
    if (!this._floatingPixels) return;
    const b = this.getBounds();
    if (!b) return;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    layerCtx.save();
    layerCtx.translate(cx, cy);
    layerCtx.rotate(this.rotation);
    layerCtx.scale(this.flipH ? -1 : 1, this.flipV ? -1 : 1);
    layerCtx.drawImage(this._floatingPixels, -b.w / 2, -b.h / 2, b.w, b.h);
    layerCtx.restore();
    this._floatingPixels = null;
    this._floatingOrigBounds = null;
  }

  /**
   * Draw the floating pixels on the overlay context (CSS pixel space, DPR-scaled transform).
   */
  drawFloatingPreview(ctx) {
    if (!this._floatingPixels) return;
    const b = this.getBounds();
    if (!b) return;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.rotation);
    ctx.scale(this.flipH ? -1 : 1, this.flipV ? -1 : 1);
    ctx.drawImage(this._floatingPixels, -b.w / 2, -b.h / 2, b.w, b.h);
    ctx.restore();
  }

  // -----------------------------------------------------------------------
  // Internal helpers

  _physBounds(dpr) {
    if (this._isDragging) return null;
    const b = this.getBounds();
    if (!b) return null;
    return {
      bx: Math.round(b.x * dpr),
      by: Math.round(b.y * dpr),
      bw: Math.round(b.w * dpr),
      bh: Math.round(b.h * dpr),
    };
  }

  // -----------------------------------------------------------------------
  // Transform tool support

  /** Get the center of the selection in CSS coords. */
  _getCenter() {
    const b = this.getBounds();
    if (!b) return null;
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
  }

  /** Transform a point from screen space into the selection's rotated local space. */
  _toLocal(x, y) {
    const c = this._getCenter();
    if (!c) return { lx: x, ly: y };
    const cos = Math.cos(-this.rotation), sin = Math.sin(-this.rotation);
    const dx = x - c.cx, dy = y - c.cy;
    return { lx: cos * dx - sin * dy + c.cx, ly: sin * dx + cos * dy + c.cy };
  }

  _getHandleAt(x, y, tolerance = 8) {
    const b = this.getBounds();
    if (!b) return null;
    const bx = b.x, by = b.y, w = b.w, h = b.h;

    // Check rotation arcs first (corners, just outside)
    const rotArcRadius = 16;
    const rotCorners = [
      [bx, by], [bx + w, by], [bx + w, by + h], [bx, by + h],
    ];
    const c = this._getCenter();

    // Check flip buttons (below selection, in screen space)
    const flipBtns = this._getFlipButtonPositions();
    if (flipBtns) {
      if (Math.abs(x - flipBtns.hx) <= flipBtns.sz / 2 && Math.abs(y - flipBtns.hy) <= flipBtns.sz / 2) return 'flipH';
      if (Math.abs(x - flipBtns.vx) <= flipBtns.sz / 2 && Math.abs(y - flipBtns.vy) <= flipBtns.sz / 2) return 'flipV';
    }

    if (c) {
      for (const [rcx, rcy] of rotCorners) {
        // Rotate the corner point to screen space
        const cos = Math.cos(this.rotation), sin = Math.sin(this.rotation);
        const dx = rcx - c.cx, dy = rcy - c.cy;
        const sx = cos * dx - sin * dy + c.cx;
        const sy = sin * dx + cos * dy + c.cy;
        const dist = Math.hypot(x - sx, y - sy);
        if (dist >= tolerance && dist <= rotArcRadius + tolerance) return 'rotate';
      }
    }

    // Work in local (un-rotated) space for resize/move detection
    const { lx, ly } = this._toLocal(x, y);
    const handles = {
      nw: [bx, by], n: [bx + w / 2, by], ne: [bx + w, by],
      e: [bx + w, by + h / 2], se: [bx + w, by + h],
      s: [bx + w / 2, by + h], sw: [bx, by + h], w: [bx, by + h / 2],
    };
    // Check resize handles first (they have priority over interior)
    for (const [name, coords] of Object.entries(handles)) {
      const [hx, hy] = coords;
      if (Math.hypot(lx - hx, ly - hy) <= tolerance) return name;
    }
    // Check if click is inside the selection bounds → move
    if (lx >= bx && lx <= bx + w && ly >= by && ly <= by + h) return 'move';
    return null;
  }

  transformOnDown(x, y) {
    const handle = this._getHandleAt(x, y);
    if (!handle) return false;

    // Flip actions are instant — toggle and return, no drag needed
    if (handle === 'flipH') {
      this.flipH = !this.flipH;
      return true;
    }
    if (handle === 'flipV') {
      this.flipV = !this.flipV;
      return true;
    }

    this._transformHandle = handle;
    this._transformStart = { bounds: this.getBounds(), px: x, py: y, angle: this.rotation };
    return true;
  }

  transformOnMove(x, y) {
    if (!this._transformHandle || !this._transformStart) return;
    const start = this._transformStart;
    const b0 = start.bounds;
    const dx = x - start.px, dy = y - start.py;
    const handle = this._transformHandle;

    // Move: translate the entire selection
    if (handle === 'move') {
      this.rect = { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h };
      return;
    }

    // Rotate: compute angle from center
    if (handle === 'rotate') {
      const c = { cx: b0.x + b0.w / 2, cy: b0.y + b0.h / 2 };
      const startAngle = Math.atan2(start.py - c.cy, start.px - c.cx);
      const curAngle   = Math.atan2(y - c.cy, x - c.cx);
      this.rotation = start.angle + (curAngle - startAngle);
      return;
    }

    // Four edges of the original rect
    let left = b0.x, top = b0.y, right = b0.x + b0.w, bottom = b0.y + b0.h;

    // Which edges does this handle drag?
    const movesLeft   = handle.includes('w');
    const movesRight  = handle.includes('e');
    const movesTop    = handle.includes('n');
    const movesBottom = handle.includes('s');

    // Shift the dragged edge(s) by the mouse delta
    if (movesLeft)   left   += dx;
    if (movesRight)  right  += dx;
    if (movesTop)    top    += dy;
    if (movesBottom) bottom += dy;

    let newW = right - left;
    let newH = bottom - top;

    if (this.keepProportional && b0.w > 0 && b0.h > 0) {
      const aspect = b0.w / b0.h;
      const isCorner = (movesLeft || movesRight) && (movesTop || movesBottom);

      if (isCorner) {
        // Use the axis with the larger proportional change
        const scaleX = newW / b0.w;
        const scaleY = newH / b0.h;
        const scale = Math.abs(scaleX - 1) > Math.abs(scaleY - 1) ? scaleX : scaleY;
        newW = b0.w * scale;
        newH = b0.h * scale;
      } else if (movesLeft || movesRight) {
        // Horizontal edge: adjust height to match, centered vertically
        newH = newW / aspect;
      } else {
        // Vertical edge: adjust width to match, centered horizontally
        newW = newH * aspect;
      }

      // Anchor the opposite corner/edge
      if (movesLeft)       left = right - newW;
      else if (movesRight) right = left + newW;
      else { const cx = b0.x + b0.w / 2; left = cx - newW / 2; right = cx + newW / 2; }

      if (movesTop)         top = bottom - newH;
      else if (movesBottom) bottom = top + newH;
      else { const cy = b0.y + b0.h / 2; top = cy - newH / 2; bottom = cy + newH / 2; }
    }

    // Constrain minimum size (anchor the opposite side)
    if (right - left < 4) {
      if (movesLeft) left = right - 4; else right = left + 4;
    }
    if (bottom - top < 4) {
      if (movesTop) top = bottom - 4; else bottom = top + 4;
    }

    this.rect = { x: left, y: top, w: right - left, h: bottom - top };
  }

  transformOnUp() {
    this._transformHandle = null;
    this._transformStart = null;
  }

  /** Get the positions of the flip buttons in screen space (below the selection). */
  _getFlipButtonPositions() {
    const b = this.getBounds();
    if (!b) return null;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const sz = 22;
    const gap = 6;
    // Position below the selection in local space, then rotate to screen space
    const localHx = cx - sz / 2 - gap / 2;
    const localVx = cx + sz / 2 + gap / 2;
    const localY  = b.y + b.h + 24;
    if (this.rotation) {
      const cos = Math.cos(this.rotation), sin = Math.sin(this.rotation);
      const rh = this._rotatePoint(localHx, localY, cx, cy, cos, sin);
      const rv = this._rotatePoint(localVx, localY, cx, cy, cos, sin);
      return { hx: rh.x, hy: rh.y, vx: rv.x, vy: rv.y, sz };
    }
    return { hx: localHx, hy: localY, vx: localVx, vy: localY, sz };
  }

  _rotatePoint(px, py, cx, cy, cos, sin) {
    const dx = px - cx, dy = py - cy;
    return { x: cos * dx - sin * dy + cx, y: sin * dx + cos * dy + cy };
  }

  drawTransformHandles(ctx) {
    const b = this.getBounds();
    if (!b) return;
    const x = b.x, y = b.y, w = b.w, h = b.h;
    const cx = x + w / 2, cy = y + h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.rotation);
    ctx.translate(-cx, -cy);

    // Resize handles
    const handles = [
      [x, y], [x + w / 2, y], [x + w, y],
      [x + w, y + h / 2], [x + w, y + h],
      [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
    ];
    ctx.fillStyle = 'rgba(100, 150, 255, 0.5)';
    ctx.strokeStyle = 'rgba(50, 100, 200, 0.8)';
    ctx.lineWidth = 1;
    for (const [hx, hy] of handles) {
      ctx.fillRect(hx - 5, hy - 5, 10, 10);
      ctx.strokeRect(hx - 5, hy - 5, 10, 10);
    }

    // Rotation arcs — quarter circle at each corner, just outside
    const arcR = 16;
    const corners = [
      { cx: x, cy: y, startAngle: Math.PI,        endAngle: Math.PI * 1.5 },  // nw
      { cx: x + w, cy: y, startAngle: Math.PI * 1.5, endAngle: Math.PI * 2 },  // ne
      { cx: x + w, cy: y + h, startAngle: 0,           endAngle: Math.PI * 0.5 },  // se
      { cx: x, cy: y + h, startAngle: Math.PI * 0.5, endAngle: Math.PI },       // sw
    ];
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(100, 200, 120, 0.7)';
    ctx.fillStyle = 'rgba(100, 200, 120, 0.18)';
    for (const c of corners) {
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, arcR, c.startAngle, c.endAngle);
      ctx.stroke();
      // Fill the pie wedge
      ctx.beginPath();
      ctx.moveTo(c.cx, c.cy);
      ctx.arc(c.cx, c.cy, arcR, c.startAngle, c.endAngle);
      ctx.closePath();
      ctx.fill();
    }

    // Flip buttons — positioned below the selection
    const btnSz = 22;
    const btnGap = 6;
    const btnY = y + h + 24;
    const btnHx = cx - btnSz / 2 - btnGap / 2;
    const btnVx = cx + btnSz / 2 + btnGap / 2;

    // Button backgrounds
    ctx.fillStyle = 'rgba(130, 110, 200, 0.35)';
    ctx.strokeStyle = 'rgba(130, 110, 200, 0.7)';
    ctx.lineWidth = 1;
    const r = 3; // corner radius
    for (const bx of [btnHx - btnSz / 2, btnVx - btnSz / 2]) {
      const by2 = btnY - btnSz / 2;
      ctx.beginPath();
      ctx.roundRect(bx, by2, btnSz, btnSz, r);
      ctx.fill();
      ctx.stroke();
    }

    // Button labels
    ctx.fillStyle = 'rgb(90, 90, 90)';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u2194', btnHx, btnY);  // ↔ horizontal flip
    ctx.fillText('\u2195', btnVx, btnY);  // ↕ vertical flip

    ctx.restore();
  }
}
