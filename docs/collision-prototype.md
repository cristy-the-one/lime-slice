# Gear collision prototype

External spur gears on parallel axes. `lime_recipe::gear_pair::classify` takes two `Gear`s, their centres in the plane, and each tooth-0 phase. `driven_turn` turns the driver by an angle and the driven gear by `mate_turn` before that check. It is not a joint in the assembly pose: the joint is the gear coupling (`docs/plan-gear-coupling.md`, `src/gear-train.ts`), which uses this check to find the pairs and, turned through sampled angles, to judge the train, never to move it. Couple gears also uses it to decide which gears get a hinge of their own (`prepareTrain`, `docs/plan-gear-kinds.md`): only gears it calls `meshing` with a gear of another part.

The check is tip circles, then module and pressure angle, then the working centre distance and the mating phase with a segment test on `Gear::points`. Only the edges of each outline that come inside the other gear's tip circle are compared, which is the few teeth that face each other. `Region::intersect` is not used. The gear card shows the verdict against the gear this one meshes with, or the nearest gear it reaches; a gear that reaches no other shows no line. `model_check` lists the same pairs in `gears`. Two gears of one solid are not a pair: fused into one body they cannot turn against each other, and two on one axis (a compound gear) would read as too close. The Open CASCADE common-volume check is unchanged.

Verdicts: `apart`, `meshing`, `tooClose`, `loose`, `toothOnTooth`, `unbuildable`, `moduleMismatch`, `pressureMismatch`.

Gears whose tip circles do not meet are `apart`, whatever they are: two stages of a train with different modules are not a fault. A module or pressure-angle mismatch is reported only for gears that reach each other.

The radial band is both backlashes either side of the working distance, the same edge on both sides: `distance < working - (b1 + b2)` is `tooClose`, and `distance > working + (b1 + b2)` is `loose` when no edge crosses. The edge itself stays in the band (12 and 24 teeth of module 2 at 36.2 mm still mesh). A segment that crosses is `toothOnTooth` at any distance. Inside the band, play along the pitch circle, one way from the centred mesh, is half the sum of the two backlashes plus `(distance - working) * tan(pressure)`: a wider centre adds play and a closer one takes it away, and at the working distance, with the usual 0.1 mm a tooth, that is 0.1 mm each way. A turn past that play is `toothOnTooth` too, because the flanks touch there before two chords of the outline cross. Past the band only the outlines decide: the teeth are narrower where they overlap, so there is more room than the pitch-circle play says (12 and 24 teeth of module 2 at 39 mm, a fifth of a tooth out of phase, cross nothing and are `loose`). A phase error is folded into half a tooth, because a gear looks the same turned by one tooth and `mate_phase` jumps by one tooth when its fraction wraps, while `mate_turn` does not.

The window's copy (`src/gear-pair.ts`) also gives the centre distance and the working distance of a pair whose outlines were compared: the card says "Too far from Wheel: centres 37 mm apart, they mesh at 36 mm.", and a `model_check` row carries `distanceMm` and `workingMm`. A gear lying the other way up (its axis opposite) is the same check, since a spur tooth is the same on both sides of its centre line. `mcp/recipe-gears.test.ts` holds the window's copy to the crate's verdicts on the same poses. An outline `Gear` cannot build is `unbuildable` and `narrow` is false. The card names `Gear::refusal` when it has that sentence. Gears inside a pattern or a queued batch are gears: those steps sit in a group's `steps`.

## A pinion inside a ring

`gears::Ring` is an internal spur gear (`docs/plan-gear-kinds.md`, stage 2). Its space between two teeth is the external tooth of the same numbers: involute flanks from the tip circle `r - m` inside out to the root circle `r + 1.25 m`, `backlash` wider at the pitch circle, a radial line below the base circle, no profile shift. `gear_pair::classify_internal` (and `classifyInternal` in the window's copy, held to the same verdicts by `mcp/recipe-gears.test.ts`, built by lust 0.3.1 and by rustc) checks a pinion inside a ring: apart when the pinion's tips do not reach the ring's tips (or it stands outside the ring), the module and pressure angle, then the working distance `m (z_ring - z_pinion) / 2`. A pinion pushed out into the ring's teeth past both backlashes is `tooClose`, one held in is `loose`. The mating phase is `mate_phase_internal`: the two turn the same way, so a pinion tooth a fraction of a pitch behind the pitch point meets a space as far behind it. The segment test compares the pinion's edges that reach past the ring's tip circle with the ring's edges inside the pinion's tip circle.

The kernel's ring is the rim's disc with that toothed hole, one extrude of loops. Against it, by exact common volume, a pinion at the mating phase shares nothing, turned through a whole pitch with the ring by `ring_turn` it shares nothing, and turned 0.2 mm past the play it crosses (`crates/lime-model-occt/tests/gear.rs`). A small pinion has less play inside a ring than the backlashes give: 12 teeth in 36 first touch at 0.055 mm of the 0.1 mm each way, because the ring's tip corner meets the pinion's undercut root before the involutes do (the ring's tip circle, 17 mm, is inside the interference point at `sqrt(rb^2 + (a sin a)^2)` = 17.4 mm). The mesh is still sound as it turns; the play is what is smaller.

## Where lust fails

lust 0.3.1 (`tools/lust/LUST_VERSION`, build 63310d1d). `gear_pair` itself builds with `lust build --sandbox --json` and prints the same verdicts as rustc (`mcp/recipe-gears.test.ts`). The rejections below were reproduced with that command while writing the check. Each one is a one-line program. The workaround is what the classifier does instead.

### L9001, variable-bound `f64::clamp`

```rust
fn main() {
    let (x, lo, hi) = (0.2_f64, 0.0_f64, 1.0_f64);
    let _ = x.clamp(lo, hi);
}
```

`L9001`: `` `clamp` on a float with bounds that are not float literals ``. The note says to write literal bounds, or `x.max(lo).min(hi)`. Fixed on lust-lang `next` by PR #44, not in 0.3.1.

The classifier does not call `clamp`. A value is held in range with `if` comparisons, the same shape as `geom2d::clamp`. `.min` and `.max` are used where a bound is another value (segment boxes, the rack's tip radius).

### L0104, `f64::total_cmp`, `midpoint`, `rem_euclid`, `div_euclid`

```rust
fn main() { let _ = 1.0_f64.total_cmp(&2.0); }
fn main() { let _ = 0.0_f64.midpoint(1.0); }
fn main() { let _ = (-1.5_f64).rem_euclid(1.0); }
fn main() { let _ = (-1.5_f64).div_euclid(1.0); }
```

`L0104`: `no method `total_cmp` on type `f64`` (and the same for `midpoint`, `rem_euclid`, `div_euclid`). The note lists the float methods lust does have. `rem_euclid` on an integer is a different method: `geom2d` already uses it on `i64`, and this crate still builds.

Phase error is folded with `%` and a comparison, not `rem_euclid`. `%` truncates toward zero, so a negative remainder is put back by hand in `tooth_err_deg`. Ordering uses `<`, not `total_cmp`.

### L0702, `dyn Iterator`

```rust
fn main() {
    let v = vec![1, 2];
    let it: &mut dyn Iterator<Item = i32> = &mut v.into_iter();
    let _ = it.next();
}
```

`L0702`: `` `dyn Iterator` (a std trait) is not supported yet ``. The note says to use a trait defined in the crate, or generics.

The segment test is `for` loops over `Vec`s. It does not type-erase an iterator.

### L0404, `unsafe`

```rust
fn main() {
    let x = 1;
    let _ = unsafe { *(&x as *const i32) };
}
```

`L0404`: `` `unsafe` is not supported ``.

The classifier is safe Rust. The grid index is a `usize` into a `Vec`, checked by clamping the cell, not a pointer.

### HashMap iteration order

Not a compile error. A `HashMap` walks in a different order under lust and rustc, so anything that prints or folds map entries can disagree. The narrow phase does not use a `HashMap`. Segments sit in a `Vec` of grid cells, and the result is whether any pair crosses, which does not depend on walk order.

A one-file program that only prints a `HashMap` produced no `lust build` output outside the recipe host in this session, so that order difference was not re-measured here. The recipe that calls `classify` was measured: lust and rustc returned the same string.

## Choices left open

- Axes more than a degree off parallel are left out of the card and of `model_check`. The check is for external spur gears on parallel axes.
- The card and `model_check` give no phase to turn to when teeth cross. `mate_phase` has it.
- The segment test uses 8 steps along each fillet and each flank. At the working distance and the usual backlash, ±0.06 mm along the pitch circle does not cross and ±0.16 mm is `toothOnTooth` because it is past the 0.1 mm of play. The same 0.16 mm at 36.2 mm, the far edge of the radial band, does not cross. At 39.9 mm the centres are past that band, so the verdict is `loose`.
