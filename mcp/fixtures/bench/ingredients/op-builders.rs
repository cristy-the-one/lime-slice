//! ---
//! ingredient: op-builders
//! title: op builders
//! version: 1
//! description: Short builders for model_apply op JSON: boxes, turned cylinders, tubes, hex prisms, cones, spheres, polar/linear patterns, plane sketches. Encodes the centre-for-turned and cone-orientation rules.
//! author: unknown
//! made-by: local-agent-mode-lime-slice
//! api: 1.4
//! lust: 7931db30
//! source-sha256: 3bafb52fcea67636023ae22f7619e15c4140fd3d5dc99cf39c5d5e0f5d8b2e8d
//! created: 2026-11-06
//! ---
// Short builders for model_apply op JSON: boxes, turned cylinders, tubes, hex prisms,
// cones, spheres, polar patterns and flat-sketch extrudes. Pure JSON, no session calls.
//
// Kernel rules they follow: a box with `origin` is its min corner; anything turned
// pivots on `centre` (box middle, mid-axis of a round), so turned shapes always use
// centre; turn is degrees about X, then Y, then Z. A cone needs radius >= topRadius:
// for one narrowing downward, pass turn [180, 0, 0].

use lime_recipe::Json;

pub type V3 = [f64; 3];
pub type P2 = [f64; 2];

/// Turn that puts a round's axis along X, Y, or keeps Z.
pub const AXIS_X: V3 = [0.0, 90.0, 0.0];
pub const AXIS_Y: V3 = [90.0, 0.0, 0.0];
pub const AXIS_Z: V3 = [0.0, 0.0, 0.0];

fn prim(op: &str, p: &str) -> Json {
    Json::obj().set("kind", "boolean").set("op", op).set("primitive", p)
}

/// Box from its min corner `o`, size `d`.
pub fn box_at(op: &str, o: V3, d: V3) -> Json {
    prim(op, "box").set("origin", o).set("dx", d[0]).set("dy", d[1]).set("dz", d[2])
}
/// Box from its two corners.
pub fn box_from_to(op: &str, a: V3, b: V3) -> Json {
    let o = [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])];
    box_at(op, o, [(a[0] - b[0]).abs(), (a[1] - b[1]).abs(), (a[2] - b[2]).abs()])
}
/// Box centred on `c`, turned.
pub fn box_turned(op: &str, c: V3, d: V3, turn: V3) -> Json {
    prim(op, "box").set("centre", c).set("dx", d[0]).set("dy", d[1]).set("dz", d[2]).set("turn", turn)
}
/// Upright cylinder from its base centre.
pub fn cyl_up(op: &str, base: V3, r: f64, h: f64) -> Json {
    prim(op, "cylinder").set("radius", r).set("height", h).set("origin", base)
}
/// Cylinder centred on `c` (mid-axis), axis set by `turn` (AXIS_X, AXIS_Y...).
pub fn cyl_turned(op: &str, c: V3, r: f64, h: f64, turn: V3) -> Json {
    prim(op, "cylinder").set("radius", r).set("height", h).set("centre", c).set("turn", turn)
}
/// Upright tube (ring) from its base centre.
pub fn tube_up(op: &str, base: V3, r: f64, r_in: f64, h: f64) -> Json {
    prim(op, "tube").set("radius", r).set("innerRadius", r_in).set("height", h).set("origin", base)
}
/// Upright regular prism (hex nut: sides 6) from its base centre, sized across flats.
pub fn prism_up(op: &str, base: V3, sides: u32, across_flats: f64, h: f64) -> Json {
    prim(op, "polygon").set("sides", sides).set("across", across_flats).set("flats", true).set("height", h).set("origin", base)
}
/// Regular prism centred on `c`, turned (bolt heads on side faces).
pub fn prism_turned(op: &str, c: V3, sides: u32, across_flats: f64, h: f64, turn: V3) -> Json {
    prim(op, "polygon").set("sides", sides).set("across", across_flats).set("flats", true).set("height", h).set("centre", c).set("turn", turn)
}
/// Cone centred on `c`, wide end radius `r_wide`, narrow end `r_narrow`; turn picks the axis
/// (wide end at -axis before the turn; [180,0,0] puts the wide end on top).
pub fn cone_turned(op: &str, c: V3, r_wide: f64, r_narrow: f64, h: f64, turn: V3) -> Json {
    prim(op, "cone").set("radius", r_wide).set("topRadius", r_narrow).set("height", h).set("centre", c).set("turn", turn)
}
pub fn sphere_at(op: &str, c: V3, r: f64) -> Json { prim(op, "sphere").set("radius", r).set("origin", c) }

/// The corner radius of a hex prism sized across flats: a round bore it passes through
/// needs a radius above this.
pub fn hex_corner_radius(across_flats: f64) -> f64 { across_flats / 3f64.sqrt() }

/// Repeat `op` `count` times about an axis through `centre`.
pub fn polar(op: Json, count: u32, centre: V3, axis: V3) -> Json {
    Json::obj().set("kind", "pattern").set("op", op)
        .set("polar", Json::obj().set("centre", centre).set("axis", axis).set("count", count))
}
/// Repeat `op` along `step`, `count` times in all.
pub fn linear(op: Json, count: u32, step: V3) -> Json {
    Json::obj().set("kind", "pattern").set("op", op)
        .set("linear", Json::obj().set("step", step).set("count", count))
}
/// Extrude a closed outline drawn on the plane through `origin` turned by `turn`
/// (AXIS_Z: the XY plane, W = +Z; [90, 0, 90]: U = Y, V = Z, W = +X; [-90, 0, 0]: U = X, V = -Z, W = +Y).
pub fn sketch(op: &str, pts: Vec<P2>, origin: V3, turn: V3, depth: f64) -> Json {
    Json::obj().set("kind", "extrude").set("op", op).set("profile", Json::arr(pts))
        .set("depth", depth).set("origin", origin).set("turn", turn)
}
/// Same, centred on the plane.
pub fn sketch_symmetric(op: &str, pts: Vec<P2>, origin: V3, turn: V3, depth: f64) -> Json {
    sketch(op, pts, origin, turn, depth).set("symmetric", true)
}
