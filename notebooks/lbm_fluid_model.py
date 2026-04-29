from __future__ import annotations

from dataclasses import dataclass, replace
import math
import random
from typing import Iterable, Mapping, Sequence


DEFAULT_RGBA = (52, 122, 214, 0.72)
ALPHA_THRESHOLD = 8
CENTER_WEIGHT = 1.8
FRAME_RATE_SCALE = 60.0
SPH_DECAY_MULTIPLIER = 60.0
EULERIAN_DECAY_MULTIPLIER = 42.0
LBM_DECAY_MULTIPLIER = 36.0


@dataclass
class FluidParams:
    particle_radius: float = 4.0
    viscosity: float = 0.45
    density: float = 0.70
    surface_tension: float = 0.58
    time_step: float = 1.0
    substeps: int = 3
    motion_decay: float = 0.12
    stop_speed: float = 0.03
    resolution_scale: float = 1.0
    fluid_scale: float = 1.0
    simulation_type: str = 'lbm'


@dataclass
class FluidParticle:
    x: float
    y: float
    vx: float = 0.0
    vy: float = 0.0
    radius: float = 4.0
    rgba: tuple[float, float, float, float] = DEFAULT_RGBA
    outside_slack: float = 0.0

    def copy(self) -> 'FluidParticle':
        return FluidParticle(
            x=self.x,
            y=self.y,
            vx=self.vx,
            vy=self.vy,
            radius=self.radius,
            rgba=self.rgba,
            outside_slack=self.outside_slack,
        )


class NotebookLBMFluidModel:
    """Python notebook port of the JS fallback fluid model.

    This mirrors the fallback simulator in playground/fluid_playground.js so the
    LBM-style fluid math can be iterated inside Jupyter without the brush/UI.
    The main methods to tweak are build_velocity_field(), step_lbm(), and
    advance_particle().
    """

    def __init__(self, display_width: int, display_height: int, params: FluidParams | Mapping[str, float] | None = None, random_seed: int = 0):
        self.display_width = max(1, int(display_width))
        self.display_height = max(1, int(display_height))
        self._rng = random.Random(random_seed)
        self.params = FluidParams()
        self.internal_width = 0
        self.internal_height = 0
        self.mask_alpha: list[int] = []
        self.mask_has_content = False
        self.velocity_field: list[float] = []
        self._particles: list[FluidParticle] = []
        self.update_params(params or {})

    @property
    def particles_internal(self) -> list[FluidParticle]:
        return self._particles

    def update_params(self, params: FluidParams | Mapping[str, float] | None = None) -> None:
        if params is None:
            next_params = self.params
        elif isinstance(params, FluidParams):
            next_params = params
        else:
            next_params = replace(self.params, **dict(params))
        self.params = next_params
        width, height = self._target_size(next_params)
        if width != self.internal_width or height != self.internal_height:
            self.internal_width = width
            self.internal_height = height
            self.mask_alpha = [255] * (width * height)
            self.mask_has_content = False
            self.velocity_field = [0.0] * (width * height * 2)
            self._particles = []

    def set_mask(self, mask: Sequence[Sequence[int | float | bool]] | None) -> None:
        if mask is None:
            self.mask_alpha = [255] * (self.internal_width * self.internal_height)
            self.mask_has_content = False
            return
        rows = [list(row) for row in mask]
        source_height = len(rows)
        source_width = len(rows[0]) if rows else 0
        if not source_width or not source_height:
            self.mask_alpha = [255] * (self.internal_width * self.internal_height)
            self.mask_has_content = False
            return
        scaled: list[int] = [0] * (self.internal_width * self.internal_height)
        has_content = False
        for y in range(self.internal_height):
            source_y = min(source_height - 1, int(y * source_height / self.internal_height))
            row = rows[source_y]
            for x in range(self.internal_width):
                source_x = min(source_width - 1, int(x * source_width / self.internal_width))
                value = row[source_x]
                alpha = 255 if bool(value) else 0
                if isinstance(value, (int, float)):
                    alpha = max(0, min(255, int(value)))
                scaled[y * self.internal_width + x] = alpha
                has_content = has_content or alpha > ALPHA_THRESHOLD
        self.mask_alpha = scaled
        self.mask_has_content = has_content

    def clear_particles(self) -> None:
        self._particles = []

    def add_particles(self, particles: Iterable[FluidParticle | Mapping[str, float]]) -> None:
        scale_x = self.internal_width / self.display_width
        scale_y = self.internal_height / self.display_height
        scale_avg = (scale_x + scale_y) * 0.5
        for particle in particles:
            if isinstance(particle, FluidParticle):
                x = particle.x * scale_x
                y = particle.y * scale_y
                vx = particle.vx * scale_x
                vy = particle.vy * scale_y
                radius = particle.radius * scale_avg
                rgba = particle.rgba
            else:
                data = dict(particle)
                x = float(data.get('x', 0.0)) * scale_x
                y = float(data.get('y', 0.0)) * scale_y
                vx = float(data.get('vx', 0.0)) * scale_x
                vy = float(data.get('vy', 0.0)) * scale_y
                radius = float(data.get('radius', self.params.particle_radius)) * scale_avg
                rgba = data.get('rgba', DEFAULT_RGBA)
            if self.inside_mask_internal(x, y):
                self._particles.append(FluidParticle(x=x, y=y, vx=vx, vy=vy, radius=radius, rgba=rgba))

    def seed_disc(self, cx: float, cy: float, count: int, radius: float | None = None, initial_speed: float = 0.0, rgba: tuple[float, float, float, float] = DEFAULT_RGBA) -> None:
        radius = self.params.particle_radius * 5 if radius is None else radius
        particles: list[FluidParticle] = []
        for _ in range(max(0, int(count))):
            angle = self._rng.random() * math.tau
            distance = math.sqrt(self._rng.random()) * radius
            speed = initial_speed * (0.4 + self._rng.random() * 0.8)
            particles.append(
                FluidParticle(
                    x=cx + math.cos(angle) * distance,
                    y=cy + math.sin(angle) * distance,
                    vx=math.cos(angle) * speed,
                    vy=math.sin(angle) * speed,
                    radius=self.params.particle_radius,
                    rgba=rgba,
                )
            )
        self.add_particles(particles)

    def step(self, dt: float = 1 / 60) -> None:
        if not self._particles:
            return
        scaled_dt = max(0.0005, dt) * self.params.time_step
        substeps = max(1, int(self.params.substeps))
        step_dt = scaled_dt / substeps
        for _ in range(substeps):
            if self.params.simulation_type == 'eulerian':
                self.step_eulerian(step_dt)
            elif self.params.simulation_type == 'sph':
                self.step_sph(step_dt)
            else:
                self.step_lbm(step_dt)

    def step_sph(self, step_dt: float) -> None:
        interaction_radius = max(4.0, self.params.particle_radius * 2.8)
        interaction_radius_sq = interaction_radius * interaction_radius
        delta = [(0.0, 0.0) for _ in self._particles]
        for index in range(len(self._particles)):
            for neighbor in range(index + 1, len(self._particles)):
                left = self._particles[index]
                right = self._particles[neighbor]
                dx = right.x - left.x
                dy = right.y - left.y
                dist_sq = dx * dx + dy * dy
                if dist_sq <= 0.0001 or dist_sq > interaction_radius_sq:
                    continue
                dist = math.sqrt(dist_sq)
                influence = 1 - dist / interaction_radius
                nx = dx / dist
                ny = dy / dist
                repel = influence * (0.025 + self.params.density * 0.11)
                viscosity = influence * self.params.viscosity * 0.08
                li_dx, li_dy = delta[index]
                ri_dx, ri_dy = delta[neighbor]
                delta[index] = (
                    li_dx - nx * repel + (right.vx - left.vx) * viscosity,
                    li_dy - ny * repel + (right.vy - left.vy) * viscosity,
                )
                delta[neighbor] = (
                    ri_dx + nx * repel + (left.vx - right.vx) * viscosity,
                    ri_dy + ny * repel + (left.vy - right.vy) * viscosity,
                )
        decay = max(0.0, min(1.0, 1 - self.params.motion_decay * step_dt * SPH_DECAY_MULTIPLIER))
        for particle, (delta_x, delta_y) in zip(self._particles, delta):
            particle.vx += delta_x * step_dt * FRAME_RATE_SCALE
            particle.vy += delta_y * step_dt * FRAME_RATE_SCALE
            particle.vx *= decay
            particle.vy *= decay
            self.advance_particle(particle, step_dt)

    def step_eulerian(self, step_dt: float) -> None:
        self.build_velocity_field(flow_scale=0.22, swirl_scale=0.16)
        flow_strength = 0.38 + self.params.density * 0.44
        diffusion = 0.08 + self.params.viscosity * 0.24
        decay = max(0.0, min(1.0, 1 - self.params.motion_decay * step_dt * EULERIAN_DECAY_MULTIPLIER))
        for particle in self._particles:
            field_x, field_y = self.sample_velocity_field_internal(particle.x, particle.y)
            particle.vx += (field_x * flow_strength - particle.vx) * diffusion
            particle.vy += (field_y * flow_strength - particle.vy) * diffusion
            particle.vx *= decay
            particle.vy *= decay
            self.advance_particle(particle, step_dt)

    def step_lbm(self, step_dt: float) -> None:
        self.build_velocity_field(flow_scale=0.34, swirl_scale=0.30)
        relaxation = 0.18 + self.params.viscosity * 0.34
        pressure = 0.2 + self.params.density * 0.5
        decay = max(0.0, min(1.0, 1 - self.params.motion_decay * step_dt * LBM_DECAY_MULTIPLIER))
        for particle in self._particles:
            field_x, field_y = self.sample_velocity_field_internal(particle.x, particle.y)
            swirl_x = -field_y * pressure
            swirl_y = field_x * pressure
            particle.vx += (field_x + swirl_x - particle.vx) * relaxation
            particle.vy += (field_y + swirl_y - particle.vy) * relaxation
            particle.vx *= decay
            particle.vy *= decay
            self.advance_particle(particle, step_dt)

    def build_velocity_field(self, flow_scale: float = 0.34, swirl_scale: float = 0.30) -> None:
        width = self.internal_width
        height = self.internal_height
        self.velocity_field = [0.0] * (width * height * 2)
        counts = [0.0] * (width * height)
        for particle in self._particles:
            ix = clamp(round(particle.x), 0, width - 1)
            iy = clamp(round(particle.y), 0, height - 1)
            base = (iy * width + ix) * 2
            self.velocity_field[base] += particle.vx
            self.velocity_field[base + 1] += particle.vy
            counts[iy * width + ix] += 1.0
        for iy in range(height):
            for ix in range(width):
                index = iy * width + ix
                if not self.mask_alpha[index]:
                    continue
                sum_x = 0.0
                sum_y = 0.0
                sum_w = 0.0
                for oy in (-1, 0, 1):
                    for ox in (-1, 0, 1):
                        nx = ix + ox
                        ny = iy + oy
                        if nx < 0 or ny < 0 or nx >= width or ny >= height:
                            continue
                        n_index = ny * width + nx
                        if not self.mask_alpha[n_index]:
                            continue
                        weight = CENTER_WEIGHT if ox == 0 and oy == 0 else 1.0
                        count = max(1.0, counts[n_index])
                        base = n_index * 2
                        sum_x += (self.velocity_field[base] / count) * weight
                        sum_y += (self.velocity_field[base + 1] / count) * weight
                        sum_w += weight
                grad_x = self.sample_mask_internal(ix + 1, iy) - self.sample_mask_internal(ix - 1, iy)
                grad_y = self.sample_mask_internal(ix, iy + 1) - self.sample_mask_internal(ix, iy - 1)
                base = index * 2
                self.velocity_field[base] = (sum_x / max(1.0, sum_w)) * flow_scale - grad_y * swirl_scale
                self.velocity_field[base + 1] = (sum_y / max(1.0, sum_w)) * flow_scale + grad_x * swirl_scale

    def sample_velocity_field_internal(self, x: float, y: float) -> tuple[float, float]:
        ix = clamp(round(x), 0, self.internal_width - 1)
        iy = clamp(round(y), 0, self.internal_height - 1)
        base = (iy * self.internal_width + ix) * 2
        return self.velocity_field[base], self.velocity_field[base + 1]

    def sample_velocity_field(self, x: float, y: float) -> tuple[float, float]:
        scale_x = self.internal_width / self.display_width
        scale_y = self.internal_height / self.display_height
        vx, vy = self.sample_velocity_field_internal(x * scale_x, y * scale_y)
        return vx / scale_x, vy / scale_y

    def sample_mask_internal(self, x: int, y: int) -> int:
        if not self.mask_has_content:
            return 1 if 0 <= x < self.internal_width and 0 <= y < self.internal_height else 0
        ix = clamp(x, 0, self.internal_width - 1)
        iy = clamp(y, 0, self.internal_height - 1)
        return 1 if self.mask_alpha[iy * self.internal_width + ix] > ALPHA_THRESHOLD else 0

    def inside_mask_internal(self, x: float, y: float) -> bool:
        ix = round(x)
        iy = round(y)
        if ix < 0 or iy < 0 or ix >= self.internal_width or iy >= self.internal_height:
            return False
        if not self.mask_has_content:
            return True
        return self.mask_alpha[iy * self.internal_width + ix] > ALPHA_THRESHOLD

    def advance_particle(self, particle: FluidParticle, step_dt: float) -> None:
        speed = math.hypot(particle.vx, particle.vy)
        if speed < self.params.stop_speed:
            particle.vx = 0.0
            particle.vy = 0.0
        next_x = particle.x + particle.vx * step_dt * FRAME_RATE_SCALE
        next_y = particle.y + particle.vy * step_dt * FRAME_RATE_SCALE
        if self.inside_mask_internal(next_x, next_y):
            particle.x = clamp(next_x, 0, self.internal_width - 1)
            particle.y = clamp(next_y, 0, self.internal_height - 1)
            particle.outside_slack = 0.0
            return
        snap_x, snap_y = self.find_inside_point(particle.x, particle.y, next_x, next_y)
        overshoot = math.hypot(next_x - snap_x, next_y - snap_y)
        leeway = self.boundary_leeway(particle, speed, step_dt)
        if overshoot <= leeway:
            particle.x = clamp(next_x, 0, self.internal_width - 1)
            particle.y = clamp(next_y, 0, self.internal_height - 1)
            particle.vx *= 0.96
            particle.vy *= 0.96
            particle.outside_slack = overshoot
        else:
            particle.x = snap_x
            particle.y = snap_y
            particle.vx *= -0.18
            particle.vy *= -0.18
            particle.outside_slack = 0.0

    def boundary_leeway(self, particle: FluidParticle, speed: float, step_dt: float) -> float:
        travel = max(0.0, speed - self.params.stop_speed) * step_dt * FRAME_RATE_SCALE
        force_bias = 1 + self.params.density * 0.9 + self.params.viscosity * 0.35
        base = particle.radius * (0.18 + self.params.density * 0.22)
        return clamp(base + travel * 0.9 * force_bias, 0.0, particle.radius * 1.9 + 10)

    def find_inside_point(self, fallback_x: float, fallback_y: float, next_x: float, next_y: float) -> tuple[float, float]:
        if self.inside_mask_internal(fallback_x, fallback_y):
            return clamp(fallback_x, 0, self.internal_width - 1), clamp(fallback_y, 0, self.internal_height - 1)
        for step in range(14):
            ratio = step / 13
            x = next_x + (fallback_x - next_x) * ratio
            y = next_y + (fallback_y - next_y) * ratio
            if self.inside_mask_internal(x, y):
                return clamp(x, 0, self.internal_width - 1), clamp(y, 0, self.internal_height - 1)
        return clamp(fallback_x, 0, self.internal_width - 1), clamp(fallback_y, 0, self.internal_height - 1)

    def build_density_grid(self, normalize: bool = False) -> list[list[float]]:
        grid = [[0.0 for _ in range(self.internal_width)] for _ in range(self.internal_height)]
        for particle in self._particles:
            ix = clamp(round(particle.x), 0, self.internal_width - 1)
            iy = clamp(round(particle.y), 0, self.internal_height - 1)
            grid[iy][ix] += 1.0
        if normalize:
            peak = max((max(row) for row in grid), default=0.0)
            if peak > 0:
                grid = [[value / peak for value in row] for row in grid]
        return grid

    def build_speed_grid(self, normalize: bool = False) -> list[list[float]]:
        grid = [[0.0 for _ in range(self.internal_width)] for _ in range(self.internal_height)]
        for y in range(self.internal_height):
            for x in range(self.internal_width):
                vx, vy = self.sample_velocity_field_internal(x, y)
                grid[y][x] = math.hypot(vx, vy)
        if normalize:
            peak = max((max(row) for row in grid), default=0.0)
            if peak > 0:
                grid = [[value / peak for value in row] for row in grid]
        return grid

    def quiver(self, stride: int = 8) -> tuple[list[float], list[float], list[float], list[float]]:
        xs: list[float] = []
        ys: list[float] = []
        us: list[float] = []
        vs: list[float] = []
        stride = max(1, int(stride))
        scale_x = self.display_width / self.internal_width
        scale_y = self.display_height / self.internal_height
        for y in range(0, self.internal_height, stride):
            for x in range(0, self.internal_width, stride):
                vx, vy = self.sample_velocity_field_internal(x, y)
                xs.append((x + 0.5) * scale_x)
                ys.append((y + 0.5) * scale_y)
                us.append(vx / scale_x)
                vs.append(vy / scale_y)
        return xs, ys, us, vs

    def particles(self) -> list[FluidParticle]:
        scale_x = self.display_width / self.internal_width
        scale_y = self.display_height / self.internal_height
        return [
            FluidParticle(
                x=particle.x * scale_x,
                y=particle.y * scale_y,
                vx=particle.vx * scale_x,
                vy=particle.vy * scale_y,
                radius=particle.radius * ((scale_x + scale_y) * 0.5),
                rgba=particle.rgba,
                outside_slack=particle.outside_slack,
            )
            for particle in self._particles
        ]

    def _target_size(self, params: FluidParams) -> tuple[int, int]:
        scale = float(params.resolution_scale) or 1.0
        fluid_scale = max(0.35, float(params.fluid_scale) or 1.0)
        return (
            max(96, round((self.display_width * scale) / fluid_scale)),
            max(72, round((self.display_height * scale) / fluid_scale)),
        )


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))
