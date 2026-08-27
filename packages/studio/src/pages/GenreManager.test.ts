import { describe, expect, it } from "vitest";

import { getGenreManagerContentLayoutClassName } from "./GenreManager";

describe("GenreManager mobile layout", () => {
  it("stacks the genre list and detail panel before the desktop breakpoint", () => {
    const className = getGenreManagerContentLayoutClassName();

    expect(className).toContain("grid-cols-1");
    expect(className).toContain("lg:grid-cols-[250px_minmax(0,1fr)]");
  });
});
