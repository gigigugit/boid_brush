const AGENT_STRIDE = 6;
const UNIFORM_FLOAT_COUNT = 20;
const WORKGROUP_SIZE = 64;
const MAX_LEVELS = 6;

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class WebGPUTreeMotionGenerator {
  constructor() {
    this.device = null;
    this.pipeline = null;
    this.uniformBuffer = null;
    this.agentBuffer = null;
    this.agentCapacity = 0;
    this.outputBuffer = null;
    this.outputCapacity = 0;
  }

  get segmentsPerAgentMax() {
    return 1 + (MAX_LEVELS * 2);
  }

  init(device) {
    if (!device) return false;
    if (this.device === device && this.pipeline && this.uniformBuffer) return true;
    this.device = device;
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({
          code: `
struct Uniforms {
  agentCount : u32,
  branchLevels : u32,
  samplesPerSegment : u32,
  segmentsPerAgent : u32,
  branchAngle : f32,
  branchLength : f32,
  lengthDecay : f32,
  widthDecay : f32,
  jitter : f32,
  rootOffset : f32,
  curve : f32,
  alphaDecay : f32,
  shade : f32,
  reserved0 : f32,
  baseColor : vec4f,
};

struct AgentInput {
  prev : vec2f,
  curr : vec2f,
  size : f32,
  prevSize : f32,
};

struct InstanceOutput {
  center : vec2f,
  size : f32,
  rotation : f32,
  color : vec4f,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> agents : array<AgentInput>;
@group(0) @binding(2) var<storage, read_write> instances : array<InstanceOutput>;

fn hash3(v : vec3u) -> f32 {
  let n = v.x * 1664525u + v.y * 1013904223u + v.z * 374761393u + 0x9e3779b9u;
  return f32(n & 0x00ffffffu) / 16777215.0;
}

fn rotate2(v : vec2f, angle : f32) -> vec2f {
  let c = cos(angle);
  let s = sin(angle);
  return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}

fn safeDir(v : vec2f) -> vec2f {
  let lenSq = dot(v, v);
  if (lenSq <= 1e-6) {
    return vec2f(0.0, -1.0);
  }
  return normalize(v);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let totalPerAgent = uniforms.samplesPerSegment * uniforms.segmentsPerAgent;
  let globalIndex = gid.x;
  let totalCount = uniforms.agentCount * totalPerAgent;
  if (globalIndex >= totalCount || totalPerAgent == 0u) {
    return;
  }

  let agentIndex = globalIndex / totalPerAgent;
  let localIndex = globalIndex % totalPerAgent;
  let segmentIndex = localIndex / uniforms.samplesPerSegment;
  let sampleIndex = localIndex % uniforms.samplesPerSegment;
  let agent = agents[agentIndex];

  let trunkVec = agent.curr - agent.prev;
  let trunkDir = safeDir(trunkVec);
  let baseSize = max(0.5, agent.size);
  let prevSize = max(0.5, agent.prevSize);
  let trunkLen = max(length(trunkVec), max(baseSize, prevSize) * 1.35);

  var start = agent.prev;
  var end = agent.curr;
  var level = 0u;
  var depth = 0.0;

  if (segmentIndex > 0u) {
    let side = select(-1.0, 1.0, (segmentIndex & 1u) == 0u);
    level = (segmentIndex - 1u) / 2u;
    depth = f32(level + 1u);
    var branchStart = agent.curr - trunkDir * (trunkLen * uniforms.rootOffset);
    var branchDir = trunkDir;
    var branchLen = trunkLen * uniforms.branchLength;
    for (var i = 0u; i < ${MAX_LEVELS}u; i = i + 1u) {
      if (i > level) {
        break;
      }
      let bend = uniforms.branchAngle * side * (1.0 + uniforms.curve * f32(i));
      branchDir = safeDir(rotate2(branchDir, bend));
      let segmentEnd = branchStart + branchDir * branchLen;
      if (i == level) {
        start = branchStart;
        end = segmentEnd;
      } else {
        branchStart = mix(branchStart, segmentEnd, 0.74);
        branchLen = branchLen * uniforms.lengthDecay;
      }
    }
  }

  let sampleT = (f32(sampleIndex) + 0.5) / max(1.0, f32(uniforms.samplesPerSegment));
  let lineDir = safeDir(end - start);
  let lineNormal = vec2f(-lineDir.y, lineDir.x);
  let noise = hash3(vec3u(agentIndex + 1u, segmentIndex + 3u, sampleIndex + 7u)) * 2.0 - 1.0;
  let jitterOffset = lineNormal * (noise * uniforms.jitter * trunkLen * (0.18 + depth * 0.05));
  let center = mix(start, end, sampleT) + jitterOffset;
  let widthTaper = mix(prevSize, baseSize, sampleT);
  let segmentWidth = max(0.45, widthTaper * pow(uniforms.widthDecay, depth));
  let alpha = uniforms.baseColor.a * max(0.08, 1.0 - depth * uniforms.alphaDecay);
  let shade = clamp(depth * uniforms.shade, 0.0, 0.75);
  let color = vec3f(
    uniforms.baseColor.r * (1.0 - shade),
    uniforms.baseColor.g * (1.0 - shade * 0.85),
    uniforms.baseColor.b * (1.0 - shade * 0.55)
  );

  instances[globalIndex].center = center;
  instances[globalIndex].size = segmentWidth;
  instances[globalIndex].rotation = atan2(lineDir.y, lineDir.x);
  instances[globalIndex].color = vec4f(color, alpha);
}
`,
        }),
        entryPoint: 'main',
      },
    });
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_FLOAT_COUNT * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.agentBuffer = null;
    this.agentCapacity = 0;
    this.outputBuffer = null;
    this.outputCapacity = 0;
    return true;
  }

  _ensureAgentCapacity(agentCount) {
    const required = Math.max(1, agentCount) * AGENT_STRIDE * 4;
    if (this.agentBuffer && required <= this.agentCapacity) return;
    this.agentCapacity = Math.max(required, this.agentCapacity ? this.agentCapacity * 2 : 4096);
    this.agentBuffer = this.device.createBuffer({
      size: this.agentCapacity,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  _ensureOutputCapacity(instanceCount) {
    const required = Math.max(1, instanceCount) * 8 * 4;
    if (this.outputBuffer && required <= this.outputCapacity) return;
    this.outputCapacity = Math.max(required, this.outputCapacity ? this.outputCapacity * 2 : 8192);
    this.outputBuffer = this.device.createBuffer({
      size: this.outputCapacity,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
  }

  generate(agentData, settings) {
    if (!this.device || !this.pipeline || !this.uniformBuffer) return null;
    const agentCount = Math.max(0, Math.floor((agentData?.length || 0) / AGENT_STRIDE));
    if (!agentCount) return null;
    const branchLevels = _clamp(Math.round(settings.branchLevels || 0), 1, MAX_LEVELS);
    const samplesPerSegment = _clamp(Math.round(settings.samplesPerSegment || 0), 1, 16);
    const segmentsPerAgent = 1 + (branchLevels * 2);
    const instanceCount = agentCount * segmentsPerAgent * samplesPerSegment;
    this._ensureAgentCapacity(agentCount);
    this._ensureOutputCapacity(instanceCount);
    this.device.queue.writeBuffer(
      this.agentBuffer,
      0,
      agentData.buffer,
      agentData.byteOffset,
      agentCount * AGENT_STRIDE * 4,
    );
    const uniformBytes = new ArrayBuffer(UNIFORM_FLOAT_COUNT * 4);
    const u32 = new Uint32Array(uniformBytes);
    const f32 = new Float32Array(uniformBytes);
    u32[0] = agentCount;
    u32[1] = branchLevels;
    u32[2] = samplesPerSegment;
    u32[3] = segmentsPerAgent;
    f32[4] = settings.branchAngle || 0;
    f32[5] = settings.branchLength || 0;
    f32[6] = settings.lengthDecay || 0;
    f32[7] = settings.widthDecay || 0;
    f32[8] = settings.jitter || 0;
    f32[9] = settings.rootOffset || 0;
    f32[10] = settings.curve || 0;
    f32[11] = settings.alphaDecay || 0;
    f32[12] = settings.shade || 0;
    f32[16] = settings.colorR || 0;
    f32[17] = settings.colorG || 0;
    f32[18] = settings.colorB || 0;
    f32[19] = settings.colorA || 1;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformBytes);

    const encoder = this.device.createCommandEncoder();
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.agentBuffer } },
        { binding: 2, resource: { buffer: this.outputBuffer } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(instanceCount / WORKGROUP_SIZE));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return {
      instanceBuffer: this.outputBuffer,
      count: instanceCount,
      branchLevels,
      samplesPerSegment,
    };
  }
}
