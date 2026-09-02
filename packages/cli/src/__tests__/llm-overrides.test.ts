import { describe, expect, it } from "vitest";
import { parseLLMOverridesFromArgv, parseViPipelineModeFromArgv } from "../utils.js";

describe("parseLLMOverridesFromArgv", () => {
  it("parses service/model/api key env and transport overrides from CLI argv", () => {
    expect(parseLLMOverridesFromArgv([
      "write",
      "next",
      "--service",
      "google",
      "--model=gemini-2.5-flash",
      "--api-key-env",
      "GOOGLE_API_KEY",
      "--api-format",
      "chat",
      "--no-stream",
    ])).toEqual({
      service: "google",
      model: "gemini-2.5-flash",
      apiKeyEnv: "GOOGLE_API_KEY",
      apiFormat: "chat",
      stream: false,
    });
  });
});

describe("parseViPipelineModeFromArgv", () => {
  it("reads the typed rollout mode without interpreting invalid values", () => {
    expect(parseViPipelineModeFromArgv([
      "write",
      "next",
      "--vi-pipeline-mode=preview",
    ])).toBe("preview");
    expect(parseViPipelineModeFromArgv([
      "--vi-pipeline-mode",
      "future-mode",
    ])).toBe("future-mode");
    expect(parseViPipelineModeFromArgv(["write", "next"])).toBeUndefined();
  });
});
