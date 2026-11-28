//! title: Lever can press
//! description: A bench can-crusher press: a welded I-beam C-frame on a folded base plate, a can chamber with a viewing slot, two guide rods under a head plate bolted to the arm, and a ram (crosshead, ratchet bar, platen, plunger) driven by a fork lever through twin toggle links. Every dimension follows the parameters; the lever, links and ram are jointed so the press can be animated (press-stroke animation).
//! api: 1.16
//! budget: 240s
use lime_recipe::{Json, Part, Session};
use lime_recipe::geom2d::{Poly, Pt, Region};

const PI: f64 = std::f64::consts::PI;
/// The ram rides a hinge this far behind it: over the stroke its arc is straight to a fraction of a tenth.
pub const RAM_PIVOT: f64 = 200000.0;

// ---------------------------------------------------------------- helpers
fn put(s: &mut Session, p: &Part, j: Json, label: &str) {
    let j = j.set("label", label);
    if let Err(e) = s.apply(p, j) {
        s.refuse(&format!("{label}: {}", e.reason));
    }
}

fn prim(s: &mut Session, p: &Part, op: &str, kind: &str, a: Json, label: &str) {
    put(s, p, a.set("kind", "boolean").set("op", op).set("primitive", kind), label);
}

fn bx(s: &mut Session, p: &Part, op: &str, c: [f64; 3], d: [f64; 3], label: &str) {
    prim(s, p, op, "box", Json::obj().set("dx", d[0]).set("dy", d[1]).set("dz", d[2]).set("centre", c), label);
}

fn axis_turn(axis: &str) -> [f64; 3] {
    match axis {
        "x" => [0.0, 90.0, 0.0],
        "y" => [90.0, 0.0, 0.0],
        _ => [0.0, 0.0, 0.0],
    }
}

fn cyl(s: &mut Session, p: &Part, op: &str, c: [f64; 3], r: f64, h: f64, axis: &str, label: &str) {
    prim(s, p, op, "cylinder", Json::obj().set("radius", r).set("height", h).set("centre", c).set("turn", axis_turn(axis)), label);
}

fn tube(s: &mut Session, p: &Part, c: [f64; 3], r_out: f64, r_in: f64, h: f64, axis: &str, label: &str) {
    prim(s, p, "fuse", "tube", Json::obj().set("radius", r_out).set("innerRadius", r_in).set("height", h).set("centre", c).set("turn", axis_turn(axis)), label);
}

/// A hex (nut or bolt head), `across` flats, `h` thick, on `axis`.
fn hex(s: &mut Session, p: &Part, c: [f64; 3], across: f64, h: f64, axis: &str, label: &str) {
    let mut t = axis_turn(axis);
    if axis == "z" { t = [0.0, 0.0, 30.0]; }
    prim(s, p, "fuse", "polygon", Json::obj().set("sides", 6.0).set("across", across).set("flats", true).set("height", h).set("centre", c).set("turn", t), label);
}

/// A nut with its washer: washer first (against `face`), hex beyond it; `dir` ±1 along `axis`.
fn nut_washer(s: &mut Session, p: &Part, at: [f64; 3], axis: &str, dir: f64, bolt_r: f64, label: &str) {
    let k = match axis { "x" => 0, "y" => 1, _ => 2 };
    let mut w = at;
    w[k] += dir * 0.45;
    cyl(s, p, "fuse", w, bolt_r * 2.1, 1.5, axis, &format!("{label} washer"));
    let mut n = at;
    n[k] += dir * (1.0 + bolt_r * 0.8 * 0.5);
    hex(s, p, n, bolt_r * 3.4, bolt_r * 0.8 * 1.0 + 0.0001, axis, &format!("{label} nut"));
    // bolt end standing proud of the nut, chamfered
    let mut e = at;
    e[k] += dir * (1.0 + bolt_r * 0.8 + 0.7);
    cyl(s, p, "fuse", e, bolt_r * 0.92, 2.0, axis, &format!("{label} thread end"));
}

/// All loops of a region (every piece) as one extrude `loops` list.
fn loops_of(r: &Region) -> Json {
    let mut all: Vec<Json> = Vec::new();
    for piece in r.to_loops() {
        if let Some(ls) = piece.as_array() {
            for l in ls.iter() { all.push(l.clone()); }
        }
    }
    Json::Arr(all)
}

/// Extrude a region drawn in the XZ plane ([x, z]) between y0 and y1.
fn xz_extrude(r: &Region, op: &str, y0: f64, y1: f64) -> Json {
    // the plane turned 90° about X: U = +X, V = +Z, W = -Y; start at the far (+Y) side and go back
    Json::obj().set("kind", "extrude").set("op", op).set("origin", [0.0, y1, 0.0]).set("turn", [90.0, 0.0, 0.0])
        .set("depth", y1 - y0).set("loops", loops_of(r))
}

fn circle_at(c: Pt, r: f64, n: u32) -> Poly {
    let mut pts: Vec<Pt> = Vec::new();
    for i in 0..n {
        let a = 2.0 * PI * (i as f64) / (n as f64);
        pts.push([c[0] + r * a.cos(), c[1] + r * a.sin()]);
    }
    Poly::new(pts)
}

/// The outline round two circles (a stadium, tapered when the radii differ).
fn capsule(a: Pt, ra: f64, b: Pt, rb: f64) -> Poly {
    let d = [b[0] - a[0], b[1] - a[1]];
    let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
    let ang = d[1].atan2(d[0]);
    let beta = ((ra - rb) / len).clamp(-0.99, 0.99).acos();
    let n = 24;
    let mut pts: Vec<Pt> = Vec::new();
    for i in 0..=n {
        let t = ang + beta + (2.0 * PI - 2.0 * beta) * (i as f64) / (n as f64);
        pts.push([a[0] + ra * t.cos(), a[1] + ra * t.sin()]);
    }
    for i in 0..=n {
        let t = ang - beta + 2.0 * beta * (i as f64) / (n as f64);
        pts.push([b[0] + rb * t.cos(), b[1] + rb * t.sin()]);
    }
    Poly::new(pts)
}

fn new_box(s: &mut Session, c: [f64; 3], d: [f64; 3], name: &str) -> Part {
    s.solid_new(Json::obj().set("primitive", "box").set("dx", d[0]).set("dy", d[1]).set("dz", d[2]).set("centre", c).set("name", name))
        .unwrap_or_else(|e| s.refuse(&format!("{name}: {}", e.reason)))
}

fn joint(s: &mut Session, p: &Part, pivot: [f64; 3], axis: [f64; 3], min: f64, max: f64) {
    let j = Json::obj().set("kind", "hinge").set("pivot", pivot).set("axis", axis).set("min", min).set("max", max);
    if let Err(e) = s.joint(p, j) {
        s.refuse(&format!("joint {}: {}", p.object, e.reason));
    }
}

/// Ram pin height for a crank angle (deg): the lever pivot at (0, zp), crank `r`, link `l`, ram on x = 0.
pub fn ram_z(zp: f64, r: f64, l: f64, theta: f64) -> f64 {
    let t = theta.to_radians();
    zp + r * t.sin() - (l * l - (r * t.cos()).powi(2)).sqrt()
}

// ---------------------------------------------------------------- main
fn main() {
    let s0 = Session::start();
    let h = s0.number("height", 300.0).range(200.0, 450.0).unit("mm").label("Frame height").help("Base to the top of the arm").get();
    let beam = s0.number("beam_width", 50.0).range(36.0, 80.0).unit("mm").label("Beam flange width").get();
    let rc = s0.number("chamber_radius", 40.0).range(25.0, 70.0).unit("mm").label("Chamber bore radius").help("A 330 ml can is about 33 mm").get();
    let hc = s0.number("chamber_height", 70.0).range(32.0, 150.0).unit("mm").label("Chamber height").get();
    let r = s0.number("crank", 35.0).range(15.0, 60.0).unit("mm").label("Crank throw").help("Lever pivot to link pin; the stroke is about twice this").get();
    let l = s0.number("link", 110.0).range(60.0, 220.0).unit("mm").label("Link length").help("Pin to pin").get();
    let lh = s0.number("lever", 260.0).range(120.0, 500.0).unit("mm").label("Lever length").help("Pivot to the grip").get();
    let th0 = s0.number("crank_up", 100.0).range(90.0, 150.0).unit("deg").label("Crank angle, ram up").help("From +X toward +Z; 90 is straight up").get();
    let th1 = s0.number("crank_down", 250.0).range(200.0, 270.0).unit("deg").label("Crank angle, ram down").get();
    let hoff = s0.number("handle_angle", 40.0).range(0.0, 90.0).unit("deg").label("Handle behind crank").help("How far the handle trails the crank arm").get();
    let crush = s0.number("crushed", 10.0).range(4.0, 30.0).unit("mm").label("Crushed can height").help("Plunger height above the floor at the bottom of the stroke").get();
    let teeth = s0.toggle("rack_teeth", true).label("Ratchet teeth on the bar").get();
    let mut s = s0;

    // ---------------- layout
    let bt = 8.0; // base plate
    let zb = bt; // floor
    let hw = beam * 0.5;
    let da = 40.0; // arm depth
    let tf = 6.0; // flange
    let zp = h - da * 0.5; // lever pivot
    let xrod = rc + 22.0; // guide rods on x = ±xrod
    let rod_r = 6.0;
    let xf = -(xrod + 26.0); // front of the arm
    let xs0 = rc + 58.0; // front face of the spine
    let ds = 40.0; // spine depth
    let yl0 = hw + 1.0; // lever plate, inner face
    let tl = 6.0;
    let yk0 = yl0 + tl + 1.5; // link, inner face
    let tk = 6.0;
    let ylug = yk0 - 1.0; // crosshead lugs stop short of the links

    if l <= r + 10.0 { s.refuse("The link must be at least 10 mm longer than the crank throw."); }
    let zr0 = ram_z(zp, r, l, th0);
    let zr1 = ram_z(zp, r, l, th1);
    let d_plunger = zr1 - (zb + crush); // ram pin to plunger face
    let neck = hc - 20.0 + crush - 10.0; // keeps the platen 4 mm over the chamber at the bottom
    let neck = neck.max(4.0);
    let rack_len = d_plunger - 7.0 - 14.0 - neck - 12.0;
    let head_bot = h - da - 10.0;
    if zr0 + 13.0 > head_bot - 2.0 {
        s.refuse(&format!("The crosshead would hit the head plate at the top of the stroke ({:.1} mm over); lengthen the link or lower the crank.", zr0 + 13.0 - head_bot + 2.0));
    }
    if rack_len < 12.0 {
        s.refuse(&format!("No room for the ratchet bar ({:.1} mm): raise the frame, lower the chamber or shorten the link.", rack_len));
    }
    let c0: Pt = [r * th0.to_radians().cos(), zp + r * th0.to_radians().sin()];
    let psi0 = (th0 - hoff).to_radians();
    let g0: Pt = [lh * psi0.cos(), zp + lh * psi0.sin()];
    s.log(&format!("ram pin z {:.1} → {:.1} (stroke {:.1}); plunger at rest {:.1} over the floor", zr0, zr1, zr0 - zr1, zr0 - d_plunger - zb));

    // ================================================================ Frame (C-frame I-beam + base)
    let base_x0 = xf - 12.0;
    let base_x1 = xs0 + ds + 18.0;
    let base_w = 2.0 * (rc + 30.0);
    let frame = new_box(&mut s, [(base_x0 + base_x1) * 0.5, 0.0, bt * 0.5], [base_x1 - base_x0, base_w, bt], "Frame");
    // folded front lip and side lips of the base sheet
    bx(&mut s, &frame, "fuse", [base_x0 + 3.0, 0.0, bt + 7.0], [6.0, base_w, 16.0], "front lip");
    bx(&mut s, &frame, "fuse", [(base_x0 + base_x1) * 0.5, base_w * 0.5 - 3.0, bt + 4.0], [base_x1 - base_x0, 6.0, 10.0], "left lip");
    bx(&mut s, &frame, "fuse", [(base_x0 + base_x1) * 0.5, -base_w * 0.5 + 3.0, bt + 4.0], [base_x1 - base_x0, 6.0, 10.0], "right lip");
    put(&mut s, &frame, Json::obj().set("kind", "fillet").set("size", 2.5).set("edges", Json::obj().set("fromNode", "front lip").set("filter", "convex")), "lip round");
    for (x, y) in [(base_x0 + 18.0, base_w * 0.5 - 16.0), (base_x0 + 18.0, -base_w * 0.5 + 16.0), (base_x1 - 14.0, base_w * 0.5 - 16.0), (base_x1 - 14.0, -base_w * 0.5 + 16.0)] {
        cyl(&mut s, &frame, "cut", [x, y, bt * 0.5], 4.5, bt + 4.0, "z", "bench hole");
    }

    // the C outline in XZ: arm on top, spine at the back with a flared foot, chamfered corners
    let outer = Poly::new(vec![
        [xf, h - da], [xf, h], [xs0 + ds - 30.0, h], [xs0 + ds, h - 30.0], [xs0 + ds, zb - 1.0],
        [xs0 - 22.0, zb - 1.0], [xs0, zb + 40.0], [xs0, h - da - 16.0], [xs0 - 16.0, h - da],
    ]);
    let outline = Region::from_poly(&outer);
    let inner = outline.offset_miter(-tf);
    let flanges = outline.difference(&inner);
    put(&mut s, &frame, xz_extrude(&flanges, "fuse", -hw, hw), "flanges");
    put(&mut s, &frame, xz_extrude(&inner, "fuse", -4.0, 4.0), "web");
    // lightening holes in the spine web
    let spine_mid = xs0 + ds * 0.5 - 2.0;
    let mut zh = zb + 70.0;
    while zh < h - da - 40.0 {
        cyl(&mut s, &frame, "cut", [spine_mid, 0.0, zh], 9.0, 12.0, "y", "lightening hole");
        zh += 42.0;
    }
    // pivot: a welded tube through the web, a shaft with head and nut
    tube(&mut s, &frame, [0.0, 0.0, zp], 13.0, 8.0, 2.0 * hw - 2.0, "y", "pivot tube");
    // the shaft ends just past the lever plates, held by thin retaining collars: the links pass over them
    cyl(&mut s, &frame, "fuse", [0.0, 0.0, zp], 8.0, 2.0 * (yl0 + tl + 1.0), "y", "pivot shaft");
    for side in [-1.0, 1.0] {
        tube(&mut s, &frame, [0.0, side * (yl0 + tl + 0.65), zp], 11.0, 7.0, 0.7, "y", "retaining collar");
    }
    // head-plate bolt holes in the bottom flange (beside the web)
    for x in [-xrod, xrod] {
        for y in [-16.0, 16.0] {
            cyl(&mut s, &frame, "cut", [x, y, h - da + tf * 0.5], 4.4, tf + 2.0, "z", "head bolt hole");
        }
    }
    s.log("frame built");

    // ================================================================ Guides (rods, head plate, bolts)
    let guides = new_box(&mut s, [0.0, 0.0, head_bot + 5.0], [2.0 * xrod + 24.0, 48.0, 10.0], "Guide rods");
    for x in [-xrod, xrod] {
        cyl(&mut s, &guides, "fuse", [x, 0.0, (head_bot + zb + 9.0) * 0.5], rod_r, head_bot - zb + 9.0, "z", "rod");
        // foot: a turned boss standing on the floor, a lock nut over it
        prim(&mut s, &guides, "fuse", "cone", Json::obj().set("radius", 11.0).set("topRadius", 9.0).set("height", 10.0).set("centre", [x, 0.0, zb + 5.0]), "rod foot");
        hex(&mut s, &guides, [x, 0.0, zb + 14.0], 17.0, 7.0, "z", "rod lock nut");
    }
    for x in [-xrod, xrod] {
        // rod tops through the plate, domed nuts
        hex(&mut s, &guides, [x, 0.0, head_bot - 3.5], 17.0, 8.0, "z", "rod nut");
        for y in [-16.0, 16.0] {
            hex(&mut s, &guides, [x, y, head_bot - 2.5], 13.0, 6.0, "z", "head bolt");
            cyl(&mut s, &guides, "fuse", [x, y, h - da + tf * 0.5], 4.0, tf + 1.0, "z", "head bolt shank");
            nut_washer(&mut s, &guides, [x, y, h - da + tf + 0.4], "z", 1.0, 4.0, "head bolt");
        }
    }
    s.log("guides built");

    // ================================================================ Chamber
    let chamber = s.solid_new(Json::obj().set("primitive", "tube").set("radius", rc + 4.0).set("innerRadius", rc)
        .set("height", hc).set("centre", [0.0, 0.0, zb + hc * 0.5 + 0.4]).set("name", "Chamber")).unwrap();
    tube(&mut s, &chamber, [0.0, 0.0, zb + 3.4], rc + 9.0, rc + 1.0, 6.0, "z", "foot flange");
    tube(&mut s, &chamber, [0.0, 0.0, zb + hc - 2.6], rc + 6.0, rc + 1.0, 6.0, "z", "rim band");
    // viewing slot in the front wall
    put(&mut s, &chamber, Json::obj().set("kind", "boolean").set("op", "cut").set("primitive", "box").set("dx", 20.0).set("dy", rc * 0.7).set("dz", hc - 26.0)
        .set("centre", [-rc - 2.0, 0.0, zb + 0.4 + hc * 0.5 + 1.0]), "viewing slot");
    for i in 0..6 {
        let a = (30.0 + 60.0 * i as f64).to_radians();
        hex(&mut s, &chamber, [(rc + 6.5) * a.cos(), (rc + 6.5) * a.sin(), zb + 8.4], 7.0, 3.0, "z", "flange bolt");
    }
    s.log("chamber built");

    // ================================================================ Ram (crosshead, bar, platen, plunger)
    let zx = zr0; // crosshead centre = ram pin
    let ram = new_box(&mut s, [0.0, 0.0, zx], [2.0 * xrod, 24.0, 14.0], "Ram");
    bx(&mut s, &ram, "fuse", [0.0, 0.0, zx], [34.0, 2.0 * ylug, 14.0], "crosshead lugs");
    for x in [-xrod, xrod] {
        cyl(&mut s, &ram, "fuse", [x, 0.0, zx], 11.0, 24.0, "z", "crosshead bush");
    }
    cyl(&mut s, &ram, "fuse", [0.0, 0.0, zx], 5.0, 2.0 * (yk0 + tk + 0.5), "y", "ram pin");
    for side in [-1.0, 1.0] {
        nut_washer(&mut s, &ram, [0.0, side * (yk0 + tk + 0.5), zx], "y", side, 5.0, "ram pin");
    }
    // ratchet bar
    let bar_top = zx - 7.0 + 1.0;
    let bar_bot = bar_top - rack_len - 2.0;
    bx(&mut s, &ram, "fuse", [0.0, 0.0, (bar_top + bar_bot) * 0.5], [16.0, 20.0, bar_top - bar_bot], "ratchet bar");
    if teeth {
        let mut polys: Vec<Poly> = Vec::new();
        let mut z = bar_bot + 5.0;
        while z + 6.0 < bar_top - 4.0 {
            polys.push(Poly::new(vec![[-8.5, z], [-5.0, z], [-8.5, z + 5.5]]));
            z += 6.0;
        }
        let r_teeth = Region::union_polys(&polys);
        put(&mut s, &ram, xz_extrude(&r_teeth, "cut", -11.0, 11.0), "ratchet teeth");
    }
    // platen
    let pl_mid = bar_bot + 1.0 - 6.0;
    bx(&mut s, &ram, "fuse", [0.0, 0.0, pl_mid], [2.0 * xrod, 24.0, 12.0], "platen");
    for x in [-xrod, xrod] {
        cyl(&mut s, &ram, "fuse", [x, 0.0, pl_mid], 11.0, 22.0, "z", "platen bush");
    }
    // plunger: neck and disc with a chamfered face
    let face = zx - d_plunger;
    cyl(&mut s, &ram, "fuse", [0.0, 0.0, (pl_mid - 5.0 + face + 12.0) * 0.5], rc * 0.42, pl_mid - 5.0 - face - 12.0, "z", "plunger neck");
    cyl(&mut s, &ram, "fuse", [0.0, 0.0, face + 8.0], rc - 1.2, 12.0, "z", "plunger disc");
    prim(&mut s, &ram, "fuse", "cone", Json::obj().set("radius", rc - 1.2).set("topRadius", rc - 3.2).set("height", 2.0).set("turn", [180.0, 0.0, 0.0]).set("centre", [0.0, 0.0, face + 1.0]), "plunger chamfer");
    for x in [-xrod, xrod] {
        cyl(&mut s, &ram, "cut", [x, 0.0, (zx + pl_mid) * 0.5], rod_r + 0.4, zx - pl_mid + 40.0, "z", "rod bore");
    }
    s.log("ram built");

    // ================================================================ Lever (fork of two plates, grip, crank pins)
    let p: Pt = [0.0, zp];
    let plate = Region::union_polys(&[capsule(c0, 11.0, p, 17.0), capsule(p, 15.0, g0, 9.0)])
        .difference(&Region::from_poly(&circle_at(p, 8.4, 48)));
    let lever = s.solid_new(Json::obj().set("feature", xz_extrude(&plate, "fuse", yl0, yl0 + tl)).set("name", "Lever"))
        .unwrap_or_else(|e| s.refuse(&format!("lever plate: {}", e.reason)));
    // grip: a tube between the plates and a rubber sleeve
    cyl(&mut s, &lever, "fuse", [g0[0], 0.0, g0[1]], 7.0, 2.0 * (yl0 + tl) + 4.0, "y", "grip tube");
    put(&mut s, &lever, xz_extrude(&plate, "fuse", -yl0 - tl, -yl0), "lever plate R");
    cyl(&mut s, &lever, "fuse", [g0[0], 0.0, g0[1]], 11.0, 2.0 * yl0 - 4.0, "y", "grip sleeve");
    for side in [-1.0, 1.0] {
        // crank pin stubs outboard of each plate, through the link, nut beyond
        cyl(&mut s, &lever, "fuse", [c0[0], side * (yl0 + tl + 0.5 * (tk + 2.0)), c0[1]], 5.0, tk + 2.0 + 1.0, "y", "crank pin");
        nut_washer(&mut s, &lever, [c0[0], side * (yk0 + tk + 0.5), c0[1]], "y", side, 5.0, "crank pin");
    }
    s.log("lever built");

    // ================================================================ Links (one each side)
    let rr: Pt = [0.0, zr0];
    let link_r = Region::from_poly(&capsule(c0, 9.0, rr, 9.0))
        .difference(&Region::union_polys(&[circle_at(c0, 5.4, 40), circle_at(rr, 5.4, 40)]));
    let link_l = s.solid_new(Json::obj().set("feature", xz_extrude(&link_r, "fuse", yk0, yk0 + tk)).set("name", "Link L")).unwrap();
    let link_rt = s.solid_new(Json::obj().set("feature", xz_extrude(&link_r, "fuse", -yk0 - tk, -yk0)).set("name", "Link R")).unwrap();

    // ================================================================ assembly and joints
    for m in [&guides, &chamber, &ram, &lever] {
        s.attach(m, &frame, [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]).unwrap_or_else(|e| s.refuse(&format!("attach: {}", e.reason)));
    }
    for lk in [&link_l, &link_rt] {
        s.attach(lk, &lever, [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]).unwrap_or_else(|e| s.refuse(&format!("attach link: {}", e.reason)));
    }
    let axis = [0.0, -1.0, 0.0]; // + turns from +X toward +Z, the way the crank angle counts
    joint(&mut s, &lever, [0.0, 0.0, zp], axis, -5.0, th1 - th0 + 5.0);
    for lk in [&link_l, &link_rt] {
        joint(&mut s, lk, [c0[0], 0.0, c0[1]], axis, -180.0, 180.0);
    }
    // a slide can't be keyed: the ram swings on a hinge far behind it (+ is down)
    joint(&mut s, &ram, [RAM_PIVOT, 0.0, zr0], axis, -0.5, 0.5);
    s.done_with(&frame, Json::obj().set("stroke", zr0 - zr1).set("ramTop", zr0).set("ramBottom", zr1).set("leverPivotZ", zp));
}
