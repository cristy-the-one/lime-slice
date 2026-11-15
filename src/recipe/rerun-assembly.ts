/**
 * --- Recipe API 1.16 (docs/plan-plugin-recipes.md, stage 2). A recipe that assembles the parts it made, run again with
 * new values: the new parts take the old parts' handles (the MCP session's `takeOver`), so the assemblies the new run
 * built name the old handles too, and they take the place of the old run's: one assembly, the old one's id and name,
 * with the new run's offsets, joints and couplings. A part the run did not make, which someone put in that assembly
 * after the run (a frame the train was mounted on), stays where it was, and so does the link that mounts a part of the
 * run on it.
 */
import { withCouplings, type Assembly, type Coupling, type GearRef, type Member } from "../assembly.ts";

/** `coupling` with every object it names passed through `to`. */
function renamedCoupling(coupling: Coupling, to: (id: string) => string): Coupling {
  return {
    ...coupling,
    driver: to(coupling.driver),
    driven: to(coupling.driven),
    // A found mesh names its two gears; a declared coupling (ratio, winch, ratchet, clutch) has none, and a ratchet
    // may name the part its click is.
    ...(coupling.gears ? { gears: [{ ...coupling.gears[0], object: to(coupling.gears[0].object) }, { ...coupling.gears[1], object: to(coupling.gears[1].object) }] as [GearRef, GearRef] } : {}),
    ...(coupling.click ? { click: { ...coupling.click, object: to(coupling.click.object) } } : {}),
    ...(coupling.carrier ? { carrier: { ...coupling.carrier, body: to(coupling.carrier.body) } } : {}),
  };
}

/** Whether `coupling` names one of `ids`. */
function names(coupling: Coupling, ids: ReadonlySet<string>): boolean {
  return [coupling.driver, coupling.driven, ...(coupling.gears ?? []).map((gear) => gear.object), ...(coupling.click ? [coupling.click.object] : []), ...(coupling.carrier ? [coupling.carrier.body] : [])].some((id) => ids.has(id));
}

/**
 * The assemblies after a rerun handed each new part (`renamed`'s keys) the handle of the old one it replaces (its
 * values). Unchanged when the run built no assembly of its own.
 */
export function rerunAssemblies(assemblies: readonly Assembly[], renamed: ReadonlyMap<string, string>): Assembly[] {
  const to = (id: string) => renamed.get(id) ?? id;
  const fresh = new Set(assemblies.filter((row) => row.members.some((member) => renamed.has(member.object))));
  if (fresh.size === 0) return [...assemblies];
  let out = assemblies.filter((row) => !fresh.has(row));
  for (const built of fresh) {
    const members: Member[] = built.members.map((member) => ({ ...member, object: to(member.object), parent: member.parent === null ? null : to(member.parent) }));
    const ids = new Set(members.map((member) => member.object));
    const couplings = (built.couplings ?? []).map((row) => renamedCoupling(row, to));
    const old = out.filter((row) => row.members.some((member) => ids.has(member.object)));
    let next: Assembly = withCouplings({ id: old[0]?.id ?? built.id, name: old[0]?.name ?? built.name, members }, couplings);
    for (const row of old) {
      // A part of the run that hung on a part from outside it keeps that link; the outside parts stay as they were.
      const kept = new Map(row.members.filter((member) => ids.has(member.object) && member.parent !== null && !ids.has(member.parent)).map((member) => [member.object, member]));
      const others = row.members.filter((member) => !ids.has(member.object));
      next = withCouplings({ ...next, members: [...next.members.map((member) => kept.get(member.object) ?? member), ...others] }, [...(next.couplings ?? []), ...(row.couplings ?? []).filter((coupling) => !names(coupling, ids))]);
    }
    const at = old.length ? out.indexOf(old[0]!) : out.length;
    out = [...out.slice(0, at).filter((row) => !old.includes(row)), next, ...out.slice(at).filter((row) => !old.includes(row))];
  }
  return out;
}
