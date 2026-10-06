//! Partial previews. A reply names the preview it leaves the client holding
//! (`previewToken`). A request that sends that name back (`previewBase`)
//! while the engine still holds the same preview gets only the layers that
//! changed, each as the paths the client already has plus the new ones.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{preview_of, PreviewLayer, PreviewPath};
use crate::gcode::PlateLayer;
use crate::strategy::{BlendMode, PrinterProfile};
use crate::support::edit::SupportEdit;

/// The preview a reply left the client holding.
pub(super) struct Shown {
    pub token: String,
    /// What the preview was drawn under besides its layers and blends, from
    /// `drawn`.
    pub drawn: [u8; 32],
    /// Each object's blend in its part frame, which weights its paths.
    pub blends: Vec<BlendMode>,
    /// Each band's layer time, `None` for a band with nothing printed.
    pub seconds: Vec<Option<f64>>,
    /// Belt copies, axis, direction, and gap. `None` on a cartesian plate.
    /// A patch is only against a preview with the same stamp: those change
    /// the tilted drawing without changing the planned paths.
    pub belt: Option<BeltStamp>,
    /// Two or more objects printing one at a time. All-at-once, and one
    /// object, leave this false so the token bytes stay what they were.
    /// A patch is only against a preview with the same order: sequential
    /// renumbers the layers without changing the planned paths.
    pub sequential: bool,
}

/// What a belt preview draws besides the planned plate. Hashed into the
/// token, and compared before a patch. A cartesian slice leaves it out, so
/// that token's bytes stay what they were.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct BeltStamp {
    copies: u32,
    axis: u8,
    direction: i8,
    gap_bits: u64,
}

impl BeltStamp {
    pub(super) fn from_belt(belt: &crate::belt::Belt) -> Self {
        Self {
            copies: belt.copies,
            axis: match belt.axis {
                crate::belt::BeltAxis::X => 0,
                crate::belt::BeltAxis::Y => 1,
                crate::belt::BeltAxis::Z => 2,
            },
            direction: if belt.direction < 0.0 { -1 } else { 1 },
            gap_bits: belt.gap_mm.to_bits(),
        }
    }

    fn mix(&self, hash: &mut Sha256) {
        hash.update(self.copies.to_le_bytes());
        hash.update([self.axis]);
        hash.update(self.direction.to_le_bytes());
        hash.update(self.gap_bits.to_le_bytes());
    }
}

/// The rotation and the belt a tilted preview is drawn with. Stored with a
/// patched reply so the disk copy is the tilted plate, not the slice frame.
#[derive(Clone)]
pub(super) struct BeltTilt {
    pub frame: crate::belt::Frame,
    pub belt: crate::belt::Belt,
    pub offsets: Vec<Option<[f64; 2]>>,
}

/// Names the preview of a kept plate: each object's key and edits, in plate
/// order, and the printer profile. The same name always means the same
/// preview.
pub(super) fn token(
    keys: &[[u8; 32]],
    profile: &PrinterProfile,
    edits: &[&[SupportEdit]],
    belt: Option<&BeltStamp>,
    sequential: bool,
) -> String {
    let mut hash = Sha256::new();
    for key in keys {
        hash.update(key);
    }
    hash.update(profile_digest(profile));
    hash.update(format!("{edits:?}"));
    // Absent on a cartesian plate, so the digest above is the whole token.
    if let Some(belt) = belt {
        belt.mix(&mut hash);
    }
    // All-at-once and a single object leave this out, so that token holds.
    if sequential {
        hash.update(b"sequential");
    }
    hash.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn profile_digest(profile: &PrinterProfile) -> [u8; 32] {
    Sha256::digest(format!("{profile:?}")).into()
}

/// What a preview reads besides its printed layers and blends: each object's
/// cut and the flow cap on its speeds. Two previews alike in these draw equal
/// layers of objects with equal blends as equal paths.
pub(super) fn drawn(contours: &[[u8; 32]], profile: &PrinterProfile) -> [u8; 32] {
    let mut hash = Sha256::new();
    for cut in contours {
        hash.update(cut);
    }
    hash.update(format!("{:x}", profile.max_volumetric_mm3_s.to_bits()));
    hash.finalize().into()
}

/// The layers of a preview that differ from the one the client holds.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPatch {
    /// The `previewToken` of the preview this patch applies to.
    pub base: String,
    /// `PreviewLayer.index` of every layer of the patched preview, in order.
    /// A layer not in `changed` is the base's layer with the same index.
    pub layers: Vec<usize>,
    /// The layers whose paths changed. A layer whose time alone changed is
    /// not one of them: its time is in `seconds`.
    pub changed: Vec<PatchLayer>,
    /// Every listed layer's estimator seconds, in the order of `layers`.
    pub seconds: Vec<f64>,
    /// The preview this patch stands for, whole, for the disk cache.
    #[serde(skip)]
    pub(crate) whole: WholePreview,
}

/// A patched reply's whole preview, drawn only when read, from the layers
/// the kept stages already hold.
#[derive(Clone)]
pub(crate) struct WholePreview {
    pub(super) layers: Arc<Vec<PlateLayer>>,
    pub(super) profile: PrinterProfile,
    pub(super) blends: Vec<BlendMode>,
    pub(super) layer_seconds: Vec<f64>,
    /// Set for a belt plate, so the stored reply is the tilted preview.
    pub(super) tilt: Option<BeltTilt>,
}

impl WholePreview {
    pub(crate) fn layers(&self) -> Vec<PreviewLayer> {
        let blends: Vec<&BlendMode> = self.blends.iter().collect();
        let mut layers = preview_of(&self.layers, &self.profile, &blends, &self.layer_seconds);
        if let Some(tilt) = &self.tilt {
            super::tilt_held(&mut layers, &self.layers, tilt);
        }
        layers
    }
}

impl std::fmt::Debug for WholePreview {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WholePreview")
    }
}

/// One changed layer. `layer.paths` holds only the paths the base layer
/// lacks; `order` lists the whole layer in print order.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchLayer {
    #[serde(flatten)]
    pub layer: PreviewLayer,
    /// `k >= 0` is path `k` of the base layer with this index, and
    /// `-1 - j` is `layer.paths[j]`.
    pub order: Vec<i32>,
}

/// `now` as a patch on `base`: every path of `now` that `base` already has
/// becomes a reference to it.
pub(super) fn diff_layer(base: &[PreviewPath], mut now: PreviewLayer) -> PatchLayer {
    let mut index: HashMap<u64, Vec<usize>> = HashMap::new();
    for (k, path) in base.iter().enumerate() {
        index.entry(path_hash(path)).or_default().push(k);
    }
    let mut order = Vec::with_capacity(now.paths.len());
    let mut fresh = Vec::new();
    for path in std::mem::take(&mut now.paths) {
        let same = index
            .get(&path_hash(&path))
            .and_then(|ks| ks.iter().copied().find(|&k| base[k] == path));
        match same {
            Some(k) => order.push(k as i32),
            None => {
                fresh.push(path);
                order.push(-(fresh.len() as i32));
            }
        }
    }
    now.paths = fresh;
    PatchLayer { layer: now, order }
}

fn path_hash(path: &PreviewPath) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.kind.hash(&mut h);
    path.strategy.hash(&mut h);
    path.object.hash(&mut h);
    for p in &path.pts {
        p[0].to_bits().hash(&mut h);
        p[1].to_bits().hash(&mut h);
    }
    for z in &path.zs {
        z.to_bits().hash(&mut h);
    }
    for v in [
        path.width,
        path.speed,
        path.effective_speed,
        path.toughness,
        path.bead_height,
    ] {
        v.to_bits().hash(&mut h);
    }
    h.finish()
}
