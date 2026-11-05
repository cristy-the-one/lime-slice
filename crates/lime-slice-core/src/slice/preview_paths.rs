use super::*;

/// Coordinates, speeds, and weights on the wire are rounded to 1 µm (or 0.001).
pub(super) struct Rounded(f64);

impl Serialize for Rounded {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_f64((self.0 * 1000.0).round() / 1000.0)
    }
}

/// A layer's paths as parallel arrays, so a large preview is a few long
/// number arrays instead of one object per path. `start[i]..start[i + 1]`
/// are path `i`'s points in `xy` (two numbers each) and `z` (one each). `z` is
/// empty when every point sits on the layer, and `null` marks a point that does.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PathColumns<'a> {
    pub(super) kinds: Vec<&'a str>,
    pub(super) strategies: Vec<&'a str>,
    pub(super) kind: Vec<u8>,
    pub(super) strategy: Vec<u8>,
    pub(super) width: Vec<Rounded>,
    pub(super) speed: Vec<Rounded>,
    pub(super) effective_speed: Vec<Rounded>,
    pub(super) toughness: Vec<Rounded>,
    pub(super) bead_height: Vec<Rounded>,
    pub(super) start: Vec<u32>,
    pub(super) xy: Vec<Rounded>,
    pub(super) z: Vec<Rounded>,
    /// Each path's object. Empty when every path is object 0.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) object: Vec<u16>,
}

pub(super) fn path_columns<S: serde::Serializer>(
    paths: &[PreviewPath],
    s: S,
) -> Result<S::Ok, S::Error> {
    fn slot<'a>(table: &mut Vec<&'a str>, name: &'a str) -> u8 {
        match table.iter().position(|k| *k == name) {
            Some(i) => i as u8,
            None => {
                table.push(name);
                (table.len() - 1) as u8
            }
        }
    }
    let points: usize = paths.iter().map(|p| p.pts.len()).sum();
    let has_z = paths.iter().any(|p| !p.zs.is_empty());
    let mut c = PathColumns {
        kinds: Vec::new(),
        strategies: Vec::new(),
        kind: Vec::with_capacity(paths.len()),
        strategy: Vec::with_capacity(paths.len()),
        width: Vec::with_capacity(paths.len()),
        speed: Vec::with_capacity(paths.len()),
        effective_speed: Vec::with_capacity(paths.len()),
        toughness: Vec::with_capacity(paths.len()),
        bead_height: Vec::with_capacity(paths.len()),
        start: Vec::with_capacity(paths.len() + 1),
        xy: Vec::with_capacity(points * 2),
        z: Vec::with_capacity(if has_z { points } else { 0 }),
        object: if paths.iter().any(|p| p.object != 0) {
            paths.iter().map(|p| p.object).collect()
        } else {
            Vec::new()
        },
    };
    c.start.push(0);
    for p in paths {
        let k = slot(&mut c.kinds, &p.kind);
        c.kind.push(k);
        let st = slot(&mut c.strategies, &p.strategy);
        c.strategy.push(st);
        c.width.push(Rounded(p.width));
        c.speed.push(Rounded(p.speed));
        c.effective_speed.push(Rounded(p.effective_speed));
        c.toughness.push(Rounded(p.toughness));
        c.bead_height.push(Rounded(p.bead_height));
        for (i, pt) in p.pts.iter().enumerate() {
            c.xy.push(Rounded(pt[0]));
            c.xy.push(Rounded(pt[1]));
            if has_z {
                // NaN serializes as JSON null: this point is at the layer Z.
                c.z.push(Rounded(p.zs.get(i).copied().unwrap_or(f64::NAN)));
            }
        }
        c.start.push((c.xy.len() / 2) as u32);
    }
    c.serialize(s)
}

pub(super) fn preview_of(
    layers: &[PlateLayer],
    profile: &PrinterProfile,
    blends: &[&BlendMode],
    layer_seconds: &[f64],
    layer_slow: &[f64],
) -> Vec<PreviewLayer> {
    layers
        .iter()
        .filter(|l| !l.is_empty())
        .enumerate()
        .map(|(emitted, layer)| {
            let seconds = layer_seconds.get(emitted).copied().unwrap_or(0.0);
            let slow = layer_slow.get(emitted).copied().unwrap_or(1.0);
            preview_layer(layer, profile, blends, seconds, slow)
        })
        .collect()
}

/// One printed layer as the preview draws it: a travel before each path
/// that moves the nozzle, then the path, decimated. Each path is in its
/// object's part frame, so a travel from another object is not drawn.
pub(super) fn preview_layer(
    layer: &PlateLayer,
    profile: &PrinterProfile,
    blends: &[&BlendMode],
    seconds: f64,
    slow: f64,
) -> PreviewLayer {
    let mut paths = Vec::new();
    let mut cursor: Option<[f64; 2]> = None;
    let mut speed_walls = 0u32;
    let mut toughness_walls = 0u32;
    let mut support_paths = 0u32;
    for run in &layer.runs {
        if run.entry != Entry::AsPlanned {
            cursor = None;
        }
        let blend = blends[run.object as usize];
        for path in &run.layer.paths[run.paths.clone()] {
            if path.kind == PathKind::Support || path.kind == PathKind::SupportInterface {
                support_paths += 1;
            }
            preview_path(
                &mut paths,
                &mut cursor,
                (&mut speed_walls, &mut toughness_walls),
                layer,
                path,
                run.object,
                profile,
                blend,
            );
        }
    }
    PreviewLayer {
        index: layer.index,
        z: layer.z,
        height: layer.height,
        note: layer.note.clone(),
        speed_walls,
        toughness_walls,
        support_paths,
        seconds,
        slow,
        paths,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn preview_path(
    paths: &mut Vec<PreviewPath>,
    cursor: &mut Option<[f64; 2]>,
    (speed_walls, toughness_walls): (&mut u32, &mut u32),
    layer: &PlateLayer,
    path: &Extrusion,
    object: u16,
    profile: &PrinterProfile,
    blend: &BlendMode,
) {
    if path.kind.is_wall() {
        match path.strategy {
            StrategyId::Speed => *speed_walls += 1,
            StrategyId::Toughness => *toughness_walls += 1,
        }
    }
    if let (Some(c), Some(start)) = (*cursor, path.points.first()) {
        let mut pts = vec![c];
        pts.extend(path.lead_in.iter().copied());
        pts.push(*start);
        if pts.len() > 2 || dist2(c, *start) > 0.05 * 0.05 {
            paths.push(PreviewPath {
                kind: "travel".into(),
                strategy: path.strategy.as_str().into(),
                pts,
                width: 0.0,
                speed: path.travel_speed,
                effective_speed: path.travel_speed,
                toughness: path_weight(blend, layer.z, path.strategy),
                zs: Vec::new(),
                bead_height: 0.0,
                object,
            });
        }
    }
    let (pts, zs) = decimate_path(&path.points, &path.z_frac, layer.z, layer.height);
    let bead = if path.bead_height > 1e-6 {
        path.bead_height
    } else {
        layer.height
    };
    let mut limited = crate::gcode::limit_speed(
        path.speed,
        path.width,
        bead,
        path.flow,
        profile.max_volumetric_mm3_s,
    );
    if layer.index == 0 {
        limited = limited.min(30.0);
    }
    paths.push(PreviewPath {
        kind: path.kind.as_str().into(),
        strategy: path.strategy.as_str().into(),
        pts,
        width: path.width,
        speed: path.speed,
        effective_speed: limited,
        toughness: path_weight(blend, layer.z, path.strategy),
        zs,
        bead_height: if path.bead_height > 1e-6 {
            path.bead_height
        } else {
            0.0
        },
        object,
    });
    *cursor = path.points.last().copied();
}

pub(super) fn path_weight(blend: &BlendMode, z: f64, strategy: StrategyId) -> f64 {
    match blend {
        BlendMode::Single { strategy } => match strategy {
            StrategyId::Speed => 0.0,
            StrategyId::Toughness => 1.0,
        },
        BlendMode::Weight { toughness } => toughness.clamp(0.0, 1.0),
        BlendMode::ByLayer {
            bottom_mm,
            transition_mm,
        } => layer_weight(z, *bottom_mm, *transition_mm),
        BlendMode::ByRegion { .. } => match strategy {
            StrategyId::Speed => 0.0,
            StrategyId::Toughness => 1.0,
        },
    }
}

pub(super) fn decimate_path(
    pts: &[[f64; 2]],
    z_frac: &[f64],
    layer_z: f64,
    layer_h: f64,
) -> (Vec<[f64; 2]>, Vec<f64>) {
    let z_at = |i: usize| {
        z_frac
            .get(i)
            .map(|f| layer_z - layer_h * (1.0 - f.clamp(0.0, 1.0)))
    };
    if pts.len() <= 2 {
        let zs = (0..pts.len()).filter_map(z_at).collect::<Vec<_>>();
        let zs = if zs.len() == pts.len() {
            zs
        } else {
            Vec::new()
        };
        return (pts.to_vec(), zs);
    }
    let mut keep = vec![0usize];
    for i in 1..pts.len() {
        let last = pts[*keep.last().unwrap()];
        if dist2(last, pts[i]) >= 0.04 * 0.04 {
            keep.push(i);
        }
    }
    if *keep.last().unwrap() != pts.len() - 1 {
        keep.push(pts.len() - 1);
    }
    let out: Vec<[f64; 2]> = keep.iter().map(|i| pts[*i]).collect();
    let zs: Vec<f64> = keep.iter().filter_map(|i| z_at(*i)).collect();
    let zs = if zs.len() == out.len() {
        zs
    } else {
        Vec::new()
    };
    (out, zs)
}

pub(super) fn seam_metrics(layers: &[PlateLayer]) -> (usize, f64, f64) {
    let mut n = 0usize;
    let mut sum = 0.0;
    let mut max_step = 0.0f64;
    for layer in layers {
        for (_, path) in layer.paths() {
            if path.scarf_mm <= 0.0 {
                continue;
            }
            n += 1;
            sum += path.scarf_mm;
            for w in path.z_frac.windows(2) {
                max_step = max_step.max((w[1] - w[0]).abs() * layer.height);
            }
        }
    }
    let mean = if n == 0 { 0.0 } else { sum / n as f64 };
    (n, mean, max_step)
}

pub(super) fn scarf_scales(path: &Extrusion) -> (f64, f64) {
    if path.z_frac.len() != path.points.len() || path.points.len() < 2 {
        return (1.0, 1.0);
    }
    let mut len = 0.0;
    let mut z_acc = 0.0;
    let mut f_acc = 0.0;
    for i in 0..path.points.len() - 1 {
        let dx = path.points[i + 1][0] - path.points[i][0];
        let dy = path.points[i + 1][1] - path.points[i][1];
        let seg = dx.hypot(dy);
        let z = 0.5 * (path.z_frac[i] + path.z_frac[i + 1]).clamp(0.0, 1.0);
        let f = if path.flow_frac.len() == path.points.len() {
            0.5 * (path.flow_frac[i] + path.flow_frac[i + 1]).clamp(0.0, 2.0)
        } else {
            1.0
        };
        len += seg;
        z_acc += seg * z;
        f_acc += seg * f;
    }
    if len < 1e-6 {
        return (1.0, 1.0);
    }
    (z_acc / len, f_acc / len)
}

pub(super) fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}
