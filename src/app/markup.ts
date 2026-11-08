import { isTauri } from "../platform.ts";

export function mountMarkup(root: HTMLElement) {
  root.innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand">Lime <span>Slice</span><small id="betaIdentity" hidden> Beta</small></div>
      <div class="project-title" id="projectTitle">Untitled</div>
      <span class="tandem-activity" id="tandemActivity" role="status" hidden></span>
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
        <button class="btn mode tab" id="tabPose" type="button" role="tab" data-tab="pose" aria-label="Pose" aria-selected="false" aria-pressed="false" aria-controls="poseBody" data-key="5">Pose</button>
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
        <label class="row setting" data-label="names under tool icons" data-keywords="rail labels captions" data-tip="Show a short name under each tool icon in Prepare and Preview, in a window at least 1280 px wide and 800 px high."><span class="row-label">Names under tool icons</span><input id="railCaptions" type="checkbox" class="switch" role="switch" checked /></label>
        <label class="row setting" data-label="show tool labels" data-tip="Widen the tool rail and show each tool's name. Off by default."><span class="row-label">Show tool labels</span><input id="railLabels" type="checkbox" class="switch" role="switch" /></label>
        <label class="row setting" data-label="plugin author" data-tip="The name a plugin you keep is signed with, in the app and through the MCP. Never filled from your account."><span class="row-label">Plugin author</span><input id="pluginAuthor" type="text" maxlength="60" placeholder="unknown" spellcheck="false" autocomplete="off" /></label>
      </div>
    </header>
    <div class="banner-rail" id="banner"></div>
    <div class="workspace">
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
        <div class="panel pose-panel" id="posePanel" aria-label="Pose" hidden></div>
      </aside>
      <main class="stage mode-solid" id="stage" aria-label="Preview">
        <div class="stage-body" id="prepareBody" role="tabpanel" aria-labelledby="tabPrepare" hidden>
          <canvas id="prepare" aria-label="Model on the build plate"></canvas>
          <div class="gizmo-readout" id="gizmoReadout" hidden></div>
          <div class="gizmo-readout gizmo-contact" id="contactReadout" hidden></div>
        </div>
        <div class="stage-body" id="modelBody" role="tabpanel" aria-labelledby="tabModel" hidden>
        </div>
        <div class="stage-body" id="poseBody" role="tabpanel" aria-labelledby="tabPose" hidden>
          <canvas id="pose" aria-label="Parts at their assembled pose"></canvas>
          <div class="modes stage-chip view-presets" id="poseViewPresets" role="group" aria-label="Camera">
            <button class="btn" type="button" data-pose-view="top" data-tip="Top view">Top</button>
            <button class="btn" type="button" data-pose-view="front" data-tip="Front view">Front</button>
            <button class="btn" type="button" data-pose-view="iso" data-tip="Iso view">Iso</button>
          </div>
          <p class="pose-empty" id="poseEmpty" hidden>Open a project or add a part to pose it.</p>
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
      </aside>
    </div>
    <footer class="status"><span class="model-paused" id="modelPaused" hidden data-tip="Slicing waits until you leave Model, then slices once">Slicing paused while modeling</span><div id="modelReadout" class="model-readout"></div><button class="model-fit-warn" id="modelFitWarn" type="button" hidden data-tip="Past the build volume. Inspect has the sizes.">Too large</button><span class="status-text" id="statusText" aria-live="polite"></span><span class="status-hint" id="statusHint" hidden>Settings are in the drawer (Ctrl+B)</span><span class="status-hint" id="grabHint" hidden></span><div id="sliceMeter" class="slice-meter" hidden></div><div id="engineLink" class="engine-link" data-state="pending">Engine …</div></footer>
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
    <div class="sheet-card help-card">
      <div class="sheet-head">
        <h2 id="helpTitle">Shortcuts</h2>
        <button class="btn" id="helpClose" type="button">Close</button>
      </div>
      <input id="helpSearch" class="help-search" type="search" placeholder="Search shortcuts" aria-label="Search shortcuts" autocomplete="off" />
      <div id="helpShortcuts" class="help-body" role="region" aria-label="Shortcuts by group" tabindex="-1"></div>
    </div>
  </div>
`;
  if (isTauri()) {
    void import("@tauri-apps/api/app").then(({ getIdentifier }) => getIdentifier()).then((id) => {
      if (id === "com.limeslice.slicer.tandem-beta") root.querySelector<HTMLElement>("#betaIdentity")!.hidden = false;
    }).catch(() => {});
  }
}
