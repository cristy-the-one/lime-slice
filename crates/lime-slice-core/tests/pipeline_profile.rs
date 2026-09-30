//! Stage timings for the whole STEP path, plus a generated rear cover.
//!
//! The small test checks that the generator's hole, boss, and cone stay closed.
//! The ignored test prints a wall-clock breakdown:
//!
//! ```text
//! cargo test -p lime-slice-core --release --test pipeline_profile -- --ignored --nocapture
//! ```

#![allow(clippy::uninlined_format_args)]

use std::time::Instant;

use lime_slice_core::{
    audit_slice, inner_profile, load_step_timed, mesh_preview_tol, pareto_estimates,
    reset_inner_profile, set_inner_profile, slice_configured, Mesh, SliceSettings, StepTimings,
    STEP_TOLERANCE_DEFAULT_MM,
};
use lime_slice_core::{BlendMode, PrinterProfile, StrategyId};

struct Writer {
    n: u64,
    body: String,
    z_up: u64,
    z_down: u64,
    x_dir: u64,
    y_dir: u64,
    y_neg: u64,
    x_neg: u64,
}

impl Writer {
    fn new() -> Self {
        let mut w = Self {
            n: 0,
            body: String::new(),
            z_up: 0,
            z_down: 0,
            x_dir: 0,
            y_dir: 0,
            y_neg: 0,
            x_neg: 0,
        };
        w.z_up = w.dir(0.0, 0.0, 1.0);
        w.z_down = w.dir(0.0, 0.0, -1.0);
        w.x_dir = w.dir(1.0, 0.0, 0.0);
        w.y_dir = w.dir(0.0, 1.0, 0.0);
        w.y_neg = w.dir(0.0, -1.0, 0.0);
        w.x_neg = w.dir(-1.0, 0.0, 0.0);
        w
    }

    fn e(&mut self, value: &str) -> u64 {
        self.n += 1;
        let id = self.n;
        self.body.push_str(&format!("#{id}={value};\n"));
        id
    }

    fn dir(&mut self, x: f64, y: f64, z: f64) -> u64 {
        self.e(&format!("DIRECTION('',({:.6},{:.6},{:.6}))", x, y, z))
    }

    fn pt(&mut self, x: f64, y: f64, z: f64) -> u64 {
        self.e(&format!("CARTESIAN_POINT('',({:.6},{:.6},{:.6}))", x, y, z))
    }

    fn vtx(&mut self, point: u64) -> u64 {
        self.e(&format!("VERTEX_POINT('',#{point})"))
    }

    fn axis2(&mut self, origin: u64, z: u64, x: u64) -> u64 {
        self.e(&format!("AXIS2_PLACEMENT_3D('',#{origin},#{z},#{x})"))
    }

    fn line_edge(&mut self, start: u64, v0: u64, v1: u64, dir: u64) -> u64 {
        let vector = self.e(&format!("VECTOR('',#{dir},1.)"));
        let line = self.e(&format!("LINE('',#{start},#{vector})"));
        self.e(&format!("EDGE_CURVE('',#{v0},#{v1},#{line},.T.)"))
    }

    fn circle_edge(&mut self, origin: u64, z: u64, x: u64, radius: f64, vertex: u64) -> u64 {
        let place = self.axis2(origin, z, x);
        let circle = self.e(&format!("CIRCLE('',#{place},{radius:.6})"));
        self.e(&format!("EDGE_CURVE('',#{vertex},#{vertex},#{circle},.T.)"))
    }

    fn oe(&mut self, edge: u64, forward: bool) -> u64 {
        let flag = if forward { ".T." } else { ".F." };
        self.e(&format!("ORIENTED_EDGE('',*,*,#{edge},{flag})"))
    }

    fn oriented_loop(&mut self, edges: &[(u64, bool)]) -> u64 {
        let mut oriented = Vec::with_capacity(edges.len());
        for (edge, forward) in edges {
            oriented.push(self.oe(*edge, *forward));
        }
        self.eloop(&oriented)
    }

    fn eloop(&mut self, edges: &[u64]) -> u64 {
        let list = edges
            .iter()
            .map(|id| format!("#{id}"))
            .collect::<Vec<_>>()
            .join(",");
        self.e(&format!("EDGE_LOOP('',({list}))"))
    }

    fn plane(&mut self, origin: u64, z: u64, x: u64) -> u64 {
        let place = self.axis2(origin, z, x);
        self.e(&format!("PLANE('',#{place})"))
    }

    fn outer_face(&mut self, loop_id: u64, surface: u64, sense: bool) -> u64 {
        let bound = self.e(&format!("FACE_OUTER_BOUND('',#{loop_id},.T.)"));
        let flag = if sense { ".T." } else { ".F." };
        self.e(&format!("ADVANCED_FACE('',(#{bound}),#{surface},{flag})"))
    }

    fn face_with_holes(&mut self, outer: u64, holes: &[u64], surface: u64) -> u64 {
        let mut bounds = vec![self.e(&format!("FACE_OUTER_BOUND('',#{outer},.T.)"))];
        for hole in holes {
            bounds.push(self.e(&format!("FACE_BOUND('',#{hole},.F.)")));
        }
        let list = bounds
            .iter()
            .map(|id| format!("#{id}"))
            .collect::<Vec<_>>()
            .join(",");
        self.e(&format!("ADVANCED_FACE('',({list}),#{surface},.T.)"))
    }

    fn solid(&mut self, faces: &[u64]) -> u64 {
        let list = faces
            .iter()
            .map(|id| format!("#{id}"))
            .collect::<Vec<_>>()
            .join(",");
        let shell = self.e(&format!("CLOSED_SHELL('',({list}))"));
        self.e(&format!("MANIFOLD_SOLID_BREP('',#{shell})"))
    }

    fn finish(mut self, solids: &[u64], name: &str) -> Vec<u8> {
        let length = self.e("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))");
        let ctx = self.e(&format!(
            "(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#{length})) REPRESENTATION_CONTEXT('','3D'))"
        ));
        let origin = self.pt(0.0, 0.0, 0.0);
        let place = self.axis2(origin, self.z_up, self.x_dir);
        let mut items = vec![place];
        items.extend_from_slice(solids);
        let list = items
            .iter()
            .map(|id| format!("#{id}"))
            .collect::<Vec<_>>()
            .join(",");
        let rep = self.e(&format!(
            "ADVANCED_BREP_SHAPE_REPRESENTATION('',({list}),#{ctx})"
        ));
        let app = self.e("APPLICATION_CONTEXT('mechanical')");
        let product = self.e(&format!("PRODUCT('{name}','{name}','',$)"));
        let formation = self.e(&format!("PRODUCT_DEFINITION_FORMATION('','',#{product})"));
        let definition = self.e(&format!(
            "PRODUCT_DEFINITION('design','',#{formation},#{app})"
        ));
        let shape = self.e(&format!("PRODUCT_DEFINITION_SHAPE('','',#{definition})"));
        self.e(&format!("SHAPE_DEFINITION_REPRESENTATION(#{shape},#{rep})"));
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('lime-slice profile'),'2;1');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN {{ 1 0 10303 214 1 1 1 1 }}'));\nENDSEC;\nDATA;\n{}ENDSEC;\nEND-ISO-10303-21;\n",
            self.body
        )
        .into_bytes()
    }
}

struct Hole {
    cx: f64,
    cy: f64,
    r: f64,
}

fn push_cylinder(w: &mut Writer, cx: f64, cy: f64, z0: f64, z1: f64, radius: f64) -> u64 {
    let origin0 = w.pt(cx, cy, z0);
    let origin1 = w.pt(cx, cy, z1);
    let p0 = w.pt(cx + radius, cy, z0);
    let p1 = w.pt(cx + radius, cy, z1);
    let v0 = w.vtx(p0);
    let v1 = w.vtx(p1);
    let z_up = w.z_up;
    let z_down = w.z_down;
    let x_dir = w.x_dir;
    let c0 = w.circle_edge(origin0, z_up, x_dir, radius, v0);
    let c1 = w.circle_edge(origin1, z_up, x_dir, radius, v1);
    let seam = w.line_edge(p0, v0, v1, z_up);
    let place = w.axis2(origin0, z_up, x_dir);
    let surface = w.e(&format!("CYLINDRICAL_SURFACE('',#{place},{radius:.6})"));
    let oe_c0 = w.oe(c0, true);
    let oe_seam_up = w.oe(seam, true);
    let oe_c1_rev = w.oe(c1, false);
    let oe_seam_down = w.oe(seam, false);
    let side_loop = w.eloop(&[oe_c0, oe_seam_up, oe_c1_rev, oe_seam_down]);
    let side = w.outer_face(side_loop, surface, true);
    let oe_c1 = w.oe(c1, true);
    let top_loop = w.eloop(&[oe_c1]);
    let top_plane = w.plane(origin1, z_up, x_dir);
    let top = w.outer_face(top_loop, top_plane, true);
    let oe_c0_rev = w.oe(c0, false);
    let bottom_loop = w.eloop(&[oe_c0_rev]);
    let bottom_plane = w.plane(origin0, z_down, x_dir);
    let bottom = w.outer_face(bottom_loop, bottom_plane, true);
    w.solid(&[side, top, bottom])
}

fn push_box(w: &mut Writer, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> u64 {
    push_holed_box(w, x0, y0, z0, x1, y1, z1, &[])
}

fn floor_tiles(width: f64, depth: f64, holes: &[Hole], gap: f64) -> Vec<[f64; 4]> {
    let mut xs = vec![0.0, width];
    let mut ys = vec![0.0, depth];
    for hole in holes {
        xs.push((hole.cx - gap).clamp(0.0, width));
        xs.push((hole.cx + gap).clamp(0.0, width));
        ys.push((hole.cy - gap).clamp(0.0, depth));
        ys.push((hole.cy + gap).clamp(0.0, depth));
    }
    let unique = |values: &mut Vec<f64>| {
        values.sort_by(|a, b| a.total_cmp(b));
        values.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    };
    unique(&mut xs);
    unique(&mut ys);
    let mut tiles = Vec::new();
    for i in 0..xs.len().saturating_sub(1) {
        for j in 0..ys.len().saturating_sub(1) {
            let (x0, x1) = (xs[i], xs[i + 1]);
            let (y0, y1) = (ys[j], ys[j + 1]);
            if x1 - x0 < 1e-4 || y1 - y0 < 1e-4 {
                continue;
            }
            let (cx, cy) = ((x0 + x1) * 0.5, (y0 + y1) * 0.5);
            let blocked = holes
                .iter()
                .any(|hole| (cx - hole.cx).abs() < gap - 1e-4 && (cy - hole.cy).abs() < gap - 1e-4);
            if !blocked {
                tiles.push([x0, y0, x1, y1]);
            }
        }
    }
    tiles
}

#[allow(clippy::too_many_arguments)]
fn push_holed_box(
    w: &mut Writer,
    x0: f64,
    y0: f64,
    z0: f64,
    x1: f64,
    y1: f64,
    z1: f64,
    holes: &[Hole],
) -> u64 {
    let p000 = w.pt(x0, y0, z0);
    let p100 = w.pt(x1, y0, z0);
    let p010 = w.pt(x0, y1, z0);
    let p110 = w.pt(x1, y1, z0);
    let p001 = w.pt(x0, y0, z1);
    let p101 = w.pt(x1, y0, z1);
    let p011 = w.pt(x0, y1, z1);
    let p111 = w.pt(x1, y1, z1);
    let v000 = w.vtx(p000);
    let v100 = w.vtx(p100);
    let v010 = w.vtx(p010);
    let v110 = w.vtx(p110);
    let v001 = w.vtx(p001);
    let v101 = w.vtx(p101);
    let v011 = w.vtx(p011);
    let v111 = w.vtx(p111);
    let (z_up, z_down, x_dir, y_dir, y_neg, x_neg) =
        (w.z_up, w.z_down, w.x_dir, w.y_dir, w.y_neg, w.x_neg);
    let ey0 = w.line_edge(p000, v000, v010, y_dir);
    let ex1 = w.line_edge(p010, v010, v110, x_dir);
    let ey1 = w.line_edge(p100, v100, v110, y_dir);
    let ex0 = w.line_edge(p000, v000, v100, x_dir);
    let tx0 = w.line_edge(p001, v001, v101, x_dir);
    let ty1 = w.line_edge(p101, v101, v111, y_dir);
    let tx1 = w.line_edge(p011, v011, v111, x_dir);
    let ty0 = w.line_edge(p001, v001, v011, y_dir);
    let up00 = w.line_edge(p000, v000, v001, z_up);
    let up10 = w.line_edge(p100, v100, v101, z_up);
    let up01 = w.line_edge(p010, v010, v011, z_up);
    let up11 = w.line_edge(p110, v110, v111, z_up);

    let mut bottom_holes = Vec::new();
    let mut top_holes = Vec::new();
    let mut walls = Vec::new();
    for hole in holes {
        let o0 = w.pt(hole.cx, hole.cy, z0);
        let o1 = w.pt(hole.cx, hole.cy, z1);
        let right0 = w.pt(hole.cx + hole.r, hole.cy, z0);
        let left0 = w.pt(hole.cx - hole.r, hole.cy, z0);
        let right1 = w.pt(hole.cx + hole.r, hole.cy, z1);
        let left1 = w.pt(hole.cx - hole.r, hole.cy, z1);
        let vr0 = w.vtx(right0);
        let vl0 = w.vtx(left0);
        let vr1 = w.vtx(right1);
        let vl1 = w.vtx(left1);
        let place0 = w.axis2(o0, z_up, x_dir);
        let place1 = w.axis2(o1, z_up, x_dir);
        let circle0 = w.e(&format!("CIRCLE('',#{place0},{:.6})", hole.r));
        let circle1 = w.e(&format!("CIRCLE('',#{place1},{:.6})", hole.r));
        let bot_rl = w.e(&format!("EDGE_CURVE('',#{vr0},#{vl0},#{circle0},.T.)"));
        let bot_lr = w.e(&format!("EDGE_CURVE('',#{vl0},#{vr0},#{circle0},.T.)"));
        let top_rl = w.e(&format!("EDGE_CURVE('',#{vr1},#{vl1},#{circle1},.T.)"));
        let top_lr = w.e(&format!("EDGE_CURVE('',#{vl1},#{vr1},#{circle1},.T.)"));
        let seam_r = w.line_edge(right0, vr0, vr1, z_up);
        let seam_l = w.line_edge(left0, vl0, vl1, z_up);
        let place = w.axis2(o0, z_up, x_dir);
        let surface = w.e(&format!("CYLINDRICAL_SURFACE('',#{place},{:.6})", hole.r));
        // Two half-walls, normal into the hole (sense false).
        let wall_a = w.oriented_loop(&[
            (bot_rl, true),
            (seam_l, true),
            (top_lr, true),
            (seam_r, false),
        ]);
        let wall_b = w.oriented_loop(&[
            (bot_lr, true),
            (seam_r, true),
            (top_rl, true),
            (seam_l, false),
        ]);
        walls.push(w.outer_face(wall_a, surface, true));
        walls.push(w.outer_face(wall_b, surface, true));
        bottom_holes.push(w.oriented_loop(&[(bot_rl, false), (bot_lr, false)]));
        top_holes.push(w.oriented_loop(&[(top_lr, false), (top_rl, false)]));
    }

    let bottom_loop = w.oriented_loop(&[(ey0, true), (ex1, true), (ey1, false), (ex0, false)]);
    let bottom_plane = w.plane(p000, z_down, x_dir);
    let bottom = w.face_with_holes(bottom_loop, &bottom_holes, bottom_plane);
    let top_loop = w.oriented_loop(&[(tx0, true), (ty1, true), (tx1, false), (ty0, false)]);
    let top_plane = w.plane(p001, z_up, x_dir);
    let top = w.face_with_holes(top_loop, &top_holes, top_plane);
    let front_loop = w.oriented_loop(&[(ex0, true), (up10, true), (tx0, false), (up00, false)]);
    let front_plane = w.plane(p000, y_neg, x_dir);
    let front = w.outer_face(front_loop, front_plane, true);
    let back_loop = w.oriented_loop(&[(up01, true), (tx1, true), (up11, false), (ex1, false)]);
    let back_plane = w.plane(p010, y_dir, x_dir);
    let back = w.outer_face(back_loop, back_plane, true);
    let left_loop = w.oriented_loop(&[(up00, true), (ty0, true), (up01, false), (ey0, false)]);
    let left_plane = w.plane(p000, x_neg, y_dir);
    let left = w.outer_face(left_loop, left_plane, true);
    let right_loop = w.oriented_loop(&[(ey1, true), (up11, true), (ty1, false), (up10, false)]);
    let right_plane = w.plane(p100, x_dir, y_dir);
    let right = w.outer_face(right_loop, right_plane, true);
    let mut faces = vec![bottom, top, front, back, left, right];
    faces.extend(walls);
    w.solid(&faces)
}

fn push_cone(w: &mut Writer, cx: f64, cy: f64, z: f64, radius: f64, semi_angle_deg: f64) -> u64 {
    let height = radius / semi_angle_deg.to_radians().tan();
    let apex = w.pt(cx, cy, z + height);
    let right = w.pt(cx + radius, cy, z);
    let left = w.pt(cx - radius, cy, z);
    let origin = w.pt(cx, cy, z);
    let va = w.vtx(apex);
    let vr = w.vtx(right);
    let vl = w.vtx(left);
    let place_up = w.axis2(origin, w.z_up, w.x_dir);
    let circle = w.e(&format!("CIRCLE('',#{place_up},{radius:.6})"));
    let to_left = w.e(&format!("EDGE_CURVE('',#{vr},#{vl},#{circle},.T.)"));
    let to_right = w.e(&format!("EDGE_CURVE('',#{vl},#{vr},#{circle},.T.)"));
    let toward_right = w.dir(radius, 0.0, -height);
    let toward_left = w.dir(-radius, 0.0, -height);
    let apex_right = w.line_edge(apex, va, vr, toward_right);
    let apex_left = w.line_edge(apex, va, vl, toward_left);
    let place_down = w.axis2(origin, w.z_down, w.x_dir);
    let surface = w.e(&format!(
        "CONICAL_SURFACE('',#{place_down},{radius:.6},{semi_angle_deg:.6})"
    ));
    let loop_a = w.oriented_loop(&[(to_left, true), (apex_left, false), (apex_right, true)]);
    let face_a = w.outer_face(loop_a, surface, true);
    let loop_b = w.oriented_loop(&[(to_right, true), (apex_right, false), (apex_left, true)]);
    let face_b = w.outer_face(loop_b, surface, true);
    let z_down = w.z_down;
    let x_dir = w.x_dir;
    let base_loop = w.oriented_loop(&[(to_right, false), (to_left, false)]);
    let base_plane = w.plane(origin, z_down, x_dir);
    let base = w.outer_face(base_loop, base_plane, true);
    w.solid(&[face_a, face_b, base])
}

fn cover_step(spec: &CoverSpec) -> Vec<u8> {
    let mut w = Writer::new();
    let mut holes = Vec::new();
    let x_span = spec.width - 2.0 * spec.margin;
    let y_span = spec.depth - 2.0 * spec.margin;
    let nx = spec.holes_x;
    let ny = spec.holes_y;
    for ix in 0..nx {
        for iy in 0..ny {
            let cx = if nx == 1 {
                spec.width * 0.5
            } else {
                spec.margin + x_span * ix as f64 / (nx - 1) as f64
            };
            let cy = if ny == 1 {
                spec.depth * 0.5
            } else {
                spec.margin + y_span * iy as f64 / (ny - 1) as f64
            };
            holes.push(Hole {
                cx,
                cy,
                r: spec.hole_r,
            });
        }
    }
    let mut solids = Vec::new();
    for tile in floor_tiles(spec.width, spec.depth, &holes, spec.hole_r) {
        solids.push(push_box(
            &mut w,
            tile[0],
            tile[1],
            0.0,
            tile[2],
            tile[3],
            spec.floor_z,
        ));
    }
    let pitch_x = spec.width / (spec.ribs_x + 1) as f64;
    let pitch_y = spec.depth / (spec.ribs_y + 1) as f64;
    let thick = spec.rib_thick;
    for ix in 1..=spec.ribs_x {
        let x = ix as f64 * pitch_x;
        for iy in 0..=spec.ribs_y {
            let y_a = iy as f64 * pitch_y;
            let y_b = (iy + 1) as f64 * pitch_y;
            let y0 = if iy == 0 { 0.0 } else { y_a + thick * 0.5 };
            let y1 = if iy == spec.ribs_y {
                spec.depth
            } else {
                y_b - thick * 0.5
            };
            if y1 - y0 > thick {
                solids.push(push_box(
                    &mut w,
                    x - thick * 0.5,
                    y0,
                    spec.floor_z,
                    x + thick * 0.5,
                    y1,
                    spec.top_z,
                ));
            }
        }
    }
    for iy in 1..=spec.ribs_y {
        let y = iy as f64 * pitch_y;
        for ix in 0..=spec.ribs_x {
            let x_a = ix as f64 * pitch_x;
            let x_b = (ix + 1) as f64 * pitch_x;
            let x0 = if ix == 0 { 0.0 } else { x_a + thick * 0.5 };
            let x1 = if ix == spec.ribs_x {
                spec.width
            } else {
                x_b - thick * 0.5
            };
            if x1 - x0 > thick {
                solids.push(push_box(
                    &mut w,
                    x0,
                    y - thick * 0.5,
                    spec.floor_z,
                    x1,
                    y + thick * 0.5,
                    spec.top_z,
                ));
            }
        }
    }
    let bosses = spec.bosses.min(holes.len());
    for hole in holes.iter().take(bosses) {
        solids.push(push_cylinder(
            &mut w,
            hole.cx,
            hole.cy,
            spec.floor_z,
            spec.top_z,
            spec.boss_r,
        ));
    }
    let cones = spec.cones.min(bosses);
    for hole in holes.iter().take(cones) {
        solids.push(push_cone(
            &mut w,
            hole.cx,
            hole.cy,
            spec.top_z,
            spec.cone_r,
            59.0,
        ));
    }
    w.finish(&solids, "rear-cover")
}

struct CoverSpec {
    width: f64,
    depth: f64,
    floor_z: f64,
    top_z: f64,
    margin: f64,
    holes_x: usize,
    holes_y: usize,
    hole_r: f64,
    ribs_x: usize,
    ribs_y: usize,
    rib_thick: f64,
    bosses: usize,
    boss_r: f64,
    cones: usize,
    cone_r: f64,
}

fn small_cover() -> Vec<u8> {
    cover_step(&CoverSpec {
        width: 40.0,
        depth: 24.0,
        floor_z: 4.0,
        top_z: 8.0,
        margin: 8.0,
        holes_x: 2,
        holes_y: 1,
        hole_r: 1.5,
        ribs_x: 1,
        ribs_y: 1,
        rib_thick: 1.6,
        bosses: 1,
        boss_r: 3.2,
        cones: 1,
        cone_r: 2.0,
    })
}

/// 311 mm rear cover: floor with a screw-hole grid, thin ribs, bosses, drill-point cones.
fn rear_cover() -> Vec<u8> {
    cover_step(&CoverSpec {
        width: 311.0,
        depth: 220.0,
        floor_z: 2.4,
        top_z: 6.4,
        margin: 16.0,
        holes_x: 10,
        holes_y: 7,
        hole_r: 3.2,
        ribs_x: 8,
        ribs_y: 6,
        rib_thick: 1.8,
        bosses: 16,
        boss_r: 4.2,
        cones: 8,
        cone_r: 2.4,
    })
}

fn volume(mesh: &Mesh) -> f64 {
    mesh.triangles
        .iter()
        .map(|tri| {
            let a = tri[0];
            let b = tri[1];
            let c = tri[2];
            a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0
}

fn unpaired_edges(mesh: &Mesh) -> usize {
    use std::collections::HashMap;
    let key = |p: [f64; 3]| p.map(|c| (c * 1e6).round() as i64);
    let mut runs: HashMap<([i64; 3], [i64; 3]), i32> = HashMap::new();
    for tri in &mesh.triangles {
        for k in 0..3 {
            *runs
                .entry((key(tri[k]), key(tri[(k + 1) % 3])))
                .or_default() += 1;
        }
    }
    runs.iter()
        .filter(|((a, b), n)| **n != 1 || runs.get(&(*b, *a)) != Some(&1))
        .count()
}

fn mesh_hash(mesh: &Mesh) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for tri in &mesh.triangles {
        for point in tri {
            for coord in point {
                let bits = (coord * 1e6).round() as i64 as u64;
                hash ^= bits;
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
    }
    hash
}

fn ui_settings() -> SliceSettings {
    SliceSettings {
        baseline: false,
        include_gcode: false,
        include_preview: true,
        supports: false,
        ..SliceSettings::default()
    }
}

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn print_step(label: &str, timings: &StepTimings) {
    println!(
        "{label}  total {:.2} ms  read {:.2}  parse {:.2}  index {:.2}  table {:.2}  topology {:.2}  compress {:.2}  tessellate {:.2}  snap {:.2}  ear {:.2} ({} faces)  sliver {:.2}  assembly {:.2}  shells {}  faces {}  tris {}",
        timings.total_ms,
        timings.read_ms,
        timings.parse_ms,
        timings.index_ms,
        timings.table_ms,
        timings.topology_ms,
        timings.compress_ms,
        timings.tessellate_ms,
        timings.snap_ms,
        timings.ear_ms,
        timings.ear_faces,
        timings.sliver_ms,
        timings.assembly_ms,
        timings.shells,
        timings.faces,
        timings.triangles
    );
}

#[test]
fn generated_cover_with_a_hole_boss_and_cone_is_closed() {
    let mut writer = Writer::new();
    let cone = push_cone(&mut writer, 0.0, 0.0, 0.0, 10.0, 59.0);
    let cone_bytes = writer.finish(&[cone], "cone");
    let (cone_mesh, cone_times) =
        load_step_timed(&cone_bytes, STEP_TOLERANCE_DEFAULT_MM).expect("cone");
    assert_eq!(unpaired_edges(&cone_mesh), 0);
    assert!(
        cone_times.ear_faces >= 2,
        "drill-point faces {}",
        cone_times.ear_faces
    );
    let height = 10.0 / 59.0_f64.to_radians().tan();
    let analytic = std::f64::consts::PI * 100.0 * height / 3.0;
    let cone_vol = volume(&cone_mesh);
    assert!(
        (cone_vol - analytic).abs() / analytic < 0.03,
        "cone volume {cone_vol} analytic {analytic}"
    );

    let open = cover_step(&CoverSpec {
        width: 40.0,
        depth: 24.0,
        floor_z: 4.0,
        top_z: 4.0,
        margin: 8.0,
        holes_x: 2,
        holes_y: 1,
        hole_r: 3.0,
        ribs_x: 0,
        ribs_y: 0,
        rib_thick: 1.6,
        bosses: 0,
        boss_r: 3.2,
        cones: 0,
        cone_r: 2.0,
    });
    let floor = load_step_timed(&open, STEP_TOLERANCE_DEFAULT_MM)
        .expect("floor")
        .0;
    let solid = 40.0 * 24.0 * 4.0;
    let removed = 2.0 * 6.0 * 6.0 * 4.0;
    let floor_vol = volume(&floor);
    assert!(
        (floor_vol - (solid - removed)).abs() < 1.0,
        "tiled floor volume {floor_vol}, wanted {}",
        solid - removed
    );

    let bytes = small_cover();
    let (mesh, timings) = load_step_timed(&bytes, STEP_TOLERANCE_DEFAULT_MM)
        .unwrap_or_else(|err| panic!("small cover: {err}"));
    print_step("small", &timings);
    assert!(mesh.triangle_count() > 24, "tris {}", mesh.triangle_count());
    assert!(timings.ear_faces >= 2, "ear faces {}", timings.ear_faces);
    assert!(volume(&mesh) > floor_vol, "boss and ribs should add volume");
}

#[test]
#[ignore = "release timing harness: cargo test -p lime-slice-core --release --test pipeline_profile -- --ignored --nocapture"]
fn pipeline_profile_rear_cover() {
    let started = Instant::now();
    let bytes = rear_cover();
    println!(
        "generated rear cover  {:.2} ms  {} bytes",
        ms(started),
        bytes.len()
    );

    let (mesh, timings) = load_step_timed(&bytes, STEP_TOLERANCE_DEFAULT_MM)
        .unwrap_or_else(|err| panic!("rear cover: {err}"));
    print_step("import", &timings);
    println!(
        "fingerprint  tris {}  volume {:.3}  unpaired {}  hash {:016x}  bounds {:?}",
        mesh.triangle_count(),
        volume(&mesh),
        unpaired_edges(&mesh),
        mesh_hash(&mesh),
        mesh.bounds()
    );

    let preview = Instant::now();
    let preview_mesh = mesh_preview_tol("rear-cover.step", &bytes, STEP_TOLERANCE_DEFAULT_MM)
        .unwrap_or_else(|err| panic!("preview: {err}"));
    let preview_ms = ms(preview);
    println!(
        "preview (cached tessellation + f32 pack)  {:.2} ms  positions {}",
        preview_ms,
        preview_mesh.positions.len()
    );

    let pose = Instant::now();
    let posed = mesh.rigid_move(
        &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        [0.0, 0.0, 0.0],
        [10.0, 0.0, 0.0],
    );
    println!(
        "pose apply  {:.2} ms  tris {}",
        ms(pose),
        posed.triangle_count()
    );

    let blend = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let profile = PrinterProfile::default();
    let settings = ui_settings();
    let slice = Instant::now();
    let response = slice_configured(&mesh, &blend, &profile, &settings).expect("slice");
    let slice_ms = ms(slice);
    let stages = &response.stages;
    println!(
        "slice UI  {:.2} ms wall  core {:.2}  index {:.2}  contours {:.2}  cut cpu {:.2}  simplify cpu {:.2}  roofs {:.2}  supports {:.2}  toolpaths {:.2}  walls cpu {:.2}  infill cpu {:.2}  order {:.2}  combing {:.2}  emit {:.2}",
        slice_ms,
        response.core_ms,
        stages.index_ms,
        stages.contour_ms,
        stages.cut_cpu_ms,
        stages.simplify_cpu_ms,
        stages.roof_ms,
        stages.support_ms,
        stages.toolpath_ms,
        stages.wall_cpu_ms,
        stages.infill_cpu_ms,
        stages.order_ms,
        stages.comb_ms,
        stages.emit_ms
    );
    println!(
        "slice result  layers {}  seconds {:.1}  filament {:.2} g  sanity {}",
        response.sanity.layers,
        response.estimate.seconds,
        response.estimate.filament_g,
        response.sanity.ok
    );

    let json = Instant::now();
    let encoded = serde_json::to_string(&response).expect("json");
    println!(
        "json serialize preview  {:.2} ms  {} bytes",
        ms(json),
        encoded.len()
    );

    let again = Instant::now();
    let second = load_step_timed(&bytes, STEP_TOLERANCE_DEFAULT_MM).expect("reload");
    println!(
        "import again (mesh cache)  {:.2} ms  hash match {}",
        ms(again),
        mesh_hash(&second.0) == mesh_hash(&mesh)
    );

    let pareto = Instant::now();
    let points = pareto_estimates(&mesh, &profile, &settings).expect("pareto");
    println!(
        "pareto (5 slices)  {:.2} ms  points {}",
        ms(pareto),
        points.len()
    );

    let audit = Instant::now();
    let report = audit_slice(&mesh, &blend, &settings, profile.nozzle_diameter).expect("audit");
    println!(
        "audit  {:.2} ms  plan {:.2}  layers {}  repaired {}  bridged {:.2} mm",
        ms(audit),
        report.plan_ms,
        report.layers,
        report.repaired_layers,
        report.bridged_mm
    );

    let mut with_gcode = settings.clone();
    with_gcode.include_gcode = true;
    with_gcode.include_preview = false;
    let emit = Instant::now();
    let emitted = slice_configured(&mesh, &blend, &profile, &with_gcode).expect("gcode");
    println!(
        "slice with gcode text  {:.2} ms  emit stage {:.2}  gcode bytes {}",
        ms(emit),
        emitted.stages.emit_ms,
        emitted.gcode.len()
    );

    println!("pipeline wall {:.2} s", ms(started) / 1000.0);
}

/// One sequential slice per Pareto blend, with inner-loop clocks.
#[test]
#[ignore = "release timing harness"]
fn pipeline_profile_blends() {
    let bytes = rear_cover();
    let (mesh, _) = load_step_timed(&bytes, STEP_TOLERANCE_DEFAULT_MM).expect("step");
    let profile = PrinterProfile::default();
    let settings = ui_settings();
    set_inner_profile(true);
    let blends = [
        (0.0, "speed"),
        (0.25, "weight 25%"),
        (0.5, "weight 50%"),
        (0.75, "weight 75%"),
        (1.0, "toughness"),
    ];
    let only = std::env::var("LIME_BLEND").ok();
    for (toughness, label) in blends {
        if only.as_ref().is_some_and(|want| {
            !want
                .split(',')
                .any(|part| !part.is_empty() && label.contains(part.trim()))
        }) {
            continue;
        }
        let blend = if toughness <= 1e-9 {
            BlendMode::Single {
                strategy: StrategyId::Speed,
            }
        } else if toughness >= 1.0 - 1e-9 {
            BlendMode::Single {
                strategy: StrategyId::Toughness,
            }
        } else {
            BlendMode::Weight { toughness }
        };
        let mut quiet = settings.clone();
        quiet.include_preview = false;
        quiet.include_gcode = std::env::var_os("LIME_GCODE").is_some();
        reset_inner_profile();
        let started = Instant::now();
        let response = slice_configured(&mesh, &blend, &profile, &quiet).expect(label);
        if quiet.include_gcode {
            println!(
                "  gcode bytes {}  seconds {:.1}  filament {:.2}",
                response.gcode.len(),
                response.estimate.seconds,
                response.estimate.filament_g
            );
        }
        let stages = &response.stages;
        println!(
            "{label}  {:.2} ms  infill cpu {:.2}  order {:.2}  toolpaths {:.2}  walls cpu {:.2}  supports {:.2}  emit {:.2}  contours {:.2}",
            ms(started),
            stages.infill_cpu_ms,
            stages.order_ms,
            stages.toolpath_ms,
            stages.wall_cpu_ms,
            stages.support_ms,
            stages.emit_ms,
            stages.contour_ms
        );
        println!("  {}", inner_profile());
    }
}
