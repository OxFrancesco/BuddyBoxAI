import { describe, expect, test } from "bun:test";

import {
  classifyProviderAuthorizationError,
  providerConnectionRequirements,
} from "./provider-connections";

describe("provider connection prerequisites", () => {
  test("documents a server-side callback and credential boundary for every provider", () => {
    for (const provider of Object.values(providerConnectionRequirements)) {
      const requirements = provider.operatorPrerequisites.join(" ").toLowerCase();
      expect(requirements).toContain("callback");
      expect(requirements).toMatch(/server-side|credential broker/);
      expect(provider.gateNotice).toMatch(/no .* connection is recorded|project creation stays locked/i);
    }
  });

  test("keeps GitHub an explicit prerequisite for project creation", () => {
    const github = providerConnectionRequirements.github;
    expect(github.summary).toContain("must be verified before iChef can create a project");
    expect(github.gateNotice).toContain("Project creation stays locked");
  });

  test("turns missing operator credentials into a safe configuration state", () => {
    expect(classifyProviderAuthorizationError({
      data: { code: "PROVIDER_NOT_CONFIGURED", message: "GitHub OAuth is not configured" },
    })).toBe("configuration_required");
    expect(classifyProviderAuthorizationError(new Error("Network unavailable"))).toBe("failed");
  });
});
