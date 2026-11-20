//! Fasteners (docs/plan-mech-parts.md, milestone 1): one primitive, four kinds.
//!
//! Hex nut (ISO 4032), socket-head cap screw (ISO 4762), hex-head screw (ISO 4017) and washer
//! (ISO 7089). Every standard size is a row in the table below. The kernel does not compute a
//! wrench size, a head, or a tap drill from the nominal. The shank of a screw is the major
//! diameter, which the row stores, and it is plain: this milestone has no thread.

use super::ffi::lime_tree_boolean;
use super::ops::{Primitive, Solid};
use super::shape::Shape;

/// A cut that must break a face extends this far past it. Boolean clearance, not a standard size.
const OVERSHOOT_MM: f64 = 0.2;

const MAX_HEIGHT_MM: f64 = 1000.0;

/// ISO 4032 style 1. `pitch` is the published coarse pitch; `drill` is the stored tap drill, not `nominal - pitch`.
struct NutRow {
    nominal: &'static str,
    #[allow(dead_code)]
    pitch: f64,
    s: f64,
    m: f64,
    drill: f64,
}

/// ISO 4762. `major` is the shank diameter (the nominal's major diameter), stored beside the head.
struct SocketRow {
    nominal: &'static str,
    major: f64,
    dk: f64,
    k: f64,
    s: f64,
    t: f64,
}

/// ISO 4017 head. `major` is the plain shank's diameter.
struct HexRow {
    nominal: &'static str,
    major: f64,
    s: f64,
    k: f64,
}

/// ISO 7089 normal series, grade A.
struct WasherRow {
    nominal: &'static str,
    d1: f64,
    d2: f64,
    h: f64,
}

const NUTS: &[NutRow] = &[
    NutRow {
        nominal: "M3",
        pitch: 0.5,
        s: 5.5,
        m: 2.4,
        drill: 2.5,
    },
    NutRow {
        nominal: "M4",
        pitch: 0.7,
        s: 7.0,
        m: 3.2,
        drill: 3.3,
    },
    NutRow {
        nominal: "M5",
        pitch: 0.8,
        s: 8.0,
        m: 4.7,
        drill: 4.2,
    },
    NutRow {
        nominal: "M6",
        pitch: 1.0,
        s: 10.0,
        m: 5.2,
        drill: 5.0,
    },
    NutRow {
        nominal: "M8",
        pitch: 1.25,
        s: 13.0,
        m: 6.8,
        drill: 6.8,
    },
    NutRow {
        nominal: "M10",
        pitch: 1.5,
        s: 16.0,
        m: 8.4,
        drill: 8.5,
    },
    NutRow {
        nominal: "M12",
        pitch: 1.75,
        s: 18.0,
        m: 10.8,
        drill: 10.2,
    },
    NutRow {
        nominal: "M16",
        pitch: 2.0,
        s: 24.0,
        m: 14.8,
        drill: 14.0,
    },
    NutRow {
        nominal: "M20",
        pitch: 2.5,
        s: 30.0,
        m: 18.0,
        drill: 17.5,
    },
    NutRow {
        nominal: "M24",
        pitch: 3.0,
        s: 36.0,
        m: 21.5,
        drill: 21.0,
    },
];

const SOCKETS: &[SocketRow] = &[
    SocketRow {
        nominal: "M3",
        major: 3.0,
        dk: 5.5,
        k: 3.0,
        s: 2.5,
        t: 1.3,
    },
    SocketRow {
        nominal: "M4",
        major: 4.0,
        dk: 7.0,
        k: 4.0,
        s: 3.0,
        t: 2.0,
    },
    SocketRow {
        nominal: "M5",
        major: 5.0,
        dk: 8.5,
        k: 5.0,
        s: 4.0,
        t: 2.5,
    },
    SocketRow {
        nominal: "M6",
        major: 6.0,
        dk: 10.0,
        k: 6.0,
        s: 5.0,
        t: 3.0,
    },
    SocketRow {
        nominal: "M8",
        major: 8.0,
        dk: 13.0,
        k: 8.0,
        s: 6.0,
        t: 4.0,
    },
    SocketRow {
        nominal: "M10",
        major: 10.0,
        dk: 16.0,
        k: 10.0,
        s: 8.0,
        t: 5.0,
    },
    SocketRow {
        nominal: "M12",
        major: 12.0,
        dk: 18.0,
        k: 12.0,
        s: 10.0,
        t: 6.0,
    },
    SocketRow {
        nominal: "M16",
        major: 16.0,
        dk: 24.0,
        k: 16.0,
        s: 14.0,
        t: 8.0,
    },
    SocketRow {
        nominal: "M20",
        major: 20.0,
        dk: 30.0,
        k: 20.0,
        s: 17.0,
        t: 10.0,
    },
    SocketRow {
        nominal: "M24",
        major: 24.0,
        dk: 36.0,
        k: 24.0,
        s: 19.0,
        t: 12.0,
    },
];

const HEXES: &[HexRow] = &[
    HexRow {
        nominal: "M3",
        major: 3.0,
        s: 5.5,
        k: 2.0,
    },
    HexRow {
        nominal: "M4",
        major: 4.0,
        s: 7.0,
        k: 2.8,
    },
    HexRow {
        nominal: "M5",
        major: 5.0,
        s: 8.0,
        k: 3.5,
    },
    HexRow {
        nominal: "M6",
        major: 6.0,
        s: 10.0,
        k: 4.0,
    },
    HexRow {
        nominal: "M8",
        major: 8.0,
        s: 13.0,
        k: 5.3,
    },
    HexRow {
        nominal: "M10",
        major: 10.0,
        s: 16.0,
        k: 6.4,
    },
    HexRow {
        nominal: "M12",
        major: 12.0,
        s: 18.0,
        k: 7.5,
    },
    HexRow {
        nominal: "M16",
        major: 16.0,
        s: 24.0,
        k: 10.0,
    },
    HexRow {
        nominal: "M20",
        major: 20.0,
        s: 30.0,
        k: 12.5,
    },
    HexRow {
        nominal: "M24",
        major: 24.0,
        s: 36.0,
        k: 15.0,
    },
];

const WASHERS: &[WasherRow] = &[
    WasherRow {
        nominal: "M3",
        d1: 3.2,
        d2: 7.0,
        h: 0.5,
    },
    WasherRow {
        nominal: "M4",
        d1: 4.3,
        d2: 9.0,
        h: 0.8,
    },
    WasherRow {
        nominal: "M5",
        d1: 5.3,
        d2: 10.0,
        h: 1.0,
    },
    WasherRow {
        nominal: "M6",
        d1: 6.4,
        d2: 12.0,
        h: 1.6,
    },
    WasherRow {
        nominal: "M8",
        d1: 8.4,
        d2: 16.0,
        h: 1.6,
    },
    WasherRow {
        nominal: "M10",
        d1: 10.5,
        d2: 20.0,
        h: 2.0,
    },
    WasherRow {
        nominal: "M12",
        d1: 13.0,
        d2: 24.0,
        h: 2.5,
    },
    WasherRow {
        nominal: "M16",
        d1: 17.0,
        d2: 30.0,
        h: 3.0,
    },
    WasherRow {
        nominal: "M20",
        d1: 21.0,
        d2: 37.0,
        h: 3.0,
    },
    WasherRow {
        nominal: "M24",
        d1: 25.0,
        d2: 44.0,
        h: 4.0,
    },
];

#[derive(Clone, Copy)]
enum Kind {
    Nut,
    Socket,
    Hex,
    Washer,
}

impl Kind {
    fn table(self) -> &'static str {
        match self {
            Kind::Nut => "ISO 4032 style 1 hex nut table",
            Kind::Socket => "ISO 4762 socket head cap screw table",
            Kind::Hex => "ISO 4017 hex head screw table",
            Kind::Washer => "ISO 7089 washer table",
        }
    }
}

/// `v` turned by `turn` degrees about X, then Y, then Z, as a primitive turns.
fn turned(v: [f64; 3], turn: [f64; 3]) -> [f64; 3] {
    let (sx, cx) = turn[0].to_radians().sin_cos();
    let (sy, cy) = turn[1].to_radians().sin_cos();
    let (sz, cz) = turn[2].to_radians().sin_cos();
    let v = [v[0], v[1] * cx - v[2] * sx, v[1] * sx + v[2] * cx];
    let v = [v[0] * cy + v[2] * sy, v[1], -v[0] * sy + v[2] * cy];
    [v[0] * cz - v[1] * sz, v[0] * sz + v[1] * cz, v[2]]
}

/// Where a piece stands so that Open CASCADE's turn about that piece's own midpoint is the part's turn about its centre.
fn place(part: &Solid, centre_z: f64, base_z: f64, height: f64) -> ([f64; 3], [f64; 3]) {
    let mid_z = base_z + height * 0.5;
    let delta = turned([0.0, 0.0, mid_z - centre_z], part.turn);
    let centre = [part.origin[0], part.origin[1], part.origin[2] + centre_z];
    let mid = [
        centre[0] + delta[0],
        centre[1] + delta[1],
        centre[2] + delta[2],
    ];
    ([mid[0], mid[1], mid[2] - height * 0.5], part.turn)
}

fn kind_of(solid: &Solid) -> Result<Kind, String> {
    match solid.part_kind.as_deref().map(str::trim) {
        Some("nut") => Ok(Kind::Nut),
        Some("socket") => Ok(Kind::Socket),
        Some("hex") => Ok(Kind::Hex),
        Some("washer") => Ok(Kind::Washer),
        _ => Err("A part needs a kind: nut, socket, hex, or washer.".into()),
    }
}

fn nominal_of(solid: &Solid) -> String {
    let text = solid.nominal.as_deref().unwrap_or("").trim();
    if text.is_empty() {
        "M6".to_string()
    } else {
        text.to_string()
    }
}

fn missing(nominal: &str, kind: Kind) -> String {
    format!("{nominal} is not in the {}.", kind.table())
}

/// A positive override, or none when the field is absent or 0 (the table row).
fn override_mm(value: Option<f64>, name: &str) -> Result<Option<f64>, String> {
    match value {
        None => Ok(None),
        Some(0.0) => Ok(None),
        Some(v) if v.is_finite() && v > 0.0 && v <= MAX_HEIGHT_MM => Ok(Some(v)),
        Some(_) => Err(format!("The {name} must be above 0 mm.")),
    }
}

/// `height` 0 is the table row. A positive height replaces that row's height.
fn table_height(height: f64) -> Result<Option<f64>, String> {
    if height == 0.0 {
        return Ok(None);
    }
    if height.is_finite() && height > 0.0 && height <= MAX_HEIGHT_MM {
        return Ok(Some(height));
    }
    Err("The height is 0 for the table row, or above 0 and at most 1000 mm.".into())
}

fn length_of(solid: &Solid, default: f64) -> Result<f64, String> {
    let length = solid.length.unwrap_or(default);
    if length.is_finite() && (0.0..=200.0).contains(&length) {
        Ok(length)
    } else {
        Err("The length under the head is from 0 to 200 mm.".into())
    }
}

fn allowance_of(solid: &Solid) -> Result<f64, String> {
    let allowance = solid.allowance.unwrap_or(0.0);
    if allowance.is_finite() && allowance >= 0.0 {
        Ok(allowance)
    } else {
        Err("The allowance is from 0 to 1 mm.".into())
    }
}

fn set_positive(value: Option<f64>) -> bool {
    value.is_some_and(|v| v != 0.0)
}

fn refuse_bore(solid: &Solid, kind: Kind) -> Result<(), String> {
    match solid.bore_kind.as_deref().map(str::trim) {
        None | Some("") => Ok(()),
        Some("thread") => Err("A modelled thread is not available yet. Use tap drill.".into()),
        Some("tap") if matches!(kind, Kind::Nut) => Ok(()),
        Some("tap") => Err("Only a nut takes a bore.".into()),
        Some(_) => Err("The bore is tap, or thread when a modelled thread exists.".into()),
    }
}

fn refuse_stray(solid: &Solid, kind: Kind) -> Result<(), String> {
    if matches!(kind, Kind::Nut | Kind::Washer) && solid.length.is_some() {
        return Err(match kind {
            Kind::Nut => "A nut has no length under a head.".into(),
            _ => "A washer has no length under a head.".into(),
        });
    }
    if matches!(kind, Kind::Socket | Kind::Hex) && solid.allowance.is_some() {
        return Err(match kind {
            Kind::Socket => "A socket screw has no allowance.".into(),
            _ => "A hex screw has no allowance.".into(),
        });
    }
    if !matches!(kind, Kind::Socket) && set_positive(solid.head_diameter) {
        return Err("Only a socket screw takes a head diameter.".into());
    }
    if !matches!(kind, Kind::Socket) && set_positive(solid.head_height) {
        return Err("Only a socket screw takes a head height.".into());
    }
    if !matches!(kind, Kind::Socket) && set_positive(solid.socket_depth) {
        return Err("Only a socket screw takes a socket depth.".into());
    }
    Ok(())
}

fn cylinder(origin: [f64; 3], turn: [f64; 3], radius: f64, height: f64) -> Solid {
    Solid {
        primitive: Primitive::Cylinder,
        origin,
        radius,
        height,
        turn,
        ..Solid::default()
    }
}

fn hex_prism(origin: [f64; 3], turn: [f64; 3], across: f64, height: f64) -> Solid {
    Solid {
        primitive: Primitive::Polygon,
        origin,
        height,
        turn,
        sides: Some(6.0),
        across: Some(across),
        flats: Some(true),
        ..Solid::default()
    }
}

fn tube(origin: [f64; 3], turn: [f64; 3], outer: f64, inner: f64, height: f64) -> Solid {
    Solid {
        primitive: Primitive::Tube,
        origin,
        radius: outer,
        inner_radius: Some(inner),
        height,
        turn,
        ..Solid::default()
    }
}

fn combine(from: Shape, op: &std::ffi::CStr, tool: &Solid) -> Result<Shape, String> {
    let p = tool.numbers();
    Shape::made(|error| unsafe {
        lime_tree_boolean(
            from.raw(),
            op.as_ptr(),
            tool.primitive.name().as_ptr(),
            p.as_ptr(),
            0,
            error,
        )
    })
}

fn build_nut(solid: &Solid) -> Result<Shape, String> {
    let nominal = nominal_of(solid);
    let Some(row) = NUTS.iter().find(|row| row.nominal == nominal) else {
        return Err(missing(&nominal, Kind::Nut));
    };
    let allowance = allowance_of(solid)?;
    let m = table_height(solid.height)?.unwrap_or(row.m);
    let hole = row.drill + allowance;
    // The wall check comes before the 0-to-1 range, so an allowance that opens the hex says so.
    if hole >= row.s {
        return Err("The allowance leaves no wall on this nut.".into());
    }
    if allowance > 1.0 {
        return Err("The allowance is from 0 to 1 mm.".into());
    }
    let centre_z = m * 0.5;
    let (origin, turn) = place(solid, centre_z, 0.0, m);
    let body = Shape::primitive(&hex_prism(origin, turn, row.s, m))?;
    let hole_h = m + 2.0 * OVERSHOOT_MM;
    let (hole_at, hole_turn) = place(solid, centre_z, -OVERSHOOT_MM, hole_h);
    combine(
        body,
        c"cut",
        &cylinder(hole_at, hole_turn, hole * 0.5, hole_h),
    )
}

fn build_socket(solid: &Solid) -> Result<Shape, String> {
    let nominal = nominal_of(solid);
    let Some(row) = SOCKETS.iter().find(|row| row.nominal == nominal) else {
        return Err(missing(&nominal, Kind::Socket));
    };
    let length = length_of(solid, 25.0)?;
    let from_height = table_height(solid.height)?;
    let from_field = override_mm(solid.head_height, "head height")?;
    let k = match (from_height, from_field) {
        (Some(a), Some(b)) if (a - b).abs() > 1e-9 => {
            return Err("Give the socket's head height once.".into());
        }
        (Some(a), _) => a,
        (None, Some(a)) => a,
        (None, None) => row.k,
    };
    let dk = override_mm(solid.head_diameter, "head diameter")?.unwrap_or(row.dk);
    let t = override_mm(solid.socket_depth, "socket depth")?.unwrap_or(row.t);
    if t >= k {
        return Err("The socket depth must be less than the head height.".into());
    }
    let centre_z = (k - length) * 0.5;
    let (head_at, head_turn) = place(solid, centre_z, 0.0, k);
    let head = Shape::primitive(&cylinder(head_at, head_turn, dk * 0.5, k))?;
    // The pocket starts at z = k − t and runs up through the top face. It does not start at z = k.
    let pocket_h = t + OVERSHOOT_MM;
    let (pocket_at, pocket_turn) = place(solid, centre_z, k - t, pocket_h);
    let opened = combine(
        head,
        c"cut",
        &hex_prism(pocket_at, pocket_turn, row.s, pocket_h),
    )?;
    if length == 0.0 {
        return Ok(opened);
    }
    let (shank_at, shank_turn) = place(solid, centre_z, -length, length);
    combine(
        opened,
        c"fuse",
        &cylinder(shank_at, shank_turn, row.major * 0.5, length),
    )
}

fn build_hex(solid: &Solid) -> Result<Shape, String> {
    let nominal = nominal_of(solid);
    let Some(row) = HEXES.iter().find(|row| row.nominal == nominal) else {
        return Err(missing(&nominal, Kind::Hex));
    };
    let length = length_of(solid, 20.0)?;
    let k = table_height(solid.height)?.unwrap_or(row.k);
    let centre_z = (k - length) * 0.5;
    let (head_at, head_turn) = place(solid, centre_z, 0.0, k);
    let head = Shape::primitive(&hex_prism(head_at, head_turn, row.s, k))?;
    if length == 0.0 {
        return Ok(head);
    }
    let (shank_at, shank_turn) = place(solid, centre_z, -length, length);
    combine(
        head,
        c"fuse",
        &cylinder(shank_at, shank_turn, row.major * 0.5, length),
    )
}

fn build_washer(solid: &Solid) -> Result<Shape, String> {
    let nominal = nominal_of(solid);
    let Some(row) = WASHERS.iter().find(|row| row.nominal == nominal) else {
        return Err(missing(&nominal, Kind::Washer));
    };
    let allowance = allowance_of(solid)?;
    let h = table_height(solid.height)?.unwrap_or(row.h);
    let inner = (row.d1 + allowance) * 0.5;
    let outer = row.d2 * 0.5;
    if inner >= outer {
        return Err("The allowance leaves no wall on this washer.".into());
    }
    if allowance > 1.0 {
        return Err("The allowance is from 0 to 1 mm.".into());
    }
    let (origin, turn) = place(solid, h * 0.5, 0.0, h);
    Shape::primitive(&tube(origin, turn, outer, inner, h))
}

/// The fastener `solid` describes, or the one sentence why it is not one.
pub(super) fn build_part(solid: &Solid) -> Result<Shape, String> {
    let kind = kind_of(solid)?;
    refuse_bore(solid, kind)?;
    refuse_stray(solid, kind)?;
    match kind {
        Kind::Nut => build_nut(solid),
        Kind::Socket => build_socket(solid),
        Kind::Hex => build_hex(solid),
        Kind::Washer => build_washer(solid),
    }
}
