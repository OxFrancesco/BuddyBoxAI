import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { randomToken, sha256 } from "./lib/bridgeCrypto";
import {
  openProviderSecret,
  pkceChallenge,
  sealProviderSecret,
  type OAuthProvider,
} from "./lib/providerCrypto";

const providerValidator = v.union(
  v.literal("github"),
  v.literal("convex"),
);

export type UserConnectableOAuthProvider = "github" | "convex";

export function isUserConnectableOAuthProvider(
  value: string,
): value is UserConnectableOAuthProvider {
  return value === "github" || value === "convex";
}

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
}

export function githubInstallationAuthorizationUrl(
  configuredSlug: string | undefined,
  state: string,
): string {
  const slug = configuredSlug?.trim().toLowerCase();
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) {
    throw new ConvexError({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "GITHUB_APP_SLUG is not configured by the iChef operator",
    });
  }
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

interface ProviderToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scopes: string[];
  expiresAt?: number;
}

interface VerifiedAccount {
  id: string;
  label: string;
  accountRef?: string;
}

type GitHubCredentialResolution =
  | { status: "missing" | "reauth" }
  | {
      status: "ok";
      installationId: number;
      repositoryId: number;
      repositoryFullName: string;
    };

export function parseGitHubInstallationBinding(
  accountRef: string,
  repositoryId: string,
  repositoryFullName: string,
): Exclude<GitHubCredentialResolution, { status: "missing" | "reauth" }> {
  const parsed = asRecordOrNull(JSON.parse(accountRef));
  const installationId = parsed ? Number(parsed.installationId) : Number.NaN;
  const numericRepositoryId = Number(repositoryId);
  if (
    !Number.isSafeInteger(installationId) ||
    installationId <= 0 ||
    !Number.isSafeInteger(numericRepositoryId) ||
    numericRepositoryId <= 0 ||
    repositoryFullName.length > 200 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u.test(repositoryFullName)
  ) {
    throw new Error("GitHub installation binding is malformed");
  }
  return {
    status: "ok",
    installationId,
    repositoryId: numericRepositoryId,
    repositoryFullName,
  };
}

export const resolveGitHubInstallationInternal = internalAction({
  args: { ownerId: v.id("users"), projectId: v.id("projects") },
  returns: v.union(
    v.object({ status: v.literal("missing") }),
    v.object({ status: v.literal("reauth") }),
    v.object({
      status: v.literal("ok"),
      installationId: v.number(),
      repositoryId: v.number(),
      repositoryFullName: v.string(),
    }),
  ),
  handler: async (ctx, args): Promise<GitHubCredentialResolution> => {
    const binding: {
      status: "missing" | "reauth" | "ok";
      externalAccountRefCiphertext?: string;
      repositoryId?: string;
      repositoryFullName?: string;
    } = await ctx.runQuery(internal.providerOAuthStore.loadGitHubInstallationBinding, args);
    if (binding.status !== "ok") return { status: binding.status };
    try {
      const accountRef = await openProviderSecret(
        binding.externalAccountRefCiphertext!,
        args.ownerId,
        "github",
        "account",
      );
      return parseGitHubInstallationBinding(
        accountRef,
        binding.repositoryId!,
        binding.repositoryFullName!,
      );
    } catch {
      return { status: "reauth" };
    }
  },
});

export const start = action({
  args: { provider: providerValidator },
  returns: v.object({ authorizationUrl: v.string() }),
  handler: async (ctx, args): Promise<{ authorizationUrl: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in before connecting a provider" });
    }
    const config = providerConfig(args.provider);
    const ownerId: Id<"users"> = await ctx.runQuery(internal.providerOAuthStore.resolveOwner, {
      tokenIdentifier: identity.tokenIdentifier,
    });
    const state = randomToken(32);
    const verifier = randomToken(32);
    const redirectUri = callbackUri(args.provider);
    await ctx.runMutation(internal.providerOAuthStore.createState, {
      ownerId,
      provider: args.provider,
      stateHash: await sha256(state),
      codeVerifierCiphertext: await sealProviderSecret(verifier, ownerId, args.provider, "pkce"),
      redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1_000,
    });
    if (args.provider === "github") {
      return {
        authorizationUrl: githubInstallationAuthorizationUrl(
          process.env.GITHUB_APP_SLUG,
          state,
        ),
      };
    }
    const authorizationUrl = new URL(config.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", await pkceChallenge(verifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    if (config.scopes.length > 0) {
      authorizationUrl.searchParams.set("scope", config.scopes.join(" "));
    }
    return { authorizationUrl: authorizationUrl.toString() };
  },
});

export const finishCallback = internalAction({
  args: { provider: providerValidator, state: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (args.state.length < 32 || args.state.length > 160 || args.code.length < 1 || args.code.length > 2_048) {
      throw new ConvexError({ code: "INVALID_CALLBACK", message: "OAuth callback is invalid" });
    }
    const state: {
      ownerId: Id<"users">;
      codeVerifierCiphertext: string;
      redirectUri: string;
    } = await ctx.runMutation(internal.providerOAuthStore.consumeState, {
      provider: args.provider,
      stateHash: await sha256(args.state),
    });
    const verifier = await openProviderSecret(
      state.codeVerifierCiphertext,
      state.ownerId,
      args.provider,
      "pkce",
    );
    const token = await exchangeCode(args.provider, args.code, verifier, state.redirectUri);
    const account = await verifyAccount(args.provider, token.accessToken);
    const [accessTokenCiphertext, refreshTokenCiphertext, externalAccountRefCiphertext] = await Promise.all([
      sealProviderSecret(token.accessToken, state.ownerId, args.provider, "access"),
      token.refreshToken
        ? sealProviderSecret(token.refreshToken, state.ownerId, args.provider, "refresh")
        : undefined,
      account.accountRef
        ? sealProviderSecret(account.accountRef, state.ownerId, args.provider, "account")
        : undefined,
    ]);
    await ctx.runMutation(internal.providerOAuthStore.finalizeConnection, {
      ownerId: state.ownerId,
      provider: args.provider,
      accessTokenCiphertext,
      refreshTokenCiphertext,
      externalAccountRefCiphertext,
      tokenType: token.tokenType,
      scopes: token.scopes,
      externalAccountIdHash: await sha256(`${args.provider}:${account.id}`),
      accountLabel: account.label,
      expiresAt: token.expiresAt,
    });
    return null;
  },
});

export const disconnect = action({
  args: { provider: providerValidator },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Authentication required" });
    const ownerId: Id<"users"> = await ctx.runQuery(internal.providerOAuthStore.resolveOwner, {
      tokenIdentifier: identity.tokenIdentifier,
    });
    const credential: { accessTokenCiphertext: string; refreshTokenCiphertext?: string } | null =
      await ctx.runQuery(internal.providerOAuthStore.loadCredential, { ownerId, provider: args.provider });
    if (credential) {
      const accessToken = await openProviderSecret(
        credential.accessTokenCiphertext,
        ownerId,
        args.provider,
        "access",
      );
      await bestEffortUpstreamRevoke(args.provider, accessToken);
    }
    await ctx.runMutation(internal.providerOAuthStore.revokeConnection, { ownerId, provider: args.provider });
    return null;
  },
});

function providerConfig(provider: OAuthProvider): ProviderConfig {
  if (!isUserConnectableOAuthProvider(provider)) {
    throw new ConvexError({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Cloudflare is managed by iChef and is not a User Service Connection",
    });
  }
  if (provider === "github") {
    return requireConfig({
      clientId: process.env.GITHUB_APP_CLIENT_ID,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      scopes: [],
    }, provider);
  }
  return requireConfig({
    clientId: process.env.CONVEX_OAUTH_CLIENT_ID,
    clientSecret: process.env.CONVEX_OAUTH_CLIENT_SECRET,
    authorizationEndpoint: "https://dashboard.convex.dev/oauth/authorize/project",
    tokenEndpoint: "https://api.convex.dev/oauth/token",
    scopes: [],
  }, provider);
}

function requireConfig(
  config: Omit<ProviderConfig, "clientId" | "clientSecret"> & {
    clientId?: string;
    clientSecret?: string;
  },
  provider: OAuthProvider,
): ProviderConfig {
  if (!config.clientId || !config.clientSecret) {
    throw new ConvexError({
      code: "PROVIDER_NOT_CONFIGURED",
      message: `${provider} OAuth is not configured by the iChef operator`,
    });
  }
  return { ...config, clientId: config.clientId, clientSecret: config.clientSecret };
}

function callbackUri(provider: OAuthProvider): string {
  const base = process.env.OAUTH_CALLBACK_BASE_URL;
  if (!base) {
    throw new ConvexError({ code: "PROVIDER_NOT_CONFIGURED", message: "OAuth callback base URL is not configured" });
  }
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ConvexError({ code: "INVALID_CONFIGURATION", message: "OAuth callback base URL must be HTTPS" });
  }
  url.pathname = `/v1/oauth/${provider}/callback`;
  return url.toString();
}

function portalResultUri(provider: OAuthProvider, result: "connected" | "error"): string {
  const configured = process.env.PUBLIC_PORTAL_URL;
  if (!configured) throw new Error("PUBLIC_PORTAL_URL is not configured");
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_PORTAL_URL must be an HTTPS origin");
  }
  url.pathname = `/connect/${provider}`;
  url.searchParams.set("result", result);
  return url.toString();
}

export function providerCallbackResponse(provider: OAuthProvider, result: "connected" | "error"): Response {
  return Response.redirect(portalResultUri(provider, result), 303);
}

async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<ProviderToken> {
  const config = providerConfig(provider);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
  });
  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "iChef/0.1",
    },
    body,
    redirect: "error",
  });
  const value = await readJsonObject(response);
  if (!response.ok || typeof value.access_token !== "string" || value.access_token.length < 16) {
    throw new Error(`${provider} token exchange failed`);
  }
  const scopeValue = typeof value.scope === "string" ? value.scope : config.scopes.join(" ");
  const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
    ? Math.max(60, Math.min(value.expires_in, 365 * 24 * 60 * 60))
    : undefined;
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" && value.refresh_token.length >= 16
      ? value.refresh_token
      : undefined,
    tokenType: typeof value.token_type === "string" ? value.token_type.slice(0, 32) : "bearer",
    scopes: splitScopes(scopeValue),
    expiresAt: expiresIn ? Date.now() + expiresIn * 1_000 : undefined,
  };
}

async function verifyAccount(provider: OAuthProvider, accessToken: string): Promise<VerifiedAccount> {
  if (provider === "github") {
    const [userResponse, installationsResponse] = await Promise.all([
      fetch("https://api.github.com/user", { headers: githubHeaders(accessToken), redirect: "error" }),
      fetch("https://api.github.com/user/installations?per_page=100", {
        headers: githubHeaders(accessToken),
        redirect: "error",
      }),
    ]);
    const user = await readJsonObject(userResponse);
    const installations = await readJsonObject(installationsResponse);
    if (!userResponse.ok || (typeof user.id !== "number" && typeof user.id !== "string") || typeof user.login !== "string") {
      throw new Error("GitHub identity verification failed");
    }
    const expectedAppId = process.env.GITHUB_APP_ID;
    if (!expectedAppId) throw new Error("GITHUB_APP_ID is not configured");
    const values = Array.isArray(installations.installations) ? installations.installations : [];
    const installation = values.find((value) => {
      const row = asRecordOrNull(value);
      return row && String(row.app_id) === expectedAppId;
    });
    const installationRecord = asRecordOrNull(installation);
    if (!installationsResponse.ok || !installationRecord || installationRecord.id === undefined) {
      throw new Error("Install the iChef GitHub App before connecting GitHub");
    }
    return {
      id: String(user.id),
      label: user.login.slice(0, 160),
      accountRef: JSON.stringify({ installationId: String(installationRecord.id), login: user.login }),
    };
  }
  if (!isUserConnectableOAuthProvider(provider)) throw new Error("Provider is not user-connectable");
  const response = await fetch("https://api.convex.dev/v1/token_details", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    redirect: "error",
  });
  const details = await readJsonObject(response);
  if (!response.ok) throw new Error("Convex token verification failed");
  const projectId = firstString(details, ["projectId", "project_id", "project"]);
  const teamId = firstString(details, ["teamId", "team_id", "team"]);
  const id = projectId ?? teamId;
  if (!id) throw new Error("Convex token details did not identify a project or team");
  return {
    id,
    label: (projectId ? `Project ${projectId}` : `Team ${teamId}`).slice(0, 160),
    accountRef: JSON.stringify({ projectId, teamId }),
  };
}

async function bestEffortUpstreamRevoke(provider: OAuthProvider, accessToken: string): Promise<void> {
  try {
    if (provider === "github") {
      const config = providerConfig(provider);
      await fetch(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
          "content-type": "application/json",
          "user-agent": "iChef/0.1",
        },
        body: JSON.stringify({ access_token: accessToken }),
        redirect: "error",
      });
    }
  } catch {
    // Local deletion is the security boundary. Upstream revocation is best-effort
    // because providers can be unavailable or may not expose a revoke endpoint.
  }
}

function githubHeaders(accessToken: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "iChef/0.1",
  };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new Error("Provider response is too large");
  return asRecordOrNull(JSON.parse(raw)) ?? {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256) return candidate;
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return String(candidate);
  }
  return undefined;
}

function splitScopes(value?: string): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[\s,]+/u).map((scope) => scope.trim()).filter(Boolean))].slice(0, 100);
}
