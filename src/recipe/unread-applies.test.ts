/**
 * docs/plan-native-recipes.md 7.1: which recipe lines read their apply's reply. A line is claimed (queued silently) only
 * when the shape of the call proves the reply unread; everything else is built in its place, as before.
 */
import { codeOnly, unreadApplyLines } from "./unread-applies.ts";

let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  failed += 1;
  console.error(`FAIL ${name}: ${a} vs ${b}`);
}

const lines = (text: string) => [...unreadApplyLines(text)].sort((a, b) => a - b);

eq("a statement with ?", lines("fn main() {\n    s.apply(&p, op)?;\n}\n"), [2]);
eq("unwrap and expect", lines("fn f() {\n  s.apply(&p, a).unwrap();\n  s.apply(&p, b).expect(\"cut\");\n}\n"), [2, 3]);
eq("a bare statement and let _", lines("fn f() {\n  s.apply(&p, a);\n  let _ = s.apply(&p, b);\n  let _ = s.apply(&p, c)?;\n}\n"), [2, 3, 4]);
eq("is_ok and is_err anywhere", lines("fn f() {\n  if s.apply(&p, a).is_ok() { n += 1; }\n  let bad = s.apply(&p, b).is_err();\n}\n"), [2, 3]);
eq("gears-on-sphere's match binds nothing of Ok", lines("fn ap(s: &mut Session, p: &Part, j: Json) -> bool {\n    match s.apply(p, j) { Ok(_) => true, Err(e) => { s.log(&e.reason); false } }\n}\n"), [2]);
eq("if let Ok(_) and Err(e)", lines("fn f() {\n  if let Ok(_) = s.apply(&p, a) { }\n  if let Err(e) = s.apply(&p, b) { log(e); }\n}\n"), [2, 3]);
eq("a bound reply is read", lines("fn f() {\n  let r = s.apply(&p, a)?;\n  let v = s.apply(&p, b)?.get(\"volumeMm3\");\n}\n"), []);
eq("a match that binds the Ok value is read", lines("fn f() {\n  match s.apply(&p, a) { Ok(r) => use_it(r), Err(_) => {} }\n}\n"), []);
eq("a match on the whole result is read", lines("fn f() {\n  match s.apply(&p, a) { r => keep(r) }\n}\n"), []);
eq("a tail expression is read", lines("fn f(s: &mut Session) -> Result<Json, Refusal> {\n  s.apply(&p, a)\n}\n"), []);
eq("an argument is read", lines("fn f() {\n  keep(s.apply(&p, a)?);\n}\n"), []);
eq("a line with a read apply and an unread one is not claimed", lines("fn f() {\n  s.apply(&p, a)?; let r = s.apply(&p, b)?;\n}\n"), []);
eq("a call over several lines claims both lines", lines("fn f() {\n  s\n    .apply(&p, a)?;\n}\n"), [2, 3]);
eq("a recipe's own fn apply claims nothing", lines("fn apply(x: u32) {}\nfn f() {\n  s.apply(&p, a)?;\n}\n"), []);
eq("comments and strings do not count", lines("fn f() {\n  // s.apply(&p, a)?;\n  let t = \"s.apply(&p, b)?;\";\n  /* s.apply(&p, c); */\n}\n"), []);
eq("apply_later and apply_now are not apply", lines("fn f() {\n  s.apply_later(&p, a)?;\n  s.apply_now(&p, b)?;\n}\n"), []);
eq("blanking keeps lines and columns", codeOnly("a // x\n\"b\" 'c' r#\"d\"#\n").length, "a // x\n\"b\" 'c' r#\"d\"#\n".length);
eq("a lifetime is not a char literal", codeOnly("fn f<'a>(x: &'a str) {}"), "fn f<'a>(x: &'a str) {}");

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("unread-applies: all passed");
