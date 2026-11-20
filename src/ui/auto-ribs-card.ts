/**
 * --- Auto ribs (docs/plan-auto-ribs.md, section 7.1): the card in the Model dock, opened from the Features menu next to
 * Stress. Four actions are all it needs: open it, click the wall, Run, Apply. The footer's primary button is Run until
 * there is a plan to apply, then Apply; Enter presses it, Esc stops a running plan or ends a pick before it closes.
 *
 * 1. Wall: a click takes the face and its smooth continuations (`wallFaces`); a taken face clicked again comes off;
 *    "Just this face" takes clicks alone. "Include side walls (folded)" is off unless checked, and then a thin face
 *    across a sharp edge joins the wall. Hovering shows what a click would take.
 * 2. Plan: a background job (src/auto-ribs-plan.ts): the stage and a bar that never goes back, each rib drawn on the wall
 *    as it is chosen, the running totals, Stop for the plan so far.
 * 3. The plan: gain and cost, the goal not met, the comparisons, the relative note; a rib list to light or take out.
 *    Process moulded also lists moulding flags under the result. Filament and resin do not.
 * 4. Apply: one History row, then what it measured and the print check before and after.
 * Optional, folded: How much, Hold and load (the Stress panel's controls), Keep clear (zones, each a place), Ribs.
 *
 * State and sentences: src/auto-ribs.ts. The app side (solid, worker, apply, picks): src/app/model/auto-ribs.ts.
 */
import { Check, X, createElement } from "lucide";
import type { Affine } from "../model-space.ts";
import type { DragHandle } from "../model-drag";
import type { HandleDrag, ModelGhost } from "../model-view";
import { wallFaces, ribPathsFromPlan, type NotOnWall, type RibWall, type RibWallOptions } from "../modeling/rib-wall.ts";
import { plateToWall, ventBodyOf, ventLoopsOf } from "../modeling/vents.ts";
import { builtVolumeOf, planFlange, ribNetOf, ribRules, ribsOnFace, wallSurfaceOf, wireProfileOf, type BuiltRib, type FaceRib, type RibProcess, type RibRulesChosen } from "../modeling/auto-ribs.ts";
import { mouldingLines, mouldingReport, nearestWallMm } from "../modeling/moulding.ts";
import type { RibSurface } from "../modeling/rib-net.ts";
import type { StudyHold, StudyLoad } from "../sim/study.ts";
import { stageName, type PlanGoal, type PlanJob, type PlanSource, type RibPlanBody, type V3 } from "../auto-ribs-plan.ts";
import {
  AUTO_RIBS_LABEL,
  AUTO_RIBS_TITLE,
  AUTOMATIC_NOTE,
  DEFAULT_HOLD_NOTE,
  NO_SOLID,
  OPEN_SHELL,
  RELATIVE_NOTE,
  SLIDER_LABELS,
  STOPPED_LINE,
  applicable,
  checkLines,
  clickWall,
  comparisonLines,
  editedNote,
  fmt,
  caseResultLines,
  goalLine,
  loadRequest,
  looseLine,
  MAX_LOAD_CASES,
  goalOf,
  grams,
  idleRun,
  keptRibs,
  measuredLine,
  newAutoRibsCard,
  newZone,
  type PanelLoadCase,
  notOnWallLines,
  resultNumbers,
  ribBox,
  ribSoup,
  ribUnderRay,
  runDone,
  runEvent,
  sliderNote,
  startedRun,
  toggleRemoved,
  totalsLine,
  wallLine,
  wallReadout,
  EVEN_PRESSURE_OFFER,
  zoneInputs,
  zoneLanded,
  zoneModeText,
  zoneSoup,
  zoneTitle,
  type AutoRibsCard,
  type CheckNumbers,
  type DrawnRib,
  type RunState,
  type ZoneRow,
  type ZoneShape,
} from "../auto-ribs.ts";
import { closeModelCard, modelCardOpen, openModelCard, refreshModelCard } from "./model-chrome";
import { html, setHtml, type Html } from "./html";

const CARD_ID = "auto-ribs";

export interface AutoRibsSolid {
  /** Triangles in the panel's frame (the solid as the view draws it), nine numbers each. */
  positions: Float32Array;
  faceOf: Uint32Array;
  volumeMm3: number;
  /** Changes when the solid does. */
  key: string;
}

export interface AutoRibsHost {
  state(): "ok" | "none" | "surfaces";
  solid(): AutoRibsSolid | null;
  /** Points in the panel's frame to the solid's own, for the ghost. */
  toSolid(positions: readonly number[]): Float32Array;
  /** The pointer's ray in the panel's frame. */
  ray(x: number, y: number): { origin: V3; direction: V3 } | null;
  /** The face under a screen point. */
  faceAt(x: number, y: number): number | null;
  densityGCm3(): number;
  nozzleMm(): number;
  printerName(): string;
  /** The printer's build direction in the panel's frame. Filament flanges use it. Resin vents do not. */
  build(): V3;
  /** The plate orientation and the part's pose, so a resin build axis turns the same way for the panel and ribs_plan. */
  plate(): { orient: readonly number[]; pose: Affine };
  /** The object's Stress setup, when it has one. */
  stress(): { holds: StudyHold[]; loads: StudyLoad[] } | null;
  /** Other objects on the plate, for an obstacle. */
  others(): { id: string; name: string }[];
  obstacle(id: string): Float32Array | null;
  readWall(options: RibWallOptions): Promise<RibWall | { reason: string; missed?: NotOnWall[] }>;
  check(): Promise<CheckNumbers | null>;
  /** Build `op` (a ribNet in the panel's frame) as one History step, or replace the edited one. */
  apply(op: Record<string, unknown>): Promise<{ ok: true; beforeMm3: number; afterMm3: number } | { ok: false; reason: string }>;
  source(): PlanSource;
  readout(text: string): void;
  /** The card closed during an edit, without Apply. */
  cancelled(): void;
  /** Face picking on (the card takes clicks) or off. */
  pickFaces(): void;
  /** The shell model's material card for the selected filament (shared with ribs_plan), with the sentence naming it. */
  material(): { e: number; nu: number; note: string } | null;
  /** Whether the Stress check can run here: the desktop's study solve. */
  stressAvailable(): boolean;
  /** The sliced Stress study before and after the ribs, opt-in after Apply. */
  stressCheck(setup: { holds: StudyHold[]; loads: StudyLoad[]; wallFaces: number[]; joinedFaces: number[]; cases?: { name: string; loads: StudyLoad[] }[] }, progress: (text: string) => void): Promise<{ before: { maxDisplacementMm: number; minSafetyFactor: number | null }; after: { maxDisplacementMm: number; minSafetyFactor: number | null } } | { cases: { name: string; before: { maxDisplacementMm: number; minSafetyFactor: number | null }; after: { maxDisplacementMm: number; minSafetyFactor: number | null } }[] } | { reason: string }>;
}

type Pick = { kind: "wall" } | { kind: "zoneFaces"; zone: number } | { kind: "hold" } | { kind: "load"; case?: number } | { kind: "place"; shape: ZoneShape["kind"] };

interface WallRead {
  /** What was asked, so a stale read is known. */
  key: string;
  wall: RibWall | null;
  error: string | null;
  /** Holds and loads that missed the wall, when that is why it was refused. */
  missed: NotOnWall[];
  /** The zone rows read with it, in order, and those whose object is gone. */
  rows: number[];
  gone: number[];
}

/** The material card the last plan was solved with, in a sentence. */
let materialNote = "";
/** The joined faces and the wall the last plan stood on: what the Stress check holds and presses by default. */
let lastSetup: { holds: StudyHold[]; loads: StudyLoad[]; wallFaces: number[]; joinedFaces: number[]; cases?: { name: string; loads: StudyLoad[] }[] } | null = null;
/** The opt-in Stress check after Apply: not run, running (its line), done (its lines) or refused. */
let stressRun: { phase: "running"; text: string } | { phase: "done"; lines: string[] } | { phase: "failed"; text: string } | null = null;

interface Applied {
  measured: string;
  check: string[] | null;
  problems: number[];
}

let host: AutoRibsHost | null = null;
let card: AutoRibsCard = newAutoRibsCard();
let run: RunState = idleRun();
let job: PlanJob | null = null;
/** Bumped by every new run and by closing, so a late answer is dropped. */
let generation = 0;
let read: WallRead | null = null;
let readTimer = 0;
let reading = false;
let picking: Pick = { kind: "wall" };
let hoverFace: number | null = null;
let hoverWall: number[] = [];
let lit: number | null = null;
let litZone: number | null = null;
let selectedZone: number | null = null;
let nextZone = 1;
/** The plan's ribs on the face (built from the plan), and the live ones while it runs. */
let faceRibs: FaceRib[] = [];
let liveDrawn = new Map<number, DrawnRib>();

/** The run's request and the read it came from: what the plan answers. */
let ranWith: { key: string; goal: PlanGoal; body: RibPlanBody; wall: RibWall; solid: AutoRibsSolid; caseNames: string[] | null; process: RibProcess } | null = null;
/** Tests set the build axis the resin plan uses. Absent: the part as it sits. */
let buildOverride: V3 | null = null;
let balancedFactor: number | null = null;
let edit: { head: string } | null = null;
let applying = false;
let applied: Applied | null = null;
let liftQueue = new Set<number>();
/** The case list last drawn, so typing a name or a weight does not rebuild it and drop the cursor. */
let paintedCases = "";
let liftFrame = 0;
let wallSurface: { wall: RibWall; surface: RibSurface } | null = null;

const busy = () => run.phase === "running" || run.phase === "stopping";
const root = () => document.querySelector<HTMLElement>("#modelAutoRibs");
const $ = <T extends HTMLElement>(selector: string) => root()?.querySelector<T>(selector) ?? null;

// ---------------------------------------------------------------------------
// Mount, open, close.
// ---------------------------------------------------------------------------

export function mountAutoRibsCard(next: AutoRibsHost) {
  host = next;
  const body = root();
  if (!body) return;
  document.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("#modelMenuAutoRibs")) openAutoRibsCard();
  });
  setHtml(body, html`
    <p class="model-note is-bad ar-refusal" id="autoRibsRefusal" role="alert" hidden></p>
    <fieldset class="stress-group stress-step ar-step" id="autoRibsWallStep" data-step="wall">
      <legend><span class="stress-mark" data-step-mark>1</span>Wall</legend>
      <p class="model-note ar-wall-line" id="autoRibsWallLine" role="status"></p>
      <div class="ar-wall-row">
        <label class="model-keep" data-tip="Take only the faces you click, not the faces that continue them smoothly"><input id="autoRibsJustThis" type="checkbox"> Just this face</label>
        <label class="model-keep" data-tip="Also take thin faces across a sharp edge, such as a cover's side walls. Off, a sharp edge stops the wall."><input id="autoRibsFolded" type="checkbox"> Include side walls (folded)</label>
        <button class="btn ar-small" id="autoRibsWallClear" type="button" hidden>Clear</button>
      </div>
      <ul class="ar-warnings" id="autoRibsWarnings" aria-label="About the wall"></ul>
    </fieldset>
    <fieldset class="stress-group stress-step ar-step" id="autoRibsPlanStep" data-step="plan">
      <legend><span class="stress-mark" data-step-mark>2</span>Plan</legend>
      <p class="model-note" id="autoRibsPlanHint">Run plans in the background; the window stays usable and the ribs appear as they are chosen.</p>
      <div class="ar-progress" id="autoRibsProgress" hidden>
        <div class="ar-stage-row"><span id="autoRibsStage"></span><span class="ar-percent" id="autoRibsPercent"></span></div>
        <div class="ar-bar" id="autoRibsBar" role="progressbar" aria-label="Planning" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
        <div class="ar-stage-row"><p class="model-note ar-totals" id="autoRibsTotals" role="status" aria-live="polite"></p><button class="btn ar-small" id="autoRibsStop" type="button" data-tip="Stop and keep the plan so far. Esc does it too.">Stop</button></div>
      </div>
      <p class="model-note is-bad" id="autoRibsError" role="alert" hidden></p>
    </fieldset>
    <section class="ar-result" id="autoRibsResult" aria-label="The plan" hidden>
      <div class="ar-headline"><strong id="autoRibsGain"></strong><span id="autoRibsCost"></span><span class="ar-badge" id="autoRibsStopped" hidden>stopped early</span><span class="ar-badge" id="autoRibsEdited" hidden>edited</span></div>
      <ul class="ar-lines" id="autoRibsCaseLines" aria-label="Each load case" hidden></ul>
      <p class="model-note" id="autoRibsStoppedLine" hidden>${STOPPED_LINE}</p>
      <p class="model-note is-warn" id="autoRibsGoal" hidden></p>
      <ul class="ar-lines" id="autoRibsCompare" aria-label="Compared with"></ul>
      <div id="autoRibsMoulding" hidden>
        <p class="model-note" id="autoRibsMouldingTitle">Moulding</p>
        <ul class="ar-lines" id="autoRibsMouldingList" aria-label="Moulding"></ul>
      </div>
      <p class="model-note" id="autoRibsVents" hidden></p>
      <p class="model-note ar-faint" id="autoRibsRelative">${RELATIVE_NOTE}</p>
      <ul class="tc-list ar-ribs" id="autoRibsList" aria-label="Planned ribs"></ul>
      <p class="model-note is-warn" id="autoRibsEditedNote" hidden></p>
      <p class="model-note is-warn" id="autoRibsStale" hidden>Something changed since this plan. Run again to plan with it.</p>
    </section>
    <section class="ar-result" id="autoRibsApplied" aria-label="Applied" hidden>
      <p class="model-note ar-strong" id="autoRibsAppliedLine" role="status"></p>
      <ul class="ar-lines" id="autoRibsCheck" aria-label="Print check"></ul>
      <div class="ar-stress" id="autoRibsStressBox" hidden>
        <button class="btn ar-small" id="autoRibsStress" type="button" data-tip="Slice and solve the whole part before and after the ribs, with the same holds and loads. Slow, so it runs only when asked.">Check with Stress</button>
        <p class="model-note" id="autoRibsStressLine" role="status" aria-live="polite" hidden></p>
        <ul class="ar-lines" id="autoRibsStressResult" aria-label="Stress before and after"></ul>
      </div>
      <p class="model-note ar-faint">Undo takes the whole network back as one step. Its pencil in History opens this card again to re-plan.</p>
    </section>
    <details class="stress-more ar-more" id="autoRibsHowMuch">
      <summary>How much</summary>
      <div class="modes ar-modes" role="group" aria-label="How much">
        <button class="btn mode" type="button" data-amount="slider" aria-pressed="true">Slider</button>
        <button class="btn mode" type="button" data-amount="stiffer" aria-pressed="false">Target</button>
        <button class="btn mode" type="button" data-amount="deflection" aria-pressed="false">Deflection</button>
        <button class="btn mode" type="button" data-amount="budget" aria-pressed="false">Budget</button>
      </div>
      <div class="ar-slider" data-for-amount="slider">
        <input id="autoRibsSlider" type="range" min="-2" max="2" step="1" value="0" aria-label="Lightest to stiffest" aria-valuetext="Balanced" list="autoRibsStops">
        <div class="ar-slider-ends" aria-hidden="true"><span>Lightest</span><span>Balanced</span><span>Stiffest</span></div>
        <p class="model-note ar-faint" id="autoRibsSliderNote"></p>
      </div>
      <div class="model-fields" data-for-amount="stiffer" hidden><label data-wide><span class="scrub-label">As stiff ×</span><input id="autoRibsStiffer" type="number" step="0.1" min="1.05" value="2" aria-label="Times as stiff as the bare wall"></label></div>
      <div class="model-fields" data-for-amount="deflection" hidden><label data-wide><span class="scrub-label">Deflection under mm</span><input id="autoRibsDeflection" type="number" step="0.05" min="0.01" value="0.5" aria-label="Greatest deflection, millimetres"></label></div>
      <div class="model-fields" data-for-amount="budget" hidden><label data-wide><span class="scrub-label">At most g</span><input id="autoRibsBudget" type="number" step="0.5" min="0.1" value="10" aria-label="Most rib material, grams"></label></div>
    </details>
    <details class="stress-more ar-more" id="autoRibsHoldLoad">
      <summary>Hold and load</summary>
      <p class="stress-note">${DEFAULT_HOLD_NOTE}</p>
      <button class="btn ar-small" id="autoRibsUseStress" type="button" hidden data-tip="Take the holds and loads this part's Stress study has">Use the Stress setup</button>
      <fieldset class="stress-group" id="autoRibsHold">
        <legend>Hold</legend>
        <div class="modes" role="group" aria-label="Hold">
          <button class="btn mode" id="autoRibsHoldFaces" type="button" aria-pressed="false">Faces</button>
          <button class="btn mode" id="autoRibsHoldBed" type="button" aria-pressed="false">Bed</button>
        </div>
        <div class="stress-pick-row" id="autoRibsHoldRow" hidden>
          <button class="btn stress-pick" id="autoRibsHoldPick" type="button" aria-pressed="false">Pick faces</button>
          <ul class="stress-chips" id="autoRibsHoldChips" aria-label="Held faces"></ul>
        </div>
      </fieldset>
      <fieldset class="stress-group" id="autoRibsLoad">
        <legend>Load</legend>
        <div class="modes" role="group" aria-label="Load kind">
          <button class="btn mode" id="autoRibsLoadForce" type="button" aria-pressed="true">Force N</button>
          <button class="btn mode" id="autoRibsLoadPressure" type="button" aria-pressed="false">Pressure MPa</button>
        </div>
        <label class="stress-inline"><span id="autoRibsForceLabel">Force</span><span class="stress-unit-field"><input id="autoRibsForce" type="number" step="0.1" value="10" aria-label="Load magnitude"><span class="stress-unit" id="autoRibsForceUnit">N</span></span></label>
        <div class="stress-pick-row">
          <button class="btn stress-pick" id="autoRibsLoadPick" type="button" aria-pressed="false">Pick faces</button>
          <ul class="stress-chips" id="autoRibsLoadChips" aria-label="Loaded faces"></ul>
        </div>
        <div class="stress-axis" role="group" aria-labelledby="autoRibsDirLabel">
          <span class="stress-axis-label" id="autoRibsDirLabel">Direction (X, Y, Z)</span>
          <input id="autoRibsDirX" type="number" step="0.1" value="0" aria-label="Direction X">
          <input id="autoRibsDirY" type="number" step="0.1" value="0" aria-label="Direction Y">
          <input id="autoRibsDirZ" type="number" step="0.1" value="-1" aria-label="Direction Z">
        </div>
      </fieldset>
      <div id="autoRibsCases" hidden></div>
      <button class="btn ar-small" id="autoRibsAddCase" type="button">Add a load case</button>
      <ul class="ar-warnings" id="autoRibsNotOnWall" aria-label="Not on the wall"></ul>
      <button class="btn ar-small" id="autoRibsEvenPressure" type="button" aria-pressed="false" hidden data-tip="A hold or load that misses the wall is left out and the plan says so; with no load left it runs under even pressure">Plan without it</button>
    </details>
    <details class="stress-more ar-more" id="autoRibsKeepClear">
      <summary>Keep clear <span class="model-history-count" id="autoRibsZoneCount"></span></summary>
      <p class="stress-note">A place on the wall where ribs may not stand, or only stand low. Numbers are in the part's frame.</p>
      <div class="ar-add" role="group" aria-label="Add a zone">
        <button class="btn ar-small" type="button" data-add-zone="faces" data-tip="Click faces of the wall: no ribs on them">Faces</button>
        <button class="btn ar-small" type="button" data-add-zone="box" data-tip="Click the wall where the box goes, then drag its arrows or type its numbers">Box</button>
        <button class="btn ar-small" type="button" data-add-zone="sphere" data-tip="Click the wall where the sphere goes">Sphere</button>
        <button class="btn ar-small" type="button" data-add-zone="cylinder" data-tip="Click the wall: a cylinder along the wall's normal there">Cylinder</button>
        <button class="btn ar-small" type="button" data-add-zone="nearHoles" data-tip="Within some millimetres of every hole in the wall">Near holes</button>
        <button class="btn ar-small" type="button" data-add-zone="nearFaces" data-tip="Within some millimetres of faces you click">Near faces</button>
        <button class="btn ar-small" type="button" data-add-zone="band" data-tip="Click the wall: everything beyond a plane through that point">Beyond a plane</button>
        <button class="btn ar-small" type="button" data-add-zone="obstacle" data-tip="Another object on the plate that sits in front of the wall, with a clearance">Another object</button>
      </div>
      <p class="model-note is-prompt" id="autoRibsPlaceHint" role="status" hidden></p>
      <ul class="ar-zones" id="autoRibsZones" aria-label="Keep-clear zones"></ul>
      <div class="ar-wall-row">
        <label class="model-keep"><input id="autoRibsRimOn" type="checkbox" checked> Keep clear of hole rims</label>
        <label class="ar-inline"><input id="autoRibsRimMm" type="number" step="0.5" min="0" value="3" aria-label="Rim margin, millimetres"> mm</label>
      </div>
    </details>
    <details class="stress-more ar-more" id="autoRibsSizes">
      <summary>Ribs</summary>
      <label class="ar-inline-row"><span class="scrub-label">Process</span><select id="autoRibsProcess" aria-label="Process"><option value="filament">Filament</option><option value="resin">Resin</option><option value="moulded">Moulded</option></select></label>
      <div class="modes ar-modes" id="autoRibsProfile" role="group" aria-label="Rib profile">
        <button class="btn mode" type="button" data-profile="auto" aria-pressed="true">Automatic</button>
        <button class="btn mode" type="button" data-profile="straight" aria-pressed="false">Straight</button>
        <button class="btn mode" type="button" data-profile="drafted" aria-pressed="false">Drafted</button>
        <button class="btn mode" type="button" data-profile="tee" aria-pressed="false">T-rib</button>
      </div>
      <p class="stress-note" id="autoRibsProfileNote">${AUTOMATIC_NOTE}</p>
      <div class="model-fields">
        <label><span class="scrub-label">Thickness</span><input id="autoRibsWidth" type="number" step="0.05" min="0.2" aria-label="Rib thickness, millimetres"></label>
        <label><span class="scrub-label">Greatest height</span><input id="autoRibsHeight" type="number" step="0.5" min="0.5" aria-label="Greatest rib height, millimetres"></label>
      </div>
      <ul class="ar-lines ar-faint" id="autoRibsDefaults" aria-label="Defaults"></ul>
    </details>
    <p class="model-note ar-faint" id="autoRibsSourceNote" hidden>Planned by the test stand-in, not the engine: the numbers are made up.</p>`);
  body.addEventListener("click", onClick);
  body.addEventListener("input", onInput);
  body.addEventListener("change", onInput);
  body.addEventListener("pointerover", (ev) => hoverList(ev.target, true));
  body.addEventListener("pointerout", (ev) => hoverList(ev.target, false));
  body.addEventListener("focusin", (ev) => hoverList(ev.target, true));
  body.addEventListener("focusout", (ev) => hoverList(ev.target, false));
  const canvas = document.querySelector<HTMLCanvasElement>("#model");
  canvas?.addEventListener("pointermove", onCanvasMove);
  canvas?.addEventListener("pointerleave", () => {
    if (hoverFace == null && lit == null) return;
    hoverFace = null;
    hoverWall = [];
    if (lit != null && run.plan) setLit(null);
    refreshModelCard();
  });
}

/** The Features menu's Auto ribs…: the card opens on the solid on screen, with nothing picked. */
export function openAutoRibsCard() {
  if (!host) return;
  edit = null;
  begin(newAutoRibsCard());
}

/** The pencil on an "Auto ribs" row: the card opens on the parent solid with the step's stored request. */
export function openAutoRibsEdit(stored: AutoRibsCard | null, head: string) {
  if (!host) return;
  edit = { head };
  begin(stored ?? newAutoRibsCard(), stored ? undefined : "This step was not made by the panel: pick its wall again to re-plan it.");
}

export function autoRibsCardOpen(): boolean {
  return modelCardOpen() === CARD_ID;
}

function begin(next: AutoRibsCard, note?: string) {
  generation += 1;
  job?.cancel();
  job = null;
  card = structuredClone(next);
  paintedCases = "";
  run = idleRun();
  read = null;
  faceRibs = [];
  liveDrawn = new Map();
  ranWith = null;

  applied = null;
  stressRun = null;
  lastSetup = null;
  picking = { kind: "wall" };
  hoverFace = null;
  hoverWall = [];
  lit = null;
  litZone = null;
  selectedZone = null;
  nextZone = Math.max(1, ...card.zones.map((zone) => zone.id + 1));
  root()?.toggleAttribute("hidden", false);
  openModelCard({ id: CARD_ID, title: AUTO_RIBS_TITLE, ghost, handles, drag, closed, escape });
  const title = document.querySelector<HTMLElement>("#modelEditHead");
  if (title) {
    title.hidden = !edit;
    title.textContent = edit?.head ?? "";
  }
  document.querySelector("#modelPanel")?.setAttribute("aria-labelledby", edit ? "modelEditHead" : "modelPanelTitle");
  host?.pickFaces();
  writeFields();
  const state = host?.state() ?? "none";
  host?.readout(state === "ok" ? note ?? (card.picked.length ? "Check the wall, then Run." : "Click the inside wall to reinforce, then Run.") : state === "surfaces" ? OPEN_SHELL : NO_SOLID);
  if (card.picked.length) queueRead(0);
  paint();
}

function closed() {
  if (applying) return;
  generation += 1;
  job?.cancel();
  job = null;
  window.clearTimeout(readTimer);
  root()?.toggleAttribute("hidden", true);
  const head = document.querySelector<HTMLElement>("#modelEditHead");
  if (head && edit) head.hidden = true;
  document.querySelector("#modelPanel")?.setAttribute("aria-labelledby", "modelPanelTitle");
  const apply = document.querySelector("#modelApply");
  if (apply) apply.textContent = "Apply";
  const cancel = document.querySelector("#modelCancel");
  if (cancel) cancel.textContent = "Cancel";
  const wasEdit = edit && !applied;
  edit = null;
  run = idleRun();
  read = null;
  faceRibs = [];
  liveDrawn = new Map();
  applied = null;
  stressRun = null;
  lastSetup = null;
  if (wasEdit) host?.cancelled();
}

/** Esc: a running plan stops first, then a pick ends; otherwise the card closes. */
function escape(): boolean {
  if (busy()) {
    stop();
    return true;
  }
  if (picking.kind !== "wall") {
    picking = { kind: "wall" };
    paint();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The wall and its read.
// ---------------------------------------------------------------------------

/** Whether the card takes a click on the part; it then does what the open pick says. */
export function autoRibsTakesPick(pick: { kind: "face" | "edge"; index: number; at?: V3 } | null): boolean {
  if (!autoRibsCardOpen() || !host || applied) return false;
  if (!pick || pick.kind !== "face") return true;
  if (busy()) {
    host.readout("The plan is running. Stop it to change the wall.");
    return true;
  }
  const face = pick.index;
  if (picking.kind === "wall") {
    const solid = host.solid();
    if (!solid) return true;
    card = clickWall(card, face, takenFaces());
    changed();
    return true;
  }
  if (picking.kind === "hold") {
    const faces = card.holds.find((hold) => hold.kind === "faces")?.faces ?? [];
    card = { ...card, holds: [{ kind: "faces", faces: toggled(faces, face) }] };
    changed();
    return true;
  }
  if (picking.kind === "load") {
    if (picking.case != null && (card.cases?.length ?? 0) >= 2) {
      const at = picking.case;
      card = { ...card, cases: card.cases!.map((row, i) => (i === at ? { ...row, loads: [withFace(row.loads[0] ?? freshLoad(), face)] } : row)) };
    } else {
      const load = card.loads[0] ?? readLoad([]);
      card = { ...card, loads: [{ ...load, faces: toggled(load.faces, face) }] };
    }
    changed();
    return true;
  }
  if (picking.kind === "zoneFaces") {
    const id = picking.zone;
    card = { ...card, zones: card.zones.map((zone) => (zone.id === id && (zone.shape.kind === "faces" || zone.shape.kind === "nearFaces") ? { ...zone, shape: { ...zone.shape, faces: toggled(zone.shape.faces, face) } } : zone)) };
    changed();
    return true;
  }
  // A place zone: where the click landed on the wall, the wall's normal there, sized from the wall.
  const at = pick.at ?? faceCentre(face);
  if (!at) return true;
  const zone = newZone(nextZone++, picking.shape, at, wallExtent(), faceNormal(face) ?? [0, 0, 1]);
  card = { ...card, zones: [...card.zones, zone] };
  selectedZone = zone.id;
  picking = { kind: "wall" };
  changed();
  return true;
}

const toggled = (faces: readonly number[], face: number) => (faces.includes(face) ? faces.filter((f) => f !== face) : [...faces, face]);

/** The faces the wall takes now: the read's, else worked out here. */
function takenFaces(): number[] {
  if (read?.wall && read.key === readKey()) return read.wall.faces;
  const solid = host?.solid();
  if (!solid || card.picked.length === 0) return [];
  return wallFaces({ positions: solid.positions, faceOf: solid.faceOf }, { picked: card.picked, excludeFaces: card.excluded, ...growthOptions() }).faces;
}

/** Growth for the wall read, the hover and the local face list. Folded is passed only when the box is on. */
function growthOptions(): { grow?: false; folded?: true } {
  return {
    ...(card.justThis ? { grow: false } : {}),
    ...(card.folded && !card.justThis ? { folded: true } : {}),
  };
}

function wallOptions(): RibWallOptions | null {
  if (!host) return null;
  const zones = zoneInputs(card.zones, (id) => host!.obstacle(id));
  const minHeight = 1;
  const asked = loadRequest(card.loads, card.cases);
  return {
    picked: card.picked,
    ...growthOptions(),
    ...(card.excluded.length ? { excludeFaces: card.excluded } : {}),
    zones: zones.inputs,
    holds: card.holds,
    ...(asked.loadCases ? { loadCases: asked.loadCases } : { loads: card.loads }),
    minRibHeightMm: minHeight,
    ...(card.ifMissed === "evenPressure" ? { ifMissed: "evenPressure" as const } : {}),
  };
}

function readKey(): string {
  const solid = host?.solid();
  return JSON.stringify([solid?.key ?? "", card.picked, card.excluded, card.justThis, card.folded, card.zones, card.holds, card.loads, card.cases ?? null, card.ifMissed]);
}

function queueRead(wait: number) {
  window.clearTimeout(readTimer);
  readTimer = window.setTimeout(() => void readWall(), wait);
}

async function readWall() {
  if (!host || card.picked.length === 0) {
    read = null;
    paint();
    return;
  }
  const key = readKey();
  if (read?.key === key) return;
  const options = wallOptions();
  if (!options) return;
  const mine = generation;
  const zones = zoneInputs(card.zones, (id) => host!.obstacle(id));
  reading = true;
  paint();
  const wall = await host.readWall(options);
  if (mine !== generation || key !== readKey()) return;
  reading = false;
  // A hold or load that misses the wall is refused by name (never planned under even pressure in its place) unless
  // "Plan without it" is on; the refusal opens Hold and load, where the button is.
  const missed = "reason" in wall ? wall.missed ?? [] : [];
  read = "reason" in wall ? { key, wall: null, error: missed.length ? `${wall.reason} ${EVEN_PRESSURE_OFFER}` : wall.reason, missed, rows: zones.rows, gone: zones.gone } : { key, wall, error: null, missed: [], rows: zones.rows, gone: zones.gone };
  if (missed.length) $<HTMLDetailsElement>("#autoRibsHoldLoad")?.setAttribute("open", "");
  if (run.phase === "idle") host.readout(read.wall ? wallReadout(read.wall.report, read.wall.faces.length) : read.error ?? "");

  paint();
}

function rulesFor(wall: RibWall): RibRulesChosen {
  const outer = wall.report.loops.reduce((most, loop) => Math.max(most, loop.lengthMm), 0);
  return ribRules({
    process: card.ribs.process,
    nozzleMm: host?.nozzleMm() ?? 0.4,
    thicknessMm: wall.report.thickness.medianMm,
    areaMm2: wall.report.areaMm2,
    outerLoopMm: outer,
    given: { ...(card.ribs.width != null ? { width: card.ribs.width } : {}), ...(card.ribs.height != null ? { maxHeight: card.ribs.height } : {}) },
  });
}

function changed() {
  queueRead(250);
  paint();
}

// ---------------------------------------------------------------------------
// Run, Stop, Apply.
// ---------------------------------------------------------------------------

/** The footer's primary button (Enter): Run, Apply, or Done after an Apply. */
export async function autoRibsPrimary() {
  if (!host) return;
  if (applied) {
    closeModelCard();
    return;
  }
  if (busy()) return;
  if (run.phase === "done" && applicable(run) && !planStale()) {
    await applyPlan();
    return;
  }
  await startRun();
}

function planStale(): boolean {
  const axis = JSON.stringify(ranWith?.body.buildAxis ?? null);
  const now = JSON.stringify(resinAxis());
  return !!ranWith && (ranWith.key !== readKey() || JSON.stringify(ranWith.goal) !== JSON.stringify(currentGoal()) || JSON.stringify(ranWith.body.rules) !== JSON.stringify(bodyRules(ranWith.wall)) || axis !== now);
}

/** The resin build axis in the wall frame. Plate +Z unless the test named one. Filament plans carry none. */
function resinAxis(): V3 | null {
  if (!host || ranWith?.process !== "resin") return null;
  const frame = host.plate();
  return plateToWall(frame.orient, frame.pose, buildOverride ?? [0, 0, 1]);
}

function ventLoops(wall: RibWall) {
  return ventLoopsOf(wall);
}

function currentGoal(): PlanGoal {
  return goalOf(card.amount, host?.densityGCm3() ?? 1.24, balancedFactor);
}

function bodyRules(wall: RibWall): RibPlanBody["rules"] {
  const chosen = rulesFor(wall);
  const step = Math.max(1, Math.floor(wall.normals.length / 64));
  const flange = planFlange(wall.normals.filter((_, i) => i % step === 0), host?.build() ?? [0, 0, 1]).flange;
  return { width: chosen.width, maxHeight: chosen.maxHeight, minHeight: chosen.minHeight, minSpacing: chosen.minSpacing, minLength: chosen.minLength, profile: wireProfileOf(card.ribs.profile, card.ribs.process, flange) as RibPlanBody["rules"]["profile"] };
}

async function startRun() {
  if (!host) return;
  const state = host.state();
  if (state !== "ok") {
    host.readout(state === "surfaces" ? OPEN_SHELL : NO_SOLID);
    return;
  }
  if (card.picked.length === 0) {
    host.readout("Click the inside wall first: Run plans ribs on it.");
    return;
  }
  if (!read || read.key !== readKey()) {
    window.clearTimeout(readTimer);
    await readWall();
  }
  const solid = host.solid();
  if (!read?.wall || !solid) {
    if (read?.error) host.readout(read.error);
    paint();
    return;
  }
  const wall = read.wall;
  const goal = currentGoal();
  const sent: RibPlanBody["request"] = wall.request.holds.holds.length === 0 ? { ...wall.request, holds: { kind: "allBoundary" } } : wall.request;
  const material = host.material();
  materialNote = material?.note ?? "";
  const asked = loadRequest(card.loads, card.cases);
  const vent = ventBodyOf(card.ribs.process, host.plate(), ventLoops(wall), buildOverride);
  const body: RibPlanBody = { request: sent, ...(material ? { material: { e: material.e, nu: material.nu } } : {}), rules: bodyRules(wall), goal, options: { baselines: true }, holeRimMarginMm: card.holeRim.on ? Math.max(0, card.holeRim.mm) : 0, ...(asked.caseWeights ? { caseWeights: asked.caseWeights } : {}), ...vent };

  generation += 1;
  const mine = generation;
  job?.cancel();
  run = startedRun();
  faceRibs = [];
  liveDrawn = new Map();
  lit = null;
  ranWith = { key: read.key, goal, body, wall, solid, caseNames: (card.cases?.length ?? 0) >= 2 ? card.cases!.map((row) => row.name) : null, process: card.ribs.process };
  const source = host.source();
  const note = $<HTMLElement>("#autoRibsSourceNote");
  if (note) note.hidden = source.kind !== "stand-in";
  host.readout("Planning ribs…");
  paint();
  const started = source.start(body, (event) => {
    if (mine !== generation) return;
    run = runEvent(run, event);
    if (event.kind === "rib") {
      if (event.change === "removed") liveDrawn.delete(event.id);
      else liftQueue.add(event.id);
      scheduleLift();
    }
    paintProgress();
  });
  job = started;
  const reply = await started.done;
  if (mine !== generation) return;
  job = null;
  run = runDone(run, reply);
  if (reply.ok) {
    const built = ribsOnFace({ positions: solid.positions, faceOf: solid.faceOf }, wall, reply.plan.ribs, host.build(), body.rules.width);
    faceRibs = built.ribs;
    if (goal.kind === "balanced" && !reply.plan.stoppedEarly) balancedFactor = reply.plan.stiffnessFactor;
    host.readout(reply.plan.ribs.length === 0 ? (reply.plan.stoppedEarly ? "Stopped before the first rib: nothing to apply." : "No rib pays on this wall under these rules.") : reply.plan.stoppedEarly ? "Stopped early. The plan so far can be applied." : "Check the plan, then Apply.");
  } else host.readout(reply.reason);
  paint();
}

function stop() {
  if (run.phase !== "running" || !job) return;
  // The answer moves the run on: the plan so far, marked stopped early.
  run = { ...run, phase: "stopping" };
  job.cancel();
  host?.readout("Stopping: the plan so far comes back in a moment.");
  paint();
}

/** Each live rib off the mid-surface onto the face, once a frame for what changed. */
function scheduleLift() {
  if (liftFrame) return;
  liftFrame = window.requestAnimationFrame(() => {
    liftFrame = 0;
    if (!ranWith) return;
    const ids = [...liftQueue].filter((id) => run.ribs.some((rib) => rib.id === id));
    liftQueue = new Set();
    if (ids.length === 0) return;
    const { solid, wall } = ranWith;
    const ribs = ids.map((id) => run.ribs.find((rib) => rib.id === id)!);
    const lifted = ribPathsFromPlan({ positions: solid.positions, faceOf: solid.faceOf }, wall, ribs.map((rib) => rib.points));
    if (wallSurface?.wall !== wall) wallSurface = { wall, surface: wallSurfaceOf({ positions: solid.positions, faceOf: solid.faceOf }, wall.faces) };
    const surface = wallSurface.surface;
    ribs.forEach((rib, i) => {
      const points = lifted.paths[i]!.points;
      liveDrawn.set(rib.id, { points, normals: points.map((p) => surface.closest(p, 5)?.normal ?? [0, 0, 1]), heights: rib.heights, width: ranWith!.body.rules.width });
    });
    refreshModelCard();
    const canvas = document.querySelector<HTMLElement>("#model");
    if (canvas) canvas.dataset.autoRibsLive = String(liveDrawn.size);
  });
}

async function applyPlan() {
  if (!host || !ranWith) return;
  const kept = keptRibs(run);
  const keptFace = faceRibs.filter((_, i) => !run.removed.includes(i));
  if (kept.length === 0 || keptFace.length === 0) {
    host.readout("Every rib was taken out: there is nothing to apply.");
    return;
  }
  const built: BuiltRib[] = keptFace.map((rib) => ({ points: rib.points, heights: rib.heights, width: rib.width, profile: (rib.sections[0]?.profile ?? "straight"), sections: rib.sections }));
  const plan = run.plan!;
  const auto = { panel: card, plan: { ribs: kept.length, stiffnessFactor: plan.stiffnessFactor, ribVolumeMm3: plan.ribVolumeMm3, stoppedEarly: plan.stoppedEarly, edited: run.removed.length > 0 } };
  const op = ribNetOf(built, AUTO_RIBS_LABEL, auto);
  if ("reason" in op) {
    host.readout(String(op.reason));
    return;
  }
  const boxes = keptFace.map((rib) => ribBox({ points: rib.points, normals: rib.normals, heights: rib.heights, width: rib.width }));
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (button) button.disabled = true;
  host.readout(`Adding ${kept.length} rib${kept.length === 1 ? "" : "s"}…`);
  const before = await host.check();
  applying = true;
  let done: Awaited<ReturnType<AutoRibsHost["apply"]>>;
  try {
    done = await host.apply(op);
  } finally {
    applying = false;
  }
  if (!done.ok) {
    host.readout(`${done.reason} The solid is unchanged.`);
    const error = $<HTMLElement>("#autoRibsError");
    if (error) {
      error.hidden = false;
      error.textContent = `Apply failed: ${done.reason} The solid is unchanged.`;
    }
    paint();
    return;
  }
  const density = host.densityGCm3();
  applied = { measured: measuredLine(done.beforeMm3, done.afterMm3, density), check: null, problems: [] };
  stressRun = null;
  lastSetup = { holds: card.holds, loads: card.loads, wallFaces: ranWith.wall.faces, joinedFaces: [...new Set(ranWith.wall.report.faces.stops.map((row) => row.face))].filter((face) => !ranWith!.wall.faces.includes(face)), ...((card.cases?.length ?? 0) >= 2 ? { cases: card.cases!.map((row) => ({ name: row.name, loads: row.loads })) } : {}) };
  edit = null;
  // Apply closed the card with the tool: it opens again on the new solid, with what was measured.
  root()?.toggleAttribute("hidden", false);
  openModelCard({ id: CARD_ID, title: AUTO_RIBS_TITLE, ghost, handles: () => [], drag: () => undefined, closed, escape });
  paint();
  host.readout(`Auto ribs: ${kept.length} rib${kept.length === 1 ? "" : "s"}, one History step. ${applied.measured}`);
  const after = await host.check();
  if (!applied || !before || !after) {
    if (applied) applied.check = ["The print check could not run."];
  } else {
    const lines = checkLines(host.printerName(), before, after, boxes);
    applied.check = lines.lines;
    applied.problems = lines.problems;
  }
  paint();
}

// ---------------------------------------------------------------------------
// Drawing.
// ---------------------------------------------------------------------------

function writeFields() {
  const set = (id: string, value: string) => {
    const input = $<HTMLInputElement>(id);
    if (input) input.value = value;
  };
  const check = (id: string, on: boolean) => {
    const input = $<HTMLInputElement>(id);
    if (input) input.checked = on;
  };
  check("#autoRibsJustThis", card.justThis);
  check("#autoRibsFolded", card.folded);
  check("#autoRibsRimOn", card.holeRim.on);
  set("#autoRibsRimMm", String(card.holeRim.mm));
  set("#autoRibsProcess", card.ribs.process);
  set("#autoRibsWidth", card.ribs.width == null ? "" : String(card.ribs.width));
  set("#autoRibsHeight", card.ribs.height == null ? "" : String(card.ribs.height));
  const a = card.amount;
  set("#autoRibsSlider", String(a.kind === "slider" ? a.stop : 0));
  if (a.kind === "stiffer") set("#autoRibsStiffer", String(a.factor));
  if (a.kind === "deflection") set("#autoRibsDeflection", String(a.mm));
  if (a.kind === "budget") set("#autoRibsBudget", String(a.grams));
  const load = card.loads[0];
  if (load) {
    set("#autoRibsForce", String(load.magnitude));
    set("#autoRibsDirX", String(load.direction[0]));
    set("#autoRibsDirY", String(load.direction[1]));
    set("#autoRibsDirZ", String(load.direction[2]));
  }
  for (const details of ["#autoRibsHowMuch", "#autoRibsHoldLoad", "#autoRibsKeepClear", "#autoRibsSizes"]) {
    const node = $<HTMLDetailsElement>(details);
    if (!node) continue;
    // A section the request uses opens with it; the rest stay folded.
    const used = details === "#autoRibsHowMuch" ? !(a.kind === "slider" && a.stop === 0) : details === "#autoRibsHoldLoad" ? card.holds.length + card.loads.length > 0 || (card.cases?.length ?? 0) >= 2 : details === "#autoRibsKeepClear" ? card.zones.length > 0 : card.ribs.width != null || card.ribs.height != null || card.ribs.profile !== "auto" || card.ribs.process !== "filament";
    node.open = used;
  }
}

function press(node: Element | null, on: boolean) {
  node?.setAttribute("aria-pressed", on ? "true" : "false");
  node?.classList.toggle("on", on);
}

function paint() {
  if (!autoRibsCardOpen() || !host) return;
  const state = host.state();
  const refusal = $<HTMLElement>("#autoRibsRefusal");
  if (refusal) {
    refusal.hidden = state === "ok";
    refusal.textContent = state === "surfaces" ? OPEN_SHELL : state === "none" ? NO_SOLID : "";
  }
  for (const id of ["#autoRibsWallStep", "#autoRibsPlanStep", "#autoRibsHowMuch", "#autoRibsHoldLoad", "#autoRibsKeepClear", "#autoRibsSizes"]) {
    const node = $<HTMLElement>(id);
    if (node) node.hidden = state !== "ok" || !!applied;
  }
  paintWall();
  paintProgress();
  paintResult();
  paintApplied();
  paintHowMuch();
  paintHoldLoad();
  paintZones();
  paintSizes();
  paintFoot();
  refreshModelCard();
}

function paintWall() {
  const line = $<HTMLElement>("#autoRibsWallLine");
  const taken = card.picked.length;
  const wall = read?.key === readKey() ? read.wall : null;
  if (line) {
    line.textContent = read?.error && read.key === readKey() ? read.error : wallLine(wall?.report ?? null, taken ? Math.max(taken, takenFaces().length) : 0);
    line.classList.toggle("is-prompt", taken === 0);
    line.classList.toggle("is-bad", !!read?.error && read.key === readKey());
  }
  const clear = $<HTMLButtonElement>("#autoRibsWallClear");
  if (clear) clear.hidden = taken === 0;
  const warnings = $<HTMLElement>("#autoRibsWarnings");
  if (warnings) {
    const rows = wall?.report.warnings ?? [];
    warnings.replaceChildren(...rows.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
  }
  mark("#autoRibsWallStep", "1", !!wall);
  mark("#autoRibsPlanStep", "2", run.phase === "done" && !!run.plan);
}

function mark(id: string, number: string, done: boolean) {
  const step = $<HTMLElement>(id);
  const markNode = step?.querySelector<HTMLElement>("[data-step-mark]");
  if (!step || !markNode) return;
  step.toggleAttribute("data-done", done);
  if (done) {
    markNode.replaceChildren(createElement(Check, { width: 12, height: 12, "aria-hidden": "true", class: "ico" }));
    markNode.setAttribute("role", "img");
    markNode.setAttribute("aria-label", "Done");
  } else {
    markNode.textContent = number;
    markNode.removeAttribute("role");
    markNode.removeAttribute("aria-label");
  }
}

function paintProgress() {
  const box = $<HTMLElement>("#autoRibsProgress");
  if (box) box.hidden = run.phase === "idle" || (run.phase === "failed" && run.ribs.length === 0) || run.phase === "done";
  const hint = $<HTMLElement>("#autoRibsPlanHint");
  if (hint) hint.hidden = run.phase !== "idle";
  const stage = $<HTMLElement>("#autoRibsStage");
  if (stage) stage.textContent = stageName(run.stage);
  const percent = Math.round(run.fraction * 100);
  const pct = $<HTMLElement>("#autoRibsPercent");
  if (pct) pct.textContent = `${percent} %`;
  const bar = $<HTMLElement>("#autoRibsBar");
  if (bar) {
    bar.setAttribute("aria-valuenow", String(percent));
    bar.dataset.fraction = String(run.fraction);
    const fill = bar.querySelector<HTMLElement>("span");
    if (fill) fill.style.width = `${percent}%`;
  }
  const totals = $<HTMLElement>("#autoRibsTotals");
  if (totals) totals.textContent = totalsLine(run.totals, host?.densityGCm3() ?? 1.24, host?.solid()?.volumeMm3 ?? 0);
  const stopButton = $<HTMLButtonElement>("#autoRibsStop");
  if (stopButton) {
    stopButton.disabled = run.phase !== "running" || !job;
    stopButton.textContent = run.phase === "stopping" ? "Stopping…" : "Stop";
  }
  const error = $<HTMLElement>("#autoRibsError");
  if (error && run.phase !== "idle") {
    error.hidden = run.phase !== "failed";
    if (run.phase === "failed") error.textContent = run.error ?? "";
  }
  refreshModelCard();
}

/** What the kept ribs add as built (ribNet's own plan of them on the solid), worked out once per set of kept ribs. */
let built: { key: string; mm3: number | null } | null = null;
function builtNow(): number | null {
  if (!ranWith || faceRibs.length === 0) return null;
  const key = JSON.stringify([ranWith.key, run.removed, faceRibs.length]);
  if (built?.key !== key) {
    const kept = faceRibs.filter((_, i) => !run.removed.includes(i));
    built = { key, mm3: kept.length ? builtVolumeOf({ positions: ranWith.solid.positions, faceOf: ranWith.solid.faceOf }, kept) : 0 };
  }
  return built.mm3;
}

function paintResult() {
  const section = $<HTMLElement>("#autoRibsResult");
  const plan = run.plan;
  if (section) section.hidden = !plan || !!applied;
  if (!plan || !host) return;
  const density = host.densityGCm3();
  const part = ranWith?.solid.volumeMm3 ?? host.solid()?.volumeMm3 ?? 0;
  const numbers = resultNumbers(run, density, part, builtNow());
  const set = (id: string, text: string, show = true) => {
    const node = $<HTMLElement>(id);
    if (!node) return;
    node.textContent = text;
    node.hidden = !show || text === "";
  };
  set("#autoRibsGain", plan.ribs.length ? numbers?.gain ?? "" : "No ribs");
  const caseLines = $<HTMLElement>("#autoRibsCaseLines");
  if (caseLines) {
    const lines = caseResultLines(ranWith?.caseNames ?? [], plan.caseFactors, plan.caseDeflectionMm);
    caseLines.hidden = lines.length === 0;
    caseLines.replaceChildren(...lines.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
  }
  set("#autoRibsCost", plan.ribs.length ? numbers?.cost ?? "" : "");
  const stopped = $<HTMLElement>("#autoRibsStopped");
  if (stopped) stopped.hidden = !plan.stoppedEarly;
  const stoppedLine = $<HTMLElement>("#autoRibsStoppedLine");
  if (stoppedLine) stoppedLine.hidden = !plan.stoppedEarly || plan.ribs.length === 0;
  const editedBadge = $<HTMLElement>("#autoRibsEdited");
  if (editedBadge) editedBadge.hidden = run.removed.length === 0;
  set("#autoRibsGoal", [ranWith ? goalLine(ranWith.goal, plan, density) : "", looseLine(plan)].filter(Boolean).join(" "));
  set("#autoRibsEditedNote", editedNote(run));
  // The card named once: the shell was solved with it, and the panel says whether it is the filament's or the default.
  set("#autoRibsRelative", materialNote ? `Stiffness numbers are relative: the wall is solved as a thin shell. Material: ${materialNote}` : RELATIVE_NOTE);
  const stale = $<HTMLElement>("#autoRibsStale");
  if (stale) stale.hidden = !planStale();
  const compare = $<HTMLElement>("#autoRibsCompare");
  if (compare) {
    compare.replaceChildren(...(plan.ribs.length ? comparisonLines(plan, density) : []).map((text, i, all) => {
      const li = document.createElement("li");
      li.textContent = text;
      if (i === all.length - 1 && plan.notBetterThanBaseline) li.className = "is-warn";
      return li;
    }));
  }
  const vents = $<HTMLElement>("#autoRibsVents");
  if (vents) {
    const n = plan.vents?.pockets.length ?? 0;
    const unvented = plan.vents?.unvented ?? [];
    const m = unvented.length;
    const reasons = [...new Set(unvented.map((item) => item.message))].join("; ");
    const extra = [plan.vents?.note, ...(plan.notes ?? [])].filter((line): line is string => typeof line === "string" && line.length > 0);
    let sentence = "";
    if (n > 0) sentence = `${n} pocket${n === 1 ? "" : "s"} vented, ${m} could not be vented`;
    else if (m > 0) sentence = `${m} could not be vented: ${reasons}`;
    else {
      const refusal = extra.find((line) => !line.startsWith("Stand-in:"));
      if (refusal) sentence = refusal;
    }
    if (sentence) {
      const rest = extra.filter((line) => line !== sentence && !sentence.includes(line));
      if (rest.length > 0) sentence = `${sentence}. ${rest.join(" ")}`;
    }
    const show = ranWith?.process === "resin" && sentence.length > 0;
    vents.hidden = !show;
    vents.textContent = show ? sentence : "";
  }
  const moulding = $<HTMLElement>("#autoRibsMoulding");
  const mouldingList = $<HTMLElement>("#autoRibsMouldingList");
  if (moulding && mouldingList) {
    const show = ranWith?.process === "moulded" && plan.ribs.length > 0;
    moulding.hidden = !show;
    if (show && ranWith) {
      const mesh = ranWith.wall.request.mesh;
      const report = mouldingReport(faceRibs.map((rib, i) => (run.removed.includes(i) ? { points: [], heights: [], sections: [], normals: [], wallMm: [] } : { points: rib.points, heights: rib.heights, sections: rib.sections, normals: rib.normals, wallMm: rib.points.map((p) => nearestWallMm(mesh.vertices, mesh.thickness, p)) })));
      const lines = mouldingLines(report);
      mouldingList.replaceChildren(...lines.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        if (!text.startsWith("Moulding checks pass")) li.className = "is-warn";
        return li;
      }));
    }
  }
  const list = $<HTMLElement>("#autoRibsList");
  if (list) {
    list.replaceChildren(...plan.ribs.map((rib, i) => {
      const face = faceRibs[i];
      const out = run.removed.includes(i);
      const item = document.createElement("li");
      item.className = "tc-found-row ar-rib";
      item.dataset.rib = String(i);
      item.toggleAttribute("data-removed", out);
      item.classList.toggle("is-lit", lit === i);
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "tc-found-pick";
      pick.dataset.litRib = String(i);
      pick.setAttribute("aria-label", `Rib ${i + 1}: ${fmt(rib.lengthMm, 0)} mm long, up to ${fmt(rib.height, 1)} mm tall${out ? ", taken out" : ""}`);
      const name = document.createElement("span");
      name.className = "tc-case";
      name.textContent = `Rib ${i + 1}`;
      const size = document.createElement("span");
      size.className = "tc-length";
      size.textContent = `${fmt(grams(rib.volumeMm3, density), 1)} g`;
      const what = document.createElement("span");
      what.className = "tc-fix-text";
      what.dataset.tip = `${fmt(rib.lengthMm, 0)} mm · up to ${fmt(rib.height, 1)} mm tall · ${face?.why ?? "straight"}`;
      what.textContent = `${fmt(rib.lengthMm, 0)} mm · up to ${fmt(rib.height, 1)} mm tall · ${face?.profile ?? "straight"}${face?.why && face.why !== "straight" && face.why !== face.profile ? ` · ${face.why}` : ""}`;
      pick.append(name, size, what);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn tc-fix ar-remove";
      remove.dataset.removeRib = String(i);
      remove.setAttribute("aria-label", out ? `Put rib ${i + 1} back` : `Take rib ${i + 1} out of the plan`);
      remove.dataset.tip = out ? "Put this rib back in the plan" : "Take this rib out of the plan before applying";
      if (out) remove.textContent = "Back";
      else remove.append(createElement(X, { width: 12, height: 12, "aria-hidden": "true", class: "ico" }));
      item.append(pick, remove);
      return item;
    }));
  }
}

function paintApplied() {
  const section = $<HTMLElement>("#autoRibsApplied");
  if (section) section.hidden = !applied;
  if (!applied) return;
  const line = $<HTMLElement>("#autoRibsAppliedLine");
  if (line) line.textContent = applied.measured;
  const list = $<HTMLElement>("#autoRibsCheck");
  if (list) {
    const rows = applied.check ?? ["Checking the part for the current printer…"];
    list.replaceChildren(...rows.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      if (/^Rib/.test(text)) li.className = "is-warn";
      return li;
    }));
  }
  const box = $<HTMLElement>("#autoRibsStressBox");
  if (box) box.hidden = !host?.stressAvailable() || !lastSetup;
  const button = $<HTMLButtonElement>("#autoRibsStress");
  if (button) {
    button.disabled = stressRun?.phase === "running";
    button.textContent = stressRun?.phase === "done" ? "Check again" : "Check with Stress";
    button.dataset.tip = (lastSetup?.cases?.length ?? 0) >= 2 ? "Slice and solve the whole part before and after the ribs, once per load case. Each case adds two slices and two solves." : "Slice and solve the whole part before and after the ribs, with the same holds and loads. Slow, so it runs only when asked.";
  }
  const status = $<HTMLElement>("#autoRibsStressLine");
  if (status) {
    const text = stressRun?.phase === "running" || stressRun?.phase === "failed" ? stressRun.text : "";
    status.textContent = text;
    status.hidden = text === "";
    status.classList.toggle("is-bad", stressRun?.phase === "failed");
  }
  const result = $<HTMLElement>("#autoRibsStressResult");
  if (result) result.replaceChildren(...(stressRun?.phase === "done" ? stressRun.lines : []).map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));
}

/** The opt-in Stress check after Apply: two sliced solves, with what each says while it runs. */
async function runStressCheck() {
  if (!host || !lastSetup || stressRun?.phase === "running") return;
  const mine = generation;
  stressRun = { phase: "running", text: "Starting the Stress check…" };
  paint();
  const reply = await host.stressCheck(lastSetup, (text) => {
    if (mine !== generation) return;
    stressRun = { phase: "running", text };
    paint();
  });
  if (mine !== generation) return;
  if ("reason" in reply) stressRun = { phase: "failed", text: reply.reason };
  else if ("cases" in reply) {
    const mm = (v: number) => `${fmt(v, 3)} mm`;
    stressRun = {
      phase: "done",
      lines: [
        ...reply.cases.map((row) => {
          const stiffer = row.after.maxDisplacementMm > 0 ? row.before.maxDisplacementMm / row.after.maxDisplacementMm : null;
          return `${row.name}: greatest deflection ${mm(row.before.maxDisplacementMm)} → ${mm(row.after.maxDisplacementMm)}${stiffer ? `: ${fmt(stiffer, 2)}× as stiff` : ""}.`;
        }),
        "Each case is the whole part, sliced, before and after. Each case adds two slices and two solves. Material cards are placeholders: compare before with after.",
      ],
    };
  } else {
    const mm = (v: number) => `${fmt(v, 3)} mm`;
    const stiffer = reply.after.maxDisplacementMm > 0 ? reply.before.maxDisplacementMm / reply.after.maxDisplacementMm : null;
    const safety = (v: number | null) => (v == null ? "—" : fmt(v, 2));
    stressRun = {
      phase: "done",
      lines: [
        `Greatest deflection ${mm(reply.before.maxDisplacementMm)} → ${mm(reply.after.maxDisplacementMm)}${stiffer ? `: ${fmt(stiffer, 2)}× as stiff on the sliced part` : ""}.`,
        `Least safety factor ${safety(reply.before.minSafetyFactor)} → ${safety(reply.after.minSafetyFactor)}.`,
        "The whole part, sliced, with the same holds and loads. Material cards are placeholders: compare before with after.",
      ],
    };
  }
  paint();
}

function paintHowMuch() {
  const a = card.amount;
  for (const button of root()?.querySelectorAll<HTMLElement>("[data-amount]") ?? []) press(button, button.dataset.amount === a.kind);
  for (const row of root()?.querySelectorAll<HTMLElement>("[data-for-amount]") ?? []) row.hidden = row.dataset.forAmount !== a.kind;
  const slider = $<HTMLInputElement>("#autoRibsSlider");
  if (slider && a.kind === "slider") slider.setAttribute("aria-valuetext", SLIDER_LABELS[Math.round(a.stop) + 2] ?? "Balanced");
  const note = $<HTMLElement>("#autoRibsSliderNote");
  if (note) note.textContent = sliderNote(a, balancedFactor);
}

function paintHoldLoad() {
  if (!host) return;
  const bed = card.holds.some((hold) => hold.kind === "bed");
  const held = card.holds.find((hold) => hold.kind === "faces");
  press($("#autoRibsHoldBed"), bed);
  press($("#autoRibsHoldFaces"), !!held);
  const row = $<HTMLElement>("#autoRibsHoldRow");
  if (row) row.hidden = !held;
  press($("#autoRibsHoldPick"), picking.kind === "hold");
  chips("#autoRibsHoldChips", held?.faces ?? [], "hold");
  const multi = (card.cases?.length ?? 0) >= 2;
  const single = $<HTMLElement>("#autoRibsLoad");
  if (single) single.hidden = multi;
  const add = $<HTMLButtonElement>("#autoRibsAddCase");
  if (add) {
    const full = multi && card.cases!.length >= MAX_LOAD_CASES;
    add.disabled = full;
    add.dataset.tip = full ? "Eight load cases is the most." : "Turn this load into a case and add another. Each case has a name, a weight and its own loads.";
  }
  const cases = $<HTMLElement>("#autoRibsCases");
  if (cases) {
    cases.hidden = !multi;
    const key = multi ? JSON.stringify({ pick: picking, rows: card.cases!.map((item) => ({ kind: item.loads[0]?.kind ?? "force", faces: item.loads[0]?.faces ?? [] })) }) : "";
    if (key !== paintedCases) {
      paintedCases = key;
      cases.replaceChildren(...(multi ? card.cases!.map((item, i) => caseField(item, i)) : []));
    }
  }
  if (!multi) {
    const load = card.loads[0];
    const pressure = load?.kind === "pressure";
    press($("#autoRibsLoadForce"), !pressure);
    press($("#autoRibsLoadPressure"), pressure);
    const label = $<HTMLElement>("#autoRibsForceLabel");
    if (label) label.textContent = pressure ? "Pressure" : "Force";
    const unit = $<HTMLElement>("#autoRibsForceUnit");
    if (unit) unit.textContent = pressure ? "MPa" : "N";
    press($("#autoRibsLoadPick"), picking.kind === "load");
    chips("#autoRibsLoadChips", load?.faces ?? [], "load");
  }
  const stress = host.stress();
  const use = $<HTMLButtonElement>("#autoRibsUseStress");
  if (use) use.hidden = !stress || stress.holds.length + stress.loads.length === 0;
  const not = $<HTMLElement>("#autoRibsNotOnWall");
  if (not) {
    const lines = read?.key === readKey() ? notOnWallLines(read.wall?.report ?? null, read.missed) : [];
    not.replaceChildren(...lines.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
  }
  // Offered once something missed the wall, and kept visible while it is on so it can be turned off again.
  const even = $<HTMLButtonElement>("#autoRibsEvenPressure");
  if (even) {
    const missedNow = read?.key === readKey() && (read.missed.length > 0 || !!read.wall?.report.substituted);
    even.hidden = !missedNow && card.ifMissed !== "evenPressure";
    press(even, card.ifMissed === "evenPressure");
  }
}

function chips(id: string, faces: readonly number[], which: string) {
  const list = $<HTMLElement>(id);
  if (!list) return;
  list.replaceChildren(...faces.map((face) => {
    const item = document.createElement("li");
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "stress-chip";
    chip.dataset.face = String(face);
    chip.dataset.chip = which;
    chip.setAttribute("aria-label", `Remove face ${face + 1}`);
    chip.append(`Face ${face + 1}`, createElement(X, { width: 12, height: 12, "aria-hidden": "true", class: "ico" }));
    item.append(chip);
    return item;
  }));
}

function numberField(zone: ZoneRow, key: string, label: string, value: number, step = 1): Html {
  return html`<label><span class="scrub-label">${label}</span><input type="number" step="${step}" value="${fmt(value, 3).replace(/,/g, "")}" data-zone-field="${key}" data-zone="${zone.id}" id="${`arZ${zone.id}${key}`}" aria-label="${`Zone ${zone.id} ${label}`}"></label>`;
}

function zoneFields(zone: ZoneRow): Html {
  const s = zone.shape;
  const xyz = (key: string, name: string, p: V3, step = 1) => [numberField(zone, `${key}0`, `${name} X`, p[0], step), numberField(zone, `${key}1`, `${name} Y`, p[1], step), numberField(zone, `${key}2`, `${name} Z`, p[2], step)];
  if (s.kind === "box") return html`<div class="ar-zone-grid">${xyz("c", "Centre", s.centre)}${xyz("s", "Size", s.size)}</div>`;
  if (s.kind === "sphere") return html`<div class="ar-zone-grid">${xyz("c", "Centre", s.centre)}${numberField(zone, "r", "Radius", s.radius)}</div>`;
  if (s.kind === "cylinder") return html`<div class="ar-zone-grid">${xyz("o", "From", s.origin)}${xyz("a", "Axis", s.axis, 0.1)}${numberField(zone, "r", "Radius", s.radius)}${numberField(zone, "l", "Length", s.length)}</div>`;
  if (s.kind === "nearHoles") return html`<div class="ar-zone-grid">${numberField(zone, "mm", "Within mm", s.mm, 0.5)}</div>`;
  if (s.kind === "nearFaces") return html`<div class="ar-zone-grid">${numberField(zone, "mm", "Within mm", s.mm, 0.5)}</div><button class="btn stress-pick" type="button" data-zone-pick="${zone.id}" aria-pressed="${picking.kind === "zoneFaces" && picking.zone === zone.id}">Pick faces</button>`;
  if (s.kind === "band") return html`<div class="ar-zone-grid">${xyz("o", "Through", s.origin)}${xyz("n", "Normal", s.normal, 0.1)}${numberField(zone, "from", "From mm", s.from, 0.5)}</div>`;
  if (s.kind === "obstacle") {
    const others = host?.others() ?? [];
    return html`<div class="ar-zone-grid"><label class="ar-wide"><span class="scrub-label">Object</span><select data-zone-object="${zone.id}" aria-label="${`Zone ${zone.id} object`}">${others.map((row) => html`<option value="${row.id}" ${row.id === s.object ? html`selected` : ""}>${row.name}</option>`)}</select></label>${numberField(zone, "clear", "Clearance mm", s.clearanceMm, 0.5)}</div>`;
  }
  return html`<button class="btn stress-pick" type="button" data-zone-pick="${zone.id}" aria-pressed="${picking.kind === "zoneFaces" && picking.zone === zone.id}">Pick faces</button>`;
}

function paintZones() {
  const list = $<HTMLElement>("#autoRibsZones");
  const count = $<HTMLElement>("#autoRibsZoneCount");
  if (count) count.textContent = card.zones.length ? String(card.zones.length) : "";
  const hint = $<HTMLElement>("#autoRibsPlaceHint");
  if (hint) {
    const text = picking.kind === "place" ? `Click the wall where the ${picking.shape === "band" ? "plane passes" : picking.shape} goes. Esc cancels.` : picking.kind === "zoneFaces" ? "Click faces for this zone. Esc or Pick faces again to finish." : "";
    hint.textContent = text;
    hint.hidden = text === "";
  }
  if (!list) return;
  const fresh = read?.key === readKey() ? read : null;
  // Keep the field being typed in: the list is drawn again only when its rows change, not for a number.
  const shape = JSON.stringify(card.zones.map((zone) => [zone.id, zone.shape.kind, zone.mode, zone.shape.kind === "obstacle" ? zone.shape.object : 0, zone.shape.kind === "faces" || zone.shape.kind === "nearFaces" ? zone.shape.faces : 0])) + JSON.stringify(picking) + String(selectedZone);
  if (list.dataset.shape !== shape) {
    list.dataset.shape = shape;
    setHtml(list, html`${card.zones.map((zone) => html`
      <li class="ar-zone ${zone.id === selectedZone ? "is-selected" : ""}" data-zone-row="${zone.id}">
        <div class="ar-zone-head">
          <button class="ar-zone-name" type="button" data-zone-select="${zone.id}" aria-pressed="${zone.id === selectedZone}" data-zone-title="${zone.id}">${zoneTitle(zone)}</button>
          <button class="btn tc-fix" type="button" data-zone-remove="${zone.id}" aria-label="${`Remove zone ${zone.id}`}">${"×"}</button>
        </div>
        <p class="model-note ar-landed" data-zone-landed="${zone.id}"></p>
        ${zone.shape.kind === "obstacle" ? html`<p class="stress-note">${zoneModeText(zone)}</p>` : html`<div class="ar-zone-mode"><select data-zone-mode="${zone.id}" aria-label="${`Zone ${zone.id} mode`}"><option value="noRibs" ${zone.mode === "noRibs" ? html`selected` : ""}>No ribs</option><option value="maxHeight" ${zone.mode === "maxHeight" ? html`selected` : ""}>Ribs up to</option></select>${zone.mode === "maxHeight" ? numberField(zone, "cap", "mm", zone.maxHeightMm, 0.5) : ""}${numberField(zone, "margin", "Margin mm", zone.marginMm, 0.5)}</div>`}
        ${zoneFields(zone)}
      </li>`)}`);
  }
  for (const zone of card.zones) {
    const at = fresh ? fresh.rows.indexOf(zone.id) : -1;
    const landed = zoneLanded(at >= 0 ? fresh?.wall?.report.zones[at] : undefined, !!fresh?.gone.includes(zone.id));
    const node = list.querySelector<HTMLElement>(`[data-zone-landed="${zone.id}"]`);
    if (node) {
      node.textContent = reading && !fresh ? "Reading…" : landed.text;
      node.classList.toggle("is-warn", landed.missed);
    }
    const title = list.querySelector<HTMLElement>(`[data-zone-title="${zone.id}"]`);
    if (title) title.textContent = zoneTitle(zone);
  }
}

function paintSizes() {
  for (const button of root()?.querySelectorAll<HTMLElement>("[data-profile]") ?? []) press(button, button.dataset.profile === card.ribs.profile);
  const note = $<HTMLElement>("#autoRibsProfileNote");
  if (note) note.textContent = card.ribs.profile === "auto" ? AUTOMATIC_NOTE : card.ribs.profile === "straight" ? "Straight: a plain rectangle." : card.ribs.profile === "drafted" ? "Drafted: sides 1° off square with a flared root, as moulding wants." : "T-rib: a flange on top, its underside chamfered so it prints standing up; the most stiffness per gram.";
  const wall = read?.wall ?? null;
  const chosen = wall ? rulesFor(wall) : null;
  const width = $<HTMLInputElement>("#autoRibsWidth");
  if (width) width.placeholder = chosen ? fmt(chosen.width, 2) : "auto";
  const height = $<HTMLInputElement>("#autoRibsHeight");
  if (height) height.placeholder = chosen ? fmt(chosen.maxHeight, 1) : "auto";
  const list = $<HTMLElement>("#autoRibsDefaults");
  if (list) list.replaceChildren(...(chosen?.defaults ?? ["Pick the wall to see the defaults it gives."]).map((text) => {
    const li = document.createElement("li");
    li.textContent = text.charAt(0).toUpperCase() + text.slice(1) + ".";
    return li;
  }));
}

function paintFoot() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  const cancel = document.querySelector<HTMLButtonElement>("#modelCancel");
  if (!button) return;
  const state = host?.state() ?? "none";
  if (applied) {
    button.textContent = "Done";
    button.disabled = false;
    if (cancel) cancel.hidden = true;
    return;
  }
  if (cancel) {
    cancel.hidden = false;
    cancel.textContent = "Cancel";
  }
  const ready = run.phase === "done" && applicable(run) && !planStale();
  button.textContent = ready ? (edit ? "Update" : "Apply") : busy() ? "Planning…" : run.plan ? "Run again" : "Run";
  button.disabled = state !== "ok" || busy() || card.picked.length === 0 || applying;
  button.setAttribute("aria-describedby", "autoRibsWallLine");
}

// ---------------------------------------------------------------------------
// The view: ghost and handles.
// ---------------------------------------------------------------------------

function drawnRibs(): DrawnRib[] {
  if (run.phase === "done" && run.plan) return faceRibs.map((rib) => ({ points: rib.points, normals: rib.normals, heights: rib.heights, width: rib.width }));
  return [...liveDrawn.values()];
}

function ghost(): ModelGhost | null {
  if (!host || applied) return null;
  const ribs = drawnRibs();
  const all: number[] = [];
  const litOut: number[] = [];
  ribs.forEach((rib, i) => {
    if (run.removed.includes(i) && run.phase === "done") return;
    if (i === lit && run.phase === "done") ribSoup(rib, litOut);
    else ribSoup(rib, all);
  });
  const zones: number[] = [];
  for (const zone of card.zones) zoneSoup(zone.shape, zone.id === litZone || zone.id === selectedZone ? zones : zones);
  const wall: number[] = [];
  const solid = host.solid();
  // The wall taken stays washed in the highlight colour; what a click would take joins it while the pointer is on it.
  const washed = run.phase === "idle" || run.phase === "failed" ? [...takenFaces(), ...hoverWall] : [];
  if (solid && washed.length) {
    const take = new Set(washed);
    for (let t = 0; t * 9 + 8 < solid.positions.length; t += 1) if (take.has(solid.faceOf[t]!)) for (let k = 0; k < 9; k += 1) wall.push(solid.positions[t * 9 + k]!);
  }
  const zoneCount = card.zones.filter((zone) => ["box", "sphere", "cylinder"].includes(zone.shape.kind)).length;
  return {
    kind: "ribs",
    ribs: host.toSolid(all),
    ...(litOut.length ? { lit: host.toSolid(litOut) } : {}),
    ...(zones.length ? { zones: host.toSolid(zones) } : {}),
    ...(wall.length ? { wall: host.toSolid(wall) } : {}),
    counts: { ribs: ribs.length - (run.phase === "done" ? run.removed.length : 0), zones: zoneCount },
  };
}

/** The selected place zone's arrows (move) and knobs (size), in the panel's frame. */
function handles(): DragHandle[] {
  const zone = card.zones.find((row) => row.id === selectedZone);
  if (!zone || applied) return [];
  const s = zone.shape;
  const axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const colors = ["x", "y", "z"] as const;
  const out: DragHandle[] = [];
  const centre: V3 | null = s.kind === "box" || s.kind === "sphere" ? s.centre : s.kind === "cylinder" ? s.origin : null;
  if (!centre) return [];
  axes.forEach((dir, k) => {
    out.push({ id: `zone-move-${k}`, kind: "axis", look: "arrow", fields: [`arZ${zone.id}${s.kind === "cylinder" ? "o" : "c"}${k}`], seat: { at: "feature", origin: centre }, dir, rate: 1, step: 1, color: colors[k]!, label: `Zone ${"XYZ"[k]}`, unit: "mm", values: [centre[k]!] });
  });
  if (s.kind === "box") {
    axes.forEach((dir, k) => {
      const at: V3 = [centre[0] + (dir[0] * s.size[0]) / 2, centre[1] + (dir[1] * s.size[1]) / 2, centre[2] + (dir[2] * s.size[2]) / 2];
      out.push({ id: `zone-size-${k}`, kind: "axis", look: "knob", fields: [`arZ${zone.id}s${k}`], seat: { at: "feature", origin: at }, dir, rate: 2, step: 1, min: 0.5, color: colors[k]!, label: `Size ${"XYZ"[k]}`, unit: "mm", values: [s.size[k]!] });
    });
  } else if (s.kind === "sphere" || s.kind === "cylinder") {
    const r = s.radius;
    const at: V3 = [centre[0] + r, centre[1], centre[2]];
    out.push({ id: "zone-radius", kind: "axis", look: "knob", fields: [`arZ${zone.id}r`], seat: { at: "feature", origin: at }, dir: [1, 0, 0], rate: 1, step: 1, min: 0.5, color: "accent", label: "Radius", unit: "mm", values: [r] });
  }
  return out;
}

function drag(event: HandleDrag) {
  const zone = card.zones.find((row) => row.id === selectedZone);
  if (!zone) return;
  const value = event.values[0] ?? 0;
  const id = event.handle.id;
  const s = structuredClone(zone.shape);
  const move = /^zone-move-(\d)$/.exec(id);
  const size = /^zone-size-(\d)$/.exec(id);
  if (move) {
    const k = Number(move[1]);
    if (s.kind === "box" || s.kind === "sphere") s.centre[k] = value;
    if (s.kind === "cylinder") s.origin[k] = value;
  } else if (size && s.kind === "box") s.size[Number(size[1])] = Math.max(0.5, value);
  else if (id === "zone-radius" && (s.kind === "sphere" || s.kind === "cylinder")) s.radius = Math.max(0.5, value);
  card = { ...card, zones: card.zones.map((row) => (row.id === zone.id ? { ...row, shape: s } : row)) };
  syncZoneInputs(zone.id);
  if (event.phase === "end") changed();
  else refreshModelCard();
}

/** A zone's typed fields follow a drag. */
function syncZoneInputs(id: number) {
  const zone = card.zones.find((row) => row.id === id);
  if (!zone) return;
  for (const input of root()?.querySelectorAll<HTMLInputElement>(`[data-zone="${id}"][data-zone-field]`) ?? []) {
    const value = zoneValue(zone, input.dataset.zoneField ?? "");
    if (value != null && document.activeElement !== input) input.value = fmt(value, 3).replace(/,/g, "");
  }
  const title = root()?.querySelector<HTMLElement>(`[data-zone-title="${id}"]`);
  if (title) title.textContent = zoneTitle(zone);
}

function zoneValue(zone: ZoneRow, key: string): number | null {
  const s = zone.shape as Record<string, unknown>;
  const vec = (name: string, k: number) => ((s[name] as V3 | undefined)?.[k] ?? null);
  const m = /^([csoan])(\d)$/.exec(key);
  if (m) return vec({ c: "centre", s: "size", o: "origin", a: "axis", n: "normal" }[m[1] as "c"]!, Number(m[2]));
  if (key === "r") return (s.radius as number) ?? null;
  if (key === "l") return (s.length as number) ?? null;
  if (key === "mm") return (s.mm as number) ?? null;
  if (key === "from") return (s.from as number) ?? null;
  if (key === "clear") return (s.clearanceMm as number) ?? null;
  if (key === "cap") return zone.maxHeightMm;
  if (key === "margin") return zone.marginMm;
  return null;
}

function withZoneValue(zone: ZoneRow, key: string, value: number): ZoneRow {
  if (key === "cap") return { ...zone, maxHeightMm: Math.max(0, value) };
  if (key === "margin") return { ...zone, marginMm: Math.max(0, value) };
  const s = structuredClone(zone.shape) as Record<string, unknown>;
  const m = /^([csoan])(\d)$/.exec(key);
  if (m) {
    const name = { c: "centre", s: "size", o: "origin", a: "axis", n: "normal" }[m[1] as "c"]!;
    const v = s[name] as V3 | undefined;
    if (v) v[Number(m[2])] = name === "size" ? Math.max(0.1, value) : value;
  } else if (key === "r") s.radius = Math.max(0.1, value);
  else if (key === "l") s.length = Math.max(0.1, value);
  else if (key === "mm") s.mm = Math.max(0, value);
  else if (key === "from") s.from = value;
  else if (key === "clear") s.clearanceMm = Math.max(0, value);
  return { ...zone, shape: s as ZoneShape };
}

// ---------------------------------------------------------------------------
// Hover: the wall a click would take, and the rib under the pointer.
// ---------------------------------------------------------------------------

let hoverFrame = 0;
let hoverAt: { x: number; y: number } | null = null;

function onCanvasMove(ev: PointerEvent) {
  if (!autoRibsCardOpen() || !host || applied || ev.buttons !== 0) return;
  hoverAt = { x: ev.clientX, y: ev.clientY };
  if (hoverFrame) return;
  hoverFrame = window.requestAnimationFrame(() => {
    hoverFrame = 0;
    if (!hoverAt || !host) return;
    // A plan on screen: the rib under the pointer lights, in the view and in the list.
    if (run.phase === "done" && run.plan) {
      const ray = host.ray(hoverAt.x, hoverAt.y);
      const hit = ray ? ribUnderRay(drawnRibs(), ray.origin, ray.direction, 1) : -1;
      setLit(hit >= 0 ? hit : null);
      return;
    }
    if (picking.kind !== "wall" || busy()) return;
    const face = host.faceAt(hoverAt.x, hoverAt.y);
    if (face === hoverFace) return;
    hoverFace = face;
    const solid = host.solid();
    if (face == null || !solid) hoverWall = [];
    else {
      const taken = takenFaces();
      hoverWall = taken.includes(face) ? [face] : wallFaces({ positions: solid.positions, faceOf: solid.faceOf }, { picked: [face], ...growthOptions() }).faces;
    }
    const canvas = document.querySelector<HTMLElement>("#model");
    if (canvas) canvas.dataset.autoRibsHover = hoverWall.join(" ");
    refreshModelCard();
  });
}

function setLit(index: number | null) {
  if (lit === index) return;
  lit = index;
  for (const row of root()?.querySelectorAll<HTMLElement>("[data-rib]") ?? []) row.classList.toggle("is-lit", Number(row.dataset.rib) === index);
  const canvas = document.querySelector<HTMLElement>("#model");
  if (canvas) {
    if (index == null) delete canvas.dataset.autoRibsLit;
    else canvas.dataset.autoRibsLit = String(index);
  }
  refreshModelCard();
}

function hoverList(target: EventTarget | null, on: boolean) {
  const row = target instanceof Element ? target.closest<HTMLElement>("[data-rib]") : null;
  if (row) setLit(on ? Number(row.dataset.rib) : null);
  const zone = target instanceof Element ? target.closest<HTMLElement>("[data-zone-row]") : null;
  if (zone) {
    litZone = on ? Number(zone.dataset.zoneRow) : null;
    refreshModelCard();
  }
}

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------

function freshLoad(): StudyLoad {
  return { kind: "force", faces: [], magnitude: 10, direction: [0, 0, -1] };
}

function withFace(load: StudyLoad, face: number): StudyLoad {
  return { ...load, faces: toggled(load.faces, face) };
}

/** The single load becomes case 1, and case 2 is added. Further clicks add a case, up to eight. */
function addLoadCase() {
  if ((card.cases?.length ?? 0) >= MAX_LOAD_CASES) return;
  const cases = (card.cases?.length ?? 0) >= 2 ? card.cases! : [{ name: "Case 1", weight: 1, loads: card.loads.length ? structuredClone(card.loads) : [freshLoad()] }];
  const n = cases.length + 1;
  card = { ...card, loads: [], cases: [...cases, { name: `Case ${n}`, weight: 1, loads: [freshLoad()] }] };
}

/** Drop one case. The last remaining case becomes today's single load, and the case list goes away. */
function removeLoadCase(index: number) {
  const left = (card.cases ?? []).filter((_, i) => i !== index);
  if (picking.kind === "load") picking = { kind: "wall" };
  if (left.length >= 2) {
    card = { ...card, cases: left };
    return;
  }
  const { cases: _gone, ...rest } = card;
  card = { ...rest, loads: left[0]?.loads.length ? left[0].loads : rest.loads.length ? rest.loads : [freshLoad()] };
}

function caseField(row: PanelLoadCase, index: number): HTMLElement {
  const load = row.loads[0] ?? freshLoad();
  const pressure = load.kind === "pressure";
  const box = document.createElement("fieldset");
  box.className = "stress-group";
  box.dataset.case = String(index);
  const legend = document.createElement("legend");
  legend.textContent = `Case ${index + 1}`;
  const head = document.createElement("div");
  head.className = "ar-case-head";
  const name = document.createElement("input");
  name.type = "text";
  name.value = row.name;
  name.dataset.case = String(index);
  name.dataset.caseField = "name";
  name.setAttribute("aria-label", `Case ${index + 1} name`);
  const weight = document.createElement("input");
  weight.type = "number";
  weight.step = "0.1";
  weight.min = "0.1";
  weight.value = String(row.weight);
  weight.dataset.case = String(index);
  weight.dataset.caseField = "weight";
  weight.setAttribute("aria-label", `Case ${index + 1} weight`);
  const weightLabel = document.createElement("label");
  weightLabel.className = "ar-inline";
  weightLabel.append("Weight ", weight);
  head.append(name, weightLabel);
  const modes = document.createElement("div");
  modes.className = "modes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", `Case ${index + 1} load kind`);
  const kindButton = (kind: "force" | "pressure", text: string, on: boolean) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn mode";
    button.dataset.caseKind = kind;
    button.dataset.case = String(index);
    button.textContent = text;
    press(button, on);
    return button;
  };
  modes.append(kindButton("force", "Force N", !pressure), kindButton("pressure", "Pressure MPa", pressure));
  const magLabel = document.createElement("label");
  magLabel.className = "stress-inline";
  const magName = document.createElement("span");
  magName.textContent = pressure ? "Pressure" : "Force";
  const magField = document.createElement("span");
  magField.className = "stress-unit-field";
  const mag = document.createElement("input");
  mag.type = "number";
  mag.step = "0.1";
  mag.value = String(load.magnitude);
  mag.dataset.case = String(index);
  mag.dataset.caseField = "mag";
  mag.setAttribute("aria-label", `Case ${index + 1} load magnitude`);
  const unit = document.createElement("span");
  unit.className = "stress-unit";
  unit.textContent = pressure ? "MPa" : "N";
  magField.append(mag, unit);
  magLabel.append(magName, magField);
  const pickRow = document.createElement("div");
  pickRow.className = "stress-pick-row";
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "btn stress-pick";
  pick.dataset.casePick = String(index);
  pick.textContent = "Pick faces";
  press(pick, picking.kind === "load" && picking.case === index);
  const list = document.createElement("ul");
  list.className = "stress-chips";
  list.setAttribute("aria-label", `Case ${index + 1} loaded faces`);
  for (const face of load.faces) {
    const item = document.createElement("li");
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "stress-chip";
    chip.dataset.face = String(face);
    chip.dataset.chip = "case";
    chip.dataset.case = String(index);
    chip.setAttribute("aria-label", `Remove face ${face + 1} from case ${index + 1}`);
    chip.append(`Face ${face + 1}`, createElement(X, { width: 12, height: 12, "aria-hidden": "true", class: "ico" }));
    item.append(chip);
    list.append(item);
  }
  pickRow.append(pick, list);
  const axis = document.createElement("div");
  axis.className = "stress-axis";
  axis.setAttribute("role", "group");
  axis.setAttribute("aria-label", `Case ${index + 1} direction`);
  const axisLabel = document.createElement("span");
  axisLabel.className = "stress-axis-label";
  axisLabel.textContent = "Direction (X, Y, Z)";
  axis.append(axisLabel);
  for (const [axisIndex, letter] of ["X", "Y", "Z"].entries()) {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.value = String(load.direction[axisIndex] ?? 0);
    input.dataset.case = String(index);
    input.dataset.caseField = "dir";
    input.dataset.axis = String(axisIndex);
    input.setAttribute("aria-label", `Case ${index + 1} direction ${letter}`);
    axis.append(input);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn ar-small";
  remove.dataset.caseRemove = String(index);
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove case ${index + 1}`);
  box.append(legend, head, modes, magLabel, pickRow, axis, remove);
  return box;
}

function readLoad(faces: number[]): StudyLoad {
  const num = (id: string, d: number) => {
    const v = Number($<HTMLInputElement>(id)?.value);
    return Number.isFinite(v) ? v : d;
  };
  const pressure = $("#autoRibsLoadPressure")?.getAttribute("aria-pressed") === "true";
  return { kind: pressure ? "pressure" : "force", faces, magnitude: num("#autoRibsForce", 10), direction: [num("#autoRibsDirX", 0), num("#autoRibsDirY", 0), num("#autoRibsDirZ", -1)] };
}

function setPick(next: Pick) {
  picking = picking.kind === next.kind && JSON.stringify(picking) === JSON.stringify(next) ? { kind: "wall" } : next;
  if (picking.kind !== "wall") host?.pickFaces();
  paint();
}

function onClick(ev: Event) {
  const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>("button") : null;
  if (!target || !host) return;
  if (target.id === "autoRibsStop") return stop();
  if (target.id === "autoRibsStress") return void runStressCheck();
  if (target.id === "autoRibsWallClear") {
    card = { ...card, picked: [], excluded: [] };
    return changed();
  }
  if (target.dataset.litRib) {
    setLit(lit === Number(target.dataset.litRib) ? null : Number(target.dataset.litRib));
    return;
  }
  if (target.dataset.removeRib) {
    run = toggleRemoved(run, Number(target.dataset.removeRib));
    host.readout(run.removed.length ? "Edited: the material is recounted; the stiffness is not solved again." : "Check the plan, then Apply.");
    return paint();
  }
  if (target.dataset.amount) {
    const kind = target.dataset.amount;
    const value = (id: string, d: number) => {
      const v = Number($<HTMLInputElement>(id)?.value);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    card = { ...card, amount: kind === "stiffer" ? { kind, factor: value("#autoRibsStiffer", 2) } : kind === "deflection" ? { kind, mm: value("#autoRibsDeflection", 0.5) } : kind === "budget" ? { kind, grams: value("#autoRibsBudget", 10) } : { kind: "slider", stop: Number($<HTMLInputElement>("#autoRibsSlider")?.value ?? 0) } };
    return paint();
  }
  if (target.dataset.profile) {
    card = { ...card, ribs: { ...card.ribs, profile: target.dataset.profile as AutoRibsCard["ribs"]["profile"] } };
    return paint();
  }
  if (target.id === "autoRibsEvenPressure") {
    card = { ...card, ifMissed: card.ifMissed === "evenPressure" ? "refuse" : "evenPressure" };
    return changed();
  }
  if (target.id === "autoRibsUseStress") {
    const stress = host.stress();
    if (stress) {
      const { cases: _gone, ...rest } = card;
      card = { ...rest, holds: structuredClone(stress.holds), loads: structuredClone(stress.loads) };
    }
    writeFields();
    return changed();
  }
  if (target.id === "autoRibsAddCase") {
    addLoadCase();
    return changed();
  }
  if (target.dataset.caseRemove) {
    removeLoadCase(Number(target.dataset.caseRemove));
    return changed();
  }
  if (target.dataset.caseKind && card.cases) {
    const index = Number(target.dataset.case);
    const kind = target.dataset.caseKind === "pressure" ? "pressure" : "force";
    card = { ...card, cases: card.cases.map((row, i) => (i === index ? { ...row, loads: [{ ...(row.loads[0] ?? freshLoad()), kind, magnitude: kind === "pressure" ? 0.01 : 10 }] } : row)) };
    return changed();
  }
  if (target.dataset.casePick) {
    const index = Number(target.dataset.casePick);
    return setPick({ kind: "load", case: index });
  }
  if (target.id === "autoRibsHoldFaces") {
    card = { ...card, holds: card.holds.some((h) => h.kind === "faces") ? [] : [{ kind: "faces", faces: [] }] };
    if (card.holds.length) setPick({ kind: "hold" });
    return changed();
  }
  if (target.id === "autoRibsHoldBed") {
    card = { ...card, holds: card.holds.some((h) => h.kind === "bed") ? [] : [{ kind: "bed", faces: [] }] };
    return changed();
  }
  if (target.id === "autoRibsHoldPick") return setPick({ kind: "hold" });
  if (target.id === "autoRibsLoadPick") {
    if (!card.loads.length) card = { ...card, loads: [readLoad([])] };
    return setPick({ kind: "load" });
  }
  if (target.id === "autoRibsLoadForce" || target.id === "autoRibsLoadPressure") {
    const kind = target.id === "autoRibsLoadPressure" ? "pressure" : "force";
    const load = card.loads[0] ?? readLoad([]);
    card = { ...card, loads: [{ ...load, kind, magnitude: kind === "pressure" ? 0.01 : 10 }] };
    const input = $<HTMLInputElement>("#autoRibsForce");
    if (input) input.value = String(card.loads[0]!.magnitude);
    return changed();
  }
  if (target.dataset.chip) {
    const face = Number(target.dataset.face);
    if (target.dataset.chip === "hold") card = { ...card, holds: card.holds.map((h) => (h.kind === "faces" ? { ...h, faces: h.faces.filter((f) => f !== face) } : h)) };
    else if (target.dataset.chip === "case" && card.cases) {
      const index = Number(target.dataset.case);
      card = { ...card, cases: card.cases.map((row, i) => (i === index ? { ...row, loads: row.loads.map((l) => ({ ...l, faces: l.faces.filter((f) => f !== face) })) } : row)) };
    } else card = { ...card, loads: card.loads.map((l) => ({ ...l, faces: l.faces.filter((f) => f !== face) })) };
    return changed();
  }
  if (target.dataset.addZone) {
    const kind = target.dataset.addZone as ZoneShape["kind"];
    const at = wallCentre();
    if (kind === "box" || kind === "sphere" || kind === "cylinder" || kind === "band") return setPick({ kind: "place", shape: kind });
    if (kind === "obstacle") {
      const other = host.others()[0];
      if (!other) {
        host.readout("Another object needs another object on the plate: add or import one first.");
        return;
      }
      const zone = newZone(nextZone++, "obstacle", at ?? [0, 0, 0], wallExtent(), [0, 0, 1], { object: other.id, name: other.name });
      card = { ...card, zones: [...card.zones, zone] };
      selectedZone = zone.id;
      return changed();
    }
    const zone = newZone(nextZone++, kind, at ?? [0, 0, 0], wallExtent(), [0, 0, 1]);
    card = { ...card, zones: [...card.zones, zone] };
    selectedZone = zone.id;
    if (kind === "faces" || kind === "nearFaces") picking = { kind: "zoneFaces", zone: zone.id };
    return changed();
  }
  if (target.dataset.zoneRemove) {
    const id = Number(target.dataset.zoneRemove);
    card = { ...card, zones: card.zones.filter((zone) => zone.id !== id) };
    if (selectedZone === id) selectedZone = null;
    if (picking.kind === "zoneFaces" && picking.zone === id) picking = { kind: "wall" };
    return changed();
  }
  if (target.dataset.zoneSelect) {
    const id = Number(target.dataset.zoneSelect);
    selectedZone = selectedZone === id ? null : id;
    return paint();
  }
  if (target.dataset.zonePick) return setPick({ kind: "zoneFaces", zone: Number(target.dataset.zonePick) });
}

function onInput(ev: Event) {
  const target = ev.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  const finished = ev.type === "change";
  const value = Number(target.value);
  if (target.id === "autoRibsJustThis" && target instanceof HTMLInputElement) {
    card = { ...card, justThis: target.checked };
    return changed();
  }
  if (target.id === "autoRibsFolded" && target instanceof HTMLInputElement) {
    card = { ...card, folded: target.checked };
    return changed();
  }
  if (target.id === "autoRibsRimOn" && target instanceof HTMLInputElement) {
    card = { ...card, holeRim: { ...card.holeRim, on: target.checked } };
    return paint();
  }
  if (target.id === "autoRibsRimMm" && Number.isFinite(value) && value >= 0) {
    card = { ...card, holeRim: { ...card.holeRim, mm: value } };
    return paint();
  }
  if (target.id === "autoRibsProcess") {
    card = { ...card, ribs: { ...card.ribs, process: target.value as RibProcess } };
    return paint();
  }
  if (target.id === "autoRibsWidth" || target.id === "autoRibsHeight") {
    const v = target.value.trim() === "" ? null : value > 0 ? value : undefined;
    if (v === undefined) return;
    card = { ...card, ribs: { ...card.ribs, ...(target.id === "autoRibsWidth" ? { width: v } : { height: v }) } };
    return paint();
  }
  if (target.id === "autoRibsSlider") {
    card = { ...card, amount: { kind: "slider", stop: value } };
    return paint();
  }
  if (target.id === "autoRibsStiffer" && value > 1) {
    card = { ...card, amount: { kind: "stiffer", factor: value } };
    return paint();
  }
  if (target.id === "autoRibsDeflection" && value > 0) {
    card = { ...card, amount: { kind: "deflection", mm: value } };
    return paint();
  }
  if (target.id === "autoRibsBudget" && value > 0) {
    card = { ...card, amount: { kind: "budget", grams: value } };
    return paint();
  }
  if (["autoRibsForce", "autoRibsDirX", "autoRibsDirY", "autoRibsDirZ"].includes(target.id)) {
    if (card.loads.length === 0 && !finished) return;
    card = { ...card, loads: [readLoad(card.loads[0]?.faces ?? [])] };
    return finished ? changed() : undefined;
  }
  if (target.dataset.caseField && card.cases) {
    const index = Number(target.dataset.case);
    const row = card.cases[index];
    if (!row) return;
    const load = row.loads[0] ?? freshLoad();
    const field = target.dataset.caseField;
    let next = row;
    if (field === "name") next = { ...row, name: target.value };
    else if (field === "weight") {
      if (!(value > 0)) {
        if (finished) target.value = String(row.weight);
        return;
      }
      next = { ...row, weight: value };
    } else if (field === "mag") {
      if (!Number.isFinite(value)) return;
      next = { ...row, loads: [{ ...load, magnitude: value }] };
    } else if (field === "dir") {
      if (!Number.isFinite(value)) return;
      const direction: [number, number, number] = [load.direction[0], load.direction[1], load.direction[2]];
      direction[Number(target.dataset.axis)] = value;
      next = { ...row, loads: [{ ...load, direction }] };
    }
    card = { ...card, cases: card.cases.map((item, i) => (i === index ? next : item)) };
    return finished ? changed() : undefined;
  }
  const zoneId = Number(target.dataset.zone ?? target.dataset.zoneMode ?? target.dataset.zoneObject);
  const zone = card.zones.find((row) => row.id === zoneId);
  if (!zone) return;
  if (target.dataset.zoneMode) {
    card = { ...card, zones: card.zones.map((row) => (row.id === zoneId ? { ...row, mode: target.value === "maxHeight" ? "maxHeight" : "noRibs" } : row)) };
    return changed();
  }
  if (target.dataset.zoneObject && zone.shape.kind === "obstacle") {
    const name = host?.others().find((row) => row.id === target.value)?.name ?? zone.shape.name;
    card = { ...card, zones: card.zones.map((row) => (row.id === zoneId ? { ...row, shape: { ...zone.shape, object: target.value, name } as ZoneShape } : row)) };
    return changed();
  }
  if (target.dataset.zoneField && target.value.trim() !== "" && Number.isFinite(value)) {
    card = { ...card, zones: card.zones.map((row) => (row.id === zoneId ? withZoneValue(row, target.dataset.zoneField!, value) : row)) };
    const title = root()?.querySelector<HTMLElement>(`[data-zone-title="${zoneId}"]`);
    const now = card.zones.find((row) => row.id === zoneId);
    if (title && now) title.textContent = zoneTitle(now);
    refreshModelCard();
    if (finished) changed();
    else queueRead(400);
  }
}

// ---------------------------------------------------------------------------
// Small reads of the solid.
// ---------------------------------------------------------------------------

function faceTriangles(face: number): number[] {
  const solid = host?.solid();
  if (!solid) return [];
  const out: number[] = [];
  for (let t = 0; t * 9 + 8 < solid.positions.length; t += 1) if (solid.faceOf[t] === face) out.push(t);
  return out;
}

function faceCentre(face: number): V3 | null {
  const solid = host?.solid();
  const tris = faceTriangles(face);
  if (!solid || tris.length === 0) return null;
  const c: V3 = [0, 0, 0];
  for (const t of tris) for (let k = 0; k < 9; k += 1) c[k % 3] = c[k % 3]! + solid.positions[t * 9 + k]! / (3 * tris.length);
  return c;
}

function faceNormal(face: number): V3 | null {
  const solid = host?.solid();
  const t = faceTriangles(face)[0];
  if (!solid || t === undefined) return null;
  const p = (k: number): V3 => [solid.positions[t * 9 + k * 3]!, solid.positions[t * 9 + k * 3 + 1]!, solid.positions[t * 9 + k * 3 + 2]!];
  const [a, b, c] = [p(0), p(1), p(2)];
  const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** The wall's box: its centre, and its largest side for a new zone's size. */
function wallBox(): { min: V3; max: V3 } | null {
  const wall = read?.wall;
  if (!wall || wall.skin.length === 0) return null;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of wall.skin) for (let k = 0; k < 3; k += 1) {
    min[k] = Math.min(min[k]!, p[k]!);
    max[k] = Math.max(max[k]!, p[k]!);
  }
  return { min, max };
}

function wallCentre(): V3 | null {
  const box = wallBox();
  return box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] : null;
}

function wallExtent(): number {
  const box = wallBox();
  return box ? Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) : 50;
}

// --- For tests: the panel's state, read from the page (window.__limeAutoRibs).
(globalThis as { __limeAutoRibs?: unknown }).__limeAutoRibs = {
  card: () => card,
  wall: () => (read?.wall ? { faces: read.wall.faces, folded: read.wall.report.faces.folded ?? [] } : null),
  run: () => ({ phase: run.phase, stage: run.stage, fraction: run.fraction, ribs: run.ribs.length, plan: run.plan ? { ribs: run.plan.ribs.length, stoppedEarly: run.plan.stoppedEarly } : null, removed: run.removed }),
  body: () => ranWith?.body ?? null,
  plan: () => run.plan,
  zonesRead: () => (read?.wall ? read.wall.report.zones : null),
  faceRibs: () => faceRibs.map((rib) => ({ points: rib.points, heights: rib.heights })),
  setBuild: (axis: V3) => {
    buildOverride = axis;
    paint();
  },
};
