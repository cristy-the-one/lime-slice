//! ---
//! plugin: mech-shaft
//! title: Shaft
//! version: 1
//! description: A plain shaft sized for a steel bore or bearing inner ring, with ISO 286 sliding fit and print allowance.
//! author: Lime Slice study
//! made-by: cursor-cloud-agent
//! api: 1.17
//! created: 2026-11-20
//! target: new
//! params: [{"name":"nominal","kind":"number","default":8,"min":2,"max":30,"step":0.1,"unit":"mm","label":"Nominal diameter"},{"name":"length","kind":"number","default":40,"min":5,"max":300,"step":0.5,"unit":"mm","label":"Length"},{"name":"fit","kind":"choice","default":"sliding","label":"Fit","options":["running","sliding","press"]},{"name":"allowance","kind":"number","default":0.1,"min":0,"max":0.5,"step":0.02,"unit":"mm","label":"Print allowance"}]
//! ---
use lime_recipe::{ops, Json, Session};
use lime_recipe::horology::{shaft, Fit};

fn main() {
    let mut s = Session::start();
    let nominal = s.number("nominal", 8.0).range(2.0, 30.0).step(0.1).unit("mm").label("Nominal diameter").get();
    let length = s.number("length", 40.0).range(5.0, 300.0).step(0.5).unit("mm").label("Length").get();
    let fit_name = s.choice("fit", &["running", "sliding", "press"], "sliding").label("Fit").get();
    let allowance = s.number("allowance", 0.1).range(0.0, 0.5).step(0.02).unit("mm").label("Print allowance").get();
    let fit = match fit_name.as_str() {
        "running" => Fit::Running,
        "press" => Fit::Press,
        _ => Fit::Sliding,
    };
    let d = shaft(nominal, fit, allowance).unwrap_or(nominal);
    let part = s.solid_new(ops::cylinder(d / 2.0, length)).unwrap();
    let r = d / 2.0;
    s.done_with(&part, Json::obj().set("nominal", nominal).set("diameter", d).set("fit", fit_name.as_str()).set("bmin", [-r, -r, 0.0]).set("bmax", [r, r, length]));
}