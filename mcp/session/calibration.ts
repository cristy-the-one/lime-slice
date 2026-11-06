/**
 * Calibration towers and blends.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { writeFileSync } from "node:fs";
import { advanceFor, enginePrinter, setAdvance, setFlow, setNozzleTemp, setRetract } from "../../src/ui/machine-library.ts";
import { withMesh } from "../engine.ts";
import { resolveWrite } from "../workspace.ts";
import { type ToolHandler, isObject, roundTo } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

async function calibrationTower(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kind = input.kind === "pa" || input.kind === "flow" || input.kind === "temp" || input.kind === "retract" ? input.kind : null;
  if (!kind) return refuse("bad-argument", "kind is pa, flow, temp, or retract.");
  const start = Number(input.start);
  const end = Number(input.end);
  const step = Number(input.step);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(step > 0) || end + 1e-9 < start) {
    return refuse("bad-tower", "The tower needs a start, an end, and a positive step.");
  }
  const bandHeight = typeof input.bandHeightMm === "number" && input.bandHeightMm > 0 ? input.bandHeightMm : kind === "pa" ? 2 : 5;
  const bands = Math.floor((end - start) / step + 1e-9) + 1;
  if (bands > 40) return refuse("bad-tower", `That tower has ${bands} bands. The limit is 40.`);
  const height = bands * bandHeight;
  const printer = this.printer();
  if (height > printer.bedZ) return refuse("bad-tower", `That tower is ${roundTo(height, 1)} mm. The bed is ${printer.bedZ} mm tall.`);
  if (kind === "pa" && !printer.firmware) return refuse("bad-tower", "The PA tower needs a firmware.");
  const body = {
    kind,
    firmware: printer.firmware,
    start,
    end,
    step,
    layerHeight: typeof input.layerHeight === "number" ? input.layerHeight : this.settings.layerHeight,
    bandHeight,
    slowMmS: 40,
    fastMmS: 200,
    accel: 3000,
    speedMmS: kind === "retract" ? 30 : 40,
    printer: enginePrinter(printer, this.filament(), this.library.nozzleMm),
  };
  if (input.dryRun === true) return { ok: true, dryRun: true, bands, heightMm: roundTo(height, 2) };
  let reply: { bands?: { index?: number; value?: number; k?: number; flow?: number; temp?: number; length?: number; z0?: number; z1?: number }[]; gcode?: string; error?: string };
  try {
    reply = JSON.parse(await this.ask(this.engine.calibrate(JSON.stringify(body)))) as typeof reply;
  } catch (err) {
    return refuse("bad-tower", err instanceof Error ? err.message : "The tower was not built.");
  }
  if (!reply.gcode || !Array.isArray(reply.bands)) return refuse("bad-tower", reply.error ?? "The tower was not built.");
  const path = resolveWrite(`${kind}-tower.gcode`, ".gcode");
  writeFileSync(path, reply.gcode);
  const listed = reply.bands.map((band, index) => ({
    index: band.index ?? index,
    value: band.value ?? band.k ?? band.flow ?? band.temp ?? band.length ?? 0,
    z0: band.z0 ?? 0,
    z1: band.z1 ?? 0,
  }));
  return { ok: true, bands: listed, gcodePath: path, bytes: Buffer.byteLength(reply.gcode) };
}

function calibrationApply(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const kind = input.kind === "pa" || input.kind === "flow" || input.kind === "temp" || input.kind === "retract" ? input.kind : null;
  if (!kind) return refuse("bad-argument", "kind is pa, flow, temp, or retract.");
  const value = Number(input.value);
  if (!Number.isFinite(value)) return refuse("bad-argument", "value is the number to save on the filament.");
  const filament = this.filament();
  this.remember("Calibration");
  if (kind === "pa") this.library = setAdvance(this.library, value, advanceFor(filament.linearAdvance, this.library.nozzleMm));
  else if (kind === "flow") this.library = setFlow(this.library, value);
  else if (kind === "temp") this.library = setNozzleTemp(this.library, value);
  else this.library = setRetract(this.library, value, null);
  return { ok: true, kind, value, stale: true, label: "Calibration" };
}

async function blendCompare(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const obj = this.wanted(input);
  if (!isObject(obj)) return obj;
  const committed = await this.commitObject(obj);
  if (committed) return refuse("commit-failed", committed);
  const built = this.sliceBody(obj, "object");
  let reply: { label?: string; toughness?: number; seconds?: number; filamentG?: number; score?: number; error?: string }[];
  try {
    const parsed = JSON.parse(await this.ask(this.engine.pareto(withMesh(JSON.stringify(built.body), built.mesh)))) as typeof reply | { error?: string };
    if (!Array.isArray(parsed)) return refuse("blend-failed", parsed.error ?? "The blends were not compared.");
    reply = parsed;
  } catch (err) {
    return refuse("blend-failed", err instanceof Error ? err.message : "The blends were not compared.");
  }
  this.pareto = reply.filter((point) => typeof point.toughness === "number").map((point) => ({
    label: point.label ?? "",
    toughness: point.toughness ?? 0,
    seconds: point.seconds ?? 0,
    grams: point.filamentG ?? 0,
    score: point.score ?? 0,
  }));
  if (this.pareto.length === 0) return refuse("blend-failed", "The blends were not compared.");
  return { ok: true, points: this.pareto };
}

function blendApply(this: Session, input: Record<string, unknown>): Record<string, unknown> {
  const index = typeof input.index === "number" ? input.index : -1;
  const point = this.pareto[index];
  if (!point) return refuse("no-blend", "Call blend_compare first, then pass a point index.", undefined, NEXT.blend);
  this.remember("Blend");
  if (point.toughness <= 0.001) {
    this.settings = { ...this.settings, blendKind: "single", strategy: "speed" };
  } else if (point.toughness >= 0.999) {
    this.settings = { ...this.settings, blendKind: "single", strategy: "toughness" };
  } else {
    this.settings = { ...this.settings, blendKind: "weight", toughness: point.toughness };
  }
  return { ok: true, index, toughness: point.toughness, stale: true, label: "Blend" };
}

/** The methods this module adds to Session. */
export const calibrationMethods = {
  calibrationTower,
  calibrationApply,
  blendCompare,
  blendApply,
};

export const calibrationHandlers: Record<string, ToolHandler> = {
  calibration_tower: (s, input) => s.calibrationTower(input),
  calibration_apply: (s, input) => s.calibrationApply(input),
  blend_compare: (s, input) => s.blendCompare(input),
  blend_apply: (s, input) => s.blendApply(input),
};
