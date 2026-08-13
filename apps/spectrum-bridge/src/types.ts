export type AttachmentKind = "image" | "audio" | "video" | "document";

export interface NormalizedAttachment {
  providerAttachmentId: string;
  kind: AttachmentKind;
  mimeType: string;
  name: string;
  sizeBytes: number;
}

export interface NormalizedInbound {
  source: "imessage";
  idempotencyKey: string;
  providerMessageId: string;
  providerWebhookId: string;
  addressHash: string;
  spaceId: string;
  lineId?: string;
  sentAt: string;
  text: string;
  attachments: NormalizedAttachment[];
}

export interface OutboundMessage {
  outboundId: string;
  idempotencyKey: string;
  spaceId: string;
  lineId?: string;
  text: string;
}

export type InboundResult =
  | { status: "accepted"; deliveryId: string; outbound?: OutboundMessage }
  | { status: "duplicate"; deliveryId: string }
  | { status: "unbound"; deliveryId: string; outbound: OutboundMessage };

export type ChallengeResult =
  | { status: "verified"; connectionId: string; outbound: OutboundMessage }
  | { status: "already_verified"; connectionId: string; outbound?: OutboundMessage }
  | { status: "invalid"; outbound?: OutboundMessage }
  | { status: "expired"; outbound?: OutboundMessage };

export interface ChallengeAttempt {
  addressHash: string;
  challengeCode: string;
  providerMessageId: string;
  idempotencyKey: string;
  spaceId: string;
  lineId?: string;
}

export type OutboundClaim =
  | { status: "claimed" }
  | { status: "already_delivered" }
  | { status: "in_flight" };

export type OutboundSettlement =
  | {
      outboundId: string;
      status: "delivered";
      attempts: number;
      providerMessageId: string;
    }
  | {
      outboundId: string;
      status: "failed_retryable";
      attempts: number;
      errorCode: "spectrum_unavailable";
    };
