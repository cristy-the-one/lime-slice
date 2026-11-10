/**
 * slice_wait keeps its own limit when the slicer's process is slow to answer a poll (it answers calls in turn, and a
 * finished slice crosses over whole), and a poll that was still out when the wait ended is not asked again: the next
 * wait takes its answer, so a finished result is never dropped. Stand-in engine with a poll that answers late.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-slice-wait-"));
process.env.LIME_MCP_BRIDGE = "0";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

const POLL_MS = 600;
const inner = fakeEngine();
let polls = 0;
let fail = false;
const engine = {
  ...inner,
  // Each poll answers after POLL_MS, as a poll queued behind another call of the slicer's process does.
  slicePoll: (id: string) => {
    polls += 1;
    return new Promise<string>((resolve, reject) => setTimeout(() => (fail ? reject(new Error("The slicer went away.")) : resolve(inner.slicePoll(id) as string)), POLL_MS));
  },
};
const session = new Session(engine);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (name: string, args: unknown = {}) => session.call(name, args) as Promise<Record<string, any>>;

const object = (await call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 10 })).object as string;
await call("model_commit", { object });
const started = await call("slice_start", {});
check("the slice started", typeof started.job === "string", started);

let t = Date.now();
const first = await call("slice_wait", { job: started.job, timeoutS: 0.1 });
const firstMs = Date.now() - t;
console.log(`slice_wait {timeoutS: 0.1} with a poll that takes ${POLL_MS} ms: answered in ${firstMs} ms`);
check("a wait returns at its limit while the poll is still out", first.ok === true && first.status === "running" && firstMs < POLL_MS - 150, { first, firstMs });
check("it asked one poll", polls === 1, String(polls));

t = Date.now();
const second = await call("slice_wait", { job: started.job, timeoutS: 5 });
const secondMs = Date.now() - t;
check("the next wait takes that poll's answer: the finished slice, asked for once", second.status === "done" && typeof second.seconds === "number" && polls === 1 && secondMs < POLL_MS + 200, { second, polls, secondMs });
check("the result is whole", (await call("gcode_summary", { job: started.job })).ok === true);
const third = await call("slice_wait", { job: started.job, timeoutS: 5 });
check("a done job answers at once, with no poll", third.status === "done" && polls === 1);

// A poll that fails after the wait gave up is reported by the next wait, not lost as an unhandled rejection.
await call("object_place", { object, centreX: 60, centreY: 60 });
const again = await call("slice_start", {});
fail = true;
const waiting = await call("slice_wait", { job: again.job, timeoutS: 0.1 });
check("the wait still returns at its limit", waiting.status === "running", waiting);
const thrown = await (async () => call("slice_wait", { job: again.job, timeoutS: 5 }))().then((value) => value, (err: unknown) => ({ threw: err instanceof Error ? err.message : String(err) }));
check("the failed poll surfaces on the next wait", "threw" in thrown && String(thrown.threw).includes("went away"), thrown);

if (failed > 0) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("slice wait: all checks passed");
