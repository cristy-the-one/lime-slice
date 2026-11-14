# Gear kinds: trains without hand-made hinges, rings, planets, racks, bevels and worms

Status: plan. Stage 1 and stage 2 are built (one PR each); stages 3 and 4 are each built to this file in a PR of their own, and
each PR corrects its section where the code says otherwise. This file is the spec. It extends
`docs/plan-gear-coupling.md` (what exists: couplings found by the mesh check, `trainTurn`, `trainCheck`).

The owner's standard: a person in the window, with no agent and no script, gets a working train. Hints over MCP for an
agent to act on do not count. For every stage the code that moves gears never reads the mesh check: the mesh check wires
the train once (Couple gears) and judges sampled frames (`trainCheck`). The motion is the coupling ratios alone.

## Stage 1: a train without hand-made hinges or a frame

### What the person does

Make two or three gears in Model, put them at mesh (the gear card says "Meshes with …"), open Pose, select one of the
gears, press **Couple gears**, and turn one of them with its ring or its Angle field. The train turns. No Link tool, no
Joint tool, no frame part. One Undo takes the whole Couple gears back.

### Hinges made by Couple gears

Couple gears first finds the gears that mesh (`worldPair` says `meshing`, gears of different objects, at the poses the
parts stand at now), then gives a hinge to each gear that needs one, then couples as before (`findCouplings`).

A gear's object **needs a hinge** when one of its gears meshes with another gear and its body does not turn:

- Its member has no joint and is not **held** (below). A member with a hinge keeps it: a hinge off the gear's axis is
  still refused with its sentence ("Pinion's hinge does not turn about its gear's axis."). A ball is still refused.
- It is the root, or the walk up from it through members seated without a joint ends on the root and the root holds no
  gear (a frame, or a part that is not a gear). Such a gear was seated by Attach or `model_place {to}`, and had to be
  given a hinge by hand before.
- A gear seated without a joint on another gear **whose axis it shares** (a compound gear, a shared shaft: the gear's
  centre within 0.05 mm of the other gear's axis line, axes parallel within a degree) keeps no joint and turns with its
  shaft, as now. A gear seated without a joint on a gear it does **not** share an axis with is not on that gear's shaft
  (Attach seats a part on whatever was selected): it is given its own hinge and seated on the assembly's root where it
  stands, so the gear it meshes with does not carry it round.

The hinge: pivot at the gear's centre and axis along the gear's axis, both in the part's own frame, angle 0, no limits.
For an object with two gears (a compound gear in one solid) the first gear that meshes gives the axis; the other is
coaxial or is refused with the off-axis sentence.

### Gears in no assembly

Couple gears on a gear that stands in no assembly makes one. Its members are every free gear in the meshing group of the
selected gear (gears that mesh with it, and gears that mesh with those), and no others: a lone gear stays free, and gears
in other assemblies are never touched. The first of them in plate order is the root; the others are seated on it where
they stand. The assembly is named "Gear train" ("Gear train 2", … when taken). Members get `frame: "part"`, as Attach
gives them (D2 of `docs/plan-assemblies.md`); the root keeps its frame.

Couple gears on a gear that stands in an assembly also takes in the free gears that mesh with that assembly's gears,
seated on its root where they stand. Nothing else changes about which gears it couples.

### A root that turns on the plate

The new rule that lets a train turn without a frame part: **an assembly's root may carry a hinge.** A root without a
joint stays the fixed root it always was. A root with a hinge is a gear on a pin in the plate:

- Its pivot and axis are in its own part frame, as every hinge's are. It turns about that line with the ring, the Angle
  field, an animation key or `model_place {angle}`, and the train turns with it.
- A hinged root's `offset` and `turn` (unused and zero for a fixed root) hold its pose in model space, so the assembly
  says by itself where the turned root stands: `solveAssembly` reads them, and every writer that solves the assembly
  writes the root's `modelPose` with the others. On reading an assembly (`readAssemblies`, which the app, the MCP
  session and the file all go through) they are set from the root's `modelPose` again, so a root moved by hand carries
  its pin, and with it the assembly, as before (D9). `movedTo` and `model_place` without `to` set them at once.
- **The parts hinged on a hinged root stay on the plate when it turns**: their offsets are turned back by the root's
  turn (and a ball's rest with them), so their pins do not move. A part seated on it without a joint (a compound gear on
  the root's shaft) turns with it, and so does everything on that part. So a turning root never carries another hinge
  round, and a hinge that rides on the root's turning part (seated on a part that is seated without a joint on the
  root) is a planet: refused with the planet sentence until stage 2.
- The couplings' seat (`couplingSeat`) of a part hinged on a hinged root is read in the root's ground frame (the root's
  frame with its turn taken out), so it does not change as the root turns, and a coupling is still dropped when a gear or
  a pin is moved by hand. A hinged root's own seat is its pivot and axis.
- A root whose `modelPose` carries a scale is not given a hinge (its offset and turn cannot hold a scale): Couple gears
  says "Pinion is scaled in model space, so it cannot turn on the plate." A file with such a root drops the root's joint.
- Rerooting (`model_place {root}`) and removing the root as before: the new root is fixed, and the old root's own hinge
  is not carried.
- Rest turns a hinged root back to its zero with its train. Make rest leaves a hinged root's zero as it is: the seat of
  the parts hinged on it is read from that zero, so a new zero would drop their couplings. (A child's Make rest is as
  before.)

Why this rule, against the other ones looked at:

- A frame part made by Couple gears would be a plate object: it would print, and it changes the print layout.
- Several roots, or a parent that is the plate and not a part, break `wellFormed`, so an older app would drop the whole
  assembly. Several roots would also touch every caller of `rootOf`.
- Parts hinged on a hinged root read in a ground frame that the solve works out (rather than turned back) would leave an
  older app placing them wrong as soon as it solves the assembly again, since it solves them from the root's turned pose.

What an older app does with it: it reads the root's hinge (any member may carry a joint), treats the root as fixed as it
always did (its `bodyOf` makes the root a body, its `trainScales` calls a root fixed, so the train reads "locked:
Pinion cannot turn") and solves from the root's `modelPose`, which is where the new app left it. Every pose stays where it
was; the older app only cannot turn the train. Nothing in the file is refused, and nothing in print changes: hinges move
`modelPose`, never the bed layout.

### Held gears

A gear that should stay fixed on purpose (a ring fused to the frame, a held sun) is **Held**: the Joint select gains
"Held" next to "Fixed", for a member and for the root. Held is a member flag (`held: true`, never with a joint): the part
does not move, as Fixed, and Couple gears never gives it a hinge. A train meshing with a held gear is locked, with its
sentence ("Ring and Pinion are locked: Ring cannot turn, and the train meshes with it."). An older app drops the
flag and reads the part as Fixed. Over MCP, `model_place {joint: {kind: "held"}}`, on a member or a root.

### What Couple gears says, and Undo

Couple gears says what it made before what it coupled: "Gave Pinion and Wheel a hinge about their axes." and, for gears
that stood in no assembly, "They stand in a new assembly, Gear train; Pinion turns on the plate." Then each coupling,
each lock and each pair not coupled, as before. In the app it is one edit (the new assembly, its members' frames, the
hinges and the couplings), so one Undo takes it all back. Over MCP it is one `plate_undo` step.

`model_place {gears: "couple"}` takes a free gear too, and its reply adds `hinged` (the names given a hinge) and, when it
made one, `madeAssembly` (its name). Every other field is as before. No new tool.

### Where it lives

- `src/assembly.ts`: `Member.held`; a hinged root's pose in `solveAssembly`, `readAssemblies`, `movedTo`;
  `couplingSeat` in the ground frame; `frameOf` returns null for a hinge that rides a turning root.
- `src/pose.ts`: `turnHinge` turns a hinged root; `turnInAssembly` turns a member and keeps the parts hinged on a
  turning root where they are.
- `src/gear-train.ts`: `prepareTrain` (the meshing group, the new assembly, the hinges), shared by the app and the MCP
  session; `trainTurn` through `turnInAssembly`; a hinged root is not fixed in `trainScales`.
- `src/app/pose.ts`: the Gears section for a free gear, Couple gears through `prepareTrain`, the root's Joint select,
  the ring on a hinged root.
- `mcp/session/place.ts`: `gears: "couple"` on a free gear, `angle` and `joint` on a root, `writeSolved` writes a
  hinged root.
- `src/pose-anim.ts`: an angle key on a hinged root.

### Tests

- `src/gear-train.test.ts`: two and three free gears with no hinges become a train with a hinged root, at the ratios;
  a turn of the root and a turn of a member turn the train, and the parts hinged on the root stay on their pins (their
  centres do not move); `trainCheck` finds only `meshing` over sampled frames; the seat survives turns of the root and a
  read (`readAssemblies`), and a gear moved by hand still drops its coupling; a compound gear on a shared shaft is not
  given a hinge, and a gear seated on a gear it does not share an axis with is; gears attached to a frame without
  hinges get them; a held gear stays fixed and locks its train; an off-axis hinge is still refused; an older reader's
  view (the root's hinge read, the train locked, every pose where it was).
- `mcp/gear-train.test.ts`: free gears coupled over `model_place {gears: "couple"}`, `hinged` and `madeAssembly` in the
  reply, `model_place {angle}` on the root and on a member, one `plate_undo` takes it all back, save and reopen.
- `e2e/pose-gears.spec.ts`: a second test from `e2e/gear-train-project.ts --free`: three gears placed at mesh, no
  hinges, no frame, no assembly. In Pose: select the pinion, Couple gears ("Gave pinion, wheel and third a hinge about
  their axes."), drag the pinion's ring and the wheel's, the Angle field, Undo of the Couple gears, save and reopen.
- `e2e/gear-train-real.spec.ts` (`test:engine`): the same with gears built by the real kernel, if `test:engine` can
  carry it.

## Stage 2: internal (ring) gears and planetary stages

Status: built (the second PR). Corrected from the outline where the code says otherwise.

### The ring gear

- **Kernel.** A new type `lime_recipe::gears::Ring { teeth, module, pressure_deg, backlash }`, not a field on `Gear`: a
  field would break every `Gear { .. }` literal, recipes' included. Its space between two teeth is the external tooth
  of the same numbers: involute flanks from the tip circle `r - m` (inside) out to the root circle `r + 1.25 m`
  (outside), `backlash` wider at the pitch circle, a radial line below the base circle. No profile shift (refused: "A
  ring gear takes no profile shift."), 20 to 150 teeth, and two refusals of its own (spaces or teeth that come to a
  point). `Ring::points` and `Ring::outline` are the hole; `mate_phase_internal` and `ring_turn` are its train helpers.
- The gear op and `PrimitiveSpec` take `internal: true` and `rim` (the outside diameter; two modules outside the roots
  when absent, up to four times that). The kernel's ring (`build_ring` in `crates/lime-model-occt/src/tree/gear.rs`) is
  the rim's disc with the toothed hole: one extrude of loops. A ring takes no bore or hub. An older app reads the gear
  op without `internal` and builds an external gear of those numbers there.
- **Mesh check, both copies** (`gear_pair::classify_internal`, `internal_turn`; `classifyInternal`, `internalTurn` in
  `src/gear-pair.ts`; the same verdicts under lust 0.3.1, rustc and the window, `mcp/recipe-gears.test.ts`). Apart when
  the pinion's tips do not reach the ring's (or it stands outside); then module and pressure angle; then the working
  distance `m (z_ring - z_pinion) / 2`: pushed out into the ring's teeth past both backlashes is `tooClose`, held in is
  `loose`. The mating phase is `mate_phase_internal` (the pair turns the same way, so a tooth behind the pitch point
  meets a space as far behind it). The segment test compares the pinion's edges past the ring's tip circle with the
  ring's edges inside the pinion's tip circle. Two rings never mesh. `worldPair` sends any pair with one ring here.
- **Tip interference.** A small pinion meets the ring's tip corner with its undercut root before the involutes touch:
  12 in 36 has 0.055 mm of play each way, not 0.1. Measured against the kernel's solids; the coupled motion never
  touches (a whole pitch, exact volume). Said in `docs/collision-prototype.md`; not refused.
- **Coupling.** Same turning direction: ratio `+z1 / z2`, times the sign of the hinge axes' dot product. Couple gears
  also turns an internal pair through a pitch of the pinion and asks the mesh check at 12 steps; a pair that leaves its
  mesh is not coupled: "Pinion and Ring are not coupled: their teeth cross as they turn."
- **Window.** The gear card's **Gear** select: External or Ring (internal). A ring shows Rim and hides Bore, Hub and
  Shift; its ghost is the rim's disc with the hole; its step reads "ring gear 36 teeth m 1 h 6, rim ⌀50".

### Planets on a carrier

- **The coupling.** Not a stage record: each mesh stays a pair coupling, and a pair whose two gears hinge on different
  parts carries `carrier: {body, name, ratio}` when one gear hinges on a part K (the carrier) and the other sits on the
  part K turns on, its centre on K's hinge line. In K's frame the mesh is a fixed-axis one, `(b - K) = rho (a - K)`
  about K's axis, so the driven body turns `ratio` per degree of the driver plus `carrier.ratio` per degree of K. Any
  other pair on different parts is refused with its sentence. The seat holds K's pin as well, so moving the carrier's
  pin drops the coupling; an older app computes a shorter seat and drops it rather than driving it as a fixed-axis one.
- **Motion.** `trainScales` of a train with a carrier solves the couplings as linear equations (Gauss-Jordan), with every
  body that has no hinge (the fixed root, a held part) at zero and the turned body at one. No solution is a lock, with
  its sentence; more than one (sun, ring and carrier all free) is refused: "… turn more than one way: hold the sun, the
  ring or the carrier (Joint: Held), and the others follow." A train with no carrier keeps the walk it had.
- **Couple gears sets a stage up** (`prepareTrain`):
  - a part without a joint, not the root and holding no gear, whose gears mesh with a ring seated elsewhere, is the
    carrier: it gets a hinge about the ring's axis. Only a ring makes a carrier: a bracket that holds a gear against a
    sun alone is a fixed axle. A carrier without a ring takes its hinge by hand (Joint: Hinge);
  - a gear seated on a part that turns, off that part's hinge line, is a planet: it gets a hinge of its own on that part;
  - a ring that is the assembly's root stays fixed in a stage with a carrier (the housing), so sun and carrier turn by it;
  - a sun inside its ring shares the ring's axis in the ring's plane: two gears, not one shaft (`coaxial` needs the two
    in planes of their own).
- **Validation.** `trainCheck` turns the whole stage and asks the mesh check about every sun-planet and planet-ring pair.
  The window's Couple gears now runs it too, over one turn in 24 steps, and says a frame that does not mesh.
- A planet on a hinged root's turning part (seated on a part seated without a joint on the root) is still refused: the
  parts hinged on a hinged root stay on the plate (stage 1), so a carrier is never the hinged root. A held or fixed
  carrier is a star: its planets turn on fixed axes and the couplings carry no carrier.

### Tests

`crates/lime-recipe/tests/ring_gear.rs` (the outline; meshing at the inside distance and through 73 turns; a ring turned
against the pinion, half a tooth off, out, in, apart); `crates/lime-model-occt/tests/gear.rs` (the ring's volume, the
refusals, exact volume at mesh, inside the play, past it, and through a pitch turned together);
`mcp/recipe-gears.test.ts` (lust, rustc and the window agree); `src/gear-planet.test.ts` (inside ratio, the stage with
ring, sun or carrier held, none held, sampled meshes from three bodies, the file, a moved carrier, Couple gears' set-up);
`mcp/gear-train.test.ts` and `mcp/gear-train-occt.test.ts` (the stage over MCP, and with real solids by exact volume at
six turns of the sun); `e2e/model-gear.spec.ts` (the Ring card) and `e2e/pose-gears.spec.ts` (a stage attached by hand,
coupled and turned in the window, saved and reopened).

## Stage 3: rack and pinion

- **Joints.** The assembly has hinges and balls; there is no slide. Stage 3 adds `{kind: "slide", origin, axis, travel,
  min, max}`: a member that moves along an axis in its own frame, `travel` mm from its zero, with limits. Pose gets an
  arrow handle and a Travel field; `model_place {joint: {kind: "slide"}}` and `{travel}`; an older app drops the joint
  (`readJoint` refuses an unknown kind) and reads the part as Fixed.
- **Kernel.** A rack op: `{primitive: "rack", module, teeth, thickness, back}` from `lime_recipe::gears::rack_outline`,
  which exists for recipes, with the same pressure angle, backlash and shift fields as `Gear`.
- **Mesh check, both copies.** A pinion against a rack: the pitch line at the pinion's pitch radius (plus shift) from its
  centre, the mating phase of the rack's teeth along the line, outlines compared as for gears.
- **Coupling.** Pinion angle to rack travel: `π m z / 360` mm per degree, signed by the slide axis against the pinion's
  turning direction at the pitch point.

## Stage 4: bevel gears and worms

- **Bevels** (intersecting axes): the kernel needs a conical tooth (a spherical involute, or the Tredgold
  approximation: the back cone's equivalent spur outline swept to the apex). The mesh check needs the axes to meet at the
  cones' apex and the cone angles to sum to the shaft angle; its outline test can run on the back cone's development as
  a spur pair of equivalent tooth counts `z / cos δ`. The coupling ratio is `-z1 / z2` about the two axes.
- **Worms** (skew axes): the kernel needs a helical thread and a throated or straight wheel. The mesh check is a lead
  and centre-distance test; an outline test in one plane does not carry it, since the contact runs along a helix. The
  ratio is `starts / z` and the worm is self-locking when its lead angle is below the friction angle.
- Stage 4's PR decides, with measurements, whether each kind can be made reliable. One that cannot stays refused with a
  sentence ("Bevel gears are not covered yet: their axes meet."), rather than half-working.
