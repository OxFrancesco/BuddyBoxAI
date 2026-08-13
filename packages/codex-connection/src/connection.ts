import { hashAccountId } from "./crypto.ts";
import type {
  AccessResolution,
  CodexAuthClient,
  CodexConnectionRepository,
  DeviceConnectionStatus,
  PersistedCodexConnection,
  RevocationResult,
  SecretVault,
} from "./types.ts";

const DEFAULT_DEVICE_TTL_MS = 15 * 60_000;

export type CodexConnectionManagerOptions = Readonly<{
  client: CodexAuthClient;
  repository: CodexConnectionRepository;
  vault: SecretVault;
  now?: () => number;
  randomId?: () => string;
  deviceTtlMs?: number;
  refreshEarlyMs?: number;
  refreshLeaseMs?: number;
  pollLeaseMs?: number;
}>;

function assertIdentifier(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function pendingStatus(
  session: NonNullable<PersistedCodexConnection["session"]>,
  now: number,
): DeviceConnectionStatus {
  if (!session.userCode || !session.verificationUri) {
    return { state: "failed", code: "invalid_session_state" };
  }
  return {
    state: "pending",
    sessionId: session.id,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    expiresAt: session.expiresAt,
    retryAfterMs: Math.max(0, session.nextPollAt - now),
  };
}

export class CodexConnectionManager {
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly deviceTtlMs: number;
  private readonly refreshEarlyMs: number;
  private readonly refreshLeaseMs: number;
  private readonly pollLeaseMs: number;

  constructor(private readonly options: CodexConnectionManagerOptions) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.deviceTtlMs = options.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS;
    this.refreshEarlyMs = options.refreshEarlyMs ?? 5 * 60_000;
    this.refreshLeaseMs = options.refreshLeaseMs ?? 30_000;
    this.pollLeaseMs = options.pollLeaseMs ?? 30_000;
    for (const [name, value] of Object.entries({
      deviceTtlMs: this.deviceTtlMs,
      refreshEarlyMs: this.refreshEarlyMs,
      refreshLeaseMs: this.refreshLeaseMs,
      pollLeaseMs: this.pollLeaseMs,
    })) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} is invalid.`);
    }
  }

  async status(userId: string): Promise<DeviceConnectionStatus> {
    assertIdentifier("userId", userId);
    const loaded = await this.options.repository.load(userId);
    if (!loaded) return { state: "disconnected" };
    if (loaded.value.credential?.status === "connected") {
      return { state: "connected" };
    }
    if (loaded.value.credential?.status === "needs_reauth") {
      return { state: "failed", code: "needs_reauth" };
    }
    const session = loaded.value.session;
    if (!session) return { state: "disconnected" };
    if (session.status === "pending") {
      if (session.expiresAt <= this.now()) {
        return { state: "failed", code: "expired" };
      }
      return pendingStatus(session, this.now());
    }
    if (session.status === "connected") return { state: "connected" };
    return { state: "failed", code: session.errorCode ?? session.status };
  }

  async start(userId: string, signal?: AbortSignal): Promise<DeviceConnectionStatus> {
    assertIdentifier("userId", userId);
    const now = this.now();
    const existing = await this.options.repository.load(userId);
    if (existing?.value.credential?.status === "connected") {
      return { state: "connected" };
    }
    const active = existing?.value.session;
    if (active?.status === "pending" && active.expiresAt > now) {
      return pendingStatus(active, now);
    }

    const device = await this.options.client.startDeviceAuthorization(signal);
    const sessionId = this.randomId();
    assertIdentifier("sessionId", sessionId);
    const expiresAt = Math.min(device.expiresAt, now + this.deviceTtlMs);
    if (
      !device.deviceAuthId ||
      !device.userCode ||
      !/^https:\/\//.test(device.verificationUri) ||
      !Number.isFinite(device.intervalMs) ||
      device.intervalMs < 0 ||
      expiresAt <= now
    ) {
      throw new Error("The device authorization response is invalid.");
    }
    const intervalMs = Math.max(1_000, device.intervalMs);
    const encryptedDeviceAuthId = await this.options.vault.seal(
      device.deviceAuthId,
      this.sessionAad(userId, sessionId),
    );
    const next: PersistedCodexConnection = {
      ...existing?.value,
      session: {
        id: sessionId,
        status: "pending",
        encryptedDeviceAuthId,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        intervalMs,
        expiresAt,
        nextPollAt: now + intervalMs,
        attemptCount: 0,
      },
    };
    const committed = await this.options.repository.commit(
      userId,
      existing?.revision ?? null,
      next,
    );
    if (!committed) {
      const winner = await this.options.repository.load(userId);
      if (winner?.value.session?.status === "pending") {
        return pendingStatus(winner.value.session, this.now());
      }
      throw new Error("The device authorization could not be persisted.");
    }
    return pendingStatus(next.session!, now);
  }

  async poll(
    userId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DeviceConnectionStatus> {
    assertIdentifier("userId", userId);
    assertIdentifier("sessionId", sessionId);
    const now = this.now();
    const loaded = await this.options.repository.load(userId);
    const session = loaded?.value.session;
    if (!loaded || !session || session.id !== sessionId) {
      return { state: "failed", code: "session_not_found" };
    }
    if (session.status === "connected") return { state: "connected" };
    if (session.status !== "pending") {
      return { state: "failed", code: session.errorCode ?? session.status };
    }
    if (session.expiresAt <= now) {
      await this.options.repository.commit(userId, loaded.revision, {
        ...loaded.value,
        session: this.clearSessionSecrets(session, "expired", "expired"),
      });
      return { state: "failed", code: "expired" };
    }
    if (session.pollLease && session.pollLease.expiresAt > now) {
      return {
        state: "busy",
        retryAfterMs: Math.max(250, session.pollLease.expiresAt - now),
      };
    }
    if (session.nextPollAt > now) return pendingStatus(session, now);
    if (!session.encryptedDeviceAuthId || !session.userCode) {
      return this.failSession(userId, loaded, "invalid_session_state");
    }

    const leaseId = this.randomId();
    const claimedSession = {
      ...session,
      pollLease: { id: leaseId, expiresAt: now + this.pollLeaseMs },
    };
    const claimed = await this.options.repository.commit(userId, loaded.revision, {
      ...loaded.value,
      session: claimedSession,
    });
    if (!claimed) return { state: "busy", retryAfterMs: 250 };

    try {
      const deviceAuthId = await this.options.vault.open(
        session.encryptedDeviceAuthId,
        this.sessionAad(userId, sessionId),
      );
      const result = await this.options.client.pollDeviceAuthorization(
        deviceAuthId,
        session.userCode,
        signal,
      );
      if (result.status === "pending" || result.status === "slow_down") {
        const delayMs =
          result.status === "slow_down"
            ? Math.min(session.intervalMs + 5_000, 30_000)
            : session.intervalMs;
        return this.finishPendingPoll(userId, sessionId, leaseId, delayMs);
      }

      const credential = await this.options.client.exchangeDeviceAuthorization(
        result.authorizationCode,
        result.codeVerifier,
        signal,
      );
      this.assertCredentials(credential);
      const [encryptedAccess, encryptedRefresh, accountIdHash] = await Promise.all([
        this.options.vault.seal(
          credential.accessToken,
          this.credentialAad(userId, "access"),
        ),
        this.options.vault.seal(
          credential.refreshToken,
          this.credentialAad(userId, "refresh"),
        ),
        hashAccountId(credential.accountId),
      ]);
      const current = await this.options.repository.load(userId);
      if (
        !current ||
        current.value.session?.id !== sessionId ||
        current.value.session.pollLease?.id !== leaseId
      ) {
        return { state: "busy", retryAfterMs: 250 };
      }
      const stored = await this.options.repository.commit(userId, current.revision, {
        ...current.value,
        session: this.clearSessionSecrets(current.value.session, "connected"),
        credential: {
          status: "connected",
          encryptedAccess,
          encryptedRefresh,
          expiresAt: credential.expiresAt,
          accountIdHash,
          updatedAt: this.now(),
        },
      });
      return stored
        ? { state: "connected" }
        : { state: "busy", retryAfterMs: 250 };
    } catch (error) {
      const code = this.errorCode(error);
      const current = await this.options.repository.load(userId);
      if (
        current?.value.session?.id === sessionId &&
        current.value.session.pollLease?.id === leaseId
      ) {
        await this.options.repository.commit(userId, current.revision, {
          ...current.value,
          session: this.clearSessionSecrets(current.value.session, "failed", code),
        });
      }
      return { state: "failed", code };
    }
  }

  async resolveAccess(
    userId: string,
    signal?: AbortSignal,
  ): Promise<AccessResolution> {
    assertIdentifier("userId", userId);
    const loaded = await this.options.repository.load(userId);
    const credential = loaded?.value.credential;
    if (!loaded || !credential) return { status: "missing" };
    if (
      credential.status === "needs_reauth" ||
      !credential.encryptedAccess ||
      !credential.encryptedRefresh ||
      credential.expiresAt === undefined
    ) {
      return { status: "reauth" };
    }
    const now = this.now();
    if (credential.expiresAt > now + this.refreshEarlyMs) {
      try {
        return {
          status: "ok",
          accessToken: await this.options.vault.open(
            credential.encryptedAccess,
            this.credentialAad(userId, "access"),
          ),
          expiresAt: credential.expiresAt,
        };
      } catch {
        await this.invalidateCredential(userId);
        return { status: "reauth" };
      }
    }
    if (credential.refreshLease && credential.refreshLease.expiresAt > now) {
      return {
        status: "busy",
        retryAfterMs: Math.max(250, credential.refreshLease.expiresAt - now),
      };
    }

    const leaseId = this.randomId();
    const claimed = await this.options.repository.commit(userId, loaded.revision, {
      ...loaded.value,
      credential: {
        ...credential,
        refreshLease: { id: leaseId, expiresAt: now + this.refreshLeaseMs },
      },
    });
    if (!claimed) return { status: "busy", retryAfterMs: 250 };

    try {
      const refreshToken = await this.options.vault.open(
        credential.encryptedRefresh,
        this.credentialAad(userId, "refresh"),
      );
      const refreshed = await this.options.client.refreshCredentials(
        refreshToken,
        signal,
      );
      this.assertCredentials(refreshed);
      const [encryptedAccess, encryptedRefresh, accountIdHash] = await Promise.all([
        this.options.vault.seal(
          refreshed.accessToken,
          this.credentialAad(userId, "access"),
        ),
        this.options.vault.seal(
          refreshed.refreshToken,
          this.credentialAad(userId, "refresh"),
        ),
        hashAccountId(refreshed.accountId),
      ]);
      const current = await this.options.repository.load(userId);
      if (!current || current.value.credential?.refreshLease?.id !== leaseId) {
        return { status: "busy", retryAfterMs: 250 };
      }
      const stored = await this.options.repository.commit(userId, current.revision, {
        ...current.value,
        credential: {
          status: "connected",
          encryptedAccess,
          encryptedRefresh,
          expiresAt: refreshed.expiresAt,
          accountIdHash,
          refreshLease: undefined,
          updatedAt: this.now(),
        },
      });
      if (!stored) return { status: "busy", retryAfterMs: 250 };
      return {
        status: "ok",
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
      };
    } catch (error) {
      const retryable = this.isRetryable(error);
      if (!retryable) {
        await this.invalidateCredential(userId, leaseId);
        return { status: "reauth" };
      }
      await this.releaseRefreshLease(userId, leaseId);
      return { status: "unavailable", retryAfterMs: 1_000 };
    }
  }

  async revoke(
    userId: string,
    signal?: AbortSignal,
  ): Promise<RevocationResult> {
    assertIdentifier("userId", userId);
    let refreshToken: string | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.options.repository.load(userId);
      if (!current) {
        return { local: "revoked", upstream: "unsupported" };
      }
      const encryptedRefresh = current.value.credential?.encryptedRefresh;
      if (encryptedRefresh) {
        try {
          refreshToken = await this.options.vault.open(
            encryptedRefresh,
            this.credentialAad(userId, "refresh"),
          );
        } catch {
          refreshToken = undefined;
        }
      }
      if (await this.options.repository.commit(userId, current.revision, null)) break;
      if (attempt === 7) {
        throw new Error("The local Codex connection could not be revoked.");
      }
    }
    if (!refreshToken || !this.options.client.revokeCredentials) {
      return {
        local: "revoked",
        upstream: this.options.client.revokeCredentials ? "failed" : "unsupported",
      };
    }
    try {
      await this.options.client.revokeCredentials(refreshToken, signal);
      return { local: "revoked", upstream: "revoked" };
    } catch {
      return { local: "revoked", upstream: "failed" };
    }
  }

  private sessionAad(userId: string, sessionId: string): string {
    return `ichef:codex-device:v1:${userId}:${sessionId}`;
  }

  private credentialAad(userId: string, kind: "access" | "refresh"): string {
    return `ichef:codex-credential:v1:${userId}:${kind}`;
  }

  private async finishPendingPoll(
    userId: string,
    sessionId: string,
    leaseId: string,
    delayMs: number,
  ): Promise<DeviceConnectionStatus> {
    const current = await this.options.repository.load(userId);
    const session = current?.value.session;
    if (!current || !session || session.id !== sessionId || session.pollLease?.id !== leaseId) {
      return { state: "busy", retryAfterMs: 250 };
    }
    const now = this.now();
    const boundedDelay = Math.max(1_000, Math.min(delayMs, session.expiresAt - now));
    const nextSession = {
      ...session,
      intervalMs: boundedDelay,
      nextPollAt: now + boundedDelay,
      attemptCount: session.attemptCount + 1,
      pollLease: undefined,
    };
    const committed = await this.options.repository.commit(userId, current.revision, {
      ...current.value,
      session: nextSession,
    });
    return committed
      ? pendingStatus(nextSession, now)
      : { state: "busy", retryAfterMs: 250 };
  }

  private async failSession(
    userId: string,
    loaded: NonNullable<Awaited<ReturnType<CodexConnectionRepository["load"]>>>,
    code: string,
  ): Promise<DeviceConnectionStatus> {
    const session = loaded.value.session;
    if (session) {
      await this.options.repository.commit(userId, loaded.revision, {
        ...loaded.value,
        session: this.clearSessionSecrets(session, "failed", code),
      });
    }
    return { state: "failed", code };
  }

  private clearSessionSecrets(
    session: NonNullable<PersistedCodexConnection["session"]>,
    status: "connected" | "failed" | "expired" | "cancelled",
    errorCode?: string,
  ): NonNullable<PersistedCodexConnection["session"]> {
    return {
      ...session,
      status,
      encryptedDeviceAuthId: undefined,
      userCode: undefined,
      pollLease: undefined,
      errorCode,
    };
  }

  private assertCredentials(credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId: string;
  }): void {
    if (
      !credentials.accessToken ||
      !credentials.refreshToken ||
      !credentials.accountId ||
      !Number.isFinite(credentials.expiresAt) ||
      credentials.expiresAt <= this.now()
    ) {
      throw new Error("The OAuth credential response is invalid.");
    }
  }

  private errorCode(error: unknown): string {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[a-z0-9_]{1,64}$/.test(error.code)
    ) {
      return error.code;
    }
    return "unexpected_error";
  }

  private isRetryable(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "retryable" in error &&
      error.retryable === true
    );
  }

  private async invalidateCredential(
    userId: string,
    requiredLeaseId?: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.options.repository.load(userId);
      const credential = current?.value.credential;
      if (!current || !credential) return;
      if (
        requiredLeaseId &&
        credential.refreshLease?.id !== requiredLeaseId
      ) {
        return;
      }
      const committed = await this.options.repository.commit(userId, current.revision, {
        ...current.value,
        credential: {
          status: "needs_reauth",
          encryptedAccess: undefined,
          encryptedRefresh: undefined,
          expiresAt: undefined,
          accountIdHash: credential.accountIdHash,
          refreshLease: undefined,
          updatedAt: this.now(),
        },
      });
      if (committed) return;
    }
  }

  private async releaseRefreshLease(userId: string, leaseId: string): Promise<void> {
    const current = await this.options.repository.load(userId);
    const credential = current?.value.credential;
    if (!current || !credential || credential.refreshLease?.id !== leaseId) return;
    await this.options.repository.commit(userId, current.revision, {
      ...current.value,
      credential: { ...credential, refreshLease: undefined },
    });
  }
}
