import {
  addRange,
  addVolume,
  bandFractions,
  defaultRange,
  defaultVolume,
  emptyOverrides,
  moveVolume,
  parseOverrides,
  projectOverrides,
  scaleVolume,
  sliceOverrideFields,
  type OverrideDocument,
} from "./overrides.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const empty = emptyOverrides();
eq("an empty document adds no slice fields", sliceOverrideFields(empty), {});
eq("a filled document still adds no slice fields", sliceOverrideFields({
  version: 1,
  ranges: [defaultRange("range-a")],
  volumes: [defaultVolume("box", 220, 220, "volume-a")],
}), {});

const body = { layerHeight: 0.2, blend: { mode: "single", strategy: "speed" } };
eq(
  "spreading the adapter leaves the request body alone",
  { ...body, ...sliceOverrideFields(empty) },
  body,
);
check("no modifiers means the project omits the field", projectOverrides(empty) === undefined);
check("a range is kept on the project", projectOverrides(addRange(empty, defaultRange("range-a")))?.ranges.length === 1);

const doc = addVolume(
  addRange(empty, defaultRange("range-a")),
  defaultVolume("cylinder", 220, 220, "volume-a"),
);
const opened = parseOverrides(JSON.parse(JSON.stringify(doc)));
check("round trip", opened.ok);
if (opened.ok) eq("round trip document", opened.doc, doc);

eq("a missing overrides value is incomplete", parseOverrides(null), { ok: false, message: "This project file is incomplete." });
eq(
  "a newer overrides version is refused",
  parseOverrides({ version: 2, ranges: [], volumes: [] }),
  { ok: false, message: "This project's overrides are version 2. This app opens overrides version 1." },
);
eq(
  "layer height is not an override",
  parseOverrides({ version: 1, ranges: [{ id: "r", zFrom: 0, zTo: 1, override: { layerHeight: 0.1 } }], volumes: [] }),
  { ok: false, message: "Layer height is not an override. The slice has one layer height." },
);

const moved = moveVolume(defaultVolume("box", 200, 180, "v"), "x", 5);
eq("move keeps size and steps x", { x: moved.x, sx: moved.sx, y: moved.y }, { x: 105, sx: 30, y: 90 });
const scaled = scaleVolume(moved, "z", -100);
eq("scale does not collapse the axis", scaled.sz, 0.2);
eq("scale leaves the center", scaled.z, moved.z);

const band = bandFractions(0, 4, 0, 20);
eq("a low band sits at the bottom of the slider", band.top + band.height, 1);
check("the band has height", band.height > 0.1 && band.height < 0.4, JSON.stringify(band));

const stored = projectOverrides(doc) as OverrideDocument;
check("stored version is 1", stored.version === 1 && stored.volumes[0].kind === "cylinder");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("overrides: store, adapter, and bands ok");
