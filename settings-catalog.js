// Pure ownership rules shared by preset, favorites, search, and workspace JSON.
export const SETTINGS_BRUSHES = Object.freeze([
  'boid', 'ant', 'bristle', 'simple', 'eraser', 'fluid', 'fluid3d', 'motionPath',
]);

const WORKSPACE_SHARED_SECTIONS = Object.freeze([
  'brushScale', 'fill', 'stamp', 'stampImage', 'canvasTexture', 'symmetry',
  'taper', 'trailBlur', 'kmMix', 'impasto', 'pencilHover',
]);

const WORKSPACE_BRUSH_SECTIONS = Object.freeze({
  boid: ['spawn', 'swarm', 'forces', 'quorum', 'variance', 'motion', 'leaders', 'visual', 'sensing', 'antPheromone'],
  ant: ['spawn', 'swarm', 'forces', 'variance', 'motion', 'visual', 'sensing', 'antPheromone'],
  bristle: ['bristleShape', 'bristlePhysics', 'bristleVariance', 'bristleVisual'],
  simple: [],
  eraser: [],
  fluid: ['fluidBrush', 'fluidForces', 'fluidMidrange', 'fluidFlow', 'fluidSettling', 'fluidRendering'],
  fluid3d: ['fluid3dBrush', 'fluid3dDynamics', 'fluid3dInteraction', 'fluid3dRendering'],
  motionPath: ['motionPathGraph', 'motionPathRuntime'],
});

export const SETTINGS_ALIASES = Object.freeze({});

export function normalizeBrushToken(value, fallback = 'boid') {
  return SETTINGS_BRUSHES.includes(value) ? value : fallback;
}

export function readControlValue(control) {
  if (!control) return undefined;
  if (control.type === 'checkbox') return !!control.checked;
  if (control.type === 'range' || control.type === 'number') {
    const value = Number(control.value);
    return Number.isFinite(value) ? value : undefined;
  }
  return String(control.value);
}

export function writeControlValue(control, value) {
  if (!control) return false;
  if (control.type === 'checkbox') control.checked = !!value;
  else control.value = String(value);
  return true;
}

export function createCatalogEntry({
  id,
  label = id,
  section = '',
  brushes = [],
  type = 'string',
  description = '',
  explicitBrushOwnership = false,
} = {}) {
  const ownedBrushes = WORKSPACE_SHARED_SECTIONS.includes(section) && !explicitBrushOwnership
    ? []
    : [...new Set(brushes)].filter(brush => SETTINGS_BRUSHES.includes(brush));
  const sessionOnly = [
    'simSidebarSessionSelect', 'simEphemeralMode', 'simSpeed', 'simEphemeralFrames', 'simEphemeralFade',
    'showSimulationOverlayControls', 'autoSaveSession',
  ].includes(id);
  const simulationControl = id?.startsWith('sim') && !sessionOnly;
  const scope = sessionOnly
    ? { kind: 'session' }
    : ownedBrushes.length
    ? { kind: 'brush', brushes: ownedBrushes }
    : simulationControl
      ? { kind: 'simulation', brushes: ['boid', 'ant'] }
      : { kind: 'shared' };
  return Object.freeze({
    id,
    label: label || id,
    section,
    description,
    type,
    scope,
    presetEligible: scope.kind === 'brush',
    simulationPresetEligible: scope.kind === 'brush' || scope.kind === 'simulation',
    favoriteEligible: scope.kind === 'brush' || scope.kind === 'simulation' || scope.kind === 'shared',
  });
}

export function catalogEntryApplies(entry, brush, kind = 'brush') {
  if (!entry) return false;
  const resolved = SETTINGS_ALIASES[entry.id] || entry.id;
  if (!resolved) return false;
  if (kind === 'brush') {
    return entry.presetEligible && entry.scope.brushes.includes(brush);
  }
  if (kind === 'simulation') {
    if (!['boid', 'ant'].includes(brush)) return false;
    return entry.simulationPresetEligible
      && (entry.scope.kind === 'simulation' || entry.scope.brushes.includes(brush));
  }
  return entry.scope.kind === 'shared'
    || entry.scope.brushes?.includes(brush)
    || (entry.scope.kind === 'simulation' && ['boid', 'ant'].includes(brush));
}

export function resolveCatalogId(id, catalog) {
  const resolved = SETTINGS_ALIASES[id] || id;
  return catalog instanceof Map ? (catalog.has(resolved) ? resolved : '') : resolved;
}

export function workspaceControlBelongsToBrush({
  brushes = [],
  section = '',
  explicitBrushOwnership = false,
} = {}, brush) {
  if (!brush) return false;
  return brushes.includes(brush)
    || (!explicitBrushOwnership && WORKSPACE_SHARED_SECTIONS.includes(section))
    || (WORKSPACE_BRUSH_SECTIONS[brush] || []).includes(section);
}

export function buildSettingsCatalog(root) {
  const catalog = new Map();
  if (!root?.querySelectorAll) return catalog;
  root.querySelectorAll('input[id], select[id], textarea[id]').forEach(control => {
    if (control.type === 'file' || control.type === 'hidden') return;
    const sectionBody = control.closest('.section-body');
    if (!sectionBody && !control.closest('#simControlStore')) return;
    const owner = control.closest('[data-brushes]');
    const brushes = (owner?.dataset?.brushes || '').split(/\s+/).filter(Boolean);
    const section = sectionBody?.previousElementSibling?.dataset?.section || '';
    const labelNode = control.closest('label');
    const label = (labelNode?.childNodes?.[0]?.textContent || control.getAttribute('aria-label') || control.id).trim();
    const description = labelNode?.nextElementSibling?.classList?.contains('slider-desc')
      ? labelNode.nextElementSibling.textContent.trim()
      : '';
    catalog.set(control.id, createCatalogEntry({
      id: control.id,
      label,
      section,
      brushes,
      explicitBrushOwnership: !!owner && owner !== sectionBody,
      description,
      type: control.type || control.tagName.toLowerCase(),
    }));
  });
  return catalog;
}
