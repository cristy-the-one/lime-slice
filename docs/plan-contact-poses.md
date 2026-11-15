# Contact in poses: a joint driven until it touches

Status: built for 6.8.0. This file is the spec (F1 of the cat clock note, `clock-function-plan.md` section 5). It extends
`docs/plan-gear-coupling.md` and `docs/plan-gear-kinds.md` (joints, `trainTurn`) and `docs/plan-assemblies.md`
(`src/interference.ts`). Kinematic contact only: no forces, no masses, no time. Hinge dynamics are F2.

The owner's standard for mechanism features: a person must be able to rely on it working, without an agent tweaking
it. So the answer comes from the geometry, the same inputs give the same answer, and what cannot be answered is refused
with one sentence.

## What a person or a script gets

"Turn the escape wheel forward until it first touches the pallet" is one question with one answer: the joint value at
first contact, the two parts that touch, and the clearance left. Or: "no contact within 360 degrees" with the range that
was searched. Nothing moves while it is asked.

- MCP: `model_place {object, until: {contact: <other part> | "any", dir: 1 | -1, max?, tolerance?, exact?}}` moves the
  joint there, one Undo step, and replies with the value, the pair and the clearance.
- MCP: `model_check {sweep}` turns a hinge that is in a gear train, with the train, and takes a fine `step` and a
  `tolerance` that the bisection pins the crossing to.
- Animation scripts (recipe API 1.15): reads of the rig at a pose the script states, `rig.first_contact`,
  `rig.clearance` and `rig.angle`, so the keys can come from the geometry.

## 1. The solve (`src/contact.ts`, shared by the window and the server, no DOM)

`firstContact(assembly, poseOf, parts, ask)`. The assembly is the one the caller holds, its expressions already read;
`parts` are each member's triangles in its own part frame (a solid's kernel mesh, a mesh part with its seat lift), as
`sampleAnimation` and the animation export take them.

**Which joint moves.** `ask.object` names a part. Its body moves (`bodyOf`: up through members seated without a joint
to the first hinge or slide). A part on a fixed body, or on a ball, is refused with its sentence. The joint moves by
`trainTurn` from where it stands: **a coupled train follows** (decided below), and every part seated on a moving body
moves with it. Each pose of the search is made from the starting assembly, never from the last pose, so no error builds
up and the same question gives the same poses.

**Which parts move.** The parts whose solved pose changes when the joint turns: found by solving at two values in the
range and comparing poses, so a hinged root that keeps its children on their pins, a planet carrier, or a held gear are
all what `trainTurn` makes them, with no second copy of its rules.

**What it can touch.** `contact: <part>`, which must not move with the joint ("Pallet turns with Wheel, so this joint
cannot bring them together."), or `"any"`: every member of the assembly that does not move. Parts outside the assembly
are not looked at (they have no pose relative to it). A pair that already crosses at the start (a pin in its hole, a
press fit) cannot be a first contact: with `"any"` it is left out and listed as `ignored`; a named part that already
crosses is refused ("Wheel already crosses Pallet where it stands: start from a clear pose.").

**The range.** `dir` is +1 or -1 (the joint's own sense: a hinge's right-hand turn about its axis, a slide's axis).
`max` is degrees for a hinge (default 360, at most 3600) or mm for a slide (default its limit that way; a slide with no
limit that way needs `max`). A joint limit of any member of the train ends the search there, and the reply says so
(`searched.limit: true`).

**The check, and its tolerance.** Contact is decided by the **mesh pass** (`interference`, `src/interference.ts`) on
the triangles above: two parts are in contact when it calls them `crossing` (or `nested`). The answer is the last pose
where no watched pair crosses, taken within `tolerance` mm of travel of the first pose where one does: no point of the
moving parts travels more than `tolerance` between the two. So the clearance at the answer is at most `tolerance` (plus
the pass's own 0.001 mm contact band), and it is measured, not assumed: `clearanceMm` is the least distance between the
two meshes at the answer (`meshDistance`, below). Default `tolerance` 0.01 mm, from 0.002 to 1 mm.

The triangles are not the solid: a curved face is a set of flat facets within the kernel's chord tolerance (0.01 to
0.05 mm on the parts here), so on a round face the mesh contact can differ from the exact one by that much. The window
has no kernel to ask, so the shared solve uses the mesh alone. Over MCP the kernel is asked as well (section 2), and a
disagreement is reported, not hidden.

**How it searches: no step to choose.** Conservative advancement. At each pose the solve measures the least distance
`d` between the moving parts and the parts they may touch, and a bound `v` on how far any point of the moving parts
travels per degree (or mm) of the joint: the eight corners of each moving part's box, turned by a small step, the
farthest one (the motion of a rigid part is affine in the point, so the box corners bound every point of the part),
times 1.1 for motions whose speed changes along the turn (a planet). The next pose is `d / v` further, which cannot
cross; when `d` is under 0.05 mm the step is 0.05 mm of travel, so the search cannot stall on a grazing face, and can
step over only a feature thinner than 0.05 mm across its motion. Every pose is also checked for crossing; the first
pose that crosses brackets contact with the last that did not, and bisection closes the bracket to `tolerance` of
travel. A search that takes more than 5,000 poses is refused with its sentence. There is no `step` to tune and nothing
random: the same assembly and question give the same poses and the same answer.

**The answer.**
`{contact: true, value, past, pair: {moving, other}, clearanceMm, searched: {from, to, limit}, toleranceMm, evaluations,
ignored, assembly, angles}`: `value` the joint at contact, `past` the first value found crossing (within tolerance of
travel), `assembly` posed at `value` for a caller that applies it, `angles` the train's joints there. No contact:
`{contact: false, searched, …}` and `assembly` posed at the end of the range, which a caller may ignore.

**`meshDistance(a, b)`**, also in `src/contact.ts`: the least distance between two triangle meshes at their poses, by
a box tree over each (the tree `interference` builds) searched pairwise with the best distance so far as the bound, and
the distance between two triangles as the least of their six vertex-to-triangle and nine edge-to-edge distances (zero
when an edge pierces the other triangle). `pairClearance` answers it for two members at a pose, with `crossing` when
the mesh pass says they cross (the distance is then 0: the depth of a crossing is not measured).

### Decided: a coupled train follows

`model_check {sweep}` on a coupled gear, and every contact solve, turn the whole train (`trainTurn`), as `model_place
{angle}`, Pose and animations do. A coupling is a constraint of the mechanism: a wheel turned alone, through its mate,
is a pose the printed parts cannot take. To turn one gear alone, uncouple first (`gears: "uncouple"`). Pairs of parts
that both move (the meshing gears themselves) are not watched: their teeth are the coupling's business and
`trainCheck`'s. A locked train is refused with its own sentence.

## 2. MCP

### `model_place {object, until}`

`until: {contact: <object> | "any", dir: 1 | -1, max?: number, tolerance?: mm, exact?: boolean}`. Given alone (no `to`,
joint, angle, travel or reach). It runs the solve on the session's assembly and moves the joint (and its train) to the
answer as one Undo step ("Pose"), writing every member's pose as `model_place {angle}` does. The reply:
`{ok, assembly, object, joint: <the moving member>, angle | travel, contact: {moving, other, names, clearanceMm,
toleranceMm, past}, searched, evaluations, ignored?, angles, moved, exact?, note}`.

No contact within the range is the refusal `no-contact` with the range searched (`searched`), and nothing moves: a
`model_place` that cannot place is a refusal, as every other.

`exact` (default true): when both touching parts are solids, the kernel's common volume (`model_check {interference,
exact}`'s measure) is taken at the answer and at `past`, with the poses put back after. The reply's `exact` is
`{atContact: {verdict, volumeMm3}, past: {verdict, volumeMm3}, agrees}`. The two passes agree when the kernel calls the
answer clear or a touch. When the kernel finds shared volume at the answer (the facets were short of the true surface),
`agrees` is false and the note says so in one sentence, with the volume; the pose is still the mesh's answer, so the
reply says which check placed it. When the kernel finds nothing at `past` the mesh pass was early by up to the chord
tolerance; that is reported too (`past.verdict: "clear"`) and is not a disagreement about the answer, which is clear by
both. A part with no solid (a mesh) is not measured, and `exact` says why.

### `model_check {sweep}`

- The hinge turns with its train (`trainTurn`), and its moving set is the parts whose pose changes, as above. A
  coupled hinge needs no uncoupling. The note says the train followed.
- `step` may be as fine as 0.01 degrees; a sweep tries at most 1,000 angles (it was 120).
- `tolerance` (degrees, default 0.5 as before, from 0.001): the bisection pins the crossing to it.
- Everything else as before: the mesh pass finds candidates, the kernel measures them, limits are not applied, poses are
  put back, nothing is undoable.

## 3. Animation: reads of the rig (recipe API 1.15)

The animation API is declarative: the script names keys, the host poses every frame after `animate`. A script that
reacts to geometry needs answers before it keys. The choice, kept small:

- **A read is a host call that takes a pose and answers a number.** The pose is a `Pose`, the same sparse value a key
  takes, resolved against the rig as it was given to the animation exactly as a key at time 0 would be (the host runs
  the same resolver, `sampleAnimation`, on a one-key animation): named joints at their aims, a train's followers turned
  with their lead, every other joint where it stands. Nothing is kept between reads and nothing moves; the script carries
  its state (the wheel's last angle) itself, in plain variables.
- Why not a stateful "current pose" on the host: it would make the order of reads matter and a read change what the next
  one answers. Why not reads inside `animate` (callbacks per frame): lust builds a plain program that talks to the host
  line by line, and a callback protocol is a new kind of run for one feature.
- The reads are methods of `Rig` that take the session, so `Rig` stays a plain value with no borrow (lust builds it as
  rustc does):

```rust
let at = Pose::new().set("Anchor", 8.0).set("Wheel", wheel);
let hit = rig.first_contact(&mut s, &at, "Wheel", 1)?;          // Option<Touch>: angle, moving, other, clearance_mm
let hit = rig.first_contact_with(&mut s, &at, &ContactAsk::new("Wheel", 1).against("Pallet").max(30.0).tolerance(0.01))?;
let gap = rig.clearance(&mut s, &at, "Wheel", "Pallet")?;        // mm; 0.0 when touching or crossing
let crossing = rig.crossing(&mut s, &at, "Wheel", "Pallet")?;    // the mesh pass's verdict
let a = rig.angle(&mut s, &at, "Third wheel")?;                  // a follower's angle at that pose
```

- `anim::frame_times(fps, end)`: the times the host samples frames at (since API 1.17 and app 6.8.0, `k / fps` for `k = 0 … ceil(end * fps)`; before, `end * i / (n - 1)`, `n = round(end * fps)`).
  Keys put on these times are what the frames show, with no interpolation between them: a pose keyed from a contact
  read is shown as read. Linear interpolation between two contact poses can cross on a curved face, so a script that
  must never show a crossing keys every frame time.
- Host calls: `rig_contact`, `rig_clearance`, `rig_angle` (added to the animation allowlist), answered by
  `src/rig-reads.ts` in both hosts (`mcp/animation-run.ts`, `src/recipe/animation-run.ts`). Each counts as a call
  (2,000 a run); the host's time answering is free of the script's 30 s (`ANIMATION_LIMITS.callsFree`).
- The level: `API = (1, 15)` in `crates/lime-recipe/src/lib.rs`, `//! api: 1.15` in a plugin that uses the reads, and a
  corpus plugin for 1.15 (`mcp/fixtures/plugins/api-1.15-rig-reads.rs`). A 1.14 host refuses a 1.15 plugin with D12's
  sentence before building it. The crate's new code is JSON in and out: lust and rustc send the same calls and get the
  same numbers, because the numbers are the host's.

## 4. Proof: an escapement-like case (`mcp/contact.test.ts`, fake engine, boxes)

A wheel hub with three radial teeth seated on it (each a box, so every mesh is real), on a hinge at the origin, and a
pallet on an anchor arm hinged above it. Over MCP on the fake engine (no kernel decides anything here):

- `model_place {until: {contact: pallet, dir: 1}}` stops the wheel with a tooth on the pallet: the clearance is at most
  the tolerance and the parts do not cross by the mesh pass; the angle agrees with the geometry worked out by hand
  (the tooth's face reaching the pallet's face) to the tolerance; a second run from the same pose gives the same angle
  to the last bit; Undo puts the wheel back.
- `"any"`, a direction with nothing in the way (no contact, refused, nothing moved), a named part that moves with the
  wheel, a part already crossing, a coupled train following (`model_check {sweep}` on a coupled gear with a fine step and
  a tolerance).
- An animation script (lust) keys the anchor's swing and, at every frame time, the wheel from `rig.first_contact` at
  the anchor's angle: the sampled frames show no crossing pair by the mesh pass, on two runs with the same keys. The
  same script built by rustc sends the same calls.

`src/contact.test.ts` holds the solve's own cases: `meshDistance` against hand-worked distances (boxes, a box turned,
a sphere), the bisection's bound on clearance, the refusals.

`mcp/contact-occt.test.ts` (CI, real Open CASCADE): the same stop on kernel solids, with `exact`, reports what the
kernel says at the answer and past it.

## 5. Pose: Until contact (the window)

A person needs no agent and no script. In Pose, a selected member whose own joint or body's joint is a hinge or a slide
shows two buttons under the joint fields, "◀ Until contact" and "Until contact ▶" (read as "Turn back until contact"
and "Turn on until contact", or Slide for a slide). A press runs the same solve against any part that stays, on the
plate meshes (each with its seat lift, as the clash check and animations take them), and moves the joint and its train
to the answer as one Undo step. One line under the buttons (a status, read by a screen reader) says what happened:
"Arm meets Stop at 15.79°, 0.003 mm left.", or "Nothing met turning Arm from 0° to -30°, where a joint limit stops it.
Nothing moved.", with any pair left out as already crossing named. The kernel is not asked in the window.

The solve runs in a worker (`src/contact-worker.ts`; on the UI thread only if no worker can be made), with the buttons
disabled and "Finding contact…" shown meanwhile, because it is not always short: measured in Node on two copies of
`samples/lime_hull.stl` (4,800 triangles each), about 220 ms for 11 poses, and on two copies of `samples/dragon_2_5.stl`
(38,000 triangles each) about 1.3 s for 14 poses; a grazing approach takes more poses. If the assembly changed while it
ran, the answer is dropped and the line says to press again. `e2e/pose-contact.spec.ts` covers it.

## What it does not do

- Forces, inertia, recoil and drop (F2). A wheel driven into a pallet that moves toward it is not pushed back: the
  solve answers only for the joint it drives, and a pair that already crosses is left out.
- Contact of two parts that both move with the joint (meshing teeth): see the coupling.
- Parts outside the assembly.
