//! A compact outline of the grown trees for picking in the UI.

use serde::Serialize;

use super::{End, Life, Limb, Supports};
use crate::adaptive::LayerBand;

/// Every limb that still prints, as parallel columns in ascending limb id.
/// `start[k]..start[k + 1]` are limb `k`'s knots in `xs`, `ys`, `zs`, `rs`,
/// top to bottom, thinned to the disks a straight run cannot stand in for.
///
/// The UI builds a branch's sites from a limb plus every limb whose `into`
/// chain reaches it, and a tree's sites from every limb with the same
/// `tree`. A site is `[siteX, siteY]` at `siteZ`, which is the exact band z
/// an edit must send back.
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
}

/// A kept interior disk sits farther than this from the line between the
/// disks around it, in x, y, or radius.
const THIN_MM: f64 = 0.05;

pub(crate) fn skeleton(supports: &Supports, bands: &[LayerBand]) -> SupportSkeleton {
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
        let disks = printed(limb, id, supports, bands);
        for &i in &thinned(&disks) {
            let [x, y, z, r] = disks[i];
            out.xs.push(hundredth(x));
            out.ys.push(hundredth(y));
            out.zs.push(hundredth(z));
            out.rs.push(hundredth(r));
        }
        out.start.push(out.xs.len() as u32);
    }
    out
}

/// `[x, y, z, r]` of each disk the limb prints, top layer first.
fn printed(limb: &Limb, id: u32, supports: &Supports, bands: &[LayerBand]) -> Vec<[f64; 4]> {
    (limb.bottom()..=limb.top)
        .rev()
        .filter_map(|i| {
            let disks = &supports.layers[i].disks;
            let at = disks.binary_search_by_key(&id, |d| d.node.0).ok()?;
            let d = disks[at];
            Some([d.xy[0], d.xy[1], bands[i].z, d.r])
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
