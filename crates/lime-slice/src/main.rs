use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use clap::{Parser, Subcommand};
mod jobs;

use lime_slice_core::{
    pareto_estimates, slice_request, Axis, BlendMode, GcodeText, Gyroid3d, Mesh, RigidPose,
    ScarfSeam, SeamPlacement, SliceRequest, SliceSettings, StrategyId, ZHopMode,
};

#[derive(Parser)]
#[command(name = "lime-slice", about = "Lime Slice FDM slicer")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[allow(clippy::large_enum_variant)]
#[derive(Subcommand)]
enum Cmd {
    /// Slice a mesh to G-code.
    Slice {
        input: PathBuf,
        #[arg(long, default_value = "region")]
        blend: String,
        #[arg(long, default_value = "x")]
        axis: String,
        #[arg(long)]
        at: Option<f64>,
        #[arg(long, default_value_t = 0.2)]
        layer_height: f64,
        /// Extrusion width, mm. Defaults to 1.125 × the nozzle, held to 0.2..1.2 mm as in the UI.
        #[arg(long)]
        line_width: Option<f64>,
        /// Nozzle diameter, mm, for the printer profile and the audit.
        #[arg(long, default_value_t = 0.4)]
        nozzle: f64,
        /// Part scale in percent about its bounding-box centre, as the UI's Scale %. The part still sits on the bed.
        #[arg(long, default_value_t = 100.0)]
        scale: f64,
        /// Turn the part about its bounding-box centre before slicing, such as `x90` or
        /// `y-90,z45`. Turns apply in order about the bed axes, then the part sits on the bed.
        #[arg(long, value_delimiter = ',', allow_hyphen_values = true)]
        rotate: Vec<String>,
        #[arg(long, default_value_t = 4.0)]
        bottom_mm: f64,
        #[arg(long, default_value_t = 6.0)]
        transition_mm: f64,
        #[arg(long, default_value_t = 0.5)]
        toughness: f64,
        /// Vary layer height by local slope inside the min/max band.
        #[arg(long, default_value_t = false)]
        adaptive: bool,
        #[arg(long, default_value_t = 0.08)]
        adaptive_min: f64,
        /// Thick-end of the adaptive band. 0 uses the nominal layer height.
        #[arg(long, default_value_t = 0.0)]
        adaptive_max: f64,
        /// Sparse-grid supports with interface layers under overhangs.
        #[arg(long, default_value_t = false)]
        supports: bool,
        /// Overhang angle from horizontal, degrees.
        #[arg(long, default_value_t = 45.0)]
        support_angle: f64,
        /// Variable-width walls, thin walls, and gap fill.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        variable_width: bool,
        /// Fit G2/G3 arcs where the path is circular.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        arc_fit: bool,
        /// Reorder travels and hide seams on corners.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        travel_opt: bool,
        /// Slow overhangs, raise the fan, and tag bridges.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        overhang_control: bool,
        /// Previous planner: line infill, no arcs, one feed.
        #[arg(long, default_value_t = false)]
        classic: bool,
        /// `tree` (organic branching, default) or `grid`.
        #[arg(long, default_value = "tree")]
        support_style: String,
        /// Organic branch lean from vertical, degrees.
        #[arg(long, default_value_t = 40.0)]
        branch_angle: f64,
        /// Organic tip diameter, millimetres.
        #[arg(long, default_value_t = 0.8)]
        tip_diameter: f64,
        /// Organic trunk diameter, millimetres.
        #[arg(long, default_value_t = 4.2)]
        trunk_diameter: f64,
        /// Sparse support shaft height multiplier. `1` keeps the model layer height.
        #[arg(long, default_value_t = 1.0)]
        support_height_mult: f64,
        /// Combine sparse infill every few layers on speed and light efficiency blends.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        infill_combine: bool,
        /// Hole-aware combing. Retract only when the inset route is blocked.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        combing: bool,
        /// Per-feature speeds and accelerations.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        feature_speeds: bool,
        /// Where each wall starts. `blend` (strategy default), `nearest`,
        /// `aligned`, or `rear`.
        #[arg(long, default_value = "blend")]
        seam: String,
        /// Scarf joints: `blend` (strategy default), `off`, `outer`, or `all`.
        #[arg(long, default_value = "blend")]
        scarf_seam: String,
        /// Scarf overlap length in millimetres.
        #[arg(long, default_value_t = 10.0)]
        scarf_length: f64,
        /// Z and flow steps on each scarf ramp.
        #[arg(long, default_value_t = 8)]
        scarf_steps: u32,
        /// Scarf start height as a fraction of the layer height.
        #[arg(long, default_value_t = 0.15)]
        scarf_start_height: f64,
        /// Scarf start flow. Ramps to 1 at full layer height.
        #[arg(long, default_value_t = 0.55)]
        scarf_start_flow: f64,
        /// 3D gyroid: `blend` (toughness), `off` (2D sine), or `on` (force).
        #[arg(long, default_value = "blend")]
        gyroid_3d: String,
        /// Z-hop: `off`, `blend`, `always`, or `smart`.
        #[arg(long, default_value = "blend")]
        z_hop: String,
        /// Hop height in millimetres.
        #[arg(long, default_value_t = 0.4)]
        z_hop_height: f64,
        /// Skip hops shorter than this travel, in millimetres.
        #[arg(long, default_value_t = 2.0)]
        z_hop_min_travel: f64,
        /// Use the pre-lookahead estimator that stops at every segment end.
        #[arg(long, default_value_t = false)]
        classic_estimator: bool,
        /// Klipper junction deviation in millimetres.
        #[arg(long, default_value_t = 0.02)]
        junction_deviation: f64,
        /// Drop outline vertices the nozzle cannot trace, on every layer's cut.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        simplify: bool,
        /// Outline tolerance in millimetres. `0` uses a sixteenth of the nozzle.
        #[arg(long, default_value_t = 0.0)]
        simplify_error: f64,
        /// Chord tolerance in millimetres when the input is STEP. STL and 3MF ignore it.
        #[arg(long, default_value_t = 0.1)]
        step_tolerance: f64,
        /// Also check contour coverage and support placement, and print the report.
        #[arg(long, default_value_t = false)]
        audit: bool,
        /// Also plan a single-strategy speed slice and report its time. Off by
        /// default: it doubles the wall time and changes no output.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = false)]
        baseline: bool,
        /// A JSON array of support edits to replay on the grown supports.
        #[arg(long)]
        support_edits: Option<PathBuf>,
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Time single-strategy and blended slices.
    Bench { input: PathBuf },
    /// HTTP API used by the browser UI.
    Serve {
        #[arg(long, default_value_t = 43118)]
        port: u16,
        /// Address to bind. Stays on loopback unless you set this, for example `0.0.0.0`.
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Shared secret required on every request except CORS preflight.
        /// Send `Authorization: Bearer <token>` or `?token=`. Overrides `LIME_SLICE_TOKEN`.
        #[arg(long)]
        token: Option<String>,
        /// Keep finished slices here and load a repeated request instead of slicing it.
        #[arg(long)]
        cache_dir: Option<PathBuf>,
    },
    /// Calibration prints.
    Calibrate {
        #[command(subcommand)]
        kind: CalibrateCmd,
    },
}

#[derive(Subcommand)]
enum CalibrateCmd {
    /// Pressure-advance tower with a slow-fast-slow line in each band.
    Pa {
        /// `klipper` emits SET_PRESSURE_ADVANCE. `marlin` emits M900 K.
        #[arg(long, default_value = "klipper")]
        firmware: String,
        #[arg(long, default_value_t = 0.0)]
        start: f64,
        #[arg(long, default_value_t = 0.08)]
        end: f64,
        #[arg(long, default_value_t = 0.01)]
        step: f64,
        #[arg(long, default_value_t = 0.2)]
        layer_height: f64,
        #[arg(long, default_value_t = 2.0)]
        band_height: f64,
        /// Slow feed. The default sits well under the volumetric cap.
        #[arg(long, default_value_t = 40.0)]
        slow: f64,
        /// Fast feed. Capped by the printer volumetric limit so it still differs from slow.
        #[arg(long, default_value_t = 200.0)]
        fast: f64,
        #[arg(long, default_value_t = 3000.0)]
        accel: f64,
        #[arg(short, long)]
        output: PathBuf,
    },
}

fn main() {
    if let Err(err) = run() {
        eprintln!("lime-slice: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    match Cli::parse().cmd {
        Cmd::Slice {
            input,
            blend,
            axis,
            at,
            layer_height,
            line_width,
            nozzle,
            scale,
            rotate,
            bottom_mm,
            transition_mm,
            toughness,
            adaptive,
            adaptive_min,
            adaptive_max,
            supports,
            support_angle,
            variable_width,
            arc_fit,
            travel_opt,
            overhang_control,
            classic,
            support_style,
            branch_angle,
            tip_diameter,
            trunk_diameter,
            support_height_mult,
            infill_combine,
            combing,
            feature_speeds,
            seam,
            scarf_seam,
            scarf_length,
            scarf_steps,
            scarf_start_height,
            scarf_start_flow,
            gyroid_3d,
            z_hop,
            z_hop_height,
            z_hop_min_travel,
            classic_estimator,
            junction_deviation,
            simplify,
            simplify_error,
            step_tolerance,
            audit,
            baseline,
            support_edits,
            output,
        } => {
            let seam = SeamPlacement::parse(&seam)?;
            let scarf_seam = ScarfSeam::parse(&scarf_seam)?;
            let gyroid_3d = Gyroid3d::parse(&gyroid_3d)?;
            let z_hop = ZHopMode::parse(&z_hop)?;
            let blend = blend_mode(
                &blend,
                &axis,
                at,
                bottom_mm,
                transition_mm,
                toughness,
                &input,
            )?;
            let settings = SliceSettings {
                layer_height,
                line_width: line_width.unwrap_or((nozzle * 1.125).clamp(0.2, 1.2)),
                adaptive,
                adaptive_min,
                adaptive_max: if adaptive_max > 0.0 {
                    adaptive_max
                } else {
                    layer_height
                },
                supports,
                support_angle,
                variable_width,
                arc_fit,
                travel_opt,
                overhang_control,
                classic,
                support_style: if support_style == "grid" {
                    lime_slice_core::SupportStyle::Grid
                } else {
                    lime_slice_core::SupportStyle::Tree
                },
                branch_angle,
                tip_diameter,
                trunk_diameter,
                support_height_mult,
                infill_combine,
                combing,
                feature_speeds,
                seam,
                scarf_seam,
                scarf_length,
                scarf_steps,
                scarf_start_height,
                scarf_start_flow,
                gyroid_3d,
                z_hop,
                z_hop_height,
                z_hop_min_travel,
                classic_estimator,
                junction_deviation_mm: junction_deviation,
                simplify,
                simplify_error_mm: simplify_error,
                baseline,
                ..SliceSettings::default()
            };
            let source = read_input(&input, scale / 100.0, step_tolerance)?;
            let mut request = request_for(&source, &blend, &settings, nozzle);
            request.step_tolerance_mm = step_tolerance;
            if !rotate.is_empty() {
                request.pose = Some(turned_pose(&source, &rotate, step_tolerance)?);
            }
            if let Some(path) = support_edits {
                let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
                request.support_edits =
                    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
            }
            let response = slice_request(&request, lime_slice_core::Job::default())
                .map_err(|e| e.to_string())?;
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&output, &response.gcode).map_err(|e| e.to_string())?;
            print_summary(&input, &response);
            for (n, edit) in response.support_edits.iter().enumerate() {
                println!("{}", edit_line(n, edit));
            }
            if let Some(warning) = coverage_line(&response.coverage) {
                eprintln!("lime-slice: warning: supports leave {warning}");
            }
            if let Some(warning) = response.in_air.and_then(in_air_line) {
                eprintln!("lime-slice: warning: {warning}");
            }
            println!("wrote {}", output.display());
            if audit {
                let mesh = lime_slice_core::load_slice_mesh_tol(
                    &source.name,
                    &source.bytes,
                    request.pose.is_some(),
                    request.step_tolerance_mm,
                )?;
                let audit_settings = SliceSettings::from_request(&request);
                let report =
                    lime_slice_core::audit_slice(&mesh, &request.blend, &audit_settings, nozzle)?;
                print_audit(&report);
            }
            if !response.sanity.ok {
                return Err(response.sanity.notes.join("; "));
            }
            Ok(())
        }
        Cmd::Bench { input } => bench(&input),
        Cmd::Serve {
            port,
            host,
            cache_dir,
            token,
        } => serve(
            &host,
            port,
            cache_dir,
            resolve_serve_token(token, token_from_env()),
        ),
        Cmd::Calibrate { kind } => calibrate(kind),
    }
}

fn calibrate(kind: CalibrateCmd) -> Result<(), String> {
    match kind {
        CalibrateCmd::Pa {
            firmware,
            start,
            end,
            step,
            layer_height,
            band_height,
            slow,
            fast,
            accel,
            output,
        } => {
            let tower = lime_slice_core::pressure_advance_tower(&lime_slice_core::PaCalib {
                firmware: lime_slice_core::PaFirmware::parse(&firmware)?,
                start,
                end,
                step,
                layer_height,
                band_height,
                slow_mm_s: slow,
                fast_mm_s: fast,
                accel,
                ..lime_slice_core::PaCalib::default()
            })?;
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&output, &tower.gcode).map_err(|e| e.to_string())?;
            println!(
                "PA {}  bands {}  K {:.4}..{:.4} step {:.4}  slow {:.1} fast {:.1} mm/s  E {:.1} mm",
                firmware,
                tower.bands.len(),
                tower.bands.first().map(|b| b.k).unwrap_or(0.0),
                tower.bands.last().map(|b| b.k).unwrap_or(0.0),
                step,
                tower.slow_mm_s,
                tower.fast_mm_s,
                tower.final_e
            );
            for band in &tower.bands {
                println!(
                    "  band {}  K {:.4}  Z {:.3}..{:.3}",
                    band.index, band.k, band.z0, band.z1
                );
            }
            println!("wrote {}", output.display());
            Ok(())
        }
    }
}

fn bench(input: &Path) -> Result<(), String> {
    let mesh = load_input(input)?;
    let (min, max) = mesh.bounds().ok_or("empty mesh")?;
    let mid_x = (min[0] + max[0]) * 0.5;
    let modes = [
        (
            "speed",
            BlendMode::Single {
                strategy: StrategyId::Speed,
            },
        ),
        (
            "toughness",
            BlendMode::Single {
                strategy: StrategyId::Toughness,
            },
        ),
        (
            "layer blend",
            BlendMode::ByLayer {
                bottom_mm: (max[2] * 0.2).max(1.0),
                transition_mm: (max[2] * 0.3).max(1.0),
            },
        ),
        (
            "region blend",
            BlendMode::ByRegion {
                axis: Axis::X,
                at_mm: mid_x,
            },
        ),
    ];
    println!(
        "mesh {}  triangles {}  size {:.1} x {:.1} x {:.1} mm",
        input.display(),
        mesh.triangle_count(),
        max[0] - min[0],
        max[1] - min[1],
        max[2] - min[2]
    );
    if let Ok(indexed) = lime_slice_core::contour_times(&mesh, 0.2) {
        println!("contours  parallel Z-index {indexed:.2} ms");
    }
    println!("new path vs classic planner (lines, no arcs, one feed)");
    println!(
        "{:<14} {:>10} {:>10} {:>10} {:>10} {:>8} {:>10} {:>8} {:>8} {:>8} {:>8}",
        "mode",
        "slice ms",
        "classic ms",
        "time s",
        "filament g",
        "arcs",
        "travel mm",
        "retract",
        "speed",
        "eff",
        "tough"
    );
    let fresh = SliceSettings::default();
    let classic = SliceSettings {
        classic: true,
        ..SliceSettings::default()
    };
    for (name, mode) in modes {
        let response =
            lime_slice_core::slice_configured(&mesh, &mode, &Default::default(), &fresh)?;
        let old = lime_slice_core::slice_configured(&mesh, &mode, &Default::default(), &classic)?;
        println!(
            "{:<14} {:>10.2} {:>10.2} {:>10.1} {:>10.2} {:>8} {:>10.1} {:>8} {:>8.1} {:>8.1} {:>8.1}  {}",
            name,
            response.core_ms,
            old.core_ms,
            response.estimate.seconds,
            response.estimate.filament_g,
            response.estimate.arc_moves,
            response.sanity.travel_length_mm,
            response.sanity.retracts,
            response.score.speed,
            response.score.efficiency,
            response.score.toughness,
            if response.sanity.ok { "ok" } else { "FAIL" }
        );
        println!(
            "  scarf loops {}  mean overlap {:.2} mm  max Z step {:.3} mm",
            response.estimate.scarfed_loops,
            response.estimate.mean_scarf_mm,
            response.estimate.max_seam_z_step_mm
        );
        println!(
            "  {} tris  outline tolerance {:.3} mm  contours {:.1} ms  supports {:.1} ms  toolpaths {:.1} ms  order {:.1} ms  combing {:.1} ms  emit {:.1} ms",
            response.mesh.triangles,
            response.mesh.outline_tolerance_mm,
            response.stages.contour_ms,
            response.stages.support_ms,
            response.stages.toolpath_ms,
            response.stages.order_ms,
            response.stages.comb_ms,
            response.stages.emit_ms
        );
        if !response.sanity.ok {
            println!("  {}", response.sanity.notes.join("; "));
        }
        println!(
            "  classic time {:.1} s  filament {:.2} g ({:.0} mm)  travel {:.1} mm  retracts {}  score speed {:.1} eff {:.1} tough {:.1}",
            old.estimate.seconds,
            old.estimate.filament_g,
            old.estimate.filament_mm,
            old.sanity.travel_length_mm,
            old.sanity.retracts,
            old.score.speed,
            old.score.efficiency,
            old.score.toughness
        );
    }
    let speed = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    println!("supports on speed blend, angle 45°, vs classic grid");
    println!(
        "{:<16} {:>10} {:>10} {:>10} {:>8}",
        "style", "time s", "filament g", "travel mm", "retract"
    );
    for (label, style, mult) in [
        ("grid", lime_slice_core::SupportStyle::Grid, 1.0),
        ("tree", lime_slice_core::SupportStyle::Tree, 1.0),
        ("tree x2 shaft", lime_slice_core::SupportStyle::Tree, 2.0),
    ] {
        let response = lime_slice_core::slice_configured(
            &mesh,
            &speed,
            &Default::default(),
            &SliceSettings {
                supports: true,
                support_style: style,
                support_height_mult: mult,
                ..SliceSettings::default()
            },
        )?;
        println!(
            "{:<16} {:>10.1} {:>10.2} {:>10.1} {:>8}  {}",
            label,
            response.estimate.seconds,
            response.estimate.filament_g,
            response.sanity.travel_length_mm,
            response.sanity.retracts,
            if response.sanity.ok { "ok" } else { "FAIL" }
        );
    }
    let routed = lime_slice_core::slice_configured(
        &mesh,
        &speed,
        &Default::default(),
        &SliceSettings::default(),
    )?;
    let straight = lime_slice_core::slice_configured(
        &mesh,
        &speed,
        &Default::default(),
        &SliceSettings {
            combing: false,
            ..SliceSettings::default()
        },
    )?;
    println!(
        "combing speed  travel {:.1} mm  retracts {}   |  straight travel {:.1} mm  retracts {}",
        routed.sanity.travel_length_mm,
        routed.sanity.retracts,
        straight.sanity.travel_length_mm,
        straight.sanity.retracts
    );
    println!("scarf off vs outer (butt seam overlap is 0; max Z step is the ramp increment)");
    println!(
        "{:<14} {:>10} {:>10} {:>10} {:>10} {:>8} {:>8} {:>10} {:>10}",
        "mode", "off s", "outer s", "off g", "outer g", "off arcs", "on arcs", "overlap", "z step"
    );
    for (name, mode) in [
        (
            "speed",
            BlendMode::Single {
                strategy: StrategyId::Speed,
            },
        ),
        (
            "toughness",
            BlendMode::Single {
                strategy: StrategyId::Toughness,
            },
        ),
    ] {
        let off = lime_slice_core::slice_configured(
            &mesh,
            &mode,
            &Default::default(),
            &SliceSettings {
                scarf_seam: ScarfSeam::Off,
                ..SliceSettings::default()
            },
        )?;
        let on = lime_slice_core::slice_configured(
            &mesh,
            &mode,
            &Default::default(),
            &SliceSettings {
                scarf_seam: ScarfSeam::Outer,
                ..SliceSettings::default()
            },
        )?;
        println!(
            "{:<14} {:>10.1} {:>10.1} {:>10.2} {:>10.2} {:>8} {:>8} {:>10.2} {:>10.3}  {}",
            name,
            off.estimate.seconds,
            on.estimate.seconds,
            off.estimate.filament_g,
            on.estimate.filament_g,
            off.estimate.arc_moves,
            on.estimate.arc_moves,
            on.estimate.mean_scarf_mm,
            on.estimate.max_seam_z_step_mm,
            if off.sanity.ok && on.sanity.ok {
                "ok"
            } else {
                "FAIL"
            }
        );
        println!(
            "  off slice {:.2} ms  outer slice {:.2} ms  scarfed loops {}",
            off.core_ms, on.core_ms, on.estimate.scarfed_loops
        );
    }
    let tough = BlendMode::Single {
        strategy: StrategyId::Toughness,
    };
    println!("gyroid3d vs 2d (--gyroid-3d off, same as main) vs classic");
    println!(
        "{:<14} {:>10} {:>10} {:>10} {:>10} {:>10} {:>10}",
        "infill", "slice ms", "time s", "filament g", "travel mm", "retract", "tough"
    );
    for (label, settings) in [
        ("gyroid3d", SliceSettings::default()),
        (
            "gyroid2d",
            SliceSettings {
                gyroid_3d: Gyroid3d::Off,
                z_hop: ZHopMode::Off,
                ..SliceSettings::default()
            },
        ),
        ("classic", classic_settings()),
    ] {
        let response =
            lime_slice_core::slice_configured(&mesh, &tough, &Default::default(), &settings)?;
        println!(
            "{:<14} {:>10.2} {:>10.1} {:>10.2} {:>10.1} {:>10} {:>10.1}",
            label,
            response.core_ms,
            response.estimate.seconds,
            response.estimate.filament_g,
            response.sanity.travel_length_mm,
            response.sanity.retracts,
            response.score.toughness
        );
    }
    println!("z-hop on this mesh (toughness smart is the blend default; speed stays off)");
    println!(
        "{:<18} {:>10} {:>10} {:>10} {:>8}",
        "mode", "time s", "travel mm", "retract", "hops"
    );
    for (label, mode, hop) in [
        ("speed blend", &speed, ZHopMode::Blend),
        ("speed smart", &speed, ZHopMode::Smart),
        ("tough off", &tough, ZHopMode::Off),
        ("tough smart", &tough, ZHopMode::Smart),
        ("tough always", &tough, ZHopMode::Always),
    ] {
        let response = lime_slice_core::slice_configured(
            &mesh,
            mode,
            &Default::default(),
            &SliceSettings {
                z_hop: hop,
                ..SliceSettings::default()
            },
        )?;
        println!(
            "{:<18} {:>10.1} {:>10.1} {:>10} {:>8}",
            label,
            response.estimate.seconds,
            response.sanity.travel_length_mm,
            response.sanity.retracts,
            response.estimate.z_hops
        );
    }
    let supported = lime_slice_core::slice_configured(
        &mesh,
        &tough,
        &Default::default(),
        &SliceSettings {
            supports: true,
            z_hop: ZHopMode::Smart,
            ..SliceSettings::default()
        },
    )?;
    let supported_off = lime_slice_core::slice_configured(
        &mesh,
        &tough,
        &Default::default(),
        &SliceSettings {
            supports: true,
            z_hop: ZHopMode::Off,
            ..SliceSettings::default()
        },
    )?;
    println!(
        "tough smart supports  time {:.1} s (off {:.1} s)  hops {}  travel {:.1} mm",
        supported.estimate.seconds,
        supported_off.estimate.seconds,
        supported.estimate.z_hops,
        supported.sanity.travel_length_mm
    );
    Ok(())
}

fn classic_settings() -> SliceSettings {
    SliceSettings {
        classic: true,
        ..SliceSettings::default()
    }
}

fn gcode_store() -> &'static Mutex<HashMap<String, GcodeText>> {
    static STORE: std::sync::LazyLock<Mutex<HashMap<String, GcodeText>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &STORE
}

fn park_gcode(text: GcodeText) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let token = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    let mut guard = gcode_store().lock().expect("gcode store");
    if guard.len() > 6 {
        guard.clear();
    }
    guard.insert(token.clone(), text);
    token
}

/// Slices kept on disk by `serve --cache-dir`.
static SLICE_CACHE: std::sync::OnceLock<lime_slice_core::SliceCache> = std::sync::OnceLock::new();

fn serve(
    host: &str,
    port: u16,
    cache_dir: Option<PathBuf>,
    token: Option<String>,
) -> Result<(), String> {
    lime_slice_core::keep_support_bases(true);
    if let Some(dir) = cache_dir {
        let _ = SLICE_CACHE.set(lime_slice_core::SliceCache::new(dir, 2 << 30));
    }
    let token = token.filter(|value| !value.is_empty());
    if open_bind_without_auth(host, token.as_deref()) {
        eprintln!(
            "warning: lime-slice is listening on {host} with no authentication. Anyone who can reach this port can submit meshes and download G-code. Pass --token or set LIME_SLICE_TOKEN."
        );
    }
    let addr = listen_addr(host, port);
    let server = tiny_http::Server::http(&addr).map_err(|e| e.to_string())?;
    eprintln!("lime-slice api http://{addr}");
    let shared = token.map(std::sync::Arc::<str>::from);
    // One thread per request, so a new slice or /api/cancel reaches the server
    // while an older slice is still planning. Starting a slice supersedes it.
    for request in server.incoming_requests() {
        let shared = shared.clone();
        std::thread::spawn(move || handle(request, shared.as_deref()));
    }
    Ok(())
}

/// `LIME_SLICE_TOKEN` when `--token` was omitted. An empty value means no token.
fn token_from_env() -> Option<String> {
    std::env::var("LIME_SLICE_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
}

fn resolve_serve_token(flag: Option<String>, env: Option<String>) -> Option<String> {
    flag.filter(|value| !value.is_empty())
        .or_else(|| env.filter(|value| !value.is_empty()))
}

fn listen_addr(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "::1"
        || host == "0:0:0:0:0:0:0:1"
}

/// True when the bind is reachable from another machine and no shared token is set.
fn open_bind_without_auth(host: &str, token: Option<&str>) -> bool {
    !is_loopback_host(host) && token.unwrap_or("").is_empty()
}

fn split_target(url: &str) -> (&str, &str) {
    url.split_once('?').unwrap_or((url, ""))
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (name == key).then(|| percent_decode(value))
    })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header_value<'a>(headers: &'a [tiny_http::Header], name: &'static str) -> Option<&'a str> {
    headers
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

/// No token configured: every request is allowed. Otherwise the bearer header or `?token=` must match.
fn request_authorized(expected: Option<&str>, authorization: Option<&str>, query: &str) -> bool {
    let Some(expected) = expected.filter(|value| !value.is_empty()) else {
        return true;
    };
    if authorization.map(str::trim).is_some_and(|header| {
        header == expected
            || header
                .strip_prefix("Bearer ")
                .or_else(|| header.strip_prefix("bearer "))
                .is_some_and(|bearer| bearer.trim() == expected)
    }) {
        return true;
    }
    query_param(query, "token").is_some_and(|value| value == expected)
}

fn is_http_origin(value: &str) -> bool {
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    match rest {
        Some(rest) => {
            !rest.is_empty()
                && !value
                    .bytes()
                    .any(|byte| byte == b'\r' || byte == b'\n' || byte == b' ')
        }
        None => false,
    }
}

/// Wildcard CORS stays when no token is set. A token echoes the request origin and allows `Authorization`.
fn cors_origin(token_required: bool, origin: Option<&str>) -> String {
    if !token_required {
        return "*".to_string();
    }
    origin
        .map(str::trim)
        .filter(|value| is_http_origin(value))
        .unwrap_or("*")
        .to_string()
}

fn handle(mut request: tiny_http::Request, token: Option<&str>) {
    {
        let method = request.method().as_str().to_string();
        let url = request.url().to_string();
        let (path, query) = split_target(&url);
        let path = path.to_string();
        let query = query.to_string();
        let origin = header_value(request.headers(), "Origin").map(str::to_string);
        let authorization = header_value(request.headers(), "Authorization").map(str::to_string);
        let token_required = token.is_some_and(|value| !value.is_empty());
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            let _ = request.respond(text_response(
                400,
                "bad body",
                token_required,
                origin.as_deref(),
            ));
            return;
        }
        if method != "OPTIONS" && !request_authorized(token, authorization.as_deref(), &query) {
            let _ = request.respond(text_response(
                401,
                err_json("unauthorized"),
                token_required,
                origin.as_deref(),
            ));
            return;
        }
        if method != "OPTIONS" {
            if let Some(reply) = jobs::route(&method, &path, &body) {
                match reply {
                    jobs::JobReply::Json(status, payload) => {
                        let _ = request.respond(text_response(
                            status,
                            payload,
                            token_required,
                            origin.as_deref(),
                        ));
                    }
                    jobs::JobReply::Events { id, watch } => {
                        jobs::respond_events(request, id, watch, token_required, origin.as_deref());
                    }
                }
                return;
            }
        }
        let (status, payload) = if method == "OPTIONS" {
            (204, String::new())
        } else if method == "GET" && path.starts_with("/api/strategies") {
            let mut toughness = 0.0;
            let mut layer_h = 0.2;
            let mut width = 0.45;
            let mut flow = 12.0;
            for pair in query.split('&') {
                let Some((k, v)) = pair.split_once('=') else {
                    continue;
                };
                let Ok(n) = v.parse::<f64>() else { continue };
                match k {
                    "toughness" => toughness = n,
                    "layerHeight" => layer_h = n,
                    "lineWidth" => width = n,
                    "maxVol" => flow = n,
                    _ => {}
                }
            }
            let card = lime_slice_core::strategy_card(toughness, layer_h, width, flow);
            (
                200,
                serde_json::to_string(&card).unwrap_or_else(|e| err_json(&e.to_string())),
            )
        } else if method == "POST" && path.starts_with("/api/cancel") {
            lime_slice_core::cancel_all();
            (200, r#"{"ok":true}"#.into())
        } else if method == "GET" && path.starts_with("/api/health") {
            (200, r#"{"ok":true}"#.into())
        } else if method == "POST" && path.starts_with("/api/calibrate/pa") {
            match serde_json::from_str::<lime_slice_core::PaCalibRequest>(&body) {
                Ok(req) => match lime_slice_core::pressure_advance_from_request(&req) {
                    Ok(res) => (
                        200,
                        serde_json::to_string(&res).unwrap_or_else(|e| err_json(&e.to_string())),
                    ),
                    Err(err) => (400, err_json(&err)),
                },
                Err(err) => (400, err_json(&err.to_string())),
            }
        } else if method == "GET" && path.starts_with("/api/gcode/") {
            let gcode_id = path.trim_start_matches("/api/gcode/").trim();
            let text = gcode_store()
                .lock()
                .expect("gcode store")
                .get(gcode_id)
                .cloned();
            match text {
                Some(text) => (200, text.text()),
                None => (404, err_json("g-code expired")),
            }
        } else if method == "POST" && path.starts_with("/api/mesh") {
            match serde_json::from_str::<SliceRequest>(&body) {
                Ok(req) => match decode_mesh(&req) {
                    Ok(bytes) => match lime_slice_core::mesh_preview_tol(
                        &req.filename,
                        &bytes,
                        req.step_tolerance_mm,
                    ) {
                        Ok(preview) => (
                            200,
                            serde_json::to_string(&preview)
                                .unwrap_or_else(|e| err_json(&e.to_string())),
                        ),
                        Err(err) => (400, err_json(&err)),
                    },
                    Err(err) => (400, err_json(&err)),
                },
                Err(err) => (400, err_json(&err.to_string())),
            }
        } else if method == "POST" && path.starts_with("/api/pareto") {
            match serde_json::from_str::<SliceRequest>(&body) {
                Ok(req) => match decode_mesh(&req) {
                    Ok(bytes) => match lime_slice_core::load_slice_mesh_tol(
                        &req.filename,
                        &bytes,
                        req.pose.is_some(),
                        req.step_tolerance_mm,
                    ) {
                        Ok(mesh) => {
                            let profile = req.printer.clone().unwrap_or_default();
                            let settings = SliceSettings {
                                job: lime_slice_core::Job::start(),
                                ..SliceSettings::from_request(&req)
                            };
                            match pareto_estimates(&mesh, &profile, &settings) {
                                Ok(points) => (
                                    200,
                                    serde_json::to_string(&points)
                                        .unwrap_or_else(|e| err_json(&e.to_string())),
                                ),
                                Err(err) => (400, err_json(&err)),
                            }
                        }
                        Err(err) => (400, err_json(&err)),
                    },
                    Err(err) => (400, err_json(&err)),
                },
                Err(err) => (400, err_json(&err.to_string())),
            }
        } else if method == "POST" && path.starts_with("/api/slice") {
            match lime_slice_core::slice_payload(
                &body,
                SLICE_CACHE.get(),
                lime_slice_core::Job::start(),
                park_gcode,
            ) {
                Ok(reply) => (200, reply),
                Err(err) => (400, err_json(&err)),
            }
        } else {
            (404, err_json("not found"))
        };
        let _ = request.respond(text_response(
            status,
            payload,
            token_required,
            origin.as_deref(),
        ));
    }
}

fn text_response(
    status: u16,
    body: impl Into<String>,
    token_required: bool,
    origin: Option<&str>,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let allow_origin = cors_origin(token_required, origin);
    let allow_headers = if token_required {
        "Content-Type, Authorization"
    } else {
        "Content-Type"
    };
    let mut response = tiny_http::Response::from_string(body).with_status_code(status);
    let headers = [
        ("Content-Type", "application/json"),
        ("Access-Control-Allow-Origin", allow_origin.as_str()),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", allow_headers),
    ];
    for (k, v) in headers {
        response.add_header(tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap());
    }
    if token_required && allow_origin != "*" {
        response
            .add_header(tiny_http::Header::from_bytes(b"Vary", b"Origin").expect("vary header"));
    }
    response
}

fn decode_mesh(req: &SliceRequest) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(req.data_b64.trim())
        .map_err(|e| e.to_string())
}

fn err_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

fn print_audit(a: &lime_slice_core::SliceAudit) {
    let coverage = a.sliced_volume_mm3 / a.mesh_volume_mm3.max(1e-9) * 100.0;
    let bridged = a.bridged_mm;
    println!(
        "audit  plan {:.0} ms  layers {}  mesh {:.0} mm3  sliced {:.0} mm3 ({coverage:.1}%, bridged {bridged:.1} mm)  missing {:.1} mm3  repaired layers {}  dropped chains {}",
        a.plan_ms, a.layers, a.mesh_volume_mm3, a.sliced_volume_mm3, a.missing_mm3, a.repaired_layers, a.dropped_chains
    );
    println!(
        "audit  unskinned top {:.1} mm2  worst {}",
        a.unskinned_top_mm2,
        a.worst_unskinned
            .map(|(z, area)| format!("{area:.2} mm2 at z {z:.2}"))
            .unwrap_or_else(|| "none".into())
    );
    println!(
        "audit  open skin {:.1} mm2  worst {}",
        a.open_skin_mm2,
        a.worst_open_skin
            .map(|(z, area)| format!("{area:.2} mm2 at z {z:.2}"))
            .unwrap_or_else(|| "none".into())
    );
    println!(
        "audit  stray bead {:.1} mm2  worst {}",
        a.stray_bead_mm2,
        a.worst_stray
            .map(|(z, area)| format!("{area:.2} mm2 at z {z:.2}"))
            .unwrap_or_else(|| "none".into())
    );
    println!(
        "audit  support {:.1} mm3  inside part {:.2} mm3  floating {:.2} mm3 on {} layers  worst {}",
        a.support_mm3,
        a.support_inside_mm3,
        a.support_floating_mm3,
        a.floating_layers,
        a.worst_floating
            .map(|(z, area)| format!("{area:.2} mm2 at z {z:.2}"))
            .unwrap_or_else(|| "none".into())
    );
    println!(
        "audit  coverage {}",
        coverage_line(&a.coverage).unwrap_or_else(|| "every demanded interface prints".into())
    );
    let t = &a.trees;
    if t.tips > 0 {
        println!(
            "audit  trees {} from {} tips  largest {} tips  tallest {:.1} mm  ends part {} pinched {} bed {}",
            t.trees, t.tips, t.largest_tips, t.tallest_mm, t.on_part, t.pinched, t.on_bed
        );
    }
    for d in &a.tree_depths {
        if d.disks == 0 {
            continue;
        }
        println!(
            "audit  tree depth {:>4.0}-{:<4} mm  disks {:>6}  radius mean {:.2} p90 {:.2} mm  volume {:.0} mm3",
            d.from_mm,
            if d.to_mm.is_finite() { format!("{:.0}", d.to_mm) } else { "inf".into() },
            d.disks,
            d.mean_radius_mm,
            d.p90_radius_mm,
            d.volume_mm3
        );
    }
}

/// One support edit's outcome in one line.
fn edit_line(n: usize, edit: &lime_slice_core::EditOutcomeView) -> String {
    let status = match edit.status {
        lime_slice_core::EditStatus::Applied => "applied".to_string(),
        lime_slice_core::EditStatus::Rebound { moved_mm } => {
            format!("rebound, a site moved {moved_mm:.2} mm")
        }
        lime_slice_core::EditStatus::Stale { missed } => format!("stale, {missed} targets missed"),
    };
    let span = match edit.changed_span {
        Some([lo, hi]) => format!("{} layers changed in {lo}..={hi}", edit.changed_layers),
        None => "no layer changed".to_string(),
    };
    format!(
        "edit {n}  {status}  {span}  newly floating {:.1} mm2 in {} patch{}",
        edit.newly_floating_mm2,
        edit.floating.len(),
        if edit.floating.len() == 1 { "" } else { "es" }
    )
}

/// Unheld overhang patches in one line, largest first. `None` when there are none.
fn coverage_line(gaps: &[lime_slice_core::CoverageGap]) -> Option<String> {
    let largest = gaps.first()?;
    let total: f32 = gaps.iter().map(|g| g.area_mm2).sum();
    Some(format!(
        "{} overhang patch{} unheld, {total:.1} mm2  largest {:.1} mm2 at z {:.2}-{:.2} x {:.1}..{:.1} y {:.1}..{:.1}",
        gaps.len(),
        if gaps.len() == 1 { "" } else { "es" },
        largest.area_mm2,
        largest.z[0],
        largest.z[1],
        largest.min[0],
        largest.max[0],
        largest.min[1],
        largest.max[1]
    ))
}

/// What prints over air with supports off, or `None` when nothing does.
fn in_air_line(air: lime_slice_core::InAir) -> Option<String> {
    let count = |n: u32, one: &str, many: &str| match n {
        0 => None,
        1 => Some(format!("1 {one}")),
        n => Some(format!("{n} {many}")),
    };
    let parts: Vec<String> = [
        count(air.islands, "island", "islands"),
        count(air.overhangs, "overhang", "overhangs"),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!parts.is_empty()).then(|| {
        format!(
            "supports are off; {} would print in the air (--supports holds them up)",
            parts.join(" and ")
        )
    })
}

/// The loader picks STL or 3MF from the file name, so every load of the
/// input must pass its real name.
fn input_name(input: &Path) -> &str {
    input
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("mesh.stl")
}

fn load_input(input: &Path) -> Result<Mesh, String> {
    let bytes = fs::read(input).map_err(|e| e.to_string())?;
    lime_slice_core::load_mesh(input_name(input), &bytes)
}

/// Mesh file as the slicer receives it.
struct Input {
    name: String,
    bytes: Vec<u8>,
}

/// The file as-is at scale 1. Any other scale is applied about the bounding-box
/// centre and sent as a binary STL in f32, which is what the UI uploads.
fn read_input(input: &Path, scale: f64, step_tolerance_mm: f64) -> Result<Input, String> {
    let bytes = fs::read(input).map_err(|e| e.to_string())?;
    let name = input_name(input).to_string();
    let step = matches!(
        input
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("step" | "stp")
    );
    if step {
        lime_slice_core::resolve_step_tolerance(step_tolerance_mm)?;
    }
    if scale == 1.0 {
        return Ok(Input { name, bytes });
    }
    if !(scale.is_finite() && scale > 0.0) {
        return Err(format!("scale must be above 0 %, got {} %", scale * 100.0));
    }
    let mesh = lime_slice_core::load_slice_mesh_tol(&name, &bytes, false, step_tolerance_mm)?;
    let (min, max) = mesh.bounds().ok_or("empty mesh")?;
    let centre = [0, 1, 2].map(|i| (min[i] + max[i]) * 0.5);
    let mut stl = vec![0u8; 80];
    stl.extend_from_slice(&(mesh.triangles.len() as u32).to_le_bytes());
    for tri in &mesh.triangles {
        stl.extend_from_slice(&[0u8; 12]);
        for v in tri {
            for i in 0..3 {
                let placed = (v[i] - centre[i]) * scale + centre[i];
                stl.extend_from_slice(&(placed as f32).to_le_bytes());
            }
        }
        stl.extend_from_slice(&[0u8; 2]);
    }
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("mesh");
    Ok(Input {
        name: format!("{stem}.stl"),
        bytes: stl,
    })
}

fn request_for(
    input: &Input,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle: f64,
) -> SliceRequest {
    SliceRequest {
        filename: input.name.clone(),
        data_b64: base64::engine::general_purpose::STANDARD.encode(&input.bytes),
        objects: None,
        print_order: None,
        layer_height: settings.layer_height,
        line_width: settings.line_width,
        blend: blend.clone(),
        printer: Some(lime_slice_core::PrinterProfile {
            nozzle_diameter: nozzle,
            ..lime_slice_core::PrinterProfile::default()
        }),
        adaptive: settings.adaptive,
        adaptive_min: settings.adaptive_min,
        adaptive_max: settings.adaptive_max,
        supports: settings.supports,
        support_angle: settings.support_angle,
        variable_width: settings.variable_width,
        arc_fit: settings.arc_fit,
        travel_opt: settings.travel_opt,
        overhang_control: settings.overhang_control,
        classic: settings.classic,
        support_style: match settings.support_style {
            lime_slice_core::SupportStyle::Tree => "tree".into(),
            lime_slice_core::SupportStyle::Grid => "grid".into(),
        },
        branch_angle: settings.branch_angle,
        tip_diameter: settings.tip_diameter,
        trunk_diameter: settings.trunk_diameter,
        support_height_mult: settings.support_height_mult,
        infill_combine: settings.infill_combine,
        combing: settings.combing,
        feature_speeds: settings.feature_speeds,
        seam: settings.seam,
        scarf_seam: settings.scarf_seam,
        scarf_length: settings.scarf_length,
        scarf_steps: settings.scarf_steps,
        scarf_start_height: settings.scarf_start_height,
        scarf_start_flow: settings.scarf_start_flow,
        gyroid_3d: settings.gyroid_3d,
        z_hop: settings.z_hop,
        z_hop_height: settings.z_hop_height,
        z_hop_min_travel: settings.z_hop_min_travel,
        baseline: settings.baseline,
        compare: false,
        include_gcode: true,
        include_preview: true,
        classic_estimator: settings.classic_estimator,
        junction_deviation_mm: settings.junction_deviation_mm,
        simplify: settings.simplify,
        simplify_error_mm: settings.simplify_error_mm,
        pose: None,
        step_tolerance_mm: lime_slice_core::STEP_TOLERANCE_DEFAULT_MM,
        support_edits: Vec::new(),
        include_skeleton: false,
        preview_base: None,
    }
}

fn print_summary(input: &Path, response: &lime_slice_core::SliceResponse) {
    println!(
        "{}  tris {}  outline tolerance {:.3} mm  core {:.2} ms  baseline {:.2} ms ({})",
        input.display(),
        response.mesh.triangles,
        response.mesh.outline_tolerance_mm,
        response.core_ms,
        response.baseline_ms,
        response.baseline_label
    );
    let stages = &response.stages;
    println!(
        "stages  index {:.2} ms  contours {:.2} ms (cut cpu {:.2}, simplify cpu {:.2})  roofs {:.2} ms  supports {:.2} ms  toolpaths {:.2} ms (walls cpu {:.2}, infill cpu {:.2})  order {:.2} ms  combing {:.2} ms  emit {:.2} ms",
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
        "time {:.1} s  filament {:.2} g ({:.1} mm)  travel {:.1} mm  retracts {}  hops {}  arcs {}  toughness {:.1}  per hour {:.1}",
        response.estimate.seconds,
        response.estimate.filament_g,
        response.estimate.filament_mm,
        response.sanity.travel_length_mm,
        response.sanity.retracts,
        response.estimate.z_hops,
        response.estimate.arc_moves,
        response.score.toughness,
        response.score.toughness / (response.estimate.seconds / 3600.0).max(1e-6)
    );
    println!(
        "features  {}",
        response
            .estimate
            .by_feature
            .iter()
            .map(|f| format!("{} {:.0} s {:.2} g", f.kind, f.seconds, f.filament_g))
            .collect::<Vec<_>>()
            .join("  ")
    );
    println!(
        "layers {}  extrusion moves {}  filament E {:.2} mm  path {:.1} mm  bounds X {:.2}..{:.2} Y {:.2}..{:.2}  sanity {}",
        response.sanity.layers,
        response.sanity.extrusion_moves,
        response.sanity.final_e,
        response.sanity.extrusion_length_mm,
        response.sanity.min_x,
        response.sanity.max_x,
        response.sanity.min_y,
        response.sanity.max_y,
        if response.sanity.ok { "ok" } else { "FAILED" }
    );
}

fn blend_mode(
    name: &str,
    axis: &str,
    at: Option<f64>,
    bottom_mm: f64,
    transition_mm: f64,
    toughness: f64,
    input: &Path,
) -> Result<BlendMode, String> {
    let axis = match axis {
        "y" | "Y" => Axis::Y,
        _ => Axis::X,
    };
    Ok(match name {
        "speed" => BlendMode::Single {
            strategy: StrategyId::Speed,
        },
        "toughness" => BlendMode::Single {
            strategy: StrategyId::Toughness,
        },
        "weight" | "efficiency" => BlendMode::Weight { toughness },
        "layer" => BlendMode::ByLayer {
            bottom_mm,
            transition_mm,
        },
        "region" => {
            let at_mm = if let Some(at) = at {
                at
            } else {
                let mesh = load_input(input)?;
                let (min, max) = mesh.bounds().ok_or("empty")?;
                match axis {
                    Axis::X => (min[0] + max[0]) * 0.5,
                    Axis::Y => (min[1] + max[1]) * 0.5,
                }
            };
            BlendMode::ByRegion { axis, at_mm }
        }
        other => return Err(format!("unknown blend '{other}'")),
    })
}

/// The pose that applies `turns` about the part's bounding-box centre and
/// sets the turned part back on the bed, keeping its centre in X and Y.
fn turned_pose(
    source: &Input,
    turns: &[String],
    step_tolerance_mm: f64,
) -> Result<RigidPose, String> {
    let rotation = turns_rotation(turns)?;
    let mesh =
        lime_slice_core::load_slice_mesh_tol(&source.name, &source.bytes, true, step_tolerance_mm)?;
    let (min, max) = mesh.bounds().ok_or("empty mesh")?;
    let pivot = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let (turned_min, _) = mesh
        .rigid_move(&rotation, pivot, pivot)
        .bounds()
        .ok_or("empty mesh")?;
    Ok(RigidPose {
        rotation,
        pivot,
        translation: [pivot[0], pivot[1], pivot[2] - turned_min[2]],
    })
}

/// Row-major rotation for turns like `x90` or `z-45`, applied in order.
fn turns_rotation(turns: &[String]) -> Result<[f64; 9], String> {
    let mut rotation = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    for turn in turns {
        let turn = turn.trim().to_ascii_lowercase();
        let mut chars = turn.chars();
        let axis = chars.next().ok_or("empty --rotate turn")?;
        let degrees: f64 = chars
            .as_str()
            .trim_start_matches([':', '='])
            .parse()
            .map_err(|_| format!("--rotate {turn}: expected an axis and degrees, such as x90"))?;
        let (sin, cos) = degrees.to_radians().sin_cos();
        // Quarter turns come out exact, so a flipped part stays square to the bed.
        let snap = |v: f64| if v.abs() < 1e-12 { 0.0 } else { v };
        let (s, c) = (snap(sin), snap(cos));
        let step = match axis {
            'x' => [1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c],
            'y' => [c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c],
            'z' => [c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0],
            _ => return Err(format!("--rotate {turn}: axis must be x, y, or z")),
        };
        let mut next = [0.0; 9];
        for row in 0..3 {
            for col in 0..3 {
                next[row * 3 + col] = (0..3)
                    .map(|k| step[row * 3 + k] * rotation[k * 3 + col])
                    .sum();
            }
        }
        rotation = next;
    }
    Ok(rotation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_apply_in_order_about_the_bed_axes() {
        let r = turns_rotation(&["x90".into(), "z90".into()]).unwrap();
        let apply = |v: [f64; 3]| {
            [
                r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
                r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
                r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
            ]
        };
        assert_eq!(apply([1.0, 0.0, 0.0]), [0.0, 1.0, 0.0]);
        assert_eq!(apply([0.0, 1.0, 0.0]), [0.0, 0.0, 1.0]);
        assert_eq!(apply([0.0, 0.0, 1.0]), [1.0, 0.0, 0.0]);
        assert!(turns_rotation(&["w90".into()]).is_err());
        assert!(turns_rotation(&["x".into()]).is_err());
    }

    #[test]
    fn scale_grows_the_part_about_its_centre_on_the_bed_and_ships_an_stl() {
        let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples");
        let cube = samples.join("calibration_cube_20mm.3mf");
        let as_is = read_input(&cube, 1.0, 0.1).unwrap();
        assert_eq!(as_is.name, "calibration_cube_20mm.3mf");
        let doubled = read_input(&cube, 2.0, 0.1).unwrap();
        assert_eq!(doubled.name, "calibration_cube_20mm.stl");
        let bounds = |input: &Input| {
            lime_slice_core::load_mesh(&input.name, &input.bytes)
                .unwrap()
                .bounds()
                .unwrap()
        };
        let (min0, max0) = bounds(&as_is);
        let (min1, max1) = bounds(&doubled);
        for i in 0..3 {
            let size = max1[i] - min1[i];
            assert!((size - 40.0).abs() < 1e-3, "axis {i} is {size} mm");
        }
        for i in 0..2 {
            let (c0, c1) = ((min0[i] + max0[i]) * 0.5, (min1[i] + max1[i]) * 0.5);
            assert!((c1 - c0).abs() < 1e-3, "axis {i} centre moved {c0} -> {c1}");
        }
        assert!(
            min1[2].abs() < 1e-6,
            "the scaled part floats at z {}",
            min1[2]
        );
        assert!(read_input(&cube, 0.0, 0.1).is_err());
    }

    #[test]
    fn region_blend_slices_every_sample() {
        let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples");
        let mut inputs: Vec<PathBuf> = fs::read_dir(&samples)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            // The Dragon audit is opt-in, as in tools/golden.sh.
            .filter(|path| path.file_name().unwrap() != "dragon_2_5.stl")
            .filter(|path| {
                matches!(
                    path.extension().and_then(|e| e.to_str()),
                    Some("stl" | "3mf")
                )
            })
            .collect();
        inputs.sort();
        assert!(inputs.iter().any(|p| p.extension().unwrap() == "3mf"));
        let settings = SliceSettings::default();
        for input in &inputs {
            let blend = blend_mode("region", "x", None, 2.0, 2.0, 0.5, input)
                .unwrap_or_else(|e| panic!("{}: {e}", input.display()));
            let request = request_for(
                &read_input(input, 1.0, 0.1).unwrap(),
                &blend,
                &settings,
                0.4,
            );
            let response = slice_request(&request, lime_slice_core::Job::default())
                .unwrap_or_else(|e| panic!("{}: {e}", input.display()));
            assert!(response.sanity.ok, "{}", input.display());
        }
    }

    #[test]
    fn slice_skips_the_baseline_pass_unless_asked() {
        use clap::Parser;
        let baseline = |extra: &[&str]| {
            let args = ["lime-slice", "slice", "part.stl", "-o", "out.gcode"]
                .into_iter()
                .chain(extra.iter().copied());
            let Cmd::Slice { baseline, .. } = Cli::try_parse_from(args).unwrap().cmd else {
                panic!("slice");
            };
            baseline
        };
        assert!(!baseline(&[]));
        assert!(baseline(&["--baseline", "true"]));
        assert!(!baseline(&["--baseline", "false"]));
    }

    #[test]
    fn serve_cli_stays_on_loopback_without_a_token() {
        use clap::Parser;
        let cli = Cli::try_parse_from(["lime-slice", "serve"]).unwrap();
        let Cmd::Serve {
            host,
            port,
            token,
            cache_dir,
        } = cli.cmd
        else {
            panic!("serve");
        };
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 43118);
        assert!(token.is_none());
        assert!(cache_dir.is_none());
        assert_eq!(listen_addr(&host, port), "127.0.0.1:43118");
        assert!(!open_bind_without_auth(&host, None));
    }

    #[test]
    fn serve_cli_accepts_host_and_token() {
        use clap::Parser;
        let cli = Cli::try_parse_from([
            "lime-slice",
            "serve",
            "--host",
            "0.0.0.0",
            "--port",
            "9",
            "--token",
            "s3cret",
        ])
        .unwrap();
        let Cmd::Serve {
            host, port, token, ..
        } = cli.cmd
        else {
            panic!("serve");
        };
        assert_eq!(host, "0.0.0.0");
        assert_eq!(port, 9);
        assert_eq!(token.as_deref(), Some("s3cret"));
        assert_eq!(listen_addr(&host, port), "0.0.0.0:9");
        assert!(open_bind_without_auth("0.0.0.0", None));
        assert!(open_bind_without_auth("192.168.1.20", Some("")));
        assert!(!open_bind_without_auth("0.0.0.0", Some("s3cret")));
        assert!(!open_bind_without_auth("localhost", None));
        assert!(!open_bind_without_auth("::1", None));
        assert_eq!(listen_addr("::1", 43118), "[::1]:43118");
        assert_eq!(
            resolve_serve_token(Some("flag".into()), Some("env".into())).as_deref(),
            Some("flag")
        );
        assert_eq!(
            resolve_serve_token(None, Some("env".into())).as_deref(),
            Some("env")
        );
        assert_eq!(
            resolve_serve_token(Some(String::new()), Some("env".into())).as_deref(),
            Some("env")
        );
        assert!(resolve_serve_token(None, None).is_none());
    }

    #[test]
    fn token_accepts_bearer_or_query_and_rejects_the_rest() {
        assert!(request_authorized(None, None, ""));
        assert!(request_authorized(Some(""), None, ""));
        assert!(request_authorized(
            Some("s3cret"),
            Some("Bearer s3cret"),
            ""
        ));
        assert!(request_authorized(
            Some("s3cret"),
            Some("bearer s3cret"),
            ""
        ));
        assert!(request_authorized(Some("s3cret"), Some("s3cret"), ""));
        assert!(request_authorized(Some("s3cret"), None, "token=s3cret"));
        assert!(request_authorized(
            Some("a b"),
            None,
            "toughness=1&token=a%20b"
        ));
        assert!(!request_authorized(Some("s3cret"), Some("Bearer nope"), ""));
        assert!(!request_authorized(Some("s3cret"), None, "token=nope"));
        assert!(!request_authorized(Some("s3cret"), None, ""));
        assert_eq!(cors_origin(false, Some("http://evil.test")), "*");
        assert_eq!(
            cors_origin(true, Some("http://phone.local:43117")),
            "http://phone.local:43117"
        );
        assert_eq!(cors_origin(true, Some("not a origin")), "*");
        assert_eq!(cors_origin(true, None), "*");
    }

    #[test]
    fn host_binds_loopback_by_default_and_token_gates_health() {
        let open = tiny_http::Server::http(listen_addr("127.0.0.1", 0)).unwrap();
        let bound = open.server_addr().to_ip().expect("expected a tcp listener");
        assert!(bound.ip().is_loopback());
        assert_ne!(bound.port(), 0);
        drop(open);

        let wide = tiny_http::Server::http(listen_addr("0.0.0.0", 0)).unwrap();
        let wide_addr = wide.server_addr().to_ip().expect("expected a tcp listener");
        assert!(wide_addr.ip().is_unspecified());
        drop(wide);

        let server = tiny_http::Server::http(listen_addr("127.0.0.1", 0)).unwrap();
        let addr = server
            .server_addr()
            .to_ip()
            .expect("expected a tcp listener");
        let endpoint = addr.to_string();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                handle(request, Some("s3cret"));
            }
        });

        let health = http_exchange(&endpoint, "GET /api/health HTTP/1.0\r\n\r\n");
        assert!(
            health.starts_with("HTTP/1.0 401") || health.starts_with("HTTP/1.1 401"),
            "{health}"
        );
        assert!(health.contains("Access-Control-Allow-Origin: *"));
        assert!(health.contains("Access-Control-Allow-Headers: Content-Type, Authorization"));

        let ok = http_exchange(
            &endpoint,
            "GET /api/health HTTP/1.0\r\nAuthorization: Bearer s3cret\r\nOrigin: http://10.0.0.8:43117\r\n\r\n",
        );
        assert!(
            ok.starts_with("HTTP/1.0 200") || ok.starts_with("HTTP/1.1 200"),
            "{ok}"
        );
        assert!(ok.contains("Access-Control-Allow-Origin: http://10.0.0.8:43117"));
        assert!(ok.contains("Vary: Origin"));

        let query = http_exchange(&endpoint, "GET /api/health?token=s3cret HTTP/1.0\r\n\r\n");
        assert!(
            query.starts_with("HTTP/1.0 200") || query.starts_with("HTTP/1.1 200"),
            "{query}"
        );

        let preflight = http_exchange(
            &endpoint,
            "OPTIONS /api/slice HTTP/1.0\r\nOrigin: http://10.0.0.8:43117\r\n\r\n",
        );
        assert!(
            preflight.starts_with("HTTP/1.0 204") || preflight.starts_with("HTTP/1.1 204"),
            "{preflight}"
        );
    }

    fn http_exchange(addr: &str, head: &str) -> String {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;
        let mut stream = {
            let mut last = None;
            let mut connected = None;
            for _ in 0..50 {
                match TcpStream::connect(addr) {
                    Ok(stream) => {
                        connected = Some(stream);
                        break;
                    }
                    Err(err) => {
                        last = Some(err);
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
            }
            connected.unwrap_or_else(|| panic!("connect {addr}: {last:?}"))
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("timeout");
        stream.write_all(head.as_bytes()).expect("write");
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        loop {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut =>
                {
                    break;
                }
                Err(err) => panic!("{err}"),
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn http_exchange_for(addr: &str, head: &str, timeout: std::time::Duration) -> String {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let mut stream = TcpStream::connect(addr).expect("connect");
        stream.set_read_timeout(Some(timeout)).expect("timeout");
        stream.write_all(head.as_bytes()).expect("write");
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        loop {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut =>
                {
                    break;
                }
                Err(err) => panic!("{err}"),
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn response_body(raw: &str) -> &str {
        raw.split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or("")
    }

    /// SSE responses have no Content-Length, so tiny_http frames them as
    /// chunked transfer. A browser strips that framing; this test reads the
    /// socket itself.
    fn event_payload(raw: &str) -> String {
        let Some((head, body)) = raw.split_once("\r\n\r\n") else {
            return String::new();
        };
        let chunked = head.lines().any(|line| {
            let lower = line.to_ascii_lowercase();
            lower.starts_with("transfer-encoding:") && lower.contains("chunked")
        });
        if chunked {
            decode_chunked(body.as_bytes())
        } else {
            body.to_string()
        }
    }

    fn decode_chunked(mut body: &[u8]) -> String {
        let mut out = Vec::new();
        while !body.is_empty() {
            let Some(split) = body.windows(2).position(|pair| pair == b"\r\n") else {
                break;
            };
            let size_line = std::str::from_utf8(&body[..split]).unwrap_or("");
            let size_hex = size_line.split(';').next().unwrap_or("").trim();
            let Ok(size) = usize::from_str_radix(size_hex, 16) else {
                break;
            };
            body = &body[split + 2..];
            if size == 0 || body.len() < size {
                break;
            }
            out.extend_from_slice(&body[..size]);
            body = &body[size..];
            if body.starts_with(b"\r\n") {
                body = &body[2..];
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn jobs_follow_a_slice_and_cancel_under_the_token() {
        use base64::Engine;
        let server = tiny_http::Server::http(listen_addr("127.0.0.1", 0)).unwrap();
        let endpoint = server
            .server_addr()
            .to_ip()
            .expect("tcp listener")
            .to_string();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                handle(request, Some("s3cret"));
            }
        });

        let stl = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples/calibration_cube_20mm.stl"),
        )
        .unwrap();
        let payload = serde_json::json!({
            "filename": "calibration_cube_20mm.stl",
            "dataB64": base64::engine::general_purpose::STANDARD.encode(stl),
            "baseline": false,
            "compare": false,
            "includePreview": false,
            "includeGcode": true,
        })
        .to_string();
        let post = |path: &str, token: bool| {
            let auth = if token {
                "Authorization: Bearer s3cret\r\nOrigin: http://10.0.0.8:43117\r\n"
            } else {
                ""
            };
            format!(
                "POST {path} HTTP/1.1\r\nHost: localhost\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            )
        };

        let denied = http_exchange(&endpoint, &post("/api/jobs", false));
        assert!(
            denied.starts_with("HTTP/1.0 401") || denied.starts_with("HTTP/1.1 401"),
            "{denied}"
        );

        let started = http_exchange(&endpoint, &post("/api/jobs", true));
        assert!(
            started.starts_with("HTTP/1.0 202") || started.starts_with("HTTP/1.1 202"),
            "{started}"
        );
        assert!(started.contains("Access-Control-Allow-Origin: http://10.0.0.8:43117"));
        assert!(started.contains("Vary: Origin"));
        let id: String = serde_json::from_str::<serde_json::Value>(response_body(&started))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let cancel = http_exchange(
            &endpoint,
            &format!(
                "POST /api/jobs/{id}/cancel?token=s3cret HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(
            cancel.starts_with("HTTP/1.0 200") || cancel.starts_with("HTTP/1.1 200"),
            "{cancel}"
        );

        let mut saw_cancelled = false;
        for _ in 0..50 {
            let poll = http_exchange(
                &endpoint,
                &format!(
                    "GET /api/jobs/{id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer s3cret\r\nConnection: close\r\n\r\n"
                ),
            );
            assert!(
                poll.starts_with("HTTP/1.0 200") || poll.starts_with("HTTP/1.1 200"),
                "{poll}"
            );
            let body: serde_json::Value = serde_json::from_str(response_body(&poll)).unwrap();
            let status = body["status"].as_str().unwrap();
            assert!(body["fraction"].as_f64().unwrap() <= 1.0);
            if status == "cancelled" {
                saw_cancelled = true;
                break;
            }
            assert_ne!(status, "done", "cancel lost the race: {body}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(saw_cancelled, "job {id} did not cancel");

        let result = http_exchange(
            &endpoint,
            &format!(
                "GET /api/jobs/{id}/result HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer s3cret\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(
            result.starts_with("HTTP/1.0 400") || result.starts_with("HTTP/1.1 400"),
            "{result}"
        );
        assert!(response_body(&result).contains("cancelled"));

        let missing = http_exchange(
            &endpoint,
            "GET /api/jobs/missing HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer s3cret\r\nConnection: close\r\n\r\n",
        );
        assert!(
            missing.starts_with("HTTP/1.0 404") || missing.starts_with("HTTP/1.1 404"),
            "{missing}"
        );

        let started = http_exchange(&endpoint, &post("/api/jobs", true));
        let id: String = serde_json::from_str::<serde_json::Value>(response_body(&started))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let events = http_exchange_for(
            &endpoint,
            &format!(
                "GET /api/jobs/{id}/events?token=s3cret HTTP/1.1\r\nHost: localhost\r\nOrigin: http://10.0.0.8:43117\r\nConnection: close\r\n\r\n"
            ),
            std::time::Duration::from_secs(60),
        );
        assert!(
            events.contains("text/event-stream"),
            "missing event stream header: {events}"
        );
        assert!(
            events.contains("Access-Control-Allow-Origin: http://10.0.0.8:43117"),
            "{events}"
        );
        let payload = event_payload(&events);
        assert!(payload.contains("data: "), "{events}");
        assert!(payload.contains("\"status\":\"done\""), "{payload}");
        let mut previous = 0.0;
        for line in payload.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let event: serde_json::Value = serde_json::from_str(data).unwrap();
            let fraction = event["fraction"].as_f64().unwrap();
            assert!(fraction + 1e-9 >= previous, "{payload}");
            previous = fraction;
        }
        assert!((previous - 1.0).abs() < 1e-9, "{payload}");

        let result = http_exchange_for(
            &endpoint,
            &format!(
                "GET /api/jobs/{id}/result HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer s3cret\r\nConnection: close\r\n\r\n"
            ),
            std::time::Duration::from_secs(5),
        );
        assert!(
            result.starts_with("HTTP/1.0 200") || result.starts_with("HTTP/1.1 200"),
            "{result}"
        );
        assert!(response_body(&result).contains("generated by Lime Slice"));

        let get = |path: &str| {
            http_exchange_for(
                &endpoint,
                &format!(
                    "GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer s3cret\r\nConnection: close\r\n\r\n"
                ),
                std::time::Duration::from_secs(5),
            )
        };
        let gone = |reply: &str, error: &str| {
            assert!(
                reply.starts_with("HTTP/1.0 410") || reply.starts_with("HTTP/1.1 410"),
                "{reply}"
            );
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(response_body(reply)).unwrap(),
                serde_json::json!({ "error": error })
            );
        };
        gone(
            &get(&format!("/api/jobs/{id}/result")),
            "result already read",
        );
        assert_eq!(jobs::held_bodies(), 0, "a read result is still held");

        let finished_job = || {
            let started = http_exchange(&endpoint, &post("/api/jobs", true));
            let id = serde_json::from_str::<serde_json::Value>(response_body(&started)).unwrap()
                ["id"]
                .as_str()
                .unwrap()
                .to_string();
            for _ in 0..600 {
                let poll: serde_json::Value =
                    serde_json::from_str(response_body(&get(&format!("/api/jobs/{id}")))).unwrap();
                if poll["status"] != "running" {
                    assert_eq!(poll["status"], "done", "{poll}");
                    return id;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            panic!("job {id} did not finish");
        };
        let older = finished_job();
        let newer = finished_job();
        assert_eq!(jobs::held_bodies(), 1, "only the newest body is held");
        gone(
            &get(&format!("/api/jobs/{older}/result")),
            "result released",
        );
        let newest = get(&format!("/api/jobs/{newer}/result"));
        assert!(
            newest.starts_with("HTTP/1.0 200") || newest.starts_with("HTTP/1.1 200"),
            "{newest}"
        );
        assert!(response_body(&newest).contains("generated by Lime Slice"));
        assert_eq!(jobs::held_bodies(), 0);
        let older_poll: serde_json::Value =
            serde_json::from_str(response_body(&get(&format!("/api/jobs/{older}")))).unwrap();
        assert_eq!(older_poll["status"], "done", "status outlives the body");
        assert_eq!(older_poll["fraction"], 1.0);

        let preflight = http_exchange(
            &endpoint,
            "OPTIONS /api/jobs HTTP/1.1\r\nHost: localhost\r\nOrigin: http://10.0.0.8:43117\r\nConnection: close\r\n\r\n",
        );
        assert!(
            preflight.starts_with("HTTP/1.0 204") || preflight.starts_with("HTTP/1.1 204"),
            "{preflight}"
        );
        assert!(preflight.contains("Access-Control-Allow-Headers: Content-Type, Authorization"));
    }
}
