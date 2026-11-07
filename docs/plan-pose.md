# Plan: the Pose stage, joints and inverse kinematics on assemblies

Status: plan, for review. Written 2026-11-07 against `main` at v5.10.0 (`2e4b18f`, the merge of #626). Docs only: no code changes with this plan.

The source is the owner's request after #626: Model changes objects, Prepare lays them out for the slicer, Preview shows the slices, and a fourth job has no home yet: **posing** an articulated design. Inverse kinematics belongs there, not on the bed. The view is drawn the way Model draws, with one difference: parts that are not selected stay solid instead of turning transparent, and the selected part or chain is drawn in a red that belongs to the app's palette.

## 1. Goal

A person can:

1. Open a **Pose** stage beside Prepare, Preview, G-code and Model, and see every object at its assembled pose, solid, with Model's shading and edges.
2. Select a part or a chain and see it in the pose colour, with everything else still solid and readable.
3. Give a member of an assembly a **joint**: a hinge about a pin axis or a ball about a point, with limits.
4. Turn a joint directly (forward kinematics), or drag a point on a part and let the joints between it and a fixed ancestor turn to follow (inverse kinematics).
5. Keep the result as the assembled pose: Model's grey context, Prepare's Assembly view, interference, the STEP export and the MCP all read the posed parts with no extra step.

The test case is the porcelain spider (`D:\lime-workspace\spider\porcelain-spider.lime`, 86 parts, one assembly). Each leg should become coxa, femur, tibia and tarsus on four pins. Dragging a claw tip should bend the knee and ankle about their pins, leave the body still, and keep every pin on its own axis.

### Non-goals

- No change to `crates/lime-slice-core`, the G-code writer, the slice request or any slice cache key. A pose is model space; the print layout is untouched. Golden G-code stays byte-identical.
- No named or stored pose library. There is one assembled pose, written to `modelPose` as today (owner, D1). Named poses can be a later milestone on top of this one.
- No physics, no collision response, no animation or keyframes.
- No multi-target solve in the first release: one dragged point at a time. "Plant these feet and move the body" is a later milestone (section 9).
- No new geometry library and no kernel change. Joints and the solver are TypeScript over poses the app already has.
- No change to project version. It stays 4 (section 7).

## 2. Current state

Read from `main` at `2e4b18f`.

### What already holds a pose

| Piece | Where | What it gives Pose |
|---|---|---|
| `modelPose` | `PlateObject` in `src/plate.ts`, saved per object | The one assembled pose every reader uses (Model, joins, Explode, interference, the STEP export, the MCP). |
| `Assembly`, `Member` | `src/assembly.ts` | A tree: one root, and each member's `offset` and `turn` in its **parent's part frame**. `solveAssembly` walks it and writes `modelPose`. `movedTo` re-seats a member by a new pose and keeps its children on it. |
| Undo | `src/app/history.ts` | The edit history already snapshots `session.assemblies` with the plate (line 82), so a pose change can be one Undo step with no new history code. |
| Assembly view | `setAssembled` in `src/prepare-view.ts` | Prepare can already draw every object at `modelPose`, solid, with the selected one in the part colour and clashes in amber. Pose reuses the idea, not this viewport (below). |

### How Model draws

Model's viewport is `src/model-view/` (about 5,600 lines across `scene`, `mesh`, `context`, `picking`, `handles` and others), built by `createModelView`.

- **The open solid** uses one `MeshStandardMaterial` with vertex colours, roughness 0.55 and metalness 0.05 (`src/model-view/mesh.ts`, line 50), with its B-rep edges drawn over it in `IDLE_EDGE` (`0x8d9780`).
- **Every other object** is grey context, `contextMaterial` in `src/context-look.ts`: flat-shaded, `transparent: true`, `opacity: 0.4`, `depthWrite: false` (`src/model-view/context.ts`). This is the transparency the owner wants gone in Pose. With 86 parts in one view, 40% grey shells with no depth writes turn into fog.

### What #626 put in Prepare

`docs/pivots-and-chains.md` describes it. These are **bed** fields on `PlateObject`, not assembly ones:

- `pivot` (a source-frame point),
- `chain` (a parent link with an offset and a turn),
- `jointLimits` (Euler degrees per axis).

They come with a Pivot tool, Link and Unlink buttons, a Chain row, and an IK tool. Trying it on the spider (the session that reviewed #626) found five limits:

1. **IK moves the print layout, not the assembled spider.** The spider's assembled pose lives in its assembly, and nothing carries a bed pose back into model space.
2. **The IK target is the leaf's pivot.** To pull a claw tip, the tarsus pivot had to be moved to the tip, which then leaves the ankle without a hinge.
3. **Joints can turn about any axis.** A pin should allow one axis only. Euler limits on a part printed upside down (the tibia is turned 180° about X) sit near ±180°, where Euler angles wrap, so a lock on X or Y is unreliable there. The tip drifted 0.4 to 0.6 mm off its plane in that test.
4. **The drag plane follows the camera.** Prepare's Top preset was not exactly overhead in that pane, which tilted the joints.
5. **A flat tree cannot be posed.** All 85 of the spider's other members sit directly on Head top. To pose a leg, the tree must say tarsus sits on tibia, tibia on femur, and so on.

## 3. The model

### A joint on a member

A **joint** says how a member may move on its parent. It is an optional field of `Member`, so an assembly without joints is the assembly it is today:

```
Member { object, parent, offset, turn, exprs?, joint? }

Joint  { kind: "hinge" | "ball",
         pivot: [x, y, z],        // in the member's own part frame, mm
         axis?: [x, y, z],        // hinge only, in the member's own part frame, unit length
         angle?: number,          // hinge only, degrees from the rest pose (below)
         min?: number, max?: number,   // hinge only, degrees; absent means free
         cone?: number,           // ball only, degrees from the rest direction; absent means free
         rest?: [qx, qy, qz, qw] } // ball only, the member's turn at rest, as a quaternion in the parent's frame
```

- **The pivot is on the member**, in its own part frame: the centre of the pin hole the member turns on. Its world point stays where it is when the joint turns, so a knee never slides off its pin.
- **A hinge** turns about `axis` through `pivot`. Its state is one number, `angle`, so a limit is a plain range on that number. Being one number, it never wraps the way Euler angles do: the limits stay right on a part printed upside down, which fixes #626 limit 3. Its axis is in the member's own frame, so it moves with the member, as a pin does.
- **A ball** turns about `pivot` in any direction. `cone` limits how far the member's own direction (its pivot to its centre) may tip from where it stood at rest. It is the joint for a part with no pin, such as a spider's swing ring if the owner wants it free.
- **The rest pose is derived, not stored**, for a hinge. `offset` and `turn` stay the member's full current pose in its parent's frame, exactly as `solveAssembly` reads them today, and the hinge's rest pose is that pose turned back by `-angle` about the axis. So every existing reader (the solver, `movedTo`, the MCP, an older app) sees the posed member at its true place. For a ball, the rest turn is stored because a free turn has no single number to undo.
- **A member without a joint is fixed** to its parent. Its offset and turn are what they are now, and IK never turns it.

### Turning a joint

Turning a hinge by `d` degrees is a pose on the member's own side:

```
pose' = pose · T(p) · R(axis, d) · T(-p)      // p = pivot, both in the member's part frame
```

The new `offset` and `turn` are `memberFields(pose')`, `angle` becomes `angle + d` clamped to `[min, max]`, and the member's children follow through `solveAssembly`, as they do for a hand move today. A ball is the same with any rotation, clamped to its cone. This is a new pure module, `src/pose.ts`, with no DOM and no Three.js, beside `src/assembly.ts`.

### The chain IK turns

A drag names a **part** and a **point on it**, the surface point under the pointer when the drag started, in the part's own frame. This fixes #626 limit 2: the target is where you grab, not the part's pivot. The joints that turn are the ones between that part and its **anchor**:

- Walk up from the dragged part through each member that has a joint, starting with the part itself if it has one.
- Stop at the first member with no joint. That member is the anchor and does not move. If every member up to the root has a joint, the root is the anchor.

For the spider, dragging a claw turns the ankle, knee, hip lift and swing joints, and stops at the sternum ring, which is fixed to Head top. The body stays still.

### The solver

Cyclic coordinate descent, as #626's `solveIk` does, but turning one joint at a time by its kind:

- **A hinge** projects the pivot-to-effector and pivot-to-target vectors onto the plane square to its axis, takes the signed angle between them, and clamps `angle` to its limits. The effector therefore never leaves the hinge's circle: no drift off the pin, whatever the camera does (#626 limit 3).
- **A ball** turns along the shortest arc, as `rotateJointToward` does now, and is clamped to its cone.

The solve stops at 32 sweeps, or once the effector is within 0.05 mm of the target, the same limits as #626. Each drag solves from the pose at its start, so one drag is one Undo step. The target is the pointer's ray met with a plane through the effector, square to the view direction. It does not matter whether the camera is exactly overhead: a hinge only takes its in-plane share of the drag.

### Linking inside an assembly

Pose needs the tree to be the mechanism (#626 limit 5). **Link** makes the selected member the parent of another member of the same assembly, where it stands. The child keeps its `modelPose` and gets the offset that holds it there, the way `attached` and `movedTo` work. Link refuses a loop with a sentence, as `withMember` does. Linking a part that belongs to no assembly asks to attach it first, with Prepare's Attach rule.

## 4. The Pose stage

### Where it sits

A fifth tab, **Pose**, after Model (`#tabPose`, key `5`), in `Stage` (`src/ui/chrome.ts`), `StageName` (`src/ui/commands.ts`), `state.stage` (`src/app/state.ts`), `setStage` (`src/app/viewer.ts`), and the compact layout's tabs (`src/ui/compact/mount.ts`). Its body is `#poseBody`, shown and hidden like `#modelBody`. Leaving Pose flushes the edit, as leaving Model does, and the next Prepare visit offers a re-slice only if a member's print layout changed, which Pose never does. So the slice stays current after a posing session.

### How it draws

`src/pose-view.ts` is a new viewport, built from Model's scene pieces (camera, lights, orbit, Top/Front/Iso presets, the edge material) and not from Prepare's, so it looks like Model:

| Draws | Material | Notes |
|---|---|---|
| Every object, at its `modelPose`, from its plate mesh | Model's solid look: `MeshStandardMaterial`, roughness 0.55, metalness 0.05, **opaque**, depth-written, plus outline edges in `IDLE_EDGE` (an `EdgesGeometry` per mesh, as `src/model-view/ghost.ts` outlines a join's tool, built once and kept) | No part is transparent. Free objects are drawn too, so the stage shows the whole design. |
| The **selected part** | The pose colour (`--pose`, below), same shading | One part. |
| The **rest of its chain** (the joints up to its anchor) | `--pose-chain`, a quieter step of the same hue | Shows what an IK drag will turn before the drag. |
| Joints | A short line along each hinge axis through its pivot, and a dot for a ball, in `--pose`, drawn only for the selected chain | What #626 drew as amber crosses on the bed. |
| Interference | Amber, as the Assembly view tints it (M6 of `docs/plan-assemblies.md`) | Unchanged meaning. A pose that drives a pin into a hole shows at once. |

The plate meshes are used, not each solid's B-rep tessellation, so a design of 86 parts opens without opening 86 trees. Each mesh's geometry is built once per source array and kept, as `contextHeld` does. A pose change then rewrites matrices and uploads no vertices.

### The pose colour

`--danger` (`#f0615a` dark, `#dc2626` light) is already the palette's red, but it means *error* in the panels. Using it on a selected part would read as "this part is wrong". The plan adds two tokens to `src/tokens.css` and `themeColors` in `src/theme.ts`, in the same family, and lighter and less saturated so they sit with lime, amber and teal:

| Token | Dark | Light | Use |
|---|---|---|---|
| `--pose` | `#f2846f` (coral) | `#c2452f` | The selected part, joint marks |
| `--pose-chain` | `#b5675a` | `#e0a094` | The other members of the selected chain |

Both must keep a contrast of at least 3:1 against `--stage`. They must also stay apart from the mesh grey, from `--danger`, and from the amber that marks interference. A unit test checks this from the two theme tables by contrast ratio and by Lab distance, the way `src/colors.test.ts` already keeps the slice palette apart. The exact values are D6: the owner may pick them from a swatch row in the M1 PR.

### Tools

The rail gets a **Pose** set, as Prepare and Model have their own sets:

| Tool | What it does |
|---|---|
| **Select** (default) | Click a part to select it. Click again to select its chain, and Esc goes back to the part. Orbit and pan as Model does. |
| **Turn** | Rings on the selected member's joint: one ring about a hinge's axis, three about a ball's pivot. Drag to turn it (forward kinematics), Shift snaps to 5°. |
| **Reach** | Drag any point on a part: IK turns the chain up to its anchor. |
| **Joint** | Click a part, then click the hole it turns on. On a solid, a cylindrical face gives the pivot (the axis midpoint inside the part) and the axis. On a mesh, Shift-click snaps to a vertex, an edge midpoint, or the box centre, and the axis is typed. |
| **Link** | Click the parent, then the child. |

### The Pose panel

The left dock shows the selected member: its name and parent, and its joint (kind, pivot, axis, angle, limits) as typed fields. Each field is one Undo step. **Rest** sets every hinge angle in the selected chain to 0. **Make rest** takes the current pose as the new rest pose, setting every angle to 0 without moving anything. The object list is the same list Prepare shows, with the assembly's tree indented by parent, so the spider reads as body, ring, then each leg's four parts.

## 5. What happens to Prepare's tools (owner, D2)

- **The IK tool leaves Prepare.** Its rail button, its command (`tool-ik`), `onIk` and `dragChainEnd` are removed. IK lives in Pose only.
- **The Pivot tool stays.** Turning and scaling a part about a chosen point is a bed-layout job, and it already keeps the slice byte-identical when the pivot is the centre.
- **Plate chains stay readable.** A project with `chain` or `jointLimits` rows opens, and a linked part still follows its parent on the bed, as #626 built. Link, Unlink and the Chain row stay. The joint-limit fields leave the Pivot and chain group, since nothing reads them once the IK tool is gone. The data stays in the file, so an older save is not damaged.
- **`docs/pivots-and-chains.md` gets a note** saying the bed chain is a layout convenience and that posing is the Pose stage's job.

Whether bed chains go entirely is a later decision (D7), once the owner has used Pose.

## 6. The MCP

The MCP places parts by `model_place`, and an assembly member's offset and turn are already its fields (M4 of `docs/plan-assemblies.md`). Joints and reaching fit the same tool with no new one:

| Tool | Change |
|---|---|
| `model_place` | New optional `joint: {kind, pivot, axis?, min?, max?, cone?}` sets or replaces this member's joint; `joint: null` removes it. New optional `angle` turns a hinge to that angle (forward kinematics). New optional `reach: {at: [x,y,z], to: [x,y,z]}` drags the part's own point `at` towards the model-space point `to` through its chain (IK), and the reply lists `moved` and the angles that changed. |
| `plate_list`, `session_info` | A member's row gains `joint` when it has one. |
| `guide` | `guide {kind: "pose"}` explains joints, anchors and reach in worked text. |

The schema budgets in `mcp/schema.test.ts` stay as they are. If `model_place` passes its 750-token budget, the field text moves into the guide.

## 7. The project file

Stay at version 4.

- `joint` is an optional key on a member row inside `assemblies`, read and written by `readAssemblies` and omitted when absent. A damaged joint (a zero axis, a min above its max, a non-finite number) is dropped, and the member stays fixed. The file still opens.
- The posed numbers are the member's `offset`, `turn` and the object's `modelPose`, as today, so the pose itself needs no new key.
- **An older app** ignores `joint`, opens every part where the pose put it, and drops the joints on its next save. Nothing moves.

`src/project.test.ts` gains a round trip of an assembly with a hinge and a ball, and a file with a damaged joint.

## 8. Milestones

Each lands as its own PR, is usable, and has tests. UI work follows the `verify-ui` skill: build first, headless Chromium, specs in `test:smoke` passing three times with `--repeat-each=3`, and screenshots in the owner's dark 1440x1000 view.

| # | Milestone | Usable result | Tests |
|---|---|---|---|
| M1 | **The stage and the view.** The Pose tab and key, `#poseBody`, `src/pose-view.ts` drawing every object opaque at `modelPose` in Model's look, the `--pose` and `--pose-chain` tokens, selecting a part from the list or the view, the camera presets. Nothing edits yet. | Open the spider in Pose and see it whole and solid, with the selected part in coral. | `e2e/pose-view.spec.ts` (new): the tab, every part drawn at its assembled box (`data-posed` on the canvas, as `data-assembled` is), no transparent material, a click selects and tints, theme switch repaints. A colour-contrast unit test. `src/ui/commands.test.ts` for the key. |
| M2 | **Joints and links, as data.** `Joint` on `Member`, `readAssemblies` and the writer, `src/pose.ts` (`turnHinge`, `turnBall`, `restOf`, `linked`), with the clamps. | Pure and tested. | `src/pose.test.ts` (new, in `tools/unit-tests.txt`): a hinge keeps its pivot fixed and its axis, limits clamp, a 180°-flipped member clamps right, a ball cone, children follow, link keeps poses and refuses loops. `src/project.test.ts`: round trip and a damaged joint. |
| M3 | **Turn, Link and the panel.** The Select, Turn, Link and Joint tools (typed pivot and axis first), the Pose panel, Rest and Make rest, the tree-indented list. Each edit is one Undo step. | Re-parent a spider leg, put hinges on its pins by typing them, turn the knee with its ring. | `e2e/pose-joints.spec.ts` (new): link, a hinge typed, a ring turn moves the children and keeps the pivot, the limit holds, Undo, the file round trip through the app. |
| M4 | **Reach (IK).** `solvePose` in `src/pose.ts` (hinge and ball CCD), the anchor walk, the grabbed point as the effector, the chain tint shown before the drag, one Undo step per drag. | Drag the spider's claw and the leg follows on its pins; the body stays. | `src/pose.test.ts`: a planar three-hinge leg reaches a reachable point to 0.05 mm, every pin stays on its axis to 1e-6 mm, limits hold, an unreachable point stretches the leg straight towards it, the anchor never moves. `e2e/pose-reach.spec.ts`: a drag on a fixture leg, Undo. |
| M5 | **Prepare cleanup** (section 5). Remove the IK tool and its command, and the joint-limit fields. Update `docs/pivots-and-chains.md`. | One IK, in the stage meant for it. | `e2e/pivots-chains.spec.ts` updated (pivots and chains still work, no IK button). `src/ui/commands.test.ts`. |
| M6 | **Joint from a hole.** The Joint tool's click on a cylindrical face of a solid gives the pivot and the axis, through the face data Model's picking already has. A mesh part keeps the typed and snapped way. | Click a pin hole and the hinge is there. | `e2e/pose-joints.spec.ts` extended with a solid that has a hole; a unit test of the pivot-from-cylinder rule. |
| M7 | **The MCP** (section 6). `model_place {joint, angle, reach}`, the rows, the guide. | Pose the spider over MCP: hinges on the pins, one `reach` per claw. | `mcp/pose.test.ts` (new, fake engine): joint set, angle, reach, refusals; `mcp/schema.test.ts` budgets. |

M1 to M4 are the owner's request. M5 tidies Prepare once Pose can do the job. M6 makes setting up a joint quick. M7 brings the MCP to parity, as `docs/plan-gui-mcp-parity.md` asks.

### As built: M1

- **The stage.**
  - **Placement.** `Pose` is the fifth tab (`#tabPose`, key `5`, D5) in `Stage`, `StageName`, `state.stage` and `setStage`. Its body is `#poseBody`, shown and hidden like `#modelBody`. Leaving Pose flushes the edit, as leaving Model does.
  - **Keys.** The rail's stage label and the shortcut sheet name it. T, Y and I click its own camera chip (`#poseViewPresets`). `/` and Ctrl+F search the settings there too, because the left dock is still Settings in M1.
- **The view, `src/pose-view.ts`.**
  - **What it reuses.** Model's scene pieces: the studio lights, the orbit glide, the view cube, the bed reference, Model's camera framing, and the frame loop that stops when the view is still.
  - **What it draws.** Every object from its plate mesh at the pose `assembledParts` gives the Assembly view, centred on the bed and standing on it, so the two views agree. Each part gets Model's solid material, opaque and depth-written, with outline edges in `IDLE_EDGE`.
  - **What it keeps.** One geometry and one outline per source array, so a selection or pose change rewrites matrices and uploads no vertex. The 86-part spider opens in about 0.4 s here, the interference pass included.
  - **Picking.** A click picks; a press that moves past 4 px orbits.
- **Looks, `src/pose-look.ts`.**
  - **The order.** A clash wins over the selection, and the selection wins over the chain, as in the Assembly view (D8). The clash pass is the Assembly view's own, per assembly and cached per pose.
  - **The chain.** The chain set is empty until joints exist (M2).
- **D6, the colours.** `--pose` is `#f2846f` and `--pose-chain` is `#b5675a`, in **both** themes. The plan's light values (`#c2452f`, `#e0a094`) assumed a light viewport, but `tokens.css` keeps the viewport dark in the light theme ("Dark viewport in both themes"), and `#c2452f` on `#0c0e12` would sink. Measured on the stage:

  | | Contrast on the stage | ΔE from `--context` (grey parts) | ΔE from `--amber` | ΔE from `--mesh` | ΔE from `--danger` |
  |---|---|---|---|---|---|
  | `--pose` | 7.7:1 | 55 | 46 | 81 | 16 (the same family, not the same red) |
  | `--pose-chain` | 4.7:1 | 44 | 56 | 80 | 28 |

  The selection and its chain are 20 apart.
- **Selection.** A click in the view calls the same `selectPlateObject` as the object list, so the list, Prepare and Pose agree. A click on empty space keeps the selection. `syncAssemblyView`, which runs on every placement, selection and assembly change, now also redraws Pose (`fx.syncPose`), only while Pose is on screen.
- **Not in M1.**
  - **The left dock.** It is still Settings, with the print-layout fields. M3 replaces it with the Pose panel; until then, moving X or Y there moves the print layout, as it does in Prepare.
  - **The phone layout.** It has no Pose tab, as it has none for G-code.
  - **The Top preset.** It looks almost straight down (`0, -0.04, 1`), as Model's and Prepare's do. Reach (M4) does not depend on it, because a hinge takes only its in-plane share of a drag.
- **Tests.**
  - `e2e/pose-view.spec.ts` (new, in `test:smoke`, passes three times with `--repeat-each=3`). It covers key 5, opaque drawing, both parts standing on the plate, the selection tint, selecting from the list and by a click, an empty click, the chip and the T/Y/I keys, the light theme's coral, the print layout unchanged afterwards, the boxes matching the Assembly view's `data-assembled`, the amber tint for crossing members, and the empty plate's line.
  - `src/pose-look.test.ts` (new, in `tools/unit-tests.txt`). It covers the look order, and reads both theme blocks of `tokens.css` for contrast of at least 3:1 and Lab distance from `--context`, `--amber`, `--mesh` and `--danger`.
  - `src/ui/commands.test.ts` covers the tab key, the camera keys and their targets in every stage.
  - Run unchanged: `keyboard`, `assembly`, `assembly-layout`, `theme-switch`, `lazy-workspaces`, `compact-layout`, `a11y-errors`, `small-ui`, `ui-review`, `fit`, `shortcuts-first-run`, `model-chrome`, `pivots-chains` and `history-search`.

### As built: M3

The Pose rail has Select, Turn, Joint and Link. The left dock shows the assembly tree and the selected member's typed joint fields. Link chooses a parent and child already in one assembly and keeps their poses; free parts are attached in Prepare first. Turn draws one ring for a hinge or three for a ball, and Shift snaps the drag to 5°. Each field, link, rest action or ring drag is one Undo step. Rest turns the selected chain's hinges toward zero within their limits. Make rest leaves the parts where they are, resets the hinge angles and shifts their limits by the same amount; ball rest orientations are reset as well. The assembled view keeps one framing shift during the Pose visit, so the fixed body does not slide as a limb moves. None of these edits changes the print layout or the slice key. Cylindrical-face picking remains M6.

## 9. Later

- **Plant and move.** Several dragged or pinned points solved together: plant all eight claws and move the body, so the legs bend to keep the claws where they are. It needs a solver over several effectors, such as damped least squares on the joint angles, and is the step that makes a spider stand.
- **Named poses.** Store several poses per assembly ("standing", "crouched") and switch between them. Each is a set of joint angles over the same rest pose, so it builds on M2 with no new pose model.
- **Pose from recipe parameters.** The spider's recipe already solves its knee for "every tip on the table". A recipe could write joints and angles, so a regenerated part keeps its pose.

## 10. How other tools do it

- **Blender** keeps an armature with an Edit mode (the rest pose) and a Pose mode, and draws the active bone highlighted in pose mode. Its IK constraint has a chain length that stops the solve at an ancestor, which is this plan's anchor, and per-bone locks and limits per axis. Pose's hinge is a bone locked to one axis.
- **Fusion** joints are rigid, revolute, slider, cylindrical, pin-slot, planar and ball, each with motion limits. You drag a component to move it within its joints. Pose's hinge is Fusion's revolute, and its ball is Fusion's ball.
- **Onshape** mates (revolute, ball and others) link two mate connectors, and dragging a part moves the mechanism within its degrees of freedom. The pivot and axis picked from a hole are what a mate connector on a cylindrical face gives.
- **Bambu Studio's Assembly View** positions and spaces parts for presentation, with no joints. That is Prepare's Assembly view here. Pose adds the joints that Bambu's view leaves to CAD.

What this changes: all three CAD tools put a joint's axis on a picked cylinder, so M6 is worth its milestone. Blender's chain length confirms the anchor rule. None of them keeps the rest pose as a separate stored copy; each derives it from joint values, as section 3 does.

## 11. Open decisions

| # | Question | Decision or recommendation |
|---|---|---|
| D1 | One assembled pose, or named poses? | Decided by the owner on 2026-11-07: one pose, written to `modelPose`. Named poses later (section 9). |
| D2 | Prepare's Pivot, chain and IK tools? | Decided by the owner on 2026-11-07: IK moves to Pose; Pivot stays in Prepare; bed chains keep loading (section 5). |
| D3 | Joint kinds? | Decided by the owner on 2026-11-07: hinge and ball, with limits. |
| D4 | How does it land? | Decided by the owner on 2026-11-07: this plan as a docs-only PR, then M1 in its own PR. |
| D5 | Where does the Pose tab sit, and what key? | After Model, key `5`, so no existing key changes. The other order (Model, Pose, Prepare, Preview, G-code) matches the order of work, but it would move every key the owner has learned. |
| D6 | The pose colour values? | As built in M1: `#f2846f` for the selection and `#b5675a` for its chain, in both themes, because the viewport is dark in both (see "As built: M1"). The test in `src/pose-look.test.ts` guards them. The owner may still pick others from the M1 screenshots. |
| D7 | Do bed chains (#626's `chain` on `PlateObject`) go entirely? | Not now. Keep them readable and following (section 5), and decide once Pose is in use. |
| D8 | Does selecting a part tint its chain up to the anchor, or the part and its children? | Up to the anchor, because that is what Reach will turn. The children move with the part and are drawn in their normal colour. |

## 12. Constraints

- **Licence.** New code is MIT. No new dependency.
- **Offline.** Nothing is fetched at run time.
- **Slicer output.** No new slice field. Golden G-code stays byte-identical, and `crates/lime-slice-core` is unchanged. A posing session does not make the slice stale.
- **Existing behaviour.** A file without `joint` keys reads and behaves as now. Prepare's Assembly view, Model's context, joins, interference and the STEP export keep reading `modelPose`.
- **MCP size.** No new tool; the budgets in `mcp/schema.test.ts` hold.
- **View state.** The selected chain and the Pose camera are view state: not saved and not in the undo stack. The pose itself is saved and undoable.
