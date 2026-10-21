import { COMMANDS, fires, fuzzyScore, helpGroups, paletteCommands, rankCommands, resolveKey, shortcutOf, tipWithShortcut, type KeyContext, type KeyEventLike } from "./commands.ts";

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
eq("case insensitive top", rankCommands(COMMANDS, "TOP")[0]?.label, "Top view");
const slRank = rankCommands(COMMANDS, "sl").map((command) => command.id);
check("sl prefers Slice over Samples", slRank.indexOf("slice") < slRank.indexOf("samples"), slRank.slice(0, 6).join(","));

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
  sketchOpen: false,
  sketchFeature: false,
  sketchLoft: false,
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
    for (const stage of ["prepare", "preview", "gcode", "model"] as const)
      contexts.push({ helpOpen, typing, stage, hasResult, running, searching, brushOn, editingSupports, inGcode, sketchOpen: false, sketchFeature: false, sketchLoft: false });
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
eq("4 is Model", press("4"), "tab-model");
eq("V cycles the preview mode only in preview", [press("V"), press("V", { stage: "preview", hasResult: true })], [null, "view-cycle"]);
eq("Shift+1..5 pick strategies", ["Shift+1", "Shift+2", "Shift+3", "Shift+4", "Shift+5"].map((chord) => press(chord)), ["strategy-speed", "strategy-efficiency", "strategy-toughness", "strategy-layer", "strategy-region"]);
eq("A arranges in Prepare only", [press("A"), press("A", { stage: "preview" })], ["plate-arrange", null]);
eq("Ctrl+D duplicates in Prepare", press("Ctrl+D"), "plate-duplicate");
eq("Delete and Backspace remove an object", [press("Del"), press("Backspace")], ["plate-remove", "plate-remove"]);
eq("Delete leaves the object while a tool is on", [press("Del", { brushOn: true }), press("Del", { editingSupports: true })], [null, null]);
eq("Delete does not remove in Preview", press("Del", { stage: "preview", hasResult: true }), null);
eq("Esc cancels a running slice", press("Esc", { running: true }), "cancel-slice");
eq("Esc does nothing when idle", press("Esc"), null);
eq("Esc clears a Model selection", press("Esc", { stage: "model" }), "model-escape");
eq("Esc still cancels a running slice on Model", press("Esc", { stage: "model", running: true }), "cancel-slice");
eq("Q and W pick in Model", [press("Q"), press("Q", { stage: "model" }), press("W", { stage: "model" })], [null, "model-face", "model-edge"]);
eq("Shift+E edits a Model step, E edits supports in Preview", [press("Shift+E"), press("Shift+E", { stage: "model" }), press("E"), press("E", { stage: "preview", hasResult: true })], [null, "model-edit-step", null, "edit-supports"]);
eq("Shift+H is Model history, H stays Hole", [press("Shift+H"), press("Shift+H", { stage: "model" }), press("H", { stage: "model" })], [null, "model-history", "model-hole"]);
eq("Shift+U is the workplane, and only in Model", [press("Shift+U"), press("Shift+U", { stage: "model" }), press("U", { stage: "model" })], [null, "model-workplane", null]);
eq("Shift+K checks the solid, and K stays Paint seam", [press("Shift+K"), press("Shift+K", { stage: "model" }), press("K")], [null, "model-check", "paint-seam"]);
eq("Enter applies a model edit, not from Prepare", [press("Enter"), press("Enter", { stage: "model" })], [null, "model-apply"]);
eq("a model letter does nothing in a field", press("Q", { stage: "model", typing: true }), null);
eq("Esc clears a search before it cancels", press("Esc", { running: true, searching: true }), "search-clear");
eq("Esc closes the sheet", press("Esc", { helpOpen: true, running: true }), "help-close");
eq("? opens, then closes, the sheet", [press("?"), press("?", { helpOpen: true })], ["help", "help-close"]);
eq("nothing else fires under the sheet", [press("1", { helpOpen: true }), press("Ctrl+S", { helpOpen: true }), press("M", { helpOpen: true })], [null, null, null]);
eq("Ctrl+Enter slices", press("Ctrl+Enter"), "slice");
eq("Ctrl+Enter slices from a field", press("Ctrl+Enter", { typing: true }), "slice");
eq("Ctrl+Shift+Enter forces a re-slice", [press("Ctrl+Shift+Enter"), press("Ctrl+Shift+Enter", { typing: true })], ["force-slice", "force-slice"]);
eq("Ctrl+B and Ctrl+Alt+B fold the panels", [press("Ctrl+B"), press("Ctrl+Alt+B")], ["panel-left", "panel-right"]);
eq("Ctrl+. shows hidden controls", press("Ctrl+."), "restore-hidden");
eq("Ctrl+K opens the palette, even from a field", [press("Ctrl+K"), press("Ctrl+K", { typing: true })], ["palette", "palette"]);
eq("undo and redo work in a field", [press("Ctrl+Z", { typing: true }), press("Ctrl+Shift+Z", { typing: true })], ["undo", "redo"]);
eq("Ctrl+Y redoes and Y is still the front view", [press("Ctrl+Y"), press("Y"), press("Ctrl+Y", { typing: true })], ["redo", "view-front", "redo"]);
eq("Ctrl+O and Ctrl+S work in a field", [press("Ctrl+O", { typing: true }), press("Ctrl+S", { typing: true })], ["open", "save-project"]);
eq(
  "Ctrl+N is New project after a slice, in Model, and from a field",
  [
    press("Ctrl+N"),
    press("Ctrl+N", { typing: true }),
    press("Ctrl+N", { stage: "model" }),
    press("Ctrl+N", { stage: "preview", hasResult: true }),
    press("Ctrl+N", { running: true }),
  ],
  ["new-project", "new-project", "new-project", "new-project", "new-project"],
);
eq("/ and Ctrl+F search, but not from a field", [press("/"), press("Ctrl+F"), press("/", { typing: true }), press("Ctrl+F", { typing: true })], ["search", "search", null, null]);
eq("Ctrl+F stays the browser's in the G-code pane", press("Ctrl+F", { stage: "gcode", inGcode: true }), null);
eq("a letter does nothing in a field", ["M", "R", "S", "F", "C", "E", "B", "K", "T", "Y", "I", "A", "V", "1"].map((chord) => press(chord, { typing: true })), Array(14).fill(null));
eq("Prepare tools", ["M", "R", "S", "F", "C", "B", "K", "N"].map((chord) => press(chord)), ["tool-move", "tool-rotate", "tool-scale", "tool-layflat", "tool-section", "paint-supports", "paint-seam", "paint-reinforce"]);
eq("S in Model starts a sketch", press("S", { stage: "model" }), "model-sketch");
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
for (const command of COMMANDS) {
  if (command.keys?.length) continue;
  const tip = tipWithShortcut(command.label, undefined);
  check(`${command.id} tip has no empty shortcut`, tip === command.label && !tip.includes("()") && !/[·•|–—-]\s*$/.test(tip), tip);
}
eq("a keyed tip names the shortcut once", tipWithShortcut("Fillet", "L"), "Fillet (L)");
eq("an empty slot is dropped", tipWithShortcut("Add ()", undefined), "Add");
eq("a real shortcut is kept", tipWithShortcut("Arrange (A)", "A"), "Arrange (A)");

// R3-01. A Prepare key is null wherever its button is not on screen, and the same command where it is.
const STAGE_KEYS: Record<string, Partial<Record<"prepare" | "preview" | "gcode" | "model", string>>> = {
  M: { prepare: "tool-move" },
  R: { prepare: "tool-rotate" },
  F: { prepare: "tool-layflat" },
  B: { prepare: "paint-supports" },
  K: { prepare: "paint-seam" },
  N: { prepare: "paint-reinforce" },
  E: { preview: "edit-supports", gcode: "edit-supports" },
  C: { prepare: "tool-section", preview: "tool-section", gcode: "tool-section" },
  T: { prepare: "view-top", model: "model-view-top" },
  Y: { prepare: "view-front", model: "model-view-front" },
  I: { prepare: "view-iso", model: "model-view-iso" },
  "/": { prepare: "search", preview: "search", gcode: "search" },
  "Ctrl+F": { prepare: "search", preview: "search", gcode: "search" },
  "Shift+1": { prepare: "strategy-speed", preview: "strategy-speed" },
  "Shift+M": { prepare: "measure", preview: "measure", gcode: "measure", model: "model-measure" },
};
for (const [chord, where] of Object.entries(STAGE_KEYS)) {
  for (const stage of ["prepare", "preview", "gcode", "model"] as const) {
    eq(`${chord} in ${stage}`, press(chord, { stage, hasResult: stage === "preview" }), where[stage] ?? null);
  }
}

// R3-05. Every chord, in every combination of stage and mode, fires at most one command,
// and a targeted command fires only where that target is on screen.
const TARGET_STAGES: Record<string, readonly ("prepare" | "preview" | "gcode" | "model")[]> = {
  "#leftToggle": ["prepare", "preview", "gcode", "model"],
  "#timing": ["prepare", "preview", "gcode", "model"],
  "#contextBarRestore": ["model"],
  "#compactChromeShow": ["prepare", "preview", "gcode", "model"],
  "#slice": ["prepare", "preview", "gcode", "model"],
  "#force": ["prepare", "preview", "gcode", "model"],
  "#cancel": ["prepare", "preview", "gcode", "model"],
  "#export": ["prepare", "preview", "gcode", "model"],
  "#tabPrepare": ["prepare", "preview", "gcode", "model"],
  "#tabPreview": ["prepare", "preview", "gcode", "model"],
  "#tabGcode": ["prepare", "preview", "gcode", "model"],
  "#tabModel": ["prepare", "preview", "gcode", "model"],
  '[data-mode="flat"]': ["preview"],
  '[data-mode="split"]': ["preview"],
  '[data-mode="solid"]': ["preview"],
  "#viewPresets button:nth-child(1)": ["prepare"],
  "#viewPresets button:nth-child(2)": ["prepare"],
  "#viewPresets button:nth-child(3)": ["prepare"],
  "#measureField": ["prepare", "preview", "gcode"],
  "#modelToolMeasure": ["model"],
  "#modelToolNew": ["model"],
  "#modelPickFace": ["model"],
  "#modelPickEdge": ["model"],
  "#modelToolBoolean": ["model"],
  "#modelToolSplit": ["model"],
  "#modelToolPull": ["model"],
  "#modelToolSketch": ["model"],
  "#modelToolFillet": ["model"],
  "#modelToolChamfer": ["model"],
  "#modelToolHole": ["model"],
  "#modelToolFeatures": ["model"],
  "#modelToolPattern": ["model"],
  "#modelToolMirror": ["model"],
  "#modelToolShell": ["model"],
  "#modelToolScale": ["model"],
  "#modelToolPlace": ["model"],
  "#modelToolWorkplane": ["model"],
  "#modelToolCheck": ["model"],
  "#modelResetView": ["model"],
  "#modelHistoryOpen": ["model"],
  "#modelApply": ["model"],
  '[data-card="speed"]': ["prepare", "preview"],
  '[data-card="efficiency"]': ["prepare", "preview"],
  '[data-card="toughness"]': ["prepare", "preview"],
  '[data-card="layer"]': ["prepare", "preview"],
  '[data-card="region"]': ["prepare", "preview"],
  "#plateArrange": ["prepare"],
  "#plateDuplicate": ["prepare"],
  '#toolRail [data-tool="move"]': ["prepare"],
  '#toolRail [data-tool="rotate"]': ["prepare"],
  '#toolRail [data-tool="scale"]': ["prepare"],
  "#layflat": ["prepare"],
  '#toolRail [data-tool="layflat"]': ["prepare"],
  '#toolRail [data-tool="section"]': ["prepare", "preview", "gcode"],
  '#toolRail [data-tool="supports"]': ["preview", "gcode"],
  '#toolRail [data-tool="paint"]': ["prepare"],
  '#toolRail [data-tool="seam"]': ["prepare"],
  '#toolRail [data-tool="reinforce"]': ["prepare"],
  // Undo and Redo run in every stage. The Model buttons are the tooltip targets, and the handler clicks them only in Model.
  "#modelUndo": ["prepare", "preview", "gcode", "model"],
  "#modelRedo": ["prepare", "preview", "gcode", "model"],
  '[data-sketch-tool="line"]': ["model"],
  '[data-sketch-tool="rectangle"]': ["model"],
  '[data-sketch-tool="circle"]': ["model"],
  '[data-sketch-tool="arc"]': ["model"],
  '[data-sketch-tool="polygon"]': ["model"],
  '[data-sketch-tool="slot"]': ["model"],
  '[data-sketch-tool="spline"]': ["model"],
  '[data-sketch-tool="trim"]': ["model"],
  '[data-sketch-tool="offset"]': ["model"],
  '[data-sketch-tool="fillet"]': ["model"],
  '[data-sketch-tool="use"]': ["model"],
  '[data-sketch-tool="construction"]': ["model"],
  "[data-sketch-look]": ["model"],
  "[data-sketch-extrude]": ["model"],
  "[data-sketch-revolve]": ["model"],
  "[data-sketch-loft]": ["model"],
  "[data-sketch-sweep]": ["model"],
  "[data-sketch-holes]": ["model"],
  "[data-sketch-ruled]": ["model"],
};
for (const command of COMMANDS) {
  if (!command.target) continue;
  for (const selector of command.target.split(",").map((part) => part.trim())) {
    check(`target ${selector} is in the stage map`, selector in TARGET_STAGES, command.id);
  }
}
const honestChords = [...new Set(COMMANDS.flatMap((command) => command.keys ?? []))];
for (const stage of ["prepare", "preview", "gcode", "model"] as const) {
  for (const sketchOpen of bools) for (const sketchFeature of bools) for (const sketchLoft of bools) for (const brushOn of bools)
    for (const helpOpen of bools) for (const running of bools) for (const typing of bools) {
      const ctx: KeyContext = {
        ...BASE,
        stage,
        hasResult: stage === "preview",
        sketchOpen,
        sketchFeature,
        sketchLoft,
        brushOn,
        helpOpen,
        running,
        typing,
      };
      for (const chord of honestChords) {
        const hits = COMMANDS.filter((command) => fires(command, eventFor(chord), ctx));
        if (hits.length > 1) check(`${chord} fires one command`, false, hits.map((command) => command.id).join(",") + ` in ${stage}`);
        const hit = hits[0];
        if (!hit?.target) continue;
        const allowed = new Set(hit.target.split(",").flatMap((part) => TARGET_STAGES[part.trim()] ?? []));
        check(`${hit.id} stays on screen in ${stage}`, allowed.has(stage), chord);
      }
    }
}

const sketchCtx = { stage: "model" as const, sketchOpen: true };
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  for (const sketchFeature of bools) for (const sketchLoft of bools) {
    const id = press(letter, { ...sketchCtx, sketchFeature, sketchLoft });
    const group = COMMANDS.find((command) => command.id === id)?.group;
    check(`${letter} in a sketch is a sketch command or nothing`, group === undefined || group === "Sketch", id ?? "null");
  }
}
eq("W in a sketch sweeps", press("W", sketchCtx), "sketch-sweep");
eq("Shift+L in a sketch lofts", press("Shift+L", sketchCtx), "sketch-loft");
eq("T in a sketch trims", press("T", sketchCtx), "sketch-trim");
eq("L in a sketch is the line", press("L", sketchCtx), "sketch-line");
eq("R in a sketch is the rectangle", press("R", sketchCtx), "sketch-rect");
eq("R in a loft is smooth", press("R", { ...sketchCtx, sketchFeature: true, sketchLoft: true }), "sketch-smooth");
eq("M cycles the feature", press("M", { ...sketchCtx, sketchFeature: true }), "sketch-mode");
eq("M does nothing with no feature", press("M", sketchCtx), null);
eq("Ctrl+Z undoes the sketch", press("Ctrl+Z", sketchCtx), "sketch-undo");
eq("Ctrl+Z in a sketch field stays in the field", press("Ctrl+Z", { ...sketchCtx, typing: true }), null);
eq("Esc cancels the sketch", press("Esc", sketchCtx), "sketch-escape");
eq("Esc still cancels a running slice while sketching", press("Esc", { ...sketchCtx, running: true }), "cancel-slice");
eq("2 types a size while sketching", press("2", sketchCtx), "sketch-size");
eq("2 in a sketch field stays text", press("2", { ...sketchCtx, typing: true }), null);
eq("2 still opens Preview outside a sketch", press("2"), "tab-preview");
eq("a sketch digit does not switch stage", press("1", sketchCtx), "sketch-size");
eq("Shift+M measures in Model", press("Shift+M", { stage: "model" }), "model-measure");
eq("T, Y and I move the Model camera", ["T", "Y", "I"].map((chord) => press(chord, { stage: "model" })), ["model-view-top", "model-view-front", "model-view-iso"]);
eq("T in a sketch still trims", press("T", sketchCtx), "sketch-trim");
eq("Model scale is labelled Scale solid", COMMANDS.find((command) => command.id === "model-scale")?.label, "Scale solid");
eq("export is labelled Export G-code", COMMANDS.find((command) => command.id === "export")?.label, "Export G-code");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("commands: registry, key map and fuzzy ok");
