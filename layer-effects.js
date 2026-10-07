const MAX_BLUR_RADIUS = 512;
const MAX_NATIVE_BLUR_RADIUS = 64;
const BLUR_SLIDER_MAX = 256;
const BLUR_SLIDER_LINEAR_MAX = 64;

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

export function normalizeLayerEffect(effect, fallbackId = 'effect-blur') {
  if (!effect || typeof effect !== 'object' || effect.type !== 'blur') return null;
  return {
    id: typeof effect.id === 'string' && effect.id.trim() ? effect.id.trim() : fallbackId,
    type: 'blur',
    name: typeof effect.name === 'string' && effect.name.trim() ? effect.name.trim() : 'Blur',
    enabled: effect.enabled !== false,
    opacity: clamp(effect.opacity, 0, 1, 1),
    radius: clamp(effect.radius, 0, MAX_BLUR_RADIUS, 8),
  };
}

export function normalizeLayerEffects(effects) {
  if (!Array.isArray(effects)) return [];
  return effects
    .map((effect, index) => normalizeLayerEffect(effect, `effect-blur-${index + 1}`))
    .filter(Boolean);
}

export function hasActiveLayerEffects(layer) {
  return normalizeLayerEffects(layer?.effects)
    .some(effect => effect.enabled && effect.opacity > 0 && effect.radius > 0);
}

export function blurRadiusFromSlider(position) {
  const value = clamp(position, 0, BLUR_SLIDER_MAX, 0);
  if (value <= BLUR_SLIDER_LINEAR_MAX) return Math.round(value);
  return Math.round(BLUR_SLIDER_LINEAR_MAX * (2 ** ((value - BLUR_SLIDER_LINEAR_MAX) / 64)));
}

export function blurRadiusToSlider(radius) {
  const value = clamp(radius, 0, MAX_BLUR_RADIUS, 0);
  if (value <= BLUR_SLIDER_LINEAR_MAX) return Math.round(value);
  return Math.round(BLUR_SLIDER_LINEAR_MAX + 64 * Math.log2(value / BLUR_SLIDER_LINEAR_MAX));
}

export class LayerEffectRenderer {
  constructor(createCanvas = null) {
    this._createCanvas = createCanvas || ((width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    });
    this._cache = new WeakMap();
  }

  invalidate(layer) {
    const cached = layer ? this._cache.get(layer) : null;
    if (cached) cached.invalidated = true;
  }

  resolve(layer, { includePreview = true } = {}) {
    const effects = normalizeLayerEffects(layer?.effects);
    const active = effects.filter(effect => effect.enabled && effect.opacity > 0 && effect.radius > 0);
    if (!layer?.canvas || !active.length) {
      const previous = this._cache.get(layer);
      this._cache.delete(layer);
      return { canvas: layer?.canvas || null, includesPreview: false, changed: !!previous };
    }

    const signature = active
      .map(effect => `${effect.id}:${effect.radius}:${effect.opacity}`)
      .join('|');
    const preview = includePreview ? (layer.gpuPreviewCanvas || null) : null;
    const previous = this._cache.get(layer);
    const canReuse = previous
      && previous.signature === signature
      && previous.width === layer.canvas.width
      && previous.height === layer.canvas.height
      && !previous.invalidated
      && !layer.dirty
      && !preview
      && !previous.hadPreview;
    if (canReuse) {
      return { canvas: previous.output, includesPreview: false, changed: false };
    }

    const width = layer.canvas.width;
    const height = layer.canvas.height;
    const dpr = Math.max(1, width / Math.max(1, layer._bbCssWidth || width));
    let source = previous?.source;
    let target = previous?.target;
    let blurSource = previous?.blurSource;
    let blurTarget = previous?.blurTarget;
    if (!source || source.width !== width || source.height !== height) {
      source = this._createCanvas(width, height);
      target = this._createCanvas(width, height);
    }

    const sourceCtx = source.getContext('2d');
    sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
    sourceCtx.clearRect(0, 0, width, height);
    sourceCtx.globalAlpha = 1;
    sourceCtx.globalCompositeOperation = 'source-over';
    sourceCtx.filter = 'none';
    sourceCtx.drawImage(layer.canvas, 0, 0);
    if (preview) sourceCtx.drawImage(preview, 0, 0, width, height);

    for (const effect of active) {
      const targetCtx = target.getContext('2d');
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.clearRect(0, 0, width, height);
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.globalAlpha = 1;
      targetCtx.filter = 'none';
      targetCtx.drawImage(source, 0, 0);
      targetCtx.globalAlpha = effect.opacity;
      const deviceRadius = effect.radius * dpr;
      if (deviceRadius <= MAX_NATIVE_BLUR_RADIUS) {
        targetCtx.filter = `blur(${deviceRadius}px)`;
        targetCtx.drawImage(source, 0, 0);
      } else {
        const downsampleSteps = Math.ceil(Math.log2(deviceRadius / MAX_NATIVE_BLUR_RADIUS));
        const scale = 2 ** -downsampleSteps;
        const scaledWidth = Math.max(1, Math.ceil(width * scale));
        const scaledHeight = Math.max(1, Math.ceil(height * scale));
        if (!blurSource || blurSource.width !== scaledWidth || blurSource.height !== scaledHeight) {
          blurSource = this._createCanvas(scaledWidth, scaledHeight);
          blurTarget = this._createCanvas(scaledWidth, scaledHeight);
        }
        const blurSourceCtx = blurSource.getContext('2d');
        blurSourceCtx.setTransform(1, 0, 0, 1, 0, 0);
        blurSourceCtx.clearRect(0, 0, scaledWidth, scaledHeight);
        blurSourceCtx.filter = 'none';
        blurSourceCtx.globalAlpha = 1;
        blurSourceCtx.globalCompositeOperation = 'source-over';
        blurSourceCtx.drawImage(source, 0, 0, width, height, 0, 0, scaledWidth, scaledHeight);

        const blurTargetCtx = blurTarget.getContext('2d');
        blurTargetCtx.setTransform(1, 0, 0, 1, 0, 0);
        blurTargetCtx.clearRect(0, 0, scaledWidth, scaledHeight);
        blurTargetCtx.globalAlpha = 1;
        blurTargetCtx.globalCompositeOperation = 'source-over';
        blurTargetCtx.filter = `blur(${deviceRadius * scale}px)`;
        blurTargetCtx.drawImage(blurSource, 0, 0);
        blurTargetCtx.filter = 'none';
        targetCtx.filter = 'none';
        targetCtx.drawImage(blurTarget, 0, 0, scaledWidth, scaledHeight, 0, 0, width, height);
      }
      targetCtx.filter = 'none';
      targetCtx.globalAlpha = 1;
      [source, target] = [target, source];
    }

    this._cache.set(layer, {
      signature,
      width,
      height,
      source,
      target,
      blurSource,
      blurTarget,
      output: source,
      hadPreview: !!preview,
      invalidated: false,
    });
    return { canvas: source, includesPreview: !!preview, changed: true };
  }
}

export { BLUR_SLIDER_MAX, MAX_BLUR_RADIUS, MAX_NATIVE_BLUR_RADIUS };
