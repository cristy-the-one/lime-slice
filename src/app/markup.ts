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
      <div class="estimate-slot"><button class="estimate" id="timing" type="button" aria-controls="rightDock" aria-expanded="false" data-tip="Results panel"></button></div>
      <div class="action-row">
        <button class="btn" id="cancel" type="button" hidden>Cancel</button>
        <button class="btn" id="sendPrinter" type="button" hidden disabled>Send</button>
        <div class="split" id="sliceSplit">
          <span id="slicePauseDot" class="slice-pause-dot" hidden data-tip="Slicing waits until you leave Model, then slices once"></span>
          <button class="btn primary" id="slice" type="button" data-slice-action="none">Slice</button>
          <details class="menu split-more" id="sliceMore">
            <summary class="btn primary" aria-label="Slice options" data-tip="More slice actions"><span class="caret" aria-hidden="true"></span></summary>
            <nav><button type="button" id="force" hidden>Force re-slice</button></nav>
          </details>
        </div>
        <button class="btn" id="export" type="button" disabled aria-label="Export G-code" data-tip="Export G-code">Export</button>
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
        <label class="row setting" data-label="show tool labels" data-tip="Widen the tool rail and show each tool's name. Off by default."><span class="row-label">Show tool labels</span><input id="railLabels" type="checkbox" class="switch" role="switch" /></label>
      </div>
    </header>
    <div class="banner-rail" id="banner"></div>
    <div class="workspace">
      <!-- E3. The Model tools: chrome.ts moves this set into the rail. A group folds into one flyout button when the window is too short for it. -->
      <div class="rail-set rail-model" id="railModel" data-for="model" role="group" aria-label="Model tools" data-model-ui>
        <div class="rail-group" data-group="create" role="group" aria-label="Create">
          <span class="rail-caption" aria-hidden="true" title="Create">Make</span>
          <div class="rail-tools">
            <button class="model-tool" id="modelToolNew" type="button" data-tool="create" aria-pressed="false" data-tip="New solid: a box, cylinder, cone, or another primitive">New solid</button>
            <!-- --- S2 sketch --- no data-tool: Sketch is a mode, not a dock handle. S. -->
            <button class="model-tool" id="modelToolSketch" type="button" aria-pressed="false" data-tip="Sketch on a face, an origin plane, or the workplane. The drawing tools are in the sketch card.">Sketch</button>
          </div>
        </div>
        <div class="rail-group" data-group="shape" data-solid-only role="group" aria-label="Shape">
          <div class="rail-sep"></div>
          <span class="rail-caption" aria-hidden="true" title="Shape">Shape</span>
          <div class="rail-tools">
            <!-- P1: Push/Pull. P. Also the gesture when no other model tool is open. -->
            <button class="model-tool" id="modelToolPull" type="button" data-tool="pushpull" aria-pressed="false" data-tip="Push/Pull: move a face. Hold Alt to add or cut material on that face only">Push/Pull</button>
            <button class="model-tool" id="modelToolFillet" type="button" data-tool="fillet" aria-pressed="false" data-tip="Fillet: round every selected edge in one step">Fillet</button>
            <button class="model-tool" id="modelToolChamfer" type="button" data-tool="chamfer" aria-pressed="false" data-tip="Chamfer: bevel every selected edge in one step">Chamfer</button>
            <!-- A2 shell -->
            <button class="model-tool" id="modelToolShell" type="button" data-tool="shell" aria-pressed="false" data-tip="Shell: hollow the solid to a wall thickness, with picked faces open">Shell</button>
            <button class="model-tool" id="modelToolSplit" type="button" data-tool="split" aria-pressed="false" data-tip="Split along X, Y, Z, or a picked flat face, and tilt the plane">Split</button>
            <button class="model-tool" id="modelToolScale" type="button" data-tool="scale" aria-pressed="false" data-tip="Scale solid">Scale</button>
          </div>
        </div>
        <div class="rail-group" data-group="features" data-solid-only role="group" aria-label="Features">
          <div class="rail-sep"></div>
          <span class="rail-caption" aria-hidden="true" title="Features">Feat.</span>
          <div class="rail-tools">
            <button class="model-tool" id="modelToolBoolean" type="button" data-tool="boolean" aria-pressed="false" data-tip="Boolean: fuse, cut, or intersect a primitive or another object on the plate">Boolean</button>
            <button class="model-tool" id="modelToolPattern" type="button" data-tool="pattern" aria-pressed="false" data-tip="Pattern: repeat history steps in a line, around an axis, or along a path">Pattern</button>
            <button class="model-tool" id="modelToolMirror" type="button" data-tool="mirror" aria-pressed="false" data-tip="Mirror: mirror history steps across X, Y, Z, or a picked flat face">Mirror</button>
            <button class="model-tool" id="modelToolHole" type="button" data-tool="hole" aria-pressed="false" data-tip="Hole: cut a cylinder into the picked face, or straight down">Hole</button>
            <!-- A3 composite features: one button, the last used on it, the rest in the menu beside the rail. -->
            <div class="model-feature" id="modelFeature">
              <button class="model-tool" id="modelToolFeatures" type="button" data-tool="pocket" aria-pressed="false" data-tip="Cut a rect, circle, or arch into the picked face">Pocket</button>
              <button class="model-feature-more" id="modelFeatureMore" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="modelFeatureMenu" aria-label="Features" data-tip="Pocket, boss, texture, array, ribs, text, parameters, stress, split to print"></button>
              <div class="model-feature-menu" id="modelFeatureMenu" role="menu" aria-label="Features" hidden>
                <button class="model-tool" type="button" role="menuitem" data-tool="pocket">Pocket</button>
                <button class="model-tool" type="button" role="menuitem" data-tool="boss">Boss</button>
                <button class="model-tool" type="button" role="menuitem" data-tool="texture">Texture</button>
                <button class="model-tool" type="button" role="menuitem" data-tool="array">Array</button>
                <button class="model-tool" type="button" role="menuitem" data-tool="ribs">Ribs</button>
                <button class="model-tool" type="button" role="menuitem" data-tool="text">Text</button>
                <!-- --- A6. Parameters live in the Model dock; this goes to them. --- -->
                <button id="modelMenuParameters" type="button" role="menuitem" data-tip="Open Parameters. Ctrl+Alt+P also opens them when the dock is closed.">Parameters</button>
                <button id="modelMenuStress" type="button" role="menuitem" data-tip="Hold, load, and an in-house estimate. The solid is not edited.">Stress…</button>
                <!-- --- Split to print (D10): a card of its own, not a rail tool. The rail's Split stays one plane. --- -->
                <button id="modelMenuSplitPrint" type="button" role="menuitem" data-tip="Cut a part too large for the printer into pieces that fit, each an object on the plate.">Split to print…</button>
              </div>
            </div>
          </div>
        </div>
        <div class="rail-group" data-group="inspect" role="group" aria-label="Inspect">
          <div class="rail-sep"></div>
          <span class="rail-caption" aria-hidden="true" title="Inspect">Check</span>
          <div class="rail-tools">
            <button class="model-tool" id="modelToolMeasure" type="button" data-tool="measure" data-solid-only aria-pressed="false" data-tip="Measure: drag two points on the solid and read the distance">Measure</button>
            <!-- --- A7 model check --- also for a mesh, so not solid-only. -->
            <button class="model-tool" id="modelToolCheck" type="button" data-tool="check" aria-pressed="false" data-tip="Check: overhangs, ceilings, islands, thin walls, and whether it fits the build volume">Check</button>
            <!-- --- A10. View: section, colour by step, the bed, the sizes. --- -->
            <button class="model-look-open" id="modelLookOpen" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="modelLookPanel" data-tip="View: section, colour by step, the bed">View</button>
          </div>
        </div>
        <div class="rail-group" data-group="frame" data-solid-only role="group" aria-label="Frame">
          <div class="rail-sep"></div>
          <span class="rail-caption" aria-hidden="true" title="Frame">Frame</span>
          <div class="rail-tools">
            <button class="model-tool" id="modelToolPlace" type="button" data-tool="place" aria-pressed="false" data-tip="Place: move and turn this object among the others. The plate stays as it is">Place</button>
            <button class="model-tool" id="modelToolWorkplane" type="button" data-tool="workplane" aria-pressed="false" data-tip="Workplane: the U, V, W frame Hole, Boolean, and Split are typed in">Workplane</button>
          </div>
        </div>
        <!-- The phone's History sheet. The desktop shows History in the Model dock. -->
        <button class="model-tool" id="modelHistoryOpen" type="button" data-solid-only aria-controls="modelHistory" aria-expanded="false" data-tip="History">History</button>
      </div>
      <!-- The rail foot's Model buttons: chrome.ts moves them above the dock toggle. -->
      <div class="rail-set rail-model-foot" id="railModelFoot" data-for="model" role="group" aria-label="Model history and export" data-model-ui>
        <div class="rail-group" data-group="edit" role="group" aria-label="Edit">
          <span class="rail-caption" aria-hidden="true" title="Edit">Edit</span>
        </div>
        <button class="model-tool" id="modelUndo" type="button" data-solid-only disabled data-tip="Undo the last solid edit">Undo</button>
        <button class="model-tool" id="modelRedo" type="button" data-solid-only disabled data-tip="Redo the last solid edit">Redo</button>
        <button class="model-tool" id="modelStep" type="button" data-solid-only data-tip="Export this solid as a STEP file">STEP</button>
        <div class="rail-sep"></div>
      </div>
      <div class="rail-fly model-look-panel" id="modelLookPanel" role="dialog" aria-label="View" data-model-ui hidden>
        <h3>View</h3>
        <button class="btn model-look-toggle" id="modelResetView" type="button" data-tip="Reset view. Shift: every object">Reset view</button>
        <label class="model-keep"><input id="modelSection" type="checkbox"> Section</label>
        <div class="model-look-axis" id="modelSectionAxis" role="group" aria-label="Section plane">
          <button type="button" data-axis="x" aria-pressed="false">X</button>
          <button type="button" data-axis="y" aria-pressed="false">Y</button>
          <button type="button" data-axis="z" aria-pressed="true">Z</button>
          <button type="button" data-axis="face" aria-pressed="false">Face</button>
        </div>
        <label class="model-look-offset">Offset <input id="modelSectionOffset" type="number" step="0.1" value="0" aria-label="Section offset"></label>
        <label class="model-keep"><input id="modelSectionFlip" type="checkbox"> Flip</label>
        <label class="model-keep"><input id="modelColourSteps" type="checkbox"> Colour by step</label>
        <p class="model-note" id="modelSectionNote" hidden></p>
        <hr />
        <button class="btn model-look-toggle" id="modelBedToggle" type="button" aria-pressed="true" data-tip="Show the bed and build volume for size">Bed and build volume</button>
        <label class="model-keep"><input id="modelRulers" type="checkbox"> Sizes and scale bar</label>
      </div>
      <div class="rail-fly" id="flyColor" role="dialog" aria-label="Color by" hidden>
        <label class="fly-field">Color by
          <select id="colorBy" aria-label="Color by">
            <option value="feature">Feature</option>
            <option value="weight">Blend weight</option>
            <option value="speed">Speed</option>
            <option value="stress" disabled>Stress (as sliced)</option>
            <option value="safety" disabled>Safety factor (as sliced)</option>
          </select>
        </label>
        <p class="fly-note" id="colorStressNote"></p>
      </div>
      <div class="rail-fly" id="flyFeatures" role="dialog" aria-label="Features shown" hidden>
        <h3>Features shown</h3>
        <div class="legend" id="legend"></div>
      </div>
      <div class="rail-fly" id="flyBed" role="dialog" aria-label="Bed" hidden>
        <label class="fly-field">Bed opacity
          <input id="bedOpacity" type="range" min="0" max="100" value="40" aria-label="Bed opacity" />
        </label>
        <p class="fly-note">0 hides the plate. Does not change the slice.</p>
      </div>
      <aside class="dock left" id="leftDock" aria-label="Settings">
        <div class="dock-head"><h2>Settings</h2><button class="btn ghost dock-close" type="button" aria-label="Collapse settings" aria-controls="leftDock"></button></div>
        <div class="panel" id="left"><div id="leftBody"></div></div>
        <!-- E3. Model's side of the dock: the open tool on top with Cancel and Apply pinned, the sketch card, History, Parameters. -->
        <div class="model-dock" id="modelDock" data-model-ui>
          <section class="model-panel" id="modelPanel" aria-labelledby="modelPanelTitle" hidden>
            <div class="model-panel-head">
              <h3 class="model-panel-title" id="modelPanelTitle"></h3>
              <h3 class="model-edit-head" id="modelEditHead" hidden></h3>
              <kbd class="model-panel-key" aria-hidden="true">Esc</kbd>
            </div>
            <div class="model-panel-body" id="modelPanelBody">
              <div class="modes model-plane-modes" id="modelWpModes" data-for="workplane" role="group" aria-label="Workplane">
                <button class="btn mode on" id="modelWpGlobal" type="button" data-wp="global" aria-pressed="true" data-tip="Model space: U is X, V is Y, W is Z">Global</button>
                <button class="btn mode" id="modelWpBed" type="button" data-wp="bed" aria-pressed="false" data-tip="Under the middle of the part, W up">Bed</button>
                <button class="btn mode" id="modelWpFace" type="button" data-wp="face" aria-pressed="false" data-tip="On a picked flat face, W out of it">Face</button>
              </div>
              <!-- A5: edges a step made. Picked is today's fillet; A step takes every edge that history row made. -->
              <div class="modes" id="modelEdgeModes" data-for="fillet chamfer" role="group" aria-label="Edges">
                <button class="btn mode on" id="modelEdgesPicked" type="button" data-edge-mode="picked" aria-pressed="true">Picked</button>
                <button class="btn mode" id="modelEdgesStep" type="button" data-edge-mode="step" aria-pressed="false" data-tip="Every sharp edge a history step made that is still on this solid">A step</button>
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
                <label data-for="boolean create" data-with="primitive" data-prim="box wedge ellipsoid" data-snap="1"><span class="scrub-label" data-scrub>Width X</span><input id="modelDx" type="number" step="0.1" value="10" aria-label="Width X"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="box wedge ellipsoid" data-snap="1"><span class="scrub-label" data-scrub>Depth Y</span><input id="modelDy" type="number" step="0.1" value="10" aria-label="Depth Y"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="box wedge ellipsoid" data-snap="1"><span class="scrub-label" data-scrub>Height Z</span><input id="modelDz" type="number" step="0.1" value="10" aria-label="Height Z"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="wedge" data-snap="1"><span class="scrub-label" data-scrub>Top X</span><input id="modelTopX" type="number" step="0.1" min="0" value="3" aria-label="Top face length along x"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="cylinder sphere cone torus tube" data-snap="1"><span class="scrub-label" id="modelRadiusLabel" data-scrub>Radius</span><input id="modelRadius" type="number" step="0.1" min="0" value="5" aria-label="Radius"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="cone" data-snap="1"><span class="scrub-label" data-scrub>Top radius</span><input id="modelTopR" type="number" step="0.1" min="0" value="2" aria-label="Top radius"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="torus" data-snap="1"><span class="scrub-label" data-scrub>Tube radius</span><input id="modelTube" type="number" step="0.1" min="0" value="1.5" aria-label="Tube radius"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="tube" data-snap="1"><span class="scrub-label" data-scrub>Inner radius</span><input id="modelInnerR" type="number" step="0.1" min="0" value="3" aria-label="Inner radius"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="polygon" data-snap="1"><span class="scrub-label" data-scrub>Sides</span><input id="modelSides" type="number" step="1" min="3" max="64" value="6" data-whole aria-label="Sides"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="polygon" data-snap="1"><span class="scrub-label" id="modelAcrossLabel" data-scrub>Across flats</span><input id="modelAcross" type="number" step="0.1" min="0" value="10" aria-label="Width across flats"></label>
                <label data-for="boolean create" data-with="primitive" data-prim="cylinder cone polygon tube" data-snap="1"><span class="scrub-label" data-scrub>Height</span><input id="modelHeight" type="number" step="0.1" min="0" value="10" aria-label="Height"></label>
                <label data-for="boolean hole" data-hole="single" data-with="primitive" data-snap="1"><span class="scrub-label" data-scrub>X</span><input id="modelX" type="number" step="0.1" value="10" aria-label="Origin x"></label>
                <label data-for="boolean hole" data-hole="single" data-with="primitive" data-snap="1"><span class="scrub-label" data-scrub>Y</span><input id="modelY" type="number" step="0.1" value="0" aria-label="Origin y"></label>
                <label data-for="boolean hole" data-hole="single" data-with="primitive" data-snap="1"><span class="scrub-label" data-scrub>Z</span><input id="modelZ" type="number" step="0.1" value="0" aria-label="Origin z"></label>
                <label data-for="boolean" data-with="primitive" data-prim="box ellipsoid cylinder cone torus wedge polygon tube" data-snap="15"><span class="scrub-label" data-scrub>Turn X</span><input id="modelRx" type="number" step="1" value="0" aria-label="Turn about x, degrees"></label>
                <label data-for="boolean" data-with="primitive" data-prim="box ellipsoid cylinder cone torus wedge polygon tube" data-snap="15"><span class="scrub-label" data-scrub>Turn Y</span><input id="modelRy" type="number" step="1" value="0" aria-label="Turn about y, degrees"></label>
                <label data-for="boolean" data-with="primitive" data-prim="box ellipsoid cylinder cone torus wedge polygon tube" data-snap="15"><span class="scrub-label" data-scrub>Turn Z</span><input id="modelRz" type="number" step="1" value="0" aria-label="Turn about z, degrees"></label>
                <label data-for="split" data-snap="1"><span class="scrub-label" id="modelPlaneLabel" data-scrub>Plane Z</span><input id="modelPlane" type="number" step="any" value="5" aria-label="Split plane Z, mm"></label>
                <label data-for="split" data-snap="15"><span class="scrub-label" data-scrub>Tilt A°</span><input id="modelTiltA" type="number" step="1" min="-${SPLIT_TILT_MAX_DEG}" max="${SPLIT_TILT_MAX_DEG}" value="0" aria-label="Tilt A, degrees"></label>
                <label data-for="split" data-snap="15"><span class="scrub-label" data-scrub>Tilt B°</span><input id="modelTiltB" type="number" step="1" min="-${SPLIT_TILT_MAX_DEG}" max="${SPLIT_TILT_MAX_DEG}" value="0" aria-label="Tilt B, degrees"></label>
                <label data-for="fillet chamfer" data-snap="1"><span class="scrub-label" data-scrub>Size</span><input id="modelBlend" type="number" step="0.1" min="0" value="1" aria-label="Fillet or chamfer size"></label>
                <!-- P1: the distance, typed. A drag writes the same field. -->
                <label data-for="pushpull" data-snap="1"><span class="scrub-label" data-scrub>Distance</span><input id="modelPull" type="number" step="0.1" value="0" aria-label="Push or pull distance, mm"></label>
                <label id="modelPullDiameterRow" hidden><span>Diameter</span><input id="modelPullDiameter" type="number" step="0.1" min="0" aria-label="Cylinder diameter, mm"></label>
                <!-- A5: the step, by its row or by its number. The number has no data-for, so the drag checklist stays on Size. -->
                <label data-for="fillet chamfer" data-when="step" data-wide><span>Step</span><select id="modelEdgeStep" aria-label="History step"></select></label>
                <label data-when="step" data-snap="1"><span class="scrub-label" data-scrub>Step number</span><input id="modelEdgeNode" type="number" step="1" min="0" value="0" data-whole aria-label="Step number"></label>
                <label data-for="hole" data-snap="1"><span class="scrub-label" data-scrub>Diameter</span><input id="modelHoleR" type="number" step="0.1" min="0" value="4" aria-label="Hole diameter" data-diameter></label>
                <label data-for="hole" data-snap="1"><span class="scrub-label" data-scrub>Depth</span><input id="modelHoleD" type="number" step="0.1" min="0" value="12" aria-label="Hole depth"></label>
                <label data-for="hole"><span class="scrub-label">Screw</span><select id="modelScrew" aria-label="Screw size: a clearance hole through, counterbored for a socket head" data-tip="A clearance hole through, counterbored for a socket head cap screw"><option value="" disabled>Custom</option>${SCREWS.map((screw) => `<option value="${screw.name}">${screw.name}</option>`).join("")}</select></label>
                <label data-for="hole" data-bore data-snap="1"><span class="scrub-label" data-scrub>Bore diameter</span><input id="modelBoreR" type="number" step="0.1" min="0" value="8" aria-label="Counterbore diameter" data-diameter></label>
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
                <!-- A3 composite features. Each number is one line: the drag checklist reads it that way. -->
                <label data-for="pocket boss" data-shape="rect arch" data-snap="1" data-tip="U size."><span class="scrub-label" data-scrub>Width</span><input id="modelFeatW" type="number" step="0.1" min="0.1" max="1000" value="10" aria-label="U size"></label>
                <label data-for="pocket boss" data-shape="rect arch" data-snap="1" data-tip="V size."><span class="scrub-label" data-scrub>Height</span><input id="modelFeatH" type="number" step="0.1" min="0.1" max="1000" value="10" aria-label="V size"></label>
                <label data-for="pocket boss" data-shape="circle" data-snap="1" data-tip="Circle."><span class="scrub-label" data-scrub>Diameter</span><input id="modelFeatDia" type="number" step="0.1" min="0.1" max="1000" value="10" aria-label="Circle"></label>
                <label data-for="pocket boss texture array ribs text" data-snap="1"><span class="scrub-label" data-scrub>Depth</span><input id="modelFeatDepth" type="number" step="0.1" min="0.1" max="1000" value="2" aria-label="Depth"></label>
                <label data-for="pocket boss text" data-snap="1" data-tip="Centre on the face."><span class="scrub-label" data-scrub>U</span><input id="modelFeatU" type="number" step="0.1" value="0" aria-label="Position along U"></label>
                <label data-for="pocket boss text" data-snap="1" data-tip="Centre on the face."><span class="scrub-label" data-scrub>V</span><input id="modelFeatV" type="number" step="0.1" value="0" aria-label="Position along V"></label>
                <label data-for="pocket" data-snap="1" data-tip="Count."><span class="scrub-label" data-scrub>Bars across</span><input id="modelFeatBarsV" type="number" step="1" min="0" max="20" value="0" data-whole aria-label="Vertical bars"></label>
                <label data-for="pocket" data-snap="1" data-tip="Count."><span class="scrub-label" data-scrub>Bars along</span><input id="modelFeatBarsH" type="number" step="1" min="0" max="20" value="0" data-whole aria-label="Horizontal bars"></label>
                <label data-for="pocket" data-snap="1" data-tip="Default 1."><span class="scrub-label" data-scrub>Bar width</span><input id="modelFeatBarW" type="number" step="0.1" min="0.1" max="50" value="1" aria-label="Bar width, default 1"></label>
                <label data-for="texture" data-snap="1" data-tip="[U, V] tile size."><span class="scrub-label" data-scrub>Pitch U</span><input id="modelTexPitchU" type="number" step="0.1" min="0.1" value="5" aria-label="Pitch along U"></label>
                <label data-for="texture" data-snap="1" data-tip="[U, V] tile size."><span class="scrub-label" data-scrub>Pitch V</span><input id="modelTexPitchV" type="number" step="0.1" min="0.1" value="5" aria-label="Pitch along V"></label>
                <label data-for="texture" data-snap="1" data-tip="Default 0.8."><span class="scrub-label" data-scrub>Groove</span><input id="modelTexGroove" type="number" step="0.1" min="0.1" max="20" value="0.8" aria-label="Groove width, default 0.8"></label>
                <label data-for="array" data-cell="rect" data-snap="1" data-tip="U size."><span class="scrub-label" data-scrub>Cell width</span><input id="modelArrW" type="number" step="0.1" min="0.1" max="500" value="4" aria-label="Cell width along U"></label>
                <label data-for="array" data-cell="rect" data-snap="1" data-tip="V size."><span class="scrub-label" data-scrub>Cell height</span><input id="modelArrH" type="number" step="0.1" min="0.1" max="500" value="3" aria-label="Cell height along V"></label>
                <label data-for="array" data-cell="circle" data-snap="1" data-tip="Circle."><span class="scrub-label" data-scrub>Diameter</span><input id="modelArrDia" type="number" step="0.1" min="0.1" max="500" value="4" aria-label="Cell diameter"></label>
                <label data-for="array" data-cell="polygon" data-snap="1" data-tip="Polygon."><span class="scrub-label" data-scrub>Sides</span><input id="modelArrSides" type="number" step="1" min="3" max="64" value="6" data-whole aria-label="Polygon sides"></label>
                <label data-for="array" data-cell="polygon" data-snap="1" data-tip="Polygon corners."><span class="scrub-label" data-scrub>Across</span><input id="modelArrAcross" type="number" step="0.1" min="0.1" max="500" value="4" aria-label="Width across corners"></label>
                <label data-for="array" data-snap="15" data-tip="Cell turn."><span class="scrub-label" data-scrub>Turn</span><input id="modelArrTurn" type="number" step="1" min="-360" max="360" value="0" aria-label="Cell turn, degrees"></label>
                <label data-for="array" data-snap="1" data-tip="[U, V] cell spacing."><span class="scrub-label" data-scrub>Pitch U</span><input id="modelArrPitchU" type="number" step="0.1" min="0.1" value="6" aria-label="Cell spacing along U"></label>
                <label data-for="array" data-snap="1" data-tip="[U, V] cell spacing."><span class="scrub-label" data-scrub>Pitch V</span><input id="modelArrPitchV" type="number" step="0.1" min="0.1" value="5" aria-label="Cell spacing along V"></label>
                <label data-for="array" data-snap="15" data-tip="Turns the layout in the face."><span class="scrub-label" data-scrub>Angle</span><input id="modelArrAngle" type="number" step="1" min="-360" max="360" value="0" aria-label="Layout angle, degrees"></label>
                <label data-for="array" data-snap="1" data-tip="Kept from the face's edges."><span class="scrub-label" data-scrub>Margin</span><input id="modelArrMargin" type="number" step="0.1" min="0" max="100" value="0" aria-label="Margin from the face's edges"></label>
                <label data-for="ribs" data-snap="1" data-tip="Rib width."><span class="scrub-label" data-scrub>Width</span><input id="modelRibWidth" type="number" step="0.1" min="0.1" max="100" value="1.2" aria-label="Rib width"></label>
                <label data-for="ribs" data-snap="1" data-tip="Centre spacing."><span class="scrub-label" data-scrub>Pitch</span><input id="modelRibPitch" type="number" step="0.1" min="0.1" max="1000" value="4" aria-label="Centre spacing"></label>
                <label data-for="ribs" data-snap="1" data-tip="Or this many, evenly."><span class="scrub-label" data-scrub>Count</span><input id="modelRibCount" type="number" step="1" min="0" max="200" value="0" data-whole aria-label="How many ribs, evenly. 0 uses the pitch"></label>
                <label data-for="ribs" data-snap="15" data-tip="Turns the layout in the face."><span class="scrub-label" data-scrub>Angle</span><input id="modelRibAngle" type="number" step="1" min="-360" max="360" value="0" aria-label="Rib angle, degrees"></label>
                <label data-for="ribs" data-snap="1" data-tip="Kept from the face's edges."><span class="scrub-label" data-scrub>Margin</span><input id="modelRibMargin" type="number" step="0.1" min="0" max="100" value="0" aria-label="Margin from the face's edges"></label>
                <label data-for="text" data-snap="1" data-tip="Capitals, mm."><span class="scrub-label" data-scrub>Height</span><input id="modelTextHeight" type="number" step="0.1" min="0.1" max="500" value="6" aria-label="Capitals, mm"></label>
                <label data-for="text" data-snap="1" data-tip="Default height × 0.15."><span class="scrub-label" data-scrub>Stroke</span><input id="modelTextStroke" type="number" step="0.1" min="0.1" max="100" value="0.9" aria-label="Stroke width, default height × 0.15"></label>
                <label data-for="text" data-snap="1" data-tip="Default height / 3."><span class="scrub-label" data-scrub>Spacing</span><input id="modelTextSpace" type="number" step="0.1" min="0" max="100" value="2" aria-label="Spacing, default height / 3"></label>
                <label data-for="text" data-snap="15" data-tip="Turns the layout in the face."><span class="scrub-label" data-scrub>Angle</span><input id="modelTextAngle" type="number" step="1" min="-360" max="360" value="0" aria-label="Text angle, degrees"></label>
                <!-- end A3 -->
                <!-- --- A4 pattern and mirror. Each number is one line: the drag checklist reads it that way. --- -->
                <label data-for="pattern" data-mode="linear" data-snap="1" data-tip="The first direction, in model space."><span class="scrub-label" data-scrub>Step X</span><input id="modelPatSx" type="number" step="0.1" value="10" aria-label="Step along X"></label>
                <label data-for="pattern" data-mode="linear" data-snap="1" data-tip="The first direction, in model space."><span class="scrub-label" data-scrub>Step Y</span><input id="modelPatSy" type="number" step="0.1" value="0" aria-label="Step along Y"></label>
                <label data-for="pattern" data-mode="linear" data-snap="1" data-tip="The first direction, in model space."><span class="scrub-label" data-scrub>Step Z</span><input id="modelPatSz" type="number" step="0.1" value="0" aria-label="Step along Z"></label>
                <label data-for="pattern" data-snap="1" data-tip="Copies, including the original."><span class="scrub-label" data-scrub>Count</span><input id="modelPatCount" type="number" step="1" min="1" max="200" value="6" data-whole aria-label="Copies, including the original"></label>
                <label data-for="pattern" data-mode="linear" data-snap="1" data-tip="A second direction. Count 1 leaves it out."><span class="scrub-label" data-scrub>Step 2 X</span><input id="modelPatS2x" type="number" step="0.1" value="0" aria-label="Second step along X"></label>
                <label data-for="pattern" data-mode="linear" data-snap="1" data-tip="A second direction. Count 1 leaves it out."><span class="scrub-label" data-scrub>Step 2 Y</span><input id="modelPatS2y" type="number" step="0.1" value="0" aria-label="Second step along Y"></label>
                <label data-for="pattern" data-mode="linear" data-snap="1" data-tip="A second direction. Count 1 leaves it out."><span class="scrub-label" data-scrub>Step 2 Z</span><input id="modelPatS2z" type="number" step="0.1" value="0" aria-label="Second step along Z"></label>
                <label data-for="pattern" data-mode="linear" data-snap="1" data-tip="Copies in the second direction. 1 leaves it out."><span class="scrub-label" data-scrub>Count 2</span><input id="modelPatCount2" type="number" step="1" min="1" max="200" value="1" data-whole aria-label="Copies in the second direction"></label>
                <label data-for="pattern" data-mode="polar" data-snap="15" data-tip="360 spaces the copies evenly around the whole turn."><span class="scrub-label" data-scrub>Angle</span><input id="modelPatAngle" type="number" step="1" min="-360" max="360" value="360" aria-label="Total angle, degrees"></label>
                <label data-for="pattern" data-mode="polar" data-snap="1" data-tip="The centre the copies turn about."><span class="scrub-label" data-scrub>Centre X</span><input id="modelPatCx" type="number" step="0.1" value="0" aria-label="Centre x"></label>
                <label data-for="pattern" data-mode="polar" data-snap="1" data-tip="The centre the copies turn about."><span class="scrub-label" data-scrub>Centre Y</span><input id="modelPatCy" type="number" step="0.1" value="0" aria-label="Centre y"></label>
                <label data-for="pattern" data-mode="polar" data-snap="1" data-tip="The centre the copies turn about."><span class="scrub-label" data-scrub>Centre Z</span><input id="modelPatCz" type="number" step="0.1" value="0" aria-label="Centre z"></label>
                <label data-for="pattern" data-mode="path" data-snap="1" data-tip="The last point. Add point keeps it."><span class="scrub-label" data-scrub>Point X</span><input id="modelPatPx" type="number" step="0.1" value="0" aria-label="Path point x"></label>
                <label data-for="pattern" data-mode="path" data-snap="1" data-tip="The last point. Add point keeps it."><span class="scrub-label" data-scrub>Point Y</span><input id="modelPatPy" type="number" step="0.1" value="0" aria-label="Path point y"></label>
                <label data-for="pattern" data-mode="path" data-snap="1" data-tip="The last point. Add point keeps it."><span class="scrub-label" data-scrub>Point Z</span><input id="modelPatPz" type="number" step="0.1" value="0" aria-label="Path point z"></label>
                <label data-for="mirror" data-snap="1" data-tip="A point the plane passes through."><span class="scrub-label" data-scrub>Plane X</span><input id="modelMirX" type="number" step="0.1" value="0" aria-label="Plane point x"></label>
                <label data-for="mirror" data-snap="1" data-tip="A point the plane passes through."><span class="scrub-label" data-scrub>Plane Y</span><input id="modelMirY" type="number" step="0.1" value="0" aria-label="Plane point y"></label>
                <label data-for="mirror" data-snap="1" data-tip="A point the plane passes through."><span class="scrub-label" data-scrub>Plane Z</span><input id="modelMirZ" type="number" step="0.1" value="0" aria-label="Plane point z"></label>
                <!-- --- end A4 --- -->
              </div>
              <!-- A5: which of the step's edges. The line names the row, "Edges of: Roof (convex)". -->
              <div class="modes" id="modelEdgeFilter" data-for="fillet chamfer" data-when="step" role="group" aria-label="Which edges">
                <button class="btn mode on" id="modelEdgeAll" type="button" data-edge-filter="all" aria-pressed="true">All</button>
                <button class="btn mode" id="modelEdgeConvex" type="button" data-edge-filter="convex" aria-pressed="false">Convex</button>
                <button class="btn mode" id="modelEdgeConcave" type="button" data-edge-filter="concave" aria-pressed="false">Concave</button>
              </div>
              <p class="model-note" id="modelEdgeOf" data-for="fillet chamfer" data-when="step" hidden></p>
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
              <!-- --- F4. One hole per sketch point. The origin fields stay in the markup for a single hole. --- -->
              <p class="model-note" id="modelHolePoints" data-for="hole" data-hole="points" hidden></p>
              <div class="model-hole-opts" data-for="hole">
                <label class="model-keep"><input id="modelThrough" type="checkbox"> Through all</label>
                <label class="model-keep"><input id="modelCounterbore" type="checkbox"> Counterbore</label>
              </div>
              <!-- A2 shell -->
              <p class="model-note" id="modelShellFaces" data-for="shell"></p>
              <label class="model-keep" data-for="shell"><input id="modelShellClosed" type="checkbox"> Keep it closed (hollow inside)</label>
              <!-- A3 composite features -->
              <div class="modes" id="modelFeatShape" data-for="pocket boss" role="group" aria-label="Shape" data-tip="rect, circle, arch.">
                <button class="btn mode on" type="button" data-shape="rect" aria-pressed="true">Rect</button>
                <button class="btn mode" type="button" data-shape="circle" aria-pressed="false">Circle</button>
                <button class="btn mode" type="button" data-shape="arch" aria-pressed="false">Arch</button>
              </div>
              <div class="modes" id="modelFeatFrom" data-for="pocket boss text" role="group" aria-label="From" data-tip="U, V = 0 at the face centre, min corner, or bottom or top edge middle.">
                <button class="btn mode on" type="button" data-from="centre" aria-pressed="true">Centre</button>
                <button class="btn mode" type="button" data-from="corner" aria-pressed="false">Corner</button>
                <button class="btn mode" type="button" data-from="bottom" aria-pressed="false">Bottom</button>
                <button class="btn mode" type="button" data-from="top" aria-pressed="false">Top</button>
              </div>
              <div class="modes" id="modelTexPattern" data-for="texture" role="group" aria-label="Pattern" data-tip="brick and shingle stagger rows.">
                <button class="btn mode on" type="button" data-pattern="lines" aria-pressed="true">Lines</button>
                <button class="btn mode" type="button" data-pattern="grid" aria-pressed="false">Grid</button>
                <button class="btn mode" type="button" data-pattern="brick" aria-pressed="false">Brick</button>
                <button class="btn mode" type="button" data-pattern="shingle" aria-pressed="false">Shingle</button>
              </div>
              <div class="modes" id="modelArrCell" data-for="array" role="group" aria-label="Cell" data-tip="Default rect.">
                <button class="btn mode on" type="button" data-cell="rect" aria-pressed="true">Rect</button>
                <button class="btn mode" type="button" data-cell="circle" aria-pressed="false">Circle</button>
                <button class="btn mode" type="button" data-cell="polygon" aria-pressed="false">Polygon</button>
              </div>
              <div class="modes" id="modelArrFit" data-for="array" role="group" aria-label="Fit" data-tip="Whole cell on the face (default), or its centre.">
                <button class="btn mode on" type="button" data-fit="inside" aria-pressed="true">Inside</button>
                <button class="btn mode" type="button" data-fit="centre" aria-pressed="false">Centre</button>
              </div>
              <label class="model-keep" data-for="array" data-tip="Every other row half a pitch over."><input id="modelArrStagger" type="checkbox"> Stagger</label>
              <div class="modes" id="modelRibAlong" data-for="ribs" role="group" aria-label="Along" data-tip="u is level (default).">
                <button class="btn mode on" type="button" data-along="u" aria-pressed="true">Along U</button>
                <button class="btn mode" type="button" data-along="v" aria-pressed="false">Along V</button>
              </div>
              <div class="modes" id="modelFeatOp" data-for="array ribs" role="group" aria-label="Raise or cut" data-tip="fuse raises (default); cut recesses.">
                <button class="btn mode on" type="button" data-op="fuse" aria-pressed="true">Raise</button>
                <button class="btn mode" type="button" data-op="cut" aria-pressed="false">Cut</button>
              </div>
              <label data-for="text" data-tip="A-Z, 0-9, space, -+.,:!?/'&amp;."><span class="scrub-label">Text</span><input id="modelFeatText" type="text" maxlength="80" value="A" aria-label="Text"></label>
              <div class="modes" id="modelTextAlign" data-for="text" role="group" aria-label="Align" data-tip="at is the middle or start.">
                <button class="btn mode on" type="button" data-align="centre" aria-pressed="true">Centre</button>
                <button class="btn mode" type="button" data-align="left" aria-pressed="false">Start</button>
              </div>
              <div class="modes" id="modelTextOp" data-for="text" role="group" aria-label="Raise or engrave" data-tip="fuse raises (default); cut recesses.">
                <button class="btn mode on" type="button" data-op="fuse" aria-pressed="true">Raise</button>
                <button class="btn mode" type="button" data-op="cut" aria-pressed="false">Engrave</button>
              </div>
              <!-- end A3 -->
              <!-- --- A4 pattern and mirror --- -->
              <p class="model-note" id="modelRepeatOf" data-for="pattern mirror"></p>
              <div class="modes" id="modelPatMode" data-for="pattern" role="group" aria-label="Pattern">
                <button class="btn mode on" type="button" data-pat="linear" aria-pressed="true">Linear</button>
                <button class="btn mode" type="button" data-pat="polar" aria-pressed="false">Polar</button>
                <button class="btn mode" type="button" data-pat="path" aria-pressed="false">Path</button>
              </div>
              <div class="modes" id="modelPatAxis" data-for="pattern" data-mode="polar" role="group" aria-label="Axis">
                <button class="btn mode" type="button" data-axis="x" aria-pressed="false">X</button>
                <button class="btn mode" type="button" data-axis="y" aria-pressed="false">Y</button>
                <button class="btn mode on" type="button" data-axis="z" aria-pressed="true">Z</button>
                <button class="btn mode" type="button" data-axis="pick" aria-pressed="false" data-tip="An edge, or a cylinder or a cone">Edge</button>
              </div>
              <p class="model-note" id="modelPathList" data-for="pattern" data-mode="path"></p>
              <div class="modes" id="modelPathActions" data-for="pattern" data-mode="path" role="group" aria-label="Path points">
                <button class="btn" id="modelPathAdd" type="button">Add point</button>
                <button class="btn" id="modelPathDrop" type="button">Remove last</button>
              </div>
              <label class="model-keep" data-for="pattern" data-mode="path" data-tip="Each copy turns to follow the path."><input id="modelPatAlign" type="checkbox" checked> Align to the path</label>
              <div class="modes" id="modelMirPlane" data-for="mirror" role="group" aria-label="Mirror plane">
                <button class="btn mode" type="button" data-plane="x" aria-pressed="false">X</button>
                <button class="btn mode" type="button" data-plane="y" aria-pressed="false">Y</button>
                <button class="btn mode on" type="button" data-plane="z" aria-pressed="true">Z</button>
                <button class="btn mode" type="button" data-plane="face" aria-pressed="false" data-tip="A picked flat face">Face</button>
              </div>
              <!-- --- end A4 --- -->
              <p class="model-note" id="modelNote" hidden role="status"></p>
              <!-- --- Split to print: the card's form, drawn by ui/split-print.ts while that card holds the pane. --- -->
              <div class="model-split-print" id="modelSplitPrint" data-card-for="split-print" hidden></div>
            </div>
            <div class="model-actions">
              <button class="btn model-actions-lead" id="modelWpPrint" type="button" data-for="workplane" data-tip="Turn the part on the plate so W points up and U runs along X. Undo takes it back">Print with W up</button>
              <button class="btn" id="modelCancel" type="button">Cancel</button>
              <button class="btn primary" id="modelApply" type="button">Apply</button>
            </div>
          </section>
          <!-- --- S2 sketch --- -->
          <div class="sketch-cards" id="sketchCards" hidden></div>
          <section class="model-history" id="modelHistory" aria-label="History" hidden>
            <button class="model-history-toggle" id="modelHistoryToggle" type="button" data-pane-head aria-controls="modelHistoryTree" aria-expanded="true"><span>History</span> <span class="model-history-count" id="modelHistoryCount"></span></button>
            <div class="mh-position" id="modelPosition" role="group" aria-label="Position">
              <button class="mh-position-open" id="modelPositionOpen" type="button" data-tip="Where this object sits in model space. Click to open Place."><span class="mh-position-name">Position</span><span class="mh-position-text" id="modelPositionText"></span></button>
              <button class="mh-position-reset" id="modelPositionReset" type="button" aria-label="Reset position" data-tip="Back to where its file put it" hidden></button>
            </div>
            <div class="model-history-tree" id="modelHistoryTree" role="tree" aria-label="Model history"></div>
          </section>
          <!-- --- A6 Parameters, under History as in Onshape. The header folds it. --- -->
          <section class="model-params" id="modelParams" aria-label="Parameters">
            <div class="model-params-head">
              <button class="model-params-toggle" id="modelParamsToggle" type="button" data-pane-head aria-controls="modelParamsMain" aria-expanded="true"><span>Parameters</span> <span class="model-history-count" id="modelParamsCount"></span></button>
              <!-- Shown folded too, so a step out of date is never hidden. -->
              <button class="btn" id="modelParamsRebuild" type="button" hidden>Rebuild</button>
            </div>
            <div class="model-params-main" id="modelParamsMain">
              <div id="modelParamsBody"></div>
              <div class="model-params-bar">
                <button class="btn" id="modelParamsAdd" type="button">Add parameter</button>
              </div>
            </div>
          </section>
          <!-- Stress sits under Parameters. Hidden until the menu opens it. Holds and loads are plate undo, not History. -->
          <section class="model-stress" id="modelStress" aria-label="Stress" hidden>
            <div class="model-params-head">
              <button class="model-params-toggle" id="modelStressToggle" type="button" data-pane-head aria-controls="modelStressMain" aria-expanded="false"><span>Stress</span></button>
            </div>
            <div class="model-params-main" id="modelStressMain" hidden>
              <div class="model-stress-scroll">
              <p class="stress-label" id="stressLabel"></p>
              <p class="stress-note" id="stressProvisional" hidden></p>
              <fieldset class="stress-group stress-step" id="stressHoldStep" data-step="hold">
                <legend><span class="stress-mark" data-step-mark>1</span>Hold</legend>
                <div class="modes" role="group" aria-label="Hold">
                  <button class="btn mode" id="stressBed" type="button" aria-pressed="false">Bed</button>
                  <button class="btn mode" id="stressHoldFaces" type="button" aria-pressed="false">Faces</button>
                </div>
                <p class="stress-note" id="stressBedHint" hidden>The faces that sit on the bed are held.</p>
                <div class="stress-pick-row" id="stressHoldPickRow" hidden>
                  <button class="btn stress-pick" id="stressHoldPick" type="button" aria-pressed="false">Pick faces</button>
                  <ul class="stress-chips" id="stressHoldChips" aria-label="Held faces"></ul>
                </div>
                <p class="stress-note" id="stressHoldHint" hidden>Click faces on the part to hold them. Esc or Pick faces again to finish.</p>
              </fieldset>
              <fieldset class="stress-group stress-step" id="stressLoadStep" data-step="load">
                <legend><span class="stress-mark" data-step-mark>2</span>Load</legend>
                <div class="modes" role="group" aria-label="Load kind">
                  <button class="btn mode" id="stressLoadForce" type="button" aria-pressed="true">Force N</button>
                  <button class="btn mode" id="stressLoadPressure" type="button" aria-pressed="false">Pressure MPa</button>
                </div>
                <label class="stress-inline"><span id="stressForceLabel">Force</span>
                  <span class="stress-unit-field"><input id="stressForce" type="number" step="0.1" value="10" aria-label="Load magnitude" /><span class="stress-unit" id="stressForceUnit">N</span></span>
                </label>
                <div class="stress-pick-row">
                  <button class="btn stress-pick" id="stressLoadPick" type="button" aria-pressed="false">Pick faces</button>
                  <ul class="stress-chips" id="stressLoadChips" aria-label="Loaded faces"></ul>
                </div>
                <p class="stress-note" id="stressLoadHint" hidden>Click the faces the load pushes on. Esc or Pick faces again to finish.</p>
                <div class="stress-axis" role="group" aria-labelledby="stressDirLabel">
                  <span class="stress-axis-label" id="stressDirLabel">Direction (X, Y, Z)</span>
                  <input id="stressDirX" type="number" step="0.1" value="0" aria-label="Direction X" />
                  <input id="stressDirY" type="number" step="0.1" value="0" aria-label="Direction Y" />
                  <input id="stressDirZ" type="number" step="0.1" value="-1" aria-label="Direction Z" />
                </div>
                <p class="stress-note" id="stressDirHint">Or drag the arrow on the part.</p>
              </fieldset>
              <fieldset class="stress-group stress-step" id="stressMaterialStep" data-step="material">
                <legend><span class="stress-mark" data-step-mark>3</span>Material</legend>
                <label>Card <select id="stressCard" aria-label="Material card"></select></label>
                <details class="stress-more" id="stressCardNumbers">
                  <summary>Edit numbers</summary>
                  <div class="stress-grid">
                    <label>E in plane MPa <input id="stressEIn" type="number" step="1" aria-label="E in plane" /></label>
                    <label>E across MPa <input id="stressEZ" type="number" step="1" aria-label="E across layers" /></label>
                    <label>ν <input id="stressNu" type="number" step="0.01" aria-label="Poisson ratio" /></label>
                    <label>Strength in plane MPa <input id="stressSIn" type="number" step="0.1" aria-label="Strength in plane" /></label>
                    <label>Strength across MPa <input id="stressSZ" type="number" step="0.1" aria-label="Strength across layers" /></label>
                    <label>Density g/cm³ <input id="stressDensity" type="number" step="0.01" aria-label="Density" /></label>
                  </div>
                  <button class="btn" id="stressSaveCard" type="button">Save card</button>
                </details>
              </fieldset>
              <fieldset class="stress-group" id="stressTargets" data-stress-local>
                <legend>Targets (optional)</legend>
                <div class="stress-grid stress-grid-2">
                  <label>Min safety factor <input id="stressMinSafety" type="number" min="0" step="0.1" aria-label="Min safety factor" /></label>
                  <label>Max deflection mm <input id="stressMaxDeflection" type="number" min="0" step="0.1" aria-label="Max deflection" /></label>
                </div>
              </fieldset>
              <details class="stress-more" id="stressAdvanced">
                <summary>Advanced</summary>
                <label>Cell size mm <input id="stressEdge" type="number" min="0.2" step="0.1" value="5" aria-label="Cell size" /></label>
                <label class="stress-check"><input id="stressGravity" type="checkbox" /> Gravity</label>
                <label class="stress-check" data-stress-local><input id="stressCheckResolution" type="checkbox" checked /> Check at a second cell size</label>
                <label class="stress-check"><input id="stressPrinter" type="checkbox" checked /> This printer</label>
                <div class="stress-axis" role="group" aria-labelledby="stressBuildLabel">
                  <span class="stress-axis-label" id="stressBuildLabel">Print direction (X, Y, Z)</span>
                  <input id="stressBuildX" type="number" step="0.01" value="0" aria-label="Print direction X" />
                  <input id="stressBuildY" type="number" step="0.01" value="0" aria-label="Print direction Y" />
                  <input id="stressBuildZ" type="number" step="0.01" value="1" aria-label="Print direction Z" />
                </div>
              </details>
              <fieldset class="stress-group" id="stressResult" hidden>
                <legend>Result</legend>
                <label>Colour <select id="stressField" aria-label="Stress field">
                  <option value="vonMises">von Mises</option>
                  <option value="displacement">Displacement</option>
                  <option value="safety">Safety factor</option>
                </select></label>
                <div class="stress-row">
                  <label>Scale <input id="stressScale" type="number" min="0" step="0.1" aria-label="Displacement scale" /></label>
                  <button class="btn" id="stressTrueScale" type="button">True scale</button>
                </div>
                <p class="stress-note">Click the coloured part to read a value there.</p>
                <div id="stressMargins"></div>
                <p id="stressNote" class="stress-note"></p>
              </fieldset>
              <details class="stress-more" id="stressVariants" data-stress-local>
                <summary>Variants</summary>
                <p class="stress-note">Print time stays off. A rough row is not met.</p>
                <div class="stress-grid">
                  <label>Load scale <input id="stressVariantScale" type="number" min="0.01" step="0.1" value="1" aria-label="Load scale" /></label>
                  <label>Walls <input id="stressVariantWalls" type="number" min="1" max="12" step="1" aria-label="Variant walls" /></label>
                  <label>Infill <input id="stressVariantInfill" type="number" min="0" max="1" step="0.05" aria-label="Variant infill" /></label>
                </div>
                <label>Pattern
                  <select id="stressVariantPattern" aria-label="Variant pattern">
                    <option value="">As printed</option>
                    <option value="lines">Lines</option>
                    <option value="grid">Grid</option>
                    <option value="gyroid">Gyroid</option>
                    <option value="lightning">Lightning</option>
                  </select>
                </label>
                <button class="btn" id="stressVariantAdd" type="button">Add variant</button>
                <p id="stressVariantList" class="stress-note"></p>
                <button class="btn" id="stressSweep" type="button">Run sweep</button>
                <p id="stressSweepStatus" class="stress-note" role="status"></p>
                <table id="stressSweepTable" class="stress-table" hidden>
                  <thead><tr><th>Variant</th><th>Deflection mm</th><th>Safety</th><th>Met</th><th>Reason</th></tr></thead>
                  <tbody id="stressSweepBody"></tbody>
                </table>
              </details>
              </div>
              <div class="stress-foot">
                <p id="stressStatus" class="stress-status" role="status"></p>
                <div class="progress indeterminate stress-progress" id="stressProgress" hidden><span></span></div>
                <div class="model-params-bar">
                  <button class="btn" id="stressCancel" type="button">Cancel</button>
                  <button class="btn primary" id="stressRun" type="button" aria-describedby="stressStatus">Run</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </aside>
      <main class="stage mode-solid" id="stage" aria-label="Preview">
        <div class="stage-body" id="prepareBody" role="tabpanel" aria-labelledby="tabPrepare" hidden>
          <canvas id="prepare" aria-label="Model on the build plate"></canvas>
          <div class="gizmo-readout" id="gizmoReadout" hidden></div>
        </div>
        <div class="stage-body" id="modelBody" role="tabpanel" aria-labelledby="tabModel" hidden>
          <canvas id="model" aria-label="Solid faces and edges"></canvas>
          <div id="stressLegend" class="stress-legend" hidden>
            <span class="stress-ramp" aria-hidden="true"></span>
            <div>
              <p id="stressLegendLabel"></p>
              <p id="stressLegendText"></p>
              <p id="stressLegendTrust"></p>
            </div>
          </div>
          <div id="stressProbe" class="stress-probe" hidden></div>
          <!-- E3. Over the view only the pick filter, the view cube (drawn in the canvas) and the context bar. -->
          <div class="model-bar" id="modelBar">
            <div class="model-pick" id="modelPick">
              <div class="modes" role="group" aria-label="Pick">
                <button class="btn mode on" id="modelPickFace" type="button" aria-pressed="true" data-tip="Pick faces. Shift-click adds or removes.">Face</button>
                <button class="btn mode" id="modelPickEdge" type="button" aria-pressed="false" data-tip="Pick edges. Shift-click adds or removes.">Edge</button>
              </div>
            </div>
            <div class="model-empty" id="modelEmpty" hidden>
              <p class="model-empty-title" id="modelEmptyTitle">No solid open</p>
              <p class="model-empty-text" id="modelEmptyText">Start a solid from a primitive, or open a STEP file.</p>
              <div class="model-empty-actions">
                <button class="btn primary" id="modelEmptyNew" type="button">New solid</button>
                <button class="btn" id="modelEmptyOpen" type="button">Open a file</button>
                <!-- --- S2 sketch --- an empty plate sketches on the bed. -->
                <button class="btn" id="modelEmptySketch" type="button">Sketch on the bed</button>
              </div>
            </div>
          </div>
        </div>
        <div class="stage-body" id="previewBody" role="tabpanel" aria-labelledby="tabPreview">
          <div class="stage-chip section-chip" id="sectionChip" role="group" aria-label="Section" hidden data-tip="Section: clip the preview on the arrow side of a free plane. Offset slides the plane, the rings aim it, and the axis keeps it square to the bed. Does not change the slice.">
            <input id="sectionOn" type="checkbox" aria-label="Section" hidden />
            <label class="chip-field" id="sectionAxisField" data-tip="Align the section plane with a bed axis. Custom means the rings have tilted it.">
              Axis
              <select id="sectionAxis" aria-label="Section axis">
                <option value="x">X</option>
                <option value="y">Y</option>
                <option value="z">Z</option>
                <option value="custom" disabled>Custom</option>
              </select>
            </label>
            <label class="chip-field" id="sectionOffsetField" data-tip="Distance from the part center along the section normal, in millimetres.">
              <span class="scrub-label" data-scrub="field">Offset mm</span>
              <input id="sectionOffset" type="number" min="-100" max="100" step="0.1" value="0" aria-label="Section offset" />
            </label>
            <button class="btn" id="sectionFlip" type="button" data-tip="Hide the other side of the section plane">Flip</button>
          </div>
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
          <div class="playback">
            <button class="btn" id="play" type="button" disabled aria-label="Play layer">Play</button>
            <div class="scrub" id="scrub" data-tip="Layer time behind the playback: amber is slow, orange too fast. Click a bar to go to its layer.">
              <canvas id="spark" aria-label="Per-layer time"></canvas>
              <input id="move" type="range" min="0" max="0" value="0" aria-label="Toolpath playback" />
            </div>
            <div class="play-readout" id="playReadout"></div>
          </div>
        </div>
      </main>
      <aside class="dock right" id="rightDock" aria-label="Results">
        <div class="dock-head"><button class="btn ghost dock-close" type="button" aria-label="Collapse results" aria-controls="rightDock"></button><h2>Results</h2></div>
        <div class="panel right" id="right"></div>
        <!-- E3. Inspect: the right dock in Model. -->
        <div class="model-inspect" id="modelInspect" data-model-ui>
          <dl class="model-inspect-kv">
            <dt>Size</dt><dd id="modelInspectSize"></dd>
            <dt>Volume</dt><dd id="modelInspectVolume">—</dd>
            <dt>Build volume</dt><dd id="modelInspectBed">—</dd>
          </dl>
          <h3>Check</h3>
          <p class="model-note" id="modelInspectCheck">Not checked yet.</p>
          <h3>On the plate</h3>
          <div class="model-inspect-objects" id="modelInspectObjects" role="list" aria-label="Objects on the plate"></div>
          <div class="model-inspect-bar"><button class="btn" id="modelInspectAdd" type="button">Add a file</button><button class="btn" id="modelInspectDuplicate" type="button">Duplicate</button></div>
        </div>
      </aside>
    </div>
    <footer class="status"><span class="model-paused" id="modelPaused" hidden data-tip="Slicing waits until you leave Model, then slices once">Slicing paused while modeling</span><div id="modelReadout" class="model-readout"></div><button class="model-fit-warn" id="modelFitWarn" type="button" hidden data-tip="Past the build volume. Inspect has the sizes.">Too large</button><span class="status-text" id="statusText" aria-live="polite"></span><span class="status-hint" id="statusHint" hidden>Settings are in the drawer (Ctrl+B)</span><div id="sliceMeter" class="slice-meter" hidden></div><div id="engineLink" class="engine-link" data-state="pending">Engine …</div></footer>
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
