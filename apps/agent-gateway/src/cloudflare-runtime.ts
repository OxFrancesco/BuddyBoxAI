import { getSandbox, type Sandbox as SandboxClient } from "@cloudflare/sandbox";
import { LIMITS, type AdmissionRequest, type PreviewRequest, type RunRequest, type ScreenshotRequest } from "./contracts/v1";
import { GatewayError } from "./errors";
import { repositoryMaterialization } from "./repository";
import type { RuntimeHandle, RuntimeLocator } from "./runtime";

const runnerPort = 8790;
const workspace = "/workspace";
const archive = "/tmp/buddybox-checkpoint.tgz";

type Client = ReturnType<typeof getSandbox>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function internalRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://container${path}`, init);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function mediaType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".txt") || path.endsWith(".log")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function ensureRunner(sandbox: Client): Promise<void> {
  const existing = (await sandbox.listProcesses()).find((process) => process.id === "buddybox-agent-runner");
  if (existing?.status !== "running" && existing?.status !== "starting") {
    const process = await sandbox.startProcess("bun /opt/buddybox-agent-runner/src/server.ts", {
      processId: "buddybox-agent-runner",
      cwd: workspace,
      autoCleanup: false,
    });
    await process.waitForPort(runnerPort, { path: "/v1/health", status: 200 });
  }
}

async function boundedJson<T>(response: Response, maxBytes = LIMITS.requestBytes): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new GatewayError("runtime_unavailable", "Runner response was too large.", 503);
  if (!response.body) throw new GatewayError("runtime_unavailable", "Runner response was empty.", 503);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel("runner response limit exceeded");
      throw new GatewayError("runtime_unavailable", "Runner response was too large.", 503);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function cloudflareRuntime(env: Env, locator: RuntimeLocator): RuntimeHandle {
  const sandbox = getSandbox(env.Sandbox as DurableObjectNamespace<SandboxClient>, locator.sandboxId, {
    transport: "rpc",
    enableDefaultSession: false,
    sleepAfter: "10m",
    normalizeId: true,
    labels: {
      workload: "buddybox-agent",
      project: locator.projectId,
      generation: String(locator.sandboxGeneration),
    },
  });

  return {
    async materialize(request: AdmissionRequest) {
      await sandbox.exec(`find ${workspace} -mindepth 1 -delete`, { timeout: 30_000 });
      const materialization = repositoryMaterialization(request);
      const result = await sandbox.exec(materialization.command, {
        env: materialization.env,
        timeout: 120_000,
      });
      if (!result.success) throw new GatewayError("runtime_unavailable", "Repository materialization failed.", 503, true);
      const commitSha = result.stdout.trim().split("\n").at(-1) ?? "";
      if (!/^[a-f0-9]{40}$/i.test(commitSha)) {
        throw new GatewayError("runtime_unavailable", "Repository did not produce a valid commit.", 503);
      }
      return { commitSha, restored: false };
    },

    async run(request: RunRequest) {
      await ensureRunner(sandbox);
      return sandbox.containerFetch(
        internalRequest("/v1/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        }),
        runnerPort,
      );
    },

    async cancel(runId: string) {
      await ensureRunner(sandbox);
      const response = await sandbox.containerFetch(
        internalRequest(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
        runnerPort,
      );
      if (response.status === 404) return { accepted: false };
      if (!response.ok) throw new GatewayError("runtime_unavailable", "Runner cancellation failed.", 503, true);
      return boundedJson<{ accepted: boolean }>(response);
    },

    async heartbeat(runId?: string) {
      await ensureRunner(sandbox);
      const path = runId ? `/v1/runs/${encodeURIComponent(runId)}/heartbeat` : "/v1/health";
      const response = await sandbox.containerFetch(internalRequest(path), runnerPort);
      if (response.status === 404) {
        return { runId, state: "missing" as const, lastEventSequence: 0, observedAt: new Date().toISOString() };
      }
      if (!response.ok) throw new GatewayError("runtime_unavailable", "Runner heartbeat failed.", 503, true);
      return boundedJson<{
        runId?: string;
        state: "idle" | "starting" | "running" | "stopping" | "stopped" | "missing";
        lastEventSequence: number;
        observedAt: string;
      }>(response);
    },

    async createCheckpoint() {
      const packed = await sandbox.exec(
        [
          "set -eu",
          `rm -f ${archive}`,
          `tar -C ${workspace} --exclude='./node_modules' --exclude='./.env' --exclude='./.env.*' -czf ${archive} .`,
          `test \"$(stat -c %s ${archive})\" -le ${LIMITS.checkpointBytes}`,
        ].join("\n"),
        { timeout: 120_000 },
      );
      if (!packed.success) throw new GatewayError("checkpoint_failed", "Checkpoint creation failed or exceeded its limit.", 500, true);
      const file = await sandbox.readFile(archive, { encoding: "base64" });
      const bytes = fromBase64(file.content);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(bytes)));
      const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return { bytes, sha256 };
    },

    async restoreCheckpoint(bytes: Uint8Array) {
      if (bytes.byteLength > LIMITS.checkpointBytes) throw new GatewayError("too_large", "Checkpoint exceeds its limit.", 413);
      await sandbox.mkdir(workspace, { recursive: true });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(ownedBytes(bytes));
          controller.close();
        },
      });
      await sandbox.writeFile(archive, stream);
      const restored = await sandbox.exec(
        [
          "set -eu",
          `tar -tzf ${archive} | awk 'BEGIN { bad=0 } /^\\// || /(^|\\/)\\.\\.(\\/|$)/ { bad=1 } END { exit bad }'`,
          `find ${workspace} -mindepth 1 -delete`,
          `tar -C ${workspace} -xzf ${archive}`,
          `rm -f ${archive}`,
          `git -C ${workspace} rev-parse HEAD`,
        ].join("\n"),
        { timeout: 120_000 },
      );
      if (!restored.success) throw new GatewayError("checkpoint_failed", "Checkpoint restore failed.", 500, true);
      const commitSha = restored.stdout.trim().split("\n").at(-1) ?? "";
      if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new GatewayError("checkpoint_failed", "Restored Git state is invalid.", 500);
      const sessions = await sandbox.exec(`find ${workspace}/.buddybox/pi-sessions -type f -name '*.jsonl' 2>/dev/null | wc -l`);
      return { commitSha, sessionCount: Number(sessions.stdout.trim() || "0") };
    },

    async startPreview(request: PreviewRequest) {
      const processId = `preview-${request.port}`;
      const existing = (await sandbox.listProcesses()).find((process) => process.id === processId);
      const process =
        existing?.status === "running" || existing?.status === "starting"
          ? existing
          : await sandbox.startProcess(request.command, { processId, cwd: workspace, autoCleanup: false });
      await process.waitForPort(request.port, { path: "/", status: 200 });
      const tunnel = await sandbox.tunnels.get(request.port, request.name ? { name: request.name } : undefined);
      return { url: tunnel.url, port: request.port };
    },

    async captureScreenshot(request: ScreenshotRequest) {
      await ensureRunner(sandbox);
      const response = await sandbox.containerFetch(
        internalRequest("/v1/screenshots", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        }),
        runnerPort,
      );
      if (!response.ok) throw new GatewayError("runtime_unavailable", "Screenshot capture failed.", 503, true);
      const result = await boundedJson<{ base64: string }>(response, Math.ceil((LIMITS.artifactBytes * 4) / 3) + 1024);
      return { bytes: fromBase64(result.base64), mediaType: "image/png" as const };
    },

    async readArtifact(path: string) {
      const fullPath = `${workspace}/${path}`;
      const measured = await sandbox.exec(
        `resolved=$(realpath -e -- ${shellQuote(fullPath)}) && case "$resolved" in /workspace/*) ;; *) exit 64 ;; esac && printf '%s\\n' "$resolved" && stat -c %s -- "$resolved"`,
        { timeout: 10_000 },
      );
      if (!measured.success) throw new GatewayError("not_found", "Artifact was not found.", 404);
      const [resolvedPath, size] = measured.stdout.trim().split("\n");
      if (!resolvedPath?.startsWith("/workspace/") || Number(size) > LIMITS.artifactBytes) {
        throw new GatewayError("too_large", "Artifact exceeds its limit.", 413);
      }
      const file = await sandbox.readFile(resolvedPath, { encoding: "base64" });
      return { bytes: fromBase64(file.content), mediaType: mediaType(path) };
    },

    async destroy() {
      await sandbox.destroy();
    },
  };
}
