# Fuzzy skin

A sideways noise on the outer walls. It is off unless the request carries `fuzzySkin`. A slice that omits the field keeps the G-code it had before, including the cartesian lock in `crates/lime-slice-core/tests/cartesian_lock.rs`.

## Decisions

- One setting for the plate. An object that sets `fuzzySkin` is refused, the same way ironing is.
- `classic` forces it off, with the other later features.
- Only an outer wall is moved. Inner walls, infill, tops, and supports stay. The offset runs after the seam is chosen and after a scarf ramp, so the seam stays on the corner it had, and a scarf is left alone: it already stores a height and a flow on each point.
- The first point and the last point of a wall stay where they were, so a closed loop still meets.
- The offset is the left normal of the wall times a noise in [-1, 1] times the thickness. The noise is `sin` of the point and the layer Z, folded into [0, 1) with `floor`, so a negative sine cannot push past one thickness. The same point on the same layer always moves the same way.
- A wall shorter than 1.5 times the point spacing is left straight. There is nowhere to put a sample.
- Thickness is above 0 and at most 1 mm. Point spacing is from 0.1 to 5 mm. The defaults are 0.3 mm and 0.8 mm.
- Contour keys ignore it, because the cut does not move. Toolpath keys keep it, so turning it on replans the walls. Ironing stays blanked on the per-layer key; fuzzy skin does not, because every layer's outer wall changes.

## Cache keys

The disk cache hashes the client JSON. Leaving `fuzzySkin` out of that JSON leaves the disk key unchanged. `null` is a different JSON object, so a client that sends `null` instead of omitting the field gets a different disk key and the same G-code.

In-memory stage keys hash `Debug` of `SliceSettings`. Adding `fuzzy_skin: Option<FuzzySkin>` changes that text once, including when the value is `None`. That is process memory. It does not change a stored request or a cartesian file.

## Wire

`fuzzySkin` is omitted when off. `{}` is on at the defaults. `thickness` and `pointDistance` are optional numbers. Any other key is refused by name.

The G-code header gains `; fuzzy skin 0.3 mm / 0.8 mm` when it is on.

## UI

A checkbox in the Strength group, advanced, off by default. Thickness and point spacing show only while it is on, with 0.05 mm and 0.1 mm steps. Off, the slice body does not carry the field, and editing the numbers does not mark the slice stale.
