import { CodexAuthError } from "./openai.ts";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:^|_)(?:access|refresh|id)?_?token$|authorization|cookie|secret|password|device_auth|user_code|code_verifier|authorization_code/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const TOKEN_PARAM =
  /\b(?:access_token|refresh_token|device_auth_id|code_verifier|authorization_code)=([^\s&]+)/gi;

function redactString(value: string): string {
  return value
    .replace(BEARER, REDACTED)
    .replace(JWT, REDACTED)
    .replace(TOKEN_PARAM, (match) => `${match.slice(0, match.indexOf("=") + 1)}${REDACTED}`);
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, seen);
  }
  return output;
}

/** Returns a detached log value. It never mutates the caller's object. */
export function redactForLog(value: unknown): unknown {
  return redact(value, new WeakSet());
}

export type SafeAuthError = Readonly<{
  name: "CodexAuthError";
  code: string;
  retryable: boolean;
  message: string;
}>;

/** Strict allow-list projection for logs, metrics, and HTTP error responses. */
export function safeAuthError(error: unknown): SafeAuthError {
  if (error instanceof CodexAuthError) return error.toJSON() as SafeAuthError;
  return {
    name: "CodexAuthError",
    code: "unexpected_error",
    retryable: false,
    message: "ChatGPT authorization failed.",
  };
}
