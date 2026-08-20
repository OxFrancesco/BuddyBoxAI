import {
  LIMITS,
  RUNTIME_PROTOCOL_VERSION,
  artifactManifestDigest,
  parseAdmission,
  parseGeneration,
  parseIdentifier,
  parsePreview,
  parseReplacement,
  parseRun,
  parseScreenshot,
  parseSiteDeployment,
} from "./contracts/v1";
import { GatewayError, publicError } from "./errors";
import { sanitizedEventStream } from "./event-stream";
import {
  checkpointKey,
  deriveSandboxId,
  type CheckpointStore,
  type RuntimeHandle,
  type RuntimeLocator,
} from "./runtime";

interface Principal {
  userId: string;
  projectId: string;
  sandboxGeneration: number;
  action: "admission" | "run" | "cancel" | "heartbeat" | "checkpoint" | "replacement" | "preview" | "artifact_read" | "screenshot" | "deploy";
  capability: string;
  runId?: string;
  releaseId?: string;
  sourceRunId?: string;
  commitSha?: string;
  hostname?: string;
  artifactManifestDigest?: string;
}

export interface GatewayDependencies {
  authenticate(request: Request): Promise<Principal | null>;
  runtimeFor(locator: RuntimeLocator): RuntimeHandle;
  checkpoints: CheckpointStore;
  publishSite(request: {
    capability: string;
    projectId: string;
    releaseId: string;
    sourceRunId: string;
    commitSha: string;
    hostname: string;
    artifactManifestDigest: string;
    assets: Array<{ path: string; data: string; sha256: string }>;
  }): Promise<{ projectId: string; releaseId: string; deploymentRef: string; liveUrl: string }>;
  now?: () => Date;
  randomId?: () => string;
}

export interface V1Handler {
  fetch(request: Request): Promise<Response>;
}

const routePattern = /^\/v1\/projects\/([^/]+)\/generations\/([^/]+)(\/.*)?$/;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

function errorResponse(error: unknown): Response {
  const safe = publicError(error);
  return json(
    {
      error: { code: safe.code, message: safe.message, retryable: safe.retryable },
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
    },
    safe.status,
  );
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > LIMITS.requestBytes) {
    throw new GatewayError("too_large", "Request body exceeds the protocol limit.", 413);
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > LIMITS.requestBytes) {
      await reader.cancel("request limit exceeded");
      throw new GatewayError("too_large", "Request body exceeds the protocol limit.", 413);
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const source = new TextDecoder().decode(body);
  return source.length === 0 ? {} : (JSON.parse(source) as unknown);
}

function artifactPath(url: URL): string {
  const value = url.searchParams.get("path");
  if (!value || value.length > 512 || value.startsWith("/") || value.split("/").includes("..")) {
    throw new GatewayError("bad_request", "Artifact path must be a bounded workspace-relative path.", 400);
  }
  return value;
}

function checkpointObjectKey(principal: Principal, projectId: string, checkpointId: string): string {
  return checkpointKey(principal.userId, projectId, checkpointId);
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function requiredAction(method: string, suffix: string): Principal["action"] | null {
  if (method === "POST" && suffix === "/admission") return "admission";
  if (method === "POST" && suffix === "/runs") return "run";
  if (method === "POST" && /^\/runs\/[^/]+\/cancel$/.test(suffix)) return "cancel";
  if (method === "GET" && (suffix === "/heartbeat" || /^\/runs\/[^/]+\/heartbeat$/.test(suffix))) return "heartbeat";
  if (method === "POST" && suffix === "/checkpoints") return "checkpoint";
  if (method === "POST" && (suffix === "/replacement" || suffix === "/teardown")) return "replacement";
  if (method === "POST" && suffix === "/previews") return "preview";
  if (method === "POST" && suffix === "/screenshots") return "screenshot";
  if (method === "GET" && suffix === "/artifacts") return "artifact_read";
  if (method === "POST" && suffix === "/deployments") return "deploy";
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createV1Handler(dependencies: GatewayDependencies): V1Handler {
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());

  return {
    async fetch(request: Request): Promise<Response> {
      const principal = await dependencies.authenticate(request);
      if (!principal) {
        return errorResponse(new GatewayError("unauthorized", "Trusted gateway authority is required.", 401));
      }

      try {
        parseIdentifier(principal.userId, "userId");
        const url = new URL(request.url);
        const match = routePattern.exec(url.pathname);
        if (!match) throw new GatewayError("not_found", "Gateway route was not found.", 404);
        const projectId = parseIdentifier(match[1] ?? "", "projectId");
        const sandboxGeneration = parseGeneration(match[2] ?? "");
        const suffix = match[3] ?? "";
        const action = requiredAction(request.method, suffix);
        if (!action) throw new GatewayError("not_found", "Gateway route was not found.", 404);
        if (
          principal.projectId !== projectId ||
          principal.sandboxGeneration !== sandboxGeneration ||
          principal.action !== action
        ) {
          throw new GatewayError("unauthorized", "Capability is not valid for this Project operation.", 401);
        }
        const locator: RuntimeLocator = {
          userId: principal.userId,
          projectId,
          sandboxGeneration,
          sandboxId: await deriveSandboxId(principal.userId, projectId, sandboxGeneration),
        };
        const runtime = dependencies.runtimeFor(locator);

        if (request.method === "POST" && suffix === "/admission") {
          const admission = parseAdmission(await readBoundedJson(request));
          if (admission.capability !== principal.capability) {
            throw new GatewayError("unauthorized", "Nested capability does not match gateway authority.", 401);
          }
          const materialized = await runtime.materialize(admission);
          let restored = materialized.restored;
          if (admission.checkpointId) {
            const stored = await dependencies.checkpoints.get(
              checkpointObjectKey(principal, projectId, admission.checkpointId),
            );
            if (!stored) throw new GatewayError("not_found", "Checkpoint was not found.", 404);
            await runtime.restoreCheckpoint(stored);
            restored = true;
          }
          return json(
            {
              protocolVersion: RUNTIME_PROTOCOL_VERSION,
              sandboxGeneration,
              commitSha: materialized.commitSha,
              restored,
            },
            201,
          );
        }

        if (request.method === "POST" && suffix === "/runs") {
          const run = parseRun(await readBoundedJson(request));
          if (principal.runId !== run.runId) {
            throw new GatewayError("unauthorized", "Capability is not valid for this Run.", 401);
          }
          if (run.capability !== principal.capability) {
            throw new GatewayError("unauthorized", "Nested capability does not match gateway authority.", 401);
          }
          const upstream = await runtime.run(run);
          if (!upstream.ok || !upstream.body) {
            throw new GatewayError("runtime_unavailable", "Pi did not accept the Run.", 503, true);
          }
          return new Response(sanitizedEventStream(upstream.body, run.runId, now), {
            status: 202,
            headers: {
              "content-type": "application/x-ndjson; charset=utf-8",
              "cache-control": "no-store",
              "x-ichef-protocol-version": RUNTIME_PROTOCOL_VERSION,
            },
          });
        }

        const runAction = /^\/runs\/([^/]+)\/(cancel|heartbeat)$/.exec(suffix);
        if (runAction) {
          const runId = parseIdentifier(runAction[1] ?? "", "runId");
          if (principal.runId !== runId) {
            throw new GatewayError("unauthorized", "Capability is not valid for this Run.", 401);
          }
          if (request.method === "POST" && runAction[2] === "cancel") {
            const result = await runtime.cancel(runId);
            return json({ protocolVersion: RUNTIME_PROTOCOL_VERSION, runId, ...result }, 202);
          }
          if (request.method === "GET" && runAction[2] === "heartbeat") {
            return json({ protocolVersion: RUNTIME_PROTOCOL_VERSION, ...(await runtime.heartbeat(runId)) });
          }
        }

        if (request.method === "GET" && suffix === "/heartbeat") {
          if (principal.runId !== undefined) {
            throw new GatewayError("unauthorized", "Run-bound authority cannot access the Sandbox heartbeat.", 401);
          }
          return json({ protocolVersion: RUNTIME_PROTOCOL_VERSION, ...(await runtime.heartbeat()) });
        }

        if (request.method === "POST" && suffix === "/checkpoints") {
          await readBoundedJson(request);
          const checkpoint = await runtime.createCheckpoint();
          if (checkpoint.bytes.byteLength > LIMITS.checkpointBytes) {
            throw new GatewayError("too_large", "Checkpoint exceeds the protocol limit.", 413);
          }
          const checkpointId = parseIdentifier(randomId(), "checkpointId");
          await dependencies.checkpoints.put(checkpointObjectKey(principal, projectId, checkpointId), checkpoint.bytes);
          return json(
            {
              protocolVersion: RUNTIME_PROTOCOL_VERSION,
              checkpointId,
              bytes: checkpoint.bytes.byteLength,
              sha256: checkpoint.sha256,
              createdAt: now().toISOString(),
            },
            201,
          );
        }

        if (request.method === "POST" && suffix === "/replacement") {
          const replacement = parseReplacement(await readBoundedJson(request));
          if (replacement.nextGeneration !== sandboxGeneration + 1) {
            throw new GatewayError("conflict", "Replacement generation must immediately follow the current one.", 409);
          }
          const stored = await dependencies.checkpoints.get(
            checkpointObjectKey(principal, projectId, replacement.checkpointId),
          );
          if (!stored) throw new GatewayError("not_found", "Checkpoint was not found.", 404);
          const nextLocator: RuntimeLocator = {
            ...locator,
            sandboxGeneration: replacement.nextGeneration,
            sandboxId: await deriveSandboxId(principal.userId, projectId, replacement.nextGeneration),
          };
          const resumed = await dependencies.runtimeFor(nextLocator).restoreCheckpoint(stored);
          await runtime.destroy();
          return json(
            {
              protocolVersion: RUNTIME_PROTOCOL_VERSION,
              sandboxGeneration: replacement.nextGeneration,
              resumedFromCheckpoint: replacement.checkpointId,
              ...resumed,
            },
            201,
          );
        }

        if (request.method === "POST" && suffix === "/previews") {
          const preview = await runtime.startPreview(parsePreview(await readBoundedJson(request)));
          return json({ protocolVersion: RUNTIME_PROTOCOL_VERSION, ...preview }, 201);
        }

        if (request.method === "POST" && suffix === "/screenshots") {
          const screenshot = await runtime.captureScreenshot(parseScreenshot(await readBoundedJson(request)));
          if (screenshot.bytes.byteLength > LIMITS.artifactBytes) {
            throw new GatewayError("too_large", "Screenshot exceeds the artifact limit.", 413);
          }
          return new Response(responseBody(screenshot.bytes), {
            headers: {
              "content-type": screenshot.mediaType,
              "cache-control": "no-store",
              "x-ichef-protocol-version": RUNTIME_PROTOCOL_VERSION,
            },
          });
        }

        if (request.method === "GET" && suffix === "/artifacts") {
          const artifact = await runtime.readArtifact(artifactPath(url));
          if (artifact.bytes.byteLength > LIMITS.artifactBytes) {
            throw new GatewayError("too_large", "Artifact exceeds the protocol limit.", 413);
          }
          return new Response(responseBody(artifact.bytes), {
            headers: {
              "content-type": artifact.mediaType,
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
              "x-ichef-protocol-version": RUNTIME_PROTOCOL_VERSION,
            },
          });
        }

        if (request.method === "POST" && suffix === "/deployments") {
          const deployment = parseSiteDeployment(await readBoundedJson(request));
          const manifestDigest = await artifactManifestDigest(deployment.assets);
          if (
            principal.releaseId !== deployment.releaseId ||
            !principal.sourceRunId ||
            principal.commitSha !== deployment.commitSha ||
            principal.hostname !== deployment.hostname ||
            principal.artifactManifestDigest !== manifestDigest
          ) {
            throw new GatewayError("unauthorized", "Capability is not valid for this exact Release manifest.", 401);
          }
          let totalBytes = 0;
          const assets = [];
          for (const descriptor of deployment.assets) {
            const artifact = await runtime.readArtifact(descriptor.workspacePath);
            totalBytes += artifact.bytes.byteLength;
            if (totalBytes > LIMITS.artifactBytes) {
              throw new GatewayError("too_large", "Deployment exceeds the artifact limit.", 413);
            }
            if (await sha256(artifact.bytes) !== descriptor.sha256) {
              throw new GatewayError("conflict", "Deployment artifact digest does not match.", 409);
            }
            assets.push({ path: descriptor.path, data: base64(artifact.bytes), sha256: descriptor.sha256 });
          }
          const published = await dependencies.publishSite({
            capability: principal.capability,
            projectId,
            releaseId: deployment.releaseId,
            sourceRunId: principal.sourceRunId,
            commitSha: deployment.commitSha,
            hostname: deployment.hostname,
            artifactManifestDigest: manifestDigest,
            assets,
          });
          return json({ protocolVersion: RUNTIME_PROTOCOL_VERSION, ...published }, 201);
        }

        if (request.method === "POST" && suffix === "/teardown") {
          await runtime.destroy();
          return new Response(null, { status: 204 });
        }

        throw new GatewayError("not_found", "Gateway route was not found.", 404);
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "agent gateway request failed",
            method: request.method,
            path: new URL(request.url).pathname,
            code: publicError(error).code,
          }),
        );
        return errorResponse(error);
      }
    },
  };
}
