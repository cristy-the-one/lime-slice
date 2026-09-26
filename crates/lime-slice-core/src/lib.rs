//! Lime Slice core: mesh in, strategy-blended FDM toolpaths and G-code out.

mod adaptive;
mod audit;
mod calibrate;
mod cancel;
mod gcode;
mod gyroid;
mod index;
mod load;
mod mesh;
mod poly;
mod simplify;
mod slice;
mod strategy;
mod support;
mod toolpath;

pub use audit::{audit_slice, SliceAudit};
pub use calibrate::{
    pressure_advance_from_request, pressure_advance_tower, PaBand, PaCalib, PaCalibOutput,
    PaCalibRequest, PaFirmware,
};
pub use cancel::{cancel_all, Job};
pub use load::{load_mesh, mesh_preview, MeshPreview};
pub use mesh::Mesh;
pub use simplify::{nozzle_error_mm, simplify_for_nozzle, simplify_mesh, SimplifyStats};
pub use slice::{
    contour_times, pareto_estimates, slice_configured, slice_request, slice_with_baseline,
    BlendScore, CompareEstimate, FeatureEstimate, ParetoPoint, PreviewLayer, PrintEstimate,
    SliceRequest, SliceResponse, SliceSettings,
};
pub use strategy::{
    strategy_card, Axis, BlendMode, Gyroid3d, PrinterProfile, ScarfSeam, StrategyCard, StrategyId,
    ZHopMode,
};
pub use support::SupportStyle;
