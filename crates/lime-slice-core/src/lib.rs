//! Lime Slice core: mesh in, strategy-blended FDM toolpaths and G-code out.

mod adaptive;
mod audit;
mod calibrate;
mod cancel;
mod gcode;
mod gyroid;
mod index;
mod inner_prof;
mod load;
mod mesh;
mod poly;
mod slice;
mod slice_cache;
mod step;
mod strategy;
mod support;
mod toolpath;

pub use audit::{audit_slice, SliceAudit};
pub use calibrate::{
    pressure_advance_from_request, pressure_advance_tower, PaBand, PaCalib, PaCalibOutput,
    PaCalibRequest, PaFirmware,
};
pub use cancel::{cancel_all, Job};
pub use inner_prof::{
    report as inner_profile, reset as reset_inner_profile, set_enabled as set_inner_profile,
};
pub use load::{
    load_mesh, load_slice_mesh, load_slice_mesh_tol, mesh_preview, mesh_preview_tol, MeshPreview,
};
pub use mesh::Mesh;
pub use slice::{
    contour_times, keep_support_bases, outline_tolerance_mm, pareto_estimates, slice_configured,
    slice_request, slice_with_baseline, BlendScore, CompareEstimate, EditOutcomeView,
    FeatureEstimate, ParetoPoint, PreviewLayer, PrintEstimate, RigidPose, SiteSpec, SliceRequest,
    SliceResponse, SliceSettings, SupportEditSpec,
};
pub use slice_cache::{slice_payload, SliceCache};
pub use step::{
    load_step, load_step_timed, resolve_step_tolerance, StepTimings, STEP_TOLERANCE_DEFAULT_MM,
    STEP_TOLERANCE_MAX_MM, STEP_TOLERANCE_MIN_MM,
};
pub use strategy::{
    strategy_card, Axis, BlendMode, Gyroid3d, PrinterProfile, ScarfSeam, StrategyCard, StrategyId,
    ZHopMode,
};
pub use support::edit::{EditStatus, SupportEdit, TipSite};
pub use support::skeleton::SupportSkeleton;
pub use support::{CoverageGap, SupportStyle};
