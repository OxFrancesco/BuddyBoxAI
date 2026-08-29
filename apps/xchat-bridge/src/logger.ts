export type LogEvent =
  | "bridge_started"
  | "bridge_stopped"
  | "configuration_failed"
  | "initialization_failed"
  | "outbound_poll_failed"
  | "inbox_poll_failed"
  | "activity_stream_failed"
  | "activity_subscription_failed";

export function logBridgeEvent(
  level: "info" | "error",
  event: LogEvent,
  details: { port?: number; errorCode?: string } = {},
): void {
  const line = JSON.stringify({ service: "xchat-bridge", event, ...details });
  if (level === "error") console.error(line);
  else console.info(line);
}
