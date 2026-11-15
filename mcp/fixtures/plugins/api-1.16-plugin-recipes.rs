//! ---
//! plugin: corpus-plugin-recipes-api-1-16
//! title: Corpus plugin recipes (API 1.16)
//! version: 1
//! description: Run a kept plugin twice, place, hinge and couple the gears.
//! author: Lime Slice corpus
//! api: 1.16
//! source-sha256: c11ec5b6ed297f64153dd7cb358033c023ae931035569ef75f9bec42b4bdee4d
//! created: 2026-11-15
//! target: new
//! params: []
//! ---
use lime_recipe::{gears, ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let module = s.number("module", 1.0).range(0.5, 3.0).unit("mm").get();
    let plate = s.solid_new(ops::cuboid(60.0, 30.0, 3.0)).unwrap();
    let a = s.run_plugin("corpus-gear-api-1-16", Json::obj().set("teeth", 12).set("module", module)).unwrap();
    let phase = gears::mate_phase(0.0, 12, 0.0, 24);
    let b = s.run_plugin("corpus-gear-api-1-16", Json::obj().set("teeth", 24).set("module", module).set("phase", phase)).unwrap();
    let missing = s.run_plugin("corpus-no-such-plugin", Json::obj()).is_err();
    let x = gears::pitch_radius(12, module) + gears::pitch_radius(24, module);
    s.attach(&a.part, &plate, [-15.0, 0.0, 3.0], [0.0, 0.0, 0.0]).unwrap();
    s.attach(&b.part, &plate, [-15.0 + x, 0.0, 3.0], [0.0, 0.0, 0.0]).unwrap();
    s.hinge(&a.part, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]).unwrap();
    s.hinge(&b.part, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]).unwrap();
    let coupled = s.couple_gears(&a.part).unwrap();
    let couplings = coupled.get("couplings").and_then(Json::as_array).map(|c| c.len()).unwrap_or(0);
    s.turn_joint(&a.part, 30.0).unwrap();
    s.done_with(&plate, Json::obj().set("couplings", couplings).set("missing", missing).set("version", a.version).set("parts", a.parts.len() + b.parts.len()));
}
