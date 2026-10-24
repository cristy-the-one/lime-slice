//! The part as it is sliced: a grid aligned with the layers, filled from the
//! beads of a [`SliceField`], meshed by its solid cells.
//!
//! The grid lives in the slice frame, where the layers stack along +Z. A
//! cell is `h_xy` square in the layer plane and a whole number of layers
//! tall, so a cell boundary is always a layer boundary. Each bead is a
//! rectangle, width × length, laid at its layer's slab. The rectangle is
//! clipped against the cells it crosses, so every deposited cubic millimetre
//! lands in exactly one cell.
//!
//! Per cell the grid keeps the deposited volume, the in-plane orientation
//! tensor `Σ volume · t ⊗ t`, and the volume of each role. A cell whose
//! fraction is under `phi_min` is void. The rest become six tetrahedra each,
//! split as the structured mesher splits its bricks, so the mesh is
//! conforming with no boundary work. Its surface is a staircase within half
//! a cell of the part's.

use std::collections::HashMap;

use crate::element::ElementKind;
use crate::error::SimError;
use crate::material::MaterialContext;
use crate::mesh::{tet10_nodes, Cell, Mesh, HEX_TETS};
use crate::slice_field::{SliceField, ROLES};
use crate::units::{midpoint, NODE_CAP, SLICED_NODE_CAP};

/// A cell with less than this fraction of polymer is void.
pub const PHI_MIN: f64 = 0.02;

/// TET10 nodes per solid cell of a large grid: one corner and seven
/// mid-edge nodes (three along the axes, three face diagonals, one body
/// diagonal) of the six-tet split.
const NODES_PER_CELL: f64 = 8.0;

const BRIDGE: usize = 9;

/// What an element is made of, as the beads in its cell laid it down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellMaterial {
    /// Deposited volume over cell volume, at most 1.
    pub volume_fraction: f64,
    /// The beads' main direction in the layer plane, as a unit vector in the
    /// slice frame. `None` when the cell has no direction to speak of.
    pub fibre_axis: Option<[f64; 3]>,
    /// The larger eigenvalue of the normalised orientation tensor, from 0.5
    /// (crossing beads, in-plane isotropic) to 1 (all beads along one line).
    pub alignment: f64,
    /// The share of the cell's volume that was bridged.
    pub bridge_share: f64,
    /// The role with the most volume, an index into [`ROLES`].
    pub role: u8,
}

impl CellMaterial {
    /// The context the material and the criterion read for this cell.
    pub fn context(&self, build_axis: [f64; 3]) -> MaterialContext {
        MaterialContext {
            build_axis,
            temperature_c: None,
            fibre_axis: self.fibre_axis,
            volume_fraction: self.volume_fraction,
            alignment: self.alignment,
            bridge_share: self.bridge_share,
        }
    }

    /// Solid polymer with no direction: what a smeared element is.
    pub fn smeared(volume_fraction: f64) -> Self {
        Self {
            volume_fraction,
            fibre_axis: None,
            alignment: 0.5,
            bridge_share: 0.0,
            role: 0,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Fill {
    volume: f64,
    /// `[xx, xy, yy]` of `Σ volume · t ⊗ t`.
    orient: [f64; 3],
    roles: [f64; ROLES.len()],
}

/// The grid of one slice field.
#[derive(Clone, Debug)]
pub struct SlicedGrid {
    pub h_xy: f64,
    pub origin: [f64; 2],
    pub nx: usize,
    pub ny: usize,
    /// Each slab's bottom and top in the slice frame, bottom first.
    pub slabs: Vec<[f64; 2]>,
    cells: HashMap<(u32, u32, u32), Fill>,
    /// The deposited volume that landed in the grid, mm³.
    pub deposited_mm3: f64,
}

/// The mesh of a grid's solid cells, with one material per element.
#[derive(Clone, Debug)]
pub struct SlicedMesh {
    /// TET10 in the slice frame.
    pub mesh: Mesh,
    pub cells: Vec<CellMaterial>,
    /// The grid cell each element came from, as `(i, j, slab)`.
    pub cell_of: Vec<(u32, u32, u32)>,
    /// Whether each element's cell has a face on the part's surface: a
    /// neighbour across one of its six faces is void.
    pub boundary: Vec<bool>,
    /// The grid's corner in the layer plane and its slabs, bottom first, so
    /// a point in the slice frame can find its cell.
    pub origin: [f64; 2],
    pub slabs: Vec<[f64; 2]>,
    pub h_xy: f64,
    /// The polymer volume the solid cells hold, mm³: what the solve weighs.
    pub solid_deposited_mm3: f64,
}

/// The cell size that keeps a dense grid of the field's bounding box under
/// the node cap. A real part fills less of its box, so this errs coarse; it
/// is where [`fitted_h_xy`] starts.
pub fn default_h_xy(field: &SliceField) -> f64 {
    dense_h_xy(field, NODE_CAP)
}

fn dense_h_xy(field: &SliceField, node_budget: usize) -> f64 {
    let (lo, hi) = bounds(field);
    let volume = (hi[0] - lo[0]).max(0.1) * (hi[1] - lo[1]).max(0.1) * (hi[2] - lo[2]).max(0.1);
    (NODES_PER_CELL * volume / node_budget.max(1) as f64).cbrt().max(0.25)
}

/// TET10 nodes per solid cell of a real part, boundary included: 11.3 on
/// both covers of the 2026-10-22 trial (73,558 nodes on 6,529 cells, 62,603
/// on 5,528). Larger than [`NODES_PER_CELL`]'s 8, which holds only deep
/// inside a bulky part.
pub const NODES_PER_SOLID_CELL: f64 = 11.3;

/// Peak memory of a sliced study, MB, for a first solve of `nodes`: 2,176 MB
/// at 73,558 nodes and 4,566 MB at 136,452 on the trial (Windows, faer's
/// supernodal LDLᵀ, slicing included), which is `2176 · (n / 73558)^1.20`.
pub fn study_memory_mb(nodes: usize) -> f64 {
    2176.0 * (nodes as f64 / 73_558.0).powf(MEMORY_EXPONENT)
}

const MEMORY_EXPONENT: f64 = 1.20;

/// Peak memory of a sliced study, MB, from the values its factor holds:
/// twice the factor, for the assembly and the factor's scratch alive beside
/// it, and 300 MB for the rest. Measured on the jet study (release, Windows):
/// 1.42e8 values peaked at 2,544 MB (this says 2,465), 4.14e8 at 6,397 MB
/// (this says 6,616).
pub fn study_peak_mb(factor_len: usize) -> f64 {
    2.0 * 8.0 * factor_len as f64 / (1024.0 * 1024.0) + 300.0
}

/// The most nodes a solve may have within `memory_mb`, and never past the cap.
pub fn nodes_for_memory(memory_mb: f64) -> usize {
    let nodes = 73_558.0 * (memory_mb.max(1.0) / 2176.0).powf(1.0 / MEMORY_EXPONENT);
    (nodes as usize).min(NODE_CAP)
}

/// The finest cell size whose solid cells fit `node_budget`, found by
/// rasterising and counting: a cover fills a small share of its box, so the
/// box alone picks cells several times too coarse. Never finer than two
/// bead widths, which a cell can't resolve below.
pub fn fitted_h_xy(field: &SliceField, node_budget: usize) -> Result<f64, SimError> {
    let widest = field
        .segments
        .iter()
        .map(|s| f64::from(s.width_mm))
        .fold(0.0, f64::max);
    let floor = (2.0 * widest).max(0.5);
    let budget = node_budget.max(1) as f64;
    let mut h = dense_h_xy(field, node_budget).max(floor);
    let mut best: Option<f64> = None;
    for _ in 0..8 {
        let grid = SlicedGrid::rasterize(field, h)?;
        let solid = grid.fractions().filter(|(_, phi)| *phi >= PHI_MIN).count() as f64;
        let nodes = solid * NODES_PER_SOLID_CELL;
        if nodes <= budget {
            best = Some(best.map_or(h, |b: f64| b.min(h)));
            if nodes >= 0.8 * budget || h <= floor {
                break;
            }
        }
        // Between a shell (cells go as h⁻²) and a block (h⁻³).
        let step = (nodes / budget).powf(1.0 / 2.5).clamp(0.5, 1.6);
        let next = (h * step).max(floor);
        if (next - h).abs() < 1e-9 {
            break;
        }
        h = next;
    }
    Ok(best.unwrap_or(h))
}

fn bounds(field: &SliceField) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for s in &field.segments {
        for p in [s.from, s.to] {
            for k in 0..3 {
                lo[k] = lo[k].min(f64::from(p[k]));
                hi[k] = hi[k].max(f64::from(p[k]));
            }
        }
        lo[2] = lo[2].min(f64::from(s.from[2]) - f64::from(s.bead_height_mm));
    }
    (lo, hi)
}

/// Slabs of whole layers, each as close to `h_xy` tall as the layer heights
/// allow, with at least one layer. A gap between layers starts a new slab.
/// Returns the slabs and the slab of each listed layer.
fn slabs_of(field: &SliceField, h_xy: f64) -> (Vec<[f64; 2]>, HashMap<u32, u32>) {
    let mut layers: Vec<(u32, f64, f64)> = field
        .header
        .layers
        .iter()
        .map(|l| (l.index, l.z_mm - l.height_mm, l.z_mm))
        .collect();
    layers.sort_by(|a, b| a.1.total_cmp(&b.1));
    let mut slabs: Vec<[f64; 2]> = Vec::new();
    let mut of = HashMap::new();
    for (index, bottom, top) in layers {
        let touching = slabs.last().filter(|slab| (bottom - slab[1]).abs() < 1e-6);
        // Add the layer while that brings the slab nearer h_xy. A tie, to the
        // micron, keeps the shorter slab, so float noise in the layer heights
        // can't give one slab more layers than its neighbours.
        let joins = touching.is_some_and(|slab| {
            (top - slab[0] - h_xy).abs() < (slab[1] - slab[0] - h_xy).abs() - 1e-6
        });
        // A touching slab starts at the exact top of the one below, so the
        // two share their nodes.
        let bottom = touching.map_or(bottom, |slab| slab[1]);
        if joins {
            slabs.last_mut().expect("a slab")[1] = top;
        } else {
            slabs.push([bottom, top]);
        }
        of.insert(index, (slabs.len() - 1) as u32);
    }
    (slabs, of)
}

impl SlicedGrid {
    pub fn rasterize(field: &SliceField, h_xy: f64) -> Result<Self, SimError> {
        if !(h_xy.is_finite() && h_xy > 0.0) {
            return Err(SimError::new("The cell size has to be positive."));
        }
        if field.segments.is_empty() {
            return Err(SimError::new("The slice field has no beads."));
        }
        let (slabs, slab_of) = slabs_of(field, h_xy);
        // The grid starts at the beads' footprint, so a part whose sides
        // are a whole number of cells fills its edge cells.
        let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        for s in &field.segments {
            if let Some(rect) = rectangle(s) {
                for p in rect {
                    for k in 0..2 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
            }
        }
        if !lo[0].is_finite() {
            return Err(SimError::new("The slice field has no beads."));
        }
        let origin = lo;
        // A side within a micron of whole cells keeps its count.
        let count = |span: f64| (((span / h_xy) - 1e-6).ceil() as usize).max(1);
        let nx = count(hi[0] - lo[0]);
        let ny = count(hi[1] - lo[1]);
        let mut grid = SlicedGrid {
            h_xy,
            origin,
            nx,
            ny,
            slabs,
            cells: HashMap::new(),
            deposited_mm3: 0.0,
        };
        for s in &field.segments {
            let Some(&slab) = slab_of.get(&s.layer) else {
                return Err(SimError::new(format!(
                    "A bead names layer {}, which the field doesn't list.",
                    s.layer
                )));
            };
            grid.lay(s, slab);
        }
        Ok(grid)
    }

    fn lay(&mut self, s: &crate::slice_field::Segment, slab: u32) {
        let depth = f64::from(s.bead_height_mm).max(0.0) * f64::from(s.flow).max(0.0);
        let Some(rect) = rectangle(s) else {
            return;
        };
        if depth <= 0.0 {
            return;
        }
        let d = [
            f64::from(s.to[0]) - f64::from(s.from[0]),
            f64::from(s.to[1]) - f64::from(s.from[1]),
        ];
        let length = d[0].hypot(d[1]);
        let width = f64::from(s.width_mm);
        let t = [d[0] / length, d[1] / length];
        let (mut x0, mut x1, mut y0, mut y1) = (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        );
        for p in rect {
            x0 = x0.min(p[0]);
            x1 = x1.max(p[0]);
            y0 = y0.min(p[1]);
            y1 = y1.max(p[1]);
        }
        let h = self.h_xy;
        let i0 = ((x0 - self.origin[0]) / h).floor().max(0.0) as usize;
        let i1 = (((x1 - self.origin[0]) / h).floor() as usize).min(self.nx - 1);
        let j0 = ((y0 - self.origin[1]) / h).floor().max(0.0) as usize;
        let j1 = (((y1 - self.origin[1]) / h).floor() as usize).min(self.ny - 1);
        let role = s.role as usize;
        let single = i0 == i1 && j0 == j1;
        for i in i0..=i1 {
            for j in j0..=j1 {
                let area = if single {
                    length * width
                } else {
                    let cx = self.origin[0] + i as f64 * h;
                    let cy = self.origin[1] + j as f64 * h;
                    clipped_area(&rect, [cx, cy], [cx + h, cy + h])
                };
                if area <= 0.0 {
                    continue;
                }
                let v = area * depth;
                let fill = self.cells.entry((i as u32, j as u32, slab)).or_default();
                fill.volume += v;
                fill.orient[0] += v * t[0] * t[0];
                fill.orient[1] += v * t[0] * t[1];
                fill.orient[2] += v * t[1] * t[1];
                fill.roles[role] += v;
                self.deposited_mm3 += v;
            }
        }
    }

    pub fn cell_volume(&self, slab: u32) -> f64 {
        let [bottom, top] = self.slabs[slab as usize];
        self.h_xy * self.h_xy * (top - bottom)
    }

    /// Every filled cell's fraction, unclamped, with its key.
    pub fn fractions(&self) -> impl Iterator<Item = ((u32, u32, u32), f64)> + '_ {
        self.cells
            .iter()
            .map(|(key, fill)| (*key, fill.volume / self.cell_volume(key.2)))
    }

    /// The material of a filled cell, from its beads.
    pub fn material(&self, key: (u32, u32, u32)) -> Option<CellMaterial> {
        let fill = self.cells.get(&key)?;
        let phi = (fill.volume / self.cell_volume(key.2)).min(1.0);
        let (axis, alignment) = principal(fill.orient, fill.volume);
        let role = fill
            .roles
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map_or(0, |(r, _)| r as u8);
        Some(CellMaterial {
            volume_fraction: phi,
            fibre_axis: axis.map(|[x, y]| [x, y, 0.0]),
            alignment,
            bridge_share: fill.roles[BRIDGE] / fill.volume,
            role,
        })
    }

    /// The TET10 mesh of the cells at `phi_min` or above. Refused, with a
    /// cell size that fits, when it would pass the node cap.
    pub fn mesh(&self, phi_min: f64) -> Result<SlicedMesh, SimError> {
        let mut solid: Vec<(u32, u32, u32)> = self
            .fractions()
            .filter(|(_, phi)| *phi >= phi_min)
            .map(|(key, _)| key)
            .collect();
        if solid.is_empty() {
            return Err(SimError::new(
                "No cell of this slice is solid enough to solve.",
            ));
        }
        solid.sort_unstable_by_key(|&(i, j, k)| (k, j, i));
        let filled: std::collections::HashSet<(u32, u32, u32)> = solid.iter().copied().collect();
        let on_surface = |(i, j, k): (u32, u32, u32)| {
            let near = |di: i64, dj: i64, dk: i64| {
                let (a, b, c) = (i64::from(i) + di, i64::from(j) + dj, i64::from(k) + dk);
                a >= 0 && b >= 0 && c >= 0 && filled.contains(&(a as u32, b as u32, c as u32))
            };
            !(near(1, 0, 0)
                && near(-1, 0, 0)
                && near(0, 1, 0)
                && near(0, -1, 0)
                && near(0, 0, 1)
                && near(0, 0, -1))
        };
        let estimate = (solid.len() as f64 * NODES_PER_CELL) as usize;
        if estimate > SLICED_NODE_CAP {
            return Err(self.cap_refusal(estimate));
        }
        let mut nodes: Vec<[f64; 3]> = Vec::new();
        let mut corner: HashMap<(u32, u32, u64), usize> = HashMap::new();
        let mut mids: HashMap<(usize, usize), usize> = HashMap::new();
        let mut elements = Vec::with_capacity(solid.len() * 6);
        let mut cells = Vec::with_capacity(solid.len() * 6);
        let mut cell_of = Vec::with_capacity(solid.len() * 6);
        let mut boundary = Vec::with_capacity(solid.len() * 6);
        let mut solid_deposited = 0.0;
        let h = self.h_xy;
        for key in solid {
            let (i, j, k) = key;
            let [bottom, top] = self.slabs[k as usize];
            let mut at = |di: u32, dj: u32, z: f64| {
                let id = (i + di, j + dj, z.to_bits());
                *corner.entry(id).or_insert_with(|| {
                    nodes.push([
                        self.origin[0] + f64::from(i + di) * h,
                        self.origin[1] + f64::from(j + dj) * h,
                        z,
                    ]);
                    nodes.len() - 1
                })
            };
            let hex = [
                at(0, 0, bottom),
                at(1, 0, bottom),
                at(1, 1, bottom),
                at(0, 1, bottom),
                at(0, 0, top),
                at(1, 0, top),
                at(1, 1, top),
                at(0, 1, top),
            ];
            let material = self.material(key).expect("a solid cell is filled");
            solid_deposited += self.cells[&key].volume.min(self.cell_volume(k));
            for tet in HEX_TETS {
                let corners = [hex[tet[0]], hex[tet[1]], hex[tet[2]], hex[tet[3]]];
                elements.push(Cell {
                    nodes: tet10_nodes(corners, &mut nodes, &mut mids, midpoint),
                });
                cells.push(material);
                cell_of.push(key);
                boundary.push(on_surface(key));
            }
        }
        if nodes.len() > SLICED_NODE_CAP {
            return Err(self.cap_refusal(nodes.len()));
        }
        Ok(SlicedMesh {
            mesh: Mesh {
                nodes,
                elements,
                kind: ElementKind::Tet10,
            },
            cells,
            cell_of,
            boundary,
            origin: self.origin,
            slabs: self.slabs.clone(),
            h_xy: h,
            solid_deposited_mm3: solid_deposited,
        })
    }

    fn cap_refusal(&self, nodes: usize) -> SimError {
        // Nodes scale with the cell count, about h⁻³ while slabs follow h.
        let fits = self.h_xy * (nodes as f64 / SLICED_NODE_CAP as f64).cbrt() * 1.05;
        SimError::new(format!(
            "This slice needs about {nodes} nodes at a {:.2} mm cell. Try a cell of {:.2} mm.",
            self.h_xy, fits
        ))
    }
}

/// A bead's footprint in the layer plane: its length by its width.
fn rectangle(s: &crate::slice_field::Segment) -> Option<[[f64; 2]; 4]> {
    let a = [f64::from(s.from[0]), f64::from(s.from[1])];
    let b = [f64::from(s.to[0]), f64::from(s.to[1])];
    let d = [b[0] - a[0], b[1] - a[1]];
    let length = d[0].hypot(d[1]);
    let width = f64::from(s.width_mm);
    if length < 1e-9 || width <= 0.0 {
        return None;
    }
    let n = [-d[1] / length * width * 0.5, d[0] / length * width * 0.5];
    Some([
        [a[0] + n[0], a[1] + n[1]],
        [b[0] + n[0], b[1] + n[1]],
        [b[0] - n[0], b[1] - n[1]],
        [a[0] - n[0], a[1] - n[1]],
    ])
}

/// The unit main direction and the larger eigenvalue of `orient / volume`.
fn principal(orient: [f64; 3], volume: f64) -> (Option<[f64; 2]>, f64) {
    if volume <= 0.0 {
        return (None, 0.5);
    }
    let (a, b, c) = (orient[0] / volume, orient[1] / volume, orient[2] / volume);
    let mean = 0.5 * (a + c);
    let radius = (0.25 * (a - c) * (a - c) + b * b).sqrt();
    let lambda = (mean + radius).clamp(0.5, 1.0);
    if radius < 1e-9 {
        return (None, lambda);
    }
    let theta = 0.5 * (2.0 * b).atan2(a - c);
    (Some([theta.cos(), theta.sin()]), lambda)
}

/// The area of the convex quad `poly` inside the box `lo`..`hi`.
fn clipped_area(poly: &[[f64; 2]; 4], lo: [f64; 2], hi: [f64; 2]) -> f64 {
    let mut pts: Vec<[f64; 2]> = poly.to_vec();
    for (axis, bound, keep_below) in [
        (0, lo[0], false),
        (0, hi[0], true),
        (1, lo[1], false),
        (1, hi[1], true),
    ] {
        if pts.is_empty() {
            return 0.0;
        }
        let inside = |p: &[f64; 2]| {
            if keep_below {
                p[axis] <= bound
            } else {
                p[axis] >= bound
            }
        };
        let mut out = Vec::with_capacity(pts.len() + 2);
        for idx in 0..pts.len() {
            let cur = pts[idx];
            let prev = pts[(idx + pts.len() - 1) % pts.len()];
            let (ci, pi) = (inside(&cur), inside(&prev));
            if ci != pi {
                let t = (bound - prev[axis]) / (cur[axis] - prev[axis]);
                out.push([
                    prev[0] + t * (cur[0] - prev[0]),
                    prev[1] + t * (cur[1] - prev[1]),
                ]);
            }
            if ci {
                out.push(cur);
            }
        }
        pts = out;
    }
    let mut twice = 0.0;
    for idx in 0..pts.len() {
        let p = pts[idx];
        let q = pts[(idx + 1) % pts.len()];
        twice += p[0] * q[1] - q[0] * p[1];
    }
    (0.5 * twice).abs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slice_field::{Header, LayerRow, Segment, FORMAT};

    /// A block of `layers` layers, `w` × `d` mm, of beads along X spaced one
    /// width apart: a solid part with every bead aligned.
    pub(crate) fn block(w: f64, d: f64, layers: u32, along_x: bool) -> SliceField {
        let width = 0.45_f32;
        let height = 0.2_f32;
        let mut segments = Vec::new();
        let mut rows = Vec::new();
        for layer in 0..layers {
            let start = segments.len() as u32;
            let z = (layer + 1) as f32 * height;
            let lines = (if along_x { d } else { w } / f64::from(width)).round() as usize;
            for n in 0..lines {
                let c = (n as f32 + 0.5) * width;
                let (from, to) = if along_x {
                    ([0.0, c, z], [w as f32, c, z])
                } else {
                    ([c, 0.0, z], [c, d as f32, z])
                };
                segments.push(Segment {
                    layer,
                    role: 7,
                    from,
                    to,
                    width_mm: width,
                    bead_height_mm: height,
                    flow: 1.0,
                });
            }
            rows.push(LayerRow {
                index: layer,
                z_mm: f64::from(z),
                height_mm: f64::from(height),
                bead_start: start,
                bead_count: segments.len() as u32 - start,
            });
        }
        SliceField {
            header: Header {
                format: FORMAT.into(),
                slice_hash: String::new(),
                frame: [
                    [1.0, 0.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0, 0.0],
                    [0.0, 0.0, 0.0, 1.0],
                ],
                layer_normal: [0.0, 0.0, 1.0],
                layers: rows,
                roles: ROLES.iter().map(|r| r.to_string()).collect(),
                segment_count: segments.len() as u32,
            },
            segments,
        }
    }

    #[test]
    fn every_deposited_millimetre_lands_in_one_cell() {
        let field = block(10.3, 4.95, 7, true);
        for h in [0.7, 1.0, 2.3] {
            let grid = SlicedGrid::rasterize(&field, h).unwrap();
            let total = field.total_volume_mm3();
            assert!(((grid.deposited_mm3 - total) / total).abs() < 1e-9, "h {h}");
            let integrated: f64 = grid
                .fractions()
                .map(|(key, phi)| phi * grid.cell_volume(key.2))
                .sum();
            assert!(((integrated - total) / total).abs() < 1e-9, "h {h}");
        }
    }

    #[test]
    fn slabs_are_whole_layers_near_the_cell_size() {
        let field = block(4.0, 4.0, 10, true);
        let grid = SlicedGrid::rasterize(&field, 0.8).unwrap();
        // 0.8 mm is four 0.2 mm layers: 4, 4 and the last 2.
        let heights: Vec<f64> = grid
            .slabs
            .iter()
            .map(|s| ((s[1] - s[0]) * 1000.0).round() / 1000.0)
            .collect();
        assert_eq!(heights, vec![0.8, 0.8, 0.4]);
    }

    #[test]
    fn aligned_beads_give_their_direction_and_crossed_beads_none() {
        let along = block(6.0, 6.0, 4, true);
        let grid = SlicedGrid::rasterize(&along, 1.5).unwrap();
        let inner = grid.material((2, 2, 0)).unwrap();
        assert!((inner.alignment - 1.0).abs() < 1e-9);
        let axis = inner.fibre_axis.unwrap();
        assert!(
            (axis[0].abs() - 1.0).abs() < 1e-9 && axis[1].abs() < 1e-9,
            "{axis:?}"
        );
        assert!(
            (inner.volume_fraction - 1.0).abs() < 1e-6,
            "{}",
            inner.volume_fraction
        );

        let mut crossed = block(6.0, 6.0, 4, true);
        let across = block(6.0, 6.0, 4, false);
        for (a, b) in crossed.segments.iter_mut().zip(&across.segments) {
            if a.layer % 2 == 1 {
                *a = *b;
            }
        }
        let grid = SlicedGrid::rasterize(&crossed, 1.5).unwrap();
        let cell = grid.material((2, 2, 0)).unwrap();
        assert!((cell.alignment - 0.5).abs() < 1e-6, "{}", cell.alignment);
    }

    #[test]
    fn the_mesh_is_six_conforming_tets_a_cell() {
        let field = block(4.0, 2.0, 5, true);
        let grid = SlicedGrid::rasterize(&field, 1.0).unwrap();
        let sliced = grid.mesh(PHI_MIN).unwrap();
        let solid = grid.fractions().filter(|(_, phi)| *phi >= PHI_MIN).count();
        assert_eq!(sliced.mesh.elements.len(), 6 * solid);
        // Every tet is positive, and the solid volume is the cells'.
        let mut volume = 0.0;
        for cell in &sliced.mesh.elements {
            let v = sliced.mesh.tet_volume(&cell.nodes[..4]);
            assert!(v > 0.0);
            volume += v;
        }
        let cells: f64 = grid
            .fractions()
            .filter(|(_, phi)| *phi >= PHI_MIN)
            .map(|(key, _)| grid.cell_volume(key.2))
            .sum();
        assert!((volume - cells).abs() < 1e-9 * cells);
        // Conforming: the mesh's open faces are exactly the cell faces with no
        // solid neighbour. A face two tets don't share would add to its area.
        let solid: std::collections::HashSet<(u32, u32, u32)> = grid
            .fractions()
            .filter(|(_, phi)| *phi >= PHI_MIN)
            .map(|(key, _)| key)
            .collect();
        let mut exposed = 0.0;
        for &(i, j, k) in &solid {
            let h = grid.h_xy;
            let tall = grid.slabs[k as usize][1] - grid.slabs[k as usize][0];
            let near = |di: i64, dj: i64, dk: i64| {
                let (a, b, c) = (i64::from(i) + di, i64::from(j) + dj, i64::from(k) + dk);
                a >= 0 && b >= 0 && c >= 0 && solid.contains(&(a as u32, b as u32, c as u32))
            };
            for (di, dj) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                if !near(di, dj, 0) {
                    exposed += h * tall;
                }
            }
            for dk in [1, -1] {
                if !near(0, 0, dk) {
                    exposed += h * h;
                }
            }
        }
        let area: f64 = crate::mesh::boundary_faces(&sliced.mesh)
            .iter()
            .map(|f| f.area)
            .sum();
        assert!(
            (area - exposed).abs() < 1e-9 * exposed,
            "{area} vs {exposed}"
        );
    }

    #[test]
    fn a_grid_past_the_cap_names_a_cell_that_fits() {
        let field = block(20.0, 20.0, 20, true);
        let grid = SlicedGrid::rasterize(&field, 0.25).unwrap();
        let err = grid.mesh(PHI_MIN).unwrap_err();
        assert!(
            err.message.starts_with("This slice needs about "),
            "{}",
            err.message
        );
        let fits: f64 = err
            .message
            .rsplit("a cell of ")
            .next()
            .unwrap()
            .trim_end_matches(" mm.")
            .parse()
            .unwrap();
        assert!(
            SlicedGrid::rasterize(&field, fits)
                .unwrap()
                .mesh(PHI_MIN)
                .is_ok(),
            "{fits}"
        );
    }
}
