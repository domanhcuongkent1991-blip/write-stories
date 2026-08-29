import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const testFileDirectory = dirname(fileURLToPath(import.meta.url));
const projectConfigPath = resolve(testFileDirectory, "../../../test-project/inkos.json");
const storageKey = "inkos:studio:ui-locale";
const VI_CREATE_LABELS = [
  "Tiểu thuyết dài",
  "Truyện ngắn",
  "Kịch bản",
  "Phân cảnh",
  "Phim tương tác",
  "Đồng nhân",
  "Ngoại truyện",
  "Viết mô phỏng",
  "Viết tiếp",
  "Dịch thuật",
  "Tương tác phân nhánh",
  "Thế giới mở",
];

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
  await expect(page.getByRole("button", { name: /^英文创作/ })).toBeVisible();

  await page.getByRole("button", { name: "VI", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Sáng tác bằng tiếng Anh/ })).toBeVisible();
  expect(mutations).toEqual([]);

  await page.getByRole("button", { name: /^Sáng tác bằng tiếng Anh/ }).click();
  await expect.poll(() => [...mutations]).toEqual(["POST /api/v1/project/language"]);

  const projectResponse = await page.request.get("/api/v1/project");
  await expect(projectResponse.json()).resolves.toMatchObject({
    language: "en",
    languageExplicit: true,
  });
});

test("create menu is one readable vertical list in Vietnamese", async ({ page }, testInfo) => {
  await writeProjectLanguage("en");
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/");
  await page.getByRole("button", { name: "VI", exact: true }).click();

  const sidebar = page.locator("aside").first();
  const menu = page.getByTestId("sidebar-create-menu");
  const buttons = menu.getByRole("button");

  await expect(buttons).toHaveCount(12);
  await expect(buttons).toHaveText(VI_CREATE_LABELS);
  for (const label of VI_CREATE_LABELS) {
    await expect(menu.getByRole("button", { name: label, exact: true })).toBeEnabled();
  }

  const sidebarBox = await sidebar.boundingBox();
  expect(Math.round(sidebarBox?.width ?? 0)).toBe(260);

  const rows = await buttons.evaluateAll((elements) => elements.map((element) => {
    const label = element.querySelector<HTMLElement>("[data-create-label]");
    if (!label) throw new Error("CreateItem label marker is missing");
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(label);
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      labelScrollWidth: label.scrollWidth,
      labelClientWidth: label.clientWidth,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  }));

  for (let index = 1; index < rows.length; index += 1) {
    expect(rows[index]!.top).toBeGreaterThanOrEqual(rows[index - 1]!.bottom);
  }
  expect(new Set(rows.map((row) => Math.round(row.left))).size).toBe(1);
  expect(rows.every((row) => row.labelScrollWidth <= row.labelClientWidth)).toBe(true);
  expect(rows.every((row) => row.textOverflow !== "ellipsis")).toBe(true);
  expect(rows.every((row) => row.whiteSpace !== "nowrap")).toBe(true);

  const downstreamHeaders = [
    page.getByRole("button", { name: "Tác phẩm của tôi", exact: true }),
    page.getByRole("button", { name: "Phim tương tác", exact: true }).last(),
    page.getByRole("button", { name: "Phiên làm việc", exact: true }),
  ];
  for (const height of [600, 768, 900]) {
    await page.setViewportSize({ width: 1280, height });
    expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const header of downstreamHeaders) {
      await header.scrollIntoViewIfNeeded();
      await expect(header).toBeVisible();
    }
  }

  await menu.scrollIntoViewIfNeeded();
  await testInfo.attach("sidebar-create-menu-vi-260px", {
    body: await sidebar.screenshot(),
    contentType: "image/png",
  });
});
