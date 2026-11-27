# lime-recipe

The crate a recipe uses: a short Rust program the MCP tool `recipe_run`
builds with `lust build --sandbox` and runs, talking to the MCP server over
stdin and stdout (protocol v1, `docs/plan-recipes.md`).

It has no dependencies and its own small JSON type, so lust (no proc
macros, edition 2024) and rustc build it the same way, and a recipe sends
the same calls under both (`cargo test -p lime-recipe` checks the JSON;
`mcp/recipe.test.ts` checks a whole recipe against a scripted host).

```rust
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let width = s.param_f64("width", 60.0);
    let part = s.solid_new(ops::cuboid(width, 20.0, 4.0)).unwrap();
    for i in 0..4 {
        let x = -width / 2.0 + width * (i as f64 + 0.5) / 4.0;
        s.apply(&part, ops::hole_through([x, 0.0, 4.0], [0.0, 0.0, -1.0], 3.2)).unwrap();
    }
    s.done(&part);
}
```

Every op an MCP edit takes can be sent as JSON: `Json::obj().set("kind",
"fillet").set("edges", ...)`. The `ops` helpers cover the common ones.

## Geometry

`geom2d` and `lattice` do the 2D work a recipe would otherwise write by
hand: polygons and regions with holes, booleans, offsets, rounded corners,
cleanup, the `loops` an `extrude` takes, and cell patterns clipped to a
region (`examples/vent_plate.rs`). They use their own sine, cosine and
arctangent, so a recipe sends the same bytes under lust and rustc, whose
libm differ in the last bit on Windows (`mcp/recipe-geom2d.test.ts`).
`tests/kernel_reference.rs` checks the booleans against Open CASCADE.
Everything stays in `src/lib.rs`: the recipe host copies only that file.

## Values a person picks (API 1.2)

`s.face("face").rule("largest_up").get()` declares a face of the part and
`s.outline("shape").default_poly(&geom2d::rect(80.0, 60.0)).get()` a closed
outline; `s.pick_face(&part, &face)` and `s.pick_outline(&shape)` resolve them
through the host's `pick` call, giving the face's index, normal, point, area
and outline, or the outline as a `Section`. The person picks them in the
Plugins panel and History (a face clicked in the view, a sketch, a face's
outline); an agent passes an index, `{normal, nearPoint}`, `{sketch}`,
`{face}`, `{loops}` or `{data}`. `s.refuse(sentence)` ends a run with a plain
reason; `s.bounds(&part)` is the part's box.

## Text and curved faces (API 1.3)

`s.face("wall").curved().get()` declares a face parameter that takes any face, not only a flat one. `s.pick_face` then says what it
got: `kind` (`plane`, `cylinder`, `cone`, `sphere`, or `other` for a torus or a freeform face), and for a cylinder or a cone its
`axis` and `radius`. A curved face has no one normal (`normal` is zero), no outline (`outline` is empty), and a point on it
(`point`); it is kept in a plugin step as `{surface, nearPoint}` and found again by the face of that surface under the point. A
parameter without `.curved()` refuses a curved face in the 1.2 sentence.

`s.lettering(&part, &face, "LOT 42", &Lettering::new(6.0, 0.8).font("mono").around())` is the `text` op as a typed call, on the face
`pick_face` gave, flat or curved (one history step; `Lettering` also takes `.style`, `.weight`, `.spacing`, `.line_spacing`,
`.align`, `.angle`, `.stroke_width`, `.axis`, `.u`, `.v`, `.project`, `.flip`, `.engrave`). The plan called the struct `Text`,
which `s.text(name, default)`'s parameter builder already is, and the method `model.text`, which a recipe has no `model` for.

`s.text_outline("LIME", "sans", 10.0)` is the letters as a `Section`: `.region` for `geom2d`, `.loops` for `extrude`, centred on the
origin with U right and V up. The host lays the text out, since this crate reads no fonts. `text_outline_with(text, &Lettering)` takes
the style, weight, spacing, line spacing, alignment, angle and pen width too. A letter the font lacks is a `Refusal` with the
layout's sentence.

## One frame for reads and cuts (API 1.4)

Every read answers in the frame `s.apply` takes its numbers in: model space, where a part `model_place` moved or turned stands
(the part's own frame when it was placed with `frame: "part"`). `s.bounds`, `s.pick_face`, and the raw `faces_find`, `edges_find`,
`surface_at`, `model_describe` and `section` calls all do, so measure the part, compute a point, and cut at it: no offset to add.
Before 1.4 the reads answered in the solid's own frame, so on a moved part such a cut missed by the pose. `PickedFace` gains
`centre` (a sphere's) and `axis_point` (a point on a cylinder's or a cone's axis, or a sphere's centre). A picked face is still kept
in the part's own frame, so it stays on the part when the part moves.

## Gears (API 1.12)

`gears` is the library's `involute-gears` v1, adopted with the same names and the same numbers bit for bit
(`gear_outline`, `mate_phase`, `idler_centre`, `rack_outline`, ...; `tests/gears.rs` and `mcp/recipe-gears.test.ts`
compare them with the library copy in `tests/fixtures`), and `Gear`, true involute outlines: splines on the flanks, the
cutting rack's root fillet and undercut, arcs at tip and root, any pressure angle and profile shift, in the crate's own
trig. `ops::gear` is the kernel's gear step, which builds the same outline (`guide {kind:"gear"}`).

`gear_pair::classify` says how two external spur gears stand (`apart`, `meshing`, `tooClose`, `loose`, `toothOnTooth`,
`unbuildable`, `moduleMismatch`, `pressureMismatch`) from their centres and phases. `gear_pair::driven_turn` turns the driver by an
angle and the driven gear by `mate_turn` before that check. Gears whose tip circles do not meet are `apart`, different modules included; the outlines are compared only
when they do (`docs/collision-prototype.md`).

## Clock ingredients (API 1.14)

`horology` holds what a mechanical clock needs beyond `gears`, as pure functions in the crate's own trig, so lust and rustc
give the same numbers (`tests/horology.rs`, `mcp/recipe-horology.test.ts`). Outlines are `gears::Outline`, closed and
counter-clockwise; `outline_points` turns one into a polyline.

- **Going train.** `train_ratio` multiplies `(wheel, pinion)` stages; `escape_period_s` is `3600 / (ratio × escape teeth)`,
  one tooth a period (160:1 on 30 teeth is 0.75 s). `count_train` finds tooth counts within `TrainLimits` whose ratio gives
  a wanted period exactly, or says why none does; `train_options` lists every one, the most balanced first.
- **Graham escapement.** `EscapeWheel` has pointed teeth leaning forward so a pallet touches the tip only. `Graham` is the
  anchor: the pallets embrace `span_teeth` (a whole number and a half), the pivot stands `tip_radius / cos(180° × span /
  teeth)` above the wheel (the tangent rule), the locking faces are arcs about the pivot (entry outer, exit inner, both
  between the same radii), the impulse faces straight. Lock and impulse are anchor degrees, drop wheel degrees; a pallet is
  half a pitch less the drop thick. `anchor()` is the outline about the pivot, `rest_pose()` where to put both parts, and
  `refusal()` says why a set of numbers cannot work, down to a pallet meeting a tooth anywhere but its tip over a stepped beat.
- **Ratchet and click.** `Ratchet` has radial faces; `click` gives the click's outline, its pivot on the tangent through the
  face it bears on (so the push passes through the pivot), the angle at which it seats, and the lift that clears the tips.
- **Cycloidal clock teeth.** `ClockWheel` and `ClockPinion` follow BS 978-2 as S. Parks derives it ("Designing Cycloidal
  Gears"): wheel addenda the true epicycloid of a circle half the pinion's pitch radius, cut at 0.95 of where the flanks meet,
  pinions with radial flanks and round, medium or high ogival tops from the standard's table. The epicycloid points are
  exact; the standard's 1.4 f_a drawing arc is not used. Root corners are sharp.
- **Bores.** `hole`, `shaft` and `pin_bore` add the mean clearance of an ISO 286 fit (running H9/d9, sliding H7/h6, press
  H7/p6) and a printing allowance you measure (how much your printer makes a hole of that size undersize, added to the drawn bore: positive when holes print small, usually tenths of a mm); an ISO press class differs from a sliding one by only 12 to 35 microns, below what a filament printer resolves, so a printed press fit needs its interference chosen by measurement; `bearing` knows 20 small ball bearings (608, 623 to 626, 683 to 685, 693 to
  695, MR63 to MR115) with their seats and shafts.
## Reads of an animation's rig (API 1.15)

An animation script names keys; the host poses the frames. To key from the geometry, a script reads the rig at a pose it
states (`docs/plan-contact-poses.md`): `rig.first_contact(&mut s, &at, "Wheel", 1)` drives the wheel's joint from where
it stands at `at` until a part it moves first touches a part that stays (`Option<Touch>`: the angle, the two parts, the
clearance left, at most 0.01 mm); `first_contact_with` takes a `ContactAsk` (a part to touch, a range, a tolerance);
`rig.clearance` is the least distance between two members (mm, 0 when touching or crossing), `rig.crossing` the mesh
pass's verdict, and `rig.angle` a member's angle there (a gear train's follower as its lead turns it). `at` is a `Pose`,
resolved as a key at time 0 would be; nothing moves and nothing is kept between reads. `anim::frame_times(fps, end)` are
the times the host samples frames at, so keys put there are shown as read: since API 1.17, `k / fps` for
`k = 0 ..= ceil(end * fps)`, every frame `1/fps` apart, an end off that grid shown by the next frame. The numbers are the host's: the crate sends
JSON and reads JSON, so lust and rustc builds send the same calls and get the same answers.

## Recipes that use plugins (API 1.16)

`s.run_plugin(id, params)` runs a kept plugin from inside a recipe and hands back what it made: `PluginRun {plugin,
version, part, parts, metrics}`. The host runs it as a run of its own (its build, its parameters, its own parts only)
inside this run's transaction, time and calls, pins the version that ran with this run's parts, and keeps its code with
the project. A refusal is an `Err` with the plugin's sentence; nothing of that nested run is left. `run_plugin_version`
asks for one version. Where the host can assemble (`context.limits.canAssemble`), `attach(&part, &parent, at, turn)`,
`joint`, `hinge`, `slide`, `hold`, `turn_joint` and `couple_gears` place the parts the run made, set their joints and
couple their gears, as `model_place` does. The crate only sends and reads JSON, so lust and rustc builds send the same
calls (`mcp/plugin-recipes.test.ts`). See `docs/plan-plugin-recipes.md`.

## Frames on the 1/fps grid (API 1.17)

The host samples every animation at frame `k` = `k / fps`, for `k = 0 ..= ceil(end * fps)`, where `end` is the last key
time with its hold; an end off that grid is shown by the next frame, which holds the final pose. `anim::frame_times(fps,
end)` returns exactly those times (before 1.17 it returned the old `round(end * fps)` frames spread over `[0, end]`), and
`k as f64 / fps as f64` is the same number, so a script that keys every `1/fps` puts each key on a frame. A plugin of an
earlier level built against this crate gets the new times too: they are the host's. See `docs/plan-pose-animation.md`.

## Keyable slides (API 1.19)

`Aim::Travel(mm)` keys a slide's travel in millimetres. It encodes as a JSON number, the same shape as a hinge's degrees;
the host reads millimetres when the joint is a slide. `Pose::set(name, Aim::Travel(mm))` is that aim. A slide driven by
a coupling is still keyed through its lead (the pinion), as before.

## Organic surfaces (API 1.18)

The ops of `docs/plan-organic-surfaces.md` (app 7.2.0), each the JSON `mcp/schema.ts` takes:

- curves: `ops::nurbs_seg` (an exact NURBS segment of a profile loop: interior poles, weights for every pole start and end
  included, degree, knots with their multiplicities), `ops::curve3d_polyline` and `ops::curve3d_nurbs` (a 3D curve;
  `closed: true` makes a NURBS curve periodic);
- `ops::sweep(op, sections, spine)`: the kernel's sweep of sections along a 3D spine (chain `transition`, `mode`, `scale`
  stations `[u, factor]` with `u` from 0 to 1, `twistDeg` with `.set`);
- `ops::fillet_g2`, `ops::fillet_conic` (`rho` 0.05 to 0.95) and `ops::fillet_variable` (`[u, radius]` stations);
- `ops::loft_apex` (a point section, first or last) and `ops::loft` (chain `guides`, `startCondition`, `endCondition`,
  `closed`, `smoothing`, `maxDegree` 2 to 10);
- open sheets: `ops::sheet_extrude_spec`, `sheet_revolve_spec`, `sheet_loft_spec`, `sheet_planar_spec`, then `ops::sheet`,
  `ops::trim_split` or `ops::replace_face` with a spec; `ops::sew`, `ops::thicken`, `ops::split_face`;
- `ops::surface_boundary`, `ops::patch` and `ops::blend_surface`.

A host before 7.2.0 does not build these steps: a plugin that uses one records 1.18, and an older host refuses it in one
sentence instead of failing at the step. The server refuses what does not fit before the kernel sees it (weights or
knots that do not match the poles, a degree the poles cannot carry, a station outside 0 to 1, rho without a conic). The
corpus plugin is `mcp/fixtures/plugins/api-1.18-organic-surfaces.rs`.
