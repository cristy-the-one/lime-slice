/** Which look a part takes in the Pose stage (`docs/plan-pose.md`, section 4). Pure, so a unit test can read it. */

export type PoseLook = "part" | "selected" | "chain" | "clash";

export interface PoseLooks {
  selectedId: string | null;
  /** The other jointed members a Reach drag would turn (plan D8). */
  chain: ReadonlySet<string>;
  clashing: ReadonlySet<string>;
}

/** A clash wins over the selection, as in the Assembly view; the selection wins over the chain. */
export function lookOf(id: string, scene: PoseLooks): PoseLook {
  if (scene.clashing.has(id)) return "clash";
  if (id === scene.selectedId) return "selected";
  if (scene.chain.has(id)) return "chain";
  return "part";
}
