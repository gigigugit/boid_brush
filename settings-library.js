import {
  SETTINGS_BRUSHES,
  catalogEntryApplies,
  normalizeBrushToken,
  readControlValue,
  resolveCatalogId,
  writeControlValue,
} from './settings-catalog.js';

export const PRESET_FORMAT = 'boid-brush-preset';
export const PRESET_VERSION = 1;
export const PRESET_LIBRARY_FORMAT = 'boid-brush-preset-library';
export const PRESET_LIBRARY_VERSION = 1;
export const PRESET_LIBRARY_KEY = 'bb_preset_library_v2';
export const LEGACY_PRESETS_KEY = 'bb_presets_v1';
export const FAVORITES_FORMAT = 'boid-brush-favorites';
export const FAVORITES_VERSION = 1;
export const FAVORITES_KEY = 'bb_favorites_v1';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function createStableId(prefix = 'preset') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createLegacyPresetId(name, brush, values) {
  const source = `${name}\n${brush}\n${JSON.stringify(values)}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const slug = String(name || 'preset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'preset';
  return `legacy-${slug}-${(hash >>> 0).toString(36)}`;
}

export function createPreset({
  name,
  kind = 'brush',
  brush,
  values,
  id,
  createdAt,
  updatedAt,
  legacyAuthoredContent,
} = {}) {
  const now = new Date().toISOString();
  const preset = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    id: id || createStableId(kind),
    name: String(name || 'Untitled').trim().slice(0, 120) || 'Untitled',
    scope: { kind, brush: normalizeBrushToken(brush) },
    values: clone(values || (kind === 'simulation' ? { parameters: {}, authoredContent: {} } : {})),
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  };
  if (object(legacyAuthoredContent)) preset.legacyAuthoredContent = clone(legacyAuthoredContent);
  return preset;
}

/**
 * @param {object} options
 * @param {boolean} [options.strict]
 * @param {(id: string, value: string|number|boolean, scope: object) => any} [options.normalizeValue]
 *   Optional per-control sanitizer applied after the scalar check. Controls
 *   that carry structured state as a JSON string (the pressure curves, the boid
 *   modulation matrix) use this to re-validate their payload on every import,
 *   export, and apply without this module needing to know the domain. Returning
 *   `undefined` drops the value.
 */
export function filterPresetParameters(values, scope, catalog, { strict = false, normalizeValue } = {}) {
  if (!object(values)) {
    if (strict) throw new Error('Preset values must be an object');
    return { values: {}, dropped: [] };
  }
  const filtered = {};
  const dropped = [];
  for (const [candidateId, value] of Object.entries(values)) {
    if (candidateId.startsWith('_')) { dropped.push(candidateId); continue; }
    const id = resolveCatalogId(candidateId, catalog);
    const entry = id && catalog.get(id);
    if (!entry || !catalogEntryApplies(entry, scope.brush, scope.kind)) {
      dropped.push(candidateId);
      continue;
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      dropped.push(candidateId);
      continue;
    }
    const normalized = normalizeValue ? normalizeValue(id, value, scope) : value;
    if (normalized === undefined) {
      dropped.push(candidateId);
      continue;
    }
    filtered[id] = normalized;
  }
  return { values: filtered, dropped };
}

export function normalizePreset(candidate, { catalog, fallbackName = 'Imported', fallbackBrush = 'boid', normalizeValue } = {}) {
  if (!object(candidate)) throw new Error('Invalid preset');
  if (candidate.format && candidate.format !== PRESET_FORMAT) throw new Error('Unsupported preset format');
  if (candidate.format === PRESET_FORMAT && candidate.version !== PRESET_VERSION) {
    throw new Error(`Unsupported preset version: ${candidate.version}`);
  }
  const legacyValues = candidate.format === PRESET_FORMAT ? null : candidate;
  const inferredBrush = legacyValues?._activeBrush || fallbackBrush;
  const scope = candidate.format === PRESET_FORMAT
    ? candidate.scope
    : { kind: 'brush', brush: inferredBrush };
  if (!object(scope) || !['brush', 'simulation'].includes(scope.kind) || !SETTINGS_BRUSHES.includes(scope.brush)) {
    throw new Error('Invalid preset scope');
  }
  const rawValues = legacyValues || candidate.values;
  if (!object(rawValues)) throw new Error('Preset values must be an object');
  let values;
  let dropped = [];
  if (scope.kind === 'simulation') {
    if (!object(rawValues)) throw new Error('Invalid simulation preset values');
    const filtered = filterPresetParameters(rawValues.parameters || {}, scope, catalog, { normalizeValue });
    values = {
      parameters: filtered.values,
      authoredContent: object(rawValues.authoredContent) ? {
        ...(object(rawValues.authoredContent.brushData) ? { brushData: clone(rawValues.authoredContent.brushData) } : {}),
        ...(object(rawValues.authoredContent.vars) ? { vars: clone(rawValues.authoredContent.vars) } : {}),
        ...(Array.isArray(rawValues.authoredContent.sensingSourceSelection)
          ? { sensingSourceSelection: clone(rawValues.authoredContent.sensingSourceSelection) }
          : {}),
      } : {},
    };
    dropped = filtered.dropped;
  } else {
    const filtered = filterPresetParameters(rawValues, scope, catalog, { normalizeValue });
    values = filtered.values;
    dropped = filtered.dropped;
  }
  const legacyAuthoredContent = object(candidate.legacyAuthoredContent)
    ? clone(candidate.legacyAuthoredContent)
    : {};
  if (legacyValues && scope.brush === 'motionPath' && object(legacyValues._motionPath)) {
    legacyAuthoredContent.motionPath = clone(legacyValues._motionPath);
    dropped = dropped.filter(id => id !== '_motionPath');
  }
  if (legacyValues) {
    const colors = {};
    if (typeof legacyValues._primaryColor === 'string') colors.primary = legacyValues._primaryColor;
    if (typeof legacyValues._secondaryColor === 'string') colors.secondary = legacyValues._secondaryColor;
    if (Object.keys(colors).length) {
      legacyAuthoredContent.colors = colors;
      dropped = dropped.filter(id => !['_primaryColor', '_secondaryColor'].includes(id));
    }
  }
  return {
    preset: createPreset({
      ...candidate,
      id: candidate.id || (legacyValues
        ? createLegacyPresetId(candidate.name || fallbackName, scope.brush, legacyValues)
        : undefined),
      name: candidate.name || fallbackName,
      kind: scope.kind,
      brush: scope.brush,
      values,
      legacyAuthoredContent: Object.keys(legacyAuthoredContent).length ? legacyAuthoredContent : undefined,
    }),
    dropped,
  };
}

export function capturePresetValues(root, catalog, scope, { normalizeValue } = {}) {
  const values = {};
  for (const entry of catalog.values()) {
    if (!catalogEntryApplies(entry, scope.brush, scope.kind)) continue;
    const raw = readControlValue(root.getElementById?.(entry.id) || root.querySelector?.(`#${CSS.escape(entry.id)}`));
    if (raw === undefined) continue;
    const value = normalizeValue ? normalizeValue(entry.id, raw, scope) : raw;
    if (value !== undefined) values[entry.id] = value;
  }
  return values;
}

export function applyPresetValues(root, catalog, preset, { normalizeValue } = {}) {
  const source = preset.scope.kind === 'simulation' ? preset.values.parameters : preset.values;
  const filtered = filterPresetParameters(source, preset.scope, catalog, { normalizeValue });
  let applied = 0;
  for (const [id, value] of Object.entries(filtered.values)) {
    const control = root.getElementById?.(id) || root.querySelector?.(`#${CSS.escape(id)}`);
    if (writeControlValue(control, value)) applied += 1;
  }
  return { applied, dropped: filtered.dropped };
}

export function emptyLibrary(entries = []) {
  return {
    format: PRESET_LIBRARY_FORMAT,
    version: PRESET_LIBRARY_VERSION,
    entries: clone(entries),
  };
}

export function normalizeLibrary(candidate, options = {}) {
  let candidates;
  if (candidate?.format === PRESET_LIBRARY_FORMAT) {
    if (candidate.version !== PRESET_LIBRARY_VERSION || !Array.isArray(candidate.entries)) {
      throw new Error('Unsupported or malformed preset library');
    }
    candidates = candidate.entries.map(entry => ({ entry, name: entry?.name }));
  } else if (candidate?.format === PRESET_FORMAT) {
    candidates = [{ entry: candidate, name: candidate.name }];
  } else if (object(candidate)) {
    if (!Object.keys(candidate).length) return { library: emptyLibrary(), warnings: [] };
    const looksLikeSingle = Object.prototype.hasOwnProperty.call(candidate, '_activeBrush')
      || Object.prototype.hasOwnProperty.call(candidate, '_motionPath')
      || Object.values(candidate).every(value => !object(value));
    candidates = looksLikeSingle
      ? [{ entry: candidate, name: options.fallbackName || 'Imported' }]
      : Object.entries(candidate).map(([name, entry]) => ({ entry, name }));
  } else {
    throw new Error('Invalid preset import');
  }
  const entries = [];
  const warnings = [];
  for (const item of candidates) {
    try {
      const normalized = normalizePreset(item.entry, { ...options, fallbackName: item.name || 'Imported' });
      entries.push(normalized.preset);
      if (normalized.dropped.length) warnings.push({ name: normalized.preset.name, dropped: normalized.dropped });
    } catch (error) {
      if (!options.skipInvalidEntries) throw error;
      warnings.push({
        name: item.name || 'Imported',
        dropped: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { library: emptyLibrary(entries), warnings };
}

export function mergeImportedEntries(existing, imported) {
  const entries = clone(existing?.entries || []);
  const names = new Set(entries.map(entry => entry.name));
  const ids = new Set(entries.map(entry => entry.id));
  for (const source of imported?.entries || []) {
    const entry = clone(source);
    if (names.has(entry.name)) {
      const base = `${entry.name} (Imported)`;
      entry.name = base;
      let n = 2;
      while (names.has(entry.name)) entry.name = `${source.name} (Imported ${n++})`;
    }
    if (ids.has(entry.id)) {
      const base = `${entry.id}-imported`;
      entry.id = base;
      let n = 2;
      while (ids.has(entry.id)) entry.id = `${base}-${n++}`;
    }
    names.add(entry.name);
    ids.add(entry.id);
    entries.push(entry);
  }
  return emptyLibrary(entries);
}

export function normalizeFavorites(candidate) {
  if (!candidate) return { format: FAVORITES_FORMAT, version: FAVORITES_VERSION, items: [] };
  if (candidate.format !== FAVORITES_FORMAT || candidate.version !== FAVORITES_VERSION || !Array.isArray(candidate.items)) {
    throw new Error('Invalid favorites data');
  }
  const seen = new Set();
  return {
    format: FAVORITES_FORMAT,
    version: FAVORITES_VERSION,
    items: candidate.items.filter(item => {
      const key = `${item?.controlId || ''}:${item?.scope?.brush || item?.scope?.kind || ''}`;
      return object(item) && typeof item.controlId === 'string' && !seen.has(key) && seen.add(key);
    })
      .map(item => ({ controlId: item.controlId, scope: clone(item.scope || {}) })),
  };
}
