# Sequential printing

`printOrder` is omitted for all-at-once, which is today's layer loop: on each layer the objects print in plate order. `sequential` finishes every layer of object 1, including its supports and its skirt, then starts object 2.

Left out, a request keeps its G-code and its disk cache key, including the cartesian lock in `crates/lime-slice-core/tests/cartesian_lock.rs`.

## Decisions

- `sequential` is opt-in. Omitted and `"all-at-once"` stay the current join.
- The nozzle must clear every finished object's mesh box, on X and Y, by `sequentialClearanceMm` for the whole of the next object's mesh box. The check is against every object already finished, not only the one before it. A miss is an error and no G-code.
- `sequentialClearanceMm` is sent only with `sequential`. `0` or omitted means the nozzle radius plus one line width. A set value replaces that. Touching the expanded box is enough: a smaller gap is the error.
- The box is the mesh, in the frame the nozzle travels. On a belt that is the nozzle plane after the plate is laid flat. The skirt is not in the box. Skirt overlap stays the existing collision warning.
- One object, sequential or not, writes the same G-code. The preview token gains a sequential mark only when two or more objects print one at a time, so a switch of order is a whole preview and not a patch. All-at-once tokens stay the bytes they were.
- Print order is not a field of `SliceSettings`. It changes the join and the emit only, so contour and toolpath keys do not move. The disk key changes only when the client sends `printOrder` or `sequentialClearanceMm`.
- `classic` still honors sequential. It does not force all-at-once.
- `sequentialClearanceMm` without `sequential` is an error.

## UI

The object list shows the order when the plate has two or more objects. All at once is the default and is omitted from the request and from the settings hash. One at a time sends `printOrder: "sequential"`. The clearance field is empty for the automatic gap and is omitted at 0. A version 2 project remembers sequential, and omits it when the order is all at once, so an older file still opens.
