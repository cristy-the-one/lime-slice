/**
 * orient_compare: score turns and, when asked, slice the best of them on a copy of the pose.
 * The plate's orientation is put back before the reply, and no job or undo step is kept.
 */
import { filamentGrams } from "../../src/estimate.ts";
import type { Mat3 } from "../../src/mesh-place.ts";
import { better, defaultTurns, scoreTurn, type OrientScore, type OrientTurn } from "../../src/orient-score.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";
import { type PlateObject, roundTo, shownName, standsOnNothing } from "./shared.ts";

function axis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function turnsOf(input: Record<string, unknown>, belt: boolean): OrientTurn[] {
  if (!Array.isArray(input.rotations)) return defaultTurns(belt);
  return input.rotations.map((row) => {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
    return { rotX: axis(item.rotX), rotY: axis(item.rotY), rotZ: axis(item.rotZ) };
  });
}

interface Compared extends OrientScore {
  from: "estimate" | "sliced";
  best?: true;
}

/** Slice one pose without registering a job. Null when the slicer does not finish; the estimate stays. */
async function sliceTurn(session: Session, obj: PlateObject, orient: Mat3): Promise<{ seconds: number; grams: number; unheldMm: number } | null> {
  const saved = obj.orient.slice() as Mat3;
  obj.orient = [...orient] as Mat3;
  let engineId: number | null = null;
  try {
    const built = session.sliceBody(obj, "object");
    built.body.partHold = true;
    const plateBody = Array.isArray(built.body.objects);
    const started = JSON.parse(await session.ask(session.engine.sliceStart(JSON.stringify(built.body), plateBody ? undefined : built.mesh))) as { id?: number };
    if (typeof started.id !== "number") return null;
    engineId = started.id;
    const pollCall = session.engine.slicePollWire
      ? session.engine.slicePollWire.bind(session.engine)
      : session.engine.slicePoll.bind(session.engine);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const poll = JSON.parse(await session.ask(pollCall(String(engineId)))) as { status?: string; wire?: Record<string, unknown>; result?: string; error?: string };
      if (poll.status === "done" && (poll.wire || poll.result)) {
        const wire = poll.wire ?? JSON.parse(poll.result!) as Record<string, unknown>;
        const estimate = (wire.estimate ?? {}) as { seconds?: number; filamentMm?: number };
        const filament = session.filament();
        const hold = standsOnNothing(wire.partHold).standsOnNothing as { unheldMm?: number } | undefined;
        return {
          seconds: Math.round(estimate.seconds ?? 0),
          grams: roundTo(filamentGrams(estimate.filamentMm ?? 0, {
            filamentDiameter: filament.diameterMm,
            filamentDensityGCm3: filament.densityGCm3,
            filamentCostPerKg: filament.costPerKg,
          }), 2),
          unheldMm: typeof hold?.unheldMm === "number" ? hold.unheldMm : 0,
        };
      }
      if (poll.status === "error" || poll.error || poll.status === "cancelled") return null;
      await session.pause(10);
    }
    return null;
  } catch {
    return null;
  } finally {
    obj.orient = saved;
    if (engineId !== null) {
      try { await session.ask(session.engine.sliceCancel(String(engineId))); } catch { /* already finished */ }
    }
  }
}

/** Score every turn. slice true slices the two best; "all" slices every turn. The plate is unchanged. */
export async function orientCompare(session: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const obj = session.find(String(input.object ?? ""));
  if (!obj) return refuse("no-object", "That object is not on the plate.", undefined, NEXT.plate);
  const positions = obj.solid && obj.solid.positions.length >= 9 ? obj.solid.positions : obj.source;
  if (positions.length < 9) return refuse("no-mesh", "That object has no mesh to turn.");
  const printer = session.printer();
  const slice = input.slice === "all" ? "all" : input.slice === true ? "best" : "none";
  if (slice !== "none" && session.running && session.running.status === "running") {
    return refuse("slice-running", `A slice is already running (${session.running.handle}). Wait or cancel it before comparing orientations.`);
  }
  const filament = session.filament();
  const rows: Compared[] = turnsOf(input, printer.kind === "belt").map((turn) => ({
    ...scoreTurn(positions, obj.scale, turn, printer, session.settings.layerHeight, session.library.nozzleMm, filament.densityGCm3),
    from: "estimate",
  }));
  if (rows.length === 0) return refuse("bad-argument", "rotations needs at least one turn.");
  const ranked = rows.map((row, index) => ({ row, index })).sort((a, b) => better(a.row, b.row) || a.index - b.index);
  const count = slice === "all" ? ranked.length : slice === "best" ? Math.min(2, ranked.length) : 0;
  const warnings: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = ranked[i]!.row;
    const exact = await sliceTurn(session, obj, row.orient);
    if (!exact) {
      warnings.push(`rotZ ${row.rotZ} did not slice; that row stays an estimate.`);
      continue;
    }
    // The mark was chosen from the faces. Equal sliced lengths must not move it onto the second row.
    row.seconds = exact.seconds;
    row.grams = exact.grams;
    row.unheldLengthMm = exact.unheldMm;
    row.from = "sliced";
  }
  const winner = ranked[0]!.row;
  winner.best = true;
  return {
    ok: true,
    object: obj.id,
    name: shownName(obj.name),
    best: { rotX: winner.rotX, rotY: winner.rotY, rotZ: winner.rotZ },
    rotations: rows.map((row) => ({
      rotX: row.rotX,
      rotY: row.rotY,
      rotZ: row.rotZ,
      unheldLengthMm: row.unheldLengthMm,
      unheldAreaMm2: row.unheldAreaMm2,
      overhangAreaMm2: row.overhangAreaMm2,
      seconds: row.seconds,
      grams: row.grams,
      from: row.from,
      ...(row.best ? { best: true } : {}),
    })),
    ...(warnings.length ? { warnings } : {}),
    note: "Nothing on the plate changed. object_place {object, rotX, rotY, rotZ} applies the best.",
  };
}
