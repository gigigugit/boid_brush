const MIN_POINT_SPACING = 1.25;
const DEFAULT_TRACK_WINDOW_MS = 240;
const CIRCLE_SEGMENTS = 18;
const ROUNDED_CAP_SEGMENTS = 8;

function clampRadius(radius) {
  return Math.max(0.5, Number(radius) || 0.5);
}

function expandBounds(bounds, x, y, radius) {
  if (!bounds) {
    return {
      minX: x - radius,
      minY: y - radius,
      maxX: x + radius,
      maxY: y + radius,
    };
  }
  bounds.minX = Math.min(bounds.minX, x - radius);
  bounds.minY = Math.min(bounds.minY, y - radius);
  bounds.maxX = Math.max(bounds.maxX, x + radius);
  bounds.maxY = Math.max(bounds.maxY, y + radius);
  return bounds;
}

function normalizeBounds(bounds, padding = 0) {
  if (!bounds) return null;
  const minX = bounds.minX - padding;
  const minY = bounds.minY - padding;
  const maxX = bounds.maxX + padding;
  const maxY = bounds.maxY + padding;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    centerX: (minX + maxX) * 0.5,
    centerY: (minY + maxY) * 0.5,
  };
}

function boundsArea(bounds) {
  return bounds ? bounds.width * bounds.height : 0;
}

function isWiderBounds(nextBounds, currentBounds) {
  if (!nextBounds) return false;
  if (!currentBounds) return true;
  const nextArea = boundsArea(nextBounds);
  const currentArea = boundsArea(currentBounds);
  if (Math.abs(nextArea - currentArea) > 0.001) {
    return nextArea > currentArea;
  }
  return Math.max(nextBounds.width, nextBounds.height) > Math.max(currentBounds.width, currentBounds.height);
}

function cloneBounds(bounds) {
  return bounds ? { ...bounds } : null;
}

function createBoundsFromCenter(x, y, radius) {
  return normalizeBounds({
    minX: x - radius,
    minY: y - radius,
    maxX: x + radius,
    maxY: y + radius,
  });
}

function polygonBounds(points) {
  if (!points.length) return null;
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return normalizeBounds({ minX, minY, maxX, maxY });
}

function pointInsideBounds(point, bounds) {
  return Boolean(
    bounds
    && point.x >= bounds.minX
    && point.x <= bounds.maxX
    && point.y >= bounds.minY
    && point.y <= bounds.maxY
  );
}

function blendBounds(fromBounds, toBounds, amount = 0.5) {
  if (!fromBounds && !toBounds) return null;
  if (!fromBounds) return cloneBounds(toBounds);
  if (!toBounds) return cloneBounds(fromBounds);
  const t = Math.max(0, Math.min(1, amount));
  return normalizeBounds({
    minX: fromBounds.minX + (toBounds.minX - fromBounds.minX) * t,
    minY: fromBounds.minY + (toBounds.minY - fromBounds.minY) * t,
    maxX: fromBounds.maxX + (toBounds.maxX - fromBounds.maxX) * t,
    maxY: fromBounds.maxY + (toBounds.maxY - fromBounds.maxY) * t,
  });
}

function buildCirclePolygon(x, y, radius) {
  const points = [];
  for (let index = 0; index < CIRCLE_SEGMENTS; index += 1) {
    const angle = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
    points.push({
      x: x + Math.cos(angle) * radius,
      y: y + Math.sin(angle) * radius,
    });
  }
  return points;
}

function boundsFromNodes(nodes, padding = 0) {
  if (!nodes.length) return null;
  let bounds = null;
  for (const node of nodes) {
    bounds = expandBounds(bounds, node.x, node.y, node.radius + padding);
  }
  return normalizeBounds(bounds);
}

function normalizeVector(x, y, fallbackX = 1, fallbackY = 0) {
  const length = Math.hypot(x, y);
  if (length <= 0.0001) {
    const fallbackLength = Math.hypot(fallbackX, fallbackY) || 1;
    return { x: fallbackX / fallbackLength, y: fallbackY / fallbackLength };
  }
  return { x: x / length, y: y / length };
}

function appendRoundedCap(points, center, tangent, normal, radius, stretch, startTheta, endTheta) {
  for (let index = 1; index < ROUNDED_CAP_SEGMENTS; index += 1) {
    const t = index / ROUNDED_CAP_SEGMENTS;
    const theta = startTheta + (endTheta - startTheta) * t;
    points.push({
      x: center.x + tangent.x * Math.cos(theta) * radius * stretch + normal.x * Math.sin(theta) * radius,
      y: center.y + tangent.y * Math.cos(theta) * radius * stretch + normal.y * Math.sin(theta) * radius,
    });
  }
}

function buildRibbonPolygon(nodes, padding = 0) {
  if (!nodes.length) return [];
  if (nodes.length === 1) {
    return buildCirclePolygon(nodes[0].x, nodes[0].y, nodes[0].radius + padding);
  }

  const left = [];
  const right = [];
  const tangents = [];
  const normals = [];
  const radii = [];
  const centers = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const prev = nodes[Math.max(0, index - 1)];
    const next = nodes[Math.min(nodes.length - 1, index + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const baseTangent = normalizeVector(dx, dy, 1, 0);
    const flowX = nodes[index].flowX ?? 0;
    const flowY = nodes[index].flowY ?? 0;
    const flowMagnitude = Math.hypot(flowX, flowY);
    const flowMix = Math.min(0.68, flowMagnitude / Math.max(1, (nodes[index].radius + padding) * 1.4));
    const tangent = normalizeVector(
      baseTangent.x * (1 - flowMix) + flowX * flowMix,
      baseTangent.y * (1 - flowMix) + flowY * flowMix,
      baseTangent.x,
      baseTangent.y
    );
    const nx = -tangent.y;
    const ny = tangent.x;
    const radius = nodes[index].radius + padding;
    const center = {
      x: nodes[index].x + flowX * Math.min(0.35, flowMix * 0.45),
      y: nodes[index].y + flowY * Math.min(0.35, flowMix * 0.45),
    };
    tangents.push(tangent);
    normals.push({ x: nx, y: ny });
    radii.push(radius);
    centers.push(center);
    left.push({ x: center.x + nx * radius, y: center.y + ny * radius });
    right.push({ x: center.x - nx * radius, y: center.y - ny * radius });
  }

  const polygon = [...left];
  const endIndex = nodes.length - 1;
  const endFlowMagnitude = Math.hypot(nodes[endIndex].flowX ?? 0, nodes[endIndex].flowY ?? 0);
  const endStretch = 1 + Math.min(0.45, endFlowMagnitude / Math.max(1, radii[endIndex] * 2.2));
  appendRoundedCap(polygon, centers[endIndex], tangents[endIndex], normals[endIndex], radii[endIndex], endStretch, Math.PI / 2, -Math.PI / 2);
  polygon.push(...right.reverse());

  const startFlowMagnitude = Math.hypot(nodes[0].flowX ?? 0, nodes[0].flowY ?? 0);
  const startStretch = 1 + Math.min(0.45, startFlowMagnitude / Math.max(1, radii[0] * 2.2));
  appendRoundedCap(
    polygon,
    centers[0],
    { x: -tangents[0].x, y: -tangents[0].y },
    normals[0],
    radii[0],
    startStretch,
    -Math.PI / 2,
    Math.PI / 2
  );
  return polygon;
}

function tracePolygon(ctx, polygon) {
  if (!polygon.length) return false;
  ctx.beginPath();
  ctx.moveTo(polygon[0].x, polygon[0].y);
  for (let index = 1; index < polygon.length; index += 1) {
    ctx.lineTo(polygon[index].x, polygon[index].y);
  }
  ctx.closePath();
  return true;
}

function cohortMetricsFromParticles(particles, startIndex, count, fallbackBounds) {
  const fallback = cloneBounds(fallbackBounds);
  if (!particles.length || count <= 0 || startIndex >= particles.length) {
    return {
      bounds: fallback,
      centroidX: fallback?.centerX ?? 0,
      centroidY: fallback?.centerY ?? 0,
      flowX: 0,
      flowY: 0,
    };
  }

  const end = Math.min(particles.length, startIndex + count);
  if (end <= startIndex) {
    return {
      bounds: fallback,
      centroidX: fallback?.centerX ?? 0,
      centroidY: fallback?.centerY ?? 0,
      flowX: 0,
      flowY: 0,
    };
  }

  let minX = particles[startIndex].x;
  let minY = particles[startIndex].y;
  let maxX = particles[startIndex].x;
  let maxY = particles[startIndex].y;
  let sumX = particles[startIndex].x;
  let sumY = particles[startIndex].y;
  let sumVx = particles[startIndex].vx ?? 0;
  let sumVy = particles[startIndex].vy ?? 0;
  for (let index = startIndex + 1; index < end; index += 1) {
    const particle = particles[index];
    minX = Math.min(minX, particle.x);
    minY = Math.min(minY, particle.y);
    maxX = Math.max(maxX, particle.x);
    maxY = Math.max(maxY, particle.y);
    sumX += particle.x;
    sumY += particle.y;
    sumVx += particle.vx ?? 0;
    sumVy += particle.vy ?? 0;
  }
  const samples = Math.max(1, end - startIndex);
  return {
    bounds: normalizeBounds({ minX, minY, maxX, maxY }),
    centroidX: sumX / samples,
    centroidY: sumY / samples,
    flowX: sumVx / samples,
    flowY: sumVy / samples,
  };
}

function cohortMetricsFromSampleField(particles, cohort, tightness = 0.68) {
  const clampedTightness = Math.max(0, Math.min(1, Number(tightness) || 0));
  const fallback = cohort.liveBounds || cohort.maxBounds || createBoundsFromCenter(cohort.x, cohort.y, cohort.radius);
  const searchBounds = normalizeBounds(
    fallback,
    Math.max(
      cohort.radius * (0.72 + (1 - clampedTightness) * 0.6),
      Math.max(fallback?.width ?? 0, fallback?.height ?? 0) * (0.04 + (1 - clampedTightness) * 0.14),
      2 + (1 - clampedTightness) * 4
    )
  );
  const nearby = [];
  for (let index = 0; index < particles.length; index += 1) {
    const particle = particles[index];
    if (pointInsideBounds(particle, searchBounds)) {
      nearby.push(particle);
    }
  }

  if (!nearby.length) {
    return {
      bounds: cloneBounds(fallback),
      centroidX: fallback.centerX,
      centroidY: fallback.centerY,
      flowX: 0,
      flowY: 0,
    };
  }

  let centroidX = 0;
  let centroidY = 0;
  let flowX = 0;
  let flowY = 0;
  for (const particle of nearby) {
    centroidX += particle.x;
    centroidY += particle.y;
    flowX += particle.vx ?? 0;
    flowY += particle.vy ?? 0;
  }
  centroidX /= nearby.length;
  centroidY /= nearby.length;
  flowX /= nearby.length;
  flowY /= nearby.length;

  const localPadding = Math.max(
    cohort.radius * (0.035 + (1 - clampedTightness) * 0.12),
    Math.hypot(flowX, flowY) * (0.035 + (1 - clampedTightness) * 0.09),
    0.35 + (1 - clampedTightness) * 0.8
  );
  let bounds = createBoundsFromCenter(
    centroidX * (0.72 + clampedTightness * 0.2) + fallback.centerX * (0.28 - clampedTightness * 0.2),
    centroidY * (0.72 + clampedTightness * 0.2) + fallback.centerY * (0.28 - clampedTightness * 0.2),
    Math.max(cohort.radius * (0.32 + (1 - clampedTightness) * 0.24), 0.9 + (1 - clampedTightness) * 0.5)
  );
  for (const particle of nearby) {
    bounds = expandBounds(bounds, particle.x, particle.y, localPadding);
  }

  return {
    bounds: normalizeBounds(bounds),
    centroidX,
    centroidY,
    flowX,
    flowY,
  };
}

export class BlobStroke {
  constructor({ sampleSpacing = MIN_POINT_SPACING } = {}) {
    this.sampleSpacing = sampleSpacing;
    this.reset();
  }

  reset() {
    this.points = [];
    this.totalLength = 0;
    this.baseBounds = null;
  }

  begin(x, y, { radius } = {}) {
    this.reset();
    this._appendPoint(x, y, clampRadius(radius));
    return this;
  }

  extend(x, y, { radius } = {}) {
    const nextRadius = clampRadius(radius);
    if (!this.points.length) {
      this.begin(x, y, { radius: nextRadius });
      return true;
    }

    const last = this.points[this.points.length - 1];
    const dx = x - last.x;
    const dy = y - last.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0.001) {
      last.radius = Math.max(last.radius, nextRadius);
      this.baseBounds = expandBounds(this.baseBounds, last.x, last.y, last.radius);
      return false;
    }

    const spacing = Math.max(this.sampleSpacing, Math.min(last.radius, nextRadius) * 0.35);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      this._appendPoint(
        last.x + dx * t,
        last.y + dy * t,
        last.radius + (nextRadius - last.radius) * t
      );
    }
    return true;
  }

  isEmpty() {
    return this.points.length === 0;
  }

  getBounds(padding = 0) {
    return normalizeBounds(this.baseBounds, Math.max(0, padding));
  }

  toDescriptor({ padding = 0 } = {}) {
    return {
      pointCount: this.points.length,
      totalLength: this.totalLength,
      bounds: this.getBounds(padding),
      points: this.points.map((point) => ({ ...point })),
    };
  }

  rasterize(ctx, {
    padding = 0,
    compositeOperation = 'source-over',
    fillStyle = 'rgba(255, 255, 255, 1)',
  } = {}) {
    if (this.isEmpty()) return null;

    ctx.save();
    ctx.globalCompositeOperation = compositeOperation;
    ctx.fillStyle = fillStyle;

    for (let index = 0; index < this.points.length; index += 1) {
      const point = this.points[index];
      this._fillDisc(ctx, point.x, point.y, point.radius + padding);
      if (index === 0) continue;
      const previous = this.points[index - 1];
      this._strokeSegment(ctx, previous, point, padding, fillStyle);
    }

    ctx.restore();
    return this.getBounds(padding);
  }

  renderPreview(ctx, {
    padding = 0,
    fillStyle = 'rgba(153, 239, 255, 0.2)',
    strokeStyle = 'rgba(153, 239, 255, 0.92)',
    guideStyle = 'rgba(255, 191, 111, 0.9)',
    showBounds = true,
  } = {}) {
    const bounds = this.rasterize(ctx, { padding, fillStyle });
    if (!bounds) return null;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (this.points.length === 1) {
      ctx.arc(this.points[0].x, this.points[0].y, this.points[0].radius + padding, 0, Math.PI * 2);
    } else {
      ctx.moveTo(this.points[0].x, this.points[0].y);
      for (let index = 1; index < this.points.length; index += 1) {
        ctx.lineTo(this.points[index].x, this.points[index].y);
      }
    }
    ctx.stroke();

    if (showBounds) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = guideStyle;
      ctx.lineWidth = 1;
      ctx.strokeRect(bounds.minX, bounds.minY, bounds.width, bounds.height);
    }
    ctx.restore();
    return bounds;
  }

  _appendPoint(x, y, radius) {
    const point = { x, y, radius };
    const previous = this.points[this.points.length - 1];
    if (previous) {
      this.totalLength += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    this.points.push(point);
    this.baseBounds = expandBounds(this.baseBounds, x, y, radius);
  }

  _fillDisc(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  _strokeSegment(ctx, from, to, padding, fillStyle) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = fillStyle;
    ctx.lineWidth = (Math.max(from.radius, to.radius) + padding) * 2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }
}

export class ParticleBlobEnvelope {
  constructor({ trackingWindowMs = DEFAULT_TRACK_WINDOW_MS, flowInfluence = 1, trackingMode = 'cohort', tightness = 0.68 } = {}) {
    this.trackingWindowMs = trackingWindowMs;
    this.flowInfluence = Math.max(0, Number(flowInfluence) || 0);
    this.trackingMode = trackingMode;
    this.tightness = Math.max(0, Math.min(1, Number(tightness) || 0));
    this.reset();
  }

  setTightness(tightness) {
    this.tightness = Math.max(0, Math.min(1, Number(tightness) || 0));
    this._rebuild();
  }

  reset() {
    this.cohorts = [];
    this.nodes = [];
    this.polygon = [];
    this.bounds = null;
  }

  isEmpty() {
    return this.cohorts.length === 0;
  }

  addSpawn({ x, y, radius, startIndex = 0, count = 0, spawnTime = 0 } = {}) {
    const fallbackBounds = createBoundsFromCenter(x, y, clampRadius(radius));
    const cohort = {
      x,
      y,
      radius: clampRadius(radius),
      startIndex,
      count,
      spawnTime,
      expiresAt: spawnTime + this.trackingWindowMs,
      liveBounds: cloneBounds(fallbackBounds),
      maxBounds: cloneBounds(fallbackBounds),
      centroidX: fallbackBounds.centerX,
      centroidY: fallbackBounds.centerY,
      flowX: 0,
      flowY: 0,
    };
    this.cohorts.push(cohort);
    this._rebuild();
    return cohort;
  }

  updateFromParticles(particles, now = 0) {
    if (this.isEmpty()) return false;
    let changed = false;
    for (const cohort of this.cohorts) {
      if (now > cohort.expiresAt) continue;
      const nextMetrics = this.trackingMode === 'lbm-samples'
        ? cohortMetricsFromSampleField(particles, cohort, this.tightness)
        : cohortMetricsFromParticles(particles, cohort.startIndex, cohort.count, cohort.liveBounds);
      const nextBounds = nextMetrics.bounds;
      if (!nextBounds) continue;
      cohort.liveBounds = cloneBounds(nextBounds);
      const previousCentroidX = cohort.centroidX;
      const previousCentroidY = cohort.centroidY;
      const previousFlowX = cohort.flowX;
      const previousFlowY = cohort.flowY;
      cohort.centroidX = nextMetrics.centroidX;
      cohort.centroidY = nextMetrics.centroidY;
      cohort.flowX = nextMetrics.flowX;
      cohort.flowY = nextMetrics.flowY;
      if (isWiderBounds(nextBounds, cohort.maxBounds)) {
        cohort.maxBounds = cloneBounds(nextBounds);
        changed = true;
      }
      if (
        Math.abs(previousCentroidX - cohort.centroidX) > 0.2 ||
        Math.abs(previousCentroidY - cohort.centroidY) > 0.2 ||
        Math.abs(previousFlowX - cohort.flowX) > 0.02 ||
        Math.abs(previousFlowY - cohort.flowY) > 0.02
      ) {
        changed = true;
      }
    }
    if (changed) {
      this._rebuild();
    }
    return changed;
  }

  getBounds(padding = 0) {
    return normalizeBounds(this.bounds, Math.max(0, padding));
  }

  getPolygon(padding = 0) {
    if (!this.nodes.length) return [];
    return buildRibbonPolygon(this.nodes, Math.max(0, padding));
  }

  toDescriptor({ padding = 0 } = {}) {
    const polygon = this.getPolygon(padding);
    return {
      cohortCount: this.cohorts.length,
      trackingWindowMs: this.trackingWindowMs,
      bounds: this.getBounds(padding),
      polygon,
      cohorts: this.cohorts.map((cohort) => ({
        x: cohort.x,
        y: cohort.y,
        radius: cohort.radius,
        startIndex: cohort.startIndex,
        count: cohort.count,
        spawnTime: cohort.spawnTime,
        centroidX: cohort.centroidX,
        centroidY: cohort.centroidY,
        flowX: cohort.flowX,
        flowY: cohort.flowY,
        liveBounds: cloneBounds(cohort.liveBounds),
        maxBounds: cloneBounds(cohort.maxBounds),
      })),
    };
  }

  rasterize(ctx, {
    padding = 0,
    compositeOperation = 'source-over',
    fillStyle = 'rgba(255, 255, 255, 1)',
  } = {}) {
    if (!this.nodes.length) return null;
    ctx.save();
    ctx.globalCompositeOperation = compositeOperation;
    ctx.fillStyle = fillStyle;
    this._fillNodeRibbon(ctx, this.nodes, padding, fillStyle);
    ctx.restore();
    return boundsFromNodes(this.nodes, padding);
  }

  renderPreview(ctx, {
    padding = 0,
    fillStyle = 'rgba(153, 239, 255, 0.2)',
    strokeStyle = 'rgba(153, 239, 255, 0.92)',
    guideStyle = 'rgba(255, 191, 111, 0.9)',
    showBounds = true,
  } = {}) {
    if (!this.nodes.length) return null;

    const bounds = this.rasterize(ctx, { padding, fillStyle });
    if (!bounds) return null;

    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(this.nodes[0].x, this.nodes[0].y);
    for (let index = 1; index < this.nodes.length; index += 1) {
      ctx.lineTo(this.nodes[index].x, this.nodes[index].y);
    }
    ctx.stroke();
    ctx.restore();

    if (showBounds && bounds) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = guideStyle;
      ctx.lineWidth = 1;
      ctx.strokeRect(bounds.minX, bounds.minY, bounds.width, bounds.height);
      ctx.restore();
    }
    return bounds;
  }

  _rebuild() {
    this.nodes = this.cohorts.map((cohort) => {
      const sourceBounds = this.trackingMode === 'lbm-samples'
        ? blendBounds(cohort.maxBounds, cohort.liveBounds, 0.58 + this.tightness * 0.38)
        : (cohort.maxBounds || cohort.liveBounds || createBoundsFromCenter(cohort.x, cohort.y, cohort.radius));
      const liveBounds = cohort.liveBounds || sourceBounds;
      const centerX = Number.isFinite(cohort.centroidX) ? cohort.centroidX : liveBounds.centerX;
      const centerY = Number.isFinite(cohort.centroidY) ? cohort.centroidY : liveBounds.centerY;
      const flowX = (cohort.flowX ?? 0) * this.flowInfluence;
      const flowY = (cohort.flowY ?? 0) * this.flowInfluence;
      const flowMagnitude = Math.hypot(flowX, flowY);
      let baseRadius;
      if (this.trackingMode === 'lbm-samples') {
        const liveExtent = Math.max(liveBounds.width, liveBounds.height, cohort.radius * 1.15);
        const historicalExtent = Math.max(sourceBounds.width, sourceBounds.height, liveExtent);
        const widthCarry = 0.02 + (1 - this.tightness) * 0.16;
        baseRadius = liveExtent * 0.5 + Math.max(0, historicalExtent - liveExtent) * widthCarry;
        baseRadius = Math.min(baseRadius, cohort.radius * (1.18 + (1 - this.tightness) * 0.5) + flowMagnitude * (0.02 + (1 - this.tightness) * 0.05));
      } else {
        baseRadius = Math.max(sourceBounds.width, sourceBounds.height, cohort.radius * 2) * 0.5;
      }
      return {
        x: centerX,
        y: centerY,
        flowX,
        flowY,
        radius: Math.max(
          cohort.radius * (0.48 + (1 - this.tightness) * 0.2),
          baseRadius * (1 + Math.min(0.006 + (1 - this.tightness) * 0.018, flowMagnitude * (0.0016 + (1 - this.tightness) * 0.0032)))
        ),
      };
    });
    this.polygon = buildRibbonPolygon(this.nodes, 0);
    this.bounds = boundsFromNodes(this.nodes, 0);
  }

  _fillNodeRibbon(ctx, nodes, padding, fillStyle) {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      this._fillDisc(ctx, node.x, node.y, node.radius + padding);
      if (index === 0) continue;
      const previous = nodes[index - 1];
      this._strokeSegment(ctx, previous, node, padding, fillStyle);
    }
  }

  _fillDisc(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  _strokeSegment(ctx, from, to, padding, fillStyle) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = fillStyle;
    ctx.lineWidth = (Math.max(from.radius, to.radius) + padding) * 2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }
}
