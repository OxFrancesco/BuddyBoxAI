export type SealedSecret = Readonly<{
  version: 1;
  nonce: string;
  ciphertext: string;
}>;

export interface SecretVault {
  seal(plaintext: string, associatedData: string): Promise<SealedSecret>;
  open(secret: SealedSecret, associatedData: string): Promise<string>;
}

export type CodexCredentials = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}>;

export type DeviceAuthorization = Readonly<{
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
}>;

export type DevicePollResult =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "slow_down" }>
  | Readonly<{
      status: "complete";
      authorizationCode: string;
      codeVerifier: string;
    }>;

export interface CodexAuthClient {
  startDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization>;
  pollDeviceAuthorization(
    deviceAuthId: string,
    userCode: string,
    signal?: AbortSignal,
  ): Promise<DevicePollResult>;
  exchangeDeviceAuthorization(
    authorizationCode: string,
    codeVerifier: string,
    signal?: AbortSignal,
  ): Promise<CodexCredentials>;
  refreshCredentials(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<CodexCredentials>;
  /** Optional because OpenAI currently documents no Codex device-token revocation endpoint. */
  revokeCredentials?(refreshToken: string, signal?: AbortSignal): Promise<void>;
}

export type PersistedDeviceSession = Readonly<{
  id: string;
  status: "pending" | "connected" | "failed" | "expired" | "cancelled";
  encryptedDeviceAuthId?: SealedSecret;
  userCode?: string;
  verificationUri?: string;
  intervalMs: number;
  expiresAt: number;
  nextPollAt: number;
  attemptCount: number;
  pollLease?: Readonly<{ id: string; expiresAt: number }>;
  errorCode?: string;
}>;

export type PersistedCredential = Readonly<{
  status: "connected" | "needs_reauth";
  encryptedAccess?: SealedSecret;
  encryptedRefresh?: SealedSecret;
  expiresAt?: number;
  accountIdHash?: string;
  refreshLease?: Readonly<{ id: string; expiresAt: number }>;
  updatedAt: number;
}>;

export type PersistedCodexConnection = Readonly<{
  session?: PersistedDeviceSession;
  credential?: PersistedCredential;
}>;

export type VersionedCodexConnection = Readonly<{
  revision: number;
  value: PersistedCodexConnection;
}>;

/**
 * Durable compare-and-swap seam. A Convex adapter should implement `commit`
 * as one mutation so refresh and polling leases are serialized globally.
 */
export interface CodexConnectionRepository {
  load(userId: string): Promise<VersionedCodexConnection | null>;
  commit(
    userId: string,
    expectedRevision: number | null,
    next: PersistedCodexConnection | null,
  ): Promise<boolean>;
}

export type DeviceConnectionStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{
      state: "pending";
      sessionId: string;
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      retryAfterMs: number;
    }>
  | Readonly<{ state: "busy"; retryAfterMs: number }>
  | Readonly<{ state: "connected" }>
  | Readonly<{ state: "failed"; code: string }>;

export type AccessResolution =
  | Readonly<{ status: "ok"; accessToken: string; expiresAt: number }>
  | Readonly<{ status: "missing" | "reauth" }>
  | Readonly<{ status: "busy" | "unavailable"; retryAfterMs: number }>;

export type RevocationResult = Readonly<{
  local: "revoked";
  upstream: "revoked" | "unsupported" | "failed";
}>;
