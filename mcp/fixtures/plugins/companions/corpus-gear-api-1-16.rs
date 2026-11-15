//! ---
//! plugin: corpus-gear-api-1-16
//! title: Corpus gear (API 1.16 companion)
//! version: 1
//! description: A gear the API 1.16 corpus plugin runs from inside it.
//! author: Lime Slice corpus
//! api: 1.16
//! source-sha256: bf4367f3342f87de352da81b3d13766fdf892264d7a1363b708cbf380b672406
//! created: 2026-11-15
//! target: new
//! params: []
//! ---
use lime_recipe::{Json, Session};

fn main() {
    let mut s = Session::start();
    let teeth = s.count("teeth", 12).range(6, 200).get();
    let module = s.number("module", 1.0).range(0.3, 5.0).get();
    let phase = s.number("phase", 0.0).get();
    let gear = Json::obj().set("teeth", teeth).set("module", module).set("thickness", 4.0).set("bore", 0.0).set("phaseDeg", phase);
    let part = s.solid_new(Json::obj().set("gear", gear).set("name", "gear")).unwrap();
    s.done_with(&part, Json::obj().set("teeth", teeth));
}
