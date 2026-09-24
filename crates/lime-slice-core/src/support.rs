use crate::adaptive::LayerBand;
use crate::contour::Loop;
use crate::toolpath::{boolean_diff, boolean_union, drop_slivers, offset_loops};

#[derive(Clone, Debug)]
pub struct SupportLayer {
    pub sparse: Vec<Loop>,
    pub interface: Vec<Loop>,
}

#[derive(Clone, Copy, Debug)]
pub struct SupportOpts {
    pub angle_deg: f64,
    pub xy_gap: f64,
    pub z_gap: f64,
    pub interface_layers: u32,
}

impl Default for SupportOpts {
    fn default() -> Self {
        Self {
            angle_deg: 45.0,
            xy_gap: 0.55,
            z_gap: 0.2,
            interface_layers: 3,
        }
    }
}

/// Project overhangs down to the bed as a sparse column plus a few dense interface layers.
pub fn build_supports(
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    opts: &SupportOpts,
) -> Vec<SupportLayer> {
    let n = bands.len();
    let mut out = vec![
        SupportLayer {
            sparse: Vec::new(),
            interface: Vec::new(),
        };
        n
    ];
    if n == 0 {
        return out;
    }
    let angle = opts.angle_deg.clamp(15.0, 75.0).to_radians().tan().max(0.2);
    let iface_n = opts.interface_layers.max(1);

    // (contact_z, region) waiting until the air gap has been cleared.
    let mut pending: Vec<(f64, Vec<Loop>)> = Vec::new();
    // Interface shells still ageing, youngest first. `left` is layers still printed dense.
    let mut gens: Vec<(Vec<Loop>, u32)> = Vec::new();
    let mut sparse: Vec<Loop> = Vec::new();

    for i in (0..n).rev() {
        let mut born: Vec<Loop> = Vec::new();
        pending.retain(|(contact_z, region)| {
            if bands[i].z <= *contact_z + 1e-6 {
                born = boolean_union(&born, region);
                false
            } else {
                true
            }
        });
        if !born.is_empty() {
            gens.insert(0, (drop_slivers(born, 0.2), iface_n));
        }

        let part = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
        let gap = if part.is_empty() {
            Vec::new()
        } else {
            offset_loops(part, opts.xy_gap)
        };
        let iface_area = union_all(gens.iter().map(|(r, _)| r.as_slice()));
        let iface_print = drop_slivers(boolean_diff(&iface_area, &gap), 0.2);
        let sparse_only = boolean_diff(&sparse, &iface_area);
        let sparse_print = drop_slivers(boolean_diff(&sparse_only, &gap), 0.2);
        out[i] = SupportLayer {
            sparse: sparse_print,
            interface: iface_print,
        };

        // A column that has landed on the model stops.
        let mut next_gens = Vec::new();
        for (region, left) in gens {
            let trimmed = drop_slivers(boolean_diff(&region, part), 0.15);
            if trimmed.is_empty() {
                continue;
            }
            if left <= 1 {
                sparse = boolean_union(&sparse, &trimmed);
            } else {
                next_gens.push((trimmed, left - 1));
            }
        }
        gens = next_gens;
        sparse = drop_slivers(boolean_diff(&sparse, part), 0.15);

        if i == 0 {
            continue;
        }
        let upper = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
        let lower = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
        if upper.is_empty() {
            continue;
        }
        let dx = bands[i].height / angle;
        let supported = offset_loops(lower, dx);
        let overhang = drop_slivers(boolean_diff(upper, &supported), 0.35);
        if overhang.is_empty() {
            continue;
        }
        let underside = bands[i].z - bands[i].height;
        pending.push((underside - opts.z_gap, overhang));
    }
    out
}

fn union_all<'a>(regions: impl Iterator<Item = &'a [Loop]>) -> Vec<Loop> {
    let mut acc: Vec<Loop> = Vec::new();
    for region in regions {
        acc = boolean_union(&acc, region);
    }
    acc
}
