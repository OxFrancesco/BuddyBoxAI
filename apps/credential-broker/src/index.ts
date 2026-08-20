import {
  GITHUB_RUNTIME_PERMISSIONS,
  resolveGitHubEgressRoute,
} from "../../../packages/provisioning/src/github-egress";

export interface Env {
  CONTROL_PLANE: Fetcher;
  CONVEX_CREDENTIAL_URL: string;
  CONVEX_GITHUB_CREDENTIAL_URL: string;
  ICHEF_CREDENTIAL_BROKER_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

const allowed = new Set(["openrouter", "openai-codex", "github"]);
const CODEX_PATH = "/v1/egress/openai-codex/backend-api/codex/responses";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 128 * 1024 * 1024;
const GITHUB_API_VERSION = "2026-03-10";
const requestHeaders = [
  "accept",
  "content-encoding",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "user-agent",
  "x-client-request-id",
] as const;
const githubRequestHeaders = [
  "accept",
  "content-encoding",
  "content-type",
  "git-protocol",
  "if-modified-since",
  "if-none-match",
  "user-agent",
] as const;
const responseHeaders = [
  "cache-control",
  "content-type",
  "openai-processing-ms",
  "retry-after",
  "x-request-id",
] as const;
const githubResponseHeaders = [
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "link",
  "retry-after",
  "vary",
  "x-github-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

type FetcherFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SignAppJwt = (input: { appId: string; privateKeyPem: string; nowSeconds: number }) => Promise<string>;
type BrokerDependencies = {
  fetcher?: FetcherFunction;
  now?: () => number;
  signAppJwt?: SignAppJwt;
};
export type CredentialBroker = { fetch(request: Request, env: Env): Promise<Response> };

type CachedInstallationToken = { token: string; expiresAt: number };

export function createCredentialBroker(dependencies: BrokerDependencies = {}): CredentialBroker {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const signAppJwt = dependencies.signAppJwt ?? createGitHubAppJwt;
  const installationTokens = new Map<string, CachedInstallationToken>();

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const match = /^\/v1\/egress\/([^/]+)\//.exec(url.pathname);
      const provider = match?.[1] ?? "";
      if (!match || !allowed.has(provider)) return new Response("Not found", { status: 404 });
      const capability = runCapability(request, provider);
      if (!capability) return noStore("Unauthorized", 401);
      const authority = await env.CONTROL_PLANE.fetch(new Request("https://control-plane.internal/v1/agent-gateway/authenticate", {
        method: "POST",
        headers: { authorization: `Bearer ${capability}` },
      }));
      if (!authority.ok) return noStore("Unauthorized", 401);
      const actor = await authority.json<unknown>();
      if (!isRunAuthority(actor)) return noStore("Unauthorized", 401);

      if (provider === "github") {
        return handleGitHubEgress({ request, url, env, actor, fetcher, now, signAppJwt, installationTokens });
      }
      if (provider !== "openai-codex") {
        return Response.json(
          { error: "provider_connection_unavailable", retryable: true },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      if (request.method !== "POST" || url.pathname !== CODEX_PATH || url.search) {
        return noStore("Not found", 404);
      }
      const declaredLength = declaredContentLength(request.headers);
      if (declaredLength === "invalid" || (typeof declaredLength === "number" && declaredLength > MAX_REQUEST_BYTES)) {
        return noStore("Request too large", 413);
      }
      let body: Uint8Array | null;
      try {
        body = await readBoundedBody(request, MAX_REQUEST_BYTES);
      } catch {
        return noStore("Request too large", 413);
      }

      const credential = await resolveCodexCredential(env, actor.userId, fetcher);
      if (credential.status !== "ok") {
        return Response.json(
          { error: `codex_${credential.status}`, retryable: credential.status === "busy" || credential.status === "unavailable" },
          { status: credential.status === "reauth" || credential.status === "missing" ? 401 : 503, headers: { "cache-control": "no-store" } },
        );
      }
      const accountId = accountIdFromAccessToken(credential.accessToken);
      if (!accountId) return noStore("Credential unavailable", 503);
      const headers = selectedHeaders(request.headers, requestHeaders);
      headers.set("authorization", `Bearer ${credential.accessToken}`);
      headers.set("chatgpt-account-id", accountId);
      const upstream = await fetcher("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers,
        body: body && body.byteLength > 0 ? (body.buffer as ArrayBuffer) : null,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: selectedHeaders(upstream.headers, responseHeaders),
      });
    },
  };
}

export default createCredentialBroker();

type CredentialResult =
  | { status: "ok"; accessToken: string; expiresAt: number }
  | { status: "missing" | "reauth" | "busy" | "unavailable" };

type GitHubBindingResult =
  | { status: "ok"; installationId: number; repositoryId: number; repositoryFullName: string }
  | { status: "missing" | "reauth" | "unavailable" };

async function handleGitHubEgress(input: {
  request: Request;
  url: URL;
  env: Env;
  actor: { userId: string; projectId: string; action: "run" };
  fetcher: FetcherFunction;
  now: () => number;
  signAppJwt: SignAppJwt;
  installationTokens: Map<string, CachedInstallationToken>;
}): Promise<Response> {
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(input.request.method)) {
    return noStore("Not found", 404);
  }
  const declaredLength = declaredContentLength(input.request.headers);
  if (declaredLength === "invalid" || (typeof declaredLength === "number" && declaredLength > MAX_GITHUB_REQUEST_BYTES)) {
    return noStore("Request too large", 413);
  }
  const binding = await resolveGitHubBinding(input.env, input.actor.userId, input.actor.projectId, input.fetcher);
  if (binding.status !== "ok") {
    return Response.json(
      { error: `github_${binding.status}`, retryable: binding.status === "unavailable" },
      { status: binding.status === "missing" || binding.status === "reauth" ? 401 : 503, headers: { "cache-control": "no-store" } },
    );
  }
  const prefix = "/v1/egress/github";
  const route = resolveGitHubEgressRoute({
    method: input.request.method,
    pathname: input.url.pathname.slice(prefix.length),
    search: input.url.search,
    repositoryFullName: binding.repositoryFullName,
  });
  if (!route) return noStore("Not found", 404);

  let body: Uint8Array | null;
  try {
    body = await readBoundedBody(input.request, MAX_GITHUB_REQUEST_BYTES);
  } catch {
    return noStore("Request too large", 413);
  }
  const cacheKey = `${binding.installationId}:${binding.repositoryId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const credential = await installationToken({
      ...input,
      binding,
      cacheKey,
      force: attempt === 1,
    });
    if (!credential) return noStore("GitHub credential unavailable", 503);
    const headers = selectedHeaders(input.request.headers, githubRequestHeaders);
    headers.set("authorization", route.kind === "git"
      ? `Basic ${btoa(`x-access-token:${credential}`)}`
      : `Bearer ${credential}`);
    if (route.kind === "api") {
      headers.set("accept", headers.get("accept") ?? "application/vnd.github+json");
      headers.set("x-github-api-version", GITHUB_API_VERSION);
    }
    const upstream = await input.fetcher(route.upstreamUrl, {
      method: input.request.method,
      headers,
      body: body && body.byteLength > 0 ? (body.buffer as ArrayBuffer) : null,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (upstream.status === 401 && attempt === 0) {
      input.installationTokens.delete(cacheKey);
      continue;
    }
    if (upstream.status >= 300 && upstream.status < 400) return noStore("GitHub redirect refused", 502);
    const upstreamLength = declaredContentLength(upstream.headers);
    if (upstreamLength === "invalid" || (typeof upstreamLength === "number" && upstreamLength > MAX_GITHUB_RESPONSE_BYTES)) {
      await upstream.body?.cancel();
      return noStore("GitHub response too large", 502);
    }
    return new Response(limitResponseBody(upstream.body, MAX_GITHUB_RESPONSE_BYTES), {
      status: upstream.status,
      headers: selectedHeaders(upstream.headers, githubResponseHeaders),
    });
  }
  return noStore("GitHub credential unavailable", 503);
}

async function installationToken(input: {
  env: Env;
  binding: Extract<GitHubBindingResult, { status: "ok" }>;
  fetcher: FetcherFunction;
  now: () => number;
  signAppJwt: SignAppJwt;
  installationTokens: Map<string, CachedInstallationToken>;
  cacheKey: string;
  force: boolean;
}): Promise<string | null> {
  const current = input.installationTokens.get(input.cacheKey);
  if (!input.force && current && current.expiresAt > input.now() + 5 * 60_000) return current.token;
  try {
    const jwt = await input.signAppJwt({
      appId: input.env.GITHUB_APP_ID,
      privateKeyPem: input.env.GITHUB_APP_PRIVATE_KEY,
      nowSeconds: Math.floor(input.now() / 1_000),
    });
    const response = await input.fetcher(
      `https://api.github.com/app/installations/${input.binding.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "user-agent": "iChef/0.1",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        body: JSON.stringify({
          repository_ids: [input.binding.repositoryId],
          permissions: GITHUB_RUNTIME_PERMISSIONS,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok || (response.status >= 300 && response.status < 400)) return null;
    const value = await response.json<unknown>();
    if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" ||
      !value.token.startsWith("ghs_") || value.token.length > 4_096 ||
      !("expires_at" in value) || typeof value.expires_at !== "string") return null;
    const expiresAt = Date.parse(value.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= input.now() + 60_000 || expiresAt > input.now() + 65 * 60_000) return null;
    pruneTokenCache(input.installationTokens, input.now());
    input.installationTokens.set(input.cacheKey, { token: value.token, expiresAt });
    return value.token;
  } catch {
    return null;
  }
}

async function resolveCodexCredential(env: Env, userId: string, fetcher: FetcherFunction): Promise<CredentialResult> {
  try {
    const response = await fetcher(env.CONVEX_CREDENTIAL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ICHEF_CREDENTIAL_BROKER_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ownerId: userId }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (!response.ok || (response.status >= 300 && response.status < 400)) return { status: "unavailable" };
    const result = await brokerResult(response, ["missing", "reauth", "busy", "unavailable"]);
    if (result.ok && typeof result.value.accessToken === "string" && typeof result.value.expiresAt === "number") {
      return { status: "ok", accessToken: result.value.accessToken, expiresAt: result.value.expiresAt };
    }
    if (!result.ok && result.status !== "invalid") return { status: result.status as Exclude<CredentialResult["status"], "ok"> };
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

async function resolveGitHubBinding(env: Env, userId: string, projectId: string, fetcher: FetcherFunction): Promise<GitHubBindingResult> {
  try {
    const response = await fetcher(env.CONVEX_GITHUB_CREDENTIAL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ICHEF_CREDENTIAL_BROKER_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ownerId: userId, projectId }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (!response.ok || (response.status >= 300 && response.status < 400)) return { status: "unavailable" };
    const result = await brokerResult(response, ["missing", "reauth", "unavailable"]);
    if (
      result.ok &&
      Number.isSafeInteger(result.value.installationId) && Number(result.value.installationId) > 0 &&
      Number.isSafeInteger(result.value.repositoryId) && Number(result.value.repositoryId) > 0 &&
      typeof result.value.repositoryFullName === "string" && result.value.repositoryFullName.length <= 141
    ) {
      return {
        status: "ok",
        installationId: Number(result.value.installationId),
        repositoryId: Number(result.value.repositoryId),
        repositoryFullName: result.value.repositoryFullName,
      };
    }
    if (!result.ok && (result.status === "missing" || result.status === "reauth")) return { status: result.status };
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

type ParsedBrokerResult = { ok: true; value: Record<string, unknown> } | { ok: false; status: string };

async function brokerResult(response: Response, allowedStatuses: readonly string[]): Promise<ParsedBrokerResult> {
  const body = await response.json<unknown>();
  if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true || !("result" in body) ||
    !body.result || typeof body.result !== "object" || !("status" in body.result) || typeof body.result.status !== "string") {
    return { ok: false, status: "invalid" };
  }
  const value = body.result as Record<string, unknown>;
  if (value.status === "ok") return { ok: true, value };
  return { ok: false, status: allowedStatuses.includes(value.status as string) ? value.status as string : "invalid" };
}

function runCapability(request: Request, provider: string): string | null {
  let capability = request.headers.get("x-ichef-run-capability");
  if (!capability && provider === "github") {
    const authorization = request.headers.get("authorization") ?? "";
    capability = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
  }
  return capability && capability.length <= 8_192 ? capability : null;
}

function isRunAuthority(value: unknown): value is { userId: string; projectId: string; action: "run" } {
  return Boolean(value && typeof value === "object" &&
    "userId" in value && typeof value.userId === "string" &&
    "projectId" in value && typeof value.projectId === "string" &&
    "action" in value && value.action === "run");
}

function selectedHeaders(source: Headers, names: readonly string[]): Headers {
  const result = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value) result.set(name, value);
  }
  return result;
}

function accountIdFromAccessToken(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const value = JSON.parse(atob(normalized)) as { "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } };
    const accountId = value["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

async function createGitHubAppJwt(input: { appId: string; privateKeyPem: string; nowSeconds: number }): Promise<string> {
  if (!/^\d+$/.test(input.appId)) throw new Error("invalid GitHub App id");
  const pem = input.privateKeyPem.replaceAll("\\n", "\n").trim();
  const bytes = privateKeyDerFromPem(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: input.nowSeconds - 60,
    exp: input.nowSeconds + 9 * 60,
    iss: input.appId,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function privateKeyDerFromPem(pem: string): Uint8Array {
  const pkcs8 = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/.exec(pem);
  if (pkcs8) return decodeBase64Der(pkcs8[1]!);
  const pkcs1 = /^-----BEGIN RSA PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END RSA PRIVATE KEY-----$/.exec(pem);
  if (!pkcs1) throw new Error("invalid GitHub App key");
  const rsaPrivateKey = decodeBase64Der(pkcs1[1]!);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  );
  return derElement(0x30, concatenate(version, rsaAlgorithm, derElement(0x04, rsaPrivateKey)));
}

function decodeBase64Der(value: string): Uint8Array {
  const normalized = value.replaceAll(/\s/g, "");
  if (!normalized) throw new Error("invalid GitHub App key");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function derElement(tag: number, contents: Uint8Array): Uint8Array {
  const length = derLength(contents.byteLength);
  return concatenate(Uint8Array.of(tag), length, contents);
}

function derLength(value: number): Uint8Array {
  if (value < 0x80) return Uint8Array.of(value);
  const bytes: number[] = [];
  for (let remaining = value; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function declaredContentLength(headers: Headers): number | "invalid" | null {
  const value = headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return "invalid";
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : "invalid";
}

async function readBoundedBody(request: Request, maximum: number): Promise<Uint8Array | null> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error("request body too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function limitResponseBody(body: ReadableStream<Uint8Array> | null, maximum: number): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let length = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        return controller.error(new Error("GitHub response too large"));
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function pruneTokenCache(cache: Map<string, CachedInstallationToken>, now: number) {
  for (const [key, value] of cache) if (value.expiresAt <= now + 5 * 60_000) cache.delete(key);
  while (cache.size >= 256) cache.delete(cache.keys().next().value as string);
}

function noStore(body: string, status: number): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

export const testables = {
  accountIdFromAccessToken,
  createGitHubAppJwt,
  declaredContentLength,
  isRunAuthority,
  runCapability,
  selectedHeaders,
};
