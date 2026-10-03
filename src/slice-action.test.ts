import { cacheStatus, coverageWarning, feed, fnv1aHex, inAirWarning, partFrameKey, quietRefresh, recipeKey, sliceAction, sliceBusyLabel, staleSliceCopy } from "./slice-action.ts";

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

const none = sliceAction({ cached: false, settingsChanged: false, force: false });
eq("none state", none.state, "none");
eq("none label", none.label, "Slice");
eq("none reslice", none.reslice, false);
eq("none recompute", none.recompute, true);

const cached = sliceAction({ cached: true, settingsChanged: false, force: false });
eq("cached state", cached.state, "cached");
eq("cached label", cached.label, "Show result");
eq("cached reslice", cached.reslice, false);
eq("cached recompute", cached.recompute, false);

const returned = sliceAction({ cached: true, settingsChanged: true, force: false });
eq("cached after settings return", returned.state, "cached");
eq("cached after settings return label", returned.label, "Show result");
eq("cached after settings return recompute", returned.recompute, false);

const changed = sliceAction({ cached: false, settingsChanged: true, force: false });
eq("changed state", changed.state, "changed");
eq("changed label", changed.label, "Re-slice");
eq("changed reslice", changed.reslice, false);
eq("changed recompute", changed.recompute, true);

const force = sliceAction({ cached: true, settingsChanged: false, force: true });
eq("force state", force.state, "force");
eq("force label", force.label, "Force re-slice");
eq("force reslice", force.reslice, true);
eq("force recompute", force.recompute, true);

const forceOnChange = sliceAction({ cached: true, settingsChanged: true, force: true });
eq("force still wins when the shown result differs", forceOnChange.state, "force");
eq("force still sends reslice", forceOnChange.reslice, true);

const forceMiss = sliceAction({ cached: false, settingsChanged: true, force: true });
eq("force on a miss stays a real re-slice", forceMiss.state, "changed");
eq("force on a miss does not pretend to bypass a cache", forceMiss.reslice, false);
eq("force on a miss still recomputes", forceMiss.recompute, true);

const forceFresh = sliceAction({ cached: false, settingsChanged: false, force: true });
eq("force with nothing cached is Slice", forceFresh.state, "none");
eq("force with nothing cached does not set reslice", forceFresh.reslice, false);

eq("busy recompute", sliceBusyLabel(true), "Slicing…");
eq("busy cache load", sliceBusyLabel(false), "Loading…");
eq("stale cached status", staleSliceCopy("cached").status, "This preview is stale. Show the saved result before export.");
eq("stale changed banner", staleSliceCopy("changed").banner, "Settings changed since this slice. Export stays off until you re-slice.");
check("cache status names force", cacheStatus("speed", "today").includes("Force re-slice"));

const speed = { mode: "single", strategy: "speed" };
const keyA = recipeKey({ layerHeight: 0.2, reslice: true, blend: speed, dataB64: "abc" }, "mesh-a");
const keyB = recipeKey({ blend: { strategy: "speed", mode: "single" }, layerHeight: 0.2 }, "mesh-a");
eq("recipe key ignores reslice, dataB64, and key order", keyA, keyB);
check("layer height changes the recipe", recipeKey({ layerHeight: 0.28, blend: speed }, "mesh-a") !== keyA);
check("mesh bytes change the recipe", recipeKey({ layerHeight: 0.2, blend: speed }, "mesh-b") !== keyA);
eq(
  "unset edit fields leave the recipe as it was before edits existed",
  recipeKey({ layerHeight: 0.2, blend: speed, supportEdits: undefined, includeSkeleton: undefined }, "mesh-a"),
  '{"blend":{"mode":"single""strategy":"speed"}"layerHeight":0.2}\nmesh-a',
);
eq(
  "a prune edit is part of the recipe",
  recipeKey({ layerHeight: 0.2, blend: speed, supportEdits: [{ kind: "prune", sites: [{ xy: [1, 2], z: 3 }] }] }, "mesh-a"),
  '{"blend":{"mode":"single""strategy":"speed"}"layerHeight":0.2"supportEdits":[{"kind":"prune""sites":[{"xy":[1,2,]"z":3},]},]}\nmesh-a',
);

const posed = (translation: number[], rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1]) => ({
  layerHeight: 0.2,
  blend: speed,
  pose: { rotation, pivot: [10, 10, 5], translation },
});
const home = partFrameKey(posed([110, 110, 5]), "mesh-a");
eq("an X/Y move keeps the part frame", partFrameKey(posed([140, 95, 5]), "mesh-a"), home);
check("an X/Y move is still a new recipe", recipeKey(posed([140, 95, 5]), "mesh-a") !== recipeKey(posed([110, 110, 5]), "mesh-a"));
check("a Z move leaves the part frame", partFrameKey(posed([110, 110, 7]), "mesh-a") !== home);
check("a rotation leaves the part frame", partFrameKey(posed([110, 110, 5], [0, -1, 0, 1, 0, 0, 0, 0, 1]), "mesh-a") !== home);
check("a setting leaves the part frame", partFrameKey({ ...posed([140, 95, 5]), layerHeight: 0.28 }, "mesh-a") !== home);
check("other mesh bytes leave the part frame", partFrameKey(posed([110, 110, 5]), "mesh-b") !== home);
eq("no pose, the part frame is the recipe", partFrameKey({ layerHeight: 0.2 }, "mesh-a"), recipeKey({ layerHeight: 0.2 }, "mesh-a"));

eq("a fresh result needs no refresh", quietRefresh({ stale: false, cached: true, sameFrame: true, fromCache: false }), false);
eq("an X/Y move refreshes on its own", quietRefresh({ stale: true, cached: false, sameFrame: true, fromCache: false }), true);
eq("a stored recipe refreshes on its own", quietRefresh({ stale: true, cached: true, sameFrame: false, fromCache: false }), true);
eq("a new recipe waits for Slice", quietRefresh({ stale: true, cached: false, sameFrame: false, fromCache: false }), false);
eq("a move after a disk-cache load waits for Slice", quietRefresh({ stale: true, cached: false, sameFrame: true, fromCache: true }), false);
eq("a stored recipe after a disk-cache load still refreshes", quietRefresh({ stale: true, cached: true, sameFrame: false, fromCache: true }), true);

eq("feed sorts object keys and writes no commas", feed({ b: 1, a: true }), '{"a":true"b":1}');
eq("feed keeps array order and a trailing comma", feed([1, 2]), "[1,2,]");
eq("same bytes, same fingerprint", fnv1aHex(new Uint8Array([1, 2, 3])), fnv1aHex(new Uint8Array([1, 2, 3])));
check("different bytes, different fingerprint", fnv1aHex(new Uint8Array([1, 2, 3])) !== fnv1aHex(new Uint8Array([1, 2, 4])));

eq("no coverage gaps, no warning", coverageWarning([]), null);
eq("one coverage gap", coverageWarning([{ areaMm2: 16 }]), "Supports leave 1 overhang patch unheld, 16.0 mm² in all.");
eq(
  "coverage gaps add up",
  coverageWarning([{ areaMm2: 375.24 }, { areaMm2: 2.5 }]),
  "Supports leave 2 overhang patches unheld, 377.7 mm² in all.",
);
eq("supports on, no air report", inAirWarning(undefined), null);
eq("supports off, nothing floats", inAirWarning({ islands: 0, overhangs: 0 }), null);
eq(
  "supports off, an island and two overhangs",
  inAirWarning({ islands: 1, overhangs: 2 }),
  "Supports are off. 1 island and 2 overhangs would print in the air. Tick Smart supports to hold them up.",
);
eq("supports off, overhangs only", inAirWarning({ islands: 0, overhangs: 1 }), "Supports are off. 1 overhang would print in the air. Tick Smart supports to hold them up.");

if (failed) throw new Error(`${failed} slice-action checks failed`);
console.log("slice-action: none, cached, changed, force ok");
