export const RUNTIME_PROTOCOL_VERSION = "2026-08-13" as const;

export const LIMITS = {
  requestBytes: 96 * 1024,
  promptCharacters: 32_000,
  capabilityCharacters: 4_096,
  branchCharacters: 200,
  commandCharacters: 1_024,
  artifactBytes: 8 * 1024 * 1024,
  checkpointBytes: 32 * 1024 * 1024,
  eventLineBytes: 16 * 1024,
  eventCount: 10_000,
  eventSummaryCharacters: 512,
} as const;

export type ModelProvider = "openai-codex" | "openrouter";
export type RunOutcome = "succeeded" | "failed" | "cancelled" | "needs_attention";

export class ProtocolLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolLimitError";
  }
}

export interface AdmissionRequest {
  repository: string;
  branch: string;
  capability: string;
  checkpointId?: string;
}

export interface RunRequest {
  runId: string;
  prompt: string;
  provider: ModelProvider;
  model: string;
  capability: string;
  resume?: boolean;
  verificationCommands?: string[];
}

export interface PreviewRequest {
  command: string;
  port: number;
  name?: string;
}

export interface ScreenshotRequest {
  port: number;
  path?: string;
  width?: number;
  height?: number;
}

export interface ReplacementRequest {
  checkpointId: string;
  nextGeneration: number;
}

export interface SiteDeploymentRequest {
  releaseId: string;
  commitSha: string;
  hostname: string;
  assets: Array<{ path: string; workspacePath: string; sha256: string }>;
}

export async function artifactManifestDigest(
  assets: ReadonlyArray<Pick<SiteDeploymentRequest["assets"][number], "path" | "sha256">>,
): Promise<string> {
  const canonical = JSON.stringify({
    version: 1,
    assets: assets
      .map(({ path, sha256 }) => ({ path, sha256 }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface PublicRuntimeEvent {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  sequence: number;
  type:
    | "run.accepted"
    | "agent.started"
    | "tool.started"
    | "tool.finished"
    | "verification.finished"
    | "run.outcome"
    | "runtime.warning";
  runId: string;
  at: string;
  tool?: string;
  status?: "succeeded" | "failed";
  outcome?: RunOutcome;
  summary?: string;
  code?: string;
}

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const repositoryPattern = /^[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}$/;
const branchPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const tunnelNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  options: { max: number; pattern?: RegExp },
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > options.max) {
    throw new Error(`${key} must be a non-empty string of at most ${options.max} characters.`);
  }
  if (options.pattern && !options.pattern.test(candidate)) throw new Error(`${key} has an invalid format.`);
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  options: { max: number; pattern?: RegExp },
): string | undefined {
  if (value[key] === undefined) return undefined;
  return requiredString(value, key, options);
}

export function parseIdentifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`${label} has an invalid format.`);
  return value;
}

export function parseGeneration(value: string): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 1_000_000) {
    throw new Error("sandboxGeneration must be an integer between 1 and 1000000.");
  }
  return generation;
}

export function parseAdmission(value: unknown): AdmissionRequest {
  const body = record(value);
  if (!body) throw new Error("Admission body must be a JSON object.");
  return {
    repository: requiredString(body, "repository", { max: 201, pattern: repositoryPattern }),
    branch: requiredString(body, "branch", { max: LIMITS.branchCharacters, pattern: branchPattern }),
    capability: requiredString(body, "capability", { max: LIMITS.capabilityCharacters }),
    checkpointId: optionalString(body, "checkpointId", { max: 128, pattern: identifierPattern }),
  };
}

export function parseRun(value: unknown): RunRequest {
  const body = record(value);
  if (!body) throw new Error("Run body must be a JSON object.");
  const provider = requiredString(body, "provider", { max: 32 });
  if (provider !== "openai-codex" && provider !== "openrouter") {
    throw new Error("provider must be openai-codex or openrouter.");
  }
  if (body.resume !== undefined && typeof body.resume !== "boolean") throw new Error("resume must be a boolean.");
  if (
    body.verificationCommands !== undefined &&
    (!Array.isArray(body.verificationCommands) || body.verificationCommands.length > 8)
  ) {
    throw new Error("verificationCommands must contain at most 8 commands.");
  }
  const verificationCommands = body.verificationCommands?.map((command) => {
    if (typeof command !== "string" || command.length === 0 || command.length > 512) {
      throw new Error("Each verification command must contain at most 512 characters.");
    }
    return command;
  });
  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string.");
  if (prompt.length > LIMITS.promptCharacters) {
    throw new ProtocolLimitError(`prompt exceeds ${LIMITS.promptCharacters} characters.`);
  }
  return {
    runId: requiredString(body, "runId", { max: 128, pattern: identifierPattern }),
    prompt,
    provider,
    model: requiredString(body, "model", { max: 200, pattern: modelPattern }),
    capability: requiredString(body, "capability", { max: LIMITS.capabilityCharacters }),
    resume: body.resume,
    verificationCommands,
  };
}

export function parsePreview(value: unknown): PreviewRequest {
  const body = record(value);
  if (!body) throw new Error("Preview body must be a JSON object.");
  const port = body.port;
  if (!Number.isInteger(port) || Number(port) < 1024 || Number(port) > 65_535) {
    throw new Error("port must be an integer between 1024 and 65535.");
  }
  return {
    command: requiredString(body, "command", { max: LIMITS.commandCharacters }),
    port: Number(port),
    name: optionalString(body, "name", { max: 63, pattern: tunnelNamePattern }),
  };
}

export function parseScreenshot(value: unknown): ScreenshotRequest {
  const body = record(value);
  if (!body) throw new Error("Screenshot body must be a JSON object.");
  const port = body.port;
  if (!Number.isInteger(port) || Number(port) < 1024 || Number(port) > 65_535) {
    throw new Error("port must be an integer between 1024 and 65535.");
  }
  const width = body.width ?? 1440;
  const height = body.height ?? 900;
  if (!Number.isInteger(width) || Number(width) < 320 || Number(width) > 2560) {
    throw new Error("width must be an integer between 320 and 2560.");
  }
  if (!Number.isInteger(height) || Number(height) < 240 || Number(height) > 2560) {
    throw new Error("height must be an integer between 240 and 2560.");
  }
  const path = optionalString(body, "path", { max: 512 }) ?? "/";
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("path must be an absolute URL path.");
  return { port: Number(port), path, width: Number(width), height: Number(height) };
}

export function parseSiteDeployment(value: unknown): SiteDeploymentRequest {
  const body = record(value);
  if (!body) throw new Error("Deployment body must be a JSON object.");
  if (!Array.isArray(body.assets) || body.assets.length === 0 || body.assets.length > 256) {
    throw new Error("assets must contain between 1 and 256 files.");
  }
  const assets = body.assets.map((candidate) => {
    const asset = record(candidate);
    if (!asset) throw new Error("Each asset must be a JSON object.");
    const path = requiredString(asset, "path", { max: 240 });
    const workspacePath = requiredString(asset, "workspacePath", { max: 512 });
    const sha256 = requiredString(asset, "sha256", { max: 64, pattern: /^[a-f0-9]{64}$/ });
    for (const [label, candidatePath] of [["path", path], ["workspacePath", workspacePath]] as const) {
      if (
        candidatePath.startsWith("/") || candidatePath.includes("\\") || candidatePath.includes("%") ||
        candidatePath.includes("//") || candidatePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
        /[^A-Za-z0-9._@+/-]/.test(candidatePath)
      ) throw new Error(`${label} has an invalid format.`);
    }
    if (path.startsWith(".") || path.split("/").some((segment) => segment.startsWith("."))) {
      throw new Error("Hidden deployment assets are not allowed.");
    }
    return { path, workspacePath, sha256 };
  });
  if (new Set(assets.map((asset) => asset.path)).size !== assets.length) {
    throw new Error("Deployment asset paths must be unique.");
  }
  const hostname = requiredString(body, "hostname", {
    max: 253,
    pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?-ichef-sites\.buddytools\.org$/,
  });
  if ((hostname.split(".")[0]?.length ?? 64) > 63) throw new Error("hostname label is too long.");
  return {
    releaseId: requiredString(body, "releaseId", { max: 128, pattern: identifierPattern }),
    commitSha: requiredString(body, "commitSha", { max: 64, pattern: /^[a-f0-9]{7,64}$/ }),
    hostname,
    assets,
  };
}

export function parseReplacement(value: unknown): ReplacementRequest {
  const body = record(value);
  if (!body) throw new Error("Replacement body must be a JSON object.");
  const nextGeneration = body.nextGeneration;
  if (!Number.isSafeInteger(nextGeneration) || Number(nextGeneration) < 1 || Number(nextGeneration) > 1_000_000) {
    throw new Error("nextGeneration must be an integer between 1 and 1000000.");
  }
  return {
    checkpointId: requiredString(body, "checkpointId", { max: 128, pattern: identifierPattern }),
    nextGeneration: Number(nextGeneration),
  };
}
