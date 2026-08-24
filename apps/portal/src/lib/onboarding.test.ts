import { describe, expect, test } from "bun:test";

import {
  evaluateProjectReadiness,
  managedHosting,
  managedProjectHostname,
  onboardingSteps,
} from "./onboarding";

describe("project onboarding gate", () => {
  test("requires every user-facing gate before project creation", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: true,
      xchat: false,
      chatgpt: true,
      github: false,
      convex: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.next?.id).toBe("github");
    expect(readiness.completed).toBe(3);
  });

  test("unlocks creation with iMessage as the verified messaging channel", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: true,
      xchat: false,
      chatgpt: true,
      github: true,
      convex: true,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.next).toBeNull();
    expect(readiness.completed).toBe(onboardingSteps.length);
  });

  test("unlocks creation with X Chat instead of iMessage", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: false,
      xchat: true,
      chatgpt: true,
      github: true,
      convex: true,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.messagingConnected).toBe(true);
    expect(readiness.next).toBeNull();
  });

  test("keeps one messaging gate when both channels are connected", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: true,
      xchat: true,
      chatgpt: true,
      github: true,
      convex: true,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.completed).toBe(onboardingSteps.length);
    expect(readiness.total).toBe(5);
  });

  test("preserves the required user journey order", () => {
    expect(onboardingSteps.map((step) => step.id)).toEqual([
      "clerk",
      "messaging",
      "chatgpt",
      "github",
      "convex",
    ]);
  });

  test("does not allow downstream connections to bypass GitHub", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: true,
      xchat: false,
      chatgpt: true,
      github: false,
      convex: true,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.next?.id).toBe("github");
  });

  test("does not require a user Cloudflare connection", () => {
    expect(onboardingSteps.map((step) => String(step.id))).not.toContain("cloudflare");
  });

  test("uses the no-extra-account managed hostname convention", () => {
    expect(managedProjectHostname).toBe("<project>-buddybox-sites.buddytools.org");
    expect(managedHosting.detail).toContain(managedProjectHostname);
    expect(managedHosting.detail).toContain("No Cloudflare account is required");
  });

  test("blocks readiness when neither messaging channel is verified", () => {
    const readiness = evaluateProjectReadiness({
      clerk: true,
      imessage: false,
      xchat: false,
      chatgpt: true,
      github: true,
      convex: true,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.messagingConnected).toBe(false);
    expect(readiness.next?.id).toBe("messaging");
  });
});
