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
an animation and the panel says, in sentences: whether it starts from rest and from a push, the steady amplitude and how
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
  weight as a point mass `m r²` on the drum.
- **Ratchet**: one-way, as a unilateral constraint between the two coordinates (or one coordinate and the frame): the
  wheel's turn against its free way, relative to the click's part, cannot pass the click's seat; running free, the seat
  moves on a pitch each time the wheel passes one (the click drops into the next notch). A ratchet is not reduced into
  its train: in a running clock it holds and the two sides move together, but winding or overrunning parts it. The
  click's mass is counted with the part it sits on; its own swing, its spring and its drop are left out (said).
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
  0.1 mm (the meshes' chords). Any miss is a refusal that says which number did not fit. An escapement that is not
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
  restitution on the approach speed). A contact is active when its gap at the midpoint is ≤ 0. A click's seat moves on
  at the step where the wheel passes a pitch.
- Impacts are captured at the step they happen in, not located inside it: this is first order at an impact. That is why
  the convergence check below is part of every run, not an option.
- Default `dt` 0.0001 s (7,500 steps a period of a 0.75 s pendulum); 1e-6 to 0.002 s may be given.

**Convergence, in every run.** The run is repeated at `dt / 2`. The period, the steady amplitude, the rate, whether it
self-starts and whether it stalls must agree: the rate to 1 s a day, the amplitude to 1 % (or 0.02 degrees), the
verdicts exactly. If they do not, the reply says **not converged** and gives both values and both steps, never one
number. The sweep's runs (section 4) are made at `dt` only and say so.

## 4. What a run answers

From a run of `seconds` of an assembly with an escapement (or a pendulum alone), each with its inputs named:

- **Self-start**: from rest as posed, and from a push of `push` degrees (default the let-off plus one degree): whether
  the pendulum's amplitude grows to a steady swing.
- **Steady amplitude** (degrees each side of rest) and how many swings it took to reach it (the first swing from which
  every swing stays within 1 % of the last ten's mean), and the amplitude over time.
- **Period** and **rate** in seconds a day against the train's designed period: `designPeriod`, or worked out from the
  train with `hand: {member, turnsPerHour}` (the escape wheel passes one tooth a period). Also the pendulum's free
  small-swing period from `swing()`, so the escapement's and the amplitude's share of the rate is visible.
- **Energy per beat**: the drive's work against the losses: the pendulum's pivot, the train's pivots, the pallets'
  friction, the impacts (drops and locks), and the integration residual.
- **Run time** of the weight's drop: the slide's travel to its limit (or `drop` mm) over the weight's mean speed.
- **Stall**: whether it stops, when, and where: which pallet face holds which tooth, the anchor's and the wheel's
  angles; or that the train never turns because its pivot friction exceeds the drive.
- **Friction sweep**: the same run at friction 0.1 to 0.5 (or `sweep`), each saying runs or stalls, amplitude and rate,
  so a person sees whether the clock runs only on optimistic friction.

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
- an escapement whose numbers horology refuses (horology's sentence), or that does not fit the parts (which number);
  the wheel and the anchor on one train; the drive turning the wheel against its teeth.

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

## 7. Stages

A. Free and driven bodies: the model from the assembly, the integrator, pivot friction, limits, energy. Tests against
   closed forms. B. The Graham element (port of horology's construction, held to the crate under lust), the ratchet,
   restitution, stall. C. `motion_run` over MCP. D. Run in Pose.

## 8. Measured (filled in as each stage lands)
