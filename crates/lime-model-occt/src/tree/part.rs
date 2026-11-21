//! Parts (docs/plan-mech-parts.md): one primitive, a `partKind`.
//!
//! Fasteners: hex nut (ISO 4032), socket-head cap screw (ISO 4762), hex-head screw (ISO 4017) and
//! washer (ISO 7089). Every standard size is a row in the table below. The kernel does not compute a
//! wrench size, a head, or a tap drill from the nominal. The shank of a screw is the major
//! diameter, which the row stores, and it is plain: this milestone has no thread.
//!
//! Fittings: spacer, shaft, collar, and heat-set boss. A shaft's diameter is
//! `lime_recipe::horology::shaft`; the clearance table is not copied here.

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

/// ISO 273 medium clearance (section 4.8). The drilled hole is this plus the allowance.
struct Clearance {
    nominal: &'static str,
    hole: f64,
}

const CLEARANCE: [Clearance; 10] = [
    Clearance { nominal: "M3", hole: 3.4 },
    Clearance { nominal: "M4", hole: 4.5 },
    Clearance { nominal: "M5", hole: 5.5 },
    Clearance { nominal: "M6", hole: 6.6 },
    Clearance { nominal: "M8", hole: 9.0 },
    Clearance { nominal: "M10", hole: 11.0 },
    Clearance { nominal: "M12", hole: 13.5 },
    Clearance { nominal: "M16", hole: 17.5 },
    Clearance { nominal: "M20", hole: 22.0 },
    Clearance { nominal: "M24", hole: 26.0 },
];

#[derive(Clone, Copy)]
enum Kind {
    Nut,
    Socket,
    Hex,
    Washer,
    Spacer,
    Shaft,
    Collar,
    Heat,
    Plate,
    Bracket,
}

impl Kind {
    fn table(self) -> &'static str {
        match self {
            Kind::Nut => "ISO 4032 style 1 hex nut table",
            Kind::Socket => "ISO 4762 socket head cap screw table",
            Kind::Hex => "ISO 4017 hex head screw table",
            Kind::Washer => "ISO 7089 washer table",
            Kind::Spacer | Kind::Shaft | Kind::Collar | Kind::Heat | Kind::Plate | Kind::Bracket => "part",
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
        Some("spacer") => Ok(Kind::Spacer),
        Some("shaft") => Ok(Kind::Shaft),
        Some("collar") => Ok(Kind::Collar),
        Some("heat-set") => Ok(Kind::Heat),
        Some("plate") => Ok(Kind::Plate),
        Some("bracket") => Ok(Kind::Bracket),
        _ => Err("A part needs a kind: nut, socket, hex, washer, spacer, shaft, collar, heat-set, plate, or bracket.".into()),
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

fn text_set(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|text| !text.trim().is_empty())
}

fn refuse_stray(solid: &Solid, kind: Kind) -> Result<(), String> {
    if matches!(kind, Kind::Plate | Kind::Bracket) {
        return refuse_bracket_stray(solid, kind);
    }
    if text_set(&solid.hole_for) {
        return Err("Only a plate or an L-bracket takes a hole for.".into());
    }
    if solid.holes.is_some() {
        return Err("Only a plate or an L-bracket takes a hole count.".into());
    }
    if solid.pitch_circle.is_some() {
        return Err("Only a plate takes a pitch circle.".into());
    }
    let fastener = matches!(kind, Kind::Nut | Kind::Socket | Kind::Hex | Kind::Washer);
    if matches!(kind, Kind::Nut | Kind::Washer) && solid.length.is_some() {
        return Err(match kind {
            Kind::Nut => "A nut has no length under a head.".into(),
            _ => "A washer has no length under a head.".into(),
        });
    }
    if matches!(kind, Kind::Socket | Kind::Hex | Kind::Spacer | Kind::Collar) && solid.allowance.is_some() {
        return Err(match kind {
            Kind::Socket => "A socket screw has no allowance.".into(),
            Kind::Hex => "A hex screw has no allowance.".into(),
            Kind::Spacer => "A spacer has no allowance.".into(),
            _ => "A collar has no allowance.".into(),
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
    if fastener && solid.diameter.is_some() {
        return Err(match kind {
            Kind::Nut => "A nut has no diameter.".into(),
            Kind::Socket => "A socket screw has no diameter.".into(),
            Kind::Hex => "A hex screw has no diameter.".into(),
            _ => "A washer has no diameter.".into(),
        });
    }
    if fastener && solid.hollow.is_some() {
        return Err("Only a spacer is hollow or solid.".into());
    }
    if fastener && text_set(&solid.fit) {
        return Err("Only a shaft takes a fit.".into());
    }
    if fastener && text_set(&solid.article) {
        return Err("Only a heat-set boss takes an article.".into());
    }
    if fastener && set_positive(solid.taper) {
        return Err("Only a heat-set boss takes a taper.".into());
    }
    if fastener && solid.set_screw.is_some() {
        return Err("Only a collar takes a set screw.".into());
    }
    if !fastener && solid.length.is_some() {
        return Err(match kind {
            Kind::Spacer => "A spacer's length is its height.".into(),
            Kind::Shaft => "A shaft's length is its height.".into(),
            Kind::Collar => "A collar's width is its height.".into(),
            _ => "A heat-set boss's height is its height.".into(),
        });
    }
    if !fastener && text_set(&solid.nominal) {
        return Err(match kind {
            Kind::Spacer => "A spacer has no nominal size.".into(),
            Kind::Shaft => "A shaft's nominal size is its diameter, not a screw size.".into(),
            Kind::Collar => "A collar has no nominal size.".into(),
            _ => "A heat-set boss is chosen by its article, not a screw size.".into(),
        });
    }
    if !matches!(kind, Kind::Spacer | Kind::Collar) && solid.bore.is_some() {
        return Err(match kind {
            Kind::Nut => "A nut has no bore.".into(),
            Kind::Socket => "A socket screw has no bore.".into(),
            Kind::Hex => "A hex screw has no bore.".into(),
            Kind::Washer => "A washer has no bore.".into(),
            Kind::Shaft => "A shaft has no bore.".into(),
            _ => "A heat-set boss's hole comes from its article.".into(),
        });
    }
    if !matches!(kind, Kind::Spacer) && solid.hollow.is_some() {
        return Err("Only a spacer is hollow or solid.".into());
    }
    if !matches!(kind, Kind::Shaft) && text_set(&solid.fit) {
        return Err("Only a shaft takes a fit.".into());
    }
    if !matches!(kind, Kind::Heat) && text_set(&solid.article) {
        return Err("Only a heat-set boss takes an article.".into());
    }
    if !matches!(kind, Kind::Heat) && set_positive(solid.taper) {
        return Err("Only a heat-set boss takes a taper.".into());
    }
    if !matches!(kind, Kind::Collar) && solid.set_screw.is_some() {
        return Err("Only a collar takes a set screw.".into());
    }
    Ok(())
}

fn refuse_bracket_stray(solid: &Solid, kind: Kind) -> Result<(), String> {
    let plate = matches!(kind, Kind::Plate);
    let named = if plate { "A plate" } else { "An L-bracket" };
    if solid.length.is_some() {
        return Err(format!("{named} has no length."));
    }
    if solid.height != 0.0 {
        return Err(format!("{named} has no height."));
    }
    if text_set(&solid.nominal) {
        return Err(format!("{named} has no nominal size."));
    }
    if set_positive(solid.head_diameter) {
        return Err("Only a socket screw takes a head diameter.".into());
    }
    if set_positive(solid.head_height) {
        return Err("Only a socket screw takes a head height.".into());
    }
    if set_positive(solid.socket_depth) {
        return Err("Only a socket screw takes a socket depth.".into());
    }
    if solid.diameter.is_some() {
        return Err(format!("{named} has no diameter."));
    }
    if solid.hollow.is_some() {
        return Err("Only a spacer is hollow or solid.".into());
    }
    if text_set(&solid.fit) {
        return Err("Only a shaft takes a fit.".into());
    }
    if text_set(&solid.article) {
        return Err("Only a heat-set boss takes an article.".into());
    }
    if set_positive(solid.taper) {
        return Err("Only a heat-set boss takes a taper.".into());
    }
    if solid.set_screw.is_some() {
        return Err("Only a collar takes a set screw.".into());
    }
    if !plate && solid.pitch_circle.is_some() {
        return Err("Only a plate takes a pitch circle.".into());
    }
    Ok(())
}

fn in_range(value: f64, lo: f64, hi: f64) -> bool {
    value.is_finite() && value >= lo && value <= hi
}

/// A tenth of a millimetre when the value needs it, else a whole number.
fn mm(value: f64) -> String {
    let tenths = (value * 10.0).round() / 10.0;
    format_tenth(tenths)
}

/// A minimum, rounded up to the tenth, so the size the sentence names is one the kernel will build.
fn mm_up(value: f64) -> String {
    format_tenth((value * 10.0 - 1e-9).ceil() / 10.0)
}

/// A maximum, rounded down to the tenth.
fn mm_down(value: f64) -> String {
    format_tenth((value * 10.0 + 1e-9).floor() / 10.0)
}

fn format_tenth(tenths: f64) -> String {
    if (tenths - tenths.round()).abs() < 1e-9 {
        format!("{}", tenths.round() as i64)
    } else {
        format!("{tenths:.1}")
    }
}

/// `R = Rz Ry Rx`, row-major, applied to a column.
fn turn_matrix(turn: [f64; 3]) -> [f64; 9] {
    let (sx, cx) = turn[0].to_radians().sin_cos();
    let (sy, cy) = turn[1].to_radians().sin_cos();
    let (sz, cz) = turn[2].to_radians().sin_cos();
    [
        cz * cy,
        cz * sy * sx - sz * cx,
        cz * sy * cx + sz * sx,
        sz * cy,
        sz * sy * sx + cz * cx,
        sz * sy * cx - cz * sx,
        -sy,
        cy * sx,
        cy * cx,
    ]
}

fn mat_mul(a: [f64; 9], b: [f64; 9]) -> [f64; 9] {
    let mut out = [0.0; 9];
    for row in 0..3 {
        for col in 0..3 {
            out[row * 3 + col] =
                a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
        }
    }
    out
}

fn mat_apply(m: [f64; 9], v: [f64; 3]) -> [f64; 3] {
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]
}

fn euler_of(m: [f64; 9]) -> [f64; 3] {
    let sy = -m[6];
    let cy = (m[0] * m[0] + m[3] * m[3]).sqrt();
    let (rx, ry, rz) = if cy > 1e-8 {
        (m[7].atan2(m[8]), sy.atan2(cy), m[3].atan2(m[0]))
    } else {
        ((-m[5]).atan2(m[4]), sy.atan2(cy), 0.0)
    };
    [rx.to_degrees(), ry.to_degrees(), rz.to_degrees()]
}

/// A cylinder whose midpoint is `local_mid` in the part's frame, its own +Z turned by `local_turn` before the part turns.
fn pose_cylinder(
    part: &Solid,
    centre_z: f64,
    local_mid: [f64; 3],
    local_turn: [f64; 3],
    height: f64,
) -> ([f64; 3], [f64; 3]) {
    let part_r = turn_matrix(part.turn);
    let delta = mat_apply(
        part_r,
        [local_mid[0], local_mid[1], local_mid[2] - centre_z],
    );
    let mid = [
        part.origin[0] + delta[0],
        part.origin[1] + delta[1],
        part.origin[2] + centre_z + delta[2],
    ];
    (
        [mid[0], mid[1], mid[2] - height * 0.5],
        euler_of(mat_mul(part_r, turn_matrix(local_turn))),
    )
}

/// A box whose midpoint is `local_mid`. Its origin is the minimum corner, and the turn is the part's.
fn pose_box(part: &Solid, centre_z: f64, local_mid: [f64; 3], size: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let (at, turn) = pose_cylinder(part, centre_z, local_mid, [0.0, 0.0, 0.0], size[2]);
    let mid = [at[0], at[1], at[2] + size[2] * 0.5];
    (
        [
            mid[0] - size[0] * 0.5,
            mid[1] - size[1] * 0.5,
            mid[2] - size[2] * 0.5,
        ],
        turn,
    )
}

fn block(origin: [f64; 3], turn: [f64; 3], size: [f64; 3]) -> Solid {
    Solid {
        primitive: Primitive::Box,
        origin,
        size,
        turn,
        ..Solid::default()
    }
}

fn cone(origin: [f64; 3], turn: [f64; 3], radius: f64, top: f64, height: f64) -> Solid {
    Solid {
        primitive: Primitive::Cone,
        origin,
        radius,
        top_radius: Some(top),
        height,
        turn,
        ..Solid::default()
    }
}

/// Ruthex RX, the 14.12.2023 Produktdatenblatt (docs/plan-mech-parts.md §4.10). `d2` is the lead-in; the boss is a cone.
struct HeatRow {
    article: &'static str,
    d1: f64,
    #[allow(dead_code)]
    d2: f64,
    l: f64,
    w: f64,
    d3: f64,
}

const HEAT: &[HeatRow] = &[
    HeatRow { article: "RX-M2x4", d1: 3.6, d2: 3.1, l: 4.0, w: 1.3, d3: 3.2 },
    HeatRow { article: "RX-M2,5x5,7", d1: 4.6, d2: 3.9, l: 5.7, w: 1.6, d3: 4.0 },
    HeatRow { article: "RX-M3Sx4,0", d1: 4.6, d2: 3.9, l: 4.0, w: 1.6, d3: 4.0 },
    HeatRow { article: "RX-M3x5x4", d1: 5.0, d2: 4.25, l: 4.0, w: 1.3, d3: 4.4 },
    HeatRow { article: "RX-M3x5,7", d1: 4.6, d2: 3.9, l: 5.7, w: 1.6, d3: 4.0 },
    HeatRow { article: "RX-M4Sx4,0", d1: 6.3, d2: 5.5, l: 4.0, w: 2.1, d3: 5.6 },
    HeatRow { article: "RX-M4x8,1", d1: 6.3, d2: 5.5, l: 8.1, w: 2.1, d3: 5.6 },
    HeatRow { article: "RX-M5Sx5,8", d1: 7.1, d2: 6.3, l: 5.8, w: 2.6, d3: 6.4 },
    HeatRow { article: "RX-M5x9,5", d1: 7.1, d2: 6.3, l: 9.5, w: 2.6, d3: 6.4 },
    HeatRow { article: "RX-M6x12,7", d1: 8.7, d2: 7.9, l: 12.7, w: 3.3, d3: 8.0 },
    HeatRow { article: "RX-M8x12,7", d1: 10.1, d2: 9.5, l: 12.7, w: 4.5, d3: 9.6 },
];

fn build_spacer(solid: &Solid) -> Result<Shape, String> {
    let od = solid.diameter.unwrap_or(10.0);
    let length = if solid.height == 0.0 { 12.0 } else { solid.height };
    let hole = solid.bore.unwrap_or(4.2);
    let hollow = solid.hollow.unwrap_or(true);
    if !in_range(od, 3.0, 80.0) {
        return Err("The outside diameter is from 3 to 80 mm.".into());
    }
    if !in_range(length, 1.0, 200.0) {
        return Err("The length is from 1 to 200 mm.".into());
    }
    if !in_range(hole, 0.0, 79.0) {
        return Err("The hole is from 0 to 79 mm.".into());
    }
    if hollow && hole >= od {
        return Err("The hole is at least as wide as the outside diameter. Turn hollow off, or use a smaller hole.".into());
    }
    let (origin, turn) = place(solid, length * 0.5, 0.0, length);
    if hollow && hole > 0.0 && hole <= od - 0.4 {
        return Shape::primitive(&tube(origin, turn, od * 0.5, hole * 0.5, length));
    }
    Shape::primitive(&cylinder(origin, turn, od * 0.5, length))
}

fn shaft_fit(solid: &Solid) -> Result<lime_recipe::horology::Fit, String> {
    match solid.fit.as_deref().map(str::trim).map(|text| text.to_ascii_lowercase()).as_deref() {
        None | Some("") | Some("sliding") => Ok(lime_recipe::horology::Fit::Sliding),
        Some("running") => Ok(lime_recipe::horology::Fit::Running),
        Some("press") => Ok(lime_recipe::horology::Fit::Press),
        Some(_) => Err("The fit is running, sliding, or press.".into()),
    }
}

fn build_shaft(solid: &Solid) -> Result<Shape, String> {
    let nominal = solid.diameter.unwrap_or(8.0);
    let length = if solid.height == 0.0 { 40.0 } else { solid.height };
    let allowance = solid.allowance.unwrap_or(0.1);
    if !in_range(length, 5.0, 300.0) {
        return Err("The length is from 5 to 300 mm.".into());
    }
    if !(allowance.is_finite() && (0.0..=0.5).contains(&allowance)) {
        return Err("The allowance is from 0 to 0.5 mm.".into());
    }
    let fit = shaft_fit(solid)?;
    // None is the crate's limit: over 0 to 30 mm. A nominal inside that and under 2 mm is this card's range.
    let Some(diameter) = lime_recipe::horology::shaft(nominal, fit, allowance) else {
        return Err("A printed shaft is only defined over 0 to 30 mm.".into());
    };
    if !(2.0..=30.0).contains(&nominal) {
        return Err("A shaft's nominal diameter is from 2 to 30 mm.".into());
    }
    if diameter <= 0.0 {
        return Err("The allowance leaves no shaft.".into());
    }
    let (origin, turn) = place(solid, length * 0.5, 0.0, length);
    Shape::primitive(&cylinder(origin, turn, diameter * 0.5, length))
}

fn build_collar(solid: &Solid) -> Result<Shape, String> {
    let bore = solid.bore.unwrap_or(8.0);
    let od = solid.diameter.unwrap_or(14.0);
    let width = if solid.height == 0.0 { 6.0 } else { solid.height };
    let screw = solid.set_screw.unwrap_or(3.0);
    if !in_range(bore, 3.0, 25.0) {
        return Err("The bore is from 3 to 25 mm.".into());
    }
    if !in_range(od, 6.0, 40.0) {
        return Err("The outside diameter is from 6 to 40 mm.".into());
    }
    if od < bore + 2.0 {
        return Err(format!(
            "The outside diameter must be at least {} mm, 2 mm above the bore.",
            mm_up(bore + 2.0)
        ));
    }
    if !in_range(width, 3.0, 15.0) {
        return Err("The width is from 3 to 15 mm.".into());
    }
    if !in_range(screw, 2.0, 6.0) {
        return Err("The set screw is from 2 to 6 mm.".into());
    }
    // 0.5 mm of the width stays on each side of the screw: diameter ≤ width − 1.
    if screw > width - 1.0 {
        return Err(format!(
            "The set screw must be at most {} mm so 0.5 mm of the collar stays on each side.",
            mm_down(width - 1.0)
        ));
    }
    let centre_z = width * 0.5;
    let (origin, turn) = place(solid, centre_z, 0.0, width);
    let body = Shape::primitive(&tube(origin, turn, od * 0.5, bore * 0.5, width))?;
    // From the outer surface along −Y, through the wall and 0.2 mm into the bore.
    let depth = (od - bore) * 0.5 + OVERSHOOT_MM;
    let (screw_at, screw_turn) = pose_cylinder(
        solid,
        centre_z,
        [0.0, od * 0.5 - depth * 0.5, width * 0.5],
        [90.0, 0.0, 0.0],
        depth,
    );
    let opened = combine(
        body,
        c"cut",
        &cylinder(screw_at, screw_turn, screw * 0.5, depth),
    )?;
    // The slit is centred on −Y, opposite the set screw. It breaks the bore, the outside, and both side faces.
    let slit_y = (od - bore) * 0.5 + 2.0 * OVERSHOOT_MM;
    let slit_z = width + 2.0 * OVERSHOOT_MM;
    let slit = [0.6, slit_y, slit_z];
    let (slit_at, slit_turn) = pose_box(
        solid,
        centre_z,
        [0.0, -((od + bore) * 0.25), width * 0.5],
        slit,
    );
    combine(opened, c"cut", &block(slit_at, slit_turn, slit))
}

fn build_heat(solid: &Solid) -> Result<Shape, String> {
    let name = solid
        .article
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("RX-M3x5,7");
    let Some(row) = HEAT.iter().find(|row| row.article == name) else {
        return Err(format!("{name} is not in the Ruthex RX table."));
    };
    let min_od = row.d1 + 2.0 * row.w;
    let boss = solid.diameter.unwrap_or(min_od);
    let height = if solid.height == 0.0 { row.l } else { solid.height };
    let taper = solid.taper.unwrap_or(0.0);
    let allowance = solid.allowance.unwrap_or(0.0);
    if !(allowance.is_finite() && (0.0..=1.0).contains(&allowance)) {
        return Err("The allowance is from 0 to 1 mm.".into());
    }
    if !(taper.is_finite() && (0.0..=2.0).contains(&taper)) {
        return Err("The taper is from 0 to 2 mm.".into());
    }
    if !boss.is_finite() || boss > 1000.0 {
        return Err("The boss diameter is at most 1000 mm.".into());
    }
    // A boss under the sheet's minimum wall is named before the taper, which asks for a wider one.
    if boss < min_od - 1e-9 {
        return Err(format!(
            "The boss must be at least {} mm across, the insert's outside plus twice the minimum wall.",
            mm_up(min_od)
        ));
    }
    if !(height.is_finite() && height + 1e-9 >= row.l && height <= 40.0) {
        return Err(format!("The height is from {} to 40 mm.", mm_up(row.l)));
    }
    // Ruthex's minimum wall applies at the top too: the top diameter is the boss less the taper.
    let top = boss - taper;
    if top < min_od - 1e-9 {
        return Err(format!(
            "A taper of {} mm needs a boss at least {} mm across.",
            mm(taper),
            mm_up(min_od + taper)
        ));
    }
    let hole = row.d3 + allowance;
    if hole >= top - 1e-9 {
        return Err(format!(
            "A taper of {} mm needs a boss at least {} mm across.",
            mm(taper),
            mm_up(hole + taper)
        ));
    }
    let (origin, turn) = place(solid, height * 0.5, 0.0, height);
    let body = Shape::primitive(&cone(origin, turn, boss * 0.5, top * 0.5, height))?;
    let hole_h = height + 2.0 * OVERSHOOT_MM;
    let (hole_at, hole_turn) = place(solid, height * 0.5, -OVERSHOOT_MM, hole_h);
    combine(
        body,
        c"cut",
        &cylinder(hole_at, hole_turn, hole * 0.5, hole_h),
    )
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

/// 0 is the default. Any other entry is the size the caller asked for.
fn axis_or(value: f64, default: f64) -> f64 {
    if value == 0.0 { default } else { value }
}

fn whole_count(value: f64) -> Option<i32> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= i32::MAX as f64 {
        Some(value as i32)
    } else {
        None
    }
}

enum HoleChoice {
    Screw(f64),
    Free,
}

fn hole_choice(solid: &Solid) -> Result<HoleChoice, String> {
    let text = solid
        .hole_for
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("M4");
    if text == "free" {
        return Ok(HoleChoice::Free);
    }
    if let Some(row) = CLEARANCE.iter().find(|row| row.nominal == text) {
        return Ok(HoleChoice::Screw(row.hole));
    }
    Err("Hole for is M3, M4, M5, M6, M8, M10, M12, M16, M20, M24, or free.".into())
}

fn drilled(solid: &Solid, choice: HoleChoice) -> Result<f64, String> {
    match choice {
        HoleChoice::Free => {
            if solid.allowance.is_some() {
                return Err("A free diameter has no allowance; it is the hole's size.".into());
            }
            let diameter = solid.bore.unwrap_or(4.7);
            if !in_range(diameter, 2.0, 30.0) {
                return Err("The free diameter is from 2 to 30 mm.".into());
            }
            Ok(diameter)
        }
        HoleChoice::Screw(clearance) => {
            if solid.bore.is_some() {
                return Err("A screw's hole comes from the clearance table.".into());
            }
            let allowance = solid.allowance.unwrap_or(0.2);
            if !(allowance.is_finite() && (0.0..=1.0).contains(&allowance)) {
                return Err("The allowance is from 0 to 1 mm.".into());
            }
            Ok(clearance + allowance)
        }
    }
}

fn count_of(value: Option<f64>, default: i32, max: i32, sentence: &str) -> Result<i32, String> {
    let n = match value {
        None => default,
        Some(raw) => match whole_count(raw) {
            Some(n) => n,
            None => return Err(sentence.into()),
        },
    };
    if (0..=max).contains(&n) { Ok(n) } else { Err(sentence.into()) }
}

fn plate_walls(n: i32, d: f64, width: f64, depth: f64, pitch: f64) -> Result<(), String> {
    if n <= 0 {
        return Ok(());
    }
    if pitch > 0.0 {
        let max_p = width.min(depth) - d - 2.0;
        if pitch > max_p + 1e-9 {
            return Err(format!(
                "The pitch circle is at most {} mm on this plate.",
                mm_down(max_p)
            ));
        }
        if n >= 2 {
            let min_p = (d + 1.0) / (std::f64::consts::PI / n as f64).sin();
            if pitch + 1e-9 < min_p {
                return Err(format!(
                    "{} holes of {} mm need a pitch circle of at least {} mm.",
                    n,
                    mm(d),
                    mm_up(min_p)
                ));
            }
        }
        return Ok(());
    }
    let inset = 8.0_f64.max(d);
    if n == 1 {
        if width + 1e-9 < d + 2.0 {
            return Err(format!(
                "A {} mm hole needs a plate at least {} mm wide.",
                mm(d),
                mm_up(d + 2.0)
            ));
        }
        if depth + 1e-9 < d + 2.0 {
            return Err(format!(
                "A {} mm hole needs a plate at least {} mm deep.",
                mm(d),
                mm_up(d + 2.0)
            ));
        }
        return Ok(());
    }
    let k = (n + 1) / 2;
    if k >= 2 {
        let need = 2.0 * inset + (k as f64 - 1.0) * (d + 1.0);
        if width + 1e-9 < need {
            return Err(format!(
                "{} holes of {} mm in a row need a plate at least {} mm wide.",
                k,
                mm(d),
                mm_up(need)
            ));
        }
    } else if width + 1e-9 < d + 2.0 {
        return Err(format!(
            "A {} mm hole needs a plate at least {} mm wide.",
            mm(d),
            mm_up(d + 2.0)
        ));
    }
    let need = 2.0 * inset + d + 1.0;
    if depth + 1e-9 < need {
        return Err(format!(
            "Two rows of {} mm holes need a plate at least {} mm deep.",
            mm(d),
            mm_up(need)
        ));
    }
    Ok(())
}

fn bracket_walls(n: i32, d: f64, leg: f64, width: f64, thickness: f64) -> Result<(), String> {
    if n <= 0 {
        return Ok(());
    }
    let need = n as f64 * (d + 2.0) + thickness;
    if leg + 1e-9 < need {
        return Err(format!(
            "{} holes of {} mm need legs of at least {} mm.",
            n,
            mm(d),
            mm_up(need)
        ));
    }
    if width + 1e-9 < d + 2.0 {
        return Err(format!(
            "A {} mm hole needs the bracket at least {} mm wide.",
            mm(d),
            mm_up(d + 2.0)
        ));
    }
    Ok(())
}

fn row_at(k: i32, y: f64, x0: f64, x1: f64, out: &mut Vec<[f64; 2]>) {
    if k <= 0 {
        return;
    }
    if k == 1 {
        out.push([0.0, y]);
        return;
    }
    for i in 0..k {
        let t = i as f64 / (k as f64 - 1.0);
        out.push([x0 + (x1 - x0) * t, y]);
    }
}

fn plate_centres(n: i32, width: f64, depth: f64, d: f64, pitch: f64) -> Vec<[f64; 2]> {
    if n <= 0 {
        return Vec::new();
    }
    if pitch > 0.0 {
        let radius = pitch * 0.5;
        return (0..n)
            .map(|i| {
                let angle = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
                [radius * angle.cos(), radius * angle.sin()]
            })
            .collect();
    }
    if n == 1 {
        return vec![[0.0, 0.0]];
    }
    let inset = 8.0_f64.max(d);
    let y = depth * 0.5 - inset;
    let x0 = -(width * 0.5 - inset);
    let x1 = width * 0.5 - inset;
    let mut out = Vec::new();
    row_at((n + 1) / 2, y, x0, x1, &mut out);
    row_at(n / 2, -y, x0, x1, &mut out);
    out
}

fn cells(n: i32, start: f64, end: f64) -> Vec<f64> {
    let span = end - start;
    (0..n)
        .map(|i| start + span * (i as f64 + 0.5) / n as f64)
        .collect()
}

fn cut_hole(
    body: Shape,
    solid: &Solid,
    centre_z: f64,
    local_mid: [f64; 3],
    local_turn: [f64; 3],
    height: f64,
    diameter: f64,
) -> Result<Shape, String> {
    let (at, turn) = pose_cylinder(solid, centre_z, local_mid, local_turn, height);
    combine(body, c"cut", &cylinder(at, turn, diameter * 0.5, height))
}

fn build_plate(solid: &Solid) -> Result<Shape, String> {
    let width = axis_or(solid.size[0], 80.0);
    let depth = axis_or(solid.size[1], 60.0);
    let thickness = axis_or(solid.size[2], 4.0);
    if !in_range(width, 30.0, 250.0) {
        return Err("The width is from 30 to 250 mm.".into());
    }
    if !in_range(depth, 20.0, 200.0) {
        return Err("The depth is from 20 to 200 mm.".into());
    }
    if !in_range(thickness, 2.0, 15.0) {
        return Err("The thickness is from 2 to 15 mm.".into());
    }
    let choice = hole_choice(solid)?;
    let n = count_of(solid.holes, 4, 12, "The hole count is from 0 to 12.")?;
    let pitch = solid.pitch_circle.unwrap_or(0.0);
    if !in_range(pitch, 0.0, 200.0) {
        return Err("The pitch circle is from 0 to 200 mm.".into());
    }
    let diameter = drilled(solid, choice)?;
    plate_walls(n, diameter, width, depth, pitch)?;
    let centre_z = thickness * 0.5;
    let (origin, turn) = pose_box(solid, centre_z, [0.0, 0.0, centre_z], [width, depth, thickness]);
    let mut body = Shape::primitive(&block(origin, turn, [width, depth, thickness]))?;
    let hole_h = thickness + 2.0 * OVERSHOOT_MM;
    for [x, y] in plate_centres(n, width, depth, diameter, pitch) {
        body = cut_hole(body, solid, centre_z, [x, y, centre_z], [0.0, 0.0, 0.0], hole_h, diameter)?;
    }
    Ok(body)
}

fn build_bracket(solid: &Solid) -> Result<Shape, String> {
    let leg = axis_or(solid.size[0], 40.0);
    let width = axis_or(solid.size[1], 30.0);
    let thickness = axis_or(solid.size[2], 3.0);
    if !in_range(thickness, 1.5, 10.0) {
        return Err("The thickness is from 1.5 to 10 mm.".into());
    }
    // A thickness inside its range that is still at least the leg names that limit, even when the leg is short.
    if thickness >= leg {
        return Err("The thickness must be less than the leg.".into());
    }
    if !in_range(leg, 15.0, 120.0) {
        return Err("The leg is from 15 to 120 mm.".into());
    }
    if !in_range(width, 10.0, 80.0) {
        return Err("The width is from 10 to 80 mm.".into());
    }
    let choice = hole_choice(solid)?;
    let n = count_of(solid.holes, 2, 4, "The holes per leg are from 0 to 4.")?;
    let diameter = drilled(solid, choice)?;
    bracket_walls(n, diameter, leg, width, thickness)?;
    let centre_z = leg * 0.5;
    let (base_at, base_turn) = pose_box(solid, centre_z, [0.0, 0.0, thickness * 0.5], [leg, width, thickness]);
    let base = Shape::primitive(&block(base_at, base_turn, [leg, width, thickness]))?;
    let upright = [thickness, width, leg];
    let (up_at, up_turn) = pose_box(
        solid,
        centre_z,
        [leg * 0.5 - thickness * 0.5, 0.0, leg * 0.5],
        upright,
    );
    let mut body = combine(base, c"fuse", &block(up_at, up_turn, upright))?;
    if n == 0 {
        return Ok(body);
    }
    let hole_h = thickness + 2.0 * OVERSHOOT_MM;
    for x in cells(n, -leg * 0.5, leg * 0.5 - thickness) {
        body = cut_hole(body, solid, centre_z, [x, 0.0, thickness * 0.5], [0.0, 0.0, 0.0], hole_h, diameter)?;
    }
    for z in cells(n, thickness, leg) {
        body = cut_hole(
            body,
            solid,
            centre_z,
            [leg * 0.5 - thickness * 0.5, 0.0, z],
            [0.0, -90.0, 0.0],
            hole_h,
            diameter,
        )?;
    }
    Ok(body)
}

/// The part `solid` describes, or the one sentence why it is not one.
pub(super) fn build_part(solid: &Solid) -> Result<Shape, String> {
    let kind = kind_of(solid)?;
    refuse_bore(solid, kind)?;
    refuse_stray(solid, kind)?;
    match kind {
        Kind::Nut => build_nut(solid),
        Kind::Socket => build_socket(solid),
        Kind::Hex => build_hex(solid),
        Kind::Washer => build_washer(solid),
        Kind::Spacer => build_spacer(solid),
        Kind::Shaft => build_shaft(solid),
        Kind::Collar => build_collar(solid),
        Kind::Heat => build_heat(solid),
        Kind::Plate => build_plate(solid),
        Kind::Bracket => build_bracket(solid),
    }
}
