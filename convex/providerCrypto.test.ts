import { afterEach, describe, expect, test } from "bun:test";

import { openProviderSecret, pkceChallenge, sealProviderSecret } from "./lib/providerCrypto";

const originalKey = process.env.ICHEF_PROVIDER_CREDENTIAL_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.ICHEF_PROVIDER_CREDENTIAL_KEY;
  else process.env.ICHEF_PROVIDER_CREDENTIAL_KEY = originalKey;
});

describe("provider OAuth cryptography", () => {
  test("binds encrypted credentials to owner, provider, and purpose", async () => {
    process.env.ICHEF_PROVIDER_CREDENTIAL_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const sealed = await sealProviderSecret("github-secret", "user-1", "github", "access");
    expect(sealed).not.toContain("github-secret");
    expect(await openProviderSecret(sealed, "user-1", "github", "access")).toBe("github-secret");
    await expect(openProviderSecret(sealed, "user-2", "github", "access")).rejects.toThrow();
    await expect(openProviderSecret(sealed, "user-1", "cloudflare", "access")).rejects.toThrow();
    await expect(openProviderSecret(sealed, "user-1", "github", "refresh")).rejects.toThrow();
  });

  test("produces an RFC 7636 S256 code challenge", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
