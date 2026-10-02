//! The last few interactive slices kept in memory, so an edit to supports
//! starts from the planned part and its unedited supports instead of
//! slicing again. One entry per mesh, blend, nozzle, and settings; entries
//! for the same part share one `ObjectSlice`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use super::{JoinedLayer, ObjectSlice, SliceSettings, SupportPlan};
use crate::mesh::Mesh;
use crate::strategy::BlendMode;
use crate::support::edit::{EditOutcome, SupportEdit};

/// One kept slice.
#[derive(Clone)]
pub(super) struct Entry {
    /// Everything but the edits, the skeleton flag, and the job.
    pub key: [u8; 32],
    /// `key` less the settings only supports read.
    pub object_key: [u8; 32],
    pub object: Arc<ObjectSlice>,
    /// Supports planned with no edits.
    pub base: Arc<SupportPlan>,
    /// The last edited state on `base`. A request whose edits extend its
    /// edits applies only the new ones.
    pub edited: Option<Arc<Edited>>,
    /// The last plan's layers as joined, so the next plan joins again only
    /// the layers whose supports or way in changed. Only the most recent
    /// entry keeps them.
    pub joined: Option<Arc<Vec<JoinedLayer>>>,
}

pub(super) struct Edited {
    pub edits: Vec<SupportEdit>,
    pub plan: SupportPlan,
    pub outcomes: Vec<EditOutcome>,
}

/// What a lookup found.
pub(super) enum Hit {
    /// The same slice: its part and its unedited supports.
    Base(Entry),
    /// The same part under other support settings.
    Object(Arc<ObjectSlice>),
}

static KEEP: AtomicBool = AtomicBool::new(false);
static KEPT: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
const CAPACITY: usize = 3;

/// Keep the last interactive slices in memory, so a support edit or a
/// support setting change reuses what it can. For long-running shells; off
/// by default, and turning it off forgets them.
pub fn keep_support_bases(on: bool) {
    KEEP.store(on, Ordering::Relaxed);
    if !on {
        entries().clear();
    }
}

pub(super) fn on() -> bool {
    KEEP.load(Ordering::Relaxed)
}

fn entries() -> std::sync::MutexGuard<'static, Vec<Entry>> {
    KEPT.lock().unwrap_or_else(|e| e.into_inner())
}

/// The entry for `key`, else the part of any entry for `object_key`.
pub(super) fn find(key: &[u8; 32], object_key: &[u8; 32]) -> Option<Hit> {
    let kept = entries();
    if let Some(entry) = kept.iter().find(|e| e.key == *key) {
        return Some(Hit::Base(entry.clone()));
    }
    kept.iter()
        .find(|e| e.object_key == *object_key)
        .map(|e| Hit::Object(Arc::clone(&e.object)))
}

/// Make `entry` the most recent, replacing any entry with its key, and drop
/// the oldest past the capacity. Older entries forget their joined layers.
pub(super) fn keep(entry: Entry) {
    let mut kept = entries();
    kept.retain(|e| e.key != entry.key);
    for e in kept.iter_mut() {
        e.joined = None;
    }
    kept.insert(0, entry);
    kept.truncate(CAPACITY);
}

/// `(key, object_key)` of a slice. Settings are hashed whole, minus the
/// fields each key ignores, so a setting added later misses the cache
/// instead of reusing a stale plan.
pub(super) fn keys(
    mesh: &Mesh,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
) -> ([u8; 32], [u8; 32]) {
    let mut hash = Sha256::new();
    for tri in &mesh.triangles {
        for v in tri {
            for c in v {
                hash.update(c.to_bits().to_le_bytes());
            }
        }
    }
    hash.update(format!("{blend:?}|{:x}|", nozzle_diameter.to_bits()));
    let blank = SliceSettings::default();
    let whole = SliceSettings {
        support_edits: Vec::new(),
        include_skeleton: false,
        job: blank.job,
        ..settings.clone()
    };
    let part = SliceSettings {
        supports: blank.supports,
        support_angle: blank.support_angle,
        support_style: blank.support_style,
        branch_angle: blank.branch_angle,
        tip_diameter: blank.tip_diameter,
        trunk_diameter: blank.trunk_diameter,
        support_height_mult: blank.support_height_mult,
        island_support: blank.island_support,
        ..whole.clone()
    };
    let mut object_hash = hash.clone();
    hash.update(format!("{whole:?}"));
    object_hash.update(format!("{part:?}"));
    (hash.finalize().into(), object_hash.finalize().into())
}
