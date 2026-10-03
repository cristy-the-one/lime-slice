//! One slice's progress and cancel flag.
//!
//! `Watch::idle` is what a slice carries when nobody is watching. It allocates
//! nothing, and the cancel check is the existing [`Job`](crate::cancel::Job)
//! test. A live watch publishes a fraction that never moves backwards.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use serde::Serialize;

use crate::cancel::Job;

/// Stages in pipeline order. The budgets are a fixed split so `fraction` can
/// move before a client reweights the counts. They are not measured times.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Stage {
    Load = 0,
    /// Per-layer slice of the mesh.
    Cut = 1,
    /// The part's walls, infill, and skin.
    Part = 2,
    /// The part's tour.
    Travel = 3,
    Supports = 4,
    Assemble = 5,
    Emit = 6,
}

const WEIGHTS: [f64; 7] = [0.02, 0.08, 0.42, 0.10, 0.20, 0.10, 0.08];
const NO_CANCEL: u8 = 255;

impl Stage {
    pub const ALL: [Stage; 7] = [
        Stage::Load,
        Stage::Cut,
        Stage::Part,
        Stage::Travel,
        Stage::Supports,
        Stage::Assemble,
        Stage::Emit,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Stage::Load => "load",
            Stage::Cut => "cut",
            Stage::Part => "part",
            Stage::Travel => "travel",
            Stage::Supports => "supports",
            Stage::Assemble => "assemble",
            Stage::Emit => "emit",
        }
    }

    fn index(self) -> usize {
        self as u8 as usize
    }

    fn from_u8(value: u8) -> Self {
        Self::ALL
            .get(value as usize)
            .copied()
            .unwrap_or(Stage::Load)
    }
}

/// Where one slice is. `fraction` is monotonic for a single watch.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: &'static str,
    pub done: u32,
    pub total: u32,
    pub fraction: f64,
    #[serde(serialize_with = "status_str")]
    pub status: Status,
}

fn status_str<S: serde::Serializer>(status: &Status, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(status.as_str())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Running,
    Done,
    Cancelled,
    Error,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Running => "running",
            Status::Done => "done",
            Status::Cancelled => "cancelled",
            Status::Error => "error",
        }
    }

    /// How a slice that returned `result` ended.
    pub fn of<T>(result: &Result<T, String>) -> Status {
        match result {
            Ok(_) => Status::Done,
            Err(err) if err == "cancelled" => Status::Cancelled,
            Err(_) => Status::Error,
        }
    }
}

/// The budget position of `done` units out of `total` in `stage`.
pub fn fraction(stage: Stage, done: u32, total: u32) -> f64 {
    let index = stage.index();
    let base: f64 = WEIGHTS[..index].iter().sum();
    let span = WEIGHTS[index];
    let part = if total == 0 {
        0.0
    } else {
        f64::from(done.min(total)) / f64::from(total)
    };
    let value = base + span * part;
    if stage == Stage::Emit && total > 0 && done >= total {
        1.0
    } else {
        value.clamp(0.0, 1.0)
    }
}

struct Snap {
    stage: Stage,
    done: u32,
    total: u32,
    fraction: f64,
    status: Status,
    seq: u64,
    log: Vec<Progress>,
}

impl Snap {
    fn fresh() -> Self {
        Self {
            stage: Stage::Load,
            done: 0,
            total: 0,
            fraction: 0.0,
            status: Status::Running,
            seq: 0,
            log: Vec::new(),
        }
    }

    fn view(&self) -> Progress {
        Progress {
            stage: self.stage.name(),
            done: self.done,
            total: self.total,
            fraction: self.fraction,
            status: self.status,
        }
    }
}

struct Shared {
    cancel: AtomicBool,
    /// Cancel when this stage is entered. `NO_CANCEL` leaves the flag alone.
    cancel_on: AtomicU8,
    stage: AtomicU8,
    counter: AtomicU32,
    total: AtomicU32,
    state: Mutex<Snap>,
    changed: Condvar,
}

impl Shared {
    fn publish(&self, stage: Stage, done: u32, total: u32, terminal: Option<Status>) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if guard.status != Status::Running && terminal.is_none() {
            return;
        }
        let fraction = match terminal {
            Some(Status::Done) => 1.0,
            _ => fraction(stage, done, total),
        };
        if terminal.is_none() && fraction + 1e-12 < guard.fraction {
            return;
        }
        if terminal.is_none()
            && stage == guard.stage
            && done < guard.done
            && fraction <= guard.fraction + 1e-12
        {
            return;
        }
        guard.stage = stage;
        guard.done = done;
        guard.total = total;
        guard.fraction = fraction.max(guard.fraction);
        if let Some(status) = terminal {
            guard.status = status;
            if status == Status::Done {
                guard.fraction = 1.0;
                guard.done = guard.total.max(guard.done);
            }
        }
        guard.seq += 1;
        let progress = guard.view();
        guard.log.push(progress);
        drop(guard);
        self.changed.notify_all();
    }
}

/// Progress sink and cancel flag for one slice.
///
/// Idle watches allocate nothing. A live watch is an `Arc` shared with every
/// stage of that slice.
#[derive(Clone)]
pub struct Watch {
    shared: Option<Arc<Shared>>,
    /// When false, cancel still works and nothing is published. Baseline and
    /// compare use this so they cannot pull the fraction backwards.
    report: bool,
}

impl Default for Watch {
    fn default() -> Self {
        Self::idle()
    }
}

impl Watch {
    pub const fn idle() -> Self {
        Self {
            shared: None,
            report: false,
        }
    }

    pub fn new() -> Self {
        Self {
            shared: Some(Arc::new(Shared {
                cancel: AtomicBool::new(false),
                cancel_on: AtomicU8::new(NO_CANCEL),
                stage: AtomicU8::new(0),
                counter: AtomicU32::new(0),
                total: AtomicU32::new(0),
                state: Mutex::new(Snap::fresh()),
                changed: Condvar::new(),
            })),
            report: true,
        }
    }

    /// A live watch that cancels itself when `stage` is entered.
    pub fn cancel_on(stage: Stage) -> Self {
        let watch = Self::new();
        if let Some(shared) = &watch.shared {
            shared.cancel_on.store(stage as u8, Ordering::Relaxed);
        }
        watch
    }

    /// Same flag, and no progress. For the baseline and compare passes.
    pub fn silent(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            report: false,
        }
    }

    pub fn cancel(&self) {
        if let Some(shared) = &self.shared {
            shared.cancel.store(true, Ordering::Relaxed);
            shared.changed.notify_all();
        }
    }

    /// The per-slice flag. False when idle. Does not look at [`Job`].
    pub fn cancelled(&self) -> bool {
        self.shared
            .as_ref()
            .is_some_and(|shared| shared.cancel.load(Ordering::Relaxed))
    }

    pub fn stopped(&self, job: Job) -> bool {
        job.cancelled() || self.cancelled()
    }

    fn reports(&self) -> Option<&Shared> {
        self.shared.as_deref().filter(|_| self.report)
    }

    /// `total` units are about to run. Done starts at 0.
    pub fn begin(&self, stage: Stage, total: u32) {
        let Some(shared) = &self.shared else {
            return;
        };
        if shared.cancel_on.load(Ordering::Relaxed) == stage as u8 {
            shared.cancel.store(true, Ordering::Relaxed);
        }
        let Some(shared) = self.reports() else {
            return;
        };
        let total = total.max(1);
        shared.stage.store(stage as u8, Ordering::Relaxed);
        shared.total.store(total, Ordering::Relaxed);
        shared.counter.store(0, Ordering::Relaxed);
        shared.publish(stage, 0, total, None);
    }

    /// One unit of the stage `begin` opened has finished.
    pub fn tick(&self) {
        let Some(shared) = self.reports() else {
            return;
        };
        let stage = Stage::from_u8(shared.stage.load(Ordering::Relaxed));
        let total = shared.total.load(Ordering::Relaxed).max(1);
        let done = shared
            .counter
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1)
            .min(total);
        shared.publish(stage, done, total, None);
    }

    /// The current stage finished, whatever the counter says.
    pub fn fill(&self) {
        let Some(shared) = self.reports() else {
            return;
        };
        let stage = Stage::from_u8(shared.stage.load(Ordering::Relaxed));
        let total = shared.total.load(Ordering::Relaxed).max(1);
        shared.counter.store(total, Ordering::Relaxed);
        shared.publish(stage, total, total, None);
    }

    /// A stage that was reused rather than run. Counts as the whole budget.
    pub fn complete(&self, stage: Stage) {
        if self.reports().is_none() && self.shared.is_some() {
            // Silent, but `cancel_on` still has to trip.
            if let Some(shared) = &self.shared {
                if shared.cancel_on.load(Ordering::Relaxed) == stage as u8 {
                    shared.cancel.store(true, Ordering::Relaxed);
                }
            }
            return;
        }
        self.begin(stage, 1);
        if !self.cancelled() {
            self.tick();
        }
    }

    /// Publishes the terminal `status`. `Cancelled` also sets the flag.
    pub fn finish(&self, status: Status) {
        let Some(shared) = &self.shared else {
            return;
        };
        if status == Status::Cancelled {
            self.cancel();
        }
        let guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let stage = guard.stage;
        let done = guard.done;
        let total = guard.total;
        drop(guard);
        shared.publish(stage, done, total, Some(status));
    }

    pub fn snapshot(&self) -> Progress {
        let Some(shared) = &self.shared else {
            return Progress {
                stage: Stage::Load.name(),
                done: 0,
                total: 0,
                fraction: 0.0,
                status: Status::Running,
            };
        };
        shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .view()
    }

    pub fn events(&self) -> Vec<Progress> {
        let Some(shared) = &self.shared else {
            return Vec::new();
        };
        shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .log
            .clone()
    }

    /// The newest state, once something was published after `seq` and
    /// `not_before` has passed. A finished slice returns at once, so a
    /// follower always gets the terminal state. Intermediate states a slow
    /// follower missed are skipped. `seq` 0 waits for the first publish.
    pub fn latest_after(&self, seq: u64, not_before: Instant) -> (u64, Progress) {
        let Some(shared) = &self.shared else {
            return (0, self.snapshot());
        };
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let now = Instant::now();
            if guard.status != Status::Running || (guard.seq > seq && now >= not_before) {
                return (guard.seq, guard.view());
            }
            guard = if guard.seq > seq {
                shared
                    .changed
                    .wait_timeout(guard, not_before - now)
                    .unwrap_or_else(|e| e.into_inner())
                    .0
            } else {
                shared
                    .changed
                    .wait(guard)
                    .unwrap_or_else(|e| e.into_inner())
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn the_budget_reaches_one_and_never_steps_back() {
        let mut previous = 0.0;
        for stage in Stage::ALL {
            let total = 4;
            for done in 0..=total {
                let value = fraction(stage, done, total);
                assert!(
                    value + 1e-12 >= previous,
                    "{stage:?} {done}/{total} moved {previous} -> {value}"
                );
                assert!((0.0..=1.0).contains(&value));
                previous = value;
            }
        }
        assert!((previous - 1.0).abs() < 1e-12);
    }

    #[test]
    fn an_idle_watch_does_not_cancel_and_records_nothing() {
        let watch = Watch::idle();
        assert!(!watch.cancelled());
        assert!(!watch.stopped(Job::default()));
        watch.begin(Stage::Part, 10);
        watch.tick();
        watch.fill();
        watch.cancel();
        assert!(!watch.cancelled());
        assert!(watch.events().is_empty());
    }

    #[test]
    fn cancel_on_trips_when_that_stage_is_entered() {
        let watch = Watch::cancel_on(Stage::Supports);
        watch.begin(Stage::Part, 4);
        assert!(!watch.cancelled());
        watch.complete(Stage::Travel);
        assert!(!watch.cancelled());
        watch.begin(Stage::Supports, 4);
        assert!(watch.cancelled());
        let stages: Vec<_> = watch
            .events()
            .into_iter()
            .map(|event| event.stage)
            .collect();
        assert_eq!(stages.first().copied(), Some("part"));
        assert!(stages.contains(&"travel"));
        assert_eq!(stages.last().copied(), Some("supports"));
    }

    #[test]
    fn ticks_from_two_threads_stay_monotonic() {
        let watch = Watch::new();
        watch.begin(Stage::Part, 100);
        let left = watch.clone();
        let right = watch.clone();
        let a = thread::spawn(move || {
            for _ in 0..50 {
                left.tick();
            }
        });
        let b = thread::spawn(move || {
            for _ in 0..50 {
                right.tick();
            }
        });
        a.join().unwrap();
        b.join().unwrap();
        let mut previous = 0.0;
        let mut done = 0;
        for event in watch.events() {
            assert!(event.fraction + 1e-12 >= previous);
            if event.stage == "part" {
                assert!(event.done >= done);
                done = event.done;
            }
            previous = event.fraction;
        }
        assert_eq!(watch.snapshot().done, 100);
        assert_eq!(watch.snapshot().status, Status::Running);
        watch.finish(Status::Done);
        let end = watch.snapshot();
        assert_eq!(end.status, Status::Done);
        assert!((end.fraction - 1.0).abs() < 1e-12);
    }
}
