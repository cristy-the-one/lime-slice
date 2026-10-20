/**
 * The Check panel: a worker runs the print check, and a row frames its box.
 * This module does not import the modeler. The chrome supplies the mesh.
 * --- A7 model check ---
 */
import { fx } from "../app/fx.ts";
import { state } from "../app/state.ts";
import { PROBE_WAIT_MS } from "../model-feasibility.ts";
import { defaultThinMm, type CheckRow, type ModelCheckReport } from "../model-check.ts";
import { boxUnder, type Affine } from "../model-space.ts";
import { setInspectCheck } from "./model-inspect.ts";

export interface CheckSource {
  /** The mesh, in its own frame: the open solid, or a plate mesh when Model has no solid. */
  positions: Float32Array;
  /** That frame into model space, where the outline is drawn. */
  toModel: Affine;
}

export interface ModelCheckMount {
  source(): CheckSource | null;
  /** The note changed. The chrome paints it. */
  noteChanged(): void;
}

let mount: ModelCheckMount | null = null;
let worker: Worker | null = null;
/** --- D31. The check the worker is running, if any: closing Check or a new solid stops it. */
let running = 0;
let serial = 0;
let timer = 0;
let rows: CheckRow[] = [];
let pose: Affine | null = null;
let note = "";

export function modelCheckNote(): string {
  return note;
}

/** The check's worker, started on first use and again after it failed or was stopped. */
function checkWorker(): Worker {
  if (worker) return worker;
  const made = new Worker(new URL("../model-check-worker.ts", import.meta.url), { type: "module" });
  made.onmessage = (ev: MessageEvent<{ id: number; report: ModelCheckReport }>) => {
    if (ev.data.id === running) running = 0;
    if (ev.data.id !== serial) return;
    applyReport(ev.data.report);
  };
  // --- D31. A worker that fails says so, instead of leaving "Checking this solid…" on screen.
  const failed = (why: string) => {
    if (worker === made) worker = null;
    made.terminate();
    const shown = running === serial;
    running = 0;
    if (!shown) return;
    rows = [];
    render([]);
    setNote(`The check stopped: ${why}. Change the thin wall or the solid to try again.`);
  };
  made.onerror = (ev) => {
    ev.preventDefault();
    failed(ev.message || "the check failed");
  };
  made.onmessageerror = () => failed("its answer could not be read");
  worker = made;
  return made;
}

/** Stop a check still running: its answer would be thrown away, and a big part keeps a core busy. */
function stopRunning() {
  if (!running || !worker) return;
  worker.terminate();
  worker = null;
  running = 0;
}

export function mountModelCheck(next: ModelCheckMount) {
  mount = next;
  document.querySelector("#modelCheckList")?.addEventListener("click", (ev) => {
    const button = ev.target instanceof Element ? ev.target.closest<HTMLButtonElement>("[data-check-row]") : null;
    const index = Number(button?.dataset.checkRow);
    const row = rows[index];
    if (!button || !row || !pose) return;
    const box = boxUnder(row.box, pose);
    fx.model?.setCheckBox(box);
    fx.model?.frame(box);
    document.querySelectorAll<HTMLButtonElement>("#modelCheckList [data-check-row]").forEach((item) => {
      item.setAttribute("aria-pressed", item === button ? "true" : "false");
    });
  });
}

/** Check opened: the threshold starts at twice the selected machine's nozzle, then the check runs. */
export function openModelCheck() {
  const input = document.querySelector<HTMLInputElement>("#modelThin");
  if (input) input.value = String(defaultThinMm(state.profile.nozzleDiameter));
  queueModelCheck(false);
}

export function closeModelCheck() {
  serial += 1;
  stopRunning();
  window.clearTimeout(timer);
  note = "";
  rows = [];
  pose = null;
  render([]);
  fx.model?.setCheckBox(null);
}

/** The solid on screen changed while Check stays open. The threshold is left as it is. */
export function refreshModelCheck() {
  queueModelCheck(false);
}

/** `typed` waits out a keystroke. Opening, leaving the field, and the end of a drag run at once. */
export function queueModelCheck(typed: boolean) {
  window.clearTimeout(timer);
  if (typed) timer = window.setTimeout(() => runCheck(), PROBE_WAIT_MS);
  else runCheck();
}

/** --- D31. The typed thin wall, or why it cannot be used: empty, 0, negative, or past 20 mm is said, not clamped. */
export function thinWallMm(text: string): number | string {
  const value = text.trim() === "" ? NaN : Number(text);
  if (!Number.isFinite(value)) return "Type a thin wall in millimetres.";
  if (value < THIN_MIN) return `Thin wall is at least ${THIN_MIN} mm.`;
  if (value > THIN_MAX) return `Thin wall is at most ${THIN_MAX} mm.`;
  return value;
}

const THIN_MIN = 0.05;
const THIN_MAX = 20;

function runCheck() {
  const id = ++serial;
  const source = mount?.source() ?? null;
  fx.model?.setCheckBox(null);
  const input = document.querySelector<HTMLInputElement>("#modelThin");
  const thin = thinWallMm(input?.value ?? String(defaultThinMm(state.profile.nozzleDiameter)));
  if (typeof thin === "string") input?.setAttribute("aria-invalid", "true");
  else input?.removeAttribute("aria-invalid");
  if (typeof thin === "string") {
    stopRunning();
    rows = [];
    render([]);
    setNote(thin);
    return;
  }
  if (!source || source.positions.length < 9) {
    pose = null;
    rows = [];
    render([]);
    setNote("Open a solid to check it.");
    return;
  }
  pose = source.toModel;
  setNote("Checking this solid…");
  const positions = new Float32Array(source.positions);
  stopRunning();
  running = id;
  checkWorker().postMessage({ id, positions, minWallMm: thin, nozzleMm: state.profile.nozzleDiameter || 0.4, buildMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ] }, [positions.buffer]);
}

function applyReport(report: ModelCheckReport) {
  rows = report.rows;
  render(rows);
  setNote(report.note);
  // --- E3. Inspect keeps the last check of the open object.
  setInspectCheck(report.note);
}

function setNote(next: string) {
  note = next;
  mount?.noteChanged();
}

function render(list: readonly CheckRow[]) {
  const root = document.querySelector("#modelCheckList");
  if (!root) return;
  // --- D31. A list item holds each row's button, which frames that place and is pressed while it is framed.
  root.replaceChildren(
    ...list.map((row, index) => {
      const item = document.createElement("div");
      item.setAttribute("role", "listitem");
      const button = document.createElement("button");
      button.type = "button";
      button.className = row.bad ? "model-check-row is-bad" : "model-check-row";
      button.dataset.checkRow = String(index);
      button.setAttribute("aria-pressed", "false");
      button.textContent = row.text;
      item.append(button);
      return item;
    }),
  );
}
