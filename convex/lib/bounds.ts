import { ConvexError } from "convex/values";

export const RAW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1_000;
export const MAX_APPROVAL_TTL_MS = 30 * 60 * 1_000;
export const MAX_EVENT_DATA_BYTES = 24_000;
export const MAX_EVENT_SUMMARY_LENGTH = 1_000;
export const MAX_PAGE_SIZE = 100;

export function boundedLimit(value: number | undefined, fallback = 50): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new ConvexError({
      code: "INVALID_LIMIT",
      message: `Limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
    });
  }
  return value;
}

export function requireBoundedString(
  value: string,
  field: string,
  maximum: number,
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${field} must contain between 1 and ${maximum} characters`,
    });
  }
  return normalized;
}

export function requireDataJson(value: string | undefined): void {
  if (value === undefined) return;
  if (new TextEncoder().encode(value).byteLength > MAX_EVENT_DATA_BYTES) {
    throw new ConvexError({
      code: "EVENT_TOO_LARGE",
      message: `Event data exceeds ${MAX_EVENT_DATA_BYTES} bytes`,
    });
  }
  try {
    JSON.parse(value);
  } catch {
    throw new ConvexError({
      code: "INVALID_EVENT_DATA",
      message: "Event data must be valid JSON",
    });
  }
}
