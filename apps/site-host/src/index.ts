const MANAGED_DEPLOY_HOST = "site-host.internal";
const MANIFEST_NAME = ".buddybox-manifest.json";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS = 256;
const encoder = new TextEncoder();

type SiteHostEnv = Env & { BUDDYBOX_SITE_HOST_SECRET: string };

type DecodedAsset = {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  contentType: string;
};

type AssetDescriptor = Pick<DecodedAsset, "path" | "sha256"> & { size: number };

type DeploymentInput = {
  projectId: string;
  releaseId: string;
  sourceRunId: string;
  commitSha: string;
  hostname: string;
  artifactManifestDigest: string;
  assets: unknown[];
};

type RunAuthority = {
  userId: string;
  projectId: string;
  sandboxGeneration: number;
  action: "deploy";
  releaseId: string;
  sourceRunId: string;
  commitSha: string;
  hostname: string;
  artifactManifestDigest: string;
};

type ResolvedRelease = {
  projectId: string;
  releaseId: string;
  commitSha: string;
  deploymentRef: string;
  status: "live";
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: SiteHostEnv): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    try {
      if (url.hostname === MANAGED_DEPLOY_HOST) {
        return await handleManagement(request, url, env, requestId);
      }
      return await handlePublic(request, url, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      console.error(JSON.stringify({
        message: "site host request failed",
        requestId,
        method: request.method,
        hostname: url.hostname,
        path: url.pathname,
        status,
        error: error instanceof Error ? error.message : "unknown error",
      }));
      return json({ error: status === 500 ? "internal_error" : error instanceof Error ? error.message : "request_failed" }, status);
    }
  },
} satisfies ExportedHandler<SiteHostEnv>;

async function handleManagement(request: Request, url: URL, env: SiteHostEnv, attemptId: string): Promise<Response> {
  if (request.method !== "POST" || url.pathname !== "/v1/deployments" || url.search) {
    throw new HttpError(404, "not_found");
  }
  const capability = bearer(request.headers.get("authorization"));
  if (!capability || capability.length > 4_096) throw new HttpError(401, "unauthorized");
  const authority = await authenticateCapability(env, capability);
  const input = validateDeploymentInput(await readBoundedJson(request));
  if (
    input.projectId !== authority.projectId ||
    input.releaseId !== authority.releaseId ||
    input.sourceRunId !== authority.sourceRunId ||
    input.commitSha !== authority.commitSha ||
    input.hostname !== authority.hostname ||
    input.artifactManifestDigest !== authority.artifactManifestDigest
  ) throw new HttpError(403, "deployment_capability_mismatch");
  if (!projectHost(input.hostname, env.SITES_BASE_DOMAIN)) throw new HttpError(400, "invalid_hostname");

  const assets = await decodeAssets(input.assets);
  if (!assets.some((asset) => asset.path === "index.html")) throw new HttpError(400, "index_html_required");
  const descriptors = assets.map(({ path, sha256, bytes }) => ({ path, sha256, size: bytes.byteLength }));
  if (await artifactManifestDigest(descriptors) !== input.artifactManifestDigest) {
    throw new HttpError(403, "deployment_manifest_mismatch");
  }
  const reservation = validateReservation(await brokerCall(env, "reserve_upload", {
    projectId: input.projectId,
    releaseId: input.releaseId,
    sourceRunId: input.sourceRunId,
    commitSha: input.commitSha,
    hostname: input.hostname,
    artifactManifestDigest: input.artifactManifestDigest,
    attemptId,
  }));
  if (reservation.status === "live") {
    return json({
      projectId: input.projectId,
      releaseId: input.releaseId,
      deploymentRef: reservation.deploymentRef,
      liveUrl: reservation.liveUrl,
    }, 201);
  }
  const ref = await deploymentRef(input.projectId, input.releaseId, input.commitSha, descriptors);
  const digest = deploymentDigest(ref);
  const prefix = releasePrefix(input.projectId, input.releaseId, digest);

  try {
    for (let offset = 0; offset < assets.length; offset += 16) {
      await Promise.all(assets.slice(offset, offset + 16).map((asset) => putImmutableAsset(env.SITE_ASSETS, prefix, asset)));
    }
    const manifest = encoder.encode(JSON.stringify({
      version: 1,
      projectId: input.projectId,
      releaseId: input.releaseId,
      sourceRunId: input.sourceRunId,
      commitSha: input.commitSha,
      artifactManifestDigest: input.artifactManifestDigest,
      deploymentRef: ref,
      assets: descriptors.toSorted((left, right) => left.path.localeCompare(right.path)),
    }));
    await putImmutable(env.SITE_ASSETS, `${prefix}/${MANIFEST_NAME}`, manifest, {
      contentType: "application/json; charset=utf-8",
      sha256: await sha256Hex(manifest),
    });

    validateActivation(await brokerCall(env, "activate_release", {
      projectId: input.projectId,
      releaseId: input.releaseId,
      sourceRunId: input.sourceRunId,
      deploymentRef: ref,
      liveUrl: `https://${input.hostname}`,
      commitSha: input.commitSha,
      hostname: input.hostname,
      artifactManifestDigest: input.artifactManifestDigest,
      attemptId,
    }), input);
  } catch (error) {
    await brokerCall(env, "fail_upload", { releaseId: input.releaseId, attemptId }).catch(() => null);
    throw error;
  }
  return json({
    projectId: input.projectId,
    releaseId: input.releaseId,
    deploymentRef: ref,
    liveUrl: `https://${input.hostname}`,
  }, 201);
}

async function handlePublic(request: Request, url: URL, env: SiteHostEnv): Promise<Response> {
  if (!projectHost(url.hostname, env.SITES_BASE_DOMAIN)) throw new HttpError(404, "site_not_found");
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
  const release = validateResolvedRelease(await brokerCall(env, "resolve_site", { hostname: url.hostname }));
  if (!release || release.status !== "live") throw new HttpError(404, "site_not_found");
  validateOpaqueId(release.projectId, "projectId");
  validateOpaqueId(release.releaseId, "releaseId");
  const prefix = releasePrefix(release.projectId, release.releaseId, deploymentDigest(release.deploymentRef));
  const requestedPath = publicAssetPath(url.pathname);
  const allowSpaFallback = requestedPath === "index.html" || !requestedPath.split("/").at(-1)?.includes(".") || request.headers.get("accept")?.includes("text/html");
  const object = await getAsset(env.SITE_ASSETS, `${prefix}/${requestedPath}`, request);
  if (object) return objectResponse(object, request.method, requestedPath);
  if (allowSpaFallback && requestedPath !== "index.html") {
    const fallback = await getAsset(env.SITE_ASSETS, `${prefix}/index.html`, request);
    if (fallback) return objectResponse(fallback, request.method, "index.html");
  }
  throw new HttpError(404, "asset_not_found");
}

async function authenticateCapability(env: SiteHostEnv, capability: string): Promise<RunAuthority> {
  const response = await env.CONTROL_PLANE.fetch(new Request("https://control-plane.internal/v1/agent-gateway/authenticate", {
    method: "POST",
    headers: { authorization: `Bearer ${capability}` },
  }));
  if (!response.ok) throw new HttpError(401, "unauthorized");
  const value: unknown = await response.json();
  if (!isRunAuthority(value)) throw new HttpError(403, "artifact_capability_required");
  return value;
}

async function brokerCall(env: SiteHostEnv, operation: string, input: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(env.CONVEX_SITE_HOST_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.BUDDYBOX_SITE_HOST_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operation, input }),
    signal: AbortSignal.timeout(10_000),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("result" in value)) {
    throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 503, "site_control_unavailable");
  }
  return value.result;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "request_too_large");
  if (!request.body) throw new HttpError(400, "request_body_required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel("request too large");
      throw new HttpError(413, "request_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function validateDeploymentInput(value: unknown): DeploymentInput {
  if (!value || typeof value !== "object") throw new HttpError(400, "invalid_deployment");
  const candidate = value as Record<string, unknown>;
  const projectId = validateOpaqueId(candidate.projectId, "projectId");
  const releaseId = validateOpaqueId(candidate.releaseId, "releaseId");
  const sourceRunId = validateOpaqueId(candidate.sourceRunId, "sourceRunId");
  if (typeof candidate.commitSha !== "string" || !/^[a-f0-9]{7,64}$/.test(candidate.commitSha)) throw new HttpError(400, "invalid_commit_sha");
  if (typeof candidate.hostname !== "string" || candidate.hostname !== candidate.hostname.toLowerCase() || candidate.hostname.length > 253) {
    throw new HttpError(400, "invalid_hostname");
  }
  if (!Array.isArray(candidate.assets) || candidate.assets.length === 0 || candidate.assets.length > MAX_ASSETS) throw new HttpError(400, "invalid_assets");
  if (typeof candidate.artifactManifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(candidate.artifactManifestDigest)) {
    throw new HttpError(400, "invalid_artifact_manifest_digest");
  }
  return {
    projectId,
    releaseId,
    sourceRunId,
    commitSha: candidate.commitSha,
    hostname: candidate.hostname,
    artifactManifestDigest: candidate.artifactManifestDigest,
    assets: candidate.assets,
  };
}

async function decodeAssets(values: unknown[]): Promise<DecodedAsset[]> {
  const assets: DecodedAsset[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const value of values) {
    const asset = await decodeAsset(value);
    if (paths.has(asset.path)) throw new HttpError(400, "duplicate_asset_path");
    paths.add(asset.path);
    total += asset.bytes.byteLength;
    if (total > MAX_TOTAL_ASSET_BYTES) throw new HttpError(413, "assets_too_large");
    assets.push(asset);
  }
  return assets;
}

async function decodeAsset(value: unknown): Promise<DecodedAsset> {
  if (!value || typeof value !== "object") throw new HttpError(400, "invalid_asset");
  const candidate = value as Record<string, unknown>;
  const path = validateAssetPath(candidate.path);
  if (typeof candidate.data !== "string" || !strictBase64(candidate.data)) throw new HttpError(400, "invalid_base64");
  if (typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256)) throw new HttpError(400, "invalid_sha256");
  const padding = candidate.data.endsWith("==") ? 2 : candidate.data.endsWith("=") ? 1 : 0;
  const estimatedSize = candidate.data.length / 4 * 3 - padding;
  if (estimatedSize > MAX_ASSET_BYTES) throw new HttpError(413, "asset_too_large");
  const binary = atob(candidate.data);
  if (binary.length > MAX_ASSET_BYTES) throw new HttpError(413, "asset_too_large");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const actual = await sha256Hex(bytes);
  if (actual !== candidate.sha256) throw new HttpError(400, "sha256_mismatch");
  return { path, bytes, sha256: actual, contentType: mimeType(path) };
}

function validateAssetPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) throw new HttpError(400, "invalid_asset_path");
  if (value === MANIFEST_NAME || value.startsWith("/") || value.includes("\\") || value.includes("%") || value.includes("//") || /[^A-Za-z0-9._@+/-]/.test(value)) {
    throw new HttpError(400, "invalid_asset_path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) throw new HttpError(400, "invalid_asset_path");
  return value;
}

function publicAssetPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid_path");
  }
  if (decoded === "/" || decoded === "") return "index.html";
  const relative = decoded.slice(1).replace(/\/$/, "");
  return validateAssetPath(relative);
}

function projectHost(hostname: string, baseDomain: string): boolean {
  if (hostname !== hostname.toLowerCase() || baseDomain !== baseDomain.toLowerCase()) return false;
  const suffix = `-${baseDomain}`;
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  const hostLabel = hostname.split(".")[0] ?? "";
  return hostLabel.length <= 63 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) && !hostname.slice(0, -".buddytools.org".length).includes(".");
}

async function deploymentRef(projectId: string, releaseId: string, commitSha: string, assets: AssetDescriptor[]): Promise<string> {
  const canonical = JSON.stringify({
    version: 1,
    projectId,
    releaseId,
    commitSha,
    assets: assets.toSorted((left, right) => left.path.localeCompare(right.path)),
  });
  return `r2:v1:${await sha256Hex(encoder.encode(canonical))}`;
}

async function artifactManifestDigest(assets: Array<Pick<AssetDescriptor, "path" | "sha256">>): Promise<string> {
  const canonical = JSON.stringify({
    version: 1,
    assets: assets
      .map(({ path, sha256 }) => ({ path, sha256 }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  });
  return sha256Hex(encoder.encode(canonical));
}

function deploymentDigest(ref: string): string {
  const match = /^r2:v1:([a-f0-9]{64})$/.exec(ref);
  if (!match?.[1]) throw new HttpError(503, "invalid_deployment_ref");
  return match[1];
}

function releasePrefix(projectId: string, releaseId: string, digest: string): string {
  return `releases/${validateOpaqueId(projectId, "projectId")}/${validateOpaqueId(releaseId, "releaseId")}/${digest}`;
}

async function putImmutableAsset(bucket: R2Bucket, prefix: string, asset: DecodedAsset): Promise<void> {
  await putImmutable(bucket, `${prefix}/${asset.path}`, asset.bytes, { contentType: asset.contentType, sha256: asset.sha256 });
}

async function putImmutable(bucket: R2Bucket, key: string, bytes: Uint8Array, metadata: { contentType: string; sha256: string }): Promise<void> {
  const conditions = new Headers({ "if-none-match": "*" });
  const stored = await bucket.put(key, bytes, {
    onlyIf: conditions,
    sha256: metadata.sha256,
    httpMetadata: { contentType: metadata.contentType },
    customMetadata: { sha256: metadata.sha256, size: String(bytes.byteLength) },
  });
  if (stored) return;
  const existing = await bucket.head(key);
  if (existing?.customMetadata?.sha256 !== metadata.sha256 || existing.size !== bytes.byteLength) {
    throw new HttpError(409, "immutable_asset_conflict");
  }
}

async function getAsset(bucket: R2Bucket, key: string, request: Request): Promise<R2ObjectBody | R2Object | null> {
  const onlyIf = new Headers();
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) onlyIf.set("if-none-match", ifNoneMatch);
  return await bucket.get(key, ifNoneMatch ? { onlyIf } : undefined);
}

function objectResponse(object: R2ObjectBody | R2Object, method: string, path: string): Response {
  const headers = securityHeaders();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  const contentType = headers.get("content-type") ?? mimeType(path);
  headers.set("content-type", contentType);
  headers.set("cache-control", cacheControl(path, contentType));
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  headers.set("content-length", String(object.size));
  return new Response(method === "HEAD" ? null : object.body, { status: 200, headers });
}

function securityHeaders(): Headers {
  return new Headers({
    "content-security-policy": "default-src 'self' https: data: blob:; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; font-src 'self' https: data:; script-src 'self' https:; style-src 'self' https: 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function cacheControl(path: string, contentType: string): string {
  if (contentType.startsWith("text/html")) return "public, max-age=0, must-revalidate";
  if (/(?:^|[-_.])[a-f0-9]{8,}(?:[-_.]|$)/i.test(path)) return "public, max-age=31536000, immutable";
  return "public, max-age=300, stale-while-revalidate=60";
}

function mimeType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({
    html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", wasm: "application/wasm",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", pdf: "application/pdf",
    webmanifest: "application/manifest+json", map: "application/json; charset=utf-8",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function strictBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function validateOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(value)) throw new HttpError(400, `invalid_${field}`);
  return value;
}

function bearer(value: string | null): string | null {
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

function isRunAuthority(value: unknown): value is RunAuthority {
  return Boolean(value && typeof value === "object" &&
    "userId" in value && typeof value.userId === "string" &&
    "projectId" in value && typeof value.projectId === "string" &&
    "sandboxGeneration" in value && Number.isSafeInteger(value.sandboxGeneration) &&
    "action" in value && value.action === "deploy" &&
    "releaseId" in value && typeof value.releaseId === "string" &&
    "sourceRunId" in value && typeof value.sourceRunId === "string" &&
    "commitSha" in value && typeof value.commitSha === "string" &&
    "hostname" in value && typeof value.hostname === "string" &&
    "artifactManifestDigest" in value && typeof value.artifactManifestDigest === "string");
}

function validateReservation(value: unknown):
  | { status: "reserved" }
  | { status: "live"; deploymentRef: string; liveUrl: string } {
  if (!value || typeof value !== "object" || !("status" in value)) {
    throw new HttpError(503, "invalid_site_control_response");
  }
  if (value.status === "reserved") return { status: "reserved" };
  if (
    value.status === "live" &&
    "deploymentRef" in value && typeof value.deploymentRef === "string" &&
    "liveUrl" in value && typeof value.liveUrl === "string"
  ) return { status: "live", deploymentRef: value.deploymentRef, liveUrl: value.liveUrl };
  throw new HttpError(503, "invalid_site_control_response");
}

function validateResolvedRelease(value: unknown): ResolvedRelease | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" ||
    !("projectId" in value) || typeof value.projectId !== "string" ||
    !("releaseId" in value) || typeof value.releaseId !== "string" ||
    !("commitSha" in value) || typeof value.commitSha !== "string" ||
    !("deploymentRef" in value) || typeof value.deploymentRef !== "string" ||
    !("status" in value) || value.status !== "live") {
    throw new HttpError(503, "invalid_site_control_response");
  }
  return {
    projectId: value.projectId,
    releaseId: value.releaseId,
    commitSha: value.commitSha,
    deploymentRef: value.deploymentRef,
    status: value.status,
  };
}

function validateActivation(value: unknown, input: Pick<DeploymentInput, "projectId" | "releaseId">): void {
  if (!value || typeof value !== "object" ||
    !("projectId" in value) || value.projectId !== input.projectId ||
    !("releaseId" in value) || value.releaseId !== input.releaseId ||
    !("status" in value) || value.status !== "live") {
    throw new HttpError(503, "invalid_site_control_response");
  }
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export const testables = {
  cacheControl,
  decodeAsset,
  artifactManifestDigest,
  deploymentRef,
  projectHost,
  publicAssetPath,
  sha256Hex,
  validateAssetPath,
};
