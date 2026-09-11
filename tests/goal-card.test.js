import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createExampleDeck, validateDeck, validateConfig, validateBundle, parseImport, serializeReviewedDeck, GoalCardStore, GOAL_KEY, CAPABILITIES, LIMITS, RANDOMNESS, clone, canonical } from '../goal-card-model.js';
import { GoalPreviewRunner } from '../goal-card-preview.js';

const storage = () => {
  const data = new Map([['bb_experimentation_v1', 'old feedback'], ['bb_session', 'old workspace']]);
  return { data, getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
};
const result = (patch = {}) => ({ status: 'cancelled', frames: 0, framesExact: true, capturedFrames: 0, simulationSeconds: 0, wallMilliseconds: 30, backend: 'unavailable', randomness: RANDOMNESS, message: '', png: null, ...patch });
const setup = () => {
  const disk = storage(), store = new GoalCardStore(disk), deck = store.import(createExampleDeck());
  return { disk, store, deck, card: deck.cards[0] };
};

test('example is complete, independently validated and capabilities use the same descriptors', () => {
  const deck = createExampleDeck();
  assert.deepEqual(validateDeck(deck), deck);
  assert.equal(deck.cards.length, 2);
  deck.cards.forEach(c => validateConfig(c.config));
  assert.deepEqual(Object.keys(deck.cards[0].config.params).sort(), Object.keys(CAPABILITIES.schema.properties.cards.items.properties.config.properties.params.properties).sort());
  assert.notEqual(deck.cards[0].config, deck.cards[1].config);
});

test('reject unsafe, unknown, incomplete, oversized and non-native imported configurations', async t => {
  const cases = [
    ['unknown root', d => { d.javascript = 'alert(1)'; }],
    ['unknown config', d => { d.cards[0].config.url = 'https://example.invalid/a'; }],
    ['unknown param', d => { d.cards[0].config.params.__unsafe = 1; }],
    ['missing params', d => { delete d.cards[0].config.params.flowScale; }],
    ['percent force', d => { d.cards[0].config.params.seek = 75; }],
    ['UI speed instead of native', d => { d.cards[0].config.params.maxSpeed = 22; }],
    ['invalid native damping', d => { d.cards[0].config.params.damping = .2; }],
    ['NaN', d => { d.cards[0].config.params.fov = NaN; }],
    ['Infinity', d => { d.cards[0].config.params.stampSize = Infinity; }],
    ['unsafe color', d => { d.cards[0].config.params.color = 'url(https://example.invalid)'; }],
    ['unsupported GPU', d => { d.cards[0].config.engine = 'webgpu'; }],
    ['unbounded run', d => { d.cards[0].budget.wallSeconds = 60; }],
    ['fractional frames', d => { d.cards[0].budget.frames = 1.5; }],
    ['oversized canvas', d => { d.cards[0].config.width = 4096; }],
    ['out of document', d => { d.cards[0].config.target.x = 500; }],
    ['angle degrees', d => { d.cards[0].config.spawns[0].angle = 90; }],
    ['unknown spawn', d => { d.cards[0].config.spawns[0].shape = 'script'; }],
    ['count cardinality', d => { const s = d.cards[0].config.spawns[0]; d.cards[0].config.spawns = [1, 2, 3].map(i => ({ ...s, id: 's' + i, count: 128 })); }],
    ['guide limits', d => { d.cards[0].config.guides[0].hardness = 11; }],
    ['guide influence', d => { d.cards[0].config.guides[0].influenceRadius = 10; }],
    ['duplicate questions', d => { d.cards[0].questions = [clone(d.sharedQuestions[0])]; }],
    ['duplicate cards', d => { d.cards[1].id = d.cards[0].id; }],
    ['missing criterion', d => { d.successCriteria = []; }],
    ['oversized text', d => { d.goal = 'x'.repeat(4001); }],
    ['self parent', d => { d.parentRevisionId = d.revisionId; d.changes = ['changed']; }],
    ['child missing changes', d => { d.parentRevisionId = 'prior'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const d = createExampleDeck(); mutate(d); assert.throws(() => validateDeck(d));
  });
  assert.throws(() => validateDeck(parseImport(JSON.stringify(createExampleDeck()).replace('"params":{', '"params":{"__proto__":{},'))), /unknown field/);
  assert.throws(() => parseImport('x'.repeat(16000001)), /too large/);
  assert.throws(() => parseImport('{broken'));
  assert.equal({}.polluted, undefined);
});

test('schema ranges include native boundaries and reject numbers just beyond them', () => {
  const params = CAPABILITIES.schema.properties.cards.items.properties.config.properties.params.properties;
  for (const [key, spec] of Object.entries(params)) {
    if (spec.type !== 'number') continue;
    for (const value of [spec.minimum, spec.maximum]) {
      const d = createExampleDeck(); d.cards[0].config.params[key] = value; validateDeck(d);
    }
    const d = createExampleDeck(); d.cards[0].config.params[key] = spec.maximum + 1; assert.throws(() => validateDeck(d), key);
  }
});

test('revision identity is immutable, key order is irrelevant, and lineage is retained', () => {
  const { store, deck } = setup();
  const reordered = Object.fromEntries(Object.entries(deck).reverse());
  store.import(reordered);
  assert.equal(store.revisions.length, 1);
  const conflict = clone(deck); conflict.sharedQuestions[0].text = 'Different question';
  const before = canonical(store.bundle());
  assert.throws(() => store.import(conflict), /identity collision/);
  assert.equal(canonical(store.bundle()), before);
  const child = clone(deck); child.revisionId = 'r2'; child.parentRevisionId = 'r1'; child.changes = ['Alter question']; child.sharedQuestions[0].text = 'Changed';
  store.import(child);
  assert.equal(store.revisions.length, 2);
  assert.equal(store.isHistorical(deck), true);
  const missing = clone(child); missing.revisionId = 'r3'; missing.parentRevisionId = 'missing';
  assert.throws(() => store.import(missing), /parent/);
});

test('reruns retain precise config/questions, scalar distinctions, notes, and sealed history', () => {
  const { store, deck, card, disk } = setup();
  const first = store.addRun(deck, card, result());
  assert.ok(first.answers.every(a => a.value === null));
  const answers = clone(first.answers); answers[0].value = 0; answers[0].note = '<script>not executed</script>'; answers[1].value = 'na';
  store.edit(first.id, { answers, notes: 'overall observation' });
  const second = store.addRun(deck, card, result({ wallMilliseconds: 50 }));
  assert.notEqual(second.id, first.id);
  assert.equal(store.reviews[0].sealed, true);
  assert.equal(store.reviews[0].answers[0].value, 0);
  assert.equal(store.reviews[0].answers[1].value, 'na');
  assert.throws(() => store.edit(first.id, { notes: 'overwrite' }), /read-only/);
  assert.throws(() => store.edit(second.id, { result: result() }), /only feedback/);
  const exported = validateBundle(store.bundle());
  assert.deepEqual(exported.revisions[0].cards[0].config, card.config);
  assert.equal(exported.revisions[0].sharedQuestions[0].text, deck.sharedQuestions[0].text);
  assert.deepEqual(new GoalCardStore(disk).bundle(), store.bundle());
  assert.equal(disk.data.get('bb_experimentation_v1'), 'old feedback');
  assert.equal(disk.data.get('bb_session'), 'old workspace');
});

test('imported evidence is read-only; collisions cannot overwrite notes/results', () => {
  const { store, deck, card } = setup();
  store.addRun(deck, card, result());
  const next = new GoalCardStore(storage()); next.import(store.bundle());
  assert.equal(next.reviews[0].sealed, true);
  assert.throws(() => next.edit(next.reviews[0].id, { notes: 'changed' }), /read-only/);
  const altered = store.bundle(); altered.reviews[0].notes = 'changed';
  assert.throws(() => next.import(altered), /collision/);
  assert.equal(next.reviews[0].notes, '');
  next.import(store.bundle()); assert.equal(next.reviews.length, 1);
});

test('historical revisions cannot acquire new evidence or edits', () => {
  const { store, deck, card } = setup();
  const r = store.addRun(deck, card, result());
  const child = clone(deck); child.revisionId = 'r2'; child.parentRevisionId = 'r1'; child.changes = ['New contrast'];
  store.import(child);
  assert.throws(() => store.addRun(deck, card, result()), /read-only/);
  assert.throws(() => store.edit(r.id, { notes: 'changed' }), /read-only/);
});

test('invalid reviewed imports reject fake completion, remote images, foreign answers and cyclic lineage', () => {
  const { store, deck, card } = setup(); store.addRun(deck, card, result());
  for (const mutate of [
    b => { b.reviews[0].result.status = 'completed'; },
    b => { b.reviews[0].result.png = 'https://example.invalid/test.png'; },
    b => { b.reviews[0].result.png = 'data:image/svg+xml;base64,AAAA'; },
    b => { b.reviews[0].result.frames = 200; },
    b => { b.reviews[0].result.backend = 'webgpu'; },
    b => { b.reviews[0].answers[0].questionId = 'foreign'; },
    b => { b.reviews[0].answers[0].value = false; },
    b => { b.reviews[0].result.frames = 1; },
    b => { b.reviews[0].cardId = 'foreign'; },
    b => { const d = clone(b.revisions[0]); d.revisionId = 'r2'; d.parentRevisionId = 'r1'; d.changes = ['cycle']; b.revisions[0].parentRevisionId = 'r2'; b.revisions[0].changes = ['cycle']; b.revisions.push(d); },
  ]) {
    const b = store.bundle(); mutate(b); assert.throws(() => validateBundle(b));
  }
  const b = store.bundle();
  const bytes = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(900000, 16); bytes.writeUInt32BE(900000, 20);
  b.reviews[0].result.png = 'data:image/png;base64,' + bytes.toString('base64');
  assert.throws(() => validateBundle(b), /dimensions/);
});

test('quota failures retain exportable edits; damaged storage is never overwritten', () => {
  const disk = storage(); disk.setItem = () => { throw new Error('quota'); };
  const store = new GoalCardStore(disk);
  store.import(createExampleDeck());
  assert.match(store.warning, /storage full/);
  assert.equal(store.bundle().revisions.length, 1);
  const broken = storage(); broken.data.set(GOAL_KEY, '{bad');
  const restored = new GoalCardStore(broken); restored.import(createExampleDeck());
  assert.match(restored.warning, /damaged/);
  assert.equal(broken.data.get(GOAL_KEY), '{bad');
  assert.equal(restored.bundle().revisions.length, 1);
});

// Real limits: 65 reviews with 20 maximum-length CJK answers, no image payload.
// Leave the newest run's overall notes empty for boundary edit tests.
function byteBudgetBundle(targetBytes = LIMITS.importBytes) {
  const disk = storage(), store = new GoalCardStore(disk), example = createExampleDeck();
  example.sharedQuestions = Array.from({ length: 12 }, (_, i) => ({ id: `shared-${i}`, text: 'Question?' }));
  example.cards[0].questions = Array.from({ length: 8 }, (_, i) => ({ id: `card-${i}`, text: 'Question?' }));
  const deck = store.import(example), review = store.addRun(deck, deck.cards[0], result());
  const bundle = store.bundle();
  bundle.reviews = Array.from({ length: 65 }, (_, i) => ({
    ...clone(review), id: `review-${i}`, sealed: i !== 64,
    answers: review.answers.map(a => ({ ...a, note: '界'.repeat(4000) })),
  }));
  // Also exercise astral Unicode and JSON escaping in the serialized budget.
  bundle.reviews[0].notes = '😀\n"\\\u0000';
  let remaining = targetBytes - Buffer.byteLength(serializeReviewedDeck(bundle), 'utf8');
  assert.ok(remaining >= 0);
  for (const row of bundle.reviews.slice(1, -1)) {
    const bytes = Math.min(remaining, 36000);
    row.notes = '界'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3);
    remaining -= bytes;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(serializeReviewedDeck(bundle), 'utf8'), targetBytes);
  return bundle;
}

test('UTF-8 budget includes pretty JSON; exact-limit backups and compact storage round-trip', () => {
  const bundle = byteBudgetBundle(), pretty = serializeReviewedDeck(bundle);
  assert.equal(pretty, JSON.stringify(bundle, null, 2));
  assert.ok(pretty.length < LIMITS.importBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < LIMITS.importBytes);
  assert.deepEqual(validateBundle(parseImport(pretty)), bundle);
  const disk = storage(); disk.setItem(GOAL_KEY, JSON.stringify(bundle));
  const recovered = new GoalCardStore(disk);
  assert.equal(recovered.blocked, false);
  assert.deepEqual(recovered.bundle(), bundle);
  const imported = new GoalCardStore(storage());
  imported.import(parseImport(serializeReviewedDeck(recovered.bundle())));
  const sealed = clone(bundle); sealed.reviews.forEach(r => { r.sealed = true; });
  assert.deepEqual(imported.bundle(), sealed);
  assert.deepEqual(validateBundle(parseImport(serializeReviewedDeck(imported.bundle()))), sealed);
  assert.throws(() => parseImport(pretty + ' '), /too large/);
});

test('oversized multibyte edits, reruns and merged imports reject atomically without truncation', () => {
  const bundle = byteBudgetBundle(LIMITS.importBytes - 3);
  const disk = storage(); disk.setItem(GOAL_KEY, JSON.stringify(bundle));
  const store = new GoalCardStore(disk), deck = store.revisions[0], last = store.reviews.at(-1);
  // A three-byte character fits exactly; its next byte must be rejected.
  store.edit(last.id, { notes: '界' });
  const before = serializeReviewedDeck(store.bundle()), raw = disk.getItem(GOAL_KEY);
  const revisions = store.revisions, reviews = store.reviews;
  const reject = action => {
    assert.throws(action, /change rejected: total UTF-8 backup exceeds 16 MB.*Existing evidence is unchanged.*no notes were truncated/);
    assert.equal(serializeReviewedDeck(store.bundle()), before);
    assert.equal(disk.getItem(GOAL_KEY), raw);
    assert.equal(store.storedRaw, raw);
    assert.equal(store.revisions, revisions);
    assert.equal(store.reviews, reviews);
    assert.equal(store.reviews.at(-1).sealed, false);
  };
  reject(() => store.edit(last.id, { notes: '界x' }));
  const answers = clone(last.answers); answers[0].note = '\u0000' + answers[0].note.slice(1);
  reject(() => store.edit(last.id, { answers }));
  reject(() => store.addRun(deck, deck.cards[0], result()));
  const child = clone(deck);
  child.revisionId = 'r2'; child.parentRevisionId = deck.revisionId; child.changes = ['New revision'];
  reject(() => store.import(child));
  const incoming = clone(bundle); incoming.reviews = [{ ...clone(last), id: 'incoming', sealed: true }];
  validateBundle(incoming); // Fits on its own, but not when merged.
  reject(() => store.import(parseImport(serializeReviewedDeck(incoming))));
  // A rejected attempt does not prevent a later valid edit from being persisted.
  store.edit(last.id, { notes: '' });
  assert.equal(store.reviews.at(-1).notes, '');
  assert.deepEqual(new GoalCardStore(disk).bundle(), store.bundle());
});

test('compact imports and recovered storage cannot bypass the pretty export byte budget', () => {
  const oversized = byteBudgetBundle(LIMITS.importBytes + 1);
  const compact = JSON.stringify(oversized);
  assert.ok(Buffer.byteLength(compact) < LIMITS.importBytes);
  const parsed = parseImport(compact);
  assert.throws(() => validateBundle(parsed), /total UTF-8 backup/);
  const { store, disk } = setup();
  const before = serializeReviewedDeck(store.bundle()), raw = disk.getItem(GOAL_KEY);
  assert.throws(() => store.import(parsed), /total UTF-8 backup/);
  assert.equal(serializeReviewedDeck(store.bundle()), before);
  assert.equal(disk.getItem(GOAL_KEY), raw);
  const legacy = storage(); legacy.setItem(GOAL_KEY, compact);
  const recovered = new GoalCardStore(legacy);
  assert.equal(recovered.blocked, true);
  assert.match(recovered.warning, /existing data left untouched/);
  recovered.import(createExampleDeck());
  assert.equal(legacy.getItem(GOAL_KEY), compact);
  assert.equal(recovered.storedRaw, compact);
});

test('stale tabs never overwrite newer persisted evidence', () => {
  const disk = storage();
  const first = new GoalCardStore(disk), stale = new GoalCardStore(disk);
  const deck = first.import(createExampleDeck());
  first.addRun(deck, deck.cards[0], result());
  const original = disk.getItem(GOAL_KEY);
  stale.import(createExampleDeck());
  assert.equal(stale.blocked, true);
  assert.match(stale.warning, /another tab/);
  assert.equal(disk.getItem(GOAL_KEY), original);
  assert.equal(stale.bundle().revisions.length, 1);
});

function fakeRunner() {
  let clock = 0, id = 0;
  const timers = new Map();
  const worker = { messages: [], terminated: false, postMessage(m) { this.messages.push(m); }, terminate() { this.terminated = true; } };
  const runner = new GoalPreviewRunner({ workerFactory: () => worker, now: () => clock,
    setTimer: (f, ms) => { timers.set(++id, { f, ms }); return id; }, clearTimer: id => timers.delete(id) });
  const fire = ms => { clock += ms; const entry = [...timers].find(([, t]) => t.ms === ms); assert.ok(entry); timers.delete(entry[0]); entry[1].f(); };
  return { runner, worker, fire, timers };
}

test('preview supervisor bounds startup stalls, cancels, reports partial frames without claiming success', async () => {
  const { runner, worker, fire, timers } = fakeRunner();
  const promise = runner.run(createExampleDeck().cards[0]);
  assert.throws(() => runner.run(createExampleDeck().cards[0]), /already/);
  fire(3000);
  assert.equal(worker.messages.at(-1).status, 'timeout');
  fire(250);
  const r = await promise;
  assert.equal(r.status, 'timeout'); assert.equal(r.framesExact, false);
  assert.equal(r.backend, 'unavailable'); assert.equal(r.wallMilliseconds, 3250);
  assert.equal(worker.terminated, true); assert.equal(timers.size, 0);
  assert.equal(runner.running, false);
});

test('cooperative cancel and completion preserve exact actual frame metadata and clean workers', async () => {
  for (const status of ['cancelled', 'completed']) {
    const { runner, worker, timers } = fakeRunner();
    const card = createExampleDeck().cards[0];
    const promise = runner.run(card);
    const frames = status === 'completed' ? card.budget.frames : 12;
    if (status === 'cancelled') runner.cancel();
    worker.onmessage({ data: { type: 'done', status, frames, capturedFrames: frames, png: null, backend: 'wasm / canvas2d', message: '' } });
    const r = await promise;
    assert.equal(r.status, status); assert.equal(r.frames, frames); assert.equal(r.framesExact, true);
    assert.equal(r.simulationSeconds, frames / 60); assert.equal(r.capturedFrames, frames);
    assert.equal(worker.terminated, true); assert.equal(timers.size, 0);
  }
});

test('worker creation failure is unavailable/error, not silent GPU success', async () => {
  const runner = new GoalPreviewRunner({ workerFactory() { throw new Error('Worker unavailable'); } });
  const r = await runner.run(createExampleDeck().cards[0]);
  assert.equal(r.status, 'error'); assert.equal(r.backend, 'unavailable'); assert.equal(r.frames, 0); assert.equal(r.png, null);
});

test('error inside a frame preserves uncertainty about partially executed steps', async () => {
  const { runner, worker } = fakeRunner();
  const pending = runner.run(createExampleDeck().cards[0]);
  worker.onmessage({ data: { type: 'done', status: 'error', frames: 4, capturedFrames: 0, png: null, backend: 'wasm / canvas2d', framesExact: false, message: 'Render failed' } });
  const r = await pending;
  assert.equal(r.framesExact, false);
  assert.equal(r.frames, 4);
  assert.equal(r.status, 'error');
});
test('isolated worker invokes existing engine and brush; portable agent is packaged and accessible', async () => {
  const worker = await readFile(new URL('../goal-card-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /BoidSim\.create/); assert.match(worker, /new BoidBrush/); assert.match(worker, /brush\.onFrame/);
  assert.doesNotMatch(worker, /window\.|localStorage|sessionStorage|pushUndo|saveSession|fetch\(/);
  const agent = await readFile(new URL('../simulation-card-designer.agent.md', import.meta.url), 'utf8');
  assert.match(agent, /Initial mode/); assert.match(agent, /Iteration mode/); assert.match(agent, /parentRevisionId/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('simulation-card-designer.agent.md'));
});
