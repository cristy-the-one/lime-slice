# Mass properties (F3 of the clock note)

The clock build computed its pendulum's period outside the server, because Lime Slice could not say what a part weighs,
where its centre of gravity is, or how hard it is to turn about its hinge. This plan is the spec for that: one
computation shared by the window and the MCP server, an MCP tool `model_mass`, three functions in `lime_recipe::mech`,
and a few read-only lines in Pose. Target version 6.8.0.

The standard: every number is computed from the geometry, with its unit, and the reply says what it is computed from.
When a number cannot be given, the reply says why in one sentence. Nothing is estimated and shown as measured.

## D1. The computation (`src/mass.ts`, no DOM)

- **Input**: a closed triangle mesh, as the soup of nine numbers per triangle the plate and the solids keep.
- **Integrals**: volume, first moments and second moments by the exact polyhedral integrals (each triangle with the
  origin is a signed tetrahedron; the sums are Eberly's closed forms). They are exact for the mesh: the only error is
  the mesh's own (a cylinder's facets), never the method's.
- **Closed or refused**: the mesh is checked as `model_check` checks it (`edgeReport`, cracks mended by `closeCracks`
  first). A mesh with open edges is refused: "*name*'s mesh has N open edges, the first at (x, y, z), so it encloses
  no volume to weigh. model_check lists them." A mesh whose volume comes out zero is refused the same way. A mesh that
  is inside out (negative volume, or a mirrored pose) is weighed with its sign turned.
- **Per part, once**: the integrals of a part's mesh are computed in its own frame and kept per mesh array (a
  `WeakMap`), then moved to the part's pose analytically (x' = A x + t: V' = J V, F' = J (A F + t V), S' = J (A S Aᵀ
  + A F tᵀ + t (A F)ᵀ + V t tᵀ), J = |det A|). Turning a hinge never re-reads a mesh.
- **Body**: the parts' integrals at their assembled poses, each times its density, summed. From the sums: mass (g),
  centre of gravity (mm), and the inertia tensor about the centre of gravity (g·mm²), in model axes.
- **Derived**: principal moments and axes (Jacobi); the moment of inertia about any axis line (parallel-axis theorem,
  I = nᵀ I_G n + m d²) and the distance d from that line to the centre of gravity; and for an axis that is not vertical
  the small-swing period as a compound pendulum, T = 2π √(I / (m g d)), with the equivalent simple-pendulum length
  L = I / (m d). Gravity is 9806.65 mm/s² along −Z of model space. For a tilted axis only gravity's part across the
  axis swings the part (g sin θ, θ the axis's angle from vertical); the reply gives that value. A vertical axis, or a
  centre of gravity on the axis, has no period, with a sentence.
- **Rest**: the period is about the rest pose, the centre of gravity straight below the axis. The reply also gives how
  far the current pose is from it (`offRestDeg`), so a caller sees whether the part hangs as posed.

## D2. What "mass" means in each reply

Two masses, never mixed without saying so:

1. **Solid at a density** (always given). The body's volume times a density in g/cm³: the selected filament's
   `densityGCm3` (the filament record, the same number the slice estimate uses), or `density` when the call gives
   one. The reply says which, and says plainly: *this is the mass of a solid body; a printed part with walls and infill
   weighs less*. Inertia, centre of gravity and period are of the solid body at that density.
2. **Sliced grams** (offered when they exist). When the latest slice is done, current (not stale), sliced this one
   object alone, at plate scale 100 %, and the body is that one part: the slice's grams of the part's own beads (walls,
   infill, top and bottom, bridges, ironing; supports, skirt, brim and travel left out), from the same filament length the
   G-code summary reports. The inertia is that of the solid scaled by the mass ratio, which **assumes the printed mass
   is spread like the solid's** (walls are denser than infill, so it is not, exactly): the reply says so. The period
   and equivalent length do not change under that scaling (both depend on I/m), and the reply says that too. When a
   slice exists but cannot be used, `slicedNot` says why in a sentence.

## D3. The body

A part outside an assembly is its own body. An assembly member's body is the part that moves with it: up through
members seated without a joint (`held` included, as it rides its parent) to the first member with a joint, or to the
root; then that member and every member seated on it, down through members without a joint. A gear on its own hinge
on the body is not part of it. The reply names the body (`body`) and lists each part with its own volume and mass.
Poses are the assembled poses (`modelPose`, as `model_check {interference}` reads them). A Model part is weighed from
its current solid, a mesh part from its plate mesh lifted to its seat, as the interference check does.

## D4. MCP: `model_mass {object, about?, density?}`

- `about: "hinge"`: the body's hinge (pivot and axis in its part frame, turned to model space). A body with a slide,
  ball or no joint is refused with a sentence naming what it has. `about: {point, axis}`: any line, typed in the
  frame the part's numbers are read in (as `surface_at` and `model_describe` answer).
- Reply: `body`, `parts`, `volumeMm3`, `mass {grams, source, densityGCm3, from}`, `centreOfGravityMm` with `frame`
  (the object's frame, `model` unless `model_place {frame:"part"}`), and `centreOfGravityModelMm` when that frame is
  the part's, since gravity is in model space; `principalInertia {momentsGmm2, axes}` about the centre of gravity;
  with `about`: `about {pointMm, axis, inertiaGmm2, leverMm, pendulum {periodS, lengthMm, gravityMmS2, offRestDeg} |
  noPeriod}`; `sliced {grams, massRatio, inertiaGmm2, ...}` or `slicedNot`; `note` with the sentences above.
- Read-only, in the `model` group, described in full in `TOOLS`, with an example; documented in `docs/mcp-server.md`.

## D5. lust: `lime_recipe::mech` (recipe API 1.13)

`pendulum_period(length_mm) -> s`, `pendulum_length(period_s) -> mm`, `compound_period(inertia_g_mm2, mass_g, d_mm)
-> s`, `equivalent_length(inertia_g_mm2, mass_g, d_mm) -> mm`, `G_MM_S2 = 9806.65`. Only `*`, `/`, `sqrt` and `std::f64::consts::PI`, so lust and rustc give the same bits;
`mcp/recipe-mech.test.ts` runs one recipe under both and compares. A new module is an addition, so the crate's API
moves to 1.13 (D12 of docs/plan-recipe-plugins.md) with a corpus plugin `api-1.13-pendulum.rs`, and
`RECIPE_API` in `src/plugin-step.ts` with it. If another branch takes 1.13 first, this one becomes 1.14.

## D6. The window

In Pose, under the selected member's joint fields, a "Mass" block of read-only lines: the body's mass at the selected
filament's density (solid), its centre of gravity in model space, and for a hinge its inertia, lever arm and period with
equivalent length, or the sentence why there is none. The same `src/mass.ts`; no new setting, no sliced grams.

## Tests

`src/mass.test.ts`: a box (volume, centre, I = m(b² + c²)/12), a fine cylinder against πr²h and m r²/2, a thin rod
about its end against T = 2π √(2L / 3g), the point pendulum 139.73 mm = 0.75 s, two parts composed against the sum,
the parallel-axis step, a moved and turned pose against the same mesh baked, an open mesh refused, a vertical axis
refused. `mcp/mass.test.ts` on the fake engine: a box, an assembly with a pendulum rod and a bob seated on it,
`about:"hinge"`, `about {point, axis}`, a part frame, the density override, refusals. `mcp/recipe-mech.test.ts`: the
same numbers from lust and rustc.
