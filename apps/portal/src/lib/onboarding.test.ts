import { describe, expect, test } from "bun:test";

import { evaluateProjectReadiness, onboardingSteps } from "./onboarding";

describe("project onboarding gate", () => {
  test("requires every user-owned service before project creation", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: true,
      chatgpt: true,
      github: false,
      cloudflare: false,
      convex: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.next?.id).toBe("github");
    expect(readiness.completed).toBe(3);
  });

  test("unlocks creation only when every required connection is verified", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: true,
      chatgpt: true,
      github: true,
      cloudflare: true,
      convex: true,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.next).toBeNull();
    expect(readiness.completed).toBe(onboardingSteps.length);
  });

  test("preserves the required user journey order", () => {
    expect(onboardingSteps.map((step) => step.id)).toEqual([
      "clerk",
      "imessage",
      "chatgpt",
      "github",
      "cloudflare",
      "convex",
    ]);
  });

  test("does not allow downstream connections to bypass GitHub", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: true,
      chatgpt: true,
      github: false,
      cloudflare: true,
      convex: true,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.next?.id).toBe("github");
  });
});
