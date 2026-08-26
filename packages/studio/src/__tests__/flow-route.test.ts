import { afterEach, describe, it, expect } from "vitest";
import { parseHash, routeToHash } from "../hooks/use-hash-route";
import { resolveNewGraphContent } from "../pages/FlowView";
import { setAppLanguage } from "../lib/app-language";
import { setWritingLanguage } from "../lib/writing-language";

describe("flow route", () => {
  afterEach(() => {
    setAppLanguage("zh");
    setWritingLanguage("zh");
  });

  it("parses #/flow/:id", () => { expect(parseHash("#/flow/p1")).toEqual({ page: "flow", projectId: "p1" }); });
  it("round-trips", () => { expect(routeToHash({ page: "flow", projectId: "p1" })).toBe("#/flow/p1"); });

  it.each([
    ["zh", "zh", "新选项", "新节点"],
    ["en", "zh", "新选项", "新节点"],
    ["vi", "zh", "新选项", "新节点"],
    ["zh", "en", "New choice", "New node"],
    ["en", "en", "New choice", "New node"],
    ["vi", "en", "New choice", "New node"],
  ] as const)(
    "uses UI locale %s independently of writing language %s",
    (uiLocale, writingLanguage, expectedChoice, expectedNode) => {
      setAppLanguage(uiLocale);
      setWritingLanguage(writingLanguage);

      expect(resolveNewGraphContent("choice")).toBe(expectedChoice);
      expect(resolveNewGraphContent("node")).toBe(expectedNode);
    },
  );
});
