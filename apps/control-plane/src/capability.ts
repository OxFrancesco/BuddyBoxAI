export type GatewayAction =
  | "admission"
  | "run"
  | "cancel"
  | "heartbeat"
  | "checkpoint"
  | "replacement"
  | "preview"
  | "artifact_read"
  | "screenshot"
  | "deploy";

export interface GatewayCapability {
  sub: string;
  projectId: string;
  sandboxGeneration: number;
  action: GatewayAction;
  runId?: string;
  releaseId?: string;
  sourceRunId?: string;
  commitSha?: string;
  hostname?: string;
  artifactManifestDigest?: string;
  exp: number;
  jti?: string;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decode(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signature(payload: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

const actions = new Set<GatewayAction>([
  "admission", "run", "cancel", "heartbeat", "checkpoint", "replacement", "preview",
  "artifact_read", "screenshot", "deploy",
]);
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validateClaims(value: Partial<GatewayCapability>): value is GatewayCapability {
  if (
    typeof value.sub !== "string" || !opaqueId.test(value.sub) ||
    typeof value.projectId !== "string" || !opaqueId.test(value.projectId) ||
    !Number.isSafeInteger(value.sandboxGeneration) || Number(value.sandboxGeneration) < 1 || Number(value.sandboxGeneration) > 1_000_000 ||
    typeof value.action !== "string" || !actions.has(value.action as GatewayAction) ||
    typeof value.exp !== "number" || !Number.isSafeInteger(value.exp)
  ) return false;
  if ((value.action === "run" || value.action === "cancel") && (typeof value.runId !== "string" || !opaqueId.test(value.runId))) {
    return false;
  }
  if (value.action === "heartbeat" && value.runId !== undefined && (typeof value.runId !== "string" || !opaqueId.test(value.runId))) {
    return false;
  }
  if (value.action === "deploy") {
    return Boolean(
      typeof value.releaseId === "string" && opaqueId.test(value.releaseId) &&
      typeof value.sourceRunId === "string" && opaqueId.test(value.sourceRunId) &&
      typeof value.commitSha === "string" && /^[a-f0-9]{7,64}$/.test(value.commitSha) &&
      typeof value.hostname === "string" && value.hostname.length <= 253 && value.hostname === value.hostname.toLowerCase() &&
      typeof value.artifactManifestDigest === "string" && /^[a-f0-9]{64}$/.test(value.artifactManifestDigest),
    );
  }
  return true;
}

function invalidBinding(input: Partial<GatewayCapability>): string {
  if (!Number.isSafeInteger(input.sandboxGeneration)) return "sandboxGeneration";
  if ((input.action === "run" || input.action === "cancel") && !input.runId) return "runId";
  if (input.action === "deploy") {
    for (const field of ["releaseId", "sourceRunId", "commitSha", "hostname", "artifactManifestDigest"] as const) {
      if (!input[field]) return field;
    }
  }
  return "claims";
}

export async function issueCapability(input: GatewayCapability, secret: string, now = Math.floor(Date.now() / 1000)) {
  if (!secret || input.exp <= now || input.exp > now + 300) throw new Error("capability must expire within five minutes");
  if (!validateClaims(input)) throw new Error(`capability ${invalidBinding(input)} binding is invalid`);
  const payload = base64url(encoder.encode(JSON.stringify({ ...input, iat: now })));
  return `${payload}.${base64url(await signature(payload, secret))}`;
}

export async function verifyCapability(token: string, secret: string, now = Math.floor(Date.now() / 1000)): Promise<GatewayCapability | null> {
  try {
    if (!secret || token.length > 4096) return null;
    const [payload, supplied, extra] = token.split(".");
    if (!payload || !supplied || extra) return null;
    const expected = await signature(payload, secret);
    const actual = decode(supplied);
    if (expected.byteLength !== actual.byteLength) return null;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) difference |= expected[index]! ^ actual[index]!;
    if (difference !== 0) return null;
    const parsed = JSON.parse(new TextDecoder().decode(decode(payload))) as Partial<GatewayCapability> & { iat?: number };
    const issuedAt = parsed.iat;
    if (!validateClaims(parsed) || !issuedAt) return null;
    if (parsed.exp <= now || parsed.exp > issuedAt + 300 || issuedAt > now + 30) return null;
    return parsed as GatewayCapability;
  } catch {
    return null;
  }
}
