import { afterEach, describe, it, expect, vi } from "vitest";
import { parseHash, routeToHash } from "../hooks/use-hash-route";
import { createFlowEditHandlers } from "../pages/FlowView";
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
    "uses UI locale %s independently of writing language %s in production edit handlers",
    (uiLocale, writingLanguage, expectedChoice, expectedNode) => {
      setAppLanguage(uiLocale);
      setWritingLanguage(writingLanguage);

      const post = vi.fn().mockResolvedValue(undefined);
      const graph = {
        title: "demo",
        nodes: [{
          id: "source",
          type: "normal",
          title: "Source",
          choices: [],
          position: { x: 0, y: 0 },
        }],
      } as never;
      const { onConnect, onAddNode } = createFlowEditHandlers({ graph, editing: true, post });

      return Promise.all([
        onConnect({ source: "source", target: "target" }),
        onAddNode(),
      ]).then(() => {
        const deltas = post.mock.calls.map(([body]) => body.delta as { nodes: { upsert: Array<any> } });
        expect(deltas[0]?.nodes.upsert[0]?.choices[0]?.text).toBe(expectedChoice);
        expect(deltas[1]?.nodes.upsert[0]?.title).toBe(expectedNode);
      });
    },
  );
});
