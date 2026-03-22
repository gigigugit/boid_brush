// =============================================================================
// psd-io.js — PSD (Photoshop) file import / export
//
// Uses the ag-psd library (loaded from CDN) to read and write .psd files.
// Supports layers with names, opacity, blend modes, and visibility.
// =============================================================================

let _agPsd = null;

/**
 * Lazily load ag-psd from CDN on first use.
 * Returns the module object { readPsd, writePsd, initializeCanvas }.
 */
async function _loadAgPsd() {
  if (_agPsd) return _agPsd;
  _agPsd = await import('https://esm.sh/ag-psd@30.1.0');
  // Tell ag-psd how to create canvas elements in the browser
  _agPsd.initializeCanvas(
    (width, height) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      return c;
    },
    (canvas, width, height) => {
      return canvas.getContext('2d').createImageData(width, height);
    }
  );
  return _agPsd;
}

// ── Blend mode mapping ─────────────────────────────────────────────────────

/** CSS globalCompositeOperation → PSD blendMode */
const CSS_TO_PSD_BLEND = {
  'source-over': 'normal',
  'multiply':    'multiply',
  'screen':      'screen',
  'overlay':     'overlay',
  'darken':      'darken',
  'lighten':     'lighten',
  'color-dodge': 'color dodge',
  'color-burn':  'color burn',
  'hard-light':  'hard light',
  'soft-light':  'soft light',
  'difference':  'difference',
  'exclusion':   'exclusion',
  'hue':         'hue',
  'saturation':  'saturation',
  'color':       'color',
  'luminosity':  'luminosity',
};

/** PSD blendMode → CSS globalCompositeOperation */
const PSD_TO_CSS_BLEND = {};
for (const [css, psd] of Object.entries(CSS_TO_PSD_BLEND)) {
  PSD_TO_CSS_BLEND[psd] = css;
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * Export the current document as a .psd file.
 * @param {App} app  The application instance
 */
export async function exportPSD(app) {
  try {
    app.showToast('⏳ Exporting PSD…');
    const { writePsd } = await _loadAgPsd();

    const w = app.W * app.DPR;   // physical pixel dimensions
    const h = app.H * app.DPR;

    // Build PSD children array (top-to-bottom, same order as app.layers)
    const children = [];
    for (const layer of app.layers) {
      // Create a clean copy of the layer canvas (without DPR transform)
      const copy = document.createElement('canvas');
      copy.width = w;
      copy.height = h;
      const copyCtx = copy.getContext('2d');
      copyCtx.drawImage(layer.canvas, 0, 0);

      children.push({
        name:      layer.name || 'Layer',
        canvas:    copy,
        left:      0,
        top:       0,
        right:     w,
        bottom:    h,
        opacity:   Math.round(layer.opacity * 255),
        blendMode: CSS_TO_PSD_BLEND[layer.blend] || 'normal',
        hidden:    !layer.visible,
      });
    }

    const psd = {
      width:  w,
      height: h,
      children,
    };

    const buffer = writePsd(psd);
    const blob = new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = 'boid-brush.psd';
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    app.showToast('💾 Exported PSD');
  } catch (err) {
    console.error('PSD export failed:', err);
    app.showToast('⚠ PSD export failed');
  }
}

// ── Import ──────────────────────────────────────────────────────────────────

/**
 * Show a file picker and import a .psd file as layers.
 * @param {App} app  The application instance
 */
export async function importPSD(app) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.psd,image/vnd.adobe.photoshop,application/x-photoshop,application/photoshop';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      app.showToast('⏳ Importing PSD…');
      const { readPsd } = await _loadAgPsd();
      const arrayBuffer = await file.arrayBuffer();
      const psd = readPsd(arrayBuffer);

      if (!psd.children || psd.children.length === 0) {
        app.showToast('⚠ PSD has no layers');
        return;
      }

      app.pushUndo();

      // Remove all existing paint layers (keep background)
      const bgLayer = app.layers.find(l => l.isBackground);
      for (const l of app.layers) {
        if (!l.isBackground) app.compositor?.deleteLayerTex(l);
      }
      app.layers = bgLayer ? [bgLayer] : [];

      // Resize canvas if PSD dimensions differ
      const psdW = psd.width;
      const psdH = psd.height;

      // Recursively collect raster layers (flattens groups)
      const newLayers = [];
      function collectLayers(children, prefix) {
        for (const child of children) {
          // Recurse into groups
          if (child.children) {
            const groupPrefix = prefix
              ? `${prefix}/${child.name || 'Group'}`
              : (child.name || 'Group');
            collectLayers(child.children, groupPrefix);
            continue;
          }
          if (!child.canvas) continue;  // skip layers without pixel data

          const { canvas: layerCanvas, ctx: layerCtx } = app.makeLayerCanvas();
          layerCtx.save();
          layerCtx.setTransform(1, 0, 0, 1, 0, 0);

          // Scale PSD layer to fit current canvas if dimensions differ
          const srcW = child.canvas.width;
          const srcH = child.canvas.height;
          const dstW = layerCanvas.width;
          const dstH = layerCanvas.height;
          const left = (child.left || 0) * (dstW / psdW);
          const top  = (child.top  || 0) * (dstH / psdH);
          const drawW = srcW * (dstW / psdW);
          const drawH = srcH * (dstH / psdH);

          layerCtx.drawImage(child.canvas, 0, 0, srcW, srcH, left, top, drawW, drawH);
          layerCtx.restore();
          layerCtx.setTransform(app.DPR, 0, 0, app.DPR, 0, 0);

          const blend = PSD_TO_CSS_BLEND[child.blendMode] || 'source-over';
          const opacity = typeof child.opacity === 'number' ? child.opacity / 255 : 1;
          const layerName = prefix
            ? `${prefix}/${child.name || 'Layer'}`
            : (child.name || 'Layer');

          newLayers.push({
            canvas: layerCanvas,
            ctx: layerCtx,
            name: layerName,
            visible: !child.hidden,
            opacity: Math.max(0, Math.min(1, opacity)),
            blend,
            dirty: true,
            glTex: null,
          });
        }
      }
      collectLayers(psd.children, '');

      if (newLayers.length === 0) {
        app.showToast('⚠ PSD had no raster layers');
        // Restore at least one empty layer
        app.addLayer('Layer 1');
        return;
      }

      // Place new layers before the background
      if (bgLayer) {
        app.layers = [...newLayers, bgLayer];
      } else {
        app.layers = newLayers;
      }

      app.activeLayerIdx = 0;
      app._syncLayerSwitcher();
      app.compositeAllLayers();
      app.showToast(`📂 Imported ${newLayers.length} layer(s) from PSD`);
    } catch (err) {
      console.error('PSD import failed:', err);
      app.showToast('⚠ PSD import failed');
    }
  });
  input.click();
}
