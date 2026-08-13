import { createBridge } from "./bridge";
import { readConfig } from "./config";
import { ConvexHttpControlPlane } from "./control-plane";
import { logBridgeEvent } from "./logger";
import { createRequestHandler } from "./server";
import { createSpectrumAdapter } from "./spectrum-adapter";

async function main(): Promise<void> {
  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig();
  } catch {
    logBridgeEvent("error", "configuration_failed", { errorCode: "invalid_environment" });
    process.exitCode = 1;
    return;
  }

  const spectrum = await createSpectrumAdapter({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    addressPepper: config.addressPepper,
  });
  const controlPlane = new ConvexHttpControlPlane({
    bridgeUrl: config.convexBridgeUrl,
    bridgeSecret: config.internalSecret,
  });
  const bridge = createBridge({ controlPlane, transport: spectrum.transport });
  const handler = createRequestHandler({
    bridge,
    addressPepper: config.addressPepper,
    internalSecret: config.internalSecret,
    ...(config.webhookSecret
      ? {
          webhookSecurity: {
            signingSecret: config.webhookSecret,
            ...(config.expectedWebhookId ? { expectedWebhookId: config.expectedWebhookId } : {}),
          },
        }
      : {}),
  });
  const server = Bun.serve({ port: config.port, fetch: handler });
  logBridgeEvent("info", "bridge_started", { ingressMode: config.ingressMode, port: server.port });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop();
    try {
      await spectrum.stop();
      logBridgeEvent("info", "bridge_stopped");
    } catch {
      logBridgeEvent("error", "shutdown_failed", { errorCode: "spectrum_stop_failed" });
    }
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  if (config.ingressMode === "grpc" || config.ingressMode === "hybrid") {
    void spectrum.start(bridge.acceptInbound).catch(() => {
      logBridgeEvent("error", "grpc_stream_failed", { errorCode: "stream_terminated" });
      process.exitCode = 1;
      void stop();
    });
  }
}

try {
  await main();
} catch {
  logBridgeEvent("error", "startup_failed", { errorCode: "provider_initialization_failed" });
  process.exitCode = 1;
}
