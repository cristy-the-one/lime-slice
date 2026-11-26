# Plan: the 7.4.1 cleanup

7.4.0 finished the interaction model, agent ergonomics and the strict default. Three small things were left over and
are all this release does. None changes what a person sees in the window, and none changes a tool's arguments or
replies, apart from one dropped note (C2).

| Card | What | Size |
|---|---|---|
| C1 | The ring-gear e2e race, and the same race in five other specs | small |
| C2 | `slice_start` mentions `scope:"plate"` only when there is another object to slice | small |
| C3 | Every lust-gated test runs with lust in CI, and a check keeps it that way | small |

The three cards touch different files, so they can run side by side. Each is its own PR into `main`. The release
is a patch bump (7.4.1) once all three are on main.

## C1. Wait for the request before reading it

**What failed.** Main's CI on `dd085f38` (the #861 merge) failed in Playwright smoke shard 2 with one test:
`e2e/model-gear.spec.ts:207`, "a ring gear: Ring hides the bore, hub and shift...". The error was
`TypeError: Cannot read properties of undefined (reading 'primitive')` at line 226:

```ts
await apply(page).click();
const sent = tree.of("open").at(-1)!.primitive as Record<string, unknown>;
```

The click returns before the window has sent `open` to the mocked `/api/model/tree`, so `tree.of("open")` can still be
empty. The same code passed on the PR and on the next main run (`66b06511`). That makes it a race in the test, not
in the app.

**The same pattern elsewhere.** A read of `tree.of("<call>").at(-1)` on the line straight after a `click()`:

| Spec | Sites |
|---|---|
| `e2e/model-gear.spec.ts` | 2 |
| `e2e/model-text-skin.spec.ts` | 2 |
| `e2e/model-kernel-gaps.spec.ts` | 1 |
| `e2e/model-text-curves.spec.ts` | 1 |
| `e2e/nurbs-sculpt.spec.ts` | 1 |

**Do.**
- Add one helper to `e2e/model-tree-mock.ts`, for example `sent(call, after)`. It waits with `expect.poll` until
  `of(call)` holds more requests than it held before the click, then returns the newest one. `after` is the count read
  before the click.
- Use it at each site in the table. Read the count before the click, then call the helper after it.
- Search for other reads that follow a click and depend on a request (`tree.calls.at(-1)`, `tree.of(...)[n]`). Fix
  those that are the same race, and list them in the PR body.

**Rule.** Every existing assertion stays, with the same expected values. The change only waits for the request that
the assertion already expects. No timeouts are raised and no retries are added.

**Done when.** `npx playwright test <the five specs> --repeat-each=10 --workers=4` passes, and the PR body gives that
count.

## C2. The plate hint only when there is a plate to slice

**Now.** `slice_start` with no `scope` slices the selected object. Its reply then always carries
`note: 'scope:"plate" slices them all.'` (`sliceIdentity` in `mcp/session/slice.ts`, line ~259). With one object on
the plate, that sentence points at a choice that does not exist.

**Do.**
- Add the note only when the job had others on the plate. The job already records that as `job.others`
  (`this.objects.length > 1`). Change the line to `if (job.scopeOmitted && job.others)`.
- With one object and no `scope`, the reply is the plain `{object, name}` that the code's last branch already gives.
- The `scope: "object"` and `sliced` fields follow the same rule, through the existing `job.others` branch: with
  others on the plate they stay, and one object gives neither.

**Tests.** In `mcp/orient.test.ts`, the check "slice_start without scope names the object and says scope plate slices
them all" (line ~203) states the old behaviour. Change it to expect no `note` with one object, and say so in the PR
body. The two-object check (line ~215) stays as it is. `mcp/slice-scope.test.ts` must still pass unchanged.

**Done when.** `mcp/orient.test.ts`, `mcp/slice-scope.test.ts` and `mcp/schema.test.ts` pass, and first contact is
still within 1500 tokens.

## C3. lust tests run with lust in CI

**Now.** CI installs lust in two jobs: "MCP server" (Linux) and "MCP server against real Open CASCADE". Each runs an
explicit list of tests with `LIME_RECIPE_REQUIRED=1`. The unit chain (`tools/run-unit.mjs`) runs in jobs without
lust, where a lust-gated test prints "lust items skipped" and exits 0. Six lust-gated tests are in no CI list, so
their lust checks have never run in CI:

- `mcp/nothing-silent.test.ts`, which includes the S1 and S1b strict checks. Until now these were verified only on the
  owner's machine.
- `mcp/clock-couple.test.ts`
- `mcp/clock-parts.test.ts`
- `mcp/graham-port.test.ts`
- `mcp/recipe-find.test.ts`
- `mcp/recipe-followups.test.ts`

**Do.**
1. Add the six to the "MCP server" (Linux) job's lust list in `.github/workflows/ci.yml`, each with
   `LIME_RECIPE_REQUIRED=1`. That job needs no OCCT for them, because they use `fakeEngine`. If one needs real
   OCCT, put it in the OCCT job instead and say why in the PR body.
2. `mcp/recipe-find.test.ts` has no `LIME_RECIPE_REQUIRED` switch. Add the same one the others have (skip without
   lust, fail when it is set), so CI fails if lust goes missing.
3. Add `tools/ci/lust-coverage.test.mjs`, modelled on `tools/ci/e2e-coverage.test.mjs`. It fails when a test file
   under `mcp/` or `src/` that reads `LIME_RECIPE_REQUIRED` or calls `findLust` is not run in `ci.yml` with
   `LIME_RECIPE_REQUIRED=1`. Add it to `tools/unit-tests.txt`.
4. Run each of the six locally with lust 0.3.2 (`LIME_LUST` set, `LIME_RECIPE_REQUIRED=1`) before pushing. A test
   that fails there is a real failure that CI had been hiding. Report it in the PR, and fix it in the PR only if the
   fix is in the test. A product fix gets its own card.

**Watch the time.** The "MCP server" job's run time before and after goes in the PR body. If the six add more than
about 3 minutes, say which test is slow.

**Done when.** The PR's "MCP server" log shows each of the six with no "lust items skipped" line, and the coverage test
fails on a branch that removes one of them from `ci.yml`. Check that once by hand and say so.

## Out of scope

- The `//! strict: false` opt-out stays until 7.5.0.
- MCP M4 and M5 are in `docs/plan-mcp-2026-07-28.md`.
- #821 (H1) is not part of this release.

## Release

Once C1–C3 are merged and main's CI is green, 7.4.1 is a patch bump by the release skill. Its notes are short:
"Fixes since v7.4.0", one line for C2 (the only change an MCP client can see), then "Under the hood" for C1 and C3.
