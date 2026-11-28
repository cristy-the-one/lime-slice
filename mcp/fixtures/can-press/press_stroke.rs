//! title: Lever press stroke
//! description: Works a lever press built by the Lever can press recipe. Keys only the lever: press, dwell, return. The loops carry the links and the ram, so the stroke needs no frame height, crank or link length.
//! kind: animation
//! api: 1.20
use lime_recipe::anim::{Animation, Camera, Ease, Pose};
use lime_recipe::Session;

fn main() {
    let mut s = Session::start();
    let depth = s.number("depth", 1.0).range(0.1, 1.0).label("Stroke used").help("Fraction of the lever swing each stroke takes").get();
    let strokes = s.count("strokes", 2).range(1, 10).label("Strokes").get();
    let down_s = s.number("down_s", 1.6).range(0.3, 10.0).unit("s").label("Press time").get();
    let up_s = s.number("up_s", 1.0).range(0.3, 10.0).unit("s").label("Return time").get();
    let dwell = s.number("dwell", 0.4).range(0.0, 5.0).unit("s").label("Dwell at the bottom").get();
    let fps = s.count("fps", 24).range(6, 60).label("Frames per second").get();
    let lever = s.text("lever", "Lever").label("Lever member").get();
    let links = s.text("links", "Link L|Link R").label("Link members").get();
    let ram = s.text("ram", "Ram").label("Ram member").get();

    let rig = s.rig().unwrap_or_else(|e| s.refuse(&e.reason));
    // The build leaves 5° past the stroke on the lever. The swing is that travel, times depth.
    let max = rig.members.iter().find(|member| member.name == lever).and_then(|member| member.max)
        .unwrap_or_else(|| s.refuse(&format!("lever {lever} has no upper limit")));
    let swing = (max - 5.0) * depth;

    let mut a = Animation::new(fps);
    a.background("#2b2f36");
    a.camera(Camera::looking(-620.0, -720.0, 520.0));
    a.colour("Frame", "#e9e4d8");
    a.colour("Chamber", "#e8913a");
    a.colour(&format!("{ram}|Guide rods"), "#5fd39a");
    a.colour(&format!("{lever}|{links}"), "#f2622b");
    // Keys at the turning points. The loop solves every frame, so the links and the ram are not keyed.
    let cycle = down_s + dwell + up_s;
    for i in 0..strokes {
        let t0 = i as f64 * cycle;
        if i == 0 {
            a.key(t0, Pose::new().set(&lever, 0.0)).ease(Ease::Linear);
        }
        a.key(t0 + down_s, Pose::new().set(&lever, swing)).ease(Ease::InOut).hold(dwell);
        a.key(t0 + cycle, Pose::new().set(&lever, 0.0)).ease(Ease::InOut);
    }
    s.animate(&a).unwrap();
}
