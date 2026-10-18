//! FNV-1a 64, the same steps as `fnv1aHex` in `src/slice-action.ts`.
//! The preimage is the one `geometryPreimage` builds.

use crate::number::json_number;

/// 16 lowercase hex digits. Same folding as the TypeScript writer.
pub fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hi: u32 = 0xcbf2_9ce4;
    let mut lo: u32 = 0x8422_2325;
    for &byte in bytes {
        lo ^= u32::from(byte);
        let low = u64::from(lo) * 0x1b3;
        hi = hi
            .wrapping_mul(0x1b3)
            .wrapping_add((low >> 32) as u32)
            .wrapping_add(lo.wrapping_shl(8));
        lo = low as u32;
    }
    format!("{hi:08x}{lo:08x}")
}

#[derive(Clone, Debug)]
pub struct Placement {
    pub scale: f64,
    pub centered: bool,
    pub step_tolerance: f64,
    pub orient: [f64; 9],
    pub offset: [f64; 3],
}

impl Placement {
    pub fn complete(&self) -> bool {
        self.scale.is_finite()
            && self.step_tolerance.is_finite()
            && self.orient.iter().all(|n| n.is_finite())
            && self.offset.iter().all(|n| n.is_finite())
    }
}

#[derive(Clone, Debug)]
pub struct HashRow {
    pub id: String,
    pub mesh_hash: String,
    pub brep_hash: String,
    pub placement: Placement,
}

/// The UTF-8 preimage, or `None` when a number cannot be written the way `JSON.stringify` would.
pub fn preimage(rows: &[HashRow]) -> Option<String> {
    let mut out = String::new();
    for row in rows {
        if !row.placement.complete() {
            return None;
        }
        out.push_str(&row.id);
        out.push('\n');
        out.push_str(&row.mesh_hash);
        out.push('\n');
        out.push_str(&row.brep_hash);
        out.push('\n');
        out.push_str(&json_number(row.placement.scale)?);
        out.push('\n');
        out.push_str(if row.placement.centered {
            "true"
        } else {
            "false"
        });
        out.push('\n');
        out.push_str(&json_number(row.placement.step_tolerance)?);
        out.push('\n');
        for value in row.placement.orient {
            out.push_str(&json_number(value)?);
            out.push('\n');
        }
        for value in row.placement.offset {
            out.push_str(&json_number(value)?);
            out.push('\n');
        }
    }
    Some(out)
}

pub fn hash_rows(rows: &[HashRow]) -> Option<String> {
    Some(fnv1a_hex(preimage(rows)?.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(x: f64) -> Placement {
        Placement {
            scale: 1.0,
            centered: true,
            step_tolerance: 0.05,
            orient: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            offset: [x, 0.0, 0.0],
        }
    }

    #[test]
    fn pinned_preimage_matches_typescript() {
        // `fnv1aHex` of the literal preimage in the design note.
        let text = "part\nabc\n\n1\ntrue\n0.05\n1\n0\n0\n0\n1\n0\n0\n0\n1\n0\n0\n0\n";
        assert_eq!(fnv1a_hex(text.as_bytes()), "d7ef30fd8838fa2f");
        let rows = [HashRow {
            id: "part".into(),
            mesh_hash: "abc".into(),
            brep_hash: String::new(),
            placement: place(0.0),
        }];
        assert_eq!(preimage(&rows).as_deref(), Some(text));
    }
}
