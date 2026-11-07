# Pivots, chains, and inverse kinematics

A pivot is a point on an object. A chain links objects through those points so a child follows its parent. Inverse kinematics turns the joints of a chain while you drag the end. All three are plate placement. They are not assemblies: an assembly keeps parts in model space and has no degrees of freedom (`docs/plan-assemblies.md`). An object can be in both.

The project version stays 4. The new keys are omitted when they are absent, so a file written without a pivot, a chain, or a joint limit is the same file as before. An older app ignores the keys and drops them the next time it saves.

## Pivot

The pivot is in the source mesh, in millimetres. Leave it empty and the object turns about its bounds centre, which is what it already did. Type X Y Z, or use the Pivot tool on the Prepare rail: click the part, drag to move the point, Shift snaps to a corner, the centre, or a nearby vertex. Reset clears it.

Rotate and scale keep a custom pivot where it is on the bed. The app does that by the same orientation and scale plus a bed offset, so the mesh the slicer sees is still produced by `placeMesh`. The slice pose's `pivot` stays the bounds centre (`docs/part-frame.md`). A project that never sets a pivot does not change that pose, the mesh bytes, or the G-code.

Model's Place rotation uses the same point, lifted by the mesh seat when the open solid is that plate object. Model's Scale solid is a kernel operation and does not read the pivot.

## Chains

Select the parent, then Link on the child. The link stores the child's pivot in the parent's pivot frame, and the child's orientation relative to the parent. Move, rotate, or scale the parent and the children follow, through the same placement path as a single object. A child you move on its own stays where you put it; the next parent move carries it from there.

The Chain row selects the whole chain. Move, rotate, scale, duplicate, and delete then treat it as one object, and one undo step puts it back. Delete chain removes every member. The plate always keeps one object, so a chain that is the whole plate is not removed. Delete on a single row removes that member and reparents its children. A copy of one member is free: it does not stay linked. A loop is refused. Arrange records the links again after it packs, so a packed child does not jump back.

## Inverse kinematics

Select the end object (the one with a parent and no children) and drag with the IK tool. The solver is cyclic coordinate descent, written here, with no library: each joint turns about its pivot so the end pivot approaches the pointer. The pointer rides a plane through the end pivot, facing the camera. Bone lengths stay. A step is at most 90°, and the solve stops at 32 steps or when the end is within 0.05 mm. Joint limits, in the Pivot and chain group, clamp the Euler angles of a joint after each step. Empty is free. The end object is not a joint. One drag is one undo step.

FABRIK is not implemented. A shared parent turns every child that hangs on that joint, not only the branch you are reaching with.

## What does not change

- No new slice-request field. `crates/lime-slice-core` is untouched.
- No GPL or LGPL code. The solver is original.
- Nothing here needs a network.
- The MCP server has no new tool. Opening and saving a project keeps `pivot`, `chain`, and `jointLimits`. Duplicating one object through MCP drops the link and keeps the pivot.
