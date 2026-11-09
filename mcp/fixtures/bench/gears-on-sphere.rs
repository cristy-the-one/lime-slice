// Spur gears of various sizes lying tangent on a sphere: each gear's back face sits on the
// tangent plane at its touch point, sunk a little so its rim meets the surface, with a hub.
// Uses the involute-gears and op-builders ingredients (copied from the release library).
use lime_recipe::{Json, Part, Session};
use ingredients::involute_gears::*;
use ingredients::op_builders::*;

struct G { polar: f64, az: f64, z: u32, m: f64 }

fn ap(s: &mut Session, p: &Part, j: Json, what: &str) -> bool {
    match s.apply(p, j) { Ok(_) => true, Err(e) => { s.log(&format!("{}: refused: {}", what, e.reason)); false } }
}

fn main() {
    let mut s = Session::start();
    let r = s.number("sphereRadius", 60.0).range(5.0, 400.0).unit("mm").label("Sphere radius").get();
    let cz = s.number("centreZ", 60.0).range(-500.0, 500.0).unit("mm").label("Sphere centre Z").get();
    let thick = s.number("thickness", 4.0).range(1.0, 20.0).unit("mm").label("Gear thickness").get();
    let part = s.object().expect("Select the sphere first.");
    let c = [0.0, 0.0, cz];
    // Polar angle from +Z (90 = equator), azimuth from +X, teeth, module.
    let gears = [
        G { polar: 114.0, az: 0.0, z: 24, m: 1.25 },
        G { polar: 112.0, az: 62.0, z: 16, m: 1.25 },
        G { polar: 116.0, az: 122.0, z: 30, m: 1.0 },
        G { polar: 112.0, az: 182.0, z: 12, m: 1.5 },
        G { polar: 115.0, az: 240.0, z: 20, m: 1.25 },
        G { polar: 112.0, az: 300.0, z: 18, m: 1.0 },
        G { polar: 141.0, az: 30.0, z: 14, m: 1.0 },
        G { polar: 141.0, az: 150.0, z: 20, m: 0.8 },
        G { polar: 141.0, az: 270.0, z: 10, m: 1.5 },
    ];
    let mut made = 0;
    for (i, g) in gears.iter().enumerate() {
        let (p, a) = (g.polar.to_radians(), g.az.to_radians());
        let n = [p.sin() * a.cos(), p.sin() * a.sin(), p.cos()];
        let ra = pitch_radius(g.z, g.m) + g.m;
        // Sink so the rim meets the sphere, plus 0.4 mm to fuse.
        let sink = r - (r * r - ra * ra).max(0.0).sqrt() + 0.4;
        let at = |d: f64| [c[0] + n[0] * d, c[1] + n[1] * d, c[2] + n[2] * d];
        // Turn [0, polar, azimuth] puts the sketch normal W on n.
        let turn = [0.0, g.polar, g.az];
        let outline = gear_outline(g.z, g.m, 0.0);
        if ap(&mut s, &part, sketch("fuse", outline, at(r - sink), turn, sink + thick), &format!("gear {}", i + 1)) { made += 1; }
        // Hub: a short round boss on the face, then a bore.
        let rh = (pitch_radius(g.z, g.m) - 1.25 * g.m) * 0.38;
        ap(&mut s, &part, cyl_turned("fuse", at(r + thick + 0.75), rh, 1.5 + 0.1, turn), &format!("hub {}", i + 1));
        ap(&mut s, &part, cyl_turned("cut", at(r + thick + 0.8), rh * 0.45, 4.0, turn), &format!("bore {}", i + 1));
    }
    s.done_with(&part, Json::obj().set("gears", made as f64));
}
