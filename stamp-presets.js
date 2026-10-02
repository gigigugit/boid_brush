/**
 * Convert inline SVG markup into a compact data URL so stamp presets can be
 * bundled directly in source without separate asset fetches.
 * @param {string} svg
 * @returns {string}
 */
function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
}

export const DEFAULT_STAMP_PRESET_ID = 'soft-round';

export const BUILTIN_STAMP_IMAGE_PRESETS = Object.freeze([
  {
    id: 'soft-round',
    name: 'Soft Round',
    sourceType: 'builtin',
    licenseLabel: 'Local asset',
    sourceUrl: './visual-assets/stamps/soft-round.png',
    dataUrl: './visual-assets/stamps/soft-round.png',
  },
  {
    id: 'builtin-circle',
    name: 'Circle',
    sourceType: 'builtin',
    licenseLabel: 'Built-in shape',
    sourceUrl: '',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="#0F172A"/>
      </svg>
    `),
  },
  {
    id: 'faint-round',
    name: 'Faint Round',
    sourceType: 'localasset',
    licenseLabel: 'Local asset',
    sourceUrl: './visual-assets/stamps/faint-round.png',
    dataUrl: './visual-assets/stamps/faint-round.png',
  }
]);

export function getBuiltinStampPreset(id) {
  return BUILTIN_STAMP_IMAGE_PRESETS.find(preset => preset.id === id) || null;
}
