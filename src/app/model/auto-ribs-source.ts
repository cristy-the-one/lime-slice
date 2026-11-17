/**
 * Auto ribs: where the panel's plans come from. This is the one file that binds the planner.
 *
 * - In the desktop window: the Tauri commands `rib_plan_start {body}`, `rib_plan_poll {id}`, `rib_plan_cancel {id}`
 *   (src-tauri/src/lib.rs, over `lime_sim_bridge::ribs`, the same jobs MCP's ribs_plan runs).
 * - In a browser on `lime-slice serve`: the same three as `POST /api/ribs/start|poll|cancel`.
 * - Under test: a page that sets `__limeRibPlanFake` (knobs, or `true`) plans with the deterministic stand-in
 *   (src/auto-ribs-plan.ts `fakePlanSource`), so the browser specs need no engine.
 */
import { enginePlanSource, fakePlanSource, type FakeKnobs, type PlanSource, type PlanTransport } from "../../auto-ribs-plan.ts";
import { isTauri } from "../../platform.ts";
import { authHeaders } from "../../ui/api-base";
import { apiBase, apiToken } from "../settings";

type FakeHook = FakeKnobs | true | undefined;

const fakeKnobs = (): FakeKnobs => {
  const hook = (globalThis as { __limeRibPlanFake?: FakeHook }).__limeRibPlanFake;
  return hook && hook !== true ? hook : {};
};

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const tauriTransport: PlanTransport = {
  async start(body) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("rib_plan_start", { body });
  },
  async poll(id) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("rib_plan_poll", { id });
  },
  async cancel(id) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("rib_plan_cancel", { id });
  },
  pause,
};

/** `serve`'s routes. A page with no engine behind it gets the sentence the modeler's own calls give. */
async function http(route: string, body: string): Promise<string> {
  try {
    const res = await fetch(`${apiBase()}/api/ribs/${route}`, { method: "POST", headers: authHeaders(apiToken(), { "Content-Type": "application/json" }), body });
    return await res.text();
  } catch {
    return JSON.stringify({ error: `Auto ribs needs the slicer engine at ${apiBase()}. Start it with cargo run -p lime-slice --release -- serve, or use the desktop app.` });
  }
}

const httpTransport: PlanTransport = {
  start: (body) => http("start", body),
  poll: (id) => http("poll", JSON.stringify({ id })),
  cancel: (id) => http("cancel", JSON.stringify({ id })),
  pause,
};

/** The source a plan starts from now. */
export function planSource(): PlanSource {
  const hook = (globalThis as { __limeRibPlanFake?: FakeHook }).__limeRibPlanFake;
  if (hook) return fakePlanSource(fakeKnobs);
  return enginePlanSource(typeof window !== "undefined" && isTauri() ? tauriTransport : httpTransport);
}
