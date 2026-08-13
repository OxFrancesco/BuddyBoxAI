import { verifyCapability } from "./capability";

interface Env { GATEWAY_CAPABILITY_SECRET: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/agent-gateway/authenticate") return new Response("Not found", { status: 404 });
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
    const capability = await verifyCapability(authorization.slice(7), env.GATEWAY_CAPABILITY_SECRET);
    if (!capability) return new Response("Unauthorized", { status: 401 });
    return Response.json({ userId: capability.sub, projectId: capability.projectId, action: capability.action }, { headers: { "cache-control": "no-store" } });
  },
} satisfies ExportedHandler<Env>;
