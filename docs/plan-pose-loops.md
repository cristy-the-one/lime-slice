# Plan: closed loops and keyable slides in Pose

Status: plan, for review. Written 2026-11-27 against `main` at v7.6.1 (`bc8d4a9`, the merge of #892). Docs only: no code changes with this plan.

The source is the owner's can press (`C:\Users\mariu\lime-workspace\can-press`, note `notes/ANIMATION-LIMITATION.md`). It is a lever, two toggle links and a ram on guide rods: a crank-slider. Lime Slice cannot hold that mechanism together, so the recipes cheat:
- the ram is a hinge 200 m away instead of a slide, because a slide cannot be keyed;
- the animation script works out the links' and the ram's angles itself and keys all three on every frame, because nothing keeps a link's pin on the ram's pin;
- in Pose, dragging the lever moves the lever and its links only, and the links leave the ram.

The owner asked for this to be addressed.

## 1. Goal

A person can:

1. Key a slide's travel in an animation, drag it in Pose along its axis, and let Reach use it, as a hinge is used today.
2. **Close a loop**: say that a point on one member stays on a point of another member (a pin), or on a line of it (a pin in a slot), even though neither is the other's parent.
3. Turn or key **one** joint of a loop (the lever), and see every other joint in the loop follow exactly: in Pose while dragging, in `model_place`, in a recipe's `turn_joint`, and on every animation frame.
4. See a loop that cannot close (a link too short, a joint at its limit, a toggle at its dead point) stop where it last closed, with a reason, as a joint stops at its limit today.

The test case is the can press. `lever-can-press` declares the ram as a slide on the frame, and a pin from each link's far end to the ram's pin. `lever-press-stroke` keys only the lever. Done means:
- the GIF matches today's, with every link pin within 0.01 mm of the ram pin on every frame;
- 0 collision warnings over the 145 frames, as now;
- dragging the lever in Pose moves the links and the ram with it.

### Non-goals

- No physics. `motion_run` does not take loops in this plan (D4).
- No table or curve coupling ("driven = f(driver)"). The note offers it as an alternative; a solved loop is exact and needs no sampling, so the table is left for later (section 8).
- No change to the slicer, the G-code, the slice cache or the kernel. A pose is model space.
- No change to project version. It stays 4; `closures` is a new optional field on an assembly (section 5).

## 2. Current state

From `main` at `bc8d4a9`:

- **Tree only.** An assembly is a tree from one root (`src/assembly.ts:163`). `solveAssembly` (`assembly.ts:286`) walks it breadth-first, a child's pose composed onto its parent's. `withMember` (`assembly.ts:431`) and `rerooted` (`:603`) refuse anything that would make a loop: "That would make a loop".
- **Joints.** `hinge {pivot, axis, angle, min, max}`, `ball {pivot, cone, rest}`, `slide {pivot, axis, travel, min, max}` (`assembly.ts:24-31`). A joint's value is baked into the member's `offset`/`turn` when it moves (`turnHinge`, `moveSlide`, `turnBall` in `src/pose.ts`).
- **Couplings** (`src/gear-train.ts`) are linear: ratio, winch, ratchet, clutch, gears, and the planetary solve. A coupling "loop" there means ratios that must agree, not a kinematic loop.
- **Reach** (`solvePose`, `pose.ts:180`) is cyclic coordinate descent over one open chain, and skips slides (`pose.ts:207`).
- **Slides cannot be keyed.** `resolveAim` (`src/pose-anim.ts:73`) refuses: "A slide moves with its pinion: key the pinion's angle". The sampler only interpolates angles and rotations (`:110`, `:362`), the Turn gizmo hides its ring for a slide (`src/app/pose.ts:601`), and Rust's `anim::Aim` has no travel (`crates/lime-recipe/src/lib.rs:7822`). Slides move only through the panel's Travel field, `model_place {travel}`, or a pinion or winch coupling.
- `docs/plan-pose.md` section 9 already names the next solver ("several pinned or dragged points solved together, such as damped least squares on the joint angles"). This plan is that solver, with a pin as the pinned point.

## 3. Slides that move like hinges (L1)

- **Keys.** A number keyed on a slide is its travel in mm, as a number on a hinge is its angle in degrees. `min`, `max`, `rest` and `{fraction}` work as on a hinge. A slide driven by a coupling (a rack on a pinion) keeps today's rule: one lead member per gear train, so the pinion is keyed, and keying the rack too is refused with the existing message.
- **Sampler.** `atTime` lerps travel like an angle; the first value of a slide track is its `travel`; `key.rest` includes slides.
- **Drag.** The Turn tool on a slide shows an arrow along its axis instead of a ring, and dragging it moves the travel, clamped to its limits, through `trainTurn`, so a rack turns its pinion.
- **Reach.** `solvePose` gives a slide a step: the error projected onto its axis, clamped. A chain with a slide in it can now reach.
- **Rust.** `anim::Aim` gains `Travel(mm)`; `Pose::set` on a slide takes mm. `Session::turn_joint` already takes mm for a slide.
- **MCP.** `pose_animate` keys accept mm on a slide; the schema text says so. No new field.

L1 needs no loop and lands first: it removes the 200 m hinge on its own.

## 4. Closed loops (L2)

### Data

```ts
interface Closure {
  id: string;
  /** A point on member `a`, in its part frame. */
  a: { member: string; at: [number, number, number] };
  /** A point on member `b`, in its part frame; for a line, the line's direction in b's frame too. */
  b: { member: string; at: [number, number, number]; along?: [number, number, number] };
  /** pin: the two points meet. line: a's point stays on the line through b's point along `along`. */
  kind: "pin" | "line";
}
interface Assembly { /* as now */ closures?: Closure[] }
```

A pin leaves the members free to turn about it (a hinge pin is a pin closure; its axis comes from the joints around it). A line is a pin in a slot. Both members must be in the same assembly, and neither may be the other's parent: that is an ordinary joint.

### Solve

After forward kinematics places every member from its joint values, each closure has an error: a 3-vector for a pin, the part of it across the line for a line. The **loop joints** are the joints on the path from each closure's two members up to their common ancestor. Those not being driven are free; everything else stays as set.

The solver is damped least squares (Levenberg–Marquardt) over the free joints' values:
- the Jacobian is numeric, one forward solve per free joint;
- it is warm-started from the last pose, so a toggle keeps its branch and does not flip through to its mirror solution;
- limits are kept by clamping each step and dropping a clamped joint from the next step;
- it stops at 1e-4 mm.

A loop of the can press's size (3 free values, 6 equations) closes in a few iterations, well under a millisecond.

If it cannot close to 0.01 mm, the move that asked for it is clamped back to the last value that closed (bisection on the driver's step), and the reply or the status line says why: "The loop between Link L and Ram cannot close past 247.3°: Link L is at its limit." This is the same behaviour as a joint limit today.

### Where it runs

The solve runs wherever a joint value changes:
- `turnInAssembly` and `trainTurn` (Turn drag, the panel's Angle and Travel fields, `model_place {angle|travel}`, `turn_joint`);
- `solvePose` (Reach);
- `sampleAnimationSteps` per frame, after keys and couplings are applied;
- `readAssemblies` on load, to close any loop that a hand edit left open.

Couplings apply first, then closures. A free loop joint that belongs to a gear train moves its train with it.

### Rules

- Keying a joint whose value a closure sets (a loop's free joint) is refused: "Link L follows the loop through Ram: key the lever." Which joints are free depends on what is keyed, so the sampler decides at validation: the keyed joints drive, the rest of each loop follows. A loop with no keyed joint keeps its pose.
- A loop over-constrained by its keys (two keyed joints that disagree) is refused at validation with the frame where it fails to close.
- `motion_run` on an assembly with closures is refused: "Loops are not simulated yet" (D4).

## 5. Saving, reading and old files

- `closures` is saved on the assembly in the project envelope next to `couplings`. The project version stays 4.
- An older app ignores the field, so a loop opens there; a save from that older app drops it. The same holds for any field added since 4. Under "clean over compat", that is accepted and noted in the release notes.
- `readAssemblies` drops a closure whose members are gone or not in the assembly, as it drops a coupling that no longer fits.

## 6. Where it goes (CLAUDE.md)

| Question | Slides (L1) | Loops (L2, L3) |
|---|---|---|
| 1. Stage | Pose | Pose |
| 2. Home | The Turn tool (arrow on a slide) and the panel's Travel field, as today | The **Joint** tool: a "Close a loop" section that picks a point on the selected member and a point on another (D1) |
| 3. Command | none new (`pose-turn`, key R) | `pose-close-loop`, label "Close loop", group Tools, no key at first (D2) |
| 4. When it can't run | A slide at its limit: the arrow stops, as a ring does | Shown disabled with the reason: no assembly, one member picked, both in one chain already ("Link L is already Ram's parent: that is a joint, not a loop") |
| 5. Word | "travel" (label, MCP field and guide already say so) | "loop" in the UI, guide and MCP (`model_place {loop}`), "closure" in code only (D1) |
| 6. Undo | Ctrl+Z in Pose, one step per drag | Making or removing a loop is one Ctrl+Z step; a drag that the loop follows is one step, as now |

## 7. Milestones

| Id | What | Size |
|---|---|---|
| L1 | **Slides keyable, draggable, reachable** (section 3): sampler, Turn arrow, Reach step, Rust `Aim::Travel`, schema text. e2e: key a slide in `pose_animate`, drag a slide's arrow, Reach through a slide. | small to medium |
| L2 | **The loop solver and its data** (section 4): `Closure`, read and save, the damped least-squares solve after FK, clamping and reasons, the solve in turn, Reach, the sampler and load. MCP `model_place {loop: {to, at, toAt, along?}}` and `{unloop}`; Rust `Session::close_loop(&a, at, &b, at)` and `close_loop_on_line(...)`. Unit tests on a four-bar, a crank-slider and a toggle at its dead point. | medium to large |
| L3 | **The Joint tool's "Close a loop"** (section 6) and the can press proof: `lever-can-press` uses a slide and two pins, `lever-press-stroke` keys the lever only. The acceptance in section 1, with before/after GIF frames and the per-frame pin error. | medium |

Each milestone is its own PR, with this plan as its spec. L1 can ship in a patch release on its own.

## 8. Later

- **Table coupling.** `driven = f(driver)` from sampled pairs, for a cam or a mechanism with no joints to solve.
- **Loops under dynamics.** `motion_run` with closures as constraints (Lagrange multipliers in the existing integrator).
- **Plant and move** (`docs/plan-pose.md` section 9): a Reach with pinned points is a temporary closure to the world, so the same solver serves it.

## 9. Open decisions

| # | Question | Recommendation |
|---|---|---|
| D1 | The word, and where it lives | "Loop", in the Joint tool: a loop is a joint that does not make a parent. A separate "Close" rail tool is the other choice; it costs a rail slot and Model's rail is already at its height limit at 1440×900 (R1). |
| D2 | A key for Close loop? | None at first. J opens the Joint tool, where it lives. |
| D3 | Pin and line, or more kinds (plane, gear-on-gear)? | Pin and line. They cover crank-sliders, four-bars, toggles and pin-in-slot. Planes and cams later, with the table coupling. |
| D4 | `motion_run` with loops | Refused with a reason until "Loops under dynamics". |
| D5 | How it lands | This plan as a docs-only PR. Then L1, L2, L3, each its own PR; L1 first. |

## 10. Constraints

- **Licence.** New code is MIT. No new dependency: the solver is TypeScript over the existing poses, with its own small dense least-squares step.
- **Speed.** A loop solve per drag event and per frame must stay under 1 ms for a loop of up to 6 free joints; a test asserts it.
- **Existing behaviour.** A file without `closures` reads and behaves exactly as now. Couplings, ratchets, clutches and Reach without loops are unchanged.
- **MCP size.** No new tool: `model_place` gains `loop` and `unloop`; the schema budgets in `mcp/schema.test.ts` hold.
- **The skill.** `mcp/skills/lime-slice/SKILL.md` gains a line on loops and keyable slides with the release that ships each.
