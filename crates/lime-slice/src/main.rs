use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use clap::{Parser, Subcommand};
use lime_slice_core::{
    mesh_preview, pareto_estimates, slice_request, Axis, BlendMode, Gyroid3d, Mesh, ScarfSeam,
    SliceRequest, SliceSettings, StrategyId, ZHopMode,
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
        /// Also check contour coverage and support placement, and print the report.
        #[arg(long, default_value_t = false)]
        audit: bool,
        /// Also plan a single-strategy speed slice and report its time.
        #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
        baseline: bool,
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Time single-strategy and blended slices.
    Bench { input: PathBuf },
    /// HTTP API used by the browser UI.
    Serve {
        #[arg(long, default_value_t = 43118)]
        port: u16,
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
            audit,
            baseline,
            output,
        } => {
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
            let source = read_input(&input, scale / 100.0)?;
            let request = request_for(&source, &blend, &settings, nozzle);
            let response = slice_request(&request, lime_slice_core::Job::default())
                .map_err(|e| e.to_string())?;
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&output, &response.gcode).map_err(|e| e.to_string())?;
            print_summary(&input, &response);
            println!("wrote {}", output.display());
            if audit {
                let mesh = lime_slice_core::load_mesh(&source.name, &source.bytes)?;
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
        Cmd::Serve { port, cache_dir } => serve(port, cache_dir),
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

fn gcode_store() -> &'static Mutex<HashMap<String, String>> {
    static STORE: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &STORE
}

fn park_gcode(text: String) -> String {
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

fn serve(port: u16, cache_dir: Option<PathBuf>) -> Result<(), String> {
    if let Some(dir) = cache_dir {
        let _ = SLICE_CACHE.set(lime_slice_core::SliceCache::new(dir, 2 << 30));
    }
    let addr = format!("127.0.0.1:{port}");
    let server = tiny_http::Server::http(&addr).map_err(|e| e.to_string())?;
    eprintln!("lime-slice api http://{addr}");
    // One thread per request, so a new slice or /api/cancel reaches the server
    // while an older slice is still planning. Starting a slice supersedes it.
    for request in server.incoming_requests() {
        std::thread::spawn(move || handle(request));
    }
    Ok(())
}

fn handle(mut request: tiny_http::Request) {
    {
        let method = request.method().as_str().to_string();
        let url = request.url().to_string();
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            let _ = request.respond(text_response(400, "bad body"));
            return;
        }
        let (status, payload) = if method == "OPTIONS" {
            (204, String::new())
        } else if method == "GET" && url.starts_with("/api/strategies") {
            let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
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
        } else if method == "POST" && url.starts_with("/api/cancel") {
            lime_slice_core::cancel_all();
            (200, r#"{"ok":true}"#.into())
        } else if method == "GET" && url.starts_with("/api/health") {
            (200, r#"{"ok":true}"#.into())
        } else if method == "POST" && url.starts_with("/api/calibrate/pa") {
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
        } else if method == "GET" && url.starts_with("/api/gcode/") {
            let token = url.trim_start_matches("/api/gcode/").trim();
            let text = gcode_store()
                .lock()
                .expect("gcode store")
                .get(token)
                .cloned();
            match text {
                Some(text) => (200, text),
                None => (404, err_json("g-code expired")),
            }
        } else if method == "POST" && url.starts_with("/api/mesh") {
            match serde_json::from_str::<SliceRequest>(&body) {
                Ok(req) => match decode_mesh(&req) {
                    Ok(bytes) => match mesh_preview(&req.filename, &bytes) {
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
        } else if method == "POST" && url.starts_with("/api/pareto") {
            match serde_json::from_str::<SliceRequest>(&body) {
                Ok(req) => match decode_mesh(&req) {
                    Ok(bytes) => match lime_slice_core::load_slice_mesh(
                        &req.filename,
                        &bytes,
                        req.pose.is_some(),
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
        } else if method == "POST" && url.starts_with("/api/slice") {
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
        let _ = request.respond(text_response(status, &payload));
    }
}

fn text_response(status: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let mut response = tiny_http::Response::from_string(body.to_string()).with_status_code(status);
    let headers = [
        ("Content-Type", "application/json"),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
    ];
    for (k, v) in headers {
        response.add_header(tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap());
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
fn read_input(input: &Path, scale: f64) -> Result<Input, String> {
    let bytes = fs::read(input).map_err(|e| e.to_string())?;
    let name = input_name(input).to_string();
    if scale == 1.0 {
        return Ok(Input { name, bytes });
    }
    if !(scale.is_finite() && scale > 0.0) {
        return Err(format!("scale must be above 0 %, got {} %", scale * 100.0));
    }
    let mesh = lime_slice_core::load_mesh(&name, &bytes)?;
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
    println!(
        "stages  contours {:.2} ms  supports {:.2} ms  toolpaths {:.2} ms  order {:.2} ms  combing {:.2} ms  emit {:.2} ms",
        response.stages.contour_ms,
        response.stages.support_ms,
        response.stages.toolpath_ms,
        response.stages.order_ms,
        response.stages.comb_ms,
        response.stages.emit_ms
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_grows_the_part_about_its_centre_on_the_bed_and_ships_an_stl() {
        let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../samples");
        let cube = samples.join("calibration_cube_20mm.3mf");
        let as_is = read_input(&cube, 1.0).unwrap();
        assert_eq!(as_is.name, "calibration_cube_20mm.3mf");
        let doubled = read_input(&cube, 2.0).unwrap();
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
        assert!(read_input(&cube, 0.0).is_err());
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
            let request = request_for(&read_input(input, 1.0).unwrap(), &blend, &settings, 0.4);
            let response = slice_request(&request, lime_slice_core::Job::default())
                .unwrap_or_else(|e| panic!("{}: {e}", input.display()));
            assert!(response.sanity.ok, "{}", input.display());
        }
    }
}
