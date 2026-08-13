import { describe, expect, test } from "bun:test";

import { normalizeProjectName } from "./projectPolicy";

describe("normalizeProjectName", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeProjectName("  Launch   plan  ")).toBe("Launch plan");
  });

  test("rejects empty names", () => {
    expect(() => normalizeProjectName("   ")).toThrow("at least 2");
  });

  test("rejects oversized names", () => {
    expect(() => normalizeProjectName("x".repeat(81))).toThrow("at most 80");
  });
});
