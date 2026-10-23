---
name: release
description: Bump the Lime Slice version, open the bump PR, tag the release once it is on main, and attach release notes to the draft that release.yml builds. Use whenever the owner says "bump the version", "release", "tag vX.Y.Z", "push the tag", "make the installers", or asks for release notes for a version. Not for landing an ordinary feature PR (that is land-pr) and never for publishing a release; the owner publishes.
---

# Release: bump, tag, notes

A release is three steps, each gated on the one before. The owner decides when each happens. "Bump" alone means step 1. "Tag" means step 2, once step 1 is on main. Never publish the draft; the owner does that on GitHub.

## 1. Bump

Pick the number from what landed since the last tag:
- a minor bump (3.6.0 → 3.7.0) when any user-facing feature landed;
- a patch bump for fixes only.

`git log --oneline vLAST..origin/main` shows what landed.

Branch `claude/version-X-Y-Z` from `origin/main`, then change every place the version lives:

| File | Where |
|---|---|
| `package.json` | `"version"`, line 4 |
| `package-lock.json` | `"version"` at the root (line 3) and in `packages[""]` (line 9) |
| `src-tauri/tauri.conf.json` | `"version"`, line 4 |
| `Cargo.toml` | `[workspace.package] version`. Every crate uses `version.workspace = true`. |
| `README.md` | line 3 ("Lime Slice X.Y.Z is…"), the release-workflow sentence "(X.Y.Z)", and "Draft releases through vLAST" |

Then:
- `CARGO_BUILD_JOBS=4 cargo update -w --offline`. Every workspace crate must move, including `lime-sim` and `lime-sim-bridge`. On 3.6.0 the lock kept those two at the old version, and every `--locked` CI job failed.
- Check it: `cargo metadata --format-version 1 --locked --offline > /dev/null`.
- `git grep -n 'OLD.VERSION' -- ':!docs/plan-*'` should show only historical mentions.
- Leave `src-tauri/Cargo.toml` alone if it shows only a line-ending change: `git checkout -- src-tauri/Cargo.toml`.

Commit "Bump the app to X.Y.Z". Open a PR titled "Lime Slice X.Y.Z". Its body lists the PRs since the last tag, one line each in user terms. Then land it with the **land-pr** skill.

## 2. Tag, once the bump PR is on main and the owner asked for it

1. Wait until **every** check on the bump PR has passed, smoke shards included. Merging does not wait for them, because main requires only three checks.
2. Read the merge commit's versions: `git show <sha>:package.json`, `src-tauri/tauri.conf.json`, and `Cargo.toml` must all say X.Y.Z. Also confirm `git ls-remote --tags origin vX.Y.Z` is empty.
3. `git tag -a vX.Y.Z <merge-sha> -m "lime-slice X.Y.Z"`, then `git push origin vX.Y.Z`. Annotated, on the merge commit, never on a branch tip.
4. The push starts `release.yml`. Find the run with `gh run list --workflow release.yml`, and watch it in the background with `gh run watch <id> --exit-status`; don't poll by hand.
5. When it succeeds, check that the draft has all five assets: `gh release view vX.Y.Z --json isDraft,assets`. They are the Windows `x64-setup.exe`, both macOS `.dmg` (aarch64 and x64), the `.AppImage`, and the `.deb`.

## 3. Notes

Notes live in `~/.lime-slice/polish-3.0/release-X.Y.Z.md`, outside the repo. Write them while the tag builds:
- the first line is "What changed since vLAST:" and one sentence;
- then one `###` section per user-facing change, named with its PR, in short bullets;
- a final "Under the hood" section for CI and tooling.

Write for the person installing it: what they will notice, not how it is built. Attach them with `gh release edit vX.Y.Z --notes-file <file>`. The release stays a draft.

## After

Record the release in the project memory's release history: the version, the bump PR, the merge sha, the tag, the run id, and "notes attached; owner publishes".
