//! Read the optional thumbnail and summary at the front of a `.lime` file.
//!
//! The picture is shown only when a finished scan's geometry hash matches
//! `meshHash`. A bad file, a truncated file, or a scan that runs out of time
//! yields no picture. Mesh bytes are never copied out of the file.

mod hash;
mod number;
mod scan;

pub use scan::{read_preview, Preview, Summary, Thumbnail};

use std::time::Duration;

/// Half a second, the budget the shell handler uses so a hostile file cannot stick the host.
pub const READ_BUDGET: Duration = Duration::from_millis(500);

/// Read `bytes` with [`READ_BUDGET`]. Never panics.
pub fn preview(bytes: &[u8]) -> Preview {
    read_preview(bytes, READ_BUDGET)
}
