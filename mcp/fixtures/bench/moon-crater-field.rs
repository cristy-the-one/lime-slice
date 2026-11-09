//! ---
//! plugin: moon-crater-field
//! title: Moon crater field
//! version: 2
//! description: Craters on a sphere: pick a sphere face (or the part's largest sphere face is used). Seeded power-law scatter of crater bowls: no overlaps, keep-clear zones, seam keep-out. No object: builds a demo moon. Refuses a part with no sphere face.
//! author: unknown
//! made-by: local-agent-mode-lime-slice
//! api: 1.3
//! lust: 7931db30
//! source-sha256: 53874eee0baf802ecbc8e662f5821f3b2e861532722a6b152c0b754f16649617
//! created: 2026-11-05
//! target: either
//! params: [{"name":"face","kind":"face","default":null,"label":"Sphere face","help":"The round face to put craters on. Empty: the part's largest sphere face.","curved":true},{"name":"count","kind":"count","default":10,"min":1,"max":120,"label":"Craters"},{"name":"seed","kind":"count","default":7,"min":1,"max":99999,"label":"Seed","help":"Same seed, same field"},{"name":"minDiameter","kind":"number","default":3,"min":1,"max":60,"step":0.5,"unit":"mm","label":"Smallest","help":"Smallest crater diameter"},{"name":"maxDiameter","kind":"number","default":16,"min":1,"max":100,"step":0.5,"unit":"mm","label":"Largest","help":"Largest crater diameter"},{"name":"skew","kind":"number","default":2.2,"min":1,"max":5,"step":0.1,"label":"Small-crater bias","help":"Higher = more small craters"},{"name":"depthRatio","kind":"number","default":0.18,"min":0.05,"max":0.5,"step":0.01,"label":"Depth / diameter","help":"How deep a bowl is, as a share of its width"},{"name":"peakOver","kind":"number","default":14,"min":0,"max":200,"step":0.5,"unit":"mm","label":"Central peak above","help":"Craters at least this wide get a peak in the middle; 0 = none"},{"name":"clearLat","kind":"number","default":90,"min":-90,"max":90,"unit":"deg","label":"Keep-clear latitude","help":"Centre of the crater-free spot (90 = north pole)"},{"name":"clearLon","kind":"number","default":0,"min":-180,"max":180,"unit":"deg","label":"Keep-clear longitude","help":"Centre of the crater-free spot"},{"name":"clearDeg","kind":"number","default":18,"min":0,"max":90,"unit":"deg","label":"Keep-clear radius","help":"A landing site no crater touches; 0 = none"},{"name":"avoid","kind":"text","default":"","label":"Also avoid","help":"More crater-free spots as lat,lon,radius; ... in degrees, e.g. existing big craters","maxLen":400},{"name":"allowOverlap","kind":"toggle","default":false,"label":"Allow overlap","help":"Craters may overlap; overlapping rims can leave slivers"},{"name":"seamLon","kind":"number","default":180,"min":-180,"max":180,"unit":"deg","label":"Seam longitude","help":"Where the sphere's own seam runs (the kernel is unreliable there)"},{"name":"seamBand","kind":"number","default":35,"min":0,"max":90,"unit":"deg","label":"Seam keep-out","help":"Craters stay this far from the seam; 0 = ignore"},{"name":"rimRatio","kind":"number","default":0,"min":0,"max":0.3,"step":0.01,"label":"Rim / diameter","help":"Raised rim height as a share of width. 0 = bowls only; rims on many small craters can trip the kernel"},{"name":"verbose","kind":"toggle","default":false,"label":"Log each crater"}]
//! ---
// Plugin: craters on a sphere. Pick a sphere face of the part (or leave it empty: the largest
// sphere face is used; no part at all builds a demo moon). Sizes follow a power law: many small
// craters, few large ones.
use lime_recipe::{Json, Session};
use ingredients::lunar_craters::*;

// Least-squares sphere centre for points known to lie on a sphere of radius r.
fn fit_centre(pts: &Vec<[f64; 3]>, r: f64, start: [f64; 3]) -> Option<[f64; 3]> {
    let mut c = start;
    for _ in 0..30 {
        let mut a = [[0.0f64; 3]; 3];
        let mut g = [0.0f64; 3];
        for p in pts.iter() {
            let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
            let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            if l < 1e-9 { continue; }
            let u = [d[0] / l, d[1] / l, d[2] / l];
            let res = l - r;
            // residual l - r, d(l)/dc = -u: solve (J^T J) step = -J^T res
            for i in 0..3 {
                g[i] += -u[i] * res;
                for j in 0..3 { a[i][j] += u[i] * u[j]; }
            }
        }
        for i in 0..3 { a[i][i] += 1e-9; }
        // Gauss-Newton: (sum u u^T) step = sum u * res, where g = -sum u * res
        let b = [-g[0], -g[1], -g[2]];
        // Gaussian elimination
        let mut m = [[0.0f64; 4]; 3];
        for i in 0..3 { for j in 0..3 { m[i][j] = a[i][j]; } m[i][3] = b[i]; }
        for col in 0..3 {
            let mut piv = col;
            for row in col + 1..3 { if m[row][col].abs() > m[piv][col].abs() { piv = row; } }
            if m[piv][col].abs() < 1e-12 { return None; }
            let tmp = m[col]; m[col] = m[piv]; m[piv] = tmp;
            for row in 0..3 {
                if row == col { continue; }
                let f = m[row][col] / m[col][col];
                for k in col..4 { m[row][k] -= f * m[col][k]; }
            }
        }
        let step = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
        c = [c[0] + step[0], c[1] + step[1], c[2] + step[2]];
        if step[0].abs() + step[1].abs() + step[2].abs() < 1e-7 { break; }
    }
    let mut worst = 0.0f64;
    for p in pts.iter() {
        let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        worst = worst.max((l - r).abs());
    }
    if worst > 0.03 * r + 0.05 { None } else { Some(c) }
}

fn ob(oid: &str) -> Json {
    if oid.is_empty() { Json::obj() } else { Json::obj().set("object", oid) }
}
fn jf(r: &Json, p: &str) -> Option<f64> {
    match r.at(p) { Some(x) => x.as_f64(), None => None }
}
fn jb(r: &Json, p: &str) -> bool {
    match r.at(p) { Some(x) => x.as_bool().unwrap_or(false), None => false }
}

fn main() {
    let mut s = Session::start();
    // Most-used controls first.
    let sphere_face = s.face("face").curved().label("Sphere face")
        .help("The round face to put craters on. Empty: the part's largest sphere face.").get();
    let count = s.count("count", 10).range(1, 120).label("Craters").get();
    let seed = s.count("seed", 7).range(1, 99999).label("Seed").help("Same seed, same field").get();
    let min_d = s.number("minDiameter", 3.0).range(1.0, 60.0).step(0.5).unit("mm").label("Smallest").help("Smallest crater diameter").get();
    let max_d = s.number("maxDiameter", 16.0).range(1.0, 100.0).step(0.5).unit("mm").label("Largest").help("Largest crater diameter").get();
    let skew = s.number("skew", 2.2).range(1.0, 5.0).step(0.1).label("Small-crater bias").help("Higher = more small craters").get();
    let depth_ratio = s.number("depthRatio", 0.18).range(0.05, 0.5).step(0.01).label("Depth / diameter").help("How deep a bowl is, as a share of its width").get();
    let peak_over = s.number("peakOver", 14.0).range(0.0, 200.0).step(0.5).unit("mm").label("Central peak above").help("Craters at least this wide get a peak in the middle; 0 = none").get();
    let clear_lat = s.number("clearLat", 90.0).range(-90.0, 90.0).unit("deg").label("Keep-clear latitude").help("Centre of the crater-free spot (90 = north pole)").get();
    let clear_lon = s.number("clearLon", 0.0).range(-180.0, 180.0).unit("deg").label("Keep-clear longitude").help("Centre of the crater-free spot").get();
    let clear_deg = s.number("clearDeg", 18.0).range(0.0, 90.0).unit("deg").label("Keep-clear radius").help("A landing site no crater touches; 0 = none").get();
    // Rarely changed.
    let zones_txt = s.text("avoid", "").max_len(400).label("Also avoid").help("More crater-free spots as lat,lon,radius; ... in degrees, e.g. existing big craters").get();
    let overlap = s.toggle("allowOverlap", false).label("Allow overlap").help("Craters may overlap; overlapping rims can leave slivers").get();
    let seam_lon = s.number("seamLon", 180.0).range(-180.0, 180.0).unit("deg").label("Seam longitude").help("Where the sphere's own seam runs (the kernel is unreliable there)").get();
    let seam_band = s.number("seamBand", 35.0).range(0.0, 90.0).unit("deg").label("Seam keep-out").help("Craters stay this far from the seam; 0 = ignore").get();
    let rim_ratio = s.number("rimRatio", 0.0).range(0.0, 0.3).step(0.01).label("Rim / diameter").help("Raised rim height as a share of width. 0 = bowls only; rims on many small craters can trip the kernel").get();
    let verbose = s.toggle("verbose", false).label("Log each crater").get();

    let obj = s.object();
    // Raw calls act on the selected object unless told which one.
    let oid: String = match s.context().at("object") { Some(x) => x.as_str().unwrap_or("").to_string(), None => String::new() };
    let part = match obj {
        Some(p) => p,
        None => s.solid_new(Json::obj().set("primitive", "sphere").set("radius", 45.0)).unwrap(),
    };
    let had_object = s.object().is_some();

    // The API gives no part name inside a recipe, so the refusals say "This part".
    let name = String::from("This part");

    // Which face: the pick, else the largest sphere face.
    let mut face_index: i64 = -1;
    let mut radius = 0.0;
    if format!("{:?}", sphere_face.value) == "Null" {
        let found = s.call("faces_find", ob(&oid).set("kind", "sphere").set("limit", 100.0));
        let mut best = 0.0;
        if let Ok(f) = found {
            for i in 0..100 {
                let a = jf(&f, &format!("faces.{}.areaMm2", i)).unwrap_or(-1.0);
                if a < 0.0 { break; }
                if a > best {
                    best = a;
                    face_index = jf(&f, &format!("faces.{}.index", i)).unwrap_or(-1.0) as i64;
                    radius = jf(&f, &format!("faces.{}.radiusMm", i)).unwrap_or(0.0);
                }
            }
        }
        if face_index < 0 || radius <= 0.0 {
            s.refuse(&format!("{} has no sphere face: Moon crater field puts craters on a ball. Pick a sphere face.", name));
            return;
        }
    } else {
        match s.pick_face(&part, &sphere_face) {
            Ok(p) => {
                if p.kind != "sphere" || p.radius.is_none() {
                    s.refuse(&format!("The picked face is {}, not a sphere: Moon crater field puts craters on a ball. Pick a sphere face.", if p.kind == "plane" { "flat".to_string() } else { p.kind.clone() }));
                    return;
                }
                face_index = p.index as i64;
                radius = p.radius.unwrap();
            }
            Err(e) => { s.refuse(&format!("{} {}", name, e.reason)); return; }
        }
    }

    // Centre: shoot rays at the part from outside and keep the hits on that face, then fit the
    // sphere centre with the known radius.
    let (mn, mx) = s.bounds(&part).unwrap();
    let mid = [(mn[0] + mx[0]) / 2.0, (mn[1] + mx[1]) / 2.0, (mn[2] + mx[2]) / 2.0];
    let ext = [(mx[0] - mn[0]) / 2.0, (mx[1] - mn[1]) / 2.0, (mx[2] - mn[2]) / 2.0];
    let reach = ext[0] + ext[1] + ext[2] + 10.0;
    let mut pts: Vec<[f64; 3]> = Vec::new();
    let grid = [-0.8, -0.4, 0.0, 0.4, 0.8];
    for axis in 0..3 {
        let (a1, a2) = ((axis + 1) % 3, (axis + 2) % 3);
        for sign in [-1.0, 1.0] {
            for g1 in grid.iter() {
                for g2 in grid.iter() {
                    let mut o = mid;
                    o[axis] += sign * reach;
                    o[a1] += g1 * ext[a1];
                    o[a2] += g2 * ext[a2];
                    let mut d = [0.0, 0.0, 0.0];
                    d[axis] = -sign;
                    if let Ok(h) = s.call("surface_at", ob(&oid).set("point", o.to_vec()).set("direction", d.to_vec())) {
                        if jb(&h, "hit") && jf(&h, "faceIndex").unwrap_or(-1.0) as i64 == face_index {
                            pts.push([jf(&h, "point.0").unwrap_or(0.0), jf(&h, "point.1").unwrap_or(0.0), jf(&h, "point.2").unwrap_or(0.0)]);
                        }
                    }
                }
            }
        }
    }
    let mut centre = None;
    if pts.len() >= 4 {
        let n = pts.len() as f64;
        let mut pm = [0.0, 0.0, 0.0];
        for p in pts.iter() { for i in 0..3 { pm[i] += p[i] / n; } }
        // start: from the hits' mean, a radius toward the part's middle
        let dv = [mid[0] - pm[0], mid[1] - pm[1], mid[2] - pm[2]];
        let dl = (dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]).sqrt().max(1e-9);
        let start = [pm[0] + dv[0] / dl * radius, pm[1] + dv[1] / dl * radius, pm[2] + dv[2] / dl * radius];
        centre = fit_centre(&pts, radius, start);
    }
    let centre = match centre {
        Some(c) => c,
        None => {
            s.refuse(&format!("{}: could not locate the centre of the sphere face (too little of it is visible). Pick a larger sphere face.", name));
            return;
        }
    };
    s.log(&format!("sphere face {}: radius {:.2}, centre {:.2} {:.2} {:.2} ({} hits)", face_index, radius, centre[0], centre[1], centre[2], pts.len()));
    // Reads (bounds, faces, rays) are in the part's own frame, but edit numbers are read in model
    // space, where a part with an assembly pose sits elsewhere. A harmless probe tells where.
    let mut shift = [0.0, 0.0, 0.0];
    let test = Json::obj().set("kind", "boolean").set("op", "cut").set("primitive", "sphere").set("radius", 0.5)
        .set("centre", vec![mn[0] - 5.0, mn[1] - 5.0, mn[2] - 5.0]);
    if let Err(e) = s.call("model_probe", ob(&oid).set("op", test)) {
        if let Some(i) = e.reason.find("sits at (") {
            let rest = &e.reason[i + 9..];
            if let Some(j) = rest.find(')') {
                let v: Vec<f64> = rest[..j].split(',').filter_map(|t| t.trim().parse::<f64>().ok()).collect();
                if v.len() == 3 { shift = [v[0], v[1], v[2]]; }
            }
        }
    }
    s.log(&format!("pose shift {:.2} {:.2} {:.2}", shift[0], shift[1], shift[2]));
    let body = body_at([centre[0] + shift[0], centre[1] + shift[1], centre[2] + shift[2]], radius);

    let (lo, hi) = (min_d.min(max_d), max_d.max(min_d));
    let mut rng = Rng::new(seed as u64);
    let mut zones = parse_zones(&zones_txt);
    if clear_deg > 0.0 { zones.push([clear_lat, clear_lon, clear_deg]); }
    let mut placed = 0;
    let mut tries = 0;
    while placed < count && tries < count * 40 {
        tries += 1;
        let u = rng.next();
        let lat = (2.0 * rng.next() - 1.0).asin().to_degrees();
        let lon = rng.next() * 360.0 - 180.0;
        let d = lo * (hi / lo).powf(u.powf(skew));
        // stay out of keep-clear zones (landing site, named craters) and, unless allowed, other craters
        let half_deg = (d * 0.6 / body.radius).to_degrees(); // includes the rim
        if near_seam(lat, lon, half_deg, seam_lon, seam_band) { continue; }
        if zones.iter().any(|z| ang_dist(lat, lon, z[0], z[1]) < z[2] + half_deg) { continue; }
        let c = Crater { lat, lon, diameter: d, depth: d * depth_ratio, rim: d * rim_ratio, peak: peak_over > 0.0 && d >= peak_over };
        let got = crater(&mut s, &part, &body, &c);
        if verbose { s.log(&format!("lat {:.1} lon {:.1} d {:.1}: {} steps", lat, lon, d, got)); }
        if got > 0 {
            placed += 1;
            if !overlap { zones.push([lat, lon, half_deg * 1.1]); }
        }
    }
    s.log(&format!("{} craters placed in {} tries", placed, tries));
    s.done_with(&part, Json::obj().set("craters", placed as f64));
}

// --- Ingredients from the library, added by recipe_run before the build; not part of the recipe. ---
#[allow(dead_code, unused_imports)]
mod ingredients {
pub mod lunar_craters {
// ingredient: lunar-craters v7 sha256:bf953c9a23d54b11ea0958140d7ca1bd38a17c6d1816d52d4fa0acf436bef63e
use lime_recipe::{Json, Part, Session};

pub struct Body {
    pub centre: [f64; 3],
    pub radius: f64,
}

pub struct Crater {
    pub lat: f64,
    pub lon: f64,
    pub diameter: f64,
    pub depth: f64,
    pub rim: f64,
    pub peak: bool,
}

/// Read the body's centre and radius from its bounding box.
/// radius_override > 0 wins over the measured value.
pub fn body_of(s: &mut Session, part: &Part, radius_override: f64) -> Body {
    let (mn, mx) = s.bounds(part).unwrap();
    let c = [(mn[0] + mx[0]) / 2.0, (mn[1] + mx[1]) / 2.0, (mn[2] + mx[2]) / 2.0];
    let r = if radius_override > 0.0 {
        radius_override
    } else {
        ((mx[0] - mn[0]) + (mx[1] - mn[1]) + (mx[2] - mn[2])) / 6.0
    };
    Body { centre: c, radius: r }
}

/// A body with a known centre and radius (exact, no measuring).
pub fn body_at(centre: [f64; 3], radius: f64) -> Body {
    Body { centre, radius }
}

/// Parse "lat,lon,deg; lat,lon,deg" into keep-clear circles.
pub fn parse_zones(text: &str) -> Vec<[f64; 3]> {
    let mut out = Vec::new();
    for item in text.split(';') {
        let v: Vec<f64> = item.split(',').filter_map(|t| t.trim().parse::<f64>().ok()).collect();
        if v.len() == 3 { out.push([v[0], v[1], v[2]]); }
    }
    out
}

/// Unit vector for latitude / longitude (Z is north).
pub fn dir(lat: f64, lon: f64) -> [f64; 3] {
    let (la, lo) = (lat.to_radians(), lon.to_radians());
    [la.cos() * lo.cos(), la.cos() * lo.sin(), la.sin()]
}

pub fn at(b: &Body, n: [f64; 3], dist: f64) -> [f64; 3] {
    [b.centre[0] + n[0] * dist, b.centre[1] + n[1] * dist, b.centre[2] + n[2] * dist]
}

/// Turn that points a primitive's local +Z along (lat, lon).
pub fn turn_to(lat: f64, lon: f64) -> [f64; 3] {
    [0.0, 90.0 - lat, lon]
}

pub fn mat_mul(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut m = [[0.0; 3]; 3];
    for i in 0..3 { for j in 0..3 { m[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]; } }
    m
}

/// Turn (X, then Y, then Z, degrees) that points local +Z along (lat, lon)
/// after first spinning the primitive `spin` degrees about its own axis.
pub fn turn_spun(lat: f64, lon: f64, spin: f64) -> [f64; 3] {
    let (b, c, sp) = ((90.0 - lat).to_radians(), lon.to_radians(), spin.to_radians());
    let ry = [[b.cos(), 0.0, b.sin()], [0.0, 1.0, 0.0], [-b.sin(), 0.0, b.cos()]];
    let rz = [[c.cos(), -c.sin(), 0.0], [c.sin(), c.cos(), 0.0], [0.0, 0.0, 1.0]];
    let rs = [[sp.cos(), -sp.sin(), 0.0], [sp.sin(), sp.cos(), 0.0], [0.0, 0.0, 1.0]];
    let m = mat_mul(rz, mat_mul(ry, rs));
    // m = Rz(g) * Ry(be) * Rx(a)
    let be = (-m[2][0]).max(-1.0).min(1.0).asin();
    let a = m[2][1].atan2(m[2][2]);
    let g = m[1][0].atan2(m[0][0]);
    [a.to_degrees(), be.to_degrees(), g.to_degrees()]
}

/// Cut one crater. Returns the number of steps that applied (0..=4).
pub fn crater(s: &mut Session, part: &Part, b: &Body, c: &Crater) -> u32 {
    let r = b.radius;
    let half = (c.diameter / 2.0).min(r * 0.9);
    let depth = c.depth.max(0.2).min(half);
    let n = dir(c.lat, c.lon);
    let turn = turn_to(c.lat, c.lon);
    // Spheres get turned too, so their seams never line up with the body's
    // (coincident seams make the kernel drop a boolean).
    let twist = [17.0, 90.0 - c.lat, c.lon];
    let mut ok = 0;

    // Bowl: a sphere whose cap through the surface is `half` wide and `depth` deep.
    let rc = (half * half + depth * depth) / (2.0 * depth);
    let bowl = Json::obj()
        .set("kind", "boolean").set("op", "cut").set("primitive", "sphere")
        .set("radius", rc).set("centre", at(b, n, r - depth + rc)).set("turn", twist)
        .set("label", "crater bowl");

    // 1. Bowl first: the kernel is happier cutting a clean sphere.
    if s.apply(part, bowl.clone()).is_ok() { ok += 1; }

    // 2. Rim: a torus ring on the bowl's edge, top `rim` above the surface,
    //    then the same bowl again to trim the half of the ring that hangs inside.
    if c.rim > 0.05 {
        let tube = c.rim.max(c.diameter * 0.07);
        let lift = (r + c.rim - tube) / r;
        let ring_axial = (r * r - half * half).sqrt() * lift;
        // The kernel can refuse a ring that grazes an edge exactly: nudge, spin, retry.
        let mut rimmed = false;
        for (f, spin) in [(1.0, 0.0), (1.035, 41.0), (0.97, 97.0)] {
            let op = Json::obj()
                .set("kind", "boolean").set("op", "fuse").set("primitive", "torus")
                .set("radius", half * lift * f).set("tubeRadius", tube)
                .set("centre", at(b, n, ring_axial)).set("turn", turn_spun(c.lat, c.lon, spin))
                .set("label", "crater rim");
            if s.apply(part, op).is_ok() { rimmed = true; break; }
        }
        if rimmed {
            ok += 1;
            if s.apply(part, bowl.clone().set("label", "rim trim")).is_ok() { ok += 1; }
        }
    }

    // 3. Central peak for big, complex craters: a blunt cone rising from the floor.
    if c.peak {
        let pr = c.diameter * 0.11;
        let buried = 0.8;
        let h = depth * 0.6 + buried;
        let base = r - depth - buried;
        let op = Json::obj()
            .set("kind", "boolean").set("op", "fuse").set("primitive", "cone")
            .set("radius", pr).set("topRadius", pr * 0.25).set("height", h)
            .set("centre", at(b, n, base + h / 2.0)).set("turn", turn)
            .set("label", "central peak");
        if s.apply(part, op).is_ok() { ok += 1; }
    }
    ok
}

/// Tiny deterministic RNG (xorshift) so a seed always gives the same field.
pub struct Rng { state: u64 }

impl Rng {
    pub fn new(seed: u64) -> Rng { Rng { state: seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) | 1 } }
    pub fn next(&mut self) -> f64 {
        let mut x = self.state;
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        self.state = x;
        (x >> 11) as f64 / 9007199254740992.0
    }
}

/// True when a crater `half_deg` wide at (lat, lon) would reach the band of
/// `band` degrees either side of longitude `seam_lon` (a sphere primitive's seam,
/// where the kernel's booleans get unreliable).
pub fn near_seam(lat: f64, lon: f64, half_deg: f64, seam_lon: f64, band: f64) -> bool {
    if band <= 0.0 { return false; }
    let dl = ((lon - seam_lon + 540.0) % 360.0 - 180.0).abs();
    let widen = half_deg / lat.to_radians().cos().max(0.2);
    dl < band + widen
}

/// Angular distance between two lat/lon points, degrees.
pub fn ang_dist(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let a = dir(lat1, lon1);
    let b = dir(lat2, lon2);
    let d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).max(-1.0).min(1.0);
    d.acos().to_degrees()
}
}
}
