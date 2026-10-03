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

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("bed-offset tests passed");
