//! Optional inner-loop clocks for the release profile harness.
//!
//! Off unless `set_enabled(true)`. Each sample is one `Instant` around a whole
//! call, not inside the tight loop.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static ON: AtomicBool = AtomicBool::new(false);

struct Slot {
    ns: AtomicU64,
    calls: AtomicU64,
    extra: AtomicU64,
}

impl Slot {
    const fn new() -> Self {
        Self {
            ns: AtomicU64::new(0),
            calls: AtomicU64::new(0),
            extra: AtomicU64::new(0),
        }
    }

    fn add(&self, ns: u64, extra: u64) {
        self.ns.fetch_add(ns, Ordering::Relaxed);
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.extra.fetch_add(extra, Ordering::Relaxed);
    }

    fn reset(&self) {
        self.ns.store(0, Ordering::Relaxed);
        self.calls.store(0, Ordering::Relaxed);
        self.extra.store(0, Ordering::Relaxed);
    }
}

static SOLID: Slot = Slot::new();
static LINES: Slot = Slot::new();
static GRID: Slot = Slot::new();
static GYROID: Slot = Slot::new();
static LIGHTNING: Slot = Slot::new();
static LIGHTNING_SEED: Slot = Slot::new();
static LIGHTNING_NN: Slot = Slot::new();
static LIGHTNING_LINK: Slot = Slot::new();
static ORDER_INFILL: Slot = Slot::new();
static ORDER_NEAREST: Slot = Slot::new();
static ORDER_LEGACY: Slot = Slot::new();
static ORDER_ISLANDS: Slot = Slot::new();
static ORDER_REST: Slot = Slot::new();
static VOID_FILL: Slot = Slot::new();
static VOID_COVER: Slot = Slot::new();
static VOID_BOOL: Slot = Slot::new();
static VOID_ISLAND: Slot = Slot::new();
static VOID_NARROW: Slot = Slot::new();
static VOID_SKIN: Slot = Slot::new();
static CHAIN: Slot = Slot::new();

pub fn set_enabled(on: bool) {
    ON.store(on, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ON.load(Ordering::Relaxed)
}

pub fn reset() {
    for slot in [
        &SOLID,
        &LINES,
        &GRID,
        &GYROID,
        &LIGHTNING,
        &LIGHTNING_SEED,
        &LIGHTNING_NN,
        &LIGHTNING_LINK,
        &ORDER_INFILL,
        &ORDER_NEAREST,
        &ORDER_LEGACY,
        &ORDER_ISLANDS,
        &ORDER_REST,
        &VOID_FILL,
        &VOID_COVER,
        &VOID_BOOL,
        &VOID_ISLAND,
        &VOID_NARROW,
        &VOID_SKIN,
        &CHAIN,
    ] {
        slot.reset();
    }
}

pub fn report() -> String {
    fn line(name: &str, slot: &Slot) -> String {
        let ns = slot.ns.load(Ordering::Relaxed);
        let calls = slot.calls.load(Ordering::Relaxed);
        let extra = slot.extra.load(Ordering::Relaxed);
        format!(
            "{name} {:.2} ms ({calls} calls, extra {extra})",
            ns as f64 / 1e6
        )
    }
    [
        line("solid", &SOLID),
        line("lines", &LINES),
        line("grid", &GRID),
        line("gyroid", &GYROID),
        line("lightning", &LIGHTNING),
        line("  lightning seed", &LIGHTNING_SEED),
        line("  lightning nn", &LIGHTNING_NN),
        line("  lightning link", &LIGHTNING_LINK),
        line("chain", &CHAIN),
        line("order infill", &ORDER_INFILL),
        line("  order legacy nn", &ORDER_LEGACY),
        line("  order islands", &ORDER_ISLANDS),
        line("  order rest", &ORDER_REST),
        line("order nearest", &ORDER_NEAREST),
        line("void fill", &VOID_FILL),
        line("  void cover", &VOID_COVER),
        line("  void bool", &VOID_BOOL),
        line("  void islands", &VOID_ISLAND),
        line("  void narrow", &VOID_NARROW),
        line("  void skin", &VOID_SKIN),
    ]
    .join("  ")
}

pub struct Sample {
    start: Option<std::time::Instant>,
}

impl Sample {
    pub fn start() -> Self {
        Self {
            start: enabled().then(std::time::Instant::now),
        }
    }

    fn finish(self, slot: &Slot, extra: u64) {
        if let Some(start) = self.start {
            slot.add(start.elapsed().as_nanos() as u64, extra);
        }
    }

    pub fn solid(self) {
        self.finish(&SOLID, 0);
    }
    pub fn lines(self) {
        self.finish(&LINES, 0);
    }
    pub fn grid(self) {
        self.finish(&GRID, 0);
    }
    pub fn gyroid(self) {
        self.finish(&GYROID, 0);
    }
    pub fn lightning(self) {
        self.finish(&LIGHTNING, 0);
    }
    pub fn lightning_seed(self, nodes: u64) {
        self.finish(&LIGHTNING_SEED, nodes);
    }
    pub fn lightning_nn(self, nodes: u64) {
        self.finish(&LIGHTNING_NN, nodes);
    }
    pub fn lightning_link(self) {
        self.finish(&LIGHTNING_LINK, 0);
    }
    pub fn order_infill(self, paths: u64) {
        self.finish(&ORDER_INFILL, paths);
    }
    pub fn order_nearest(self, paths: u64) {
        self.finish(&ORDER_NEAREST, paths);
    }
    pub fn order_legacy(self, paths: u64) {
        self.finish(&ORDER_LEGACY, paths);
    }
    pub fn order_islands(self, paths: u64) {
        self.finish(&ORDER_ISLANDS, paths);
    }
    pub fn order_rest(self, paths: u64) {
        self.finish(&ORDER_REST, paths);
    }
    pub fn void_fill(self) {
        self.finish(&VOID_FILL, 0);
    }
    pub fn void_cover(self, paths: u64) {
        self.finish(&VOID_COVER, paths);
    }
    pub fn void_bool(self) {
        self.finish(&VOID_BOOL, 0);
    }
    pub fn void_island(self) {
        self.finish(&VOID_ISLAND, 0);
    }
    pub fn void_narrow(self) {
        self.finish(&VOID_NARROW, 0);
    }
    pub fn void_skin(self) {
        self.finish(&VOID_SKIN, 0);
    }
    pub fn chain(self, segs: u64) {
        self.finish(&CHAIN, segs);
    }
}
