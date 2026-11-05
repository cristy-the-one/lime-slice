use super::*;

/// The mesh cut into layers, with what is read off the cut alone. Every
/// blend of the same mesh and layer settings shares it.
pub(crate) struct Contours {
    pub bands: Vec<LayerBand>,
    pub contours: Vec<Vec<Loop>>,
    pub(super) bounds: ([f64; 3], [f64; 3]),
    /// Each layer's distance below the nearest roof, from `roof_distances`.
    pub(super) roofs: Vec<f64>,
    /// Each layer's skin, from `skin_regions`: `[0]` at speed's shell
    /// depths, `[1]` at toughness's. `skin_of` picks one for a strategy.
    pub(super) skins: [Vec<Arc<Skin>>; 2],
    /// What prints over air with supports off, for the first overhang angle
    /// asked, keyed by its bits.
    pub(super) in_air: std::sync::OnceLock<(u64, InAir)>,
    /// Each layer's XY box, `None` on an empty layer, found when first asked.
    pub(super) boxes: std::sync::OnceLock<Vec<Option<XyRect>>>,
    pub(super) clocks: CutClocks,
    /// Layers that closed a mesh gap, the length of those links, and chains that stayed open.
    pub(super) repaired_layers: usize,
    pub(super) bridged_mm: f64,
    pub(super) dropped_chains: usize,
}

/// Wall-clock and CPU time the cut took.
#[derive(Clone, Copy, Default)]
pub(super) struct CutClocks {
    pub(super) contour_ms: f64,
    pub(super) index_ms: f64,
    pub(super) cut_cpu_ms: f64,
    pub(super) simplify_cpu_ms: f64,
    pub(super) roof_ms: f64,
}

impl Contours {
    pub(super) fn new(
        bands: Vec<LayerBand>,
        contours: Vec<Vec<Loop>>,
        bounds: ([f64; 3], [f64; 3]),
        settings: &SliceSettings,
    ) -> Self {
        let fewest_walls = pure(StrategyId::Speed)
            .walls
            .min(pure(StrategyId::Toughness).walls)
            .max(1);
        let roof_started = Instant::now();
        let wall_stack = settings.line_width * fewest_walls as f64;
        let roofs = roof_distances(&bands, &contours, wall_stack);
        let skins = skin_regions(
            &bands,
            &contours,
            wall_stack,
            settings.shallow_skins,
            settings.solid_under_walls,
        );
        Self {
            bands,
            contours,
            bounds,
            roofs,
            skins,
            in_air: std::sync::OnceLock::new(),
            boxes: std::sync::OnceLock::new(),
            repaired_layers: 0,
            bridged_mm: 0.0,
            dropped_chains: 0,
            clocks: CutClocks {
                roof_ms: elapsed_ms(roof_started),
                ..CutClocks::default()
            },
        }
    }

    /// What prints over air at overhang angle `angle_deg`. It reads only
    /// the cut and the angle, so every blend of the cut shares it.
    pub(super) fn boxes(&self) -> &[Option<XyRect>] {
        self.boxes
            .get_or_init(|| self.contours.par_iter().map(|c| loop_bounds(c)).collect())
    }

    /// The band of this cut that prints at the Z where `band` is cut, if any.
    pub(super) fn band_at(&self, band: &LayerBand) -> Option<usize> {
        let z = band.cut_z();
        let i = self.bands.partition_point(|b| b.z < z);
        self.bands.get(i).filter(|b| b.z - b.height <= z).map(|_| i)
    }

    /// What prints over air without supports, less what `paint` holds up.
    pub(super) fn in_air(&self, angle_deg: f64, paint: &[PaintDisk], join: f64) -> InAir {
        if !paint.is_empty() {
            return crate::support::in_air(&self.bands, &self.contours, angle_deg, paint, join);
        }
        let bits = angle_deg.to_bits();
        if let Some(&(_, found)) = self.in_air.get().filter(|(at, _)| *at == bits) {
            return found;
        }
        let found = crate::support::in_air(&self.bands, &self.contours, angle_deg, &[], 0.0);
        let _ = self.in_air.set((bits, found));
        found
    }
}

/// One layer of the part on its own. `note` names the strategy it used.
#[derive(Clone)]
pub(super) struct ObjectLayer {
    pub(super) paths: Vec<Extrusion>,
    pub(super) note: String,
    /// The print speed `note` names, when the object's speed cap lowers it.
    pub(super) shown_speed: Option<f64>,
    pub(super) wall_ms: f64,
    pub(super) infill_ms: f64,
}

impl ObjectLayer {
    /// `note` under the object's speed cap `cap`.
    pub(super) fn note_under(&self, cap: f64) -> String {
        match self.shown_speed {
            Some(speed) if cap < speed => {
                self.note
                    .replacen(&speed_label(speed), &speed_label(cap), 1)
            }
            _ => self.note.clone(),
        }
    }
}

/// The part's own toolpaths: every layer's walls, infill, and skin with
/// overhangs split, in the order they were planned. Supports never read it.
pub(crate) struct PartPaths {
    pub(super) layers: Vec<Arc<ObjectLayer>>,
    /// Each layer's own inputs, from `layer_inputs`.
    pub(super) inputs: Vec<[u8; 32]>,
    /// The kept layer key the layers were planned under.
    pub(super) base: [u8; 32],
    /// Layers taken from a kept plan instead of planned.
    pub(super) reused: u32,
    pub(super) toolpath_ms: f64,
    /// The serial pass before the parallel layers.
    pub(super) prep_ms: f64,
    pub(super) wall_cpu_ms: f64,
    pub(super) infill_cpu_ms: f64,
}

/// The part's layers in print order, each one tour scarfed as it went,
/// before any travel is combed or hopped.
pub(crate) struct PartTour {
    pub(super) layers: Vec<Arc<TourLayer>>,
    pub(super) base: [u8; 32],
    pub(super) reused: u32,
    pub(super) order_ms: f64,
}

/// One layer of the part's tour and what it was toured from.
pub(crate) struct TourLayer {
    pub(super) source: Arc<ObjectLayer>,
    /// Where the tour started: where the tour below ended.
    pub(super) from: Option<[f64; 2]>,
    pub(super) paths: Vec<Extrusion>,
    /// Where the tour ends, carried up through layers with no part.
    pub(super) end: Option<[f64; 2]>,
}

/// How the nozzle travels into each path of the part's tour, combed and
/// hopped.
pub(crate) struct PartTravels {
    pub(super) layers: Vec<Arc<CombLayer>>,
    pub(super) base: [u8; 32],
    pub(super) reused: u32,
    pub(super) comb_ms: f64,
}

/// One travel per path of `tour`.
pub(crate) struct CombLayer {
    pub(super) tour: Arc<TourLayer>,
    /// The layer below has top skin, which z-hop reads.
    pub(super) after_top: bool,
    pub(super) travels: Vec<Travel>,
}

/// What combing and z-hop decide about the travel into one path.
#[derive(Clone)]
pub(super) struct Travel {
    pub(super) lead_in: Vec<[f64; 2]>,
    pub(super) travel_in: TravelIn,
    pub(super) z_hop: f64,
}

impl Travel {
    pub(super) fn of(path: Extrusion) -> Self {
        Self {
            lead_in: path.lead_in,
            travel_in: path.travel_in,
            z_hop: path.z_hop,
        }
    }

    pub(super) fn onto(&self, path: &Extrusion) -> Extrusion {
        Extrusion {
            lead_in: self.lead_in.clone(),
            travel_in: self.travel_in,
            z_hop: self.z_hop,
            ..path.clone()
        }
    }
}

/// The part as `assemble` joins it: its tour with its travels.
#[derive(Clone, Copy)]
pub(super) struct Part<'a> {
    pub(super) paths: &'a PartPaths,
    pub(super) tour: &'a PartTour,
    pub(super) travels: &'a PartTravels,
}

impl Part<'_> {
    /// The nozzle moves on layer `i`'s part, so the layer ends where the
    /// part's tour does.
    pub(super) fn prints(&self, i: usize) -> bool {
        self.tour.layers[i]
            .paths
            .iter()
            .any(|p| !p.points.is_empty())
    }

    /// Layer `i` of the part in print order, combed and hopped.
    pub(super) fn combed(&self, i: usize) -> impl Iterator<Item = Extrusion> + '_ {
        let layer = &self.travels.layers[i];
        layer
            .tour
            .paths
            .iter()
            .zip(&layer.travels)
            .map(|(path, travel)| travel.onto(path))
    }
}

/// Supports planned on the cut: the forest, the regions and branches of
/// every layer, and the paths printed from them. The forest is shared
/// with the plan built from it; editing it copies it first.
#[derive(Clone)]
pub(crate) struct SupportPlan {
    pub(super) supports: Arc<Supports>,
    pub(super) coverage: Vec<CoverageGap>,
    /// With supports off, what prints over air. `None` with supports on.
    pub(super) in_air: Option<InAir>,
    /// Layers each layer's support stands for, from `shaft_scales`.
    pub(super) shaft: Vec<f64>,
    /// Each layer's support paths. An edit repaints some layers and shares
    /// the rest with the plan it started from.
    pub(super) paths: Vec<Arc<Vec<Extrusion>>>,
    /// What the trees grew among when other objects stand near: the part
    /// and those objects, per layer, in the part frame. `None` is the part
    /// alone.
    pub(super) solid: Option<Arc<Vec<Vec<Loop>>>>,
    pub(super) support_ms: f64,
    pub(super) toolpath_ms: f64,
}

impl SupportPlan {
    /// What the trees avoid and stand on.
    pub(super) fn solid<'a>(&'a self, cut: &'a Contours) -> &'a [Vec<Loop>] {
        self.solid.as_deref().map_or(&cut.contours, Vec::as_slice)
    }

    /// Bring paths, shaft scales, and coverage up to date after edits
    /// changed the support on `changed` layers. A changed layer can move the
    /// shaft scale of its run beyond itself, so layers whose scale moved are
    /// repainted too. Returns the layers repainted, ascending.
    pub(super) fn refresh(
        &mut self,
        cut: &Contours,
        changed: &[usize],
        blend: &BlendMode,
        settings: &SliceSettings,
    ) -> Vec<usize> {
        if changed.is_empty() {
            return Vec::new();
        }
        let layers = &self.supports.layers;
        let shaft = shaft_scales(layers, settings.support_height_mult);
        // A belt brim and the belt anchors reach across layers, so an edit can
        // move the brim or an anchor of layers it did not touch.
        let across = self.supports.floor().is_some()
            && (settings.support_tree_brim_mm.is_some() || settings.support_anchor_mm.is_some());
        let mut repaint: Vec<usize> = (0..shaft.len())
            .filter(|&i| across || shaft[i] != self.shaft[i])
            .chain(changed.iter().copied())
            .collect();
        repaint.sort_unstable();
        repaint.dedup();
        let painted = paint(
            cut,
            &self.supports,
            &shaft,
            &repaint,
            blend,
            settings,
            &Watch::idle(),
            false,
            self.supports.floor(),
        );
        for (&i, paths) in repaint.iter().zip(painted) {
            self.paths[i] = Arc::new(paths);
        }
        self.shaft = shaft;
        self.coverage = self.supports.coverage(&cut.bands, self.solid(cut));
        repaint
    }

    /// The same supports painted again under `settings`, for a plan whose
    /// supports grew alike but whose toolpath settings differ. Each layer's
    /// paint reads only its own support and shaft scale, so this is the
    /// plan the supports would have had painted under `settings` all along.
    pub(super) fn repaint(
        &self,
        cut: &Contours,
        blend: &BlendMode,
        settings: &SliceSettings,
        watch: &Watch,
    ) -> SupportPlan {
        let started = Instant::now();
        let shaft = shaft_scales(&self.supports.layers, settings.support_height_mult);
        let all: Vec<usize> = (0..cut.bands.len()).collect();
        let paths = paint(
            cut,
            &self.supports,
            &shaft,
            &all,
            blend,
            settings,
            watch,
            true,
            self.supports.floor(),
        )
        .into_iter()
        .map(Arc::new)
        .collect();
        SupportPlan {
            supports: Arc::clone(&self.supports),
            coverage: self.coverage.clone(),
            in_air: self.in_air,
            shaft,
            paths,
            solid: self.solid.clone(),
            support_ms: 0.0,
            toolpath_ms: elapsed_ms(started),
        }
    }
}

/// What applying edits to a support plan did, and what it cost.
#[derive(Default)]
pub(super) struct Edits {
    pub(super) outcomes: Vec<EditOutcome>,
    pub(super) apply_ms: f64,
    pub(super) refresh_ms: f64,
}

/// Apply `edits` in order onto `plan`, then repaint the layers they changed.
pub(super) fn edit(
    plan: &mut SupportPlan,
    cut: &Contours,
    edits: &[SupportEdit],
    blend: &BlendMode,
    settings: &SliceSettings,
) -> Edits {
    if edits.is_empty() {
        return Edits::default();
    }
    let started = Instant::now();
    let solid = plan.solid.clone();
    let solid = solid.as_deref().map_or(&cut.contours, |s| s);
    let outcomes = Arc::make_mut(&mut plan.supports).apply(edits, &cut.bands, solid);
    let apply_ms = elapsed_ms(started);
    let started = Instant::now();
    let mut changed: Vec<usize> = outcomes
        .iter()
        .flat_map(|o| o.changed.iter().copied())
        .collect();
    changed.sort_unstable();
    changed.dedup();
    plan.refresh(cut, &changed, blend, settings);
    Edits {
        outcomes,
        apply_ms,
        refresh_ms: elapsed_ms(started),
    }
}
