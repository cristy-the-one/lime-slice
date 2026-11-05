/**
 * The URL `mcp/session.ts` had before it was split into `mcp/session/`. Recipe and lust lookups resolve paths
 * relative to it (`./lime-recipe/`, `../crates/lime-recipe`, `./lust/bin/`), so it must stay in `mcp/`, beside
 * session.ts. In the bundled server it is the bundle's own URL, as before.
 */
export const SESSION_URL = import.meta.url;
