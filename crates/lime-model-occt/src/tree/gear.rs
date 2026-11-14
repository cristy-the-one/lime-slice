//! The gear primitive (docs/plan-native-recipes.md milestone 8): a spur gear with true involute flanks, as a new solid
//! or as a boolean's tool. The outline is `lime_recipe::gears::Gear`'s, the same code a recipe's `Gear::outline` runs:
//! involute splines, the cutting rack's root fillet (and its undercut on a small gear), arcs at tip and root. It is one
//! extrude of loops, with the bore as a hole, and a hub fused on top when there is one.

use std::os::raw::c_int;

use lime_recipe::gears::{Gear, Piece, Ring};

use super::ffi::{lime_tree_extrude_loops, lime_tree_feature_extrude_loops};
use super::k1::encode_loops;
use super::ops::{BoreShape, ProfileLoop, ProfileSegment, Solid};
use super::shape::Shape;

/// The thickest gear, and the tallest hub, in millimetres.
const MAX_MM: f64 = 1000.0;

/// What a gear `Solid` reads, checked: the gear, its thickness, and its bore and hub.
pub(super) struct GearSpec {
    pub(super) gear: Gear,
    pub(super) thickness: f64,
    pub(super) phase_deg: f64,
    bore: Option<(BoreShape, f64, f64)>,
    hub: Option<(f64, f64)>,
}

/// The gear a `Solid` describes, or the one sentence why it is not one.
pub(super) fn gear_spec(solid: &Solid) -> Result<GearSpec, String> {
    let teeth = solid.teeth.unwrap_or(0.0);
    if !(teeth.is_finite() && teeth.fract() == 0.0) {
        return Err("A gear takes a whole number of teeth.".into());
    }
    let gear = Gear {
        teeth: teeth.clamp(0.0, 10_000.0) as u32,
        module: solid.module.unwrap_or(0.0),
        pressure_deg: solid.pressure_deg.unwrap_or(20.0),
        backlash: solid.backlash.unwrap_or(0.1),
        shift: solid.profile_shift.unwrap_or(0.0),
    };
    if let Some(why) = gear.refusal() {
        return Err(why);
    }
    let thickness = solid.height;
    if !(thickness.is_finite() && thickness > 0.0 && thickness <= MAX_MM) {
        return Err("A gear's thickness is above 0 and at most 1000 mm.".into());
    }
    let phase_deg = solid.phase_deg.unwrap_or(0.0);
    if !phase_deg.is_finite() {
        return Err("A gear's phase is a number of degrees.".into());
    }
    let shape = solid.bore_shape.unwrap_or(BoreShape::Round);
    let bore = match solid.bore.filter(|size| *size != 0.0) {
        None => {
            if solid.bore_shape.is_some() || solid.bore_flat.is_some() {
                return Err("A bore's shape or flat needs a bore size.".into());
            }
            None
        }
        Some(size) => {
            if !(size.is_finite() && size > 0.0) {
                return Err("A gear's bore is above 0 mm.".into());
            }
            let flat = match (shape, solid.bore_flat) {
                (BoreShape::D, None) => 0.9 * size,
                (BoreShape::D, Some(flat)) if flat.is_finite() && flat > size / 2.0 && flat < size => flat,
                (BoreShape::D, Some(_)) => {
                    return Err("A D bore's flat is more than half the bore and less than all of it, mm across.".into());
                }
                (_, Some(_)) => return Err("Only a D bore takes a flat.".into()),
                (_, None) => 0.0,
            };
            // The bore's farthest point from the axis must leave a module of material under the teeth.
            let reach = match shape {
                BoreShape::Hex => size / 3f64.sqrt(),
                _ => size / 2.0,
            };
            if reach > gear.root_radius() - gear.module {
                return Err(format!(
                    "The bore leaves less than one module of material under the teeth: keep it under {:.2} mm.",
                    2.0 * (gear.root_radius() - gear.module) * if shape == BoreShape::Hex { 3f64.sqrt() / 2.0 } else { 1.0 }
                ));
            }
            Some((shape, size, flat))
        }
    };
    let hub = match (solid.hub_diameter, solid.hub_height) {
        (None, None) => None,
        (Some(d), Some(h)) => {
            if !(h.is_finite() && h > 0.0 && h <= MAX_MM) {
                return Err("A hub's height is above 0 and at most 1000 mm.".into());
            }
            let reach = bore.map_or(0.0, |(shape, size, _)| if shape == BoreShape::Hex { size / 3f64.sqrt() } else { size / 2.0 });
            if !(d.is_finite() && d / 2.0 >= reach + 0.5) {
                return Err("A hub is wider than the bore by at least 1 mm.".into());
            }
            if d / 2.0 > gear.tip_radius() * 4.0 {
                return Err("A hub is at most twice the gear's diameter.".into());
            }
            Some((d, h))
        }
        _ => return Err("A hub takes both hubDiameter and hubHeight.".into()),
    };
    Ok(GearSpec { gear, thickness, phase_deg, bore, hub })
}

fn segment(piece: &Piece) -> ProfileSegment {
    match piece {
        Piece::Line(to) => ProfileSegment::Line { to: *to },
        Piece::Arc(through, to) => ProfileSegment::Arc { through: *through, to: *to },
        Piece::Spline(through, to) => ProfileSegment::Spline { through: through.clone(), to: *to },
    }
}

/// A circle of `radius` about the origin, as two arcs.
fn circle(radius: f64) -> ProfileLoop {
    ProfileLoop {
        start: [radius, 0.0],
        segments: vec![
            ProfileSegment::Arc { through: [0.0, radius], to: [-radius, 0.0] },
            ProfileSegment::Arc { through: [0.0, -radius], to: [radius, 0.0] },
        ],
    }
}

/// The bore's loop: a circle, a hexagon `size` across its flats with corners on ±U, or a D whose flat faces +U.
fn bore_loop(shape: BoreShape, size: f64, flat: f64) -> ProfileLoop {
    match shape {
        BoreShape::Round => circle(size / 2.0),
        BoreShape::Hex => {
            let corner = size / 3f64.sqrt();
            let point = |k: u32| {
                let (s, c) = lime_recipe::geom2d::sin_cos_deg(60.0 * f64::from(k));
                [corner * c, corner * s]
            };
            ProfileLoop {
                start: point(0),
                segments: (1..=6).map(|k| ProfileSegment::Line { to: point(k % 6) }).collect(),
            }
        }
        BoreShape::D => {
            let radius = size / 2.0;
            let across = flat - radius;
            let half = (radius * radius - across * across).max(0.0).sqrt();
            ProfileLoop {
                start: [across, -half],
                segments: vec![
                    ProfileSegment::Line { to: [across, half] },
                    ProfileSegment::Arc { through: [-radius, 0.0], to: [across, -half] },
                ],
            }
        }
    }
}

/// `v` turned by `turn` degrees about X, then Y, then Z, as tree.cpp turns a primitive and a workplane.
fn turned(v: [f64; 3], turn: [f64; 3]) -> [f64; 3] {
    let (sx, cx) = turn[0].to_radians().sin_cos();
    let (sy, cy) = turn[1].to_radians().sin_cos();
    let (sz, cz) = turn[2].to_radians().sin_cos();
    let v = [v[0], v[1] * cx - v[2] * sx, v[1] * sx + v[2] * cx];
    let v = [v[0] * cy + v[2] * sy, v[1], -v[0] * sy + v[2] * cy];
    [v[0] * cz - v[1] * sz, v[0] * sz + v[1] * cz, v[2]]
}

/// The gear `solid` describes, built against nothing: its base centred on `origin`, `height` thick along its own Z,
/// turned about the middle of its axis like a cylinder, the hub on top.
pub(super) fn build_gear(solid: &Solid) -> Result<Shape, String> {
    if solid.internal == Some(true) {
        return build_ring(solid);
    }
    if solid.rim.is_some() {
        return Err("Only a ring gear (internal) takes a rim.".into());
    }
    let spec = gear_spec(solid)?;
    let outline = spec.gear.outline(spec.phase_deg)?;
    let mut loops = vec![ProfileLoop { start: outline.start, segments: outline.pieces.iter().map(segment).collect() }];
    let bore = spec.bore.map(|(shape, size, flat)| bore_loop(shape, size, flat));
    loops.extend(bore.clone());
    let half = turned([0.0, 0.0, spec.thickness / 2.0], solid.turn);
    let [x, y, z] = solid.origin;
    let centre = [x, y, z + spec.thickness / 2.0];
    let [rx, ry, rz] = solid.turn;
    // The body: centred on the middle of its axis, half its thickness each way.
    let p = [centre[0], centre[1], centre[2], rx, ry, rz, spec.thickness, 1.0];
    let mut blob = Vec::new();
    encode_loops(&loops, &mut blob);
    let body = Shape::made(|error| unsafe {
        lime_tree_feature_extrude_loops(c"fuse".as_ptr(), p.as_ptr(), blob.as_ptr(), blob.len() as c_int, error)
    })?;
    let Some((diameter, height)) = spec.hub else {
        return Ok(body);
    };
    let mut hub = vec![circle(diameter / 2.0)];
    hub.extend(bore);
    let top = [centre[0] + half[0], centre[1] + half[1], centre[2] + half[2]];
    let p = [top[0], top[1], top[2], rx, ry, rz, height, 0.0];
    let mut blob = Vec::new();
    encode_loops(&hub, &mut blob);
    Shape::made(|error| unsafe {
        lime_tree_extrude_loops(body.raw(), c"fuse".as_ptr(), p.as_ptr(), blob.as_ptr(), blob.len() as c_int, error)
    })
}

/// The ring `solid` describes (docs/plan-gear-kinds.md, stage 2): `teeth`, `module`, `pressureDeg` and `backlash` as a
/// gear's, `rim` its outside diameter. No profile shift, bore or hub. Or the one sentence why it is not one.
pub(super) fn ring_spec(solid: &Solid) -> Result<(Ring, f64, f64, f64), String> {
    let teeth = solid.teeth.unwrap_or(0.0);
    if !(teeth.is_finite() && teeth.fract() == 0.0) {
        return Err("A gear takes a whole number of teeth.".into());
    }
    if solid.profile_shift.is_some_and(|x| x != 0.0) {
        return Err("A ring gear takes no profile shift.".into());
    }
    if solid.bore.is_some_and(|x| x != 0.0) || solid.bore_shape.is_some() || solid.bore_flat.is_some() || solid.hub_diameter.is_some() || solid.hub_height.is_some() {
        return Err("A ring gear takes no bore or hub: its hole is its teeth.".into());
    }
    let ring = Ring {
        teeth: teeth.clamp(0.0, 10_000.0) as u32,
        module: solid.module.unwrap_or(0.0),
        pressure_deg: solid.pressure_deg.unwrap_or(20.0),
        backlash: solid.backlash.unwrap_or(0.1),
    };
    if let Some(why) = ring.refusal() {
        return Err(why);
    }
    let thickness = solid.height;
    if !(thickness.is_finite() && thickness > 0.0 && thickness <= MAX_MM) {
        return Err("A gear's thickness is above 0 and at most 1000 mm.".into());
    }
    let phase_deg = solid.phase_deg.unwrap_or(0.0);
    if !phase_deg.is_finite() {
        return Err("A gear's phase is a number of degrees.".into());
    }
    let least = 2.0 * (ring.root_radius() + 2.0 * ring.module);
    let rim = solid.rim.unwrap_or(least);
    if !(rim.is_finite() && rim >= least - 1e-9 && rim <= 4.0 * least) {
        return Err(format!("A ring's rim is {:.2} to {:.2} mm across: at least two modules outside its root.", least, 4.0 * least));
    }
    Ok((ring, thickness, phase_deg, rim))
}

/// A ring gear: a disc of its rim with the toothed hole through it, one extrude of loops.
fn build_ring(solid: &Solid) -> Result<Shape, String> {
    let (ring, thickness, phase_deg, rim) = ring_spec(solid)?;
    let hole = ring.outline(phase_deg)?;
    let loops = vec![circle(rim / 2.0), ProfileLoop { start: hole.start, segments: hole.pieces.iter().map(segment).collect() }];
    let [x, y, z] = solid.origin;
    let [rx, ry, rz] = solid.turn;
    let p = [x, y, z + thickness / 2.0, rx, ry, rz, thickness, 1.0];
    let mut blob = Vec::new();
    encode_loops(&loops, &mut blob);
    Shape::made(|error| unsafe {
        lime_tree_feature_extrude_loops(c"fuse".as_ptr(), p.as_ptr(), blob.as_ptr(), blob.len() as c_int, error)
    })
}
