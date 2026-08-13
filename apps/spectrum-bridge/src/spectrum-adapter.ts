import { Spectrum, text, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import type { OutboundTransport } from "./bridge";
import { normalizeSpectrumInbound } from "./normalize";
import type { NormalizedInbound } from "./types";

export interface SpectrumAdapterConfig {
  projectId: string;
  projectSecret: string;
  addressPepper: string;
}

export interface SpectrumAdapter {
  transport: OutboundTransport;
  start(onInbound: (message: NormalizedInbound) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export async function createSpectrumAdapter(config: SpectrumAdapterConfig): Promise<SpectrumAdapter> {
  const app = await Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers: [imessage.config()],
    telemetry: false,
    options: { flattenGroups: false, logLevel: "silent" },
  });
  const provider = imessage(app);

  const transport: OutboundTransport = {
    async sendText(message) {
      const space = await provider.space.get(
        message.spaceId,
        message.lineId ? { phone: message.lineId } : {},
      );
      const sent = await space.send(text(message.text));
      if (!sent?.id) throw new Error("Spectrum did not return a message identifier");
      return { providerMessageId: sent.id };
    },
  };

  return {
    transport,
    async start(onInbound) {
      for await (const [space, message] of app.messages) {
        const envelope = serializeGrpcInbound(space, message);
        const normalized = await normalizeSpectrumInbound(envelope, {
          addressPepper: config.addressPepper,
          webhookId: "grpc-stream",
        });
        if (normalized.ok) await onInbound(normalized.value);
      }
    },
    async stop() {
      await app.stop();
    },
  };
}

interface GrpcSpace {
  id: string;
  __platform?: string;
  platform?: string;
  phone?: string;
}

interface GrpcMessage {
  id: string;
  __platform?: string;
  platform?: string;
  direction?: "inbound" | "outbound";
  timestamp?: Date | string;
  sender?: { id: string; __platform?: string; platform?: string };
  content: unknown;
}

export function serializeGrpcInbound(space: GrpcSpace, message: GrpcMessage): unknown {
  return {
    event: "messages",
    space: {
      id: space.id,
      platform: "iMessage",
      ...(space.phone ? { phone: space.phone } : {}),
    },
    message: {
      id: message.id,
      platform: "iMessage",
      direction: "inbound",
      timestamp: timestampString(message.timestamp),
      sender: {
        id: message.sender?.id ?? "",
        platform: "iMessage",
      },
      content: message.content,
    },
  };
}

function timestampString(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return "";
}

// Compile-time checks against the pinned SDK types without leaking them into
// the bridge's small external interface.
type _SpectrumSpaceCompatible = Space extends GrpcSpace ? true : never;
type _SpectrumMessageCompatible = Message extends GrpcMessage ? true : never;
