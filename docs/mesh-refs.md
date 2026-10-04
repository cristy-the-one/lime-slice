# Mesh references

A slice request sends its mesh once per engine session. Later requests name the mesh by id instead of sending the bytes again. A move or a setting tweak then uploads about 2 KB of JSON instead of the whole mesh as Base64.

## Contract

### Request

A mesh travels in one of two fields, on the request for one object or on each entry of `objects` for a plate:

- `dataB64`: the bytes in Base64. Every client can send this, and old clients keep working.
- `meshRef`: the id a reply gave those bytes.

A request that sends both for the same mesh is refused. `filename` and `stepToleranceMm` are still sent with either field. They are parse options, and the engine applies them to the bytes on every request.

### Reply

Every reply names the meshes it read:

- `meshId` for the request's own mesh;
- `meshIds` for a plate, as an object from object id to mesh id.

The id is the SHA-256 of the mesh bytes, in hex. Clients treat it as opaque.

### Unknown references

The engine holds meshes in memory only. After a restart, or after it evicted a mesh, a `meshRef` names nothing. The engine then refuses the request with a distinct error:

- `serve` answers HTTP 409 on `POST /api/slice`, and on `GET /api/jobs/{id}/result` for a job.
- The desktop `slice_model` command fails with the same JSON body as its error string.

```json
{ "error": "meshRef 3f… is not held by this engine; send dataB64 instead", "code": "unknownMeshRef", "meshRefs": ["3f…"] }
```

The client forgets every id it holds and sends the same request once more with `dataB64`. Other errors keep their old form: HTTP 400 with `{ "error": … }`, or the plain message on the desktop.

## Engine

`lime_slice_core::slice_payload` is the one boundary that `serve`, its jobs, and the desktop app share, so the store and the references live in `lime-slice-core` (`meshes.rs`).

1. Before anything reads the request, `meshes::intern` decodes each `dataB64`, holds the bytes under their id, and writes `meshRef` in place of `dataB64`. It checks that every `meshRef` the request names is held.
2. The disk-cache key is then computed from that rewritten request. A `dataB64` request and a `meshRef` request for the same bytes have one key and share entries.
3. Loading reads the held bytes by id and parses them with the request's `filename` and `stepToleranceMm`. The kept stage keys hash the parsed, posed triangles, and `previewToken` is built from those keys. Neither sees how the mesh arrived.

The store keeps bytes, not parsed meshes. The id therefore covers the bytes alone, and a STEP file sent once can be read at any tolerance. Parsing the Baby Dragon's STL, 475,270 triangles, takes about 6 ms, so a parsed-mesh cache would not pay for itself.

The store is bounded at 512 MB (`HELD_BYTES`) and drops the least recently used meshes first. It never drops the newest mesh, even when that mesh alone is over the bound. It also never drops a mesh that a request in flight still reads. Without that rule, a large upload could evict a mesh another request had already checked.

`warm_kept` after a disk-cache load plans in the background. It does not keep its mesh held. If that mesh is evicted before the plan starts, the warm-up fails quietly, as any warm-up may.

## Client

`src/mesh-refs.ts` keeps the ids by the mesh bytes' fingerprint, the same fingerprint the recipe key uses. Changed bytes have another fingerprint and are sent again. `recipeKey` and `partFrameKey` skip `dataB64` and `meshRef` and use the fingerprint, so a recipe is the same however its mesh is sent.

The `/api/slice` fallback, used when an engine has no job routes, always sends the bytes. Such an engine predates references and never names a mesh.

## Filament price and density

The slice request does not send the profile's `filamentDensityGCm3` or `filamentCostPerKg`. Neither changes a toolpath. The UI computes grams from the reply's `filamentMm`, per feature and in total, and cost from the grams:

```
grams = filamentMm × π (filamentDiameter / 2)² × density / 1000
```

Editing either field after a slice therefore shows the new grams and cost at once, keeps Export enabled, and sends no request.

The engine prints one density-dependent line, the G-code footer's `; TIME:… FILAMENT_MM:… FILAMENT_G:…`, at its default 1.24 g/cm³. The UI writes the profile's grams into that line when it exports or uploads the G-code (`withFooterGrams` in `src/estimate.ts`), with the same formula and three decimals. CLI output does not change.

## Measured

Measured on 2026-10-04 through `serve --cache-dir`, from a Python client on the same machine, with the release build. A move shifts the part 25 mm in X. A tweak changes the nozzle temperature by 5 °C. Each figure is the median of three, after one cold slice. "Before" is 27ef8ea, which sends `dataB64` on every request.

| Mesh | Step | Request before | Request after | Wall before | Wall after |
|---|---|---|---|---|---|
| Baby Dragon, 475,270 triangles | move | 31.7 MB | 1.2 KB | 195 ms | 107 ms |
| Baby Dragon | tweak | 31.7 MB | 1.2 KB | 190 ms | 97 ms |
| Rear cover, STEP at 0.1 mm | move | 0.36 MB | 1.2 KB | 86 ms | 86 ms |
| Rear cover | tweak | 0.36 MB | 1.2 KB | 63 ms | 63 ms |

The engine's own time (`coreMs`) stayed at 55 to 62 ms on the dragon and 36 to 50 ms on the cover. The STEP cover tessellates to a 0.36 MB STL at the app's default tolerance, so its upload was already small. In the e2e run, the 2.5 MB dragon sample's first job body was 2.5 MB and its move's body was 1,268 bytes.

The desktop app passes the request as one string over Tauri IPC, and that is where the bytes cost most. Timed in the webview around `invoke("slice_model")`, with the same build sending `dataB64` on every call and then `meshRef`:

| Mesh | Step | Wall with `dataB64` | Wall with `meshRef` |
|---|---|---|---|
| Baby Dragon | move | 1,125 ms | 77 ms |
| Baby Dragon | tweak | 1,168 ms | 96 ms |

On the engine side, hashing the dragon's 23.8 MB once takes 14 ms and parsing it takes 6 ms.
