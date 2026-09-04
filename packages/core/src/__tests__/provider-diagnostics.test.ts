import { describe, expect, it, vi } from "vitest";
import {
  buildProviderDiagnosticObservation,
  buildProviderErrorDiagnosticObservation,
  emitProviderDiagnostic,
  type ProviderDiagnosticObserver,
} from "../llm/provider-diagnostics.js";

describe("provider diagnostics", () => {
  it("records only redacted shape and configured marker presence", () => {
    const observation = buildProviderDiagnosticObservation({
      service: "custom:Fixture",
      requestedModel: "fixture-model",
      apiFormat: "chat",
      stream: true,
      durationMs: 1_234,
      markers: ["CHAPTER_CONTENT", "RUNTIME_STATE_DELTA"],
      response: {
        content: "secret prose\n=== CHAPTER_CONTENT ===\nbody",
        finishReason: "stop",
        providerMetadata: {
          returnedModel: "wire-model",
          systemFingerprint: "fp-fixture",
          contentFieldPresent: true,
          reasoningFieldPresent: false,
          refusalFieldPresent: false,
          toolFieldPresent: false,
        },
      },
    });

    expect(observation).toMatchObject({
      schemaVersion: 1,
      service: "custom:Fixture",
      requestedModel: "fixture-model",
      returnedModel: "wire-model",
      systemFingerprint: "fp-fixture",
      apiFormat: "chat",
      stream: true,
      outcome: "final-answer",
      finishReason: "stop",
      contentLengthBucket: "1-1k",
      durationBucket: "1-5s",
      markerPresence: {
        CHAPTER_CONTENT: true,
        RUNTIME_STATE_DELTA: false,
      },
      errorClass: null,
      errorCode: null,
      httpStatus: null,
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.markerPresence)).toBe(true);
    expect(JSON.stringify(observation)).not.toContain("secret prose");
    for (const forbidden of [
      "content",
      "messages",
      "headers",
      "apiKey",
      "rawResponse",
      "errorMessage",
    ]) {
      expect(observation).not.toHaveProperty(forbidden);
    }
  });

  it("records normalized error identity without its raw message", () => {
    const observation = buildProviderErrorDiagnosticObservation({
      service: "custom:Fixture",
      requestedModel: "fixture-model",
      apiFormat: "chat",
      stream: false,
      durationMs: 250,
      error: Object.assign(new Error("upstream body with sensitive text"), {
        errorClass: "transport",
        code: "LLM_TRANSPORT",
        status: 502,
      }),
    });

    expect(observation).toMatchObject({
      outcome: "provider-error",
      contentLengthBucket: "0",
      durationBucket: "<1s",
      errorClass: "transport",
      errorCode: "LLM_TRANSPORT",
      httpStatus: 502,
      markerPresence: {},
    });
    expect(JSON.stringify(observation)).not.toContain("sensitive text");
  });

  it("swallows observer failures so diagnostics cannot break writing", () => {
    const observer: ProviderDiagnosticObserver = {
      observe: vi.fn(() => {
        throw new Error("observer failed");
      }),
    };
    const observation = buildProviderErrorDiagnosticObservation({
      service: null,
      requestedModel: "fixture-model",
      apiFormat: "responses",
      stream: true,
      durationMs: 0,
      error: new Error("failure"),
    });

    expect(() => emitProviderDiagnostic(observer, observation)).not.toThrow();
    expect(observer.observe).toHaveBeenCalledOnce();
  });
});
