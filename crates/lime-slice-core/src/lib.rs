//! Lime Slice core: mesh in, strategy-blended FDM toolpaths and G-code out.

mod adaptive;
mod calibrate;
mod contour;
mod gcode;
mod gyroid;
mod index;
mod load;
mod mesh;
mod slice;
mod strategy;
mod support;
mod toolpath;

pub use calibrate::{
    pressure_advance_from_request, pressure_advance_tower, PaBand, PaCalib, PaCalibOutput,
    PaCalibRequest, PaFirmware,
};
pub use load::load_mesh;
pub use mesh::Mesh;
pub use slice::{
    contour_times, slice_configured, slice_request, slice_with_baseline, BlendScore, PrintEstimate,
    SliceRequest, SliceResponse, SliceSettings,
};
pub use strategy::{Axis, BlendMode, Gyroid3d, PrinterProfile, ScarfSeam, StrategyId, ZHopMode};
pub use support::SupportStyle;
