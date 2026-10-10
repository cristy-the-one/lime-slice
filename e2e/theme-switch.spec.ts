import { expect, test, type Page } from "@playwright/test";

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#theme").selectOption(theme);
  await page.locator("#gear").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
}

/** Every option's own background and text, and their WCAG contrast. A transparent option falls back to the popup's stale native colors. */
async function optionColors(page: Page, selector: string) {
  return page.locator(selector).evaluate((select) => {
    const rgb = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    return [...(select as HTMLSelectElement).options].map((option) => {
      const style = getComputedStyle(option);
      const bg = rgb(style.backgroundColor);
      const fg = rgb(style.color);
      const [hi, lo] = [lum(bg), lum(fg)].sort((a, b) => b - a);
      return { label: option.text, alpha: bg[3] ?? 1, contrast: (hi! + 0.05) / (lo! + 0.05) };
    });
  });
}

test("select options keep readable colors through light, dark, and light again", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.goto("/");
  for (const theme of ["light", "dark", "light"] as const) {
    await setTheme(page, theme);
    for (const selector of ["#colorBy", "#levelPick", "#theme"]) {
      for (const option of await optionColors(page, selector)) {
        expect(option.alpha, `${theme}: ${selector} ${option.label} has its own background`).toBe(1);
        expect(option.contrast, `${theme}: ${selector} ${option.label} contrast`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});
