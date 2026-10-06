export function mountMarkup(root: HTMLElement) {
  root.innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand">Lime <span>Slice</span></div>
      <button class="btn panel-toggle" id="toggleLeft" type="button">Settings</button>
      <button class="btn panel-toggle" id="toggleRight" type="button">Blend</button>
      <label class="btn file">Open mesh<input id="file" type="file" accept=".stl,.3mf,.step,.stp,.STL,.3MF,.STEP,.STP" /></label>
      <input id="projectFile" type="file" accept=".lime,application/json" hidden />
      <details class="menu" id="samples">
        <summary class="btn">Samples</summary>
        <nav>
          <button type="button" data-project="open">Open project</button>
          <button type="button" data-project="save">Save project</button>
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
      <label class="theme-field">Theme
        <select id="theme" aria-label="Theme">
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <div class="spacer"></div>
      <div class="action-row">
        <button class="btn primary" id="slice" type="button" data-slice-action="none">Slice</button>
        <button class="btn" id="cancel" type="button" disabled>Cancel</button>
        <button class="btn" id="export" type="button" disabled>Export G-code</button>
        <button class="btn" id="sendPrinter" type="button" disabled title="Slice first, and add a Prusa Link host on this printer.">Send to printer</button>
        <button class="btn" id="force" type="button" disabled title="Plan this recipe again. Available when a saved slice would be shown.">Force re-slice</button>
      </div>
    </header>
    <div class="banner-rail" id="banner"></div>
    <div class="workspace">
      <aside class="panel" id="left"><div id="leftBody"></div><div id="leftFoot"></div></aside>
      <section class="stage mode-solid" id="stage">
        <div class="viewbar">
          <div class="modes" id="viewModes">
            <button class="btn mode" type="button" data-mode="flat" aria-pressed="false">2D</button>
            <button class="btn mode" type="button" data-mode="split" aria-pressed="false">Split</button>
            <button class="btn mode" type="button" data-mode="solid" aria-pressed="true">3D</button>
          </div>
          <div class="modes" role="tablist" aria-label="Workspace">
            <button class="btn mode tab" id="tabPrepare" type="button" role="tab" data-tab="prepare" aria-selected="false" aria-pressed="false" aria-controls="prepareBody">Prepare</button>
            <button class="btn mode tab on" id="tabPreview" type="button" role="tab" data-tab="preview" aria-selected="true" aria-pressed="true" aria-controls="previewBody">Preview</button>
            <button class="btn mode tab" id="tabGcode" type="button" role="tab" data-tab="gcode" aria-selected="false" aria-pressed="false" aria-controls="gcodePane">G-code</button>
          </div>
          <label class="field">Color
            <select id="colorBy" aria-label="Color by">
              <option value="feature">Feature</option>
              <option value="weight">Blend weight</option>
              <option value="speed">Speed</option>
            </select>
          </label>
          <label class="view-inline" title="Build plate opacity. 0 hides the plate. Does not change the slice.">
            Bed
            <input id="bedOpacity" type="range" min="0" max="100" value="40" aria-label="Bed opacity" />
          </label>
          <label class="check" id="sectionField" title="Clip the preview on the arrow side of a free plane. Cut slides the plane. Rings aim it. Does not change the slice.">
            <input id="sectionOn" type="checkbox" /> Section
          </label>
          <label class="view-inline" id="sectionOffsetField" hidden title="Distance from the part center along the section normal.">
            Cut
            <input id="sectionOffset" type="range" min="-100" max="100" step="0.1" value="0" aria-label="Section offset" />
          </label>
          <button class="btn" id="sectionFlip" type="button" hidden title="Hide the other side of the section plane">Flip</button>
        </div>
        <div class="stage-body" id="prepareBody" role="tabpanel" aria-labelledby="tabPrepare" hidden>
          <canvas id="prepare" aria-label="Model on the build plate"></canvas>
          <div class="gizmo-readout" id="gizmoReadout" hidden></div>
        </div>
        <div class="stage-body" id="previewBody" role="tabpanel" aria-labelledby="tabPreview">
          <div class="vslider" id="vslider">
            <div class="readout" id="readHigh">—</div>
            <button class="layer-step" id="layerNext" type="button" aria-label="Next layer" disabled>▲</button>
            <div class="track">
              <div class="range-bands" id="rangeBands"></div>
              <div class="band" id="layerBand" hidden></div>
              <input id="rangeLow" type="range" min="0" max="0" value="0" aria-label="Lowest visible layer" />
              <input id="rangeHigh" type="range" min="0" max="0" value="0" aria-label="Current layer" />
            </div>
            <button class="layer-step" id="layerPrev" type="button" aria-label="Previous layer" disabled>▼</button>
            <div class="readout" id="readLow">Z —</div>
          </div>
          <div class="previews">
            <div class="pane" id="pane2d"><canvas id="view" aria-label="2D toolpath"></canvas></div>
            <div class="pane" id="pane3d">
              <div class="belt-mock-tag" id="beltMockTag" hidden>Mock belt preview</div>
              <div class="viewport-bands" id="viewportBands" hidden></div>
              <canvas id="view3d" aria-label="3D toolpath"></canvas>
              <div class="section-readout" id="sectionReadout" hidden></div>
            </div>
          </div>
        </div>
        <div class="gcode-pane" id="gcodePane" role="tabpanel" aria-labelledby="tabGcode" tabindex="-1" hidden></div>
        <div class="stage-tools">
          <div class="spark-wrap">
            <div class="spark-label" id="sparkLabel">Layer time</div>
            <canvas id="spark" aria-label="Per-layer time"></canvas>
          </div>
          <div class="playback">
            <button class="btn" id="play" type="button" disabled aria-label="Play layer">Play</button>
            <button class="btn" id="stop" type="button" disabled aria-label="Stop playback">Stop</button>
            <input id="move" type="range" min="0" max="0" value="0" aria-label="Toolpath playback" />
            <div class="play-readout" id="playReadout">Feature — · feed — · E —</div>
          </div>
        </div>
        <div class="legend" id="legend"></div>
      </section>
      <aside class="panel right" id="right"></aside>
    </div>
    <footer class="status"><div class="timing" id="timing">No slice yet</div><div id="sliceMeter" class="slice-meter" hidden></div><div id="engineLink" class="engine-link" data-state="pending">Engine …</div><div id="status">Load an STL, 3MF, or STEP file. Arrow keys move the layer. Press ? for shortcuts.</div></footer>
  </div>
  <div id="help" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="helpTitle">
    <div class="sheet-card">
      <h2 id="helpTitle">Shortcuts</h2>
      <ul id="helpShortcuts"></ul>
      <ul>
        <li>Force re-slice plans a saved recipe again</li>
        <li>Prepare gizmo sits at the left of the view. Drag a ring to rotate. <kbd>Shift</kbd> snaps 15°</li>
        <li>Drag the part, or an arrow, to move it. <kbd>Shift</kbd> snaps 1 mm. X and Y fields set the bed position</li>
        <li>Drag the split plane when By region is on</li>
        <li>Bed fades the build plate. 0 hides it</li>
        <li>Section clips the preview. Cut moves the plane. Rings, parked at the left, aim it. The sheet is only a guide. Layers still apply. Neither changes the slice</li>
        <li><kbd>↑</kbd> <kbd>↓</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd> <kbd>Home</kbd> <kbd>End</kbd> Layer. The ▲ ▼ buttons step one layer; the slider still scrubs</li>
        <li>Prepare nudge buttons step 0.1 mm, or 1° when Rotate is on. A scroll on a handle does the same</li>
      </ul>
      <button class="btn" id="helpClose" type="button">Close</button>
    </div>
  </div>
`;
}
