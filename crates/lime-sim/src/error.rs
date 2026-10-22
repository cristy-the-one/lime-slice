//! Sentences a caller can show. A refusal is one sentence.

use std::fmt;

/// A solve that did not produce a field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimError {
    pub message: String,
}

impl SimError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for SimError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SimError {}

pub fn not_held() -> SimError {
    SimError::new("This part is not held. Fix a face, or the bed.")
}

pub fn tet4_refused() -> SimError {
    SimError::new("This study uses quadratic tetrahedra. Linear tetrahedra lock in bending.")
}

pub fn temperature_refused() -> SimError {
    SimError::new("Temperature is not in this version.")
}

pub fn modal_refused() -> SimError {
    SimError::new("Modal analysis is not in this version.")
}

pub fn bead_refused() -> SimError {
    SimError::new("A bead-by-bead model is not in this version.")
}

pub fn open_mesh() -> SimError {
    SimError::new("This mesh is open, so it has no interior to mesh.")
}

pub fn node_cap(nodes: usize) -> SimError {
    SimError::new(format!(
        "This mesh has {nodes} nodes. Raise the edge length, or the cap."
    ))
}

pub fn zero_axis() -> SimError {
    SimError::new("The build direction has zero length.")
}
