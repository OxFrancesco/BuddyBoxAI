import { describe, expect, test } from "bun:test";

import { withLifecycleAuthorization, type LifecycleAuthEnv } from "./lifecycle-auth";

const SECRET = "prototype_shared_secret_at_least_32_chars";

function env(secret: string | null = SECRET): LifecycleAuthEnv {
  return secret === null ? {} : { ICHEF_PROTOTYPE_SECRET: secret };
}

let protectedCalls = 0;
const fetch = withLifecycleAuthorization<LifecycleAuthEnv>(async (request) => {
  protectedCalls += 1;
  return new Response(null, {
    status: new URL(request.url).pathname.includes("INVALID") ? 400 : 404,
  });
});

describe("prototype lifecycle HTTP boundary", () => {
  test("fails closed when the shared secret is missing or shorter than 32 characters", async () => {
    protectedCalls = 0;
    for (const value of [null, "too-short"]) {
      const response = await fetch(
        new Request("https://prototype.example/api/sandboxes/probe/setup", {
          method: "POST",
          headers: { authorization: `Bearer ${SECRET}` },
        }),
        env(value),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(protectedCalls).toBe(0);
  });

  test("requires the exact Bearer credential before touching any lifecycle resource", async () => {
    protectedCalls = 0;
    for (const authorization of [
      undefined,
      SECRET,
      `bearer ${SECRET}`,
      `Bearer  ${SECRET}`,
      `Bearer ${SECRET}suffix`,
    ]) {
      const headers = new Headers();
      if (authorization !== undefined) headers.set("authorization", authorization);
      const response = await fetch(
        new Request("https://prototype.example/api/sandboxes/probe/destroy", { method: "POST", headers }),
        env(),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(protectedCalls).toBe(0);
  });

  test("allows an exact Bearer credential through to lifecycle route validation", async () => {
    const response = await fetch(
      new Request("https://prototype.example/api/sandboxes/INVALID/setup", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      env(),
    );
    expect(response.status).toBe(400);
  });

  test("does not demand the lifecycle credential for non-API healthless 404s", async () => {
    const response = await fetch(new Request("https://prototype.example/"), env());
    expect(response.status).toBe(404);
  });
});
