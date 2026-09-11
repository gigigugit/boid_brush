import { clone, RANDOMNESS, validateConfig } from './goal-card-model.js';

// The supervisor has no app reference. A worker can be terminated even while
// WASM is busy. Successful/cooperative stops have exact frames; forced kills
// explicitly mark the last confirmed count as a lower bound, never fake success.
export class GoalPreviewRunner {
  constructor({ workerFactory = () => new Worker(new URL('./goal-card-worker.js', import.meta.url), { type: 'module' }),
    now = () => performance.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer) } = {}) {
    Object.assign(this, { workerFactory, now, setTimer, clearTimer });
    this.running = false;
  }
  run(card, onProgress = () => {}) {
    if (this.running) throw new Error('A preview is already running');
    validateConfig(card.config);
    const { frames, wallSeconds } = card.budget;
    if (!Number.isInteger(frames) || frames < 1 || frames > 180 || !Number.isFinite(wallSeconds) || wallSeconds < .5 || wallSeconds > 5) throw new Error('Invalid preview budget');
    this.running = true;
    const start = this.now();
    let worker, deadline, grace, finished = false, requested = null;
    let latest = { frames: 0, capturedFrames: 0, png: null, backend: 'unavailable' };
    return new Promise(resolve => {
      const finish = (status, exact, message = '') => {
        if (finished) return;
        finished = true;
        this.clearTimer(deadline); this.clearTimer(grace); worker?.terminate();
        this.running = false; this.cancel = () => {};
        resolve({ ...latest, status, framesExact: exact, simulationSeconds: latest.frames / 60,
          wallMilliseconds: Math.max(0, this.now() - start), randomness: RANDOMNESS, message });
      };
      const stop = status => {
        if (finished || requested) return;
        requested = status;
        worker?.postMessage({ type: 'stop', status });
        grace = this.setTimer(() => finish(status, false, 'Worker terminated after 250 ms stop grace. Frames are last confirmed, not an exact execution total.'), 250);
      };
      this.cancel = () => stop('cancelled');
      try {
        deadline = this.setTimer(() => stop('timeout'), wallSeconds * 1000);
        worker = this.workerFactory();
        worker.onmessage = ({ data }) => {
          if (finished || !['progress', 'done'].includes(data?.type)) return;
          latest = { frames: data.frames, capturedFrames: data.capturedFrames, png: data.png, backend: data.backend };
          onProgress(clone(latest));
          if (data.type === 'done') finish(requested || data.status, data.framesExact !== false, data.message);
        };
        worker.onerror = event => { event.preventDefault?.(); finish(requested || 'error', false, String(event.message || 'Preview worker unavailable').slice(0, 2000)); };
        worker.postMessage({ type: 'start', config: clone(card.config), budget: clone(card.budget) });
      } catch (error) { finish('error', true, String(error.message).slice(0, 2000)); }
    });
  }
  cancel() {}
}
