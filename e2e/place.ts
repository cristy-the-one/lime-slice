import type { Page } from "@playwright/test";

/** The selected object's bed position as the X and Y fields hold it, and its lowest Z. */
export async function placeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const field = (id: string) => (document.querySelector(`#${id}`) as HTMLInputElement | null)?.value ?? "";
    const z = document.querySelector("#placeXY")?.getAttribute("data-bed-z") ?? "";
    return `X ${field("placeX")} · Y ${field("placeY")} · bed Z ${z} mm`;
  });
}
