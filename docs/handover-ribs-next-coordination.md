# Handover: coordinating `feature/ribs-next`

Written 2026-11-19 by the Claude (Opus) session that has coordinated this work since 2026-11-17. It is for the next coordinator and its executors. Read `docs/handover-auto-ribs-next.md` first: it holds the six packages (A–F), the rules (§2), the brief format (§6) and the owner's decisions (§7). This document covers what has been done since, what is in flight, what is left, and how the coordination has run in practice.

## 1. The roles

- **Coordinator** (a Claude session). It writes briefs, reviews PRs against them, merges package PRs into `feature/ribs-next`, merges `main` into the feature branch, and brings decisions to the owner. It writes no feature code. Its only commits have been CI wiring, conflict merges, and one bug fix cherry-picked to main.
- **Executors** (Grok agents in cloud sessions). Each works on one brief at a time, on its own branch, and opens a PR into `feature/ribs-next`. Three were running at handover: "A" (A1 session), "C" (C-STUDY session), and an "E2" session.
- **The owner** relays every message both ways. Write briefs and replies as copyable `text` blocks, one block per recipient.

## 2. Rules (in force, from the handover and the owner)

- Nothing goes from this work to `main` directly. The feature branch goes to main as one reviewed PR at the end. The one exception so far was a bug fix in released code (#753), and the owner chose it.
- No version bump, tag or release. The owner tags and publishes.
- Defaults that change what an existing feature does are the owner's decision. So are the wording of new goals, bundling a third-party solver (CalculiX: dev-machine cross-check only), and anything with company part data. Company data never enters the repo; all test geometry is synthetic.
- Never loosen a test. If an executor changes an expected value, the PR names the old and new value and why, and the coordinator checks the reason (see §7).
- UI tests: headless Chromium only, never Edge or Chrome. New e2e specs go into `test:smoke` in `package.json`; new unit tests into `tools/unit-tests.txt`.
- Rust: `CARGO_BUILD_JOBS=4`, targeted `cargo test -p <crate>`. No workspace-wide `cargo test` (CI runs it).
- Never edit the owner's MCP config.

## 3. Branch and CI mechanics

- `feature/ribs-next` was cut at `edb706b2` (the v6.11.0 tag commit). Package branches are `ribs-next/<name>`, with PRs into the feature branch, merged with `gh pr merge <n> --merge` (merge commits, no squash).
- CI: `.github/workflows/ci.yml` on the feature branch has `pull_request: branches: [main, feature/ribs-next]` (commit `8486f501`). Pushes to the feature branch itself get no CI, so even the coordinator's own merges (main into the branch) go through a PR.
- **Merge main into the feature branch at least weekly.** It was last done 2026-11-19 (#755). The only conflict so far is the `test:smoke` list in `package.json`: resolve it as the union of both sides' specs.
- **Open CASCADE jobs** have a 25-minute limit (1500 s):
  - "MCP server against real Open CASCADE" (shared) was at about 1177 s on 2026-11-19, so keep new tests out of it.
  - "Folded shell against real Open CASCADE" runs `folded-shell-occt`, `draft-occt` (after #761) and `moulding-occt`. It was about 480 s before the last two were added. Put new OCCT tests here, or in a job of their own.
- **Known flakes** (re-run with `gh run rerun <run> --failed`; check first that the PR doesn't touch the area):
  - `e2e/model-gear.spec.ts` "a rack";
  - `e2e/xy-comp.spec.ts` (the slice form rebuilds under the test; the same race was fixed in `min-layer-time` by waiting for `#slice` to be enabled);
  - "OCCT dynamic link (Windows)" heap corruption in the brep test;
  - "Rust tests" stalling in `apt-get update` for GTK/WebKitGTK until the 40-minute limit;
  - "MCP server (macOS)" cancelled.
- A local coordinator worktree has been at `D:\projects\lime-slice-ribs-next`. Git Bash's path conversion breaks `git show <ref>:.github/...`, so use a worktree or `MSYS_NO_PATHCONV=1`.

## 4. What is done

Merged into `feature/ribs-next`, oldest first:

| PR | Package | What | Merge commit |
|---|---|---|---|
| #743 | A1 | Planner objective Σ wᵢ·Cᵢ/Cᵢ⁰ (normalized, weighted), a per-case report; one case identical to v6.11.0 (snapshots `one_case_*_v6110.txt`) | a1932562 |
| #744 | C study | `docs/plan-folded-shell.md`: option 1, the folded shell; ribs cross creases | afb1d51d |
| #745 | A1b | Worst-case mode as a p-norm (p = 8), crate only | 6c24518d |
| #746 | C1 | Traces unfold across creases over 20°; rib feet on faces; miter web axis | 9f42406e |
| #748 | A2 | `ribs_plan` `loadCases` (≤ 8, named, weighted); bridge and `rib-wall.ts`; worst mode not exposed (it lost to weighted) | 52cafe93 |
| #750 | A3 | Load cases in the Auto ribs panel; per-case factors; per-case Stress check; a `readLoads` fix (stored load places) | 5eb46437 |
| #751 | C2 | Folded extraction behind `wall.folded` (default off), "Include side walls (folded)" checkbox, stiff patches, consistent normals | c031a4b9 |
| #755 | — | main merged into the feature branch | d7f4be06 |
| #757 | B study | `docs/plan-shell-modes.md`: frequencies and buckling are feasible; vibration first | 4cb9d961 |
| #756 | A3b | `ribs_plan` builds its load request through the panel's `loadRequest`; the refusals (weight ≤ 0, > 8 cases) stay in the tool | 54b096b0 |
| #758 | D study | `docs/plan-rib-thicken-blend.md`: build neither the cell model nor a thicken move | 894fa138 |
| #759 | D1 | Real folded cover and box against the baselines: ribs win (the grid needs 2.1×, thickening 4.4–4.9× the rib material) | 5f869e86 |
| #760 | E1 | Moulding report on moulded plans (`src/modeling/moulding.ts`, `plan.moulding`, panel list) | 4ef7fd0d |
| #761 | E2 | `draft` Model step on existing faces (kernel, MCP op, face menu, History) | c24dbf1f |

`feature/ribs-next` head at handover: **c24dbf1f**.

Also on `main`: #753, the `readLoads` fix (`02989e0f`). In v6.11.0, `ribs_apply verify:true` with a region-placed load checked the wrong place.

**Package status:** A done; C done (folded-as-default pending, §6); D done (no build); E1 and E2 done; B, E1b, E3 and F remain.

## 5. In flight at handover

| Executor | Branch | Brief | State |
|---|---|---|---|
| E2 session | — | — | Free. #761 merged at `c24dbf1f` (after the coordinator's conflict merge `ef62961d`, the union of `ci.yml` and the smoke list). Next: E1b (Appendix C). |
| A | `ribs-next/b-vibration` | B1a, Appendix A | Started from `4ef7fd0d`. Crate-only vibration build. |
| C | `ribs-next/e-vents` | E3, Appendix B | Started from `4ef7fd0d`. Resin vent notches. |

Review notes for #761, already settled:
- The executor replaced the brief's "frustum" volume with the integral ∫(40−2zt)(30−2zt)dz. That is correct: the brief was wrong, since a rectangle drafted on all sides is not a similar-section frustum.
- The fillet-adjacent refusal asserts only that a message exists. OCCT fails at Build there and cannot name a face. Refusal by index is asserted in `mcp/draft-occt.test.ts` for the cases it can name.

## 6. What is left

In order, with who is meant to take it:

1. **E1b: size the moulded default at its base.** The owner decided this on 2026-11-19. It goes to the E2 executor from `c24dbf1f`. Not yet sent; the brief is Appendix C.
2. **E3** (C, in flight). Review it against Appendix B. Check in particular:
   - which side of a pocket cups, and the vent size, both verified from Formlabs by the executor, not taken from the handover;
   - that the reported stiffness includes the notches;
   - that filament and moulded replies are byte-identical.
3. **B1a** (A, in flight). Review it against Appendix A. Check:
   - the textbook convergence tables;
   - the basis-independent score for repeated modes;
   - frequency ribs beating compliance ribs in frequency under the point load;
   - stiffness plans byte-identical.
4. **B1b: vibration in the tool and panel.** Brief it once B1a's numbers are in:
   - `ribs_plan` `goal: {kind: "frequency", factor}`; Hz before and after in the reply; the stiffness factor beside it for information;
   - a frequency goal with a budget or other goal is refused (one goal per plan);
   - loads are ignored under a frequency goal, and the reply's notes say so;
   - a missing material density is refused;
   - in the panel, a "Stiffer / Higher frequency" choice, with the slider meaning ×N of the chosen quantity; one-goal panels unchanged;
   - guide text; e2e and MCP tests.
5. **B2: buckling.** It needs the owner's wording first (proposed: "buckling load factor above N on load case X"; `on` must name a case). Build it on B1's operator with S = −Kg (plate Kg only; membrane Kg is dead weight per the study; beam Kg can wait).
6. **F: rib planners as plugins.** Study first (handover §4 F), then likely one build. Start the study once B1b has settled the tool surface.
7. **Close-out:**
   - **Folded as the default.** The owner chose "opt-in now, default later, with a checkbox". The switch is its own reviewed change, when the package goes to main. #759's numbers support it: on the real folded parts the ribs beat both baselines.
   - A final review of `feature/ribs-next` as a whole, a last main merge, then one PR to main. The owner merges, tags and publishes.

## 7. Owner decisions on record

- 2026-11-17: the coordinator role; executors leave first-team `claude/*` PRs alone.
- 2026-11-18: CI on PRs into the feature branch: yes. Folded: opt-in now (`wall.folded`, panel checkbox, default off), default later as its own change.
- 2026-11-19:
  - The `readLoads` fix goes to main as its own PR (#753, merged).
  - The vibration goal is a ratio ("raise the lowest frequency ×N"), with Hz before and after shown, and one goal per plan (stiffness or frequency, not both).
  - The moulded default rib is sized at its base: 0.6 × wall where the flanks meet the wall.
- Open: the buckling goal's wording; when folded becomes the default; when the feature branch goes to main.

## 8. How review has gone: what to check every time

These were all caught in review here, and each is worth a standing check:

- **Numbers that come from a stand-in.** #750's per-case factors on the synthetic box came from a made-up formula in `fakePlanSource`, presented as plan numbers. Ask where every reported number is computed.
- **"Shares one builder"** claims. Check that both paths actually call it (#750 → #756).
- **A test that passes for the wrong reason.** In #750's verify test the point load missed the floor (deflection 0.0006 mm), so "stiffer for each case" was nearly free. Chasing it found a real bug (`readLoads` dropping places). Sanity-check magnitudes, not just pass/fail.
- **An expected value changed in a fix-up commit.** Read it. Sometimes the brief was wrong (#761's frustum); sometimes it is a loosening (#761's refusal message: justified by OCCT's behaviour, so accepted).
- **CI budget.** Every new OCCT test reports its seconds and the job's total. #751 brought the shared job to 1344/1500 before its test was moved out.
- **The coordinator's own brief can be wrong.** E1's rule 1 counted the root fillets as rib thickness, and the default then looked twice the limit when it was 3–9% over. When a result looks extreme, check the rule before the code.
- **Hand-built stand-ins.** D's coarse folded box showed the grid beating the ribs. The real extracted parts (#759) showed the opposite. Confirm on the real path before acting on a stand-in.

## 9. Pointers

- Plans: `docs/plan-auto-ribs.md`, `docs/handover-auto-ribs-next.md`, `docs/plan-folded-shell.md`, `docs/plan-shell-modes.md`, `docs/plan-rib-thicken-blend.md`.
- Probe branches, never to be merged: `ribs-next/c-probe`, `ribs-next/b-probe` (3b5680ab), `ribs-next/d-probe` (5ba6b209).
- Key code:
  - solver and planner: `crates/lime-sim/src/shell/` (`planner/select.rs` Mix and score, `planner/mod.rs` Goal, `model.rs` creases and folds);
  - wall extraction: `src/modeling/rib-wall.ts`;
  - tool: `mcp/session/ribs.ts`;
  - panel: `src/ui/auto-ribs-card.ts`, `src/auto-ribs.ts` (`loadRequest`);
  - moulding: `src/modeling/moulding.ts`.
- Tests that guard one-case identity: `crates/lime-sim/tests/rib_multi_load.rs` with `one_case_v6110.txt`, `one_case_budget_v6110.txt` and `one_case_curved_v6110.txt`.

---

## Appendix A: brief B1a (sent to A, in flight)

```text
BRIEF B1a: Natural frequency in the shell solver, and a planner goal to raise it

GOAL
The rib planner can plan for "raise the lowest natural frequency ×N" instead of stiffness: crate only, no tool or panel yet (that's B1b). Done when a frequency plan on a clamped panel reaches its ratio, its Hz is right against the textbook plates, and every existing stiffness plan is byte-for-byte unchanged.

OWNER DECISIONS (fixed, don't revisit)
- The goal is a ratio: "lowest frequency ×N", with Hz before and after in the result.
- One goal per plan: stiffness OR frequency. No mixing, no frequency constraint on a stiffness plan.
- No new defaults: a request without the frequency goal plans exactly as today.

BRANCH
ribs-next/b-vibration from origin/feature/ribs-next at its head when you start. PR into feature/ribs-next.

READ FIRST
docs/plan-shell-modes.md (the B study) all of it; its build order is the spec. Probe code: ribs-next/b-probe at 3b5680ab (crates/lime-sim/tests/shell_modes_probe.rs). Lift what works, rewrite as production code; don't merge that branch.
crates/lime-sim/src/shell/: model.rs (assembly, dofs), sparse.rs (the LDLᵀ factor), plate.rs, membrane.rs, beam.rs (ψ and the rib offset map).
crates/lime-sim/src/shell/planner/: mod.rs (Goal ~line 195, the stop test ~924, Outcome/RibPlan), select.rs (first-order estimate, shortlist of 8 re-solved, Mix), field.rs (the direction field the rib candidates are traced along), baseline.rs.
crates/lime-sim/tests/rib_multi_load.rs and the one_case_*_v6110.txt snapshots: the identity guard.

TASKS (one commit each)
1. Mass and modes, in lime-sim::shell:
   - Consistent translational mass (linear triangle, ρt) on ux, uy, uz; no mass on the drilling dof; the rib's translational mass through the same offset map as its stiffness; no extra ψ inertia (study §1).
   - Lowest k modes with faer 0.24.4 matrix_free::eigen::partial_eigen on K⁻¹M, reusing the static LDLᵀ (study §3). Not partial_self_adjoint_eigen (study explains why).
   - Density from the material card the planner already uses. If a card has no density, refuse the frequency goal by name; don't invent one.
2. The score (study §4–5): rise in the lowest frequency per volume. For a near-repeated cluster (eigenvalues within a tolerance you justify, e.g. 2%), score by the lower eigenvalue of the projected cluster matrix, never a single vector or the sum. The shortlist re-solves exactly, as today.
3. The candidate field: a frequency plan traces rib candidates from the lowest mode shape(s)' curvature, not from a static load. Holds still apply; loads are ignored for the goal (say so in the result's notes). Show the difference on the study's point-load panel.
4. Goal::Frequency { factor } (ratio of lowest ω, ribbed over bare). Result adds: frequency_hz { bare, ribbed }, frequency_factor, and the stiffness factor beside it for information (one extra static solve is fine). One goal only: a Frequency request with a budget refuses, the same way other conflicting goals are refused today (check how mod.rs does it).

TESTS
- Textbook plates in lime-sim tests (not the probe file): simply supported rectangle first 4 modes and clamped square λ₁ = 35.99 (Leissa), each within 2% at the finest of three meshes, convergence printed. Square-plate repeated pair: the cluster score is basis-independent (rotate the returned vectors, same score to 1e-9).
- Frequency plan on the clamped 120 × 70 × 2 panel at the planner's pitch: reaches ×1.3 (and report the most it reaches); against equal-volume compliance ribs, under the study's point load: frequency ribs give the higher frequency (the study had +41.7% vs +3.8%). Report both factors for both plans.
- Rib mass on: the reported Hz includes the ribs' mass (study: under 1% effect; report it).
- Identity: every one_case_*_v6110 snapshot and rib_multi_load passes untouched; a stiffness request's RibPlan JSON is byte-identical to before (add a test that compares it).
- Timing: frequency plan time vs stiffness plan time on the same panel; eigen solve vs static solve. Report, don't assert.
Never loosen a tolerance.

OUT OF SCOPE
Buckling (B2, later, owner wording pending). lime-sim-bridge, mcp/, src/ (that's B1b). Mixed goals. Any change to stiffness planning.

COMMANDS
CARGO_BUILD_JOBS=4; cargo test -p lime-sim --release; cargo clippy -p lime-sim --all-targets --locked -- -D warnings. No workspace-wide cargo test.

REPORT
Each task in a line; the convergence tables; the point-load comparison (Hz, frequency factor, stiffness factor, volume for both plans); repeated-pair test result; timings; identity results; what was not done; commit and PR.
```

## Appendix B: brief E3 (sent to C, in flight)

```text
BRIEF E3: Vent notches for resin, so ribs don't seal pockets

GOAL
With process "resin", a ribs plan finds every pocket the ribs close off on the wall (cells bounded all round by ribs and borders) that can trap resin during the print, and opens each with a vent notch through one of its ribs. The reported stiffness is the stiffness of the notched ribs. The result lists each pocket and its vent. Filament and moulded plans are unchanged.

BRANCH
ribs-next/e-vents, from origin/feature/ribs-next at 4ef7fd0d (#760 merged). PR into feature/ribs-next.

READ FIRST
docs/handover-auto-ribs-next.md §4 E3, §6.
docs/plan-auto-ribs.md: the process table (~line 51–56, the cupping row and the Formlabs links) and §"Resin" (~203).
Formlabs, "Cupping and blowout" (linked in the plan), and the Form 4 design specifications. Read them yourself. Write down which side of a pocket has to face which way to cup in a bottom-up resin printer, and the minimum vent size they give. The handover quotes 0.75 mm for a drain hole; check it. Don't rely on this brief or the handover for either.
crates/lime-sim/src/shell/planner/: mod.rs (RibPlan, the final clean solve), loose.rs (how rib ends that meet ribs/borders are known), surface.rs, trace.rs.
src/modeling/moulding.ts (#760): the pattern for a process report as one pure function.
mcp/schema.ts ribNet (~line 692): runs are paths; a gap is two runs. Note taper (a loose end comes down over its length; 0 is square).

DESIGN (probe first, then pick; say which and why)
- Pockets: the faces of the rib network drawn on the wall (ribs + wall borders + holes), on the surface, not a projection. A cell is closed when every edge of its boundary is a rib or a border that rises (a side wall stands there). A cell with a loose rib end or an open border drains already.
- Which closed cells cup: by the build direction. The request may give it (buildAxis); default the part as it sits on the plate, +Z up. If the plate has no resin printer, still use +Z and say so in notes.
- The vent: one notch per cupping pocket, on its boundary rib at the point lowest along the drain direction. Two options to compare: (a) a gap in the rib run, full height; (b) a "mouse hole" at the root, the vent's size high, the rib top continuous. Measure what each costs in stiffness on the test panel. Prefer (b) if the kernel builds it as part of the ribNet row; else (a).
- Size: a named constant from the Formlabs figure you verified, at least that, rounded up to the printer's XY pixel if the printer record has one. Not a new user default: report it.
- Stiffness: the plan's final clean solve includes the notches (a gap is two ribs; a mouse hole is a reduced section over its length). Report the factor before and after venting.
- Where the code lives: in the planner (crate) if the solve must see it, which it must; the pocket finder can be a pure function either side. Say which.

TESTS
- A clamped panel planned as resin with a crossed grid of ribs that closes N cells: N pockets found, N vents, the notched ribNet builds (OCCT), and each former pocket now drains (re-run the finder on the built ribs: 0 cupping pockets).
- Orientation: the same panel turned over cups nothing (or everything): the build direction decides, per the Formlabs rule you cite.
- A cell with a loose rib end, and a cell open to the part's edge: not pockets.
- Stiffness: factor before and after venting on that panel; the loss from (a) vs (b).
- Filament and moulded on the same request: the reply has no vents key and is byte-identical to before.
- Unit tests for the pocket finder on hand-built graphs (a square, a square with a gap, two squares sharing a rib, a cell bordered by a hole), in tools/unit-tests.txt.
- Panel: with Resin, the result lists "N pockets vented" (nothing when 0); e2e test in headless Chromium, added to test:smoke.
Never loosen a test.

OUT OF SCOPE
Moulding checks (E1), draft (E2). Hollowing or drain holes in the part itself; only ribs get notches. Any change to filament or moulded plans. A resin printer model in the machine library.

COMMANDS
CARGO_BUILD_JOBS=4; cargo test -p lime-sim --release; clippy on lime-sim; the unit chain, tsc and build; the auto-ribs e2e specs in headless Chromium; the MCP OCCT test (put it in the folded-shell job or its own, not the shared one at 1177 s of 1500). No workspace-wide cargo test.

REPORT
The Formlabs rule and size you verified, with the quote's source; the design choices and why; each test with numbers (pockets, vents, factor before/after, (a) vs (b)); screenshots (pockets marked, the vented ribs built); CI times; what wasn't done; commit and PR.
```

## Appendix C: brief E1b (not yet sent; to the E2 executor, from c24dbf1f)

```text
BRIEF E1b: Size the moulded default rib at its base (owner decision)

GOAL
The moulded default rib is 0.6 × the local wall thickness where its flanks meet the wall (the base, without fillets), instead of 0.6 × at half height. The default now passes its own moulding rule 1. Only moulded changes; filament and resin are untouched.

BRANCH
ribs-next/e-moulded-base, from origin/feature/ribs-next at c24dbf1f (#761 merged). PR into feature/ribs-next.

READ FIRST
#760: src/modeling/moulding.ts and its default table (base 0.62–0.65 × wall today, radius 0.27–0.29, junction 1.22–1.24).
src/modeling/auto-ribs.ts: ribRules (moulded share 0.6) and chooseSection.
crates/lime-sim/src/shell/planner/profile.rs: default_drafted (width at half height, DRAFT_DEG, root half the top), Process::Moulded; rib_section.rs if the planner sizes by width.
mcp/schema.ts and mcp/guides.ts: wherever the moulded default is described ("moulded 0.6 × the wall's median thickness").

TASKS
1. Moulded only: the default width is set so the base is 0.6 × wall. Keep the 1° draft. Keep the root radius as half the top width unless that falls outside 0.25–0.5 × wall; if it does, say so and stop. Don't pick a new radius rule yourself.
   The planner and the panel must agree on the width (one rule, in one place per language; the crate test and the TS test prove they match).
2. Words: the schema, guide and panel text say "0.6 × the wall at the rib's base" for moulded.
3. A typed width stays the user's: only the default changes.

TESTS
- The default table again (walls 2 and 3 mm, heights 1×/2×/3×): base/wall = 0.600 (to 1e-6), radius/wall, junction/wall. Rule 1 passes. Report the junction honestly. If it still flags against 1.2, don't change anything to make it pass; report the number.
- Moulded plans on the existing test panels: report the new widths, volume and stiffness factor against before. Update any moulded expected values on purpose, each named in the PR with old → new and why.
- Filament and resin: every existing test and snapshot passes untouched (one_case_*_v6110 included), and a filament and a resin plan reply are byte-identical to before.
- The moulding OCCT test: a moulded default plan now reports rule 1 passing.
Never loosen a test.

OUT OF SCOPE
Resin's 0.8 × default, the draft angle, the radius rule, the 1.2 junction limit, E3.

COMMANDS
CARGO_BUILD_JOBS=4; cargo test -p lime-sim --release; clippy on lime-sim; the unit chain; tsc and build; auto-ribs e2e in headless Chromium; CI for the OCCT job. No workspace-wide cargo test.

REPORT
The new table; old → new for each changed moulded expectation; filament/resin identity; what wasn't done; commit and PR.
```

If E1b's junction still reads over 1.2 at the new size, that is a small follow-up decision for the owner: a smaller root fillet, or a looser junction limit.
