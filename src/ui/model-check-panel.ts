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
let serial = 0;
let timer = 0;
let rows: CheckRow[] = [];
let pose: Affine | null = null;
let note = "";

export function modelCheckNote(): string {
  return note;
}

export function mountModelCheck(next: ModelCheckMount) {
  mount = next;
  worker = new Worker(new URL("../model-check-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<{ id: number; report: ModelCheckReport }>) => {
    if (ev.data.id !== serial) return;
    applyReport(ev.data.report);
  };
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

function thinMm(): number {
  const value = Number(document.querySelector<HTMLInputElement>("#modelThin")?.value);
  if (!Number.isFinite(value)) return defaultThinMm(state.profile.nozzleDiameter);
  return Math.min(20, Math.max(0.05, value));
}

function runCheck() {
  const id = ++serial;
  const source = mount?.source() ?? null;
  fx.model?.setCheckBox(null);
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
  worker?.postMessage({ id, positions, minWallMm: thinMm(), nozzleMm: state.profile.nozzleDiameter || 0.4, buildMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ] }, [positions.buffer]);
}

function applyReport(report: ModelCheckReport) {
  rows = report.rows;
  render(rows);
  setNote(report.note);
}

function setNote(next: string) {
  note = next;
  mount?.noteChanged();
}

function render(list: readonly CheckRow[]) {
  const root = document.querySelector("#modelCheckList");
  if (!root) return;
  root.replaceChildren(
    ...list.map((row, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = row.bad ? "model-check-row is-bad" : "model-check-row";
      button.dataset.checkRow = String(index);
      button.setAttribute("role", "listitem");
      button.setAttribute("aria-pressed", "false");
      button.textContent = row.text;
      return button;
    }),
  );
}
