import { describe, expect, it } from "vitest";

import { getAuditTelemetryKey, getBookDetailExportControlsClassName } from "./BookDetail";

describe("BookDetail mobile export controls", () => {
  it("wraps export controls so the full Vietnamese action remains reachable", () => {
    const className = getBookDetailExportControlsClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("flex-wrap");
  });

  it("scopes audit telemetry to its book before looking up a chapter", () => {
    expect(getAuditTelemetryKey("book-a", 3)).not.toBe(getAuditTelemetryKey("book-b", 3));
  });
});
