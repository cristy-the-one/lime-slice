// A vent plate: a rounded plate with four screw bosses and a honeycomb vent that keeps clear of the bosses
// and the edge. The 2D work is lime_recipe::geom2d and lime_recipe::lattice; the recipe only places it.
use lime_recipe::geom2d::{circle, rect, Region};
use lime_recipe::lattice::{hex, Orient};
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let w = s.param_f64("width", 120.0);
    let h = s.param_f64("height", 80.0);
    let t = s.param_f64("thick", 3.0);
    let corner = s.param_f64("cornerR", 8.0);
    let cell = s.param_f64("cell", 6.0);
    let rib = s.param_f64("rib", 1.6);
    let margin = s.param_f64("margin", 5.0);
    let boss = s.param_f64("bossD", 10.0);

    let plate = Region::from_poly(&rect(w, h));
    let mut bosses = Region::empty();
    for (sx, sy) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
        let at = [sx * (w / 2.0 - corner), sy * (h / 2.0 - corner)];
        bosses = bosses.union(&Region::from_poly(&circle(boss / 2.0, 48).translate(at[0], at[1])));
    }
    let vent = plate.offset_miter(-margin).difference(&bosses.offset(margin).to_region(0.05));

    let part = s.solid_new(ops::cuboid(w + 2.0, h + 2.0, t)).unwrap();
    let outline = plate.round_corners(corner).to_loops();
    s.apply(&part, Json::obj().set("kind", "extrude").set("op", "common").set("origin", [0.0, 0.0, 0.0])
        .set("depth", t).set("loops", outline[0].clone()).set("label", "plate")).unwrap();

    let cells = hex(cell, Orient::Flat).rib(rib).cells(&vent, 4.0);
    let mut cut = 0;
    let mut clipped = 0;
    for c in cells.iter() {
        for loops in c.region.round_corners_with(0.8, 0.45, 0.2).to_loops() {
            let op = Json::obj().set("kind", "extrude").set("op", "cut").set("origin", [0.0, 0.0, -0.5])
                .set("depth", t + 1.0).set("loops", loops)
                .set("label", format!("cell {} {}", c.index[0], c.index[1]));
            if s.apply(&part, op).is_ok() {
                cut += 1;
            }
        }
        if c.clipped {
            clipped += 1;
        }
    }
    let open: f64 = cells.iter().map(|c| c.area()).fold(0.0, |a, b| a + b);
    s.done_with(&part, Json::obj().set("cells", cut).set("clipped", clipped)
        .set("ventMm2", (vent.area() * 100.0).round() / 100.0).set("openMm2", (open * 100.0).round() / 100.0));
}
