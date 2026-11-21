//! ---
//! plugin: mech-v-pulley
//! title: V-belt pulley
//! version: 1
//! description: A double-cone pulley groove for classic V-belts; groove angle and widths follow ISO 5291 proportions.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"pitchDiameter","kind":"number","default":50,"min":20,"max":200,"step":0.5,"unit":"mm","label":"Pitch diameter"},{"name":"width","kind":"number","default":12,"min":4,"max":40,"step":0.1,"unit":"mm","label":"Rim width"},{"name":"bore","kind":"number","default":8,"min":3,"max":30,"step":0.1,"unit":"mm","label":"Bore diameter"},{"name":"grooveAngle","kind":"number","default":38,"min":30,"max":45,"step":0.5,"unit":"deg","label":"Groove angle"}]
//! ---
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let pitch = s.number("pitchDiameter", 50.0).range(20.0, 200.0).step(0.5).unit("mm").label("Pitch diameter").get();
    let width = s.number("width", 12.0).range(4.0, 40.0).step(0.1).unit("mm").label("Rim width").get();
    let bore = s.number("bore", 8.0).range(3.0, 30.0).step(0.1).unit("mm").label("Bore diameter").get();
    let angle = s.number("grooveAngle", 38.0).range(30.0, 45.0).step(0.5).unit("deg").label("Groove angle").get();
    let r = pitch / 2.0;
    let half = angle.to_radians() / 2.0;
    let groove_depth = width * 0.35;
    let r_top = r + groove_depth;
    let r_bot = r - groove_depth;
    let top_half = r_top * half.tan();
    let bot_half = r_bot * half.tan();
    let disc_h = width + 4.0;
    let part = s.solid_new(ops::cylinder(r_top + 2.0, disc_h)).unwrap();
    let cone = Json::obj()
        .set("primitive", "cone")
        .set("radius", top_half.max(1.0))
        .set("topRadius", bot_half.max(0.5))
        .set("height", groove_depth * 2.0);
    s.apply(&part, ops::boolean("cut", cone, [0.0, 0.0, disc_h / 2.0 - groove_depth])).unwrap();
    if bore > 0.2 {
        s.apply(&part, ops::hole_through([0.0, 0.0, disc_h], [0.0, 0.0, -1.0], bore)).unwrap();
    }
    let ro = r_top + 2.0;
    s.done_with(&part, Json::obj().set("pitch", pitch).set("grooveDepth", groove_depth).set("angle", angle).set("bmin", [-ro, -ro, 0.0]).set("bmax", [ro, ro, disc_h]));
}