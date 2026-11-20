//! A plan that does not opt into creases is the plan v6.12.0 gave, on walls
//! with sharp edges that are not folded.
//!
//! Three synthetic walls, each planned balanced and to twice the bare
//! stiffness with every other option at its default:
//! - a floor that runs over a radius-3 fillet (three 30° facets) into a
//!   wall, as a fillet extracted by `ribWall` with default options;
//! - a floor and a wall meeting at 90° along one edge, as `wall.addFaces`
//!   across a sharp edge gives;
//! - a floor with a face standing on one of its mesh lines (every edge of
//!   that line carries three triangles), as `addFaces` of a standing face.
//!
//! The expected prints were made by `sharp_walls/mod.rs` compiled against
//! origin/main at 02989e0f (v6.12.0). They are compared byte for byte:
//! every f64 is printed so it parses back to the same bits, and the plan's
//! mesh is a hash of its bits. Do not regenerate them from this branch.
//!
//! v6.12.0 itself prints differently in the last bits on Linux and on
//! Windows (the platforms' maths libraries round some functions
//! differently), so there is one set per platform, each generated from
//! v6.12.0 on that platform: `_linux` (WSL Ubuntu 24.04, the same as CI;
//! release and debug builds print the same) and `_windows` (MSVC). Another
//! platform has no v6.12.0 print to compare with, and says so.

mod sharp_walls;

use lime_sim::shell::planner::plan_ribs;
use sharp_walls::{print, request, sharpness, walls};

macro_rules! prints {
    ($suffix:literal) => {
        [
            ("fillet_balanced", include_str!(concat!("sharp_fillet_balanced_v6120_02989e0f_", $suffix, ".txt"))),
            ("fillet_stiffer2", include_str!(concat!("sharp_fillet_stiffer2_v6120_02989e0f_", $suffix, ".txt"))),
            ("right_angle_balanced", include_str!(concat!("sharp_right_angle_balanced_v6120_02989e0f_", $suffix, ".txt"))),
            ("right_angle_stiffer2", include_str!(concat!("sharp_right_angle_stiffer2_v6120_02989e0f_", $suffix, ".txt"))),
            ("t_junction_balanced", include_str!(concat!("sharp_t_junction_balanced_v6120_02989e0f_", $suffix, ".txt"))),
            ("t_junction_stiffer2", include_str!(concat!("sharp_t_junction_stiffer2_v6120_02989e0f_", $suffix, ".txt"))),
        ]
    };
}

const LINUX: [(&str, &str); 6] = prints!("linux");
const WINDOWS: [(&str, &str); 6] = prints!("windows");

/// This platform's v6.12.0 prints, if there are any.
fn v6120() -> Option<&'static [(&'static str, &'static str); 6]> {
    if cfg!(target_os = "linux") {
        Some(&LINUX)
    } else if cfg!(target_os = "windows") {
        Some(&WINDOWS)
    } else {
        None
    }
}

fn expected(name: &str) -> Option<String> {
    let text = v6120()?
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap_or_else(|| panic!("no v6.12.0 print for {name}"))
        .1;
    // A Windows checkout may turn the fixture's line ends into CRLF.
    Some(text.replace("\r\n", "\n"))
}

fn first_difference(got: &str, want: &str) -> String {
    for (i, (g, w)) in got.lines().zip(want.lines()).enumerate() {
        if g != w {
            return format!("line {}:\n  got  {g}\n  want {w}", i + 1);
        }
    }
    format!(
        "{} lines against {}",
        got.lines().count(),
        want.lines().count()
    )
}

#[test]
fn the_walls_have_sharp_edges() {
    for (name, mesh, _) in walls() {
        let (max, sharp, tee) = sharpness(&mesh);
        eprintln!("{name}: largest dihedral {max:.1}°, {sharp} edges over 20°, {tee} edges with three or more triangles");
        assert!(max > 20.0 && sharp > 0, "{name} has no edge over 20°");
        if name.starts_with("t_junction") {
            assert!(tee > 0, "{name} has no T-junction edge");
        }
    }
}

#[test]
fn a_default_plan_is_v6_12_0_on_sharp_walls() {
    if v6120().is_none() {
        eprintln!("no v6.12.0 prints for this platform: not compared");
        return;
    }
    for (name, mesh, goal) in walls() {
        let req = request(mesh, goal);
        assert!(!req.options.creases, "creases must be off by default");
        let got = print(
            name,
            &plan_ribs(&req).unwrap_or_else(|e| panic!("{}", e.message)),
        );
        let want = expected(name).expect("a print on this platform");
        assert!(
            got == want,
            "{name} differs from v6.12.0: {}",
            first_difference(&got, &want)
        );
    }
}

/// The option is what changes these plans: with creases on, at least one
/// of them leaves v6.12.0 (all six did when measured).
#[test]
fn creases_on_is_what_changes_them() {
    if v6120().is_none() {
        eprintln!("no v6.12.0 prints for this platform: not compared");
        return;
    }
    let mut changed = Vec::new();
    for (name, mesh, goal) in walls() {
        let mut req = request(mesh, goal);
        req.options.creases = true;
        let plan = plan_ribs(&req).unwrap_or_else(|e| panic!("{}", e.message));
        let got = print(name, &plan);
        if Some(got) != expected(name) {
            changed.push(name);
        }
        eprintln!(
            "{name} creases on: {} ribs, x{:.6}, {:.3} mm3",
            plan.ribs.len(),
            plan.stiffness_factor,
            plan.rib_volume_mm3
        );
    }
    eprintln!("creases on changes {changed:?}");
    assert!(!changed.is_empty(), "creases on changed nothing");
}
