import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { cloudflareRuntime } from "./cloudflare-runtime";
import { LIMITS } from "./contracts/v1";
import { createV1Handler } from "./http-v1";

async function brokerEgress(request: Request, env: Env, provider: "openrouter" | "openai-codex" | "github") {
  const source = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");
  const cloudflareHeaders: string[] = [];
  headers.forEach((_value, key) => {
    if (key.startsWith("cf-")) cloudflareHeaders.push(key);
  });
  for (const key of cloudflareHeaders) headers.delete(key);
  headers.set("x-ichef-egress-provider", provider);
  if (provider !== "github") headers.delete("authorization");
  const target = new URL(`https://credential-broker.internal/v1/egress/${provider}${source.pathname}`);
  target.search = source.search;
  return env.CREDENTIAL_BROKER.fetch(
    new Request(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    }),
  );
}

async function packageRegistryEgress(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Package registry egress is read-only.", { status: 403 });
  }
  const source = new URL(request.url);
  source.protocol = "https:";
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("host");
  return fetch(new Request(source, { method: request.method, headers, redirect: "follow" }));
}

export class Sandbox extends BaseSandbox<Env> {
  enableInternet = false;
  interceptHttps = true;
}

Sandbox.outboundByHost = {
  "models.ichef.internal": (request, env) => brokerEgress(request, env, "openrouter"),
  "codex.ichef.internal": (request, env) => brokerEgress(request, env, "openai-codex"),
  "github.ichef.internal": (request, env) => brokerEgress(request, env, "github"),
  "registry.npmjs.org": (request) => packageRegistryEgress(request),
};

Sandbox.outbound = async () => new Response("Outbound destination is not permitted.", { status: 403 });

type GatewayAction = "admission" | "run" | "cancel" | "heartbeat" | "checkpoint" | "replacement" | "preview" | "artifact_read" | "screenshot" | "deploy";

async function authenticate(request: Request, env: Env): Promise<{
  userId: string;
  projectId: string;
  sandboxGeneration: number;
  action: GatewayAction;
  capability: string;
  runId?: string;
  releaseId?: string;
  sourceRunId?: string;
  commitSha?: string;
  hostname?: string;
  artifactManifestDigest?: string;
} | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > LIMITS.capabilityCharacters + 16) return null;
  const response = await env.CONTROL_PLANE.fetch(
    new Request("https://control-plane.internal/v1/agent-gateway/authenticate", {
      method: "POST",
      headers: { authorization },
    }),
  );
  if (!response.ok) return null;
  const body = await response.json<unknown>();
  if (
    typeof body !== "object" || body === null ||
    !("userId" in body) || typeof body.userId !== "string" ||
    !("projectId" in body) || typeof body.projectId !== "string" ||
    !("sandboxGeneration" in body) || !Number.isSafeInteger(body.sandboxGeneration) ||
    !("action" in body) || typeof body.action !== "string" ||
    !["admission", "run", "cancel", "heartbeat", "checkpoint", "replacement", "preview", "artifact_read", "screenshot", "deploy"].includes(body.action)
  ) return null;
  const authority = {
    userId: body.userId,
    projectId: body.projectId,
    sandboxGeneration: Number(body.sandboxGeneration),
    action: body.action as GatewayAction,
    capability: authorization.slice(7),
    ...("runId" in body && typeof body.runId === "string" ? { runId: body.runId } : {}),
    ...("releaseId" in body && typeof body.releaseId === "string" ? { releaseId: body.releaseId } : {}),
    ...("sourceRunId" in body && typeof body.sourceRunId === "string" ? { sourceRunId: body.sourceRunId } : {}),
    ...("commitSha" in body && typeof body.commitSha === "string" ? { commitSha: body.commitSha } : {}),
    ...("hostname" in body && typeof body.hostname === "string" ? { hostname: body.hostname } : {}),
    ...("artifactManifestDigest" in body && typeof body.artifactManifestDigest === "string" ? { artifactManifestDigest: body.artifactManifestDigest } : {}),
  };
  if ((authority.action === "run" || authority.action === "cancel") && !authority.runId) return null;
  if (authority.action === "deploy" && (!authority.releaseId || !authority.sourceRunId || !authority.commitSha || !authority.hostname || !authority.artifactManifestDigest)) return null;
  return authority;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handler = createV1Handler({
      authenticate: (candidate) => authenticate(candidate, env),
      runtimeFor: (locator) => cloudflareRuntime(env, locator),
      checkpoints: {
        async put(key, bytes) {
          await env.CHECKPOINTS.put(key, bytes, {
            httpMetadata: { contentType: "application/gzip" },
          });
        },
        async get(key) {
          const object = await env.CHECKPOINTS.get(key);
          if (!object) return null;
          if (object.size > LIMITS.checkpointBytes) return null;
          return new Uint8Array(await object.arrayBuffer());
        },
      },
      async publishSite(payload) {
        const response = await env.SITE_HOST.fetch(new Request("https://site-host.internal/v1/deployments", {
          method: "POST",
          headers: {
            authorization: `Bearer ${payload.capability}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload, (key, value) => key === "capability" ? undefined : value),
        }));
        const result = await response.json<unknown>().catch(() => null);
        if (!response.ok || !result || typeof result !== "object" ||
          !("projectId" in result) || typeof result.projectId !== "string" ||
          !("releaseId" in result) || typeof result.releaseId !== "string" ||
          !("deploymentRef" in result) || typeof result.deploymentRef !== "string" ||
          !("liveUrl" in result) || typeof result.liveUrl !== "string") {
          throw new Error("Managed site deployment failed");
        }
        return {
          projectId: result.projectId,
          releaseId: result.releaseId,
          deploymentRef: result.deploymentRef,
          liveUrl: result.liveUrl,
        };
      },
    });
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
