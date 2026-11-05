/**
 * What a first run looks like. "First run" is a launch with no saved settings level: nobody has picked one yet.
 * A saved level, whatever it is, makes the launch a returning one and keeps today's behaviour exactly.
 */
export type SettingsLevel = "simple" | "advanced" | "expert";

export const LEVEL_KEY = "lime-slice-settings-level";

/** The stored level, or Simple on a first run. */
export function levelFromStored(raw: string | null): SettingsLevel {
  if (raw === "simple" || raw === "advanced" || raw === "expert") return raw;
  return "simple";
}

export function isFirstRun(raw: string | null): boolean {
  return raw !== "simple" && raw !== "advanced" && raw !== "expert";
}

/** A first run with nothing on the plate opens Prepare, where the next step (add a model) is. A returning launch keeps Preview. */
export function startStage(raw: string | null, hasMesh: boolean): "prepare" | "preview" {
  return isFirstRun(raw) && !hasMesh ? "prepare" : "preview";
}
