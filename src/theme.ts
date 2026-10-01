export type ThemeChoice = "system" | "dark" | "light";

const KEY = "lime-slice-theme";

export interface ThemeColors {
  stage: string;
  text: string;
  muted: string;
  teal: string;
  amber: string;
  line: string;
  bed: string;
  bedMinor: string;
  mesh: string;
  danger: string;
  slow: string;
  fast: string;
  spark: string;
  sheet: string;
  gizmoHot: string;
  axisX: string;
  axisY: string;
  axisZ: string;
}

export function loadTheme(): ThemeChoice {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

export function applyTheme(choice: ThemeChoice) {
  localStorage.setItem(KEY, choice);
  const root = document.documentElement;
  root.dataset.theme = choice;
  root.dataset.scheme = resolvedScheme(choice);
}

export function themeColors(): ThemeColors {
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    stage: pick("--stage", "#0b0d11"),
    text: pick("--text", "#e8eaed"),
    muted: pick("--muted", "#a3abb8"),
    teal: pick("--teal", "#2ec4b6"),
    amber: pick("--amber", "#f5a524"),
    line: pick("--line", "#2a303a"),
    bed: pick("--bed", "#141820"),
    bedMinor: pick("--bed-minor", "#222733"),
    mesh: pick("--mesh", "#c6f26d"),
    danger: pick("--danger", "#f0615a"),
    slow: pick("--slow", "#f5a524"),
    fast: pick("--fast", "#d55e00"),
    spark: pick("--spark", "#3a4250"),
    sheet: pick("--sheet", "#f4efe4"),
    gizmoHot: pick("--gizmo-hot", "#ffffff"),
    axisX: pick("--axis-x", "#e85d4c"),
    axisY: pick("--axis-y", "#8fce6a"),
    axisZ: pick("--axis-z", "#6aa7ff"),
  };
}

export function hexToThree(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(n) ? n : 0;
}

export function onSchemeChange(cb: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", () => {
    if (document.documentElement.dataset.theme === "system") applyTheme("system");
    cb();
  });
}

function resolvedScheme(choice: ThemeChoice): "light" | "dark" {
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
