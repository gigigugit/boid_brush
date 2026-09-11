import { GoalCardStore, createExampleDeck, CAPABILITIES, LIMITS, parseImport, questionsFor, clone, serializeReviewedDeck } from './goal-card-model.js';
import { GoalPreviewRunner } from './goal-card-preview.js';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (label, action, id) => {
  const b = el('button', label); b.type = 'button';
  if (id) b.id = id;
  b.addEventListener('click', action); return b;
};
function download(value, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type }));
  const a = el('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class GoalCardsView {
  constructor(storage) {
    this.store = new GoalCardStore(storage);
    this.runner = new GoalPreviewRunner();
    this.deck = this.store.revisions.at(-1) || null;
    this.index = 0; this.runId = null; this.message = '';
  }
  mount(root) { this.root = root; this.render(); }
  unmount() { this.runner.cancel(); this.root = null; }
  importValue(value) {
    if (this.runner.running) throw new Error('Cancel the active preview before importing a revision.');
    this.deck = this.store.import(value);
    this.index = 0; this.runId = null;
    this.message = 'Deck validated. Nothing was loaded into the painting workspace.';
    this.render();
  }
  warn(message) {
    this.message = message;
    if (this.status) this.status.textContent = [message, this.store.warning].filter(Boolean).join(' ');
  }
  async start() {
    if (this.runner.running || !this.deck) return;
    const deck = this.deck, card = deck.cards[this.index];
    const imageSize = this.store.reviews.reduce((n, r) => n + (r.result.png?.length || 0), 0);
    if (this.store.reviews.length >= LIMITS.reviews || imageSize + LIMITS.imageChars > LIMITS.totalImageChars) {
      this.warn('Evidence capacity reached. Download reviewed deck. Use a fresh browser profile for further runs; existing evidence will not be deleted.');
      return;
    }
    try {
      const promise = this.runner.run(card, progress => {
        if (this.liveImage && progress.png) { this.liveImage.src = progress.png; this.liveImage.hidden = false; }
        this.warn(`Running isolated preview: ${progress.frames} confirmed frames · ${progress.backend}`);
      });
      this.message = 'Starting isolated WASM / Canvas2D preview…';
      this.render();
      const result = await promise;
      const review = this.store.addRun(deck, card, result);
      this.runId = review.id;
      this.message = `${result.status} · ${result.frames}${result.framesExact ? '' : '+'} frames · ${(result.wallMilliseconds / 1000).toFixed(2)} s wall time. Output frozen. ${result.message}`;
    } catch (error) { this.message = error.message; }
    this.render();
  }
  render() {
    if (!this.root) return;
    this.root.replaceChildren();
    const actions = el('div', undefined, 'experiment-actions');
    const input = el('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file || this.runner.running) return;
      try {
        if (file.size > LIMITS.importBytes) throw new Error('Deck exceeds 16 MB import limit');
        this.importValue(parseImport(await file.text()));
      } catch (error) { this.warn(`Import rejected: ${error.message}`); }
      input.value = '';
    });
    const load = button('Import deck', () => input.click(), 'goalImport');
    load.disabled = this.runner.running;
    actions.append(load, input,
      button('Download example', () => download(createExampleDeck(), 'goal-card-example.json'), 'goalExample'),
      button('Schema / capabilities', () => download(CAPABILITIES, 'goal-card-capabilities.json'), 'goalSchema'));
    const agent = el('a', 'Portable designer agent'); agent.href = './simulation-card-designer.agent.md'; agent.download = 'simulation-card-designer.agent.md';
    actions.append(agent);
    const reviewed = button('Download reviewed deck', () => download(serializeReviewedDeck(this.store.bundle()), 'reviewed-goal-deck.json'), 'goalExport');
    reviewed.disabled = !this.store.revisions.length;
    actions.append(reviewed);
    this.root.append(actions);
    this.status = el('p', [this.message, this.store.warning].filter(Boolean).join(' '), 'experiment-note');
    this.status.id = 'goalStatus'; this.status.setAttribute('role', 'status');
    this.root.append(this.status);
    this.root.append(el('p', 'Manual loop: download example + capabilities + agent → ask your LLM for a deck → import → preview and review → download reviewed deck → ask for a new revision. No automatic optimization.', 'experiment-note'));
    if (!this.deck) {
      const example = button('Try validated example', () => this.importValue(createExampleDeck()), 'goalTryExample');
      example.disabled = this.runner.running;
      this.root.append(example);
      return;
    }
    const selectorLabel = el('label', 'Deck revision ');
    const selector = el('select'); selector.id = 'goalRevision'; selector.disabled = this.runner.running;
    for (const [i, d] of this.store.revisions.entries()) {
      const option = el('option', `${d.title} · ${d.deckId}/${d.revisionId}${this.store.isHistorical(d) ? ' (history)' : ''}`);
      option.value = String(i); option.selected = d === this.deck; selector.append(option);
    }
    selector.addEventListener('change', () => { this.deck = this.store.revisions[+selector.value]; this.index = 0; this.runId = null; this.render(); });
    selectorLabel.append(selector); this.root.append(selectorLabel);
    this.root.append(el('h3', this.deck.goal));
    const criteria = el('ul');
    this.deck.successCriteria.forEach(c => criteria.append(el('li', c)));
    this.root.append(criteria);
    const card = this.deck.cards[this.index];
    const nav = el('nav', undefined, 'experiment-actions'); nav.setAttribute('aria-label', 'Goal cards');
    for (const [label, delta, id] of [['← Previous', -1, 'goalPrevious'], ['Next →', 1, 'goalNext']]) {
      const move = button(label, () => { this.index += delta; this.runId = null; this.message = ''; this.render(); document.getElementById(id)?.focus(); }, id);
      move.disabled = this.runner.running || this.index + delta < 0 || this.index + delta >= this.deck.cards.length;
      nav.append(move);
    }
    nav.append(el('span', `${this.index + 1} / ${this.deck.cards.length}`)); this.root.append(nav);
    const section = el('section', undefined, 'experiment-card goal-card');
    section.append(el('h3', card.title), el('p', card.hypothesis));
    const budget = `${card.budget.frames} frames maximum; ${card.budget.wallSeconds} s wall deadline (+≤250 ms stop grace). WASM / Canvas2D only; hard circle stamps, no external assets.`;
    section.append(el('p', budget, 'experiment-note'));
    const historical = this.store.isHistorical(this.deck);
    const run = button('Run preview', () => void this.start(), 'goalRun'); run.disabled = this.runner.running || historical;
    const cancel = button('Cancel & freeze', () => this.runner.cancel(), 'goalCancel'); cancel.disabled = !this.runner.running;
    const runActions = el('div', undefined, 'experiment-actions'); runActions.append(run, cancel); section.append(runActions);
    const runs = this.store.runs(this.deck, card);
    // Never display a new live image under an older run's metadata/answers.
    const review = this.runner.running ? null : runs.find(r => r.id === this.runId) || runs.at(-1);
    if (runs.length) {
      const historyLabel = el('label', 'Evidence run ');
      const history = el('select'); history.id = 'goalRunHistory'; history.disabled = this.runner.running;
      for (const [i, r] of runs.entries()) {
        const option = el('option', `${i + 1} · ${r.result.status} · ${r.createdAt}${r.sealed || historical ? ' · read-only' : ''}`);
        option.value = r.id; option.selected = r.id === review?.id; history.append(option);
      }
      history.addEventListener('change', () => { this.runId = history.value; this.render(); });
      historyLabel.append(history); section.append(historyLabel);
    }
    const image = el('img'); image.id = 'goalPreviewImage'; image.alt = this.runner.running ? 'Live isolated preview; not yet frozen' : 'Frozen isolated simulation preview'; image.hidden = !review?.result.png;
    if (review?.result.png) image.src = review.result.png;
    this.liveImage = image; section.append(image);
    if (review) {
      const r = review.result;
      section.append(el('p', `${r.status} · ${r.frames}${r.framesExact ? ' exact' : '+ confirmed (execution total unknown)'} frames · PNG frame ${r.capturedFrames} · ${r.simulationSeconds.toFixed(3)} s simulation · ${(r.wallMilliseconds / 1000).toFixed(3)} s wall · ${r.backend}. ${r.randomness}. ${r.message}`, 'experiment-note'));
      const readonly = review.sealed || historical || this.runner.running;
      section.append(el('p', readonly ? 'Historical evidence is read-only. Run again on a current revision for new feedback.' : 'Agreement: −100 disagree, 0 neutral, +100 agree. Unanswered is not neutral; N/A is separate. Rerunning seals this evidence.', 'experiment-note'));
      const save = patch => {
        try { this.store.edit(review.id, patch); this.warn('Feedback saved in this tab.'); }
        catch (error) { this.warn(error.message); }
      };
      for (const q of questionsFor(this.deck, card)) {
        const field = el('fieldset', undefined, 'goal-question'); field.disabled = readonly;
        field.append(el('legend', q.text));
        const answer = clone(review.answers.find(a => a.questionId === q.id));
        const state = el('output');
        const updateState = () => { state.textContent = answer.value === null ? 'Unanswered' : answer.value === 'na' ? 'Not applicable' : String(answer.value); };
        const saveAnswer = () => {
          const fresh = this.store.reviews.find(r => r.id === review.id);
          save({ answers: fresh.answers.map(a => a.questionId === q.id ? clone(answer) : a) }); updateState();
        };
        const slider = el('input'); slider.type = 'range'; slider.min = '-100'; slider.max = '100'; slider.step = '1';
        slider.value = typeof answer.value === 'number' ? String(answer.value) : '0';
        slider.setAttribute('aria-label', q.text);
        slider.addEventListener('input', () => { answer.value = +slider.value; saveAnswer(); });
        field.append(slider, state);
        const choices = el('div', undefined, 'experiment-actions');
        for (const [label, value] of [['Neutral (0)', 0], ['N/A', 'na'], ['Clear answer', null]]) {
          choices.append(button(label, () => { answer.value = value; slider.value = '0'; saveAnswer(); }));
        }
        field.append(choices);
        const label = el('label', 'Question note (optional)');
        const note = el('textarea'); note.rows = 2; note.maxLength = 4000; note.value = answer.note;
        note.addEventListener('input', () => { answer.note = note.value; saveAnswer(); });
        label.append(note); field.append(label); updateState(); section.append(field);
      }
      const notesLabel = el('label', 'Overall notes');
      const notes = el('textarea'); notes.id = 'goalNotes'; notes.maxLength = 12000; notes.rows = 3;
      notes.value = review.notes; notes.disabled = readonly;
      notes.addEventListener('input', () => save({ notes: notes.value }));
      notesLabel.append(notes); section.append(notesLabel);
    } else section.append(el('p', this.runner.running ? 'Preview running. Feedback opens when the output freezes; prior evidence is retained.' : 'Run preview to freeze evidence and answer this card’s questions.'));
    const details = el('details'); details.append(el('summary', 'Complete configuration & revision changes'));
    details.append(el('pre', JSON.stringify({ deckId: this.deck.deckId, revisionId: this.deck.revisionId, parentRevisionId: this.deck.parentRevisionId, changes: this.deck.changes, card }, null, 2)));
    section.append(details); this.root.append(section);
  }
}
