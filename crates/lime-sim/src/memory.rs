//! The memory this machine can spare for a solve.
//!
//! A study that names no `memoryMb` fits its first cell size to
//! [`crate::sliced_study::DEFAULT_MEMORY_MB`] so a default solve stays quick,
//! but its second cell size, which only judges trust, may use what the
//! machine has free. Asking the system is the one OS call in this crate.

/// The share of the free memory a second cell size may take. The rest is
/// left for the app, the slicer and the system.
const SPARE_SHARE: f64 = 0.75;

/// The memory a solve may take now, MB: three quarters of what the system
/// reports available. `None` where the system can't be asked.
pub fn spare_mb() -> Option<f64> {
    available_mb().map(|mb| mb * SPARE_SHARE)
}

#[cfg(windows)]
fn available_mb() -> Option<f64> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // SAFETY: `status` is a MEMORYSTATUSEX whose length field says its size,
    // as the call requires.
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    (ok != 0).then(|| status.avail_phys as f64 / (1024.0 * 1024.0))
}

#[cfg(target_os = "linux")]
fn available_mb() -> Option<f64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = info.lines().find(|l| l.starts_with("MemAvailable:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn available_mb() -> Option<f64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spare_memory_is_a_share_of_something_real() {
        // CI runners have at least a gigabyte free; a platform that can't be
        // asked says so with None rather than a guess.
        if let Some(mb) = spare_mb() {
            assert!(mb > 256.0 && mb.is_finite(), "{mb}");
        }
    }
}
