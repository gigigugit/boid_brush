const INSTANCE_STRIDE = 8;
const GPU_UNIFORM_BUFFER_BYTES = 16; // vec2f canvasPx (8) + f32 dpr (4) + f32 pad (4)
const GPU_INSTANCE_BUFFER_MIN_BYTES = 4096; // ~128 instances at 8 floats/instance before growth
const GPU_STAMP_EDGE_SOFTNESS = 0.84; // Start feathering near the outer 16% of the circle

class CanvasBoidStampRenderer {
  constructor() {
    this.kind = 'canvas';
  }

  async init() {
    return true;
  }

  reset() {}

  render({ instances, count, targetCtx }) {
    if (!targetCtx || !instances || count <= 0) return false;
    targetCtx.save();
    for (let i = 0; i < count; i++) {
      const base = i * INSTANCE_STRIDE;
      const x = instances[base + 0];
      const y = instances[base + 1];
      const size = instances[base + 2];
      const r = Math.round(instances[base + 4] * 255);
      const g = Math.round(instances[base + 5] * 255);
      const b = Math.round(instances[base + 6] * 255);
      const a = Math.max(0, Math.min(1, instances[base + 7]));
      if (a <= 0 || size <= 0) continue;
      targetCtx.fillStyle = `rgb(${r},${g},${b})`;
      targetCtx.globalAlpha = a;
      targetCtx.beginPath();
      targetCtx.arc(x, y, size / 2, 0, Math.PI * 2);
      targetCtx.fill();
    }
    targetCtx.globalAlpha = 1;
    targetCtx.restore();
    return true;
  }
}

class WebGPUBoidStampRenderer {
  constructor() {
    this.kind = 'webgpu';
    this.ready = false;
    this.failed = false;
    this.canvas = null;
    this.context = null;
    this.adapter = null;
    this.device = null;
    this.pipeline = null;
    this.uniformBuffer = null;
    this.instanceBuffer = null;
    this.instanceCapacity = 0;
    this.presentationFormat = null;
    this._initPromise = null;
  }

  async init() {
    if (this.ready) return true;
    if (this.failed) return false;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (typeof navigator === 'undefined' || !navigator.gpu || typeof document === 'undefined') {
      this.failed = true;
      return false;
    }
    try {
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) {
        this.failed = true;
        return false;
      }
      this.device = await this.adapter.requestDevice();
      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('webgpu');
      if (!this.context) {
        this.failed = true;
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
        size: GPU_UNIFORM_BUFFER_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.pipeline = this._createPipeline(this.presentationFormat);
      this.ready = true;
      return true;
    } catch (error) {
      console.warn('Boid WebGPU renderer unavailable — falling back to Canvas2D.', error);
      this.failed = true;
      this.ready = false;
      return false;
    } finally {
      this._initPromise = null;
    }
  }

  reset() {
    this.instanceBuffer = null;
    this.instanceCapacity = 0;
  }

  _createPipeline(format) {
    const shader = this.device.createShaderModule({
      code: `
struct Uniforms {
  canvasPx : vec2f,
  dpr : f32,
  pad : f32,
};

struct VertexInput {
  @location(0) center : vec2f,
  @location(1) size : f32,
  @location(2) _pad0 : f32,
  @location(3) color : vec4f,
};

struct VertexOutput {
  @builtin(position) position : vec4f,
  @location(0) local : vec2f,
  @location(1) color : vec4f,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;

@vertex
fn vs_main(input : VertexInput, @builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var quad = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0)
  );
  let local = quad[vertexIndex];
  let centerPx = input.center * uniforms.dpr;
  let halfSizePx = (input.size * uniforms.dpr) * 0.5;
  let posPx = centerPx + local * halfSizePx;
  let clipX = (posPx.x / uniforms.canvasPx.x) * 2.0 - 1.0;
  let clipY = 1.0 - (posPx.y / uniforms.canvasPx.y) * 2.0;

  var out : VertexOutput;
  out.position = vec4f(clipX, clipY, 0.0, 1.0);
  out.local = local;
  out.color = input.color;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4f {
  let dist = length(input.local);
  if (dist > 1.0) {
    discard;
  }
  let edge = smoothstep(1.0, ${GPU_STAMP_EDGE_SOFTNESS.toFixed(2)}, dist);
  return vec4f(input.color.rgb, input.color.a * edge);
}
`,
    });

    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: INSTANCE_STRIDE * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32' },
            { shaderLocation: 2, offset: 12, format: 'float32' },
            { shaderLocation: 3, offset: 16, format: 'float32x4' },
          ],
        }],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
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

  _ensureInstanceBuffer(instanceCount) {
    const requiredBytes = Math.max(1, instanceCount) * INSTANCE_STRIDE * 4;
    if (this.instanceBuffer && requiredBytes <= this.instanceCapacity) return;
    const nextCapacity = Math.max(
      requiredBytes,
      this.instanceCapacity ? this.instanceCapacity * 2 : GPU_INSTANCE_BUFFER_MIN_BYTES,
    );
    this.instanceBuffer = this.device.createBuffer({
      size: nextCapacity,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.instanceCapacity = nextCapacity;
  }

  render({ instances, count, targetCtx, targetWidthPx, targetHeightPx, dpr }) {
    if (!this.ready || !instances || count <= 0 || !targetCtx) return false;
    const widthPx = Math.max(1, Math.round(targetWidthPx));
    const heightPx = Math.max(1, Math.round(targetHeightPx));
    this._ensureCanvas(widthPx, heightPx);
    this._ensureInstanceBuffer(count);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([
      widthPx,
      heightPx,
      dpr,
      0,
    ]));
    this.device.queue.writeBuffer(this.instanceBuffer, 0, instances.buffer, instances.byteOffset, count * INSTANCE_STRIDE * 4);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: { buffer: this.uniformBuffer },
      }],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    pass.draw(6, count, 0, 0);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    targetCtx.save();
    targetCtx.setTransform(1, 0, 0, 1, 0, 0);
    targetCtx.globalAlpha = 1;
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.drawImage(this.canvas, 0, 0);
    targetCtx.restore();
    return true;
  }
}

export class BoidStampRenderer {
  constructor() {
    this.canvas = new CanvasBoidStampRenderer();
    this.webgpu = new WebGPUBoidStampRenderer();
    this.activeKind = this.canvas.kind;
  }

  async init() {
    await this.canvas.init();
    await this.webgpu.init();
  }

  reset() {
    this.canvas.reset();
    this.webgpu.reset();
    this.activeKind = this.canvas.kind;
  }

  get webgpuReady() {
    return this.webgpu.ready;
  }

  render(renderState) {
    const backend = this.webgpu.ready ? this.webgpu : this.canvas;
    const ok = backend.render(renderState);
    this.activeKind = ok ? backend.kind : this.canvas.kind;
    if (!ok && backend !== this.canvas) {
      const fallbackOk = this.canvas.render(renderState);
      this.activeKind = fallbackOk ? this.canvas.kind : this.activeKind;
      return fallbackOk;
    }
    return ok;
  }
}

export function createBoidStampRenderer() {
  return new BoidStampRenderer();
}
