const DEFAULT_COMPOSITE_OPERATION = 'source-over';
const GPU_INTEROP_PROBE_ALPHA_MIN = 24;
const GPU_INTEROP_PROBE_RED_MIN = 24;

export class WebGPUFluidRenderer {
  constructor() {
    this.kind = 'webgpu-fluid';
    this.ready = false;
    this.failed = false;
    this.unavailableReason = 'WebGPU fluid renderer not initialized';
    this.lastRenderFailureReason = '';
    this.adapter = null;
    this.device = null;
    this.canvas = null;
    this.context = null;
    this.presentationFormat = null;
    this.pipeline = null;
    this.presentPipeline = null;
    this.uniformBuffer = null;
    this._presentSampler = null;
    this._accumulationTexture = null;
    this._accumulationView = null;
    this._accumulationWidth = 0;
    this._accumulationHeight = 0;
    this.previewCanvas = null;
    this._previewCtx = null;
    this._previewSyncPending = false;
    this._previewSyncQueued = false;
    this._pendingPreviewWidth = 0;
    this._pendingPreviewHeight = 0;
    this._hasLivePreviewFrame = false;
    this._hasSubmittedFrame = false;
    this.onPreviewUpdated = null;
    this._interopProbeCanvas = null;
    this._interopProbeCtx = null;
    this._initPromise = null;
  }

  _setRenderFailure(reason) {
    this.lastRenderFailureReason = reason || 'WebGPU fluid render failed';
    return false;
  }

  async init() {
    if (this.ready) return true;
    if (this.failed) return false;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu || typeof document === 'undefined') {
        this.failed = true;
        this.unavailableReason = 'navigator.gpu unavailable';
        return false;
      }
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) {
        this.failed = true;
        this.unavailableReason = 'WebGPU adapter unavailable';
        return false;
      }
      this.device = await this.adapter.requestDevice();
      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('webgpu');
      if (!this.context) {
        this.failed = true;
        this.unavailableReason = 'WebGPU canvas context unavailable';
        return false;
      }
      this.presentationFormat = navigator.gpu.getPreferredCanvasFormat
        ? navigator.gpu.getPreferredCanvasFormat()
        : 'bgra8unorm';
      this.context.configure({
        device: this.device,
        format: this.presentationFormat,
        alphaMode: 'premultiplied',
      });
      this.uniformBuffer = this.device.createBuffer({
        size: 4 * 4 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this._presentSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this.pipeline = this._createPipeline();
      this.presentPipeline = this._createPresentPipeline();
      const interopOk = await this._verify2DInterop();
      if (!interopOk) {
        this.failed = true;
        return false;
      }
      this.ready = true;
      this.unavailableReason = '';
      return true;
    } catch (error) {
      this.failed = true;
      this.unavailableReason = error?.message || 'WebGPU fluid renderer initialization failed';
      return false;
    } finally {
      this._initPromise = null;
    }
  }

  reset() {
    this.ready = false;
    this.failed = false;
    this.unavailableReason = 'WebGPU fluid renderer not initialized';
    this.lastRenderFailureReason = '';
    this.adapter = null;
    this.device = null;
    this.canvas = null;
    this.context = null;
    this.presentationFormat = null;
    this.pipeline = null;
    this.presentPipeline = null;
    this.uniformBuffer = null;
    this._presentSampler = null;
    this._accumulationTexture = null;
    this._accumulationView = null;
    this._accumulationWidth = 0;
    this._accumulationHeight = 0;
    this.previewCanvas = null;
    this._previewCtx = null;
    this._previewSyncPending = false;
    this._previewSyncQueued = false;
    this._pendingPreviewWidth = 0;
    this._pendingPreviewHeight = 0;
    this._hasLivePreviewFrame = false;
    this._hasSubmittedFrame = false;
    this.onPreviewUpdated = null;
    this._interopProbeCanvas = null;
    this._interopProbeCtx = null;
  }

  _createPipeline() {
    const shader = this.device.createShaderModule({
      code: `
struct Uniforms {
  targetPx : vec2f,
  gridSize : vec2f,
  displaySize : vec2f,
  mode : f32,
  pressureScale : f32,
  thicknessScale : f32,
  alphaScale : f32,
};

@group(0) @binding(0) var<storage, read> cells : array<f32>;
@group(0) @binding(1) var<uniform> uniforms : Uniforms;

struct VertexOutput {
  @builtin(position) position : vec4f,
  @location(0) uv : vec2f,
};

const CELL_STRIDE : u32 = 14u;

fn idx(cell : u32, field : u32) -> u32 {
  return cell * CELL_STRIDE + field;
}

fn sampleCell(x : u32, y : u32, field : u32) -> f32 {
  let cx = min(x, u32(max(uniforms.gridSize.x, 1.0)) - 1u);
  let cy = min(y, u32(max(uniforms.gridSize.y, 1.0)) - 1u);
  return cells[idx(cy * u32(max(uniforms.gridSize.x, 1.0)) + cx, field)];
}

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

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4f {
  let gridX = clamp(u32(input.uv.x * uniforms.gridSize.x), 0u, u32(max(uniforms.gridSize.x, 1.0)) - 1u);
  let gridY = clamp(u32(input.uv.y * uniforms.gridSize.y), 0u, u32(max(uniforms.gridSize.y, 1.0)) - 1u);
  let thickness = sampleCell(gridX, gridY, 1u);
  let pressure = sampleCell(gridX, gridY, 2u);
  let vx = sampleCell(gridX, gridY, 3u);
  let vy = sampleCell(gridX, gridY, 4u);
  let pigment = vec3f(sampleCell(gridX, gridY, 5u), sampleCell(gridX, gridY, 6u), sampleCell(gridX, gridY, 7u));
  let pigmentAlpha = sampleCell(gridX, gridY, 8u);
  let occupancy = sampleCell(gridX, gridY, 9u);
  let terrain = sampleCell(gridX, gridY, 10u);
  let speed = length(vec2f(vx, vy));
  let pressureTint = vec3f(0.22 + abs(pressure) * 1.2, 0.18 + speed * 0.8, 0.42 + terrain * 0.5);
  let volumeColor = mix(vec3f(0.03, 0.05, 0.08), max(pigment, vec3f(0.14, 0.22, 0.34)), clamp(thickness * uniforms.thicknessScale + occupancy * 0.3, 0.0, 1.0));
  let pigmentColor = mix(vec3f(0.0), pigment, clamp(pigmentAlpha + thickness * 0.4, 0.0, 1.0));
  var color = volumeColor;
  if (uniforms.mode > 1.5) {
    color = pigmentColor;
  } else if (uniforms.mode > 0.5) {
    color = pressureTint;
  }
  let alpha = clamp(max(thickness * uniforms.alphaScale, pigmentAlpha * 0.7 + occupancy * 0.4), 0.0, 1.0);
  return vec4f(color, alpha);
}
`,
    });

    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: {
        module: shader,
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
  }

  _createPresentPipeline() {
    const shader = this.device.createShaderModule({
      code: `
@group(0) @binding(0) var uTex : texture_2d<f32>;
@group(0) @binding(1) var uSampler : sampler;

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

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4f {
  return textureSample(uTex, uSampler, input.uv);
}
`,
    });

    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: {
        module: shader,
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
  }

  _ensureCanvas(widthPx, heightPx) {
    if (this.canvas.width === widthPx && this.canvas.height === heightPx) return;
    this.canvas.width = widthPx;
    this.canvas.height = heightPx;
    this.context.configure({ device: this.device, format: this.presentationFormat, alphaMode: 'premultiplied' });
    this._accumulationTexture = null;
    this._accumulationView = null;
    this._accumulationWidth = 0;
    this._accumulationHeight = 0;
    this._hasSubmittedFrame = false;
  }

  _ensureAccumulationTexture(widthPx, heightPx) {
    if (this._accumulationTexture && this._accumulationWidth === widthPx && this._accumulationHeight === heightPx) return;
    this._accumulationTexture = this.device.createTexture({
      size: { width: widthPx, height: heightPx },
      format: this.presentationFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._accumulationView = this._accumulationTexture.createView();
    this._accumulationWidth = widthPx;
    this._accumulationHeight = heightPx;
  }

  _ensurePreviewCanvas(widthPx, heightPx) {
    if (!this.previewCanvas) {
      this.previewCanvas = document.createElement('canvas');
      this._previewCtx = this.previewCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this.previewCanvas || !this._previewCtx) return false;
    if (this.previewCanvas.width !== widthPx || this.previewCanvas.height !== heightPx) {
      this.previewCanvas.width = widthPx;
      this.previewCanvas.height = heightPx;
    }
    return true;
  }

  _syncPreviewCanvas(widthPx, heightPx) {
    if (!this.canvas) return false;
    if (!this._ensurePreviewCanvas(widthPx, heightPx)) return false;
    try {
      this._previewCtx.save();
      this._previewCtx.setTransform(1, 0, 0, 1, 0, 0);
      this._previewCtx.clearRect(0, 0, widthPx, heightPx);
      this._previewCtx.globalCompositeOperation = 'copy';
      this._previewCtx.drawImage(this.canvas, 0, 0, widthPx, heightPx);
      this._previewCtx.restore();
      this._hasLivePreviewFrame = true;
      this.onPreviewUpdated?.(this.previewCanvas);
      return true;
    } catch {
      try { this._previewCtx.restore(); } catch {}
      return false;
    }
  }

  _clearPreviewCanvas() {
    this._hasLivePreviewFrame = false;
    this._pendingPreviewWidth = 0;
    this._pendingPreviewHeight = 0;
    this._previewSyncPending = false;
    this._previewSyncQueued = false;
    if (!this.previewCanvas || !this._previewCtx) return;
    this._previewCtx.save();
    this._previewCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    this._previewCtx.restore();
  }

  invalidatePreview() {
    this._clearPreviewCanvas();
    return true;
  }

  _schedulePreviewSync(widthPx, heightPx) {
    this._pendingPreviewWidth = widthPx;
    this._pendingPreviewHeight = heightPx;
    if (this._previewSyncPending) {
      this._previewSyncQueued = true;
      return;
    }
    this._previewSyncPending = true;
    const finalize = () => {
      const syncWidth = this._pendingPreviewWidth;
      const syncHeight = this._pendingPreviewHeight;
      this._previewSyncPending = false;
      this._syncPreviewCanvas(syncWidth, syncHeight);
      if (this._previewSyncQueued) {
        this._previewSyncQueued = false;
        this._schedulePreviewSync(this._pendingPreviewWidth, this._pendingPreviewHeight);
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (this.device?.queue?.onSubmittedWorkDone) {
          this.device.queue.onSubmittedWorkDone().then(finalize, () => { this._previewSyncPending = false; });
          return;
        }
        finalize();
      });
      return;
    }
    if (this.device?.queue?.onSubmittedWorkDone) {
      this.device.queue.onSubmittedWorkDone().then(finalize, () => { this._previewSyncPending = false; });
      return;
    }
    finalize();
  }

  _presentAccumulation(encoder) {
    let bindGroup;
    try {
      bindGroup = this.device.createBindGroup({
        layout: this.presentPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this._accumulationView },
          { binding: 1, resource: this._presentSampler },
        ],
      });
    } catch (error) {
      return this._setRenderFailure(`WebGPU fluid present bind group failed: ${error?.message || error}`);
    }
    try {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(this.presentPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6, 1, 0, 0);
      pass.end();
      return true;
    } catch (error) {
      return this._setRenderFailure(`WebGPU fluid present pass failed: ${error?.message || error}`);
    }
  }

  render({ renderState, targetWidthPx, targetHeightPx, clear = true }) {
    if (!this.ready) return this._setRenderFailure('WebGPU fluid renderer not ready');
    if (!renderState?.buffer) return this._setRenderFailure('WebGPU fluid render state unavailable');
    const widthPx = Math.max(1, Math.round(targetWidthPx || renderState.displayWidth || renderState.width));
    const heightPx = Math.max(1, Math.round(targetHeightPx || renderState.displayHeight || renderState.height));
    this._ensureCanvas(widthPx, heightPx);
    this._ensureAccumulationTexture(widthPx, heightPx);
    const modeIndex = ['volume', 'pressure', 'pigment'].indexOf(renderState.params?.renderMode || 'volume');
    const uniforms = new Float32Array([
      widthPx,
      heightPx,
      renderState.width,
      renderState.height,
      renderState.displayWidth || widthPx,
      renderState.displayHeight || heightPx,
      modeIndex < 0 ? 0 : modeIndex,
      Math.max(1, renderState.stats?.maxPressure || 1),
      Math.max(1, renderState.stats?.maxThickness || 1),
      Number(renderState.params?.commitOpacityScale ?? 1),
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms.buffer, uniforms.byteOffset, uniforms.byteLength);
    let bindGroup;
    try {
      bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: renderState.buffer } },
          { binding: 1, resource: { buffer: this.uniformBuffer } },
        ],
      });
    } catch (error) {
      return this._setRenderFailure(`WebGPU fluid bind group failed: ${error?.message || error}`);
    }
    try {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this._accumulationView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: clear ? 'clear' : 'load',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6, 1, 0, 0);
      pass.end();
      const presented = this._presentAccumulation(encoder);
      if (!presented) return false;
      this.device.queue.submit([encoder.finish()]);
      this._schedulePreviewSync(widthPx, heightPx);
      this._hasSubmittedFrame = true;
      this.lastRenderFailureReason = '';
      return true;
    } catch (error) {
      return this._setRenderFailure(`WebGPU fluid submit failed: ${error?.message || error}`);
    }
  }

  clearSurface(widthPx, heightPx) {
    if (!this.ready) return this._setRenderFailure('WebGPU fluid renderer not ready');
    const width = Math.max(1, Math.round(widthPx));
    const height = Math.max(1, Math.round(heightPx));
    this._ensureCanvas(width, height);
    this._ensureAccumulationTexture(width, height);
    try {
      const encoder = this.device.createCommandEncoder();
      const clearPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this._accumulationView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      clearPass.end();
      const presented = this._presentAccumulation(encoder);
      if (!presented) return false;
      this.device.queue.submit([encoder.finish()]);
      this._clearPreviewCanvas();
      this._schedulePreviewSync(width, height);
      this._hasSubmittedFrame = false;
      this.lastRenderFailureReason = '';
      return true;
    } catch (error) {
      return this._setRenderFailure(`WebGPU fluid clear failed: ${error?.message || error}`);
    }
  }

  copyTo2D(targetCtx, widthPx, heightPx, compositeOperation = DEFAULT_COMPOSITE_OPERATION) {
    if (!targetCtx) return this._setRenderFailure('2D target context unavailable');
    const sourceCanvas = (this._hasLivePreviewFrame ? this.previewCanvas : null) || this.canvas;
    if (!sourceCanvas) return this._setRenderFailure('WebGPU fluid preview canvas unavailable');
    try {
      targetCtx.save();
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.globalAlpha = 1;
      targetCtx.globalCompositeOperation = compositeOperation || DEFAULT_COMPOSITE_OPERATION;
      targetCtx.drawImage(
        sourceCanvas,
        0,
        0,
        sourceCanvas.width,
        sourceCanvas.height,
        0,
        0,
        Math.max(1, Math.round(widthPx || sourceCanvas.width)),
        Math.max(1, Math.round(heightPx || sourceCanvas.height)),
      );
      targetCtx.restore();
      return true;
    } catch (error) {
      try { targetCtx.restore(); } catch {}
      return this._setRenderFailure(`WebGPU fluid→2D copy failed: ${error?.message || error}`);
    }
  }

  async _verify2DInterop() {
    if (typeof document === 'undefined') return false;
    if (!this._interopProbeCanvas) {
      this._interopProbeCanvas = document.createElement('canvas');
      this._interopProbeCanvas.width = 32;
      this._interopProbeCanvas.height = 32;
      this._interopProbeCtx = this._interopProbeCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this._interopProbeCtx) {
      this.unavailableReason = '2D interop probe unavailable';
      return false;
    }
    const probeState = {
      buffer: this.device.createBuffer({
        size: 14 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      width: 1,
      height: 1,
      displayWidth: 32,
      displayHeight: 32,
      params: { renderMode: 'volume', commitOpacityScale: 1 },
      stats: { maxPressure: 1, maxThickness: 1 },
    };
    const probeCell = new Float32Array([0, 1, 0.5, 0, 0, 1, 0.1, 0.1, 1, 1, 0, 0, 0, 0]);
    this.device.queue.writeBuffer(probeState.buffer, 0, probeCell.buffer, probeCell.byteOffset, probeCell.byteLength);
    const drew = this.render({ renderState: probeState, targetWidthPx: 32, targetHeightPx: 32, clear: true });
    if (!drew) return false;
    if (this.device.queue.onSubmittedWorkDone) await this.device.queue.onSubmittedWorkDone();
    this._interopProbeCtx.save();
    this._interopProbeCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._interopProbeCtx.clearRect(0, 0, 32, 32);
    this._interopProbeCtx.globalCompositeOperation = 'copy';
    this._interopProbeCtx.drawImage(this.canvas, 0, 0);
    this._interopProbeCtx.restore();
    const pixel = this._interopProbeCtx.getImageData(16, 16, 1, 1).data;
    this._clearPreviewCanvas();
    if (pixel[3] >= GPU_INTEROP_PROBE_ALPHA_MIN && pixel[0] >= GPU_INTEROP_PROBE_RED_MIN) return true;
    this.unavailableReason = '2D interop copy out unsupported';
    return false;
  }
}
