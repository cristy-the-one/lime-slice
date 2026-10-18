import { SCREWS } from "../model-hole";
import { SPLIT_TILT_MAX_DEG } from "../model-plane";
import { PRIMITIVES } from "../model-primitive";

export function mountMarkup(root: HTMLElement) {
  root.innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand">Lime <span>Slice</span></div>
      <div class="project-title" id="projectTitle">Untitled</div>
      <details class="menu" id="fileMenu">
        <summary class="btn ghost" aria-label="File menu">File<span class="caret" aria-hidden="true"></span></summary>
        <nav>
          <button type="button" data-file-action="new" data-key="Ctrl N">New project</button>
          <button type="button" data-file-action="open" data-key="Ctrl O">Open…</button>
          <button type="button" data-file-action="save" data-key="Ctrl S">Save project</button>
          <details class="menu submenu" id="samples">
            <summary>Samples<span class="caret right" aria-hidden="true"></span></summary>
            <nav>
              <button type="button" data-sample="calibration_cube_20mm.stl">20 mm cube</button>
              <button type="button" data-sample="lime_hull.stl">60 mm hull</button>
              <button type="button" data-sample="calibration_cube_20mm.3mf">Cube 3MF</button>
              <button type="button" data-sample="step_cube.step">STEP cube</button>
              <button type="button" data-sample="overhang_ledge.stl">Overhang</button>
              <button type="button" data-sample="slope_ramp.stl">Slope</button>
              <button type="button" data-sample="thin_fin.stl">Thin wall</button>
              <button type="button" data-sample="bridge_span.stl">Bridge</button>
              <button type="button" data-sample="arc_post.stl">Arc post</button>
            </nav>
          </details>
          <button type="button" id="export3mf">Export 3MF</button>
          <hr />
          <button type="button" id="calibrateOpen">Calibrate…</button>
          <button type="button" id="machineOpen">Printers and filaments…</button>
        </nav>
      </details>
      <input id="file" type="file" accept=".stl,.3mf,.step,.stp,.lime,.STL,.3MF,.STEP,.STP,.LIME" hidden />
      <input id="plateAddFile" type="file" accept=".stl,.3mf,.step,.stp,.STL,.3MF,.STEP,.STP" hidden />
      <input id="projectFile" type="file" accept=".lime,application/json" hidden />
      <details class="menu" id="printerChip">
        <summary class="btn chip" aria-label="Printer, filament and nozzle" data-tip="Printer, filament and nozzle"><span id="printerChipLabel"></span><span class="caret" aria-hidden="true"></span></summary>
        <div class="popover" id="printerPick"></div>
      </details>
      <div class="modes title-tabs" role="tablist" aria-label="Workspace">
        <button class="btn mode tab" id="tabPrepare" type="button" role="tab" data-tab="prepare" aria-label="Prepare" aria-selected="false" aria-pressed="false" aria-controls="prepareBody" data-key="1">Prepare</button>
        <button class="btn mode tab on" id="tabPreview" type="button" role="tab" data-tab="preview" aria-label="Preview" aria-selected="true" aria-pressed="true" aria-controls="previewBody" data-key="2">Preview</button>
        <button class="btn mode tab" id="tabGcode" type="button" role="tab" data-tab="gcode" aria-label="G-code" aria-selected="false" aria-pressed="false" aria-controls="gcodePane" data-key="3">G-code</button>
        <button class="btn mode tab" id="tabModel" type="button" role="tab" data-tab="model" aria-label="Model" aria-selected="false" aria-pressed="false" aria-controls="modelBody" data-key="4">Model</button>
      </div>
      <button class="btn panel-toggle" id="toggleLeft" type="button">Settings</button>
      <button class="btn panel-toggle" id="toggleRight" type="button">Results</button>
      <div class="estimate-slot"><button class="estimate" id="timing" type="button" data-tip="Show the results panel"></button></div>
      <div class="action-row">
        <button class="btn" id="cancel" type="button" hidden>Cancel</button>
        <button class="btn" id="sendPrinter" type="button" hidden disabled>Send</button>
        <div class="split" id="sliceSplit">
          <button class="btn primary" id="slice" type="button" data-slice-action="none">Slice</button>
          <details class="menu split-more" id="sliceMore">
            <summary class="btn primary" aria-label="Slice options" data-tip="More slice actions"><span class="caret" aria-hidden="true"></span></summary>
            <nav><button type="button" id="force" hidden>Force re-slice</button></nav>
          </details>
        </div>
        <button class="btn" id="export" type="button" disabled aria-label="Export G-code">Export</button>
      </div>
      <div class="gear-items" hidden>
        <label class="theme-field">Theme
          <select id="theme" aria-label="Theme">
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label class="row setting" data-label="auto-slice when a slice takes under 20 s" data-tip="Slice again by itself after a change, while the last slice took under 20 seconds."><span class="row-label">Auto-slice when a slice takes under 20 s</span><input id="autoslice" type="checkbox" class="switch" role="switch" /></label>
      </div>
    </header>
    <div class="banner-rail" id="banner"></div>
    <div class="workspace">
      <aside class="panel" id="left"><div id="leftBody"></div></aside>
      <section class="stage mode-solid" id="stage">
        <div class="viewbar">
          <div class="modes" id="viewModes">
            <button class="btn mode" type="button" data-mode="flat" aria-pressed="false">2D</button>
            <button class="btn mode" type="button" data-mode="split" aria-pressed="false">Split</button>
            <button class="btn mode" type="button" data-mode="solid" aria-pressed="true">3D</button>
          </div>
          <label class="view-inline">Color
            <select id="colorBy" aria-label="Color by">
              <option value="feature">Feature</option>
              <option value="weight">Blend weight</option>
              <option value="speed">Speed</option>
            </select>
          </label>
          <label class="view-inline" data-tip="Build plate opacity. 0 hides the plate. Does not change the slice.">
            Bed
            <input id="bedOpacity" type="range" min="0" max="100" value="40" aria-label="Bed opacity" />
          </label>
          <label class="view-toggle" id="measureField" data-tip="Sizes: the part's length, width and height, a scale bar, and numbers along the bed. The scale bar is measured at the view centre.">
            <input id="measureOn" type="checkbox" aria-label="Measure" checked /><span class="view-toggle-face">Measure</span>
          </label>
          <label class="view-toggle" id="sectionField" data-tip="Section: clip the preview on the arrow side of a free plane. Offset slides the plane, the rings aim it, and the axis keeps it square to the bed. Does not change the slice.">
            <input id="sectionOn" type="checkbox" aria-label="Section" /><span class="view-toggle-face">Section</span>
          </label>
          <label class="view-inline" id="sectionAxisField" hidden data-tip="Align the section plane with a bed axis. Custom means the rings have tilted it.">
            Axis
            <select id="sectionAxis" aria-label="Section axis">
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z">Z</option>
              <option value="custom" disabled>Custom</option>
            </select>
          </label>
          <label class="view-inline" id="sectionOffsetField" hidden data-tip="Distance from the part center along the section normal, in millimetres.">
            <span class="scrub-label" data-scrub="field">Offset mm</span>
            <input id="sectionOffset" type="number" min="-100" max="100" step="0.1" value="0" aria-label="Section offset" />
          </label>
          <button class="btn" id="sectionFlip" type="button" hidden data-tip="Hide the other side of the section plane">Flip</button>
        </div>
        <div class="stage-body" id="prepareBody" role="tabpanel" aria-labelledby="tabPrepare" hidden>
          <canvas id="prepare" aria-label="Model on the build plate"></canvas>
          <div class="gizmo-readout" id="gizmoReadout" hidden></div>
        </div>
        <div class="stage-body" id="modelBody" role="tabpanel" aria-labelledby="tabModel" hidden>
          <canvas id="model" aria-label="Solid faces and edges"></canvas>
          <div class="model-bar" id="modelBar">
            <div class="model-top">
              <div class="model-tools" role="toolbar" aria-label="Model">
                <button class="model-tool" id="modelToolNew" type="button" data-tool="create" aria-pressed="false" data-tip="Start a new solid from a box, cylinder, cone, or another primitive">New solid</button>
                <span class="model-sep"></span>
                <div class="modes" role="group" aria-label="Pick">
                  <button class="btn mode on" id="modelPickFace" type="button" aria-pressed="true" data-tip="Pick faces. Shift-click adds or removes.">Face</button>
                  <button class="btn mode" id="modelPickEdge" type="button" aria-pressed="false" data-tip="Pick edges. Shift-click adds or removes.">Edge</button>
                </div>
                <span class="model-count" id="modelCount" hidden></span>
                <div class="model-edit" id="modelEdit" hidden>
                  <span class="model-sep"></span>
                  <!-- P1: Push/Pull. P. Also the gesture when no other model tool is open. -->
                  <button class="model-tool" id="modelToolPull" type="button" data-tool="pushpull" aria-pressed="false" data-tip="Push or pull a face. Hold Alt to add or remove material on that face only">Push/Pull</button>
                  <button class="model-tool" id="modelToolBoolean" type="button" data-tool="boolean" aria-pressed="false" data-tip="Fuse, cut, or intersect a primitive or another object on the plate">Boolean</button>
                  <button class="model-tool" id="modelToolSplit" type="button" data-tool="split" aria-pressed="false" data-tip="Split along X, Y, Z, or a picked flat face, and tilt the plane">Split</button>
                  <button class="model-tool" id="modelToolFillet" type="button" data-tool="fillet" aria-pressed="false" data-tip="Round every selected edge in one step">Fillet</button>
                  <button class="model-tool" id="modelToolChamfer" type="button" data-tool="chamfer" aria-pressed="false" data-tip="Chamfer every selected edge in one step">Chamfer</button>
                  <button class="model-tool" id="modelToolHole" type="button" data-tool="hole" aria-pressed="false" data-tip="Cut a cylinder into the picked face, or straight down">Hole</button>
                  <!-- A2 shell -->
                  <button class="model-tool" id="modelToolShell" type="button" data-tool="shell" aria-pressed="false" data-tip="Hollow the solid to a wall thickness, with picked faces open">Shell</button>
                  <button class="model-tool" id="modelToolScale" type="button" data-tool="scale" aria-pressed="false" data-tip="Scale the solid about its centre">Scale</button>
                  <button class="model-tool" id="modelToolMeasure" type="button" data-tool="measure" aria-pressed="false" data-tip="Drag two points on the solid and read the distance">Measure</button>
                  <button class="model-tool" id="modelToolPlace" type="button" data-tool="place" aria-pressed="false" data-tip="Move and turn this object among the others. The plate stays as it is">Place</button>
                  <button class="model-tool" id="modelToolWorkplane" type="button" data-tool="workplane" aria-pressed="false" data-tip="Set the U, V, W frame Hole, Boolean, and Split are typed in">Workplane</button>
                  <span class="model-sep"></span>
                  <button class="model-tool is-icon" id="modelStep" type="button" data-tip="Write this solid as AP214 STEP">STEP</button>
                  <button class="model-tool is-icon" id="modelUndo" type="button" disabled data-tip="Undo the last solid edit">Undo</button>
                  <button class="model-tool is-icon" id="modelRedo" type="button" disabled data-tip="Redo the last solid edit">Redo</button>
                  <button class="model-tool" id="modelHistoryOpen" type="button" aria-controls="modelHistory" aria-expanded="false">History</button>
                </div>
                <span class="model-sep"></span>
                <!-- --- A7 model check --- stays outside #modelEdit, so a mesh can be checked too -->
                <button class="model-tool" id="modelToolCheck" type="button" data-tool="check" aria-pressed="false" data-tip="Overhangs, ceilings, islands, thin walls, and whether it fits the build volume">Check</button>
                <button class="model-tool is-icon" id="modelBedToggle" type="button" aria-pressed="true" data-tip="Show the bed and build volume for size">Bed</button>
              </div>
              <span class="model-paused" id="modelPaused">Slicing paused while modeling</span>
            </div>
            <div class="model-empty" id="modelEmpty" hidden>
              <p class="model-empty-title" id="modelEmptyTitle">No solid open</p>
              <p class="model-empty-text" id="modelEmptyText">Start a solid from a primitive, or open a STEP file.</p>
              <div class="model-empty-actions">
                <button class="btn primary" id="modelEmptyNew" type="button">New solid</button>
                <button class="btn" id="modelEmptyOpen" type="button">Open a file</button>
              </div>
            </div>
            <div class="model-side">
              <div class="model-panel" id="modelPanel" hidden>
                <h2 class="model-edit-head" id="modelEditHead" hidden></h2>
                <div class="modes model-plane-modes" id="modelWpModes" data-for="workplane" role="group" aria-label="Workplane">
                  <button class="btn mode on" id="modelWpGlobal" type="button" data-wp="global" aria-pressed="true" data-tip="Model space: U is X, V is Y, W is Z">Global</button>
                  <button class="btn mode" id="modelWpBed" type="button" data-wp="bed" aria-pressed="false" data-tip="Under the middle of the part, W up">Bed</button>
                  <button class="btn mode" id="modelWpFace" type="button" data-wp="face" aria-pressed="false" data-tip="On a picked flat face, W out of it">Face</button>
                </div>
                <div class="modes model-plane-modes" id="modelPlaneModes" data-for="split" role="group" aria-label="Plane">
                  <button class="btn mode" id="modelSplitX" type="button" data-plane="x" aria-pressed="false" data-tip="Cut square to X">X</button>
                  <button class="btn mode" id="modelSplitY" type="button" data-plane="y" aria-pressed="false" data-tip="Cut square to Y">Y</button>
                  <button class="btn mode on" id="modelSplitZ" type="button" data-plane="z" aria-pressed="true" data-tip="Cut square to Z">Z</button>
                  <button class="btn mode" id="modelSplitFace" type="button" data-plane="face" aria-pressed="false" data-tip="Cut parallel to a picked flat face">Face</button>
                </div>
                <div class="model-prims" id="modelPrim" data-for="boolean create" role="radiogroup" aria-label="Primitive">${PRIMITIVES.map(
                  (entry, i) => `<button class="model-prim" type="button" role="radio" data-kind="${entry.kind}" aria-label="${entry.label}" data-tip="${entry.label}" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${entry.label}</button>`,
                ).join("")}<button class="model-prim" id="modelWithObject" type="button" role="radio" data-kind="object" data-for="boolean" aria-label="Another object" data-tip="Another object on the plate: a split piece, an import, or a new solid" aria-checked="false" tabindex="-1">Object</button></div>
                <div class="model-objects" id="modelObjects" data-for="boolean" data-with="object" role="radiogroup" aria-label="Tool object"></div>
                <div class="model-fields">
                  <label data-for="boolean create" data-with="primitive" data-prim="box wedge ellipsoid" data-snap="1"><span class="scrub-label" data-scrub>Size X</span><input id="modelDx" type="number" step="0.1" value="10" aria-label="Size x"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="box wedge ellipsoid" data-snap="1"><span class="scrub-label" data-scrub>Size Y</span><input id="modelDy" type="number" step="0.1" value="10" aria-label="Size y"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="box wedge ellipsoid" data-snap="1"><span class="scrub-label" data-scrub>Size Z</span><input id="modelDz" type="number" step="0.1" value="10" aria-label="Size z"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="wedge" data-snap="1"><span class="scrub-label" data-scrub>Top X</span><input id="modelTopX" type="number" step="0.1" min="0" value="3" aria-label="Top face length along x"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="cylinder sphere cone torus tube" data-snap="1"><span class="scrub-label" id="modelRadiusLabel" data-scrub>Radius</span><input id="modelRadius" type="number" step="0.1" min="0" value="5" aria-label="Radius"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="cone" data-snap="1"><span class="scrub-label" data-scrub>Top radius</span><input id="modelTopR" type="number" step="0.1" min="0" value="2" aria-label="Top radius"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="torus" data-snap="1"><span class="scrub-label" data-scrub>Tube radius</span><input id="modelTube" type="number" step="0.1" min="0" value="1.5" aria-label="Tube radius"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="tube" data-snap="1"><span class="scrub-label" data-scrub>Inner radius</span><input id="modelInnerR" type="number" step="0.1" min="0" value="3" aria-label="Inner radius"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="polygon" data-snap="1"><span class="scrub-label" data-scrub>Sides</span><input id="modelSides" type="number" step="1" min="3" max="64" value="6" data-whole aria-label="Sides"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="polygon" data-snap="1"><span class="scrub-label" id="modelAcrossLabel" data-scrub>Across flats</span><input id="modelAcross" type="number" step="0.1" min="0" value="10" aria-label="Width across flats"></label>
                  <label data-for="boolean create" data-with="primitive" data-prim="cylinder cone polygon tube" data-snap="1"><span class="scrub-label" data-scrub>Height</span><input id="modelHeight" type="number" step="0.1" min="0" value="10" aria-label="Height"></label>
                  <label data-for="boolean hole" data-with="primitive" data-snap="1"><span class="scrub-label" data-scrub>X</span><input id="modelX" type="number" step="0.1" value="10" aria-label="Origin x"></label>
                  <label data-for="boolean hole" data-with="primitive" data-snap="1"><span class="scrub-label" data-scrub>Y</span><input id="modelY" type="number" step="0.1" value="0" aria-label="Origin y"></label>
                  <label data-for="boolean hole" data-with="primitive" data-snap="1"><span class="scrub-label" data-scrub>Z</span><input id="modelZ" type="number" step="0.1" value="0" aria-label="Origin z"></label>
                  <label data-for="boolean" data-with="primitive" data-prim="box ellipsoid cylinder cone torus wedge polygon tube" data-snap="15"><span class="scrub-label" data-scrub>Turn X</span><input id="modelRx" type="number" step="1" value="0" aria-label="Turn about x, degrees"></label>
                  <label data-for="boolean" data-with="primitive" data-prim="box ellipsoid cylinder cone torus wedge polygon tube" data-snap="15"><span class="scrub-label" data-scrub>Turn Y</span><input id="modelRy" type="number" step="1" value="0" aria-label="Turn about y, degrees"></label>
                  <label data-for="boolean" data-with="primitive" data-prim="box ellipsoid cylinder cone torus wedge polygon tube" data-snap="15"><span class="scrub-label" data-scrub>Turn Z</span><input id="modelRz" type="number" step="1" value="0" aria-label="Turn about z, degrees"></label>
                  <label data-for="split" data-snap="1"><span class="scrub-label" id="modelPlaneLabel" data-scrub>Plane Z</span><input id="modelPlane" type="number" step="any" value="5" aria-label="Split plane Z, mm"></label>
                  <label data-for="split" data-snap="15"><span class="scrub-label" data-scrub>Tilt A°</span><input id="modelTiltA" type="number" step="1" min="-${SPLIT_TILT_MAX_DEG}" max="${SPLIT_TILT_MAX_DEG}" value="0" aria-label="Tilt A, degrees"></label>
                  <label data-for="split" data-snap="15"><span class="scrub-label" data-scrub>Tilt B°</span><input id="modelTiltB" type="number" step="1" min="-${SPLIT_TILT_MAX_DEG}" max="${SPLIT_TILT_MAX_DEG}" value="0" aria-label="Tilt B, degrees"></label>
                  <label data-for="fillet chamfer" data-snap="1"><span class="scrub-label" data-scrub>Size</span><input id="modelBlend" type="number" step="0.1" min="0" value="1" aria-label="Fillet or chamfer size"></label>
                  <!-- P1: the distance, typed. A drag writes the same field. -->
                  <label data-for="pushpull" data-snap="1"><span class="scrub-label" data-scrub>Distance</span><input id="modelPull" type="number" step="0.1" value="0" aria-label="Push or pull distance, mm"></label>
                  <label data-for="hole" data-snap="1"><span class="scrub-label" data-scrub>Radius</span><input id="modelHoleR" type="number" step="0.1" min="0" value="2" aria-label="Hole radius"></label>
                  <label data-for="hole" data-snap="1"><span class="scrub-label" data-scrub>Depth</span><input id="modelHoleD" type="number" step="0.1" min="0" value="12" aria-label="Hole depth"></label>
                  <label data-for="hole"><span class="scrub-label">Screw</span><select id="modelScrew" aria-label="Screw size: a clearance hole through, counterbored for a socket head" data-tip="A clearance hole through, counterbored for a socket head cap screw"><option value="" disabled>Custom</option>${SCREWS.map((screw) => `<option value="${screw.name}">${screw.name}</option>`).join("")}</select></label>
                  <label data-for="hole" data-bore data-snap="1"><span class="scrub-label" data-scrub>Bore radius</span><input id="modelBoreR" type="number" step="0.1" min="0" value="4" aria-label="Counterbore radius"></label>
                  <label data-for="hole" data-bore data-snap="1"><span class="scrub-label" data-scrub>Bore depth</span><input id="modelBoreD" type="number" step="0.1" min="0" value="3" aria-label="Counterbore depth"></label>
                  <!-- A2 shell -->
                  <label data-for="shell" data-snap="1"><span class="scrub-label" data-scrub>Thickness</span><input id="modelShell" type="number" step="0.1" min="0.05" value="1" aria-label="Wall thickness"></label>
                  <label data-for="scale" data-snap="0.5"><span class="scrub-label" data-scrub>Factor</span><input id="modelFactor" type="number" step="0.1" min="0.1" max="20" value="2" aria-label="Uniform scale"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>A X</span><input id="modelAx" type="number" step="0.1" value="0" aria-label="Point A x"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>A Y</span><input id="modelAy" type="number" step="0.1" value="0" aria-label="Point A y"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>A Z</span><input id="modelAz" type="number" step="0.1" value="0" aria-label="Point A z"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>B X</span><input id="modelBx" type="number" step="0.1" value="0" aria-label="Point B x"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>B Y</span><input id="modelBy" type="number" step="0.1" value="0" aria-label="Point B y"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>B Z</span><input id="modelBz" type="number" step="0.1" value="0" aria-label="Point B z"></label>
                  <label data-for="place" data-snap="1"><span class="scrub-label" data-scrub>X</span><input id="modelPlaceX" type="number" step="0.1" value="0" aria-label="Move in model space x"></label>
                  <label data-for="place" data-snap="1"><span class="scrub-label" data-scrub>Y</span><input id="modelPlaceY" type="number" step="0.1" value="0" aria-label="Move in model space y"></label>
                  <label data-for="place" data-snap="1"><span class="scrub-label" data-scrub>Z</span><input id="modelPlaceZ" type="number" step="0.1" value="0" aria-label="Move in model space z"></label>
                  <label data-for="place" data-snap="15"><span class="scrub-label" data-scrub>Turn X</span><input id="modelPlaceRx" type="number" step="1" value="0" aria-label="Turn in model space about x, degrees"></label>
                  <label data-for="place" data-snap="15"><span class="scrub-label" data-scrub>Turn Y</span><input id="modelPlaceRy" type="number" step="1" value="0" aria-label="Turn in model space about y, degrees"></label>
                  <label data-for="place" data-snap="15"><span class="scrub-label" data-scrub>Turn Z</span><input id="modelPlaceRz" type="number" step="1" value="0" aria-label="Turn in model space about z, degrees"></label>
                  <label data-for="workplane" data-snap="1"><span class="scrub-label" data-scrub>X</span><input id="modelWpX" type="number" step="0.1" value="0" aria-label="Workplane origin, model x"></label>
                  <label data-for="workplane" data-snap="1"><span class="scrub-label" data-scrub>Y</span><input id="modelWpY" type="number" step="0.1" value="0" aria-label="Workplane origin, model y"></label>
                  <label data-for="workplane" data-snap="1"><span class="scrub-label" data-scrub>Z</span><input id="modelWpZ" type="number" step="0.1" value="0" aria-label="Workplane origin, model z"></label>
                  <label data-for="workplane" data-snap="15"><span class="scrub-label" data-scrub>Turn X</span><input id="modelWpRx" type="number" step="1" value="0" aria-label="Turn the workplane about model x, degrees"></label>
                  <label data-for="workplane" data-snap="15"><span class="scrub-label" data-scrub>Turn Y</span><input id="modelWpRy" type="number" step="1" value="0" aria-label="Turn the workplane about model y, degrees"></label>
                  <label data-for="workplane" data-snap="15"><span class="scrub-label" data-scrub>Turn Z</span><input id="modelWpRz" type="number" step="1" value="0" aria-label="Turn the workplane about model z, degrees"></label>
                  <!-- --- A7 model check --- -->
                  <label data-for="check" data-snap="0.05"><span class="scrub-label" data-scrub>Thin wall</span><input id="modelThin" type="number" step="0.05" min="0.05" max="20" value="0.8" aria-label="Thin wall, mm"></label>
                </div>
                <div class="model-check-list" id="modelCheckList" data-for="check" role="list" aria-label="Check"></div>
                <div class="modes" id="modelAcrossModes" data-for="boolean create" data-with="primitive" data-prim="polygon" role="group" aria-label="Width across">
                  <button class="btn mode" id="modelCorners" type="button" aria-pressed="false" data-tip="Size the polygon from corner to corner">Corners</button>
                  <button class="btn mode on" id="modelFlats" type="button" aria-pressed="true" data-tip="Size the polygon from flat to flat, as a nut is sized">Flats</button>
                </div>
                <div class="modes" data-for="boolean" role="group" aria-label="Boolean">
                  <button class="btn mode on" id="modelFuse" type="button" aria-pressed="true">Fuse</button>
                  <button class="btn mode" id="modelCut" type="button" aria-pressed="false">Cut</button>
                  <button class="btn mode" id="modelCommon" type="button" aria-pressed="false">Common</button>
                </div>
                <label class="model-keep" data-for="boolean" data-with="object"><input id="modelKeepTool" type="checkbox"> Keep the tool object</label>
                <div class="model-hole-opts" data-for="hole">
                  <label class="model-keep"><input id="modelThrough" type="checkbox"> Through all</label>
                  <label class="model-keep"><input id="modelCounterbore" type="checkbox"> Counterbore</label>
                </div>
                <!-- A2 shell -->
                <p class="model-note" id="modelShellFaces" data-for="shell"></p>
                <label class="model-keep" data-for="shell"><input id="modelShellClosed" type="checkbox"> Keep it closed (hollow inside)</label>
                <p class="model-note" id="modelNote" hidden></p>
                <div class="model-actions">
                  <button class="btn model-actions-lead" id="modelWpPrint" type="button" data-for="workplane" data-tip="Turn the part on the plate so W points up and U runs along X. Undo takes it back">Print with W up</button>
                  <button class="btn" id="modelCancel" type="button">Cancel</button>
                  <button class="btn primary" id="modelApply" type="button">Apply</button>
                </div>
              </div>
              <section class="model-history" id="modelHistory" aria-label="History" hidden>
                <button class="model-history-toggle" id="modelHistoryToggle" type="button" aria-controls="modelHistoryTree" aria-expanded="true"><span>History</span> <span class="model-history-count" id="modelHistoryCount"></span></button>
                <div class="mh-position" id="modelPosition" role="group" aria-label="Position">
                  <button class="mh-position-open" id="modelPositionOpen" type="button" data-tip="Where this object sits in model space. Click to open Place."><span class="mh-position-name">Position</span><span class="mh-position-text" id="modelPositionText"></span></button>
                  <button class="mh-position-reset" id="modelPositionReset" type="button" aria-label="Reset position" data-tip="Back to where its file put it" hidden></button>
                </div>
                <div class="model-history-tree" id="modelHistoryTree" role="tree" aria-label="Model history"></div>
              </section>
              <div class="model-foot" id="modelFoot">
                <div class="model-foot-row">
                  <button class="model-view-reset" id="modelResetView" type="button" aria-label="Reset view" data-tip="Reset view. Shift: every object"></button>
                  <div id="modelReadout" class="model-readout"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="stage-body" id="previewBody" role="tabpanel" aria-labelledby="tabPreview">
          <div class="stale-chip" id="staleChip" role="status" hidden>
            <span id="staleChipText"></span>
            <button class="btn" id="staleReslice" type="button" data-tip="Slice again (Ctrl+Enter)" hidden>Re-slice</button>
          </div>
          <div class="vslider" id="vslider">
            <div class="readout" id="readHigh"></div>
            <button class="layer-step" id="layerNext" type="button" aria-label="Next layer" disabled></button>
            <div class="track">
              <div class="range-bands" id="rangeBands"></div>
              <div class="layer-pins" id="layerPins"></div>
              <div class="band" id="layerBand" hidden></div>
              <button class="layer-action" id="layerAction" type="button" hidden aria-label="Pause at this layer">+</button>
              <input id="rangeLow" type="range" min="0" max="0" value="0" aria-label="Lowest visible layer" />
              <input id="rangeHigh" type="range" min="0" max="0" value="0" aria-label="Current layer" />
            </div>
            <button class="layer-step" id="layerPrev" type="button" aria-label="Previous layer" disabled></button>
            <div class="readout" id="readLow"></div>
          </div>
          <div class="previews">
            <div class="pane" id="pane2d">
              <canvas id="view" aria-label="2D toolpath"></canvas>
              <div class="flat-tools" id="flatTools">
                <button class="flat-tool" id="flatZoomOut" type="button" aria-label="Zoom out" disabled></button>
                <button class="flat-tool" id="flatFit" type="button" aria-label="Fit layer" disabled>Fit</button>
                <button class="flat-tool" id="flatZoomIn" type="button" aria-label="Zoom in" disabled></button>
              </div>
            </div>
            <div class="pane" id="pane3d">
              <div class="viewport-bands" id="viewportBands" hidden></div>
              <canvas id="view3d" aria-label="3D toolpath"></canvas>
              <div class="section-readout" id="sectionReadout" hidden></div>
            </div>
          </div>
        </div>
        <div class="gcode-pane" id="gcodePane" role="tabpanel" aria-labelledby="tabGcode" tabindex="-1" hidden></div>
        <div class="stage-tools">
          <div class="spark-wrap">
            <div class="spark-label" id="sparkLabel"><span>Layer time</span><span class="spark-key"><span><i style="background:var(--slow)"></i>slow</span><span><i style="background:var(--fast)"></i>too fast</span></span></div>
            <canvas id="spark" aria-label="Per-layer time"></canvas>
          </div>
          <div class="playback">
            <button class="btn" id="play" type="button" disabled aria-label="Play layer">Play</button>
            <input id="move" type="range" min="0" max="0" value="0" aria-label="Toolpath playback" />
            <div class="play-readout" id="playReadout"></div>
          </div>
        </div>
        <div class="legend" id="legend"></div>
      </section>
      <aside class="panel right" id="right"></aside>
    </div>
    <footer class="status"><div id="sliceMeter" class="slice-meter" hidden></div><div id="engineLink" class="engine-link" data-state="pending">Engine …</div></footer>
  </div>
  <div id="calibrate" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="calibrateTitle">
    <div class="sheet-card cal-card">
      <div class="sheet-head"><h2 id="calibrateTitle">Calibrate</h2><button class="btn" id="calibrateClose" type="button">Close</button></div>
      <div id="calibrateBody" class="cal-grid"></div>
    </div>
  </div>
  <div id="unsaved" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="unsavedTitle">
    <div class="sheet-card unsaved-card">
      <h2 id="unsavedTitle">Save this project?</h2>
      <p>This project has unsaved changes.</p>
      <div class="unsaved-actions">
        <button class="btn primary" type="button" data-unsaved="save">Save</button>
        <button class="btn" type="button" data-unsaved="discard">Don't save</button>
        <button class="btn" type="button" data-unsaved="cancel">Cancel</button>
      </div>
    </div>
  </div>
  <div id="help" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="helpTitle">
    <div class="sheet-card">
      <h2 id="helpTitle">Shortcuts</h2>
      <div id="helpShortcuts" class="help-body"></div>
      <button class="btn" id="helpClose" type="button">Close</button>
    </div>
  </div>
`;
}
