/**
 * The app's recipe transport (src/recipe/tauri.ts) against a scripted Tauri runner: the commands it sends, the events
 * it reads, and the shared host's run on top. No Tauri and no lust.
 */
import { AppRecipes, type Invoke, type Listen, type RecipeExitPayload, type RecipeLinePayload } from "./tauri.ts";

let failed = 0;
function check(name: string, cond: boolean, detail: unknown = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

/**
 * A runner stand-in. `recipe` plays the program: it gets each line the window sends and answers with lines or an
 * exit. Every command is logged.
 */
function runner(recipe: (line: string, say: (line: string) => void, exit: (code: number | null, reason?: string) => void) => void, opts: { available?: boolean; buildCode?: number; marks?: string } = {}) {
  const commands: { command: string; args: Record<string, unknown> }[] = [];
  const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const emit = (event: string, payload: unknown) => setTimeout(() => {
    for (const h of handlers.get(event) ?? []) h({ payload });
  }, 0);
  let current = "";
  const invoke: Invoke = async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    commands.push({ command, args });
    if (command === "recipe_available") return (opts.available === false ? { ok: false, reason: "Running plugins needs lust." } : { ok: true, lust: "lust" }) as T;
    if (command === "recipe_build") {
      const code = opts.buildCode ?? 0;
      return { code, stdout: opts.marks ?? "", ...(opts.marks !== undefined ? { marked: true } : {}), stderr: code ? "boom" : "", exe: code ? null : `/root/slot-${String(args.slot)}/recipe`, main: `/root/slot-${String(args.slot)}/src/main.rs` } as T;
    }
    if (command === "recipe_start") {
      current = String(args.run);
      // Another run's lines on the same event are not this run's.
      emit("recipe-line", { run: "someone-else", line: '{"id":99,"call":"model_describe"}' } satisfies RecipeLinePayload);
      return undefined as T;
    }
    if (command === "recipe_send") {
      recipe(String(args.line), (line) => emit("recipe-line", { run: current, line } satisfies RecipeLinePayload), (code, reason) => emit("recipe-exit", { run: current, code, reason: reason ?? null, stderr: "" } satisfies RecipeExitPayload));
      return undefined as T;
    }
    if (command === "recipe_close_input" || command === "recipe_kill") {
      emit("recipe-exit", { run: current, code: command === "recipe_kill" ? null : 0, reason: null, stderr: "" } satisfies RecipeExitPayload);
      return undefined as T;
    }
    throw new Error(`unknown command ${command}`);
  };
  const listen: Listen = async <T,>(event: string, handler: (event: { payload: T }) => void) => {
    const set = handlers.get(event) ?? new Set();
    handlers.set(event, set);
    const h = handler as (event: { payload: unknown }) => void;
    set.add(h);
    return () => set.delete(h);
  };
  return { invoke, listen, commands, listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) };
}

const pair = (r: { invoke: Invoke; listen: Listen }): [Invoke, Listen] => [r.invoke, r.listen];

// --- A recipe that only logs, built and run through the runner.
{
  const r = runner((line, say) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (msg.v === 1) say(JSON.stringify({ id: 1, call: "log", args: { text: "hello" }, at: { line: 3 } }));
    else if (msg.id === 1) say(JSON.stringify({ done: { object: "", metrics: {} } }));
  });
  const app = new AppRecipes(r.invoke, r.listen);
  const built = await app.build("hello", "fn main() {}\r\n", false);
  check("the build goes to the runner", built.ok && built.exe === "/root/slot-0/recipe", built);
  const build = r.commands.find((c) => c.command === "recipe_build")!;
  check("the build is LF text in slot 0", build.args.slot === 0 && build.args.source === "fn main() {}\n", build.args);
  const logged: string[] = [];
  const out = await app.run(built.exe!, { params: {} }, async (site) => {
    logged.push(String(site.args.text));
    return { ok: true, result: { ok: true } };
  }, { timeoutS: 5, maxCalls: 10, maxLineBytes: 4096 });
  check("the run reached done", out.ok && out.calls === 1, out);
  check("the log call was answered, another run's line was not", logged.length === 1 && logged[0] === "hello", logged);
  const start = r.commands.find((c) => c.command === "recipe_start")!;
  check("the runner gets the program and the host's limits", start.args.exe === "/root/slot-0/recipe" && JSON.stringify(start.args.limits) === JSON.stringify({ timeoutS: 5, maxCalls: 10, maxLineBytes: 4096 }), start.args);
  const sends = r.commands.filter((c) => c.command === "recipe_send").map((c) => JSON.parse(String(c.args.line)) as Record<string, unknown>);
  check("the start line, then the reply, in order", sends.length === 2 && sends[0]!.v === 1 && sends[1]!.id === 1 && sends[1]!.ok === true, sends);
  check("every send names the run", r.commands.filter((c) => c.command === "recipe_send").every((c) => c.args.run === start.args.run));
  check("done closes the input", r.commands.some((c) => c.command === "recipe_close_input"));
  check("the listeners are gone after the exit", r.listeners() === 0, r.listeners());
}

// --- The unread s.apply calls lust marked come back with the build; a runner whose lust was not asked gives none.
{
  const mark = JSON.stringify({ schema: 1, kind: "unread_result", fn: "lime_recipe::Session::apply", file: "/root/slot-0/src/main.rs", span: { line: 2, col: 7 } });
  // The mark is at byte column 7 of a line indented with a tab: the call reports column 10 (src/recipe/host.ts).
  const SOURCE = "fn main() {\n\tlet s.apply(a)?;\n}\n";
  const marked = await new AppRecipes(...pair(runner(() => {}, { marks: mark }))).build("m", SOURCE, false);
  check("the marks of a build are its unread calls", JSON.stringify(marked.unread) === JSON.stringify([{ line: 2, col: 10 }]), marked);
  const none = await new AppRecipes(...pair(runner(() => {}, { marks: "" }))).build("m", SOURCE, false);
  check("a lust that was asked and marked nothing: no unread call", JSON.stringify(none.unread) === "[]", none);
  const old = await new AppRecipes(...pair(runner(() => {}))).build("m", SOURCE, false);
  check("a lust that was not asked: no marks at all", old.ok && old.unread === undefined, old);
}

// --- The runner's stop is the run's reason.
{
  const r = runner((line, _say, exit) => {
    if ((JSON.parse(line) as { v?: number }).v === 1) exit(null, "The recipe used more than 1024 MB of memory and was stopped.");
  });
  const app = new AppRecipes(r.invoke, r.listen);
  const out = await app.run("/root/slot-0/recipe", {}, async () => ({ ok: true, result: {} }));
  check("a memory stop reads as the runner said", out.reason === "The recipe used more than 1024 MB of memory and was stopped.", out.reason);
}

// --- Slots: the same name keeps its slot, a fifth name takes the least recently used one.
{
  const r = runner(() => {});
  const app = new AppRecipes(r.invoke, r.listen);
  const slots = ["a", "b", "c", "d", "a", "e"].map((name) => app.slotFor(name));
  check("four names, four slots; a again keeps 0; e takes b's", JSON.stringify(slots) === JSON.stringify([0, 1, 2, 3, 0, 1]), slots);
}

// --- No lust: one sentence, nothing built.
{
  const r = runner(() => {}, { available: false });
  const app = new AppRecipes(r.invoke, r.listen);
  const built = await app.build("x", "fn main() {}", false);
  check("without lust the build says why", !built.ok && built.reason === "Running plugins needs lust.", built);
  check("nothing went to lust", !r.commands.some((c) => c.command === "recipe_build"));
}

// --- A failed build with no diagnostics says what lust said.
{
  const r = runner(() => {}, { buildCode: 2 });
  const app = new AppRecipes(r.invoke, r.listen);
  const built = await app.build("x", "fn main() {}", false);
  check("a failed build carries lust's words", !built.ok && built.reason === "lust failed: boom", built);
}

if (failed) {
  console.error(`recipe tauri: ${failed} failed`);
  process.exit(1);
}
console.log("recipe tauri: ok");
process.exit(0);
