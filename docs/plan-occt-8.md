# Plan: move Model mode from Open CASCADE 7.9.2 to 8.0.2

Status: plan, for review. Written 2026-11-28 against `main` at v7.7.0 (`604803a`, the merge of #911). Docs only: no code changes with this plan.

The trigger: every macOS build of `crates/lime-model-occt` prints `'sprintf' is deprecated` many times. The call is in Open CASCADE's own header `NCollection_UBTreeFiller.hxx` (line 198 in 7.9.2). That header comes in through `BRepClass3d_*`, `Extrema_*` and `ShapeAnalysis_Surface`, and the Xcode SDK marks `sprintf` deprecated. The owner does not want the warning silenced: no `-isystem` and no `-Wno-...`. The noise buries real warnings from our own C++.

Upstream fixed it in commit `5ae60b51d` "Coding - Moving to Sprintf call (#675)" (2025-08-17). The header now calls OCCT's exported `Sprintf`. That commit is an ancestor of `V8_0_0` (GitHub compare: "ahead") and is not in 7.9.x: compared with `V7_9_3` the result is "diverged", and `V7_9_3` still calls `sprintf`. In `V8_0_2` (tag commit `83f9abe`, 2026-11-22) the call is at `src/FoundationClasses/TKernel/NCollection/NCollection_UBTreeFiller.hxx:186`. No 8.0.2 header calls `sprintf`, `vsprintf`, `tmpnam` or `mktemp` outside a comment; in 7.9.2 the `sprintf` call at line 198 is the only one (checked by grep over both header sets). The fix is therefore OCCT 8.0.x. 8.0 is a major release, so the move needs this plan first.

## 1. Goal

1. Model mode, the MCP engine and the release installers run on **Open CASCADE 8.0.2** on Linux, Windows, macOS arm64 and macOS Intel.
2. The bridge's C++ builds on 8.0.2 with **no warning that comes from an Open CASCADE header, and no deprecation warning in our own C++**, with no warning flag added or changed. A CI step checks the macOS log for this.
3. **Geometry does not change silently.** Every kernel result the tests produce is compared before and after (section 6). A difference is either explained and accepted by the owner, or fixed.
4. Projects saved with 7.9.2 still open. A solid saved by one version reads in the other, both ways.

### Non-goals

- No new OCCT feature. BRepGraph, `GeomFill_Gordon`, `TKHelix`, `NCollection_KDTree` and the new `GeomProp`/`GeomBndLib` packages are later ideas, not part of this move.
- No change to the slicer, the G-code, the project format version, or the `LIMEBREP 1` header format.
- No `Handle(T)` to `occ::handle<T>` rewrite. 8.0.2 keeps `Handle()` and does not warn on it (`Standard_Handle.hxx:448`); our 229 uses stay.
- No OCCT build change beyond what 8.0 needs: still shared libraries, the same toolkits, FreeType, TBB, OpenGL and Draw still off.
- No company part data in fixtures or A/B inputs. The A/B uses the repo's own tests only.

## 2. Current state

From `main` at `604803a`:

- **The bridge.** `crates/lime-model-occt/cpp/`: `kernel.cpp` (14,058 lines), `tree.cpp` (4,389), `text.cpp` (1,751), `fault.cpp` (193), `kernel.h` (1,196) and `organic_fill.inc` (2,367): 24,348 lines in all, including **222 distinct OCCT headers**. `crates/lime-model/cpp/bridge.cpp` (9 lines) includes only `Standard_VersionInfo.hxx`, to report the version.
- **Build.** `crates/lime-model-occt/build.rs`:
  - links 16 toolkits (`LIBS`, `:7-26`), plus 10 STEP toolkits when `TKDESTEP` is present (`STEP_LIBS`, `:28-39`);
  - compiles C++17 (`:88`), with `/EHa` on MSVC and `OCC_CONVERT_SIGNALS` elsewhere (`:94-102`);
  - finds headers by probing `include/opencascade` and then `inc` for `Standard_VersionInfo.hxx` (`include_dir`, `:114-125`);
  - refuses a static `libTKernel.a` (`:138-150`).

  `crates/lime-model/build.rs` does the same probe (`:45-53`) and links `TKernel` only.
- **How OCCT is built.** `tools/occt/install.py`:
  - pins `VERSION = "7.9.2"`, `TAG = "V7_9_2"` and the archive SHA-256 (`:22-25`);
  - builds 17 toolkits through `BUILD_ADDITIONAL_TOOLKITS` (`:30-51`), with every module off (`:53-62`);
  - passes a fixed list of `USE_*`/`BUILD_*` options with `INSTALL_DIR_LAYOUT=Unix` (`:105-160`);
  - unpacks into `OCCT-7_9_2` (`:219`).

  `tools/occt/stage_bundle.py` copies the `TK*` shared libraries and the three notices into the installers.
- **CI.** `.github/workflows/ci.yml` names `occt-7.9.2` 52 times: a path and a cache key `occt-7.9.2-model-<os>-<arch>-<hash of install.py>` in every OCCT job:
  - Rust tests (`:104`);
  - "MCP server against real Open CASCADE" (`:215`), including the "Can press loop proof" step (`:389`);
  - "Folded shell against real Open CASCADE" (`:402`);
  - "Auto ribs against real Open CASCADE" (`:501`);
  - clippy (`:587`) and the Tauri build (`:683`);
  - "release bench smoke" (`:1373`; release bridge at `:1432`);
  - "OCCT dynamic link (Windows)" (`:1528`), which also loads the bridge from the bundled layout without PATH (`:1578`);
  - "OCCT dynamic link (macOS)" (`:1600`).

  `release.yml` has 8 more (`:166-227`), for Linux, Windows, macOS arm64 and macOS Intel.
- **Cold build time and cache.** With 7.9.2, a cache miss took 25 min on macOS, 35 min on Windows and 27 min on Linux. That is run 38390949449 (2026-10-13), the last change to `install.py`. Each cached install is 22 to 27 MB. The repo's Actions caches total 11.4 GB over 42 entries.
- **Local.** On the owner's Windows machines OCCT lives outside the profile (`D:\occt-7.9.2` on this one). The bridge DLL needs the OCCT DLLs beside it, because `LoadLibraryExW` ignores PATH (memory: local-occt-bridge).
- **Saved solids.**
  - A project keeps each step's solid as `LIMEBREP 1 <occt version> <volume> <edges>` plus BinTools bytes, written with `BinTools_FormatVersion_CURRENT` (`kernel.cpp:4016`; header `src/tree.rs:82`, reader `src/tree/shape_io.rs:206-255`).
  - A solid that fails to read says "saved by Open CASCADE X, this modeler has Y", and its history is rebuilt (`e2e/model-tree-save.spec.ts:303`).
  - A replayed step must match its saved fingerprint: the same faces and edges, and a volume within 1e-6 relative (`src/tree.rs:106-111`).
- **Version-specific expectations.**
  - `tests/kernel_fault.rs:119` expects the 3.1.1 push crash to be refused on Windows.
  - `tests/mesh_angle.rs:110` asserts node values printed by the Windows 7.9.2 job.
  - `tests/flat_mesh.rs:2` keeps point sets on which 7.9.2's Delabella faulted.
  - `kernel.cpp:770` subclasses `BRepMesh_BaseMeshAlgo` (the exact flat mesher, #881). It relies on `initDataStructure` and on TKMesh's exports on Windows.
- **Licence.** `third_party/occt/NOTICE.md` names 7.9.2, tag `V7_9_2` and its SHA-256 (`:3`, `:13-17`).

## 3. The evidence: a compile probe against 8.0.2

What was done: the `V8_0_2` source archive was downloaded (SHA-256 `4b3ecaa559cd4f772a8a763668ca692bf79a36b05c41e8871139eb8d4625de9c`). Its 8,374 public headers were flattened into one directory, as an install does. `Standard_Version.hxx` was generated from `adm/templates/Standard_Version.hxx.in`. Then `kernel.cpp`, `tree.cpp`, `text.cpp`, `fault.cpp` and `lime-model/cpp/bridge.cpp` got a syntax-only compile with clang (zig 0.16, libc++, `x86_64-linux-gnu`, `-std=c++17 -DOCC_CONVERT_SIGNALS -DLIME_OCCT_STEP -DLIME_OCCT_TEST_HOOKS`, default warnings). As a control, the same command against the installed 7.9.2 headers gives **0 errors and 0 warnings**.

Results against 8.0.2:

| Kind | Count | Where |
|---|---|---|
| Missing header (fatal) | 1 header, stops 2 files | `TopTools_ListIteratorOfListOfShape.hxx` (`kernel.cpp:181`, `tree.cpp:44`). In 8.0 the typedef lives in `TopTools_ListOfShape.hxx`, deprecated. With a one-line shim the probe went on. |
| Errors | 3, one site | `fault.cpp:144-147`: `Standard_Failure::NewInstance`, `Standard_Failure::Jump`, and `Handle(Standard_Failure)`. `Standard_Failure` now derives from `std::exception`, not `Standard_Transient`. |
| Deprecation warnings in our code | 495 on 432 lines, 23 distinct names | see the table below |
| Warnings from OCCT headers | 21 `#pragma` warnings from 13 deprecated headers | every chain starts at one of our own `#include`s (or a deprecated header including another), so they go when we include the replacements |
| `bridge.cpp` | 0 | `OCCT_Version_String_Complete()` is unchanged |

Kernel, tree and text compile otherwise. The custom mesh algorithm, the `Message_ProgressIndicator` subclass, the `IMeshTools_MeshAlgoFactory` subclass, `Bnd_Box::Get`, `IndexedDataMap::Seek` and every builder we call still compile.

Deprecations by kind:

| Deprecated | Uses | 8.0 replacement |
|---|---|---|
| `Standard_True`, `Standard_False` | 262 | `true`, `false` |
| `Standard_Real`, `Standard_Integer`, `Standard_Boolean` | 34 | `double`, `int`, `bool` |
| Collection typedefs: `TopTools_ListOfShape` (46), `TopTools_IndexedDataMapOfShapeListOfShape` (23), `TopTools_IndexedMapOfShape` (21), `TColStd_Array1OfReal` (19), `TColStd_Array1OfInteger` (16), `TopTools_ListIteratorOfListOfShape` (10), `TColgp_Array1OfPnt`/`Array1OfPnt2d`/`Array2OfPnt`, `TColStd_Array2OfReal`, `TDF_LabelSequence` (4 each), `TopTools_HSequenceOfShape` (3), `TColgp_HArray1OfPnt` (2) | 160 | `NCollection_List<TopoDS_Shape>`, `NCollection_IndexedDataMap<TopoDS_Shape, …, TopTools_ShapeMapHasher>`, `NCollection_Array1<double>` and so on. All of these exist in 7.9.2 too. |
| `Standard_Failure::GetMessageString()` | 26 | `what()`, which 7.9.2 does not have |
| Copy-out `Knots(arr)`, `Multiplicities(arr)` (`organic_fill.inc`) | 11 | `Knots()`/`Multiplicities()` returning a const reference, also in 7.9.2 |
| `ShapeAnalysis_FreeBounds::ConnectEdgesToWires` with a handle out-parameter (`kernel.cpp:12692`) | 1 | the overload that returns the handle, which 7.9.2 does not have |
| `GCE2d_MakeSegment` | 1 | `GC_MakeSegment2d`, which 7.9.2 does not have |

What the probe does not cover:
- **MSVC.** No MSVC compile was run (no MSVC on this machine), so the `_MSC_VER` branch of `fault.cpp` is checked by reading only. It uses `throw Standard_Failure(...)`, which 8.0 keeps.
- **Apple clang's SDK deprecations.** `sprintf` was checked by grep, as above.
- **Linking.** Nothing was linked, and in particular TKMesh's exports for `FlatBaseMeshAlgo` on Windows were not checked.
- **Runtime behaviour.** OCCT 8 itself was not built.

## 4. What 8.0 changes for us

Sources:
- the 8.0.0 release notes ([V8_0_0]);
- the 8.0.0p1, 8.0.1 and 8.0.2 notes ([V8_0_0_p1], [V8.0.1], [V8_0_2]);
- the upgrade guide `dox/upgrade/upgrade.md`, section `upgrade_occt800`, in the 8.0.2 source;
- the probe above.

| Our use | 8.0 change | Our fix | Source |
|---|---|---|---|
| `fault.cpp:138-147`: on Linux and macOS a signal becomes `Standard_Failure::NewInstance(...)->Jump()` | `Standard_Failure` derives from `std::exception`, is no longer a handle class, and has no `Raise`, `Throw`, `Instance`, `NewInstance` or `Jump`. The handler stack is `thread_local`. A signal is stored in a `std::variant` and thrown by `Standard_ErrorHandler::Raise()` from `OCC_CATCH_SIGNALS`. | Call `Standard_ErrorHandler::Abort(OSD_SIGSEGV(kInternalError))` (or the type that matches the signal) instead. That is the 8.0 way to jump to the nearest `OCC_CATCH_SIGNALS`. `IsInTryBlock()` stays. Proof: `tests/kernel_fault.rs`'s deliberate fault hook on Linux and macOS. | upgrade guide "Exception handling"; `Standard_ErrorHandler.hxx` (`Abort<T>`, `SignalException`); PR #984 "Inherited Standard_Failure from std::exception" |
| 211 `catch (const Standard_Failure&)` clauses and 94 `catch (...)` | Catching still works. None of our clauses catches `std::exception` ahead of it (checked), so no failure changes handler. `OSD_ThreadPool::performJob` still words an SEH fault as "Error: Unknown exception", which `tree.cpp:126` matches. | No change. Proof: kernel_fault, Windows. | `OSD_ThreadPool.cxx` |
| `GetMessageString()` (26 uses) | Deprecated in favour of `what()`. | A one-line `failure_text(const Standard_Failure&)` in `kernel.h` while both versions build (D2). After O4, `what()`. | `Standard_Failure.hxx:59` |
| `#include <TopTools_ListIteratorOfListOfShape.hxx>` | The header is gone (typedef-only headers were removed; PR #1475, which restores some, is on master after 8.0.2, "since 8.1.0"). | Include `NCollection_List.hxx` and use `NCollection_List<TopoDS_Shape>::Iterator`. | probe; upgrade guide "Removed and deprecated" |
| 160 collection typedefs, 13 deprecated headers | Typedef headers warn through `Standard_HEADER_DEPRECATED` (a `#pragma GCC warning`), and each typedef warns through `[[deprecated]]`. | Use the `NCollection_*` templates and their headers, which work on 7.9.2 too. | upgrade guide "Package collection typedefs"; PR #1026 |
| `Standard_True/False/Real/Integer/Boolean` (296 uses) | Deprecated aliases. | `true`, `false`, `double`, `int`, `bool`. | upgrade guide "Handle macro and Standard_* primitive types" |
| `Knots(arr)`, `Multiplicities(arr)` copy-outs | Deprecated: BSpline arrays are value members, and the copy-out overloads cost a copy. | The const-reference accessors. They exist in 7.9.2 (`Geom_BSplineCurve.hxx:656, :768`). | upgrade guide "BSpline/Bezier weights and accessors" |
| `ConnectEdgesToWires(..., Handle&)` | Handle out-parameters are deprecated in favour of return by value. | The new overload, behind the version switch until O4. | upgrade guide "Handle out-parameter overloads deprecated" |
| `GCE2d_MakeSegment` | Deprecated alias of `GC_MakeSegment2d`. | `GC_MakeSegment2d`, behind the version switch. | `GCE2d_MakeSegment.hxx:25` (8.0.2) |
| `FlatBaseMeshAlgo : BRepMesh_BaseMeshAlgo` (`kernel.cpp:770`) | Same virtuals, `Standard_Integer`/`Boolean` spelled `int`/`bool`. `getNodesMap()` is now `NCollection_DynamicArray` (we do not call it). Nodes are registered in `registerNode()`, not `initDataStructure()`. The plug-in factory was rebuilt around `BRepMesh_DiscretAlgoFactory` (we use `IMeshTools_MeshAlgoFactory` and `BRepMesh_Context`, still present). 8.0.1 changed seam constraints (#1338), and 8.0.2 changed circumcircles and refinement near constrained edges (#1741). | Compiles as is. Re-check that boundary nodes are the neighbours' on 8.0: `tests/flat_mesh*.rs`, `mesh_quality.rs`, `mesh_order.rs`. Check the link on Windows (TKMesh exports) in O2. | header diff 7.9.2 ↔ 8.0.2; [V8_0_0] "Mesh"; [V8.0.1] #1338; [V8_0_2] #1741 |
| Display and export meshes (`BRepMesh_IncrementalMesh`, tangential deflection) | The 8.0.2 fix to tangential-deflection sampling (#1741) can move nodes. | Expected changes in `mesh_angle.rs` (Windows numbers) and mesh counts. The A/B reports them; refresh the numbers with the owner's yes (D4). | [V8_0_2] |
| Volume (`BRepGProp::VolumeProperties`; our parallel copy `integrated_volume`, `kernel.cpp:564-594`, which claims "the same number to the last bit") | `BRepGProp_Face` now caches the surface and location, and shared subshapes are no longer double-counted under `SkipShared` (we use the default `false`). 8.0.2 changed plane-limited integration (#1587, #1601), which we do not use. | The bit-for-bit claim must be re-proved on 8.0 (`tests/brep.rs`, `part.rs`, `primitives.rs`). Fingerprint tolerance is 1e-6, so last-bit drift is harmless. A real drift shows in the A/B. | [V8_0_0] "Performance" |
| Booleans, fillets, offsets, lofts, pipes, `UnifySameDomain`, `ShapeFix` | Many crash and hang fixes, and some changed results: "FillSameDomainFaces uses the parent solid" (thin solids), the fillet spine seam (#1501), `ThruSections` history for closed lofts (#1783), circular wire offsets (#1453), C2 continuity classification. Fillets are now reentrant across threads (#1374). | No code change. The A/B (section 6) checks face and edge counts and volumes. `kernel_fault.rs`'s Windows refusal of the 3.1.1 push may now be a valid solid (D6). | [V8_0_0], [V8.0.1], [V8_0_2] |
| `IsClosed()`/`IsPeriodic()` on curves and surfaces | Tolerance is now `Precision::Computational()`, not `gp::Resolution()`. | We call only `BRep_Tool::IsClosed` (topological), so there is no effect. Checked: no `Geom*::IsClosed()` call in the bridge. | upgrade guide "IsClosed/IsPeriodic" |
| `NCollection_Array1` assignment | `operator=`/`Assign` now take the source's bounds (as `std::vector` does). The old element copy is `CopyValues()`. | No array of ours is default-built and then assigned (checked by grep). O2 re-checks after the typedef rewrite. | [V8_0_0] "Collections" |
| `BinTools::Write(..., BinTools_FormatVersion_CURRENT)` | `BinTools_FormatVersion.hxx` is unchanged between 7.9.2 and 8.0.2. | 7.9.2-written solids read on 8.0, and 8.0-written ones read on 7.9.2. Proved both ways in O3. | header diff |
| STEP read and write (`STEPCAFControl_*`, `XSControl_*`, `DESTEP_Parameters`) | Concurrent readers and writers are safe. `StepData_ReadWriteModule::StepType` returns a `string_view` (we do not override it). Unit and GD&T fixes. `Standard_Strtod` is thread-local (8.0.0p1). | No code change. `tests/step_import` (Windows job) and `step-guard-occt` cover it. | [V8_0_0] "STEP"; [V8_0_0_p1] |
| Toolkits: build.rs `LIBS` (16) + `STEP_LIBS` (10), install.py `TOOLKITS` (17) | All still exist under the same names. `TKDESTEP`'s and `TKXCAF`'s dependency lists are the same set (`src/DataExchange/*/EXTERNLIB.cmake`). New toolkits we do not need: `TKHelix`, `TKExpress`. | None. | 8.0.2 `src/*/TOOLKITS.cmake` |
| `Standard_VersionInfo.hxx` probe; `include/opencascade`, `lib`, `bin` | The Unix layout still installs headers to `include/opencascade` (`CMakeLists.txt:876`), and `Standard_VersionInfo.hxx` is still a TKernel header. Resources move to `share/<project>/resources`; we ship none. | None in build.rs. | 8.0.2 `CMakeLists.txt`; upgrade guide "Minimum requirements" |
| CMake options in `install.py:113-139` | Still read: `BUILD_LIBRARY_TYPE`, `INSTALL_DIR_LAYOUT`, `BUILD_ADDITIONAL_TOOLKITS` (`separate_arguments` kept), every `USE_*`, `BUILD_DOC_Overview`, `BUILD_USE_PCH`, `BUILD_RELEASE_DISABLE_EXCEPTIONS` (default ON in 8, and we pass OFF). No longer read: `BUILD_Inspector` (Inspector left the repo), `BUILD_SAMPLES_QT`, `BUILD_SAMPLES_MFC`, `BUILD_MODULE_DETools`. `BUILD_PATCH` is removed (we do not use it). `USE_VTK` is now off by default. `BUILD_GTEST` defaults off. | Drop the four unread options for 8 so CMake's "not used" warning does not appear. Keep the rest. | 8.0.2 `CMakeLists.txt`, `adm/cmake` |
| Source layout `OCCT-7_9_2/src/<Package>` | `src/<Module>/<Toolkit>/<Package>` (#450). The archive unpacks to `OCCT-8_0_2`. | `install.py` takes the folder name from its version table. Nothing of ours reads OCCT's source paths. | PR #450 |
| Compiler and standard | C++17 required (we already build C++17). VS 2019+, GCC 8+, Clang 7+, Apple Clang 11+, CMake 3.10+. | None: the runners have VS 2026, current GCC, Xcode clang and CMake. | upgrade guide "Minimum requirements" |
| Exceptions with `/EHa` on Windows; `OCC_CONVERT_SIGNALS` elsewhere | Unchanged in OCCT's CMake (`adm/cmake/occt_defs_flags.cmake:48-56`). | None. | 8.0.2 source |
| Linux: the bridge is `dlopen`ed and catches OCCT exceptions | 8.0 no longer links with `-symbolic`, and the upgrade guide asks to re-check RTTI across `dlopen`ed plug-ins. | Proved by `kernel_fault` and the MCP OCCT jobs on Linux in O3. | upgrade guide "Minimum requirements" |
| Third-party (FreeType, TBB, RapidJSON, VTK) | All off for us, and all optional. 8.0.1 discovers a system TBB on Windows only when TBB is on. | None. | [V8.0.1] #1403 |
| Licence | `LICENSE_LGPL_21.txt` and `OCCT_LGPL_EXCEPTION.txt` in `V8_0_2` are byte-identical to `third_party/occt/` (line endings aside). New in 8.0.2: `NCollection_UtfIterator.lxx` carries the **Unicode License V3** notice for its ConvertUTF-derived parts (#1532). | Update `NOTICE.md` to 8.0.2, `V8_0_2` and the new SHA-256, and add the Unicode notice (D7). | 8.0.2 source; [V8_0_2] |

[V8_0_0]: https://github.com/Open-Cascade-SAS/OCCT/releases/tag/V8_0_0
[V8_0_0_p1]: https://github.com/Open-Cascade-SAS/OCCT/releases/tag/V8_0_0_p1
[V8.0.1]: https://github.com/Open-Cascade-SAS/OCCT/releases/tag/V8.0.1
[V8_0_2]: https://github.com/Open-Cascade-SAS/OCCT/releases/tag/V8_0_2

On the PRs named in the brief:
- #955 is "Add modernization scripts for OCCT 8.0.0": the `adm/scripts/migration_800` suite.
- #965 is "Clang-Tidy apply with refactoring".
- #1212 is "NCollection modernization and BRepGraph overhaul".
- #1230 is "Deprecate NCollection_Vector", which the bridge does not use.

In all, the break that touches us is the signal jump in `fault.cpp`, one removed header, and mechanical renames.

## 5. Milestones

Four PRs, each small enough to review on its own. The release stays on 7.9.2 until O4 lands, so a problem found on the way costs nothing shipped.

| Id | What | Size |
|---|---|---|
| **O1** | **CI builds OCCT 8.0.2 beside 7.9.2, behind a switch.**<br>• `install.py --version {7.9.2,8.0.2}`, with a table of tag, SHA-256, folder name and the options each version reads.<br>• One workflow-level `OCCT_VERSION: "7.9.2"` in `ci.yml` and `release.yml` replaces the 60 literals in paths and cache keys.<br>• A non-required "Open CASCADE 8 preview" job (Linux, Windows, macOS arm64) builds and caches 8.0.2 and uploads its install size and build time. | small |
| **O2** | **The bridge compiles on both, warning-free on 8.0.2, and the crate tests pass there.**<br>• The renames in section 4: collection templates, `true`/`false`/`double`, the const-reference accessors.<br>• A tiny `cpp/occt_compat.h` with the four things 7.9.2 lacks: `failure_text`, the handle-returning `ConnectEdgesToWires`, `GC_MakeSegment2d`, and the `fault.cpp` jump, behind `OCC_VERSION_HEX >= 0x080000`.<br>• The preview job builds `lime-model` and `lime-model-occt` against 8.0.2 and runs `cargo test -p lime-model -p lime-model-occt`. On Windows it also runs the bundled-layout load and `step_import`.<br>• Expectations tied to 7.9.2 become per-version: `mesh_angle.rs`'s Windows numbers and `kernel_fault.rs`'s Windows refusal (D6). | medium |
| **O3** | **Parity proof.**<br>• The kernel A/B (section 6) on the whole crate suite and the MCP OCCT tests.<br>• The preview job also runs the MCP server, folded shell, auto ribs and can press steps, and the release bench smoke bridge build, all against 8.0.2.<br>• A BRep cross-read both ways.<br>• Each accepted difference is listed in the PR with its reason. | medium |
| **O4** | **Switch and clean up.**<br>• `OCCT_VERSION: "8.0.2"` in both workflows, and the preview job removed.<br>• `NOTICE.md` updated (version, tag, SHA-256, Unicode notice).<br>• `occt_compat.h` and the 7.9.2 row of `install.py` removed (D8).<br>• `GetMessageString` becomes `what()`.<br>• The local setup note updated, as a folder outside the profile such as `D:\occt-8.0.2`, with the DLLs beside the bridge as now. The OCCT row in `CLAUDE.md` and the `verify-ui` skill also move off a profile path.<br>• The release notes name the kernel move and the accepted geometry changes. | small |

Each is its own PR with this plan as its spec. O1 and O2 change nothing a user sees. O4 is the only one that changes what ships.

### Proof each milestone needs

| Proof | O1 | O2 | O3 | O4 |
|---|---|---|---|---|
| Every required check green on 7.9.2, unchanged ("test, clippy, and Tauri", "release bench smoke", "typecheck and frontend build", "Playwright smoke") | ✓ | ✓ | ✓ | on 8.0.2 |
| Preview job builds and caches 8.0.2 on Linux, Windows and macOS. The PR records cold build minutes and cache MB beside 7.9.2's 25 to 35 min and 22 to 27 MB. | ✓ | | | |
| `cargo test -p lime-model -p lime-model-occt` on 8.0.2 (Linux, macOS, Windows), as in "OCCT dynamic link (Windows)" and "(macOS)" | | ✓ | ✓ | ✓ |
| "Load the bridge from the bundled layout without PATH" and "STEP import regression through the loaded bridge" on 8.0.2 (Windows) | | ✓ | ✓ | ✓ |
| **macOS log check.** The preview build of the bridge on macOS keeps cargo's `warning:` lines from `cc`. A step fails on any warning whose path is under `$OCCT_ROOT/include`, or any `-Wdeprecated-declarations` or `#pragma-messages` warning in `crates/lime-model-occt/cpp`. No warning flag is added, and the build uses `cc`'s defaults exactly as today. | | ✓ | ✓ | ✓, moves into "OCCT dynamic link (macOS)" |
| "MCP server against real Open CASCADE", "Folded shell against real Open CASCADE", "Auto ribs against real Open CASCADE" and its "Can press loop proof" step, all on 8.0.2 | | | ✓ | ✓ |
| Release bench smoke's release bridge build on 8.0.2 | | | ✓ | ✓ |
| Kernel A/B report (section 6) in the PR: 0 unexplained differences | | | ✓ | |
| BRep cross-read: a 7.9.2-written `LIMEBREP` read on 8.0.2, and an 8.0.2-written one on 7.9.2 | | | ✓ | |
| `release.yml` dry build of all four installers on 8.0.2 (a manual run on the PR branch; never published) | | | | ✓ |

## 6. The kernel A/B

The slicer's golden A/B (`tools/golden_ab.sh`) compares G-code. The slicer does not link OCCT, so the golden A/B says nothing here. Model needs its own A/B.

- **Record.** A debug-only hook in `lime_model_occt::tree` (the JSON entry point every Rust test and the MCP engine call) appends one line per request when `LIME_OCCT_AB=<file>` is set. The line holds a hash of the request and the reply's result: for a solid, faces, edges, volume and bounding box; for a mesh, the triangle count; for a refusal, its text. It writes nothing otherwise and is compiled out of release, as `LIME_OCCT_TEST_HOOKS` is.
- **Run.** The whole `lime-model-occt` test suite, and the MCP `*-occt.test.ts` files of the three OCCT jobs, once on each version from the same commit. O2's dual build makes that possible.
- **Compare.** `tools/occt_ab.py` pairs lines by request hash:
  - a face or edge count that differs is a difference;
  - a volume beyond `Fingerprint::matches`' 1e-6 relative is a difference;
  - a bounding box beyond 1e-6 mm is a difference;
  - a refusal on one side and a solid on the other is a difference;
  - a different triangle count is reported but is not a failure, since 8.0.2 changed the mesher on purpose.
- **Decide.** Each difference is listed in O3's PR with the upstream change that explains it. The owner accepts it (D4), or it becomes a fix before O4.

Only the repo's own tests feed the A/B. No company part data goes into it.

## 7. Where it goes (CLAUDE.md)

The six questions are for features. This is a dependency move at **app level** with no UI, so most do not apply:

| Question | Answer |
|---|---|
| 1. Stage | App level: the kernel under Model, Pose's solids and every export |
| 2. Home | None. No rail tool or menu entry. |
| 3. Command | None. No `COMMANDS` entry and no MCP tool. The version the bridge reports (`occt_version()`, written into each `LIMEBREP` header) reads 8.0.2. |
| 4. When it can't run | Unchanged. A solid that fails to read still says "saved by Open CASCADE X, this modeler has Y" and rebuilds from its history. |
| 5. Word | "Open CASCADE", as now |
| 6. Undo | Nothing to undo. A rollback is reverting O4, a one-line `OCCT_VERSION` change while `install.py` keeps 7.9.2 (D8). |

## 8. Risks

- **Windows crash history.**
  - The access violation in TKBRep (3.1.1, the push with lettering, `kernel_fault.rs`), Delabella's faults (`flat_mesh.rs`) and W1, the Windows brep crash the owner marked solved on 2026-11-27, were all seen on 7.9.2 with MSVC.
  - 8.0 has many fixes in these paths. The crash could be gone, which is good but turns a "refused on Windows" assertion red. Or it could move. New null-edge guards include `BRepExtrema_DistanceSS` (8.0.0p1) and `ChFi3d_Builder::StartSol` (8.0.1).
  - `fault.cpp`'s Windows translator does not change. Its POSIX jump does. O2 must prove the deliberate fault hook on all three systems before anything else runs on 8.0.
- **The exact flat mesher (#881).** It subclasses OCCT's internals, which 8.0 refactored: node registration moved, seam constraints changed. A boundary mismatch would crack a plate. `flat_mesh*.rs`, `mesh_quality.rs` and `plate_normals.rs` are its guard, on Windows too.
- **Geometry drift in old projects.** A 7.9.2 project whose history replays to a different face or edge count on 8.0 is refused at seeding with "The saved solid is not this step…" (`tree.rs:301`). The saved `LIMEBREP` solid itself still reads, because BinTools is unchanged. The A/B measures how often a replay changes. Each case is named in the release notes, and none is silent (memory: clean-over-compat).
- **Bit-for-bit volume.** `integrated_volume` copies OCCT's 7.9.2 face loop to give "the same number to the last bit". If 8.0's `BRepGProp` sums differently, the tests that assert equality go red. That is harmless in use (tolerance 1e-6), but the parallel copy must then follow 8.0's order or the claim must be dropped.
- **RTTI across `dlopen`** on Linux without `-symbolic`: covered by the Linux OCCT jobs in O3.
- **Licence.** LGPL-2.1 with the Open CASCADE exception 1.0 is unchanged, and the texts are identical. The Unicode License V3 notice in `NCollection_UtfIterator.lxx` is new to 8.0.2 and should be carried in `NOTICE.md`. The source offer moves to `V8_0_2` and its SHA-256.
- **Build time and cache.**
  - The 8.0 tree is larger: 8,374 public headers, and new packages built inside TKernel, TKMath and TKG3d.
  - A cold build was not measured. O1 measures it on all three systems against 7.9.2's 25, 35 and 27 minutes. The jobs' 300-minute build timeouts leave room.
  - During O1 to O3, each runner keeps two OCCT caches (about 25 MB each by 7.9.2's size), and the repo is already at 11.4 GB of caches, so older entries are evicted sooner. O4 drops the 7.9.2 keys.
- **CI time during the preview.** Running the three 25-minute MCP OCCT jobs twice on every PR is too much. The preview job runs when `tools/occt/**`, `crates/lime-model-occt/**`, `crates/lime-model/**` or the workflows change, and on manual dispatch (D5).
- **Archive hash.** GitHub source archives are usually stable but not promised. `install.py` already refuses a mismatched hash, so a changed archive fails loudly and does not build something else.

## 9. Open decisions

| # | Question | Recommendation |
|---|---|---|
| D1 | Which 8.0? | **8.0.2**, pinned by tag `V8_0_2` and SHA-256. It is the latest maintenance release and keeps 8.0.1's API and class layouts ([V8_0_2]). Its fixes include fillet, loft, mesh and BREP-read fixes we would otherwise meet. Waiting for 8.1 brings more API churn (#1475 already marks aliases "since 8.1.0"). |
| D2 | One switch day, or a window where the bridge builds on both? | **A window.** O2 to O3 build on both through `occt_compat.h` (four items), so the A/B compares one commit on two kernels. O4 removes it. A flag day saves the shim but loses the A/B. |
| D3 | How far to modernize the C++? | **Only what 8.0.2 warns about** (section 3, about 430 lines), made by our own reviewed search-and-replace. No `occ::handle` rewrite, since `Handle()` does not warn. Upstream's `adm/scripts/migration_800` is a reference for the mapping and is not run on our tree. |
| D4 | Which A/B differences are acceptable? | **Mesh triangle counts and volumes within 1e-6: accepted without asking. Any face or edge count change, volume change, or refusal-to-solid flip: listed in O3 with the upstream reason for the owner.** A solid that becomes a refusal blocks O4. |
| D5 | Where the 8.0 preview runs | **A separate non-required job,** run on OCCT-related paths and by hand. It does not join the required "test, clippy, and Tauri" gate until O4 makes 8.0.2 the default. |
| D6 | `kernel_fault.rs`'s 3.1.1 case expects a refusal on Windows. On 8.0 it may build. | **Accept a valid solid or one of the refusals on every system,** since the crash was 7.9.2's. Keep the deliberate fault hook test unchanged: that is the guard. |
| D7 | Carry the Unicode License V3 notice? | **Yes,** in `third_party/occt/NOTICE.md` with O4. It costs a paragraph and covers object code built from that header. |
| D8 | When to drop 7.9.2 | **In O4's PR for the workflows, but keep the 7.9.2 row of `install.py` until the release after the switch has shipped,** so a rollback is one line. Remove it in the next cleanup. |
| D9 | Release vehicle | **A minor version (7.8.0),** with the kernel move and every accepted geometry change in the notes. The owner tags as usual. |

## 10. Constraints

- **No silenced warnings.** No `-isystem`, no `-Wno-*`, no `#pragma` to hide a diagnostic, in build.rs or the sources. The macOS check counts warnings, and its rules are written in the workflow.
- **No company data.** Fixtures and A/B inputs come from the repo's tests only.
- **No profile paths** in repo files. Local OCCT is a folder outside the profile, named in a memory note or the setup doc only as an example.
- **`CARGO_BUILD_JOBS=4`** for every local cargo run. **The owner's MCP config is not touched:** the installed MCP moves to 8.0.2 when the owner installs the 7.8.0 release.
- **Licence.** Lime stays MIT. OCCT stays shared libraries, replaceable, with its notices beside them. No OCCT source is modified.
