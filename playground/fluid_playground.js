import { BlobStroke, ParticleBlobEnvelope } from '../blob-stroke.js?v=20260424-refresh-1';

const FLUID_WASM_MODULE = '../wasm-sim/pkg/boid_sim.js?v=20260424-refresh-1';
const RENDER_MODE_IDS = { particles: 0, grid: 1, hybrid: 2 };
const SIMULATION_TYPE_IDS = { sph: 0, eulerian: 1, lbm: 2 };
const BLOB_TRACK_WINDOW_MS = 240;

const dom = {
  viewport: document.getElementById('viewport'),
  simCanvas: document.getElementById('simCanvas'),
  overlayCanvas: document.getElementById('overlayCanvas'),
  runtimeDot: document.getElementById('runtimeDot'),
  runtimeLabel: document.getElementById('runtimeLabel'),
  runtimeMeta: document.getElementById('runtimeMeta'),
  particleCount: document.getElementById('particleCount'),
  maskCoverage: document.getElementById('maskCoverage'),
  internalResolution: document.getElementById('internalResolution'),
  simMs: document.getElementById('simMs'),
  frameMs: document.getElementById('frameMs'),
  statusText: document.getElementById('statusText'),
  displayOverlay: document.getElementById('displayOverlay'),
  displayMode: document.getElementById('displayMode'),
  renderMode: document.getElementById('renderMode'),
  simulationType: document.getElementById('simulationType'),
  resolutionScale: document.getElementById('resolutionScale'),
  fluidScale: document.getElementById('fluidScale'),
  freeFlowMode: document.getElementById('freeFlowMode'),
  strokePull: document.getElementById('strokePull'),
  strokeRake: document.getElementById('strokeRake'),
  strokeJitter: document.getElementById('strokeJitter'),
  hueJitter: document.getElementById('hueJitter'),
  lightnessJitter: document.getElementById('lightnessJitter'),
  pigmentColor: document.getElementById('pigmentColor'),
  brushRadius: document.getElementById('brushRadius'),
  spawnCount: document.getElementById('spawnCount'),
  particleRadius: document.getElementById('particleRadius'),
  viscosity: document.getElementById('viscosity'),
  density: document.getElementById('density'),
  surfaceTension: document.getElementById('surfaceTension'),
  timeStep: document.getElementById('timeStep'),
  solverSubsteps: document.getElementById('solverSubsteps'),
  motionDecay: document.getElementById('motionDecay'),
  stopSpeed: document.getElementById('stopSpeed'),
  brushRadiusValue: document.getElementById('brushRadiusValue'),
  spawnCountValue: document.getElementById('spawnCountValue'),
  particleRadiusValue: document.getElementById('particleRadiusValue'),
  viscosityValue: document.getElementById('viscosityValue'),
  densityValue: document.getElementById('densityValue'),
  surfaceTensionValue: document.getElementById('surfaceTensionValue'),
  timeStepValue: document.getElementById('timeStepValue'),
  solverSubstepsValue: document.getElementById('solverSubstepsValue'),
  motionDecayValue: document.getElementById('motionDecayValue'),
  stopSpeedValue: document.getElementById('stopSpeedValue'),
  resolutionScaleValue: document.getElementById('resolutionScaleValue'),
  fluidScaleValue: document.getElementById('fluidScaleValue'),
  strokePullValue: document.getElementById('strokePullValue'),
  strokeRakeValue: document.getElementById('strokeRakeValue'),
  strokeJitterValue: document.getElementById('strokeJitterValue'),
  hueJitterValue: document.getElementById('hueJitterValue'),
  lightnessJitterValue: document.getElementById('lightnessJitterValue'),
  blobTightness: document.getElementById('blobTightness'),
  blobTightnessValue: document.getElementById('blobTightnessValue'),
  toolBlob: document.getElementById('toolBlob'),
  toolPigment: document.getElementById('toolPigment'),
  toolErase: document.getElementById('toolErase'),
  togglePlayback: document.getElementById('togglePlayback'),
  stepOnce: document.getElementById('stepOnce'),
  seedCenter: document.getElementById('seedCenter'),
  seedBlob: document.getElementById('seedBlob'),
  presetCircle: document.getElementById('presetCircle'),
  presetRibbon: document.getElementById('presetRibbon'),
  clearPigment: document.getElementById('clearPigment'),
  clearAll: document.getElementById('clearAll'),
  exportSnapshot: document.getElementById('exportSnapshot'),
};

const ctx = {
  sim: dom.simCanvas.getContext('2d', { alpha: true }),
  overlay: dom.overlayCanvas.getContext('2d', { alpha: true }),
};

const buffers = {
  maskCanvas: document.createElement('canvas'),
  paintCanvas: document.createElement('canvas'),
  stagedPaintCanvas: document.createElement('canvas'),
  fluidCanvas: document.createElement('canvas'),
  compositeCanvas: document.createElement('canvas'),
  scaleCanvas: document.createElement('canvas'),
};

const bufferCtx = {
  mask: buffers.maskCanvas.getContext('2d', { willReadFrequently: true }),
  paint: buffers.paintCanvas.getContext('2d', { willReadFrequently: true }),
  stagedPaint: buffers.stagedPaintCanvas.getContext('2d', { willReadFrequently: true }),
  fluid: buffers.fluidCanvas.getContext('2d', { willReadFrequently: true }),
  composite: buffers.compositeCanvas.getContext('2d', { willReadFrequently: true }),
  scale: buffers.scaleCanvas.getContext('2d', { willReadFrequently: true }),
};

const state = {
  width: 0,
  height: 0,
  pointerDown: false,
  pointerId: null,
  pointer: { x: 0, y: 0 },
  lastPointer: { x: 0, y: 0 },
  activeTool: 'blob',
  playback: true,
  freeFlowMode: false,
  draggingWithShift: false,
  maskDirty: true,
  maskCoverage: 0,
  lastFrameAt: performance.now(),
  frameMs: 0,
  simMs: 0,
  runtime: { type: 'boot', detail: 'Preparing solver…' },
  solverFactory: null,
  sim: null,
  activeBlobStroke: null,
  activeBlobMode: 'paint',
  lastBlobDescriptor: null,
};

class WasmBlobFluidSimulator {
  constructor(mod, displayWidth, displayHeight, params) {
    this.mod = mod;
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.internalWidth = 0;
    this.internalHeight = 0;
    this.maskImageData = null;
    this.handle = null;
    this.params = { ...params };
    this.updateParams(params);
  }

  updateParams(params) {
    this.params = { ...params };
    const next = this._targetSize(params);
    const needsRebuild = this.handle === null || next.width !== this.internalWidth || next.height !== this.internalHeight;
    if (needsRebuild) {
      this.internalWidth = next.width;
      this.internalHeight = next.height;
      this._recreateHandle();
    }

    this.mod.fluid_set_params(
      this.handle,
      this._scaleDistance(params.particleRadius),
      params.viscosity,
      params.density,
      params.surfaceTension,
      params.timeStep,
      params.substeps,
      params.motionDecay,
      this._scaleDistance(params.stopSpeed),
      SIMULATION_TYPE_IDS[params.simulationType] ?? SIMULATION_TYPE_IDS.sph,
      RENDER_MODE_IDS[params.renderMode] ?? RENDER_MODE_IDS.hybrid
    );
  }

  setDisplaySize(displayWidth, displayHeight) {
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.updateParams(this.params);
  }

  setMask(imageData) {
    this.maskImageData = imageData;
    if (this.handle === null) return;
    const scaled = scaleImageData(imageData, this.internalWidth, this.internalHeight);
    this.mod.fluid_set_mask_rgba(this.handle, new Uint8Array(scaled.data));
  }

  addParticles(particlesArray) {
    if (this.handle === null || !particlesArray.length) return;
    const packed = new Float32Array(particlesArray.length * 9);
    const scaleX = this.internalWidth / this.displayWidth;
    const scaleY = this.internalHeight / this.displayHeight;
    const scaleAvg = (scaleX + scaleY) * 0.5;
    let offset = 0;

    for (const particle of particlesArray) {
      const rgba = hexToRgba(particle.color ?? this.params.pigmentColor, particle.alpha ?? 0.72);
      packed[offset + 0] = particle.x * scaleX;
      packed[offset + 1] = particle.y * scaleY;
      packed[offset + 2] = (particle.vx ?? 0) * scaleX;
      packed[offset + 3] = (particle.vy ?? 0) * scaleY;
      packed[offset + 4] = rgba.r;
      packed[offset + 5] = rgba.g;
      packed[offset + 6] = rgba.b;
      packed[offset + 7] = rgba.a;
      packed[offset + 8] = (particle.radius ?? this.params.particleRadius) * scaleAvg;
      offset += 9;
    }

    this.mod.fluid_add_particles(this.handle, packed, 9);
  }

  clearParticles() {
    if (this.handle !== null) this.mod.fluid_clear_particles(this.handle);
  }

  step(dt) {
    if (this.handle !== null) this.mod.fluid_step(this.handle, dt);
  }

  readPixels() {
    return {
      buffer: new Uint8ClampedArray(this.mod.fluid_read_pixels(this.handle)),
      width: this.internalWidth,
      height: this.internalHeight,
    };
  }

  getParticleCount() {
    return this.handle !== null ? this.mod.fluid_get_particle_count(this.handle) : 0;
  }

  getParticles() {
    if (this.handle === null) return [];
    const raw = this.mod.fluid_get_particles(this.handle);
    const scaleX = this.displayWidth / this.internalWidth;
    const scaleY = this.displayHeight / this.internalHeight;
    const particles = [];
    for (let index = 0; index < raw.length; index += 4) {
      particles.push({
        x: raw[index] * scaleX,
        y: raw[index + 1] * scaleY,
        vx: raw[index + 2] * scaleX,
        vy: raw[index + 3] * scaleY,
      });
    }
    return particles;
  }

  getRenderSize() {
    return { width: this.internalWidth, height: this.internalHeight };
  }

  destroySimulator() {
    if (this.handle !== null) {
      this.mod.fluid_destroy_simulator(this.handle);
      this.handle = null;
    }
  }

  _targetSize(params) {
    const scale = Number(params.resolutionScale) || 1;
    const fluidScale = Math.max(0.35, Number(params.fluidScale) || 1);
    return {
      width: Math.max(96, Math.round((this.displayWidth * scale) / fluidScale)),
      height: Math.max(72, Math.round((this.displayHeight * scale) / fluidScale)),
    };
  }

  _scaleDistance(distance) {
    const scaleX = this.internalWidth / this.displayWidth;
    const scaleY = this.internalHeight / this.displayHeight;
    return distance * ((scaleX + scaleY) * 0.5);
  }

  _recreateHandle() {
    if (this.handle !== null) {
      this.mod.fluid_destroy_simulator(this.handle);
    }
    this.handle = this.mod.fluid_create_simulator(this.internalWidth, this.internalHeight);
    if (this.maskImageData) {
      this.setMask(this.maskImageData);
    }
  }
}

class FallbackBlobFluidSimulator {
  constructor(displayWidth, displayHeight, params) {
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.params = { ...params };
    this.particles = [];
    this.maskImageData = null;
    this.maskAlpha = new Uint8ClampedArray(0);
    this.maskHasContent = false;
    this.renderCanvas = document.createElement('canvas');
    this.renderCtx = this.renderCanvas.getContext('2d', { willReadFrequently: true });
    this.scaleCanvas = document.createElement('canvas');
    this.scaleCtx = this.scaleCanvas.getContext('2d', { willReadFrequently: true });
    this.velocityField = new Float32Array(0);
    this.updateParams(params);
  }

  updateParams(params) {
    this.params = { ...params };
    const next = this._targetSize(params);
    const resized = next.width !== this.renderCanvas.width || next.height !== this.renderCanvas.height;
    if (resized) {
      this.renderCanvas.width = next.width;
      this.renderCanvas.height = next.height;
      this.maskAlpha = new Uint8ClampedArray(next.width * next.height);
      this.maskHasContent = false;
      this.velocityField = new Float32Array(next.width * next.height * 2);
      this.particles.length = 0;
      if (this.maskImageData) this.setMask(this.maskImageData);
    }
  }

  setDisplaySize(displayWidth, displayHeight) {
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.updateParams(this.params);
  }

  setMask(imageData) {
    this.maskImageData = imageData;
    const scaled = scaleImageData(imageData, this.renderCanvas.width, this.renderCanvas.height, this.scaleCanvas, this.scaleCtx);
    this.maskHasContent = false;
    for (let index = 0, pixel = 0; index < this.maskAlpha.length; index += 1, pixel += 4) {
      this.maskAlpha[index] = scaled.data[pixel + 3];
      this.maskHasContent ||= this.maskAlpha[index] > 8;
    }
  }

  addParticles(particlesArray) {
    const scaleX = this.renderCanvas.width / this.displayWidth;
    const scaleY = this.renderCanvas.height / this.displayHeight;
    const scaleAvg = (scaleX + scaleY) * 0.5;
    for (const particle of particlesArray) {
      const mapped = {
        x: particle.x * scaleX,
        y: particle.y * scaleY,
        vx: (particle.vx ?? 0) * scaleX,
        vy: (particle.vy ?? 0) * scaleY,
        outsideSlack: 0,
        radius: (particle.radius ?? this.params.particleRadius) * scaleAvg,
        color: particle.color ?? this.params.pigmentColor,
        alpha: particle.alpha ?? 0.72,
      };
      if (this._insideMask(mapped.x, mapped.y)) {
        this.particles.push(mapped);
      }
    }
    if (this.particles.length > 4200) {
      this.particles.splice(0, this.particles.length - 4200);
    }
  }

  clearParticles() {
    this.particles.length = 0;
    this.renderCtx.clearRect(0, 0, this.renderCanvas.width, this.renderCanvas.height);
  }

  step(dt) {
    if (!this.particles.length) return;
    const scaledDt = Math.max(0.0005, dt) * this.params.timeStep;
    const substeps = Math.max(1, this.params.substeps | 0);
    const stepDt = scaledDt / substeps;

    for (let stepIndex = 0; stepIndex < substeps; stepIndex += 1) {
      if (this.params.simulationType === 'eulerian') {
        this._stepEulerian(stepDt);
      } else if (this.params.simulationType === 'lbm') {
        this._stepLbm(stepDt);
      } else {
        this._stepSph(stepDt);
      }
    }
  }

  _stepSph(stepDt) {
    const interactionRadius = Math.max(4, this.params.particleRadius * 2.8);
    const interactionRadiusSq = interactionRadius * interactionRadius;
    const delta = new Array(this.particles.length).fill(null).map(() => ({ x: 0, y: 0 }));

    for (let index = 0; index < this.particles.length; index += 1) {
      for (let neighbor = index + 1; neighbor < this.particles.length; neighbor += 1) {
        const dx = this.particles[neighbor].x - this.particles[index].x;
        const dy = this.particles[neighbor].y - this.particles[index].y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= 0.0001 || distSq > interactionRadiusSq) continue;
        const dist = Math.sqrt(distSq);
        const influence = 1 - dist / interactionRadius;
        const nx = dx / dist;
        const ny = dy / dist;
        const repel = influence * (0.025 + this.params.density * 0.11);
        const viscosity = influence * this.params.viscosity * 0.08;

        delta[index].x -= nx * repel;
        delta[index].y -= ny * repel;
        delta[neighbor].x += nx * repel;
        delta[neighbor].y += ny * repel;
        delta[index].x += (this.particles[neighbor].vx - this.particles[index].vx) * viscosity;
        delta[index].y += (this.particles[neighbor].vy - this.particles[index].vy) * viscosity;
        delta[neighbor].x += (this.particles[index].vx - this.particles[neighbor].vx) * viscosity;
        delta[neighbor].y += (this.particles[index].vy - this.particles[neighbor].vy) * viscosity;
      }
    }

    const decay = Math.max(0, Math.min(1, 1 - this.params.motionDecay * stepDt * 60));
    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index];
      particle.vx += delta[index].x * stepDt * 60;
      particle.vy += delta[index].y * stepDt * 60;
      particle.vx *= decay;
      particle.vy *= decay;
      this._advanceParticle(particle, stepDt);
    }
  }

  _stepEulerian(stepDt) {
    this._buildVelocityField(0.22, 0.16);
    const flowStrength = 0.38 + this.params.density * 0.44;
    const diffusion = 0.08 + this.params.viscosity * 0.24;
    const decay = Math.max(0, Math.min(1, 1 - this.params.motionDecay * stepDt * 42));
    for (const particle of this.particles) {
      const field = this._sampleVelocityField(particle.x, particle.y);
      particle.vx += (field.x * flowStrength - particle.vx) * diffusion;
      particle.vy += (field.y * flowStrength - particle.vy) * diffusion;
      particle.vx *= decay;
      particle.vy *= decay;
      this._advanceParticle(particle, stepDt);
    }
  }

  _stepLbm(stepDt) {
    this._buildVelocityField(0.34, 0.30);
    const relaxation = 0.18 + this.params.viscosity * 0.34;
    const pressure = 0.2 + this.params.density * 0.5;
    const decay = Math.max(0, Math.min(1, 1 - this.params.motionDecay * stepDt * 36));
    for (const particle of this.particles) {
      const field = this._sampleVelocityField(particle.x, particle.y);
      const swirlX = -field.y * pressure;
      const swirlY = field.x * pressure;
      particle.vx += (field.x + swirlX - particle.vx) * relaxation;
      particle.vy += (field.y + swirlY - particle.vy) * relaxation;
      particle.vx *= decay;
      particle.vy *= decay;
      this._advanceParticle(particle, stepDt);
    }
  }

  _buildVelocityField(flowScale, swirlScale) {
    const width = this.renderCanvas.width;
    const height = this.renderCanvas.height;
    this.velocityField.fill(0);
    const counts = new Float32Array(width * height);

    for (const particle of this.particles) {
      const ix = clamp(Math.round(particle.x), 0, width - 1);
      const iy = clamp(Math.round(particle.y), 0, height - 1);
      const base = (iy * width + ix) * 2;
      this.velocityField[base] += particle.vx;
      this.velocityField[base + 1] += particle.vy;
      counts[iy * width + ix] += 1;
    }

    for (let iy = 0; iy < height; iy += 1) {
      for (let ix = 0; ix < width; ix += 1) {
        const index = iy * width + ix;
        if (!this.maskAlpha[index]) continue;
        let sumX = 0;
        let sumY = 0;
        let sumW = 0;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = ix + ox;
            const ny = iy + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nIndex = ny * width + nx;
            if (!this.maskAlpha[nIndex]) continue;
            const weight = ox === 0 && oy === 0 ? 1.8 : 1;
            const count = Math.max(1, counts[nIndex]);
            const base = nIndex * 2;
            sumX += (this.velocityField[base] / count) * weight;
            sumY += (this.velocityField[base + 1] / count) * weight;
            sumW += weight;
          }
        }

        const gradX = this._sampleMask(ix + 1, iy) - this._sampleMask(ix - 1, iy);
        const gradY = this._sampleMask(ix, iy + 1) - this._sampleMask(ix, iy - 1);
        const base = index * 2;
        this.velocityField[base] = (sumX / Math.max(1, sumW)) * flowScale - gradY * swirlScale;
        this.velocityField[base + 1] = (sumY / Math.max(1, sumW)) * flowScale + gradX * swirlScale;
      }
    }
  }

  _sampleVelocityField(x, y) {
    const ix = clamp(Math.round(x), 0, this.renderCanvas.width - 1);
    const iy = clamp(Math.round(y), 0, this.renderCanvas.height - 1);
    const base = (iy * this.renderCanvas.width + ix) * 2;
    return { x: this.velocityField[base], y: this.velocityField[base + 1] };
  }

  _sampleMask(x, y) {
    if (!this.maskHasContent) {
      return x >= 0 && y >= 0 && x < this.renderCanvas.width && y < this.renderCanvas.height ? 1 : 0;
    }
    const ix = clamp(x, 0, this.renderCanvas.width - 1);
    const iy = clamp(y, 0, this.renderCanvas.height - 1);
    return this.maskAlpha[iy * this.renderCanvas.width + ix] > 8 ? 1 : 0;
  }

  _advanceParticle(particle, stepDt) {
    const speed = Math.hypot(particle.vx, particle.vy);
    if (speed < this.params.stopSpeed) {
      particle.vx = 0;
      particle.vy = 0;
    }

    const nextX = particle.x + particle.vx * stepDt * 60;
    const nextY = particle.y + particle.vy * stepDt * 60;
    if (this._insideMask(nextX, nextY)) {
      particle.x = clamp(nextX, 0, this.renderCanvas.width - 1);
      particle.y = clamp(nextY, 0, this.renderCanvas.height - 1);
      particle.outsideSlack = 0;
    } else {
      const snap = this._findInsidePoint(particle.x, particle.y, nextX, nextY);
      const overshoot = Math.hypot(nextX - snap.x, nextY - snap.y);
      const leeway = this._boundaryLeeway(particle, speed, stepDt);
      if (overshoot <= leeway) {
        particle.x = clamp(nextX, 0, this.renderCanvas.width - 1);
        particle.y = clamp(nextY, 0, this.renderCanvas.height - 1);
        particle.vx *= 0.96;
        particle.vy *= 0.96;
        particle.outsideSlack = overshoot;
      } else {
        particle.x = snap.x;
        particle.y = snap.y;
        particle.vx *= -0.18;
        particle.vy *= -0.18;
        particle.outsideSlack = 0;
      }
    }
  }

  _boundaryLeeway(particle, speed, stepDt) {
    const travel = Math.max(0, speed - this.params.stopSpeed) * stepDt * 60;
    const forceBias = 1 + this.params.density * 0.9 + this.params.viscosity * 0.35;
    const base = particle.radius * (0.18 + this.params.density * 0.22);
    return clamp(base + travel * 0.9 * forceBias, 0, particle.radius * 1.9 + 10);
  }

  _findInsidePoint(fallbackX, fallbackY, nextX, nextY) {
    if (this._insideMask(fallbackX, fallbackY)) {
      return {
        x: clamp(fallbackX, 0, this.renderCanvas.width - 1),
        y: clamp(fallbackY, 0, this.renderCanvas.height - 1),
      };
    }
    for (let step = 0; step < 14; step += 1) {
      const ratio = step / 13;
      const x = nextX + (fallbackX - nextX) * ratio;
      const y = nextY + (fallbackY - nextY) * ratio;
      if (this._insideMask(x, y)) {
        return {
          x: clamp(x, 0, this.renderCanvas.width - 1),
          y: clamp(y, 0, this.renderCanvas.height - 1),
        };
      }
    }
    return {
      x: clamp(fallbackX, 0, this.renderCanvas.width - 1),
      y: clamp(fallbackY, 0, this.renderCanvas.height - 1),
    };
  }

  readPixels() {
    this._render(this.params.renderMode);
    return {
      buffer: this.renderCtx.getImageData(0, 0, this.renderCanvas.width, this.renderCanvas.height).data,
      width: this.renderCanvas.width,
      height: this.renderCanvas.height,
    };
  }

  getParticleCount() {
    return this.particles.length;
  }

  getParticles() {
    const scaleX = this.displayWidth / this.renderCanvas.width;
    const scaleY = this.displayHeight / this.renderCanvas.height;
    return this.particles.map((particle) => ({
      x: particle.x * scaleX,
      y: particle.y * scaleY,
      vx: particle.vx * scaleX,
      vy: particle.vy * scaleY,
    }));
  }

  getRenderSize() {
    return { width: this.renderCanvas.width, height: this.renderCanvas.height };
  }

  destroySimulator() {
    this.particles.length = 0;
  }

  _targetSize(params) {
    const scale = Number(params.resolutionScale) || 1;
    const fluidScale = Math.max(0.35, Number(params.fluidScale) || 1);
    return {
      width: Math.max(96, Math.round((this.displayWidth * scale) / fluidScale)),
      height: Math.max(72, Math.round((this.displayHeight * scale) / fluidScale)),
    };
  }

  _render(mode) {
    const renderCtx = this.renderCtx;
    renderCtx.clearRect(0, 0, this.renderCanvas.width, this.renderCanvas.height);
    renderCtx.globalCompositeOperation = 'source-over';

    if (mode !== 'particles') {
      const cellSize = Math.max(3, Math.min(24, Math.round(this.params.particleRadius * 3)));
      for (let y = 0; y < this.renderCanvas.height; y += cellSize) {
        for (let x = 0; x < this.renderCanvas.width; x += cellSize) {
          let count = 0;
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          let sumA = 0;
          for (const particle of this.particles) {
            if (particle.x < x || particle.x >= x + cellSize || particle.y < y || particle.y >= y + cellSize) continue;
            const rgba = hexToRgba(particle.color, particle.alpha);
            count += 1;
            sumR += rgba.r;
            sumG += rgba.g;
            sumB += rgba.b;
            sumA += rgba.a;
          }
          if (!count) continue;
          renderCtx.fillStyle = `rgba(${Math.round(sumR / count)}, ${Math.round(sumG / count)}, ${Math.round(sumB / count)}, ${Math.min(0.78, 0.05 + (sumA / count) * 0.28 + count * 0.025)})`;
          renderCtx.fillRect(x, y, cellSize, cellSize);
        }
      }
    }

    if (mode !== 'grid') {
      for (const particle of this.particles) {
        const radius = Math.max(1.25, particle.radius * (mode === 'hybrid' ? 1.55 : 1.1));
        const rgba = hexToRgba(particle.color, particle.alpha * 0.6);
        this._blendDisc(particle.x, particle.y, radius * 2.5, rgba, mode === 'hybrid', particle.outsideSlack > 0);
      }
    }
  }

  _blendDisc(cx, cy, reach, rgba, soft, allowOutside = false) {
    const minX = Math.floor(cx - reach);
    const maxX = Math.ceil(cx + reach);
    const minY = Math.floor(cy - reach);
    const maxY = Math.ceil(cy + reach);
    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        if (!allowOutside && !this._insideMask(px, py)) continue;
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const distance = Math.hypot(dx, dy);
        if (distance > reach) continue;
        const falloff = Math.max(0, 1 - distance / reach);
        const alpha = rgba.a * (soft ? falloff * falloff : falloff) * 0.6;
        if (alpha <= 0.001) continue;
        this.renderCtx.fillStyle = `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${alpha})`;
        this.renderCtx.fillRect(px, py, 1, 1);
      }
    }
  }

  _insideMask(x, y) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.renderCanvas.width || iy >= this.renderCanvas.height) return false;
    if (!this.maskHasContent) return true;
    return this.maskAlpha[iy * this.renderCanvas.width + ix] > 8;
  }
}

async function resolveSolverFactory() {
  try {
    const mod = await import(FLUID_WASM_MODULE);
    if (typeof mod.default === 'function') {
      await mod.default();
    }
    if (typeof mod.fluid_create_simulator === 'function') {
      return {
        type: 'wasm',
        label: 'WASM boid_sim.js',
        detail: 'Fluid solver loaded from wasm-sim/pkg/boid_sim.js.',
        async create(width, height, params) {
          return new WasmBlobFluidSimulator(mod, width, height, params);
        },
      };
    }
  } catch (error) {
    console.error('Fluid WASM load failed:', error);
  }

  return {
    type: 'fallback',
    label: 'JS fallback',
    detail: 'Fluid WASM exports were unavailable, so the backup JS prototype is active.',
    async create(width, height, params) {
      return new FallbackBlobFluidSimulator(width, height, params);
    },
  };
}

function readParams() {
  return {
    brushRadius: Number(dom.brushRadius.value),
    spawnCount: Number(dom.spawnCount.value),
    particleRadius: Number(dom.particleRadius.value),
    viscosity: Number(dom.viscosity.value) / 100,
    density: Number(dom.density.value) / 100,
    surfaceTension: Number(dom.surfaceTension.value) / 100,
    timeStep: Number(dom.timeStep.value) / 16,
    substeps: Number(dom.solverSubsteps.value),
    motionDecay: Number(dom.motionDecay.value) / 100,
    stopSpeed: Number(dom.stopSpeed.value) / 100,
    resolutionScale: Number(dom.resolutionScale.value),
    fluidScale: Number(dom.fluidScale.value) / 100,
    freeFlowMode: Boolean(dom.freeFlowMode.checked),
    strokePull: Number(dom.strokePull.value) / 100,
    strokeRake: Number(dom.strokeRake.value) / 100,
    strokeJitter: Number(dom.strokeJitter.value) / 100,
    hueJitter: Number(dom.hueJitter.value),
    lightnessJitter: Number(dom.lightnessJitter.value),
    blobTightness: Number(dom.blobTightness.value) / 100,
    renderMode: dom.renderMode.value,
    simulationType: 'lbm',
    pigmentColor: dom.pigmentColor.value,
  };
}

async function applyFlowMode() {
  if (state.freeFlowMode) {
    state.activeBlobStroke = null;
    state.activeBlobMode = 'paint';
    state.lastBlobDescriptor = null;
    bufferCtx.mask.clearRect(0, 0, state.width, state.height);
    clearStagedPaintLayer();
    state.maskDirty = true;
    state.maskCoverage = 0;
    dom.maskCoverage.textContent = '0%';
  }

  const sim = state.sim || await ensureSimulator();
  sim.setMask?.(bufferCtx.mask.getImageData(0, 0, state.width, state.height));

  if (state.freeFlowMode) {
    setStatus('Free-flow mode enabled. Blob boundaries and blob previews are bypassed.');
  } else {
    setStatus('Blob-bound mode enabled. Fluid is constrained by committed blob domains again.');
  }
  setTool(state.activeTool);
}

function updateOutputs() {
  const params = readParams();
  dom.brushRadiusValue.value = `${params.brushRadius}px`;
  dom.spawnCountValue.value = `${params.spawnCount}`;
  dom.particleRadiusValue.value = `${params.particleRadius.toFixed(1)}px`;
  dom.viscosityValue.value = params.viscosity.toFixed(2);
  dom.densityValue.value = params.density.toFixed(2);
  dom.surfaceTensionValue.value = params.surfaceTension.toFixed(2);
  dom.timeStepValue.value = `${params.timeStep.toFixed(2)}x`;
  dom.solverSubstepsValue.value = `${params.substeps}`;
  dom.motionDecayValue.value = params.motionDecay.toFixed(2);
  dom.stopSpeedValue.value = params.stopSpeed.toFixed(2);
  dom.resolutionScaleValue.value = `${Math.round(params.resolutionScale * 100)}%`;
  dom.fluidScaleValue.value = `${Math.round(params.fluidScale * 100)}%`;
  dom.strokePullValue.value = `${Math.round(params.strokePull * 100)}%`;
  dom.strokeRakeValue.value = `${Math.round(params.strokeRake * 100)}%`;
  dom.strokeJitterValue.value = `${Math.round(params.strokeJitter * 100)}%`;
  dom.hueJitterValue.value = `${Math.round(params.hueJitter)}°`;
  dom.lightnessJitterValue.value = `${Math.round(params.lightnessJitter)}%`;
  dom.blobTightnessValue.value = `${Math.round(params.blobTightness * 100)}%`;
  dom.presetCircle.disabled = params.freeFlowMode;
  dom.presetRibbon.disabled = params.freeFlowMode;
  dom.blobTightness.disabled = params.freeFlowMode;
  if (!params.freeFlowMode && state.activeBlobStroke?.setTightness) {
    state.activeBlobStroke.setTightness(params.blobTightness);
  }
  if (state.freeFlowMode !== params.freeFlowMode) {
    state.freeFlowMode = params.freeFlowMode;
    applyFlowMode().catch(console.error);
  }
  if (state.sim?.updateParams) {
    state.sim.updateParams(params);
    updateResolutionStat();
  }
}

function setStatus(message) {
  dom.statusText.textContent = message;
}

function setRuntime(type, label, detail) {
  state.runtime = { type, detail };
  dom.runtimeLabel.textContent = label;
  dom.runtimeMeta.textContent = detail;
  dom.runtimeDot.style.background = type === 'wasm' ? 'var(--ok-0)' : 'var(--warm-0)';
  dom.runtimeDot.style.boxShadow = type === 'wasm'
    ? '0 0 0 4px rgba(123, 229, 168, 0.16)'
    : '0 0 0 4px rgba(255, 191, 111, 0.16)';
}

function setTool(tool) {
  state.activeTool = tool;
  dom.toolBlob.classList.toggle('active', tool === 'blob');
  dom.toolPigment.classList.toggle('active', tool === 'pigment');
  dom.toolErase.classList.toggle('active', tool === 'erase');
  if (state.freeFlowMode) {
    setStatus(
      tool === 'erase'
        ? 'Free-flow mode: erase does not affect a blob boundary because no blob is active.'
        : 'Free-flow mode: pointer injects fluid without blob calculation or blob rendering.'
    );
    return;
  }
  setStatus(
    tool === 'blob'
      ? 'Painting blob mask and injecting pigment on the same stroke.'
      : tool === 'pigment'
        ? 'Injecting pigment into the blob.'
        : 'Erasing mask pixels.'
  );
}

async function ensureSimulator() {
  const params = readParams();
  if (!state.sim) {
    state.sim = await state.solverFactory.create(state.width, state.height, params);
    state.sim.setMask?.(bufferCtx.mask.getImageData(0, 0, state.width, state.height));
  }
  state.sim.updateParams?.(params);
  updateResolutionStat();
  return state.sim;
}

function resizeCanvases() {
  const rect = dom.viewport.getBoundingClientRect();
  const nextWidth = Math.max(1, Math.floor(rect.width));
  const nextHeight = Math.max(1, Math.floor(rect.height));
  if (nextWidth === state.width && nextHeight === state.height) return;

  const oldMask = state.width && state.height
    ? bufferCtx.mask.getImageData(0, 0, state.width, state.height)
    : null;

  state.width = nextWidth;
  state.height = nextHeight;

  dom.simCanvas.width = nextWidth;
  dom.simCanvas.height = nextHeight;
  dom.overlayCanvas.width = nextWidth;
  dom.overlayCanvas.height = nextHeight;
  buffers.maskCanvas.width = nextWidth;
  buffers.maskCanvas.height = nextHeight;
  buffers.compositeCanvas.width = nextWidth;
  buffers.compositeCanvas.height = nextHeight;

  if (oldMask) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = oldMask.width;
    tempCanvas.height = oldMask.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(oldMask, 0, 0);
    bufferCtx.mask.clearRect(0, 0, nextWidth, nextHeight);
    bufferCtx.mask.drawImage(tempCanvas, 0, 0, nextWidth, nextHeight);
  } else {
    applyMaskPreset('circle');
  }

  if (state.sim?.setDisplaySize) {
    state.sim.setDisplaySize(nextWidth, nextHeight);
    state.sim.setMask?.(bufferCtx.mask.getImageData(0, 0, nextWidth, nextHeight));
  }

  state.maskDirty = true;
  updateResolutionStat();
}

function beginBlobStroke(point, erase = false) {
  state.activeBlobMode = erase ? 'erase' : 'paint';
  if (erase) {
    const stroke = new BlobStroke();
    stroke.begin(point.x, point.y, { radius: Number(dom.brushRadius.value) });
    state.activeBlobStroke = stroke;
    return;
  }
  state.activeBlobStroke = new ParticleBlobEnvelope({
    trackingWindowMs: BLOB_TRACK_WINDOW_MS,
    flowInfluence: readParams().simulationType === 'lbm' ? 1 : 0,
    trackingMode: readParams().simulationType === 'lbm' ? 'lbm-samples' : 'cohort',
    tightness: readParams().blobTightness,
  });
}

async function resetBlobDomainForNewStroke() {
  state.activeBlobStroke = null;
  state.activeBlobMode = 'paint';
  state.lastBlobDescriptor = null;
  bufferCtx.mask.clearRect(0, 0, state.width, state.height);
  clearStagedPaintLayer();
  state.maskDirty = true;
  state.maskCoverage = 0;
  dom.maskCoverage.textContent = '0%';

  const sim = await ensureSimulator();
  sim.clearParticles?.();
  syncSimulatorMask(false);
}

function extendBlobStroke(point, spawnMeta = null) {
  if (!state.activeBlobStroke) {
    beginBlobStroke(point, state.activeBlobMode === 'erase');
    if (state.activeBlobMode === 'erase') return;
  }
  if (state.activeBlobMode === 'erase') {
    state.activeBlobStroke.extend(point.x, point.y, { radius: Number(dom.brushRadius.value) });
    return;
  }
  if (spawnMeta) {
    state.activeBlobStroke.addSpawn(spawnMeta);
  }
}

function commitBlobStroke() {
  if (state.freeFlowMode || !state.activeBlobStroke || state.activeBlobStroke.isEmpty()) return null;
  const erase = state.activeBlobMode === 'erase';
  if (!erase) {
    state.activeBlobStroke.updateFromParticles?.(state.sim?.getParticles?.() ?? [], performance.now());
  }
  state.activeBlobStroke.rasterize(bufferCtx.mask, {
    compositeOperation: erase ? 'destination-out' : 'source-over',
    fillStyle: 'rgba(255, 255, 255, 1)',
  });

  state.lastBlobDescriptor = erase
    ? null
    : state.activeBlobStroke.toDescriptor({ padding: Number(dom.particleRadius.value) });

  if (!erase) {
    commitStagedPaintLayer();
  } else {
    clearStagedPaintLayer();
  }

  const committed = state.activeBlobStroke;
  state.activeBlobStroke = null;
  state.activeBlobMode = 'paint';
  state.maskDirty = true;
  return committed;
}

function getEffectiveMaskImageData(includeActiveStroke = false) {
  if (!includeActiveStroke || !state.activeBlobStroke || state.activeBlobStroke.isEmpty()) {
    return bufferCtx.mask.getImageData(0, 0, state.width, state.height);
  }

  bufferCtx.composite.clearRect(0, 0, state.width, state.height);
  bufferCtx.composite.drawImage(buffers.maskCanvas, 0, 0);
  state.activeBlobStroke.rasterize(bufferCtx.composite, {
    compositeOperation: state.activeBlobMode === 'erase' ? 'destination-out' : 'source-over',
    fillStyle: 'rgba(255, 255, 255, 1)',
  });
  return bufferCtx.composite.getImageData(0, 0, state.width, state.height);
}

function syncSimulatorMask(includeActiveStroke = false) {
  if (!state.sim) return null;
  const imageData = getEffectiveMaskImageData(includeActiveStroke);
  state.sim.setMask?.(imageData);
  return imageData;
}

function applyMaskPreset(type) {
  if (state.freeFlowMode) {
    setStatus('Disable free-flow mode to apply blob presets.');
    return;
  }
  state.activeBlobStroke = null;
  state.lastBlobDescriptor = null;
  const maskCtx = bufferCtx.mask;
  maskCtx.clearRect(0, 0, state.width, state.height);
  maskCtx.fillStyle = '#fff';
  if (type === 'circle') {
    const radius = Math.min(state.width, state.height) * 0.24;
    maskCtx.beginPath();
    maskCtx.arc(state.width * 0.5, state.height * 0.5, radius, 0, Math.PI * 2);
    maskCtx.fill();
  } else if (type === 'ribbon') {
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.lineWidth = Math.min(state.width, state.height) * 0.18;
    maskCtx.beginPath();
    maskCtx.moveTo(state.width * 0.18, state.height * 0.28);
    maskCtx.bezierCurveTo(
      state.width * 0.28, state.height * 0.1,
      state.width * 0.66, state.height * 0.88,
      state.width * 0.84, state.height * 0.52
    );
    maskCtx.stroke();
  }
  state.maskDirty = true;
}

function refreshMaskCoverage() {
  if (state.freeFlowMode) {
    state.maskCoverage = 0;
    dom.maskCoverage.textContent = '0%';
    state.sim?.setMask?.(bufferCtx.mask.getImageData(0, 0, state.width, state.height));
    return;
  }
  const imageData = getEffectiveMaskImageData(false);
  let filled = 0;
  for (let index = 3; index < imageData.data.length; index += 4) {
    if (imageData.data[index] > 0) filled += 1;
  }
  state.maskCoverage = filled / (state.width * state.height || 1);
  dom.maskCoverage.textContent = `${Math.round(state.maskCoverage * 100)}%`;
  state.sim?.setMask?.(imageData);
}

function makeSpawnProfile(x, y, previousPoint = null) {
  if (!previousPoint) {
    return {
      dx: 0,
      dy: 0,
      distance: 0,
      tangentX: 1,
      tangentY: 0,
      normalX: 0,
      normalY: 1,
      travel: 0,
      spawnTime: performance.now(),
    };
  }
  const dx = x - previousPoint.x;
  const dy = y - previousPoint.y;
  const distance = Math.hypot(dx, dy);
  const tangentX = distance > 1e-3 ? dx / distance : 1;
  const tangentY = distance > 1e-3 ? dy / distance : 0;
  return {
    dx,
    dy,
    distance,
    tangentX,
    tangentY,
    normalX: -tangentY,
    normalY: tangentX,
    travel: 0,
    spawnTime: performance.now(),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hexToHsl(hex) {
  const rgba = hexToRgba(hex, 1);
  const r = rgba.r / 255;
  const g = rgba.g / 255;
  const b = rgba.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) * 0.5;
  if (max === min) {
    return { h: 0, s: 0, l: lightness * 100 };
  }

  const delta = max - min;
  const saturation = lightness > 0.5
    ? delta / (2 - max - min)
    : delta / (max + min);
  let hue = 0;
  if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
  else if (max === g) hue = ((b - r) / delta + 2) / 6;
  else hue = ((r - g) / delta + 4) / 6;
  return { h: hue * 360, s: saturation * 100, l: lightness * 100 };
}

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;

  if (sat <= 0) {
    const grey = Math.round(light * 255);
    const hex = grey.toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
  }

  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const hueToRgb = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const r = Math.round(hueToRgb(hue + 1 / 3) * 255);
  const g = Math.round(hueToRgb(hue) * 255);
  const b = Math.round(hueToRgb(hue - 1 / 3) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function jitterPigmentColor(baseColor, params, profile, index) {
  if (params.hueJitter <= 0 && params.lightnessJitter <= 0) return baseColor;
  const { h, s, l } = hexToHsl(baseColor);
  const phase = (profile?.spawnTime ?? performance.now()) * 0.0026 + index * 0.71;
  const structured = Math.sin(phase) * 0.62 + Math.cos(phase * 0.53 + 1.1) * 0.38;
  const randomBias = (Math.random() - 0.5) * 2;
  const hueOffset = (structured * 0.7 + randomBias * 0.3) * params.hueJitter;
  const lightOffset = (Math.cos(phase * 0.91 + 0.6) * 0.58 + randomBias * 0.42) * params.lightnessJitter;
  const saturationOffset = clamp(-Math.abs(lightOffset) * 0.18 + structured * 2.4, -8, 8);
  return hslToHex(h + hueOffset, s + saturationOffset, l + lightOffset);
}

function makeParticlesAt(x, y, amount, color, spawnProfile = null) {
  const params = readParams();
  const particles = [];
  const speedScale = 0.42 + params.density * 0.58 + params.surfaceTension * 0.18;
  const profile = spawnProfile ?? makeSpawnProfile(x, y, null);
  const travel = Math.min(1, profile.distance / Math.max(8, params.brushRadius * 0.75));
  const laneCount = Math.max(2, 2 + Math.round(params.strokeRake * 5));
  const laneSpacing = params.brushRadius * (0.08 + params.strokeRake * 0.2);
  const phase = profile.spawnTime * 0.018;

  for (let index = 0; index < amount; index += 1) {
    if (profile.distance <= 1e-3) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * params.brushRadius;
      const radialVelocity = speedScale * (0.3 + Math.random() * 1.05);
      const swirlVelocity = speedScale * (0.12 + params.strokeJitter * 0.72) * (Math.random() - 0.5);
      particles.push({
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        vx: Math.cos(angle) * radialVelocity - Math.sin(angle) * swirlVelocity,
        vy: Math.sin(angle) * radialVelocity + Math.cos(angle) * swirlVelocity,
        radius: params.particleRadius,
        color: jitterPigmentColor(color, params, profile, index),
        alpha: 0.68 + Math.random() * 0.1,
      });
      continue;
    }

    const laneIndex = index % laneCount;
    const lanePosition = laneCount > 1 ? laneIndex / (laneCount - 1) - 0.5 : 0;
    const alongOffset = ((Math.random() - 0.42) * params.brushRadius * (0.32 + params.strokePull * 0.9))
      + travel * params.brushRadius * (0.12 + params.strokePull * 0.42);
    const laneOffset = lanePosition * laneSpacing * (1 + travel * 1.4)
      + (Math.random() - 0.5) * params.brushRadius * (0.08 + params.strokeJitter * 0.22);
    const swirlOffset = Math.sin(phase + laneIndex * 1.37 + index * 0.31) * params.brushRadius * params.strokeJitter * 0.16;
    const scatterRadius = Math.sqrt(Math.random()) * params.brushRadius * (0.08 + params.strokeJitter * 0.24);
    const scatterAngle = phase + index * 0.53;
    const scatterX = Math.cos(scatterAngle) * scatterRadius;
    const scatterY = Math.sin(scatterAngle) * scatterRadius;
    const tangentVelocity = speedScale * (0.62 + params.strokePull * 2.2 + params.surfaceTension * 0.24) * (0.66 + travel * 0.96 + Math.random() * 0.5);
    const crossVelocity = speedScale * (lanePosition * (0.36 + params.strokeRake * 1.45)
      + Math.sin(phase + index * 0.83) * params.strokeJitter * 0.28
      + (Math.random() - 0.5) * (0.12 + params.strokeJitter * 0.45));
    const curlVelocity = speedScale * Math.sin(phase * 0.74 + lanePosition * 5.6 + index * 0.21)
      * (0.16 + params.strokeJitter * 0.72 + params.strokeRake * 0.24);
    const backfill = speedScale * (Math.random() - 0.5) * (0.08 + params.strokePull * 0.22);
    const dragNoise = speedScale * (Math.random() - 0.5) * 0.2;

    particles.push({
      x: x
        + profile.tangentX * alongOffset
        + profile.normalX * (laneOffset + swirlOffset)
        + scatterX * 0.35,
      y: y
        + profile.tangentY * alongOffset
        + profile.normalY * (laneOffset + swirlOffset)
        + scatterY * 0.35,
      vx: profile.tangentX * (tangentVelocity + backfill)
        + profile.normalX * (crossVelocity + curlVelocity)
        + dragNoise,
      vy: profile.tangentY * (tangentVelocity + backfill)
        + profile.normalY * (crossVelocity + curlVelocity)
        + dragNoise,
      radius: params.particleRadius * (1 + (Math.random() - 0.5) * (0.08 + params.strokeJitter * 0.22)),
      color: jitterPigmentColor(color, params, profile, index),
      alpha: 0.66 + travel * 0.12 + Math.random() * 0.05,
    });
  }
  return particles;
}

async function seedAt(x, y, amount = readParams().spawnCount, { announce = true, includeActiveStroke = false, spawnProfile = null } = {}) {
  const sim = await ensureSimulator();
  const spawnTime = performance.now();
  const resolvedProfile = spawnProfile
    ? { ...spawnProfile, spawnTime }
    : makeSpawnProfile(x, y, null);
  const startIndex = sim.getParticleCount?.() ?? 0;
  let pendingSpawn = null;
  if (includeActiveStroke) {
    if (state.activeBlobMode === 'paint' && state.activeBlobStroke?.addSpawn) {
      pendingSpawn = state.activeBlobStroke.addSpawn({
        x,
        y,
        radius: Number(dom.brushRadius.value),
        startIndex,
        count: amount,
        spawnTime,
      });
    }
    syncSimulatorMask(true);
  }
  const particles = makeParticlesAt(x, y, amount, dom.pigmentColor.value, resolvedProfile);
  sim.addParticles(particles);
  const endIndex = sim.getParticleCount?.() ?? (startIndex + particles.length);
  if (announce) {
    setStatus(`Seeded ${amount} pigment particles.`);
  }
  const spawnMeta = {
    x,
    y,
    radius: Number(dom.brushRadius.value),
    startIndex,
    count: Math.max(0, endIndex - startIndex) || particles.length,
    spawnTime,
  };
  if (pendingSpawn) {
    Object.assign(pendingSpawn, spawnMeta);
  }
  return spawnMeta;
}

async function seedBlob() {
  const sim = await ensureSimulator();
  const imageData = bufferCtx.mask.getImageData(0, 0, state.width, state.height);
  const particles = [];
  const params = readParams();
  const stride = Math.max(4, Math.round(params.particleRadius * 1.8));
  for (let y = 0; y < state.height; y += stride) {
    for (let x = 0; x < state.width; x += stride) {
      const pixel = params.freeFlowMode ? 255 : imageData.data[(y * state.width + x) * 4 + 3];
      if (pixel < 20 || Math.random() > 0.48) continue;
      particles.push({
        x: x + (Math.random() - 0.5) * stride,
        y: y + (Math.random() - 0.5) * stride,
        vx: (Math.random() - 0.5) * (0.28 + params.surfaceTension * 0.28),
        vy: (Math.random() - 0.5) * (0.28 + params.surfaceTension * 0.28),
        radius: params.particleRadius,
        color: jitterPigmentColor(dom.pigmentColor.value, params, { spawnTime: performance.now() }, particles.length),
        alpha: 0.56 + Math.random() * 0.08,
      });
    }
  }
  sim.addParticles(particles);
  setStatus(`Flooded blob with ${particles.length} starter particles.`);
}

function clearOverlay() {
  ctx.overlay.clearRect(0, 0, state.width, state.height);
}

function resizeRasterSurface(canvas, targetCtx, width, height) {
  if (canvas.width === width && canvas.height === height) {
    return;
  }

  const oldWidth = canvas.width;
  const oldHeight = canvas.height;
  const previous = (oldWidth > 0 && oldHeight > 0)
    ? document.createElement('canvas')
    : null;

  if (previous) {
    previous.width = oldWidth;
    previous.height = oldHeight;
    const previousCtx = previous.getContext('2d');
    previousCtx.drawImage(canvas, 0, 0);
  }

  canvas.width = width;
  canvas.height = height;
  targetCtx.imageSmoothingEnabled = false;
  if (previous) {
    targetCtx.clearRect(0, 0, width, height);
    targetCtx.drawImage(previous, 0, 0, width, height);
  }
}

function ensurePaintSurface(width, height) {
  resizeRasterSurface(buffers.paintCanvas, bufferCtx.paint, width, height);
  resizeRasterSurface(buffers.stagedPaintCanvas, bufferCtx.stagedPaint, width, height);
}

function clearCommittedPaintLayer() {
  bufferCtx.paint.clearRect(0, 0, buffers.paintCanvas.width, buffers.paintCanvas.height);
}

function clearStagedPaintLayer() {
  bufferCtx.stagedPaint.clearRect(0, 0, buffers.stagedPaintCanvas.width, buffers.stagedPaintCanvas.height);
}

function commitStagedPaintLayer() {
  if (!buffers.stagedPaintCanvas.width || !buffers.stagedPaintCanvas.height) {
    return;
  }
  ensurePaintSurface(buffers.stagedPaintCanvas.width, buffers.stagedPaintCanvas.height);
  bufferCtx.paint.save();
  bufferCtx.paint.globalCompositeOperation = 'source-over';
  bufferCtx.paint.drawImage(buffers.stagedPaintCanvas, 0, 0);
  bufferCtx.paint.restore();
  clearStagedPaintLayer();
}

function depositFluidToPaint(frame) {
  ensurePaintSurface(frame.width, frame.height);
  const targetCtx = state.freeFlowMode || !state.activeBlobStroke
    ? bufferCtx.paint
    : bufferCtx.stagedPaint;
  targetCtx.save();
  targetCtx.globalCompositeOperation = 'source-over';
  targetCtx.drawImage(buffers.fluidCanvas, 0, 0);
  targetCtx.restore();
}

function renderOverlay() {
  clearOverlay();
  const overlay = ctx.overlay;
  const overlayMode = dom.displayOverlay.value;

  if (!state.freeFlowMode && overlayMode !== 'none') {
    overlay.save();
    overlay.drawImage(buffers.maskCanvas, 0, 0);
    overlay.globalCompositeOperation = 'source-in';
    overlay.fillStyle = 'rgba(69, 214, 255, 0.18)';
    overlay.fillRect(0, 0, state.width, state.height);
    overlay.restore();

    overlay.save();
    overlay.lineWidth = 1.5;
    overlay.strokeStyle = 'rgba(153, 239, 255, 0.88)';
    overlay.setLineDash([8, 8]);
    overlay.strokeRect(0.75, 0.75, state.width - 1.5, state.height - 1.5);
    overlay.restore();
  }

  if (overlayMode === 'maskVectors') {
    const particles = state.sim?.getParticles?.() ?? [];
    const step = Math.max(1, Math.floor(particles.length / 60));
    overlay.save();
    overlay.strokeStyle = 'rgba(255, 191, 111, 0.52)';
    for (let index = 0; index < particles.length; index += step) {
      const particle = particles[index];
      overlay.beginPath();
      overlay.moveTo(particle.x, particle.y);
      overlay.lineTo(particle.x + particle.vx * 22, particle.y + particle.vy * 22);
      overlay.stroke();
    }
    overlay.restore();
  }

  if (!state.freeFlowMode && state.activeBlobStroke) {
    const previewFill = state.activeBlobMode === 'erase'
      ? 'rgba(255, 140, 140, 0.22)'
      : 'rgba(153, 239, 255, 0.2)';
    const previewStroke = state.activeBlobMode === 'erase'
      ? 'rgba(255, 140, 140, 0.94)'
      : 'rgba(153, 239, 255, 0.92)';
    state.activeBlobStroke.renderPreview(overlay, {
      fillStyle: previewFill,
      strokeStyle: previewStroke,
      guideStyle: 'rgba(255, 191, 111, 0.86)',
      padding: Number(dom.particleRadius.value),
      showBounds: true,
    });
  }

  overlay.save();
  overlay.strokeStyle = state.activeTool === 'erase' || state.draggingWithShift
    ? 'rgba(255, 140, 140, 0.92)'
    : state.activeTool === 'pigment'
      ? 'rgba(255, 191, 111, 0.92)'
      : 'rgba(153, 239, 255, 0.92)';
  overlay.lineWidth = 2;
  overlay.beginPath();
  overlay.arc(state.pointer.x, state.pointer.y, Number(dom.brushRadius.value), 0, Math.PI * 2);
  overlay.stroke();
  overlay.restore();
}

function renderFluid({ depositPaint = false } = {}) {
  ctx.sim.clearRect(0, 0, state.width, state.height);
  ctx.sim.fillStyle = 'rgba(3, 9, 16, 0.7)';
  ctx.sim.fillRect(0, 0, state.width, state.height);
  const displayMode = dom.displayMode?.value || 'composite';
  const frame = state.sim?.readPixels?.() ?? null;

  if (frame) {
    if (buffers.fluidCanvas.width !== frame.width || buffers.fluidCanvas.height !== frame.height) {
      buffers.fluidCanvas.width = frame.width;
      buffers.fluidCanvas.height = frame.height;
    }
    bufferCtx.fluid.putImageData(new ImageData(frame.buffer, frame.width, frame.height), 0, 0);
    if (depositPaint) {
      depositFluidToPaint(frame);
    } else if (
      buffers.paintCanvas.width !== frame.width
      || buffers.paintCanvas.height !== frame.height
      || buffers.stagedPaintCanvas.width !== frame.width
      || buffers.stagedPaintCanvas.height !== frame.height
    ) {
      ensurePaintSurface(frame.width, frame.height);
    }
  }

  if (buffers.paintCanvas.width && buffers.paintCanvas.height) {
    ctx.sim.imageSmoothingEnabled = buffers.paintCanvas.width >= state.width * 0.95 && buffers.paintCanvas.height >= state.height * 0.95;
    ctx.sim.drawImage(buffers.paintCanvas, 0, 0, state.width, state.height);
  }
  if (buffers.stagedPaintCanvas.width && buffers.stagedPaintCanvas.height) {
    ctx.sim.imageSmoothingEnabled = buffers.stagedPaintCanvas.width >= state.width * 0.95 && buffers.stagedPaintCanvas.height >= state.height * 0.95;
    ctx.sim.drawImage(buffers.stagedPaintCanvas, 0, 0, state.width, state.height);
  }
  if (frame && displayMode !== 'pigment') {
    ctx.sim.imageSmoothingEnabled = frame.width >= state.width * 0.95 && frame.height >= state.height * 0.95;
    ctx.sim.drawImage(buffers.fluidCanvas, 0, 0, state.width, state.height);
    dom.internalResolution.textContent = `${frame.width} x ${frame.height}`;
  } else if (frame) {
    dom.internalResolution.textContent = `${frame.width} x ${frame.height}`;
  }
}

async function tick(now) {
  const dt = Math.min(0.05, (now - state.lastFrameAt) / 1000 || 0.016);
  state.lastFrameAt = now;

  if (state.maskDirty) {
    refreshMaskCoverage();
    state.maskDirty = false;
  }

  const frameStart = performance.now();
  let depositedPaint = false;
  if (state.playback && state.sim) {
    const simStart = performance.now();
    state.sim.step(dt);
    state.simMs = performance.now() - simStart;
    depositedPaint = true;
  }

  state.activeBlobStroke?.updateFromParticles?.(state.sim?.getParticles?.() ?? [], now);

  renderFluid({ depositPaint: depositedPaint });
  renderOverlay();
  state.frameMs = performance.now() - frameStart;
  dom.simMs.textContent = `${state.simMs.toFixed(1)} ms`;
  dom.frameMs.textContent = `${state.frameMs.toFixed(1)} ms`;
  dom.particleCount.textContent = `${state.sim?.getParticleCount?.() ?? 0}`;
  requestAnimationFrame(tick);
}

function eventPoint(event) {
  const rect = dom.simCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * state.width,
    y: ((event.clientY - rect.top) / rect.height) * state.height,
  };
}

async function handlePointerDown(event) {
  state.pointerDown = true;
  state.pointerId = event.pointerId;
  if (typeof dom.simCanvas.setPointerCapture === 'function') {
    try {
      dom.simCanvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events used in automated checks may not support capture.
    }
  }
  const point = eventPoint(event);
  state.pointer = point;
  state.lastPointer = point;
  if (state.freeFlowMode) {
    if (state.activeTool !== 'erase' && !event.shiftKey) {
      await seedAt(point.x, point.y, readParams().spawnCount, {
        announce: false,
        includeActiveStroke: false,
        spawnProfile: makeSpawnProfile(point.x, point.y, null),
      });
    }
    return;
  }
  if (state.activeTool === 'pigment' && !event.shiftKey) {
    await seedAt(point.x, point.y);
  } else {
    if (state.activeTool === 'blob' && !event.shiftKey) {
      await resetBlobDomainForNewStroke();
    }
    beginBlobStroke(point, state.activeTool === 'erase' || event.shiftKey);
    if (state.activeTool === 'blob' && !event.shiftKey) {
      await seedAt(point.x, point.y, readParams().spawnCount, {
        announce: false,
        includeActiveStroke: true,
        spawnProfile: makeSpawnProfile(point.x, point.y, null),
      });
    }
  }
}

async function handlePointerMove(event) {
  const point = eventPoint(event);
  const previousPoint = state.lastPointer;
  state.pointer = point;
  state.draggingWithShift = event.shiftKey;
  if (!state.pointerDown) return;
  if (state.freeFlowMode) {
    if (state.activeTool !== 'erase' && !event.shiftKey) {
      await seedAt(point.x, point.y, Math.max(4, Math.round(readParams().spawnCount * 0.45)), {
        announce: false,
        includeActiveStroke: false,
        spawnProfile: makeSpawnProfile(point.x, point.y, previousPoint),
      });
    }
    state.lastPointer = point;
    return;
  }
  if (state.activeTool === 'pigment' && !event.shiftKey) {
    await seedAt(point.x, point.y, Math.max(4, Math.round(readParams().spawnCount * 0.45)), {
      spawnProfile: makeSpawnProfile(point.x, point.y, previousPoint),
    });
  } else {
    if (state.activeTool === 'blob' && !event.shiftKey) {
      await seedAt(point.x, point.y, Math.max(4, Math.round(readParams().spawnCount * 0.35)), {
        announce: false,
        includeActiveStroke: true,
        spawnProfile: makeSpawnProfile(point.x, point.y, previousPoint),
      });
    } else {
      extendBlobStroke(point);
    }
  }
  state.lastPointer = point;
}

function handlePointerUp(event) {
  if (state.pointerId !== event.pointerId) return;
  state.pointerDown = false;
  state.pointerId = null;
  state.draggingWithShift = false;
  if (state.freeFlowMode) {
    return;
  }
  const committed = commitBlobStroke();
  if (committed && state.lastBlobDescriptor?.bounds) {
    const bounds = state.lastBlobDescriptor.bounds;
    setStatus(`Committed blob domain ${Math.round(bounds.width)} x ${Math.round(bounds.height)} and kept injected pigment inside it.`);
  }
}

async function stepOnce() {
  const sim = await ensureSimulator();
  const start = performance.now();
  sim.step(1 / 60);
  state.simMs = performance.now() - start;
  renderFluid({ depositPaint: true });
  renderOverlay();
  dom.simMs.textContent = `${state.simMs.toFixed(1)} ms`;
  dom.particleCount.textContent = `${state.sim?.getParticleCount?.() ?? 0}`;
  setStatus('Advanced the simulation by one frame.');
}

function exportSnapshot() {
  bufferCtx.composite.clearRect(0, 0, state.width, state.height);
  bufferCtx.composite.drawImage(dom.simCanvas, 0, 0);
  bufferCtx.composite.drawImage(dom.overlayCanvas, 0, 0);
  const anchor = document.createElement('a');
  anchor.href = buffers.compositeCanvas.toDataURL('image/png');
  anchor.download = 'blob-fluid-playground.png';
  anchor.click();
  setStatus('Exported snapshot PNG.');
}

function updateResolutionStat() {
  const renderSize = state.sim?.getRenderSize?.();
  dom.internalResolution.textContent = renderSize
    ? `${renderSize.width} x ${renderSize.height}`
    : `${state.width} x ${state.height}`;
}

function bindEvents() {
  for (const element of [
    dom.brushRadius,
    dom.spawnCount,
    dom.particleRadius,
    dom.viscosity,
    dom.density,
    dom.surfaceTension,
    dom.timeStep,
    dom.solverSubsteps,
    dom.motionDecay,
    dom.stopSpeed,
    dom.fluidScale,
    dom.freeFlowMode,
    dom.strokePull,
    dom.strokeRake,
    dom.strokeJitter,
    dom.hueJitter,
    dom.lightnessJitter,
    dom.blobTightness,
    dom.renderMode,
    dom.resolutionScale,
  ]) {
    element.addEventListener('input', updateOutputs);
    element.addEventListener('change', updateOutputs);
  }

  dom.toolBlob.addEventListener('click', () => setTool('blob'));
  dom.toolPigment.addEventListener('click', () => ensureSimulator().then(() => setTool('pigment')));
  dom.toolErase.addEventListener('click', () => setTool('erase'));

  dom.togglePlayback.addEventListener('click', () => {
    state.playback = !state.playback;
    dom.togglePlayback.classList.toggle('active', state.playback);
    dom.togglePlayback.textContent = state.playback ? 'Pause' : 'Play';
    setStatus(state.playback ? 'Simulation resumed.' : 'Simulation paused.');
  });

  dom.stepOnce.addEventListener('click', () => stepOnce().catch(console.error));
  dom.seedCenter.addEventListener('click', () => {
    seedAt(state.width * 0.5, state.height * 0.5, readParams().spawnCount * 2).catch(console.error);
  });
  dom.seedBlob.addEventListener('click', () => seedBlob().catch(console.error));

  dom.presetCircle.addEventListener('click', () => {
    applyMaskPreset('circle');
    setStatus('Applied circular blob mask.');
  });
  dom.presetRibbon.addEventListener('click', () => {
    applyMaskPreset('ribbon');
    setStatus('Applied ribbon blob mask.');
  });

  dom.clearPigment.addEventListener('click', async () => {
    const sim = await ensureSimulator();
    sim.clearParticles?.();
    clearStagedPaintLayer();
    setStatus('Cleared live fluid pigment and uncommitted paint. Last committed paint remains on the canvas.');
  });

  dom.clearAll.addEventListener('click', async () => {
    state.activeBlobStroke = null;
    state.lastBlobDescriptor = null;
    bufferCtx.mask.clearRect(0, 0, state.width, state.height);
    clearCommittedPaintLayer();
    clearStagedPaintLayer();
    state.maskDirty = true;
    const sim = await ensureSimulator();
    sim.clearParticles?.();
    setStatus('Cleared mask, live fluid, committed paint, and uncommitted paint.');
  });

  dom.exportSnapshot.addEventListener('click', exportSnapshot);
  dom.displayOverlay.addEventListener('change', renderOverlay);
  dom.displayMode?.addEventListener('change', () => {
    renderFluid();
    renderOverlay();
  });

  dom.simCanvas.addEventListener('pointerdown', (event) => handlePointerDown(event).catch(console.error));
  dom.simCanvas.addEventListener('pointermove', (event) => handlePointerMove(event).catch(console.error));
  dom.simCanvas.addEventListener('pointerup', handlePointerUp);
  dom.simCanvas.addEventListener('pointercancel', handlePointerUp);
  dom.simCanvas.addEventListener('pointerleave', (event) => {
    state.pointer = eventPoint(event);
  });

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
      dom.togglePlayback.click();
    }
    if (event.key.toLowerCase() === 'b') setTool('blob');
    if (event.key.toLowerCase() === 'p') setTool('pigment');
    if (event.key.toLowerCase() === 'e') setTool('erase');
  });

  const resizeObserver = new ResizeObserver(() => resizeCanvases());
  resizeObserver.observe(dom.viewport);
}

function scaleImageData(imageData, width, height, canvas = buffers.scaleCanvas, drawCtx = bufferCtx.scale) {
  if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
    canvas.width = imageData.width;
    canvas.height = imageData.height;
  }
  drawCtx.putImageData(imageData, 0, 0);
  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = width;
  targetCanvas.height = height;
  const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
  targetCtx.imageSmoothingEnabled = true;
  targetCtx.drawImage(canvas, 0, 0, width, height);
  return targetCtx.getImageData(0, 0, width, height);
}

function hexToRgba(hex, alpha = 1) {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map((chunk) => chunk + chunk).join('')
    : normalized;
  const int = Number.parseInt(value, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
    a: alpha,
  };
}

async function boot() {
  bindEvents();
  state.solverFactory = await resolveSolverFactory();
  setRuntime(state.solverFactory.type, state.solverFactory.label, state.solverFactory.detail);
  resizeCanvases();
  updateOutputs();
  setTool('blob');
  await ensureSimulator();
  setStatus(
    state.solverFactory.type === 'wasm'
      ? 'Playground ready. The fluid simulation is running through WASM.'
      : 'Playground ready, but the JS fallback is active because WASM did not load.'
  );
  requestAnimationFrame(tick);
}

boot().catch((error) => {
  console.error(error);
  setRuntime('fallback', 'Startup error', 'Check the console for details.');
  setStatus('The playground failed to boot cleanly.');
});

window.__BlobFluidPlayground = {
  state,
  readParams,
  seedBlob,
  seedAt,
  BlobStroke,
  ParticleBlobEnvelope,
};
