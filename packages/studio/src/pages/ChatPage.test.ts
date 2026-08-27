import { describe, expect, it } from "vitest";
import {
  getChatComposerControlClassName,
  getChatComposerModelRowClassName,
} from "./ChatPage";

describe("ChatPage responsive composer layout", () => {
  it("lets the primary controls shrink and wrap on narrow viewports", () => {
    const className = getChatComposerControlClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("flex-wrap");
  });

  it("lets model and world actions wrap independently of the input row", () => {
    const className = getChatComposerModelRowClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("flex-wrap");
  });
});
