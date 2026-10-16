# Review: MCP server on `feature/mcp-server`

Status: **draft, being refined**. Reviewed head `82cd79c` (one commit on top of `origin/main` `176c7e7`, 36 files, +3831/−10).

## Summary and verdict

Draft verdict: **not ready to merge.** The Prepare/slice/export path is mostly sound. The Model path does not do what the PR says: an applied edit never reaches the plate mesh, so slicing, 3MF export, render, and save all ignore it. More findings follow in the full report.

## Method

In progress. The native build was OOM-killed on this VM on the first attempt and the VM restarted. The final report records what ran.

## Findings

To be filled in.
