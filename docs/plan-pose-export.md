# Plan: export a pose for other programs

Status: E1, E2 and E3 implemented (STEP AP242 assembly tree + flat, Pose sheet JSON, glTF 2.0 binary with optional animation, 3MF assembly, STL one/each, OBJ + MTL, Pose Export dialog, and MCP `pose_export` + `model_export_step {assembly: true, flat?: true}`). The owner's three decisions are in section 9.

The owner's request on 2026-11-21: "an option to export the exact configuration from the Pose as a STEP and other formats that are used by external programs".

## 1. What there is today

- An assembly's row in the object list has a **STEP** button (`data-assembly-step`, `exportAssembly` in `src/app/model/assembly.ts`). It writes one STEP file: every member as a solid named after its part, at its `modelPose`. Over MCP it is `model_export_step {assembly: true}` (`docs/plan-assemblies.md` M9).
- Turning a joint in Pose writes the moved members' `modelPose` (`docs/plan-pose.md` section 1, item 5). So that STEP is already the joint configuration Pose shows, once the turn is kept.
- An animation frame is not kept: after an animation plays or is scrubbed, the assembly is back where it was unless the person presses **Keep this frame** (`src/app/pose.ts`). Without that, the STEP button cannot export frame 37, and with it the frame replaces the kept pose.
- The STEP is flat: one file of named solids, all in one product. A CAD program opens it as loose bodies, not as an assembly of parts with placements, and two copies of one part are two solids.
- STEP is the only format. `export_3mf` writes the **print layout**, not the assembly as posed. Split to print writes STEP, 3MF or STL of its own pieces.
- The bundled Open CASCADE has the STEP writer (`TKDESTEP`) and the XCAF document (`TKXCAF`), and no IGES, glTF or OBJ writer (`TKDEIGES`, `TKRWMesh`, `TKDEGLTF`, `TKDEOBJ` are not in `occt/lib`).

## 2. Goal

From the Pose view, export exactly what it shows, one assembly at a time, in the formats other programs read:

1. **The configuration as shown.** The joint values Pose shows now, or, while an animation is stopped on a frame, that frame's poses. The file says which.
2. **STEP as an assembly**, so FreeCAD, Fusion, SolidWorks, Onshape, Inventor and Creo open it as parts placed in an assembly, not as loose bodies.
3. **Mesh formats** for viewers, renderers, game engines and slicers: glTF binary, 3MF, STL and OBJ.
4. **A pose sheet** (JSON): each member's joint value and placement, for a script or a robot program.

### Non-goals

- No import of these formats back into a rig. A STEP or 3MF opened in Lime Slice is a new object, as now.
- No IGES, Parasolid, ACIS, FBX or USD. IGES would need `TKDEIGES` in the bundle, and STEP AP242 is read everywhere IGES is. The others are proprietary SDKs or out of scope.
- No URDF in v1 (section 9).
- No change to the slice, the print layout or any cache key. Exporting a frame does not keep that frame.

## 3. Which configuration

- **D1. As shown.** The export reads the poses the Pose view draws at that moment: each member's `modelPose`, or, when an animation is stopped on a frame (`docs/plan-pose-animation.md` D4, the player's sampled frame), that frame's poses. The dialog names it: "Now" or "Frame 37 of Wave (2.92 s)". Over MCP, `frame: {animation, t}` samples the frame the same way the player does.
- **D2. Model space, millimetres.** Every format gets model-space placements in mm. glTF is metres, Y up: it gets a 0.001 scale and a −90° turn about X on its root node, so it opens upright at the right size.
- **D3. The part's own frame.** Each part's geometry is written once in its own frame, and each member is that part plus a placement. Two members of the same part share it in STEP, glTF and 3MF.

## 4. The formats

| Format | Read by | What is kept | How it is written |
|---|---|---|---|
| **STEP AP242, assembly** (default) | FreeCAD, Fusion, SolidWorks, Onshape, Inventor, Creo, KiCad | Exact B-rep. An assembly product named after the assembly; one product per distinct part; one instance per member, with its placement and its name. Part colours. The joint tree as nested sub-assemblies (a member under its parent). | XCAF, with the bundled `TKDESTEP`: `XCAFDoc_ShapeTool` adds each part once and each member as a located instance. |
| **STEP, flat** (as in 7.0) | the same | Exact B-rep, one named solid per member, no products. | Today's `exportSolid(…, "step", …)` path, kept as an option. |
| **glTF 2.0 binary (.glb)** | Blender, three.js, Unity, Unreal, Windows 3D Viewer, web viewers | One node per member, nested as the joint tree, each with its local transform; one mesh per part; a material per part colour; names. A kept animation as a glTF animation: its sampled frames (D1) as node rotations and translations, one channel per moving member (decision 1). | Written in TypeScript from the meshes the app already holds (no `TKRWMesh`). |
| **3MF, assembly** | PrusaSlicer, Bambu Studio, Cura, 3D Builder | One object per part with its mesh; one build item per member with its transform; names; colours (materials extension). At the pose, not the print layout. | The existing 3MF writer, given the pose transforms where `export_3mf` gives the print layout. |
| **STL** | almost everything | Triangles only, no names or colours. One file with every member at its pose, or a ZIP of one STL per member. | From the same meshes, transformed. |
| **OBJ + MTL** | Blender, MeshLab, older tools | One group per member, a material per colour. Vertices at the pose. | From the same meshes. |
| **Pose sheet (JSON)** | scripts, robot programs | Per member: name, parent, joint kind, value (angle or travel), limits, and the 4×4 placement in mm. The assembly, the configuration (D1) and the units. | From the rig and the poses. |

**D4. Mesh detail.** The mesh formats tessellate each part at a chord tolerance, default 0.05 mm, from 0.01 to 1 mm in the dialog. That is the same tolerance and the same mesh the Pose view draws. A part that came from an STL keeps its own triangles.

## 5. In the app

- **D5. An Export button in Pose,** beside Save animation. It opens a dialog:
  - the assembly, by default the one in Pose;
  - the configuration (D1): Now, or the frame the player is stopped on;
  - the format (section 4), and its options: STEP tree or flat; STL one file or one per member; mesh detail;
  - the file name, `<assembly>-pose.<ext>`, or `<assembly>-frame-37.<ext>` for a frame.
- It saves the way every export does (`src/app/save-bytes.ts`). The object list's STEP button writes the same assembly tree, of the kept pose (decision 2); the flat file is an option in the Pose dialog only.

## 6. MCP

**D6.** A new tool, `pose_export {assembly, format, frame?, path?, chordMm?, step?, stl?}`:
- `format`: `step`, `glb`, `3mf`, `stl`, `obj`, `pose`;
- `frame: {animation, t}`: a frame of a kept animation (D1);
- `step: "tree" | "flat"`, `stl: "one" | "each"`;
- `path`: in the workspace; by default `<assembly>-pose.<ext>`.

It answers with the path, the format, the bytes, the members and the parts, in one sentence and a short object, never one line per triangle or per frame. `model_export_step {assembly: true}` writes the tree too (decision 2), with `flat: true` for the 7.0 file. The size tables and options are in `guide`, not the first-contact schema.

## 7. Tests

- **STEP tree**: read the file back with XCAF in the kernel test. One instance per member; each placement equals the member's pose within 1e-6 mm; names; two members of one part share one product. The flat option round-trips as today.
- **GLB**: parse the file in a unit test. Node count and nesting follow the joint tree; each node's world matrix, after D2's root transform, equals the pose; the mesh bounds at the pose equal the assembly's posed bounds within the chord tolerance.
- **3MF**: unzip and parse. One build item per member with the pose's transform; posed bounds as above. The print layout is not used.
- **STL** and **OBJ**: triangle counts and posed bounds; OBJ has one group per member.
- **Pose sheet**: each member's value and placement equal the rig's.
- **A frame**: exported at `t`, the poses equal the player's sampled frame at `t`, and differ from the rest pose; the assembly is unchanged afterwards.
- **e2e** (`test:smoke`): the Export dialog in Pose saves each format through the download path; the file name names the frame.
- **MCP**: `pose_export` for each format against the real Open CASCADE job, with the counts and bounds above.

## 8. Milestones

Each one is a PR to `main`.

1. **E1. STEP as an assembly, the Pose Export dialog, `pose_export` with `step` and `pose`.** The configuration (D1), including a frame. The object list's STEP button and `model_export_step {assembly: true}` switch to the tree (decision 2).
2. **E2. glTF binary.** Nodes, meshes, colours, the joint tree, and a kept animation as a glTF animation (decision 1).
3. **E3. 3MF, STL and OBJ** at the pose.

## 9. Decided 2026-11-21

1. **glTF animation in E2.** E2 also writes a kept animation as a glTF animation: the frames the player samples (`docs/plan-pose-animation.md` D4), as node rotations and translations, one channel per member that moves, linear between samples. A test plays it back in the GLB parse and checks frame `k`'s node matrices against the player's frame `k`.
2. **STEP is the tree everywhere.** The Pose dialog, the object list's STEP button and `model_export_step {assembly: true}` all write the assembly tree. The 7.0 flat file stays as an option: "Flat (one solid per part)" in the Pose dialog and `flat: true` over MCP.
3. **URDF later, in its own plan.** It needs masses and inertias per link, and the material cards are provisional; it waits for a robot to drive.
