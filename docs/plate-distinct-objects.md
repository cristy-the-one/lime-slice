# Distinct objects on one plate

Add object loads a mesh from a file. Duplicate copies the selected object. File > Open still replaces the plate. No engine change: `ObjectSpec` already has its own mesh, and the client already sends each object's bytes (`objectBase64`, `withMeshData`, `meshRefs`).

## What changes

**Add object** opens a file picker. The formats are the mesh formats Open already takes: STL, 3MF (mesh only), and STEP at the current STEP chord. A `.lime` project is not an object; Open still owns that. Cancelling the picker does nothing.

The bytes go through the same read as Open. STL is `parseStl`, which settles the mesh onto Z = 0. 3MF and STEP go through `previewRemote` with the chord captured when the file was chosen. The new `PlateObject` starts as a freshly opened part: identity orientation, scale 1, empty paint, empty per-object overrides, its own `fileName` and its own bytes. It is then shifted, with `centered` off, so its bounds sit in the first clear shelf slot (`ARRANGE_GAP_MM`, same gap as Arrange). Existing objects are not moved. If the bed has no slot that both clears them and stays on the bed, the part is still added, past the edge, and the off-bed line is the warning it already is. The new row is selected. That is one undo step, taken after the mesh has been read, so a failed read or a cancel does not push history.

**Duplicate** (the button and Ctrl+D) stays an exact copy of the selected object: same mesh, rotation, scale, paint, and overrides, same place on the bed, so the overlap warning still means what it means today. It copies that object only. A missing selection copies nothing; it does not fall back to the first row.

**File > Open** and the samples menu still call `adoptBytes` and replace the plate.

## What does not change

- One object with no overrides still sends today's body: `filename`, `dataB64`, `pose`, no `objects`.
- Arrange, Frame, the marks line, scrub, belt mode, sequential printing, and per-object overrides keep their current controls.
- A `.lime` save already stores each object's mesh bytes and file name. Load already parses each one. Distinct meshes ride that path; they do not need a new project version.
- 3MF export of one object stays the placed mesh it writes today. With two or more, the file is one mesh of every part's placed triangles. This importer indexes vertices across the whole model, so separate build items with indices restarting at 0 would re-open as a corrupt mesh. One mesh keeps every part and still re-opens.
- Mesh refs stay keyed by fingerprint. Different bytes get different refs. The unknown-ref retry still forgets every id and sends `dataB64` again.
- The toolbar does not grow. The Add tip says the button reads a file. The prepare canvas stays the default size.

## Drop, separate change

A plain drop keeps today's meaning: the first file replaces the plate, including on an empty scene. When a plate already has a mesh, **Shift+drop** adds each mesh file through the Add path, in order. Shift is the modifier because a drop that sometimes adds and sometimes replaces is ambiguous, and the replace is the behaviour people already have. An empty scene ignores Shift and still opens the file. A dropped `.lime` is not added as an object.

## Risks

- Tests that clicked Add to get a second copy of the same mesh must click Duplicate. The copy, the overlap, and Arrange are unchanged; only which control does the copy moves.
- A STEP preview is async. The undo step is taken when the mesh arrives. If Open replaced the plate while that preview was in flight, the late result is dropped.
- Parking in the first free corner leaves a centered part where the user put it. It does not look like Arrange, which packs everything from the left.
- A new part records the STEP chord it was tessellated with. Selecting it later restores that chord, as selecting any object already restores its own.
- Exporting several parts as one 3MF mesh loses the object list on re-import. That is the same mesh-only 3MF open as today, with all of the triangles present.

## Review questions

1. Is the first clear shelf slot, leaving existing parts put, the right place for a newly opened mesh?
2. Is Shift+drop the right modifier, with a plain drop still replacing?
3. Is one 3MF mesh of every placed part acceptable, given the importer's global vertex indices?
4. Should Add reset the STEP chord to 0.1 the way Open does, instead of using the chord already on screen?
