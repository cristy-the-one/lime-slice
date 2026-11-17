/**
 * Auto ribs: where the panel's plans come from. This is the one file that binds the planner.
 *
 * - In the desktop window: the Tauri commands `rib_plan_start {body}`, `rib_plan_poll {id}`, `rib_plan_cancel {id}`
 *   (src-tauri/src/lib.rs, over `lime_sim_bridge::ribs`, the same jobs MCP's ribs_plan runs). The names and arguments
 *   are `RIB_PLAN_COMMANDS` (src/auto-ribs-plan.ts), checked against lib.rs by src/auto-ribs-plan.test.ts.
 * - In a browser on `lime-slice serve`: the same three as `POST /api/ribs/start|poll|cancel`.
 * - Under test: a page that sets `__limeRibPlanFake` (knobs, or `true`) plans with the deterministic stand-in
 *   (src/auto-ribs-plan.ts `fakePlanSource`), so the browser specs need no engine.
 */
import { enginePlanSource, fakePlanSource, httpPlanTransport, tauriPlanTransport, type FakeKnobs, type PlanSource } from "../../auto-ribs-plan.ts";
import { isTauri } from "../../platform.ts";
import { authHeaders } from "../../ui/api-base";
import { apiBase, apiToken } from "../settings";

type FakeHook = FakeKnobs | true | undefined;

const fakeKnobs = (): FakeKnobs => {
  const hook = (globalThis as { __limeRibPlanFake?: FakeHook }).__limeRibPlanFake;
  return hook && hook !== true ? hook : {};
};

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const tauri = tauriPlanTransport(async (command, args) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>(command, args);
}, pause);

/** `serve`'s routes. A page with no engine behind it gets the sentence the modeler's own calls give. */
const http = httpPlanTransport(async (route, body) => {
  try {
    const res = await fetch(`${apiBase()}${route}`, { method: "POST", headers: authHeaders(apiToken(), { "Content-Type": "application/json" }), body });
    return await res.text();
  } catch {
    return JSON.stringify({ error: `Auto ribs needs the slicer engine at ${apiBase()}. Start it with cargo run -p lime-slice --release -- serve, or use the desktop app.` });
  }
}, pause);

/** The source a plan starts from now. */
export function planSource(): PlanSource {
  const hook = (globalThis as { __limeRibPlanFake?: FakeHook }).__limeRibPlanFake;
  if (hook) return fakePlanSource(fakeKnobs);
  return enginePlanSource(typeof window !== "undefined" && isTauri() ? tauri : http);
}
