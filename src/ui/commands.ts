/** Shared command list for the palette and the ? shortcut sheet. */
export interface CommandSpec {
  id: string;
  label: string;
  group: string;
  /** Shown in the palette and the shortcut sheet. Omit when the action has no key. */
  shortcut?: string;
  keywords?: string;
}

export const COMMANDS: CommandSpec[] = [
  { id: "palette", label: "Command palette", group: "Window", shortcut: "Ctrl+K", keywords: "search commands" },
  { id: "help", label: "Shortcut sheet", group: "Window", shortcut: "?", keywords: "help keys" },
  { id: "open-project", label: "Open project", group: "File", shortcut: "Ctrl+O", keywords: "lime file" },
  { id: "save-project", label: "Save project", group: "File", shortcut: "Ctrl+S", keywords: "lime file" },
  { id: "open-mesh", label: "Open mesh", group: "File", keywords: "file stl 3mf step" },
  { id: "samples", label: "Samples", group: "File", keywords: "cube hull example" },
  { id: "slice", label: "Slice", group: "Slice", shortcut: "Ctrl+Enter", keywords: "plan show result re-slice" },
  { id: "force-slice", label: "Force re-slice", group: "Slice", keywords: "recompute cache" },
  { id: "cancel-slice", label: "Cancel slice", group: "Slice", keywords: "stop abort" },
  { id: "export", label: "Export G-code", group: "Slice", shortcut: "Ctrl+E", keywords: "save download" },
  { id: "tab-prepare", label: "Prepare", group: "View", keywords: "tab mesh" },
  { id: "tab-preview", label: "Preview", group: "View", keywords: "tab toolpath" },
  { id: "tab-gcode", label: "G-code", group: "View", keywords: "tab gcode" },
  { id: "view-2d", label: "2D preview", group: "View", shortcut: "1", keywords: "flat" },
  { id: "view-split", label: "Split preview", group: "View", shortcut: "2" },
  { id: "view-3d", label: "3D preview", group: "View", shortcut: "3", keywords: "solid" },
  { id: "view-top", label: "Top view", group: "View", shortcut: "T", keywords: "camera prepare" },
  { id: "view-front", label: "Front view", group: "View", shortcut: "Y", keywords: "camera prepare" },
  { id: "view-iso", label: "Iso view", group: "View", shortcut: "I", keywords: "camera prepare isometric" },
  { id: "tool-move", label: "Move", group: "Tools", shortcut: "M", keywords: "translate gizmo" },
  { id: "tool-rotate", label: "Rotate", group: "Tools", shortcut: "R", keywords: "gizmo" },
  { id: "tool-scale", label: "Scale", group: "Tools", shortcut: "S", keywords: "percent field" },
  { id: "tool-layflat", label: "Lay flat", group: "Tools", shortcut: "F", keywords: "bed face" },
  { id: "undo", label: "Undo", group: "Edit", shortcut: "Ctrl+Z", keywords: "placement settings revert" },
  { id: "redo", label: "Redo", group: "Edit", shortcut: "Ctrl+Shift+Z", keywords: "placement settings again" },
  { id: "tool-section", label: "Section", group: "Tools", shortcut: "C", keywords: "clip cut" },
  { id: "edit-supports", label: "Edit supports", group: "Tools", shortcut: "E", keywords: "tree branch delete prune regrow" },
  { id: "theme-system", label: "Theme: System", group: "Settings", keywords: "theme appearance" },
  { id: "theme-dark", label: "Theme: Dark", group: "Settings", keywords: "theme appearance" },
  { id: "theme-light", label: "Theme: Light", group: "Settings", keywords: "theme appearance" },
  { id: "level-simple", label: "Settings level: Simple", group: "Settings", keywords: "level" },
  { id: "level-advanced", label: "Settings level: Advanced", group: "Settings", keywords: "level" },
  { id: "level-expert", label: "Settings level: Expert", group: "Settings", keywords: "level" },
  { id: "panel-left", label: "Toggle settings panel", group: "Window", keywords: "left collapse" },
  { id: "panel-right", label: "Toggle blend panel", group: "Window", keywords: "right collapse" },
];

export function helpEntries(commands: CommandSpec[] = COMMANDS): { shortcut: string; label: string }[] {
  return commands.filter((command) => command.shortcut).map((command) => ({ shortcut: command.shortcut!, label: command.label }));
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
