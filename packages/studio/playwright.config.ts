import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Global setup creates the root-bound Vietnamese capability marker after the
  // web servers are ready. The API command itself builds Core first, because
  // the API imports Core's compiled dist/index.js while it starts.
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 60_000,
  // Run specs serially against the single shared dev server. The authoring
  // agent flow streams a long SSE turn; with parallel workers, concurrent
  // specs hammering the one server starve that turn into a 60s timeout (the
  // spec passes alone but flakes in a parallel full run). Serial is both
  // reliable and faster here (one backend, no contention).
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4580",
    headless: true,
    screenshot: "only-on-failure",
  },
  // Always start dedicated Windows-safe API and Vite processes with the
  // deterministic LLM stub; no POSIX shell/background process is required.
  webServer: [
    {
      name: "InkOS API",
      // Keep Core compilation ahead of API startup, then run the local tsx
      // entrypoint directly so Playwright owns the only long-lived process.
      command: "node --import ./node_modules/tsx/dist/loader.mjs e2e/web-server-wrapper.ts api",
      cwd: ".",
      url: "http://127.0.0.1:4581/api/v1/project",
      env: {
        INKOS_AGENT_LLM_STUB: "1",
        INKOS_EXPERIMENTAL_WRITING_VI: "1",
        INKOS_STUDIO_PORT: "4581",
        INKOS_STUDIO_HOSTNAME: "127.0.0.1",
        INKOS_PROJECT_ROOT: "../../test-project",
        INKOS_E2E_SHUTDOWN_FILE: "../../test-project/.inkos/e2e-shutdown.sentinel",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: "InkOS Studio",
      // Avoid a pnpm wrapper here as well; Windows cleanup must terminate
      // the actual Vite process rather than an orphaned child process.
      command: "node --import ./node_modules/tsx/dist/loader.mjs e2e/web-server-wrapper.ts vite --host 127.0.0.1 --port 4580",
      cwd: ".",
      url: "http://127.0.0.1:4580",
      env: {
        INKOS_STUDIO_PORT: "4581",
        INKOS_STUDIO_WEB_HOST: "127.0.0.1",
        INKOS_STUDIO_WEB_PORT: "4580",
        INKOS_E2E_SHUTDOWN_FILE: "../../test-project/.inkos/e2e-shutdown.sentinel",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
