# Supports on the belt floor

A belt slice forces supports off unless the request sends `belt.floorSupports: true`. Omitted, the flag is absent, and a belt that asked for supports still prints none. The cartesian lock is unchanged.

The planner runs after the plate is rotated so the nozzle plane is horizontal. In that frame the belt is the plane `z = (y + yShift) * tan(angle) - zDrop`, from the same shift `lay_flat` stored on the frame. Printable material on a layer is `y` at or below that plane. Supports that would step through it land on it.

## Decisions

- The flag is opt-in and omitted when off. Honoring `supports: true` on a belt without it would emit horizontal supports onto a bed the printer does not have, and would change existing belt G-code.
- With the flag, the belt frame starts at the plane that meets the belt under the plate's upstream edge, lowered in whole layer steps so the part is cut on the same planes. Starting at the first plane that meets the part left the planes between the belt and an overhang unsliced, so trunks ended mid-air where the part's first layer cut them. Layers before the lowest foot print nothing and are dropped; belt positions count from the first printed layer (`Belt::start`).
- With the flag, trunks and grid columns grow along gravity, which is normal to the belt. Each layer they fall moves them `height * tan(angle)` toward the belt in slice Y, so they stand plumb in the lab. Which surfaces need support is still judged in the slice frame.
- With the flag, tree and grid supports are clipped to the half-plane. A trunk thickens where the belt is under its centre on the next layer, the way a trunk thickens on layer 0, and stops once its whole disk is past the belt. A disk that crosses the plane becomes the largest circle on the printable side that keeps its upstream edge, so the slanted foot stands on the layer above it.
- The plane is not a field of `SliceSettings`. It is mixed into the support grow and paint keys only when the flag is on, so a cartesian key keeps its bytes. Contour keys do not move.
- A raft and floor supports together are refused. Floor supports grow down to the belt, through the pad, and nothing yet decides whether they should stand on the pad instead.
- Support edits and support paint stay refused. A disk is still in the part frame, and the planner is in the rotated frame. Seam paint stays refused for the same reason.
- Compare stays refused on a belt.
- `classic` still grows floor supports when the flag is on. It does not force them off.

## UI

There is no separate checkbox. On a belt printer, Smart supports sends `floorSupports: true`, because the belt is the only floor supports can stand on. Unticked, the request omits it. Smart supports and the belt raft lock each other: while one is on, the other is disabled with a hint; a raft that is already on stays untickable. A `floorSupports` field in an older saved machine is kept but not read.
