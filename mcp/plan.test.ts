/**
 * plan_run against the stand-in engine: references between steps, a bad reference, a refused middle step, and a plan
 * that runs past the reply time and answers with a job.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { GUIDES } from "./guides.ts";
import { planProblem, resolveReferences } from "./plan.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-plan-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

async function reply(session: Session, name: string, args: unknown): Promise<Record<string, unknown> | string> {
  try {
    return await session.call(name, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

type StepRow = { step: number; tool: string; result?: Record<string, unknown> };

// A solid and its top face in one call, the face list read through a reference to the new object.
{
  const session = new Session(fakeEngine());
  const plan = await session.call("plan_run", {
    steps: [
      { tool: "solid_new", args: { primitive: "box", dx: 40, dy: 30, dz: 10 } },
      { tool: "faces_find", args: { object: "$1.object", normal: [0, 0, 1] } },
      { tool: "workplane_set", args: { object: "$1.object", faceIndex: "$2.faces.0.index" } },
    ],
  });
  const steps = plan.steps as StepRow[];
  const made = steps[0]?.result?.object;
  const faces = steps[1]?.result?.faces as { index: number; normal: number[] }[] | undefined;
  check("a plan makes a solid and reads its faces in one call", plan.ok === true && steps.length === 3 && typeof made === "string" && (faces?.length ?? 0) >= 1, JSON.stringify(plan).slice(0, 600));
  check("the reference handed step 2 the new object", steps[1]?.result?.ok === true && (faces?.[0]?.normal[2] ?? 0) > 0.99, JSON.stringify(steps[1]).slice(0, 400));
  check("a number reference stays a number", steps[2]?.result?.ok === true, JSON.stringify(steps[2]));
  const alone = await session.call("faces_find", { object: made, normal: [0, 0, 1] });
  check("the plan's step answers as the call alone does", JSON.stringify(alone.faces) === JSON.stringify(faces), JSON.stringify(alone).slice(0, 300));
  const history = await session.call("model_history", { object: made });
  check("the plan's steps are ordinary steps in the history", history.ok === true, JSON.stringify(history).slice(0, 300));
}

// References that cannot work are refused with the step and the path.
{
  const session = new Session(fakeEngine());
  const ahead = await reply(session, "plan_run", { steps: [{ tool: "faces_find", args: { object: "$2.object" } }, { tool: "session_info" }] });
  check("a reference to a later step is refused before anything runs", ahead === "Step 1: $2.object at args.object refers to step 2, which does not run before step 1. A reference names an earlier step, from 1.", String(ahead));
  const malformed = await reply(session, "plan_run", { steps: [{ tool: "session_info" }, { tool: "faces_find", args: { object: "$one.object" } }] });
  check("a malformed reference is refused with its path", malformed === "Step 2: \"$one.object\" at args.object is not a reference. Write \"$N.path\" with N an earlier step's number, e.g. \"$1.object\", or start with \"$$\" for a literal \"$\".", String(malformed));
  const nested = await reply(session, "plan_run", { steps: [{ tool: "plan_run", args: { steps: [{ tool: "session_info" }] } }] });
  check("plan_run cannot be a step", nested === "Step 1: plan_run cannot run inside a plan. Put its steps in this plan instead.", String(nested));
  const tooMany = await reply(session, "plan_run", { steps: Array.from({ length: 26 }, () => ({ tool: "session_info" })) });
  check("more than 25 steps is refused", tooMany === "input.steps is too long.", String(tooMany));
  const missing = await session.call("plan_run", {
    steps: [
      { tool: "solid_new", args: { primitive: "box", dx: 10, dy: 10, dz: 10 } },
      { tool: "faces_find", args: { object: "$1.object", normal: [0, 0, 1] } },
      { tool: "workplane_set", args: { object: "$1.object", faceIndex: "$2.margins.0.value" } },
    ],
  });
  check(
    "a reference that names nothing stops the plan at that step",
    missing.ok === false && missing.failedStep === 3 && missing.reason === "Step 3: $2.margins.0.value names nothing: step 2's result has no margins." && (missing.steps as StepRow[]).length === 2,
    JSON.stringify(missing).slice(0, 400),
  );
}

// A refused middle step stops the plan; the steps before it stay, the steps after it do not run.
{
  const session = new Session(fakeEngine());
  const plan = await session.call("plan_run", {
    steps: [
      { tool: "solid_new", args: { primitive: "box", dx: 20, dy: 20, dz: 20 } },
      { tool: "model_apply", args: { object: "$1.object", op: { kind: "fillet", edges: [0], radius: 1 } } },
      { tool: "model_commit", args: { object: "$1.object" } },
    ],
  });
  const steps = plan.steps as (StepRow & { ok?: boolean; reason?: string })[];
  check(
    "a failing middle step stops the plan and says which",
    plan.ok === false && plan.failedStep === 2 && steps.length === 2 && steps[1]?.ok === false
      && String(plan.reason).startsWith("Step 2 (model_apply) failed: input.op.radius is not a field of this tool. A fillet op takes edges"),
    JSON.stringify(plan).slice(0, 600),
  );
  const listed = await session.call("plate_list", {});
  check("the steps before the failed one stay applied", (listed.objects as unknown[]).length === 1, JSON.stringify(listed).slice(0, 300));
  const refusedPlan = await session.call("plan_run", { steps: [{ tool: "object_select", args: { object: "obj_99" } }, { tool: "session_info" }] });
  check("a refusal (ok false) stops the plan too", refusedPlan.ok === false && refusedPlan.failedStep === 1 && String(refusedPlan.reason).startsWith("Step 1 (object_select) was refused: "), JSON.stringify(refusedPlan).slice(0, 300));
}

// A plan that runs past the reply time answers with a job; slice_wait returns the plan's result.
{
  process.env.LIME_MCP_REPLY_S = "0.2";
  process.env.LIME_MCP_FAKE_MODEL_MS = "150";
  const session = new Session(fakeEngine());
  const first = await session.call("plan_run", {
    steps: [
      { tool: "solid_new", args: { primitive: "box", dx: 20, dy: 20, dz: 20 } },
      { tool: "model_apply", args: { object: "$1.object", op: { kind: "scale", factor: 1.5 }, probe: true } },
      { tool: "model_apply", args: { object: "$1.object", op: { kind: "scale", factor: 0.5 }, probe: true } },
    ],
  });
  const busy = await session.call("model_undo", { object: "obj_1" });
  let done = first;
  for (let i = 0; i < 40 && first.status === "running" && done.status !== "done"; i += 1) done = await session.call("slice_wait", { job: first.job, timeoutS: 5 });
  delete process.env.LIME_MCP_REPLY_S;
  delete process.env.LIME_MCP_FAKE_MODEL_MS;
  check("an edit while the plan runs is refused with the plan's job", busy.ok === false && String(busy.reason).startsWith(`plan_run is still running in the background as ${String(first.job)}`), JSON.stringify(busy));
  check("a long plan answers with a job", first.status === "running" && first.tool === "plan_run", JSON.stringify(first).slice(0, 300));
  check("slice_wait on the plan's job returns the plan's result", done.ok === true && done.status === "done" && (done.steps as unknown[]).length === 3, JSON.stringify(done).slice(0, 400));
}

// The pure parts.
check("$$ is a literal dollar", JSON.stringify(resolveReferences({ label: "$$5" }, [], 1)) === JSON.stringify({ value: { label: "$5" } }));
check("$1 alone is the whole result", JSON.stringify(resolveReferences(["$1"], [{ ok: true }], 2)) === JSON.stringify({ value: [{ ok: true }] }));
check("a reference inside a list is checked", planProblem([{ tool: "a" }, { tool: "b", args: { at: [0, "$3.x"] } }]) === "Step 2: $3.x at args.at[1] refers to step 3, which does not run before step 2. A reference names an earlier step, from 1.");
const plans = GUIDES.find((row) => row.uri === "lime://guide/plans");
check("the plans guide is served", !!plans && plans.text.includes("$2.faces.0.index"));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("plan: ok");
