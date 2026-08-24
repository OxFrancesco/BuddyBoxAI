import { describe, expect, test } from "bun:test";

import { parseClerkPublishableKey } from "./clerk-config";

describe("public Clerk configuration", () => {
  test("accepts only a publishable Clerk key safe to embed in the browser", () => {
    expect(parseClerkPublishableKey("pk_live_Y2xlcmsuaWNoZWYuZXhhbXBsZQ$")).toBe(
      "pk_live_Y2xlcmsuaWNoZWYuZXhhbXBsZQ$",
    );
    expect(parseClerkPublishableKey("pk_test_dGVzdC5leGFtcGxlJA$")).toBe(
      "pk_test_dGVzdC5leGFtcGxlJA$",
    );
  });

  test("fails closed before rendering auth when the public key is absent or malformed", () => {
    expect(() => parseClerkPublishableKey(undefined)).toThrow("VITE_CLERK_PUBLISHABLE_KEY");
    expect(() => parseClerkPublishableKey("sk_live_secret")).toThrow("VITE_CLERK_PUBLISHABLE_KEY");
  });
});
