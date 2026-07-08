const DOC_VERSION = 1;

let shapeSeq = 1;

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function createShapeId(prefix = 'shape') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${shapeSeq++}`;
}

function normalizeStyle(kind, style = {}) {
  const isStrokeOnly = kind === 'line' || kind === 'polyline';
  return {
    fill: style.fill ?? (isStrokeOnly ? 'none' : '#5b8af0'),
    stroke: style.stroke ?? '#e8edf8',
    strokeWidth: Math.max(1, Number(style.strokeWidth) || 1),
    opacity: Math.min(1, Math.max(0.05, Number(style.opacity) || 1)),
  };
}

function normalizeMeta(meta = {}) {
  return {
    guideRole: meta.guideRole || 'none',
    closed: !!meta.closed,
  };
}

function normalizeGeometry(kind, geometry = {}) {
  if (kind === 'rect') {
    return {
      x: Number(geometry.x) || 0,
      y: Number(geometry.y) || 0,
      width: Math.max(1, Number(geometry.width) || 1),
      height: Math.max(1, Number(geometry.height) || 1),
    };
  }
  if (kind === 'ellipse') {
    return {
      cx: Number(geometry.cx) || 0,
      cy: Number(geometry.cy) || 0,
      rx: Math.max(1, Number(geometry.rx) || 1),
      ry: Math.max(1, Number(geometry.ry) || 1),
    };
  }
  if (kind === 'line') {
    return {
      x1: Number(geometry.x1) || 0,
      y1: Number(geometry.y1) || 0,
      x2: Number(geometry.x2) || 0,
      y2: Number(geometry.y2) || 0,
    };
  }
  const points = Array.isArray(geometry.points) ? geometry.points : [];
  return {
    points: points.map(point => ({
      x: Number(point?.x) || 0,
      y: Number(point?.y) || 0,
    })),
  };
}

export function createShape(kind, geometry, style = {}, meta = {}) {
  return {
    id: createShapeId(),
    kind,
    geometry: normalizeGeometry(kind, geometry),
    style: normalizeStyle(kind, style),
    meta: normalizeMeta(meta),
  };
}

export function createEmptyDocument(width = 1600, height = 900) {
  return {
    version: DOC_VERSION,
    width,
    height,
    background: '#10141d',
    items: [],
  };
}

export function cloneDocument(doc) {
  return deepClone(doc);
}

export function normalizeDocument(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid vector document');
  const width = Math.max(1, Number(payload.width) || 1600);
  const height = Math.max(1, Number(payload.height) || 900);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    version: DOC_VERSION,
    width,
    height,
    background: typeof payload.background === 'string' ? payload.background : '#10141d',
    items: items
      .filter(item => item && typeof item === 'object' && typeof item.kind === 'string')
      .map(item => ({
        id: item.id || createShapeId(),
        kind: item.kind,
        geometry: normalizeGeometry(item.kind, item.geometry),
        style: normalizeStyle(item.kind, item.style),
        meta: normalizeMeta(item.meta),
      })),
  };
}

export function translateShape(shape, dx, dy) {
  const next = deepClone(shape);
  if (next.kind === 'rect') {
    next.geometry.x += dx;
    next.geometry.y += dy;
  } else if (next.kind === 'ellipse') {
    next.geometry.cx += dx;
    next.geometry.cy += dy;
  } else if (next.kind === 'line') {
    next.geometry.x1 += dx;
    next.geometry.y1 += dy;
    next.geometry.x2 += dx;
    next.geometry.y2 += dy;
  } else {
    next.geometry.points = next.geometry.points.map(point => ({ x: point.x + dx, y: point.y + dy }));
  }
  return next;
}

export function updateShapePoint(shape, pointIndex, x, y) {
  const next = deepClone(shape);
  if (next.kind === 'line') {
    if (pointIndex === 0) {
      next.geometry.x1 = x;
      next.geometry.y1 = y;
    } else {
      next.geometry.x2 = x;
      next.geometry.y2 = y;
    }
    return next;
  }
  if (next.kind === 'polyline' && next.geometry.points[pointIndex]) {
    next.geometry.points[pointIndex] = { x, y };
  }
  return next;
}

export function getShapePoints(shape) {
  if (shape.kind === 'line') {
    return [
      { x: shape.geometry.x1, y: shape.geometry.y1 },
      { x: shape.geometry.x2, y: shape.geometry.y2 },
    ];
  }
  if (shape.kind === 'polyline') return shape.geometry.points.map(point => ({ ...point }));
  if (shape.kind === 'rect') {
    const { x, y, width, height } = shape.geometry;
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }
  if (shape.kind === 'ellipse') {
    const { cx, cy, rx, ry } = shape.geometry;
    return [
      { x: cx - rx, y: cy - ry },
      { x: cx + rx, y: cy - ry },
      { x: cx + rx, y: cy + ry },
      { x: cx - rx, y: cy + ry },
    ];
  }
  return [];
}

export function getShapeBounds(shape) {
  const points = getShapePoints(shape);
  if (!points.length) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}
