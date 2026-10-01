import { formatProgress, mockSliceProgress, progressFromEvent } from "./slice-progress.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const held = mockSliceProgress(0);
check("mock holds indeterminate at start", held.fraction === 0 && held.source === "mock" && held.etaSeconds == null);
const early = mockSliceProgress(399);
check("mock still unknown just before the hold ends", early.fraction === 0);

const moving = mockSliceProgress(4_000);
check("mock then advances", moving.fraction > 0.1 && moving.fraction < 0.9 && moving.source === "mock");
check("mock eta counts down", (moving.etaSeconds ?? 0) < 12 && (moving.etaSeconds ?? 0) > 0);
check("mock label is marked estimated", formatProgress(moving).startsWith("est. "));

const real = progressFromEvent(0.25, 4_000);
check("event eta is three times elapsed at 25%", Math.abs((real.etaSeconds ?? 0) - 12) < 0.01 && real.source === "event");
check("event label has no estimate prefix", formatProgress(real) === "25% · ~12 s");
check("unknown event stays blank", formatProgress(progressFromEvent(0, 1000)) === "");
check("finished event has no eta", progressFromEvent(1, 1000).etaSeconds == null);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("slice-progress: event and mock ok");
