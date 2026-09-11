const MIN_POINT_DISTANCE = 2;
const MAX_CORRAL_POINTS = 256;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizePoints(points) {
  if (!Array.isArray(points)) return [];
  const result = [];
  for (const point of points) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(x - previous.x, y - previous.y) >= MIN_POINT_DISTANCE) {
      result.push({ x, y });
    }
  }
  if (result.length > 2 && Math.hypot(
    result[0].x - result[result.length - 1].x,
    result[0].y - result[result.length - 1].y,
  ) < MIN_POINT_DISTANCE) result.pop();
  return result;
}

function resampleClosed(points, maxPoints = MAX_CORRAL_POINTS) {
  if (points.length <= maxPoints) return points;
  const lengths = [];
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(perimeter);
  }
  if (perimeter <= 0) return [];
  const result = [];
  for (let sample = 0; sample < maxPoints; sample++) {
    const target = perimeter * sample / maxPoints;
    let segment = lengths.findIndex(length => length >= target);
    if (segment < 0) segment = lengths.length - 1;
    const startLength = segment === 0 ? 0 : lengths[segment - 1];
    const segmentLength = Math.max(1e-6, lengths[segment] - startLength);
    const t = (target - startLength) / segmentLength;
    const a = points[segment];
    const b = points[(segment + 1) % points.length];
    result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return result;
}

export function smoothClosedCorral(points, iterations = 2) {
  let current = sanitizePoints(points);
  if (current.length < 3) return [];
  for (let pass = 0; pass < Math.max(0, Math.min(3, iterations)); pass++) {
    const next = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
      );
    }
    current = resampleClosed(next);
  }
  return resampleClosed(current);
}

export function pointInCorral(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (((a.y > y) !== (b.y > y))
      && x < ((b.x - a.x) * (y - a.y)) / ((b.y - a.y) || 1e-9) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function compileCorral(points) {
  const clean = resampleClosed(sanitizePoints(points));
  if (clean.length < 3) return null;
  const bounds = clean.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x),
    minY: Math.min(box.minY, point.y),
    maxX: Math.max(box.maxX, point.x),
    maxY: Math.max(box.maxY, point.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const signedArea = clean.reduce((area, point, index) => {
    const next = clean[(index + 1) % clean.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0);
  return { points: clean, bounds, winding: signedArea >= 0 ? 1 : -1 };
}

function closestBoundaryPoint(x, y, points) {
  let closest = null;
  let bestDistance2 = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t = length2 > 1e-9 ? clamp(((x - a.x) * dx + (y - a.y) * dy) / length2, 0, 1) : 0;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const distance2 = (x - px) ** 2 + (y - py) ** 2;
    if (distance2 < bestDistance2) {
      bestDistance2 = distance2;
      closest = { x: px, y: py, distance: Math.sqrt(distance2), dx, dy };
    }
  }
  return closest;
}

export function corralRepulsionWeight(distance, radius) {
  const influenceRadius = Math.max(0, Number(radius) || 0);
  if (influenceRadius <= 0 || distance >= influenceRadius) return 0;
  const u = clamp(1 - Math.max(0, distance) / influenceRadius, 0, 1);
  return u * u * (3 - 2 * u);
}

export function corralForceWeight(distance, radius, midpoint = 0.5, falloff = 'smooth') {
  const influenceRadius = Math.max(0, Number(radius) || 0);
  if (influenceRadius <= 0 || distance >= influenceRadius) return 0;
  const t = clamp(Math.max(0, distance) / influenceRadius, 0, 1);
  if (falloff === 'linear') return 1 - t;
  if (falloff === 'quadratic') return (1 - t) ** 2;
  const base = corralRepulsionWeight(distance, influenceRadius);
  const midpointCorrection = (clamp(Number(midpoint) || 0, 0, 1.5) - 0.5)
    * 16 * t * t * (1 - t) * (1 - t);
  return Math.max(0, base + midpointCorrection);
}

export function constrainAgentsToCorral(read, compiled, options = {}, legacyRadius = 32) {
  if (!compiled || !read?.buffer || !read.count || read.stride < 4) return false;
  const legacy = typeof options === 'number';
  const config = legacy
    ? { edgeStrength: options, repulsionRadius: legacyRadius }
    : options;
  const response = clamp(Number(config.edgeStrength) || 0, 0, 2);
  const influenceRadius = clamp(Number(config.repulsionRadius) || 0, 0, 300);
  const hardEdge = config.hardEdge !== false;
  const tangentialForce = clamp(Number(config.tangentialForce) || 0, -2, 2);
  const midpointForce = clamp(Number(config.midpointForce ?? 0.5), 0, 1.5);
  const normalDamping = clamp(Number(config.normalDamping) || 0, 0, 1);
  const tangentialFriction = clamp(Number(config.tangentialFriction) || 0, 0, 1);
  let changed = false;
  for (let i = 0; i < read.count; i++) {
    const base = i * read.stride;
    let x = read.buffer[base];
    let y = read.buffer[base + 1];
    const inside = pointInCorral(x, y, compiled.points);
    const nearest = closestBoundaryPoint(x, y, compiled.points);
    if (!nearest) continue;
    const edgeLength = Math.hypot(nearest.dx, nearest.dy) || 1;
    const nx = compiled.winding * -nearest.dy / edgeLength;
    const ny = compiled.winding * nearest.dx / edgeLength;
    if (!inside && hardEdge) {
      x = nearest.x + nx * 0.75;
      y = nearest.y + ny * 0.75;
      read.buffer[base] = x;
      read.buffer[base + 1] = y;
      changed = true;
    }
    const profile = inside
      ? corralForceWeight(nearest.distance, influenceRadius, midpointForce, config.falloff)
      : 1;
    if ((!inside && hardEdge) || profile > 0) {
      const push = response * profile;
      let vx = read.buffer[base + 2];
      let vy = read.buffer[base + 3];
      const outwardVelocity = vx * -nx + vy * -ny;
      if (hardEdge && outwardVelocity > 0) {
        vx += nx * outwardVelocity * (1 + Math.min(1, response));
        vy += ny * outwardVelocity * (1 + Math.min(1, response));
      }
      const tx = -ny;
      const ty = nx;
      const normalVelocity = vx * nx + vy * ny;
      const tangentVelocity = vx * tx + vy * ty;
      const dampedNormal = normalVelocity * (1 - profile * normalDamping);
      const dampedTangent = tangentVelocity * (1 - profile * tangentialFriction);
      const nextVx = nx * (dampedNormal + push) + tx * (dampedTangent + tangentialForce * profile);
      const nextVy = ny * (dampedNormal + push) + ty * (dampedTangent + tangentialForce * profile);
      if (nextVx !== read.buffer[base + 2] || nextVy !== read.buffer[base + 3]) {
        read.buffer[base + 2] = nextVx;
        read.buffer[base + 3] = nextVy;
        changed = true;
      }
    }
  }
  return changed;
}

export function corralToSvg(points, width, height) {
  const clean = sanitizePoints(points);
  if (clean.length < 3) throw new Error('A corral needs at least three points');
  const path = clean.map((point, index) =>
    `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  ).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(1, width)} ${Math.max(1, height)}"><path d="${path} Z" fill="none" stroke="#ff2bd6" stroke-width="2"/></svg>`;
}

export function extractClosedSvgPath(svgText) {
  if (typeof svgText !== 'string' || svgText.length > 1024 * 1024) throw new Error('SVG file is too large');
  const rootMatch = svgText.match(/<svg\b([^>]*)>/i);
  const pathMatches = [...svgText.matchAll(/<path\b([^>]*)\/?>/gi)];
  if (!rootMatch || !/<\/svg\s*>/i.test(svgText) || pathMatches.length !== 1) {
    throw new Error('SVG must contain one path');
  }
  if (/<(?:script|use|image|foreignObject)\b/i.test(svgText) || /\btransform\s*=/i.test(svgText)) {
    throw new Error('SVG transforms and external content are not supported');
  }
  const readAttribute = (attributes, name) => {
    const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    return match ? (match[2] ?? match[3] ?? '') : '';
  };
  const d = readAttribute(pathMatches[0][1], 'd').trim();
  if (!/[zZ]\s*$/.test(d)) throw new Error('SVG path must be closed');
  const viewBox = readAttribute(rootMatch[1], 'viewBox').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value)) || viewBox[2] <= 0 || viewBox[3] <= 0) {
    throw new Error('SVG requires a valid viewBox');
  }
  return { d, viewBox };
}
