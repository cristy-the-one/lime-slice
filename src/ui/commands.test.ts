import { COMMANDS, fires, fuzzyScore, helpGroups, paletteCommands, rankCommands, resolveKey, shortcutOf, type KeyContext, type KeyEventLike } from "./commands.ts";

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

// Key events -------------------------------------------------------------------------------------------------

const BASE: KeyContext = {
  helpOpen: false,
  typing: false,
  stage: "prepare",
  hasResult: false,
  running: false,
  searching: false,
  brushOn: false,
  editingSupports: false,
  inGcode: false,
};

const NAMED: Record<string, string> = { Esc: "Escape", "↑": "ArrowUp", "↓": "ArrowDown", PgUp: "PageUp", PgDn: "PageDown", Del: "Delete" };

/** The event a browser reports for `chord`, as a US keyboard sends it. */
function eventFor(chord: string, repeat = false): KeyEventLike {
  const parts = chord.split("+");
  const name = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  const key = NAMED[name] ?? name;
  const shifted = mods.includes("Shift");
  const code = /^[0-9]$/.test(key) ? `Digit${key}` : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  const shownKey = shifted && /^[0-9]$/.test(key) ? ")!@#$%"[Number(key)]! : /^[a-z]$/i.test(key) && shifted ? key.toUpperCase() : /^[a-z]$/i.test(key) ? key.toLowerCase() : key;
  return { key: shownKey, code, ctrlKey: mods.includes("Ctrl"), metaKey: false, shiftKey: shifted, altKey: mods.includes("Alt"), repeat };
}

function press(chord: string, ctx: Partial<KeyContext> = {}, repeat = false): string | null {
  return resolveKey(eventFor(chord, repeat), { ...BASE, ...ctx })?.id ?? null;
}

// Every chord fires at most one command in any context.
const bools = [false, true];
const contexts: KeyContext[] = [];
for (const helpOpen of bools) for (const typing of bools) for (const hasResult of bools) for (const running of bools)
  for (const searching of bools) for (const brushOn of bools) for (const editingSupports of bools) for (const inGcode of bools)
    for (const stage of ["prepare", "preview", "gcode"] as const)
      contexts.push({ helpOpen, typing, stage, hasResult, running, searching, brushOn, editingSupports, inGcode });
const chords = [...new Set(COMMANDS.flatMap((command) => command.keys ?? []))];
for (const chord of chords) {
  for (const repeat of bools) {
    const ev = eventFor(chord, repeat);
    for (const ctx of contexts) {
      const hits = COMMANDS.filter((command) => fires(command, ev, ctx)).map((command) => command.id);
      if (hits.length > 1) {
        check(`${chord} fires one command`, false, `${hits.join(",")} in ${JSON.stringify(ctx)}`);
        break;
      }
    }
  }
}

const ctrlK = COMMANDS.filter((command) => command.keys?.includes("Ctrl+K"));
eq("exactly one Ctrl+K", ctrlK.map((command) => command.id), ["palette"]);

// Bindings ---------------------------------------------------------------------------------------------------

eq("1 is Prepare", press("1"), "tab-prepare");
eq("2 is Preview", press("2"), "tab-preview");
eq("3 is G-code", press("3"), "tab-gcode");
eq("V cycles the preview mode only in preview", [press("V"), press("V", { stage: "preview", hasResult: true })], [null, "view-cycle"]);
eq("Shift+1..5 pick strategies", ["Shift+1", "Shift+2", "Shift+3", "Shift+4", "Shift+5"].map((chord) => press(chord)), ["strategy-speed", "strategy-efficiency", "strategy-toughness", "strategy-layer", "strategy-region"]);
eq("A arranges in Prepare only", [press("A"), press("A", { stage: "preview" })], ["plate-arrange", null]);
eq("Ctrl+D duplicates in Prepare", press("Ctrl+D"), "plate-duplicate");
eq("Delete and Backspace remove an object", [press("Del"), press("Backspace")], ["plate-remove", "plate-remove"]);
eq("Delete leaves the object while a tool is on", [press("Del", { brushOn: true }), press("Del", { editingSupports: true })], [null, null]);
eq("Delete does not remove in Preview", press("Del", { stage: "preview", hasResult: true }), null);
eq("Esc cancels a running slice", press("Esc", { running: true }), "cancel-slice");
eq("Esc does nothing when idle", press("Esc"), null);
eq("Esc clears a search before it cancels", press("Esc", { running: true, searching: true }), "search-clear");
eq("Esc closes the sheet", press("Esc", { helpOpen: true, running: true }), "help-close");
eq("? opens, then closes, the sheet", [press("?"), press("?", { helpOpen: true })], ["help", "help-close"]);
eq("nothing else fires under the sheet", [press("1", { helpOpen: true }), press("Ctrl+S", { helpOpen: true }), press("M", { helpOpen: true })], [null, null, null]);
eq("Ctrl+Enter slices", press("Ctrl+Enter"), "slice");
eq("Ctrl+Enter slices from a field", press("Ctrl+Enter", { typing: true }), "slice");
eq("Ctrl+Shift+Enter forces a re-slice", [press("Ctrl+Shift+Enter"), press("Ctrl+Shift+Enter", { typing: true })], ["force-slice", "force-slice"]);
eq("Ctrl+B and Ctrl+Alt+B fold the panels", [press("Ctrl+B"), press("Ctrl+Alt+B")], ["panel-left", "panel-right"]);
eq("Ctrl+K opens the palette, even from a field", [press("Ctrl+K"), press("Ctrl+K", { typing: true })], ["palette", "palette"]);
eq("undo and redo work in a field", [press("Ctrl+Z", { typing: true }), press("Ctrl+Shift+Z", { typing: true })], ["undo", "redo"]);
eq("Ctrl+O and Ctrl+S work in a field", [press("Ctrl+O", { typing: true }), press("Ctrl+S", { typing: true })], ["open", "save-project"]);
eq("/ and Ctrl+F search, but not from a field", [press("/"), press("Ctrl+F"), press("/", { typing: true }), press("Ctrl+F", { typing: true })], ["search", "search", null, null]);
eq("Ctrl+F stays the browser's in the G-code pane", press("Ctrl+F", { stage: "gcode", inGcode: true }), null);
eq("a letter does nothing in a field", ["M", "R", "S", "F", "C", "E", "B", "K", "T", "Y", "I", "A", "V", "1"].map((chord) => press(chord, { typing: true })), Array(14).fill(null));
eq("tools", ["M", "R", "S", "F", "C", "E", "B", "K"].map((chord) => press(chord)), ["tool-move", "tool-rotate", "tool-scale", "tool-layflat", "tool-section", "edit-supports", "paint-supports", "paint-seam"]);
eq("camera presets", ["T", "Y", "I"].map((chord) => press(chord)), ["view-top", "view-front", "view-iso"]);
eq("Ctrl+E exports", press("Ctrl+E"), "export");
eq("a bare letter ignores Ctrl", press("Ctrl+M"), null);

const inPreview = { stage: "preview", hasResult: true } as const;
eq("layer keys", ["↑", "]", "↓", "[", "PgUp", "PgDn", "Home", "End"].map((chord) => press(chord, inPreview)), ["layer-up", "layer-up", "layer-down", "layer-down", "layer-up-10", "layer-down-10", "layer-first", "layer-last"]);
eq("layer keys need a result", press("↑", { stage: "preview", hasResult: false }), null);
eq("layer keys stay out of Prepare", press("↑"), null);
eq("[ and ] size the brush while it is on", [press("[", { brushOn: true }), press("]", { brushOn: true }), press("[")], ["brush-smaller", "brush-larger", null]);
eq("only layer and brush keys repeat", COMMANDS.filter((command) => command.repeat).map((command) => command.id), ["layer-up", "layer-down", "layer-up-10", "layer-down-10", "brush-smaller", "brush-larger"]);
eq("a held M does not repeat", press("M", {}, true), null);
eq("a held ↑ repeats", press("↑", inPreview, true), "layer-up");

// Help and palette -------------------------------------------------------------------------------------------

const keyed = COMMANDS.filter((command) => command.keys && command.show !== "none");
const listed = helpGroups().flatMap((group) => group.entries);
eq("the sheet lists every keyed command once", listed.map((entry) => entry.label), keyed.map((command) => command.label));
eq("the sheet shows all of a command's chords", listed.find((entry) => entry.label === "Remove object")?.keys, ["Del", "Backspace"]);
eq("the sheet spells the keys the old prose left out", ["Search settings", "Smaller brush", "Paint seam", "Layer up", "Toggle results panel"].map((label) => listed.find((entry) => entry.label === label)?.keys), [["/", "Ctrl+F"], ["["], ["K"], ["↑", "]"], ["Ctrl+Alt+B"]]);
eq("groups appear once each", helpGroups().map((group) => group.group), [...new Set(helpGroups().map((group) => group.group))]);
check("the palette hides sheet-only commands", paletteCommands().every((command) => command.show !== "help" && command.show !== "none"));
check("the palette lists the shortcut of a keyed command", shortcutOf(COMMANDS.find((command) => command.id === "slice")!) === "Ctrl+Enter");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("commands: registry, key map and fuzzy ok");
