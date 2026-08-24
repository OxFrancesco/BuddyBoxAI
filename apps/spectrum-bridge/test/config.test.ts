import { describe, expect, test } from "bun:test";

import { readConfig } from "../src/config";

const baseEnv = {
  SPECTRUM_PROJECT_ID: "project-id",
  SPECTRUM_PROJECT_SECRET: "project_secret_value",
  SPECTRUM_WEBHOOK_SECRET: "webhook_secret_value",
  BUDDYBOX_ADDRESS_PEPPER: "address_pepper_value",
  CONVEX_BRIDGE_URL: "https://example.convex.site/bridge/spectrum",
  BUDDYBOX_BRIDGE_SECRET: "bridge_secret_value",
};

describe("bridge configuration seam", () => {
  test("defaults to webhook ingress and a bounded listen port", () => {
    expect(readConfig(baseEnv)).toMatchObject({ ingressMode: "webhook", port: 3000 });
  });

  test("requires a Spectrum webhook secret only for modes that accept webhooks", () => {
    expect(() => readConfig({ ...baseEnv, SPECTRUM_WEBHOOK_SECRET: undefined })).toThrow();
    expect(
      readConfig({ ...baseEnv, SPECTRUM_WEBHOOK_SECRET: undefined, SPECTRUM_INGRESS_MODE: "grpc" }),
    ).toMatchObject({ ingressMode: "grpc", webhookSecret: undefined });
  });
});
