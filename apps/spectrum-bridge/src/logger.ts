export type BridgeLogEvent =
  | "bridge_started"
  | "bridge_stopped"
  | "configuration_failed"
  | "startup_failed"
  | "grpc_stream_failed"
  | "shutdown_failed";

/**
 * Emits only allowlisted operational fields. Callers cannot attach arbitrary
 * metadata, so message bodies, addresses, routing ids, and secrets cannot
 * accidentally enter bridge logs.
 */
export function logBridgeEvent(
  level: "info" | "error",
  event: BridgeLogEvent,
  details: { ingressMode?: string; port?: number; errorCode?: string } = {},
): void {
  const record = JSON.stringify({ service: "spectrum-bridge", event, ...details });
  if (level === "error") console.error(record);
  else console.info(record);
}
