# Coupling kinds: a declared ratio, a winch, a ratchet with its click, a friction clutch

Status: built for 6.8.0. This file is the spec (F4 of the cat clock note, `clock-function-plan.md` section 5). It extends
`docs/plan-gear-coupling.md` and `docs/plan-gear-kinds.md` (couplings found from meshing gears, `trainScales`,
`trainTurn`, `trainCheck`, slides, Held) and sits beside `docs/plan-contact-poses.md` (first contact as a pose solve).
Kinematic only: no forces, no masses, no time. Dynamics are F2.

The owner's standard for mechanism features: "the user should be able to rely on the fact that the gear-coupling joint is
working. not constant tweaking by an LLM". So a person in the window, with no agent and no script, gets a working
mechanism; every answer comes from the model and is the same each time; what cannot be given is refused with one
sentence. The code that moves parts never reads a collision check.

## What a person gets

In Pose, under **Couplings**, a selected part on a hinge or a slide couples to another part of its assembly:

- **Ratio**: the other part moves `ratio` degrees (or mm, on a slide) for each degree (or mm) of this one, both ways.
- **Winch**: this part is a drum on a hinge, the other a load on a slide; the cord moves `2πr/360` mm a degree.
- **Ratchet**: this part is the ratchet wheel; the other is the part its click sits on (coaxial), or the frame. It
  carries that part one way and runs free the other. With a click and the wheel's teeth, tip and root, the click rides up
  each tooth and drops into the next notch.
- **Friction clutch**: the other part follows one to one unless it is held or turned on its own; then it slips.

Each coupling is listed with Remove; Couple and Remove are one Undo each. Turning either part (the ring, the Angle or
Travel field, Rest, an animation key, `model_place {angle}`) moves the other by the rule. Over MCP the same is
`model_place {object, couple: {driven, kind, ...}}`.

## 1. A general coupling

### Data model (`src/assembly.ts`)

Decided: **one list, one type.** A declared coupling is a `Coupling` row in `Assembly.couplings` beside the found gear
meshes, with `kind` set and no `gears`:

```ts
interface Coupling {
  driver: string; driven: string; ratio: number;
  gears?: [GearRef, GearRef];                 // a found mesh only
  kind?: "ratio" | "winch" | "ratchet" | "clutch";  // a declared coupling only
  names?: [string, string];                   // its two bodies' labels, as a mesh names its gears
  on?: [JointUse, JointUse];                  // "hinge" | "slide" | "fixed", when it was declared
  radius?: number; wind?: "in" | "out";       // winch
  free?: 1 | -1;                              // ratchet
  click?: { object, name, teeth, tip, root, arm, sense, zero, phase, lift };  // ratchet with a click
  carrier?; rack?; seat?;                     // found meshes, as before
}
```

Why one list rather than a second field: the walk that carries a turn through a train (`trainScales`) and every reader
of it (Pose's lock lines, the MCP reply, `trainOf` for animations, the contact solve's moving set) then sees a mixed train
of gears and declared couplings with no second code path; a gear driving a drum that winds a weight is one train.

- **Units.** `ratio` is the driven joint's move per unit of the driver's: degrees a degree (hinge to hinge), mm a degree
  (hinge to slide), degrees a mm (slide to hinge), mm a mm (slide to slide). `on` records the two joint kinds, so the
  units a ratio was typed in are known; a line reads "Arbor drives Rack, ×0.5 mm a degree".
- **Bodies.** Driver and driven are bodies (`bodyOf`: a part seated without a joint on a hinged part couples through
  that part's hinge). A ball is refused. One part twice ("are one part: they already move together") is refused.
- **No seat.** A declared coupling says how two joints move together wherever the parts stand, so it carries no seat
  and is not dropped by the gear seat rule. It **is dropped** when a body it names loses its joint or changes it (the
  joint kinds no longer match `on`, so degrees never drive millimetres), when a member is removed or rerooted through,
  and when a click no longer sits on the driven body. As before, the reader (`readAssemblies`) drops it, so the window,
  the MCP session and the file agree.
- **Replacing.** A second declaration between the same two bodies replaces the first. Two bodies already coupled by
  their gears are refused ("are already coupled by their gears"). **Couple gears and Uncouple touch found meshes only**
  (`withFound`); declared couplings stay through both.
- **An older app.** 6.7 reads `couplings` rows that carry two gears; a declared row has none, so it skips the row and
  keeps the assembly, every member, joint and pose. It opens the file and the parts stand where they were left; it does
  not drive them together, and it drops the declared rows if it saves. No version bump of the file.

### Propagation and locks (`src/gear-train.ts`)

`trainScales(assembly, start, sign = 0, options)` walks from the turned body. Gears, ratios and winches tie bodies
rigidly (multiply one way, divide the other), as the gear walk did. Same lock detection, with the words widened:

- a body reached twice at different scales closes a loop whose ratios disagree: "a, b and c are locked: they close a
  loop whose ratios do not agree, so none of them can turn." ("tooth ratios" when every coupling in it is a mesh);
- a body that cannot move (the fixed root, a held part) in the train locks it: "... cannot turn, and the train is coupled
  to it." ("meshes with it" for gears).

A ratio or winch that would lock its train is refused when it is declared ("That would lock the train: ..."). Limits are
as before: the train stops together at the first joint limit, a hinge's in degrees, a slide's in mm. A train with a
planet carrier is still solved as linear equations; a ratio or winch is one more equation there, and a ratchet or clutch
in such a train is refused ("not covered: a ratchet or a clutch in a train with a planet carrier").

`sign` is the way the turn goes (+1, -1, or 0 for a listing, where a ratchet runs free). `trainTurn` passes it.

### Pose and MCP

- Pose: the Couplings section of a selected member whose body turns or slides: Other part (every member on another
  body), Kind, its fields, a line of what it does, Couple; each declared coupling with Remove; a status line. The Gears
  section lists only found meshes.
- MCP, decided: **a field `couple` on `model_place`**, beside `gears` rather than an extension of it. `gears` is a verb
  over the mesh check ("couple", "list", "uncouple" found meshes); a declaration needs its own numbers and a named other
  part, so it is its own object: `couple: {driven, kind?, ratio?, radius?, wind?, free?, click?, teeth?, tip?, root?,
  remove?}`. `object` is the driver. It is given on its own, each kind refuses a number it does not read, and the reply
  has `coupling` (or `removed`), every `couplings` row and a note. `gears: "list"` lists every coupling, declared ones
  as `{driver, driven, kind, names, ratio, ...}`. `model_place {angle | travel}` replies `slipped` (each clutch that
  slipped) and `stopped` (a ratchet that held the turn short). One `plate_undo` step each. Described in full in `TOOLS`,
  with examples, in `guide {kind:"pose"}` and `docs/mcp-server.md`.

## 2. Winch

A winch is the hinge-to-slide coupling with its ratio worked out from the drum's radius `r`: `2πr/360` mm a degree,
offered as its own kind so a person types the radius, not a ratio, and the line says what it is ("Drum winds Weight in
turning forward, on a 12 mm drum: ×0.209 mm a degree").

- **Which way the cord winds.** `wind: "in"` (default) means turning the drum forward (its hinge's +) winds the cord in:
  the load moves toward the drum. "Toward" is read from the model: the load's slide direction against the line from the
  load's slide pivot to the drum's hinge line, across the drum's axis. `"out"` pays the cord out. A slide that runs
  neither toward nor away from the drum (across the cord) is refused: a cord from the drum cannot pull it.
- **The weight and the cord move with the drum**: the load is the slide's body, and a cord or weight shell seated on it
  without a joint (`model_place {to}`, Attach) rides with it. The cord is a rigid part: its length does not change as it
  winds (no flexible member; the clock note's cord stays a cylinder that moves with the weight).
- The load's slide limits stop the drum (a weight on the floor), and pulling the load turns the drum back.

## 3. Ratchet (one-way)

### The rule

A ratchet couples a **wheel** (the driver, on a hinge) and the **part its click sits on** (the driven: a part on a hinge
coaxial with the wheel, or a part that stays: the root or a held part, the frame). `free` (+1 or -1) is the way the
wheel turns, against that part, that the click lets pass. Relative motion `rel = Δwheel - Δpart / ratio` (ratio ±1 from
the two hinges' senses, 1 on the frame):

- `rel` in the free way: they are not tied; the wheel runs free under the click.
- `rel` against the free way: tied one to one. On a turning part, the wheel carries it (and the part carries the wheel);
  on a part that stays, the turn is a lock: "Ratchet turns only forward: its click on Frame holds it the other way."

How it is solved, the same for a hand turn, an animation frame and `trainTurn` (they are all `trainTurn`): the train is
first walked with every ratchet untied; any ratchet whose relative motion goes against its free way is tied, and the
walk is made again; ties only grow, so it ends. A turn the far side of a train makes is judged the same way, so turning a
clock train from its escape end runs the great wheel forward off its click while the drum stays, as it does by hand.

**Power a train from its drum.** With no forces, nothing pulls the drum after the train: a weight does not hang on a
kinematic model. So the animation of a running clock keys the drum (its key turns the train through the ratchet), not
the escape wheel. This is said in the guide.

### The click

Decided: **the click's lift is worked out from horology's ratchet and click, not keyed and not found by contact.** A
ratchet's click is a part on its own hinge, seated on the driven part. Given the wheel's `teeth`, `tip` and `root`
(`lime_recipe::horology::Ratchet`), the click is horology's click for that wheel (`Ratchet::click` with `click_size`:
seat gap 0.1 and rise 0.6 of the tooth depth, the pivot on the tangent through the middle of the face it bears on), and
its one free number, its length (`Click.length`, the "arm"), is read from where its hinge stands: the hinge's distance
from the wheel's axis `R` and the face's middle `m` give `arm = √(R² - m²)`. `src/ratchet-click.ts` ports horology's
construction line by line (the nose, the underside, `lift_deg`).

`clickLift(phase)` is the click's turn about its pivot when the wheel has run `phase` degrees free past the notch: **the
least turn at which neither the nose, nor the underside, nor any tooth's tip corner between them crosses a tooth**, found
by a fixed scan of 600 steps and a 40-step bisection. So the nose sits in its notch (no lift) while the seat gap closes,
rides the tooth's back exactly, reaches horology's `lift_deg` at the tip, and drops into the next notch as the tip
passes. It is the geometry's own answer, the same each time, and it costs microseconds: no meshes, no contact search.

- **The state is the phase**, kept on the coupling (`click.phase`, degrees of the wheel past the last notch, below one
  pitch): it grows as the wheel runs free (dropping by a pitch at each notch), and shrinks when the wheel turns the other
  way, as the nose rides back down; only when it reaches 0 (the click seated) does the ratchet tie. So **a turn against
  the free way first has the play of the click's phase**: `trainTurn` cuts the turn there (a piece), seats the click, and
  carries on tied; on a part that stays it stops there, and the reply says why (`stopped`). The click's hinge angle is
  `zero + sense · clickLift(phase)`, `zero` its angle when it was declared (seated in its notch: declare it seated), and
  `sense` maps the lift (counter-clockwise in the wheel's plane seen with the wheel running free clockwise, as horology
  draws it) to the click hinge's own sense.
- A click is never turned by hand or keyed ("Click moves with its ratchet: turn Ratchet."): it is set by its wheel.
- Refused, each with its sentence: a click whose hinge does not lie along the wheel's axis, one hinged inside the teeth,
  a click not seated on the driven part, horology's own limits (6 to 200 teeth, root 0.3 to 0.97 of the tip, an arm of
  0.5 depths to 20 tip radii), and **a click of the other hand**: its body (the part's box centre) lies off the side of the
  pivot's radial line where horology's nose would be, so it would bite the wrong way ("check free, or which hand the
  click is").
- **The proof**, `src/gear-couplings.test.ts`: three ratchets (20, 30 and 12 teeth) with the click built by a second,
  independent port of horology's construction in the test; at 200 phases over a pitch, no point of the nose or the
  underside is inside a tooth and no tip is inside the click (deepest 0.000000 mm), every lifted pose touches a tooth
  within 0.001 mm (it rests, it does not float), and the lift reaches horology's `lift_deg` at the tip.
- **What the contact solve would cost, and why it is not used.** `src/contact.ts` could find the click's angle per
  frame (drive the click down until it touches the wheel), but it needs the parts' triangles, takes about 200 ms to
  1.3 s a solve on the parts measured in `docs/plan-contact-poses.md` (dozens of poses each), would run on every drag
  event and every frame, and its facets would rest the nose up to the chord tolerance off the true face. The click here
  comes from the same numbers the parts were built from, so it is exact for horology's click, and costs nothing. A click
  that is not horology's (a hand-drawn pawl) is out of this rule: couple the ratchet without a click (it still holds
  one way), or drive the pawl with `model_place {until}`.

## 4. Friction clutch (slips above a torque)

There are no forces in the app (dynamics is F2), so no torque is computed and none is typed. The kinematic meaning, as
the rule, said in the plan, the panel's help line, the coupling's line ("no torque is computed") and the MCP description:

A clutch couples a **driver** side and a **driven** side at `ratio` (default one to one, the hinges' senses taken in). In
any turn:

1. **The turn starts on the driver side** (the turned body reaches the driver through rigid couplings, gears, ratios,
   winches or tied ratchets, without crossing the clutch): the driven side follows at the ratio, **unless** that side
   cannot move (its own walk, without the clutch, locks: it holds a fixed or held part, a loop that disagrees, or a
   ratchet that holds the turn's way) **or** it holds a body driven on its own in this turn (an animation's keyed body):
   then **it slips**: the driver side turns, the driven side stays. A driven side stops at its own joint limits and slips
   on past them; the driver side runs on.
2. **The turn starts on the driven side** (by hand, the Angle field, `model_place {angle}`, a key): **it slips**: the
   driver side stays. That is what lets a clock's hands be set without turning the train: the cannon pinion is the
   driven side, the centre arbor the driver.
3. **Both sides already move with the turn** (the clutch closes a loop with gears): it slips as it must and says so.

What counts, precisely:

- **A hand turn** (ring, Angle or Travel field, Rest): the body turned is the one driven on its own. Rule 1 or 2 by side.
- **An animation**: every keyed body is driven on its own, at every frame. Keys on both sides of a clutch are allowed
  (unlike a gear train, where they are refused): the driven side follows its own keys and the clutch slips; with keys on
  the driver side only, the driven side follows. A driven side with no key and a driver with a key: it follows.
- **A Held joint** on the driven side (or a fixed part its gears mesh with): that side cannot move, so the clutch slips.
  Held on the driver side locks the driver side's own train, as any held part does.

Each slip is said in one sentence, in the panel after a turn and in the reply's `slipped`: "Centre stays: the clutch
slips when Hand is turned on its own.", "Hand stays: the clutch from Centre slips, as Hand cannot move.".

## What it does not do

- Torque, friction, a weight's pull, a spring's push: F2. A clutch slips by the rules above, not by a force; a ratchet
  holds by its click, not by its strength.
- An expression or a table as a coupling (`couple {driver, driven, expression | table}` in the clock note): not built. A
  table coupling would make the click's lift a typed table; the click here comes from the geometry instead.
- A flexible cord (its length winding on the drum), a cord over a pulley.
- A ratchet or clutch in a train with a planet carrier (refused).
- Validation by the mesh check: a declared coupling has no gears, so `trainCheck` has nothing to ask about it. The click
  is validated by the proof above, against horology's outlines.

## Tests

- `src/gear-couplings.test.ts` (unit chain): ratios hinge to hinge, hinge to slide, slide to slide, slide to hinge and
  their lines; a train of declared couplings both ways; a loop that disagrees refused and one that agrees turning; a body
  that loses or changes its joint drops its coupling on reading; a train coupled to a fixed part locked; limits stop the
  train; the file round trip; Couple gears keeps declared couplings; an older reader's view (no gears, so 6.7 skips the
  row). Winch: its ratio and sign from the slide's direction, wind out, a turn of the drum, the cord with the weight, the
  floor (the slide's limit) stopping the drum, pulling the weight, the refusals. Ratchet: forward only on the frame; the
  click from horology's numbers, its lift by the geometry, the drop at a pitch, the ride back down and the stop, 3600.5
  degrees in one turn and in 7.3-degree steps ending at the same phase; a click on a turning part (a great wheel) with a
  train, from either end; an animation that winds two pitches and runs back one; keying a click refused; the refusals,
  the other hand included; the click proof above. Clutch: the train carries the hand, setting the hand slips, a held
  driven side slips, a driven side's limit, keys on one side and on both, the file.
- `mcp/couplings.test.ts` (unit chain, fake engine): each kind over `model_place {couple}`, turns by `angle` and
  `travel`, `gears: "list"` and `"uncouple"`, `stopped` and `slipped` in replies, remove, one `plate_undo`, save and
  reopen with every coupling (the click's phase included), and the refusals.
- `e2e/pose-couplings.spec.ts` (headless Chromium, smoke list): a project of parts on joints and nothing coupled
  (`e2e/gear-train-project.ts --couplings`); in Pose a person couples a ratio and a clutch, drags the arbor's ring (the
  wheel at 3, the hand carried), sets the hand by its Angle field (the clutch slips), couples a winch and drags the drum
  (the weight and its cord move 2πr/360 mm a degree), couples a ratchet with its click, types angles forward (the click
  lifted) and back (it stops on its seat), drags its ring, removes the clutch and undoes it, saves and reopens.
