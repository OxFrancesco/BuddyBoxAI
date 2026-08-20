export {};

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const baseUrl = process.env.ICHEF_PROBE_URL ?? "http://127.0.0.1:8877";
const sharedSecret = process.env.ICHEF_PROTOTYPE_SECRET;
if (!sharedSecret || sharedSecret.length < 32) {
  throw new Error("ICHEF_PROTOTYPE_SECRET must contain at least 32 characters");
}
const sandboxId = `pi-probe-${Date.now().toString(36)}`;
const execFileAsync = promisify(execFile);

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${sharedSecret}`);
  const response = await fetch(`${baseUrl}/api/sandboxes/${sandboxId}${path}`, {
    method: "POST",
    ...init,
    headers,
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}

const report: Record<string, unknown> = {
  prototype: "pi-sandbox-runtime",
  sandboxId,
  startedAt: new Date().toISOString(),
};

async function consumeRun(response: Response) {
  return (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((entry) => JSON.parse(entry));
}

try {
  report.setup = await (await request("/setup")).json();

  const runStartedAt = performance.now();
  const run = await request("/runs", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: "initial-build",
      prompt: "Create the prototype website module and verify the project with Bun.",
    }),
  });
  const events = await consumeRun(run);
  report.run = {
    elapsedMs: Math.round(performance.now() - runStartedAt),
    events,
    leakedRawToolArguments: events.some((event) => "args" in event || "command" in event || "content" in event),
  };

  const cancelledRun = await request("/runs", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: "cancel-run",
      prompt: "Keep drafting a long project plan until I cancel this run.",
      scenario: "slow",
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const abort = await (await request("/runs/cancel-run/abort")).json();
  const cancelledEvents = await consumeRun(cancelledRun);
  report.cancellation = {
    abort,
    events: cancelledEvents,
    outcome: cancelledEvents.findLast((event) => event.type === "outcome")?.outcome,
  };

  const preview = (await (await request("/preview")).json()) as {
    tunnelUrl?: string;
    [key: string]: unknown;
  };
  let external: Record<string, unknown> = { attempted: false };
  if (preview.tunnelUrl) {
    try {
      const response = await fetch(preview.tunnelUrl);
      const html = await response.text();
      external = {
        attempted: true,
        status: response.status,
        containsHeadline: html.includes("Dinner is served by iChef"),
      };
    } catch (error) {
      external = {
        attempted: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  report.preview = { ...preview, external };

  const idleStartedAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  let idleState: { generatedFileSurvived?: boolean; [key: string]: unknown };
  try {
    idleState = (await (await request("/state")).json()) as {
      generatedFileSurvived?: boolean;
      [key: string]: unknown;
    };
  } catch (error) {
    idleState = {
      ok: false,
      generatedFileSurvived: false,
      wakeError: error instanceof Error ? error.message : String(error),
    };
    await request("/destroy");
  }
  report.idleRestart = {
    waitedMs: Math.round(performance.now() - idleStartedAt),
    state: idleState,
  };
  if (!idleState.generatedFileSurvived) {
    const recoverySetup = await (await request("/setup")).json();
    const recoveryRun = await request("/runs", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "rebuild-before-checkpoint",
        prompt: "Rebuild the prototype module so checkpoint recovery can be tested.",
      }),
    });
    report.rebuildBeforeCheckpoint = {
      setup: recoverySetup,
      events: await consumeRun(recoveryRun),
    };
  }
  report.recovery = await (await request("/recover")).json();

  try {
    const image = await execFileAsync("docker", [
      "image",
      "ls",
      "cloudflare-dev/sandbox",
      "--format",
      "{{.Size}} {{.ID}}",
    ]);
    const [size, id] = image.stdout.trim().split("\n")[0]?.split(" ") ?? [];
    report.image = { dockerVirtualSize: size, imageId: id };
  } catch (error) {
    report.image = { error: error instanceof Error ? error.message : String(error) };
  }

  report.completedAt = new Date().toISOString();
  const elapsedSeconds = (Date.now() - Date.parse(String(report.startedAt))) / 1000;
  const memoryUsd = 0.25 * elapsedSeconds * 0.0000025;
  const diskUsd = 2 * elapsedSeconds * 0.00000007;
  const cpuUpperBoundUsd = (1 / 16) * elapsedSeconds * 0.00002;
  report.cost = {
    elapsedSeconds,
    containerUpperBoundUsd: Number((memoryUsd + diskUsd + cpuUpperBoundUsd).toFixed(8)),
    note: "Conservative lite-instance upper bound for the whole wall-clock probe; excludes included usage, network, Worker, Durable Object, and logs.",
  };
  report.verdict = "runtime-proof-complete";
} catch (error) {
  report.verdict = "runtime-proof-failed";
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    report.cleanup = await (await request("/destroy")).json();
  } catch (error) {
    report.cleanup = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

console.log(JSON.stringify(report, null, 2));
if (report.verdict !== "runtime-proof-complete") process.exitCode = 1;
