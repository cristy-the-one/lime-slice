//! One function maps a finished solve onto rough, usable, or converged.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustLevel {
    Rough,
    Usable,
    Converged,
}

impl TrustLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rough => "rough",
            Self::Usable => "usable",
            Self::Converged => "converged",
        }
    }
}

#[derive(Clone, Debug)]
pub struct TrustInput<'a> {
    pub provisional: bool,
    pub tet4: bool,
    pub relative_energy_error: Option<f64>,
    pub rigid_failed: bool,
    pub estimator_ran: bool,
    pub pattern_unmeasured: bool,
    pub has_infill_core: bool,
    pub notes: &'a [String],
}

pub fn level_of(input: &TrustInput<'_>) -> TrustLevel {
    let err = input.relative_energy_error.filter(|e| e.is_finite());
    let err_rough = err.map(|e| e > 0.15).unwrap_or(true);
    if input.provisional
        || input.tet4
        || input.rigid_failed
        || !input.estimator_ran
        || err.is_none()
        || err_rough
    {
        return TrustLevel::Rough;
    }
    let err = err.unwrap_or(1.0);
    let capped = input.pattern_unmeasured && input.has_infill_core;
    if capped || err > 0.05 {
        TrustLevel::Usable
    } else {
        TrustLevel::Converged
    }
}

/// A limit that the number meets is still not met while the result is rough.
///
/// A provisional card says so. Otherwise a rough pass names the error estimate.
pub fn constraint_met(
    level: TrustLevel,
    inside: bool,
    relative_energy_error: f64,
    provisional: bool,
) -> (bool, String) {
    if !inside {
        return (false, "Outside the limit.".into());
    }
    if level == TrustLevel::Rough {
        if provisional {
            return (false, "Provisional card, not a measurement.".into());
        }
        let pct = (relative_energy_error * 100.0).round() as i64;
        return (
            false,
            format!("The error estimate is {pct}%, which is only a rough result."),
        );
    }
    (true, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rough_pass_names_the_error() {
        let (met, reason) = constraint_met(TrustLevel::Rough, true, 0.22, false);
        assert!(!met);
        assert_eq!(
            reason,
            "The error estimate is 22%, which is only a rough result."
        );
        let (met, reason) = constraint_met(TrustLevel::Rough, true, 0.01, true);
        assert!(!met);
        assert_eq!(reason, "Provisional card, not a measurement.");
    }
}
