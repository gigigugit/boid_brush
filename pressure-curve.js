function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function endpointSlope(hereSpan, nextSpan, hereSlope, nextSlope) {
  let tangent = ((2 * hereSpan + nextSpan) * hereSlope - hereSpan * nextSlope)
    / (hereSpan + nextSpan);
  if (Math.sign(tangent) !== Math.sign(hereSlope)) return 0;
  if (Math.sign(hereSlope) !== Math.sign(nextSlope) && Math.abs(tangent) > Math.abs(3 * hereSlope)) {
    tangent = 3 * hereSlope;
  }
  return tangent;
}

function buildTangents(points) {
  const count = points.length;
  const spans = new Array(count - 1);
  const slopes = new Array(count - 1);
  for (let index = 0; index < count - 1; index += 1) {
    spans[index] = points[index + 1][0] - points[index][0];
    slopes[index] = (points[index + 1][1] - points[index][1]) / spans[index];
  }

  if (count === 2) return [slopes[0], slopes[0]];

  const tangents = new Array(count);
  tangents[0] = endpointSlope(spans[0], spans[1], slopes[0], slopes[1]);
  tangents[count - 1] = endpointSlope(
    spans[count - 2],
    spans[count - 3],
    slopes[count - 2],
    slopes[count - 3],
  );

  for (let index = 1; index < count - 1; index += 1) {
    const previousSlope = slopes[index - 1];
    const nextSlope = slopes[index];
    if (previousSlope === 0 || nextSlope === 0 || Math.sign(previousSlope) !== Math.sign(nextSlope)) {
      tangents[index] = 0;
      continue;
    }
    const previousSpan = spans[index - 1];
    const nextSpan = spans[index];
    const previousWeight = 2 * nextSpan + previousSpan;
    const nextWeight = nextSpan + 2 * previousSpan;
    tangents[index] = (previousWeight + nextWeight)
      / (previousWeight / previousSlope + nextWeight / nextSlope);
  }
  return tangents;
}

export function evaluatePressureCurve(curve, pressure, fallbackLow = 0.3) {
  const value = clamp01(Number.isFinite(pressure) ? pressure : 0.5);
  if (!Array.isArray(curve) || curve.length < 2) {
    return fallbackLow + (1 - fallbackLow) * value;
  }

  for (let index = 0; index < curve.length; index += 1) {
    const point = curve[index];
    if (!Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])
      || (index > 0 && point[0] <= curve[index - 1][0])) {
      return fallbackLow + (1 - fallbackLow) * value;
    }
  }
  if (value <= curve[0][0]) return clamp01(curve[0][1]);
  if (value >= curve[curve.length - 1][0]) return clamp01(curve[curve.length - 1][1]);

  let segment = 0;
  while (segment < curve.length - 2 && value > curve[segment + 1][0]) segment += 1;
  const start = curve[segment];
  const end = curve[segment + 1];
  const span = end[0] - start[0];
  const t = (value - start[0]) / span;
  if (curve.length === 2) return clamp01(start[1] + (end[1] - start[1]) * t);
  const t2 = t * t;
  const t3 = t2 * t;
  const tangents = buildTangents(curve);
  const output = (2 * t3 - 3 * t2 + 1) * start[1]
    + (t3 - 2 * t2 + t) * span * tangents[segment]
    + (-2 * t3 + 3 * t2) * end[1]
    + (t3 - t2) * span * tangents[segment + 1];
  return clamp01(output);
}
