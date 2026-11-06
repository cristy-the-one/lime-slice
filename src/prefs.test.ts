import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPrefs, PREF_FAMILIES, PREF_REGISTRY, prefsOver, type PrefStorage } from "./prefs.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function memory(initial: Record<string, string> = {}): PrefStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const boom = () => {
  throw new Error("blocked");
};
const blocked: PrefStorage = { getItem: boom, setItem: boom, removeItem: boom };
const quota: PrefStorage = { getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: boom };

// Basic typed access ----------------------------------------------------------------------------------------
{
  const store = memory();
  const p = createPrefs(() => store);
  eq("unset string is null", p.get("lime-slice-theme"), null);
  eq("set returns true", p.set("lime-slice-theme", "dark"), true);
  eq("string round-trips", p.get("lime-slice-theme"), "dark");
  eq("bool default true when unset", p.getBool("lime-slice-auto-slice"), true);
  eq("bool default false when unset", p.getBool("lime-slice-settle"), false);
  p.setBool("lime-slice-auto-slice", false);
  eq("bool is stored as 0", store.data.get("lime-slice-auto-slice"), "0");
  p.setBool("lime-slice-settle", true);
  eq("bool is stored as 1", store.data.get("lime-slice-settle"), "1");
  eq("bool reads back", [p.getBool("lime-slice-auto-slice"), p.getBool("lime-slice-settle")], [false, true]);
  p.setNumber("lime-slice-how-split-print", 3);
  eq("number round-trips through the family", p.getNumber("lime-slice-how-split-print"), 3);
  eq("number fallback", createPrefs(() => memory()).getNumber("lime-slice-how-x", 1), 1);
  eq("number default", createPrefs(() => memory()).getNumber("lime-slice-how-x"), 0);
  p.setJson("lime-slice-recent-commands", ["a", "b"]);
  eq("json is stored as plain JSON text", store.data.get("lime-slice-recent-commands"), '["a","b"]');
  eq("json reads back", p.getJson("lime-slice-recent-commands"), ["a", "b"]);
  eq("json default is a fresh list", createPrefs(() => memory()).getJson("lime-slice-recent-commands"), []);
  eq("remove drops the key", [p.remove("lime-slice-theme"), p.get("lime-slice-theme")], [true, null]);
}

// Old-format values load unchanged --------------------------------------------------------------------------
{
  const p = createPrefs(() => memory({
    "lime-slice-auto-slice": "0",
    "lime-slice-measure": "garbage",
    "lime-slice-settle": "garbage",
    "lime-slice-how-split-print": "4",
    "lime-slice-how-bad": "abc",
    "lime-slice-plugins-used": '{"a":12}',
    "lime-slice-dock-panes": '{"layers":240}',
    "lime-slice-machines": '{"v":1}',
    "lime-slice-closed-groups": "not json",
    "lime-slice.profile.v1": '{"name":"Mine"}',
    "lime-slice-model-params-folded:/p.lime": "1",
  }));
  eq("0 means off", p.getBool("lime-slice-auto-slice"), false);
  eq("garbage keeps an on-by-default switch on", p.getBool("lime-slice-measure"), true);
  eq("garbage keeps an off-by-default switch off", p.getBool("lime-slice-settle"), false);
  eq("a saved count", p.getNumber("lime-slice-how-split-print"), 4);
  eq("an unreadable count answers the fallback", p.getNumber("lime-slice-how-bad", 1), 1);
  eq("a saved object", p.getJson("lime-slice-plugins-used"), { a: 12 });
  eq("saved pane sizes", p.getJson("lime-slice-dock-panes"), { layers: 240 });
  eq("library text stays raw", p.get("lime-slice-machines"), '{"v":1}');
  eq("unreadable JSON answers the default", p.getJson("lime-slice-closed-groups"), null);
  eq("the profile text stays raw", p.get("lime-slice.profile.v1"), '{"name":"Mine"}');
  eq("a project fold", p.getBool("lime-slice-model-params-folded:/p.lime"), true);
}

// A broken storage never throws -----------------------------------------------------------------------------
for (const [label, make] of [
  ["throwing", () => createPrefs(() => blocked)],
  ["getter throws", () => createPrefs(boom)],
  ["missing", () => createPrefs(() => null)],
  ["undefined", () => createPrefs(() => undefined)],
  ["quota exceeded", () => createPrefs(() => quota)],
  ["prefsOver null", () => prefsOver(null)],
] as const) {
  const p = make();
  try {
    eq(`${label}: get`, p.get("lime-slice-theme"), null);
    eq(`${label}: bool default`, [p.getBool("lime-slice-auto-slice"), p.getBool("lime-slice-settle")], [true, false]);
    eq(`${label}: number`, p.getNumber("lime-slice-how-x", 7), 7);
    eq(`${label}: json default`, p.getJson("lime-slice-plugins-used"), {});
    eq(`${label}: writes report false`, [p.set("lime-slice-theme", "dark"), p.setBool("lime-slice-settle", true), p.setNumber("lime-slice-how-x", 1), p.setJson("lime-slice-recent-commands", [])], [false, false, false, false]);
    eq(`${label}: remove`, p.remove("lime-slice-theme"), false);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${label}: threw ${String(error)}`);
  }
}
eq("unserialisable json does not throw", createPrefs(() => memory()).setJson("lime-slice-recent-commands", 1n), false);

// The app's modules over old-format saved values --------------------------------------------------------------
{
  const store = memory({
    "lime-slice-theme": "dark",
    "lime-slice-settings-level": "expert",
    "lime-slice-recent-commands": '["slice","undo","slice"]',
    "lime-slice-auto-slice": "0",
    "lime-slice.profile.v1": '{"name":"Old","bedX":180}',
    "lime-slice-machines": "LIB",
    "lime-slice-settings-profiles": "PROFILES",
  });
  (globalThis as { localStorage?: unknown }).localStorage = store;
  const { loadTheme } = await import("./theme.ts");
  const { loadProfile } = await import("./profiles.ts");
  const { loadAutoSlice, saveAutoSlice } = await import("./auto-slice-pref.ts");
  const { loadRecent, pushRecent } = await import("./ui/palette-recent.ts");
  const { localMachineStore } = await import("./ui/machine-library-store.ts");
  const { localSettingsProfileStore } = await import("./ui/settings-profile-store.ts");
  eq("theme", loadTheme(), "dark");
  const profile = loadProfile();
  eq("profile merges onto defaults", [profile.name, profile.bedX, profile.bedY], ["Old", 180, 220]);
  eq("auto-slice off", loadAutoSlice(), false);
  saveAutoSlice(true);
  eq("auto-slice writes 1", store.data.get("lime-slice-auto-slice"), "1");
  eq("recents", loadRecent(), ["slice", "undo"]);
  pushRecent("export");
  eq("recents write the same JSON", store.data.get("lime-slice-recent-commands"), '["export","slice","undo"]');
  eq("machine library text", localMachineStore().read(), "LIB");
  localMachineStore().write("LIB2");
  eq("machine library write", store.data.get("lime-slice-machines"), "LIB2");
  eq("settings profiles text", localSettingsProfileStore().read(), "PROFILES");
  (globalThis as { localStorage?: unknown }).localStorage = blocked;
  eq("a blocked storage gives the default theme", loadTheme(), "system");
  eq("a blocked storage gives the default profile", loadProfile().name, "Generic Marlin 0.4 mm PLA");
  eq("a blocked machine store reads nothing", localMachineStore().read(), null);
  localMachineStore().write("x");
  delete (globalThis as { localStorage?: unknown }).localStorage;
  eq("no storage gives the default theme", loadTheme(), "system");
}

// Registry shape --------------------------------------------------------------------------------------------
for (const [key, def] of [...Object.entries(PREF_REGISTRY), ...Object.entries(PREF_FAMILIES)] as [string, { type: string; default: unknown; purpose: string }][]) {
  if (!def.purpose.trim() || !["string", "bool", "number", "json"].includes(def.type)) {
    failed += 1;
    console.error(`FAIL registry entry ${key} needs a type and a purpose`);
  }
  if (def.type === "bool" && typeof def.default !== "boolean") {
    failed += 1;
    console.error(`FAIL registry bool ${key} needs a boolean default`);
  }
}

// Source scan -----------------------------------------------------------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
/** Files allowed to touch the storage objects directly, with the reason. Nothing else. */
const DIRECT_STORAGE_ALLOWED: Record<string, string> = {
  "src/prefs.ts": "the module itself",
};
const registered = (key: string) => key in PREF_REGISTRY || Object.keys(PREF_FAMILIES).some((prefix) => key.startsWith(prefix));

for (const file of walk("src")) {
  const rel = file.replace(/\\/g, "/");
  if (rel === "src/prefs.ts") continue;
  const code = withoutComments(readFileSync(file, "utf8"));
  if (/\b(localStorage|sessionStorage)\b/.test(code) && !(rel in DIRECT_STORAGE_ALLOWED)) {
    failed += 1;
    console.error(`FAIL ${rel} uses localStorage/sessionStorage directly; go through src/prefs.ts`);
  }
  for (const match of code.matchAll(/["'`](lime-slice[-.:\w]*|lime\.stress\.\w+)(?=["'`$])/g)) {
    const key = match[1]!;
    if (!registered(key)) {
      failed += 1;
      console.error(`FAIL ${rel} names the preference key "${key}" that is not in PREF_REGISTRY`);
    }
  }
  for (const match of code.matchAll(/\bprefs\.(?:get|set|remove|getBool|setBool|getNumber|setNumber|getJson|setJson)\(\s*["'`]([^"'`$]+)/g)) {
    if (!registered(match[1]!)) {
      failed += 1;
      console.error(`FAIL ${rel} calls prefs with the unregistered key "${match[1]}"`);
    }
  }
}

if (failed) throw new Error(`${failed} failed`);
console.log("prefs: typed access, broken storage, old formats, registry and source scan ok");
