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
      <input id="projectFile" type="file" accept=".lime,application/json" hidden />
      <details class="menu" id="printerChip">
        <summary class="btn chip" aria-label="Printer, filament and nozzle" data-tip="Printer, filament and nozzle"><span id="printerChipLabel"></span><span class="caret" aria-hidden="true"></span></summary>
        <div class="popover" id="printerPick"></div>
      </details>
      <div class="modes title-tabs" role="tablist" aria-label="Workspace">
        <button class="btn mode tab" id="tabPrepare" type="button" role="tab" data-tab="prepare" aria-label="Prepare" aria-selected="false" aria-pressed="false" aria-controls="prepareBody" data-key="1">Prepare</button>
        <button class="btn mode tab on" id="tabPreview" type="button" role="tab" data-tab="preview" aria-label="Preview" aria-selected="true" aria-pressed="true" aria-controls="previewBody" data-key="2">Preview</button>
        <button class="btn mode tab" id="tabGcode" type="button" role="tab" data-tab="gcode" aria-label="G-code" aria-selected="false" aria-pressed="false" aria-controls="gcodePane" data-key="3">G-code</button>
      </div>
      <button class="btn panel-toggle" id="toggleLeft" type="button">Settings</button>
      <button class="btn panel-toggle" id="toggleRight" type="button">Results</button>
      <button class="estimate" id="timing" type="button" data-tip="Show the results panel"></button>
      <div class="action-row">
        <button class="btn" id="cancel" type="button" hidden>Cancel</button>
        <button class="btn" id="sendPrinter" type="button" hidden disabled>Send</button>
        <div class="split" id="sliceSplit">
          <button class="btn primary" id="slice" type="button" data-slice-action="none" data-key="Ctrl ↵">Slice</button>
          <details class="menu split-more" id="sliceMore">
            <summary class="btn primary" aria-label="Slice options" data-tip="More slice actions"><span class="caret" aria-hidden="true"></span></summary>
            <nav><button type="button" id="force" hidden>Force re-slice</button></nav>
          </details>
        </div>
        <button class="btn" id="export" type="button" disabled aria-label="Export G-code" data-key="Ctrl E">Export</button>
      </div>
      <div class="gear-items" hidden>
        <label class="theme-field">Theme
          <select id="theme" aria-label="Theme">
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label class="row setting" data-label="auto-slice under 50k triangles" data-tip="Slice again by itself after a change, while the mesh is small enough to be quick."><span class="row-label">Auto-slice under 50k triangles</span><input id="autoslice" type="checkbox" class="switch" role="switch" /></label>
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
          <label class="view-toggle" id="sectionField" data-tip="Section: clip the preview on the arrow side of a free plane. Cut slides the plane, the rings aim it. Does not change the slice.">
            <input id="sectionOn" type="checkbox" aria-label="Section" /><span class="view-toggle-face">Section</span>
          </label>
          <label class="view-inline" id="sectionOffsetField" hidden data-tip="Distance from the part center along the section normal.">
            Cut
            <input id="sectionOffset" type="range" min="-100" max="100" step="0.1" value="0" aria-label="Section offset" />
          </label>
          <button class="btn" id="sectionFlip" type="button" hidden data-tip="Hide the other side of the section plane">Flip</button>
        </div>
        <div class="stage-body" id="prepareBody" role="tabpanel" aria-labelledby="tabPrepare" hidden>
          <canvas id="prepare" aria-label="Model on the build plate"></canvas>
          <div class="gizmo-readout" id="gizmoReadout" hidden></div>
        </div>
        <div class="stage-body" id="previewBody" role="tabpanel" aria-labelledby="tabPreview">
          <div class="vslider" id="vslider">
            <div class="readout" id="readHigh"></div>
            <button class="layer-step" id="layerNext" type="button" aria-label="Next layer" disabled>▲</button>
            <div class="track">
              <div class="range-bands" id="rangeBands"></div>
              <div class="band" id="layerBand" hidden></div>
              <input id="rangeLow" type="range" min="0" max="0" value="0" aria-label="Lowest visible layer" />
              <input id="rangeHigh" type="range" min="0" max="0" value="0" aria-label="Current layer" />
            </div>
            <button class="layer-step" id="layerPrev" type="button" aria-label="Previous layer" disabled>▼</button>
            <div class="readout" id="readLow"></div>
          </div>
          <div class="previews">
            <div class="pane" id="pane2d">
              <canvas id="view" aria-label="2D toolpath"></canvas>
              <div class="flat-tools" id="flatTools">
                <button class="flat-tool" id="flatZoomOut" type="button" aria-label="Zoom out" disabled>−</button>
                <button class="flat-tool" id="flatFit" type="button" aria-label="Fit layer" disabled>Fit</button>
                <button class="flat-tool" id="flatZoomIn" type="button" aria-label="Zoom in" disabled>+</button>
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
