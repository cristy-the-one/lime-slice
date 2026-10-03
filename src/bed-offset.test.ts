import { replyFrameEdit, replyFrameRay, replyOffset, sceneShift, shownBedOffset, type BedMotion, type SlicedBed } from "./bed-offset.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

const motion = (translation: [number, number], orient = "I", scale = 1, meshEpoch = 1): BedMotion => ({
  translation,
  orientKey: orient,
  scale,
  meshEpoch,
});

const sliced = (over: Partial<SlicedBed> = {}): SlicedBed => ({
  translation: [10, 20],
  offset: [0, 0],
  orientKey: "I",
  scale: 1,
  meshEpoch: 1,
  ...over,
});

eq("a reply with no offset is the origin", replyOffset(undefined), [0, 0]);
eq("a reply with a null offset is the origin", replyOffset(null), [0, 0]);
eq("a short offset is the origin", replyOffset([4]), [0, 0]);
eq("a non-finite offset is the origin", replyOffset([1, Number.NaN]), [0, 0]);
eq("a reply offset is kept", replyOffset([12.5, -3]), [12.5, -3]);

eq("nothing sliced draws at the origin", shownBedOffset(null, motion([10, 20])), [0, 0]);
eq("no move keeps a missing offset at the origin", shownBedOffset(sliced(), motion([10, 20])), [0, 0]);
eq("an X/Y move slides a reply that has no offset", shownBedOffset(sliced(), motion([14, 17])), [4, -3]);
eq("an X/Y move adds to the reply offset", shownBedOffset(sliced({ offset: [12.5, -3] }), motion([14, 17])), [16.5, -6]);
eq("the reply offset replaces the slide once the pose matches", shownBedOffset(sliced({ translation: [14, 17], offset: [40, -5] }), motion([14, 17])), [40, -5]);
eq("rotation does not slide the old paths", shownBedOffset(sliced({ offset: [2, 2] }), motion([30, 30], "R")), [2, 2]);
eq("scale does not slide the old paths", shownBedOffset(sliced({ offset: [2, 2] }), motion([30, 30], "I", 1.5)), [2, 2]);
eq("another mesh does not slide the old paths", shownBedOffset(sliced({ offset: [2, 2] }), motion([30, 30], "I", 1, 2)), [2, 2]);

eq("the matrix is a scene translation, not a buffer rewrite", sceneShift([4, -3]), [4, 0, 3]);
eq("picking subtracts the offset", replyFrameRay([13, 24, 5], [3, 4]), [10, 20, 5]);
eq("a zero offset leaves the ray in the reply frame", replyFrameRay([10, 20, 5], [0, 0]), [10, 20, 5]);

const site = { xy: [10, 20] as [number, number], z: 3 };
eq("an edit site is sent in the reply frame", replyFrameEdit(site), site);
eq("the drawn point converts back to that site", replyFrameRay([site.xy[0] + 7, site.xy[1] - 2, site.z], [7, -2]), [site.xy[0], site.xy[1], site.z]);

// Field names from `SliceResponse` after #118 (`serde(rename_all = "camelCase")`).
// `offset` is not one of them. A future reply adds that key and nothing else.
const engineReply = JSON.parse(`{
  "coreMs": 1,
  "baselineMs": 0,
  "baselineLabel": "",
  "mesh": {"triangles": 12, "outlineToleranceMm": 0, "min": [0, 0, 0], "max": [20, 20, 20]},
  "stages": {"contourMs": 0, "supportMs": 0, "toolpathMs": 0, "orderMs": 0, "combMs": 0, "emitMs": 0},
  "sanity": {"ok": true, "layers": 1, "extrusionMoves": 1, "travelMoves": 0, "finalE": 1, "extrusionLengthMm": 1, "travelLengthMm": 0, "minX": 0, "maxX": 20, "minY": 0, "maxY": 20, "notes": [], "retracts": 0, "zHops": 0},
  "coverage": [{"z": [0.2, 0.4], "areaMm2": 1.5, "min": [1, 2], "max": [4, 5], "outline": [[[1, 2], [4, 2], [4, 5]]]}],
  "inAir": {"islands": 0, "overhangs": 1},
  "gcode": "",
  "layers": [{"index": 0, "z": 0.2, "height": 0.2, "note": "", "speedWalls": 2, "toughnessWalls": 3, "supportPaths": 0, "seconds": 0.1, "paths": {"kinds": ["wall"], "strategies": ["toughness"], "kind": [0], "strategy": [0], "start": [0, 2], "xy": [0, 0, 10, 0], "z": [], "width": [0.45], "speed": [30], "effectiveSpeed": [28], "toughness": [1], "beadHeight": [0.2]}}],
  "blend": "toughness",
  "estimate": {"seconds": 1, "filamentMm": 10, "filamentG": 0.03, "arcMoves": 0, "travelMm": 0, "retracts": 0, "zHops": 0, "scarfedLoops": 0, "meanScarfMm": 0, "maxSeamZStepMm": 0, "byFeature": []},
  "score": {"speed": 0, "efficiency": 0, "toughness": 1},
  "compare": [],
  "skeleton": {"id": [1], "tree": [1], "into": [0], "live": [1], "siteX": [10], "siteY": [20], "siteZ": [0.2], "start": [0, 1], "xs": [10], "ys": [20], "zs": [0.2], "rs": [0.4]},
  "previewToken": "preview-1"
}`) as {
  offset?: [number, number];
  bedOffset?: [number, number];
  coverage: { outline: number[][][] }[];
  skeleton: { siteX: number[]; siteY: number[]; siteZ: number[] };
  layers: { paths: { xy: number[] } }[];
  previewPatch?: { base: string; layers: number[]; changed: unknown[] };
};

eq("today's reply has no offset key", Object.hasOwn(engineReply, "offset"), false);
eq("a reply without offset draws at the origin", replyOffset(engineReply.offset), [0, 0]);
eq("sanity minX is not the bed offset", replyOffset(engineReply.offset), [0, 0]);

const moved = JSON.parse(JSON.stringify(engineReply)) as typeof engineReply & { offset: [number, number] };
moved.offset = [40, -5];
moved.layers = [];
moved.previewPatch = { base: "preview-1", layers: [0], changed: [] };
eq("the contracted field is offset, a millimetre pair", replyOffset(moved.offset), [40, -5]);
eq("an X/Y move after that reply uses the new offset", shownBedOffset(sliced({ translation: [40, -5], offset: replyOffset(moved.offset) }), motion([40, -5])), [40, -5]);

const decoy = JSON.parse(`{"bedOffset":[9,9],"translation":[3,4]}`) as { offset?: [number, number] };
eq("bedOffset and translation are not the reply field", replyOffset(decoy.offset), [0, 0]);

const gap = engineReply.coverage[0]!.outline;
const sites = [engineReply.skeleton.siteX[0], engineReply.skeleton.siteY[0], engineReply.skeleton.siteZ[0]];
eq("coverage outlines stay in the reply frame", gap, [[[1, 2], [4, 2], [4, 5]]]);
eq("skeleton sites stay in the reply frame", sites, [10, 20, 0.2]);
eq("layer paths stay in the reply frame", engineReply.layers[0]!.paths.xy, [0, 0, 10, 0]);
eq("a patch does not rewrite those buffers", moved.previewPatch, { base: "preview-1", layers: [0], changed: [] });

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("bed-offset tests passed");
