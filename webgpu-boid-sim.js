import { BoidSim } from './wasm-bridge.js';

const AGENT_STRIDE = 23;
const PARAMS_LEN = 67;
const WORKGROUP_SIZE = 64;
const BYTES_PER_F32 = 4;
const STAGING_BUFFER_COUNT = 2;
const MAX_GPU_SIM_POINT_GUIDES = 32;
const MAX_GPU_SIM_PATH_TARGETS = 16;

function fillParamsArray(target, p, targetX, targetY, time) {
  target[0]  = p.seek ?? 0.4;
  target[1]  = p.cohesion ?? 0.15;
  target[2]  = p.separation ?? 0.5;
  target[3]  = p.alignment ?? 0.2;
  target[4]  = p.jitter ?? 0;
  target[5]  = p.wander ?? 0;
  target[6]  = p.wanderSpeed ?? 0.3;
  target[7]  = p.maxSpeed ?? 4.0;
  target[8]  = p.damping ?? 0.95;
  target[9]  = p.flowField ?? 0;
  target[10] = p.flowScale ?? 0.01;
  target[11] = p.fleeRadius ?? 0;
  target[12] = p.fov ?? 360;
  target[13] = p.individuality ?? 0;
  target[14] = p.quorumThreshold ?? 0;
  target[15] = p.quorumCompositeStrength ?? 0.35;
  target[16] = p.sensingEnabled ? 1 : 0;
  target[17] = p.sensingMode === 'attract' ? 1 : 0;
  target[18] = p.sensingStrength ?? 0.5;
  target[19] = p.sensingRadius ?? 20;
  target[20] = p.sensingThreshold ?? 0.1;
  target[21] = targetX;
  target[22] = targetY;
  target[23] = time;
  target[24] = p.neighborRadius ?? 80;
  target[25] = p.separationRadius ?? 25;
  target[26] = p.sizeVar ?? 0;
  target[27] = p.opacityVar ?? 0;
  target[28] = p.speedVar ?? 0;
  target[29] = p.forceVar ?? 0;
  target[30] = p.hueVar ?? 0;
  target[31] = p.satVar ?? 0;
  target[32] = p.litVar ?? 0;
  target[33] = p.simBoundsMargin ?? -1;
  target[34] = p.simSpeed ?? 1;
  target[35] = p.leader?.pull ?? 0;
  target[36] = p.leader?.seek ?? (p.seek ?? 0.4);
  target[37] = p.leader?.cohesion ?? (p.cohesion ?? 0.15);
  target[38] = p.leader?.separation ?? (p.separation ?? 0.5);
  target[39] = p.leader?.alignment ?? (p.alignment ?? 0.2);
  target[40] = p.leader?.jitter ?? 0;
  target[41] = p.leader?.wander ?? 0;
  target[42] = p.leader?.wanderSpeed ?? (p.wanderSpeed ?? 0.3);
  target[43] = p.leader?.maxSpeed ?? (p.maxSpeed ?? 4.0);
  target[44] = p.leader?.damping ?? (p.damping ?? 0.95);
  target[45] = p.leader?.flowField ?? 0;
  target[46] = p.leader?.flowScale ?? (p.flowScale ?? 0.01);
  target[47] = p.leader?.fleeRadius ?? 0;
  target[48] = p.leader?.fov ?? (p.fov ?? 360);
  target[49] = p.leader?.individuality ?? 0;
  target[50] = p.leader?.quorumThreshold ?? 0;
  target[51] = p.leader?.quorumCompositeStrength ?? 0.35;
  target[52] = p.leader?.sensingEnabled ? 1 : 0;
  target[53] = p.leader?.sensingMode === 'attract' ? 1 : 0;
  target[54] = p.leader?.sensingStrength ?? 0.5;
  target[55] = p.leader?.sensingRadius ?? 20;
  target[56] = p.leader?.sensingThreshold ?? 0.1;
  target[57] = p.leader?.neighborRadius ?? 80;
  target[58] = p.leader?.separationRadius ?? 25;
  target[59] = p.leader?.sizeVar ?? 0;
  target[60] = p.leader?.opacityVar ?? 0;
  target[61] = p.leader?.speedVar ?? 0;
  target[62] = p.leader?.forceVar ?? 0;
  target[63] = p.leader?.hueVar ?? 0;
  target[64] = p.leader?.satVar ?? 0;
  target[65] = p.leader?.litVar ?? 0;
  target[66] = p.leader?.simBoundsMargin ?? -1;
}

function packMeta(agentCount, width, height) {
  const raw = new ArrayBuffer(16);
  const u32 = new Uint32Array(raw);
  const f32 = new Float32Array(raw);
  u32[0] = agentCount >>> 0;
  u32[1] = 0;
  f32[2] = width;
  f32[3] = height;
  return raw;
}

function packGuideMeta(pointCount, pathTargetCount) {
  const raw = new ArrayBuffer(16);
  const u32 = new Uint32Array(raw);
  u32[0] = pointCount >>> 0;
  u32[1] = pathTargetCount >>> 0;
  // Padding slots keep this packed buffer aligned with the WGSL GuideMeta struct.
  u32[2] = 0;
  u32[3] = 0;
  return raw;
}

function isSupportedByGpu(p) {
  return true;
}

export class WebGPUBoidSim {
  static async create(width, height, maxAgents, wasmPath = './wasm-sim/pkg/boid_sim.js', options = {}) {
    const helper = await BoidSim.create(width, height, maxAgents, wasmPath);
    const sim = new WebGPUBoidSim(width, height, maxAgents, helper, options);
    await sim.init();
    return sim;
  }

  constructor(width, height, maxAgents, helper, options = {}) {
    this.width = width;
    this.height = height;
    this.maxAgents = maxAgents;
    this.helper = helper;
    this._stride = helper?._stride || AGENT_STRIDE;
    this._params = new Float32Array(PARAMS_LEN);
    this._lastParamsObject = null;
    this._gpuSupportedForParams = false;
    this._stateVersion = 0;
    this._activeBufferIndex = 0;
    this._gpuBuffersDirty = true;
    this._latestAppliedVersion = -1;
    this._stagingSlots = [];
    this._lastMode = 'wasm';
    this.ready = false;
    this._sharedAdapter = options.adapter || null;
    this._sharedDevice = options.device || null;
    this.adapter = null;
    this.device = null;
    this.pipeline = null;
    this.quorumPipeline = null;
    this.paramsBuffer = null;
    this.metaBuffer = null;
    this.guideMetaBuffer = null;
    this.pointGuideBuffer = null;
    this.pathTargetBuffer = null;
    this.quorumBuffer = null;
    this.agentBuffers = [];
    this.bindGroups = [];
    this.quorumBindGroups = [];
    this.sensingTexture = null;
    this.sensingTextureView = null;
    this._sensingTextureWidth = 0;
    this._sensingTextureHeight = 0;
    this._pointGuides = new Float32Array(MAX_GPU_SIM_POINT_GUIDES * 8);
    this._pathTargets = new Float32Array(MAX_GPU_SIM_PATH_TARGETS * 8);
    this._pointGuideCount = 0;
    this._pathTargetCount = 0;
  }

  async init() {
    if (!this._sharedDevice && (typeof navigator === 'undefined' || !navigator.gpu)) {
      throw new Error('WebGPU unavailable');
    }
    if (this._sharedDevice) {
      this.device = this._sharedDevice;
      this.adapter = this._sharedAdapter;
    } else {
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) throw new Error('WebGPU adapter unavailable');
      this.device = await this.adapter.requestDevice();
    }

    const maxBytes = this.maxAgents * this._stride * BYTES_PER_F32;
    this.agentBuffers = [
      this.device.createBuffer({
        size: maxBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      }),
      this.device.createBuffer({
        size: maxBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      }),
    ];
    this.paramsBuffer = this.device.createBuffer({
      size: PARAMS_LEN * BYTES_PER_F32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.metaBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.guideMetaBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pointGuideBuffer = this.device.createBuffer({
      size: this._pointGuides.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.pathTargetBuffer = this.device.createBuffer({
      size: this._pathTargets.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.quorumBuffer = this.device.createBuffer({
      size: this.maxAgents * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._ensureSensingTexture(1, 1);
    this.device.queue.writeTexture(
      { texture: this.sensingTexture },
      new Uint8Array([0]),
      { offset: 0, bytesPerRow: 1, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    for (let i = 0; i < STAGING_BUFFER_COUNT; i++) {
      this._stagingSlots.push({
        buffer: this.device.createBuffer({
          size: maxBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        busy: false,
        ready: null,
      });
    }

    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: this._shaderCode() }),
        entryPoint: 'main',
      },
    });
    this.quorumPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: this._quorumShaderCode() }),
        entryPoint: 'main',
      },
    });
    this.bindGroups = [
      this._createBindGroup(0, 1),
      this._createBindGroup(1, 0),
    ];
    this.quorumBindGroups = [
      this._createQuorumBindGroup(0),
      this._createQuorumBindGroup(1),
    ];
    this.ready = true;
  }

  _createBindGroup(inputIndex, outputIndex) {
    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.agentBuffers[inputIndex] } },
          { binding: 1, resource: { buffer: this.agentBuffers[outputIndex] } },
          { binding: 2, resource: { buffer: this.paramsBuffer } },
          { binding: 3, resource: { buffer: this.metaBuffer } },
          { binding: 4, resource: { buffer: this.pointGuideBuffer } },
          { binding: 5, resource: { buffer: this.pathTargetBuffer } },
          { binding: 6, resource: { buffer: this.guideMetaBuffer } },
          { binding: 7, resource: this.sensingTextureView },
          { binding: 8, resource: { buffer: this.quorumBuffer } },
        ],
      });
  }

  _createQuorumBindGroup(inputIndex) {
    return this.device.createBindGroup({
      layout: this.quorumPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.agentBuffers[inputIndex] } },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
        { binding: 2, resource: { buffer: this.metaBuffer } },
        { binding: 3, resource: { buffer: this.quorumBuffer } },
      ],
    });
  }

  _ensureSensingTexture(width, height) {
    const safeWidth = Math.max(1, Math.floor(width || 0));
    const safeHeight = Math.max(1, Math.floor(height || 0));
    if (
      this.sensingTexture &&
      this._sensingTextureWidth === safeWidth &&
      this._sensingTextureHeight === safeHeight
    ) {
      return;
    }
    if (this.sensingTexture) {
      this.sensingTexture.destroy();
    }
    this.sensingTexture = this.device.createTexture({
      size: { width: safeWidth, height: safeHeight, depthOrArrayLayers: 1 },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.sensingTextureView = this.sensingTexture.createView();
    this._sensingTextureWidth = safeWidth;
    this._sensingTextureHeight = safeHeight;
    if (this.pipeline) {
      this.bindGroups = [
        this._createBindGroup(0, 1),
        this._createBindGroup(1, 0),
      ];
    }
  }

  _shaderCode() {
    return `
const STRIDE : u32 = ${AGENT_STRIDE}u;
const X : u32 = 0u;
const Y : u32 = 1u;
const VX : u32 = 2u;
const VY : u32 = 3u;
const AX : u32 = 4u;
const AY : u32 = 5u;
const WA : u32 = 6u;
const LIFE : u32 = 7u;
const NX : u32 = 10u;
const NY : u32 = 11u;
const FLAGS : u32 = 15u;
const SPD_M : u32 = 16u;
const SEEK_M : u32 = 17u;
const COH_M : u32 = 18u;
const SEP_M : u32 = 19u;
const FLAG_ALIVE : u32 = 1u;
const FLAG_LEADER : u32 = 2u;
const PI : f32 = 3.141592653589793;
const TAU : f32 = 6.283185307179586;

struct ParamsBuffer {
  values : array<f32, ${PARAMS_LEN}>,
}

struct SimMeta {
  agentCount : u32,
  _pad0 : u32,
  width : f32,
  height : f32,
}

struct PointGuide {
  posRadius : vec4f,
  params : vec4f,
}

struct PathTarget {
  primary : vec4f,
  influence : vec4f,
}

struct GuideMeta {
  pointCount : u32,
  pathTargetCount : u32,
  _pad0 : u32,
  _pad1 : u32,
}

@group(0) @binding(0) var<storage, read> inAgents : array<f32>;
@group(0) @binding(1) var<storage, read_write> outAgents : array<f32>;
@group(0) @binding(2) var<storage, read> params : ParamsBuffer;
@group(0) @binding(3) var<uniform> simMeta : SimMeta;
@group(0) @binding(4) var<storage, read> pointGuides : array<PointGuide, ${MAX_GPU_SIM_POINT_GUIDES}>;
@group(0) @binding(5) var<storage, read> pathTargets : array<PathTarget, ${MAX_GPU_SIM_PATH_TARGETS}>;
@group(0) @binding(6) var<uniform> guideMeta : GuideMeta;
@group(0) @binding(7) var sensingTex : texture_2d<f32>;
@group(0) @binding(8) var<storage, read> quorumMembers : array<u32>;

fn agentIndex(agent : u32, field : u32) -> u32 {
  return agent * STRIDE + field;
}

fn agentValue(agent : u32, field : u32) -> f32 {
  return inAgents[agentIndex(agent, field)];
}

fn hash1(n : f32) -> f32 {
  return fract(sin(n) * 43758.5453123);
}

fn hash2(p : vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn sampleSensing(canvasPos : vec2f) -> f32 {
  if (simMeta.width <= 0.0 || simMeta.height <= 0.0) {
    return 0.0;
  }
  let dims = textureDimensions(sensingTex);
  if (dims.x == 0u || dims.y == 0u) {
    return 0.0;
  }
  let sensingX = i32(round(canvasPos.x * (f32(dims.x) / simMeta.width)));
  let sensingY = i32(round(canvasPos.y * (f32(dims.y) / simMeta.height)));
  if (sensingX < 0 || sensingY < 0 || sensingX >= i32(dims.x) || sensingY >= i32(dims.y)) {
    return 0.0;
  }
  return textureLoad(sensingTex, vec2i(sensingX, sensingY), 0).r;
}

fn valueNoise(p : vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  let x1 = mix(a, b, u.x);
  let x2 = mix(c, d, u.x);
  return mix(x1, x2, u.y);
}

fn inFov(xi : f32, yi : f32, vx : f32, vy : f32, ox : f32, oy : f32, fovRad : f32) -> bool {
  if (fovRad >= TAU - 0.001) {
    return true;
  }
  let speed = length(vec2f(vx, vy));
  if (speed <= 0.0001) {
    return true;
  }
  let toOther = vec2f(ox - xi, oy - yi);
  let dist = length(toOther);
  if (dist <= 0.0001) {
    return true;
  }
  let dir = vec2f(vx, vy) / speed;
  let toDir = toOther / dist;
  return dot(dir, toDir) >= cos(fovRad * 0.5);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let i = gid.x;
  if (i >= simMeta.agentCount) {
    return;
  }

  let flags = u32(max(agentValue(i, FLAGS), 0.0));
  let isLeader = (flags & FLAG_LEADER) != 0u;
  for (var field : u32 = 0u; field < STRIDE; field = field + 1u) {
    outAgents[agentIndex(i, field)] = inAgents[agentIndex(i, field)];
  }
  if ((flags & FLAG_ALIVE) == 0u) {
    return;
  }

  let seek = select(params.values[0], params.values[36], isLeader);
  let cohesion = select(params.values[1], params.values[37], isLeader);
  let separation = select(params.values[2], params.values[38], isLeader);
  let alignment = select(params.values[3], params.values[39], isLeader);
  let jitter = select(params.values[4], params.values[40], isLeader);
  let wander = select(params.values[5], params.values[41], isLeader);
  let wanderSpeed = select(params.values[6], params.values[42], isLeader);
  let maxSpeed = select(params.values[7], params.values[43], isLeader);
  let damping = select(params.values[8], params.values[44], isLeader);
  let flowField = select(params.values[9], params.values[45], isLeader);
  let flowScale = select(params.values[10], params.values[46], isLeader);
  let fleeRadius = select(params.values[11], params.values[47], isLeader);
  let fovRad = select(params.values[12], params.values[48], isLeader) * PI / 180.0;
  let quorumThreshold = max(select(params.values[14], params.values[50], isLeader), 0.0);
  let quorumEnabled = quorumThreshold >= 2.0;
  let quorumCompositeStrength = clamp(select(params.values[15], params.values[51], isLeader), 0.0, 1.0);
  let sensingEnabled = select(params.values[16], params.values[52], isLeader) > 0.5;
  let sensingAttract = select(params.values[17], params.values[53], isLeader) > 0.5;
  let sensingStrength = select(params.values[18], params.values[54], isLeader);
  let sensingRadius = select(params.values[19], params.values[55], isLeader);
  let sensingThreshold = select(params.values[20], params.values[56], isLeader);
  let goalPos = vec2f(params.values[21], params.values[22]);
  let time = params.values[23];
  let neighborRadius = max(select(params.values[24], params.values[57], isLeader), 1.0);
  let separationRadius = max(select(params.values[25], params.values[58], isLeader), 1.0);
  let boundsMargin = select(params.values[33], params.values[66], isLeader);
  let simSpeed = max(params.values[34], 0.0);
  let leaderPull = clamp(params.values[35], 0.0, 1.0);

  let xi = agentValue(i, X);
  let yi = agentValue(i, Y);
  let focalQuorum = quorumEnabled && quorumMembers[i] != 0u;
  var vx = agentValue(i, VX);
  var vy = agentValue(i, VY);
  var wa = agentValue(i, WA);
  let nx = agentValue(i, NX);
  let ny = agentValue(i, NY);
  let spdMul = agentValue(i, SPD_M);
  let seekMul = agentValue(i, SEEK_M);
  let cohMul = agentValue(i, COH_M);
  let sepMul = agentValue(i, SEP_M);
  let agentMaxSpeed = max(maxSpeed * spdMul, 0.0001);

  var ax = 0.0;
  var ay = 0.0;

  let toTarget = goalPos - vec2f(xi, yi);
  let targetDist = max(length(toTarget), 1.0);
  let desired = (toTarget / targetDist) * agentMaxSpeed;
  ax = ax + (desired.x - vx) * seek * seekMul;
  ay = ay + (desired.y - vy) * seek * seekMul;

  if (fleeRadius > 0.0) {
    let away = vec2f(xi, yi) - goalPos;
    let fleeDist = length(away);
    if (fleeDist > 0.0 && fleeDist <= fleeRadius) {
      let strength = 1.0 - fleeDist / fleeRadius;
      let awayDir = away / fleeDist;
      ax = ax + awayDir.x * agentMaxSpeed * 0.8 * strength;
      ay = ay + awayDir.y * agentMaxSpeed * 0.8 * strength;
    }
  }

  if (jitter > 0.0) {
    let noiseSeed = f32(i) * 17.0 + agentValue(i, LIFE) * 0.618 + time * 0.001;
    ax = ax + (hash1(noiseSeed) - 0.5) * jitter * agentMaxSpeed * 2.0;
    ay = ay + (hash1(noiseSeed + 11.0) - 0.5) * jitter * agentMaxSpeed * 2.0;
  }

  if (wander > 0.0) {
    wa = wa + (hash1(f32(i) * 23.0 + agentValue(i, LIFE) * 0.137 + time * 0.0013) - 0.5) * wanderSpeed * 2.0;
    ax = ax + cos(wa) * wander * agentMaxSpeed;
    ay = ay + sin(wa) * wander * agentMaxSpeed;
  }

  if (flowField > 0.0) {
    let samplePos = vec2f((xi + nx) * flowScale, (yi + ny) * flowScale + time * 0.0005);
    let angle = valueNoise(samplePos) * TAU;
    ax = ax + cos(angle) * flowField * agentMaxSpeed;
    ay = ay + sin(angle) * flowField * agentMaxSpeed;
  }

  if (sensingEnabled && sensingStrength != 0.0 && sensingRadius > 0.0) {
    var sensingFx = 0.0;
    var sensingFy = 0.0;
    for (var senseIndex = 0u; senseIndex < 8u; senseIndex = senseIndex + 1u) {
      let angle = (f32(senseIndex) / 8.0) * TAU;
      let senseDir = vec2f(cos(angle), sin(angle));
      let senseSample = sampleSensing(vec2f(xi, yi) + senseDir * sensingRadius);
      if (senseSample > sensingThreshold) {
        let signedSample = select(-senseSample, senseSample, sensingAttract);
        sensingFx = sensingFx + senseDir.x * signedSample;
        sensingFy = sensingFy + senseDir.y * signedSample;
      }
    }
    ax = ax + sensingFx * sensingStrength * agentMaxSpeed;
    ay = ay + sensingFy * sensingStrength * agentMaxSpeed;
  }

  for (var pointIndex = 0u; pointIndex < guideMeta.pointCount; pointIndex = pointIndex + 1u) {
    let guide = pointGuides[pointIndex];
    let guidePos = guide.posRadius.xy;
    let guideRadius = max(guide.posRadius.z, 0.0001);
      let guideOuterRadius = max(guide.params.w, guideRadius);
    let dx = guidePos.x - xi;
    let dy = guidePos.y - yi;
    let d = length(vec2f(dx, dy));
      if (d <= 0.0001 || d > guideOuterRadius) {
      continue;
    }
    let guideSign = guide.params.y;
    let guideHardness = max(guide.params.z, 0.1);
      var shaped = 0.0;
    if (guideSign < 0.0) {
        if (d > guideRadius) {
          continue;
        }
        let falloff = 1.0 - d / guideRadius;
        shaped = pow(falloff, guideHardness);
      } else if (d <= guideRadius) {
        shaped = 1.0 - d / guideRadius;
      } else {
        let innerSq = guideRadius * guideRadius;
        let outerSq = guideOuterRadius * guideOuterRadius;
        let distanceSq = max(d * d, 1.0);
        let gravity = 1.0 / distanceSq;
        let innerGravity = 1.0 / innerSq;
        let outerGravity = 1.0 / outerSq;
        let denom = innerGravity - outerGravity;
        if (denom > 0.000001) {
          shaped = clamp((gravity - outerGravity) / denom, 0.0, 1.0);
        }
    }
    let push = guide.params.x * simSpeed * agentMaxSpeed * shaped * 0.85 * guideSign;
    ax = ax + (dx / d) * push;
    ay = ay + (dy / d) * push;
  }

  for (var pathIndex = 0u; pathIndex < guideMeta.pathTargetCount; pathIndex = pathIndex + 1u) {
    let pathPrimary = pathTargets[pathIndex].primary;
    let pathInfluence = pathTargets[pathIndex].influence;
    let dx = pathPrimary.x - xi;
    let dy = pathPrimary.y - yi;
    let d = length(vec2f(dx, dy));
    let innerRadius = max(pathPrimary.w, 0.0001);
    let outerRadius = max(pathInfluence.x, innerRadius);
    if (d <= 0.0001 || d > outerRadius) {
      continue;
    }
    var falloff = 1.0;
    if (d > innerRadius) {
      let innerSq = innerRadius * innerRadius;
      let outerSq = outerRadius * outerRadius;
      let distanceSq = max(d * d, 1.0);
      let gravity = 1.0 / distanceSq;
      let innerGravity = 1.0 / innerSq;
      let outerGravity = 1.0 / outerSq;
      let denom = innerGravity - outerGravity;
      if (denom <= 0.000001) {
        falloff = 0.0;
      } else {
        falloff = clamp((gravity - outerGravity) / denom, 0.0, 1.0);
      }
    }
    let push = pathPrimary.z * simSpeed * agentMaxSpeed * falloff;
    ax = ax + (dx / d) * push;
    ay = ay + (dy / d) * push;
  }

  let nd2 = neighborRadius * neighborRadius;
  let sd2 = separationRadius * separationRadius;
  var cx = 0.0;
  var cy = 0.0;
  var cc = 0u;
  var avx = 0.0;
  var avy = 0.0;
  var ac = 0u;
  var sx = 0.0;
  var sy = 0.0;
  var qcx = 0.0;
  var qcy = 0.0;
  var qvx = 0.0;
  var qvy = 0.0;
  var qc = 0u;
  var leaderCx = 0.0;
  var leaderCy = 0.0;
  var leaderCount = 0u;

  for (var j = 0u; j < simMeta.agentCount; j = j + 1u) {
    if (j == i) {
      continue;
    }
    let otherFlags = u32(max(agentValue(j, FLAGS), 0.0));
    if ((otherFlags & FLAG_ALIVE) == 0u) {
      continue;
    }

    let ox = agentValue(j, X);
    let oy = agentValue(j, Y);
    if (!inFov(xi, yi, vx, vy, ox, oy, fovRad)) {
      continue;
    }

    let dx = ox - xi;
    let dy = oy - yi;
    let d2 = dx * dx + dy * dy;
    if (!isLeader && (otherFlags & FLAG_LEADER) != 0u && d2 < nd2) {
      leaderCx = leaderCx + ox;
      leaderCy = leaderCy + oy;
      leaderCount = leaderCount + 1u;
    }
    let neighborQuorum = quorumEnabled && quorumMembers[j] != 0u;

    if (focalQuorum) {
      if (neighborQuorum) {
        if (d2 < nd2) {
          cx = cx + ox;
          cy = cy + oy;
          cc = cc + 1u;
          avx = avx + agentValue(j, VX);
          avy = avy + agentValue(j, VY);
          ac = ac + 1u;
        }
        if (d2 < sd2 && d2 > 0.0) {
          let d = sqrt(d2);
          sx = sx - dx / d;
          sy = sy - dy / d;
        }
      }
    } else if (neighborQuorum) {
      if (d2 < nd2 || d2 < sd2) {
        qcx = qcx + ox;
        qcy = qcy + oy;
        qvx = qvx + agentValue(j, VX);
        qvy = qvy + agentValue(j, VY);
        qc = qc + 1u;
      }
    } else {
      if (d2 < nd2) {
        cx = cx + ox;
        cy = cy + oy;
        cc = cc + 1u;
        avx = avx + agentValue(j, VX);
        avy = avy + agentValue(j, VY);
        ac = ac + 1u;
      }
      if (d2 < sd2 && d2 > 0.0) {
        let d = sqrt(d2);
        sx = sx - dx / d;
        sy = sy - dy / d;
      }
    }
  }

  if (cc > 0u && cohesion > 0.0) {
    let groupCenter = vec2f(cx / f32(cc), cy / f32(cc));
    let toGroup = groupCenter - vec2f(xi, yi);
    let groupDist = max(length(toGroup), 1.0);
    let groupDesired = (toGroup / groupDist) * agentMaxSpeed;
    ax = ax + (groupDesired.x - vx) * cohesion * cohMul;
    ay = ay + (groupDesired.y - vy) * cohesion * cohMul;
  }

  if (ac > 0u && alignment > 0.0) {
    ax = ax + ((avx / f32(ac)) - vx) * alignment;
    ay = ay + ((avy / f32(ac)) - vy) * alignment;
  }

  if (separation > 0.0) {
    ax = ax + sx * separation * sepMul;
    ay = ay + sy * separation * sepMul;
  }

  if (!focalQuorum && qc > 0u && quorumCompositeStrength > 0.0) {
    let compositeCenter = vec2f(qcx / f32(qc), qcy / f32(qc));
    if (cohesion > 0.0) {
      let toComposite = compositeCenter - vec2f(xi, yi);
      let compositeDist = max(length(toComposite), 1.0);
      let compositeDesired = (toComposite / compositeDist) * agentMaxSpeed;
      ax = ax + (compositeDesired.x - vx) * cohesion * cohMul * quorumCompositeStrength;
      ay = ay + (compositeDesired.y - vy) * cohesion * cohMul * quorumCompositeStrength;
    }

    if (alignment > 0.0) {
      let compositeSpeed = length(vec2f(qvx, qvy));
      var compositeVx = qvx;
      var compositeVy = qvy;
      if (compositeSpeed > agentMaxSpeed && compositeSpeed > 0.0) {
        let compositeScale = agentMaxSpeed / compositeSpeed;
        compositeVx = compositeVx * compositeScale;
        compositeVy = compositeVy * compositeScale;
      }
      ax = ax + (compositeVx - vx) * alignment * quorumCompositeStrength;
      ay = ay + (compositeVy - vy) * alignment * quorumCompositeStrength;
    }

    if (separation > 0.0) {
      let compositeDelta = compositeCenter - vec2f(xi, yi);
      let compositeDist2 = dot(compositeDelta, compositeDelta);
      if (compositeDist2 < sd2 && compositeDist2 > 0.0) {
        let compositeDist = sqrt(compositeDist2);
        ax = ax - (compositeDelta.x / compositeDist) * separation * sepMul * quorumCompositeStrength;
        ay = ay - (compositeDelta.y / compositeDist) * separation * sepMul * quorumCompositeStrength;
      }
    }
  }

  if (!isLeader && !focalQuorum && leaderPull > 0.0 && leaderCount > 0u) {
    let leaderCenter = vec2f(leaderCx / f32(leaderCount), leaderCy / f32(leaderCount));
    let toLeader = leaderCenter - vec2f(xi, yi);
    let leaderDist = max(length(toLeader), 1.0);
    let leaderDesired = (toLeader / leaderDist) * agentMaxSpeed;
    ax = ax + (leaderDesired.x - vx) * leaderPull;
    ay = ay + (leaderDesired.y - vy) * leaderPull;
  }

  vx = vx + ax;
  vy = vy + ay;
  let speed = length(vec2f(vx, vy));
  if (speed > agentMaxSpeed) {
    let scale = agentMaxSpeed / speed;
    vx = vx * scale;
    vy = vy * scale;
  }
  vx = vx * damping;
  vy = vy * damping;

  var x = xi + vx;
  var y = yi + vy;

  if (boundsMargin >= 0.0) {
    let minX = -boundsMargin;
    let minY = -boundsMargin;
    let maxX = simMeta.width + boundsMargin;
    let maxY = simMeta.height + boundsMargin;
    if (x < minX) {
      x = minX;
      if (vx < 0.0) {
        vx = 0.0;
      }
    } else if (x > maxX) {
      x = maxX;
      if (vx > 0.0) {
        vx = 0.0;
      }
    }
    if (y < minY) {
      y = minY;
      if (vy < 0.0) {
        vy = 0.0;
      }
    } else if (y > maxY) {
      y = maxY;
      if (vy > 0.0) {
        vy = 0.0;
      }
    }
  }

  outAgents[agentIndex(i, X)] = x;
  outAgents[agentIndex(i, Y)] = y;
  outAgents[agentIndex(i, VX)] = vx;
  outAgents[agentIndex(i, VY)] = vy;
  outAgents[agentIndex(i, AX)] = ax;
  outAgents[agentIndex(i, AY)] = ay;
  outAgents[agentIndex(i, WA)] = wa;
  outAgents[agentIndex(i, LIFE)] = agentValue(i, LIFE) + 1.0;
}
`;
  }

  _quorumShaderCode() {
    return `
const STRIDE : u32 = ${AGENT_STRIDE}u;
const X : u32 = 0u;
const Y : u32 = 1u;
const VX : u32 = 2u;
const VY : u32 = 3u;
const FLAGS : u32 = 15u;
const FLAG_ALIVE : u32 = 1u;
const FLAG_LEADER : u32 = 2u;
const PI : f32 = 3.141592653589793;
const TAU : f32 = 6.283185307179586;

struct ParamsBuffer {
  values : array<f32, ${PARAMS_LEN}>,
}

struct SimMeta {
  agentCount : u32,
  _pad0 : u32,
  width : f32,
  height : f32,
}

@group(0) @binding(0) var<storage, read> inAgents : array<f32>;
@group(0) @binding(1) var<storage, read> params : ParamsBuffer;
@group(0) @binding(2) var<uniform> simMeta : SimMeta;
@group(0) @binding(3) var<storage, read_write> quorumMembers : array<u32>;

fn agentIndex(agent : u32, field : u32) -> u32 {
  return agent * STRIDE + field;
}

fn agentValue(agent : u32, field : u32) -> f32 {
  return inAgents[agentIndex(agent, field)];
}

fn inFov(xi : f32, yi : f32, vx : f32, vy : f32, ox : f32, oy : f32, fovRad : f32) -> bool {
  if (fovRad >= TAU - 0.001) {
    return true;
  }
  let speed = length(vec2f(vx, vy));
  if (speed <= 0.0001) {
    return true;
  }
  let toOther = vec2f(ox - xi, oy - yi);
  let dist = length(toOther);
  if (dist <= 0.0001) {
    return true;
  }
  let dir = vec2f(vx, vy) / speed;
  let toDir = toOther / dist;
  return dot(dir, toDir) >= cos(fovRad * 0.5);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let i = gid.x;
  if (i >= simMeta.agentCount) {
    return;
  }

  let flags = u32(max(agentValue(i, FLAGS), 0.0));
  let isLeader = (flags & FLAG_LEADER) != 0u;
  if ((flags & FLAG_ALIVE) == 0u) {
    quorumMembers[i] = 0u;
    return;
  }

  let threshold = u32(max(select(params.values[14], params.values[50], isLeader), 0.0));
  if (threshold < 2u) {
    quorumMembers[i] = 0u;
    return;
  }

  let neighborRadius = max(select(params.values[24], params.values[57], isLeader), 1.0);
  let neighborRadius2 = neighborRadius * neighborRadius;
  let fovRad = select(params.values[12], params.values[48], isLeader) * PI / 180.0;
  let xi = agentValue(i, X);
  let yi = agentValue(i, Y);
  let vx = agentValue(i, VX);
  let vy = agentValue(i, VY);
  var seen = 0u;

  for (var j = 0u; j < simMeta.agentCount; j = j + 1u) {
    if (j == i) {
      continue;
    }
    let otherFlags = u32(max(agentValue(j, FLAGS), 0.0));
    if ((otherFlags & FLAG_ALIVE) == 0u) {
      continue;
    }

    let ox = agentValue(j, X);
    let oy = agentValue(j, Y);
    if (!inFov(xi, yi, vx, vy, ox, oy, fovRad)) {
      continue;
    }

    let dx = ox - xi;
    let dy = oy - yi;
    if (dx * dx + dy * dy < neighborRadius2) {
      seen = seen + 1u;
      if (seen >= threshold) {
        quorumMembers[i] = 1u;
        return;
      }
    }
  }

  quorumMembers[i] = 0u;
}
`;
  }

  _applyReadyResults() {
    let newest = null;
    for (const slot of this._stagingSlots) {
      if (!slot.ready) continue;
      if (slot.ready.version !== this._stateVersion) {
        slot.ready = null;
        continue;
      }
      if (!newest || slot.ready.versionAppliedOrder > newest.versionAppliedOrder) {
        newest = slot.ready;
      }
    }
    if (!newest || newest.version < this._latestAppliedVersion) return;

    const read = this.helper.readAgents();
    if (read.count === newest.count) {
      read.buffer.set(newest.data.subarray(0, newest.count * read.stride));
      this._gpuBuffersDirty = false;
      this._latestAppliedVersion = newest.version;
    } else {
      console.warn(`WebGPU boid sim readback count mismatch (${newest.count} GPU vs ${read.count} CPU); re-syncing GPU buffers from WASM state.`);
      this._gpuBuffersDirty = true;
    }
    for (const slot of this._stagingSlots) {
      slot.ready = null;
    }
  }

  _nextFreeStagingSlot() {
    return this._stagingSlots.find(slot => !slot.busy && !slot.ready) || null;
  }

  _markStateDirty() {
    this._stateVersion += 1;
    this._gpuBuffersDirty = true;
    for (const slot of this._stagingSlots) {
      slot.ready = null;
    }
  }

  setSimulationGuides(guides = {}) {
    const points = Array.isArray(guides?.points) ? guides.points : [];
    const pathTargets = Array.isArray(guides?.pathTargets) ? guides.pathTargets : [];
    const supportsPoints = points.length <= MAX_GPU_SIM_POINT_GUIDES;
    const supportsPathTargets = pathTargets.length <= MAX_GPU_SIM_PATH_TARGETS;

    this._pointGuides.fill(0);
    this._pathTargets.fill(0);
    this._pointGuideCount = supportsPoints ? points.length : 0;
    this._pathTargetCount = supportsPathTargets ? pathTargets.length : 0;

    if (supportsPoints) {
      for (let i = 0; i < points.length; i++) {
        const guide = points[i];
        const base = i * 8;
        this._pointGuides[base + 0] = guide.x ?? 0;
        this._pointGuides[base + 1] = guide.y ?? 0;
        this._pointGuides[base + 2] = guide.radius ?? 0;
        this._pointGuides[base + 3] = 0;
        this._pointGuides[base + 4] = guide.strength ?? 0;
        this._pointGuides[base + 5] = guide.type === 'repel' ? -1 : 1;
        this._pointGuides[base + 6] = guide.hardness ?? 1;
          this._pointGuides[base + 7] = guide.influenceRadius ?? guide.radius ?? 0;
      }
    }

    if (supportsPathTargets) {
      for (let i = 0; i < pathTargets.length; i++) {
        const target = pathTargets[i];
        const base = i * 8;
        this._pathTargets[base + 0] = target.x ?? 0;
        this._pathTargets[base + 1] = target.y ?? 0;
        this._pathTargets[base + 2] = target.strength ?? 0;
        this._pathTargets[base + 3] = target.radius ?? 0;
        this._pathTargets[base + 4] = target.influenceRadius ?? target.radius ?? 0;
        this._pathTargets[base + 5] = 0;
        this._pathTargets[base + 6] = 0;
        this._pathTargets[base + 7] = 0;
      }
    }

    return {
      points: supportsPoints,
      pathTargets: supportsPathTargets,
    };
  }

  writeParams(p, targetX, targetY, time) {
    this._applyReadyResults();
    this._lastParamsObject = p;
    this._gpuSupportedForParams = isSupportedByGpu(p);
    fillParamsArray(this._params, p, targetX, targetY, time);
    this.helper.writeParams(p, targetX, targetY, time);
  }

  step(dt) {
    this._applyReadyResults();
    if (!this.ready || !this._gpuSupportedForParams) {
      this.helper.step(dt);
      this._markStateDirty();
      this._lastMode = 'wasm';
      return;
    }

    const read = this.helper.readAgents();
    if (read.count <= 0) {
      this._lastMode = 'webgpu';
      return;
    }

    const stagingSlot = this._nextFreeStagingSlot();
    if (!stagingSlot) {
      this._lastMode = 'webgpu';
      return;
    }

    const byteLength = read.count * read.stride * BYTES_PER_F32;
    if (this._gpuBuffersDirty) {
      this.device.queue.writeBuffer(
        this.agentBuffers[this._activeBufferIndex],
        0,
        read.buffer.buffer,
        read.buffer.byteOffset,
        byteLength,
      );
      this._gpuBuffersDirty = false;
    }

    this.device.queue.writeBuffer(this.paramsBuffer, 0, this._params.buffer, this._params.byteOffset, this._params.byteLength);
    this.device.queue.writeBuffer(this.metaBuffer, 0, packMeta(read.count, this.width, this.height));
    this.device.queue.writeBuffer(this.guideMetaBuffer, 0, packGuideMeta(this._pointGuideCount, this._pathTargetCount));
    if (this._pointGuideCount > 0) {
      this.device.queue.writeBuffer(this.pointGuideBuffer, 0, this._pointGuides.buffer, this._pointGuides.byteOffset, this._pointGuideCount * 8 * BYTES_PER_F32);
    }
    if (this._pathTargetCount > 0) {
      this.device.queue.writeBuffer(this.pathTargetBuffer, 0, this._pathTargets.buffer, this._pathTargets.byteOffset, this._pathTargetCount * 8 * BYTES_PER_F32);
    }

    const outputIndex = 1 - this._activeBufferIndex;
    const encoder = this.device.createCommandEncoder();
    const quorumPass = encoder.beginComputePass();
    quorumPass.setPipeline(this.quorumPipeline);
    quorumPass.setBindGroup(0, this.quorumBindGroups[this._activeBufferIndex]);
    quorumPass.dispatchWorkgroups(Math.ceil(read.count / WORKGROUP_SIZE));
    quorumPass.end();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[this._activeBufferIndex]);
    pass.dispatchWorkgroups(Math.ceil(read.count / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(this.agentBuffers[outputIndex], 0, stagingSlot.buffer, 0, byteLength);
    this.device.queue.submit([encoder.finish()]);

    const version = this._stateVersion;
    const appliedTimestamp = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    stagingSlot.busy = true;
    this._activeBufferIndex = outputIndex;
    this._lastMode = 'webgpu';

    stagingSlot.buffer.mapAsync(GPUMapMode.READ, 0, byteLength).then(() => {
      const view = new Float32Array(stagingSlot.buffer.getMappedRange(0, byteLength));
      const data = view.slice();
      stagingSlot.buffer.unmap();
      stagingSlot.ready = {
        version,
        count: read.count,
        data,
        versionAppliedOrder: appliedTimestamp,
      };
      stagingSlot.busy = false;
    }).catch((error) => {
      try {
        stagingSlot.buffer.unmap();
      } catch {}
      console.warn('WebGPU boid sim readback failed; re-syncing GPU buffers from WASM state.', error);
      stagingSlot.busy = false;
      stagingSlot.ready = null;
      this._gpuBuffersDirty = true;
    });
  }

  readAgents() {
    this._applyReadyResults();
    return this.helper.readAgents();
  }

  spawnAgent(x, y) {
    const id = this.helper.spawnAgent(x, y);
    this._markStateDirty();
    return id;
  }

  spawnBatch(cx, cy, count, shape, angle, jitter, radius) {
    this.helper.spawnBatch(cx, cy, count, shape, angle, jitter, radius);
    this._markStateDirty();
  }

  setLeaderRange(startIndex, endIndex, leaderCount) {
    this.helper.setLeaderRange(startIndex, endIndex, leaderCount);
    this._markStateDirty();
  }

  removeAgent(id) {
    this.helper.removeAgent(id);
    this._markStateDirty();
  }

  clearAgents() {
    this.helper.clearAgents();
    this._markStateDirty();
  }

  setDisplaySize(displayWidth, displayHeight) {
    this.width = Math.max(1, Math.round(displayWidth || 1));
    this.height = Math.max(1, Math.round(displayHeight || 1));
    this.helper.setDisplaySize?.(this.width, this.height);
    this._markStateDirty();
  }

  uploadSensing(luminance, w, h) {
    this.helper.uploadSensing(luminance, w, h);
    if (!this.ready) return;
    this._ensureSensingTexture(w, h);
    this.device.queue.writeTexture(
      { texture: this.sensingTexture },
      luminance,
      {
        offset: 0,
        bytesPerRow: Math.max(1, Math.floor(w || 0)),
        rowsPerImage: Math.max(1, Math.floor(h || 0)),
      },
      {
        width: Math.max(1, Math.floor(w || 0)),
        height: Math.max(1, Math.floor(h || 0)),
        depthOrArrayLayers: 1,
      },
    );
  }

  get wasm() {
    return this.helper.wasm;
  }

  destroy() {
    const destroyBuffer = buffer => {
      try {
        buffer?.destroy?.();
      } catch {}
    };
    for (const slot of this._stagingSlots || []) {
      destroyBuffer(slot?.buffer);
    }
    this._stagingSlots = [];
    for (const buffer of this.agentBuffers || []) {
      destroyBuffer(buffer);
    }
    this.agentBuffers = [];
    destroyBuffer(this.paramsBuffer);
    destroyBuffer(this.metaBuffer);
    destroyBuffer(this.guideMetaBuffer);
    destroyBuffer(this.pointGuideBuffer);
    destroyBuffer(this.pathTargetBuffer);
    destroyBuffer(this.quorumBuffer);
    this.paramsBuffer = null;
    this.metaBuffer = null;
    this.guideMetaBuffer = null;
    this.pointGuideBuffer = null;
    this.pathTargetBuffer = null;
    this.quorumBuffer = null;
    if (this.sensingTexture) {
      try {
        this.sensingTexture.destroy();
      } catch {}
    }
    this.sensingTexture = null;
    this.sensingTextureView = null;
    this._sensingTextureWidth = 0;
    this._sensingTextureHeight = 0;
    this.bindGroups = [];
    this.quorumBindGroups = [];
    this.pipeline = null;
    this.quorumPipeline = null;
    this.device = null;
    this.adapter = null;
    this.ready = false;
    this.helper?.destroy?.();
    this.helper = null;
  }

  get mode() {
    return this._lastMode;
  }

  markStateDirty() {
    this._markStateDirty();
  }
}
