import { describe, expect, it } from "vitest";
import {
  buildDetectionConfig,
  buildNotifyChannel,
  detectionDraftFromConfig,
  notifyDraftFromChannel,
} from "./project-settings-model";
import { getProjectSettingsOverrideAgentInputClassName } from "./ProjectSettings";

describe("project settings form model", () => {
  it("preserves webhook event filters when round-tripping notification channels", () => {
    const draft = notifyDraftFromChannel({
      type: "webhook",
      url: "https://hooks.example.com/inkos",
      secret: "s1",
      events: ["chapter-complete", "pipeline-error"],
    });

    expect(buildNotifyChannel(draft)).toEqual({
      type: "webhook",
      url: "https://hooks.example.com/inkos",
      secret: "s1",
      events: ["chapter-complete", "pipeline-error"],
    });
  });

  it("honors detection.enabled=false instead of re-enabling the detector", () => {
    const draft = detectionDraftFromConfig({
      enabled: false,
      provider: "custom",
      apiUrl: "https://detector.example.com/api",
      apiKeyEnv: "DETECT_KEY",
      threshold: 0.7,
      autoRewrite: true,
      maxRetries: 4,
    });

    expect(draft.enabled).toBe(false);
    expect(buildDetectionConfig(draft)).toBeNull();
  });

  it("places the override agent input on its own row until the small breakpoint", () => {
    const className = getProjectSettingsOverrideAgentInputClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("basis-full");
    expect(className).toContain("flex-none");
    expect(className).toContain("sm:flex-1");
  });
});
