use std::io::Write;

use base64::Engine;

use crate::{height_to_u16, HeightFrame, FORMAT};

pub fn write_csv(frame: &HeightFrame, mut w: impl Write) -> Result<(), String> {
    let origin = format!(
        "{},{}",
        fmt_mm(frame.origin_mm[0]),
        fmt_mm(frame.origin_mm[1])
    );
    let extent = format!(
        "{},{},{},{}",
        fmt_mm(frame.extent_mm[0]),
        fmt_mm(frame.extent_mm[1]),
        fmt_mm(frame.extent_mm[2]),
        fmt_mm(frame.extent_mm[3])
    );
    writeln!(w, "# lime-haptic height frame (experimental)").map_err(|e| e.to_string())?;
    writeln!(w, "# format: {FORMAT}").map_err(|e| e.to_string())?;
    writeln!(w, "# pitch_mm: {}", fmt_mm(frame.pitch_mm)).map_err(|e| e.to_string())?;
    writeln!(w, "# travel_mm: {}", fmt_mm(frame.travel_mm)).map_err(|e| e.to_string())?;
    writeln!(w, "# origin_mm: {origin}").map_err(|e| e.to_string())?;
    writeln!(w, "# extent_mm: {extent}").map_err(|e| e.to_string())?;
    writeln!(w, "# base: {}", frame.base.as_str()).map_err(|e| e.to_string())?;
    writeln!(w, "# base_z_mm: {}", fmt_mm(frame.base_z_mm)).map_err(|e| e.to_string())?;
    writeln!(w, "# cols: {}", frame.cols).map_err(|e| e.to_string())?;
    writeln!(w, "# rows: {}", frame.rows).map_err(|e| e.to_string())?;
    writeln!(w, "# units: mm").map_err(|e| e.to_string())?;
    writeln!(w, "# row_0: min_y").map_err(|e| e.to_string())?;
    writeln!(w, "# no_hit_count: {}", frame.no_hit_count()).map_err(|e| e.to_string())?;
    writeln!(w, "# no_hit_mask: {}", mask_b64(frame)).map_err(|e| e.to_string())?;
    for row in 0..frame.rows {
        for col in 0..frame.cols {
            if col > 0 {
                write!(w, ",").map_err(|e| e.to_string())?;
            }
            write!(w, "{}", fmt_mm(frame.height(col, row))).map_err(|e| e.to_string())?;
        }
        writeln!(w).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn write_png(frame: &HeightFrame, w: impl Write) -> Result<(), String> {
    let cols = u32::try_from(frame.cols).map_err(|_| "too many columns for a PNG".to_string())?;
    let rows = u32::try_from(frame.rows).map_err(|_| "too many rows for a PNG".to_string())?;
    let mut samples = Vec::with_capacity(frame.cols * frame.rows * 2);
    // PNG row 0 is the top of the picture. Grid row 0 is minimum Y, so the
    // file is written last grid row first: +X right, +Y up.
    for row in (0..frame.rows).rev() {
        for col in 0..frame.cols {
            let sample = height_to_u16(frame.height(col, row), frame.travel_mm);
            samples.extend_from_slice(&sample.to_be_bytes());
        }
    }
    let mut encoder = png::Encoder::new(w, cols, rows);
    encoder.set_color(png::ColorType::Grayscale);
    encoder.set_depth(png::BitDepth::Sixteen);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer
        .write_image_data(&samples)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn sidecar_json(frame: &HeightFrame) -> String {
    let value = serde_json::json!({
        "format": FORMAT,
        "experimental": true,
        "pitchMm": frame.pitch_mm,
        "travelMm": frame.travel_mm,
        "originMm": frame.origin_mm,
        "extentMm": frame.extent_mm,
        "base": frame.base.as_str(),
        "baseZMm": frame.base_z_mm,
        "cols": frame.cols,
        "rows": frame.rows,
        "units": "mm",
        "row0": "minY",
        "pngRow0": "maxY",
        "noHitCount": frame.no_hit_count(),
        "noHitMask": mask_b64(frame),
    });
    let mut text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    text
}

pub(crate) fn mask_b64(frame: &HeightFrame) -> String {
    let mut bytes = vec![0u8; frame.no_hit.len().div_ceil(8)];
    for (i, missed) in frame.no_hit.iter().enumerate() {
        if *missed {
            bytes[i / 8] |= 1 << (7 - (i % 8));
        }
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Three decimal places, with `-0.000` written as `0.000`.
fn fmt_mm(value: f64) -> String {
    let mut scaled = (value * 1000.0).round() / 1000.0;
    if !scaled.is_finite() || scaled.abs() < 5.0e-4 {
        scaled = 0.0;
    }
    format!("{scaled:.3}")
}
