function clamp(value, min, max) {
  return value < min ? min : (value > max ? max : value);
}
function clamp01(value) {
  return clamp(value, 0, 1);
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

/**
 * Generic monotone-Hermite spline evaluator shared by every "drag points on a
 * canvas" curve editor in the app. `curve` is a sorted `[x, y]` point list
 * with `x` always read in the unipolar 0..1 domain (matching a normalized
 * pressure or channel signal); `y` is passed through unclamped internally and
 * only clamped to `[clampMin, clampMax]` on the way out, so callers can reuse
 * the exact same interpolation for a unipolar 0..1 output (the stylus
 * pressure curves) or a bipolar -1..1 output (the input-modulation curve)
 * without duplicating the spline math.
 *
 * On malformed/absent curve data this never throws: it falls back to
 * `fallback(value)` (or, without a fallback, the clamped input itself), so a
 * corrupted document degrades to a safe passthrough instead of breaking the
 * caller.
 */
export function evaluateSplineCurve(curve, x, { clampMin = 0, clampMax = 1, fallback } = {}) {
  const value = clamp01(Number.isFinite(x) ? x : 0.5);
  const clampOut = v => clamp(v, clampMin, clampMax);
  if (!Array.isArray(curve) || curve.length < 2) {
    return typeof fallback === 'function' ? fallback(value) : clampOut(value);
  }

  for (let index = 0; index < curve.length; index += 1) {
    const point = curve[index];
    if (!Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])
      || (index > 0 && point[0] <= curve[index - 1][0])) {
      return typeof fallback === 'function' ? fallback(value) : clampOut(value);
    }
  }
  if (value <= curve[0][0]) return clampOut(curve[0][1]);
  if (value >= curve[curve.length - 1][0]) return clampOut(curve[curve.length - 1][1]);

  let segment = 0;
  while (segment < curve.length - 2 && value > curve[segment + 1][0]) segment += 1;
  const start = curve[segment];
  const end = curve[segment + 1];
  const span = end[0] - start[0];
  const t = (value - start[0]) / span;
  if (curve.length === 2) return clampOut(start[1] + (end[1] - start[1]) * t);
  const t2 = t * t;
  const t3 = t2 * t;
  const tangents = buildTangents(curve);
  const output = (2 * t3 - 3 * t2 + 1) * start[1]
    + (t3 - 2 * t2 + t) * span * tangents[segment]
    + (-2 * t3 + 3 * t2) * end[1]
    + (t3 - t2) * span * tangents[segment + 1];
  return clampOut(output);
}

export function evaluatePressureCurve(curve, pressure, fallbackLow = 0.3) {
  return evaluateSplineCurve(curve, pressure, {
    clampMin: 0,
    clampMax: 1,
    fallback: value => fallbackLow + (1 - fallbackLow) * value,
  });
}
