/**
 * Targets that read one place, and picks that survive a Model edit. A sliced cantilever, held at one end and pushed
 * down at the other, reads a maxDeflectionMm at the free end and one at the middle. The beam is then made thicker
 * and solved again without a new sim_setup. A study given as face numbers is refused after the same edit.
 * Needs the engine's modelling (OCCT); says it was skipped when the engine has none.
 */
import { fileURLToPath } from "node:url";

import { loadNativeEngine } from "./engine.ts";
import { Session, STALE_FACES } from "./session.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const engine = loadNativeEngine(root);

type Margin = { kind?: string; value?: number; region?: unknown; hotSpot?: { at?: number[] } };
type Vec = [number, number, number];

// A 60 × 10 × 6 mm bar on X, from x = -30 to 30, z = 0 to 6.
const FREE: Vec = [29, 0, 3];
const MIDDLE: Vec = [0, 0, 3];
const RADIUS = 4;
const tip = { sphere: { centre: FREE, radiusMm: RADIUS } };
const middle = { sphere: { centre: MIDDLE, radiusMm: RADIUS } };

async function bar(session: Session): Promise<string | null> {
  let built: Record<string, unknown>;
  try {
    built = await session.call("model_build", { name: "cantilever", base: { primitive: "box", dx: 60, dy: 10, dz: 6 } });
  } catch (err) {
    built = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (built.ok === true) return String(built.object);
  const reason = String(built.reason ?? "");
  if (/open cascade|occt/i.test(reason)) console.log(`cantilever: skipped, ${reason}`);
  else check("cantilever: builds", false, reason);
  return null;
}

/** The bar 4 mm thicker, committed, as a client edits between runs. */
async function thicken(session: Session, object: string): Promise<boolean> {
  const edit = await session.call("model_apply_batch", { object, ops: [{ kind: "boolean", op: "fuse", primitive: "box", centre: [0, 0, 8], dx: 60, dy: 10, dz: 4 }] });
  const commit = await session.call("model_commit", { object });
  if (edit.ok !== true || commit.ok !== true) console.error(JSON.stringify({ edit: edit.reason ?? edit, commit: commit.reason ?? commit }));
  return edit.ok === true && commit.ok === true;
}

function inside(at: number[] | undefined, centre: Vec, radius: number): boolean {
  if (!at || at.length !== 3) return false;
  return Math.hypot(at[0]! - centre[0], at[1]! - centre[1], at[2]! - centre[2]) <= radius + 1e-3;
}

{
  const session = new Session(engine);
  const object = await bar(session);
  if (object) {
    const setup = await session.call("sim_setup", {
      object,
      representation: "sliced",
      hMm: 2,
      card: "inhouse-petg",
      fixtures: [{ kind: "region", region: { box: { min: [-31, -6, -1], max: [-28, 6, 20] } } }],
      loads: [{ kind: "force", region: { box: { min: [28, -6, -1], max: [31, 6, 20] } }, magnitude: 5, direction: [0, 0, -1] }],
      constraints: [
        { kind: "maxDeflectionMm", value: 100, region: tip },
        { kind: "maxDeflectionMm", value: 100, region: middle },
      ],
    });
    check("cantilever: set up with places", setup.ok === true, String(setup.reason ?? ""));
    const first = await session.call("sim_run", { object, checkResolution: false });
    const margins = (first.margins ?? []) as Margin[];
    const [end, mid] = margins;
    const peak = typeof first.maxDisplacementMm === "number" ? first.maxDisplacementMm : NaN;
    check("cantilever: runs, one margin per target", first.ok === true && margins.length === 2, JSON.stringify(first.reason ?? margins));
    check(
      "cantilever: the free end bends more than the middle",
      (end?.value ?? 0) > (mid?.value ?? Infinity),
      `${end?.value} vs ${mid?.value}`,
    );
    check(
      "cantilever: neither reads past the part's peak",
      (end?.value ?? Infinity) <= peak + 1e-9 && (mid?.value ?? Infinity) <= peak + 1e-9,
      `${end?.value}, ${mid?.value}, peak ${peak}`,
    );
    check(
      "cantilever: each hot spot is inside its own region",
      inside(end?.hotSpot?.at, FREE, RADIUS) && inside(mid?.hotSpot?.at, MIDDLE, RADIUS),
      JSON.stringify([end?.hotSpot?.at, mid?.hotSpot?.at]),
    );
    check(
      "cantilever: each margin carries the region as given",
      JSON.stringify(end?.region) === JSON.stringify(tip) && JSON.stringify(mid?.region) === JSON.stringify(middle),
      JSON.stringify([end?.region, mid?.region]),
    );
    check("cantilever: thickened and committed", await thicken(session, object));
    const again = await session.call("sim_run", { object, checkResolution: false });
    const after = ((again.margins ?? []) as Margin[])[0];
    check(
      "cantilever: no new sim_setup, and the thicker bar's free end bends less",
      again.ok === true && (after?.value ?? Infinity) < (end?.value ?? 0),
      JSON.stringify(again.reason ?? [after?.value, end?.value]),
    );
  }
}

{
  const session = new Session(engine);
  const object = await bar(session);
  if (object) {
    const ends = await session.call("faces_find", { object, normal: [1, 0, 0] });
    const starts = await session.call("faces_find", { object, normal: [-1, 0, 0] });
    const face = (reply: Record<string, unknown>) => Number((reply.faces as { index?: number }[] | undefined)?.[0]?.index ?? -1);
    const setup = await session.call("sim_setup", {
      object,
      representation: "sliced",
      hMm: 2,
      card: "inhouse-petg",
      fixtures: [{ kind: "faces", faces: [face(starts)] }],
      loads: [{ kind: "force", faces: [face(ends)], magnitude: 5, direction: [0, 0, -1] }],
      constraints: [{ kind: "maxDeflectionMm", value: 100, region: { faces: [face(ends)] } }],
    });
    check("faces: set up", setup.ok === true, String(setup.reason ?? ""));
    const before = await session.call("sim_run", { object, checkResolution: false });
    check("faces: runs before an edit", before.ok === true, String(before.reason ?? ""));
    check("faces: thickened and committed", await thicken(session, object));
    const after = await session.call("sim_run", { object, checkResolution: false });
    check("faces: refused after an edit, not solved on renumbered faces", after.ok === false && after.reason === STALE_FACES, JSON.stringify(after.reason ?? after.ok));
  }
}

{
  const session = new Session(engine);
  const refusals = [
    [{ kind: "minStiffnessNPerMm", value: 10 }, "A stiffness target needs the region it reads."],
    [{ kind: "relativeDeflectionMm", value: 1, region: tip }, "A relative deflection needs two regions, region and other."],
    [{ kind: "deflectionBandMm", band: [2, 1] }, "A band needs two numbers, the lower first."],
  ] as const;
  for (const [target, sentence] of refusals) {
    const reply = await session.call("sim_setup", { beam: { lengthMm: 20, widthMm: 4, heightMm: 4 }, constraints: [target] });
    check(`refuses ${target.kind} with the solver's sentence`, reply.ok === false && reply.reason === sentence, String(reply.reason));
  }
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sim-region: ok");
