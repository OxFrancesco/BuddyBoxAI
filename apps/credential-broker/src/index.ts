interface Env {
  CONTROL_PLANE: Fetcher;
  CONVEX_CREDENTIAL_URL: string;
  ICHEF_CREDENTIAL_BROKER_SECRET: string;
}

const allowed = new Set(["openrouter", "openai-codex", "github"]);
const CODEX_PATH = "/v1/egress/openai-codex/backend-api/codex/responses";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
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
const responseHeaders = [
  "cache-control",
  "content-type",
  "openai-processing-ms",
  "retry-after",
  "x-request-id",
] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/v1\/egress\/([^/]+)\//.exec(url.pathname);
    if (!match || !allowed.has(match[1] ?? "")) return new Response("Not found", { status: 404 });
    const capability = request.headers.get("x-ichef-run-capability");
    if (!capability || capability.length > 8_192) return noStore("Unauthorized", 401);
    const authority = await env.CONTROL_PLANE.fetch(new Request("https://control-plane.internal/v1/agent-gateway/authenticate", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}` },
    }));
    if (!authority.ok) return noStore("Unauthorized", 401);
    const actor = await authority.json<unknown>();
    if (!isRunAuthority(actor)) return noStore("Unauthorized", 401);

    if (match[1] !== "openai-codex") {
      return Response.json(
        { error: "provider_connection_unavailable", retryable: true },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    if (request.method !== "POST" || url.pathname !== CODEX_PATH || url.search) {
      return noStore("Not found", 404);
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return noStore("Request too large", 413);
    }

    const credential = await resolveCodexCredential(env, actor.userId);
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
    const upstream = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers,
      body: request.body,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: selectedHeaders(upstream.headers, responseHeaders),
    });
  },
} satisfies ExportedHandler<Env>;

type CredentialResult =
  | { status: "ok"; accessToken: string; expiresAt: number }
  | { status: "missing" | "reauth" | "busy" | "unavailable" };

async function resolveCodexCredential(env: Env, userId: string): Promise<CredentialResult> {
  try {
    const response = await fetch(env.CONVEX_CREDENTIAL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ICHEF_CREDENTIAL_BROKER_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ownerId: userId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { status: "unavailable" };
    const body = await response.json<unknown>();
    if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true || !("result" in body)) {
      return { status: "unavailable" };
    }
    const result = body.result;
    if (!result || typeof result !== "object" || !("status" in result) || typeof result.status !== "string") {
      return { status: "unavailable" };
    }
    if (result.status === "ok" && "accessToken" in result && typeof result.accessToken === "string" &&
      "expiresAt" in result && typeof result.expiresAt === "number") {
      return { status: "ok", accessToken: result.accessToken, expiresAt: result.expiresAt };
    }
    if (["missing", "reauth", "busy", "unavailable"].includes(result.status)) {
      return { status: result.status as "missing" | "reauth" | "busy" | "unavailable" };
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
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

function noStore(body: string, status: number): Response {
  return new Response(body, { status, headers: { "cache-control": "no-store" } });
}

export const testables = { accountIdFromAccessToken, isRunAuthority, selectedHeaders };
