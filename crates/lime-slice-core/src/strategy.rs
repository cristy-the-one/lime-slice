use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyId {
    Speed,
    Toughness,
}

impl StrategyId {
    pub fn as_str(self) -> &'static str {
        match self {
            StrategyId::Speed => "speed",
            StrategyId::Toughness => "toughness",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    X,
    Y,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum BlendMode {
    /// One named strategy for the whole part.
    Single { strategy: StrategyId },
    /// Interpolate strategy parameters. `toughness` is 0 (pure speed) to 1 (pure toughness).
    Weight { toughness: f64 },
    /// Bottom band is toughness, then a linear mix into speed.
    ByLayer {
        #[serde(rename = "bottomMm")]
        bottom_mm: f64,
        #[serde(rename = "transitionMm")]
        transition_mm: f64,
    },
    /// Split each layer on a plane. The low side is toughness, the high side is speed.
    ByRegion {
        axis: Axis,
        #[serde(rename = "atMm")]
        at_mm: f64,
    },
}

impl Default for BlendMode {
    fn default() -> Self {
        BlendMode::Single {
            strategy: StrategyId::Speed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InfillPattern {
    Lines,
    Grid,
    Gyroid,
    /// Sparse tree that only props up nearby roofs. Speed blend.
    Lightning,
}

impl InfillPattern {
    pub fn as_str(self) -> &'static str {
        match self {
            InfillPattern::Lines => "lines",
            InfillPattern::Grid => "grid",
            InfillPattern::Gyroid => "gyroid",
            InfillPattern::Lightning => "lightning",
        }
    }

    /// Relative strength of one millimetre of this pattern. Gyroid stays above the sparse patterns.
    pub fn strength(self) -> f64 {
        match self {
            InfillPattern::Lightning => 0.40,
            InfillPattern::Lines => 0.72,
            InfillPattern::Grid => 1.0,
            InfillPattern::Gyroid => 1.35,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeamMode {
    /// Start the loop near the previous extrusion end. Less travel.
    Nearest,
    /// Stack the seam on the +X side.
    Aligned,
}

/// Where a scarf joint replaces a butt seam.
///
/// `Blend` follows the resolved strategy: toughness (and a weight mix at or
/// above 50%) scarfs outer walls, speed and light efficiency mixes do not.
/// A sharp convex corner still keeps the corner seam; the scarf is only
/// applied when that corner is absent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScarfSeam {
    #[default]
    Blend,
    Off,
    Outer,
    All,
}

/// When the toughness gyroid is the real TPMS section instead of the 2D sine.
///
/// `Blend` uses the 3D section wherever the resolved pattern is gyroid
/// (toughness, and a weight mix at or above 75%). Speed stays on lightning.
/// `Off` keeps the 2D bands. `On` forces the 3D gyroid for every strategy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Gyroid3d {
    #[default]
    Blend,
    Off,
    On,
}

/// When a travel lifts the nozzle.
///
/// `Blend` is smart on toughness (and a weight mix at or above 50%) and off
/// on speed. `Smart` hops only when a long travel crosses printed top or
/// perimeter that combing could not route around, or when leaving a top skin.
/// `Always` hops every travel longer than the threshold. `Off` never hops.
/// `--classic` forces off.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ZHopMode {
    Off,
    #[default]
    Blend,
    Always,
    Smart,
}

impl ZHopMode {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "false" => Ok(ZHopMode::Off),
            "blend" | "auto" | "default" => Ok(ZHopMode::Blend),
            "always" | "on" | "true" => Ok(ZHopMode::Always),
            "smart" => Ok(ZHopMode::Smart),
            other => Err(format!(
                "unknown z-hop '{other}' (use off, blend, always, or smart)"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ZHopMode::Off => "off",
            ZHopMode::Blend => "blend",
            ZHopMode::Always => "always",
            ZHopMode::Smart => "smart",
        }
    }
}

impl Gyroid3d {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.trim().to_ascii_lowercase().as_str() {
            "blend" | "auto" | "default" => Ok(Gyroid3d::Blend),
            "off" | "2d" | "false" => Ok(Gyroid3d::Off),
            "on" | "3d" | "true" => Ok(Gyroid3d::On),
            other => Err(format!(
                "unknown gyroid mode '{other}' (use blend, off, or on)"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Gyroid3d::Blend => "blend",
            Gyroid3d::Off => "off",
            Gyroid3d::On => "on",
        }
    }
}

impl ScarfSeam {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.trim().to_ascii_lowercase().as_str() {
            "blend" | "auto" | "default" => Ok(ScarfSeam::Blend),
            "off" | "none" | "false" => Ok(ScarfSeam::Off),
            "outer" => Ok(ScarfSeam::Outer),
            "all" | "walls" => Ok(ScarfSeam::All),
            other => Err(format!(
                "unknown scarf seam '{other}' (use blend, off, outer, or all)"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ScarfSeam::Blend => "blend",
            ScarfSeam::Off => "off",
            ScarfSeam::Outer => "outer",
            ScarfSeam::All => "all",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResolvedStrategy {
    pub id: StrategyId,
    pub walls: u32,
    pub infill_density: f64,
    pub pattern: InfillPattern,
    pub print_speed: f64,
    pub travel_speed: f64,
    pub accel: f64,
    pub seam: SeamMode,
    pub retract_mm: f64,
    pub retract_min_travel: f64,
    pub fan: u8,
    pub skirt_loops: u32,
    /// 0 = speed, 1 = toughness. Used when a single toolpath is a mix.
    pub toughness: f64,
    /// Millimetres below a roof that lightning (or a pruned pattern) still prints.
    /// `0` keeps the pattern for the full height.
    pub lightning_range_mm: f64,
    /// Emit sparse infill every N layers at N times the layer height. `1` is off.
    pub infill_combine: u32,
    /// Distinct feed and accel for outer, inner, sparse, solid, top, and travel.
    pub feature_speeds: bool,
    pub outer_speed: f64,
    pub inner_speed: f64,
    pub sparse_speed: f64,
    pub solid_speed: f64,
    pub top_speed: f64,
    pub outer_accel: f64,
    pub inner_accel: f64,
    pub sparse_accel: f64,
    pub solid_accel: f64,
    pub top_accel: f64,
    pub travel_accel: f64,
    /// Scarf used when the slice knob is `Blend`. Speed is off; toughness is outer.
    pub scarf: ScarfSeam,
    /// True when this toolpath should cut the TPMS gyroid at the layer Z.
    pub gyroid_3d: bool,
    /// Resolved hop policy. `Blend` is not stored here.
    pub z_hop: ZHopMode,
}

pub fn pure(id: StrategyId) -> ResolvedStrategy {
    match id {
        StrategyId::Speed => ResolvedStrategy {
            id,
            walls: 2,
            infill_density: 0.12,
            pattern: InfillPattern::Lightning,
            print_speed: 140.0,
            travel_speed: 300.0,
            accel: 3500.0,
            seam: SeamMode::Nearest,
            retract_mm: 0.35,
            retract_min_travel: 4.0,
            fan: 255,
            skirt_loops: 1,
            toughness: 0.0,
            lightning_range_mm: 4.0,
            infill_combine: 3,
            feature_speeds: true,
            outer_speed: 130.0,
            inner_speed: 160.0,
            sparse_speed: 220.0,
            solid_speed: 150.0,
            top_speed: 120.0,
            outer_accel: 3500.0,
            inner_accel: 4000.0,
            sparse_accel: 5000.0,
            solid_accel: 3500.0,
            top_accel: 3000.0,
            travel_accel: 5500.0,
            scarf: ScarfSeam::Off,
            gyroid_3d: false,
            z_hop: ZHopMode::Off,
        },
        StrategyId::Toughness => ResolvedStrategy {
            id,
            walls: 5,
            infill_density: 0.48,
            pattern: InfillPattern::Gyroid,
            print_speed: 45.0,
            travel_speed: 140.0,
            accel: 800.0,
            seam: SeamMode::Aligned,
            retract_mm: 0.9,
            retract_min_travel: 1.2,
            fan: 150,
            skirt_loops: 2,
            toughness: 1.0,
            lightning_range_mm: 0.0,
            infill_combine: 1,
            feature_speeds: true,
            outer_speed: 40.0,
            inner_speed: 48.0,
            sparse_speed: 55.0,
            solid_speed: 42.0,
            top_speed: 36.0,
            outer_accel: 650.0,
            inner_accel: 850.0,
            sparse_accel: 1000.0,
            solid_accel: 750.0,
            top_accel: 550.0,
            travel_accel: 1200.0,
            scarf: ScarfSeam::Outer,
            gyroid_3d: true,
            z_hop: ZHopMode::Smart,
        },
    }
}

pub fn mix(toughness: f64) -> ResolvedStrategy {
    let t = toughness.clamp(0.0, 1.0);
    let speed = pure(StrategyId::Speed);
    let tough = pure(StrategyId::Toughness);
    let lerp = |a: f64, b: f64| a + (b - a) * t;
    // Speed → lightning, efficiency (mid weight) → lines then grid, toughness → gyroid.
    let (pattern, range) = if t < 0.20 {
        (InfillPattern::Lightning, lerp(4.0, 3.2))
    } else if t < 0.45 {
        (InfillPattern::Lines, lerp(2.4, 0.0))
    } else if t < 0.75 {
        (InfillPattern::Grid, 0.0)
    } else {
        (InfillPattern::Gyroid, 0.0)
    };
    ResolvedStrategy {
        id: if t >= 0.5 {
            StrategyId::Toughness
        } else {
            StrategyId::Speed
        },
        walls: lerp(speed.walls as f64, tough.walls as f64)
            .round()
            .clamp(1.0, 8.0) as u32,
        infill_density: lerp(speed.infill_density, tough.infill_density),
        pattern,
        print_speed: lerp(speed.print_speed, tough.print_speed),
        travel_speed: lerp(speed.travel_speed, tough.travel_speed),
        accel: lerp(speed.accel, tough.accel),
        seam: if t >= 0.5 {
            SeamMode::Aligned
        } else {
            SeamMode::Nearest
        },
        retract_mm: lerp(speed.retract_mm, tough.retract_mm),
        retract_min_travel: lerp(speed.retract_min_travel, tough.retract_min_travel),
        fan: lerp(speed.fan as f64, tough.fan as f64).round() as u8,
        skirt_loops: if t >= 0.5 { 2 } else { 1 },
        toughness: t,
        lightning_range_mm: range,
        infill_combine: if t < 0.20 {
            3
        } else if t < 0.45 {
            2
        } else {
            1
        },
        feature_speeds: true,
        outer_speed: lerp(speed.outer_speed, tough.outer_speed),
        inner_speed: lerp(speed.inner_speed, tough.inner_speed),
        sparse_speed: lerp(speed.sparse_speed, tough.sparse_speed),
        solid_speed: lerp(speed.solid_speed, tough.solid_speed),
        top_speed: lerp(speed.top_speed, tough.top_speed),
        outer_accel: lerp(speed.outer_accel, tough.outer_accel),
        inner_accel: lerp(speed.inner_accel, tough.inner_accel),
        sparse_accel: lerp(speed.sparse_accel, tough.sparse_accel),
        solid_accel: lerp(speed.solid_accel, tough.solid_accel),
        top_accel: lerp(speed.top_accel, tough.top_accel),
        travel_accel: lerp(speed.travel_accel, tough.travel_accel),
        scarf: if t >= 0.5 {
            ScarfSeam::Outer
        } else {
            ScarfSeam::Off
        },
        gyroid_3d: pattern == InfillPattern::Gyroid,
        z_hop: if t >= 0.5 {
            ZHopMode::Smart
        } else {
            ZHopMode::Off
        },
    }
}

/// Classic planner: line infill for the full height, no lightning pruning.
pub fn classicize(mut strategy: ResolvedStrategy) -> ResolvedStrategy {
    if strategy.pattern == InfillPattern::Lightning {
        strategy.pattern = InfillPattern::Lines;
    }
    strategy.lightning_range_mm = 0.0;
    strategy.infill_combine = 1;
    strategy.feature_speeds = false;
    strategy.scarf = ScarfSeam::Off;
    strategy.gyroid_3d = false;
    strategy.z_hop = ZHopMode::Off;
    strategy
}

/// Support infill fraction. Toughness prints denser supports than speed.
pub fn support_density(strategy: &ResolvedStrategy) -> f64 {
    (0.10 + 0.22 * strategy.toughness).clamp(0.08, 0.36)
}

/// Interface layers sit denser than the sparse support under them.
pub fn support_interface_density(strategy: &ResolvedStrategy) -> f64 {
    (support_density(strategy) * 3.2).clamp(0.5, 0.85)
}

pub fn support_speed(strategy: &ResolvedStrategy, interface: bool) -> f64 {
    let scale = if interface { 0.45 } else { 0.62 };
    (strategy.print_speed * scale).clamp(18.0, 80.0)
}

/// Toughness weight at a layer whose top is `z`.
pub fn layer_weight(z: f64, bottom_mm: f64, transition_mm: f64) -> f64 {
    if z <= bottom_mm.max(0.0) {
        1.0
    } else if transition_mm <= 1e-6 || z >= bottom_mm + transition_mm {
        0.0
    } else {
        1.0 - (z - bottom_mm) / transition_mm
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterProfile {
    pub name: String,
    pub nozzle_diameter: f64,
    pub filament_diameter: f64,
    pub nozzle_temp: f64,
    pub bed_temp: f64,
    pub bed_x: f64,
    pub bed_y: f64,
    /// Volumetric flow cap. Speeds that would exceed this are slowed.
    #[serde(default = "default_flow")]
    pub max_volumetric_mm3_s: f64,
    /// Used by the filament-mass estimator. PLA is 1.24 g/cm³.
    #[serde(default = "default_density")]
    pub filament_density_g_cm3: f64,
    /// Klipper pressure advance (mm/(mm/s)). `0` emits nothing.
    #[serde(default)]
    pub pressure_advance: f64,
    /// Marlin linear advance K. `0` emits nothing.
    #[serde(default)]
    pub linear_advance: f64,
}

fn default_flow() -> f64 {
    12.0
}

fn default_density() -> f64 {
    1.24
}

impl Default for PrinterProfile {
    fn default() -> Self {
        Self {
            name: "Generic Marlin 0.4 mm PLA".into(),
            nozzle_diameter: 0.4,
            filament_diameter: 1.75,
            nozzle_temp: 200.0,
            bed_temp: 60.0,
            bed_x: 220.0,
            bed_y: 220.0,
            max_volumetric_mm3_s: default_flow(),
            filament_density_g_cm3: default_density(),
            pressure_advance: 0.0,
            linear_advance: 0.0,
        }
    }
}

/// Relative pressure/linear advance by feature. Outer and top keep the full factor.
pub fn advance_scale(kind: &str) -> f64 {
    match kind {
        "outer" | "top" | "wall" | "skirt" => 1.0,
        "inner" | "thin-wall" => 0.85,
        "sparse" | "infill" | "solid" | "gap-fill" => 0.65,
        "bridge" => 0.5,
        "support" | "support-interface" => 0.4,
        _ => 1.0,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyCard {
    pub name: String,
    pub toughness: f64,
    pub walls: u32,
    pub pattern: String,
    pub density: f64,
    pub outer: f64,
    pub inner: f64,
    pub sparse: f64,
    pub solid: f64,
    pub top: f64,
    pub travel: f64,
    pub effective_outer: f64,
    pub effective_inner: f64,
    pub effective_sparse: f64,
    pub effective_top: f64,
}

/// Resolved parameters for a toughness weight, with feeds after the volumetric cap.
pub fn strategy_card(toughness: f64, layer_h: f64, line_width: f64, max_vol: f64) -> StrategyCard {
    let t = toughness.clamp(0.0, 1.0);
    let resolved = if t <= 1e-9 {
        pure(StrategyId::Speed)
    } else if t >= 1.0 - 1e-9 {
        pure(StrategyId::Toughness)
    } else {
        mix(t)
    };
    let cap = |speed: f64| {
        if !max_vol.is_finite() || max_vol <= 0.0 {
            speed
        } else {
            let area = (line_width * layer_h).max(1e-6);
            speed.min(max_vol / area)
        }
    };
    let name = if t <= 1e-9 {
        "speed"
    } else if t >= 1.0 - 1e-9 {
        "toughness"
    } else if (t - 0.5).abs() < 0.02 {
        "efficiency"
    } else {
        "weight"
    };
    StrategyCard {
        name: name.into(),
        toughness: resolved.toughness,
        walls: resolved.walls,
        pattern: resolved.pattern.as_str().into(),
        density: resolved.infill_density,
        outer: resolved.outer_speed,
        inner: resolved.inner_speed,
        sparse: resolved.sparse_speed,
        solid: resolved.solid_speed,
        top: resolved.top_speed,
        travel: resolved.travel_speed,
        effective_outer: cap(resolved.outer_speed),
        effective_inner: cap(resolved.inner_speed),
        effective_sparse: cap(resolved.sparse_speed),
        effective_top: cap(resolved.top_speed),
    }
}

impl BlendMode {
    pub fn describe(&self) -> String {
        match self {
            BlendMode::Single { strategy } => format!("single {}", strategy.as_str()),
            BlendMode::Weight { toughness } => {
                format!("weight toughness {:.0}%", toughness.clamp(0.0, 1.0) * 100.0)
            }
            BlendMode::ByLayer {
                bottom_mm,
                transition_mm,
            } => format!("by layer bottom {bottom_mm:.2} mm then {transition_mm:.2} mm transition"),
            BlendMode::ByRegion { axis, at_mm } => {
                let axis = match axis {
                    Axis::X => "X",
                    Axis::Y => "Y",
                };
                format!("by region {axis} = {at_mm:.2} mm (low toughness, high speed)")
            }
        }
    }
}
