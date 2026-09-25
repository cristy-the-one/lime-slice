use std::sync::atomic::{AtomicBool, Ordering};

static FLAG: AtomicBool = AtomicBool::new(false);

pub fn reset() {
    FLAG.store(false, Ordering::Relaxed);
}

pub fn request() {
    FLAG.store(true, Ordering::Relaxed);
}

pub fn poll() -> bool {
    FLAG.load(Ordering::Relaxed)
}
