use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use base64::Engine;
use clap::{Parser, Subcommand};
use lime_slice_core::{slice_request, Axis, BlendMode, SliceRequest, SliceSettings, StrategyId};

#[derive(Parser)]
#[command(name = "lime-slice", about = "Lime Slice FDM slicer")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

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
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Time single-strategy and blended slices.
    Bench { input: PathBuf },
    /// HTTP API used by the browser UI.
    Serve {
        #[arg(long, default_value_t = 43118)]
        port: u16,
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
            bottom_mm,
            transition_mm,
            toughness,
            adaptive,
            adaptive_min,
            adaptive_max,
            supports,
            support_angle,
            output,
        } => {
            let response = slice_file(
                &input,
                &blend_mode(
                    &blend,
                    &axis,
                    at,
                    bottom_mm,
                    transition_mm,
                    toughness,
                    &input,
                )?,
                &SliceSettings {
                    layer_height,
                    line_width: 0.45,
                    adaptive,
                    adaptive_min,
                    adaptive_max: if adaptive_max > 0.0 {
                        adaptive_max
                    } else {
                        layer_height
                    },
                    supports,
                    support_angle,
                },
            )?;
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&output, &response.gcode).map_err(|e| e.to_string())?;
            print_summary(&input, &response);
            println!("wrote {}", output.display());
            if !response.sanity.ok {
                return Err(response.sanity.notes.join("; "));
            }
            Ok(())
        }
        Cmd::Bench { input } => bench(&input),
        Cmd::Serve { port } => serve(port),
    }
}

fn bench(input: &PathBuf) -> Result<(), String> {
    let bytes = fs::read(input).map_err(|e| e.to_string())?;
    let mesh = lime_slice_core::load_mesh(
        &input
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("mesh.stl"),
        &bytes,
    )?;
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
    println!("baseline is the single-strategy speed path");
    println!(
        "{:<14} {:>10} {:>10} {:>8} {:>10} {:>8}",
        "mode", "core ms", "base ms", "layers", "E mm", "ok"
    );
    for (name, mode) in modes {
        let started = Instant::now();
        let response =
            lime_slice_core::slice_with_baseline(&mesh, &mode, &Default::default(), 0.2, 0.45)?;
        let wall = started.elapsed().as_secs_f64() * 1000.0;
        println!(
            "{:<14} {:>10.2} {:>10.2} {:>8} {:>10.1} {:>8}   (process {:.1} ms)",
            name,
            response.core_ms,
            response.baseline_ms,
            response.sanity.layers,
            response.sanity.final_e,
            if response.sanity.ok { "yes" } else { "NO" },
            wall
        );
        if !response.sanity.ok {
            println!("  {}", response.sanity.notes.join("; "));
        }
    }
    Ok(())
}

fn serve(port: u16) -> Result<(), String> {
    let addr = format!("127.0.0.1:{port}");
    let server = tiny_http::Server::http(&addr).map_err(|e| e.to_string())?;
    eprintln!("lime-slice api http://{addr}");
    for mut request in server.incoming_requests() {
        let method = request.method().as_str().to_string();
        let url = request.url().to_string();
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            let _ = request.respond(text_response(400, "bad body"));
            continue;
        }
        let (status, payload) = if method == "OPTIONS" {
            (204, String::new())
        } else if method == "GET" && url.starts_with("/api/health") {
            (200, r#"{"ok":true}"#.into())
        } else if method == "POST" && url.starts_with("/api/slice") {
            match serde_json::from_str::<SliceRequest>(&body) {
                Ok(req) => match slice_request(&req) {
                    Ok(res) => (
                        200,
                        serde_json::to_string(&res).unwrap_or_else(|e| err_json(&e.to_string())),
                    ),
                    Err(err) => (400, err_json(&err)),
                },
                Err(err) => (400, err_json(&err.to_string())),
            }
        } else {
            (404, err_json("not found"))
        };
        let _ = request.respond(text_response(status, &payload));
    }
    Ok(())
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

fn err_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

fn slice_file(
    input: &PathBuf,
    blend: &BlendMode,
    settings: &SliceSettings,
) -> Result<lime_slice_core::SliceResponse, String> {
    let bytes = fs::read(input).map_err(|e| e.to_string())?;
    let name = input
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("mesh.stl");
    slice_request(&SliceRequest {
        filename: name.into(),
        data_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
        layer_height: settings.layer_height,
        line_width: settings.line_width,
        blend: blend.clone(),
        printer: None,
        adaptive: settings.adaptive,
        adaptive_min: settings.adaptive_min,
        adaptive_max: settings.adaptive_max,
        supports: settings.supports,
        support_angle: settings.support_angle,
    })
}

fn print_summary(input: &PathBuf, response: &lime_slice_core::SliceResponse) {
    println!(
        "{}  tris {}  core {:.2} ms  baseline {:.2} ms ({})",
        input.display(),
        response.mesh.triangles,
        response.core_ms,
        response.baseline_ms,
        response.baseline_label
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
    input: &PathBuf,
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
        "weight" => BlendMode::Weight { toughness },
        "layer" => BlendMode::ByLayer {
            bottom_mm,
            transition_mm,
        },
        "region" => {
            let at_mm = if let Some(at) = at {
                at
            } else {
                let bytes = fs::read(input).map_err(|e| e.to_string())?;
                let mesh = lime_slice_core::load_mesh("mesh.stl", &bytes)?;
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
