use super::*;

/// One object of a plate in its part frame, ready to plan.
pub(super) struct PlateObject<'a> {
    pub(super) id: Option<&'a str>,
    pub(super) mesh: Cow<'a, Mesh>,
    /// Where the part frame sits on the bed. `None` when it has no pose.
    pub(super) offset: Option<[f64; 2]>,
    /// Its blend, moved into its part frame.
    pub(super) blend: BlendMode,
    /// Its settings, with no pose left.
    pub(super) settings: SliceSettings,
}

impl PlateObject<'_> {
    pub(super) fn to_bed(&self) -> [f64; 2] {
        self.offset.unwrap_or([0.0, 0.0])
    }
}

impl BeltJob {
    /// What takes the laid frame's lab points back to each part frame.
    pub(super) fn tilt_offsets(&self) -> Vec<Option<[f64; 2]>> {
        self.baked.iter().map(|&b| Some(b)).collect()
    }
}

/// A belt slice: the rotation that laid the plate flat, and the placement
/// the reply still reports. The planner sees the settled meshes, with no offset.
pub(super) struct BeltJob {
    /// Its `frame` is the rotation that laid this plate flat.
    pub(super) belt: crate::belt::Belt,
    /// Belt length of one copy, from the settled slice height.
    pub(super) extent: f64,
    /// Each object's part-frame offset before that shift was baked into the mesh.
    pub(super) offsets: Vec<Option<[f64; 2]>>,
    /// The part of each offset baked into the laid mesh. A plate of one object
    /// keeps its place out of the mesh: emit adds it across the belt, and
    /// along the belt laying flat would settle it away. So a move of a lone
    /// part plans nothing again. A plate of several bakes it, since the
    /// objects' places relative to each other set where they meet a plane.
    pub(super) baked: Vec<[f64; 2]>,
    /// Part-frame bounds in the lab, with the later copies included along Y.
    pub(super) lab_bounds: Vec<([f64; 3], [f64; 3])>,
    /// A pad on the belt, in the slice frame, when the request asked for one.
    pub(super) raft: Option<crate::belt::Raft>,
    /// Set when supports grow to the tilted belt. `None` forces supports off.
    pub(super) floor: Option<FloorPlane>,
}

/// How far the belt raft reaches past the plate's footprint on every side.
pub(super) const BELT_RAFT_MARGIN_MM: f64 = 1.0;

/// Lay the plate on the belt, and turn off the features that assume a flat bed.
pub(super) fn prepare_belt(
    objects: &mut [PlateObject<'_>],
    settings: &mut SliceSettings,
    spec: &crate::belt::BeltSpec,
) -> Result<BeltJob, String> {
    let mut belt = crate::belt::Belt::resolve(spec)?;
    if settings.compare {
        return Err("belt: compare is not supported yet".into());
    }
    if belt.floor_supports && belt.raft_layers > 0 {
        return Err("belt.floorSupports is not available with a raft yet".into());
    }
    let offsets: Vec<Option<[f64; 2]>> = objects.iter().map(|o| o.offset).collect();
    let across = objects.len() == 1;
    let baked: Vec<[f64; 2]> = objects
        .iter()
        .map(|o| if across { [0.0, 0.0] } else { o.to_bed() })
        .collect();
    let mut lab_bounds = Vec::with_capacity(objects.len());
    let mut placed = Vec::with_capacity(objects.len());
    for (object, &shift) in objects.iter().zip(&baked) {
        let (min, max) = object.mesh.bounds().ok_or("empty mesh")?;
        lab_bounds.push((min, max));
        placed.push(crate::belt::translate_xy(object.mesh.as_ref(), shift));
    }
    if belt.raft_layers > 0 && settings.adaptive {
        return Err("belt.raftLayers needs a fixed layer height; turn adaptive layers off".into());
    }
    // The pad lies on the belt under the footprint, and the parts stand on it.
    let raft = if belt.raft_layers > 0 {
        let (min, max) = xy_bounds(&placed)?;
        let top = f64::from(belt.raft_layers) * settings.layer_height.clamp(0.05, 0.6);
        for mesh in &mut placed {
            *mesh = crate::belt::shift_z(mesh, top);
        }
        Some(crate::belt::Raft {
            min: [min[0] - BELT_RAFT_MARGIN_MM, min[1] - BELT_RAFT_MARGIN_MM],
            max: [max[0] + BELT_RAFT_MARGIN_MM, max[1] + BELT_RAFT_MARGIN_MM],
            top,
            line_width: settings.line_width,
        })
    } else {
        None
    };
    let (laid, frame) = crate::belt::lay_flat(
        &placed,
        &belt,
        raft.as_ref(),
        settings.layer_height.clamp(0.05, 0.6),
    )?;
    belt.frame = frame;
    let (span_x, max_z) = crate::belt::plate_span(&laid)?;
    let extent = max_z / belt.sin_a;
    crate::belt::check_fit(&belt, span_x, extent)?;
    let lift = raft.map_or(0.0, |r| r.top);
    for ((object, mesh), &shift) in objects.iter_mut().zip(laid).zip(&baked) {
        // Paint is in the part frame, as the mesh was, so it takes the
        // mesh's move onto the bed, the pad and the belt.
        let (rotation, pivot, translation) = frame.pose(shift, lift);
        for disk in &mut object.settings.support_paint {
            *disk = disk.posed(&rotation, pivot, translation);
        }
        for disk in &mut object.settings.seam_paint {
            *disk = disk.posed(&rotation, pivot, translation);
        }
        for region in &mut object.settings.reinforcement {
            region.pose(&rotation, pivot, translation);
        }
        let across_bed = object.to_bed()[0] - shift[0];
        object.mesh = Cow::Owned(mesh);
        object.offset = (across_bed != 0.0).then_some([across_bed, 0.0]);
        // Horizontal supports would stand on a bed this printer does not have.
        // `floorSupports` grows them to the tilted belt instead.
        if !belt.floor_supports {
            object.settings.supports = false;
        }
        // A scarf ramp and a hop both move machine Z. On a belt that axis is
        // the belt, so either one would walk the part between beads.
        object.settings.z_hop = ZHopMode::Off;
        object.settings.hanging_rows = true;
        object.settings.scarf_seam = ScarfSeam::Off;
        object.settings.skirt = false;
        // Blend would hide the seam wherever the strategy likes. The belt edge
        // is the back of the nozzle plane, which is Rear after the rotation.
        // An explicit seam stays unless the printer asks for the belt edge.
        // An explicit rear stays stacked on +X; the edge takes whichever foot
        // of a layer's U is nearer the nozzle.
        let seam = object.settings.seam;
        if seam != SeamPlacement::Rear && (belt.seam_on_edge || seam == SeamPlacement::Blend) {
            object.settings.seam = SeamPlacement::Edge;
        }
    }
    if !belt.floor_supports {
        settings.supports = false;
    }
    settings.z_hop = ZHopMode::Off;
    settings.hanging_rows = true;
    settings.scarf_seam = ScarfSeam::Off;
    settings.skirt = false;
    let extra = f64::from(belt.copies - 1) * belt.stride(extent);
    if extra > 0.0 {
        // Later copies print later, so they stand upstream of the first: toward -Y.
        for (min, max) in &mut lab_bounds {
            if belt.direction >= 0.0 {
                min[1] -= extra;
            } else {
                max[1] += extra;
            }
        }
    }
    let floor = belt
        .floor_supports
        .then(|| FloorPlane::new(belt.sin_a / belt.cos_a, frame.y_shift, frame.z_drop));
    Ok(BeltJob {
        belt,
        extent,
        offsets,
        baked,
        lab_bounds,
        raft,
        floor,
    })
}

pub(super) fn xy_bounds(meshes: &[Mesh]) -> Result<([f64; 2], [f64; 2]), String> {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for mesh in meshes {
        let (lo, hi) = mesh.bounds().ok_or("empty mesh")?;
        min[0] = min[0].min(lo[0]);
        min[1] = min[1].min(lo[1]);
        max[0] = max[0].max(hi[0]);
        max[1] = max[1].max(hi[1]);
    }
    if !max[0].is_finite() {
        return Err("empty mesh".into());
    }
    Ok((min, max))
}

/// How many leading layers of the planned plate print nothing under the belt's start.
/// A belt reply numbers its layers from the first one after them.
pub(super) fn belt_opened(layers: &[PlateLayer], belt: &crate::belt::Belt) -> usize {
    layers
        .iter()
        .take_while(|layer| layer.z <= belt.start + 1e-9)
        .count()
}

/// One planned plate, emitted once per copy. The first copy keeps the writer's
/// layer-0 treatment. Later copies' first layer is slowed here, because the
/// writer only does that for index 0. Layers below the belt's start print
/// nothing and are left out, so the lowest foot is layer 0.
pub(super) fn belt_output(mut layers: Vec<PlateLayer>, job: &BeltJob) -> Vec<PlateLayer> {
    let opened = belt_opened(&layers, &job.belt);
    layers.drain(..opened);
    for layer in &mut layers {
        layer.index -= opened;
        layer.own -= opened;
    }
    if let Some(raft) = &job.raft {
        let across = [raft.min[0], raft.max[0]];
        for layer in &mut layers {
            let ys = raft.lines(&job.belt.frame, layer.z);
            if ys.is_empty() {
                continue;
            }
            let paths = belt_raft_paths(across, &ys, raft.line_width, layer.index % 2 == 1);
            let n = paths.len();
            // The part's plan does not know the nozzle ends on the pad.
            if let Some(first) = layer.runs.first_mut() {
                first.entry = Entry::Cross { z_hop: 0.0 };
            }
            let pad = Run {
                object: 0,
                layer: PrintLayer::new(LayerPaths {
                    index: layer.index,
                    z: layer.z,
                    height: layer.height,
                    paths,
                    note: layer.note.clone(),
                }),
                paths: 0..n,
                entry: Entry::AsPlanned,
                label: None,
            };
            layer.runs.insert(0, pad);
        }
    }
    for layer in &mut layers {
        if layer.index != 0 {
            retouch_layer(layer, &job.belt.frame, false);
        }
    }
    let stride = job.belt.stride(job.extent);
    let mut out = Vec::with_capacity(layers.len() * job.belt.copies as usize);
    for copy in 0..job.belt.copies {
        for layer in &layers {
            let mut layer = layer.clone();
            if copy > 0 && layer.index == 0 {
                retouch_layer(&mut layer, &job.belt.frame, true);
            }
            layer.belt_shift = f64::from(copy) * stride;
            layer.index = out.len();
            out.push(layer);
        }
    }
    out
}

/// Slow the belt-contact edge. Runs that share one path list are rebuilt
/// together, so a split wall does not leave the head and the body on different lists.
pub(super) fn retouch_layer(layer: &mut PlateLayer, frame: &crate::belt::Frame, slow_all: bool) {
    let mut seen = vec![false; layer.runs.len()];
    for i in 0..layer.runs.len() {
        if seen[i] {
            continue;
        }
        let mut group = vec![i];
        seen[i] = true;
        for (j, run) in layer.runs.iter().enumerate().skip(i + 1) {
            if run.layer.shares_paths(&layer.runs[i].layer) {
                group.push(j);
                seen[j] = true;
            }
        }
        let paths = layer.runs[i].layer.paths.clone();
        let mut touched = vec![false; paths.len()];
        for &run in &group {
            for k in layer.runs[run].paths.clone() {
                if let Some(flag) = touched.get_mut(k) {
                    *flag = true;
                }
            }
        }
        let mut next = Vec::with_capacity(paths.len());
        let mut placed: Vec<std::ops::Range<usize>> = Vec::with_capacity(paths.len());
        let mut changed = false;
        for (k, path) in paths.iter().enumerate() {
            let start = next.len();
            if touched[k] {
                let pieces = crate::belt::retouch(path, layer.z, layer.height, frame, slow_all);
                if pieces.len() != 1
                    || pieces[0].points.len() != path.points.len()
                    || pieces[0].speed != path.speed
                    || pieces[0].flow != path.flow
                    || pieces[0].fan != path.fan
                    || pieces[0].fan_role != path.fan_role
                {
                    changed = true;
                }
                next.extend(pieces);
            } else {
                next.push(path.clone());
            }
            placed.push(start..next.len());
        }
        if !changed {
            continue;
        }
        let mut printed = layer.runs[i].layer.clone();
        printed.set_paths(next);
        for &run in &group {
            let range = layer.runs[run].paths.clone();
            let rebuilt = if range.is_empty() {
                let at = if range.start >= placed.len() {
                    printed.paths.len()
                } else {
                    placed[range.start].start
                };
                at..at
            } else {
                placed[range.start].start..placed[range.end - 1].end
            };
            layer.runs[run].layer = printed.clone();
            layer.runs[run].paths = rebuilt;
        }
    }
}

/// Preview points go back to the lab, in the part frame, so a layer draws tilted.
/// `z` on the layer is the belt position the scrubber already prints.
pub(super) fn tilt_preview(
    preview: &mut [PreviewLayer],
    planned: &[PlateLayer],
    tilt: &patch::BeltTilt,
) {
    let printed: Vec<&PlateLayer> = planned.iter().filter(|layer| !layer.is_empty()).collect();
    for (view, layer) in preview.iter_mut().zip(printed) {
        tilt_layer(view, layer, tilt);
    }
}

/// The same tilt, for a stored patch whose plate is the expanded belt plate.
pub(super) fn tilt_held(
    preview: &mut [PreviewLayer],
    planned: &[PlateLayer],
    tilt: &patch::BeltTilt,
) {
    tilt_preview(preview, planned, tilt);
}

pub(super) fn tilt_layer(view: &mut PreviewLayer, layer: &PlateLayer, tilt: &patch::BeltTilt) {
    for path in &mut view.paths {
        let [dx, dy] = tilt
            .offsets
            .get(path.object as usize)
            .copied()
            .flatten()
            .unwrap_or([0.0, 0.0]);
        let shift = -tilt.belt.direction * layer.belt_shift;
        let mut pts = Vec::with_capacity(path.pts.len());
        let mut zs = Vec::with_capacity(path.pts.len());
        for (i, pt) in path.pts.iter().enumerate() {
            let slice_z = path
                .zs
                .get(i)
                .copied()
                .filter(|z| z.is_finite())
                .unwrap_or(layer.z);
            let lab = tilt.belt.frame.lab(pt[0], pt[1], slice_z);
            pts.push([lab[0] - dx, lab[1] - dy + shift]);
            zs.push(lab[2]);
        }
        path.pts = pts;
        path.zs = zs;
    }
    view.z = tilt.belt.position(layer.z, layer.belt_shift);
}
