//! ---
//! plugin: corpus-gears-api-1-12
//! title: Corpus gears (API 1.12)
//! version: 1
//! description: A gear's true involute outline cut into a plate, and its mate's phase, from lime_recipe::gears.
//! author: Lime Slice corpus
//! api: 1.12
//! source-sha256: c112f535c6b73dabc21404353f060a02b2f7bf2f7218793dc713b914bb398898
//! created: 2026-11-09
//! target: new
//! params: []
//! ---
use lime_recipe::gears::{gear_outline, mate_phase, Gear};
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let plate = s.solid_new(ops::cuboid(40.0, 40.0, 4.0)).unwrap();
    let gear = Gear::new(9, 2.0);
    let outline = gear.outline(0.0).unwrap().to_loop();
    s.apply(&plate, Json::obj().set("kind", "extrude").set("op", "cut").set("origin", [0.0, 0.0, 4.0]).set("depth", -2.0).set("loops", vec![outline])).unwrap();
    let mate = mate_phase(0.0, 9, 0.0, 18);
    let library = gear_outline(9, 2.0, 0.0).len();
    s.done_with(&plate, Json::obj().set("mate", mate).set("thickness", gear.pitch_thickness()).set("undercut", gear.undercut()).set("libraryPoints", library as f64));
}
