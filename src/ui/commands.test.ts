import { COMMANDS, fuzzyScore, helpEntries, rankCommands } from "./commands.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

eq("empty query keeps registry order", rankCommands(COMMANDS, "").map((command) => command.id), COMMANDS.map((command) => command.id));
eq("blank query keeps registry order", rankCommands(COMMANDS, "  ").map((command) => command.id), COMMANDS.map((command) => command.id));

const sliceFirst = rankCommands(COMMANDS, "slice").map((command) => command.id);
check("slice query ranks Slice first", sliceFirst[0] === "slice", sliceFirst.join(","));
check("slice query finds force re-slice", sliceFirst.includes("force-slice"));

const preview = rankCommands(COMMANDS, "prev").map((command) => command.label);
check("prev matches Preview", preview.includes("Preview"), preview.join(","));
eq("nonsense matches nothing", rankCommands(COMMANDS, "xyzqq").length, 0);
eq("case insensitive top", rankCommands(COMMANDS, "TOP")[0]?.id, "view-top");
check("sl prefers Slice over Samples", rankCommands(COMMANDS, "sl")[0]?.id === "slice");

eq("fuzzy miss", fuzzyScore("xyz", "Slice"), null);
check("fuzzy hit is positive", (fuzzyScore("sl", "Slice") ?? 0) > 0);
check("boundary bonus beats a buried match", (fuzzyScore("s", "Slice") ?? 0) > (fuzzyScore("s", "preset") ?? 0));

const ids = COMMANDS.map((command) => command.id);
eq("unique ids", new Set(ids).size, ids.length);
const shortcuts = COMMANDS.map((command) => command.shortcut).filter((shortcut): shortcut is string => !!shortcut);
eq("unique shortcuts", new Set(shortcuts).size, shortcuts.length);

const help = helpEntries();
eq("help shortcuts come from the registry", help.map((entry) => entry.shortcut), shortcuts);
check("help labels match the palette", help.every((entry) => COMMANDS.some((command) => command.shortcut === entry.shortcut && command.label === entry.label)));
check("palette shortcut is listed once", help.filter((entry) => entry.shortcut === "Ctrl+K").length === 1);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("commands: registry and fuzzy ok");
