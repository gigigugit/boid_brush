import { createRiverBundle, RiverExperimentRunner } from './river-experiment.js';

// Feedback owns observations. The opt-in river runner owns its temporary state
// and new paint layers separately from ordinary observation-only cards.
export const FEEDBACK_KEY = 'bb_experimentation_v1';
export const FEEDBACK_FORMAT = 'boid-brush-experimentation';
export const SAMPLE_LABELS = ['Start', 'Early', 'Middle', 'Late', 'End'];
export const QUESTIONS = [
  { id: 'cohesion', group: 'Flock', text: 'The flock stays together as intended.', boid: true },
  { id: 'alignment', group: 'Flock', text: 'Agents align their headings as intended.', boid: true },
  { id: 'motion', group: 'Motion', text: 'Speed and motion feel smooth and controllable.' },
  { id: 'seek', group: 'Motion', text: 'Agents follow the intended targets or guides.' },
  { id: 'separation', group: 'Flock', text: 'Agents keep the intended spacing.', boid: true },
  { id: 'boundary', group: 'Environment', text: 'Agents respond to boundaries as intended.' },
  { id: 'obstacles', group: 'Environment', text: 'Agents respond to obstacles as intended.' },
  { id: 'stampSize', group: 'Appearance', text: 'Stamp size suits the motion.' },
  { id: 'stampRotation', group: 'Appearance', text: 'Stamp rotation suits the motion.' },
  { id: 'stampColor', group: 'Appearance', text: 'Stamp colors behave as intended.' },
  { id: 'appearance', group: 'Appearance', text: 'The resulting marks have the intended appearance.' },
  { id: 'overall', group: 'Overall', text: 'The overall behavior matches my intention.' },
];
const questionIds = new Set(QUESTIONS.map(q => q.id));
const text = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : '';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 240;
export const emptyCurve = () => Array(5).fill(null);

export function normalizeCurve(value) {
  return Array.from({ length: 5 }, (_, i) => (
    typeof value?.[i] === 'number' && Number.isFinite(value[i])
      ? Math.max(-100, Math.min(100, Math.round(value[i]))) : null
  ));
}

// Fill the samples crossed by a fast drag, rather than losing intermediate points.
export function dragCurve(curve, from, to) {
  const next = normalizeCurve(curve);
  const end = { index: Math.max(0, Math.min(4, Math.round(to.index))), value: Math.max(-100, Math.min(100, Math.round(to.value))) };
  const start = from || end;
  const low = Math.min(start.index, end.index);
  const high = Math.max(start.index, end.index);
  for (let i = low; i <= high; i++) {
    const t = start.index === end.index ? 1 : (i - start.index) / (end.index - start.index);
    next[i] = Math.round(start.value + (end.value - start.value) * t);
  }
  return normalizeCurve(next);
}

export function fitExperimentationView(view, width, height, docW, docH) {
  const c = Math.abs(Math.cos(view.rotation || 0));
  const s = Math.abs(Math.sin(view.rotation || 0));
  return {
    ...view, panX: 0, panY: 0,
    zoom: Math.max(0.01, Math.min(view.zoom || 1,
      width * 0.92 / Math.max(1, docW * c + docH * s),
      height * 0.92 / Math.max(1, docW * s + docH * c))),
  };
}

export function relevantQuestions(brush) {
  return QUESTIONS.filter(q => !q.boid || brush === 'boid' || !brush);
}

// Only data (not arbitrary prototypes, runtime objects or playback frames).
function safeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const encoded = JSON.stringify(value);
  return encoded.length <= 500000 ? JSON.parse(encoded) : { omitted: 'Configuration exceeds snapshot size limit' };
}

export class FeedbackStore {
  constructor(storage) {
    this.records = new Map();
    this.storage = storage;
    this.status = '';
    this.blocked = false;
    try {
      const raw = storage?.getItem(FEEDBACK_KEY);
      if (!storage) throw new Error('Storage unavailable');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.format !== FEEDBACK_FORMAT || data.version !== 1 || !Array.isArray(data.records)) {
        throw new Error('Unsupported feedback data');
      }
      let skipped = false;
      for (const row of data.records) {
        if (!validId(row?.id) || !row.answers || typeof row.answers !== 'object') {
          skipped = true;
          continue;
        }
        const answers = {};
        for (const q of QUESTIONS) {
          if (!Object.hasOwn(row.answers, q.id)) continue;
          const answer = row.answers[q.id];
          answers[q.id] = {
            curve: normalizeCurve(answer?.curve),
            notApplicable: answer?.notApplicable === true,
            note: text(answer?.note),
          };
        }
        this.records.set(row.id, {
          id: row.id, name: text(row.name, 160), brush: text(row.brush, 40),
          updatedAt: text(row.updatedAt, 50), notes: text(row.notes, 12000),
          configuration: safeSnapshot(row.configuration), answers,
        });
      }
      if (skipped) throw new Error('Some feedback entries are damaged');
    } catch {
      // Keep unreadable/future data untouched. Edits stay in memory and export
      // remains available; never silently replace someone else's observations.
      this.blocked = true;
      this.status = 'Feedback storage is unavailable or damaged. Edits stay in this tab; export JSON before closing.';
    }
  }

  update(context, patch) {
    if (!validId(context?.id)) return false;
    const old = this.records.get(context.id);
    const record = {
      id: context.id, name: text(context.name, 160), brush: text(context.brush, 40),
      configuration: safeSnapshot(context.configuration),
      notes: old?.notes || '', answers: { ...old?.answers },
      updatedAt: new Date().toISOString(),
    };
    if (Object.hasOwn(patch, 'notes')) record.notes = text(patch.notes, 12000);
    if (questionIds.has(patch.question)) {
      const prior = record.answers[patch.question] || { curve: emptyCurve(), notApplicable: false, note: '' };
      record.answers[patch.question] = {
        curve: normalizeCurve(patch.curve ?? prior.curve),
        notApplicable: patch.notApplicable ?? prior.notApplicable,
        note: text(patch.note ?? prior.note),
      };
    }
    this.records.set(record.id, record);
    return this.persist();
  }

  persist() {
    if (this.blocked) return false;
    try {
      this.storage.setItem(FEEDBACK_KEY, JSON.stringify(this.bundle()));
      this.status = 'Feedback saved on this device.';
      return true;
    } catch {
      this.status = 'Could not save feedback (storage full or blocked). Edits stay in this tab; export JSON before closing.';
      return false;
    }
  }

  bundle() {
    return {
      format: FEEDBACK_FORMAT, version: 1, exportedAt: new Date().toISOString(),
      schema: {
        questions: QUESTIONS, sampleLabels: SAMPLE_LABELS,
        scale: { min: -100, max: 100, neutral: 0, unanswered: null },
        meaning: 'Agreement with each statement over an observation, not a simulation parameter curve.',
      },
      records: [...this.records.values()],
    };
  }
}

export const STARTERS = [
  { key: 'flock', name: 'Gentle flock', description: 'A small, slow flock with stronger cohesion and alignment.' },
  { key: 'spacing', name: 'Room to move', description: 'Compare wider separation and looser cohesion.' },
  { key: 'obstacle', name: 'Target and obstacle', description: 'A gentle attractor beyond a repelling obstacle.' },
];

export function createStarter(key, { id, width, height, controls = {} }) {
  const starter = STARTERS.find(item => item.key === key);
  if (!starter) throw new Error('Unknown experimentation starter');
  const x = width * 0.35, y = height * 0.5;
  const spacing = key === 'spacing';
  const vars = { seek: 0, cohesion: spacing ? 0.15 : 0.55, alignment: 0.45, separation: spacing ? 0.65 : 0.25, maxSpeed: 4, damping: 0.95, sensingEnabled: false };
  const points = key === 'obstacle' ? [
    { id: 2, type: 'attract', x: width * 0.75, y, enabled: true, radius: Math.max(8, width * 0.04), influenceRadius: width, strength: 0.6 },
    { id: 3, type: 'repel', x: width * 0.55, y, enabled: true, radius: Math.max(10, width * 0.08), strength: 0.8 },
  ] : [];
  return {
    id, name: starter.name, savedAt: Date.now(), experimentationBrush: 'boid', experimentationStarter: key,
    vars, paramSnapshot: { ...vars },
    controlState: {
      ...controls, count: 48, stampSize: 6, maxSpeed: 8, damping: 95,
      cohesion: vars.cohesion * 100, alignment: 45, separation: vars.separation * 100,
      seek: 0, sensingEnabled: false, simEphemeralMode: false,
    },
    brushData: {
      boid: { spawns: [{ id: 1, x, y, enabled: true, count: 48, stampSize: 6 }], points, paths: [] },
      ant: { spawns: [], points: [], edges: [], pheromonePaths: [] },
      motionPath: { spawns: [], points: [], paths: [] },
    },
    nextId: 4, savedPlayback: null, sensingSourceSelection: [],
  };
}

function element(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) el.textContent = content;
  return el;
}
function button(label, action) {
  const el = element('button', '', label);
  el.type = 'button';
  el.addEventListener('click', action);
  return el;
}

export class ExperimentationController {
  constructor(app, { storage } = {}) {
    this.app = app;
    if (storage === undefined) {
      try { storage = window.localStorage; } catch { storage = null; }
    }
    this.store = new FeedbackStore(storage);
    this.open = false;
    this.tab = 'current';
    this.selectedId = null;
    this.panel = document.getElementById('experimentationDialog');
    this.launch = document.getElementById('experimentationLaunch');
    this.body = document.getElementById('experimentationContent');
    this.status = document.getElementById('experimentationStatus');
    this.river = new RiverExperimentRunner(app, message => {
      const status = this.body.querySelector('[data-river-progress]');
      if (status) status.textContent = message;
      const start = this.body.querySelector('[data-river-start]');
      if (start) start.disabled = this.river.running;
      const stop = this.body.querySelector('[data-river-stop]');
      if (stop) stop.disabled = !this.river.running;
    });
    this.launch.addEventListener('click', () => this.show());
    document.getElementById('experimentationClose').addEventListener('click', () => this.close());
    document.getElementById('experimentationExport').addEventListener('click', () => {
      app._downloadBlob(new Blob([JSON.stringify(this.store.bundle(), null, 2)], { type: 'application/json' }), 'boid-brush-feedback.json');
      this.status.textContent = 'Feedback JSON exported. ' + this.store.status;
    });
    this.panel.addEventListener('keydown', event => {
      // Native inputs keep their editing/navigation behavior, without triggering
      // painting shortcuts (Space, Delete, etc.) on the window listener.
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
    });
    this.panel.addEventListener('keyup', event => event.stopPropagation());
    document.querySelectorAll('[data-experimentation-tab]').forEach(tab => {
      tab.addEventListener('click', () => this.selectTab(tab.dataset.experimentationTab));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...document.querySelectorAll('[data-experimentation-tab]')];
        const index = tabs.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        this.selectTab(tabs[next].dataset.experimentationTab);
        tabs[next].focus();
      });
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.open) this.fitView();
    });
    this.resizeObserver.observe(document.getElementById('canvasArea'));
    this.sync();
  }

  show(opener = this.launch) {
    if (this.open) return;
    this.opener = opener;
    this.savedView = this.app._captureViewState();
    this.open = true;
    // No resize event: resizing backing canvases would destroy unsized documents.
    document.body.classList.add('experimentation-open');
    this.panel.hidden = false;
    this.launch.setAttribute('aria-expanded', 'true');
    // Covered sidebar is not keyboard/screen-reader reachable; the canvas and
    // playback controls remain interactive (intentionally a non-modal dialog).
    this.covered = ['rightPanel', 'rightPanelTabs', 'sidebarToggle'].map(id => document.getElementById(id)).filter(Boolean)
      .map(el => ({ el, inert: el.inert }));
    this.covered.forEach(({ el }) => { el.inert = true; });
    this.fitView();
    this.render();
    document.getElementById('experimentationClose').focus();
    if (this.app.saveSession({ syncSimulation: false }) === false) {
      this.status.textContent += ' Workspace could not be saved; export feedback and simulation setup before leaving.';
    }
  }

  fitView() {
    const metrics = this.app._getCanvasViewMetrics();
    const view = fitExperimentationView(this.savedView, metrics.areaRect.width, metrics.areaRect.height, metrics.docW, metrics.docH);
    // Large documents on small screens may need a fit below the normal manual
    // zoom floor. This is a transient presentation transform, never a persisted
    // zoom-limit change (close restores the original normalized view).
    this.app.viewZoom = view.zoom;
    this.app.viewPanX = view.panX;
    this.app.viewPanY = view.panY;
    this.app.viewRotation = view.rotation;
    this.app.viewFlipped = view.flipped;
    this.app._applyViewTransform();
  }

  close() {
    if (this.river.running) { this.river.cancel(); return; }
    if (!this.open) return;
    this.open = false;
    this.panel.hidden = true;
    document.body.classList.remove('experimentation-open');
    this.launch.setAttribute('aria-expanded', 'false');
    this.covered.forEach(({ el, inert }) => { el.inert = inert; });
    this.app._applyViewState(this.savedView);
    (this.opener?.isConnected && !this.opener.hidden ? this.opener : this.launch).focus();
  }

  sync() {
    const app = this.app;
    const available = app._isMotionBrush() && (app.simulation.enabled || app.simulation.sessions.length > 0);
    this.launch.hidden = !available;
    if (!available && this.open) this.close();
    if (!this.open) return;
    const signature = JSON.stringify([app.simulation.activeSessionIndex, app.simulation.experimentationDraftId, app.activeBrush,
      app.simulation.sessions.map(s => [s.id, s.name])]);
    if (signature !== this.signature) { this.signature = signature; this.render(); }
  }

  selectTab(tab) {
    this.tab = tab;
    this.render();
  }

  context() {
    if (this.tab === 'current') return this.app._getExperimentationContext();
    const sessions = this.app.simulation.sessions;
    const session = sessions.find(s => s.id === this.selectedId) || sessions[0];
    this.selectedId = session?.id || null;
    return session ? this.app._getExperimentationContext(session) : null;
  }

  render() {
    if (!this.open) return;
    document.querySelectorAll('[data-experimentation-tab]').forEach(tab => {
      const active = tab.dataset.experimentationTab === this.tab;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) this.body.setAttribute('aria-labelledby', tab.id);
    });
    this.body.replaceChildren();
    this.status.textContent = this.store.status || 'Feedback saves locally as you edit. Export a backup to keep it elsewhere.';
    if (this.tab === 'starters') { this.renderStarters(); return; }
    const context = this.context();
    if (this.tab === 'saved') this.renderNavigation();
    if (!context) {
      this.body.append(element('p', 'experiment-note', 'No saved configurations yet. Save a simulation or add a starting point.'));
      return;
    }
    const card = element('section', 'experiment-card');
    card.append(element('h3', '', context.name));
    const loaded = context.id === this.app._getExperimentationContext().id;
    card.append(element('p', 'experiment-note', loaded
      ? 'Currently loaded • feedback follows this session, including renames.'
      : 'Browsing only • this configuration is NOT loaded. Navigation never changes the simulation.'));
    if (this.tab === 'current') {
      card.append(element('p', 'experiment-note', 'Tracks sessions loaded anywhere in the app. Saving this draft keeps its feedback identity.'));
    } else {
      const load = button(loaded ? 'Already loaded' : 'Load this configuration…', () => {
        if (this.app.simulation.starting) {
          this.status.textContent = 'Wait for simulation startup to finish before loading.';
          return;
        }
        if (!window.confirm('Load this configuration for single-session playback? Playback will stop, and the current draft will be preserved as a saved session. Existing paint is not cleared. Starting points use Boid / Normal mode. Use Play explicitly when ready.')) return;
        const loaded = this.app._loadExperimentationSession(context.id);
        this.render();
        if (!loaded) this.status.textContent = 'Configuration not loaded. Check brush availability (Ant and Motion Path require alpha features).';
      });
      load.disabled = loaded;
      card.append(load);
    }
    card.append(element('p', 'experiment-note', 'Agreement over your observation: −100 disagree, 0 neutral, +100 agree. Drag across Start → End, or use the keyboard sliders. Blank samples are unanswered, not neutral. Mark irrelevant questions N/A.'));
    const record = this.store.records.get(context.id);
    for (const q of relevantQuestions(context.brush)) this.renderQuestion(card, q, context, record?.answers[q.id]);
    const notesLabel = element('label', 'experiment-notes', 'Overall notes (optional)');
    const notes = element('textarea');
    notes.rows = 3;
    notes.maxLength = 12000;
    notes.value = record?.notes || '';
    notes.addEventListener('input', () => this.save(context, { notes: notes.value }));
    notesLabel.append(notes);
    card.append(notesLabel);
    this.body.append(card);
  }

  save(context, patch) {
    // Resolve by identity, not by the current selected array index. This also
    // captures live parameter edits without rebuilding focused inputs.
    const session = this.app.simulation.sessions.find(s => s.id === context.id);
    const current = this.app._getExperimentationContext();
    const fresh = current.id === context.id ? current : session ? this.app._getExperimentationContext(session) : context;
    this.store.update(fresh, patch);
    this.status.textContent = this.store.status;
  }

  renderNavigation() {
    const sessions = this.app.simulation.sessions;
    const index = sessions.findIndex(s => s.id === this.selectedId);
    const nav = element('nav', 'experiment-actions');
    nav.setAttribute('aria-label', 'Saved configuration cards');
    const move = delta => {
      this.selectedId = sessions[index + delta]?.id || this.selectedId;
      this.render();
      this.body.querySelector(`[data-direction="${delta}"]`)?.focus();
    };
    const prev = button('← Previous', () => move(-1));
    const next = button('Next →', () => move(1));
    prev.dataset.direction = '-1';
    next.dataset.direction = '1';
    prev.disabled = index <= 0;
    next.disabled = index < 0 || index >= sessions.length - 1;
    const count = element('span', '', sessions.length ? `${index + 1} / ${sessions.length}` : '0 / 0');
    count.setAttribute('aria-live', 'polite');
    nav.append(prev, count, next);
    this.body.append(nav);
  }

  renderStarters() {
    this.renderRiverExperiment();
    this.body.append(element('p', 'experiment-note', 'Add a runnable Boid configuration to your saved cards. Nothing is loaded, started, armed for multi-session playback, or painted. Load explicitly, then use the existing Play controls (running may paint; Undo is unchanged).'));
    for (const starter of STARTERS) {
      const card = element('section', 'experiment-card');
      card.append(element('h3', '', starter.name), element('p', 'experiment-note', starter.description));
      card.append(button('Add saved configuration', () => {
        const session = this.app._addExperimentationStarter(starter.key);
        this.selectedId = session.id;
        this.selectTab('saved');
        document.getElementById('experimentationTabSaved').focus();
        this.status.textContent = `Added ${session.name}. Not loaded or running.`;
      }));
      this.body.append(card);
    }
  }

  renderRiverExperiment() {
    const app = this.app;
    const generate = () => createRiverBundle({
      width: app.W, height: app.H, controls: app._getExperimentationDefaultControls(),
      idPrefix: `river-${app._createSimulationSessionId()}`,
    });
    const card = element('section', 'experiment-card');
    card.append(element('h3', '', 'River / oxbow experiment'));
    card.append(element('p', 'experiment-note',
      'A priori: unguided control, guided baseline, slower alignment, looser spacing/smaller stamps, stronger pull. Five trials, nine feedback candidates. No scoring or automatic winner.'));
    card.append(element('p', 'experiment-note',
      'A moving guide traces a horseshoe, then a bypass while retaining old paint. Finite agents recirculate off-canvas: this is visual outflow, not a source/sink, channel constraint, or physical erosion. Keep this tab visible. At most 12 minutes; stalls/timeouts stop safely.'));
    const actions = element('div', 'experiment-actions');
    actions.append(button('Download native river JSON', () => {
      try {
        const bundle = generate();
        app._downloadBlob(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), 'river-priori.sim-setup.json');
        this.river.report('Downloaded analysis and nine static phase candidates. Native Setup Accept replaces your saved list: import in a separate workspace or back up first. Use Start here for automatic phase transitions.');
      } catch (error) { this.river.report(error.message); }
    }));
    const start = button('Start bounded sequence…', async () => {
      if (this.river.running) return;
      if (!window.confirm('Run five trials unattended on five NEW layers and append nine saved candidates? Current playback will stop without resuming; existing paint and draft are retained. Only the latest experiment layer stays visible. Canvas/shortcuts are locked until completion; Stop or Escape cancels and retains partial layers. Keep the tab visible. Maximum 12 minutes.')) return;
      try {
        const run = this.river.start(generate());
        start.disabled = this.river.running;
        stop.disabled = !this.river.running;
        if (this.river.running) this.body.querySelector('[data-river-stop]')?.focus();
        await run;
      } catch (error) { this.river.report(`River experiment failed: ${error.message}`); }
    });
    start.dataset.riverStart = '';
    start.disabled = this.river.running;
    const stop = button('Stop / Cancel', () => this.river.cancel());
    stop.dataset.riverStop = '';
    stop.disabled = !this.river.running;
    actions.append(start, stop);
    const status = element('p', 'experiment-note', this.river.progress);
    status.dataset.riverProgress = '';
    status.setAttribute('role', 'status');
    card.append(actions, status);
    this.body.append(card);
  }

  renderQuestion(card, q, context, answer) {
    let curve = normalizeCurve(answer?.curve);
    let notApplicable = answer?.notApplicable === true;
    const field = element('fieldset', 'experiment-question');
    const legend = element('legend', '', `${q.group} · ${q.text}`);
    const summary = element('span', 'experiment-answer-state');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 300 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('experiment-curve');
    const actions = element('div', 'experiment-actions');
    const neutral = button('All neutral', () => update(Array(5).fill(0)));
    const clear = button('Clear answer', () => { notApplicable = false; update(emptyCurve()); });
    const na = button('Not applicable', () => {
      notApplicable = !notApplicable;
      refresh();
      this.save(context, { question: q.id, curve, notApplicable });
    });
    actions.append(neutral, clear, na);
    const details = element('details');
    details.append(element('summary', '', 'Keyboard sliders & optional note'));
    const sliders = SAMPLE_LABELS.map((label, i) => {
      const row = element('label', 'experiment-slider', label);
      const input = element('input');
      input.type = 'range'; input.min = '-100'; input.max = '100'; input.step = '1';
      input.setAttribute('aria-label', `${q.text} ${label} agreement`);
      input.addEventListener('input', () => {
        const next = [...curve]; next[i] = Number(input.value); update(next);
      });
      // Enter/Space explicitly answers neutral on an untouched slider.
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const next = [...curve]; next[i] = Number(input.value); update(next);
        }
      });
      const value = element('output');
      row.append(input, value);
      details.append(row);
      return { input, value };
    });
    const noteLabel = element('label', 'experiment-notes', 'Question note (optional)');
    const note = element('textarea');
    note.rows = 2; note.maxLength = 4000; note.value = answer?.note || '';
    note.addEventListener('input', () => this.save(context, { question: q.id, note: note.value }));
    noteLabel.append(note); details.append(noteLabel);
    const refresh = () => {
      const count = curve.filter(value => value !== null).length;
      summary.textContent = notApplicable ? 'Not applicable' : count ? `${count}/5 samples answered` : 'Unanswered';
      na.setAttribute('aria-pressed', String(notApplicable));
      svg.classList.toggle('not-applicable', notApplicable);
      svg.replaceChildren();
      const shape = (tag, attrs) => {
        const node = document.createElementNS(svg.namespaceURI, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
        svg.append(node); return node;
      };
      shape('path', { d: 'M 15 10 H 285 M 15 50 H 285 M 15 90 H 285', class: 'experiment-grid' });
      let path = '';
      curve.forEach((value, i) => {
        const x = 15 + i * 67.5, y = 50 - (value || 0) * 0.4;
        if (value !== null) path += `${i && curve[i - 1] !== null ? 'L' : 'M'} ${x} ${y} `;
      });
      shape('path', { d: path, class: 'experiment-line' });
      curve.forEach((value, i) => shape('circle', {
        cx: 15 + i * 67.5, cy: 50 - (value || 0) * 0.4, r: 4,
        class: value === null ? 'experiment-point unanswered' : 'experiment-point',
      }));
      sliders.forEach(({ input, value }, i) => {
        input.value = String(curve[i] ?? 0);
        input.disabled = notApplicable;
        input.setAttribute('aria-valuetext', curve[i] === null ? 'Unanswered. Use arrows to answer, or Enter for neutral.' : `${curve[i]} agreement`);
        value.textContent = curve[i] === null ? '—' : String(curve[i]);
      });
    };
    const update = (next, persist = true) => {
      curve = normalizeCurve(next); notApplicable = false; refresh();
      if (persist) this.save(context, { question: q.id, curve, notApplicable });
    };
    let pointer = null, previous = null;
    const sample = event => {
      const rect = svg.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width * 300;
      const y = (event.clientY - rect.top) / rect.height * 100;
      const next = { index: Math.max(0, Math.min(4, Math.round((x - 15) / 67.5))), value: Math.max(-100, Math.min(100, Math.round((50 - y) / 0.4))) };
      // Keep dragging visual and cheap. Serialize the configuration and write
      // localStorage once at release/cancel, not on every hardware sample.
      update(dragCurve(curve, previous, next), false);
      previous = next;
    };
    svg.addEventListener('pointerdown', event => {
      if (pointer !== null || event.button !== 0) return;
      event.preventDefault(); pointer = event.pointerId; previous = null;
      svg.setPointerCapture(pointer); sample(event);
    });
    svg.addEventListener('pointermove', event => { if (event.pointerId === pointer) sample(event); });
    svg.addEventListener('pointerup', event => {
      if (event.pointerId !== pointer) return;
      sample(event);
      this.save(context, { question: q.id, curve, notApplicable });
      svg.releasePointerCapture(pointer); pointer = null; previous = null;
    });
    const cancel = () => {
      if (pointer !== null) this.save(context, { question: q.id, curve, notApplicable });
      pointer = null; previous = null;
    };
    svg.addEventListener('pointercancel', cancel);
    svg.addEventListener('lostpointercapture', cancel);
    refresh();
    field.append(legend, summary, svg, element('div', 'experiment-curve-axis', 'Start → Early → Middle → Late → End'), actions, details);
    card.append(field);
  }
}
