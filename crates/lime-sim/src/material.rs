//! Linear orthotropic elasticity in the build frame, and max-stress failure.
//!
//! `LinearIsotropic` is this model with the three moduli equal and
//! `isotropic` set. A later plastic model implements the same
//! `stress_tangent` and keeps its history in `MatState`.

use serde::{Deserialize, Serialize};

use crate::units::{cross, dot, material_frame, normalize};

#[derive(Clone, Debug, Default)]
pub struct MatState {
    pub plastic_strain: Option<[f64; 6]>,
}

#[derive(Clone, Copy, Debug)]
pub struct MaterialContext {
    pub build_axis: [f64; 3],
    pub temperature_c: Option<f64>,
    pub fibre_axis: Option<[f64; 3]>,
    pub volume_fraction: f64,
    /// The larger eigenvalue of the beads' orientation tensor: 0.5 for
    /// crossing beads, 1 for beads along `fibre_axis`. A smear has 0.5.
    pub alignment: f64,
    /// The share of the volume that was bridged. A smear has 0.
    pub bridge_share: f64,
}

impl MaterialContext {
    /// A smeared element: a fraction, and no bead direction.
    pub fn smeared(build_axis: [f64; 3], volume_fraction: f64) -> Self {
        Self {
            build_axis,
            temperature_c: None,
            fibre_axis: None,
            volume_fraction,
            alignment: 0.5,
            bridge_share: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Strain {
    pub v: [f64; 6],
}

#[derive(Clone, Copy, Debug)]
pub struct Stress {
    pub v: [f64; 6],
}

#[derive(Clone, Copy, Debug)]
pub struct Tangent {
    pub c: [[f64; 6]; 6],
}

#[derive(Clone, Copy, Debug)]
pub struct Allowables {
    pub in_plane_mpa: f64,
    pub across_layers_mpa: f64,
    pub compression_in_plane_mpa: f64,
    pub compression_across_layers_mpa: f64,
    pub shear_across_layers_mpa: f64,
}

/// `Sync`, so an assembly can read one from every thread.
pub trait MaterialModel: Sync {
    fn stress_tangent(
        &self,
        strain: &[f64; 6],
        state: &mut MatState,
        ctx: &MaterialContext,
    ) -> (Stress, Tangent);
    fn allowables(&self) -> Allowables;
    fn density_g_cm3(&self) -> f64;
    fn isotropic(&self) -> bool;
}

pub trait FailureCriterion {
    fn safety(&self, stress: &Stress, allow: &Allowables, ctx: &MaterialContext) -> f64;
}

/// Transverse isotropy: the layer plane is stiff, the layer normal is weak.
/// One Poisson ratio. The compliance is symmetric, and it is isotropic when
/// the two moduli match.
#[derive(Clone, Debug)]
pub struct LinearOrthotropic {
    pub e_in_plane_mpa: f64,
    pub e_across_layers_mpa: f64,
    pub nu: f64,
    pub strength_in_plane_mpa: f64,
    pub strength_across_layers_mpa: f64,
    pub compression_in_plane_mpa: f64,
    pub compression_across_layers_mpa: f64,
    pub shear_across_layers_mpa: f64,
    pub density_g_cm3: f64,
    pub isotropic: bool,
}

impl LinearOrthotropic {
    pub fn isotropic(e_mpa: f64, nu: f64, density_g_cm3: f64) -> Self {
        Self {
            e_in_plane_mpa: e_mpa,
            e_across_layers_mpa: e_mpa,
            nu,
            strength_in_plane_mpa: f64::INFINITY,
            strength_across_layers_mpa: f64::INFINITY,
            compression_in_plane_mpa: f64::INFINITY,
            compression_across_layers_mpa: f64::INFINITY,
            shear_across_layers_mpa: f64::INFINITY,
            density_g_cm3,
            isotropic: true,
        }
    }

    fn moduli(&self, vf: f64) -> (f64, f64) {
        let vf = vf.clamp(0.0, 1.0);
        if self.isotropic {
            let e = self.e_in_plane_mpa * vf;
            (e, e)
        } else {
            (self.e_in_plane_mpa * vf, self.e_across_layers_mpa * vf)
        }
    }
}

impl MaterialModel for LinearOrthotropic {
    fn stress_tangent(
        &self,
        strain: &[f64; 6],
        _state: &mut MatState,
        ctx: &MaterialContext,
    ) -> (Stress, Tangent) {
        let vf = ctx.volume_fraction;
        let (e_in, e_z) = self.moduli(vf);
        if e_in <= 0.0 || e_z <= 0.0 {
            return (Stress { v: [0.0; 6] }, Tangent { c: [[0.0; 6]; 6] });
        }
        let c_local = orthotropic_c(e_in, e_in, e_z, self.nu);
        let q = material_frame(ctx.build_axis).unwrap_or([
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]);
        let c = tangent_global(&c_local, &q);
        let mut stress = [0.0; 6];
        for i in 0..6 {
            for j in 0..6 {
                stress[i] += c[i][j] * strain[j];
            }
        }
        (Stress { v: stress }, Tangent { c })
    }

    fn allowables(&self) -> Allowables {
        if self.isotropic {
            let s = self.strength_in_plane_mpa;
            Allowables {
                in_plane_mpa: s,
                across_layers_mpa: s,
                compression_in_plane_mpa: s,
                compression_across_layers_mpa: s,
                shear_across_layers_mpa: s,
            }
        } else {
            Allowables {
                in_plane_mpa: self.strength_in_plane_mpa,
                across_layers_mpa: self.strength_across_layers_mpa,
                compression_in_plane_mpa: self.compression_in_plane_mpa,
                compression_across_layers_mpa: self.compression_across_layers_mpa,
                shear_across_layers_mpa: self.shear_across_layers_mpa,
            }
        }
    }

    fn density_g_cm3(&self) -> f64 {
        self.density_g_cm3
    }

    fn isotropic(&self) -> bool {
        self.isotropic
    }
}

pub struct MaxStress;

impl FailureCriterion for MaxStress {
    fn safety(&self, stress: &Stress, allow: &Allowables, ctx: &MaterialContext) -> f64 {
        let q = material_frame(ctx.build_axis).unwrap_or([
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]);
        let local = tensor_to_stress(&rotate_to(&q, &stress_to_tensor(&stress.v)));
        let mean = 0.5 * (local[0] + local[1]);
        // local[3] is in-plane shear. It widens the principal radius. It is
        // not compared with the interlayer shear allowable.
        let radius = ((0.5 * (local[0] - local[1])).powi(2) + local[3] * local[3]).sqrt();
        let tension_in = (mean + radius).max(mean - radius).max(0.0);
        let compression_in = (-(mean + radius).min(mean - radius)).max(0.0);
        let tension_z = local[2].max(0.0);
        let compression_z = (-local[2]).max(0.0);
        let interlayer = local[4].hypot(local[5]);
        // The smeared stress is the average. The struts in a core carry
        // about stress/vf, so the allowable scales by the same fraction.
        let vf = ctx.volume_fraction.clamp(0.0, 1.0);
        let mut sf = f64::INFINITY;
        if tension_in > 1e-15 {
            sf = sf.min(allow.in_plane_mpa * vf / tension_in);
        }
        if compression_in > 1e-15 {
            sf = sf.min(allow.compression_in_plane_mpa * vf / compression_in);
        }
        if tension_z > 1e-15 {
            sf = sf.min(allow.across_layers_mpa * vf / tension_z);
        }
        if compression_z > 1e-15 {
            sf = sf.min(allow.compression_across_layers_mpa * vf / compression_z);
        }
        if interlayer > 1e-15 {
            sf = sf.min(allow.shear_across_layers_mpa * vf / interlayer);
        }
        sf
    }
}

/// A bead card section: a transversely orthotropic bead, its bond to the
/// next bead, and its bond to the next layer. A cell of the sliced
/// representation mixes it by how its beads lie (the sliced plan, §6).
///
/// Like the rest of a card it is never copied from a data sheet. A
/// provisional section keeps the study `rough`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BeadSection {
    #[serde(default)]
    pub provisional: bool,
    #[serde(rename = "EAlongBeadMPa")]
    pub e_along_mpa: f64,
    /// In the layer plane, across a bead: the bead-to-bead bond.
    #[serde(rename = "EAcrossBeadMPa")]
    pub e_across_mpa: f64,
    /// Along the layer normal: the layer-to-layer bond.
    #[serde(rename = "EAcrossLayersMPa")]
    pub e_layers_mpa: f64,
    #[serde(rename = "strengthAlongBeadMPa")]
    pub strength_along_mpa: f64,
    #[serde(rename = "strengthAcrossBeadMPa")]
    pub strength_across_mpa: f64,
    #[serde(rename = "strengthAcrossLayersMPa")]
    pub strength_layers_mpa: f64,
    #[serde(rename = "shearAcrossLayersMPa")]
    pub shear_layers_mpa: f64,
    /// In-plane shear between beads. Absent, it is half the across-bead
    /// strength, a placeholder like the main card's shear.
    #[serde(default, rename = "shearAcrossBeadMPa")]
    pub shear_across_mpa: Option<f64>,
    /// Multiplies the across-bead modulus and strength in a bridged cell.
    #[serde(rename = "bridgeFactor")]
    pub bridge_factor: f64,
}

impl BeadSection {
    pub fn check(&self) -> Result<(), String> {
        let moduli = [self.e_along_mpa, self.e_across_mpa, self.e_layers_mpa];
        let strengths = [
            self.strength_along_mpa,
            self.strength_across_mpa,
            self.strength_layers_mpa,
            self.shear_layers_mpa,
            self.shear_across_mpa.unwrap_or(1.0),
        ];
        if moduli
            .iter()
            .chain(&strengths)
            .any(|v| !(v.is_finite() && *v > 0.0))
        {
            return Err("Every bead modulus and strength has to be positive.".into());
        }
        if !(self.bridge_factor.is_finite()
            && self.bridge_factor > 0.0
            && self.bridge_factor <= 1.0)
        {
            return Err("bridgeFactor has to be above 0 and at most 1.".into());
        }
        Ok(())
    }

    fn shear_across(&self) -> f64 {
        self.shear_across_mpa
            .unwrap_or(0.5 * self.strength_across_mpa)
    }

    /// The across-bead number in a cell with this bridged share.
    fn bridged(&self, value: f64, bridge_share: f64) -> f64 {
        let share = bridge_share.clamp(0.0, 1.0);
        value * (1.0 - share * (1.0 - self.bridge_factor))
    }

    /// Along the cell's first axis, across it in the plane, and along the
    /// layer normal, for this context: the beads mixed by their alignment
    /// and scaled by the fraction.
    fn cell_values(&self, along: f64, across: f64, layers: f64, ctx: &MaterialContext) -> [f64; 3] {
        let phi = ctx.volume_fraction.clamp(0.0, 1.0);
        let l1 = ctx.alignment.clamp(0.5, 1.0);
        let l2 = 1.0 - l1;
        let across = self.bridged(across, ctx.bridge_share);
        [
            phi * (l1 * along + l2 * across),
            phi * (l2 * along + l1 * across),
            phi * layers,
        ]
    }
}

/// The cell's frame: the bead direction, the in-plane normal to it, and the
/// layer normal, as rows. Without a direction the cell is in-plane
/// isotropic, so any in-plane pair will do.
pub fn bead_frame(ctx: &MaterialContext) -> [[f64; 3]; 3] {
    let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let Some(e3) = normalize(ctx.build_axis) else {
        return identity;
    };
    let in_plane = ctx.fibre_axis.and_then(|t| {
        let along = [
            t[0] - dot(t, e3) * e3[0],
            t[1] - dot(t, e3) * e3[1],
            t[2] - dot(t, e3) * e3[2],
        ];
        normalize(along)
    });
    match in_plane {
        Some(e1) => [e1, cross(e3, e1), e3],
        None => material_frame(e3).unwrap_or(identity),
    }
}

/// Beads mixed per cell. Stiffness follows `BeadSection::cell_values`; the
/// shear moduli are Huber's, `√(Ei·Ej) / (2(1 + ν))`, so the cell stays
/// positive definite at any mix. Density is the card's.
#[derive(Clone, Debug)]
pub struct BeadComposite {
    pub beads: BeadSection,
    pub nu: f64,
    pub density_g_cm3: f64,
}

impl MaterialModel for BeadComposite {
    fn stress_tangent(
        &self,
        strain: &[f64; 6],
        _state: &mut MatState,
        ctx: &MaterialContext,
    ) -> (Stress, Tangent) {
        let b = &self.beads;
        let [e1, e2, e3] = b.cell_values(b.e_along_mpa, b.e_across_mpa, b.e_layers_mpa, ctx);
        if e1 <= 0.0 || e2 <= 0.0 || e3 <= 0.0 {
            return (Stress { v: [0.0; 6] }, Tangent { c: [[0.0; 6]; 6] });
        }
        let c_local = orthotropic_huber(e1, e2, e3, self.nu);
        let c = tangent_global(&c_local, &bead_frame(ctx));
        let mut stress = [0.0; 6];
        for i in 0..6 {
            for j in 0..6 {
                stress[i] += c[i][j] * strain[j];
            }
        }
        (Stress { v: stress }, Tangent { c })
    }

    /// The solid bead's numbers; the cell's come from `BeadMaxStress`.
    fn allowables(&self) -> Allowables {
        let b = &self.beads;
        Allowables {
            in_plane_mpa: b.strength_along_mpa,
            across_layers_mpa: b.strength_layers_mpa,
            compression_in_plane_mpa: b.strength_along_mpa,
            compression_across_layers_mpa: b.strength_layers_mpa,
            shear_across_layers_mpa: b.shear_layers_mpa,
        }
    }

    fn density_g_cm3(&self) -> f64 {
        self.density_g_cm3
    }

    fn isotropic(&self) -> bool {
        false
    }
}

/// Which allowable decided a safety factor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Governs {
    InPlane,
    AlongBead,
    AcrossBead,
    AcrossLayers,
    InterlayerShear,
    BeadShear,
}

impl Governs {
    pub fn as_str(self) -> &'static str {
        match self {
            Governs::InPlane => "in-plane",
            Governs::AlongBead => "along-bead",
            Governs::AcrossBead => "across-bead",
            Governs::AcrossLayers => "across-layers",
            Governs::InterlayerShear => "interlayer-shear",
            Governs::BeadShear => "bead-shear",
        }
    }
}

/// Max-stress in the cell's own frame: along the bead, across it, across
/// the layers, interlayer shear and shear between beads. Each allowable is
/// mixed and scaled by the fraction as the stiffness is (SR-01's rule, from
/// the real fraction). Compression uses the tension number, a placeholder
/// like the main card's.
pub struct BeadMaxStress<'a> {
    pub beads: &'a BeadSection,
}

impl BeadMaxStress<'_> {
    pub fn safety_governed(
        &self,
        stress: &Stress,
        ctx: &MaterialContext,
    ) -> (f64, Option<Governs>) {
        let b = self.beads;
        let q = bead_frame(ctx);
        let local = tensor_to_stress(&rotate_to(&q, &stress_to_tensor(&stress.v)));
        let [s1, s2, s3] = b.cell_values(
            b.strength_along_mpa,
            b.strength_across_mpa,
            b.strength_layers_mpa,
            ctx,
        );
        let phi = ctx.volume_fraction.clamp(0.0, 1.0);
        let shear_layers = phi * b.shear_layers_mpa;
        let shear_beads = phi * b.bridged(b.shear_across(), ctx.bridge_share);
        let checks = [
            (local[0].abs(), s1, Governs::AlongBead),
            (local[1].abs(), s2, Governs::AcrossBead),
            (local[2].abs(), s3, Governs::AcrossLayers),
            (
                local[4].hypot(local[5]),
                shear_layers,
                Governs::InterlayerShear,
            ),
            (local[3].abs(), shear_beads, Governs::BeadShear),
        ];
        let mut best = (f64::INFINITY, None);
        for (load, allow, governs) in checks {
            if load > 1e-15 {
                let sf = allow / load;
                if sf < best.0 {
                    best = (sf, Some(governs));
                }
            }
        }
        best
    }
}

pub fn von_mises(s: &[f64; 6]) -> f64 {
    let (xx, yy, zz, xy, yz, zx) = (s[0], s[1], s[2], s[3], s[4], s[5]);
    let a = (xx - yy).powi(2) + (yy - zz).powi(2) + (zz - xx).powi(2);
    (0.5 * a + 3.0 * (xy * xy + yz * yz + zx * zx)).sqrt()
}

fn orthotropic_c(e1: f64, e2: f64, e3: f64, nu: f64) -> [[f64; 6]; 6] {
    let nu12 = nu;
    let nu13 = nu;
    let nu23 = nu;
    let nu21 = nu12 * e2 / e1;
    let nu31 = nu13 * e3 / e1;
    let nu32 = nu23 * e3 / e2;
    let g12 = e1 / (2.0 * (1.0 + nu12));
    let g23 = e3 / (2.0 * (1.0 + nu));
    let g31 = e3 / (2.0 * (1.0 + nu));
    let mut s = [[0.0; 6]; 6];
    s[0][0] = 1.0 / e1;
    s[1][1] = 1.0 / e2;
    s[2][2] = 1.0 / e3;
    s[0][1] = -nu21 / e2;
    s[1][0] = -nu12 / e1;
    s[0][2] = -nu31 / e3;
    s[2][0] = -nu13 / e1;
    s[1][2] = -nu32 / e3;
    s[2][1] = -nu23 / e2;
    s[3][3] = 1.0 / g12;
    s[4][4] = 1.0 / g23;
    s[5][5] = 1.0 / g31;
    invert6(&s).unwrap_or([[0.0; 6]; 6])
}

/// Orthotropic stiffness with one Poisson ratio and Huber's shear moduli.
fn orthotropic_huber(e1: f64, e2: f64, e3: f64, nu: f64) -> [[f64; 6]; 6] {
    let g = |a: f64, b: f64| (a * b).sqrt() / (2.0 * (1.0 + nu));
    let mut s = [[0.0; 6]; 6];
    s[0][0] = 1.0 / e1;
    s[1][1] = 1.0 / e2;
    s[2][2] = 1.0 / e3;
    s[0][1] = -nu / e1;
    s[1][0] = -nu / e1;
    s[0][2] = -nu / e1;
    s[2][0] = -nu / e1;
    s[1][2] = -nu / e2;
    s[2][1] = -nu / e2;
    s[3][3] = 1.0 / g(e1, e2);
    s[4][4] = 1.0 / g(e2, e3);
    s[5][5] = 1.0 / g(e1, e3);
    invert6(&s).unwrap_or([[0.0; 6]; 6])
}

fn tangent_global(c_local: &[[f64; 6]; 6], q: &[[f64; 3]; 3]) -> [[f64; 6]; 6] {
    let mut c = [[0.0; 6]; 6];
    for col in 0..6 {
        let mut strain = [0.0; 6];
        strain[col] = 1.0;
        let stress = apply_local(c_local, q, &strain);
        for row in 0..6 {
            c[row][col] = stress[row];
        }
    }
    c
}

fn apply_local(c_local: &[[f64; 6]; 6], q: &[[f64; 3]; 3], strain_g: &[f64; 6]) -> [f64; 6] {
    let local_strain = tensor_to_strain(&rotate_to(q, &strain_to_tensor(strain_g)));
    let mut local_stress = [0.0; 6];
    for i in 0..6 {
        for j in 0..6 {
            local_stress[i] += c_local[i][j] * local_strain[j];
        }
    }
    tensor_to_stress(&rotate_from(q, &stress_to_tensor(&local_stress)))
}

/// Engineering shear is twice the tensor shear.
fn strain_to_tensor(v: &[f64; 6]) -> [[f64; 3]; 3] {
    [
        [v[0], 0.5 * v[3], 0.5 * v[5]],
        [0.5 * v[3], v[1], 0.5 * v[4]],
        [0.5 * v[5], 0.5 * v[4], v[2]],
    ]
}

fn tensor_to_strain(t: &[[f64; 3]; 3]) -> [f64; 6] {
    [
        t[0][0],
        t[1][1],
        t[2][2],
        t[0][1] + t[1][0],
        t[1][2] + t[2][1],
        t[0][2] + t[2][0],
    ]
}

/// Voigt stress stores the tensor shear, not twice it.
fn stress_to_tensor(v: &[f64; 6]) -> [[f64; 3]; 3] {
    [[v[0], v[3], v[5]], [v[3], v[1], v[4]], [v[5], v[4], v[2]]]
}

fn tensor_to_stress(t: &[[f64; 3]; 3]) -> [f64; 6] {
    [
        t[0][0],
        t[1][1],
        t[2][2],
        0.5 * (t[0][1] + t[1][0]),
        0.5 * (t[1][2] + t[2][1]),
        0.5 * (t[0][2] + t[2][0]),
    ]
}

/// `Q * t * Qᵀ`, with `Q` stored as rows.
fn rotate_to(q: &[[f64; 3]; 3], t: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut qt = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                qt[i][j] += q[i][k] * t[k][j];
            }
        }
    }
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                out[i][j] += qt[i][k] * q[j][k];
            }
        }
    }
    out
}

/// `Qᵀ * t * Q`.
fn rotate_from(q: &[[f64; 3]; 3], t: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut tq = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                tq[i][j] += t[i][k] * q[k][j];
            }
        }
    }
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                out[i][j] += q[k][i] * tq[k][j];
            }
        }
    }
    out
}

pub fn invert6(m: &[[f64; 6]; 6]) -> Option<[[f64; 6]; 6]> {
    let mut a = [[0.0; 12]; 6];
    for i in 0..6 {
        for j in 0..6 {
            a[i][j] = m[i][j];
        }
        a[i][6 + i] = 1.0;
    }
    for col in 0..6 {
        let mut pivot = col;
        let mut best = a[col][col].abs();
        for row in col + 1..6 {
            let v = a[row][col].abs();
            if v > best {
                best = v;
                pivot = row;
            }
        }
        if best < 1e-18 {
            return None;
        }
        if pivot != col {
            a.swap(pivot, col);
        }
        let div = a[col][col];
        for j in 0..12 {
            a[col][j] /= div;
        }
        for row in 0..6 {
            if row == col {
                continue;
            }
            let f = a[row][col];
            if f == 0.0 {
                continue;
            }
            for j in 0..12 {
                a[row][j] -= f * a[col][j];
            }
        }
    }
    let mut inv = [[0.0; 6]; 6];
    for i in 0..6 {
        for j in 0..6 {
            inv[i][j] = a[i][6 + j];
        }
    }
    Some(inv)
}

pub fn compliance_of(c: &[[f64; 6]; 6]) -> [[f64; 6]; 6] {
    invert6(c).unwrap_or([[0.0; 6]; 6])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isotropic_limit_matches_lame() {
        let e = 1000.0;
        let nu = 0.25;
        let c = orthotropic_c(e, e, e, nu);
        let lambda = e * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
        let mu = e / (2.0 * (1.0 + nu));
        assert!((c[0][0] - (lambda + 2.0 * mu)).abs() < 1e-8);
        assert!((c[0][1] - lambda).abs() < 1e-8);
        assert!((c[3][3] - mu).abs() < 1e-8);
        assert!(c[0][3].abs() < 1e-10);
    }

    #[test]
    fn full_infill_keeps_the_across_layer_allowable() {
        let mat = LinearOrthotropic {
            e_in_plane_mpa: 1800.0,
            e_across_layers_mpa: 1500.0,
            nu: 0.35,
            strength_in_plane_mpa: 30.0,
            strength_across_layers_mpa: 15.0,
            compression_in_plane_mpa: 30.0,
            compression_across_layers_mpa: 15.0,
            shear_across_layers_mpa: 7.5,
            density_g_cm3: 1.27,
            isotropic: false,
        };
        let ctx = MaterialContext {
            build_axis: [0.0, 0.0, 1.0],
            temperature_c: None,
            fibre_axis: None,
            volume_fraction: 1.0,
            alignment: 0.5,
            bridge_share: 0.0,
        };
        let stress = Stress {
            v: [0.0, 0.0, 10.0, 0.0, 0.0, 0.0],
        };
        let sf = MaxStress.safety(&stress, &mat.allowables(), &ctx);
        assert!((sf - 1.5).abs() < 1e-9, "sf {sf}");
        let in_plane = Stress {
            v: [10.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        };
        let sf_x = MaxStress.safety(&in_plane, &mat.allowables(), &ctx);
        assert!((sf_x - 3.0).abs() < 1e-9, "sf_x {sf_x}");
    }

    #[test]
    fn isotropic_stress_does_not_depend_on_the_build_frame() {
        let mat = LinearOrthotropic::isotropic(1000.0, 0.25, 1.0);
        let strain = [0.01, 0.02, 0.015, -0.002, -0.001, 0.002];
        let expect = [26.0, 34.0, 30.0, -0.8, -0.4, 0.8];
        let ctx = MaterialContext {
            build_axis: [0.0, 0.0, 1.0],
            temperature_c: None,
            fibre_axis: None,
            volume_fraction: 1.0,
            alignment: 0.5,
            bridge_share: 0.0,
        };
        let (stress, tangent) = mat.stress_tangent(&strain, &mut MatState::default(), &ctx);
        for k in 0..6 {
            assert!(
                (stress.v[k] - expect[k]).abs() < 1e-8,
                "component {k}: {}",
                stress.v[k]
            );
            assert!(tangent.c[k][k] > 0.0, "diagonal {k} {}", tangent.c[k][k]);
        }
    }
}
