const MAX_BLUR_RADIUS = 64;

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
    if (layer) this._cache.delete(layer);
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
      targetCtx.filter = `blur(${effect.radius * dpr}px)`;
      targetCtx.drawImage(source, 0, 0);
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
      output: source,
      hadPreview: !!preview,
    });
    return { canvas: source, includesPreview: !!preview, changed: true };
  }
}

export { MAX_BLUR_RADIUS };
