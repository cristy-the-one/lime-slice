//! ---
//! plugin: corpus-pendulum-api-1-13
//! title: Corpus pendulum (API 1.13)
//! version: 1
//! description: A rod whose length swings in 0.75 s, and its period as a bar hung by its end, from lime_recipe::mech.
//! author: Lime Slice corpus
//! api: 1.13
//! source-sha256: edaba4ca70a1a394ef88130e01fc6327cb48837d349904d017bbc9462500cbfb
//! created: 2026-11-15
//! target: new
//! params: []
//! ---
use lime_recipe::mech::{compound_period, equivalent_length, pendulum_length, pendulum_period};
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    // A rod that swings in 0.75 s as a simple pendulum, and the same rod as a uniform bar hung by its end.
    let length = pendulum_length(0.75);
    let rod = s.solid_new(ops::cuboid(4.0, 4.0, length)).unwrap();
    let mass = 4.0 * 4.0 * length * 1.24 / 1000.0;
    let inertia = mass * length * length / 3.0;
    let bar = compound_period(inertia, mass, length / 2.0);
    s.done_with(&rod, Json::obj().set("lengthMm", length).set("simpleS", pendulum_period(length)).set("barS", bar).set("barLengthMm", equivalent_length(inertia, mass, length / 2.0)));
}
