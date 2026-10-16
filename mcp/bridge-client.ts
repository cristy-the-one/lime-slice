/** Optional mirror into a desktop app. Off unless both variables are set. A failure stays off the tool result. */

export async function mirror(payload: unknown): Promise<void> {
  const url = process.env.LIME_MCP_BRIDGE;
  const token = process.env.LIME_MCP_BRIDGE_TOKEN;
  if (!url || !token) return;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("lime-mcp: LIME_MCP_BRIDGE is not a URL, so the mirror was not sent.");
    return;
  }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
    console.error("lime-mcp: LIME_MCP_BRIDGE is not a loopback address, so the mirror was not sent.");
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) console.error("lime-mcp: the desktop bridge refused the mirror.");
  } catch {
    console.error("lime-mcp: the desktop bridge did not accept the mirror.");
  }
}
