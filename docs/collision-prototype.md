# Gear collision prototype

External spur gears on parallel axes. `lime_recipe::gear_pair::classify` takes two `Gear`s, their centres in the plane, and each tooth-0 phase. `driven_turn` turns the driver by an angle and the driven gear by `mate_turn` before that check. It is not a joint in the assembly pose.

The check is tip circles, then the working centre distance and the mating phase, then a segment test on `Gear::points` when the tip circles meet. `Region::intersect` is not used. The gear card shows the verdict against the gear this one meshes with, or the nearest other gear. `model_check` lists the same pairs in `gears`. The Open CASCADE common-volume check is unchanged.

Verdicts: `apart`, `meshing`, `tooClose`, `toothOnTooth`, `moduleMismatch`, `pressureMismatch`.

Play along the pitch circle is half the sum of the two backlashes, one way from the centred mesh (0.1 mm each way at the usual 0.1 mm a tooth). Centres closer than the working distance by more than that sum are `tooClose`. A phase error is folded into half a tooth, because a gear looks the same turned by one tooth and `mate_phase` jumps by one tooth when its fraction wraps, while `mate_turn` does not.

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

- Centres farther than the working distance by more than both backlashes, while the tip circles still meet and no edges cross, are `meshing`. Only the close side of that band is `tooClose`.
- A module or pressure-angle mismatch is reported even when the gears are far apart.
- Axes more than a degree apart, or pointing opposite ways, are left out of the card and of `model_check`. The check is for external spur gears whose axes point the same way.
- The segment test uses 8 steps along each fillet and each flank. At the usual backlash, ±0.06 mm along the pitch circle does not cross and ±0.16 mm is `toothOnTooth` because it is past the play, whether or not a segment also hits.
