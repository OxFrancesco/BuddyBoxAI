import { z } from "zod";

const snowflakeSchema = z.string().regex(/^\d{1,19}$/);
const meResponseSchema = z.object({
  data: z.object({
    id: snowflakeSchema,
    username: z.string().min(1),
  }),
});
const publicKeysResponseSchema = z.object({
  data: z.array(z.object({
    public_key_version: z.string().regex(/^[1-9]\d*$/),
  }).catchall(z.unknown())),
});
const webhooksResponseSchema = z.object({
  data: z.array(z.object({
    id: snowflakeSchema,
    url: z.string().url(),
    valid: z.boolean(),
  })).default([]),
});
const webhookSchema = z.object({
  id: snowflakeSchema,
  url: z.string().url(),
  valid: z.boolean(),
});
const createWebhookResponseSchema = z.object({ data: webhookSchema });
const SUBSCRIPTION_TAG = "buddybox-xchat";
const subscriptionSchema = z.object({
  subscription_id: snowflakeSchema,
  event_type: z.string().min(1),
  filter: z.object({ user_id: snowflakeSchema }).catchall(z.unknown()),
  tag: z.string().min(1).optional(),
  webhook_id: snowflakeSchema.optional(),
});
const subscriptionsResponseSchema = z.object({
  data: z.array(subscriptionSchema).default([]),
  meta: z.object({ next_token: z.string().min(1).optional() }).catchall(z.unknown()).optional(),
});
const createSubscriptionResponseSchema = z.union([
  z.object({ data: subscriptionSchema }),
  z.object({ data: z.object({ subscription: subscriptionSchema }) }),
]);

export type XChatIdentityRegistration = (input: {
  userId: string;
  pin: string;
  accessToken: string;
  fetcher: XProvisioningHttp;
  forceRotation: boolean;
}) => Promise<{ publicKeyVersion: string; status: "ready" | "created" }>;

export type XChatIdentityVerification = (input: {
  userId: string;
  pin: string;
  accessToken: string;
  fetcher: XProvisioningHttp;
}) => Promise<{ publicKeyVersion: string } | undefined>;

export type XProvisioningHttp = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProvisionXChatOptions {
  phase: "status" | "identity" | "identity-rotate" | "webhook" | "subscription" | "all";
  env: Readonly<Record<string, string | undefined>>;
  fetcher?: XProvisioningHttp;
  identityRegistration?: XChatIdentityRegistration;
  identityVerification?: XChatIdentityVerification;
}

type IdentityPhaseResult =
  | {
      phase: "identity" | "identity-rotate";
      status: "blocked";
      code: "identity_setup_required";
      userId: string;
      username: string;
      publicKeyVersions: string[];
    }
  | {
      phase: "identity" | "identity-rotate";
      status: "blocked";
      code: "identity_recovery_unverified";
      userId: string;
      username: string;
      publicKeyVersions: string[];
    }
  | {
      phase: "identity" | "identity-rotate";
      status: "blocked";
      code: "oauth_identity_mismatch";
      expectedUserId: string;
      actualUserId: string;
    }
  | {
      phase: "identity" | "identity-rotate";
      status: "ready";
      userId: string;
      username: string;
      publicKeyVersions: string[];
    }
  | {
      phase: "identity" | "identity-rotate";
      status: "created";
      userId: string;
      username: string;
      publicKeyVersions: string[];
    }
  | { phase: "identity" | "identity-rotate"; status: "error"; code: "invalid_x_response" };

type WebhookPhaseResult =
  | {
      phase: "webhook";
      status: "ready" | "created";
      webhookId: string;
      url: string;
    }
  | { phase: "webhook"; status: "blocked"; code: "webhook_missing"; url: string }
  | {
      phase: "webhook";
      status: "blocked";
      code: "webhook_invalid";
      webhookId: string;
      url: string;
    };

type SubscriptionPhaseResult =
  | {
      phase: "subscription";
      status: "ready" | "created";
      subscriptionId: string;
      userId: string;
      webhookId: string;
    }
  | {
      phase: "subscription";
      status: "blocked";
      code: "oauth_identity_mismatch" | "webhook_required" | "subscription_missing";
    };

type ProvisioningErrorResult = {
  phase: ProvisionXChatOptions["phase"];
  status: "error";
  code: "invalid_configuration" | "invalid_x_response" | "x_request_failed" | "provisioning_failed";
};

export interface ProvisionXChatResult {
  status: "ready" | "blocked" | "changed" | "error";
  requestedPhase: "status" | "identity" | "identity-rotate" | "webhook" | "subscription" | "all";
  phases: Array<IdentityPhaseResult | WebhookPhaseResult | SubscriptionPhaseResult | ProvisioningErrorResult>;
}

export async function provisionXChat(options: ProvisionXChatOptions): Promise<ProvisionXChatResult> {
  try {
    return await provisionXChatUnsafe(options);
  } catch (error: unknown) {
    return {
      status: "error",
      requestedPhase: options.phase,
      phases: [{
        phase: options.phase,
        status: "error",
        code: provisioningErrorCode(error),
      }],
    };
  }
}

async function provisionXChatUnsafe(options: ProvisionXChatOptions): Promise<ProvisionXChatResult> {
  if (options.phase === "status" || options.phase === "all") {
    const requestedPhase = options.phase;
    const identityOptions: ProvisionXChatOptions = {
      phase: "identity",
      env: options.env,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.identityVerification ? { identityVerification: options.identityVerification } : {}),
    };
    const identity = await provisionXChat(identityOptions);
    const webhook = await provisionWebhook(options, requestedPhase === "all");
    const subscription = await provisionSubscription(options, requestedPhase === "all");
    const phases = [...identity.phases, ...webhook.phases, ...subscription.phases];
    return { status: summarize(phases), requestedPhase, phases };
  }
  if (options.phase === "webhook") return await provisionWebhook(options, true);
  if (options.phase === "subscription") return await provisionSubscription(options, true);
  const identityPhase = options.phase === "identity-rotate" ? "identity-rotate" : "identity";
  try {
    const accessToken = required(options.env, "X_OAUTH_ACCESS_TOKEN");
    const fetcher = options.fetcher ?? fetch;
    const me = await requestJson({
      fetcher,
      url: "https://api.x.com/2/users/me",
      token: accessToken,
      schema: meResponseSchema,
    });
    const expectedUserId = optional(options.env.X_CHAT_USER_ID);
    if (expectedUserId && expectedUserId !== me.data.id) {
      return {
        status: "blocked",
        requestedPhase: identityPhase,
        phases: [{
          phase: identityPhase,
          status: "blocked",
          code: "oauth_identity_mismatch",
          expectedUserId,
          actualUserId: me.data.id,
        }],
      };
    }
    const publicKeysUrl = new URL(`https://api.x.com/2/users/${me.data.id}/public_keys`);
    const keys = await requestJson({
      fetcher,
      url: publicKeysUrl.toString(),
      token: accessToken,
      schema: publicKeysResponseSchema,
    });
    const publicKeyVersions = keys.data.map((key) => key.public_key_version);
    if (options.identityRegistration) {
      const pin = required(options.env, "X_CHAT_PIN");
      const forceRotation = options.phase === "identity-rotate";
      if (forceRotation && required(options.env, "X_CHAT_ROTATION_CONFIRM_USER_ID") !== me.data.id) {
        throw new ConfigurationError();
      }
      const registered = await options.identityRegistration({
        userId: me.data.id,
        pin,
        accessToken,
        fetcher,
        forceRotation,
      });
      const phaseStatus = registered.status;
      return {
        status: phaseStatus === "created" ? "changed" : "ready",
        requestedPhase: identityPhase,
        phases: [{
          phase: identityPhase,
          status: phaseStatus,
          userId: me.data.id,
          username: me.data.username,
          publicKeyVersions: [registered.publicKeyVersion],
        }],
      };
    }
    if (publicKeyVersions.length > 0) {
      const pin = optional(options.env.X_CHAT_PIN);
      if (!pin || !options.identityVerification) {
        return {
          status: "blocked",
          requestedPhase: identityPhase,
          phases: [{
            phase: identityPhase,
            status: "blocked",
            code: "identity_recovery_unverified",
            userId: me.data.id,
            username: me.data.username,
            publicKeyVersions,
          }],
        };
      }
      const verified = await options.identityVerification({
        userId: me.data.id,
        pin,
        accessToken,
        fetcher,
      });
      if (!verified || !publicKeyVersions.includes(verified.publicKeyVersion)) {
        return {
          status: "blocked",
          requestedPhase: identityPhase,
          phases: [{
            phase: identityPhase,
            status: "blocked",
            code: "identity_recovery_unverified",
            userId: me.data.id,
            username: me.data.username,
            publicKeyVersions,
          }],
        };
      }
      return {
        status: "ready",
        requestedPhase: identityPhase,
        phases: [{
          phase: identityPhase,
          status: "ready",
          userId: me.data.id,
          username: me.data.username,
          publicKeyVersions,
        }],
      };
    }
    return {
      status: "blocked",
      requestedPhase: identityPhase,
      phases: [{
        phase: identityPhase,
        status: "blocked",
        code: "identity_setup_required",
        userId: me.data.id,
        username: me.data.username,
        publicKeyVersions,
      }],
    };
  } catch (error: unknown) {
    if (error instanceof ProvisioningBoundaryError) {
      return {
        status: "error",
        requestedPhase: identityPhase,
        phases: [{ phase: identityPhase, status: "error", code: "invalid_x_response" }],
      };
    }
    throw error;
  }
}

async function provisionSubscription(
  options: ProvisionXChatOptions,
  allowCreate: boolean,
): Promise<ProvisionXChatResult> {
  const fetcher = options.fetcher ?? fetch;
  const accessToken = required(options.env, "X_OAUTH_ACCESS_TOKEN");
  const appBearerToken = required(options.env, "X_APP_BEARER_TOKEN");
  const webhookUrl = requiredHttpsUrl(options.env, "X_WEBHOOK_URL");
  const me = await requestJson({
    fetcher,
    url: "https://api.x.com/2/users/me",
    token: accessToken,
    schema: meResponseSchema,
  });
  const expectedUserId = optional(options.env.X_CHAT_USER_ID);
  if (expectedUserId && expectedUserId !== me.data.id) {
    return {
      status: "blocked",
      requestedPhase: "subscription",
      phases: [{ phase: "subscription", status: "blocked", code: "oauth_identity_mismatch" }],
    };
  }
  const webhooks = await requestJson({
    fetcher,
    url: "https://api.x.com/2/webhooks",
    token: appBearerToken,
    schema: webhooksResponseSchema,
  });
  const webhook = webhooks.data.find((candidate) => candidate.url === webhookUrl && candidate.valid);
  if (!webhook) {
    return {
      status: "blocked",
      requestedPhase: "subscription",
      phases: [{ phase: "subscription", status: "blocked", code: "webhook_required" }],
    };
  }
  const subscriptions = await listSubscriptions(fetcher, appBearerToken);
  const existing = subscriptions.find((subscription) =>
    subscription.event_type === "chat.received"
    && subscription.webhook_id === webhook.id
    && subscription.filter.user_id === me.data.id
    && subscription.tag === SUBSCRIPTION_TAG
    && Object.keys(subscription.filter).length === 1
  );
  if (existing) {
    return {
      status: "ready",
      requestedPhase: "subscription",
      phases: [{
        phase: "subscription",
        status: "ready",
        subscriptionId: existing.subscription_id,
        userId: me.data.id,
        webhookId: webhook.id,
      }],
    };
  }
  if (!allowCreate) {
    return {
      status: "blocked",
      requestedPhase: "subscription",
      phases: [{ phase: "subscription", status: "blocked", code: "subscription_missing" }],
    };
  }
  const created = await requestJson({
    fetcher,
    url: "https://api.x.com/2/activity/subscriptions",
    token: accessToken,
    method: "POST",
    body: {
      event_type: "chat.received",
      filter: { user_id: me.data.id },
      tag: SUBSCRIPTION_TAG,
      webhook_id: webhook.id,
    },
    schema: createSubscriptionResponseSchema,
  });
  const subscription = "subscription" in created.data ? created.data.subscription : created.data;
  if (
    subscription.event_type !== "chat.received"
    || subscription.webhook_id !== webhook.id
    || subscription.filter.user_id !== me.data.id
    || subscription.tag !== SUBSCRIPTION_TAG
    || Object.keys(subscription.filter).length !== 1
  ) throw new ProvisioningBoundaryError();
  return {
    status: "changed",
    requestedPhase: "subscription",
    phases: [{
      phase: "subscription",
      status: "created",
      subscriptionId: subscription.subscription_id,
      userId: me.data.id,
      webhookId: webhook.id,
    }],
  };
}

async function listSubscriptions(
  fetcher: XProvisioningHttp,
  token: string,
): Promise<z.infer<typeof subscriptionSchema>[]> {
  const subscriptions: z.infer<typeof subscriptionSchema>[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL("https://api.x.com/2/activity/subscriptions");
    if (nextToken) url.searchParams.set("pagination_token", nextToken);
    const response = await requestJson({
      fetcher,
      url: url.toString(),
      token,
      schema: subscriptionsResponseSchema,
    });
    subscriptions.push(...response.data);
    const candidate = response.meta?.next_token;
    if (!candidate) return subscriptions;
    if (seenTokens.has(candidate)) throw new ProvisioningBoundaryError();
    seenTokens.add(candidate);
    nextToken = candidate;
  }
  throw new ProvisioningBoundaryError();
}

async function provisionWebhook(
  options: ProvisionXChatOptions,
  allowCreate: boolean,
): Promise<ProvisionXChatResult> {
  const appBearerToken = required(options.env, "X_APP_BEARER_TOKEN");
  const webhookUrl = requiredHttpsUrl(options.env, "X_WEBHOOK_URL");
  const fetcher = options.fetcher ?? fetch;
  const webhooks = await requestJson({
    fetcher,
    url: "https://api.x.com/2/webhooks",
    token: appBearerToken,
    schema: webhooksResponseSchema,
  });
  const existing = webhooks.data.find((webhook) => webhook.url === webhookUrl);
  if (existing) {
    if (!existing.valid) {
      return {
        status: "blocked",
        requestedPhase: "webhook",
        phases: [{
          phase: "webhook",
          status: "blocked",
          code: "webhook_invalid",
          webhookId: existing.id,
          url: existing.url,
        }],
      };
    }
    return {
      status: "ready",
      requestedPhase: "webhook",
      phases: [{
        phase: "webhook",
        status: "ready",
        webhookId: existing.id,
        url: existing.url,
      }],
    };
  }
  if (!allowCreate) {
    return {
      status: "blocked",
      requestedPhase: "webhook",
      phases: [{ phase: "webhook", status: "blocked", code: "webhook_missing", url: webhookUrl }],
    };
  }
  const createdResponse = await requestJson({
    fetcher,
    url: "https://api.x.com/2/webhooks",
    token: appBearerToken,
    method: "POST",
    body: { url: webhookUrl },
    schema: createWebhookResponseSchema,
  });
  const created = createdResponse.data;
  if (created.url !== webhookUrl) throw new ProvisioningBoundaryError();
  if (!created.valid) {
    return {
      status: "blocked",
      requestedPhase: "webhook",
      phases: [{
        phase: "webhook",
        status: "blocked",
        code: "webhook_invalid",
        webhookId: created.id,
        url: created.url,
      }],
    };
  }
  return {
    status: "changed",
    requestedPhase: "webhook",
    phases: [{
      phase: "webhook",
      status: "created",
      webhookId: created.id,
      url: created.url,
    }],
  };
}

function summarize(phases: ProvisionXChatResult["phases"]): ProvisionXChatResult["status"] {
  if (phases.some((phase) => phase.status === "error")) return "error";
  if (phases.some((phase) => phase.status === "blocked")) return "blocked";
  if (phases.some((phase) => phase.status === "created")) return "changed";
  return "ready";
}

async function requestJson<Output>(options: {
  fetcher: XProvisioningHttp;
  url: string;
  token: string;
  method?: "GET" | "POST";
  body?: Readonly<Record<string, unknown>>;
  schema: z.ZodType<Output>;
}): Promise<Output> {
  let response: Response;
  try {
    response = await options.fetcher(options.url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new XRequestError();
  }
  if (!response.ok) throw new XRequestError();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProvisioningBoundaryError();
  }
  const parsed = options.schema.safeParse(body);
  if (!parsed.success) throw new ProvisioningBoundaryError();
  return parsed.data;
}

class ProvisioningBoundaryError extends Error {}
class XRequestError extends Error {}
class ConfigurationError extends Error {}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = optional(env[name]);
  if (!value) throw new ConfigurationError();
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requiredHttpsUrl(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new ConfigurationError();
  }
  return value;
}

function provisioningErrorCode(error: unknown): ProvisioningErrorResult["code"] {
  if (error instanceof ConfigurationError || error instanceof SyntaxError || error instanceof z.ZodError) {
    return "invalid_configuration";
  }
  if (error instanceof ProvisioningBoundaryError) return "invalid_x_response";
  if (error instanceof XRequestError) return "x_request_failed";
  return "provisioning_failed";
}
