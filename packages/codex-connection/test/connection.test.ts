import { describe, expect, test } from "bun:test";
import {
  AesGcmSecretVault,
  CodexConnectionManager,
  MemoryCodexConnectionRepository,
  type CodexAuthClient,
} from "../src/index.ts";

const ACCESS = "ey.secret.access";
const REFRESH = "refresh-secret-value";

function fakeClient(): CodexAuthClient {
  return {
    startDeviceAuthorization: async () => ({
      deviceAuthId: "device-secret-id",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalMs: 5_000,
      expiresAt: 1_900_000,
    }),
    pollDeviceAuthorization: async () => ({ status: "pending" }),
    exchangeDeviceAuthorization: async () => ({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: 9_000_000,
      accountId: "account-1",
    }),
    refreshCredentials: async () => ({
      accessToken: `${ACCESS}.refreshed`,
      refreshToken: `${REFRESH}.rotated`,
      expiresAt: 10_000_000,
      accountId: "account-1",
    }),
  };
}

async function subject(client = fakeClient()) {
  const repository = new MemoryCodexConnectionRepository();
  const vault = await AesGcmSecretVault.fromRawKey(new Uint8Array(32).fill(7));
  let currentNow = 1_000_000;
  const manager = new CodexConnectionManager({
    client,
    repository,
    vault,
    now: () => currentNow,
    randomId: () => "session-1",
  });
  return {
    manager,
    repository,
    advance: (milliseconds: number) => {
      currentNow += milliseconds;
    },
  };
}

describe("CodexConnectionManager", () => {
  test("starts a durable device flow without persisting the device credential in plaintext", async () => {
    const { manager, repository } = await subject();

    await expect(manager.start("user-1")).resolves.toEqual({
      state: "pending",
      sessionId: "session-1",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      expiresAt: 1_900_000,
      retryAfterMs: 5_000,
    });
    await expect(manager.status("user-1")).resolves.toMatchObject({
      state: "pending",
      sessionId: "session-1",
    });

    const persisted = JSON.stringify(await repository.load("user-1"));
    expect(persisted).not.toContain("device-secret-id");
    expect(persisted).not.toContain(ACCESS);
    expect(persisted).not.toContain(REFRESH);
  });

  test("polls a completed authorization and persists only encrypted OAuth credentials", async () => {
    const client = fakeClient();
    client.pollDeviceAuthorization = async () => ({
      status: "complete",
      authorizationCode: "authorization-secret",
      codeVerifier: "verifier-secret",
    });
    const { manager, repository, advance } = await subject(client);
    const started = await manager.start("user-1");
    if (started.state !== "pending") throw new Error("expected pending flow");
    advance(5_000);

    await expect(manager.poll("user-1", started.sessionId)).resolves.toEqual({
      state: "connected",
    });

    const persisted = JSON.stringify(await repository.load("user-1"));
    for (const secret of [
      "device-secret-id",
      "authorization-secret",
      "verifier-secret",
      ACCESS,
      REFRESH,
      "account-1",
    ]) {
      expect(persisted).not.toContain(secret);
    }
  });

  test("returns only the current short-lived access token to the agent runtime", async () => {
    const client = fakeClient();
    client.pollDeviceAuthorization = async () => ({
      status: "complete",
      authorizationCode: "authorization-secret",
      codeVerifier: "verifier-secret",
    });
    const { manager, advance } = await subject(client);
    const started = await manager.start("user-1");
    if (started.state !== "pending") throw new Error("expected pending flow");
    advance(5_000);
    await manager.poll("user-1", started.sessionId);

    await expect(manager.resolveAccess("user-1")).resolves.toEqual({
      status: "ok",
      accessToken: ACCESS,
      expiresAt: 9_000_000,
    });
  });

  test("serializes refresh rotation with a durable lease", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const client = fakeClient();
    client.pollDeviceAuthorization = async () => ({
      status: "complete",
      authorizationCode: "authorization-secret",
      codeVerifier: "verifier-secret",
    });
    client.refreshCredentials = async () => {
      await refreshGate;
      return {
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
        expiresAt: 20_000_000,
        accountId: "account-1",
      };
    };
    const { manager, advance, repository } = await subject(client);
    const started = await manager.start("user-1");
    if (started.state !== "pending") throw new Error("expected pending flow");
    advance(5_000);
    await manager.poll("user-1", started.sessionId);
    advance(8_000_000);

    const first = manager.resolveAccess("user-1");
    await Bun.sleep(0);
    await expect(manager.resolveAccess("user-1")).resolves.toMatchObject({
      status: "busy",
    });
    releaseRefresh();
    await expect(first).resolves.toEqual({
      status: "ok",
      accessToken: "rotated-access",
      expiresAt: 20_000_000,
    });

    const persisted = JSON.stringify(await repository.load("user-1"));
    expect(persisted).not.toContain("rotated-access");
    expect(persisted).not.toContain("rotated-refresh");
  });

  test("erases OAuth material after a permanent refresh rejection", async () => {
    const client = fakeClient();
    client.pollDeviceAuthorization = async () => ({
      status: "complete",
      authorizationCode: "authorization-secret",
      codeVerifier: "verifier-secret",
    });
    client.refreshCredentials = async () => {
      throw Object.assign(new Error("safe rejection"), {
        code: "authorization_rejected",
        retryable: false,
      });
    };
    const { manager, advance, repository } = await subject(client);
    const started = await manager.start("user-1");
    if (started.state !== "pending") throw new Error("expected pending flow");
    advance(5_000);
    await manager.poll("user-1", started.sessionId);
    advance(8_000_000);

    await expect(manager.resolveAccess("user-1")).resolves.toEqual({
      status: "reauth",
    });
    const persisted = await repository.load("user-1");
    expect(persisted?.value.credential).toMatchObject({ status: "needs_reauth" });
    expect(persisted?.value.credential?.encryptedAccess).toBeUndefined();
    expect(persisted?.value.credential?.encryptedRefresh).toBeUndefined();
  });

  test("releases a refresh lease after a transient outage without erasing credentials", async () => {
    const client = fakeClient();
    client.pollDeviceAuthorization = async () => ({
      status: "complete",
      authorizationCode: "authorization-secret",
      codeVerifier: "verifier-secret",
    });
    client.refreshCredentials = async () => {
      throw Object.assign(new Error("safe outage"), {
        code: "upstream_unavailable",
        retryable: true,
      });
    };
    const { manager, advance, repository } = await subject(client);
    const started = await manager.start("user-1");
    if (started.state !== "pending") throw new Error("expected pending flow");
    advance(5_000);
    await manager.poll("user-1", started.sessionId);
    advance(8_000_000);

    await expect(manager.resolveAccess("user-1")).resolves.toEqual({
      status: "unavailable",
      retryAfterMs: 1_000,
    });
    const credential = (await repository.load("user-1"))?.value.credential;
    expect(credential?.status).toBe("connected");
    expect(credential?.refreshLease).toBeUndefined();
    expect(credential?.encryptedRefresh).toBeDefined();
  });

  test("revokes locally first and never returns a refresh credential", async () => {
    let revokedWith = "";
    const client = fakeClient();
    client.pollDeviceAuthorization = async () => ({
      status: "complete",
      authorizationCode: "authorization-secret",
      codeVerifier: "verifier-secret",
    });
    client.revokeCredentials = async (token) => {
      revokedWith = token;
    };
    const { manager, advance, repository } = await subject(client);
    const started = await manager.start("user-1");
    if (started.state !== "pending") throw new Error("expected pending flow");
    advance(5_000);
    await manager.poll("user-1", started.sessionId);

    await expect(manager.revoke("user-1")).resolves.toEqual({
      local: "revoked",
      upstream: "revoked",
    });
    expect(revokedWith).toBe(REFRESH);
    expect(await repository.load("user-1")).toBeNull();
  });
});
