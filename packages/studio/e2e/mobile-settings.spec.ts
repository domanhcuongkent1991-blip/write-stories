import { expect, test } from "@playwright/test";

const UI_LOCALE_STORAGE_KEY = "inkos:studio:ui-locale";

test("Settings Agent Skills cards do not create horizontal overflow at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript((storageKey) => {
    localStorage.setItem(storageKey, "vi");
  }, UI_LOCALE_STORAGE_KEY);

  const skillsResponse = page.waitForResponse((response) => response.url().includes("/api/v1/skills") && response.ok());
  await page.goto("/#/settings");
  await skillsResponse;
  await expect(page.getByText("Agent Skills", { exact: true })).toBeVisible();

  const dimensions = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) throw new Error("Studio main element is missing");
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      mainClientWidth: main.clientWidth,
      mainScrollWidth: main.scrollWidth,
    };
  });

  expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.documentClientWidth);
  expect(dimensions.mainScrollWidth).toBeLessThanOrEqual(dimensions.mainClientWidth);
});
