import { expect, test } from "@playwright/test";

const UI_LOCALE_STORAGE_KEY = "inkos:studio:ui-locale";
const BOOK_CREATE_SESSION_KEY = "inkos.book-create.session-id";
const BOOK_TITLE = `Hành trình LAN ${Date.now()}`;

test("creates and writes one Vietnamese chapter on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(({ locale }) => {
    localStorage.setItem("inkos:studio:ui-locale", locale);
  }, { locale: "vi" });

  const confirmedAgentRequests: Array<Record<string, unknown>> = [];
  let writeNextRequests = 0;
  let writeTaskSessionId: string | undefined;
  const existingBooksResponse = await page.request.get("/api/v1/books");
  const existingBooks = existingBooksResponse.ok()
    ? await existingBooksResponse.json() as { books?: Array<{ id: string }> }
    : { books: [] };
  const existingBookIds = new Set(existingBooks.books?.map((book) => book.id));
  let createdBookId: string | undefined;
  let createdSessionId: string | undefined;
  let testError: unknown;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/api/v1/agent")) {
      try {
        const body = JSON.parse(request.postData() ?? "{}");
        if (body.requestedIntent === "create_book") confirmedAgentRequests.push(body);
      } catch {
        // Ignore unrelated malformed requests; assertions below cover the flow.
      }
    }
    if (request.url().endsWith("/api/v1/agent")) {
      try {
        const body = JSON.parse(request.postData() ?? "{}");
        if (body.requestedIntent === "write_next") {
          writeNextRequests += 1;
          if (typeof body.sessionId === "string" && body.sessionId.trim()) {
            writeTaskSessionId = body.sessionId;
          }
        }
      } catch {
        // Ignore unrelated malformed requests; the counter remains unchanged.
      }
    }
  });

  try {
    // The deterministic agent stub still goes through the normal model-picker
    // guard. Seed a non-real key so the local API exposes DeepSeek's static
    // model catalog and ChatPage auto-selects its first model. No provider
    // request is possible while INKOS_AGENT_LLM_STUB=1 is enabled.
    const modelSecretResponse = await page.request.put("/api/v1/services/deepseek/secret", {
      data: { apiKey: "stub-key-e2e-not-real" },
    });
    expect(modelSecretResponse.ok()).toBe(true);

    await page.goto("/#/book/new");
  const composer = page.getByRole("textbox", { name: /command|lệnh/i });
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    async () => page.evaluate((key) => localStorage.getItem(key), BOOK_CREATE_SESSION_KEY),
    { timeout: 20_000 },
  ).toBeTruthy();
  const sessionId = await page.evaluate((key) => localStorage.getItem(key), BOOK_CREATE_SESSION_KEY);
  expect(sessionId).toBeTruthy();
  createdSessionId = sessionId ?? undefined;

  const languageSelector = page.locator("select").first();
  await expect(languageSelector).toBeVisible();
  await languageSelector.selectOption("vi");

  await composer.fill(`Tạo một tiểu thuyết dài về ${BOOK_TITLE}, nhân vật chính phải lựa chọn giữa sự thật và gia đình.`);
  await composer.press("Enter");
  await expect(page.getByTestId("confirm-action")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("confirm-action").click();

  await expect.poll(() => confirmedAgentRequests.length, { timeout: 60_000 }).toBe(1);
  expect(confirmedAgentRequests[0]?.actionPayload).toMatchObject({ createBook: { language: "vi" } });

  await expect.poll(
    async () => {
      const response = await page.request.get("/api/v1/books");
      if (!response.ok()) return null;
      const payload = await response.json() as { books?: Array<{ id: string; title: string }> };
      return payload.books?.find((book) => !existingBookIds.has(book.id) && book.language === "vi") ?? null;
    },
    { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
  ).toMatchObject({ language: "vi" });
  const booksAfterCreate = await (await page.request.get("/api/v1/books")).json() as {
    books?: Array<{ id: string; title: string; language?: string }>;
  };
  const createdBook = booksAfterCreate.books?.find((book) => !existingBookIds.has(book.id) && book.language === "vi");
  expect(createdBook).toBeDefined();
  const bookId = createdBook!.id;
  createdBookId = bookId;

  await expect.poll(
    async () => (await page.request.get(`/api/v1/books/${encodeURIComponent(bookId)}`)).json(),
    { timeout: 30_000 },
  ).toMatchObject({ book: { id: bookId, language: "vi" } });

  await expect.poll(
    async () => (await page.request.get(`/api/v1/sessions/${encodeURIComponent(sessionId!)}`)).json(),
    { timeout: 30_000 },
  ).toMatchObject({ session: expect.anything() });

  await page.goto(`/#/book/${encodeURIComponent(bookId)}`);
  const writeNext = page.getByRole("button", { name: /Write next|Viết chương tiếp theo/i });
  await expect(writeNext).toBeVisible({ timeout: 30_000 });
  await writeNext.click();
  await expect.poll(() => writeNextRequests, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => writeTaskSessionId, { timeout: 10_000 }).toBeTruthy();
  const taskSessionId = writeTaskSessionId!;
  let writeTaskSeen = false;
  const writeTaskPromise = expect.poll(
    async () => {
      const response = await page.request.get(`/api/v1/sessions/${encodeURIComponent(taskSessionId)}`);
      if (!response.ok()) return writeTaskSeen;
      const payload = await response.json() as { task?: unknown };
      if (payload.task !== undefined) writeTaskSeen = true;
      return writeTaskSeen;
    },
    { timeout: 30_000 },
  ).toBe(true);
  await writeTaskPromise;

  await expect.poll(
    async () => {
      const response = await page.request.get(`/api/v1/books/${encodeURIComponent(bookId)}`);
      if (!response.ok()) return null;
      return await response.json() as { chapters?: Array<{ number: number }> };
    },
    { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
  ).toMatchObject({ chapters: expect.arrayContaining([expect.objectContaining({ number: 1 })]) });
  const chapterPayload = await (await page.request.get(`/api/v1/books/${encodeURIComponent(bookId)}`)).json() as {
    chapters?: Array<{ number: number }>;
  };
  const chapterCount = chapterPayload.chapters?.length ?? 0;
  expect(chapterCount).toBeGreaterThanOrEqual(1);
  const chapterArtifact = await page.request.get(`/api/v1/books/${encodeURIComponent(bookId)}/chapters/1`);
  expect(chapterArtifact.ok()).toBe(true);

  await page.reload();
  await expect.poll(
    async () => {
      const response = await page.request.get(`/api/v1/books/${encodeURIComponent(bookId)}`);
      if (!response.ok()) return null;
      return await response.json() as { chapters?: Array<{ number: number }> };
    },
    { timeout: 30_000 },
  ).toMatchObject({ chapters: expect.arrayContaining([expect.objectContaining({ number: 1 })]) });
  const reloadedBook = await (await page.request.get(`/api/v1/books/${encodeURIComponent(bookId)}`)).json() as {
    chapters?: Array<{ number: number }>;
  };
  expect(reloadedBook.chapters).toHaveLength(chapterCount);
  expect(new Set(reloadedBook.chapters?.map((chapter) => chapter.number)).size).toBe(reloadedBook.chapters?.length ?? 0);
  expect(writeNextRequests).toBe(1);

  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    try {
      await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
    } catch {
      // Preserve the original test result if the page is already unavailable.
    }
    try {
      await page.waitForTimeout(250);
    } catch {
      // Preserve the original test result if the page is already unavailable.
    }

    let cleanupBookId = createdBookId;
    if (!cleanupBookId) {
      try {
        const lookupDelays = [0, 500, 1_000, 2_000, 4_000];
        for (const delay of lookupDelays) {
          if (delay > 0) await page.waitForTimeout(delay);
          const response = await page.request.get("/api/v1/books");
          if (!response.ok()) continue;
          const payload = await response.json() as {
            books?: Array<{ id: string; title?: string; language?: string }>;
          };
          const candidates = (payload.books ?? []).filter((book) =>
            !existingBookIds.has(book.id)
            && book.title === BOOK_TITLE
            && book.language === "vi",
          );
          if (candidates.length === 1) {
            cleanupBookId = candidates[0]!.id;
            break;
          }
        }
      } catch (error) {
        if (testError === undefined) throw error;
        console.warn(`E2E cleanup lookup failed for ${BOOK_TITLE}: ${String(error)}`);
      }
    }

    if (cleanupBookId) {
      try {
        const cleanupSessionId = writeTaskSessionId ?? createdSessionId;
        if (cleanupSessionId) {
          await expect.poll(
            async () => {
              const response = await page.request.get(`/api/v1/sessions/${encodeURIComponent(cleanupSessionId)}`);
              if (!response.ok()) return true;
              const payload = await response.json() as {
                task?: { execution?: { status?: string } };
              };
              const status = payload.task?.execution?.status;
              return status === undefined || status === "completed" || status === "error";
            },
            { timeout: 30_000 },
          ).toBe(true);
        }

        const bookPath = `/api/v1/books/${encodeURIComponent(cleanupBookId)}`;
        const retryDelays = [0, 500, 1_000, 2_000, 4_000];
        let deleteStatus: number | undefined;
        for (const delay of retryDelays) {
          if (delay > 0) await page.waitForTimeout(delay);
          const response = await page.request.delete(bookPath);
          deleteStatus = response.status();
          if (response.ok() || response.status() === 404) break;
        }

        const verify = await page.request.get(bookPath);
        if (verify.status() !== 404) {
          throw new Error(
            `E2E cleanup could not remove newly-created book ${cleanupBookId} `
            + `(last DELETE status ${deleteStatus ?? "unknown"}, GET status ${verify.status()})`,
          );
        }
      } catch (error) {
        if (testError === undefined) throw error;
        console.warn(`E2E cleanup failed for newly-created book ${cleanupBookId}: ${String(error)}`);
      }
    } else if (testError === undefined) {
      throw new Error(`E2E cleanup could not uniquely identify newly-created Vietnamese book ${BOOK_TITLE}`);
    }
  }
});
