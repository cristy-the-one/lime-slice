import { durationTile, formatCount, formatDuration, formatLength, formatMass, formatMetres, formatMoney, formatMs, formatPercent } from "./format.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

eq("zero seconds", formatDuration(0), "0 s");
eq("under ten seconds keeps a decimal", formatDuration(1.24), "1.2 s");
eq("seconds", formatDuration(42), "42 s");
eq("just under ten seconds does not read 10.0", formatDuration(9.99), "10 s");
eq("just under a minute rounds up into minutes", formatDuration(59.6), "1 min 0 s");
eq("minutes and seconds", formatDuration(334.1), "5 min 34 s");
eq("a long minute count stays in minutes", formatDuration(3599), "59 min 59 s");
eq("an hour", formatDuration(3600), "1 h 0 min");
eq("hours drop the seconds", formatDuration(60371), "16 h 46 min");
eq("minutes round up across the hour", formatDuration(3599.9), "1 h 0 min");
eq("hours carry the rounded minute", formatDuration(7199), "2 h 0 min");
eq("a day", formatDuration(86400), "1 d 0 h");
eq("days and hours", formatDuration(2 * 86400 + 3 * 3600 + 1500), "2 d 3 h");
eq("hours carry into the day", formatDuration(86400 - 20), "1 d 0 h");
eq("negative clamps to zero", formatDuration(-4), "0 s");
eq("not a number", formatDuration(Number.NaN), "—");

eq("tile seconds", durationTile(42), { value: "42", unit: "s" });
eq("tile minutes", durationTile(334.1), { value: "5:34", unit: "min:s" });
eq("tile hours", durationTile(60371), { value: "16:46", unit: "h:min" });
eq("tile minutes pad", durationTile(3600 + 5 * 60), { value: "1:05", unit: "h:min" });
eq("tile days", durationTile(2 * 86400 + 3 * 3600), { value: "2:03", unit: "d:h" });

eq("grams under ten", formatMass(2.589), "2.59 g");
eq("grams under a hundred", formatMass(54.32), "54.3 g");
eq("grams over a hundred", formatMass(136.38), "136.4 g");
eq("grams just under a kilogram", formatMass(999.9), "999.9 g");
eq("rounds up into kilograms", formatMass(999.97), "1.00 kg");
eq("kilograms", formatMass(1240), "1.24 kg");
eq("zero grams", formatMass(0), "0.00 g");

eq("millimetres", formatLength(843.2), "843 mm");
eq("small millimetres keep a decimal", formatLength(4.26), "4.3 mm");
eq("metres", formatLength(54520), "54.5 m");
eq("rounds up into metres", formatLength(999.6), "1.0 m");
eq("kilometres", formatLength(2063215), "2.06 km");
eq("filament metres under ten", formatMetres(868.1), "0.87 m");
eq("filament metres", formatMetres(54520), "54.5 m");
eq("filament metres separate thousands", formatMetres(1234500, "en-US"), "1,234.5 m");

eq("count with separators", formatCount(87113, "en-US"), "87,113");
eq("count with German separators", formatCount(87113, "de-DE"), "87.113");
eq("small count", formatCount(0, "en-US"), "0");
eq("compact count under a thousand", formatCount(871, "en-US", true), "871");
eq("compact count in thousands", formatCount(87113, "en-US", true), "87.1k");
eq("compact count rounds a round thousand", formatCount(12000, "en-US", true), "12k");
eq("compact count in millions", formatCount(2063215, "en-US", true), "2.1M");

eq("percent", formatPercent(23.6), "24%");
eq("percent under half", formatPercent(0.4), "0%");

eq("money in euro", formatMoney(3.409, "en-US"), "€3.41");
eq("money in German", formatMoney(3.409, "de-DE"), "3,41 €");

eq("stage under a hundred ms", formatMs(13.76), "13.8 ms");
eq("stage over a hundred ms", formatMs(432.1), "432 ms");
eq("stage over a second", formatMs(2345), "2345 ms · 2.35 s");
eq("stage not finite", formatMs(Number.POSITIVE_INFINITY), "—");

if (failed) throw new Error(`${failed} format checks failed`);
console.log("format: ok");
