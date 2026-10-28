---
name: land-pr
description: Open, watch, and merge a Lime Slice PR the owner's way. Branch from main, trailers, bind and monitor, merge only after every check incl. the smoke shards. Use when opening a PR, on a ci-monitor event, or when a PR is green or merged. Not for release tags or local UI tests.
---

# Land a PR

The owner reviews PRs at milestones, not every small step. Open one when a piece of work is complete and verified, then drive it to merge without being asked.

## Before opening

- Branch from a fresh `origin/main` (`git fetch` first). Name it `claude/<topic>`.
- Stage files by name. Never commit any of these:
  - installer `.exe` files;
  - `pw-*.config.ts`;
  - `UI-OVERHAUL-NOTES.md`;
  - `e2e/zz-*` probe specs;
  - `layout-proposal/`;
  - `ideaformer-*`;
  - company STEP files;
  - a `src-tauri/Cargo.toml` that only changed line endings.
- Commit messages: a plain-sentence subject, a body that says why, and the attribution line the session gives. A subagent stamps its own model in that line; rewrite it to the owner's line before pushing.
- Run the checks for what changed. For UI and e2e, use **verify-ui**. Rust: `cargo clippy -p <crates> --all-targets --locked -- -D warnings` (CI's clippy is `-D warnings` over the whole workspace). Skip the full local `cargo test`; CI runs it.
- A new e2e spec goes into `test:smoke` in `package.json`, or CI never runs it. A new unit test goes into `tools/unit-tests.txt`.

## Open and watch

1. Create it with `gh pr create --base main`. The body comes in this order:
   - what changes for the user;
   - what the maintainer inherits;
   - the tests that ran.

   End it with the session's PR attribution line.
2. Bind it (`ccd_pr bind_pr`) and turn the monitor on (`set_monitor`, `auto_fix: true`). From then on, CI failures and conflicts arrive as ci-monitor events. Don't poll CI yourself.
3. **Auto-merge: the smoke shards first.** Main's ruleset requires only "test, clippy, and Tauri", "release bench smoke", and "typecheck and frontend build". GitHub's auto-merge waits for those three and nothing else. #407 merged with two red smoke shards, and main stayed broken until the next PR fixed it.
   - For a PR that touches UI, e2e, or anything a spec exercises, arm auto-merge (`set_auto_merge`, merge method **merge**) only after `gh pr checks <n>` shows all four smoke shards passing.
   - A CI-only PR can be armed at once.
   - A docs-only PR (only `docs/` and `*.md` files) runs no CI: the `what changed` job skips every other job, and a skipped required check counts as passed. Merge it once the owner approves; there is nothing to wait for.
4. A PR whose checks are all green before you arm it is "clean", and GitHub refuses to arm auto-merge on it. The owner's standing rule is merge-on-green, so merge it yourself: `gh pr merge <n> --merge`, after one more `gh pr checks <n>`.

## When a check fails

Read the log before touching code. `gh run view <run> --log-failed` works only once the whole run has finished.

- **The failure is in "Install Playwright Chromium"** (apt lock or a slow mirror): it's infrastructure, not the PR. Rerun with `gh run rerun <run> --failed`. Since #410 the step falls back to installing the browser without system packages.
- **A test fails:**
  1. Reproduce it locally with **verify-ui**.
  2. Search recent CI runs for the same test name. One failure in 40 runs, with the same code green on the PR's own run, is a flake: rerun it, and say so in the reply.
  3. Anything else is a real failure. Fix it on the PR branch.
- **A conflict with main:** merge `origin/main` into the branch. Don't rebase or force-push. Resolve, re-run the touched checks, commit, and push.
- **The branch is checked out in another worktree:** git refuses to check it out here. Detach that worktree (`git -C <other> checkout --detach`) once it is clean and its branch matches origin.

## After the merge

- Check that main's own CI run on the merge commit is green. A failed job there gets the same triage as above.
- If `dev/stress-sim` or another long-lived branch should follow main, fast-forward it when it is an ancestor; otherwise merge.
- Report to the owner:
  - what landed, in user terms;
  - the checks;
  - anything left over.
