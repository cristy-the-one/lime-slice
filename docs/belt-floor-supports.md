# Supports on the belt floor

A belt slice forces supports off unless the request sends `belt.floorSupports: true`. Omitted, the flag is absent, and a belt that asked for supports still prints none. The cartesian lock is unchanged.

The planner runs after the plate is rotated so the nozzle plane is horizontal. In that frame the belt is the plane `z = (y + yShift) * tan(angle) - zDrop`, from the same shift `lay_flat` stored on the frame. Printable material on a layer is `y` at or below that plane. Supports that would step through it land on it.

## Decisions

- The flag is opt-in and omitted when off. Honoring `supports: true` on a belt without it would emit horizontal supports onto a bed the printer does not have, and would change existing belt G-code.
- With the flag, tree and grid supports are clipped to the half-plane. A trunk whose next layer is under the belt at its xy stops and thickens there, the way a trunk thickens on layer 0. Disks are shrunk so the circle stays on the printable side of the plane.
- The plane is not a field of `SliceSettings`. It is mixed into the support grow and paint keys only when the flag is on, so a cartesian key keeps its bytes. Contour keys do not move.
- A raft and floor supports together are refused. The raft lifts the part after `lay_flat`, and the frame's drop is from before that lift.
- Support edits and support paint stay refused. A disk is still in the part frame, and the planner is in the rotated frame. Seam paint stays refused for the same reason.
- Compare stays refused on a belt.
- `classic` still grows floor supports when the flag is on. It does not force them off.

## UI

The machine sheet has a checkbox, off by default, next to the raft. Off, the slice request omits `floorSupports`. A saved machine that has no such field reads as off.
