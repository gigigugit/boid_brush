// Versioned data only. These descriptors drive both validation and the downloadable schema.
export const GOAL_KEY = 'bb_goal_cards_v1';
export const RANDOMNESS = 'Engine-internal seed 42; no user seed control; cross-build reproducibility not guaranteed';
export const LIMITS = Object.freeze({ importBytes: 16000000, imageChars: 1500000, totalImageChars: 8000000, revisions: 20, reviews: 100 });
const number = (minimum, maximum, description, integer = false) => ({ type: integer ? 'integer' : 'number', minimum, maximum, description });
const string = (maxLength = 2000, minLength = 1) => ({ type: 'string', minLength, maxLength });
const enumeration = (...values) => ({ enum: values });
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const id = { ...string(80), pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', maxLength: 7 };
const unit = description => number(0, 1, description);
const question = object({ id, text: string(500) });
export const SCALE = Object.freeze({ min: -100, max: 100, neutral: 0, unanswered: null, notApplicable: 'na', meaning: 'Agreement with the statement; not an objective score.' });
export const PARAM_SCHEMA = object({
  seek: unit('Native force weight'), cohesion: unit('Native force weight'),
  separation: unit('Native force weight'), alignment: unit('Native force weight'),
  jitter: unit('Native force weight'), wander: unit('Native force weight'),
  wanderSpeed: number(.01, 1, 'Native angular wander step'),
  maxSpeed: number(.5, 15, 'Native speed, pixels per fixed 1/60 s step'),
  damping: number(.8, 1, 'Velocity multiplier per step'),
  fov: number(30, 360, 'Degrees'), flowField: unit('Native force weight'),
  flowScale: number(.001, .1, 'Inverse pixels'),
  fleeRadius: number(0, 150, 'Pixels'), individuality: unit('Native individuality'),
  neighborRadius: number(1, 240, 'Pixels'), separationRadius: number(1, 240, 'Pixels'),
  simBoundsMargin: number(0, 240, 'Pixels outside preview; native simulation bounds'),
  sizeVar: unit('Native random size variation'), opacityVar: unit('Native random opacity variation'),
  speedVar: unit('Native random speed variation'), forceVar: unit('Native random force variation'),
  hueVar: unit('Native random hue variation'), satVar: unit('Native random saturation variation'),
  litVar: unit('Native random lightness variation'),
  stampSize: number(1, 40, 'Circle diameter, pixels'),
  stampOpacity: number(.01, 1, 'Alpha'), stampSeparation: number(0, 80, 'Pixels; 0 uses native automatic spacing'),
  color,
});
export const CONFIG_SCHEMA = object({
  engine: enumeration('boid-wasm-canvas-v1'),
  width: number(128, 512, 'Pixels, DPR 1', true), height: number(128, 512, 'Pixels, DPR 1', true),
  background: color,
  params: PARAM_SCHEMA,
  target: object({ x: number(0, 512, 'Pixels'), y: number(0, 512, 'Pixels') }),
  spawns: array(object({
    id, x: number(0, 512, 'Pixels'), y: number(0, 512, 'Pixels'),
    count: number(1, 128, 'Agents; total <=256', true),
    shape: enumeration('circle', 'ring', 'gaussian', 'line', 'ellipse', 'diamond', 'grid', 'sunburst', 'spiral', 'poisson', 'random_cluster', 'burst', 'lemniscate', 'phyllotaxis', 'noise_scatter', 'bullseye', 'cross', 'wave', 'voronoi'),
    radius: number(1, 200, 'Pixels'), angle: number(0, Math.PI * 2, 'Radians'), jitter: unit('Position noise'),
  }), 4, 1),
  guides: array(object({
    id, type: enumeration('attract', 'repel'),
    x: number(0, 512, 'Pixels'), y: number(0, 512, 'Pixels'),
    strength: number(0, 2, 'Native point force'), radius: number(10, 300, 'Pixels'),
    influenceRadius: number(10, 1024, 'Pixels; >= radius, attract only'),
    hardness: number(.1, 10, 'Native repel falloff exponent'),
  }), 8),
});
export const DECK_SCHEMA = object({
  format: enumeration('boid-brush-goal-deck'), version: enumeration(1),
  deckId: id, revisionId: id, parentRevisionId: { anyOf: [id, { type: 'null' }] },
  changes: array(string(1000), 20),
  title: string(160), goal: string(4000), successCriteria: array(string(1000), 12, 1),
  sharedQuestions: array(question, 12, 1),
  cards: array(object({
    id, title: string(160), hypothesis: string(2000),
    questions: array(question, 8),
    budget: object({ frames: number(1, 180, 'Fixed 1/60 s steps', true), wallSeconds: number(.5, 5, 'Includes startup; hard stop plus <=250 ms cancellation grace') }),
    config: CONFIG_SCHEMA,
  }), 12, 1),
});
export const CAPABILITIES = {
  schema: DECK_SCHEMA, scale: SCALE, limits: LIMITS,
  engine: 'Existing BoidSim + BoidBrush.onFrame + CanvasBoidStampRenderer in a fresh worker per run.',
  fixed: { stepSeconds: 1 / 60, simSpeed: 1, brushScale: 1, pressure: 1, stamp: 'hard circle', paint: 'persistent preview-only accumulation', spawnDistribution: 'native uniform', randomness: RANDOMNESS },
  unsupported: ['WebGPU', 'other brushes', 'animated paths', 'sensing', 'leaders', 'quorum', 'modulation', 'stamp images/rotation', 'textures', 'symmetry', 'smudge', 'taper', 'ephemeral fading', 'external assets'],
  rules: ['Every field is required; unknown fields rejected at every level.', 'Coordinates must fit width/height. Total spawn count <=256. IDs unique within each list; shared/card question IDs must not overlap.', 'Parent must differ from revision. Child revisions require changes. Import parent first; same identity with different content is rejected.', 'Reviews link immutable revision/card snapshots. Earlier runs and imported reviews are read-only. No automatic interpretation of agreement.'],
};
export const clone = value => JSON.parse(JSON.stringify(value));
// Download reviewed deck uses this exact formatting, not localStorage's compact JSON.
export const serializeReviewedDeck = bundle => JSON.stringify(bundle, null, 2);
export function canonical(value) {
  return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
function fail(path, message) { throw new Error(`${path}: ${message}`); }
export function validate(schema, value, path = 'deck') {
  if (schema.anyOf) {
    if (!schema.anyOf.some(s => { try { validate(s, value, path); return true; } catch { return false; } })) fail(path, 'invalid value');
    return;
  }
  if (schema.enum) { if (!schema.enum.includes(value)) fail(path, `expected ${schema.enum.join(' / ')}`); return; }
  if (schema.type === 'null') { if (value !== null) fail(path, 'expected null'); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected plain object');
    for (const k of Object.keys(value)) if (!Object.hasOwn(schema.properties, k)) fail(`${path}.${k}`, 'unknown field');
    for (const k of schema.required) validate(schema.properties[k], value[k], `${path}.${k}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) fail(path, `expected ${schema.minItems}–${schema.maxItems} items`);
    value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > schema.maxLength || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail(path, 'invalid or oversized text');
  } else if (!Number.isFinite(value) || value < schema.minimum || value > schema.maximum || (schema.type === 'integer' && !Number.isInteger(value))) fail(path, `expected ${schema.minimum}–${schema.maximum} ${schema.type}`);
}
function unique(rows, path) {
  if (new Set(rows.map(r => r.id)).size !== rows.length) fail(path, 'duplicate IDs');
}
export function validateConfig(config) {
  validate(CONFIG_SCHEMA, config, 'config');
  for (const p of [config.target, ...config.spawns, ...config.guides]) {
    if (p.x > config.width || p.y > config.height) fail('config', 'coordinates outside dimensions');
  }
  unique(config.spawns, 'spawns'); unique(config.guides, 'guides');
  if (config.spawns.reduce((sum, s) => sum + s.count, 0) > 256) fail('spawns', 'total count exceeds 256');
  for (const g of config.guides) if (g.influenceRadius < g.radius) fail('guides', 'influenceRadius must be >= radius');
  return config;
}
export function validateDeck(deck) {
  validate(DECK_SCHEMA, deck);
  if (deck.parentRevisionId === deck.revisionId) fail('revisionId', 'cannot be its own parent');
  if (deck.parentRevisionId && !deck.changes.length) fail('changes', 'describe parent changes');
  unique(deck.cards, 'cards'); unique(deck.sharedQuestions, 'sharedQuestions');
  for (const card of deck.cards) {
    unique([...deck.sharedQuestions, ...card.questions], 'questions');
    validateConfig(card.config);
  }
  return clone(deck);
}
export function parseImport(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > LIMITS.importBytes) fail('import', 'file too large');
  return JSON.parse(raw);
}
export function createExampleDeck() {
  const config = {
    engine: 'boid-wasm-canvas-v1', width: 384, height: 384, background: '#ffffff',
    params: { seek: 0, cohesion: .35, separation: .15, alignment: .22, jitter: 0, wander: .06, wanderSpeed: .3, maxSpeed: 4, damping: .95, fov: 115, flowField: 0, flowScale: .01, fleeRadius: 0, individuality: 0, neighborRadius: 80, separationRadius: 25, simBoundsMargin: 0, sizeVar: 0, opacityVar: 0, speedVar: 0, forceVar: 0, hueVar: 0, satVar: 0, litVar: 0, stampSize: 4, stampOpacity: .15, stampSeparation: 0, color: '#216c91' },
    target: { x: 192, y: 192 },
    spawns: [{ id: 'spawn-1', x: 140, y: 192, count: 48, shape: 'circle', radius: 45, angle: 0, jitter: 0 }],
    guides: [{ id: 'guide-1', type: 'attract', x: 270, y: 192, strength: .3, radius: 80, influenceRadius: 350, hardness: 1 }],
  };
  return validateDeck({
    format: 'boid-brush-goal-deck', version: 1, deckId: 'mark-study', revisionId: 'r1', parentRevisionId: null, changes: [],
    title: 'Compact marks / open marks', goal: 'Explore a blue cluster of marks with visible white gaps.',
    successCriteria: ['Blue marks remain visible against white.', 'White gaps remain visible within the cluster.'],
    sharedQuestions: [{ id: 'visible', text: 'Blue marks are visible against the background.' }, { id: 'gaps', text: 'White gaps are visible inside the cluster.' }],
    cards: [
      { id: 'baseline', title: 'Baseline', hypothesis: 'This starting configuration may retain gaps; it has not been observed.', questions: [], budget: { frames: 90, wallSeconds: 3 }, config },
      { id: 'spacing', title: 'More separation', hypothesis: 'Increasing separation alone may leave more white gaps.', questions: [], budget: { frames: 90, wallSeconds: 3 }, config: { ...clone(config), params: { ...config.params, separation: .45 } } },
    ],
  });
}

const answerSchema = object({ questionId: id, value: { anyOf: [number(-100, 100, 'Scalar agreement', true), enumeration(null, 'na')] }, note: string(4000, 0) });
const resultSchema = object({
  status: enumeration('completed', 'cancelled', 'timeout', 'error'),
  frames: number(0, 180, 'Confirmed completed simulation frames', true),
  framesExact: enumeration(true, false),
  capturedFrames: number(0, 180, 'Frames represented by PNG', true),
  simulationSeconds: number(0, 3, 'Confirmed frames / 60'),
  wallMilliseconds: number(0, Number.MAX_SAFE_INTEGER, 'Actual elapsed wall time; includes browser suspension'),
  backend: enumeration('wasm / canvas2d', 'unavailable'),
  randomness: enumeration(RANDOMNESS),
  message: string(2000, 0),
  png: { anyOf: [{ ...string(LIMITS.imageChars), pattern: '^data:image/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$' }, { type: 'null' }] },
});
const reviewSchema = object({
  id, deckId: id, revisionId: id, cardId: id, createdAt: string(50),
  sealed: enumeration(true, false), result: resultSchema,
  answers: array(answerSchema, 20), notes: string(12000, 0),
});
const bundleSchema = object({
  format: enumeration('boid-brush-reviewed-deck'), version: enumeration(1),
  scale: object({ min: enumeration(-100), max: enumeration(100), neutral: enumeration(0), unanswered: enumeration(null), notApplicable: enumeration('na'), meaning: enumeration(SCALE.meaning) }),
  revisions: array(DECK_SCHEMA, LIMITS.revisions), reviews: array(reviewSchema, LIMITS.reviews),
});
CAPABILITIES.reviewedSchema = bundleSchema;
const sameRevision = (a, b) => a.deckId === b.deckId && a.revisionId === b.revisionId;
export const questionsFor = (deck, card) => [...deck.sharedQuestions, ...card.questions];
export function validateBundle(bundle) {
  validate(bundleSchema, bundle, 'reviewed deck');
  bundle.revisions.forEach(validateDeck);
  const identities = bundle.revisions.map(d => `${d.deckId}/${d.revisionId}`);
  if (new Set(identities).size !== identities.length) fail('revisions', 'duplicate identity');
  unique(bundle.reviews, 'reviews');
  let imageSize = 0;
  for (const d of bundle.revisions) {
    if (d.parentRevisionId && !bundle.revisions.some(p => p.deckId === d.deckId && p.revisionId === d.parentRevisionId)) fail('parentRevisionId', 'import parent revision first');
    const seen = new Set([d.revisionId]);
    let parent = d.parentRevisionId;
    while (parent) {
      if (seen.has(parent)) fail('revisions', 'cyclic lineage');
      seen.add(parent);
      parent = bundle.revisions.find(p => p.deckId === d.deckId && p.revisionId === parent)?.parentRevisionId;
    }
  }
  for (const review of bundle.reviews) {
    const deck = bundle.revisions.find(d => sameRevision(d, review));
    const card = deck?.cards.find(c => c.id === review.cardId);
    if (!card) fail('review', 'missing immutable revision/card');
    const ids = questionsFor(deck, card).map(q => q.id);
    unique(review.answers.map(a => ({ id: a.questionId })), 'answers');
    if (review.answers.length !== ids.length || review.answers.some(a => !ids.includes(a.questionId))) fail('answers', 'questions do not match revision');
    const r = review.result;
    if (r.frames > card.budget.frames || r.capturedFrames > r.frames || r.simulationSeconds !== r.frames / 60 || (r.status === 'completed' && (r.frames !== card.budget.frames || !r.framesExact || !r.png || r.backend === 'unavailable'))) fail('result', 'inconsistent frame evidence');
    if (r.png) {
      // Bound decoded dimensions before an imported image ever reaches <img>.
      const header = atob(r.png.slice('data:image/png;base64,'.length, 'data:image/png;base64,'.length + 44));
      const bytes = Uint8Array.from(header, c => c.charCodeAt(0));
      if (bytes.length < 24 || header.slice(12, 16) !== 'IHDR') fail('png', 'invalid PNG header');
      const view = new DataView(bytes.buffer);
      if (view.getUint32(16) !== card.config.width || view.getUint32(20) !== card.config.height) fail('png', 'dimensions must match preview configuration');
    }
    imageSize += r.png?.length || 0;
  }
  if (imageSize > LIMITS.totalImageChars) fail('images', 'evidence limit reached; export and use a fresh browser profile');
  // Check the complete export envelope before any store mutation commits. Compact
  // localStorage uses the same envelope and is always no larger than this backup.
  if (new TextEncoder().encode(serializeReviewedDeck(bundle)).length > LIMITS.importBytes) {
    fail('reviewed deck', 'change rejected: total UTF-8 backup exceeds 16 MB. Existing evidence is unchanged; no notes were truncated. Download reviewed deck and use a fresh browser profile.');
  }
  return clone(bundle);
}

export class GoalCardStore {
  constructor(storage) {
    this.storage = storage; this.revisions = []; this.reviews = []; this.warning = ''; this.blocked = false;
    this.storedRaw = null;
    try {
      const raw = storage?.getItem(GOAL_KEY);
      this.storedRaw = raw ?? null;
      if (raw) Object.assign(this, validateBundle(parseImport(raw)));
      if (!storage) throw new Error('Storage unavailable');
    } catch {
      this.blocked = true;
      this.warning = 'Goal-card storage unavailable or damaged; existing data left untouched. Export before closing.';
    }
  }
  bundle() { return clone({ format: 'boid-brush-reviewed-deck', version: 1, scale: SCALE, revisions: this.revisions, reviews: this.reviews }); }
  persist() {
    if (this.blocked) return;
    try {
      // Never let a stale tab replace another tab's evidence. Export this tab
      // and reimport in a fresh view to resolve conflicts explicitly.
      if ((this.storage.getItem(GOAL_KEY) ?? null) !== this.storedRaw) {
        this.blocked = true;
        this.warning = 'Goal-card storage changed in another tab. Existing disk evidence was not overwritten. Download this tab’s reviewed deck before closing.';
        return;
      }
      const raw = JSON.stringify(this.bundle());
      this.storage.setItem(GOAL_KEY, raw); this.storedRaw = raw; this.warning = '';
    }
    catch { this.warning = 'Goal-card storage full or blocked. Evidence remains in this tab only; download reviewed deck before closing.'; }
  }
  import(value) {
    const incoming = value?.format === 'boid-brush-goal-deck'
      ? { revisions: [validateDeck(value)], reviews: [] } : validateBundle(value);
    const revisions = clone(this.revisions), reviews = clone(this.reviews);
    for (const d of incoming.revisions) {
      const prior = revisions.find(p => sameRevision(p, d));
      if (prior && canonical(prior) !== canonical(d)) fail('revisionId', 'identity collision; use a NEW revisionId and preserve parent lineage');
      if (!prior) revisions.push(d);
    }
    for (const r of incoming.reviews) {
      const prior = reviews.find(p => p.id === r.id);
      if (prior && canonical({ ...prior, sealed: true }) !== canonical({ ...r, sealed: true })) fail('review', 'identity collision; existing evidence preserved');
      if (!prior) reviews.push({ ...r, sealed: true });
    }
    validateBundle({ ...this.bundle(), revisions, reviews });
    this.revisions = revisions; this.reviews = reviews;
    this.persist();
    const imported = incoming.revisions.at(-1);
    return (imported && this.revisions.find(d => sameRevision(d, imported))) || this.revisions.at(-1) || null;
  }
  runs(deck, card) { return this.reviews.filter(r => sameRevision(r, deck) && r.cardId === card.id); }
  isHistorical(deck) { return this.revisions.some(d => d.deckId === deck.deckId && d.parentRevisionId === deck.revisionId); }
  addRun(deck, card, result) {
    if (this.isHistorical(deck)) fail('revision', 'historical revisions are read-only');
    const review = {
      id: crypto.randomUUID(), deckId: deck.deckId, revisionId: deck.revisionId, cardId: card.id,
      createdAt: new Date().toISOString(), sealed: false, result: clone(result),
      answers: questionsFor(deck, card).map(q => ({ questionId: q.id, value: null, note: '' })), notes: '',
    };
    const reviews = this.reviews.map(r => sameRevision(r, deck) && r.cardId === card.id ? { ...r, sealed: true } : r);
    reviews.push(review);
    validateBundle({ ...this.bundle(), reviews });
    this.reviews = reviews; this.persist(); return review;
  }
  edit(reviewId, patch) {
    const row = this.reviews.find(r => r.id === reviewId);
    const deck = this.revisions.find(d => sameRevision(d, row || {}));
    if (!row || row.sealed || this.isHistorical(deck)) fail('review', 'historical evidence is read-only');
    const next = clone(row);
    for (const k of Object.keys(patch)) if (!['answers', 'notes'].includes(k)) fail('review', 'only feedback is editable');
    Object.assign(next, patch);
    const reviews = this.reviews.map(r => r.id === next.id ? next : r);
    validateBundle({ ...this.bundle(), reviews });
    this.reviews = reviews; this.persist();
  }
}
