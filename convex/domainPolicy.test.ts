import { describe, expect, test } from "bun:test";

import {
  canTransitionRun,
  isActiveRunStatus,
  quotaDecision,
} from "./domainPolicy";

describe("Run admission policy", () => {
  test("only non-terminal Run states retain the one-active-Run lease", () => {
    expect(isActiveRunStatus("queued")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("verifying")).toBe(true);
    expect(isActiveRunStatus("succeeded")).toBe(false);
    expect(isActiveRunStatus("failed")).toBe(false);
    expect(isActiveRunStatus("cancelled")).toBe(false);
    expect(isActiveRunStatus("needs_attention")).toBe(false);
  });

  test("a Run cannot claim success before verification", () => {
    expect(canTransitionRun("running", "succeeded")).toBe(false);
    expect(canTransitionRun("verifying", "succeeded")).toBe(true);
    expect(canTransitionRun("running", "needs_attention")).toBe(true);
    expect(canTransitionRun("queued", "cancelled")).toBe(true);
    expect(canTransitionRun("succeeded", "running")).toBe(false);
  });

  test("quota admission returns an exact remaining allowance", () => {
    expect(quotaDecision(7, 10, 3)).toEqual({
      allowed: true,
      remaining: 0,
    });
    expect(quotaDecision(8, 10, 3)).toEqual({
      allowed: false,
      remaining: 2,
    });
  });
});
