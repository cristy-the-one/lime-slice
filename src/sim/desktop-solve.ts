/**
 * The desktop stress solve. Tauri calls `sim_study`. A page under test can
 * set `__limeSimStudy` and answer without a shell. The browser has neither.
 */
import { isTauri } from "../platform.ts";

export const SOLVE_NEEDS_APP = "The stress solve runs in the desktop app.";

type StudyHook = (body: string) => string | Promise<string>;

export async function solveStudy(body: string): Promise<string> {
  const hook = (globalThis as { __limeSimStudy?: StudyHook }).__limeSimStudy;
  if (hook) return hook(body);
  if (typeof window !== "undefined" && isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("sim_study", { body });
  }
  return JSON.stringify({ ok: false, reason: SOLVE_NEEDS_APP });
}
