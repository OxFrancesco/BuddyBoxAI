export type IngressMode = "webhook" | "grpc" | "hybrid";

export interface BridgeConfig {
  projectId: string;
  projectSecret: string;
  webhookSecret?: string;
  expectedWebhookId?: string;
  addressPepper: string;
  convexBridgeUrl: string;
  internalSecret: string;
  ingressMode: IngressMode;
  port: number;
}

export function readConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const ingressMode = parseIngressMode(env.SPECTRUM_INGRESS_MODE);
  const webhookSecret = optional(env.SPECTRUM_WEBHOOK_SECRET);
  if (ingressMode !== "grpc" && !webhookSecret) {
    throw new Error("SPECTRUM_WEBHOOK_SECRET is required for webhook ingress");
  }

  const port = parsePort(env.PORT);
  const projectSecret = required(env, "SPECTRUM_PROJECT_SECRET");
  const addressPepper = required(env, "BUDDYBOX_ADDRESS_PEPPER");
  const internalSecret = required(env, "BUDDYBOX_BRIDGE_SECRET");
  if (projectSecret.length < 16 || addressPepper.length < 16 || internalSecret.length < 16) {
    throw new Error("Bridge secrets must be at least 16 characters");
  }

  const convexBridgeUrl = required(env, "CONVEX_BRIDGE_URL");
  const url = new URL(convexBridgeUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("CONVEX_BRIDGE_URL must use HTTPS outside localhost");
  }

  return {
    projectId: required(env, "SPECTRUM_PROJECT_ID"),
    projectSecret,
    webhookSecret,
    ...(optional(env.SPECTRUM_WEBHOOK_ID)
      ? { expectedWebhookId: optional(env.SPECTRUM_WEBHOOK_ID) }
      : {}),
    addressPepper,
    convexBridgeUrl: url.toString(),
    internalSecret,
    ingressMode,
    port,
  };
}

function parseIngressMode(value: string | undefined): IngressMode {
  const mode = optional(value) ?? "webhook";
  if (mode !== "webhook" && mode !== "grpc" && mode !== "hybrid") {
    throw new Error("SPECTRUM_INGRESS_MODE must be webhook, grpc, or hybrid");
  }
  return mode;
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000;
  if (!/^\d+$/.test(value)) throw new Error("PORT must be an integer");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be between 1 and 65535");
  }
  return port;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = optional(env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
