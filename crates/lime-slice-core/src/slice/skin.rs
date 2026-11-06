use crate::adaptive::LayerBand;
use crate::poly::{
    boolean_diff, boolean_intersect, offset_loops, resolve_nonzero, signed_area, Loop,
};
use crate::strategy::ResolvedStrategy;
use crate::toolpath::{island_loops, Skin};
use rayon::iter::{IntoParallelIterator, ParallelIterator};
use std::sync::Arc;

pub(super) fn roof_distances(
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    wall_stack: f64,
) -> Vec<f64> {
    let n = bands.len();
    let roof: Vec<bool> = (0..n)
        .into_par_iter()
        .map(|i| {
            i + 1 >= n
                || exposed_past_walls(
                    &contours[i],
                    contours.get(i + 1).map(Vec::as_slice).unwrap_or(&[]),
                    wall_stack,
                )
        })
        .collect();
    let mut dist = vec![0.0; n];
    let mut since = 0.0;
    for i in (0..n).rev() {
        if roof[i] {
            since = 0.0;
        }
        dist[i] = since;
        since += bands[i].height;
    }
    dist
}

/// Each layer's skin at both pairs of shell depths `shell_depths` gives,
/// speed's first. A floor is the area of a layer that the layer below does
/// not cover, and a roof the area the layer above does not cover; the first
/// layer is all floor and the last all roof. A layer's bottom skin is every
/// floor whose underside is within the bottom depth below its top, and its
/// top skin every roof within the top depth above it, each clipped to the
/// layer. Inside a closed part neither reaches, so it prints as interior.
///
/// With `shallow`, a floor or roof thinner than the walls is kept, and the
/// walls are taken off the joined skin instead. A slope so shallow that each
/// layer steps past half the walls exposes such a strip on every layer: alone
/// each is closed by the walls, but the strips of the shell depth together
/// make a skin, and without it the slab between the walls prints hollow.
///
/// With `under_walls`, a layer whose walls stand, a whole wall stack wide, on
/// the interior of the layer below gets top skin under them, `UNDER_WALLS_MM`
/// deep: see `under_walls`. Without it those walls print on whatever sparse
/// infill is there, which is nothing where no roof asked for lightning.
pub(super) fn skin_regions(
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    wall_stack: f64,
    shallow: bool,
    under_walls: bool,
) -> [Vec<Arc<Skin>>; 2] {
    let n = bands.len();
    let exposed = |current: &[Loop], other: &[Loop]| {
        if shallow {
            exposed_strips(current, other)
        } else {
            exposed_core(current, other, wall_stack)
        }
    };
    let floors: Vec<Vec<Loop>> = (0..n)
        .into_par_iter()
        .map(|i| match i {
            0 => contours[0].clone(),
            _ => exposed(&contours[i], &contours[i - 1]),
        })
        .collect();
    let roofs: Vec<Vec<Loop>> = (0..n)
        .into_par_iter()
        .map(|i| match contours.get(i + 1) {
            None => contours[i].clone(),
            Some(above) => exposed(&contours[i], above),
        })
        .collect();
    let ceilings: Vec<Vec<Loop>> = if under_walls {
        (0..n)
            .into_par_iter()
            .map(|i| match contours.get(i + 1) {
                Some(above) => self::under_walls(&contours[i], above, wall_stack),
                None => Vec::new(),
            })
            .collect()
    } else {
        Vec::new()
    };
    let joined = |skin: Vec<Loop>| {
        if shallow {
            cored(skin, wall_stack)
        } else {
            skin
        }
    };
    let at = |(bottom, top): (f64, f64)| -> Vec<Arc<Skin>> {
        (0..n)
            .into_par_iter()
            .map(|i| {
                let mut under: Vec<Loop> = Vec::new();
                for f in (0..=i).rev() {
                    let dist = bands[f..=i].iter().fold(0.0, |d, b| d + b.height);
                    if dist > bottom + 1e-6 {
                        break;
                    }
                    under.extend(floors[f].iter().cloned());
                }
                let mut over: Vec<Loop> = Vec::new();
                for r in i..n {
                    let dist = bands[i + 1..=r].iter().rev().fold(0.0, |d, b| d + b.height);
                    if dist > top {
                        break;
                    }
                    over.extend(roofs[r].iter().cloned());
                }
                for (r, ceiling) in ceilings.iter().enumerate().skip(i) {
                    let dist = bands[i + 1..=r].iter().fold(0.0, |d, b| d + b.height);
                    if dist > UNDER_WALLS_MM + 1e-6 {
                        break;
                    }
                    over.extend(ceiling.iter().cloned());
                }
                Arc::new(Skin {
                    bottom: joined(clipped_union(&contours[i], under)),
                    top: joined(clipped_union(&contours[i], over)),
                })
            })
            .collect()
    };
    [at(SPEED_SHELLS), at(TOUGH_SHELLS)]
}

/// Core of an exposed island, past half the walls, that makes it skin, mm².
pub(super) const SKIN_CORE_MM2: f64 = 0.05;

/// How deep the skin under walls standing on interior reaches, mm.
pub(super) const UNDER_WALLS_MM: f64 = 1.2;

/// Where the walls of `above` stand on the interior of `current`, past the
/// walls of `current`, grown back to the width of those walls. Only a stretch
/// a whole wall stack wide counts: a slope steps its walls in by less than
/// that a layer and stands on the walls below, while a lip or a comb born
/// over a slot lands its walls on nothing.
pub(super) fn under_walls(current: &[Loop], above: &[Loop], wall_stack: f64) -> Vec<Loop> {
    if current.is_empty() || above.is_empty() {
        return Vec::new();
    }
    let core = offset_loops(current, -wall_stack);
    if core.is_empty() {
        return Vec::new();
    }
    let band = boolean_diff(above, &offset_loops(above, -wall_stack));
    let landed = boolean_intersect(&core, &band);
    let wide: Vec<Loop> = island_loops(&landed)
        .into_iter()
        .filter(|island| {
            let inner = offset_loops(island, -wall_stack * 0.48);
            inner.iter().map(|l| signed_area(l)).sum::<f64>() >= SKIN_CORE_MM2
        })
        .flatten()
        .collect();
    if wide.is_empty() {
        return wide;
    }
    offset_loops(&wide, wall_stack * 0.5 + 0.05)
}

/// Bottom and top shell depths, mm: speed's, and a strategy's over 0.6 toughness.
pub(super) const SPEED_SHELLS: (f64, f64) = (0.6, 0.6);
pub(super) const TOUGH_SHELLS: (f64, f64) = (1.2, 1.0);

/// The skin of a layer, of `skins` at both shell depths, for `strategy`.
pub(super) fn skin_of(skins: [&Arc<Skin>; 2], strategy: &ResolvedStrategy) -> Arc<Skin> {
    Arc::clone(skins[usize::from(strategy.toughness > 0.6)])
}

/// The part of `layer` inside any of `pieces`, which may overlap.
pub(super) fn clipped_union(layer: &[Loop], pieces: Vec<Loop>) -> Vec<Loop> {
    if pieces.is_empty() || layer.is_empty() {
        return Vec::new();
    }
    boolean_intersect(layer, &resolve_nonzero(pieces))
}

/// The islands of `current` that `other` does not cover, each kept only when
/// it reaches deeper than the walls. A thinner strip along the outline, as on
/// a slope, is closed by the walls; an island with any core left is skin.
pub(super) fn exposed_core(current: &[Loop], other: &[Loop], wall_stack: f64) -> Vec<Loop> {
    if current.is_empty() {
        return Vec::new();
    }
    if other.is_empty() {
        return current.to_vec();
    }
    let exposed = boolean_diff(current, other);
    island_loops(&exposed)
        .into_iter()
        .filter(|island| {
            let core = offset_loops(island, -wall_stack * 0.5);
            core.iter().map(|l| signed_area(l)).sum::<f64>() >= SKIN_CORE_MM2
        })
        .flatten()
        .collect()
}

/// Every part of `current` that `other` does not cover, however thin.
pub(super) fn exposed_strips(current: &[Loop], other: &[Loop]) -> Vec<Loop> {
    if current.is_empty() || other.is_empty() {
        return current.to_vec();
    }
    boolean_diff(current, other)
}

/// The islands of `skin` with a core past half the walls, as `exposed_core`
/// keeps them.
pub(super) fn cored(skin: Vec<Loop>, wall_stack: f64) -> Vec<Loop> {
    if skin.is_empty() {
        return skin;
    }
    island_loops(&skin)
        .into_iter()
        .filter(|island| {
            let core = offset_loops(island, -wall_stack * 0.5);
            core.iter().map(|l| signed_area(l)).sum::<f64>() >= SKIN_CORE_MM2
        })
        .flatten()
        .collect()
}

/// `current` has area `other` does not cover, reaching deeper than the walls:
/// a roof when `other` is the layer above, a floor when it is the layer below.
/// A thinner strip along the outline, as on a slope, is closed by the walls.
pub(super) fn exposed_past_walls(current: &[Loop], other: &[Loop], wall_stack: f64) -> bool {
    if current.is_empty() {
        return false;
    }
    if other.is_empty() {
        return true;
    }
    let exposed = boolean_diff(current, other);
    if exposed.is_empty() {
        return false;
    }
    let core = offset_loops(&exposed, -wall_stack * 0.5);
    core.iter().map(|l| signed_area(l)).sum::<f64>() >= 1.0
}
