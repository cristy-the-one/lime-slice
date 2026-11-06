use super::fill_lines::clip_segment_in;
use crate::poly::{loop_bounds, Loop};
use std::borrow::Cow;
use std::sync::OnceLock;

/// Loops with their bounding boxes, so segment and point tests skip loops that
/// cannot touch them.
pub(super) struct Outline<'a> {
    pub(super) loops: Cow<'a, [Loop]>,
    boxes: Vec<([f64; 2], [f64; 2])>,
    pub(super) bounds: Option<([f64; 2], [f64; 2])>,
    /// Built at the first test on an outline with many edges.
    pub(super) cells: OnceLock<Option<EdgeCells>>,
}

impl<'a> Outline<'a> {
    pub(super) fn new(loops: &'a [Loop]) -> Self {
        Self::from_cow(Cow::Borrowed(loops))
    }

    pub(super) fn owned(loops: Vec<Loop>) -> Outline<'static> {
        Outline::from_cow(Cow::Owned(loops))
    }

    fn from_cow(loops: Cow<'a, [Loop]>) -> Self {
        let boxes = loops
            .iter()
            .map(|l| loop_bounds(std::slice::from_ref(l)).unwrap_or(([0.0; 2], [0.0; 2])))
            .collect();
        let bounds = loop_bounds(&loops);
        Self {
            loops,
            boxes,
            bounds,
            cells: OnceLock::new(),
        }
    }

    pub(super) fn cells(&self) -> Option<&EdgeCells> {
        self.cells
            .get_or_init(|| EdgeCells::build(&self.loops, self.bounds?))
            .as_ref()
    }

    /// Whether loop `l`'s box meets the box of `a..b`.
    pub(super) fn loop_meets(&self, l: usize, a: [f64; 2], b: [f64; 2]) -> bool {
        let lo = [a[0].min(b[0]), a[1].min(b[1])];
        let hi = [a[0].max(b[0]), a[1].max(b[1])];
        let (mn, mx) = self.boxes[l];
        !(hi[0] < mn[0] || lo[0] > mx[0] || hi[1] < mn[1] || lo[1] > mx[1])
    }

    /// Edge `k` of loop `l`, from vertex `k` to the next.
    pub(super) fn edge(&self, l: usize, k: usize) -> ([f64; 2], [f64; 2]) {
        let loop_ = &self.loops[l];
        (loop_[k], loop_[(k + 1) % loop_.len()])
    }

    pub(super) fn box_holds(&self, p: [f64; 2]) -> bool {
        self.bounds.is_some_and(|(mn, mx)| {
            p[0] >= mn[0] && p[0] <= mx[0] && p[1] >= mn[1] && p[1] <= mx[1]
        })
    }

    /// Loops whose box meets the box of `a..b`. The others cannot touch it.
    pub(super) fn touching(&self, a: [f64; 2], b: [f64; 2]) -> impl Iterator<Item = &Loop> + '_ {
        (0..self.loops.len())
            .filter(move |&l| self.loop_meets(l, a, b))
            .map(|l| &self.loops[l])
    }

    /// Same answer as `in_solid`: a point outside a loop's box is outside that loop.
    pub(super) fn contains(&self, p: [f64; 2]) -> bool {
        if let Some(cells) = self.cells() {
            // The parity of every crossing over the loops `touching` keeps.
            let mut inside = false;
            for &(l, k) in cells.row(p[1]) {
                let (l, k) = (l as usize, k as usize);
                if self.loops[l].len() >= 3 && self.loop_meets(l, p, p) {
                    let (pj, pi) = self.edge(l, k);
                    inside ^= crate::poly::ray_crosses(p[0], p[1], pi, pj);
                }
            }
            return inside;
        }
        self.touching(p, p)
            .filter(|l| crate::poly::point_in_loop(l, p[0], p[1]))
            .count()
            % 2
            == 1
    }

    pub(super) fn crosses(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if let Some(cells) = self.cells() {
            return cells.near(a, b).any(|(l, k)| {
                let (c, d) = self.edge(l, k);
                self.loop_meets(l, a, b) && segments_properly_cross(a, b, c, d)
            });
        }
        self.touching(a, b).any(|l| {
            let n = l.len();
            n >= 2 && (0..n).any(|i| segments_properly_cross(a, b, l[i], l[(i + 1) % n]))
        })
    }

    /// True when the whole segment stays in the solid, holes included.
    /// A boundary crossing rejects the segment; the midpoint must also land inside.
    pub(super) fn segment_inside(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if self.loops.is_empty() || self.crosses(a, b) {
            return false;
        }
        self.contains([(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5])
    }

    /// Like `segment_inside`, but touching the boundary anywhere except at the
    /// segment's own ends also counts as leaving. Clipper snaps to a 1 µm grid,
    /// so a travel that passes exactly through an outline vertex is common, and
    /// a proper-crossing test alone lets it slip out of the part there.
    pub(super) fn route_inside(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if self.loops.is_empty() {
            return false;
        }
        let meets = self.touching(a, b).any(|l| {
            let n = l.len();
            n >= 2 && (0..n).any(|i| segment_meets(a, b, l[i], l[(i + 1) % n]))
        });
        !meets && self.contains([(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5])
    }

    /// `a..b` shares a point with the boundary other than its own ends.
    pub(super) fn meets(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if let Some(cells) = self.cells() {
            return cells.near(a, b).any(|(l, k)| {
                let (c, d) = self.edge(l, k);
                self.loop_meets(l, a, b) && segment_meets(a, b, c, d)
            });
        }
        self.touching(a, b).any(|l| {
            let n = l.len();
            n >= 2 && (0..n).any(|i| segment_meets(a, b, l[i], l[(i + 1) % n]))
        })
    }

    /// A link that crosses no boundary and whose midpoint is inside, or just
    /// inside when nudged toward the region's centre.
    pub(super) fn link_stays(&self, a: [f64; 2], b: [f64; 2]) -> bool {
        if self.crosses(a, b) {
            return false;
        }
        let mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
        if self.contains(mid) {
            return true;
        }
        let Some((mn, mx)) = self.bounds else {
            return false;
        };
        let c = [(mn[0] + mx[0]) * 0.5, (mn[1] + mx[1]) * 0.5];
        let vx = c[0] - mid[0];
        let vy = c[1] - mid[1];
        let len = vx.hypot(vy).max(1e-9);
        self.contains([mid[0] + vx / len * 0.05, mid[1] + vy / len * 0.05])
    }

    pub(super) fn clip_segment(&self, a: [f64; 2], b: [f64; 2]) -> Vec<[[f64; 2]; 2]> {
        clip_segment_in(self, a, b)
    }
}

/// An outline's edges on a grid, so a test reads the edges near it instead of
/// every edge. A cell lists each edge whose box meets it, a row each edge
/// whose height range meets it. Callers still apply their exact test and the
/// loop boxes `Outline::touching` applies.
pub(super) struct EdgeCells {
    origin: [f64; 2],
    cell: f64,
    nx: usize,
    ny: usize,
    cells: Vec<Vec<(u32, u32)>>,
    rows: Vec<Vec<(u32, u32)>>,
}

/// Outlines with fewer edges are scanned whole.
pub(super) const EDGE_CELLS_MIN: usize = 64;

/// How far from a segment `near` still finds an edge, mm. Far above the
/// rounding in the segment tests, far below a cell.
pub(super) const EDGE_CELLS_SLACK: f64 = 1e-3;

impl EdgeCells {
    fn build(loops: &[Loop], (min, max): ([f64; 2], [f64; 2])) -> Option<Self> {
        let edges: usize = loops.iter().filter(|l| l.len() >= 2).map(|l| l.len()).sum();
        if edges < EDGE_CELLS_MIN {
            return None;
        }
        let w = (max[0] - min[0]).max(1e-6);
        let h = (max[1] - min[1]).max(1e-6);
        // About one edge per cell, at most 256 cells a side.
        let cell = (w * h / edges as f64).sqrt().max(w / 256.0).max(h / 256.0);
        let (nx, ny) = ((w / cell) as usize + 1, (h / cell) as usize + 1);
        let mut grid = Self {
            origin: min,
            cell,
            nx,
            ny,
            cells: vec![Vec::new(); nx * ny],
            rows: vec![Vec::new(); ny],
        };
        for (l, loop_) in loops.iter().enumerate() {
            if loop_.len() < 2 {
                continue;
            }
            for k in 0..loop_.len() {
                let (c, d) = (loop_[k], loop_[(k + 1) % loop_.len()]);
                let (x0, x1) = (grid.col(c[0].min(d[0])), grid.col(c[0].max(d[0])));
                for y in grid.row_at(c[1].min(d[1]))..=grid.row_at(c[1].max(d[1])) {
                    grid.rows[y].push((l as u32, k as u32));
                    for x in x0..=x1 {
                        grid.cells[y * grid.nx + x].push((l as u32, k as u32));
                    }
                }
            }
        }
        Some(grid)
    }

    fn col(&self, x: f64) -> usize {
        (((x - self.origin[0]) / self.cell).floor().max(0.0) as usize).min(self.nx - 1)
    }

    fn row_at(&self, y: f64) -> usize {
        (((y - self.origin[1]) / self.cell).floor().max(0.0) as usize).min(self.ny - 1)
    }

    /// Edges whose height range can hold `y`, each once.
    fn row(&self, y: f64) -> &[(u32, u32)] {
        &self.rows[self.row_at(y)]
    }

    /// Edges within `EDGE_CELLS_SLACK` of segment `a..b`, some more than once.
    /// Each column the segment spans gives the rows its height covers there.
    pub(super) fn near(
        &self,
        a: [f64; 2],
        b: [f64; 2],
    ) -> impl Iterator<Item = (usize, usize)> + '_ {
        let s = EDGE_CELLS_SLACK;
        let (x_lo, x_hi) = (a[0].min(b[0]), a[0].max(b[0]));
        let y_at = move |x: f64| {
            let t = ((x - a[0]) / (b[0] - a[0])).clamp(0.0, 1.0);
            a[1] + (b[1] - a[1]) * t
        };
        (self.col(x_lo - s)..=self.col(x_hi + s))
            .flat_map(move |x| {
                let (y0, y1) = if (b[0] - a[0]).abs() < 1e-9 {
                    (a[1].min(b[1]), a[1].max(b[1]))
                } else {
                    let left = self.origin[0] + x as f64 * self.cell - s;
                    let right = left + self.cell + 2.0 * s;
                    let (ya, yb) = (y_at(left.max(x_lo)), y_at(right.min(x_hi)));
                    (ya.min(yb), ya.max(yb))
                };
                (self.row_at(y0 - s)..=self.row_at(y1 + s)).map(move |y| y * self.nx + x)
            })
            .flat_map(move |i| self.cells[i].iter())
            .map(|&(l, k)| (l as usize, k as usize))
    }
}

pub(super) fn segments_properly_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    o1 * o2 < -1e-10 && o3 * o4 < -1e-10
}

/// `a..b` and `c..d` share a point other than `a` or `b`: a proper crossing,
/// or `c` or `d` lying on `a..b` strictly between its ends.
pub(super) fn segment_meets(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    const ON: f64 = 1e-9;
    let side = |o: f64| {
        if o > ON {
            1
        } else if o < -ON {
            -1
        } else {
            0
        }
    };
    let (o1, o2) = (orient(a, b, c), orient(a, b, d));
    let (s1, s2) = (side(o1), side(o2));
    let (s3, s4) = (side(orient(c, d, a)), side(orient(c, d, b)));
    if s1 * s2 < 0 && s3 * s4 < 0 {
        return true;
    }
    let within = |p: [f64; 2]| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        if len2 <= 0.0 {
            return false;
        }
        let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
        let len = len2.sqrt();
        t * len > 1e-6 && (1.0 - t) * len > 1e-6
    };
    (s1 == 0 && within(c)) || (s2 == 0 && within(d))
}

pub(super) fn orient(p: [f64; 2], q: [f64; 2], r: [f64; 2]) -> f64 {
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
}
