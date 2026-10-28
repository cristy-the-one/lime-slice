#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// A long-running app slices again and again; on the Windows heap each warm
/// slice got slower. mimalloc keeps it as fast as the first.
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    lime_slice_desktop_lib::run();
}
