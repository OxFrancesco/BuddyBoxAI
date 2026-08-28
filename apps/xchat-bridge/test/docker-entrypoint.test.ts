import { describe, expect, test } from "bun:test";

import { vaultDirectoryFor } from "../src/docker-entrypoint";

describe("X Chat container startup", () => {
  test("limits writable vault directories to the Railway data volume", () => {
    expect(vaultDirectoryFor(undefined)).toBe("/data");
    expect(vaultDirectoryFor("/data/custom-vault.json")).toBe("/data");

    for (const path of [
      "xchat-vault.json",
      "/data",
      "/data/nested/xchat-vault.json",
      "/database/xchat-vault.json",
      "/data/../tmp/xchat-vault.json",
      "/tmp/xchat-vault.json",
    ]) {
      expect(() => vaultDirectoryFor(path)).toThrow("X Chat vault must be a direct child of /data");
    }
  });
});
