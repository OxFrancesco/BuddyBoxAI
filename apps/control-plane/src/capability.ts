export type GatewayAction = "admission" | "run" | "cancel" | "heartbeat" | "checkpoint" | "replacement" | "preview" | "artifact";

export interface GatewayCapability {
  sub: string;
  projectId: string;
  action: GatewayAction;
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

export async function issueCapability(input: GatewayCapability, secret: string, now = Math.floor(Date.now() / 1000)) {
  if (!secret || input.exp <= now || input.exp > now + 300) throw new Error("capability must expire within five minutes");
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
    if (!parsed.sub || !parsed.projectId || !parsed.action || !parsed.exp || !parsed.iat) return null;
    if (parsed.exp <= now || parsed.exp > parsed.iat + 300 || parsed.iat > now + 30) return null;
    return parsed as GatewayCapability;
  } catch {
    return null;
  }
}
