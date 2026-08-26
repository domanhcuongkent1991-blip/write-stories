import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const testFileDirectory = dirname(fileURLToPath(import.meta.url));
const projectConfigPath = resolve(testFileDirectory, "../../../test-project/inkos.json");
const storageKey = "inkos:studio:ui-locale";

let originalProjectConfig = "";

async function writeProjectLanguage(language: "zh" | "en" | null): Promise<void> {
  const config = JSON.parse(originalProjectConfig) as Record<string, unknown>;
  if (language === null) delete config.language;
  else config.language = language;
  await writeFile(projectConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function recordProjectMutations(page: Page): string[] {
  const mutations: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      (pathname === "/api/v1/project" || pathname === "/api/v1/project/language")
      && (request.method() === "POST" || request.method() === "PUT")
    ) {
      mutations.push(`${request.method()} ${pathname}`);
    }
  });
  return mutations;
}

test.beforeEach(async ({ context }) => {
  originalProjectConfig = await readFile(projectConfigPath, "utf-8");
  await context.addInitScript((key) => {
    const clearedMarker = `${key}:e2e-cleared`;
    if (sessionStorage.getItem(clearedMarker) === null) {
      localStorage.removeItem(key);
      sessionStorage.setItem(clearedMarker, "true");
    }
  }, storageKey);
});

test.afterEach(async () => {
  await writeFile(projectConfigPath, originalProjectConfig, "utf-8");
});

test("header VI selection persists without changing writing language", async ({ page }) => {
  await writeProjectLanguage("en");
  const mutations = recordProjectMutations(page);

  await page.goto("/");
  await page.getByRole("button", { name: "VI", exact: true }).click();

  await expect(page.getByRole("button", { name: "Tác phẩm của tôi", exact: true })).toBeVisible();
  expect(mutations).toEqual([]);

  await page.reload();
  await expect(page.getByRole("button", { name: "Tác phẩm của tôi", exact: true })).toBeVisible();

  const projectResponse = await page.request.get("/api/v1/project");
  expect(projectResponse.ok()).toBe(true);
  await expect(projectResponse.json()).resolves.toMatchObject({ language: "en" });
  expect(mutations).toEqual([]);
});

test("first run separates UI locale from writing language", async ({ page }) => {
  await writeProjectLanguage(null);
  const mutations = recordProjectMutations(page);

  await page.goto("/");
  await expect(page.getByRole("button", { name: "VI", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^English Writing/ })).toBeVisible();

  await page.getByRole("button", { name: "VI", exact: true }).click();
  await expect(page.getByRole("button", { name: /^English Writing/ })).toBeVisible();
  expect(mutations).toEqual([]);

  await page.getByRole("button", { name: /^English Writing/ }).click();
  await expect.poll(() => [...mutations]).toEqual(["POST /api/v1/project/language"]);

  const projectResponse = await page.request.get("/api/v1/project");
  await expect(projectResponse.json()).resolves.toMatchObject({
    language: "en",
    languageExplicit: true,
  });
});
