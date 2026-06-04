const PARTICLE_FLOATS = 10;
const BYTES_PER_F32 = 4;
const PARAM_FLOATS = 32;
const MAX_GUIDE_POINTS = 32;
const WORKGROUP_SIZE = 64;
export const MIN_FLOW_PARTICLES = 256;
export const MAX_FLOW_PARTICLES = 40000;
export const DEFAULT_FLOW_PARTICLES = 12000;
const PALETTE_MODES = Object.freeze({
  mono: 0,
  duo: 1,
  prism: 2,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(value, fallback = '#1a1a1a') {
  let hex = String(value || fallback).trim();
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex)) hex = fallback;
  if (hex.length === 4) hex = `#${hex.slice(1).split('').map(ch => ch + ch).join('')}`;
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function buildParticleData(count, {
  width = 1,
  height = 1,
  centers = [],
  baseSpeed = 1.5,
  segmentWidth = 4,
} = {}) {
  const safeCount = Math.max(1, Math.round(count || 1));
  const data = new Float32Array(safeCount * PARTICLE_FLOATS);
  const usableCenters = Array.isArray(centers) && centers.length
    ? centers
    : [{ x: width * 0.5, y: height * 0.5, radius: Math.min(width, height) * 0.18, weight: 1 }];
  const weightSum = usableCenters.reduce((sum, center) => sum + Math.max(0.001, Number(center.weight) || 1), 0);
  for (let i = 0; i < safeCount; i += 1) {
    let pick = Math.random() * weightSum;
    let center = usableCenters[0];
    for (const candidate of usableCenters) {
      pick -= Math.max(0.001, Number(candidate.weight) || 1);
      if (pick <= 0) {
        center = candidate;
        break;
      }
    }
    const angle = Math.random() * Math.PI * 2;
    const radial = Math.sqrt(Math.random()) * Math.max(8, Number(center.radius) || 24);
    const x = clamp((Number(center.x) || width * 0.5) + Math.cos(angle) * radial, 0, width);
    const y = clamp((Number(center.y) || height * 0.5) + Math.sin(angle) * radial, 0, height);
    const vx = Math.cos(angle + (Math.random() - 0.5) * 1.4) * baseSpeed * (0.35 + Math.random() * 0.8);
    const vy = Math.sin(angle + (Math.random() - 0.5) * 1.4) * baseSpeed * (0.35 + Math.random() * 0.8);
    const base = i * PARTICLE_FLOATS;
    data[base + 0] = x;
    data[base + 1] = y;
    data[base + 2] = x - (vx * 0.4);
    data[base + 3] = y - (vy * 0.4);
    data[base + 4] = vx;
    data[base + 5] = vy;
    data[base + 6] = Math.random();
    data[base + 7] = 0.35 + Math.random() * 0.65;
    data[base + 8] = 0.55 + Math.random() * 0.9;
    data[base + 9] = segmentWidth * (0.6 + Math.random() * 0.9);
  }
  return data;
}

function buildGuideData(points = []) {
  const packed = new Float32Array(MAX_GUIDE_POINTS * 4);
  const count = Math.min(MAX_GUIDE_POINTS, points.length);
  for (let i = 0; i < count; i += 1) {
    const point = points[i] || {};
    const base = i * 4;
    packed[base + 0] = Number(point.x ?? 0);
    packed[base + 1] = Number(point.y ?? 0);
    packed[base + 2] = Number(point.strength ?? 0);
    packed[base + 3] = Math.max(1, Number(point.radius ?? 1));
  }
  return { packed, count };
}

export class WebGPUFlowFieldSystem {
  static async create(options = {}) {
    const system = new WebGPUFlowFieldSystem(options);
    await system.init();
    return system;
  }

  constructor(options = {}) {
    this._sharedAdapter = options.adapter || null;
    this._sharedDevice = options.device || null;
    this.adapter = null;
    this.device = null;
    this.canvas = null;
    this.context = null;
    this.previewCanvas = null;
    this._previewCtx = null;
    this.ready = false;
    this.failed = false;
    this.unavailableReason = '';
    this.presentationFormat = null;
    this.maxParticles = Math.max(256, Math.round(options.maxParticles || 32768));
    this.activeParticleCount = Math.min(this.maxParticles, Math.max(512, Math.round(options.initialParticles || 12000)));
    this.params = new Float32Array(PARAM_FLOATS);
    this.paramsBuffer = null;
    this.guideBuffer = null;
    this.particleBuffers = [];
    this.computeBindGroups = [];
    this.renderBindGroups = [];
    this.computePipeline = null;
    this.fadePipeline = null;
    this.particlePipeline = null;
    this.presentPipeline = null;
    this.presentSampler = null;
    this.accumulationTextures = [];
    this.accumulationViews = [];
    this.accumulationWidth = 0;
    this.accumulationHeight = 0;
    this._activeParticleBufferIndex = 0;
    this._activeAccumulationIndex = 0;
    this._pendingPreviewWidth = 0;
    this._pendingPreviewHeight = 0;
    this._previewSyncPending = false;
    this._previewSyncQueued = false;
    this._hasLivePreviewFrame = false;
    this.onPreviewUpdated = null;
    this._debugEvents = [];
    this._debugSeq = 0;
    this._debugMaxEvents = 160;
    this._lastRenderSignature = '';
    this._lastGuideSignature = '';
  }

  _pushDebugEvent(type, details = {}) {
    const entry = {
      seq: ++this._debugSeq,
      type,
      t: typeof performance !== 'undefined' && Number.isFinite(performance.now())
        ? Number(performance.now().toFixed(2))
        : Date.now(),
      ...details,
    };
    this._debugEvents.push(entry);
    if (this._debugEvents.length > this._debugMaxEvents) {
      this._debugEvents.splice(0, this._debugEvents.length - this._debugMaxEvents);
    }
    return entry;
  }

  getDebugState() {
    return {
      ready: this.ready,
      failed: this.failed,
      unavailableReason: this.unavailableReason,
      activeParticleCount: this.activeParticleCount,
      canvas: this.canvas ? { width: this.canvas.width || 0, height: this.canvas.height || 0 } : null,
      previewCanvas: this.previewCanvas ? { width: this.previewCanvas.width || 0, height: this.previewCanvas.height || 0 } : null,
      previewSyncPending: this._previewSyncPending,
      previewSyncQueued: this._previewSyncQueued,
      hasLivePreviewFrame: this._hasLivePreviewFrame,
      activeParticleBufferIndex: this._activeParticleBufferIndex,
      activeAccumulationIndex: this._activeAccumulationIndex,
      events: this._debugEvents.slice(),
    };
  }

  clearDebugState() {
    this._debugEvents = [];
    this._debugSeq = 0;
    this._lastRenderSignature = '';
    this._lastGuideSignature = '';
    return true;
  }

  async init() {
    if (this.ready) return true;
    if (!this._sharedDevice && (typeof navigator === 'undefined' || !navigator.gpu || typeof document === 'undefined')) {
      this.failed = true;
      this.unavailableReason = 'WebGPU unavailable';
      throw new Error(this.unavailableReason);
    }
    if (this._sharedDevice) {
      this.device = this._sharedDevice;
      this.adapter = this._sharedAdapter;
    } else {
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) {
        this.failed = true;
        this.unavailableReason = 'WebGPU adapter unavailable';
        throw new Error(this.unavailableReason);
      }
      this.device = await this.adapter.requestDevice();
    }
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) {
      this.failed = true;
      this.unavailableReason = 'WebGPU canvas context unavailable';
      throw new Error(this.unavailableReason);
    }
    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat
      ? navigator.gpu.getPreferredCanvasFormat()
      : 'bgra8unorm';
    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: 'premultiplied',
    });
    this.previewCanvas = document.createElement('canvas');
    this._previewCtx = this.previewCanvas.getContext('2d', { willReadFrequently: true });
    this.paramsBuffer = this.device.createBuffer({
      size: this.params.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.guideBuffer = this.device.createBuffer({
      size: MAX_GUIDE_POINTS * 4 * BYTES_PER_F32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const particleBytes = this.maxParticles * PARTICLE_FLOATS * BYTES_PER_F32;
    this.particleBuffers = [
      this.device.createBuffer({ size: particleBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      this.device.createBuffer({ size: particleBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    ];
    this.computePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: this._computeShader() }),
        entryPoint: 'main',
      },
    });
    this.fadePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this._fullscreenShader() }),
        entryPoint: 'vs_main',
      },
      fragment: {
        module: this.device.createShaderModule({ code: this._fadeShader() }),
        entryPoint: 'fs_main',
        targets: [{
          format: this.presentationFormat,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.particlePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this._particleShader() }),
        entryPoint: 'vs_main',
      },
      fragment: {
        module: this.device.createShaderModule({ code: this._particleShader() }),
        entryPoint: 'fs_main',
        targets: [{
          format: this.presentationFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.presentSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.presentPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: this._fullscreenShader() }),
        entryPoint: 'vs_main',
      },
      fragment: {
        module: this.device.createShaderModule({ code: this._presentShader() }),
        entryPoint: 'fs_main',
        targets: [{
          format: this.presentationFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this._rebuildParticleBindGroups();
    this.resetParticles(this.activeParticleCount, { width: 1, height: 1 });
    this.ready = true;
    this._pushDebugEvent('init-ready', {
      maxParticles: this.maxParticles,
      activeParticleCount: this.activeParticleCount,
      sharedDevice: !!this._sharedDevice,
    });
    return true;
  }

  _rebuildParticleBindGroups() {
    if (!this.computePipeline || !this.particlePipeline) return;
    this.computeBindGroups = [
      this.device.createBindGroup({
        layout: this.computePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.particleBuffers[0] } },
          { binding: 1, resource: { buffer: this.particleBuffers[1] } },
          { binding: 2, resource: { buffer: this.paramsBuffer } },
          { binding: 3, resource: { buffer: this.guideBuffer } },
        ],
      }),
      this.device.createBindGroup({
        layout: this.computePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.particleBuffers[1] } },
          { binding: 1, resource: { buffer: this.particleBuffers[0] } },
          { binding: 2, resource: { buffer: this.paramsBuffer } },
          { binding: 3, resource: { buffer: this.guideBuffer } },
        ],
      }),
    ];
    this.renderBindGroups = [
      this.device.createBindGroup({
        layout: this.particlePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.particleBuffers[0] } },
          { binding: 1, resource: { buffer: this.paramsBuffer } },
        ],
      }),
      this.device.createBindGroup({
        layout: this.particlePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.particleBuffers[1] } },
          { binding: 1, resource: { buffer: this.paramsBuffer } },
        ],
      }),
    ];
  }

  _ensureCanvas(widthPx, heightPx) {
    if (this.canvas.width === widthPx && this.canvas.height === heightPx) return;
    this.canvas.width = widthPx;
    this.canvas.height = heightPx;
    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: 'premultiplied',
    });
  }

  _ensurePreviewCanvas(widthPx, heightPx) {
    if (this.previewCanvas.width !== widthPx || this.previewCanvas.height !== heightPx) {
      this.previewCanvas.width = widthPx;
      this.previewCanvas.height = heightPx;
    }
  }

  _ensureAccumulationTextures(widthPx, heightPx) {
    if (this.accumulationWidth === widthPx && this.accumulationHeight === heightPx && this.accumulationTextures.length === 2) return;
    this.accumulationTextures.forEach(texture => texture?.destroy?.());
    this.accumulationTextures = [0, 1].map(() => this.device.createTexture({
      size: { width: widthPx, height: heightPx },
      format: this.presentationFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
    this.accumulationViews = this.accumulationTextures.map(texture => texture.createView());
    this.accumulationWidth = widthPx;
    this.accumulationHeight = heightPx;
    this._activeAccumulationIndex = 0;
  }

  setGuides(points = []) {
    const { packed, count } = buildGuideData(points);
    this.device.queue.writeBuffer(this.guideBuffer, 0, packed);
    this.params[20] = count;
    const guideSignature = JSON.stringify({
      count,
      firstGuide: count > 0 ? {
        x: Number(points[0]?.x ?? 0),
        y: Number(points[0]?.y ?? 0),
        strength: Number(points[0]?.strength ?? 0),
        radius: Number(points[0]?.radius ?? 0),
      } : null,
    });
    if (guideSignature !== this._lastGuideSignature) {
      this._lastGuideSignature = guideSignature;
      this._pushDebugEvent('set-guides', JSON.parse(guideSignature));
    }
  }

  setConfig(config = {}) {
    const primary = hexToRgb(config.primaryColor, '#1a1a1a');
    const secondary = hexToRgb(config.secondaryColor, '#ffffff');
    this.params[0] = Math.max(1, Number(config.width) || 1);
    this.params[1] = Math.max(1, Number(config.height) || 1);
    this.params[2] = Math.max(1, Number(config.renderWidthPx) || 1);
    this.params[3] = Math.max(1, Number(config.renderHeightPx) || 1);
    this.params[4] = this.activeParticleCount;
    this.params[5] = Number(config.time) || 0;
    this.params[6] = clamp(Number(config.dt) || (1 / 60), 1 / 240, 0.05);
    this.params[7] = Math.max(0.0001, Number(config.flowScale) || 0.01);
    this.params[8] = Math.max(0, Number(config.flowStrength) || 0.85);
    this.params[9] = clamp(Number(config.damping) || 0.96, 0.7, 0.999);
    this.params[10] = Math.max(0.2, Number(config.maxSpeed) || 4);
    this.params[11] = Math.max(0, Number(config.evolutionSpeed) || 0.2);
    this.params[12] = clamp(Number(config.trailFade) || 0.94, 0.5, 0.9995);
    this.params[13] = Math.max(0.4, Number(config.segmentWidth) || 3);
    this.params[14] = Math.max(2, Number(config.segmentLength) || 24);
    this.params[15] = Number(config.spawnCenterX ?? this.params[0] * 0.5);
    this.params[16] = Number(config.spawnCenterY ?? this.params[1] * 0.5);
    this.params[17] = Math.max(4, Number(config.spawnRadius) || 16);
    this.params[18] = clamp(Number(config.respawnRate) || 0.18, 0, 1);
    this.params[19] = config.brushActive ? 1 : 0;
    this.params[21] = PALETTE_MODES[config.paletteMode] ?? PALETTE_MODES.duo;
    this.params[22] = primary.r;
    this.params[23] = primary.g;
    this.params[24] = primary.b;
    this.params[25] = clamp(Number(config.opacity) || 0.75, 0, 1);
    this.params[26] = secondary.r;
    this.params[27] = secondary.g;
    this.params[28] = secondary.b;
    this.params[29] = 1;
    this.params[30] = clamp(Number(config.paletteMix ?? 0.75), 0, 1);
    this.params[31] = Math.max(1, Number(config.dpr) || 1);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
  }

  resetParticles(count, options = {}) {
    this.activeParticleCount = Math.min(this.maxParticles, Math.max(256, Math.round(count || this.activeParticleCount)));
    const data = buildParticleData(this.activeParticleCount, options);
    this.device.queue.writeBuffer(this.particleBuffers[0], 0, data);
    this.device.queue.writeBuffer(this.particleBuffers[1], 0, data);
    this._activeParticleBufferIndex = 0;
    this.params[4] = this.activeParticleCount;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    const centers = Array.isArray(options.centers) ? options.centers : [];
    this._pushDebugEvent('reset-particles', {
      count: this.activeParticleCount,
      width: Number(options.width || 0),
      height: Number(options.height || 0),
      centerCount: centers.length,
      firstCenter: centers.length ? {
        x: Number(centers[0]?.x ?? 0),
        y: Number(centers[0]?.y ?? 0),
        radius: Number(centers[0]?.radius ?? 0),
        weight: Number(centers[0]?.weight ?? 0),
      } : null,
      baseSpeed: Number(options.baseSpeed || 0),
      segmentWidth: Number(options.segmentWidth || 0),
    });
  }

  invalidatePreview() {
    this._hasLivePreviewFrame = false;
    this._previewSyncPending = false;
    this._previewSyncQueued = false;
    if (!this._previewCtx || !this.previewCanvas) return;
    this._previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
  }

  clearSurface(widthPx, heightPx) {
    if (!this.ready) return false;
    this._ensureCanvas(Math.max(1, widthPx), Math.max(1, heightPx));
    this._ensurePreviewCanvas(Math.max(1, widthPx), Math.max(1, heightPx));
    this._ensureAccumulationTextures(Math.max(1, widthPx), Math.max(1, heightPx));
    const encoder = this.device.createCommandEncoder();
    for (const view of this.accumulationViews) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: 'store',
        }],
      });
      pass.end();
    }
    const presentPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    presentPass.end();
    this.device.queue.submit([encoder.finish()]);
    this.invalidatePreview();
    this._pushDebugEvent('clear-surface', { widthPx, heightPx });
    return true;
  }

  copyTo2D(targetCtx, widthPx, heightPx, compositeOperation = 'source-over') {
    const source = this._hasLivePreviewFrame ? this.previewCanvas : this.canvas;
    if (!targetCtx || !source) return false;
    try {
      targetCtx.save();
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.globalCompositeOperation = compositeOperation;
      targetCtx.drawImage(source, 0, 0, widthPx, heightPx);
      targetCtx.restore();
      this._pushDebugEvent('copy-to-2d', {
        source: this._hasLivePreviewFrame ? 'preview' : 'canvas',
        widthPx,
        heightPx,
        compositeOperation,
      });
      return true;
    } catch (error) {
      try { targetCtx.restore(); } catch {}
      this._pushDebugEvent('copy-to-2d-failed', {
        source: this._hasLivePreviewFrame ? 'preview' : 'canvas',
        widthPx,
        heightPx,
        compositeOperation,
        message: error?.message || String(error),
      });
      return false;
    }
  }

  _schedulePreviewSync(widthPx, heightPx) {
    this._pendingPreviewWidth = widthPx;
    this._pendingPreviewHeight = heightPx;
    if (this._previewSyncPending) {
      this._previewSyncQueued = true;
      return;
    }
    this._previewSyncPending = true;
    this._pushDebugEvent('preview-sync-start', {
      widthPx,
      heightPx,
      hadOnPreviewUpdated: typeof this.onPreviewUpdated === 'function',
    });
    const finalize = () => {
      const syncWidth = this._pendingPreviewWidth;
      const syncHeight = this._pendingPreviewHeight;
      this._previewSyncPending = false;
      try {
        this._ensurePreviewCanvas(syncWidth, syncHeight);
        this._previewCtx.clearRect(0, 0, syncWidth, syncHeight);
        this._previewCtx.drawImage(this.canvas, 0, 0, syncWidth, syncHeight);
        this._hasLivePreviewFrame = true;
        this._pushDebugEvent('preview-sync-success', {
          widthPx: syncWidth,
          heightPx: syncHeight,
          hadOnPreviewUpdated: typeof this.onPreviewUpdated === 'function',
        });
        this.onPreviewUpdated?.(this.previewCanvas);
      } catch (error) {
        this._hasLivePreviewFrame = false;
        this._pushDebugEvent('preview-sync-failed', {
          widthPx: syncWidth,
          heightPx: syncHeight,
          hadOnPreviewUpdated: typeof this.onPreviewUpdated === 'function',
          message: error?.message || String(error),
        });
      }
      if (this._previewSyncQueued) {
        this._previewSyncQueued = false;
        this._schedulePreviewSync(this._pendingPreviewWidth, this._pendingPreviewHeight);
      }
    };
    if (this.device?.queue?.onSubmittedWorkDone) {
      this.device.queue.onSubmittedWorkDone().then(finalize, () => {
        this._previewSyncPending = false;
      });
      return;
    }
    requestAnimationFrame(finalize);
  }

  render(config = {}) {
    if (!this.ready) return false;
    const widthPx = Math.max(1, Math.round(config.targetWidthPx || 1));
    const heightPx = Math.max(1, Math.round(config.targetHeightPx || 1));
    this._ensureCanvas(widthPx, heightPx);
    this._ensurePreviewCanvas(widthPx, heightPx);
    this._ensureAccumulationTextures(widthPx, heightPx);
    this.setConfig(config);
    const renderSignature = JSON.stringify({
      widthPx,
      heightPx,
      renderWidthPx: Number(config.renderWidthPx || 0),
      renderHeightPx: Number(config.renderHeightPx || 0),
      particleCount: this.activeParticleCount,
      brushActive: !!config.brushActive,
      guideCount: Number(this.params[20] || 0),
    });
    if (renderSignature !== this._lastRenderSignature) {
      this._lastRenderSignature = renderSignature;
      this._pushDebugEvent('render-submitted', {
        widthPx,
        heightPx,
        renderWidthPx: Number(config.renderWidthPx || 0),
        renderHeightPx: Number(config.renderHeightPx || 0),
        activeParticleCount: this.activeParticleCount,
        brushActive: !!config.brushActive,
        inputIndex: this._activeParticleBufferIndex,
        accumulationIndex: this._activeAccumulationIndex,
        hasLivePreviewFrame: this._hasLivePreviewFrame,
      });
    }

    const inputIndex = this._activeParticleBufferIndex;
    const outputIndex = inputIndex ^ 1;
    const prevAccumIndex = this._activeAccumulationIndex;
    const nextAccumIndex = prevAccumIndex ^ 1;

    const fadeBindGroup = this.device.createBindGroup({
      layout: this.fadePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.accumulationViews[prevAccumIndex] },
        { binding: 1, resource: this.presentSampler },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
      ],
    });
    const presentBindGroup = this.device.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.accumulationViews[nextAccumIndex] },
        { binding: 1, resource: this.presentSampler },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroups[inputIndex]);
    computePass.dispatchWorkgroups(Math.ceil(this.activeParticleCount / WORKGROUP_SIZE));
    computePass.end();

    const fadePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.accumulationViews[nextAccumIndex],
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    fadePass.setPipeline(this.fadePipeline);
    fadePass.setBindGroup(0, fadeBindGroup);
    fadePass.draw(6, 1, 0, 0);
    fadePass.end();

    const particlePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.accumulationViews[nextAccumIndex],
        loadOp: 'load',
        storeOp: 'store',
      }],
    });
    particlePass.setPipeline(this.particlePipeline);
    particlePass.setBindGroup(0, this.renderBindGroups[outputIndex]);
    particlePass.draw(6, this.activeParticleCount, 0, 0);
    particlePass.end();

    const presentPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    presentPass.setPipeline(this.presentPipeline);
    presentPass.setBindGroup(0, presentBindGroup);
    presentPass.draw(6, 1, 0, 0);
    presentPass.end();

    this.device.queue.submit([encoder.finish()]);
    this._activeParticleBufferIndex = outputIndex;
    this._activeAccumulationIndex = nextAccumIndex;
    this._schedulePreviewSync(widthPx, heightPx);
    return true;
  }

  _computeShader() {
    return `
struct Particle {
  pos : vec2f,
  prev : vec2f,
  vel : vec2f,
  seed : f32,
  life : f32,
  tone : f32,
  widthScale : f32,
};

struct Params {
  values : array<f32, ${PARAM_FLOATS}>,
};

@group(0) @binding(0) var<storage, read> srcParticles : array<Particle>;
@group(0) @binding(1) var<storage, read_write> dstParticles : array<Particle>;
@group(0) @binding(2) var<storage, read> params : Params;
@group(0) @binding(3) var<storage, read> guides : array<vec4f>;

fn hash11(n : f32) -> f32 {
  var x = fract(n * 0.1031);
  x = x * (x + 33.33);
  x = x * (x + x);
  return fract(x);
}

fn scalarField(pos : vec2f, seed : f32, time : f32, scale : f32) -> f32 {
  let p = pos * scale;
  let layerA = sin(p.x * 1.23 + time * 0.53 + seed * 6.2831) * cos(p.y * 1.11 - time * 0.37 + seed * 4.17);
  let layerB = sin((p.x + p.y) * 0.71 - time * 0.19 + seed * 8.11);
  let layerC = cos((p.x - p.y) * 1.57 + time * 0.23 - seed * 5.37);
  return layerA * 0.6 + layerB * 0.25 + layerC * 0.15;
}

fn curlField(pos : vec2f, seed : f32, time : f32, scale : f32) -> vec2f {
  let eps = 6.0;
  let dx = scalarField(pos + vec2f(eps, 0.0), seed, time, scale) - scalarField(pos - vec2f(eps, 0.0), seed, time, scale);
  let dy = scalarField(pos + vec2f(0.0, eps), seed, time, scale) - scalarField(pos - vec2f(0.0, eps), seed, time, scale);
  let flow = vec2f(dy, -dx);
  let lenSq = max(dot(flow, flow), 1e-5);
  return flow / sqrt(lenSq);
}

fn respawnParticle(source : Particle, index : u32, width : f32, height : f32, center : vec2f, radius : f32, time : f32) -> Particle {
  let a = hash11(source.seed * 97.13 + f32(index) * 0.173 + time * 0.13) * 6.2831853;
  let r = sqrt(hash11(source.seed * 43.71 + f32(index) * 1.713 + time * 0.19)) * radius;
  let pos = vec2f(
    clamp(center.x + cos(a) * r, 0.0, width),
    clamp(center.y + sin(a) * r, 0.0, height)
  );
  let vAngle = a + (hash11(source.seed * 12.7 + time * 0.7) - 0.5) * 1.8;
  let speed = 0.4 + hash11(source.seed * 81.91 + time * 0.31) * 1.6;
  var next = source;
  next.pos = pos;
  next.prev = pos - vec2f(cos(vAngle), sin(vAngle)) * speed * 2.0;
  next.vel = vec2f(cos(vAngle), sin(vAngle)) * speed;
  next.life = 0.55 + hash11(source.seed * 19.7 + time * 0.41) * 0.45;
  next.tone = 0.2 + hash11(source.seed * 51.7 + time * 0.61) * 0.8;
  return next;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let index = gid.x;
  let particleCount = u32(params.values[4]);
  if (index >= particleCount) {
    return;
  }
  let width = max(params.values[0], 1.0);
  let height = max(params.values[1], 1.0);
  let time = params.values[5];
  let dt = clamp(params.values[6], 1.0 / 240.0, 0.05);
  let flowScale = params.values[7];
  let flowStrength = params.values[8];
  let damping = params.values[9];
  let maxSpeed = params.values[10];
  let evolutionSpeed = params.values[11];
  let center = vec2f(params.values[15], params.values[16]);
  let spawnRadius = params.values[17];
  let respawnRate = params.values[18];
  let brushActive = params.values[19] > 0.5;
  let guideCount = u32(params.values[20]);

  var particle = srcParticles[index];
  var flow = curlField(particle.pos, particle.seed, time * max(evolutionSpeed, 0.001), flowScale * 0.045);
  flow += vec2f(
    scalarField(particle.pos + vec2f(11.0, -7.0), particle.seed + 0.27, time * evolutionSpeed, flowScale * 0.022),
    scalarField(particle.pos + vec2f(-13.0, 9.0), particle.seed + 0.43, time * evolutionSpeed, flowScale * 0.022)
  ) * 0.18;

  var guideForce = vec2f(0.0, 0.0);
  for (var i = 0u; i < guideCount; i = i + 1u) {
    let guide = guides[i];
    let delta = guide.xy - particle.pos;
    let distance = length(delta);
    let radius = max(guide.w, 1.0);
    if (distance > radius || distance <= 1e-5) {
      continue;
    }
    let dir = delta / distance;
    let falloff = 1.0 - distance / radius;
    guideForce += dir * guide.z * falloff * falloff;
  }

  let fieldAccel = flow * flowStrength + guideForce * 0.55;
  var vel = particle.vel * damping + fieldAccel * (dt * 60.0);
  let speed = length(vel);
  if (speed > maxSpeed) {
    vel = vel / speed * maxSpeed;
  }

  var next = particle;
  next.prev = particle.pos;
  next.pos = particle.pos + vel * (dt * 60.0);
  next.vel = vel;
  next.life = particle.life - dt * (0.08 + respawnRate * 0.22);
  next.tone = clamp(particle.tone * 0.92 + speed / max(maxSpeed, 0.001) * 0.18 + flowStrength * 0.03, 0.0, 1.0);

  let reseedChance = respawnRate * (brushActive ? 0.22 : 0.06) * (dt * 60.0);
  let randomRespawn = hash11(particle.seed * 73.1 + f32(index) * 0.117 + time * 13.7) < reseedChance;
  let outside = next.pos.x < -4.0 || next.pos.x > width + 4.0 || next.pos.y < -4.0 || next.pos.y > height + 4.0;
  if (next.life <= 0.0 || outside || randomRespawn) {
    next = respawnParticle(next, index, width, height, center, spawnRadius, time);
  }

  dstParticles[index] = next;
}
`;
  }

  _fullscreenShader() {
    return `
struct VertexOutput {
  @builtin(position) position : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var pos = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0)
  );
  var out : VertexOutput;
  let p = pos[vertexIndex];
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
  return out;
}
`;
  }

  _fadeShader() {
    return `
struct Params {
  values : array<f32, ${PARAM_FLOATS}>,
};

@group(0) @binding(0) var uTex : texture_2d<f32>;
@group(0) @binding(1) var uSampler : sampler;
@group(0) @binding(2) var<storage, read> params : Params;

@fragment
fn fs_main(@location(0) uv : vec2f) -> @location(0) vec4f {
  let prev = textureSample(uTex, uSampler, uv);
  let fade = clamp(params.values[12], 0.0, 0.9995);
  return vec4f(prev.rgb * fade, prev.a * fade);
}
`;
  }

  _particleShader() {
    return `
struct Particle {
  pos : vec2f,
  prev : vec2f,
  vel : vec2f,
  seed : f32,
  life : f32,
  tone : f32,
  widthScale : f32,
};

struct Params {
  values : array<f32, ${PARAM_FLOATS}>,
};

struct VertexOutput {
  @builtin(position) position : vec4f,
  @location(0) local : vec2f,
  @location(1) tone : f32,
  @location(2) speed : f32,
  @location(3) seed : f32,
};

@group(0) @binding(0) var<storage, read> particles : array<Particle>;
@group(0) @binding(1) var<storage, read> params : Params;

fn palette(t : f32, seed : f32, speed : f32) -> vec3f {
  let primary = vec3f(params.values[22], params.values[23], params.values[24]);
  let secondary = vec3f(params.values[26], params.values[27], params.values[28]);
  let mode = i32(params.values[21]);
  if (mode == ${PALETTE_MODES.mono}) {
    let glow = clamp(0.25 + t * 0.75 + speed * 0.15, 0.0, 1.0);
    return mix(primary * 0.55, vec3f(1.0, 1.0, 1.0), glow * 0.45);
  }
  if (mode == ${PALETTE_MODES.prism}) {
    let phase = seed * 6.28318 + t * 4.0;
    let prism = vec3f(
      0.55 + 0.45 * cos(phase + 0.0),
      0.55 + 0.45 * cos(phase + 2.1),
      0.55 + 0.45 * cos(phase + 4.2)
    );
    return mix(primary * 0.35 + prism * 0.65, secondary * 0.25 + prism * 0.75, clamp(params.values[30], 0.0, 1.0));
  }
  return mix(primary, secondary, clamp(t * 0.8 + seed * 0.2, 0.0, 1.0));
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32, @builtin(instance_index) instanceIndex : u32) -> VertexOutput {
  let particle = particles[instanceIndex];
  let dpr = max(params.values[31], 1.0);
  let renderWidth = max(params.values[2], 1.0);
  let renderHeight = max(params.values[3], 1.0);
  let segmentWidth = max(params.values[13], 0.4) * particle.widthScale;
  let segmentLength = max(params.values[14], 2.0);

  var quad = array<vec2f, 6>(
    vec2f(0.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(0.0,  1.0),
    vec2f(0.0,  1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0,  1.0)
  );
  let local = quad[vertexIndex];
  let delta = particle.pos - particle.prev;
  let speed = length(delta);
  let dir = select(normalize(vec2f(1.0, 0.0)), normalize(delta), speed > 1e-4);
  let normal = vec2f(-dir.y, dir.x);
  let head = particle.pos;
  let tail = particle.pos - dir * max(segmentLength, speed * 8.0);
  let center = mix(tail, head, local.x);
  let pos = center + normal * ((local.y * 0.5) * segmentWidth);
  let posPx = pos * dpr;
  let clipX = (posPx.x / renderWidth) * 2.0 - 1.0;
  let clipY = 1.0 - (posPx.y / renderHeight) * 2.0;

  var out : VertexOutput;
  out.position = vec4f(clipX, clipY, 0.0, 1.0);
  out.local = local;
  out.tone = particle.tone;
  out.speed = speed;
  out.seed = particle.seed;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4f {
  let across = 1.0 - smoothstep(0.0, 1.0, abs(input.local.y));
  let along = smoothstep(0.0, 0.35, input.local.x) * (1.0 - smoothstep(0.72, 1.0, input.local.x));
  let alpha = across * along * params.values[25];
  if (alpha <= 0.001) {
    discard;
  }
  let speedTone = clamp(input.speed * 0.22, 0.0, 1.0);
  let color = palette(clamp(input.tone * 0.7 + speedTone * 0.3, 0.0, 1.0), input.seed, speedTone);
  return vec4f(color, alpha);
}
`;
  }

  _presentShader() {
    return `
@group(0) @binding(0) var uTex : texture_2d<f32>;
@group(0) @binding(1) var uSampler : sampler;

@fragment
fn fs_main(@location(0) uv : vec2f) -> @location(0) vec4f {
  return textureSample(uTex, uSampler, uv);
}
`;
  }
}
