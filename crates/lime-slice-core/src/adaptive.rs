use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::mesh::Mesh;

/// One printed layer. `z` is the top of the layer; `height` is its thickness.
#[derive(Clone, Copy, Debug)]
pub struct LayerBand {
    pub index: usize,
    pub z: f64,
    pub height: f64,
}

impl LayerBand {
    /// Where the mesh is cut for this layer: its middle, so a slope is off by
    /// half a layer either way instead of a whole layer in one direction.
    pub fn cut_z(&self) -> f64 {
        self.z - self.height * 0.5
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HeightOpts {
    /// Fixed layer height, and the first-layer height when adaptive is on.
    pub nominal: f64,
    pub adaptive: bool,
    pub min_h: f64,
    pub max_h: f64,
}

struct Facet {
    z0: f64,
    z1: f64,
    /// Layer height that keeps the stair-step of this facet inside the quality band.
    height: f64,
}

/// Horizontal stair-step (mm) we are willing to leave on a sloped face.
const QUALITY_MM: f64 = 0.12;

pub fn plan_bands(mesh: &Mesh, opts: &HeightOpts) -> Result<Vec<LayerBand>, String> {
    plan_plate_bands(mesh, &[mesh], opts)
}

/// `mesh`'s bands on a plate of `plate`. Adaptive heights follow the slopes
/// of every mesh on the plate, so each Z takes the thinnest layer any of them
/// needs and every object's bands agree up to its own top.
pub fn plan_plate_bands(
    mesh: &Mesh,
    plate: &[&Mesh],
    opts: &HeightOpts,
) -> Result<Vec<LayerBand>, String> {
    let (_, max) = mesh.bounds().ok_or("empty mesh")?;
    let top = max[2];
    let (min_h, max_h) = if opts.adaptive {
        let min_h = opts.min_h.min(opts.max_h).clamp(0.04, 0.48);
        let max_h = opts.max_h.max(opts.min_h).clamp(min_h, 0.6);
        (min_h, max_h)
    } else {
        let h = opts.nominal.clamp(0.05, 0.6);
        (h, h)
    };
    if top < min_h * 0.5 {
        return Err("mesh is flatter than one layer".into());
    }
    let facets: Vec<Facet> = if opts.adaptive {
        plate
            .iter()
            .flat_map(|m| facets_of(m, min_h, max_h))
            .collect()
    } else {
        Vec::new()
    };

    let mut sweep = Sweep::new(&facets);
    let mut bands = Vec::new();
    let mut floor = 0.0;
    let mut index = 0usize;
    while floor < top - 1e-4 {
        let mut height = if !opts.adaptive {
            opts.nominal.clamp(0.05, 0.6)
        } else if index == 0 {
            opts.nominal.clamp(min_h, max_h)
        } else {
            sweep.recommend(floor, max_h, min_h, max_h)
        };
        if floor + height > top + 1e-6 {
            let remain = top - floor;
            if remain < min_h * 0.45 && !bands.is_empty() {
                let prev: &mut LayerBand = bands.last_mut().unwrap();
                prev.height += remain;
                prev.z = top;
                break;
            }
            height = remain.max(0.02);
        }
        floor += height;
        bands.push(LayerBand {
            index,
            z: floor,
            height,
        });
        index += 1;
    }
    if bands.is_empty() {
        return Err("mesh is flatter than one layer".into());
    }
    Ok(bands)
}

fn facets_of(mesh: &Mesh, min_h: f64, max_h: f64) -> Vec<Facet> {
    let mut out = Vec::with_capacity(mesh.triangles.len());
    for tri in &mesh.triangles {
        let mut z0 = tri[0][2];
        let mut z1 = tri[0][2];
        for v in tri.iter().skip(1) {
            z0 = z0.min(v[2]);
            z1 = z1.max(v[2]);
        }
        if z1 - z0 < 1e-6 {
            continue;
        }
        out.push(Facet {
            z0,
            z1,
            height: height_for_slope(normal_z(tri), min_h, max_h),
        });
    }
    out
}

fn normal_z(tri: &[[f64; 3]; 3]) -> f64 {
    let ux = tri[1][0] - tri[0][0];
    let uy = tri[1][1] - tri[0][1];
    let uz = tri[1][2] - tri[0][2];
    let vx = tri[2][0] - tri[0][0];
    let vy = tri[2][1] - tri[0][1];
    let vz = tri[2][2] - tri[0][2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    if len < 1e-12 {
        0.0
    } else {
        (nz / len).abs()
    }
}

/// `|nz|` is the sine of the surface angle from vertical.
/// Vertical walls (`nz ≈ 0`) take the thick end of the band. Shallow slopes
/// and the curved faces that turn toward horizontal take the thin end.
fn height_for_slope(nz_abs: f64, min_h: f64, max_h: f64) -> f64 {
    let nz = nz_abs.clamp(0.0, 1.0);
    if nz < 0.04 {
        return max_h;
    }
    let horizontal = (1.0 - nz * nz).max(0.0).sqrt();
    if horizontal < 1e-4 {
        return min_h;
    }
    let tan_phi = nz / horizontal;
    (QUALITY_MM / tan_phi).clamp(min_h, max_h)
}

/// `recommend` for a floor that only rises: each facet enters once its bottom
/// is inside the window and leaves once its top is below the floor, so a plan
/// costs the facets once instead of once per layer.
struct Sweep<'a> {
    facets: Vec<&'a Facet>,
    next: usize,
    open: BinaryHeap<(Reverse<u64>, usize)>,
}

impl<'a> Sweep<'a> {
    fn new(facets: &'a [Facet]) -> Self {
        let mut facets: Vec<&Facet> = facets
            .iter()
            .filter(|f| f.z0.is_finite() && f.z1.is_finite())
            .collect();
        facets.sort_by(|a, b| a.z0.total_cmp(&b.z0));
        Self {
            facets,
            next: 0,
            open: BinaryHeap::new(),
        }
    }

    fn recommend(&mut self, z: f64, window: f64, min_h: f64, max_h: f64) -> f64 {
        let z1 = z + window;
        while let Some(facet) = self.facets.get(self.next) {
            if facet.z0 > z1 + 1e-6 {
                break;
            }
            self.open.push((Reverse(facet.height.to_bits()), self.next));
            self.next += 1;
        }
        while let Some(&(_, i)) = self.open.peek() {
            if self.facets[i].z1 >= z - 1e-6 {
                break;
            }
            self.open.pop();
        }
        let height = match self.open.peek() {
            Some(&(_, i)) => max_h.min(self.facets[i].height),
            None => max_h,
        };
        height.clamp(min_h, max_h)
    }
}

#[cfg(test)]
fn recommend(facets: &[Facet], z: f64, window: f64, min_h: f64, max_h: f64) -> f64 {
    let z1 = z + window;
    let mut height = max_h;
    for facet in facets {
        if facet.z1 >= z - 1e-6 && facet.z0 <= z1 + 1e-6 {
            height = height.min(facet.height);
        }
    }
    height.clamp(min_h, max_h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(height: f64) -> Mesh {
        let (x, y, z) = (10.0, 10.0, height);
        let p = |i: usize| -> [f64; 3] {
            [
                if i & 1 == 0 { 0.0 } else { x },
                if i & 2 == 0 { 0.0 } else { y },
                if i & 4 == 0 { 0.0 } else { z },
            ]
        };
        let quads = [
            [0, 2, 3, 1],
            [4, 5, 7, 6],
            [0, 1, 5, 4],
            [2, 6, 7, 3],
            [0, 4, 6, 2],
            [1, 3, 7, 5],
        ];
        let mut triangles = Vec::new();
        for q in quads {
            triangles.push([p(q[0]), p(q[1]), p(q[2])]);
            triangles.push([p(q[0]), p(q[2]), p(q[3])]);
        }
        Mesh { triangles }
    }

    #[test]
    fn a_tall_part_plans_past_twenty_thousand_layers() {
        let opts = HeightOpts {
            nominal: 0.05,
            adaptive: false,
            min_h: 0.05,
            max_h: 0.05,
        };
        let bands = plan_bands(&column(5000.0), &opts).unwrap();
        assert_eq!(bands.len(), 100_000);
        assert!((bands.last().unwrap().z - 5000.0).abs() < 1e-6);
        assert!(bands.iter().enumerate().all(|(i, b)| b.index == i));
    }

    #[test]
    fn adaptive_heights_on_a_tall_part_plan_past_twenty_thousand_layers() {
        let opts = HeightOpts {
            nominal: 0.04,
            adaptive: true,
            min_h: 0.04,
            max_h: 0.05,
        };
        let bands = plan_bands(&column(2000.0), &opts).unwrap();
        assert!(bands.len() > 39_000, "{} layers", bands.len());
        assert!((bands.last().unwrap().z - 2000.0).abs() < 1e-6);
    }

    #[test]
    fn the_sweep_picks_what_every_facet_would() {
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let triangles: Vec<[[f64; 3]; 3]> = (0..400)
            .map(|_| {
                let base = [next() * 50.0, next() * 50.0, next() * 200.0];
                let mut tri = [base; 3];
                for v in tri.iter_mut().skip(1) {
                    *v = [
                        base[0] + next() * 4.0 - 2.0,
                        base[1] + next() * 4.0 - 2.0,
                        base[2] + next() * next() * 3.0,
                    ];
                }
                tri
            })
            .collect();
        let mesh = Mesh { triangles };
        let (min_h, max_h) = (0.04, 0.3);
        let facets = facets_of(&mesh, min_h, max_h);
        let mut sweep = Sweep::new(&facets);
        let mut z = 0.0;
        let mut picked = Vec::new();
        while z < 205.0 {
            let want = recommend(&facets, z, max_h, min_h, max_h);
            assert_eq!(sweep.recommend(z, max_h, min_h, max_h), want, "at z {z}");
            picked.push(want.to_bits());
            z += min_h + next() * (max_h - min_h);
        }
        assert!(picked.len() > 1000);
        picked.sort_unstable();
        picked.dedup();
        assert!(picked.len() > 20, "{} distinct heights", picked.len());
    }
}
