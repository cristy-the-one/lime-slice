import {
  API_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  authHeaders,
  currentApiTarget,
  normalizeBase,
  resolveApiBase,
} from "./api-base";

function viteEnv(name: string): string | undefined {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const value = env?.[name];
  return value && value.length > 0 ? value : undefined;
}

/** Engine URL and shared token, edited from the gear menu and kept in localStorage. */
export function mountConnection(onSaved: () => void) {
  const panel = document.querySelector("#gear .gear-panel");
  if (!panel || document.querySelector("#connection")) return;
  const section = document.createElement("section");
  section.id = "connection";
  section.className = "connection";
  section.innerHTML = `
    <div class="gear-label">Connection</div>
    <label class="field">Engine URL
      <input id="apiBase" type="url" spellcheck="false" autocomplete="off" />
    </label>
    <label class="field">Token
      <input id="apiToken" type="password" spellcheck="false" autocomplete="off" />
    </label>
    <div class="connection-actions">
      <button type="button" class="btn" id="apiSave">Save</button>
      <button type="button" class="btn" id="apiTest">Test connection</button>
    </div>
    <p id="apiUsing" class="connection-result"></p>
    <p id="apiTestResult" class="connection-result" role="status"></p>
  `;
  panel.append(section);

  const url = section.querySelector<HTMLInputElement>("#apiBase")!;
  const token = section.querySelector<HTMLInputElement>("#apiToken")!;
  const using = section.querySelector<HTMLElement>("#apiUsing")!;
  const result = section.querySelector<HTMLElement>("#apiTestResult")!;
  url.value = localStorage.getItem(API_STORAGE_KEY) ?? "";
  token.value = localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  const params = new URLSearchParams(location.search);
  url.placeholder = resolveApiBase({
    stored: "",
    query: params.get("api"),
    env: viteEnv("VITE_LIME_API"),
    protocol: location.protocol,
    hostname: location.hostname,
  });
  token.placeholder = "Optional";

  const paintUsing = () => {
    const target = currentApiTarget();
    using.textContent = target.token ? `Using ${target.base} with a token` : `Using ${target.base}`;
  };
  paintUsing();

  section.querySelector("#apiSave")!.addEventListener("click", () => {
    const next = normalizeBase(url.value);
    if (next) localStorage.setItem(API_STORAGE_KEY, next);
    else localStorage.removeItem(API_STORAGE_KEY);
    const secret = token.value.trim();
    if (secret) localStorage.setItem(TOKEN_STORAGE_KEY, secret);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
    url.value = next;
    result.dataset.state = "ok";
    result.textContent = "Saved";
    paintUsing();
    onSaved();
  });

  section.querySelector("#apiTest")!.addEventListener("click", () => {
    const typedUrl = normalizeBase(url.value);
    const target = currentApiTarget();
    const base = typedUrl || target.base;
    const secret = token.value.trim() || (typedUrl ? "" : target.token);
    void testConnection(base, secret, result);
  });
}

async function testConnection(base: string, token: string, result: HTMLElement) {
  result.dataset.state = "pending";
  result.textContent = `Testing ${base}…`;
  try {
    const res = await fetch(`${base}/api/health`, { headers: authHeaders(token) });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    result.dataset.state = "ok";
    result.textContent = `OK · ${base}`;
  } catch (err) {
    const reason = err instanceof Error && err.message !== "Failed to fetch" ? err.message : "unreachable";
    result.dataset.state = "bad";
    result.textContent = `Failed · ${base} · ${reason}`;
  }
}
