// =============================================================================
// app.js — Core painting application engine
//
// Manages canvases, layers, undo/redo, parameter cache, frame loop,
// session persistence, and wires all modules together.
// =============================================================================

import { Compositor, getCanvasBlendMode } from './compositor.js';
import { BoidBrush, AntBrush, BristleBrush, FluidBrush, ThreeDFluidBrush, SimpleBrush, EraserBrush, MotionPathBrush, SpawnShapes } from './brushes.js';
import { buildSidebar, buildFavoritesPanel, buildSettingsPanel, buildSimulationControlsPanel, buildGuidesPanel, buildLayersPanel, syncUI, initEdgeSliders, syncEdgeSliders, renderSimulationSessionCard, refreshWorkspaceSettingsUi, LEADER_OVERRIDE_FIELDS, PRESETS_KEY, AUTOSAVE_STORAGE_KEY } from './ui.js';
import { SelectionManager } from './selection.js';
import { exportPSD, importPSD } from './psd-io.js';
import { BlobStroke } from './blob-stroke.js';
import { BUILTIN_STAMP_IMAGE_PRESETS, DEFAULT_STAMP_PRESET_ID, getBuiltinStampPreset } from './stamp-presets.js';

const STORAGE_KEY = 'bb_session_v1';
const BUILD_ID_STORAGE_KEY = 'bb_lastLoadedBuildId';
const APP_BUILD_ID = '2026-05-26-sim-phase4-playback-export-1';
const WORKSPACE_SETTINGS_FORMAT = 'boid-brush-workspace';
const WORKSPACE_SETTINGS_VERSION = 2;
const MAX_VIEW_BOOKMARKS = 48;
const VIEW_BOOKMARK_DEFAULT_NAME = 'View';
const MAX_VIEW_BOOKMARK_NAME_LENGTH = 80;
const MAX_VIEW_BOOKMARK_LAYER_NAME_LENGTH = 120;
const VIEW_BOOKMARK_ACTIVE_ZOOM_EPSILON = 0.025;
const VIEW_BOOKMARK_ACTIVE_PAN_EPSILON = 48;
const VIEW_BOOKMARK_ACTIVE_ROTATION_EPSILON = Math.PI / 90;
const SIM_SETUP_FORMAT = 'boid-brush-simulation-setup';
const SIM_SETUP_VERSION = 1;
const SIM_SAVED_PLAYBACK_FORMAT = 'boid-brush-saved-playback';
const SIM_SAVED_PLAYBACK_VERSION = 1;
const SIM_SAVED_PLAYBACK_CAPTURE_INTERVAL = 2;
const SIM_SAVED_PLAYBACK_MAX_FRAMES = 240;
const SIM_EXPORT_TIMESLICE_MS = 250;
const SIM_EXPORT_FFMPEG_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const SIM_EXPORT_FFMPEG_UTIL_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js';
const SIM_EXPORT_FFMPEG_CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const SIM_EPHEMERAL_ALPHA_SNAP_INTERVAL_FRAMES = 6;
const SIM_EPHEMERAL_ALPHA_SNAP_THRESHOLD = 5;
const SIM_EPHEMERAL_ALPHA_SNAP_VISIBLE_STEPS = 3;
const SIM_NEAR_INFINITE_BOUNDS_MARGIN = 100000;
// ── Force Visualization submode ─────────────────────────────────────────
// A `simulation.mode` alternative to the default 'normal' authoring mode.
// Scenarios describe groups (bound to existing spawn definitions), weighted
// attractors, and routes that connect them; a separate camera policy frames
// the result. All of it is persisted config — no runtimes, camera smoothing
// accumulators, or resolved per-frame positions live on this state.
const FORCE_VIZ_ATTRACTOR_TYPES = ['fixed', 'unreachable', 'moving', 'orbiting', 'path', 'shared'];
const FORCE_VIZ_CAMERA_POLICIES = ['fixed', 'followBoid', 'followCentroid', 'frameGroups', 'orbit'];
const FORCE_VIZ_CAMERA_INTERRUPTIONS = ['holdOnUserInput', 'resumeAfterDelay', 'ignoreUserInput'];
const FORCE_VIZ_CAMERA_EXIT_BEHAVIORS = ['restoreManualView', 'retainCurrentView'];
const FORCE_VIZ_MANUAL_INPUT_HOLD_MS = 900;
const FORCE_VIZ_LOOKAHEAD_SCALE = 14;
const FORCE_VIZ_DEFAULT_ATTRACTOR_RADIUS = 80;
const FORCE_VIZ_DEFAULT_ATTRACTOR_STRENGTH = 1.2;

// Keep the inline JSON editor's single-key accent lightweight and deterministic.
const WORKSPACE_JSON_HIGHLIGHT_KEY = 'a';
const WORKSPACE_JSON_HIGHLIGHT_KEY_REGEX = new RegExp(`"${WORKSPACE_JSON_HIGHLIGHT_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"(?=\\s*:)`, 'g');
const WORKSPACE_JSON_HIGHLIGHT_MAX_CHARS = 250000;
const LEADER_FACTORY_DEFAULTS = Object.freeze(LEADER_OVERRIDE_FIELDS.reduce((acc, field) => {
  acc[field.id] = field.defaultValue;
  acc[field.overrideId] = false;
  return acc;
}, {
  leaderCount: 0,
  leaderPull: 35,
}));
const SIM_SESSION_SIDEBAR_CONTROL_EXCLUDE_IDS = new Set([
  'alwaysShowTabs',
  'autoSaveSession',
  'perfTelemetryEnabled',
  'perfWakeLockEnabled',
  'showSimulationOverlayControls',
  'showSimulationSelectionOverlay',
  'simSidebarSessionSelect',
]);
const SIM_SPAWN_RUNTIME_REFRESH_FIELDS = new Set([
  'color',
  'count',
  'opacity',
  'distribution',
  'noiseScale',
  'shape',
  'radius',
  'angle',
  'jitter',
  'stampSize',
  'stampSeparation',
  'trailFlow',
  'smudge',
  'hueVar',
  'satVar',
  'litVar',
  'sizeVar',
  'opacityVar',
  'speedVar',
]);
const SIM_SPAWN_APPEARANCE_FIELDS = new Set([
  'color',
  'opacity',
]);
const FACTORY_DEFAULTS = Object.freeze({
  brushScale: 100,
  fillTolerance: 75,
  spawnRadius: 25,
  spawnAngle: 0,
  spawnJitter: 0,
  count: 500,
  seek: 75,
  cohesion: 35,
  separation: 15,
  alignment: 22,
  jitter: 0,
  wander: 6,
  wanderSpeed: 30,
  fov: 115,
  flowField: 0,
  flowScale: 10,
  fleeRadius: 0,
  individuality: 0,
  quorumThreshold: 0,
  quorumCompositeStrength: 35,
  sizeVar: 0,
  opacityVar: 0,
  speedVar: 0,
  forceVar: 0,
  hueVar: 0,
  satVar: 0,
  litVar: 0,
  maxSpeed: 22,
  damping: 95,
  ...LEADER_FACTORY_DEFAULTS,
  motionPathAgentCount: 12,
  motionPathRenderMode: 'ribbon',
  motionPathScale: 100,
  motionPathSpeed: 100,
  motionPathAcceleration: 50,
  motionPathAvoidance: 25,
  motionPathAttraction: 0,
  motionPathSpacing: 35,
  motionPathAngleSmoothing: 90,
  motionPathMovementSmoothing: 65,
  motionPathPathSmoothing: 35,
  strokeAngleMode: 'auto',
  bristleCount: 30,
  bristleWidth: 30,
  bristleSpread: 10,
  bristleSplay: 30,
  bristleAngleOffset: 0,
  bristleFan: 0,
  bristleFanAngle: 90,
  bristleLength: 20,
  bristleStiffness: 50,
  bristleDamping: 85,
  bristleFriction: 40,
  bristleSmoothing: 50,
  pencilBlend: 80,
  bSizeVar: 0,
  bOpacityVar: 0,
  bStiffVar: 0,
  bLengthVar: 0,
  bFrictionVar: 0,
  bHueVar: 0,
  lbmBrushRadius: 36,
  lbmSpawnCount: 30,
  lbmParticleRadius: 3,
  lbmStrokePull: 36,
  lbmStrokePull_multIdx: 5,
  lbmStrokeRake: 55,
  lbmStrokeRake_multIdx: 5,
  lbmStrokeJitter: 65,
  lbmStrokeJitter_multIdx: 5,
  lbmHueJitter: 0,
  lbmLightnessJitter: 0,
  lbmInjectForce: 100,
  lbmInjectForce_multIdx: 5,
  lbmVortexStrength: 0,
  lbmVortexStrength_multIdx: 5,
  lbmBurstStrength: 0,
  lbmBurstStrength_multIdx: 5,
  lbmChevronStrength: 0,
  lbmChevronStrength_multIdx: 5,
  lbmUndulateStrength: 0,
  lbmUndulateStrength_multIdx: 5,
  lbmViscosity: 28,
  lbmDensity: 30,
  lbmSurfaceTension: 34,
  lbmTimeStep: 16,
  lbmSubsteps: 4,
  lbmMotionDecay: 34,
  lbmStopSpeed: 14,
  lbmPigmentCarry: 65,
  lbmPigmentRetention: 78,
  lbmResolutionScale: 100,
  lbmFluidScale: 115,
  fluid3dBrushRadius: 40,
  fluid3dEmitterCount: 5,
  fluid3dEmissionRate: 38,
  fluid3dEmitterStrength: 29,
  fluid3dEmitterVelocity: 18,
  fluid3dPressure: 44,
  fluid3dMomentum: 80,
  fluid3dVelocityDiffuse: 34,
  fluid3dDrag: 29,
  fluid3dThicknessDecay: 15,
  fluid3dPigmentDiffusion: 24,
  fluid3dPressureFade: 24,
  fluid3dSettleThreshold: 4,
  fluid3dTerrainWeight: 18,
  fluid3dScalarFieldInfluence: 45,
  fluid3dInfluenceStrength: 38,
  fluid3dInfluenceRadius: 120,
  fluid3dMaxVelocity: 12,
  fluid3dThicknessFloor: 4,
  fluid3dOpacity: 60,
  fluid3dOpacityScale: 100,
  fluid3dResolutionScale: 90,
  fluid3dPreviewScale: 55,
  fluid3dFluidScale: 120,
  fluid3dOccupancyBias: 8,
  fluid3dSpreadClamp: 82,
  fluid3dSurfaceTension: 18,
  fluid3dEdgeWidth: 42,
  fluid3dEdgeDrag: 16,
  fluid3dInjectorMotion: 70,
  fluid3dInjectorPigment: 82,
  fluid3dInjectorOccupancy: 74,
  fluid3dInjectorSwirl: 36,
  stampSize: 10,
  stampOpacity: 15,
  stampSeparation: 0,
  smudge: 0,
  skipStamps: 0,
  stabilizer: 0,
  strokeWaveType: 'none',
  strokeWaveAmplitude: 0,
  strokeWaveLength: 80,
  strokeWavePhase: 0,
  stampImageRotation: 0,
  canvasTextureStrength: 60,
  canvasTextureScale: 100,
  canvasTextureOffsetX: 0,
  canvasTextureOffsetY: 0,
  canvasTextureRotation: 0,
  canvasTextureDeposit: 100,
  canvasTextureFlow: 100,
  canvasTextureEdgeBreakup: 35,
  canvasTextureSmudgeDrag: 30,
  canvasTexturePooling: 55,
  canvasTextureShowOnCanvas: false,
  symmetryCount: 4,
  symmetryCenterX: 50,
  symmetryCenterY: 50,
  symmetryMode: 'radial',
  symmetryPathMirror: false,
  symmetryPathUseCurve: false,
  symmetrySizeMultipliers: '1',
  taperLength: 0,
  taperCurve: 100,
  sensingStrength: 50,
  sensingRadius: 20,
  sensingFitRadius: 0,
  sensingThreshold: 10,
  sensingUpdateFrames: 30,
  antFollow: 40,
  antPheromoneRate: 50,
  antPheromoneDecay: 20,
  antPheromoneSize: 6,
  trailBlur: 0,
  trailFlow: 0,
  kmStrength: 50,
  impastoStrength: 60,
  impastoLightAngle: 45,
  impastoLightElevation: 45,
  simSpeed: 100,
  simPointStrength: 90,
  simPointRadius: 120,
  simBoundsMargin: 0,
  simPathSpeed: 120,
  simEdgeForce: 100,
  simEdgeRadius: 28,
  simPheroPaintRadius: 18,
  simPheroPaintStrength: 55,
  simEphemeralFrames: 45,
  simEphemeralFade: 100,
  simMotionPathMode: 'path',
  pressureSpawnRadius: false,
  bristleFanEnable: false,
  pencilAngle: true,
  showBristles: true,
  lbmFirstPassPreview: true,
  lbmShowFlow: true,
  fluid3dAdaptiveQuality: true,
  fluid3dShowField: false,
  fluid3dInjectorMode: 'motion',
  smudgeOnly: false,
  pressureSize: true,
  pressureOpacity: true,
  flatStroke: false,
  stampImageEnabled: true,
  stampImageTint: true,
  canvasTextureEnabled: false,
  canvasTextureInvert: false,
  symmetryEnabled: false,
  symmetryGuideVisible: true,
  symmetryMirror: false,
  taperSize: true,
  taperOpacity: true,
  sensingEnabled: false,
  showBoids: true,
  showSpawn: true,
  antTrailVisible: true,
  antPheromoneToSensing: true,
  simEphemeralMode: false,
  kmMix: false,
  impasto: false,
  perfTelemetryEnabled: false,
  perfWakeLockEnabled: false,
  showSimulationOverlayControls: false,
  showSimulationSelectionOverlay: true,
  spawnShape: 'circle',
  boidHoverAction: 'spawn',
  boidTouchAction: 'spawn',
  boidUntouchAction: 'cull',
  boidUnhoverAction: 'cull',
  lbmRenderMode: 'hybrid',
  fluid3dRenderMode: 'volume',
  canvasTexturePreset: 'builtin-paper-grain',
  sensingMode: 'avoid',
  sensingChannel: 'darkness',
  sensingSource: 'below',
  bgColor: '#313131',
  _docSized: true,
  _docW: 1024,
  _docH: 1024,
  _primaryColor: '#1a1a1a',
  _secondaryColor: '#ffffff',
  _activeBrush: 'boid',
});
const MAX_UNDO = 20;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const WHEEL_ZOOM_IN = 1.05;
const WHEEL_ZOOM_OUT = 0.95;
const WHEEL_ROTATION_DEG = 2;
const WORKSPACE_MARGIN_PX = 200;
// Pressure EMA alpha (~4-sample smoothing window for pointer events)
const PRESSURE_SMOOTH_ALPHA = 0.25;
const DEFAULT_CANVAS_TEXTURE_ID = 'builtin-paper-grain';
const RETRYABLE_STARTUP_FETCH_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const PAPER_TEXTURE_FLECK_SCALE = 3.2;
const PAPER_TEXTURE_FLECK_THRESHOLD = 0.84;
const PAPER_TEXTURE_FLECK_INTENSITY = 170;
const TEXTURE_SLOPE_AMPLIFICATION = 1.8;
const TEXTURE_SMUDGE_MIN_DISTANCE = 0.35;
const TEXTURE_SMUDGE_SIZE_FACTOR = 0.14;
const TEXTURE_SMUDGE_BASE_INFLUENCE = 0.4;
const TEXTURE_SMUDGE_SLOPE_INFLUENCE = 1.4;
const TEXTURE_EDGE_BREAKUP_MIN_SIZE = 0.7;
const TEXTURE_EDGE_BREAKUP_SIZE_SCALE = 0.18;
const TEXTURE_EDGE_BREAKUP_VALLEY_SCALE = 0.14;
const TEXTURE_EDGE_FEATHER_MIN_DISTANCE = 0.6;
const TEXTURE_EDGE_FEATHER_DISTANCE_SCALE = 0.12;
const TEXTURE_EDGE_FEATHER_OPACITY_SCALE = 0.32;
const TEXTURE_CHANNEL_DEFAULTS = {
  deposit: 1,
  flow: 1,
  edgeBreakup: 0,
  smudgeDrag: 0,
  pooling: 0,
};
const SIM_SPAWN_SHAPES = [
  'circle', 'ring', 'gaussian', 'line', 'ellipse', 'diamond', 'grid',
  'sunburst', 'spiral', 'poisson', 'random_cluster', 'burst', 'lemniscate',
  'phyllotaxis', 'noise_scatter', 'bullseye', 'cross', 'wave', 'voronoi',
];
const DUPLICATE_OFFSET = 14;
const ANGLE_PRECISION = 10;
const SIM_POINT_HIT_RADIUS = 40;
const SIM_LINE_HIT_RADIUS = 12;
const SIM_DELETE_HIT_RADIUS = 20;
const SIM_DELETE_BADGE_OFFSET = 24;
const SIM_DELETE_BADGE_RADIUS = 20;
const SIM_DELETE_BADGE_FONT = 24;
const SIM_PARAM_HANDLE_RADIUS = 8;
const SIM_PARAM_HIT_RADIUS = 32;
const SIM_OVERLAY_ACTION_HIT_RADIUS = 12;
const SIM_DRAG_DEADZONE_PX = 20;
const SIM_POINT_STRENGTH_HANDLE_OFFSET = 22;
const SIM_POINT_STRENGTH_HANDLE_SCALE = 60;
const SIM_PATH_START_MARKER_RADIUS = 6;
const SIM_PATH_DIRECTION_HANDLE_OFFSET = 34;
const SIM_PATH_DIRECTION_ARROW_LENGTH = 14;
const SIM_PATH_SPEED_ADD_BUTTON_OFFSET_Y = 28;
const SIM_PATH_SPEED_ADD_BUTTON_WIDTH = 88;
const SIM_PATH_SPEED_ADD_BUTTON_HEIGHT = 22;
const SIM_PATH_SPEED_DELETE_OFFSET = 14;
const SIM_PATH_RADIUS_ADD_BUTTON_OFFSET_Y = 54;
const SIM_PATH_OVERLAY_ROW_GAP = 4;
const SIM_PATH_OVERLAY_STACK_GAP = 10;
const SIM_PATH_OVERLAY_SAFE_MARGIN = 14;
const SIM_PATH_RADIUS_HANDLE_OFFSET = 10;
const SIM_PATH_RADIUS_HANDLE_SCALE = 0.3;
const SIM_PATH_POSITION_HANDLE_RADIUS = 12;
const SIM_PATH_FORMAT_BUTTON_OFFSET_Y = 82;
const SIM_PATH_FORMAT_BUTTON_WIDTH = 72;
const SIM_PATH_FORMAT_BUTTON_HEIGHT = 22;
const SIM_PATH_RADIUS_HANDLE_COLOR = 'rgba(255,105,214,0.98)';
const SIM_PATH_POSITION_HANDLE_COLOR = 'rgba(255,214,120,0.98)';
const SIM_PATH_FORMAT_BUTTON_COLOR = 'rgba(255,214,120,0.92)';
const SIM_SPAWN_FORMAT_BUTTON_OFFSET_Y = 26;
const SIM_SPAWN_FORMAT_BUTTON_WIDTH = 72;
const SIM_SPAWN_FORMAT_BUTTON_HEIGHT = 22;
const SIM_SPAWN_MASK_CELL_SIZE_MIN = 2;
const SIM_SPAWN_MASK_CELL_SIZE_MAX = 6;
const SIM_SPAWN_MASK_MAX_DIM = 160;
const SIM_SPAWN_MASK_ALPHA_THRESHOLD = 8;
const SIM_SPAWN_NOISE_SCALE_MIN = 0.2;
const SIM_SPAWN_NOISE_SCALE_MAX = 3;
const SIM_SPAWN_DISTRIBUTION_MODES = ['uniform', 'density', 'noise'];
const SIM_SENSING_MODES = ['avoid', 'attract'];
const SIM_SENSING_CHANNELS = ['darkness', 'lightness', 'saturation', 'red', 'green', 'blue', 'alpha'];
const SIM_SENSING_SOURCES = ['below', 'active', 'all', 'selected'];
const DEFAULT_SIM_HARDNESS = 0.1;
const MAX_SIM_HARDNESS = 10;
const MAX_SWARM_COUNT = 2000;
const DEFAULT_PATH_STRENGTH = 0.9;
const DEFAULT_PATH_RADIUS = 40;
const DEFAULT_SIM_PATH_SPEED = 1;
const DEFAULT_SIM_POINT_INFLUENCE_SCALE = 1.8;
const SIM_PATH_SPEED_MIN = 0.1;
const SIM_PATH_SPEED_MAX = 4;
const SIM_PATH_SIZE_HANDLE_OFFSET = 14;
const SIM_PATH_TOGGLE_HANDLE_OFFSET = 18;
const SIM_PATH_SPEED_HANDLE_OFFSET = 18;
const SIM_PATH_SPEED_HANDLE_SCALE = 18;
const SIM_PATH_STRENGTH_HANDLE_OFFSET = 18;
const SIM_PATH_STRENGTH_HANDLE_SCALE = 30;
const SIM_PATH_STRENGTH_HANDLE_COLOR = 'rgba(100,220,255,0.98)';
const SIM_PATH_STRENGTH_MIN = -2;
const SIM_PATH_STRENGTH_MAX = 2;
const SIM_PATH_OVERLAY_TOGGLE_GAP = 6;
const SIM_PATH_OVERLAY_TOGGLE_SIZE = 22;
const SIM_PATH_PRIMITIVE_DEFAULT_RADIUS = 84;
const SIM_PATH_PRIMITIVE_DEFAULT_ELLIPSE_RATIO = 0.65;
const SIM_PATH_PRIMITIVE_SAMPLE_COUNT = 40;
const SIM_PATH_STAR_INNER_RATIO = 0.46;
const SIM_PATH_PRIMITIVE_KINDS = ['circle', 'star', 'square', 'diamond', 'ellipse'];
// Keep traveled distance bounded during long simulation runs; each path still
// wraps or ping-pongs against its own actual length when sampled.
const PATH_DISTANCE_WRAP_THRESHOLD = 1000000;
const MOTION_PATH_LEADER_DELTA_MAX = 1 / 20;
const MOTION_PATH_LEADER_DELTA_FALLBACK = 1 / 60;
const MOTION_PATH_LEADER_DAMPING = 0.9;
const SIM_HEATMAP_MIN_CELL_SIZE = 18;
const SIM_HEATMAP_MAX_CELL_SIZE = 28;
const SIM_HEATMAP_TARGET_CELLS = 48;
const SIM_HEATMAP_MAX_ALPHA = 1;
const DEFAULT_SIM_SEEK = 0;
const MAX_SIM_SESSION_NAME_LENGTH = 64;
const MOTION_PATH_HANDLE_RADIUS = 7;
const MOTION_PATH_HIT_RADIUS = 12;
const SYMMETRY_GUIDE_HANDLE_RADIUS = 9;
const SYMMETRY_GUIDE_HIT_RADIUS = 18;
const SYMMETRY_GUIDE_SEGMENT_HIT_FACTOR = 0.75;
const SYMMETRY_GUIDE_SLOT_RADIUS = 4;
const SYMMETRY_GUIDE_SLOT_DEDUPE_PRECISION = 1000;
const SYMMETRY_GUIDE_MIN_NODES = 2;
const SYMMETRY_GUIDE_MAX_NODES = 32;
const SYMMETRY_GUIDE_DEFAULT_START = Object.freeze({ x: 0.2, y: 0.8 });
const SYMMETRY_GUIDE_DEFAULT_END = Object.freeze({ x: 0.8, y: 0.2 });
const SYMMETRY_GUIDE_DEFAULT_CONTROL = Object.freeze({ x: 0.5, y: 0.5 });
const SYMMETRY_PATH_CURVE_SAMPLES = 64;
const MOTION_PATH_POINT_SIZE_MIN = 0.2;
const MOTION_PATH_POINT_SIZE_MAX = 4;
const MOTION_PATH_POINT_SIZE_STEP = 0.05;
const MOTION_PATH_POINT_SPEED_MIN = 0;
const MOTION_PATH_POINT_SPEED_MAX = 50;
const MOTION_PATH_POINT_SPEED_STEP = 0.05;
const MOTION_PATH_SIZE_HANDLE_RADIUS = 5;
const MOTION_PATH_SIZE_HANDLE_BASE_OFFSET = 18;
const MOTION_PATH_SIZE_HANDLE_SCALE_PIXELS = 14;
const MOTION_PATH_SPEED_HANDLE_RADIUS = 5;
const MOTION_PATH_SPEED_HANDLE_BASE_OFFSET = 18;
const MOTION_PATH_SPEED_HANDLE_SCALE_PIXELS = 6;
const MOTION_PATH_RESAMPLE_STEP = 16;
const MOTION_PATH_CURVE_SAMPLES = 48;
const MOTION_PATH_ELLIPSE_MIN_SAMPLES = 32;
const MOTION_PATH_DEFAULT_HALF_WIDTH = 110;
const MOTION_PATH_DEFAULT_HALF_HEIGHT = 70;
const MOTION_PATH_DEFAULT_OFFSET = 22;
const MOTION_PATH_RADIAL_MIN_SAMPLE_RADIUS = 1e-6;
const MOTION_PATH_RADIAL_COUNT_DEFAULT = 8;
const MOTION_PATH_RADIAL_COUNT_MIN = 1;
const MOTION_PATH_RADIAL_COUNT_MAX = 64;
const MOTION_PATH_RADIAL_SPREAD_MIN = 0;
const MOTION_PATH_RADIAL_SPREAD_DEFAULT = 360;
const MOTION_PATH_RADIAL_SPREAD_MAX = 360;
const MOTION_PATH_RADIAL_FULL_CIRCLE_THRESHOLD = 359.999;
const MOTION_PATH_RADIAL_SPREAD_CENTER_OFFSET = 0.5;
const MOTION_PATH_GROUP_NAME_MAX_LENGTH = 40;
const MOTION_PATH_RUNTIME_BASE_SPEED = 90;
const MOTION_PATH_RUNTIME_DELTA_CAP = 1 / 24;
const MOTION_PATH_RUNTIME_INTERACTION_RADIUS = 110;
const PERF_TELEMETRY_KEY = 'bb_perfTelemetry';
const PERF_WAKE_LOCK_KEY = 'bb_perfWakeLock';
const PERF_UI_REFRESH_MS = 500;
const PERF_SLOW_FRAME_MS = 20;
const PERF_THROTTLE_GAP_MS = 250;
const PERF_RECENT_EVENT_LIMIT = 10;
const DIRTY_TILE_SIZE = 256;
const DIRTY_TILE_MAX_COVERAGE = 0.45;
const STAMP_IMAGE_DISABLED_BRUSHES = new Set(['fluid', 'fluid3d']);

function _clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Shortest-path angle interpolation (radians), used by the Force
 *  Visualization camera adapter so orbit/rotation smoothing doesn't spin
 *  the long way around when crossing the -PI/PI wrap. */
function _lerpAngle(a, b, t) {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  else if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _wrapIndex(v, size) {
  return ((v % size) + size) % size;
}

function _radiansToDegrees(value) {
  return value * 180 / Math.PI;
}

function _degreesToRadians(value) {
  return value * Math.PI / 180;
}

function _formatAngleDegrees(value) {
  return Math.round(_radiansToDegrees(value) * ANGLE_PRECISION) / ANGLE_PRECISION;
}

function _parseAngleDegrees(value) {
  return _degreesToRadians(+value);
}

function _deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function _fetchWithRetry(resource, {
  attempts = 6,
  delayMs = 400,
  init,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(resource, init);
      if (!RETRYABLE_STARTUP_FETCH_STATUSES.has(response.status) || attempt >= attempts) {
        return response;
      }
      lastError = new Error(`Fetch failed (${response.status})`);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;
    }
    // Exponential back-off with jitter — gives TLS 0-RTT (HTTP 425) time to settle
    const jitter = Math.random() * 100;
    await _sleep(delayMs * attempt + jitter);
  }
  throw lastError || new Error('Fetch failed');
}

function _escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function _sanitizeSimulationSessionData(value) {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const next = [];
    for (const entry of value) {
      const normalized = _sanitizeSimulationSessionData(entry);
      if (normalized !== undefined) next.push(normalized);
    }
    return next;
  }
  if (!_isPlainObject(value)) return undefined;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = _sanitizeSimulationSessionData(entry);
    if (normalized !== undefined) next[key] = normalized;
  }
  return next;
}

function _normalizeSimulationSavedPlaybackNumericArray(values, {
  minLength = 0,
  maxLength = Infinity,
  evenLength = false,
} = {}) {
  if (!Array.isArray(values)) return null;
  const next = [];
  for (const value of values) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    next.push(n);
    if (next.length > maxLength) break;
  }
  if (next.length < minLength) return null;
  if (evenLength && (next.length % 2) !== 0) return null;
  return next;
}

function _normalizeSimulationSavedPlayback(value) {
  if (!_isPlainObject(value)) return null;
  if (value.format !== SIM_SAVED_PLAYBACK_FORMAT) return null;
  const frameRate = Number(value.frameRate);
  const capturedAt = Number(value.capturedAt);
  const agentCount = Math.max(0, Math.round(Number(value.agentCount) || 0));
  const captureInterval = Math.max(1, Math.round(Number(value.captureInterval) || 1));
  const appearance = _normalizeSimulationSavedPlaybackNumericArray(value.appearance, {
    minLength: agentCount * 5,
    maxLength: agentCount * 5,
  });
  if (agentCount > 0 && !appearance) return null;
  const rawFrames = Array.isArray(value.frames) ? value.frames.slice(0, SIM_SAVED_PLAYBACK_MAX_FRAMES) : [];
  const frames = [];
  for (const entry of rawFrames) {
    const positions = _normalizeSimulationSavedPlaybackNumericArray(entry?.positions, {
      minLength: agentCount * 2,
      maxLength: agentCount * 2,
      evenLength: true,
    });
    if (!positions) continue;
    frames.push({ positions });
  }
  if (!frames.length) return null;
  return {
    format: SIM_SAVED_PLAYBACK_FORMAT,
    version: SIM_SAVED_PLAYBACK_VERSION,
    signature: typeof value.signature === 'string' ? value.signature : '',
    frameRate: Number.isFinite(frameRate) ? Math.max(1, Math.round(frameRate)) : 60,
    captureInterval,
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0,
    width: Math.max(1, Math.round(Number(value.width) || 1)),
    height: Math.max(1, Math.round(Number(value.height) || 1)),
    agentCount,
    appearance: appearance || [],
    frames,
    truncated: value.truncated === true,
  };
}

function _normalizeSimulationVars(value) {
  const sensingMode = value?.sensingMode === 'follow' ? 'attract' : value?.sensingMode;
  return {
    seek: Number.isFinite(value?.seek) ? value.seek : DEFAULT_SIM_SEEK,
    cohesion: Number.isFinite(value?.cohesion) ? value.cohesion : undefined,
    separation: Number.isFinite(value?.separation) ? value.separation : undefined,
    alignment: Number.isFinite(value?.alignment) ? value.alignment : undefined,
    maxSpeed: Number.isFinite(value?.maxSpeed) ? value.maxSpeed : undefined,
    damping: Number.isFinite(value?.damping) ? value.damping : undefined,
    sensingEnabled: typeof value?.sensingEnabled === 'boolean' ? value.sensingEnabled : undefined,
    sensingMode: SIM_SENSING_MODES.includes(sensingMode) ? sensingMode : undefined,
    sensingChannel: SIM_SENSING_CHANNELS.includes(value?.sensingChannel) ? value.sensingChannel : undefined,
    sensingStrength: Number.isFinite(value?.sensingStrength) ? _clamp(value.sensingStrength, 0, 1) : undefined,
    sensingRadius: Number.isFinite(value?.sensingRadius) ? Math.max(0, value.sensingRadius) : undefined,
    sensingFitRadius: Number.isFinite(value?.sensingFitRadius) ? Math.max(0, value.sensingFitRadius) : undefined,
    sensingThreshold: Number.isFinite(value?.sensingThreshold) ? _clamp(value.sensingThreshold, 0, 1) : undefined,
    sensingSource: SIM_SENSING_SOURCES.includes(value?.sensingSource) ? value.sensingSource : undefined,
    sensingUpdateFrames: Number.isFinite(value?.sensingUpdateFrames)
      ? Math.max(1, Math.min(50, Math.round(value.sensingUpdateFrames)))
      : undefined,
  };
}

function _normalizeSimulationSensingSourceSelection(value) {
  const seen = new Set();
  const normalized = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const key = String(entry || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

function _readLeaderOverrideConfig({ val, chk, sel }) {
  const overrides = {};
  for (const field of LEADER_OVERRIDE_FIELDS) {
    overrides[field.key] = {
      enabled: chk(field.overrideId),
      value: field.readControl({ val, chk, sel }),
    };
  }
  return {
    count: Math.max(0, Math.round(val('leaderCount') || 0)),
    pull: val('leaderPull') / 100,
    overrides,
  };
}

function _normalizeSimulationInspectorSections(value) {
  const next = {};
  if (!value || typeof value !== 'object') return next;
  for (const [key, sectionOpen] of Object.entries(value)) {
    next[key] = !!sectionOpen;
  }
  return next;
}

function _clampSimulationSpawnNoiseScale(value) {
  return _clamp(
    Number.isFinite(value) ? value : 1,
    SIM_SPAWN_NOISE_SCALE_MIN,
    SIM_SPAWN_NOISE_SCALE_MAX,
  );
}

function _simulationSpawnNoise(ix, iy, scale = 1) {
  const scaledX = ix * scale;
  const scaledY = iy * scale;
  const seed = Math.sin((scaledX * 12.9898) + (scaledY * 78.233)) * 43758.5453;
  return seed - Math.floor(seed);
}

function _normalizeSimulationPathDirection(value) {
  return value === 'reverse' ? 'reverse' : 'forward';
}

function _getSimulationPathDirectionLabel(value) {
  return _normalizeSimulationPathDirection(value) === 'reverse' ? 'Reverse' : 'Forward';
}

function _closestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-6) return { x: ax, y: ay, distance: Math.hypot(px - ax, py - ay), t: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const x = ax + dx * t;
  const y = ay + dy * t;
  return { x, y, distance: Math.hypot(px - x, py - y), t };
}

function _distanceSquared(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

function _getMotionPathBounds(points) {
  const valid = Array.isArray(points)
    ? points.filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    : [];
  if (!valid.length) return null;
  let minX = valid[0].x;
  let maxX = valid[0].x;
  let minY = valid[0].y;
  let maxY = valid[0].y;
  for (const pt of valid) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function _sampleCubicBezierPoint(points, t) {
  const [p0, p1, p2, p3] = points;
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: (uuu * p0.x) + (3 * uu * t * p1.x) + (3 * u * tt * p2.x) + (ttt * p3.x),
    y: (uuu * p0.y) + (3 * uu * t * p1.y) + (3 * u * tt * p2.y) + (ttt * p3.y),
  };
}

function _sampleCubicHermitePoint(p0, p1, m0, m1, t) {
  const clamped = _clamp(t, 0, 1);
  const t2 = clamped * clamped;
  const t3 = t2 * clamped;
  const h00 = (2 * t3) - (3 * t2) + 1;
  const h10 = t3 - (2 * t2) + clamped;
  const h01 = (-2 * t3) + (3 * t2);
  const h11 = t3 - t2;
  return {
    x: (h00 * p0.x) + (h10 * m0.x) + (h01 * p1.x) + (h11 * m1.x),
    y: (h00 * p0.y) + (h10 * m0.y) + (h01 * p1.y) + (h11 * m1.y),
    stampScale: _lerp(
      Number.isFinite(p0?.stampScale) ? p0.stampScale : 1,
      Number.isFinite(p1?.stampScale) ? p1.stampScale : 1,
      clamped,
    ),
    speedScale: _lerp(
      Number.isFinite(p0?.speedScale) ? p0.speedScale : 1,
      Number.isFinite(p1?.speedScale) ? p1.speedScale : 1,
      clamped,
    ),
  };
}

function _normalizeMotionPathPoint(kind, point) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  const normalized = {
    x: point.x,
    y: point.y,
    stampScale: _clamp(
      Number.isFinite(point?.stampScale) ? point.stampScale : 1,
      MOTION_PATH_POINT_SIZE_MIN,
      MOTION_PATH_POINT_SIZE_MAX,
    ),
    speedScale: _clamp(
      Number.isFinite(point?.speedScale) ? point.speedScale : 1,
      MOTION_PATH_POINT_SPEED_MIN,
      MOTION_PATH_POINT_SPEED_MAX,
    ),
  };
  if (kind === 'bezier') normalized.connector = point?.connector === 'sharp' ? 'sharp' : 'curve';
  return normalized;
}

function _normalizeMotionPathPoints(kind, rawPoints, fallbackPoints = []) {
  const valid = Array.isArray(rawPoints)
    ? rawPoints.map(point => _normalizeMotionPathPoint(kind, point)).filter(Boolean)
    : [];
  const fallback = Array.isArray(fallbackPoints)
    ? fallbackPoints.map(point => _normalizeMotionPathPoint(kind, point)).filter(Boolean)
    : [];
  if (kind !== 'bezier') return valid.length ? valid : fallback;
  const hasConnectorMetadata = valid.some(point => point?.connector === 'sharp' || point?.connector === 'curve');
  if (!hasConnectorMetadata && valid.length >= 4 && ((valid.length - 1) % 3 === 0)) {
    const anchors = [];
    for (let index = 0; index < valid.length; index += 3) {
      const anchor = valid[index];
      if (!anchor) continue;
      anchors.push({ x: anchor.x, y: anchor.y, stampScale: anchor.stampScale, speedScale: anchor.speedScale, connector: 'curve' });
    }
    return anchors.length ? anchors : fallback;
  }
  return valid.length
    ? valid.map(point => ({
        x: point.x,
        y: point.y,
        stampScale: point.stampScale,
        speedScale: point.speedScale,
        connector: point.connector === 'sharp' ? 'sharp' : 'curve',
      }))
    : fallback;
}

function _roundMotionPathPointStampScale(value) {
  const clamped = _clamp(
    Number.isFinite(value) ? value : 1,
    MOTION_PATH_POINT_SIZE_MIN,
    MOTION_PATH_POINT_SIZE_MAX,
  );
  return Math.round(clamped / MOTION_PATH_POINT_SIZE_STEP) * MOTION_PATH_POINT_SIZE_STEP;
}

function _roundMotionPathPointSpeedScale(value) {
  const clamped = _clamp(
    Number.isFinite(value) ? value : 1,
    MOTION_PATH_POINT_SPEED_MIN,
    MOTION_PATH_POINT_SPEED_MAX,
  );
  return Math.round(clamped / MOTION_PATH_POINT_SPEED_STEP) * MOTION_PATH_POINT_SPEED_STEP;
}

function _normalizeMotionPathRadialCount(value) {
  return _clamp(
    Number.isFinite(value) ? Math.round(value) : MOTION_PATH_RADIAL_COUNT_DEFAULT,
    MOTION_PATH_RADIAL_COUNT_MIN,
    MOTION_PATH_RADIAL_COUNT_MAX,
  );
}

function _normalizeMotionPathRadialSpread(value) {
  return _clamp(
    Number.isFinite(value) ? value : MOTION_PATH_RADIAL_SPREAD_DEFAULT,
    MOTION_PATH_RADIAL_SPREAD_MIN,
    MOTION_PATH_RADIAL_SPREAD_MAX,
  );
}

function _normalizeMotionPathGroupId(value) {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : null;
}

function _normalizeMotionPathGroupName(value, fallback = '') {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return (trimmed || fallback).slice(0, MOTION_PATH_GROUP_NAME_MAX_LENGTH);
}

function _buildMotionPathRadialSpokes(center, spokeHandle, count, spread) {
  if (!center || !spokeHandle) return [];
  const radius = Math.hypot(spokeHandle.x - center.x, spokeHandle.y - center.y);
  if (radius <= MOTION_PATH_RADIAL_MIN_SAMPLE_RADIUS) {
    return [{
      x: spokeHandle.x,
      y: spokeHandle.y,
      stampScale: spokeHandle.stampScale,
      speedScale: spokeHandle.speedScale,
    }];
  }
  const normalizedCount = _normalizeMotionPathRadialCount(count);
  const normalizedSpread = _normalizeMotionPathRadialSpread(spread);
  const isSingleSpoke = normalizedCount <= 1;
  // A single spoke always behaves like a single directed line, even if its spread slider reaches 360°.
  const fullCircle = !isSingleSpoke && normalizedSpread >= MOTION_PATH_RADIAL_FULL_CIRCLE_THRESHOLD;
  const baseAngle = Math.atan2(spokeHandle.y - center.y, spokeHandle.x - center.x);
  let startAngle = baseAngle;
  if (!fullCircle && !isSingleSpoke) {
    startAngle = baseAngle - (((normalizedSpread * Math.PI) / 180) * MOTION_PATH_RADIAL_SPREAD_CENTER_OFFSET);
  }
  let stepAngle = 0;
  if (fullCircle) {
    stepAngle = (Math.PI * 2) / normalizedCount;
  } else if (!isSingleSpoke) {
    stepAngle = ((normalizedSpread * Math.PI) / 180) / Math.max(1, normalizedCount - 1);
  }
  const spokes = [];
  for (let index = 0; index < normalizedCount; index++) {
    const angle = startAngle + (stepAngle * index);
    spokes.push({
      x: center.x + (Math.cos(angle) * radius),
      y: center.y + (Math.sin(angle) * radius),
      stampScale: spokeHandle.stampScale,
      speedScale: spokeHandle.speedScale,
    });
  }
  return spokes;
}

function _buildMotionPathRadialPoints(pathItem) {
  const points = _normalizeMotionPathPoints('radial', pathItem?.points);
  if (points.length < 2) return [];
  const center = points[0];
  const spokeHandle = points[1];
  const spokes = _buildMotionPathRadialSpokes(
    center,
    spokeHandle,
    pathItem?.radialCount,
    pathItem?.radialSpread,
  );
  if (!spokes.length) return [center, spokeHandle];
  const sampled = [{
    x: center.x,
    y: center.y,
    stampScale: center.stampScale,
    speedScale: center.speedScale,
  }];
  spokes.forEach((spoke, index) => {
    sampled.push({
      x: spoke.x,
      y: spoke.y,
      stampScale: spoke.stampScale,
      speedScale: spoke.speedScale,
    });
    if (index < spokes.length - 1) {
      // Stop after the last spoke so agents finish at the final tip instead of being forced back to center.
      sampled.push({
        x: center.x,
        y: center.y,
        stampScale: center.stampScale,
        speedScale: center.speedScale,
      });
    }
  });
  return sampled;
}

function _getMotionPathBezierTangents(points, index, closed = false) {
  const count = Array.isArray(points) ? points.length : 0;
  if (!count) return { incoming: { x: 0, y: 0 }, outgoing: { x: 0, y: 0 } };
  const current = points[index];
  const prev = index > 0 ? points[index - 1] : (closed ? points[count - 1] : null);
  const next = index < count - 1 ? points[index + 1] : (closed ? points[0] : null);
  const incoming = prev
    ? { x: (current.x - prev.x) * 0.5, y: (current.y - prev.y) * 0.5 }
    : next
      ? { x: (next.x - current.x) * 0.5, y: (next.y - current.y) * 0.5 }
      : { x: 0, y: 0 };
  const outgoing = next
    ? { x: (next.x - current.x) * 0.5, y: (next.y - current.y) * 0.5 }
    : prev
      ? { x: (current.x - prev.x) * 0.5, y: (current.y - prev.y) * 0.5 }
      : { x: 0, y: 0 };
  if (current?.connector === 'sharp') return { incoming, outgoing };
  const smooth = prev && next
    ? { x: (next.x - prev.x) * 0.35, y: (next.y - prev.y) * 0.35 }
    : next
      ? { x: (next.x - current.x) * 0.5, y: (next.y - current.y) * 0.5 }
      : prev
        ? { x: (current.x - prev.x) * 0.5, y: (current.y - prev.y) * 0.5 }
        : { x: 0, y: 0 };
  return { incoming: smooth, outgoing: smooth };
}

function _normalizeSimulationPathPoints(points) {
  return Array.isArray(points)
    ? points
        .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
        .map(point => ({ x: point.x, y: point.y }))
    : [];
}

function _smoothSimulationPathPoints(points, closed = false, iterations = 2) {
  let current = _normalizeSimulationPathPoints(points);
  if (current.length < 3) return current;
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (current.length < 2) break;
    const next = [];
    if (!closed) next.push({ x: current[0].x, y: current[0].y });
    const segmentCount = closed ? current.length : current.length - 1;
    for (let index = 0; index < segmentCount; index++) {
      const a = current[index];
      const b = current[(index + 1) % current.length];
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25,
      });
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75,
      });
    }
    if (!closed) {
      const last = current[current.length - 1];
      next.push({ x: last.x, y: last.y });
    }
    current = next;
  }
  return current;
}

function _sampleMotionPathBezierSegment(points, startIndex, closed = false) {
  const count = Array.isArray(points) ? points.length : 0;
  const endIndex = closed ? ((startIndex + 1) % count) : startIndex + 1;
  const start = points[startIndex];
  const end = points[endIndex];
  if (!start || !end) return [];
  const startTangents = _getMotionPathBezierTangents(points, startIndex, closed);
  const endTangents = _getMotionPathBezierTangents(points, endIndex, closed);
  const sampled = [];
  for (let i = 0; i <= MOTION_PATH_CURVE_SAMPLES; i++) {
    sampled.push(_sampleCubicHermitePoint(start, end, startTangents.outgoing, endTangents.incoming, i / MOTION_PATH_CURVE_SAMPLES));
  }
  return sampled;
}

function _findMotionPathBezierInsertIndex(points, localX, localY, closed = false) {
  if (!Array.isArray(points) || points.length < 2) return points?.length || 0;
  const segmentCount = closed ? points.length : points.length - 1;
  let bestIndex = points.length;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
    const sampled = _sampleMotionPathBezierSegment(points, segmentIndex, closed);
    for (let i = 1; i < sampled.length; i++) {
      const hit = _closestPointOnSegment(localX, localY, sampled[i - 1].x, sampled[i - 1].y, sampled[i].x, sampled[i].y);
      if (hit.distance < bestDistance) {
        bestDistance = hit.distance;
        bestIndex = segmentIndex + 1;
      }
    }
  }
  return Math.min(Math.max(bestIndex, 0), points.length);
}

function _normalizeMotionPathEndBehavior(value) {
  return ['restart', 'bounce', 'random', 'stop', 'reverse'].includes(value) ? value : 'restart';
}

function _normalizeMotionPathDirectionMode(value) {
  return ['forward', 'reverse', 'alternate', 'random'].includes(value) ? value : 'forward';
}

function _normalizeMotionPathStartMode(value) {
  return value === 'random' ? 'random' : 'spread';
}

function _getMotionPathStartModeLabel(value) {
  return _normalizeMotionPathStartMode(value) === 'random' ? 'Random Start' : 'Even Start';
}

function _getMotionPathDeterministicStartUnit(documentId, updatedAt, pathId, agentIndex, totalAgents) {
  const seed = (
    (Number.isFinite(documentId) ? documentId : 0) * 73856093
    + (Number.isFinite(pathId) ? pathId : 0) * 19349663
    + Math.round((Number.isFinite(updatedAt) ? updatedAt : 0) % 2147483647)
    + (agentIndex + 1) * 83492791
    + (totalAgents + 1) * 2654435761
  );
  const raw = Math.sin(seed * 0.00000123791) * 43758.5453123;
  return raw - Math.floor(raw);
}

function _getMotionPathDirectionModeLabel(value) {
  switch (_normalizeMotionPathDirectionMode(value)) {
    case 'reverse': return 'Dir Rev';
    case 'alternate': return 'Dir Alt';
    case 'random': return 'Dir Rnd';
    default: return 'Dir Fwd';
  }
}

function _getMotionPathDirectionArrowAngle(mode, markerIndex, baseAngle) {
  switch (_normalizeMotionPathDirectionMode(mode)) {
    case 'reverse':
      return baseAngle + Math.PI;
    case 'alternate':
      return markerIndex % 2 === 0 ? baseAngle : baseAngle + Math.PI;
    case 'random':
      return markerIndex % 3 === 1 ? baseAngle + Math.PI : baseAngle;
    default:
      return baseAngle;
  }
}

function _getMotionPathEndBehaviorLabel(value) {
  switch (_normalizeMotionPathEndBehavior(value)) {
    case 'bounce': return 'Bounce';
    case 'random': return 'Random';
    case 'stop': return 'Stop';
    case 'reverse': return 'Reverse';
    default: return 'Restart';
  }
}

function _getMotionPathEndBehaviorAccent(value) {
  switch (_normalizeMotionPathEndBehavior(value)) {
    case 'bounce': return 'rgba(255,196,92,0.95)';
    case 'random': return 'rgba(185,122,255,0.95)';
    case 'stop': return 'rgba(255,120,120,0.95)';
    case 'reverse': return 'rgba(120,208,255,0.95)';
    default: return 'rgba(118,214,152,0.95)';
  }
}

function _resampleMotionPathPoints(points, step = MOTION_PATH_RESAMPLE_STEP, closed = false) {
  const valid = Array.isArray(points)
    ? points
        .filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
        .map(pt => ({
          x: pt.x,
          y: pt.y,
          stampScale: Number.isFinite(pt?.stampScale) ? pt.stampScale : 1,
          speedScale: Number.isFinite(pt?.speedScale) ? pt.speedScale : 1,
        }))
    : [];
  if (valid.length < 2) return valid;
  const output = [{ ...valid[0] }];
  const appendSegment = (a, b) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 1e-6) return;
    const steps = Math.max(1, Math.ceil(length / Math.max(1, step)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      output.push({
        x: _lerp(a.x, b.x, t),
        y: _lerp(a.y, b.y, t),
        stampScale: _lerp(
          Number.isFinite(a?.stampScale) ? a.stampScale : 1,
          Number.isFinite(b?.stampScale) ? b.stampScale : 1,
          t,
        ),
        speedScale: _lerp(
          Number.isFinite(a?.speedScale) ? a.speedScale : 1,
          Number.isFinite(b?.speedScale) ? b.speedScale : 1,
          t,
        ),
      });
    }
  };
  for (let i = 1; i < valid.length; i++) appendSegment(valid[i - 1], valid[i]);
  if (closed) appendSegment(valid[valid.length - 1], valid[0]);
  return output;
}

function _chaikinSmoothMotionPathPoints(points, closed = false) {
  const valid = Array.isArray(points)
    ? points
        .filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
        .map(pt => ({
          x: pt.x,
          y: pt.y,
          stampScale: Number.isFinite(pt?.stampScale) ? pt.stampScale : 1,
          speedScale: Number.isFinite(pt?.speedScale) ? pt.speedScale : 1,
        }))
    : [];
  if (valid.length < 2) return valid;
  if (closed) {
    const output = [];
    for (let i = 0; i < valid.length; i++) {
      const a = valid[i];
      const b = valid[(i + 1) % valid.length];
      output.push(
        {
          x: _lerp(a.x, b.x, 0.25),
          y: _lerp(a.y, b.y, 0.25),
          stampScale: _lerp(a.stampScale, b.stampScale, 0.25),
          speedScale: _lerp(a.speedScale, b.speedScale, 0.25),
        },
        {
          x: _lerp(a.x, b.x, 0.75),
          y: _lerp(a.y, b.y, 0.75),
          stampScale: _lerp(a.stampScale, b.stampScale, 0.75),
          speedScale: _lerp(a.speedScale, b.speedScale, 0.75),
        },
      );
    }
    return output;
  }
  const output = [{ ...valid[0] }];
  for (let i = 0; i < valid.length - 1; i++) {
    const a = valid[i];
    const b = valid[i + 1];
    output.push(
      {
        x: _lerp(a.x, b.x, 0.25),
        y: _lerp(a.y, b.y, 0.25),
        stampScale: _lerp(a.stampScale, b.stampScale, 0.25),
        speedScale: _lerp(a.speedScale, b.speedScale, 0.25),
      },
      {
        x: _lerp(a.x, b.x, 0.75),
        y: _lerp(a.y, b.y, 0.75),
        stampScale: _lerp(a.stampScale, b.stampScale, 0.75),
        speedScale: _lerp(a.speedScale, b.speedScale, 0.75),
      },
    );
  }
  output.push({ ...valid[valid.length - 1] });
  return output;
}

function _smoothMotionPathTrackPoints(points, amount = 0, closed = false, step = MOTION_PATH_RESAMPLE_STEP) {
  const smoothing = _clamp01(amount);
  let working = _resampleMotionPathPoints(points, step, closed);
  if (smoothing <= 0 || working.length < 3) return working;
  const passes = Math.max(1, Math.round(smoothing * 4));
  for (let i = 0; i < passes; i++) {
    working = _chaikinSmoothMotionPathPoints(working, closed);
    working = _resampleMotionPathPoints(working, step, closed);
  }
  return working;
}

function _sampleMotionPathArrowMarkers(points, spacing = 72, startOffset = 26) {
  const valid = Array.isArray(points)
    ? points.filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y)).map(pt => ({ x: pt.x, y: pt.y }))
    : [];
  if (valid.length < 2) return [];
  const markers = [];
  let distanceUntilNext = Math.max(1, startOffset);
  for (let i = 1; i < valid.length; i++) {
    const a = valid[i - 1];
    const b = valid[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segmentLength = Math.hypot(dx, dy);
    if (segmentLength <= 1e-6) continue;
    let consumed = 0;
    while (consumed + distanceUntilNext <= segmentLength) {
      const t = (consumed + distanceUntilNext) / segmentLength;
      markers.push({
        x: a.x + dx * t,
        y: a.y + dy * t,
        angle: Math.atan2(dy, dx),
      });
      consumed += distanceUntilNext;
      distanceUntilNext = Math.max(18, spacing);
    }
    distanceUntilNext -= (segmentLength - consumed);
    if (distanceUntilNext <= 1e-6) distanceUntilNext = Math.max(18, spacing);
  }
  return markers;
}

function _sampleMotionPathPrimitive(pathItem, step = MOTION_PATH_RESAMPLE_STEP) {
  const kind = pathItem?.kind || 'polyline';
  const points = _normalizeMotionPathPoints(kind, pathItem?.points);
  if (kind === 'rectangle' || kind === 'ellipse') {
    if (points.length < 2) return [];
    const a = points[0];
    const b = points[1];
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    if (kind === 'rectangle') {
      return _resampleMotionPathPoints([
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ], step, true);
    }
    const rx = Math.max(1, (right - left) * 0.5);
    const ry = Math.max(1, (bottom - top) * 0.5);
    const cx = (left + right) * 0.5;
    const cy = (top + bottom) * 0.5;
    const circumference = Math.PI * (3 * (rx + ry) - Math.sqrt(Math.max(0, ((3 * rx) + ry) * (rx + (3 * ry)))));
    const samples = Math.max(MOTION_PATH_ELLIPSE_MIN_SAMPLES, Math.ceil(circumference / Math.max(1, step)));
    const ellipsePoints = [];
    for (let i = 0; i <= samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      ellipsePoints.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
    }
    return ellipsePoints;
  }
  if (kind === 'bezier') {
    if (points.length < 2) return points.map(point => ({ x: point.x, y: point.y }));
    const sampled = [];
    const segmentCount = !!pathItem?.closed ? points.length : points.length - 1;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
      const segmentPoints = _sampleMotionPathBezierSegment(points, segmentIndex, !!pathItem?.closed);
      if (!segmentPoints.length) continue;
      segmentPoints.forEach((point, index) => {
        if (segmentIndex > 0 && index === 0) return;
        sampled.push(point);
      });
    }
    return _resampleMotionPathPoints(sampled, step, !!pathItem?.closed);
  }
  if (kind === 'radial') {
    return _resampleMotionPathPoints(_buildMotionPathRadialPoints(pathItem), step, false);
  }
  return _resampleMotionPathPoints(points, step, !!pathItem?.closed);
}

function _buildMotionPathTrack(points, closed = false) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const segmentLengths = [];
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segmentLengths.push(length);
    totalLength += length;
  }
  if (totalLength <= 1e-6) return null;
  return { points, segmentLengths, totalLength, closed };
}

function _sampleMotionPathTrack(track, distanceAlongPath) {
  if (!track?.points?.length) return null;
  if (track.points.length === 1) {
    return {
      x: track.points[0].x,
      y: track.points[0].y,
      angle: 0,
      stampScale: Number.isFinite(track.points[0]?.stampScale) ? track.points[0].stampScale : 1,
      speedScale: Number.isFinite(track.points[0]?.speedScale) ? track.points[0].speedScale : 1,
    };
  }
  const total = Math.max(track.totalLength || 0, 1e-6);
  const distance = track.closed
    ? _wrapIndex(distanceAlongPath, total)
    : _clamp(distanceAlongPath, 0, total);
  let remaining = distance;
  for (let i = 1; i < track.points.length; i++) {
    const length = track.segmentLengths[i - 1] || 0;
    if (remaining <= length || i === track.points.length - 1) {
      const a = track.points[i - 1];
      const b = track.points[i];
      const t = length <= 1e-6 ? 0 : remaining / length;
      return {
        x: _lerp(a.x, b.x, t),
        y: _lerp(a.y, b.y, t),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        stampScale: _lerp(
          Number.isFinite(a?.stampScale) ? a.stampScale : 1,
          Number.isFinite(b?.stampScale) ? b.stampScale : 1,
          t,
        ),
        speedScale: _lerp(
          Number.isFinite(a?.speedScale) ? a.speedScale : 1,
          Number.isFinite(b?.speedScale) ? b.speedScale : 1,
          t,
        ),
      };
    }
    remaining -= length;
  }
  const last = track.points[track.points.length - 1];
  const prev = track.points[track.points.length - 2] || last;
  return {
    x: last.x,
    y: last.y,
    angle: Math.atan2(last.y - prev.y, last.x - prev.x),
    stampScale: Number.isFinite(last?.stampScale) ? last.stampScale : 1,
    speedScale: Number.isFinite(last?.speedScale) ? last.speedScale : 1,
  };
}

function _sampleQuadraticBezierPoint(start, control, end, t) {
  const clamped = _clamp01(t);
  const inv = 1 - clamped;
  return {
    x: inv * inv * start.x + 2 * inv * clamped * control.x + clamped * clamped * end.x,
    y: inv * inv * start.y + 2 * inv * clamped * control.y + clamped * clamped * end.y,
  };
}

function _parseSymmetrySizeMultipliers(value) {
  if (Array.isArray(value)) {
    const parsed = value
      .map(entry => Number.parseFloat(String(entry).replace(/×/g, '').trim()))
      .filter(entry => Number.isFinite(entry) && entry > 0);
    return parsed.length ? parsed : [1];
  }
  const parsed = String(value ?? '')
    .split(/[,\s;|/]+/)
    .map(entry => Number.parseFloat(entry.replace(/×/g, '').trim()))
    .filter(entry => Number.isFinite(entry) && entry > 0);
  return parsed.length ? parsed : [1];
}

function _buildPolylineSegments(points, closed = false) {
  const validPoints = Array.isArray(points)
    ? points.filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    : [];
  const segments = [];
  let totalLength = 0;
  for (let i = 1; i < validPoints.length; i++) {
    const a = validPoints[i - 1];
    const b = validPoints[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 1e-6) continue;
    segments.push({ a, b, length });
    totalLength += length;
  }

  if (closed && validPoints.length > 2) {
    const a = validPoints[validPoints.length - 1];
    const b = validPoints[0];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 1e-6) {
      segments.push({ a, b, length });
      totalLength += length;
    }
  }
  return { validPoints, segments, totalLength };
}

function _samplePolylinePointAtDistance(points, distanceAlongPath, closed = false) {
  const { validPoints, segments, totalLength } = _buildPolylineSegments(points, closed);
  if (validPoints.length === 0) return null;
  if (validPoints.length === 1) {
    return { x: validPoints[0].x, y: validPoints[0].y, tangentX: 1, tangentY: 0, totalLength: 0, distance: 0 };
  }
  if (!segments.length || totalLength <= 1e-6) return { x: validPoints[0].x, y: validPoints[0].y };

  let distance = closed
    ? _wrapIndex(distanceAlongPath, totalLength)
    : _clamp(distanceAlongPath, 0, totalLength);

  for (const segment of segments) {
    if (distance <= segment.length) {
      const t = segment.length <= 1e-6 ? 0 : distance / segment.length;
      const tangentX = segment.length <= 1e-6 ? 1 : (segment.b.x - segment.a.x) / segment.length;
      const tangentY = segment.length <= 1e-6 ? 0 : (segment.b.y - segment.a.y) / segment.length;
      return {
        x: _lerp(segment.a.x, segment.b.x, t),
        y: _lerp(segment.a.y, segment.b.y, t),
        tangentX,
        tangentY,
        totalLength,
        distance,
      };
    }
    distance -= segment.length;
  }

  const last = segments[segments.length - 1];
  return {
    x: last.b.x,
    y: last.b.y,
    tangentX: last.length <= 1e-6 ? 1 : (last.b.x - last.a.x) / last.length,
    tangentY: last.length <= 1e-6 ? 0 : (last.b.y - last.a.y) / last.length,
    totalLength,
    distance: totalLength,
  };
}

function _getClosestPolylineDistance(points, x, y, closed = false) {
  const { validPoints, segments, totalLength } = _buildPolylineSegments(points, closed);
  if (!validPoints.length) return null;
  if (validPoints.length === 1 || !segments.length || totalLength <= 1e-6) {
    return {
      x: validPoints[0].x,
      y: validPoints[0].y,
      tangentX: 1,
      tangentY: 0,
      totalLength: 0,
      distanceAlongPath: 0,
      distance: Math.hypot(x - validPoints[0].x, y - validPoints[0].y),
    };
  }
  let traversed = 0;
  let best = null;
  for (const segment of segments) {
    const hit = _closestPointOnSegment(x, y, segment.a.x, segment.a.y, segment.b.x, segment.b.y);
    if (!best || hit.distance < best.distance) {
      best = {
        x: hit.x,
        y: hit.y,
        tangentX: segment.length <= 1e-6 ? 1 : (segment.b.x - segment.a.x) / segment.length,
        tangentY: segment.length <= 1e-6 ? 0 : (segment.b.y - segment.a.y) / segment.length,
        totalLength,
        distanceAlongPath: traversed + (segment.length * hit.t),
        distance: hit.distance,
      };
    }
    traversed += segment.length;
  }
  return best;
}

function _pathInfluenceFalloff(distance, radius, influenceRadius) {
  const innerRadius = Math.max(1, radius || 0);
  const outerRadius = Math.max(innerRadius, influenceRadius || innerRadius);
  if (distance <= innerRadius) return 1;
  if (distance >= outerRadius) return 0;
  const innerSq = innerRadius * innerRadius;
  const outerSq = outerRadius * outerRadius;
  const distanceSq = Math.max(distance * distance, 1);
  const gravity = 1 / distanceSq;
  const innerGravity = 1 / innerSq;
  const outerGravity = 1 / outerSq;
  const denom = innerGravity - outerGravity;
  if (denom <= 1e-6) return 0;
  return Math.max(0, Math.min(1, (gravity - outerGravity) / denom));
}

function _smoothstep01(value) {
  const t = _clamp01(value);
  return t * t * (3 - (2 * t));
}

function _normalizeSimulationPathPrimitiveKind(value) {
  return SIM_PATH_PRIMITIVE_KINDS.includes(value) ? value : '';
}

function _normalizeSimulationPathType(value) {
  return value === 'stroke' ? 'stroke' : 'standard';
}

function _normalizeSimulationPathSpeed(value) {
  return _clamp(Number.isFinite(value) ? value : DEFAULT_SIM_PATH_SPEED, SIM_PATH_SPEED_MIN, SIM_PATH_SPEED_MAX);
}

function _getSimulationPathBounds(points) {
  const validPoints = Array.isArray(points)
    ? points.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    : [];
  if (!validPoints.length) return null;
  let minX = validPoints[0].x;
  let maxX = validPoints[0].x;
  let minY = validPoints[0].y;
  let maxY = validPoints[0].y;
  for (const point of validPoints) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) * 0.5,
    centerY: (minY + maxY) * 0.5,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function _buildSimulationPathPrimitivePoints(pathItem) {
  const primitiveKind = _normalizeSimulationPathPrimitiveKind(pathItem?.primitiveKind);
  if (!primitiveKind) return [];
  const centerX = Number.isFinite(pathItem?.centerX) ? pathItem.centerX : 0;
  const centerY = Number.isFinite(pathItem?.centerY) ? pathItem.centerY : 0;
  const radiusX = Math.max(8, Number.isFinite(pathItem?.primitiveRadius) ? pathItem.primitiveRadius : SIM_PATH_PRIMITIVE_DEFAULT_RADIUS);
  const radiusY = Math.max(8, Number.isFinite(pathItem?.primitiveRadiusY)
    ? pathItem.primitiveRadiusY
    : (primitiveKind === 'ellipse' ? radiusX * SIM_PATH_PRIMITIVE_DEFAULT_ELLIPSE_RATIO : radiusX));
  if (primitiveKind === 'square') {
    return [
      { x: centerX - radiusX, y: centerY - radiusY },
      { x: centerX + radiusX, y: centerY - radiusY },
      { x: centerX + radiusX, y: centerY + radiusY },
      { x: centerX - radiusX, y: centerY + radiusY },
    ];
  }
  if (primitiveKind === 'diamond') {
    return [
      { x: centerX, y: centerY - radiusY },
      { x: centerX + radiusX, y: centerY },
      { x: centerX, y: centerY + radiusY },
      { x: centerX - radiusX, y: centerY },
    ];
  }
  if (primitiveKind === 'star') {
    const points = [];
    for (let index = 0; index < 10; index++) {
      const angle = (-Math.PI * 0.5) + ((Math.PI * 2 * index) / 10);
      const useOuter = index % 2 === 0;
      const rx = useOuter ? radiusX : radiusX * SIM_PATH_STAR_INNER_RATIO;
      const ry = useOuter ? radiusY : radiusY * SIM_PATH_STAR_INNER_RATIO;
      points.push({ x: centerX + Math.cos(angle) * rx, y: centerY + Math.sin(angle) * ry });
    }
    return points;
  }
  const samples = SIM_PATH_PRIMITIVE_SAMPLE_COUNT;
  const points = [];
  for (let index = 0; index < samples; index++) {
    const angle = (index / samples) * Math.PI * 2;
    points.push({
      x: centerX + Math.cos(angle) * radiusX,
      y: centerY + Math.sin(angle) * (primitiveKind === 'ellipse' ? radiusY : radiusX),
    });
  }
  return points;
}

function _rebuildSimulationPathPrimitive(pathItem) {
  if (!pathItem) return;
  const primitiveKind = _normalizeSimulationPathPrimitiveKind(pathItem.primitiveKind);
  if (!primitiveKind) return;
  pathItem.points = _buildSimulationPathPrimitivePoints(pathItem);
}

function _normalizeSimulationPathSpeedPoints(points, nextIdRef) {
  const rawPoints = Array.isArray(points) ? points : [];
  return rawPoints
    .filter(point => Number.isFinite(point?.t) || Number.isFinite(point?.speed))
    .map(point => ({
      id: Number.isFinite(point?.id) ? point.id : nextIdRef(),
      t: _clamp01(Number.isFinite(point?.t) ? point.t : 0.5),
      speed: _normalizeSimulationPathSpeed(point?.speed),
    }))
    .sort((left, right) => left.t - right.t);
}

function _normalizeSimulationPathRadiusPoints(points, nextIdRef, fallbackRadius = DEFAULT_PATH_RADIUS) {
  const rawPoints = Array.isArray(points) ? points : [];
  return rawPoints
    .filter(point => Number.isFinite(point?.t) || Number.isFinite(point?.radius))
    .map(point => ({
      id: Number.isFinite(point?.id) ? point.id : nextIdRef(),
      t: _clamp01(Number.isFinite(point?.t) ? point.t : 0.5),
      radius: Math.max(1, Number.isFinite(point?.radius) ? point.radius : fallbackRadius),
    }))
    .sort((left, right) => left.t - right.t);
}

function _normalizeSimulationPathStrength(value) {
  return _clamp(Number.isFinite(value) ? value : DEFAULT_PATH_STRENGTH, SIM_PATH_STRENGTH_MIN, SIM_PATH_STRENGTH_MAX);
}

function _normalizeSimulationPathStrengthPoints(points, nextIdRef, fallbackStrength = DEFAULT_PATH_STRENGTH) {
  const rawPoints = Array.isArray(points) ? points : [];
  return rawPoints
    .filter(point => Number.isFinite(point?.t) || Number.isFinite(point?.strength))
    .map(point => ({
      id: Number.isFinite(point?.id) ? point.id : nextIdRef(),
      t: _clamp01(Number.isFinite(point?.t) ? point.t : 0.5),
      strength: _normalizeSimulationPathStrength(Number.isFinite(point?.strength) ? point.strength : fallbackStrength),
    }))
    .sort((left, right) => left.t - right.t);
}

function _getSimulationPathStrengthAt(pathItem, pathT, baseStrength = DEFAULT_PATH_STRENGTH, closed = false) {
  const points = Array.isArray(pathItem?.strengthPoints) ? pathItem.strengthPoints.slice().sort((left, right) => left.t - right.t) : [];
  const fallbackStrength = _normalizeSimulationPathStrength(baseStrength);
  if (!points.length) return fallbackStrength;
  const t = closed ? _wrapIndex(pathT, 1) : _clamp01(pathT);
  if (closed) {
    if (points.length === 1) return _normalizeSimulationPathStrength(points[0].strength);
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index];
      const next = points[index + 1];
      if (t < start.t || t > next.t) continue;
      const span = Math.max(1e-6, next.t - start.t);
      const mix = _smoothstep01((t - start.t) / span);
      return _lerp(start.strength, next.strength, mix);
    }
    const start = points[points.length - 1];
    const next = points[0];
    const sampleT = t < next.t ? t + 1 : t;
    const endT = next.t + 1;
    const span = Math.max(1e-6, endT - start.t);
    const mix = _smoothstep01((sampleT - start.t) / span);
    return _lerp(start.strength, next.strength, mix);
  }
  const nodes = [{ t: 0, strength: fallbackStrength }, ...points, { t: 1, strength: fallbackStrength }];
  for (let index = 1; index < nodes.length; index++) {
    const start = nodes[index - 1];
    const end = nodes[index];
    if (t > end.t && index < nodes.length - 1) continue;
    const span = Math.max(1e-6, end.t - start.t);
    const mix = _smoothstep01((t - start.t) / span);
    return _lerp(start.strength, end.strength, mix);
  }
  return nodes[nodes.length - 1].strength;
}

function _getNextSimulationPathControlPointT(points, closed = false) {
  const values = (Array.isArray(points) ? points : [])
    .map(point => _clamp01(Number.isFinite(point?.t) ? point.t : NaN))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!values.length) return 0.5;
  const epsilon = 1e-4;

  if (closed) {
    let bestStart = values[0];
    let bestSpan = -1;
    for (let index = 0; index < values.length; index++) {
      const start = values[index];
      const end = index === values.length - 1 ? values[0] + 1 : values[index + 1];
      const span = end - start;
      if (span > bestSpan) {
        bestSpan = span;
        bestStart = start;
      }
    }
    if (!(bestSpan > epsilon)) return _wrapIndex(values[values.length - 1] + 0.15, 1);
    return _wrapIndex(bestStart + (bestSpan * 0.5), 1);
  }

  const nodes = [0, ...values, 1];
  let bestStart = 0;
  let bestEnd = 1;
  let bestSpan = -1;
  for (let index = 1; index < nodes.length; index++) {
    const start = nodes[index - 1];
    const end = nodes[index];
    const span = end - start;
    if (span > bestSpan) {
      bestSpan = span;
      bestStart = start;
      bestEnd = end;
    }
  }
  if (!(bestSpan > epsilon)) return _clamp01(values[values.length - 1] + 0.15);
  return _clamp01(bestStart + ((bestEnd - bestStart) * 0.5));
}

function _sanitizeSimulationHandles(handles) {
  return (Array.isArray(handles) ? handles : []).filter(handle => (
    Number.isFinite(handle?.x) &&
    Number.isFinite(handle?.y) &&
    Number.isFinite(Number.isFinite(handle?.anchorX) ? handle.anchorX : handle?.x) &&
    Number.isFinite(Number.isFinite(handle?.anchorY) ? handle.anchorY : handle?.y)
  ));
}

function _getSimulationPathSpeedAt(pathItem, pathT, baseSpeed = DEFAULT_SIM_PATH_SPEED, closed = false) {
  const points = Array.isArray(pathItem?.speedPoints) ? pathItem.speedPoints.slice().sort((left, right) => left.t - right.t) : [];
  const fallbackSpeed = _normalizeSimulationPathSpeed(baseSpeed);
  if (!points.length) return fallbackSpeed;
  const t = closed ? _wrapIndex(pathT, 1) : _clamp01(pathT);
  if (closed) {
    if (points.length === 1) return points[0].speed;
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index];
      const next = points[index + 1];
      if (t < start.t || t > next.t) continue;
      const span = Math.max(1e-6, next.t - start.t);
      const mix = _smoothstep01((t - start.t) / span);
      return _lerp(start.speed, next.speed, mix);
    }
    const start = points[points.length - 1];
    const next = points[0];
    const sampleT = t < next.t ? t + 1 : t;
    const endT = next.t + 1;
    const span = Math.max(1e-6, endT - start.t);
    const mix = _smoothstep01((sampleT - start.t) / span);
    return _lerp(start.speed, next.speed, mix);
  }
  const nodes = [{ t: 0, speed: fallbackSpeed }, ...points, { t: 1, speed: fallbackSpeed }];
  for (let index = 1; index < nodes.length; index++) {
    const start = nodes[index - 1];
    const end = nodes[index];
    if (t > end.t && index < nodes.length - 1) continue;
    const span = Math.max(1e-6, end.t - start.t);
    const mix = _smoothstep01((t - start.t) / span);
    return _lerp(start.speed, end.speed, mix);
  }
  return nodes[nodes.length - 1].speed;
}

function _getSimulationPathRadiusAt(pathItem, pathT, baseRadius = DEFAULT_PATH_RADIUS, closed = false) {
  const points = Array.isArray(pathItem?.radiusPoints) ? pathItem.radiusPoints.slice().sort((left, right) => left.t - right.t) : [];
  const fallbackRadius = Math.max(1, Number.isFinite(baseRadius) ? baseRadius : DEFAULT_PATH_RADIUS);
  if (!points.length) return fallbackRadius;
  const t = closed ? _wrapIndex(pathT, 1) : _clamp01(pathT);
  if (closed) {
    if (points.length === 1) return Math.max(1, points[0].radius);
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index];
      const next = points[index + 1];
      if (t < start.t || t > next.t) continue;
      const span = Math.max(1e-6, next.t - start.t);
      const mix = _smoothstep01((t - start.t) / span);
      return Math.max(1, _lerp(start.radius, next.radius, mix));
    }
    const start = points[points.length - 1];
    const next = points[0];
    const sampleT = t < next.t ? t + 1 : t;
    const endT = next.t + 1;
    const span = Math.max(1e-6, endT - start.t);
    const mix = _smoothstep01((sampleT - start.t) / span);
    return Math.max(1, _lerp(start.radius, next.radius, mix));
  }
  const nodes = [{ t: 0, radius: fallbackRadius }, ...points, { t: 1, radius: fallbackRadius }];
  for (let index = 1; index < nodes.length; index++) {
    const start = nodes[index - 1];
    const end = nodes[index];
    if (t > end.t && index < nodes.length - 1) continue;
    const span = Math.max(1e-6, end.t - start.t);
    const mix = _smoothstep01((t - start.t) / span);
    return Math.max(1, _lerp(start.radius, end.radius, mix));
  }
  return Math.max(1, nodes[nodes.length - 1].radius);
}

/**
 * Sample a point along a polyline using an absolute traveled distance.
 * Closed paths wrap continuously; open paths ping-pong forward and backward.
 */
function _samplePolylinePoint(points, distanceAlongPath, closed = false) {
  const initial = _samplePolylinePointAtDistance(points, 0, closed);
  if (!initial) return null;
  const totalLength = initial.totalLength || 0;
  if (closed) return _samplePolylinePointAtDistance(points, distanceAlongPath, true);
  const pingPongDistance = totalLength <= 1e-6
    ? 0
    : _wrapIndex(distanceAlongPath, totalLength * 2);
  const distance = pingPongDistance <= totalLength ? pingPongDistance : (totalLength * 2) - pingPongDistance;
  return _samplePolylinePointAtDistance(points, distance, false);
}

function _capitalizeTextureChannel(name) {
  return name ? name[0].toUpperCase() + name.slice(1) : '';
}

function _hashNoise2D(x, y, seed = 0) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 101.3) * 43758.5453123;
  return n - Math.floor(n);
}

function _smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function _normalizeHexColor(value, fallback = '') {
  let hex = String(value || '').trim();
  if (!hex) return fallback;
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex)) return fallback;
  if (hex.length === 4) {
    hex = `#${hex.slice(1).split('').map(ch => ch + ch).join('')}`;
  }
  return hex.toLowerCase();
}

function _valueNoise2D(x, y, scale, seed = 0) {
  const sx = x / scale;
  const sy = y / scale;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const tx = _smoothstep(sx - x0);
  const ty = _smoothstep(sy - y0);
  const n00 = _hashNoise2D(x0, y0, seed);
  const n10 = _hashNoise2D(x0 + 1, y0, seed);
  const n01 = _hashNoise2D(x0, y0 + 1, seed);
  const n11 = _hashNoise2D(x0 + 1, y0 + 1, seed);
  const nx0 = _lerp(n00, n10, tx);
  const nx1 = _lerp(n01, n11, tx);
  return _lerp(nx0, nx1, ty);
}

export class App {
  constructor() {
    // DOM
    this.compositeCanvas = document.getElementById('compositeDisplay');
    this.liveCanvas = document.getElementById('liveCanvas');
    this.interactionCanvas = document.getElementById('interactionCanvas');
    this.canvasFrame = document.getElementById('canvasFrame');
    this.statusEl = document.getElementById('status');
    this.toastEl = document.getElementById('toast');

    // Canvas contexts
    this.lctx = null;
    this.DPR = 1;
    this.W = 0;
    this.H = 0;
    this._workspaceMargin = WORKSPACE_MARGIN_PX;

    // Layers
    this.layers = [];
    this.activeLayerIdx = 0;
    this._nextLayerId = 1;
    this._sensingSourceSelection = [];
    this._sensingSourcePickerAnchor = null;
    this._sensingSourcePickerPanel = null;
    this._sensingSourcePickerPointerHandler = null;
    this._sensingSourcePickerKeyHandler = null;

    // Undo/redo
    this.undoStack = [];
    this.redoStack = [];

    // Compositor
    this.compositor = null;

    // Brush engines
    this.brushes = {};
    this.sharedMotionSim = null;
    this.sharedMotionSimPromise = null;
    this.sharedMotionSimEpoch = 0;
    this.activeBrush = 'boid';

    // Drawing state
    this.isDrawing = false;
    this.pressure = 0.5;
    this._rawPressure = 0.5;  // unsmoothed pressure for EMA calculation
    this.tiltX = 0;       // stylus tilt in degrees (-90..90)
    this.tiltY = 0;
    this.azimuth = 0;     // stylus azimuth in radians (0..2π)
    this.altitude = Math.PI / 2; // stylus altitude (π/2 = vertical)
    this.prevAzimuth = 0;
    this.azimuthDeltaDeg = 0;
    this.azimuthUpdateCount = 0;
    this.penAngleSampleValid = false; // true once we have any real azimuth sample
    this.penEventHasAngles = false;   // true for the current/last processed pen event
    this.penAngleSource = 'none';     // 'azimuthAngle' | 'tilt' | 'none'
    this.pointerType = 'mouse';  // last pointer type ('mouse', 'pen', 'touch')
    this.leaderX = 0;
    this.leaderY = 0;
    this.undoPushedThisStroke = false;

    // Stabilizer (lazy mouse)
    this._stabX = 0;
    this._stabY = 0;
    this._strokeWave = {
      active: false,
      lastBaseX: Number.NaN,
      lastBaseY: Number.NaN,
      distance: 0,
      tangentX: 1,
      tangentY: 0,
    };

    // View transform (pinch zoom/rotate/pan)
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.viewRotation = 0; // radians
    this._pinchActive = false;
    this._pinchStartDist = 0;
    this._pinchStartAngle = 0;
    this._pinchStartZoom = 1;
    this._pinchStartRotation = 0;
    this._pinchStartPanX = 0;
    this._pinchStartPanY = 0;
    this._pinchStartMidX = 0;
    this._pinchStartMidY = 0;
    this._pinchAnchor = { x: 0, y: 0 };
    this._activePointers = new Map();

    // Flip view
    this.viewFlipped = false;
    this.viewBookmarks = [];
    this.lastChangeMarker = null;

    // Tiling mode
    this.tilingMode = false;

    // Cursor preview position (screen-relative to canvasArea)
    this._cursorX = -1;
    this._cursorY = -1;

    // Taper state
    this.isTapering = false;
    this.taperFrame = 0;
    this.taperTotal = 0;
    this.strokeFrame = 0;

    // Params
    this._paramsDirty = true;
    this._cachedP = null;
    this.symmetry = this._createDefaultSymmetryState();
    this._symmetryDrag = null;
    this._symmetryStrokeState = null;

    // Canvas texture
    this._builtinCanvasTextures = new Map();
    this._canvasTexture = null;
    this._customCanvasTexture = null;
    this._activeCanvasTextureId = DEFAULT_CANVAS_TEXTURE_ID;
    this._customStampImage = null;
    this._stampTintCanvas = null;
    this._stampTintCtx = null;

    // Smudge: cached image data for colour sampling (invalidated each composite)
    this._smudgeImageData = null;

    // Height map for impasto (greyscale accumulation of paint thickness)
    this._heightCanvas = null;
    this._heightCtx = null;
    this._heightDirty = false;
    this._impastoOverlayCanvas = null;

    // Reusable 1×1 canvas for CSS color parsing (smudge)
    this._colorParseCanvas = document.createElement('canvas');
    this._colorParseCanvas.width = 1;
    this._colorParseCanvas.height = 1;
    this._colorParseCtx = this._colorParseCanvas.getContext('2d');
    this._sensingCompositeCanvas = null;
    this._sensingCompositeCtx = null;
    this._performanceTelemetry = this._createPerformanceTelemetryState();
    this._wakeLockSentinel = null;
    this._simEphemeralAlphaSnapSupported = true;

    // Internal clipboard buffer (fallback when Clipboard API unavailable)
    this._clipboardBlob = null;
    this._clipboardMetadata = null;  // { x, y, w, h } bounds from selection copy

    // Tool mode ('brush' | 'rect-select' | 'ellipse-select' | 'lasso-select')
    this.activeTool = 'brush';
    this.selectionMgr = null;
    this.simulation = {
      enabled: false,
      starting: false,
      running: false,
      paused: false,
      frameCount: 0,
      guidesVisible: true,
      heatmapVisible: false,
      hudCollapsed: false,
      inspectorCollapsed: false,
      inspectorSections: {},
      editorTool: 'spawn',
      // Submode: 'normal' (default, unchanged authoring/playback behavior) or
      // 'forceVisualization' (scenario-driven groups/attractors/routes with a
      // policy-driven camera). Persisted; normal mode ignores it entirely.
      mode: 'normal',
      forceViz: null, // populated below by _createDefaultForceVizState()
      brushData: {
        boid: { spawns: [], points: [], paths: [] },
        ant: { spawns: [], points: [], edges: [], pheromonePaths: [] },
        motionPath: { spawns: [], points: [], paths: [] },
      },
      // Scene-level variable overrides (applied during simulation playback).
      // seek defaults to 0 so boids follow guides instead of the cursor.
      vars: { seek: DEFAULT_SIM_SEEK },
      // Named saved simulation sessions.
      sessions: [],
      activeSessionIndex: -1,
      savedPlayback: null,
      multiSessionEnabled: false,
      multiSessionBindings: [],
      runtimeSessions: [],
      cachedRuntimeSessions: [],
      priorDrawSeek: null,
      drawingPath: null,
      drawingBlob: null,
      dragTarget: null,
      selected: null,
      hovered: null,
      pathDistance: 0,
      motionPathVelocity: { x: 0, y: 0 },
      runtimeStrokeStarts: [],
      clipboard: null,
      nextId: 1,
    };
    // populated in _init() after the first resize, once this.W/this.H
    // reflect real canvas dimensions (see _createDefaultForceVizState()).
    // Force Visualization runtime-only state — never persisted/serialized.
    // Holds the manual view the user had before entering the submode (for
    // the 'restoreManualView' exit behavior) and small camera bookkeeping
    // (orbit angle accumulator, last manual pan/zoom/rotate timestamp for
    // interruption handling).
    this._forceVizManualViewSnapshot = null;
    this._forceVizCameraRuntime = { lastManualInputAt: 0, orbitAngle: 0, lastElapsed: null };
    this._simulationSavedPlaybackCapture = null;
    this.motionPath = this._createDefaultMotionPathState();
    this.motionPathEditor = this._createMotionPathEditorState();
    this._simFormatMenuUi = {
      activePopover: null,
      docked: false,
      position: null,
      dragPointerId: null,
      dragOffsetX: 0,
      dragOffsetY: 0,
    };
    this._simPathOverlayUi = {
      preferredSideByPath: new Map(),
      showSpeedHandles: true,
      showRadiusHandles: true,
      showStrengthHandles: true,
    };
    this._simulationContextOverride = null;
    this._simulationSessionRoutingPanel = null;
    this._simulationSessionRoutingAnchor = null;
    this._simulationSessionRoutingPointerHandler = null;
    this._simulationSessionRoutingKeyHandler = null;

    // Color
    this.primaryEl = document.getElementById('primaryColor');
    this.secondaryEl = document.getElementById('secondaryColor');
    this.bgColorEl = document.getElementById('bgColor');
    this._colorPicker = {
      open: false,
      target: 'primary',
      hue: 0,
      saturation: 100,
      lightness: 50,
      anchorEl: null,
      initialHex: '#1a1a1a',
      changedSinceOpen: false,
      wheelPointerId: null,
      refs: null,
    };

    // Color history
    this._colorHistory = [];
    this._maxColorHistory = 16;
    this._fluidInteractionState = { emitters: [], influences: [], scalarFields: [] };
    this._simulationExport = this._createSimulationExportState();
    this._workspaceJsonEditorBaseDoc = null;
    this._workspaceJsonAutoApplyTimer = null;
    this._workspaceJsonAutoApplying = false;
    this._workspaceJsonAutoApplyPending = false;

    // Frame loop
    this._rafId = null;
    this._startTime = performance.now();

    // Toast timer
    this._toastTimer = null;

    // Kick off
    this._init().catch(error => this._handleInitError(error));
  }

  _createDefaultSymmetryState() {
    return {
      pathNodes: [
        { ...SYMMETRY_GUIDE_DEFAULT_START, connector: 'curve' },
        { ...SYMMETRY_GUIDE_DEFAULT_CONTROL, connector: 'curve' },
        { ...SYMMETRY_GUIDE_DEFAULT_END, connector: 'curve' },
      ],
    };
  }

  _normalizeSymmetryState(state) {
    const next = this._createDefaultSymmetryState();
    if (!state || typeof state !== 'object' || Array.isArray(state)) return next;
    const normalizeNode = (source, fallback) => ({
      x: Number.isFinite(source?.x) ? _clamp01(source.x) : fallback.x,
      y: Number.isFinite(source?.y) ? _clamp01(source.y) : fallback.y,
      connector: source?.connector === 'sharp' ? 'sharp' : 'curve',
    });
    const rawNodes = Array.isArray(state.pathNodes) && state.pathNodes.length
      ? state.pathNodes
      : [state.pathStart, state.pathControl, state.pathEnd];
    const normalizedNodes = rawNodes
      .map((node, index) => normalizeNode(node, next.pathNodes[Math.min(index, next.pathNodes.length - 1)]))
      .filter(Boolean)
      .slice(0, SYMMETRY_GUIDE_MAX_NODES);
    if (normalizedNodes.length >= SYMMETRY_GUIDE_MIN_NODES) next.pathNodes = normalizedNodes;
    return next;
  }

  _serializeSymmetryState() {
    return _deepClone(this._normalizeSymmetryState(this.symmetry));
  }

  _getSymmetryPathNodes() {
    const symmetry = this._normalizeSymmetryState(this.symmetry);
    return symmetry.pathNodes.map(node => ({
      x: node.x * this.W,
      y: node.y * this.H,
      connector: node.connector === 'sharp' ? 'sharp' : 'curve',
    }));
  }

  _getSymmetryPathPoints() {
    return this._getSymmetryPathNodes();
  }

  _getSymmetryPathGuidePoints(p = this.getP()) {
    const nodes = this._getSymmetryPathNodes();
    if (nodes.length < SYMMETRY_GUIDE_MIN_NODES) return nodes;
    if (!p.symmetryPathUseCurve) return nodes;
    const sampled = [];
    for (let segmentIndex = 0; segmentIndex < nodes.length - 1; segmentIndex++) {
      const segmentPoints = _sampleMotionPathBezierSegment(nodes, segmentIndex, false);
      if (!segmentPoints.length) continue;
      if (sampled.length) segmentPoints.shift();
      sampled.push(...segmentPoints);
    }
    return sampled.length ? sampled : nodes;
  }

  _getSymmetryPathTrack(p = this.getP()) {
    return _buildMotionPathTrack(this._getSymmetryPathGuidePoints(p), false);
  }

  _getSymmetryPathSlots(count, p = this.getP()) {
    const copies = Math.max(1, Math.round(count || 1));
    const track = this._getSymmetryPathTrack(p);
    const points = this._getSymmetryPathGuidePoints(p);
    if (!track || !points.length) return [];
    if (copies <= 1) {
      const sample = _sampleMotionPathTrack(track, 0);
      return [sample ? { x: sample.x, y: sample.y, angle: sample.angle || 0 } : { ...points[0], angle: 0 }];
    }
    const slots = [];
    for (let i = 0; i < copies; i++) {
      const sample = _sampleMotionPathTrack(track, (i / Math.max(1, copies - 1)) * track.totalLength);
      slots.push(sample ? { x: sample.x, y: sample.y, angle: sample.angle || 0 } : { ...points[0], angle: 0 });
    }
    return slots;
  }

  _getSymmetryRadialCenter(p = this.getP()) {
    return {
      x: p.symmetryCenterX * this.W,
      y: p.symmetryCenterY * this.H,
    };
  }

  _getSymmetrySizeMultipliers(p = this.getP()) {
    return Array.isArray(p.symmetrySizeMultipliers) && p.symmetrySizeMultipliers.length
      ? p.symmetrySizeMultipliers
      : [1];
  }

  _resolvePathSymmetryBaseSlotIndex(x, y, count, p = this.getP()) {
    const slots = this._getSymmetryPathSlots(count, p);
    if (slots.length <= 1) return 0;
    const closest = _getClosestPolylineDistance(this._getSymmetryPathGuidePoints(p), x, y, false);
    if (!closest || !Number.isFinite(closest.totalLength) || closest.totalLength <= 1e-6) return 0;
    return Math.max(0, Math.min(slots.length - 1, Math.round((closest.distanceAlongPath / closest.totalLength) * (slots.length - 1))));
  }

  _getSymmetryPathInsertPreview(x, y, p = this.getP()) {
    const nodes = this._getSymmetryPathNodes();
    if (nodes.length < SYMMETRY_GUIDE_MIN_NODES) return null;
    let best = null;
    const considerHit = (hit, index) => {
      if (!hit) return;
      if (!best || hit.distance < best.distance) {
        best = { index, x: hit.x, y: hit.y, distance: hit.distance };
      }
    };
    if (p.symmetryPathUseCurve) {
      for (let segmentIndex = 0; segmentIndex < nodes.length - 1; segmentIndex++) {
        const segmentPoints = _sampleMotionPathBezierSegment(nodes, segmentIndex, false);
        for (let i = 1; i < segmentPoints.length; i++) {
          considerHit(
            _closestPointOnSegment(x, y, segmentPoints[i - 1].x, segmentPoints[i - 1].y, segmentPoints[i].x, segmentPoints[i].y),
            segmentIndex + 1,
          );
        }
      }
    } else {
      for (let index = 1; index < nodes.length; index++) {
        considerHit(_closestPointOnSegment(x, y, nodes[index - 1].x, nodes[index - 1].y, nodes[index].x, nodes[index].y), index);
      }
    }
    return best;
  }

  _setSymmetryPathNodes(nodes) {
    const normalized = Array.isArray(nodes)
      ? nodes
          .filter(node => Number.isFinite(node?.x) && Number.isFinite(node?.y))
          .map(node => ({
            x: this.W > 0 ? _clamp01(node.x / this.W) : 0,
            y: this.H > 0 ? _clamp01(node.y / this.H) : 0,
            connector: node?.connector === 'sharp' ? 'sharp' : 'curve',
          }))
          .slice(0, SYMMETRY_GUIDE_MAX_NODES)
      : [];
    if (normalized.length < SYMMETRY_GUIDE_MIN_NODES) return false;
    this.symmetry = {
      ...this.symmetry,
      pathNodes: normalized,
    };
    return true;
  }

  _insertSymmetryPathNode(x, y, p = this.getP()) {
    const insertion = this._getSymmetryPathInsertPreview(x, y, p);
    if (!insertion) return false;
    const nodes = this._getSymmetryPathNodes();
    nodes.splice(insertion.index, 0, { x: insertion.x, y: insertion.y, connector: 'curve' });
    return this._setSymmetryPathNodes(nodes);
  }

  _removeSymmetryPathNode(index) {
    const nodes = this._getSymmetryPathNodes();
    if (nodes.length <= SYMMETRY_GUIDE_MIN_NODES || index < 0 || index >= nodes.length) return false;
    nodes.splice(index, 1);
    return this._setSymmetryPathNodes(nodes);
  }

  _beginSymmetryStroke(x, y, p = this.getP()) {
    if (!p.symmetryEnabled) {
      this._symmetryStrokeState = null;
      return;
    }
    if (p.symmetryMode === 'path') {
      this._symmetryStrokeState = {
        mode: 'path',
        baseSlotIndex: this._resolvePathSymmetryBaseSlotIndex(x, y, p.symmetryCount, p),
      };
      return;
    }
    this._symmetryStrokeState = { mode: 'radial' };
  }

  _clearSymmetryStrokeState() {
    this._symmetryStrokeState = null;
  }

  _findSymmetryGuideHit(x, y, p = this.getP()) {
    if (!p.symmetryEnabled || p.symmetryMode !== 'path' || p.symmetryGuideVisible === false || this.activeTool !== 'brush') return null;
    const nodes = this._getSymmetryPathNodes();
    const guidePoints = this._getSymmetryPathGuidePoints(p);
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (Math.hypot(x - node.x, y - node.y) <= SYMMETRY_GUIDE_HIT_RADIUS) return { kind: 'pathNode', nodeIndex: index };
    }
    for (let i = 1; i < guidePoints.length; i++) {
      const a = guidePoints[i - 1];
      const b = guidePoints[i];
      const segment = _closestPointOnSegment(x, y, a.x, a.y, b.x, b.y);
      if (segment.distance <= SYMMETRY_GUIDE_HIT_RADIUS * SYMMETRY_GUIDE_SEGMENT_HIT_FACTOR) return { kind: 'pathTranslate' };
    }
    return null;
  }

  _handleSymmetryPointerDown(x, y, event = null) {
    const p = this.getP();
    const hit = this._findSymmetryGuideHit(x, y, p);
    if (event?.altKey && hit?.kind === 'pathNode') {
      const removed = this._removeSymmetryPathNode(hit.nodeIndex);
      if (!removed) this.showToast('Need at least two symmetry nodes');
      else this.showToast('Removed symmetry node');
      return true;
    }
    if (event?.shiftKey && hit?.kind === 'pathTranslate') {
      const inserted = this._insertSymmetryPathNode(x, y, p);
      if (inserted) {
        this.showToast('Added symmetry node');
        return true;
      }
    }
    if (!hit) return false;
    this._symmetryDrag = { ...hit, lastX: x, lastY: y };
    return true;
  }

  _handleSymmetryPointerMove(x, y) {
    if (!this._symmetryDrag) return false;
    const nodes = this._getSymmetryPathNodes();
    if (this._symmetryDrag.kind === 'pathNode') {
      if (!nodes[this._symmetryDrag.nodeIndex]) return false;
      nodes[this._symmetryDrag.nodeIndex] = {
        ...nodes[this._symmetryDrag.nodeIndex],
        x,
        y,
      };
      this._setSymmetryPathNodes(nodes);
    } else {
      const dx = x - this._symmetryDrag.lastX;
      const dy = y - this._symmetryDrag.lastY;
      const xs = nodes.map(node => node.x);
      const ys = nodes.map(node => node.y);
      const clampedDx = _clamp(dx, -Math.min(...xs), this.W - Math.max(...xs));
      const clampedDy = _clamp(dy, -Math.min(...ys), this.H - Math.max(...ys));
      this._setSymmetryPathNodes(nodes.map(node => ({
        ...node,
        x: node.x + clampedDx,
        y: node.y + clampedDy,
      })));
    }
    this._symmetryDrag.lastX = x;
    this._symmetryDrag.lastY = y;
    return true;
  }

  _handleSymmetryPointerUp() {
    if (!this._symmetryDrag) return false;
    this._symmetryDrag = null;
    return true;
  }

  _drawSymmetryGuideOverlay(ctx, p = this.getP()) {
    if (!p.symmetryEnabled || p.symmetryGuideVisible === false) return;
    ctx.save();
    if (p.symmetryMode === 'path') {
      const nodes = this._getSymmetryPathNodes();
      const guidePoints = this._getSymmetryPathGuidePoints(p);
      const slots = this._getSymmetryPathSlots(p.symmetryCount, p);
      ctx.strokeStyle = 'rgba(123,255,186,0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(guidePoints[0].x, guidePoints[0].y);
      for (let i = 1; i < guidePoints.length; i++) ctx.lineTo(guidePoints[i].x, guidePoints[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(123,255,186,0.9)';
      for (const slot of slots) {
        ctx.beginPath();
        ctx.arc(slot.x, slot.y, SYMMETRY_GUIDE_SLOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,170,230,0.95)';
      nodes.forEach(handle => {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, SYMMETRY_GUIDE_HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      const { x: cx, y: cy } = this._getSymmetryRadialCenter(p);
      const radius = Math.max(this.W, this.H) * 0.5;
      ctx.strokeStyle = 'rgba(123,255,186,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]);
      for (let i = 0; i < Math.max(1, p.symmetryCount); i++) {
        const angle = (i / Math.max(1, p.symmetryCount)) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,170,230,0.95)';
      ctx.beginPath();
      ctx.arc(cx, cy, SYMMETRY_GUIDE_SLOT_RADIUS + 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _captureSimulationPriorDrawSeek() {
    const seekControl = document.getElementById('seek');
    const seekValue = seekControl ? Number(seekControl.value) : NaN;
    if (Number.isFinite(seekValue)) this.simulation.priorDrawSeek = seekValue;
  }

  _restoreSimulationPriorDrawSeek() {
    const priorDrawSeek = this.simulation?.priorDrawSeek;
    this.simulation.priorDrawSeek = null;
    if (!Number.isFinite(priorDrawSeek)) return;
    const seekControl = document.getElementById('seek');
    if (!seekControl) return;
    seekControl.value = String(priorDrawSeek);
    this._paramsDirty = true;
    syncUI(this);
  }

  // ========================================================
  // INIT
  // ========================================================

  async _init() {
    this.selectionMgr = new SelectionManager(this);
    this._resizeAll();
    this.simulation.forceViz = this._createDefaultForceVizState();
    this.compositor = new Compositor(this.compositeCanvas);
    this.compositor.resize(this.W, this.H, this.DPR);
    this._addBackgroundLayer();
    this.addLayer('Layer 1');
    this._syncLayerSwitcher();
    this._syncAlphaLockUI();

    // Brush engines
    this.brushes.boid = new BoidBrush(this);
    this.brushes.ant = new AntBrush(this);
    this.brushes.bristle = new BristleBrush(this);
    this.brushes.motionPath = new MotionPathBrush(this);
    this.brushes.fluid = new FluidBrush(this);
    this.brushes.fluid3d = new ThreeDFluidBrush(this);
    this.brushes.simple = new SimpleBrush(this);
    this.brushes.eraser = new EraserBrush(this);

    // Sidebar UI
    buildSidebar(this);
    buildFavoritesPanel(this);
    buildSettingsPanel(this);
    buildLayersPanel(this);
    buildGuidesPanel(this);
    buildSimulationControlsPanel(this);
    initEdgeSliders(this);
    this._initPerformanceTelemetry();

    // Events
    this._bindEvents();
    this._initTopbarOverflow();

    // Make the canvas and controls interactive before optional brush engines
    // finish probing GPU/WASM backends.
    this._fillBackgroundLayer();
    this.compositeAllLayers();
    this._frameLoop();

    // Init WASM/GPU-backed brushes without blocking the first interactive frame.
    const brushInitEntries = [
      ['boid', this.brushes.boid.init()],
      ['ant', this.brushes.ant.init()],
      ['fluid', this.brushes.fluid.init()],
      ['fluid3d', this.brushes.fluid3d.init()],
    ];
    const brushInitResults = await Promise.allSettled(brushInitEntries.map(([, promise]) => promise));
    for (let index = 0; index < brushInitResults.length; index += 1) {
      const result = brushInitResults[index];
      if (result.status !== 'rejected') continue;
      console.error(`Brush engine init failed during startup (${brushInitEntries[index][0]}):`, result.reason);
    }

    // Re-composite after session restore because restoring layers/view state may
    // replace the document we drew above for the first interactive frame.
    await this._ensureBuiltinCanvasTexture();
    await this._restoreSession();
    this._syncColorPickerUi();
    // Fresh loads start with activeBrush='boid' but had not been run through
    // the normal brush activation path. Re-applying the current brush keeps
    // startup behavior consistent with choosing it from the menu.
    this.setBrush(this.activeBrush);
    this._syncSimulationUI();

    // Composite & start loop
    this.compositeAllLayers();

    this._announceBuildLoad();
    this.setStatus('Ready');
  }

  // ========================================================
  // CANVAS MANAGEMENT
  // ========================================================

  _resizeAll() {
    if (this._docSized) {
      // Document has explicit size — don't resize to viewport
      const transformEl = document.getElementById('canvasTransform');
      if (transformEl) {
        transformEl.style.width = this.W + 'px';
        transformEl.style.height = this.H + 'px';
      }
      this.sharedMotionSim?.setDisplaySize?.(this.W, this.H);
      this.lctx = this.liveCanvas.getContext('2d', { desynchronized: true });
      this.lctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
      this._applyViewTransform();
      return;
    }
    this.DPR = window.devicePixelRatio || 1;
    const rect = document.getElementById('canvasArea').getBoundingClientRect();
    this.W = Math.floor(rect.width);
    this.H = Math.floor(rect.height);
    this.sharedMotionSim?.setDisplaySize?.(this.W, this.H);

    for (const c of [this.compositeCanvas, this.liveCanvas, this.interactionCanvas]) {
      c.width = this.W * this.DPR;
      c.height = this.H * this.DPR;
      c.style.width = this.W + 'px';
      c.style.height = this.H + 'px';
    }

    this.lctx = this.liveCanvas.getContext('2d', { desynchronized: true });
    this.lctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);

    // Resize existing layers
    for (const l of this.layers) {
      if (l.canvas.width !== this.W * this.DPR || l.canvas.height !== this.H * this.DPR) {
        const tmp = document.createElement('canvas');
        tmp.width = l.canvas.width;
        tmp.height = l.canvas.height;
        tmp.getContext('2d').drawImage(l.canvas, 0, 0);
        l.canvas.width = this.W * this.DPR;
        l.canvas.height = this.H * this.DPR;
        l.ctx = l.canvas.getContext('2d', { desynchronized: true, willReadFrequently: true });
        l.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
        l.ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, this.W, this.H);
      }
      l.dirty = true;
      this.compositor?.deleteLayerTex(l);
    }
    this.compositor?.resize(this.W, this.H, this.DPR);
    // Refill background layer after resize
    this._fillBackgroundLayer();

    // Resize height canvas for impasto, preserving existing paint height data
    if (!this._heightCanvas) {
      this._heightCanvas = document.createElement('canvas');
      this._heightCtx = this._heightCanvas.getContext('2d');
    }
    const targetW = this.W * this.DPR;
    const targetH = this.H * this.DPR;
    if (this._heightCanvas.width !== targetW || this._heightCanvas.height !== targetH) {
      const oldW = this._heightCanvas.width, oldH = this._heightCanvas.height;
      if (oldW > 0 && oldH > 0) {
        const tmp = document.createElement('canvas');
        tmp.width = oldW; tmp.height = oldH;
        tmp.getContext('2d').drawImage(this._heightCanvas, 0, 0);
        this._heightCanvas.width = targetW;
        this._heightCanvas.height = targetH;
        this._heightCtx.drawImage(tmp, 0, 0, oldW, oldH, 0, 0, targetW, targetH);
      } else {
        this._heightCanvas.width = targetW;
        this._heightCanvas.height = targetH;
      }
    }
    this._applyViewTransform();
  }

  async resizeDocument(newW, newH, bgColor) {
    newW = Math.max(1, Math.min(8192, Math.round(newW)));
    newH = Math.max(1, Math.min(8192, Math.round(newH)));
    const oldDocW = Math.max(1, this._docW || this.W || newW);
    const oldDocH = Math.max(1, this._docH || this.H || newH);
    const oldWorkspaceW = Math.max(1, this.W || oldDocW);
    const oldWorkspaceH = Math.max(1, this.H || oldDocH);
    const oldOffsetX = Math.max(0, Math.round((oldWorkspaceW - oldDocW) / 2));
    const oldOffsetY = Math.max(0, Math.round((oldWorkspaceH - oldDocH) / 2));
    const margin = Math.max(0, Math.round(this._workspaceMargin || 0));
    const workspaceW = newW + (margin * 2);
    const workspaceH = newH + (margin * 2);

    this._docSized = true;
    this._docW = newW;
    this._docH = newH;

    this.DPR = 1;
    this.W = workspaceW;
    this.H = workspaceH;
    this.sharedMotionSim?.setDisplaySize?.(workspaceW, workspaceH);

    // Resize display canvases
    for (const c of [this.compositeCanvas, this.liveCanvas, this.interactionCanvas]) {
      c.width = workspaceW;
      c.height = workspaceH;
      c.style.width = workspaceW + 'px';
      c.style.height = workspaceH + 'px';
    }
    this.lctx = this.liveCanvas.getContext('2d', { desynchronized: true });
    this.lctx.setTransform(1, 0, 0, 1, 0, 0);

    // Resize layers (preserve content by scaling)
    for (const l of this.layers) {
      const tmp = document.createElement('canvas');
      tmp.width = l.canvas.width;
      tmp.height = l.canvas.height;
      tmp.getContext('2d').drawImage(l.canvas, 0, 0);
      l.canvas.width = workspaceW;
      l.canvas.height = workspaceH;
      l.ctx = l.canvas.getContext('2d', { desynchronized: true, willReadFrequently: true });
      l.ctx.drawImage(tmp, oldOffsetX, oldOffsetY, oldDocW, oldDocH, margin, margin, newW, newH);
      l.dirty = true;
      this.compositor?.deleteLayerTex(l);
    }

    this.compositor?.resize(workspaceW, workspaceH, 1);

    // Background
    if (bgColor) {
      this.setColorValue('background', bgColor, { silent: true });
    }
    this._fillBackgroundLayer();

    // Height canvas
    if (this._heightCanvas) {
      const tmp = document.createElement('canvas');
      tmp.width = this._heightCanvas.width;
      tmp.height = this._heightCanvas.height;
      tmp.getContext('2d').drawImage(this._heightCanvas, 0, 0);
      this._heightCanvas.width = workspaceW;
      this._heightCanvas.height = workspaceH;
      this._heightCtx.drawImage(tmp, oldOffsetX, oldOffsetY, oldDocW, oldDocH, margin, margin, newW, newH);
    }

    // Reinit WASM sims
    try {
      if (this.brushes.boid) await this.brushes.boid.init({ force: true });
      if (this.brushes.ant) await this.brushes.ant.init({ force: true });
      if (this.brushes.fluid) await this.brushes.fluid.init({ force: true });
      if (this.brushes.fluid3d) await this.brushes.fluid3d.init({ force: true });
    } catch(e) { console.warn('WASM reinit failed:', e); }

    // Zoom to fit
    const viewRect = document.getElementById('canvasArea').getBoundingClientRect();
    const fitZoom = Math.min(viewRect.width / workspaceW, viewRect.height / workspaceH, 1) * 0.95;
    this.viewZoom = fitZoom;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.viewRotation = 0;
    this.viewFlipped = false;
    this._applyViewTransform();

    this._smudgeImageData = null;
    this.compositeAllLayers();
    this.showToast(`📐 Canvas: ${newW}×${newH}`);
  }

  _showCanvasSizeModal() {
    const modal = document.getElementById('canvasSizeModal');
    if (!modal) return;
    const wEl = document.getElementById('canvasSizeW');
    const hEl = document.getElementById('canvasSizeH');
    const bgEl = document.getElementById('canvasSizeBg');
    const presetEl = document.getElementById('canvasSizePreset');
    if (wEl) wEl.value = this._docW || this.W;
    if (hEl) hEl.value = this._docH || this.H;
    if (bgEl) bgEl.value = this.bgColorEl?.value || '#313131';
    if (presetEl) presetEl.value = `${this._docW || this.W}x${this._docH || this.H}`;
    this._syncCanvasSizeColorTrigger(bgEl?.value || '#313131');
    modal.classList.add('open');
  }

  _hideCanvasSizeModal() {
    if (this._colorPicker.open && this._getColorTargetKey(this._colorPicker.target) === 'canvasSizeBg') {
      this._closeColorPicker({ recordHistory: false });
    }
    document.getElementById('canvasSizeModal')?.classList.remove('open');
  }

  _getWorkspaceJsonModalElements() {
    return {
      panel: document.getElementById('jsonPanel'),
      editor: document.getElementById('workspaceJsonEditor'),
      highlight: document.getElementById('workspaceJsonHighlight'),
      structuredEditor: document.getElementById('workspaceJsonStructuredEditor'),
      status: document.getElementById('workspaceJsonStatus'),
      meta: document.getElementById('workspaceJsonMeta'),
      documentName: document.getElementById('workspaceJsonDocumentName'),
      docSelect: document.getElementById('workspaceJsonDocumentSelect'),
      sessionSelect: document.getElementById('workspaceJsonSessionSelect'),
      sessionSelectWrap: document.getElementById('workspaceJsonSessionSelectWrap'),
      docHint: document.getElementById('workspaceJsonDocHint'),
      autoApplyToggle: document.getElementById('workspaceJsonAutoApply'),
    };
  }

  _escapeWorkspaceJsonHtml(text = '') {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _escapeWorkspaceJsonAttr(text = '') {
    return this._escapeWorkspaceJsonHtml(text).replace(/"/g, '&quot;');
  }

  _encodeWorkspaceJsonPath(path = []) {
    try {
      return encodeURIComponent(JSON.stringify(Array.isArray(path) ? path : []));
    } catch {
      return encodeURIComponent('[]');
    }
  }

  _decodeWorkspaceJsonPath(raw = '') {
    try {
      const decoded = JSON.parse(decodeURIComponent(raw));
      return Array.isArray(decoded) ? decoded : [];
    } catch {
      return [];
    }
  }

  _formatWorkspaceJsonPathLabel(path = []) {
    if (!Array.isArray(path) || !path.length) return 'value';
    return path.reduce((label, segment) => {
      if (typeof segment === 'number') return `${label}[${segment}]`;
      return label ? `${label}.${segment}` : String(segment);
    }, '');
  }

  _setWorkspaceJsonValueAtPath(target, path, value) {
    if (!Array.isArray(path) || !path.length) return value;
    let current = target;
    for (let index = 0; index < path.length - 1; index++) {
      current = current?.[path[index]];
      if (current == null) return target;
    }
    current[path[path.length - 1]] = value;
    return target;
  }

  _workspaceJsonPrimitiveType(value) {
    if (value === null) return 'null';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'string';
  }

  _workspaceJsonFieldSize(rawValue = '') {
    return Math.max(1, Math.min(48, String(rawValue ?? '').length || 1));
  }

  _buildWorkspaceJsonPrimitiveField(value, path) {
    const type = this._workspaceJsonPrimitiveType(value);
    const encodedPath = this._encodeWorkspaceJsonPath(path);
    if (type === 'boolean') {
      return `<select class="workspace-json-valueSelect" data-json-path="${encodedPath}" data-json-type="boolean" aria-label="${this._escapeWorkspaceJsonAttr(this._formatWorkspaceJsonPathLabel(path))}"><option value="true"${value ? ' selected' : ''}>true</option><option value="false"${value ? '' : ' selected'}>false</option></select>`;
    }
    if (type === 'null') {
      return `<input class="workspace-json-valueField" data-json-path="${encodedPath}" data-json-type="null" type="text" inputmode="text" value="null" size="4" aria-label="${this._escapeWorkspaceJsonAttr(this._formatWorkspaceJsonPathLabel(path))}">`;
    }
    const rawValue = type === 'number' ? String(value) : String(value ?? '');
    const input = `<input class="workspace-json-valueField workspace-json-valueField--${type}" data-json-path="${encodedPath}" data-json-type="${type}" type="text" ${type === 'number' ? 'inputmode="decimal"' : 'inputmode="text"'} value="${this._escapeWorkspaceJsonAttr(rawValue)}" size="${this._workspaceJsonFieldSize(rawValue)}" aria-label="${this._escapeWorkspaceJsonAttr(this._formatWorkspaceJsonPathLabel(path))}">`;
    if (type === 'string') {
      return `<span class="workspace-json-token">"</span>${input}<span class="workspace-json-token">"</span>`;
    }
    return input;
  }

  _buildWorkspaceJsonLineMarkup({ depth = 0, key = null, content = '', isLast = true }) {
    const keyMarkup = key == null
      ? ''
      : `<span class="workspace-json-token workspace-json-key">"${this._escapeWorkspaceJsonHtml(key)}"</span><span class="workspace-json-token">: </span>`;
    const commaMarkup = isLast ? '' : '<span class="workspace-json-token workspace-json-comma">,</span>';
    return `<div class="workspace-json-line" style="--json-depth:${depth}">${keyMarkup}${content}${commaMarkup}</div>`;
  }

  _buildWorkspaceJsonStructuredMarkup(value, { path = [], depth = 0, key = null, isLast = true } = {}) {
    if (Array.isArray(value)) {
      if (!value.length) return this._buildWorkspaceJsonLineMarkup({ depth, key, content: '<span class="workspace-json-token workspace-json-bracket">[]</span>', isLast });
      const childMarkup = value.map((item, index) => this._buildWorkspaceJsonStructuredMarkup(item, {
        path: [...path, index],
        depth: depth + 1,
        key: null,
        isLast: index === value.length - 1,
      })).join('');
      return [
        this._buildWorkspaceJsonLineMarkup({ depth, key, content: '<span class="workspace-json-token workspace-json-bracket">[</span>', isLast: true }),
        childMarkup,
        this._buildWorkspaceJsonLineMarkup({ depth, key: null, content: '<span class="workspace-json-token workspace-json-bracket">]</span>', isLast }),
      ].join('');
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) return this._buildWorkspaceJsonLineMarkup({ depth, key, content: '<span class="workspace-json-token workspace-json-bracket">{}</span>', isLast });
      const childMarkup = entries.map(([childKey, childValue], index) => this._buildWorkspaceJsonStructuredMarkup(childValue, {
        path: [...path, childKey],
        depth: depth + 1,
        key: childKey,
        isLast: index === entries.length - 1,
      })).join('');
      return [
        this._buildWorkspaceJsonLineMarkup({ depth, key, content: '<span class="workspace-json-token workspace-json-bracket">{</span>', isLast: true }),
        childMarkup,
        this._buildWorkspaceJsonLineMarkup({ depth, key: null, content: '<span class="workspace-json-token workspace-json-bracket">}</span>', isLast }),
      ].join('');
    }
    return this._buildWorkspaceJsonLineMarkup({
      depth,
      key,
      content: this._buildWorkspaceJsonPrimitiveField(value, path),
      isLast,
    });
  }

  _renderWorkspaceJsonStructuredEditor(documentValue = this._workspaceJsonEditorBaseDoc) {
    const { structuredEditor } = this._getWorkspaceJsonModalElements();
    if (!structuredEditor) return false;
    structuredEditor.innerHTML = this._buildWorkspaceJsonStructuredMarkup(documentValue, { path: [], depth: 0, key: null, isLast: true });
    structuredEditor.querySelectorAll('.workspace-json-valueField').forEach(field => {
      field.size = this._workspaceJsonFieldSize(field.value || field.placeholder || '');
    });
    return true;
  }

  _readWorkspaceJsonStructuredDocument() {
    const { structuredEditor } = this._getWorkspaceJsonModalElements();
    if (!structuredEditor) throw new Error('Workspace JSON value editor is unavailable.');
    if (this._workspaceJsonEditorBaseDoc == null) throw new Error('Workspace JSON editor is empty.');
    const nextDocument = _deepClone(this._workspaceJsonEditorBaseDoc);
    const fields = structuredEditor.querySelectorAll('[data-json-path][data-json-type]');
    for (const field of fields) {
      const path = this._decodeWorkspaceJsonPath(field.dataset.jsonPath || '');
      const type = field.dataset.jsonType || 'string';
      let nextValue;
      if (type === 'boolean') {
        nextValue = field.value === 'true';
      } else if (type === 'number') {
        const raw = String(field.value || '').trim();
        if (!raw) throw new Error(`Invalid number for ${this._formatWorkspaceJsonPathLabel(path)}.`);
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${this._formatWorkspaceJsonPathLabel(path)}.`);
        nextValue = parsed;
      } else if (type === 'null') {
        const raw = String(field.value || '').trim().toLowerCase();
        if (raw !== 'null') throw new Error(`Null fields must remain null for ${this._formatWorkspaceJsonPathLabel(path)}.`);
        nextValue = null;
      } else {
        nextValue = String(field.value || '');
      }
      this._setWorkspaceJsonValueAtPath(nextDocument, path, nextValue);
    }
    return nextDocument;
  }

  _getWorkspaceJsonEditorText() {
    return JSON.stringify(this._readWorkspaceJsonStructuredDocument(), null, 2);
  }

  async _runWorkspaceJsonAutoApply() {
    if (this._workspaceJsonAutoApplying) {
      this._workspaceJsonAutoApplyPending = true;
      return false;
    }
    this._workspaceJsonAutoApplying = true;
    try {
      return await this._applyWorkspaceJsonEditor({ skipConfirm: true, refreshEditor: false, quiet: true });
    } finally {
      this._workspaceJsonAutoApplying = false;
      if (this._workspaceJsonAutoApplyPending) {
        this._workspaceJsonAutoApplyPending = false;
        this._scheduleWorkspaceJsonAutoApply();
      }
    }
  }

  _scheduleWorkspaceJsonAutoApply() {
    const { autoApplyToggle } = this._getWorkspaceJsonModalElements();
    if (!autoApplyToggle?.checked) return false;
    if (this._workspaceJsonAutoApplyTimer) clearTimeout(this._workspaceJsonAutoApplyTimer);
    this._workspaceJsonAutoApplyTimer = setTimeout(() => {
      this._workspaceJsonAutoApplyTimer = null;
      void this._runWorkspaceJsonAutoApply();
    }, 180);
    return true;
  }

  _cancelWorkspaceJsonAutoApply() {
    if (this._workspaceJsonAutoApplyTimer) {
      clearTimeout(this._workspaceJsonAutoApplyTimer);
      this._workspaceJsonAutoApplyTimer = null;
    }
    this._workspaceJsonAutoApplyPending = false;
  }

  _handleWorkspaceJsonValueInput(event) {
    const field = event.target?.closest?.('[data-json-path][data-json-type]');
    if (!field) return;
    if (field.classList.contains('workspace-json-valueField')) {
      field.size = this._workspaceJsonFieldSize(field.value || field.placeholder || '');
    }
    try {
      this._readWorkspaceJsonStructuredDocument();
    } catch (error) {
      this._cancelWorkspaceJsonAutoApply();
      this._setWorkspaceJsonModalStatus(error?.message || 'Workspace JSON validation failed.', 'error');
      return;
    }
    const { autoApplyToggle } = this._getWorkspaceJsonModalElements();
    if (autoApplyToggle?.checked) {
      this._setWorkspaceJsonModalStatus('Draft updated. Applying changes…');
      this._scheduleWorkspaceJsonAutoApply();
      return;
    }
    this._setWorkspaceJsonModalStatus('Draft updated. Apply when ready.', 'success');
  }

  _syncWorkspaceJsonHighlight() {
    const { editor, highlight } = this._getWorkspaceJsonModalElements();
    if (!editor || !highlight) return;
    const raw = editor.value || '';
    const editorWrap = editor.parentElement;
    const useHighlight = raw.length <= WORKSPACE_JSON_HIGHLIGHT_MAX_CHARS;
    editorWrap?.classList.toggle('workspace-json-editorWrap--plain', !useHighlight);
    if (!useHighlight) {
      highlight.textContent = '';
      this._syncWorkspaceJsonHighlightScroll();
      return;
    }
    highlight.innerHTML = this._escapeWorkspaceJsonHtml(raw)
      .replace(WORKSPACE_JSON_HIGHLIGHT_KEY_REGEX, `<span class="workspace-json-highlightKey">"${WORKSPACE_JSON_HIGHLIGHT_KEY}"</span>`);
    this._syncWorkspaceJsonHighlightScroll();
  }

  _syncWorkspaceJsonHighlightScroll() {
    const { editor, highlight } = this._getWorkspaceJsonModalElements();
    if (!editor || !highlight) return;
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }

  _getWorkspaceJsonDocumentSpecs() {
    return [
      {
        key: 'workspace',
        group: 'Workspace',
        label: 'Workspace Bundle',
        description: 'Workspace settings snapshot with session controls, presets, and autosave state. Use Save/Open Workspace File for full layer pixels.',
        kind: 'bundle',
      },
      { key: 'brush-boid', group: 'Brush Settings', label: 'Brush: Boid', description: 'Boid brush controls, including shared boid-specific stamp and motion settings.', kind: 'brush', brush: 'boid' },
      { key: 'brush-ant', group: 'Brush Settings', label: 'Brush: Ant', description: 'Ant brush controls and the shared brush settings it uses.', kind: 'brush', brush: 'ant' },
      { key: 'brush-bristle', group: 'Brush Settings', label: 'Brush: Bristle', description: 'Bristle brush geometry, physics, and visual tuning.', kind: 'brush', brush: 'bristle' },
      { key: 'brush-simple', group: 'Brush Settings', label: 'Brush: Simple', description: 'Simple brush and other shared drawing-mode controls.', kind: 'brush', brush: 'simple' },
      { key: 'brush-eraser', group: 'Brush Settings', label: 'Brush: Eraser', description: 'Eraser brush settings and any shared stamp controls it reuses.', kind: 'brush', brush: 'eraser' },
      { key: 'brush-fluid', group: 'Brush Settings', label: 'Brush: Fluid', description: 'Fluid brush injection, flow, and render controls.', kind: 'brush', brush: 'fluid' },
      { key: 'brush-fluid3d', group: 'Brush Settings', label: 'Brush: 3D Fluid', description: '3D fluid brush emitter, dynamics, and rendering controls.', kind: 'brush', brush: 'fluid3d' },
      { key: 'brush-motionPath', group: 'Brush Settings', label: 'Brush: Motion Path', description: 'Motion-path brush graph and runtime controls.', kind: 'brush', brush: 'motionPath' },
      {
        key: 'simulation-global',
        group: 'Simulation',
        label: 'Simulation: Global',
        description: 'Global simulation runtime state shared by all sessions and brushes.',
        kind: 'simulation-global',
      },
      {
        key: 'simulation-session',
        group: 'Simulation',
        label: 'Simulation: Session',
        description: 'The currently selected simulation session, or the live draft when no session is selected.',
        kind: 'simulation-session',
        supportsSessionSelect: true,
      },
      {
        key: 'canvas',
        group: 'Canvas',
        label: 'Canvas Parameters',
        description: 'Document size, canvas view, and other canvas-surface parameters.',
        kind: 'canvas',
      },
      {
        key: 'other',
        group: 'Other',
        label: 'Other Settings',
        description: 'Remaining workspace settings, app options, and uncategorized controls.',
        kind: 'other',
      },
    ];
  }

  _getWorkspaceJsonDocumentSpec(docKey) {
    return this._getWorkspaceJsonDocumentSpecs().find(spec => spec.key === docKey) || this._getWorkspaceJsonDocumentSpecs()[0];
  }

  _workspaceJsonControlBrushTokens(controlId) {
    const element = document.getElementById(controlId);
    if (!element) return [];
    const tokens = new Set();
    let current = element;
    while (current) {
      const attr = current.getAttribute?.('data-brushes');
      if (attr) {
        for (const token of attr.split(/\s+/).map(part => part.trim()).filter(Boolean)) tokens.add(token);
      }
      current = current.parentElement;
    }
    return [...tokens];
  }

  _workspaceJsonControlSectionId(controlId) {
    const element = document.getElementById(controlId);
    if (!element) return '';
    const sectionBody = element.closest('.section-body');
    const sectionHeader = sectionBody?.previousElementSibling;
    return sectionHeader?.dataset?.section || '';
  }

  _workspaceJsonBrushSectionIds(brush) {
    const shared = ['brushScale', 'fill', 'stamp', 'stampImage', 'canvasTexture', 'symmetry', 'taper', 'trailBlur', 'kmMix', 'impasto', 'pencilHover'];
    const brushSections = {
      boid: ['spawn', 'swarm', 'forces', 'quorum', 'variance', 'motion', 'leaders', 'visual', 'sensing', 'antPheromone'],
      ant: ['spawn', 'swarm', 'forces', 'variance', 'motion', 'visual', 'sensing', 'antPheromone'],
      bristle: ['bristleShape', 'bristlePhysics', 'bristleVariance', 'bristleVisual'],
      simple: [],
      eraser: [],
      fluid: ['fluidBrush', 'fluidForces', 'fluidMidrange', 'fluidFlow', 'fluidSettling', 'fluidRendering'],
      fluid3d: ['fluid3dBrush', 'fluid3dDynamics', 'fluid3dInteraction', 'fluid3dRendering'],
      motionPath: ['motionPathGraph', 'motionPathRuntime'],
    };
    return new Set([...shared, ...(brushSections[brush] || [])]);
  }

  _workspaceJsonControlBelongsToBrush(controlId, brush) {
    if (!brush) return false;
    const tokens = this._workspaceJsonControlBrushTokens(controlId);
    if (tokens.includes(brush)) return true;
    const sectionId = this._workspaceJsonControlSectionId(controlId);
    return this._workspaceJsonBrushSectionIds(brush).has(sectionId);
  }

  _workspaceJsonCanvasKeys() {
    return new Set(['bgColor', '_docSized', '_docW', '_docH', '_view', '_tilingMode', '_canvasTextureState', '_stampImageState']);
  }

  _getWorkspaceJsonSessionSelectValue() {
    const { sessionSelect } = this._getWorkspaceJsonModalElements();
    const raw = sessionSelect?.value;
    if (raw === '' || raw === 'draft' || raw == null) return 'draft';
    const index = Number(raw);
    return Number.isFinite(index) ? index : 'draft';
  }

  _buildWorkspaceJsonBrushDocument(bundle, brush) {
    const controls = bundle?.session && typeof bundle.session === 'object' ? bundle.session : this._captureSessionControls();
    const doc = {};
    for (const [key, value] of Object.entries(controls)) {
      if (key === '_simulation') continue;
      if (!this._workspaceJsonControlBelongsToBrush(key, brush)) continue;
      doc[key] = _deepClone(value);
    }
    return doc;
  }

  _buildWorkspaceJsonSimulationGlobalDocument(bundle) {
    const sim = _deepClone(bundle?.session?._simulation || this.simulation || {});
    delete sim.sessions;
    delete sim.brushData;
    delete sim.vars;
    delete sim.runtimeSessions;
    delete sim.cachedRuntimeSessions;
    delete sim.priorDrawSeek;
    delete sim.drawingPath;
    delete sim.drawingBlob;
    delete sim.dragTarget;
    delete sim.selected;
    delete sim.pathDistance;
    return sim;
  }

  _buildWorkspaceJsonSimulationSessionDocument(bundle, sessionIndex = 'draft') {
    const sim = bundle?.session?._simulation || this.simulation || {};
    const sessions = Array.isArray(sim.sessions) ? sim.sessions : [];
    if (Number.isFinite(sessionIndex) && sessionIndex >= 0 && sessions[sessionIndex]) {
      return _deepClone(sessions[sessionIndex]);
    }
    return {
      name: 'Current Draft',
      brushData: _deepClone(sim.brushData || {}),
      vars: _deepClone(sim.vars || {}),
      sensingSourceSelection: _deepClone(sim.sensingSourceSelection || []),
      activeSessionIndex: Number.isFinite(sim.activeSessionIndex) ? sim.activeSessionIndex : -1,
      multiSessionEnabled: sim.multiSessionEnabled === true,
      multiSessionBindings: _deepClone(sim.multiSessionBindings || []),
    };
  }

  _buildWorkspaceJsonCanvasDocument(bundle) {
    const controls = bundle?.session && typeof bundle.session === 'object' ? bundle.session : this._captureSessionControls();
    const canvasKeys = this._workspaceJsonCanvasKeys();
    const doc = {};
    for (const [key, value] of Object.entries(controls)) {
      if (key === '_simulation') continue;
      if (!canvasKeys.has(key)) continue;
      doc[key] = _deepClone(value);
    }
    return doc;
  }

  _buildWorkspaceJsonOtherDocument(bundle) {
    const controls = bundle?.session && typeof bundle.session === 'object' ? bundle.session : this._captureSessionControls();
    const canvasKeys = this._workspaceJsonCanvasKeys();
    const doc = {
      autosaveEnabled: !!bundle?.autosaveEnabled,
      presets: _deepClone(bundle?.presets || {}),
    };
    for (const [key, value] of Object.entries(controls)) {
      if (key === '_simulation') continue;
      if (canvasKeys.has(key)) continue;
      if (this._getWorkspaceJsonDocumentSpecs().some(spec => spec.kind === 'brush' && this._workspaceJsonControlBelongsToBrush(key, spec.brush))) continue;
      doc[key] = _deepClone(value);
    }
    return doc;
  }

  _buildWorkspaceJsonDocument(bundle, docKey, state = {}) {
    const spec = this._getWorkspaceJsonDocumentSpec(docKey);
    if (spec.kind === 'bundle') return _deepClone(bundle);
    if (spec.kind === 'brush') return this._buildWorkspaceJsonBrushDocument(bundle, spec.brush);
    if (spec.kind === 'simulation-global') return this._buildWorkspaceJsonSimulationGlobalDocument(bundle);
    if (spec.kind === 'simulation-session') return this._buildWorkspaceJsonSimulationSessionDocument(bundle, state.sessionIndex);
    if (spec.kind === 'canvas') return this._buildWorkspaceJsonCanvasDocument(bundle);
    if (spec.kind === 'other') return this._buildWorkspaceJsonOtherDocument(bundle);
    return {};
  }

  _createWorkspaceJsonEditorBundle() {
    // The inline JSON tab edits workspace settings only; full layer pixel snapshots stay in Save/Open Workspace File flows.
    return this.createWorkspaceSettingsBundle();
  }

  _populateWorkspaceJsonDocumentSelect(docKey = 'workspace') {
    const { docSelect, sessionSelect, sessionSelectWrap, docHint } = this._getWorkspaceJsonModalElements();
    const specs = this._getWorkspaceJsonDocumentSpecs();
    if (docSelect) {
      const groups = new Map();
      for (const spec of specs) {
        const groupName = spec.group || 'Other';
        if (!groups.has(groupName)) groups.set(groupName, []);
        groups.get(groupName).push(spec);
      }
      docSelect.innerHTML = Array.from(groups.entries()).map(([groupName, groupSpecs]) => `
        <optgroup label="${groupName}">
          ${groupSpecs.map(spec => `<option value="${spec.key}">${spec.label}</option>`).join('')}
        </optgroup>
      `).join('');
      docSelect.value = specs.some(spec => spec.key === docKey) ? docKey : 'workspace';
    }
    const selectedSpec = this._getWorkspaceJsonDocumentSpec(docSelect?.value || docKey);
    if (sessionSelectWrap) sessionSelectWrap.hidden = !selectedSpec.supportsSessionSelect;
    if (sessionSelect) {
      const simulation = this.simulation || {};
      const sessions = Array.isArray(simulation.sessions) ? simulation.sessions : [];
      sessionSelect.innerHTML = [
        `<option value="draft">Current Draft</option>`,
        ...sessions.map((session, index) => `<option value="${index}">${session.name || `Session ${index + 1}`}</option>`),
      ].join('');
      const savedIndex = Number.isFinite(this._workspaceJsonEditorSessionIndex)
        ? this._workspaceJsonEditorSessionIndex
        : (Number.isFinite(simulation.activeSessionIndex) && simulation.activeSessionIndex >= 0 ? simulation.activeSessionIndex : 'draft');
      sessionSelect.value = selectedSpec.supportsSessionSelect && savedIndex !== 'draft' && sessions[savedIndex]
        ? String(savedIndex)
        : 'draft';
    }
    if (docHint) docHint.textContent = selectedSpec.description;
  }

  _setWorkspaceJsonModalStatus(message = 'Ready to edit the current workspace bundle.', level = '') {
    const { status } = this._getWorkspaceJsonModalElements();
    if (!status) return;
    status.textContent = message;
    status.className = `workspace-json-status${level ? ` ${level}` : ''}`;
  }

  _populateWorkspaceJsonEditor(bundle = this.createWorkspaceSettingsBundle()) {
    const { meta, documentName } = this._getWorkspaceJsonModalElements();
    const { docSelect, sessionSelect } = this._getWorkspaceJsonModalElements();
    const docKey = docSelect?.value || this._workspaceJsonEditorDocKey || 'workspace';
    const sessionIndex = docKey === 'simulation-session' ? this._getWorkspaceJsonSessionSelectValue() : 'draft';
    this._workspaceJsonEditorDocKey = docKey;
    this._workspaceJsonEditorSessionIndex = sessionIndex === 'draft' ? -1 : sessionIndex;
    if (documentName) documentName.textContent = this._getWorkspaceJsonDocumentSpec(docKey).label;
    if (meta) {
      const exportedAt = bundle?.exportedAt ? new Date(bundle.exportedAt) : null;
      const spec = this._getWorkspaceJsonDocumentSpec(docKey);
      const sessionLabel = docKey === 'simulation-session' && sessionSelect && sessionSelect.value !== 'draft'
        ? ` Session ${sessionSelect.selectedOptions?.[0]?.textContent || sessionSelect.value}.`
        : '';
      meta.textContent = `${spec.description}${sessionLabel}` + (exportedAt && Number.isFinite(exportedAt.getTime())
        ? ` Snapshot generated ${exportedAt.toLocaleString()}.`
        : '');
    }
    const documentPayload = this._buildWorkspaceJsonDocument(bundle, docKey, { sessionIndex: this._workspaceJsonEditorSessionIndex });
    this._workspaceJsonEditorBaseDoc = _deepClone(documentPayload);
    this._renderWorkspaceJsonStructuredEditor(documentPayload);
    this._setWorkspaceJsonModalStatus();
  }

  _refreshWorkspaceJsonPanel() {
    const { structuredEditor } = this._getWorkspaceJsonModalElements();
    if (!structuredEditor) return false;
    this._workspaceJsonEditorDocKey = this._workspaceJsonEditorDocKey || 'workspace';
    this._workspaceJsonEditorSessionIndex = Number.isFinite(this._workspaceJsonEditorSessionIndex)
      ? this._workspaceJsonEditorSessionIndex
      : -1;
    this._populateWorkspaceJsonDocumentSelect(this._workspaceJsonEditorDocKey);
    this._populateWorkspaceJsonEditor(this._createWorkspaceJsonEditorBundle());
    return true;
  }

  _resetWorkspaceJsonEditorToCurrent() {
    const { docSelect, structuredEditor } = this._getWorkspaceJsonModalElements();
    if (!structuredEditor) return false;
    const docKey = docSelect?.value || this._workspaceJsonEditorDocKey || 'workspace';
    const sessionIndex = docKey === 'simulation-session' ? this._getWorkspaceJsonSessionSelectValue() : 'draft';
    const bundle = this._createWorkspaceJsonEditorBundle();
    const nextText = JSON.stringify(
      this._buildWorkspaceJsonDocument(bundle, docKey, { sessionIndex: sessionIndex === 'draft' ? -1 : sessionIndex }),
      null,
      2,
    );
    let currentText = '';
    try {
      currentText = this._getWorkspaceJsonEditorText();
    } catch {
      currentText = '';
    }
    if (currentText === nextText) {
      this._setWorkspaceJsonModalStatus('JSON editor already matches the current workspace snapshot.', 'success');
      return true;
    }
    if (!confirm('Discard JSON edits and reload the current workspace snapshot?')) {
      this._setWorkspaceJsonModalStatus('Reset cancelled.', 'warn');
      return false;
    }
    this._workspaceJsonEditorDocKey = docKey;
    this._workspaceJsonEditorSessionIndex = sessionIndex === 'draft' ? -1 : sessionIndex;
    this._populateWorkspaceJsonEditor(bundle);
    this._setWorkspaceJsonModalStatus(`${this._getWorkspaceJsonDocumentSpec(docKey).label} reloaded from the current workspace snapshot.`, 'success');
    this.showToast('↺ JSON reset to current');
    return true;
  }

  _isWorkspaceJsonPanelActive() {
    const panel = document.getElementById('jsonPanel');
    const drawer = document.getElementById('rightPanel');
    return !!panel?.classList.contains('active') && !!drawer?.classList.contains('open');
  }

  _activateRightPanelTab(viewName) {
    const rightPanel = document.getElementById('rightPanel');
    const rightTabs = document.getElementById('rightPanelTabs');
    const tab = rightTabs?.querySelector(`.panel-tab[data-panel-view="${viewName}"]`);
    const view = rightPanel?.querySelector(`.panel-view[data-panel-view="${viewName}"]`);
    if (!rightPanel || !rightTabs || !tab || !view) return false;
    rightTabs.querySelectorAll('.panel-tab').forEach(button => button.classList.remove('active'));
    rightPanel.querySelectorAll(':scope > .panel-view').forEach(panelView => panelView.classList.remove('active'));
    tab.classList.add('active');
    view.classList.add('active');
    rightPanel.classList.add('open');
    document.getElementById('sidebarToggle')?.classList.add('active');
    this._updateTabVisibility();
    return true;
  }

  _closeRightPanel() {
    document.getElementById('rightPanel')?.classList.remove('open');
    document.getElementById('sidebarToggle')?.classList.remove('active');
    this._updateTabVisibility();
  }

  _showWorkspaceJsonModal() {
    const { structuredEditor } = this._getWorkspaceJsonModalElements();
    if (!structuredEditor) return;
    this._activateRightPanelTab('json');
    this._refreshWorkspaceJsonPanel();
    requestAnimationFrame(() => {
      const firstField = structuredEditor.querySelector('[data-json-path][data-json-type]');
      firstField?.focus();
      firstField?.setSelectionRange?.(0, 0);
    });
  }

  _hideWorkspaceJsonModal() {
    if (this._colorPicker?.open) {
      this._closeColorPicker({ recordHistory: false });
    }
    this._cancelWorkspaceJsonAutoApply();
    this._closeRightPanel();
  }

  _readWorkspaceJsonEditorBundle({ requireSession = true } = {}) {
    const { docSelect } = this._getWorkspaceJsonModalElements();
    const parsed = this._readWorkspaceJsonStructuredDocument();
    const docKey = docSelect?.value || this._workspaceJsonEditorDocKey || 'workspace';
    if (docKey === 'workspace') {
      const normalized = this._normalizeWorkspaceSettingsBundle(parsed);
      if (requireSession && (!normalized.session || typeof normalized.session !== 'object' || Array.isArray(normalized.session))) {
        throw new Error('Workspace bundle is missing session settings.');
      }
      return { parsed, normalized, docKey };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Selected document must be a JSON object.');
    }
    return { parsed, normalized: parsed, docKey };
  }

  _formatWorkspaceJsonEditor() {
    const { structuredEditor } = this._getWorkspaceJsonModalElements();
    if (!structuredEditor) return false;
    const { parsed } = this._readWorkspaceJsonEditorBundle({ requireSession: false });
    this._workspaceJsonEditorBaseDoc = _deepClone(parsed);
    this._renderWorkspaceJsonStructuredEditor(parsed);
    this._setWorkspaceJsonModalStatus('Workspace JSON formatted.', 'success');
    this.showToast('✨ JSON formatted');
    return true;
  }

  _validateWorkspaceJsonEditor() {
    const { normalized, docKey } = this._readWorkspaceJsonEditorBundle();
    if (docKey === 'workspace') {
      const presetCount = normalized.presets && typeof normalized.presets === 'object' && !Array.isArray(normalized.presets)
        ? Object.keys(normalized.presets).length
        : 0;
      this._setWorkspaceJsonModalStatus(
        `Workspace JSON is valid. Ready to apply.${presetCount ? ` Includes ${presetCount} preset${presetCount === 1 ? '' : 's'}.` : ''}`,
        'success',
      );
      this.showToast('✓ JSON valid');
      return true;
    }
    this._setWorkspaceJsonModalStatus('Document JSON is valid. Ready to apply.', 'success');
    this.showToast('✓ JSON valid');
    return true;
  }

  async _copyWorkspaceJsonEditorText() {
    let text = '';
    try {
      text = this._getWorkspaceJsonEditorText();
    } catch (error) {
      this._setWorkspaceJsonModalStatus(error?.message || 'Nothing to copy from the workspace JSON editor.', 'warn');
      return false;
    }
    if (!text) {
      this._setWorkspaceJsonModalStatus('Nothing to copy from the workspace JSON editor.', 'warn');
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      this._setWorkspaceJsonModalStatus('Workspace JSON copied to the clipboard.', 'success');
      this.showToast('📋 Workspace JSON copied');
      return true;
    } catch (error) {
      console.error('Workspace JSON copy failed:', error);
      this._setWorkspaceJsonModalStatus('Clipboard copy failed. You can still select the JSON manually.', 'error');
      return false;
    }
  }

  async _applyWorkspaceJsonEditor({ skipConfirm = false, refreshEditor = true, quiet = false } = {}) {
    let parsed;
    let normalized;
    let docKey;
    try {
      ({ parsed, normalized, docKey } = this._readWorkspaceJsonEditorBundle());
    } catch (error) {
      this._setWorkspaceJsonModalStatus(error?.message || 'Workspace JSON validation failed.', 'error');
      return false;
    }
    const confirmMessage = docKey === 'workspace'
      ? (this.simulation?.enabled
        ? 'Apply workspace JSON and replace the current workspace state? This will stop simulation and restore the saved workspace state.'
        : 'Apply workspace JSON and replace the current workspace state?')
      : `Apply the ${this._getWorkspaceJsonDocumentSpec(docKey).label} document into the current workspace state?`;
    if (!skipConfirm && !confirm(confirmMessage)) {
      this._setWorkspaceJsonModalStatus('Apply cancelled.', 'warn');
      return false;
    }
    try {
      if (docKey === 'workspace') {
        await this.applyWorkspaceSettingsBundle(parsed);
      } else {
        const bundle = this._createWorkspaceJsonEditorBundle();
        const merged = this._mergeWorkspaceJsonDocumentIntoBundle(bundle, docKey, parsed, { sessionIndex: this._workspaceJsonEditorSessionIndex });
        await this.applyWorkspaceSettingsBundle(merged);
      }
      refreshWorkspaceSettingsUi(this);
      this._populateWorkspaceJsonDocumentSelect(docKey);
      if (refreshEditor) {
        this._populateWorkspaceJsonEditor(this._createWorkspaceJsonEditorBundle());
      } else {
        this._workspaceJsonEditorBaseDoc = _deepClone(parsed);
      }
      if (quiet) {
        this._setWorkspaceJsonModalStatus('Changes applied from the JSON value editor.', 'success');
      } else if (docKey === 'workspace') {
        const presetCount = normalized.presets && typeof normalized.presets === 'object' && !Array.isArray(normalized.presets)
          ? Object.keys(normalized.presets).length
          : 0;
        this._setWorkspaceJsonModalStatus(
          `Workspace JSON applied successfully.${presetCount ? ` Loaded ${presetCount} preset${presetCount === 1 ? '' : 's'}.` : ''}`,
          'success',
        );
      } else {
        this._setWorkspaceJsonModalStatus(`${this._getWorkspaceJsonDocumentSpec(docKey).label} applied successfully.`, 'success');
      }
      if (!quiet) this.showToast(`💾 ${this._getWorkspaceJsonDocumentSpec(docKey).label} applied`);
      return true;
    } catch (error) {
      console.error('Workspace JSON apply failed:', error);
      this._setWorkspaceJsonModalStatus(error?.message || 'Workspace apply failed.', 'error');
      return false;
    }
  }

  _mergeWorkspaceJsonDocumentIntoBundle(bundle, docKey, parsed, state = {}) {
    if (docKey === 'workspace') return parsed;
    const nextBundle = _deepClone(bundle || this._createWorkspaceJsonEditorBundle());
    nextBundle.session = _deepClone(nextBundle.session || {});
    nextBundle.session._simulation = _deepClone(nextBundle.session._simulation || {});
    const canvasKeys = this._workspaceJsonCanvasKeys();
    if (docKey.startsWith('brush-')) {
      Object.assign(nextBundle.session, _deepClone(parsed));
      return nextBundle;
    }
    if (docKey === 'simulation-global') {
      const simulation = nextBundle.session._simulation;
      for (const [key, value] of Object.entries(parsed || {})) {
        if (key === 'sessions' || key === 'brushData' || key === 'vars' || key === 'runtimeSessions' || key === 'cachedRuntimeSessions' || key === 'priorDrawSeek' || key === 'drawingPath' || key === 'drawingBlob' || key === 'dragTarget' || key === 'selected' || key === 'pathDistance') continue;
        simulation[key] = _deepClone(value);
      }
      return nextBundle;
    }
    if (docKey === 'simulation-session') {
      const simulation = nextBundle.session._simulation;
      const sessions = Array.isArray(simulation.sessions) ? _deepClone(simulation.sessions) : [];
      const sessionIndex = Number.isFinite(state.sessionIndex) ? state.sessionIndex : -1;
      if (sessionIndex >= 0 && sessions[sessionIndex]) {
        sessions[sessionIndex] = { ...sessions[sessionIndex], ..._deepClone(parsed) };
        simulation.sessions = sessions;
      } else {
        if (Object.prototype.hasOwnProperty.call(parsed, 'brushData')) simulation.brushData = _deepClone(parsed.brushData);
        if (Object.prototype.hasOwnProperty.call(parsed, 'vars')) simulation.vars = _deepClone(parsed.vars);
        if (Object.prototype.hasOwnProperty.call(parsed, 'sensingSourceSelection')) simulation.sensingSourceSelection = _deepClone(parsed.sensingSourceSelection);
        if (Object.prototype.hasOwnProperty.call(parsed, 'multiSessionEnabled')) simulation.multiSessionEnabled = !!parsed.multiSessionEnabled;
        if (Object.prototype.hasOwnProperty.call(parsed, 'multiSessionBindings')) simulation.multiSessionBindings = _deepClone(parsed.multiSessionBindings);
        if (Object.prototype.hasOwnProperty.call(parsed, 'activeSessionIndex')) simulation.activeSessionIndex = Number.isFinite(Number(parsed.activeSessionIndex)) ? Math.max(-1, Math.round(Number(parsed.activeSessionIndex))) : simulation.activeSessionIndex;
      }
      return nextBundle;
    }
    if (docKey === 'canvas') {
      for (const [key, value] of Object.entries(parsed || {})) {
        if (!canvasKeys.has(key)) continue;
        nextBundle.session[key] = _deepClone(value);
      }
      return nextBundle;
    }
    if (docKey === 'other') {
      if (Object.prototype.hasOwnProperty.call(parsed, 'autosaveEnabled')) nextBundle.autosaveEnabled = !!parsed.autosaveEnabled;
      if (Object.prototype.hasOwnProperty.call(parsed, 'presets')) nextBundle.presets = _deepClone(parsed.presets);
      for (const [key, value] of Object.entries(parsed || {})) {
        if (key === 'autosaveEnabled' || key === 'presets') continue;
        if (canvasKeys.has(key)) continue;
        if (this._workspaceJsonControlBrushTokens(key).length) continue;
        if (key === '_simulation') continue;
        nextBundle.session[key] = _deepClone(value);
      }
      return nextBundle;
    }
    return nextBundle;
  }

  _createSimulationExportState() {
    return {
      armedOnStart: false,
      recording: false,
      exportBusy: false,
      format: 'webm',
      frameRate: 30,
      quality: 'high',
      mimeType: '',
      recorder: null,
      stream: null,
      chunks: [],
      blob: null,
      stopPromise: null,
      resolveStop: null,
      stopAnnounce: false,
      ffmpeg: null,
      fetchFile: null,
      ffmpegLoaded: false,
      ffmpegLoadPromise: null,
    };
  }

  _showSimulationExportModal() {
    const modal = document.getElementById('simExportModal');
    if (!modal) return;
    const state = this._simulationExport;
    const formatEl = document.getElementById('simExportFormat');
    const fpsEl = document.getElementById('simExportFrameRate');
    const qualityEl = document.getElementById('simExportQuality');
    if (formatEl) formatEl.value = state.format;
    if (fpsEl) fpsEl.value = String(state.frameRate);
    if (qualityEl) qualityEl.value = state.quality;
    modal.classList.add('open');
    this._refreshSimulationExportUi();
  }

  _hideSimulationExportModal() {
    document.getElementById('simExportModal')?.classList.remove('open');
  }

  _readSimulationExportOptionsFromUi() {
    const state = this._simulationExport;
    const format = document.getElementById('simExportFormat')?.value || state.format;
    const frameRate = Math.max(1, Number(document.getElementById('simExportFrameRate')?.value || state.frameRate || 30));
    const quality = document.getElementById('simExportQuality')?.value || state.quality;
    state.format = format;
    state.frameRate = frameRate;
    state.quality = quality;
    return { format, frameRate, quality };
  }

  _formatSimulationFrameCounter() {
    return `Frame ${String(Math.max(0, Math.round(this.simulation.frameCount || 0))).padStart(4, '0')}`;
  }

  _refreshSimulationExportUi() {
    const state = this._simulationExport;
    const options = this._readSimulationExportOptionsFromUi();
    const recordBtn = document.getElementById('simRecordBtn');
    if (recordBtn) {
      recordBtn.classList.toggle('recording', state.recording);
      recordBtn.classList.toggle('active', state.recording || state.armedOnStart);
      recordBtn.textContent = state.recording ? '⏺ Stop Rec' : (state.armedOnStart ? '⏺ Armed' : '⏺ Record');
      recordBtn.disabled = state.exportBusy;
    }
    const exportBtn = document.getElementById('simExportBtn');
    if (exportBtn) {
      exportBtn.textContent = state.exportBusy ? 'Exporting…' : 'Export';
      exportBtn.disabled = state.exportBusy;
    }
    const frameCounter = document.getElementById('simFrameCounter');
    if (frameCounter) frameCounter.textContent = this._formatSimulationFrameCounter();
    const recordActionBtn = document.getElementById('simExportRecordAction');
    if (recordActionBtn) {
      recordActionBtn.textContent = state.recording ? 'Stop Recording' : (state.armedOnStart ? 'Cancel Auto-Record' : 'Start Recording');
      recordActionBtn.disabled = state.exportBusy;
    }
    const downloadBtn = document.getElementById('simExportDownloadBtn');
    if (downloadBtn) {
      downloadBtn.textContent = state.exportBusy ? 'Exporting…' : 'Export Latest';
      downloadBtn.disabled = state.exportBusy || (!state.blob && !state.recording);
    }
    const status = document.getElementById('simExportStatusText');
    if (status) {
      if (state.exportBusy) {
        status.textContent = `Exporting ${options.format.toUpperCase()} at ${options.frameRate} FPS (${options.quality})…`;
      } else if (state.recording) {
        status.textContent = `Recording in progress · ${options.frameRate} FPS · ${options.quality} quality · target ${options.format.toUpperCase()}`;
      } else if (state.armedOnStart) {
        status.textContent = `Auto-record armed · recording will start with the next simulation run · ${options.frameRate} FPS · ${options.quality} quality · target ${options.format.toUpperCase()}`;
      } else if (state.blob) {
        status.textContent = `Latest capture ready · ${(state.blob.size / (1024 * 1024)).toFixed(2)} MB · export ${options.format.toUpperCase()} at ${options.frameRate} FPS (${options.quality})`;
      } else {
        status.textContent = `No recording captured yet · ${options.frameRate} FPS · ${options.quality} quality · target ${options.format.toUpperCase()}`;
      }
    }
  }

  async _toggleSimulationRecordingRequest() {
    const state = this._simulationExport;
    if (state.recording) {
      await this._stopSimulationRecording();
      return;
    }
    if (state.armedOnStart) {
      state.armedOnStart = false;
      this._syncSimulationUI();
      this.showToast('Recording arm cleared');
      return;
    }
    if (this.simulation.running || this.simulation.paused) {
      await this._startSimulationRecording();
      return;
    }
    state.armedOnStart = true;
    this._syncSimulationUI();
    this.showToast('⏺ Recording armed for next run');
  }

  _getSimulationRecordingMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    return candidates.find(type => typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(type)) || '';
  }

  _getSimulationRecordingBitrate(quality = 'high', frameRate = 30) {
    const base = quality === 'low' ? 4_000_000 : quality === 'medium' ? 7_000_000 : 12_000_000;
    return Math.max(2_500_000, Math.round(base * Math.max(0.5, frameRate / 30)));
  }

  async _startSimulationRecording(options = this._readSimulationExportOptionsFromUi()) {
    const state = this._simulationExport;
    if (state.recording) return true;
    if (typeof MediaRecorder === 'undefined' || typeof this.compositeCanvas?.captureStream !== 'function') {
      this.showToast('⚠ Browser recording is unavailable');
      return false;
    }
    const mimeType = this._getSimulationRecordingMimeType();
    if (!mimeType) {
      this.showToast('⚠ No supported recording codec found');
      return false;
    }
    state.blob = null;
    state.chunks = [];
    state.armedOnStart = false;
    state.format = options.format;
    state.frameRate = options.frameRate;
    state.quality = options.quality;
    state.mimeType = mimeType;
    const stream = this.compositeCanvas.captureStream(options.frameRate);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: this._getSimulationRecordingBitrate(options.quality, options.frameRate),
    });
    state.stream = stream;
    state.recorder = recorder;
    state.recording = true;
    state.stopAnnounce = false;
    state.stopPromise = new Promise(resolve => {
      state.resolveStop = resolve;
    });
    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) state.chunks.push(event.data);
    };
    recorder.onerror = () => {
      this.showToast('⚠ Recording failed');
    };
    recorder.onstop = () => {
      const blob = state.chunks.length ? new Blob(state.chunks, { type: state.mimeType || 'video/webm' }) : null;
      state.blob = blob && blob.size ? blob : null;
      state.chunks = [];
      state.recording = false;
      state.recorder = null;
      for (const track of state.stream?.getTracks?.() || []) track.stop();
      state.stream = null;
      const resolve = state.resolveStop;
      state.resolveStop = null;
      state.stopPromise = null;
      if (state.stopAnnounce) this.showToast('⏹ Recording stopped');
      state.stopAnnounce = false;
      this._syncSimulationUI();
      if (resolve) resolve(state.blob);
    };
    recorder.start(SIM_EXPORT_TIMESLICE_MS);
    this.showToast('⏺ Recording started');
    this._syncSimulationUI();
    return true;
  }

  async _stopSimulationRecording({ announce = true } = {}) {
    const state = this._simulationExport;
    if (!state.recording) return state.blob;
    state.stopAnnounce = announce;
    const stopPromise = state.stopPromise;
    try {
      state.recorder?.stop();
    } catch {
      state.recording = false;
      state.recorder = null;
      for (const track of state.stream?.getTracks?.() || []) track.stop();
      state.stream = null;
      const resolve = state.resolveStop;
      state.resolveStop = null;
      state.stopPromise = null;
      if (resolve) resolve(state.blob);
    }
    this._syncSimulationUI();
    return stopPromise;
  }

  async _ensureSimulationRecordingBlob() {
    if (this._simulationExport.recording) return this._stopSimulationRecording({ announce: false });
    return this._simulationExport.blob;
  }

  async _loadSimulationExportFfmpeg() {
    const state = this._simulationExport;
    if (state.ffmpegLoaded && state.ffmpeg && state.fetchFile) return state;
    if (!state.ffmpegLoadPromise) {
      state.ffmpegLoadPromise = (async () => {
        const ffmpegModule = await import(SIM_EXPORT_FFMPEG_URL);
        const utilModule = await import(SIM_EXPORT_FFMPEG_UTIL_URL);
        const ffmpeg = new ffmpegModule.FFmpeg();
        const coreURL = await utilModule.toBlobURL(`${SIM_EXPORT_FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript');
        const wasmURL = await utilModule.toBlobURL(`${SIM_EXPORT_FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm');
        const workerURL = await utilModule.toBlobURL(`${SIM_EXPORT_FFMPEG_CORE_BASE_URL}/ffmpeg-core.worker.js`, 'text/javascript');
        await ffmpeg.load({ coreURL, wasmURL, workerURL });
        state.ffmpeg = ffmpeg;
        state.fetchFile = utilModule.fetchFile;
        state.ffmpegLoaded = true;
      })();
    }
    try {
      await state.ffmpegLoadPromise;
    } finally {
      state.ffmpegLoadPromise = null;
    }
    return state;
  }

  async _transcodeSimulationRecording(blob, options) {
    if (!blob) return null;
    if (options.format === 'webm') {
      return { blob, extension: 'webm', mimeType: blob.type || 'video/webm' };
    }
    const state = await this._loadSimulationExportFfmpeg();
    const ffmpeg = state.ffmpeg;
    const fetchFile = state.fetchFile;
    const inputName = 'simulation-input.webm';
    const outputName = options.format === 'gif' ? 'simulation-output.gif' : 'simulation-output.mp4';
    await ffmpeg.writeFile(inputName, await fetchFile(blob));
    try {
      if (options.format === 'gif') {
        const gifFps = Math.min(options.frameRate, options.quality === 'low' ? 12 : options.quality === 'medium' ? 16 : 20);
        const gifScale = options.quality === 'low'
          ? 'trunc(iw*0.7/2)*2'
          : options.quality === 'medium'
            ? 'trunc(iw*0.85/2)*2'
            : 'iw';
        await ffmpeg.exec([
          '-i', inputName,
          '-vf', `fps=${gifFps},scale=${gifScale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
          outputName,
        ]);
        const data = await ffmpeg.readFile(outputName);
        return { blob: new Blob([data], { type: 'image/gif' }), extension: 'gif', mimeType: 'image/gif' };
      }
      const mp4Quality = options.quality === 'low' ? '12' : options.quality === 'medium' ? '8' : '5';
      await ffmpeg.exec([
        '-i', inputName,
        '-r', String(options.frameRate),
        '-c:v', 'mpeg4',
        '-q:v', mp4Quality,
        '-pix_fmt', 'yuv420p',
        outputName,
      ]);
      const data = await ffmpeg.readFile(outputName);
      return { blob: new Blob([data], { type: 'video/mp4' }), extension: 'mp4', mimeType: 'video/mp4' };
    } finally {
      try { await ffmpeg.deleteFile(inputName); } catch {}
      try { await ffmpeg.deleteFile(outputName); } catch {}
    }
  }

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  }

  async _exportSimulationRecording() {
    const state = this._simulationExport;
    if (state.exportBusy) return;
    const options = this._readSimulationExportOptionsFromUi();
    const sourceBlob = await this._ensureSimulationRecordingBlob();
    if (!sourceBlob) {
      this.showToast('⚠ Record a simulation first');
      this._refreshSimulationExportUi();
      return;
    }
    state.exportBusy = true;
    this._syncSimulationUI();
    try {
      const exported = await this._transcodeSimulationRecording(sourceBlob, options);
      if (!exported?.blob) throw new Error('No export output produced');
      const stamp = new Date().toISOString().replace(/[.:]/g, '-');
      this._downloadBlob(exported.blob, `simulation-${stamp}.${exported.extension}`);
      this.showToast(`💾 Exported ${exported.extension.toUpperCase()}`);
    } catch (error) {
      console.error('Simulation export failed:', error);
      this.showToast(options.format === 'webm' ? '⚠ Export failed' : '⚠ Export failed — try WebM');
    } finally {
      state.exportBusy = false;
      this._syncSimulationUI();
    }
  }

  resetSimulationPlayback() {
    void this._stopSimulationRecording({ announce: false });
    this.stopSimulation(false);
    this._simulationSavedPlaybackCapture = null;
    this.simulation.frameCount = 0;
    this.simulation.pathDistance = 0;
    for (const pathItem of this._getSimulationBrushData('boid')?.paths || []) {
      pathItem.travelDistance = 0;
    }
    this._syncSimulationUI();
    this.showToast('Simulation reset');
  }

  _onCanvasSizePresetChange() {
    const preset = document.getElementById('canvasSizePreset')?.value;
    if (!preset || preset === 'custom') return;
    const [w, h] = preset.split('x').map(Number);
    const wEl = document.getElementById('canvasSizeW');
    const hEl = document.getElementById('canvasSizeH');
    if (wEl) wEl.value = w;
    if (hEl) hEl.value = h;
  }

  makeLayerCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = this.W * this.DPR;
    canvas.height = this.H * this.DPR;
    const ctx = canvas.getContext('2d', { desynchronized: true, willReadFrequently: true });
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    return { canvas, ctx };
  }

  _createLayerRecord(canvas, ctx, props = {}) {
    const layer = {
      id: props.id || this._allocateLayerId(),
      canvas,
      ctx,
      visible: true,
      opacity: 1,
      blend: 'source-over',
      dirty: true,
      dirtyTiles: null,
      glTex: null,
      gpuPreviewCanvas: null,
      alphaLock: false,
      ...props,
    };
    this._noteLayerId(layer.id);
    canvas._bbLayer = layer;
    return layer;
  }

  _allocateLayerId() {
    const id = `layer-${this._nextLayerId}`;
    this._nextLayerId += 1;
    return id;
  }

  _noteLayerId(id) {
    const match = /^layer-(\d+)$/.exec(String(id || ''));
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isFinite(numericId) && numericId >= this._nextLayerId) {
      this._nextLayerId = numericId + 1;
    }
  }

  _markLayerDirty(layer, rect = null) {
    if (!layer) return;
    if (!rect) {
      layer.dirty = true;
      layer.dirtyTiles = null;
      return;
    }
    const x0 = Math.max(0, Math.min(this.W, rect.x));
    const y0 = Math.max(0, Math.min(this.H, rect.y));
    const x1 = Math.max(0, Math.min(this.W, rect.x + rect.w));
    const y1 = Math.max(0, Math.min(this.H, rect.y + rect.h));
    if (x1 <= x0 || y1 <= y0) return;
    if (layer.dirty && !layer.dirtyTiles) return;
    layer.dirty = true;
    const tiles = layer.dirtyTiles ||= new Set();
    const minTX = Math.floor(x0 / DIRTY_TILE_SIZE);
    const maxTX = Math.floor((x1 - 1) / DIRTY_TILE_SIZE);
    const minTY = Math.floor(y0 / DIRTY_TILE_SIZE);
    const maxTY = Math.floor((y1 - 1) / DIRTY_TILE_SIZE);
    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        tiles.add(`${tx},${ty}`);
      }
    }
    const totalTilesX = Math.max(1, Math.ceil(this.W / DIRTY_TILE_SIZE));
    const totalTilesY = Math.max(1, Math.ceil(this.H / DIRTY_TILE_SIZE));
    const maxTiles = Math.max(1, Math.floor(totalTilesX * totalTilesY * DIRTY_TILE_MAX_COVERAGE));
    if (tiles.size > maxTiles) {
      layer.dirtyTiles = null;
    }
  }

  _markContextDirty(ctx, rect = null) {
    this._markLayerDirty(ctx?.canvas?._bbLayer || null, rect);
  }

  // ========================================================
  // LAYERS
  // ========================================================

  addLayer(name) {
    const { canvas, ctx } = this.makeLayerCanvas();
    this.layers.splice(this.activeLayerIdx, 0, this._createLayerRecord(canvas, ctx, {
      name: name || `Layer ${this.layers.length + 1}`,
    }));
    this._syncLayerSwitcher();
    this.compositeAllLayers();
  }

  _getLayerById(id) {
    if (!id) return null;
    return this.layers.find(layer => layer.id === id) || null;
  }

  getActiveLayerIndex() {
    const overrideLayerId = this._simulationContextOverride?.layerId;
    if (!overrideLayerId) return this.activeLayerIdx;
    const index = this.layers.findIndex(layer => layer.id === overrideLayerId);
    return index >= 0 ? index : this.activeLayerIdx;
  }

  getActiveLayer() {
    const overrideLayer = this._getLayerById(this._simulationContextOverride?.layerId);
    return overrideLayer || this.layers[this.activeLayerIdx];
  }

  getSuggestedViewBookmarkName() {
    const activeLayer = this.getActiveLayer();
    const baseName = typeof activeLayer?.name === 'string' && activeLayer.name.trim()
      ? activeLayer.name.trim()
      : VIEW_BOOKMARK_DEFAULT_NAME;
    let suffix = this.viewBookmarks.length + 1;
    let candidate = `${baseName} ${suffix}`;
    const existing = new Set(this.viewBookmarks.map(bookmark => String(bookmark?.name || '').trim().toLowerCase()).filter(Boolean));
    while (existing.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${baseName} ${suffix}`;
    }
    return candidate;
  }

  toggleAlphaLock() {
    const layer = this.getActiveLayer();
    if (!layer) return;
    layer.alphaLock = !layer.alphaLock;
    this._syncAlphaLockUI();
    if (typeof syncUI === 'function') syncUI(this);
  }

  _syncAlphaLockUI() {
    const btn = document.getElementById('alphaLockBtn');
    if (!btn) return;
    const layer = this.getActiveLayer();
    const on = layer && layer.alphaLock;
    btn.classList.toggle('active-lock', on);
    btn.title = `Alpha Lock (/) ${on ? 'ON' : 'OFF'}`;
  }

  // ── Background layer ──────────────────────────────────────

  _addBackgroundLayer() {
    const { canvas, ctx } = this.makeLayerCanvas();
     const bgLayer = this._createLayerRecord(canvas, ctx, {
      name: 'Background', isBackground: true,
    });
    this.layers.push(bgLayer); // always last = bottom
    this._fillBackgroundLayer();
  }

  _fillBackgroundLayer() {
    const bg = this.layers.find(l => l.isBackground);
    if (!bg) return;
    const color = this.bgColorEl ? this.bgColorEl.value : '#ffffff';
    bg.ctx.save();
    bg.ctx.setTransform(1, 0, 0, 1, 0, 0);
    bg.ctx.globalAlpha = 1;
    // Replace the entire backing store so browsers do not keep any stale
    // transparent pixels from an earlier frame.
    bg.ctx.globalCompositeOperation = 'copy';
    bg.ctx.fillStyle = color;
    bg.ctx.fillRect(0, 0, bg.canvas.width, bg.canvas.height);
    bg.ctx.restore();
    bg.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    bg.dirty = true;
    bg.dirtyTiles = null;
  }

  _normalizeHexColor(color, fallback = null) {
    if (typeof color !== 'string') return fallback;
    const trimmed = color.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
    if (/^#[0-9a-f]{3}$/.test(trimmed)) {
      return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
    }
    return fallback;
  }

  _isCustomColorTarget(target) {
    return !!target && typeof target === 'object';
  }

  _getColorTargetKey(target) {
    if (this._isCustomColorTarget(target)) {
      return String(target.key || target.input?.id || target.trigger?.id || target.label || 'custom');
    }
    return String(target || '');
  }

  _getColorInput(target) {
    if (this._isCustomColorTarget(target)) return target.input || null;
    if (target === 'primary') return this.primaryEl;
    if (target === 'secondary') return this.secondaryEl;
    if (target === 'background') return this.bgColorEl;
    return null;
  }

  getColorValue(target, fallback = '#ffffff') {
    if (this._isCustomColorTarget(target) && typeof target.getValue === 'function') {
      return this._normalizeHexColor(target.getValue(), fallback) || fallback;
    }
    const input = this._getColorInput(target);
    return this._normalizeHexColor(input?.value, fallback) || fallback;
  }

  setColorValue(target, color, options = {}) {
    const input = this._getColorInput(target);
    const normalized = this._normalizeHexColor(color, this.getColorValue(target));
    if (!normalized) return null;
    const changed = this.getColorValue(target, normalized) !== normalized;
    if (this._isCustomColorTarget(target)) {
      if (typeof target.setValue === 'function') target.setValue(normalized, options);
      else if (input) input.value = normalized;
    } else {
      if (!input) return null;
      input.value = normalized;
    }
    if (options.recordHistory && this._getColorTargetKey(target) === 'primary') this._recordColor(normalized);
    if (!options.silent && (changed || options.forceEvent)) {
      const eventName = this._isCustomColorTarget(target) ? target.eventName : 'input';
      if (input && eventName) input.dispatchEvent(new Event(eventName, { bubbles: true }));
      if (this._isCustomColorTarget(target) && typeof target.onInput === 'function') {
        target.onInput(normalized, options);
      }
    }
    return normalized;
  }

  _updateTabVisibility() {
    const alwaysShow = document.getElementById('alwaysShowTabs')?.checked || false;
    const leftPanel = document.getElementById('leftPanel');
    const rightPanel = document.getElementById('rightPanel');
    const leftTabs = document.getElementById('leftPanelTabs');
    const rightTabs = document.getElementById('rightPanelTabs');
    const leftOpen = leftPanel?.classList.contains('open');
    const rightOpen = rightPanel?.classList.contains('open');
    const rightView = rightPanel?.querySelector(':scope > .panel-view.active')?.dataset.panelView || '';
    document.body.classList.toggle('json-panel-expanded', rightOpen && rightView === 'json');
    const simDrawerTab = leftTabs?.querySelector('.panel-tab[data-panel-view="simulationControls"]');
    const simDrawerAvailable = !!simDrawerTab && !simDrawerTab.classList.contains('panel-tab-hidden');
    if (leftTabs) {
      leftTabs.classList.toggle('panel-tabs--visible', alwaysShow || leftOpen || simDrawerAvailable);
      leftTabs.classList.toggle('panel-tabs--open', !!leftOpen);
    }
    if (rightTabs) {
      rightTabs.classList.toggle('panel-tabs--visible', alwaysShow || rightOpen);
      rightTabs.classList.toggle('panel-tabs--open', !!rightOpen);
    }
  }

  _isSimulationOverlayHudEnabled() {
    return !!document.getElementById('showSimulationOverlayControls')?.checked;
  }

  _isSimulationSelectionOverlayEnabled() {
    const input = document.getElementById('showSimulationSelectionOverlay');
    return input ? !!input.checked : true;
  }

  _showSimulationControlsDrawer({ activate = false } = {}) {
    const leftTabs = document.getElementById('leftPanelTabs');
    const leftPanel = document.getElementById('leftPanel');
    const simTab = leftTabs?.querySelector('.panel-tab[data-panel-view="simulationControls"]');
    const simView = document.getElementById('simulationControlsPanel');
    if (!leftTabs || !leftPanel || !simTab || !simView) return;
    simTab.classList.remove('panel-tab-hidden');
    if (activate) {
      leftTabs.querySelectorAll('.panel-tab').forEach(tab => tab.classList.remove('active'));
      leftPanel.querySelectorAll(':scope > .panel-view').forEach(view => view.classList.remove('active'));
      simTab.classList.add('active');
      simView.classList.add('active');
      leftPanel.classList.add('open');
      document.getElementById('layersToggle')?.classList.add('active');
    }
    this._updateTabVisibility();
  }

  _hideSimulationControlsDrawer({ closeIfActive = false } = {}) {
    const leftTabs = document.getElementById('leftPanelTabs');
    const leftPanel = document.getElementById('leftPanel');
    const layersTab = leftTabs?.querySelector('.panel-tab[data-panel-view="layers"]');
    const simTab = leftTabs?.querySelector('.panel-tab[data-panel-view="simulationControls"]');
    const layersView = document.getElementById('layersPanel');
    const simView = document.getElementById('simulationControlsPanel');
    const activeViewName = leftPanel?.querySelector(':scope > .panel-view.active')?.dataset.panelView;
    const wasActive = activeViewName === 'simulationControls' || !!simTab?.classList.contains('active');
    if (simTab) {
      simTab.classList.add('panel-tab-hidden');
      simTab.classList.remove('active');
    }
    simView?.classList.remove('active');
    if (wasActive) {
      layersTab?.classList.add('active');
      layersView?.classList.add('active');
      if (closeIfActive) {
        leftPanel?.classList.remove('open');
        document.getElementById('layersToggle')?.classList.remove('active');
      }
    }
    this._updateTabVisibility();
  }

  swapPaintColors() {
    const primary = this.getColorValue('primary', '#1a1a1a');
    const secondary = this.getColorValue('secondary', '#ffffff');
    this.setColorValue('primary', secondary);
    this.setColorValue('secondary', primary);
  }

  setBackgroundColor(color) {
    this.setColorValue('background', color, { forceEvent: true });
  }

  _getColorTrigger(target) {
    if (this._isCustomColorTarget(target)) return target.trigger || target.anchorEl || null;
    if (target === 'primary') return document.getElementById('primaryColorTrigger');
    if (target === 'secondary') return document.getElementById('secondaryColorTrigger');
    if (target === 'background') return document.getElementById('bgColorTrigger');
    return null;
  }

  _getColorTargetLabel(target) {
    if (this._isCustomColorTarget(target)) return target.label || 'Color';
    if (target === 'secondary') return 'Secondary Color';
    if (target === 'background') return 'Background Color';
    return 'Primary Color';
  }

  _setColorTriggerActive(trigger, active) {
    if (!trigger) return;
    trigger.classList.toggle('active', !!active);
    trigger.setAttribute('aria-expanded', active ? 'true' : 'false');
  }

  _hexToRgb(hex) {
    const normalized = this._normalizeHexColor(hex, null);
    if (!normalized) return null;
    return {
      r: parseInt(normalized.slice(1, 3), 16),
      g: parseInt(normalized.slice(3, 5), 16),
      b: parseInt(normalized.slice(5, 7), 16),
    };
  }

  _rgbToHsl(r, g, b) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const lightness = (max + min) / 2;
    let hue = 0;
    let saturation = 0;

    if (max !== min) {
      const delta = max - min;
      saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
      switch (max) {
        case red:
          hue = ((green - blue) / delta) + (green < blue ? 6 : 0);
          break;
        case green:
          hue = ((blue - red) / delta) + 2;
          break;
        default:
          hue = ((red - green) / delta) + 4;
          break;
      }
      hue *= 60;
    }

    return {
      hue,
      saturation: saturation * 100,
      lightness: lightness * 100,
    };
  }

  _hexToHsl(hex) {
    const rgb = this._hexToRgb(hex);
    return rgb ? this._rgbToHsl(rgb.r, rgb.g, rgb.b) : { hue: 0, saturation: 100, lightness: 50 };
  }

  _hslToRgb(hue, saturation, lightness) {
    const h = (((hue % 360) + 360) % 360) / 360;
    const s = Math.max(0, Math.min(100, saturation)) / 100;
    const l = Math.max(0, Math.min(100, lightness)) / 100;
    if (s === 0) {
      const value = Math.round(l * 255);
      return { r: value, g: value, b: value };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - (l * s);
    const p = 2 * l - q;
    const hueToRgb = t => {
      let next = t;
      if (next < 0) next += 1;
      if (next > 1) next -= 1;
      if (next < 1 / 6) return p + ((q - p) * 6 * next);
      if (next < 1 / 2) return q;
      if (next < 2 / 3) return p + ((q - p) * (2 / 3 - next) * 6);
      return p;
    };
    return {
      r: Math.round(hueToRgb(h + 1 / 3) * 255),
      g: Math.round(hueToRgb(h) * 255),
      b: Math.round(hueToRgb(h - 1 / 3) * 255),
    };
  }

  _hslToHex(hue, saturation, lightness) {
    const { r, g, b } = this._hslToRgb(hue, saturation, lightness);
    const toHex = value => value.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  _syncColorPickerStateFromHex(hex) {
    const next = this._hexToHsl(hex);
    this._colorPicker.hue = next.hue;
    this._colorPicker.saturation = next.saturation;
    this._colorPicker.lightness = next.lightness;
  }

  _applyColorPickerState() {
    const picker = this._colorPicker;
    const hex = this._hslToHex(picker.hue, picker.saturation, picker.lightness);
    this.setColorValue(picker.target, hex);
    picker.changedSinceOpen = hex !== picker.initialHex;
    this._syncColorPickerUi();
  }

  _syncColorTriggerSwatches() {
    const activeKey = this._colorPicker.open ? this._getColorTargetKey(this._colorPicker.target) : '';
    ['primary', 'secondary', 'background'].forEach(target => {
      const trigger = this._getColorTrigger(target);
      if (!trigger) return;
      const chip = trigger.querySelector('.topbar-color-chip');
      if (chip) chip.style.background = this.getColorValue(target, '#ffffff');
      this._setColorTriggerActive(trigger, activeKey === this._getColorTargetKey(target));
    });
    this._syncCanvasSizeColorTrigger();
    const customTrigger = this._getColorTrigger(this._colorPicker.target);
    if (customTrigger && !['primaryColorTrigger', 'secondaryColorTrigger', 'bgColorTrigger'].includes(customTrigger.id || '')) {
      this._setColorTriggerActive(customTrigger, this._colorPicker.open);
    }
  }

  _syncCanvasSizeColorTrigger(color = null) {
    const trigger = document.getElementById('canvasSizeBgTrigger');
    const chip = trigger?.querySelector('.canvas-size-color-chip');
    const valueEl = document.getElementById('canvasSizeBgValue');
    const input = document.getElementById('canvasSizeBg');
    const normalized = this._normalizeHexColor(color, input?.value || '#ffffff') || '#ffffff';
    if (input) input.value = normalized;
    if (chip) chip.style.background = normalized;
    if (valueEl) valueEl.textContent = normalized.toUpperCase();
  }

  _getCanvasSizeColorTarget() {
    const input = document.getElementById('canvasSizeBg');
    const trigger = document.getElementById('canvasSizeBgTrigger');
    if (!input || !trigger) return null;
    return {
      key: 'canvasSizeBg',
      input,
      trigger,
      label: 'Canvas Background',
      eventName: false,
      getValue: () => input.value,
      setValue: normalized => {
        input.value = normalized;
        this._syncCanvasSizeColorTrigger(normalized);
      },
    };
  }

  _syncSimulationFormatColorTrigger(trigger, color) {
    if (!trigger) return;
    const chip = trigger.querySelector('.sim-format-colorChip');
    const normalized = this._normalizeHexColor(color, '#1a1a1a') || '#1a1a1a';
    if (chip) chip.style.background = normalized;
    trigger.title = normalized.toUpperCase();
  }

  _getSimulationFormatColorTarget(trigger) {
    if (!trigger) return null;
    const input = trigger.nextElementSibling?.matches?.('[data-sim-field][data-sim-type="color"]')
      ? trigger.nextElementSibling
      : null;
    if (!input) return null;
    const entry = this._getSelectedSimulationEntry();
    const field = trigger.dataset.simColorTrigger || input.dataset.simField || 'color';
    const label = field === 'color'
      ? 'Simulation Color'
      : `${field.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase())} Color`;
    const entryKey = entry ? `${entry.collection}:${entry.id}` : 'selection';
    return {
      key: `sim-format:${entryKey}:${field}`,
      input,
      trigger,
      label,
      eventName: false,
      getValue: () => input.value,
      setValue: normalized => {
        input.value = normalized;
        delete input.dataset.simUnset;
        this._syncSimulationFormatColorTrigger(trigger, normalized);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      onCommit: () => input.dispatchEvent(new Event('change', { bubbles: true })),
    };
  }

  _renderColorPickerHistory() {
    const container = document.getElementById('colorPickerHistory');
    if (!container) return;
    container.innerHTML = '';
    for (const hex of this._colorHistory) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'color-picker-historySwatch';
      swatch.title = hex;
      swatch.style.background = hex;
      swatch.addEventListener('click', e => {
        e.stopPropagation();
        this._syncColorPickerStateFromHex(hex);
        this._applyColorPickerState();
      });
      container.appendChild(swatch);
    }
  }

  _drawColorWheel() {
    const canvas = document.getElementById('colorWheelCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const picker = this._colorPicker;
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const outerRadius = (size / 2) - 8;
    const innerRadius = outerRadius - 28;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    if (typeof ctx.createConicGradient === 'function') {
      const gradient = ctx.createConicGradient(0, cx, cy);
      gradient.addColorStop(0, '#ff0000');
      gradient.addColorStop(1 / 6, '#ffff00');
      gradient.addColorStop(2 / 6, '#00ff00');
      gradient.addColorStop(3 / 6, '#00ffff');
      gradient.addColorStop(4 / 6, '#0000ff');
      gradient.addColorStop(5 / 6, '#ff00ff');
      gradient.addColorStop(1, '#ff0000');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let step = 0; step < 360; step += 1) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, outerRadius, (step - 1) * Math.PI / 180, step * Math.PI / 180);
        ctx.closePath();
        ctx.fillStyle = `hsl(${step},100%,50%)`;
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const currentHex = this._hslToHex(picker.hue, picker.saturation, picker.lightness);
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius - 10, 0, Math.PI * 2);
    ctx.fillStyle = currentHex;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const markerRadius = (outerRadius + innerRadius) / 2;
    const markerAngle = picker.hue * Math.PI / 180;
    const markerX = cx + Math.cos(markerAngle) * markerRadius;
    const markerY = cy + Math.sin(markerAngle) * markerRadius;
    ctx.beginPath();
    ctx.arc(markerX, markerY, 8, 0, Math.PI * 2);
    ctx.fillStyle = currentHex;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(markerX, markerY, 10.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _syncColorPickerUi() {
    this._syncColorTriggerSwatches();
    const panel = document.getElementById('colorPickerPanel');
    if (!panel) return;
    const picker = this._colorPicker;
    const title = document.getElementById('colorPickerTitle');
    const previewSwatch = document.getElementById('colorPreviewSwatch');
    const saturationSlider = document.getElementById('colorSaturationSlider');
    const lightnessSlider = document.getElementById('colorLightnessSlider');
    const saturationValue = document.getElementById('colorSaturationValue');
    const lightnessValue = document.getElementById('colorLightnessValue');
    const hexInput = document.getElementById('colorHexInput');
    const currentHex = this._hslToHex(picker.hue, picker.saturation, picker.lightness);
    if (title) title.textContent = this._getColorTargetLabel(picker.target);
    if (previewSwatch) previewSwatch.style.background = currentHex;
    if (saturationSlider) {
      saturationSlider.value = String(Math.round(picker.saturation));
      saturationSlider.style.setProperty('--slider-track', `linear-gradient(90deg, hsl(${picker.hue} 0% ${picker.lightness}%), hsl(${picker.hue} 100% ${picker.lightness}%))`);
    }
    if (lightnessSlider) {
      lightnessSlider.value = String(Math.round(picker.lightness));
      lightnessSlider.style.setProperty('--slider-track', `linear-gradient(90deg, hsl(${picker.hue} ${picker.saturation}% 0%), hsl(${picker.hue} ${picker.saturation}% 50%), hsl(${picker.hue} ${picker.saturation}% 100%))`);
    }
    if (saturationValue) saturationValue.textContent = `${Math.round(picker.saturation)}%`;
    if (lightnessValue) lightnessValue.textContent = `${Math.round(picker.lightness)}%`;
    if (hexInput && document.activeElement !== hexInput) {
      hexInput.value = currentHex.toUpperCase();
      hexInput.classList.remove('invalid');
    }
    panel.setAttribute('aria-hidden', picker.open ? 'false' : 'true');
    this._renderColorPickerHistory();
    this._drawColorWheel();
  }

  _positionColorPickerPanel() {
    const panel = document.getElementById('colorPickerPanel');
    const picker = this._colorPicker;
    if (!panel || !picker.open) return;
    const anchor = picker.anchorEl || this._getColorTrigger(picker.target);
    if (!anchor) return;
    panel.style.left = '-9999px';
    panel.style.top = '-9999px';
    panel.style.display = 'block';
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 12;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 10;
    if (left + panelRect.width > window.innerWidth - margin) {
      left = window.innerWidth - panelRect.width - margin;
    }
    if (left < margin) left = margin;
    if (top + panelRect.height > window.innerHeight - margin) {
      top = anchorRect.top - panelRect.height - 10;
    }
    if (top < margin) top = margin;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  _openColorPicker(target, anchorEl = null) {
    const panel = document.getElementById('colorPickerPanel');
    if (!panel) return;
    const picker = this._colorPicker;
    if (picker.open && picker.anchorEl && picker.anchorEl !== (anchorEl || this._getColorTrigger(target))) {
      this._setColorTriggerActive(picker.anchorEl, false);
    }
    picker.target = target;
    picker.anchorEl = anchorEl || this._getColorTrigger(target);
    picker.initialHex = this.getColorValue(target, '#ffffff');
    picker.changedSinceOpen = false;
    picker.open = true;
    this._syncColorPickerStateFromHex(picker.initialHex);
    panel.classList.add('open');
    this._setColorTriggerActive(picker.anchorEl, true);
    this._syncColorPickerUi();
    this._positionColorPickerPanel();
  }

  _closeColorPicker(options = {}) {
    const panel = document.getElementById('colorPickerPanel');
    const picker = this._colorPicker;
    if (!panel || !picker.open) {
      this._syncColorTriggerSwatches();
      return;
    }
    const target = picker.target;
    const trigger = picker.anchorEl || this._getColorTrigger(target);
    const finalHex = this.getColorValue(target, '#ffffff');
    const shouldRecordHistory = options.recordHistory !== false && picker.changedSinceOpen;
    const shouldCommitTarget = picker.changedSinceOpen && this._isCustomColorTarget(target) && typeof target.onCommit === 'function';
    picker.open = false;
    picker.anchorEl = null;
    picker.wheelPointerId = null;
    picker.changedSinceOpen = false;
    panel.classList.remove('open');
    panel.style.display = '';
    this._setColorTriggerActive(trigger, false);
    if (shouldRecordHistory) this._recordColor(finalHex);
    if (shouldCommitTarget) target.onCommit(finalHex, options);
    this._syncColorTriggerSwatches();
  }

  _handleColorInputSync(target) {
    if (this._colorPicker.open && this._getColorTargetKey(this._colorPicker.target) === this._getColorTargetKey(target)) {
      this._syncColorPickerStateFromHex(this.getColorValue(target, '#ffffff'));
    }
    this._syncColorPickerUi();
  }

  _updateColorPickerHueFromPointerEvent(event) {
    const canvas = document.getElementById('colorWheelCanvas');
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const outerRadius = (canvas.width / 2) - 8;
    const innerRadius = outerRadius - 28;
    const dx = x - cx;
    const dy = y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance < innerRadius - 14 || distance > outerRadius + 14) return false;
    this._colorPicker.hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    this._applyColorPickerState();
    return true;
  }

  _initColorPickerBindings() {
    if (this._colorPicker.refs) {
      this._syncColorPickerUi();
      return;
    }
    const refs = {
      panel: document.getElementById('colorPickerPanel'),
      closeBtn: document.getElementById('colorPickerClose'),
      wheel: document.getElementById('colorWheelCanvas'),
      saturationSlider: document.getElementById('colorSaturationSlider'),
      lightnessSlider: document.getElementById('colorLightnessSlider'),
      hexInput: document.getElementById('colorHexInput'),
    };
    if (!refs.panel || !refs.wheel || !refs.saturationSlider || !refs.lightnessSlider || !refs.hexInput) return;
    this._colorPicker.refs = refs;

    ['primary', 'secondary', 'background'].forEach(target => {
      const trigger = this._getColorTrigger(target);
      trigger?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (this._colorPicker.open && this._getColorTargetKey(this._colorPicker.target) === this._getColorTargetKey(target)) {
          this._closeColorPicker();
          return;
        }
        this._openColorPicker(target, trigger);
      });
    });

    document.getElementById('canvasSizeBgTrigger')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const target = this._getCanvasSizeColorTarget();
      if (!target) return;
      if (this._colorPicker.open && this._getColorTargetKey(this._colorPicker.target) === this._getColorTargetKey(target)) {
        this._closeColorPicker({ recordHistory: false });
        return;
      }
      this._openColorPicker(target, event.currentTarget);
    });

    refs.panel.addEventListener('click', event => event.stopPropagation());
    refs.closeBtn.addEventListener('click', () => this._closeColorPicker());
    refs.saturationSlider.addEventListener('input', () => {
      this._colorPicker.saturation = +refs.saturationSlider.value;
      this._applyColorPickerState();
    });
    refs.lightnessSlider.addEventListener('input', () => {
      this._colorPicker.lightness = +refs.lightnessSlider.value;
      this._applyColorPickerState();
    });
    refs.hexInput.addEventListener('input', () => {
      const raw = refs.hexInput.value.trim();
      if (!/^#?[0-9a-fA-F]{0,6}$/.test(raw)) {
        refs.hexInput.classList.add('invalid');
        return;
      }
      const candidate = raw.startsWith('#') ? raw : `#${raw}`;
      const normalized = this._normalizeHexColor(candidate, null);
      refs.hexInput.classList.remove('invalid');
      if (!normalized) return;
      this._syncColorPickerStateFromHex(normalized);
      this._applyColorPickerState();
    });
    refs.hexInput.addEventListener('blur', () => {
      const raw = refs.hexInput.value.trim();
      const candidate = raw.startsWith('#') ? raw : `#${raw}`;
      const normalized = this._normalizeHexColor(candidate, null);
      refs.hexInput.classList.remove('invalid');
      if (normalized) {
        this._syncColorPickerStateFromHex(normalized);
        this._applyColorPickerState();
      }
      refs.hexInput.value = this.getColorValue(this._colorPicker.target, '#ffffff').toUpperCase();
    });
    refs.hexInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        refs.hexInput.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this._closeColorPicker();
      }
    });
    refs.wheel.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      this._colorPicker.wheelPointerId = event.pointerId;
      try {
        refs.wheel.setPointerCapture?.(event.pointerId);
      } catch { /* synthetic or unsupported pointer capture */ }
      this._updateColorPickerHueFromPointerEvent(event);
    });
    refs.wheel.addEventListener('pointermove', event => {
      if (this._colorPicker.wheelPointerId !== event.pointerId) return;
      event.preventDefault();
      this._updateColorPickerHueFromPointerEvent(event);
    });
    const releaseWheel = event => {
      if (this._colorPicker.wheelPointerId !== event.pointerId) return;
      this._colorPicker.wheelPointerId = null;
      try {
        refs.wheel.releasePointerCapture?.(event.pointerId);
      } catch { /* synthetic or unsupported pointer capture */ }
    };
    refs.wheel.addEventListener('pointerup', releaseWheel);
    refs.wheel.addEventListener('pointercancel', releaseWheel);

    document.addEventListener('click', event => {
      if (!this._colorPicker.open) return;
      if (refs.panel.contains(event.target)) return;
      if (event.target?.closest?.('.topbar-color-trigger, .canvas-size-color-trigger, .sim-format-color')) return;
      this._closeColorPicker();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this._colorPicker.open) {
        this._closeColorPicker();
      }
    });
    window.addEventListener('resize', () => {
      if (this._colorPicker.open) this._positionColorPickerPanel();
    });
    this._syncCanvasSizeColorTrigger();
    this._syncColorPickerUi();
  }

  // ── Canvas texture ─────────────────────────────────────────

  /**
   * Build the default built-in paper texture.
   */
  _buildBuiltinPaperTextureCanvas() {
    const c = document.createElement('canvas');
        this.setColorValue('background', bgColor, { silent: true });
    c.height = 192;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(c.width, c.height);
    const d = img.data;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const base = 180;
        const coarse = _valueNoise2D(x, y, 38, 11);
        const medium = _valueNoise2D(x, y, 16, 29);
        const fine = _valueNoise2D(x, y, 6, 71);
        const fleck = _valueNoise2D(x, y, PAPER_TEXTURE_FLECK_SCALE, 97);
        const fiber = Math.sin((x + y * 0.18) * 0.11 + medium * 4.2) * 0.5 + 0.5;
        let grey = base
          + (coarse - 0.5) * 44
          + (medium - 0.5) * 26
          + (fine - 0.5) * 14
          + (fiber - 0.5) * 12;
        if (fleck > PAPER_TEXTURE_FLECK_THRESHOLD) {
          grey -= (fleck - PAPER_TEXTURE_FLECK_THRESHOLD) * PAPER_TEXTURE_FLECK_INTENSITY;
        }
        grey = Math.max(58, Math.min(235, Math.round(grey)));
        const off = (y * c.width + x) * 4;
        d[off] = grey;
        d[off + 1] = grey;
        d[off + 2] = grey;
        d[off + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Linen canvas texture — coarse woven grid with thread noise. */
  _buildBuiltinLinenTextureCanvas() {
    const sz = 256;
    const c = document.createElement('canvas');
    c.width = sz;
    c.height = sz;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(sz, sz);
    const d = img.data;
    const THREAD = 9; // pixels per thread period
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const warpPhase = (x % THREAD) / THREAD * Math.PI * 2;
        const weftPhase = (y % THREAD) / THREAD * Math.PI * 2;
        const warp = Math.sin(warpPhase + _valueNoise2D(x, y, 5, 13) * 1.5) * 0.5 + 0.5;
        const weft = Math.sin(weftPhase + _valueNoise2D(x, y, 5, 37) * 1.5) * 0.5 + 0.5;
        const weave = Math.max(warp, weft);
        const micro = _valueNoise2D(x, y, 2.5, 59) * 0.18;
        const coarse = _valueNoise2D(x, y, 28, 7) * 0.06;
        let grey = 168 + weave * 40 + micro * 20 + coarse * 20 - 25;
        grey = Math.max(60, Math.min(230, Math.round(grey)));
        const off = (y * sz + x) * 4;
        d[off] = d[off + 1] = d[off + 2] = grey;
        d[off + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Rough watercolor paper — pronounced tooth with soft pits. */
  _buildBuiltinWatercolorTextureCanvas() {
    const sz = 256;
    const c = document.createElement('canvas');
    c.width = sz;
    c.height = sz;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(sz, sz);
    const d = img.data;
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const macro = _valueNoise2D(x, y, 52, 3);
        const mid   = _valueNoise2D(x, y, 22, 17);
        const fine  = _valueNoise2D(x, y, 8,  41);
        const pit   = _valueNoise2D(x, y, 4.5, 83);
        const fibre = Math.abs(Math.sin((x * 0.07 + y * 0.04) + mid * 5.5)) * 0.5 + 0.5;
        let grey = 165
          + (macro - 0.5) * 55
          + (mid   - 0.5) * 32
          + (fine  - 0.5) * 18
          + (fibre - 0.5) * 10;
        if (pit < 0.22) grey -= (0.22 - pit) * 140;
        grey = Math.max(45, Math.min(228, Math.round(grey)));
        const off = (y * sz + x) * 4;
        d[off] = d[off + 1] = d[off + 2] = grey;
        d[off + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Charcoal / drawing paper — fine consistent tooth with light directional grain. */
  _buildBuiltinCharcoalTextureCanvas() {
    const sz = 192;
    const c = document.createElement('canvas');
    c.width = sz;
    c.height = sz;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(sz, sz);
    const d = img.data;
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const tooth  = _valueNoise2D(x, y, 4, 23);
        const medium = _valueNoise2D(x, y, 12, 47);
        const coarse = _valueNoise2D(x, y, 30, 5);
        // Horizontal directional grain for drawing paper feel
        const grain = Math.sin(y * 0.62 + _valueNoise2D(x, y, 8, 61) * 3.8) * 0.5 + 0.5;
        let grey = 175
          + (tooth  - 0.5) * 22
          + (medium - 0.5) * 18
          + (coarse - 0.5) * 14
          + (grain  - 0.5) *  8;
        grey = Math.max(80, Math.min(225, Math.round(grey)));
        const off = (y * sz + x) * 4;
        d[off] = d[off + 1] = d[off + 2] = grey;
        d[off + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Smooth Bristol board — subtle micro-texture, nearly flat. */
  _buildBuiltinBristolTextureCanvas() {
    const sz = 128;
    const c = document.createElement('canvas');
    c.width = sz;
    c.height = sz;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(sz, sz);
    const d = img.data;
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const micro  = _valueNoise2D(x, y, 2.2, 31);
        const smooth = _valueNoise2D(x, y, 18,  19);
        let grey = 195
          + (micro  - 0.5) * 12
          + (smooth - 0.5) *  6;
        grey = Math.max(150, Math.min(238, Math.round(grey)));
        const off = (y * sz + x) * 4;
        d[off] = d[off + 1] = d[off + 2] = grey;
        d[off + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  _createCanvasTextureRecord({ id, name, sourceType, canvas, dataUrl = null, persistDataUrl = false }) {
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    const grey = new Uint8ClampedArray(width * height);
    for (let i = 0; i < grey.length; i++) {
      const off = i * 4;
      grey[i] = Math.round(0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2]);
    }
    const flowX = new Float32Array(grey.length);
    const flowY = new Float32Array(grey.length);
    const slope = new Float32Array(grey.length);
    for (let y = 0; y < height; y++) {
      const yU = _wrapIndex(y - 1, height);
      const yD = _wrapIndex(y + 1, height);
      for (let x = 0; x < width; x++) {
        const xL = _wrapIndex(x - 1, width);
        const xR = _wrapIndex(x + 1, width);
        const i = y * width + x;
        const gx = (grey[y * width + xR] - grey[y * width + xL]) / 255;
        const gy = (grey[yD * width + x] - grey[yU * width + x]) / 255;
        const len = Math.hypot(gx, gy);
        slope[i] = Math.min(1, len * TEXTURE_SLOPE_AMPLIFICATION);
        if (len > 1e-5) {
          flowX[i] = -gx / len;
          flowY[i] = -gy / len;
        }
      }
    }
    return {
      id,
      name,
      sourceType,
      width,
      height,
      canvas,
      previewCanvas: canvas,
      previewDataUrl: canvas.toDataURL('image/png'),
      heightData: grey,
      flowX,
      flowY,
      slope,
      dataUrl: persistDataUrl ? (dataUrl || canvas.toDataURL('image/png')) : null,
    };
  }

  _setActiveCanvasTexture(texture, { silent = false } = {}) {
    this._canvasTexture = texture;
    this._activeCanvasTextureId = texture?.id || DEFAULT_CANVAS_TEXTURE_ID;
    const chk = document.getElementById('canvasTextureEnabled');
    if (chk && !chk.checked) chk.checked = true;
    this._paramsDirty = true;
    if (document.getElementById('sidebar')) syncUI(this);
    if (this.compositeCanvas) this.compositeAllLayers({ forceFull: true });
    if (!silent && texture) this.showToast(`🖼 Texture: ${texture.name}`);
  }

  async _ensureBuiltinCanvasTexture() {
    const BUILTINS = [
      { id: DEFAULT_CANVAS_TEXTURE_ID,    name: 'Paper Grain',      build: () => this._buildBuiltinPaperTextureCanvas() },
      { id: 'builtin-linen',              name: 'Linen Canvas',     build: () => this._buildBuiltinLinenTextureCanvas() },
      { id: 'builtin-watercolor',         name: 'Watercolor Paper', build: () => this._buildBuiltinWatercolorTextureCanvas() },
      { id: 'builtin-charcoal',           name: 'Charcoal Paper',   build: () => this._buildBuiltinCharcoalTextureCanvas() },
      { id: 'builtin-bristol',            name: 'Bristol Board',    build: () => this._buildBuiltinBristolTextureCanvas() },
    ];
    for (const { id, name, build } of BUILTINS) {
      if (!this._builtinCanvasTextures.has(id)) {
        const canvas = build();
        const texture = this._createCanvasTextureRecord({ id, name, sourceType: 'builtin', canvas });
        this._builtinCanvasTextures.set(id, texture);
      }
    }
    if (!this._canvasTexture) {
      this._setActiveCanvasTexture(this._builtinCanvasTextures.get(DEFAULT_CANVAS_TEXTURE_ID), { silent: true });
    }
  }

  async _canvasFromDataUrl(dataUrl) {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return c;
  }

  async _setCustomCanvasTextureFromDataUrl(dataUrl, name = 'Custom Upload', { activate = true, silent = false } = {}) {
    const canvas = await this._canvasFromDataUrl(dataUrl);
    const texture = this._createCanvasTextureRecord({
      id: 'custom-upload',
      name,
      sourceType: 'upload',
      canvas,
      dataUrl,
      persistDataUrl: true,
    });
    this._customCanvasTexture = texture;
    if (activate) this._setActiveCanvasTexture(texture, { silent });
    else if (document.getElementById('sidebar')) syncUI(this);
    return texture;
  }

  setCanvasTextureById(id, { silent = false } = {}) {
    const texture = id === 'custom-upload'
      ? this._customCanvasTexture
      : this._builtinCanvasTextures.get(id);
    if (!texture) return false;
    this._setActiveCanvasTexture(texture, { silent });
    return true;
  }

  /**
   * Load a user-supplied image as a greyscale canvas texture tile.
   * @param {File} file - Image file (PNG, JPEG, etc.)
   */
  async loadCanvasTexture(file) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = evt => resolve(evt.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await this._setCustomCanvasTextureFromDataUrl(dataUrl, file?.name || 'Custom Upload', { silent: true });
      this.showToast('🖼 Texture loaded & enabled');
      return true;
    } catch {
      this.showToast('⚠ Texture load failed — invalid image');
      return false;
    }
  }

  clearCanvasTexture() {
    this._customCanvasTexture = null;
    this._setActiveCanvasTexture(this._builtinCanvasTextures.get(DEFAULT_CANVAS_TEXTURE_ID), { silent: true });
    this.showToast('Texture reset to built-in paper grain');
  }

  async _setCustomStampImageFromDataUrl(dataUrl, name = 'Custom Stamp', { silent = false, id = 'custom-stamp', sourceType = 'upload', licenseLabel = '', sourceUrl = '' } = {}) {
    const canvas = await this._canvasFromDataUrl(dataUrl);
    this._customStampImage = {
      id,
      name,
      sourceType,
      licenseLabel,
      sourceUrl,
      canvas,
      dataUrl,
      width: canvas.width,
      height: canvas.height,
    };
    this.invalidateParams();
    if (document.getElementById('sidebar')) syncUI(this);
    if (!silent) this.showToast('🖼 Stamp image loaded');
    this._maybeAutoSaveSession();
    return this._customStampImage;
  }

  async loadCustomStampImage(file) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = evt => resolve(evt.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await this._setCustomStampImageFromDataUrl(dataUrl, file?.name || 'Custom Stamp');
      return true;
    } catch {
      this.showToast('⚠ Stamp image load failed — invalid image');
      return false;
    }
  }

  async loadBuiltinStampPreset(id, { enable = true, silent = false } = {}) {
    const preset = getBuiltinStampPreset(id);
    if (!preset) return false;
    await this._setCustomStampImageFromDataUrl(preset.dataUrl, preset.name, {
      silent: true,
      id: preset.id,
      sourceType: preset.sourceType,
      licenseLabel: preset.licenseLabel || '',
      sourceUrl: preset.sourceUrl || '',
    });
    if (enable) {
      const enableEl = document.getElementById('stampImageEnabled');
      if (enableEl) enableEl.checked = true;
    }
    if (document.getElementById('sidebar')) syncUI(this);
    if (!silent) this.showToast(`🖼 Stamp preset: ${preset.name}`);
    this._maybeAutoSaveSession();
    return true;
  }

  clearCustomStampImage({ silent = false } = {}) {
    this._customStampImage = null;
    this.invalidateParams();
    if (document.getElementById('sidebar')) syncUI(this);
    if (!silent) this.showToast('Stamp image cleared');
    this._maybeAutoSaveSession();
  }

  getCustomStampImageMeta() {
    if (!this._customStampImage) return null;
    return {
      id: this._customStampImage.id,
      name: this._customStampImage.name,
      sourceType: this._customStampImage.sourceType,
      licenseLabel: this._customStampImage.licenseLabel || '',
      sourceUrl: this._customStampImage.sourceUrl || '',
      width: this._customStampImage.width,
      height: this._customStampImage.height,
      canvas: this._customStampImage.canvas,
    };
  }

  getAvailableStampImagePresets() {
    return BUILTIN_STAMP_IMAGE_PRESETS.map(preset => ({
      id: preset.id,
      name: preset.name,
      sourceType: preset.sourceType,
      licenseLabel: preset.licenseLabel || '',
      previewDataUrl: preset.dataUrl,
    }));
  }

  _serializeCustomStampImageState() {
    return this._customStampImage
      ? {
          id: this._customStampImage.id,
          name: this._customStampImage.name,
          sourceType: this._customStampImage.sourceType,
          dataUrl: this._customStampImage.dataUrl,
        }
      : null;
  }

  async _restoreCustomStampImageState(state) {
    if (!state) {
      this._customStampImage = null;
      return;
    }
    try {
      if (state.sourceType === 'builtin' && state.id) {
        const restored = await this.loadBuiltinStampPreset(state.id, { enable: false, silent: true });
        if (restored) return;
      }
      if (!state?.dataUrl) {
        this._customStampImage = null;
        return;
      }
      await this._setCustomStampImageFromDataUrl(state.dataUrl, state.name || 'Custom Stamp', {
        silent: true,
        id: state.id || 'custom-stamp',
        sourceType: state.sourceType || 'upload',
      });
    } catch {
      this._customStampImage = null;
      this.showToast('⚠ Saved custom stamp could not be restored');
    }
  }

  async _loadDefaultStampImage({ enable = true } = {}) {
    await this.loadBuiltinStampPreset(DEFAULT_STAMP_PRESET_ID, { enable, silent: true });
  }

  hasActiveStampImage(p = this._cachedP || this.getP()) {
    return !!p?.stampImageCanvas;
  }

  /**
   * Sample the active texture at a canvas position.
   */
  _sampleTextureFieldInternal(x, y, p = this._cachedP || this.getP(), { ignoreToggle = false } = {}) {
    const tex = this._canvasTexture;
    if (!tex?.heightData || (!ignoreToggle && !p?.canvasTextureEnabled)) {
      return { height: 0, valley: 1, flowX: 0, flowY: 0, slope: 0 };
    }
    const scale = Math.max(0.05, p.canvasTextureScale || 1);
    const theta = (p.canvasTextureRotation || 0) * Math.PI / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const tx = (x + (p.canvasTextureOffsetX || 0)) / scale;
    const ty = (y + (p.canvasTextureOffsetY || 0)) / scale;
    const u = cos * tx - sin * ty;
    const v = sin * tx + cos * ty;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const w = tex.width;
    const h = tex.height;
    const idx00 = _wrapIndex(y0, h) * w + _wrapIndex(x0, w);
    const idx10 = _wrapIndex(y0, h) * w + _wrapIndex(x1, w);
    const idx01 = _wrapIndex(y1, h) * w + _wrapIndex(x0, w);
    const idx11 = _wrapIndex(y1, h) * w + _wrapIndex(x1, w);
    const wx0 = 1 - fx;
    const wy0 = 1 - fy;
    const w00 = wx0 * wy0;
    const w10 = fx * wy0;
    const w01 = wx0 * fy;
    const w11 = fx * fy;
    let height = (
      tex.heightData[idx00] * w00 +
      tex.heightData[idx10] * w10 +
      tex.heightData[idx01] * w01 +
      tex.heightData[idx11] * w11
    ) / 255;
    if (p.canvasTextureInvert) height = 1 - height;
    let flowX = tex.flowX[idx00] * w00 + tex.flowX[idx10] * w10 + tex.flowX[idx01] * w01 + tex.flowX[idx11] * w11;
    let flowY = tex.flowY[idx00] * w00 + tex.flowY[idx10] * w10 + tex.flowY[idx01] * w01 + tex.flowY[idx11] * w11;
    const slope = tex.slope[idx00] * w00 + tex.slope[idx10] * w10 + tex.slope[idx01] * w01 + tex.slope[idx11] * w11;
    if (p.canvasTextureInvert) {
      flowX *= -1;
      flowY *= -1;
    }
    return {
      height,
      valley: 1 - height,
      flowX,
      flowY,
      slope,
    };
  }

  sampleTextureField(x, y, p = this._cachedP || this.getP()) {
    return this._sampleTextureFieldInternal(x, y, p);
  }

  sampleTextureHeight(x, y, p = this._cachedP || this.getP()) {
    return this.sampleTextureField(x, y, p).height;
  }

  sampleTextureFlowVector(x, y, p = this._cachedP || this.getP()) {
    const field = this.sampleTextureField(x, y, p);
    const len = Math.hypot(field.flowX, field.flowY);
    if (len < 1e-5) return { x: 0, y: 0, slope: field.slope };
    return { x: field.flowX / len, y: field.flowY / len, slope: field.slope };
  }

  hasCanvasTexture() {
    return !!this._canvasTexture?.heightData;
  }

  getTextureInfluence(p, channel = 'deposit') {
    if (!this.hasCanvasTexture() || !p?.canvasTextureEnabled) return 0;
    const key = `canvasTexture${_capitalizeTextureChannel(channel)}`;
    const channelValue = typeof p[key] === 'number' ? p[key] : (TEXTURE_CHANNEL_DEFAULTS[channel] ?? 0);
    return _clamp01((p.canvasTextureStrength || 0) * channelValue);
  }

  getTextureDepositDensity(x, y, p = this._cachedP || this.getP()) {
    const influence = this.getTextureInfluence(p, 'deposit');
    if (influence <= 0) return 1;
    return Math.max(0.05, 1 - influence * this.sampleTextureHeight(x, y, p));
  }

  getTexturePoolingDensity(x, y, p = this._cachedP || this.getP()) {
    const influence = this.getTextureInfluence(p, 'pooling');
    if (influence <= 0) return 1;
    return Math.max(0.15, 1 - influence * this.sampleTextureHeight(x, y, p));
  }

  getTextureSmudgeOffset(x, y, size, p = this._cachedP || this.getP()) {
    const influence = this.getTextureInfluence(p, 'smudgeDrag');
    if (influence <= 0) return { x, y };
    const flow = this.sampleTextureFlowVector(x, y, p);
    const dist = Math.max(TEXTURE_SMUDGE_MIN_DISTANCE, size * TEXTURE_SMUDGE_SIZE_FACTOR)
      * influence
      * (TEXTURE_SMUDGE_BASE_INFLUENCE + flow.slope * TEXTURE_SMUDGE_SLOPE_INFLUENCE);
    return { x: x + flow.x * dist, y: y + flow.y * dist };
  }

  getTextureEdgeBreakup(x, y, p = this._cachedP || this.getP()) {
    const influence = this.getTextureInfluence(p, 'edgeBreakup');
    if (influence <= 0) return 0;
    const field = this.sampleTextureField(x, y, p);
    return _clamp01(influence * (0.3 + field.slope * 1.15 + field.height * 0.35));
  }

  getAvailableCanvasTextures() {
    const items = [...this._builtinCanvasTextures.values()].map(tex => ({
      id: tex.id,
      name: tex.name,
      sourceType: tex.sourceType,
    }));
    if (this._customCanvasTexture) {
      items.push({
        id: this._customCanvasTexture.id,
        name: this._customCanvasTexture.name,
        sourceType: this._customCanvasTexture.sourceType,
      });
    }
    return items;
  }

  getActiveCanvasTextureMeta() {
    if (!this._canvasTexture) return null;
    return {
      id: this._canvasTexture.id,
      name: this._canvasTexture.name,
      sourceType: this._canvasTexture.sourceType,
      width: this._canvasTexture.width,
      height: this._canvasTexture.height,
      previewCanvas: this._canvasTexture.previewCanvas,
      previewDataUrl: this._canvasTexture.previewDataUrl,
    };
  }

  _serializeCanvasTextureState() {
    return {
      activeId: this._activeCanvasTextureId || DEFAULT_CANVAS_TEXTURE_ID,
      custom: this._customCanvasTexture
        ? {
            name: this._customCanvasTexture.name,
            dataUrl: this._customCanvasTexture.dataUrl,
          }
        : null,
    };
  }

  async _restoreCanvasTextureState(state) {
    await this._ensureBuiltinCanvasTexture();
    if (state?.custom?.dataUrl) {
      try {
        await this._setCustomCanvasTextureFromDataUrl(state.custom.dataUrl, state.custom.name || 'Custom Upload', { activate: false });
      } catch {
        this._customCanvasTexture = null;
        this.showToast('⚠ Saved custom texture could not be restored');
      }
    }
    if (!this.setCanvasTextureById(state?.activeId || DEFAULT_CANVAS_TEXTURE_ID, { silent: true })) {
      this._setActiveCanvasTexture(this._builtinCanvasTextures.get(DEFAULT_CANVAS_TEXTURE_ID), { silent: true });
    }
  }

  setActiveLayer(idx) {
    if (idx >= 0 && idx < this.layers.length && !this.layers[idx].isBackground) {
      this.activeLayerIdx = idx;
      this._syncLayerSwitcher();
      this._syncAlphaLockUI();
      this._renderViewBookmarksPanel?.();
    }
  }

  removeLayer() {
    const paintLayers = this.layers.filter(l => !l.isBackground);
    if (paintLayers.length <= 1) { this.showToast('Need at least 1 layer'); return; }
    const target = this.layers[this.activeLayerIdx];
    if (target.isBackground) { this.showToast('Cannot delete background'); return; }
    this.pushUndo();
    const rem = this.layers[this.activeLayerIdx];
    this.compositor?.deleteLayerTex(rem);
    this.layers.splice(this.activeLayerIdx, 1);
    if (this.activeLayerIdx >= this.layers.length) this.activeLayerIdx = this.layers.length - 1;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
    this.recordLastChangeMarker('Layer deleted');
  }

  duplicateLayer() {
    this.pushUndo();
    const src = this.getActiveLayer();
    const { canvas, ctx } = this.makeLayerCanvas();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(src.canvas, 0, 0);
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.layers.splice(this.activeLayerIdx, 0, this._createLayerRecord(canvas, ctx, {
      name: src.name + ' copy',
      opacity: src.opacity,
      blend: src.blend,
    }));
    this._syncLayerSwitcher();
    this.compositeAllLayers();
    this.recordLastChangeMarker('Layer duplicated');
  }

  moveLayerUp() {
    if (this.activeLayerIdx <= 0) {
      this.showToast('Already at top');
      return;
    }
    this.pushUndo();
    [this.layers[this.activeLayerIdx - 1], this.layers[this.activeLayerIdx]] =
      [this.layers[this.activeLayerIdx], this.layers[this.activeLayerIdx - 1]];
    this.activeLayerIdx--;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
    this.recordLastChangeMarker('Layer reordered');
  }

  moveLayerDown() {
    if (this.activeLayerIdx >= this.layers.length - 1) {
      this.showToast('Already at bottom');
      return;
    }
    if (this.layers[this.activeLayerIdx + 1]?.isBackground) {
      this.showToast('Already at bottom');
      return;
    }
    this.pushUndo();
    [this.layers[this.activeLayerIdx + 1], this.layers[this.activeLayerIdx]] =
      [this.layers[this.activeLayerIdx], this.layers[this.activeLayerIdx + 1]];
    this.activeLayerIdx++;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
    this.recordLastChangeMarker('Layer reordered');
  }

  mergeDown() {
    if (this.activeLayerIdx >= this.layers.length - 1) { this.showToast('No layer below'); return; }
    const lower = this.layers[this.activeLayerIdx + 1];
    if (lower.isBackground) { this.showToast('Cannot merge into background'); return; }
    this.pushUndo();
    const upper = this.layers[this.activeLayerIdx];
    lower.ctx.save();
    lower.ctx.setTransform(1, 0, 0, 1, 0, 0);
    lower.ctx.globalAlpha = upper.opacity;
    lower.ctx.globalCompositeOperation = getCanvasBlendMode(upper.blend);
    lower.ctx.drawImage(upper.canvas, 0, 0);
    lower.ctx.restore();
    lower.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.compositor?.deleteLayerTex(upper);
    lower.dirty = true;
    this.layers.splice(this.activeLayerIdx, 1);
    this._syncLayerSwitcher();
    this.compositeAllLayers();
    this.recordLastChangeMarker('Layers merged');
  }

  flattenAll() {
    const paintLayers = this.layers.filter(l => !l.isBackground);
    if (paintLayers.length <= 1) return;
    this.pushUndo();
    const bgLayer = this.layers.find(l => l.isBackground);
    const { canvas, ctx } = this.makeLayerCanvas();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = paintLayers.length - 1; i >= 0; i--) {
      const l = paintLayers[i];
      if (!l.visible) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = getCanvasBlendMode(l.blend);
      ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.restore(); ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    for (const l of paintLayers) this.compositor?.deleteLayerTex(l);
    this.layers = [this._createLayerRecord(canvas, ctx, { name: 'Flattened' })];
    if (bgLayer) this.layers.push(bgLayer);
    this.activeLayerIdx = 0;
    this._syncLayerSwitcher();
    this.compositeAllLayers();
    this.recordLastChangeMarker('Layers flattened');
  }

  clearActiveLayer() {
    const l = this.getActiveLayer();
    if (l.isBackground) { this.showToast('Use BG color picker to change background'); return; }
    const brush = this.getCurrentBrush();
    const preserveSimulationStroke = !!(
      brush &&
      this.simulation.enabled &&
      this._isMotionBrush() &&
      (this.simulation.running || this.simulation.paused)
    );
    if (!preserveSimulationStroke && brush?.deactivate) brush.deactivate();
    this.pushUndo();
    l.ctx.save();
    l.ctx.setTransform(1, 0, 0, 1, 0, 0);
    l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
    l.ctx.restore();
    l.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    if (preserveSimulationStroke) brush?.onActiveLayerCleared?.(l);
    this._markLayerDirty(l);
    // Also clear height map when there's only one paint layer
    if (this.layers.filter(layer => !layer.isBackground).length === 1) {
      this._heightCtx?.clearRect(0, 0, this._heightCanvas.width, this._heightCanvas.height);
      this._heightDirty = true;
    }
    this.compositeAllLayers();
    this.recordLastChangeMarker('Layer cleared');
    this.showToast('🗑 Layer cleared');
  }

  compositeAllLayers(options = {}) {
    this._smudgeImageData = null; // invalidate smudge cache
    const p = this._cachedP || this.getP();
    const forceFullComposite = !!(options.forceFull || (p.impasto && p.impastoStrength > 0));
    this.compositor?.composite(this.layers, this.W, this.H, { forceFull: forceFullComposite });

    // Impasto: recompute lighting overlay from height map when dirty, then draw
    if (p.impasto && p.impastoStrength > 0) {
      if (this._heightDirty) {
        this._impastoOverlayCanvas = this._computeImpastoOverlay(p);
        this._heightDirty = false;
      }
      if (this._impastoOverlayCanvas && this.compositeCanvas) {
        const dctx = this.compositeCanvas.getContext('2d');
        if (dctx) {
          dctx.save();
          dctx.setTransform(1, 0, 0, 1, 0, 0);
          dctx.globalCompositeOperation = 'overlay';
          dctx.globalAlpha = p.impastoStrength * 0.6;
          dctx.drawImage(this._impastoOverlayCanvas, 0, 0);
          dctx.globalAlpha = 1;
          dctx.globalCompositeOperation = 'source-over';
          dctx.restore();
        }
      }
    }
  }

  _renderCanvasTexturePreview(p = this._cachedP || this.getP()) {
    if (!this.liveCanvas || !this.lctx || !this.hasCanvasTexture()) return false;
    const ctx = this.lctx;
    if (!ctx) return false;
    const width = this.W;
    const height = this.H;
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    const strength = _clamp01(typeof p?.canvasTextureStrength === 'number' ? p.canvasTextureStrength : 1);
    const contrast = 0.2 + strength * 1.8;
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const field = this._sampleTextureFieldInternal(px, py, p, { ignoreToggle: true });
        const display = _clamp01(0.5 + (field.height - 0.5) * contrast);
        const slopeBoost = field.slope * 24 * strength;
        const shade = Math.max(0, Math.min(255, Math.round(display * 255 + slopeBoost)));
        const off = (py * width + px) * 4;
        data[off] = shade;
        data[off + 1] = shade;
        data[off + 2] = shade;
        data[off + 3] = 255;
      }
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.putImageData(imageData, 0, 0);
    ctx.restore();
    return true;
  }

  queueFluidInteractionInputs({ emitters = [], influences = [], scalarFields = [] } = {}) {
    this._fluidInteractionState.emitters.push(...emitters.map(record => ({ ...record })));
    this._fluidInteractionState.influences.push(...influences.map(record => ({ ...record })));
    this._fluidInteractionState.scalarFields.push(...scalarFields.map(record => ({ ...record })));
  }

  consumeFluidInteractionInputs() {
    const snapshot = {
      emitters: this._fluidInteractionState.emitters.splice(0),
      influences: this._fluidInteractionState.influences.splice(0),
      scalarFields: this._fluidInteractionState.scalarFields.splice(0),
    };
    return snapshot;
  }

  _syncLayerSwitcher() {
    const sel = document.getElementById('layerSwitcher');
    if (!sel) return;
    sel.innerHTML = '';
    this.layers.forEach((l, i) => {
      if (l.isBackground) return; // skip background in switcher
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = l.name;
      if (i === this.activeLayerIdx) opt.selected = true;
      sel.appendChild(opt);
    });
    // Also refresh sidebar layer list if it exists
    if (this._renderLayerList) this._renderLayerList();
  }

  // ========================================================
  // UNDO / REDO
  // ========================================================

  _captureSimulationUndoState() {
    return {
      brushData: _deepClone(this.simulation.brushData),
      selected: this.simulation.selected ? { ...this.simulation.selected } : null,
      nextId: this.simulation.nextId,
    };
  }

  _captureState() {
    return {
      layers: this.layers.map(l => ({
        data: (l.canvas.width > 0 && l.canvas.height > 0)
          ? l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height)
          : null,
        id: l.id,
        name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend,
        isBackground: !!l.isBackground
      })),
      simulation: this._captureSimulationUndoState(),
    };
  }

  _restoreSimulationUndoState(state) {
    if (!state) return;
    this.simulation.brushData = _deepClone(state.brushData || this.simulation.brushData);
    this.simulation.selected = state.selected ? { ...state.selected } : null;
    if (Number.isFinite(state.nextId)) this.simulation.nextId = state.nextId;
    this._normalizeSimulationData();
    this._constrainSimulationDataToBounds('boid');
    this._constrainSimulationDataToBounds('ant');
    this._renderSimulationInspector();
  }

  _restoreState(state) {
    const layerState = Array.isArray(state) ? state : (state?.layers || []);
    for (const l of this.layers) this.compositor?.deleteLayerTex(l);
    this.layers = layerState.map(s => {
      const { canvas, ctx } = this.makeLayerCanvas();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (s.data) ctx.putImageData(s.data, 0, 0);
      ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
      return this._createLayerRecord(canvas, ctx, {
        id: s.id,
        name: s.name,
        visible: s.visible,
        opacity: s.opacity,
        blend: s.blend,
        isBackground: !!s.isBackground,
      });
    });
    if (this.activeLayerIdx >= this.layers.length) this.activeLayerIdx = this.layers.length - 1;
    // Ensure active layer is not the background
    if (this.layers[this.activeLayerIdx]?.isBackground) {
      this.activeLayerIdx = Math.max(0, this.activeLayerIdx - 1);
    }
    this._syncLayerSwitcher();
    this.compositeAllLayers();
    if (!Array.isArray(state) && state?.simulation) {
      this._restoreSimulationUndoState(state.simulation);
    }
  }

  pushUndo(capturedState = null) {
    this.undoStack.push({ s: capturedState || this._captureState(), i: this.activeLayerIdx });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this._updateSimUndoRedoBtns();
  }

  doUndo() {
    if (!this.undoStack.length) return;
    this.redoStack.push({ s: this._captureState(), i: this.activeLayerIdx });
    const u = this.undoStack.pop();
    this.activeLayerIdx = u.i;
    this._restoreState(u.s);
    this.showToast('↩ Undo');
    this._updateSimUndoRedoBtns();
  }

  doRedo() {
    if (!this.redoStack.length) return;
    this.undoStack.push({ s: this._captureState(), i: this.activeLayerIdx });
    const r = this.redoStack.pop();
    this.activeLayerIdx = r.i;
    this._restoreState(r.s);
    this.showToast('↪ Redo');
    this._updateSimUndoRedoBtns();
  }

  // Sync the enabled/disabled state of the simulation playback bar undo/redo
  // buttons to match the current undo and redo stack lengths.
  _updateSimUndoRedoBtns() {
    const undoBtn = document.getElementById('simUndoBtn');
    const redoBtn = document.getElementById('simRedoBtn');
    if (undoBtn) undoBtn.disabled = this.undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = this.redoStack.length === 0;
  }

  // ========================================================
  // SIMULATION GUIDE UNDO/REDO
  // ========================================================

  pushUndoForSimulationGuideChange() {
    this.pushUndo();
  }

  doUndoSimulationGuide() {
    this.doUndo();
  }

  doRedoSimulationGuide() {
    this.doRedo();
  }

  _restoreSimulationState(simState) {
    this._restoreSimulationUndoState(simState);
  }

  // ========================================================
  // PARAMETER CACHE
  // ========================================================

  invalidateParams() { this._paramsDirty = true; }

  getP() {
    if (!this._paramsDirty && this._cachedP) {
      return this._simulationContextOverride
        ? this._getRuntimeScopedParams(this._cachedP)
        : this._cachedP;
    }
    this._paramsDirty = false;

    const el = id => document.getElementById(id);
    const has = id => !!el(id);
    const val = id => { const e = el(id); return e ? +e.value : 0; };
    const numOr = (id, fallback) => {
      const e = el(id);
      return e ? +e.value : fallback;
    };
    const chk = id => { const e = el(id); return e ? e.checked : false; };
    const sel = id => { const e = el(id); return e ? e.value : ''; };
    const _MULT_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
    const mult = id => {
      const e = el(id + '_multIdx');
      const idx = e ? Math.round(+e.value) : 5;
      return _MULT_STEPS[Math.max(0, Math.min(_MULT_STEPS.length - 1, idx))];
    };

    const scale = val('brushScale') / 100;
    const stampImageAllowed = !STAMP_IMAGE_DISABLED_BRUSHES.has(this.activeBrush);

    this._cachedP = {
      // Brush scale
      brushScale: scale,
      // Spawn
      spawnShape: sel('spawnShape') || 'circle',
      spawnRadius: Math.round(val('spawnRadius') * scale),
      spawnAngle: (val('spawnAngle') || 0) * Math.PI / 180,
      spawnJitter: val('spawnJitter') / 100,
      pressureSpawnRadius: chk('pressureSpawnRadius'),
      boidHoverAction: sel('boidHoverAction') || 'spawn',
      boidTouchAction: sel('boidTouchAction') || 'spawn',
      boidUntouchAction: sel('boidUntouchAction') || 'persist',
      boidUnhoverAction: sel('boidUnhoverAction') || 'persist',
      // Swarm
      count: Math.max(1, Math.min(MAX_SWARM_COUNT, val('count') || 60)),
      // Forces
      seek: val('seek') / 100,
      cohesion: val('cohesion') / 100,
      separation: val('separation') / 100,
      alignment: val('alignment') / 100,
      jitter: val('jitter') / 100,
      wander: val('wander') / 100,
      wanderSpeed: val('wanderSpeed') / 100,
      fov: val('fov') || 360,
      flowField: val('flowField') / 100,
      flowScale: val('flowScale') / 1000,
      fleeRadius: val('fleeRadius'),
      individuality: val('individuality') / 100,
      quorumThreshold: Math.max(0, Math.round(val('quorumThreshold') || 0)),
      quorumCompositeStrength: val('quorumCompositeStrength') / 100,
      // Variance
      sizeVar: val('sizeVar') / 100,
      opacityVar: val('opacityVar') / 100,
      speedVar: val('speedVar') / 100,
      forceVar: val('forceVar') / 100,
      hueVar: val('hueVar') / 100,
      satVar: val('satVar') / 100,
      litVar: val('litVar') / 100,
      // Motion
      maxSpeed: val('maxSpeed') / 2,
      damping: val('damping') / 100,
      motionPathAgentCount: Math.max(1, Math.min(MAX_SWARM_COUNT, Math.round(val('motionPathAgentCount') || 12))),
      motionPathRenderMode: sel('motionPathRenderMode') || 'ribbon',
      motionPathScale: (val('motionPathScale') || 100) / 100,
      motionPathSpeed: numOr('motionPathSpeed', 100) / 100,
      motionPathAcceleration: (val('motionPathAcceleration') || 50) / 100,
      motionPathAvoidance: (val('motionPathAvoidance') || 25) / 100,
      motionPathAttraction: (val('motionPathAttraction') || 0) / 100,
      motionPathSpacing: (val('motionPathSpacing') || 35) / 100,
      motionPathAngleSmoothing: (val('motionPathAngleSmoothing') || 90) / 100,
      motionPathMovementSmoothing: (val('motionPathMovementSmoothing') || 65) / 100,
      motionPathPathSmoothing: (val('motionPathPathSmoothing') || 35) / 100,
      // Stamp
      stampSize: Math.max(1, Math.round(val('stampSize') * scale)),
      stampOpacity: val('stampOpacity') / 100,
      stampSeparation: val('stampSeparation'),
      skipStamps: val('skipStamps'),
      pressureSize: chk('pressureSize'),
      pressureOpacity: chk('pressureOpacity'),
      stampImageEnabled: chk('stampImageEnabled') && !!this._customStampImage?.canvas && stampImageAllowed,
      stampImageCanvas: chk('stampImageEnabled') && stampImageAllowed ? this._customStampImage?.canvas || null : null,
      stampImageTint: chk('stampImageTint'),
      stampImageRotation: (val('stampImageRotation') || 0) * Math.PI / 180,
      smudge: val('smudge') / 100,
      smudgeOnly: chk('smudgeOnly'),
      flatStroke: chk('flatStroke'),
      stabilizer: val('stabilizer') / 100,
      strokeWaveType: sel('strokeWaveType') || 'none',
      strokeWaveAmplitude: Math.max(0, val('strokeWaveAmplitude') || 0),
      strokeWaveLength: Math.max(1, val('strokeWaveLength') || 80),
      strokeWavePhase: ((val('strokeWavePhase') || 0) * Math.PI) / 180,
      // Symmetry
      symmetryEnabled: chk('symmetryEnabled'),
      symmetryCount: val('symmetryCount') || 4,
      symmetryMode: sel('symmetryMode') || 'radial',
      symmetryGuideVisible: has('symmetryGuideVisible') ? chk('symmetryGuideVisible') : true,
      symmetryMirror: chk('symmetryMirror'),
      symmetryPathMirror: chk('symmetryPathMirror'),
      symmetryPathUseCurve: chk('symmetryPathUseCurve'),
      symmetrySizeMultipliers: _parseSymmetrySizeMultipliers(has('symmetrySizeMultipliers') ? document.getElementById('symmetrySizeMultipliers')?.value : '1'),
      symmetryCenterX: (val('symmetryCenterX') || 50) / 100,
      symmetryCenterY: (val('symmetryCenterY') || 50) / 100,
      // Taper
      taperLength: val('taperLength'),
      taperCurve: val('taperCurve') / 100,
      taperSize: chk('taperSize'),
      taperOpacity: chk('taperOpacity'),
      // Sensing
      sensingEnabled: chk('sensingEnabled'),
      sensingMode: sel('sensingMode') || 'avoid',
      sensingChannel: sel('sensingChannel') || 'darkness',
      sensingStrength: val('sensingStrength') / 100,
      sensingRadius: val('sensingRadius'),
      sensingFitRadius: val('sensingFitRadius'),
      sensingThreshold: val('sensingThreshold') / 100,
      sensingUpdateFrames: Math.max(1, Math.min(50, Math.round(val('sensingUpdateFrames') || 30))),
      sensingSource: sel('sensingSource') || 'below',
      // Visual
      showBoids: chk('showBoids'),
      showSpawn: chk('showSpawn'),
      // Bristle brush
      bristleCount: val('bristleCount') || 30,
      bristleWidth: Math.max(1, Math.round((val('bristleWidth') || 30) * scale)),
      bristleLength: Math.max(1, Math.round((val('bristleLength') || 20) * scale)),
      bristleStiffness: (val('bristleStiffness') || 50) / 100,
      bristleDamping: (val('bristleDamping') || 85) / 100,
      bristleFriction: (val('bristleFriction') || 40) / 100 * 20,
      bristleSpread: (val('bristleSpread') || 10) / 100 * 10,
      bristleSplay: (val('bristleSplay') || 30) / 100,
      bristleAngleOffset: (val('bristleAngleOffset') || 0) * Math.PI / 180,
      bristleFanEnable: chk('bristleFanEnable'),
      bristleFan: (chk('bristleFanEnable') ? val('bristleFan') : 0) || 0,
      bristleFanAngle: (val('bristleFanAngle') || 90) * Math.PI / 180,
      bristleSmoothing: (val('bristleSmoothing') || 50) / 100,
      strokeAngleMode: sel('strokeAngleMode') || 'auto',
      pencilAngle: (sel('strokeAngleMode') || 'auto') !== 'path',
      pencilBlend: (val('pencilBlend') || 0) / 100,
      showBristles: chk('showBristles'),
      // LBM fluid brush
      lbmBrushRadius: Math.max(2, Math.round(numOr('lbmBrushRadius', 36) * scale)),
      lbmSpawnCount: numOr('lbmSpawnCount', 30),
      lbmParticleRadius: numOr('lbmParticleRadius', 3),
      lbmViscosity: numOr('lbmViscosity', 28) / 100,
      lbmDensity: numOr('lbmDensity', 30) / 100,
      lbmSurfaceTension: numOr('lbmSurfaceTension', 34) / 100,
      lbmTimeStep: numOr('lbmTimeStep', 16) / 16,
      lbmSubsteps: numOr('lbmSubsteps', 4),
      lbmMotionDecay: numOr('lbmMotionDecay', 34) / 100,
      lbmStopSpeed: numOr('lbmStopSpeed', 14) / 100,
      lbmPigmentCarry: numOr('lbmPigmentCarry', 65) / 100,
      lbmPigmentRetention: numOr('lbmPigmentRetention', 78) / 100,
      lbmResolutionScale: numOr('lbmResolutionScale', 100) / 100,
      lbmFluidScale: numOr('lbmFluidScale', 115) / 100,
      lbmStrokePull: numOr('lbmStrokePull', 36) / 100 * mult('lbmStrokePull'),
      lbmStrokeRake: numOr('lbmStrokeRake', 55) / 100 * mult('lbmStrokeRake'),
      lbmStrokeJitter: numOr('lbmStrokeJitter', 65) / 100 * mult('lbmStrokeJitter'),
      lbmHueJitter: numOr('lbmHueJitter', 0),
      lbmLightnessJitter: numOr('lbmLightnessJitter', 0),
      lbmInjectForce: numOr('lbmInjectForce', 100) / 100 * mult('lbmInjectForce'),
      lbmVortexStrength: numOr('lbmVortexStrength', 0) / 100 * mult('lbmVortexStrength'),
      lbmBurstStrength: numOr('lbmBurstStrength', 0) / 100 * mult('lbmBurstStrength'),
      lbmChevronStrength: numOr('lbmChevronStrength', 0) / 100 * mult('lbmChevronStrength'),
      lbmUndulateStrength: numOr('lbmUndulateStrength', 0) / 100 * mult('lbmUndulateStrength'),
      lbmRenderMode: sel('lbmRenderMode') || 'hybrid',
      lbmFirstPassPreview: has('lbmFirstPassPreview') ? chk('lbmFirstPassPreview') : true,
      lbmShowFlow: chk('lbmShowFlow'),
      fluid3dBrushRadius: Math.max(4, Math.round(numOr('fluid3dBrushRadius', 42) * scale)),
      fluid3dEmitterCount: Math.max(1, Math.round(numOr('fluid3dEmitterCount', 8))),
      fluid3dEmissionRate: numOr('fluid3dEmissionRate', 72) / 100,
      fluid3dEmitterStrength: numOr('fluid3dEmitterStrength', 82) / 100,
      fluid3dEmitterVelocity: numOr('fluid3dEmitterVelocity', 74) / 100,
      fluid3dPressure: numOr('fluid3dPressure', 62) / 100,
      fluid3dMomentum: numOr('fluid3dMomentum', 88) / 100,
      fluid3dVelocityDiffuse: numOr('fluid3dVelocityDiffuse', 22) / 100,
      fluid3dDrag: numOr('fluid3dDrag', 18) / 100,
      fluid3dThicknessDecay: numOr('fluid3dThicknessDecay', 8) / 100,
      fluid3dPigmentDiffusion: numOr('fluid3dPigmentDiffusion', 28) / 100,
      fluid3dPressureFade: numOr('fluid3dPressureFade', 12) / 100,
      fluid3dSettleThreshold: numOr('fluid3dSettleThreshold', 4) / 100,
      fluid3dTerrainWeight: numOr('fluid3dTerrainWeight', 24) / 100,
      fluid3dScalarFieldInfluence: numOr('fluid3dScalarFieldInfluence', 45) / 100,
      fluid3dInfluenceStrength: numOr('fluid3dInfluenceStrength', 70) / 100,
      fluid3dInfluenceRadius: numOr('fluid3dInfluenceRadius', 120),
      fluid3dMaxVelocity: numOr('fluid3dMaxVelocity', 18) / 10,
      fluid3dThicknessFloor: numOr('fluid3dThicknessFloor', 4) / 1000,
      fluid3dOpacity: numOr('fluid3dOpacity', 68) / 100,
      fluid3dOpacityScale: numOr('fluid3dOpacityScale', 100) / 100,
      fluid3dResolutionScale: numOr('fluid3dResolutionScale', 90) / 100,
      fluid3dPreviewScale: numOr('fluid3dPreviewScale', 55) / 100,
      fluid3dFluidScale: numOr('fluid3dFluidScale', 115) / 100,
      fluid3dOccupancyBias: numOr('fluid3dOccupancyBias', 12) / 100,
      fluid3dSpreadClamp: numOr('fluid3dSpreadClamp', 82) / 100,
      fluid3dSurfaceTension: numOr('fluid3dSurfaceTension', 18) / 100,
      fluid3dEdgeWidth: numOr('fluid3dEdgeWidth', 42) / 100,
      fluid3dEdgeDrag: numOr('fluid3dEdgeDrag', 16) / 100,
      fluid3dInjectorMotion: numOr('fluid3dInjectorMotion', 70) / 100,
      fluid3dInjectorPigment: numOr('fluid3dInjectorPigment', 82) / 100,
      fluid3dInjectorOccupancy: numOr('fluid3dInjectorOccupancy', 74) / 100,
      fluid3dInjectorSwirl: numOr('fluid3dInjectorSwirl', 36) / 100,
      fluid3dAdaptiveQuality: has('fluid3dAdaptiveQuality') ? chk('fluid3dAdaptiveQuality') : true,
      fluid3dShowField: chk('fluid3dShowField'),
      fluid3dInjectorMode: sel('fluid3dInjectorMode') || 'motion',
      fluid3dRenderMode: sel('fluid3dRenderMode') || 'volume',
      // Bristle variance
      bSizeVar: val('bSizeVar') / 100,
      bOpacityVar: val('bOpacityVar') / 100,
      bStiffVar: val('bStiffVar') / 100,
      bLengthVar: val('bLengthVar') / 100,
      bFrictionVar: val('bFrictionVar') / 100,
      bHueVar: val('bHueVar') / 100,
      // Canvas texture
      canvasTextureEnabled: chk('canvasTextureEnabled'),
      canvasTextureShowOnCanvas: chk('canvasTextureShowOnCanvas'),
      canvasTextureStrength: val('canvasTextureStrength') / 100,
      canvasTextureScale: val('canvasTextureScale') / 100 || 1,
      canvasTextureOffsetX: (val('canvasTextureOffsetX') || 0) / 10,
      canvasTextureOffsetY: (val('canvasTextureOffsetY') || 0) / 10,
      canvasTextureRotation: val('canvasTextureRotation') || 0,
      canvasTextureInvert: chk('canvasTextureInvert'),
      canvasTextureDeposit: (val('canvasTextureDeposit') || 0) / 100,
      canvasTextureFlow: (val('canvasTextureFlow') || 0) / 100,
      canvasTextureEdgeBreakup: (val('canvasTextureEdgeBreakup') || 0) / 100,
      canvasTextureSmudgeDrag: (val('canvasTextureSmudgeDrag') || 0) / 100,
      canvasTexturePooling: (val('canvasTexturePooling') || 0) / 100,
      // Color
      color: this.primaryEl.value,
      // Trail blur
      trailBlur: val('trailBlur') || 0,
      trailFlow: val('trailFlow') / 100,
      // Kubelka-Munk pigment mixing
      kmMix: chk('kmMix'),
      kmStrength: val('kmStrength') / 100,
      // Heightmap impasto
      impasto: chk('impasto'),
      impastoStrength: val('impastoStrength') / 100,
      impastoLightAngle: val('impastoLightAngle') * Math.PI / 180,
      impastoLightElevation: val('impastoLightElevation') * Math.PI / 180,
      // Ant brush
      antFollow: val('antFollow') / 100,
      antPheromoneRate: val('antPheromoneRate') / 100,
      antPheromoneDecay: val('antPheromoneDecay') / 1000,
      antPheromoneSize: val('antPheromoneSize') || 6,
      antTrailVisible: chk('antTrailVisible'),
      antPheromoneToSensing: chk('antPheromoneToSensing'),
      // Neighbor/separation radii (ant math panel)
      neighborRadius: val('am_neighborRadius') || 80,
      separationRadius: val('am_separationRadius') || 25,
      // Simulation mode
      simSpeed: (val('simSpeed') || 100) / 100,
      simPointStrength: (val('simPointStrength') || 0) / 100,
      simPointRadius: val('simPointRadius') || 120,
      simBoundsMargin: Math.max(0, val('simBoundsMargin') || 0),
      simPathSpeed: val('simPathSpeed') || 120,
      simEdgeForce: (val('simEdgeForce') || 100) / 100,
      simEdgeRadius: val('simEdgeRadius') || 28,
      simPheroPaintRadius: val('simPheroPaintRadius') || 18,
      simPheroPaintStrength: (val('simPheroPaintStrength') || 55) / 100,
      simEphemeralMode: chk('simEphemeralMode'),
      simEphemeralFrames: Math.max(1, Math.round(val('simEphemeralFrames') || 45)),
      simEphemeralFade: (val('simEphemeralFade') || 100) / 100,
      simMotionPathMode: sel('simMotionPathMode') === 'forces' ? 'forces' : 'path',
      leaderConfig: _readLeaderOverrideConfig({ val, chk, sel }),
    };
    return this._simulationContextOverride
      ? this._getRuntimeScopedParams(this._cachedP)
      : this._cachedP;
  }

  // ========================================================
  // SIMULATION MODE
  // ========================================================

  _isMotionBrush(name = this.activeBrush) {
    return name === 'boid' || name === 'ant' || name === 'motionPath';
  }

  _usesPathGuides(brush = this.activeBrush) {
    return brush === 'boid' || brush === 'motionPath';
  }

  _getSimulationContextBrush() {
    return this._simulationContextOverride?.brush || this.activeBrush;
  }

  _getRuntimeScopedParams(baseParams) {
    if (!this._simulationContextOverride || !this.simulation?.enabled || !baseParams) return baseParams;
    const vars = this._getSimulationVars();
    const next = { ...baseParams };
    const paramSnapshot = _sanitizeSimulationSessionData(this._simulationContextOverride?.paramSnapshot);
    if (paramSnapshot && typeof paramSnapshot === 'object') {
      for (const [key, value] of Object.entries(paramSnapshot)) {
        next[key] = _deepClone(value);
      }
    }
    if (!vars) return next;
    if (Number.isFinite(vars.seek)) next.seek = vars.seek;
    if (Number.isFinite(vars.cohesion)) next.cohesion = vars.cohesion;
    if (Number.isFinite(vars.separation)) next.separation = vars.separation;
    if (Number.isFinite(vars.alignment)) next.alignment = vars.alignment;
    if (Number.isFinite(vars.maxSpeed)) next.maxSpeed = vars.maxSpeed;
    if (Number.isFinite(vars.damping)) next.damping = vars.damping;
    if (typeof vars.sensingEnabled === 'boolean') next.sensingEnabled = vars.sensingEnabled;
    if (typeof vars.sensingMode === 'string') next.sensingMode = vars.sensingMode;
    if (typeof vars.sensingChannel === 'string') next.sensingChannel = vars.sensingChannel;
    if (Number.isFinite(vars.sensingStrength)) next.sensingStrength = vars.sensingStrength;
    if (Number.isFinite(vars.sensingRadius)) next.sensingRadius = vars.sensingRadius;
    if (Number.isFinite(vars.sensingFitRadius)) next.sensingFitRadius = vars.sensingFitRadius;
    if (Number.isFinite(vars.sensingThreshold)) next.sensingThreshold = vars.sensingThreshold;
    if (typeof vars.sensingSource === 'string') next.sensingSource = vars.sensingSource;
    if (Number.isFinite(vars.sensingUpdateFrames)) next.sensingUpdateFrames = vars.sensingUpdateFrames;
    return next;
  }

  _getSimulationVars() {
    return this._simulationContextOverride?.vars || this.simulation.vars;
  }

  _getCurrentSensingSourceSelectionState() {
    return Array.isArray(this._simulationContextOverride?.sensingSourceSelection)
      ? this._simulationContextOverride.sensingSourceSelection
      : this._sensingSourceSelection;
  }

  _setCurrentSensingSourceSelectionState(selection) {
    const normalized = _normalizeSimulationSensingSourceSelection(selection);
    if (Array.isArray(this._simulationContextOverride?.sensingSourceSelection)) {
      this._simulationContextOverride.sensingSourceSelection = normalized;
      return normalized;
    }
    this._sensingSourceSelection = normalized;
    return normalized;
  }

  _withSimulationRuntimeContext(context, callback) {
    const previousContext = this._simulationContextOverride;
    const previousStrokeFrame = this.strokeFrame;
    const previousLeaderX = this.leaderX;
    const previousLeaderY = this.leaderY;
    this._simulationContextOverride = context || null;
    if (context && Number.isFinite(context.strokeFrame)) {
      this.strokeFrame = context.strokeFrame;
    }
    if (context) {
      if (Number.isFinite(context.leaderX)) this.leaderX = context.leaderX;
      if (Number.isFinite(context.leaderY)) this.leaderY = context.leaderY;
    }
    try {
      return callback();
    } finally {
      if (context) {
        context.strokeFrame = this.strokeFrame;
        context.leaderX = this.leaderX;
        context.leaderY = this.leaderY;
      }
      this.leaderX = previousLeaderX;
      this.leaderY = previousLeaderY;
      this.strokeFrame = previousStrokeFrame;
      this._simulationContextOverride = previousContext;
    }
  }

  _getSimulationBrushData(brush = this._getSimulationContextBrush()) {
    const brushData = this._simulationContextOverride?.brushData || this.simulation.brushData;
    return brushData[brush] || null;
  }

  _getSimulationCollection(collection, brush = this.activeBrush) {
    const data = this._getSimulationBrushData(brush);
    return data && Array.isArray(data[collection]) ? data[collection] : [];
  }

  _ensureSimulationSpawns(brush = this.activeBrush) {
    const data = this._getSimulationBrushData(brush);
    if (!data) return [];
    if (!Array.isArray(data.spawns)) data.spawns = [];
    if (!data.spawns.length) {
      data.spawns.push({
        id: this.simulation.nextId++,
        x: this.W * 0.5,
        y: this.H * 0.5,
        enabled: true,
      });
    }
    return data.spawns;
  }

  _getSimulationTargetLayers() {
    const drawableLayers = this.layers.filter(layer => !layer.isBackground);
    return drawableLayers.length ? drawableLayers : this.layers.slice();
  }

  _getDefaultSimulationSessionLayerId(sessionIndex = 0) {
    const layers = this._getSimulationTargetLayers();
    if (!layers.length) return this.getActiveLayer()?.id || null;
    const safeIndex = Math.max(0, Math.min(sessionIndex, layers.length - 1));
    return layers[safeIndex]?.id || layers[0]?.id || null;
  }

  _createSimulationSessionId() {
    const stamp = Date.now().toString(36);
    const suffix = Math.random().toString(36).slice(2, 9);
    return `sim-session-${stamp}-${suffix}`;
  }

  _ensureSimulationSessionIds(sessions = this.simulation.sessions) {
    const usedIds = new Set();
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || typeof session !== 'object') continue;
      let id = typeof session.id === 'string' ? session.id.trim() : '';
      if (!id || usedIds.has(id)) id = this._createSimulationSessionId();
      session.id = id;
      usedIds.add(id);
      session.vars = _normalizeSimulationVars(session.vars);
      session.sensingSourceSelection = _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection);
    }
    return sessions;
  }

  _normalizeSimulationLayerIds(layerIds, fallbackSessionIndex = 0) {
    const validLayers = new Set(this._getSimulationTargetLayers().map(layer => layer.id));
    const normalized = [];
    const addLayer = layerId => {
      const id = String(layerId || '');
      if (!id || !validLayers.has(id) || normalized.includes(id)) return;
      normalized.push(id);
    };
    for (const layerId of Array.isArray(layerIds) ? layerIds : []) addLayer(layerId);
    if (!normalized.length) addLayer(this._getDefaultSimulationSessionLayerId(fallbackSessionIndex));
    return normalized;
  }

  _normalizeSimulationSessionBindings() {
    const sessions = Array.isArray(this.simulation.sessions) ? this.simulation.sessions : [];
    this._ensureSimulationSessionIds(sessions);
    const bindings = Array.isArray(this.simulation.multiSessionBindings) ? this.simulation.multiSessionBindings : [];
    const normalized = [];
    const bySession = new Map();
    const sessionIndexById = new Map(sessions.map((session, index) => [session.id, index]));

    for (const binding of bindings) {
      const indexedSession = typeof binding?.sessionId === 'string' ? sessionIndexById.get(binding.sessionId) : undefined;
      const fallbackIndex = Math.round(binding?.sessionIndex);
      const sessionIndex = Number.isFinite(indexedSession) ? indexedSession : fallbackIndex;
      if (!Number.isFinite(sessionIndex) || sessionIndex < 0 || sessionIndex >= sessions.length) continue;
      if (bySession.has(sessionIndex)) continue;
      const layerIds = this._normalizeSimulationLayerIds(
        Array.isArray(binding?.layerIds) ? binding.layerIds : [binding?.layerId],
        sessionIndex,
      );
      const nextBinding = {
        sessionId: sessions[sessionIndex].id,
        sessionIndex,
        layerIds,
        enabled: binding?.enabled !== false,
      };
      bySession.set(sessionIndex, nextBinding);
      normalized.push(nextBinding);
    }

    for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
      if (bySession.has(sessionIndex)) continue;
      normalized.push({
        sessionId: sessions[sessionIndex].id,
        sessionIndex,
        layerIds: this._normalizeSimulationLayerIds([this._getDefaultSimulationSessionLayerId(sessionIndex)], sessionIndex),
        enabled: true,
      });
    }

    normalized.sort((left, right) => left.sessionIndex - right.sessionIndex);
    this.simulation.multiSessionBindings = normalized;

    const activeSessionIndex = Math.round(this.simulation.activeSessionIndex);
    this.simulation.activeSessionIndex = Number.isFinite(activeSessionIndex)
      && activeSessionIndex >= 0
      && activeSessionIndex < sessions.length
      ? activeSessionIndex
      : -1;

    return normalized;
  }

  _getSimulationSessionBinding(sessionIndex) {
    this._normalizeSimulationSessionBindings();
    return this.simulation.multiSessionBindings.find(binding => binding.sessionIndex === sessionIndex) || null;
  }

  _buildSimulationSessionRoutingSummary() {
    const bindings = this._normalizeSimulationSessionBindings();
    const enabledBindings = bindings.filter(binding => binding.enabled !== false && this.simulation.sessions[binding.sessionIndex]);
    if (!enabledBindings.length) return 'No saved sessions armed for Run';
    const uniqueLayers = new Set();
    let routeCount = 0;
    for (const binding of enabledBindings) {
      for (const layerId of binding.layerIds || []) {
        if (!this._getLayerById(layerId)) continue;
        uniqueLayers.add(layerId);
        routeCount += 1;
      }
    }
    if (!routeCount) return 'No saved sessions have valid target layers';
    return `${enabledBindings.length} session${enabledBindings.length === 1 ? '' : 's'} armed across ${routeCount} layer route${routeCount === 1 ? '' : 's'} (${uniqueLayers.size} unique layer${uniqueLayers.size === 1 ? '' : 's'})`;
  }

  _getSimulationSessionContextSummary() {
    const activeIndex = Number.isFinite(this.simulation.activeSessionIndex)
      ? Math.round(this.simulation.activeSessionIndex)
      : -1;
    const session = activeIndex >= 0 && activeIndex < this.simulation.sessions.length
      ? this.simulation.sessions[activeIndex]
      : null;
    const name = session?.name?.trim() || 'Unsaved Draft';
    const isSaved = !!session;
    const savedPlaybackStatus = this._getSimulationSavedPlaybackStatus(session);
    return {
      activeIndex,
      session,
      isSaved,
      name,
      typeLabel: isSaved ? 'Saved Session' : 'Unsaved Draft',
      sidebarTitle: `Simulation session: ${name}`,
      sidebarSummary: isSaved
        ? `The brush sidebar is editing ${name}. Save to keep sidebar values, simulation defaults, and guide edits together in this session.`
        : 'The brush sidebar is editing an unsaved draft. Save it to keep the current sidebar values, simulation defaults, and guide edits together.',
      editorSummary: isSaved
        ? `Editing saved session "${name}". Guide edits and simulation-mode defaults update this session until you load another one or start a new draft.`
        : 'Editing an unsaved draft session. Save it to reuse the current simulation defaults, guides, and sensing routes later.',
      playbackLabel: `Session ${name}`,
      playbackSummary: savedPlaybackStatus.summary,
      playbackBadge: savedPlaybackStatus.badge,
      playbackReady: savedPlaybackStatus.ready,
      setupLabel: isSaved ? `Editing saved session: ${name}` : 'Editing unsaved draft session.',
      modeSummary: 'The brush sidebar stays wired to the selected simulation draft or saved session.',
      routingSummary: this._buildSimulationSessionRoutingSummary(),
    };
  }

  _buildSimulationSavedPlaybackSignature(session = {}) {
    // Saved playback is only reusable when the authored session state still
    // matches the run that produced the cached frames, so hash the guide data,
    // runtime overrides, and sensing selection into a stable signature.
    const brushData = _sanitizeSimulationSessionData(session.brushData);
    const controlState = _sanitizeSimulationSessionData(session.controlState);
    const paramSnapshot = _sanitizeSimulationSessionData(session.paramSnapshot);
    return JSON.stringify({
      brushData: _isPlainObject(brushData) ? brushData : {},
      vars: _normalizeSimulationVars(session.vars),
      controlState: _isPlainObject(controlState) ? controlState : {},
      paramSnapshot: _isPlainObject(paramSnapshot) ? paramSnapshot : {},
      sensingSourceSelection: _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection),
    });
  }

  _getSimulationSavedPlaybackStatus(session = null) {
    const playback = _normalizeSimulationSavedPlayback(session ? session.savedPlayback : this.simulation.savedPlayback);
    if (!playback) {
      return {
        ready: false,
        badge: 'No saved playback',
        summary: 'No saved playback captured yet. Run a boid simulation to cache frames for stacked multi-session playback.',
        playback: null,
      };
    }
    const signature = this._buildSimulationSavedPlaybackSignature(session || {
      brushData: this.simulation.brushData,
      vars: this.simulation.vars,
      controlState: this._captureSimulationSessionControlState(),
      paramSnapshot: this._captureSimulationSessionParamSnapshot(),
      sensingSourceSelection: this._serializeSensingSourceSelection(),
    });
    const ready = !!playback.signature && playback.signature === signature;
    const frameCount = playback.frames?.length || 0;
    return ready
      ? {
          ready: true,
          badge: `Saved playback · ${frameCount} frames`,
          summary: `Saved playback is ready (${frameCount} frames). Multi-session playback will reuse it instead of recomputing this boid session live.`,
          playback,
        }
      : {
          ready: false,
          badge: 'Saved playback outdated',
          summary: 'Saved playback exists but no longer matches the current session settings. Re-run the session to refresh it.',
          playback,
        };
  }

  _getSimulationSavedPlaybackBadgeTone(status) {
    if (status?.ready) return 'active';
    return status?.playback ? 'warn' : 'muted';
  }

  _getSimulationPlaybackBarSummary(context) {
    if (this._shouldUseMultiSessionPlayback()) {
      const diagnostics = this._getMultiSessionRouteDiagnostics();
      if (diagnostics.blockReason) return diagnostics.blockReason;
      return `Run ready · ${context.routingSummary}`;
    }
    return context.playbackSummary;
  }

  _buildSimulationRunToastMessage(runtimes = [], routeCount = 0) {
    const total = runtimes.length;
    if (!total) return 'Simulation running';
    const savedCount = runtimes.filter(runtime => !!runtime?.savedPlayback).length;
    const liveCount = Math.max(0, total - savedCount);
    const parts = [`${total} session${total === 1 ? '' : 's'}`];
    if (routeCount > 0) parts.push(`${routeCount} route${routeCount === 1 ? '' : 's'}`);
    if (savedCount && liveCount) {
      parts.push(`${savedCount} saved`);
      parts.push(`${liveCount} live`);
    } else if (savedCount) {
      parts.push(`${savedCount} saved playback`);
    } else if (liveCount) {
      parts.push(`${liveCount} live`);
    }
    return `Simulation running (${parts.join(', ')})`;
  }

  _getSimulationSavedPlaybackForRuntime(session) {
    const status = this._getSimulationSavedPlaybackStatus(session);
    return status.ready ? status.playback : null;
  }

  _beginSimulationSavedPlaybackCapture() {
    this._simulationSavedPlaybackCapture = {
      signature: this._buildSimulationSavedPlaybackSignature({
        brushData: this.simulation.brushData,
        vars: this.simulation.vars,
        controlState: this._captureSimulationSessionControlState(),
        paramSnapshot: this._captureSimulationSessionParamSnapshot(),
        sensingSourceSelection: this._serializeSensingSourceSelection(),
      }),
      format: SIM_SAVED_PLAYBACK_FORMAT,
      version: SIM_SAVED_PLAYBACK_VERSION,
      frameRate: 60,
      captureInterval: SIM_SAVED_PLAYBACK_CAPTURE_INTERVAL,
      capturedAt: Date.now(),
      width: this.W,
      height: this.H,
      agentCount: 0,
      appearance: null,
      frames: [],
      truncated: false,
    };
  }

  _syncSimulationSavedPlaybackCapture(brush) {
    if (!brush?.captureSavedPlaybackFrame) return;
    if (!this._simulationSavedPlaybackCapture) this._beginSimulationSavedPlaybackCapture();
    const capture = this._simulationSavedPlaybackCapture;
    if (!capture || (this.simulation.frameCount % capture.captureInterval) !== 0) return;
    if (capture.frames.length >= SIM_SAVED_PLAYBACK_MAX_FRAMES) {
      capture.truncated = true;
      if (!this.simulation.savedPlayback && capture.appearance && capture.frames.length) {
        this.simulation.savedPlayback = _deepClone({
          ...capture,
          appearance: capture.appearance,
          frames: capture.frames,
        });
      }
      return;
    }
    const frame = brush.captureSavedPlaybackFrame();
    if (!frame || frame.count <= 0 || !frame.positions?.length) return;
    if (!capture.agentCount) {
      capture.agentCount = frame.count;
      capture.appearance = frame.appearance;
    }
    if (frame.count !== capture.agentCount || !capture.appearance) {
      capture.truncated = true;
      return;
    }
    capture.frames.push({ positions: frame.positions });
    this.simulation.savedPlayback = _normalizeSimulationSavedPlayback({
      ...capture,
      appearance: capture.appearance,
      frames: capture.frames,
    });
  }

  _getSavedPlaybackRuntimeStats() {
    let total = 0;
    let completed = 0;
    for (const runtime of this.simulation.runtimeSessions || []) {
      if (!runtime?.savedPlayback) continue;
      total++;
      if (runtime.playbackComplete) completed++;
    }
    return { total, completed };
  }

  _pauseSimulationAtSavedPlaybackEnd() {
    const savedStats = this._getSavedPlaybackRuntimeStats();
    this.simulation.running = false;
    this.simulation.paused = true;
    this.isDrawing = false;
    this._syncSimulationUI();
    this.showToast(savedStats.total > 0
      ? `Saved playback complete — paused at end (${savedStats.completed}/${savedStats.total} sessions)`
      : 'Saved playback complete — paused at end');
  }

  _syncSimulationSessionContextUi() {
    const context = this._getSimulationSessionContextSummary();
    const sidebarTitle = document.getElementById('simSidebarSessionName');
    if (sidebarTitle) sidebarTitle.textContent = context.sidebarTitle;
    const sidebarMeta = document.getElementById('simSidebarSessionMeta');
    if (sidebarMeta) sidebarMeta.textContent = context.sidebarSummary;
    const sidebarBadge = document.getElementById('simSidebarSessionBadge');
    if (sidebarBadge) {
      sidebarBadge.textContent = context.typeLabel;
      sidebarBadge.className = `sim-stage-badge ${context.isSaved ? 'active' : 'muted'}`;
    }
    const sidebarSave = document.getElementById('simSidebarSave');
    if (sidebarSave) sidebarSave.textContent = context.isSaved ? 'Update Saved Session' : 'Save Draft Session';
    const handle = document.getElementById('simOverlayHandle');
    if (handle) handle.title = `${context.setupLabel} ${context.modeSummary}`;
    const simSetupActiveSession = document.getElementById('simSetupActiveSession');
    if (simSetupActiveSession) simSetupActiveSession.textContent = context.setupLabel;
    const simSetupModeSummary = document.getElementById('simSetupModeSummary');
    if (simSetupModeSummary) simSetupModeSummary.textContent = context.modeSummary;
    const sidebarSelect = document.getElementById('simSidebarSessionSelect');
    if (sidebarSelect) {
      const hasSessions = this.simulation.sessions.length > 0;
      sidebarSelect.disabled = !hasSessions;
      let opts = `<option value="" ${context.isSaved ? '' : 'selected'} disabled>${context.isSaved ? 'Choose a saved session...' : 'Unsaved Draft'}</option>`;
      for (let i = 0; i < this.simulation.sessions.length; i++) {
        const s = this.simulation.sessions[i];
        const label = s.name || `Session ${i + 1}`;
        opts += `<option value="${i}" ${i === context.activeIndex ? 'selected' : ''}>${label}</option>`;
      }
      sidebarSelect.innerHTML = opts;
    }
  }

  _getRunnableSimulationSessionBindings() {
    const routes = [];
    for (const binding of this._normalizeSimulationSessionBindings()) {
      if (binding.enabled === false) continue;
      if (!this.simulation.sessions[binding.sessionIndex]) continue;
      for (const layerId of binding.layerIds || []) {
        if (!this._getLayerById(layerId)) continue;
        routes.push({
          sessionId: binding.sessionId,
          sessionIndex: binding.sessionIndex,
          layerId,
        });
      }
    }
    return routes;
  }

  _getMultiSessionRouteDiagnostics({ autoHeal = false } = {}) {
    const sessions = Array.isArray(this.simulation.sessions) ? this.simulation.sessions : [];
    const bindings = this._normalizeSimulationSessionBindings();
    const armedBindings = bindings.filter(binding => (
      binding.enabled !== false && sessions[binding.sessionIndex]
    ));
    let healedBindings = false;

    if (autoHeal) {
      for (const binding of bindings) {
        const nextLayerIds = this._normalizeSimulationLayerIds(binding.layerIds, binding.sessionIndex);
        const prevLayerIds = Array.isArray(binding.layerIds) ? binding.layerIds : [];
        const unchanged = prevLayerIds.length === nextLayerIds.length
          && prevLayerIds.every((layerId, index) => layerId === nextLayerIds[index]);
        if (!unchanged) {
          binding.layerIds = nextLayerIds;
          healedBindings = true;
        }
      }
    }

    const runnableRoutes = [];
    for (const binding of armedBindings) {
      for (const layerId of binding.layerIds || []) {
        if (!this._getLayerById(layerId)) continue;
        runnableRoutes.push({
          sessionId: binding.sessionId,
          sessionIndex: binding.sessionIndex,
          layerId,
        });
      }
    }

    let blockReason = '';
    if (!sessions.length) {
      blockReason = 'Save at least one simulation session before running multiple sessions';
    } else if (!armedBindings.length) {
      blockReason = 'Enable (mount) at least one saved session route before running multiple sessions';
    } else if (!runnableRoutes.length) {
      blockReason = 'Mounted sessions have no valid target layer routes — reselect target layer(s) in Simulation Setup';
    }

    return {
      runnableRoutes,
      blockReason,
      healedBindings,
    };
  }

  _shouldUseMultiSessionPlayback() {
    return this.activeBrush === 'boid' && this.simulation.multiSessionEnabled === true;
  }

  _hasActiveMultiSessionPlayback() {
    return this._shouldUseMultiSessionPlayback() && this.simulation.runtimeSessions.length > 0;
  }

  _normalizeSimulationData() {
    for (const brush of ['boid', 'ant', 'motionPath']) {
      const data = this._getSimulationBrushData(brush);
      if (!data) continue;

      if (!Array.isArray(data.spawns)) {
        data.spawns = data.spawn ? [data.spawn] : [];
        delete data.spawn;
      }
      data.spawns = data.spawns.map(spawn => ({
        id: spawn?.id || this.simulation.nextId++,
        x: Number.isFinite(spawn?.x) ? spawn.x : this.W * 0.5,
        y: Number.isFinite(spawn?.y) ? spawn.y : this.H * 0.5,
        enabled: spawn?.enabled !== false,
        count: Number.isFinite(spawn?.count) ? Math.max(1, Math.min(MAX_SWARM_COUNT, Math.round(spawn.count))) : undefined,
        shape: SIM_SPAWN_SHAPES.includes(spawn?.shape) ? spawn.shape : undefined,
        radius: Number.isFinite(spawn?.radius) ? Math.max(1, spawn.radius) : undefined,
        angle: Number.isFinite(spawn?.angle) ? spawn.angle : undefined,
        jitter: Number.isFinite(spawn?.jitter) ? Math.max(0, Math.min(1, spawn.jitter)) : undefined,
        color: _normalizeHexColor(spawn?.color),
        opacity: Number.isFinite(spawn?.opacity) ? Math.max(0, Math.min(1, spawn.opacity)) : undefined,
        distribution: SIM_SPAWN_DISTRIBUTION_MODES.includes(spawn?.distribution) ? spawn.distribution : undefined,
        noiseScale: Number.isFinite(spawn?.noiseScale) ? _clampSimulationSpawnNoiseScale(spawn.noiseScale) : undefined,
        stampSize: Number.isFinite(spawn?.stampSize) ? Math.max(1, spawn.stampSize) : undefined,
        stampSeparation: Number.isFinite(spawn?.stampSeparation) ? Math.max(0, Math.min(1, spawn.stampSeparation)) : undefined,
        trailFlow: Number.isFinite(spawn?.trailFlow) ? Math.max(0, Math.min(1, spawn.trailFlow)) : undefined,
        smudge: Number.isFinite(spawn?.smudge) ? Math.max(0, Math.min(1, spawn.smudge)) : undefined,
        hueVar: Number.isFinite(spawn?.hueVar) ? Math.max(0, Math.min(1, spawn.hueVar)) : undefined,
        satVar: Number.isFinite(spawn?.satVar) ? Math.max(0, Math.min(1, spawn.satVar)) : undefined,
        litVar: Number.isFinite(spawn?.litVar) ? Math.max(0, Math.min(1, spawn.litVar)) : undefined,
        sizeVar: Number.isFinite(spawn?.sizeVar) ? Math.max(0, Math.min(1, spawn.sizeVar)) : undefined,
        opacityVar: Number.isFinite(spawn?.opacityVar) ? Math.max(0, Math.min(1, spawn.opacityVar)) : undefined,
        speedVar: Number.isFinite(spawn?.speedVar) ? Math.max(0, Math.min(1, spawn.speedVar)) : undefined,
        mask: this._normalizeSimulationSpawnMask(spawn?.mask),
      }));

      if (!Array.isArray(data.points)) data.points = [];
      data.points = data.points.map(point => ({
        id: point?.id || this.simulation.nextId++,
        x: Number.isFinite(point?.x) ? point.x : this.W * 0.5,
        y: Number.isFinite(point?.y) ? point.y : this.H * 0.5,
        type: point?.type === 'repel' ? 'repel' : 'attract',
        enabled: point?.enabled !== false,
        color: _normalizeHexColor(point?.color),
        strength: Number.isFinite(point?.strength) ? Math.max(0, point.strength) : undefined,
        radius: Number.isFinite(point?.radius) ? Math.max(1, point.radius) : undefined,
        hardness: Number.isFinite(point?.hardness) ? Math.max(DEFAULT_SIM_HARDNESS, Math.min(MAX_SIM_HARDNESS, point.hardness)) : undefined,
      }));

      if (this._usesPathGuides(brush)) {
        const legacyPaths = [];
        if (Array.isArray(data.path) && data.path.length >= 2) legacyPaths.push({ points: data.path });
        if (Array.isArray(data.paths)) legacyPaths.push(...data.paths);
        data.paths = legacyPaths.map(pathItem => {
          const primitiveKind = _normalizeSimulationPathPrimitiveKind(pathItem?.primitiveKind);
          const points = Array.isArray(pathItem?.points)
            ? pathItem.points
                .filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
                .map(pt => ({ x: pt.x, y: pt.y }))
            : [];
          const bounds = _getSimulationPathBounds(points);
          const normalized = {
            id: pathItem?.id || this.simulation.nextId++,
            enabled: pathItem?.enabled !== false,
            points,
            color: _normalizeHexColor(pathItem?.color),
            strength: Number.isFinite(pathItem?.strength) ? _normalizeSimulationPathStrength(pathItem.strength) : undefined,
            radius: Number.isFinite(pathItem?.radius) ? Math.max(1, pathItem.radius) : undefined,
            influenceRadius: Number.isFinite(pathItem?.influenceRadius) ? Math.max(1, pathItem.influenceRadius) : undefined,
            closed: !!pathItem?.closed,
            startOffset: Number.isFinite(pathItem?.startOffset) ? _clamp01(pathItem.startOffset) : 0,
            direction: _normalizeSimulationPathDirection(pathItem?.direction),
            primitiveKind,
            centerX: Number.isFinite(pathItem?.centerX) ? pathItem.centerX : (bounds?.centerX ?? this.W * 0.5),
            centerY: Number.isFinite(pathItem?.centerY) ? pathItem.centerY : (bounds?.centerY ?? this.H * 0.5),
            primitiveRadius: Number.isFinite(pathItem?.primitiveRadius)
              ? Math.max(8, pathItem.primitiveRadius)
              : Math.max(8, Math.max(bounds?.width || 0, bounds?.height || 0, SIM_PATH_PRIMITIVE_DEFAULT_RADIUS) * 0.5),
            primitiveRadiusY: Number.isFinite(pathItem?.primitiveRadiusY)
              ? Math.max(8, pathItem.primitiveRadiusY)
              : undefined,
            speed: _normalizeSimulationPathSpeed(pathItem?.speed),
            pathType: _normalizeSimulationPathType(pathItem?.pathType),
            speedPoints: _normalizeSimulationPathSpeedPoints(pathItem?.speedPoints, () => this.simulation.nextId++),
            radiusPoints: _normalizeSimulationPathRadiusPoints(pathItem?.radiusPoints, () => this.simulation.nextId++, pathItem?.radius),
            strengthPoints: _normalizeSimulationPathStrengthPoints(pathItem?.strengthPoints, () => this.simulation.nextId++, pathItem?.strength),
            travelDistance: Number.isFinite(pathItem?.travelDistance) ? pathItem.travelDistance : 0,
          };
          if (primitiveKind) {
            if (!Number.isFinite(normalized.primitiveRadiusY)) {
              normalized.primitiveRadiusY = primitiveKind === 'ellipse'
                ? normalized.primitiveRadius * SIM_PATH_PRIMITIVE_DEFAULT_ELLIPSE_RATIO
                : normalized.primitiveRadius;
            }
            _rebuildSimulationPathPrimitive(normalized);
          }
          return normalized;
        }).filter(pathItem => pathItem.points.length >= 2);
        delete data.path;
      }

      if (brush === 'ant') {
        if (!Array.isArray(data.edges)) data.edges = [];
        data.edges = data.edges.map(edge => ({
          id: edge?.id || this.simulation.nextId++,
          enabled: edge?.enabled !== false,
          points: Array.isArray(edge?.points)
            ? edge.points
                .filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
                .map(pt => ({ x: pt.x, y: pt.y }))
            : [],
          strength: Number.isFinite(edge?.strength) ? Math.max(0, edge.strength) : undefined,
          radius: Number.isFinite(edge?.radius) ? Math.max(0, edge.radius) : undefined,
        })).filter(edge => edge.points.length >= 2);

        if (!Array.isArray(data.pheromonePaths)) data.pheromonePaths = [];
        data.pheromonePaths = data.pheromonePaths.map(pathItem => ({
          id: pathItem?.id || this.simulation.nextId++,
          enabled: pathItem?.enabled !== false,
          points: Array.isArray(pathItem?.points)
            ? pathItem.points
                .filter(pt => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
                .map(pt => ({ x: pt.x, y: pt.y }))
            : [],
          radius: Number.isFinite(pathItem?.radius) ? Math.max(1, pathItem.radius) : undefined,
          intensity: Number.isFinite(pathItem?.intensity) ? Math.max(0, Math.min(1, pathItem.intensity)) : undefined,
        })).filter(pathItem => pathItem.points.length >= 2);
      }
    }

    if (this.simulation.selected && !this._getSelectedSimulationEntry()) {
      this.simulation.selected = null;
    }
    this._normalizeForceVizState();
  }

  // ========================================================
  // FORCE VISUALIZATION SUBMODE
  // ========================================================
  // Scenarios are pure config: groups (bound to an existing spawn
  // definition + optional paint layer), attractors (fixed/unreachable/
  // moving/orbiting/path/shared), and routes that connect a group to an
  // attractor with a weight. Everything here is persisted; per-frame
  // resolved positions, camera smoothing bookkeeping, and agent index
  // ranges are computed fresh each run and never saved (see
  // _forceVizCameraRuntime and BoidBrush._spawnRangesById).

  _createForceVizId(prefix) {
    return `${prefix}-${(this.simulation.nextId++).toString(36)}`;
  }

  _createDefaultForceVizCameraConfig() {
    return {
      policy: 'fixed', // fixed | followBoid | followCentroid | frameGroups | orbit
      targetGroupId: null,
      targetBoidIndex: 0,
      smoothing: 0.12, // 0..1 per-frame lerp factor
      offsetX: 0,
      offsetY: 0,
      lookahead: 0, // 0..1 velocity lookahead factor
      padding: 80, // px padding used by frameGroups
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      orbitRadius: 260,
      orbitSpeed: 0.25, // radians/sec
      interruption: 'holdOnUserInput', // holdOnUserInput | resumeAfterDelay | ignoreUserInput
      resumeDelay: 1.5, // seconds, used by resumeAfterDelay
      exitBehavior: 'restoreManualView', // restoreManualView | retainCurrentView
    };
  }

  _createDefaultForceVizAttractor(overrides = {}) {
    return {
      id: this._createForceVizId('attractor'),
      name: overrides.name || 'Attractor 1',
      type: 'fixed',
      enabled: true,
      x: Number.isFinite(overrides.x) ? overrides.x : this.W * 0.5,
      y: Number.isFinite(overrides.y) ? overrides.y : this.H * 0.5,
      strength: FORCE_VIZ_DEFAULT_ATTRACTOR_STRENGTH,
      radius: FORCE_VIZ_DEFAULT_ATTRACTOR_RADIUS,
      influenceRadius: FORCE_VIZ_DEFAULT_ATTRACTOR_RADIUS * 2,
      hardness: DEFAULT_SIM_HARDNESS,
      movement: {
        velocityX: 0,
        velocityY: 0,
        driftRadius: 40,
        driftSpeed: 0.15,
        orbitCenterX: this.W * 0.5,
        orbitCenterY: this.H * 0.5,
        orbitRadius: 100,
        orbitSpeed: 0.5,
        pathId: null,
      },
      sharedAttractorId: null,
    };
  }

  _createDefaultForceVizGroup(overrides = {}) {
    return {
      id: this._createForceVizId('group'),
      name: overrides.name || 'Group 1',
      spawnId: overrides.spawnId ?? null,
      layerId: overrides.layerId ?? null,
    };
  }

  _createDefaultForceVizRoute(overrides = {}) {
    return {
      id: this._createForceVizId('route'),
      groupId: overrides.groupId ?? null,
      attractorId: overrides.attractorId ?? null,
      weight: Number.isFinite(overrides.weight) ? overrides.weight : 1,
      enabled: true,
    };
  }

  _createDefaultForceVizScenario() {
    const group = this._createDefaultForceVizGroup();
    const attractor = this._createDefaultForceVizAttractor();
    return {
      id: this._createForceVizId('scenario'),
      name: 'Scenario 1',
      groups: [group],
      attractors: [attractor],
      routes: [this._createDefaultForceVizRoute({ groupId: group.id, attractorId: attractor.id })],
    };
  }

  _createDefaultForceVizState() {
    const scenario = this._createDefaultForceVizScenario();
    return {
      activeScenarioIndex: 0,
      scenarios: [scenario],
      // The UI edits one group/attractor/route at a time while the
      // underlying model stays array-based so more can be added later.
      ui: {
        activeGroupId: scenario.groups[0]?.id ?? null,
        activeAttractorId: scenario.attractors[0]?.id ?? null,
        activeRouteId: scenario.routes[0]?.id ?? null,
      },
      camera: this._createDefaultForceVizCameraConfig(),
    };
  }

  _normalizeForceVizCameraConfig(raw) {
    const defaults = this._createDefaultForceVizCameraConfig();
    const cfg = raw && typeof raw === 'object' ? raw : {};
    return {
      policy: FORCE_VIZ_CAMERA_POLICIES.includes(cfg.policy) ? cfg.policy : defaults.policy,
      targetGroupId: typeof cfg.targetGroupId === 'string' ? cfg.targetGroupId : null,
      targetBoidIndex: Number.isFinite(cfg.targetBoidIndex) ? Math.max(0, Math.round(cfg.targetBoidIndex)) : defaults.targetBoidIndex,
      smoothing: Number.isFinite(cfg.smoothing) ? _clamp01(cfg.smoothing) : defaults.smoothing,
      offsetX: Number.isFinite(cfg.offsetX) ? cfg.offsetX : defaults.offsetX,
      offsetY: Number.isFinite(cfg.offsetY) ? cfg.offsetY : defaults.offsetY,
      lookahead: Number.isFinite(cfg.lookahead) ? _clamp01(cfg.lookahead) : defaults.lookahead,
      padding: Number.isFinite(cfg.padding) ? Math.max(0, cfg.padding) : defaults.padding,
      minZoom: Number.isFinite(cfg.minZoom) ? Math.max(MIN_ZOOM, cfg.minZoom) : defaults.minZoom,
      maxZoom: Number.isFinite(cfg.maxZoom) ? Math.min(MAX_ZOOM, cfg.maxZoom) : defaults.maxZoom,
      orbitRadius: Number.isFinite(cfg.orbitRadius) ? Math.max(1, cfg.orbitRadius) : defaults.orbitRadius,
      orbitSpeed: Number.isFinite(cfg.orbitSpeed) ? cfg.orbitSpeed : defaults.orbitSpeed,
      interruption: FORCE_VIZ_CAMERA_INTERRUPTIONS.includes(cfg.interruption) ? cfg.interruption : defaults.interruption,
      resumeDelay: Number.isFinite(cfg.resumeDelay) ? Math.max(0, cfg.resumeDelay) : defaults.resumeDelay,
      exitBehavior: FORCE_VIZ_CAMERA_EXIT_BEHAVIORS.includes(cfg.exitBehavior) ? cfg.exitBehavior : defaults.exitBehavior,
    };
  }

  _normalizeForceVizAttractor(raw) {
    const defaults = this._createDefaultForceVizAttractor();
    const src = raw && typeof raw === 'object' ? raw : {};
    const movement = src.movement && typeof src.movement === 'object' ? src.movement : {};
    const rawPathId = (typeof movement.pathId === 'string' || typeof movement.pathId === 'number') ? movement.pathId : null;
    const boundPath = rawPathId == null
      ? null
      : this._getForceVizPathOptions().find(path => String(path.id) === String(rawPathId));
    return {
      id: typeof src.id === 'string' && src.id ? src.id : this._createForceVizId('attractor'),
      name: typeof src.name === 'string' && src.name.trim() ? src.name.slice(0, 60) : defaults.name,
      type: FORCE_VIZ_ATTRACTOR_TYPES.includes(src.type) ? src.type : defaults.type,
      enabled: src.enabled !== false,
      x: Number.isFinite(src.x) ? src.x : defaults.x,
      y: Number.isFinite(src.y) ? src.y : defaults.y,
      strength: Number.isFinite(src.strength) ? Math.max(0, src.strength) : defaults.strength,
      radius: Number.isFinite(src.radius) ? Math.max(1, src.radius) : defaults.radius,
      influenceRadius: Number.isFinite(src.influenceRadius) ? Math.max(1, src.influenceRadius) : defaults.influenceRadius,
      hardness: Number.isFinite(src.hardness) ? Math.max(DEFAULT_SIM_HARDNESS, Math.min(MAX_SIM_HARDNESS, src.hardness)) : defaults.hardness,
      movement: {
        velocityX: Number.isFinite(movement.velocityX) ? movement.velocityX : defaults.movement.velocityX,
        velocityY: Number.isFinite(movement.velocityY) ? movement.velocityY : defaults.movement.velocityY,
        driftRadius: Number.isFinite(movement.driftRadius) ? Math.max(0, movement.driftRadius) : defaults.movement.driftRadius,
        driftSpeed: Number.isFinite(movement.driftSpeed) ? movement.driftSpeed : defaults.movement.driftSpeed,
        orbitCenterX: Number.isFinite(movement.orbitCenterX) ? movement.orbitCenterX : defaults.movement.orbitCenterX,
        orbitCenterY: Number.isFinite(movement.orbitCenterY) ? movement.orbitCenterY : defaults.movement.orbitCenterY,
        orbitRadius: Number.isFinite(movement.orbitRadius) ? Math.max(0, movement.orbitRadius) : defaults.movement.orbitRadius,
        orbitSpeed: Number.isFinite(movement.orbitSpeed) ? movement.orbitSpeed : defaults.movement.orbitSpeed,
        pathId: boundPath?.id ?? rawPathId,
      },
      sharedAttractorId: typeof src.sharedAttractorId === 'string' ? src.sharedAttractorId : null,
    };
  }

  _normalizeForceVizGroup(raw) {
    const defaults = this._createDefaultForceVizGroup();
    const src = raw && typeof raw === 'object' ? raw : {};
    const rawSpawnId = (typeof src.spawnId === 'string' || typeof src.spawnId === 'number') ? src.spawnId : null;
    const boundSpawn = rawSpawnId == null
      ? null
      : this._getForceVizSpawnOptions().find(spawn => String(spawn.id) === String(rawSpawnId));
    return {
      id: typeof src.id === 'string' && src.id ? src.id : this._createForceVizId('group'),
      name: typeof src.name === 'string' && src.name.trim() ? src.name.slice(0, 60) : defaults.name,
      spawnId: boundSpawn?.id ?? rawSpawnId,
      layerId: typeof src.layerId === 'string' ? src.layerId : null,
    };
  }

  _normalizeForceVizRoute(raw, groupIds, attractorIds) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const groupId = groupIds.has(src.groupId) ? src.groupId : null;
    const attractorId = attractorIds.has(src.attractorId) ? src.attractorId : null;
    return {
      id: typeof src.id === 'string' && src.id ? src.id : this._createForceVizId('route'),
      groupId,
      attractorId,
      weight: Number.isFinite(src.weight) ? Math.max(0, src.weight) : 1,
      enabled: src.enabled !== false,
    };
  }

  _normalizeForceVizScenario(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const groups = (Array.isArray(src.groups) ? src.groups : []).map(group => this._normalizeForceVizGroup(group));
    const attractors = (Array.isArray(src.attractors) ? src.attractors : []).map(attractor => this._normalizeForceVizAttractor(attractor));
    if (!groups.length) groups.push(this._createDefaultForceVizGroup());
    if (!attractors.length) attractors.push(this._createDefaultForceVizAttractor());
    const groupIds = new Set(groups.map(group => group.id));
    const attractorIds = new Set(attractors.map(attractor => attractor.id));
    // Shared attractors must reference another attractor in the same scenario.
    for (const attractor of attractors) {
      if (attractor.type === 'shared' && (!attractor.sharedAttractorId || !attractorIds.has(attractor.sharedAttractorId) || attractor.sharedAttractorId === attractor.id)) {
        attractor.sharedAttractorId = attractors.find(other => other.id !== attractor.id)?.id ?? null;
      }
    }
    let routes = (Array.isArray(src.routes) ? src.routes : [])
      .map(route => this._normalizeForceVizRoute(route, groupIds, attractorIds))
      .filter(route => route.groupId && route.attractorId);
    if (!routes.length) {
      routes = [this._createDefaultForceVizRoute({ groupId: groups[0].id, attractorId: attractors[0].id })];
    }
    return {
      id: typeof src.id === 'string' && src.id ? src.id : this._createForceVizId('scenario'),
      name: typeof src.name === 'string' && src.name.trim() ? src.name.slice(0, 60) : 'Scenario',
      groups,
      attractors,
      routes,
    };
  }

  /** Normalizes/migrates `simulation.forceViz` in place. Safe to call
   *  repeatedly (constructor, after load, after workspace import) — older
   *  saves that predate this submode simply get the default state. */
  _normalizeForceVizState() {
    const raw = this.simulation.forceViz;
    const scenarios = (raw && Array.isArray(raw.scenarios) && raw.scenarios.length
      ? raw.scenarios
      : [this._createDefaultForceVizScenario()]
    ).map(scenario => this._normalizeForceVizScenario(scenario));
    const activeScenarioIndex = Number.isFinite(raw?.activeScenarioIndex)
      ? Math.max(0, Math.min(scenarios.length - 1, Math.round(raw.activeScenarioIndex)))
      : 0;
    const scenario = scenarios[activeScenarioIndex];
    const uiRaw = raw?.ui && typeof raw.ui === 'object' ? raw.ui : {};
    const groupIds = new Set(scenario.groups.map(group => group.id));
    const attractorIds = new Set(scenario.attractors.map(attractor => attractor.id));
    const routeIds = new Set(scenario.routes.map(route => route.id));
    this.simulation.forceViz = {
      activeScenarioIndex,
      scenarios,
      ui: {
        activeGroupId: groupIds.has(uiRaw.activeGroupId) ? uiRaw.activeGroupId : scenario.groups[0].id,
        activeAttractorId: attractorIds.has(uiRaw.activeAttractorId) ? uiRaw.activeAttractorId : scenario.attractors[0].id,
        activeRouteId: routeIds.has(uiRaw.activeRouteId) ? uiRaw.activeRouteId : scenario.routes[0].id,
      },
      camera: this._normalizeForceVizCameraConfig(raw?.camera),
    };
  }

  _getActiveForceVizScenario() {
    const fv = this.simulation.forceViz;
    if (!fv) return null;
    return fv.scenarios[fv.activeScenarioIndex] || fv.scenarios[0] || null;
  }

  _getForceVizGroup(groupId, scenario = this._getActiveForceVizScenario()) {
    return scenario?.groups.find(group => group.id === groupId) || null;
  }

  _getForceVizAttractor(attractorId, scenario = this._getActiveForceVizScenario()) {
    return scenario?.attractors.find(attractor => attractor.id === attractorId) || null;
  }

  _getForceVizRoutesForGroup(groupId, scenario = this._getActiveForceVizScenario()) {
    return scenario?.routes.filter(route => route.groupId === groupId) || [];
  }

  /** Options for the "bind to spawn" control: existing boid spawn
   *  definitions, not a duplicate physics/spawn config. */
  _getForceVizSpawnOptions() {
    const data = this._getSimulationBrushData('boid');
    return Array.isArray(data?.spawns) ? data.spawns : [];
  }

  _getForceVizPathOptions() {
    const data = this._getSimulationBrushData('boid');
    return Array.isArray(data?.paths) ? data.paths : [];
  }

  _setSimulationMode(mode) {
    const next = mode === 'forceVisualization' ? 'forceVisualization' : 'normal';
    if (this.simulation.mode === next) return;
    if (this.simulation.running || this.simulation.paused) this.stopSimulation(false);
    if (next === 'forceVisualization') {
      this._forceVizManualViewSnapshot = this._captureViewState();
    } else {
      this._restoreOrRetainForceVizView();
    }
    this.simulation.mode = next;
    this._normalizeForceVizState();
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
    this.showToast(next === 'forceVisualization' ? 'Force Visualization mode ON' : 'Force Visualization mode OFF');
  }

  /** Applies the configured exit behavior after a run stops: restores the
   *  manual view captured on entering the submode, or leaves the camera
   *  wherever the run left it ('retainCurrentView'). The snapshot itself is
   *  kept so repeated run/stop cycles within the same submode session keep
   *  restoring to the same baseline view. */
  _applyForceVizExitBehaviorOnStop() {
    const cfg = this.simulation.forceViz?.camera;
    const exitBehavior = cfg?.exitBehavior || 'restoreManualView';
    if (exitBehavior !== 'restoreManualView' || !this._forceVizManualViewSnapshot) return;
    const snapshot = this._forceVizManualViewSnapshot;
    this.viewZoom = snapshot.zoom;
    this.viewPanX = snapshot.panX;
    this.viewPanY = snapshot.panY;
    this.viewRotation = snapshot.rotation;
    this._applyViewTransform();
  }

  /** Called when actually leaving Force Visualization mode (not just
   *  stopping a run): applies the same exit behavior, then discards the
   *  snapshot since there is no longer a submode session to return to. */
  _restoreOrRetainForceVizView() {
    this._applyForceVizExitBehaviorOnStop();
    this._forceVizManualViewSnapshot = null;
  }

  _addForceVizGroup() {
    const scenario = this._getActiveForceVizScenario();
    if (!scenario) return null;
    const group = this._createDefaultForceVizGroup({ name: `Group ${scenario.groups.length + 1}` });
    scenario.groups.push(group);
    this.simulation.forceViz.ui.activeGroupId = group.id;
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
    return group;
  }

  _removeForceVizGroup(groupId) {
    const scenario = this._getActiveForceVizScenario();
    if (!scenario || scenario.groups.length <= 1) return;
    scenario.groups = scenario.groups.filter(group => group.id !== groupId);
    scenario.routes = scenario.routes.filter(route => route.groupId !== groupId);
    if (!scenario.routes.length) {
      scenario.routes.push(this._createDefaultForceVizRoute({ groupId: scenario.groups[0].id, attractorId: scenario.attractors[0].id }));
    }
    this._normalizeForceVizState();
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
  }

  _setForceVizActiveGroup(groupId) {
    if (!this.simulation.forceViz) return;
    this.simulation.forceViz.ui.activeGroupId = groupId;
    this._syncSimulationUI();
  }

  _updateForceVizGroup(groupId, patch) {
    const group = this._getForceVizGroup(groupId);
    if (!group) return;
    Object.assign(group, patch);
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
  }

  _addForceVizAttractor() {
    const scenario = this._getActiveForceVizScenario();
    if (!scenario) return null;
    const attractor = this._createDefaultForceVizAttractor({ name: `Attractor ${scenario.attractors.length + 1}` });
    scenario.attractors.push(attractor);
    this.simulation.forceViz.ui.activeAttractorId = attractor.id;
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
    return attractor;
  }

  _removeForceVizAttractor(attractorId) {
    const scenario = this._getActiveForceVizScenario();
    if (!scenario || scenario.attractors.length <= 1) return;
    scenario.attractors = scenario.attractors.filter(attractor => attractor.id !== attractorId);
    scenario.routes = scenario.routes.filter(route => route.attractorId !== attractorId);
    for (const attractor of scenario.attractors) {
      if (attractor.sharedAttractorId === attractorId) attractor.sharedAttractorId = null;
    }
    if (!scenario.routes.length) {
      scenario.routes.push(this._createDefaultForceVizRoute({ groupId: scenario.groups[0].id, attractorId: scenario.attractors[0].id }));
    }
    this._normalizeForceVizState();
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
  }

  _setForceVizActiveAttractor(attractorId) {
    if (!this.simulation.forceViz) return;
    this.simulation.forceViz.ui.activeAttractorId = attractorId;
    this._syncSimulationUI();
  }

  _updateForceVizAttractor(attractorId, patch) {
    const attractor = this._getForceVizAttractor(attractorId);
    if (!attractor) return;
    if (patch && typeof patch === 'object' && patch.movement) {
      attractor.movement = { ...attractor.movement, ...patch.movement };
      const { movement, ...rest } = patch;
      Object.assign(attractor, rest);
    } else {
      Object.assign(attractor, patch);
    }
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
  }

  _addForceVizRoute() {
    const scenario = this._getActiveForceVizScenario();
    if (!scenario) return null;
    const groupId = this.simulation.forceViz.ui.activeGroupId || scenario.groups[0].id;
    const attractorId = this.simulation.forceViz.ui.activeAttractorId || scenario.attractors[0].id;
    const route = this._createDefaultForceVizRoute({ groupId, attractorId });
    scenario.routes.push(route);
    this.simulation.forceViz.ui.activeRouteId = route.id;
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
    return route;
  }

  _removeForceVizRoute(routeId) {
    const scenario = this._getActiveForceVizScenario();
    if (!scenario || scenario.routes.length <= 1) return;
    scenario.routes = scenario.routes.filter(route => route.id !== routeId);
    this._normalizeForceVizState();
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
  }

  _setForceVizActiveRoute(routeId) {
    if (!this.simulation.forceViz) return;
    this.simulation.forceViz.ui.activeRouteId = routeId;
    this._syncSimulationUI();
  }

  _updateForceVizRoute(routeId, patch) {
    const scenario = this._getActiveForceVizScenario();
    const route = scenario?.routes.find(entry => entry.id === routeId);
    if (!route) return;
    Object.assign(route, patch);
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
  }

  _updateForceVizCamera(patch) {
    if (!this.simulation.forceViz) return;
    this.simulation.forceViz.camera = this._normalizeForceVizCameraConfig({ ...this.simulation.forceViz.camera, ...patch });
    this._syncSimulationUI();
    this._maybeAutoSaveSession?.();
  }

  /** Live position for one attractor this frame. Reuses the same animated
   *  path-target math as simulation guide paths for the 'path' type, so a
   *  path attractor and a path guide behave identically. */
  _resolveForceVizAttractorPosition(attractor, elapsed, scenario, depth = 0) {
    if (!attractor) return null;
    switch (attractor.type) {
      case 'moving': {
        const vx = attractor.movement?.velocityX || 0;
        const vy = attractor.movement?.velocityY || 0;
        return { x: attractor.x + vx * elapsed, y: attractor.y + vy * elapsed };
      }
      case 'unreachable': {
        // Drifts continuously around its anchor so the influence falloff
        // never fully saturates — boids chase it but never quite arrive.
        const driftAngle = elapsed * (attractor.movement?.driftSpeed || 0);
        const driftRadius = attractor.movement?.driftRadius || 0;
        return {
          x: attractor.x + Math.cos(driftAngle) * driftRadius,
          y: attractor.y + Math.sin(driftAngle) * driftRadius,
        };
      }
      case 'orbiting': {
        const cx = attractor.movement?.orbitCenterX ?? attractor.x;
        const cy = attractor.movement?.orbitCenterY ?? attractor.y;
        const radius = Math.max(0, attractor.movement?.orbitRadius || 0);
        const angle = elapsed * (attractor.movement?.orbitSpeed || 0);
        return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
      }
      case 'path': {
        const pathItem = this._getForceVizPathOptions().find(entry => String(entry.id) === String(attractor.movement?.pathId));
        if (!pathItem) return { x: attractor.x, y: attractor.y };
        const target = this._getAnimatedSimulationPathTarget(pathItem, this.getP());
        return target ? { x: target.x, y: target.y } : { x: attractor.x, y: attractor.y };
      }
      case 'shared': {
        if (depth > 4) return { x: attractor.x, y: attractor.y };
        const target = scenario?.attractors.find(entry => entry.id === attractor.sharedAttractorId);
        if (!target || target.id === attractor.id) return { x: attractor.x, y: attractor.y };
        return this._resolveForceVizAttractorPosition(target, elapsed, scenario, depth + 1);
      }
      case 'fixed':
      default:
        return { x: attractor.x, y: attractor.y };
    }
  }

  /** Maps a Force Visualization group to the agent index range its bound
   *  spawn produced this stroke (see BoidBrush._spawnRangesById). Returns
   *  null when the group isn't bound or hasn't spawned yet — the route is
   *  simply skipped for this frame rather than falling back to "everyone". */
  _resolveForceVizGroupRange(brush, group) {
    const ranges = brush?._spawnRangesById;
    if (!ranges || group?.spawnId == null) return null;
    const range = ranges.get(group.spawnId)
      || [...ranges.entries()].find(([spawnId]) => String(spawnId) === String(group.spawnId))?.[1];
    if (!range) return null;
    return { start: range.startIndex, end: range.endIndex };
  }

  /** Builds the CPU-applied, group-scoped guide points routes describe.
   *  Called from brushes.js `_collectSimulationGuides` only while
   *  simulation.mode === 'forceVisualization'. */
  _collectForceVizGuidePoints(brush, p) {
    const scenario = this._getActiveForceVizScenario();
    if (!scenario || !scenario.routes.length) return [];
    const elapsed = (performance.now() - this._startTime) / 1000;
    const points = [];
    for (const route of scenario.routes) {
      if (route.enabled === false) continue;
      const weight = Math.max(0, route.weight ?? 1);
      if (weight <= 0) continue;
      const group = this._getForceVizGroup(route.groupId, scenario);
      const attractor = this._getForceVizAttractor(route.attractorId, scenario);
      if (!group || !attractor || attractor.enabled === false) continue;
      const groupRange = this._resolveForceVizGroupRange(brush, group);
      if (!groupRange) continue;
      const pos = this._resolveForceVizAttractorPosition(attractor, elapsed, scenario);
      if (!pos) continue;
      points.push({
        x: pos.x,
        y: pos.y,
        strength: Math.max(0, (attractor.strength ?? 0) * weight),
        radius: Math.max(1, attractor.radius ?? FORCE_VIZ_DEFAULT_ATTRACTOR_RADIUS),
        influenceRadius: Math.max(attractor.radius ?? FORCE_VIZ_DEFAULT_ATTRACTOR_RADIUS, attractor.influenceRadius ?? FORCE_VIZ_DEFAULT_ATTRACTOR_RADIUS * 2),
        groupRange,
      });
    }
    return points;
  }

  /** Computes the pan (viewPanX/viewPanY) that would center canvas point
   *  (focusX, focusY) in the viewport at the given zoom/rotation, reusing
   *  the exact same anchor math manual pan/zoom/pinch already use — the
   *  camera adapter never introduces a second coordinate system. */
  _computeForceVizCenteredPan(focusX, focusY, zoom, rotation) {
    const areaRect = document.getElementById('canvasArea')?.getBoundingClientRect();
    const w = areaRect?.width || this.W;
    const h = areaRect?.height || this.H;
    const savedZoom = this.viewZoom;
    const savedRotation = this.viewRotation;
    this.viewZoom = zoom;
    this.viewRotation = rotation;
    this._setViewPanForScreenAnchor(focusX, focusY, w / 2, h / 2);
    const panX = this.viewPanX;
    const panY = this.viewPanY;
    this.viewZoom = savedZoom;
    this.viewRotation = savedRotation;
    return { panX, panY };
  }

  _isForceVizCameraInterrupted(cfg) {
    if (cfg.interruption === 'ignoreUserInput') return false;
    const runtime = this._forceVizCameraRuntime;
    const sinceMs = performance.now() - (runtime.lastManualInputAt || 0);
    if (cfg.interruption === 'resumeAfterDelay') {
      return sinceMs < Math.max(0, (cfg.resumeDelay || 0) * 1000);
    }
    // holdOnUserInput: pause automation briefly after any manual pan/zoom/rotate.
    return sinceMs < FORCE_VIZ_MANUAL_INPUT_HOLD_MS;
  }

  /** Resolves the desired focus point/zoom/rotation for the active camera
   *  policy from BoidBrush's cached transient snapshot (centroid/bounds/
   *  average velocity/candidates) — never re-scans the agent buffer here.
   *  Returns null when the policy has nothing to frame yet (e.g. no agents
   *  spawned) so the adapter leaves the camera exactly where it is. */
  _resolveForceVizCameraDesired(brush, elapsed) {
    const cfg = this.simulation.forceViz.camera;
    const snapshot = brush?._transientSnapshot;
    switch (cfg.policy) {
      case 'followBoid': {
        if (!snapshot?.count || !snapshot.candidates?.length) return null;
        const idx = Math.max(0, Math.min(snapshot.candidates.length - 1, Math.round(cfg.targetBoidIndex || 0)));
        const candidate = snapshot.candidates[idx];
        return { focusX: candidate.x, focusY: candidate.y, velX: candidate.vx, velY: candidate.vy, zoom: this.viewZoom, rotation: this.viewRotation };
      }
      case 'followCentroid': {
        if (!snapshot?.count) return null;
        return { focusX: snapshot.centroid.x, focusY: snapshot.centroid.y, velX: snapshot.avgVelocity.x, velY: snapshot.avgVelocity.y, zoom: this.viewZoom, rotation: this.viewRotation };
      }
      case 'frameGroups': {
        if (!snapshot?.count) return null;
        const { minX, minY, maxX, maxY } = snapshot.bounds;
        const areaRect = document.getElementById('canvasArea')?.getBoundingClientRect();
        const areaW = areaRect?.width || this.W;
        const areaH = areaRect?.height || this.H;
        const pad = Math.max(0, cfg.padding || 0);
        const boundsW = Math.max(1, maxX - minX);
        const boundsH = Math.max(1, maxY - minY);
        const zoom = Math.max(0.01, Math.min(areaW / (boundsW + pad * 2), areaH / (boundsH + pad * 2)));
        return { focusX: (minX + maxX) / 2, focusY: (minY + maxY) / 2, velX: 0, velY: 0, zoom, rotation: this.viewRotation };
      }
      case 'orbit': {
        if (!snapshot?.count) return null;
        const runtime = this._forceVizCameraRuntime;
        const dt = Number.isFinite(runtime.lastElapsed) ? Math.max(0, Math.min(0.25, elapsed - runtime.lastElapsed)) : 0;
        runtime.orbitAngle = (runtime.orbitAngle || 0) + (cfg.orbitSpeed || 0) * dt;
        runtime.lastElapsed = elapsed;
        return { focusX: snapshot.centroid.x, focusY: snapshot.centroid.y, velX: 0, velY: 0, zoom: this.viewZoom, rotation: runtime.orbitAngle };
      }
      case 'fixed':
      default:
        return null;
    }
  }

  /** The single adapter that turns a resolved camera policy target into
   *  actual view state changes: applies offset/lookahead, clamps zoom,
   *  respects interruption, smooths toward the target, and finally calls
   *  the same _applyViewTransform() manual pan/zoom uses. Canvas
   *  coordinates are untouched — this only moves viewZoom/viewPanX/
   *  viewPanY/viewRotation, the same fields manual navigation uses. */
  _applyForceVizCameraFrame(brush, elapsed) {
    const sim = this.simulation;
    if (!sim.enabled || sim.mode !== 'forceVisualization' || !sim.running) return;
    if (this.activeBrush !== 'boid') return;
    const cfg = sim.forceViz?.camera;
    if (!cfg || this._isForceVizCameraInterrupted(cfg)) return;
    const desired = this._resolveForceVizCameraDesired(brush, elapsed);
    if (!desired) return;
    const minZoom = Math.max(MIN_ZOOM, cfg.minZoom);
    const maxZoom = Math.min(MAX_ZOOM, cfg.maxZoom);
    const clampedZoom = Math.max(minZoom, Math.min(maxZoom, desired.zoom));
    const lookahead = Math.max(0, cfg.lookahead || 0);
    const focusX = desired.focusX + (desired.velX || 0) * lookahead * FORCE_VIZ_LOOKAHEAD_SCALE + (cfg.offsetX || 0);
    const focusY = desired.focusY + (desired.velY || 0) * lookahead * FORCE_VIZ_LOOKAHEAD_SCALE + (cfg.offsetY || 0);
    const targetRotation = Number.isFinite(desired.rotation) ? desired.rotation : this.viewRotation;
    const target = this._computeForceVizCenteredPan(focusX, focusY, clampedZoom, targetRotation);
    const smoothing = Math.max(0.001, Math.min(1, cfg.smoothing));
    this.viewZoom = _lerp(this.viewZoom, clampedZoom, smoothing);
    this.viewPanX = _lerp(this.viewPanX, target.panX, smoothing);
    this.viewPanY = _lerp(this.viewPanY, target.panY, smoothing);
    this.viewRotation = _lerpAngle(this.viewRotation, targetRotation, smoothing);
    this._applyViewTransform();
  }

  /** Compact camera/status text for the HUD — the only place this reads
   *  from is the same transient snapshot + camera config the adapter uses. */
  _formatForceVizStatusText() {
    const sim = this.simulation;
    if (sim.mode !== 'forceVisualization') return '';
    const cfg = sim.forceViz?.camera;
    const scenario = this._getActiveForceVizScenario();
    const routeCount = scenario?.routes.filter(route => route.enabled !== false).length || 0;
    const policyLabel = {
      fixed: 'Fixed',
      followBoid: 'Follow Boid',
      followCentroid: 'Follow Centroid',
      frameGroups: 'Frame Groups',
      orbit: 'Orbit',
    }[cfg?.policy] || 'Fixed';
    const stateLabel = sim.running ? 'Running' : (sim.paused ? 'Paused' : 'Ready');
    return `${stateLabel} · ${routeCount} route${routeCount === 1 ? '' : 's'} · Cam: ${policyLabel} · ${Math.round(this.viewZoom * 100)}%`;
  }

  _syncForceVizUI() {
    const select = document.getElementById('simModeSelect');
    if (select && select.value !== this.simulation.mode) select.value = this.simulation.mode;
    document.querySelectorAll('[data-sim-force-viz-only]').forEach(el => {
      el.style.display = this.simulation.mode === 'forceVisualization' ? '' : 'none';
    });
    this._renderForceVizPanel?.();
    this._updateForceVizStatusText();
  }

  /** Cheap per-frame text refresh, split out from _syncForceVizUI() (which
   *  also toggles DOM visibility) so the camera-frame hook in the main RAF
   *  loop isn't doing a querySelectorAll every frame. */
  _updateForceVizStatusText() {
    const status = document.getElementById('simForceVizStatus');
    if (!status) return;
    const text = this._formatForceVizStatusText();
    if (status.textContent !== text) status.textContent = text;
    const nextDisplay = text ? '' : 'none';
    if (status.style.display !== nextDisplay) status.style.display = nextDisplay;
  }

  _resolveSimulationSpawnConfig(spawn, p = this.getP()) {
    return {
      count: Number.isFinite(spawn?.count) ? Math.max(1, Math.min(MAX_SWARM_COUNT, Math.round(spawn.count))) : p.count,
      shape: spawn?.shape || p.spawnShape,
      radius: Number.isFinite(spawn?.radius) ? Math.max(1, spawn.radius) : p.spawnRadius,
      angle: Number.isFinite(spawn?.angle) ? spawn.angle : p.spawnAngle,
      jitter: Number.isFinite(spawn?.jitter) ? Math.max(0, Math.min(1, spawn.jitter)) : p.spawnJitter,
      color: _normalizeHexColor(spawn?.color, _normalizeHexColor(p.color, '#1a1a1a')),
      opacity: Number.isFinite(spawn?.opacity) ? Math.max(0, Math.min(1, spawn.opacity)) : p.stampOpacity,
      distribution: SIM_SPAWN_DISTRIBUTION_MODES.includes(spawn?.distribution) ? spawn.distribution : 'uniform',
      noiseScale: Number.isFinite(spawn?.noiseScale) ? _clampSimulationSpawnNoiseScale(spawn.noiseScale) : 1,
      mask: spawn?.mask || null,
      stampSize: Number.isFinite(spawn?.stampSize) ? Math.max(1, spawn.stampSize) : p.stampSize,
      stampSeparation: Number.isFinite(spawn?.stampSeparation) ? Math.max(0, Math.min(1, spawn.stampSeparation)) : p.stampSeparation,
      trailFlow: Number.isFinite(spawn?.trailFlow) ? Math.max(0, Math.min(1, spawn.trailFlow)) : p.trailFlow,
      smudge: Number.isFinite(spawn?.smudge) ? Math.max(0, Math.min(1, spawn.smudge)) : p.smudge,
      hueVar: Number.isFinite(spawn?.hueVar) ? Math.max(0, Math.min(1, spawn.hueVar)) : p.hueVar,
      satVar: Number.isFinite(spawn?.satVar) ? Math.max(0, Math.min(1, spawn.satVar)) : p.satVar,
      litVar: Number.isFinite(spawn?.litVar) ? Math.max(0, Math.min(1, spawn.litVar)) : p.litVar,
      sizeVar: Number.isFinite(spawn?.sizeVar) ? Math.max(0, Math.min(1, spawn.sizeVar)) : p.sizeVar,
      opacityVar: Number.isFinite(spawn?.opacityVar) ? Math.max(0, Math.min(1, spawn.opacityVar)) : p.opacityVar,
      speedVar: Number.isFinite(spawn?.speedVar) ? Math.max(0, Math.min(1, spawn.speedVar)) : p.speedVar,
    };
  }

  _resolveSimulationPointConfig(point, p = this.getP()) {
    const radius = Number.isFinite(point?.radius) ? Math.max(1, point.radius) : p.simPointRadius;
    const isRepel = point?.type === 'repel';
    return {
      strength: Number.isFinite(point?.strength) ? Math.max(0, point.strength) : p.simPointStrength,
      radius,
      hardness: Number.isFinite(point?.hardness) ? Math.max(DEFAULT_SIM_HARDNESS, Math.min(MAX_SIM_HARDNESS, point.hardness)) : 1,
      influenceRadius: isRepel
        ? radius
        : (Number.isFinite(point?.influenceRadius)
            ? Math.max(radius, point.influenceRadius)
            : radius * DEFAULT_SIM_POINT_INFLUENCE_SCALE),
    };
  }

  _resolveSimulationPathConfig(pathItem, p = this.getP()) {
    const radius = Number.isFinite(pathItem?.radius) ? Math.max(1, pathItem.radius) : DEFAULT_PATH_RADIUS;
    return {
      strength: _normalizeSimulationPathStrength(Number.isFinite(pathItem?.strength) ? pathItem.strength : DEFAULT_PATH_STRENGTH),
      radius,
      influenceRadius: Number.isFinite(pathItem?.influenceRadius) ? Math.max(radius, pathItem.influenceRadius) : radius,
      closed: !!pathItem?.closed,
      startOffset: Number.isFinite(pathItem?.startOffset) ? _clamp01(pathItem.startOffset) : 0,
      direction: _normalizeSimulationPathDirection(pathItem?.direction),
      speed: _normalizeSimulationPathSpeed(pathItem?.speed),
    };
  }

  _getSimulationPathRenderPoints(pathItem) {
    const points = _normalizeSimulationPathPoints(pathItem?.points);
    if (points.length < 3) return points;
    return _smoothSimulationPathPoints(points, !!pathItem?.closed, 2);
  }

  _getSimulationPathSample(pathItem, traveledDistance = 0, p = this.getP()) {
    const config = this._resolveSimulationPathConfig(pathItem, p);
    const renderPoints = this._getSimulationPathRenderPoints(pathItem);
    const origin = _samplePolylinePointAtDistance(renderPoints, 0, config.closed);
    if (!origin) return null;
    const totalLength = origin.totalLength || 0;
    const startDistance = totalLength * config.startOffset;
    let distanceAlongPath = startDistance;
    if (config.closed) {
      distanceAlongPath = startDistance + (config.direction === 'reverse' ? -traveledDistance : traveledDistance);
    } else if (totalLength > 1e-6) {
      const startPhase = config.direction === 'reverse' ? (totalLength * 2) - startDistance : startDistance;
      const phase = _wrapIndex(startPhase + traveledDistance, totalLength * 2);
      distanceAlongPath = phase <= totalLength ? phase : (totalLength * 2) - phase;
    }
    const sample = _samplePolylinePointAtDistance(renderPoints, distanceAlongPath, config.closed);
    if (!sample) return null;
    const pathT = totalLength > 1e-6
      ? (config.closed ? _wrapIndex(distanceAlongPath / totalLength, 1) : _clamp01(distanceAlongPath / totalLength))
      : 0;
    const speed = _getSimulationPathSpeedAt(pathItem, pathT, config.speed, config.closed);
    const radius = _getSimulationPathRadiusAt(pathItem, pathT, config.radius, config.closed);
    const strength = _getSimulationPathStrengthAt(pathItem, pathT, config.strength, config.closed);
    return {
      ...sample,
      config: {
        ...config,
        radius,
        strength,
        influenceRadius: Math.max(radius, Number.isFinite(config.influenceRadius) ? config.influenceRadius : radius),
      },
      renderPoints,
      totalLength,
      startDistance,
      distanceAlongPath,
      pathT,
      speed,
      radius,
      strength,
    };
  }

  _getAnimatedSimulationPathTarget(pathItem, p = this.getP(), traveledDistance = null) {
    if (!pathItem?.points?.length) return null;
    const point = this._getSimulationPathSample(pathItem, Number.isFinite(traveledDistance) ? traveledDistance : (pathItem?.travelDistance || 0), p);
    return point ? { x: point.x, y: point.y, config: point.config, pathItem, tangentX: point.tangentX, tangentY: point.tangentY } : null;
  }

  _resolveSimulationEdgeConfig(edge, p = this.getP()) {
    return {
      strength: Number.isFinite(edge?.strength) ? Math.max(0, edge.strength) : p.simEdgeForce,
      radius: Number.isFinite(edge?.radius) ? Math.max(0, edge.radius) : p.simEdgeRadius,
    };
  }

  _resolveSimulationPheromoneConfig(pathItem, p = this.getP()) {
    return {
      radius: Number.isFinite(pathItem?.radius) ? Math.max(1, pathItem.radius) : p.simPheroPaintRadius,
      intensity: Number.isFinite(pathItem?.intensity) ? Math.max(0, Math.min(1, pathItem.intensity)) : p.simPheroPaintStrength,
    };
  }

  _getSimulationItemDefaultFields(kind, target = null, p = this.getP()) {
    const color = _normalizeHexColor(p?.color, '#1a1a1a');
    if (kind === 'spawn') {
      const defaults = {
        count: Math.max(1, Math.min(MAX_SWARM_COUNT, Math.round(p.count))),
        color,
        opacity: Math.max(0, Math.min(1, p.stampOpacity)),
        stampSize: Math.max(1, p.stampSize),
        stampSeparation: Math.max(0, Math.min(1, p.stampSeparation)),
        trailFlow: Math.max(0, Math.min(1, p.trailFlow)),
        smudge: Math.max(0, Math.min(1, p.smudge)),
        hueVar: Math.max(0, Math.min(1, p.hueVar)),
        satVar: Math.max(0, Math.min(1, p.satVar)),
        litVar: Math.max(0, Math.min(1, p.litVar)),
        sizeVar: Math.max(0, Math.min(1, p.sizeVar)),
        opacityVar: Math.max(0, Math.min(1, p.opacityVar)),
        speedVar: Math.max(0, Math.min(1, p.speedVar)),
      };
      if (target?.mask) {
        defaults.distribution = 'uniform';
        defaults.noiseScale = 1;
      } else {
        defaults.shape = SIM_SPAWN_SHAPES.includes(p.spawnShape) ? p.spawnShape : 'circle';
        defaults.radius = Math.max(1, p.spawnRadius);
        defaults.angle = Number.isFinite(p.spawnAngle) ? p.spawnAngle : 0;
        defaults.jitter = Math.max(0, Math.min(1, p.spawnJitter));
      }
      return defaults;
    }
    if (kind === 'point') {
      const defaults = {
        color,
        strength: Math.max(0, p.simPointStrength),
        radius: Math.max(1, p.simPointRadius),
      };
      if (target?.type === 'repel') defaults.hardness = 1;
      return defaults;
    }
    if (kind === 'path') {
      return {
        color,
        strength: _normalizeSimulationPathStrength(DEFAULT_PATH_STRENGTH),
        radius: Math.max(1, DEFAULT_PATH_RADIUS),
        influenceRadius: Math.max(1, DEFAULT_PATH_RADIUS),
        speed: _normalizeSimulationPathSpeed(DEFAULT_SIM_PATH_SPEED),
        pathType: 'standard',
        direction: 'forward',
        closed: false,
      };
    }
    if (kind === 'edge') {
      return {
        strength: Math.max(0, p.simEdgeForce),
        radius: Math.max(0, p.simEdgeRadius),
      };
    }
    if (kind === 'pheromonePath') {
      return {
        radius: Math.max(1, p.simPheroPaintRadius),
        intensity: Math.max(0, Math.min(1, p.simPheroPaintStrength)),
      };
    }
    return {};
  }

  _applySimulationItemCurrentDefaults(entry, fields = null, p = this.getP()) {
    if (!entry?.target) return [];
    const defaults = this._getSimulationItemDefaultFields(entry.kind, entry.target, p);
    const nextFields = Array.isArray(fields) && fields.length
      ? fields.filter(field => Object.prototype.hasOwnProperty.call(defaults, field))
      : Object.keys(defaults);
    nextFields.forEach(field => {
      entry.target[field] = defaults[field];
    });
    return nextFields;
  }

  _getSimulationSpawnCenter(brush = this.activeBrush) {
    const allSpawns = this._ensureSimulationSpawns(brush);
    const spawns = allSpawns.filter(spawn => spawn.enabled !== false);
    let activeSpawns = spawns.length ? spawns : allSpawns;
    if (brush === 'motionPath' && Array.isArray(this.simulation.runtimeStrokeStarts) && this.simulation.runtimeStrokeStarts.length) {
      activeSpawns = activeSpawns.concat(this.simulation.runtimeStrokeStarts);
    }
    if (!activeSpawns.length) return { x: this.W * 0.5, y: this.H * 0.5 };
    let sx = 0;
    let sy = 0;
    for (const spawn of activeSpawns) {
      sx += spawn.x;
      sy += spawn.y;
    }
    return { x: sx / activeSpawns.length, y: sy / activeSpawns.length };
  }

  _getSimulationGuideFollowTargets(brush = this.activeBrush, p = this.getP(), advancePaths = false, elapsed = 0) {
    const data = this._getSimulationBrushData(brush);
    if (!data) return [];
    const targets = [];

    for (const pathItem of data.paths || []) {
      if (pathItem?.enabled === false || !pathItem?.points?.length) continue;
      const currentDistance = Number.isFinite(pathItem.travelDistance) ? pathItem.travelDistance : 0;
      let targetDistance = currentDistance;
      if (advancePaths) {
        const sample = this._getSimulationPathSample(pathItem, currentDistance, p);
        const speed = sample?.speed ?? _normalizeSimulationPathSpeed(pathItem?.speed);
        targetDistance = currentDistance + ((elapsed / 1000) * p.simPathSpeed * p.simSpeed * speed);
        if (targetDistance >= PATH_DISTANCE_WRAP_THRESHOLD) targetDistance %= PATH_DISTANCE_WRAP_THRESHOLD;
        pathItem.travelDistance = targetDistance;
      }
      const target = this._getAnimatedSimulationPathTarget(pathItem, p, targetDistance);
      if (!target?.config || !Number.isFinite(target.config.strength) || target.config.strength <= 0) continue;
      targets.push({ x: target.x, y: target.y, weight: target.config.strength });
    }

    return targets;
  }


  _getSimulationForceVectorAt(x, y, p = this.getP(), { brush = this.activeBrush, includePaths = true, advancePaths = false, elapsed = 0 } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
    const data = this._getSimulationBrushData(brush);
    if (!data) return { x: 0, y: 0 };
    let fx = 0;
    let fy = 0;
    const speedScale = Math.max(0.1, p.simSpeed || 1);
    for (const point of data.points || []) {
      if (point?.enabled === false) continue;
      const config = this._resolveSimulationPointConfig(point, p);
      const dx = point.x - x;
      const dy = point.y - y;
      const d = Math.hypot(dx, dy);
      const sign = point.type === 'repel' ? -1 : 1;
      const outerRadius = sign < 0
        ? config.radius
        : Math.max(config.radius || 0, config.influenceRadius || config.radius || 0);
      if (d <= 0.0001 || d > outerRadius) continue;
      let shaped = 0;
      if (sign < 0) {
        const falloff = 1 - d / Math.max(config.radius, 1);
        shaped = Math.pow(Math.max(0, falloff), Math.max(DEFAULT_SIM_HARDNESS, config.hardness || 1));
      } else if (d <= config.radius) {
        shaped = 1 - d / Math.max(config.radius, 1);
      } else {
        shaped = _pathInfluenceFalloff(d, config.radius, outerRadius);
      }
      const pull = config.strength * speedScale * shaped * 0.85 * sign;
      fx += (dx / d) * pull;
      fy += (dy / d) * pull;
    }
    if (includePaths) {
      for (const pathItem of data.paths || []) {
        if (pathItem?.enabled === false || !pathItem?.points?.length) continue;
        const traveled = Number.isFinite(pathItem.travelDistance) ? pathItem.travelDistance : 0;
        let nextDistance = traveled;
        if (advancePaths) {
          const sample = this._getSimulationPathSample(pathItem, traveled, p);
          const speed = sample?.speed ?? _normalizeSimulationPathSpeed(pathItem?.speed);
          nextDistance = traveled + ((elapsed / 1000) * p.simPathSpeed * p.simSpeed * speed);
          if (nextDistance >= PATH_DISTANCE_WRAP_THRESHOLD) nextDistance %= PATH_DISTANCE_WRAP_THRESHOLD;
          pathItem.travelDistance = nextDistance;
        }
        const target = this._getAnimatedSimulationPathTarget(pathItem, p, nextDistance);
        if (!target?.config) continue;
        const dx = target.x - x;
        const dy = target.y - y;
        const d = Math.hypot(dx, dy);
        const influenceRadius = Math.max(target.config.radius || 0, target.config.influenceRadius || 0);
        if (d <= 0.0001 || d > influenceRadius) continue;
        const falloff = _pathInfluenceFalloff(d, target.config.radius, influenceRadius);
        const pull = target.config.strength * speedScale * falloff;
        fx += (dx / d) * pull;
        fy += (dy / d) * pull;
      }
    }
    return { x: fx, y: fy };
  }

  _collectSimulationStrokeStartSpawns(brush = this.activeBrush, p = this.getP()) {
    if (brush !== 'motionPath') return [];
    const data = this._getSimulationBrushData(brush);
    if (!data) return [];
    const starts = [];
    for (const pathItem of data.paths || []) {
      if (pathItem?.enabled === false) continue;
      if (_normalizeSimulationPathType(pathItem?.pathType) !== 'stroke') continue;
      const sample = this._getSimulationPathSample(pathItem, 0, p);
      if (!sample) continue;
      starts.push({ id: `stroke-start-${pathItem.id}`, x: sample.x, y: sample.y, enabled: true });
    }
    return starts;
  }

  _activateLeftPanelTab(viewName) {
    const leftPanel = document.getElementById('leftPanel');
    const leftTabs = document.getElementById('leftPanelTabs');
    const tab = leftTabs?.querySelector(`.panel-tab[data-panel-view="${viewName}"]`);
    const view = leftPanel?.querySelector(`.panel-view[data-panel-view="${viewName}"]`);
    if (!leftPanel || !leftTabs || !tab || !view) return;
    leftTabs.querySelectorAll('.panel-tab').forEach(button => button.classList.remove('active'));
    leftPanel.querySelectorAll(':scope > .panel-view').forEach(panelView => panelView.classList.remove('active'));
    tab.classList.add('active');
    view.classList.add('active');
    leftPanel.classList.add('open');
    document.getElementById('layersToggle')?.classList.add('active');
    this._updateTabVisibility();
  }

  _setSimulationSelection(selection, { focusDrawer = false } = {}) {
    this._simFormatMenuUi.activePopover = null;
    this.simulation.selected = selection
      ? {
          brush: this.activeBrush,
          collection: selection.collection,
          kind: selection.kind,
          id: selection.target?.id ?? selection.id,
        }
      : null;
    const distributeModal = document.getElementById('simDistributePointsModal');
    if (distributeModal?.classList.contains('open')) {
      const pathId = Number(distributeModal.dataset.pathId || 0);
      const selectedId = this.simulation.selected?.kind === 'path' ? this.simulation.selected.id : 0;
      if (!selectedId || selectedId !== pathId) this._closeSimulationDistributeDialog();
    }
    if (focusDrawer && selection) {
      this._activateLeftPanelTab('guides');
    }
    this._renderSimulationInspector();
    this._syncSimulationActionButtons();
  }

  _clampSimulationFormatMenuPosition(left, top, width = 0, height = 0) {
    const topbarHeight = document.getElementById('topbarWrap')?.offsetHeight || 44;
    const statusHeight = document.getElementById('status')?.offsetHeight || 24;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const minTop = topbarHeight + 8;
    const maxTop = Math.max(minTop, window.innerHeight - statusHeight - height - 8);
    return {
      left: _clamp(left, 8, maxLeft),
      top: _clamp(top, minTop, maxTop),
    };
  }

  _getSimulationFormatMenuDockPosition(width = 0, height = 0) {
    const topbarHeight = document.getElementById('topbarWrap')?.offsetHeight || 44;
    return this._clampSimulationFormatMenuPosition(8, topbarHeight + 8, width, height);
  }

  _applySimulationFormatMenuPosition() {
    const panel = document.getElementById('simFormatMenu');
    if (!panel) return;
    if (this._simFormatMenuUi.docked && panel.classList.contains('open')) {
      const pos = this._getSimulationFormatMenuDockPosition(panel.offsetWidth || 0, panel.offsetHeight || 0);
      this._simFormatMenuUi.position = pos;
      panel.classList.add('docked');
      panel.style.left = `${Math.round(pos.left)}px`;
      panel.style.top = `${Math.round(pos.top)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      this._positionSimulationFormatMenuPopovers();
      return;
    }
    panel.classList.remove('docked');
    if (!this._simFormatMenuUi.position) {
      if (!panel.classList.contains('open')) {
        panel.style.left = '';
        panel.style.top = '';
        panel.style.right = '';
        panel.style.bottom = '';
        return;
      }
      const rect = panel.getBoundingClientRect();
      this._simFormatMenuUi.position = this._clampSimulationFormatMenuPosition(
        rect.left,
        rect.top,
        rect.width || panel.offsetWidth || 0,
        rect.height || panel.offsetHeight || 0,
      );
    }
    const pos = this._clampSimulationFormatMenuPosition(
      this._simFormatMenuUi.position.left,
      this._simFormatMenuUi.position.top,
      panel.offsetWidth || 0,
      panel.offsetHeight || 0,
    );
    this._simFormatMenuUi.position = pos;
    panel.style.left = `${Math.round(pos.left)}px`;
    panel.style.top = `${Math.round(pos.top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    this._positionSimulationFormatMenuPopovers();
  }

  _positionSimulationFormatMenuPopovers() {
    const panel = document.getElementById('simFormatMenu');
    if (!panel?.classList.contains('open')) return;
    const topbarHeight = document.getElementById('topbarWrap')?.offsetHeight || 44;
    const statusHeight = document.getElementById('status')?.offsetHeight || 24;
    const canvasTop = topbarHeight;
    const canvasBottom = window.innerHeight - statusHeight;
    panel.querySelectorAll('[data-sim-format-popover]').forEach(popover => {
      popover.classList.remove('above');
      if (!popover.classList.contains('open')) return;
      const chip = popover.closest('[data-sim-format-chip]');
      if (!chip) return;
      const chipRect = chip.getBoundingClientRect();
      const popoverHeight = popover.offsetHeight || 0;
      const gap = 8;
      const wouldOverflowBelow = (chipRect.bottom + gap + popoverHeight) > canvasBottom;
      const fitsAbove = (chipRect.top - gap - popoverHeight) >= canvasTop;
      if (wouldOverflowBelow && fitsAbove) popover.classList.add('above');
    });
  }

  _toggleSimulationFormatMenuPopover(key) {
    this._simFormatMenuUi.activePopover = this._simFormatMenuUi.activePopover === key ? null : key;
    this._renderSimulationInspector();
  }

  _toggleSimulationFormatMenuDock(force) {
    const next = typeof force === 'boolean' ? force : !this._simFormatMenuUi.docked;
    this._simFormatMenuUi.docked = next;
    if (next) {
      this._simFormatMenuUi.dragPointerId = null;
      this._simFormatMenuUi.position = null;
    }
    this._applySimulationFormatMenuPosition();
    this._renderSimulationInspector();
  }

  _closeSimulationFormatMenuPopover({ rerender = true } = {}) {
    if (!this._simFormatMenuUi.activePopover) return;
    this._simFormatMenuUi.activePopover = null;
    if (rerender) this._renderSimulationInspector();
  }

  _handleSimulationFormatMenuPointerDown(event) {
    const panel = document.getElementById('simFormatMenu');
    if (!panel?.classList.contains('open')) return;
    if (this._simFormatMenuUi.docked) return;
    if (event.button !== 0) return;
    if (event.target.closest('input,button,select,option,[data-sim-format-popover]')) return;
    const rect = panel.getBoundingClientRect();
    this._simFormatMenuUi.dragPointerId = event.pointerId;
    this._simFormatMenuUi.dragOffsetX = event.clientX - rect.left;
    this._simFormatMenuUi.dragOffsetY = event.clientY - rect.top;
    this._simFormatMenuUi.position = { left: rect.left, top: rect.top };
    panel.setPointerCapture?.(event.pointerId);
    panel.classList.add('dragging');
  }

  _handleSimulationFormatMenuPointerMove(event) {
    if (this._simFormatMenuUi.dragPointerId !== event.pointerId) return;
    event.preventDefault();
    this._simFormatMenuUi.position = this._clampSimulationFormatMenuPosition(
      event.clientX - this._simFormatMenuUi.dragOffsetX,
      event.clientY - this._simFormatMenuUi.dragOffsetY,
      document.getElementById('simFormatMenu')?.offsetWidth || 0,
      document.getElementById('simFormatMenu')?.offsetHeight || 0,
    );
    this._applySimulationFormatMenuPosition();
  }

  _handleSimulationFormatMenuPointerUp(event) {
    if (this._simFormatMenuUi.dragPointerId !== event.pointerId) return;
    const panel = document.getElementById('simFormatMenu');
    panel?.releasePointerCapture?.(event.pointerId);
    panel?.classList.remove('dragging');
    this._simFormatMenuUi.dragPointerId = null;
  }

  _handleSimulationFormatMenuGlobalPointerDown(event) {
    const activeKey = this._simFormatMenuUi.activePopover;
    if (!activeKey) return;
    if (event.target.closest('#simFormatMenu')) return;
    this._closeSimulationFormatMenuPopover();
  }

  _getSelectedSimulationEntry() {
    const sel = this.simulation.selected;
    if (!sel || sel.brush !== this.activeBrush) return null;
    const items = this._getSimulationCollection(sel.collection);
    const target = items.find(item => item.id === sel.id);
    return target ? { ...sel, target } : null;
  }

  _getHoveredSimulationEntry() {
    const hover = this.simulation.hovered;
    if (!hover || hover.brush !== this.activeBrush) return null;
    const items = this._getSimulationCollection(hover.collection);
    const target = items.find(item => item.id === hover.id);
    return target ? { ...hover, target } : null;
  }

  _setSimulationHover(selection) {
    const next = selection
      ? {
        brush: this.activeBrush,
        collection: selection.collection,
        kind: selection.kind,
        id: selection.target?.id ?? selection.id,
      }
      : null;
    const prev = this.simulation.hovered;
    if (
      (prev?.brush || null) === (next?.brush || null) &&
      (prev?.collection || null) === (next?.collection || null) &&
      (prev?.kind || null) === (next?.kind || null) &&
      (prev?.id || null) === (next?.id || null)
    ) {
      return false;
    }
    this.simulation.hovered = next;
    return true;
  }

  _getSimulationHoverSelectionFromHit(hit) {
    if (!hit?.target || !hit?.collection) return null;
    if (hit.kind === 'paramHandle') {
      return { collection: hit.collection, kind: hit.selectionKind || 'point', target: hit.target };
    }
    if (hit.kind === 'overlayAction') {
      return { collection: hit.collection, kind: hit.collection === 'spawns' ? 'spawn' : 'path', target: hit.target };
    }
    if (hit.kind === 'delete') {
      const kind = hit.anchorType === 'spawn'
        ? 'spawn'
        : hit.anchorType === 'edge'
          ? 'edge'
          : hit.anchorType === 'pheromonePath'
            ? 'pheromonePath'
            : hit.anchorType === 'path'
              ? 'path'
              : 'point';
      return { collection: hit.collection, kind, target: hit.target };
    }
    if (hit.kind === 'spawn' || hit.kind === 'point' || hit.kind === 'path' || hit.kind === 'edge' || hit.kind === 'pheromonePath') {
      return hit;
    }
    return null;
  }

  _getSimulationAnchor(item) {
    if (Array.isArray(item?.points) && item.points.length) {
      return item.points[Math.floor(item.points.length / 2)];
    }
    return item ? { x: item.x, y: item.y } : { x: this.W * 0.5, y: this.H * 0.5 };
  }

  _getSimulationDeleteAnchor(item, kind = '') {
    if (kind === 'spawn' && item?.mask?.bounds) {
      return {
        x: item.mask.bounds.maxX,
        y: item.mask.bounds.minY,
      };
    }
    return this._getSimulationAnchor(item);
  }

  _getSimulationGuideChromeKey(collection, target, suffix = 'delete') {
    return `${collection}:${target?.id ?? 'unknown'}:${suffix}`;
  }

  _getSimulationUiScale() {
    const zoom = Number.isFinite(this.viewZoom) && this.viewZoom > 0 ? this.viewZoom : 1;
    return _clamp(1 / zoom, 0.1, 4);
  }

  _getSimulationUiMetrics() {
    const scale = this._getSimulationUiScale();
    return {
      scale,
      dragDeadzone: SIM_DRAG_DEADZONE_PX * scale,
      pointHitRadius: SIM_POINT_HIT_RADIUS * scale,
      lineHitRadius: SIM_LINE_HIT_RADIUS * scale,
      deleteHitRadius: SIM_DELETE_HIT_RADIUS * scale,
      deleteBadgeOffset: SIM_DELETE_BADGE_OFFSET * scale,
      deleteBadgeRadius: SIM_DELETE_BADGE_RADIUS * scale,
      deleteBadgeFont: SIM_DELETE_BADGE_FONT * scale,
      paramHandleRadius: SIM_PARAM_HANDLE_RADIUS * scale,
      paramHitRadius: SIM_PARAM_HIT_RADIUS * scale,
      overlayActionHitRadius: SIM_OVERLAY_ACTION_HIT_RADIUS * scale,
      pointStrengthHandleOffset: SIM_POINT_STRENGTH_HANDLE_OFFSET * scale,
      pointStrengthHandleScale: SIM_POINT_STRENGTH_HANDLE_SCALE * scale,
      pathStartMarkerRadius: SIM_PATH_START_MARKER_RADIUS * scale,
      pathDirectionHandleOffset: SIM_PATH_DIRECTION_HANDLE_OFFSET * scale,
      pathDirectionArrowLength: SIM_PATH_DIRECTION_ARROW_LENGTH * scale,
      pathSpeedAddButtonWidth: SIM_PATH_SPEED_ADD_BUTTON_WIDTH * scale,
      pathSpeedAddButtonHeight: SIM_PATH_SPEED_ADD_BUTTON_HEIGHT * scale,
      pathSpeedDeleteOffset: SIM_PATH_SPEED_DELETE_OFFSET * scale,
      pathOverlayRowGap: SIM_PATH_OVERLAY_ROW_GAP * scale,
      pathOverlayStackGap: SIM_PATH_OVERLAY_STACK_GAP * scale,
      pathOverlaySafeMargin: SIM_PATH_OVERLAY_SAFE_MARGIN * scale,
      pathRadiusHandleOffset: SIM_PATH_RADIUS_HANDLE_OFFSET * scale,
      pathRadiusHandleScale: SIM_PATH_RADIUS_HANDLE_SCALE * scale,
      pathPositionHandleRadius: SIM_PATH_POSITION_HANDLE_RADIUS * scale,
      pathFormatButtonWidth: SIM_PATH_FORMAT_BUTTON_WIDTH * scale,
      pathFormatButtonHeight: SIM_PATH_FORMAT_BUTTON_HEIGHT * scale,
      pathSizeHandleOffset: SIM_PATH_SIZE_HANDLE_OFFSET * scale,
      pathToggleHandleOffset: SIM_PATH_TOGGLE_HANDLE_OFFSET * scale,
      pathSpeedHandleOffset: SIM_PATH_SPEED_HANDLE_OFFSET * scale,
      pathSpeedHandleScale: SIM_PATH_SPEED_HANDLE_SCALE * scale,
      pathStrengthHandleOffset: SIM_PATH_STRENGTH_HANDLE_OFFSET * scale,
      pathStrengthHandleScale: SIM_PATH_STRENGTH_HANDLE_SCALE * scale,
      pathOverlayToggleGap: SIM_PATH_OVERLAY_TOGGLE_GAP * scale,
      pathOverlayToggleSize: SIM_PATH_OVERLAY_TOGGLE_SIZE * scale,
      spawnFormatButtonOffsetY: SIM_SPAWN_FORMAT_BUTTON_OFFSET_Y * scale,
      spawnFormatButtonWidth: SIM_SPAWN_FORMAT_BUTTON_WIDTH * scale,
      spawnFormatButtonHeight: SIM_SPAWN_FORMAT_BUTTON_HEIGHT * scale,
    };
  }

  _getSimulationDeleteBadgeLayouts() {
    const data = this._getSimulationBrushData();
    if (!data) return new Map();
    const selected = this._getSelectedSimulationEntry();
    const hovered = this._getHoveredSimulationEntry();
    const ui = this._getSimulationUiMetrics();
    const entries = [];
    const pushEntry = (collection, kind, target) => {
      if (!target) return;
      const anchor = this._getSimulationDeleteAnchor(target, kind);
      const badge = this._getSimDeleteBadgePos(anchor.x, anchor.y);
      const key = this._getSimulationGuideChromeKey(collection, target);
      entries.push({
        key,
        collection,
        kind,
        target,
        trueX: badge.x,
        trueY: badge.y,
        x: badge.x,
        y: badge.y,
        visible:
          (selected?.collection === collection && selected?.id === target.id)
          || (hovered?.collection === collection && hovered?.id === target.id),
      });
    };

    for (const spawn of this._ensureSimulationSpawns()) pushEntry('spawns', 'spawn', spawn);
    for (const point of data.points || []) pushEntry('points', 'point', point);
    if (this._usesPathGuides()) {
      for (const pathItem of data.paths || []) pushEntry('paths', 'path', pathItem);
    }
    if (this.activeBrush === 'ant') {
      for (const edge of data.edges || []) pushEntry('edges', 'edge', edge);
      for (const trail of data.pheromonePaths || []) pushEntry('pheromonePaths', 'pheromonePath', trail);
    }

    const hoverKey = hovered ? this._getSimulationGuideChromeKey(hovered.collection, hovered.target) : '';
    const hoverEntry = hoverKey ? entries.find(entry => entry.key === hoverKey) : null;
    if (hoverEntry) {
      const clusterThreshold = Math.max(ui.deleteBadgeRadius * 3, 28 * ui.scale);
      const cluster = entries.filter(entry => Math.hypot(entry.trueX - hoverEntry.trueX, entry.trueY - hoverEntry.trueY) <= clusterThreshold);
      if (cluster.length > 1) {
        const spreadRadius = Math.max(ui.deleteBadgeRadius * 2.6, 26 * ui.scale);
        const neighbors = cluster.filter(entry => entry.key !== hoverEntry.key).sort((left, right) => left.key.localeCompare(right.key));
        neighbors.forEach((entry, index) => {
          const angle = (-Math.PI * 0.5) + ((Math.PI * 2 * index) / Math.max(1, neighbors.length));
          entry.x = hoverEntry.trueX + (Math.cos(angle) * spreadRadius);
          entry.y = hoverEntry.trueY + (Math.sin(angle) * spreadRadius);
          entry.visible = true;
        });
        hoverEntry.visible = true;
      }
    }

    const layouts = new Map();
    entries.forEach(entry => layouts.set(entry.key, entry));
    return layouts;
  }

  // Compute the clamped canvas position of a delete badge so it is always
  // fully visible within canvas bounds. Applies SIM_DELETE_BADGE_OFFSET from
  // the guide anchor and clamps to [SIM_DELETE_BADGE_RADIUS, W/H - SIM_DELETE_BADGE_RADIUS].
  _getSimDeleteBadgePos(anchorX, anchorY) {
    const ui = this._getSimulationUiMetrics();
    const bx = anchorX + ui.deleteBadgeOffset;
    const by = anchorY - ui.deleteBadgeOffset;
    return {
      x: Math.max(ui.deleteBadgeRadius, Math.min(this.W - ui.deleteBadgeRadius, bx)),
      y: Math.max(ui.deleteBadgeRadius, Math.min(this.H - ui.deleteBadgeRadius, by)),
    };
  }

  _normalizeSimulationSpawnMask(mask) {
    if (!mask || typeof mask !== 'object') return null;
    const width = Math.max(1, Math.round(mask.width || 0));
    const height = Math.max(1, Math.round(mask.height || 0));
    const cellSize = _clamp(
      Math.round(mask.cellSize || SIM_SPAWN_MASK_CELL_SIZE_MIN),
      SIM_SPAWN_MASK_CELL_SIZE_MIN,
      SIM_SPAWN_MASK_CELL_SIZE_MAX,
    );
    const alphaSource = Array.isArray(mask.alpha)
      ? mask.alpha
      : ArrayBuffer.isView(mask.alpha)
        ? Array.from(mask.alpha)
        : [];
    if (!width || !height || alphaSource.length < width * height) return null;
    const bounds = mask.bounds;
    if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
      return null;
    }
    return {
      width,
      height,
      cellSize,
      alpha: alphaSource.slice(0, width * height).map(value => _clamp(Math.round(value || 0), 0, 255)),
      bounds: {
        minX: bounds.minX,
        minY: bounds.minY,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
        maxX: bounds.minX + Math.max(1, bounds.width),
        maxY: bounds.minY + Math.max(1, bounds.height),
      },
      points: Array.isArray(mask.points)
        ? mask.points
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.radius))
            .map(point => ({ x: point.x, y: point.y, radius: Math.max(1, point.radius) }))
        : [],
      distribution: SIM_SPAWN_DISTRIBUTION_MODES.includes(mask.distribution) ? mask.distribution : 'uniform',
      noiseScale: _clampSimulationSpawnNoiseScale(mask.noiseScale),
    };
  }

  _createSimulationSpawnMaskFromStroke(stroke, { distribution = 'uniform', noiseScale = 1 } = {}) {
    if (!stroke || stroke.isEmpty()) return null;
    const rawBounds = stroke.getBounds(2);
    if (!rawBounds) return null;
    const maxDim = Math.max(rawBounds.width, rawBounds.height, 1);
    const cellSize = _clamp(
      Math.ceil(maxDim / SIM_SPAWN_MASK_MAX_DIM),
      SIM_SPAWN_MASK_CELL_SIZE_MIN,
      SIM_SPAWN_MASK_CELL_SIZE_MAX,
    );
    const width = Math.max(1, Math.ceil(rawBounds.width / cellSize));
    const height = Math.max(1, Math.ceil(rawBounds.height / cellSize));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1 / cellSize, 0, 0, 1 / cellSize, -rawBounds.minX / cellSize, -rawBounds.minY / cellSize);
    stroke.rasterize(ctx, { fillStyle: 'rgba(255,255,255,1)' });
    const imageData = ctx.getImageData(0, 0, width, height).data;
    const alpha = new Array(width * height);
    for (let index = 0; index < alpha.length; index++) {
      alpha[index] = imageData[(index * 4) + 3];
    }
    return {
      width,
      height,
      cellSize,
      alpha,
      bounds: {
        minX: rawBounds.minX,
        minY: rawBounds.minY,
        width: rawBounds.width,
        height: rawBounds.height,
        maxX: rawBounds.maxX,
        maxY: rawBounds.maxY,
      },
      points: stroke.points.map(point => ({ x: point.x, y: point.y, radius: point.radius })),
      distribution: SIM_SPAWN_DISTRIBUTION_MODES.includes(distribution) ? distribution : 'uniform',
      noiseScale: _clampSimulationSpawnNoiseScale(noiseScale),
    };
  }

  _getSimulationSpawnMaskAlpha(mask, x, y) {
    if (!mask?.alpha?.length || !mask.bounds) return 0;
    const localX = (x - mask.bounds.minX) / mask.cellSize;
    const localY = (y - mask.bounds.minY) / mask.cellSize;
    const ix = Math.floor(localX);
    const iy = Math.floor(localY);
    if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return 0;
    return mask.alpha[(iy * mask.width) + ix] || 0;
  }

  _sampleSimulationSpawnMask(mask, count) {
    if (!mask?.alpha?.length || !mask.bounds || count <= 0) return [];
    const weights = [];
    const cumulative = [];
    let totalWeight = 0;
    for (let index = 0; index < mask.alpha.length; index++) {
      const alpha = mask.alpha[index] || 0;
      if (alpha <= SIM_SPAWN_MASK_ALPHA_THRESHOLD) continue;
      const ix = index % mask.width;
      const iy = Math.floor(index / mask.width);
      const baseWeight = alpha / 255;
      let weight = 1;
      if (mask.distribution === 'density') {
        weight = baseWeight;
      } else if (mask.distribution === 'noise') {
        const noise = _simulationSpawnNoise(ix, iy, mask.noiseScale || 1);
        weight = baseWeight * (0.2 + noise * 0.8);
      }
      totalWeight += Math.max(0.0001, weight);
      weights.push(index);
      cumulative.push(totalWeight);
    }
    if (!weights.length) return [];
    const samples = [];
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
      const pick = Math.random() * totalWeight;
      let low = 0;
      let high = cumulative.length - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (pick <= cumulative[mid]) high = mid;
        else low = mid + 1;
      }
      const cellIndex = weights[low];
      const ix = cellIndex % mask.width;
      const iy = Math.floor(cellIndex / mask.width);
      samples.push({
        x: mask.bounds.minX + ((ix + Math.random()) * mask.cellSize),
        y: mask.bounds.minY + ((iy + Math.random()) * mask.cellSize),
      });
    }
    return samples;
  }

  _spawnSimulationAgents(sim, config, cx, cy) {
    if (!sim || !config) return { count: 0, startIndex: 0, endIndex: 0 };
    const beforeCount = sim.readAgents().count;
    if (config.mask) {
      const points = this._sampleSimulationSpawnMask(config.mask, config.count);
      for (const point of points) sim.spawnAgent(point.x, point.y);
      const afterCount = sim.readAgents().count;
      return {
        count: Math.max(0, afterCount - beforeCount),
        startIndex: beforeCount,
        endIndex: afterCount,
      };
    }
    sim.spawnBatch(cx, cy, config.count, config.shape, config.angle, config.jitter, config.radius);
    const afterCount = sim.readAgents().count;
    return {
      count: Math.max(0, afterCount - beforeCount),
      startIndex: beforeCount,
      endIndex: afterCount,
    };
  }

  _drawSimulationSpawnMaskPreview(ctx, mask, { fillStyle, strokeStyle, outlineOnly = false } = {}) {
    if (!mask?.bounds) return;
    ctx.save();
    ctx.fillStyle = fillStyle || 'rgba(255,255,255,0.12)';
    ctx.strokeStyle = strokeStyle || 'rgba(255,255,255,0.7)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (Array.isArray(mask.alpha) && mask.alpha.length === mask.width * mask.height) {
      const alphaAt = (ix, iy) => {
        if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return 0;
        return mask.alpha[(iy * mask.width) + ix] || 0;
      };
      for (let index = 0; index < mask.alpha.length; index++) {
        const alpha = mask.alpha[index] || 0;
        if (alpha <= SIM_SPAWN_MASK_ALPHA_THRESHOLD) continue;
        const ix = index % mask.width;
        const iy = Math.floor(index / mask.width);
        const cellX = mask.bounds.minX + (ix * mask.cellSize);
        const cellY = mask.bounds.minY + (iy * mask.cellSize);
        ctx.globalAlpha = Math.max(outlineOnly ? 0.42 : 0.18, alpha / 255);
        if (!outlineOnly) {
          ctx.fillRect(cellX, cellY, mask.cellSize, mask.cellSize);
          continue;
        }
        const boundary =
          alphaAt(ix - 1, iy) <= SIM_SPAWN_MASK_ALPHA_THRESHOLD ||
          alphaAt(ix + 1, iy) <= SIM_SPAWN_MASK_ALPHA_THRESHOLD ||
          alphaAt(ix, iy - 1) <= SIM_SPAWN_MASK_ALPHA_THRESHOLD ||
          alphaAt(ix, iy + 1) <= SIM_SPAWN_MASK_ALPHA_THRESHOLD;
        if (!boundary) continue;
        ctx.lineWidth = 1;
        ctx.strokeRect(cellX + 0.5, cellY + 0.5, Math.max(0, mask.cellSize - 1), Math.max(0, mask.cellSize - 1));
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(mask.bounds.minX, mask.bounds.minY, mask.bounds.width, mask.bounds.height);
    }
    const hasRasterMask = Array.isArray(mask.alpha) && mask.alpha.length === mask.width * mask.height;
    if (Array.isArray(mask.points) && mask.points.length && (!hasRasterMask || !outlineOnly)) {
      for (let index = 0; index < mask.points.length; index++) {
        const point = mask.points[index];
        ctx.beginPath();
        ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
        if (outlineOnly) {
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.fill();
        }
        if (index === 0) continue;
        const previous = mask.points[index - 1];
        ctx.beginPath();
        ctx.lineWidth = outlineOnly ? 1.5 : Math.max(previous.radius, point.radius) * 2;
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _getSimulationOverlayScratchContext() {
    if (!this._simulationOverlayScratch) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      this._simulationOverlayScratch = { canvas, ctx };
    }
    const { canvas, ctx } = this._simulationOverlayScratch;
    if (!ctx) return null;
    if (canvas.width !== this.W || canvas.height !== this.H) {
      canvas.width = this.W;
      canvas.height = this.H;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return { canvas, ctx };
  }

  _drawSimulationOverlayBand(ctx, alpha, drawBand) {
    if (!Number.isFinite(alpha) || alpha <= 0 || typeof drawBand !== 'function') return;
    const scratch = this._getSimulationOverlayScratchContext();
    if (!scratch?.ctx || !scratch.canvas) return;
    scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
    scratch.ctx.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
    drawBand(scratch.ctx);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(scratch.canvas, 0, 0);
    ctx.restore();
  }

  _getSimulationParameterHandles(entry, p = this.getP()) {
    if (!entry?.target) return [];
    const ui = this._getSimulationUiMetrics();
    const { kind, target } = entry;
    if (kind === 'spawn') {
      if (target.mask) return [];
      const config = this._resolveSimulationSpawnConfig(target, p);
      return _sanitizeSimulationHandles([{
        kind: 'paramHandle',
        handleType: 'radius',
        selectionKind: kind,
        field: 'radius',
        collection: entry.collection,
        target,
        x: target.x + Math.max(10 * ui.scale, config.radius),
        y: target.y,
      }]);
    }
    if (kind === 'point') {
      const config = this._resolveSimulationPointConfig(target, p);
      return _sanitizeSimulationHandles([
        {
          kind: 'paramHandle',
          handleType: 'radius',
          selectionKind: kind,
          field: 'radius',
          collection: entry.collection,
          target,
          x: target.x + Math.max(10 * ui.scale, config.radius),
          y: target.y,
        },
        {
          kind: 'paramHandle',
          handleType: 'strength',
          selectionKind: kind,
          field: 'strength',
          collection: entry.collection,
          target,
          x: target.x,
          y: target.y - (ui.pointStrengthHandleOffset + config.strength * ui.pointStrengthHandleScale),
        },
      ]);
    }
    if (kind === 'path') {
      const sample = this._getSimulationPathSample(target, 0, p);
      if (!sample) return [];
      const bounds = _getSimulationPathBounds(target.points);
      const directionSign = sample.config.direction === 'reverse' ? -1 : 1;
      const handles = [
        {
          kind: 'paramHandle',
          handleType: 'pathPosition',
          selectionKind: kind,
          field: 'points',
          collection: entry.collection,
          target,
          x: bounds?.centerX ?? sample.x,
          y: bounds?.centerY ?? sample.y,
          anchorX: bounds?.centerX ?? sample.x,
          anchorY: bounds?.centerY ?? sample.y,
        },
        {
          kind: 'paramHandle',
          handleType: 'pathStart',
          selectionKind: kind,
          field: 'startOffset',
          collection: entry.collection,
          target,
          anchorX: sample.x,
          anchorY: sample.y,
          x: sample.x,
          y: sample.y,
        },
        {
          kind: 'paramHandle',
          handleType: 'pathDirection',
          selectionKind: kind,
          field: 'direction',
          collection: entry.collection,
          target,
          anchorX: sample.x,
          anchorY: sample.y,
          x: sample.x + (sample.tangentX * ui.pathDirectionHandleOffset * directionSign),
          y: sample.y + (sample.tangentY * ui.pathDirectionHandleOffset * directionSign),
        },
      ];
      if (bounds) {
        handles.push({
          kind: 'paramHandle',
          handleType: 'pathScale',
          selectionKind: kind,
          field: 'primitiveRadius',
          collection: entry.collection,
          target,
          anchorX: bounds.centerX,
          anchorY: bounds.centerY,
          x: bounds.centerX + Math.max(12 * ui.scale, Math.max(bounds.width, bounds.height) * 0.5) + ui.pathSizeHandleOffset,
          y: bounds.centerY,
        });
        handles.push({
          kind: 'paramHandle',
          handleType: 'pathClosed',
          selectionKind: kind,
          field: 'closed',
          collection: entry.collection,
          target,
          anchorX: bounds.centerX,
          anchorY: bounds.centerY,
          x: bounds.centerX,
          y: bounds.minY - ui.pathToggleHandleOffset,
        });
      }
      if (Array.isArray(target.speedPoints) && sample.totalLength > 1e-6) {
        for (const speedPoint of target.speedPoints) {
          const pointSample = _samplePolylinePointAtDistance(sample.renderPoints, sample.totalLength * _clamp01(speedPoint.t), sample.config.closed);
          if (!pointSample) continue;
          const normalX = -pointSample.tangentY;
          const normalY = pointSample.tangentX;
          const offset = ui.pathSpeedHandleOffset + (_normalizeSimulationPathSpeed(speedPoint.speed) * ui.pathSpeedHandleScale);
          handles.push({
            kind: 'paramHandle',
            handleType: 'pathSpeed',
            selectionKind: kind,
            field: 'speedPoints',
            collection: entry.collection,
            target,
            speedPointId: speedPoint.id,
            anchorX: pointSample.x,
            anchorY: pointSample.y,
            x: pointSample.x + (normalX * offset),
            y: pointSample.y + (normalY * offset),
          });
        }
      }
      if (Array.isArray(target.radiusPoints) && sample.totalLength > 1e-6) {
        for (const radiusPoint of target.radiusPoints) {
          const pointSample = _samplePolylinePointAtDistance(sample.renderPoints, sample.totalLength * _clamp01(radiusPoint.t), sample.config.closed);
          if (!pointSample) continue;
          const normalX = -pointSample.tangentY;
          const normalY = pointSample.tangentX;
          const offset = ui.pathRadiusHandleOffset + (Math.max(1, radiusPoint.radius) * ui.pathRadiusHandleScale);
          handles.push({
            kind: 'paramHandle',
            handleType: 'pathRadius',
            selectionKind: kind,
            field: 'radiusPoints',
            collection: entry.collection,
            target,
            radiusPointId: radiusPoint.id,
            anchorX: pointSample.x,
            anchorY: pointSample.y,
            x: pointSample.x - (normalX * offset),
            y: pointSample.y - (normalY * offset),
          });
        }
      }
      if (Array.isArray(target.strengthPoints) && sample.totalLength > 1e-6) {
        for (const strengthPoint of target.strengthPoints) {
          const pointSample = _samplePolylinePointAtDistance(sample.renderPoints, sample.totalLength * _clamp01(strengthPoint.t), sample.config.closed);
          if (!pointSample) continue;
          // Use right normal (opposite side from speed/radius handles)
          const normalX = pointSample.tangentY;
          const normalY = -pointSample.tangentX;
          const s = _normalizeSimulationPathStrength(strengthPoint.strength);
          const offset = ui.pathStrengthHandleOffset + (s * ui.pathStrengthHandleScale);
          handles.push({
            kind: 'paramHandle',
            handleType: 'pathStrength',
            selectionKind: kind,
            field: 'strengthPoints',
            collection: entry.collection,
            target,
            strengthPointId: strengthPoint.id,
            anchorX: pointSample.x,
            anchorY: pointSample.y,
            x: pointSample.x + (normalX * offset),
            y: pointSample.y + (normalY * offset),
          });
        }
      }
      return _sanitizeSimulationHandles(handles);
    }
    if (kind === 'edge' || kind === 'pheromonePath') {
      const points = Array.isArray(target.points) ? target.points : [];
      const origin = _samplePolylinePointAtDistance(points, 0, false);
      if (!origin || origin.totalLength <= 1e-6) return [];
      const sample = _samplePolylinePointAtDistance(points, origin.totalLength * 0.5, false);
      if (!sample) return [];
      const normalX = -sample.tangentY;
      const normalY = sample.tangentX;
      if (kind === 'edge') {
        const config = this._resolveSimulationEdgeConfig(target, p);
        const radiusOffset = ui.pathRadiusHandleOffset + (Math.max(0, config.radius) * ui.pathRadiusHandleScale);
        const strengthOffset = ui.pathStrengthHandleOffset + (Math.max(0, config.strength) * ui.pathStrengthHandleScale);
        return _sanitizeSimulationHandles([
          {
            kind: 'paramHandle',
            handleType: 'edgeRadius',
            selectionKind: kind,
            field: 'radius',
            collection: entry.collection,
            target,
            anchorX: sample.x,
            anchorY: sample.y,
            normalX: -normalX,
            normalY: -normalY,
            x: sample.x - (normalX * radiusOffset),
            y: sample.y - (normalY * radiusOffset),
          },
          {
            kind: 'paramHandle',
            handleType: 'edgeStrength',
            selectionKind: kind,
            field: 'strength',
            collection: entry.collection,
            target,
            anchorX: sample.x,
            anchorY: sample.y,
            normalX,
            normalY,
            x: sample.x + (normalX * strengthOffset),
            y: sample.y + (normalY * strengthOffset),
          },
        ]);
      }
      const config = this._resolveSimulationPheromoneConfig(target, p);
      const radiusOffset = ui.pathRadiusHandleOffset + (Math.max(1, config.radius) * ui.pathRadiusHandleScale);
      const intensityOffset = ui.pathStrengthHandleOffset + (Math.max(0, config.intensity) * ui.pathStrengthHandleScale);
      return _sanitizeSimulationHandles([
        {
          kind: 'paramHandle',
          handleType: 'pheromoneRadius',
          selectionKind: kind,
          field: 'radius',
          collection: entry.collection,
          target,
          anchorX: sample.x,
          anchorY: sample.y,
          normalX: -normalX,
          normalY: -normalY,
          x: sample.x - (normalX * radiusOffset),
          y: sample.y - (normalY * radiusOffset),
        },
        {
          kind: 'paramHandle',
          handleType: 'pheromoneIntensity',
          selectionKind: kind,
          field: 'intensity',
          collection: entry.collection,
          target,
          anchorX: sample.x,
          anchorY: sample.y,
          normalX,
          normalY,
          x: sample.x + (normalX * intensityOffset),
          y: sample.y + (normalY * intensityOffset),
        },
      ]);
    }
    return [];
  }

  _getSimulationSpawnOverlayControls(target, p = this.getP()) {
    if (!target) return { formatButton: null };
    const ui = this._getSimulationUiMetrics();
    const config = this._resolveSimulationSpawnConfig(target, p);
    const anchor = target.mask?.bounds
      ? {
          x: target.mask.bounds.minX + (target.mask.bounds.width * 0.5),
          y: target.mask.bounds.minY,
        }
      : {
          x: target.x,
        y: target.y - Math.max(14 * ui.scale, config.radius) - ui.spawnFormatButtonOffsetY,
        };
    return {
      formatButton: {
        kind: 'overlayAction',
        action: 'showFormat',
        target,
        collection: 'spawns',
        x: anchor.x,
        y: anchor.y,
        width: ui.spawnFormatButtonWidth,
        height: ui.spawnFormatButtonHeight,
      },
    };
  }

  _applySimulationParameterHandleDrag(handle, x, y) {
    if (!handle?.target) return;
    const ui = this._getSimulationUiMetrics();
    if (handle.handleType === 'radius') {
      const radius = Math.max(1, Math.min(300, Math.hypot(x - handle.target.x, y - handle.target.y)));
      handle.target.radius = radius;
      return;
    }
    if (handle.handleType === 'edgeRadius' || handle.handleType === 'pheromoneRadius') {
      const normalX = Number.isFinite(handle.normalX) ? handle.normalX : 1;
      const normalY = Number.isFinite(handle.normalY) ? handle.normalY : 0;
      const anchorX = Number.isFinite(handle.anchorX) ? handle.anchorX : 0;
      const anchorY = Number.isFinite(handle.anchorY) ? handle.anchorY : 0;
      const offset = Math.max(0, ((x - anchorX) * normalX) + ((y - anchorY) * normalY));
      const radius = Math.max(handle.handleType === 'edgeRadius' ? 0 : 1, (offset - ui.pathRadiusHandleOffset) / ui.pathRadiusHandleScale);
      handle.target.radius = Math.min(300, radius);
      return;
    }
    if (handle.handleType === 'pathPosition') {
      if (handle.dragLocked !== false) {
        const startX = Number.isFinite(handle.dragStartX) ? handle.dragStartX : handle.x;
        const startY = Number.isFinite(handle.dragStartY) ? handle.dragStartY : handle.y;
        if (Math.hypot(x - startX, y - startY) < ui.dragDeadzone) return;
        handle.dragLocked = false;
        handle.lastDragX = startX;
        handle.lastDragY = startY;
      }
      const lastX = Number.isFinite(handle.lastDragX) ? handle.lastDragX : handle.x;
      const lastY = Number.isFinite(handle.lastDragY) ? handle.lastDragY : handle.y;
      this._translateSimulationTarget(handle.target, x - lastX, y - lastY);
      handle.lastDragX = x;
      handle.lastDragY = y;
      handle.x = x;
      handle.y = y;
      return;
    }
    if (handle.handleType === 'strength') {
      const nextStrength = Math.max(0, Math.min(2, (handle.target.y - y - ui.pointStrengthHandleOffset) / ui.pointStrengthHandleScale));
      handle.target.strength = nextStrength;
      return;
    }
    if (handle.handleType === 'edgeStrength') {
      const normalX = Number.isFinite(handle.normalX) ? handle.normalX : 1;
      const normalY = Number.isFinite(handle.normalY) ? handle.normalY : 0;
      const anchorX = Number.isFinite(handle.anchorX) ? handle.anchorX : 0;
      const anchorY = Number.isFinite(handle.anchorY) ? handle.anchorY : 0;
      const offset = Math.max(0, ((x - anchorX) * normalX) + ((y - anchorY) * normalY));
      handle.target.strength = Math.max(0, Math.min(2, (offset - ui.pathStrengthHandleOffset) / ui.pathStrengthHandleScale));
      return;
    }
    if (handle.handleType === 'pheromoneIntensity') {
      const normalX = Number.isFinite(handle.normalX) ? handle.normalX : 1;
      const normalY = Number.isFinite(handle.normalY) ? handle.normalY : 0;
      const anchorX = Number.isFinite(handle.anchorX) ? handle.anchorX : 0;
      const anchorY = Number.isFinite(handle.anchorY) ? handle.anchorY : 0;
      const offset = Math.max(0, ((x - anchorX) * normalX) + ((y - anchorY) * normalY));
      handle.target.intensity = Math.max(0, Math.min(1, (offset - ui.pathStrengthHandleOffset) / ui.pathStrengthHandleScale));
      return;
    }
    if (handle.handleType === 'pathStart') {
      const config = this._resolveSimulationPathConfig(handle.target);
      const closest = _getClosestPolylineDistance(this._getSimulationPathRenderPoints(handle.target), x, y, config.closed);
      handle.target.startOffset = closest && closest.totalLength > 1e-6
        ? _clamp01(closest.distanceAlongPath / closest.totalLength)
        : 0;
      return;
    }
    if (handle.handleType === 'pathDirection') {
      const sample = this._getSimulationPathSample(handle.target, 0);
      if (!sample) return;
      const dx = x - sample.x;
      const dy = y - sample.y;
      const dot = (dx * sample.tangentX) + (dy * sample.tangentY);
      if (Math.abs(dot) > 0.5) handle.target.direction = dot < 0 ? 'reverse' : 'forward';
      return;
    }
    if (handle.handleType === 'pathScale') {
      const bounds = _getSimulationPathBounds(handle.target.points);
      if (!bounds) return;
      const centerX = bounds.centerX;
      const centerY = bounds.centerY;
      const currentRadius = Math.max(8, Math.max(bounds.width, bounds.height) * 0.5);
      const targetRadius = Math.max(8, Math.min(320, Math.hypot(x - centerX, y - centerY) - ui.pathSizeHandleOffset));
      const scale = targetRadius / currentRadius;
      for (const point of handle.target.points) {
        point.x = centerX + ((point.x - centerX) * scale);
        point.y = centerY + ((point.y - centerY) * scale);
      }
      if (_normalizeSimulationPathPrimitiveKind(handle.target.primitiveKind)) {
        handle.target.centerX = centerX;
        handle.target.centerY = centerY;
        handle.target.primitiveRadius = Math.max(8, (handle.target.primitiveRadius || currentRadius) * scale);
        handle.target.primitiveRadiusY = Math.max(8, (handle.target.primitiveRadiusY || currentRadius) * scale);
        _rebuildSimulationPathPrimitive(handle.target);
      }
      this._constrainSimulationTargetToBounds(handle.target);
      return;
    }
    if (handle.handleType === 'pathSpeed') {
      const speedPoint = Array.isArray(handle.target.speedPoints)
        ? handle.target.speedPoints.find(point => point.id === handle.speedPointId)
        : null;
      if (!speedPoint) return;
      const config = this._resolveSimulationPathConfig(handle.target);
      const renderPoints = this._getSimulationPathRenderPoints(handle.target);
      const closest = _getClosestPolylineDistance(renderPoints, x, y, config.closed);
      if (!closest || closest.totalLength <= 1e-6) return;
      const normalX = -closest.tangentY;
      const normalY = closest.tangentX;
      const offset = ((x - closest.x) * normalX) + ((y - closest.y) * normalY);
      speedPoint.t = _clamp01(closest.distanceAlongPath / closest.totalLength);
      speedPoint.speed = _normalizeSimulationPathSpeed((offset - ui.pathSpeedHandleOffset) / ui.pathSpeedHandleScale);
      handle.target.speedPoints.sort((left, right) => left.t - right.t);
      return;
    }
    if (handle.handleType === 'pathRadius') {
      const radiusPoint = Array.isArray(handle.target.radiusPoints)
        ? handle.target.radiusPoints.find(point => point.id === handle.radiusPointId)
        : null;
      if (!radiusPoint) return;
      const config = this._resolveSimulationPathConfig(handle.target);
      const renderPoints = this._getSimulationPathRenderPoints(handle.target);
      const closest = _getClosestPolylineDistance(renderPoints, x, y, config.closed);
      if (!closest || closest.totalLength <= 1e-6) return;
      const normalX = -closest.tangentY;
      const normalY = closest.tangentX;
      const offset = Math.abs(((x - closest.x) * normalX) + ((y - closest.y) * normalY));
      radiusPoint.t = _clamp01(closest.distanceAlongPath / closest.totalLength);
      radiusPoint.radius = Math.max(1, (offset - ui.pathRadiusHandleOffset) / ui.pathRadiusHandleScale);
      handle.target.radiusPoints.sort((left, right) => left.t - right.t);
    }
    if (handle.handleType === 'pathStrength') {
      const strengthPoint = Array.isArray(handle.target.strengthPoints)
        ? handle.target.strengthPoints.find(point => point.id === handle.strengthPointId)
        : null;
      if (!strengthPoint) return;
      const config = this._resolveSimulationPathConfig(handle.target);
      const renderPoints = this._getSimulationPathRenderPoints(handle.target);
      const closest = _getClosestPolylineDistance(renderPoints, x, y, config.closed);
      if (!closest || closest.totalLength <= 1e-6) return;
      const normalX = closest.tangentY;
      const normalY = -closest.tangentX;
      const offset = ((x - closest.x) * normalX) + ((y - closest.y) * normalY);
      strengthPoint.t = _clamp01(closest.distanceAlongPath / closest.totalLength);
      strengthPoint.strength = _normalizeSimulationPathStrength((offset - ui.pathStrengthHandleOffset) / ui.pathStrengthHandleScale);
      handle.target.strengthPoints.sort((left, right) => left.t - right.t);
      return;
    }
  }

  _getSimulationBoundsRect(p = this.getP()) {
    const margin = Math.max(0, p?.simBoundsMargin || 0);
    return {
      minX: -margin,
      minY: -margin,
      maxX: this.W + margin,
      maxY: this.H + margin,
    };
  }

  _clampSimulationPoint(x, y, p = this.getP()) {
    const bounds = this._getSimulationBoundsRect(p);
    return {
      x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
      y: Math.max(bounds.minY, Math.min(bounds.maxY, y)),
    };
  }

  _constrainSimulationTargetToBounds(target, p = this.getP()) {
    if (!target) return;
    const bounds = this._getSimulationBoundsRect(p);
    if (target.mask?.bounds) {
      const maskBounds = target.mask.bounds;
      let dx = 0;
      let dy = 0;
      if (maskBounds.minX < bounds.minX) dx = bounds.minX - maskBounds.minX;
      else if (maskBounds.maxX > bounds.maxX) dx = bounds.maxX - maskBounds.maxX;
      if (maskBounds.minY < bounds.minY) dy = bounds.minY - maskBounds.minY;
      else if (maskBounds.maxY > bounds.maxY) dy = bounds.maxY - maskBounds.maxY;
      if (dx || dy) {
        target.x += dx;
        target.y += dy;
        maskBounds.minX += dx;
        maskBounds.maxX += dx;
        maskBounds.minY += dy;
        maskBounds.maxY += dy;
        if (Array.isArray(target.mask.points)) {
          for (const point of target.mask.points) {
            point.x += dx;
            point.y += dy;
          }
        }
      }
      return;
    }
    if (Array.isArray(target.points) && target.points.length) {
      let minX = target.points[0].x;
      let minY = target.points[0].y;
      let maxX = target.points[0].x;
      let maxY = target.points[0].y;
      for (const pt of target.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
      let dx = 0;
      let dy = 0;
      if (minX < bounds.minX) dx = bounds.minX - minX;
      else if (maxX > bounds.maxX) dx = bounds.maxX - maxX;
      if (minY < bounds.minY) dy = bounds.minY - minY;
      else if (maxY > bounds.maxY) dy = bounds.maxY - maxY;
      if (dx || dy) {
        for (const pt of target.points) {
          pt.x += dx;
          pt.y += dy;
        }
        if (_normalizeSimulationPathPrimitiveKind(target.primitiveKind)) {
          target.centerX = (Number.isFinite(target.centerX) ? target.centerX : 0) + dx;
          target.centerY = (Number.isFinite(target.centerY) ? target.centerY : 0) + dy;
        }
      }
      return;
    }
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      const clamped = this._clampSimulationPoint(target.x, target.y, p);
      target.x = clamped.x;
      target.y = clamped.y;
    }
  }

  _constrainSimulationDataToBounds(brush = this.activeBrush, p = this.getP()) {
    const data = this._getSimulationBrushData(brush);
    if (!data) return;
    for (const spawn of data.spawns || []) this._constrainSimulationTargetToBounds(spawn, p);
    for (const point of data.points || []) this._constrainSimulationTargetToBounds(point, p);
    if (brush === 'boid') {
      for (const pathItem of data.paths || []) this._constrainSimulationTargetToBounds(pathItem, p);
    } else if (brush === 'ant') {
      for (const edge of data.edges || []) this._constrainSimulationTargetToBounds(edge, p);
      for (const trail of data.pheromonePaths || []) this._constrainSimulationTargetToBounds(trail, p);
    }
  }

  _translateSimulationTarget(target, dx, dy) {
    if (!target) return;
    if (target.mask?.bounds) {
      target.x += dx;
      target.y += dy;
      target.mask.bounds.minX += dx;
      target.mask.bounds.maxX += dx;
      target.mask.bounds.minY += dy;
      target.mask.bounds.maxY += dy;
      if (Array.isArray(target.mask.points)) {
        for (const point of target.mask.points) {
          point.x += dx;
          point.y += dy;
        }
      }
      this._constrainSimulationTargetToBounds(target);
      return;
    }
    if (Array.isArray(target.points)) {
      for (const pt of target.points) {
        pt.x += dx;
        pt.y += dy;
      }
      if (_normalizeSimulationPathPrimitiveKind(target.primitiveKind)) {
        target.centerX = (Number.isFinite(target.centerX) ? target.centerX : 0) + dx;
        target.centerY = (Number.isFinite(target.centerY) ? target.centerY : 0) + dy;
      }
      this._constrainSimulationTargetToBounds(target);
      return;
    }
    target.x += dx;
    target.y += dy;
    this._constrainSimulationTargetToBounds(target);
  }

  _createSimulationPathPrimitive(kind, centerX = this.W * 0.5, centerY = this.H * 0.5) {
    const primitiveKind = _normalizeSimulationPathPrimitiveKind(kind);
    if (!primitiveKind) return null;
    const primitiveRadius = primitiveKind === 'ellipse' ? SIM_PATH_PRIMITIVE_DEFAULT_RADIUS * 1.1 : SIM_PATH_PRIMITIVE_DEFAULT_RADIUS;
    const defaults = this._getSimulationItemDefaultFields('path');
    const entry = {
      id: this.simulation.nextId++,
      enabled: true,
      primitiveKind,
      centerX,
      centerY,
      primitiveRadius,
      primitiveRadiusY: primitiveKind === 'ellipse'
        ? primitiveRadius * SIM_PATH_PRIMITIVE_DEFAULT_ELLIPSE_RATIO
        : primitiveRadius,
      color: defaults.color,
      radius: defaults.radius,
      strength: defaults.strength,
      influenceRadius: defaults.influenceRadius,
      speed: defaults.speed,
      pathType: defaults.pathType,
      speedPoints: [],
      radiusPoints: [],
      strengthPoints: [],
      closed: true,
      startOffset: 0,
      direction: defaults.direction,
      travelDistance: 0,
      points: [],
    };
    _rebuildSimulationPathPrimitive(entry);
    this._constrainSimulationTargetToBounds(entry);
    return entry;
  }

  _addSimulationPathPrimitive(kind) {
    if (this.activeBrush !== 'boid') return;
    const data = this._getSimulationBrushData('boid');
    if (!data) return;
    const entry = this._createSimulationPathPrimitive(kind);
    if (!entry) return;
    this.pushUndo();
    data.paths.push(entry);
    this._setSimulationSelection({ collection: 'paths', kind: 'path', target: entry });
    this._renderSimulationInspector();
    this._maybeAutoSaveSession();
    this.showToast(`${kind[0].toUpperCase()}${kind.slice(1)} path added`);
  }

  _addSimulationPathSpeedPoint(target) {
    if (!target) return;
    if (!Array.isArray(target.speedPoints)) target.speedPoints = [];
    const t = _getNextSimulationPathControlPointT(target.speedPoints, !!target.closed);
    target.speedPoints.push({
      id: this.simulation.nextId++,
      t,
      speed: _normalizeSimulationPathSpeed(target.speed),
    });
    target.speedPoints.sort((left, right) => left.t - right.t);
  }

  _addSimulationPathRadiusPoint(target) {
    if (!target) return;
    if (!Array.isArray(target.radiusPoints)) target.radiusPoints = [];
    const t = _getNextSimulationPathControlPointT(target.radiusPoints, !!target.closed);
    target.radiusPoints.push({
      id: this.simulation.nextId++,
      t,
      radius: Math.max(1, Number.isFinite(target.radius) ? target.radius : DEFAULT_PATH_RADIUS),
    });
    target.radiusPoints.sort((left, right) => left.t - right.t);
  }

  _addSimulationPathStrengthPoint(target) {
    if (!target) return;
    if (!Array.isArray(target.strengthPoints)) target.strengthPoints = [];
    const t = _getNextSimulationPathControlPointT(target.strengthPoints, !!target.closed);
    target.strengthPoints.push({
      id: this.simulation.nextId++,
      t,
      strength: _normalizeSimulationPathStrength(Number.isFinite(target.strength) ? target.strength : DEFAULT_PATH_STRENGTH),
    });
    target.strengthPoints.sort((left, right) => left.t - right.t);
  }

  _removeSimulationPathStrengthPoint(target, strengthPointId) {
    if (!target || !Array.isArray(target.strengthPoints)) return;
    target.strengthPoints = target.strengthPoints.filter(point => point.id !== strengthPointId);
  }

  _getSimulationPathSpeedOverlayControls(target, p = this.getP()) {
    if (!target?.points?.length) return { addButton: null, radiusAddButton: null, strengthAddButton: null, formatButton: null, deleteButtons: [], radiusDeleteButtons: [], strengthDeleteButtons: [], speedToggleButton: null, radiusToggleButton: null, strengthToggleButton: null };
    const ui = this._getSimulationUiMetrics();
    const bounds = _getSimulationPathBounds(target.points);
    const allHandles = this._getSimulationParameterHandles({ kind: 'path', collection: 'paths', target }, p);
    const handles = allHandles
      .filter(handle => handle.handleType === 'pathSpeed' || handle.handleType === 'pathRadius' || handle.handleType === 'pathStrength');
    const deleteButtons = handles.filter(handle => handle.handleType === 'pathSpeed').map(handle => ({
      kind: 'overlayAction',
      action: 'deleteSpeedPoint',
      target,
      collection: 'paths',
      speedPointId: handle.speedPointId,
      x: handle.x + ui.pathSpeedDeleteOffset,
      y: handle.y - ui.pathSpeedDeleteOffset,
    }));
    const radiusDeleteButtons = handles.filter(handle => handle.handleType === 'pathRadius').map(handle => ({
      kind: 'overlayAction',
      action: 'deleteRadiusPoint',
      target,
      collection: 'paths',
      radiusPointId: handle.radiusPointId,
      x: handle.x + ui.pathSpeedDeleteOffset,
      y: handle.y - ui.pathSpeedDeleteOffset,
    }));
    const strengthDeleteButtons = handles.filter(handle => handle.handleType === 'pathStrength').map(handle => ({
      kind: 'overlayAction',
      action: 'deleteStrengthPoint',
      target,
      collection: 'paths',
      strengthPointId: handle.strengthPointId,
      x: handle.x + ui.pathSpeedDeleteOffset,
      y: handle.y - ui.pathSpeedDeleteOffset,
    }));
    const makeOverlayButton = (action, x, y, width, height) => ({
      kind: 'overlayAction',
      action,
      target,
      collection: 'paths',
      x,
      y,
      width,
      height,
    });
    let addButton = null;
    let radiusAddButton = null;
    let strengthAddButton = null;
    let formatButton = null;
    let speedToggleButton = null;
    let radiusToggleButton = null;
    let strengthToggleButton = null;
    if (bounds) {
      const maxChipWidth = Math.max(ui.pathSpeedAddButtonWidth, ui.pathFormatButtonWidth);
      const centerX = _clamp(
        bounds.centerX,
        (maxChipWidth * 0.5) + ui.pathOverlaySafeMargin,
        this.W - (maxChipWidth * 0.5) - ui.pathOverlaySafeMargin,
      );
      const occupiedTop = Math.min(
        bounds.minY,
        ...allHandles.map(handle => handle.y - ui.paramHitRadius),
        ...deleteButtons.map(button => button.y - ui.overlayActionHitRadius),
        ...radiusDeleteButtons.map(button => button.y - ui.overlayActionHitRadius),
        ...strengthDeleteButtons.map(button => button.y - ui.overlayActionHitRadius),
      );
      const occupiedBottom = Math.max(
        bounds.maxY,
        ...allHandles.map(handle => handle.y + ui.paramHitRadius),
        ...deleteButtons.map(button => button.y + ui.overlayActionHitRadius),
        ...radiusDeleteButtons.map(button => button.y + ui.overlayActionHitRadius),
        ...strengthDeleteButtons.map(button => button.y + ui.overlayActionHitRadius),
      );
      const stackHeight = (ui.pathFormatButtonHeight * 4) + (ui.pathOverlayRowGap * 3);
      const minTop = ui.pathOverlaySafeMargin;
      const maxTop = Math.max(minTop, this.H - ui.pathOverlaySafeMargin - stackHeight);
      const aboveTop = occupiedTop - ui.pathOverlayStackGap - stackHeight;
      const belowTop = occupiedBottom + ui.pathOverlayStackGap;
      const fitsAbove = aboveTop >= minTop;
      const fitsBelow = belowTop <= maxTop;
      const pathKey = `${this.activeBrush}:${target.id}`;
      const preferredSide = this._simPathOverlayUi.preferredSideByPath.get(pathKey);
      let placeBelow = false;
      if (preferredSide === 'below' && fitsBelow) {
        placeBelow = true;
      } else if (preferredSide === 'above' && fitsAbove) {
        placeBelow = false;
      } else if (fitsAbove) {
        placeBelow = false;
      } else if (fitsBelow) {
        placeBelow = true;
      } else {
        placeBelow = belowTop > maxTop && aboveTop >= belowTop ? false : belowTop <= aboveTop;
      }
      this._simPathOverlayUi.preferredSideByPath.set(pathKey, placeBelow ? 'below' : 'above');
      const stackTop = _clamp(placeBelow ? belowTop : aboveTop, minTop, maxTop);
      const rowCenters = [];
      let nextTop = stackTop;
      for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        rowCenters.push(nextTop + (ui.pathFormatButtonHeight * 0.5));
        nextTop += ui.pathFormatButtonHeight + ui.pathOverlayRowGap;
      }
      const toggleX = centerX + (ui.pathSpeedAddButtonWidth * 0.5) + ui.pathOverlayToggleGap + (ui.pathOverlayToggleSize * 0.5);
      if (placeBelow) {
        addButton = makeOverlayButton('addSpeedPoint', centerX, rowCenters[0], ui.pathSpeedAddButtonWidth, ui.pathSpeedAddButtonHeight);
        radiusAddButton = makeOverlayButton('addRadiusPoint', centerX, rowCenters[1], ui.pathSpeedAddButtonWidth, ui.pathSpeedAddButtonHeight);
        strengthAddButton = makeOverlayButton('addStrengthPoint', centerX, rowCenters[2], ui.pathSpeedAddButtonWidth, ui.pathSpeedAddButtonHeight);
        formatButton = makeOverlayButton('showFormat', centerX, rowCenters[3], ui.pathFormatButtonWidth, ui.pathFormatButtonHeight);
        speedToggleButton = makeOverlayButton('toggleSpeedHandles', toggleX, rowCenters[0], ui.pathOverlayToggleSize, ui.pathOverlayToggleSize);
        radiusToggleButton = makeOverlayButton('toggleRadiusHandles', toggleX, rowCenters[1], ui.pathOverlayToggleSize, ui.pathOverlayToggleSize);
        strengthToggleButton = makeOverlayButton('toggleStrengthHandles', toggleX, rowCenters[2], ui.pathOverlayToggleSize, ui.pathOverlayToggleSize);
      } else {
        formatButton = makeOverlayButton('showFormat', centerX, rowCenters[0], ui.pathFormatButtonWidth, ui.pathFormatButtonHeight);
        strengthAddButton = makeOverlayButton('addStrengthPoint', centerX, rowCenters[1], ui.pathSpeedAddButtonWidth, ui.pathSpeedAddButtonHeight);
        radiusAddButton = makeOverlayButton('addRadiusPoint', centerX, rowCenters[2], ui.pathSpeedAddButtonWidth, ui.pathSpeedAddButtonHeight);
        addButton = makeOverlayButton('addSpeedPoint', centerX, rowCenters[3], ui.pathSpeedAddButtonWidth, ui.pathSpeedAddButtonHeight);
        strengthToggleButton = makeOverlayButton('toggleStrengthHandles', toggleX, rowCenters[1], ui.pathOverlayToggleSize, ui.pathOverlayToggleSize);
        radiusToggleButton = makeOverlayButton('toggleRadiusHandles', toggleX, rowCenters[2], ui.pathOverlayToggleSize, ui.pathOverlayToggleSize);
        speedToggleButton = makeOverlayButton('toggleSpeedHandles', toggleX, rowCenters[3], ui.pathOverlayToggleSize, ui.pathOverlayToggleSize);
      }
    }
    return { addButton, radiusAddButton, strengthAddButton, formatButton, deleteButtons, radiusDeleteButtons, strengthDeleteButtons, speedToggleButton, radiusToggleButton, strengthToggleButton };
  }

  _removeSimulationPathSpeedPoint(target, speedPointId) {
    if (!target || !Array.isArray(target.speedPoints)) return;
    target.speedPoints = target.speedPoints.filter(point => point.id !== speedPointId);
  }

  _removeSimulationPathRadiusPoint(target, radiusPointId) {
    if (!target || !Array.isArray(target.radiusPoints)) return;
    target.radiusPoints = target.radiusPoints.filter(point => point.id !== radiusPointId);
  }

  _duplicateSelectedSimulationItem() {
    const entry = this._getSelectedSimulationEntry();
    if (!entry) return;
    const items = this._getSimulationCollection(entry.collection);
    const clone = this._cloneSimulationItemTarget(entry.target);
    if (!clone) return null;
    this.pushUndo();
    items.push(clone);
    this._setSimulationSelection({ collection: entry.collection, kind: entry.kind, target: clone });
    this._maybeAutoSaveSession();
    this.showToast('Simulation item duplicated');
    return clone;
  }

  _cloneSimulationItemTarget(sourceTarget, { offsetX = DUPLICATE_OFFSET, offsetY = DUPLICATE_OFFSET } = {}) {
    if (!sourceTarget) return null;
    const clone = _deepClone(sourceTarget);
    clone.id = this.simulation.nextId++;
    if (Array.isArray(clone.points)) {
      clone.points = clone.points.map(pt => ({ x: pt.x + offsetX, y: pt.y + offsetY }));
      if (_normalizeSimulationPathPrimitiveKind(clone.primitiveKind)) {
        clone.centerX = (Number.isFinite(clone.centerX) ? clone.centerX : this.W * 0.5) + offsetX;
        clone.centerY = (Number.isFinite(clone.centerY) ? clone.centerY : this.H * 0.5) + offsetY;
      }
      if (Array.isArray(clone.speedPoints)) {
        clone.speedPoints = clone.speedPoints.map(point => ({ ...point, id: this.simulation.nextId++ }));
      }
      if (Array.isArray(clone.radiusPoints)) {
        clone.radiusPoints = clone.radiusPoints.map(point => ({ ...point, id: this.simulation.nextId++ }));
      }
      if (Array.isArray(clone.strengthPoints)) {
        clone.strengthPoints = clone.strengthPoints.map(point => ({ ...point, id: this.simulation.nextId++ }));
      }
    } else if (clone.mask?.bounds) {
      clone.x += offsetX;
      clone.y += offsetY;
      clone.mask.bounds.minX += offsetX;
      clone.mask.bounds.maxX += offsetX;
      clone.mask.bounds.minY += offsetY;
      clone.mask.bounds.maxY += offsetY;
      if (Array.isArray(clone.mask.points)) {
        clone.mask.points = clone.mask.points.map(point => ({
          x: point.x + offsetX,
          y: point.y + offsetY,
          radius: point.radius,
        }));
      }
    } else {
      clone.x += offsetX;
      clone.y += offsetY;
    }
    this._constrainSimulationTargetToBounds(clone);
    return clone;
  }

  _copySelectedSimulationItem({ suppressToast = false } = {}) {
    const entry = this._getSelectedSimulationEntry();
    if (!entry) return false;
    this.simulation.clipboard = {
      brush: entry.brush,
      collection: entry.collection,
      kind: entry.kind,
      target: _deepClone(entry.target),
    };
    this._syncSimulationActionButtons();
    if (!suppressToast) this.showToast('Simulation item copied');
    return true;
  }

  _cutSelectedSimulationItem() {
    const entry = this._getSelectedSimulationEntry();
    if (!entry) return false;
    if (!this._copySelectedSimulationItem({ suppressToast: true })) return false;
    this._deleteSimulationItem(entry);
    if (entry.kind === 'spawn') this._queueSimulationPlaybackRefresh();
    this._syncSimulationActionButtons();
    this.showToast('Simulation item cut');
    return true;
  }

  _canPasteSimulationClipboard() {
    const clipboard = this.simulation.clipboard;
    if (!clipboard || clipboard.brush !== this.activeBrush) return false;
    return Array.isArray(this._getSimulationCollection(clipboard.collection, clipboard.brush));
  }

  _pasteSimulationClipboardItem() {
    const clipboard = this.simulation.clipboard;
    if (!clipboard) return false;
    if (clipboard.brush !== this.activeBrush) {
      this.showToast('Switch to the matching simulation brush before pasting');
      return false;
    }
    const items = this._getSimulationCollection(clipboard.collection, clipboard.brush);
    if (!Array.isArray(items)) return false;
    const clone = this._cloneSimulationItemTarget(clipboard.target);
    if (!clone) return false;
    this.pushUndo();
    items.push(clone);
    this._setSimulationSelection({ collection: clipboard.collection, kind: clipboard.kind, target: clone });
    this._maybeAutoSaveSession();
    if (clipboard.kind === 'spawn') this._queueSimulationPlaybackRefresh();
    this._syncSimulationActionButtons();
    this.showToast('Simulation item pasted');
    return true;
  }

  _syncSimulationActionButtons() {
    const selected = this._getSelectedSimulationEntry();
    const clipboard = this.simulation.clipboard;
    const canPaste = this._canPasteSimulationClipboard();
    ['simDrawerDuplicateBtn', 'simDrawerCopyBtn', 'simDrawerCutBtn'].forEach(id => {
      const button = document.getElementById(id);
      if (button) button.disabled = !selected;
    });
    const pasteBtn = document.getElementById('simDrawerPasteBtn');
    if (pasteBtn) {
      pasteBtn.disabled = !canPaste;
      pasteBtn.title = canPaste
        ? 'Paste simulation item'
        : clipboard && clipboard.brush !== this.activeBrush
          ? 'Switch to the matching simulation brush to paste'
          : 'Copy or cut a simulation item first';
    }
  }

  _openSimulationHelp() {
    document.getElementById('simHelpModal')?.classList.add('open');
  }

  _closeSimulationHelp() {
    document.getElementById('simHelpModal')?.classList.remove('open');
  }

  _openForceVizHelp() {
    document.getElementById('forceVizHelpModal')?.classList.add('open');
  }

  _closeForceVizHelp() {
    document.getElementById('forceVizHelpModal')?.classList.remove('open');
  }

  _toggleSimTopbarGuide() {
    this._openSimulationHelp();
  }

  _getSimulationDistributeDialogTarget() {
    const modal = document.getElementById('simDistributePointsModal');
    const pathId = Number(modal?.dataset.pathId || 0);
    if (!pathId) return null;
    return (this._getSimulationBrushData('boid')?.paths || []).find(pathItem => pathItem.id === pathId) || null;
  }

  _mapSimulationDistributionCurve(t, curve) {
    const value = _clamp01(t);
    if (curve === 'ease-in') return value ** 1.65;
    if (curve === 'ease-out') return 1 - ((1 - value) ** 1.65);
    return value;
  }

  _buildSimulationDistributedTs(count, distribution = 'uniform', curve = 'linear') {
    const total = Math.max(2, Math.min(20, Math.round(count || 2)));
    if (total === 2) return [0, 1];
    let values = [];
    if (distribution === 'random') {
      values = [0];
      for (let index = 1; index < total - 1; index++) {
        const raw = Math.sin((index + 1) * 12.9898 + total * 78.233) * 43758.5453;
        values.push(raw - Math.floor(raw));
      }
      values.push(1);
      values.sort((left, right) => left - right);
    } else if (distribution === 'gaussian') {
      const normalizer = Math.tanh(1.75);
      values = Array.from({ length: total }, (_, index) => {
        const base = index / (total - 1);
        const centered = (base * 2) - 1;
        return 0.5 + (Math.tanh(centered * 1.75) / (2 * normalizer));
      });
    } else {
      values = Array.from({ length: total }, (_, index) => index / (total - 1));
    }
    return values
      .map((value, index) => {
        if (index === 0) return 0;
        if (index === values.length - 1) return 1;
        return this._mapSimulationDistributionCurve(value, curve);
      })
      .sort((left, right) => left - right)
      .map(value => _clamp01(value));
  }

  _renderSimulationDistributeDialogPreview() {
    const preview = document.getElementById('simDistributePreview');
    const summary = document.getElementById('simDistributePreviewSummary');
    const meta = document.getElementById('simDistributePreviewMeta');
    const typeSelect = document.getElementById('simDistributePointType');
    const countInput = document.getElementById('simDistributePointCount');
    const modeSelect = document.getElementById('simDistributeMode');
    const curveSelect = document.getElementById('simDistributeCurve');
    const pathItem = this._getSimulationDistributeDialogTarget();
    if (!preview || !summary || !meta || !typeSelect || !countInput || !modeSelect || !curveSelect) return;
    const pointType = typeSelect.value === 'radius' ? 'radius' : 'speed';
    const count = Math.max(2, Math.min(20, Math.round(+countInput.value || 2)));
    countInput.value = String(count);
    const distribution = modeSelect.value || 'uniform';
    const curve = curveSelect.value || 'linear';
    const values = this._buildSimulationDistributedTs(count, distribution, curve);
    preview.innerHTML = values.map(t => `<span class="sim-distribute-preview-dot ${pointType === 'radius' ? 'radius' : ''}" style="left:${(t * 100).toFixed(4)}%;"></span>`).join('');
    summary.textContent = `${count} ${pointType} point${count === 1 ? '' : 's'}`;
    const existingCount = pathItem
      ? (pointType === 'radius' ? (pathItem.radiusPoints?.length || 0) : (pathItem.speedPoints?.length || 0))
      : 0;
    meta.textContent = pathItem
      ? `Apply will replace ${existingCount} existing ${pointType} point${existingCount === 1 ? '' : 's'} on the selected path.`
      : 'Select a path to distribute points.';
  }

  _openSimulationDistributeDialog(pointType = 'speed') {
    const entry = this._getSelectedSimulationEntry();
    if (!entry || entry.kind !== 'path') return;
    const modal = document.getElementById('simDistributePointsModal');
    const subtitle = document.getElementById('simDistributePointsSubtitle');
    const typeSelect = document.getElementById('simDistributePointType');
    const countInput = document.getElementById('simDistributePointCount');
    if (!modal || !subtitle || !typeSelect || !countInput) return;
    modal.dataset.pathId = String(entry.target.id);
    modal.classList.add('open');
    typeSelect.value = pointType === 'radius' ? 'radius' : 'speed';
    const existingCount = pointType === 'radius'
      ? Math.max(2, entry.target.radiusPoints?.length || 5)
      : Math.max(2, entry.target.speedPoints?.length || 5);
    countInput.value = String(Math.min(20, existingCount));
    subtitle.textContent = pointType === 'radius'
      ? 'Populate the selected path with radius points so thickness changes can be blocked in quickly.'
      : 'Populate the selected path with speed points so motion changes can be blocked in quickly.';
    this._renderSimulationDistributeDialogPreview();
  }

  _closeSimulationDistributeDialog() {
    const modal = document.getElementById('simDistributePointsModal');
    if (!modal) return;
    modal.classList.remove('open');
    delete modal.dataset.pathId;
  }

  _distributeSimulationPathPoints(pathItem, pointType, { count, distribution, curve }) {
    if (!pathItem) return;
    const values = this._buildSimulationDistributedTs(count, distribution, curve);
    const config = this._resolveSimulationPathConfig(pathItem);
    if (pointType === 'radius') {
      pathItem.radiusPoints = values.map(t => ({
        id: this.simulation.nextId++,
        t,
        radius: _getSimulationPathRadiusAt(pathItem, t, config.radius, !!pathItem.closed),
      }));
      return;
    }
    pathItem.speedPoints = values.map(t => ({
      id: this.simulation.nextId++,
      t,
      speed: _getSimulationPathSpeedAt(pathItem, t, config.speed, !!pathItem.closed),
    }));
  }

  _applySimulationDistributeDialog() {
    const pathItem = this._getSimulationDistributeDialogTarget();
    const typeSelect = document.getElementById('simDistributePointType');
    const countInput = document.getElementById('simDistributePointCount');
    const modeSelect = document.getElementById('simDistributeMode');
    const curveSelect = document.getElementById('simDistributeCurve');
    if (!pathItem || !typeSelect || !countInput || !modeSelect || !curveSelect) return;
    const pointType = typeSelect.value === 'radius' ? 'radius' : 'speed';
    this.pushUndo();
    this._distributeSimulationPathPoints(pathItem, pointType, {
      count: +countInput.value || 2,
      distribution: modeSelect.value || 'uniform',
      curve: curveSelect.value || 'linear',
    });
    this._renderSimulationInspector();
    this._maybeAutoSaveSession();
    this._closeSimulationDistributeDialog();
  }

  _maybeAutoSaveSession() {
    this._syncActiveSimulationSessionFromDraft();
    if (document.getElementById('autoSaveSession')?.checked) this.saveSession();
  }

  _queueSimulationInspectorRefresh() {
    if (this._simulationInspectorRefreshQueued) return;
    this._simulationInspectorRefreshQueued = true;
    const flush = () => {
      this._simulationInspectorRefreshQueued = false;
      this._renderSimulationInspector();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }

  _syncSimulationSessionDraftUi({ rerenderInspector = true } = {}) {
    this._syncActiveSimulationSessionFromDraft();
    this._syncSimulationSessionContextUi();
    if (rerenderInspector) this._queueSimulationInspectorRefresh();
  }

  _shouldRefreshSimulationPlaybackForSpawnFields(entry, fields = []) {
    if (!entry || entry.kind !== 'spawn' || !Array.isArray(fields) || !fields.length) return false;
    if (this._canLiveRefreshSimulationSpawnAppearance(entry, fields)) return false;
    return fields.some(field => SIM_SPAWN_RUNTIME_REFRESH_FIELDS.has(field));
  }

  _canLiveRefreshSimulationSpawnAppearance(entry, fields = []) {
    if (!entry || entry.kind !== 'spawn' || !Array.isArray(fields) || !fields.length) return false;
    if (!fields.every(field => SIM_SPAWN_APPEARANCE_FIELDS.has(field))) return false;
    if (!this.simulation.enabled || (!this.simulation.running && !this.simulation.paused)) return false;
    if (this._hasActiveMultiSessionPlayback()) return false;
    return typeof this.getCurrentBrush?.()?.refreshSimulationSpawnAppearance === 'function';
  }

  _syncLiveSimulationSpawnAppearance(entry, fields = []) {
    if (!this._canLiveRefreshSimulationSpawnAppearance(entry, fields)) return;
    const brush = this.getCurrentBrush();
    const p = this.getP();
    brush?.refreshSimulationSpawnAppearance?.(p);
  }

  _queueSimulationPlaybackRefresh({ preservePaused = true } = {}) {
    if ((!this.simulation.running && !this.simulation.paused) || this.simulation.starting) return;
    this._simulationPlaybackRefreshPreservePaused =
      !!this._simulationPlaybackRefreshPreservePaused || (!!preservePaused && !!this.simulation.paused);
    if (this._simulationPlaybackRefreshQueued) return;
    this._simulationPlaybackRefreshQueued = true;
    const flush = async () => {
      this._simulationPlaybackRefreshQueued = false;
      const shouldRestorePause = !!this._simulationPlaybackRefreshPreservePaused;
      this._simulationPlaybackRefreshPreservePaused = false;
      const wasRunning = this.simulation.running;
      const wasPaused = this.simulation.paused;
      if ((!wasRunning && !wasPaused) || this.simulation.starting || !this.simulation.enabled || !this._isMotionBrush()) return;
      this.stopSimulation(false);
      await this.startSimulation({ announce: false });
      if (!shouldRestorePause || !this.simulation.running) return;
      const pauseAfterRefresh = () => {
        if (!this.simulation.running) return;
        this.simulation.running = false;
        this.simulation.paused = true;
        this.isDrawing = false;
        this._syncSimulationUI();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(pauseAfterRefresh);
      else setTimeout(pauseAfterRefresh, 0);
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(flush);
    else setTimeout(flush, 0);
  }

  _captureSimulationSessionControlState() {
    const controls = {};
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return controls;
    sidebar.querySelectorAll('input[type="range"], input[type="checkbox"], select, input[type="number"]').forEach(el => {
      if (!el.id || SIM_SESSION_SIDEBAR_CONTROL_EXCLUDE_IDS.has(el.id)) return;
      controls[el.id] = el.type === 'checkbox' ? !!el.checked : el.value;
    });
    return _sanitizeSimulationSessionData(controls) || {};
  }

  _captureSimulationSessionParamSnapshot() {
    const params = this.getP();
    const snapshot = {};
    for (const [key, value] of Object.entries(params || {})) {
      const normalized = _sanitizeSimulationSessionData(value);
      if (normalized !== undefined) snapshot[key] = normalized;
    }
    return snapshot;
  }

  _getSimulationVarOverridesFromParamSnapshot(snapshot = {}, sessionBaseVars = this.simulation?.vars || {}) {
    const normalizedBaseVars = _normalizeSimulationVars(sessionBaseVars);
    return _normalizeSimulationVars({
      ...normalizedBaseVars,
      // Simulation seek is owned by the session override slider, not the
      // draw-mode sidebar seek control captured in the param snapshot.
      seek: Number.isFinite(normalizedBaseVars.seek) ? normalizedBaseVars.seek : DEFAULT_SIM_SEEK,
      cohesion: Number.isFinite(normalizedBaseVars.cohesion) ? normalizedBaseVars.cohesion : snapshot.cohesion,
      separation: Number.isFinite(normalizedBaseVars.separation) ? normalizedBaseVars.separation : snapshot.separation,
      alignment: Number.isFinite(normalizedBaseVars.alignment) ? normalizedBaseVars.alignment : snapshot.alignment,
      maxSpeed: Number.isFinite(normalizedBaseVars.maxSpeed) ? normalizedBaseVars.maxSpeed : snapshot.maxSpeed,
      damping: Number.isFinite(normalizedBaseVars.damping) ? normalizedBaseVars.damping : snapshot.damping,
      sensingEnabled: typeof normalizedBaseVars.sensingEnabled === 'boolean' ? normalizedBaseVars.sensingEnabled : snapshot.sensingEnabled,
      sensingMode: typeof normalizedBaseVars.sensingMode === 'string' ? normalizedBaseVars.sensingMode : snapshot.sensingMode,
      sensingChannel: typeof normalizedBaseVars.sensingChannel === 'string' ? normalizedBaseVars.sensingChannel : snapshot.sensingChannel,
      sensingStrength: Number.isFinite(normalizedBaseVars.sensingStrength) ? normalizedBaseVars.sensingStrength : snapshot.sensingStrength,
      sensingRadius: Number.isFinite(normalizedBaseVars.sensingRadius) ? normalizedBaseVars.sensingRadius : snapshot.sensingRadius,
      sensingFitRadius: Number.isFinite(normalizedBaseVars.sensingFitRadius) ? normalizedBaseVars.sensingFitRadius : snapshot.sensingFitRadius,
      sensingThreshold: Number.isFinite(normalizedBaseVars.sensingThreshold) ? normalizedBaseVars.sensingThreshold : snapshot.sensingThreshold,
      sensingSource: typeof normalizedBaseVars.sensingSource === 'string' ? normalizedBaseVars.sensingSource : snapshot.sensingSource,
      sensingUpdateFrames: Number.isFinite(normalizedBaseVars.sensingUpdateFrames) ? normalizedBaseVars.sensingUpdateFrames : snapshot.sensingUpdateFrames,
    });
  }

  _applySimulationSessionControlState(controlState, { sync = true } = {}) {
    if (!controlState || typeof controlState !== 'object') return false;
    let applied = false;
    for (const [id, value] of Object.entries(controlState)) {
      if (!id || SIM_SESSION_SIDEBAR_CONTROL_EXCLUDE_IDS.has(id)) continue;
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = value;
      applied = true;
    }
    if (!applied) return false;
    this._paramsDirty = true;
    if (sync) {
      syncUI(this);
      this._refreshSensingLayerSourceUi?.();
    }
    return applied;
  }

  _syncSimulationSessionSensingControls({ sync = true } = {}) {
    const vars = this.simulation?.vars || {};
    let applied = false;
    const assign = (id, value) => {
      if (value === undefined || value === null) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = String(value);
      applied = true;
    };
    if (typeof vars.sensingEnabled === 'boolean') assign('sensingEnabled', vars.sensingEnabled);
    if (typeof vars.sensingMode === 'string') assign('sensingMode', vars.sensingMode);
    if (typeof vars.sensingChannel === 'string') assign('sensingChannel', vars.sensingChannel);
    if (Number.isFinite(vars.sensingStrength)) assign('sensingStrength', Math.round(vars.sensingStrength * 100));
    if (Number.isFinite(vars.sensingRadius)) assign('sensingRadius', Math.round(vars.sensingRadius));
    if (Number.isFinite(vars.sensingFitRadius)) assign('sensingFitRadius', Math.round(vars.sensingFitRadius));
    if (Number.isFinite(vars.sensingThreshold)) assign('sensingThreshold', Math.round(vars.sensingThreshold * 100));
    if (typeof vars.sensingSource === 'string') {
      assign('sensingSource', vars.sensingSource);
      const sourceSelect = document.getElementById('sensingSource');
      if (sourceSelect) sourceSelect.dataset.prevValue = vars.sensingSource;
    }
    if (Number.isFinite(vars.sensingUpdateFrames)) {
      assign('sensingUpdateFrames', Math.max(1, Math.min(50, Math.round(vars.sensingUpdateFrames))));
    }
    if (!applied) return false;
    this._paramsDirty = true;
    if (sync && document.getElementById('sidebar')) syncUI(this);
    this._refreshSensingLayerSourceUi?.();
    return true;
  }

  _syncActiveSimulationSessionFromDraft() {
    const activeIndex = Number.isFinite(this.simulation.activeSessionIndex)
      ? Math.round(this.simulation.activeSessionIndex)
      : -1;
    const session = activeIndex >= 0 ? this.simulation.sessions[activeIndex] : null;
    if (!session) return null;
    const paramSnapshot = this._captureSimulationSessionParamSnapshot();
    const controlState = this._captureSimulationSessionControlState();
    this.simulation.vars = this._getSimulationVarOverridesFromParamSnapshot(paramSnapshot, {});
    const nextSession = {
      ...session,
      vars: _normalizeSimulationVars(this.simulation.vars),
      controlState,
      paramSnapshot,
      sensingSourceSelection: _normalizeSimulationSensingSourceSelection(this._serializeSensingSourceSelection()),
      brushData: _deepClone(this.simulation.brushData),
      savedPlayback: _normalizeSimulationSavedPlayback(this.simulation.savedPlayback),
      nextId: this.simulation.nextId,
    };
    this.simulation.sessions[activeIndex] = nextSession;
    return nextSession;
  }

  _applySimulationSessionToDraft(session) {
    if (!session) return false;
    const paramSnapshot = _sanitizeSimulationSessionData(session.paramSnapshot) || {};
    this.simulation.vars = _normalizeSimulationVars({
      ...this._getSimulationVarOverridesFromParamSnapshot(paramSnapshot, session.vars),
      ...session.vars,
    });
    this._restoreSensingSourceSelection(session.sensingSourceSelection);
    this._applySimulationSessionControlState(session.controlState, { sync: false });
    this._syncSimulationSessionSensingControls({ sync: false });
    this.simulation.brushData = _deepClone(session.brushData);
    this.simulation.savedPlayback = _normalizeSimulationSavedPlayback(session.savedPlayback);
    this._simulationSavedPlaybackCapture = null;
    if (Number.isFinite(session.nextId)) this.simulation.nextId = Math.max(1, Math.round(session.nextId));
    this.simulation.selected = null;
    this._normalizeSimulationData();
    this._constrainSimulationDataToBounds('boid');
    this._constrainSimulationDataToBounds('ant');
    this._ensureSimulationSpawns();
    this._paramsDirty = true;
    syncUI(this);
    return true;
  }

  _newSimulationSession() {
    if (this.simulation.running || this.simulation.paused) {
      this.stopSimulation(false);
      this.showToast('Simulation stopped before creating a new draft');
    }
    const paramSnapshot = this._captureSimulationSessionParamSnapshot();
    this._syncActiveSimulationSessionFromDraft();
    // New sessions snapshot the currently active settings fresh — pass an empty
    // base so leftover vars overrides from the previous draft (just captured
    // above by _syncActiveSimulationSessionFromDraft) don't stick around.
    this.simulation.vars = this._getSimulationVarOverridesFromParamSnapshot(paramSnapshot, {});
    // New simulation sessions always start from the sim seek default instead of
    // inheriting the current draw-mode seek slider value.
    this.simulation.vars.seek = DEFAULT_SIM_SEEK;
    this.simulation.brushData = {
      boid: { spawns: [], points: [], paths: [] },
      ant: { spawns: [], points: [], edges: [], pheromonePaths: [] },
    };
    this.simulation.savedPlayback = null;
    this._simulationSavedPlaybackCapture = null;
    this.simulation.activeSessionIndex = -1;
    this.simulation.nextId = 1;
    this.simulation.selected = null;
    this.simulation.drawingBlob = null;
    this._ensureSimulationSpawns();
    this._renderSimulationInspector();
    this._syncSimulationSessionContextUi();
    this.saveSession();
    this.showToast('New simulation session started');
  }

  _saveSimulationSession() {
    this._syncActiveSimulationSessionFromDraft();
    this._normalizeSimulationSessionBindings();
    const activeIndex = this.simulation.activeSessionIndex;
    const existingSession = activeIndex >= 0 ? this.simulation.sessions[activeIndex] : null;
    const defaultName = existingSession?.name || `Session ${this.simulation.sessions.length + 1}`;
    const rawName = window.prompt(existingSession ? 'Update this simulation session:' : 'Name for this simulation session:', defaultName);
    if (!rawName) return;
    const name = rawName.trim().slice(0, MAX_SIM_SESSION_NAME_LENGTH) || defaultName;
    const paramSnapshot = this._captureSimulationSessionParamSnapshot();
    const controlState = this._captureSimulationSessionControlState();
    const vars = this._getSimulationVarOverridesFromParamSnapshot(paramSnapshot);
    this.simulation.vars = vars;
    const nextSession = {
      id: existingSession?.id || this._createSimulationSessionId(),
      name,
      savedAt: Date.now(),
      vars,
      controlState,
      paramSnapshot,
      sensingSourceSelection: _normalizeSimulationSensingSourceSelection(this._serializeSensingSourceSelection()),
      brushData: _deepClone(this.simulation.brushData),
      savedPlayback: _normalizeSimulationSavedPlayback(this.simulation.savedPlayback),
      nextId: this.simulation.nextId,
    };
    if (existingSession) {
      this.simulation.sessions[activeIndex] = nextSession;
    } else {
      this.simulation.sessions.push(nextSession);
      this.simulation.activeSessionIndex = this.simulation.sessions.length - 1;
    }
    this._normalizeSimulationSessionBindings();
    this._renderSimulationInspector();
    if (this._simulationSessionRoutingPanel?.classList.contains('open')) {
      this._renderSimulationSessionRoutingPicker();
      if (this._simulationSessionRoutingAnchor) this._positionSimulationSessionRoutingPicker(this._simulationSessionRoutingAnchor);
    }
    this._syncSimulationSessionContextUi();
    this.saveSession();
    const verb = existingSession ? 'Updated' : 'Saved';
    this.showToast(rawName.trim().length > MAX_SIM_SESSION_NAME_LENGTH ? `${verb} "${name}" (trimmed)` : `${verb} "${name}"`);
  }

  _loadSimulationSession(index) {
    const session = this.simulation.sessions[index];
    if (!session || !this._applySimulationSessionToDraft(session)) return;
    this.simulation.activeSessionIndex = index;
    this._normalizeSimulationSessionBindings();
    this._renderSimulationInspector();
    this._syncSimulationSessionContextUi();
    this.saveSession();
    this.showToast(`Loaded "${session.name}"`);
  }

  _setActiveSimulationSessionIndex(index) {
    if (this.simulation.running || this.simulation.paused) {
      this.stopSimulation(false);
      this.showToast('Simulation stopped before switching sessions');
    }
    this._syncActiveSimulationSessionFromDraft();
    if (!Number.isFinite(index) || index < 0 || !this.simulation.sessions[index]) {
      this.simulation.activeSessionIndex = -1;
      this._normalizeSimulationSessionBindings();
      this._renderSimulationInspector();
      this._syncSimulationSessionContextUi();
      this.saveSession();
      return;
    }
    this._loadSimulationSession(index);
  }

  _deleteSimulationSavedSession(index) {
    const session = this.simulation.sessions[index];
    if (!session) return;
    if (!window.confirm(`Delete saved simulation session "${session.name}"?`)) return;
    this.simulation.sessions.splice(index, 1);
    if (this.simulation.activeSessionIndex === index) {
      this.simulation.activeSessionIndex = -1;
    } else if (this.simulation.activeSessionIndex > index) {
      this.simulation.activeSessionIndex -= 1;
    }
    this._normalizeSimulationSessionBindings();
    this._renderSimulationInspector();
    if (this._simulationSessionRoutingPanel?.classList.contains('open')) {
      this._renderSimulationSessionRoutingPicker();
      if (this._simulationSessionRoutingAnchor) this._positionSimulationSessionRoutingPicker(this._simulationSessionRoutingAnchor);
    }
    this.saveSession();
    this.showToast(`Deleted "${session.name}"`);
  }

  _createSimulationSetupDraft() {
    const sessions = this._ensureSimulationSessionIds(_deepClone(this.simulation.sessions || [])) || [];
    const activeSessionId = this.simulation.activeSessionIndex >= 0
      ? sessions[this.simulation.activeSessionIndex]?.id || null
      : null;
    const bindings = this._normalizeSimulationSessionBindings().map(binding => ({
      sessionId: binding.sessionId,
      sessionIndex: binding.sessionIndex,
      enabled: binding.enabled !== false,
      layerIds: this._normalizeSimulationLayerIds(binding.layerIds, binding.sessionIndex),
    }));
    const rows = sessions.map((session, sessionIndex) => {
      const sessionVars = _normalizeSimulationVars(session.vars);
      const binding = bindings.find(candidate => candidate.sessionId === session.id)
        || bindings.find(candidate => candidate.sessionIndex === sessionIndex)
        || {
          sessionId: session.id,
          sessionIndex,
          enabled: false,
          layerIds: this._normalizeSimulationLayerIds([this._getDefaultSimulationSessionLayerId(sessionIndex)], sessionIndex),
        };
      const sensingSource = SIM_SENSING_SOURCES.includes(sessionVars.sensingSource)
        ? sessionVars.sensingSource
        : 'below';
      let sensingLayerIds = _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection);
      if (sensingSource === 'selected' && !sensingLayerIds.length) {
        sensingLayerIds = this._seedDraftSensingSourceSelection(sensingSource, sessionIndex);
      }
      return {
        sessionId: session.id,
        sessionIndex,
        name: session.name || `Session ${sessionIndex + 1}`,
        savedAt: session.savedAt || 0,
        enabled: binding.enabled !== false,
        layerIds: this._normalizeSimulationLayerIds(binding.layerIds, sessionIndex),
        sensingEnabled: sessionVars.sensingEnabled === true,
        sensingMode: SIM_SENSING_MODES.includes(sessionVars.sensingMode) ? sessionVars.sensingMode : 'avoid',
        sensingChannel: SIM_SENSING_CHANNELS.includes(sessionVars.sensingChannel) ? sessionVars.sensingChannel : 'darkness',
        sensingStrength: Number.isFinite(sessionVars.sensingStrength) ? _clamp(sessionVars.sensingStrength, 0, 1) : 0.5,
        sensingRadius: Number.isFinite(sessionVars.sensingRadius) ? Math.max(0, sessionVars.sensingRadius) : 20,
        sensingFitRadius: Number.isFinite(sessionVars.sensingFitRadius) ? Math.max(0, sessionVars.sensingFitRadius) : 0,
        sensingThreshold: Number.isFinite(sessionVars.sensingThreshold) ? _clamp(sessionVars.sensingThreshold, 0, 1) : 0.1,
        sensingUpdateFrames: Number.isFinite(sessionVars.sensingUpdateFrames) ? Math.max(1, Math.min(50, Math.round(sessionVars.sensingUpdateFrames))) : 30,
        sensingSource,
        sensingLayerIds,
        unresolvedLayers: [],
        unresolvedSensingLayers: [],
      };
    });
    return {
      sessions,
      activeSessionId,
      multiSessionEnabled: this.simulation.multiSessionEnabled === true,
      rows,
      status: '',
      statusLevel: '',
      importedSetupMeta: null,
    };
  }

  _seedDraftSensingSourceSelection(source = 'below', sessionIndex = 0) {
    const activeLayer = this._getLayerById(this._getDefaultSimulationSessionLayerId(sessionIndex)) || this.getActiveLayer();
    const activeLayerIndex = activeLayer ? this.layers.findIndex(layer => layer.id === activeLayer.id) : this.getActiveLayerIndex();
    if (source === 'all') {
      return this.layers.filter(layer => layer.visible).map(layer => layer.id);
    }
    if (source === 'selected') {
      return activeLayer ? [activeLayer.id] : [];
    }
    if (source === 'active') {
      return activeLayer ? [activeLayer.id] : [];
    }
    return this.layers
      .slice(Math.max(0, activeLayerIndex + 1))
      .filter(layer => layer.visible)
      .map(layer => layer.id);
  }

  _buildSimulationSetupLayerSummary(layerIds, sessionIndex = 0) {
    const layers = this._normalizeSimulationLayerIds(layerIds, sessionIndex)
      .map(layerId => this._getLayerById(layerId))
      .filter(Boolean);
    if (!layers.length) return 'No layers';
    if (layers.length === 1) return layers[0].name || 'Unnamed layer';
    const first = layers[0].name || 'Unnamed layer';
    return `${first} +${layers.length - 1}`;
  }

  _buildSimulationSetupSensingSummary(row) {
    if (!row?.sensingEnabled) return 'Sensing off';
    if (row.sensingSource !== 'selected') {
      if (row.sensingSource === 'below') return 'Layers below active';
      if (row.sensingSource === 'all') return 'All visible layers';
      if (row.sensingSource === 'active') return 'Active layer only';
      return 'Source not set';
    }
    const layers = _normalizeSimulationSensingSourceSelection(row.sensingLayerIds)
      .map(layerId => this._getLayerById(layerId))
      .filter(Boolean);
    if (!layers.length) return 'Selected layers required';
    if (layers.length === 1) return layers[0].name || 'Unnamed layer';
    const first = layers[0].name || 'Unnamed layer';
    return `${first} +${layers.length - 1}`;
  }

  _syncSimulationSetupRowSensingVars(row, updates = {}) {
    if (!row || !this._simulationSetupDraft) return null;
    const session = this._simulationSetupDraft.sessions?.[row.sessionIndex];
    if (!session) return null;
    const nextVars = _normalizeSimulationVars({
      ...session.vars,
      ...updates,
    });
    session.vars = nextVars;
    const liveSession = this.simulation.sessions?.[row.sessionIndex];
    if (liveSession) {
      liveSession.vars = _normalizeSimulationVars({
        ...liveSession.vars,
        ...updates,
      });
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sensingEnabled')) {
      row.sensingEnabled = nextVars.sensingEnabled === true;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sensingMode')) {
      row.sensingMode = nextVars.sensingMode || 'avoid';
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sensingChannel')) {
      row.sensingChannel = nextVars.sensingChannel || 'darkness';
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sensingStrength')) {
      row.sensingStrength = Number.isFinite(nextVars.sensingStrength) ? nextVars.sensingStrength : 0.5;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sensingRadius')) {
      row.sensingRadius = Number.isFinite(nextVars.sensingRadius) ? nextVars.sensingRadius : 20;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sensingFitRadius')) {
      row.sensingFitRadius = Number.isFinite(nextVars.sensingFitRadius) ? nextVars.sensingFitRadius : 0;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sensingThreshold')) {
      row.sensingThreshold = Number.isFinite(nextVars.sensingThreshold) ? nextVars.sensingThreshold : 0.1;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'sensingUpdateFrames')) {
      row.sensingUpdateFrames = Number.isFinite(nextVars.sensingUpdateFrames) ? nextVars.sensingUpdateFrames : 30;
    }
    if (row.sessionIndex === this.simulation.activeSessionIndex) {
      this.simulation.vars = _normalizeSimulationVars({
        ...this.simulation.vars,
        ...updates,
      });
      this._syncSimulationSessionSensingControls();
    }
    for (const runtime of this.simulation.runtimeSessions || []) {
      if (runtime?.sessionIndex !== row.sessionIndex) continue;
      runtime.vars = _normalizeSimulationVars({
        ...runtime.vars,
        ...updates,
      });
      runtime.paramSnapshot = {
        ...(runtime.paramSnapshot || {}),
        ..._sanitizeSimulationSessionData(updates) || {},
      };
    }
    for (const runtime of this.simulation.cachedRuntimeSessions || []) {
      if (runtime?.sessionIndex !== row.sessionIndex) continue;
      runtime.vars = _normalizeSimulationVars({
        ...runtime.vars,
        ...updates,
      });
      runtime.paramSnapshot = {
        ...(runtime.paramSnapshot || {}),
        ..._sanitizeSimulationSessionData(updates) || {},
      };
    }
    return session;
  }

  _setSimulationSetupStatus(message = '', level = '', { persist = true } = {}) {
    if (!this._simulationSetupDraft) return;
    if (persist) {
      this._simulationSetupDraft.status = message;
      this._simulationSetupDraft.statusLevel = level;
    }
    const node = document.getElementById('simSetupStatus');
    if (!node) return;
    node.textContent = message;
    node.className = `sim-setup-status${level ? ` ${level}` : ''}`;
  }

  _closeSimulationSetupMenus({ exceptRowKey = '' } = {}) {
    const root = document.getElementById('simSetupRows');
    if (!root) return;
    root.querySelectorAll('.sim-setup-multiList.open').forEach(menu => {
      if (exceptRowKey && menu.dataset.rowKey === exceptRowKey) return;
      menu.classList.remove('open');
    });
  }

  _toggleSimulationSetupMenu(rowKey, event) {
    const button = event?.currentTarget;
    const menu = button?.parentElement?.querySelector('.sim-setup-multiList');
    if (!menu) return;
    const nextOpen = !menu.classList.contains('open');
    this._closeSimulationSetupMenus({ exceptRowKey: nextOpen ? rowKey : '' });
    menu.classList.toggle('open', nextOpen);
  }

  _updateSimulationSetupSummary() {
    const summary = document.getElementById('simSetupSummary');
    const toggle = document.getElementById('simSetupMultiToggle');
    this._syncSimulationSessionContextUi();
    if (!summary || !this._simulationSetupDraft) return;
    if (toggle) toggle.checked = this._simulationSetupDraft.multiSessionEnabled === true;
    const enabledRows = this._simulationSetupDraft.rows.filter(row => row.enabled);
    const routeCount = enabledRows.reduce((count, row) => count + this._normalizeSimulationLayerIds(row.layerIds, row.sessionIndex).length, 0);
    if (!this._simulationSetupDraft.rows.length) {
      summary.textContent = 'No saved sessions loaded.';
      return;
    }
    summary.textContent = `${this._simulationSetupDraft.rows.length} saved session${this._simulationSetupDraft.rows.length === 1 ? '' : 's'} in draft, ${enabledRows.length} enabled, ${routeCount} target route${routeCount === 1 ? '' : 's'}.`;
  }

  _getSimulationSetupReadinessStatus() {
    if (!this._simulationSetupDraft) return { message: '', level: '' };
    if (this._simulationSetupDraft.multiSessionEnabled !== true) {
      return {
        message: 'Enable Multi-Session Playback to route saved sessions across layers.',
        level: '',
      };
    }
    const diagnostics = this._getMultiSessionRouteDiagnostics();
    if (diagnostics.blockReason) {
      return {
        message: diagnostics.blockReason,
        level: 'warn',
      };
    }
    const routeCount = diagnostics.runnableRoutes.length;
    const sessionCount = new Set(diagnostics.runnableRoutes.map(route => route.sessionIndex)).size;
    return {
      message: `Ready to run ${sessionCount} session${sessionCount === 1 ? '' : 's'} across ${routeCount} route${routeCount === 1 ? '' : 's'}.`,
      level: 'success',
    };
  }

  _renderSimulationSetupExplorer() {
    const root = document.getElementById('simSetupRows');
    if (!root || !this._simulationSetupDraft) return;
    const rows = this._simulationSetupDraft.rows || [];
    this._updateSimulationSetupSummary();
    if (this._simulationSetupDraft.status) {
      this._setSimulationSetupStatus(this._simulationSetupDraft.status || '', this._simulationSetupDraft.statusLevel || '', { persist: false });
    } else {
      const readiness = this._getSimulationSetupReadinessStatus();
      this._setSimulationSetupStatus(readiness.message, readiness.level, { persist: false });
    }
    if (!rows.length) {
      root.innerHTML = '<div class="sim-setup-empty">Save at least one simulation session before assigning setup rows.</div>';
      return;
    }
    const layerOptions = this._getSimulationTargetLayers().map(layer => ({
      id: layer.id,
      label: layer.name || (layer.isBackground ? 'Background' : 'Unnamed layer'),
    }));
    const sensingLayerOptions = this.layers.map(layer => ({
      id: layer.id,
      label: layer.name || (layer.isBackground ? 'Background' : 'Unnamed layer'),
    }));
    const renderFutureControls = row => `
      <div class="sim-setup-futureControls">
        <label class="sim-setup-futureField">
          <span>On</span>
          <input type="checkbox" data-sim-setup-future-field="sensingEnabled" data-sim-setup-row="${_escapeHtml(row.sessionId)}" ${row.sensingEnabled ? 'checked' : ''}>
        </label>
        <label class="sim-setup-futureField">
          <span>Mode</span>
          <select data-sim-setup-future-field="sensingMode" data-sim-setup-row="${_escapeHtml(row.sessionId)}">
            <option value="avoid" ${row.sensingMode === 'avoid' ? 'selected' : ''}>Avoid</option>
            <option value="attract" ${row.sensingMode === 'attract' ? 'selected' : ''}>Attract</option>
          </select>
        </label>
        <label class="sim-setup-futureField">
          <span>Channel</span>
          <select data-sim-setup-future-field="sensingChannel" data-sim-setup-row="${_escapeHtml(row.sessionId)}">
            <option value="darkness" ${row.sensingChannel === 'darkness' ? 'selected' : ''}>Darkness</option>
            <option value="lightness" ${row.sensingChannel === 'lightness' ? 'selected' : ''}>Lightness</option>
            <option value="saturation" ${row.sensingChannel === 'saturation' ? 'selected' : ''}>Saturation</option>
            <option value="red" ${row.sensingChannel === 'red' ? 'selected' : ''}>Red</option>
            <option value="green" ${row.sensingChannel === 'green' ? 'selected' : ''}>Green</option>
            <option value="blue" ${row.sensingChannel === 'blue' ? 'selected' : ''}>Blue</option>
            <option value="alpha" ${row.sensingChannel === 'alpha' ? 'selected' : ''}>Alpha</option>
          </select>
        </label>
        <label class="sim-setup-futureField">
          <span>Strength</span>
          <input type="number" min="0" max="1" step="0.01" data-sim-setup-future-field="sensingStrength" data-sim-setup-row="${_escapeHtml(row.sessionId)}" value="${Number.isFinite(row.sensingStrength) ? row.sensingStrength.toFixed(2) : '0.50'}">
        </label>
        <label class="sim-setup-futureField">
          <span>Radius</span>
          <input type="number" min="0" max="200" step="1" data-sim-setup-future-field="sensingRadius" data-sim-setup-row="${_escapeHtml(row.sessionId)}" value="${Number.isFinite(row.sensingRadius) ? Math.round(row.sensingRadius) : 20}">
        </label>
        <label class="sim-setup-futureField">
          <span>Fit Radius</span>
          <input type="number" min="0" max="200" step="1" data-sim-setup-future-field="sensingFitRadius" data-sim-setup-row="${_escapeHtml(row.sessionId)}" value="${Number.isFinite(row.sensingFitRadius) ? Math.round(row.sensingFitRadius) : 0}">
        </label>
        <label class="sim-setup-futureField">
          <span>Threshold</span>
          <input type="number" min="0" max="1" step="0.01" data-sim-setup-future-field="sensingThreshold" data-sim-setup-row="${_escapeHtml(row.sessionId)}" value="${Number.isFinite(row.sensingThreshold) ? row.sensingThreshold.toFixed(2) : '0.10'}">
        </label>
        <label class="sim-setup-futureField">
          <span>Every</span>
          <input type="number" min="1" max="50" step="1" data-sim-setup-future-field="sensingUpdateFrames" data-sim-setup-row="${_escapeHtml(row.sessionId)}" value="${Number.isFinite(row.sensingUpdateFrames) ? Math.round(row.sensingUpdateFrames) : 30}">
        </label>
      </div>`;
    root.innerHTML = `
      <table class="sim-setup-table">
        <thead>
          <tr>
            <th style="width:56px;">Run</th>
            <th>Simulation</th>
            <th style="width:210px;">Stamp Layer(s)</th>
            <th style="width:88px;">Sense</th>
            <th style="width:150px;">Sense Source</th>
            <th style="width:220px;">Sense Layer(s)</th>
            <th style="width:180px;">Future</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => {
            const rowKey = _escapeHtml(row.sessionId);
            const isActiveSession = row.sessionId === this._simulationSetupDraft.activeSessionId;
            const saveStamp = row.savedAt ? new Date(row.savedAt).toLocaleString() : 'Not saved yet';
            const routeWarning = row.unresolvedLayers?.length
              ? `<div class="sim-setup-warning">Missing: ${_escapeHtml(row.unresolvedLayers.join(', '))}</div>`
              : '';
            const sensingWarning = row.unresolvedSensingLayers?.length
              ? `<div class="sim-setup-warning">Missing: ${_escapeHtml(row.unresolvedSensingLayers.join(', '))}</div>`
              : '';
            return `
              <tr data-sim-setup-row="${rowKey}" class="${isActiveSession ? 'active' : ''}">
                <td><label class="sim-setup-check"><input type="checkbox" data-sim-setup-enabled="${rowKey}" ${row.enabled ? 'checked' : ''}></label></td>
                <td>
                  <div class="sim-setup-sessionName">
                    <strong>${_escapeHtml(row.name)}</strong>
                    <span>Saved ${_escapeHtml(saveStamp)}</span>
                    ${isActiveSession ? '<span>Loaded into the current draft session</span>' : ''}
                    <span>${row.enabled ? 'Ready for multi-session playback' : 'Disabled in draft'}</span>
                  </div>
                </td>
                <td>
                  <div class="sim-setup-multi">
                    <button type="button" data-sim-setup-menu="${rowKey}" data-sim-setup-kind="layers">
                      <span>${_escapeHtml(this._buildSimulationSetupLayerSummary(row.layerIds, row.sessionIndex))}</span>
                      <span aria-hidden="true">▾</span>
                    </button>
                    <div class="sim-setup-multiList" data-row-key="${rowKey}" data-sim-setup-list="layers">
                      ${layerOptions.map(option => `
                        <label>
                          <input type="checkbox" data-sim-setup-layer-option="${rowKey}" value="${_escapeHtml(option.id)}" ${row.layerIds.includes(option.id) ? 'checked' : ''}>
                          <span>${_escapeHtml(option.label)}</span>
                        </label>`).join('')}
                    </div>
                    ${routeWarning}
                  </div>
                </td>
                <td><label class="sim-setup-check"><input type="checkbox" data-sim-setup-sensing-enabled="${rowKey}" ${row.sensingEnabled ? 'checked' : ''}></label></td>
                <td>
                  <select data-sim-setup-sensing-source="${rowKey}">
                    <option value="below" ${row.sensingSource === 'below' ? 'selected' : ''}>Below</option>
                    <option value="all" ${row.sensingSource === 'all' ? 'selected' : ''}>All Visible</option>
                    <option value="active" ${row.sensingSource === 'active' ? 'selected' : ''}>Active</option>
                    <option value="selected" ${row.sensingSource === 'selected' ? 'selected' : ''}>Selected</option>
                  </select>
                </td>
                <td>
                  <div class="sim-setup-multi">
                    <button type="button" data-sim-setup-menu="${rowKey}" data-sim-setup-kind="sensing" ${row.sensingSource === 'selected' ? '' : 'disabled'}>
                      <span>${_escapeHtml(this._buildSimulationSetupSensingSummary(row))}</span>
                      <span aria-hidden="true">▾</span>
                    </button>
                    <div class="sim-setup-multiList" data-row-key="${rowKey}" data-sim-setup-list="sensing">
                      ${sensingLayerOptions.map(option => `
                        <label>
                          <input type="checkbox" data-sim-setup-sensing-layer-option="${rowKey}" value="${_escapeHtml(option.id)}" ${row.sensingLayerIds.includes(option.id) ? 'checked' : ''}>
                          <span>${_escapeHtml(option.label)}</span>
                        </label>`).join('')}
                    </div>
                    ${sensingWarning}
                    <div class="sim-setup-muted">${_escapeHtml(this._buildSimulationSetupSensingSummary(row))}</div>
                  </div>
                </td>
                <td>${renderFutureControls(row)}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    document.getElementById('simSetupAddLayer')?.addEventListener('click', () => {
      this.addLayer();
      this._normalizeSimulationSessionBindings();
      if (this._simulationSetupDraft) {
        this._simulationSetupDraft = this._createSimulationSetupDraft();
        this._renderSimulationSetupExplorer();
      }
      this.saveSession();
      this.showToast('Added new layer');
    });
    document.getElementById('simSetupAddSession')?.addEventListener('click', () => {
      this.simulation.activeSessionIndex = -1;
      this._saveSimulationSession();
      if (this._simulationSetupDraft) {
        this._simulationSetupDraft = this._createSimulationSetupDraft();
        this._renderSimulationSetupExplorer();
      }
    });

    root.querySelectorAll('[data-sim-setup-enabled]').forEach(input => {
      input.addEventListener('change', event => {
        const row = this._getSimulationSetupDraftRow(event.target.dataset.simSetupEnabled);
        if (!row) return;
        row.enabled = !!event.target.checked;
        this._updateSimulationSetupSummary();
      });
    });
    root.querySelectorAll('[data-sim-setup-sensing-enabled]').forEach(input => {
      input.addEventListener('change', event => {
        const row = this._getSimulationSetupDraftRow(event.target.dataset.simSetupSensingEnabled);
        if (!row) return;
        row.sensingEnabled = !!event.target.checked;
        this._renderSimulationSetupExplorer();
      });
    });
    root.querySelectorAll('[data-sim-setup-sensing-source]').forEach(select => {
      select.addEventListener('change', event => {
        const row = this._getSimulationSetupDraftRow(event.target.dataset.simSetupSensingSource);
        if (!row) return;
        row.sensingSource = SIM_SENSING_SOURCES.includes(event.target.value) ? event.target.value : 'below';
        if (row.sensingSource === 'selected' && !row.sensingLayerIds.length) {
          row.sensingLayerIds = this._seedDraftSensingSourceSelection('selected', row.sessionIndex);
        }
        this._renderSimulationSetupExplorer();
      });
    });
    root.querySelectorAll('[data-sim-setup-menu]').forEach(button => {
      button.addEventListener('click', event => {
        const rowKey = event.currentTarget.dataset.simSetupMenu;
        this._toggleSimulationSetupMenu(rowKey, event);
      });
    });
    root.querySelectorAll('[data-sim-setup-layer-option]').forEach(input => {
      input.addEventListener('change', event => {
        const row = this._getSimulationSetupDraftRow(event.target.dataset.simSetupLayerOption);
        if (!row) return;
        const nextIds = new Set(this._normalizeSimulationLayerIds(row.layerIds, row.sessionIndex));
        if (event.target.checked) nextIds.add(event.target.value);
        else nextIds.delete(event.target.value);
        row.layerIds = this._normalizeSimulationLayerIds(Array.from(nextIds), row.sessionIndex);
        this._renderSimulationSetupExplorer();
      });
    });
    root.querySelectorAll('[data-sim-setup-sensing-layer-option]').forEach(input => {
      input.addEventListener('change', event => {
        const row = this._getSimulationSetupDraftRow(event.target.dataset.simSetupSensingLayerOption);
        if (!row) return;
        const nextIds = new Set(_normalizeSimulationSensingSourceSelection(row.sensingLayerIds));
        if (event.target.checked) nextIds.add(event.target.value);
        else nextIds.delete(event.target.value);
        row.sensingLayerIds = _normalizeSimulationSensingSourceSelection(Array.from(nextIds));
        this._renderSimulationSetupExplorer();
      });
    });
    root.querySelectorAll('[data-sim-setup-future-field]').forEach(input => {
      const applyFutureValue = () => {
        const row = this._getSimulationSetupDraftRow(input.dataset.simSetupRow);
        if (!row) return;
        const field = input.dataset.simSetupFutureField;
        let value;
        if (input.type === 'checkbox') {
          value = input.checked;
        } else if (field === 'sensingMode') {
          value = input.value === 'attract' ? 'attract' : 'avoid';
        } else if (field === 'sensingChannel') {
          value = SIM_SENSING_CHANNELS.includes(input.value) ? input.value : 'darkness';
        } else {
          const rawValue = Number(input.value);
          if (field === 'sensingStrength' || field === 'sensingThreshold') {
            value = Number.isFinite(rawValue) ? _clamp(rawValue, 0, 1) : undefined;
          } else if (field === 'sensingRadius' || field === 'sensingFitRadius') {
            value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : undefined;
          } else if (field === 'sensingUpdateFrames') {
            value = Number.isFinite(rawValue) ? Math.max(1, Math.min(50, Math.round(rawValue))) : undefined;
          }
        }
        if (value === undefined) return;
        row[field] = value;
        this._syncSimulationSetupRowSensingVars(row, { [field]: value });
      };
      input.addEventListener('input', applyFutureValue);
      input.addEventListener('change', applyFutureValue);
    });
  }

  _getSimulationSetupDraftRow(sessionId) {
    return this._simulationSetupDraft?.rows?.find(row => row.sessionId === sessionId) || null;
  }

  _showSimulationSetupExplorer(opener = null) {
    const modal = document.getElementById('simSetupModal');
    if (!modal) return;
    this._simulationSetupDraft = this._createSimulationSetupDraft();
    this._simulationSetupOpener = opener || document.activeElement;
    this._renderSimulationSetupExplorer();
    modal.classList.add('open');
    const acceptButton = document.getElementById('simSetupAccept');
    queueMicrotask(() => acceptButton?.focus());
  }

  _hideSimulationSetupExplorer({ discard = true } = {}) {
    const modal = document.getElementById('simSetupModal');
    if (!modal) return;
    modal.classList.remove('open');
    this._closeSimulationSetupMenus();
    if (discard) this._simulationSetupDraft = null;
    const opener = this._simulationSetupOpener;
    this._simulationSetupOpener = null;
    opener?.focus?.();
  }

  _applySimulationSetupDraft() {
    if (!this._simulationSetupDraft) return false;
    const validationError = this._validateSimulationSetupDraft();
    if (validationError) {
      this._setSimulationSetupStatus(validationError, 'error');
      return false;
    }
    const sessions = this._ensureSimulationSessionIds(_deepClone(this._simulationSetupDraft.sessions || [])) || [];
    const rowsById = new Map(this._simulationSetupDraft.rows.map(row => [row.sessionId, row]));
    for (const session of sessions) {
      const row = rowsById.get(session.id);
      if (!row) continue;
      session.vars = _normalizeSimulationVars({
        ...session.vars,
        sensingEnabled: row.sensingEnabled,
        sensingMode: row.sensingMode,
        sensingChannel: row.sensingChannel,
        sensingStrength: row.sensingStrength,
        sensingRadius: row.sensingRadius,
        sensingFitRadius: row.sensingFitRadius,
        sensingThreshold: row.sensingThreshold,
        sensingUpdateFrames: row.sensingUpdateFrames,
        sensingSource: row.sensingSource,
      });
      session.sensingSourceSelection = _normalizeSimulationSensingSourceSelection(row.sensingLayerIds);
    }
    this.simulation.sessions = sessions;
    const nextActiveIndex = this._simulationSetupDraft.activeSessionId
      ? sessions.findIndex(session => session.id === this._simulationSetupDraft.activeSessionId)
      : -1;
    this.simulation.activeSessionIndex = nextActiveIndex >= 0 ? nextActiveIndex : -1;
    this.simulation.multiSessionEnabled = this._simulationSetupDraft.multiSessionEnabled === true;
    this.simulation.multiSessionBindings = this._simulationSetupDraft.rows.map(row => ({
      sessionId: row.sessionId,
      sessionIndex: row.sessionIndex,
      enabled: row.enabled !== false,
      layerIds: this._normalizeSimulationLayerIds(row.layerIds, row.sessionIndex),
    }));
    for (const runtime of [...(this.simulation.runtimeSessions || []), ...(this.simulation.cachedRuntimeSessions || [])]) {
      if (!runtime || !Number.isFinite(runtime.sessionIndex)) continue;
      const session = sessions[runtime.sessionIndex];
      if (!session) continue;
      runtime.vars = _normalizeSimulationVars(session.vars);
      runtime.paramSnapshot = _sanitizeSimulationSessionData(session.paramSnapshot) || {};
      runtime.sensingSourceSelection = _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection);
      runtime.sessionName = session.name;
    }
    if (this.simulation.running || this.simulation.paused) this.stopSimulation(false);
    this._normalizeSimulationSessionBindings();
    if (this.simulation.activeSessionIndex >= 0) {
      this._applySimulationSessionToDraft(this.simulation.sessions[this.simulation.activeSessionIndex]);
    }
    this._renderSimulationInspector();
    this._syncSimulationUI();
    this.saveSession();
    this._hideSimulationSetupExplorer({ discard: true });
    this.showToast('Simulation setup applied');
    return true;
  }

  _validateSimulationSetupDraft() {
    if (!this._simulationSetupDraft) return 'No simulation setup draft is open.';
    for (const row of this._simulationSetupDraft.rows || []) {
      if (Array.isArray(row.unresolvedLayers) && row.unresolvedLayers.length) {
        return `Resolve missing target layers for ${row.name} before accepting.`;
      }
      const layerIds = this._normalizeSimulationLayerIds(row.layerIds, row.sessionIndex);
      if (row.enabled && !layerIds.length) {
        return `Choose at least one target layer for ${row.name}.`;
      }
      if (row.sensingEnabled && row.sensingSource === 'selected' && Array.isArray(row.unresolvedSensingLayers) && row.unresolvedSensingLayers.length) {
        return `Resolve missing sensing layers for ${row.name} before accepting.`;
      }
      if (row.sensingEnabled && row.sensingSource === 'selected' && !_normalizeSimulationSensingSourceSelection(row.sensingLayerIds).length) {
        return `Choose at least one sensing source layer for ${row.name}.`;
      }
    }
    return '';
  }

  _buildSimulationSetupDraftSnapshot(draft = this._simulationSetupDraft) {
    if (!draft) return null;
    const sessions = this._ensureSimulationSessionIds(_deepClone(draft.sessions || [])) || [];
    const rowsById = new Map((draft.rows || []).map(row => [row.sessionId, row]));
    for (const session of sessions) {
      const row = rowsById.get(session.id);
      if (!row) continue;
      session.vars = _normalizeSimulationVars({
        ...session.vars,
        sensingEnabled: row.sensingEnabled,
        sensingMode: row.sensingMode,
        sensingChannel: row.sensingChannel,
        sensingStrength: row.sensingStrength,
        sensingRadius: row.sensingRadius,
        sensingFitRadius: row.sensingFitRadius,
        sensingThreshold: row.sensingThreshold,
        sensingUpdateFrames: row.sensingUpdateFrames,
        sensingSource: row.sensingSource,
      });
      session.sensingSourceSelection = _normalizeSimulationSensingSourceSelection(row.sensingLayerIds);
    }
    return {
      activeSessionId: draft.activeSessionId || null,
      multiSessionEnabled: draft.multiSessionEnabled === true,
      sessions,
      bindings: (draft.rows || []).map(row => ({
        sessionId: row.sessionId,
        sessionIndex: row.sessionIndex,
        enabled: row.enabled !== false,
        layerIds: this._normalizeSimulationLayerIds(row.layerIds, row.sessionIndex),
      })),
    };
  }

  _resetSimulationSetupDraftToDefaults() {
    if (!this._simulationSetupDraft) return;
    this._simulationSetupDraft.multiSessionEnabled = false;
    this._simulationSetupDraft.rows.forEach((row, index) => {
      row.enabled = false;
      row.layerIds = this._normalizeSimulationLayerIds([this._getDefaultSimulationSessionLayerId(index)], index);
      row.sensingEnabled = false;
      row.sensingMode = 'avoid';
      row.sensingChannel = 'darkness';
      row.sensingStrength = 0.5;
      row.sensingRadius = 20;
      row.sensingFitRadius = 0;
      row.sensingThreshold = 0.1;
      row.sensingUpdateFrames = 30;
      row.sensingSource = 'below';
      row.sensingLayerIds = [];
      row.unresolvedLayers = [];
      row.unresolvedSensingLayers = [];
    });
    this._setSimulationSetupStatus('Draft reset to default routing and sensing.', 'warn');
    this._renderSimulationSetupExplorer();
  }

  createSimulationSetupBundle() {
    this._normalizeSimulationSessionBindings();
    const draft = document.getElementById('simSetupModal')?.classList.contains('open') ? this._simulationSetupDraft : null;
    const snapshot = draft ? this._buildSimulationSetupDraftSnapshot(draft) : null;
    const layerCatalog = this.layers.map(layer => ({
      id: layer.id,
      name: layer.name || '',
      isBackground: !!layer.isBackground,
    }));
    return {
      format: SIM_SETUP_FORMAT,
      version: SIM_SETUP_VERSION,
      exportedAt: new Date().toISOString(),
      appBuildId: APP_BUILD_ID,
      activeSessionId: snapshot?.activeSessionId
        || (this.simulation.activeSessionIndex >= 0 ? this.simulation.sessions[this.simulation.activeSessionIndex]?.id || null : null),
      multiSessionEnabled: snapshot ? snapshot.multiSessionEnabled : this.simulation.multiSessionEnabled === true,
      sessions: snapshot
        ? snapshot.sessions
        : this._ensureSimulationSessionIds(_deepClone(this.simulation.sessions || [])),
      bindings: snapshot
        ? snapshot.bindings
        : _deepClone(this.simulation.multiSessionBindings || []),
      layers: layerCatalog,
    };
  }

  exportSimulationSetupFile() {
    const bundle = this.createSimulationSetupBundle();
    const stamp = new Date().toISOString().replace(/[.:]/g, '-');
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    this._downloadBlob(blob, `boid-brush-sim-setup-${stamp}.json`);
    this.showToast('Simulation setup exported');
    return true;
  }

  _mapImportedSimulationSetupLayerIds(layerIds, sourceLayers = []) {
    const byId = new Map(this.layers.map(layer => [layer.id, layer.id]));
    const byName = new Map(this.layers.map(layer => [layer.name || '', layer.id]));
    const sourceById = new Map((sourceLayers || []).map(layer => [layer.id, layer]));
    const resolved = [];
    const missing = [];
    for (const layerId of Array.isArray(layerIds) ? layerIds : []) {
      if (byId.has(layerId)) {
        resolved.push(byId.get(layerId));
        continue;
      }
      const sourceLayer = sourceById.get(layerId);
      const mappedByName = sourceLayer?.name ? byName.get(sourceLayer.name) : null;
      if (mappedByName) resolved.push(mappedByName);
      else missing.push(sourceLayer?.name || layerId);
    }
    return {
      resolved: [...new Set(resolved)],
      missing,
    };
  }

  _normalizeSimulationSetupBundle(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw new Error('Invalid simulation setup payload');
    }
    if (bundle.format !== SIM_SETUP_FORMAT) {
      throw new Error('Unsupported simulation setup format');
    }
    const sessions = this._ensureSimulationSessionIds(
      (Array.isArray(bundle.sessions) ? bundle.sessions : [])
        .filter(session => session && typeof session === 'object')
        .map(session => ({
          ...session,
          vars: _normalizeSimulationVars(session.vars),
          sensingSourceSelection: _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection),
          savedPlayback: _normalizeSimulationSavedPlayback(session.savedPlayback),
        })),
    );
    const sessionIndexById = new Map(sessions.map((session, index) => [session.id, index]));
    const sourceLayers = Array.isArray(bundle.layers) ? bundle.layers : [];
    const bindings = (Array.isArray(bundle.bindings) ? bundle.bindings : []).map(binding => {
      const indexedSession = typeof binding?.sessionId === 'string' ? sessionIndexById.get(binding.sessionId) : undefined;
      const fallbackIndex = Math.round(binding?.sessionIndex);
      const sessionIndex = Number.isFinite(indexedSession) ? indexedSession : fallbackIndex;
      const session = sessions[sessionIndex];
      if (!session) return null;
      const mapped = this._mapImportedSimulationSetupLayerIds(
        Array.isArray(binding?.layerIds) ? binding.layerIds : [binding?.layerId],
        sourceLayers,
      );
      return {
        sessionId: session.id,
        sessionIndex,
        enabled: binding?.enabled !== false,
        layerIds: mapped.resolved,
        unresolvedLayers: mapped.missing,
      };
    }).filter(Boolean);
    return {
      activeSessionId: typeof bundle.activeSessionId === 'string' ? bundle.activeSessionId : null,
      multiSessionEnabled: bundle.multiSessionEnabled === true,
      sessions,
      bindings,
      importedSetupMeta: {
        exportedAt: bundle.exportedAt || '',
        sourceLayers,
      },
    };
  }

  async importSimulationSetupText(rawText) {
    const parsed = JSON.parse(rawText);
    const normalized = this._normalizeSimulationSetupBundle(parsed);
    const bindingsById = new Map(normalized.bindings.map(binding => [binding.sessionId, binding]));
    this._simulationSetupDraft = {
      sessions: normalized.sessions,
      activeSessionId: normalized.activeSessionId,
      multiSessionEnabled: normalized.multiSessionEnabled,
      rows: normalized.sessions.map((session, sessionIndex) => {
        const binding = bindingsById.get(session.id);
        const sessionVars = _normalizeSimulationVars(session.vars);
        const sensingMap = this._mapImportedSimulationSetupLayerIds(session.sensingSourceSelection, normalized.importedSetupMeta?.sourceLayers);
        return {
          sessionId: session.id,
          sessionIndex,
          name: session.name || `Session ${sessionIndex + 1}`,
          savedAt: session.savedAt || 0,
          enabled: binding?.enabled !== false,
          layerIds: this._normalizeSimulationLayerIds(binding?.layerIds, sessionIndex),
          sensingEnabled: sessionVars.sensingEnabled === true,
          sensingMode: SIM_SENSING_MODES.includes(sessionVars.sensingMode) ? sessionVars.sensingMode : 'avoid',
          sensingChannel: SIM_SENSING_CHANNELS.includes(sessionVars.sensingChannel) ? sessionVars.sensingChannel : 'darkness',
          sensingStrength: Number.isFinite(sessionVars.sensingStrength) ? _clamp(sessionVars.sensingStrength, 0, 1) : 0.5,
          sensingRadius: Number.isFinite(sessionVars.sensingRadius) ? Math.max(0, sessionVars.sensingRadius) : 20,
          sensingFitRadius: Number.isFinite(sessionVars.sensingFitRadius) ? Math.max(0, sessionVars.sensingFitRadius) : 0,
          sensingThreshold: Number.isFinite(sessionVars.sensingThreshold) ? _clamp(sessionVars.sensingThreshold, 0, 1) : 0.1,
          sensingUpdateFrames: Number.isFinite(sessionVars.sensingUpdateFrames) ? Math.max(1, Math.min(50, Math.round(sessionVars.sensingUpdateFrames))) : 30,
          sensingSource: SIM_SENSING_SOURCES.includes(sessionVars.sensingSource) ? sessionVars.sensingSource : 'below',
          sensingLayerIds: sensingMap.resolved,
          unresolvedLayers: binding?.unresolvedLayers || [],
          unresolvedSensingLayers: sensingMap.missing,
        };
      }),
      status: normalized.bindings.some(binding => binding.unresolvedLayers?.length)
        ? 'Imported setup has unresolved layer mappings. Review rows before Accept.'
        : 'Imported setup loaded into draft.',
      statusLevel: normalized.bindings.some(binding => binding.unresolvedLayers?.length) ? 'warn' : '',
      importedSetupMeta: normalized.importedSetupMeta,
    };
    this._renderSimulationSetupExplorer();
    return true;
  }

  _ensureSimulationSessionRoutingPanel() {
    if (this._simulationSessionRoutingPanel) return this._simulationSessionRoutingPanel;
    const panel = document.createElement('div');
    panel.id = 'simulationSessionRoutingPanel';
    panel.style.position = 'fixed';
    panel.style.zIndex = '140';
    panel.style.width = '340px';
    panel.style.maxHeight = '360px';
    panel.style.overflow = 'auto';
    panel.style.padding = '10px';
    panel.style.borderRadius = '10px';
    panel.style.border = '1px solid rgba(255,255,255,0.14)';
    panel.style.background = 'rgba(10,12,18,0.96)';
    panel.style.boxShadow = '0 14px 36px rgba(0,0,0,0.35)';
    panel.style.color = '#eef3ff';
    panel.style.font = '12px/1.4 Segoe UI, sans-serif';
    panel.style.display = 'none';
    panel.style.userSelect = 'none';
    document.body.appendChild(panel);
    this._simulationSessionRoutingPanel = panel;
    return panel;
  }

  _positionSimulationSessionRoutingPicker(anchorEl) {
    const panel = this._ensureSimulationSessionRoutingPanel();
    const anchorRect = anchorEl?.getBoundingClientRect();
    if (!anchorRect) return;
    const panelRect = panel.getBoundingClientRect();
    const gap = 8;
    const maxLeft = Math.max(8, window.innerWidth - panelRect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - panelRect.height - 8);
    const left = Math.min(maxLeft, Math.max(8, anchorRect.right - panelRect.width));
    const top = Math.min(maxTop, Math.max(8, anchorRect.bottom + gap));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  _renderSimulationSessionRoutingPicker() {
    const panel = this._ensureSimulationSessionRoutingPanel();
    const bindings = this._normalizeSimulationSessionBindings();
    const layerOptions = this._getSimulationTargetLayers().map(layer => ({
      id: layer.id,
      label: layer.name || (layer.isBackground ? 'Background' : 'Unnamed layer'),
    }));
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <strong style="font-size:12px;">Session Layer Routing</strong>
        <button type="button" data-sim-routing-close style="padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:#eef3ff;cursor:pointer;">Done</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button type="button" data-sim-routing-enable-all style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(58,106,232,0.14);color:#dfe8ff;cursor:pointer;">Enable All</button>
        <button type="button" data-sim-routing-disable-all style="padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#eef3ff;cursor:pointer;">Disable All</button>
      </div>
      ${this.simulation.sessions.length ? `
        <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:6px 8px;align-items:center;">
          <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(238,243,255,0.65);">Run</div>
          <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(238,243,255,0.65);">Session</div>
          <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(238,243,255,0.65);">Stamp Layer</div>
          ${this.simulation.sessions.map((session, sessionIndex) => {
            const binding = bindings.find(candidate => candidate.sessionIndex === sessionIndex) || {
              enabled: true,
              layerId: this._getDefaultSimulationSessionLayerId(sessionIndex),
            };
            return `
              <label style="display:flex;justify-content:center;">
                <input type="checkbox" data-sim-routing-enabled="${sessionIndex}" ${binding.enabled !== false ? 'checked' : ''}>
              </label>
              <div style="min-width:0;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,0.04);font-weight:600;">${_escapeHtml(session.name)}</div>
              <select data-sim-routing-layer="${sessionIndex}" style="width:100%;background:rgba(20,25,36,0.98);color:#eef3ff;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:6px 8px;font-size:11px;min-height:32px;">
                ${layerOptions.map(option => `<option value="${option.id}" ${option.id === binding.layerId ? 'selected' : ''}>${_escapeHtml(option.label)}</option>`).join('')}
              </select>
            `;
          }).join('')}
        </div>
      ` : `<div style="font-size:11px;color:rgba(238,243,255,0.72);">Save at least one session before assigning parallel layer routes.</div>`}
    `;
    panel.querySelectorAll('[data-sim-routing-enabled]').forEach(input => {
      input.addEventListener('change', event => {
        const sessionIndex = Number(event.target.dataset.simRoutingEnabled);
        const binding = this._getSimulationSessionBinding(sessionIndex);
        if (!binding) return;
        binding.enabled = event.target.checked;
        this._renderSimulationInspector();
        this.saveSession();
      });
    });
    panel.querySelectorAll('[data-sim-routing-layer]').forEach(select => {
      select.addEventListener('change', event => {
        const sessionIndex = Number(event.target.dataset.simRoutingLayer);
        const binding = this._getSimulationSessionBinding(sessionIndex);
        if (!binding) return;
        binding.layerId = event.target.value || this._getDefaultSimulationSessionLayerId(sessionIndex);
        this._renderSimulationInspector();
        this.saveSession();
      });
    });
    panel.querySelector('[data-sim-routing-enable-all]')?.addEventListener('click', () => {
      this._normalizeSimulationSessionBindings().forEach(binding => { binding.enabled = true; });
      this._renderSimulationSessionRoutingPicker();
      this._renderSimulationInspector();
      this.saveSession();
    });
    panel.querySelector('[data-sim-routing-disable-all]')?.addEventListener('click', () => {
      this._normalizeSimulationSessionBindings().forEach(binding => { binding.enabled = false; });
      this._renderSimulationSessionRoutingPicker();
      this._renderSimulationInspector();
      this.saveSession();
    });
    panel.querySelector('[data-sim-routing-close]')?.addEventListener('click', () => this.closeSimulationSessionRoutingPicker());
  }

  openSimulationSessionRoutingPicker(anchorEl) {
    this._showSimulationSetupExplorer(anchorEl);
  }

  toggleSimulationSessionRoutingPicker(anchorEl) {
    const modal = document.getElementById('simSetupModal');
    if (modal?.classList.contains('open')) {
      this._hideSimulationSetupExplorer({ discard: true });
      return;
    }
    this.openSimulationSessionRoutingPicker(anchorEl);
  }

  closeSimulationSessionRoutingPicker() {
    this._hideSimulationSetupExplorer({ discard: true });
  }

  async _createSimulationRuntimeBrush(brushName = 'boid', gpuOptions = {}) {
    if (brushName !== 'boid') return null;
    const runtimeBrush = new BoidBrush(this);
    await runtimeBrush.init({ useShared: false, gpuOptions });
    if (!runtimeBrush.sim) {
      throw new Error('Failed to initialize isolated boid simulation runtime');
    }
    return runtimeBrush;
  }

  _releaseCachedMultiSessionRuntimeSessions() {
    for (const runtime of this.simulation.cachedRuntimeSessions || []) {
      if (!runtime?.brushInstance) continue;
      this._withSimulationRuntimeContext(runtime, () => {
        runtime.brushInstance.destroy?.();
      });
    }
    this.simulation.cachedRuntimeSessions = [];
  }

  _canReuseCachedMultiSessionRuntimeSessions(bindings) {
    const cached = this.simulation.cachedRuntimeSessions || [];
    if (!cached.length || cached.length !== bindings.length) return false;
    return bindings.every((binding, index) => {
      const runtime = cached[index];
      return !!runtime?.brushInstance
        && runtime.brush === 'boid'
        && runtime.sessionIndex === binding.sessionIndex
        && runtime.layerId === binding.layerId;
    });
  }

  _primeMultiSessionRuntime(runtime, session, layer, p) {
    runtime.brush = 'boid';
    runtime.brushData = _deepClone(session.brushData);
    runtime.vars = _normalizeSimulationVars(session.vars);
    runtime.paramSnapshot = _sanitizeSimulationSessionData(session.paramSnapshot) || {};
    runtime.sensingSourceSelection = _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection);
    runtime.savedPlayback = this._getSimulationSavedPlaybackForRuntime(session);
    runtime.layerId = layer.id;
    runtime.sessionIndex = this.simulation.sessions.indexOf(session);
    runtime.sessionName = session.name;
    runtime.leaderX = this.W * 0.5;
    runtime.leaderY = this.H * 0.5;
    runtime.strokeFrame = 0;
    runtime.playbackCursor = 0;
    runtime.playbackComplete = false;
    this._withSimulationRuntimeContext(runtime, () => {
      runtime.brushInstance.resetSimulationPlaybackState?.({ compositePreview: false });
      this._normalizeSimulationData();
      const runtimeParams = this.getP();
      this._constrainSimulationDataToBounds(runtime.brush, runtimeParams);
      if (runtime.savedPlayback) {
        runtime.brushInstance.prepareSavedPlayback?.(runtime.savedPlayback, runtimeParams);
      } else {
        const allSpawns = this._ensureSimulationSpawns(runtime.brush);
        const spawns = allSpawns.filter(spawn => spawn.enabled !== false);
        const spawn = spawns[0] || allSpawns[0];
        for (const pathItem of this._getSimulationBrushData('boid')?.paths || []) {
          pathItem.travelDistance = 0;
        }
        this._updateSimulationLeader(0, runtimeParams);
        runtime.leaderX = this.leaderX;
        runtime.leaderY = this.leaderY;
        runtime.brushInstance.onDown?.(spawn.x, spawn.y, 1);
        runtime.brushInstance.configureSimulation?.(this._getSimulationBrushData(runtime.brush), runtimeParams);
        runtime.brushInstance.ensureSimulationSpawnAppearance?.(runtimeParams);
      }
    });
  }

  async _createMultiSessionRuntimeSessions(p) {
    const bindings = this._getRunnableSimulationSessionBindings();
    if (this._canReuseCachedMultiSessionRuntimeSessions(bindings)) {
      const runtimes = this.simulation.cachedRuntimeSessions;
      this.simulation.cachedRuntimeSessions = [];
      bindings.forEach((binding, index) => {
        const session = this.simulation.sessions[binding.sessionIndex];
        const layer = this._getLayerById(binding.layerId);
        const runtime = runtimes[index];
        if (!session || !layer || !runtime) return;
        this._primeMultiSessionRuntime(runtime, session, layer, p);
      });
      return runtimes;
    }

    this._releaseCachedMultiSessionRuntimeSessions();

    // Acquire a single shared GPU device for all runtime sessions to avoid
    // exceeding the browser's WebGPU device limit when multiple sims start.
    let gpuOptions = {};
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        const existingSim = this.sharedMotionSim;
        if (existingSim?.device && existingSim?.adapter) {
          gpuOptions = { device: existingSim.device, adapter: existingSim.adapter };
        } else {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            const device = await adapter.requestDevice();
            gpuOptions = { device, adapter };
          }
        }
      } catch (e) {
        console.warn('Multi-session: shared GPU device acquisition failed, sessions will attempt individual devices.', e);
      }
    }

    const runtimes = [];
    let failedCount = 0;
    for (const binding of bindings) {
      const session = this.simulation.sessions[binding.sessionIndex];
      const layer = this._getLayerById(binding.layerId);
      if (!session || !layer) continue;
      const runtime = {
        brush: 'boid',
        brushData: _deepClone(session.brushData),
        vars: _normalizeSimulationVars(session.vars),
        paramSnapshot: _sanitizeSimulationSessionData(session.paramSnapshot) || {},
        sensingSourceSelection: _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection),
        savedPlayback: this._getSimulationSavedPlaybackForRuntime(session),
        layerId: layer.id,
        sessionIndex: binding.sessionIndex,
        sessionName: session.name,
        leaderX: this.W * 0.5,
        leaderY: this.H * 0.5,
        strokeFrame: 0,
        playbackCursor: 0,
        playbackComplete: false,
        brushInstance: null,
      };
      try {
        runtime.brushInstance = await this._createSimulationRuntimeBrush(runtime.brush, gpuOptions);
      } catch (e) {
        console.error(`Multi-session: failed to create runtime for session "${session.name}" → layer "${layer.name}":`, e);
        failedCount++;
        continue;
      }
      this._primeMultiSessionRuntime(runtime, session, layer, p);
      runtimes.push(runtime);
    }
    if (failedCount > 0 && runtimes.length > 0) {
      this.showToast(`${failedCount} session(s) failed to start — running ${runtimes.length} of ${runtimes.length + failedCount}`);
    }
    return runtimes;
  }

  _stepMultiSessionSimulation(elapsed, p) {
    let liveRuntimeCount = 0;
    let savedRuntimeCount = 0;
    let savedRuntimeCompleteCount = 0;
    for (const runtime of this.simulation.runtimeSessions) {
      if (!runtime?.brushInstance) continue;
      if (runtime.savedPlayback) {
        savedRuntimeCount++;
        if (runtime.playbackCursor >= (runtime.savedPlayback.frames?.length || 0)) {
          runtime.playbackComplete = true;
          savedRuntimeCompleteCount++;
          continue;
        }
        this._withSimulationRuntimeContext(runtime, () => {
          const runtimeParams = this.getP();
          this._applySimulationEphemeralFade(runtimeParams);
          runtime.brushInstance.renderSavedPlaybackFrame?.(runtime.savedPlayback, runtime.playbackCursor, runtimeParams);
        });
        runtime.playbackCursor += 1;
        runtime.playbackComplete = runtime.playbackCursor >= runtime.savedPlayback.frames.length;
        if (runtime.playbackComplete) savedRuntimeCompleteCount++;
        continue;
      }
      liveRuntimeCount++;
      this._withSimulationRuntimeContext(runtime, () => {
        const runtimeParams = this.getP();
        this._updateSimulationLeader(elapsed, runtimeParams);
        runtime.leaderX = this.leaderX;
        runtime.leaderY = this.leaderY;
        this._applySimulationEphemeralFade(runtimeParams);
        runtime.brushInstance.onFrame?.(elapsed);
      });
    }
    this._updateSimulationLeader(elapsed, p);
    const allSavedPlaybackComplete = savedRuntimeCount > 0
      && liveRuntimeCount === 0
      && savedRuntimeCompleteCount === savedRuntimeCount;
    if (allSavedPlaybackComplete && this.simulation.running) {
      this._pauseSimulationAtSavedPlaybackEnd();
    }
  }

  _teardownMultiSessionRuntimeSessions({ commitPreview = false, cache = false } = {}) {
    const nextCached = [];
    for (const runtime of this.simulation.runtimeSessions) {
      if (!runtime?.brushInstance) continue;
      this._withSimulationRuntimeContext(runtime, () => {
        if (commitPreview && runtime.brushInstance.onUp) {
          runtime.brushInstance.onUp(runtime.leaderX, runtime.leaderY);
        }
        runtime.brushInstance.deactivate?.();
      });
      if (cache) nextCached.push(runtime);
      else runtime.brushInstance.destroy?.();
    }
    this.simulation.cachedRuntimeSessions = cache ? nextCached : [];
    this.simulation.runtimeSessions = [];
  }


  _renderSimulationInspector() {
    const panel = document.getElementById('simOverlaySidebar');
    const formatPanel = document.getElementById('simFormatMenu');
    const guidesPanel = document.getElementById('guidesPanelEditor');
    if (!panel) return;
    try {
      this._syncSimulationSessionContextUi();
      const uiEnabled = this.simulation.enabled && this._isMotionBrush();
      const simTab = document.querySelector('#rightPanelTabs .panel-tab[data-panel-view="simulation"]');
      if (simTab) simTab.classList.toggle('panel-tab-hidden', !uiEnabled);
      if (!uiEnabled) {
        panel.innerHTML = '';
        // If simulation tab was active, switch back to brush
        if (simTab && simTab.classList.contains('active')) {
          simTab.classList.remove('active');
          panel.classList.remove('active');
          const brushTab = document.querySelector('#rightPanelTabs .panel-tab[data-panel-view="brush"]');
          if (brushTab) brushTab.classList.add('active');
          document.getElementById('sidebar')?.classList.add('active');
        }
        if (formatPanel) {
          formatPanel.innerHTML = '';
          formatPanel.classList.remove('open');
        }
        return;
      }

      const data = this._getSimulationBrushData();
      if (!data) {
        panel.innerHTML = '';
        if (formatPanel) {
          formatPanel.innerHTML = '';
          formatPanel.classList.remove('open');
        }
        return;
      }
      const selected = this._getSelectedSimulationEntry();
      if (this.simulation.selected && !selected) this.simulation.selected = null;
      const p = this.getP();
      const isBoid = this.activeBrush === 'boid';
      const usesPathGuides = this._usesPathGuides();
      const sessionContext = this._getSimulationSessionContextSummary();
      const isSectionOpen = sectionId => this.simulation.inspectorSections?.[sectionId] !== false;
      const renderSection = (sectionId, title, body, { collapsed = false } = {}) => {
        const openSection = collapsed ? false : isSectionOpen(sectionId);
        return `
          <div class="section-header${openSection ? '' : ' closed'}" data-sim-section-toggle="${sectionId}">${_escapeHtml(title)} <span class="chevron">▼</span></div>
          <div class="section-body${openSection ? '' : ' collapsed'}" data-sim-section-body="${sectionId}">
            ${body}
          </div>`;
      };
    const pointItems = data.points || [];
    const attractPoints = [];
    const repelPoints = [];
    for (const point of pointItems) {
      if (point?.type === 'repel') repelPoints.push(point);
      else attractPoints.push(point);
    }
    const groups = [
      { collection: 'spawns', kind: 'spawn', label: 'Spawn', items: data.spawns || [] },
      { collection: 'points', kind: 'point', label: 'Attract Point', items: attractPoints },
      { collection: 'points', kind: 'point', label: 'Repel Point', items: repelPoints },
      ...(usesPathGuides ? [{ collection: 'paths', kind: 'path', label: 'Path Guide', items: data.paths || [] }] : []),
      ...(!isBoid ? [{ collection: 'edges', kind: 'edge', label: 'Edge Barrier', items: data.edges || [] }] : []),
      ...(!isBoid ? [{ collection: 'pheromonePaths', kind: 'pheromonePath', label: 'Pheromone Trail', items: data.pheromonePaths || [] }] : []),
    ];
    const describeSimulationItem = (group, item, idx) => {
      const parts = [`${group.label} ${idx + 1}`];
      if (group.kind === 'spawn') {
        if (item.mask) parts.push('blob');
        else if (item.shape) parts.push(item.shape);
      } else if (group.kind === 'path') {
        if (item.primitiveKind) parts.push(item.primitiveKind);
        parts.push(item.closed ? 'Closed' : 'Open');
      }
      if (item.enabled === false) parts.push('Off');
      return parts.join(' · ');
    };
    const getGuideIcon = (group, item) => {
      if (group.kind === 'spawn') return item.mask ? '◉' : '◎';
      if (group.kind === 'path') return item.primitiveKind ? '⬡' : '≈';
      if (group.kind === 'edge') return '⛶';
      if (group.kind === 'pheromonePath') return '∿';
      return item.type === 'repel' ? '↘' : '↗';
    };
    const getGuideMeta = (group, item) => {
      if (group.kind === 'spawn') {
        if (item.mask?.bounds) return `${Math.round(item.mask.bounds.width)}×${Math.round(item.mask.bounds.height)} blob`;
        const radius = Number.isFinite(item.radius) ? `${Math.round(item.radius)}px` : 'Brush radius';
        const shape = item.shape || 'Brush shape';
        return `${shape} · ${radius}`;
      }
      if (group.kind === 'path') {
        const pointCount = Array.isArray(item.points) ? item.points.length : 0;
        const speedPoints = Array.isArray(item.speedPoints) ? item.speedPoints.length : 0;
        const radiusPoints = Array.isArray(item.radiusPoints) ? item.radiusPoints.length : 0;
        const strengthPoints = Array.isArray(item.strengthPoints) ? item.strengthPoints.length : 0;
        const extras = [
          speedPoints ? `${speedPoints} spd` : '',
          radiusPoints ? `${radiusPoints} rad` : '',
          strengthPoints ? `${strengthPoints} str` : '',
        ].filter(Boolean).join(' · ');
        return `${item.closed ? 'Closed' : 'Open'} · ${pointCount} pts${extras ? ` · ${extras}` : ''}`;
      }
      if (group.kind === 'edge') {
        return `${Array.isArray(item.points) ? item.points.length : 0} pts · ${Math.round(item.radius || 0)}px radius`;
      }
      if (group.kind === 'pheromonePath') {
        return `${Array.isArray(item.points) ? item.points.length : 0} pts · ${(item.intensity ?? 0).toFixed(2)} intensity`;
      }
      return `${item.type === 'repel' ? 'Repel' : 'Attract'} · ${Math.round(item.radius || 0)}px radius`;
    };
    const sectionKeyForGroup = group => {
      if (group.kind === 'point') return group.label.toLowerCase().includes('repel') ? 'repelPoints' : 'attractPoints';
      if (group.kind === 'path') return 'paths';
      if (group.kind === 'edge') return 'edges';
      if (group.kind === 'pheromonePath') return 'pheromonePaths';
      return group.collection;
    };
    const groupBySectionKey = Object.fromEntries(groups.map(group => [sectionKeyForGroup(group), group]));
    const renderGuideLayerList = group => {
      if (!group?.items?.length) return '<div class="sim-inspector-note">No items yet.</div>';
      return `<div class="sim-guide-layer-list">${group.items.map((item, idx) => `
        <div class="sim-guide-layer ${selected?.id === item.id && selected?.collection === group.collection ? 'active' : ''} ${item.enabled === false ? 'disabled' : ''}" data-sim-select="1" data-sim-collection="${group.collection}" data-sim-kind="${group.kind}" data-sim-id="${item.id}" tabindex="0" role="button" aria-pressed="${selected?.id === item.id && selected?.collection === group.collection ? 'true' : 'false'}">
          <div class="sim-guide-layer-icon">${_escapeHtml(getGuideIcon(group, item))}</div>
          <div class="sim-guide-layer-main">
            <div class="sim-guide-layer-title">${_escapeHtml(describeSimulationItem(group, item, idx))}</div>
            <div class="sim-guide-layer-meta">${_escapeHtml(getGuideMeta(group, item))}</div>
          </div>
          <div class="sim-guide-layer-actions">
            <button type="button" class="sim-guide-layer-toggle ${item.enabled !== false ? 'active' : ''}" data-sim-toggle-item="1" data-sim-collection="${group.collection}" data-sim-id="${item.id}">${item.enabled !== false ? 'On' : 'Off'}</button>
            <button type="button" class="sim-guide-layer-delete" data-sim-delete-item="1" data-sim-collection="${group.collection}" data-sim-id="${item.id}">×</button>
          </div>
        </div>`).join('')}</div>`;
    };
    const renderInspectorSubgroup = (title, body) => `
      <div class="sim-inspector-subgroup">
        <div class="sim-inspector-subgroup-title">${_escapeHtml(title)}</div>
        ${body}
      </div>`;
    const renderTypeSection = (sectionId, title, parts, { collapsed = false } = {}) => {
      const body = parts.filter(Boolean).join('');
      if (!body) return '';
      return renderSection(sectionId, title, body, { collapsed });
    };

    const formatSimVarValue = (varName, value) => {
      if (!Number.isFinite(value)) return 'Brush def.';
      switch (varName) {
        case 'maxSpeed':
          return value.toFixed(1);
        case 'damping':
          return value.toFixed(2);
        case 'sensingRadius':
        case 'sensingFitRadius':
          return `${Math.round(value)}px`;
        case 'sensingUpdateFrames':
          return `${Math.round(value)}f`;
        default:
          return `${Math.round(value * 100)}%`;
      }
    };
    const formatSimInputNumber = (value, digits = 2) => {
      if (!Number.isFinite(value)) return '';
      return String(Number(value.toFixed(digits)));
    };
    const getSimParamDisplayMeta = (id, raw) => {
      switch (id) {
        case 'simSpeed':
          return { value: raw / 100, min: 0.1, max: 3, step: 0.01, digits: 2 };
        case 'simPointStrength':
        case 'simEdgeForce':
        case 'simPheroPaintStrength':
        case 'simEphemeralFade': {
          const max = {
            simPointStrength: 2,
            simEdgeForce: 2,
            simPheroPaintStrength: 1,
            simEphemeralFade: 3,
          }[id] ?? 2;
          return { value: raw / 100, min: 0, max, step: 0.01, digits: 2 };
        }
        default:
          return { value: raw, min: null, max: null, step: null, digits: Number.isInteger(raw) ? 0 : 2 };
      }
    };
    const simParamDisplayToRaw = (id, displayValue) => {
      switch (id) {
        case 'simSpeed':
        case 'simPointStrength':
        case 'simEdgeForce':
        case 'simPheroPaintStrength':
        case 'simEphemeralFade':
          return displayValue * 100;
        default:
          return displayValue;
      }
    };
    const renderCompactSimNumberInput = ({ datasetAttr, id, value, min, max, step, placeholder = '' }) => {
      const placeholderAttr = placeholder ? ` placeholder="${placeholder}"` : '';
      return `<input type="number" class="sim-slider-number" min="${min}" max="${max}" step="${step}" value="${value}" data-sim-input-kind="number" ${datasetAttr}="${id}"${placeholderAttr}>`;
    };
    const simVarSlider = ({ id, label, min, max, step, scale, value, desc }) => {
      const resolved = Number.isFinite(value) ? value : 0;
      const sliderValue = resolved / scale;
      const numberMin = min * scale;
      const numberMax = max * scale;
      const numberStep = step * scale;
      return `
        <div class="sim-slider-row">
          <div class="sim-slider-header">
            <span class="sim-slider-label">${label}</span>
            <span class="sim-inspector-value" data-sim-var-label="${id}">${formatSimVarValue(id, resolved)}</span>
          </div>
          <div class="sim-slider-controls">
            <input type="range" min="${min}" max="${max}" step="${step}" value="${sliderValue}" data-sim-var="${id}" data-sim-var-scale="${scale}" data-sim-input-kind="range">
            ${renderCompactSimNumberInput({ datasetAttr: 'data-sim-var', id, value: formatSimInputNumber(resolved, scale < 1 ? 2 : 1), min: numberMin, max: numberMax, step: numberStep })}
          </div>
          ${desc ? `<div class="sim-inspector-note" style="margin-top:4px">${desc}</div>` : ''}
        </div>`;
    };
    const seekValue = Number.isFinite(this.simulation.vars.seek) ? this.simulation.vars.seek : DEFAULT_SIM_SEEK;
    const cohesionValue = Number.isFinite(this.simulation.vars.cohesion) ? this.simulation.vars.cohesion : p.cohesion;
    const separationValue = Number.isFinite(this.simulation.vars.separation) ? this.simulation.vars.separation : p.separation;
    const alignmentValue = Number.isFinite(this.simulation.vars.alignment) ? this.simulation.vars.alignment : p.alignment;
    const maxSpeedValue = Number.isFinite(this.simulation.vars.maxSpeed) ? this.simulation.vars.maxSpeed : p.maxSpeed;
    const dampingValue = Number.isFinite(this.simulation.vars.damping) ? this.simulation.vars.damping : p.damping;
    const formatSimPanelValue = (id, value) => {
      switch (id) {
        case 'simSpeed': return `${(value / 100).toFixed(1)}×`;
        case 'simPointStrength':
        case 'simEdgeForce':
        case 'simPheroPaintStrength':
        case 'simEphemeralFade':
          return (value / 100).toFixed(2);
        case 'simBoundsMargin':
          return Math.round(value) >= SIM_NEAR_INFINITE_BOUNDS_MARGIN
            ? 'Near-infinite'
            : `${Math.round(value)}px`;
        case 'simPathSpeed':
          return `${Math.round(value)}px/s`;
        case 'simEphemeralFrames':
          return `${Math.round(value)}f`;
        default:
          return String(Math.round(value));
      }
    };
    const simPanelCheckbox = ({ id, label, desc }) => `
      <label class="sim-inspector-row" style="margin:4px 0">
        <span>${label}</span>
        <input type="checkbox" data-sim-param="${id}" ${document.getElementById(id)?.checked ? 'checked' : ''}>
      </label>
      ${desc ? `<div class="sim-inspector-note" style="margin-top:2px">${desc}</div>` : ''}`;
    const simPanelSlider = ({ id, label, min, max, value, desc, step = 1 }) => {
      const numberMeta = getSimParamDisplayMeta(id, value);
      const numberMin = numberMeta.min ?? getSimParamDisplayMeta(id, min).value;
      const numberMax = numberMeta.max ?? getSimParamDisplayMeta(id, max).value;
      const numberStep = numberMeta.step ?? Math.max(getSimParamDisplayMeta(id, step).value, 0.01);
      return `
      <div class="sim-slider-row">
        <div class="sim-slider-header">
          <span class="sim-slider-label">${label}</span>
          <span class="sim-inspector-value" data-sim-param-label="${id}">${formatSimPanelValue(id, value)}</span>
        </div>
        <div class="sim-slider-controls">
          <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-sim-param="${id}" data-sim-input-kind="range">
          ${renderCompactSimNumberInput({ datasetAttr: 'data-sim-param', id, value: formatSimInputNumber(numberMeta.value, numberMeta.digits), min: numberMin, max: numberMax, step: numberStep })}
        </div>
        ${desc ? `<div class="sim-inspector-note" style="margin-top:4px">${desc}</div>` : ''}
      </div>`;
    };
    const playbackSettingsBody = `
      ${simPanelCheckbox({
        id: 'simEphemeralMode',
        label: 'Ephemeral Mode',
        desc: 'Continuously fades older simulation stamps so trails clear over time.',
      })}
      ${simPanelSlider({
        id: 'simSpeed',
        label: 'Playback Speed',
        min: 10,
        max: 300,
        value: Math.round(p.simSpeed * 100),
        desc: 'Playback multiplier for autonomous painting.',
      })}
      ${simPanelSlider({
        id: 'simEphemeralFrames',
        label: 'Trail Length',
        min: 1,
        max: 240,
        value: Math.round(p.simEphemeralFrames || 45),
        desc: 'Approximate frame lifetime before older stamps disappear in Ephemeral Mode.',
      })}
      ${simPanelSlider({
        id: 'simEphemeralFade',
        label: 'Fade Speed',
        min: 10,
        max: 300,
        value: Math.round((p.simEphemeralFade || 1) * 100),
        desc: 'How quickly old paint fades each frame (lower = longer trails).',
      })}
      ${simPanelSlider({
        id: 'simBoundsMargin',
        label: 'Bounds Margin',
        min: 0,
        max: SIM_NEAR_INFINITE_BOUNDS_MARGIN,
        value: Math.round(p.simBoundsMargin || 0),
        desc: 'Extends the simulation bounds beyond the canvas edge. Increase it for near-infinite boid, ant, and guide movement in simulation mode.',
      })}`;
    const pointSettingsBody = `
      ${simPanelSlider({
        id: 'simPointStrength',
        label: 'Point Force',
        min: 0,
        max: 200,
        value: Math.round(p.simPointStrength * 100),
      })}
      ${simPanelSlider({
        id: 'simPointRadius',
        label: 'Point Radius',
        min: 10,
        max: 300,
        value: Math.round(p.simPointRadius),
        desc: 'Attract and repel points share these defaults until an item override is set.',
      })}`;
    const pathSettingsBody = usesPathGuides
      ? `${simPanelSlider({
          id: 'simPathSpeed',
          label: 'Path Speed',
          min: 1,
          max: 200,
          value: Math.round(p.simPathSpeed),
          desc: 'How many pixels per second animated path guides travel, regardless of path length.',
        })}
        <div class="sim-inspector-note">Use the Path tool in Simulation mode to animate an attraction point along the guide stroke while boids paint.</div>`
      : '';
    const pathPrimitiveButtons = usesPathGuides
      ? `<div class="sim-inspector-actions" style="margin-top:4px">${SIM_PATH_PRIMITIVE_KINDS.map(kind => `<button data-sim-add-path-primitive="${kind}">${kind[0].toUpperCase()}${kind.slice(1)}</button>`).join('')}</div>
         <div class="sim-inspector-note">Insert reusable path primitives directly onto the canvas, then drag the teal size handle to resize them.</div>`
      : '';
    const edgeSettingsBody = !isBoid
      ? `${simPanelSlider({
          id: 'simEdgeForce',
          label: 'Edge Force',
          min: 0,
          max: 200,
          value: Math.round(p.simEdgeForce * 100),
        })}
        ${simPanelSlider({
          id: 'simEdgeRadius',
          label: 'Avoid Radius',
          min: 0,
          max: 200,
          value: Math.round(p.simEdgeRadius),
        })}`
      : '';
    const pheromoneSettingsBody = !isBoid
      ? `${simPanelSlider({
          id: 'simPheroPaintRadius',
          label: 'Phero Radius',
          min: 2,
          max: 80,
          value: Math.round(p.simPheroPaintRadius),
        })}
        ${simPanelSlider({
          id: 'simPheroPaintStrength',
          label: 'Phero Paint',
          min: 0,
          max: 100,
          value: Math.round(p.simPheroPaintStrength * 100),
          desc: 'Use the Edge tool for barriers and the Pheromone tool to paint visible pheromone trails that ants will follow.',
        })}`
      : '';
    const boidForcesBody = `
      <div class="sim-inspector-note">These runtime overrides apply immediately while boids are already in motion.</div>
      ${simVarSlider({ id: 'seek', label: 'Seek (cursor pull)', min: 0, max: 100, step: 0.5, scale: 0.01, value: seekValue, desc: 'Defaults to 0 in simulation mode so guides dominate until you pull boids back toward the cursor.' })}
      ${simVarSlider({ id: 'cohesion', label: 'Cohesion', min: 0, max: 100, step: 0.5, scale: 0.01, value: cohesionValue })}
      ${simVarSlider({ id: 'separation', label: 'Separation', min: 0, max: 100, step: 0.5, scale: 0.01, value: separationValue })}
      ${simVarSlider({ id: 'alignment', label: 'Alignment', min: 0, max: 100, step: 0.5, scale: 0.01, value: alignmentValue })}`;
    const boidMotionBody = `
      <div class="sim-inspector-note">Motion overrides affect already-running boids without forcing a respawn.</div>
      ${simVarSlider({ id: 'maxSpeed', label: 'Max Speed', min: 1, max: 30, step: 0.5, scale: 0.5, value: maxSpeedValue })}
      ${simVarSlider({ id: 'damping', label: 'Damping', min: 80, max: 100, step: 0.5, scale: 0.01, value: dampingValue })}`;
    const boidSensingBody = `
      <div class="sim-inspector-note">Use the sidebar Pixel Sensing controls while this session is loaded. Those drawing-mode controls are saved with the active simulation session and applied per runtime during multi-session playback.</div>`;
    const activeSavedSession = this.simulation.activeSessionIndex >= 0
      ? this.simulation.sessions[this.simulation.activeSessionIndex] || null
      : null;
    const stageLayerOptions = isBoid ? this._getSimulationTargetLayers() : [];
    const sensingLayerOptions = isBoid
      ? this.layers.map(layer => ({ id: layer.id, name: layer.name || layer.id, isBackground: !!layer.isBackground }))
      : [];
    const stageSessionCards = isBoid
      ? (() => {
          const draft = this._createSimulationSetupDraft();
          if (!draft.rows.length) {
            return '<div class="sim-inspector-note">Save the draft session to create reusable stage sessions.</div>';
          }
          return `<div class="sim-stage-list">${draft.rows.map(row => {
            const session = this.simulation.sessions[row.sessionIndex] || null;
            if (!session) return '';
            const isEditing = row.sessionIndex === this.simulation.activeSessionIndex;
            const playbackStatus = this._getSimulationSavedPlaybackStatus(session);
            const playbackBadgeTone = this._getSimulationSavedPlaybackBadgeTone(playbackStatus);
            const normalizedLayerIds = this._normalizeSimulationLayerIds(row.layerIds, row.sessionIndex);
            const selectedLayerIdSet = new Set(normalizedLayerIds);
            const selectedSensingLayerSet = new Set(row.sensingLayerIds);
            const routeCount = normalizedLayerIds.length;
            const routeSummary = this._buildSimulationSetupLayerSummary(normalizedLayerIds, row.sessionIndex);
            const sensingSummary = this._buildSimulationSetupSensingSummary(row);
            const sensingLayersDisabled = row.sensingSource !== 'selected';
            return `
              <details class="sim-stage-card${isEditing ? ' editing' : ''}" ${isEditing ? 'open' : ''}>
                <summary class="sim-stage-card-summary">
                  <div class="sim-stage-card-main">
                    <div class="sim-stage-card-titleRow">
                      <span class="sim-stage-card-title">${_escapeHtml(session.name || `Session ${row.sessionIndex + 1}`)}</span>
                      ${isEditing ? '<span class="sim-stage-badge active">Draft loaded</span>' : ''}
                      <span class="sim-stage-badge${row.enabled ? '' : ' muted'}">${row.enabled ? 'Mounted' : 'Off'}</span>
                      <span class="sim-stage-badge ${playbackBadgeTone}">${_escapeHtml(playbackStatus.badge)}</span>
                    </div>
                    <div class="sim-stage-card-meta">Stage: ${_escapeHtml(routeSummary)} · Sensing: ${_escapeHtml(sensingSummary)} · ${routeCount} route${routeCount === 1 ? '' : 's'}</div>
                  </div>
                  <span class="sim-stage-card-caret" aria-hidden="true">▾</span>
                </summary>
                <div class="sim-stage-card-body">
                  <div class="sim-stage-row">
                    <div class="sim-inspector-note">${isEditing ? 'This saved session is the active draft on the canvas.' : 'Load this session to edit its guides and overrides on the canvas.'}</div>
                    <div class="sim-inspector-actions">
                      <button data-sim-stage-edit-session="${row.sessionIndex}">${isEditing ? 'Loaded' : 'Load into Draft'}</button>
                    </div>
                  </div>
                  <label class="sim-inspector-row">
                    <span>
                      <span>Mount on Stage</span>
                      <span class="sim-inspector-note" style="display:block;margin-top:2px">Enable this saved session for multi-session playback routing.</span>
                    </span>
                    <input type="checkbox" data-sim-stage-enabled="${row.sessionIndex}" ${row.enabled ? 'checked' : ''}>
                  </label>
                  <div class="sim-stage-field">
                    <div class="sim-stage-field-label">Target Layer(s)</div>
                    <div class="sim-stage-checklist">
                      ${stageLayerOptions.map(layer => {
                        const checked = selectedLayerIdSet.has(layer.id);
                        return `
                          <label class="sim-stage-check">
                            <input type="checkbox" data-sim-stage-layer="${row.sessionIndex}" value="${_escapeHtml(layer.id)}" ${checked ? 'checked' : ''}>
                            <span>${_escapeHtml(layer.name || layer.id)}${layer.isBackground ? ' (Background)' : ''}</span>
                          </label>`;
                      }).join('')}
                    </div>
                  </div>
                  <label class="sim-inspector-row">
                    <span>
                      <span>Session Sensing</span>
                      <span class="sim-inspector-note" style="display:block;margin-top:2px">Keep sensing attached to the saved session instead of the general sidebar.</span>
                    </span>
                    <input type="checkbox" data-sim-stage-sensing-enabled="${row.sessionIndex}" ${row.sensingEnabled ? 'checked' : ''}>
                  </label>
                  <div class="sim-stage-field">
                    <div class="sim-stage-field-label">Sensing Source</div>
                    <select class="sim-stage-select" data-sim-stage-sensing-source="${row.sessionIndex}">
                      <option value="below" ${row.sensingSource === 'below' ? 'selected' : ''}>Layers below active</option>
                      <option value="all" ${row.sensingSource === 'all' ? 'selected' : ''}>All visible layers</option>
                      <option value="active" ${row.sensingSource === 'active' ? 'selected' : ''}>Active layer only</option>
                      <option value="selected" ${row.sensingSource === 'selected' ? 'selected' : ''}>Custom selected layers</option>
                    </select>
                  </div>
                  <div class="sim-stage-field${sensingLayersDisabled ? ' muted' : ''}">
                    <div class="sim-stage-field-label">Selected Sensing Layers</div>
                    <div class="sim-stage-checklist">
                      ${sensingLayerOptions.map(layer => {
                        const checked = selectedSensingLayerSet.has(layer.id);
                        return `
                          <label class="sim-stage-check">
                            <input type="checkbox" data-sim-stage-sensing-layer="${row.sessionIndex}" value="${_escapeHtml(layer.id)}" ${checked ? 'checked' : ''} ${sensingLayersDisabled ? 'disabled' : ''}>
                            <span>${_escapeHtml(layer.name)}${layer.isBackground ? ' (Background)' : ''}</span>
                          </label>`;
                      }).join('')}
                    </div>
                  </div>
                  <div class="sim-inspector-note">${_escapeHtml(playbackStatus.summary)}</div>
                </div>
              </details>`;
          }).join('')}</div>`;
        })()
      : '';
    const activePlaybackStatus = this._getSimulationSavedPlaybackStatus(activeSavedSession);
    const activePlaybackBadgeTone = this._getSimulationSavedPlaybackBadgeTone(activePlaybackStatus);
    const savedSessionControls = isBoid
      ? `
        <div class="sim-inspector-note">Use the brush sidebar or this editor to keep session-specific boid settings, guide edits, and stage routing together.</div>
        ${renderInspectorSubgroup('Active Session Draft', `
          <div class="sim-stage-draft">
            <div class="sim-stage-draft-title">${activeSavedSession ? `Editing saved session “${_escapeHtml(activeSavedSession.name || 'Untitled')}”` : 'Editing unsaved draft session'}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 4px;">
              <span class="sim-stage-badge ${activePlaybackBadgeTone}">${_escapeHtml(activePlaybackStatus.badge)}</span>
            </div>
            <div class="sim-inspector-note">${_escapeHtml(sessionContext.editorSummary)}</div>
            <div class="sim-inspector-note">${_escapeHtml(activePlaybackStatus.summary)}</div>
            <label class="sim-inspector-row">
              <span>
                <span>Multi-Session Playback</span>
                <span class="sim-inspector-note" style="display:block;margin-top:2px">Route multiple saved sessions to different layers from this single stage panel.</span>
              </span>
              <input type="checkbox" data-sim-multi-toggle="1" ${this.simulation.multiSessionEnabled ? 'checked' : ''}>
            </label>
            <div class="sim-inspector-actions">
              <button data-sim-new-session="1">New Draft</button>
              <button data-sim-save-session="1">${activeSavedSession ? 'Update Saved Session' : 'Save Draft Session'}</button>
              ${activeSavedSession ? '<button class="danger" data-sim-delete-active-session="1">Delete Saved Session</button>' : ''}
            </div>
            <div class="sim-inspector-note">${_escapeHtml(this._buildSimulationSessionRoutingSummary())}</div>
          </div>
        `)}
        ${renderInspectorSubgroup('Saved Sessions / Stage', stageSessionCards)}
        ${renderInspectorSubgroup('Workspace', `
          <div class="sim-inspector-actions">
            <button data-sim-export-setup="1">Save Setup JSON</button>
            <button data-sim-import-setup="1">Load Setup JSON</button>
            <button data-sim-export-workspace="1">Save Workspace File</button>
            <button data-sim-import-workspace="1">Open Workspace File</button>
          </div>
        `)}
      `
      : '';

    const boidSettingsSection = isBoid
      ? renderTypeSection('boidSettings', 'Simulation Boid Settings', [
          renderInspectorSubgroup('Forces', boidForcesBody),
          renderInspectorSubgroup('Motion', boidMotionBody),
        ])
      : '';
    const pixelSensingSection = isBoid
      ? renderTypeSection('pixelSensing', 'Simulation Pixel Sensing', [
          renderInspectorSubgroup('Per-Session Sensing', boidSensingBody),
        ])
      : '';
    const pointSection = renderTypeSection('pointSettings', 'Points', [
      renderInspectorSubgroup('Defaults', pointSettingsBody),
      renderInspectorSubgroup('Attract Points', renderGuideLayerList(groupBySectionKey.attractPoints)),
      renderInspectorSubgroup('Repel Points', renderGuideLayerList(groupBySectionKey.repelPoints)),
    ]);
    const pathSection = isBoid
      ? renderTypeSection('paths', 'Paths', [
          renderInspectorSubgroup('Add Primitive', pathPrimitiveButtons),
          renderInspectorSubgroup('Defaults', pathSettingsBody),
          renderInspectorSubgroup('Path Guides', renderGuideLayerList(groupBySectionKey.paths)),
        ])
      : '';
    const spawnSection = renderTypeSection('spawns', 'Spawns', [
      `<div class="sim-inspector-note">Select a spawn to override its count, shape, radius, and other per-spawn behavior. Shared drawing-mode spawn defaults still live in the main sidebar.</div>`,
      renderInspectorSubgroup('Spawn Items', renderGuideLayerList(groupBySectionKey.spawns)),
    ]);
    const edgeSection = !isBoid
      ? renderTypeSection('edges', 'Edge Barriers', [
          renderInspectorSubgroup('Defaults', edgeSettingsBody),
          renderInspectorSubgroup('Barrier Items', renderGuideLayerList(groupBySectionKey.edges)),
        ])
      : '';
    const pheromoneSection = !isBoid
      ? renderTypeSection('pheromonePaths', 'Pheromone Trails', [
          renderInspectorSubgroup('Defaults', pheromoneSettingsBody),
          renderInspectorSubgroup('Trail Items', renderGuideLayerList(groupBySectionKey.pheromonePaths)),
        ])
      : '';

    const sessionCardMarkup = isBoid
      ? renderSimulationSessionCard({
          title: 'Simulation Session',
          badgeTone: sessionContext.isSaved ? 'active' : 'muted',
          badgeLabel: _escapeHtml(sessionContext.typeLabel),
          sessionSelectMarkup: `
            <label class="sim-session-switcher">
              <span>Session Selector</span>
              <select class="sim-stage-select" data-sim-active-session-select ${this.simulation.sessions.length ? '' : 'disabled'}>
                <option value="" ${sessionContext.isSaved ? '' : 'selected'} disabled>${sessionContext.isSaved ? 'Choose a saved session...' : 'Unsaved Draft'}</option>
                ${this.simulation.sessions.map((session, index) => `<option value="${index}" ${index === sessionContext.activeIndex ? 'selected' : ''}>${_escapeHtml(session.name || `Session ${index + 1}`)}</option>`).join('')}
              </select>
            </label>`,
          actionsMarkup: `
            <button data-sim-new-session="1">New Draft</button>
            <button data-sim-save-session="1">${sessionContext.isSaved ? 'Update Saved Session' : 'Save Draft Session'}</button>
            <button data-sim-open-setup="1">Stage Setup</button>
            <button data-sim-open-inspector="1">Session Editor</button>`,
          sessionName: _escapeHtml(sessionContext.sidebarTitle),
          sessionMeta: _escapeHtml(sessionContext.sidebarSummary),
        })
      : '';

    let inspector = `
      ${isBoid ? `
        <div class="sim-inspector-sessionBar">
          ${sessionCardMarkup}
        </div>
      ` : `
        <div class="sim-inspector-header">
          <div class="sim-inspector-title">Simulation Scene Editor</div>
        </div>
      `}
      ${isBoid ? `
        <div class="sim-session-context">
          <div class="sim-session-context-main">
            <div class="sim-session-context-eyebrow">Active Session</div>
            <div class="sim-session-context-titleRow">
              <div class="sim-session-context-title">${_escapeHtml(sessionContext.name)}</div>
              <span class="sim-stage-badge ${sessionContext.isSaved ? 'active' : 'muted'}">${_escapeHtml(sessionContext.typeLabel)}</span>
              <span class="sim-stage-badge muted">Drawing defaults stay in sidebar</span>
            </div>
            <div class="sim-session-context-meta">${_escapeHtml(sessionContext.editorSummary)}</div>
            <div class="sim-session-context-meta">${_escapeHtml(sessionContext.routingSummary)}</div>
            <div class="sim-inspector-note">Use the sticky session selector above to switch which session these controls edit while you scroll through the inspector.</div>
          </div>
        </div>
      ` : ''}
      <div class="sim-guide-panel-summary">Current tool: <strong>${this.simulation.editorTool}</strong> · Playback speed <strong data-sim-summary="simSpeed">${p.simSpeed.toFixed(1)}×</strong> · ${selected ? `Selected <strong>${_escapeHtml(selected.kind === 'point' ? selected.target.type : selected.kind)}</strong>` : 'Select a guide to edit it.'}</div>
      ${renderSection('scene', 'Scene', `<div class="sim-inspector-note">Global simulation controls live here. Guide-specific overrides move into the floating format card so the layer list stays compact.</div>`) }
      ${renderTypeSection('playback', 'Playback & Bounds', [
        renderInspectorSubgroup('Playback', playbackSettingsBody),
      ])}
      ${pixelSensingSection}
      ${boidSettingsSection}
      ${pointSection}
      ${pathSection}
      ${spawnSection}
      ${edgeSection}
      ${pheromoneSection}
      ${renderSection('sceneVariables', isBoid ? 'Session Workspace' : 'Scene Variables', `<div class="sim-inspector-note">${isBoid ? 'Save and restore the current simulation scene, runtime overrides, and session routing state.' : 'Override brush parameters for simulation playback. Seek defaults to 0 so agents follow guides instead of the cursor.'}</div>
        ${isBoid ? savedSessionControls : `<div class="sim-inspector-actions" style="margin-top:10px"><button data-sim-new-session="1">New Session</button><button data-sim-save-session="1">Save Session</button></div>`}`)}
    `;

    let formatMarkup = '';
    let guideEditorMarkup = '';
    const selectionOverlayEnabled = this._isSimulationSelectionOverlayEnabled();

    if (!selected) {
      inspector += renderSection('selection', 'No Selection', `<div class="sim-inspector-note">Select a spawn, ${usesPathGuides ? 'attract point, repel point, or path guide' : 'attract point, repel point, edge barrier, or pheromone trail'} on the canvas or from the lists above to edit its per-item overrides.</div>`, { collapsed: false });
      guideEditorMarkup = `
        <div class="sim-guide-panel-summary">Select a guide in simulation mode to edit its per-item overrides here.</div>
        <div class="sim-inspector-note">Spawn, point, path, edge, and pheromone guide settings now live in this left-side drawer instead of the floating overlay.</div>
      `;
    } else {
      const target = selected.target;

      // Helper: render a slider row for a numeric override field.
      // Slider value = stored value / scale  (e.g. scale=0.01 → slider 0-200 maps to stored 0-2.0).
      // When the field is not set on target, shows "Brush def." and places thumb at midpoint.
      const simSlider = (field, type, label, min, max, step, scale, showNumberInput = false) => {
        const raw = target[field];
        const isSet = Number.isFinite(raw);
        let sliderVal;
        if (isSet) {
          sliderVal = type === 'angle'
            ? Math.round(_formatAngleDegrees(raw))
            : Math.round(raw / scale);
        } else {
          sliderVal = Math.round((+min + +max) / 2);
        }
        const fmtStored = v => {
          if (type === 'angle') return v + '°';
          if (type === 'integer') return String(Math.round(v));
          return scale < 1 ? v.toFixed(2) : v.toFixed(1);
        };
        const displayVal = isSet
          ? fmtStored(type === 'angle' ? sliderVal : sliderVal * scale)
          : 'Brush def.';
        const unset = isSet ? '' : ' data-sim-unset="1"';
        const resetOpacity = isSet ? '' : ' style="opacity:0.35"';
        const inputVal = isSet
          ? (type === 'angle' ? Math.round(_formatAngleDegrees(raw)) : (type === 'integer' ? Math.round(raw) : raw))
          : '';
        return `<div class="sim-slider-row">
          <div class="sim-slider-header">
            <span class="sim-slider-label">${label}</span>
            <div class="sim-slider-meta">
              <span class="sim-inspector-value" data-sim-val-label="${field}">${displayVal}</span>
              <button class="sim-fld-reset" data-sim-reset="${field}" title="Match current default"${resetOpacity}>×</button>
            </div>
          </div>
          <div class="sim-slider-controls">
            <input type="range" min="${min}" max="${max}" step="${step}" value="${sliderVal}"
                   data-sim-field="${field}" data-sim-type="${type}" data-sim-scale="${scale}" data-sim-input-kind="range"${unset}>
            <input type="number" class="sim-slider-number" min="${type === 'angle' ? -180 : (type === 'integer' ? Math.round(min * scale) : min * scale)}" max="${type === 'angle' ? 180 : (type === 'integer' ? Math.round(max * scale) : max * scale)}" step="${type === 'integer' ? 1 : (type === 'angle' ? 1 : scale < 1 ? scale : step * scale)}" value="${inputVal}" placeholder="Brush def."
                   data-sim-field="${field}" data-sim-type="${type}" data-sim-scale="${scale}" data-sim-input-kind="number"${unset}>
          </div>
        </div>`;
      };
      const activePopover = this._simFormatMenuUi.activePopover;
      const compactColorControl = (field, fallbackColor = p.color) => {
        const raw = _normalizeHexColor(target[field]);
        const isSet = !!raw;
        const value = raw || _normalizeHexColor(fallbackColor, '#1a1a1a');
        return `<button type="button" class="sim-format-color" title="Color" data-sim-color-trigger="${field}"${isSet ? '' : ' data-sim-unset="1"'}><span class="sim-format-colorChip" style="background:${value}"></span></button><input type="hidden" value="${value}" data-sim-field="${field}" data-sim-type="color"${isSet ? '' : ' data-sim-unset="1"'}>`;
      };
      const compactNumberControl = (field, type, label, min, max, step, scale) => {
        const raw = target[field];
        const isSet = Number.isFinite(raw);
        const sliderVal = isSet
          ? (type === 'angle' ? Math.round(_formatAngleDegrees(raw)) : Math.round(raw / scale))
          : Math.round((+min + +max) / 2);
        const inputVal = isSet
          ? (type === 'angle' ? Math.round(_formatAngleDegrees(raw)) : (type === 'integer' ? Math.round(raw) : formatSimInputNumber(raw, scale < 1 ? 2 : 1)))
          : '';
        const open = activePopover === field;
        return `<div class="sim-format-chip sim-format-chip-number" data-sim-format-chip="${field}">
          <span class="sim-format-chip-label">${label}:</span>
          <input type="number" class="sim-format-number" min="${type === 'angle' ? -180 : (type === 'integer' ? Math.round(min * scale) : min * scale)}" max="${type === 'angle' ? 180 : (type === 'integer' ? Math.round(max * scale) : max * scale)}" step="${type === 'integer' ? 1 : (type === 'angle' ? 1 : scale < 1 ? scale : step * scale)}" value="${inputVal}" placeholder="--"
                 data-sim-field="${field}" data-sim-type="${type}" data-sim-scale="${scale}" data-sim-input-kind="number">
          <button type="button" class="sim-format-trigger" data-sim-format-toggle="${field}" aria-expanded="${open ? 'true' : 'false'}">▾</button>
          <div class="sim-format-popover sim-format-slider-popover ${open ? 'open' : ''}" data-sim-format-popover="${field}">
            <div class="sim-format-slider-wrap">
              <input type="range" class="sim-format-slider" min="${min}" max="${max}" step="${step}" value="${sliderVal}"
                     data-sim-field="${field}" data-sim-type="${type}" data-sim-scale="${scale}" data-sim-input-kind="range"${isSet ? '' : ' data-sim-unset="1"'}>
            </div>
          </div>
        </div>`;
      };
      const compactChoiceControl = (field, label, options, value = '') => `
        <label class="sim-format-chip sim-format-chip-select">
          <span class="sim-format-chip-label">${label}:</span>
          <select class="sim-format-select" data-sim-field="${field}" data-sim-type="select">
            ${options.map(option => `<option value="${option.value}" ${String(value) === String(option.value) ? 'selected' : ''}>${_escapeHtml(option.label)}</option>`).join('')}
          </select>
        </label>`;
      const compactToggleControl = (field, label, checkedValue) => `
        <label class="sim-format-chip sim-format-chip-toggle">
          <span class="sim-format-chip-label">${label}</span>
          <input type="checkbox" data-sim-field="${field}" data-sim-type="bool" ${checkedValue ? 'checked' : ''}>
        </label>`;
      const guideColorRow = (field, label, fallbackColor = p.color) => `
        <label class="sim-inspector-row">
          <span>${_escapeHtml(label)}</span>
          <span>${compactColorControl(field, fallbackColor)}</span>
        </label>`;
      const guideChoiceRow = (field, label, options, value = '') => `
        <label class="sim-inspector-row">
          <span>${_escapeHtml(label)}</span>
          <select data-sim-field="${field}" data-sim-type="select">
            ${options.map(option => `<option value="${option.value}" ${String(value) === String(option.value) ? 'selected' : ''}>${_escapeHtml(option.label)}</option>`).join('')}
          </select>
        </label>`;
      const guideToggleRow = (field, label, checkedValue) => `
        <label class="sim-inspector-row">
          <span>${_escapeHtml(label)}</span>
          <input type="checkbox" data-sim-field="${field}" data-sim-type="bool" ${checkedValue ? 'checked' : ''}>
        </label>`;
      const guideButtonRow = (label, markup) => `
        <div class="sim-inspector-row">
          <span>${_escapeHtml(label)}</span>
          <div class="sim-inspector-list">${markup}</div>
        </div>`;

      const guideRows = [];
      const guideResetFields = [];

      const pushGuideSlider = (field, type, label, min, max, step, scale) => {
        guideRows.push(simSlider(field, type, label, min, max, step, scale));
        guideResetFields.push(field);
      };

      const pushGuideColor = (field, fallbackColor = p.color) => {
        guideRows.push(guideColorRow(field, 'Color', fallbackColor));
        guideResetFields.push(field);
      };

      const pushGuideChoice = (field, label, options, value = '') => {
        guideRows.push(guideChoiceRow(field, label, options, value));
        guideResetFields.push(field);
      };

      const pushGuideToggle = (field, label, checkedValue) => {
        guideRows.push(guideToggleRow(field, label, checkedValue));
        guideResetFields.push(field);
      };

      const compactControls = [];
      const resetFields = [];
      if (selected.kind === 'spawn') {
        compactControls.push(compactColorControl('color'));
        compactControls.push(compactNumberControl('count', 'integer', 'Count', 1, MAX_SWARM_COUNT, 1, 1));
        compactControls.push(compactNumberControl('opacity', 'number', 'Opacity', 0, 100, 1, 0.01));
        resetFields.push('color', 'count', 'opacity');
        if (target.mask) {
          compactControls.push(compactChoiceControl('distribution', 'Mode', SIM_SPAWN_DISTRIBUTION_MODES.map(mode => ({ value: mode, label: mode })), target.distribution || 'uniform'));
          compactControls.push(compactNumberControl('noiseScale', 'number', 'Noise', 20, 300, 5, 0.01));
          resetFields.push('distribution', 'noiseScale');
        } else {
          compactControls.push(compactChoiceControl('shape', 'Shape', [{ value: '', label: 'Default' }, ...SIM_SPAWN_SHAPES.map(shape => ({ value: shape, label: shape }))], target.shape || ''));
          compactControls.push(compactNumberControl('radius', 'integer', 'Size', 1, 300, 1, 1));
          compactControls.push(compactNumberControl('angle', 'angle', 'Angle', -180, 180, 1, 1));
          compactControls.push(compactNumberControl('jitter', 'number', 'Jitter', 0, 100, 1, 0.01));
          resetFields.push('shape', 'radius', 'angle', 'jitter');
        }
        compactControls.push(compactNumberControl('stampSize', 'integer', 'Stamp Size', 1, 100, 1, 1));
        compactControls.push(compactNumberControl('stampSeparation', 'number', 'Spacing', 0, 100, 1, 0.01));
        compactControls.push(compactNumberControl('trailFlow', 'number', 'Flow', 0, 100, 1, 0.01));
        compactControls.push(compactNumberControl('smudge', 'number', 'Smudge', 0, 100, 1, 0.01));
        compactControls.push(compactNumberControl('hueVar', 'number', 'Hue Var', 0, 100, 1, 0.01));
        compactControls.push(compactNumberControl('satVar', 'number', 'Sat Var', 0, 100, 1, 0.01));
        compactControls.push(compactNumberControl('litVar', 'number', 'Lit Var', 0, 100, 1, 0.01));
        compactControls.push(compactNumberControl('sizeVar', 'number', 'Size Var', 0, 100, 1, 0.01));
        compactControls.push(compactNumberControl('opacityVar', 'number', 'Opacity Var', 0, 100, 1, 0.01));
        compactControls.push(compactNumberControl('speedVar', 'number', 'Speed Var', 0, 100, 1, 0.01));
        resetFields.push('stampSize', 'stampSeparation', 'trailFlow', 'smudge', 'hueVar', 'satVar', 'litVar', 'sizeVar', 'opacityVar', 'speedVar');
      } else if (selected.kind === 'point') {
        compactControls.push(compactColorControl('color'));
        compactControls.push(compactNumberControl('strength', 'number', 'Strength', 0, 200, 5, 0.01));
        compactControls.push(compactNumberControl('radius', 'integer', 'Radius', 1, 300, 1, 1));
        resetFields.push('color', 'strength', 'radius');
        if (target.type === 'repel') {
          compactControls.push(compactNumberControl('hardness', 'number', 'Hardness', 1, 100, 5, 0.1));
          resetFields.push('hardness');
        }
      } else if (selected.kind === 'path') {
        const pathConfig = this._resolveSimulationPathConfig(target, p);
        compactControls.push(compactColorControl('color'));
        compactControls.push(compactNumberControl('strength', 'number', 'Strength', 0, 200, 5, 0.01));
        compactControls.push(compactNumberControl('radius', 'integer', 'Radius', 1, 300, 1, 1));
        compactControls.push(compactNumberControl('influenceRadius', 'integer', 'Falloff', 1, 600, 1, 1));
        compactControls.push(compactNumberControl('speed', 'number', 'Speed', 10, 400, 5, 0.01));
        compactControls.push('<button type="button" class="sim-format-reset" data-sim-add-speed-point="1">+Speed Pt</button>');
        compactControls.push('<button type="button" class="sim-format-reset" data-sim-add-radius-point="1">+Radius Pt</button>');
        compactControls.push('<button type="button" class="sim-format-reset" data-sim-distribute-points="speed">Dist Speed</button>');
        compactControls.push('<button type="button" class="sim-format-reset" data-sim-distribute-points="radius">Dist Radius</button>');
        compactControls.push(compactChoiceControl('pathType', 'Type', [
          { value: 'standard', label: 'Standard' },
          { value: 'stroke', label: 'Stroke Start' },
        ], _normalizeSimulationPathType(target.pathType)));
        compactControls.push(compactChoiceControl('direction', 'Dir', [
          { value: 'forward', label: 'Forward' },
          { value: 'reverse', label: 'Reverse' },
        ], pathConfig.direction));
        compactControls.push(compactToggleControl('closed', 'Loop', !!target.closed));
        resetFields.push('color', 'strength', 'radius', 'influenceRadius', 'speed', 'pathType', 'direction', 'closed');
      } else if (selected.kind === 'edge') {
        compactControls.push(compactNumberControl('strength', 'number', 'Force', 0, 200, 5, 0.01));
        compactControls.push(compactNumberControl('radius', 'integer', 'Radius', 0, 300, 1, 1));
        resetFields.push('strength', 'radius');
      } else if (selected.kind === 'pheromonePath') {
        compactControls.push(compactNumberControl('radius', 'integer', 'Radius', 1, 80, 1, 1));
        compactControls.push(compactNumberControl('intensity', 'number', 'Intensity', 0, 100, 5, 0.01));
        resetFields.push('radius', 'intensity');
      }

      if (selectionOverlayEnabled) {
        formatMarkup = `
          <div class="sim-format-shell">
            <div class="sim-format-row" data-sim-format-drag-root="1">
              <button type="button" class="sim-format-reset" data-sim-format-dock="1">${this._simFormatMenuUi.docked ? 'Undock' : 'Dock Top'}</button>
              ${compactControls.join('')}
              <button type="button" class="sim-format-reset" data-sim-reset-all="${resetFields.join(',')}">Match Current</button>
              <button type="button" class="sim-format-close" data-sim-clear-selection="1" aria-label="Close format menu">×</button>
            </div>
          </div>`;
      }

      const guideKindTitle = selected.kind === 'spawn'
        ? 'Spawn Overrides'
        : selected.kind === 'point'
          ? `${target.type === 'repel' ? 'Repel' : 'Attract'} Point Overrides`
          : selected.kind === 'path'
            ? 'Path Guide Overrides'
            : selected.kind === 'edge'
              ? 'Edge Barrier Overrides'
              : 'Pheromone Trail Overrides';
      if (selected.kind === 'spawn') {
        pushGuideColor('color');
        pushGuideSlider('count', 'integer', 'Count', 1, MAX_SWARM_COUNT, 1, 1);
        pushGuideSlider('opacity', 'number', 'Opacity', 0, 100, 1, 0.01);
        if (target.mask) {
          pushGuideChoice('distribution', 'Mode', SIM_SPAWN_DISTRIBUTION_MODES.map(mode => ({ value: mode, label: mode })), target.distribution || 'uniform');
          pushGuideSlider('noiseScale', 'number', 'Noise', 20, 300, 5, 0.01);
        } else {
          pushGuideChoice('shape', 'Shape', [{ value: '', label: 'Default' }, ...SIM_SPAWN_SHAPES.map(shape => ({ value: shape, label: shape }))], target.shape || '');
          pushGuideSlider('radius', 'integer', 'Size', 1, 300, 1, 1);
          pushGuideSlider('angle', 'angle', 'Angle', -180, 180, 1, 1);
          pushGuideSlider('jitter', 'number', 'Jitter', 0, 100, 1, 0.01);
        }
        pushGuideSlider('stampSize', 'integer', 'Stamp Size', 1, 100, 1, 1);
        pushGuideSlider('stampSeparation', 'number', 'Spacing', 0, 100, 1, 0.01);
        pushGuideSlider('trailFlow', 'number', 'Flow', 0, 100, 1, 0.01);
        pushGuideSlider('smudge', 'number', 'Smudge', 0, 100, 1, 0.01);
        pushGuideSlider('hueVar', 'number', 'Hue Var', 0, 100, 1, 0.01);
        pushGuideSlider('satVar', 'number', 'Sat Var', 0, 100, 1, 0.01);
        pushGuideSlider('litVar', 'number', 'Lit Var', 0, 100, 1, 0.01);
        pushGuideSlider('sizeVar', 'number', 'Size Var', 0, 100, 1, 0.01);
        pushGuideSlider('opacityVar', 'number', 'Opacity Var', 0, 100, 1, 0.01);
        pushGuideSlider('speedVar', 'number', 'Speed Var', 0, 100, 1, 0.01);
      } else if (selected.kind === 'point') {
        pushGuideColor('color');
        pushGuideSlider('strength', 'number', 'Strength', 0, 200, 5, 0.01);
        pushGuideSlider('radius', 'integer', 'Radius', 1, 300, 1, 1);
        if (target.type === 'repel') pushGuideSlider('hardness', 'number', 'Hardness', 1, 100, 5, 0.1);
      } else if (selected.kind === 'path') {
        const pathConfig = this._resolveSimulationPathConfig(target, p);
        pushGuideColor('color');
        pushGuideSlider('strength', 'number', 'Strength', 0, 200, 5, 0.01);
        pushGuideSlider('radius', 'integer', 'Radius', 1, 300, 1, 1);
        pushGuideSlider('influenceRadius', 'integer', 'Falloff', 1, 600, 1, 1);
        pushGuideSlider('speed', 'number', 'Speed', 10, 400, 5, 0.01);
        guideRows.push(guideButtonRow('Path Points', `
          <button type="button" class="sim-format-reset" data-sim-add-speed-point="1">+Speed Pt</button>
          <button type="button" class="sim-format-reset" data-sim-add-radius-point="1">+Radius Pt</button>
          <button type="button" class="sim-format-reset" data-sim-distribute-points="speed">Dist Speed</button>
          <button type="button" class="sim-format-reset" data-sim-distribute-points="radius">Dist Radius</button>
        `));
        pushGuideChoice('pathType', 'Type', [
          { value: 'standard', label: 'Standard' },
          { value: 'stroke', label: 'Stroke Start' },
        ], _normalizeSimulationPathType(target.pathType));
        pushGuideChoice('direction', 'Dir', [
          { value: 'forward', label: 'Forward' },
          { value: 'reverse', label: 'Reverse' },
        ], pathConfig.direction);
        pushGuideToggle('closed', 'Loop', !!target.closed);
      } else if (selected.kind === 'edge') {
        pushGuideSlider('strength', 'number', 'Force', 0, 200, 5, 0.01);
        pushGuideSlider('radius', 'integer', 'Radius', 0, 300, 1, 1);
      } else if (selected.kind === 'pheromonePath') {
        pushGuideSlider('radius', 'integer', 'Radius', 1, 80, 1, 1);
        pushGuideSlider('intensity', 'number', 'Intensity', 0, 100, 5, 0.01);
      }
      guideEditorMarkup = `
        <div class="sim-guide-panel-summary">Current tool: <strong>${this.simulation.editorTool}</strong> · Playback speed <strong data-sim-summary="simSpeed">${p.simSpeed.toFixed(1)}×</strong> · Selected <strong>${_escapeHtml(selected.kind === 'point' ? selected.target.type : selected.kind)}</strong>${selected.kind === 'spawn' || selected.kind === 'point' || selected.kind === 'path' || selected.kind === 'edge' || selected.kind === 'pheromonePath' ? ` · ${_escapeHtml(getGuideMeta({ kind: selected.kind, collection: selected.collection }, target))}` : ''}</div>
        ${renderInspectorSubgroup(guideKindTitle, guideRows.length ? guideRows.join('') : '<div class="sim-inspector-note">No per-item overrides available for this guide.</div>')}
        ${guideResetFields.length ? `<div class="sim-inspector-actions" style="margin-top:6px"><button type="button" data-sim-reset-all="${guideResetFields.join(',')}">Match Current Defaults</button><button type="button" data-sim-clear-selection="1">Clear Selection</button></div>` : ''}
      `;
    }

    formatMarkup = '';

    panel.innerHTML = inspector;
    if (guidesPanel) {
      guidesPanel.innerHTML = guideEditorMarkup;
    }
    if (formatPanel) {
      if (formatMarkup) {
        formatPanel.innerHTML = formatMarkup;
        formatPanel.classList.add('open');
        this._applySimulationFormatMenuPosition();
        this._positionSimulationFormatMenuPopovers();
      } else {
        formatPanel.innerHTML = '';
        formatPanel.classList.remove('open');
        formatPanel.classList.remove('dragging');
      }
    }

    this._renderSimulationTreePanel?.();

    const interactionRoots = [panel, formatPanel, guidesPanel].filter(Boolean);
    const queryAllInRoots = selector => interactionRoots.flatMap(root => Array.from(root.querySelectorAll(selector)));
    const getRootForControl = control => interactionRoots.find(root => root.contains(control)) || panel;

    panel.querySelectorAll('[data-sim-section-toggle]').forEach(header => {
      header.addEventListener('click', () => {
        const sectionId = header.dataset.simSectionToggle;
        this.simulation.inspectorSections[sectionId] = !isSectionOpen(sectionId);
        this._renderSimulationInspector();
      });
    });

    panel.querySelectorAll('[data-sim-select]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._setSimulationSelection({
          collection: btn.dataset.simCollection,
          kind: btn.dataset.simKind,
          id: +btn.dataset.simId,
        });
      });
      if (btn.tagName !== 'BUTTON') {
        btn.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          btn.click();
        });
      }
    });
    panel.querySelectorAll('[data-sim-toggle-item]').forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        const collection = btn.dataset.simCollection;
        const id = +btn.dataset.simId;
        const item = this._getSimulationCollection(collection).find(candidate => candidate.id === id);
        if (!item) return;
        this.pushUndo();
        item.enabled = item.enabled === false;
        if (collection === 'spawns') this._queueSimulationPlaybackRefresh();
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      });
    });
    panel.querySelectorAll('[data-sim-delete-item]').forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        const collection = btn.dataset.simCollection;
        const id = +btn.dataset.simId;
        const item = this._getSimulationCollection(collection).find(candidate => candidate.id === id);
        if (!item) return;
        this._deleteSimulationItem({ collection, target: item });
      });
    });
    queryAllInRoots('[data-sim-clear-selection]').forEach(button => {
      button.addEventListener('click', () => this._setSimulationSelection(null));
    });
    queryAllInRoots('[data-sim-format-dock]').forEach(button => {
      button.addEventListener('click', () => this._toggleSimulationFormatMenuDock());
    });
    queryAllInRoots('[data-sim-format-toggle]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        this._toggleSimulationFormatMenuPopover(button.dataset.simFormatToggle);
      });
    });
    queryAllInRoots('[data-sim-color-trigger]').forEach(button => {
      this._syncSimulationFormatColorTrigger(button, button.nextElementSibling?.value || '#1a1a1a');
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const target = this._getSimulationFormatColorTarget(button);
        if (!target) return;
        if (this._colorPicker.open && this._getColorTargetKey(this._colorPicker.target) === this._getColorTargetKey(target)) {
          this._closeColorPicker({ recordHistory: false });
          return;
        }
        this._openColorPicker(target, button);
      });
    });
    queryAllInRoots('[data-sim-reset-all]').forEach(button => {
      button.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry) return;
        const fields = (button.dataset.simResetAll || '').split(',').map(field => field.trim()).filter(Boolean);
        if (!fields.length) return;
        this.pushUndo();
        const appliedFields = this._applySimulationItemCurrentDefaults(entry, fields);
        this._syncLiveSimulationSpawnAppearance(entry, appliedFields);
        if (this._shouldRefreshSimulationPlaybackForSpawnFields(entry, appliedFields)) this._queueSimulationPlaybackRefresh();
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      });
    });
    queryAllInRoots('[data-sim-duplicate]').forEach(button => {
      button.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        this._duplicateSelectedSimulationItem();
        if (entry?.kind === 'spawn') this._queueSimulationPlaybackRefresh();
      });
    });
    panel.querySelectorAll('[data-sim-add-path-primitive]').forEach(btn => {
      btn.addEventListener('click', () => this._addSimulationPathPrimitive(btn.dataset.simAddPathPrimitive));
    });
    queryAllInRoots('[data-sim-add-speed-point]').forEach(button => {
      button.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry || entry.kind !== 'path') return;
        this.pushUndo();
        this._addSimulationPathSpeedPoint(entry.target);
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      });
    });
    queryAllInRoots('[data-sim-del-speed-point]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry || entry.kind !== 'path') return;
        this.pushUndo();
        this._removeSimulationPathSpeedPoint(entry.target, +btn.dataset.simDelSpeedPoint);
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      });
    });
    queryAllInRoots('[data-sim-add-radius-point]').forEach(button => {
      button.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry || entry.kind !== 'path') return;
        this.pushUndo();
        this._addSimulationPathRadiusPoint(entry.target);
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      });
    });
    queryAllInRoots('[data-sim-del-radius-point]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry || entry.kind !== 'path') return;
        this.pushUndo();
        this._removeSimulationPathRadiusPoint(entry.target, +btn.dataset.simDelRadiusPoint);
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      });
    });
    queryAllInRoots('[data-sim-distribute-points]').forEach(button => {
      button.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry || entry.kind !== 'path') return;
        this._openSimulationDistributeDialog(button.dataset.simDistributePoints || 'speed');
      });
    });
    queryAllInRoots('[data-sim-delete]').forEach(button => {
      button.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (entry) {
          this._deleteSimulationItem(entry);
          if (entry.kind === 'spawn') this._queueSimulationPlaybackRefresh();
        }
      });
    });
    panel.querySelectorAll('[data-sim-param]').forEach(el => {
      const paramId = el.dataset.simParam;
      const source = document.getElementById(paramId);
      const isBooleanParam = (el.type === 'checkbox') || (source?.type === 'checkbox');
      const inputKind = el.dataset.simInputKind || (el.type === 'number' ? 'number' : 'range');
      const peers = () => Array.from(panel.querySelectorAll(`[data-sim-param="${paramId}"]`));
      const syncParamUI = value => {
        if (isBooleanParam) {
          peers().forEach(peer => { peer.checked = !!value; });
          return;
        }
        const label = panel.querySelector(`[data-sim-param-label="${paramId}"]`);
        if (label) label.textContent = formatSimPanelValue(paramId, value);
        if (paramId === 'simSpeed') {
          const summary = panel.querySelector('[data-sim-summary="simSpeed"]');
          if (summary) summary.textContent = formatSimPanelValue(paramId, value);
        }
        const numberMeta = getSimParamDisplayMeta(paramId, value);
        peers().forEach(peer => {
          peer.value = peer.type === 'number'
            ? formatSimInputNumber(numberMeta.value, numberMeta.digits)
            : String(value);
        });
      };
      const initialParamValue = (() => {
        if (isBooleanParam) return !!source?.checked;
        const rawValue = Number(source?.value ?? el.value);
        return Number.isFinite(rawValue) ? rawValue : 0;
      })();
      syncParamUI(initialParamValue);
      if (!source) return;
      const forward = eventName => {
        if (isBooleanParam) {
          const nextChecked = !!el.checked;
          source.checked = nextChecked;
          syncParamUI(nextChecked);
          source.dispatchEvent(new Event(eventName, { bubbles: true }));
          return;
        }
        const nextValue = el.type === 'number'
          ? simParamDisplayToRaw(paramId, Math.max(Number(el.min || Number.NEGATIVE_INFINITY), Math.min(Number(el.max || Number.POSITIVE_INFINITY), Number(el.value || getSimParamDisplayMeta(paramId, Number(source.value || 0)).value || 0))))
          : +el.value;
        if (Number.isNaN(nextValue)) return;
        source.value = String(nextValue);
        if (el.type === 'number') {
          const numberMeta = getSimParamDisplayMeta(paramId, nextValue);
          el.value = formatSimInputNumber(numberMeta.value, numberMeta.digits);
        }
        syncParamUI(nextValue);
        source.dispatchEvent(new Event(eventName, { bubbles: true }));
        if (paramId === 'simBoundsMargin') {
          this._constrainSimulationDataToBounds('boid');
          this._constrainSimulationDataToBounds('ant');
          this._constrainSimulationDataToBounds('motionPath');
        }
      };
      el.addEventListener('input', () => {
        if (isBooleanParam) {
          forward('input');
          return;
        }
        if (inputKind === 'range') {
          const value = +el.value;
          peers().forEach(peer => {
            if (peer !== el) {
              const numberMeta = getSimParamDisplayMeta(paramId, value);
              peer.value = peer.type === 'number'
                ? formatSimInputNumber(numberMeta.value, numberMeta.digits)
                : String(value);
            }
          });
          syncParamUI(value);
        } else {
          const value = Number(el.value);
          if (!Number.isNaN(value)) {
            peers().forEach(peer => {
              if (peer !== el) peer.value = String(simParamDisplayToRaw(paramId, value));
            });
            syncParamUI(simParamDisplayToRaw(paramId, value));
          }
        }
        forward('input');
      });
      el.addEventListener('change', () => forward('change'));
    });
    queryAllInRoots('[data-sim-field]').forEach(el => {
      const field = el.dataset.simField;
      const type = el.dataset.simType || 'number';
      const scale = parseFloat(el.dataset.simScale || '1');
      const clampToInputBounds = (control, value, fallbackMin = Number.NEGATIVE_INFINITY) => {
        const minVal = control.min !== '' ? +control.min : fallbackMin;
        const maxVal = control.max !== '' ? +control.max : Number.POSITIVE_INFINITY;
        return Math.max(minVal, Math.min(maxVal, value));
      };
      const clampToStoredBounds = (control, value, fallbackMin = Number.NEGATIVE_INFINITY) => {
        const unitScale = control.type === 'range' && type !== 'angle' ? scale : 1;
        const minVal = control.min !== '' ? (+control.min * unitScale) : fallbackMin;
        const maxVal = control.max !== '' ? (+control.max * unitScale) : Number.POSITIVE_INFINITY;
        return Math.max(minVal, Math.min(maxVal, value));
      };

      // Write the current control value into target (no re-render).
      const writeField = () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry) return false;
        const { target } = entry;
        if (type === 'bool') {
          target[field] = el.checked;
        } else if (type === 'color') {
          const normalized = _normalizeHexColor(el.value);
          if (!normalized) delete target[field];
          else target[field] = normalized;
        } else if (type === 'select') {
          if (el.value === '') delete target[field];
          else target[field] = el.value;
        } else if (el.type === 'range') {
          if (type === 'integer') {
            target[field] = clampToStoredBounds(el, Math.round(+el.value * scale), 1);
          } else if (type === 'angle') {
            target[field] = _parseAngleDegrees(el.value);
          } else {
            target[field] = clampToStoredBounds(el, +el.value * scale);
          }
        } else if (el.value === '') {
          delete target[field];
        } else if (type === 'integer') {
          target[field] = clampToStoredBounds(el, Math.round(+el.value), 1);
        } else if (type === 'angle') {
          target[field] = _parseAngleDegrees(el.value);
        } else {
          target[field] = clampToStoredBounds(el, +el.value);
        }
        return true;
      };
      const getUndoToken = () => {
        const entry = this._getSelectedSimulationEntry();
        return entry ? `${entry.collection}:${entry.id}:${field}` : null;
      };
      const ensureUndo = () => {
        const token = getUndoToken();
        if (!token || this._activeSimulationFieldUndoToken === token) return;
        this.pushUndo();
        this._activeSimulationFieldUndoToken = token;
      };
      const resetUndo = () => {
        const token = getUndoToken();
        if (!token || this._activeSimulationFieldUndoToken === token) {
          this._activeSimulationFieldUndoToken = null;
        }
      };
      const syncFieldLive = () => {
        if (!writeField()) return false;
        this._syncSimulationSessionDraftUi({ rerenderInspector: false });
        this._syncLiveSimulationSpawnAppearance(this._getSelectedSimulationEntry(), [field]);
        return true;
      };

      // Live label update for range sliders (no re-render while dragging).
      if (el.type === 'range') {
        el.addEventListener('input', () => {
          const controlRoot = getRootForControl(el);
          const lbl = controlRoot.querySelector(`[data-sim-val-label="${field}"]`);
          if (!lbl) return;
          const liveValue = type === 'angle'
            ? Math.round(+el.value)
            : type === 'integer'
              ? clampToStoredBounds(el, Math.round(+el.value * scale), 1)
              : clampToStoredBounds(el, +el.value * scale);
          if (type === 'angle') lbl.textContent = `${liveValue}°`;
          else if (type === 'integer') lbl.textContent = String(liveValue);
          else lbl.textContent = liveValue.toFixed(scale < 1 ? 2 : 1);
          const numberInput = Array.from(controlRoot.querySelectorAll(`[data-sim-field="${field}"]`))
            .find(candidate => candidate !== el && candidate.type === 'number');
          if (numberInput) numberInput.value = String(liveValue);
          // Restore reset-button opacity once the user moves the slider.
          const resetBtn = controlRoot.querySelector(`.sim-fld-reset[data-sim-reset="${field}"]`);
          if (resetBtn) resetBtn.style.opacity = '1';
          ensureUndo();
          syncFieldLive();
        });
      } else if (el.type === 'color') {
        el.addEventListener('input', () => {
          const controlRoot = getRootForControl(el);
          const lbl = controlRoot.querySelector(`[data-sim-val-label="${field}"]`);
          const resetBtn = controlRoot.querySelector(`.sim-fld-reset[data-sim-reset="${field}"]`);
          const normalized = _normalizeHexColor(el.value, '#000000');
          if (lbl) lbl.textContent = normalized.toUpperCase();
          if (resetBtn) resetBtn.style.opacity = '1';
          ensureUndo();
          syncFieldLive();
        });
      } else if (el.type === 'number') {
        el.addEventListener('input', () => {
          const controlRoot = getRootForControl(el);
          const lbl = controlRoot.querySelector(`[data-sim-val-label="${field}"]`);
          const resetBtn = controlRoot.querySelector(`.sim-fld-reset[data-sim-reset="${field}"]`);
          const rangeInput = Array.from(controlRoot.querySelectorAll(`[data-sim-field="${field}"]`))
            .find(candidate => candidate !== el && candidate.type === 'range');
          if (el.value === '') {
            if (lbl) lbl.textContent = 'Brush def.';
            if (resetBtn) resetBtn.style.opacity = '0.35';
            return;
          }
          const numericValue = type === 'integer'
            ? clampToStoredBounds(el, Math.round(+el.value), 1)
            : clampToStoredBounds(el, +el.value);
          if (lbl) {
            if (type === 'angle') lbl.textContent = `${Math.round(numericValue)}°`;
            else if (type === 'integer') lbl.textContent = String(numericValue);
            else lbl.textContent = numericValue.toFixed(scale < 1 ? 2 : 1);
          }
          if (rangeInput) rangeInput.value = type === 'angle' ? String(Math.round(numericValue)) : String(scale ? numericValue / scale : numericValue);
          if (resetBtn) resetBtn.style.opacity = '1';
          ensureUndo();
          syncFieldLive();
        });
      }

      // Commit on change + trigger re-render.
      const applyField = () => {
        ensureUndo();
        try {
          if (!syncFieldLive()) return;
          const entry = this._getSelectedSimulationEntry();
          if (this._shouldRefreshSimulationPlaybackForSpawnFields(entry, [field])) this._queueSimulationPlaybackRefresh();
          this._renderSimulationInspector();
          this._maybeAutoSaveSession();
        } finally {
          resetUndo();
        }
      };
      el.addEventListener(el.type === 'checkbox' ? 'input' : 'change', applyField);
      el.addEventListener('blur', resetUndo);
    });

    // Reset buttons — clear an override field and re-render.
    queryAllInRoots('[data-sim-reset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = this._getSelectedSimulationEntry();
        if (!entry) return;
        this.pushUndo();
        const appliedFields = this._applySimulationItemCurrentDefaults(entry, [btn.dataset.simReset]);
        this._syncLiveSimulationSpawnAppearance(entry, appliedFields);
        if (this._shouldRefreshSimulationPlaybackForSpawnFields(entry, appliedFields)) this._queueSimulationPlaybackRefresh();
        this._renderSimulationInspector();
        this._maybeAutoSaveSession();
      });
    });

    // Scene-variable sliders (seek, etc.)
    panel.querySelectorAll('[data-sim-var]').forEach(el => {
      const varName = el.dataset.simVar;
      const scale = parseFloat(el.dataset.simVarScale || '0.01');
      const inputKind = el.dataset.simInputKind || (el.type === 'number' ? 'number' : 'range');
      const peers = () => Array.from(panel.querySelectorAll(`[data-sim-var="${varName}"]`));
      const updateVar = () => {
        const raw = inputKind === 'number' ? (+el.value / scale) : +el.value;
        if (Number.isNaN(raw)) return;
        this.simulation.vars[varName] = raw * scale;
        const label = panel.querySelector(`[data-sim-var-label="${varName}"]`);
        if (label) label.textContent = formatSimVarValue(varName, this.simulation.vars[varName]);
        peers().forEach(peer => {
          peer.value = peer.type === 'number'
            ? formatSimInputNumber(this.simulation.vars[varName], scale < 1 ? 2 : 1)
            : String(raw);
        });
        this._maybeAutoSaveSession();
      };
      el.addEventListener('input', updateVar);
      el.addEventListener('change', updateVar);
    });

    panel.querySelector('[data-sim-new-session]')?.addEventListener('click', () => this._newSimulationSession());
    panel.querySelector('[data-sim-save-session]')?.addEventListener('click', () => this._saveSimulationSession());
    panel.querySelector('[data-sim-active-session-select]')?.addEventListener('change', event => {
      const nextIndex = Number(event.target.value);
      if (Number.isFinite(nextIndex)) this._setActiveSimulationSessionIndex(nextIndex);
    });
    panel.querySelector('[data-sim-open-setup]')?.addEventListener('click', event => {
      this._showSimulationSetupExplorer(event.currentTarget);
    });
    panel.querySelector('[data-sim-open-inspector]')?.addEventListener('click', () => {
      if (!this.simulation.enabled) this._toggleSimulationMode(true);
      this.simulation.inspectorCollapsed = false;
      this._syncSimulationUI?.();
    });
    const commitStageInspectorChange = ({ rerender = true } = {}) => {
      if (this.simulation.running || this.simulation.paused) this.stopSimulation(false);
      if (rerender) this._renderSimulationInspector();
      this._syncSimulationUI();
      this.saveSession();
    };
    panel.querySelector('[data-sim-multi-toggle]')?.addEventListener('change', event => {
      this.simulation.multiSessionEnabled = !!event.target.checked;
      commitStageInspectorChange();
    });
    panel.querySelectorAll('[data-sim-stage-edit-session]').forEach(button => {
      button.addEventListener('click', event => {
        const nextIndex = Number(event.currentTarget.dataset.simStageEditSession);
        if (Number.isFinite(nextIndex)) this._setActiveSimulationSessionIndex(nextIndex);
      });
    });
    panel.querySelectorAll('[data-sim-stage-enabled]').forEach(input => {
      input.addEventListener('change', event => {
        const sessionIndex = Number(event.target.dataset.simStageEnabled);
        if (!Number.isFinite(sessionIndex)) return;
        const binding = this._getSimulationSessionBinding(sessionIndex);
        binding.enabled = !!event.target.checked;
        commitStageInspectorChange();
      });
    });
    panel.querySelectorAll('[data-sim-stage-layer]').forEach(input => {
      input.addEventListener('change', event => {
        const sessionIndex = Number(event.target.dataset.simStageLayer);
        if (!Number.isFinite(sessionIndex)) return;
        const selectedLayerIds = Array.from(panel.querySelectorAll(`[data-sim-stage-layer="${sessionIndex}"]:checked`)).map(el => el.value);
        const binding = this._getSimulationSessionBinding(sessionIndex);
        binding.layerIds = this._normalizeSimulationLayerIds(selectedLayerIds, sessionIndex);
        commitStageInspectorChange();
      });
    });
    panel.querySelectorAll('[data-sim-stage-sensing-enabled]').forEach(input => {
      input.addEventListener('change', event => {
        const sessionIndex = Number(event.target.dataset.simStageSensingEnabled);
        const session = this.simulation.sessions[sessionIndex];
        if (!session) return;
        const enabled = !!event.target.checked;
        session.vars = _normalizeSimulationVars({
          ...session.vars,
          sensingEnabled: enabled,
        });
        if (sessionIndex === this.simulation.activeSessionIndex) {
          this.simulation.vars = _normalizeSimulationVars({
            ...this.simulation.vars,
            sensingEnabled: enabled,
          });
          this._syncSimulationSessionSensingControls();
        }
        commitStageInspectorChange();
      });
    });
    panel.querySelectorAll('[data-sim-stage-sensing-source]').forEach(select => {
      select.addEventListener('change', event => {
        const sessionIndex = Number(event.target.dataset.simStageSensingSource);
        const session = this.simulation.sessions[sessionIndex];
        if (!session) return;
        const nextSource = event.target.value || 'below';
        let selection = _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection);
        if (nextSource === 'selected' && !selection.length) {
          selection = this._normalizeSimulationLayerIds([this.activeLayer?.id], sessionIndex);
        }
        session.vars = _normalizeSimulationVars({
          ...session.vars,
          sensingSource: nextSource,
        });
        session.sensingSourceSelection = selection;
        if (sessionIndex === this.simulation.activeSessionIndex) {
          this.simulation.vars = _normalizeSimulationVars({
            ...this.simulation.vars,
            sensingSource: nextSource,
          });
          this._restoreSensingSourceSelection(selection);
          this._syncSimulationSessionSensingControls();
        }
        commitStageInspectorChange();
      });
    });
    panel.querySelectorAll('[data-sim-stage-sensing-layer]').forEach(input => {
      input.addEventListener('change', event => {
        const sessionIndex = Number(event.target.dataset.simStageSensingLayer);
        const session = this.simulation.sessions[sessionIndex];
        if (!session) return;
        const selectedLayerIds = Array.from(panel.querySelectorAll(`[data-sim-stage-sensing-layer="${sessionIndex}"]:checked`)).map(el => el.value);
        session.sensingSourceSelection = _normalizeSimulationSensingSourceSelection(selectedLayerIds);
        if (sessionIndex === this.simulation.activeSessionIndex) {
          this._restoreSensingSourceSelection(session.sensingSourceSelection);
          this._syncSimulationSessionSensingControls();
        }
        commitStageInspectorChange();
      });
    });
    panel.querySelector('[data-sim-delete-active-session]')?.addEventListener('click', () => {
      if (this.simulation.activeSessionIndex >= 0) this._deleteSimulationSavedSession(this.simulation.activeSessionIndex);
    });
    panel.querySelector('[data-sim-export-setup]')?.addEventListener('click', () => this.exportSimulationSetupFile());
    panel.querySelector('[data-sim-import-setup]')?.addEventListener('click', () => document.getElementById('simSetupImportInput')?.click());
    panel.querySelector('[data-sim-export-workspace]')?.addEventListener('click', () => this.exportWorkspaceSettingsFile());
    panel.querySelector('[data-sim-import-workspace]')?.addEventListener('click', () => document.getElementById('workspaceSettingsImportInput')?.click());
    } catch (error) {
      console.error('Simulation inspector render failed:', error);
      this.simulation.inspectorCollapsed = true;
      panel.classList.remove('open');
      panel.innerHTML = '';
    }
  }

  _toggleSimulationMode(force) {
    if (!this._isMotionBrush()) return;
    const wasEnabled = !!this.simulation.enabled;
    const next = typeof force === 'boolean' ? force : !this.simulation.enabled;
    const overlayHudEnabled = this._isSimulationOverlayHudEnabled();
    if (!wasEnabled && next) this._captureSimulationPriorDrawSeek();
    if (!next) {
      this.stopSimulation(false);
      this.simulation.frameCount = 0;
      this.simulation.selected = null;
      this._closeSimulationHelp();
      this._hideSimulationExportModal();
    } else {
      const brush = this.getCurrentBrush();
      if (brush?.deactivate) brush.deactivate();
      this.isDrawing = false;
      this.isTapering = false;
    }
    this.simulation.enabled = next;
    this.simulation.paused = false;
    this.simulation.drawingPath = null;
    this.simulation.drawingBlob = null;
    this.simulation.dragTarget = null;
    this._normalizeSimulationData();
    if (next) {
      this._constrainSimulationDataToBounds('boid');
      this._constrainSimulationDataToBounds('ant');
      this._constrainSimulationDataToBounds('motionPath');
    }
    this._ensureSimulationSpawns();
    if (wasEnabled && !next) this._restoreSimulationPriorDrawSeek();
    this._syncSimulationUI();
    if (next && !overlayHudEnabled) this._showSimulationControlsDrawer();
    this.showToast(next ? 'Simulation mode ON' : 'Simulation mode OFF');
  }

  _setSimulationTool(tool) {
    if (!this._isMotionBrush()) return;
    this.simulation.editorTool = tool;
    this._syncSimulationUI();
  }

  _syncSimulationUI() {
    this._syncForceVizUI();
    if (this.activeBrush !== 'ant' && this.simulation.editorTool === 'edge') this.simulation.editorTool = 'spawn';
    if (this.activeBrush === 'ant' && this.simulation.editorTool === 'path') this.simulation.editorTool = 'spawn';
    if (this.activeBrush !== 'ant' && this.simulation.editorTool === 'pheromone') this.simulation.editorTool = 'spawn';
    const btn = document.getElementById('simulationBtn');
    const hud = document.getElementById('simHud');
    const playbackBar = document.getElementById('simPlaybackBar');
    const hudCollapseBtn = document.getElementById('simHudCollapseBtn');
    const heatmapButtons = [document.getElementById('simHeatmapToggle'), document.getElementById('simDrawerHeatmapToggle')];
    const stepBackButtons = [document.getElementById('simStepBackBtn'), document.getElementById('simDrawerStepBackBtn')];
    const stepForwardButtons = [document.getElementById('simStepForwardBtn'), document.getElementById('simDrawerStepForwardBtn')];
    const guidesButtons = [document.getElementById('simGuidesToggle'), document.getElementById('simDrawerGuidesToggle')];
    const inspectorButtons = [document.getElementById('simInspectorToggle'), document.getElementById('simDrawerInspectorToggle')];
    const handle = document.getElementById('simOverlayHandle');
    const overflowHelpBtn = document.getElementById('simHelpMenuBtn');
    const isMotion = this._isMotionBrush();
    const overlayHudEnabled = this._isSimulationOverlayHudEnabled();
    const showOverlayHud = !!this.simulation.enabled && isMotion && overlayHudEnabled;
    const showSimulationDrawer = !!this.simulation.enabled && isMotion && !overlayHudEnabled;
    const guidePaths = (this._usesPathGuides())
      ? (this._getSimulationBrushData(this.activeBrush)?.paths || []).filter(pathItem => pathItem.enabled !== false && pathItem.points?.length >= 2)
      : [];
    const canStepPaths = guidePaths.length > 0;
    const showPathStepButtons = (this._usesPathGuides()) && !!this.simulation.heatmapVisible;
    if (btn) {
      btn.style.display = isMotion ? '' : 'none';
      btn.classList.toggle('active', !!this.simulation.enabled);
    }
    if (overflowHelpBtn) {
      const nextDisplay = isMotion ? '' : 'none';
      if (overflowHelpBtn.style.display !== nextDisplay) {
        overflowHelpBtn.style.display = nextDisplay;
        this._layoutTopbarOverflow?.();
      }
    }
    if (hud) {
      hud.classList.toggle('open', showOverlayHud);
      hud.classList.toggle('collapsed', !!this.simulation.hudCollapsed);
    }
    if (showSimulationDrawer) this._showSimulationControlsDrawer();
    else this._hideSimulationControlsDrawer({ closeIfActive: true });
    this._renderSimulationTreePanel?.();
    if (playbackBar) {
      playbackBar.classList.toggle('open', !!this.simulation.enabled && isMotion);
    }
    document.body.classList.remove('sim-topbar-row-open');
    document.body.style.removeProperty('--sim-row-h');
    if (hudCollapseBtn) {
      const expanded = !this.simulation.hudCollapsed;
      hudCollapseBtn.textContent = expanded ? 'Collapse' : 'Expand';
      hudCollapseBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
    if (handle) {
      // Handle is now hidden; simulation tab in rightPanel replaces it
      handle.style.display = 'none';
    }

    document.querySelectorAll('#simToolRow, #simDrawerToolRow').forEach(toolRow => {
      toolRow.querySelectorAll('[data-sim-tool]').forEach(el => {
        const tool = el.dataset.simTool;
        const hide =
          (this.activeBrush !== 'ant' && tool === 'edge') ||
          (this.activeBrush === 'ant' && tool === 'path') ||
          (this.activeBrush !== 'ant' && tool === 'pheromone');
        el.style.display = hide ? 'none' : '';
        el.classList.toggle('active', this.simulation.editorTool === tool);
      });
    });

    document.getElementById('simRunBtn')?.classList.toggle('active', this.simulation.running);
    document.getElementById('simHudRunBtn')?.classList.toggle('active', this.simulation.running);
    document.getElementById('simDrawerRunBtn')?.classList.toggle('active', this.simulation.running);
    document.getElementById('simPauseBtn')?.classList.toggle('active', this.simulation.paused);
    const ephemeralBtn = document.getElementById('simEphemeralToggle');
    if (ephemeralBtn) {
      const ephemeralOn = !!document.getElementById('simEphemeralMode')?.checked;
      ephemeralBtn.classList.toggle('active', ephemeralOn);
      ephemeralBtn.setAttribute('aria-pressed', ephemeralOn ? 'true' : 'false');
      const ephemeralLabel = ephemeralOn ? 'Ephemeral mode on' : 'Ephemeral mode off';
      ephemeralBtn.setAttribute('aria-label', ephemeralLabel);
      ephemeralBtn.title = ephemeralLabel;
    }
    const resetBtn = document.getElementById('simResetBtn');
    if (resetBtn) resetBtn.disabled = !this.simulation.running && !this.simulation.paused && !(this.simulation.frameCount > 0);
    const forceVizBtn = document.getElementById('simForceVizToggle');
    if (forceVizBtn) {
      const forceVizOn = this.simulation.mode === 'forceVisualization';
      const forceVizLabel = forceVizOn ? 'Force Visualization mode on' : 'Force Visualization mode off';
      forceVizBtn.classList.toggle('active', forceVizOn);
      forceVizBtn.setAttribute('aria-pressed', forceVizOn ? 'true' : 'false');
      forceVizBtn.setAttribute('aria-label', forceVizLabel);
      forceVizBtn.title = forceVizLabel;
    }
    const simTabActive = document.querySelector('#rightPanelTabs .panel-tab[data-panel-view="simulation"]')?.classList.contains('active');
    inspectorButtons.forEach(button => button?.classList.toggle('active', !!simTabActive));
    guidesButtons.forEach(button => {
      if (!button) return;
      button.classList.toggle('active', this.simulation.guidesVisible !== false);
      button.textContent = this.simulation.guidesVisible !== false ? 'Hide Guides' : 'Show Guides';
      button.setAttribute('aria-pressed', this.simulation.guidesVisible !== false ? 'true' : 'false');
    });
    heatmapButtons.forEach(button => {
      if (!button) return;
      button.classList.toggle('active', !!this.simulation.heatmapVisible);
      button.setAttribute('aria-pressed', this.simulation.heatmapVisible ? 'true' : 'false');
    });
    stepBackButtons.forEach(button => {
      if (!button) return;
      button.style.display = showPathStepButtons ? '' : 'none';
      button.disabled = !canStepPaths;
    });
    stepForwardButtons.forEach(button => {
      if (!button) return;
      button.style.display = showPathStepButtons ? '' : 'none';
      button.disabled = !canStepPaths;
    });
    const status = document.getElementById('simStatus');
    const playbackBadge = document.getElementById('simPlaybackReadyBadge');
    const routingSummary = document.getElementById('simRoutingSummary');
    if (status) {
      const context = this._getSimulationSessionContextSummary();
      const base = this.simulation.running ? 'Running' : (this.simulation.paused ? 'Paused' : 'Ready');
      const extras = [];
      const savedRuntimeStats = this._getSavedPlaybackRuntimeStats();
      const sessionLabel = context.playbackLabel || 'Session';
      if (this.simulation.heatmapVisible) extras.push('Heatmap');
      if (savedRuntimeStats.total > 0) {
        extras.push(savedRuntimeStats.completed >= savedRuntimeStats.total
          ? 'Saved complete'
          : `Saved ${savedRuntimeStats.completed}/${savedRuntimeStats.total}`);
      }
      if (this._simulationExport.armedOnStart) extras.push('REC Armed');
      if (this._simulationExport.recording) extras.push('REC');
      const stateLabel = extras.length ? `${base} · ${extras.join(' · ')}` : base;
      status.textContent = `${sessionLabel} · ${stateLabel}`;
      if (playbackBadge) {
        const playbackStatus = this._getSimulationSavedPlaybackStatus(context.session);
        const badgeTone = this._getSimulationSavedPlaybackBadgeTone(playbackStatus);
        playbackBadge.textContent = context.playbackBadge;
        playbackBadge.className = `sim-playback-readout ${badgeTone}`;
      }
      if (routingSummary) {
        routingSummary.textContent = this._getSimulationPlaybackBarSummary(context);
      }
    }
    this._syncSimulationSessionContextUi();
    this._refreshSimulationExportUi();
    syncEdgeSliders(this);
    this._renderSimulationInspector();
    this._syncSimulationActionButtons();
    this._updateSimUndoRedoBtns();
  }

  _toggleSimulationGuidesVisibility(force) {
    const next = typeof force === 'boolean' ? force : this.simulation.guidesVisible === false;
    this.simulation.guidesVisible = next;
    this._syncSimulationUI();
    this.saveSession();
  }

  _toggleSimulationHeatmap(force) {
    const next = typeof force === 'boolean' ? force : !this.simulation.heatmapVisible;
    this.simulation.heatmapVisible = !!next;
    this._syncSimulationUI();
    this.saveSession();
  }

  _stepSimulationPathPosition(direction = 1) {
    if (!this.simulation.enabled || !this._usesPathGuides()) return;
    const paths = (this._getSimulationBrushData(this.activeBrush)?.paths || []).filter(pathItem => pathItem.enabled !== false && pathItem.points?.length >= 2);
    if (!paths.length) return;
    const p = this.getP();
    const delta = Math.max(4, (p.simPathSpeed || 0) * 0.25) * (direction < 0 ? -1 : 1);
    for (const pathItem of paths) {
      const current = Number.isFinite(pathItem.travelDistance) ? pathItem.travelDistance : 0;
      let next = current + delta;
      next %= PATH_DISTANCE_WRAP_THRESHOLD;
      if (next < 0) next += PATH_DISTANCE_WRAP_THRESHOLD;
      pathItem.travelDistance = next;
    }
    this._updateSimulationLeader(0, p);
    this._maybeAutoSaveSession();
  }

  async startSimulation({ announce = true } = {}) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return;
    const brush = this.getCurrentBrush();
    if (!brush) return;
    if (this.simulation.running || this.simulation.starting) return;
    this._constrainSimulationDataToBounds(this.activeBrush);
    this.stopSimulation(false);
    this.simulation.starting = true;
    let diagnostics = null;
    try {
      this.simulation.running = true;
      this.simulation.paused = false;
      this.simulation.frameCount = 0;
      this.simulation.pathDistance = 0;
      const simParams = this.getP();
      this.isDrawing = true;
      this.undoPushedThisStroke = false;
      this.strokeFrame = 0;

      if (this._shouldUseMultiSessionPlayback()) {
        this._simulationSavedPlaybackCapture = null;
        diagnostics = this._getMultiSessionRouteDiagnostics({ autoHeal: true });
        if (diagnostics.healedBindings) this.saveSession();
        if (!diagnostics.runnableRoutes.length) {
          this.simulation.running = false;
          this.simulation.paused = false;
          this.isDrawing = false;
          this._syncSimulationUI();
          this.showToast(diagnostics.blockReason || 'Save and arm at least one session route before running multiple sessions');
          return;
        }
        const runtimeSessions = await this._createMultiSessionRuntimeSessions(simParams);
        if (!runtimeSessions.length) {
          this.simulation.running = false;
          this.simulation.paused = false;
          this.isDrawing = false;
          this._syncSimulationUI();
          this.showToast('Simulation start failed: unable to start session runtimes');
          return;
        }
        brush.deactivate?.();
        this.simulation.runtimeSessions = runtimeSessions;
      } else {
        this._beginSimulationSavedPlaybackCapture();
        this.simulation.runtimeSessions = [];
        const allSpawns = this._ensureSimulationSpawns();
        const spawns = allSpawns.filter(spawn => spawn.enabled !== false);
        const spawn = spawns[0] || allSpawns[0];
        if (this._usesPathGuides()) {
          for (const pathItem of this._getSimulationBrushData(this.activeBrush)?.paths || []) {
            pathItem.travelDistance = 0;
          }
        }
        this.simulation.runtimeStrokeStarts = this._collectSimulationStrokeStartSpawns(this.activeBrush, simParams);
        const launchSpawn = this.simulation.runtimeStrokeStarts[0] || spawn;
        const bindForceVizSpawn = this.simulation.mode === 'forceVisualization'
          && this.activeBrush === 'boid'
          && spawn
          && Array.isArray(this.simulation.forceViz?.scenarios);
        if (bindForceVizSpawn) {
          const activeScenario = this._getActiveForceVizScenario();
          const activeRoutes = activeScenario?.routes || [];
          const activeGroups = activeScenario?.groups || [];
          const boundSpawnIds = new Set(activeRoutes.filter(route => route.enabled !== false).map(route => route.groupId));
          const primaryGroup = activeGroups.find(group => boundSpawnIds.has(group.id) && group.spawnId != null)
            || activeGroups.find(group => group.spawnId != null)
            || null;
          brush._primarySpawnId = primaryGroup?.spawnId ?? spawn.id ?? null;
        }
        this._updateSimulationLeader(0, simParams);
        brush.onDown?.(launchSpawn.x, launchSpawn.y, 1);
        brush.configureSimulation?.(this._getSimulationBrushData(), simParams);
      }

      if (this._simulationExport.armedOnStart) void this._startSimulationRecording();
      this._syncSimulationUI();
      if (announce) {
        this.showToast(this.simulation.runtimeSessions.length
          ? this._buildSimulationRunToastMessage(this.simulation.runtimeSessions, diagnostics?.runnableRoutes?.length || 0)
          : 'Simulation running');
      }
    } catch (error) {
      console.error('Simulation start failed:', error);
      this._teardownMultiSessionRuntimeSessions({ commitPreview: false });
      this.simulation.running = false;
      this.simulation.paused = false;
      this.isDrawing = false;
      this._syncSimulationUI();
      const msg = error?.message?.includes('WebGPU')
        ? 'Simulation start failed: GPU device limit reached'
        : 'Simulation start failed';
      this.showToast(msg);
    } finally {
      this.simulation.starting = false;
    }
  }

  pauseSimulation() {
    if (!this.simulation.running) return;
    this.simulation.running = false;
    this.simulation.paused = true;
    this.isDrawing = false;
    this._syncSimulationUI();
    this.showToast(this.simulation.runtimeSessions.length
      ? `Simulation paused (${this.simulation.runtimeSessions.length} sessions)`
      : 'Simulation paused');
  }

  resumeSimulation() {
    if (!this.simulation.paused || !this._isMotionBrush()) return;
    this.simulation.paused = false;
    this.simulation.running = true;
    this.isDrawing = true;
    this._syncSimulationUI();
    this.showToast(this.simulation.runtimeSessions.length
      ? `Simulation resumed (${this.simulation.runtimeSessions.length} sessions)`
      : 'Simulation resumed');
  }

  stopSimulation(showToast = true) {
    const brush = this.getCurrentBrush();
    const wasActive = this.simulation.running || this.simulation.paused;
    const hadMultiSessionPlayback = this.simulation.runtimeSessions.length > 0;
    void this._stopSimulationRecording({ announce: false });
    if (hadMultiSessionPlayback) {
      this._teardownMultiSessionRuntimeSessions({
        commitPreview: this.simulation.running,
        cache: true,
      });
    } else if (this.simulation.running && brush?.onUp) {
      brush.onUp(this.leaderX, this.leaderY);
    }
    if (wasActive) this.recordLastChangeMarker('Simulation stroke');
    if (wasActive && !hadMultiSessionPlayback && brush?.deactivate) brush.deactivate();
    this.simulation.starting = false;
    this.simulation.running = false;
    this.simulation.paused = false;
    this.simulation.runtimeStrokeStarts = [];
    this.simulation.motionPathVelocity = { x: 0, y: 0 };
    this.isDrawing = false;
    this.isTapering = false;
    this._simulationSavedPlaybackCapture = null;
    if (wasActive && this.simulation.mode === 'forceVisualization') this._applyForceVizExitBehaviorOnStop();
    this._syncSimulationUI();
    if (showToast && wasActive) this.showToast('Simulation stopped');
  }

  _applySimulationEphemeralFade(p) {
    if (!this.simulation.running || !this.simulation.enabled || !p.simEphemeralMode) return;
    const layer = this.getActiveLayer();
    if (!layer?.ctx?.canvas) return;
    const defaultFrames = Math.max(1, Number(FACTORY_DEFAULTS.simEphemeralFrames) || 45);
    const defaultFade = Math.max(0, (Number(FACTORY_DEFAULTS.simEphemeralFade) || 100) / 100);
    const frames = Math.max(1, Number.isFinite(p.simEphemeralFrames) ? p.simEphemeralFrames : defaultFrames);
    const fadeSpeed = Math.max(0, Number.isFinite(p.simEphemeralFade) ? p.simEphemeralFade : defaultFade);
    // Convert user "fade speed" into per-frame erase alpha relative to the
    // desired trail lifetime so higher fade speeds clear old stamps sooner.
    const fadeAlpha = Math.min(1, fadeSpeed / frames);
    if (fadeAlpha <= 0) return;
    const ctx = layer.ctx;
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = fadeAlpha;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    const shouldSnapResidualAlpha =
      this._simEphemeralAlphaSnapSupported &&
      // High fadeAlpha values already clear residual pixels quickly.
      fadeAlpha < 0.5 &&
      // Process in batches to reduce per-frame ImageData cost.
      (this.simulation.frameCount % SIM_EPHEMERAL_ALPHA_SNAP_INTERVAL_FRAMES === 0);
    if (shouldSnapResidualAlpha) {
      try {
        const intervalFadeAlpha = 1 - Math.pow(1 - fadeAlpha, SIM_EPHEMERAL_ALPHA_SNAP_INTERVAL_FRAMES);
        // Canvas compositing quantizes alpha to 8-bit values. At very low fade
        // rates, faint anti-aliased edge pixels can stop changing entirely and
        // linger as a ghost outline. Snap those low-alpha pixels to fully
        // transparent once their expected change per snap interval falls below a
        // few visible 8-bit alpha steps so the tail fully disappears instead of
        // stalling in a still-visible edge band.
        const snapThreshold = Math.min(
          32,
          Math.max(
            SIM_EPHEMERAL_ALPHA_SNAP_THRESHOLD,
            Math.ceil(SIM_EPHEMERAL_ALPHA_SNAP_VISIBLE_STEPS / Math.max(intervalFadeAlpha, 1 / 255)),
          ),
        );
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        let changed = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] === 0) {
            if (data[i - 3] || data[i - 2] || data[i - 1]) {
              data[i - 3] = 0;
              data[i - 2] = 0;
              data[i - 1] = 0;
              changed = true;
            }
            continue;
          }
          if (data[i] <= snapThreshold) {
            data[i - 3] = 0;
            data[i - 2] = 0;
            data[i - 1] = 0;
            data[i] = 0;
            changed = true;
          }
        }
        if (changed) ctx.putImageData(imageData, 0, 0);
      } catch (error) {
        console.warn('Ephemeral fade alpha snap disabled:', error);
        this._simEphemeralAlphaSnapSupported = false;
      }
    }
    layer.dirty = true;
  }

  _handleSimulationPointerDown(x, y) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return false;
    if (this.simulation.running || this.simulation.paused) return true;
    const clampedPoint = this._clampSimulationPoint(x, y);
    x = clampedPoint.x;
    y = clampedPoint.y;
    const tool = this.simulation.editorTool;
    const isPathCreationTool =
      ((tool === 'path') && (this._usesPathGuides())) ||
      (tool === 'edge' && this.activeBrush === 'ant') ||
      (tool === 'pheromone' && this.activeBrush === 'ant');

    const hit = this._findSimulationHit(x, y);
    if (hit?.kind === 'delete') {
      this._deleteSimulationItem(hit);
      return true;
    }
    if (hit?.kind === 'overlayAction') {
      const selectionKind = hit.collection === 'spawns' ? 'spawn' : 'path';
      this._setSimulationSelection({ collection: hit.collection, kind: selectionKind, target: hit.target });
      const isToggle = hit.action === 'toggleSpeedHandles' || hit.action === 'toggleRadiusHandles' || hit.action === 'toggleStrengthHandles';
      if (hit.action === 'addSpeedPoint') {
        this.pushUndo();
        this._addSimulationPathSpeedPoint(hit.target);
      } else if (hit.action === 'addRadiusPoint') {
        this.pushUndo();
        this._addSimulationPathRadiusPoint(hit.target);
      } else if (hit.action === 'deleteSpeedPoint') {
        this.pushUndo();
        this._removeSimulationPathSpeedPoint(hit.target, hit.speedPointId);
      } else if (hit.action === 'deleteRadiusPoint') {
        this.pushUndo();
        this._removeSimulationPathRadiusPoint(hit.target, hit.radiusPointId);
      } else if (hit.action === 'addStrengthPoint') {
        this.pushUndo();
        this._addSimulationPathStrengthPoint(hit.target);
      } else if (hit.action === 'deleteStrengthPoint') {
        this.pushUndo();
        this._removeSimulationPathStrengthPoint(hit.target, hit.strengthPointId);
      } else if (hit.action === 'toggleSpeedHandles') {
        this._simPathOverlayUi.showSpeedHandles = !this._simPathOverlayUi.showSpeedHandles;
      } else if (hit.action === 'toggleRadiusHandles') {
        this._simPathOverlayUi.showRadiusHandles = !this._simPathOverlayUi.showRadiusHandles;
      } else if (hit.action === 'toggleStrengthHandles') {
        this._simPathOverlayUi.showStrengthHandles = !this._simPathOverlayUi.showStrengthHandles;
      }
      this._renderSimulationInspector();
      if (!isToggle) this._maybeAutoSaveSession();
      return true;
    }
    if (hit?.kind === 'paramHandle' && hit.handleType === 'pathClosed') {
      this.pushUndo();
      hit.target.closed = !hit.target.closed;
      this._setSimulationSelection({ collection: hit.collection, kind: hit.selectionKind || 'path', target: hit.target });
      this._renderSimulationInspector();
      this._maybeAutoSaveSession();
      return true;
    }
    if (hit?.kind) {
      this._setSimulationHover(this._getSimulationHoverSelectionFromHit(hit));
      this._setSimulationSelection(hit.kind === 'paramHandle'
        ? { collection: hit.collection, kind: hit.selectionKind || 'point', target: hit.target }
        : hit);
      this.simulation.dragTarget = {
        ...hit,
        lastX: x,
        lastY: y,
        dragStartX: x,
        dragStartY: y,
        dragLocked: hit.kind === 'paramHandle' ? hit.handleType === 'pathPosition' : true,
        undoState: this._captureState(),
      };
      return true;
    }

    const data = this._getSimulationBrushData();
    const p = this.getP();
    if (!data) return true;
    this._setSimulationHover(null);
    this._setSimulationSelection(null);

    if (tool === 'spawn') {
      this.pushUndo();
      const spawn = {
        id: this.simulation.nextId++,
        x,
        y,
        enabled: true,
        ...this._getSimulationItemDefaultFields('spawn', null, p),
      };
      data.spawns.push(spawn);
      this._setSimulationSelection({ collection: 'spawns', kind: 'spawn', target: spawn });
      this._maybeAutoSaveSession();
    } else if (tool === 'spawnBlob') {
      const stroke = new BlobStroke();
      stroke.begin(x, y, { radius: Math.max(8, p.spawnRadius) });
      this.simulation.drawingBlob = { stroke };
    } else if (tool === 'attract' || tool === 'repel') {
      this.pushUndo();
      const point = {
        id: this.simulation.nextId++,
        x,
        y,
        type: tool,
        enabled: true,
        ...this._getSimulationItemDefaultFields('point', { type: tool }, p),
      };
      data.points.push(point);
      this._setSimulationSelection({ collection: 'points', kind: 'point', target: point });
      this._maybeAutoSaveSession();
    } else if (tool === 'pheromone' && this.activeBrush === 'ant') {
      this.simulation.drawingPath = {
        kind: tool,
        points: [{ x, y }],
      };
    } else if (((tool === 'path') && (this._usesPathGuides())) || (tool === 'edge' && this.activeBrush === 'ant')) {
      this.simulation.drawingPath = {
        kind: tool,
        points: [{ x, y }],
      };
    }
    this._renderSimulationInspector();
    return true;
  }

  _handleSimulationPointerMove(x, y) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return false;
    const ui = this._getSimulationUiMetrics();
    const clampedPoint = this._clampSimulationPoint(x, y);
    x = clampedPoint.x;
    y = clampedPoint.y;
    if (this.simulation.dragTarget) {
      this._setSimulationHover(null);
      const hit = this.simulation.dragTarget;
      if (hit.dragLocked) {
        if (Math.hypot(x - hit.dragStartX, y - hit.dragStartY) < ui.dragDeadzone) {
          return true;
        }
        hit.dragLocked = false;
        hit.lastX = hit.dragStartX;
        hit.lastY = hit.dragStartY;
      }
      const dx = x - hit.lastX;
      const dy = y - hit.lastY;
      hit.lastX = x;
      hit.lastY = y;
      hit.moved = true;
      if (hit.kind === 'paramHandle') {
        this._applySimulationParameterHandleDrag(hit, x, y);
      } else {
        this._translateSimulationTarget(hit.target, dx, dy);
      }
      return true;
    }
    if (this.simulation.drawingBlob?.stroke) {
      this._setSimulationHover(null);
      this.simulation.drawingBlob.stroke.extend(x, y, { radius: Math.max(8, this.getP().spawnRadius) });
      return true;
    }
    if (this.simulation.drawingPath) {
      this._setSimulationHover(null);
      const pts = this.simulation.drawingPath.points;
      const last = pts[pts.length - 1];
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy >= 16) pts.push({ x, y });
      return true;
    }
    const hit = this._findSimulationHit(x, y);
    this._setSimulationHover(this._getSimulationHoverSelectionFromHit(hit));
    return this.simulation.running || this.simulation.paused;
  }

  _handleSimulationPointerUp() {
    if (!this.simulation.enabled || !this._isMotionBrush()) return false;
    const hadMoved = !!this.simulation.dragTarget?.moved;
    const dragKind = this.simulation.dragTarget?.kind;
    const dragUndoState = this.simulation.dragTarget?.undoState || null;
    this.simulation.dragTarget = null;
    if (this.simulation.drawingBlob?.stroke) {
      const data = this._getSimulationBrushData();
      const mask = this._createSimulationSpawnMaskFromStroke(this.simulation.drawingBlob.stroke, {
        distribution: 'uniform',
        noiseScale: 1,
      });
      if (data && mask) {
        this.pushUndo();
        const spawn = {
          id: this.simulation.nextId++,
          x: mask.bounds.minX + (mask.bounds.width * 0.5),
          y: mask.bounds.minY + (mask.bounds.height * 0.5),
          enabled: true,
          mask,
          ...this._getSimulationItemDefaultFields('spawn', { mask }, this.getP()),
        };
        data.spawns.push(spawn);
        this._setSimulationSelection({ collection: 'spawns', kind: 'spawn', target: spawn });
        this._maybeAutoSaveSession();
      }
      this.simulation.drawingBlob = null;
      this._renderSimulationInspector();
      return true;
    }
    if (this.simulation.drawingPath) {
      const path = this.simulation.drawingPath.points.filter((pt, i, arr) => i === 0 || Math.hypot(pt.x - arr[i - 1].x, pt.y - arr[i - 1].y) > 1);
      const data = this._getSimulationBrushData();
      if (data && path.length >= 2) {
        this.pushUndo();
        if (this.simulation.drawingPath.kind === 'path' && (this._usesPathGuides())) {
          const defaults = this._getSimulationItemDefaultFields('path', null, this.getP());
          const entry = {
            id: this.simulation.nextId++,
            points: path,
            enabled: true,
            color: defaults.color,
            radius: defaults.radius,
            strength: defaults.strength,
            influenceRadius: defaults.influenceRadius,
            closed: false,
            direction: defaults.direction,
            startOffset: 0,
            speed: defaults.speed,
            pathType: defaults.pathType,
            speedPoints: [],
            radiusPoints: [],
            strengthPoints: [],
            travelDistance: 0,
          };
          data.paths.push(entry);
          this._setSimulationSelection({ collection: 'paths', kind: 'path', target: entry });
          this._maybeAutoSaveSession();
        } else if (this.simulation.drawingPath.kind === 'edge' && this.activeBrush === 'ant') {
          const entry = {
            id: this.simulation.nextId++,
            points: path,
            enabled: true,
            ...this._getSimulationItemDefaultFields('edge', null, this.getP()),
          };
          data.edges.push(entry);
          this._setSimulationSelection({ collection: 'edges', kind: 'edge', target: entry });
          this._maybeAutoSaveSession();
        } else if (this.simulation.drawingPath.kind === 'pheromone' && this.activeBrush === 'ant') {
          const entry = {
            id: this.simulation.nextId++,
            points: path,
            enabled: true,
            ...this._getSimulationItemDefaultFields('pheromonePath', null, this.getP()),
          };
          data.pheromonePaths.push(entry);
          this._setSimulationSelection({ collection: 'pheromonePaths', kind: 'pheromonePath', target: entry });
          this._maybeAutoSaveSession();
        }
      }
      this.simulation.drawingPath = null;
      this._renderSimulationInspector();
      return true;
    }
    if (hadMoved) {
      if (dragUndoState && (dragKind === 'paramHandle' || dragKind === 'spawn' || dragKind === 'point' || dragKind === 'path' || dragKind === 'edge' || dragKind === 'pheromonePath')) {
        this.pushUndo(dragUndoState);
      }
      if (dragKind === 'paramHandle') this._renderSimulationInspector();
      this._maybeAutoSaveSession();
    }
    return this.simulation.running || this.simulation.paused || this.simulation.enabled;
  }

  _deleteSimulationItem(hit) {
    const data = this._getSimulationBrushData();
    if (!data) return;
    const collection = hit.collection;
    if (!collection || !Array.isArray(data[collection])) return;
    this.pushUndoForSimulationGuideChange('deleteGuide', this.activeBrush, { collection, id: hit.target?.id });
    data[collection] = data[collection].filter(item => item.id !== hit.target?.id);
    if (collection === 'spawns') this._ensureSimulationSpawns();
    const selected = this._getSelectedSimulationEntry();
    if (selected && selected.collection === collection && selected.id === hit.target?.id) {
      this.simulation.selected = null;
    }
    this._renderSimulationInspector();
    this._syncSimulationActionButtons();
    this._maybeAutoSaveSession();
  }

  clearSimulationGuides() {
    const data = this._getSimulationBrushData();
    if (!data) return;
    const hasGuides = !!(
      (data.spawns && data.spawns.length) ||
      (data.points && data.points.length) ||
      (data.paths && data.paths.length) ||
      (data.edges && data.edges.length) ||
      (data.pheromonePaths && data.pheromonePaths.length)
    );
    if (hasGuides) this.pushUndo();
    data.spawns = [];
    data.points = [];
    if (this._usesPathGuides()) data.paths = [];
    if (this.activeBrush === 'ant') {
      data.edges = [];
      data.pheromonePaths = [];
    }
    this.simulation.selected = null;
    this._ensureSimulationSpawns();
    this._renderSimulationInspector();
    this._syncSimulationActionButtons();
    this._maybeAutoSaveSession();
    this.showToast('Simulation guides cleared');
  }

  _getSimulationPolylineMinDistance(points, x, y) {
    if (!Array.isArray(points) || !points.length) return Infinity;
    if (points.length === 1) return Math.hypot(x - points[0].x, y - points[0].y);
    let minDistance = Infinity;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const candidate = _closestPointOnSegment(x, y, a.x, a.y, b.x, b.y);
      if (candidate.distance < minDistance) minDistance = candidate.distance;
    }
    return minDistance;
  }

  _getSimulationHeatmapValueAt(x, y, p = this.getP(), data = this._getSimulationBrushData()) {
    if (!data) return 0;
    let value = 0;
    const simSpeed = Math.max(0, p.simSpeed || 0);
    const guideSpeedScale = Math.max(1, p.maxSpeed || 0);

    for (const point of data.points || []) {
      if (point?.enabled === false) continue;
      const config = this._resolveSimulationPointConfig(point, p);
      if (!Number.isFinite(config.strength) || config.strength <= 0 || !Number.isFinite(config.radius) || config.radius <= 0) continue;
      const dx = point.x - x;
      const dy = point.y - y;
      const distance = Math.hypot(dx, dy);
      const sign = point.type === 'repel' ? -1 : 1;
      const outerRadius = point.type === 'repel'
        ? config.radius
        : Math.max(config.radius, config.influenceRadius || config.radius);
      if (distance > outerRadius) continue;
      let shaped = 0;
      if (sign < 0) {
        const falloff = Math.max(0, 1 - (distance / config.radius));
        shaped = Math.pow(falloff, Math.max(DEFAULT_SIM_HARDNESS, Math.min(MAX_SIM_HARDNESS, config.hardness)));
      } else if (distance <= config.radius) {
        shaped = Math.max(0, 1 - (distance / config.radius));
      } else {
        shaped = _pathInfluenceFalloff(distance, config.radius, outerRadius);
      }
      value += sign * config.strength * simSpeed * guideSpeedScale * shaped * 0.85;
    }

    if (this._usesPathGuides()) {
      for (const pathItem of data.paths || []) {
        if (pathItem?.enabled === false || !pathItem?.points?.length) continue;
        const target = this._getAnimatedSimulationPathTarget(pathItem, p);
        if (!target?.config) continue;
        const dx = target.x - x;
        const dy = target.y - y;
        const distance = Math.hypot(dx, dy);
        const influenceRadius = Math.max(target.config.radius || 0, target.config.influenceRadius || 0);
        if (distance > influenceRadius) continue;
        value += target.config.strength * simSpeed * guideSpeedScale * _pathInfluenceFalloff(distance, target.config.radius, target.config.influenceRadius);
      }
    }

    if (this.activeBrush === 'ant') {
      for (const trail of data.pheromonePaths || []) {
        if (trail?.enabled === false || !trail?.points?.length) continue;
        const config = this._resolveSimulationPheromoneConfig(trail, p);
        if (!Number.isFinite(config.radius) || config.radius <= 0 || !Number.isFinite(config.intensity) || config.intensity <= 0) continue;
        const distance = this._getSimulationPolylineMinDistance(trail.points, x, y);
        if (distance > config.radius) continue;
        value += (1 - (distance / config.radius)) * (config.intensity * 100) * simSpeed;
      }
      for (const edge of data.edges || []) {
        if (edge?.enabled === false || !edge?.points?.length) continue;
        const config = this._resolveSimulationEdgeConfig(edge, p);
        if (!Number.isFinite(config.radius) || config.radius <= 0 || !Number.isFinite(config.strength) || config.strength <= 0) continue;
        const distance = this._getSimulationPolylineMinDistance(edge.points, x, y);
        if (distance > config.radius) continue;
        value -= (1 - (distance / config.radius)) * config.strength * simSpeed;
      }
    }

    return value;
  }

  _drawSimulationHeatmapOverlay(ctx, p = this.getP(), data = this._getSimulationBrushData()) {
    if (!data) return;
    const guideSpeedScale = Math.max(1, p.maxSpeed || 0);
    const cellSize = Math.max(
      SIM_HEATMAP_MIN_CELL_SIZE,
      Math.min(SIM_HEATMAP_MAX_CELL_SIZE, Math.round(Math.min(this.W, this.H) / SIM_HEATMAP_TARGET_CELLS))
    );
    const samples = [];
    const pathHotspots = [];
    let maxAbs = 0;
    for (let top = 0; top < this.H; top += cellSize) {
      for (let left = 0; left < this.W; left += cellSize) {
        const centerX = Math.min(this.W - 1, left + (cellSize * 0.5));
        const centerY = Math.min(this.H - 1, top + (cellSize * 0.5));
        const value = this._getSimulationHeatmapValueAt(centerX, centerY, p, data);
        const magnitude = Math.abs(value);
        if (magnitude <= 1e-4) continue;
        if (magnitude > maxAbs) maxAbs = magnitude;
        samples.push({ left, top, value });
      }
    }

    if (this._usesPathGuides()) {
      for (const pathItem of data.paths || []) {
        if (pathItem?.enabled === false || !pathItem?.points?.length) continue;
        const target = this._getAnimatedSimulationPathTarget(pathItem, p);
        if (!target?.config) continue;
        const peak = Math.abs(target.config.strength) * Math.max(0, p.simSpeed || 0) * guideSpeedScale;
        if (peak <= 1e-4) continue;
        pathHotspots.push({
          x: target.x,
          y: target.y,
          radius: Math.max(target.config.radius || 0, target.config.influenceRadius || 0, 1),
          coreRadius: Math.max(1, target.config.radius || 0),
          peak,
          repel: target.config.strength < 0,
        });
        if (peak > maxAbs) maxAbs = peak;
      }
    }

    if (maxAbs <= 1e-4 || (!samples.length && !pathHotspots.length)) return;

    ctx.save();
    if (samples.length) {
      for (const sample of samples) {
        const alpha = Math.min(SIM_HEATMAP_MAX_ALPHA, (Math.abs(sample.value) / maxAbs) * SIM_HEATMAP_MAX_ALPHA);
        ctx.fillStyle = sample.value >= 0
          ? `rgba(255, 72, 72, ${alpha.toFixed(4)})`
          : `rgba(72, 132, 255, ${alpha.toFixed(4)})`;
        ctx.fillRect(sample.left, sample.top, cellSize + 1, cellSize + 1);
      }
    }

    // Path guides only influence the sim at their current animated target, so add
    // a direct hotspot overlay to make that moving attraction clearly visible.
    for (const hotspot of pathHotspots) {
      const alpha = Math.min(1, hotspot.peak / maxAbs);
      const gradient = ctx.createRadialGradient(hotspot.x, hotspot.y, 0, hotspot.x, hotspot.y, hotspot.radius);
      const startColor = hotspot.repel ? `rgba(72, 132, 255, ${(alpha * 0.95).toFixed(4)})` : `rgba(255, 72, 72, ${(alpha * 0.95).toFixed(4)})`;
      const midColor = hotspot.repel ? `rgba(72, 132, 255, ${(alpha * 0.55).toFixed(4)})` : `rgba(255, 72, 72, ${(alpha * 0.55).toFixed(4)})`;
      gradient.addColorStop(0, startColor);
      gradient.addColorStop(Math.min(1, Math.max(0.2, hotspot.coreRadius / hotspot.radius)), midColor);
      gradient.addColorStop(1, 'rgba(255, 72, 72, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(hotspot.x, hotspot.y, hotspot.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _findPolylineHit(points, x, y, maxDistance) {
    let best = null;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const candidate = _closestPointOnSegment(x, y, a.x, a.y, b.x, b.y);
      if (!best || candidate.distance < best.distance) best = candidate;
    }
    return best && best.distance <= maxDistance ? best : null;
  }

  _findSimulationHit(x, y) {
    if (this.simulation.guidesVisible === false) return null;
    const data = this._getSimulationBrushData();
    if (!data) return null;
    const ui = this._getSimulationUiMetrics();
    const selected = this._getSelectedSimulationEntry();
    const hovered = this._getHoveredSimulationEntry();
    const deleteBadgeLayouts = this._getSimulationDeleteBadgeLayouts();
    if (selected) {
      if (selected.kind === 'path') {
        const speedControls = this._getSimulationPathSpeedOverlayControls(selected.target);
        if (speedControls.addButton) {
          const halfWidth = speedControls.addButton.width * 0.5;
          const halfHeight = speedControls.addButton.height * 0.5;
          if (
            x >= speedControls.addButton.x - halfWidth &&
            x <= speedControls.addButton.x + halfWidth &&
            y >= speedControls.addButton.y - halfHeight &&
            y <= speedControls.addButton.y + halfHeight
          ) {
            return speedControls.addButton;
          }
        }
        if (speedControls.radiusAddButton) {
          const halfWidth = speedControls.radiusAddButton.width * 0.5;
          const halfHeight = speedControls.radiusAddButton.height * 0.5;
          if (
            x >= speedControls.radiusAddButton.x - halfWidth &&
            x <= speedControls.radiusAddButton.x + halfWidth &&
            y >= speedControls.radiusAddButton.y - halfHeight &&
            y <= speedControls.radiusAddButton.y + halfHeight
          ) {
            return speedControls.radiusAddButton;
          }
        }
        if (speedControls.strengthAddButton) {
          const halfWidth = speedControls.strengthAddButton.width * 0.5;
          const halfHeight = speedControls.strengthAddButton.height * 0.5;
          if (
            x >= speedControls.strengthAddButton.x - halfWidth &&
            x <= speedControls.strengthAddButton.x + halfWidth &&
            y >= speedControls.strengthAddButton.y - halfHeight &&
            y <= speedControls.strengthAddButton.y + halfHeight
          ) {
            return speedControls.strengthAddButton;
          }
        }
        for (const toggleButton of [speedControls.speedToggleButton, speedControls.radiusToggleButton, speedControls.strengthToggleButton]) {
          if (!toggleButton) continue;
          const halfWidth = toggleButton.width * 0.5;
          const halfHeight = toggleButton.height * 0.5;
          if (
            x >= toggleButton.x - halfWidth &&
            x <= toggleButton.x + halfWidth &&
            y >= toggleButton.y - halfHeight &&
            y <= toggleButton.y + halfHeight
          ) {
            return toggleButton;
          }
        }
      }
      const handles = this._getSimulationParameterHandles(selected).filter(h => {
        if (h.handleType === 'pathSpeed') return this._simPathOverlayUi.showSpeedHandles;
        if (h.handleType === 'pathRadius') return this._simPathOverlayUi.showRadiusHandles;
        if (h.handleType === 'pathStrength') return this._simPathOverlayUi.showStrengthHandles;
        return true;
      });
      for (const handle of handles) {
        if (Math.hypot(x - handle.x, y - handle.y) <= ui.paramHitRadius) {
          return handle;
        }
      }
      if (selected.kind === 'spawn') {
        const spawnControls = this._getSimulationSpawnOverlayControls(selected.target);
        if (spawnControls.formatButton) {
          const halfWidth = spawnControls.formatButton.width * 0.5;
          const halfHeight = spawnControls.formatButton.height * 0.5;
          if (
            x >= spawnControls.formatButton.x - halfWidth &&
            x <= spawnControls.formatButton.x + halfWidth &&
            y >= spawnControls.formatButton.y - halfHeight &&
            y <= spawnControls.formatButton.y + halfHeight
          ) return spawnControls.formatButton;
        }
      }
      if (selected.kind === 'path') {
        const speedControls = this._getSimulationPathSpeedOverlayControls(selected.target);
        if (speedControls.formatButton) {
          const halfWidth = speedControls.formatButton.width * 0.5;
          const halfHeight = speedControls.formatButton.height * 0.5;
          if (
            x >= speedControls.formatButton.x - halfWidth &&
            x <= speedControls.formatButton.x + halfWidth &&
            y >= speedControls.formatButton.y - halfHeight &&
            y <= speedControls.formatButton.y + halfHeight
          ) {
            return speedControls.formatButton;
          }
        }
        for (const button of speedControls.deleteButtons) {
          if (Math.hypot(x - button.x, y - button.y) <= ui.overlayActionHitRadius) {
            return button;
          }
        }
        for (const button of speedControls.radiusDeleteButtons) {
          if (Math.hypot(x - button.x, y - button.y) <= ui.overlayActionHitRadius) {
            return button;
          }
        }
        for (const button of speedControls.strengthDeleteButtons) {
          if (Math.hypot(x - button.x, y - button.y) <= ui.overlayActionHitRadius) {
            return button;
          }
        }
      }
    }
    const checkDelete = (target, collection, kind) => {
      const badge = deleteBadgeLayouts.get(this._getSimulationGuideChromeKey(collection, target));
      if (!badge?.visible) return null;
      const dx = x - badge.x;
      const dy = y - badge.y;
      return dx * dx + dy * dy <= ui.deleteHitRadius * ui.deleteHitRadius ? { kind: 'delete', target, collection, anchorType: kind } : null;
    };

    for (const spawn of this._ensureSimulationSpawns()) {
      const del = checkDelete(spawn, 'spawns', 'spawn');
      if (del) return del;
      if (Math.hypot(x - spawn.x, y - spawn.y) <= ui.pointHitRadius) return { kind: 'spawn', target: spawn, collection: 'spawns' };
    }

    for (const point of data.points) {
      const del = checkDelete(point, 'points', 'point');
      if (del) return del;
      if (Math.hypot(x - point.x, y - point.y) <= ui.pointHitRadius) return { kind: 'point', target: point, collection: 'points' };
    }

    if (this._usesPathGuides()) {
      for (const pathItem of data.paths || []) {
        const del = checkDelete(pathItem, 'paths', 'path');
        if (del) return del;
        if (this._findPolylineHit(this._getSimulationPathRenderPoints(pathItem), x, y, ui.lineHitRadius)) {
          return { kind: 'path', target: pathItem, collection: 'paths' };
        }
      }
    }

    if (this.activeBrush === 'ant') {
      for (const pathItem of data.pheromonePaths || []) {
        const del = checkDelete(pathItem, 'pheromonePaths', 'pheromonePath');
        if (del) return del;
        if (this._findPolylineHit(pathItem.points || [], x, y, ui.lineHitRadius)) {
          return { kind: 'pheromonePath', target: pathItem, collection: 'pheromonePaths' };
        }
      }
      for (const edge of data.edges || []) {
        const del = checkDelete(edge, 'edges', 'edge');
        if (del) return del;
        if (this._findPolylineHit(edge.points || [], x, y, ui.lineHitRadius)) {
          return { kind: 'edge', target: edge, collection: 'edges' };
        }
      }
    }

    return null;
  }

  _updateSimulationLeader(elapsed, p) {
    const center = this._getSimulationSpawnCenter();
    if (this.activeBrush === 'boid') {
      const targets = this._getSimulationGuideFollowTargets('boid', p, true, elapsed);
      if (targets.length) {
        let sx = 0;
        let sy = 0;
        let sw = 0;
        for (const target of targets) {
          const weight = Math.max(0.001, target.weight || 0);
          sx += target.x * weight;
          sy += target.y * weight;
          sw += weight;
        }
        this.leaderX = sx / Math.max(sw, 1);
        this.leaderY = sy / Math.max(sw, 1);
        return;
      }
    }

    if (this.activeBrush === 'motionPath') {
      const mode = p.simMotionPathMode === 'forces' ? 'forces' : 'path';
      if (mode === 'path') {
        const targets = this._getSimulationGuideFollowTargets('motionPath', p, true, elapsed);
        if (targets.length) {
          let sx = 0;
          let sy = 0;
          let sw = 0;
          for (const target of targets) {
            const weight = Math.max(0.001, target.weight || 0);
            sx += target.x * weight;
            sy += target.y * weight;
            sw += weight;
          }
          this.leaderX = sx / Math.max(sw, 1);
          this.leaderY = sy / Math.max(sw, 1);
          return;
        }
      } else {
        if (!Number.isFinite(this.leaderX) || !Number.isFinite(this.leaderY)) {
          this.leaderX = center.x;
          this.leaderY = center.y;
        }
        const dt = Math.max(0, Math.min(MOTION_PATH_LEADER_DELTA_MAX, elapsed > 0 ? elapsed - (this._lastLeaderElapsed || elapsed) : MOTION_PATH_LEADER_DELTA_FALLBACK));
        this._lastLeaderElapsed = elapsed;
        const force = this._getSimulationForceVectorAt(this.leaderX, this.leaderY, p, {
          brush: 'motionPath',
          includePaths: true,
          advancePaths: true,
          elapsed: dt * 1000,
        });
        const velocity = this.simulation.motionPathVelocity || { x: 0, y: 0 };
        velocity.x = (velocity.x + force.x * dt) * MOTION_PATH_LEADER_DAMPING;
        velocity.y = (velocity.y + force.y * dt) * MOTION_PATH_LEADER_DAMPING;
        this.simulation.motionPathVelocity = velocity;
        const next = this._clampSimulationPoint(this.leaderX + velocity.x, this.leaderY + velocity.y);
        this.leaderX = next.x;
        this.leaderY = next.y;
        return;
      }
    }

    this.leaderX = center.x;
    this.leaderY = center.y;
  }

  drawSimulationOverlay(ctx) {
    if (!this.simulation.enabled || !this._isMotionBrush()) return;
    const data = this._getSimulationBrushData();
    if (!data) return;
    const p = this.getP();
    const ui = this._getSimulationUiMetrics();
    if (this.simulation.heatmapVisible) this._drawSimulationHeatmapOverlay(ctx, p, data);
    if (this.simulation.guidesVisible === false) return;
    const selected = this._getSelectedSimulationEntry();
    const hovered = this._getHoveredSimulationEntry();
    const deleteBadgeLayouts = this._getSimulationDeleteBadgeLayouts();
    const isSelected = (collection, item) => selected?.collection === collection && selected?.id === item.id;
    const isHovered = (collection, item) => hovered?.collection === collection && hovered?.id === item.id;
    const allParamHandles = selected ? this._getSimulationParameterHandles(selected, p) : [];
    const selectedHandles = allParamHandles.filter(h => {
      if (h.handleType === 'pathSpeed') return this._simPathOverlayUi.showSpeedHandles;
      if (h.handleType === 'pathRadius') return this._simPathOverlayUi.showRadiusHandles;
      if (h.handleType === 'pathStrength') return this._simPathOverlayUi.showStrengthHandles;
      return true;
    });

    const drawDelete = (collection, kind, target, anchorX, anchorY) => {
      const badge = deleteBadgeLayouts.get(this._getSimulationGuideChromeKey(collection, target)) || this._getSimDeleteBadgePos(anchorX, anchorY);
      if (!badge?.visible) return;
      if (Math.hypot((badge.x || 0) - (badge.trueX || badge.x || 0), (badge.y || 0) - (badge.trueY || badge.y || 0)) > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.24)';
        ctx.lineWidth = Math.max(1, ui.scale);
        ctx.setLineDash([4 * ui.scale, 3 * ui.scale]);
        ctx.beginPath();
        ctx.moveTo(badge.trueX, badge.trueY);
        ctx.lineTo(badge.x, badge.y);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = 'rgba(18,18,22,0.72)';
      ctx.beginPath();
      ctx.arc(badge.x, badge.y, ui.deleteBadgeRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.34)';
      ctx.lineWidth = Math.max(1, ui.scale);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = `${ui.deleteBadgeFont}px Segoe UI, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('×', badge.x, badge.y + (0.5 * ui.scale));
    };

    const drawOverlayChip = (button, label) => {
      if (!button) return;
      const width = button.width || 22;
      const height = button.height || 22;
      const radius = Math.min(9, height * 0.5);
      const strokeStyle = button.strokeStyle || 'rgba(126,206,255,0.7)';
      const fillStyle = button.fillStyle || 'rgba(12,18,30,0.82)';
      const textStyle = button.textStyle || 'rgba(214,240,255,0.96)';
      ctx.save();
      ctx.fillStyle = fillStyle;
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = Math.max(1, 1.2 * ui.scale);
      ctx.beginPath();
      ctx.moveTo(button.x - width * 0.5 + radius, button.y - height * 0.5);
      ctx.lineTo(button.x + width * 0.5 - radius, button.y - height * 0.5);
      ctx.quadraticCurveTo(button.x + width * 0.5, button.y - height * 0.5, button.x + width * 0.5, button.y - height * 0.5 + radius);
      ctx.lineTo(button.x + width * 0.5, button.y + height * 0.5 - radius);
      ctx.quadraticCurveTo(button.x + width * 0.5, button.y + height * 0.5, button.x + width * 0.5 - radius, button.y + height * 0.5);
      ctx.lineTo(button.x - width * 0.5 + radius, button.y + height * 0.5);
      ctx.quadraticCurveTo(button.x - width * 0.5, button.y + height * 0.5, button.x - width * 0.5, button.y + height * 0.5 - radius);
      ctx.lineTo(button.x - width * 0.5, button.y - height * 0.5 + radius);
      ctx.quadraticCurveTo(button.x - width * 0.5, button.y - height * 0.5, button.x - width * 0.5 + radius, button.y - height * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = textStyle;
      ctx.font = `${(width > 30 ? 11 : 10) * ui.scale}px Segoe UI, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, button.x, button.y + 0.5);
      ctx.restore();
    };

    const drawHandle = (handle, color) => {
      if (!handle?.target) return;
      const anchorX = Number.isFinite(handle.anchorX) ? handle.anchorX : handle.target.x;
      const anchorY = Number.isFinite(handle.anchorY) ? handle.anchorY : handle.target.y;
      const isRadiusHandle = handle.handleType === 'radius'
        || handle.handleType === 'pathRadius'
        || handle.handleType === 'edgeRadius'
        || handle.handleType === 'pheromoneRadius';
      const isRingStrengthHandle = handle.handleType === 'pathStrength'
        || handle.handleType === 'edgeStrength'
        || handle.handleType === 'pheromoneIntensity';
      const handleColor = isRadiusHandle
        ? SIM_PATH_RADIUS_HANDLE_COLOR
        : isRingStrengthHandle
          ? SIM_PATH_STRENGTH_HANDLE_COLOR
          : handle.handleType === 'pathPosition'
            ? SIM_PATH_POSITION_HANDLE_COLOR
            : color;
      ctx.save();
      ctx.strokeStyle = handleColor;
      ctx.fillStyle = handleColor;
      ctx.lineWidth = Math.max(1, 1.75 * ui.scale);
      if (Number.isFinite(anchorX) && Number.isFinite(anchorY) && (Math.abs(handle.x - anchorX) > 0.5 || Math.abs(handle.y - anchorY) > 0.5)) {
        ctx.beginPath();
        ctx.moveTo(anchorX, anchorY);
        ctx.lineTo(handle.x, handle.y);
        ctx.stroke();
      }
      if (handle.handleType === 'strength') {
        ctx.translate(handle.x, handle.y);
        ctx.rotate(Math.PI * 0.25);
        ctx.fillRect(-ui.paramHandleRadius + ui.scale, -ui.paramHandleRadius + ui.scale, (ui.paramHandleRadius - ui.scale) * 2, (ui.paramHandleRadius - ui.scale) * 2);
      } else if (handle.handleType === 'pathDirection') {
        const angle = Math.atan2(handle.y - anchorY, handle.x - anchorX);
        ctx.translate(handle.x, handle.y);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(ui.paramHandleRadius, 0);
        ctx.lineTo(-ui.paramHandleRadius + ui.scale, -ui.paramHandleRadius + ui.scale);
        ctx.lineTo(-ui.paramHandleRadius + ui.scale, ui.paramHandleRadius + ui.scale);
        ctx.closePath();
        ctx.fill();
      } else if (handle.handleType === 'pathStart') {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, ui.paramHandleRadius + (1.5 * ui.scale), 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, Math.max(1, ui.paramHandleRadius - (2 * ui.scale)), 0, Math.PI * 2);
        ctx.fill();
      } else if (handle.handleType === 'pathScale') {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, ui.paramHandleRadius + ui.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.moveTo(handle.x - (4 * ui.scale), handle.y);
        ctx.lineTo(handle.x + (4 * ui.scale), handle.y);
        ctx.moveTo(handle.x, handle.y - (4 * ui.scale));
        ctx.lineTo(handle.x, handle.y + (4 * ui.scale));
        ctx.stroke();
      } else if (handle.handleType === 'pathPosition') {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, ui.pathPositionHandleRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(12,18,30,0.9)';
        ctx.lineWidth = Math.max(1, 1.4 * ui.scale);
        ctx.beginPath();
        ctx.moveTo(handle.x - (5 * ui.scale), handle.y);
        ctx.lineTo(handle.x + (5 * ui.scale), handle.y);
        ctx.moveTo(handle.x, handle.y - (5 * ui.scale));
        ctx.lineTo(handle.x, handle.y + (5 * ui.scale));
        ctx.stroke();
      } else if (handle.handleType === 'pathClosed') {
        const width = 18 * ui.scale;
        const height = 12 * ui.scale;
        ctx.fillRect(handle.x - width * 0.5, handle.y - height * 0.5, width, height);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeRect(handle.x - width * 0.5, handle.y - height * 0.5, width, height);
      } else if (handle.handleType === 'pathSpeed') {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, ui.paramHandleRadius + (0.5 * ui.scale), 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(handle.x, handle.y - (5 * ui.scale));
        ctx.lineTo(handle.x + (4 * ui.scale), handle.y + ui.scale);
        ctx.lineTo(handle.x - (4 * ui.scale), handle.y + ui.scale);
        ctx.closePath();
        ctx.fill();
      } else if (isRadiusHandle) {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, ui.paramHandleRadius + (0.5 * ui.scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth = Math.max(1, 1.2 * ui.scale);
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, 4.2 * ui.scale, 0, Math.PI * 2);
        ctx.stroke();
      } else if (isRingStrengthHandle) {
        ctx.strokeStyle = SIM_PATH_STRENGTH_HANDLE_COLOR;
        ctx.fillStyle = SIM_PATH_STRENGTH_HANDLE_COLOR;
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, ui.paramHandleRadius + (0.5 * ui.scale), 0, Math.PI * 2);
        ctx.stroke();
        // Diamond fill to distinguish from radius
        ctx.save();
        ctx.translate(handle.x, handle.y);
        ctx.rotate(Math.PI * 0.25);
        ctx.fillRect(-4 * ui.scale, -4 * ui.scale, 8 * ui.scale, 8 * ui.scale);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, ui.paramHandleRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    const drawSelectedHandles = (item, color) => {
      for (const handle of selectedHandles) {
        if (handle.target === item) drawHandle(handle, color);
      }
    };

    const drawPathArrow = (x, y, angle, color, scale = 1) => {
      const length = ui.pathDirectionArrowLength * scale;
      const wing = 5 * ui.scale * scale;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, 1.8 * ui.scale);
      ctx.beginPath();
      ctx.moveTo(-length, -wing);
      ctx.lineTo(0, 0);
      ctx.lineTo(-length, wing);
      ctx.stroke();
      ctx.restore();
    };

    for (const spawn of this._ensureSimulationSpawns()) {
      const config = this._resolveSimulationSpawnConfig(spawn, p);
      const active = spawn.enabled !== false;
      const sel = isSelected('spawns', spawn);
      const hover = !sel && isHovered('spawns', spawn);
      ctx.save();
      ctx.globalAlpha = active ? 1 : 0.35;
      ctx.strokeStyle = sel ? 'rgba(140,196,255,0.98)' : hover ? 'rgba(186,228,255,0.9)' : 'rgba(255,255,255,0.45)';
      ctx.fillStyle = sel ? 'rgba(100,180,255,0.14)' : hover ? 'rgba(134,198,255,0.12)' : 'rgba(255,255,255,0.06)';
      ctx.lineWidth = sel ? 3 : hover ? 2.25 : 1.25;
      if (sel || hover) {
        ctx.shadowColor = 'rgba(100,180,255,0.7)';
        ctx.shadowBlur = sel ? 12 : 8;
      }
      if (spawn.mask) {
        this._drawSimulationSpawnMaskPreview(ctx, spawn.mask, {
          fillStyle: 'rgba(0,0,0,0)',
          strokeStyle: sel ? 'rgba(140,196,255,0.96)' : 'rgba(110,176,255,0.78)',
          outlineOnly: true,
        });
      } else {
        ctx.beginPath();
        ctx.arc(spawn.x, spawn.y, Math.max(8, config.radius + (sel ? 4 : 0)), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(spawn.x, spawn.y, 5 * ui.scale, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      if (sel) {
        drawSelectedHandles(spawn, 'rgba(140,196,255,0.98)');
        const spawnControls = this._getSimulationSpawnOverlayControls(spawn, p);
        if (spawnControls.formatButton) {
          drawOverlayChip({
            ...spawnControls.formatButton,
            strokeStyle: 'rgba(140,196,255,0.9)',
            textStyle: 'rgba(220,244,255,0.98)',
          }, 'Format');
        }
      }
      if (sel || hover) {
        const deleteAnchor = this._getSimulationDeleteAnchor(spawn, 'spawn');
        drawDelete('spawns', 'spawn', spawn, deleteAnchor.x, deleteAnchor.y);
      }
      ctx.restore();
    }

    for (const point of data.points) {
      const config = this._resolveSimulationPointConfig(point, p);
      const attract = point.type === 'attract';
      const sel = isSelected('points', point);
      const hover = !sel && isHovered('points', point);
      const color = sel
        ? 'rgba(150,214,255,0.95)'
        : hover ? (attract ? 'rgba(142,194,255,0.94)' : 'rgba(255,214,158,0.95)')
          : attract ? 'rgba(94,149,255,0.76)' : 'rgba(255,188,118,0.78)';
      const fill = hover
        ? (attract ? 'rgba(54,98,185,0.14)' : 'rgba(217,147,66,0.14)')
        : attract ? 'rgba(54,98,185,0.1)' : 'rgba(217,147,66,0.1)';
      ctx.save();
      ctx.globalAlpha = point.enabled !== false ? 1 : 0.35;
      ctx.strokeStyle = color;
      ctx.fillStyle = fill;
      ctx.lineWidth = sel ? 3 : hover ? 2.25 : 1.25;
      if (sel || hover) {
        ctx.shadowColor = attract ? 'rgba(94,149,255,0.65)' : 'rgba(255,188,118,0.65)';
        ctx.shadowBlur = sel ? 10 : 6;
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, config.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 7 * ui.scale, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (sel) drawSelectedHandles(point, color);
      if (sel || hover) drawDelete('points', 'point', point, point.x, point.y);
      ctx.restore();
    }

    if (this._usesPathGuides()) {
      for (const pathItem of data.paths || []) {
        if (!pathItem.points?.length) continue;
        const config = this._resolveSimulationPathConfig(pathItem, p);
        const renderPoints = this._getSimulationPathRenderPoints(pathItem);
        const target = this._getAnimatedSimulationPathTarget(pathItem, p);
        const startSample = this._getSimulationPathSample(pathItem, 0, p);
        const pathSel = isSelected('paths', pathItem);
        const pathHover = !pathSel && isHovered('paths', pathItem);
        const pathStrokeColor = pathSel ? 'rgba(168,218,255,0.98)' : pathHover ? 'rgba(198,232,255,0.92)' : 'rgba(116,166,255,0.72)';
        ctx.save();
        ctx.globalAlpha = pathItem.enabled !== false ? 1 : 0.3;
        ctx.strokeStyle = pathStrokeColor;
        ctx.lineWidth = pathSel ? 4 : pathHover ? 3 : 2;
        if (pathSel || pathHover) {
          ctx.shadowColor = 'rgba(120,200,255,0.7)';
          ctx.shadowBlur = pathSel ? 10 : 6;
        }
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(renderPoints[0].x, renderPoints[0].y);
        for (let i = 1; i < renderPoints.length; i++) ctx.lineTo(renderPoints[i].x, renderPoints[i].y);
        if (config.closed) ctx.closePath();
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
        const bandAlpha = (pathItem.enabled !== false ? 1 : 0.3) * 0.16;
        const radiusPointCount = Array.isArray(pathItem.radiusPoints) ? pathItem.radiusPoints.length : 0;
        this._drawSimulationOverlayBand(ctx, bandAlpha, bandCtx => {
          bandCtx.save();
          bandCtx.strokeStyle = pathStrokeColor;
          bandCtx.lineCap = 'round';
          bandCtx.lineJoin = 'round';
          if (radiusPointCount && renderPoints.length >= 2) {
            let traveled = 0;
            const totalLength = _buildPolylineSegments(renderPoints, config.closed).totalLength;
            const segmentCount = config.closed ? renderPoints.length : renderPoints.length - 1;
            for (let index = 0; index < segmentCount; index++) {
              const start = renderPoints[index];
              const end = renderPoints[(index + 1) % renderPoints.length];
              const length = Math.hypot(end.x - start.x, end.y - start.y);
              if (length <= 1e-6) continue;
              const startT = totalLength > 1e-6 ? traveled / totalLength : 0;
              const endT = totalLength > 1e-6 ? (traveled + length) / totalLength : startT;
              const segmentRadius = Math.max(
                _getSimulationPathRadiusAt(pathItem, startT, config.radius, config.closed),
                _getSimulationPathRadiusAt(pathItem, endT, config.radius, config.closed),
              );
              bandCtx.lineWidth = Math.max(2, segmentRadius * 2);
              bandCtx.beginPath();
              bandCtx.moveTo(start.x, start.y);
              bandCtx.lineTo(end.x, end.y);
              bandCtx.stroke();
              traveled += length;
            }
          } else {
            bandCtx.lineWidth = config.radius * 2;
            bandCtx.beginPath();
            bandCtx.moveTo(renderPoints[0].x, renderPoints[0].y);
            for (let i = 1; i < renderPoints.length; i++) bandCtx.lineTo(renderPoints[i].x, renderPoints[i].y);
            if (config.closed) bandCtx.closePath();
            bandCtx.stroke();
          }
          bandCtx.restore();
        });
        if (target) {
          ctx.globalAlpha = pathItem.enabled !== false ? 1 : 0.3;
          ctx.fillStyle = isSelected('paths', pathItem) ? 'rgba(196,233,255,0.98)' : 'rgba(136,190,255,0.95)';
          ctx.beginPath();
          ctx.arc(target.x, target.y, Math.max(5, Math.min(11, (target.radius || config.radius) * 0.2)), 0, Math.PI * 2);
          ctx.fill();
        }
        if (startSample) {
          const startColor = isSelected('paths', pathItem) ? 'rgba(120,236,178,0.98)' : 'rgba(120,236,178,0.82)';
          ctx.globalAlpha = pathItem.enabled !== false ? 1 : 0.35;
          ctx.fillStyle = startColor;
          ctx.strokeStyle = 'rgba(12,16,24,0.85)';
          ctx.lineWidth = Math.max(1, 1.25 * ui.scale);
          ctx.beginPath();
          ctx.arc(startSample.x, startSample.y, ui.pathStartMarkerRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          const angle = Math.atan2(startSample.tangentY, startSample.tangentX) + (startSample.config.direction === 'reverse' ? Math.PI : 0);
          drawPathArrow(startSample.x + (Math.cos(angle) * (ui.pathStartMarkerRadius + (2 * ui.scale))), startSample.y + (Math.sin(angle) * (ui.pathStartMarkerRadius + (2 * ui.scale))), angle, startColor, isSelected('paths', pathItem) ? 1.1 : 0.95);
        }
        if (isSelected('paths', pathItem)) {
          drawSelectedHandles(pathItem, 'rgba(120,236,178,0.98)');
          const speedControls = this._getSimulationPathSpeedOverlayControls(pathItem, p);
          if (speedControls.addButton) drawOverlayChip(speedControls.addButton, '+ Speed');
          if (speedControls.radiusAddButton) {
            drawOverlayChip({
              ...speedControls.radiusAddButton,
              strokeStyle: 'rgba(255,105,214,0.82)',
              textStyle: 'rgba(255,222,246,0.98)',
            }, '+ Radius');
          }
          if (speedControls.strengthAddButton) {
            drawOverlayChip({
              ...speedControls.strengthAddButton,
              strokeStyle: 'rgba(100,220,255,0.82)',
              textStyle: 'rgba(196,244,255,0.98)',
            }, '+ Strength');
          }
          if (speedControls.formatButton) {
            drawOverlayChip({
              ...speedControls.formatButton,
              strokeStyle: 'rgba(255,214,120,0.82)',
              textStyle: 'rgba(255,240,196,0.98)',
            }, 'Format');
          }
          for (const button of speedControls.deleteButtons) {
            drawDelete('paths', 'pathSpeedPoint', { id: `speed:${button.speedPointId}` }, button.x, button.y);
          }
          for (const button of speedControls.radiusDeleteButtons) {
            drawDelete('paths', 'pathRadiusPoint', { id: `radius:${button.radiusPointId}` }, button.x, button.y);
          }
          for (const button of speedControls.strengthDeleteButtons) {
            drawDelete('paths', 'pathStrengthPoint', { id: `strength:${button.strengthPointId}` }, button.x, button.y);
          }
          const drawToggleChip = (button, active) => {
            if (!button) return;
            drawOverlayChip({
              ...button,
              strokeStyle: active ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.25)',
              textStyle: active ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)',
            }, active ? '✓' : '○');
          };
          if (speedControls.speedToggleButton) drawToggleChip(speedControls.speedToggleButton, this._simPathOverlayUi.showSpeedHandles);
          if (speedControls.radiusToggleButton) drawToggleChip(speedControls.radiusToggleButton, this._simPathOverlayUi.showRadiusHandles);
          if (speedControls.strengthToggleButton) drawToggleChip(speedControls.strengthToggleButton, this._simPathOverlayUi.showStrengthHandles);
        }
        if (pathSel || pathHover) {
          const anchor = this._getSimulationAnchor(pathItem);
          drawDelete('paths', 'path', pathItem, anchor.x, anchor.y);
        }
        ctx.restore();
      }
    }

    if (this.activeBrush === 'ant') {
      for (const trail of data.pheromonePaths || []) {
        if (!trail.points?.length) continue;
        const config = this._resolveSimulationPheromoneConfig(trail, p);
        const trailSel = isSelected('pheromonePaths', trail);
        const trailHover = !trailSel && isHovered('pheromonePaths', trail);
        ctx.save();
        ctx.globalAlpha = trail.enabled !== false ? 1 : 0.35;
        ctx.strokeStyle = trailSel ? 'rgba(194,255,150,0.95)' : trailHover ? 'rgba(214,255,190,0.94)' : 'rgba(120,200,80,0.72)';
        ctx.lineWidth = Math.max(2, config.radius * 2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (trailSel || trailHover) {
          ctx.shadowColor = 'rgba(150,255,100,0.6)';
          ctx.shadowBlur = trailSel ? 8 : 5;
        }
        ctx.globalAlpha *= Math.max(0.12, config.intensity * 0.4);
        ctx.beginPath();
        ctx.moveTo(trail.points[0].x, trail.points[0].y);
        for (let i = 1; i < trail.points.length; i++) ctx.lineTo(trail.points[i].x, trail.points[i].y);
        ctx.stroke();
        if (trailSel) drawSelectedHandles(trail, 'rgba(194,255,150,0.95)');
        ctx.restore();
        if (trailSel || trailHover) {
          const anchor = this._getSimulationAnchor(trail);
          drawDelete('pheromonePaths', 'pheromonePath', trail, anchor.x, anchor.y);
        }
      }
      for (const edge of data.edges) {
        if (!edge.points?.length) continue;
        const config = this._resolveSimulationEdgeConfig(edge, p);
        const edgeSel = isSelected('edges', edge);
        const edgeHover = !edgeSel && isHovered('edges', edge);
        ctx.save();
        ctx.globalAlpha = edge.enabled !== false ? 1 : 0.35;
        ctx.strokeStyle = edgeSel ? 'rgba(255,238,160,0.98)' : edgeHover ? 'rgba(255,243,188,0.96)' : 'rgba(255,210,120,0.78)';
        ctx.fillStyle = 'rgba(255,210,120,0.08)';
        ctx.lineWidth = edgeSel ? 4 : edgeHover ? 3 : 2;
        if (edgeSel || edgeHover) {
          ctx.shadowColor = 'rgba(255,220,80,0.6)';
          ctx.shadowBlur = edgeSel ? 10 : 6;
        }
        ctx.beginPath();
        ctx.moveTo(edge.points[0].x, edge.points[0].y);
        for (let i = 1; i < edge.points.length; i++) ctx.lineTo(edge.points[i].x, edge.points[i].y);
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (config.radius > 0) {
          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.lineWidth = config.radius * 2;
          ctx.stroke();
          ctx.restore();
        }
        if (edgeSel) drawSelectedHandles(edge, 'rgba(255,238,160,0.98)');
        if (edgeSel || edgeHover) {
          const anchor = this._getSimulationAnchor(edge);
          drawDelete('edges', 'edge', edge, anchor.x, anchor.y);
        }
        ctx.restore();
      }
    }

    if (this.simulation.drawingPath?.points?.length >= 2) {
      const pts = this.simulation.drawingPath.points;
      ctx.strokeStyle =
        this.simulation.drawingPath.kind === 'edge' ? 'rgba(255,210,120,0.85)'
        : this.simulation.drawingPath.kind === 'pheromone' ? 'rgba(120,200,80,0.85)'
        : 'rgba(116,166,255,0.85)';
      ctx.lineWidth = this.simulation.drawingPath.kind === 'pheromone'
        ? Math.max(2, p.simPheroPaintRadius * 2)
        : 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.simulation.drawingBlob?.stroke) {
      this.simulation.drawingBlob.stroke.renderPreview(ctx, {
        fillStyle: 'rgba(140,196,255,0.18)',
        strokeStyle: 'rgba(140,196,255,0.92)',
        guideStyle: 'rgba(255,210,120,0.85)',
      });
    }
  }

  // ========================================================
  // MOTION PATH DOCUMENTS / EDITOR
  // ========================================================

  _createMotionPathEditorState() {
    return {
      canvas: null,
      ctx: null,
      activePanel: null,
      helpOpen: false,
      selectedPathId: null,
      selectedPathIds: [],
      selectedHandleIndex: -1,
      selectedHandleType: null,
      hoverPathId: null,
      hoverHandleIndex: -1,
      hoverHandleType: null,
      dragPathId: null,
      dragMode: null,
      dragHandleIndex: -1,
      activeTool: 'select',
      creationPathId: null,
      clipboardPaths: [],
      pasteCount: 0,
      insertPointMode: false,
      insertBetweenPoints: false,
      pointerId: null,
      touchPoints: {},
      touchGestureActive: false,
      touchGestureDistance: 0,
      touchGestureCenterX: 0,
      touchGestureCenterY: 0,
      lastLocalX: 0,
      lastLocalY: 0,
      lastScreenX: 0,
      lastScreenY: 0,
      needsRedraw: true,
      canvasWidth: 0,
      canvasHeight: 0,
    };
  }

  _createMotionPathDocumentRecord(id, name = `Motion Graph ${id}`) {
    return {
      id,
      name,
      version: 1,
      paths: [],
      agents: [],
      rules: [],
      view: { zoom: 1, panX: 0, panY: 0 },
      nextPathId: 1,
      nextGroupId: 1,
      updatedAt: Date.now(),
    };
  }

  _createDefaultMotionPathState() {
    return {
      documents: [this._createMotionPathDocumentRecord(1, 'Motion Graph 1')],
      activeDocumentId: 1,
      nextDocumentId: 2,
      editorOpen: false,
      previousUiState: null,
    };
  }

  _normalizeMotionPathState() {
    if (!this.motionPath || typeof this.motionPath !== 'object') {
      this.motionPath = this._createDefaultMotionPathState();
      return;
    }
    const rawDocs = Array.isArray(this.motionPath.documents) ? this.motionPath.documents : [];
    const docs = rawDocs.map((doc, index) => {
      const fallbackId = index + 1;
      const id = Number.isFinite(doc?.id) ? Math.max(1, Math.round(doc.id)) : fallbackId;
      const name = typeof doc?.name === 'string' && doc.name.trim() ? doc.name.trim().slice(0, 60) : `Motion Graph ${id}`;
      const rawPaths = Array.isArray(doc?.paths) ? doc.paths : [];
      let nextPathId = 1;
      let nextGroupId = 1;
      const paths = rawPaths.map((pathItem, pathIndex) => {
        const pathId = Number.isFinite(pathItem?.id) ? Math.max(1, Math.round(pathItem.id)) : nextPathId;
        nextPathId = Math.max(nextPathId, pathId + 1);
        const groupId = _normalizeMotionPathGroupId(pathItem?.groupId);
        if (groupId) nextGroupId = Math.max(nextGroupId, groupId + 1);
        const kind = ['polyline', 'bezier', 'rectangle', 'ellipse', 'radial'].includes(pathItem?.kind) ? pathItem.kind : 'polyline';
        const fallbackPoints = kind === 'bezier'
          ? [
              { x: -MOTION_PATH_DEFAULT_HALF_WIDTH, y: MOTION_PATH_DEFAULT_HALF_HEIGHT, connector: 'curve' },
              { x: 0, y: -MOTION_PATH_DEFAULT_HALF_HEIGHT, connector: 'curve' },
              { x: MOTION_PATH_DEFAULT_HALF_WIDTH, y: MOTION_PATH_DEFAULT_HALF_HEIGHT, connector: 'curve' },
            ]
          : kind === 'rectangle' || kind === 'ellipse'
            ? [
                { x: -MOTION_PATH_DEFAULT_HALF_WIDTH, y: -MOTION_PATH_DEFAULT_HALF_HEIGHT },
                { x: MOTION_PATH_DEFAULT_HALF_WIDTH, y: MOTION_PATH_DEFAULT_HALF_HEIGHT },
              ]
            : kind === 'radial'
              ? [
                  { x: 0, y: 0 },
                  { x: 0, y: -MOTION_PATH_DEFAULT_HALF_HEIGHT },
              ]
            : [
                { x: -MOTION_PATH_DEFAULT_HALF_WIDTH, y: MOTION_PATH_DEFAULT_HALF_HEIGHT },
                { x: 0, y: -MOTION_PATH_DEFAULT_HALF_HEIGHT },
                { x: MOTION_PATH_DEFAULT_HALF_WIDTH, y: MOTION_PATH_DEFAULT_HALF_HEIGHT },
              ];
        const rawPoints = Array.isArray(pathItem?.points) ? pathItem.points : fallbackPoints;
        const points = _normalizeMotionPathPoints(kind, rawPoints, fallbackPoints);
        return {
          id: pathId,
          name: typeof pathItem?.name === 'string' && pathItem.name.trim()
            ? pathItem.name.trim().slice(0, 40)
            : `${kind[0].toUpperCase()}${kind.slice(1)} ${pathIndex + 1}`,
          kind,
          closed: kind === 'rectangle' || kind === 'ellipse' ? true : !!pathItem?.closed,
          endBehavior: _normalizeMotionPathEndBehavior(pathItem?.endBehavior),
          directionMode: _normalizeMotionPathDirectionMode(pathItem?.directionMode),
          startMode: _normalizeMotionPathStartMode(pathItem?.startMode),
          agentCount: Number.isFinite(pathItem?.agentCount) ? Math.max(0, Math.round(pathItem.agentCount)) : 0,
          speedMultiplier: Number.isFinite(pathItem?.speedMultiplier) ? Math.max(0.1, pathItem.speedMultiplier) : 1,
          groupId,
          groupKind: typeof pathItem?.groupKind === 'string' ? pathItem.groupKind : '',
          groupName: _normalizeMotionPathGroupName(pathItem?.groupName),
          radialLineIndex: Number.isFinite(pathItem?.radialLineIndex) ? Math.max(0, Math.round(pathItem.radialLineIndex)) : 0,
          radialCount: _normalizeMotionPathRadialCount(pathItem?.radialCount),
          radialSpread: _normalizeMotionPathRadialSpread(pathItem?.radialSpread),
          points: points.length ? points : _normalizeMotionPathPoints(kind, fallbackPoints, fallbackPoints),
        };
      });
      return {
        id,
        name,
        version: Number.isFinite(doc?.version) ? Math.max(1, Math.round(doc.version)) : 1,
        paths,
        agents: Array.isArray(doc?.agents) ? doc.agents : [],
        rules: Array.isArray(doc?.rules) ? doc.rules : [],
        view: {
          zoom: Number.isFinite(doc?.view?.zoom) ? Math.max(0.1, doc.view.zoom) : 1,
          panX: Number.isFinite(doc?.view?.panX) ? doc.view.panX : 0,
          panY: Number.isFinite(doc?.view?.panY) ? doc.view.panY : 0,
        },
        nextPathId: Number.isFinite(doc?.nextPathId) ? Math.max(nextPathId, Math.round(doc.nextPathId)) : nextPathId,
        nextGroupId: Number.isFinite(doc?.nextGroupId) ? Math.max(nextGroupId, Math.round(doc.nextGroupId)) : nextGroupId,
        updatedAt: Number.isFinite(doc?.updatedAt) ? doc.updatedAt : Date.now(),
      };
    });
    if (!docs.length) docs.push(this._createMotionPathDocumentRecord(1, 'Motion Graph 1'));
    const idSet = new Set();
    for (const doc of docs) {
      while (idSet.has(doc.id)) doc.id += 1;
      idSet.add(doc.id);
    }
    const maxId = docs.reduce((best, doc) => Math.max(best, doc.id), 0);
    const activeDocumentId = idSet.has(this.motionPath.activeDocumentId) ? this.motionPath.activeDocumentId : docs[0].id;
    this.motionPath.documents = docs;
    this.motionPath.activeDocumentId = activeDocumentId;
    this.motionPath.nextDocumentId = Number.isFinite(this.motionPath.nextDocumentId)
      ? Math.max(maxId + 1, Math.round(this.motionPath.nextDocumentId))
      : maxId + 1;
    this.motionPath.editorOpen = !!this.motionPath.editorOpen;
    this.motionPath.previousUiState = null;
    if (!this.motionPathEditor || typeof this.motionPathEditor !== 'object') {
      this.motionPathEditor = this._createMotionPathEditorState();
    }
  }

  _serializeMotionPathState() {
    this._normalizeMotionPathState();
    return {
      documents: _deepClone(this.motionPath.documents),
      activeDocumentId: this.motionPath.activeDocumentId,
      nextDocumentId: this.motionPath.nextDocumentId,
    };
  }

  _getMotionPathDocumentById(id) {
    this._normalizeMotionPathState();
    return this.motionPath.documents.find(doc => doc.id === id) || null;
  }

  _getActiveMotionPathDocument() {
    this._normalizeMotionPathState();
    return this._getMotionPathDocumentById(this.motionPath.activeDocumentId) || this.motionPath.documents[0] || null;
  }

  _getSelectedMotionPathPrimitive() {
    const doc = this._getActiveMotionPathDocument();
    const pathId = this.motionPathEditor?.selectedPathId;
    if (!doc || !Number.isFinite(pathId)) return null;
    return doc.paths.find(path => path.id === pathId) || null;
  }

  _getSelectedMotionPathPrimitiveIds() {
    const ids = Array.isArray(this.motionPathEditor?.selectedPathIds)
      ? this.motionPathEditor.selectedPathIds
      : [];
    return Array.from(new Set(ids.filter(Number.isFinite).map(id => Math.round(id))));
  }

  _getSelectedMotionPathPrimitives() {
    const doc = this._getActiveMotionPathDocument();
    if (!doc) return [];
    const idSet = new Set(this._getSelectedMotionPathPrimitiveIds());
    return doc.paths.filter(path => idSet.has(path.id));
  }

  _getMotionPathGroupMembers(groupId, doc = this._getActiveMotionPathDocument()) {
    if (!doc || !Number.isFinite(groupId)) return [];
    return doc.paths.filter(path => Number(path?.groupId) === groupId);
  }

  _getMotionPathPrimitiveSelectionIds(pathId, { handleType = null } = {}) {
    const doc = this._getActiveMotionPathDocument();
    const path = doc?.paths?.find(entry => entry.id === pathId);
    if (!path) return [];
    if (handleType === 'handle' || handleType === 'size-handle' || handleType === 'speed-handle') {
      return [path.id];
    }
    if (Number.isFinite(path.groupId)) {
      return this._getMotionPathGroupMembers(path.groupId, doc).map(entry => entry.id);
    }
    return [path.id];
  }

  _getSelectedMotionPathGroup() {
    const selected = this._getSelectedMotionPathPrimitives();
    if (!selected.length) return null;
    const first = selected[0];
    if (!Number.isFinite(first?.groupId) || !first?.groupKind) return null;
    if (!selected.every(path => path.groupId === first.groupId && path.groupKind === first.groupKind)) return null;
    return {
      groupId: first.groupId,
      groupKind: first.groupKind,
      groupName: first.groupName || '',
      radialCount: _normalizeMotionPathRadialCount(first.radialCount),
      radialSpread: _normalizeMotionPathRadialSpread(first.radialSpread),
      paths: selected.slice().sort((a, b) => (a.radialLineIndex || 0) - (b.radialLineIndex || 0)),
    };
  }

  _getSelectedMotionPathPoint() {
    const path = this._getSelectedMotionPathPrimitive();
    const handleIndex = Number.isFinite(this.motionPathEditor?.selectedHandleIndex)
      ? this.motionPathEditor.selectedHandleIndex
      : -1;
    return path?.points?.[handleIndex] || null;
  }

  _isMotionPathPrimitiveSelected(pathId) {
    return this._getSelectedMotionPathPrimitiveIds().includes(pathId);
  }

  _getMotionPathEditorCreateKind(tool = this.motionPathEditor?.activeTool) {
    return typeof tool === 'string' && tool.startsWith('create-')
      ? tool.slice('create-'.length)
      : null;
  }

  _isMotionPathPrimitiveComplete(path) {
    if (!path) return false;
    if (path.kind === 'rectangle' || path.kind === 'ellipse') return path.points.length >= 2;
    if (path.kind === 'radial') return path.points.length >= 2;
    if (path.kind === 'bezier') return path.points.length >= 2;
    return path.points.length >= 2;
  }

  _removeMotionPathPrimitiveById(pathId) {
    const doc = this._getActiveMotionPathDocument();
    if (!doc || !Number.isFinite(pathId)) return false;
    const index = doc.paths.findIndex(path => path.id === pathId);
    if (index === -1) return false;
    doc.paths.splice(index, 1);
    this._markMotionPathDocumentUpdated(doc);
    return true;
  }

  _cleanupMotionPathCreation() {
    const pathId = this.motionPathEditor.creationPathId;
    if (!Number.isFinite(pathId)) return false;
    const doc = this._getActiveMotionPathDocument();
    const path = doc?.paths?.find(entry => entry.id === pathId) || null;
    const shouldDiscard = !!path && !this._isMotionPathPrimitiveComplete(path);
    if (shouldDiscard) {
      this._removeMotionPathPrimitiveById(pathId);
      if (this.motionPathEditor.selectedPathId === pathId) {
        this._setSelectedMotionPathPrimitives([], null, -1);
      }
    }
    this.motionPathEditor.creationPathId = null;
    this.motionPathEditor.needsRedraw = true;
    return shouldDiscard;
  }

  _setMotionPathEditorTool(tool = 'select') {
    const allowedCreateKinds = new Set(['polyline', 'bezier', 'rectangle', 'ellipse', 'radial']);
    const previousKind = this._getMotionPathEditorCreateKind();
    let nextTool = tool === 'delete'
      ? 'delete'
      : tool === 'pan'
        ? 'pan'
        : 'select';
    if (typeof tool === 'string' && tool.startsWith('create-')) {
      const kind = tool.slice('create-'.length);
      if (allowedCreateKinds.has(kind)) nextTool = `create-${kind}`;
    }
    if (previousKind && nextTool !== this.motionPathEditor.activeTool) {
      this._cleanupMotionPathCreation();
    }
    this.motionPathEditor.activeTool = nextTool;
    if (nextTool !== 'select') this.motionPathEditor.insertPointMode = false;
    this.motionPathEditor.needsRedraw = true;
    this._syncMotionPathUI();
  }

  _startMotionPathPrimitiveCreation(kind) {
    if (!['polyline', 'bezier', 'rectangle', 'ellipse', 'radial'].includes(kind)) return;
    this._cleanupMotionPathCreation();
    this._setMotionPathEditorTool(`create-${kind}`);
    this.motionPathEditor.creationPathId = null;
    let placementTarget = 'the first point';
    if (kind === 'rectangle' || kind === 'ellipse') placementTarget = 'the first corner';
    else if (kind === 'radial') placementTarget = 'the center point';
    this.showToast(`Click on the graph canvas to place ${placementTarget} for a ${kind}`);
  }

  _setSelectedMotionPathPrimitives(pathIds = [], primaryPathId = null, handleIndex = -1, handleType = null) {
    const ids = Array.from(new Set((Array.isArray(pathIds) ? pathIds : [pathIds])
      .filter(Number.isFinite)
      .map(id => Math.round(id))));
    const nextPrimary = ids.length
      ? (Number.isFinite(primaryPathId) && ids.includes(Math.round(primaryPathId)) ? Math.round(primaryPathId) : ids[ids.length - 1])
      : null;
    this.motionPathEditor.selectedPathIds = ids;
    this.motionPathEditor.selectedPathId = nextPrimary;
    this.motionPathEditor.selectedHandleIndex = ids.length === 1 && Number.isFinite(handleIndex) ? handleIndex : -1;
    this.motionPathEditor.selectedHandleType = ids.length === 1 && Number.isFinite(handleIndex)
      ? (handleType === 'size-handle' ? 'size-handle' : 'handle')
      : null;
    this.motionPathEditor.needsRedraw = true;
    this._syncMotionPathUI();
  }

  _setSelectedMotionPathPrimitive(pathId = null, handleIndex = -1, handleType = null) {
    this._setSelectedMotionPathPrimitives(Number.isFinite(pathId) ? [pathId] : [], pathId, handleIndex, handleType);
  }

  _toggleMotionPathPrimitiveSelection(pathId) {
    if (!Number.isFinite(pathId)) return;
    const ids = this._getSelectedMotionPathPrimitiveIds();
    const existingIndex = ids.indexOf(pathId);
    if (existingIndex >= 0) ids.splice(existingIndex, 1);
    else ids.push(pathId);
    this._setSelectedMotionPathPrimitives(ids, existingIndex >= 0 ? ids[ids.length - 1] : pathId, -1);
  }

  _selectAllMotionPathPrimitives() {
    const doc = this._getActiveMotionPathDocument();
    if (!doc?.paths?.length) return;
    this._setSelectedMotionPathPrimitives(doc.paths.map(path => path.id), doc.paths[doc.paths.length - 1]?.id || null, -1);
  }

  _cloneMotionPathPrimitive(path, offsetX = 0, offsetY = 0, nameSuffix = ' Copy') {
    const clone = _deepClone(path);
    clone.id = 0;
    clone.name = typeof clone.name === 'string' && clone.name.trim()
      ? (clone.name.endsWith(nameSuffix) ? clone.name : `${clone.name}${nameSuffix}`)
      : `Primitive${nameSuffix}`;
    clone.points = Array.isArray(clone.points)
      ? clone.points.map(pt => ({ ...pt, x: (pt?.x || 0) + offsetX, y: (pt?.y || 0) + offsetY }))
      : [];
    return clone;
  }

  _copySelectedMotionPathPrimitives() {
    const selected = this._getSelectedMotionPathPrimitives();
    if (!selected.length) {
      this.showToast('Select one or more primitives to copy');
      return false;
    }
    this.motionPathEditor.clipboardPaths = selected.map(path => _deepClone(path));
    this.motionPathEditor.pasteCount = 0;
    this._syncMotionPathUI();
    this.showToast(`Copied ${selected.length} primitive${selected.length === 1 ? '' : 's'}`);
    return true;
  }

  _pasteMotionPathPrimitives(sources = this.motionPathEditor.clipboardPaths, { updateClipboard = false, label = 'Pasted' } = {}) {
    const doc = this._getActiveMotionPathDocument();
    const items = Array.isArray(sources) ? sources : [];
    if (!doc || !items.length) {
      this.showToast('Nothing to paste');
      return false;
    }
    this.motionPathEditor.pasteCount = (this.motionPathEditor.pasteCount || 0) + 1;
    const offset = DUPLICATE_OFFSET * this.motionPathEditor.pasteCount;
    const groupIdMap = new Map();
    const inserted = items.map(source => {
      const clone = this._cloneMotionPathPrimitive(source, offset, offset);
      clone.id = doc.nextPathId++;
      if (Number.isFinite(source?.groupId)) {
        if (!groupIdMap.has(source.groupId)) groupIdMap.set(source.groupId, doc.nextGroupId++);
        clone.groupId = groupIdMap.get(source.groupId);
      }
      return clone;
    });
    doc.paths.push(...inserted);
    if (updateClipboard) {
      this.motionPathEditor.clipboardPaths = inserted.map(path => _deepClone(path));
    }
    this._markMotionPathDocumentUpdated(doc);
    this._setSelectedMotionPathPrimitives(inserted.map(path => path.id), inserted[inserted.length - 1]?.id || null, -1);
    this._maybeAutoSaveSession();
    this.showToast(`${label} ${inserted.length} primitive${inserted.length === 1 ? '' : 's'}`);
    return true;
  }

  _duplicateSelectedMotionPathPrimitives() {
    const selected = this._getSelectedMotionPathPrimitives();
    if (!selected.length) {
      this.showToast('Select one or more primitives to duplicate');
      return false;
    }
    return this._pasteMotionPathPrimitives(selected, { updateClipboard: false, label: 'Duplicated' });
  }

  _markMotionPathDocumentUpdated(doc = this._getActiveMotionPathDocument()) {
    if (!doc) return;
    doc.updatedAt = Date.now();
    this.motionPathEditor.needsRedraw = true;
  }

  _getMotionPathEditorCanvas() {
    return document.getElementById('motionPathEditorCanvas');
  }

  _getMotionPathEditorOverlayControls() {
    return document.getElementById('motionPathEditorOverlayControls');
  }

  _getMotionPathOverlayEndBehaviorSelect() {
    return document.getElementById('motionPathOverlayEndBehaviorSelect');
  }

  _hideMotionPathOverlayEndBehaviorSelect() {
    const select = this._getMotionPathOverlayEndBehaviorSelect();
    if (!select) return;
    select.classList.remove('open');
    delete select.dataset.pathId;
    select.style.left = '-9999px';
    select.style.top = '-9999px';
  }

  _openMotionPathOverlayEndBehaviorSelect(pathId, anchorX, anchorY) {
    const doc = this._getActiveMotionPathDocument();
    const numericPathId = Math.round(+pathId);
    const path = doc?.paths?.find(entry => entry.id === numericPathId);
    const select = this._getMotionPathOverlayEndBehaviorSelect();
    if (!path || !select || path.closed) return;
    select.dataset.pathId = String(numericPathId);
    select.value = _normalizeMotionPathEndBehavior(path.endBehavior);
    select.style.left = `${Math.round(anchorX)}px`;
    select.style.top = `${Math.round(anchorY)}px`;
    select.classList.add('open');
    select.focus({ preventScroll: true });
    try {
      select.showPicker?.();
    } catch {}
  }

  _cycleMotionPathDirectionMode(pathId) {
    const doc = this._getActiveMotionPathDocument();
    const numericPathId = Math.round(+pathId);
    const path = doc?.paths?.find(entry => entry.id === numericPathId);
    if (!path) return;
    const order = ['forward', 'reverse', 'alternate', 'random'];
    const current = _normalizeMotionPathDirectionMode(path.directionMode);
    const next = order[(order.indexOf(current) + 1) % order.length];
    path.directionMode = next;
    this._markMotionPathDocumentUpdated(doc);
    this._syncMotionPathUI();
    this._maybeAutoSaveSession();
    this.showToast(`${path.name}: ${_getMotionPathDirectionModeLabel(next)}`);
  }

  _syncMotionPathOverlayControls(doc = this._getActiveMotionPathDocument()) {
    const host = this._getMotionPathEditorOverlayControls();
    if (!host) return;
    if (!this.motionPath.editorOpen || !doc?.paths?.length) {
      host.innerHTML = '';
      this._hideMotionPathOverlayEndBehaviorSelect();
      return;
    }
    const controls = [];
    for (const path of doc.paths) {
      const sampled = _sampleMotionPathPrimitive(path, MOTION_PATH_RESAMPLE_STEP);
      if (!sampled.length) continue;
      const bounds = _getMotionPathBounds(sampled);
      if (!bounds) continue;
      const anchor = this._motionPathLocalToEditorPoint(bounds.maxX, bounds.minY, doc);
      controls.push(`
        <div class="motion-path-editor-pathControls" style="left:${anchor.x + 22}px;top:${anchor.y - 18}px;" data-path-id="${path.id}">
          <button type="button" data-kind="direction" data-path-id="${path.id}" title="Cycle path direction mode">${_getMotionPathDirectionModeLabel(path.directionMode)}</button>
          <button type="button" data-kind="start" data-path-id="${path.id}" title="Toggle initial start placement">${_normalizeMotionPathStartMode(path.startMode) === 'random' ? 'Random' : 'Even'}</button>
          ${path.closed ? '' : `<button type="button" data-kind="behavior" data-path-id="${path.id}" title="Choose end behavior">${_getMotionPathEndBehaviorLabel(path.endBehavior)}</button>`}
        </div>
      `);
    }
    host.innerHTML = controls.join('');
  }

  _syncMotionPathEditorCanvasSize() {
    const canvas = this._getMotionPathEditorCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      this.motionPathEditor.needsRedraw = true;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.motionPathEditor.canvas = canvas;
    this.motionPathEditor.ctx = ctx;
    this.motionPathEditor.canvasWidth = width;
    this.motionPathEditor.canvasHeight = height;
    return { canvas, ctx, width, height, dpr };
  }

  _getMotionPathEditorView(doc = this._getActiveMotionPathDocument()) {
    const size = this._syncMotionPathEditorCanvasSize();
    return {
      width: size?.width || this.motionPathEditor.canvasWidth || 1,
      height: size?.height || this.motionPathEditor.canvasHeight || 1,
      zoom: Math.max(0.1, doc?.view?.zoom || 1),
      centerX: ((size?.width || this.motionPathEditor.canvasWidth || 1) * 0.5) + (doc?.view?.panX || 0),
      centerY: ((size?.height || this.motionPathEditor.canvasHeight || 1) * 0.5) + (doc?.view?.panY || 0),
    };
  }

  _motionPathLocalToEditorPoint(x, y, doc = this._getActiveMotionPathDocument()) {
    const view = this._getMotionPathEditorView(doc);
    return {
      x: view.centerX + x * view.zoom,
      y: view.centerY + y * view.zoom,
    };
  }

  _motionPathEditorToLocalPoint(screenX, screenY, doc = this._getActiveMotionPathDocument()) {
    const view = this._getMotionPathEditorView(doc);
    return {
      x: (screenX - view.centerX) / view.zoom,
      y: (screenY - view.centerY) / view.zoom,
    };
  }

  _panMotionPathEditorView(deltaX, deltaY, doc = this._getActiveMotionPathDocument()) {
    if (!doc) return;
    doc.view.panX = (doc.view.panX || 0) + deltaX;
    doc.view.panY = (doc.view.panY || 0) + deltaY;
    this.motionPathEditor.needsRedraw = true;
  }

  _zoomMotionPathEditorAt(screenX, screenY, zoomFactor, doc = this._getActiveMotionPathDocument()) {
    if (!doc || !Number.isFinite(zoomFactor) || zoomFactor <= 0) return;
    const view = this._getMotionPathEditorView(doc);
    const local = this._motionPathEditorToLocalPoint(screenX, screenY, doc);
    const nextZoom = _clamp(view.zoom * zoomFactor, 0.1, 8);
    doc.view.zoom = nextZoom;
    doc.view.panX = screenX - (local.x * nextZoom) - (view.width * 0.5);
    doc.view.panY = screenY - (local.y * nextZoom) - (view.height * 0.5);
    this.motionPathEditor.needsRedraw = true;
  }

  _resetMotionPathEditorView(doc = this._getActiveMotionPathDocument()) {
    if (!doc) return;
    doc.view.zoom = 1;
    doc.view.panX = 0;
    doc.view.panY = 0;
    this.motionPathEditor.needsRedraw = true;
    this._syncMotionPathUI();
  }

  _resetMotionPathEditorZoom(doc = this._getActiveMotionPathDocument()) {
    if (!doc) return;
    const canvas = this._getMotionPathEditorCanvas();
    const width = this.motionPathEditor.canvasWidth || canvas?.clientWidth || 1;
    const height = this.motionPathEditor.canvasHeight || canvas?.clientHeight || 1;
    const centerX = width * 0.5;
    const centerY = height * 0.5;
    const currentZoom = Math.max(0.1, doc.view?.zoom || 1);
    this._zoomMotionPathEditorAt(centerX, centerY, 1 / currentZoom, doc);
    this._syncMotionPathUI();
  }

  _centerMotionPathEditorView(doc = this._getActiveMotionPathDocument()) {
    if (!doc) return;
    doc.view.panX = 0;
    doc.view.panY = 0;
    this.motionPathEditor.needsRedraw = true;
    this._syncMotionPathUI();
  }

  _setMotionPathEditorPanel(panel = null) {
    const allowed = panel === 'graph' || panel === 'selection' || panel === 'edit';
    const nextPanel = allowed ? panel : null;
    if (nextPanel === null) {
      if (this.motionPathEditor.activePanel === null) return;
      this.motionPathEditor.activePanel = null;
    } else {
      this.motionPathEditor.activePanel = this.motionPathEditor.activePanel === nextPanel ? null : nextPanel;
    }
    this._syncMotionPathUI();
  }

  _setMotionPathEditorHelp(open = null) {
    const next = open === null ? !this.motionPathEditor.helpOpen : !!open;
    if (this.motionPathEditor.helpOpen === next) return;
    this.motionPathEditor.helpOpen = next;
    this._syncMotionPathUI();
  }

  _positionMotionPathEditorPopover(buttonId, popupId, { alignRight = false } = {}) {
    const button = document.getElementById(buttonId);
    const popup = document.getElementById(popupId);
    const host = document.querySelector('#motionPathEditor .motion-path-editor-main');
    if (!button || !popup || !host) return;
    const hostRect = host.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const maxLeft = Math.max(0, hostRect.width - popupRect.width - 8);
    const rawLeft = alignRight
      ? buttonRect.right - hostRect.left - popupRect.width
      : buttonRect.left - hostRect.left;
    const left = _clamp(rawLeft, 8, maxLeft);
    const top = Math.max(8, (buttonRect.bottom - hostRect.top) + 8);
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  _cycleMotionPathStartMode(pathId) {
    const doc = this._getActiveMotionPathDocument();
    const numericPathId = Math.round(+pathId);
    const path = doc?.paths?.find(entry => entry.id === numericPathId);
    if (!path) return;
    path.startMode = _normalizeMotionPathStartMode(path.startMode) === 'random' ? 'spread' : 'random';
    this._markMotionPathDocumentUpdated(doc);
    this._syncMotionPathUI();
    this._maybeAutoSaveSession();
    this.showToast(`${path.name}: ${_getMotionPathStartModeLabel(path.startMode)}`);
  }

  _updateMotionPathEditorTouchPoint(pointerId, clientX, clientY) {
    this.motionPathEditor.touchPoints[pointerId] = { clientX, clientY };
  }

  _removeMotionPathEditorTouchPoint(pointerId) {
    delete this.motionPathEditor.touchPoints[pointerId];
  }

  _getMotionPathEditorTouchPoints() {
    return Object.values(this.motionPathEditor.touchPoints || {});
  }

  _cancelMotionPathEditorDrag() {
    this.motionPathEditor.pointerId = null;
    this.motionPathEditor.dragMode = null;
    this.motionPathEditor.dragPathId = null;
    this.motionPathEditor.dragHandleIndex = -1;
  }

  _endMotionPathEditorTouchGesture() {
    this.motionPathEditor.touchGestureActive = false;
    this.motionPathEditor.touchGestureDistance = 0;
    this.motionPathEditor.touchGestureCenterX = 0;
    this.motionPathEditor.touchGestureCenterY = 0;
    this.motionPathEditor.needsRedraw = true;
  }

  _beginMotionPathEditorTouchGesture(canvas) {
    const points = this._getMotionPathEditorTouchPoints();
    if (!canvas || points.length < 2) return false;
    const rect = canvas.getBoundingClientRect();
    const [first, second] = points;
    this._cancelMotionPathEditorDrag();
    this.motionPathEditor.touchGestureActive = true;
    this.motionPathEditor.touchGestureDistance = Math.max(1, Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY));
    this.motionPathEditor.touchGestureCenterX = ((first.clientX + second.clientX) * 0.5) - rect.left;
    this.motionPathEditor.touchGestureCenterY = ((first.clientY + second.clientY) * 0.5) - rect.top;
    this.motionPathEditor.needsRedraw = true;
    return true;
  }

  _updateMotionPathEditorTouchGesture(canvas) {
    if (!canvas || !this.motionPathEditor.touchGestureActive) return false;
    const points = this._getMotionPathEditorTouchPoints();
    if (points.length < 2) {
      this._endMotionPathEditorTouchGesture();
      return false;
    }
    const rect = canvas.getBoundingClientRect();
    const [first, second] = points;
    const centerX = ((first.clientX + second.clientX) * 0.5) - rect.left;
    const centerY = ((first.clientY + second.clientY) * 0.5) - rect.top;
    const distance = Math.max(1, Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY));
    const previousDistance = this.motionPathEditor.touchGestureDistance || distance;
    const deltaX = centerX - this.motionPathEditor.touchGestureCenterX;
    const deltaY = centerY - this.motionPathEditor.touchGestureCenterY;
    if (distance > 0 && previousDistance > 0) {
      this._zoomMotionPathEditorAt(centerX, centerY, distance / previousDistance);
    }
    if (deltaX || deltaY) {
      this._panMotionPathEditorView(deltaX, deltaY);
    }
    this.motionPathEditor.touchGestureDistance = distance;
    this.motionPathEditor.touchGestureCenterX = centerX;
    this.motionPathEditor.touchGestureCenterY = centerY;
    return true;
  }

  _setMotionPathInsertPointMode(active) {
    this.motionPathEditor.insertPointMode = !!active;
    this.motionPathEditor.needsRedraw = true;
    this._syncMotionPathUI();
  }

  _findMotionPathInsertIndex(points, closed, localX, localY, mode = 'append') {
    if (!Array.isArray(points) || points.length < 2 || mode !== 'between') return points?.length || 0;
    let bestIndex = points.length;
    let bestDistance = Number.POSITIVE_INFINITY;
    const checkSegment = (startIndex, endIndex, insertIndex) => {
      const a = points[startIndex];
      const b = points[endIndex];
      const hit = _closestPointOnSegment(localX, localY, a.x, a.y, b.x, b.y);
      if (hit.distance < bestDistance) {
        bestDistance = hit.distance;
        bestIndex = insertIndex;
      }
    };
    for (let i = 1; i < points.length; i++) checkSegment(i - 1, i, i);
    if (closed) checkSegment(points.length - 1, 0, points.length);
    return bestIndex;
  }

  _getMotionPathInsertedPointStampScale(points, insertIndex, closed = false) {
    const items = Array.isArray(points) ? points : [];
    if (!items.length) return 1;
    const prev = insertIndex > 0
      ? items[insertIndex - 1]
      : (closed ? items[items.length - 1] : items[0]);
    const next = insertIndex < items.length
      ? items[insertIndex]
      : (closed ? items[0] : items[items.length - 1]);
    if (prev && next) {
      return _roundMotionPathPointStampScale(((prev.stampScale || 1) + (next.stampScale || 1)) * 0.5);
    }
    return _roundMotionPathPointStampScale(prev?.stampScale ?? next?.stampScale ?? 1);
  }

  _getMotionPathInsertedPointSpeedScale(points, insertIndex, closed = false) {
    const items = Array.isArray(points) ? points : [];
    if (!items.length) return 1;
    const prev = insertIndex > 0
      ? items[insertIndex - 1]
      : (closed ? items[items.length - 1] : items[0]);
    const next = insertIndex < items.length
      ? items[insertIndex]
      : (closed ? items[0] : items[items.length - 1]);
    if (prev && next) {
      return _roundMotionPathPointSpeedScale(((prev.speedScale || 1) + (next.speedScale || 1)) * 0.5);
    }
    return _roundMotionPathPointSpeedScale(prev?.speedScale ?? next?.speedScale ?? 1);
  }

  _appendMotionPathBezierAnchor(path, localX, localY) {
    if (!path) return -1;
    path.points.push({
      x: localX,
      y: localY,
      stampScale: _roundMotionPathPointStampScale(path.points[path.points.length - 1]?.stampScale ?? 1),
      speedScale: _roundMotionPathPointSpeedScale(path.points[path.points.length - 1]?.speedScale ?? 1),
      connector: 'curve',
    });
    return path.points.length - 1;
  }

  _insertMotionPathBezierAnchor(path, localX, localY) {
    if (!path || path.points.length < 2) return this._appendMotionPathBezierAnchor(path, localX, localY);
    const insertIndex = _findMotionPathBezierInsertIndex(path.points, localX, localY, !!path.closed);
    path.points.splice(insertIndex, 0, {
      x: localX,
      y: localY,
      stampScale: this._getMotionPathInsertedPointStampScale(path.points, insertIndex, !!path.closed),
      speedScale: this._getMotionPathInsertedPointSpeedScale(path.points, insertIndex, !!path.closed),
      connector: 'curve',
    });
    return insertIndex;
  }

  _toggleMotionPathBezierConnector(pathId, handleIndex) {
    const doc = this._getActiveMotionPathDocument();
    const path = doc?.paths?.find(entry => entry.id === pathId);
    const point = path?.points?.[handleIndex];
    if (!path || path.kind !== 'bezier' || !point) return false;
    point.connector = point.connector === 'sharp' ? 'curve' : 'sharp';
    this._markMotionPathDocumentUpdated(doc);
    this._setSelectedMotionPathPrimitive(path.id, handleIndex);
    this._maybeAutoSaveSession();
    this.showToast(`${point.connector === 'sharp' ? 'Sharp' : 'Curved'} connector on ${path.name}`);
    return true;
  }

  _createMotionPathPrimitive(kind, { points = null, announce = true } = {}) {
    const doc = this._getActiveMotionPathDocument();
    if (!doc) return null;
    const id = doc.nextPathId++;
    const primitive = {
      id,
      name: `${kind[0].toUpperCase()}${kind.slice(1)} ${id}`,
      kind,
      closed: kind === 'rectangle' || kind === 'ellipse',
      endBehavior: 'restart',
      directionMode: 'forward',
      startMode: 'spread',
      agentCount: 0,
      speedMultiplier: 1,
      radialCount: _normalizeMotionPathRadialCount(),
      radialSpread: _normalizeMotionPathRadialSpread(),
      points: _normalizeMotionPathPoints(kind, Array.isArray(points) ? points : []),
    };
    doc.paths.push(primitive);
    this._markMotionPathDocumentUpdated(doc);
    this._setSelectedMotionPathPrimitives([primitive.id], primitive.id, -1);
    this._maybeAutoSaveSession();
    if (announce) this.showToast(`Added ${primitive.kind}`);
    return primitive;
  }

  _createMotionPathRadialGroup(centerPoint, spokeHandle, {
    groupName = '',
    radialCount = MOTION_PATH_RADIAL_COUNT_DEFAULT,
    radialSpread = MOTION_PATH_RADIAL_SPREAD_DEFAULT,
    reusePathId = null,
  } = {}) {
    const doc = this._getActiveMotionPathDocument();
    if (!doc || !centerPoint || !spokeHandle) return [];
    const count = _normalizeMotionPathRadialCount(radialCount);
    const spread = _normalizeMotionPathRadialSpread(radialSpread);
    const groupId = doc.nextGroupId++;
    const resolvedGroupName = _normalizeMotionPathGroupName(groupName, `Radial ${groupId}`);
    const spokes = _buildMotionPathRadialSpokes(centerPoint, spokeHandle, count, spread);
    const created = [];
    spokes.forEach((spoke, index) => {
      const pathId = index === 0 && Number.isFinite(reusePathId) ? reusePathId : doc.nextPathId++;
      created.push({
        id: pathId,
        name: `${resolvedGroupName} · Line ${index + 1}`,
        kind: 'polyline',
        closed: false,
        endBehavior: 'restart',
        directionMode: 'forward',
        startMode: 'spread',
        agentCount: 0,
        speedMultiplier: 1,
        groupId,
        groupKind: 'radial',
        groupName: resolvedGroupName,
        radialLineIndex: index,
        radialCount: count,
        radialSpread: spread,
        points: _normalizeMotionPathPoints('polyline', [
          { x: centerPoint.x, y: centerPoint.y, stampScale: centerPoint.stampScale, speedScale: centerPoint.speedScale },
          { x: spoke.x, y: spoke.y, stampScale: spoke.stampScale, speedScale: spoke.speedScale },
        ]),
      });
    });
    doc.paths.push(...created);
    return created;
  }

  _updateMotionPathRadialGroup(groupId, {
    radialCount = null,
    radialSpread = null,
    groupName = null,
  } = {}) {
    const doc = this._getActiveMotionPathDocument();
    const members = this._getMotionPathGroupMembers(groupId, doc)
      .slice()
      .sort((a, b) => (a.radialLineIndex || 0) - (b.radialLineIndex || 0));
    if (!doc || !members.length) return [];
    const first = members[0];
    const centerPoint = first.points?.[0];
    const spokeHandle = first.points?.[1];
    if (!centerPoint || !spokeHandle) return members;
    // Group edits keep radial metadata synchronized, so the first member is the canonical source for shared defaults.
    const count = _normalizeMotionPathRadialCount(radialCount ?? first.radialCount);
    const spread = _normalizeMotionPathRadialSpread(radialSpread ?? first.radialSpread);
    const resolvedGroupName = _normalizeMotionPathGroupName(groupName, first.groupName || `Radial ${groupId}`);
    const spokes = _buildMotionPathRadialSpokes(centerPoint, spokeHandle, count, spread);
    while (members.length > count) {
      const member = members.pop();
      const index = doc.paths.findIndex(path => path.id === member.id);
      if (index >= 0) doc.paths.splice(index, 1);
    }
    while (members.length < count) {
      const pathId = doc.nextPathId++;
      const index = members.length;
      const clone = _deepClone(first);
      clone.id = pathId;
      clone.radialLineIndex = index;
      doc.paths.push(clone);
      members.push(clone);
    }
    members.forEach((member, index) => {
      const spoke = spokes[index] || spokes[spokes.length - 1] || spokeHandle;
      member.name = `${resolvedGroupName} · Line ${index + 1}`;
      member.kind = 'polyline';
      member.groupId = groupId;
      member.groupKind = 'radial';
      member.groupName = resolvedGroupName;
      member.radialLineIndex = index;
      member.radialCount = count;
      member.radialSpread = spread;
      member.points = _normalizeMotionPathPoints('polyline', [
        {
          x: centerPoint.x,
          y: centerPoint.y,
          stampScale: centerPoint.stampScale,
          speedScale: centerPoint.speedScale,
        },
        {
          x: spoke.x,
          y: spoke.y,
          stampScale: spoke.stampScale,
          speedScale: spoke.speedScale,
        },
      ]);
    });
    return members;
  }

  _createMotionPathPrimitiveFromShape(path) {
    if (!path) return null;
    const sampled = _sampleMotionPathPrimitive(path, Math.max(MOTION_PATH_RESAMPLE_STEP * 1.5, 18));
    if (!sampled.length) return null;
    const points = [];
    const targetCount = path.kind === 'ellipse' ? 8 : 4;
    for (let i = 0; i < targetCount; i++) {
      const index = Math.min(sampled.length - 1, Math.round((i / targetCount) * (sampled.length - 1)));
      points.push({ x: sampled[index].x, y: sampled[index].y });
    }
    return {
      ...path,
      kind: 'polyline',
      closed: true,
      points,
    };
  }

  _addPointToMotionPathPrimitive(localX = Number.NaN, localY = Number.NaN) {
    const doc = this._getActiveMotionPathDocument();
    const selected = this._getSelectedMotionPathPrimitive();
    if (!doc || !selected) return;
    if (selected.kind === 'radial') {
      this.showToast('Radial primitives use their center and spoke handle; adjust spoke count and spread in Selection');
      return;
    }
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
      this._setMotionPathInsertPointMode(!this.motionPathEditor.insertPointMode);
      if (this.motionPathEditor.insertPointMode) this.showToast(`Click on the graph canvas to place a point on ${selected.name}`);
      return;
    }
    if (selected.kind === 'rectangle' || selected.kind === 'ellipse') {
      const replacement = this._createMotionPathPrimitiveFromShape(selected);
      if (!replacement) return;
      const index = doc.paths.findIndex(path => path.id === selected.id);
      if (index === -1) return;
      doc.paths[index] = replacement;
      this._setSelectedMotionPathPrimitive(replacement.id, -1);
      this._markMotionPathDocumentUpdated(doc);
      this._syncMotionPathUI();
      return this._addPointToMotionPathPrimitive(localX, localY);
    }
    if (selected.kind === 'bezier') {
      this.motionPathEditor.selectedHandleIndex = this.motionPathEditor.insertBetweenPoints
        ? this._insertMotionPathBezierAnchor(selected, localX, localY)
        : this._appendMotionPathBezierAnchor(selected, localX, localY);
      this._markMotionPathDocumentUpdated(doc);
      this._syncMotionPathUI();
      this._maybeAutoSaveSession();
      this._setMotionPathInsertPointMode(false);
      this.showToast(`Placed bezier anchor on ${selected.name}`);
      return;
    }
    const pts = selected.points;
    const insertIndex = this._findMotionPathInsertIndex(
      pts,
      !!selected.closed,
      localX,
      localY,
      this.motionPathEditor.insertBetweenPoints ? 'between' : 'append',
    );
    pts.splice(insertIndex, 0, {
      x: localX,
      y: localY,
      stampScale: this._getMotionPathInsertedPointStampScale(pts, insertIndex, !!selected.closed),
      speedScale: this._getMotionPathInsertedPointSpeedScale(pts, insertIndex, !!selected.closed),
    });
    this.motionPathEditor.selectedHandleIndex = insertIndex;
    this._markMotionPathDocumentUpdated(doc);
    this._syncMotionPathUI();
    this._maybeAutoSaveSession();
    this._setMotionPathInsertPointMode(false);
    this.showToast(`Placed point on ${selected.name}`);
  }

  _placeMotionPathCreationPoint(kind, localX, localY, { finalize = false } = {}) {
    const doc = this._getActiveMotionPathDocument();
    if (!doc) return;
    let path = doc.paths.find(entry => entry.id === this.motionPathEditor.creationPathId && entry.kind === kind) || null;
    if (!path) {
      path = this._createMotionPathPrimitive(kind, { points: [{ x: localX, y: localY, stampScale: 1, speedScale: 1 }], announce: false });
      if (!path) return;
      this.motionPathEditor.creationPathId = path.id;
      this.motionPathEditor.selectedHandleIndex = 0;
      this._syncMotionPathUI();
      if (kind === 'rectangle' || kind === 'ellipse') {
        this.showToast(`Click the opposite corner to finish the ${kind}`);
      } else if (kind === 'radial') {
        this.showToast('Click again to place the spoke handle and finish the radial lines');
      } else {
        this.showToast(`Click to place the next ${kind === 'bezier' ? 'curve point' : 'point'}. Double-click or press Enter to finish.`);
      }
      return;
    }

    let selectedHandleIndex = path.points.length - 1;
    if (kind === 'radial') {
      const centerPoint = {
        x: path.points[0]?.x ?? localX,
        y: path.points[0]?.y ?? localY,
        stampScale: path.points[0]?.stampScale ?? 1,
        speedScale: path.points[0]?.speedScale ?? 1,
      };
      const spokeHandle = { x: localX, y: localY, stampScale: 1, speedScale: 1 };
      const radialIndex = doc.paths.findIndex(entry => entry.id === path.id);
      if (radialIndex >= 0) doc.paths.splice(radialIndex, 1);
      const created = this._createMotionPathRadialGroup(centerPoint, spokeHandle, {
        groupName: path.name,
        radialCount: path.radialCount,
        radialSpread: path.radialSpread,
        reusePathId: path.id,
      });
      this.motionPathEditor.creationPathId = null;
      this._markMotionPathDocumentUpdated(doc);
      this._setSelectedMotionPathPrimitives(created.map(entry => entry.id), created[0]?.id || null, -1);
      this._maybeAutoSaveSession();
      this.showToast(`Created grouped radial lines (${created.length})`);
      return;
    }
    if (kind === 'rectangle' || kind === 'ellipse') {
      if (path.points.length === 1) path.points.push({ x: localX, y: localY, stampScale: 1, speedScale: 1 });
      else path.points[1] = { x: localX, y: localY, stampScale: 1, speedScale: 1 };
      selectedHandleIndex = 1;
      this.motionPathEditor.creationPathId = null;
    } else if (kind === 'bezier') {
      selectedHandleIndex = this._appendMotionPathBezierAnchor(path, localX, localY);
      if (finalize && this._isMotionPathPrimitiveComplete(path)) this.motionPathEditor.creationPathId = null;
    } else {
      path.points.push({ x: localX, y: localY, stampScale: 1, speedScale: 1 });
      selectedHandleIndex = path.points.length - 1;
      if (finalize && this._isMotionPathPrimitiveComplete(path)) this.motionPathEditor.creationPathId = null;
    }

    this._markMotionPathDocumentUpdated(doc);
    this._setSelectedMotionPathPrimitive(path.id, selectedHandleIndex);
    this._maybeAutoSaveSession();
  }

  _deleteSelectedMotionPathPrimitive() {
    const doc = this._getActiveMotionPathDocument();
    const selectedIds = this._getSelectedMotionPathPrimitiveIds();
    if (!doc || !selectedIds.length) {
      this.showToast('Select one or more primitives to delete');
      return false;
    }
    const idSet = new Set(selectedIds);
    const firstIndex = doc.paths.findIndex(path => idSet.has(Number(path?.id)));
    const removed = doc.paths.filter(path => idSet.has(Number(path?.id)));
    if (!removed.length) {
      this.showToast('Selected primitives could not be found');
      this._setSelectedMotionPathPrimitives([], null, -1);
      return false;
    }
    doc.paths = doc.paths.filter(path => !idSet.has(Number(path?.id)));
    if (this.motionPathEditor.creationPathId && idSet.has(this.motionPathEditor.creationPathId)) {
      this.motionPathEditor.creationPathId = null;
    }
    const fallback = doc.paths[Math.max(0, Math.min(firstIndex, doc.paths.length - 1))] || null;
    this.motionPathEditor.hoverPathId = null;
    this.motionPathEditor.hoverHandleIndex = -1;
    this.motionPathEditor.dragPathId = null;
    this.motionPathEditor.dragHandleIndex = -1;
    this.motionPathEditor.dragMode = null;
    this.motionPathEditor.insertPointMode = false;
    this._markMotionPathDocumentUpdated(doc);
    this._setSelectedMotionPathPrimitives(fallback ? [fallback.id] : [], fallback?.id || null, -1);
    this._maybeAutoSaveSession();
    this.showToast(`Deleted ${removed.length} primitive${removed.length === 1 ? '' : 's'}`);
    return true;
  }

  _translateMotionPathPrimitive(path, dx, dy) {
    if (!path?.points) return;
    for (const pt of path.points) {
      pt.x += dx;
      pt.y += dy;
    }
  }

  _translateSelectedMotionPathPrimitives(dx, dy) {
    const selected = this._getSelectedMotionPathPrimitives();
    for (const path of selected) this._translateMotionPathPrimitive(path, dx, dy);
  }

  _getMotionPathPointSizeHandleOffset(stampScale = 1) {
    return MOTION_PATH_SIZE_HANDLE_BASE_OFFSET + (_roundMotionPathPointStampScale(stampScale) * MOTION_PATH_SIZE_HANDLE_SCALE_PIXELS);
  }

  _getMotionPathPointSpeedHandleOffset(speedScale = 1) {
    return MOTION_PATH_SPEED_HANDLE_BASE_OFFSET + (_roundMotionPathPointSpeedScale(speedScale) * MOTION_PATH_SPEED_HANDLE_SCALE_PIXELS);
  }

  _getMotionPathPointSizeHandleScreenPoint(point, doc = this._getActiveMotionPathDocument()) {
    const anchor = this._motionPathLocalToEditorPoint(point?.x || 0, point?.y || 0, doc);
    return {
      x: anchor.x,
      y: anchor.y - this._getMotionPathPointSizeHandleOffset(point?.stampScale),
    };
  }

  _getMotionPathPointSpeedHandleScreenPoint(point, doc = this._getActiveMotionPathDocument()) {
    const anchor = this._motionPathLocalToEditorPoint(point?.x || 0, point?.y || 0, doc);
    return {
      x: anchor.x + this._getMotionPathPointSpeedHandleOffset(point?.speedScale),
      y: anchor.y,
    };
  }

  _getMotionPathPointStampScaleFromScreen(point, screenX, screenY, doc = this._getActiveMotionPathDocument()) {
    const anchor = this._motionPathLocalToEditorPoint(point?.x || 0, point?.y || 0, doc);
    const radialDistance = Math.max(0, Math.hypot(screenX - anchor.x, screenY - anchor.y));
    return _roundMotionPathPointStampScale((radialDistance - MOTION_PATH_SIZE_HANDLE_BASE_OFFSET) / MOTION_PATH_SIZE_HANDLE_SCALE_PIXELS);
  }

  _getMotionPathPointSpeedScaleFromScreen(point, screenX, doc = this._getActiveMotionPathDocument()) {
    const anchor = this._motionPathLocalToEditorPoint(point?.x || 0, point?.y || 0, doc);
    const distance = Math.max(0, screenX - anchor.x);
    return _roundMotionPathPointSpeedScale((distance - MOTION_PATH_SPEED_HANDLE_BASE_OFFSET) / MOTION_PATH_SPEED_HANDLE_SCALE_PIXELS);
  }

  _hitTestMotionPathPrimitive(localX, localY, screenX = Number.NaN, screenY = Number.NaN) {
    const doc = this._getActiveMotionPathDocument();
    if (!doc) return null;
    const zoom = Math.max(0.1, doc.view?.zoom || 1);
    const handleRadius = MOTION_PATH_HIT_RADIUS / zoom;
    const sizeHandleRadius = MOTION_PATH_SIZE_HANDLE_RADIUS + 4;
    const speedHandleRadius = MOTION_PATH_SPEED_HANDLE_RADIUS + 4;
    for (let i = doc.paths.length - 1; i >= 0; i--) {
      const path = doc.paths[i];
      for (let handleIndex = 0; handleIndex < path.points.length; handleIndex++) {
        const pt = path.points[handleIndex];
        if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
          const sizeHandle = this._getMotionPathPointSizeHandleScreenPoint(pt, doc);
          if (_distanceSquared(screenX, screenY, sizeHandle.x, sizeHandle.y) <= sizeHandleRadius * sizeHandleRadius) {
            return { pathId: path.id, type: 'size-handle', handleIndex };
          }
          const speedHandle = this._getMotionPathPointSpeedHandleScreenPoint(pt, doc);
          if (_distanceSquared(screenX, screenY, speedHandle.x, speedHandle.y) <= speedHandleRadius * speedHandleRadius) {
            return { pathId: path.id, type: 'speed-handle', handleIndex };
          }
        }
        if (_distanceSquared(localX, localY, pt.x, pt.y) <= handleRadius * handleRadius) {
          return { pathId: path.id, type: 'handle', handleIndex };
        }
      }
      const sampled = _sampleMotionPathPrimitive(path, MOTION_PATH_RESAMPLE_STEP);
      for (let segmentIndex = 1; segmentIndex < sampled.length; segmentIndex++) {
        const hit = _closestPointOnSegment(localX, localY, sampled[segmentIndex - 1].x, sampled[segmentIndex - 1].y, sampled[segmentIndex].x, sampled[segmentIndex].y);
        if (hit.distance <= handleRadius) {
          return { pathId: path.id, type: 'move', handleIndex: -1 };
        }
      }
    }
    return null;
  }

  _onMotionPathEditorPointerDown(e) {
    if (!this.motionPath.editorOpen) return;
    const canvas = this._getMotionPathEditorCanvas();
    if (!canvas || e.target !== canvas) return;
    this._hideMotionPathOverlayEndBehaviorSelect();
    if (e.pointerType === 'touch') {
      this._updateMotionPathEditorTouchPoint(e.pointerId, e.clientX, e.clientY);
      canvas.setPointerCapture?.(e.pointerId);
      if (this._beginMotionPathEditorTouchGesture(canvas)) {
        e.preventDefault();
        return;
      }
    }
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const local = this._motionPathEditorToLocalPoint(screenX, screenY);
    if (e.button === 1) {
      this.motionPathEditor.pointerId = e.pointerId;
      this.motionPathEditor.dragMode = 'pan';
      this.motionPathEditor.lastScreenX = e.clientX;
      this.motionPathEditor.lastScreenY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
      this.motionPathEditor.needsRedraw = true;
      e.preventDefault();
      return;
    }
    if (e.button === 0 && this.motionPathEditor.activeTool === 'pan') {
      this.motionPathEditor.pointerId = e.pointerId;
      this.motionPathEditor.dragMode = 'pan';
      this.motionPathEditor.lastScreenX = e.clientX;
      this.motionPathEditor.lastScreenY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
      this.motionPathEditor.needsRedraw = true;
      e.preventDefault();
      return;
    }
    const createKind = this._getMotionPathEditorCreateKind();
    if (e.button === 0 && createKind) {
      this._placeMotionPathCreationPoint(createKind, local.x, local.y, { finalize: e.detail >= 2 });
      e.preventDefault();
      return;
    }
    const hit = this._hitTestMotionPathPrimitive(local.x, local.y, screenX, screenY);
    if (e.button === 0 && e.detail >= 2 && hit?.type === 'handle') {
      const doc = this._getActiveMotionPathDocument();
      const path = doc?.paths?.find(entry => entry.id === hit.pathId);
      if (path?.kind === 'bezier') {
        this._toggleMotionPathBezierConnector(path.id, hit.handleIndex);
        e.preventDefault();
        return;
      }
    }
    if (e.button === 0 && this.motionPathEditor.insertPointMode && (!hit || hit.type !== 'handle')) {
      this._addPointToMotionPathPrimitive(local.x, local.y);
      e.preventDefault();
      return;
    }
    if (e.button === 0 && this.motionPathEditor.activeTool === 'delete') {
      if (hit?.pathId) {
        const ids = this._getMotionPathPrimitiveSelectionIds(hit.pathId, { handleType: hit.type });
        this._setSelectedMotionPathPrimitives(ids, hit.pathId, -1);
        this._deleteSelectedMotionPathPrimitive();
      }
      e.preventDefault();
      return;
    }
    const toggleSelection = !!(e.shiftKey || e.ctrlKey || e.metaKey);
    const selectedIds = this._getSelectedMotionPathPrimitiveIds();
    const hitSelected = !!(hit?.pathId && selectedIds.includes(hit.pathId));
    if (e.button === 0 && toggleSelection && hit?.pathId) {
      const ids = this._getMotionPathPrimitiveSelectionIds(hit.pathId, { handleType: hit.type });
      ids.forEach(id => this._toggleMotionPathPrimitiveSelection(id));
      e.preventDefault();
      return;
    }
    if (e.button === 0 && !hit) {
      this._setSelectedMotionPathPrimitives([], null, -1);
      e.preventDefault();
      return;
    }
    this.motionPathEditor.pointerId = e.pointerId;
    this.motionPathEditor.lastLocalX = local.x;
    this.motionPathEditor.lastLocalY = local.y;
    this.motionPathEditor.lastScreenX = e.clientX;
    this.motionPathEditor.lastScreenY = e.clientY;
    this.motionPathEditor.dragPathId = hit?.pathId || null;
    this.motionPathEditor.dragMode = hit?.type || null;
    this.motionPathEditor.dragHandleIndex = hit?.handleIndex ?? -1;
    canvas.setPointerCapture?.(e.pointerId);
    if ((hit?.type === 'handle' || hit?.type === 'size-handle' || hit?.type === 'speed-handle') && selectedIds.length > 1) {
      this._setSelectedMotionPathPrimitive(hit.pathId, hit.handleIndex, hit.type);
    } else if (hit?.pathId && hitSelected && selectedIds.length > 1) {
      this._setSelectedMotionPathPrimitives(selectedIds, hit.pathId, -1);
    } else {
      const ids = hit?.pathId
        ? this._getMotionPathPrimitiveSelectionIds(hit.pathId, { handleType: hit.type })
        : [];
      this._setSelectedMotionPathPrimitives(
        ids,
        hit?.pathId || null,
        hit?.type === 'handle' || hit?.type === 'size-handle' || hit?.type === 'speed-handle' ? hit?.handleIndex : -1,
        hit?.type,
      );
    }
    this.motionPathEditor.needsRedraw = true;
    e.preventDefault();
  }

  _onMotionPathEditorPointerMove(e) {
    if (!this.motionPath.editorOpen) return;
    const canvas = this._getMotionPathEditorCanvas();
    if (!canvas) return;
    if (e.pointerType === 'touch' && this.motionPathEditor.touchPoints[e.pointerId]) {
      this._updateMotionPathEditorTouchPoint(e.pointerId, e.clientX, e.clientY);
      if (this.motionPathEditor.touchGestureActive || this._getMotionPathEditorTouchPoints().length >= 2) {
        this._beginMotionPathEditorTouchGesture(canvas);
        this._updateMotionPathEditorTouchGesture(canvas);
        e.preventDefault();
        return;
      }
    }
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const local = this._motionPathEditorToLocalPoint(screenX, screenY);
    if (this.motionPathEditor.pointerId !== e.pointerId || !this.motionPathEditor.dragMode) {
      const hover = this._hitTestMotionPathPrimitive(local.x, local.y, screenX, screenY);
      this.motionPathEditor.hoverPathId = hover?.pathId || null;
      this.motionPathEditor.hoverHandleIndex = hover?.handleIndex ?? -1;
      this.motionPathEditor.hoverHandleType = hover?.type === 'size-handle'
        ? 'size-handle'
        : hover?.type === 'speed-handle'
          ? 'speed-handle'
          : hover?.type === 'handle'
            ? 'handle'
            : null;
      this.motionPathEditor.needsRedraw = true;
      return;
    }
    if (this.motionPathEditor.dragMode === 'pan') {
      const dx = e.clientX - this.motionPathEditor.lastScreenX;
      const dy = e.clientY - this.motionPathEditor.lastScreenY;
      this._panMotionPathEditorView(dx, dy);
      this.motionPathEditor.lastScreenX = e.clientX;
      this.motionPathEditor.lastScreenY = e.clientY;
      return;
    }
    const doc = this._getActiveMotionPathDocument();
    const path = doc?.paths?.find(entry => entry.id === this.motionPathEditor.dragPathId);
    if (!path) return;
    const dx = local.x - this.motionPathEditor.lastLocalX;
    const dy = local.y - this.motionPathEditor.lastLocalY;
    if (this.motionPathEditor.dragMode === 'move') {
      if (this._isMotionPathPrimitiveSelected(path.id) && this._getSelectedMotionPathPrimitiveIds().length > 1) {
        this._translateSelectedMotionPathPrimitives(dx, dy);
      } else {
        this._translateMotionPathPrimitive(path, dx, dy);
      }
    } else if (this.motionPathEditor.dragMode === 'size-handle' && path.points[this.motionPathEditor.dragHandleIndex]) {
      path.points[this.motionPathEditor.dragHandleIndex].stampScale = this._getMotionPathPointStampScaleFromScreen(
        path.points[this.motionPathEditor.dragHandleIndex],
        screenX,
        screenY,
        doc,
      );
    } else if (this.motionPathEditor.dragMode === 'speed-handle' && path.points[this.motionPathEditor.dragHandleIndex]) {
      path.points[this.motionPathEditor.dragHandleIndex].speedScale = this._getMotionPathPointSpeedScaleFromScreen(
        path.points[this.motionPathEditor.dragHandleIndex],
        screenX,
        doc,
      );
    } else if (this.motionPathEditor.dragMode === 'handle' && path.points[this.motionPathEditor.dragHandleIndex]) {
      path.points[this.motionPathEditor.dragHandleIndex].x = local.x;
      path.points[this.motionPathEditor.dragHandleIndex].y = local.y;
    }
    this.motionPathEditor.lastLocalX = local.x;
    this.motionPathEditor.lastLocalY = local.y;
    this._markMotionPathDocumentUpdated(doc);
    this._syncMotionPathUI();
  }

  _onMotionPathEditorPointerUp(e) {
    if (e.pointerType === 'touch' && this.motionPathEditor.touchPoints[e.pointerId]) {
      this._removeMotionPathEditorTouchPoint(e.pointerId);
      if (this.motionPathEditor.touchGestureActive) {
        if (this._getMotionPathEditorTouchPoints().length < 2) {
          this._endMotionPathEditorTouchGesture();
        }
        this._cancelMotionPathEditorDrag();
        e.preventDefault();
        return;
      }
    }
    if (this.motionPathEditor.pointerId !== e.pointerId) return;
    this.motionPathEditor.pointerId = null;
    this.motionPathEditor.dragMode = null;
    this.motionPathEditor.dragPathId = null;
    this.motionPathEditor.dragHandleIndex = -1;
    this._maybeAutoSaveSession();
    this.motionPathEditor.needsRedraw = true;
  }

  _onMotionPathEditorWheel(e) {
    if (!this.motionPath.editorOpen) return;
    const canvas = this._getMotionPathEditorCanvas();
    if (!canvas || e.target !== canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    if (e.ctrlKey || e.metaKey) {
      this._zoomMotionPathEditorAt(screenX, screenY, Math.exp(-e.deltaY * 0.0015));
    } else {
      this._panMotionPathEditorView(-e.deltaX, -e.deltaY);
    }
    e.preventDefault();
  }

  _renderMotionPathEditorSurface() {
    if (!this.motionPath.editorOpen) return;
    const size = this._syncMotionPathEditorCanvasSize();
    if (!size || !this.motionPathEditor.needsRedraw) return;
    const { ctx, width, height } = size;
    const doc = this._getActiveMotionPathDocument();
    ctx.clearRect(0, 0, width, height);

    const view = this._getMotionPathEditorView(doc);
    ctx.save();
    ctx.strokeStyle = 'rgba(98,124,170,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, view.centerY);
    ctx.lineTo(width, view.centerY);
    ctx.moveTo(view.centerX, 0);
    ctx.lineTo(view.centerX, height);
    ctx.stroke();
    ctx.restore();

    const selectedIdSet = new Set(this._getSelectedMotionPathPrimitiveIds());
    for (const path of doc?.paths || []) {
      const sampled = _sampleMotionPathPrimitive(path, MOTION_PATH_RESAMPLE_STEP);
      if (!sampled.length) continue;
      const selected = selectedIdSet.has(path.id);
      const primary = path.id === this.motionPathEditor.selectedPathId;
      const hovered = path.id === this.motionPathEditor.hoverPathId;
      ctx.save();
      ctx.strokeStyle = primary
        ? 'rgba(91,138,240,0.98)'
        : selected
          ? 'rgba(114,174,255,0.92)'
          : hovered
            ? 'rgba(129,170,255,0.82)'
            : 'rgba(211,226,255,0.76)';
      ctx.lineWidth = primary ? 2.8 : selected ? 2.15 : 1.6;
      ctx.beginPath();
      sampled.forEach((pt, index) => {
        const screen = this._motionPathLocalToEditorPoint(pt.x, pt.y, doc);
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
      });
      ctx.stroke();

      if (_normalizeMotionPathStartMode(path.startMode) === 'random') {
        ctx.save();
        ctx.strokeStyle = primary ? 'rgba(120,236,178,0.92)' : 'rgba(120,236,178,0.62)';
        ctx.lineWidth = primary ? 1.7 : 1.2;
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        sampled.forEach((pt, index) => {
          const screen = this._motionPathLocalToEditorPoint(pt.x, pt.y, doc);
          if (index === 0) ctx.moveTo(screen.x, screen.y);
          else ctx.lineTo(screen.x, screen.y);
        });
        ctx.stroke();
        ctx.restore();
      }

      if (path.kind === 'bezier' && path.points.length >= 2) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        path.points.forEach((pt, index) => {
          const screen = this._motionPathLocalToEditorPoint(pt.x, pt.y, doc);
          if (index === 0) ctx.moveTo(screen.x, screen.y);
          else ctx.lineTo(screen.x, screen.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }

      path.points.forEach((pt, handleIndex) => {
        const screen = this._motionPathLocalToEditorPoint(pt.x, pt.y, doc);
        const hot = primary
          && handleIndex === this.motionPathEditor.hoverHandleIndex
          && path.id === this.motionPathEditor.hoverPathId
          && this.motionPathEditor.hoverHandleType === 'handle';
        const hotSizeHandle = primary
          && handleIndex === this.motionPathEditor.hoverHandleIndex
          && path.id === this.motionPathEditor.hoverPathId
          && this.motionPathEditor.hoverHandleType === 'size-handle';
        const hotSpeedHandle = primary
          && handleIndex === this.motionPathEditor.hoverHandleIndex
          && path.id === this.motionPathEditor.hoverPathId
          && this.motionPathEditor.hoverHandleType === 'speed-handle';
        const selectedSizeHandle = primary
          && handleIndex === this.motionPathEditor.selectedHandleIndex
          && this.motionPathEditor.selectedHandleType === 'size-handle';
        const selectedSpeedHandle = primary
          && handleIndex === this.motionPathEditor.selectedHandleIndex
          && this.motionPathEditor.selectedHandleType === 'speed-handle';
        const fill = hot ? '#ffffff' : primary ? '#8bb3ff' : selected ? '#9ec4ff' : '#d7e5ff';
        const isSharpBezierAnchor = path.kind === 'bezier' && pt?.connector === 'sharp';
        const sizeHandle = this._getMotionPathPointSizeHandleScreenPoint(pt, doc);
        const speedHandle = this._getMotionPathPointSpeedHandleScreenPoint(pt, doc);
        ctx.strokeStyle = selectedSizeHandle
          ? 'rgba(255,210,120,0.96)'
          : hotSizeHandle
            ? 'rgba(255,236,196,0.96)'
            : 'rgba(255,210,120,0.52)';
        ctx.lineWidth = selectedSizeHandle ? 2 : 1.3;
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y);
        ctx.lineTo(sizeHandle.x, sizeHandle.y);
        ctx.stroke();
        ctx.fillStyle = selectedSizeHandle
          ? 'rgba(255,210,120,0.98)'
          : hotSizeHandle
            ? 'rgba(255,236,196,0.98)'
            : 'rgba(255,210,120,0.86)';
        ctx.strokeStyle = 'rgba(12,16,24,0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(sizeHandle.x, sizeHandle.y, MOTION_PATH_SIZE_HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (selectedSizeHandle || hotSizeHandle) {
          ctx.fillStyle = 'rgba(245,248,255,0.95)';
          ctx.font = '10px Segoe UI, Arial, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${pt.stampScale.toFixed(2)}x`, sizeHandle.x + 10, sizeHandle.y);
        }
        ctx.strokeStyle = selectedSpeedHandle
          ? 'rgba(120,236,178,0.96)'
          : hotSpeedHandle
            ? 'rgba(210,255,233,0.98)'
            : 'rgba(120,236,178,0.52)';
        ctx.lineWidth = selectedSpeedHandle ? 2 : 1.3;
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y);
        ctx.lineTo(speedHandle.x, speedHandle.y);
        ctx.stroke();
        ctx.fillStyle = selectedSpeedHandle
          ? 'rgba(120,236,178,0.98)'
          : hotSpeedHandle
            ? 'rgba(210,255,233,0.98)'
            : 'rgba(120,236,178,0.88)';
        ctx.strokeStyle = 'rgba(12,16,24,0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(speedHandle.x, speedHandle.y, MOTION_PATH_SPEED_HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (selectedSpeedHandle || hotSpeedHandle) {
          ctx.fillStyle = 'rgba(245,248,255,0.95)';
          ctx.font = '10px Segoe UI, Arial, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${pt.speedScale.toFixed(2)}x`, speedHandle.x + 10, speedHandle.y);
        }
        ctx.fillStyle = fill;
        ctx.strokeStyle = 'rgba(12,16,24,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (isSharpBezierAnchor) {
          ctx.moveTo(screen.x, screen.y - MOTION_PATH_HANDLE_RADIUS - 1);
          ctx.lineTo(screen.x + MOTION_PATH_HANDLE_RADIUS + 1, screen.y);
          ctx.lineTo(screen.x, screen.y + MOTION_PATH_HANDLE_RADIUS + 1);
          ctx.lineTo(screen.x - MOTION_PATH_HANDLE_RADIUS - 1, screen.y);
          ctx.closePath();
        } else {
          ctx.arc(screen.x, screen.y, MOTION_PATH_HANDLE_RADIUS, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.stroke();
        if (path.kind === 'bezier') {
          ctx.fillStyle = 'rgba(12,16,24,0.8)';
          ctx.beginPath();
          if (isSharpBezierAnchor) {
            ctx.rect(screen.x - 2, screen.y - 2, 4, 4);
          } else {
            ctx.arc(screen.x, screen.y, 2.2, 0, Math.PI * 2);
          }
          ctx.fill();
        }
      });

      if (sampled.length >= 2) {
        const arrowMarkers = _sampleMotionPathArrowMarkers(sampled, 74, 28);
        const drawArrowMarker = (marker, angle, color, scale = 1) => {
          const length = 8 * scale;
          const wing = 4 * scale;
          ctx.save();
          ctx.translate(this._motionPathLocalToEditorPoint(marker.x, marker.y, doc).x, this._motionPathLocalToEditorPoint(marker.x, marker.y, doc).y);
          ctx.rotate(angle);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(-length, -wing);
          ctx.lineTo(0, 0);
          ctx.lineTo(-length, wing);
          ctx.stroke();
          ctx.restore();
        };
        const arrowColor = primary ? 'rgba(91,138,240,0.92)' : 'rgba(198,216,255,0.78)';
        arrowMarkers.forEach((marker, markerIndex) => {
          const angle = _getMotionPathDirectionArrowAngle(path.directionMode, markerIndex, marker.angle);
          drawArrowMarker(marker, angle, arrowColor, 1);
        });
      }

      if (!path.closed && sampled.length >= 2) {
        const endBehavior = _normalizeMotionPathEndBehavior(path.endBehavior);
        const startScreen = this._motionPathLocalToEditorPoint(sampled[0].x, sampled[0].y, doc);
        const endScreen = this._motionPathLocalToEditorPoint(sampled[sampled.length - 1].x, sampled[sampled.length - 1].y, doc);
        const endAccent = _getMotionPathEndBehaviorAccent(endBehavior);
        const endLabel = _getMotionPathEndBehaviorLabel(endBehavior);

        ctx.fillStyle = 'rgba(26,190,104,0.95)';
        ctx.strokeStyle = 'rgba(12,16,24,0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(startScreen.x, startScreen.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(12,16,24,0.9)';
        ctx.font = '10px Segoe UI, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('S', startScreen.x, startScreen.y + 0.5);

        ctx.fillStyle = endAccent;
        ctx.strokeStyle = 'rgba(12,16,24,0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.rect(endScreen.x - 8, endScreen.y - 6, 16, 12);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(12,16,24,0.92)';
        ctx.font = '9px Segoe UI, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(endLabel[0], endScreen.x, endScreen.y + 0.5);

        ctx.fillStyle = 'rgba(230,236,246,0.92)';
        ctx.font = '10px Segoe UI, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(endLabel, endScreen.x + 12, endScreen.y - 10);
      }
      ctx.restore();
    }

    this._syncMotionPathOverlayControls(doc);

    const preview = this._compileActiveMotionPathGraph(this.getP());
    if (preview?.paths?.length && preview?.agents?.length) {
      ctx.save();
      for (const agent of preview.agents) {
        const track = preview.paths[agent.pathIndex];
        const pt = _sampleMotionPathTrack(track, agent.distance);
        if (!pt) continue;
        const screen = this._motionPathLocalToEditorPoint(pt.x, pt.y, doc);
        ctx.fillStyle = 'rgba(255,210,120,0.9)';
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 2.5 + ((pt.stampScale || 1) * 1.2), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    this.motionPathEditor.needsRedraw = false;
  }

  _compileActiveMotionPathGraph(p = this.getP()) {
    const doc = this._getActiveMotionPathDocument();
    if (!doc) return { documentId: null, updatedAt: 0, paths: [], agents: [] };
    const compiledPaths = doc.paths
      .map(path => {
        const sampled = _sampleMotionPathPrimitive(path, MOTION_PATH_RESAMPLE_STEP);
        const smoothed = path.kind === 'bezier' || path.kind === 'ellipse' || path.kind === 'radial'
          ? sampled
          : _smoothMotionPathTrackPoints(sampled, p.motionPathPathSmoothing || 0, !!path.closed, MOTION_PATH_RESAMPLE_STEP);
        const track = _buildMotionPathTrack(smoothed, path.closed);
        return track
          ? {
              ...track,
              id: path.id,
              kind: path.kind,
              name: path.name,
              agentCount: path.agentCount || 0,
              speedMultiplier: path.speedMultiplier || 1,
              endBehavior: _normalizeMotionPathEndBehavior(path.endBehavior),
              directionMode: _normalizeMotionPathDirectionMode(path.directionMode),
              startMode: _normalizeMotionPathStartMode(path.startMode),
            }
          : null;
      })
      .filter(Boolean);
    const agents = [];
    if (compiledPaths.length) {
      const explicitTotal = compiledPaths.reduce((sum, path) => sum + (path.agentCount > 0 ? path.agentCount : 0), 0);
      const usesExplicitCounts = explicitTotal > 0;
      const totalAgents = Math.max(1, p.motionPathAgentCount || 1);
      const unresolvedPaths = compiledPaths.filter(path => path.agentCount <= 0);
      const remainingAgents = Math.max(0, totalAgents - explicitTotal);
      compiledPaths.forEach((path, pathIndex) => {
        let count = path.agentCount > 0 ? path.agentCount : 0;
        if (!usesExplicitCounts) {
          const base = Math.floor(totalAgents / compiledPaths.length);
          const remainder = totalAgents % compiledPaths.length;
          count = base + (pathIndex < remainder ? 1 : 0);
        } else if (unresolvedPaths.length && count === 0) {
          const unresolvedIndex = unresolvedPaths.findIndex(entry => entry.id === path.id);
          const base = Math.floor(remainingAgents / unresolvedPaths.length);
          const remainder = remainingAgents % unresolvedPaths.length;
          count = base + (unresolvedIndex < remainder ? 1 : 0);
        }
        for (let agentIndex = 0; agentIndex < count; agentIndex++) {
          const directionMode = _normalizeMotionPathDirectionMode(path.directionMode);
          const direction = directionMode === 'reverse'
            ? -1
            : directionMode === 'alternate'
              ? (agentIndex % 2 === 0 ? 1 : -1)
              : directionMode === 'random'
                ? (Math.random() < 0.5 ? -1 : 1)
                : 1;
          const startMode = _normalizeMotionPathStartMode(path.startMode);
          const baseDistance = startMode === 'random'
            ? _getMotionPathDeterministicStartUnit(doc.id, doc.updatedAt, path.id, agentIndex, count) * path.totalLength
            : (count <= 1 ? 0 : (path.totalLength * agentIndex) / count);
          const distance = !path.closed && direction === -1
            ? Math.max(0, path.totalLength - baseDistance)
            : baseDistance;
          agents.push({ pathIndex, pathId: path.id, distance, speedMultiplier: path.speedMultiplier || 1, endBehavior: _normalizeMotionPathEndBehavior(path.endBehavior), direction, startMode });
        }
      });
      if (!agents.length) {
        for (let i = 0; i < totalAgents; i++) {
          const pathIndex = i % compiledPaths.length;
          const path = compiledPaths[pathIndex];
          const directionMode = _normalizeMotionPathDirectionMode(path.directionMode);
          const direction = directionMode === 'reverse'
            ? -1
            : directionMode === 'alternate'
              ? (i % 2 === 0 ? 1 : -1)
              : directionMode === 'random'
                ? (Math.random() < 0.5 ? -1 : 1)
                : 1;
          const baseDistance = _normalizeMotionPathStartMode(path.startMode) === 'random'
            ? _getMotionPathDeterministicStartUnit(doc.id, doc.updatedAt, path.id, i, totalAgents) * path.totalLength
            : 0;
          const distance = !path.closed && direction === -1 ? Math.max(0, path.totalLength - baseDistance) : baseDistance;
          agents.push({ pathIndex, pathId: path.id, distance, speedMultiplier: path.speedMultiplier || 1, endBehavior: _normalizeMotionPathEndBehavior(path.endBehavior), direction, startMode: _normalizeMotionPathStartMode(path.startMode) });
        }
      }
    }
    return {
      documentId: doc.id,
      updatedAt: doc.updatedAt,
      scale: p.brushScale,
      paths: compiledPaths,
      agents,
    };
  }

  _setActiveMotionPathDocument(id) {
    const next = this._getMotionPathDocumentById(Number(id));
    if (!next) return;
    this.motionPath.activeDocumentId = next.id;
    this._syncMotionPathUI();
    this._maybeAutoSaveSession();
  }

  _createMotionPathDocument(name = null) {
    this._normalizeMotionPathState();
    const id = this.motionPath.nextDocumentId++;
    const trimmed = typeof name === 'string' ? name.trim().slice(0, 60) : '';
    const doc = this._createMotionPathDocumentRecord(id, trimmed || `Motion Graph ${id}`);
    this.motionPath.documents.push(doc);
    this.motionPath.activeDocumentId = doc.id;
    this._syncMotionPathUI();
    this._maybeAutoSaveSession();
    this.showToast(`Created ${doc.name}`);
    return doc;
  }

  _renameActiveMotionPathDocument() {
    const doc = this._getActiveMotionPathDocument();
    if (!doc) return;
    const rawName = window.prompt('Rename motion graph:', doc.name);
    if (!rawName) return;
    const name = rawName.trim().slice(0, 60);
    if (!name) return;
    doc.name = name;
    doc.updatedAt = Date.now();
    this._syncMotionPathUI();
    this._maybeAutoSaveSession();
    this.showToast(`Renamed to ${name}`);
  }

  _duplicateActiveMotionPathDocument() {
    const doc = this._getActiveMotionPathDocument();
    if (!doc) return;
    const id = this.motionPath.nextDocumentId++;
    const clone = _deepClone(doc);
    clone.id = id;
    clone.name = `${doc.name} Copy`;
    clone.updatedAt = Date.now();
    this.motionPath.documents.push(clone);
    this.motionPath.activeDocumentId = id;
    this._syncMotionPathUI();
    this._maybeAutoSaveSession();
    this.showToast(`Duplicated ${doc.name}`);
  }

  _deleteActiveMotionPathDocument() {
    this._normalizeMotionPathState();
    const doc = this._getActiveMotionPathDocument();
    if (!doc) return;
    if (!window.confirm(`Delete motion graph "${doc.name}"?`)) return;

    if (this.motionPath.documents.length <= 1) {
      const replacement = this._createMotionPathDocumentRecord(doc.id, 'Motion Graph 1');
      this.motionPath.documents = [replacement];
      this.motionPath.activeDocumentId = replacement.id;
      this.motionPath.nextDocumentId = Math.max(this.motionPath.nextDocumentId, replacement.id + 1);
      this._syncMotionPathUI();
      this._maybeAutoSaveSession();
      this.showToast('Deleted graph and reset to a blank motion graph');
      return;
    }

    const index = this.motionPath.documents.findIndex(entry => entry.id === doc.id);
    if (index === -1) return;
    this.motionPath.documents.splice(index, 1);
    const fallback = this.motionPath.documents[Math.max(0, index - 1)] || this.motionPath.documents[0] || null;
    this.motionPath.activeDocumentId = fallback?.id || this.motionPath.activeDocumentId;
    this._syncMotionPathUI();
    this._maybeAutoSaveSession();
    this.showToast(`Deleted ${doc.name}`);
  }

  _syncMotionPathUI() {
    this._normalizeMotionPathState();
    const doc = this._getActiveMotionPathDocument();
    const docs = this.motionPath.documents;
    const validPathIds = new Set((doc?.paths || []).map(path => path.id));
    if (this.motionPathEditor.creationPathId && !validPathIds.has(this.motionPathEditor.creationPathId)) {
      this.motionPathEditor.creationPathId = null;
    }
    const selectedIds = this._getSelectedMotionPathPrimitiveIds().filter(id => validPathIds.has(id));
    if (selectedIds.length !== this._getSelectedMotionPathPrimitiveIds().length || (selectedIds.length && !selectedIds.includes(this.motionPathEditor.selectedPathId))) {
      this.motionPathEditor.selectedPathIds = selectedIds;
      this.motionPathEditor.selectedPathId = selectedIds.includes(this.motionPathEditor.selectedPathId)
        ? this.motionPathEditor.selectedPathId
        : (selectedIds[selectedIds.length - 1] || null);
      this.motionPathEditor.selectedHandleIndex = selectedIds.length === 1 ? this.motionPathEditor.selectedHandleIndex : -1;
      this.motionPathEditor.selectedHandleType = selectedIds.length === 1 ? this.motionPathEditor.selectedHandleType : null;
    }
    const optionsHtml = docs.map(entry => `<option value="${entry.id}">${entry.name}</option>`).join('');
    for (const id of ['motionPathDocSelect', 'motionPathEditorSelect']) {
      const select = document.getElementById(id);
      if (!select) continue;
      select.innerHTML = optionsHtml;
      if (doc) select.value = String(doc.id);
    }
    const compiled = this._compileActiveMotionPathGraph(this.getP());
    const summary = `${doc?.paths?.length || 0} path${(doc?.paths?.length || 0) === 1 ? '' : 's'} · ${compiled?.agents?.length || 0} agent${(compiled?.agents?.length || 0) === 1 ? '' : 's'}`;
    const sidebarName = document.getElementById('motionPathDocName');
    if (sidebarName) sidebarName.textContent = doc?.name || 'No graph';
    const sidebarSummary = document.getElementById('motionPathDocSummary');
    if (sidebarSummary) sidebarSummary.textContent = summary;
    const editorName = document.getElementById('motionPathEditorDocName');
    if (editorName) editorName.textContent = doc?.name || 'No graph selected';
    const editorMeta = document.getElementById('motionPathEditorDocMeta');
    if (editorMeta) editorMeta.textContent = summary;
    const badge = document.getElementById('motionPathEditorStatus');
    if (badge) {
      const zoomLabel = `${Math.round((doc?.view?.zoom || 1) * 100)}%`;
      const createKind = this._getMotionPathEditorCreateKind();
      const toolLabel = createKind
        ? `Create ${createKind[0].toUpperCase()}${createKind.slice(1)}`
        : this.motionPathEditor.activeTool === 'pan'
          ? 'Pan Tool'
        : this.motionPathEditor.activeTool === 'delete'
          ? 'Delete Tool'
          : 'Select Tool';
      badge.textContent = this.motionPathEditor.insertPointMode ? 'Click to Place Point' : `${toolLabel} · View ${zoomLabel}`;
    }
    const zoomBadge = document.getElementById('motionPathToolbarZoomLabel');
    if (zoomBadge) zoomBadge.textContent = `${Math.round((doc?.view?.zoom || 1) * 100)}%`;
    const singleDoc = docs.length <= 1;
    for (const id of ['motionPathDeleteDocBtn', 'motionPathEditorDelete']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.disabled = false;
      btn.title = singleDoc
        ? 'Delete the current graph and reset to a new blank graph'
        : 'Delete the current motion graph';
      btn.textContent = id === 'motionPathEditorDelete'
        ? (singleDoc ? 'Reset Graph' : 'Delete')
        : (singleDoc ? 'Reset' : 'Delete');
    }
    if (!selectedIds.length && doc?.paths?.length && Number.isFinite(this.motionPathEditor.selectedPathId) && !doc.paths.some(path => path.id === this.motionPathEditor.selectedPathId)) {
      this.motionPathEditor.selectedPathId = null;
      this.motionPathEditor.selectedHandleIndex = -1;
      this.motionPathEditor.selectedHandleType = null;
    }
    const selected = this._getSelectedMotionPathPrimitive();
    const selectedCount = selectedIds.length;
    const singleSelected = selectedCount === 1 ? selected : null;
    const selectedPoint = singleSelected?.points?.[this.motionPathEditor.selectedHandleIndex] || null;
    const selectedGroup = this._getSelectedMotionPathGroup();
    const radialGroup = selectedGroup?.groupKind === 'radial' ? selectedGroup : null;
    const createKind = this._getMotionPathEditorCreateKind();
    if (!singleSelected && this.motionPathEditor.insertPointMode) this.motionPathEditor.insertPointMode = false;
    const selectionMeta = document.getElementById('motionPathEditorSelectionMeta');
    const radialCount = radialGroup
      ? radialGroup.radialCount
      : singleSelected?.kind === 'radial'
        ? _normalizeMotionPathRadialCount(singleSelected.radialCount)
        : 0;
    const radialSpread = radialGroup
      ? Math.round(radialGroup.radialSpread)
      : singleSelected?.kind === 'radial'
        ? Math.round(_normalizeMotionPathRadialSpread(singleSelected.radialSpread))
        : 0;
    const radialDetails = radialCount > 0
      ? ` · ${radialCount} spoke${radialCount === 1 ? '' : 's'} · ${radialSpread}° spread`
      : '';
    if (selectionMeta) {
      selectionMeta.textContent = radialGroup && selectedCount > 1
        ? `radial group · ${selectedCount} selected line${selectedCount === 1 ? '' : 's'}${radialDetails}`
        : singleSelected
        ? `${singleSelected.kind}${singleSelected.closed ? ' · closed' : ''} · ${singleSelected.points.length} control point${singleSelected.points.length === 1 ? '' : 's'}${radialDetails} · ${_getMotionPathDirectionModeLabel(singleSelected.directionMode)} · ${_getMotionPathStartModeLabel(singleSelected.startMode)}${singleSelected.closed ? '' : ` · ${_getMotionPathEndBehaviorLabel(singleSelected.endBehavior)}`}${selectedPoint ? ` · node size ${selectedPoint.stampScale.toFixed(2)}x · node speed ${selectedPoint.speedScale.toFixed(2)}x` : ''}`
        : selectedCount > 1
          ? `${selectedCount} primitives selected`
          : 'No primitive selected';
    }
    const nameInput = document.getElementById('motionPathSelectedName');
    if (nameInput) {
      nameInput.disabled = !singleSelected && !radialGroup;
      if (radialGroup) nameInput.value = radialGroup.groupName || '';
      else nameInput.value = singleSelected?.name || '';
    }
    const agentInput = document.getElementById('motionPathSelectedAgentCount');
    if (agentInput) {
      agentInput.disabled = !singleSelected || !!radialGroup;
      agentInput.value = String(singleSelected?.agentCount || 0);
    }
    const pointStampScaleInput = document.getElementById('motionPathSelectedPointStampScale');
    if (pointStampScaleInput) {
      pointStampScaleInput.disabled = !selectedPoint;
      pointStampScaleInput.value = selectedPoint ? selectedPoint.stampScale.toFixed(2) : '1.00';
    }
    const pointSpeedScaleInput = document.getElementById('motionPathSelectedPointSpeedScale');
    if (pointSpeedScaleInput) {
      pointSpeedScaleInput.disabled = !selectedPoint;
      pointSpeedScaleInput.value = selectedPoint ? selectedPoint.speedScale.toFixed(2) : '1.00';
    }
    const endBehaviorInput = document.getElementById('motionPathSelectedEndBehavior');
    if (endBehaviorInput) {
      endBehaviorInput.disabled = !singleSelected || !!singleSelected?.closed;
      endBehaviorInput.value = _normalizeMotionPathEndBehavior(singleSelected?.endBehavior);
    }
    const startModeInput = document.getElementById('motionPathSelectedStartMode');
    if (startModeInput) {
      startModeInput.disabled = !singleSelected;
      startModeInput.value = _normalizeMotionPathStartMode(singleSelected?.startMode);
    }
    const closedInput = document.getElementById('motionPathSelectedClosed');
    if (closedInput) {
      closedInput.disabled = !singleSelected || !!radialGroup || (singleSelected?.kind !== 'polyline' && singleSelected?.kind !== 'bezier');
      closedInput.checked = !!singleSelected?.closed;
    }
    const radialCountInput = document.getElementById('motionPathSelectedRadialCount');
    if (radialCountInput) {
      radialCountInput.disabled = !radialGroup && singleSelected?.kind !== 'radial';
      radialCountInput.value = String(radialCount);
    }
    const radialSpreadInput = document.getElementById('motionPathSelectedRadialSpread');
    if (radialSpreadInput) {
      radialSpreadInput.disabled = !radialGroup && singleSelected?.kind !== 'radial';
      radialSpreadInput.value = String(radialSpread);
    }
    const addPointBtn = document.getElementById('motionPathAddPoint');
    if (addPointBtn) {
      addPointBtn.disabled = !singleSelected || !!createKind || !!radialGroup || singleSelected?.kind === 'radial';
      addPointBtn.textContent = this.motionPathEditor.insertPointMode ? 'Cancel Point' : 'Add Point';
    }
    const insertBetweenToggle = document.getElementById('motionPathInsertBetweenToggle');
    if (insertBetweenToggle) {
      insertBetweenToggle.checked = !!this.motionPathEditor.insertBetweenPoints;
      insertBetweenToggle.disabled = !singleSelected || !!createKind || !!radialGroup || singleSelected?.kind === 'radial';
    }
    const deletePrimitiveBtn = document.getElementById('motionPathDeletePrimitive');
    if (deletePrimitiveBtn) deletePrimitiveBtn.disabled = !selectedCount;
    const toolbarStates = [
      ['motionPathToolSelect', true, this.motionPathEditor.activeTool === 'select'],
      ['motionPathToolPan', true, this.motionPathEditor.activeTool === 'pan'],
      ['motionPathToolDelete', true, this.motionPathEditor.activeTool === 'delete'],
      ['motionPathToolbarCopy', !!selectedCount, false],
      ['motionPathToolbarPaste', !!(this.motionPathEditor.clipboardPaths?.length), false],
      ['motionPathToolbarDuplicate', !!selectedCount, false],
      ['motionPathToolbarDeleteSelection', !!selectedCount, false],
      ['motionPathToolbarAddPolyline', true, createKind === 'polyline'],
      ['motionPathToolbarAddBezier', true, createKind === 'bezier'],
      ['motionPathToolbarAddRect', true, createKind === 'rectangle'],
      ['motionPathToolbarAddEllipse', true, createKind === 'ellipse'],
      ['motionPathToolbarAddRadial', true, createKind === 'radial'],
      ['motionPathToolbarPanelGraph', true, this.motionPathEditor.activePanel === 'graph'],
      ['motionPathToolbarPanelSelection', true, this.motionPathEditor.activePanel === 'selection'],
      ['motionPathToolbarPanelEdit', true, this.motionPathEditor.activePanel === 'edit'],
      ['motionPathToolbarHelp', true, !!this.motionPathEditor.helpOpen],
      ['motionPathToolbarZoomOut', true, false],
      ['motionPathToolbarZoomReset', true, false],
      ['motionPathToolbarZoomIn', true, false],
      ['motionPathToolbarCenterView', true, false],
    ];
    for (const [id, enabled, active] of toolbarStates) {
      const button = document.getElementById(id);
      if (!button) continue;
      button.disabled = !enabled;
      button.classList.toggle('active', !!active);
    }
    const empty = document.getElementById('motionPathEditorEmpty');
    if (empty) empty.classList.toggle('hidden', !!doc?.paths?.length);
    const drawer = document.getElementById('motionPathEditorDrawer');
    if (drawer) {
      drawer.classList.toggle('open', !!this.motionPathEditor.activePanel);
      if (this.motionPathEditor.activePanel === 'graph') this._positionMotionPathEditorPopover('motionPathToolbarPanelGraph', 'motionPathEditorDrawer');
      else if (this.motionPathEditor.activePanel === 'selection') this._positionMotionPathEditorPopover('motionPathToolbarPanelSelection', 'motionPathEditorDrawer');
      else if (this.motionPathEditor.activePanel === 'edit') this._positionMotionPathEditorPopover('motionPathToolbarPanelEdit', 'motionPathEditorDrawer');
    }
    const panelMap = [
      ['motionPathEditorGraphPanel', 'graph'],
      ['motionPathEditorSelectionPanel', 'selection'],
      ['motionPathEditorEditPanel', 'edit'],
    ];
    for (const [id, panel] of panelMap) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('is-open', this.motionPathEditor.activePanel === panel);
    }
    const helpCard = document.getElementById('motionPathEditorHelpCard');
    if (helpCard) {
      helpCard.classList.toggle('open', !!this.motionPathEditor.helpOpen);
      if (this.motionPathEditor.helpOpen) {
        this._positionMotionPathEditorPopover('motionPathToolbarHelp', 'motionPathEditorHelpCard', { alignRight: true });
      }
    }
    this._syncMotionPathOverlayControls(doc);
    const canvas = this._getMotionPathEditorCanvas();
    if (canvas) {
      canvas.style.cursor = this.motionPathEditor.dragMode === 'pan'
        ? 'grabbing'
        : this.motionPathEditor.activeTool === 'pan'
          ? 'grab'
        : this.motionPathEditor.insertPointMode
          ? 'copy'
          : createKind
            ? 'cell'
          : this.motionPathEditor.activeTool === 'delete'
            ? 'not-allowed'
          : 'crosshair';
    }
    this.motionPathEditor.needsRedraw = true;
  }

  _openMotionPathEditor() {
    this._normalizeMotionPathState();
    if (this.motionPath.editorOpen) return;
    this.motionPath.previousUiState = {
      sidebarOpen: !!document.getElementById('rightPanel')?.classList.contains('open'),
      layersOpen: !!document.getElementById('leftPanel')?.classList.contains('open'),
    };
    document.getElementById('rightPanel')?.classList.remove('open');
    document.getElementById('leftPanel')?.classList.remove('open');
    document.getElementById('sidebarToggle')?.classList.remove('active');
    document.getElementById('layersToggle')?.classList.remove('active');
    this._updateTabVisibility();
    document.getElementById('brushDropdown')?.classList.remove('open');
    document.getElementById('motionPathEditor')?.classList.add('open');
    this.motionPath.editorOpen = true;
    this.motionPathEditor.activePanel = null;
    this.motionPathEditor.touchPoints = {};
    this._endMotionPathEditorTouchGesture();
    this._syncMotionPathEditorCanvasSize();
    this._syncMotionPathUI();
    this._syncMotionPathOverlayControls();
    this._renderMotionPathEditorSurface();
    document.getElementById('motionPathEditorClose')?.focus();
  }

  _closeMotionPathEditor({ save = true } = {}) {
    if (!this.motionPath.editorOpen) return;
    this._cleanupMotionPathCreation();
    this._hideMotionPathOverlayEndBehaviorSelect();
    const overlayControls = this._getMotionPathEditorOverlayControls();
    if (overlayControls) overlayControls.innerHTML = '';
    document.getElementById('motionPathEditor')?.classList.remove('open');
    this.motionPath.editorOpen = false;
    this.motionPathEditor.pointerId = null;
    this.motionPathEditor.dragMode = null;
    this.motionPathEditor.dragPathId = null;
    this.motionPathEditor.dragHandleIndex = -1;
    this.motionPathEditor.activePanel = null;
    this.motionPathEditor.touchPoints = {};
    this._endMotionPathEditorTouchGesture();
    this.motionPathEditor.selectedHandleIndex = -1;
    this.motionPathEditor.selectedHandleType = null;
    this.motionPathEditor.hoverHandleType = null;
    this.motionPathEditor.creationPathId = null;
    this.motionPathEditor.activeTool = 'select';
    this.motionPathEditor.insertPointMode = false;
    const previous = this.motionPath.previousUiState;
    if (previous?.sidebarOpen) {
      document.getElementById('rightPanel')?.classList.add('open');
      document.getElementById('sidebarToggle')?.classList.add('active');
    }
    if (previous?.layersOpen) {
      document.getElementById('leftPanel')?.classList.add('open');
      document.getElementById('layersToggle')?.classList.add('active');
    }
    this._updateTabVisibility();
    this.motionPath.previousUiState = null;
    this._syncMotionPathUI();
    if (save) this.saveSession();
  }

  // ========================================================
  // BRUSH MANAGEMENT
  // ========================================================

  setBrush(name) {
    if (!this.brushes[name]) return;
    if (this.activeBrush !== name && this._simulationExport.recording) void this._stopSimulationRecording({ announce: false });
    if (this.activeBrush !== name && (this.simulation.running || this.simulation.paused)) this.stopSimulation(false);
    this.setTool('brush'); // restore brush mode when changing brush type
    // Deactivate current
    const cur = this.brushes[this.activeBrush];
    if (cur && cur.deactivate) cur.deactivate();
    this.activeBrush = name;
    // Update brush dropdown button
    const brushLabels = { boid: '🐦 Boid', ant: '🐜 Ant', bristle: '🖊 Bristle', motionPath: '🧭 Motion Path', fluid: '🌊 LBM Fluid', fluid3d: '💧 3D Fluid', simple: '🖌 Simple', eraser: '◻ Eraser' };
    const btn = document.getElementById('brushBtn');
    if (btn) {
      btn.textContent = brushLabels[name] || name;
      btn.classList.remove('active', 'eraser-active');
      btn.classList.add(name === 'eraser' ? 'eraser-active' : 'active');
    }
    // Update dropdown selection
    document.querySelectorAll('#brushDropdown button[data-brush]').forEach(b => {
      b.classList.toggle('selected', b.dataset.brush === name);
    });
    // Toggle brush-specific sections
    this._toggleBrushSections(name);
    if (!this._isMotionBrush(name)) this.simulation.enabled = false;
    this._ensureSimulationSpawns(name);
    this._syncSimulationUI();
    this._syncMotionPathUI();
    this._paramsDirty = true;
  }

  _toggleBrushSections(brush) {
    document.querySelectorAll('[data-brushes]').forEach(el => {
      const allowed = el.dataset.brushes.split(' ');
      const shouldShow = allowed.includes(brush)
        && !(el.dataset.section === 'sensing' && this.simulation.enabled && this._isMotionBrush(brush));
      el.classList.toggle('brush-hidden', !shouldShow);
    });
  }

  getCurrentBrush() { return this.brushes[this.activeBrush]; }

  /** Set the active interaction tool. */
  setTool(name) {
    this.activeTool = name;
    this._syncSelectionUI();
  }

  /** Clear the active selection. Stamps any floating pixels first. */
  deselect() {
    if (!this.selectionMgr?.active) return;
    this._commitFloatingPixels();
    this.selectionMgr.clear();
    this._syncSelectionUI();
    this.showToast('✕ Deselected');
  }

  /** Stamp floating pixels back onto the active layer (if any). */
  _commitFloatingPixels() {
    if (!this.selectionMgr?._floatingPixels) return;
    const l = this.getActiveLayer();
    this.selectionMgr.stampPixels(l.ctx, this.DPR);
    l.dirty = true;
    this.compositeAllLayers();
  }

  /** Sync selection toolbar buttons with current tool/selection state. */
  _syncSelectionUI() {
    document.getElementById('rectSelectBtn')?.classList.toggle('active', this.activeTool === 'rect-select');
    document.getElementById('ellipseSelectBtn')?.classList.toggle('active', this.activeTool === 'ellipse-select');
    document.getElementById('lassoSelectBtn')?.classList.toggle('active', this.activeTool === 'lasso-select');
    document.getElementById('fillBtn')?.classList.toggle('active', this.activeTool === 'fill');
    document.getElementById('eyedropperBtn')?.classList.toggle('active', this.activeTool === 'eyedropper');
    const deselectBtn = document.getElementById('deselectBtn');
    if (deselectBtn) deselectBtn.style.display = this.selectionMgr?.active ? '' : 'none';
    const transformBtn = document.getElementById('transformBtn');
    if (transformBtn) transformBtn.style.display = this.selectionMgr?.active ? '' : 'none';
    const proportionalBtn = document.getElementById('proportionalToggle');
    if (proportionalBtn) proportionalBtn.style.display = this.selectionMgr?.transformActive ? '' : 'none';
    // Update transform button active state
    document.getElementById('transformBtn')?.classList.toggle('active', this.activeTool === 'transform');
  }

  _toggleTransform() {
    if (!this.selectionMgr?.active) return;
    this.selectionMgr.transformActive = !this.selectionMgr.transformActive;
    if (this.selectionMgr.transformActive) {
      this.setTool('transform');
      this.showToast('🔒 Transform mode ON');
    } else {
      this.setTool('brush');
      this.showToast('🔒 Transform mode OFF');
    }
    this._syncSelectionUI();
  }

  _toggleProportional() {
    if (!this.selectionMgr) return;
    this.selectionMgr.keepProportional = !this.selectionMgr.keepProportional;
    const btn = document.getElementById('proportionalToggle');
    if (btn) btn.classList.toggle('active', this.selectionMgr.keepProportional);
    this.showToast(this.selectionMgr.keepProportional ? '🔒 Proportional: ON' : '🔒 Proportional: OFF');
  }

  // ========================================================
  // DRAWING / POINTER EVENTS
  // ========================================================

  _bindEvents() {
    const ic = this.interactionCanvas;

    ic.addEventListener('pointerdown', e => this._onPointerDown(e));
    ic.addEventListener('pointermove', e => this._onPointerMove(e));
    ic.addEventListener('pointerrawupdate', e => this._onPointerRawUpdate(e));
    ic.addEventListener('pointerup', e => this._onPointerUp(e));
    ic.addEventListener('pointercancel', e => this._onPointerUp(e));
    ic.addEventListener('pointerleave', e => this._onPointerLeave(e));

    // Touch events for pinch zoom/rotate (on canvasArea to capture all fingers)
    const area = document.getElementById('canvasArea');
    area.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false });
    area.addEventListener('touchmove', e => this._onTouchMove(e), { passive: false });
    area.addEventListener('touchend', e => this._onTouchEnd(e), { passive: false });
    area.addEventListener('touchcancel', e => this._onTouchEnd(e), { passive: false });

    // Mouse wheel zoom
    area.addEventListener('wheel', e => this._onWheel(e), { passive: false });

    // Keyboard shortcuts
    window.addEventListener('keydown', e => this._onKeyDown(e));

    // Resize
    window.addEventListener('resize', () => {
      this._resizeAll();
      this.compositeAllLayers();
    });

    // Brush dropdown
    const brushBtn = document.getElementById('brushBtn');
    const brushDropdown = document.getElementById('brushDropdown');
    if (brushBtn && brushDropdown) {
      const positionDropdown = () => {
        const r = brushBtn.getBoundingClientRect();
        brushDropdown.style.top = (r.bottom + 4) + 'px';
        brushDropdown.style.left = r.left + 'px';
      };
      brushBtn.addEventListener('click', e => {
        e.stopPropagation();
        positionDropdown();
        brushDropdown.classList.toggle('open');
      });
      brushDropdown.querySelectorAll('button[data-brush]').forEach(b => {
        b.addEventListener('click', e => {
          e.stopPropagation();
          this.setBrush(b.dataset.brush);
          brushDropdown.classList.remove('open');
        });
      });
      document.addEventListener('click', () => {
        brushDropdown.classList.remove('open');
      });
    }
    this._initColorPickerBindings();
    document.getElementById('undoBtn')?.addEventListener('click', () => this.doUndo());
    document.getElementById('redoBtn')?.addEventListener('click', () => this.doRedo());
    document.getElementById('simUndoBtn')?.addEventListener('click', () => this.doUndo());
    document.getElementById('simRedoBtn')?.addEventListener('click', () => this.doRedo());
    document.getElementById('clearBtn')?.addEventListener('click', () => this.clearActiveLayer());
    document.getElementById('saveWorkspaceBtn')?.addEventListener('click', () => document.getElementById('btnExportWorkspace')?.click());
    document.getElementById('openWorkspaceBtn')?.addEventListener('click', () => document.getElementById('btnImportWorkspace')?.click());
    document.getElementById('saveBtn')?.addEventListener('click', () => this.saveImage());
    document.getElementById('reloadAppBtn')?.addEventListener('click', () => this.reloadAppWithCacheBust());
    document.getElementById('exportPsdBtn')?.addEventListener('click', () => exportPSD(this));
    document.getElementById('importPsdBtn')?.addEventListener('click', () => importPSD(this));
    document.getElementById('resetViewBtn')?.addEventListener('click', () => this.resetView());
    document.getElementById('flipViewBtn')?.addEventListener('click', () => this.flipView());
    document.getElementById('tilingBtn')?.addEventListener('click', () => this.toggleTiling());
    document.getElementById('alphaLockBtn')?.addEventListener('click', () => this.toggleAlphaLock());
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      const rp = document.getElementById('rightPanel');
      const open = rp?.classList.toggle('open');
      document.getElementById('sidebarToggle')?.classList.toggle('active', open);
      this._updateTabVisibility();
    });
    document.getElementById('layersToggle')?.addEventListener('click', () => {
      const lp = document.getElementById('leftPanel');
      const open = lp?.classList.toggle('open');
      document.getElementById('layersToggle')?.classList.toggle('active', open);
      this._updateTabVisibility();
    });
    // ── Panel tab switching (drawer handles) ──
    document.querySelectorAll('.panel-tabs').forEach(tabBar => {
      tabBar.addEventListener('click', e => {
        const tab = e.target.closest('.panel-tab');
        if (!tab) return;
        const viewName = tab.dataset.panelView;
        const panelId = tab.dataset.panelTarget;
        const panelContainer = document.getElementById(panelId);
        if (!panelContainer) return;

        const isActive = tab.classList.contains('active');
        const isOpen = panelContainer.classList.contains('open');

        if (isActive && isOpen) {
          // Clicking the active tab when panel is open closes the panel
          panelContainer.classList.remove('open');
          // Update topbar toggle
          if (panelId === 'rightPanel') document.getElementById('sidebarToggle')?.classList.remove('active');
          if (panelId === 'leftPanel') document.getElementById('layersToggle')?.classList.remove('active');
        } else {
          // Switch to the clicked tab and open the panel
          tabBar.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          panelContainer.querySelectorAll(':scope > .panel-view').forEach(v => v.classList.remove('active'));
          const target = panelContainer.querySelector(`.panel-view[data-panel-view="${viewName}"]`);
          if (target) target.classList.add('active');
          panelContainer.classList.add('open');
          // Update topbar toggle
          if (panelId === 'rightPanel') document.getElementById('sidebarToggle')?.classList.add('active');
          if (panelId === 'leftPanel') document.getElementById('layersToggle')?.classList.add('active');
          if (panelId === 'rightPanel' && viewName === 'json') this._refreshWorkspaceJsonPanel();
        }
        this._updateTabVisibility();
      });
    });
    // ── Always show tabs setting ──
    const alwaysShowTabsCb = document.getElementById('alwaysShowTabs');
    if (alwaysShowTabsCb) {
      const storedAlwaysShowTabs = localStorage.getItem('bb_alwaysShowTabs');
      alwaysShowTabsCb.checked = storedAlwaysShowTabs == null ? true : storedAlwaysShowTabs === 'true';
      if (storedAlwaysShowTabs == null) {
        localStorage.setItem('bb_alwaysShowTabs', 'true');
      }
      alwaysShowTabsCb.addEventListener('change', () => {
        localStorage.setItem('bb_alwaysShowTabs', alwaysShowTabsCb.checked);
        this._updateTabVisibility();
      });
    }
    this._updateTabVisibility();
    document.getElementById('swapColors')?.addEventListener('click', () => {
      this.swapPaintColors();
    });
    document.getElementById('layerSwitcher')?.addEventListener('change', e => {
      this.setActiveLayer(+e.target.value);
      syncUI(this);
    });
    // Selection tools
    document.getElementById('rectSelectBtn')?.addEventListener('click', () => this.setTool('rect-select'));
    document.getElementById('ellipseSelectBtn')?.addEventListener('click', () => this.setTool('ellipse-select'));
    document.getElementById('lassoSelectBtn')?.addEventListener('click', () => this.setTool('lasso-select'));
    document.getElementById('fillBtn')?.addEventListener('click', () => this.setTool('fill'));
    document.getElementById('eyedropperBtn')?.addEventListener('click', () => this.setTool('eyedropper'));
    document.getElementById('deselectBtn')?.addEventListener('click', () => this.deselect());
    // Transform tool
    document.getElementById('transformBtn')?.addEventListener('click', () => this._toggleTransform());
    document.getElementById('proportionalToggle')?.addEventListener('click', () => this._toggleProportional());
    document.getElementById('simulationBtn')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      this._toggleSimulationMode(!this.simulation.enabled);
    });
    document.getElementById('simHelpMenuBtn')?.addEventListener('click', () => {
      this._closeTopbarOverflowMenu?.();
      this._toggleSimTopbarGuide();
    });
    document.getElementById('simRunBtn')?.addEventListener('click', () => {
      if (this.simulation.paused) this.resumeSimulation();
      else this.startSimulation();
    });
    ['simHudRunBtn', 'simDrawerRunBtn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => {
        if (this.simulation.paused) this.resumeSimulation();
        else this.startSimulation();
      });
    });
    document.getElementById('simPauseBtn')?.addEventListener('click', () => this.pauseSimulation());
    document.getElementById('simStopBtn')?.addEventListener('click', () => this.stopSimulation());
    ['simHudStopBtn', 'simDrawerStopBtn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this.stopSimulation());
    });
    document.getElementById('simResetBtn')?.addEventListener('click', () => this.resetSimulationPlayback());
    document.getElementById('simEphemeralToggle')?.addEventListener('click', () => {
      const source = document.getElementById('simEphemeralMode');
      if (!source) return;
      source.checked = !source.checked;
      this.invalidateParams();
      source.dispatchEvent(new Event('change', { bubbles: true }));
      this._syncSimulationUI();
    });
    document.getElementById('simForceVizToggle')?.addEventListener('click', () => {
      this._setSimulationMode(this.simulation.mode === 'forceVisualization' ? 'normal' : 'forceVisualization');
    });
    document.getElementById('simSetupExplorerBtn')?.addEventListener('click', event => {
      this.toggleSimulationSessionRoutingPicker(event.currentTarget);
    });
    document.getElementById('simEphemeralMode')?.addEventListener('change', () => {
      if (document.getElementById('simEphemeralMode')?.checked && this.simulation.running) {
        const brush = this.getCurrentBrush();
        if (typeof brush?._commitGpuPreviewToLayer === 'function') {
          brush._commitGpuPreviewToLayer();
        }
      }
      this.invalidateParams();
      this._syncSimulationUI();
    });
    document.getElementById('simRecordBtn')?.addEventListener('click', () => void this._toggleSimulationRecordingRequest());
    document.getElementById('simExportBtn')?.addEventListener('click', () => this._showSimulationExportModal());
    ['simGuidesToggle', 'simDrawerGuidesToggle'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this._toggleSimulationGuidesVisibility());
    });
    ['simHeatmapToggle', 'simDrawerHeatmapToggle'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this._toggleSimulationHeatmap());
    });
    ['simCanvasClearBtn', 'simDrawerCanvasClearBtn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this.clearActiveLayer());
    });
    ['simClearBtn', 'simDrawerClearBtn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this.clearSimulationGuides());
    });
    document.getElementById('simDrawerDuplicateBtn')?.addEventListener('click', () => {
      const entry = this._getSelectedSimulationEntry();
      const clone = this._duplicateSelectedSimulationItem();
      if (clone && entry?.kind === 'spawn') this._queueSimulationPlaybackRefresh();
    });
    document.getElementById('simDrawerCopyBtn')?.addEventListener('click', () => {
      this._copySelectedSimulationItem();
    });
    document.getElementById('simDrawerCutBtn')?.addEventListener('click', () => {
      this._cutSelectedSimulationItem();
    });
    document.getElementById('simDrawerPasteBtn')?.addEventListener('click', () => {
      this._pasteSimulationClipboardItem();
    });
    ['simStepBackBtn', 'simDrawerStepBackBtn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this._stepSimulationPathPosition(-1));
    });
    ['simStepForwardBtn', 'simDrawerStepForwardBtn'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this._stepSimulationPathPosition(1));
    });
    document.getElementById('simHudCollapseBtn')?.addEventListener('click', () => {
      this.simulation.hudCollapsed = !this.simulation.hudCollapsed;
      this._syncSimulationUI();
    });
    document.getElementById('simModeSelect')?.addEventListener('change', event => {
      this._setSimulationMode(event.target.value);
    });
    ['simInspectorToggle', 'simDrawerInspectorToggle'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => {
        // Toggle simulation tab visibility in right panel
        const simTab = document.querySelector('#rightPanelTabs .panel-tab[data-panel-view="simulation"]');
        if (simTab) {
          if (simTab.classList.contains('active')) {
            // Switch back to brush
            const brushTab = document.querySelector('#rightPanelTabs .panel-tab[data-panel-view="brush"]');
            if (brushTab) brushTab.click();
          } else {
            simTab.click();
          }
        }
        this._syncSimulationUI();
      });
    });
    document.getElementById('simOverlayHandle')?.addEventListener('click', () => {
      // Switch to simulation tab in right panel
      const simTab = document.querySelector('#rightPanelTabs .panel-tab[data-panel-view="simulation"]');
      if (simTab) simTab.click();
    });
    document.getElementById('simFormatMenu')?.addEventListener('pointerdown', e => this._handleSimulationFormatMenuPointerDown(e));
    window.addEventListener('pointermove', e => this._handleSimulationFormatMenuPointerMove(e), { passive: false });
    window.addEventListener('pointerup', e => this._handleSimulationFormatMenuPointerUp(e));
    window.addEventListener('pointercancel', e => this._handleSimulationFormatMenuPointerUp(e));
    document.addEventListener('pointerdown', e => this._handleSimulationFormatMenuGlobalPointerDown(e), true);
    window.addEventListener('resize', () => {
      this._applySimulationFormatMenuPosition();
      this._positionSimulationFormatMenuPopovers();
    });
    document.querySelectorAll('[data-sim-tool]').forEach(el => {
      el.addEventListener('click', () => this._setSimulationTool(el.dataset.simTool));
    });
    document.getElementById('simHelpClose')?.addEventListener('click', () => this._closeSimulationHelp());
    document.getElementById('simHelpBackdrop')?.addEventListener('click', () => this._closeSimulationHelp());
    document.getElementById('forceVizHelpClose')?.addEventListener('click', () => this._closeForceVizHelp());
    document.getElementById('forceVizHelpBackdrop')?.addEventListener('click', () => this._closeForceVizHelp());
    document.getElementById('simDistributePointsClose')?.addEventListener('click', () => this._closeSimulationDistributeDialog());
    document.getElementById('simDistributePointsBackdrop')?.addEventListener('click', () => this._closeSimulationDistributeDialog());
    document.getElementById('simDistributePointsCancel')?.addEventListener('click', () => this._closeSimulationDistributeDialog());
    document.getElementById('simDistributePointsApply')?.addEventListener('click', () => this._applySimulationDistributeDialog());
    ['simDistributePointCount', 'simDistributePointType', 'simDistributeMode', 'simDistributeCurve'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => this._renderSimulationDistributeDialogPreview());
      document.getElementById(id)?.addEventListener('change', () => this._renderSimulationDistributeDialogPreview());
    });
    // Copy/cut/paste
    document.getElementById('copyBtn')?.addEventListener('click', () => this.copyToClipboard());
    document.getElementById('cutBtn')?.addEventListener('click', () => this.cutToClipboard());
    document.getElementById('pasteBtn')?.addEventListener('click', () => this.pasteFromClipboard());
    // Color pickers invalidate params
    this.primaryEl.addEventListener('input', () => {
      this._paramsDirty = true;
      this._handleColorInputSync('primary');
    });
    this.secondaryEl.addEventListener('input', () => {
      this._paramsDirty = true;
      this._handleColorInputSync('secondary');
    });
    // Background color
    this.bgColorEl?.addEventListener('input', () => {
      this._fillBackgroundLayer();
      this.compositeAllLayers();
      this._handleColorInputSync('background');
    });
    // Canvas size modal
    document.getElementById('canvasSizeBtn')?.addEventListener('click', () => this._showCanvasSizeModal());
    document.getElementById('canvasSizeClose')?.addEventListener('click', () => this._hideCanvasSizeModal());
    document.getElementById('canvasSizeBackdrop')?.addEventListener('click', () => this._hideCanvasSizeModal());
    document.getElementById('workspaceJsonCloseAction')?.addEventListener('click', () => this._hideWorkspaceJsonModal());
    document.getElementById('workspaceJsonDocumentSelect')?.addEventListener('change', event => {
      this._workspaceJsonEditorDocKey = event.target.value || 'workspace';
      this._populateWorkspaceJsonDocumentSelect(this._workspaceJsonEditorDocKey);
      this._populateWorkspaceJsonEditor(this._createWorkspaceJsonEditorBundle());
    });
    document.getElementById('workspaceJsonSessionSelect')?.addEventListener('change', event => {
      this._workspaceJsonEditorSessionIndex = event.target.value === 'draft' ? -1 : Number(event.target.value);
      if (!Number.isFinite(this._workspaceJsonEditorSessionIndex)) this._workspaceJsonEditorSessionIndex = -1;
      this._populateWorkspaceJsonEditor(this._createWorkspaceJsonEditorBundle());
    });
    document.getElementById('workspaceJsonStructuredEditor')?.addEventListener('input', event => this._handleWorkspaceJsonValueInput(event));
    document.getElementById('workspaceJsonStructuredEditor')?.addEventListener('change', event => this._handleWorkspaceJsonValueInput(event));
    document.getElementById('workspaceJsonAutoApply')?.addEventListener('change', event => {
      if (event.target.checked) {
        this._setWorkspaceJsonModalStatus('Auto-apply enabled. Changes will apply while typing.', 'success');
        try {
          this._readWorkspaceJsonStructuredDocument();
          this._scheduleWorkspaceJsonAutoApply();
        } catch (error) {
          this._setWorkspaceJsonModalStatus(error?.message || 'Workspace JSON validation failed.', 'error');
        }
      } else {
        this._cancelWorkspaceJsonAutoApply();
        this._setWorkspaceJsonModalStatus('Auto-apply disabled. Use Apply when ready.', 'success');
      }
    });
    document.getElementById('workspaceJsonFormat')?.addEventListener('click', () => {
      try {
        this._formatWorkspaceJsonEditor();
      } catch (error) {
        this._setWorkspaceJsonModalStatus(error?.message || 'Workspace JSON format failed.', 'error');
        this.showToast('⚠ JSON format failed');
      }
    });
    document.getElementById('workspaceJsonValidate')?.addEventListener('click', () => {
      try {
        this._validateWorkspaceJsonEditor();
      } catch (error) {
        this._setWorkspaceJsonModalStatus(error?.message || 'Workspace JSON validation failed.', 'error');
        this.showToast('⚠ JSON validation failed');
      }
    });
    document.getElementById('workspaceJsonCopy')?.addEventListener('click', () => {
      void this._copyWorkspaceJsonEditorText();
    });
    document.getElementById('workspaceJsonResetCurrent')?.addEventListener('click', () => {
      this._resetWorkspaceJsonEditorToCurrent();
    });
    document.getElementById('workspaceJsonApply')?.addEventListener('click', () => {
      void this._applyWorkspaceJsonEditor();
    });
    document.getElementById('simExportClose')?.addEventListener('click', () => this._hideSimulationExportModal());
    document.getElementById('simExportBackdrop')?.addEventListener('click', () => this._hideSimulationExportModal());
    document.getElementById('simSetupClose')?.addEventListener('click', () => this._hideSimulationSetupExplorer({ discard: true }));
    document.getElementById('simSetupBackdrop')?.addEventListener('click', () => this._hideSimulationSetupExplorer({ discard: true }));
    document.getElementById('simSetupExit')?.addEventListener('click', () => this._hideSimulationSetupExplorer({ discard: true }));
    document.getElementById('simSetupAccept')?.addEventListener('click', () => this._applySimulationSetupDraft());
    document.getElementById('simSetupClearDefaults')?.addEventListener('click', () => this._resetSimulationSetupDraftToDefaults());
    document.getElementById('simSetupMultiToggle')?.addEventListener('change', event => {
      if (!this._simulationSetupDraft) return;
      this._simulationSetupDraft.multiSessionEnabled = !!event.target.checked;
      this._updateSimulationSetupSummary();
    });
    document.getElementById('simSetupSaveJson')?.addEventListener('click', () => this.exportSimulationSetupFile());
    document.getElementById('simSetupLoadJson')?.addEventListener('click', () => document.getElementById('simSetupLoadFile')?.click());
    document.getElementById('simSetupExportWorkspace')?.addEventListener('click', () => this.exportWorkspaceSettingsFile());
    document.getElementById('simSetupImportWorkspace')?.addEventListener('click', () => document.getElementById('simSetupWorkspaceImportFile')?.click());
    document.getElementById('simSetupLoadFile')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        await this.importSimulationSetupText(await file.text());
      } catch (error) {
        console.error('Simulation setup import failed:', error);
        this._setSimulationSetupStatus(error?.message || 'Simulation setup import failed.', 'error');
      }
    });
    document.getElementById('simSetupWorkspaceImportFile')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        await this.importWorkspaceSettingsText(await file.text());
        this._hideSimulationSetupExplorer({ discard: true });
        this.showToast(`📂 Loaded workspace file ${file.name}`);
      } catch (error) {
        console.error('Workspace import failed:', error);
        this._setSimulationSetupStatus(error?.message || 'Workspace import failed.', 'error');
      }
    });
    document.addEventListener('keydown', event => {
      const modal = document.getElementById('simSetupModal');
      if (!modal?.classList.contains('open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this._hideSimulationSetupExplorer({ discard: true });
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = [...modal.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled])')]
        .filter(node => node.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.addEventListener('keydown', event => {
      if (!this._isWorkspaceJsonPanelActive()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this._hideWorkspaceJsonModal();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void this._applyWorkspaceJsonEditor();
        return;
      }
      if (!event.shiftKey) return;
      const lowered = event.key.toLowerCase();
      if (lowered === 'f') {
        event.preventDefault();
        try {
          this._formatWorkspaceJsonEditor();
        } catch (error) {
          this._setWorkspaceJsonModalStatus(error?.message || 'Workspace JSON format failed.', 'error');
          this.showToast('⚠ JSON format failed');
        }
      } else if (lowered === 'v') {
        event.preventDefault();
        try {
          this._validateWorkspaceJsonEditor();
        } catch (error) {
          this._setWorkspaceJsonModalStatus(error?.message || 'Workspace JSON validation failed.', 'error');
          this.showToast('⚠ JSON validation failed');
        }
      } else if (lowered === 'c') {
        event.preventDefault();
        void this._copyWorkspaceJsonEditorText();
      }
    });
    document.addEventListener('pointerdown', event => {
      const modal = document.getElementById('simSetupModal');
      if (!modal?.classList.contains('open')) return;
      if (event.target.closest('[data-sim-setup-menu]') || event.target.closest('.sim-setup-multiList')) return;
      this._closeSimulationSetupMenus();
    });
    document.getElementById('simExportRecordAction')?.addEventListener('click', () => void this._toggleSimulationRecordingRequest());
    document.getElementById('simExportDownloadBtn')?.addEventListener('click', () => {
      void this._exportSimulationRecording();
    });
    ['simExportFormat', 'simExportFrameRate', 'simExportQuality'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => this._refreshSimulationExportUi());
    });
    document.getElementById('canvasSizePreset')?.addEventListener('change', () => this._onCanvasSizePresetChange());
    document.getElementById('canvasSizeSwap')?.addEventListener('click', () => {
      const w = document.getElementById('canvasSizeW');
      const h = document.getElementById('canvasSizeH');
      if (w && h) { const t = w.value; w.value = h.value; h.value = t; }
    });
    document.getElementById('canvasSizeApply')?.addEventListener('click', async () => {
      const w = +document.getElementById('canvasSizeW')?.value || 1920;
      const h = +document.getElementById('canvasSizeH')?.value || 1080;
      const bg = document.getElementById('canvasSizeBg')?.value || '#ffffff';
      await this.resizeDocument(w, h, bg);
      this._hideCanvasSizeModal();
    });
    document.getElementById('motionPathEditBtn')?.addEventListener('click', () => this._openMotionPathEditor());
    document.getElementById('motionPathNewDocBtn')?.addEventListener('click', () => this._createMotionPathDocument());
    document.getElementById('motionPathRenameDocBtn')?.addEventListener('click', () => this._renameActiveMotionPathDocument());
    document.getElementById('motionPathDeleteDocBtn')?.addEventListener('click', () => this._deleteActiveMotionPathDocument());
    document.getElementById('motionPathDocSelect')?.addEventListener('change', e => this._setActiveMotionPathDocument(e.target.value));
    document.getElementById('motionPathEditorClose')?.addEventListener('click', () => this._closeMotionPathEditor());
    document.getElementById('motionPathEditorBackdrop')?.addEventListener('click', () => this._closeMotionPathEditor({ save: false }));
    document.getElementById('motionPathEditorCreate')?.addEventListener('click', () => this._createMotionPathDocument());
    document.getElementById('motionPathEditorRename')?.addEventListener('click', () => this._renameActiveMotionPathDocument());
    document.getElementById('motionPathEditorDuplicate')?.addEventListener('click', () => this._duplicateActiveMotionPathDocument());
    document.getElementById('motionPathEditorDelete')?.addEventListener('click', () => this._deleteActiveMotionPathDocument());
    document.getElementById('motionPathEditorSelect')?.addEventListener('change', e => this._setActiveMotionPathDocument(e.target.value));
    document.getElementById('motionPathToolSelect')?.addEventListener('click', () => this._setMotionPathEditorTool('select'));
    document.getElementById('motionPathToolPan')?.addEventListener('click', () => this._setMotionPathEditorTool('pan'));
    document.getElementById('motionPathToolDelete')?.addEventListener('click', () => this._setMotionPathEditorTool('delete'));
    document.getElementById('motionPathToolbarZoomOut')?.addEventListener('click', () => {
      const canvas = this._getMotionPathEditorCanvas();
      const width = this.motionPathEditor.canvasWidth || canvas?.clientWidth || 1;
      const height = this.motionPathEditor.canvasHeight || canvas?.clientHeight || 1;
      this._zoomMotionPathEditorAt(width * 0.5, height * 0.5, 1 / 1.2);
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathToolbarZoomReset')?.addEventListener('click', () => this._resetMotionPathEditorZoom());
    document.getElementById('motionPathToolbarZoomIn')?.addEventListener('click', () => {
      const canvas = this._getMotionPathEditorCanvas();
      const width = this.motionPathEditor.canvasWidth || canvas?.clientWidth || 1;
      const height = this.motionPathEditor.canvasHeight || canvas?.clientHeight || 1;
      this._zoomMotionPathEditorAt(width * 0.5, height * 0.5, 1.2);
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathToolbarCenterView')?.addEventListener('click', () => this._centerMotionPathEditorView());
    document.getElementById('motionPathToolbarPanelGraph')?.addEventListener('click', () => this._setMotionPathEditorPanel('graph'));
    document.getElementById('motionPathToolbarPanelSelection')?.addEventListener('click', () => this._setMotionPathEditorPanel('selection'));
    document.getElementById('motionPathToolbarPanelEdit')?.addEventListener('click', () => this._setMotionPathEditorPanel('edit'));
    document.getElementById('motionPathToolbarHelp')?.addEventListener('click', () => this._setMotionPathEditorHelp());
    document.getElementById('motionPathToolbarCopy')?.addEventListener('click', () => this._copySelectedMotionPathPrimitives());
    document.getElementById('motionPathToolbarPaste')?.addEventListener('click', () => this._pasteMotionPathPrimitives());
    document.getElementById('motionPathToolbarDuplicate')?.addEventListener('click', () => this._duplicateSelectedMotionPathPrimitives());
    document.getElementById('motionPathToolbarDeleteSelection')?.addEventListener('click', () => this._deleteSelectedMotionPathPrimitive());
    document.getElementById('motionPathAddPolyline')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('polyline'));
    document.getElementById('motionPathAddBezier')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('bezier'));
    document.getElementById('motionPathAddRect')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('rectangle'));
    document.getElementById('motionPathAddEllipse')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('ellipse'));
    document.getElementById('motionPathAddRadial')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('radial'));
    document.getElementById('motionPathToolbarAddPolyline')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('polyline'));
    document.getElementById('motionPathToolbarAddBezier')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('bezier'));
    document.getElementById('motionPathToolbarAddRect')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('rectangle'));
    document.getElementById('motionPathToolbarAddEllipse')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('ellipse'));
    document.getElementById('motionPathToolbarAddRadial')?.addEventListener('click', () => this._startMotionPathPrimitiveCreation('radial'));
    document.getElementById('motionPathAddPoint')?.addEventListener('click', () => this._addPointToMotionPathPrimitive());
    document.getElementById('motionPathInsertBetweenToggle')?.addEventListener('change', e => {
      this.motionPathEditor.insertBetweenPoints = !!e.target.checked;
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathDeletePrimitive')?.addEventListener('pointerdown', e => e.stopPropagation());
    document.getElementById('motionPathDeletePrimitive')?.addEventListener('click', () => this._deleteSelectedMotionPathPrimitive());
    document.getElementById('motionPathSelectedName')?.addEventListener('input', e => {
      const selectedGroup = this._getSelectedMotionPathGroup();
      if (selectedGroup?.groupKind === 'radial') {
        const name = _normalizeMotionPathGroupName(e.target.value, `Radial ${selectedGroup.groupId}`);
        this._getMotionPathGroupMembers(selectedGroup.groupId).forEach((path, index) => {
          path.groupName = name;
          path.name = `${name} · Line ${index + 1}`;
        });
        this._markMotionPathDocumentUpdated();
        this._syncMotionPathUI();
        return;
      }
      const selected = this._getSelectedMotionPathPrimitive();
      if (!selected) return;
      selected.name = String(e.target.value || '').slice(0, 40);
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathSelectedAgentCount')?.addEventListener('input', e => {
      const selected = this._getSelectedMotionPathPrimitive();
      if (!selected) return;
      selected.agentCount = Math.max(0, Math.round(+e.target.value || 0));
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathSelectedPointStampScale')?.addEventListener('input', e => {
      const point = this._getSelectedMotionPathPoint();
      if (!point) return;
      point.stampScale = _roundMotionPathPointStampScale(+e.target.value || 1);
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathSelectedPointSpeedScale')?.addEventListener('input', e => {
      const point = this._getSelectedMotionPathPoint();
      if (!point) return;
      point.speedScale = _roundMotionPathPointSpeedScale(Number(e.target.value));
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathSelectedEndBehavior')?.addEventListener('change', e => {
      const selected = this._getSelectedMotionPathPrimitive();
      if (!selected) return;
      selected.endBehavior = _normalizeMotionPathEndBehavior(e.target.value);
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathSelectedStartMode')?.addEventListener('change', e => {
      const selected = this._getSelectedMotionPathPrimitive();
      if (!selected) return;
      selected.startMode = _normalizeMotionPathStartMode(e.target.value);
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathSelectedClosed')?.addEventListener('change', e => {
      const selected = this._getSelectedMotionPathPrimitive();
      if (!selected || (selected.kind !== 'polyline' && selected.kind !== 'bezier')) return;
      selected.closed = !!e.target.checked;
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathSelectedRadialCount')?.addEventListener('input', e => {
      const selectedGroup = this._getSelectedMotionPathGroup();
      if (selectedGroup?.groupKind === 'radial') {
        this._updateMotionPathRadialGroup(selectedGroup.groupId, { radialCount: +e.target.value });
        this._markMotionPathDocumentUpdated();
        this._syncMotionPathUI();
        return;
      }
      const selected = this._getSelectedMotionPathPrimitive();
      if (!selected || selected.kind !== 'radial') return;
      selected.radialCount = _normalizeMotionPathRadialCount(+e.target.value);
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    document.getElementById('motionPathSelectedRadialSpread')?.addEventListener('input', e => {
      const selectedGroup = this._getSelectedMotionPathGroup();
      if (selectedGroup?.groupKind === 'radial') {
        this._updateMotionPathRadialGroup(selectedGroup.groupId, { radialSpread: +e.target.value });
        this._markMotionPathDocumentUpdated();
        this._syncMotionPathUI();
        return;
      }
      const selected = this._getSelectedMotionPathPrimitive();
      if (!selected || selected.kind !== 'radial') return;
      selected.radialSpread = _normalizeMotionPathRadialSpread(+e.target.value);
      this._markMotionPathDocumentUpdated();
      this._syncMotionPathUI();
    });
    const overlayControls = this._getMotionPathEditorOverlayControls();
    overlayControls?.addEventListener('pointerdown', e => e.stopPropagation());
    overlayControls?.addEventListener('click', e => {
      const button = e.target instanceof HTMLElement ? e.target.closest('button[data-kind][data-path-id]') : null;
      if (!button) return;
      e.preventDefault();
      e.stopPropagation();
      const pathId = button.dataset.pathId;
      if (!pathId) return;
      if (button.dataset.kind === 'direction') {
        this._cycleMotionPathDirectionMode(pathId);
        return;
      }
      if (button.dataset.kind === 'start') {
        this._cycleMotionPathStartMode(pathId);
        return;
      }
      if (button.dataset.kind === 'behavior') {
        const hostRect = overlayControls.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        this._openMotionPathOverlayEndBehaviorSelect(
          pathId,
          buttonRect.left - hostRect.left + (buttonRect.width * 0.5),
          buttonRect.bottom - hostRect.top + 8,
        );
      }
    });
    const overlayEndBehaviorSelect = this._getMotionPathOverlayEndBehaviorSelect();
    overlayEndBehaviorSelect?.addEventListener('pointerdown', e => e.stopPropagation());
    overlayEndBehaviorSelect?.addEventListener('change', e => {
      const select = e.currentTarget;
      const pathId = Math.round(+(select?.dataset?.pathId || 0));
      const doc = this._getActiveMotionPathDocument();
      const path = doc?.paths?.find(entry => entry.id === pathId);
      if (!path) return;
      path.endBehavior = _normalizeMotionPathEndBehavior(select.value);
      this._markMotionPathDocumentUpdated(doc);
      this._syncMotionPathUI();
      this._hideMotionPathOverlayEndBehaviorSelect();
    });
    overlayEndBehaviorSelect?.addEventListener('blur', () => {
      this._hideMotionPathOverlayEndBehaviorSelect();
    });
    const motionPathCanvas = document.getElementById('motionPathEditorCanvas');
    motionPathCanvas?.addEventListener('pointerdown', e => this._onMotionPathEditorPointerDown(e));
    motionPathCanvas?.addEventListener('pointermove', e => this._onMotionPathEditorPointerMove(e));
    motionPathCanvas?.addEventListener('pointerup', e => this._onMotionPathEditorPointerUp(e));
    motionPathCanvas?.addEventListener('pointercancel', e => this._onMotionPathEditorPointerUp(e));
    motionPathCanvas?.addEventListener('lostpointercapture', e => this._onMotionPathEditorPointerUp(e));
    motionPathCanvas?.addEventListener('wheel', e => this._onMotionPathEditorWheel(e), { passive: false });
    motionPathCanvas?.addEventListener('contextmenu', e => e.preventDefault());
  }

  _initTopbarOverflow() {
    const topbar = document.getElementById('topbar');
    const menu = document.getElementById('topbarOverflowMenu');
    const toggle = document.getElementById('topbarOverflowToggle');
    if (!topbar || !menu || !toggle) return;

    // Capture the initial ordered children and insert comment placeholders to
    // track original positions so items can be returned in the right order.
    const items = Array.from(topbar.children).map(node => {
      const placeholder = document.createComment('tbof');
      node.before(placeholder);
      return { node, placeholder };
    });

    // Use let so that closeMenu and the dismiss handlers can mutually reference
    // each other without temporal-dead-zone issues.
    let onDocClick, onDocKeydown;
    // Track whether dismiss listeners are currently attached to avoid
    // unconditional removeEventListener calls before the menu has ever opened.
    let dismissBound = false;

    const closeMenu = (returnFocus = false) => {
      const wasOpen = menu.classList.contains('open');
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      if (dismissBound) {
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onDocKeydown);
        dismissBound = false;
      }
      // Return focus to the caret toggle when the menu was closed by user action
      // and focus was inside the menu (e.g. Escape key or outside click).
      if (returnFocus && wasOpen && menu.contains(document.activeElement)) {
        toggle.focus();
      }
    };
    this._closeTopbarOverflowMenu = closeMenu;

    // Check the click target instead of stopping propagation on the menu so
    // that events inside the menu can still bubble normally to their ancestors.
    onDocClick = e => { if (!menu.contains(e.target) && e.target !== toggle) closeMenu(true); };
    onDocKeydown = e => { if (e.key === 'Escape') closeMenu(true); };

    let layoutPending = false;
    const layout = () => {
      if (layoutPending) return;
      layoutPending = true;
      requestAnimationFrame(() => {
        layoutPending = false;

        // 1. Return all overflowed items back to topbar (in original order).
        for (const item of items) {
          if (item.node.parentElement !== topbar) {
            item.placeholder.after(item.node);
          }
        }
        closeMenu();

        // 2. Reset any separator display overrides from the previous layout pass.
        topbar.querySelectorAll('.tb-sep').forEach(s => { s.style.display = ''; });

        // 2.5. Keep explicit overflow-only items in the menu even when the topbar fits.
        for (const item of items) {
          if (!item.node.classList.contains('tb-prefer-overflow')) continue;
          if (item.node.style.display === 'none') continue;
          menu.append(item.node);
        }

        // 3. Move trailing items into the menu until the topbar fits.
        //    Skip items that are hidden by app logic (display:none) — they
        //    don't contribute to overflow width and should stay in the topbar
        //    so that show/hide toggling by app code continues to work.
        for (let i = items.length - 1; i >= 0; i--) {
          if (topbar.scrollWidth <= topbar.clientWidth) break;
          const item = items[i];
          if (item.node.classList.contains('topbar-essential')) continue;
          if (item.node.style.display === 'none') continue;
          menu.prepend(item.node);
        }

        // 4. Hide orphan separators at the visible boundaries of #topbar.
        const tbVisible = Array.from(topbar.childNodes)
          .filter(n => n.nodeType === Node.ELEMENT_NODE &&
                       getComputedStyle(n).display !== 'none');
        // Trailing separators
        for (let i = tbVisible.length - 1; i >= 0; i--) {
          if (tbVisible[i].classList.contains('tb-sep')) tbVisible[i].style.display = 'none';
          else break;
        }
        // Leading separators
        for (let i = 0; i < tbVisible.length; i++) {
          if (tbVisible[i].classList.contains('tb-sep')) tbVisible[i].style.display = 'none';
          else break;
        }

        // 5. Show the caret only when there are overflow items.
        const hasOverflow = menu.children.length > 0;
        toggle.hidden = !hasOverflow;
        if (!hasOverflow) closeMenu();
      });
    };
    this._layoutTopbarOverflow = layout;

    // Caret click — open/close the menu and position it under the toggle button.
    // stopPropagation prevents the toggle's own click from reaching onDocClick
    // which is attached to the document and would immediately close the menu.
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      const r = toggle.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.right = (window.innerWidth - r.right) + 'px';
      const isOpen = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      // Add dismiss listeners only while the menu is open, so they don't fire
      // on every click/keydown throughout the rest of the application lifetime.
      if (isOpen) {
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onDocKeydown);
        dismissBound = true;
        // Move focus to the first focusable item in the menu for keyboard users.
        const firstFocusable = menu.querySelector(
          'button:not([hidden]):not([disabled]), input:not([hidden]):not([disabled]), select:not([hidden]):not([disabled])'
        );
        firstFocusable?.focus();
      } else {
        closeMenu();
      }
    });

    // Re-run layout on window resize, orientation change, and whenever
    // #topbar itself changes size (e.g. after show/hide of conditional buttons).
    window.addEventListener('resize', layout);
    window.addEventListener('orientationchange', layout);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(layout).observe(topbar);
    }

    layout();
  }

  _getEventCoords(e) {
    // Get coords relative to the canvas area (not the transformed canvas)
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const sx = e.clientX - areaRect.left;
    const sy = e.clientY - areaRect.top;
    // Convert from screen space (post-transform) to canvas space
    return this._screenToCanvas(sx, sy);
  }

  _getCanvasViewMetrics() {
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const workspaceW = Math.max(1, this.W || 1);
    const workspaceH = Math.max(1, this.H || 1);
    const docW = Math.max(1, this._docW || workspaceW);
    const docH = Math.max(1, this._docH || workspaceH);
    const docOffsetX = Math.max(0, Math.round((workspaceW - docW) / 2));
    const docOffsetY = Math.max(0, Math.round((workspaceH - docH) / 2));
    return {
      areaRect,
      baseX: (areaRect.width - workspaceW) / 2,
      baseY: (areaRect.height - workspaceH) / 2,
      centerX: workspaceW / 2,
      centerY: workspaceH / 2,
      workspaceW,
      workspaceH,
      docW,
      docH,
      docOffsetX,
      docOffsetY,
    };
  }

  _screenToCanvas(sx, sy) {
    const { baseX, baseY, centerX, centerY } = this._getCanvasViewMetrics();

    // Undo translate(base + pan) and the canvas-center pivot translation.
    let dx = sx - baseX - this.viewPanX - centerX;
    let dy = sy - baseY - this.viewPanY - centerY;
    // Undo rotate(rot)
    const cos = Math.cos(-this.viewRotation);
    const sin = Math.sin(-this.viewRotation);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    // Undo scale(zoom)
    let ux = rx / this.viewZoom;
    let uy = ry / this.viewZoom;
    // Undo scaleX(flip)
    if (this.viewFlipped) ux = -ux;
    return { x: ux + centerX, y: uy + centerY };
  }

  _setViewPanForScreenAnchor(canvasX, canvasY, screenX, screenY) {
    const { baseX, baseY, centerX, centerY } = this._getCanvasViewMetrics();
    let offsetX = canvasX - centerX;
    const offsetY = canvasY - centerY;
    if (this.viewFlipped) offsetX = -offsetX;
    offsetX *= this.viewZoom;
    const scaledOffsetY = offsetY * this.viewZoom;
    const cos = Math.cos(this.viewRotation);
    const sin = Math.sin(this.viewRotation);
    const rx = offsetX * cos - scaledOffsetY * sin;
    const ry = offsetX * sin + scaledOffsetY * cos;
    this.viewPanX = screenX - baseX - centerX - rx;
    this.viewPanY = screenY - baseY - centerY - ry;
  }

  /** Extract stylus tilt/azimuth from a PointerEvent and store on this App */
  _captureTilt(e) {
    const prevAz = this.azimuth;
    this.penEventHasAngles = false;
    this.tiltX = e.tiltX || 0;
    this.tiltY = e.tiltY || 0;
    // Prefer the direct azimuthAngle/altitudeAngle (Safari/WebKit on iPad)
    if (typeof e.azimuthAngle === 'number') {
      this.azimuth = e.azimuthAngle;
      this.altitude = typeof e.altitudeAngle === 'number' ? e.altitudeAngle : Math.PI / 2;
      this.penEventHasAngles = true;
      this.penAngleSampleValid = true;
      this.penAngleSource = 'azimuthAngle';
    } else if (this.tiltX !== 0 || this.tiltY !== 0) {
      // Compute azimuth from tiltX/tiltY (Pointer Events Level 2 fallback)
      const tx = this.tiltX * Math.PI / 180;
      const ty = this.tiltY * Math.PI / 180;
      this.azimuth = Math.atan2(Math.tan(ty), Math.tan(tx));
      if (this.azimuth < 0) this.azimuth += Math.PI * 2;
      // Approximate altitude from tilt magnitude
      const tiltMag = Math.sqrt(tx * tx + ty * ty);
      this.altitude = Math.max(0, Math.PI / 2 - tiltMag);
      this.penEventHasAngles = true;
      this.penAngleSampleValid = true;
      this.penAngleSource = 'tilt';
    } else {
      // Pen is vertical or no tilt data — leave previous values
      this.penAngleSource = 'none';
    }

    // Track azimuth change per processed pen event for live diagnostics.
    let diff = this.azimuth - prevAz;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.prevAzimuth = prevAz;
    this.azimuthDeltaDeg = diff * 180 / Math.PI;
    if (Math.abs(this.azimuthDeltaDeg) > 0.01) this.azimuthUpdateCount++;
  }

  _onPointerRawUpdate(e) {
    if ((e.pointerType || '') !== 'pen') return;
    this.pointerType = 'pen';
    this._captureTilt(e);
  }

  getCurrentPenAngle() {
    if (this.pointerType !== 'pen') return null;
    if (!this.penAngleSampleValid || !Number.isFinite(this.azimuth)) return null;
    return this.azimuth;
  }

  resolveStrokeAngle(pathAngle, options = {}) {
    const fallbackAngle = Number.isFinite(options.fallbackAngle) ? options.fallbackAngle : 0;
    const mode = options.mode || this._cachedP?.strokeAngleMode || this.getP().strokeAngleMode || 'auto';
    const penAngle = this.getCurrentPenAngle();
    if (mode === 'path') {
      return Number.isFinite(pathAngle) ? pathAngle : fallbackAngle;
    }
    if (Number.isFinite(penAngle)) {
      return penAngle;
    }
    if (Number.isFinite(pathAngle)) {
      return pathAngle;
    }
    return fallbackAngle;
  }

  _onPointerDown(e) {
    e.preventDefault();
    // Track active pointers for multi-touch detection
    this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.pointerType = e.pointerType || 'mouse';
    // Don't start drawing during pinch gesture
    if (this._pinchActive) return;
    // Don't start drawing if touch and multiple pointers (pinch incoming)
    if (e.pointerType === 'touch' && this._activePointers.size > 1) return;

    this.interactionCanvas.setPointerCapture(e.pointerId);
    const { x, y } = this._getEventCoords(e);
    this._captureTilt(e);
    if (this._handleSimulationPointerDown(x, y)) return;
    if (this._handleSymmetryPointerDown(x, y, e)) return;
    // Move selection by dragging inside it (works in any tool mode)
    if (this.selectionMgr?.active && !this.selectionMgr.transformActive) {
      if (this.selectionMgr.moveOnDown(x, y)) {
        // Lift pixels from the layer on first move (noop if already floating)
        if (!this.selectionMgr._floatingPixels) {
          const l = this.getActiveLayer();
          this.pushUndo();
          this.selectionMgr.liftPixels(l.ctx, l.canvas, this.DPR);
          l.dirty = true;
          this.compositeAllLayers();
        }
        return;
      }
    }
    // Transform tool dispatch - check for handle drag (resize or move)
    if (this.activeTool === 'transform' && this.selectionMgr?.transformActive) {
      if (this.selectionMgr.transformOnDown(x, y)) {
        // Lift pixels from the layer on first transform drag (noop if already floating)
        if (!this.selectionMgr._floatingPixels) {
          const l = this.getActiveLayer();
          this.pushUndo();
          this.selectionMgr.liftPixels(l.ctx, l.canvas, this.DPR);
          l.dirty = true;
          this.compositeAllLayers();
        }
        return;
      }
    }
    // Fill tool dispatch
    if (this.activeTool === 'fill') {
      this._floodFill(x, y);
      return;
    }
    // Eyedropper tool dispatch
    if (this.activeTool === 'eyedropper') {
      this._pickColor(x, y);
      return;
    }
    // Selection tool dispatch - click outside selection starts a new one
    if (this.activeTool !== 'brush') {
      this._commitFloatingPixels(); // stamp any floating pixels before new selection
      this.selectionMgr.onDown(x, y);
      return;
    }
    // Reset EMA pressure at stroke start for immediate response
    this._rawPressure = e.pressure || 0.5;
    this.pressure = this._rawPressure;
    this._stabX = x;
    this._stabY = y;
    this.isDrawing = true;
    this.undoPushedThisStroke = false;
    this.isTapering = false;
    this.strokeFrame = 0;
    const p = this.getP();
    this._beginSymmetryStroke(x, y, p);
    this._resetStrokeWaveState();
    const waveStart = this._applyStrokeWavePoint(x, y, p, { reset: true });
    this.leaderX = waveStart.x;
    this.leaderY = waveStart.y;

    const brush = this.getCurrentBrush();
    if (brush) brush.onDown(this.leaderX, this.leaderY, this.pressure);
  }

  _onPointerMove(e) {
    this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.pointerType = e.pointerType || 'mouse';
    // Track cursor position for brush size preview
    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    this._cursorX = e.clientX - areaRect.left;
    this._cursorY = e.clientY - areaRect.top;
    // Don't draw during pinch
    if (this._pinchActive) return;
    const simCoords = this._getEventCoords(e);
    if (this._handleSimulationPointerMove(simCoords.x, simCoords.y)) return;
    if (this._handleSymmetryPointerMove(simCoords.x, simCoords.y)) return;
    // Move-drag dispatch (any tool mode)
    if (this.selectionMgr?._isMoving) {
      const { x, y } = this._getEventCoords(e);
      this.selectionMgr.moveOnMove(x, y);
      return;
    }
    // Transform tool dispatch
    if (this.activeTool === 'transform' && this.selectionMgr?._transformHandle) {
      const { x, y } = this._getEventCoords(e);
      this.selectionMgr.transformOnMove(x, y);
      return;
    }
    if (this.activeTool !== 'brush') {
      if (this.selectionMgr?._isDragging) {
        const { x, y } = this._getEventCoords(e);
        this.selectionMgr.onMove(x, y);
      }
      return;
    }
    if (!this.isDrawing) {
      const { x, y } = this._getEventCoords(e);
      this._rawPressure = e.pressure || 0.5;
      this.pressure += (this._rawPressure - this.pressure) * PRESSURE_SMOOTH_ALPHA;
      this._captureTilt(e);
      this.leaderX = x;
      this.leaderY = y;
      // Notify brush of hover for Apple Pencil hover preview/spawn
      // Skip during taper — hover would clear the tapering boids
      if (!this.isTapering && !(this.simulation.enabled && this._isMotionBrush())) {
        const brush = this.getCurrentBrush();
        if (brush && brush.onHover) brush.onHover(x, y);
      }
      return;
    }

    const brush = this.getCurrentBrush();
    const p = this.getP();
    const stab = p.stabilizer || 0;
    // Use coalesced events for smoother brush strokes (sub-frame input samples)
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [e];
    for (const pe of events) {
      const { x, y } = this._getEventCoords(pe);
      this._rawPressure = pe.pressure || 0.5;
      this.pressure += (this._rawPressure - this.pressure) * PRESSURE_SMOOTH_ALPHA;
      this._captureTilt(pe);

      // Apply stabilizer (lazy mouse)
      if (stab > 0) {
        const alpha = 1 - stab * 0.95; // keeps min 5% responsiveness at max stabilizer
        this._stabX += (x - this._stabX) * alpha;
        this._stabY += (y - this._stabY) * alpha;
        const wavePoint = this._applyStrokeWavePoint(this._stabX, this._stabY, p);
        this.leaderX = wavePoint.x;
        this.leaderY = wavePoint.y;
        if (brush) brush.onMove(this.leaderX, this.leaderY, this.pressure);
      } else {
        const wavePoint = this._applyStrokeWavePoint(x, y, p);
        this.leaderX = wavePoint.x;
        this.leaderY = wavePoint.y;
        if (brush) brush.onMove(this.leaderX, this.leaderY, this.pressure);
      }
    }
  }

  _onPointerUp(e) {
    this._activePointers.delete(e.pointerId);
    if (this._handleSimulationPointerUp()) return;
    if (this._handleSymmetryPointerUp()) return;
    // Move-drag end (any tool mode) — keep pixels floating
    if (this.selectionMgr?._isMoving) {
      this.selectionMgr.moveOnUp();
      return;
    }
    // Transform tool dispatch — keep pixels floating
    if (this.activeTool === 'transform' && this.selectionMgr?._transformHandle) {
      this.selectionMgr.transformOnUp();
      return;
    }
    // Selection tool dispatch
    if (this.activeTool !== 'brush') {
      if (this.selectionMgr?._isDragging) {
        const { x, y } = this._getEventCoords(e);
        this.selectionMgr.onUp(x, y);
      }
      return;
    }
    if (!this.isDrawing) return;
    this.isDrawing = false;
    const { x, y } = this._getEventCoords(e);

    const brush = this.getCurrentBrush();
    const p = this.getP();
    const waveActive = (p.strokeWaveType || 'none') !== 'none' && (p.strokeWaveAmplitude || 0) > 0;
    if (waveActive) {
      const stab = p.stabilizer || 0;
      let baseX = x;
      let baseY = y;
      if (stab > 0) {
        const alpha = 1 - stab * 0.95;
        this._stabX += (x - this._stabX) * alpha;
        this._stabY += (y - this._stabY) * alpha;
        baseX = this._stabX;
        baseY = this._stabY;
      }
      const wavePoint = this._applyStrokeWavePoint(baseX, baseY, p);
      this.leaderX = wavePoint.x;
      this.leaderY = wavePoint.y;
      if (brush) brush.onUp(this.leaderX, this.leaderY);
    } else if (brush) {
      brush.onUp(x, y);
    }
    this._resetStrokeWaveState();

    this._recordColor(this.primaryEl.value);
    this.recordLastChangeMarker('Stroke');

    // Start taper if configured
    if (p.taperLength > 0) {
      this.isTapering = true;
      this.taperFrame = 0;
      this.taperTotal = p.taperLength;
    } else {
      this._clearSymmetryStrokeState();
    }
  }

  _onPointerLeave(e) {
    // Clear hover state when a hover-capable pointer leaves canvas.
    // Touch has no hover phase, so letting pointerleave run unhover logic after
    // touch-up would incorrectly override the configured untouch action.
    if (this.isDrawing) return;
    if ((e.pointerType || this.pointerType) === 'touch') return;
    const brush = this.getCurrentBrush();
    if (brush && brush.onHoverEnd) brush.onHoverEnd();
  }

  _resetStrokeWaveState() {
    this._strokeWave.active = false;
    this._strokeWave.lastBaseX = Number.NaN;
    this._strokeWave.lastBaseY = Number.NaN;
    this._strokeWave.distance = 0;
    this._strokeWave.tangentX = 1;
    this._strokeWave.tangentY = 0;
  }

  _applyStrokeWavePoint(baseX, baseY, p = this.getP(), { reset = false } = {}) {
    const state = this._strokeWave;
    if (!state) return { x: baseX, y: baseY };

    if (reset || !state.active) {
      state.active = true;
      state.lastBaseX = baseX;
      state.lastBaseY = baseY;
      state.distance = 0;
      state.tangentX = 1;
      state.tangentY = 0;
    } else {
      const dx = baseX - state.lastBaseX;
      const dy = baseY - state.lastBaseY;
      const stepDistance = Math.hypot(dx, dy);
      if (stepDistance > 1e-3) {
        state.distance += stepDistance;
        state.tangentX = dx / stepDistance;
        state.tangentY = dy / stepDistance;
      }
      state.lastBaseX = baseX;
      state.lastBaseY = baseY;
    }

    const waveType = String(p?.strokeWaveType || 'none');
    const amplitude = Math.max(0, Number(p?.strokeWaveAmplitude) || 0);
    if (waveType === 'none' || amplitude <= 0) {
      return { x: baseX, y: baseY, baseX, baseY, tangentX: state.tangentX, tangentY: state.tangentY, normalX: -state.tangentY, normalY: state.tangentX };
    }

    const wavelength = Math.max(1, Number(p?.strokeWaveLength) || 1);
    const phase = (state.distance / wavelength) * Math.PI * 2 + (Number(p?.strokeWavePhase) || 0);
    let waveValue = 0;
    switch (waveType) {
      case 'sine':
      default:
        waveValue = Math.sin(phase);
        break;
    }
    const normalX = -state.tangentY;
    const normalY = state.tangentX;
    return {
      x: baseX + normalX * waveValue * amplitude,
      y: baseY + normalY * waveValue * amplitude,
      baseX,
      baseY,
      tangentX: state.tangentX,
      tangentY: state.tangentY,
      normalX,
      normalY,
    };
  }

  _onKeyDown(e) {
    const target = e.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      const isEditableField = !target.disabled && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
      if (target.isContentEditable || isEditableField) return;
    }
    if (this.motionPath?.editorOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.motionPathEditor?.insertPointMode) {
          this._setMotionPathInsertPointMode(false);
          return;
        }
        if (this._getMotionPathEditorCreateKind()) {
          this._setMotionPathEditorTool('select');
          return;
        }
        this._closeMotionPathEditor();
      } else if (e.key === 'Enter' && this._getMotionPathEditorCreateKind()) {
        e.preventDefault();
        this._setMotionPathEditorTool('select');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        this._copySelectedMotionPathPrimitives();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        this._pasteMotionPathPrimitives();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this._duplicateSelectedMotionPathPrimitives();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this._selectAllMotionPathPrimitives();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this._deleteSelectedMotionPathPrimitive();
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        this._setMotionPathEditorTool('select');
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        this._setMotionPathEditorTool('delete');
      }
      return;
    }
    // Ctrl+N = new canvas / canvas size
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); this._showCanvasSizeModal(); return; }
    // Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo
    if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); this.doUndoSimulationGuide(); }
    if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); this.doRedoSimulationGuide(); }
    // Ctrl+S = save image
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.saveImage(); }
    const hasSelectedSimulationItem = !!(this.simulation.enabled && this._getSelectedSimulationEntry());
    const canPasteSimulationItem = !!(this.simulation.enabled && this._canPasteSimulationClipboard());
    // Ctrl+C = copy simulation item or canvas selection to clipboard
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      if (hasSelectedSimulationItem) this._copySelectedSimulationItem();
      else this.copyToClipboard();
    }
    // Ctrl+X = cut simulation item or canvas selection
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      e.preventDefault();
      if (hasSelectedSimulationItem) this._cutSelectedSimulationItem();
      else this.cutToClipboard();
      return;
    }
    // Ctrl+V = paste simulation item or canvas clipboard
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      if (canPasteSimulationItem) this._pasteSimulationClipboardItem();
      else this.pasteFromClipboard();
    }
    // Escape = deselect
    if (e.key === 'Escape') this.deselect();
    // M = rectangle select, L = lasso select, T = transform
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (e.key === 'm' || e.key === 'M') { this.setTool('rect-select'); return; }
      if (e.key === 'l' || e.key === 'L') { this.setTool('lasso-select'); return; }
      if (e.key === 'g' || e.key === 'G') { this.setTool('fill'); return; }
      if (e.key === 'e' || e.key === 'E') { this.setTool('eyedropper'); return; }
      if (e.key === 't' || e.key === 'T') { this._toggleTransform(); return; }
    }
    // 0 = reset view
    if (e.key === '0' && !e.ctrlKey && !e.metaKey) this.resetView();
    // [ / ] = decrease / increase brush size
    if (e.key === '[') this._adjustBrushSize(-1);
    if (e.key === ']') this._adjustBrushSize(1);
    // F = flip canvas view
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
      this.flipView();
    }
    // P = toggle tiling mode
    if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey) {
      this.toggleTiling();
      return;
    }
    // X = swap colors (non-ctrl; Ctrl+X is cut)
    if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey) {
      this.swapPaintColors();
    }
    // / = toggle alpha lock on active layer
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.toggleAlphaLock();
    }
  }

  _adjustBrushSize(delta) {
    const slider = document.getElementById('stampSize');
    if (!slider) return;
    slider.value = Math.max(+slider.min, Math.min(+slider.max, +slider.value + delta));
    this.invalidateParams();
    const span = document.getElementById('v_stampSize');
    if (span) span.textContent = slider.value;
    this.showToast(`🖌 Brush size: ${slider.value}`);
  }

  // ========================================================
  // PINCH ZOOM / ROTATE / PAN (Touch Gestures)
  // ========================================================

  _onTouchStart(e) {
    if (e.touches.length === 2) {
      // Two-finger gesture: start pinch zoom/rotate
      e.preventDefault();
      this._pinchActive = true;
      // Cancel any active drawing
      if (this.isDrawing && !this.simulation.running) {
        this.isDrawing = false;
        const brush = this.getCurrentBrush();
        if (brush) brush.onUp(this.leaderX, this.leaderY);
      }
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      this._pinchStartDist = Math.sqrt(dx * dx + dy * dy);
      this._pinchStartAngle = Math.atan2(dy, dx);
      this._pinchStartZoom = this.viewZoom;
      this._pinchStartRotation = this.viewRotation;
      this._pinchStartPanX = this.viewPanX;
      this._pinchStartPanY = this.viewPanY;
      this._pinchStartMidX = (t0.clientX + t1.clientX) / 2;
      this._pinchStartMidY = (t0.clientY + t1.clientY) / 2;
      // Compute canvas point under pinch midpoint (to anchor zoom/rotate)
      const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
      this._pinchAnchor = this._screenToCanvas(
        this._pinchStartMidX - areaRect.left,
        this._pinchStartMidY - areaRect.top
      );
    }
  }

  _onTouchMove(e) {
    if (this._pinchActive && e.touches.length === 2) {
      e.preventDefault();
      this._forceVizCameraRuntime.lastManualInputAt = performance.now();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      // Zoom
      const scale = dist / this._pinchStartDist;
      this.viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._pinchStartZoom * scale));

      // Rotation
      this.viewRotation = this._pinchStartRotation + (angle - this._pinchStartAngle);

      // Pan: keep the canvas anchor point under the current pinch midpoint
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
      const curSX = midX - areaRect.left;
      const curSY = midY - areaRect.top;
      this._setViewPanForScreenAnchor(this._pinchAnchor.x, this._pinchAnchor.y, curSX, curSY);

      this._applyViewTransform();
    }
  }

  _onTouchEnd(e) {
    if (this._pinchActive && e.touches.length < 2) {
      this._pinchActive = false;
    }
  }

  _onWheel(e) {
    e.preventDefault();
    this._forceVizCameraRuntime.lastManualInputAt = performance.now();
    // Shift+scroll = rotate view
    if (e.shiftKey) {
      const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
      const mx = e.clientX - areaRect.left;
      const my = e.clientY - areaRect.top;
      const anchor = this._screenToCanvas(mx, my);
      const rotDelta = (e.deltaY > 0 ? 1 : -1) * WHEEL_ROTATION_DEG * Math.PI / 180;
      this.viewRotation += rotDelta;
      this._setViewPanForScreenAnchor(anchor.x, anchor.y, mx, my);
      this._applyViewTransform();
      return;
    }
    const zoomFactor = e.deltaY > 0 ? WHEEL_ZOOM_OUT : WHEEL_ZOOM_IN;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * zoomFactor));

    const areaRect = document.getElementById('canvasArea').getBoundingClientRect();
    const mx = e.clientX - areaRect.left;
    const my = e.clientY - areaRect.top;
    const anchor = this._screenToCanvas(mx, my);
    this.viewZoom = newZoom;
    this._setViewPanForScreenAnchor(anchor.x, anchor.y, mx, my);
    this._applyViewTransform();
  }

  _applyViewTransform() {
    const el = document.getElementById('canvasTransform');
    if (!el) return;
    const { baseX, baseY, centerX, centerY, docOffsetX, docOffsetY, docW, docH } = this._getCanvasViewMetrics();
    const deg = this.viewRotation * 180 / Math.PI;
    const flipScale = this.viewFlipped ? -1 : 1;
    el.style.width = this.W + 'px';
    el.style.height = this.H + 'px';
    el.style.transform = `translate(${baseX + this.viewPanX}px, ${baseY + this.viewPanY}px) translate(${centerX}px, ${centerY}px) rotate(${deg}deg) scale(${this.viewZoom}) scaleX(${flipScale}) translate(${-centerX}px, ${-centerY}px)`;
    if (this.canvasFrame) {
      this.canvasFrame.style.left = `${docOffsetX}px`;
      this.canvasFrame.style.top = `${docOffsetY}px`;
      this.canvasFrame.style.width = `${docW}px`;
      this.canvasFrame.style.height = `${docH}px`;
    }
    this._renderViewBookmarksPanel?.();
  }

  resetView() {
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.viewRotation = 0;
    this.viewFlipped = false;
    this._applyViewTransform();
    this.showToast('🔍 View reset');
  }

  flipView() {
    this.viewFlipped = !this.viewFlipped;
    this._applyViewTransform();
    this.showToast(this.viewFlipped ? '🪞 View flipped' : '🪞 View unflipped');
  }

  toggleTiling() {
    this.tilingMode = !this.tilingMode;
    this._syncTilingUI();
    this.showToast(this.tilingMode ? '🔁 Tiling: ON' : '🔁 Tiling: OFF');
  }

  _syncTilingUI() {
    const btn = document.getElementById('tilingBtn');
    if (btn) btn.classList.toggle('active', this.tilingMode);
  }

  _createPerformanceTelemetryState() {
    return {
      initialized: false,
      enabled: true,
      wakeLockPreferred: false,
      wakeLockActive: false,
      lastFrameAt: 0,
      frameCount: 0,
      slowFrameCount: 0,
      totalFrameMs: 0,
      totalBrushMs: 0,
      totalClearMs: 0,
      totalOverlayMs: 0,
      totalStatusMs: 0,
      renderSubmittedStamps: 0,
      renderEstimatedStamps: 0,
      renderFallbackCount: 0,
      renderBackendCounts: { webgpu: 0, webgl: 0, canvas: 0, legacy: 0 },
      lastRenderFallbackReason: '',
      worstFrameMs: 0,
      worstFramePhase: 'none',
      maxBrushMs: 0,
      maxClearMs: 0,
      maxOverlayMs: 0,
      maxStatusMs: 0,
      longTaskCount: 0,
      longTaskTotalMs: 0,
      throttleGapCount: 0,
      visibilityChanges: 0,
      focusLostCount: 0,
      pageHideCount: 0,
      freezeCount: 0,
      hiddenAt: 0,
      hiddenMs: 0,
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'visible',
      focused: typeof document !== 'undefined' ? document.hasFocus() : true,
      memoryMB: null,
      deviceMemoryGB: Number.isFinite(navigator?.deviceMemory) ? navigator.deviceMemory : null,
      hardwareConcurrency: Number.isFinite(navigator?.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
      recentEvents: [],
      lastUiRefreshAt: 0,
      observer: null,
      enabledEl: null,
      wakeLockEl: null,
      readoutEl: null,
    };
  }

  _resetPerformanceTelemetryStats() {
    const t = this._performanceTelemetry;
    t.lastFrameAt = 0;
    t.frameCount = 0;
    t.slowFrameCount = 0;
    t.totalFrameMs = 0;
    t.totalBrushMs = 0;
    t.totalClearMs = 0;
    t.totalOverlayMs = 0;
    t.totalStatusMs = 0;
    t.renderSubmittedStamps = 0;
    t.renderEstimatedStamps = 0;
    t.renderFallbackCount = 0;
    t.renderBackendCounts.webgpu = 0;
    t.renderBackendCounts.webgl = 0;
    t.renderBackendCounts.canvas = 0;
    t.renderBackendCounts.legacy = 0;
    t.lastRenderFallbackReason = '';
    t.worstFrameMs = 0;
    t.worstFramePhase = 'none';
    t.maxBrushMs = 0;
    t.maxClearMs = 0;
    t.maxOverlayMs = 0;
    t.maxStatusMs = 0;
    t.longTaskCount = 0;
    t.longTaskTotalMs = 0;
    t.throttleGapCount = 0;
    t.visibilityChanges = 0;
    t.focusLostCount = 0;
    t.pageHideCount = 0;
    t.freezeCount = 0;
    t.hiddenAt = document.visibilityState === 'hidden' ? performance.now() : 0;
    t.hiddenMs = 0;
    t.visibilityState = document.visibilityState;
    t.focused = document.hasFocus();
    t.memoryMB = null;
    t.recentEvents.length = 0;
    t.lastUiRefreshAt = 0;
  }

  _notePerformanceEvent(message) {
    const t = this._performanceTelemetry;
    const stamp = (performance.now() / 1000).toFixed(1) + 's';
    t.recentEvents.unshift(`${stamp} ${message}`);
    if (t.recentEvents.length > PERF_RECENT_EVENT_LIMIT) t.recentEvents.length = PERF_RECENT_EVENT_LIMIT;
  }

  _persistPerformancePreference(key, enabled) {
    try {
      localStorage.setItem(key, enabled ? '1' : '0');
    } catch { /* ignore persistence errors */ }
  }

  _loadPerformancePreference(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (value == null) return fallback;
      return value === '1';
    } catch {
      return fallback;
    }
  }

  _initPerformanceTelemetry() {
    const t = this._performanceTelemetry;
    if (t.initialized) return;
    t.initialized = true;
    t.enabled = this._loadPerformancePreference(PERF_TELEMETRY_KEY, true);
    t.wakeLockPreferred = this._loadPerformancePreference(PERF_WAKE_LOCK_KEY, false);
    this._resetPerformanceTelemetryStats();
    this._notePerformanceEvent('telemetry initialized');
    t.enabledEl = document.getElementById('perfTelemetryEnabled');
    t.wakeLockEl = document.getElementById('perfWakeLockEnabled');
    t.readoutEl = document.getElementById('perfTelemetryReadout');

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        t.observer = new PerformanceObserver(list => {
          if (!t.enabled) return;
          for (const entry of list.getEntries()) {
            t.longTaskCount++;
            t.longTaskTotalMs += entry.duration;
            this._notePerformanceEvent(`long task ${entry.duration.toFixed(1)}ms`);
          }
          this._refreshPerformanceTelemetryUI(true);
        });
        t.observer.observe({ entryTypes: ['longtask'] });
      } catch { /* unsupported */ }
    }

    document.addEventListener('visibilitychange', () => {
      t.visibilityChanges++;
      t.visibilityState = document.visibilityState;
      if (document.visibilityState === 'hidden') {
        t.hiddenAt = performance.now();
        this._releasePerformanceWakeLock();
        this._notePerformanceEvent('tab hidden');
      } else {
        if (t.hiddenAt) t.hiddenMs += performance.now() - t.hiddenAt;
        t.hiddenAt = 0;
        this._requestPerformanceWakeLock();
        this._notePerformanceEvent('tab visible');
      }
      this._refreshPerformanceTelemetryUI(true);
    });
    window.addEventListener('focus', () => {
      t.focused = true;
      this._requestPerformanceWakeLock();
      this._refreshPerformanceTelemetryUI(true);
    });
    window.addEventListener('blur', () => {
      t.focused = false;
      t.focusLostCount++;
      this._notePerformanceEvent('window blurred');
      this._refreshPerformanceTelemetryUI(true);
    });
    window.addEventListener('pagehide', () => {
      t.pageHideCount++;
      this._releasePerformanceWakeLock();
      this._notePerformanceEvent('page hidden by browser');
      this._refreshPerformanceTelemetryUI(true);
    });
    window.addEventListener('pageshow', () => {
      this._requestPerformanceWakeLock();
      this._notePerformanceEvent('page shown by browser');
      this._refreshPerformanceTelemetryUI(true);
    });
    document.addEventListener('freeze', () => {
      t.freezeCount++;
      this._notePerformanceEvent('page lifecycle freeze');
      this._refreshPerformanceTelemetryUI(true);
    });
    document.addEventListener('resume', () => {
      this._notePerformanceEvent('page lifecycle resume');
      this._requestPerformanceWakeLock();
      this._refreshPerformanceTelemetryUI(true);
    });

    this._requestPerformanceWakeLock();
    this._refreshPerformanceTelemetryUI(true);
  }

  setPerformanceTelemetryEnabled(enabled) {
    const t = this._performanceTelemetry;
    t.enabled = !!enabled;
    this._persistPerformancePreference(PERF_TELEMETRY_KEY, t.enabled);
    this._resetPerformanceTelemetryStats();
    this._notePerformanceEvent(t.enabled ? 'telemetry enabled' : 'telemetry disabled');
    this._refreshPerformanceTelemetryUI(true);
    this.showToast(t.enabled ? '📊 Perf telemetry enabled' : '📊 Perf telemetry disabled');
  }

  async setPerformanceWakeLockEnabled(enabled) {
    const t = this._performanceTelemetry;
    t.wakeLockPreferred = !!enabled;
    this._persistPerformancePreference(PERF_WAKE_LOCK_KEY, t.wakeLockPreferred);
    if (t.wakeLockPreferred) await this._requestPerformanceWakeLock();
    else await this._releasePerformanceWakeLock();
    this._refreshPerformanceTelemetryUI(true);
    this.showToast(t.wakeLockPreferred ? '🔆 Wake lock requested' : '🔆 Wake lock released');
  }

  async _requestPerformanceWakeLock() {
    const t = this._performanceTelemetry;
    if (!t.wakeLockPreferred || document.visibilityState !== 'visible' || !navigator.wakeLock) {
      t.wakeLockActive = false;
      return false;
    }
    if (this._wakeLockSentinel && !this._wakeLockSentinel.released) {
      t.wakeLockActive = true;
      return true;
    }
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      this._wakeLockSentinel = sentinel;
      t.wakeLockActive = true;
      sentinel.addEventListener('release', () => {
        if (this._wakeLockSentinel === sentinel) {
          this._wakeLockSentinel = null;
          t.wakeLockActive = false;
          this._refreshPerformanceTelemetryUI(true);
        }
      });
      this._notePerformanceEvent('screen wake lock acquired');
      return true;
    } catch (err) {
      t.wakeLockActive = false;
      this._notePerformanceEvent(`wake lock unavailable (${err?.name || 'error'})`);
      return false;
    } finally {
      this._refreshPerformanceTelemetryUI(true);
    }
  }

  async _releasePerformanceWakeLock() {
    const t = this._performanceTelemetry;
    const sentinel = this._wakeLockSentinel;
    this._wakeLockSentinel = null;
    t.wakeLockActive = false;
    if (!sentinel) return;
    try {
      await sentinel.release();
    } catch { /* already released */ }
  }

  _recordPerformanceFrame(frame) {
    const t = this._performanceTelemetry;
    if (!t.enabled) return;
    if (this._isPerformanceThrottleGap(frame)) {
      t.throttleGapCount++;
      this._notePerformanceEvent(`raf gap ${frame.deltaMs.toFixed(1)}ms`);
    }
    if (frame.hidden) {
      this._refreshPerformanceTelemetryUI();
      return;
    }
    t.frameCount++;
    t.totalFrameMs += frame.totalMs;
    t.totalBrushMs += frame.brushMs;
    t.totalClearMs += frame.clearMs;
    t.totalOverlayMs += frame.overlayMs;
    t.totalStatusMs += frame.statusMs;
    t.maxBrushMs = Math.max(t.maxBrushMs, frame.brushMs);
    t.maxClearMs = Math.max(t.maxClearMs, frame.clearMs);
    t.maxOverlayMs = Math.max(t.maxOverlayMs, frame.overlayMs);
    t.maxStatusMs = Math.max(t.maxStatusMs, frame.statusMs);
    if (frame.totalMs >= PERF_SLOW_FRAME_MS) {
      t.slowFrameCount++;
      const phases = [
        ['brush', frame.brushMs],
        ['overlay', frame.overlayMs],
        ['clear', frame.clearMs],
        ['status', frame.statusMs],
      ];
      phases.sort((a, b) => b[1] - a[1]);
      if (frame.totalMs > t.worstFrameMs) {
        t.worstFrameMs = frame.totalMs;
        t.worstFramePhase = phases[0][0];
      }
    }
    if (performance.memory?.usedJSHeapSize) {
      t.memoryMB = performance.memory.usedJSHeapSize / (1024 * 1024);
    }
    this._refreshPerformanceTelemetryUI();
  }

  recordBrushRenderTelemetry({ backend = 'legacy', submittedStamps = 0, renderedStampsEstimate = 0, fallbackReason = '' } = {}) {
    const t = this._performanceTelemetry;
    if (!t.enabled) return;
    const key = backend === 'webgpu' || backend === 'webgl' || backend === 'canvas' ? backend : 'legacy';
    t.renderBackendCounts[key] = (t.renderBackendCounts[key] || 0) + 1;
    t.renderSubmittedStamps += Math.max(0, submittedStamps | 0);
    t.renderEstimatedStamps += Math.max(0, renderedStampsEstimate | 0);
    if (fallbackReason) {
      t.renderFallbackCount++;
      if (fallbackReason !== t.lastRenderFallbackReason) {
        t.lastRenderFallbackReason = fallbackReason;
        this._notePerformanceEvent(`render fallback: ${fallbackReason}`);
      }
    }
    this._refreshPerformanceTelemetryUI();
  }

  _isPerformanceThrottleGap(frame) {
    const t = this._performanceTelemetry;
    return Number.isFinite(frame.deltaMs)
      && t.lastFrameAt
      && t.focused
      && t.visibilityState === 'visible'
      && frame.deltaMs >= PERF_THROTTLE_GAP_MS;
  }

  _refreshPerformanceTelemetryUI(force = false) {
    const t = this._performanceTelemetry;
    const now = performance.now();
    if (!force && now - t.lastUiRefreshAt < PERF_UI_REFRESH_MS) return;
    t.lastUiRefreshAt = now;
    const enabledEl = t.enabledEl;
    const wakeLockEl = t.wakeLockEl;
    const readoutEl = t.readoutEl;
    if (enabledEl) enabledEl.checked = !!t.enabled;
    if (wakeLockEl) wakeLockEl.checked = !!t.wakeLockPreferred;
    if (!readoutEl) return;
    if (!t.enabled) {
      readoutEl.textContent = 'Telemetry is off.';
      return;
    }
    const frameCount = Math.max(t.frameCount, 1);
    const avgFrame = t.totalFrameMs / frameCount;
    const fps = avgFrame > 0 ? 1000 / avgFrame : 0;
    const hiddenMs = t.hiddenMs + (t.hiddenAt ? performance.now() - t.hiddenAt : 0);
    const wakeLockState = t.wakeLockPreferred
      ? ` • wake ${t.wakeLockActive ? 'on' : 'waiting'}`
      : '';
    const lines = [
      `State: ${t.visibilityState}${t.focused ? ' • focused' : ' • blurred'}${wakeLockState}`,
      `Frames: ${t.frameCount} • avg ${avgFrame.toFixed(1)}ms • ~${fps.toFixed(0)}fps • slow ${t.slowFrameCount}`,
      `Attribution: brush ${(t.totalBrushMs / frameCount).toFixed(1)} • overlay ${(t.totalOverlayMs / frameCount).toFixed(1)} • clear ${(t.totalClearMs / frameCount).toFixed(1)} • status ${(t.totalStatusMs / frameCount).toFixed(1)} ms/frame`,
      `Render: submit ${t.renderSubmittedStamps} • est ${t.renderEstimatedStamps} • fb ${t.renderFallbackCount} • backends wg:${t.renderBackendCounts.webgpu} gl:${t.renderBackendCounts.webgl} c2d:${t.renderBackendCounts.canvas} cpu:${t.renderBackendCounts.legacy}`,
      `Worst: ${t.worstFrameMs.toFixed(1)}ms (${t.worstFramePhase}) • long tasks ${t.longTaskCount} (${t.longTaskTotalMs.toFixed(0)}ms) • raf gaps ${t.throttleGapCount}`,
      `Lifecycle: hidden ${(hiddenMs / 1000).toFixed(1)}s • vis ${t.visibilityChanges} • blur ${t.focusLostCount} • pagehide ${t.pageHideCount} • freeze ${t.freezeCount}`,
      `Device: ${t.hardwareConcurrency || '?'} cores • ${t.deviceMemoryGB || '?'}GB mem${t.memoryMB != null ? ` • heap ${t.memoryMB.toFixed(0)}MB` : ''}`,
    ];
    if (t.recentEvents.length) lines.push(`Recent: ${t.recentEvents.slice(0, 3).join(' | ')}`);
    readoutEl.textContent = lines.join('\n');
  }

  _getPerformanceStatusSummary() {
    const t = this._performanceTelemetry;
    if (!t.enabled || t.frameCount === 0) return '';
    const avgFrame = t.totalFrameMs / t.frameCount;
    const fps = avgFrame > 0 ? 1000 / avgFrame : 0;
    const activeSeconds = Math.max(0.001, t.totalFrameMs / 1000);
    const stampRate = t.renderEstimatedStamps / activeSeconds;
    const backendCounts = t.renderBackendCounts;
    let backend = 'cpu';
    if (backendCounts.webgpu >= backendCounts.webgl
      && backendCounts.webgpu >= backendCounts.canvas
      && backendCounts.webgpu >= backendCounts.legacy) {
      backend = 'wgpu';
    } else if (backendCounts.webgl >= backendCounts.canvas && backendCounts.webgl >= backendCounts.legacy) {
      backend = 'webgl';
    } else if (backendCounts.canvas >= backendCounts.legacy) {
      backend = 'c2d';
    }
    return `Perf ${fps.toFixed(0)}fps ${avgFrame.toFixed(1)}ms St:${stampRate.toFixed(0)}/s B:${backend} Fb:${t.renderFallbackCount} LT:${t.longTaskCount} Gap:${t.throttleGapCount}${t.wakeLockPreferred ? ` WL:${t.wakeLockActive ? 'on' : 'wait'}` : ''}`;
  }

  _buildPerformanceTelemetrySnapshot() {
    const t = this._performanceTelemetry;
    const frameCount = Math.max(t.frameCount, 1);
    return JSON.stringify({
      enabled: t.enabled,
      wakeLockPreferred: t.wakeLockPreferred,
      wakeLockActive: t.wakeLockActive,
      visibilityState: t.visibilityState,
      focused: t.focused,
      frames: t.frameCount,
      avgFrameMs: +(t.totalFrameMs / frameCount).toFixed(3),
      avgBrushMs: +(t.totalBrushMs / frameCount).toFixed(3),
      avgOverlayMs: +(t.totalOverlayMs / frameCount).toFixed(3),
      avgClearMs: +(t.totalClearMs / frameCount).toFixed(3),
      avgStatusMs: +(t.totalStatusMs / frameCount).toFixed(3),
      renderSubmittedStamps: t.renderSubmittedStamps,
      renderEstimatedStamps: t.renderEstimatedStamps,
      renderFallbackCount: t.renderFallbackCount,
      renderBackendCounts: t.renderBackendCounts,
      lastRenderFallbackReason: t.lastRenderFallbackReason,
      slowFrames: t.slowFrameCount,
      worstFrameMs: +t.worstFrameMs.toFixed(3),
      worstFramePhase: t.worstFramePhase,
      longTasks: t.longTaskCount,
      longTaskTotalMs: +t.longTaskTotalMs.toFixed(3),
      rafGaps: t.throttleGapCount,
      hiddenMs: +(t.hiddenMs + (t.hiddenAt ? performance.now() - t.hiddenAt : 0)).toFixed(3),
      visibilityChanges: t.visibilityChanges,
      blurCount: t.focusLostCount,
      pageHideCount: t.pageHideCount,
      freezeCount: t.freezeCount,
      memoryMB: t.memoryMB == null ? null : +t.memoryMB.toFixed(3),
      hardwareConcurrency: t.hardwareConcurrency,
      deviceMemoryGB: t.deviceMemoryGB,
      recentEvents: t.recentEvents,
    }, null, 2);
  }

  async copyPerformanceTelemetrySnapshot() {
    const snapshot = this._buildPerformanceTelemetrySnapshot();
    try {
      await navigator.clipboard.writeText(snapshot);
      this.showToast('📋 Perf snapshot copied');
    } catch {
      console.info(snapshot);
      this.showToast('📋 Perf snapshot logged to console');
    }
  }

  resetPerformanceTelemetry() {
    this._resetPerformanceTelemetryStats();
    this._notePerformanceEvent('telemetry reset');
    this._refreshPerformanceTelemetryUI(true);
    this.showToast('♻ Perf telemetry reset');
  }

  _captureCompositeDebugImageData() {
    return this.compositor?.captureImageData?.() || null;
  }

  _maskPreviewToDataUrl(imageData) {
    if (!imageData) return null;
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  _boundsToDebugObject(bounds) {
    if (!bounds || bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return null;
    return {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      width: bounds.maxX - bounds.minX + 1,
      height: bounds.maxY - bounds.minY + 1,
    };
  }

  captureEphemeralGhostDebug(options = {}) {
    const layer = this.getActiveLayer();
    if (!layer?.ctx?.canvas) return null;
    const width = layer.canvas.width;
    const height = layer.canvas.height;
    const alphaThreshold = Math.max(1, Math.min(64, Math.round(options.alphaThreshold ?? 24)));
    const diffThreshold = Math.max(1, Math.min(255, Math.round(options.diffThreshold ?? 8)));
    const originalVisible = layer.visible;

    const layerImage = layer.ctx.getImageData(0, 0, width, height);
    this.compositeAllLayers({ forceFull: true });
    const displayWith = this._captureCompositeDebugImageData();
    const flatWithCanvas = this._compositeFlatCanvas();
    const flatWith = flatWithCanvas.getContext('2d')?.getImageData(0, 0, width, height) || null;

    let displayWithout = null;
    let flatWithout = null;
    try {
      layer.visible = false;
      this.compositeAllLayers({ forceFull: true });
      displayWithout = this._captureCompositeDebugImageData();
      const flatWithoutCanvas = this._compositeFlatCanvas();
      flatWithout = flatWithoutCanvas.getContext('2d')?.getImageData(0, 0, width, height) || null;
    } finally {
      layer.visible = originalVisible;
      this.compositeAllLayers({ forceFull: true });
    }

    const layerMask = new ImageData(width, height);
    const flatMask = new ImageData(width, height);
    const displayMask = new ImageData(width, height);
    const displayOnlyMask = new ImageData(width, height);
    const summary = {
      activeLayer: {
        index: this.activeLayerIdx,
        name: layer.name || `Layer ${this.activeLayerIdx + 1}`,
        width,
        height,
      },
      thresholds: { alphaThreshold, diffThreshold },
      layerLowAlphaPixels: 0,
      flatGhostPixels: 0,
      displayGhostPixels: 0,
      displayOnlyGhostPixels: 0,
      displayGhostZeroAlphaPixels: 0,
      layerLowAlphaBounds: null,
      flatGhostBounds: null,
      displayGhostBounds: null,
      displayOnlyGhostBounds: null,
      boid: this.brushes?.boid?.getDebugState?.() || null,
    };
    const bounds = {
      layer: { minX: width, minY: height, maxX: -1, maxY: -1 },
      flat: { minX: width, minY: height, maxX: -1, maxY: -1 },
      display: { minX: width, minY: height, maxX: -1, maxY: -1 },
      displayOnly: { minX: width, minY: height, maxX: -1, maxY: -1 },
    };
    const updateBounds = (target, x, y) => {
      target.minX = Math.min(target.minX, x);
      target.minY = Math.min(target.minY, y);
      target.maxX = Math.max(target.maxX, x);
      target.maxY = Math.max(target.maxY, y);
    };
    const colorMaskPixel = (dest, offset, r, g, b, a = 255) => {
      dest[offset] = r;
      dest[offset + 1] = g;
      dest[offset + 2] = b;
      dest[offset + 3] = a;
    };
    const diffMagnitude = (withData, withoutData, offset) => {
      if (!withData || !withoutData) return 0;
      const dr = Math.abs(withData[offset] - withoutData[offset]);
      const dg = Math.abs(withData[offset + 1] - withoutData[offset + 1]);
      const db = Math.abs(withData[offset + 2] - withoutData[offset + 2]);
      const da = Math.abs(withData[offset + 3] - withoutData[offset + 3]);
      return Math.max(dr, dg, db, da);
    };

    const layerData = layerImage.data;
    const flatWithData = flatWith?.data || null;
    const flatWithoutData = flatWithout?.data || null;
    const displayWithData = displayWith?.data || null;
    const displayWithoutData = displayWithout?.data || null;
    for (let offset = 0; offset < layerData.length; offset += 4) {
      const pixelIndex = offset >> 2;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      const alpha = layerData[offset + 3];
      const isLayerLowAlpha = alpha > 0 && alpha <= alphaThreshold;
      const flatDiff = diffMagnitude(flatWithData, flatWithoutData, offset);
      const displayDiff = diffMagnitude(displayWithData, displayWithoutData, offset);
      const hasFlatGhost = flatDiff > diffThreshold && alpha <= alphaThreshold;
      const hasDisplayGhost = displayDiff > diffThreshold && alpha <= alphaThreshold;
      const compositorOnlyGhost = hasDisplayGhost && !hasFlatGhost;

      if (isLayerLowAlpha) {
        summary.layerLowAlphaPixels += 1;
        updateBounds(bounds.layer, x, y);
        colorMaskPixel(layerMask.data, offset, 255, 255, 255, Math.max(96, alpha));
      }
      if (hasFlatGhost) {
        summary.flatGhostPixels += 1;
        updateBounds(bounds.flat, x, y);
        colorMaskPixel(flatMask.data, offset, 80, 255, 80);
      }
      if (hasDisplayGhost) {
        summary.displayGhostPixels += 1;
        updateBounds(bounds.display, x, y);
        colorMaskPixel(displayMask.data, offset, 80, 220, 255);
        if (alpha === 0) summary.displayGhostZeroAlphaPixels += 1;
      }
      if (compositorOnlyGhost) {
        summary.displayOnlyGhostPixels += 1;
        updateBounds(bounds.displayOnly, x, y);
        colorMaskPixel(displayOnlyMask.data, offset, 255, 96, 96);
      }
    }

    summary.layerLowAlphaBounds = this._boundsToDebugObject(bounds.layer);
    summary.flatGhostBounds = this._boundsToDebugObject(bounds.flat);
    summary.displayGhostBounds = this._boundsToDebugObject(bounds.display);
    summary.displayOnlyGhostBounds = this._boundsToDebugObject(bounds.displayOnly);

    const result = {
      summary,
      previews: {
        layerLowAlpha: this._maskPreviewToDataUrl(layerMask),
        flatGhost: this._maskPreviewToDataUrl(flatMask),
        displayGhost: this._maskPreviewToDataUrl(displayMask),
        compositorOnlyGhost: this._maskPreviewToDataUrl(displayOnlyMask),
      },
    };
    this._ephemeralGhostDebug = result;
    console.info('Ephemeral ghost debug summary:', result.summary);
    return result;
  }

  showEphemeralGhostDebug(options = {}) {
    const result = this.captureEphemeralGhostDebug(options);
    if (!result || typeof document === 'undefined') return result;
    const summaryText = JSON.stringify(result.summary, null, 2);
    let panel = document.getElementById('ephemeralGhostDebugPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ephemeralGhostDebugPanel';
      panel.style.position = 'fixed';
      panel.style.right = '14px';
      panel.style.bottom = '54px';
      panel.style.width = '360px';
      panel.style.maxHeight = '70vh';
      panel.style.overflow = 'auto';
      panel.style.zIndex = '200';
      panel.style.background = 'rgba(8,10,16,0.95)';
      panel.style.color = '#eef3ff';
      panel.style.border = '1px solid rgba(255,255,255,0.18)';
      panel.style.borderRadius = '10px';
      panel.style.boxShadow = '0 12px 32px rgba(0,0,0,0.35)';
      panel.style.padding = '10px';
      panel.style.font = '12px/1.4 Consolas, monospace';
      panel.style.touchAction = 'auto';
      panel.style.webkitUserSelect = 'text';
      panel.style.userSelect = 'text';
      document.body.appendChild(panel);
    }
    const previewBlock = (title, dataUrl) => dataUrl
      ? `<div style="margin-top:10px"><div style="margin-bottom:4px;font-weight:700">${title}</div><img src="${dataUrl}" style="display:block;width:100%;height:auto;background:#111;border:1px solid rgba(255,255,255,0.1)"></div>`
      : '';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <strong>Ephemeral Ghost Debug</strong>
        <div style="display:flex;gap:6px">
          <button id="ephemeralGhostDebugCopy" type="button">Copy JSON</button>
          <button id="ephemeralGhostDebugClose" type="button">Close</button>
        </div>
      </div>
      <textarea id="ephemeralGhostDebugSummary" readonly spellcheck="false" style="display:block;width:100%;min-height:180px;margin:8px 0 0;padding:8px;border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:rgba(0,0,0,0.28);color:#eef3ff;font:12px/1.4 Consolas, monospace;white-space:pre;overflow:auto;resize:vertical;touch-action:auto;-webkit-user-select:text;user-select:text;cursor:text"></textarea>
      ${previewBlock('Layer low-alpha pixels', result.previews.layerLowAlpha)}
      ${previewBlock('Software composite ghost contribution', result.previews.flatGhost)}
      ${previewBlock('Displayed composite ghost contribution', result.previews.displayGhost)}
      ${previewBlock('Compositor-only contribution', result.previews.compositorOnlyGhost)}
    `;
    const summaryEl = panel.querySelector('#ephemeralGhostDebugSummary');
    if (summaryEl) summaryEl.value = summaryText;
    panel.querySelector('#ephemeralGhostDebugClose')?.addEventListener('click', () => this.clearEphemeralGhostDebugView());
    panel.querySelector('#ephemeralGhostDebugCopy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(summaryText);
        this.showToast('📋 Ghost debug copied');
      } catch {
        console.info(result.summary);
        this.showToast('📋 Ghost debug logged');
      }
    });
    return result;
  }

  clearEphemeralGhostDebugView() {
    document.getElementById('ephemeralGhostDebugPanel')?.remove();
    return true;
  }

  // ========================================================
  // FRAME LOOP
  // ========================================================

  _frameLoop() {
    const perf = this._performanceTelemetry.enabled ? this._performanceTelemetry : null;
    const frameStart = perf ? performance.now() : 0;
    const deltaMs = perf && perf.lastFrameAt ? frameStart - perf.lastFrameAt : 0;
    if (perf) perf.lastFrameAt = frameStart;
    if (document.visibilityState === 'hidden') {
      // Hidden tabs are browser-throttled anyway; skip the heavy frame work so
      // we do not keep behaving like a costly background tab.
      if (perf) this._recordPerformanceFrame({ deltaMs, totalMs: 0, brushMs: 0, clearMs: 0, overlayMs: 0, statusMs: 0, hidden: true });
      this._rafId = requestAnimationFrame(() => this._frameLoop());
      return;
    }
    const elapsed = (performance.now() - this._startTime) / 1000;
    const brush = this.getCurrentBrush();
    const p = this.getP();
    let brushMs = 0;
    let clearMs = 0;
    let overlayMs = 0;
    let statusMs = 0;

    // Taper pass — after stroke ends
    const brushStart = perf ? performance.now() : 0;
    if (this.isTapering && brush && brush.taperFrame) {
      this.taperFrame++;
      const t = this.taperFrame / this.taperTotal;
      if (t >= 1) {
        this.isTapering = false;
        this._clearSymmetryStrokeState();
      } else {
        brush.taperFrame(t, p);
      }
    }

    // Active brush frame (e.g. boid step)
    if (this.simulation.running) {
      this.simulation.frameCount += 1;
      const frameCounter = document.getElementById('simFrameCounter');
      if (frameCounter) frameCounter.textContent = this._formatSimulationFrameCounter();
      if (this._hasActiveMultiSessionPlayback()) {
        this._stepMultiSessionSimulation(elapsed, p);
      } else {
        this._updateSimulationLeader(elapsed, p);
        this._applySimulationEphemeralFade(p);
      }
    }
    if ((this.isDrawing || this.simulation.running) && brush && brush.onFrame && !this._hasActiveMultiSessionPlayback()) {
      brush.onFrame(elapsed);
      if (this.simulation.running && this.simulation.enabled && this.activeBrush === 'boid') {
        this._syncSimulationSavedPlaybackCapture(brush);
        // Force Visualization camera: resolves its target from the BoidBrush
        // transient snapshot brush.onFrame() just refreshed, then smooths
        // view state via the same _applyViewTransform() manual nav uses.
        this._applyForceVizCameraFrame(brush, elapsed);
        this._updateForceVizStatusText();
      }
    } else if (!this.isDrawing && !this.simulation.running && !this.isTapering && brush && brush.onHoverFrame) {
      // Step hover simulation (boid flocking / bristle physics) without stamping
      // Skip during taper — taperFrame already steps the sim
      brush.onHoverFrame(elapsed);
    }
    if (perf) brushMs = performance.now() - brushStart;

    // Update live overlay (particle visualization)
    const clearStart = perf ? performance.now() : 0;
    this.lctx.clearRect(0, 0, this.W, this.H);
    if (perf) clearMs = performance.now() - clearStart;

    const showingCanvasTexturePreview = p.canvasTextureShowOnCanvas && this.hasCanvasTexture();
    if (showingCanvasTexturePreview) {
      this._renderCanvasTexturePreview(p);
    }

    // Brush size cursor preview
    const overlayStart = perf ? performance.now() : 0;
    if (!showingCanvasTexturePreview && this._cursorX >= 0 && this._cursorY >= 0) {
      const canvasPos = this._screenToCanvas(this._cursorX, this._cursorY);
      const radius = p.stampSize / 2;
      this.lctx.save();
      this.lctx.strokeStyle = 'rgba(255,255,255,0.5)';
      this.lctx.lineWidth = 1;
      this.lctx.beginPath();
      this.lctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
      this.lctx.stroke();
      this.lctx.restore();
    }

    if (!showingCanvasTexturePreview) this._drawSymmetryGuideOverlay(this.lctx, p);
    if (!showingCanvasTexturePreview && brush && brush.drawOverlay) {
      brush.drawOverlay(this.lctx, p);
    }
    if (!showingCanvasTexturePreview) this.drawSimulationOverlay(this.lctx);
    // Selection overlay (marching ants)
    if (!showingCanvasTexturePreview && this.selectionMgr) this.selectionMgr.drawOverlay(this.lctx, elapsed);
    // Floating pixel preview (during move/transform drag)
    if (!showingCanvasTexturePreview && this.selectionMgr) this.selectionMgr.drawFloatingPreview(this.lctx);
    // Transform handles
    if (!showingCanvasTexturePreview && this.selectionMgr?.transformActive) this.selectionMgr.drawTransformHandles(this.lctx);

    // Tiling mode boundary indicator
    if (!showingCanvasTexturePreview && this.tilingMode) {
      this.lctx.save();
      this.lctx.strokeStyle = 'rgba(255,200,50,0.3)';
      this.lctx.lineWidth = 1;
      this.lctx.setLineDash([8, 4]);
      this.lctx.strokeRect(0, 0, this.W, this.H);
      this.lctx.restore();
    }
    if (this.motionPath?.editorOpen) {
      this._renderMotionPathEditorSurface();
    }
    if (perf) overlayMs = performance.now() - overlayStart;

    // Update status
    const statusStart = perf ? performance.now() : 0;
    this._updateStatus(brush);
    if (perf) {
      statusMs = performance.now() - statusStart;
      this._recordPerformanceFrame({
        deltaMs,
        totalMs: performance.now() - frameStart,
        brushMs,
        clearMs,
        overlayMs,
        statusMs,
        hidden: false,
      });
    }

    this._rafId = requestAnimationFrame(() => this._frameLoop());
  }

  _updateStatus(brush) {
    let info = `${this.W}×${this.H} | Layer ${this.activeLayerIdx + 1}/${this.layers.length}`;
    if (this.viewZoom !== 1 || this.viewRotation !== 0) {
      info += ` | ${Math.round(this.viewZoom * 100)}%`;
      if (this.viewRotation !== 0) info += ` ${Math.round(this.viewRotation * 180 / Math.PI)}°`;
    }
    if (this.simulation.running) info += ' | Sim: running';
    else if (this.simulation.paused) info += ' | Sim: paused';
    if (this.simulation.runtimeSessions.length > 0) info += ` | Sessions: ${this.simulation.runtimeSessions.length}`;
    if (brush && brush.getStatusInfo) info += ` | ${brush.getStatusInfo()}`;
    const perf = this._getPerformanceStatusSummary();
    if (perf) info += ` | ${perf}`;
    this.statusEl.textContent = info;
  }

  // ========================================================
  // STAMP HELPERS
  // ========================================================

  _markStampDirty(ctx, x, y, size, extraPad = 0) {
    const half = size / 2 + Math.max(2, extraPad);
    this._markContextDirty(ctx, {
      x: x - half,
      y: y - half,
      w: half * 2,
      h: half * 2,
    });
  }

  _getStampWrapPoints(x, y, size) {
    if (!this.tilingMode) return [];
    const r = size / 2;
    const W = this.W;
    const H = this.H;
    const overLeft = x - r < 0;
    const overRight = x + r > W;
    const overTop = y - r < 0;
    const overBottom = y + r > H;
    const wraps = [];
    if (overLeft) wraps.push({ x: x + W, y });
    if (overRight) wraps.push({ x: x - W, y });
    if (overTop) wraps.push({ x, y: y + H });
    if (overBottom) wraps.push({ x, y: y - H });
    if (overLeft && overTop) wraps.push({ x: x + W, y: y + H });
    if (overRight && overTop) wraps.push({ x: x - W, y: y + H });
    if (overLeft && overBottom) wraps.push({ x: x + W, y: y - H });
    if (overRight && overBottom) wraps.push({ x: x - W, y: y - H });
    return wraps;
  }

  _getTintedStampCanvas(bitmap, widthPx, heightPx, fillColor) {
    if (!this._stampTintCanvas) {
      this._stampTintCanvas = document.createElement('canvas');
      this._stampTintCtx = this._stampTintCanvas.getContext('2d');
    }
    if (this._stampTintCanvas.width !== widthPx || this._stampTintCanvas.height !== heightPx) {
      this._stampTintCanvas.width = widthPx;
      this._stampTintCanvas.height = heightPx;
    }
    const ctx = this._stampTintCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, widthPx, heightPx);
    ctx.drawImage(bitmap, 0, 0, widthPx, heightPx);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = fillColor;
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.globalCompositeOperation = 'source-over';
    return this._stampTintCanvas;
  }

  _drawBitmapStamp(ctx, bitmap, x, y, size, color, opacity, options = {}) {
    if (!bitmap || opacity <= 0 || size <= 0) return;
    const p = options.p || this._cachedP || this.getP();
    const rotation = options.rotation ?? p.stampImageRotation ?? 0;
    const tintEnabled = options.tintEnabled ?? p.stampImageTint;
    const applyTexture = options.applyTexture !== false;
    const applyAlphaLock = options.applyAlphaLock !== false;
    const applyImpasto = options.applyImpasto !== false;
    const markDirty = options.markDirty !== false;
    const applyTiling = options.applyTiling !== false;
    const textureEnabled = applyTexture && this.hasCanvasTexture() && p.canvasTextureEnabled;
    if (textureEnabled) opacity *= this.getTextureDepositDensity(x, y, p);
    if (opacity <= 0) return;

    const aspect = bitmap.width > 0 && bitmap.height > 0 ? bitmap.width / bitmap.height : 1;
    const drawW = aspect >= 1 ? size : size * aspect;
    const drawH = aspect >= 1 ? size / aspect : size;
    const dirtySize = Math.sqrt(drawW * drawW + drawH * drawH);
    const renderWidthPx = Math.max(1, Math.ceil(drawW * this.DPR));
    const renderHeightPx = Math.max(1, Math.ceil(drawH * this.DPR));
    const renderSource = tintEnabled
      ? this._getTintedStampCanvas(bitmap, renderWidthPx, renderHeightPx, color)
      : bitmap;
    const heightSource = applyImpasto && p.impasto && p.impastoStrength > 0 && this._heightCtx
      ? this._getTintedStampCanvas(bitmap, renderWidthPx, renderHeightPx, '#ffffff')
      : null;
    const activeLayer = this.getActiveLayer();
    const useAlphaLock = applyAlphaLock && activeLayer && activeLayer.alphaLock && this.activeBrush !== 'eraser';

    const drawAt = (tx, ty) => {
      ctx.save();
      if (useAlphaLock) ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = opacity;
      ctx.translate(tx, ty);
      if (rotation) ctx.rotate(rotation);
      ctx.drawImage(renderSource, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();

      if (heightSource) {
        const hctx = this._heightCtx;
        hctx.save();
        hctx.globalAlpha = Math.min(opacity * p.impastoStrength, 1);
        hctx.translate(tx * this.DPR, ty * this.DPR);
        if (rotation) hctx.rotate(rotation);
        hctx.drawImage(heightSource, -(drawW * this.DPR) / 2, -(drawH * this.DPR) / 2, drawW * this.DPR, drawH * this.DPR);
        hctx.restore();
        this._heightDirty = true;
      }

      if (markDirty) this._markStampDirty(ctx, tx, ty, dirtySize);
    };

    drawAt(x, y);
    if (applyTiling) {
      for (const pt of this._getStampWrapPoints(x, y, dirtySize)) drawAt(pt.x, pt.y);
    }
  }

  symBitmapStamp(ctx, x, y, size, color, opacity, options = {}) {
    const p = options.p || this._cachedP || this.getP();
    const bitmap = options.bitmap || p?.stampImageCanvas;
    if (!bitmap) return;
    for (const pt of this.getSymmetryPoints(x, y)) {
      this._drawBitmapStamp(ctx, bitmap, pt.x, pt.y, size * (pt.sizeMultiplier || 1), color, opacity, { ...options, p });
    }
  }

  stampCircle(ctx, x, y, size, color, opacity) {
    const p = this._cachedP || this.getP();
    const textureEnabled = this.hasCanvasTexture() && p.canvasTextureEnabled;
    let drawSize = size;
    let dirtyExtraPad = 0;
    // Modulate opacity by canvas texture if enabled
    if (textureEnabled) {
      opacity *= this.getTextureDepositDensity(x, y, p);
      const edgeBreakup = this.getTextureEdgeBreakup(x, y, p);
      if (edgeBreakup > 0) {
        const field = this.sampleTextureField(x, y, p);
        drawSize = size * Math.max(
          TEXTURE_EDGE_BREAKUP_MIN_SIZE,
          1 - edgeBreakup * TEXTURE_EDGE_BREAKUP_SIZE_SCALE + (field.valley - 0.5) * edgeBreakup * TEXTURE_EDGE_BREAKUP_VALLEY_SCALE,
        );
      }
    }
    // Kubelka-Munk pigment mixing: blend brush colour with existing canvas colour
    // physically (subtractive mixing) before smudge logic takes over
    if (p.kmMix && p.kmStrength > 0 && !p.smudge) {
      const sampled = this._sampleSmudgeColor(x, y);
      if (sampled.a > 10) {
        const mixed = this._kmMixColors(color, sampled.r, sampled.g, sampled.b, p.kmStrength);
        color = `rgb(${mixed.r},${mixed.g},${mixed.b})`;
      }
    }
    // Smudge: blend brush colour with existing canvas colour
    if (p.smudge > 0) {
      const smudgePoint = textureEnabled ? this.getTextureSmudgeOffset(x, y, drawSize, p) : { x, y };
      const sampled = this._sampleSmudgeColor(smudgePoint.x, smudgePoint.y);
      if (sampled.a > 0) {
        if (p.smudgeOnly) {
          // Smudge-only: stamp purely with the sampled canvas colour
          // Modulate by area-averaged alpha so stamps fade at edges near transparent pixels
          color = `rgb(${sampled.r},${sampled.g},${sampled.b})`;
          opacity *= this._sampleSmudgeAreaAlpha(smudgePoint.x, smudgePoint.y, drawSize);
        } else {
          const brush = this._parseColorToRGB(color);
          const s = p.smudge * (sampled.a / 255); // scale by sampled alpha
          const r = Math.round(brush.r * (1 - s) + sampled.r * s);
          const g = Math.round(brush.g * (1 - s) + sampled.g * s);
          const b = Math.round(brush.b * (1 - s) + sampled.b * s);
          color = `rgb(${r},${g},${b})`;
        }
      } else if (p.smudgeOnly) {
        // Nothing on canvas to smudge — skip stamp entirely
        return;
      }
    } else if (p.smudgeOnly) {
      // Smudge is 0 but smudgeOnly is on — nothing to do
      return;
    }
    ctx.beginPath();
    ctx.arc(x, y, drawSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    const activeLayer = this.getActiveLayer();
    const useAlphaLock = activeLayer && activeLayer.alphaLock && this.activeBrush !== 'eraser';
    if (useAlphaLock) ctx.globalCompositeOperation = 'source-atop';
    ctx.fill();
    if (textureEnabled) {
      const breakup = this.getTextureEdgeBreakup(x, y, p);
      if (breakup > 0.12) {
        const flow = this.sampleTextureFlowVector(x, y, p);
        const feather = Math.max(TEXTURE_EDGE_FEATHER_MIN_DISTANCE, drawSize * TEXTURE_EDGE_FEATHER_DISTANCE_SCALE * breakup);
        dirtyExtraPad = Math.max(
          dirtyExtraPad,
          Math.hypot(flow.x * feather, flow.y * feather) + Math.max(1, drawSize * (0.12 + breakup * 0.04)),
        );
        ctx.globalAlpha = opacity * breakup * TEXTURE_EDGE_FEATHER_OPACITY_SCALE;
        ctx.beginPath();
        ctx.arc(x + flow.x * feather, y + flow.y * feather, Math.max(0.5, drawSize * (0.22 + breakup * 0.08)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (useAlphaLock) ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Impasto: stamp onto the height map proportionally to stamp opacity
    if (p.impasto && p.impastoStrength > 0 && this._heightCtx) {
      const hctx = this._heightCtx;
      hctx.beginPath();
      hctx.arc(x * this.DPR, y * this.DPR, (drawSize / 2) * this.DPR, 0, Math.PI * 2);
      hctx.fillStyle = '#ffffff';
      hctx.globalAlpha = Math.min(opacity * p.impastoStrength, 1);
      hctx.fill();
      hctx.globalAlpha = 1;
      this._heightDirty = true;
    }

    this._markStampDirty(ctx, x, y, drawSize, dirtyExtraPad);

    // Tiling: wrap stamp at canvas edges
    if (this.tilingMode) {
      const r = size / 2;
      const W = this.W, H = this.H;
      const overLeft = x - r < 0, overRight = x + r > W;
      const overTop = y - r < 0, overBottom = y + r > H;
      const wraps = [];
      if (overLeft)  wraps.push([x + W, y]);
      if (overRight) wraps.push([x - W, y]);
      if (overTop)    wraps.push([x, y + H]);
      if (overBottom) wraps.push([x, y - H]);
      // Corners
      if (overLeft  && overTop)    wraps.push([x + W, y + H]);
      if (overRight && overTop)    wraps.push([x - W, y + H]);
      if (overLeft  && overBottom) wraps.push([x + W, y - H]);
      if (overRight && overBottom) wraps.push([x - W, y - H]);

      for (const [wx, wy] of wraps) {
        if (useAlphaLock) ctx.globalCompositeOperation = 'source-atop';
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = opacity;
        ctx.fill();
        if (useAlphaLock) ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        // Impasto for wrapped stamps
        if (p.impasto && p.impastoStrength > 0 && this._heightCtx) {
          const hctx = this._heightCtx;
          hctx.beginPath();
          hctx.arc(wx * this.DPR, wy * this.DPR, r * this.DPR, 0, Math.PI * 2);
          hctx.fillStyle = '#ffffff';
          hctx.globalAlpha = Math.min(opacity * p.impastoStrength, 1);
          hctx.fill();
          hctx.globalAlpha = 1;
          this._heightDirty = true;
        }
        this._markStampDirty(ctx, wx, wy, size, dirtyExtraPad);
      }
    }
  }

  /**
   * Parse any CSS colour string to {r, g, b}.
   * Fast path for #rrggbb / #rgb hex; canvas fallback for hsl(), rgb(), etc.
   */
  _parseColorToRGB(color) {
    if (color[0] === '#') {
      let hex = color.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      const n = parseInt(hex, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    // Fallback: render into 1×1 canvas and read back
    const c = this._colorParseCtx;
    c.clearRect(0, 0, 1, 1);
    c.fillStyle = color;
    c.fillRect(0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }

  /**
   * Flood-fill a contiguous region of similar colour on the active layer.
   * Receives CSS-pixel coordinates and converts to device pixels internally.
   */
  /**
   * Sample the colour at (x, y) from the composited visible image and set it
   * as the primary colour.  Switches back to the brush tool immediately after.
   */
  _pickColor(x, y) {
    // Sample from the composite (flattened visible) canvas for a WYSIWYG pick
    const src = this.compositeCanvas;
    const dpr = this.DPR;
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    if (px < 0 || px >= src.width || py < 0 || py >= src.height) {
      this.setTool('brush');
      return;
    }
    // Reuse the 1×1 parse canvas to avoid creating a new context
    const ctx = this._colorParseCtx;
    ctx.clearRect(0, 0, 1, 1);
    ctx.drawImage(src, -px, -py);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0) {
      // Transparent pixel — sample background color instead
      this.setColorValue('primary', this.getColorValue('background', '#ffffff'));
    } else {
      const toHex = v => v.toString(16).padStart(2, '0');
      this.setColorValue('primary', `#${toHex(d[0])}${toHex(d[1])}${toHex(d[2])}`);
    }
    this._recordColor(this.getColorValue('primary', '#1a1a1a'));
    this.showToast(`🔬 Picked ${this.getColorValue('primary', '#1a1a1a')}`);
    // Return to brush mode after picking
    this.setTool('brush');
  }

  _floodFill(x, y) {
    const layer = this.getActiveLayer();
    if (!layer) return;

    this.pushUndo();

    const dpr = this.DPR;
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    const w = layer.canvas.width;
    const h = layer.canvas.height;

    if (px < 0 || px >= w || py < 0 || py >= h) return;

    // Read current layer pixels
    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    const imageData = layer.ctx.getImageData(0, 0, w, h);
    layer.ctx.restore();
    const data = imageData.data;

    // Target colour at click point
    const idx = (py * w + px) * 4;
    const targetR = data[idx], targetG = data[idx + 1], targetB = data[idx + 2], targetA = data[idx + 3];

    // Fill colour from primary colour picker
    const fill = this._parseColorToRGB(this.primaryEl.value);
    const fillR = fill.r, fillG = fill.g, fillB = fill.b, fillA = 255;

    // Don't fill if target already matches fill colour
    if (targetR === fillR && targetG === fillG && targetB === fillB && targetA === fillA) return;

    // Tolerance from sidebar slider
    const tolEl = document.getElementById('fillTolerance');
    const tolerance = tolEl ? +tolEl.value : 32;

    function colorMatch(i) {
      return Math.abs(data[i] - targetR) <= tolerance &&
             Math.abs(data[i + 1] - targetG) <= tolerance &&
             Math.abs(data[i + 2] - targetB) <= tolerance &&
             Math.abs(data[i + 3] - targetA) <= tolerance;
    }

    // Scanline flood fill
    const visited = new Uint8Array(w * h);
    const stack = [[px, py]];

    while (stack.length > 0) {
      const [cx, cy] = stack.pop();
      const ci = cy * w + cx;
      if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
      if (visited[ci]) continue;
      if (!colorMatch(ci * 4)) continue;

      // Find leftmost pixel in this row
      let left = cx;
      while (left > 0 && !visited[cy * w + left - 1] && colorMatch((cy * w + left - 1) * 4)) left--;

      // Find rightmost pixel in this row
      let right = cx;
      while (right < w - 1 && !visited[cy * w + right + 1] && colorMatch((cy * w + right + 1) * 4)) right++;

      for (let fx = left; fx <= right; fx++) {
        const fi = cy * w + fx;
        visited[fi] = 1;
        const di = fi * 4;
        data[di] = fillR;
        data[di + 1] = fillG;
        data[di + 2] = fillB;
        data[di + 3] = fillA;

        if (cy > 0 && !visited[(cy - 1) * w + fx] && colorMatch(((cy - 1) * w + fx) * 4)) stack.push([fx, cy - 1]);
        if (cy < h - 1 && !visited[(cy + 1) * w + fx] && colorMatch(((cy + 1) * w + fx) * 4)) stack.push([fx, cy + 1]);
      }
    }

    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.putImageData(imageData, 0, 0);
    layer.ctx.restore();
    layer.dirty = true;
    this.compositeAllLayers();
    this.recordLastChangeMarker('Fill');
    this.showToast('🪣 Filled');
  }

  /**
   * Sample the active layer colour at CSS coordinate (x, y).
   * Uses a cached ImageData snapshot that is invalidated each compositeAllLayers().
   */
  _sampleSmudgeColor(x, y) {
    const layer = this.getActiveLayer();
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    // Lazy-capture once per composite cycle
    if (!this._smudgeImageData) {
      this._smudgeImageData = layer.ctx.getImageData(0, 0, w, h);
    }
    // Convert CSS coordinates to canvas bitmap pixels (canvas is scaled by DPR)
    const dpr = this.DPR;
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    if (px < 0 || py < 0 || px >= w || py >= h) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    const off = (py * w + px) * 4;
    const d = this._smudgeImageData.data;
    return { r: d[off], g: d[off + 1], b: d[off + 2], a: d[off + 3] };
  }

  /**
   * Sample the average alpha within a circular stamp footprint on the active layer.
   * Returns 0–1. Samples 9 points (center + 8 surrounding at half-radius) for
   * performance, giving a smooth fade-out at edges near transparent pixels.
   */
  _sampleSmudgeAreaAlpha(x, y, size) {
    const layer = this.getActiveLayer();
    const w = layer.canvas.width;
    const h = layer.canvas.height;
    if (!this._smudgeImageData) {
      this._smudgeImageData = layer.ctx.getImageData(0, 0, w, h);
    }
    const dpr = this.DPR;
    const r = size / 2 * 0.5; // sample at half-radius
    const d = this._smudgeImageData.data;
    // 9 sample offsets: center + 4 cardinal + 4 diagonal at half-radius
    const offsets = [
      [0, 0],
      [r, 0], [-r, 0], [0, r], [0, -r],
      [r * 0.707, r * 0.707], [-r * 0.707, r * 0.707],
      [r * 0.707, -r * 0.707], [-r * 0.707, -r * 0.707],
    ];
    let sum = 0;
    let count = 0;
    for (const [dx, dy] of offsets) {
      const px = Math.round((x + dx) * dpr);
      const py = Math.round((y + dy) * dpr);
      if (px >= 0 && py >= 0 && px < w && py < h) {
        sum += d[(py * w + px) * 4 + 3]; // alpha channel
        count++;
      }
    }
    return count > 0 ? (sum / count) / 255 : 0;
  }

  /**
   * Kubelka-Munk two-flux reflectance mixing.
   * Converts brush and canvas colours to K/S coefficients, mixes them by
   * brushStrength, and converts back to RGB — producing physically-based
   * subtractive pigment mixing (blue + yellow → vibrant green).
   *
   * @param {string} brushColorHex  Hex colour string of the brush (e.g. "#ff0000")
   * @param {number} canvasR        Existing canvas red   channel (0–255)
   * @param {number} canvasG        Existing canvas green channel (0–255)
   * @param {number} canvasB        Existing canvas blue  channel (0–255)
   * @param {number} strength       Mix strength 0–1 (1 = full brush colour)
   * @returns {{ r: number, g: number, b: number }}
   */
  _kmMixColors(brushColorHex, canvasR, canvasG, canvasB, strength) {
    const brushRGB = this._parseColorToRGB(brushColorHex);

    // Convert 0-255 channel to linear reflectance [0.001, 0.999]
    const toR = v => Math.max(0.001, Math.min(0.999, v / 255));
    // Kubelka-Munk remission function: K/S = (1 - R)² / (2R)
    const toKS = R => ((1 - R) * (1 - R)) / (2 * R);
    // Convert K/S back to reflectance: R = 1 + K/S - sqrt((K/S)² + 2*(K/S))
    const toRefl = ks => {
      const r = 1 + ks - Math.sqrt(ks * ks + 2 * ks);
      return Math.max(0, Math.min(1, r));
    };

    const channels = [
      [brushRGB.r, canvasR],
      [brushRGB.g, canvasG],
      [brushRGB.b, canvasB],
    ];

    const mixed = channels.map(([bv, cv]) => {
      const Rb = toR(bv);
      const Rc = toR(cv);
      const KSb = toKS(Rb);
      const KSc = toKS(Rc);
      // Separate K and S using a fixed K:S ratio derived from KS composite
      // Simplified assumption: S=1, K=KS (valid for opaque pigments)
      const Kb = KSb, Sb = 1;
      const Kc = KSc, Sc = 1;
      const Kmix = strength * Kb + (1 - strength) * Kc;
      const Smix = strength * Sb + (1 - strength) * Sc;
      const KSmix = Kmix / Smix;
      return Math.round(toRefl(KSmix) * 255);
    });

    return { r: mixed[0], g: mixed[1], b: mixed[2] };
  }

  /**
   * Compute a lighting overlay canvas from the height map using Sobel normals
   * and a directional light model (Phong N·L).
   * Only called when _heightDirty is true; result is cached as _impastoOverlayCanvas.
   */
  _computeImpastoOverlay(p) {
    if (!this._heightCanvas || this._heightCanvas.width === 0) return null;
    const w = this._heightCanvas.width;
    const h = this._heightCanvas.height;
    const src = this._heightCtx.getImageData(0, 0, w, h).data;

    // Build a greyscale height array (using red channel)
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      height[i] = src[i * 4] / 255;
    }

    // Light direction from angle + elevation
    const la = p.impastoLightAngle;      // azimuth in radians
    const le = p.impastoLightElevation;  // elevation in radians
    const Lx = Math.cos(le) * Math.cos(la);
    const Ly = Math.cos(le) * Math.sin(la);
    const Lz = Math.sin(le);

    // Create output canvas
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const imgData = octx.createImageData(w, h);
    const od = imgData.data;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        // Sobel kernel to approximate surface gradient
        const tl = height[(y - 1) * w + (x - 1)];
        const tc = height[(y - 1) * w + x];
        const tr = height[(y - 1) * w + (x + 1)];
        const ml = height[y * w + (x - 1)];
        const mr = height[y * w + (x + 1)];
        const bl = height[(y + 1) * w + (x - 1)];
        const bc = height[(y + 1) * w + x];
        const br = height[(y + 1) * w + (x + 1)];

        const nx = -(tr + 2 * mr + br - tl - 2 * ml - bl);
        const ny = -(bl + 2 * bc + br - tl - 2 * tc - tr);
        const nz = 1.0;
        // Normalise; nz=1 guarantees len >= 1, but guard for safety
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const Nx = len > 1e-6 ? nx / len : 0;
        const Ny = len > 1e-6 ? ny / len : 0;
        const Nz = len > 1e-6 ? nz / len : 1;

        // N·L dot product, clamped
        const NdotL = Math.max(0, Math.min(1, Nx * Lx + Ny * Ly + Nz * Lz));

        // Map to output: 128 is neutral; above = highlights, below = shadows
        const v = Math.round(128 + (NdotL - 0.5) * 200);
        const off = (y * w + x) * 4;
        od[off] = v;
        od[off + 1] = v;
        od[off + 2] = v;
        od[off + 3] = 255;
      }
    }

    octx.putImageData(imgData, 0, 0);
    return out;
  }

  getSymmetryPoints(x, y) {
    const p = this.getP();
    const sizeMultipliers = this._getSymmetrySizeMultipliers(p);
    const getSizeMultiplier = index => sizeMultipliers[Math.max(0, Math.min(sizeMultipliers.length - 1, index))] ?? 1;
    if (!p.symmetryEnabled) return [{ x, y, index: 0, mirrored: false, sizeMultiplier: 1 }];
    if (p.symmetryMode === 'path') {
      const slots = this._getSymmetryPathSlots(p.symmetryCount, p);
      if (slots.length <= 1) return [{ x, y, index: 0, mirrored: false, sizeMultiplier: getSizeMultiplier(0) }];
      let baseIndex = 0;
      if ((this.isDrawing || this.isTapering) && this._symmetryStrokeState?.mode === 'path') {
        baseIndex = Math.max(0, Math.min(slots.length - 1, this._symmetryStrokeState.baseSlotIndex || 0));
      } else {
        baseIndex = this._resolvePathSymmetryBaseSlotIndex(x, y, p.symmetryCount, p);
      }
      const base = slots[baseIndex] || slots[0];
      const baseAngle = Number.isFinite(base?.angle) ? base.angle : 0;
      const baseTangentX = Math.cos(baseAngle);
      const baseTangentY = Math.sin(baseAngle);
      const baseNormalX = -baseTangentY;
      const baseNormalY = baseTangentX;
      const dx = x - base.x;
      const dy = y - base.y;
      const along = dx * baseTangentX + dy * baseTangentY;
      const across = dx * baseNormalX + dy * baseNormalY;
      const seen = new Set();
      const copies = [];
      const pushCopy = (slot, index, mirrored = false) => {
        const angle = Number.isFinite(slot?.angle) ? slot.angle : 0;
        const tangentX = Math.cos(angle);
        const tangentY = Math.sin(angle);
        const normalX = -tangentY;
        const normalY = tangentX;
        const cross = mirrored ? -across : across;
        const px = slot.x + tangentX * along + normalX * cross;
        const py = slot.y + tangentY * along + normalY * cross;
        const key = `${Math.round(px * SYMMETRY_GUIDE_SLOT_DEDUPE_PRECISION)}:${Math.round(py * SYMMETRY_GUIDE_SLOT_DEDUPE_PRECISION)}`;
        if (seen.has(key)) return;
        seen.add(key);
        copies.push({
          x: px,
          y: py,
          index,
          mirrored,
          sizeMultiplier: getSizeMultiplier(index),
        });
      };
      slots.forEach((slot, index) => {
        pushCopy(slot, index, false);
        if (p.symmetryPathMirror) pushCopy(slot, index, true);
      });
      return copies;
    }
    const { x: cx, y: cy } = this._getSymmetryRadialCenter(p);
    const pts = [];
    const n = p.symmetryCount;
    const dx = x - cx, dy = y - cy;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const cos = Math.cos(a), sin = Math.sin(a);
      pts.push({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos, index: i, mirrored: false, sizeMultiplier: getSizeMultiplier(i) });
      if (p.symmetryMirror) {
        pts.push({ x: cx + dx * cos + dy * sin, y: cy + dx * sin - dy * cos, index: i, mirrored: true, sizeMultiplier: getSizeMultiplier(i) });
      }
    }
    return pts;
  }

  symCircleStamp(ctx, x, y, size, color, opacity) {
    for (const pt of this.getSymmetryPoints(x, y)) {
      this.stampCircle(ctx, pt.x, pt.y, size * (pt.sizeMultiplier || 1), color, opacity);
    }
  }

  symStamp(ctx, x, y, size, color, opacity, options = {}) {
    const p = options.p || this._cachedP || this.getP();
    if (p?.stampImageCanvas) {
      this.symBitmapStamp(ctx, x, y, size, color, opacity, { ...options, p });
      return;
    }
    this.symCircleStamp(ctx, x, y, size, color, opacity);
  }

  // ========================================================
  // SENSING (for boid brush)
  // ========================================================

  _serializeSensingSourceSelection() {
    const seen = new Set();
    const serialized = [];
    for (const id of this._getCurrentSensingSourceSelectionState()) {
      const key = String(id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      serialized.push(key);
    }
    return serialized;
  }

  _restoreSensingSourceSelection(selection) {
    this._setCurrentSensingSourceSelectionState(selection);
  }

  _getSelectedSensingSourceLayers() {
    const selectedIds = this._serializeSensingSourceSelection();
    const selectedSet = new Set(selectedIds);
    const layers = this.layers.filter(layer => selectedSet.has(layer.id));
    if (layers.length !== selectedIds.length) {
      this._setCurrentSensingSourceSelectionState(layers.map(layer => layer.id));
    }
    return layers;
  }

  getSensingSourceSelectionSignature() {
    return JSON.stringify(this._getSelectedSensingSourceLayers().map(layer => layer.id));
  }

  _setSensingSourceSelection(layerIds, { refreshUi = true, invalidate = true } = {}) {
    this._restoreSensingSourceSelection(layerIds);
    if (invalidate) this.invalidateParams();
    if (refreshUi) this._refreshSensingLayerSourceUi();
    if (!this._simulationContextOverride) {
      const summary = document.querySelector('[data-sim-sensing-summary="1"]');
      if (summary) summary.textContent = this._buildSensingLayerSelectionSummary();
    }
    this._maybeAutoSaveSession?.();
  }

  _seedSensingSourceSelectionFromSource(source = 'active') {
    let selection = [];
    const activeLayerIndex = this.getActiveLayerIndex();
    if (source === 'below') {
      selection = this.layers
        .slice(activeLayerIndex + 1)
        .filter(layer => layer.visible)
        .map(layer => layer.id);
    } else if (source === 'all') {
      selection = this.layers
        .filter(layer => layer.visible)
        .map(layer => layer.id);
    } else {
      const activeLayer = this.getActiveLayer();
      selection = activeLayer ? [activeLayer.id] : [];
    }
    this._setSensingSourceSelection(selection, { refreshUi: false, invalidate: false });
    return selection;
  }

  _ensureSensingSourceSelection({ fallbackSource = 'active' } = {}) {
    const selectedLayers = this._getSelectedSensingSourceLayers();
    if (selectedLayers.length > 0) return selectedLayers;
    this._seedSensingSourceSelectionFromSource(fallbackSource);
    return this._getSelectedSensingSourceLayers();
  }

  _buildSensingLayerSelectionSummary() {
    const selectedLayers = this._getSelectedSensingSourceLayers();
    if (!selectedLayers.length) return 'No custom sources selected';
    const labels = selectedLayers.map(layer => layer.isBackground ? 'Background' : layer.name || 'Unnamed layer');
    if (labels.length <= 3) return labels.join(', ');
    return `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`;
  }

  _refreshSensingLayerSourceUi() {
    const sourceSelect = document.getElementById('sensingSource');
    const button = document.getElementById('sensingSourceLayersBtn');
    const summary = document.getElementById('sensingSourceLayersSummary');
    if (sourceSelect && !sourceSelect.dataset.prevValue) {
      sourceSelect.dataset.prevValue = sourceSelect.value || 'below';
    }
    if (summary) {
      const prefix = sourceSelect?.value === 'selected' ? 'Using: ' : 'Custom: ';
      summary.textContent = prefix + this._buildSensingLayerSelectionSummary();
    }
    if (button) {
      button.textContent = sourceSelect?.value === 'selected' ? 'Edit Layers' : 'Pick Layers';
    }
    if (this._sensingSourcePickerPanel?.classList.contains('open')) {
      this._renderSensingSourcePicker();
      if (this._sensingSourcePickerAnchor) this._positionSensingSourcePicker(this._sensingSourcePickerAnchor);
    }
  }

  _handleSensingSourceChange(nextSource, previousSource = 'below') {
    if (nextSource === 'selected') {
      this._ensureSensingSourceSelection({ fallbackSource: previousSource || 'active' });
    }
    const sourceSelect = document.getElementById('sensingSource');
    if (sourceSelect) sourceSelect.dataset.prevValue = nextSource;
    this._refreshSensingLayerSourceUi();
  }

  _ensureSensingSourcePickerPanel() {
    if (this._sensingSourcePickerPanel) return this._sensingSourcePickerPanel;
    const panel = document.createElement('div');
    panel.id = 'sensingSourcePickerPanel';
    panel.style.position = 'fixed';
    panel.style.zIndex = '140';
    panel.style.width = '260px';
    panel.style.maxHeight = '320px';
    panel.style.overflow = 'auto';
    panel.style.padding = '10px';
    panel.style.borderRadius = '10px';
    panel.style.border = '1px solid rgba(255,255,255,0.14)';
    panel.style.background = 'rgba(10,12,18,0.96)';
    panel.style.boxShadow = '0 14px 36px rgba(0,0,0,0.35)';
    panel.style.color = '#eef3ff';
    panel.style.font = '12px/1.4 Segoe UI, sans-serif';
    panel.style.display = 'none';
    panel.style.userSelect = 'none';
    document.body.appendChild(panel);
    this._sensingSourcePickerPanel = panel;
    return panel;
  }

  _positionSensingSourcePicker(anchorEl) {
    const panel = this._ensureSensingSourcePickerPanel();
    const anchorRect = anchorEl?.getBoundingClientRect();
    if (!anchorRect) return;
    const panelRect = panel.getBoundingClientRect();
    const gap = 8;
    const maxLeft = Math.max(8, window.innerWidth - panelRect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - panelRect.height - 8);
    const left = Math.min(maxLeft, Math.max(8, anchorRect.right - panelRect.width));
    const top = Math.min(maxTop, Math.max(8, anchorRect.bottom + gap));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  _renderSensingSourcePicker() {
    const panel = this._ensureSensingSourcePickerPanel();
    const selected = new Set(this._serializeSensingSourceSelection());
    const options = this.layers.map(layer => ({
      id: layer.id,
      label: layer.isBackground ? 'Background' : (layer.name || 'Unnamed layer'),
      meta: layer.isBackground ? 'Canvas background fill' : `${Math.round(layer.opacity * 100)}% • ${layer.visible ? 'visible' : 'hidden'}`,
      checked: selected.has(layer.id),
    }));
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <strong style="font-size:12px;">Sensing Sources</strong>
        <button type="button" data-sensing-picker-close style="padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:#eef3ff;cursor:pointer;">Done</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button type="button" data-sensing-picker-visible style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(58,106,232,0.14);color:#dfe8ff;cursor:pointer;">All Visible</button>
        <button type="button" data-sensing-picker-clear style="padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#eef3ff;cursor:pointer;">Clear</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${options.map(option => `
          <label style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,0.04);cursor:pointer;">
            <input type="checkbox" data-sensing-layer-id="${option.id}" ${option.checked ? 'checked' : ''} style="margin-top:2px;">
            <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
              <span style="font-weight:600;">${option.label}</span>
              <span style="font-size:11px;color:rgba(238,243,255,0.68);">${option.meta}</span>
            </span>
          </label>
        `).join('')}
      </div>
    `;
    panel.querySelectorAll('[data-sensing-layer-id]').forEach(input => {
      input.addEventListener('change', event => {
        const current = new Set(this._serializeSensingSourceSelection());
        const layerId = event.target.dataset.sensingLayerId;
        if (event.target.checked) current.add(layerId);
        else current.delete(layerId);
        const sourceSelect = document.getElementById('sensingSource');
        if (sourceSelect && sourceSelect.value !== 'selected') {
          const previousSource = sourceSelect.value || sourceSelect.dataset.prevValue || 'below';
          this._seedSensingSourceSelectionFromSource(previousSource);
          current.clear();
          for (const selectedLayer of this._serializeSensingSourceSelection()) current.add(selectedLayer);
          if (event.target.checked) current.add(layerId);
          else current.delete(layerId);
          sourceSelect.value = 'selected';
          this._handleSensingSourceChange('selected', previousSource);
        }
        this._setSensingSourceSelection(Array.from(current));
      });
    });
    panel.querySelector('[data-sensing-picker-visible]')?.addEventListener('click', () => {
      const visibleIds = this.layers.filter(layer => layer.visible).map(layer => layer.id);
      const sourceSelect = document.getElementById('sensingSource');
      if (sourceSelect && sourceSelect.value !== 'selected') {
        const previousSource = sourceSelect.value || sourceSelect.dataset.prevValue || 'below';
        sourceSelect.value = 'selected';
        this._handleSensingSourceChange('selected', previousSource);
      }
      this._setSensingSourceSelection(visibleIds);
    });
    panel.querySelector('[data-sensing-picker-clear]')?.addEventListener('click', () => {
      const sourceSelect = document.getElementById('sensingSource');
      if (sourceSelect && sourceSelect.value !== 'selected') {
        const previousSource = sourceSelect.value || sourceSelect.dataset.prevValue || 'below';
        sourceSelect.value = 'selected';
        this._handleSensingSourceChange('selected', previousSource);
      }
      this._setSensingSourceSelection([]);
    });
    panel.querySelector('[data-sensing-picker-close]')?.addEventListener('click', () => this.closeSensingSourcePicker());
  }

  openSensingSourcePicker(anchorEl) {
    const panel = this._ensureSensingSourcePickerPanel();
    const sourceSelect = document.getElementById('sensingSource');
    if (sourceSelect?.value === 'selected' && this._serializeSensingSourceSelection().length === 0) {
      this._ensureSensingSourceSelection({ fallbackSource: sourceSelect.dataset.prevValue || 'active' });
    }
    this._sensingSourcePickerAnchor = anchorEl || this._sensingSourcePickerAnchor;
    this._renderSensingSourcePicker();
    panel.style.display = 'block';
    panel.classList.add('open');
    if (this._sensingSourcePickerAnchor) this._positionSensingSourcePicker(this._sensingSourcePickerAnchor);
    if (!this._sensingSourcePickerPointerHandler) {
      this._sensingSourcePickerPointerHandler = event => {
        if (panel.contains(event.target) || this._sensingSourcePickerAnchor?.contains?.(event.target)) return;
        this.closeSensingSourcePicker();
      };
      document.addEventListener('pointerdown', this._sensingSourcePickerPointerHandler);
    }
    if (!this._sensingSourcePickerKeyHandler) {
      this._sensingSourcePickerKeyHandler = event => {
        if (event.key === 'Escape') this.closeSensingSourcePicker();
      };
      document.addEventListener('keydown', this._sensingSourcePickerKeyHandler);
    }
  }

  toggleSensingSourcePicker(anchorEl) {
    const panel = this._ensureSensingSourcePickerPanel();
    if (panel.classList.contains('open')) {
      this.closeSensingSourcePicker();
      return;
    }
    this.openSensingSourcePicker(anchorEl);
  }

  closeSensingSourcePicker() {
    const panel = this._sensingSourcePickerPanel;
    if (panel) {
      panel.classList.remove('open');
      panel.style.display = 'none';
    }
    if (this._sensingSourcePickerPointerHandler) {
      document.removeEventListener('pointerdown', this._sensingSourcePickerPointerHandler);
      this._sensingSourcePickerPointerHandler = null;
    }
    if (this._sensingSourcePickerKeyHandler) {
      document.removeEventListener('keydown', this._sensingSourcePickerKeyHandler);
      this._sensingSourcePickerKeyHandler = null;
    }
  }

  buildSensingData(p = this.getP()) {
    const src = p.sensingSource;
    const w = this.W * this.DPR, h = this.H * this.DPR;
    if (src === 'active') {
      // Read directly from the active layer bitmap; the reusable offscreen
      // surface only helps when multiple layers must be composited first.
      const l = this.getActiveLayer();
      return l.ctx.getImageData(0, 0, w, h);
    }
    if (!this._sensingCompositeCanvas) {
      this._sensingCompositeCanvas = document.createElement('canvas');
      this._sensingCompositeCtx = this._sensingCompositeCanvas.getContext('2d');
    }
    const tmp = this._sensingCompositeCanvas;
    if (tmp.width !== w || tmp.height !== h) {
      tmp.width = w;
      tmp.height = h;
    }
    const tc = this._sensingCompositeCtx;
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, w, h);

    const drawLayer = layer => {
      if (!layer) return;
      tc.globalAlpha = layer.opacity;
      tc.globalCompositeOperation = getCanvasBlendMode(layer.blend);
      tc.drawImage(layer.canvas, 0, 0);
    };

    const activeLayerIndex = this.getActiveLayerIndex();

    if (src === 'below') {
      // Layers below active
      for (let i = this.layers.length - 1; i > activeLayerIndex; i--) {
        const l = this.layers[i];
        if (!l.visible) continue;
        drawLayer(l);
      }
    } else if (src === 'all') {
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const l = this.layers[i];
        if (!l.visible) continue;
        drawLayer(l);
      }
    } else if (src === 'selected') {
      const selectedIds = new Set(this._serializeSensingSourceSelection());
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const l = this.layers[i];
        if (!selectedIds.has(l.id)) continue;
        drawLayer(l);
      }
    }
    return tc.getImageData(0, 0, w, h);
  }

  // ========================================================
  // SAVE IMAGE
  // ========================================================

  _compositeFlatCanvas() {
    const { canvas, ctx } = this.makeLayerCanvas();
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.bgColorEl ? this.bgColorEl.value : '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (!l.visible) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = getCanvasBlendMode(l.blend);
      ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.restore();
    return canvas;
  }

  saveImage() {
    const canvas = this._compositeFlatCanvas();
    // Use toBlob for better performance with large canvases
    canvas.toBlob(blob => {
      if (!blob) {
        // Fallback to toDataURL
        const a = document.createElement('a');
        a.download = 'boid-brush.png';
        a.href = canvas.toDataURL('image/png');
        a.click();
        this.showToast('💾 Saved');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = 'boid-brush.png';
      a.href = url;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.showToast('💾 Saved');
    }, 'image/png');
  }

  // ========================================================
  // COPY / PASTE
  // ========================================================

  async copyToClipboard() {
    // With an active selection: copy only the selected pixels from the active layer
    if (this.selectionMgr?.active) {
      try {
        const l = this.getActiveLayer();
        const bounds = this.selectionMgr.getBounds();
        const extracted = this.selectionMgr.extractPixels(l.canvas, this.DPR);
        if (!extracted) { this.showToast('⚠ Nothing selected'); return; }
        const blob = await extracted.convertToBlob({ type: 'image/png' });
        this._clipboardBlob = blob;
        this._clipboardMetadata = bounds;  // Store original location & size
        let clipboardOk = false;
        try {
          if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            clipboardOk = true;
          }
        } catch { /* Clipboard unavailable */ }
        this.showToast(clipboardOk ? '📋 Selection copied' : '📋 Selection copied (in-app)');
      } catch { this.showToast('⚠ Copy failed'); }
      return;
    }
    // No selection: copy flat composite of all layers
    try {
      const canvas = this._compositeFlatCanvas();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) { this.showToast('⚠ Copy failed'); return; }
      // Always store internally for in-app paste fallback
      this._clipboardBlob = blob;
      this._clipboardMetadata = null;  // No selection = no stored location
      let clipboardOk = false;
      try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
          clipboardOk = true;
        }
      } catch { /* Clipboard API unavailable or denied */ }
      this.showToast(clipboardOk ? '📋 Copied to clipboard' : '📋 Copied (in-app only)');
    } catch (err) {
      this.showToast('⚠ Copy failed');
    }
  }

  /** Shared helper to paste an image blob onto the active layer */
  _pasteImageBlob(blob) {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      this.pushUndo();
      const l = this.getActiveLayer();
      // If clipboard has stored bounds metadata, paste at exact original location & size
      if (this._clipboardMetadata) {
        const { x, y, w, h } = this._clipboardMetadata;
        l.ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h);
        l.dirty = true;
        this.compositeAllLayers();
        this.recordLastChangeMarker('Paste');
        URL.revokeObjectURL(url);
        this.showToast('📋 Pasted at original location');
        return;
      }
      // If a selection is active, paste into the selection bounding box
      if (this.selectionMgr?.active) {
        const bounds = this.selectionMgr.getBounds();
        if (bounds && bounds.w > 0 && bounds.h > 0) {
          const dpr = this.DPR;
          l.ctx.save();
          l.ctx.setTransform(1, 0, 0, 1, 0, 0);
          this.selectionMgr._buildPath(l.ctx, dpr);
          l.ctx.clip();
          l.ctx.drawImage(img, bounds.x * dpr, bounds.y * dpr, bounds.w * dpr, bounds.h * dpr);
          l.ctx.restore();
          l.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          l.dirty = true;
          this.compositeAllLayers();
          this.recordLastChangeMarker('Paste');
          URL.revokeObjectURL(url);
          this.showToast('📋 Pasted into selection');
          return;
        }
      }
      // Otherwise scale to fit canvas while maintaining aspect ratio, centered
      const srcAspect = img.width / img.height;
      const canvasAspect = this.W / this.H;
      let destW, destH;
      if (srcAspect > canvasAspect) {
        // Image is wider than canvas; fit to width
        destW = this.W;
        destH = this.W / srcAspect;
      } else {
        // Image is taller than canvas; fit to height
        destH = this.H;
        destW = this.H * srcAspect;
      }
      const destX = (this.W - destW) / 2;
      const destY = (this.H - destH) / 2;
      l.ctx.drawImage(img, 0, 0, img.width, img.height, destX, destY, destW, destH);
      l.dirty = true;
      this.compositeAllLayers();
      this.recordLastChangeMarker('Paste');
      URL.revokeObjectURL(url);
      this.showToast('📋 Pasted');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      this.showToast('⚠ Paste failed — invalid image');
    };
    img.src = url;
  }

  async pasteFromClipboard() {
    // Tier 1: try native Clipboard API
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              this._pasteImageBlob(blob);
              return;
            }
          }
        }
      }
    } catch { /* Clipboard API unavailable or denied — fall through */ }

    // Tier 2: use internal clipboard buffer (from in-app copy)
    if (this._clipboardBlob) {
      this._pasteImageBlob(this._clipboardBlob);
      return;
    }

    // Tier 3: open a file picker as last resort
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      this._pasteImageBlob(file);
    });
    input.click();
  }

  // ========================================================
  // SESSION PERSISTENCE
  /** Cut the selected region from the active layer to clipboard. */
  async cutToClipboard() {
    if (!this.selectionMgr?.active) { this.showToast('⚠ No selection to cut'); return; }
    const l = this.getActiveLayer();
    if (l.isBackground) { this.showToast('Cannot cut from background layer'); return; }
    try {
      const extracted = this.selectionMgr.extractPixels(l.canvas, this.DPR);
      if (!extracted) { this.showToast('⚠ Cut failed'); return; }
      const blob = await extracted.convertToBlob({ type: 'image/png' });
      this._clipboardBlob = blob;
      try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }
      } catch { /* Clipboard unavailable */ }
      this.pushUndo();
      this.selectionMgr.clearPixels(l.ctx, this.DPR);
      l.dirty = true;
      this.compositeAllLayers();
      this.recordLastChangeMarker('Cut');
      this.showToast('✂ Cut');
    } catch { this.showToast('⚠ Cut failed'); }
  }

  // ========================================================
  // COLOR HISTORY
  // ========================================================

  _recordColor(hex) {
    hex = hex.toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    const idx = this._colorHistory.indexOf(hex);
    if (idx !== -1) this._colorHistory.splice(idx, 1);
    this._colorHistory.unshift(hex);
    if (this._colorHistory.length > this._maxColorHistory) this._colorHistory.pop();
    this._renderColorHistory();
  }

  _renderColorHistory() {
    const container = document.getElementById('colorHistory');
    if (container) {
      container.innerHTML = '';
      for (const hex of this._colorHistory) {
        const swatch = document.createElement('div');
        swatch.style.cssText = `width:20px;height:20px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,0.15);background:${hex};transition:transform 0.1s;`;
        swatch.title = hex;
        swatch.addEventListener('click', () => {
          this.setColorValue('primary', hex);
        });
        swatch.addEventListener('mouseenter', () => swatch.style.transform = 'scale(1.2)');
        swatch.addEventListener('mouseleave', () => swatch.style.transform = 'scale(1)');
        container.appendChild(swatch);
      }
    }
    this._renderColorPickerHistory();
  }

  // SESSION PERSISTENCE
  // ========================================================

  _captureSessionControls() {
    const controls = {};
    document.querySelectorAll('#sidebar input[type="range"], #sidebar input[type="checkbox"], #sidebar input[type="text"], #sidebar select, #settingsPanel input[type="range"], #settingsPanel input[type="checkbox"], #settingsPanel select').forEach(el => {
      if (el.id) controls[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    document.querySelectorAll('#sidebar input[type="number"], #settingsPanel input[type="number"]').forEach(el => {
      if (el.id) controls[el.id] = el.value;
    });
    controls.primaryColor = this.primaryEl.value;
    controls.secondaryColor = this.secondaryEl.value;
    controls.bgColor = this.bgColorEl ? this.bgColorEl.value : '#ffffff';
    controls.activeBrush = this.activeBrush;
    controls.activeTool = this.activeTool;
    controls._colorHistory = this._colorHistory;
    controls._tilingMode = this.tilingMode;
    controls._view = this._captureViewState();
    controls._viewBookmarks = _deepClone(this.viewBookmarks);
    controls._lastChangeMarker = _deepClone(this.lastChangeMarker);
    if (this._docSized) {
      controls._docSized = true;
      controls._docW = this._docW;
      controls._docH = this._docH;
    }
    controls._simulation = {
      enabled: this.simulation.enabled,
      guidesVisible: this.simulation.guidesVisible !== false,
      heatmapVisible: this.simulation.heatmapVisible === true,
      hudCollapsed: this.simulation.hudCollapsed,
      inspectorCollapsed: this.simulation.inspectorCollapsed,
      inspectorSections: this.simulation.inspectorSections,
      editorTool: this.simulation.editorTool,
      // 'normal' | 'forceVisualization' — config only, no runtimes/camera
      // smoothing state. See _createDefaultForceVizState().
      mode: this.simulation.mode,
      forceViz: _deepClone(this.simulation.forceViz),
      brushData: this.simulation.brushData,
      nextId: this.simulation.nextId,
      vars: this.simulation.vars,
      sessions: this.simulation.sessions,
      activeSessionIndex: this.simulation.activeSessionIndex,
      savedPlayback: this.simulation.savedPlayback,
      multiSessionEnabled: this.simulation.multiSessionEnabled,
      multiSessionBindings: this.simulation.multiSessionBindings,
    };
    controls._symmetryState = this._serializeSymmetryState();
    controls._sensingSourceSelection = this._serializeSensingSourceSelection();
    controls._motionPath = this._serializeMotionPathState();
    controls._canvasTextureState = this._serializeCanvasTextureState();
    controls._stampImageState = this._serializeCustomStampImageState();
    return controls;
  }

  _captureViewState() {
    return {
      zoom: Number.isFinite(this.viewZoom) ? this.viewZoom : 1,
      panX: Number.isFinite(this.viewPanX) ? this.viewPanX : 0,
      panY: Number.isFinite(this.viewPanY) ? this.viewPanY : 0,
      rotation: Number.isFinite(this.viewRotation) ? this.viewRotation : 0,
      flipped: !!this.viewFlipped,
    };
  }

  _normalizeViewState(view) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) return null;
    const zoom = Number(view.zoom);
    const panX = Number(view.panX);
    const panY = Number(view.panY);
    const rotation = Number(view.rotation);
    return {
      zoom: Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1,
      panX: Number.isFinite(panX) ? panX : 0,
      panY: Number.isFinite(panY) ? panY : 0,
      rotation: Number.isFinite(rotation) ? rotation : 0,
      flipped: !!view.flipped,
    };
  }

  _sanitizeBookmarkName(name, fallback = VIEW_BOOKMARK_DEFAULT_NAME) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    return trimmed ? trimmed.slice(0, MAX_VIEW_BOOKMARK_NAME_LENGTH) : fallback;
  }

  _createViewNavigationSnapshot() {
    const activeLayer = this.getActiveLayer();
    return {
      view: this._captureViewState(),
      layerId: activeLayer?.id || null,
      layerName: typeof activeLayer?.name === 'string' ? activeLayer.name.slice(0, MAX_VIEW_BOOKMARK_LAYER_NAME_LENGTH) : (activeLayer?.isBackground ? 'Background' : ''),
      activeLayerIndex: this.getActiveLayerIndex(),
    };
  }

  _createBookmarkId(prefix = 'view') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  _createStableNavigationId(prefix, raw, index = 0) {
    const parts = [
      prefix,
      typeof raw?.id === 'string' ? raw.id : '',
      typeof raw?.name === 'string' ? raw.name : '',
      typeof raw?.label === 'string' ? raw.label : '',
      typeof raw?.createdAt === 'string' ? raw.createdAt : '',
      typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
      typeof raw?.timestamp === 'string' ? raw.timestamp : '',
      Number.isFinite(Number(raw?.view?.zoom)) ? Number(raw.view.zoom).toFixed(3) : '',
      Number.isFinite(Number(raw?.view?.panX)) ? Math.round(Number(raw.view.panX)) : '',
      Number.isFinite(Number(raw?.view?.panY)) ? Math.round(Number(raw.view.panY)) : '',
      Number.isFinite(Number(raw?.view?.rotation)) ? Number(raw.view.rotation).toFixed(3) : '',
      raw?.view?.flipped ? 'flip' : '',
      index,
    ].join('-').toLowerCase();
    const slug = parts.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
    return slug ? `${prefix}-${slug}` : `${prefix}-${index + 1}`;
  }

  _sanitizeViewBookmarkEntry(raw, index = 0) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const view = this._normalizeViewState(raw.view);
    if (!view) return null;
    const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
    return {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : this._createStableNavigationId('view', raw, index),
      name: this._sanitizeBookmarkName(raw.name, `${VIEW_BOOKMARK_DEFAULT_NAME} ${index + 1}`),
      createdAt,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
      view,
      layerId: typeof raw.layerId === 'string' && raw.layerId.trim() ? raw.layerId.trim() : null,
      layerName: typeof raw.layerName === 'string' ? raw.layerName.slice(0, MAX_VIEW_BOOKMARK_LAYER_NAME_LENGTH) : '',
      activeLayerIndex: Number.isFinite(Number(raw.activeLayerIndex)) ? Math.max(0, Math.round(Number(raw.activeLayerIndex))) : 0,
    };
  }

  _sanitizeViewBookmarks(bookmarks) {
    if (!Array.isArray(bookmarks)) return [];
    const seen = new Set();
    const sanitized = [];
    bookmarks.forEach((bookmark, index) => {
      const next = this._sanitizeViewBookmarkEntry(bookmark, index);
      if (!next || seen.has(next.id)) return;
      seen.add(next.id);
      sanitized.push(next);
    });
    return sanitized.slice(0, MAX_VIEW_BOOKMARKS);
  }

  _sanitizeLastChangeMarker(marker) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
    const view = this._normalizeViewState(marker.view);
    if (!view) return null;
    return {
      id: typeof marker.id === 'string' && marker.id.trim() ? marker.id.trim() : this._createStableNavigationId('change', marker),
      label: this._sanitizeBookmarkName(marker.label, 'Last change'),
      timestamp: typeof marker.timestamp === 'string' ? marker.timestamp : new Date().toISOString(),
      view,
      layerId: typeof marker.layerId === 'string' && marker.layerId.trim() ? marker.layerId.trim() : null,
      layerName: typeof marker.layerName === 'string' ? marker.layerName.slice(0, MAX_VIEW_BOOKMARK_LAYER_NAME_LENGTH) : '',
      activeLayerIndex: Number.isFinite(Number(marker.activeLayerIndex)) ? Math.max(0, Math.round(Number(marker.activeLayerIndex))) : 0,
    };
  }

  _applyViewState(view) {
    const normalized = this._normalizeViewState(view);
    if (!normalized) return false;
    this.viewZoom = normalized.zoom;
    this.viewPanX = normalized.panX;
    this.viewPanY = normalized.panY;
    this.viewRotation = normalized.rotation;
    this.viewFlipped = normalized.flipped;
    this._applyViewTransform();
    return true;
  }

  saveCurrentViewBookmark({ name, overwriteId = null } = {}) {
    const snapshot = this._createViewNavigationSnapshot();
    const timestamp = new Date().toISOString();
    const overwriteIndex = overwriteId
      ? this.viewBookmarks.findIndex(bookmark => bookmark.id === overwriteId)
      : -1;
    if (overwriteIndex >= 0) {
      const existing = this.viewBookmarks[overwriteIndex];
      this.viewBookmarks[overwriteIndex] = {
        ...existing,
        ...snapshot,
        name: this._sanitizeBookmarkName(name, existing.name),
        updatedAt: timestamp,
      };
      this.viewBookmarks = [...this.viewBookmarks];
    } else {
      this.viewBookmarks = [
        {
          id: this._createBookmarkId('view'),
          name: this._sanitizeBookmarkName(name, this.getSuggestedViewBookmarkName()),
          createdAt: timestamp,
          updatedAt: timestamp,
          ...snapshot,
        },
        ...this.viewBookmarks,
      ].slice(0, MAX_VIEW_BOOKMARKS);
    }
    this._renderViewBookmarksPanel?.();
    this.saveSession();
    this.showToast(overwriteIndex >= 0 ? '🔖 Bookmark updated' : '🔖 Bookmark saved');
    return true;
  }

  renameViewBookmark(id, name) {
    const index = this.viewBookmarks.findIndex(bookmark => bookmark.id === id);
    if (index < 0) return false;
    const nextName = this._sanitizeBookmarkName(name, this.viewBookmarks[index].name);
    this.viewBookmarks[index] = {
      ...this.viewBookmarks[index],
      name: nextName,
      updatedAt: new Date().toISOString(),
    };
    this.viewBookmarks = [...this.viewBookmarks];
    this._renderViewBookmarksPanel?.();
    this.saveSession();
    this.showToast(`✏️ ${nextName}`);
    return true;
  }

  deleteViewBookmark(id) {
    const bookmark = this.viewBookmarks.find(entry => entry.id === id);
    if (!bookmark) return false;
    this.viewBookmarks = this.viewBookmarks.filter(entry => entry.id !== id);
    this._renderViewBookmarksPanel?.();
    this.saveSession();
    this.showToast(`🗑 ${bookmark.name}`);
    return true;
  }

  _applyNavigationSnapshot(snapshot, toastLabel) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const targetIndex = snapshot.layerId
      ? this.layers.findIndex(layer => layer.id === snapshot.layerId && !layer.isBackground)
      : -1;
    if (targetIndex >= 0) {
      this.setActiveLayer(targetIndex);
    } else if (Number.isFinite(Number(snapshot.activeLayerIndex))) {
      this.setActiveLayer(Math.round(Number(snapshot.activeLayerIndex)));
    }
    const applied = this._applyViewState(snapshot.view);
    syncUI(this);
    this._renderViewBookmarksPanel?.();
    this.saveSession();
    if (toastLabel) this.showToast(toastLabel);
    return applied;
  }

  jumpToViewBookmark(id) {
    const bookmark = this.viewBookmarks.find(entry => entry.id === id);
    if (!bookmark) return false;
    return this._applyNavigationSnapshot(bookmark, `🔖 ${bookmark.name}`);
  }

  jumpToLastChange() {
    if (!this.lastChangeMarker) {
      this.showToast('⚠ No recent change recorded');
      return false;
    }
    const label = this.lastChangeMarker.label ? `↩ ${this.lastChangeMarker.label}` : '↩ Last change';
    return this._applyNavigationSnapshot(this.lastChangeMarker, label);
  }

  getActiveViewBookmarkId() {
    const current = this._captureViewState();
    const activeLayerId = this.getActiveLayer()?.id || null;
    const match = this.viewBookmarks.find(bookmark => {
      if (!bookmark?.view) return false;
      return Math.abs((bookmark.view.zoom || 1) - (current.zoom || 1)) <= VIEW_BOOKMARK_ACTIVE_ZOOM_EPSILON
        && Math.abs((bookmark.view.panX || 0) - (current.panX || 0)) <= VIEW_BOOKMARK_ACTIVE_PAN_EPSILON
        && Math.abs((bookmark.view.panY || 0) - (current.panY || 0)) <= VIEW_BOOKMARK_ACTIVE_PAN_EPSILON
        && Math.abs((bookmark.view.rotation || 0) - (current.rotation || 0)) <= VIEW_BOOKMARK_ACTIVE_ROTATION_EPSILON
        && !!bookmark.view.flipped === !!current.flipped
        && (!bookmark.layerId || bookmark.layerId === activeLayerId);
    });
    return match?.id || null;
  }

  recordLastChangeMarker(label = 'Last change', { persistSession = true } = {}) {
    this.lastChangeMarker = this._sanitizeLastChangeMarker({
      id: this._createBookmarkId('change'),
      label,
      timestamp: new Date().toISOString(),
      ...this._createViewNavigationSnapshot(),
    });
    this._renderViewBookmarksPanel?.();
    if (persistSession) this.saveSession();
    return true;
  }

  _captureWorkspaceDocumentState() {
    const activeLayer = this.getActiveLayer();
    return {
      width: this._docW || this.W,
      height: this._docH || this.H,
      docSized: !!this._docSized,
      activeLayerId: activeLayer && !activeLayer.isBackground ? activeLayer.id : null,
      activeLayerIndex: this.getActiveLayerIndex(),
      nextLayerId: this._nextLayerId,
      layers: this.layers.map(layer => ({
        id: layer.id,
        name: layer.name || '',
        visible: layer.visible !== false,
        opacity: Number.isFinite(layer.opacity) ? Math.max(0, Math.min(1, layer.opacity)) : 1,
        blend: typeof layer.blend === 'string' ? layer.blend : 'source-over',
        alphaLock: !!layer.alphaLock,
        isBackground: !!layer.isBackground,
        dataUrl: layer.canvas.toDataURL('image/png'),
      })),
    };
  }

  async _restoreWorkspaceDocumentState(documentState) {
    if (!documentState || typeof documentState !== 'object' || Array.isArray(documentState)) return false;
    const layerStates = Array.isArray(documentState.layers)
      ? documentState.layers.filter(layer => layer && typeof layer === 'object')
      : [];
    if (!layerStates.length) return false;

    const width = Math.max(1, Math.min(8192, Math.round(Number(documentState.width) || this.W || 1)));
    const height = Math.max(1, Math.min(8192, Math.round(Number(documentState.height) || this.H || 1)));
    if (width !== this._docW || height !== this._docH) {
      await this.resizeDocument(width, height, this.bgColorEl?.value || '#ffffff');
    }

    const restoredLayers = await Promise.all(layerStates.map(async (layerState, index) => {
      const { canvas, ctx } = this.makeLayerCanvas();
      const layer = this._createLayerRecord(canvas, ctx, {
        id: typeof layerState.id === 'string' && layerState.id.trim() ? layerState.id.trim() : undefined,
        name: typeof layerState.name === 'string' && layerState.name.trim()
          ? layerState.name.trim()
          : (layerState.isBackground ? 'Background' : `Layer ${index + 1}`),
        visible: layerState.visible !== false,
        opacity: Number.isFinite(Number(layerState.opacity))
          ? Math.max(0, Math.min(1, Number(layerState.opacity)))
          : 1,
        blend: typeof layerState.blend === 'string' ? layerState.blend : 'source-over',
        alphaLock: !!layerState.alphaLock,
        isBackground: !!layerState.isBackground,
      });
      if (typeof layerState.dataUrl === 'string' && layerState.dataUrl.startsWith('data:image/')) {
        const sourceCanvas = await this._canvasFromDataUrl(layerState.dataUrl);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      layer.dirty = true;
      layer.dirtyTiles = null;
      return layer;
    }));

    const backgroundIndex = restoredLayers.findIndex(layer => layer.isBackground);
    if (backgroundIndex >= 0 && backgroundIndex !== restoredLayers.length - 1) {
      const [backgroundLayer] = restoredLayers.splice(backgroundIndex, 1);
      restoredLayers.push(backgroundLayer);
    }

    if (!restoredLayers.some(layer => layer.isBackground)) {
      const { canvas, ctx } = this.makeLayerCanvas();
      restoredLayers.push(this._createLayerRecord(canvas, ctx, {
        name: 'Background',
        isBackground: true,
      }));
    }

    for (const layer of this.layers) this.compositor?.deleteLayerTex(layer);
    this.layers = restoredLayers;

    const nextLayerId = Math.round(Number(documentState.nextLayerId));
    if (Number.isFinite(nextLayerId)) {
      this._nextLayerId = Math.max(this._nextLayerId, nextLayerId);
    }

    const activeLayerId = typeof documentState.activeLayerId === 'string' ? documentState.activeLayerId.trim() : '';
    let nextActiveLayer = activeLayerId
      ? this.layers.findIndex(layer => layer.id === activeLayerId && !layer.isBackground)
      : -1;
    if (nextActiveLayer < 0) {
      const activeLayerIndex = Math.round(Number(documentState.activeLayerIndex));
      if (Number.isFinite(activeLayerIndex)
        && activeLayerIndex >= 0
        && activeLayerIndex < this.layers.length
        && !this.layers[activeLayerIndex].isBackground) {
        nextActiveLayer = activeLayerIndex;
      }
    }
    if (nextActiveLayer < 0) {
      nextActiveLayer = this.layers.findIndex(layer => !layer.isBackground);
    }
    this.activeLayerIdx = Math.max(0, nextActiveLayer);

    this._docSized = documentState.docSized === true;
    this._docW = width;
    this._docH = height;

    const backgroundLayer = this.layers.find(layer => layer.isBackground);
    if (backgroundLayer && !layerStates.some(layer => layer && layer.isBackground)) {
      this._fillBackgroundLayer();
    }

    this._syncLayerSwitcher();
    this._syncAlphaLockUI();
    syncUI(this);
    this.compositeAllLayers({ forceFull: true });
    return true;
  }

  saveSession() {
    try {
      this._syncActiveSimulationSessionFromDraft();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._captureSessionControls()));
    } catch { /* quota exceeded — ignore */ }
  }

  _readWorkspacePresets() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  _sanitizeWorkspacePresets(presets) {
    return presets && typeof presets === 'object' && !Array.isArray(presets)
      ? _deepClone(presets)
      : {};
  }

  createWorkspaceSettingsBundle({ includeDocument = false } = {}) {
    this.saveSession();
    const autoSaveValue = (() => {
      try {
        return localStorage.getItem(AUTOSAVE_STORAGE_KEY) === '1';
      } catch {
        return !!document.getElementById('autoSaveSession')?.checked;
      }
    })();
    const bundle = {
      format: WORKSPACE_SETTINGS_FORMAT,
      version: WORKSPACE_SETTINGS_VERSION,
      exportedAt: new Date().toISOString(),
      appBuildId: APP_BUILD_ID,
      session: this._captureSessionControls(),
      presets: this._readWorkspacePresets(),
      autosaveEnabled: autoSaveValue,
    };
    if (includeDocument) bundle.document = this._captureWorkspaceDocumentState();
    return bundle;
  }

  createWorkspaceFileBundle() {
    return this.createWorkspaceSettingsBundle({ includeDocument: true });
  }

  exportWorkspaceFile() {
    try {
      const bundle = this.createWorkspaceFileBundle();
      const stamp = new Date().toISOString().replace(/[.:]/g, '-');
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      this._downloadBlob(blob, `boid-brush-workspace-${stamp}.json`);
      this.showToast('💾 Workspace file saved');
      return true;
    } catch (error) {
      console.error('Workspace file export failed:', error);
      this.showToast('⚠ Workspace file export failed');
      return false;
    }
  }

  exportWorkspaceSettingsFile() {
    return this.exportWorkspaceFile();
  }

  _normalizeWorkspaceSettingsBundle(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw new Error('Invalid workspace payload');
    }
    if (bundle.format === WORKSPACE_SETTINGS_FORMAT) {
      return {
        session: bundle.session,
        presets: Object.prototype.hasOwnProperty.call(bundle, 'presets') ? bundle.presets : {},
        autosaveValue: bundle.autosaveEnabled === true ? '1' : '0',
        document: bundle.document && typeof bundle.document === 'object' && !Array.isArray(bundle.document)
          ? _deepClone(bundle.document)
          : null,
      };
    }
    if (Object.prototype.hasOwnProperty.call(bundle, 'session') || Object.prototype.hasOwnProperty.call(bundle, 'presets')) {
      return {
        session: bundle.session,
        presets: Object.prototype.hasOwnProperty.call(bundle, 'presets') ? bundle.presets : this._readWorkspacePresets(),
        autosaveValue: bundle.autosaveEnabled === true || bundle.autosave === '1'
          ? '1'
          : (bundle.autosaveEnabled === false || bundle.autosave === '0' ? '0' : null),
        document: bundle.document && typeof bundle.document === 'object' && !Array.isArray(bundle.document)
          ? _deepClone(bundle.document)
          : null,
      };
    }
    return {
      session: bundle,
      presets: this._readWorkspacePresets(),
      autosaveValue: null,
      document: null,
    };
  }

  async applyWorkspaceSettingsBundle(bundle) {
    const normalized = this._normalizeWorkspaceSettingsBundle(bundle);
    if (!normalized.session || typeof normalized.session !== 'object' || Array.isArray(normalized.session)) {
      throw new Error('Workspace bundle is missing session settings');
    }
    this.stopSimulation(false);
    if (this.selectionMgr?.active) {
      this.selectionMgr.clear();
      this._syncSelectionUI();
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized.session));
    localStorage.setItem(PRESETS_KEY, JSON.stringify(this._sanitizeWorkspacePresets(normalized.presets)));
    await this._restoreSession();
    if (normalized.document) {
      await this._restoreWorkspaceDocumentState(normalized.document);
    }
    const checkbox = document.getElementById('autoSaveSession');
    const autoSaveValue = normalized.autosaveValue ?? (checkbox?.checked ? '1' : '0');
    try {
      localStorage.setItem(AUTOSAVE_STORAGE_KEY, autoSaveValue);
    } catch { /* ignore localStorage failures */ }
    if (checkbox) checkbox.checked = autoSaveValue === '1';
    this.compositeAllLayers({ forceFull: true });
    return true;
  }

  async importWorkspaceSettingsText(rawText) {
    const parsed = JSON.parse(rawText);
    return this.applyWorkspaceSettingsBundle(parsed);
  }

  _applyControlState(controls = {}) {
    for (const [id, val] of Object.entries(controls)) {
      if (id === '_docSized' || id === '_docW' || id === '_docH') continue;
      if (id === '_view') continue;
      if (id === '_canvasTextureState') continue;
      if (id === '_stampImageState') continue;
      if (id === 'primaryColor' || id === '_primaryColor') { this.setColorValue('primary', val); continue; }
      if (id === 'secondaryColor' || id === '_secondaryColor') { this.setColorValue('secondary', val); continue; }
      if (id === 'bgColor') { this.setBackgroundColor(val); continue; }
      if (id === 'activeBrush' || id === '_activeBrush') { this.setBrush(val); continue; }
      if (id === 'activeTool' || id === '_activeTool') { this.setTool(typeof val === 'string' ? val : 'brush'); continue; }
      if (id === '_colorHistory') {
        if (Array.isArray(val)) {
          this._colorHistory = val.filter(v => typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v));
        }
        this._renderColorHistory();
        continue;
      }
      if (id === '_tilingMode') {
        this.tilingMode = !!val;
        this._syncTilingUI();
        continue;
      }
      if (id === '_viewBookmarks') {
        this.viewBookmarks = this._sanitizeViewBookmarks(val);
        this._renderViewBookmarksPanel?.();
        continue;
      }
      if (id === '_lastChangeMarker') {
        this.lastChangeMarker = this._sanitizeLastChangeMarker(val);
        this._renderViewBookmarksPanel?.();
        continue;
      }
      if (id === '_simulation') {
        if (val?.brushData) this.simulation.brushData = val.brushData;
        if (typeof val?.editorTool === 'string') this.simulation.editorTool = val.editorTool;
        if (typeof val?.nextId === 'number') this.simulation.nextId = val.nextId;
        this.simulation.enabled = !!val?.enabled;
        this.simulation.guidesVisible = val?.guidesVisible !== false;
        this.simulation.heatmapVisible = !!val?.heatmapVisible;
        this.simulation.hudCollapsed = !!val?.hudCollapsed;
        this.simulation.inspectorCollapsed = !!val?.inspectorCollapsed;
        this.simulation.inspectorSections = _normalizeSimulationInspectorSections(val?.inspectorSections);
        if (val?.vars && typeof val.vars === 'object') {
          this.simulation.vars = _normalizeSimulationVars(val.vars);
        }
        if (Array.isArray(val?.sessions)) {
          this.simulation.sessions = val.sessions
            .filter(session => session && typeof session === 'object')
            .map(session => ({
              ...session,
              vars: _normalizeSimulationVars(session.vars),
              controlState: _sanitizeSimulationSessionData(session.controlState) || {},
              paramSnapshot: _sanitizeSimulationSessionData(session.paramSnapshot) || {},
              sensingSourceSelection: _normalizeSimulationSensingSourceSelection(session.sensingSourceSelection),
              savedPlayback: _normalizeSimulationSavedPlayback(session.savedPlayback),
            }));
        }
        this.simulation.activeSessionIndex = Number.isFinite(val?.activeSessionIndex) ? Math.round(val.activeSessionIndex) : -1;
        this.simulation.savedPlayback = _normalizeSimulationSavedPlayback(val?.savedPlayback);
        this.simulation.multiSessionEnabled = !!val?.multiSessionEnabled;
        this.simulation.multiSessionBindings = Array.isArray(val?.multiSessionBindings) ? _deepClone(val.multiSessionBindings) : [];
        // Older saves predate the submode entirely — missing `mode`/`forceViz`
        // falls back to 'normal' plus the default scenario via normalization.
        this.simulation.mode = val?.mode === 'forceVisualization' ? 'forceVisualization' : 'normal';
        this.simulation.forceViz = val?.forceViz && typeof val.forceViz === 'object' ? _deepClone(val.forceViz) : null;
        // A persisted session owns its own manual-view baseline. Discard any
        // runtime snapshot from the previously open workspace; _restoreSession
        // captures the restored view after `_view` has been applied.
        this._forceVizManualViewSnapshot = null;
        this._normalizeForceVizState();
        continue;
      }
      if (id === '_symmetryState') {
        this.symmetry = this._normalizeSymmetryState(val);
        continue;
      }
      if (id === '_sensingSourceSelection') {
        this._restoreSensingSourceSelection(val);
        continue;
      }
      if (id === '_motionPath') {
        if (val && typeof val === 'object') {
          this.motionPath = {
            ...this.motionPath,
            ..._deepClone(val),
            editorOpen: false,
            previousUiState: null,
          };
        }
        continue;
      }
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val;
    }
    this._normalizeSimulationSessionBindings();
    if (this.simulation.activeSessionIndex >= 0) {
      this._applySimulationSessionToDraft(this.simulation.sessions[this.simulation.activeSessionIndex]);
    }
  }

  async _applyFactoryDefaults() {
    await this._loadDefaultStampImage({ enable: true });
    this.viewBookmarks = [];
    this.lastChangeMarker = null;
    this.symmetry = this._createDefaultSymmetryState();
    this._symmetryDrag = null;
    this._clearSymmetryStrokeState();
    this._applyControlState(FACTORY_DEFAULTS);
    await this.resizeDocument(FACTORY_DEFAULTS._docW || 1024, FACTORY_DEFAULTS._docH || 1024, FACTORY_DEFAULTS.bgColor || '#313131');
    this._paramsDirty = true;
    syncUI(this);
    this._renderViewBookmarksPanel?.();
    this._normalizeSimulationData();
    this._ensureSimulationSpawns();
    this._normalizeMotionPathState();
    this._syncMotionPathUI();
    this._syncSimulationUI();
  }

  async _restoreSession() {
    try {
      await this._ensureBuiltinCanvasTexture();
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        await this._applyFactoryDefaults();
        return;
      }
      const controls = JSON.parse(raw);
      const hasSavedStampImageState = Object.prototype.hasOwnProperty.call(controls, '_stampImageState');
      const restoredView = controls && typeof controls._view === 'object' && !Array.isArray(controls._view)
        ? controls._view
        : null;
      if (controls._canvasTextureState) {
        await this._restoreCanvasTextureState(controls._canvasTextureState);
      }
      if (hasSavedStampImageState) {
        await this._restoreCustomStampImageState(controls._stampImageState);
      } else {
        await this._loadDefaultStampImage({ enable: true });
      }
      this.viewBookmarks = [];
      this.lastChangeMarker = null;
      this._applyControlState(controls);
      if (!hasSavedStampImageState && this.activeBrush === 'boid') {
        const stampImageToggle = document.getElementById('stampImageEnabled');
        if (stampImageToggle?.checked) stampImageToggle.checked = false;
      }
      this._paramsDirty = true;
      syncUI(this);
      this._normalizeSimulationData();
      this._ensureSimulationSpawns();
      this._normalizeMotionPathState();
      this._syncMotionPathUI();
      this._syncSimulationUI();
      if (controls._docSized && controls._docW && controls._docH) {
        await this.resizeDocument(controls._docW, controls._docH, this.bgColorEl?.value || '#ffffff');
      }
      if (restoredView) this._applyViewState(restoredView);
      this._forceVizManualViewSnapshot = this.simulation.mode === 'forceVisualization'
        ? this._captureViewState()
        : null;
      if (this.activeTool === 'transform' && !this.selectionMgr?.active) {
        this.setTool('brush');
      }
    } catch {
      await this._applyFactoryDefaults();
    }
  }

  // ========================================================
  // UTILITIES
  // ========================================================

  showToast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }

  _handleInitError(error) {
    console.error('App init failed:', error);
    const message = error?.message || 'Unknown startup error';
    this.setStatus(`Startup failed: ${message}`);
    this.showToast('⚠ Startup failed');
  }

  async _clearReloadCaches() {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.allSettled(keys.map(key => caches.delete(key)));
      }
    } catch { /* ignore cache API failures */ }

    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(registrations.map(reg => reg.unregister()));
      }
    } catch { /* ignore SW failures */ }
  }

  _clearAppLocalStorage(namespace = 'bb_') {
    try {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(namespace)) {
          try { localStorage.removeItem(key); } catch { /* ignore localStorage failures */ }
        }
      }
    } catch { /* ignore localStorage failures */ }
  }

  _clearReloadStorageArtifacts({ wipeSession = false } = {}) {
    if (wipeSession) {
      // Wipe every app-owned key so the next boot behaves like a first visit.
      this._clearAppLocalStorage();
    } else {
      try {
        localStorage.removeItem(BUILD_ID_STORAGE_KEY);
      } catch { /* ignore localStorage failures */ }
    }

    try { sessionStorage.clear(); } catch { /* ignore sessionStorage failures */ }

    // Best-effort cookie eviction for same-origin readable cookies.
    try {
      const cookieNames = document.cookie
        .split(';')
        .map(part => part.split('=')[0]?.trim())
        .filter(Boolean);
      for (const name of cookieNames) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax`;
      }
    } catch { /* ignore cookie failures */ }
  }

  async reloadAppWithCacheBust({ wipeSession = false } = {}) {
    const btn = document.getElementById('reloadAppBtn');
    if (btn) btn.disabled = true;
    this.setStatus(wipeSession ? 'Reloading app (clearing saved data and caches)…' : 'Reloading app (clearing caches)…');
    await this._clearReloadCaches();
    this._clearReloadStorageArtifacts({ wipeSession });
    const url = new URL(window.location.href);
    url.searchParams.set('bb_reload', `${Date.now()}`);
    window.location.replace(url.toString());
  }

  _announceBuildLoad() {
    let previousBuildId = '';
    try {
      previousBuildId = localStorage.getItem(BUILD_ID_STORAGE_KEY) || '';
      localStorage.setItem(BUILD_ID_STORAGE_KEY, APP_BUILD_ID);
    } catch { /* ignore storage failures */ }
    if (!previousBuildId) {
      this.showToast(`Build ${APP_BUILD_ID} loaded`);
      return;
    }
    if (previousBuildId !== APP_BUILD_ID) {
      this.showToast(`Updated build: ${previousBuildId} → ${APP_BUILD_ID}`);
    }
  }

  setStatus(msg) {
    this.statusEl.textContent = `${msg} · Build ${APP_BUILD_ID}`;
  }
}
