/**
 * The one list of commands. The palette, the shortcut sheet, button tooltips and the keyboard dispatcher
 * (`keys.ts`) all read it. A command runs by its case in `runCommand` (`palette.ts`), else by clicking `target`.
 */
export type KeyScope =
  | "always"
  | "help"
  | "prepare"
  | "objects"
  | "preview"
  | "running"
  | "searching"
  | "brush"
  | "find";

export interface CommandSpec {
  id: string;
  label: string;
  group: string;
  /** Chords in the sheet's own spelling: "Ctrl+Shift+Z", "Shift+1", "Esc", "↑", "PgUp", "Del". The first is shown in tooltips and palette rows. */
  keys?: string[];
  /** Where the chords fire. Default "always", which means the shortcut sheet is closed. */
  when?: KeyScope;
  /** Fires while a text field has focus. */
  typing?: boolean;
  /** Fires on key auto-repeat. */
  repeat?: boolean;
  /** Selector of the button this command mirrors. A keyed command shows its first chord in that button's tooltip. */
  target?: string;
  /** Where the command is listed. Default "both". */
  show?: "both" | "help" | "none";
  keywords?: string;
}

export const COMMANDS: CommandSpec[] = [
  { id: "palette", label: "Command palette", group: "Window", keys: ["Ctrl+K"], typing: true, keywords: "search commands" },
  { id: "help", label: "Shortcut sheet", group: "Window", keys: ["?"], keywords: "help keys" },
  { id: "help-close", label: "Close shortcut sheet", group: "Window", keys: ["Esc", "?"], when: "help", typing: true, show: "none" },
  { id: "panel-left", label: "Toggle settings panel", group: "Window", keys: ["Ctrl+B"], keywords: "left collapse" },
  { id: "panel-right", label: "Toggle blend panel", group: "Window", keys: ["Ctrl+Alt+B"], keywords: "right collapse" },
  { id: "open-project", label: "Open project", group: "File", keys: ["Ctrl+O"], typing: true, keywords: "lime file" },
  { id: "save-project", label: "Save project", group: "File", keys: ["Ctrl+S"], typing: true, keywords: "lime file" },
  { id: "open-mesh", label: "Open mesh", group: "File", target: "#file", keywords: "file stl 3mf step" },
  { id: "samples", label: "Samples", group: "File", keywords: "cube hull example" },
  { id: "slice", label: "Slice", group: "Slice", keys: ["Ctrl+Enter"], typing: true, target: "#slice", keywords: "plan show result re-slice" },
  { id: "force-slice", label: "Force re-slice", group: "Slice", keys: ["Ctrl+Shift+Enter"], typing: true, target: "#force", keywords: "recompute cache" },
  { id: "cancel-slice", label: "Cancel slice", group: "Slice", keys: ["Esc"], when: "running", typing: true, target: "#cancel", keywords: "stop abort" },
  { id: "export", label: "Export G-code", group: "Slice", keys: ["Ctrl+E"], target: "#export", keywords: "save download" },
  { id: "send-printer", label: "Send to printer", group: "Slice", keywords: "prusa link upload gcode host" },
  { id: "tab-prepare", label: "Prepare", group: "View", keys: ["1"], target: "#tabPrepare", keywords: "tab mesh stage" },
  { id: "tab-preview", label: "Preview", group: "View", keys: ["2"], target: "#tabPreview", keywords: "tab toolpath stage" },
  { id: "tab-gcode", label: "G-code", group: "View", keys: ["3"], target: "#tabGcode", keywords: "tab gcode stage" },
  { id: "view-cycle", label: "Cycle 2D, split, 3D", group: "View", keys: ["V"], when: "preview", keywords: "preview mode flat solid" },
  { id: "view-2d", label: "2D preview", group: "View", target: '[data-mode="flat"]', keywords: "flat" },
  { id: "view-split", label: "Split preview", group: "View", target: '[data-mode="split"]' },
  { id: "view-3d", label: "3D preview", group: "View", target: '[data-mode="solid"]', keywords: "solid" },
  { id: "view-top", label: "Top view", group: "View", keys: ["T"], target: "#viewPresets button:nth-child(1)", keywords: "camera prepare" },
  { id: "view-front", label: "Front view", group: "View", keys: ["Y"], target: "#viewPresets button:nth-child(2)", keywords: "camera prepare" },
  { id: "view-iso", label: "Iso view", group: "View", keys: ["I"], target: "#viewPresets button:nth-child(3)", keywords: "camera prepare isometric" },
  { id: "layer-up", label: "Layer up", group: "Layers", keys: ["↑", "]"], when: "preview", repeat: true, show: "help" },
  { id: "layer-down", label: "Layer down", group: "Layers", keys: ["↓", "["], when: "preview", repeat: true, show: "help" },
  { id: "layer-up-10", label: "Ten layers up", group: "Layers", keys: ["PgUp"], when: "preview", repeat: true, show: "help" },
  { id: "layer-down-10", label: "Ten layers down", group: "Layers", keys: ["PgDn"], when: "preview", repeat: true, show: "help" },
  { id: "layer-first", label: "First layer", group: "Layers", keys: ["Home"], when: "preview", show: "help" },
  { id: "layer-last", label: "Last layer", group: "Layers", keys: ["End"], when: "preview", show: "help" },
  { id: "strategy-speed", label: "Strategy: Speed", group: "Strategy", keys: ["Shift+1"], target: '[data-card="speed"]', keywords: "blend" },
  { id: "strategy-efficiency", label: "Strategy: Efficiency", group: "Strategy", keys: ["Shift+2"], target: '[data-card="efficiency"]', keywords: "blend" },
  { id: "strategy-toughness", label: "Strategy: Toughness", group: "Strategy", keys: ["Shift+3"], target: '[data-card="toughness"]', keywords: "blend" },
  { id: "strategy-layer", label: "Strategy: By layer", group: "Strategy", keys: ["Shift+4"], target: '[data-card="layer"]', keywords: "blend" },
  { id: "strategy-region", label: "Strategy: By region", group: "Strategy", keys: ["Shift+5"], target: '[data-card="region"]', keywords: "blend split plane" },
  { id: "plate-arrange", label: "Arrange plate", group: "Plate", keys: ["A"], when: "prepare", target: "#plateArrange", keywords: "objects pack" },
  { id: "plate-duplicate", label: "Duplicate object", group: "Plate", keys: ["Ctrl+D"], when: "prepare", target: "#plateDuplicate", keywords: "copy" },
  { id: "plate-remove", label: "Remove object", group: "Plate", keys: ["Del", "Backspace"], when: "objects", keywords: "delete" },
  { id: "tool-move", label: "Move", group: "Tools", keys: ["M"], target: '#toolRail [data-tool="move"]', keywords: "translate gizmo" },
  { id: "tool-rotate", label: "Rotate", group: "Tools", keys: ["R"], target: '#toolRail [data-tool="rotate"]', keywords: "gizmo" },
  { id: "tool-scale", label: "Scale", group: "Tools", keys: ["S"], target: '#toolRail [data-tool="scale"]', keywords: "percent field" },
  { id: "tool-layflat", label: "Lay flat", group: "Tools", keys: ["F"], target: '#layflat, #toolRail [data-tool="layflat"]', keywords: "bed face" },
  { id: "tool-section", label: "Section", group: "Tools", keys: ["C"], target: '#toolRail [data-tool="section"]', keywords: "clip cut" },
  { id: "edit-supports", label: "Edit supports", group: "Tools", keys: ["E"], target: '#toolRail [data-tool="supports"]', keywords: "tree branch delete prune regrow" },
  { id: "paint-supports", label: "Paint supports", group: "Tools", keys: ["B"], target: '#toolRail [data-tool="paint"]', keywords: "brush enforce block" },
  { id: "paint-seam", label: "Paint seam", group: "Tools", keys: ["K"], target: '#toolRail [data-tool="seam"]', keywords: "brush" },
  { id: "brush-smaller", label: "Smaller brush", group: "Tools", keys: ["["], when: "brush", repeat: true, show: "help" },
  { id: "brush-larger", label: "Larger brush", group: "Tools", keys: ["]"], when: "brush", repeat: true, show: "help" },
  { id: "undo", label: "Undo", group: "Edit", keys: ["Ctrl+Z"], typing: true, keywords: "placement settings revert" },
  { id: "redo", label: "Redo", group: "Edit", keys: ["Ctrl+Shift+Z"], typing: true, keywords: "placement settings again" },
  { id: "search", label: "Search settings", group: "Edit", keys: ["/", "Ctrl+F"], when: "find", keywords: "find filter" },
  { id: "search-clear", label: "Clear settings search", group: "Edit", keys: ["Esc"], when: "searching", typing: true, show: "none" },
  { id: "theme-system", label: "Theme: System", group: "Settings", keywords: "theme appearance" },
  { id: "theme-dark", label: "Theme: Dark", group: "Settings", keywords: "theme appearance" },
  { id: "theme-light", label: "Theme: Light", group: "Settings", keywords: "theme appearance" },
  { id: "level-simple", label: "Settings level: Simple", group: "Settings", keywords: "level" },
  { id: "level-advanced", label: "Settings level: Advanced", group: "Settings", keywords: "level" },
  { id: "level-expert", label: "Settings level: Expert", group: "Settings", keywords: "level" },
  { id: "profile-save", label: "Save settings profile", group: "Settings", keywords: "limeprofile name" },
  { id: "profile-rename", label: "Rename settings profile", group: "Settings", keywords: "limeprofile" },
  { id: "profile-duplicate", label: "Duplicate settings profile", group: "Settings", keywords: "limeprofile copy" },
  { id: "profile-delete", label: "Delete settings profile", group: "Settings", keywords: "limeprofile remove" },
  { id: "profile-export", label: "Export settings profile", group: "Settings", keywords: "limeprofile json download" },
  { id: "profile-import", label: "Import settings profile", group: "Settings", keywords: "limeprofile json open" },
];

/** Gestures the sheet lists beside the keys. The pointer code lives in the views. */
export const MOUSE_HINTS: { gesture: string; label: string }[] = [
  { gesture: "Shift + drag", label: "Snap a move to 1 mm, a rotation to 15°" },
  { gesture: "Scroll a handle", label: "Nudge 0.1 mm, or 1° on a ring" },
  { gesture: "Drag the plane", label: "Move the By region split" },
  { gesture: "2D: drag", label: "Pan the layer" },
  { gesture: "2D: wheel", label: "Zoom at the cursor" },
];

/** Everything that decides whether a chord fires, read once per key press. */
export interface KeyContext {
  helpOpen: boolean;
  typing: boolean;
  stage: "prepare" | "preview" | "gcode";
  hasResult: boolean;
  running: boolean;
  /** Focus is in the settings search, or a query is active and no other field has focus. */
  searching: boolean;
  /** A paint or seam brush is on. */
  brushOn: boolean;
  editingSupports: boolean;
  /** Focus is in the G-code pane, where Ctrl+F stays the browser's. */
  inGcode: boolean;
}

/** Scopes that share a chord must not overlap: Esc cancels a slice only when it is not clearing a search. */
const SCOPES: Record<KeyScope, (c: KeyContext) => boolean> = {
  always: (c) => !c.helpOpen,
  help: (c) => c.helpOpen,
  prepare: (c) => !c.helpOpen && c.stage === "prepare",
  objects: (c) => !c.helpOpen && c.stage === "prepare" && !c.brushOn && !c.editingSupports,
  preview: (c) => !c.helpOpen && c.stage === "preview" && c.hasResult,
  running: (c) => !c.helpOpen && c.running && !c.searching,
  searching: (c) => !c.helpOpen && c.searching,
  brush: (c) => !c.helpOpen && c.stage === "prepare" && c.brushOn,
  find: (c) => !c.helpOpen && !c.inGcode,
};

export type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat">;

const KEY_NAMES: Record<string, string> = {
  Esc: "Escape",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  PgUp: "PageUp",
  PgDn: "PageDown",
  Del: "Delete",
};

/** Does `chord` ("Ctrl+Shift+Z", "Shift+1", "]") describe this key press? Ctrl also stands for Cmd. */
export function chordMatches(chord: string, ev: KeyEventLike): boolean {
  const parts = chord.split("+");
  const name = parts[parts.length - 1] ?? "";
  const mods = parts.slice(0, -1);
  const key = KEY_NAMES[name] ?? name;
  if (mods.includes("Ctrl") !== (ev.ctrlKey || ev.metaKey)) return false;
  if (mods.includes("Alt") !== ev.altKey) return false;
  const punctuation = key.length === 1 && !/[a-z0-9]/i.test(key);
  if (!punctuation && mods.includes("Shift") !== ev.shiftKey) return false;
  // A shifted digit or an Alt letter reports another `key`, so those chords match the physical key.
  if (/^[0-9]$/.test(key) && mods.includes("Shift")) return ev.code === `Digit${key}`;
  if (/^[a-z]$/i.test(key) && mods.includes("Alt")) return ev.code === `Key${key.toUpperCase()}`;
  return ev.key.toLowerCase() === key.toLowerCase();
}

export function fires(command: CommandSpec, ev: KeyEventLike, ctx: KeyContext): boolean {
  if (!command.keys) return false;
  if (!SCOPES[command.when ?? "always"](ctx)) return false;
  if (ctx.typing && !command.typing) return false;
  if (ev.repeat && !command.repeat) return false;
  return command.keys.some((chord) => chordMatches(chord, ev));
}

/** The command a key press runs, or null. The tests keep a key press from firing two commands in one context. */
export function resolveKey(ev: KeyEventLike, ctx: KeyContext, commands: CommandSpec[] = COMMANDS): CommandSpec | null {
  return commands.find((command) => fires(command, ev, ctx)) ?? null;
}

/** First chord: the one tooltips and palette rows show. */
export function shortcutOf(command: CommandSpec): string | undefined {
  return command.keys?.[0];
}

/** The first chord of the command with this id. */
export function keyOf(id: string, commands: CommandSpec[] = COMMANDS): string | undefined {
  const command = commands.find((c) => c.id === id);
  return command ? shortcutOf(command) : undefined;
}

/** A chord as a label prints it beside its text: ⇧1, Ctrl ↵, Ctrl E. Tooltips and the sheet keep the registry spelling. */
export function chordGlyphs(chord: string): string {
  return chord.replace("Shift+", "⇧").replace("Ctrl+", "Ctrl ").replace("Alt+", "Alt ").replace("Enter", "↵");
}

export function paletteCommands(commands: CommandSpec[] = COMMANDS): CommandSpec[] {
  return commands.filter((command) => (command.show ?? "both") === "both");
}

export interface HelpGroup {
  group: string;
  entries: { keys: string[]; label: string }[];
}

/** Keyed commands for the sheet, grouped in registry order. */
export function helpGroups(commands: CommandSpec[] = COMMANDS): HelpGroup[] {
  const groups: HelpGroup[] = [];
  for (const command of commands) {
    if (!command.keys || command.show === "none") continue;
    let group = groups.find((g) => g.group === command.group);
    if (!group) {
      group = { group: command.group, entries: [] };
      groups.push(group);
    }
    group.entries.push({ keys: command.keys, label: command.label });
  }
  return groups;
}

/** The keyed command a button stands for, found through `target`. */
export function commandForElement(el: Element, commands: CommandSpec[] = COMMANDS): CommandSpec | undefined {
  return commands.find((command) => command.keys && command.target && el.matches(command.target));
}

/** Every keyed `target` as one selector, for code that must notice those buttons. */
export function targetSelector(commands: CommandSpec[] = COMMANDS): string {
  return commands.flatMap((command) => (command.keys && command.target ? [command.target] : [])).join(", ");
}

/**
 * Subsequence score. `null` when `query` is not a subsequence of `text`.
 * Empty query scores 0 so callers can keep the registry order.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let prev = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) {
      streak = 0;
      continue;
    }
    const boundary = i === 0 || /[^a-z0-9]/.test(t[i - 1]!);
    score += 8;
    if (boundary) score += 10;
    if (i === prev + 1) {
      streak += 1;
      score += 6 + streak;
    } else {
      streak = 0;
    }
    prev = i;
    qi += 1;
  }
  if (qi < q.length) return null;
  if (t.startsWith(q)) score += 50;
  for (const word of t.split(/[^a-z0-9]+/)) {
    if (word.startsWith(q)) score += 30;
  }
  score -= Math.max(0, t.length - q.length) * 0.05;
  return score;
}

export function rankCommands<T extends { label: string; keywords?: string; group?: string }>(items: T[], query: string): T[] {
  const q = query.trim();
  if (!q) return items.slice();
  const ranked: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const labelScore = fuzzyScore(q, item.label);
    const hay = `${item.label} ${item.keywords ?? ""} ${item.group ?? ""}`;
    const extra = fuzzyScore(q, hay);
    const score = labelScore == null ? extra : labelScore + 20;
    if (score == null) return;
    ranked.push({ item, score, index });
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.map((row) => row.item);
}
