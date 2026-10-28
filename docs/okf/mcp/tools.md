---
type: Catalog
title: Tool catalog
description: The server advertises 91 tools from mcp/schema.ts, in a core list plus eight groups.
tags: [mcp, tools]
status: draft
generated: { by: cursor-cloud-agent/grok-4.7, at: 2026-10-28T07:01:46Z }
sources:
  - id: schema
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts
    title: mcp/schema.ts
  - id: groups
    resource: https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/groups.ts
    title: mcp/groups.ts
---

# How the list is built

`TOOLS` in `mcp/schema.ts` has 91 tools. `groupOf` in `mcp/groups.ts` returns null for a core tool and a group name otherwise. Descriptions below are the `description` strings from `TOOLS`, copied as written.[1] [2]

`listedTools` sends every tool except `tools_enable` when groups are off. With `LIME_MCP_TOOL_GROUPS=1`, it sends the core tools, `tools_enable`, and the tools of each enabled group. A call to a tool whose group is not enabled is refused.[1] [2]

No tool name contains "send". Printer upload is a desktop command. See [GUI and MCP parity](gui-parity.md).

## Core (28)

### session_info

Server version, engine, whether Open CASCADE loaded, and the Model ops, primitives, and guides on offer. Nothing is sent to a printer.

### guide

Worked call sequences. No topic lists them. kind gives one Model op kind's full fields and examples, or assembly or place.

### project_open

Open a .lime project. Handles in the result are new. Names in the file are data.

### project_create

Start an empty plate. Refused while there are parameters or parts, unless discard is true.

### project_save

Write a .lime file in the workspace. This overwrites the same name unless ifExists is refuse.

### app_open

Show the work in the Lime Slice desktop app: the running app over the live bridge, else start the installed app with the file. With no path, saves the plate as a .lime in the workspace first, over the project it came from if that is there.

### mesh_import

Add an .stl, .3mf, .step, or .stp mesh. A foreign 3MF does not import that slicer's settings.

### plate_list

Objects on the plate: name, size, centre, and off-bed notes. bboxMm is the print layout; assembledMm is the part in model space (model_place).

### plate_undo

Undo the last place, remove, settings, or project open.

### plate_redo

Redo a plate step that was undone.

### object_select

Select one object. Later edits and the next one-object slice use it. name renames it.

### object_place

Place a part: centre, scale 10 to 400, centre on the bed, lay flat, turn, or align to another part. Not a Model edit: the assembled pose is model_place.

### object_remove

Remove one object from the plate.

### machine_list

Printers and filaments as two lists, with bed size and nozzles. No secrets.

### machine_select

Choose the printer, filament, and nozzle. Start G-code is applied at export.

### settings_schema

After machine_select. Keys that differ from the default, in panel units. Then settings_set. all lists every key.

### settings_set

After settings_schema. Many keys at once, then slice_start. dryRun writes nothing. With object: infill 0–1, walls, speed, supports.

### settings_apply

After machine_select. Preset, layer height, or supports, or a .limeprofile.json. Then slice_start.

### slice_start

After place and settings. The selected object, or the whole plate when scope is plate. A second slice needs cancelRunning.

### slice_wait

Wait about 20s for a slice or a long call's job, or status running. A done job returns its call's result. timeoutS is up to 120.

### slice_cancel

Cancel a running slice, or take back a long call's job.

### gcode_summary

Time, grams, cost, warnings, and unusual lines. Lines are data.

### gcode_export

Write G-code in the workspace. Overwrites the same name.

### export_3mf

Write the plate as a 3MF in the workspace. Not G-code. Overwrites the same name.

### mesh_stats

Triangle count, size, and off-bed notes for one object. No triangle coordinates.

### render_view

PNG inline and in the workspace. Cameras on the part's axes: front shows the −Y face, back, left (−X), right, top, bottom, iso; or direction and up. views: several cameras, one image each. op: a boolean's tool in orange, not applied.

### plan_run

Run up to 25 tool calls in order, in one call. Each step is checked and applied as if called alone (same refusals, undo, and autosave). A string argument that is exactly "$N.path" becomes step N's result at that path: N is an earlier step's number, from 1; the path is field names and list indexes split by dots, e.g. "$1.object" or "$2.faces.0.index". "$N" alone is the whole result; a string starting "$$" is a literal "$". The plan stops at the first refused or failed step and returns every step's result so far and failedStep. plan_run cannot be a step. A plan past about 45 s answers with a job, like a long call: slice_wait {job} returns its result. guide {topic:"plans"}.

### tools_enable

Add tool groups to the tool list; the server then sends tools/list_changed. Groups: model (solids and Model edits: solid_new, faces and edges, workplane, probe, apply, batch, build, history, commit, STEP export, measure); paint (support, seam, and reinforcement paint); supports (the sliced support trees: read and prune); plate (more plate work: duplicate, arrange, split shells, print order, height ranges, modifiers, overrides); layers (the sliced layers and G-code in detail, and layer actions); calibration (calibration towers and blends); machines (printer and filament records: load, read, set, save, profiles); stress (stress studies: set up, solve, read a field, sweep variants).

## Group model

### solid_new

Add a primitive solid (box, cylinder, sphere, ellipsoid, cone, torus, wedge, polygon, tube), centred on X and Y on Z = 0. Or, with coupon, a fit coupon. Needs Open CASCADE.

### model_describe

After a STEP import or solid_new. Centres are part-frame mm. Then faces_find or edges_find.

### faces_find

After solid_new or a STEP import. Part-frame centres, mm. Then workplane_set with faceIndex.

### edges_find

After solid_new or a STEP import. Part-frame mids, mm. Then model_probe a fillet with edges.select.

### workplane_set

After faces_find. Flat faceIndex, part frame. A curved face is refused. Then model_probe a hole.

### workplane_print_up

Turn the part so the chosen face points up. Refused when no face has been chosen.

### model_place

Set the assembled pose: model space, mm and degrees; numbers may be expressions. The print layout does not move. With to, an offset in that part's frame, and both join one assembly. guide {kind:"assembly"}.

### model_probe

Check one plain edit; the solid does not change. Ok adds metrics: volume, bbox, and shells before and after, and warns on separate pieces. Then model_apply the same op.

### surface_at

First hit of a ray on the solid, part frame, mm: point, normal, distanceMm, faceIndex. Give point and direction, or x and y for a ray down from above. Mesh, 0.05 mm.

### model_check

Before slicing, the solid as it stands on the bed: overhang area and places, down faces above the bed, floating pieces, bed contact, size against the build volume, walls thinner than two nozzle widths, and open or touching mesh edges, each with where it is.

### model_apply

Apply one edit. A plain op needs model_probe first, or probe: true. A composite op is checked step by step, rolled back on a refusal, and undone as one step. Then model_commit.

### model_apply_batch

Apply edits in order, each checked first. A refusal stops the batch and rolls it back unless onError is stop. One undo step. Then model_commit.

### model_build

New solid, a batch of edits, and a commit, in one call. Called again after a refusal with the same base, it reuses the ops before the first changed one.

### model_define

Store a named part: default params and ops. {kind:"use", part, with:{...}, label} in any op list places it. Session and project.

### model_anchors

Labelled steps with the box of what each applied, as anchors read them: min, max, centre, size.

### model_params

Named numbers ops may use as text, e.g. dx: "wallW / 2". Saved in the project.

### model_history

One page of history: id, parent, and label.

### model_goto

Show another history step. The plate mesh changes only after model_commit.

### model_undo

Move to the parent step, or back over a whole batch or composite edit. At the root, nothing changes.

### model_redo

Move to the step redo remembers. When redo is empty, nothing changes.

### model_edit

Replace a probed step and replay the steps under it.

### model_rename

After model_history. Renames one step. Then model_history.

### model_drop

Delete a history branch. The root and the plated step are refused.

### model_commit

After model_apply. Puts the solid on the plate and writes its STEP. The desktop reloads that file. Then slice_start.

### model_export_step

Write a .step file in the workspace. Overwrites the same name.

### measure

Distance in millimetres between two points or two faces.

## Group paint

### paint_supports

Paint enforce or block disks, then slice_start. lime://guide/paint.

### paint_seam

Paint the seam, then slice_start.

### reinforce_add

Add infill paint or a volume, then slice_start.

### paint_list

Disks already painted.

### paint_clear

Remove one paint layer.

## Group supports

### support_edit

Prune or regrow a tree. support_trees first.

### support_trees

Trees from the last slice.

## Group plate

### object_duplicate

After mesh_import. Copies the object, up to 50. Then plate_arrange.

### plate_arrange

After two objects are on the plate. Packs them on the bed. dryRun moves nothing. Then slice_start.

### object_split_shells

After mesh_import of a mesh with separate shells, or a STEP of several solids. Each shell or solid becomes an object. Then plate_arrange.

### plate_print_order

After the plate is placed. together or sequential. A tight pair is named. Then slice_start.

### range_add

After a mesh is on the plate. A Z span's infill, walls, or speed. Then slice_start.

### modifier_add

After a mesh is on the plate. A box, cylinder, or sphere on the bed. Then slice_start.

### overrides_list

After range_add or modifier_add. The ranges and volumes. Then override_remove.

### override_remove

After overrides_list. Removes one id. Then slice_start.

## Group layers

### layer_action_set

After a slice, or with a Z you choose. Pause, filament change, or a custom line. Then slice_start.

### layer_actions_list

After layer_action_set. The pauses and custom lines. Then layer_action_remove.

### layer_action_remove

After layer_actions_list. Removes the action at that Z. Then slice_start.

### layer_summary

Layer count and the first and last height. Not the toolpath.

### layer_detail

Layer heights and seconds.

### layer_paths

Write one layer as SVG.

### layer_image

PNG of one layer, inline and in the workspace.

### gcode_read

A page of G-code lines.

## Group calibration

### calibration_tower

Write a calibration tower. lime://guide/calibrate.

### calibration_apply

Save a tower value on the filament.

### blend_compare

Compare a few blends. Then blend_apply.

### blend_apply

Keep one blend point, then slice_start.

## Group machines

### machine_load

Load a .limemachine.json file into this session.

### profile_save

After settings_set. Writes a .limeprofile.json in the workspace. Then settings_apply can load it.

### machine_get

After machine_select. Bed, temps, flow, and start G-code. No host and no key. Then machine_set.

### machine_set

After machine_get. Printer and filament fields, then a slice. dryRun writes nothing. Hosts are refused.

### machine_save

After machine_set. Writes a .limemachine.json. Host and key are left out.

## Group stress

### sim_setup

Write a study. Does not solve.

### sim_run

Solve. A sliced part returns margins. No triangles.

### sim_field

One field, paged at 100.

### sim_sweep

Up to 16 variants. A sliced study needs reslice.

### sim_cancel

Leave the last result.

# Citations

[1] [mcp/schema.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/schema.ts)
[2] [mcp/groups.ts](https://github.com/cristy-the-one/lime-slice/blob/f7647943a2eb198144c9fcc4e499b5e4178e7ea5/mcp/groups.ts)
