# Repair audit in the sheet

The cut already counts layers that closed a mesh gap and chains it could not close (`slice_with_stats` in `crates/lime-slice-core/src/index.rs`). The slice response carries those two counts on `mesh`. The sheet prints them under the triangle line.

This is not a second `slice --audit` pass. That pass measures volume, floating support, and unskinned tops. The sheet does not run it.

## Decisions

- The counts come from the cut the slice already does. `slice` returns the same loops as `slice_with_stats` and drops the stats, so G-code is unchanged.
- A clean mesh reports zeros. An older reply that omits the fields reads as zero.
- The line appears after a slice. Before a slice the triangle line stays as it was.
- A plate sums the counts across objects.
- The counts are not a `SliceSettings` field, so contour keys do not move and a cartesian request keeps its G-code.
- There is no interactive hole fill. Closing a gap is still the cut's existing weld, up to 1.25 mm.
