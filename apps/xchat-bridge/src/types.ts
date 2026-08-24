export interface EncryptedEnvelope {
  algorithm: "AES-256-GCM";
  keyVersion: number;
  iv: string;
  ciphertext: string;
}

export interface VerifiedInboundText {
  eventUuid: string;
  providerMessageId: string;
  senderId: string;
  conversationId: string;
  occurredAt: number;
  text: string;
  keyChangeEvent?: string;
}

export interface InboundAdmission {
  senderIdHash: string;
  providerConversationIdHash: string;
  eventUuid: string;
  providerMessageId: string;
  messageHash: string;
  encryptedPayload: EncryptedEnvelope;
  claimTokenHash: string;
  claimExpiresAt: number;
  occurredAt: number;
}

export type InboundAdmissionResult =
  | { status: "duplicate"; deliveryId: string; claimRequired: boolean }
  | { status: "unbound"; deliveryId: string }
  | {
      status: "accepted";
      deliveryId: string;
      connectionId: string;
      ownerId: string;
      projectId: string | null;
      conversationId: string;
    };

export interface OutboundLease {
  deliveryId: string;
  connectionId: string;
  providerConversationIdHash: string;
  messageHash: string;
  encryptedPayload: EncryptedEnvelope;
  payloadAad: string;
  occurredAt: number;
  attempt: number;
  leaseExpiresAt: number;
}

export interface OutboundPlaintext {
  conversationId: string;
  text: string;
}

export interface PreparedSend {
  messageId: string;
  conversationId: string;
  encodedMessageCreateEvent: string;
  encodedMessageEventSignature: string;
}

export type SettlementOutcome = "sent" | "delivered" | "failed" | "failed_retryable";
