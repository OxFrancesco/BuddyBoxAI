export type GatewayErrorCode =
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "conflict"
  | "too_large"
  | "runtime_unavailable"
  | "checkpoint_failed"
  | "internal";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function publicError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof ProtocolLimitError) return new GatewayError("too_large", error.message, 413);
  if (error instanceof SyntaxError) return new GatewayError("bad_request", "Request JSON is invalid.", 400);
  if (error instanceof Error && /must|invalid|format|required|between/i.test(error.message)) {
    return new GatewayError("bad_request", error.message, 400);
  }
  return new GatewayError("internal", "The Agent Gateway could not complete the request.", 500, true);
}
import { ProtocolLimitError } from "./contracts/v1";
