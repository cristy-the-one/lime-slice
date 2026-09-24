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
        BlendMode::ByRegion {
            axis: Axis::X,
            at_mm: 10.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InfillPattern {
    Lines,
    Grid,
    Gyroid,
}

impl InfillPattern {
    pub fn as_str(self) -> &'static str {
        match self {
            InfillPattern::Lines => "lines",
            InfillPattern::Grid => "grid",
            InfillPattern::Gyroid => "gyroid",
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
}

pub fn pure(id: StrategyId) -> ResolvedStrategy {
    match id {
        StrategyId::Speed => ResolvedStrategy {
            id,
            walls: 2,
            infill_density: 0.12,
            pattern: InfillPattern::Lines,
            print_speed: 140.0,
            travel_speed: 250.0,
            accel: 3500.0,
            seam: SeamMode::Nearest,
            retract_mm: 0.35,
            retract_min_travel: 4.0,
            fan: 255,
            skirt_loops: 1,
            toughness: 0.0,
        },
        StrategyId::Toughness => ResolvedStrategy {
            id,
            walls: 5,
            infill_density: 0.48,
            pattern: InfillPattern::Gyroid,
            print_speed: 45.0,
            travel_speed: 120.0,
            accel: 800.0,
            seam: SeamMode::Aligned,
            retract_mm: 0.9,
            retract_min_travel: 1.2,
            fan: 150,
            skirt_loops: 2,
            toughness: 1.0,
        },
    }
}

pub fn mix(toughness: f64) -> ResolvedStrategy {
    let t = toughness.clamp(0.0, 1.0);
    let speed = pure(StrategyId::Speed);
    let tough = pure(StrategyId::Toughness);
    let lerp = |a: f64, b: f64| a + (b - a) * t;
    let pattern = if t < 0.34 {
        InfillPattern::Lines
    } else if t < 0.67 {
        InfillPattern::Grid
    } else {
        InfillPattern::Gyroid
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
    }
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
        }
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
