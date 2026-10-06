# Per-object infill, walls, and speed

An object can print with its own infill, wall count, or speed cap. Left out, the strategy's numbers stay, so a request that does not set them keeps its G-code and its disk cache key, including the cartesian lock in `crates/lime-slice-core/tests/cartesian_lock.rs`.

## Decisions

- `infill`, `walls`, and `speed` are object settings. A plate request that sets one of them on an object is no longer refused. Ranges and volumes stay plate-wide.
- On one object, the same keys may sit on the request itself. They are omitted when unset.
- Infill is 0 to 1. Walls are 1 to 12. Speed is above 0 and at most 1000 mm/s. A bad value names the field: `walls 0 is outside 1 to 12`. On a plate the error is `objects[0].settings: walls 0 is outside 1 to 12`.
- A height range or a modifier volume wins on each field it sets. The object's value fills the fields the range or volume leaves empty. Two caps do not stack: the winning field is applied once.
- The outline does not move, so contour and support keys blank the tweak. Toolpaths do not. Adding the field still changes those Debug keys once, including when it is empty.
- `classic` still honors the override. It does not clear it.

## Cache keys

The disk cache hashes the client JSON. Leaving the three fields out leaves the disk key unchanged.

In-memory stage keys hash `Debug` of `SliceSettings`. Adding `object_tweak` changes that text once. The contour and support copies set it back to empty, so turning walls on does not recut or regrow supports.

## UI

The object list has three fields, empty until set. Empty keeps the strategy. Infill is a percent on screen and a fraction on the request. A one-object plate with any of them set sends `objects`, which is the existing rule for an object that has its own settings.
