import { describe, expect, it } from "vitest";

import {
  getFilmWizardPhaseGroupClassName,
  getFilmWizardRootClassName,
  getFilmWizardSubviewBarClassName,
  getFilmWizardTopBarClassName,
} from "./FilmWizard";

describe("FilmWizard mobile shell layout", () => {
  it("uses the containing App shell height", () => {
    const className = getFilmWizardRootClassName();

    expect(className).toContain("h-full");
    expect(className).toContain("min-h-0");
    expect(className).not.toContain("h-screen");
  });

  it("wraps the phase toolbar without losing its shrink boundary", () => {
    expect(getFilmWizardTopBarClassName()).toContain("flex-wrap");
    expect(getFilmWizardPhaseGroupClassName()).toContain("min-w-0");
    expect(getFilmWizardPhaseGroupClassName()).toContain("flex-wrap");
    expect(getFilmWizardPhaseGroupClassName()).toContain("w-full");
  });

  it("wraps subview controls", () => {
    expect(getFilmWizardSubviewBarClassName()).toContain("flex-wrap");
  });
});
