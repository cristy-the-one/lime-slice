//! A streaming read of a `.lime` file. Long strings (mesh and solid bytes) are
//! skipped, not stored. Nothing here panics on a bad file.

use std::time::{Duration, Instant};

use crate::hash::{hash_rows, HashRow, Placement};

const THUMB_MAX_EDGE: u32 = 512;
const THUMB_MAX_BYTES: usize = 128 * 1024;
const SHORT_STRING: usize = 4096;
const MAX_OBJECTS: usize = 4096;
const MAX_NEST: usize = 10_000;

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub name: Option<String>,
    pub printer: Option<String>,
    pub object_count: Option<u32>,
    pub layer_height: Option<f64>,
    pub sliced_seconds: Option<f64>,
    pub grams: Option<f64>,
}

impl Summary {
    fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.printer.is_none()
            && self.object_count.is_none()
            && self.layer_height.is_none()
            && self.sliced_seconds.is_none()
            && self.grams.is_none()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Thumbnail {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub mesh_hash: String,
    pub generated_by: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Clone, Debug)]
struct Obj {
    id: String,
    name: String,
    mesh_name: String,
    mesh_hash: String,
    brep: bool,
    brep_hash: String,
    placement: Option<Placement>,
    settings: bool,
    paint: usize,
    seam: usize,
    reinforce: bool,
    model_tree: bool,
    pose_set: bool,
    pose_identity: bool,
    workplane: bool,
}

impl Obj {
    fn new() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            mesh_name: String::new(),
            mesh_hash: String::new(),
            brep: false,
            brep_hash: String::new(),
            placement: None,
            settings: false,
            paint: 0,
            seam: 0,
            reinforce: false,
            model_tree: false,
            pose_set: false,
            pose_identity: true,
            workplane: false,
        }
    }

    /// The same test as `plateFileIsVersion2` for one object.
    fn forces_plate(&self) -> bool {
        self.name != self.mesh_name
            || self.settings
            || self.paint > 0
            || self.seam > 0
            || self.reinforce
            || self.brep
            || self.model_tree
            || (self.pose_set && !self.pose_identity)
            || self.workplane
    }
}

struct TopMesh {
    hash: String,
}

struct Scan<'a> {
    bytes: &'a [u8],
    at: usize,
    deadline: Instant,
    incomplete: bool,
    version: Option<u64>,
    top_mesh: Option<TopMesh>,
    top_place: Option<Placement>,
    objects: Vec<Obj>,
    thumbnail: Option<Thumbnail>,
    summary: Option<Summary>,
}

impl<'a> Scan<'a> {
    fn new(bytes: &'a [u8], budget: Duration) -> Self {
        Self {
            bytes,
            at: 0,
            deadline: Instant::now() + budget,
            incomplete: false,
            version: None,
            top_mesh: None,
            top_place: None,
            objects: Vec::new(),
            thumbnail: None,
            summary: None,
        }
    }

    fn timed_out(&mut self) -> bool {
        if Instant::now() >= self.deadline {
            self.incomplete = true;
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.at += 1;
        Some(byte)
    }

    fn skip_ws(&mut self) -> bool {
        loop {
            if self.timed_out() {
                return false;
            }
            match self.peek() {
                Some(b' ' | b'\n' | b'\r' | b'\t') => self.at += 1,
                _ => return true,
            }
        }
    }

    fn eat(&mut self, byte: u8) -> bool {
        if !self.skip_ws() {
            return false;
        }
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn parse_file(&mut self) {
        if !self.eat(b'{') {
            self.incomplete = true;
            return;
        }
        loop {
            if self.timed_out() || !self.skip_ws() {
                self.incomplete = true;
                return;
            }
            if self.eat(b'}') {
                return;
            }
            let key = match self.parse_string(256) {
                Some(Text::Kept(key)) => key,
                _ => {
                    self.incomplete = true;
                    return;
                }
            };
            if !self.eat(b':') {
                self.incomplete = true;
                return;
            }
            let ok = match key.as_str() {
                "thumbnail" => self.parse_thumbnail(),
                "summary" => self.parse_summary(),
                "version" => self.parse_version(),
                "mesh" => self.parse_mesh(MeshSlot::Top),
                "placement" => self.parse_placement(PlaceSlot::Top),
                "objects" => self.parse_objects(),
                _ => self.skip_value(),
            };
            if !ok {
                self.incomplete = true;
                return;
            }
            if !self.skip_ws() {
                self.incomplete = true;
                return;
            }
            if self.peek() == Some(b',') {
                self.at += 1;
                continue;
            }
            if self.eat(b'}') {
                return;
            }
            self.incomplete = true;
            return;
        }
    }

    fn parse_version(&mut self) -> bool {
        match self.parse_number() {
            Some(n) if n >= 0.0 && n.fract() == 0.0 && n < u64::MAX as f64 => {
                self.version = Some(n as u64);
                true
            }
            Some(_) => true,
            None => false,
        }
    }

    fn parse_thumbnail(&mut self) -> bool {
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut format = String::new();
        let mut width = None;
        let mut height = None;
        let mut data = String::new();
        let mut mesh_hash = String::new();
        let mut generated_by = None;
        let mut created_at = None;
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(64) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = match key.as_str() {
                "format" => match self.parse_string(16) {
                    Some(Text::Kept(text)) => {
                        format = text;
                        true
                    }
                    Some(Text::Skipped) => true,
                    None => false,
                },
                "width" => {
                    width = self.parse_number();
                    width.is_some()
                }
                "height" => {
                    height = self.parse_number();
                    height.is_some()
                }
                "data" => match self.parse_string(base64_cap()) {
                    Some(Text::Kept(text)) => {
                        data = text;
                        true
                    }
                    Some(Text::Skipped) => true,
                    None => false,
                },
                "meshHash" => match self.parse_string(64) {
                    Some(Text::Kept(text)) => {
                        mesh_hash = text;
                        true
                    }
                    Some(Text::Skipped) => true,
                    None => false,
                },
                "generatedBy" => match self.parse_string(80) {
                    Some(Text::Kept(text)) => {
                        generated_by = Some(text);
                        true
                    }
                    Some(Text::Skipped) => true,
                    None => false,
                },
                "createdAt" => match self.parse_string(40) {
                    Some(Text::Kept(text)) => {
                        created_at = Some(text);
                        true
                    }
                    Some(Text::Skipped) => true,
                    None => false,
                },
                _ => self.skip_value(),
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
        self.thumbnail = thumbnail_from(
            format,
            width,
            height,
            data,
            mesh_hash,
            generated_by,
            created_at,
        );
        true
    }

    fn parse_summary(&mut self) -> bool {
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut summary = Summary {
            name: None,
            printer: None,
            object_count: None,
            layer_height: None,
            sliced_seconds: None,
            grams: None,
        };
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(64) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = match key.as_str() {
                "name" => match self.parse_label() {
                    Some(value) => {
                        summary.name = value;
                        true
                    }
                    None => false,
                },
                "printer" => match self.parse_label() {
                    Some(value) => {
                        summary.printer = value;
                        true
                    }
                    None => false,
                },
                "objectCount" => {
                    if let Some(n) = self.parse_number() {
                        if n.fract() == 0.0 && (1.0..100_001.0).contains(&n) {
                            summary.object_count = Some(n as u32);
                        }
                        true
                    } else {
                        false
                    }
                }
                "layerHeight" => {
                    if let Some(n) = self.parse_number() {
                        if n.is_finite() && n > 0.0 && n <= 100.0 {
                            summary.layer_height = Some(n);
                        }
                        true
                    } else {
                        false
                    }
                }
                "slicedSeconds" => {
                    if let Some(n) = self.parse_number() {
                        if n.is_finite() && (0.0..=1e9).contains(&n) {
                            summary.sliced_seconds = Some(n);
                        }
                        true
                    } else {
                        false
                    }
                }
                "grams" => {
                    if let Some(n) = self.parse_number() {
                        if n.is_finite() && (0.0..=1e9).contains(&n) {
                            summary.grams = Some(n);
                        }
                        true
                    } else {
                        false
                    }
                }
                _ => self.skip_value(),
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
        if !summary.is_empty() {
            self.summary = Some(summary);
        }
        true
    }

    /// `Some(None)` is a string with nothing usable. `None` is not a string.
    fn parse_label(&mut self) -> Option<Option<String>> {
        match self.parse_string(SHORT_STRING) {
            Some(Text::Kept(text)) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    Some(None)
                } else {
                    Some(Some(trimmed.chars().take(240).collect()))
                }
            }
            Some(Text::Skipped) => Some(None),
            None => None,
        }
    }

    fn parse_objects(&mut self) -> bool {
        if !self.eat(b'[') {
            return self.skip_value();
        }
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b']') {
                return true;
            }
            if self.objects.len() >= MAX_OBJECTS {
                self.incomplete = true;
                return false;
            }
            if !self.parse_object() {
                return false;
            }
            if !self.finish_field() {
                return false;
            }
        }
    }

    fn parse_object(&mut self) -> bool {
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut obj = Obj::new();
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(64) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = match key.as_str() {
                "id" => match self.parse_string(SHORT_STRING) {
                    Some(Text::Kept(text)) => {
                        obj.id = text;
                        true
                    }
                    Some(Text::Skipped) => {
                        self.incomplete = true;
                        true
                    }
                    None => false,
                },
                "name" => match self.parse_string(SHORT_STRING) {
                    Some(Text::Kept(text)) => {
                        obj.name = text;
                        true
                    }
                    Some(Text::Skipped) => {
                        self.incomplete = true;
                        true
                    }
                    None => false,
                },
                "mesh" => self.parse_mesh(MeshSlot::Object(&mut obj)),
                "brep" => self.parse_brep(&mut obj),
                "placement" => self.parse_placement(PlaceSlot::Object(&mut obj)),
                "settings" => self.parse_settings(&mut obj),
                "supportPaint" => self.parse_count_array(&mut obj.paint),
                "seamPaint" => self.parse_count_array(&mut obj.seam),
                "reinforcement" => self.parse_reinforcement(&mut obj),
                "modelTree" => self.parse_present(&mut obj.model_tree),
                "modelPose" => self.parse_pose(&mut obj),
                "workplane" => self.parse_workplane(&mut obj),
                _ => self.skip_value(),
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
        self.objects.push(obj);
        true
    }

    fn parse_mesh(&mut self, slot: MeshSlot<'_>) -> bool {
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut name = String::new();
        let mut hash = String::new();
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(64) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = match key.as_str() {
                "name" => match self.parse_string(SHORT_STRING) {
                    Some(Text::Kept(text)) => {
                        name = text;
                        true
                    }
                    Some(Text::Skipped) => {
                        self.incomplete = true;
                        true
                    }
                    None => false,
                },
                "hash" => match self.parse_string(64) {
                    Some(Text::Kept(text)) => {
                        hash = text;
                        true
                    }
                    Some(Text::Skipped) => {
                        self.incomplete = true;
                        true
                    }
                    None => false,
                },
                _ => self.skip_value(),
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
        match slot {
            MeshSlot::Top => self.top_mesh = Some(TopMesh { hash }),
            MeshSlot::Object(obj) => {
                obj.mesh_name = name;
                obj.mesh_hash = hash;
            }
        }
        true
    }

    fn parse_brep(&mut self, obj: &mut Obj) -> bool {
        if !self.skip_ws() {
            return false;
        }
        if self.eat(b'n') {
            return self.consume("ull");
        }
        if !self.eat(b'{') {
            return self.skip_value();
        }
        obj.brep = true;
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                return true;
            }
            let key = match self.parse_string(64) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = if key == "hash" {
                match self.parse_string(64) {
                    Some(Text::Kept(text)) => {
                        obj.brep_hash = text;
                        true
                    }
                    Some(Text::Skipped) => true,
                    None => false,
                }
            } else {
                self.skip_value()
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
    }

    fn parse_placement(&mut self, slot: PlaceSlot<'_>) -> bool {
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut place = Placement {
            scale: f64::NAN,
            centered: true,
            step_tolerance: f64::NAN,
            orient: [f64::NAN; 9],
            offset: [f64::NAN; 3],
        };
        let mut saw_centered = false;
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(64) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = match key.as_str() {
                "scale" => {
                    place.scale = self.parse_number().unwrap_or(f64::NAN);
                    place.scale.is_finite()
                }
                "centered" => {
                    saw_centered = true;
                    match self.parse_bool() {
                        Some(value) => {
                            place.centered = value;
                            true
                        }
                        None => false,
                    }
                }
                "stepTolerance" => {
                    place.step_tolerance = self.parse_number().unwrap_or(f64::NAN);
                    place.step_tolerance.is_finite()
                }
                "orient" => self.parse_nine(&mut place.orient),
                "offset" => self.parse_offset(&mut place.offset),
                _ => self.skip_value(),
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
        if !saw_centered || !place.complete() {
            self.incomplete = true;
            return true;
        }
        match slot {
            PlaceSlot::Top => self.top_place = Some(place),
            PlaceSlot::Object(obj) => obj.placement = Some(place),
        }
        true
    }

    fn parse_nine(&mut self, into: &mut [f64; 9]) -> bool {
        if !self.eat(b'[') {
            return self.skip_value();
        }
        for (index, slot) in into.iter_mut().enumerate() {
            if index > 0 && !self.eat(b',') {
                return false;
            }
            match self.parse_number() {
                Some(n) => *slot = n,
                None => return false,
            }
        }
        self.eat(b']')
    }

    fn parse_offset(&mut self, into: &mut [f64; 3]) -> bool {
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut saw = [false; 3];
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(8) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let index = match key.as_str() {
                "x" => 0,
                "y" => 1,
                "z" => 2,
                _ => {
                    if !self.skip_value() || !self.finish_field() {
                        return false;
                    }
                    continue;
                }
            };
            match self.parse_number() {
                Some(n) => {
                    into[index] = n;
                    saw[index] = true;
                }
                None => return false,
            }
            if !self.finish_field() {
                return false;
            }
        }
        if !saw.iter().all(|flag| *flag) {
            self.incomplete = true;
        }
        true
    }

    fn parse_settings(&mut self, obj: &mut Obj) -> bool {
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut any = false;
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            if self.parse_string(256).is_none() || !self.eat(b':') || !self.skip_value() {
                return false;
            }
            any = true;
            if !self.finish_field() {
                return false;
            }
        }
        obj.settings = any;
        true
    }

    fn parse_count_array(&mut self, into: &mut usize) -> bool {
        if !self.eat(b'[') {
            return self.skip_value();
        }
        let mut count = 0usize;
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b']') {
                *into = count;
                return true;
            }
            if !self.skip_value() {
                return false;
            }
            count = count.saturating_add(1);
            if !self.finish_field() {
                return false;
            }
        }
    }

    fn parse_reinforcement(&mut self, obj: &mut Obj) -> bool {
        if !self.eat(b'[') {
            return self.skip_value();
        }
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b']') {
                return true;
            }
            if !self.reinforcement_item(obj) || !self.finish_field() {
                return false;
            }
        }
    }

    /// A paint region with no disks does not count. Any other region does.
    fn reinforcement_item(&mut self, obj: &mut Obj) -> bool {
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut kind = String::new();
        let mut disks = 0usize;
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(32) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = match key.as_str() {
                "kind" => match self.parse_string(32) {
                    Some(Text::Kept(text)) => {
                        kind = text;
                        true
                    }
                    Some(Text::Skipped) => true,
                    None => false,
                },
                "disks" => self.parse_count_array(&mut disks),
                _ => self.skip_value(),
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
        // A paint region with no disks is dropped, the same as `dropEmptyReinforce`. Any other kind counts.
        if kind == "paint" {
            if disks > 0 {
                obj.reinforce = true;
            }
        } else if !kind.is_empty() {
            obj.reinforce = true;
        }
        true
    }

    fn parse_present(&mut self, flag: &mut bool) -> bool {
        if !self.skip_ws() {
            return false;
        }
        if self.peek() == Some(b'n') {
            self.at += 1;
            return self.consume("ull");
        }
        *flag = true;
        self.skip_value()
    }

    fn parse_pose(&mut self, obj: &mut Obj) -> bool {
        if !self.skip_ws() {
            return false;
        }
        if self.peek() == Some(b'n') {
            self.at += 1;
            return self.consume("ull");
        }
        if !self.eat(b'{') {
            return self.skip_value();
        }
        let mut m = [f64::NAN; 9];
        let mut t = [f64::NAN; 3];
        let mut saw_m = false;
        let mut saw_t = false;
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(8) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = match key.as_str() {
                "m" => {
                    saw_m = self.parse_nine(&mut m);
                    saw_m
                }
                "t" => {
                    saw_t = self.parse_vec3(&mut t);
                    saw_t
                }
                _ => self.skip_value(),
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
        if saw_m && saw_t && m.iter().all(|n| n.is_finite()) && t.iter().all(|n| n.is_finite()) {
            obj.pose_set = true;
            let identity_m = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
            obj.pose_identity = m == identity_m && t == [0.0, 0.0, 0.0];
        } else {
            self.incomplete = true;
        }
        true
    }

    fn parse_vec3(&mut self, into: &mut [f64; 3]) -> bool {
        if !self.eat(b'[') {
            return false;
        }
        for (index, slot) in into.iter_mut().enumerate() {
            if index > 0 && !self.eat(b',') {
                return false;
            }
            match self.parse_number() {
                Some(n) => *slot = n,
                None => return false,
            }
        }
        self.eat(b']')
    }

    fn parse_workplane(&mut self, obj: &mut Obj) -> bool {
        if !self.skip_ws() {
            return false;
        }
        if self.peek() == Some(b'n') {
            self.at += 1;
            return self.consume("ull");
        }
        if !self.eat(b'{') {
            obj.workplane = true;
            return self.skip_value();
        }
        let mut source = String::new();
        let mut origin = [f64::NAN; 3];
        let mut turn = [f64::NAN; 3];
        let mut saw_origin = false;
        let mut saw_turn = false;
        loop {
            if !self.skip_ws() {
                return false;
            }
            if self.eat(b'}') {
                break;
            }
            let key = match self.parse_string(16) {
                Some(Text::Kept(key)) => key,
                _ => return false,
            };
            if !self.eat(b':') {
                return false;
            }
            let ok = match key.as_str() {
                "source" => match self.parse_string(16) {
                    Some(Text::Kept(text)) => {
                        source = text;
                        true
                    }
                    Some(Text::Skipped) => true,
                    None => false,
                },
                "origin" => {
                    saw_origin = self.parse_vec3(&mut origin);
                    saw_origin
                }
                "turn" => {
                    saw_turn = self.parse_vec3(&mut turn);
                    saw_turn
                }
                _ => self.skip_value(),
            };
            if !ok || !self.finish_field() {
                return false;
            }
        }
        let global = source == "global"
            && saw_origin
            && saw_turn
            && origin == [0.0, 0.0, 0.0]
            && turn == [0.0, 0.0, 0.0];
        // A global frame is not stored, so it does not make the file a plate.
        obj.workplane = !global;
        true
    }

    /// After a field value, a comma continues the object or array. A closer ends it,
    /// and is put back so the caller can see it.
    fn finish_field(&mut self) -> bool {
        if !self.skip_ws() {
            return false;
        }
        if self.peek() == Some(b',') {
            self.at += 1;
            return true;
        }
        matches!(self.peek(), Some(b'}' | b']'))
    }

    fn parse_bool(&mut self) -> Option<bool> {
        if !self.skip_ws() {
            return None;
        }
        if self.peek() == Some(b't') {
            self.at += 1;
            self.consume("rue").then_some(true)
        } else if self.peek() == Some(b'f') {
            self.at += 1;
            self.consume("alse").then_some(false)
        } else {
            None
        }
    }

    fn parse_number(&mut self) -> Option<f64> {
        if !self.skip_ws() {
            return None;
        }
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        let mut digits = 0usize;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.at += 1;
            digits += 1;
            if digits > 400 {
                self.incomplete = true;
                return None;
            }
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.at += 1;
                digits += 1;
                if digits > 400 {
                    self.incomplete = true;
                    return None;
                }
            }
        }
        if digits == 0 {
            return None;
        }
        if self.peek().is_some_and(|b| b == b'e' || b == b'E') {
            self.at += 1;
            if self.peek().is_some_and(|b| b == b'+' || b == b'-') {
                self.at += 1;
            }
            let mut exp_digits = 0usize;
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.at += 1;
                exp_digits += 1;
                if exp_digits > 8 {
                    self.incomplete = true;
                    return None;
                }
            }
            if exp_digits == 0 {
                return None;
            }
        }
        let token = self.bytes.get(start..self.at)?;
        let text = std::str::from_utf8(token).ok()?;
        text.parse::<f64>().ok().filter(|n| n.is_finite())
    }

    fn consume(&mut self, rest: &str) -> bool {
        for byte in rest.bytes() {
            if self.bump() != Some(byte) {
                return false;
            }
        }
        true
    }

    fn skip_value(&mut self) -> bool {
        if !self.skip_ws() {
            return false;
        }
        match self.peek() {
            Some(b'{') => self.skip_container(),
            Some(b'[') => self.skip_container(),
            Some(b'"') => self.skip_string_only(),
            Some(b't') => {
                self.at += 1;
                self.consume("rue")
            }
            Some(b'f') => {
                self.at += 1;
                self.consume("alse")
            }
            Some(b'n') => {
                self.at += 1;
                self.consume("ull")
            }
            Some(b'-' | b'0'..=b'9') => self.parse_number().is_some(),
            _ => false,
        }
    }

    fn skip_container(&mut self) -> bool {
        let open = match self.bump() {
            Some(b @ (b'{' | b'[')) => b,
            _ => return false,
        };
        let mut closers = Vec::new();
        closers.push(if open == b'{' { b'}' } else { b']' });
        let mut since = 0usize;
        while let Some(closer) = closers.last().copied() {
            if since >= 65_536 {
                since = 0;
                if self.timed_out() {
                    return false;
                }
            }
            let Some(byte) = self.bump() else {
                return false;
            };
            since += 1;
            match byte {
                b'"' => {
                    if !self.skip_string_body() {
                        return false;
                    }
                }
                b'{' => {
                    if closers.len() >= MAX_NEST {
                        self.incomplete = true;
                        return false;
                    }
                    closers.push(b'}');
                }
                b'[' => {
                    if closers.len() >= MAX_NEST {
                        self.incomplete = true;
                        return false;
                    }
                    closers.push(b']');
                }
                found if found == closer => {
                    closers.pop();
                }
                _ => {}
            }
        }
        true
    }

    fn skip_string_only(&mut self) -> bool {
        if self.bump() != Some(b'"') {
            return false;
        }
        self.skip_string_body()
    }

    fn skip_string_body(&mut self) -> bool {
        let mut since = 0usize;
        while let Some(byte) = self.bump() {
            since += 1;
            if since >= 65_536 {
                since = 0;
                if self.timed_out() {
                    return false;
                }
            }
            if byte == b'\\' {
                if self.bump().is_none() {
                    return false;
                }
                continue;
            }
            if byte == b'"' {
                return true;
            }
        }
        false
    }

    fn parse_string(&mut self, limit: usize) -> Option<Text> {
        if !self.skip_ws() {
            return None;
        }
        if self.bump() != Some(b'"') {
            return None;
        }
        let mut out = String::new();
        let mut skipped = false;
        while let Some(byte) = self.bump() {
            if out.len() > limit {
                skipped = true;
            }
            if byte == b'"' {
                return Some(if skipped {
                    Text::Skipped
                } else {
                    Text::Kept(out)
                });
            }
            if byte == b'\\' {
                let escaped = self.bump()?;
                if skipped {
                    if escaped == b'u' {
                        for _ in 0..4 {
                            self.bump()?;
                        }
                    }
                    continue;
                }
                match escaped {
                    b'"' | b'\\' | b'/' => out.push(escaped as char),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let unit = self.hex4()?;
                        if (0xD800..=0xDBFF).contains(&unit) {
                            if self.bump() != Some(b'\\') || self.bump() != Some(b'u') {
                                return None;
                            }
                            let low = self.hex4()?;
                            if !(0xDC00..=0xDFFF).contains(&low) {
                                return None;
                            }
                            let code = 0x10000
                                + (((unit as u32) - 0xD800) << 10)
                                + ((low as u32) - 0xDC00);
                            out.push(char::from_u32(code)?);
                        } else if (0xDC00..=0xDFFF).contains(&unit) {
                            return None;
                        } else {
                            out.push(char::from_u32(u32::from(unit))?);
                        }
                    }
                    _ => return None,
                }
                continue;
            }
            if byte < 0x20 {
                return None;
            }
            if !skipped {
                if byte < 0x80 {
                    out.push(byte as char);
                } else {
                    // Put the byte back and decode one UTF-8 scalar.
                    self.at -= 1;
                    let rest = self.bytes.get(self.at..)?;
                    let text = std::str::from_utf8(rest).ok()?;
                    let ch = text.chars().next()?;
                    self.at += ch.len_utf8();
                    out.push(ch);
                }
            }
        }
        None
    }

    fn hex4(&mut self) -> Option<u16> {
        let mut value = 0u16;
        for _ in 0..4 {
            let byte = self.bump()?;
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return None,
            };
            value = (value << 4) | u16::from(digit);
        }
        Some(value)
    }

    fn rows(&self) -> Option<Vec<HashRow>> {
        if self.incomplete {
            return None;
        }
        let version = self.version?;
        if version == 1 {
            let mesh = self.top_mesh.as_ref()?;
            let placement = self.top_place.clone()?;
            return Some(vec![HashRow {
                id: "part".into(),
                mesh_hash: mesh.hash.clone(),
                brep_hash: String::new(),
                placement,
            }]);
        }
        if !(2..=4).contains(&version) {
            return None;
        }
        if self.objects.is_empty() {
            return None;
        }
        let plate = self.objects.len() != 1 || self.objects.first().is_some_and(Obj::forces_plate);
        if plate {
            let mut rows = Vec::with_capacity(self.objects.len());
            for obj in &self.objects {
                if obj.id.is_empty() || obj.mesh_hash.is_empty() {
                    return None;
                }
                rows.push(HashRow {
                    id: obj.id.clone(),
                    mesh_hash: obj.mesh_hash.clone(),
                    brep_hash: if obj.brep {
                        obj.brep_hash.clone()
                    } else {
                        String::new()
                    },
                    placement: obj.placement.clone()?,
                });
            }
            return Some(rows);
        }
        let obj = self.objects.first()?;
        Some(vec![HashRow {
            id: "part".into(),
            mesh_hash: obj.mesh_hash.clone(),
            brep_hash: String::new(),
            placement: obj.placement.clone()?,
        }])
    }
}

enum Text {
    Kept(String),
    Skipped,
}

enum MeshSlot<'a> {
    Top,
    Object(&'a mut Obj),
}

enum PlaceSlot<'a> {
    Top,
    Object(&'a mut Obj),
}

fn base64_cap() -> usize {
    THUMB_MAX_BYTES.div_ceil(3) * 4 + 8
}

fn thumbnail_from(
    format: String,
    width: Option<f64>,
    height: Option<f64>,
    data: String,
    mesh_hash: String,
    generated_by: Option<String>,
    created_at: Option<String>,
) -> Option<Thumbnail> {
    if format != "png" || !hash_ok(&mesh_hash) || data.len() > base64_cap() {
        return None;
    }
    let width = int_edge(width)?;
    let height = int_edge(height)?;
    if width.max(height) > THUMB_MAX_EDGE {
        return None;
    }
    let png = decode_base64(&data)?;
    if png.len() > THUMB_MAX_BYTES {
        return None;
    }
    let info = png_info(&png)?;
    if info.0 != width || info.1 != height {
        return None;
    }
    let generated_by = generated_by.filter(|text| generated_by_ok(text));
    let created_at = created_at.filter(|text| created_at_ok(text));
    Some(Thumbnail {
        png,
        width,
        height,
        mesh_hash,
        generated_by,
        created_at,
    })
}

fn int_edge(value: Option<f64>) -> Option<u32> {
    let n = value?;
    if n.fract() != 0.0 || !(1.0..=THUMB_MAX_EDGE as f64).contains(&n) {
        return None;
    }
    Some(n as u32)
}

fn hash_ok(text: &str) -> bool {
    text.len() == 16
        && text
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn generated_by_ok(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

fn created_at_ok(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes.len() > 24 {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|slice| slice.iter().all(|b| b.is_ascii_digit()))
    };
    digits(0..4)
        && bytes.get(4) == Some(&b'-')
        && digits(5..7)
        && bytes.get(7) == Some(&b'-')
        && digits(8..10)
        && bytes.get(10) == Some(&b'T')
        && digits(11..13)
        && bytes.get(13) == Some(&b':')
        && digits(14..16)
        && bytes.get(16) == Some(&b':')
        && digits(17..19)
        && bytes.last() == Some(&b'Z')
        && (bytes.len() == 20
            || (bytes.get(19) == Some(&b'.')
                && digits(20..bytes.len() - 1)
                && (1..=3).contains(&(bytes.len() - 21))))
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks_exact(4) {
        let vals = [
            b64_digit(chunk[0])?,
            b64_digit(chunk[1])?,
            b64_digit(chunk[2])?,
            b64_digit(chunk[3])?,
        ];
        out.push((vals[0] << 2) | (vals[1] >> 4));
        if chunk[2] != b'=' {
            out.push((vals[1] << 4) | (vals[2] >> 2));
        }
        if chunk[3] != b'=' {
            out.push((vals[2] << 6) | vals[3]);
        }
    }
    Some(out)
}

fn b64_digit(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        b'=' => Some(0),
        _ => None,
    }
}

/// Width, height, and colour type when the PNG is an 8-bit RGB or RGBA image.
fn png_info(png: &[u8]) -> Option<(u32, u32, u8)> {
    if png.len() < 33 || png.get(..8) != Some(&PNG_SIGNATURE) {
        return None;
    }
    let length = u32::from_be_bytes(png.get(8..12)?.try_into().ok()?);
    if length != 13 || png.get(12..16) != Some(b"IHDR") {
        return None;
    }
    let width = u32::from_be_bytes(png.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(png.get(20..24)?.try_into().ok()?);
    let depth = *png.get(24)?;
    let color = *png.get(25)?;
    let compression = *png.get(26)?;
    let filter = *png.get(27)?;
    let interlace = *png.get(28)?;
    if depth != 8 || compression != 0 || filter != 0 || interlace != 0 {
        return None;
    }
    if color != 2 && color != 6 {
        return None;
    }
    if width < 1 || height < 1 || width > THUMB_MAX_EDGE || height > THUMB_MAX_EDGE {
        return None;
    }
    Some((width, height, color))
}

pub struct Preview {
    pub thumbnail: Option<Thumbnail>,
    pub summary: Option<Summary>,
    /// Present only when the scan finished and the geometry could be hashed.
    pub geometry_hash: Option<String>,
}

impl Preview {
    /// The PNG when it belongs to this geometry. A missing or unfinished hash hides it.
    pub fn image(&self) -> Option<&[u8]> {
        let thumb = self.thumbnail.as_ref()?;
        let hash = self.geometry_hash.as_ref()?;
        if hash == &thumb.mesh_hash {
            Some(&thumb.png)
        } else {
            None
        }
    }
}

pub fn read_preview(bytes: &[u8], budget: Duration) -> Preview {
    let mut scan = Scan::new(bytes, budget);
    scan.parse_file();
    let geometry_hash = scan.rows().and_then(|rows| hash_rows(&rows));
    Preview {
        thumbnail: scan.thumbnail,
        summary: scan.summary,
        geometry_hash,
    }
}
