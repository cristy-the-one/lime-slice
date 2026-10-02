//! Through-holes and blind holes must stay open. The void filler used to read a
//! ring as two discs and lay beads across the opening; these slices lock the
//! fixed behavior on real toolpaths and G-code.
//!
//! The body is a 40 × 28 × 8 mm block. Voids, all different diameters:
//! - vertical through-hole, diameter 6 mm
//! - vertical through-hole, diameter 0.50 mm (0.10 mm over the 0.40 mm nozzle)
//! - blind hole from the top, diameter 4 mm, floor at Z = 4
//! - blind hole from the bottom, diameter 2.5 mm, ceiling at Z = 2.5
//! - blind hole from the +X face, diameter 3 mm, end cap at X = 22

use std::collections::HashMap;

use lime_slice_core::{
    audit_slice, slice_configured, BlendMode, Mesh, PrinterProfile, SliceSettings, StrategyId,
};

const W: f64 = 40.0;
const D: f64 = 28.0;
const H: f64 = 8.0;
const NOZZLE: f64 = 0.4;
const LINE: f64 = 0.45;
/// Keep the sampled core this far inside the faceted wall, past a bead that
/// legally ends on the opening.
const CORE_INSET: f64 = 0.08;

#[derive(Clone, Copy)]
struct VertHole {
    name: &'static str,
    cx: f64,
    cy: f64,
    r: f64,
    z0: f64,
    z1: f64,
    n: usize,
    /// The material just under `z0` is a floor and needs solid skin.
    floor_at_z0: bool,
}

#[derive(Clone, Copy)]
struct SideHole {
    name: &'static str,
    cy: f64,
    cz: f64,
    r: f64,
    x0: f64,
    x1: f64,
    n: usize,
}

fn vertical_holes() -> [VertHole; 4] {
    [
        VertHole {
            name: "through-6mm",
            cx: 9.0,
            cy: 8.0,
            r: 3.0,
            z0: 0.0,
            z1: H,
            n: 32,
            floor_at_z0: false,
        },
        VertHole {
            name: "through-0.5mm",
            cx: 18.0,
            cy: 14.0,
            r: 0.25,
            z0: 0.0,
            z1: H,
            n: 18,
            floor_at_z0: false,
        },
        VertHole {
            name: "blind-top-4mm",
            cx: 31.0,
            cy: 8.0,
            r: 2.0,
            z0: 4.0,
            z1: H,
            n: 28,
            floor_at_z0: true,
        },
        VertHole {
            name: "blind-bottom-2.5mm",
            cx: 9.0,
            cy: 21.0,
            r: 1.25,
            z0: 0.0,
            z1: 2.5,
            n: 24,
            floor_at_z0: false,
        },
    ]
}

fn side_hole() -> SideHole {
    SideHole {
        name: "blind-side-3mm",
        cy: 21.0,
        cz: 4.0,
        r: 1.5,
        x0: 22.0,
        x1: W,
        n: 28,
    }
}

fn hole_fixture() -> Mesh {
    let mut tris = Vec::new();
    let vertical = vertical_holes();
    let side = side_hole();
    let mut top_loops = Vec::new();
    let mut bottom_loops = Vec::new();

    for hole in &vertical {
        let cs = unit_circle(hole.n);
        let at = |z: f64| ring_z(&cs, hole.cx, hole.cy, hole.r, z);
        if hole.z0 <= 1e-9 && (hole.z1 - H).abs() < 1e-9 {
            let low = at(0.0);
            let high = at(H);
            add_tube(&mut tris, &low, &high, hole.cx, hole.cy);
            bottom_loops.push(xy_of(&low));
            top_loops.push(xy_of(&high));
        } else if (hole.z1 - H).abs() < 1e-9 && hole.z0 > 1e-9 {
            let low = at(hole.z0);
            let high = at(H);
            add_tube(&mut tris, &low, &high, hole.cx, hole.cy);
            add_disk(
                &mut tris,
                &low,
                [hole.cx, hole.cy, hole.z0],
                [hole.cx, hole.cy, hole.z0 - 0.4],
            );
            top_loops.push(xy_of(&high));
        } else if hole.z0 <= 1e-9 && hole.z1 < H - 1e-9 {
            let low = at(0.0);
            let high = at(hole.z1);
            add_tube(&mut tris, &low, &high, hole.cx, hole.cy);
            add_disk(
                &mut tris,
                &high,
                [hole.cx, hole.cy, hole.z1],
                [hole.cx, hole.cy, hole.z1 + 0.4],
            );
            bottom_loops.push(xy_of(&low));
        } else {
            panic!("unsupported vertical hole {}", hole.name);
        }
    }

    let cs = unit_circle(side.n);
    let side_open = ring_x(&cs, side.x1, side.cy, side.cz, side.r);
    let side_end = ring_x(&cs, side.x0, side.cy, side.cz, side.r);
    add_tube_x(&mut tris, &side_end, &side_open, side.cy, side.cz);
    add_disk(
        &mut tris,
        &side_end,
        [side.x0, side.cy, side.cz],
        [side.x0 - 0.4, side.cy, side.cz],
    );

    let interior = [W * 0.5, D * 0.5, H * 0.5];
    add_xy_face(&mut tris, H, rect(0.0, 0.0, W, D), top_loops, interior);
    add_xy_face(&mut tris, 0.0, rect(0.0, 0.0, W, D), bottom_loops, interior);
    add_yz_face(
        &mut tris,
        W,
        rect(0.0, 0.0, D, H),
        vec![yz_of(&side_open)],
        interior,
    );
    add_yz_face(&mut tris, 0.0, rect(0.0, 0.0, D, H), Vec::new(), interior);
    add_xz_face(&mut tris, D, rect(0.0, 0.0, W, H), interior);
    add_xz_face(&mut tris, 0.0, rect(0.0, 0.0, W, H), interior);

    Mesh { triangles: tris }
}

fn unit_circle(n: usize) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| {
            let a = std::f64::consts::TAU * i as f64 / n as f64;
            (a.cos(), a.sin())
        })
        .collect()
}

fn ring_z(cs: &[(f64, f64)], cx: f64, cy: f64, r: f64, z: f64) -> Vec<[f64; 3]> {
    cs.iter()
        .map(|(c, s)| [cx + r * c, cy + r * s, z])
        .collect()
}

fn ring_x(cs: &[(f64, f64)], x: f64, cy: f64, cz: f64, r: f64) -> Vec<[f64; 3]> {
    cs.iter()
        .map(|(c, s)| [x, cy + r * c, cz + r * s])
        .collect()
}

fn xy_of(ring: &[[f64; 3]]) -> Vec<[f64; 2]> {
    ring.iter().map(|p| [p[0], p[1]]).collect()
}

fn yz_of(ring: &[[f64; 3]]) -> Vec<[f64; 2]> {
    ring.iter().map(|p| [p[1], p[2]]).collect()
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[f64; 2]> {
    vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

fn add_tube(tris: &mut Vec<[[f64; 3]; 3]>, low: &[[f64; 3]], high: &[[f64; 3]], cx: f64, cy: f64) {
    let n = low.len();
    for i in 0..n {
        let j = (i + 1) % n;
        let quad = [low[i], low[j], high[j], high[i]];
        push_outward(
            tris,
            quad[0],
            quad[1],
            quad[2],
            outside_z(centroid4(&quad), cx, cy),
        );
        push_outward(
            tris,
            quad[0],
            quad[2],
            quad[3],
            outside_z(centroid4(&quad), cx, cy),
        );
    }
}

fn add_tube_x(
    tris: &mut Vec<[[f64; 3]; 3]>,
    end: &[[f64; 3]],
    open: &[[f64; 3]],
    cy: f64,
    cz: f64,
) {
    let n = end.len();
    for i in 0..n {
        let j = (i + 1) % n;
        let quad = [end[i], end[j], open[j], open[i]];
        let mid = centroid4(&quad);
        push_outward(tris, quad[0], quad[1], quad[2], outside_x(mid, cy, cz));
        push_outward(tris, quad[0], quad[2], quad[3], outside_x(mid, cy, cz));
    }
}

fn add_disk(
    tris: &mut Vec<[[f64; 3]; 3]>,
    ring: &[[f64; 3]],
    center: [f64; 3],
    interior: [f64; 3],
) {
    for i in 0..ring.len() {
        let j = (i + 1) % ring.len();
        push_outward(tris, center, ring[i], ring[j], interior);
    }
}

fn centroid4(p: &[[f64; 3]; 4]) -> [f64; 3] {
    [
        (p[0][0] + p[1][0] + p[2][0] + p[3][0]) * 0.25,
        (p[0][1] + p[1][1] + p[2][1] + p[3][1]) * 0.25,
        (p[0][2] + p[1][2] + p[2][2] + p[3][2]) * 0.25,
    ]
}

fn outside_z(mid: [f64; 3], cx: f64, cy: f64) -> [f64; 3] {
    let dx = mid[0] - cx;
    let dy = mid[1] - cy;
    let len = dx.hypot(dy).max(1e-9);
    [mid[0] + dx / len * 0.4, mid[1] + dy / len * 0.4, mid[2]]
}

fn outside_x(mid: [f64; 3], cy: f64, cz: f64) -> [f64; 3] {
    let dy = mid[1] - cy;
    let dz = mid[2] - cz;
    let len = dy.hypot(dz).max(1e-9);
    [mid[0], mid[1] + dy / len * 0.4, mid[2] + dz / len * 0.4]
}

fn add_xy_face(
    tris: &mut Vec<[[f64; 3]; 3]>,
    z: f64,
    outer: Vec<[f64; 2]>,
    holes: Vec<Vec<[f64; 2]>>,
    interior: [f64; 3],
) {
    for t in triangulate(outer, holes) {
        push_outward(
            tris,
            [t[0][0], t[0][1], z],
            [t[1][0], t[1][1], z],
            [t[2][0], t[2][1], z],
            interior,
        );
    }
}

fn add_yz_face(
    tris: &mut Vec<[[f64; 3]; 3]>,
    x: f64,
    outer: Vec<[f64; 2]>,
    holes: Vec<Vec<[f64; 2]>>,
    interior: [f64; 3],
) {
    for t in triangulate(outer, holes) {
        push_outward(
            tris,
            [x, t[0][0], t[0][1]],
            [x, t[1][0], t[1][1]],
            [x, t[2][0], t[2][1]],
            interior,
        );
    }
}

fn add_xz_face(tris: &mut Vec<[[f64; 3]; 3]>, y: f64, outer: Vec<[f64; 2]>, interior: [f64; 3]) {
    for t in triangulate(outer, Vec::new()) {
        push_outward(
            tris,
            [t[0][0], y, t[0][1]],
            [t[1][0], y, t[1][1]],
            [t[2][0], y, t[2][1]],
            interior,
        );
    }
}

fn push_outward(
    tris: &mut Vec<[[f64; 3]; 3]>,
    a: [f64; 3],
    b: [f64; 3],
    c: [f64; 3],
    interior: [f64; 3],
) {
    let n = cross3(sub3(b, a), sub3(c, a));
    if n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-18 {
        return;
    }
    let toward = sub3(interior, a);
    let dot = n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2];
    if dot > 0.0 {
        tris.push([a, c, b]);
    } else {
        tris.push([a, b, c]);
    }
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross3(u: [f64; 3], v: [f64; 3]) -> [f64; 3] {
    [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ]
}

/// CCW outer, holes wound either way. Area of the triangles has to match the
/// outer minus the holes, so a bad face fails before the mesh is sliced.
fn triangulate(mut outer: Vec<[f64; 2]>, holes: Vec<Vec<[f64; 2]>>) -> Vec<[[f64; 2]; 3]> {
    if shoelace(&outer) < 0.0 {
        outer.reverse();
    }
    let mut hole_abs = 0.0;
    let mut wound = Vec::with_capacity(holes.len());
    for mut hole in holes {
        let area = shoelace(&hole);
        hole_abs += area.abs();
        if area > 0.0 {
            hole.reverse();
        }
        wound.push(hole);
    }
    let expected = shoelace(&outer) - hole_abs;
    let mut data = Vec::new();
    let mut hole_ix = Vec::with_capacity(wound.len());
    for p in &outer {
        data.push(p[0]);
        data.push(p[1]);
    }
    for hole in &wound {
        hole_ix.push(data.len() / 2);
        for p in hole {
            data.push(p[0]);
            data.push(p[1]);
        }
    }
    let idx = earcutr::earcut(&data, &hole_ix, 2).expect("face triangulation");
    let mut tris = Vec::with_capacity(idx.len() / 3);
    for t in idx.chunks_exact(3) {
        let pt = |i: usize| [data[i * 2], data[i * 2 + 1]];
        let tri = [pt(t[0]), pt(t[1]), pt(t[2])];
        if shoelace(&tri).abs() < 1e-10 {
            continue;
        }
        tris.push(tri);
    }
    let got: f64 = tris.iter().map(|t| shoelace(t)).sum();
    assert!(
        (got - expected).abs() < 1e-3,
        "face triangulation area {got:.6} != {expected:.6} ({} tris)",
        tris.len()
    );
    tris
}

fn shoelace(ring: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..ring.len() {
        let p = ring[i];
        let q = ring[(i + 1) % ring.len()];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a * 0.5
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn poly_disk_area(r: f64, n: usize) -> f64 {
    0.5 * n as f64 * r * r * (std::f64::consts::TAU / n as f64).sin()
}

fn expected_volume() -> f64 {
    let mut voids = 0.0;
    for hole in vertical_holes() {
        voids += poly_disk_area(hole.r, hole.n) * (hole.z1 - hole.z0);
    }
    let side = side_hole();
    voids += poly_disk_area(side.r, side.n) * (side.x1 - side.x0);
    W * D * H - voids
}

fn mesh_volume(mesh: &Mesh) -> f64 {
    mesh.triangles
        .iter()
        .map(|[a, b, c]| {
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum()
}

fn open_edges(mesh: &Mesh) -> usize {
    let mut ids: HashMap<[u64; 3], u32> = HashMap::new();
    let mut next = 0u32;
    let mut uses: HashMap<(u32, u32), u32> = HashMap::new();
    for tri in &mesh.triangles {
        let mut face = [0u32; 3];
        for (slot, v) in face.iter_mut().zip(tri.iter()) {
            let bits = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
            *slot = *ids.entry(bits).or_insert_with(|| {
                let id = next;
                next += 1;
                id
            });
        }
        if face[0] == face[1] || face[1] == face[2] || face[0] == face[2] {
            continue;
        }
        for (a, b) in [(face[0], face[1]), (face[1], face[2]), (face[2], face[0])] {
            let key = if a < b { (a, b) } else { (b, a) };
            *uses.entry(key).or_default() += 1;
        }
    }
    uses.values().filter(|count| **count != 2).count()
}

#[test]
fn hole_fixture_is_watertight() {
    let mesh = hole_fixture();
    let volume = mesh_volume(&mesh);
    let want = expected_volume();
    let open = open_edges(&mesh);
    assert_eq!(
        open, 0,
        "boundary edges {open}, volume {volume:.4} vs {want:.4}"
    );
    assert!(
        (volume - want).abs() < 0.05,
        "mesh volume {volume:.4} mm3, polygonal voids imply {want:.4}"
    );
    assert!(
        mesh.triangle_count() < 800,
        "fixture grew to {} tris",
        mesh.triangle_count()
    );
    eprintln!(
        "hole fixture  {} tris  volume {:.3} mm3  (model {:.3})  open edges {open}",
        mesh.triangle_count(),
        volume,
        want
    );
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Bead {
    Wall,
    Skin,
    Part,
    Support,
    Travel,
    Skip,
}

fn bead_of(kind: &str) -> Bead {
    match kind {
        "outer" | "inner" | "wall" | "thin-wall" => Bead::Wall,
        "top" | "solid" => Bead::Skin,
        "support" | "support-interface" => Bead::Support,
        "travel" => Bead::Travel,
        "skirt" => Bead::Skip,
        _ => Bead::Part,
    }
}

struct Seg {
    a: [f64; 2],
    b: [f64; 2],
    bead: Bead,
    width: f64,
    /// Travel into a part bead. Support and skirt hops are not combing.
    comb: bool,
}

#[derive(Clone, Copy)]
enum Opening {
    Disk { c: [f64; 2], r: f64 },
    Rect { min: [f64; 2], max: [f64; 2] },
}

struct OpeningAt {
    name: &'static str,
    shape: Opening,
}

fn core_radius(r: f64, n: usize) -> f64 {
    r * (std::f64::consts::PI / n as f64).cos() - CORE_INSET
}

fn openings_at(cut_z: f64) -> Vec<OpeningAt> {
    let mut out = Vec::new();
    for hole in vertical_holes() {
        if cut_z <= hole.z0 + 1e-6 || cut_z >= hole.z1 - 1e-6 {
            continue;
        }
        let r = core_radius(hole.r, hole.n);
        if r > 0.04 {
            out.push(OpeningAt {
                name: hole.name,
                shape: Opening::Disk {
                    c: [hole.cx, hole.cy],
                    r,
                },
            });
        }
    }
    let side = side_hole();
    let dz = cut_z - side.cz;
    let r_poly = side.r * (std::f64::consts::PI / side.n as f64).cos();
    if dz.abs() < r_poly {
        let half = (r_poly * r_poly - dz * dz).sqrt();
        let inset = 0.12;
        if half > inset + 0.05 {
            out.push(OpeningAt {
                name: side.name,
                shape: Opening::Rect {
                    min: [side.x0 + 0.15, side.cy - (half - inset)],
                    max: [side.x1 - 0.15, side.cy + (half - inset)],
                },
            });
        }
    }
    out
}

fn overlap_len(a: [f64; 2], b: [f64; 2], shape: Opening) -> f64 {
    match shape {
        Opening::Disk { c, r } => disk_overlap(a, b, c, r),
        Opening::Rect { min, max } => rect_overlap(a, b, min, max),
    }
}

fn disk_overlap(a: [f64; 2], b: [f64; 2], c: [f64; 2], r: f64) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let fx = a[0] - c[0];
    let fy = a[1] - c[1];
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-18 {
        return 0.0;
    }
    let disc = {
        let qb = 2.0 * (fx * dx + fy * dy);
        let qc = fx * fx + fy * fy - r * r;
        qb * qb - 4.0 * len2 * qc
    };
    if disc < 0.0 {
        return 0.0;
    }
    let sd = disc.sqrt();
    let mut t0 = (-2.0 * (fx * dx + fy * dy) - sd) / (2.0 * len2);
    let mut t1 = (-2.0 * (fx * dx + fy * dy) + sd) / (2.0 * len2);
    if t1 < t0 {
        std::mem::swap(&mut t0, &mut t1);
    }
    let lo = t0.max(0.0);
    let hi = t1.min(1.0);
    if hi <= lo {
        0.0
    } else {
        (hi - lo) * len2.sqrt()
    }
}

fn rect_overlap(a: [f64; 2], b: [f64; 2], min: [f64; 2], max: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let mut u0 = 0.0;
    let mut u1 = 1.0;
    let mut clip = |p: f64, q: f64| -> bool {
        if p.abs() < 1e-15 {
            return q >= 0.0;
        }
        let t = q / p;
        if p < 0.0 {
            if t > u1 {
                return false;
            }
            if t > u0 {
                u0 = t;
            }
        } else {
            if t < u0 {
                return false;
            }
            if t < u1 {
                u1 = t;
            }
        }
        true
    };
    if !clip(-dx, a[0] - min[0])
        || !clip(dx, max[0] - a[0])
        || !clip(-dy, a[1] - min[1])
        || !clip(dy, max[1] - a[1])
        || u1 <= u0
    {
        return 0.0;
    }
    (u1 - u0) * dx.hypot(dy)
}

fn point_in_opening(p: [f64; 2], shape: Opening) -> bool {
    match shape {
        Opening::Disk { c, r } => dist2(p, c) <= r,
        Opening::Rect { min, max } => {
            p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1]
        }
    }
}

fn samples(shape: Opening, step: f64) -> Vec<[f64; 2]> {
    let (min, max) = match shape {
        Opening::Disk { c, r } => ([c[0] - r, c[1] - r], [c[0] + r, c[1] + r]),
        Opening::Rect { min, max } => (min, max),
    };
    let mut pts = Vec::new();
    let mut y = min[1];
    while y <= max[1] + 1e-9 {
        let mut x = min[0];
        while x <= max[0] + 1e-9 {
            let p = [x, y];
            if point_in_opening(p, shape) {
                pts.push(p);
            }
            x += step;
        }
        y += step;
    }
    pts
}

fn dist_to_seg(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len2 = dx * dx + dy * dy;
    let t = if len2 < 1e-18 {
        0.0
    } else {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
    };
    (p[0] - a[0] - dx * t).hypot(p[1] - a[1] - dy * t)
}

struct HoleTally {
    layers: usize,
    preview_mm: f64,
    preview_mm2: f64,
    gcode_mm: f64,
    support_mm2: f64,
    travel_mm: f64,
    wall_layers: usize,
    skin_cover: Vec<(f64, f64)>,
}

impl HoleTally {
    fn new() -> Self {
        Self {
            layers: 0,
            preview_mm: 0.0,
            preview_mm2: 0.0,
            gcode_mm: 0.0,
            support_mm2: 0.0,
            travel_mm: 0.0,
            wall_layers: 0,
            skin_cover: Vec::new(),
        }
    }
}

fn tally_names() -> Vec<&'static str> {
    let mut names: Vec<_> = vertical_holes().iter().map(|h| h.name).collect();
    names.push(side_hole().name);
    names
}

struct SliceReport {
    layers: usize,
    max_sparse_bead: f64,
    combined_sparse: usize,
    holes: HashMap<&'static str, HoleTally>,
    notes: Vec<String>,
}

fn analyze(response: &lime_slice_core::SliceResponse) -> SliceReport {
    let mut holes: HashMap<&'static str, HoleTally> = tally_names()
        .into_iter()
        .map(|n| (n, HoleTally::new()))
        .collect();
    let mut max_sparse_bead = 0.0_f64;
    let mut combined_sparse = 0usize;

    for layer in &response.layers {
        let cut = layer.z - layer.height * 0.5;
        let openings = openings_at(cut);
        let mut segs: Vec<Seg> = Vec::new();
        for (i, path) in layer.paths.iter().enumerate() {
            let bead = bead_of(&path.kind);
            let part_bead =
                |kind: &str| matches!(bead_of(kind), Bead::Wall | Bead::Skin | Bead::Part);
            // A comb stays inside one island. The hop between support and a wall
            // is leaving that support, not a route the part comb is meant to take.
            let comb = bead == Bead::Travel
                && i > 0
                && part_bead(&layer.paths[i - 1].kind)
                && layer
                    .paths
                    .get(i + 1)
                    .is_some_and(|next| part_bead(&next.kind));
            if path.kind == "sparse" {
                let h = if path.bead_height > 1e-6 {
                    path.bead_height
                } else {
                    layer.height
                };
                max_sparse_bead = max_sparse_bead.max(h);
                if path.bead_height > layer.height + 0.04 {
                    combined_sparse += 1;
                }
            }
            for w in path.pts.windows(2) {
                if dist2(w[0], w[1]) < 1e-6 {
                    continue;
                }
                segs.push(Seg {
                    a: w[0],
                    b: w[1],
                    bead,
                    width: path.width,
                    comb,
                });
            }
        }
        for opening in &openings {
            let tally = holes.get_mut(opening.name).unwrap();
            tally.layers += 1;
            let mut part_mm = 0.0;
            let mut travel_mm = 0.0;
            let mut wall_hit = [false; 8];
            for seg in &segs {
                let len = overlap_len(seg.a, seg.b, opening.shape);
                if len <= 1e-4 {
                    continue;
                }
                match seg.bead {
                    Bead::Travel if seg.comb => travel_mm += len,
                    Bead::Skip | Bead::Support | Bead::Travel => {}
                    _ => part_mm += len,
                }
            }
            tally.preview_mm += part_mm;
            tally.travel_mm += travel_mm;
            let step = match opening.shape {
                Opening::Disk { r, .. } => (r * 0.45).clamp(0.06, 0.2),
                Opening::Rect { .. } => 0.15,
            };
            let pts = samples(opening.shape, step);
            if !pts.is_empty() {
                let mut part_n = 0usize;
                let mut support_n = 0usize;
                for p in &pts {
                    let mut part = false;
                    let mut support = false;
                    for seg in &segs {
                        let reach = match seg.bead {
                            Bead::Support => seg.width.max(LINE) * 0.5,
                            Bead::Skip | Bead::Travel => continue,
                            _ => seg.width.max(0.2) * 0.5,
                        };
                        if dist_to_seg(*p, seg.a, seg.b) <= reach {
                            if seg.bead == Bead::Support {
                                support = true;
                            } else {
                                part = true;
                            }
                        }
                    }
                    part_n += usize::from(part);
                    support_n += usize::from(support);
                }
                let area = opening_area(opening.shape);
                tally.preview_mm2 += area * part_n as f64 / pts.len() as f64;
                tally.support_mm2 += area * support_n as f64 / pts.len() as f64;
            }
            if let Some(hole) = vertical_holes().iter().find(|h| h.name == opening.name) {
                for seg in &segs {
                    if seg.bead != Bead::Wall {
                        continue;
                    }
                    for p in [seg.a, seg.b] {
                        let dx = p[0] - hole.cx;
                        let dy = p[1] - hole.cy;
                        let rad = dx.hypot(dy);
                        if rad > hole.r * 0.55 && rad < hole.r + 1.2 {
                            let bin = ((dy.atan2(dx) + std::f64::consts::PI)
                                / std::f64::consts::TAU
                                * 8.0)
                                .floor()
                                .clamp(0.0, 7.0) as usize;
                            wall_hit[bin] = true;
                        }
                    }
                }
                if wall_hit.iter().all(|hit| *hit) {
                    tally.wall_layers += 1;
                }
            }
        }
        if let Some(hole) = vertical_holes().iter().find(|h| h.floor_at_z0) {
            // Speed top shell is 0.6 mm. The layer whose roof distance lands on
            // that boundary stays interior; the skinned band is the 0.6 mm below
            // the floor, not the cavity above it.
            if layer.z <= hole.z0 + 1e-6 && layer.z > hole.z0 - 0.55 {
                let shape = Opening::Disk {
                    c: [hole.cx, hole.cy],
                    r: hole.r * 0.45,
                };
                let pts = samples(shape, 0.25);
                let covered = pts
                    .iter()
                    .filter(|p| {
                        segs.iter().any(|seg| {
                            seg.bead == Bead::Skin && dist_to_seg(**p, seg.a, seg.b) <= 0.30
                        })
                    })
                    .count();
                let frac = if pts.is_empty() {
                    0.0
                } else {
                    covered as f64 / pts.len() as f64
                };
                holes
                    .get_mut(hole.name)
                    .unwrap()
                    .skin_cover
                    .push((layer.z, frac));
            }
        }
    }

    let gcode = gcode_overlap(&response.gcode);
    for (name, mm) in gcode {
        if let Some(tally) = holes.get_mut(name) {
            tally.gcode_mm += mm;
        }
    }

    let mut notes = Vec::new();
    if let Some(side) = response.layers.iter().min_by(|a, b| {
        (a.z - side_hole().cz - a.height * 0.5)
            .abs()
            .partial_cmp(&(b.z - side_hole().cz - b.height * 0.5).abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    }) {
        let side_h = side_hole();
        let mut end_cap = false;
        let mut low = false;
        let mut high = false;
        for path in &side.paths {
            if !matches!(bead_of(&path.kind), Bead::Wall) {
                continue;
            }
            for w in path.pts.windows(2) {
                let x_near = (w[0][0] - side_h.x0).abs() < 0.9
                    && (w[1][0] - side_h.x0).abs() < 0.9
                    && w[0][0] < side_h.x0 + 0.2;
                let y_lo = w[0][1].min(w[1][1]);
                let y_hi = w[0][1].max(w[1][1]);
                if x_near && y_lo < side_h.cy && y_hi > side_h.cy {
                    end_cap = true;
                }
            }
            for p in &path.pts {
                if p[0] > side_h.x0 + 0.3 && p[0] < side_h.x1 - 0.2 {
                    if p[1] > side_h.cy + 0.3 && p[1] < side_h.cy + side_h.r + 0.8 {
                        high = true;
                    }
                    if p[1] < side_h.cy - 0.3 && p[1] > side_h.cy - side_h.r - 0.8 {
                        low = true;
                    }
                }
            }
        }
        if !end_cap || !low || !high {
            notes.push(format!(
                "side-hole walls on z={:.2}: end-cap {end_cap} low-flank {low} high-flank {high}",
                side.z
            ));
        }
    }

    SliceReport {
        layers: response.layers.len(),
        max_sparse_bead,
        combined_sparse,
        holes,
        notes,
    }
}

fn opening_area(shape: Opening) -> f64 {
    match shape {
        Opening::Disk { r, .. } => std::f64::consts::PI * r * r,
        Opening::Rect { min, max } => (max[0] - min[0]).max(0.0) * (max[1] - min[1]).max(0.0),
    }
}

fn gcode_overlap(gcode: &str) -> HashMap<&'static str, f64> {
    let mut out: HashMap<&'static str, f64> = HashMap::new();
    let mut layer_z = 0.0;
    let mut layer_h = 0.2;
    let mut pos: Option<[f64; 2]> = None;
    let mut in_part = false;
    for line in gcode.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(";LAYER:") {
            for tok in rest.split_whitespace() {
                if let Some(v) = tok.strip_prefix("Z:") {
                    layer_z = v.parse().unwrap_or(layer_z);
                } else if let Some(v) = tok.strip_prefix("H:") {
                    layer_h = v.parse().unwrap_or(layer_h);
                }
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix(';') {
            let rest = rest.trim();
            if let Some(ty) = rest.strip_prefix("TYPE:") {
                in_part = !ty.contains("SUPPORT") && ty != "SKIRT";
            }
            continue;
        }
        if !(trimmed.starts_with("G0 ")
            || trimmed.starts_with("G1 ")
            || trimmed.starts_with("G2 ")
            || trimmed.starts_with("G3 "))
        {
            continue;
        }
        let arc = trimmed.starts_with("G2 ") || trimmed.starts_with("G3 ");
        let cw = trimmed.starts_with("G2 ");
        let mut x: Option<f64> = None;
        let mut y: Option<f64> = None;
        let mut ij: Option<[f64; 2]> = None;
        let mut e: Option<f64> = None;
        for tok in trimmed.split_whitespace().skip(1) {
            if let Some(v) = tok.strip_prefix('X') {
                x = v.parse().ok();
            } else if let Some(v) = tok.strip_prefix('Y') {
                y = v.parse().ok();
            } else if let Some(v) = tok.strip_prefix('I') {
                let i: f64 = v.parse().unwrap_or(0.0);
                ij = Some([i, ij.map(|p| p[1]).unwrap_or(0.0)]);
            } else if let Some(v) = tok.strip_prefix('J') {
                let j: f64 = v.parse().unwrap_or(0.0);
                let i = ij.map(|p| p[0]).unwrap_or(0.0);
                ij = Some([i, j]);
            } else if let Some(v) = tok.strip_prefix('E') {
                e = v.parse().ok();
            }
        }
        let Some(start) = pos else {
            if let (Some(x), Some(y)) = (x, y) {
                pos = Some([x, y]);
            }
            continue;
        };
        if x.is_none() && y.is_none() {
            continue;
        }
        let end = [x.unwrap_or(start[0]), y.unwrap_or(start[1])];
        let extruding = arc || e.is_some();
        if extruding && in_part {
            let chain = if arc {
                arc_chain(start, end, ij.unwrap_or([0.0, 0.0]), cw)
            } else {
                vec![end]
            };
            let mut prev = start;
            let openings = openings_at(layer_z - layer_h * 0.5);
            for next in chain {
                for opening in &openings {
                    let len = overlap_len(prev, next, opening.shape);
                    if len > 1e-4 {
                        *out.entry(opening.name).or_insert(0.0) += len;
                    }
                }
                prev = next;
            }
        }
        pos = Some(end);
    }
    out
}

fn arc_chain(start: [f64; 2], end: [f64; 2], ij: [f64; 2], cw: bool) -> Vec<[f64; 2]> {
    let center = [start[0] + ij[0], start[1] + ij[1]];
    let radius = ij[0].hypot(ij[1]);
    if radius < 1e-6 {
        return vec![end];
    }
    let a0 = (start[1] - center[1]).atan2(start[0] - center[0]);
    let a1 = (end[1] - center[1]).atan2(end[0] - center[0]);
    let mut sweep = a1 - a0;
    if cw {
        if sweep >= 0.0 {
            sweep -= std::f64::consts::TAU;
        }
    } else if sweep <= 0.0 {
        sweep += std::f64::consts::TAU;
    }
    let step = 8.0_f64.to_radians();
    let n = ((sweep.abs() / step).ceil() as usize).max(1);
    (1..=n)
        .map(|i| {
            let a = a0 + sweep * i as f64 / n as f64;
            [center[0] + radius * a.cos(), center[1] + radius * a.sin()]
        })
        .collect()
}

fn speed() -> BlendMode {
    BlendMode::Single {
        strategy: StrategyId::Speed,
    }
}

/// Same knobs as the UI defaults. `baseline` only times a second speed plan,
/// so the regression leaves it off and slices the part once.
fn profile_settings() -> SliceSettings {
    SliceSettings {
        baseline: false,
        compare: false,
        ..SliceSettings::default()
    }
}

struct Case {
    name: &'static str,
    combing: bool,
    infill_combine: bool,
    supports: bool,
    layer_height: f64,
    /// This case is where infill-combine is tall enough to merge layers.
    expect_combine: bool,
}

fn cases() -> [Case; 5] {
    [
        Case {
            name: "default",
            combing: true,
            infill_combine: true,
            supports: false,
            layer_height: 0.2,
            expect_combine: false,
        },
        Case {
            name: "combing",
            combing: true,
            infill_combine: false,
            supports: false,
            layer_height: 0.2,
            expect_combine: false,
        },
        Case {
            name: "infill-combine",
            combing: false,
            infill_combine: true,
            supports: false,
            layer_height: 0.2,
            expect_combine: false,
        },
        Case {
            name: "supports",
            combing: true,
            infill_combine: true,
            supports: true,
            layer_height: 0.2,
            expect_combine: false,
        },
        Case {
            name: "combine-0.1mm",
            combing: true,
            infill_combine: true,
            supports: false,
            layer_height: 0.1,
            expect_combine: true,
        },
    ]
}

fn run_case(mesh: &Mesh, case: &Case) -> (SliceReport, lime_slice_core::SliceResponse) {
    let settings = SliceSettings {
        combing: case.combing,
        infill_combine: case.infill_combine,
        supports: case.supports,
        layer_height: case.layer_height,
        ..profile_settings()
    };
    let response = slice_configured(mesh, &speed(), &PrinterProfile::default(), &settings)
        .unwrap_or_else(|err| panic!("{} slice failed: {err}", case.name));
    assert!(
        response.sanity.ok,
        "{} sanity {:?}",
        case.name, response.sanity.notes
    );
    let report = analyze(&response);
    (report, response)
}

fn format_case(case: &Case, report: &SliceReport) -> String {
    let mut lines = vec![format!(
        "{:<16} layers {:3}  max sparse bead {:.3} mm  combined sparse paths {}",
        case.name, report.layers, report.max_sparse_bead, report.combined_sparse
    )];
    for name in tally_names() {
        let tally = &report.holes[name];
        let skin = if tally.skin_cover.is_empty() {
            String::new()
        } else {
            let min = tally
                .skin_cover
                .iter()
                .map(|(_, f)| *f)
                .fold(1.0_f64, f64::min);
            let detail: Vec<String> = tally
                .skin_cover
                .iter()
                .map(|(z, f)| format!("{z:.2}:{:.0}%", f * 100.0))
                .collect();
            format!(
                "  floor skin {} layers min {:.0}% [{}]",
                tally.skin_cover.len(),
                min * 100.0,
                detail.join(" ")
            )
        };
        lines.push(format!(
            "  {name:<18} open {:3}  leak {:.4} mm2  gcode {:.4} mm  walls {}/{}  travel {:.3} mm  support {:.4} mm2{skin}",
            tally.layers,
            tally.preview_mm2,
            tally.gcode_mm,
            tally.wall_layers,
            tally.layers,
            tally.travel_mm,
            tally.support_mm2,
        ));
    }
    for note in &report.notes {
        lines.push(format!("  note: {note}"));
    }
    lines.join("\n")
}

fn assert_case(case: &Case, report: &SliceReport) {
    let want_layers = (H / case.layer_height).round() as usize;
    assert_eq!(report.layers, want_layers, "{} layer count", case.name);
    if case.expect_combine {
        assert!(
            report.combined_sparse > 0
                && report.max_sparse_bead > 0.25
                && report.max_sparse_bead <= 0.34,
            "{} should merge sparse beads under the 0.30 mm cap, max {:.3} paths {}",
            case.name,
            report.max_sparse_bead,
            report.combined_sparse
        );
    } else {
        assert!(
            report.max_sparse_bead <= 0.32,
            "{} sparse bead {:.3} mm over the nozzle cap",
            case.name,
            report.max_sparse_bead
        );
    }
    for name in tally_names() {
        let tally = &report.holes[name];
        assert!(tally.layers > 0, "{} never opened {name}", case.name);
        assert!(
            tally.preview_mm2 < 1e-6,
            "{} {name} hole-area material leak {:.4} mm2 over {} layers (path {:.3} mm)",
            case.name,
            tally.preview_mm2,
            tally.layers,
            tally.preview_mm
        );
        assert!(
            tally.gcode_mm < 1e-3,
            "{} {name} G-code centerline inside the void {:.4} mm",
            case.name,
            tally.gcode_mm
        );
        if name != side_hole().name {
            assert_eq!(
                tally.wall_layers,
                tally.layers,
                "{} {name} missing a closed wall on {} open layers",
                case.name,
                tally.layers - tally.wall_layers
            );
        }
        if case.combing {
            assert!(
                tally.travel_mm < 1e-3,
                "{} combing travel crossed {name} by {:.3} mm",
                case.name,
                tally.travel_mm
            );
        }
        // Through-holes and the top-opening blind hole are not overhangs, so
        // support must stay out. The bottom-opening hole's ceiling is an
        // overhang, held only with supports on. That is recorded, not failed.
        if matches!(name, "through-6mm" | "through-0.5mm" | "blind-top-4mm") {
            assert!(
                tally.support_mm2 < 1e-6,
                "{} support leaked into {name}: {:.4} mm2",
                case.name,
                tally.support_mm2
            );
        }
    }
    let floor = &report.holes["blind-top-4mm"];
    assert!(
        floor.skin_cover.len() >= 3,
        "{} blind-top floor skinned on {} layers, want the 0.6 mm top shell",
        case.name,
        floor.skin_cover.len()
    );
    for (z, frac) in &floor.skin_cover {
        assert!(
            *frac >= 0.80,
            "{} blind-top floor at z={z:.2} skin coverage {:.0}%",
            case.name,
            frac * 100.0
        );
        assert!(
            *z <= 4.0 + 1e-6,
            "{} solid skin at z={z:.2} is above the blind floor",
            case.name
        );
    }
    let top = floor
        .skin_cover
        .iter()
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap())
        .unwrap();
    assert!(
        (top.0 - 4.0).abs() < 1e-6,
        "{} highest floor skin is z={:.2}, want the floor at 4.00",
        case.name,
        top.0
    );
    assert!(
        report.notes.is_empty(),
        "{} {}",
        case.name,
        report.notes.join("; ")
    );
}

#[test]
fn holes_stay_open_for_default_combing_combine_and_supports() {
    let mesh = hole_fixture();
    for case in cases() {
        let (report, _) = run_case(&mesh, &case);
        eprintln!("{}", format_case(&case, &report));
        assert_case(&case, &report);
    }

    let audit = audit_slice(&mesh, &speed(), &profile_settings(), NOZZLE).expect("audit");
    let coverage = audit.sliced_volume_mm3 / audit.mesh_volume_mm3.max(1e-9) * 100.0;
    eprintln!(
        "audit default  layers {}  coverage {:.2}%  missing {:.3} mm3  bridged {:.3} mm  stray {:.3} mm2  open skin {:.3} mm2  unskinned {:.3} mm2  support inside {:.3} mm3",
        audit.layers,
        coverage,
        audit.missing_mm3,
        audit.bridged_mm,
        audit.stray_bead_mm2,
        audit.open_skin_mm2,
        audit.unskinned_top_mm2,
        audit.support_inside_mm3
    );
    assert_eq!(audit.layers, 40, "audit layers");
    assert!(
        (coverage - 100.0).abs() < 1.5,
        "sliced volume {coverage:.2}% of the mesh"
    );
    assert!(
        audit.missing_mm3 < 1.0,
        "contours lost {:.3} mm3",
        audit.missing_mm3
    );
    assert_eq!(audit.bridged_mm, 0.0, "fixture mesh needed gap bridges");
    assert!(
        audit.stray_bead_mm2 < 0.5,
        "stray bead {:.3} mm2 (material in a hole or past the outline), worst {:?}",
        audit.stray_bead_mm2,
        audit.worst_stray
    );
    assert!(
        audit.open_skin_mm2 < 1.0,
        "open skin {:.3} mm2, worst {:?}",
        audit.open_skin_mm2,
        audit.worst_open_skin
    );
    assert!(
        audit.unskinned_top_mm2 < 1.0,
        "unskinned top {:.3} mm2, worst {:?}",
        audit.unskinned_top_mm2,
        audit.worst_unskinned
    );
    assert!(
        audit.support_inside_mm3 < 0.5,
        "support inside the part {:.3} mm3",
        audit.support_inside_mm3
    );
}
