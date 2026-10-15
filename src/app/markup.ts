export function mountMarkup(root: HTMLElement) {
  root.innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand">Lime <span>Slice</span></div>
      <details class="menu" id="fileMenu">
        <summary class="btn ghost" aria-label="File menu">File<span class="caret" aria-hidden="true"></span></summary>
        <nav>
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
                <div class="modes" role="group" aria-label="Pick">
                  <button class="btn mode on" id="modelPickFace" type="button" aria-pressed="true" data-tip="Pick faces. Shift-click adds or removes.">Face</button>
                  <button class="btn mode" id="modelPickEdge" type="button" aria-pressed="false" data-tip="Pick edges. Shift-click adds or removes.">Edge</button>
                </div>
                <span class="model-count" id="modelCount" hidden></span>
                <div class="model-edit" id="modelEdit" hidden>
                  <span class="model-sep"></span>
                  <button class="model-tool" id="modelToolBoolean" type="button" data-tool="boolean" aria-pressed="false" data-tip="Fuse, cut, or intersect a box, cylinder, or sphere">Boolean</button>
                  <button class="model-tool" id="modelToolSplit" type="button" data-tool="split" aria-pressed="false" data-tip="Split along X, Y, Z, or a picked flat face, and tilt the plane">Split</button>
                  <button class="model-tool" id="modelToolFillet" type="button" data-tool="fillet" aria-pressed="false" data-tip="Round every selected edge in one step">Fillet</button>
                  <button class="model-tool" id="modelToolChamfer" type="button" data-tool="chamfer" aria-pressed="false" data-tip="Chamfer every selected edge in one step">Chamfer</button>
                  <button class="model-tool" id="modelToolHole" type="button" data-tool="hole" aria-pressed="false" data-tip="Cut a cylinder into the picked face, or straight down">Hole</button>
                  <button class="model-tool" id="modelToolScale" type="button" data-tool="scale" aria-pressed="false" data-tip="Scale the solid about its centre">Scale</button>
                  <button class="model-tool" id="modelToolMeasure" type="button" data-tool="measure" aria-pressed="false" data-tip="Drag two points on the solid and read the distance">Measure</button>
                  <span class="model-sep"></span>
                  <button class="model-tool" id="modelStep" type="button" data-tip="Write this solid as AP214 STEP">STEP</button>
                  <button class="model-tool" id="modelUndo" type="button" disabled data-tip="Undo the last solid edit">Undo</button>
                  <button class="model-tool" id="modelRedo" type="button" disabled data-tip="Redo the last solid edit">Redo</button>
                  <button class="model-tool" id="modelHistoryOpen" type="button" aria-controls="modelHistory" aria-expanded="false">History</button>
                </div>
              </div>
              <span class="model-paused" id="modelPaused">Slicing paused while modeling</span>
            </div>
            <div class="model-side">
              <div class="model-panel" id="modelPanel" hidden>
                <div class="modes model-plane-modes" id="modelPlaneModes" data-for="split" role="group" aria-label="Plane">
                  <button class="btn mode" id="modelSplitX" type="button" data-plane="x" aria-pressed="false" data-tip="Cut square to X">X</button>
                  <button class="btn mode" id="modelSplitY" type="button" data-plane="y" aria-pressed="false" data-tip="Cut square to Y">Y</button>
                  <button class="btn mode on" id="modelSplitZ" type="button" data-plane="z" aria-pressed="true" data-tip="Cut square to Z">Z</button>
                  <button class="btn mode" id="modelSplitFace" type="button" data-plane="face" aria-pressed="false" data-tip="Cut parallel to a picked flat face">Face</button>
                </div>
                <div class="model-fields">
                  <label data-for="boolean" data-wide><span>Primitive</span>
                    <select id="modelPrim" aria-label="Primitive">
                      <option value="box">Box</option>
                      <option value="cylinder">Cylinder</option>
                      <option value="sphere">Sphere</option>
                    </select>
                  </label>
                  <label data-for="boolean" data-prim="box" data-snap="1"><span class="scrub-label" data-scrub>Size X</span><input id="modelDx" type="number" step="0.1" value="10" aria-label="Box size x"></label>
                  <label data-for="boolean" data-prim="box" data-snap="1"><span class="scrub-label" data-scrub>Size Y</span><input id="modelDy" type="number" step="0.1" value="10" aria-label="Box size y"></label>
                  <label data-for="boolean" data-prim="box" data-snap="1"><span class="scrub-label" data-scrub>Size Z</span><input id="modelDz" type="number" step="0.1" value="10" aria-label="Box size z"></label>
                  <label data-for="boolean" data-prim="cylinder sphere" data-snap="1"><span class="scrub-label" data-scrub>Radius</span><input id="modelRadius" type="number" step="0.1" min="0" value="5" aria-label="Radius"></label>
                  <label data-for="boolean" data-prim="cylinder" data-snap="1"><span class="scrub-label" data-scrub>Height</span><input id="modelHeight" type="number" step="0.1" min="0" value="10" aria-label="Height"></label>
                  <label data-for="boolean hole" data-snap="1"><span class="scrub-label" data-scrub>X</span><input id="modelX" type="number" step="0.1" value="10" aria-label="Origin x"></label>
                  <label data-for="boolean hole" data-snap="1"><span class="scrub-label" data-scrub>Y</span><input id="modelY" type="number" step="0.1" value="0" aria-label="Origin y"></label>
                  <label data-for="boolean hole" data-snap="1"><span class="scrub-label" data-scrub>Z</span><input id="modelZ" type="number" step="0.1" value="0" aria-label="Origin z"></label>
                  <label data-for="boolean" data-prim="box cylinder" data-snap="15"><span class="scrub-label" data-scrub>Turn X</span><input id="modelRx" type="number" step="1" value="0" aria-label="Turn about x, degrees"></label>
                  <label data-for="boolean" data-prim="box cylinder" data-snap="15"><span class="scrub-label" data-scrub>Turn Y</span><input id="modelRy" type="number" step="1" value="0" aria-label="Turn about y, degrees"></label>
                  <label data-for="boolean" data-prim="box cylinder" data-snap="15"><span class="scrub-label" data-scrub>Turn Z</span><input id="modelRz" type="number" step="1" value="0" aria-label="Turn about z, degrees"></label>
                  <label data-for="split" data-snap="1"><span class="scrub-label" id="modelPlaneLabel" data-scrub>Plane Z</span><input id="modelPlane" type="number" step="0.1" value="5" aria-label="Split plane Z, mm"></label>
                  <label data-for="split" data-snap="15"><span class="scrub-label" data-scrub>Tilt A°</span><input id="modelTiltA" type="number" step="1" min="-85" max="85" value="0" aria-label="Tilt A, degrees"></label>
                  <label data-for="split" data-snap="15"><span class="scrub-label" data-scrub>Tilt B°</span><input id="modelTiltB" type="number" step="1" min="-85" max="85" value="0" aria-label="Tilt B, degrees"></label>
                  <label data-for="fillet chamfer" data-snap="1"><span class="scrub-label" data-scrub>Size</span><input id="modelBlend" type="number" step="0.1" min="0" value="1" aria-label="Fillet or chamfer size"></label>
                  <label data-for="hole" data-snap="1"><span class="scrub-label" data-scrub>Radius</span><input id="modelHoleR" type="number" step="0.1" min="0" value="2" aria-label="Hole radius"></label>
                  <label data-for="hole" data-snap="1"><span class="scrub-label" data-scrub>Depth</span><input id="modelHoleD" type="number" step="0.1" min="0" value="12" aria-label="Hole depth"></label>
                  <label data-for="scale" data-snap="0.5"><span class="scrub-label" data-scrub>Factor</span><input id="modelFactor" type="number" step="0.1" min="0.1" max="20" value="2" aria-label="Uniform scale"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>A X</span><input id="modelAx" type="number" step="0.1" value="0" aria-label="Point A x"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>A Y</span><input id="modelAy" type="number" step="0.1" value="0" aria-label="Point A y"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>A Z</span><input id="modelAz" type="number" step="0.1" value="0" aria-label="Point A z"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>B X</span><input id="modelBx" type="number" step="0.1" value="0" aria-label="Point B x"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>B Y</span><input id="modelBy" type="number" step="0.1" value="0" aria-label="Point B y"></label>
                  <label data-for="measure" data-snap="1"><span class="scrub-label" data-scrub>B Z</span><input id="modelBz" type="number" step="0.1" value="0" aria-label="Point B z"></label>
                </div>
                <div class="modes" data-for="boolean" role="group" aria-label="Boolean">
                  <button class="btn mode on" id="modelFuse" type="button" aria-pressed="true">Fuse</button>
                  <button class="btn mode" id="modelCut" type="button" aria-pressed="false">Cut</button>
                  <button class="btn mode" id="modelCommon" type="button" aria-pressed="false">Common</button>
                </div>
                <p class="model-note" id="modelNote" hidden></p>
                <div class="model-actions">
                  <button class="btn" id="modelCancel" type="button">Cancel</button>
                  <button class="btn primary" id="modelApply" type="button">Apply</button>
                </div>
              </div>
              <section class="model-history" id="modelHistory" aria-label="History" hidden>
                <button class="model-history-toggle" id="modelHistoryToggle" type="button" aria-controls="modelHistoryTree" aria-expanded="true"><span>History</span> <span class="model-history-count" id="modelHistoryCount"></span></button>
                <div class="model-history-tree" id="modelHistoryTree" role="tree" aria-label="Model history"></div>
              </section>
              <div class="model-foot" id="modelFoot">
                <div id="modelReadout" class="model-readout">Open a STEP file to measure a solid.</div>
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
  <div id="help" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="helpTitle">
    <div class="sheet-card">
      <h2 id="helpTitle">Shortcuts</h2>
      <div id="helpShortcuts" class="help-body"></div>
      <button class="btn" id="helpClose" type="button">Close</button>
    </div>
  </div>
`;
}
