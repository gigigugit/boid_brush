// =============================================================================
// spatial.rs — Uniform grid spatial hash for boid neighbor queries
//
// # Algorithm
// The simulation canvas is divided into a uniform grid of cells. Each cell is
// `cell_size` pixels wide and tall, where:
//
//   cell_size = max(neighbor_radius, separation_radius, MIN_CELL_SIZE)
//
// Each frame, `build()` assigns every live agent to exactly one cell using a
// three-pass counting sort (O(n + num_cells) total, zero heap allocation):
//
//   Pass 1 — for each live agent: compute cell index, increment cell count.
//   Pass 2 — prefix-sum cell counts → per-cell start offsets in `sorted[]`.
//   Pass 3 — fill `sorted[]` with agent indices, grouped by cell.
//
// A neighbor query then inspects only the 3×3 cell neighborhood around the
// querying agent. Agents in cells ≥2 steps away have distance ≥ cell_size
// ≥ max(neighbor_r, separation_r), so the strict `d² < r²` checks cannot
// pass for them — they can be skipped entirely.
//
// Complexity comparison:
//   Before (naive all-pairs):  O(n²) distance checks per frame
//   After (spatial grid):      O(n · k) checks, k = avg agents in 3×3 neighborhood
//
// For typical boid distributions (n = 60–500, neighbor_radius = 80 px,
// canvas ~1920×1080), k << n, yielding a significant practical speedup.
//
// # Memory model
// All scratch buffers (`cell_of`, `sorted`, `counts`, `starts`) are
// pre-allocated to `max_agents` / `max_cells` capacity at simulation init
// and reused every frame — zero per-frame heap allocation.
//
// Cell-level arrays are resized only when grid dimensions change (i.e., when
// neighbor_radius, canvas width, or canvas height changes), which is rare.
// =============================================================================

use crate::boid::*;

/// Minimum cell size in pixels. Prevents degenerate grids when radii are very
/// small on large canvases. At 20 px with a 4K canvas (3840×2160) the grid
/// is at most 192×108 = 20 736 cells.
const MIN_CELL_SIZE: f32 = 20.0;

/// Maximum cells per axis. Caps memory and computation when radii are tiny.
/// At 512 cells/axis × MIN_CELL_SIZE=20 px the largest supported canvas edge
/// is 10 240 px — well above any realistic browser canvas.
const MAX_GRID_DIM: u32 = 512;

/// Uniform-grid spatial hash for O(n·k) boid neighbor queries.
///
/// Build once per frame with `build()`, then query with `cell_agents()`.
pub struct SpatialGrid {
    /// Effective cell size (pixels), ≥ `MIN_CELL_SIZE`.
    pub cell_size: f32,
    /// Number of cells along the x-axis.
    pub grid_w: u32,
    /// Number of cells along the y-axis.
    pub grid_h: u32,
    /// `cell_of[i]` = flat cell index for live agent `i`; `u32::MAX` for dead agents.
    cell_of: Vec<u32>,
    /// Agent indices packed by cell (counting-sort output).
    sorted: Vec<u32>,
    /// Number of agents per cell (reset each frame; reused as fill cursor in pass 3).
    counts: Vec<u32>,
    /// First index in `sorted` belonging to each cell (prefix-sum of counts).
    starts: Vec<u32>,
}

impl SpatialGrid {
    /// Pre-allocate scratch buffers for up to `max_agents` agents.
    pub fn new(max_agents: usize) -> Self {
        Self {
            cell_size: 80.0,
            grid_w: 1,
            grid_h: 1,
            cell_of: vec![u32::MAX; max_agents],
            sorted: vec![0u32; max_agents],
            counts: vec![0u32; 1],
            starts: vec![0u32; 1],
        }
    }

    /// Rebuild the grid from current agent positions.
    ///
    /// Call once per frame *before* any `cell_agents()` queries.
    ///
    /// * `buf`          — flat agent buffer (STRIDE f32s per agent)
    /// * `agent_count`  — number of agents at the front of `buf` (may include dead ones)
    /// * `neighbor_r`   — cohesion / alignment query radius (pixels)
    /// * `separation_r` — separation query radius (pixels)
    /// * `width`, `height` — canvas dimensions (pixels)
    pub fn build(
        &mut self,
        buf: &[f32],
        agent_count: usize,
        neighbor_r: f32,
        separation_r: f32,
        width: u32,
        height: u32,
    ) {
        // Cell size must be ≥ the largest query radius so that the 3×3
        // cell neighborhood is both sufficient and exhaustive.
        let cs = neighbor_r.max(separation_r).max(MIN_CELL_SIZE);
        let gw = ((width as f32 / cs).ceil() as u32).clamp(1, MAX_GRID_DIM);
        let gh = ((height as f32 / cs).ceil() as u32).clamp(1, MAX_GRID_DIM);
        let nc = (gw * gh) as usize;

        // Resize cell-level arrays only when grid dimensions change.
        if gw != self.grid_w || gh != self.grid_h || self.counts.len() != nc {
            self.grid_w = gw;
            self.grid_h = gh;
            self.counts.resize(nc, 0);
            self.starts.resize(nc, 0);
        }
        self.cell_size = cs;

        // --- Pass 1: zero counts; assign each live agent to a cell index ---
        for c in &mut self.counts {
            *c = 0;
        }
        for i in 0..agent_count {
            let base = i * STRIDE;
            if !has_flag(buf, base, FLAG_ALIVE) {
                self.cell_of[i] = u32::MAX; // sentinel: excluded from grid
                continue;
            }
            // Saturating cast: negative positions → 0; NaN → 0 (Rust 1.45+ saturating f32→u32).
            let cx = ((buf[base + X] / cs) as u32).min(gw - 1);
            let cy = ((buf[base + Y] / cs) as u32).min(gh - 1);
            let cid = cy * gw + cx;
            self.cell_of[i] = cid;
            self.counts[cid as usize] += 1;
        }

        // --- Pass 2: prefix-sum → per-cell start offsets in sorted[] ---
        let mut offset = 0u32;
        for c in 0..nc {
            self.starts[c] = offset;
            offset += self.counts[c];
            self.counts[c] = 0; // reset; reused as fill cursor in pass 3
        }

        // --- Pass 3: place agent indices into sorted[] grouped by cell ---
        for i in 0..agent_count {
            let cid = self.cell_of[i];
            if cid == u32::MAX {
                continue; // dead agent — excluded
            }
            let slot = self.starts[cid as usize] + self.counts[cid as usize];
            self.sorted[slot as usize] = i as u32;
            self.counts[cid as usize] += 1;
        }
    }

    /// Return the grid cell coordinates `(cx, cy)` for a given agent index,
    /// using the cached `cell_of` assignment from the last `build()` call.
    ///
    /// Returns `(-1, -1)` for dead agents (cell_of == u32::MAX).
    /// Using this in the force loop avoids recomputing `pos / cell_size`.
    #[inline]
    pub fn agent_cell(&self, agent_index: usize) -> (i32, i32) {
        let cid = self.cell_of[agent_index];
        if cid == u32::MAX {
            return (-1, -1); // dead agent
        }
        ((cid % self.grid_w) as i32, (cid / self.grid_w) as i32)
    }

    /// Return the slice of agent indices in cell (`cx`, `cy`).
    ///
    /// Returns `&[]` when the cell coordinates are out of grid bounds.
    /// The returned indices are valid positions in the simulation's agent buffer.
    #[inline]
    pub fn cell_agents(&self, cx: i32, cy: i32) -> &[u32] {
        if cx < 0 || cy < 0 || cx >= self.grid_w as i32 || cy >= self.grid_h as i32 {
            return &[];
        }
        let cid = (cy as u32 * self.grid_w + cx as u32) as usize;
        let start = self.starts[cid] as usize;
        let end = start + self.counts[cid] as usize;
        &self.sorted[start..end]
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::Simulation;

    /// Helper: spawn an agent with a known alive flag.
    fn spawn(sim: &mut Simulation, x: f32, y: f32) {
        sim.spawn_one(x, y);
    }

    #[test]
    fn test_grid_cell_assignment() {
        // 200×200 canvas, neighbor_radius=100 → cell_size=100 → 2×2 grid
        let mut sim = Simulation::new(200, 200, 100);
        spawn(&mut sim, 50.0, 50.0); // agent 0 → cell (0,0)
        spawn(&mut sim, 150.0, 50.0); // agent 1 → cell (1,0)
        spawn(&mut sim, 50.0, 150.0); // agent 2 → cell (0,1)
        spawn(&mut sim, 150.0, 150.0); // agent 3 → cell (1,1)

        let mut grid = SpatialGrid::new(100);
        grid.build(&sim.buf, sim.agent_count, 100.0, 25.0, 200, 200);

        assert_eq!(grid.grid_w, 2);
        assert_eq!(grid.grid_h, 2);

        // Each quadrant has exactly one agent.
        assert_eq!(grid.cell_agents(0, 0).len(), 1, "cell (0,0)");
        assert_eq!(grid.cell_agents(1, 0).len(), 1, "cell (1,0)");
        assert_eq!(grid.cell_agents(0, 1).len(), 1, "cell (0,1)");
        assert_eq!(grid.cell_agents(1, 1).len(), 1, "cell (1,1)");

        // Correct agent indices
        assert_eq!(grid.cell_agents(0, 0)[0], 0);
        assert_eq!(grid.cell_agents(1, 0)[0], 1);
        assert_eq!(grid.cell_agents(0, 1)[0], 2);
        assert_eq!(grid.cell_agents(1, 1)[0], 3);

        // Out-of-bounds returns empty.
        assert_eq!(grid.cell_agents(-1, 0).len(), 0);
        assert_eq!(grid.cell_agents(2, 0).len(), 0);
        assert_eq!(grid.cell_agents(0, -1).len(), 0);
        assert_eq!(grid.cell_agents(0, 2).len(), 0);
    }

    #[test]
    fn test_grid_total_agent_count() {
        let mut sim = Simulation::new(400, 400, 200);
        for i in 0..30 {
            let x = 10.0 + (i % 10) as f32 * 15.0;
            let y = 10.0 + (i / 10) as f32 * 15.0;
            spawn(&mut sim, x, y);
        }

        let mut grid = SpatialGrid::new(200);
        grid.build(&sim.buf, sim.agent_count, 80.0, 25.0, 400, 400);

        // Sum of all cell counts must equal the number of spawned agents.
        let total: u32 = (0..grid.grid_w as i32)
            .flat_map(|cx| (0..grid.grid_h as i32).map(move |cy| (cx, cy)))
            .map(|(cx, cy)| grid.cell_agents(cx, cy).len() as u32)
            .sum();
        assert_eq!(total, sim.agent_count as u32);
    }

    #[test]
    fn test_grid_boundary_agents() {
        // Agents exactly at canvas boundaries should not panic (clamped to grid).
        let mut sim = Simulation::new(800, 600, 10);
        spawn(&mut sim, 0.0, 0.0);
        spawn(&mut sim, 799.9, 0.0);
        spawn(&mut sim, 0.0, 599.9);
        spawn(&mut sim, 799.9, 599.9);

        let mut grid = SpatialGrid::new(10);
        // Should not panic even at extreme positions.
        grid.build(&sim.buf, sim.agent_count, 80.0, 25.0, 800, 600);

        // All 4 agents should be indexed somewhere.
        let total: u32 = (0..grid.grid_w as i32)
            .flat_map(|cx| (0..grid.grid_h as i32).map(move |cy| (cx, cy)))
            .map(|(cx, cy)| grid.cell_agents(cx, cy).len() as u32)
            .sum();
        assert_eq!(total, 4);
    }

    #[test]
    fn test_grid_no_dead_agents() {
        // Dead agents (FLAG_ALIVE = 0) should not appear in any cell.
        let mut sim = Simulation::new(200, 200, 10);
        spawn(&mut sim, 50.0, 50.0);
        spawn(&mut sim, 150.0, 50.0);
        // Remove agent 0; agent 1 swaps into slot 0.
        sim.remove_agent(0);
        assert_eq!(sim.agent_count, 1);

        let mut grid = SpatialGrid::new(10);
        grid.build(&sim.buf, sim.agent_count, 80.0, 25.0, 200, 200);

        let total: u32 = (0..grid.grid_w as i32)
            .flat_map(|cx| (0..grid.grid_h as i32).map(move |cy| (cx, cy)))
            .map(|(cx, cy)| grid.cell_agents(cx, cy).len() as u32)
            .sum();
        assert_eq!(total, 1);
    }
}
