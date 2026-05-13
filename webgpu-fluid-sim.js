// These constants are baked into the WGSL source below; changing them requires
// the compute pipelines and backing buffer sizes to stay in sync.
const CELL_STRIDE = 14;
const META_FLOATS = 16;
const PARAM_FLOATS = 32;
const MAX_EMITTERS = 256;
const MAX_INFLUENCES = 256;
const MAX_SCALAR_FIELDS = 128;
const BYTES_PER_F32 = 4;
const WORKGROUP_SIZE = 64;
const DEFAULT_STATS_INTERVAL = 2;
const MIN_INTERNAL_WIDTH = 48;
const MIN_INTERNAL_HEIGHT = 36;

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _packColor(color) {
  if (!color) return { r: 0, g: 0, b: 0, a: 0 };
  if (Array.isArray(color)) {
    return {
      r: Number(color[0] ?? 0),
      g: Number(color[1] ?? 0),
      b: Number(color[2] ?? 0),
      a: Number(color[3] ?? 1),
    };
  }
  return {
    r: Number(color.r ?? 0),
    g: Number(color.g ?? 0),
    b: Number(color.b ?? 0),
    a: Number(color.a ?? 1),
  };
}

function _targetSize(displayWidth, displayHeight, params = {}) {
  const resolutionScale = Math.max(0.25, Number(params.resolutionScale) || 1);
  const fluidScale = Math.max(0.4, Number(params.fluidScale) || 1);
  return {
    width: Math.max(MIN_INTERNAL_WIDTH, Math.round((displayWidth * resolutionScale) / fluidScale)),
    height: Math.max(MIN_INTERNAL_HEIGHT, Math.round((displayHeight * resolutionScale) / fluidScale)),
  };
}

function _scaleImageDataViaCanvas(imageData, width, height, sourceCanvas, sourceCtx, targetCanvas, targetCtx) {
  sourceCanvas.width = imageData.width;
  sourceCanvas.height = imageData.height;
  sourceCtx.putImageData(imageData, 0, 0);
  targetCanvas.width = width;
  targetCanvas.height = height;
  targetCtx.clearRect(0, 0, width, height);
  targetCtx.drawImage(sourceCanvas, 0, 0, width, height);
  return targetCtx.getImageData(0, 0, width, height);
}

function _packEmitters(records = []) {
  const packed = new Float32Array(MAX_EMITTERS * 12);
  const count = Math.min(MAX_EMITTERS, records.length);
  for (let i = 0; i < count; i += 1) {
    const emitter = records[i] || {};
    const base = i * 12;
    const color = _packColor(emitter.pigmentColor || emitter.color || emitter.pigment);
    packed[base + 0] = Number(emitter.sourceType ?? emitter.type ?? 0);
    packed[base + 1] = Number(emitter.x ?? 0);
    packed[base + 2] = Number(emitter.y ?? 0);
    packed[base + 3] = Number(emitter.vx ?? emitter.velocityX ?? 0);
    packed[base + 4] = Number(emitter.vy ?? emitter.velocityY ?? 0);
    packed[base + 5] = Math.max(0, Number(emitter.radius ?? 0));
    packed[base + 6] = Number(emitter.strength ?? emitter.volume ?? 0);
    packed[base + 7] = Number(emitter.alpha ?? color.a ?? 1);
    packed[base + 8] = Number(color.r ?? 0);
    packed[base + 9] = Number(color.g ?? 0);
    packed[base + 10] = Number(color.b ?? 0);
    packed[base + 11] = Number(emitter.modeFlags ?? emitter.mode ?? 0);
  }
  return { packed, count };
}

function _packInfluences(records = []) {
  const packed = new Float32Array(MAX_INFLUENCES * 12);
  const count = Math.min(MAX_INFLUENCES, records.length);
  for (let i = 0; i < count; i += 1) {
    const influence = records[i] || {};
    const base = i * 12;
    const color = _packColor(influence.pigmentColor || influence.color || influence.pigment);
    packed[base + 0] = Number(influence.sourceType ?? influence.type ?? 0);
    packed[base + 1] = Number(influence.x ?? 0);
    packed[base + 2] = Number(influence.y ?? 0);
    packed[base + 3] = Number(influence.vx ?? influence.directionX ?? 0);
    packed[base + 4] = Number(influence.vy ?? influence.directionY ?? 0);
    packed[base + 5] = Math.max(0, Number(influence.radius ?? 0));
    packed[base + 6] = Number(influence.strength ?? 0);
    packed[base + 7] = Number(influence.alpha ?? color.a ?? 0);
    packed[base + 8] = Number(color.r ?? 0);
    packed[base + 9] = Number(color.g ?? 0);
    packed[base + 10] = Number(color.b ?? 0);
    packed[base + 11] = Number(influence.modeFlags ?? influence.mode ?? 0);
  }
  return { packed, count };
}

function _packScalarFields(records = []) {
  const packed = new Float32Array(MAX_SCALAR_FIELDS * 12);
  const count = Math.min(MAX_SCALAR_FIELDS, records.length);
  for (let i = 0; i < count; i += 1) {
    const field = records[i] || {};
    const base = i * 12;
    packed[base + 0] = Number(field.sourceType ?? field.type ?? 0);
    packed[base + 1] = Number(field.x ?? 0);
    packed[base + 2] = Number(field.y ?? 0);
    packed[base + 3] = Math.max(0, Number(field.radius ?? 0));
    packed[base + 4] = Number(field.strength ?? 0);
    packed[base + 5] = Number(field.alpha ?? 1);
    packed[base + 6] = Number(field.value0 ?? field.drag ?? 0);
    packed[base + 7] = Number(field.value1 ?? field.directionX ?? 0);
    packed[base + 8] = Number(field.value2 ?? field.directionY ?? 0);
    packed[base + 9] = Number(field.value3 ?? field.capacity ?? 0);
    packed[base + 10] = Number(field.modeFlags ?? field.mode ?? 0);
    packed[base + 11] = Number(field.falloff ?? 1);
  }
  return { packed, count };
}

function _createMetaArray(meta = {}) {
  const packed = new Float32Array(META_FLOATS);
  packed[0] = Number(meta.width ?? 1);
  packed[1] = Number(meta.height ?? 1);
  packed[2] = Number(meta.displayWidth ?? 1);
  packed[3] = Number(meta.displayHeight ?? 1);
  packed[4] = Number(meta.dt ?? 1 / 60);
  packed[5] = Number(meta.emitterCount ?? 0);
  packed[6] = Number(meta.influenceCount ?? 0);
  packed[7] = Number(meta.scalarFieldCount ?? 0);
  packed[8] = Number(meta.frameIndex ?? 0);
  packed[9] = Number(meta.renderMode ?? 0);
  packed[10] = Number(meta.hasMask ? 1 : 0);
  packed[11] = Number(meta.debug ? 1 : 0);
  return packed;
}

function _createParamsArray(params = {}) {
  const packed = new Float32Array(PARAM_FLOATS);
  packed[0] = Number(params.emissionRate ?? 0.8);
  packed[1] = Number(params.emitterStrength ?? 1.0);
  packed[2] = Number(params.emitterVelocity ?? 0.7);
  packed[3] = Number(params.pressureResponse ?? 0.6);
  packed[4] = Number(params.momentumRetention ?? 0.82);
  packed[5] = Number(params.velocityDiffuse ?? 0.2);
  packed[6] = Number(params.drag ?? 0.12);
  packed[7] = Number(params.thicknessDecay ?? 0.02);
  packed[8] = Number(params.pigmentDiffusion ?? 0.1);
  packed[9] = Number(params.pressureFade ?? 0.06);
  packed[10] = Number(params.settleThreshold ?? 0.02);
  packed[11] = Number(params.terrainWeight ?? 0.25);
  packed[12] = Number(params.scalarFieldInfluence ?? 0.5);
  packed[13] = Number(params.influenceStrength ?? 0.8);
  packed[14] = Number(params.influenceRadius ?? 0.5);
  packed[15] = Number(params.maxVelocity ?? 1.8);
  packed[16] = Number(params.thicknessFloor ?? 0.001);
  packed[17] = Number(params.commitOpacityScale ?? 1);
  packed[18] = Number(params.previewBoost ?? 1);
  packed[19] = Number(params.occupancyBias ?? 0.08);
  return packed;
}

export class WebGPUFluidSim {
  static async create(displayWidth, displayHeight, params = {}) {
    const sim = new WebGPUFluidSim(displayWidth, displayHeight, params);
    await sim.init();
    return sim;
  }

  constructor(displayWidth, displayHeight, params = {}) {
    this.displayWidth = Math.max(1, displayWidth || 1);
    this.displayHeight = Math.max(1, displayHeight || 1);
    this.params = { ...params };
    const next = _targetSize(this.displayWidth, this.displayHeight, this.params);
    this.internalWidth = next.width;
    this.internalHeight = next.height;
    this.adapter = null;
    this.device = null;
    this.ready = false;
    this.failed = false;
    this.unavailableReason = '';
    this._sourceCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    this._sourceCtx = this._sourceCanvas?.getContext('2d', { willReadFrequently: true }) || null;
    this._targetCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    this._targetCtx = this._targetCanvas?.getContext('2d', { willReadFrequently: true }) || null;
    this._maskAlpha = new Uint8Array(this.internalWidth * this.internalHeight);
    this._hasMask = false;
    this._pendingEmitters = [];
    this._pendingInfluences = [];
    this._pendingScalarFields = [];
    this._frameIndex = 0;
    this._activeBufferIndex = 0;
    this._statsEvery = DEFAULT_STATS_INTERVAL;
    this._statsCounter = 0;
    this._statsReadbackPending = false;
    this._lastStats = { activeCells: 0, occupiedRatio: 0, maxPressure: 0, maxThickness: 0, averageVelocity: 0 };
    this._lastParticleView = [];
    this._renderModeIndex = 0;
    this._cellBuffers = [];
    this._cellBindGroups = [];
    this._injectPipeline = null;
    this._dynamicsPipeline = null;
    this._transportPipeline = null;
    this._maskBuffer = null;
    this._paramsBuffer = null;
    this._metaBuffer = null;
    this._emitterBuffer = null;
    this._influenceBuffer = null;
    this._scalarFieldBuffer = null;
    this._statsReadBuffer = null;
    this._initPromise = null;
  }

  async init() {
    if (this.ready) return true;
    if (this.failed) throw new Error(this.unavailableReason || 'WebGPU fluid sim unavailable');
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      this.failed = true;
      this.unavailableReason = 'navigator.gpu unavailable';
      throw new Error(this.unavailableReason);
    }
    this.adapter = await navigator.gpu.requestAdapter();
    if (!this.adapter) {
      this.failed = true;
      this.unavailableReason = 'WebGPU adapter unavailable';
      throw new Error(this.unavailableReason);
    }
    this.device = await this.adapter.requestDevice();
    this._createPipelines();
    this._rebuildResources();
    this.ready = true;
    return true;
  }

  _createPipelines() {
    const shader = this.device.createShaderModule({ code: this._shaderCode() });
    this._injectPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: shader, entryPoint: 'inject_main' },
    });
    this._dynamicsPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: shader, entryPoint: 'dynamics_main' },
    });
    this._transportPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: shader, entryPoint: 'transport_main' },
    });
  }

  _cellBufferByteLength() {
    return this.internalWidth * this.internalHeight * CELL_STRIDE * BYTES_PER_F32;
  }

  _rebuildResources() {
    this._cellBuffers.forEach(buffer => buffer?.destroy?.());
    this._maskBuffer?.destroy?.();
    this._paramsBuffer?.destroy?.();
    this._metaBuffer?.destroy?.();
    this._emitterBuffer?.destroy?.();
    this._influenceBuffer?.destroy?.();
    this._scalarFieldBuffer?.destroy?.();
    this._statsReadBuffer?.destroy?.();
    this._cellBindGroups = [];
    const cellBytes = this._cellBufferByteLength();
    this._cellBuffers = [
      this.device.createBuffer({ size: cellBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }),
      this.device.createBuffer({ size: cellBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }),
    ];
    this._maskBuffer = this.device.createBuffer({
      size: Math.max(4, this.internalWidth * this.internalHeight * BYTES_PER_F32),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._paramsBuffer = this.device.createBuffer({ size: PARAM_FLOATS * BYTES_PER_F32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._metaBuffer = this.device.createBuffer({ size: META_FLOATS * BYTES_PER_F32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._emitterBuffer = this.device.createBuffer({ size: MAX_EMITTERS * 12 * BYTES_PER_F32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._influenceBuffer = this.device.createBuffer({ size: MAX_INFLUENCES * 12 * BYTES_PER_F32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._scalarFieldBuffer = this.device.createBuffer({ size: MAX_SCALAR_FIELDS * 12 * BYTES_PER_F32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._statsReadBuffer = this.device.createBuffer({ size: cellBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this._cellBindGroups = [this._createBindGroup(0, 1), this._createBindGroup(1, 0)];
    this._activeBufferIndex = 0;
    this._frameIndex = 0;
    this._writeMaskBuffer();
    this.clearState();
  }

  _createBindGroup(inputIndex, outputIndex) {
    return this.device.createBindGroup({
      layout: this._injectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._cellBuffers[inputIndex] } },
        { binding: 1, resource: { buffer: this._cellBuffers[outputIndex] } },
        { binding: 2, resource: { buffer: this._paramsBuffer } },
        { binding: 3, resource: { buffer: this._metaBuffer } },
        { binding: 4, resource: { buffer: this._emitterBuffer } },
        { binding: 5, resource: { buffer: this._influenceBuffer } },
        { binding: 6, resource: { buffer: this._scalarFieldBuffer } },
        { binding: 7, resource: { buffer: this._maskBuffer } },
      ],
    });
  }

  updateParams(params = {}) {
    this.params = { ...this.params, ...params };
    const next = _targetSize(this.displayWidth, this.displayHeight, this.params);
    const needsResize = next.width !== this.internalWidth || next.height !== this.internalHeight;
    this._renderModeIndex = ['volume', 'pressure', 'pigment'].indexOf(this.params.renderMode);
    if (needsResize && this.ready) {
      this.internalWidth = next.width;
      this.internalHeight = next.height;
      this._maskAlpha = new Uint8Array(this.internalWidth * this.internalHeight);
      this._rebuildResources();
    }
  }

  setDisplaySize(displayWidth, displayHeight) {
    this.displayWidth = Math.max(1, displayWidth || 1);
    this.displayHeight = Math.max(1, displayHeight || 1);
    this.updateParams(this.params);
  }

  setMask(imageData) {
    if (!imageData || !this._sourceCanvas || !this._sourceCtx || !this._targetCanvas || !this._targetCtx) {
      this._maskAlpha = new Uint8Array(this.internalWidth * this.internalHeight);
      this._hasMask = false;
      if (this.ready) this._writeMaskBuffer();
      return;
    }
    const scaled = _scaleImageDataViaCanvas(imageData, this.internalWidth, this.internalHeight, this._sourceCanvas, this._sourceCtx, this._targetCanvas, this._targetCtx);
    this._maskAlpha = new Uint8Array(this.internalWidth * this.internalHeight);
    this._hasMask = false;
    for (let i = 0; i < this._maskAlpha.length; i += 1) {
      const alpha = scaled.data[i * 4 + 3];
      this._maskAlpha[i] = alpha;
      if (alpha > 8) this._hasMask = true;
    }
    if (this.ready) this._writeMaskBuffer();
  }

  _writeMaskBuffer() {
    const packed = new Float32Array(this._maskAlpha.length);
    for (let i = 0; i < this._maskAlpha.length; i += 1) packed[i] = this._maskAlpha[i] / 255;
    this.device.queue.writeBuffer(this._maskBuffer, 0, packed.buffer, packed.byteOffset, packed.byteLength);
  }

  submitEmitters(records = []) {
    this._pendingEmitters.push(...records.map(record => ({ ...record })));
  }

  submitInfluences(records = []) {
    this._pendingInfluences.push(...records.map(record => ({ ...record })));
  }

  submitScalarFields(records = []) {
    this._pendingScalarFields.push(...records.map(record => ({ ...record })));
  }

  clearInteractionState() {
    this._pendingEmitters = [];
    this._pendingInfluences = [];
    this._pendingScalarFields = [];
  }

  clearState() {
    if (!this.ready) return;
    const zero = new Float32Array(this.internalWidth * this.internalHeight * CELL_STRIDE);
    this.device.queue.writeBuffer(this._cellBuffers[0], 0, zero.buffer, zero.byteOffset, zero.byteLength);
    this.device.queue.writeBuffer(this._cellBuffers[1], 0, zero.buffer, zero.byteOffset, zero.byteLength);
    this._statsReadbackPending = false;
    this._lastStats = { activeCells: 0, occupiedRatio: 0, maxPressure: 0, maxThickness: 0, averageVelocity: 0 };
    this._lastParticleView = [];
    this.clearInteractionState();
  }

  step(dt = 1 / 60, { captureStats = true } = {}) {
    if (!this.ready) return;
    const emitterPack = _packEmitters(this._pendingEmitters);
    const influencePack = _packInfluences(this._pendingInfluences);
    const scalarPack = _packScalarFields(this._pendingScalarFields);
    const meta = _createMetaArray({
      width: this.internalWidth,
      height: this.internalHeight,
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
      dt: Math.min(0.05, Math.max(1 / 240, Number(dt) || 1 / 60)),
      emitterCount: emitterPack.count,
      influenceCount: influencePack.count,
      scalarFieldCount: scalarPack.count,
      frameIndex: this._frameIndex,
      renderMode: this._renderModeIndex < 0 ? 0 : this._renderModeIndex,
      hasMask: this._hasMask,
    });
    const params = _createParamsArray(this.params);
    this.device.queue.writeBuffer(this._metaBuffer, 0, meta.buffer, meta.byteOffset, meta.byteLength);
    this.device.queue.writeBuffer(this._paramsBuffer, 0, params.buffer, params.byteOffset, params.byteLength);
    if (emitterPack.count > 0) this.device.queue.writeBuffer(this._emitterBuffer, 0, emitterPack.packed.buffer, emitterPack.packed.byteOffset, emitterPack.packed.byteLength);
    if (influencePack.count > 0) this.device.queue.writeBuffer(this._influenceBuffer, 0, influencePack.packed.buffer, influencePack.packed.byteOffset, influencePack.packed.byteLength);
    if (scalarPack.count > 0) this.device.queue.writeBuffer(this._scalarFieldBuffer, 0, scalarPack.packed.buffer, scalarPack.packed.byteOffset, scalarPack.packed.byteLength);

    const workgroups = Math.ceil((this.internalWidth * this.internalHeight) / WORKGROUP_SIZE);
    const encoder = this.device.createCommandEncoder();
    const bindGroup = this._cellBindGroups[this._activeBufferIndex];
    let pass = encoder.beginComputePass();
    pass.setPipeline(this._injectPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    pass = encoder.beginComputePass();
    pass.setPipeline(this._dynamicsPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    pass = encoder.beginComputePass();
    pass.setPipeline(this._transportPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    const outputIndex = 1 - this._activeBufferIndex;
    if (captureStats && !this._statsReadbackPending && (this._statsCounter % this._statsEvery) === 0) {
      encoder.copyBufferToBuffer(this._cellBuffers[outputIndex], 0, this._statsReadBuffer, 0, this._cellBufferByteLength());
    }
    this.device.queue.submit([encoder.finish()]);
    this._activeBufferIndex = outputIndex;
    this._frameIndex += 1;
    this._statsCounter += 1;
    this.clearInteractionState();
    if (captureStats && !this._statsReadbackPending && (this._statsCounter % this._statsEvery) === 1) this._scheduleStatsReadback();
  }

  _scheduleStatsReadback() {
    if (!this._statsReadBuffer || this._statsReadbackPending) return;
    this._statsReadbackPending = true;
    this._statsReadBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const view = new Float32Array(this._statsReadBuffer.getMappedRange());
      const stats = { activeCells: 0, occupiedRatio: 0, maxPressure: 0, maxThickness: 0, averageVelocity: 0 };
      const particles = [];
      const totalCells = this.internalWidth * this.internalHeight;
      for (let i = 0; i < totalCells; i += 1) {
        const base = i * CELL_STRIDE;
        const thickness = view[base + 1] || 0;
        const pressure = Math.abs(view[base + 2] || 0);
        const vx = view[base + 3] || 0;
        const vy = view[base + 4] || 0;
        const occupancy = view[base + 9] || 0;
        if (thickness > 0.002 || occupancy > 0.02) {
          stats.activeCells += 1;
          stats.maxThickness = Math.max(stats.maxThickness, thickness);
          stats.maxPressure = Math.max(stats.maxPressure, pressure);
          stats.averageVelocity += Math.hypot(vx, vy);
          if (particles.length < 2048) {
            const x = i % this.internalWidth;
            const y = Math.floor(i / this.internalWidth);
            particles.push({
              x: ((x + 0.5) / this.internalWidth) * this.displayWidth,
              y: ((y + 0.5) / this.internalHeight) * this.displayHeight,
              vx: (vx / this.internalWidth) * this.displayWidth,
              vy: (vy / this.internalHeight) * this.displayHeight,
              thickness,
              pressure,
            });
          }
        }
      }
      stats.occupiedRatio = totalCells > 0 ? stats.activeCells / totalCells : 0;
      stats.averageVelocity = stats.activeCells > 0 ? stats.averageVelocity / stats.activeCells : 0;
      this._lastStats = stats;
      this._lastParticleView = particles;
      this._statsReadBuffer.unmap();
      this._statsReadbackPending = false;
    }).catch(() => {
      try { this._statsReadBuffer.unmap(); } catch {}
      this._statsReadbackPending = false;
    });
  }

  getParticleCount() {
    return this._lastStats.activeCells || 0;
  }

  getParticles() {
    return this._lastParticleView.slice();
  }

  getRenderSize() {
    return { width: this.internalWidth, height: this.internalHeight };
  }

  getRenderState() {
    return {
      buffer: this._cellBuffers[this._activeBufferIndex],
      width: this.internalWidth,
      height: this.internalHeight,
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
      params: { ...this.params },
      stats: { ...this._lastStats },
    };
  }

  getDebugState() {
    return {
      ready: this.ready,
      failed: this.failed,
      unavailableReason: this.unavailableReason,
      internalWidth: this.internalWidth,
      internalHeight: this.internalHeight,
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
      stats: { ...this._lastStats },
      pendingEmitters: this._pendingEmitters.length,
      pendingInfluences: this._pendingInfluences.length,
      pendingScalarFields: this._pendingScalarFields.length,
      frameIndex: this._frameIndex,
    };
  }

  destroy() {
    this.ready = false;
    this.failed = false;
    this.adapter = null;
    this.device = null;
    this._cellBuffers = [];
    this._cellBindGroups = [];
    this._injectPipeline = null;
    this._dynamicsPipeline = null;
    this._transportPipeline = null;
    this._maskBuffer = null;
    this._paramsBuffer = null;
    this._metaBuffer = null;
    this._emitterBuffer = null;
    this._influenceBuffer = null;
    this._scalarFieldBuffer = null;
    this._statsReadBuffer = null;
    this._lastParticleView = [];
  }

  _shaderCode() {
    return `
const CELL_STRIDE : u32 = ${CELL_STRIDE}u;
const MAX_EMITTERS : u32 = ${MAX_EMITTERS}u;
const MAX_INFLUENCES : u32 = ${MAX_INFLUENCES}u;
const MAX_SCALAR_FIELDS : u32 = ${MAX_SCALAR_FIELDS}u;

struct ParamsBuffer {
  values : array<f32, ${PARAM_FLOATS}>,
};

struct MetaBuffer {
  values : array<f32, ${META_FLOATS}>,
};

@group(0) @binding(0) var<storage, read> inCells : array<f32>;
@group(0) @binding(1) var<storage, read_write> outCells : array<f32>;
@group(0) @binding(2) var<storage, read> params : ParamsBuffer;
@group(0) @binding(3) var<uniform> meta : MetaBuffer;
@group(0) @binding(4) var<storage, read> emitters : array<f32>;
@group(0) @binding(5) var<storage, read> influences : array<f32>;
@group(0) @binding(6) var<storage, read> scalarFields : array<f32>;
@group(0) @binding(7) var<storage, read> maskAlpha : array<f32>;

fn width() -> u32 { return u32(max(meta.values[0], 1.0)); }
fn height() -> u32 { return u32(max(meta.values[1], 1.0)); }
fn displayWidth() -> f32 { return max(meta.values[2], 1.0); }
fn displayHeight() -> f32 { return max(meta.values[3], 1.0); }
fn dt() -> f32 { return max(meta.values[4], 0.0001); }
fn emitterCount() -> u32 { return u32(max(meta.values[5], 0.0)); }
fn influenceCount() -> u32 { return u32(max(meta.values[6], 0.0)); }
fn scalarFieldCount() -> u32 { return u32(max(meta.values[7], 0.0)); }
fn hasMask() -> bool { return meta.values[10] > 0.5; }

fn idx(cell : u32, field : u32) -> u32 { return cell * CELL_STRIDE + field; }
fn readCell(cell : u32, field : u32) -> f32 { return inCells[idx(cell, field)]; }
fn writeCell(cell : u32, field : u32, value : f32) { outCells[idx(cell, field)] = value; }

fn clampCellCoord(v : i32, upper : u32) -> u32 {
  if (v < 0) { return 0u; }
  let u = u32(v);
  if (u >= upper) { return upper - 1u; }
  return u;
}

fn cellIndex(x : u32, y : u32) -> u32 { return y * width() + x; }

fn cellPositionPx(x : u32, y : u32) -> vec2f {
  return vec2f(
    (f32(x) + 0.5) / f32(width()) * displayWidth(),
    (f32(y) + 0.5) / f32(height()) * displayHeight(),
  );
}

fn emitterAt(index : u32, field : u32) -> f32 { return emitters[index * 12u + field]; }
fn influenceAt(index : u32, field : u32) -> f32 { return influences[index * 12u + field]; }
fn scalarFieldAt(index : u32, field : u32) -> f32 { return scalarFields[index * 12u + field]; }

fn maskForCell(cell : u32) -> f32 {
  if (!hasMask()) { return 1.0; }
  return 1.0 - clamp(maskAlpha[cell], 0.0, 1.0);
}

fn loadCellState(cell : u32) -> array<f32, ${CELL_STRIDE}> {
  var state : array<f32, ${CELL_STRIDE}>;
  for (var i : u32 = 0u; i < CELL_STRIDE; i = i + 1u) {
    state[i] = readCell(cell, i);
  }
  return state;
}

fn storeCellState(cell : u32, state : array<f32, ${CELL_STRIDE}>) {
  for (var i : u32 = 0u; i < CELL_STRIDE; i = i + 1u) {
    writeCell(cell, i, state[i]);
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn inject_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let total = width() * height();
  let cell = gid.x;
  if (cell >= total) { return; }
  let x = cell % width();
  let y = cell / width();
  let pos = cellPositionPx(x, y);
  var state = loadCellState(cell);
  let maskFactor = maskForCell(cell);
  if (maskFactor <= 0.001) {
    state[1] = 0.0;
    state[2] = 0.0;
    state[3] = 0.0;
    state[4] = 0.0;
    state[5] = 0.0;
    state[6] = 0.0;
    state[7] = 0.0;
    state[8] = 0.0;
    state[9] = 0.0;
    state[10] = 1.0;
    state[11] = 0.0;
    storeCellState(cell, state);
    return;
  }
  state[10] = max(state[10], 1.0 - maskFactor);
  for (var i : u32 = 0u; i < emitterCount() && i < MAX_EMITTERS; i = i + 1u) {
    let dx = emitterAt(i, 1u) - pos.x;
    let dy = emitterAt(i, 2u) - pos.y;
    let radius = max(emitterAt(i, 5u), 0.001);
    let dist = length(vec2f(dx, dy));
    if (dist > radius) { continue; }
    let falloff = 1.0 - dist / radius;
    let strength = emitterAt(i, 6u) * params.values[0] * params.values[1] * falloff * maskFactor;
    state[1] = max(0.0, state[1] + strength * dt());
    state[2] = state[2] + strength * params.values[3] * 0.45;
    state[3] = state[3] + emitterAt(i, 3u) * params.values[2] * falloff * dt();
    state[4] = state[4] + emitterAt(i, 4u) * params.values[2] * falloff * dt();
    let alpha = clamp(emitterAt(i, 7u), 0.0, 1.0);
    let pigmentMix = alpha * falloff;
    let nextAlpha = clamp(state[8] + pigmentMix * (1.0 - state[8]), 0.0, 1.0);
    state[5] = mix(state[5], emitterAt(i, 8u) / 255.0, pigmentMix);
    state[6] = mix(state[6], emitterAt(i, 9u) / 255.0, pigmentMix);
    state[7] = mix(state[7], emitterAt(i, 10u) / 255.0, pigmentMix);
    state[8] = nextAlpha;
    state[9] = clamp(max(state[9], state[1] * 0.5 + params.values[19]), 0.0, 1.0);
  }
  for (var i : u32 = 0u; i < influenceCount() && i < MAX_INFLUENCES; i = i + 1u) {
    let dx = influenceAt(i, 1u) - pos.x;
    let dy = influenceAt(i, 2u) - pos.y;
    let radius = max(influenceAt(i, 5u), 0.001);
    let dist = length(vec2f(dx, dy));
    if (dist > radius) { continue; }
    let falloff = pow(1.0 - dist / radius, 1.5);
    let strength = influenceAt(i, 6u) * params.values[13] * falloff * maskFactor;
    state[3] = state[3] + influenceAt(i, 3u) * strength * dt();
    state[4] = state[4] + influenceAt(i, 4u) * strength * dt();
    state[2] = state[2] + strength * 0.15;
    if (influenceAt(i, 7u) > 0.001) {
      let pigmentMix = influenceAt(i, 7u) * falloff * 0.35;
      state[5] = mix(state[5], influenceAt(i, 8u) / 255.0, pigmentMix);
      state[6] = mix(state[6], influenceAt(i, 9u) / 255.0, pigmentMix);
      state[7] = mix(state[7], influenceAt(i, 10u) / 255.0, pigmentMix);
      state[8] = clamp(max(state[8], pigmentMix), 0.0, 1.0);
    }
  }
  for (var i : u32 = 0u; i < scalarFieldCount() && i < MAX_SCALAR_FIELDS; i = i + 1u) {
    let dx = scalarFieldAt(i, 1u) - pos.x;
    let dy = scalarFieldAt(i, 2u) - pos.y;
    let radius = max(scalarFieldAt(i, 3u), 0.001);
    let dist = length(vec2f(dx, dy));
    if (dist > radius) { continue; }
    let falloff = pow(1.0 - dist / radius, max(0.25, scalarFieldAt(i, 11u)));
    let strength = scalarFieldAt(i, 4u) * params.values[12] * falloff;
    state[10] = clamp(state[10] + scalarFieldAt(i, 6u) * strength, 0.0, 1.0);
    state[11] = clamp(max(state[11], scalarFieldAt(i, 9u) * strength), 0.0, 1.0);
    state[3] = state[3] + scalarFieldAt(i, 7u) * strength * 0.12;
    state[4] = state[4] + scalarFieldAt(i, 8u) * strength * 0.12;
  }
  storeCellState(cell, state);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn dynamics_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let total = width() * height();
  let cell = gid.x;
  if (cell >= total) { return; }
  let x = cell % width();
  let y = cell / width();
  var state = loadCellState(cell);
  let xm = clampCellCoord(i32(x) - 1, width());
  let xp = clampCellCoord(i32(x) + 1, width());
  let ym = clampCellCoord(i32(y) - 1, height());
  let yp = clampCellCoord(i32(y) + 1, height());
  let left = cellIndex(xm, y);
  let right = cellIndex(xp, y);
  let up = cellIndex(x, ym);
  let down = cellIndex(x, yp);
  let thicknessL = readCell(left, 1u);
  let thicknessR = readCell(right, 1u);
  let thicknessU = readCell(up, 1u);
  let thicknessD = readCell(down, 1u);
  let pressureL = readCell(left, 2u);
  let pressureR = readCell(right, 2u);
  let pressureU = readCell(up, 2u);
  let pressureD = readCell(down, 2u);
  let vxAvg = (readCell(left, 3u) + readCell(right, 3u) + readCell(up, 3u) + readCell(down, 3u)) * 0.25;
  let vyAvg = (readCell(left, 4u) + readCell(right, 4u) + readCell(up, 4u) + readCell(down, 4u)) * 0.25;
  let terrainGradientX = readCell(right, 10u) - readCell(left, 10u);
  let terrainGradientY = readCell(down, 10u) - readCell(up, 10u);
  let div = (readCell(right, 3u) - readCell(left, 3u) + readCell(down, 4u) - readCell(up, 4u)) * 0.5;
  let pressureGradientX = (pressureR - pressureL) * 0.5 + (thicknessR - thicknessL) * params.values[3];
  let pressureGradientY = (pressureD - pressureU) * 0.5 + (thicknessD - thicknessU) * params.values[3];
  var vx = mix(state[3], vxAvg, params.values[5]);
  var vy = mix(state[4], vyAvg, params.values[5]);
  vx = (vx - pressureGradientX * 0.12 - terrainGradientX * params.values[11]) * params.values[4];
  vy = (vy - pressureGradientY * 0.12 - terrainGradientY * params.values[11]) * params.values[4];
  let drag = clamp(params.values[6] + state[11] * 0.3, 0.0, 0.98);
  vx = vx * (1.0 - drag * dt());
  vy = vy * (1.0 - drag * dt());
  let maxVelocity = max(params.values[15], 0.01);
  let speed = length(vec2f(vx, vy));
  if (speed > maxVelocity) {
    let scaled = normalize(vec2f(vx, vy)) * maxVelocity;
    vx = scaled.x;
    vy = scaled.y;
  }
  state[2] = max(0.0, state[2] + div * params.values[3] - params.values[9] * dt());
  state[3] = vx;
  state[4] = vy;
  state[1] = max(0.0, state[1] - params.values[7] * dt());
  if (state[1] < params.values[16] && speed < params.values[10]) {
    state[1] = max(0.0, state[1] - params.values[7] * 0.5 * dt());
    state[9] = max(0.0, state[9] - params.values[7] * dt() * 2.0);
  }
  storeCellState(cell, state);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn transport_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let total = width() * height();
  let cell = gid.x;
  if (cell >= total) { return; }
  let x = cell % width();
  let y = cell / width();
  var state = loadCellState(cell);
  let srcX = clampCellCoord(i32(round(f32(x) - state[3])), width());
  let srcY = clampCellCoord(i32(round(f32(y) - state[4])), height());
  let src = cellIndex(srcX, srcY);
  let carry = clamp(params.values[8], 0.0, 1.0);
  let srcThickness = readCell(src, 1u);
  let srcPressure = readCell(src, 2u);
  let srcOccupancy = readCell(src, 9u);
  state[1] = mix(state[1], srcThickness, carry);
  state[2] = mix(state[2], srcPressure, carry * 0.55);
  state[5] = mix(state[5], readCell(src, 5u), carry);
  state[6] = mix(state[6], readCell(src, 6u), carry);
  state[7] = mix(state[7], readCell(src, 7u), carry);
  state[8] = clamp(mix(state[8], readCell(src, 8u), carry), 0.0, 1.0);
  state[9] = clamp(max(srcOccupancy, state[1] * 0.5), 0.0, 1.0);
  if (state[1] <= params.values[16] && length(vec2f(state[3], state[4])) < params.values[10]) {
    state[3] = 0.0;
    state[4] = 0.0;
    state[2] = max(0.0, state[2] - params.values[9] * dt());
  }
  storeCellState(cell, state);
}
`;
  }
}
