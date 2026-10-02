//! Support edits as the request carries them, and edit outcomes as the
//! response reports them.

use serde::{Deserialize, Serialize};

use crate::adaptive::LayerBand;
use crate::support::edit::{EditOutcome, EditStatus, SupportEdit, TipSite};
use crate::support::CoverageGap;

/// One support edit on the wire. `kind` picks the variant.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SupportEditSpec {
    /// Remove the limbs born at `sites`.
    Prune { sites: Vec<SiteSpec> },
    /// Grow fresh limbs for the unheld demand inside `region`, on the
    /// layers whose z lies within `z`, low then high.
    Regrow {
        region: Vec<Vec<[f64; 2]>>,
        z: [f64; 2],
    },
}

/// A birth site: xy in mm at the band z the skeleton reported.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SiteSpec {
    pub xy: [f64; 2],
    pub z: f64,
}

const MAX_EDITS: usize = 1000;
const MAX_SITES: usize = 200_000;
const MAX_REGION_POINTS: usize = 100_000;
const MAX_MM: f64 = 100_000.0;

/// Checks every edit and turns it into the engine's form. The error names
/// the edit, as `supportEdits[1]: a prune needs at least one site`.
pub(crate) fn parse_support_edits(specs: &[SupportEditSpec]) -> Result<Vec<SupportEdit>, String> {
    if specs.len() > MAX_EDITS {
        return Err(format!(
            "supportEdits: {} edits, at most {MAX_EDITS} are allowed",
            specs.len()
        ));
    }
    let (mut sites, mut points) = (0usize, 0usize);
    specs
        .iter()
        .enumerate()
        .map(|(n, spec)| {
            parse_one(spec, &mut sites, &mut points).map_err(|e| format!("supportEdits[{n}]: {e}"))
        })
        .collect()
}

fn parse_one(
    spec: &SupportEditSpec,
    sites: &mut usize,
    points: &mut usize,
) -> Result<SupportEdit, String> {
    match spec {
        SupportEditSpec::Prune { sites: specs } => {
            if specs.is_empty() {
                return Err("a prune needs at least one site".into());
            }
            *sites += specs.len();
            if *sites > MAX_SITES {
                return Err(format!("more than {MAX_SITES} sites across all edits"));
            }
            specs
                .iter()
                .map(|s| {
                    finite(s.xy[0], "site x")?;
                    finite(s.xy[1], "site y")?;
                    finite(s.z, "site z")?;
                    Ok(TipSite { xy: s.xy, z: s.z })
                })
                .collect::<Result<_, String>>()
                .map(|sites| SupportEdit::Prune { sites })
        }
        SupportEditSpec::Regrow { region, z } => {
            if region.is_empty() {
                return Err("a regrow needs at least one region loop".into());
            }
            for (l, lp) in region.iter().enumerate() {
                if lp.len() < 3 {
                    return Err(format!(
                        "region loop {l} has {} points, at least 3 are needed",
                        lp.len()
                    ));
                }
                for p in lp {
                    finite(p[0], "region x")?;
                    finite(p[1], "region y")?;
                }
            }
            *points += region.iter().map(Vec::len).sum::<usize>();
            if *points > MAX_REGION_POINTS {
                return Err(format!(
                    "more than {MAX_REGION_POINTS} region points across all edits"
                ));
            }
            finite(z[0], "z low")?;
            finite(z[1], "z high")?;
            if z[0] > z[1] {
                return Err(format!(
                    "z range {} to {} has its low end above its high end",
                    z[0], z[1]
                ));
            }
            Ok(SupportEdit::Regrow {
                region: region.clone(),
                z: *z,
            })
        }
    }
}

fn finite(v: f64, what: &str) -> Result<(), String> {
    if v.is_finite() && v.abs() <= MAX_MM {
        Ok(())
    } else {
        Err(format!(
            "{what} {v} is not a finite coordinate within {MAX_MM} mm"
        ))
    }
}

/// What one edit did, as the response reports it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcomeView {
    #[serde(flatten)]
    pub status: EditStatus,
    /// Layers whose printed support changed.
    pub changed_layers: usize,
    /// Lowest and highest changed layer, as `PreviewLayer.index` numbers them. Absent when none changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_span: Option<[usize; 2]>,
    /// Coverage area after the edit less the area before it, mm².
    pub newly_floating_mm2: f64,
    /// Coverage gaps the edit leaves, specks included.
    pub floating: Vec<CoverageGap>,
}

impl EditOutcomeView {
    pub(crate) fn of(outcome: &EditOutcome, bands: &[LayerBand]) -> Self {
        let span = outcome
            .changed
            .first()
            .zip(outcome.changed.last())
            .map(|(&lo, &hi)| [bands[lo].index, bands[hi].index]);
        Self {
            status: outcome.status,
            changed_layers: outcome.changed.len(),
            changed_span: span,
            newly_floating_mm2: outcome.newly_floating_mm2,
            floating: outcome.floating.clone(),
        }
    }
}
