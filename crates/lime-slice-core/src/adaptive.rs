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
    let facets = if opts.adaptive {
        facets_of(mesh, min_h, max_h)
    } else {
        Vec::new()
    };

    let mut bands = Vec::new();
    let mut floor = 0.0;
    let mut index = 0usize;
    while floor < top - 1e-4 {
        let mut height = if !opts.adaptive {
            opts.nominal.clamp(0.05, 0.6)
        } else if index == 0 {
            opts.nominal.clamp(min_h, max_h)
        } else {
            recommend(&facets, floor, max_h, min_h, max_h)
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
        if index > 20_000 {
            return Err("layer count exceeded 20000".into());
        }
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
