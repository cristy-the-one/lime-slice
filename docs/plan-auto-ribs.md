# Plan: reinforcement ribs added automatically, where the part needs them

Status: plan, for review. Written 2026-11-17 against `main` at e00c56b0 (6.10.0). It changes no code. The owner has approved building after this plan; each step in section 8 ships as its own small PR with before/after numbers.

The request, in short: add reinforcement ribs to a part automatically, where they are needed and no more than needed, as a change to the solid (so the STEP changes), without getting in the way of what the part is for. The nearest thing a designer does today is apply one uniform rib pattern over the whole inside of a cover, known to be overkill. The team's worked example is such a ribbed cover; it is a company part, so its measurements and pictures are kept outside the repository and this document does not describe it.

The yardstick the owner set for choosing a method: **the automatic route must be so much less work than drawing ribs by hand that the manual route is not a serious alternative.** Every option below is scored by a count of what the user must give and must repair.

Evidence marks used below: **[read]** the source itself was opened; **[abstract]** only its abstract or index record; **[inferred]** our own reasoning; **[probe]** tried on this machine against the 6.9.0 engine; **[code]** read in this repository.

## 1. The short answer

- **No product does this with one button.** Fusion, nTop, Altair Inspire, SolidWorks, Creo, Ansys Discovery and NX each offer either a manual rib from a sketch, or an optimisation that needs a design space, loads and holds and returns an organic shape, a mesh or embossed beads. FreeCAD and its add-ons have no automatic ribs either, and no released Part Design rib at all.
- **The method that fits is published and proven on curved shells**: solve the bare shell, lay candidate ribs along the directions the shell bends in, keep the ribs that take the most strain out of the shell for their material, size them, check again (Li et al. 2017; Gil-Ureta, Pietroni & Zorin 2020). Neither has public code and both output meshes. We re-implement it on our own solver and kernel, and output real editable solid steps, which neither paper does.
- **Full topology optimisation is the wrong lane.** Left free, it thickens the wall instead of making ribs; forced to make ribs, it needs fine meshes and tuning, and its result is a density cloud that has to be turned back into geometry. Nothing in the app can do that last step, and FreeCAD's own path for it is weak.
- **"Bio-inspired" holds up as a procedure, not as a pattern.** No fair test shows leaf-vein, Voronoi or isogrid patterns saving material against ribs aligned with the load. What saves material is alignment with the load and sizing. Growing ribs from where the strain is highest and pruning the ones that do little is the defensible "organic" part, and it is what we build.
- **What the user does: four actions.** Open Auto ribs, click the wall to reinforce, Run, Apply. Holds and loads are optional: with none given, the wall is pressed evenly and held at its edges, which answers "this cover is floppy". A user who knows the real load gives it with the same Hold and Load controls as Stress.
- **What is new work**: a fast solve of a thin wall as a shell (today's Stress study solves the sliced beads on a block grid, which cannot resolve a 2 mm wall on a large part), the rib planner, and a rib-network step in the modeler. The modeler can already build a rib along any path on a curved wall from existing steps [probe], so the kernel is not the blocker.

## 2. State of the art

### 2.1 Topology optimisation and thin walls

- **SIMP, level-set, BESO** take a meshed design space, loads, holds and a material budget and return a density or a boundary, not features. The teaching codes are 2D ([DTU 88-line page](https://www.topopt.mek.dtu.dk/apps-and-software/efficient-topology-optimization-in-matlab) [read]).
- **Left unconstrained, the stiffest answer is a sheet, not ribs.** Sigmund, Aage & Andreassen 2016 found variable-thickness sheets up to 80 % stiffer than frame-like designs in practical single-load cases, and say ribs or frames win only once buckling or a minimum feature size enters ([accepted manuscript](https://backend.orbit.dtu.dk/ws/files/140300672/Michell_plain.pdf) [read]). A plastic cover has a fixed wall and bends out of plane, which is the case where ribs are right.
- **Variants built to output ribs** (stiffener height as a variable, casting-direction constraints, moving morphable components) are mostly shown on flat plates ([Wang & Zhang 2023](https://www.frontiersin.org/articles/10.3389/fmats.2023.1277421/full) [read]; [Huo et al. 2023](https://arxiv.org/abs/2306.10449) [abstract]). The giga-voxel wing that "discovered" curved ribs needed about 8,000 processors for days ([Aage et al. 2017](https://orbit.dtu.dk/en/publications/giga-voxel-computational-morphogenesis-for-structural-design/) [abstract]).

### 2.2 Rib layout on shells

- **Li, Zheng, You, Yang, Zhang & Liu 2017, "Rib-reinforced Shell Structure"** ([manuscript](https://eprints.bournemouth.ac.uk/29571/1/ribShell-revised5-lowres.pdf) [read]). A triangle shell with loads and holds; the shell as membrane plus plate-bending triangles, ribs as beams on mesh edges; candidate ribs traced along the smoothed principal stress directions; each rib scored by how much strain energy it removes, weak ones dropped; sections sized under a stress limit. Printed test at equal weight: the bare shell bent 5.6 mm at 30 N, the ribbed one 1.2 mm at 33 N. Honest detail: at equal rib volume a plain quad grid did as well (38.4 MPa against 40.0), and a Voronoi grid did worse (43.7). Single load case; output is a mesh.
- **Gil-Ureta, Pietroni & Zorin 2020, "Reinforcement of General Shell Structures"** ([author PDF](https://cims.nyu.edu/gcl/papers/2020-shells.pdf) [read]). Same shape of pipeline with a better field and an exact volume model that moves smoothly between ribs and a thicker wall. 1.44× stiffer than Li's ribs at equal weight; 1.08× to 26.9× stiffer than an equal-weight plain shell over 16 consumer-type models; 2 to 80 s. They report that using the plain solved stress field instead of their optimised one changes little, which is what lets a first version skip their hardest step. Single load case; output is a mesh; no code.
- **Stress-line methods.** Tam & Mueller 2015 trace principal stress lines and add them one at a time, watching the gain fall off; one shell example was 20 % more efficient than a mesh grid at equal volume ([paper](http://papers.cumincad.org/data/works/att/acadia15_095.pdf) [read]). A BSD-2 MATLAB tracer for shells exists, with the known trouble spots (points where the two principal stresses are equal) handled ([PSLshell](https://github.com/PSLer/PSLshell) [read]).
- **Adaptive growth** (Ding & Yamazaki 2004 and followers): stiffeners grow and branch from seeds over a set of candidate beams, with later versions for vibration and buckling ([index record](https://doi.org/10.1016/j.compstruc.2014.01.022) [abstract]). Results depend on seeds and tuning constants. No public code.
- **Ribs from buckling or vibration modes**: used in practice; we found no primary paper that validates the simple "rib across the first mode" rule against an optimiser. Treat as a later extension.

### 2.3 Bio-inspired patterns: the evidence

| Pattern | What the source shows | Saving against a load-aligned grid |
|---|---|---|
| Leaf venation ([Runions et al. 2005](https://www.algorithmicbotany.org/papers/venation.sig2005.html) [abstract]) | A growth model for how veins look | None claimed; no mechanics |
| Bone remodelling (Huiskes 1987 [abstract]) | Material follows strain energy | As a method it is the same update as BESO; open, bone-like cells lose up to 57 % in stiffness against closed ones (cited in Sigmund 2016 [read]) |
| Voronoi ribs ([Pietroni et al.](https://arxiv.org/abs/1408.6591) [abstract]) | Cells sized by stress | Worst of three at equal volume in Li 2017 [read] |
| Isogrid ([NASA CR-124075](https://ntrs.nasa.gov/citations/19730011184) [read, record]) | Triangular grid, designed by analysis | Behaves the same in every direction: good when the load direction is unknown, not a saving |

The working variable is alignment with the load plus sizing. This plan uses growth and pruning by strain energy, and does not ship pattern libraries as if they saved material.

### 2.4 Rib rules for plastic, and what changes for printing

| Rule | Moulded | Filament print | Resin print |
|---|---|---|---|
| Rib thickness | at most 60 % of the wall, against sink ([Protolabs](https://www.protolabs.com/resources/design-tips/design-stronger-molded-parts/) [read]; DuPont: 1/2 to 2/3 [read]) | no sink, so no need to thin ([Stratasys FDM guide](https://www.stratasys.com/siteassets/sdm/content---website-storage/design-guides/dg_sdm_fdm_0725a.pdf) [read]); a whole number of bead widths, at least two [inferred from slicer behaviour] | minimum wall 0.2 mm ([Formlabs Form 4](https://formlabs.com/global/support/Design-specifications-for-3D-models-Form-4L-generation/) [read]) |
| Rib height | under 3× rib thickness, several short ribs over one tall ([Stratasys Direct moulding guide](https://stratasys.com/siteassets/sdm/resources/design-guidelines/injection-molding/injection_molding_design_guidelines_2017.pdf) [read]) | limited by clearance and by standing as a thin wall | same |
| Draft | 0.25 to 0.5° a side [read] | none needed [read] | none |
| Root fillet | 0.25 to 0.5× thickness [read] | not needed, but cuts stress [read] | same |
| Overhang | n/a | 45° from the build direction; bridges 5 to 10 mm ([Hubs](https://www.hubs.com/knowledge-base/how-design-parts-fdm-3d-printing/), [Ultimaker](https://ultimaker.com/learn/design-for-fff-3d-printing-maximize-your-success/) [read]) | over 10° from level, 5 mm spans [read] |
| Special trap | sink on the show face | weak across layers; on a 45° belt the overhang test is in the tilted layer frame. No vendor gives a number ([OrcaSlicer belt guide](https://www.orcaslicer.com/wiki/guides/belt_printing) [read]); `model_check` already measures it | ribs can close pockets that trap resin (cupping); pockets need a vent ([Formlabs](https://formlabs.com/global/support/Cupping-Blowout/) [read]) |

Why ribs at all: bending stiffness goes with the cube of the height. DuPont's equal-stiffness examples replace a flat wall by a thinner ribbed one for 24 to 45 % less material ([DuPont General Design Principles](https://academic.sun.ac.za/mad/catalogs/dfmguidelines/dupontgeneraldesignprinciples.pdf) [read]). The Covestro guide could not be opened, so no numbers are taken from it.

### 2.5 What commercial tools ask of the user

| Tool | What it does | The user gives | Comes out |
|---|---|---|---|
| Fusion Rib / Web ([help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-RIB.htm) [read]) | manual rib | a sketch per rib line, thickness, draft | parametric feature |
| Fusion Generative Design ([help](https://help.autodesk.com/cloudhelp/ENU/Fusion-GenerativeDesign/files/GD-MFG-METHODS.htm) [read]) | new shape between kept bodies | keep bodies, obstacle bodies, loads, holds, method, material | organic bodies |
| Fusion Shape Optimization ([help](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/SIM-SHAPE-OP.htm) [read]) | shows removable material | loads, holds, target mass | a mesh to model over |
| nTop rib workflow ([guide](https://docs.ntop.com/help-articles/knowledge-base/rib-design/guide-to-rib-design) [read]) | a rib pattern projected on a surface, height and thickness driven by a field | a block graph the user builds, a pattern, a solved field | an implicit body |
| Altair Inspire rib ([help](https://2024.help.altair.com/2024/inspire/en_us/topics/shared/geometry/rib_t.htm) [read]) | manual rib | a sketch, thickness, draft | geometry |
| Altair topography optimisation ([help](https://help.altair.com/inspire/en_us/topics/inspire/structure/optimization_topography.htm) [read]) | beads pressed into a sheet | loads, holds, bead width, height, angle | beads, not ribs |
| Creo topology + Generate Design ([help](https://support.ptc.com/help/creo/creo_pma/r12/usascii/generative_design/generate_design.html) [read]) | optimised shape rebuilt as a solid | a full study | facets or a freeform solid |
| SolidWorks, Ansys Discovery, NX | manual rib; topology study | as above | mesh or smoothed body (help pages not opened; search summaries only) |

None adds ribs to an existing thin-walled solid from one command. CATIA, MSC Apex, Moldflow and SimSolid were not checked. Patents were not searched; a search is owed before the feature is advertised.

## 3. FreeCAD and its extensions: emulate, borrow or delegate

| Piece | What it really does | Licence | State | Verdict |
|---|---|---|---|---|
| FEM workbench ([source](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Fem/femobjects/solver_calculix.py) [read]) | Sets up static, frequency and buckling runs; meshes with Gmsh or Netgen; runs CalculiX; reads results back | LGPL-2.1 | part of FreeCAD 1.1 | **Emulate** the analysis on our solver. Nothing to embed: it is an orchestrator |
| CalculiX ([site](http://www.dhondt.de/) [read]) | General solver; shells are expanded into bricks ([manual](https://sources.debian.org/data/main/c/calculix-ccx-doc/2.11-1.1/ccx_2.11/doc/ccx/node37.html) [read]) | GPL-2 | current | **Borrow, in reserve only**: as a separate program run over files, if shell buckling is ever needed and ours falls short |
| Gmsh ([licence](https://gmsh.info/LICENSE.txt) [read]) | Mesher | GPL-2+, exception only for Netgen, METIS, OCCT, ParaView | current | Not linked. Our shell mesh comes from the kernel's own triangulation |
| `beso` ([repo](https://github.com/calculix/beso) [read]) | BESO over CalculiX runs; stiffness, failure, buckling; switches shell thickness per element; has a draw-direction filter. Output is result meshes | LGPL-3.0 | last commit 2025-04, fixes unmerged | **Emulate the idea** (rank by sensitivity, add and remove), re-derived from the paper, not from the code. Useful as a cross-check on a developer machine |
| FEMbyGEN ([docs](https://reqrefusion.github.io/FreeCAD-Documentation-html/wiki/FEMbyGEN_Workbench.html) [read]) | Design-of-experiments loop plus the same BESO | LGPL-2.1 | active | **Delegate** at most, in documentation |
| ToOptix | SIMP, 3D only | GPL-2 add-on | fails above FreeCAD 0.17 | Ignore |
| Part Design rib | Does not exist in any release; two open requests; a draft change is unmerged ([PR](https://github.com/FreeCAD/FreeCAD/pull/32555) [read]) | LGPL-2.1 | not merged | **Emulate** rib construction in our kernel |
| Small rib add-ons (RibTool, PartDesignUpgrade) | Manual rib or corner gusset from picks | MIT / LGPL | tiny | Nothing to take |
| SheetMetal, Curves, Lattice2 and the other workbenches checked | No ribs, gussets or stiffeners on an existing part | mixed | | None |
| Mesh to solid (Shape from Mesh, Reverse Engineering) | One flat face per triangle; the workbench is empty | LGPL | weak | This is why an "optimised blob" route fails there too |

**Licence facts** (from the licence texts and the FSF FAQ, not legal advice). Open CASCADE is LGPL-2.1 with an [exception](https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/master/OCCT_LGPL_EXCEPTION.txt) that lets code compiled against its headers go out under our terms, with a notice [read]. A GPL program shipped in the same installer and run as a separate process over files is aggregation ([FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation) [read]); we would owe its source or a written offer and the licence text. Linking GPL code into the app would make the app GPL. Copying LGPL source into a crate makes that file LGPL, so we re-derive from papers. Re-implementing a published algorithm is not a copyright matter.

**Verdict: emulate.** Nothing is borrowed at link level, nothing is delegated. The user needs nothing outside the app.

## 4. What Lime Slice already has

| Piece | Head start? | Why |
|---|---|---|
| STEP in as an editable solid, History, STEP out [code] | Yes | The prerequisite. Open shells are measure-only |
| The manual `ribs` step (even strips across a flat face) [code, probe] | Yes, as the pattern to copy | One History row, clipped to the face, merges into walls, a crossed set makes a grid. Flat faces only; curved faces are refused. **Bug found**: on a sloped floor a rib broke 0.2 mm through the outer skin |
| Group step with `combine` (many tools, one fuse) [code, probe] | Yes | 300 crossing rib segments fuse in about 9 s as one step, against about 125 s one by one |
| Loft through sections, extrude with draft [code, probe] | Yes | A rib along any curve on a curved wall was built by a loft whose sections stand along the surface normal. A rib lying in one plane was built from a section of the wall, offset and extruded. Both kept the outer skin untouched |
| Sweep, extrude "up to face" [probe] | No | The sweep leans on curved walls; "up to" stops on flat faces only |
| Lettering on freeform faces [code, probe] | Partly | Already raises a strip along the normal of a freeform face; cannot cross a face edge |
| Fillet [probe] | Partly | Root fillets work by explicit edge. A fillet over a whole 290-segment network did not finish in 90 s |
| Stress study [code, probe] | Partly | Real head start: holds and loads from picked faces, load cases, layer-aware materials, a fast solver, and a before/after number on the real sliced part in 3 to 26 s. **Not** usable to place ribs: it solves the sliced beads on a block grid, has no shell elements, and returns no strain energy or bending directions. A 2 mm wall needs cells under 1 mm, which on a 200 mm part already costs 486,000 nodes and 9.3 GB [code, from the solver-scaling plan]. Material cards are placeholders, so numbers are relative |
| `model_check` [code] | Partly | Belt-aware overhang with face indexes: the printability check after ribs. It cannot say "this wall is too floppy for its span" |
| Mass and volume [code] | Yes | Material added is the volume change of the rib step |
| Plugins [code] | Partly | A plugin can read faces and emit steps on an imported part, but cannot call the solver. The first version is built into the app; a plugin hook is listed for later |
| Print transition (wedges, gussets) [code] | Looks related | Decides from one edge and the print direction, for overhang, not stiffness. Flat faces only |
| Reinforce (denser infill in a painted region) [code] | Looks related | Changes no geometry; cannot stiffen a thin skin with nothing under it. It stays the cheap alternative for thick parts |
| Tree supports [code] | Looks related | Grows columns down through layers in free space. Only the idea of merging by "can one trunk carry both" transfers |
| Mesh to solid, mid-surface, topology optimiser | No | None exists |

## 5. The worked example

The team's ribbed cover was opened read-only and measured. Its ribs are a uniform pattern over the whole inside, applied by hand, with no relation to where the part bends. Its measurements, cross-sections and pictures are in a local folder outside the repository and are given to the owner by path. They set the acceptance test in section 9: on a cover of that kind with its ribs removed, the automatic ribs must reach the same stiffness with clearly less added material.

## 6. Options compared

User effort is counted in actions (a click, a pick, a number typed). The manual route, for comparison: one sketch line and one rib step per rib direction, plus trimming and checking, for dozens of ribs: tens of minutes, and no answer to "is it enough".

| | (a) Rules from geometry | (b) Ribs grown from a shell solve | (c) Topology optimisation back to solids | (d) Delegate |
|---|---|---|---|---|
| The user gives | the wall (1 pick), Run, Apply: **3** | the wall (1 pick), Run, Apply: **4 with the panel open**; optional holds, loads, keep-outs | design space, keep regions, loads, holds, budget, then repair of the result: **10+ and a repair session** | export, a FreeCAD study, a mesh result, remodel by hand: **an afternoon** |
| The user repairs | ribs where none are needed; none where the load really is | little: delete or lengthen a rib | most of it | everything |
| They get | a spaced grid sized by span | ribs along the bending directions, densest where the strain is, sized by rule | an organic density result | a mesh |
| Editable solid steps | yes | yes | no path today | no |
| Function respected | keep-out picks, clearance | keep-out picks, clearance, the outside never touched | by "keep" regions only | by hand |
| Least material | no: it cannot know | yes: add, re-solve, stop at the target | yes in theory | yes in theory |
| Checked how | print check only | shell solve before/after, then the existing Stress study on the sliced part, mass added, print check on flat bed and belt | same, after reconstruction | outside |
| Size of the work | small | medium: a shell solver, a planner, a rib-network step | very large | none |
| Main risk | it is the overkill pattern again, automated | the shell model of a real solid part (section 7.2) | research-grade end to end; may not produce ribs at all | fails the owner's order of preference |

**Decision: (b), with (a)'s zero-input start as its default.** It is the only option that is both low effort and answers "where and how much". (a) alone automates the overkill. (c) is research-grade on real parts and needs the most from the user. (d) is the last resort and is not needed.

## 7. The method

### 7.1 What the user sees

1. **Open Auto ribs** (Model menu, next to Stress) on a solid.
2. **Click the wall to reinforce.** The inside face; faces that continue it smoothly are taken with it. This is also the answer to "do not touch the outside": ribs only ever stand on picked faces.
3. **Run.** With no holds or loads given: the wall is held where it meets the rest of the part and pressed evenly. A preview shows the ribs, the predicted gain ("3.1× stiffer"), and the cost ("+9.4 g, +6 %").
4. **Apply.** One History row, "Auto ribs", editable and removable as a unit.

Optional, never required:
- **How much**: one slider between "lightest" and "stiffest", or a target ("twice as stiff", "under 0.5 mm"), or a budget ("at most 10 g").
- **Hold and Load**, the same controls as the Stress panel, when the real load is known.
- **Keep clear**: faces, or a distance from picked features, where no rib may stand. Holes, bosses and openings inside the wall are kept clear by default with a margin.
- **Rib size**: thickness and greatest height. Defaults come from the process: filament (bead widths, no draft), resin, or moulded (60 % of the wall, draft).

After Apply the panel reports: grams and percent added, extra print time from a slice, stiffness before and after on the real sliced part from the existing Stress study, and the print check for the current printer (flat bed or belt).

### 7.2 The analysis: a shell solve of the wall

- **Model.** The picked wall is meshed from the kernel's triangulation and solved as a thin shell: a membrane triangle plus a plate-bending triangle per facet, with ribs as beam elements along mesh edges (the model of Li et al., which they checked against a commercial solver). Wall thickness per vertex comes from inward rays, as `model_check` already does. This lives in `lime-sim` beside the existing solver and reuses its sparse solve.
- **Edges of the picked wall** are held where the wall runs into the rest of the part (side walls, rims), unless the user's own holds say otherwise.
- **Outputs**: deflection, strain energy per element, and the two principal bending directions per element.
- **Why not the existing block-grid solver**: section 4. A shell of 20,000 triangles solves in well under a second, so the planner can afford a few hundred solves.
- **What is rough here, said plainly**: treating a wall of a solid part as a shell held at its edges ignores how much the side walls give. The ranking of where ribs help survives this; the absolute numbers do not. That is why the number shown to the user after Apply comes from the existing Stress study on the whole sliced part, not from the shell.

### 7.3 The planner: grow, score, prune

1. Solve the bare wall.
2. Smooth the bending directions and trace candidate lines along both, spaced by rule, kept off keep-clear areas and away from points where the direction is undefined.
3. Score each candidate by the strain energy it removes per gram. Add the best, re-solve, repeat. Ribs that meet are joined; a rib that ends in mid-wall is extended to the nearest wall or rib, since a loose end does little.
4. Stop at the target, the budget, or when the next rib gains under a set fraction.
5. Size by rule (7.1), with height capped by the clearance to whatever faces the wall.
6. Always computed for the report: the same stiffness reached by simply thickening the wall, and by an even grid of the same weight. A plan that beats neither is shown as such.

Deterministic: the same part and inputs give the same ribs.

### 7.4 The geometry: one rib-network step

- A new composite step, `ribNet`: a list of paths on the solid's faces, with thickness, height and end taper. Each run becomes a loft through sections that stand along the surface normal and sink half a millimetre into the wall; all runs are fused in one combined step. This uses steps the kernel already has [probe].
- Guards: every rib is checked against the outside by rays before it is built, and the built step is refused if the outside surface changed anywhere.
- Usable by hand and over MCP as well, so a person or an agent can add or edit a rib path without the planner.
- Root fillets are off in the first version (the whole-network fillet is the one operation that ran away in the probe); a fillet per rib is listed for later.

### 7.5 Printability

- **Filament, flat bed and 45° belt**: after planning, `model_check` runs in the current pose. Rib ends are tapered so they start from the wall, not in the air. A rib whose top would be an unsupported ceiling in this pose is reported, with the choice to drop it or keep it.
- **Resin**: closed pockets between ribs facing the build plate are reported (cupping). Vent notches are listed for later.
- **Moulded** is a size preset only (thickness ratio, draft); no sink or flow check.

## 8. Steps, each its own PR

| # | What ships | Evidence in the PR |
|---|---|---|
| 1 | The rib-network step (`ribNet`): paths in, one editable History row out; on flat, sloped, cylinder and freeform walls. Fix for the sloped-floor leak of the existing `ribs` step | Outside surface unchanged by rays; mass added; print check on flat bed and belt; timing for 300 runs |
| 2 | The shell solver in `lime-sim`: membrane plus bending triangles, beam ribs, strain energy and bending directions | Textbook plate cases (clamped and simply supported plates under pressure and point load) within a stated error; a ribbed plate against the existing solver |
| 3 | The planner as an engine call and an MCP tool: wall, optional holds and loads, target or budget in; rib paths and the predicted gain out | On synthetic covers: stiffness per gram against wall thickening and against an even grid; the Stress study before and after on the sliced part |
| 4 | The Auto ribs panel: pick, Run, preview, Apply, report | Screenshots in the owner's theme; the four-action count on a real import |
| 5 | The acceptance run of section 9, and what it shows | Numbers kept local for the company part; synthetic twin in the repo |

## 9. How we know it worked

- **The yardstick**: a cover imported from STEP gets useful ribs in four actions and no repair.
- **Least material**: on a cover with its hand-made ribs removed, the automatic ribs reach the stiffness of the hand-made pattern with clearly less added material, under even pressure and under one real load.
- **Function**: the outside surface is unchanged; no rib stands on a keep-clear area or closer to a facing part than the clearance.
- **Editable**: the result is one History row; a rib can be deleted or changed; the STEP exports.
- **Printable**: the print check reports nothing new on a flat bed and on the belt, or names each rib that is a problem.
- **Honest numbers**: every stiffness figure says it is relative (placeholder material cards), and the report shows the thickening and even-grid comparisons.

## 10. Research-grade, and not in the first version

- Several load cases at once (the first version takes one, or even pressure). Load-aligned ribs are not optimal for mixed loads; the plan is an envelope plus the check, not a guarantee.
- Buckling and vibration targets.
- The shell model of a whole solid part, side walls and bosses included (needs a mid-surface, which nothing here builds).
- A continuous blend between ribs and local wall thickening (Gil-Ureta's cell model).
- Root fillets per rib, draft on existing faces, vent notches for resin.
- A plugin hook so rib planners can be written as plugins.
- Topology optimisation of any kind.

## 11. Decisions taken

The owner put the method and scope decisions with the coordinating session. Recorded here with their options.

| Decision | Options | Taken | Why |
|---|---|---|---|
| Method | rules only; shell solve with growth and pruning; topology optimisation; delegate | shell solve with growth and pruning | The only one that is both four actions and "where needed" |
| What the user must give | loads and holds always; or nothing beyond the wall | nothing beyond the wall; loads optional | Asking for loads first would make hand-drawn ribs look reasonable |
| Solver for placement | the existing block-grid solver; a new shell solver; CalculiX as a separate program | a new shell solver in `lime-sim` | The block grid cannot resolve a thin wall on a large part; a bundled GPL program is not needed |
| Geometry | new kernel op; or a composite from existing steps | composite from existing steps first | Proven in the probe; a kernel op only if speed or robustness demands it |
| Root fillets in the first version | on; off | off | The one operation that ran away in the probe |
| Bio patterns as a library | ship them; or growth by strain only | growth by strain only | No evidence they save material |
| Added print time and material | treat as a cost to approve; or expected | expected, and reported | The owner: a part without ribs is lighter and faster; the point is the least that meets the target |

Still the owner's: publishing or tagging a release, anything that would put company part data in the repository, and the patent search before the feature is advertised.
