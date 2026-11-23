//! Experimental height frames for a tactile pin array.
//!
//! Lime Slice compiles the table. The rig firmware keeps the real-time loop.
//! This crate does not slice, and it does not write MPEG-Haptics or a
//! stiffness channel. See `docs/haptic.md`.

mod emit;
mod index;

use rayon::prelude::*;

pub use emit::{sidecar_json, write_csv, write_png};

/// File-format name written into the CSV header and the PNG sidecar.
pub const FORMAT: &str = "lime-haptic-height-1";

/// One axis stops here. A pitch of 0.001 mm across a metre is a mistake, not a frame.
const MAX_AXIS: usize = 100_000;
/// `cols * rows` stops here, about 16 MB of `f64` heights plus the mask.
const MAX_PINS: usize = 2_000_000;
/// A remainder thinner than this does not add another row of pins.
const SPAN_SNAP_MM: f64 = 1.0e-4;

/// Rectangle the pins cover, in millimetres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Extent {
    /// The mesh XY bounding box.
    Auto,
    /// `x0, y0, x1, y1` with `x0 < x1` and `y0 < y1`.
    Rect { x0: f64, y0: f64, x1: f64, y1: f64 },
}

impl Extent {
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        if text.eq_ignore_ascii_case("auto") {
            return Ok(Self::Auto);
        }
        let parts: Vec<&str> = text.split(',').map(str::trim).collect();
        if parts.len() != 4 {
            return Err("extent is \"auto\" or x0,y0,x1,y1 in millimetres".into());
        }
        let mut n = [0.0; 4];
        for (i, part) in parts.iter().enumerate() {
            n[i] = part
                .parse::<f64>()
                .map_err(|_| format!("extent value \"{part}\" is not a number"))?;
            if !n[i].is_finite() {
                return Err("extent values must be finite".into());
            }
        }
        if n[2] <= n[0] || n[3] <= n[1] {
            return Err("extent must have x0 < x1 and y0 < y1".into());
        }
        Ok(Self::Rect {
            x0: n[0],
            y0: n[1],
            x1: n[2],
            y1: n[3],
        })
    }
}

/// Z plane the pin height is measured from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Base {
    /// Mesh minimum Z. The height is how far the top surface sits above the bottom of the part.
    Min,
    /// One stroke below the mesh maximum Z, so the highest point maps to full travel.
    Top,
}

impl Base {
    pub fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "min" => Ok(Self::Min),
            "top" => Ok(Self::Top),
            _ => Err("base is \"min\" or \"top\"".into()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Min => "min",
            Self::Top => "top",
        }
    }
}

/// One compiled frame. Row 0 is minimum Y. Column 0 is minimum X.
#[derive(Debug)]
pub struct HeightFrame {
    pub pitch_mm: f64,
    pub travel_mm: f64,
    pub origin_mm: [f64; 2],
    /// `x0, y0, x1, y1` of the rectangle the grid was built over.
    pub extent_mm: [f64; 4],
    pub base: Base,
    pub base_z_mm: f64,
    pub cols: usize,
    pub rows: usize,
    /// Millimetres, clipped to `[0, travel]`. Misses are `0`.
    pub heights_mm: Vec<f64>,
    /// `true` where the vertical ray missed the mesh.
    pub no_hit: Vec<bool>,
}

impl HeightFrame {
    pub fn no_hit_count(&self) -> usize {
        self.no_hit.iter().filter(|miss| **miss).count()
    }

    pub fn centre(&self, col: usize, row: usize) -> [f64; 2] {
        [
            self.origin_mm[0] + (col as f64 + 0.5) * self.pitch_mm,
            self.origin_mm[1] + (row as f64 + 0.5) * self.pitch_mm,
        ]
    }

    pub fn height(&self, col: usize, row: usize) -> f64 {
        self.heights_mm[row * self.cols + col]
    }

    pub fn missed(&self, col: usize, row: usize) -> bool {
        self.no_hit[row * self.cols + col]
    }
}

/// Map a clipped height onto a 16-bit sample. `0` is 0 mm and `65535` is `travel_mm`.
pub fn height_to_u16(height_mm: f64, travel_mm: f64) -> u16 {
    if !travel_mm.is_finite() || travel_mm <= 0.0 || !height_mm.is_finite() || height_mm <= 0.0 {
        return 0;
    }
    let t = (height_mm / travel_mm).clamp(0.0, 1.0);
    let sample = (t * 65535.0).round();
    if sample >= 65535.0 {
        65535
    } else if sample <= 0.0 {
        0
    } else {
        sample as u16
    }
}

/// Sample `triangles` (millimetres, Z-up) into a pin grid.
///
/// Pins sit on cell centres. A cell count that would land within
/// 0.0001 mm of an exact multiple does not grow an extra cell. Each pin
/// casts a vertical ray and keeps the highest hit. Height is `hitZ - base`,
/// clipped to `[0, travel]`. A miss is height 0 and a set mask bit.
///
/// Rows run in parallel. Each pin is independent, so the table does not
/// depend on the thread count.
pub fn compile(
    triangles: &[[[f64; 3]; 3]],
    pitch_mm: f64,
    travel_mm: f64,
    extent: Extent,
    base: Base,
) -> Result<HeightFrame, String> {
    if !pitch_mm.is_finite() || pitch_mm <= 0.0 {
        return Err("pitch must be a finite number of millimetres above 0".into());
    }
    if !travel_mm.is_finite() || travel_mm <= 0.0 {
        return Err("travel must be a finite number of millimetres above 0".into());
    }
    let grid = index::Grid::build(triangles)?;
    let (x0, y0, x1, y1) = match extent {
        Extent::Auto => (grid.min[0], grid.min[1], grid.max[0], grid.max[1]),
        Extent::Rect { x0, y0, x1, y1 } => {
            if ![x0, y0, x1, y1].iter().all(|v| v.is_finite()) || x1 <= x0 || y1 <= y0 {
                return Err("extent must have finite x0 < x1 and y0 < y1".into());
            }
            (x0, y0, x1, y1)
        }
    };
    let cols = cells_along(x1 - x0, pitch_mm)?;
    let rows = cells_along(y1 - y0, pitch_mm)?;
    let pins = cols
        .checked_mul(rows)
        .filter(|n| *n <= MAX_PINS)
        .ok_or_else(|| format!("pin grid is {cols} by {rows}, above the limit of {MAX_PINS}"))?;
    let base_z = match base {
        Base::Min => grid.min[2],
        Base::Top => grid.max[2] - travel_mm,
    };
    if !base_z.is_finite() {
        return Err("mesh Z bounds are not finite".into());
    }

    #[derive(Clone, Copy)]
    struct Pin {
        height: f64,
        no_hit: bool,
    }
    let mut samples = vec![
        Pin {
            height: 0.0,
            no_hit: true
        };
        pins
    ];
    samples
        .par_chunks_mut(cols)
        .enumerate()
        .for_each(|(row, chunk)| {
            let y = y0 + (row as f64 + 0.5) * pitch_mm;
            for (col, pin) in chunk.iter_mut().enumerate() {
                let x = x0 + (col as f64 + 0.5) * pitch_mm;
                let Some(z) = grid.top_z(x, y) else {
                    continue;
                };
                pin.height = (z - base_z).clamp(0.0, travel_mm);
                pin.no_hit = false;
            }
        });

    let mut heights_mm = Vec::with_capacity(pins);
    let mut no_hit = Vec::with_capacity(pins);
    for pin in samples {
        heights_mm.push(pin.height);
        no_hit.push(pin.no_hit);
    }
    Ok(HeightFrame {
        pitch_mm,
        travel_mm,
        origin_mm: [x0, y0],
        extent_mm: [x0, y0, x1, y1],
        base,
        base_z_mm: base_z,
        cols,
        rows,
        heights_mm,
        no_hit,
    })
}

fn cells_along(span: f64, pitch: f64) -> Result<usize, String> {
    if !span.is_finite() || span <= 0.0 {
        return Err("extent is empty".into());
    }
    let covered = (span / pitch).floor();
    if !covered.is_finite() {
        return Err("pin grid is too large".into());
    }
    // An exact multiple stays exact. A remainder under a tenth of a micron
    // is float dust on a millimetre mesh, not another pin.
    let rem = span - covered * pitch;
    let n = if rem <= SPAN_SNAP_MM {
        covered
    } else {
        covered + 1.0
    };
    let n = n.max(1.0);
    if n > MAX_AXIS as f64 {
        return Err(format!(
            "pitch {pitch} mm across {span} mm would be {n} pins on one axis"
        ));
    }
    Ok(n as usize)
}
