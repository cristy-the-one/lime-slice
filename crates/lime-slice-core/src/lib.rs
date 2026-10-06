//! Lime Slice core: mesh in, strategy-blended FDM toolpaths and G-code out.

mod adaptive;
mod audit;
mod belt;
mod calibrate;
mod cancel;
mod gcode;
mod gyroid;
mod index;
mod lightning;
mod inner_prof;
mod load;
mod mesh;
mod meshes;
mod modifiers;
mod poly;
mod progress;
mod slice;
mod slice_cache;
mod step;
mod strategy;
mod support;
mod toolpath;

pub use audit::{audit_slice, SliceAudit};
pub use calibrate::{
    flow_from_request, flow_tower, pressure_advance_from_request, pressure_advance_tower,
    retract_from_request, retract_tower, temperature_from_request, temperature_tower, FlowBand,
    FlowCalib, FlowCalibOutput, FlowCalibRequest, PaBand, PaCalib, PaCalibOutput, PaCalibRequest,
    PaFirmware, RetractBand, RetractCalib, RetractCalibOutput, RetractCalibRequest, TempBand,
    TempCalib, TempCalibOutput, TempCalibRequest,
};
pub use cancel::{cancel_all, Job};
pub use gcode::GcodeText;
pub use inner_prof::{
    report as inner_profile, reset as reset_inner_profile, set_enabled as set_inner_profile,
};
pub use load::{
    load_mesh, load_slice_mesh, load_slice_mesh_tol, mesh_preview, mesh_preview_tol, MeshPreview,
};
pub use mesh::Mesh;
pub use meshes::{mesh_id, PayloadError, HELD_BYTES};
pub use progress::{fraction, Progress, Stage, Status, Watch};
pub use slice::{
    contour_times, keep_support_bases, outline_tolerance_mm, pareto_estimates, slice_configured,
    slice_configured_watched, slice_request, slice_request_watched, slice_with_baseline,
    BlendScore, CompareEstimate, EditOutcomeView, FeatureEstimate, HeightRangeSpec,
    ModifierVolumeSpec, PaintDiskSpec, ParetoPoint, PreviewLayer, PrintEstimate, RigidPose,
    SiteSpec, SliceRequest, SliceResponse, SliceSettings, SupportEditSpec, VolumeKind,
};
pub use slice_cache::{slice_payload, slice_payload_watched, SliceCache};
pub use step::{
    load_step, load_step_timed, resolve_step_tolerance, StepTimings, STEP_TOLERANCE_DEFAULT_MM,
    STEP_TOLERANCE_MAX_MM, STEP_TOLERANCE_MIN_MM,
};
pub use strategy::{
    strategy_card, Axis, BlendMode, FuzzySkin, Gyroid3d, Ironing, PrinterProfile, ScarfSeam,
    SeamPlacement, StrategyCard, StrategyId, ZHopMode,
};
pub use support::edit::{EditStatus, SupportEdit, TipSite};
pub use support::paint::{PaintDisk, PaintKind, PaintTally};
pub use support::skeleton::SupportSkeleton;
pub use support::{CoverageGap, InAir, SupportStyle};
