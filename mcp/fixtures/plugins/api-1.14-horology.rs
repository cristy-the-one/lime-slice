//! ---
//! plugin: corpus-horology-api-1-14
//! title: Corpus horology (API 1.14)
//! version: 1
//! description: A ratchet's outline cut into a plate, with the note's going train, a Graham anchor's pivot distance and a pin bore, from lime_recipe::horology.
//! author: Lime Slice corpus
//! api: 1.14
//! source-sha256: a92309ed5db4a4afa3f3c8b26621e5f50ec534f45d249e9db2980914154deb36
//! created: 2026-11-15
//! target: new
//! params: []
//! ---
use lime_recipe::horology::{count_train, pin_bore, EscapeWheel, Fit, Graham, Ratchet, TrainLimits};
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let plate = s.solid_new(ops::cuboid(40.0, 40.0, 4.0)).unwrap();
    let ratchet = Ratchet::new(16, 12.0, 9.5);
    let outline = ratchet.outline(0.0).unwrap().to_loop();
    s.apply(&plate, Json::obj().set("kind", "extrude").set("op", "cut").set("origin", [0.0, 0.0, 4.0]).set("depth", -2.0).set("loops", vec![outline])).unwrap();
    let train = count_train(0.75, 30, 3, &TrainLimits::new(40, 64, 8, 10)).unwrap();
    let graham = Graham::new(EscapeWheel::new(30, 22.5, 17.5, 12.0), 7.5);
    s.done_with(
        &plate,
        Json::obj()
            .set("period", train.period_s())
            .set("firstWheel", train.stages[0].0 as f64)
            .set("pivot", graham.pivot_distance())
            .set("swing", graham.swing_deg())
            .set("bore", pin_bore(2.0, Fit::Running, 0.2).unwrap()),
    );
}
