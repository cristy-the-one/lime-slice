//! Lime Slice core: mesh in, strategy-blended FDM toolpaths and G-code out.

mod adaptive;
mod contour;
mod gcode;
mod load;
mod mesh;
mod slice;
mod strategy;
mod support;
mod toolpath;

pub use load::load_mesh;
pub use mesh::Mesh;
pub use slice::{
    slice_configured, slice_request, slice_with_baseline, SliceRequest, SliceResponse,
    SliceSettings,
};
pub use strategy::{Axis, BlendMode, PrinterProfile, StrategyId};
