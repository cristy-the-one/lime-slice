/**
 * Animation plugins in the library (docs/plan-animation-plugins.md A2–A4): which names an animation run used, which of
 * its text parameters name assembly members, what an assembly must have to play it, and the one sentence when it
 * lacks a member. Shared by the MCP server and the window, so both refuse and describe alike. No DOM, no Node.
 */
/** A member as these checks see it: its name in the rig. */
type Named = { name: string };

/**
 * A name or pattern as an animation names members: `*` is any run of characters, `|` joins alternatives, each
 * alternative trimmed and matched against the whole name. `rigGroup` (src/pose-anim.ts) resolves names with it.
 */
export function nameMatcher(pattern: string): (name: string) => boolean {
  const matchers = pattern.split("|").map((part) => new RegExp(`^${part.trim().split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
  return (name) => matchers.some((matcher) => matcher.test(name));
}

/**
 * Each member's name as an animation sees it: the part's name as displayed, a repeated name given `-2`, `-3`, … in
 * member order, and "Part" for one without a name. `animationRig` (src/pose-anim.ts) names the rig with it.
 */
export function memberNamesOf(members: readonly { object: string }[], nameOf: (object: string) => string | undefined): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const member of members) {
    const base = nameOf(member.object)?.trim() || "Part";
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name); names.set(member.object, name);
  }
  return names;
}

/** The members a name or pattern matches, in rig order. */
export function membersMatching<T extends Named>(rig: readonly T[], pattern: string): T[] {
  const match = nameMatcher(pattern);
  return rig.filter((row) => match(row.name));
}

/** A declared parameter, as the header's `params` caches it: only what this module reads. */
export interface MemberParamDecl { name: string; kind: string; default?: unknown; label?: string }

/** At most this many members are named in a sentence; the rest are counted. */
const LISTED = 12;
/** Header lists: at most this many entries, each at most this long (a name or a pattern). */
export const MEMBER_LIST_MAX = 64;
export const MEMBER_NAME_MAX = 120;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The member names or patterns one call of an animation script sends: an `animate` call's key poses, key colours and
 * palette, and a rig read's members and the pose it is taken at. Empty for any other call.
 */
export function namesInCall(tool: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keysOf = (value: unknown) => { if (record(value)) out.push(...Object.keys(value)); };
  if (tool === "animate") {
    keysOf(args.colors);
    if (Array.isArray(args.keys)) for (const key of args.keys) if (record(key)) { keysOf(key.set); keysOf(key.colors); }
  } else if (tool === "rig_contact" || tool === "rig_clearance" || tool === "rig_angle") {
    for (const field of ["member", "a", "b", "against"]) if (typeof args[field] === "string") out.push(args[field] as string);
    if (record(args.pose)) keysOf(args.pose.set);
  }
  return out.filter((name) => name.trim() !== "");
}

/**
 * The names one call sends only to colour a member (an `animate` call's palette and key colours), and those it sends
 * to pose, key or read one. A name in both lists is posed: only a name that is never posed, keyed or read is optional.
 */
export function colourNamesInCall(tool: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keysOf = (value: unknown) => { if (record(value)) out.push(...Object.keys(value)); };
  if (tool === "animate") {
    keysOf(args.colors);
    if (Array.isArray(args.keys)) for (const key of args.keys) if (record(key)) keysOf(key.colors);
  }
  return out.filter((name) => name.trim() !== "");
}

/** The names `namesInCall` finds that are not colour keys: poses, rig reads. */
export function posedNamesInCall(tool: string, args: Record<string, unknown>): string[] {
  const posed: string[] = [];
  if (tool === "animate") {
    if (Array.isArray(args.keys)) for (const key of args.keys) if (record(key) && record(key.set)) posed.push(...Object.keys(key.set));
  } else posed.push(...namesInCall(tool, args));
  return posed.filter((name) => name.trim() !== "");
}

/** What a run tracks of the names a script sends: all of them, and the ones sent only to colour a member. */
export function nameTracker(): { add(tool: string, args: Record<string, unknown>): void; used(): string[]; colourOnly(): string[] } {
  const all = new Set<string>(), colour = new Set<string>(), posed = new Set<string>();
  return {
    add(tool, args) {
      for (const name of namesInCall(tool, args)) all.add(name);
      for (const name of colourNamesInCall(tool, args)) colour.add(name);
      for (const name of posedNamesInCall(tool, args)) posed.add(name);
    },
    used: () => [...all],
    colourOnly: () => [...colour].filter((name) => !posed.has(name)),
  };
}

/**
 * An `animate` call with the colours of optional members this assembly lacks taken out, and a sentence for each one
 * taken out. Only a name the plugin lists as optional (never posed, keyed or read) is skipped; any other missing name
 * is the sampler's refusal as before.
 */
export function skipMissingOptional(args: Record<string, unknown>, optional: readonly string[] | undefined, rig: readonly Named[]): { args: Record<string, unknown>; skipped: string[] } {
  if (!optional?.length) return { args, skipped: [] };
  const absent = new Set(optional.filter((name) => !membersMatching(rig, name).length));
  if (!absent.size) return { args, skipped: [] };
  const skipped: string[] = [];
  const strip = (colors: unknown): unknown => {
    if (!record(colors)) return colors;
    const kept: Record<string, unknown> = {};
    for (const [name, colour] of Object.entries(colors)) { if (absent.has(name)) { if (!skipped.includes(name)) skipped.push(name); } else kept[name] = colour; }
    return kept;
  };
  const out: Record<string, unknown> = { ...args };
  if (out.colors !== undefined) out.colors = strip(out.colors);
  if (Array.isArray(out.keys)) out.keys = out.keys.map((key) => (record(key) && key.colors !== undefined ? { ...key, colors: strip(key.colors) } : key));
  return { args: out, skipped: skipped.map((name) => `This assembly has no member matching "${name}", which the animation only colours, so its colour was skipped.`) };
}

/**
 * What a run says about its member names: the text parameters whose value it used as a member name (in declared
 * order), the names it used as written, that no such parameter gave (sorted), and of those the ones it only coloured
 * (`optionalNames`: an assembly without them still plays; they are not in `memberNames`).
 */
export function membersOfRun(params: readonly MemberParamDecl[], values: Readonly<Record<string, unknown>>, used: Iterable<string>, colourOnly: Iterable<string> = []): { memberParams: string[]; memberNames: string[]; optionalNames: string[] } {
  const usedSet = new Set(used);
  const memberParams: string[] = [];
  const fromParams = new Set<string>();
  for (const param of params) {
    if (param.kind !== "text") continue;
    const value = valueOf(param, values);
    if (typeof value === "string" && usedSet.has(value)) { memberParams.push(param.name); fromParams.add(value); }
  }
  const colourSet = new Set(colourOnly);
  const fixed = [...usedSet].filter((name) => !fromParams.has(name)).sort();
  return { memberParams, memberNames: fixed.filter((name) => !colourSet.has(name)), optionalNames: fixed.filter((name) => colourSet.has(name)) };
}

/** The value a run takes for `param`: the one given, else its default. */
function valueOf(param: MemberParamDecl, values: Readonly<Record<string, unknown>>): unknown {
  return Object.prototype.hasOwnProperty.call(values, param.name) ? values[param.name] : param.default;
}

/** The members as a sentence lists them: "Frame, Wheel and 3 more". */
function listed(rig: readonly Named[]): string {
  const names = rig.map((row) => row.name);
  if (names.length <= LISTED) return names.join(", ");
  return `${names.slice(0, LISTED).join(", ")} and ${names.length - LISTED} more`;
}

/** The sentence for a parameter whose value names no member of this assembly. */
export function missingParamSentence(value: string, param: string, rig: readonly Named[]): string {
  return `This assembly has no member matching "${value}", which the parameter ${param} names: set ${param} to one of its members (${listed(rig)}).`;
}

/** The sentence for a name the animation uses as written that no member of this assembly matches. */
export function missingNameSentence(name: string): string {
  return `This assembly has no member matching "${name}", a name the animation uses as written: name a part ${name}, or keep a version of the animation that takes it as a parameter.`;
}

/**
 * The first member an animation plugin needs that this assembly lacks, as one sentence, or null when it has them all.
 * Member parameters are read with the values given (else their defaults); a parameter that is not declared is skipped.
 */
export function missingMember(rig: readonly Named[], memberParams: readonly string[] | undefined, memberNames: readonly string[] | undefined, params: readonly MemberParamDecl[], values: Readonly<Record<string, unknown>>): string | null {
  for (const name of memberParams ?? []) {
    const param = params.find((row) => row.name === name);
    if (!param) continue;
    const value = valueOf(param, values);
    if (typeof value !== "string" || value.trim() === "") return `The parameter ${name} names no member: set ${name} to one of its members (${listed(rig)}).`;
    if (!membersMatching(rig, value).length) return missingParamSentence(value, name, rig);
  }
  for (const name of memberNames ?? []) if (!membersMatching(rig, name).length) return missingNameSentence(name);
  return null;
}

/**
 * A sampler's "No member matches X." made actionable: when X is the value a run was given for a parameter, the sentence
 * says which parameter to set and to what. Any other reason comes back as it was.
 */
export function explainNoMember(reason: string, values: Readonly<Record<string, unknown>>, rig: readonly Named[]): string {
  const m = /No member matches (.+?)\.(?=[;"'\s]|$)/.exec(reason);
  if (!m) return reason;
  const param = Object.entries(values).find(([, value]) => value === m[1])?.[0];
  return param ? missingParamSentence(m[1]!, param, rig) : reason;
}

/**
 * What an animation plugin needs, on one line: `an assembly with members: wheel (default "Escape wheel"); and Frame as
 * named`. Null for a plugin that names no member (or was kept before member parameters were recorded).
 */
export function needsLine(params: readonly MemberParamDecl[], memberParams: readonly string[] | undefined, memberNames: readonly string[] | undefined, optionalNames?: readonly string[]): string | null {
  const set = (memberParams ?? []).map((name) => {
    const param = params.find((row) => row.name === name);
    return `${name}${typeof param?.default === "string" ? ` (default "${param.default}")` : ""}`;
  });
  const fixed = memberNames ?? [];
  if (!set.length && !fixed.length && !optionalNames?.length) return null;
  const tail = fixed.length ? `${set.length ? "; and " : ""}${fixed.join(", ")} as named` : "";
  const optional = optionalNames?.length ? `${set.length || fixed.length ? "; " : ""}optionally ${optionalNames.join(", ")} (only coloured; skipped when absent)` : "";
  return `an assembly ${set.length || fixed.length ? "with members: " : ""}${set.join(", ")}${tail}${optional}`;
}

/** A header list line (`member-params`, `member-names`): a JSON list of short strings, or null when it does not read. */
export function readMemberList(text: string | undefined): string[] | null {
  if (text === undefined || text.trim() === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || parsed.length > MEMBER_LIST_MAX) return null;
    if (!parsed.every((item) => typeof item === "string" && item.trim() !== "" && [...item].length <= MEMBER_NAME_MAX && !/[\u0000-\u001f\u007f]/.test(item))) return null;
    return [...new Set(parsed as string[])];
  } catch {
    return null;
  }
}

/** The header line's value for a list, or undefined when the list is empty (the line is then left out). */
export function memberListText(list: readonly string[] | undefined): string | undefined {
  return list && list.length ? JSON.stringify(list) : undefined;
}

/**
 * Why a list of member parameters does not fit the declared parameters, as a clause ("wheel is not a parameter the
 * animation declares"), or null when each names a text parameter.
 */
export function memberParamsProblem(memberParams: readonly string[], params: readonly MemberParamDecl[]): string | null {
  for (const name of memberParams) {
    const param = params.find((row) => row.name === name);
    if (!param) return `${name} is not a parameter the animation declares`;
    if (param.kind !== "text") return `${name} is a ${param.kind} parameter, and a member is named by a text parameter`;
  }
  return null;
}

/** How a script declares a member parameter, for a refusal to quote. */
export function memberParamExample(name: string): string {
  return `let ${name} = s.text("${name}", "<member name>").get(); before the first call`;
}

/**
 * The hint a keep gives for names written into the script: which they are, and the lines that make one a parameter, so
 * the next version plays on assemblies whose parts are named otherwise. Null when there are none.
 */
export function fixedNamesHint(memberNames: readonly string[]): string | null {
  if (!memberNames.length) return null;
  const first = memberNames[0]!;
  const param = first.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "member";
  return `The animation names ${memberNames.map((name) => `"${name}"`).join(", ")} as written, so it plays only on assemblies with members of ${memberNames.length === 1 ? "that name" : "those names"}. To fit others, take each as a text parameter with that default and use the value: let ${param} = s.text("${param}", "${first}").label("${first}").get(); then .set(&${param}, ...). Keep it again under the same title for the next version.`;
}
