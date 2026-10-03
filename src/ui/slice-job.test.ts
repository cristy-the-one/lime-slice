import { progressFromEvent } from "./slice-progress.ts";
import {
  beginSliceJob,
  followJobProgress,
  formatStageLine,
  jobEtaSeconds,
  jobEventsUrl,
  parseJobSnapshot,
  stageLabel,
  takeSseEvents,
  type JobSnapshot,
} from "./slice-job.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

const snap = (over: Partial<JobSnapshot> & Pick<JobSnapshot, "status" | "fraction">): JobSnapshot => ({
  id: "7",
  stage: "part",
  done: 2,
  total: 4,
  ...over,
});

const donePayload = JSON.stringify(snap({ status: "done", fraction: 1, stage: "emit", done: 4, total: 4 }));
const first = `data: ${JSON.stringify(snap({ status: "running", fraction: 0.06, stage: "cut", done: 1, total: 4 }))}\n\n`;
const partial = `data: ${donePayload.slice(0, 20)}`;
const taken = takeSseEvents(first + partial);
eq("sse keeps one complete event", taken.events.length, 1);
eq("sse snapshot is the cut stage", parseJobSnapshot(taken.events[0]!)?.stage, "cut");
const rest = takeSseEvents(taken.rest + donePayload.slice(20) + "\n\n");
eq("sse finishes a split event", parseJobSnapshot(rest.events[0]!)?.status, "done");
check("a non-snapshot is ignored", parseJobSnapshot("[]") == null && parseJobSnapshot("{") == null);

eq("stage name", stageLabel("part"), "Walls and infill");
eq("stage line counts the layer", formatStageLine(snap({ status: "running", fraction: 0.4 })), "Walls and infill 2/4");
check("eta at 40% is 1.5 times elapsed", Math.abs((jobEtaSeconds(0.4, 2_000) ?? 0) - 3) < 0.01);
check("eta matches the event helper", jobEtaSeconds(0.25, 4_000) === progressFromEvent(0.25, 4_000).etaSeconds);

eq("events url carries the token", jobEventsUrl("http://127.0.0.1:43118", "7", "a b"), "http://127.0.0.1:43118/api/jobs/7/events?token=a%20b");

const missing = await beginSliceJob(async () => ({ status: 404, text: `{"error":"not found"}` }), {});
check("404 falls back", "unsupported" in missing);
const down = await beginSliceJob(async () => { throw new TypeError("Failed to fetch"); }, {});
check("a dead connection falls back", "unsupported" in down);
const started = await beginSliceJob(async () => ({ status: 202, text: `{"id":"9"}` }), { filename: "a.stl" });
eq("202 returns the job id", started, { id: "9" });
let threw = false;
try {
  await beginSliceJob(async () => ({ status: 500, text: `{"error":"boom"}` }), {});
} catch (err) {
  threw = err instanceof Error && err.message === "boom";
}
check("a job error is not a fallback", threw);

const seen: string[] = [];
let polls = 0;
const polled = await followJobProgress({
  eventsUrl: jobEventsUrl("http://engine", "7", "s3cret"),
  openEvents: (_url, handlers) => {
    queueMicrotask(() => handlers.onError());
    return { close() {} };
  },
  poll: async () => {
    polls += 1;
    if (polls === 1) return snap({ status: "running", fraction: 0.2, stage: "cut", done: 1, total: 4 });
    return snap({ status: "done", fraction: 1, stage: "emit", done: 4, total: 4 });
  },
  sleep: async () => {},
  shouldStop: () => false,
  onUpdate: (next) => seen.push(next.stage),
});
eq("poll fallback reaches done", polled.status, "done");
eq("poll fallback reports both stages", seen, ["cut", "emit"]);

let stop = false;
let cancelSaw = false;
const hanging = followJobProgress({
  eventsUrl: "http://engine/api/jobs/7/events",
  openEvents: null,
  poll: async () => snap({ status: "running", fraction: 0.2, stage: "supports", done: 1, total: 3 }),
  sleep: async () => { stop = true; },
  shouldStop: () => stop,
  onUpdate: () => { cancelSaw = true; },
});
let cancelled = false;
try {
  await hanging;
} catch (err) {
  cancelled = err instanceof Error && err.message === "cancelled";
}
check("cancel stops the poll", cancelled && cancelSaw);

const streamed = await followJobProgress({
  eventsUrl: "http://engine/api/jobs/7/events?token=s3cret",
  openEvents: (url, handlers) => {
    check("stream opens the events url", url.includes("token=s3cret"));
    handlers.onMessage(JSON.stringify(snap({ status: "running", fraction: 0.5, stage: "travel", done: 1, total: 2 })));
    handlers.onMessage(JSON.stringify(snap({ status: "done", fraction: 1, stage: "emit", done: 2, total: 2 })));
    return { close() {} };
  },
  poll: async () => { throw new Error("poll should not run after a terminal event"); },
  sleep: async () => {},
  shouldStop: () => false,
  onUpdate: () => {},
});
eq("sse terminal snapshot wins", streamed.stage, "emit");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("slice-job: sse, poll, cancel, and eta ok");
