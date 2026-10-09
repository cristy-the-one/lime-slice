use std::collections::HashMap;

use lime_slice_core::{
    load_mesh, load_slice_mesh_tol, resolve_step_tolerance, STEP_TOLERANCE_DEFAULT_MM,
    STEP_TOLERANCE_MAX_MM, STEP_TOLERANCE_MIN_MM,
};

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read(path).unwrap()
}

fn load(name: &str) -> lime_slice_core::Mesh {
    load_mesh(name, &fixture(name)).unwrap_or_else(|err| panic!("{name}: {err}"))
}

fn volume(mesh: &lime_slice_core::Mesh) -> f64 {
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

fn boundary_edges(mesh: &lime_slice_core::Mesh) -> usize {
    let key = |p: [f64; 3]| {
        (
            (p[0] * 1e3).round() as i64,
            (p[1] * 1e3).round() as i64,
            (p[2] * 1e3).round() as i64,
        )
    };
    let mut ids = HashMap::new();
    let mut next = 0i64;
    let mut edges: HashMap<(i64, i64), i32> = HashMap::new();
    for tri in &mesh.triangles {
        let mut vert = [0i64; 3];
        for (i, point) in tri.iter().enumerate() {
            vert[i] = *ids.entry(key(*point)).or_insert_with(|| {
                let id = next;
                next += 1;
                id
            });
        }
        for pair in [(vert[0], vert[1]), (vert[1], vert[2]), (vert[2], vert[0])] {
            let edge = if pair.0 < pair.1 {
                pair
            } else {
                (pair.1, pair.0)
            };
            *edges.entry(edge).or_default() += 1;
        }
    }
    edges.values().filter(|count| **count != 2).count()
}

fn expect_box(mesh: &lime_slice_core::Mesh, min: [f64; 3], max: [f64; 3], slack: f64) {
    let (lo, hi) = mesh.bounds().expect("bounds");
    for axis in 0..3 {
        assert!(
            (lo[axis] - min[axis]).abs() <= slack,
            "min[{axis}] {} wanted {}",
            lo[axis],
            min[axis]
        );
        assert!(
            (hi[axis] - max[axis]).abs() <= slack,
            "max[{axis}] {} wanted {}",
            hi[axis],
            max[axis]
        );
    }
}

#[test]
fn rectangular_hole_is_watertight_in_millimetres() {
    let mesh = load("rect_hole.step");
    assert!(mesh.triangle_count() > 0);
    expect_box(&mesh, [0.0, 0.0, 0.0], [20.0, 16.0, 10.0], 1e-6);
    let vol = volume(&mesh);
    assert!((vol - 2840.0).abs() < 1.0, "volume {vol}");
    assert_eq!(boundary_edges(&mesh), 0);
}

/// Directed edges that do not meet their reverse exactly once. Zero means the
/// mesh is closed and every triangle faces the same way as its neighbours.
fn unpaired_edges(mesh: &lime_slice_core::Mesh) -> usize {
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

/// Truck's weld measures its tolerance against the bounding box: 0.025 of a
/// 300 mm bar merged vertices 3.75 mm apart and closed this 1 mm hole.
#[test]
fn a_long_bar_keeps_its_one_millimetre_hole() {
    let mesh = load("slot_bar.step");
    expect_box(&mesh, [0.0, 0.0, 0.0], [300.0, 16.0, 10.0], 1e-6);
    let vol = volume(&mesh);
    assert!((vol - 47_940.0).abs() < 1e-3, "volume {vol}");
    assert_eq!(unpaired_edges(&mesh), 0);
}

/// Two half-cone faces that meet at the apex, like a drill point. Truck
/// returns no mesh for either half, and they used to be dropped.
#[test]
fn a_cone_that_meets_at_its_apex_is_closed() {
    let mesh = load("apex_cone.step");
    let height = 10.0 / 59.0_f64.to_radians().tan();
    expect_box(&mesh, [-10.0, -10.0, 0.0], [10.0, 10.0, height], 0.1);
    let vol = volume(&mesh);
    let analytic = std::f64::consts::PI * 100.0 * height / 3.0;
    assert!(
        (vol - analytic).abs() / analytic < 0.03,
        "volume {vol} analytic {analytic}"
    );
    assert_eq!(unpaired_edges(&mesh), 0);
}

/// Creo leaves a 1 mm sliver face between two coincident edges, bounded by only
/// two distinct points. Truck finds no loop to trim it by and meshes the whole
/// parametric rectangle: a ribbon outside the part.
#[test]
fn a_zero_area_extrusion_face_adds_no_ribbon() {
    let mesh = load("sliver_face.step");
    expect_box(&mesh, [0.0, 0.0, 0.0], [10.0, 10.0, 10.0], 1e-6);
    assert_eq!(mesh.triangle_count(), load("cube.step").triangle_count());
    assert_eq!(boundary_edges(&mesh), 0);
    let vol = volume(&mesh);
    assert!((vol - 1000.0).abs() < 1e-6, "volume {vol}");
}

/// A 300 mm wall that is a linear extrusion of a 50 mm radius arc, cut at the
/// top by a sloped plane, like the long side walls of a Creo part. Truck's
/// parameter space for it is 1 rad by 300 mm, so with no point between the two
/// rims it fans every chord out from one corner and cuts across the arc.
#[test]
fn an_extruded_arc_wall_follows_the_arc() {
    let mesh = load("arc_wall.step");
    let radius = |p: [f64; 3]| (p[0] * p[0] + p[1] * p[1]).sqrt();
    let mut worst: f64 = 0.0;
    let mut wall = 0;
    for tri in &mesh.triangles {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let (ab, ac) = (
            [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        );
        let nz = ab[0] * ac[1] - ab[1] * ac[0];
        let area = (ab[0] * ac[1] - ab[1] * ac[0])
            .hypot((ab[1] * ac[2] - ab[2] * ac[1]).hypot(ab[2] * ac[0] - ab[0] * ac[2]));
        // The chord wall sits at y = 43.3, the caps face along z.
        let flat = tri.iter().all(|p| (p[1] - 43.30127).abs() < 1e-6);
        if flat || nz.abs() > 0.5 * area {
            continue;
        }
        wall += 1;
        let centroid = [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0);
        for p in [a, b, c, centroid] {
            worst = worst.max((radius(p) - 50.0).abs());
        }
    }
    assert!(wall > 0);
    assert!(
        worst < 0.2,
        "{wall} wall triangles stray {worst} mm from the arc"
    );
    let analytic =
        300.0 * 1250.0 * (std::f64::consts::PI / 3.0 - (std::f64::consts::PI / 3.0).sin());
    let vol = volume(&mesh);
    assert!(
        (vol - analytic).abs() / analytic < 0.03,
        "volume {vol} analytic {analytic}"
    );
    assert_eq!(boundary_edges(&mesh), 0);
}

/// Creo leaves the edges of a small cone up to 0.15 mm off it. The cylinder here
/// is 1.2 mm across with its edge circles 0.12 mm outside it, past the 0.1 mm a
/// rim vertex is moved to meet an edge, and it used to leave an open ring.
#[test]
fn a_small_cylinder_whose_edges_sit_off_it_is_closed() {
    let mesh = load("loose_cylinder.step");
    expect_box(&mesh, [-0.72, -0.72, 0.0], [0.72, 0.72, 1.5], 0.2);
    assert_eq!(unpaired_edges(&mesh), 0);
}

#[test]
fn cylinder_tessellates_inside_the_analytic_solid() {
    let mesh = load("cylinder.step");
    assert!(mesh.triangle_count() > 0);
    expect_box(&mesh, [-5.0, -5.0, 0.0], [5.0, 5.0, 12.0], 0.2);
    let vol = volume(&mesh).abs();
    let analytic = std::f64::consts::PI * 25.0 * 12.0;
    assert!(
        (vol - analytic).abs() / analytic < 0.06,
        "volume {vol} analytic {analytic}"
    );
    assert_eq!(boundary_edges(&mesh), 0);
}

#[test]
fn inch_cube_converts_to_millimetres() {
    let mesh = load("inch_cube.step");
    assert!(mesh.triangle_count() > 0);
    expect_box(&mesh, [0.0, 0.0, 0.0], [25.4, 25.4, 25.4], 1e-6);
    let vol = volume(&mesh);
    assert!((vol - 25.4_f64.powi(3)).abs() < 0.1, "volume {vol}");
    assert_eq!(boundary_edges(&mesh), 0);
}

#[test]
fn assembly_merges_placed_bodies_into_one_mesh() {
    let mesh = load("assembly.step");
    assert!(mesh.triangle_count() > 12, "tris {}", mesh.triangle_count());
    expect_box(&mesh, [0.0, 0.0, 0.0], [40.0, 10.0, 10.0], 1e-6);
    let vol = volume(&mesh);
    assert!((vol - 2000.0).abs() < 1.0, "volume {vol}");
    assert_eq!(boundary_edges(&mesh), 0);
}

#[test]
fn stp_extension_and_sample_cube_match_the_ten_millimetre_solid() {
    let bytes = fixture("cube.step");
    let mesh = load_mesh("part.stp", &bytes).unwrap();
    expect_box(&mesh, [0.0, 0.0, 0.0], [10.0, 10.0, 10.0], 1e-6);
    assert!((volume(&mesh) - 1000.0).abs() < 1e-6);
    assert_eq!(boundary_edges(&mesh), 0);
    let sample =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples/step_cube.step");
    let sample_mesh = load_mesh("step_cube.step", &std::fs::read(sample).unwrap()).unwrap();
    expect_box(&sample_mesh, [0.0, 0.0, 0.0], [10.0, 10.0, 10.0], 1e-6);
}

#[test]
fn stl_load_is_unchanged() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../samples/calibration_cube_20mm.stl");
    let mesh = load_mesh("calibration_cube_20mm.stl", &std::fs::read(path).unwrap()).unwrap();
    assert_eq!(mesh.triangle_count(), 12);
    expect_box(&mesh, [0.0, 0.0, 0.0], [20.0, 20.0, 20.0], 1e-3);
}

#[test]
fn bad_files_and_tolerances_are_errors() {
    let err = |name: &str, bytes: &[u8]| load_mesh(name, bytes).unwrap_err();
    assert!(err("empty.step", b"").contains("empty"));
    assert!(err("notes.step", b"hello").contains("ISO-10303-21"));
    assert!(err("bin.step", b"\0\0\0not text").contains("not text"));
    let header = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    assert!(err("empty-data.step", header).contains("no geometry"));
    let open = String::from_utf8(fixture("cube.step"))
        .unwrap()
        .replace("CLOSED_SHELL", "OPEN_SHELL");
    let open_err = err("open.step", open.as_bytes());
    assert!(open_err.contains("no closed solid"), "{open_err}");
    let cube = fixture("cube.step");
    let low =
        load_slice_mesh_tol("cube.step", &cube, false, STEP_TOLERANCE_MIN_MM - 0.001).unwrap_err();
    assert!(low.contains("chord tolerance"), "{low}");
    let high =
        load_slice_mesh_tol("cube.step", &cube, false, STEP_TOLERANCE_MAX_MM + 0.01).unwrap_err();
    assert!(high.contains("chord tolerance"), "{high}");
    assert!(load_slice_mesh_tol("cube.step", &cube, false, f64::NAN).is_err());
    let mesh = load_slice_mesh_tol("cube.step", &cube, false, 0.0).unwrap();
    assert!(mesh.triangle_count() > 0);
    assert_eq!(
        resolve_step_tolerance(0.0).unwrap(),
        STEP_TOLERANCE_DEFAULT_MM
    );
    let stl = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../samples/calibration_cube_20mm.stl"),
    )
    .unwrap();
    assert!(load_slice_mesh_tol("cube.stl", &stl, false, 9.0).is_ok());
}
