//! title: Lever press stroke
//! description: Works a lever press built by the Lever can press recipe: the lever pulls the crank through its swing, the twin toggle links follow and the ram runs down its guide rods and back, for a number of strokes. Give it the same frame height, crank, link and crank angles the press was built with.
//! kind: animation
//! api: 1.17
use lime_recipe::anim::{Animation, Camera, Ease, Pose};
use lime_recipe::Session;

const RAM_PIVOT: f64 = 200000.0;

fn ram_z(zp: f64, r: f64, l: f64, theta: f64) -> f64 {
    let t = theta.to_radians();
    zp + r * t.sin() - (l * l - (r * t.cos()).powi(2)).sqrt()
}

fn main() {
    let mut s = Session::start();
    let h = s.number("height", 300.0).range(200.0, 450.0).unit("mm").label("Frame height").help("As the press was built").get();
    let r = s.number("crank", 35.0).range(15.0, 60.0).unit("mm").label("Crank throw").get();
    let l = s.number("link", 110.0).range(60.0, 220.0).unit("mm").label("Link length").get();
    let th0 = s.number("crank_up", 100.0).range(90.0, 150.0).unit("deg").label("Crank angle, ram up").get();
    let th1 = s.number("crank_down", 250.0).range(200.0, 270.0).unit("deg").label("Crank angle, ram down").get();
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
    let lk = rig.group(&links);
    let zp = h - 20.0;
    let zr0 = ram_z(zp, r, l, th0);
    let c = |th: f64| -> (f64, f64) { (r * th.to_radians().cos(), zp + r * th.to_radians().sin()) };
    let (cx0, cz0) = c(th0);
    let phi0 = (zr0 - cz0).atan2(-cx0).to_degrees();
    let pose_at = |th: f64| -> Pose {
        let (cx, cz) = c(th);
        let zr = ram_z(zp, r, l, th);
        let phi = (zr - cz).atan2(-cx).to_degrees();
        let link_rel = (phi - phi0) - (th - th0);
        let ram_deg = ((zr0 - zr) / RAM_PIVOT).asin().to_degrees();
        let mut p = Pose::new().set(&lever, th - th0).set(&ram, ram_deg);
        for m in lk.names() { p = p.set(m, link_rel); }
        p
    };

    let mut a = Animation::new(fps);
    a.background("#2b2f36");
    a.camera(Camera::looking(-620.0, -720.0, 520.0));
    a.colour("Frame", "#e9e4d8");
    a.colour("Chamber", "#e8913a");
    a.colour(&format!("{}|Guide rods", ram), "#5fd39a");
    a.colour(&format!("{}|{}", lever, links), "#f2622b");
    // one key on every frame, posed exactly, so the links never leave the ram pin between keys
    let th_end = th0 + (th1 - th0) * depth;
    let ease = |u: f64| 0.5 - 0.5 * (std::f64::consts::PI * u.clamp(0.0, 1.0)).cos();
    let cycle = down_s + dwell + up_s;
    let end = cycle * strokes as f64;
    for t in lime_recipe::anim::frame_times(fps, end) {
        let k = (t / cycle).floor().min(strokes as f64 - 1.0);
        let tc = t - k * cycle;
        let th = if tc <= down_s {
            th0 + (th_end - th0) * ease(tc / down_s)
        } else if tc <= down_s + dwell {
            th_end
        } else {
            th_end + (th0 - th_end) * ease((tc - down_s - dwell) / up_s)
        };
        a.key(t, pose_at(th)).ease(Ease::Linear);
    }
    s.animate(&a).unwrap();
}
