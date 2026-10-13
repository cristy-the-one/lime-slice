import { bytesToBase64 } from "../base64";
import type { ModelPick, ModelSolid } from "../model-view";
import { authHeaders } from "../ui/api-base";
import { fx } from "./fx";
import { apiBase, apiToken, isStepName } from "./settings";
import { state } from "./state";

let ticket = 0;
let solid: ParsedSolid | null = null;
let picks: ModelPick[] = [];

interface ParsedSolid extends ModelSolid {
  faces: { id: number; areaMm2: number }[];
}

export function bindModelView() {
  fx.model?.onPick((pick: ModelPick) => void onPick(pick));
  document.querySelector("#modelPickFace")?.addEventListener("click", () => setMode("face"));
  document.querySelector("#modelPickEdge")?.addEventListener("click", () => setMode("edge"));
}

export function showModel() {
  const mine = ++ticket;
  picks = [];
  solid = null;
  fx.model?.setSolid(null);
  fx.model?.highlight([]);
  const mesh = state.mesh;
  if (!mesh) {
    readout("Open a STEP file to measure a solid.");
    return;
  }
  if (!isStepName(mesh.name)) {
    readout("Model measure reads a STEP solid. This file is a mesh.");
    return;
  }
  readout("Reading the solid…");
  void load(mine, mesh.name, mesh.bytes, state.stepTolerance);
}

function setMode(mode: "face" | "edge") {
  fx.model?.setPickMode(mode);
  picks = [];
  fx.model?.highlight([]);
  document.querySelector("#modelPickFace")?.setAttribute("aria-pressed", mode === "face" ? "true" : "false");
  document.querySelector("#modelPickFace")?.classList.toggle("on", mode === "face");
  document.querySelector("#modelPickEdge")?.setAttribute("aria-pressed", mode === "edge" ? "true" : "false");
  document.querySelector("#modelPickEdge")?.classList.toggle("on", mode === "edge");
  if (solid) readout(`Volume ${mm(solid.volumeMm3)} mm³. Pick ${mode === "face" ? "a face" : "an edge"}.`);
}

async function load(mine: number, name: string, bytes: ArrayBuffer, chord: number) {
  const body = await post("/api/model", {
    filename: name,
    dataB64: bytesToBase64(new Uint8Array(bytes)),
    stepToleranceMm: chord,
  });
  if (mine !== ticket || state.stage !== "model") return;
  const parsed = asSolid(body);
  if (!parsed) {
    readout(text(body.error) || "Could not read this STEP solid.");
    return;
  }
  solid = parsed;
  fx.model?.setSolid(parsed);
  fx.model?.resize();
  readout(`Volume ${mm(parsed.volumeMm3)} mm³. Pick a face or an edge.`);
}

async function onPick(pick: ModelPick) {
  if (!solid) return;
  const previous = picks[0];
  const same = previous && previous.kind === pick.kind && previous.index === pick.index;
  picks = previous && !same && picks.length === 1 ? [previous, pick] : [pick];
  fx.model?.highlight(picks);
  if (picks.length === 1) {
    readout(`${describe(solid, pick)} Volume ${mm(solid.volumeMm3)} mm³.`);
    return;
  }
  readout("Measuring distance…");
  const mine = ticket;
  const body = await post("/api/model/distance", {
    id: solid.id,
    aKind: picks[0]!.kind,
    aIndex: picks[0]!.index,
    bKind: picks[1]!.kind,
    bIndex: picks[1]!.index,
  });
  if (mine !== ticket || state.stage !== "model") return;
  const distance = typeof body.distanceMm === "number" ? body.distanceMm : null;
  if (distance == null) {
    readout(text(body.error) || "Could not measure that distance.");
    return;
  }
  readout(`${describe(solid, picks[0]!)} ${describe(solid, picks[1]!)} Distance ${mm(distance)} mm.`);
}

function describe(current: ParsedSolid, pick: ModelPick) {
  if (pick.kind === "face") {
    const area = current.faces.find((face) => face.id === pick.index)?.areaMm2;
    return `Face ${pick.index + 1} · ${mm(area ?? Number.NaN)} mm².`;
  }
  const length = current.edges.find((edge) => edge.id === pick.index)?.lengthMm;
  return `Edge ${pick.index + 1} · ${mm(length ?? Number.NaN)} mm.`;
}

function readout(message: string) {
  const node = document.querySelector("#modelReadout");
  if (node) node.textContent = message;
}

function mm(value: number) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asSolid(body: Record<string, unknown>): ParsedSolid | null {
  if (typeof body.volumeMm3 !== "number" || !Array.isArray(body.positions) || !Array.isArray(body.triangles)) return null;
  const faces = Array.isArray(body.faces) ? body.faces.flatMap((face) => {
    if (!face || typeof face !== "object") return [];
    const row = face as { id?: unknown; areaMm2?: unknown };
    if (typeof row.id !== "number" || typeof row.areaMm2 !== "number") return [];
    return [{ id: row.id, areaMm2: row.areaMm2 }];
  }) : [];
  const edges = Array.isArray(body.edges) ? body.edges.flatMap((edge) => {
    if (!edge || typeof edge !== "object") return [];
    const row = edge as { id?: unknown; lengthMm?: unknown; points?: unknown };
    if (typeof row.id !== "number" || typeof row.lengthMm !== "number" || !Array.isArray(row.points)) return [];
    return [{ id: row.id, lengthMm: row.lengthMm, points: Float32Array.from(row.points.filter((item) => typeof item === "number")) }];
  }) : [];
  return {
    id: typeof body.id === "number" ? body.id : 1,
    volumeMm3: body.volumeMm3,
    positions: Float32Array.from(body.positions.filter((item) => typeof item === "number")),
    triangles: body.triangles.filter((item) => typeof item === "number"),
    faces,
    edges,
  };
}

async function post(path: string, payload: unknown): Promise<Record<string, unknown>> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  try {
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      const command = path.endsWith("/distance") ? "model_distance" : "model_solid";
      return JSON.parse(await invoke<string>(command, { payload: JSON.stringify(payload) })) as Record<string, unknown>;
    }
    const res = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: authHeaders(apiToken(), { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok && typeof body.error !== "string") return { error: "Could not read this STEP solid." };
    return body;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read this STEP solid.";
    if (message === "Failed to fetch") {
      return { error: `Model measure needs the slicer engine at ${apiBase()}. Start it with cargo run -p lime-slice --release -- serve.` };
    }
    return { error: message };
  }
}
