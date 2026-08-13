import { describe, expect, test } from "bun:test";

import { parsePublicEnv } from "./env";

describe("parsePublicEnv", () => {
  test("accepts Clerk and Convex public configuration", () => {
    expect(
      parsePublicEnv({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_example",
        VITE_CONVEX_URL: "https://example.convex.cloud/",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_test_example",
      convexUrl: "https://example.convex.cloud",
    });
  });

  test("fails closed when a required value is absent", () => {
    expect(() =>
      parsePublicEnv({ VITE_CLERK_PUBLISHABLE_KEY: "pk_test_example" }),
    ).toThrow("VITE_CONVEX_URL");
  });

  test("rejects insecure remote Convex endpoints", () => {
    expect(() =>
      parsePublicEnv({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_live_example",
        VITE_CONVEX_URL: "http://example.com",
      }),
    ).toThrow("HTTPS");
  });
});
