import { chmod, chown, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BUN_UID = 1_000;
const BUN_GID = 1_000;
const DEFAULT_VAULT_PATH = "/data/xchat-vault.json";

export function vaultDirectoryFor(value: string | undefined): string {
  const vaultPath = value?.trim() || DEFAULT_VAULT_PATH;
  const normalized = resolve(vaultPath);
  if (normalized !== vaultPath || dirname(normalized) !== "/data") {
    throw new Error("X Chat vault must be a direct child of /data");
  }
  return "/data";
}

async function prepareVault(value: string | undefined): Promise<void> {
  const vaultPath = value?.trim() || DEFAULT_VAULT_PATH;
  const directory = vaultDirectoryFor(value);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolvedDirectory = await realpath(directory);
  if (resolvedDirectory !== directory) {
    throw new Error("X Chat vault directory may not traverse symbolic links");
  }
  await chown(directory, BUN_UID, BUN_GID);
  await chmod(directory, 0o700);
  try {
    const existing = await lstat(vaultPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("X Chat vault must be a regular file");
    }
    await chown(vaultPath, BUN_UID, BUN_GID);
    await chmod(vaultPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
  if (process.getuid?.() === 0) {
    await prepareVault(process.env.XCHAT_VAULT_PATH);
    process.setgroups?.([]);
    process.setgid?.(BUN_GID);
    process.setuid?.(BUN_UID);
  }
  if (process.getuid?.() !== BUN_UID || process.getgid?.() !== BUN_GID) {
    throw new Error("X Chat bridge must run as the bun user");
  }
  const startupModule = process.argv[2] ?? "./index";
  if (!/^\.\/[a-z][a-z0-9-]*(?:\.ts)?$/.test(startupModule)) {
    throw new Error("Invalid X Chat startup module");
  }
  await import(startupModule);
}

if (import.meta.main) await main();
