import { describe, expect, test } from "bun:test";

import {
  isUserConnectableOAuthProvider,
  parseGitHubInstallationBinding,
} from "./providerOAuth";

describe("User OAuth surface", () => {
  test("does not expose Cloudflare as a User Service Connection", () => {
    expect(isUserConnectableOAuthProvider("github")).toBe(true);
    expect(isUserConnectableOAuthProvider("convex")).toBe(true);
    expect(isUserConnectableOAuthProvider("cloudflare")).toBe(false);
  });
});

describe("GitHub credential resolution", () => {
  test("returns only a validated installation and repository binding", () => {
    expect(parseGitHubInstallationBinding(
      JSON.stringify({ installationId: "987", login: "octocat" }),
      "123",
      "octocat/chef-site",
    )).toEqual({
      status: "ok",
      installationId: 987,
      repositoryId: 123,
      repositoryFullName: "octocat/chef-site",
    });
  });

  test("rejects malformed or unsafe identifiers", () => {
    expect(() => parseGitHubInstallationBinding("{}", "123", "octocat/chef-site")).toThrow();
    expect(() => parseGitHubInstallationBinding('{"installationId":1}', "0", "octocat/chef-site")).toThrow();
    expect(() => parseGitHubInstallationBinding('{"installationId":1}', "123", "../escape")).toThrow();
  });
});
