use std::sync::atomic::{AtomicU64, Ordering};

static LATEST: AtomicU64 = AtomicU64::new(0);

/// One slice started by a shell. Starting a newer job, or `cancel_all`, makes
/// it stale, and the planner stops at its next check. The default job belongs
/// to nobody and never goes stale, so tests and the CLI run to completion.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Job(u64);

impl Job {
    /// Supersede every running job with this one.
    pub fn start() -> Self {
        Job(LATEST.fetch_add(1, Ordering::SeqCst) + 1)
    }

    pub fn cancelled(self) -> bool {
        self.0 != 0 && LATEST.load(Ordering::Relaxed) != self.0
    }
}

pub fn cancel_all() {
    LATEST.fetch_add(1, Ordering::SeqCst);
}
