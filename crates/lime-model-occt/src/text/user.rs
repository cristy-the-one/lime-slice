//! The person's own fonts (docs/plan-text-on-curves-and-fonts.md, milestone 4).
//!
//! A font file is data, read by `ttf-parser` and never run. The engine keeps the fonts it was given in a table by id
//! (`user:` and the first 16 hex digits of the file's SHA-256, `.n` after it for the n-th face of a collection), the way the
//! bundled fonts are found by name, so a text step names its font by id and a rebuild finds the same bytes.
//!
//! Embedding (D5). The project keeps the font file. A font whose `OS/2 fsType` forbids embedding (restricted, or preview and
//! print only, or bitmap embedding only) is not copied into the project; it keeps a `Pack`: the outlines, advances and kerning
//! of just the letters the project's texts use, at the weights they use. That is data the layout reads in place of the file,
//! so the project rebuilds and edits anywhere with those letters, and says so when a letter outside them is typed.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use ttf_parser::{name_id, Face, Permissions, Tag};

use super::{lay_out_with, Align, Contour, FaceGlyphs, Glyphs, Laid, Seg, Spec};

/// The sentence for a file that is not a font.
pub const UNREADABLE: &str =
    "This file is not a font Lime Slice can read. Use a TrueType (.ttf) or OpenType (.otf) file.";

/// The largest font file the engine takes, bytes.
pub const MAX_FILE_BYTES: usize = 40 * 1024 * 1024;

/// The id's prefix: a font the person added.
pub const ID_PREFIX: &str = "user:";

pub fn is_user_id(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

/// What a font's licence lets a project keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Embedding {
    /// The whole file: installable or editable embedding, or no `OS/2` table to say otherwise.
    Full,
    /// Only the outlines the text uses: restricted, preview and print, bitmap-only embedding, or a malformed value.
    Outlines,
}

/// The licence's say, from `OS/2 fsType`.
pub fn embedding_of(face: &Face) -> Embedding {
    if face.tables().os2.is_none() {
        return Embedding::Full;
    }
    match face.permissions() {
        Some(Permissions::Installable) | Some(Permissions::Editable)
            if face.is_outline_embedding_allowed() =>
        {
            Embedding::Full
        }
        _ => Embedding::Outlines,
    }
}

/// What the person sees of a font and what the layout needs to choose among its styles.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    /// The full name: "Source Code Pro Regular".
    pub name: String,
    pub family: String,
    pub style: String,
    pub bold: bool,
    pub italic: bool,
    /// The `wght` axis of a variable font: minimum, default, maximum.
    pub weight_axis: Option<[f64; 3]>,
    pub fs_type: u16,
    pub embedding: Embedding,
}

/// A letter's outline, advance and the pairs it kerns with, as a pack keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PackGlyph {
    /// The advance, font units.
    pub adv: f64,
    /// Each closed loop: start x, y, then for each piece its kind (1 line, 2 quad, 3 cubic) and its points.
    pub c: Vec<Vec<f64>>,
}

/// The letters of one weight (or the one weight of a static font).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Instance {
    pub weight: Option<f64>,
    pub glyphs: BTreeMap<u32, PackGlyph>,
    /// `[left, right, adjustment]` in font units, for every pair of these letters the font kerns.
    pub kern: Vec<[f64; 3]>,
}

/// The outlines of the letters a project uses, from a font it may not embed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pack {
    pub lime: String,
    pub v: u32,
    pub id: String,
    pub sha256: String,
    pub meta: Meta,
    /// The capitals' height, font units.
    pub cap: f64,
    pub instances: Vec<Instance>,
}

const PACK_TAG: &str = "font-pack";

pub enum Source {
    File { bytes: Arc<Vec<u8>>, index: u32 },
    Pack(Box<Pack>),
}

pub struct UserFont {
    pub id: String,
    pub sha256: String,
    pub meta: Meta,
    pub source: Source,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<UserFont>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<UserFont>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The font `id` names, if this engine was given it.
pub fn lookup(id: &str) -> Option<Arc<UserFont>> {
    let id = id.split('@').next().unwrap_or(id);
    registry().lock().ok()?.get(id).cloned()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_of(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn id_of(sha: &str, index: u32) -> String {
    if index == 0 {
        format!("{ID_PREFIX}{}", &sha[..16])
    } else {
        format!("{ID_PREFIX}{}.{index}", &sha[..16])
    }
}

fn name_of(face: &Face, ids: &[u16]) -> Option<String> {
    for id in ids {
        for name in face.names() {
            if name.name_id == *id && name.is_unicode() {
                if let Some(text) = name.to_string() {
                    let text = text.trim().to_string();
                    if !text.is_empty() {
                        return Some(text);
                    }
                }
            }
        }
    }
    None
}

fn wght() -> Tag {
    Tag::from_bytes(b"wght")
}

fn has_outlines(face: &Face) -> bool {
    let t = face.tables();
    t.glyf.is_some() || t.cff.is_some() || t.cff2.is_some()
}

fn meta_of(face: &Face) -> Meta {
    let family = name_of(face, &[name_id::TYPOGRAPHIC_FAMILY, name_id::FAMILY])
        .unwrap_or_else(|| "Untitled font".into());
    let style = name_of(face, &[name_id::TYPOGRAPHIC_SUBFAMILY, name_id::SUBFAMILY])
        .unwrap_or_else(|| "Regular".into());
    let name = name_of(face, &[name_id::FULL_NAME]).unwrap_or_else(|| {
        if style.eq_ignore_ascii_case("regular") {
            family.clone()
        } else {
            format!("{family} {style}")
        }
    });
    let weight_axis = face
        .variation_axes()
        .into_iter()
        .find(|axis| axis.tag == wght())
        .map(|axis| {
            [
                f64::from(axis.min_value),
                f64::from(axis.def_value),
                f64::from(axis.max_value),
            ]
        });
    let fs_type = fs_type_of(face);
    Meta {
        name,
        family,
        style,
        bold: face.is_bold(),
        italic: face.is_italic(),
        weight_axis,
        fs_type,
        embedding: embedding_of(face),
    }
}

/// The raw `OS/2 fsType`, read from the table as the file holds it.
fn fs_type_of(face: &Face) -> u16 {
    face.raw_face()
        .table(Tag::from_bytes(b"OS/2"))
        .and_then(|data| data.get(8..10))
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .unwrap_or(0)
}

/// What a font file is, or the sentence that says why it is not one we can use. Nothing is stored.
pub fn inspect(bytes: &[u8], index: u32) -> Result<Meta, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "This font file is larger than {} MB. Pick a smaller one.",
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    let face = Face::parse(bytes, index).map_err(|_| UNREADABLE.to_string())?;
    let meta = meta_of(&face);
    if !has_outlines(&face) {
        return Err(format!(
            "‘{}’ has only bitmap letters and no outlines. Pick an outline font (TrueType or OpenType).",
            meta.name
        ));
    }
    if face.tables().cmap.is_none() {
        return Err(format!(
            "‘{}’ maps no characters to letters, so it cannot be typed with.",
            meta.name
        ));
    }
    Ok(meta)
}

/// Every face of a collection as `(index, name)`; a single font gives its own.
fn faces_of(bytes: &[u8]) -> Vec<(u32, String)> {
    let count = ttf_parser::fonts_in_collection(bytes).unwrap_or(1);
    (0..count)
        .filter_map(|i| {
            Face::parse(bytes, i)
                .ok()
                .map(|face| (i, meta_of(&face).name))
        })
        .collect()
}

/// Whether `bytes` is a pack and not a font file: a pack is JSON, which starts with an opening brace.
pub fn is_pack(bytes: &[u8]) -> bool {
    bytes.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{')
}

/// What `register` tells the caller about the font it now holds.
pub struct Added {
    pub font: Arc<UserFont>,
    /// The other faces of a collection, by index and name, when there is more than one.
    pub faces: Vec<(u32, String)>,
}

/// Take a font file (or a pack of one) into the table. A pack never replaces the whole font it came from.
pub fn register(bytes: Vec<u8>, face: Option<u32>) -> Result<Added, String> {
    if is_pack(&bytes) {
        let pack: Pack = serde_json::from_slice(&bytes).map_err(|_| UNREADABLE.to_string())?;
        if pack.lime != PACK_TAG || pack.v != 1 || !is_user_id(&pack.id) {
            return Err(UNREADABLE.to_string());
        }
        let mut table = registry()
            .lock()
            .map_err(|_| "The font table is busy.".to_string())?;
        if let Some(held) = table.get(&pack.id) {
            if matches!(held.source, Source::File { .. }) {
                return Ok(Added {
                    font: held.clone(),
                    faces: Vec::new(),
                });
            }
        }
        let font = Arc::new(UserFont {
            id: pack.id.clone(),
            sha256: pack.sha256.clone(),
            meta: pack.meta.clone(),
            source: Source::Pack(Box::new(pack)),
        });
        table.insert(font.id.clone(), font.clone());
        return Ok(Added {
            font,
            faces: Vec::new(),
        });
    }
    let index = face.unwrap_or(0);
    let meta = inspect(&bytes, index)?;
    let sha = sha256_of(&bytes);
    let id = id_of(&sha, index);
    let faces = {
        let all = faces_of(&bytes);
        if all.len() > 1 {
            all
        } else {
            Vec::new()
        }
    };
    let font = Arc::new(UserFont {
        id: id.clone(),
        sha256: sha,
        meta,
        source: Source::File {
            bytes: Arc::new(bytes),
            index,
        },
    });
    registry()
        .lock()
        .map_err(|_| "The font table is busy.".to_string())?
        .insert(id, font.clone());
    Ok(Added { font, faces })
}

fn letters_of(pack: &Pack) -> String {
    let set: BTreeSet<char> = pack
        .instances
        .iter()
        .flat_map(|inst| inst.glyphs.keys())
        .filter_map(|cp| char::from_u32(*cp))
        .filter(|ch| !ch.is_whitespace())
        .collect();
    set.into_iter().collect()
}

/// The reply of `textFontAdd`: what the font is, for the picker and the card.
pub fn info(added: &Added) -> Value {
    let font = &added.font;
    let meta = &font.meta;
    let mut out = json!({
        "ok": true,
        "id": font.id,
        "sha256": font.sha256,
        "name": meta.name,
        "family": meta.family,
        "style": meta.style,
        "bold": meta.bold,
        "italic": meta.italic,
        "weight": meta.weight_axis.map(|[min, def, max]| json!({"min": min, "default": def, "max": max})),
        "fsType": meta.fs_type,
        "embedding": meta.embedding,
        "restricted": meta.embedding == Embedding::Outlines,
    });
    if !added.faces.is_empty() {
        out["faces"] = json!(added
            .faces
            .iter()
            .map(|(i, n)| json!({"index": i, "name": n}))
            .collect::<Vec<_>>());
    }
    if let Source::Pack(pack) = &font.source {
        out["pack"] = json!(true);
        out["letters"] = json!(letters_of(pack));
        out["weights"] = json!(pack
            .instances
            .iter()
            .filter_map(|i| i.weight)
            .collect::<Vec<_>>());
    }
    out
}

/// The weight a text asks for, and whether its italic is a slant, from the style and the weight typed, or a sentence.
/// A variable font's bold is weight 700 (inside the axis); a static font has a bold only if its file is bold.
pub fn resolve(
    meta: &Meta,
    bold: bool,
    italic: bool,
    weight: Option<f64>,
) -> Result<(Option<f64>, bool), String> {
    let slant = italic && !meta.italic;
    let weight = match (weight, meta.weight_axis) {
        (Some(w), Some([min, _, max])) => {
            if !w.is_finite() || w < min - 1e-9 || w > max + 1e-9 {
                return Err(format!("‘{}’ takes weights {} to {}.", meta.name, trim(min), trim(max)));
            }
            Some(w)
        }
        (Some(_), None) => {
            return Err(format!(
                "‘{}’ is not a variable font, so it has one weight. Leave the weight out, or pick a variable font.",
                meta.name
            ))
        }
        (None, Some([min, _, max])) if bold => Some(700.0f64.clamp(min, max)),
        (None, None) if bold && !meta.bold => {
            return Err(format!("‘{}’ has no bold. Pick Regular, or another font.", meta.name))
        }
        (None, _) => None,
    };
    Ok((weight, slant))
}

fn trim(v: f64) -> String {
    if v.fract().abs() < 1e-9 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// A pack's letters read by the layout.
struct PackGlyphs<'a> {
    pack: &'a Pack,
    instance: &'a Instance,
    kern: HashMap<(u32, u32), f64>,
}

impl<'a> PackGlyphs<'a> {
    fn new(pack: &'a Pack, instance: &'a Instance) -> Self {
        let kern = instance
            .kern
            .iter()
            .map(|k| ((k[0] as u32, k[1] as u32), k[2]))
            .collect();
        PackGlyphs {
            pack,
            instance,
            kern,
        }
    }
}

impl Glyphs for PackGlyphs<'_> {
    fn glyph(&self, ch: char) -> Option<u32> {
        let cp = ch as u32;
        self.instance.glyphs.contains_key(&cp).then_some(cp)
    }
    fn advance(&self, glyph: u32) -> f64 {
        self.instance.glyphs.get(&glyph).map_or(0.0, |g| g.adv)
    }
    fn kerning(&self, left: u32, right: u32) -> f64 {
        self.kern.get(&(left, right)).copied().unwrap_or(0.0)
    }
    fn outline(&self, glyph: u32) -> Vec<Contour> {
        self.instance
            .glyphs
            .get(&glyph)
            .map_or_else(Vec::new, |g| g.c.iter().filter_map(|c| decode(c)).collect())
    }
    fn cap_height(&self) -> f64 {
        self.pack.cap
    }
    fn lacks(&self, missing: &[char]) -> String {
        let names: Vec<String> = missing.iter().map(|ch| format!("‘{ch}’")).collect();
        let list = match names.len() {
            1 => names[0].clone(),
            n => format!("{} and {}", names[..n - 1].join(", "), names[n - 1]),
        };
        format!(
            "‘{}’ is saved in this project with only the letters it was used for, so it has no {list}. Add the font file again to type more.",
            self.pack.meta.name
        )
    }
}

fn encode(contour: &Contour) -> Vec<f64> {
    let mut out = vec![contour.start[0], contour.start[1]];
    for seg in &contour.segs {
        match *seg {
            Seg::Line(p) => out.extend([1.0, p[0], p[1]]),
            Seg::Quad(a, p) => out.extend([2.0, a[0], a[1], p[0], p[1]]),
            Seg::Cubic(a, b, p) => out.extend([3.0, a[0], a[1], b[0], b[1], p[0], p[1]]),
        }
    }
    out
}

fn decode(flat: &[f64]) -> Option<Contour> {
    if flat.len() < 2 {
        return None;
    }
    let mut contour = Contour {
        start: [flat[0], flat[1]],
        segs: Vec::new(),
    };
    let mut i = 2;
    while i < flat.len() {
        let (kind, n) = match flat[i] as i32 {
            1 => (1, 2),
            2 => (2, 4),
            3 => (3, 6),
            _ => return None,
        };
        let c = flat.get(i + 1..i + 1 + n)?;
        contour.segs.push(match kind {
            1 => Seg::Line([c[0], c[1]]),
            2 => Seg::Quad([c[0], c[1]], [c[2], c[3]]),
            _ => Seg::Cubic([c[0], c[1]], [c[2], c[3]], [c[4], c[5]]),
        });
        i += 1 + n;
    }
    Some(contour)
}

fn face_at<'a>(bytes: &'a [u8], index: u32, weight: Option<f64>) -> Result<Face<'a>, String> {
    let mut face = Face::parse(bytes, index).map_err(|_| UNREADABLE.to_string())?;
    if let Some(w) = weight {
        face.set_variation(wght(), w as f32);
    }
    Ok(face)
}

fn same_weight(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => (x - y).abs() < 0.5,
        _ => false,
    }
}

/// Lay out a text in a font the person added.
pub fn lay_out(spec: &Spec) -> Result<Laid, String> {
    let font = lookup(&spec.font).ok_or_else(|| {
        format!(
            "The font {} is not on this computer. Add its file again, or pick another font.",
            spec.font
        )
    })?;
    let (bold, italic) = super::fonts::style_flags(spec.style.as_deref())?;
    let (weight, slant) = resolve(&font.meta, bold, italic, spec.weight)?;
    match &font.source {
        Source::File { bytes, index } => {
            let face = face_at(bytes, *index, weight)?;
            lay_out_with(spec, &FaceGlyphs(face), slant, font.id.clone())
        }
        Source::Pack(pack) => {
            let instance = pack.instances.iter().find(|inst| same_weight(inst.weight, weight)).ok_or_else(|| {
                format!(
                    "‘{}’ is saved in this project at the weights it was used at only. Add the font file again to use another weight.",
                    pack.meta.name
                )
            })?;
            lay_out_with(
                spec,
                &PackGlyphs::new(pack, instance),
                slant,
                font.id.clone(),
            )
        }
    }
}

/// One text the project sets in a font: the pack keeps the letters of each, at the weight it resolves to.
pub struct Use {
    pub text: String,
    pub style: Option<String>,
    pub weight: Option<f64>,
}

/// The pack of `id`: the outlines, advances and kerning of the letters of `uses`. A pack that is already a pack is returned
/// as it is (the whole font is not here to take more from).
pub fn pack(id: &str, uses: &[Use]) -> Result<Pack, String> {
    let font = lookup(id).ok_or_else(|| format!("The font {id} is not on this computer."))?;
    let (bytes, index) = match &font.source {
        Source::Pack(pack) => return Ok((**pack).clone()),
        Source::File { bytes, index } => (bytes.clone(), *index),
    };
    // The letters of each weight.
    let mut by_weight: Vec<(Option<f64>, BTreeSet<char>)> = Vec::new();
    for use_ in uses {
        let (bold, italic) = super::fonts::style_flags(use_.style.as_deref())?;
        let (weight, _) = resolve(&font.meta, bold, italic, use_.weight)?;
        // A space costs only its advance, so every pack has one: a text can always gain a word break.
        let chars = use_
            .text
            .chars()
            .filter(|ch| !ch.is_control())
            .chain(std::iter::once(' '));
        match by_weight.iter_mut().find(|(w, _)| same_weight(*w, weight)) {
            Some((_, set)) => set.extend(chars),
            None => by_weight.push((weight, chars.collect())),
        }
    }
    if by_weight.is_empty() {
        by_weight.push((None, BTreeSet::new()));
    }
    let mut instances = Vec::new();
    let mut cap = 0.0;
    for (weight, chars) in by_weight {
        let face = face_at(&bytes, index, weight)?;
        let glyphs = FaceGlyphs(face);
        cap = glyphs.cap_height();
        let mut map = BTreeMap::new();
        let mut ids: Vec<(char, u32)> = Vec::new();
        for ch in &chars {
            if let Some(g) = glyphs.glyph(*ch) {
                map.insert(
                    *ch as u32,
                    PackGlyph {
                        adv: glyphs.advance(g),
                        c: glyphs.outline(g).iter().map(encode).collect(),
                    },
                );
                ids.push((*ch, g));
            }
        }
        let mut kern = Vec::new();
        for (lc, l) in &ids {
            for (rc, r) in &ids {
                let k = glyphs.kerning(*l, *r);
                if k != 0.0 {
                    kern.push([*lc as u32 as f64, *rc as u32 as f64, k]);
                }
            }
        }
        instances.push(Instance {
            weight,
            glyphs: map,
            kern,
        });
    }
    let mut meta = font.meta.clone();
    meta.embedding = Embedding::Outlines;
    Ok(Pack {
        lime: PACK_TAG.into(),
        v: 1,
        id: font.id.clone(),
        sha256: font.sha256.clone(),
        meta,
        cap,
        instances,
    })
}

/// `textFontAdd`: take a font file (base64) and answer what it is.
pub fn add_reply(data_b64: &str, face: Option<u32>) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|_| UNREADABLE.to_string())?;
    let added = register(bytes, face)?;
    Ok(info(&added).to_string())
}

/// `textFontPack`: the pack of a font for the letters a project uses, as base64 of its JSON.
pub fn pack_reply(id: &str, uses: &[Use]) -> Result<String, String> {
    use base64::Engine;
    let pack = pack(id, uses)?;
    let json = serde_json::to_vec(&pack).map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "id": pack.id,
        "name": pack.meta.name,
        "dataB64": base64::engine::general_purpose::STANDARD.encode(json),
        "letters": letters_of(&pack),
    })
    .to_string())
}

/// A layout spec for a font id and a text, for tests and the card's checks.
#[allow(dead_code)]
pub fn spec_for(id: &str, text: &str, height: f64) -> Spec {
    Spec {
        text: text.into(),
        font: id.into(),
        style: None,
        height,
        spacing: None,
        line_spacing: None,
        align: Align::Centre,
        angle_deg: 0.0,
        weight: None,
        stroke_mm: None,
    }
}
