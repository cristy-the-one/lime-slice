//! Concentric brim around tree trunks that stand on the first layer.
//!
//! A trunk that finishes the walk on layer 0 is on the bed. Its disk is the
//! circle `organic_disks` already printed. The brim is the band outside that
//! circle, kept off the part, filled with one loop per line width.
//!
//! On a belt the trunks meet the tilted belt instead, and their feet are
//! spread and cut along the belt line (`belt_feet`, `foot_loops`).

use crate::adaptive::LayerBand;
use crate::poly::{boolean_diff, offset_loops, resolve_nonzero, signed_area, Loop};

use super::{clip_half, Disk, FloorPlane, NodeId, SupportLayer};

/// Outward rings covering `brim_mm` past each on-bed trunk. Empty when the
/// brim is off, so a slice that does not ask never offsets.
pub(crate) fn on_bed_brim(disks: &[Disk], part: &[Loop], line_width: f64, brim_mm: f64) -> Vec<Loop> {
    if disks.is_empty() || brim_mm <= 1e-6 || line_width <= 1e-6 {
        return Vec::new();
    }
    let circles: Vec<Loop> = disks
        .iter()
        .map(|disk| circle(disk.xy, disk.r.max(0.32)))
        .collect();
    let solid = if circles.len() == 1 {
        circles
    } else {
        resolve_nonzero(circles)
    };
    if solid.is_empty() {
        return Vec::new();
    }
    let grown = offset_loops(&solid, brim_mm);
    let mut band = boolean_diff(&grown, &solid);
    if !part.is_empty() {
        let keep_out = offset_loops(part, line_width * 0.5);
        band = boolean_diff(&band, &keep_out);
    }
    let steps = ((brim_mm / line_width).ceil() as u32).clamp(1, 40);
    let mut out = Vec::new();
    let mut region = band;
    for _ in 0..steps {
        let bead = offset_loops(&region, -line_width * 0.5);
        let rings: Vec<Loop> = bead
            .into_iter()
            .filter(|loop_| signed_area(loop_) > 0.35 && loop_.len() >= 3)
            .collect();
        if rings.is_empty() {
            break;
        }
        out.extend(rings);
        region = offset_loops(&region, -line_width);
        region.retain(|loop_| signed_area(loop_) > 0.35 && loop_.len() >= 3);
        if region.is_empty() {
            break;
        }
    }
    out
}

/// A trunk where it meets the belt on one layer: its centre and radius as it
/// stood before the belt clip, and the radius its foot spreads to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Foot {
    pub xy: [f64; 2],
    pub r: f64,
    pub spread: f64,
    pub node: NodeId,
}

/// Trunks whose foot reaches the belt on layer `i`.
///
/// The belt clip shrinks a disk that crosses the belt to the circle that only
/// touches it, so a trunk would meet the belt with one bead's tip on every
/// layer. A foot is the trunk's own disk, spread to `spread`, cut flat along
/// the belt line instead. A plumb trunk meets the tilted belt over several
/// layers; its spread foot reaches lower layers than the walk carried the
/// trunk, so a trunk that landed on a layer above is carried down plumb too.
pub(crate) fn belt_feet(
    stood: &[SupportLayer],
    bands: &[LayerBand],
    floor: FloorPlane,
    i: usize,
    spread: f64,
) -> Vec<Foot> {
    let Some(band) = bands.get(i) else {
        return Vec::new();
    };
    let y_max = floor.y_max(band.z);
    let meets = |y: f64, r: f64| y + r > y_max && y - r < y_max;
    let mut feet: Vec<Foot> = stood
        .get(i)
        .map(|layer| {
            layer
                .disks
                .iter()
                .filter(|d| meets(d.xy[1], d.r.max(spread)))
                .map(|d| Foot {
                    xy: d.xy,
                    r: d.r,
                    spread: d.r.max(spread),
                    node: d.node,
                })
                .collect()
        })
        .unwrap_or_default();
    if spread <= 1e-6 {
        return feet;
    }
    let mut fall = 0.0;
    for j in i + 1..stood.len().min(bands.len()) {
        fall += floor.fall(bands[j].height);
        if fall > 4.0 * spread + 1.0 {
            break;
        }
        let below = &stood[j - 1].disks;
        let step = floor.fall(bands[j].height);
        let y_below = floor.y_max(bands[j - 1].z);
        for d in &stood[j].disks {
            let landed = d.xy[1] + step - d.r > y_below && !below.iter().any(|b| b.node == d.node);
            let y = d.xy[1] + fall;
            if landed && d.r < spread && meets(y, spread) {
                feet.push(Foot {
                    xy: [d.xy[0], y],
                    r: d.r,
                    spread,
                    node: d.node,
                });
            }
        }
    }
    feet
}

/// The printed cross-section of `feet` on a layer whose belt line is
/// `y_max`: each trunk's own disk, and its spread kept `gap` off the part,
/// cut along the belt line.
pub(crate) fn foot_loops(feet: &[Foot], y_max: f64, part: &[Loop], gap: f64) -> Vec<Loop> {
    if feet.is_empty() {
        return Vec::new();
    }
    let own: Vec<Loop> = feet.iter().map(|f| circle(f.xy, f.r.max(0.32))).collect();
    let wide: Vec<Loop> = feet
        .iter()
        .filter(|f| f.spread > f.r)
        .map(|f| circle(f.xy, f.spread))
        .collect();
    let mut solid = own;
    if !wide.is_empty() {
        let wide = resolve_nonzero(wide);
        let wide = if part.is_empty() {
            wide
        } else {
            boolean_diff(&wide, &offset_loops(part, gap))
        };
        solid.extend(wide);
    }
    let solid = resolve_nonzero(solid);
    clip_half(&solid, y_max)
        .into_iter()
        .filter(|l| l.len() >= 3 && signed_area(l).abs() >= 0.05)
        .collect()
}

fn circle(center: [f64; 2], radius: f64) -> Loop {
    let n = 24;
    (0..n)
        .map(|i| {
            let a = i as f64 * std::f64::consts::TAU / n as f64;
            [
                center[0] + radius * a.cos(),
                center[1] + radius * a.sin(),
            ]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(r: f64) -> Disk {
        Disk {
            xy: [0.0, 0.0],
            r,
            node: super::super::NodeId(1),
        }
    }

    fn radii(loops: &[Loop]) -> (f64, f64) {
        let mut min_r = f64::MAX;
        let mut max_r = 0.0_f64;
        for loop_ in loops {
            for p in loop_ {
                let r = p[0].hypot(p[1]);
                min_r = min_r.min(r);
                max_r = max_r.max(r);
            }
        }
        (min_r, max_r)
    }

    #[test]
    fn a_bed_trunk_grows_concentric_brim_outside_itself() {
        assert!(on_bed_brim(&[disk(2.0)], &[], 0.45, 0.0).is_empty());
        let rings = on_bed_brim(&[disk(2.0)], &[], 0.45, 1.35);
        assert!(rings.len() >= 2, "loops {}", rings.len());
        let (min_r, max_r) = radii(&rings);
        assert!(min_r > 2.0, "inner centerline {min_r}");
        assert!(max_r > 2.7, "outer centerline {max_r}");
        assert!(max_r < 2.0 + 1.35 + 0.2, "outer centerline {max_r}");
    }

    #[test]
    fn brim_stops_at_the_part() {
        let part = vec![vec![
            [1.0, -10.0],
            [20.0, -10.0],
            [20.0, 10.0],
            [1.0, 10.0],
        ]];
        let rings = on_bed_brim(&[disk(2.0)], &part, 0.45, 1.35);
        assert!(!rings.is_empty());
        let mut saw_free_side = false;
        for loop_ in &rings {
            for p in loop_ {
                assert!(p[0] < 1.6, "brim entered the part at {p:?}");
                saw_free_side |= p[0] < 0.0;
            }
        }
        assert!(saw_free_side, "the free side of the trunk lost its brim");
    }
}
