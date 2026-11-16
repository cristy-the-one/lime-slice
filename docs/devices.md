# Other devices and the phone layout

## Run on another device (iPhone/iPad over LAN or Tailscale)

The engine stays on loopback until you set `--host`. On the computer that will slice:

```bash
cargo run -p lime-slice --release -- serve --host 0.0.0.0 --token "$LIME_SLICE_TOKEN"
LIME_DEV_HOST=0.0.0.0 npm run dev
```

`--host` defaults to `127.0.0.1`. `0.0.0.0` accepts connections from the LAN. On Tailscale, bind `0.0.0.0` or the machine's Tailscale address. `--token` is optional; the same secret can be supplied with `LIME_SLICE_TOKEN` when the flag is omitted. The flag wins when both are set.

On the phone, open `http://<computer-ip>:43117` (the LAN address or the Tailscale IP, port 43117). A page that is not served from localhost calls `http://<that-host>:43118` on its own. To point at a different engine, open `http://<computer-ip>:43117/?api=http://<engine-host>:43118` or set the URL in the gear menu under Connection and press Test connection. A saved Connection URL wins over `?api=`, which wins over `VITE_LIME_API`. `LIME_DEV_HOST` only changes the Vite dev server (default `127.0.0.1`). Playwright still starts preview on `127.0.0.1`.

Without a token, a non-loopback bind has no authentication: anyone who can reach the port can submit meshes and download G-code. The process prints that warning when it binds. Set a token on a shared network. The UI sends `Authorization: Bearer <token>`, and the engine also accepts `?token=` on a request. CORS stays `*` until a token is set; with a token the engine echoes the page's Origin and allows the Authorization header. Do not expose port 43118 to the public internet.

## Phone / compact layout

The same web UI can draw an iPhone-sized shell. It is not an iOS app. Open it with `?layout=compact`, or set Interface layout to Compact (phone) in the gear menu (and on the Device tab). Auto uses compact when the window is 600px wide or less, and when a phone-sized touch screen is in landscape. An iPad-sized window stays on the desktop shell.

Chrome device mode: open devtools, toggle the device toolbar, pick iPhone 14 (390×844), and load `http://127.0.0.1:43117/?layout=compact`. Touch orbit is one finger, pinch and pan are two fingers, a tap on empty canvas hides the chrome, and a double-tap fits the view. The settings sheet peeks at 56px and drags to half or full. At half, the model is the area above the sheet, about 48% of the screen. The default Prepare view keeps the 3D canvas at 70% or more.

On a phone over the LAN, use the remote-engine commands above and add `&layout=compact` (or `?layout=compact` if there is no other query).

### iOS port later: what's already prepared and what's still TODO

Prepared in the web layer:

- Compact layout, safe-area insets on the phone chrome only, `100dvh`, and `viewport-fit=cover`
- `src/platform.ts` chooses `invoke` inside Tauri and `http` in the browser, and skips window decorations unless `isDesktopShell()`
- File open and G-code save go through `pickModelFile` and `saveGcode`
- Haptics call `navigator.vibrate` and otherwise do nothing

Still TODO before a native shell:

- `tauri ios init` and an Xcode project. Not started here
- `#[cfg(desktop)]` around `tauri-plugin-window-state` and `set_decorations` in src-tauri
- Capabilities split per platform
- `Info.plist` local-network usage string
- iOS file and share plugins behind `pickModelFile` / `saveGcode`
- A Tauri haptics plugin behind `haptic()`
- Whether the phone embeds an engine or keeps using the HTTP engine on another computer
