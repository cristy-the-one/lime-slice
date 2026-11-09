//! ---
//! plugin: spiderweb-cut-on-a-part
//! title: Spiderweb cut on a part
//! version: 3
//! description: Cuts spiderwebs into a flat face: pick it, or the largest face facing up. reach 0 fills; depth 0 cuts through.
//! author: unknown
//! made-by: local-agent-mode-lime-slice
//! api: 1.3
//! lust: 7931db30
//! source-sha256: 1a235da3624287ac8973c3037821ccd54a95605d74078412335be5de10316b94
//! created: 2026-11-05
//! target: object
//! params: [{"name":"face","kind":"face","default":{"rule":"largest_up"},"label":"Face (click one; empty: the largest face facing up)","help":"A flat face to cut the webs into. Nothing picked: the largest flat face facing +Z."},{"name":"webs","kind":"count","default":2,"min":1,"max":12,"label":"Webs (widest free spots first)"},{"name":"centres","kind":"text","default":"","label":"Web centres (optional)","help":"Part-frame points 'x,y; x,y' (Z at the face) or 'x,y,z; ...' projected onto the face. Empty: the widest free spots.","maxLen":240},{"name":"spokes","kind":"count","default":8,"min":5,"max":16,"label":"Spokes per web"},{"name":"rings","kind":"count","default":3,"min":2,"max":7,"label":"Rings per web"},{"name":"hub","kind":"number","default":1.5,"min":0.5,"max":10,"step":0.1,"unit":"mm","label":"Solid hub radius"},{"name":"reach","kind":"number","default":0,"min":0,"max":200,"step":0.5,"unit":"mm","label":"Web radius (0: fill the free spot)"},{"name":"strand","kind":"number","default":0.8,"min":0.4,"max":5,"step":0.05,"unit":"mm","label":"Thread width"},{"name":"wall","kind":"number","default":1,"min":0.4,"max":10,"step":0.05,"unit":"mm","label":"Wall kept next to the face's edges and openings"},{"name":"sag","kind":"number","default":0.12,"min":0,"max":0.4,"step":0.01,"label":"Thread sag toward the hub"},{"name":"min_hole","kind":"number","default":1,"min":0.1,"max":50,"step":0.1,"unit":"mm2","label":"Smallest hole kept"},{"name":"depth","kind":"number","default":0,"min":0,"max":500,"step":0.1,"unit":"mm","label":"Cut depth (0: through the part)"}]
//! ---
// Spiderweb cut on a part: sagging-thread spiderwebs cut into a flat face of the given part,
// placed in the face's widest free spots (kept `wall` clear of its edges and openings) or at
// centres you give.
use lime_recipe::geom2d::Region;
use lime_recipe::{Json, Session};
use ingredients::spiderweb::*;

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn main() {
    let mut s = Session::start();
    let face_pick = s.face("face").rule("largest_up").label("Face (click one; empty: the largest face facing up)")
        .help("A flat face to cut the webs into. Nothing picked: the largest flat face facing +Z.").get();
    let webs = s.count("webs", 2).range(1, 12).label("Webs (widest free spots first)").get() as usize;
    let centres_txt = s.text("centres", "").max_len(240).label("Web centres (optional)")
        .help("Part-frame points 'x,y; x,y' (Z at the face) or 'x,y,z; ...' projected onto the face. Empty: the widest free spots.").get();
    let spokes = s.count("spokes", 8).range(5, 16).label("Spokes per web").get() as usize;
    let rings = s.count("rings", 3).range(2, 7).label("Rings per web").get() as usize;
    let hub = s.number("hub", 1.5).range(0.5, 10.0).step(0.1).unit("mm").label("Solid hub radius").get();
    let reach = s.number("reach", 0.0).range(0.0, 200.0).step(0.5).unit("mm").label("Web radius (0: fill the free spot)").get();
    let strand = s.number("strand", 0.8).range(0.4, 5.0).step(0.05).unit("mm").label("Thread width").get();
    let wall = s.number("wall", 1.0).range(0.4, 10.0).step(0.05).unit("mm").label("Wall kept next to the face's edges and openings").get();
    let sag = s.number("sag", 0.12).range(0.0, 0.4).step(0.01).label("Thread sag toward the hub").get();
    let min_hole = s.number("min_hole", 1.0).range(0.1, 50.0).step(0.1).unit("mm2").label("Smallest hole kept").get();
    let depth_in = s.number("depth", 0.0).range(0.0, 500.0).step(0.1).unit("mm").label("Cut depth (0: through the part)").get();

    let part = match s.object() {
        Some(p) => p,
        None => panic!("Pick the part to cut the spiderweb into: this plugin works on a part."),
    };

    // 1. The face: the one picked, or the largest flat face facing up (the rule).
    let picked = match s.pick_face(&part, &face_pick) {
        Ok(p) => p,
        Err(e) => panic!("No flat face to cut into: {}", e.reason),
    };
    let face: f64 = picked.index as f64;
    let fi = face as usize;

    // 2. The free area: the face's real outline (edges and every opening in it) inset by `wall`.
    let sec = match s.face_outline(&part, face, wall) {
        Ok(sec) => sec,
        Err(e) => panic!("Face {} cannot take a web, it must be a flat face ({}).", fi, e.reason),
    };
    let allowed: Region = sec.region.clone();
    if allowed.is_empty() {
        panic!("Face {} has no material left once a {} mm wall is kept along its edges and openings.", fi, wall);
    }
    let fr = sec.frame.clone();

    // 3. Where the webs go, in the face's own [u, v] frame.
    let proto = Web { spokes, rings, hub, reach, strand, sag, min_hole, phase: 0.3, seed: 0 };
    let need = min_web_radius(&proto);
    if reach > 0.0 && reach < need {
        panic!("A {} mm reach is too short for {} rings of {} mm thread around a {} mm hub; it needs at least {:.1} mm.", reach, rings, strand, hub, need);
    }
    let mut spots: Vec<([f64; 2], f64)> = Vec::new();
    let txt = centres_txt.trim().to_string();
    if !txt.is_empty() {
        for (k, item) in txt.split(';').enumerate() {
            let nums: Vec<f64> = item.split(',').filter_map(|t| t.trim().parse::<f64>().ok()).collect();
            if nums.len() < 2 {
                panic!("Web centre {} ('{}') is not a point: write x,y or x,y,z.", k + 1, item.trim());
            }
            let p = [nums[0], nums[1], if nums.len() > 2 { nums[2] } else { fr.origin[2] }];
            let d = [p[0] - fr.origin[0], p[1] - fr.origin[1], p[2] - fr.origin[2]];
            let uv = [dot(d, fr.u), dot(d, fr.v)];
            if !allowed.contains(uv) {
                panic!("Web centre {} ({}) is not on free material of face {}: it is on an opening or within the {} mm wall.", k + 1, item.trim(), fi, wall);
            }
            spots.push((uv, edge_distance(&allowed, uv)));
        }
    } else {
        spots = free_spots(&allowed, webs, wall, need, 0.05);
        if spots.is_empty() {
            let widest = deepest_point(&allowed, 0.05).map(|x| x.1).unwrap_or(0.0);
            panic!("The free area of face {} is too small for one web: its widest spot is {:.1} mm across inside the {} mm wall, and {} rings need {:.1} mm.", fi, 2.0 * widest, wall, rings, 2.0 * need);
        }
        if spots.len() < webs {
            s.log(&format!("{} of {} webs fit on face {}; the rest of the free area is narrower than {:.1} mm.", spots.len(), webs, fi, 2.0 * need));
        }
    }

    // 4. Each web in its own cell, so neighbours keep a wall between them.
    let centres: Vec<[f64; 2]> = spots.iter().map(|x| x.0).collect();
    let mut cuts: Vec<Json> = Vec::new();
    let mut holes = 0;
    let mut placed: Vec<Json> = Vec::new();
    let mut outside = 0.0;
    let mut all = Region::empty();
    for (i, sp) in spots.iter().enumerate() {
        let r = if reach > 0.0 { reach } else { sp.1 };
        if r < need {
            s.log(&format!("web {} left out: its spot is {:.1} mm wide, under the {:.1} mm a web needs.", i + 1, 2.0 * r, 2.0 * need));
            continue;
        }
        let mut w = proto.clone();
        w.reach = r;
        w.phase = 0.3 + 0.9 * i as f64;
        w.seed = i;
        let cell = web_cell(i, &centres, &allowed, wall);
        let made = web_cuts(sp.0, &cell, &w);
        for prof in made.iter() {
            all = all.union(prof);
            for piece in prof.to_loops() {
                cuts.push(sec.extrude("cut", 0.0, piece).set("label", "spiderweb"));
                holes += 1;
            }
        }
        let p3 = fr.point(sp.0);
        placed.push(Json::obj().set("centre", p3).set("reachMm", (r * 100.0).round() / 100.0).set("holes", made.len()));
    }
    if cuts.is_empty() {
        panic!("Nothing would be cut on face {}: every web hole is under the {} mm2 smallest hole.", fi, min_hole);
    }
    outside += all.difference(&allowed).area();

    // 5. Depth: through the part (the part's far side along the face normal), or as asked.
    let depth = if depth_in > 0.0 {
        depth_in
    } else {
        let mut far = 0.0;
        let mut cursor = String::new();
        loop {
            let mut args = Json::obj().set("object", part.object.as_str()).set("limit", 100.0);
            if !cursor.is_empty() {
                args = args.set("cursor", cursor.as_str());
            }
            let r = s.call("faces_find", args).unwrap();
            if let Some(rows) = r.get("faces").and_then(|f| f.as_array()) {
                for f in rows.iter() {
                    for key in ["bbox.min", "bbox.max"].iter() {
                        if let Some(p) = f.at(key).and_then(|x| x.as_f64s()) {
                            if p.len() == 3 {
                                let d = [fr.origin[0] - p[0], fr.origin[1] - p[1], fr.origin[2] - p[2]];
                                far = f64::max(far, dot(d, fr.w));
                            }
                        }
                    }
                }
            }
            match r.get("nextCursor").and_then(|c| c.as_str()) {
                Some(c) => cursor = c.to_string(),
                None => break,
            }
        }
        far + 0.5
    };
    let cuts: Vec<Json> = cuts.into_iter().map(|c| c.set("depth", -depth).set("depth2", 0.2)).collect();

    let before = s.volume(&part).unwrap();
    let r = s.apply_many(&part, "cut", cuts).unwrap();
    for f in r.failures.iter() {
        s.log(&format!("hole {} left out: {}", f.0, f.1));
    }
    if r.applied == 0 {
        panic!("Nothing was cut on face {}: the kernel refused every web hole.", fi);
    }
    let after = s.volume(&part).unwrap();
    s.done_with(&part, Json::obj().set("face", fi).set("webs", Json::Arr(placed)).set("holes", holes)
        .set("applied", r.applied).set("failures", r.failures.len()).set("depthMm", (depth * 100.0).round() / 100.0)
        .set("volumeBefore", before).set("volumeAfter", after).set("outsideMm2", outside));
}

// --- Ingredients from the library, added by recipe_run before the build; not part of the recipe. ---
#[allow(dead_code, unused_imports)]
mod ingredients {
pub mod spiderweb {
// ingredient: spiderweb v2 sha256:6064b0d867eccfa062e5da7718e65df44c7cbf9f8833193cb937300dfb2455dc
use lime_recipe::geom2d::{circle, Poly, Region};

/// One web's shape: spoke and ring counts, sizes in mm (hub, reach, strand), sag as a
/// fraction of the thread's length pulled toward the hub, the smallest hole kept in mm2,
/// and a phase (radians) and seed that turn and vary the web so neighbours differ.
#[derive(Clone)]
pub struct Web {
    pub spokes: usize,
    pub rings: usize,
    pub hub: f64,
    pub reach: f64,
    pub strand: f64,
    pub sag: f64,
    pub min_hole: f64,
    pub phase: f64,
    pub seed: usize,
}

/// One web thread between two spokes: a chord from (a0, r0) to (a1, r1) around c,
/// pulled toward c by sag at its middle, as n + 1 points.
pub fn thread(c: [f64; 2], a0: f64, r0: f64, a1: f64, r1: f64, sag: f64, n: usize) -> Vec<[f64; 2]> {
    let p0 = [c[0] + r0 * a0.cos(), c[1] + r0 * a0.sin()];
    let p1 = [c[0] + r1 * a1.cos(), c[1] + r1 * a1.sin()];
    let mut pts = Vec::new();
    for i in 0..=n {
        let t = i as f64 / n as f64;
        let x = p0[0] + (p1[0] - p0[0]) * t;
        let y = p0[1] + (p1[1] - p0[1]) * t;
        let k = 1.0 - sag * 4.0 * t * (1.0 - t);
        pts.push([c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]);
    }
    pts
}

/// Spoke angles in radians, evenly spread from phase with a small fixed jitter
/// (from seed) so the web looks hand-spun.
pub fn spoke_angles(w: &Web) -> Vec<f64> {
    let tau = std::f64::consts::TAU;
    let mut ang = Vec::new();
    for i in 0..w.spokes {
        let jit = 0.18 * (i as f64 * 2.17 + w.seed as f64).sin() * tau / w.spokes as f64;
        ang.push(w.phase + tau * i as f64 / w.spokes as f64 + jit);
    }
    ang
}

/// Radius of ring k (0 = hub, rings = the outer thread) where it meets spoke i:
/// evenly spaced hub to reach, with a small wobble; the outer ring never passes reach.
pub fn ring_radius(w: &Web, k: usize, i: usize) -> f64 {
    let r = w.hub + (w.reach - w.hub) * k as f64 / w.rings as f64;
    if k == 0 {
        return r;
    }
    let s = ((i * 3 + k * 5 + w.seed) as f64 * 1.3).sin();
    if k == w.rings { r * (1.0 - 0.03 * (1.0 + s)) } else { r * (1.0 + 0.06 * s) }
}

/// The smallest free radius (mm) a web needs: the hub plus, per ring, one thread
/// and a 0.4 mm opening.
pub fn min_web_radius(w: &Web) -> f64 {
    w.hub + w.rings as f64 * (w.strand + 0.4)
}

/// The web's holes around centre c, clipped to area (the material the web may open,
/// already kept clear of edges), threads strand wide; holes under min_hole mm2 are dropped.
pub fn web_holes(c: [f64; 2], area: &Region, w: &Web) -> Vec<Region> {
    let ang = spoke_angles(w);
    let tau = std::f64::consts::TAU;
    let mut out = Vec::new();
    for k in 0..w.rings {
        for i in 0..w.spokes {
            let j = (i + 1) % w.spokes;
            let a0 = ang[i];
            let mut a1 = ang[j];
            if a1 < a0 {
                a1 += tau;
            }
            let mut pts = thread(c, a0, ring_radius(w, k + 1, i), a1, ring_radius(w, k + 1, j), w.sag, 10);
            let inner_sag = if k == 0 { 0.0 } else { w.sag };
            let inner = thread(c, a0, ring_radius(w, k, i), a1, ring_radius(w, k, j), inner_sag, 10);
            for p in inner.iter().rev() {
                pts.push(*p);
            }
            let gap = Region::from_poly(&Poly::new(pts)).offset_miter(-w.strand / 2.0);
            let hole = gap.intersect(area).without_small(w.min_hole);
            for piece in hole.pieces() {
                if piece.area() >= w.min_hole {
                    out.push(piece);
                }
            }
        }
    }
    out
}

/// The web's holes with softened corners (0.3 mm, as a printed web), as straight-edged
/// regions (no arcs, so the kernel never meets a near-flat arc), clipped to area again so
/// rounding never eats into the wall, cleaned to 0.01 mm; each region's to_loops() is one
/// extrude's loops per piece.
pub fn web_cuts(c: [f64; 2], area: &Region, w: &Web) -> Vec<Region> {
    let mut out = Vec::new();
    for h in web_holes(c, area, w) {
        let r = h.clean(0.03).round_corners_with(0.3, 0.4, 0.15).to_region(0.02).intersect(area).clean(0.01);
        if !r.is_empty() {
            out.push(r);
        }
    }
    out
}

/// The widest spot of a region: the centre and radius (mm) of its largest inscribed
/// circle, found by shrinking the region until it vanishes (to tol mm). None when empty.
pub fn deepest_point(region: &Region, tol: f64) -> Option<([f64; 2], f64)> {
    if region.is_empty() {
        return None;
    }
    let bb = region.bbox();
    let mut lo = 0.0;
    let mut hi = 0.5 * (bb[1][0] - bb[0][0]).min(bb[1][1] - bb[0][1]) + tol;
    let mut last = region.clone();
    while hi - lo > tol {
        let mid = 0.5 * (lo + hi);
        let inner = region.offset(-mid).to_region(0.02);
        if inner.is_empty() {
            hi = mid;
        } else {
            lo = mid;
            last = inner;
        }
    }
    let mut best = last.clone();
    let mut best_a = -1.0;
    for p in last.pieces() {
        let a = p.area();
        if a > best_a {
            best_a = a;
            best = p;
        }
    }
    let mut c = best.centroid();
    if !region.contains(c) {
        let lb = best.bbox();
        c = [0.5 * (lb[0][0] + lb[1][0]), 0.5 * (lb[0][1] + lb[1][1])];
    }
    Some((c, lo))
}

/// Up to n free spots for webs, widest first: each is the deepest point of what is left
/// after the earlier spots' circles (grown by gap mm) are taken out. Spots narrower than
/// min_r are not returned.
pub fn free_spots(region: &Region, n: usize, gap: f64, min_r: f64, tol: f64) -> Vec<([f64; 2], f64)> {
    let mut left = region.clone();
    let mut out = Vec::new();
    while out.len() < n {
        match deepest_point(&left, tol) {
            Some((c, r)) => {
                if r < min_r {
                    break;
                }
                out.push((c, r));
                let disc = Region::from_poly(&circle(r + gap, 96).translate(c[0], c[1]));
                left = left.difference(&disc);
            }
            None => break,
        }
    }
    out
}

/// The part of area that belongs to web i: area cut on the bisector with every other
/// centre, each side keeping gap / 2 mm, so neighbouring webs never run into each other.
pub fn web_cell(i: usize, centres: &[[f64; 2]], area: &Region, gap: f64) -> Region {
    let big = 1.0e4;
    let a = centres[i];
    let mut cell = area.clone();
    for (j, b) in centres.iter().enumerate() {
        if j == i {
            continue;
        }
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let d = (dx * dx + dy * dy).sqrt();
        if d < 1e-9 {
            continue;
        }
        let n = [dx / d, dy / d];
        let t = [-n[1], n[0]];
        let q = [0.5 * (a[0] + b[0]) - n[0] * gap / 2.0, 0.5 * (a[1] + b[1]) - n[1] * gap / 2.0];
        let mut p = Poly::new(vec![
            [q[0] + t[0] * big, q[1] + t[1] * big],
            [q[0] - t[0] * big, q[1] - t[1] * big],
            [q[0] - t[0] * big - n[0] * big, q[1] - t[1] * big - n[1] * big],
            [q[0] + t[0] * big - n[0] * big, q[1] + t[1] * big - n[1] * big],
        ]);
        if p.area() < 0.0 {
            p = p.reversed();
        }
        cell = cell.intersect(&Region::from_poly(&p));
    }
    cell
}

/// Distance (mm) from p to the nearest edge of region (outlines and holes alike):
/// the largest web reach that stays on the region around p.
pub fn edge_distance(region: &Region, p: [f64; 2]) -> f64 {
    let mut best = f64::MAX;
    for lp in region.loops().iter() {
        let pts = &lp.pts;
        let n = pts.len();
        for i in 0..n {
            let a = pts[i];
            let b = pts[(i + 1) % n];
            let dx = b[0] - a[0];
            let dy = b[1] - a[1];
            let l2 = dx * dx + dy * dy;
            let mut t = if l2 > 0.0 { ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 } else { 0.0 };
            t = t.max(0.0).min(1.0);
            let ex = a[0] + dx * t - p[0];
            let ey = a[1] + dy * t - p[1];
            best = best.min((ex * ex + ey * ey).sqrt());
        }
    }
    best
}
}
}
