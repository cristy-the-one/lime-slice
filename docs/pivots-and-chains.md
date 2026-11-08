# Pivots and bed chains

A pivot is a point on an object. A bed chain links objects through those points so a child follows its parent in the print layout. It is a layout convenience, separate from an assembly's model-space pose. For joints and inverse kinematics, use the Pose stage and its Reach tool (`docs/plan-pose.md`). An object can be in both a bed chain and an assembly.

The project version stays 4. The new keys are omitted when they are absent, so a file written without a pivot, a chain, or a joint limit is the same file as before. An older app ignores the keys and drops them the next time it saves.

## Pivot

The pivot is in the source mesh, in millimetres. Leave it empty and the object turns about its bounds centre, which is what it already did. Type X Y Z, or use the Pivot tool on the Prepare rail: click the part, drag to move the point, Shift snaps to a corner, the centre, or a nearby vertex. Reset clears it.

Rotate and scale keep a custom pivot where it is on the bed. The app does that by the same orientation and scale plus a bed offset, so the mesh the slicer sees is still produced by `placeMesh`. The slice pose's `pivot` stays the bounds centre (`docs/part-frame.md`). A project that never sets a pivot does not change that pose, the mesh bytes, or the G-code.

Model's Place rotation uses the same point, lifted by the mesh seat when the open solid is that plate object. Model's Scale solid is a kernel operation and does not read the pivot.

## Chains

Select the parent, then Link on the child. The link stores the child's pivot in the parent's pivot frame, and the child's orientation relative to the parent. Move, rotate, or scale the parent and the children follow, through the same placement path as a single object. A child you move on its own stays where you put it; the next parent move carries it from there.

The Chain row selects the whole chain. Move, rotate, scale, duplicate, and delete then treat it as one object, and one undo step puts it back. Delete chain removes every member. The plate always keeps one object, so a chain that is the whole plate is not removed. Delete on a single row removes that member and reparents its children. A copy of one member is free: it does not stay linked. A loop is refused. Arrange records the links again after it packs, so a packed child does not jump back.

## Older project files

Projects made before Pose may contain bed-chain `jointLimits`. They remain in the file when it is opened and saved, so an older app can still read them. The Prepare controls no longer edit or use those limits; Pose joints are stored separately on assembly members.

## What does not change

- No new slice-request field. `crates/lime-slice-core` is untouched.
- No GPL or LGPL code.
- Nothing here needs a network.
- The MCP server has no new tool. Opening and saving a project keeps `pivot`, `chain`, and `jointLimits`. Duplicating one object through MCP drops the link and keeps the pivot.
