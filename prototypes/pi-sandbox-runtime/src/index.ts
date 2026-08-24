import { getSandbox, type Sandbox as SandboxClient } from "@cloudflare/sandbox";
import { withLifecycleAuthorization } from "./lifecycle-auth";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<SandboxClient>;
  BUDDYBOX_PROTOTYPE_SECRET?: string;
}

const runnerPort = 8790;
const previewPort = 4173;
const idPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;

function sandboxFor(env: Env, id: string) {
  return getSandbox(env.Sandbox, id, {
    transport: "rpc",
    enableDefaultSession: false,
    sleepAfter: "12s",
    normalizeId: true,
    labels: { workload: "buddybox-pi-prototype" },
  });
}

function jsonError(error: unknown, status = 500): Response {
  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

async function ensureRunner(sandbox: ReturnType<typeof sandboxFor>) {
  const existing = (await sandbox.listProcesses()).find((process) => process.id === "pi-runtime");
  if (existing?.status === "running" || existing?.status === "starting") return existing;

  const process = await sandbox.startProcess("bun /opt/buddybox-pi-prototype/src/server.ts", {
    processId: "pi-runtime",
    cwd: "/workspace",
  });
  await process.waitForPort(runnerPort, { path: "/health", status: 200 });
  return process;
}

function containerRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.hostname = "container";
  url.port = "";
  url.pathname = pathname;
  return new Request(url, request);
}

async function proxyRunner(request: Request, sandbox: ReturnType<typeof sandboxFor>, pathname: string) {
  await ensureRunner(sandbox);
  return sandbox.containerFetch(containerRequest(request, pathname), runnerPort);
}

const seedFiles: Record<string, string> = {
  "/workspace/package.json": JSON.stringify(
    {
      name: "buddybox-pi-prototype-site",
      private: true,
      type: "module",
      scripts: {
        test: "bun test",
        build: "bun build src/site-server.ts --outdir dist --target bun",
        dev: "bun src/site-server.ts",
      },
    },
    null,
    2,
  ),
  "/workspace/src/site-server.ts": [
    'import { headline } from "./generated";',
    "",
    'const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BuddyBox Pi probe</title><style>body{font-family:system-ui;background:#171412;color:#fff7ed;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:42rem;padding:3rem;border:1px solid #6b5547;border-radius:1.5rem;background:#211b17}small{color:#f59e0b;text-transform:uppercase;letter-spacing:.18em}</style></head><body><main><small>Cloudflare Sandbox + Pi</small><h1>${headline}</h1><p>This page was produced by the real Pi coding loop using a deterministic credential-free model.</p></main></body></html>`;',
    "",
    'Bun.serve({ hostname: "0.0.0.0", port: 4173, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });',
    'console.log("preview ready on 4173");',
    "",
  ].join("\n"),
  "/workspace/src/generated.test.ts": `import { expect, test } from "bun:test";
import { headline } from "./generated";

test("Pi generated the expected headline", () => {
  expect(headline).toBe("Dinner is served by BuddyBox");
});
`,
  "/workspace/AGENTS.md": `# PROTOTYPE workspace

Use Bun. This workspace is disposable. Verify every change with bun test and bun run build.
`,
};

async function seed(sandbox: ReturnType<typeof sandboxFor>) {
  await sandbox.exec("find /workspace -mindepth 1 -delete", { timeout: 20_000 });
  await sandbox.mkdir("/workspace/src", { recursive: true });
  for (const [path, content] of Object.entries(seedFiles)) await sandbox.writeFile(path, content);
  const git = await sandbox.exec(
    'git init && git config user.email "prototype@buddybox.local" && git config user.name "BuddyBox Prototype" && git add . && git commit -m "Initial prototype"',
    { timeout: 20_000 },
  );
  if (!git.success) throw new Error(`git seed failed: ${git.stderr}`);
  await ensureRunner(sandbox);
  const runtime = await sandbox.exec(
    "bun --version && node --version && git --version && du -sb /opt/buddybox-pi-prototype",
    { timeout: 20_000 },
  );
  if (!runtime.success) throw new Error(`runtime inspection failed: ${runtime.stderr}`);
  const [bunVersion, nodeVersion, gitVersion, footprint] = runtime.stdout.trim().split("\n");
  const network = await sandbox.exec(
    "curl --max-time 5 --silent --output /dev/null --write-out '%{http_code}' https://example.com",
    { timeout: 10_000 },
  );
  return {
    bunVersion,
    nodeVersion,
    gitVersion,
    runnerBytes: Number(footprint?.split(/\s+/)[0]),
    outboundNetwork: { reachable: network.success, status: network.stdout.trim() },
  };
}

async function inspectIdleRestart(sandbox: ReturnType<typeof sandboxFor>) {
  const processesBefore = await sandbox.listProcesses();
  let generatedFileSurvived = false;
  let generatedFileError: string | undefined;
  try {
    const generated = await sandbox.readFile("/workspace/src/generated.ts");
    generatedFileSurvived = generated.content.includes("Dinner is served by BuddyBox");
  } catch (error) {
    generatedFileError = error instanceof Error ? error.message : String(error);
  }
  await ensureRunner(sandbox);
  const health = await sandbox.containerFetch(new Request("http://container/health"), runnerPort);
  return {
    configuredIdleAfter: "12s",
    processesBeforeRecovery: processesBefore.map((process) => ({
      id: process.id,
      status: process.status,
    })),
    generatedFileSurvived,
    generatedFileError,
    runnerHealth: await health.json(),
  };
}

async function startPreview(sandbox: ReturnType<typeof sandboxFor>) {
  const existing = (await sandbox.listProcesses()).find((process) => process.id === "preview");
  const process =
    existing?.status === "running" || existing?.status === "starting"
      ? existing
      : await sandbox.startProcess("bun run dev", {
          processId: "preview",
          cwd: "/workspace",
        });
  await process.waitForPort(previewPort, { path: "/", status: 200 });

  const internal = await sandbox.containerFetch(new Request("http://container/"), previewPort);
  const html = await internal.text();

  let tunnelUrl: string | undefined;
  let tunnelError: string | undefined;
  try {
    tunnelUrl = (await sandbox.tunnels.get(previewPort)).url;
  } catch (error) {
    tunnelError = error instanceof Error ? error.message : String(error);
  }
  return { internalStatus: internal.status, containsHeadline: html.includes("Dinner is served by BuddyBox"), tunnelUrl, tunnelError };
}

async function checkpointAndReplace(env: Env, id: string) {
  const startedAt = Date.now();
  const current = sandboxFor(env, id);
  const archive = "/tmp/buddybox-checkpoint.tgz";
  const packed = await current.exec(`tar -C /workspace -czf ${archive} .`, { timeout: 30_000 });
  if (!packed.success) throw new Error(`checkpoint failed: ${packed.stderr}`);
  const checkpoint = await current.readFile(archive, { encoding: "base64" });
  await current.destroy();

  const recoveredId = `${id.slice(0, 37)}-recovered`;
  const replacement = sandboxFor(env, recoveredId);
  await replacement.mkdir("/workspace", { recursive: true });
  await replacement.writeFile(archive, checkpoint.content, { encoding: "base64" });
  const restored = await replacement.exec(`tar -C /workspace -xzf ${archive}`, { timeout: 30_000 });
  if (!restored.success) throw new Error(`restore failed: ${restored.stderr}`);
  await ensureRunner(replacement);
  const health = await replacement.containerFetch(new Request("http://container/health"), runnerPort);
  const generated = await replacement.readFile("/workspace/src/generated.ts");
  const git = await replacement.exec("git rev-parse --is-inside-work-tree && git status --short", {
    cwd: "/workspace",
    timeout: 20_000,
  });
  return {
    recoveredSandboxId: recoveredId,
    checkpointBytes: checkpoint.size,
    elapsedMs: Date.now() - startedAt,
    generatedFileRestored: generated.content.includes("Dinner is served by BuddyBox"),
    gitRepositoryRestored: git.success && git.stdout.startsWith("true"),
    gitStatus: git.stdout.trim().split("\n").slice(1),
    runnerHealth: await health.json(),
  };
}

export default {
  fetch: withLifecycleAuthorization<Env>(async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/sandboxes\/([^/]+)\/(setup|runs|preview|state|recover|destroy)(.*)$/);
    if (!match) return new Response("PROTOTYPE: use /api/sandboxes/:id/*", { status: 404 });

    const [, id, action, rest] = match;
    if (!idPattern.test(id)) return jsonError(new Error("invalid sandbox id"), 400);
    const sandbox = sandboxFor(env, id);

    try {
      if (request.method === "POST" && action === "setup") {
        const startedAt = Date.now();
        const runtime = await seed(sandbox);
        return Response.json({ ok: true, startupMs: Date.now() - startedAt, runtime });
      }
      if (action === "runs") {
        return proxyRunner(request, sandbox, `/runs${rest}`);
      }
      if (request.method === "POST" && action === "preview") {
        return Response.json({ ok: true, ...(await startPreview(sandbox)) });
      }
      if (request.method === "POST" && action === "state") {
        return Response.json({ ok: true, ...(await inspectIdleRestart(sandbox)) });
      }
      if (request.method === "POST" && action === "recover") {
        return Response.json({ ok: true, ...(await checkpointAndReplace(env, id)) });
      }
      if (request.method === "POST" && action === "destroy") {
        await sandbox.destroy();
        const recoveredId = `${id.slice(0, 37)}-recovered`;
        if (recoveredId !== id) await sandboxFor(env, recoveredId).destroy();
        return Response.json({ ok: true });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (error) {
      return jsonError(error);
    }
  }),
};
