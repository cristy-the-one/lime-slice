//! The stages of the last interactive slices, kept in memory. Each stage is
//! keyed on exactly what it and the stages before it read, so a request
//! takes every stage whose inputs did not change and computes only from the
//! first one whose inputs did.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use super::patch::Shown;
use super::{Contours, JoinedLayer, PartPaths, PartTour, PartTravels, SliceSettings, SupportPlan};
use crate::mesh::Mesh;
use crate::strategy::BlendMode;
use crate::support::edit::{EditOutcome, SupportEdit};

/// Supports with edits applied on a kept base.
pub(super) struct Edited {
    pub edits: Vec<SupportEdit>,
    pub plan: SupportPlan,
    pub outcomes: Vec<EditOutcome>,
}

/// One kept support plan: the supports grown and painted with no edits, and
/// the last edited state on them. A request whose edits extend that state's
/// edits applies only the new ones.
struct SupportEntry {
    grow: [u8; 32],
    paint: [u8; 32],
    base: Arc<SupportPlan>,
    edited: Option<Arc<Edited>>,
}

/// The supports a lookup found. `painted` is false when only the grown
/// trees match and every layer still needs painting under the request's
/// settings.
pub(super) struct FoundSupports {
    pub base: Arc<SupportPlan>,
    pub edited: Option<Arc<Edited>>,
    pub painted: bool,
}

/// The newest plan's layers as joined, so the next plan of the same part
/// joins again only the layers whose supports or way in changed, and the
/// preview the last reply drew from them.
struct Last {
    comb: [u8; 32],
    contours: [u8; 32],
    joined: Arc<Vec<JoinedLayer>>,
    shown: Option<Arc<Shown>>,
}

/// The newest plan's joined layers, and the preview drawn from them once
/// its reply was built.
pub(super) struct Prior {
    pub joined: Arc<Vec<JoinedLayer>>,
    pub shown: Option<Arc<Shown>>,
    /// The part, its order, and its travels are this request's, so a layer
    /// with the same supports and way in joins to the same paths.
    pub same_part: bool,
}

/// Most recent first, at most `cap` values.
pub(super) struct Shelf<T> {
    cap: usize,
    items: Vec<([u8; 32], Arc<T>)>,
}

impl<T> Shelf<T> {
    const fn new(cap: usize) -> Self {
        Self {
            cap,
            items: Vec::new(),
        }
    }

    fn get(&mut self, key: &[u8; 32]) -> Option<Arc<T>> {
        let at = self.items.iter().position(|(k, _)| k == key)?;
        let item = self.items.remove(at);
        let value = Arc::clone(&item.1);
        self.items.insert(0, item);
        Some(value)
    }

    fn put(&mut self, key: [u8; 32], value: Arc<T>) {
        self.items.retain(|(k, _)| *k != key);
        self.items.insert(0, (key, value));
        self.items.truncate(self.cap);
    }
}

pub(super) struct Kept {
    contours: Shelf<Contours>,
    toolpaths: Shelf<PartPaths>,
    tours: Shelf<PartTour>,
    travels: Shelf<PartTravels>,
    supports: Vec<SupportEntry>,
    last: Option<Last>,
}

const SUPPORT_CAPACITY: usize = 3;

static KEEP: AtomicBool = AtomicBool::new(false);
static KEPT: Mutex<Kept> = Mutex::new(Kept {
    contours: Shelf::new(2),
    toolpaths: Shelf::new(2),
    tours: Shelf::new(2),
    travels: Shelf::new(2),
    supports: Vec::new(),
    last: None,
});

/// A stage the kept slices hold, one shelf each.
pub(super) trait Stage: Sized {
    fn shelf(kept: &mut Kept) -> &mut Shelf<Self>;
}

impl Stage for Contours {
    fn shelf(kept: &mut Kept) -> &mut Shelf<Self> {
        &mut kept.contours
    }
}

impl Stage for PartPaths {
    fn shelf(kept: &mut Kept) -> &mut Shelf<Self> {
        &mut kept.toolpaths
    }
}

impl Stage for PartTour {
    fn shelf(kept: &mut Kept) -> &mut Shelf<Self> {
        &mut kept.tours
    }
}

impl Stage for PartTravels {
    fn shelf(kept: &mut Kept) -> &mut Shelf<Self> {
        &mut kept.travels
    }
}

/// Keep the stages of the last interactive slices in memory, so a support
/// edit or a settings change recomputes only what it changed. For
/// long-running shells; off by default, and turning it off forgets them.
pub fn keep_support_bases(on: bool) {
    KEEP.store(on, Ordering::Relaxed);
    if !on {
        let mut kept = kept();
        kept.contours.items.clear();
        kept.toolpaths.items.clear();
        kept.tours.items.clear();
        kept.travels.items.clear();
        kept.supports.clear();
        kept.last = None;
    }
}

pub(super) fn on() -> bool {
    KEEP.load(Ordering::Relaxed)
}

fn kept() -> std::sync::MutexGuard<'static, Kept> {
    KEPT.lock().unwrap_or_else(|e| e.into_inner())
}

/// The kept `T` under `key`, else what `make` returns, kept under `key`.
/// `reused` says which. Nothing is held locked while `make` runs.
pub(super) fn stage<T: Stage>(
    key: &[u8; 32],
    reused: &mut bool,
    make: impl FnOnce() -> Result<T, String>,
) -> Result<Arc<T>, String> {
    if let Some(found) = T::shelf(&mut kept()).get(key) {
        *reused = true;
        return Ok(found);
    }
    let made = Arc::new(make()?);
    T::shelf(&mut kept()).put(*key, Arc::clone(&made));
    Ok(made)
}

/// The supports kept for `keys`: painted under the same settings, else
/// only grown under the same support settings.
pub(super) fn supports(keys: &Keys) -> Option<FoundSupports> {
    let kept = kept();
    let found = |e: &SupportEntry, painted| FoundSupports {
        base: Arc::clone(&e.base),
        edited: e.edited.clone(),
        painted,
    };
    if let Some(e) = kept.supports.iter().find(|e| e.paint == keys.paint) {
        return Some(found(e, true));
    }
    kept.supports
        .iter()
        .find(|e| e.grow == keys.grow)
        .map(|e| found(e, false))
}

/// Make these supports the most recent, replacing the entry painted the
/// same way, and drop the oldest past the capacity.
pub(super) fn keep_supports(keys: &Keys, base: Arc<SupportPlan>, edited: Option<Arc<Edited>>) {
    let mut kept = kept();
    kept.supports.retain(|e| e.paint != keys.paint);
    kept.supports.insert(
        0,
        SupportEntry {
            grow: keys.grow,
            paint: keys.paint,
            base,
            edited,
        },
    );
    kept.supports.truncate(SUPPORT_CAPACITY);
}

/// The newest plan's joined layers when they cut the mesh as `keys` does.
pub(super) fn prior(keys: &Keys) -> Option<Prior> {
    let kept = kept();
    let last = kept.last.as_ref().filter(|l| l.contours == keys.contours)?;
    Some(Prior {
        joined: Arc::clone(&last.joined),
        shown: last.shown.clone(),
        same_part: last.comb == keys.comb,
    })
}

/// Make `joined` the newest plan's layers. Its preview is not drawn yet.
pub(super) fn keep_joined(keys: &Keys, joined: Arc<Vec<JoinedLayer>>) {
    kept().last = Some(Last {
        comb: keys.comb,
        contours: keys.contours,
        joined,
        shown: None,
    });
}

/// Record that a reply drew `shown` from `joined`. A newer plan that
/// replaced them since wins.
pub(super) fn show(joined: &Arc<Vec<JoinedLayer>>, shown: Shown) {
    if let Some(last) = kept()
        .last
        .as_mut()
        .filter(|l| Arc::ptr_eq(&l.joined, joined))
    {
        last.shown = Some(Arc::new(shown));
    }
}

/// One key per stage. Each hashes the settings whole, less the fields only
/// later stages read, so a setting added later misses the cache instead of
/// reusing a stale stage.
pub(super) struct Keys {
    /// The cut: mesh, nozzle, and layer settings. No blend.
    pub contours: [u8; 32],
    /// The part's own toolpaths.
    pub toolpaths: [u8; 32],
    /// The part's tour, before combing.
    pub order: [u8; 32],
    /// The part's combing and z-hop. Two plans with this key join the same
    /// part.
    pub comb: [u8; 32],
    /// The supports as grown, before painting.
    pub grow: [u8; 32],
    /// The supports painted.
    pub paint: [u8; 32],
    /// Everything but the edits, the preview base, and the job.
    pub whole: [u8; 32],
}

pub(super) fn keys(
    mesh: &Mesh,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
) -> Keys {
    let mut mesh_hash = Sha256::new();
    for tri in &mesh.triangles {
        for v in tri {
            for c in v {
                mesh_hash.update(c.to_bits().to_le_bytes());
            }
        }
    }
    mesh_hash.update(format!("{:x}|", nozzle_diameter.to_bits()));
    let blank = SliceSettings::default();
    let whole = SliceSettings {
        support_edits: Vec::new(),
        include_skeleton: false,
        preview_base: None,
        job: blank.job,
        baseline: blank.baseline,
        compare: blank.compare,
        include_gcode: blank.include_gcode,
        include_preview: blank.include_preview,
        ..settings.clone()
    };
    let no_emit = SliceSettings {
        arc_fit: blank.arc_fit,
        classic_estimator: blank.classic_estimator,
        junction_deviation_mm: blank.junction_deviation_mm,
        ..whole.clone()
    };
    let comb = SliceSettings {
        supports: blank.supports,
        support_angle: blank.support_angle,
        support_style: blank.support_style,
        branch_angle: blank.branch_angle,
        tip_diameter: blank.tip_diameter,
        trunk_diameter: blank.trunk_diameter,
        support_height_mult: blank.support_height_mult,
        ..no_emit.clone()
    };
    let order = SliceSettings {
        combing: blank.combing,
        z_hop: blank.z_hop,
        z_hop_height: blank.z_hop_height,
        z_hop_min_travel: blank.z_hop_min_travel,
        ..comb.clone()
    };
    let toolpaths = SliceSettings {
        travel_opt: blank.travel_opt,
        scarf_seam: blank.scarf_seam,
        scarf_length: blank.scarf_length,
        scarf_steps: blank.scarf_steps,
        scarf_start_height: blank.scarf_start_height,
        scarf_start_flow: blank.scarf_start_flow,
        ..order.clone()
    };
    let contours = SliceSettings {
        variable_width: blank.variable_width,
        overhang_control: blank.overhang_control,
        classic: blank.classic,
        feature_speeds: blank.feature_speeds,
        infill_combine: blank.infill_combine,
        gyroid_3d: blank.gyroid_3d,
        ..toolpaths.clone()
    };
    let grow = SliceSettings {
        supports: settings.supports,
        support_angle: settings.support_angle,
        support_style: settings.support_style,
        branch_angle: settings.branch_angle,
        tip_diameter: settings.tip_diameter,
        trunk_diameter: settings.trunk_diameter,
        ..contours.clone()
    };
    let paint = SliceSettings {
        supports: settings.supports,
        support_angle: settings.support_angle,
        support_style: settings.support_style,
        branch_angle: settings.branch_angle,
        tip_diameter: settings.tip_diameter,
        trunk_diameter: settings.trunk_diameter,
        support_height_mult: settings.support_height_mult,
        ..toolpaths.clone()
    };
    let key = |s: &SliceSettings, blend: Option<&BlendMode>| -> [u8; 32] {
        let mut hash = mesh_hash.clone();
        hash.update(format!("{blend:?}|{s:?}"));
        hash.finalize().into()
    };
    Keys {
        contours: key(&contours, None),
        toolpaths: key(&toolpaths, Some(blend)),
        order: key(&order, Some(blend)),
        comb: key(&comb, Some(blend)),
        grow: key(&grow, Some(blend)),
        paint: key(&paint, Some(blend)),
        whole: key(&whole, Some(blend)),
    }
}
