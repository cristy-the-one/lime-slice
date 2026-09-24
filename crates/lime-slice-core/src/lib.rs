//! Lime Slice core: mesh in, strategy-blended FDM toolpaths and G-code out.

mod adaptive;
mod contour;
mod gcode;
mod index;
mod load;
mod mesh;
mod slice;
mod strategy;
mod support;
mod toolpath;

pub use load::load_mesh;
pub use mesh::Mesh;
pub use slice::{
    contour_times, slice_configured, slice_request, slice_with_baseline, BlendScore, PrintEstimate,
    SliceRequest, SliceResponse, SliceSettings,
};
pub use strategy::{Axis, BlendMode, PrinterProfile, ScarfSeam, StrategyId};
pub use support::SupportStyle;
