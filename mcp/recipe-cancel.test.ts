/** A cancelled background recipe stops and rolls back, even when cancellation arrives during its build. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEngine } from "./engine.ts";
import { findLust } from "./recipe.ts";
import { Session } from "./session.ts";

if (!findLust()) {
  if (process.env.LIME_RECIPE_REQUIRED === "1") throw new Error("recipe cancellation test needs lust");
  console.log("recipe cancellation: skipped (needs lust)");
  process.exit(0);
}
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-recipe-cancel-"));
process.env.LIME_MCP_REPLY_S = "0.05";
process.env.LIME_MCP_FAKE_MODEL_MS = "200";
const session = new Session(fakeEngine());
const source = `use lime_recipe::{ops, Session};
fn main() {
    let mut s = Session::start();
    let p = s.solid_new(ops::cuboid(10.0, 10.0, 2.0)).unwrap();
    for _ in 0..10 { s.apply(&p, ops::boolean("fuse", ops::cuboid(1.0, 1.0, 1.0), [0.0, 0.0, 2.0])).unwrap(); }
    s.done(&p);
}
`;
const warm = await session.call("recipe_run", { name: "cancel-test", source, mode: "check" });
if (warm.status === "running") {
  let ready = warm;
  while (ready.status === "running") ready = await session.call("slice_wait", { job: warm.job, timeoutS: 1 });
  if (ready.ok !== true) throw new Error(`warm build failed: ${JSON.stringify(ready)}`);
} else if (warm.ok !== true) throw new Error(`warm build failed: ${JSON.stringify(warm)}`);
const job = await session.call("recipe_run", { name: "cancel-test", source, timeoutS: 30 });
if (job.status !== "running" || typeof job.job !== "string") throw new Error(`recipe did not detach: ${JSON.stringify(job)}`);
for (let i = 0; i < 50 && !session.workJobs.find((row) => row.handle === job.job)?.ctx.stage?.includes("call "); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
if (!session.workJobs.find((row) => row.handle === job.job)?.ctx.stage?.includes("call ")) throw new Error("recipe did not start a model call");
let cancelled = await session.call("slice_cancel", { job: job.job });
while (cancelled.status === "cancelling") cancelled = await session.call("slice_wait", { job: job.job, timeoutS: 1 });
if (cancelled.ok !== false || !String(cancelled.reason).includes("cancelled") || session.objects.length !== 0) throw new Error(`recipe was not cancelled and rolled back: ${JSON.stringify(cancelled)}`);
console.log("recipe cancellation: ok");
process.exit(0);
