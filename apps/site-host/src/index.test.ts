import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import worker, { testables } from "./index";

afterEach(() => mock.restore());

const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const artifactManifestDigest = "ef8707ab866dc5c932006defb3ac93702966a498d0717b79b661d0cce0782380";

function deploymentRequest() {
  return new Request("https://site-host.internal/v1/deployments", {
    method: "POST",
    headers: { authorization: "Bearer deploy-capability", "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "project_1",
      releaseId: "release_1",
      sourceRunId: "run_1",
      commitSha: "abcdef1",
      hostname: "demo-buddybox-sites.buddytools.org",
      artifactManifestDigest,
      assets: [{ path: "index.html", data: "aGVsbG8=", sha256 }],
    }),
  });
}

function deploymentEnv(events: string[], authority: Record<string, unknown> = {}) {
  return {
    SITES_BASE_DOMAIN: "buddybox-sites.buddytools.org",
    CONVEX_SITE_HOST_URL: "https://convex.test/site-host",
    BUDDYBOX_SITE_HOST_SECRET: "s".repeat(64),
    CONTROL_PLANE: {
      fetch: async () => Response.json({
        userId: "user_1",
        projectId: "project_1",
        sandboxGeneration: 1,
        action: "deploy",
        releaseId: "release_1",
        sourceRunId: "run_1",
        commitSha: "abcdef1",
        hostname: "demo-buddybox-sites.buddytools.org",
        artifactManifestDigest,
        ...authority,
      }),
    },
    SITE_ASSETS: {
      put: async (key: string) => {
        events.push(`put:${key}`);
        return { key };
      },
      head: async () => null,
    },
  } as never;
}

describe("site-host input validation", () => {
  test("accepts normalized static asset paths", () => {
    expect(testables.validateAssetPath("assets/app-abc_123.js")).toBe("assets/app-abc_123.js");
    expect(testables.validateAssetPath("index.html")).toBe("index.html");
  });

  test.each(["/index.html", "../secret", "a/../b", "a//b", "a\\b", "a%2fb", ".buddybox-manifest.json", ".env", "assets/.secret"])(
    "rejects unsafe asset path %s",
    (path) => expect(() => testables.validateAssetPath(path)).toThrow(),
  );

  test("decodes strict base64 and enforces declared sha256", async () => {
    const bytes = new TextEncoder().encode("hello");
    const sha256 = await testables.sha256Hex(bytes);
    expect(await testables.decodeAsset({ path: "hello.txt", data: "aGVsbG8=", sha256 })).toEqual({
      path: "hello.txt",
      bytes,
      sha256,
      contentType: "text/plain; charset=utf-8",
    });
    await expect(testables.decodeAsset({ path: "hello.txt", data: "aGVsbG8=", sha256: "0".repeat(64) })).rejects.toThrow("sha256");
    await expect(testables.decodeAsset({ path: "hello.txt", data: "%%", sha256 })).rejects.toThrow("base64");
  });

  test("allows an integrity-checked empty asset", async () => {
    const sha256 = await testables.sha256Hex(new Uint8Array());
    expect((await testables.decodeAsset({ path: "empty.txt", data: "", sha256 })).bytes.byteLength).toBe(0);
  });

  test("creates deterministic deployment refs independent of asset order", async () => {
    const left = await testables.deploymentRef("project_1", "release_1", "abcdef1", [
      { path: "index.html", sha256: "a".repeat(64), size: 10 },
      { path: "assets/app.js", sha256: "b".repeat(64), size: 20 },
    ]);
    const right = await testables.deploymentRef("project_1", "release_1", "abcdef1", [
      { path: "assets/app.js", sha256: "b".repeat(64), size: 20 },
      { path: "index.html", sha256: "a".repeat(64), size: 10 },
    ]);
    expect(left).toBe(right);
    expect(left).toMatch(/^r2:v1:[a-f0-9]{64}$/);
  });
});

describe("site-host public requests", () => {
  test("maps roots and trailing-slash SPA paths safely", () => {
    expect(testables.publicAssetPath("/")).toBe("index.html");
    expect(testables.publicAssetPath("/docs/")).toBe("docs");
    expect(() => testables.publicAssetPath("/%2e%2e/secret")).toThrow();
  });

  test("only resolves exact managed child hosts", () => {
    expect(testables.projectHost("demo-abc-buddybox-sites.buddytools.org", "buddybox-sites.buddytools.org")).toBe(true);
    expect(testables.projectHost(`${"a".repeat(48)}-buddybox-sites.buddytools.org`, "buddybox-sites.buddytools.org")).toBe(true);
    expect(testables.projectHost(`${"a".repeat(49)}-buddybox-sites.buddytools.org`, "buddybox-sites.buddytools.org")).toBe(false);
    expect(testables.projectHost("buddybox-sites.buddytools.org", "buddybox-sites.buddytools.org")).toBe(false);
    expect(testables.projectHost("demo.sites.buddybox.buddytools.org", "buddybox-sites.buddytools.org")).toBe(false);
    expect(testables.projectHost("demo-buddybox-sites.buddytools.org.evil.test", "buddybox-sites.buddytools.org")).toBe(false);
    expect(testables.projectHost("deep.demo-buddybox-sites.buddytools.org", "buddybox-sites.buddytools.org")).toBe(false);
  });

  test("uses immutable cache for fingerprinted assets and revalidates html", () => {
    expect(testables.cacheControl("assets/app-0123456789abcdef.js", "text/javascript; charset=utf-8")).toContain("immutable");
    expect(testables.cacheControl("index.html", "text/html; charset=utf-8")).toBe("public, max-age=0, must-revalidate");
  });
});

describe("site-host deployment boundary", () => {
  test("reserves the exact preauthorized manifest before any R2 write", async () => {
    const events: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (_url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { operation: string };
      events.push(`broker:${body.operation}`);
      if (body.operation === "reserve_upload") return Response.json({ ok: true, result: { status: "reserved" } });
      return Response.json({ ok: true, result: { projectId: "project_1", releaseId: "release_1", status: "live" } });
    }) as unknown as typeof fetch);
    const response = await worker.fetch(deploymentRequest(), deploymentEnv(events));
    expect(response.status).toBe(201);
    expect(events[0]).toBe("broker:reserve_upload");
    expect(events.some((event) => event.startsWith("put:"))).toBe(true);
    expect(events.at(-1)).toBe("broker:activate_release");
  });

  test("does not create orphan R2 objects when reservation fails", async () => {
    const events: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async () => {
      events.push("broker:reserve_upload");
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }) as unknown as typeof fetch);
    const response = await worker.fetch(deploymentRequest(), deploymentEnv(events));
    expect(response.status).toBe(400);
    expect(events).toEqual(["broker:reserve_upload"]);
  });

  test("rejects a capability for another release manifest before reservation or R2", async () => {
    const events: string[] = [];
    const broker = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ ok: true })) as unknown as typeof fetch);
    const response = await worker.fetch(deploymentRequest(), deploymentEnv(events, { releaseId: "release_2" }));
    expect(response.status).toBe(403);
    expect(broker).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test("returns an already-live exact manifest without rewriting R2", async () => {
    const events: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (_url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { operation: string };
      events.push(`broker:${body.operation}`);
      return Response.json({
        ok: true,
        result: {
          status: "live",
          deploymentRef: `r2:v1:${"d".repeat(64)}`,
          liveUrl: "https://demo-buddybox-sites.buddytools.org/",
        },
      });
    }) as unknown as typeof fetch);
    const response = await worker.fetch(deploymentRequest(), deploymentEnv(events));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      deploymentRef: `r2:v1:${"d".repeat(64)}`,
      liveUrl: "https://demo-buddybox-sites.buddytools.org/",
    });
    expect(events).toEqual(["broker:reserve_upload"]);
  });
});
