# Lever can press: why the animation is "cheated", and how the GIF works around it

Project: `C:\Users\mariu\lime-workspace\can-press` (git, main). Build plugin `lever-can-press`
(`recipes/can_press.rs`), animation plugin `lever-press-stroke` (`recipes/press_stroke.rs`).

Members: Frame, Guide rods, Chamber (fixed); Lever (hinge on Frame at [0,0,280], axis [0,-1,0]);
Link L / Link R (hinges on the Lever at the crank pin); Ram (see below).

The mechanism is a crank-slider (toggle): lever crank r = 35 → link L = 110 → ram pin on x = 0.
Ram pin height: zr(θ) = zp + r·sinθ − sqrt(L² − (r·cosθ)²), θ = 100°…250°, stroke 66.9 mm.

## What lime-slice should have been able to do

1. **A slide (prismatic) joint that can be keyed or dragged.** The ram slides on two guide rods, but
   pose_animate refuses keys on a slide ("a slide moves with its pinion"); a slide moves only through a coupling.
2. **A closed-loop, non-linear constraint**: "the link pin stays on the ram pin" (a pin-on-pin or point-on-line
   constraint), solved for the whole loop. You would key or drag only the lever, and the links and ram would
   follow exactly, in Pose and in animations. lime-slice has no loop solver:
   - Couplings are linear only (ratio, winch, ratchet, clutch): a fixed number of degrees or mm per degree.
   - `reach` IK turns one open chain, and the ram is not in the lever's chain.

So in Pose, dragging the lever moves the lever only. The links swing with it (they are its children) and leave the
ram pin, and the ram stays put.
- The best linear ratio coupling (link −0.918 deg/deg; ram 1.16e-4 deg/deg on the 200 m pivot) still leaves the
  link up to ~17.7 mm off the pin and the ram ~7.5 mm off.
- End-to-end ratios are worse: 26 mm and 9.4 mm.

The user rejected the approximation, so no coupling was added.

## How the GIF was made to look right

a) **The ram is not a slide.** It is a hinge whose pivot is 200 m away (pivot [200000, 0, zr0], axis [0,-1,0],
   limits ±0.5°). Keying angle a = asin(drop / 200000) moves it almost straight down. A first try at 20 m drifted
   sideways by dz·sin(a): 0.7 mm at the platen, 150 mm below the pin. That is more than the 0.4 mm bush clearance,
   and the collision check caught it.

b) **The animation script does the kinematics itself.** For each θ it computes three angles and writes them into
   every key:
   - the lever angle: θ − θ0;
   - each link's angle relative to the lever: (φ − φ0) − (θ − θ0), where φ is the crank-pin → ram-pin direction.
     This reaches about −147°, so the link limits are ±180°;
   - the ram's far-pivot angle.

c) **One key on every frame** (`anim::frame_times`, `Ease::Linear`). With only 12 keys per stroke, interpolating
   between them let the links leave the ram pin mid-stroke (Ram × Link collisions on 22 frames). Exact per-frame keys
   gave 0 warnings over 145 frames, at the defaults and at a larger variant.

d) **The animation takes the build's geometry params again** (height, crank, link, crank_up, crank_down). It cannot
   read them from the assembly, so they must match the build.

Net result: the motion is exact only inside that one script. The assembly itself has no relation between its joints.

## What to ask lime-slice for

- A solved linkage constraint (pin-on-pin / point-on-line closing a loop), **or**
- a table/curve coupling (driven = f(driver) from sampled pairs),
- plus keyable or draggable slides.

With either constraint, `lever-can-press` could declare the loop itself and dragging in Pose would be exact.
