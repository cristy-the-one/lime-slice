# Gear kinds: trains without hand-made hinges, rings, planets, racks, bevels and worms

Status: built. Stages 1 to 3 are built and stage 4 decided, one PR each; each are each built to this file in a PR of their own, and
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

Status: built (the third PR). Corrected from the outline where the code says otherwise.

- **The slide joint.** `Joint` gains `{kind: "slide", pivot, axis, travel, min, max}`: the part moves along `axis` in
  its own frame, `travel` mm from its zero (`moveSlide`), clamped to its limits. `pivot` is a point on the line (kept so
  every joint has one). Pose's Joint select offers **Slide** (not on a root), with Axis, **Travel mm** and Minimum and
  Maximum mm; there is no ring for a slide, so a rack moves with its pinion's ring or by its Travel field. Rest takes a
  slide back to 0 with its train; Make rest leaves a slide's zero as it is (its seat is read from it). Reach leaves a slide
  where it is; an animation keys the pinion, not the slide ("A slide moves with its pinion: key the pinion's angle.").
  `model_place {travel}` moves a slide (and its train), `{angle}` on a slide or `{travel}` on a hinge is refused, and
  `joint: {kind: "slide", pivot, axis, min, max}` makes one. An older app drops the joint (`readJoint` refuses the kind)
  and reads the rack as fixed; its coupling is dropped there with it.
- **Kernel.** `lime_recipe::gears::Rack { teeth, module, pressure_deg, backlash }`, a type of its own (the library's
  `rack_outline` is the adopted bit-for-bit copy, 0.9 m addendum, no backlash, and stays as it is): straight flanks at the
  pressure angle, addendum m, dedendum 1.25 m, `backlash` off each tooth at the pitch line, 1 to 400 teeth, along its own +X
  with teeth pointing +Y, the pitch line through the origin and tooth 0 on it. The gear solid takes `rack: true` and
  `back` (the bar under the roots, 1.5 modules when absent); no profile shift, phase, bore, hub or rim (each refused with
  its sentence). `rack_travel(turn, z, m)` is `PI m z / 360` mm a degree. An older app reads `rack` as unknown and builds a
  spur gear of those numbers if it rebuilds the step.
- **Mesh check, both copies** (`gear_pair::classify_rack`, `rack_turn`; `classifyRack`, `rackTurn`; the same verdicts
  under lust 0.3.1, rustc and the window). In the rack's frame: apart when the pinion's tips stand clear of the rack's
  tips or off its ends; module and pressure angle; the working distance from the pitch line is the pinion's pitch radius
  plus its shift (`tooClose` nearer by more than both backlashes, `loose` farther); the mating phase as the pitch circle
  rolls on the pitch line (a pinion tooth a fraction behind the foot meets a space as far behind it); a turn past the play
  inside the band, or two edges that cross, is `toothOnTooth`. `worldPair` projects into the rack's frame from its
  `tooth0` (along the rack) and `axis`; a rack with a ring or a rack is apart.
- **Coupling.** A pinion on a hinge and a rack on a slide on one frame couple at `PI m z / 360` mm a degree (the coupling
  row says `rack: "driven"` or `"driver"`, and its line reads "pinion drives rack, ×0.105 mm a degree"). The sign is the
  geometry's: the pinion turned + about its own axis carries its pitch point along `teeth x axis`, and the rack travels
  with it, read against the slide's axis and the pinion's hinge. Refused, each with its sentence: a rack on a hinge, a
  pinion on a slide, a slide that does not run along the rack's teeth, and a rack and pinion on different frames. A held
  rack locks its pinion. Limits are each joint's own: a slide's in mm, a hinge's in degrees.
- **Couple gears** gives a rack that meshes a slide along its teeth (and a pinion its hinge), says "Gave rack a slide along
  its teeth.", and never makes a rack the root of a new assembly: the first gear that is not a rack is. A rack that is the
  root stays fixed, with a sentence. The MCP reply adds `slid`.

### Tests

`crates/lime-recipe/tests/rack_gear.rs` (the outline and its area; meshing and through ±280 degrees of sampled travel; a
rack sent the wrong way caught; half a pitch off, near, far, apart); `crates/lime-model-occt/tests/gear.rs` (the rack's
volume; exact volume at mesh, ±0.06 mm, a pitch turned with the rack moved by `rack_travel`, crossing past the play; the
refusals); `mcp/recipe-gears.test.ts` (lust, rustc and the window agree); `src/gear-rack.test.ts` (the window's verdicts,
the coupling and its sign, either side driving, a slide limit, 200 turns and reads, a rack moved by hand, the refusals,
Couple gears from free parts); `mcp/gear-train.test.ts` (over MCP, `travel` and `angle` and their refusals) and
`mcp/gear-train-occt.test.ts` (real solids by exact volume at five pinion turns, crossing when the rack moves alone);
`e2e/model-gear.spec.ts` (the Rack card) and `e2e/pose-gears.spec.ts` (a free rack and pinion coupled and driven by hand,
the rack's Travel field, saved and reopened).

## Stage 4: bevel gears and worms

Status: decided (the fourth PR). Both stay **refused, with a sentence**: neither can be made reliable to the owner's
standard with what the kernel and the mesh check have, and a half-working kind is worse than an honest refusal. What
changed: two gears whose axes cross used to be skipped in silence (`worldPair` returns null for axes more than a degree
off parallel, so Couple gears said "No pair of these gears meshes" or nothing). Now a pair whose bounding spheres meet
(each gear's reach, `gearReach`, with half its thickness) is said, in the window's Gears section, in `notCoupled`, and as
`gears: "couple"`'s refusal for free gears: "Flat and Standing are not coupled: their axes cross at 90°, and bevel gears
and worms are not covered." Nothing is hinged, nothing is made.

### What a bevel pair would need

- **Kernel.** No conical gear exists. A bevel gear's tooth is a spherical involute narrowing to the cone's apex. The usual
  stand-in is Tredgold's: the tooth on the back cone is the involute of a virtual spur gear of `z / cos δ` teeth, and the
  solid is a loft of that outline from the back cone toward the apex, scaled by the distance. OCCT can loft wires
  (`lime_tree_feature_extrude_loops` does not; a ruled loft through two or three scaled outlines would be a new op), and
  `Gear::points` gives the virtual outline. The faces are then not exact spherical involutes; the error grows with the face
  width over the cone distance.
- **Mesh check.** The axes must meet at the cones' common apex (one point, in 3D), and the pitch-cone angles must sum to
  the shaft angle (`tan δ1 = sin Σ / (z2/z1 + cos Σ)`). Those are cheap and exact. The outline test, though, only carries
  on one surface: the back cone's development is a plane where two virtual spur gears mesh, and a segment test there
  judges that section. A pair can clear on the back cone and touch toward the apex (the loft's error, a wrong cone
  angle), so a second development at the inner end is needed at least, and nothing between them is checked.
- **Coupling.** Kinematically the easy part: `-z1/z2` about the two hinge axes (any axes: `trainTurn` turns each hinge
  about its own), the sign from the axes against the apex. `trainCheck` would sample frames with the same two-section test.
- **Why refused.** The verdict would rest on a polygon test at two cone sections of a lofted approximation, while the
  owner's standard is that a person can rely on it. The only judge that sees the whole face is the kernel's exact common
  volume, which is too slow to run on every sampled frame in the window. Until a conical tooth is built exactly (a real
  spherical involute, or an octoid as cut) and the check is shown against exact volume over the face width, bevel gears
  stay refused.

### What a worm and wheel would need

- **Kernel.** A worm is a helical thread: a trapezoid of the axial pitch `PI m` swept along a helix of lead `starts PI m`.
  No helical sweep exists in the gear op (the kernel's sweep op could carry it, untested for this). The wheel is throated
  (hobbed to the worm's curvature) or, for a printed toy, a helical spur gear, which the gear op does not make either.
- **Mesh check.** The contact runs along a line on a helix, not in any one plane: the outline approach does not carry at
  all. A check would be centre distance and lead (`tan λ = starts m / d1`), and the wheel's helix angle equal to the
  lead angle, which says the pair is made right, not that it turns clear.
- **Coupling.** `starts / z_wheel` turns of the wheel per worm turn, about axes at 90° that do not meet; a worm is
  self-locking when its lead angle is under the friction angle, which a coupling can say (the wheel cannot drive the worm).
- **Why refused.** No kernel geometry, and no check of the mesh that the window could trust.

### Tests

`src/gear-crossed.test.ts` (a right-angle pair within reach is refused with the angle, out of reach or parallel is not, a
30° skew says 30°, an assembly's pair and Couple gears on free gears make nothing); `mcp/gear-train.test.ts` (the
refusal over MCP, nothing made); `e2e/pose-gears.spec.ts` (the sentence in the window, nothing made).
