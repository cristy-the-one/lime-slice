//! `slice-field-1`: the beads one object's G-code extrudes, as data.
//!
//! The engine builds it from the slicer's `emitted_beads`. This crate only
//! reads it, so the solve path still doesn't link the slicer.
//!
//! The bytes are:
//! - `b"LSF1"`;
//! - a `u32` little-endian length, then that many bytes of UTF-8 JSON, the
//!   [`Header`];
//! - `segmentCount` rows of [`SEGMENT_BYTES`] bytes each, little-endian:
//!   `u32 layer, u8 role, f32 x0 y0 z0 x1 y1 z1, f32 width, f32 beadHeight,
//!   f32 flow`.
//!
//! Points are in the slice frame. `frame` takes them to the part frame.

use serde::{Deserialize, Serialize};

use crate::error::SimError;

pub const FORMAT: &str = "slice-field-1";
const MAGIC: &[u8; 4] = b"LSF1";
/// One segment row: a `u32`, a `u8` and nine `f32`s.
pub const SEGMENT_BYTES: usize = 4 + 1 + 9 * 4;

/// The roles a segment can have, in the order a row's `u8` indexes them.
/// Skirt, supports and ironing carry nothing, so the engine leaves them out.
pub const ROLES: [&str; 10] = [
    "outer",
    "inner",
    "wall",
    "thin-wall",
    "gap-fill",
    "infill",
    "sparse",
    "solid",
    "top",
    "bridge",
];

/// The role's index in [`ROLES`], or `None` for a bead that carries no load.
pub fn role_index(kind: &str) -> Option<u8> {
    ROLES.iter().position(|r| *r == kind).map(|i| i as u8)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerRow {
    pub index: u32,
    pub z_mm: f64,
    pub height_mm: f64,
    pub bead_start: u32,
    pub bead_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    pub format: String,
    /// The slice request's hash: the study's cache key.
    pub slice_hash: String,
    /// Slice frame to part frame, row-major, the last row `[0, 0, 0, 1]`.
    pub frame: [[f64; 4]; 4],
    /// The direction the layers stack in, in the part frame.
    pub layer_normal: [f64; 3],
    pub layers: Vec<LayerRow>,
    pub roles: Vec<String>,
    pub segment_count: u32,
}

/// One extruding segment. `flow` already holds every multiplier the G-code
/// writer applies, so the deposited volume is length × width × height × flow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Segment {
    pub layer: u32,
    pub role: u8,
    pub from: [f32; 3],
    pub to: [f32; 3],
    pub width_mm: f32,
    pub bead_height_mm: f32,
    pub flow: f32,
}

impl Segment {
    pub fn volume_mm3(&self) -> f64 {
        let dx = f64::from(self.to[0]) - f64::from(self.from[0]);
        let dy = f64::from(self.to[1]) - f64::from(self.from[1]);
        let length = dx.hypot(dy);
        length
            * f64::from(self.width_mm)
            * f64::from(self.bead_height_mm).max(0.0)
            * f64::from(self.flow).max(0.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SliceField {
    pub header: Header,
    pub segments: Vec<Segment>,
}

impl SliceField {
    pub fn total_volume_mm3(&self) -> f64 {
        self.segments.iter().map(Segment::volume_mm3).sum()
    }

    pub fn encode(&self) -> Vec<u8> {
        let header = serde_json::to_vec(&self.header).expect("a header serializes");
        let mut out = Vec::with_capacity(8 + header.len() + self.segments.len() * SEGMENT_BYTES);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(&header);
        for s in &self.segments {
            out.extend_from_slice(&s.layer.to_le_bytes());
            out.push(s.role);
            for v in s.from.iter().chain(&s.to) {
                out.extend_from_slice(&v.to_le_bytes());
            }
            for v in [s.width_mm, s.bead_height_mm, s.flow] {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, SimError> {
        let bad = |why: &str| SimError::new(format!("This is not a slice field: {why}."));
        if bytes.len() < 8 || &bytes[..4] != MAGIC {
            return Err(bad("it doesn't start with LSF1"));
        }
        let len = u32::from_le_bytes(bytes[4..8].try_into().expect("4 bytes")) as usize;
        let body = bytes
            .get(8..8 + len)
            .ok_or_else(|| bad("the header is cut short"))?;
        let header: Header =
            serde_json::from_slice(body).map_err(|e| bad(&format!("the header is wrong ({e})")))?;
        if header.format != FORMAT {
            return Err(SimError::new(format!(
                "This slice field is {}, and this version reads {FORMAT}.",
                header.format
            )));
        }
        if header.roles != ROLES {
            return Err(bad("its roles are not this version's"));
        }
        let rows = &bytes[8 + len..];
        let count = header.segment_count as usize;
        if rows.len() != count * SEGMENT_BYTES {
            return Err(bad("the segment rows don't match the header's count"));
        }
        let f = |row: &[u8], at: usize| f32::from_le_bytes(row[at..at + 4].try_into().expect("4"));
        let mut segments = Vec::with_capacity(count);
        for row in rows.chunks_exact(SEGMENT_BYTES) {
            let role = row[4];
            if role as usize >= ROLES.len() {
                return Err(bad("a segment has an unknown role"));
            }
            segments.push(Segment {
                layer: u32::from_le_bytes(row[0..4].try_into().expect("4")),
                role,
                from: [f(row, 5), f(row, 9), f(row, 13)],
                to: [f(row, 17), f(row, 21), f(row, 25)],
                width_mm: f(row, 29),
                bead_height_mm: f(row, 33),
                flow: f(row, 37),
            });
        }
        let mut next = 0u32;
        for layer in &header.layers {
            if layer.bead_start != next {
                return Err(bad("its layers don't cover the segments in order"));
            }
            next += layer.bead_count;
        }
        if next != header.segment_count {
            return Err(bad("its layers don't cover the segments in order"));
        }
        Ok(Self { header, segments })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field() -> SliceField {
        let seg = |layer, role, x0: f32, x1: f32| Segment {
            layer,
            role,
            from: [x0, 0.0, 0.2],
            to: [x1, 0.0, 0.2],
            width_mm: 0.45,
            bead_height_mm: 0.2,
            flow: 1.0,
        };
        SliceField {
            header: Header {
                format: FORMAT.into(),
                slice_hash: "abc".into(),
                frame: [
                    [1.0, 0.0, 0.0, -5.0],
                    [0.0, 1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0, 0.0],
                    [0.0, 0.0, 0.0, 1.0],
                ],
                layer_normal: [0.0, 0.0, 1.0],
                layers: vec![
                    LayerRow {
                        index: 0,
                        z_mm: 0.2,
                        height_mm: 0.2,
                        bead_start: 0,
                        bead_count: 2,
                    },
                    LayerRow {
                        index: 1,
                        z_mm: 0.4,
                        height_mm: 0.2,
                        bead_start: 2,
                        bead_count: 1,
                    },
                ],
                roles: ROLES.iter().map(|r| r.to_string()).collect(),
                segment_count: 3,
            },
            segments: vec![
                seg(0, 0, 0.0, 10.0),
                seg(0, 6, 0.0, 5.0),
                seg(1, 9, 1.0, 3.0),
            ],
        }
    }

    #[test]
    fn a_field_reads_back_as_written() {
        let field = field();
        let bytes = field.encode();
        let header_len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        assert_eq!(bytes.len(), 8 + header_len + 3 * SEGMENT_BYTES);
        let back = SliceField::decode(&bytes).unwrap();
        assert_eq!(back, field);
        let expect = (10.0 + 5.0 + 2.0) * 0.45 * 0.2;
        assert!((back.total_volume_mm3() - expect).abs() < 1e-6);
    }

    #[test]
    fn a_damaged_field_is_a_sentence() {
        let bytes = field().encode();
        let err = SliceField::decode(&bytes[..bytes.len() - 1]).unwrap_err();
        assert_eq!(
            err.message,
            "This is not a slice field: the segment rows don't match the header's count."
        );
        let err = SliceField::decode(b"GCODE;").unwrap_err();
        assert_eq!(
            err.message,
            "This is not a slice field: it doesn't start with LSF1."
        );
        let mut other = field();
        other.header.format = "slice-field-2".into();
        let err = SliceField::decode(&other.encode()).unwrap_err();
        assert_eq!(
            err.message,
            "This slice field is slice-field-2, and this version reads slice-field-1."
        );
    }

    #[test]
    fn skirt_supports_and_ironing_have_no_role() {
        for kind in ["skirt", "support", "support-interface", "ironing"] {
            assert_eq!(role_index(kind), None, "{kind}");
        }
        assert_eq!(role_index("bridge"), Some(9));
    }
}
