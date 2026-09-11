import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  createExampleDeck, validateDeck, validateBundle, parseImport, serializeReviewedDeck,
  GoalCardStore, PARAM_SCHEMA, LIMITS, RANDOMNESS, clone,
} from '../goal-card-model.js';

const directory = new URL('../goal-card-decks/serpentine/', import.meta.url);
const readJSON = async file => parseImport(await readFile(new URL(file, directory), 'utf8'));
const manifest = await readJSON('manifest.json');
const decks = await Promise.all(manifest.decks.map(entry => readJSON(entry.file)));
const byId = new Map(decks.map(deck => [deck.deckId, deck]));
const findCard = (deckId, cardId) => {
  const card = byId.get(deckId)?.cards.find(candidate => candidate.id === cardId);
  assert.ok(card, `Missing ${deckId}/${cardId}`);
  return card;
};
const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
};
const source = createExampleDeck().cards[0].config;
const anchor = clone(source);
anchor.guides = [];
const sorted = values => [...values].sort((a, b) => a - b);

// Compare execution inputs only, not IDs/titles/hypothesis descriptions.
function changedPaths(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return [path];
  if (Array.isArray(a) && (!Array.isArray(b) || a.length !== b.length)) return [path];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key =>
    changedPaths(a[key], b[key], path ? `${path}.${key}` : key));
}
const inputs = card => ({ config: card.config, budget: card.budget });

test('all six standalone static decks validate, import, and round-trip without executing cards', () => {
  const disk = storage();
  const store = new GoalCardStore(disk);
  store.import(createExampleDeck()); // New goal identities must coexist with the source study.
  assert.equal(decks.length, 6);
  for (const deck of decks) {
    assert.deepEqual(validateDeck(deck), deck);
    assert.equal(deck.cards.length, 12);
    assert.equal(deck.revisionId, 'r1');
    assert.equal(deck.parentRevisionId, null);
    assert.deepEqual(deck.changes, []);
    assert.notEqual(deck.deckId, 'mark-study');
    assert.deepEqual(store.import(deck), deck);
    store.import(deck); // An unchanged standalone import is idempotent.
  }
  assert.equal(store.revisions.length, 7);
  assert.equal(store.reviews.length, 0);
  assert.equal(store.warning, '');
  const serialized = serializeReviewedDeck(store.bundle());
  assert.ok(Buffer.byteLength(serialized) < LIMITS.importBytes);
  const restored = new GoalCardStore(disk);
  assert.deepEqual(restored.bundle(), store.bundle());
  const imported = new GoalCardStore(storage());
  imported.import(validateBundle(parseImport(serialized)));
  assert.deepEqual(imported.bundle(), store.bundle());
});

test('manifest accounts for every file, identity, card and manual import/run order', async () => {
  assert.equal(manifest.importable, false);
  assert.equal(manifest.deckCount, 6);
  assert.equal(manifest.cardCount, 72);
  assert.equal(new Set(decks.map(deck => deck.deckId)).size, 6);
  assert.deepEqual((await readdir(directory)).sort(), ['manifest.json', ...manifest.decks.map(entry => entry.file)].sort());
  manifest.decks.forEach((entry, index) => {
    assert.match(entry.file, /^\d\d-[a-z-]+\.json$/);
    assert.equal(entry.order, index + 1);
    assert.equal(entry.deckId, decks[index].deckId);
    assert.equal(entry.revisionId, decks[index].revisionId);
    assert.equal(entry.cardCount, decks[index].cards.length);
    assert.equal(entry.anchorCardId, 'anchor');
    assert.deepEqual(entry.runOrder, decks[index].cards.map(card => card.id));
  });
  assert.equal(manifest.retention.maxCardsPerDeck, 12);
  assert.equal(manifest.retention.maxRevisions, LIMITS.revisions);
  assert.equal(manifest.retention.maxReviews, LIMITS.reviews);
  assert.equal(manifest.retention.maxImportBytes, LIMITS.importBytes);
  assert.equal(manifest.retention.maxTotalImageChars, LIMITS.totalImageChars);
  assert.equal(manifest.retention.exportAfterEveryDeck, true);
  assert.throws(() => validateDeck(manifest), /unknown field|expected/);
});

test('complete native controls, rendering, spawn and image-only questions remain matched', () => {
  assert.deepEqual(manifest.sharedControls.config, anchor);
  assert.deepEqual(manifest.sharedControls.sourcePair.baselineConfig, source);
  assert.equal(manifest.sharedControls.randomness, RANDOMNESS);
  assert.equal(manifest.sharedControls.wallSeconds, 5);
  assert.equal(manifest.sharedControls.anchorFrames, 90);
  assert.equal(manifest.sharedControls.fixedStepSeconds, 1 / 60);
  assert.deepEqual(manifest.questions.map(q => q.id), ['ribbon', 'bends', 'continuity', 'compactness', 'gaps']);
  const expectedSpacing = clone(source);
  expectedSpacing.params.separation = .45;
  for (const deck of decks) {
    assert.deepEqual(deck.sharedQuestions, manifest.questions);
    assert.deepEqual(findCard(deck.deckId, 'anchor').config, anchor);
    assert.deepEqual(findCard(deck.deckId, 'anchor').budget, { frames: 90, wallSeconds: 5 });
    for (const card of deck.cards) {
      assert.match(card.hypothesis, /^Unobserved hypothesis:/);
      assert.deepEqual(card.questions, []);
      assert.equal(card.budget.wallSeconds, 5);
      if (deck !== decks[5]) assert.equal(card.budget.frames, 90);
      assert.deepEqual(Object.keys(card.config.params).sort(), Object.keys(PARAM_SCHEMA.properties).sort());
      for (const key of Object.keys(anchor).filter(key => !['params', 'guides'].includes(key))) {
        assert.deepEqual(card.config[key], anchor[key], `${deck.deckId}/${card.id}/${key}`);
      }
      for (const key of ['stampSize', 'stampOpacity', 'stampSeparation', 'color',
        'sizeVar', 'opacityVar', 'speedVar', 'forceVar', 'hueVar', 'satVar', 'litVar',
        'seek', 'fleeRadius', 'simBoundsMargin']) {
        assert.equal(card.config.params[key], anchor.params[key], `${card.id}/${key}`);
      }
      if (card.id === 'source-baseline') assert.deepEqual(card.config, source);
      if (card.id === 'source-spacing') assert.deepEqual(card.config, expectedSpacing);
      if (card.id === 'anchor-repeat') assert.deepEqual(inputs(card), inputs(findCard(deck.deckId, 'anchor')));
    }
  }
  assert.deepEqual(manifest.sharedControls.sourcePair.sourceBudget, { frames: 90, wallSeconds: 3 });
  assert.deepEqual(manifest.sharedControls.sourcePair.newBudget, { frames: 90, wallSeconds: 5 });
});

test('fourteen one-factor grids match complete configs with nonzero wander and flow scale controls', () => {
  const expected = {
    wander: [0, .02, .06, .12, .24],
    wanderSpeed: [.05, .15, .3, .6, 1],
    jitter: [0, .015, .05, .12, .25],
    flowField: [0, .08, .2, .45],
    flowScale: [.003, .01, .03, .07],
    cohesion: [.15, .35, .6, .85],
    alignment: [0, .22, .5, .8],
    separation: [0, .15, .3, .45],
    neighborRadius: [40, 80, 140],
    fov: [60, 115, 220, 360],
    maxSpeed: [2, 4, 6],
    damping: [.88, .95, .99],
    individuality: [0, .15, .4],
    separationRadius: [12, 25, 40],
  };
  assert.equal(manifest.oneFactorSweeps.length, 14);
  assert.deepEqual(manifest.oneFactorSweeps.map(sweep => sweep.parameter).sort(), Object.keys(expected).sort());
  for (const sweep of manifest.oneFactorSweeps) {
    const control = findCard(sweep.deckId, sweep.controlCardId);
    assert.deepEqual(sweep.valueGrid, expected[sweep.parameter]);
    assert.deepEqual(sorted(sweep.members.map(member => member.value)), expected[sweep.parameter]);
    for (const member of sweep.members) {
      const card = findCard(sweep.deckId, member.cardId);
      const expectedConfig = clone(control.config);
      expectedConfig.params[sweep.parameter] = member.value;
      assert.deepEqual(card.config, expectedConfig);
      assert.deepEqual(card.budget, control.budget);
      for (const [key, value] of Object.entries(sweep.fixedParams)) assert.equal(card.config.params[key], value);
      if (sweep.parameter === 'wanderSpeed') assert.equal(card.config.params.wander, .06);
      if (sweep.parameter === 'flowScale') assert.equal(card.config.params.flowField, .2);
    }
  }
});

test('all 68 declared pairings change only listed execution paths and cover every card', () => {
  assert.equal(manifest.pairings.length, 68);
  const covered = new Set();
  const identities = new Set();
  for (const pair of manifest.pairings) {
    const control = findCard(pair.deckId, pair.controlCardId);
    const variant = findCard(pair.deckId, pair.variantCardId);
    const identity = `${pair.deckId}/${pair.controlCardId}/${pair.variantCardId}`;
    assert.ok(!identities.has(identity), identity);
    identities.add(identity);
    assert.deepEqual(changedPaths(inputs(control), inputs(variant)).sort(), [...pair.changedPaths].sort(), identity);
    assert.equal(control.budget.wallSeconds, variant.budget.wallSeconds);
    if (pair.kind !== 'interval') assert.equal(control.budget.frames, variant.budget.frames);
    covered.add(`${pair.deckId}/${pair.controlCardId}`);
    covered.add(`${pair.deckId}/${pair.variantCardId}`);
  }
  for (const deck of decks) for (const card of deck.cards) assert.ok(covered.has(`${deck.deckId}/${card.id}`));
});

test('limited factorial has all eight cells and twelve one-factor edges; static guides are separate', () => {
  const factorial = manifest.factorial;
  assert.deepEqual(factorial.valueGrids, { wander: [.06, .18], cohesion: [.35, .7], alignment: [.22, .65] });
  assert.equal(factorial.cells.length, 8);
  const combinations = new Set();
  for (const cell of factorial.cells) {
    const expected = clone(anchor);
    Object.assign(expected.params, cell.values);
    assert.deepEqual(findCard(factorial.deckId, cell.cardId).config, expected);
    for (const key of Object.keys(factorial.valueGrids)) assert.ok(factorial.valueGrids[key].includes(cell.values[key]));
    combinations.add(JSON.stringify(cell.values));
  }
  assert.equal(combinations.size, 8);
  assert.equal(manifest.pairings.filter(pair => pair.kind === 'factorial-edge').length, 12);
  const guidance = manifest.staticGuidance;
  assert.deepEqual(guidance.valueGrid, [.1, .3, .6]);
  assert.deepEqual(guidance.members.map(member => member.value), [.1, .3, .6]);
  for (const member of guidance.members) {
    const card = findCard(guidance.deckId, member.cardId);
    const expected = clone(source);
    expected.guides[0].strength = member.value;
    assert.deepEqual(card.config, expected);
    assert.match(card.title, /STATIC.*NOT a leader/);
  }
});

test('three complete configurations match at 60/120/180 frames and their 90-frame references', () => {
  const intervals = manifest.intervals;
  assert.deepEqual(intervals.frameGrid, [60, 120, 180]);
  assert.deepEqual(intervals.simulationSecondGrid, [1, 2, 3]);
  assert.equal(intervals.wallSeconds, 5);
  assert.equal(intervals.groups.length, 3);
  assert.deepEqual(intervals.groups.map(group => group.id), ['guide-free', 'coordinated-wander', 'flow']);
  const ids = new Set();
  for (const group of intervals.groups) {
    const expected = clone(anchor);
    Object.assign(expected.params, group.fixedParams);
    const reference = findCard(group.reference90.deckId, group.reference90.cardId);
    assert.equal(group.reference90.revisionId, 'r1');
    assert.deepEqual(reference.config, expected);
    assert.deepEqual(reference.budget, { frames: 90, wallSeconds: 5 });
    assert.deepEqual(group.members.map(member => member.frames), intervals.frameGrid);
    for (const member of group.members) {
      const card = findCard(intervals.deckId, member.cardId);
      assert.ok(!ids.has(member.cardId));
      ids.add(member.cardId);
      assert.deepEqual(card.config, expected);
      assert.deepEqual(card.budget, { frames: member.frames, wallSeconds: 5 });
      assert.equal(member.simulationSeconds, member.frames / 60);
    }
  }
  assert.equal(ids.size, 9);
});

test('unsupported leaders remain a non-runnable plan; evidence is deduplicated and learning stays manual', async () => {
  assert.equal(manifest.deferredLeaderStudy.runnable, false);
  assert.equal(manifest.deferredLeaderStudy.status, 'blocked-unsupported-v1');
  assert.equal(manifest.deferredLeaderStudy.proposedControls.length, 6);
  for (const deck of decks) {
    for (const card of deck.cards) {
      const keys = [];
      const visit = object => {
        if (object && typeof object === 'object') {
          keys.push(...Object.keys(object));
          Object.values(object).forEach(visit);
        }
      };
      visit(card.config);
      assert.ok(!keys.some(key => /leader|seed|sensing|quorum/i.test(key)));
    }
  }
  const provenance = manifest.provenance;
  assert.equal(provenance.uniqueCompletedReviews, 2);
  assert.equal(provenance.pairedConfigurationComparisons, 1);
  assert.equal(provenance.independentReplications, 0);
  assert.equal(provenance.failedAttempts, 1);
  assert.equal(provenance.baseline.suppliedExportOccurrences, 2);
  assert.equal(provenance.baseline.countedReviews, 1);
  assert.equal(provenance.spacingCompleted.answers.gaps - provenance.baseline.answers.gaps, 11);
  assert.equal(provenance.spacingFailed.framesExact, false);
  assert.equal(provenance.spacingFailed.png, null);
  const agent = await readFile(new URL('../simulation-card-designer.agent.md', import.meta.url), 'utf8');
  for (const heading of ['Learned observations', 'Learned failures', 'Working hypotheses',
    'Open questions', 'Next experiments', 'Learning change log']) assert.ok(agent.includes(`### ${heading}`));
  for (const record of [provenance.baseline, provenance.spacingCompleted, provenance.spacingFailed]) assert.ok(agent.includes(record.reviewId));
  assert.match(agent, /not app-autonomous/);
  assert.match(agent, /nothing was saved/);
  assert.match(agent, /at most 12 observations/);
  assert.match(agent, /not visually inspected/);
  assert.doesNotMatch(JSON.stringify(manifest), /data:image\/png;base64/);
});
