# Hinge dynamics: an assembly run in time

Status: plan for 6.8.0, F2 of the cat clock note (`clock-function-plan.md` section 5). It builds on joints and trains
(`docs/plan-gear-coupling.md`, `docs/plan-gear-kinds.md`), declared couplings (`docs/plan-coupling-kinds.md`), mass
properties (`docs/plan-mass-properties.md`), contact in poses (`docs/plan-contact-poses.md`) and the animation output
(`docs/plan-pose-animation.md`, `docs/plan-mcp-reliability.md`).

The note's cheats this removes: the pendulum's swing prescribed as a cosine, and "whether it self-starts, keeps
amplitude, or stalls is unknown". The owner's standard for mechanism features: "the user should be able to rely on the
fact that [it] is working. not constant tweaking by an LLM". For a simulation that means:

- every number in a reply says what it was computed from and what was left out;
- a result that depends on the time step is shown to be converged, or reported as **not converged** with both values;
- nothing is presented as a prediction of a printed clock that the model cannot support;
- friction of printed plastic is not known to the app: it is an input with a stated default, and its effect is shown by
  a sweep in every clock reply, never hidden.

## What a person gets

In Pose, an assembly with a drive gets **Run**: the driven part, its drive (a torque, or a weight on a winch coupling),
the friction coefficient and the seconds. Progress and Cancel in the panel's own block; at the end the motion plays as
an animation and the panel says, in sentences: whether it runs let go as posed and from a push, the steady amplitude and how
many swings it took, the period and the rate in seconds a day against the train's designed period, the energy per beat
from the drive against the losses, how long the weight's drop lasts, and whether and where it stalls. Over MCP the same
is `motion_run`, a job (`slice_wait`, `slice_cancel`), with frames written through `pose_animate`'s writer.

## 1. The model

**Bodies.** A body is a member on a hinge or a slide with what is seated on it without a joint (`movingBody`). Its mass
and inertia come from `src/mass.ts` (exact polyhedral integrals of the closed meshes) at a density: the solid's mass, as
`model_mass` says it ("a printed part with walls and infill weighs less"). Every body's joint must sit on the assembly's
fixed root (its frame is the root): one degree of freedom each, a hinge angle or a slide's travel, about or along a line
fixed in model space. Gravity is 9806.65 mm/s² along −Z of model space, as `swing()` takes it.

Why rigid bodies on fixed axes: that is what a clock is (arbors in a frame, a pendulum on its pin, a weight on a cord),
and for it the equations are exact; nothing is linearised. A hinge body's centre of gravity turns about its line, so the
gravity torque `n·((c − p) × m g)` is worked out at every step, at any angle (the large-swing pendulum is not a small-angle
formula).

**Couplings as constraints, reduced.** Gear meshes, declared ratios and winches tie two joints rigidly
(`trainScales`). Each rigid train becomes **one generalized coordinate** `q` (its lead body's joint, in radians or mm),
every body moving `sᵢ q` (its scale, converted from degrees and mm to radians and mm). The train's inertia is the
reflected inertia `M = Σ Iᵢ sᵢ²` (a slide's mass for `Iᵢ`), its generalized force `Q = Σ sᵢ τᵢ`. Decided over stiff
springs between teeth because a spring needs a stiffness nobody knows, a step small enough for it (microseconds), and
gives tooth chatter that is the spring's, not the clock's; a reduced coordinate is exact for ideal (rigid, backlash-free)
teeth and is the same tie Pose already turns. Left out and said: tooth friction and mesh losses, backlash, tooth impacts.

- **Winch**: the drum's train includes the weight's slide body. The weight's potential energy is the drive: gravity on
  the slide body, reflected through the winch ratio, turns the train. The cord is rigid and massless; the weight does not
  swing. `drive.weight` (grams) replaces the weight body's solid mass (a can filled with coins weighs what it holds).
  A weight on a cord round a drum with no slide part is `drive: {member, weight, radius}`: the same equations with the
  weight as a point mass `m r²` on the drum. On a drum that has a declared winch, `radius` is a what-if on that winch:
  the weight's slide moves `radius / declared radius` as far a drum turn and weighs the drive's grams, counted once (no
  cord weight besides); the reply's note says so, and that the animation keys still follow the declared ratio.
  `drive.dir` is not used there: the cord winds the winch's way.
- **Ratchet**: one-way, as a unilateral constraint between the two coordinates (or one coordinate and the frame): the
  wheel's turn against its free way, relative to the click's part, cannot pass the click's seat; running free, the seat
  moves on a pitch each time the wheel passes one (the click drops into the next notch). A ratchet is not reduced into
  its train: in a running clock it holds and the two sides move together, but winding or overrunning parts it. The
  click's mass is counted with the part it sits on; its own swing, its spring and its drop are left out (said). The
  drive's sense at the escape wheel is carried through the ratchets that hold (the drive turns them against their free
  way); a drive that turns a ratchet its free way never reaches the wheel and is refused with a sentence.
- **Clutch**: here a torque finally exists. A clutch is Coulomb friction between its two coordinates with a capacity
  `clutch` (N·mm, default 5: a guess for a printed friction fit, named in every reply that has a clutch). It carries the
  driven side while the torque needed stays under the capacity and slips above it. The kinematic rule of
  `docs/plan-coupling-kinds.md` is this rule's limit: a free driven side is carried (the torque needed is small), a held
  side slips (no capacity can move a part that stays). A keyed side does not exist in a run.
- **Planet carriers** (a gear hinged on a turning part) are not modelled: refused.

**Pivot friction.** A Coulomb torque at each pin, `μ · r_pin · N`, with `N` the pin's static load: the body's weight,
and for a drum also the cord's pull. Decided over a constant drag torque because the coefficient is the number a person
can look up or measure, it scales with load (a heavier bob loses more, as on the bench), and it stops a part dead at
rest (a drag does not); decided over the full pin load because gear-tooth forces need tooth geometry a coupling does not
carry. Left out and said: tooth forces on the pins, the centripetal part of the pendulum's pin load (a fraction of a
percent at clock amplitudes). On a train the bound reflects: `F = Σ |sᵢ| μ r Nᵢ`. Slides are frictionless (a hanging
weight touches no guide). An optional viscous term `viscous` (N·mm·s per radian, per hinge, default 0) stands for air.

**Defaults.** `friction` 0.3 (horology's plastic on plastic, used for pivots and pallets alike), `pinRadius` 1.5 mm
(the clock's 3 mm steel pins), `restitution` 0 (a drop is dead: no bounce), density the filament's. Each is in every
reply's `inputs`, and the friction sweep (section 4) shows what the answer does with friction.

**Joint limits** are stops on a coordinate: unilateral, with the same restitution.

## 2. Contact: an analytic Graham escapement, checked against the meshes

Decided: **(b), an analytic escapement element built from `horology`'s Graham numbers, checked against (a) the meshes
when a run is set up.**

- (a) alone is out of reach: `meshDistance` costs about 0.2 s for two 4,800-triangle parts; a 60 s run at the default
  step is 600,000 steps, so 33 hours for one run. Contact tables built once from `firstContact` (the note's section 3)
  would give the wheel's stop angle against the anchor's angle, but not the contact normal and lever arms that forces
  need, and their error is the table's spacing (0.25 to 0.6 degrees in the note's table).
- (b) is exact for a Graham escapement as `horology` builds it, costs microseconds a step, and its forces have exact
  normals and lever arms. horology's own clash check guarantees the pallets meet the wheel only at the tooth tips over the
  whole beat, so the element is a tip point against two pallet faces each (the locking arc about the pivot and the
  straight impulse face), nothing else.
- (b) is checked against the parts. The numbers are matched to the meshes when a run starts: the frame's sense from the
  wheel's teeth (which way they lean), the wheel's phase from its tip vertices, the anchor's angle from its four pallet
  corners, each to 0.02 mm, and the anchor's pivot at horology's pivot distance from the wheel's axis to 0.05 mm. Then
  the element's least gap at the start pose is compared with `meshDistance` between the two meshes: they must agree to
  0.1 mm (the meshes' chords). Before that, a pallet more than 0.02 mm inside a tooth is refused (the meshes' distance
  reads 0 for parts that overlap, so the comparison alone let a wheel not phased for its anchor pass): the refusal names
  the tooth, the pallet and its face, and the wheel turn either way that clears it. Any miss is a refusal that says which
  number did not fit. An escapement that is not
  horology's (a recoil anchor, hand-drawn pallets) is refused: "only a Graham escapement built from horology's numbers
  is covered".

Contact force law at a tooth tip: no penetration velocity, Newton restitution `e` on the approach speed, Coulomb
friction `μ` along the face (`friction`, or `palletFriction` when given).

What it must conserve, and the tests that show it:

- a frictionless pendulum keeps its amplitude (to 1e-6 relative energy over 100 swings) and its period matches
  `swing()` at small amplitude (to 1e-5) and the elliptic-integral period at 30 degrees (to 1e-5);
- in a running escapement, energy is accounted for: drive in = pivot friction + pallet friction + impacts + the change in
  kinetic and potential energy, with the residual under 1 % of the drive's work (it is the integrator's, and it shrinks
  with the step).

## 3. Integration

Decided: **Moreau's midpoint time stepping** (Moreau–Jean), fixed step.

- Free motion is the position Verlet (Störmer–Verlet) scheme: half a step of positions, a whole step of velocities under
  the forces at the midpoint, half a step of positions. It is symplectic and second order: a frictionless pendulum's
  energy oscillates within O(h²) and never drifts, and its period is off by `(ωh)²/24`, 3·10⁻⁸ at the default step on a
  0.75 s pendulum.
- Contacts, impacts and every Coulomb friction (pivots, pallets, clutch) are velocity impulses solved together at the
  midpoint of each step (projected Gauss–Seidel over a handful of rows: normal impulses ≥ 0, friction within its bound,
  restitution on the approach speed). A click's seat moves on at the step where the wheel passes a pitch.
- **Speculative contacts.** A tooth tip within half a step's travel of a face gets its row before it touches: its
  velocity may close the gap by the step's end and no more (with restitution `e > 0` it rebounds instead). Found by
  measurement: activating a contact only once its gap is ≤ 0 lets it go in by up to a step's travel, and the rate then
  moved 24 s a day between `dt` 1e-4 and 5e-5.
- **Events.** A step in which a contact is made or broken (the contacts within 0.1 µm at its start and at its predicted
  end differ) or a speculative contact closes is made again as 8 sub-steps, and once more inside those: an impact, a
  lock or a let-off is placed to `dt / 64`. Between events the step stays `dt`, so the free motion keeps its symplectic
  step and the cost is that of a fixed step (a few events a beat).
- A tip sliding off the impulse face past its let-off corner leaves it: that corner is a contact only for directions
  between the impulse face's normal and the pallet's back (found by a run whose amplitude dropped by a third once in 25
  beats: the corner had been taken as a wall along the slide).
- Default `dt` 0.00005 s (15,000 steps a period of a 0.75 s pendulum); 1e-6 to 0.002 s may be given. Measured on the
  test clock (section 8): the period at 1e-4, 5e-5 and 2.5e-5 s differs by 2.8 and then 0.6 s a day.

**Convergence, in every run.** The run is repeated at `dt / 2`. The period, the settled amplitude, the rate and the
class of answer (running, stopped, past the locking faces) must agree: the period to 1 s a day, the amplitude to 1 %
(or 0.02 degrees), the class exactly. If they do not, the reply says **not converged** and gives both values and both
steps, never one number. A swing settled at one step and still settling at the other is not a time-step matter and is
not counted against convergence. The sweep's runs (section 4) are made at `dt` only and say so.

**Settled.** A swing is settled when each side's turning points over the run's last 10 periods, fitted by least
squares against time, change less than 0.002 degrees a period (at least 6 turning points a side). Each side's mean and
slope are in every run and sweep row (`plusSideDeg`, `minusSideDeg`, `trendDegPerPeriod`, `beatDifferenceDeg`), so a
swing that still swells and alternating beats are both visible. The settled amplitude is the mean of the two sides'
means; "after N periods" counts from the start to the first turning point from which every later one stays within 1 %
(or 0.02 degrees) of its side's mean. Found by the cute-clock note: the old rule (the last ten turning points within
1 % of their mean, both sides mixed) called a swing settled while it grew 0.005 degrees a period, and missed a run
steady to 0.006 degrees. The period is the mean over the crossings since the swing settled, or over the window's when it
has not (then marked `periodSettled: false`).

**Agreement of the starts.** When the run let go as posed and the run from the push both settle, their amplitudes and
periods are compared (`agree`, the same tolerances); a difference is said, not folded into convergence: a steady swing
that depends on how the clock starts is a property of the model, not of the step.

**A confirmed stall ends the run.** Once the escape wheel has moved less than half a tooth over three free periods and
the largest swing in them is below the let-off and not growing, the run stops there (`endedAtS`): nothing after it can
change. A stalled run used to integrate to the end, 5 to 10 minutes of the owner's agents' time.

**Overswing.** The locking faces end at half the swing plus the supplementary arc. An anchor that swings further has
left the geometry horology drew (in the print, the tooth would run off the pallet onto the arm), so the run reports the
overswing, when and how far, and gives no amplitude or rate. Found by a run with frictionless pallets, whose amplitude
grew past 4 degrees.

## 4. What a run answers

From a run of `seconds` of an assembly with an escapement (or a pendulum alone), each with its inputs named:

- **Let go as posed** (`fromRest`), and from a push of `push` degrees from where the pendulum hangs. "As posed" is the
  pose as it stands, which may be off the pendulum's gravity rest: `releaseDeg` says how far, and the sentence says "let
  go as posed, the pendulum X° from where it hangs" (or "hanging still"). `selfStarts` means it runs when let go from
  that pose, not from hanging still. A Graham escapement hanging still never starts in a deterministic model, so there is
  no "start from rest" mode; with `findStart: true` the reply gives instead the smallest push from where the pendulum
  hangs (the wheel as posed) after which it is still running at the probe's end (6 s or 8 free periods): short runs at
  `dt`, bisected to 0.05 degrees, assuming a larger push starts it whenever a smaller one does. Off by default: on the test
  clock it adds about 6 s, a third of a 20 s job. The default push, with an escapement, puts the anchor
  `min(1, supplementary / 2)` degrees past the let-off, measured from the anchor's middle, so the release unlocks and
  stays on the locking faces (`let-off + 1`, the old default, was the faces' very end with a 1 degree supplementary arc,
  and the push run "overswung at 0 s"); without one, 5 degrees.
- **What it does** (`state`, and the verdict from the push run): **runs** needs about one tooth a period over the last
  window (within 10 %) and a swing that is not falling; **not settled**, the wheel turns but the swing falls more than
  the settled slope or the run is too short to judge; **stalls**; **overswings**. With a pendulum and no escapement
  nothing gives it energy, so it never "runs": **swings** (holds its swing), **swings, decaying** (in degrees a period,
  and when it stands still) or **still**.
- **Steady amplitude** (degrees each side of rest) and how many swings it took to reach it (the first swing from which
  every swing stays within 1 % of the last ten's mean), and the amplitude over time.
- **Period** and **rate** in seconds a day against the train's designed period: `designPeriod`, or worked out from the
  train with `hand: {member, turnsPerHour}` (the escape wheel passes one tooth a period). Also the pendulum's free
  small-swing period from `swing()`, so the escapement's and the amplitude's share of the rate is visible.
- **Energy per beat**: the drive's work against the losses: each arbor's pin on its own line (a train's pins slip
  together, so its loss splits exactly by `|s_k| · pin bound_k / the train's bound`), the pallets' friction, the
  impacts (drops and locks), and the integration residual. A loss below 0 is the integration's error in booking a row's
  work over the step's mean velocity; the sentence says so. (Booking each solver update's kinetic-energy change instead
  was tried: from the free velocity it charges a held ratchet h²F²/2M a step, five times the drive's work on a ratchet
  clock; measured from half the force's increment it closes the balance but splits coupled rows arbitrarily, a drum's
  pin going negative. The per-row work is kept.)
- **Run time** of the weight's drop: the weight's speed over the window, against `drop` mm when given and the distance
  from where the weight starts to its own slide's limit on the side it falls toward (the falling sense from its travel
  over the window), both said when known.
- **Stall**: from the run's own history: when the wheel stopped (0 if it never turned a tooth) and how many teeth it
  passed, the largest swing and when (a release from standing still is the first turning point), since when the
  pendulum has stood still, the anchor's largest reach from its middle against the let-off ("it never unlocks" when it
  fell short), and where it rests: which pallet face holds which tooth and the anchor's angle; or that the train never
  turns because its pivot friction exceeds the drive. Every turning point carries its side.
- **Friction sweep**: the same run at friction 0.1 to 0.5 (or `sweep`), each row with its state, the last swing, each
  side's mean and trend, a period (marked unsettled when it is), the rate, and `why` where a value is missing, so a
  person sees whether the clock runs only on optimistic friction.

Every reply has `inputs` (density, friction, pin radius, restitution, drive, dt) and `leftOut`: tooth friction and mesh
losses, backlash, the click's own swing and spring, the cord's stretch and the weight's swing, infill (solid mass), air
(unless `viscous`), the pin's tooth loads, temperature and wear. A person reads the rate as **the model's** rate: a
printed clock is set by its sliding bob, as the note says.

## 5. Scope and refusals

Planar mechanisms on parallel axes, every joint on the fixed root. Refused, each in one sentence:

- a ball joint: "X turns on a ball joint: only hinges and slides are covered.";
- hinges not parallel: "X's hinge is not parallel to Y's: only mechanisms on parallel axes are covered.";
- a joint on a moving part (a planet on a carrier, an arm on an arm), a ratchet's click excepted: "X is hinged on Y,
  which moves: only parts whose joint sits on the frame are covered.";
- a root on a hinge: "The root turns on a hinge of its own: a run needs a fixed frame.";
- a locked train (its own sentence from `trainScales`), a planet carrier in a train;
- an open mesh (`model_mass`'s sentence);
- a drive with nothing to turn: "X does not move: it has no joint, or it is held.", a weight with no winch and no radius:
  "A weight hangs on a cord: couple a drum to the weight's slide (Winch), or give the drum's radius.";
- an escapement whose numbers horology refuses (horology's sentence), or that does not fit the parts (which number); a
  pallet inside a tooth (the tooth, the pallet, the wheel turn that clears it); the wheel and the anchor on one train;
  the drive turning the wheel against its teeth; a drive that turns a ratchet its free way.

## 6. Where it runs

`src/dynamics.ts` (the model and the step) and `src/motion.ts` (runs, the convergence check, the analysis, the reply,
the frames as animation keys) are shared, no DOM. The window runs a job in a worker (`src/motion-worker.ts`), with the
same code in slices on the thread when no worker can be made; the MCP server runs `motion_run` as a detachable,
stoppable job, giving the event loop a turn between slices so `slice_wait` and `slice_cancel` are heard. Progress is the
simulated time over the asked time, through every run of the set (main, half step, push, sweep).

Budget: the escapement element is a few microseconds a step; measured numbers are in section 8 once built.

**Frames.** A run's trajectory becomes a `PoseAnimation` with a key per frame (each train keyed on the body that carries
the drive, so a ratchet stays engaged as in the run, and the pendulum's body), sampled by `sampleAnimation` and written by
`pose_animate`'s incremental GIF and PNG writer (one frame held at a time, `.partial` names, cancel between frames). Pose
plays the same keys.

**A part's frame and its mesh.** Joints are read in each member's own part frame (`modelPose`); a mesh part's triangles
are kept dropped onto the bed and placed by its seat lift then `modelPose`. A run carries both (`DynPart.frame` and
`pose`), so a hinge's pivot is where Pose draws it whatever the mesh's seat.

## 7. Stages

A. Free and driven bodies: the model from the assembly, the integrator, pivot friction, limits, energy. Tests against
   closed forms. B. The Graham element (port of horology's construction, held to the crate under lust), the ratchet,
   restitution, stall. C. `motion_run` over MCP. D. Run in Pose.

## 8. Measured (filled in as each stage lands)

The test clock (`src/escapement.test.ts`): horology's 30-tooth wheel, tip 22.5, root 17.5, lean 12°, span 7.5 teeth,
default lock, impulse and drop, extruded 4 mm thick; a 3 × 3 × 140 mm rod and a 30 × 6 × 30 mm bob on the anchor (8 g,
free period 0.7386 s); 0.25 N·mm on the escape wheel; friction 0.3 on 1.5 mm pins; PLA 1.24 g/cm³.

| Check | Measured |
|---|---|
| Compound pendulum at 1° against `swing()` with its elliptic correction | 3.0e-8 relative |
| The same at 30° against the elliptic period | 2.6e-8 relative |
| Frictionless, 100 swings: energy | within 1.8e-7 of the swing's |
| Weight on a drum with pivot friction, θ(1 s) against ½αt² | 2.6e-13 relative |
| Weight on a winch, fall in 0.1 s against ½at² | 4.5e-14 relative |
| Two wheels coupled at 3 against τ/(I₁ + 9I₂) | exact to 1e-9 |
| Wheel stopped by pivot friction, turns against Iω²/(2τ) | 3.3e-10 relative |
| Stop with e 0.5: rebound speed | 0.5 to 1e-9 |
| Graham port against the crate under lust (4 escapements, about 1,000 numbers each) | within 7.5e-14 mm |
| Escapement fitted to its meshes: corners; element gap against `meshDistance` | 0.00000 mm; 0.1204 against 0.1204 mm |
| The anchor's pendulum alone at 1°, period against `swing()` | 7.2e-9 relative |
| Test clock from a 3.5° push: steady 3.124°, one tooth a period, energy per beat | drive 26.18 µJ = losses 26.18 µJ; residual 0.0000 % |
| Its period against the free period at that amplitude | +5.97 % (the pallets' friction on an 8 g pendulum) |
| 27 g bob, 0.18 N·mm, friction 0.15: period against free | within 1 % (0.86 %) |
| Period at dt 1e-4 / 5e-5 / 2.5e-5 s (test clock) | 0.7828060 / 0.7827808 / 0.7827754 s |
| Cost a step, the test clock | about 3.5 µs |
| One 60 s run of the test clock at dt 5e-5 s (1.2 million steps) | 4.2 s (Node) |
| A whole 60 s `motion_run` / Pose Run: from rest and from a push, each at dt and dt/2, and five sweep runs | 143 s (Node). Re-measured 2026-11-16 on one machine: 176 s before, 35 s once a confirmed stall ends its run (the runs let go as posed, and the sweep's stalled ones, stop at 2.25 s): the stalled runs were most of the cost |
| The test clock driven by a 200 g weight on a 10 mm drum through 60:1, a hand at 1/120: rate against the designed 1 s, run time | 86400 (1/T − 1) to 0.01 s a day; 159.4 mm an hour, 1.88 hours to the slide's limit |

**Budget.** The cost is the steps: about 20,000 a simulated second at the default step plus a few refined events a
beat, so about 0.07 s of computing a simulated second for one run, and eleven runs make a clock's answer. A 60 s clock
is therefore a job of about two and a half minutes; a 20 s one, under a minute. Geometric contact was never in the
loop (section 2).

**What a reply says** (the test clock, `motion_run` on the fake engine, 12 s):

> Let go as posed, the pendulum hanging still, it does not run: the escape wheel never turns a tooth; the pendulum does
> not swing; it never unlocks: the anchor reaches at most 1.985° from its middle (at 0.36 s), short of the 2° let-off;
> the pendulum has stood still since 0.36 s; a tooth rests on the entry pallet's impulse face; the anchor stands
> -1.985° from its middle position; the run ended at 2.25 s, the stall confirmed (three periods with less than half a
> tooth and the swing below the let-off, not growing).
> From a 3.5° push (the anchor 3.5° from its middle; it unlocks at 2°), it runs: the escape wheel turns a tooth a period
> and the swing settles at 3.125° each side after 3 periods (each side changing less than 0.002° a period over the last
> 10 periods), period 0.782755 s.
> The pendulum's free small-swing period is 0.738562 s (mass properties, no escapement); at the run's 3.125° the free
> period is 0.738699 s.
> Each beat over the last 8 periods the drive gives 26.18 µJ; it goes to pivot of Escape wheel 2.41, pivot of Anchor
> 4.459, impacts (drops and locks) 6.257, pallet friction 13.055 µJ; the integration residual is 0 % of the drive's work.
> It runs only at friction 0.3 of 0.3, 0.6 (at 0.6 it stops): the answer depends on friction the app does not know.

For a drive too weak for its pivots (0.04 N·mm) the stall reads "the escape wheel stops at 1.05 s, after 2 teeth; ...; a
tooth rests on the entry pallet's impulse face; the anchor stands -1.705° from its middle position". For 0.1 N·mm and a
1.5° push the other way (the cute-clock note's job_38, rebuilt), the pendulum swings back to 1.557° at 0.42 s and stands
still: the reply gives that swing and "it never unlocks", where it used to say "it never starts ... the pendulum swings
0° each side". With `findStart`, the test clock's smallest push is 2.063° (2.016° is not enough), just past the 2°
let-off.
