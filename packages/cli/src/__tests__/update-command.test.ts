import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runSourceUpdateGuard } from "../commands/update.js";

describe("source-build update guard", () => {
  it("returns exit code 2 and directs the user to reviewed Git changes", () => {
    const lines: string[] = [];
    const result = runSourceUpdateGuard({
      locale: "vi",
      currentVersion: "1.8.0",
      writeLine: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(2);
    expect(lines.join("\n")).toContain("Git");
    expect(lines.join("\n")).not.toContain("npm install -g");
  });

  it("does not contain registry, install, or child-process execution", async () => {
    const source = await readFile(new URL("../commands/update.ts", import.meta.url), "utf-8");

    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("npm view");
    expect(source).not.toContain("npm install");
    expect(source).toContain("process.exitCode = result.exitCode");
  });
});
