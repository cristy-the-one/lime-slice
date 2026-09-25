export type ThemeChoice = "system" | "dark" | "light";

const KEY = "lime-slice-theme";

export interface ThemeColors {
  stage: string;
  text: string;
  muted: string;
  teal: string;
  amber: string;
  line: string;
  bedMinor: string;
  danger: string;
  slow: string;
  fast: string;
  spark: string;
}

export function loadTheme(): ThemeChoice {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

export function applyTheme(choice: ThemeChoice) {
  localStorage.setItem(KEY, choice);
  document.documentElement.dataset.theme = choice;
}

export function themeColors(): ThemeColors {
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    stage: pick("--stage", "#0c0e12"),
    text: pick("--text", "#e7e2d6"),
    muted: pick("--muted", "#b3ab9e"),
    teal: pick("--teal", "#2ec4b6"),
    amber: pick("--amber", "#f0a202"),
    line: pick("--line", "#313744"),
    bedMinor: pick("--bed-minor", "#222733"),
    danger: pick("--danger", "#e85d4c"),
    slow: pick("--slow", "#f0a202"),
    fast: pick("--fast", "#d55e00"),
    spark: pick("--spark", "#3d4654"),
  };
}

export function hexToThree(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(n) ? n : 0;
}

export function onSchemeChange(cb: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", cb);
}
