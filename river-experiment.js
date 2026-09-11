// A small, declared-before-observation experiment, not an optimizer or fluid model.
const clone = value => JSON.parse(JSON.stringify(value));

export const RIVER_ANALYSIS = {
  baseline: {
    width: 1424, height: 1424, count: 500, spawnRadius: 300,
    spawn: { x: 710.858, y: 677.218 },
    seek: 0, snapshotSeekIgnored: 0.75,
    cohesion: 0.35, separation: 0.15, alignment: 0.22,
    maxSpeed: 11, damping: 0.95, wander: 0.06, wanderSpeed: 0.3, fov: 115,
    jitter: 0, flowField: 0, stampSize: 10, stampOpacity: 0.15,
    ephemeralFrames: 45, ephemeralFade: 1, paths: 0, points: 0,
  },
  feedback: {
    cohesion: [59, 100, 100, 100, 100], motion: [100, 98, 100, 100, 100],
    separation: [75, 70, 76, 76, 69], stampSize: [55, 53, 49, 54, 66],
    seek: [100, 100, 100, 100, 100], boundary: [100, 100, 100, 100, 100],
  },
  interpretation: [
    'Agreement samples are observations, not parameter trajectories or objective scores.',
    'Strong motion/cohesion agreement supports retaining the baseline as a control.',
    'Session vars.seek=0 overrides paramSnapshot.seek=0.75; moving guides still exert their own force.',
    'No guide paths/points were supplied. Seek/boundary agreement does not demonstrate channel following or outflow.',
    'Spacing and stamp size have more room for exploration. Trials are selective contrasts, not a Cartesian search or a claimed optimum.',
  ],
};

export const RIVER_TRIALS = [
  { key: 'control', name: 'Unguided control', guided: false, changes: {} },
  { key: 'guided', name: 'Guided baseline', guided: true, changes: {} },
  { key: 'pace', name: 'Slower aligned flow', guided: true,
    changes: { maxSpeed: 9, alignment: 0.30, pathSpeed: 150 } },
  { key: 'spacing', name: 'Looser narrow ink', guided: true,
    changes: { cohesion: 0.30, separation: 0.22, wander: 0.03, stampSize: 7 } },
  { key: 'pull', name: 'Stronger guide pull', guided: true,
    changes: { guidePull: 1.6, pathSpeed: 180, stampSize: 8 } },
];

export const RIVER_LIMITS = Object.freeze({
  trials: 5, controlFrames: 60, controlMilliseconds: 15000, phaseMilliseconds: 120000,
  stallMilliseconds: 15000, totalMilliseconds: 720000, pollMilliseconds: 100,
});

// Dense authored points survive the app's existing two-pass corner smoothing.
// The return is outside the document but inside the native <=240px sim margin.
export function riverGeometry(width, height, phase = 'horseshoe') {
  if (!['horseshoe', 'bypass'].includes(phase)) throw new Error('Unknown river phase');
  if (![width, height].every(n => Number.isFinite(n) && n >= 256 && n <= 2048)) {
    throw new Error('River experiment requires document dimensions from 256 to 2048 px.');
  }
  const margin = Math.min(220, Math.min(width, height) * 0.14);
  const p = (x, y) => ({ x: x * width, y: y * height });
  const inlet = [p(0, .28), p(.10, .28), p(.18, .22), p(.26, .20),
    p(.33, .25), p(.36, .34), p(.35, .43), p(.32, .50)];
  const bend = phase === 'horseshoe'
    ? [p(.23, .55), p(.16, .64), p(.18, .76), p(.28, .83),
      p(.41, .82), p(.48, .73), p(.46, .62), p(.39, .54)]
    : [p(.35, .51), p(.39, .54)];
  return {
    margin,
    points: [...inlet, ...bend, p(.48, .49), p(.56, .39), p(.66, .35),
      p(.75, .39), p(.81, .49), p(.88, .55), p(1, .55),
      { x: width + margin * .8, y: height * .55 },
      { x: width + margin * .8, y: -margin * .8 },
      { x: -margin * .8, y: -margin * .8 },
      { x: -margin * .8, y: height * .28 }],
  };
}

export function createRiverBundle({ width = 1424, height = 1424, controls = {}, idPrefix = 'river-priori-v1' } = {}) {
  const geometry = riverGeometry(width, height);
  const scale = Math.min(width, height) / 1424;
  const sessions = RIVER_TRIALS.flatMap(trial => {
    const p = { ...RIVER_ANALYSIS.baseline, guidePull: 1.1, pathSpeed: 200, ...trial.changes };
    return (trial.guided ? ['horseshoe', 'bypass'] : ['control']).map(phase => {
      const vars = Object.fromEntries(['seek', 'cohesion', 'separation', 'alignment', 'maxSpeed', 'damping'].map(key => [key, p[key]]));
      vars.sensingEnabled = false;
      const radius = (trial.guided ? 20 : 300) * scale;
      const stampSize = Math.max(2, Math.round(p.stampSize * scale));
      const pathSpeed = Math.max(1, Math.min(200, Math.round(p.pathSpeed * scale)));
      return {
        id: `${idPrefix}-${trial.key}-${phase}`,
        name: `River · ${trial.name} · ${phase}`,
        savedAt: 0, experimentationBrush: 'boid', experimentationStarter: 'river',
        vars,
        controlState: {
          ...controls, count: 500, brushScale: 100, seek: 0,
          cohesion: p.cohesion * 100, separation: p.separation * 100,
          alignment: p.alignment * 100, maxSpeed: p.maxSpeed * 2, damping: 95,
          wander: p.wander * 100, wanderSpeed: 30, fov: 115, jitter: 0, flowField: 0,
          stampSize, stampOpacity: 15, spawnRadius: radius,
          simBoundsMargin: Math.ceil(geometry.margin), simPathSpeed: pathSpeed, simSpeed: 100,
          sensingEnabled: false, flatStroke: false, simEphemeralMode: !trial.guided,
          simEphemeralFrames: 45, simEphemeralFade: 100,
          pressureSize: false, pressureOpacity: false, pressureSpawnRadius: false,
          stampImageEnabled: false, canvasTextureEnabled: false, boidModMatrix: '',
          stampSeparation: 0, skipStamps: 0, smudge: 0, trailFlow: 0,
          sizeVar: 0, opacityVar: 0, speedVar: 0, forceVar: 0,
          hueVar: 0, satVar: 0, litVar: 0, individuality: 0,
          fleeRadius: 0, leaderCount: 0, quorumThreshold: 0,
          boidTouchAction: 'spawn', boidUntouchAction: 'persist',
          symmetryEnabled: false, taperLength: 0,
        },
        paramSnapshot: {
          ...vars, count: 500, wander: p.wander, wanderSpeed: .3, fov: 115,
          jitter: 0, flowField: 0, stampSize, stampOpacity: .15, spawnRadius: radius,
          simBoundsMargin: Math.ceil(geometry.margin), simPathSpeed: pathSpeed,
          simSpeed: 1, simEphemeralMode: !trial.guided, simEphemeralFrames: 45, simEphemeralFade: 1,
        },
        brushData: {
          boid: {
            spawns: [{
              id: 1, enabled: true, count: 500, radius, shape: 'circle',
              x: trial.guided ? width * .02 : width * p.spawn.x / 1424,
              y: trial.guided ? height * .28 : height * p.spawn.y / 1424,
              stampSize, color: '#216c91', opacity: .15,
            }],
            points: [],
            paths: trial.guided ? [{
              id: 2, enabled: true, pathType: 'standard', closed: true,
              direction: 'forward', startOffset: 0, travelDistance: 0,
              speed: 1, strength: p.guidePull, radius: 32 * scale,
              influenceRadius: Math.hypot(width, height) + geometry.margin * 2,
              points: riverGeometry(width, height, phase).points,
              speedPoints: [], radiusPoints: [], strengthPoints: [],
            }] : [],
          },
          ant: { spawns: [], points: [], edges: [], pheromonePaths: [] },
          motionPath: { spawns: [], points: [], paths: [] },
        },
        sensingSourceSelection: [], savedPlayback: null, nextId: 3,
        riverExperiment: { trial: trial.key, phase, changes: trial.changes },
      };
    });
  });
  return {
    format: 'boid-brush-simulation-setup', version: 1,
    activeSessionId: null, multiSessionEnabled: false, sessions,
    bindings: sessions.map((session, sessionIndex) => ({
      sessionId: session.id, sessionIndex, enabled: false, layerIds: [],
    })),
    layers: [],
    riverExperiment: {
      version: 1, dimensions: { width, height }, analysis: clone(RIVER_ANALYSIS),
      trials: clone(RIVER_TRIALS), limits: { ...RIVER_LIMITS },
      instructions: [
        'Use Experimentation > Starting points > River / oxbow experiment > Start for the automatic sequence.',
        'Start appends nine unarmed feedback candidates and paints five new layers; it never selects a best candidate.',
        'Each guided trial runs one full horseshoe circuit, then one bypass circuit on the same layer without respawning.',
        'The control observes up to 60 frames or 15 wall-clock seconds. Runner guides use the boid fixed 1/60-second simulation step, not application uptime.',
        'Imported JSON contains static phase candidates, not an executable schedule. Native Setup Accept replaces saved sessions: import in a separate workspace or back up first.',
        'Use Boid / Normal mode and the stated document dimensions for imported candidates; loading does not resize the document.',
        'Keep the tab visible. Stop/Escape cancels; completed and partial experiment layers remain. Original playback is stopped, not automatically resumed.',
      ],
      limitations: [
        'Finite initial agents recirculate via an off-canvas return. Visible outflow is not a source/sink or mass-conserving river.',
        'Moving attractors are not channel constraints; agents can cut corners or overshoot. Appearance requires observation.',
        'The cutoff is an authored guide change with persistent old marks, not erosion or emergent oxbow formation.',
        'Guided trials deliberately narrow/relocate the spawn and disable ephemeral fading to expose the horseshoe.',
        'Random spawn/wander are not seeded. No automatic scores, optimization, physical GPU, or hydrology claims.',
      ],
    },
  };
}

const savedSimKeys = [
  'enabled', 'mode', 'forceViz', 'vars', 'brushData', 'savedPlayback', 'nextId',
  'activeSessionIndex', 'experimentationDraftId', 'sessions', 'multiSessionEnabled',
  'multiSessionBindings', 'guidesVisible', 'heatmapVisible', 'selected', 'priorDrawSeek',
];

export class RiverExperimentRunner {
  constructor(app, onProgress = () => {}) {
    this.app = app;
    this.onProgress = onProgress;
    this.running = false;
    this.progress = 'Not started. Five predeclared trials; no automatic winner.';
    this.results = [];
  }

  report(message) {
    this.progress = message;
    this.onProgress(message);
  }

  cancel() {
    if (!this.running) return;
    this.cancelled = true;
    this.report('Stopping and restoring workspace…');
  }

  discardPlayback() {
    const app = this.app;
    if (app.simulation.running) app.pauseSimulation();
    if (app.simulation.paused) app.stopSimulation(false);
  }

  async waitForPhase(session, started) {
    const app = this.app;
    const path = app.simulation.brushData.boid.paths[0];
    // Use the owning sampler's smoothed length, not unsmoothed authored length.
    const length = path ? app._getSimulationPathSample(path, 0).totalLength : 0;
    let previous = -1, movedAt = performance.now();
    const phaseStarted = movedAt;
    while (!this.cancelled) {
      const now = performance.now();
      if (!app.simulation.running) throw new Error('Playback interrupted');
      if (app.activeBrush !== 'boid' || app.getActiveLayer()?.id !== this.layerId) throw new Error('Experiment target changed');
      const distance = path ? path.travelDistance : app.simulation.frameCount;
      if (distance !== previous) { previous = distance; movedAt = now; }
      if (now - started > RIVER_LIMITS.totalMilliseconds || now - phaseStarted > RIVER_LIMITS.phaseMilliseconds) {
        throw new Error('Time budget reached');
      }
      if (now - movedAt > RIVER_LIMITS.stallMilliseconds) throw new Error('No simulation progress; keep this tab visible');
      const fraction = distance / (path ? length : RIVER_LIMITS.controlFrames);
      this.report(`${session.name} · ${Math.min(100, Math.floor(fraction * 100))}% · Stop or Escape to cancel`);
      if (fraction >= 1 || (!path && now - phaseStarted >= RIVER_LIMITS.controlMilliseconds && distance > 0)) {
        this.results.push({ sessionId: session.id, phase: session.riverExperiment.phase,
          frames: app.simulation.frameCount, distance, circuitLength: length, status: 'completed' });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, RIVER_LIMITS.pollMilliseconds));
    }
  }

  async start(bundle) {
    if (this.running) return false;
    const app = this.app;
    if (app.simulation.starting || app.isTapering || (app.isDrawing && !app.simulation.running)
      || app.selectionMgr?.active || app.selectionMgr?.transformActive || app._simulationExport?.recording) {
      this.report('Finish the current stroke, selection, transform, recording, or startup before starting.');
      return false;
    }
    const { width, height } = bundle.riverExperiment.dimensions;
    if (width !== app.W || height !== app.H || bundle.sessions.length !== 9) {
      this.report('Regenerate the river setup for this document before starting.');
      return false;
    }
    const snapshot = {
      sim: Object.fromEntries(savedSimKeys.map(key => [key, clone(app.simulation[key] ?? null)])),
      controls: app._captureSimulationSessionControlState(), brush: app.activeBrush,
      view: app._captureViewState(), layerId: app.getActiveLayer()?.id,
      corralEnabled: app.corral.enabled, suppress: app._suppressSessionPersistence,
      armed: app._simulationExport.armedOnStart,
      forceVizView: clone(app._forceVizManualViewSnapshot ?? null),
      forceVizCamera: clone(app._forceVizCameraRuntime ?? null),
    };
    this.running = true;
    this.cancelled = false;
    this.results = [];
    const ownedLayers = [];
    const started = performance.now();
    let failure = null;
    // A local input fence prevents shortcuts, canvas editing, routing, and layer
    // changes during the unattended sequence. Escape/Stop always remain usable.
    const fence = event => {
      if (event.type === 'keydown' && event.key === 'Escape') this.cancel();
      if (event.target?.closest?.('[data-river-stop]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['pointerdown', 'pointermove', 'pointerup', 'click', 'keydown', 'keyup', 'input', 'change'];
    try {
      events.forEach(type => window.addEventListener(type, fence, true));
      app._suppressSessionPersistence = true;
      app._simulationExport.armedOnStart = false;
      this.discardPlayback();
      app.simulation.activeSessionIndex = -1;
      app.simulation.multiSessionEnabled = false;
      app._setSimulationMode('normal');
      app.setBrush('boid');
      app.corral.enabled = false;
      if (!app.simulation.enabled) app._toggleSimulationMode(true);
      app.simulation.guidesVisible = false;
      app.simulation.heatmapVisible = false;
      app.experimentation?.fitView();
      for (const trial of RIVER_TRIALS) {
        if (this.cancelled) break;
        this.discardPlayback();
        ownedLayers.forEach(layer => { layer.visible = false; });
        app.activeLayerIdx = 0;
        app.addLayer(`River · ${trial.name}`);
        const layer = app.getActiveLayer();
        this.layerId = layer.id;
        ownedLayers.push(layer);
        const phases = bundle.sessions.filter(s => s.riverExperiment.trial === trial.key);
        app._applySimulationSessionToDraft(phases[0]);
        await app.startSimulation({ announce: false });
        if (!app.simulation.running) throw new Error('Boid simulation could not start');
        for (let i = 0; i < phases.length && !this.cancelled; i++) {
          if (i > 0) {
            // Same agents and paint; only the animated guide's geometry changes.
            const path = app.simulation.brushData.boid.paths[0];
            path.points = clone(phases[i].brushData.boid.paths[0].points);
            path.travelDistance = 0;
          }
          await this.waitForPhase(phases[i], started);
        }
        // Commit ONLY the experiment-owned target, never the user's old preview.
        if (!this.cancelled) app.stopSimulation(false);
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        this.discardPlayback();
        app.simulation.activeSessionIndex = -1;
        app.setBrush(snapshot.brush);
        app._setSimulationMode(snapshot.sim.mode);
        if (app.simulation.enabled !== snapshot.sim.enabled) app._toggleSimulationMode(snapshot.sim.enabled);
        Object.assign(app.simulation, snapshot.sim, { running: false, paused: false, starting: false });
        app._applySimulationSessionControlState(snapshot.controls);
        app.corral.enabled = snapshot.corralEnabled;
        app._simulationExport.armedOnStart = snapshot.armed;
        app.activeLayerIdx = Math.max(0, app.layers.findIndex(layer => layer.id === snapshot.layerId));
        app._applyViewState(snapshot.view);
        app._forceVizManualViewSnapshot = snapshot.forceVizView;
        app._forceVizCameraRuntime = snapshot.forceVizCamera;
        // Append, never import/Accept: retain the user's exact draft/list/bindings.
        for (const session of bundle.sessions) {
          app.simulation.sessions.push(clone(session));
          app.simulation.multiSessionBindings.push({
            sessionId: session.id, sessionIndex: app.simulation.sessions.length - 1, enabled: false, layerIds: [],
          });
        }
        app._syncLayerSwitcher();
        app._syncSimulationUI();
        app.compositeAllLayers();
      } finally {
        events.forEach(type => window.removeEventListener(type, fence, true));
        app._suppressSessionPersistence = snapshot.suppress;
        this.running = false;
        this.layerId = null;
      }
      const saved = app.saveSession({ syncSimulation: false });
      this.report(`${failure ? `Stopped: ${failure.message}` : this.cancelled ? 'Cancelled' : 'Finished'}. ${this.results.length}/9 phases completed. Nine unarmed candidates added; experiment layers retained (only latest visible). Original playback remains stopped.${saved ? '' : ' Workspace not saved; export a backup.'}`);
    }
    return !failure && !this.cancelled;
  }
}
