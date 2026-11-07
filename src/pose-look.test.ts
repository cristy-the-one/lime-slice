/**
 * The Pose stage's looks and colours (`docs/plan-pose.md`, section 4 and D6). The colours are read from `tokens.css`, so
 * a token edit that loses contrast or collides with a colour the 3D view already uses fails here.
 */
import { readFileSync } from "node:fs";
import { lookOf } from "./pose-look.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// --- Looks ---
const scene = { selectedId: "a", chain: new Set(["b", "a"]), clashing: new Set(["c"]) };
check("the selected part is drawn selected", lookOf("a", scene) === "selected");
check("a chain member is drawn in the chain colour", lookOf("b", scene) === "chain");
check("a clash wins over the selection", lookOf("c", { ...scene, selectedId: "c" }) === "clash");
check("any other part keeps the plain look", lookOf("d", scene) === "part");
check("no selection leaves every part plain", lookOf("a", { selectedId: null, chain: new Set(), clashing: new Set() }) === "part");

// --- Colours ---
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** The token's value inside one `:root[data-scheme=...]` block, or null when that block does not set it. */
function blockToken(scheme: "dark" | "light", name: string): string | null {
  const start = css.indexOf(`:root[data-scheme="${scheme}"]`);
  if (start < 0) throw new Error(`no ${scheme} block`);
  const end = css.indexOf("\n}", start);
  const block = css.slice(start, end < 0 ? undefined : end);
  const found = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block);
  return found ? found[1]!.toLowerCase() : null;
}

/** A token the light block leaves out (`--mesh`) falls back to the dark value, as `themeColors` does. */
function token(scheme: "dark" | "light", name: string): string {
  const value = blockToken(scheme, name) ?? blockToken("dark", name);
  if (!value) throw new Error(`--${name} missing`);
  return value;
}

check("the light theme sets its own pose colours", blockToken("light", "pose") !== null && blockToken("light", "pose-chain") !== null);

const linear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).map(linear) as [number, number, number];
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** CIE76 distance in CIELAB (D65), the measure `colors.test.ts` keeps the slice palette apart with. */
function deltaE(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = rgb(hex);
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * bl);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
}

for (const scheme of ["dark", "light"] as const) {
  const pose = token(scheme, "pose");
  const chain = token(scheme, "pose-chain");
  const stage = token(scheme, "stage");
  const where = `${scheme}: ${pose} / ${chain} on ${stage}`;
  check(`the pose colour stands out on the stage (${scheme})`, contrast(pose, stage) >= 3, `${where}: ${contrast(pose, stage).toFixed(2)}`);
  check(`the chain colour stands out on the stage (${scheme})`, contrast(chain, stage) >= 3, `${where}: ${contrast(chain, stage).toFixed(2)}`);
  check(`the selection and its chain are told apart (${scheme})`, deltaE(pose, chain) >= 12, `${where}: ΔE ${deltaE(pose, chain).toFixed(1)}`);
  // The colours a part can stand beside in Pose: plain parts, the clash tint, the part green, and the error red.
  for (const other of ["context", "amber", "mesh"]) {
    const value = token(scheme, other);
    check(`the pose colour is not --${other} (${scheme})`, deltaE(pose, value) >= 30, `${pose} vs ${value}: ΔE ${deltaE(pose, value).toFixed(1)}`);
    check(`the chain colour is not --${other} (${scheme})`, deltaE(chain, value) >= 30, `${chain} vs ${value}: ΔE ${deltaE(chain, value).toFixed(1)}`);
  }
  const danger = token(scheme, "danger");
  check(`the pose colour is its own, not the error red (${scheme})`, pose !== danger && deltaE(pose, danger) >= 10, `${pose} vs ${danger}: ΔE ${deltaE(pose, danger).toFixed(1)}`);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("pose look tests passed");
