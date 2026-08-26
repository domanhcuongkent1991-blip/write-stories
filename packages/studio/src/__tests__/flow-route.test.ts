import { describe, it, expect } from "vitest";
import { parseHash, routeToHash } from "../hooks/use-hash-route";
import { resolveNewGraphContent } from "../pages/FlowView";
import { setAppLanguage } from "../lib/app-language";

describe("flow route", () => {
  it("parses #/flow/:id", () => { expect(parseHash("#/flow/p1")).toEqual({ page: "flow", projectId: "p1" }); });
  it("round-trips", () => { expect(routeToHash({ page: "flow", projectId: "p1" })).toBe("#/flow/p1"); });

  it("does not persist Vietnamese UI copy as graph content", () => {
    setAppLanguage("vi");

    expect(resolveNewGraphContent("choice")).toBe("New choice");
    expect(resolveNewGraphContent("node")).toBe("New node");

    setAppLanguage("zh");
  });
});
