/**
 * Slice replies as the app read them through a spec's proxy to a real engine. The app asks for its layers in parts
 * (`layerParts`, read once each from `/api/reply/<token>/<i>`), so a reply is kept whole only after the app has read
 * every part, with `layers` put back in order.
 */
export function engineReplies<T extends { layers?: unknown[] }>() {
  const replies: T[] = [];
  const waiting = new Map<string, { reply: T & { layerParts?: unknown }; parts: unknown[][]; left: number }>();
  /** Call with each proxied 200 response's URL and text. */
  const note = (url: string, text: string) => {
    const part = /\/api\/reply\/([^/]+)\/(\d+)$/.exec(url);
    if (part) {
      const held = waiting.get(decodeURIComponent(part[1]!));
      if (!held) return;
      held.parts[Number(part[2])] = JSON.parse(text) as unknown[];
      if (--held.left > 0) return;
      waiting.delete(decodeURIComponent(part[1]!));
      delete held.reply.layerParts;
      (held.reply as { layers?: unknown[] }).layers = held.parts.flat();
      replies.push(held.reply);
      return;
    }
    if (!/\/api\/jobs\/[^/]+\/result$|\/api\/slice$/.test(url)) return;
    const reply = JSON.parse(text) as T & { layerParts?: { token: string; count: number } };
    const parts = reply.layerParts;
    if (parts && parts.count > 0) {
      waiting.set(parts.token, { reply, parts: [], left: parts.count });
      return;
    }
    if (parts) {
      delete reply.layerParts;
      (reply as { layers?: unknown[] }).layers = [];
    }
    replies.push(reply);
  };
  return { replies, note };
}
