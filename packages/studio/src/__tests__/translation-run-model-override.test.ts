import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStudioServer } from "../api/server.js";

const ID = "2026-09-25T00-00-00-000Z-run-model-test";

describe("Studio translation run model override", () => {
  let root: string;
  let llmServer: Server;
  let llmPort: number;
  let lastChatModel: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-run-"));
    lastChatModel = undefined;

    llmServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
      });
      req.on("end", () => {
        try {
          const body = JSON.parse(raw) as { model?: string };
          lastChatModel = body.model;
        } catch {
          lastChatModel = undefined;
        }
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub LLM stop" } }));
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
    llmPort = (llmServer.address() as AddressInfo).port;

    const projectDir = join(root, "translations", ID);
    await mkdir(join(projectDir, "source"), { recursive: true });
    await mkdir(join(projectDir, "translated"), { recursive: true });
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(
      join(root, "inkos.json"),
      JSON.stringify({
        name: "run-model-test",
        version: "0.1.0",
        language: "vi",
        llm: {
          defaultModel: "cfg-model",
          services: [{ service: "custom", name: "Custom", baseUrl: `http://127.0.0.1:${llmPort}/v1` }],
        },
      }),
      "utf-8",
    );
    await writeFile(
      join(root, ".inkos", "secrets.json"),
      JSON.stringify({ services: { "custom:Custom": { apiKey: "test-key" } } }),
      "utf-8",
    );
    await writeFile(
      join(projectDir, "manifest.json"),
      JSON.stringify({
        id: ID,
        title: "run-model-test",
        sourceLanguage: "zh",
        targetLanguage: "vi",
        chapters: [
          {
            number: 1,
            title: "chapter one",
            sourcePath: `translations/${ID}/source/chapter-0001.json`,
            translatedPath: `translations/${ID}/translated/chapter-0001.json`,
            segmentCount: 1,
            charCount: 10,
            status: "pending",
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(
      join(projectDir, "source", "chapter-0001.json"),
      JSON.stringify({
        number: 1,
        title: "chapter one",
        sourceLanguage: "zh",
        targetLanguage: "vi",
        segments: [{ index: 0, source: "雪落无声。" }],
      }),
      "utf-8",
    );
    await writeFile(
      join(projectDir, "glossary.json"),
      JSON.stringify({
        version: 2,
        meta: { prepCompletedAt: "2026-09-25T00:00:00.000Z" },
        terms: [],
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => llmServer.close((err) => (err ? reject(err) : resolve())));
  });

  it("passes body.model through to the LLM client when provided", async () => {
    const app = createStudioServer({} as never, root);
    const res = await app.request(`/api/v1/translations/${ID}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "override-model" }),
    });
    expect([500, 502]).toContain(res.status);
    expect(lastChatModel).toBe("override-model");
  });

  it("falls back to the project service model when body.model is absent", async () => {
    const app = createStudioServer({} as never, root);
    const res = await app.request(`/api/v1/translations/${ID}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchSize: 1 }),
    });
    expect([500, 502]).toContain(res.status);
    expect(lastChatModel).toBe("cfg-model");
  });
});
