use super::*;

/// One belt layer's support brim: a line along X at slice `y`, where the
/// layer meets the belt, over `spans`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct BeltBrim {
    pub y: f64,
    pub spans: Vec<[f64; 2]>,
}

/// The belt brim and the belt anchor of each layer, both empty unless asked
/// for. A layer meets the belt along one line; where its supports cross that
/// line they stand on the belt, and those pieces over every layer are the
/// support feet on the belt.
pub(super) fn belt_lines(
    cut: &Contours,
    supports: &Supports,
    floor: FloorPlane,
    settings: &SliceSettings,
    spread: f64,
) -> (Vec<Option<BeltBrim>>, Vec<Option<BeltBrim>>) {
    if !settings.supports
        || (settings.support_tree_brim_mm.is_none() && settings.support_anchor_mm.is_none())
    {
        return (Vec::new(), Vec::new());
    }
    let line_width = settings.line_width;
    let bands = &cut.bands;
    let ys: Vec<f64> = bands
        .iter()
        .map(|b| floor.y_max(b.z) - 0.5 * line_width)
        .collect();
    let feet: Vec<Vec<[f64; 2]>> = (0..bands.len())
        .into_par_iter()
        .map(|i| {
            let Some(layer) = supports.layers.get(i) else {
                return Vec::new();
            };
            let mut spans = line_spans(&layer.sparse, ys[i]);
            spans.extend(line_spans(&layer.interface, ys[i]));
            let circles = layer.disks.iter().map(|d| (d.xy, d.r)).chain(
                supports
                    .belt_feet(bands, i, spread)
                    .into_iter()
                    .map(|f| (f.xy, f.spread)),
            );
            for (c, r) in circles {
                let dy = ys[i] - c[1];
                if dy.abs() < r {
                    let half = (r * r - dy * dy).sqrt();
                    spans.push([c[0] - half, c[0] + half]);
                }
            }
            merge_spans(spans)
        })
        .collect();
    if feet.iter().all(Vec::is_empty) {
        return (Vec::new(), Vec::new());
    }
    // Slice Y between two belt lines, measured along the belt.
    let along = (1.0 + floor.tan_a().powi(2)).sqrt();
    let gap = settings
        .support_xy_gap_mm
        .unwrap_or_else(|| SupportOpts::default().xy_gap);
    // The part where it lies on each belt line, grown by the XY gap.
    let part = |j: usize| -> Vec<[f64; 2]> {
        line_spans(&cut.contours[j], ys[j])
            .into_iter()
            .map(|s| [s[0] - gap, s[1] + gap])
            .collect()
    };
    let brims = match settings.support_tree_brim_mm {
        Some(width) => belt_brims(&ys, &feet, along, width, &part),
        None => Vec::new(),
    };
    let anchors = match settings.support_anchor_mm {
        Some(spacing) => {
            let at: Vec<f64> = ys.iter().map(|y| y * along).collect();
            let mut out = vec![None; bands.len()];
            for j in belt_anchor_layers(&at, &feet, spacing) {
                // The anchor runs through the sparse support and the trees
                // standing on its line, but not over a dense interface.
                let mut taken = part(j);
                if let Some(layer) = supports.layers.get(j) {
                    taken.extend(line_spans(&layer.interface, ys[j]));
                }
                if let Some(Some(brim)) = brims.get(j) {
                    taken.extend(brim.spans.iter().copied());
                }
                out[j] = belt_anchor(ys[j], &feet[j], &merge_spans(taken));
            }
            out
        }
        None => Vec::new(),
    };
    (brims, anchors)
}

/// The brim each belt layer lays beside the supports that stand on the belt.
/// The brim is the belt within the brim width of a foot, measured on the
/// belt, less the feet and the part, so it widens a foot across the belt on
/// its own layer and along the belt on the layers before and after it.
pub(super) fn belt_brims(
    ys: &[f64],
    feet: &[Vec<[f64; 2]>],
    along: f64,
    width: f64,
    part: &(dyn Fn(usize) -> Vec<[f64; 2]> + Sync),
) -> Vec<Option<BeltBrim>> {
    (0..ys.len())
        .into_par_iter()
        .map(|j| {
            let mut spans = Vec::new();
            let mut reach_from = |k: usize| {
                let off = (ys[j] - ys[k]).abs() * along;
                if off > width {
                    return false;
                }
                let reach = (width * width - off * off).sqrt();
                spans.extend(feet[k].iter().map(|s| [s[0] - reach, s[1] + reach]));
                true
            };
            for k in (0..=j).rev() {
                if !reach_from(k) {
                    break;
                }
            }
            for k in j + 1..ys.len() {
                if !reach_from(k) {
                    break;
                }
            }
            if spans.is_empty() {
                return None;
            }
            let mut taken = feet[j].clone();
            taken.extend(part(j));
            let spans = subtract_spans(&merge_spans(spans), &merge_spans(taken));
            (!spans.is_empty()).then_some(BeltBrim { y: ys[j], spans })
        })
        .collect()
}

/// How far a belt anchor runs past the outermost support foot on its line, mm.
pub(crate) const BELT_ANCHOR_REACH_MM: f64 = 5.0;
/// The anchor spacing a request may ask for, mm along the belt.
pub(crate) const BELT_ANCHOR_MIN_MM: f64 = 2.0;
pub(crate) const BELT_ANCHOR_MAX_MM: f64 = 200.0;

/// The layers that lay a belt anchor: the first support foot along the belt,
/// then the next foot at least `spacing` further along it than the anchor
/// before, and the last foot. `at` is each layer's place along the belt, mm.
/// A layer with no foot lays none, so a stretch of belt where no support
/// stands gets none.
pub(super) fn belt_anchor_layers(at: &[f64], feet: &[Vec<[f64; 2]>], spacing: f64) -> Vec<usize> {
    let mut footed: Vec<usize> = (0..at.len())
        .filter(|&i| feet.get(i).is_some_and(|f| !f.is_empty()))
        .collect();
    footed.sort_by(|&a, &b| at[a].total_cmp(&at[b]));
    let (Some(&first), Some(&last)) = (footed.first(), footed.last()) else {
        return Vec::new();
    };
    let mut out = vec![first];
    let mut from = at[first];
    for &i in &footed[1..] {
        if at[i] - from >= spacing - 1e-6 {
            out.push(i);
            from = at[i];
        }
    }
    if out.last() != Some(&last) {
        out.push(last);
    }
    out
}

/// One belt anchor: the line at `y` from the leftmost support foot on it to
/// the rightmost, [`BELT_ANCHOR_REACH_MM`] past each, less `taken` (the part
/// grown by the XY gap, a dense interface, and a brim already there).
pub(super) fn belt_anchor(y: f64, feet: &[[f64; 2]], taken: &[[f64; 2]]) -> Option<BeltBrim> {
    let lo = feet.iter().map(|s| s[0]).fold(f64::INFINITY, f64::min);
    let hi = feet.iter().map(|s| s[1]).fold(f64::NEG_INFINITY, f64::max);
    if lo > hi {
        return None;
    }
    let spans = subtract_spans(
        &[[lo - BELT_ANCHOR_REACH_MM, hi + BELT_ANCHOR_REACH_MM]],
        taken,
    );
    (!spans.is_empty()).then_some(BeltBrim { y, spans })
}

/// Where the line at `y` runs inside `loops`, by even-odd crossings.
pub(super) fn line_spans(loops: &[Loop], y: f64) -> Vec<[f64; 2]> {
    let mut xs = Vec::new();
    for l in loops {
        let n = l.len();
        for k in 0..n {
            let (a, b) = (l[k], l[(k + 1) % n]);
            if (a[1] > y) != (b[1] > y) {
                xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
            }
        }
    }
    xs.sort_by(f64::total_cmp);
    xs.chunks_exact(2).map(|w| [w[0], w[1]]).collect()
}

/// `spans` sorted, with the overlapping ones joined.
pub(super) fn merge_spans(mut spans: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    spans.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut out: Vec<[f64; 2]> = Vec::with_capacity(spans.len());
    for s in spans {
        match out.last_mut() {
            Some(last) if s[0] <= last[1] => last[1] = last[1].max(s[1]),
            _ => out.push(s),
        }
    }
    out
}

/// `spans` less `cut`, both sorted and joined.
pub(super) fn subtract_spans(spans: &[[f64; 2]], cut: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for s in spans {
        let mut from = s[0];
        for c in cut {
            if c[1] <= from || c[0] >= s[1] {
                continue;
            }
            if c[0] > from {
                out.push([from, c[0]]);
            }
            from = from.max(c[1]);
        }
        if from < s[1] {
            out.push([from, s[1]]);
        }
    }
    out
}

/// A belt layer's trunks: the disks the belt clip left, less the trunks whose
/// foot meets the belt here, and those feet cut along the belt line.
pub(super) fn belt_trunks<'a>(
    disks: &'a [Disk],
    feet: &[Foot],
    floor: Option<FloorPlane>,
    z: f64,
    contours: &[Loop],
    settings: &SliceSettings,
) -> (Cow<'a, [Disk]>, Vec<Loop>) {
    let Some(floor) = floor.filter(|_| !feet.is_empty()) else {
        return (Cow::Borrowed(disks), Vec::new());
    };
    let kept: Vec<Disk> = disks
        .iter()
        .filter(|d| !feet.iter().any(|f| f.node == d.node))
        .copied()
        .collect();
    let gap = settings
        .support_xy_gap_mm
        .unwrap_or_else(|| SupportOpts::default().xy_gap);
    (
        Cow::Owned(kept),
        foot_loops(feet, floor.y_max(z), contours, gap),
    )
}

/// The first layer's skirt around the part and its support footprint.
pub(super) fn skirt_paths(
    contours: &[Loop],
    support: Option<&SupportLayer>,
    z: f64,
    blend: &BlendMode,
    settings: &SliceSettings,
) -> Vec<Extrusion> {
    let (sparse, interface) = support
        .map(|s| (s.sparse.as_slice(), s.interface.as_slice()))
        .unwrap_or((&[], &[]));
    let outline = boolean_union(contours, &boolean_union(sparse, interface));
    if outline.is_empty() || !settings.skirt || settings.adhesion == AdhesionType::None {
        return Vec::new();
    }
    let mut strategy = match blend {
        BlendMode::ByRegion { .. } => {
            let mut tough = resolve(pure(StrategyId::Toughness), settings);
            tough.skirt_loops = 1;
            tough
        }
        other => layer_strategy(other, z, settings),
    };
    if settings.adhesion == AdhesionType::Skirt {
        if let Some(loops) = settings.skirt_loops {
            strategy.skirt_loops = loops;
        }
        return plan_skirt(&outline, &strategy, settings.line_width);
    }
    let kind = if settings.adhesion == AdhesionType::MouseEars {
        plan_mouse_ears
    } else {
        plan_brim
    };
    kind(
        &outline,
        &strategy,
        settings.line_width,
        settings.brim_width_mm,
        settings.brim_gap_mm,
    )
}

/// How the first layer holds to the bed. Omitted is the existing skirt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AdhesionType {
    #[default]
    Skirt,
    Brim,
    MouseEars,
    None,
}

impl AdhesionType {
    pub fn is_skirt(&self) -> bool {
        *self == Self::Skirt
    }

    pub fn uses_brim(self) -> bool {
        matches!(self, Self::Brim | Self::MouseEars)
    }
}
