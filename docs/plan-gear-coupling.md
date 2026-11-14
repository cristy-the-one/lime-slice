# Gear coupling: gears that drive gears in Pose and animation

Status: plan and first cut, built in the same branch. This file is the spec the code follows.

## What the user gets

An assembly of spur gears, each on a hinge about its own axis, turns as a gear train. Turning one gear in Pose (the
ring, or the Angle field), in an animation, or over MCP turns every gear it meshes with, at the tooth ratio, through the
whole train. Nobody declares the pairs: **Couple gears** finds them with the mesh check that already exists
(`src/gear-pair.ts`, the same verdict as `lime_recipe::gear_pair::classify`). A pair the check does not call `meshing`
is not coupled, and the reply says why in one sentence. A train that cannot turn (a closed loop whose ratios disagree,
or a gear that meshes with a fixed gear) is reported as locked, names its gears, and does not move.

## Scope

Covered: external spur gears on parallel axes, each gear a plate object's own solid or a gear step on it, each turning
on a hinge about its axis, all hinges sitting on one frame.

Not covered (each needs its own ratio and mesh test, or cannot come from a mesh check at all): racks, internal (ring)
gears, bevel gears, worms, planets (a gear whose hinge rides on another turning part), and contact mechanisms (cams,
latches, Geneva wheels). Reach (the drag that solves a chain toward a point) and `model_check {sweep}` turn one hinge as
before; they do not drive a train.

## Data model (`src/assembly.ts`)

`Assembly` gains an optional list:

```ts
interface GearRef { object: string; step: number | null; name: string }
interface Coupling { driver: string; driven: string; ratio: number; gears: [GearRef, GearRef] }
interface Assembly { id; name; members; couplings?: Coupling[] }
```

- `driver` and `driven` are **bodies**: the member whose hinge turns the gear. A gear's body is found by walking up from
  its object through members without a joint to the first member with a hinge. A walk that reaches the root first ends
  on a fixed body (the root). A ball on the way means the gear is not covered.
- `ratio` is how far the driven body turns for one degree of the driver: `-z_driver / z_driven` (as
  `lime_recipe::gears::mate_turn`), times the sign of the dot product of the two hinge axes in model space. Two gears
  whose hinges point opposite ways turn the same way about their own axes.
- `gears` names the two gears of the mesh (object, gear step or null for the object's own solid, and the label), so the
  validator can find them again and a reply can name them.
- `seat` records what a hinge turn never changes: each gear's pose on its body, and each hinged body's pivot and axis
  on its parent with that parent's pose on the frame. The reader drops a coupling whose seat no longer matches (a gear
  moved by hand, a pivot or axis edited), so the joint never drives gears that may have left their mesh. Couple again.
- Couplings read outward from the train's first body in member order ("pinion drives wheel, wheel drives third").
- No phase is stored. The phase is the pose: every turn moves all coupled bodies by their share of one delta, so the
  phase each pair had when it was coupled is kept. Redefining a hinge's zero (Make rest) changes nothing.

Saved with the project in the assembly row (`readAssemblies` reads it, the same reader the app, the MCP session and
the file use). An older app reads `id`, `name` and `members` only, so it opens the file and drops the couplings; it does
not refuse the file. No version bump. A damaged coupling is left out without discarding its assembly. A coupling is
dropped when a body it names is no longer a member, or is no longer a hinge (unless it is the fixed root), and when a
member is removed or the assembly is rerooted through it. `assembly_merge` keeps both assemblies' couplings.

## Where it is solved (`src/gear-train.ts`)

One module, no DOM, shared by the app, the MCP session and the animation sampler:

- `findCouplings(assembly, gears, poses)`: every pair of gears on different bodies whose axes are parallel and whose
  slabs overlap. `worldPair` gives the verdict. `meshing` becomes a coupling if both bodies sit on the same frame (the
  first jointed ancestor of the hinge, or the root) and each hinge turns about its gear's axis (parallel within a
  degree, the gear's centre within 0.05 mm of the hinge line). Every other verdict, and each of those refusals, is one
  sentence in `notCoupled`. Two gears of one solid, or on one body (a shared shaft: a part seated without a joint on a
  gear), are one body and never a pair.
- `trainScales(couplings, start)`: a walk from the turned body; each coupling multiplies by its ratio one way and
  divides the other. A body reached twice at a different scale closes a loop whose ratios disagree; a fixed body
  reached at all means the train cannot turn. Either is a lock, named by the gears in the train.
- `trainTurn(assembly, object, delta)`: the bodies' scales, the delta clamped so no hinge passes its limits (the train
  stops together at the first limit), then `turnHinge` on each body by `scale * delta`. A locked train is refused with
  its sentence and nothing moves. A member in no coupling is `turnHinge` as before.
- `trainCheck(assembly, poseOf, gearsAt, object, angles)`: the validator. For each sampled driver angle, the train is
  turned from its present pose, solved, its gears placed again, and every coupled pair checked by `worldPair`. The
  mesh check is the judge, not the driver: the code that moves the gears never reads it.

## Pose (`src/app/pose.ts`)

- The hinge ring and the Angle field call `trainTurn`; a drag solves from the assembly at drag start, so it stays one
  undo step and does not drift. Rest turns the train back with the gear.
- A **Gears** section under the assembly: **Couple gears** (finds and stores the couplings, says what it found, which
  pairs were not coupled and why, and any lock) and **Uncouple** when there are couplings. Each coupling reads
  "Pinion drives Wheel, ×−0.5".

## Animation (`src/pose-anim.ts`, `pose_animate`)

An angle key on a coupled hinge turns the train with `trainTurn`. Keys on two bodies of one train (or a reach or ball
key on a gear in a train) are refused before sampling: "Pinion and Wheel are one gear train; key only one of them." A
locked train refuses the animation with its sentence.

## MCP surface

One field on `model_place`, no new tool: `gears: "couple" | "list" | "uncouple"` on any member of an assembly.

- `couple` stores the couplings `findCouplings` gives, replacing the assembly's earlier ones, and replies with
  `couplings` (driver, driven, gear names, ratio), `notCoupled` (names and the sentence), `locked` (gears and the
  sentence) and `checked`: the validator over one turn of the first coupled gear in 24 steps (pairs checked, and
  any pair that was not `meshing`).
- `list` replies the same rows without changing anything; `uncouple` drops them.
- `model_place {angle}` on a coupled hinge turns the train; the reply's `angles` names every hinge that moved.
- The token budget (18,250 for the list, 5,650 for the first list) is held: the field's description is paid for by
  shortening other core descriptions.
- `guide {kind:"pose"}` and `docs/mcp-server.md` say how.

## Tests

- `src/gear-train.test.ts` (unit chain): the ratio and its sign (opposite hinge axes), propagation through three gears,
  a compound gear on a shared shaft (two objects, one body), a consistent loop that turns and an inconsistent loop that
  is locked and moves nothing, a gear meshing with a fixed gear is locked, limits stop the whole train, a pair that is
  not meshing is not coupled with its sentence, the validator finds no `toothOnTooth` over sampled frames (and does
  find it when the ratio is made wrong), save and read round trip, and an older reader's view.
- `src/pose-anim` coverage in the same file: an angle key on the driver turns the follower; keys on two gears of one
  train are refused.
- `mcp/gear-train.test.ts` (unit chain): a frame, a pinion and a wheel placed at their centre distance with the mating
  phase, hinged, `gears:"couple"`, a turn of the pinion turns the wheel by `-z1/z2`, `model_check` still calls the pair
  `meshing` at sampled angles, `list` reads it back, one Undo restores the train, the project round trips, a gear 1 mm
  too far is not coupled with its sentence, and a fixed gear locks the train. The gears are Model tree roots, so the
  fake engine is enough: no kernel call takes part in any of it, as `mcp/pose.test.ts`.
- `e2e/pose-gears.spec.ts` (headless Chromium, smoke list), with no script or agent in the loop: a pinion (12), a wheel
  (24), a third gear (18), and a compound stage (a 12-tooth gear seated on the wheel's shaft driving a 24), written by
  `e2e/gear-train-project.ts` through the MCP session and opened in the app. Couple gears in the Pose panel lists the
  three meshes; a drag on the pinion's hinge ring turns every gear at its tooth ratio (wheel -p/2, third +2p/3, out
  +p/4, the small gear with its shaft); typing the third gear's angle drives the train back from the far end; one Undo
  restores the train; and after a save and reopen the couplings come from the file and a second drag checks the ratios
  again.
