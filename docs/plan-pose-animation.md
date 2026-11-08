# Plan: pose animations, a lust script kind and a Save button in Pose

Status: plan, for review. Written 2026-11-08 against `main` at v6.1.0 (`f58e0c5`, the merge of #640). Docs only: no code changes with this plan.

The source is the owner's request after the stop-motion experiment on the mechanical arm (section 2): that experiment is the blueprint for "a new type of script in lust that can animate an IK rigged object or assembly", with a button in Pose that saves the animation, or its set of frames, at the end.

## 1. Goal

A person, or an agent through the MCP, can:

1. Write an **animation**: a lust script that names poses of a rigged assembly over time (keyframes of joint angles and IK reach targets), using the rig's own part names, never raw handles.
2. Run it against the assembly in Pose and watch it play in the Pose view, with a scrubber.
3. Press **Save animation** in Pose and get an animated GIF, or the frames as numbered PNGs, from a camera that does not move or re-frame between frames.
4. Keep the animation with the project, like a recipe, and share it as a plugin file, like a recipe.
5. Do all of it through the MCP in one call, with a reply that stays short however many frames there are.

The test case is `D:\lime-workspace\arm\mechanical-arm-ik-shoulder.lime` (24 parts, 18 hinges, Shoulder disc as the fixed root) and the sequence of section 2: rest, arm up, fist, point into the distance, raise the hand, peace sign.

### Non-goals

- No physics, no collision response, no secondary motion. Frames are poses; interference is reported, not avoided.
- No timeline editor in v1. Keyframes are written in the script (or by an agent); the Pose panel plays and scrubs them.
- No video file in v1 (MP4, WebM). GIF and PNG frames only; video is section 10.
- No change to geometry, the print layout, the slice or any cache key. An animation only poses; after it plays, the assembly is back where it was unless the person keeps the last frame.
- No multi-effector solve ("plant the feet and move the body"). That is `plan-pose.md` section 9, and an animation key can name one reach target per member, solved as today.
- No moving the root. The fixed root stays fixed; a "camera move" is a camera setting, not a pose.

## 2. The experiment (the blueprint)

Done on 2026-11-08 over the MCP on v6.0.1, against the arm above. Files in `D:\lime-workspace\arm\`: `arm-stop-motion.gif` (16 frames, 240 KB) and `arm-stop-motion-sheet.png`.

How it was made:

- Five keyframes of joint angles. Rest is every angle 0. **Arm up**: shoulder roll 90, elbow 110, palm roll 180. **Fist**: every finger root, middle and claw at -45, -50, -40, thumb -40, -40. **Point**: the index finger's three joints at +15, +27, +30. **Peace**: elbow 150, palm roll 90, the middle finger at +30, +39, +33.
- A script outside the app blended them linearly into 16 frames and wrote 98 `plan_run` steps: per frame, one `model_place {object, angle}` per joint that changed, then one `render_view` with a fixed camera direction `(-1, -1, 0.5)`.
- The frames were stitched into a GIF with holds on rest, point and peace, and a 4 × 4 contact sheet.

What it taught (each lesson is answered by a decision below):

| | Lesson | Answer |
|---|---|---|
| L1 | "Straight" is not angle 0. Each finger link carries its rest curl in its offset (index 15, 27, 30), so a straight finger is a number someone has to dig out of the project file. | D3 `aligned` |
| L2 | Signs are a trap: + straightens a finger, the elbow lifts the arm only after the shoulder rolls, mirrored parts turn the other way. | D3 named poses, D8 rig check |
| L3 | `render_view` re-frames every image, so the arm "breathes" between frames 1 and 5 as its bounds change. | D5 one framing for the whole animation |
| L4 | Every `model_place` lists every moved part: 16 frames gave an 85 KB reply that the client set aside unread. | D4 one call, a short reply; D7 `angles` reply |
| L5 | The hand has no sideways joint, so the "V" of the peace sign cannot open. Nothing said so. | D8 rig check |
| L6 | The shape of the work: keyframes, in-betweens, a locked camera, frames, a GIF. | D1 to D6 |
| L7 | It took 98 calls for 16 frames; a 5 s animation at 12 fps would be 60 frames and ~400 calls, near the recipe's 2,000-call limit with a few such clips. | D4 the host samples |

## 3. The script

### D1. A new plugin kind: `animation`

An animation is a recipe plugin (`plan-recipe-plugins.md` D6) with `kind: animation` in its front matter. It is one `.rs` file, built by the bundled lust with `--sandbox`, and kept, versioned, exported and imported exactly as a recipe plugin. What differs is what it is given and what it may call:

```rust
//! ---
//! plugin: arm-point-then-peace
//! title: Point into the distance, then a peace sign
//! kind: animation
//! api: 1.8
//! params: [{"name":"fps","kind":"count","default":12,"min":4,"max":30}]
//! ---
use lime_recipe::{anim::*, Session};

fn main() {
    let mut s = Session::start();
    let fps = s.count("fps", 12).range(4, 30).label("Frames per second").get();
    let rig = s.rig().unwrap_or_else(|r| s.refuse(&r.reason));

    let fingers = rig.group("Finger * root|Finger * middle|Finger * claw");
    let index = rig.group("Finger 1 *");
    let middle = rig.group("Finger 2 *");

    let mut a = Animation::new(fps);
    a.key(0.0, Pose::rest());
    a.key(1.2, Pose::new().set("Upper arm", 90.0).set("Forearm", 110.0).set("Palm", 180.0)).ease(Ease::InOut);
    a.key(1.8, Pose::new().set_all(&fingers, Aim::Fraction(-0.9)).set("Thumb *", -40.0));
    a.key(2.6, Pose::new().set_all(&index, Aim::Aligned)).hold(1.0);
    a.key(3.6, Pose::new().set("Forearm", 150.0).set("Palm", 90.0)).ease(Ease::InOut);
    a.key(4.4, Pose::new().set_all(&middle, Aim::Aligned)).hold(1.2);
    a.camera(Camera::looking(-1.0, -1.0, 0.5));

    s.animate(&a).unwrap_or_else(|r| s.refuse(&r.reason));
}
```

- **Why a plugin kind, not a new file type.** Everything a plugin has (the library, versions, export, the hash, the source shown before the first run, the sandbox) is what an animation needs. One field says which host runs it.
- **Why not plain recipe calls in a loop** (the experiment's way). L4 and L7: hundreds of calls and replies per clip, and the script would own the in-betweens, the camera and the framing, which are the host's to get right once.

### D2. What an animation is given, and what it may do

- It is given **one assembly**: the assembly of the part it is run on (`object`, as a recipe), in Pose the selected member's.
- It may **pose only that assembly**: hinge angles, ball rotations and reach keys on its members. It cannot call a Model op, make or remove a part, move the root, move the print layout, or name a part outside the assembly. A call that would is refused with "An animation can only pose the assembly it was given." This is D11.1 of the plugin plan ("only its own parts") read for animations.
- Its allowlist is new and short: `rig` (read the rig, D3), `animate` (D4), `log`, `progress`, `data`. Not `model_apply`, `solid_new`, `object_place` or `model_place`.
- Text in the script (titles, `log` lines, part names it prints) is data, as for every plugin (D11.5).

### D3. The rig, by name, with named poses

`s.rig()` answers the assembly as the script needs it, in one call:

- Each member: its **name** (as the object list shows it; a repeated name gets the plate's `-2`, `-3` suffix, as the STEP export names solids), parent name, joint kind, limits, current angle.
- For each hinge, **`aligned`**: the angle at which the member's frame lines up with its parent's about the hinge axis, read from the member's offset and turn (the finger's 15, 27, 30 of L1). For a ball, the rotation that does the same.
- `rig.group("Finger 1 *")` selects members by name, with `*` and `|`. A group that matches nothing is refused with the name (so a typo is not a silent no-op).

A key sets a joint to one of:

| `Aim` | Means |
|---|---|
| a number | that hinge angle in degrees (today's `model_place {angle}`) |
| `Aim::Rest` | 0, the pose the rig was made in |
| `Aim::Aligned` | the `aligned` angle: a finger straight, an elbow in line |
| `Aim::Min`, `Aim::Max` | a limit |
| `Aim::Fraction(f)` | `f` of the way from 0 to the limit on that side: -0.9 is 90 % of the way to `min` |
| `Aim::Reach { at, to }` | an IK target for that member's chain: `at` on the part, `to` in model space, solved per frame (D4) |

Named aims answer L1 and most of L2: the script says "straight" or "90 % closed", and the sign is the rig's business.

### D4. The host samples, solves and renders; one call, a short reply

`s.animate(&a)` sends the whole animation once: keyframes, holds, easing, camera, fps. The host:

1. Checks it (D8) and refuses with every problem at once, each with its key's line.
2. Samples the frames: `round(duration × fps)` frames, each joint interpolated between the keys that set it (linear, or `Ease::InOut` smoothstep; a joint no key sets keeps its current angle), clamped to its limits. A ball interpolates by quaternion slerp. A `Reach` key is solved per frame from the previous frame's pose with `solvePose` (`plan-pose.md` section 3), so a reach tracks smoothly rather than jumping to one solution.
3. Computes **one framing** for all frames (D5) and renders them.
4. Answers `{frames, durationS, fps, keys: [{t, line, reached?, distanceMm?, clamped?: [names]}], files?}`: one line per key, never one per frame or per part (L4).

Sampling lives in one TypeScript module shared by the app and the MCP (`src/pose-anim.ts`), as `solvePose` is shared today, so an animation plays the same in both.

### D5. The camera

- `Camera::looking(dx, dy, dz)` with an optional `up` is a direction, as `render_view {direction, up}`. With none, Pose's current camera (in the app) or `iso` (MCP).
- **One framing for the whole animation**: the host poses every sampled frame once, takes the union of the posed bounds, and frames that box for every image. Nothing re-frames between frames (L3).
- Size: `longEdge` (MCP) or the export dialog's size (app). The background and look are Pose's (`plan-pose.md` section 4): solid parts, Model's shading and edges; the selection colour is off in exported frames.

## 4. Pose: play and save

### D6. The Animations section and the Save button

The Pose panel gains an **Animations** section under the parts tree:

- The project's animations and the library's `kind: animation` plugins, each with its parameters (the plugin form, `plan-recipe-plugins.md` D5).
- **Play** runs it on the selected member's assembly and plays it in the Pose view; a scrubber and the frame number sit under the view; Space plays and pauses; Esc stops. Playing changes nothing: when it stops, every joint is back at its angle from before Play.
- **Keep this frame** writes the scrubbed frame's angles as the assembled pose: one undo step, like a Turn.
- **Save animation…** renders every frame at the chosen size with the Pose view's own renderer, off screen, and saves:
  - **GIF** (default): one file, the frame delays from the script's fps and holds, looping.
  - **PNG frames**: one PNG per frame, `name-001.png` …, in a folder the person picks (desktop app) or a `.zip` (browser).
  - Options: size (long edge, 320 to 1920 px), fps (the script's by default), the camera (the script's, or "this view": Pose's current camera, locked).
- A run that is refused (D8) says why in the panel, with the line, and plays nothing.

The rendering is the app's, not the engine's: the frames look like the Pose view the person was watching, and a GIF of 60 frames at 640 px is a few seconds of WebGL work, with a progress bar and Cancel.

## 5. The MCP

### D7. One new tool, two small changes to existing ones

| Tool | Change |
|---|---|
| `pose_animate` (new, core) | `{object, plugin? \| source? \| path?, params?, fps?, camera?, longEdge?, out: {gif?: name, frames?: name}}` runs an animation (D1 to D5) and writes the GIF and/or the frames into the workspace with the engine's renderer. The reply is D4's: one line per key and the file paths. `out` left out samples and checks only (a dry run). |
| `render_view` | New optional `fit: {min, max}`: frame this model-space box instead of the scene's bounds, so a caller can lock framing across its own frames (L3) without an animation. |
| `model_place` | New optional `reply: "angles"`: a pose call answers only `{ok, angles}` and the reach summary, not the `moved` list (L4). |

`plate_list` and `pose_animate`'s dry run show each hinge's `aligned` angle (D3), so an agent never has to read the project file to find "straight" again (L1).

## 6. The project file

- An animation applied in the project is kept as recipes are (`mcpModel.rustRecipes`, `plan-recipe-plugins.md` D1): its source or plugin reference, its params and the assembly id, under `mcpModel.animations[name]`. A file without the key reads as none; an older app ignores it.
- Frames and GIFs are never stored in the project. They are exports.
- Project version stays as it is.

## 7. Checks

### D8. The rig check

Before sampling, the host refuses (with the key's line, and every problem in one reply):

- a name or group that matches no member;
- a joint that has no hinge or ball, or a `Reach` on a member whose chain has no joint;
- a number outside a joint's limits (named, with the limit, instead of a silent clamp);
- a key that asks a hinge to turn about an axis it does not have, which is what L5 was: the "V" needed a sideways joint the finger does not have. The check can only see this for `Reach` keys (a target off the chain's planes, reported as `distanceMm` per key, D4); for angle keys it is the rig's design, and the guide says so.

It warns, without refusing, when two keys set the same joint at the same time (the later wins) and when a sampled frame puts two parts through each other (`assemblyClashes`), with the frame numbers.

## 8. Milestones

Each one is a PR with its tests, as `plan-pose.md` was built.

| | Milestone | Done when | Tests |
|---|---|---|---|
| M1 | **MCP groundwork.** `render_view {fit}`, `model_place {reply:"angles"}`, `aligned` in `plate_list`. | The section 2 experiment can be redone over the MCP with a fixed framing and a reply under 5 KB. | `mcp/render.test.ts`, `mcp/pose.test.ts`; `aligned` of a finger link equals its turn's opposite. |
| M2 | **The sampler.** `src/pose-anim.ts`: keys to frames (aims, easing, holds, limits, slerp, per-frame reach), one framing, the rig check. | The arm's five keys give the 16 sets of angles of section 2 within 0.01°; a reach key tracks a moving target with every pin on its axis. | `src/pose-anim.test.ts` in `tools/unit-tests.txt`. |
| M3 | **`lime-recipe` 1.8.** `anim` module (`Animation`, `Pose`, `Aim`, `Ease`, `Camera`), `s.rig()`, `s.animate()`; the host's `kind: animation` allowlist and the D2 refusal. | The script of D1 builds under lust and Cargo and runs in describe mode. | `crates/lime-recipe` tests; `mcp/recipe.test.ts` gains an animation that tries `model_apply` and is refused. |
| M4 | **`pose_animate`.** The MCP tool, the engine's frame renderer with `fit`, the GIF writer, the PNG frames, the D4 reply. | `pose_animate` on the arm writes `arm-point-peace.gif`; its frames match the M1 redo frame for frame. | `mcp/pose-animate.test.ts`; the reply for 60 frames is under 4 KB. |
| M5 | **Pose: play and save.** The Animations section, Play, scrubber, Keep this frame, Save animation… (GIF, PNG frames, size, fps, camera). | Play the arm's animation in Pose and save a GIF from the panel; the project pose is unchanged after Play. | `e2e/pose-animate.spec.ts` (play, scrub, keep, save, refusal shown), in `test:smoke`. |
| M6 | **Plugins and docs.** `kind: animation` in the Plugins panel and `recipe_run`'s plugin list, the `animation` guide, README. | An animation exported from one project imports into another and plays. | `mcp/plugin*.test.ts` gain a kind round trip. |

M1 is useful on its own (it fixes L3 and L4 for anyone animating by hand today) and can land first. M2 and M3 can go in parallel; M4 needs both; M5 needs M2 and M3.

## 9. Open decisions

- **O1. The GIF encoder.** A small MIT encoder (for example `gifenc`, ~10 kB, no dependencies) used by both the app and the MCP, or one written here (LZW and a median-cut palette, ~300 lines). Recommendation: the dependency, pinned, with its licence in the notices.
- **O2. PNG frames in the browser build.** A `.zip` (needs a zip writer; `fflate` is MIT and small) or one download per frame. Recommendation: zip in the browser, a folder in the desktop app.
- **O3. Where interpolation lives.** The host (D4, recommended: one call, shared code, short replies), or the script (a frame loop calling `pose` per frame: more freedom, L4 and L7 again).
- **O4. The field name.** `kind: animation` in the plugin front matter (recommended) or a separate `//! animation: true`.
- **O5. Holds and timing in GIFs.** Per-frame delays (recommended: a hold is one frame with a long delay, so a GIF stays small) or repeated frames.

## 10. Later

- Video export (WebM through `MediaRecorder` in the app; MP4 needs an encoder and its licence).
- A timeline editor in Pose: keys as marks on the scrubber, dragged in time, set from the current pose ("Key this pose").
- Camera keys (orbit, dolly) and per-frame overlays (frame number, captions).
- Multi-effector keys once `plan-pose.md` section 9's solver lands: plant several claws and move the body.
- Recording a Reach drag in Pose as keys.

## 11. Constraints

- No change to the slice, the G-code, the print layout or any cache key; golden G-code stays byte-identical.
- An animation runs under the same lust sandbox, limits and memory cap as every plugin (`plan-recipe-plugins.md` D11); its frames are rendered by the host, outside the sandbox, from the poses it asked for.
- Every new spec goes in `test:smoke` and every new unit test in `tools/unit-tests.txt` (the repo's `verify-ui` rule); the MCP token budgets in `mcp/schema.test.ts` are raised only by the rule written there.
