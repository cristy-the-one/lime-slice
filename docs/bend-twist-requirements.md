# Bend and twist: requirements

Open CASCADE has no operation that bends or twists a solid. These are the requirements for adding both in two
independent parts. **A** builds bent and twisted shapes when they are made, out of the loft that already exists, with no
kernel change. **B** adds a general `deform` op that bends or twists any solid already in the history.

Build A first. B does not depend on A, but both edit `mcp/session.ts` and `mcp/schema.ts`, so they go one at a time,
never in parallel.

Shared conventions, for both parts:

- Units are millimetres and degrees. Points are typed in the part frame, as every other Model op's are, and are turned
  into the solid's frame with `toSolidOp` (`src/model-space.ts`).
- Refusals are one plain sentence that says what to change, the same way the existing refusals in `mcp/compose.ts`
  (`separateReason`) and `kernel.cpp` are worded. No stack traces and no Open CASCADE class names.
- Each new field is described in `mcp/schema.ts`, so the test "every property has a description" keeps passing. The
  tool list stays under the cap in `mcp/schema.test.ts`. Raise the cap only if needed, and only by the bytes the new
  fields cost, with a comment saying so.
- Bump the version as a minor release, in every file the earlier bumps touched: `Cargo.toml`, `Cargo.lock` (the
  `lime-*` crates only), `README.md` (two places), `mcp/engine.ts`, `mcp/native-load.test.ts`, `mcp/protocol.ts`,
  `mcp/stdio.test.ts`, `package.json`, `package-lock.json` (two entries), and `src-tauri/tauri.conf.json`.
- Document the change in `docs/mcp-server.md`, in the `ops` guide in `mcp/guides.ts` (one worked example for each new
  field), and in `docs/step-modeler.md` for B's kernel op.
- Test in two ways. Unit tests run against the stand-in engine and are listed in `package.json` `test:unit`. Live
  checks run on the real kernel: build the bridge with `OCCT_ROOT=D:/occt-7.9.2 cargo build -p lime-model-occt`, run
  the MCP bundle (`node tools/mcp/bundle.mjs <dir>`) with `LIME_OCCT_BRIDGE` pointing at that DLL, and copy the
  Open CASCADE DLLs from `D:/occt-7.9.2/bin` next to it.

---

## A. Bend and twist at construction time

Bend and twist are added as fields on ops that already exist. Each one becomes a `loft`: the MCP server places the
sections, as `sweep` already does in `mcp/sweep.ts`. There are **no kernel, `tree.rs`, `src/` type, or file-format
changes**: the stored op is an ordinary `loft`, so saving, replay, resume, anchors, and colours all work as they do
for any loft.

### A1. `twistDeg` on `sweep`

- Field: `twistDeg`, a number from −3600 to 3600. Default 0.
- Meaning: each section turns about its own W axis (the path's direction there) by
  `twistDeg × (arc length from the start to this section ÷ the path's total length)`. That turn is added on top of the
  frame `sweepSections` already computes. The first section does not turn, and the last turns by `twistDeg`.
- Implementation: in `sweepSections`, rotate each section's U and V about W before building its Euler `turn`.
- Twist has no visible effect on a plain circle. When `twistDeg` ≠ 0 and the section is a circle with no `radiusV` and
  no profile, the sweep still builds, and the result adds this note: "A twist does not show on a round section; give
  radiusV or a profile."
- Section density: when the twist turns by more than 10° between two sections that already exist, add sections
  between them until no gap is over 10°. The total stays at most 200. If it would pass 200, refuse:
  "This twist needs more than 200 sections; twist less or shorten the path."

### A2. `twistDeg`, `scaleEnd`, and `bend` on `extrude`

`extrude` takes three new optional fields. With none of them, it stays the kernel's own extrude and its output must
not change at all (regression).

- `twistDeg`, from −3600 to 3600. The profile turns about the plane's W axis, through the plane's U, V origin, from 0
  at the start to `twistDeg` at the far end.
- `scaleEnd`, a positive factor. The profile is scaled about the U, V origin, from 1 at the start to `scaleEnd` at the
  far end. This gives a taper.
- `bend: {radiusMm, angleDeg, toward}`. The extrusion follows a circular arc instead of a straight line.
  - `radiusMm` is the radius of the arc the profile's U, V origin travels along. It is above 0.
  - `angleDeg` is the angle swept, above 0 and at most 360.
  - `toward` is `"+u"`, `"-u"`, `"+v"`, or `"-v"`: the in-plane direction the arc curves toward. Default `"+v"`.
  - The length along the arc is `radiusMm × angleDeg` in radians. With `bend` given, `depth` is ignored and must not be
    required. The schema keeps `depth` required only when `bend` is absent: check this in the session and refuse
    clearly if neither is given.
  - `symmetric` with `bend` is refused: "A bent extrude grows one way; leave out symmetric."
- Any combination is allowed. Twist and scale are spread along the arc length when `bend` is given, and along `depth`
  otherwise.
- How it is built: the server makes a `loft` whose sections are the profile, transformed for each station along the
  run.
  - A station's origin is either on the straight line (plane origin + W × s) or on the arc.
  - For a bend, the arc's centre is the plane origin + `radiusMm` × the `toward` direction. A station at arc angle φ
    has its origin turned φ about the axis through that centre along `toward` × W. Its W turns by the same φ, so each
    section stays square to the arc.
  - Each section's own U and V carry the progressive twist and scale.
  - The profile's `smooth` and `corners` carry over to every section.
- Section density: there is a section at least every 10° of twist and every 10° of bend, and at least 2. With only
  `scaleEnd`, 2 sections, ruled. The total is at most 200, refused past that as in A1.
- Refusals:
  - `bend.radiusMm` must be larger than the profile's reach toward the centre: the largest distance any profile point
    lies on the `toward` side of the origin. Otherwise refuse: "The bend radius must be larger than the profile's
    reach toward the bend, X mm."
  - `scaleEnd` ≤ 0 → "scaleEnd is a factor above 0."
- What is stored: the `loft`. The echoed `typed` is the extrude as the caller wrote it (as `sweep` echoes its own
  fields), plus `sections: N`. The step's label is the caller's `label` if given; otherwise the loft's own label.
- Anchors: no change is needed, because `opBox` already handles a loft.

### A3. Schema, docs, guide

- Add the fields to the `sweep` and `extrude` branches in `mcp/schema.ts`. Keep each description short.
- `docs/mcp-server.md`: add a paragraph under "Kernel sketch ops" that gives each field's exact meaning, as above.
- `ops` guide, worked examples:
  - a twisted square vase: an extrude of a 30 mm square, depth 60, `twistDeg` 90, `scaleEnd` 0.7;
  - a bent bracket: an extrude of a 10 × 4 rectangle with `bend` {radiusMm 20, angleDeg 90};
  - a twisted ribbon: a sweep with a flat profile and `twistDeg` 180.

### A4. Tests: a new `mcp/bend-twist.test.ts` (stand-in engine)

These check the section layout, not the solid, since the stand-in builds nothing.

1. Extrude with no new fields: the stored op is `kind: "extrude"`, byte-identical to before.
2. Extrude, 10 × 10 square, depth 20, `twistDeg` 90.
   - The stored op is a loft with at least 10 sections.
   - The first section's turn equals the plane's turn.
   - The last section's U axis is the plane's U turned 90° about W, within 1e-6.
   - Section origins lie on the W line, evenly spaced from 0 to 20.
3. Extrude, `scaleEnd` 0.5, no twist: 2 sections, `ruled: true`, and the last profile's points are half the first's.
4. Extrude with `bend` {radiusMm 30, angleDeg 90, toward "+v"} on the XY plane, W = +Z.
   - Every section origin is at distance 30 from the arc centre (plane origin + 30 V).
   - The last section's W points along +V, within 1e-6.
   - There are at least 10 sections.
5. A bend whose radius is at or below the profile's reach toward it is refused, and the sentence names the reach.
6. A twist that needs more than 200 sections is refused with the A1 sentence.
7. Sweep with `twistDeg` 90 along a straight 20 mm path, `radius` 3, `radiusV` 1: the last section's U axis is turned
   90° from the first's about the path.
8. Sweep with `twistDeg` on a plain circle builds, and the result carries the round-section note.
9. The schema accepts the new fields and refuses an unknown field inside `bend`.

### A5. Live acceptance (real kernel)

The results must match these within the tolerances given:

- Twisted prism: 10 × 10 square, depth 20, `twistDeg` 90, fused onto a block. The volume added is 2000 mm³ ± 1%.
  A twisted prism keeps its volume.
- Bent bar: 10 × 4 rectangle centred on the U, V origin, `bend` {radiusMm 30, angleDeg 90}. The volume added is
  40 × 30 × π/2 = 1885.0 mm³ ± 1%.
- Taper: 20 × 20 square, depth 30, `scaleEnd` 0.5. The volume added is
  30/3 × (400 + 100 + √(400 × 100)) = 7000 mm³ ± 1%.
- Twisted ribbon sweep (`twistDeg` 180, profile 8 × 1): builds, and `model_check` reports no islands.
- `render_view` of each looks smooth, with no visible faceting along the twist.

### A6. Out of scope for A

Changing a solid that already exists (that is B). Bending a revolve or a loft. Twisting about an axis other than the
extrude's W.

---

## B. `deform`: bend or twist any existing solid

A new kernel step. It deforms the whole current solid by an analytic map, approximating the result as B-spline
surfaces within a stated tolerance, and refuses with a sentence whenever the result is not sound.

### B1. The op

Stored op and engine JSON, camelCase as elsewhere:

```
{ kind: "deform", mode: "twist" | "bend", origin: [x,y,z], axis: [x,y,z],
  angleDeg, from?, to?,                 // twist
  toward?: [x,y,z], radiusMm?,          // bend (angleDeg is the bend's total)
  toleranceMm?: number }                // default 0.01, from 0.001 to 0.2
```

MCP ops: `{kind: "twist", origin, axis, angleDeg, from, to, toleranceMm, label}` and
`{kind: "bend", origin, along, toward, radiusMm, angleDeg, toleranceMm, label}`. Both bake into the stored `deform`.
They are plain ops: probed, applied, labelled, and resumable like any other.

### B2. The maps (exact definitions)

Let `o` = origin and `a` = the unit axis.

**Twist.** For a point p:
- h = (p − o)·a
- t = clamp((h − from) ÷ (to − from), 0, 1)
- θ = angleDeg × t
- p′ = o + Rot(a, θ)(p − o)

Defaults: `from` and `to` are the solid's extent along `a`. Below `from` nothing moves. Above `to`, the material turns
rigidly by `angleDeg`. If `to` ≤ `from`, refuse: "to must be past from along the axis."

**Bend.** For bend, `axis` is called `along`; call it d. `toward` is the unit vector n, square to d. If it is not
square to `along`, refuse: "toward must be square to along." R = `radiusMm` (the neutral layer's radius),
Φ = `angleDeg` in radians, and L = R × Φ.

For a point p:
- s = (p − o)·d
- z = (p − o)·n
- w = p − o − s d − z n
- s < 0: p′ = p.
- 0 ≤ s ≤ L: φ = s ÷ R, and p′ = o + w + d (R − z) sin φ + n (R − (R − z) cos φ).
- s > L: carried rigidly. With d′ = d cos Φ + n sin Φ and n′ = −d sin Φ + n cos Φ,
  p′ = o + w + d R sin Φ + n R (1 − cos Φ) + (s − L) d′ + z n′.

The neutral layer z = 0 keeps its length. Refuse when any part of the solid inside 0 ≤ s ≤ L has z ≥ R (material past
the bend's centre): "The bend radius must be larger than the part's reach toward the bend, X mm."

### B3. Kernel algorithm (`kernel.cpp`, `build_deform`)

1. Check that the map's inputs are finite, and that `axis`, `along`, and `toward` are not zero. Refuse otherwise.
2. `BRepBuilderAPI_NurbsConvert` the solid, so every face, edge curve, and pcurve is a B-spline.
3. Do the deformation with a custom `BRepTools_Modification`, run through `BRepTools_Modifier`, on the converted
   solid:
   - **NewSurface:** copy the face's B-spline surface. Insert knots in U and V until it passes the tolerance check in
     step 4. Then move every pole through the map. The weights stay the same. Keep the same parameter ranges, so the
     pcurves stay valid as they are.
   - **NewCurve (3D edge curves):** return false, and rebuild them afterwards with `BRepLib::BuildCurves3d` from the
     pcurves on the new surfaces. Faces and edges then agree.
   - **NewPoint (vertices):** the map applied to the vertex.
   - **NewCurve2d:** return false; the pcurves are unchanged.
4. **Tolerance check, per face.** Sample a 9 × 9 grid of (u, v) over the face's parameter range. Compare
   map(original surface point) with the new surface point at the same (u, v). If the largest gap is over
   `toleranceMm`, add knots midway in the spans where the gap is over the tolerance, and try again. Stop after 6
   rounds or 400 poles a direction; if it still fails, refuse:
   "This deform needs a finer surface than allowed near (x, y, z). Deform less, or deform before adding fine detail."
   The position is the worst sample's.
5. Then run `BRepLib::SameParameter` and `ShapeFix_Shape` on the result. It must be one valid solid
   (`BRepCheck_Analyzer`), with as many solids and shells as before. Otherwise refuse:
   "The deformed part is not a sound solid; it may fold through itself near (x, y, z)." Give the position of the first
   bad face's centre.
6. Volume check:
   - Twist keeps the volume exactly. Refuse if it changed by more than 0.5%.
   - Bend: compute the expected volume as V_out + ∫ over the bent zone of (1 − z ÷ R) dV, sampling the original solid's
     mesh to integrate. Refuse if the result is more than 1% off. Name the step the same way as other refusals.
7. The result goes into the tree like any other step, and its fingerprint is checked on replay as usual.

### B4. Rust, C ABI, and TypeScript wiring (the extrude and loft pattern)

- `crates/lime-model-occt/src/tree.rs`: add `Op::Deform` with the fields above (`serde(rename_all = "camelCase")`;
  optional fields skipped when absent), build it through a new `lime_tree_deform` FFI, and add it to `build`.
- `crates/lime-model-occt/cpp/tree.cpp` and `kernel.h`: `lime_tree_deform(from, p[], mode, error)` and `build_deform`.
- `src/model-tree.ts`: a `DeformOp` type, added to `ModelOp`, and an `opLabel` such as "Twist 90° about Z",
  "Bend 90° r 30".
- `src/model-tree-file.ts`: read the op back from a `.lime` file, validating every field.
- `src/model-space.ts` `toSolidOp`: move `origin` through the pose, and turn `axis`, `along`, and `toward` through it.
- `src/model-edit.ts`: no edit panel. Add `deform` to the kinds `editRefusal` turns away.
- `src/model-feasibility.ts`: add `deform` to `PROBED_TOOLS`, with checking and fits sentences.
- `mcp/session.ts` bake: `twist` and `bend` become `deform`. Add them to `session_info`'s ops list.
- `mcp/anchors.ts` `opBox`: return null for `deform`. It has no tool box: anchors to a deform's label refuse, and the
  docs say so.
- `mcp/compose.ts`: `addsPiece` does not apply. `cutsOffPiece` does not apply.

### B5. Tests

**Rust**, a new `crates/lime-model-occt/tests/deform.rs`, which must pass with `LIME_REQUIRE_OCCT=1`:

1. Twist a 10 × 10 × 40 box 90° about its Z axis, over its full height:
   - the volume is 4000 ± 0.5%;
   - the top face's corners sit at the base corners turned 90° about the axis, ± 0.02 mm (find them with the face
     picker, or from the reply's bbox at a 45° twist, where the half-width is 5√2);
   - the result is one valid solid.
2. Twist with `from` and `to` set to the middle 20 mm: the bottom 10 mm keeps its exact corners, and the top 10 mm is
   rigidly turned by the full angle.
3. Bend a 100 × 10 × 4 bar (along X, centred on z = 0) about `toward` +Z, R 30, 90°, from x = 0:
   - the volume is preserved within 1%;
   - the far end face's centre is at o + R d sin Φ + R n (1 − cos Φ) + (100 − L) d′, ± 0.05 mm.
4. A bend with R below the part's reach toward it is refused with the B2 sentence.
5. Apply a deform, then a boolean cut through the deformed part: the cut builds, and the volume drops by about the
   tool's overlap.
6. Replay: save the tree, reopen it, and get the same fingerprint.
7. A twist so tight it cannot meet 0.001 mm is refused with the B3.4 sentence, and does not crash.

**MCP**, a new `mcp/deform.test.ts` (stand-in engine):
- `twist` and `bend` bake into `deform` with the right defaults;
- schema refusals;
- `toSolidOp` under a moved and turned pose turns `axis` and `toward`;
- `model_anchors` on a deform label refuses.

### B6. Live acceptance

On the real kernel, twist a finished swept fish body 30° about its length, then cut a 1 mm eye hole through the
deformed surface:

- every step applies;
- `model_check` reports no islands;
- the render is smooth;
- the whole run takes under 10 s.

### B7. Known costs; document them

- Every face becomes NURBS, including planes. Booleans and fillets after a deform are slower, and are more likely to be
  refused. The guide must say: deform late in the history, then add only simple cuts.
- The result is held to `toleranceMm`, not exact.
- A deform has no tool box, so it cannot be an anchor, a highlight, or a colour target.

### B8. Out of scope for B

Freeform deformation lattices. Taper as a deform (A's `scaleEnd` covers construction time). Deforming a mesh-imported
object without a Model solid: refuse, with the meshBlock message the other ops already give.
