//! XY bins for a vertical ray.
//!
//! `lime-slice-core`'s `ZIndex` buckets faces by the Z range a horizontal
//! plane cut can cross. A pin ray is vertical, so it wants the opposite
//! index: bins in XY. This grid stays in this crate. The slicer's index is
//! not used and is not modified.

const BIN_PAD_MM: f64 = 1.0e-4;

pub(crate) struct Grid {
    origin_x: f64,
    origin_y: f64,
    cell: f64,
    cols: usize,
    rows: usize,
    bins: Vec<Vec<u32>>,
    tris: Vec<[[f64; 3]; 3]>,
    pub min: [f64; 3],
    pub max: [f64; 3],
}

impl Grid {
    pub(crate) fn build(triangles: &[[[f64; 3]; 3]]) -> Result<Self, String> {
        let mut tris = Vec::with_capacity(triangles.len());
        for tri in triangles {
            if tri.iter().flatten().all(|c| c.is_finite()) {
                tris.push(*tri);
            }
        }
        if tris.is_empty() {
            return Err("mesh contains no finite triangles".into());
        }
        let (min, max) = bounds(&tris);
        let span_x = (max[0] - min[0]).max(0.0);
        let span_y = (max[1] - min[1]).max(0.0);
        let target = ((tris.len() as f64) / 8.0).sqrt().clamp(1.0, 512.0);
        let span = span_x.max(span_y).max(1.0e-3);
        let cell = (span / target).max(1.0e-3);
        let cols = axis_bins(span_x, cell);
        let rows = axis_bins(span_y, cell);
        let mut bins = vec![Vec::new(); cols * rows];
        let pad = cell * 1.0e-6 + BIN_PAD_MM;
        for (ti, tri) in tris.iter().enumerate() {
            let (x0, x1, y0, y1) = xy_box(tri);
            let c0 = bin_of(x0 - pad, min[0], cell, cols);
            let c1 = bin_of(x1 + pad, min[0], cell, cols);
            let r0 = bin_of(y0 - pad, min[1], cell, rows);
            let r1 = bin_of(y1 + pad, min[1], cell, rows);
            for row in r0..=r1 {
                for col in c0..=c1 {
                    bins[row * cols + col].push(ti as u32);
                }
            }
        }
        Ok(Self {
            origin_x: min[0],
            origin_y: min[1],
            cell,
            cols,
            rows,
            bins,
            tris,
            min,
            max,
        })
    }

    /// Highest finite intersection of a downward ray at `(x, y)`, if any.
    pub(crate) fn top_z(&self, x: f64, y: f64) -> Option<f64> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let col = ((x - self.origin_x) / self.cell).floor() as isize;
        let row = ((y - self.origin_y) / self.cell).floor() as isize;
        let mut best: Option<f64> = None;
        // The point's own bin is enough when the bbox insert is exact. The
        // ring around it covers a point that landed on a bin edge.
        for dr in -1isize..=1 {
            for dc in -1isize..=1 {
                let r = row + dr;
                let c = col + dc;
                if r < 0 || c < 0 || r >= self.rows as isize || c >= self.cols as isize {
                    continue;
                }
                let bin = &self.bins[r as usize * self.cols + c as usize];
                for &ti in bin {
                    let Some(z) = vertical_hit(&self.tris[ti as usize], x, y) else {
                        continue;
                    };
                    best = Some(best.map_or(z, |have| have.max(z)));
                }
            }
        }
        best
    }
}

fn axis_bins(span: f64, cell: f64) -> usize {
    if span <= 1.0e-9 {
        1
    } else {
        ((span / cell).ceil() as usize).clamp(1, 4096)
    }
}

fn bin_of(coord: f64, origin: f64, cell: f64, n: usize) -> usize {
    let i = ((coord - origin) / cell).floor() as isize;
    if i < 0 {
        0
    } else if i >= n as isize {
        n - 1
    } else {
        i as usize
    }
}

fn bounds(tris: &[[[f64; 3]; 3]]) -> ([f64; 3], [f64; 3]) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for tri in tris {
        for v in tri {
            for i in 0..3 {
                min[i] = min[i].min(v[i]);
                max[i] = max[i].max(v[i]);
            }
        }
    }
    (min, max)
}

fn xy_box(tri: &[[f64; 3]; 3]) -> (f64, f64, f64, f64) {
    let mut x0 = f64::INFINITY;
    let mut x1 = f64::NEG_INFINITY;
    let mut y0 = f64::INFINITY;
    let mut y1 = f64::NEG_INFINITY;
    for v in tri {
        x0 = x0.min(v[0]);
        x1 = x1.max(v[0]);
        y0 = y0.min(v[1]);
        y1 = y1.max(v[1]);
    }
    (x0, x1, y0, y1)
}

/// Barycentric hit of a vertical ray against the triangle's XY projection.
/// A vertical or degenerate face has no area and does not count.
fn vertical_hit(tri: &[[f64; 3]; 3], x: f64, y: f64) -> Option<f64> {
    let (a, b, c) = (tri[0], tri[1], tri[2]);
    let (x0, y0) = (a[0], a[1]);
    let (x1, y1) = (b[0], b[1]);
    let (x2, y2) = (c[0], c[1]);
    let denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if denom.abs() < 1.0e-14 {
        return None;
    }
    let w0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / denom;
    let w1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / denom;
    let w2 = 1.0 - w0 - w1;
    // Include the shared edge of two faces. The caller keeps the higher Z.
    const EDGE: f64 = -1.0e-8;
    if w0 < EDGE || w1 < EDGE || w2 < EDGE {
        return None;
    }
    let z = w0 * a[2] + w1 * b[2] + w2 * c[2];
    z.is_finite().then_some(z)
}
