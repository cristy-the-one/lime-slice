# Sequential printing

`printOrder` is omitted for all-at-once, which is today's layer loop: on each layer the objects print in plate order. `sequential` finishes every layer of object 1, including its supports and its skirt, then starts object 2.

Left out, a request keeps its G-code and its disk cache key, including the cartesian lock in `crates/lime-slice-core/tests/cartesian_lock.rs`.

## Decisions

- `sequential` is opt-in. Omitted and `"all-at-once"` stay the current join.
- While the next object prints, the toolhead around the nozzle (heater block, fan duct, carriage) sweeps over the plate. Every finished object's mesh box must clear the next object's mesh box, on X and Y, by `sequentialClearanceMm`: how far the head reaches around the nozzle. The check is against every object already finished, not only the one before it. A miss is an error and no G-code.
- `sequentialClearanceMm` is sent only with `sequential`, from 0 to 100. `0` or omitted means 35 mm, a conservative toolhead. A set value replaces that, for a printer whose head is known to be smaller. Touching the expanded box is enough: a smaller gap is the error.
- The gantry passes over every finished object while the next one prints. Every object but the last must be no taller than `sequentialGantryMm`, the height from the nozzle tip to the gantry. `0` or omitted means 20 mm. A taller object that is not last is an error that names it.
- Between objects the nozzle retracts, climbs 2 mm above the tallest object already printed, travels to the next object's first point at that height, and only then goes down to its first layer. Going down first would drive it through the object it just finished.
- Each object's first layer gets the first-layer speed, flow and fan, as the plate's first layer does.
- The box is the mesh. The skirt is not in the box. Skirt overlap stays the existing collision warning.
- A belt printer refuses `sequential`: the belt advances once per layer, and starting the next object again at its first layer would run it backwards.
- One object, sequential or not, writes the same G-code. The preview token gains a sequential mark only when two or more objects print one at a time, so a switch of order is a whole preview and not a patch. All-at-once tokens stay the bytes they were.
- Print order is not a field of `SliceSettings`. It changes the join and the emit only, so contour and toolpath keys do not move. The disk key changes only when the client sends `printOrder`, `sequentialClearanceMm` or `sequentialGantryMm`.
- `classic` still honors sequential. It does not force all-at-once.
- `sequentialClearanceMm` or `sequentialGantryMm` without `sequential` is an error.

## UI

The object list shows the order when the plate has two or more objects. All at once is the default and is omitted from the request and from the settings hash. One at a time sends `printOrder: "sequential"`. The toolhead clearance and gantry height fields are empty for the defaults and are omitted at 0. A version 2 project remembers sequential, and omits it when the order is all at once, so an older file still opens.
