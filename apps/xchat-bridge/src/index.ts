import { XChatBridge } from "./bridge";
import { XChatEngine } from "./chat-engine";
import { readConfig } from "./config";
import { ConvexXChatControlPlane } from "./control-plane";
import { EnvelopeProtector } from "./crypto";
import { logBridgeEvent } from "./logger";
import { UserContextTokenProvider } from "./oauth";
import { createRequestHandler } from "./server";
import { classifyStartupFailure } from "./startup";
import { WebhookReplayAdmission } from "./replay";
import { EncryptedFileVault } from "./vault";
import { XApiClient } from "./x-api";

async function main(): Promise<void> {
  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig();
  } catch {
    logBridgeEvent("error", "configuration_failed", { errorCode: "invalid_environment" });
    process.exitCode = 1;
    return;
  }

  const protector = new EnvelopeProtector(config.routeEncryptionKey);
  const vault = new EncryptedFileVault(config.vaultPath, new EnvelopeProtector(config.vaultEncryptionKey));
  const tokens = new UserContextTokenProvider({
    accessToken: config.accessToken,
    ...(config.refreshToken ? { refreshToken: config.refreshToken } : {}),
    ...(config.oauthClientId ? { clientId: config.oauthClientId } : {}),
    ...(config.oauthClientSecret ? { clientSecret: config.oauthClientSecret } : {}),
    vault,
  });
  await tokens.initialize();
  const api = new XApiClient({ baseUrl: config.apiBaseUrl, tokens });
  const engine = await XChatEngine.create({
    juiceboxPin: config.juiceboxPin,
    botUserId: config.botUserId,
    api,
    vault,
  });
  const control = new ConvexXChatControlPlane({ url: config.brokerUrl, secret: config.bridgeSecret });
  const bridge = new XChatBridge({
    control,
    engine,
    protector,
    vault,
    addressPepper: config.addressPepper,
    portalUrl: config.portalUrl,
  });
  const server = Bun.serve({
    port: config.port,
    fetch: createRequestHandler({
      bridge,
      consumerSecret: config.consumerSecret,
      replay: new WebhookReplayAdmission(vault),
    }),
  });
  logBridgeEvent("info", "bridge_started", { port: server.port ?? config.port });

  let stopped = false;
  let polling = false;
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      await bridge.flushDirectReplies();
      await bridge.deliverLeasedBatch();
    } catch {
      logBridgeEvent("error", "outbound_poll_failed", { errorCode: "control_plane_unavailable" });
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), config.pollIntervalMs);
  timer.unref();
  void poll();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    server.stop();
    engine.lock();
    logBridgeEvent("info", "bridge_stopped");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

try {
  await main();
} catch (error: unknown) {
  const failure = classifyStartupFailure(error);
  logBridgeEvent("error", "initialization_failed", { errorCode: failure.errorCode });
  process.exitCode = failure.exitCode;
}
