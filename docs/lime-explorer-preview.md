# Explorer preview for `.lime` files

A `.lime` file stays version 3 JSON. It gains two optional top-level fields, `thumbnail` and `summary`, written before every other key. Windows Explorer reads those fields from a small shell DLL. It does not open the slicer, Open CASCADE, or the mesh bytes.

This is the text-file version of what 3MF, OpenDocument, and Office already do with a package part, and what PrusaSlicer does for G-code: put a PNG where a dumb reader can lift it out, and keep a hash so a picture of a different plate is never shown. A ZIP container would match 3MF more literally and would make every newly saved file unreadable by the app that ships today.

## Decision

| Question | Choice |
| --- | --- |
| Where the picture lives | Optional top-level `thumbnail` in the same JSON document. No version bump. |
| Format | One PNG, full alpha, non-interlaced, 8-bit. Longest side at most 512. Encoded bytes at most 128 KiB. |
| Extra sizes or JPEG | No. Explorer, Quick Look, and the freedesktop cache scale one image. |
| Key order | `thumbnail`, then `summary`, then the keys a version 3 file already has. The file is still one JSON value. |
| Stale pictures | `thumbnail.meshHash` is a FNV-1a 64 of the plate geometry. Writers drop the picture when the hash does not match. The shell hides it when a finished scan disagrees. |
| No picture in the file | A placeholder card. The shell does not rasterize a mesh and does not load Open CASCADE. |
| Summary | Optional `summary` beside the picture: name, printer, object count, layer height, and sliced time and grams when a slice exists. |
| Windows | A separate crate, `crates/lime-shell`, 64-bit, out of process. `IThumbnailProvider`, `IPreviewHandler`, and a read-only `IPropertyStore`. Not linked into any slicer crate. |
| Install | Per-user registry when the NSIS install is per-user, so it does not need an administrator. The existing app install is otherwise unchanged. |
| macOS and Linux | Same fields, later. Not built here. |

`PROJECT_VERSION` stays 3. An app from before version 3 still refuses the file, because the version number is still 3. A current reader that does not know the new keys still opens the file.

## What comparable tools actually do

### 3MF, and the slicers that write it

3MF is an OPC zip. The core spec's package thumbnail is an optional JPEG or PNG part, related from the package root with the OPC relationship type `http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail`. The usual part name is `/Metadata/thumbnail.png`. The spec's reason is the one we care about: external agents, including a file explorer, should see the part without understanding the 3D model. See [3MF Core Specification 1.3.0, §2.1.3 and §6.1](https://3mf.io/wp-content/uploads/sites/55/2025/02/3MF_Core_Specification_v1.3.0.pdf) and the [relationship table](https://github.com/3MFConsortium/spec_core/blob/master/3MF%20Core%20Specification.md).

Writers:

- **PrusaSlicer** adds `Metadata/thumbnail.png` when it exports a 3MF (`THUMBNAIL_FILE` in [`3mf.cpp`](https://github.com/prusa3d/PrusaSlicer/blob/master/src/libslic3r/Format/3mf.cpp)).
- **Cura** writes the same path, registers the OPC thumbnail relationship, and fills it with a 300×300 PNG snapshot of the build plate ([`ThreeMFWriter.py`](https://github.com/Ultimaker/Cura/blob/a5e1bee3/plugins/3MFWriter/ThreeMFWriter.py)). The snapshot is skipped when the renderer is not up.
- **Bambu Studio** stores several plate renders in the same zip: `Metadata/plate_N.png` at 128×128, plus top and pick views ([`bbs_3mf.hpp`](https://github.com/bambulab/BambuStudio/blob/fda63da8/src/libslic3r/Format/bbs_3mf.hpp)). That is a slicer-project convention on top of the one package thumbnail the spec names.

Windows does not parse 3MF geometry to draw the icon. `Windows\System32\ms3dthumbnailprovider.dll` is a thumbnail and preview handler registered on `.3mf`. It shows the embedded picture. When a slicer install replaces the `.3mf` association and drops those `ShellEx` keys, Explorer falls back to the application icon. People restore the picture by putting the handler's CLSID back under `{e357fccd-a995-4576-b01f-234630154e96}` (thumbnail) and `{8895b1c6-b41f-4c1c-a562-0d564250836f}` (preview). That is the same pair of keys this design registers for `.lime`.

### G-code thumbnails

G-code is a text stream, closer to `.lime` than a zip is. PrusaSlicer writes one or more images as comment blocks near the top:

```
; thumbnail begin 440x240 12345
; <base64, 78 columns>
; thumbnail end
```

The format tag is `thumbnail` for PNG, or the JPEG or QOI tag. Sizes and formats are a printer setting such as `440x240/QOI, 640x480/PNG`. Several sizes exist because the printer firmware wants the LCD's exact pixels and the desktop wants another; the firmware will not scale. QOI replaced PNG on the printer because PNG is heavy for the board, not because Explorer wants it ([Prusa's model-preview note](https://help.prusa3d.com/article/model-preview_648687), [`Thumbnails.cpp`](https://github.com/prusa3d/PrusaSlicer/blob/b028299c/src/libslic3r/GCode/Thumbnails.cpp)). Bambu Studio added the same kind of block for non-Bambu printers, at a size the user can set ([BambuStudio#2333](https://github.com/bambulab/BambuStudio/pull/2333)). Moonraker finds the block by scanning the file, which only works because the block is bounded and marked.

The lesson for `.lime`: a text file can carry a preview if a scanner can find it without building a DOM of the mesh. The lesson we do not take: several encodings, and a printer-LCD size list. Explorer asks for a pixel size and scales.

### CAD files that are already containers

These formats can afford a named preview stream because every reader already opens a container.

| Format | Preview | Notes |
| --- | --- | --- |
| SolidWorks `.sldprt` (legacy) | OLE compound file, stream `PreviewPNG` or a DIB in `Preview` | Extractors such as `gsf` read that stream and nothing else. Modern files are often encrypted and then have no readable preview. |
| Inventor `.ipt` / `.iam` | OLE property set, a 512×512 PNG (older files, a DIB) | [Inventor streams](https://github.com/TWiesendanger/ExtrabbitCode.Inventor.MetaReader/blob/master/docs/INVENTOR-FILE-FORMAT.md). Geometry stays opaque. Mass properties in the same property set can be stale; the thumbnail has the same problem, and Inventor does not hash it. |
| Creo `.prt` | Section `THMB_IMG_MAIN`, usually a JPEG | Present when `saving_model_thumbnails` was on. PTC documents that Windows Explorer shows that image, and that older files and files saved with the option off have none ([About Viewing Thumbnails](https://support.ptc.com/help/creo/creo_pma/r13/usascii/fundamentals/fundamentals/about_viewing_thumbnails.html)). |
| Fusion 360 `.f3d` | Zip (method 93, zstd) with `Previews/*.png` | The BREP is not reconstructed to draw the icon. |
| AutoCAD DWG | Header pointer to a DIB (R2010 and earlier) or a PNG (R2013+) | The preview is addressed from the header so a reader need not walk the drawing. |
| SketchUp `.skp` | PNG bytes immediately after the version header | Same idea: fixed offset, then stop. |

[cad-preview](https://github.com/cinderblock/cad-preview) is a survey of these streams. The shared pattern is an embedded raster at a known place. None of them ask the shell to tessellate a boundary representation.

### Office and OpenDocument

Both are zips.

- **OpenDocument** requires `Thumbnails/thumbnail.png`, PNG only, no frame and no border, because a file manager may add its own chrome. The 1.3 note says desktops show the image in a square of up to 256 px and that a producer should look acceptable when scaled into that square. Encrypted documents get no content thumbnail. [ODF 1.3 Part 2, §3.8](https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part2-packages/OpenDocument-v1.3-os-part2-packages.html). The older 1.1 text asked for 128×128, 24-bit, non-interlaced, with a full alpha channel, to line up with the freedesktop thumbnail spec.
- **Office Open XML** allows one package thumbnail, any of GIF, PNG, TIFF, or JPEG, found by a thumbnail relationship (`http://purl.oclc.org/ooxml/officeDocument/relationships/metadata/thumbnail`). Word has historically written `docProps/thumbnail.wmf` or a JPEG. There is no size cap in the spec. [ECMA-376 thumbnail part](https://ooxml.info/docs/15/15.2/15.2.16/).

PNG with alpha is the strictest of these, and it is the one file managers composite onto a selection or a dark background. WMF and JPEG are legacy.

### Blender

A `.blend` file stores the thumbnail in a `TEST` block near the start: width, height, then raw bottom-up RGBA. `REND` blocks before it are skipped. Pre-2.5 files have none. Gzip and zstd wrappers are peeled first. The Windows installer registers `BlendThumb.dll`; `blender -R` registers it per user. Linux uses a thumbnailer executable that writes a PNG. Blender itself ignores the block. The extractor is intentionally not the full loader.

Two constraints we copy: the bytes are early, and the shell DLL does not link the editor. We do not copy the code. Blender's thumbnail extractor is GPL, and this repo does not take GPL. We also do not copy raw RGBA. A PNG is smaller and is what the other specs already agreed on.

### glTF, GLB, and USDZ

glTF and GLB have no thumbnail field and no reserved chunk for one. Finder shows a generic icon until a Quick Look extension loads a renderer ([QuickLookGLTF](https://github.com/arthurrmp/QuickLookGLTF) and similar). That is the "render on demand" design. It works when the platform already has a parser, and it fails open when it does not: the icon is blank.

USDZ is a zip of USD, and macOS previews it by loading the scene in Model I/O, not by reading an embedded PNG. Apple ships that parser. We do not have an equivalent inside `dllhost.exe`, and a `.lime` solid may be Open CASCADE binary that only our engine reads.

### Windows shell

[Thumbnail handlers](https://learn.microsoft.com/en-us/windows/win32/shell/thumbnail-providers) and [`IThumbnailProvider::GetThumbnail`](https://learn.microsoft.com/en-us/windows/win32/api/thumbcache/nf-thumbcache-ithumbnailprovider-getthumbnail):

- The shell passes `cx`, the maximum width and height in physical pixels. The bitmap should fit in that square. The shell scales down and keeps the aspect ratio. It does not scale up (the cache sizes include 32, 96, 256, and 1024, and the list changes). Returning one 512-px image covers the sizes Explorer actually asks for at normal and high DPI; a 256-px image stays 256 on a 1024 request and looks soft.
- The bitmap is a 32-bit DIB. `WTSAT_ARGB` means the alpha channel is valid. `WTSAT_UNKNOWN` makes the shell guess, and transparent pixels often become a black box. The Windows SDK sample converts to premultiplied `32bppPBGRA` and reports `WTSAT_ARGB`. We do that. We do not matte onto white: a white card is wrong on a dark Explorer theme, which is the same reason ODF forbids a baked frame.
- Initialize with `IInitializeWithStream`, not with a path. The handler then runs out of process in `dllhost.exe`. Setting `DisableProcessIsolation = 1` opts out of that and is for legacy handlers only. A crash must not take down Explorer.
- The thumbnail cache is consulted first. The extractor runs when the cache has no image, or when the file's last-modified time is newer than the cached copy. `System.ThumbnailCacheId` changes when the item's name, volume, or data-modified value changes. Cache files live under `%LocalAppData%\Microsoft\Windows\Explorer\thumbcache_*.db`. We do not implement `System.Thumbnail` ourselves; the shell fills it from the provider. Returning it from a property handler would fight the cache.
- The shell's own recipe-thumbnail sample is a custom text file with a base64 image pulled out of the file. That is Microsoft's example of this feature, and it is an embedded image, not a render of the document.

[Preview handlers](https://learn.microsoft.com/en-us/windows/win32/shell/preview-handlers) always run out of process, in `prevhost.exe`. The class implements `IInitializeWithStream`, `IObjectWithSite`, `IOleWindow`, and `IPreviewHandler`, plus `IPreviewHandlerVisuals` so the host's background and font are honoured. `Initialize` only stores the stream. `DoPreview` does the work. Heavy work in `Initialize` is how handlers time out.

Registration, from [How to Register a Preview Handler](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-register-a-preview-handler):

- `.lime` → ProgID `com.limeslice.slicer.lime` (the ProgID Tauri already writes: bundle identifier plus extension).
- Thumbnail CLSID under `ShellEx\{e357fccd-a995-4576-b01f-234630154e96}`.
- Preview CLSID under `ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}`.
- The CLSID listed at `Software\Microsoft\Windows\CurrentVersion\PreviewHandlers`. Microsoft says HKLM for an all-users install and HKCU for a per-user install, on Windows 7 and later.
- The CLSID's `AppID` is `{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}`, the 64-bit `Prevhost.exe` surrogate that Windows already registers. We do not add our own `AppID` or `DllSurrogate`. A new AppID under HKCU is not a reliable launch path for the COM service, and writing it under HKLM needs an administrator. A 32-bit handler would use `{534A1E02-D58F-44f0-B58B-36CBED287C7C}` instead; we ship only the 64-bit DLL.
- `InprocServer32` threading model is `Apartment`.
- The same thumbnail CLSID is also written under `SystemFileAssociations\.lime`, so a later "Open with" change does not drop icons.

The handler CLSID is `{A344EC17-8764-5F01-9C73-FFE2DA751916}` (UUID v5 of `lime-slice.shell.handler`). One class implements thumbnail, preview, and properties. The shell queries the interface it wants.

Property handlers for the Details pane are registered at `SOFTWARE\Microsoft\Windows\CurrentVersion\PropertySystem\PropertyHandlers\.lime`. That key is documented under HKLM, and the indexer is a system service, so a per-user install may not light up custom columns. The installer still writes the key into the install hive (`SHCTX`). The Preview Pane does not depend on it. Values are standard properties, so no `.propdesc` schema is required:

| Property | Source |
| --- | --- |
| `System.Title` | `summary.name` |
| `System.Subject` | `summary.printer` |
| `System.Comment` | one line: object count, layer height, time, grams |
| `System.ApplicationName` | `Lime Slice` |
| `System.Keywords` | printer name, when set |

`Commit` is read-only. A `.propdesc` for real columns (layer height, grams) needs `PSRegisterPropertySchema` and an administrator. That is a follow-up, not this change.

Per-user testing without an administrator: install the NSIS package for the current user, or import the HKCU keys by hand, then sign out of Explorer (`Stop-Process -Name explorer` is Marius's call, not the installer) or open a new folder window. `regsvr32` is not used. It is a GUI process and a per-machine habit; the installer writes the keys itself.

### macOS Quick Look and freedesktop

Later, same `thumbnail` bytes.

- **macOS:** a Thumbnail extension (`QLThumbnailProvider`) and a Preview extension (`QLPreviewProvider` / `QLPreviewingController`). The app's `Info.plist` lists the UTI in `QLSupportedContentTypes`. The system caches the result and can sync it through iCloud. [Providing thumbnails of your custom file types](https://developer.apple.com/documentation/QuickLookThumbnailing/providing-thumbnails-of-your-custom-file-types). Not built now. The Tauri Mac build has no extension target in this change.
- **Linux:** the [Thumbnail Managing Standard](https://specifications.freedesktop.org/thumbnail/latest/) caches PNGs under `~/.cache/thumbnails/{normal,large,x-large,xx-large}/` (128, 256, 512, 1024) with `Thumb::URI` and `Thumb::MTime`. A `.thumbnailer` file in `/usr/share/thumbnailers` or `~/.local/share/thumbnailers` points a command at the MIME type; Tumbler and GNOME thumbnailers run it. The command would be a tiny binary over `lime-preview` that writes the embedded PNG, not a slicer. Not built now.

## Options

| | (a) JSON fields | (b) ZIP container | (c) Sidecar PNG | (d) Binary header or trailer | (e) Render in the shell |
| --- | --- | --- | --- | --- | --- |
| What it is | `thumbnail` and `summary` first in the JSON | `project.json` plus `Metadata/thumbnail.png`, OPC relationship | `part.lime.png` next to the file | Magic and length, then PNG, then JSON; or a trailer | Software-rasterize the first mesh inside the handler |
| Who already does this | Prusa G-code; the Windows SDK recipe sample | 3MF, ODF, OOXML, Fusion, Bambu plate PNGs | Nobody, for a project file that is supposed to stand alone | Blender (`TEST`), SketchUp, DWG | glTF Quick Look plugins; `stl-thumb` |
| Explorer cost | Read the prefix. Stop after two small values. | Unzip one part by name. Cheapest possible lookup. | Trivial, and wrong | Read a fixed offset. Also cheap | Parse the mesh. Slow, and impossible for a BREP |
| Old v3 files | Open unchanged. The keys are absent. | Open unchanged if the reader accepts both magic numbers. | Open unchanged. | Open unchanged only if the new wrapper is opt-in. | Open unchanged. |
| Files this app saves, opened in today's 2.7.0 | Open. `parseProject` ignores unknown keys. The next save from 2.7.0 drops the new keys. | Do not open. The file starts with `PK`. `JSON.parse` fails and the app says it is not a project. | Open. The picture is lost as soon as the file is mailed or renamed. | Do not open. A preamble or a trailer is not valid JSON. `JSON.parse` rejects trailing data. | Open. Explorer still has nothing embedded to show. |
| Version bump | Not required. | The inner JSON could stay version 3, and the break would still be total, because the envelope is what `parseProject` sees. A version 4 would also be refused by today's app (`version > target`). | Not required. | Required in practice, and still a break. | Not required. |
| Multi-resolution and HiDPI | One 512 PNG. The shell cache holds 32, 96, 256, 1024. | Several parts, the way Bambu stores plate, top, and pick. | Several files, easier to lose. | Several chunks. | The handler draws at `cx`. Quality depends on a rasterizer we would have to write. |
| Alpha | PNG RGBA. | PNG or JPEG. 3MF allows both. | PNG. | Whatever we invent. | We would have to blend it. |
| Size | Tens of kilobytes in front of mesh payloads that are already megabytes of base64. | Zip compression helps the JSON too, and changes every byte of every file. | A second file. | A few dozen bytes of header plus the PNG. | Zero, until the handler runs. |
| Corruption | A bad `thumbnail` is ignored. The project still opens. | A bad zip does not open at all, including the geometry. | The sidecar can rot alone. | A bad length desynchronises the JSON. | A bad mesh hangs or crashes the handler. |
| Tooling | `JSON.parse`, diff, MCP, and the tests stay as they are. | Every reader, the MCP session, and git diffs change. | File managers and mail do not keep the pair. | Two parsers forever. | Links a renderer into `dllhost.exe`. |
| Licence | None. The PNG is ours. | None, if we write the zip ourselves. | None. | None. | A small rasterizer is fine. Open CASCADE is LGPL and must not be loaded into the shell, statically or dynamically. Blender's extractor is GPL and is not usable. |

### Why not a container

(b) is the best answer for a format that is already a package of parts. `.lime` is not. Version 1 was one JSON document so the file would open on its own, and version 3 is still that document (`serializeProject` / `parseProject` in `src/project.ts`). The MCP server reads and writes it as text (`mcp/session.ts` calls the same two functions). `parseProject` does `JSON.parse` and then copies the fields it knows. Unknown keys are not rejected. They are dropped on the next save, because the writer builds a new object.

Checked readers:

- `parseProject` accepts any JSON object with a version it can migrate. An extra key does not fail the open.
- `applyMigrations` copies the object through (`{ ...doc, version: 3 }` for the version 2 step, and the version 1 step spreads `doc` too). An extra key survives migration and then has to be copied by `readPlate` / `readVersion1` or the writer will drop it. Those two functions are updated in this work so `thumbnail` and `summary` round-trip.
- The MCP session has no second parser. The Rust engine never reads `.lime`.
- No reader walks the file with a schema that refuses unknown properties.

So an optional field does not force a version bump, and today's released app still opens the file. A zip does force a break, with or without a version bump, because the bytes are no longer JSON. That fails the requirement that old v3 files keep opening and that older v3 readers keep opening what we save.

A future package version, if it ever happens, should move this PNG to `Metadata/thumbnail.png` with the OPC thumbnail relationship and put the same `meshHash` in a small sidecar part inside the zip. This document is the list of reasons not to do that now.

### Why not a sidecar, a header, or a shell-side render

(c) contradicts the reason the mesh is embedded. Rename, copy, and mail split the pair. The freedesktop cache is a sidecar, and it is a cache, not the file.

(d) is how Blender and SketchUp stay fast, and it works because every one of their readers uses their binary parser. `JSON.parse` does not. A trailer is a syntax error. A preamble is a syntax error.

(e) is what glTF has to do because nobody embedded a picture. It is the wrong primary path here. The handler's budget is a fraction of a second, it runs in `dllhost.exe` / `prevhost.exe`, and it must survive a hostile file. A `.lime` mesh is base64 measured in megabytes, and a `brep` is Open CASCADE's binary, which is not ours to tessellate in the shell. LGPL code is allowed in this repo only as a dynamic library of the engine, not inside a shell extension. The fallback when the PNG is missing is a card drawn with GDI, not a renderer.

JPEG was rejected with (a)'s format row. 3MF permits it. It has no alpha, so Explorer would need a matte, and the matte is the black-box bug above. QOI was rejected because only Prusa's firmware wants it. A second, smaller PNG was rejected because the shell already caches several sizes; two base64 blobs would both have to carry the same hash and would both sit in the prefix.

## File format

No version change. `PROJECT_VERSION` remains 3. Fields are optional. A file without them is a normal version 3 file.

Pretty-printed with the same two-space `JSON.stringify` as today. When a thumbnail is present it is the first key. When a summary is present and a thumbnail is not, the summary is first. Then `version`, and the rest of the object in the order `serializeProject` already uses. RFC 8259 does not give object order a meaning. `JSON.parse` accepts any order. Our writer uses insertion order, which `JSON.stringify` preserves, so a streaming reader that wants the picture reads the first key and stops. The rest of the file is still one JSON value; we do not truncate it.

```json
{
  "thumbnail": {
    "format": "png",
    "width": 512,
    "height": 384,
    "data": "<base64 of the PNG, no line breaks>",
    "meshHash": "<16 lowercase hex digits>",
    "generatedBy": "lime-slice/2.8.0",
    "createdAt": "2026-10-18T09:00:00.000Z"
  },
  "summary": {
    "name": "bracket",
    "printer": "Voron 2.4",
    "objectCount": 2,
    "layerHeight": 0.2,
    "slicedSeconds": 1234,
    "grams": 12.4
  },
  "version": 3
}
```

`slicedSeconds` and `grams` are omitted when this session has not sliced. Nothing else in the file stores them today (the estimate lives on the app session and on the G-code footer, not in the project). The preview says they are unknown rather than inventing them.

### `thumbnail`

| Field | Rule |
| --- | --- |
| `format` | The string `png`. Anything else is ignored. |
| `width`, `height` | Integers, each from 1 to 512, longest side 512. Must match the PNG IHDR. |
| `data` | Base64 of a PNG. Decoded length at most 128 × 1024 bytes. Signature `89 50 4E 47 0D 0A 1A 0A`. IHDR bit depth 8, colour type 6 (RGBA) or 2 (RGB), interlace 0. Writers emit colour type 6. |
| `meshHash` | Required for the picture to be shown. 16 lowercase hex digits. See below. |
| `generatedBy` | Optional. `lime-slice/<package version>` or `lime-mcp/<package version>`, at most 64 characters. |
| `createdAt` | Optional. UTC `Date.toISOString()`. |

A thumbnail that fails these checks is discarded at parse time. The project still opens. The same checks run again at write time.

### `summary`

All fields optional except that a summary object with no usable fields is omitted.

| Field | Rule |
| --- | --- |
| `name` | First object's name. On a version 1 file, the mesh name. Not a new project-title feature. |
| `printer` | `profile.name`. |
| `objectCount` | `objects.length`, or 1 when the file is a single mesh. Integer, at least 1. |
| `layerHeight` | `settings.layerHeight`, millimetres, finite, greater than 0. |
| `slicedSeconds` | Finite, at least 0, only after a slice in this session. |
| `grams` | Finite, at least 0, from that slice's filament mass. |

### `meshHash`

FNV-1a 64, the same function as `fnv1aHex` (`src/slice-action.ts`): offset basis `0xcbf29ce484222325`, prime `0x100000001b3`, 16 lowercase hex digits. It is the hash of a UTF-8 preimage, not of the PNG and not of the whole file.

Plate order is the `objects` array. A version 1 file is one object with id `part`, the top-level mesh, no brep, and the top-level placement.

For each object, append these lines (newline after every line, including the last):

1. `id`
2. `mesh.hash`
3. `brep.hash`, or an empty line when there is no brep
4. `JSON.stringify(scale)`
5. `true` or `false` for `centered`
6. `JSON.stringify(stepTolerance)`
7. nine lines, `JSON.stringify` of `orient[0]` through `orient[8]`
8. `JSON.stringify` of `offset.x`, `offset.y`, `offset.z`

`JSON.stringify` of a finite number is the ECMA-262 conversion. The Rust reader parses each JSON number and formats it with the same conversion (Ryū, pinned by a shared fixture). Settings, paint, layer actions, the camera, and the PNG bytes are not in the preimage. A settings-only edit does not invalidate the picture. Moving, scaling, replacing a mesh, or replacing a brep does.

The camera is deliberately outside the hash. A save that can draw writes a new PNG of the current view and the same hash. A save that cannot draw keeps the previous PNG when the hash still matches, and drops it when the hash does not.

### When a writer emits the fields

`serializeProject` is the gate. It writes `thumbnail` only when the object passes the checks above and `meshHash` equals the preimage of the project being written. It never writes a stale picture. It writes `summary` only when the caller set one. Existing projects that carry neither field serialize to the same JSON as they do today.

| Path | Picture | Summary |
| --- | --- | --- |
| App save (`saveCurrentProject`) | Render the current slice-view camera into an offscreen target, long edge 512, transparent clear. Not `canvas.toDataURL()`: the WebGL drawing buffer is not preserved. A fully transparent frame counts as a failed capture. The page does not bundle `mcp/render.ts` (it uses `node:zlib`). If the capture fails, keep a stored thumbnail whose hash still matches, otherwise omit it. | Always, from the plate. `slicedSeconds` and `grams` only when the slice estimate is current (`stale()` is false). |
| MCP `project_save` | `renderMesh` in `mcp/render.ts`, the `render_view` renderer: whole plate, positions transformed by placement, camera `iso`, long edge 512. No window, no OpenGL, no Open CASCADE. On failure, the same keep-or-drop rule. | Always, from the plate. Time and grams only if this session has a finished slice. |
| MCP autosave (`flushAutosave`) | Does not render. Keeps a thumbnail already on the document when the hash still matches, and drops it when the geometry changed. Autosave stays cheap and must not throw. | Written from the plate, without time and grams unless the document already had them and the slice is still the current one. |
| Open, untouched, save | Round-trips. | Round-trips. |
| Open a file with no thumbnail | Opens as it does today. The next successful save adds one. | Added on the next save. |
| Geometry edit, then a headless save that cannot render | Thumbnail omitted. | Summary updated. The picture is not left behind. |

`generatedBy` is `lime-slice/<version>` in the app and `lime-mcp/<version>` in the session. `createdAt` is the time of the render. A kept thumbnail keeps its original `createdAt` and `generatedBy`.

A capture whose PNG is over 128 KiB is scaled so the long edge is 256 and encoded again. If it is still over the cap, the thumbnail is omitted. The save itself still succeeds.

### What the shell shows

Fast path: read the first key. If it is `thumbnail`, decode and check it, and read `summary` if it is the second key. Do not build a DOM, and do not allocate a multi-megabyte string. Base64 is decoded into a capped buffer.

Then a second streaming pass, or the same pass continued, skips string values longer than 128 bytes (mesh `bytesBase64` and brep bytes) and rebuilds the preimage from the short fields. The pass has a 500 ms budget so a pathological file cannot stick `dllhost.exe`.

| Scan result | Icon and preview image |
| --- | --- |
| Hash matches | The PNG, as `WTSAT_ARGB`. |
| Hash differs | The placeholder card. A stale picture is not shown. |
| Budget exceeded before the hash is confirmed | The placeholder card. An unchecked picture is not shown. Our own writers put the geometry after the prefix in a single sequential scan, so a normal project finishes. |
| No thumbnail, or a thumbnail that fails the checks | The placeholder card. |
| Truncated or hostile JSON | The placeholder card, or `E_FAIL` from the thumbnail API if nothing at all can be drawn. No panic. |

The placeholder is a GDI card: the name, the printer, the object count, the layer height, and the time and grams when the summary has them. With no summary, the card says `Lime Slice project` and `No preview stored`. The preview pane uses the host background from `IPreviewHandlerVisuals`. It does not launch the app.

The Details pane reads the property handler. If Windows ignores a per-user property handler, the Preview Pane still has the same text. That split is deliberate.

## Code layout

| Piece | Where | Linked to the slicer? |
| --- | --- | --- |
| Field types, read, write, hash, stale drop | `src/project.ts` and a small helper next to it | No. TypeScript only. |
| App capture | `src/app/project-io.ts`, using the existing 3D view | No. |
| MCP capture | `mcp/session.ts` on `project_save`, renderer in `mcp/render.ts` | No engine change. |
| Streaming reader | `crates/lime-preview`. The only dependency is `ryu`, which formats numbers the way `JSON.stringify` does. | No. Workspace member so `cargo test` runs it. Not a dependency of `lime-slice`, `lime-slice-core`, `lime-model`, or the desktop crate. |
| COM DLL | `crates/lime-shell`, crate type `cdylib`, `windows` crate 0.61 (already in the lockfile, MIT or Apache-2.0). `#[cfg(windows)]` for COM. Linux builds a stub so clippy and `cargo test --workspace` stay green. | No. |
| Self-test | A Windows-only example that `LoadLibrary`s the DLL, calls `DllGetClassObject`, and asks `IThumbnailProvider` for a sample file. Console subsystem, run by hand. | The installer does not start it. |
| Installer | NSIS hook only. `tauri.windows.conf.json` already selects NSIS. WiX is not a bundle target; the same registry table is what a WiX component would write if one is added later. | The file version stays 3. The app is 2.8.0. |

COM entry points (`DllGetClassObject`, `DllCanUnloadNow`, `DllRegisterServer`, `DllUnregisterServer`) catch panics and return a failure `HRESULT`. The DLL does not call `AllocConsole`, does not spawn a process, and does not use `println!` on the COM path. Registration from `DllRegisterServer` writes HKCU when the process is not elevated, so a hand registration also avoids an administrator. The NSIS hook does not run `regsvr32`.

Licence: no GPL and no Open CASCADE in the shell. The `windows` crate is MIT or Apache-2.0. `lime-preview` depends only on `ryu` (Apache-2.0 or the Boost Software License) for the number text. PNG bytes are checked structurally in `lime-preview` and decoded with Windows Imaging Component on Windows, which is part of the OS.

## Installer

The release workflow's Windows leg already builds NSIS (`--bundles nsis`). That leg also builds `lime_shell.dll` and copies it to `src-tauri/resources/lime_shell.dll`. The Windows installer command passes `src-tauri/tauri.shell.json`, which maps that file to `$INSTDIR\lime_shell.dll` and points NSIS at `src-tauri/windows/shell-hooks.nsh`. Linux and macOS do not pass that config, so a desktop build there never looks for the DLL. This step does not bump `tauri.conf.json`, the workspace version, or any crate version. It does not add a `workflow_dispatch` and does not tag.

The NSIS hook (`NSIS_HOOK_POSTINSTALL` / `NSIS_HOOK_POSTUNINSTALL`) writes and deletes, under `SHCTX` so a per-user install stays in HKCU and a per-machine install stays in HKLM:

- `Software\Classes\CLSID\{A344EC17-8764-5F01-9C73-FFE2DA751916}\InprocServer32` → `$INSTDIR\lime_shell.dll`, `ThreadingModel` = `Apartment`, `AppID` = `{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}`
- `Software\Classes\com.limeslice.slicer.lime\shellex\{e357fccd-a995-4576-b01f-234630154e96}`
- `Software\Classes\com.limeslice.slicer.lime\shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}`
- `Software\Classes\SystemFileAssociations\.lime\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}`
- `Software\Classes\.lime\ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}`
- `Software\Microsoft\Windows\CurrentVersion\PreviewHandlers` value named `{A344EC17-8764-5F01-9C73-FFE2DA751916}` = `Lime Slice project`
- `Software\Microsoft\Windows\CurrentVersion\PropertySystem\PropertyHandlers\.lime` = the same CLSID

The open verb, the icon, and the rest of the Tauri association are left as they are. Uninstall removes these keys and does not delete unrelated `.lime` associations the user may have edited, beyond the `ShellEx` subkeys and the CLSID we created.

## Tests

On the Linux CI VM, and locally:

| Test | Where |
| --- | --- |
| A version 3 file with no new fields parses and serializes as it does today | `src/project.test.ts` |
| Round-trip: serialize, parse, serialize keeps the PNG and the summary when the geometry matches | `src/project-thumb.test.ts` |
| `thumbnail` is the first key and the text is valid JSON | `src/project-thumb.test.ts` |
| A geometry change drops the thumbnail; a settings change keeps it | `src/project-thumb.test.ts` |
| A bad thumbnail (wrong type, bad base64, oversize, JPEG, mismatched IHDR, missing `meshHash`) does not fail the open and is not written back | `src/project-thumb.test.ts` |
| Version stays 3, including a file that has the new fields | `src/project-thumb.test.ts` |
| MCP `project_save` writes a thumbnail from `renderMesh`; a following geometry edit that cannot render drops it; autosave does not call the renderer | `mcp/thumb.test.ts` |
| Streaming reader: prefix only, hash match, hash mismatch, summary, missing field | `crates/lime-preview` |
| Hostile input, no panic and no multi-megabyte allocation: truncated JSON, a string hundreds of megabytes long declared and not stored, wrong types, a thumbnail key buried inside a mesh name, a file that never closes | `crates/lime-preview` |
| Shared hash fixture: the TypeScript preimage and the Rust preimage are the same bytes | both |

`tools/golden_ab.sh` is the slicer check. It must stay 48 same / 0 different. The slicer crates are not modified. The new crates are workspace members and must not become dependencies of `lime-slice` or `lime-slice-core`.

Windows, for Marius, because this VM is Linux:

- `cargo build -p lime-shell --release` produces `lime_shell.dll`. CI on `windows-latest` does this and runs `cargo test -p lime-preview`. The existing job names stay as they are. The step is added to `MCP server (Windows)`, which already has a Rust toolchain; the build is the `windows` crate and our code, with no Open CASCADE.
- The self-test example loads the DLL and writes a BMP or PNG of `GetThumbnail` for a sample `.lime`.
- Explorer medium and extra-large icons, including a 200% DPI display if he has one.
- Preview Pane, light and dark, with a thumbnail and with an old file that has none.
- A file whose `meshHash` was edited to not match shows the card, not the picture.
- Details pane: `System.Title` and `System.Comment` if the per-user property handler is honoured; if it is not, that is the known HKLM limitation.
- Install and uninstall as a normal user. No console window from the installer, the DLL, or Explorer. The self-test is allowed to be a console program because he runs it himself.

## Migration

- Files on disk today: unchanged, and they open on this app and on 2.7.0.
- Files this app saves: still `"version": 3`. 2.7.0 opens them and, on a later save, writes them back without `thumbnail` or `summary`. No geometry is lost. The picture comes back the next time this app saves.
- An app from before version 3: still refuses the file. That refusal is the version check, and this work does not touch it.
- Slicer output, G-code, and golden hashes: unchanged. The thumbnail is not an input to the engine.
- No tag, no release, and no `workflow_dispatch`. The app version is 2.8.0. The file version stays 3.

File > New project (Ctrl+N) clears the open document. It does not change `.lime`. The dirty check is the same flag Open uses.

## Open questions

1. Details-pane columns with their own names (layer height, grams) need a `.propdesc` and HKLM. The Preview Pane text is the stand-in. Is that enough, or should a later installer elevate just to register the schema?
2. Autosave does not render. A crash between a geometry edit and the next `project_save` leaves no picture, or drops the old one. Rendering on autosave would make the one-second timer depend on the software rasterizer. I would rather keep autosave cheap unless you want the picture there.
3. The app thumbnail uses the current camera. The MCP thumbnail uses `iso`, because a headless session has no camera. Say if MCP should use a fixed three-quarter view that matches a particular app default instead.
