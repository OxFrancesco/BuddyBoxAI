import { describe, expect, test } from "bun:test";

import {
  evaluateProjectReadiness,
  projectSchema,
  runSchema,
  type IMessageConnection,
  type ServiceConnection,
  type XChatConnection,
} from "./domain";

const now = "2026-08-13T12:00:00.000Z";

const iMessageConnection: IMessageConnection = {
  id: "imessage_01J1",
  userId: "user_01J1",
  address: "+393331234567",
  status: "verified",
  verifiedAt: now,
  createdAt: now,
  updatedAt: now,
};

function connection(provider: ServiceConnection["provider"], status: ServiceConnection["status"] = "healthy") {
  return {
    id: `service_${provider}`,
    userId: "user_01J1",
    provider,
    externalAccountId: `external_${provider}`,
    status,
    scopes: ["delegated"],
    connectedAt: now,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
  } satisfies ServiceConnection;
}

const xChatConnection: XChatConnection = {
  id: "xchat_01J1",
  userId: "user_01J1",
  accountIdHash: "0123456789abcdef",
  status: "verified",
  verifiedAt: now,
  createdAt: now,
  updatedAt: now,
};

describe("Project-ready User seam", () => {
  test("requires verified messaging, ChatGPT, GitHub, and Convex authority", () => {
    const readiness = evaluateProjectReadiness({
      userId: "user_01J1",
      iMessageConnections: [iMessageConnection],
      serviceConnections: [connection("chatgpt"), connection("github"), connection("convex")],
    });

    expect(readiness).toEqual({ ready: true, missing: [] });
  });

  test("reports unhealthy or absent requirements without accepting another User's authority", () => {
    const readiness = evaluateProjectReadiness({
      userId: "user_01J1",
      iMessageConnections: [{ ...iMessageConnection, userId: "user_other" }],
      serviceConnections: [connection("chatgpt"), connection("github", "action-required")],
    });

    expect(readiness).toEqual({
      ready: false,
      missing: ["verified-messaging", "github", "convex"],
    });
  });

  test("accepts verified X Chat as the messaging channel", () => {
    const readiness = evaluateProjectReadiness({
      userId: "user_01J1",
      iMessageConnections: [],
      xChatConnections: [xChatConnection],
      serviceConnections: [connection("chatgpt"), connection("github"), connection("convex")],
    });

    expect(readiness).toEqual({ ready: true, missing: [] });
  });
});

describe("canonical entity invariants", () => {
  test("a Project has one owner and does not contain Sandbox state", () => {
    const project = projectSchema.parse({
      id: "project_01J1",
      ownerUserId: "user_01J1",
      name: "Dinner Club",
      slug: "dinner-club",
      status: "active",
      repository: { owner: "francesco", name: "dinner-club", defaultBranch: "main" },
      createdAt: now,
      updatedAt: now,
    });

    expect(project.ownerUserId).toBe("user_01J1");
    expect(project).not.toHaveProperty("sandboxId");
  });

  test("a terminal Run requires its truthful outcome", () => {
    expect(
      runSchema.safeParse({
        id: "run_01J1",
        projectId: "project_01J1",
        conversationId: "conversation_01J1",
        requestedByUserId: "user_01J1",
        instruction: "Publish the verified homepage",
        status: "terminal",
        outcome: null,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(false);
  });

  test("a non-terminal Run cannot claim an outcome", () => {
    expect(
      runSchema.safeParse({
        id: "run_01J1",
        projectId: "project_01J1",
        conversationId: "conversation_01J1",
        requestedByUserId: "user_01J1",
        instruction: "Publish the verified homepage",
        status: "running",
        outcome: "succeeded",
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(false);
  });
});
