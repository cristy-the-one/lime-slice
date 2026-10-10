import { markProjectDirty } from "../project-dirty";
import { changedPresetKeys, type PresetSettings } from "../presets";
import "./shell.css";

export type SettingsLevel = "simple" | "advanced" | "expert";

const LEVEL_KEY = "lime-slice-settings-level";

const FIELD_KEYS: Record<string, keyof PresetSettings> = {
  lh: "layerHeight",
  adaptive: "adaptive",
  amin: "adaptiveMin",
  amax: "adaptiveMax",
  simplify: "simplify",
  simperr: "simplifyError",
  feeds: "featureSpeeds",
  arcs: "arcFit",
  combine: "infillCombine",
  combing: "combing",
  overhang: "overhangControl",
  pa: "pressureAdvance",
  la: "linearAdvance",
  gyroid3d: "gyroid3d",
  zhop: "zHop",
  zhopht: "zHopHeight",
  zhopmin: "zHopMinTravel",
  vwidth: "variableWidth",
  travelopt: "travelOpt",
  seam: "seam",
  ironing: "ironing",
  ironflow: "ironingFlow",
  ironspeed: "ironingSpeed",
  ironspace: "ironingSpacing",
  fuzzy: "fuzzySkin",
  fuzzythick: "fuzzyThickness",
  fuzzydist: "fuzzyPointDistance",
  scarf: "scarfSeam",
  scarflen: "scarfLength",
  scarfsteps: "scarfSteps",
  supports: "supports",
  sstyle: "supportStyle",
  sangle: "supportAngle",
  bangle: "branchAngle",
  tipd: "tipDiameter",
  trunkd: "trunkDiameter",
  shmult: "supportHeightMult",
  autoslice: "autoSlice",
  weight: "toughness",
  bottom: "bottomMm",
  trans: "transitionMm",
  axis: "axis",
  at: "atMm",
};

export function loadSettingsLevel(): SettingsLevel {
  const raw = localStorage.getItem(LEVEL_KEY);
  if (raw === "simple" || raw === "advanced" || raw === "expert") return raw;
  return "expert";
}

export function applyStoredLevel() {
  document.documentElement.dataset.settingsLevel = loadSettingsLevel();
}

export function setSettingsLevel(level: SettingsLevel) {
  localStorage.setItem(LEVEL_KEY, level);
  document.documentElement.dataset.settingsLevel = level;
  document.querySelectorAll<HTMLButtonElement>("[data-level-choice]").forEach((el) => {
    el.setAttribute("aria-pressed", el.dataset.levelChoice === level ? "true" : "false");
  });
}

export function levelBarHtml() {
  const level = loadSettingsLevel();
  const button = (id: SettingsLevel, label: string) =>
    `<button class="btn level-btn" type="button" data-level-choice="${id}" aria-pressed="${level === id ? "true" : "false"}">${label}</button>`;
  return `<div class="level-bar" role="radiogroup" aria-label="Settings level">${button("simple", "Simple")}${button("advanced", "Advanced")}${button("expert", "Expert")}</div>`;
}

export function mountSettingsPanel() {
  applyStoredLevel();
  const left = document.querySelector("#left");
  left?.addEventListener("click", (ev) => {
    const button = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-level-choice]");
    if (!button?.dataset.levelChoice) return;
    const level = button.dataset.levelChoice as SettingsLevel;
    setSettingsLevel(level);
    markProjectDirty();
  });
}

/** Dots for values that differ from the factory preset. Same comparison as the preset diff. */
export function paintSettingMarks(current: PresetSettings) {
  const changed = new Set(changedPresetKeys(current));
  for (const [id, key] of Object.entries(FIELD_KEYS)) {
    const input = document.getElementById(id);
    const row = input?.closest<HTMLElement>("label, .setting");
    row?.classList.toggle("is-modified", changed.has(key));
  }
}
