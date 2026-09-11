// No host app, DOM, layers, history or storage references cross this boundary.
// Import the REAL engine and brush frame/stamp/guide pipeline, not a reimplementation.
import { BoidSim } from './wasm-bridge.js';
import { BoidBrush } from './brushes.js';
import { validateConfig, LIMITS } from './goal-card-model.js';

let stop = null;
let started = false;
self.onmessage = event => {
  if (event.data?.type === 'stop') stop = event.data.status;
  if (event.data?.type === 'start' && !started) {
    started = true;
    void run(event.data.config, event.data.budget);
  }
};
async function run(config, budget) {
  let brush, frames = 0, capturedFrames = 0, png = null, backend = 'unavailable';
  let stepping = false;
  const startedAt = performance.now();
  const report = (type, extra = {}) => self.postMessage({ type, frames, capturedFrames, png, backend, ...extra });
  try {
    validateConfig(config);
    if (!Number.isInteger(budget?.frames) || budget.frames < 1 || budget.frames > 180 || !Number.isFinite(budget.wallSeconds) || budget.wallSeconds < .5 || budget.wallSeconds > 5) throw new Error('Invalid run budget');
    const canvas = new OffscreenCanvas(config.width, config.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Offscreen Canvas2D unavailable');
    ctx.fillStyle = config.background;
    ctx.fillRect(0, 0, config.width, config.height);
    const layer = { canvas, ctx, alphaLock: false, blend: 'source-over', dirty: false };
    // All optional/unsupported behaviors are explicitly off. Native defaults
    // for unexposed leader/sensing fields cannot act because no leaders/maps exist.
    const p = { ...config.params, simSpeed: 1, brushScale: 1, pressureSize: false, pressureOpacity: false,
      sensingEnabled: false, quorumThreshold: 0, quorumCompositeStrength: 0,
      symmetryEnabled: false, corralEnabled: false, flatStroke: false,
      trailBlur: 0, trailFlow: 0, smudge: 0, smudgeOnly: false, kmMix: false, impasto: false,
      stampImageCanvas: null, canvasTextureEnabled: false, taperLength: 0, skipStamps: 0,
      simEphemeralMode: false, leaderCount: 0, colorDist: null };
    const app = {
      W: config.width, H: config.height, DPR: 1, pressure: 1, strokeFrame: 0,
      activeBrush: 'boid', isDrawing: false, leaderX: config.target.x, leaderY: config.target.y,
      simulation: { enabled: true, running: true, mode: 'normal', brushData: { boid: { points: config.guides, paths: [] } } },
      getP: () => p, getActiveLayer: () => layer,
      _resolveSimulationPointConfig: point => point,
      compositeAllLayers() {}, // persistent offscreen layer IS the preview, not the host canvas
    };
    brush = new BoidBrush(app);
    // Deliberately do not call GPU/DOM renderer initialization. The manager's
    // built-in Canvas2D renderer is ready without it and consumes the same batches.
    brush.sim = await BoidSim.create(config.width, config.height, 256);
    brush._ready = true;
    backend = 'wasm / canvas2d';
    brush.sim.writeParams(p, config.target.x, config.target.y, 0);
    for (const s of config.spawns) brush.sim.spawnBatch(s.x, s.y, s.count, s.shape, s.angle, s.jitter, s.radius);
    if (brush.sim.readAgents().count !== config.spawns.reduce((n, s) => n + s.count, 0)) throw new Error('Engine did not spawn the requested agents');
    const capture = async () => {
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const next = new FileReaderSync().readAsDataURL(blob);
      if (next.length > LIMITS.imageChars) throw new Error('Preview PNG exceeds image limit');
      png = next; capturedFrames = frames;
    };
    while (!stop && frames < budget.frames && performance.now() - startedAt < budget.wallSeconds * 1000) {
      stepping = true;
      brush.onFrame(frames / 60);
      frames++;
      stepping = false;
      // Confirm completed frames before asynchronous encoding. Frozen evidence
      // identifies both the completed count and the exact PNG frame separately.
      report('progress');
      if (frames % 10 === 0 || frames === budget.frames) { await capture(); report('progress'); }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (frames && capturedFrames !== frames) await capture();
    report('done', { status: stop || (frames === budget.frames ? 'completed' : 'timeout'), message: '' });
  } catch (error) {
    report('done', { status: 'error', framesExact: !stepping, message: String(error.message || error).slice(0, 2000) });
  } finally {
    brush?.destroy();
  }
}
