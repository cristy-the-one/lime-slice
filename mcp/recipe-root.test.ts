/**
 * The MCP recipe root shared between servers (mcp/recipe-root.ts): its key, holding a slot (one holder at a time, taken
 * over only from a process that is gone, raced by real processes), a host's slots and build record inside a process,
 * whole-file writes, and the sweep of the per-pid roots older servers left. No lust: nothing is built here.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { claimSlot, pidAlive, rootKey, rootState, slotDir, sweepStaleRoots, writeWhole } from "./recipe-root.ts";
import { RecipeHost } from "./recipe.ts";

// A child of the race below: wait for the start time, try to take the slot, say whether it did, and stay alive (a
// holder that ended could rightly be taken over) until the parent closes its input.
if (process.argv[2] === "claim") {
  const [, , , dir, slot, at] = process.argv;
  while (Date.now() < Number(at)) { /* spin to the start line */ }
  process.stdout.write(claimSlot(dir!, slot!) ? "won\n" : "lost\n");
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  await new Promise(() => {});
}

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const scratch = mkdtempSync(join(tmpdir(), "lime-recipe-root-test-"));

// --- The key: lust and every crate. Anything a build reads that changes gives another root.
{
  const libs = [{ major: 2, lib: "pub const API: (u32, u32) = (2, 0);" }, { major: 1, lib: "pub const API: (u32, u32) = (1, 12);" }];
  const key = rootKey("/opt/lust", "lust 0.2.0 (build aa)", libs);
  check("a key is 16 hex digits", /^[0-9a-f]{16}$/.test(key), key);
  check("the same lust and crates give the same key, in any order", key === rootKey("/opt/lust", "lust 0.2.0 (build aa)", [...libs].reverse()));
  check("another lust build gives another", key !== rootKey("/opt/lust", "lust 0.2.0 (build ab)", libs));
  check("another lust path gives another", key !== rootKey("/opt/lust2", "lust 0.2.0 (build aa)", libs));
  check("a changed crate gives another", key !== rootKey("/opt/lust", "lust 0.2.0 (build aa)", [libs[0]!, { major: 1, lib: `${libs[1]!.lib} ` }]));
  check("one more crate gives another", key !== rootKey("/opt/lust", "lust 0.2.0 (build aa)", libs.slice(0, 1)));
}

// --- Holding a slot. The pids here are made up; `alive` says which of them run.
{
  const locks = join(scratch, "locks-a");
  const alive = (set: number[]) => (pid: number) => set.includes(pid);
  check("a free slot is taken", claimSlot(locks, "slot-0", 1001, alive([1001])));
  check("its holder is written down", readFileSync(join(locks, "slot-0.g1"), "utf8") === "1001\n");
  check("a held slot is not taken by another", !claimSlot(locks, "slot-0", 1002, alive([1001, 1002])));
  check("nor again by its holder", !claimSlot(locks, "slot-0", 1001, alive([1001])));
  check("another slot is free", claimSlot(locks, "slot-1", 1002, alive([1001, 1002])));
  check("a slot whose holder is gone is taken over", claimSlot(locks, "slot-0", 1003, alive([1002, 1003])));
  check("as the next holder: no lock file is removed", JSON.stringify(readdirSync(locks).filter((n) => n.startsWith("slot-0.")).sort()) === JSON.stringify(["slot-0.g1", "slot-0.g2"]) && readFileSync(join(locks, "slot-0.g2"), "utf8") === "1003\n");
  check("the new holder holds it against the next", !claimSlot(locks, "slot-0", 1004, alive([1003, 1004])));
  check("a pid we may not signal counts as running", pidAlive(process.pid) && !pidAlive(0) && !pidAlive(-5));
  // A process that has the pid of a holder that is gone: the file is not one it wrote.
  const reused = join(scratch, "locks-c");
  mkdirSync(reused);
  writeFileSync(join(reused, "slot-0.g1"), "3001\n");
  check("our own pid in a lock this process did not write is an earlier process's", claimSlot(reused, "slot-0", 3001, alive([3001])) && existsSync(join(reused, "slot-0.g2")));
  // A lock with no pid in it: being written (held), or left by a process that died writing it (free after a minute).
  const unwritten = join(scratch, "locks-d");
  mkdirSync(unwritten);
  writeFileSync(join(unwritten, "slot-0.g1"), "");
  check("a lock just made and not yet written is held", !claimSlot(unwritten, "slot-0", 4001, alive([4001])));
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(join(unwritten, "slot-0.g1"), old, old);
  check("one left unwritten for minutes is taken over", claimSlot(unwritten, "slot-0", 4001, alive([4001])));
  writeFileSync(join(unwritten, "slot-0.gx"), "junk");
  writeFileSync(join(unwritten, "slot-00.g9"), "4002\n");
  check("other files in the folder are not this slot's", !claimSlot(unwritten, "slot-0", 4003, alive([4001, 4003])));
}

// --- A race of real processes: each round, eight start on one line for one free slot, and exactly one gets it. Then
// the holder ends, and eight more race to take it over: again exactly one.
{
  const self = fileURLToPath(import.meta.url);
  const locks = join(scratch, "locks-race");
  const round = (slot: string): Promise<{ won: number; lost: number; holders: ReturnType<typeof spawn>[]; all: ReturnType<typeof spawn>[] }> => new Promise((resolve) => {
    const at = Date.now() + 1500;
    const all: ReturnType<typeof spawn>[] = [];
    const holders: ReturnType<typeof spawn>[] = [];
    let won = 0;
    let lost = 0;
    for (let i = 0; i < 8; i += 1) {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", self, "claim", locks, slot, String(at)], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
      all.push(child);
      child.stdout!.setEncoding("utf8").on("data", (text: string) => {
        if (text.includes("won")) { won += 1; holders.push(child); } else lost += 1;
        if (won + lost === 8) resolve({ won, lost, holders, all });
      });
    }
  });
  const end = (children: ReturnType<typeof spawn>[]) => Promise.all(children.map((child) => new Promise<void>((done) => { child.on("exit", () => done()); child.stdin!.end(); })));
  let exact = 0;
  const rounds = 2;
  for (let r = 0; r < rounds; r += 1) {
    const first = await round(`slot-${r}`);
    // The losers end; the holder stays, and a second wave finds the slot held.
    await end(first.all.filter((child) => !first.holders.includes(child)));
    const second = await round(`slot-${r}`);
    await end(second.all);
    await end(first.holders);
    // The holder is gone now: a third wave takes the slot over, one of them.
    const third = await round(`slot-${r}`);
    await end(third.all);
    if (first.won === 1 && first.lost === 7 && second.won === 0 && second.lost === 8 && third.won === 1 && third.lost === 7) exact += 1;
    else console.error(`round ${r}: ${JSON.stringify({ first: [first.won, first.lost], second: [second.won, second.lost], third: [third.won, third.lost] })}`);
  }
  check("of eight processes racing for a slot exactly one holds it; none takes it while he runs; one takes it over when he is gone", exact === rounds, exact);
}

// --- Inside a process: a root's hosts share its slots; each index is a slot of the root this process holds, a second
// "server" (another table over the same root, standing for another process) gets the next ones, and with the root's
// slots all held a process builds in slots of its own.
{
  const root = join(scratch, "root-a");
  mkdirSync(root);
  const mine = rootState(root);
  check("a root's state is one per root", rootState(root) === mine && rootState(join(scratch, "root-b")) !== mine);
  check("the first two slots of the current major", slotDir(root, mine, 2, 0, true) === "slot-0" && slotDir(root, mine, 2, 1, true) === "slot-1");
  check("asked again, the same slot", slotDir(root, mine, 2, 0, true) === "slot-0");
  check("an older major has slots of its own", slotDir(root, mine, 1, 0, false) === "slot-1-0");
  const other = { slotUse: new Map(), dirs: new Map(), built: new Map() };
  check("another table over the same root gets the slots after ours", slotDir(root, other, 2, 0, true) === "slot-2" && slotDir(root, other, 2, 1, true) === "slot-3");
  for (let n = 4; n < 32; n += 1) writeFileSync(join(root, "locks", `slot-${n}.g1`), `${process.ppid}\n`);
  check("with every slot of the root held, a process builds in a slot of its own", slotDir(root, other, 2, 2, true) === `own-${process.pid}-slot-2`);
}

// --- Two hosts of one root in a process are one table: the slot one built in is not the other's to reuse blindly.
{
  const root = join(scratch, "root-hosts");
  const crateDir = join(fileURLToPath(new URL("..", import.meta.url)), "crates", "lime-recipe");
  const a = new RecipeHost({ crateDir, root, lust: null });
  const b = new RecipeHost({ crateDir, root, lust: null });
  const slotFor = (host: RecipeHost, name: string) => (host as unknown as { slotFor(name: string, major: number): string }).slotFor(name, host.api()[0]);
  const first = slotFor(a, "one");
  check("a name keeps its slot across the hosts of a root", slotFor(b, "one") === first && slotFor(a, "two") !== first && slotFor(b, "two") === slotFor(a, "two"));
  check("and they share one record of what each slot was built from", (a as unknown as { built: unknown }).built === (b as unknown as { built: unknown }).built);
  check("the slots a host lists are the ones this process holds", JSON.stringify(a.slots().sort()) === JSON.stringify(["slot-0", "slot-1"]), a.slots());
  const elsewhere = new RecipeHost({ crateDir, root: join(scratch, "root-elsewhere"), lust: null });
  check("a host of another root has its own", (elsewhere as unknown as { built: unknown }).built !== (a as unknown as { built: unknown }).built && elsewhere.slots().length === 0);
  check("without lust a host's own root is a folder of this process in the temp folder", new RecipeHost({ crateDir, lust: null }).root === join(tmpdir(), `lime-recipes-${process.pid}`));
}

// --- Whole-file writes.
{
  const file = join(scratch, "whole.txt");
  check("a new file is written", writeWhole(file, "one") && readFileSync(file, "utf8") === "one");
  check("the same text is left alone", !writeWhole(file, "one"));
  check("other text replaces it, with no temporary file left", writeWhole(file, "two") && readFileSync(file, "utf8") === "two" && readdirSync(scratch).filter((n) => n.startsWith("whole.txt")).length === 1);
}

// --- The sweep: `lime-recipes-<pid>` of a process that is gone is removed, its socket file first; one whose process
// runs, and every other folder, is left.
{
  const temp = join(scratch, "temp");
  for (const name of ["lime-recipes-111", "lime-recipes-222", "lime-recipes-app", "lime-recipes-333x", "lime-recipes-abc123", "lime-bench-ws-444", `lime-recipes-${process.pid}`]) {
    mkdirSync(join(temp, name, "slot-0", "src"), { recursive: true });
    writeFileSync(join(temp, name, "lust.sock"), "12345");
    writeFileSync(join(temp, name, "slot-0", "src", "main.rs"), "fn main() {}");
  }
  writeFileSync(join(temp, "lime-recipes-555"), "a file, not a root");
  const removed = await sweepStaleRoots(temp, (pid) => pid === 222);
  const left = readdirSync(temp).sort();
  check("the roots of processes that are gone are removed", JSON.stringify(removed) === JSON.stringify(["lime-recipes-111"]), removed);
  check("a running server's root, the app's root and every other folder are left", ["lime-recipes-222", "lime-recipes-app", "lime-recipes-333x", "lime-recipes-abc123", "lime-bench-ws-444", `lime-recipes-${process.pid}`].every((name) => left.includes(name) && existsSync(join(temp, name, "lust.sock"))) && left.includes("lime-recipes-555") && !left.includes("lime-recipes-111"), left);
  check("a folder that is not there is no error", (await sweepStaleRoots(join(scratch, "nowhere"))).length === 0);
}

rmSync(scratch, { recursive: true, force: true });
if (failed > 0) {
  console.error(`recipe-root: ${failed} failed`);
  process.exit(1);
}
console.log("recipe-root: all passed");
process.exit(0);
