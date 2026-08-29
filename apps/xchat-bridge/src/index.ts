import { XChatBridge } from "./bridge";
import { XActivityStreamClient } from "./activity-stream";
import { XChatEngine } from "./chat-engine";
import { readConfig } from "./config";
import { ConvexXChatControlPlane } from "./control-plane";
import { EnvelopeProtector } from "./crypto";
import { logBridgeEvent } from "./logger";
import { UserContextTokenProvider } from "./oauth";
import { XChatInbox } from "./inbox";
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
  const inbox = new XChatInbox({
    api,
    engine,
    bridge,
    vault,
    botUserId: config.botUserId,
  });
  const activity = new XActivityStreamClient({
    baseUrl: config.apiBaseUrl,
    bearerToken: config.appBearerToken,
  });
  let ready = false;
  let inboxReady = false;
  let subscriptionsReady = false;
  let streamReady = false;
  const updateReady = () => { ready = inboxReady && subscriptionsReady && streamReady; };
  const server = Bun.serve({
    port: config.port,
    fetch: createRequestHandler({
      bridge,
      ...(config.consumerSecret ? { consumerSecret: config.consumerSecret } : {}),
      replay: new WebhookReplayAdmission(vault),
      ready: () => ready,
    }),
  });
  logBridgeEvent("info", "bridge_started", { port: server.port ?? config.port });

  let stopped = false;
  let outboundPolling = false;
  let inboxPolling = false;
  const activityAbort = new AbortController();
  const pollOutbound = async () => {
    if (stopped || outboundPolling) return;
    outboundPolling = true;
    try {
      await bridge.flushDirectReplies();
      await bridge.deliverLeasedBatch();
    } catch {
      logBridgeEvent("error", "outbound_poll_failed", { errorCode: "control_plane_unavailable" });
    } finally {
      outboundPolling = false;
    }
  };
  const pollInbox = async () => {
    if (stopped || inboxPolling) return;
    inboxPolling = true;
    try {
      await inbox.pollOnce();
      inboxReady = true;
      updateReady();
    } catch {
      logBridgeEvent("error", "inbox_poll_failed", { errorCode: "xchat_inbox_unavailable" });
    } finally {
      inboxPolling = false;
    }
  };
  const runActivityStream = async () => {
    while (!stopped) {
      if (!subscriptionsReady) {
        try {
          await api.ensureActivitySubscriptions(config.botUserId);
          subscriptionsReady = true;
          updateReady();
        } catch {
          logBridgeEvent("error", "activity_subscription_failed", { errorCode: "xchat_subscription_unavailable" });
          await Bun.sleep(5_000);
          continue;
        }
      }
      try {
        for await (const event of activity.events(activityAbort.signal, () => {
          streamReady = true;
          updateReady();
        })) {
          if (stopped) return;
          await inbox.noteActivity(event);
        }
      } catch {
        if (stopped || activityAbort.signal.aborted) return;
        streamReady = false;
        updateReady();
        logBridgeEvent("error", "activity_stream_failed", { errorCode: "xchat_stream_unavailable" });
      }
      streamReady = false;
      updateReady();
      await Bun.sleep(5_000);
    }
  };
  const outboundTimer = setInterval(() => void pollOutbound(), config.pollIntervalMs);
  const inboxTimer = setInterval(() => void pollInbox(), config.inboxPollIntervalMs);
  outboundTimer.unref();
  inboxTimer.unref();
  void pollOutbound();
  void pollInbox();
  void runActivityStream();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(outboundTimer);
    clearInterval(inboxTimer);
    activityAbort.abort();
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
