/**
 * --- Split to print, milestone 3b: the export's names and its note (docs/plan-split-connectors.md, D12).
 */
import { encode3mf } from "../mesh-place.ts";
import { crc32 } from "../png-rgba.ts";
import { exportStem, partStem, pieceNames, pinsName, SUPPORT_NOTE } from "./partition-export.ts";
import { pieceFiles } from "../ui/split-export.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const show = (value: unknown) => JSON.stringify(value);

check("pieces are named in assembly order, part 1 first", show(pieceNames("cover", 3)) === show(["cover-1", "cover-2", "cover-3"]), show(pieceNames("cover", 3)));
check("the files are those names with their extension", show(pieceNames("cover", 2).map((name) => `${name}.stl`)) === show(["cover-1.stl", "cover-2.stl"]));
// --- Milestone 5: the pins are one more part, after the last piece, in every format.
check("the pins come last, as <source>-pins", show(pieceNames("bar.step", 3, true)) === show(["bar-1", "bar-2", "bar-3", "bar-pins"]) && pinsName("exports/bar.step") === "bar-pins", show(pieceNames("bar.step", 3, true)));
check("and each format names them", show(pieceFiles("bar", pieceNames("bar", 2, true)).stl) === show(["bar-1.stl", "bar-2.stl", "bar-pins.stl"]), show(pieceFiles("bar", pieceNames("bar", 2, true))));
check("ten pieces and more keep their order", pieceNames("bar", 12).at(9) === "bar-10" && pieceNames("bar", 12).at(11) === "bar-12");
check("a file name drops its folder and its extension", exportStem("exports/Telo cover.step") === "Telo cover" && exportStem("C:\\parts\\cover.3mf") === "cover");
check("characters a file name cannot hold become dashes", exportStem('a:b*c?"d"') === "a-b-c--d-", exportStem('a:b*c?"d"'));
check("an empty name is a part", exportStem("") === "part" && show(pieceNames(".stl", 1)) === show(["part-1"]));
check("a plate object's name drops its extension and keeps its number", partStem("hook.step 2") === "hook 2" && partStem("parts/body.STL") === "body" && partStem("Rim 3") === "Rim 3" && partStem("") === "part", show([partStem("hook.step 2"), partStem("parts/body.STL"), partStem("Rim 3")]));
check("no pieces, no names", pieceNames("cover", 0).length === 0);
check("the support note", SUPPORT_NOTE === "Keep supports off the cut faces. They carry the fit and the part number.");

// One 3MF of the pieces: each object named, and every entry with the CRC-32 a zip reader checks.
const tri = (x: number) => new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0, x, 0, 0, x, 1, 0, x, 0, 1, x, 0, 0, x, 0, 1, x + 1, 0, 0, x + 1, 0, 0, x, 0, 1, x, 1, 0]);
const file = encode3mf([tri(0), tri(5), tri(10)], pieceNames("cover", 3));
const text = new TextDecoder().decode(file);
check("the 3MF names each piece in order", [...text.matchAll(/<object id="(\d)" name="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`).join() === "1:cover-1,2:cover-2,3:cover-3", text.slice(0, 300));
const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
let at = 0;
let entries = 0;
let crcs = true;
while (view.getUint32(at, true) === 0x04034b50) {
  const size = view.getUint32(at + 18, true);
  const nameLength = view.getUint16(at + 26, true);
  const data = file.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
  if (view.getUint32(at + 14, true) !== crc32(data) || view.getUint16(at + 4, true) !== 20) crcs = false;
  entries += 1;
  at += 30 + nameLength + size;
}
check("every entry carries its CRC-32 and reads as zip 2.0", entries === 3 && crcs, `${entries} entries`);
const central = view.getUint32(file.byteLength - 22 + 16, true);
check("the central directory agrees", view.getUint32(central, true) === 0x02014b50 && view.getUint32(central + 16, true) === crc32(file.subarray(30 + view.getUint16(26, true), 30 + view.getUint16(26, true) + view.getUint32(18, true))));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("partition export: ok");
