import { diameterExpr, radiusExpr } from "./diameter-expr.ts";

let failed = 0;

function eq(name: string, actual: string, expected: string): void {
  if (actual === expected) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

eq("a name typed as a diameter is half of it", radiusExpr("bore"), "(bore) / 2");
eq("and shows as typed", diameterExpr(radiusExpr("bore")), "bore");
eq("an older radius expression shows doubled", diameterExpr("r"), "(r) * 2");
eq("and is stored as it was", radiusExpr(diameterExpr("r")), "r");
eq("a wrapped sum round-trips", diameterExpr(radiusExpr("(d + 1)")), "(d + 1)");
eq("an older (d) / 2 shows as d", diameterExpr("(d) / 2"), "d");
eq("two terms ending in * 2 are wrapped, not cut", radiusExpr("(a) + (b) * 2"), "((a) + (b) * 2) / 2");
eq("two terms ending in / 2 are wrapped, not cut", diameterExpr("(a) - (b) / 2"), "((a) - (b) / 2) * 2");
eq("and both come back whole", diameterExpr(radiusExpr("(a) + (b) * 2")), "(a) + (b) * 2");

if (failed > 0) {
  console.error(`${failed} diameter expression check(s) failed`);
  process.exit(1);
}
console.log("diameter-expr: ok");
