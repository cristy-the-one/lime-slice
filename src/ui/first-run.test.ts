import { isFirstRun, levelFromStored, startStage } from "./first-run.ts";
import { loadRecent, pushRecent, RECENT_KEY, withRecents } from "./palette-recent.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// First run ---------------------------------------------------------------------------------------------------

eq("nothing saved is Simple", levelFromStored(null), "simple");
eq("junk saved is Simple", levelFromStored("pro"), "simple");
eq("a saved expert stays expert", levelFromStored("expert"), "expert");
eq("a saved advanced stays advanced", levelFromStored("advanced"), "advanced");
eq("a saved simple stays simple", levelFromStored("simple"), "simple");
eq("nothing saved is a first run", isFirstRun(null), true);
eq("a saved level is not a first run", [isFirstRun("simple"), isFirstRun("advanced"), isFirstRun("expert")], [false, false, false]);
eq("a first run with no mesh opens Prepare", startStage(null, false), "prepare");
eq("a first run with a mesh keeps Preview", startStage(null, true), "preview");
eq("a returning launch keeps Preview, even with an expert level", [startStage("expert", false), startStage("simple", false)], ["preview", "preview"]);

// Recent palette commands -------------------------------------------------------------------------------------

function fakeStore(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[RECENT_KEY, initial]]);
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
}

eq("a fresh install has none", loadRecent(fakeStore()), []);
eq("no storage has none", loadRecent(null), []);
eq("garbage has none", loadRecent(fakeStore("{nope")), []);
eq("a non-list has none", loadRecent(fakeStore('{"a":1}')), []);

const store = fakeStore();
for (const id of ["a", "b", "c", "d", "e", "f"]) pushRecent(id, store);
eq("the last five, newest first", loadRecent(store), ["f", "e", "d", "c", "b"]);
pushRecent("c", store);
eq("a repeat moves to the front once", loadRecent(store), ["c", "f", "e", "d", "b"]);

const blocked = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};
eq("blocked storage reads none", loadRecent(blocked), []);
eq("blocked storage still returns the new list", pushRecent("x", blocked), ["x"]);

const items = [{ id: "palette" }, { id: "slice" }, { id: "export" }, { id: "undo" }];
const shown = withRecents(items, ["undo", "gone", "palette", "slice"], new Set(["palette"]));
eq("recents lead, the palette row and unknown ids never do", shown.top.map((item) => item.id), ["undo", "slice"]);
eq("the rest keep registry order", shown.rest.map((item) => item.id), ["palette", "export"]);
eq("none recent leaves everything in order", withRecents(items, []).rest.map((item) => item.id), ["palette", "slice", "export", "undo"]);

if (failed) throw new Error(`${failed} failed`);
console.log("first-run: level, stage and recent commands ok");
