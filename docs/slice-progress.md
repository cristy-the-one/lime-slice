# Slice progress and cancellation

A slice can report where it is, and stop, without changing the G-code. The report is a sink the caller holds. A slice with no sink does the same work it does today.

## Decisions

- The fraction is a fixed budget across stages, not a measured share of time. The budget stays. A client that wants its own weights reweights with `done` and `total`.
- Cancellation is checked at stage and layer boundaries. It does not abort a Clipper call or one layer's toolpaths.
- A cancelled slice returns `cancelled` and is not a result. The disk cache stores a reply only after `slice_request` returns, so a cancel never lands there. A stage the kept shelf stores is a stage that finished; a stage that stopped in the middle is not stored.
- Stages that finished before a cancel stay on the kept shelf. A cancel during the part stage leaves the cut cached, and the next slice reuses it.
- `POST /api/slice` and `POST /api/cancel` stay as they are. Progress is a second way in, `POST /api/jobs`. The cache key is still the request body, so a job and a synchronous slice share an entry.
- A job stays supersedable. A newer `Job::start` slice stales it, because auto-slice relies on that. The per-job cancel is what the UI's Cancel sends.
- Emit ticks once per folded layer, not inside the parallel scan. Since #98, emit takes about 80 ms on a kept slice, so finer ticks would not show.
- Support progress counts the walk: grid demand, or tree growth. Paint is a cancel check at the end of the stage, not a tick.
- Baseline and compare are not stages. The app never requests them.
- An event stream starts from the current state, not from a replay of every event. That is enough for a client that connects late.
- With no sink, and with a sink that is never cancelled, the G-code is byte-identical. `tools/golden_ab.sh` is the check against the previous tree.

## Model

**Watch.** `Watch` is the sink and the cancel flag for one slice. `Watch::idle()` is no allocation. Its checks are a null test, then the existing `Job` test. `Watch::new()` is the one a job holds. Cloning shares that flag. `Watch::finish` publishes the terminal status, and `Status::of` maps a slice result to it. `Watch::latest_after` blocks until the state changes or the slice ends, so a follower reads the newest state without polling.

**Stages.** Reported in pipeline order. `done` and `total` count the units of that stage. `fraction` is the budget up to the previous stage, plus this stage's budget times `done / total`. It never moves backwards. A reused stage is reported as already finished, so the fraction jumps by that stage's budget.

| Stage | What it counts | Budget |
| --- | --- | ---: |
| `load` | The mesh decode, one unit | 0.02 |
| `cut` | Per-layer slice of the mesh | 0.08 |
| `part` | The part's walls, infill, and skin, per layer | 0.42 |
| `travel` | The part's tour, per layer | 0.10 |
| `supports` | The support walk, per layer. Paint is the end of the stage | 0.20 |
| `assemble` | Joining skirt, supports, and the part, per layer | 0.10 |
| `emit` | G-code, per emitted layer | 0.08 |

Layers inside a stage finish on the pool, out of order. The sink keeps the highest fraction it has published, so a late report of an earlier layer does not pull the bar back.

**Cancellation.** `Watch::cancel` sets the flag. The planner also stops when its `Job` is stale, which is what `POST /api/cancel` and a newer `POST /api/slice` already do. A job's own cancel does not stale every other job. The flag is read at the start of a stage and at each layer of the cut, the part, the part tour, the support walk, assembly, and emit. The layer that is already inside a kernel runs to the end. The next layer does not start.

A cancel during emit sets the writer's cancelled bit and `slice_request` returns `cancelled` before a response exists. Baseline and compare, when a CLI or API caller asks for them, watch the same flag and publish nothing, so they cannot pull the fraction backwards.

**Caches.** The disk cache is unchanged: the key is the request with `previewBase` left out, and a reply sent as a patch is stored whole. The kept shelves are unchanged: a stage is inserted only when its function returns. `Job` and the watch are not part of any key.

**Status.** `running` while the slice is in a stage. `done` with fraction 1 when the response is built. `cancelled` when the flag or the job stopped it. `error` when the slice failed for another reason. The fraction stays where it was on `cancelled` and `error`.

## Steps

1. `Watch` and the stage budget. Idle is free. No slice output change.
2. Thread the watch through load, cut, part, travel, supports, assembly, and emit. Checks sit next to the `Job` checks that were already there.
3. `POST /api/jobs`, poll, server-sent events, and per-job cancel. The synchronous routes stay.
4. Tests: monotonic fractions, cancel at each stage, a cancelled slice re-run matches a slice that was never cancelled, and the HTTP routes including the token.
5. The web client follows a job (`src/ui/slice-job.ts`). The desktop app forwards the same watch as `slice-progress` events. Both name the stages from `src/ui/stage-labels.json`.
6. A job holds its result body until the first read, and only the newest body is held.

`mockSliceProgress` is left for busy work with no progress stream, such as the blend comparison.

## Wire

**Start.** `POST /api/jobs` takes the same JSON body as `POST /api/slice`. The response is `202` and `{"id":"1"}`. The slice runs on its own thread. The body is not given a job field, so the cache key does not change.

**Poll.** `GET /api/jobs/1`

```json
{"id":"1","stage":"part","done":40,"total":100,"fraction":0.268,"status":"running"}
```

`status` is `running`, `done`, `cancelled`, or `error`. `done` and `total` are the current stage. `fraction` is the budget above, from 0 to 1.

**Events.** `GET /api/jobs/1/events` is `text/event-stream`. Each event is one `data:` line of the poll object, then a blank line. The first event is the current state. Each later event is the newest state when the stream sends it, so a slow reader skips states but never the end. The stream ends after a terminal status. `EventSource` cannot set `Authorization`; use `?token=` the same way the other routes do.

**Cancel.** `POST /api/jobs/1/cancel` returns `{"ok":true}`. The slice stops at the next boundary. `POST /api/cancel` still stales every `Job::start` slice, including jobs.

**Result.** `GET /api/jobs/1/result` is the same JSON `POST /api/slice` returns, once `status` is `done`. It answers once. The body is released when it is sent, and a second read is `410` and `{"error":"result already read"}`. When a newer job's body replaced this job's body, the read is `410` and `{"error":"result released"}`. `409` and `{"error":"running"}` while it runs. `400` and `{"error":"cancelled"}` or the slice error after it stops. `404` for an unknown id.

The token and CORS rules are the ones on every `/api` route. No token allows the request. A token requires `Authorization: Bearer` or `?token=`. With a token, `Access-Control-Allow-Origin` echoes the page origin and `Authorization` is allowed. Without one, the origin stays `*`.

Jobs are kept in memory, newest first, and the oldest are dropped past eight. Dropping a job does not stop it. All eight keep their progress and status. Only the newest finished body is held, because a reply can be tens of megabytes: about 55 MB for a 311 mm STEP part.

**Desktop.** The Tauri command `slice_model` runs the same watched slice and emits `slice-progress` at most ten times a second:

```json
{"progress":0.268,"message":"Walls and infill","stage":"part","done":40,"total":100,"status":"running"}
```

`progress` is the fraction. `message` is the stage's name from `src/ui/stage-labels.json`, the file the web client uses. The terminal event is always sent, with `status` `done`, `cancelled`, or `error`. The forwarding thread ends before the command returns. `cancel_slice` stales every `Job::start` slice and cancels the current watch.
