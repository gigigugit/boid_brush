const INSTANCE_STRIDE = 8;
const GPU_UNIFORM_BUFFER_BYTES = 16; // vec2f canvasPx (8) + f32 dpr (4) + f32 pad (4)
const GPU_INSTANCE_BUFFER_MIN_BYTES = 4096; // ~128 instances at 8 floats/instance before growth
const GPU_STAMP_EDGE_SOFTNESS = 0.84; // Start feathering near the outer 16% of the circle
const GPU_INTEROP_PROBE_ALPHA_MIN = 16; // Treat tiny alpha noise as empty when probing WebGPU->2D canvas copy-out.
const WEBGL_INTEROP_PROBE_ALPHA_MIN = 16; // Treat tiny alpha noise as empty when probing WebGL->2D canvas copy-out.
const GPU_INTEROP_PROBE_RED_MIN = 128; // Require visible red channel signal to avoid alpha-only/noise false positives.
const WEBGL_INTEROP_PROBE_RED_MIN = 128; // Require visible red channel signal to avoid alpha-only/noise false positives.

const DEFAULT_COMPOSITE_OPERATION = 'source-over';

class CanvasBoidStampRenderer {
  constructor() {
    this.kind = 'canvas';
  }

  async init() {
    return true;
  }

  reset() {}

  render({ instances, count, targetCtx, compositeOperation = DEFAULT_COMPOSITE_OPERATION }) {
    if (!targetCtx || !instances || count <= 0) return false;
    targetCtx.save();
    targetCtx.globalCompositeOperation = compositeOperation || DEFAULT_COMPOSITE_OPERATION;
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

class WebGLBoidStampRenderer {
  constructor() {
    this.kind = 'webgl';
    this.ready = false;
    this.failed = false;
    this.unavailableReason = 'WebGL2 stamp renderer not initialized';
    this.lastRenderFailureReason = '';
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.instanceBuffer = null;
    this.vao = null;
    this._stampTexture = null;
    this._stampTextureSource = null;
    this._uniforms = null;
    this._interopProbeCanvas = null;
    this._interopProbeCtx = null;
    this._copyMode = 'drawImage';
    this._readbackCanvas = null;
    this._readbackCtx = null;
    this._readbackPixels = null;
    this._readbackImageData = null;
    this._initPromise = null;
  }

  _setRenderFailure(reason) {
    this.lastRenderFailureReason = reason || 'WebGL stamp draw failed';
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
    if (typeof document === 'undefined') {
      this.failed = true;
      this.unavailableReason = 'document unavailable';
      return false;
    }
    try {
      this.canvas = document.createElement('canvas');
      this.gl = this.canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      });
      if (!this.gl) {
        this.failed = true;
        this.unavailableReason = 'WebGL2 context unavailable';
        return false;
      }
      this.program = this._createProgram();
      this.instanceBuffer = this.gl.createBuffer();
      this.vao = this.gl.createVertexArray();
      if (!this.program || !this.instanceBuffer || !this.vao) {
        this.failed = true;
        this.unavailableReason = 'WebGL2 renderer setup failed';
        return false;
      }
      this._bindInstanceLayout();
      this.gl.useProgram(this.program);
      this._uniforms = {
        canvasPx: this.gl.getUniformLocation(this.program, 'uCanvasPx'),
        dpr: this.gl.getUniformLocation(this.program, 'uDpr'),
        stampScale: this.gl.getUniformLocation(this.program, 'uStampScale'),
        rotation: this.gl.getUniformLocation(this.program, 'uRotation'),
        useStampTexture: this.gl.getUniformLocation(this.program, 'uUseStampTexture'),
        tintStamp: this.gl.getUniformLocation(this.program, 'uTintStamp'),
        stampTexture: this.gl.getUniformLocation(this.program, 'uStampTexture'),
      };
      this.gl.uniform1i(this._uniforms.stampTexture, 0);
      this.gl.disable(this.gl.DEPTH_TEST);
      this.gl.disable(this.gl.CULL_FACE);
      this.gl.enable(this.gl.BLEND);
      this.gl.blendFuncSeparate(
        this.gl.SRC_ALPHA,
        this.gl.ONE_MINUS_SRC_ALPHA,
        this.gl.ONE,
        this.gl.ONE_MINUS_SRC_ALPHA,
      );
      const interopOk = await this._verify2DInterop();
      if (!interopOk) {
        this.failed = true;
        this.ready = false;
        return false;
      }
      this.ready = true;
      this.unavailableReason = '';
      return true;
    } catch (error) {
      console.warn('Boid WebGL renderer unavailable — falling back to Canvas2D.', error);
      this.failed = true;
      this.ready = false;
      this.unavailableReason = error?.message || 'WebGL2 renderer initialization failed';
      return false;
    } finally {
      this._initPromise = null;
    }
  }

  reset() {
    this.ready = false;
    this.failed = false;
    this.unavailableReason = 'WebGL2 stamp renderer not initialized';
    this.lastRenderFailureReason = '';
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.instanceBuffer = null;
    this.vao = null;
    this._stampTexture = null;
    this._stampTextureSource = null;
    this._uniforms = null;
    this._interopProbeCanvas = null;
    this._interopProbeCtx = null;
    this._copyMode = 'drawImage';
    this._readbackCanvas = null;
    this._readbackCtx = null;
    this._readbackPixels = null;
    this._readbackImageData = null;
  }

  _createShader(type, source) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) return shader;
    const info = this.gl.getShaderInfoLog(shader);
    this.gl.deleteShader(shader);
    throw new Error(info || 'WebGL shader compilation failed');
  }

  _createProgram() {
    const vertex = this._createShader(this.gl.VERTEX_SHADER, `#version 300 es
      precision highp float;
      layout(location=0) in vec2 aCenter;
      layout(location=1) in float aSize;
      layout(location=2) in float aRotation;
      layout(location=3) in vec4 aColor;

      uniform vec2 uCanvasPx;
      uniform float uDpr;
      uniform vec2 uStampScale;
      uniform vec2 uRotation;

      out vec2 vLocal;
      out vec2 vUV;
      out vec4 vColor;

      const vec2 QUAD[6] = vec2[6](
        vec2(-1.0, -1.0),
        vec2( 1.0, -1.0),
        vec2(-1.0,  1.0),
        vec2(-1.0,  1.0),
        vec2( 1.0, -1.0),
        vec2( 1.0,  1.0)
      );

      void main() {
        vec2 local = QUAD[gl_VertexID];
        vec2 scaledLocal = local * uStampScale;
        float instanceCos = cos(aRotation);
        float instanceSin = sin(aRotation);
        vec2 instanceLocal = vec2(
          scaledLocal.x * instanceCos - scaledLocal.y * instanceSin,
          scaledLocal.x * instanceSin + scaledLocal.y * instanceCos
        );
        vec2 rotatedLocal = vec2(
          instanceLocal.x * uRotation.x - instanceLocal.y * uRotation.y,
          instanceLocal.x * uRotation.y + instanceLocal.y * uRotation.x
        );
        vec2 centerPx = aCenter * uDpr;
        vec2 posPx = centerPx + rotatedLocal * (aSize * uDpr * 0.5);
        vec2 clip = vec2(
          (posPx.x / uCanvasPx.x) * 2.0 - 1.0,
          1.0 - (posPx.y / uCanvasPx.y) * 2.0
        );
        gl_Position = vec4(clip, 0.0, 1.0);
        vLocal = local;
        vUV = local * 0.5 + 0.5;
        vColor = aColor;
      }
    `);
    const fragment = this._createShader(this.gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      in vec2 vLocal;
      in vec2 vUV;
      in vec4 vColor;

      uniform bool uUseStampTexture;
      uniform bool uTintStamp;
      uniform sampler2D uStampTexture;

      out vec4 outColor;

      void main() {
        if (uUseStampTexture) {
          vec4 sampleColor = texture(uStampTexture, vUV);
          if (sampleColor.a <= 0.001) discard;
          outColor = uTintStamp
            ? vec4(vColor.rgb, vColor.a * sampleColor.a)
            : vec4(sampleColor.rgb, sampleColor.a * vColor.a);
          return;
        }

        float dist = length(vLocal);
        if (dist > 1.0) discard;
        float edge = 1.0 - smoothstep(${GPU_STAMP_EDGE_SOFTNESS.toFixed(2)}, 1.0, dist);
        outColor = vec4(vColor.rgb, vColor.a * edge);
      }
    `);
    const program = this.gl.createProgram();
    this.gl.attachShader(program, vertex);
    this.gl.attachShader(program, fragment);
    this.gl.linkProgram(program);
    this.gl.deleteShader(vertex);
    this.gl.deleteShader(fragment);
    if (this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) return program;
    const info = this.gl.getProgramInfoLog(program);
    this.gl.deleteProgram(program);
    throw new Error(info || 'WebGL program link failed');
  }

  _bindInstanceLayout() {
    this.gl.bindVertexArray(this.vao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, INSTANCE_STRIDE * 4, 0);
    this.gl.vertexAttribDivisor(0, 1);
    this.gl.enableVertexAttribArray(1);
    this.gl.vertexAttribPointer(1, 1, this.gl.FLOAT, false, INSTANCE_STRIDE * 4, 8);
    this.gl.vertexAttribDivisor(1, 1);
    this.gl.enableVertexAttribArray(2);
    this.gl.vertexAttribPointer(2, 1, this.gl.FLOAT, false, INSTANCE_STRIDE * 4, 12);
    this.gl.vertexAttribDivisor(2, 1);
    this.gl.enableVertexAttribArray(3);
    this.gl.vertexAttribPointer(3, 4, this.gl.FLOAT, false, INSTANCE_STRIDE * 4, 16);
    this.gl.vertexAttribDivisor(3, 1);
    this.gl.bindVertexArray(null);
  }

  _ensureCanvas(widthPx, heightPx) {
    if (this.canvas.width !== widthPx || this.canvas.height !== heightPx) {
      this.canvas.width = widthPx;
      this.canvas.height = heightPx;
    }
    this.gl.viewport(0, 0, widthPx, heightPx);
  }

  _ensureReadbackSurface(widthPx, heightPx) {
    if (typeof document === 'undefined') return false;
    if (!this._readbackCanvas) {
      this._readbackCanvas = document.createElement('canvas');
      this._readbackCtx = this._readbackCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this._readbackCtx) return false;
    if (this._readbackCanvas.width !== widthPx || this._readbackCanvas.height !== heightPx) {
      this._readbackCanvas.width = widthPx;
      this._readbackCanvas.height = heightPx;
      this._readbackImageData = null;
    }
    const pixelBytes = widthPx * heightPx * 4;
    if (!this._readbackPixels || this._readbackPixels.length !== pixelBytes) {
      this._readbackPixels = new Uint8Array(pixelBytes);
      this._readbackImageData = null;
    }
    if (!this._readbackImageData || this._readbackImageData.width !== widthPx || this._readbackImageData.height !== heightPx) {
      this._readbackImageData = this._readbackCtx.createImageData(widthPx, heightPx);
    }
    return true;
  }

  _copyViaReadPixels(targetCtx, widthPx, heightPx, compositeOperation = DEFAULT_COMPOSITE_OPERATION) {
    if (!this.gl) return this._setRenderFailure('WebGL context unavailable for readback');
    if (!this._ensureReadbackSurface(widthPx, heightPx)) {
      return this._setRenderFailure('WebGL readback surface unavailable');
    }
    try {
      this.gl.readPixels(0, 0, widthPx, heightPx, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this._readbackPixels);
    } catch (error) {
      return this._setRenderFailure(`WebGL readPixels failed: ${error?.message || error}`);
    }

    const src = this._readbackPixels;
    const dest = this._readbackImageData.data;
    for (let y = 0; y < heightPx; y++) {
      const srcRow = (heightPx - 1 - y) * widthPx * 4;
      const destRow = y * widthPx * 4;
      for (let x = 0; x < widthPx; x++) {
        const srcIdx = srcRow + x * 4;
        const destIdx = destRow + x * 4;
        const alpha = src[srcIdx + 3];
        if (alpha > 0 && alpha < 255) {
          const scale = 255 / alpha;
          dest[destIdx + 0] = Math.min(255, Math.round(src[srcIdx + 0] * scale));
          dest[destIdx + 1] = Math.min(255, Math.round(src[srcIdx + 1] * scale));
          dest[destIdx + 2] = Math.min(255, Math.round(src[srcIdx + 2] * scale));
        } else {
          dest[destIdx + 0] = src[srcIdx + 0];
          dest[destIdx + 1] = src[srcIdx + 1];
          dest[destIdx + 2] = src[srcIdx + 2];
        }
        dest[destIdx + 3] = alpha;
      }
    }

    try {
      this._readbackCtx.putImageData(this._readbackImageData, 0, 0);
      targetCtx.save();
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.globalAlpha = 1;
      targetCtx.globalCompositeOperation = compositeOperation || DEFAULT_COMPOSITE_OPERATION;
      targetCtx.drawImage(this._readbackCanvas, 0, 0);
      targetCtx.restore();
      return true;
    } catch (error) {
      try { targetCtx.restore(); } catch {}
      return this._setRenderFailure(`WebGL readback copy failed: ${error?.message || error}`);
    }
  }

  clearSurface(widthPx, heightPx) {
    if (!this.gl || !this.program || !this.instanceBuffer || !this.vao) {
      return this._setRenderFailure('WebGL render state unavailable');
    }
    const width = Math.max(1, Math.round(widthPx));
    const height = Math.max(1, Math.round(heightPx));
    try {
      this._ensureCanvas(width, height);
      this.gl.clearColor(0, 0, 0, 0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      this.gl.flush();
      this.lastRenderFailureReason = '';
      return true;
    } catch (error) {
      return this._setRenderFailure(`WebGL clear failed: ${error?.message || error}`);
    }
  }

  copyTo2D(targetCtx, widthPx, heightPx, compositeOperation = DEFAULT_COMPOSITE_OPERATION) {
    if (!targetCtx) return this._setRenderFailure('2D target context unavailable');
    return this._copyViaReadPixels(
      targetCtx,
      Math.max(1, Math.round(widthPx)),
      Math.max(1, Math.round(heightPx)),
      compositeOperation,
    );
  }

  _ensureStampTexture(bitmap) {
    if (!bitmap) return true;
    if (!this._stampTexture) {
      this._stampTexture = this.gl.createTexture();
      if (!this._stampTexture) return false;
      this.gl.bindTexture(this.gl.TEXTURE_2D, this._stampTexture);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    }
    if (this._stampTextureSource === bitmap) return true;
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this._stampTexture);
    this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, bitmap);
    this._stampTextureSource = bitmap;
    return true;
  }

  async _verify2DInterop() {
    if (typeof document === 'undefined') return false;
    if (!this.gl || !this.program || !this.instanceBuffer || !this.vao) {
      this.unavailableReason = 'WebGL render state unavailable';
      return false;
    }
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
    const probeInstances = new Float32Array([
      16, 16, 20, 0,
      1, 0.15, 0.15, 1,
    ]);
    this._copyMode = 'drawImage';
    const drew = this.render({
      instances: probeInstances,
      count: 1,
      targetCtx: this._interopProbeCtx,
      targetWidthPx: 32,
      targetHeightPx: 32,
      dpr: 1,
      allowBeforeReady: true,
    });
    if (!drew) return false;
    const pixel = this._interopProbeCtx.getImageData(16, 16, 1, 1).data;
    if (pixel[3] >= WEBGL_INTEROP_PROBE_ALPHA_MIN && pixel[0] >= WEBGL_INTEROP_PROBE_RED_MIN) return true;

    this._interopProbeCtx.clearRect(0, 0, 32, 32);
    this._copyMode = 'readPixels';
    const readbackDrew = this.render({
      instances: probeInstances,
      count: 1,
      targetCtx: this._interopProbeCtx,
      targetWidthPx: 32,
      targetHeightPx: 32,
      dpr: 1,
      allowBeforeReady: true,
    });
    if (!readbackDrew) return false;
    const readbackPixel = this._interopProbeCtx.getImageData(16, 16, 1, 1).data;
    if (readbackPixel[3] >= WEBGL_INTEROP_PROBE_ALPHA_MIN && readbackPixel[0] >= WEBGL_INTEROP_PROBE_RED_MIN) {
      console.warn('Boid WebGL renderer using readPixels copy fallback.');
      return true;
    }

    this._copyMode = 'drawImage';
    console.warn('Boid WebGL renderer copy out unsupported — falling back to Canvas2D.');
    this.unavailableReason = '2D interop copy out unsupported';
    return false;
  }

  render({ instances, count, targetCtx, targetWidthPx, targetHeightPx, dpr, stampBitmap = null, stampTint = true, stampRotation = 0, stampAspect = 1, allowBeforeReady = false, compositeOperation = DEFAULT_COMPOSITE_OPERATION, copyToTarget = true, clear = true }) {
    if (!allowBeforeReady && !this.ready) return this._setRenderFailure('WebGL renderer not ready');
    if (copyToTarget && !targetCtx) return this._setRenderFailure('2D target context unavailable');
    if (!instances || count <= 0) return this._setRenderFailure('no stamp instances to draw');
    if (!this.gl || !this.program || !this.instanceBuffer || !this.vao) {
      return this._setRenderFailure('WebGL render state unavailable');
    }
    const widthPx = Math.max(1, Math.round(targetWidthPx));
    const heightPx = Math.max(1, Math.round(targetHeightPx));
    const aspect = Number.isFinite(stampAspect) && stampAspect > 0 ? stampAspect : 1;
    const stampScale = aspect >= 1 ? [1, 1 / aspect] : [aspect, 1];

    try {
      this._ensureCanvas(widthPx, heightPx);
      this.gl.useProgram(this.program);
      this.gl.bindVertexArray(this.vao);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, instances.subarray(0, count * INSTANCE_STRIDE), this.gl.DYNAMIC_DRAW);
      this.gl.uniform2f(this._uniforms.canvasPx, widthPx, heightPx);
      this.gl.uniform1f(this._uniforms.dpr, dpr);
      this.gl.uniform2f(this._uniforms.stampScale, stampScale[0], stampScale[1]);
      this.gl.uniform2f(this._uniforms.rotation, Math.cos(stampRotation || 0), Math.sin(stampRotation || 0));
      this.gl.uniform1i(this._uniforms.useStampTexture, stampBitmap ? 1 : 0);
      this.gl.uniform1i(this._uniforms.tintStamp, stampTint ? 1 : 0);
      if (stampBitmap) {
        if (!this._ensureStampTexture(stampBitmap)) {
          return this._setRenderFailure('WebGL stamp texture unavailable');
        }
      }
      if (clear) {
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      }
      this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 6, count);
      this.gl.bindVertexArray(null);
      this.gl.flush();
    } catch (error) {
      return this._setRenderFailure(`WebGL submit failed: ${error?.message || error}`);
    }

    if (!copyToTarget) {
      this.lastRenderFailureReason = '';
      return true;
    }

    let copied = false;
    if (this._copyMode === 'readPixels') {
      copied = this._copyViaReadPixels(targetCtx, widthPx, heightPx, compositeOperation);
    } else {
      try {
        targetCtx.save();
        targetCtx.setTransform(1, 0, 0, 1, 0, 0);
        targetCtx.globalAlpha = 1;
        targetCtx.globalCompositeOperation = compositeOperation || DEFAULT_COMPOSITE_OPERATION;
        targetCtx.drawImage(this.canvas, 0, 0);
        targetCtx.restore();
        copied = true;
      } catch (error) {
        try { targetCtx.restore(); } catch {}
        return this._setRenderFailure(`WebGL→2D copy failed: ${error?.message || error}`);
      }
    }
    if (!copied) return false;
    this.lastRenderFailureReason = '';
    return true;
  }
}

class WebGPUBoidStampRenderer {
  constructor() {
    this.kind = 'webgpu';
    this.ready = false;
    this.failed = false;
    this.unavailableReason = 'WebGPU stamp renderer not initialized';
    this.lastRenderFailureReason = '';
    this.canvas = null;
    this.context = null;
    this.adapter = null;
    this.device = null;
    this.pipeline = null;
    this.uniformBuffer = null;
    this.instanceBuffer = null;
    this.instanceCapacity = 0;
    this.presentationFormat = null;
    this._interopProbeCanvas = null;
    this._interopProbeCtx = null;
    this._initPromise = null;
    this._hasSubmittedFrame = false;
    this._accumulationTexture = null;
    this._accumulationView = null;
    this._accumulationWidth = 0;
    this._accumulationHeight = 0;
    this._presentSampler = null;
    this._presentPipeline = null;
    this.previewCanvas = null;
    this._previewCtx = null;
    this._previewSyncPending = false;
    this._previewSyncQueued = false;
    this._pendingPreviewWidth = 0;
    this._pendingPreviewHeight = 0;
    this._hasLivePreviewFrame = false;
    this.onPreviewUpdated = null;
    this._debugEvents = [];
    this._debugSeq = 0;
    this._debugMaxEvents = 120;
  }

  _setRenderFailure(reason) {
    this.lastRenderFailureReason = reason || 'WebGPU stamp draw failed';
    this._pushDebugEvent('render-failure', { reason: this.lastRenderFailureReason });
    return false;
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
      kind: this.kind,
      ready: this.ready,
      failed: this.failed,
      unavailableReason: this.unavailableReason,
      lastRenderFailureReason: this.lastRenderFailureReason,
      hasSubmittedFrame: this._hasSubmittedFrame,
      hasLivePreviewFrame: this._hasLivePreviewFrame,
      previewSyncPending: this._previewSyncPending,
      previewSyncQueued: this._previewSyncQueued,
      canvas: this.canvas ? { width: this.canvas.width, height: this.canvas.height } : null,
      previewCanvas: this.previewCanvas ? { width: this.previewCanvas.width, height: this.previewCanvas.height } : null,
      accumulation: this._accumulationTexture ? { width: this._accumulationWidth, height: this._accumulationHeight } : null,
      events: this._debugEvents.slice(),
    };
  }

  clearDebugState() {
    this._debugEvents = [];
    this._debugSeq = 0;
    return true;
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
      this.unavailableReason = 'navigator.gpu unavailable';
      this._pushDebugEvent('init-unavailable', { reason: this.unavailableReason });
      return false;
    }
    try {
      this._pushDebugEvent('init-start');
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) {
        this.failed = true;
        this.unavailableReason = 'WebGPU adapter unavailable';
        this._pushDebugEvent('init-failed', { reason: this.unavailableReason });
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
        size: GPU_UNIFORM_BUFFER_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.pipeline = this._createPipeline(this.presentationFormat);
      this._presentSampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
      });
      this._presentPipeline = this._createPresentPipeline(this.presentationFormat);
      const interopOk = await this._verify2DInterop();
      if (!interopOk) {
        this.failed = true;
        this._pushDebugEvent('init-failed', { reason: this.unavailableReason || '2D interop probe failed' });
        return false;
      }
      this.ready = true;
      this.unavailableReason = '';
      this._pushDebugEvent('init-ready');
      return true;
    } catch (error) {
      console.warn('Boid WebGPU renderer unavailable — falling back to Canvas2D.', error);
      this.failed = true;
      this.ready = false;
      this.unavailableReason = error?.message || 'WebGPU renderer initialization failed';
      this._pushDebugEvent('init-failed', { reason: this.unavailableReason });
      return false;
    } finally {
      this._initPromise = null;
    }
  }

  reset() {
    this.canvas = null;
    this.context = null;
    this.adapter = null;
    this.device = null;
    this.pipeline = null;
    this.uniformBuffer = null;
    this.presentationFormat = null;
    this.instanceBuffer = null;
    this.instanceCapacity = 0;
    this._interopProbeCanvas = null;
    this._interopProbeCtx = null;
    this._initPromise = null;
    this.ready = false;
    this.failed = false;
    this.unavailableReason = 'WebGPU stamp renderer not initialized';
    this.lastRenderFailureReason = '';
    this._hasSubmittedFrame = false;
    this._accumulationTexture = null;
    this._accumulationView = null;
    this._accumulationWidth = 0;
    this._accumulationHeight = 0;
    this._presentSampler = null;
    this._presentPipeline = null;
    this.previewCanvas = null;
    this._previewCtx = null;
    this._previewSyncPending = false;
    this._previewSyncQueued = false;
    this._pendingPreviewWidth = 0;
    this._pendingPreviewHeight = 0;
    this._hasLivePreviewFrame = false;
    this.onPreviewUpdated = null;
    this.clearDebugState();
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
  @location(2) rotation : f32,
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
  let rotCos = cos(input.rotation);
  let rotSin = sin(input.rotation);
  let rotatedLocal = vec2f(
    local.x * rotCos - local.y * rotSin,
    local.x * rotSin + local.y * rotCos
  );
  let centerPx = input.center * uniforms.dpr;
  let halfSizePx = (input.size * uniforms.dpr) * 0.5;
  let posPx = centerPx + rotatedLocal * halfSizePx;
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
  let edge = 1.0 - smoothstep(${GPU_STAMP_EDGE_SOFTNESS.toFixed(2)}, 1.0, dist);
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

  _createPresentPipeline(format) {
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
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
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
    this._accumulationTexture = null;
    this._accumulationView = null;
    this._accumulationWidth = 0;
    this._accumulationHeight = 0;
    this._hasSubmittedFrame = false;
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
      this._pushDebugEvent('preview-sync-complete', { widthPx, heightPx });
      this.onPreviewUpdated?.(this.previewCanvas);
      return true;
    } catch {
      try { this._previewCtx.restore(); } catch {}
      this._pushDebugEvent('preview-sync-failed', { widthPx, heightPx });
      return false;
    }
  }

  _clearPreviewCanvas() {
    const hadLivePreviewFrame = this._hasLivePreviewFrame;
    this._hasLivePreviewFrame = false;
    this._pendingPreviewWidth = 0;
    this._pendingPreviewHeight = 0;
    this._previewSyncPending = false;
    this._previewSyncQueued = false;
    if (hadLivePreviewFrame) this._pushDebugEvent('preview-cleared');
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
      this._pushDebugEvent('preview-sync-queued', { widthPx, heightPx });
      return;
    }
    this._previewSyncPending = true;
    this._pushDebugEvent('preview-sync-requested', { widthPx, heightPx });
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
          this.device.queue.onSubmittedWorkDone().then(finalize, () => {
            this._previewSyncPending = false;
          });
          return;
        }
        finalize();
      });
      return;
    }
    if (this.device?.queue?.onSubmittedWorkDone) {
      this.device.queue.onSubmittedWorkDone().then(finalize, () => {
        this._previewSyncPending = false;
      });
      return;
    }
    finalize();
  }

  _ensureAccumulationTexture(widthPx, heightPx) {
    if (this._accumulationTexture
      && this._accumulationWidth === widthPx
      && this._accumulationHeight === heightPx) {
      return;
    }
    this._accumulationTexture = this.device.createTexture({
      size: { width: widthPx, height: heightPx },
      format: this.presentationFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._accumulationView = this._accumulationTexture.createView();
    this._accumulationWidth = widthPx;
    this._accumulationHeight = heightPx;
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

  _presentAccumulation(encoder) {
    if (!this._presentPipeline || !this._presentSampler || !this._accumulationView) {
      return this._setRenderFailure('WebGPU present pipeline unavailable');
    }
    let bindGroup;
    try {
      bindGroup = this.device.createBindGroup({
        layout: this._presentPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this._accumulationView },
          { binding: 1, resource: this._presentSampler },
        ],
      });
    } catch (error) {
      return this._setRenderFailure(`WebGPU present bind group failed: ${error?.message || error}`);
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
      pass.setPipeline(this._presentPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6, 1, 0, 0);
      pass.end();
      return true;
    } catch (error) {
      return this._setRenderFailure(`WebGPU present pass failed: ${error?.message || error}`);
    }
  }

  _drawToWebGPUCanvas({ instances, count, targetWidthPx, targetHeightPx, dpr, allowBeforeReady = false, clear = true }) {
    if (!allowBeforeReady && !this.ready) return this._setRenderFailure('WebGPU renderer not ready');
    if (!this.device) return this._setRenderFailure('WebGPU device unavailable');
    if (!this.context) return this._setRenderFailure('WebGPU canvas context unavailable');
    if (!this.pipeline) return this._setRenderFailure('WebGPU render pipeline unavailable');
    if (!this.uniformBuffer) return this._setRenderFailure('WebGPU uniform buffer unavailable');
    if (!instances) return this._setRenderFailure('stamp instance buffer missing');
    if (count <= 0) return this._setRenderFailure('no stamp instances to draw');
    const widthPx = Math.max(1, Math.round(targetWidthPx));
    const heightPx = Math.max(1, Math.round(targetHeightPx));
    this._pushDebugEvent('draw-request', { count, widthPx, heightPx, dpr, allowBeforeReady, clear });
    try {
      this._ensureCanvas(widthPx, heightPx);
      this._ensureAccumulationTexture(widthPx, heightPx);
      this._ensureInstanceBuffer(count);
    } catch (error) {
      return this._setRenderFailure(`WebGPU canvas setup failed: ${error?.message || error}`);
    }

    try {
      this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([
        widthPx,
        heightPx,
        dpr,
        0,
      ]));
    } catch (error) {
      return this._setRenderFailure(`WebGPU uniform upload failed: ${error?.message || error}`);
    }

    try {
      this.device.queue.writeBuffer(this.instanceBuffer, 0, instances.buffer, instances.byteOffset, count * INSTANCE_STRIDE * 4);
    } catch (error) {
      return this._setRenderFailure(`WebGPU instance upload failed: ${error?.message || error}`);
    }

    let bindGroup;
    try {
      bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        }],
      });
    } catch (error) {
      return this._setRenderFailure(`WebGPU bind group creation failed: ${error?.message || error}`);
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
      pass.setVertexBuffer(0, this.instanceBuffer);
      pass.draw(6, count, 0, 0);
      pass.end();
      const presented = this._presentAccumulation(encoder);
      if (!presented) return false;
      this.device.queue.submit([encoder.finish()]);
      this._schedulePreviewSync(widthPx, heightPx);
      this._hasSubmittedFrame = true;
      this._pushDebugEvent('draw-submitted', { count, widthPx, heightPx, clear });
      this.lastRenderFailureReason = '';
      return true;
    } catch (error) {
      return this._setRenderFailure(`WebGPU submit failed: ${error?.message || error}`);
    }
  }

  clearSurface(widthPx, heightPx) {
    if (!this.ready) return this._setRenderFailure('WebGPU renderer not ready');
    const width = Math.max(1, Math.round(widthPx));
    const height = Math.max(1, Math.round(heightPx));
    this._pushDebugEvent('clear-request', { widthPx: width, heightPx: height });
    try {
      this._ensureCanvas(width, height);
      this._ensureAccumulationTexture(width, height);
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
      this._pushDebugEvent('clear-submitted', { widthPx: width, heightPx: height });
      this.lastRenderFailureReason = '';
      return true;
    } catch (error) {
      return this._setRenderFailure(`WebGPU clear failed: ${error?.message || error}`);
    }
  }

  copyTo2D(targetCtx, widthPx, heightPx, compositeOperation = DEFAULT_COMPOSITE_OPERATION) {
    if (!targetCtx) return this._setRenderFailure('2D target context unavailable');
    const sourceCanvas = (this._hasLivePreviewFrame ? this.previewCanvas : null) || this.canvas;
    if (!sourceCanvas) return this._setRenderFailure('WebGPU preview canvas unavailable');
    this._pushDebugEvent('copy-to-2d', {
      widthPx: Math.max(1, Math.round(widthPx || sourceCanvas.width)),
      heightPx: Math.max(1, Math.round(heightPx || sourceCanvas.height)),
      source: this._hasLivePreviewFrame ? 'preview' : 'swapchain',
      compositeOperation: compositeOperation || DEFAULT_COMPOSITE_OPERATION,
    });
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
      return this._setRenderFailure(`WebGPU→2D copy failed: ${error?.message || error}`);
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
      console.warn('Boid WebGPU renderer 2D probe unavailable — falling back to Canvas2D.');
      this.unavailableReason = '2D interop probe unavailable';
      return false;
    }
    // Packed as [x, y, size, rotation, r, g, b, a] to match the renderer's instance stride.
    const probeInstances = new Float32Array([
      16, 16, 20, 0,
      1, 0.15, 0.15, 1,
    ]);
    this._pushDebugEvent('interop-probe-start');
    const drew = this._drawToWebGPUCanvas({
      instances: probeInstances,
      count: 1,
      targetWidthPx: 32,
      targetHeightPx: 32,
      dpr: 1,
      allowBeforeReady: true,
    });
    if (!drew) return false;
    // Older/partial WebGPU implementations may not expose an explicit completion
    // promise. When available, wait so the probe samples the submitted frame.
    if (this.device.queue.onSubmittedWorkDone) {
      await this.device.queue.onSubmittedWorkDone();
    }
    this._interopProbeCtx.save();
    this._interopProbeCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._interopProbeCtx.clearRect(0, 0, 32, 32);
    this._interopProbeCtx.globalCompositeOperation = 'copy';
    this._interopProbeCtx.drawImage(this.canvas, 0, 0);
    this._interopProbeCtx.restore();
    const pixel = this._interopProbeCtx.getImageData(16, 16, 1, 1).data;
    this._clearPreviewCanvas();
    this._pushDebugEvent('interop-probe-result', { red: pixel[0], green: pixel[1], blue: pixel[2], alpha: pixel[3] });
    // Require a meaningful alpha value so partial/broken implementations that
    // copy back only faint noise do not get treated as working WebGPU→2D interop.
    if (pixel[3] >= GPU_INTEROP_PROBE_ALPHA_MIN && pixel[0] >= GPU_INTEROP_PROBE_RED_MIN) return true;
    console.warn('Boid WebGPU renderer copy out unsupported — falling back to Canvas2D.');
    this.unavailableReason = '2D interop copy out unsupported';
    return false;
  }

  render({ instances, count, targetCtx, targetWidthPx, targetHeightPx, dpr, compositeOperation = DEFAULT_COMPOSITE_OPERATION, copyToTarget = true, clear = true }) {
    if (!this.ready) return this._setRenderFailure('WebGPU renderer not ready');
    if (copyToTarget && !targetCtx) return this._setRenderFailure('2D target context unavailable');
    if (!copyToTarget) {
      const submittedDirect = this._drawToWebGPUCanvas({ instances, count, targetWidthPx, targetHeightPx, dpr, clear });
      if (!submittedDirect) return false;
      this.lastRenderFailureReason = '';
      return true;
    }
    let copiedPriorFrame = false;
    if (this._hasSubmittedFrame) {
      try {
        targetCtx.save();
        targetCtx.setTransform(1, 0, 0, 1, 0, 0);
        targetCtx.globalAlpha = 1;
        targetCtx.globalCompositeOperation = compositeOperation || DEFAULT_COMPOSITE_OPERATION;
        targetCtx.drawImage(
          this.canvas,
          0,
          0,
          this.canvas.width,
          this.canvas.height,
          0,
          0,
          Math.max(1, Math.round(targetWidthPx || this.canvas.width)),
          Math.max(1, Math.round(targetHeightPx || this.canvas.height)),
        );
        targetCtx.restore();
        copiedPriorFrame = true;
      } catch (error) {
        try { targetCtx.restore(); } catch {}
        return this._setRenderFailure(`WebGPU→2D copy failed: ${error?.message || error}`);
      }
    }

    const submitted = this._drawToWebGPUCanvas({ instances, count, targetWidthPx, targetHeightPx, dpr, clear });
    if (!submitted) return false;
    this._hasSubmittedFrame = true;
    // Warm-up: first submitted frame has no previously completed frame to copy yet.
    if (!copiedPriorFrame) {
      return this._setRenderFailure('WebGPU renderer warming up (first frame deferred for 2D copy)');
    }
    this.lastRenderFailureReason = '';
    return true;
  }
}

export class BoidStampRenderer {
  constructor() {
    this.canvas = new CanvasBoidStampRenderer();
    this.webgl = new WebGLBoidStampRenderer();
    this.webgpu = new WebGPUBoidStampRenderer();
    this.activeKind = this.canvas.kind;
  }

  async init() {
    await this.canvas.init();
    try {
      await this.webgl.init();
    } catch (error) {
      console.warn('Boid WebGL renderer init failed — falling back to Canvas2D.', error);
    }
    try {
      await this.webgpu.init();
    } catch (error) {
      console.warn('Boid WebGPU renderer init failed — falling back to Canvas2D.', error);
    }
    this.activeKind = this.canvas.kind;
  }

  reset() {
    this.canvas.reset();
    this.webgl.reset();
    this.webgpu.reset();
    this.activeKind = this.canvas.kind;
  }

  get webgpuReady() {
    return this.webgpu.ready;
  }

  canRenderBatch({ stampBitmap = null } = {}) {
    if (stampBitmap) return this.webgl.ready;
    return true;
  }

  getPreferredBatchRendererKind({ stampBitmap = null } = {}) {
    if (stampBitmap) {
      if (this.webgl.ready) return this.webgl.kind;
      return this.canvas.kind;
    }
    if (this.webgpu.ready) return this.webgpu.kind;
    if (this.webgl.ready) return this.webgl.kind;
    return this.canvas.kind;
  }

  getUnavailableReason({ stampBitmap = null } = {}) {
    if (stampBitmap) {
      return this.webgl.lastRenderFailureReason || this.webgl.unavailableReason || 'GPU stamp-image renderer unavailable';
    }
    return this.legacyReason;
  }

  get legacyReason() {
    return this.webgpu.lastRenderFailureReason
      || this.webgl.lastRenderFailureReason
      || (this.webgpu.ready ? '' : (this.webgpu.unavailableReason || ''))
      || (this.webgl.ready ? '' : (this.webgl.unavailableReason || ''))
      || 'GPU stamp renderer unavailable';
  }

  _getRendererChain(renderState = {}) {
    const chain = [];
    if (renderState.stampBitmap) {
      if (this.webgl.ready) chain.push(this.webgl);
      return chain;
    }
    chain.push(this.canvas);
    return chain;
  }

  render(renderState) {
    const chain = this._getRendererChain(renderState);
    let ok = false;
    let usedBackend = this.canvas;
    for (const renderer of chain) {
      ok = renderer.render(renderState);
      if (ok) {
        usedBackend = renderer;
        break;
      }
    }
    if (!ok) {
      this.activeKind = this.canvas.kind;
      return false;
    }
    this.activeKind = usedBackend.kind;
    return ok;
  }
}

export function createBoidStampRenderer() {
  return new BoidStampRenderer();
}
