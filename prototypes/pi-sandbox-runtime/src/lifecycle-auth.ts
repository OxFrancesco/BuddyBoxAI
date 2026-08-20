export interface LifecycleAuthEnv {
  ICHEF_PROTOTYPE_SECRET?: string;
}

export function withLifecycleAuthorization<Env extends LifecycleAuthEnv>(
  next: (request: Request, env: Env) => Promise<Response>,
): (request: Request, env: Env) => Promise<Response> {
  return async (request, env) => {
    if (!new URL(request.url).pathname.startsWith("/api/")) return await next(request, env);
    const authorizationError = await lifecycleAuthorizationError(request, env);
    return authorizationError ?? await next(request, env);
  };
}

async function lifecycleAuthorizationError(
  request: Request,
  env: LifecycleAuthEnv,
): Promise<Response | undefined> {
  const secret = env.ICHEF_PROTOTYPE_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    return new Response(null, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  const expected = `Bearer ${secret}`;
  const provided = request.headers.get("authorization") ?? "";
  const [expectedDigest, providedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
  ]);
  let mismatch = provided.length ^ expected.length;
  const expectedBytes = new Uint8Array(expectedDigest);
  const providedBytes = new Uint8Array(providedDigest);
  for (let index = 0; index < expectedBytes.byteLength; index += 1) {
    mismatch |= expectedBytes[index]! ^ providedBytes[index]!;
  }
  if (mismatch !== 0) {
    return new Response(null, {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
      },
    });
  }
  return undefined;
}
