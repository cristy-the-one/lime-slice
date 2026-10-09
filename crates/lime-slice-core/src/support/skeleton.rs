//! A compact outline of the grown trees for picking in the UI.

use serde::Serialize;

use super::{CoverageGap, End, Life, Limb, Supports, TiltedGap};
use crate::adaptive::LayerBand;
use crate::belt::Belt;
use crate::gcode::PlateLayer;

/// Every limb that still prints, as parallel columns in ascending limb id.
/// `start[k]..start[k + 1]` are limb `k`'s knots in `xs`, `ys`, `zs`, `rs`,
/// top to bottom, thinned to the disks a straight run cannot stand in for.
///
/// The UI builds a branch's sites from a limb plus every limb whose `into`
/// chain reaches it, and a tree's sites from every limb with the same
/// `tree`. A site is `[siteX, siteY]` at `siteZ`, which is the exact band z
/// an edit must send back. Sites are in the slice frame and are ids to send
/// back as they are, never to draw.
///
/// The knots are in the reply frame: the part frame on a flat bed, and on a
/// belt the preview's frame, the lab less the object's offset.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSkeleton {
    /// Walk node id of each limb.
    pub id: Vec<u32>,
    /// Id of the root limb of each limb's tree.
    pub tree: Vec<u32>,
    /// Id of the limb each one merged into, `0` for a root.
    pub into: Vec<u32>,
    /// `1` while the limb's own tip prints, `0` once pruned down to a merge.
    pub live: Vec<u8>,
    /// Birth site, rounded to 1 µm.
    pub site_x: Vec<f64>,
    pub site_y: Vec<f64>,
    /// Birth z, exactly as the band carries it.
    pub site_z: Vec<f64>,
    /// Offsets into the knot columns, one more than there are limbs.
    pub start: Vec<u32>,
    /// Printed disks, rounded to 0.01 mm.
    pub xs: Vec<f32>,
    pub ys: Vec<f32>,
    pub zs: Vec<f32>,
    pub rs: Vec<f32>,
    /// Belt only: the `PreviewLayer.z` of the layer each knot's disk prints
    /// on, one per knot. A belt layer's `z` is the belt position, so the
    /// knot's own height says nothing about which layer it is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ls: Option<Vec<f64>>,
}

/// How a belt reply draws the slice frame. Its knots go to the lab, less the
/// object's offset, as the preview's points do, and each is named by the belt
/// position of its layer. A coverage gap's outline goes the same way.
pub(crate) struct Tilt<'a> {
    pub belt: &'a Belt,
    /// Where the object's part frame sits on the bed.
    pub offset: [f64; 2],
    /// The planned plate, which `LayerBand::index` numbers.
    pub plate: &'a [PlateLayer],
}

/// `gaps` with the place the belt preview draws each. `bands` carry plate
/// layer numbers, as `skeleton`'s do. Without a tilt, a flat bed, they are
/// as they are.
pub(crate) fn tilt_gaps(
    gaps: &[CoverageGap],
    bands: &[LayerBand],
    tilt: Option<&Tilt>,
) -> Vec<CoverageGap> {
    gaps.iter()
        .map(|gap| tilt.map_or_else(|| gap.clone(), |tilt| tilt_gap(gap, bands, tilt)))
        .collect()
}

/// A gap on a layer the bands do not name is returned as it is.
fn tilt_gap(gap: &CoverageGap, bands: &[LayerBand], tilt: &Tilt) -> CoverageGap {
    let layer_at = |z: f64| {
        bands
            .iter()
            .find(|b| b.z == z)
            .map(|b| &tilt.plate[b.index])
    };
    let (Some(low), Some(high)) = (layer_at(gap.z[0]), layer_at(gap.z[1])) else {
        return gap.clone();
    };
    let position = |layer: &PlateLayer| tilt.belt.position(layer.z, layer.belt_shift);
    let outline = gap
        .outline
        .iter()
        .map(|l| {
            l.iter()
                .map(|p| {
                    let lab = tilt
                        .belt
                        .frame
                        .lab(f64::from(p[0]), f64::from(p[1]), high.z);
                    [
                        hundredth(lab[0] - tilt.offset[0]),
                        hundredth(lab[1] - tilt.offset[1]),
                        hundredth(lab[2]),
                    ]
                })
                .collect()
        })
        .collect();
    CoverageGap {
        tilted: Some(TiltedGap {
            ls: [position(low), position(high)],
            outline,
        }),
        ..gap.clone()
    }
}

/// A kept interior disk sits farther than this from the line between the
/// disks around it, in x, y, or radius.
const THIN_MM: f64 = 0.05;

pub(crate) fn skeleton(
    supports: &Supports,
    bands: &[LayerBand],
    tilt: Option<&Tilt>,
) -> SupportSkeleton {
    let limbs = &supports.forest.limbs;
    let root = |mut k: usize| {
        while let End::Merged { into } = limbs[k].end {
            k = into.0 as usize - 1;
        }
        k as u32 + 1
    };
    let mut out = SupportSkeleton {
        start: vec![0],
        ..SupportSkeleton::default()
    };
    let mut on_layer = Vec::new();
    for (k, limb) in limbs.iter().enumerate() {
        let live = match limb.life {
            Life::Live => 1,
            Life::Trimmed { .. } => 0,
            Life::Removed { .. } => continue,
        };
        let id = k as u32 + 1;
        out.id.push(id);
        out.tree.push(root(k));
        out.into.push(match limb.end {
            End::Merged { into } => into.0,
            _ => 0,
        });
        out.live.push(live);
        let [x, y] = limb.knots[0].xy;
        out.site_x.push(um(x));
        out.site_y.push(um(y));
        out.site_z.push(bands[limb.top].z);
        let (disks, on): (Vec<[f64; 4]>, Vec<usize>) =
            printed(limb, id, supports, bands).into_iter().unzip();
        for &i in &thinned(&disks) {
            let [x, y, z, r] = disks[i];
            let [x, y, z] = match tilt {
                Some(tilt) => {
                    let layer = &tilt.plate[bands[on[i]].index];
                    let lab = tilt.belt.frame.lab(x, y, layer.z);
                    on_layer.push(tilt.belt.position(layer.z, layer.belt_shift));
                    [lab[0] - tilt.offset[0], lab[1] - tilt.offset[1], lab[2]]
                }
                None => [x, y, z],
            };
            out.xs.push(hundredth(x));
            out.ys.push(hundredth(y));
            out.zs.push(hundredth(z));
            out.rs.push(hundredth(r));
        }
        out.start.push(out.xs.len() as u32);
    }
    out.ls = tilt.map(|_| on_layer);
    out
}

/// `[x, y, z, r]` of each disk the limb prints, top layer first, with the
/// band it prints on.
fn printed(
    limb: &Limb,
    id: u32,
    supports: &Supports,
    bands: &[LayerBand],
) -> Vec<([f64; 4], usize)> {
    (limb.bottom()..=limb.top)
        .rev()
        .filter_map(|i| {
            let disks = &supports.layers[i].disks;
            let at = disks.binary_search_by_key(&id, |d| d.node.0).ok()?;
            let d = disks[at];
            Some(([d.xy[0], d.xy[1], bands[i].z, d.r], i))
        })
        .collect()
}

/// Indices of the disks to keep: the first, the last, and every interior
/// disk the straight run between its kept neighbours misses by `THIN_MM`.
fn thinned(disks: &[[f64; 4]]) -> Vec<usize> {
    if disks.len() <= 2 {
        return (0..disks.len()).collect();
    }
    let within = |a: usize, b: usize, m: usize| {
        let t = (disks[m][2] - disks[a][2]) / (disks[b][2] - disks[a][2]);
        [0, 1, 3].iter().all(|&c| {
            let on_line = disks[a][c] + (disks[b][c] - disks[a][c]) * t;
            (disks[m][c] - on_line).abs() <= THIN_MM
        })
    };
    let mut keep = vec![0];
    let mut anchor = 0;
    for end in 2..disks.len() {
        if !(anchor + 1..end).all(|m| within(anchor, end, m)) {
            anchor = end - 1;
            keep.push(anchor);
        }
    }
    keep.push(disks.len() - 1);
    keep
}

fn um(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn hundredth(v: f64) -> f32 {
    ((v * 100.0).round() / 100.0) as f32
}
